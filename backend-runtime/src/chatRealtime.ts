import crypto from 'crypto';
import * as admin from 'firebase-admin';
import { ensureFirebase } from './firebaseAdmin';
import {
  buildChatRealtimeMessageContentSignature,
  normalizeChatRealtimeReplyPayload,
} from './lib/chatRealtimePayload';

interface SharedConversationWatch {
  subscribers: Map<number, ConversationWatcherHandlers>;
  nextSubscriberId: number;
  cleanupFirebase: (() => void) | null;
  initPromise: Promise<void>;
  // Guards against the Firebase `.off()` teardown running more than once for a
  // single watch instance (stuck-message-delivery-fix hotfix, Fix C).
  torndown: boolean;
  // Handle for a deferred grace-window release, scheduled when the LAST
  // subscriber leaves. Kept on the watch so an incoming subscriber can cancel it
  // (reusing the still-live Firebase listeners) and so release/cancel can clear
  // it. `null` when no release is pending.
  pendingReleaseTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Grace window (ms) kept between the LAST subscriber leaving a shared
 * conversation watch and the Firebase `.off()` teardown. Holding the watch alive
 * briefly eliminates rapid teardown/re-attach churn — the exact churn that trips
 * Firebase's "listen() called twice for same path/queryId" internal assert when
 * a new subscriber re-attaches before the SDK released the prior listen. If a new
 * subscriber attaches within this window the pending release is cancelled and the
 * live listeners are reused (no `.off()`, no re-attach).
 * (stuck-message-delivery-fix hotfix — grace-window release hardening.)
 */
export const DEFAULT_SHARED_WATCH_RELEASE_GRACE_MS = 5000;

let sharedWatchReleaseGraceMs = DEFAULT_SHARED_WATCH_RELEASE_GRACE_MS;

/**
 * Test hook: override the grace window (ms) used for deferred watch release.
 * Values `<= 0` fall back to immediate release. Not part of the public runtime
 * API — exported only so tests can drive release timing deterministically.
 */
export function __setSharedWatchReleaseGraceMs(ms: number): void {
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
    sharedWatchReleaseGraceMs = ms;
  }
}

/** Test hook: read the current grace window (ms). */
export function __getSharedWatchReleaseGraceMs(): number {
  return sharedWatchReleaseGraceMs;
}

/** Test hook: reset the grace window to its default. */
export function __resetSharedWatchReleaseGraceMs(): void {
  sharedWatchReleaseGraceMs = DEFAULT_SHARED_WATCH_RELEASE_GRACE_MS;
}

/**
 * Test hook: is a deferred release currently pending for this conversation
 * watch? A pending release means the last subscriber has left but the Firebase
 * listeners are still attached (inside the grace window).
 */
export function __hasPendingRelease(tenantId: string, conversationKey: string): boolean {
  const watchKey = [
    typeof tenantId === 'string' ? tenantId.trim() : '',
    typeof conversationKey === 'string' ? conversationKey.trim() : '',
  ].join('::');
  const watch = sharedConversationWatches.get(watchKey);
  return !!watch && watch.pendingReleaseTimer !== null;
}

/** Test hook: number of watches with a deferred release pending. */
export function __getPendingReleaseCount(): number {
  let count = 0;
  for (const watch of sharedConversationWatches.values()) {
    if (watch.pendingReleaseTimer !== null) {
      count += 1;
    }
  }
  return count;
}

/**
 * Detect the Firebase SDK internal assertion that fires when `.on()` is invoked
 * for a path/queryId that still has an active listen — e.g. under connection
 * churn when a new subscriber re-attaches before the SDK released the prior
 * listen. Message shape: "Firebase Database INTERNAL ASSERT FAILED: listen()
 * called twice for same path/queryId".
 */
function isListenCalledTwiceError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error && typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : '';
  return /listen\(\) called twice/i.test(message);
}

/**
 * Attach a Realtime Database child listener defensively (stuck-message-delivery-fix
 * hotfix, Fix C). If the SDK throws the "listen() called twice" internal assert,
 * detach any lingering listen for this exact (ref, event, callback) and re-attach
 * exactly once. If the re-attach still fails, detach again so we never leave a
 * half-registered listener, then surface the error cleanly. Any other error is
 * rethrown unchanged.
 */
function safeAttachListener(
  ref: admin.database.Reference,
  eventType: 'child_added' | 'child_changed',
  callback: (snapshot: admin.database.DataSnapshot) => void
): void {
  try {
    ref.on(eventType, callback);
    return;
  } catch (error) {
    if (!isListenCalledTwiceError(error)) {
      throw error;
    }
  }

  // Recovery path: release the stale listen, then re-attach once.
  try {
    ref.off(eventType, callback);
  } catch {
    // Best-effort detach; ignore failures releasing a listener that may not exist.
  }

  try {
    ref.on(eventType, callback);
  } catch (retryError) {
    try {
      ref.off(eventType, callback);
    } catch {
      // Best-effort detach so no half-registered listener is left behind.
    }
    throw retryError;
  }
}

/**
 * Default upper bound on the number of per-message diff signatures a shared
 * watch retains for change detection (finding P3-3). Diff signatures are compact
 * (a few status flags + one content-signature string) rather than full message
 * payloads, so the same memory budget holds many more ids than the old
 * full-payload cache. That headroom is what stops a large (>cap) conversation
 * from evicting the diff state of messages that are still receiving
 * receipts/edits — the eviction that used to make a later `child_changed` look
 * brand-new and re-broadcast phantom status/update/delete events. When the cap
 * is exceeded the oldest entries are trimmed.
 */
export const DEFAULT_MAX_SHARED_WATCH_CACHE_ENTRIES = 5000;

let sharedWatchCacheCap = DEFAULT_MAX_SHARED_WATCH_CACHE_ENTRIES;

/**
 * Test hook: override the per-watch diff-signature cap so tests can force
 * eviction with a handful of messages instead of thousands. Mirrors
 * `__setSharedWatchReleaseGraceMs`. Values `< 1` are ignored. Not part of the
 * public runtime API.
 */
export function __setSharedWatchCacheCap(cap: number): void {
  if (typeof cap === 'number' && Number.isFinite(cap) && cap >= 1) {
    sharedWatchCacheCap = Math.trunc(cap);
  }
}

/** Test hook: read the current per-watch diff-signature cap. */
export function __getSharedWatchCacheCap(): number {
  return sharedWatchCacheCap;
}

/** Test hook: reset the per-watch diff-signature cap to its default. */
export function __resetSharedWatchCacheCap(): void {
  sharedWatchCacheCap = DEFAULT_MAX_SHARED_WATCH_CACHE_ENTRIES;
}

const sharedConversationWatches = new Map<string, SharedConversationWatch>();

export interface ConversationWatchStats {
  activeWatches: number;
  totalSubscribers: number;
}

export interface InternalTokenPayload {
  sub?: string;
  exp?: number;
  email?: string;
  master?: boolean;
}

export interface ChatMessagePayload {
  id: string;
  text?: string;
  sender: string;
  recipientId?: string;
  timestamp: string;
  isSpecial?: boolean;
  conversationKey: string;
  tenantId?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  thumbnailUrl?: string;
  attachments?: any[];
  replyTo?: {
    messageId: string;
    sender: string;
    senderName?: string;
    text?: string;
    isSpecial?: boolean;
    hasAttachments?: boolean;
    attachmentCount?: number;
    hasSticker?: boolean;
    hasGif?: boolean;
  };
  sticker?: any;
  gif?: any;
  delivered?: boolean;
  read?: boolean;
  deliveredAt?: string;
  readAt?: string;
  editedAt?: string;
  editCount?: number;
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  reactions?: Record<string, string[]>;
}

export interface ChatStatusPayload {
  id: string;
  delivered?: boolean;
  read?: boolean;
  deliveredAt?: string;
  readAt?: string;
}

export interface ConversationWatcherHandlers {
  onMessage?: (payload: ChatMessagePayload) => void;
  onStatus?: (payload: ChatStatusPayload) => void;
  onMessageUpdate?: (payload: ChatMessagePayload) => void;
  onMessageDelete?: (payload: ChatMessagePayload) => void;
}

export function getConversationWatchStats(): ConversationWatchStats {
  let totalSubscribers = 0;
  for (const watch of sharedConversationWatches.values()) {
    totalSubscribers += watch.subscribers.size;
  }

  return {
    activeWatches: sharedConversationWatches.size,
    totalSubscribers,
  };
}

export function normalizeEmail(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function sanitizeKey(value?: string | null): string | null {
  const normalized = normalizeEmail(value);
  return normalized ? normalized.replace(/[.@]/g, '_') : null;
}

export function getConversationKey(emailA?: string | null, emailB?: string | null): string | null {
  const keyA = sanitizeKey(emailA);
  const keyB = sanitizeKey(emailB);
  if (!keyA || !keyB) {
    return null;
  }
  return [keyA, keyB].sort().join('__');
}

export function decodeInternalToken(token: string | undefined | null): InternalTokenPayload | null {
  if (!token) {
    return null;
  }
  const master = process.env.INTERNAL_API_KEY;
  if (!master) {
    return null;
  }
  if (token === master) {
    return {
      sub: 'system',
      exp: Math.floor(Date.now() / 1000) + 3600,
      master: true,
    };
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }
  const expected = crypto.createHmac('sha256', master).update(payload).digest('base64url');
  if (expected !== signature) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()) as InternalTokenPayload;
    if (typeof decoded.exp !== 'number') {
      return null;
    }
    if (decoded.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function verifyInternalToken(token: string | undefined | null): boolean {
  return decodeInternalToken(token) !== null;
}

function normalizeBooleanFlag(value: unknown): boolean | undefined {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return undefined;
}

function normalizeStringField(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTimestampField(value: unknown): string | undefined {
  const textValue = normalizeStringField(value);
  if (textValue) {
    return textValue;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  const epochMs = value >= 1e12 ? value : value * 1000;
  try {
    const iso = new Date(epochMs).toISOString();
    return iso;
  } catch {
    return undefined;
  }
}

function normalizeIntField(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }

  return Math.trunc(numeric);
}

function normalizeReplyPayload(input: unknown): ChatMessagePayload['replyTo'] | undefined {
  return normalizeChatRealtimeReplyPayload(input);
}

function normalizeSnapshot(
  snapshot: admin.database.DataSnapshot,
  conversationKey: string
): ChatMessagePayload | null {
  if (!snapshot.key) {
    return null;
  }
  const raw = snapshot.val() as Record<string, any> | null;
  if (!raw) {
    return null;
  }
  const sender = normalizeEmail(raw.sender);
  if (!sender) {
    return null;
  }

  const timestamp = normalizeTimestampField(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  const recipientId = normalizeEmail(raw.recipientId);
  const payload: ChatMessagePayload = {
    id: snapshot.key,
    text: typeof raw.text === 'string' ? raw.text : undefined,
    sender,
    recipientId: recipientId || undefined,
    timestamp,
    isSpecial: raw.isSpecial === true ? true : undefined,
    conversationKey,
    tenantId: normalizeStringField(raw.tenantId),
    fileUrl: normalizeStringField(raw.fileUrl),
    fileName: normalizeStringField(raw.fileName),
    fileType: normalizeStringField(raw.fileType),
    fileSize: normalizeIntField(raw.fileSize),
    thumbnailUrl: normalizeStringField(raw.thumbnailUrl),
    attachments: Array.isArray(raw.attachments) ? raw.attachments : undefined,
    replyTo: normalizeReplyPayload(raw.replyTo),
    sticker: raw.sticker && typeof raw.sticker === 'object' ? raw.sticker : undefined,
    gif: raw.gif && typeof raw.gif === 'object' ? raw.gif : undefined,
    delivered: normalizeBooleanFlag(raw.delivered),
    read: normalizeBooleanFlag(raw.read),
    deliveredAt: normalizeTimestampField(raw.deliveredAt),
    readAt: normalizeTimestampField(raw.readAt),
    editedAt: normalizeTimestampField(raw.editedAt),
    editCount: normalizeIntField(raw.editCount),
    deleted: raw.deleted === true ? true : undefined,
    deletedAt: normalizeTimestampField(raw.deletedAt),
    deletedBy: normalizeEmail(raw.deletedBy) || undefined,
    reactions:
      raw.reactions && typeof raw.reactions === 'object' && !Array.isArray(raw.reactions)
        ? (raw.reactions as Record<string, string[]>)
        : undefined,
  };
  return payload;
}

function deriveStatusPayload(snapshot: admin.database.DataSnapshot): ChatStatusPayload | null {
  if (!snapshot.key) {
    return null;
  }
  const raw = snapshot.val() as Record<string, any> | null;
  if (!raw) {
    return null;
  }
  const payload: ChatStatusPayload = {
    id: snapshot.key,
  };
  const delivered = normalizeBooleanFlag(raw.delivered);
  const read = normalizeBooleanFlag(raw.read);
  const deliveredAt = normalizeTimestampField(raw.deliveredAt);
  const readAt = normalizeTimestampField(raw.readAt);

  if (delivered !== undefined) {
    payload.delivered = delivered;
  }
  if (read !== undefined) {
    payload.read = read;
  }
  if (deliveredAt) {
    payload.deliveredAt = deliveredAt;
  }
  if (readAt) {
    payload.readAt = readAt;
  }
  return payload;
}

/**
 * Compact per-message state a shared watch retains purely to detect
 * broadcastable transitions on `child_changed` (finding P3-3). Only the fields
 * needed to diff status and content are kept — not the full payload — so the
 * watch can retain diff state for many more messages within the same memory
 * budget. This keeps receipts/edits on older messages in a large conversation
 * diffed against real prior state instead of being mistaken for brand-new
 * messages after a cache eviction.
 */
interface WatchMessageDiffState {
  delivered?: boolean;
  read?: boolean;
  deliveredAt?: string;
  readAt?: string;
  deleted?: boolean;
  contentSignature: string;
}

/** Build the compact diff signature retained for change detection. */
function buildWatchMessageDiffState(payload: ChatMessagePayload): WatchMessageDiffState {
  return {
    delivered: payload.delivered,
    read: payload.read,
    deliveredAt: payload.deliveredAt,
    readAt: payload.readAt,
    deleted: payload.deleted,
    contentSignature: buildChatRealtimeMessageContentSignature(payload),
  };
}

function trimWatchCaches(
  knownMessageIds: Set<string>,
  messageDiffStates: Map<string, WatchMessageDiffState>
): void {
  if (messageDiffStates.size <= sharedWatchCacheCap) {
    return;
  }

  while (messageDiffStates.size > sharedWatchCacheCap) {
    const oldestEntry = messageDiffStates.keys().next();
    if (oldestEntry.done || typeof oldestEntry.value !== 'string') {
      break;
    }

    const oldestMessageId = oldestEntry.value;
    messageDiffStates.delete(oldestMessageId);
    knownMessageIds.delete(oldestMessageId);
  }
}

/**
 * Cancel a pending grace-window release, if any. Called when a new subscriber
 * attaches to a watch that is inside its release window — the live Firebase
 * listeners are reused, so no `.off()` / re-attach churn occurs.
 */
function cancelPendingRelease(watch: SharedConversationWatch): void {
  if (watch.pendingReleaseTimer !== null) {
    clearTimeout(watch.pendingReleaseTimer);
    watch.pendingReleaseTimer = null;
  }
}

/**
 * Run the idempotent Firebase teardown for a watch and drop it from the cache.
 * Guards: (1) never release a watch that has (re)gained subscribers; (2) only
 * delete the cache entry if it still points at this exact watch instance;
 * (3) `cleanupFirebase` is itself idempotent (the `torndown` guard), so a
 * double-release is harmless.
 */
function releaseSharedWatch(watchKey: string, watch: SharedConversationWatch): void {
  if (watch.subscribers.size > 0) {
    // A subscriber attached after the release was scheduled — keep the watch.
    return;
  }

  cancelPendingRelease(watch);

  if (sharedConversationWatches.get(watchKey) === watch) {
    sharedConversationWatches.delete(watchKey);
  }

  watch.cleanupFirebase?.();
}

/**
 * Schedule a deferred release after the LAST subscriber leaves, keeping the
 * Firebase listeners alive for `SHARED_WATCH_RELEASE_GRACE_MS`. A zero/negative
 * grace window releases immediately. The timer handle is stored on the watch and
 * `unref()`'d so it never keeps the Node process alive; it is cleared when the
 * timer fires, when a new subscriber cancels it, or on release.
 */
function scheduleSharedWatchRelease(watchKey: string, watch: SharedConversationWatch): void {
  // Already torn down, or a release is already scheduled — idempotent no-op.
  if (watch.torndown || watch.pendingReleaseTimer !== null) {
    return;
  }

  const graceMs = sharedWatchReleaseGraceMs;
  if (graceMs <= 0) {
    releaseSharedWatch(watchKey, watch);
    return;
  }

  const timer = setTimeout(() => {
    watch.pendingReleaseTimer = null;
    releaseSharedWatch(watchKey, watch);
  }, graceMs);

  // Never keep the Node event loop alive purely for a deferred watch release.
  timer.unref?.();
  watch.pendingReleaseTimer = timer;
}

export async function watchConversationRealtime(
  tenantId: string,
  conversationKey: string,
  handlers: ConversationWatcherHandlers
): Promise<() => void> {
  ensureFirebase();
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  const normalizedConversationKey = typeof conversationKey === 'string' ? conversationKey.trim() : '';
  if (!normalizedTenantId) {
    throw new Error('Missing tenantId for watchConversationRealtime');
  }
  if (!normalizedConversationKey) {
    throw new Error('Missing conversationKey for watchConversationRealtime');
  }

  const watchKey = [normalizedTenantId, normalizedConversationKey].join('::');
  let watch = sharedConversationWatches.get(watchKey);

  if (watch) {
    // Reusing a live watch. If it was inside its grace-window release, cancel the
    // pending teardown and reuse the still-attached Firebase listeners — no
    // `.off()`, no re-attach (this is what avoids "listen() called twice" churn).
    cancelPendingRelease(watch);
  }

  if (!watch) {
    const db = admin.database();
    const conversationRef = db
      .ref('tenantChat')
      .child(normalizedTenantId)
      .child('conversationMessages')
      .child(normalizedConversationKey);

    const knownMessageIds = new Set<string>();
    const messageDiffStates = new Map<string, WatchMessageDiffState>();

    const listeners = {
      messageListener: (snapshot: admin.database.DataSnapshot) => {
        if (!snapshot.key) {
          return;
        }
        if (knownMessageIds.has(snapshot.key)) {
          return;
        }
        knownMessageIds.add(snapshot.key);
        const payload = normalizeSnapshot(snapshot, normalizedConversationKey);
        if (!payload) {
          return;
        }
        messageDiffStates.set(snapshot.key, buildWatchMessageDiffState(payload));
        trimWatchCaches(knownMessageIds, messageDiffStates);
        broadcast(watchKey, (subscriber) => subscriber.onMessage?.(payload));
      },
      changeListener: (snapshot: admin.database.DataSnapshot) => {
        if (!snapshot.key) {
          return;
        }

        const payload = normalizeSnapshot(snapshot, normalizedConversationKey);
        if (!payload) {
          return;
        }

        // Diff against the COMPACT prior signature. A missing prior signature
        // means this id was either never seen OR its diff state was merely
        // evicted from the bounded cache (finding P3-3). In BOTH cases we must
        // NOT synthesize phantom status/update/delete events (an evicted receipt
        // target would otherwise re-broadcast a fake delivered/read flip or a
        // phantom delete to every subscriber). We only re-seed the signature so a
        // subsequent genuine change is diffed against real prior state.
        const previousState = messageDiffStates.get(snapshot.key);
        const nextState = buildWatchMessageDiffState(payload);
        messageDiffStates.set(snapshot.key, nextState);
        trimWatchCaches(knownMessageIds, messageDiffStates);

        if (!previousState) {
          return;
        }

        const statusChanged =
          previousState.delivered !== nextState.delivered ||
          previousState.read !== nextState.read ||
          previousState.deliveredAt !== nextState.deliveredAt ||
          previousState.readAt !== nextState.readAt;

        if (statusChanged) {
          const statusPayload = deriveStatusPayload(snapshot);
          if (statusPayload) {
            broadcast(watchKey, (subscriber) => subscriber.onStatus?.(statusPayload));
          }
        }

        if (previousState.contentSignature !== nextState.contentSignature) {
          broadcast(watchKey, (subscriber) => subscriber.onMessageUpdate?.(payload));
        }

        if (nextState.deleted && !previousState.deleted) {
          broadcast(watchKey, (subscriber) => subscriber.onMessageDelete?.(payload));
        }
      },
    };

    watch = {
      subscribers: new Map<number, ConversationWatcherHandlers>(),
      nextSubscriberId: 1,
      cleanupFirebase: null,
      initPromise: Promise.resolve(),
      torndown: false,
      pendingReleaseTimer: null,
    };

    watch.initPromise = (async () => {
      const initialSnapshot = await conversationRef.once('value');
      initialSnapshot.forEach((child) => {
        if (child.key) {
          knownMessageIds.add(child.key);
          const payload = normalizeSnapshot(child, normalizedConversationKey);
          if (payload) {
            messageDiffStates.set(child.key, buildWatchMessageDiffState(payload));
            trimWatchCaches(knownMessageIds, messageDiffStates);
          }
        }
        return false;
      });

      safeAttachListener(conversationRef, 'child_added', listeners.messageListener);
      safeAttachListener(conversationRef, 'child_changed', listeners.changeListener);

      // Idempotent teardown: `.off()` runs at most once per watch instance even
      // if cleanup is invoked more than once (stuck-message-delivery-fix hotfix,
      // Fix C).
      watch!.cleanupFirebase = () => {
        if (watch!.torndown) {
          return;
        }
        watch!.torndown = true;
        conversationRef.off('child_added', listeners.messageListener);
        conversationRef.off('child_changed', listeners.changeListener);
      };
    })();

    sharedConversationWatches.set(watchKey, watch);
  }

  const subscriberId = watch.nextSubscriberId++;
  watch.subscribers.set(subscriberId, handlers);

  try {
    await watch.initPromise;
  } catch (error) {
    watch.subscribers.delete(subscriberId);
    if (watch.subscribers.size === 0) {
      // Init failed before any listener could be reused — release immediately
      // (no grace window is useful for a watch that never came up).
      cancelPendingRelease(watch);
      if (sharedConversationWatches.get(watchKey) === watch) {
        sharedConversationWatches.delete(watchKey);
      }
      watch.cleanupFirebase?.();
    }
    throw error;
  }

  return () => {
    const current = sharedConversationWatches.get(watchKey);
    if (!current) {
      return;
    }
    current.subscribers.delete(subscriberId);
    if (current.subscribers.size === 0) {
      // Grace-window release: keep the Firebase listeners alive for a short
      // window instead of tearing down immediately, so a quick re-subscribe
      // reuses them rather than re-attaching (which can trip Firebase's
      // "listen() called twice" assert). Teardown runs when the window elapses
      // with zero subscribers.
      scheduleSharedWatchRelease(watchKey, current);
    }
  };
}

function broadcast(watchKey: string, emit: (subscriber: ConversationWatcherHandlers) => void): void {
  const watch = sharedConversationWatches.get(watchKey);
  if (!watch || watch.subscribers.size === 0) {
    return;
  }

  for (const subscriber of watch.subscribers.values()) {
    try {
      emit(subscriber);
    } catch (error) {
      console.warn('[chat-realtime] subscriber callback failed', error);
    }
  }
}

