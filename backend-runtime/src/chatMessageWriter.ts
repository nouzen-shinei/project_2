import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { ensureFirebase } from './firebaseAdmin';
import { getConversationKey, normalizeEmail, sanitizeKey } from './chatRealtime';

// ─── Helpers for videoTranscodes RTDB write-back ─────────────────────────────

/** Parse the storage object path out of a Firebase Storage download URL. */
function extractStoragePathFromDownloadUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/v0\/b\/[^/]+\/o\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

/** Derive the videoTranscodes Firestore document id for a storage path (mirrors videoTranscoder.ts). */
function transcodeDocIdFromPath(storagePath: string): string {
  return crypto.createHash('sha256').update(storagePath).digest('hex').slice(0, 40);
}

/**
 * Fire-and-forget: record the RTDB message location in each video attachment's
 * videoTranscodes Firestore document so the transcoder can write transcodedUrl
 * back to the message when transcoding completes.
 */
function recordRtdbPathInTranscodeDocs(
  tenantId: string,
  conversationKey: string,
  messageId: string,
  attachments: Array<{ url: string; fileType?: string; fileName?: string }> | undefined,
  singleFileUrl?: string,
  singleFileType?: string
): void {
  try {
    const fsdb = admin.firestore();
    const rtdbPath = { rtdbTenantId: tenantId, rtdbConversationKey: conversationKey, rtdbMessageId: messageId };

    const processUrl = (url: string, attachmentIndex: number) => {
      const storagePath = extractStoragePathFromDownloadUrl(url);
      if (!storagePath) return;
      const docId = transcodeDocIdFromPath(storagePath);
      fsdb.collection('videoTranscodes').doc(docId)
        .set({ ...rtdbPath, rtdbAttachmentIndex: attachmentIndex }, { merge: true })
        .catch((err: unknown) =>
          console.warn('[chatMessageWriter] failed to record RTDB path in videoTranscodes', err)
        );
    };

    if (singleFileUrl && /\bvideo\b/i.test(singleFileType ?? '')) {
      processUrl(singleFileUrl, -1);
    }

    (attachments ?? []).forEach((att, i) => {
      if (/\bvideo\b/i.test(att.fileType ?? '') || /\bvideo\b/i.test(att.fileName ?? '')) {
        processUrl(att.url, i);
      }
    });
  } catch (err) {
    console.warn('[chatMessageWriter] recordRtdbPathInTranscodeDocs error', err);
  }
}

const DEFAULT_EDIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_DELETE_WINDOW_MS = 0; // unlimited by default
const DEVICE_ONLINE_STALE_MS = 2 * 60 * 1000;
const ACTIVE_CHAT_STALE_MS = 45 * 1000;

function resolveWindowMs(secondsEnv?: string, msEnv?: string, fallbackMs: number = DEFAULT_EDIT_WINDOW_MS): number {
  const seconds = Number(secondsEnv);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const millis = Number(msEnv);
  if (Number.isFinite(millis) && millis >= 0) {
    return Math.round(millis);
  }
  return fallbackMs;
}

export const CHAT_MESSAGE_EDIT_WINDOW_MS = resolveWindowMs(
  process.env.CHAT_MESSAGE_EDIT_WINDOW_SECONDS,
  process.env.CHAT_MESSAGE_EDIT_WINDOW_MS,
  DEFAULT_EDIT_WINDOW_MS
);

export const CHAT_MESSAGE_DELETE_WINDOW_MS = resolveWindowMs(
  process.env.CHAT_MESSAGE_DELETE_WINDOW_SECONDS,
  process.env.CHAT_MESSAGE_DELETE_WINDOW_MS,
  DEFAULT_DELETE_WINDOW_MS
);

export class ChatMessageActionError extends Error {
  code: 'not_found' | 'not_authorized' | 'too_old' | 'invalid_payload' | 'not_allowed' | 'already_deleted';
  details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ChatMessageActionError['code'],
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ChatMessageActionError';
    this.code = code;
    this.details = details;
  }
}

type LastMessageType =
  | 'text'
  | 'sticker'
  | 'gif'
  | 'attachment'
  | 'special'
  | 'deleted'
  | 'unknown';
type SummaryUpdateStrategy = 'increment' | 'decrement' | 'reset' | 'preserve';
type ChatDeliverySource = 'presence' | 'push';

export interface ChatDeliveryProvenance {
  sources?: ChatDeliverySource[];
  lastSource?: ChatDeliverySource;
  lastUpdatedAt?: string;
  presence?: {
    deliveredAt?: string;
    onlineDeviceCount?: number;
    focusedDeviceCount?: number;
  };
  push?: {
    deliveredAt?: string;
    acceptedDeviceCount?: number;
    mobileAcceptedCount?: number;
    webAcceptedCount?: number;
  };
}

export interface FileAttachment {
  url: string;
  fileName: string;
  fileType: string;
  fileSize?: number;
  thumbnailUrl?: string;
}

export interface StickerPayload {
  url: string;
  name: string;
  pack?: string;
  width?: number;
  height?: number;
}

export interface GifPayload {
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  title?: string;
  source?: string;
}

export interface ChatReplyContextPayload {
  messageId: string;
  sender: string;
  senderName?: string;
  text?: string;
  isSpecial?: boolean;
  hasAttachments?: boolean;
  attachmentCount?: number;
  hasSticker?: boolean;
  hasGif?: boolean;
}

export interface SendChatMessageInput {
  senderEmail: string;
  recipientEmail: string;
  tenantId: string;
  // Stable client-generated message identity used as the server idempotency key
  // so a retried/re-driven send upserts the same durable record instead of
  // creating a duplicate (stuck-message-delivery-fix, Defect A).
  clientMsgId?: string;
  text?: string;
  isSpecial?: boolean;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  thumbnailUrl?: string;
  attachments?: FileAttachment[];
  replyTo?: ChatReplyContextPayload;
  sticker?: StickerPayload;
  gif?: GifPayload;
  delivered?: boolean;
  read?: boolean;
}

export interface EditChatMessageInput {
  messageId: string;
  editorEmail?: string;
  text: string;
  force?: boolean;
  tenantId?: string;
}

export interface DeleteChatMessageInput {
  messageId: string;
  requesterEmail?: string;
  force?: boolean;
  tenantId?: string;
}

export interface ChatMessageRecord {
  id: string;
  text: string;
  sender: string;
  recipientId?: string;
  clientMsgId?: string;
  timestamp: string;
  conversationKey: string;
  tenantId?: string | null;
  isSpecial: boolean;
  reactions?: Record<string, string[]>;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  thumbnailUrl?: string;
  attachments?: FileAttachment[];
  replyTo?: ChatReplyContextPayload;
  sticker?: StickerPayload;
  gif?: GifPayload;
  delivered: boolean;
  read: boolean;
  deliveredAt?: string;
  readAt?: string;
  deliveryProvenance?: ChatDeliveryProvenance;
  editedAt?: string;
  editCount?: number;
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
}

export interface ToggleChatReactionInput {
  messageId: string;
  tenantId: string;
  actorEmail: string;
  reactionType: string;
}

export interface SyncChatConversationReceiptsInput {
  tenantId: string;
  actorEmail: string;
  partnerEmail: string;
  deliveredMessageIds?: string[];
  readMessageIds?: string[];
  markConversationDelivered?: boolean;
}

export interface SyncChatConversationReceiptsResult {
  deliveredMessageIds: string[];
  readMessageIds: string[];
  deliveredCount: number;
  readCount: number;
  actorHasOnlineDevice: boolean;
  actorHasFocusedChatDevice: boolean;
}

export interface ConfirmOutboundChatDeliveryInput {
  tenantId: string;
  actorEmail: string;
  partnerEmail: string;
  deliveredMessageIds: string[];
  provenance?: ChatDeliveryProvenance;
}

export interface ConfirmOutboundChatDeliveryResult {
  deliveredMessageIds: string[];
  deliveredCount: number;
}

export interface MarkPendingChatMessagesDeliveredInput {
  tenantId: string;
  recipientEmail: string;
}

export interface MarkPendingChatMessagesDeliveredResult {
  deliveredMessageIds: string[];
  deliveredCount: number;
  recipientHasOnlineDevice: boolean;
}

export interface MarkChatConversationReadInput {
  tenantId: string;
  // The signed-in user reading the conversation (bound to the auth token by the
  // route — never client-supplied). Only their own incoming unread messages are
  // marked read (chat-production-hardening, finding P0-1 — Model A: backend is
  // the only writer).
  actorEmail: string;
  partnerEmail: string;
}

export interface MarkChatConversationReadResult {
  readMessageIds: string[];
  updatedCount: number;
}

export interface ReconcileChatUnreadForUserInput {
  tenantId: string;
  // The signed-in user whose stored unread counters are reconciled against the
  // true-unread set. Bound to the auth token by the route.
  actorEmail: string;
}

export interface ReconcileChatUnreadForUserResult {
  reconciledConversations: number;
  selfConversationsCleaned: number;
}

export interface RebuildChatSummariesForUserInput {
  tenantId: string;
  // The signed-in user whose conversation summaries are reconstructed. Bound to
  // the auth token by the route — never client-supplied.
  actorEmail: string;
}

export interface RebuildChatSummariesForUserResult {
  rebuiltConversations: number;
  prunedConversations: number;
}

interface ConversationSummary {
  partnerEmail: string;
  partnerId?: string | null;
  partnerName?: string | null;
  tenantId?: string | null;
  lastMessage?: {
    messageId: string;
    text: string;
    timestamp: string;
    sender: string;
    isOwnMessage: boolean;
    delivered: boolean;
    read: boolean;
    type: LastMessageType;
    attachmentCount?: number;
    isSpecial?: boolean;
    editedAt?: string;
    deleted?: boolean;
    deletedAt?: string;
  } | null;
  unreadCount: number;
  updatedAt: string;
}

interface ConversationLatestRecord {
  messageId: string;
  timestamp: string;
  sender: string;
  recipientId: string | null;
  tenantId?: string | null;
  delivered: boolean;
  read: boolean;
  deliveryProvenance?: ChatDeliveryProvenance;
  isSpecial: boolean;
  deleted?: boolean;
  editedAt?: string;
  preview: {
    text: string;
    type: LastMessageType;
    attachmentCount?: number;
  };
}

interface SummaryUpdateOptions {
  unreadStrategy: SummaryUpdateStrategy;
  unreadAmount?: number;
  forceUpdateLastMessage?: boolean;
  updateIfSameMessageId?: boolean;
}

function sanitizeNonNegativeCount(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return undefined;
  }
  return Math.trunc(numeric);
}

function normalizeDeliverySource(value: unknown): ChatDeliverySource | undefined {
  return value === 'presence' || value === 'push' ? value : undefined;
}

function normalizeDeliverySources(values: unknown[]): ChatDeliverySource[] {
  const result: ChatDeliverySource[] = [];
  for (const value of values) {
    const normalized = normalizeDeliverySource(value);
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function normalizeChatDeliveryProvenance(input: unknown): ChatDeliveryProvenance | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const raw = input as Record<string, any>;
  const lastSource = normalizeDeliverySource(raw.lastSource);
  const presence = raw.presence && typeof raw.presence === 'object'
    ? pruneUndefined({
        deliveredAt: typeof raw.presence.deliveredAt === 'string' && raw.presence.deliveredAt.trim()
          ? raw.presence.deliveredAt
          : undefined,
        onlineDeviceCount: sanitizeNonNegativeCount(raw.presence.onlineDeviceCount),
        focusedDeviceCount: sanitizeNonNegativeCount(raw.presence.focusedDeviceCount),
      })
    : undefined;
  const push = raw.push && typeof raw.push === 'object'
    ? pruneUndefined({
        deliveredAt: typeof raw.push.deliveredAt === 'string' && raw.push.deliveredAt.trim()
          ? raw.push.deliveredAt
          : undefined,
        acceptedDeviceCount: sanitizeNonNegativeCount(raw.push.acceptedDeviceCount),
        mobileAcceptedCount: sanitizeNonNegativeCount(raw.push.mobileAcceptedCount),
        webAcceptedCount: sanitizeNonNegativeCount(raw.push.webAcceptedCount),
      })
    : undefined;

  const sources = normalizeDeliverySources([
    ...(Array.isArray(raw.sources) ? raw.sources : []),
    lastSource,
    presence ? 'presence' : undefined,
    push ? 'push' : undefined,
  ]);

  const normalized = pruneUndefined({
    sources: sources.length ? sources : undefined,
    lastSource,
    lastUpdatedAt: typeof raw.lastUpdatedAt === 'string' && raw.lastUpdatedAt.trim()
      ? raw.lastUpdatedAt
      : undefined,
    presence: presence && Object.keys(presence).length ? presence : undefined,
    push: push && Object.keys(push).length ? push : undefined,
  });

  return Object.keys(normalized).length ? normalized : undefined;
}

function maxDefinedCount(current: number | undefined, next: number | undefined): number | undefined {
  if (typeof current !== 'number') {
    return next;
  }
  if (typeof next !== 'number') {
    return current;
  }
  return Math.max(current, next);
}

function mergeChatDeliveryProvenance(
  current: ChatDeliveryProvenance | undefined,
  update: ChatDeliveryProvenance | undefined,
  fallbackTimestamp?: string
): ChatDeliveryProvenance | undefined {
  const existing = normalizeChatDeliveryProvenance(current);
  const incoming = normalizeChatDeliveryProvenance(update);
  if (!existing && !incoming) {
    return undefined;
  }

  const presence = existing?.presence || incoming?.presence
    ? pruneUndefined({
        deliveredAt: existing?.presence?.deliveredAt ?? incoming?.presence?.deliveredAt,
        onlineDeviceCount: maxDefinedCount(existing?.presence?.onlineDeviceCount, incoming?.presence?.onlineDeviceCount),
        focusedDeviceCount: maxDefinedCount(existing?.presence?.focusedDeviceCount, incoming?.presence?.focusedDeviceCount),
      })
    : undefined;

  const push = existing?.push || incoming?.push
    ? pruneUndefined({
        deliveredAt: existing?.push?.deliveredAt ?? incoming?.push?.deliveredAt,
        acceptedDeviceCount: maxDefinedCount(existing?.push?.acceptedDeviceCount, incoming?.push?.acceptedDeviceCount),
        mobileAcceptedCount: maxDefinedCount(existing?.push?.mobileAcceptedCount, incoming?.push?.mobileAcceptedCount),
        webAcceptedCount: maxDefinedCount(existing?.push?.webAcceptedCount, incoming?.push?.webAcceptedCount),
      })
    : undefined;

  const sources = normalizeDeliverySources([
    ...(existing?.sources ?? []),
    ...(incoming?.sources ?? []),
    existing?.lastSource,
    incoming?.lastSource,
    presence ? 'presence' : undefined,
    push ? 'push' : undefined,
  ]);

  const merged = pruneUndefined({
    sources: sources.length ? sources : undefined,
    lastSource: incoming?.lastSource ?? existing?.lastSource,
    lastUpdatedAt: incoming?.lastUpdatedAt ?? fallbackTimestamp ?? existing?.lastUpdatedAt,
    presence: presence && Object.keys(presence).length ? presence : undefined,
    push: push && Object.keys(push).length ? push : undefined,
  });

  return Object.keys(merged).length ? merged : undefined;
}

function buildPresenceDeliveryProvenance(
  receiptState: { onlineDeviceCount: number; focusedChatDeviceCount: number },
  deliveredAt: string
): ChatDeliveryProvenance | undefined {
  if (receiptState.onlineDeviceCount <= 0) {
    return undefined;
  }
  return {
    sources: ['presence'],
    lastSource: 'presence',
    lastUpdatedAt: deliveredAt,
    presence: pruneUndefined({
      deliveredAt,
      onlineDeviceCount: receiptState.onlineDeviceCount,
      focusedDeviceCount: receiptState.focusedChatDeviceCount,
    }),
  };
}

function buildPushDeliveryProvenance(
  stats: {
    acceptedDeviceCount?: number;
    mobileAcceptedCount?: number;
    webAcceptedCount?: number;
  },
  deliveredAt: string
): ChatDeliveryProvenance | undefined {
  const acceptedDeviceCount = sanitizeNonNegativeCount(stats.acceptedDeviceCount);
  const mobileAcceptedCount = sanitizeNonNegativeCount(stats.mobileAcceptedCount);
  const webAcceptedCount = sanitizeNonNegativeCount(stats.webAcceptedCount);
  if (!acceptedDeviceCount && !mobileAcceptedCount && !webAcceptedCount) {
    return undefined;
  }
  return {
    sources: ['push'],
    lastSource: 'push',
    lastUpdatedAt: deliveredAt,
    push: pruneUndefined({
      deliveredAt,
      acceptedDeviceCount,
      mobileAcceptedCount,
      webAcceptedCount,
    }),
  };
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      result[key] = entry;
    }
  }
  return result as T;
}

// A self-conversation key has two identical participant halves (emailA == emailB).
function isSelfConversationKey(conversationKey?: string | null): boolean {
  if (typeof conversationKey !== 'string') {
    return false;
  }
  const halves = conversationKey.split('__').filter(Boolean);
  return halves.length === 2 && halves[0] === halves[1];
}

// The six characters Firebase RTDB forbids in a path segment: . # $ [ ] /
const ILLEGAL_RTDB_PATH_CHARS = /[.#$[\]/]/g;

/**
 * Deterministically map a clientMsgId to an RTDB-path-safe form by replacing each
 * illegal path character (`.`, `#`, `$`, `[`, `]`, `/`) with `_`. Trims first.
 * MUST remain byte-for-byte identical to the client implementation in
 * `lib/pendingId.ts` so the idempotency index key matches regardless of which
 * side computed it. A malformed-but-nonempty clientMsgId is sanitized and used —
 * never thrown on — so the writer can never 500 on a bad path segment
 * (stuck-message-delivery-fix hotfix, Fix A).
 *
 * Idempotent: sanitizeClientMsgId(sanitizeClientMsgId(x)) === sanitizeClientMsgId(x).
 */
function sanitizeClientMsgId(id: unknown): string {
  if (typeof id !== 'string') {
    return '';
  }
  return id.trim().replace(ILLEGAL_RTDB_PATH_CHARS, '_');
}

/**
 * Look up a previously-persisted durable record for a (conversation, clientMsgId)
 * pair so a retried/re-driven send returns the existing message instead of
 * creating a duplicate. Returns null when no prior record is indexed or the
 * indexed record no longer exists (stuck-message-delivery-fix, Defect A).
 */
async function findChatMessageByClientMsgId(
  db: admin.database.Database,
  tenantId: string,
  conversationKey: string,
  clientMsgId: string
): Promise<ChatMessageRecord | null> {
  // Defensive: always sanitize before using as a `.child()` path segment so a
  // caller that forgot to sanitize can never crash the lookup. Idempotent, so
  // an already-sanitized id is unchanged.
  const safeClientMsgId = sanitizeClientMsgId(clientMsgId);
  if (!safeClientMsgId) {
    return null;
  }
  const indexSnap = await tenantChatRootRef(db, tenantId)
    .child('conversationClientMsgIndex')
    .child(conversationKey)
    .child(safeClientMsgId)
    .get();
  const mappedId = indexSnap.exists() ? indexSnap.val() : null;
  if (typeof mappedId !== 'string' || !mappedId) {
    return null;
  }
  const messageSnap = await tenantChatRootRef(db, tenantId)
    .child('conversationMessages')
    .child(conversationKey)
    .child(mappedId)
    .get();
  if (!messageSnap.exists()) {
    return null;
  }
  return messageSnap.val() as ChatMessageRecord;
}

function getTimestampMs(value?: string | number | Date | null): number {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getArbitraryTimestampMs(value: unknown): number {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return getTimestampMs(value);
  }
  if (typeof (value as any)?.toMillis === 'function') {
    try {
      return Number((value as any).toMillis()) || 0;
    } catch {
      return 0;
    }
  }
  if (typeof (value as any)?.toDate === 'function') {
    try {
      const date = (value as any).toDate();
      return date instanceof Date ? date.getTime() : 0;
    } catch {
      return 0;
    }
  }
  if (typeof (value as any)?.seconds === 'number') {
    const seconds = Number((value as any).seconds);
    const nanos = typeof (value as any)?.nanoseconds === 'number' ? Number((value as any).nanoseconds) : 0;
    return Math.round(seconds * 1000 + nanos / 1_000_000);
  }
  return 0;
}

function tenantMatchesDevice(device: Record<string, any>, tenantId: string): boolean {
  const normalizedTenantId = (tenantId || '').trim();
  if (!normalizedTenantId) {
    return false;
  }

  const tenantIds = Array.isArray(device.tenantIds)
    ? device.tenantIds
        .map((entry: unknown) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry: string) => Boolean(entry))
    : [];
  if (tenantIds.includes(normalizedTenantId)) {
    return true;
  }

  const activeTenantId = typeof device.activeTenantId === 'string' ? device.activeTenantId.trim() : '';
  if (activeTenantId === normalizedTenantId) {
    return true;
  }

  if (Array.isArray(device.tenantMemberships)) {
    return device.tenantMemberships.some((membership: any) => {
      if (!membership || typeof membership.tenantId !== 'string') {
        return false;
      }
      if (membership.tenantId.trim() !== normalizedTenantId) {
        return false;
      }
      if (typeof membership.status !== 'string') {
        return true;
      }
      return membership.status.trim().toLowerCase() === 'active';
    });
  }

  return false;
}

function isDeviceLoggedOut(device: Record<string, any>): boolean {
  if (device.sessionActive === false) return true;
  const logoutType = typeof device.logoutType === 'string' ? device.logoutType : '';
  if (logoutType === 'manual' || logoutType === 'forced') return true;
  const lastActivityType = typeof device.lastActivityType === 'string' ? device.lastActivityType : '';
  if (lastActivityType === 'logout' || lastActivityType === 'forced_logout') return true;
  return false;
}

function isOnlineTenantDevice(device: Record<string, any>, tenantId: string, nowMs: number): boolean {
  if (!tenantMatchesDevice(device, tenantId)) {
    return false;
  }
  if (device.isDeleted === true) {
    return false;
  }
  if (isDeviceLoggedOut(device)) {
    return false;
  }
  if (device.isOnline !== true) {
    return false;
  }

  const lastSeenMs = Math.max(
    getArbitraryTimestampMs(device.lastSeen),
    getArbitraryTimestampMs(device.updatedAt),
    getArbitraryTimestampMs(device.lastActivity)
  );

  if (lastSeenMs <= 0) {
    return false;
  }

  return nowMs - lastSeenMs <= DEVICE_ONLINE_STALE_MS;
}

function isFocusedChatTenantDevice(
  device: Record<string, any>,
  tenantId: string,
  partnerEmail: string,
  nowMs: number
): boolean {
  if (!isOnlineTenantDevice(device, tenantId, nowMs)) {
    return false;
  }
  if (device.activeChatIsFocused !== true) {
    return false;
  }
  if (normalizeEmail(device.activeChatPartner) !== normalizeEmail(partnerEmail)) {
    return false;
  }

  const chatSeenMs = Math.max(
    getArbitraryTimestampMs(device.activeChatLastSeenAt),
    getArbitraryTimestampMs(device.lastSeen),
    getArbitraryTimestampMs(device.updatedAt)
  );

  if (chatSeenMs <= 0) {
    return false;
  }

  return nowMs - chatSeenMs <= ACTIVE_CHAT_STALE_MS;
}

// ─── Receipt-promotion resilience + performance hardening ────────────────────
// (chat-production-hardening — receipt-promotion resilience + perf hardening.)
//
// The throttle (Part B) and the device receipt-state cache (Part C) trade a tiny
// bounded window of staleness for a sharp reduction in redundant work on the
// hottest receipt path (devices/ping fires promotion on EVERY ping). They only
// ever REDUCE redundant work — a genuinely-needed receipt is never dropped
// because the next ping after the window (or the next inbound message) still
// promotes. Under the node:test / jest runners the default windows collapse to 0
// so the pre-existing suites observe the exact prior (uncached, unthrottled)
// behavior; each dedicated test opts back in via its `__set*` hook. Production
// (neither env var set) keeps the conservative windows.
const IS_TEST_RUNTIME = Boolean(process.env.NODE_TEST_CONTEXT || process.env.JEST_WORKER_ID);

interface RecipientDeviceReceiptState {
  hasOnlineDevice: boolean;
  hasFocusedChatDevice: boolean;
  onlineDeviceCount: number;
  focusedChatDeviceCount: number;
}

// Part C — short-TTL device receipt-state cache. Device presence does not change
// sub-second, so within a small window it is safe to reuse the last-resolved
// state instead of re-reading ALL of the recipient's Firestore device docs on
// every receipt sync/promotion. Keyed by tenant + recipient + partner (the FOCUS
// count is partner-scoped, so distinct partners must never share an entry;
// the delivery-only path uses '' for partner and gets its own entry).
export const DEFAULT_RECEIPT_STATE_CACHE_TTL_MS = 2500;
let receiptStateCacheTtlMs = IS_TEST_RUNTIME ? 0 : DEFAULT_RECEIPT_STATE_CACHE_TTL_MS;
const receiptStateCache = new Map<string, { expiresAt: number; value: RecipientDeviceReceiptState }>();

/**
 * Test hook: set the device receipt-state cache TTL (ms). `0` disables caching
 * (every call re-reads Firestore). Not part of the public runtime API — exported
 * only so tests can drive cache behavior deterministically.
 */
export function __setReceiptStateCacheTtlMs(ms: number): void {
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
    receiptStateCacheTtlMs = ms;
  }
}

/** Test hook: clear the cache and reset the TTL to its (runtime) default. */
export function __resetReceiptStateCache(): void {
  receiptStateCacheTtlMs = IS_TEST_RUNTIME ? 0 : DEFAULT_RECEIPT_STATE_CACHE_TTL_MS;
  receiptStateCache.clear();
}

async function resolveRecipientDeviceReceiptState(
  tenantId: string,
  recipientEmail: string,
  partnerEmail: string
): Promise<RecipientDeviceReceiptState> {
  ensureFirebase();
  const normalizedRecipient = normalizeEmail(recipientEmail);
  const normalizedPartner = normalizeEmail(partnerEmail);
  // Only the recipient identity is required to resolve ONLINE devices. A partner
  // is needed solely for the per-conversation FOCUS check below, so the
  // delivery-only caller (`markPendingChatMessagesDeliveredForRecipient`, which
  // passes an empty partner) can still detect an online device and promote
  // pending receipts. When no partner is supplied the focus count stays 0,
  // exactly matching the prior all-false result for that case
  // (chat-production-hardening, finding P2-3).
  if (!normalizedRecipient) {
    return {
      hasOnlineDevice: false,
      hasFocusedChatDevice: false,
      onlineDeviceCount: 0,
      focusedChatDeviceCount: 0,
    };
  }

  // Part C: short-TTL cache. The key includes the partner so a partner-scoped
  // FOCUS count for one conversation is never served for a different partner
  // (the delivery-only '' partner gets its own entry).
  const cacheKey = `${tenantId}::${normalizedRecipient}::${normalizedPartner}`;
  const nowMs = Date.now();
  if (receiptStateCacheTtlMs > 0) {
    const cached = receiptStateCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.value };
    }
  }

  const db = admin.firestore();
  const devicesSnap = await db
    .collection('user_devices')
    .doc(normalizedRecipient)
    .collection('devices')
    .get();

  let onlineDeviceCount = 0;
  let focusedChatDeviceCount = 0;

  for (const doc of devicesSnap.docs) {
    const data = (doc.data() || {}) as Record<string, any>;
    if (isOnlineTenantDevice(data, tenantId, nowMs)) {
      onlineDeviceCount += 1;
    }
    // Focus is conversation-scoped: only meaningful when a partner is supplied.
    if (normalizedPartner && isFocusedChatTenantDevice(data, tenantId, normalizedPartner, nowMs)) {
      focusedChatDeviceCount += 1;
    }
  }

  const resolved: RecipientDeviceReceiptState = {
    hasOnlineDevice: onlineDeviceCount > 0,
    hasFocusedChatDevice: focusedChatDeviceCount > 0,
    onlineDeviceCount,
    focusedChatDeviceCount,
  };

  if (receiptStateCacheTtlMs > 0) {
    receiptStateCache.set(cacheKey, { expiresAt: nowMs + receiptStateCacheTtlMs, value: { ...resolved } });
  }

  return resolved;
}

function computeMessagePreview(message: ChatMessageRecord): {
  text: string;
  type: LastMessageType;
  attachmentCount?: number;
} {
  if (message.deleted) {
    return { text: 'Message deleted', type: 'deleted' };
  }

  if (message.isSpecial) {
    return { text: message.text || 'Special message', type: 'special' };
  }

  if (message.sticker) {
    return { text: '🎯 Sticker', type: 'sticker' };
  }

  if (message.gif) {
    return { text: '🖼️ GIF', type: 'gif' };
  }

  const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
  if (attachmentCount > 0) {
    const label = attachmentCount === 1 ? '📎 Attachment' : `📎 ${attachmentCount} attachments`;
    return { text: label, type: 'attachment', attachmentCount };
  }

  if (message.fileUrl) {
    return { text: '📎 Attachment', type: 'attachment', attachmentCount: 1 };
  }

  const normalizedText = (message.text || '').trim();
  if (normalizedText) {
    return { text: normalizedText, type: 'text' };
  }

  return { text: 'Message', type: 'unknown' };
}

function sumAttachmentArrayBytes(list?: FileAttachment[]): number {
  if (!Array.isArray(list) || !list.length) {
    return 0;
  }
  return list.reduce((total, entry) => {
    const size = Number(entry?.fileSize ?? 0);
    return Number.isFinite(size) && size > 0 ? total + size : total;
  }, 0);
}

function calculateAttachmentBytes(record: { fileSize?: number; attachments?: FileAttachment[] }): number {
  const directSize = Number(record.fileSize ?? 0);
  const primary = Number.isFinite(directSize) && directSize > 0 ? directSize : 0;
  return primary + sumAttachmentArrayBytes(record.attachments);
}

function buildConversationLatestRecord(messageId: string, message: ChatMessageRecord): ConversationLatestRecord | null {
  const sender = normalizeEmail(message.sender);
  if (!sender) {
    return null;
  }

  const preview = computeMessagePreview(message);
  const timestamp = message.timestamp || new Date().toISOString();

  const record: ConversationLatestRecord = {
    messageId,
    timestamp,
    sender,
    recipientId: normalizeEmail(message.recipientId) || null,
    tenantId: message.tenantId ?? null,
    delivered: Boolean(message.delivered),
    read: Boolean(message.read),
    isSpecial: Boolean(message.isSpecial),
    preview: {
      text: preview.text,
      type: preview.type,
    },
  };

  if (message.deleted) {
    record.deleted = true;
    record.preview.text = 'Message deleted';
    record.preview.type = 'deleted';
  }

  if (message.editedAt) {
    record.editedAt = message.editedAt;
  }

  const deliveryProvenance = normalizeChatDeliveryProvenance(message.deliveryProvenance);
  if (deliveryProvenance) {
    record.deliveryProvenance = deliveryProvenance;
  }

  if (typeof preview.attachmentCount === 'number') {
    record.preview.attachmentCount = preview.attachmentCount;
  }

  return record;
}

function buildLastMessageSummary(ownerEmail: string, messageId: string, message: ChatMessageRecord): ConversationSummary['lastMessage'] {
  const normalizedOwner = normalizeEmail(ownerEmail);
  const preview = computeMessagePreview(message);
  const sender = normalizeEmail(message.sender);
  const timestamp = message.timestamp || new Date().toISOString();

  const summary: NonNullable<ConversationSummary['lastMessage']> = {
    messageId,
    text: preview.text,
    timestamp,
    sender,
    isOwnMessage: sender === normalizedOwner,
    delivered: Boolean(message.delivered),
    read: Boolean(message.read),
    type: preview.type,
    isSpecial: Boolean(message.isSpecial),
  };

  if (typeof preview.attachmentCount === 'number') {
    summary.attachmentCount = preview.attachmentCount;
  }

  if (message.editedAt) {
    summary.editedAt = message.editedAt;
  }

  if (message.deleted) {
    summary.deleted = true;
    summary.deletedAt = message.deletedAt ?? timestamp;
    summary.text = 'Message deleted';
    summary.type = 'deleted';
  }

  return summary;
}

function buildMessageIndexRecord(message: ChatMessageRecord) {
  return {
    conversationKey: message.conversationKey,
    sender: normalizeEmail(message.sender),
    recipientId: normalizeEmail(message.recipientId) || null,
    tenantId: message.tenantId ?? null,
    timestamp: message.timestamp,
    delivered: Boolean(message.delivered),
    read: Boolean(message.read),
    isSpecial: Boolean(message.isSpecial),
    hasAttachments: Boolean((message.attachments && message.attachments.length > 0) || message.fileUrl),
    attachmentBytes: calculateAttachmentBytes(message),
    deliveryProvenance: normalizeChatDeliveryProvenance(message.deliveryProvenance) ?? null,
    deleted: Boolean(message.deleted),
    editedAt: message.editedAt || null,
    lastUpdated: new Date().toISOString(),
  };
}

function tenantChatRootRef(db: admin.database.Database, tenantId: string): admin.database.Reference {
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!normalizedTenantId) {
    throw new Error('Tenant id is required');
  }
  return db.ref('tenantChat').child(normalizedTenantId);
}

async function writeMessageIndexRecord(
  db: admin.database.Database,
  tenantId: string,
  message: ChatMessageRecord
): Promise<void> {
  await tenantChatRootRef(db, tenantId).child('messageIndex').child(message.id).set(buildMessageIndexRecord(message));
}

async function updateConversationLatest(
  db: admin.database.Database,
  tenantId: string,
  conversationKey: string,
  messageId: string,
  message: ChatMessageRecord
): Promise<void> {
  const record = buildConversationLatestRecord(messageId, message);
  if (!record) {
    return;
  }
  await tenantChatRootRef(db, tenantId).child('conversationLatest').child(conversationKey).set(record);
}

async function updateUserConversationState(
  db: admin.database.Database,
  tenantId: string,
  userKey: string | null,
  conversationKey: string | null,
  payload: Record<string, unknown>
): Promise<void> {
  if (!userKey || !conversationKey) {
    return;
  }
  const cleaned = pruneUndefined(payload);
  if (!Object.keys(cleaned).length) {
    return;
  }
  await tenantChatRootRef(db, tenantId).child('userConversations').child(`${userKey}/${conversationKey}`).update(cleaned);
}

async function registerConversationForUsers(
  db: admin.database.Database,
  tenantId: string,
  userEmailA?: string | null,
  userEmailB?: string | null,
  messageId?: string | null,
  timestamp?: string,
): Promise<void> {
  const normalizedA = normalizeEmail(userEmailA);
  const normalizedB = normalizeEmail(userEmailB);
  const keyA = sanitizeKey(normalizedA);
  const keyB = sanitizeKey(normalizedB);
  const conversationKey = getConversationKey(normalizedA, normalizedB);
  if (!normalizedA || !normalizedB || !keyA || !keyB || !conversationKey) {
    return;
  }

  const updatedAt = timestamp ?? new Date().toISOString();

  const payloadForA = {
    conversationKey,
    partnerEmail: normalizedB,
    partnerKey: keyB,
    lastMessageId: messageId ?? null,
    updatedAt,
    unreadCount: 0,
    tenantId: tenantId ?? null,
  };

  const payloadForB = {
    conversationKey,
    partnerEmail: normalizedA,
    partnerKey: keyA,
    lastMessageId: messageId ?? null,
    updatedAt,
    unreadCount: 0,
    tenantId: tenantId ?? null,
  };

  await Promise.all([
    tenantChatRootRef(db, tenantId).child('userConversations').child(`${keyA}/${conversationKey}`).set(payloadForA),
    tenantChatRootRef(db, tenantId).child('userConversations').child(`${keyB}/${conversationKey}`).set(payloadForB),
  ]);
}

/**
 * Run an RTDB `transaction` with bounded retry + jittered backoff.
 *
 * The conversation-summary node (`conversationSummaries/{owner}/{partner}`) is a
 * write hotspot: every send increments the recipient's unread + rewrites
 * `lastMessage`, and every read decrements it. Firebase RTDB aborts a transaction
 * after ~25 internal collisions with `Error: maxretry`; under a burst (e.g. sending
 * many stickers while the peer's read-marking runs) that limit is reached and the
 * transaction throws. Re-attempting a *fresh* transaction after a short jittered
 * pause lets the burst settle so the write lands, instead of the caller failing.
 *
 * Only `maxretry`-class contention aborts are retried; any other error propagates
 * immediately. After the final attempt the last error is rethrown so callers that
 * need to know (or already treat it best-effort) keep their existing behavior.
 */
async function runRtdbTransactionWithRetry(
  ref: admin.database.Reference,
  updateFn: (current: any) => any,
  options?: { attempts?: number; label?: string }
): Promise<Awaited<ReturnType<admin.database.Reference['transaction']>>> {
  const maxAttempts = Math.max(1, options?.attempts ?? 4);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await ref.transaction(updateFn);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isContentionAbort = /maxretry/i.test(message);
      if (!isContentionAbort || attempt === maxAttempts) {
        throw error;
      }
      // Exponential backoff (50/100/200…ms) capped at 1s, plus up to 100ms jitter
      // so concurrent callers don't resynchronize and re-collide.
      const backoffMs = Math.min(1000, 50 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

async function updateConversationSummaryForMessage(
  db: admin.database.Database,
  tenantId: string,
  ownerEmail: string,
  partnerEmail: string | undefined,
  messageId: string,
  message: ChatMessageRecord,
  options: SummaryUpdateOptions
): Promise<ConversationSummary | null> {
  const normalizedOwner = normalizeEmail(ownerEmail);
  const normalizedPartner = normalizeEmail(partnerEmail);
  if (!normalizedOwner || !normalizedPartner) {
    return null;
  }

  const ownerKey = sanitizeKey(normalizedOwner);
  const partnerKey = sanitizeKey(normalizedPartner);
  if (!ownerKey || !partnerKey) {
    return null;
  }

  const summaryRef = tenantChatRootRef(db, tenantId).child('conversationSummaries').child(`${ownerKey}/${partnerKey}`);
  const unreadAmount = options.unreadAmount ?? 1;

  const result = await runRtdbTransactionWithRetry(summaryRef, (currentValue) => {
    const current: ConversationSummary = currentValue && typeof currentValue === 'object'
      ? {
          partnerEmail: normalizeEmail((currentValue as ConversationSummary).partnerEmail) || normalizedPartner,
          partnerId: (currentValue as ConversationSummary).partnerId ?? null,
          partnerName: (currentValue as ConversationSummary).partnerName ?? null,
          tenantId: (currentValue as ConversationSummary).tenantId ?? null,
          lastMessage: (currentValue as ConversationSummary).lastMessage ?? null,
          unreadCount: typeof (currentValue as ConversationSummary).unreadCount === 'number'
            ? (currentValue as ConversationSummary).unreadCount
            : 0,
          updatedAt: (currentValue as ConversationSummary).updatedAt || new Date().toISOString(),
        }
      : {
          partnerEmail: normalizedPartner,
          partnerId: null,
          partnerName: null,
          tenantId: null,
          lastMessage: null,
          unreadCount: 0,
          updatedAt: new Date().toISOString(),
        };

    let nextUnread = current.unreadCount;
    switch (options.unreadStrategy) {
      case 'increment':
        nextUnread = current.unreadCount + unreadAmount;
        break;
      case 'decrement':
        nextUnread = Math.max(0, current.unreadCount - unreadAmount);
        break;
      case 'reset':
        nextUnread = 0;
        break;
      default:
        nextUnread = current.unreadCount;
        break;
    }

    const incomingTimestampMs = getTimestampMs(message.timestamp);
    const existingTimestampMs = getTimestampMs(current.lastMessage?.timestamp);
    const isSameMessage = current.lastMessage?.messageId === messageId;

    const shouldUpdateLastMessage =
      options.forceUpdateLastMessage ||
      !current.lastMessage ||
      incomingTimestampMs >= existingTimestampMs ||
      (options.updateIfSameMessageId && isSameMessage);

    const updatedLastMessage = shouldUpdateLastMessage
      ? buildLastMessageSummary(normalizedOwner, messageId, message)
      : current.lastMessage;

    const updatedAt =
      (shouldUpdateLastMessage && updatedLastMessage?.timestamp) ||
      current.updatedAt ||
      message.timestamp ||
      new Date().toISOString();

    return {
      partnerEmail: normalizedPartner,
      partnerId: current.partnerId ?? null,
      partnerName: current.partnerName ?? null,
      tenantId: message.tenantId ?? current.tenantId ?? null,
      lastMessage: updatedLastMessage ?? current.lastMessage ?? null,
      unreadCount: nextUnread,
      updatedAt,
    } satisfies ConversationSummary;
  });

  return (result.snapshot?.val() as ConversationSummary) ?? null;
}

async function applySummaryUpdatesForMessage(
  db: admin.database.Database,
  messageId: string,
  message: ChatMessageRecord,
  options: {
    recipientUnreadStrategy?: SummaryUpdateStrategy;
    recipientUnreadAmount?: number;
    forceUpdateLastMessage?: boolean;
    updateIfSameMessageId?: boolean;
  } = {}
): Promise<void> {
  const tenantId = typeof message.tenantId === 'string' ? message.tenantId.trim() : '';
  if (!tenantId) {
    return;
  }
  const sender = normalizeEmail(message.sender);
  const recipient = normalizeEmail(message.recipientId);
  if (!sender || !recipient) {
    return;
  }

  const normalizedMessage: ChatMessageRecord = {
    ...message,
    sender,
    recipientId: recipient,
  };

  let conversationKey = normalizedMessage.conversationKey || null;
  if (!conversationKey) {
    conversationKey = getConversationKey(sender, recipient);
    if (!conversationKey) {
      return;
    }
    normalizedMessage.conversationKey = conversationKey;
  }

  const pointerPromise = conversationKey
    ? updateConversationLatest(db, tenantId, conversationKey, messageId, normalizedMessage)
    : Promise.resolve();

  const forceUpdateLastMessage = options.forceUpdateLastMessage ?? true;
  const updateIfSameMessageId = options.updateIfSameMessageId ?? true;
  const recipientUnreadStrategy =
    options.recipientUnreadStrategy ?? (normalizedMessage.deleted || normalizedMessage.read ? 'decrement' : 'increment');
  const recipientUnreadAmount = options.recipientUnreadAmount ?? 1;

  const senderSummaryPromise = updateConversationSummaryForMessage(db, tenantId, sender, recipient, messageId, normalizedMessage, {
    unreadStrategy: 'preserve',
    unreadAmount: 0,
    forceUpdateLastMessage,
    updateIfSameMessageId,
  }).catch(() => null);

  const recipientSummaryPromise = updateConversationSummaryForMessage(db, tenantId, recipient, sender, messageId, normalizedMessage, {
    unreadStrategy: recipientUnreadStrategy,
    unreadAmount: recipientUnreadAmount,
    forceUpdateLastMessage,
    updateIfSameMessageId,
  }).catch(() => null);

  const [senderSummary, recipientSummary] = await Promise.all([senderSummaryPromise, recipientSummaryPromise]);

  await pointerPromise;

  if (!conversationKey) {
    return;
  }

  const senderKey = sanitizeKey(sender);
  const recipientKey = sanitizeKey(recipient);
  const senderPartnerKey = sanitizeKey(recipient);
  const recipientPartnerKey = sanitizeKey(sender);
  const timestamp = normalizedMessage.timestamp || new Date().toISOString();

  const metadataUpdates: Promise<void>[] = [];
  if (senderKey) {
    metadataUpdates.push(
      updateUserConversationState(db, tenantId, senderKey, conversationKey, {
        partnerEmail: recipient,
        partnerKey: senderPartnerKey,
        lastMessageId: messageId,
        updatedAt: senderSummary?.updatedAt ?? timestamp,
        unreadCount: senderSummary?.unreadCount ?? 0,
        tenantId: normalizedMessage.tenantId ?? null,
      })
    );
  }

  if (recipientKey) {
    metadataUpdates.push(
      updateUserConversationState(db, tenantId, recipientKey, conversationKey, {
        partnerEmail: sender,
        partnerKey: recipientPartnerKey,
        lastMessageId: messageId,
        updatedAt: recipientSummary?.updatedAt ?? timestamp,
        unreadCount: recipientSummary?.unreadCount ?? 0,
        tenantId: normalizedMessage.tenantId ?? null,
      })
    );
  }

  await Promise.all(metadataUpdates);
}

interface LoadedMessageContext {
  messageId: string;
  message: ChatMessageRecord;
  conversationKey: string;
  messageRef: admin.database.Reference;
  indexRef: admin.database.Reference;
}

async function applyReceiptPatchToMessageContext(
  db: admin.database.Database,
  context: LoadedMessageContext,
  options: {
    deliveredAt?: string;
    readAt?: string;
    markDelivered?: boolean;
    markRead?: boolean;
    deliveryProvenance?: ChatDeliveryProvenance;
  }
): Promise<ChatMessageRecord> {
  const patch: Record<string, unknown> = {};
  const indexPatch: Record<string, unknown> = {
    lastUpdated: new Date().toISOString(),
  };
  let nextMessage: ChatMessageRecord = { ...context.message };
  let changed = false;
  let decrementedUnread = false;

  if (options.markDelivered && !nextMessage.delivered) {
    const deliveredAt = options.deliveredAt ?? new Date().toISOString();
    patch.delivered = true;
    patch.deliveredAt = deliveredAt;
    indexPatch.delivered = true;
    nextMessage = {
      ...nextMessage,
      delivered: true,
      deliveredAt,
    };
    changed = true;
  }

  if (options.markRead && !nextMessage.read) {
    const readAt = options.readAt ?? new Date().toISOString();
    const deliveredAt = nextMessage.deliveredAt ?? options.deliveredAt ?? readAt;
    patch.read = true;
    patch.readAt = readAt;
    patch.delivered = true;
    patch.deliveredAt = deliveredAt;
    indexPatch.read = true;
    indexPatch.delivered = true;
    nextMessage = {
      ...nextMessage,
      read: true,
      readAt,
      delivered: true,
      deliveredAt,
    };
    changed = true;
    decrementedUnread = true;
  }

  const mergedDeliveryProvenance = mergeChatDeliveryProvenance(
    nextMessage.deliveryProvenance,
    options.deliveryProvenance,
    options.readAt ?? options.deliveredAt
  );
  if (
    JSON.stringify(normalizeChatDeliveryProvenance(nextMessage.deliveryProvenance) ?? null)
    !== JSON.stringify(mergedDeliveryProvenance ?? null)
  ) {
    patch.deliveryProvenance = mergedDeliveryProvenance ?? null;
    indexPatch.deliveryProvenance = mergedDeliveryProvenance ?? null;
    nextMessage = {
      ...nextMessage,
      deliveryProvenance: mergedDeliveryProvenance,
    };
    changed = true;
  }

  if (!changed) {
    return nextMessage;
  }

  await Promise.all([
    context.messageRef.update(patch),
    context.indexRef.update(indexPatch),
  ]);

  await applySummaryUpdatesForMessage(db, context.messageId, nextMessage, {
    recipientUnreadStrategy: decrementedUnread ? 'decrement' : 'preserve',
    recipientUnreadAmount: decrementedUnread ? 1 : 0,
    forceUpdateLastMessage: false,
    updateIfSameMessageId: true,
  });

  return nextMessage;
}

// Normalize a raw RTDB message value (from `conversationMessages`) into a typed
// ChatMessageRecord. Extracted from `loadMessageContext` so a bounded query that
// has ALREADY fetched the raw record (e.g. the delivered-scan bounded query) can
// reuse it without paying for a second per-message read (chat-production-hardening,
// finding P2-3 — eliminate the N+1 context load).
function normalizeStoredMessageRecord(
  messageId: string,
  conversationKey: string,
  raw: Record<string, any>
): ChatMessageRecord {
  const normalizedSender = normalizeEmail(raw.sender);
  const normalizedRecipient = normalizeEmail(raw.recipientId);

  const messageTenantId =
    typeof raw.tenantId === 'string'
      ? raw.tenantId
      : raw.tenantId === null
      ? null
      : undefined;

  return {
    id: messageId,
    text: typeof raw.text === 'string' ? raw.text : '',
    sender: normalizedSender,
    recipientId: normalizedRecipient || undefined,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
    conversationKey,
    tenantId: messageTenantId,
    isSpecial: Boolean(raw.isSpecial),
    fileUrl: typeof raw.fileUrl === 'string' ? raw.fileUrl : undefined,
    fileName: typeof raw.fileName === 'string' ? raw.fileName : undefined,
    fileType: typeof raw.fileType === 'string' ? raw.fileType : undefined,
    fileSize: typeof raw.fileSize === 'number' ? raw.fileSize : undefined,
    thumbnailUrl: typeof raw.thumbnailUrl === 'string' ? raw.thumbnailUrl : undefined,
    attachments: Array.isArray(raw.attachments) ? (raw.attachments as FileAttachment[]) : undefined,
    replyTo: normalizeReplyContextPayload(raw.replyTo),
    sticker: raw.sticker as StickerPayload | undefined,
    gif: raw.gif as GifPayload | undefined,
    delivered: Boolean(raw.delivered),
    read: Boolean(raw.read),
    deliveredAt: typeof raw.deliveredAt === 'string' ? raw.deliveredAt : undefined,
    readAt: typeof raw.readAt === 'string' ? raw.readAt : undefined,
    deliveryProvenance: normalizeChatDeliveryProvenance(raw.deliveryProvenance),
    editedAt: typeof raw.editedAt === 'string' ? raw.editedAt : undefined,
    editCount: typeof raw.editCount === 'number' ? raw.editCount : undefined,
    deleted: Boolean(raw.deleted),
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : undefined,
    deletedBy: typeof raw.deletedBy === 'string' ? normalizeEmail(raw.deletedBy) : undefined,
  };
}

// Build a LoadedMessageContext from an ALREADY-NORMALIZED message record without
// re-reading it (the message + index refs are derived purely from the ids). Used
// by the bounded delivered-scan path so a batch of undelivered messages fetched
// in a single indexed query can be receipt-patched without an extra read per item.
function buildMessageContextFromRecord(
  db: admin.database.Database,
  tenantId: string,
  conversationKey: string,
  messageId: string,
  message: ChatMessageRecord
): LoadedMessageContext {
  return {
    messageId,
    message,
    conversationKey,
    messageRef: tenantChatRootRef(db, tenantId)
      .child('conversationMessages')
      .child(conversationKey)
      .child(messageId),
    indexRef: tenantChatRootRef(db, tenantId).child('messageIndex').child(messageId),
  };
}

async function loadMessageContext(
  db: admin.database.Database,
  tenantId: string,
  messageId: string
): Promise<LoadedMessageContext | null> {
  if (!messageId) {
    return null;
  }

  const indexRef = tenantChatRootRef(db, tenantId).child('messageIndex').child(messageId);
  const indexSnapshot = await indexRef.get();
  if (!indexSnapshot.exists()) {
    return null;
  }

  const indexValue = indexSnapshot.val() as Record<string, any> | null;
  const conversationKey = typeof indexValue?.conversationKey === 'string' ? indexValue.conversationKey : null;
  if (!conversationKey) {
    return null;
  }

  const messageRef = tenantChatRootRef(db, tenantId).child('conversationMessages').child(conversationKey).child(messageId);
  const messageSnapshot = await messageRef.get();
  if (!messageSnapshot.exists()) {
    return null;
  }

  const raw = (messageSnapshot.val() as Record<string, any>) || {};
  const message = normalizeStoredMessageRecord(messageId, conversationKey, raw);

  return {
    messageId,
    message,
    conversationKey,
    messageRef,
    indexRef,
  };
}

function parseStorageObjectPath(url: string | undefined, bucketName: string): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }

  if (url.startsWith('gs://')) {
    const remainder = url.slice('gs://'.length);
    const slash = remainder.indexOf('/');
    if (slash <= 0) {
      return null;
    }
    const bucket = remainder.slice(0, slash);
    const objectPath = remainder.slice(slash + 1);
    if (bucket && bucket !== bucketName) {
      return null;
    }
    return decodeURIComponent(objectPath);
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    let derivedBucket = '';
    let objectPath = '';

    if (host === 'firebasestorage.googleapis.com') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      const bucketIndex = parts.indexOf('b');
      if (bucketIndex >= 0 && parts.length > bucketIndex + 1) {
        derivedBucket = parts[bucketIndex + 1];
      }
      const objectIndex = parts.indexOf('o');
      if (objectIndex >= 0 && parts.length > objectIndex + 1) {
        objectPath = decodeURIComponent(parts.slice(objectIndex + 1).join('/'));
      }
    } else if (host.endsWith('storage.googleapis.com')) {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        derivedBucket = parts[0];
        objectPath = decodeURIComponent(parts.slice(1).join('/'));
      }
    }

    if (!objectPath) {
      return null;
    }

    if (derivedBucket && derivedBucket !== bucketName) {
      return null;
    }

    return objectPath;
  } catch {
    return null;
  }
}

async function deleteStorageObjectsForMessage(message: ChatMessageRecord): Promise<void> {
  if (!message) {
    return;
  }

  try {
    ensureFirebase();
  } catch {
    return;
  }

  type StorageBucket = ReturnType<ReturnType<typeof admin.storage>['bucket']>;
  let bucket: StorageBucket;
  try {
    bucket = admin.storage().bucket();
  } catch (error) {
    console.warn('[chatMessageWriter] storage bucket unavailable, skipping delete', {
      reason: (error as Error)?.message,
    });
    return;
  }

  const bucketName = bucket.name;
  if (!bucketName) {
    console.warn('[chatMessageWriter] storage bucket name missing, skipping delete');
    return;
  }
  const targets = new Set<string>();

  const consider = (candidate?: string) => {
    const resolved = parseStorageObjectPath(candidate, bucketName);
    if (resolved) {
      targets.add(resolved);
    }
  };

  consider(message.fileUrl);
  consider(message.thumbnailUrl);

  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      if (!attachment) {
        continue;
      }
      consider(attachment.url);
      if (attachment.thumbnailUrl) {
        consider(attachment.thumbnailUrl);
      }
    }
  }

  if (!targets.size) {
    return;
  }

  await Promise.all(
    Array.from(targets).map(async (objectPath) => {
      try {
        await bucket.file(objectPath).delete({ ignoreNotFound: true });
      } catch (error) {
        console.warn('[chatMessageWriter] failed to delete storage object', {
          objectPath,
          error: (error as Error)?.message,
        });
      }
    })
  );
}

function isTextEditableMessage(message: ChatMessageRecord): boolean {
  if (!message) {
    return false;
  }
  if (message.deleted) {
    return false;
  }
  if (message.isSpecial) {
    return false;
  }
  if (message.sticker || message.gif) {
    return false;
  }
  if (message.fileUrl || (Array.isArray(message.attachments) && message.attachments.length > 0)) {
    return false;
  }
  const text = (message.text || '').trim();
  return text.length > 0;
}

function normalizeReplyContextPayload(input: unknown): ChatReplyContextPayload | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const raw = input as Record<string, unknown>;
  const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : '';
  const sender = normalizeEmail(typeof raw.sender === 'string' ? raw.sender : undefined);
  if (!messageId || !sender) {
    return undefined;
  }

  const senderName = typeof raw.senderName === 'string' ? raw.senderName.trim() : '';
  const normalizedText = typeof raw.text === 'string'
    ? raw.text.replace(/\s+/g, ' ').trim()
    : '';

  const attachmentCountCandidate = Number(raw.attachmentCount);
  const attachmentCount = Number.isFinite(attachmentCountCandidate) && attachmentCountCandidate > 0
    ? Math.trunc(attachmentCountCandidate)
    : undefined;

  const hasAttachments = Boolean(raw.hasAttachments) || Boolean(attachmentCount);
  const hasSticker = raw.hasSticker === true;
  const hasGif = raw.hasGif === true;

  return pruneUndefined({
    messageId,
    sender,
    senderName: senderName || undefined,
    text: normalizedText || undefined,
    isSpecial: raw.isSpecial === true ? true : undefined,
    hasAttachments: hasAttachments ? true : undefined,
    attachmentCount,
    hasSticker: hasSticker ? true : undefined,
    hasGif: hasGif ? true : undefined,
  });
}

export async function sendChatMessage(input: SendChatMessageInput): Promise<ChatMessageRecord> {
  ensureFirebase();
  const db = admin.database();

  const sender = normalizeEmail(input.senderEmail);
  const recipient = normalizeEmail(input.recipientEmail);
  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  if (!sender || !recipient) {
    throw new Error('Sender and recipient must be valid email addresses');
  }
  if (!tenantId) {
    throw new Error('Tenant id is required for chat messages');
  }

  const conversationKey = getConversationKey(sender, recipient);
  if (!conversationKey) {
    throw new Error('Unable to derive conversation key');
  }

  // Self-address prevention (stuck-message-delivery-fix, Defect A / Property 3).
  // Reject a send whose resolved recipient equals the sender (or whose derived
  // conversation key is a self key) at the durable-write boundary so no message
  // record, self-conversation node, or self summary is ever persisted. This
  // backstops the client guard and closes the outage path that stranded a
  // message in a self-conversation.
  if (sender === recipient || isSelfConversationKey(conversationKey)) {
    throw new ChatMessageActionError(
      'Self-addressed chat messages are not allowed',
      'not_allowed',
      { sender, recipient, conversationKey }
    );
  }

  // Sanitize the incoming clientMsgId to an RTDB-path-safe form BEFORE it is used
  // as a `.child()` index path segment or stored on the record. A malformed id
  // (e.g. one containing a `.` from a legacy offline-queued tempId) is sanitized
  // and used, never thrown on — the writer must never 500 on a bad clientMsgId
  // (stuck-message-delivery-fix hotfix, Fix A). The stored `clientMsgId` and the
  // index key are the same sanitized value, so re-drives dedupe consistently.
  const rawClientMsgId =
    typeof input.clientMsgId === 'string' && input.clientMsgId.trim()
      ? input.clientMsgId.trim()
      : undefined;
  const clientMsgId = rawClientMsgId ? sanitizeClientMsgId(rawClientMsgId) || undefined : undefined;

  // Idempotent upsert keyed on clientMsgId: a retried/re-driven send returns the
  // existing durable record instead of creating a second one.
  if (clientMsgId) {
    const existing = await findChatMessageByClientMsgId(db, tenantId, conversationKey, clientMsgId);
    if (existing) {
      return existing;
    }
  }

  const conversationRef = tenantChatRootRef(db, tenantId).child('conversationMessages').child(conversationKey);
  const newMessageRef = conversationRef.push();
  const messageId = newMessageRef.key;
  if (!messageId) {
    throw new Error('Failed to allocate message id');
  }

  // Atomically claim the clientMsgId → messageId mapping. If another concurrent
  // write already claimed it, defer to that existing record (idempotency).
  if (clientMsgId) {
    const indexRef = tenantChatRootRef(db, tenantId)
      .child('conversationClientMsgIndex')
      .child(conversationKey)
      .child(clientMsgId);
    const claim = await indexRef.transaction((current: unknown) =>
      typeof current === 'string' && current ? current : messageId
    );
    const claimedId = claim.snapshot.val();
    if (typeof claimedId === 'string' && claimedId && claimedId !== messageId) {
      const existing = await findChatMessageByClientMsgId(db, tenantId, conversationKey, clientMsgId);
      if (existing) {
        return existing;
      }
      // The prior claim points to a missing record — reclaim with our messageId.
      await indexRef.set(messageId);
    }
  }

  const timestamp = new Date().toISOString();

  const attachments = Array.isArray(input.attachments)
    ? input.attachments.map((attachment) => pruneUndefined({
        url: attachment.url,
        fileName: attachment.fileName,
        fileType: attachment.fileType,
        fileSize: attachment.fileSize,
        thumbnailUrl: attachment.thumbnailUrl,
      }))
    : undefined;

  const messageRecord: ChatMessageRecord = pruneUndefined({
    id: messageId,
    text: input.text ?? '',
    sender,
    recipientId: recipient,
    clientMsgId,
    timestamp,
    conversationKey,
    tenantId,
    isSpecial: Boolean(input.isSpecial),
    fileUrl: input.fileUrl,
    fileName: input.fileName,
    fileType: input.fileType,
    fileSize: input.fileSize,
    thumbnailUrl: input.thumbnailUrl,
    attachments,
    replyTo: normalizeReplyContextPayload(input.replyTo),
    sticker: input.sticker,
    gif: input.gif,
    // Receipt integrity (chat-production-hardening, finding P2-4): the INITIAL
    // send NEVER trusts caller-supplied `delivered`/`read`. A brand-new message
    // cannot already be delivered to or read by the recipient — receipts are set
    // only later via the dedicated delivery/read endpoints
    // (`markPendingChatMessagesDeliveredForRecipient` / `syncChatConversationReceipts`
    // / `markConversationDelivered`). Forcing both `false` here prevents a sender
    // from forging receipt ticks AND from decrementing the recipient's unread for
    // a message they never saw (with `read` false, `applySummaryUpdatesForMessage`
    // below correctly INCREMENTS recipient unread for a genuine new inbound message).
    delivered: false,
    read: false,
  });

  await newMessageRef.set(messageRecord);
  await writeMessageIndexRecord(db, tenantId, messageRecord);
  await registerConversationForUsers(db, tenantId, sender, recipient, messageId, timestamp);
  await applySummaryUpdatesForMessage(db, messageId, messageRecord);

  // Record the RTDB message location in videoTranscodes docs so the transcoder
  // can write transcodedUrl back to this message when done (best-effort).
  recordRtdbPathInTranscodeDocs(
    tenantId,
    conversationKey,
    messageId,
    attachments,
    input.fileUrl,
    input.fileType,
  );

  return messageRecord;
}

// Part A — Index-not-defined graceful fallback.
// Module-level guard so the "deploy the .indexOn" advisory is logged AT MOST ONCE
// per (field, conversation-path) instead of on every stale-index query — a burst
// of pings must not spam the logs.
const indexFallbackWarned = new Set<string>();

/**
 * Read the `field == value` subset of a conversation's messages, returning a
 * plain `Record<messageId, rawMessage>` of the matching children (the shape the
 * receipt callers iterate).
 *
 * FAST PATH: the bounded indexed query `conversationMessages/{conv}
 * .orderByChild(field).equalTo(value)`. Identical semantics to today when the
 * `.indexOn` for `field` is present in the DEPLOYED rules.
 *
 * RESILIENCE (receipt-promotion resilience + perf hardening): if the Admin SDK
 * throws "Index not defined" — which happens when `database.rules.json` HAS the
 * index but the rules have NOT been deployed yet — fall back to a SINGLE read of
 * the whole conversation node and filter its children in memory to
 * `child[field] === value`. RTDB's `equalTo(value)` matches only children whose
 * `field` is STRICTLY equal to `value` (a child missing `field` is invisible to
 * the index), so the in-memory filter uses the same strict `=== value` predicate
 * — the returned subset is identical on both paths. The fallback is bounded by
 * that one node read (no N+1, no cross-conversation scan) and self-heals to the
 * fast indexed path the moment the rules deploy. Any NON-index error is
 * re-thrown unchanged so callers keep their existing error handling.
 */
async function getConversationMessagesByIndexedField(
  db: admin.database.Database,
  tenantId: string,
  conversationKey: string,
  field: 'delivered' | 'read',
  value: boolean
): Promise<Record<string, any>> {
  const conversationRef = tenantChatRootRef(db, tenantId)
    .child('conversationMessages')
    .child(conversationKey);

  try {
    const snapshot = await conversationRef.orderByChild(field).equalTo(value).get();
    if (!snapshot.exists()) {
      return {};
    }
    const node = snapshot.val();
    return node && typeof node === 'object' ? (node as Record<string, any>) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only the stale/missing-index case is recoverable here; everything else
    // (permission, network, ...) must propagate so callers handle it as before.
    if (!/Index not defined/i.test(message)) {
      throw error;
    }

    const warnKey = `${field}:${tenantId}/${conversationKey}`;
    if (!indexFallbackWarned.has(warnKey)) {
      indexFallbackWarned.add(warnKey);
      console.warn(
        `[chatMessageWriter] ".indexOn": "${field}" not deployed for ` +
          `tenantChat/${tenantId}/conversationMessages/${conversationKey}; using a bounded ` +
          `in-memory fallback for this receipt read. Deploy database.rules.json ` +
          `(firebase deploy --only database) to restore the fast indexed path.`
      );
    }

    const snapshot = await conversationRef.get();
    if (!snapshot.exists()) {
      return {};
    }
    const node = (snapshot.val() || {}) as Record<string, any>;
    const filtered: Record<string, any> = {};
    for (const [childKey, childValue] of Object.entries(node)) {
      if (
        childValue &&
        typeof childValue === 'object' &&
        (childValue as Record<string, any>)[field] === value
      ) {
        filtered[childKey] = childValue;
      }
    }
    return filtered;
  }
}

/** Test hook: reset the one-time index-fallback warning guard. */
export function __resetIndexFallbackWarnings(): void {
  indexFallbackWarned.clear();
}

export async function markPendingChatMessagesDeliveredForRecipient(
  input: MarkPendingChatMessagesDeliveredInput
): Promise<MarkPendingChatMessagesDeliveredResult> {
  ensureFirebase();
  const db = admin.database();

  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (!tenantId || !recipientEmail) {
    throw new ChatMessageActionError('Recipient and tenant are required', 'invalid_payload');
  }

  const receiptState = await resolveRecipientDeviceReceiptState(tenantId, recipientEmail, '');
  if (!receiptState.hasOnlineDevice) {
    return {
      deliveredMessageIds: [],
      deliveredCount: 0,
      recipientHasOnlineDevice: false,
    };
  }

  // chat-production-hardening, finding P2-3: the previous implementation queried
  // the FLAT global `messageIndex` by `recipientId` — which returns EVERY message
  // ever addressed to the recipient (delivered ones included) — and then did an
  // N+1 `loadMessageContext` per undelivered item. Both scaled with the
  // recipient's total history volume.
  //
  // Bounded replacement: enumerate ONLY the recipient's conversations (bounded by
  // conversation count via `userConversations`), and for each run a `delivered ==
  // false` indexed query so discovery is bounded to the UNDELIVERED subset. The
  // raw records returned by that bounded query are reused directly to build the
  // receipt-patch context (no extra per-message read), eliminating the N+1.
  const recipientKey = sanitizeKey(recipientEmail);
  if (!recipientKey) {
    return {
      deliveredMessageIds: [],
      deliveredCount: 0,
      recipientHasOnlineDevice: true,
    };
  }

  const conversationsSnapshot = await tenantChatRootRef(db, tenantId)
    .child('userConversations')
    .child(recipientKey)
    .get();

  const conversationKeys: string[] = [];
  if (conversationsSnapshot.exists()) {
    conversationsSnapshot.forEach((child) => {
      const key = child.key;
      if (key) {
        conversationKeys.push(key);
      }
      return false;
    });
  }

  const deliveredAt = new Date().toISOString();
  const deliveryProvenance = buildPresenceDeliveryProvenance(receiptState, deliveredAt);
  const deliveredMessageIds: string[] = [];

  for (const conversationKey of conversationKeys) {
    // A self-conversation is never a real inbox; skip it so we never touch self
    // data (mirrors the send/read self-address guards).
    if (isSelfConversationKey(conversationKey)) {
      continue;
    }

    // Bounded (`delivered == false`) discovery, routed through the index helper
    // so a not-yet-deployed `.indexOn` degrades to a single bounded node read
    // instead of hard-failing the whole promotion (Part A).
    const undeliveredChildren = await getConversationMessagesByIndexedField(
      db,
      tenantId,
      conversationKey,
      'delivered',
      false
    );

    // Collect the bounded (`delivered == false`) subset, re-applying the
    // remaining predicate (genuinely-incoming to the recipient, not deleted,
    // truly undelivered) because the index only narrows on `delivered`.
    const pending: Array<{ messageId: string; record: ChatMessageRecord }> = [];
    for (const [messageId, rawValue] of Object.entries(undeliveredChildren)) {
      const raw = (rawValue || {}) as Record<string, any>;
      if (!messageId) {
        continue;
      }
      if (raw.delivered === true || raw.deleted === true) {
        continue;
      }
      if (normalizeEmail(raw.recipientId) !== recipientEmail) {
        continue;
      }
      // Genuinely-incoming: a self-addressed record (sender == recipient) is
      // never legitimately deliverable.
      if (normalizeEmail(raw.sender) === recipientEmail) {
        continue;
      }
      pending.push({ messageId, record: normalizeStoredMessageRecord(messageId, conversationKey, raw) });
    }

    for (const { messageId, record } of pending) {
      const context = buildMessageContextFromRecord(db, tenantId, conversationKey, messageId, record);
      const updated = await applyReceiptPatchToMessageContext(db, context, {
        markDelivered: true,
        deliveredAt,
        deliveryProvenance,
      });
      if (updated.delivered) {
        deliveredMessageIds.push(messageId);
      }
    }
  }

  return {
    deliveredMessageIds,
    deliveredCount: deliveredMessageIds.length,
    recipientHasOnlineDevice: true,
  };
}

// Part B — throttle/coalesce receipt promotion on devices/ping.
// `devices/ping` fires promotion on EVERY ping (fire-and-forget), and each
// promotion enumerates ALL of the recipient's conversations. Pings are frequent
// and bursty, so a per-(tenant, recipient) time-throttle coalesces a burst into
// at most one promotion per short window. The raw
// `markPendingChatMessagesDeliveredForRecipient` stays UNTHROTTLED for direct /
// test callers; only the ping handler goes through the throttled wrapper.
export const DEFAULT_RECEIPT_PROMOTION_THROTTLE_MS = 3000;
let receiptPromotionThrottleMs = IS_TEST_RUNTIME ? 0 : DEFAULT_RECEIPT_PROMOTION_THROTTLE_MS;
// Keyed by `${tenantId}::${recipientEmail}` → last-run start time (ms).
const receiptPromotionLastRunAt = new Map<string, number>();

/**
 * Test hook: set the receipt-promotion throttle window (ms). `0` disables
 * throttling (every call runs). Not part of the public runtime API — exported
 * only so tests can drive coalescing deterministically.
 */
export function __setReceiptPromotionThrottleMs(ms: number): void {
  if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
    receiptPromotionThrottleMs = ms;
  }
}

/** Test hook: clear the throttle state and reset the window to its (runtime) default. */
export function __resetReceiptPromotionThrottleMs(): void {
  receiptPromotionThrottleMs = IS_TEST_RUNTIME ? 0 : DEFAULT_RECEIPT_PROMOTION_THROTTLE_MS;
  receiptPromotionLastRunAt.clear();
}

/**
 * Throttled/coalescing wrapper around `markPendingChatMessagesDeliveredForRecipient`
 * for the devices/ping hot path. A burst of pings for the same
 * (tenant, recipient) within the window runs the underlying promotion AT MOST
 * once; a ping after the window promotes again. Distinct (tenant, recipient)
 * keys are independent.
 *
 * Correctness is unaffected: a ping inside the window is SKIPPED (returns null),
 * and the next ping after the window — or the next inbound message via the
 * normal receipt path — still promotes, so no genuinely-needed receipt is ever
 * dropped. The last-run time is recorded the moment a run STARTS (before the
 * await) so a run in-flight/just-completed suppresses immediate repeats and a
 * burst of concurrent pings all coalesce into the single in-flight run.
 */
export async function promotePendingDeliveryForRecipientThrottled(
  input: MarkPendingChatMessagesDeliveredInput
): Promise<MarkPendingChatMessagesDeliveredResult | null> {
  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const recipientEmail = normalizeEmail(input.recipientEmail);
  // Without a well-formed key we cannot throttle; defer to the raw function so it
  // applies its own validation/behavior unchanged.
  if (!tenantId || !recipientEmail) {
    return markPendingChatMessagesDeliveredForRecipient(input);
  }

  const key = `${tenantId}::${recipientEmail}`;
  const now = Date.now();

  if (receiptPromotionThrottleMs > 0) {
    const lastRun = receiptPromotionLastRunAt.get(key);
    if (typeof lastRun === 'number' && now - lastRun < receiptPromotionThrottleMs) {
      // Inside the coalescing window: skip this redundant promotion.
      return null;
    }
    // Record the run start BEFORE awaiting so bursty/concurrent pings coalesce
    // into this single run.
    receiptPromotionLastRunAt.set(key, now);
  }

  return markPendingChatMessagesDeliveredForRecipient(input);
}

export async function syncChatConversationReceipts(
  input: SyncChatConversationReceiptsInput
): Promise<SyncChatConversationReceiptsResult> {
  ensureFirebase();
  const db = admin.database();

  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const actorEmail = normalizeEmail(input.actorEmail);
  const partnerEmail = normalizeEmail(input.partnerEmail);
  if (!tenantId || !actorEmail || !partnerEmail) {
    throw new ChatMessageActionError('Actor, partner, and tenant are required', 'invalid_payload');
  }

  const conversationKey = getConversationKey(actorEmail, partnerEmail);
  if (!conversationKey) {
    throw new ChatMessageActionError('Unable to resolve conversation', 'invalid_payload');
  }

  const receiptState = await resolveRecipientDeviceReceiptState(tenantId, actorEmail, partnerEmail);
  const deliveredTargets = new Set(
    Array.isArray(input.deliveredMessageIds)
      ? input.deliveredMessageIds.map((entry) => String(entry || '').trim()).filter(Boolean)
      : []
  );
  const readTargets = new Set(
    Array.isArray(input.readMessageIds)
      ? input.readMessageIds.map((entry) => String(entry || '').trim()).filter(Boolean)
      : []
  );

  if (input.markConversationDelivered && receiptState.hasOnlineDevice) {
    // chat-production-hardening, finding P2-3: previously this did a full
    // `get()` scan of the ENTIRE conversation (O(all messages)). Replace with a
    // bounded `delivered == false` indexed query so the scan is O(undelivered),
    // re-applying the remaining predicate (partner -> actor, not deleted) on the
    // bounded subset because the index only narrows on `delivered`. Routed
    // through the index helper so a not-yet-deployed `.indexOn` degrades to a
    // bounded node read instead of hard-failing (Part A).
    const undeliveredChildren = await getConversationMessagesByIndexedField(
      db,
      tenantId,
      conversationKey,
      'delivered',
      false
    );
    for (const [messageId, rawValue] of Object.entries(undeliveredChildren)) {
      const raw = (rawValue || {}) as Record<string, any>;
      if (!messageId) {
        continue;
      }
      if (raw.delivered === true || raw.deleted === true) {
        continue;
      }
      if (normalizeEmail(raw.sender) !== partnerEmail) {
        continue;
      }
      if (normalizeEmail(raw.recipientId) !== actorEmail) {
        continue;
      }
      deliveredTargets.add(messageId);
    }
  }

  if (!receiptState.hasOnlineDevice) {
    deliveredTargets.clear();
  }
  if (!receiptState.hasFocusedChatDevice) {
    readTargets.clear();
  }

  const deliveredMessageIds: string[] = [];
  const readMessageIds: string[] = [];
  const targetedIds = new Set<string>([...deliveredTargets, ...readTargets]);

  for (const messageId of targetedIds) {
    const context = await loadMessageContext(db, tenantId, messageId);
    if (!context) {
      continue;
    }
    if (normalizeEmail(context.message.sender) !== partnerEmail) {
      continue;
    }
    if (normalizeEmail(context.message.recipientId) !== actorEmail) {
      continue;
    }
    if (context.message.deleted) {
      continue;
    }

    const shouldRead = readTargets.has(messageId);
    const shouldDeliver = deliveredTargets.has(messageId) || shouldRead;
    const beforeDelivered = Boolean(context.message.delivered);
    const beforeRead = Boolean(context.message.read);
    const receiptTimestamp = new Date().toISOString();

    const updated = await applyReceiptPatchToMessageContext(db, context, {
      markDelivered: shouldDeliver,
      markRead: shouldRead,
      deliveredAt: shouldDeliver ? receiptTimestamp : undefined,
      readAt: shouldRead ? receiptTimestamp : undefined,
      deliveryProvenance: shouldDeliver ? buildPresenceDeliveryProvenance(receiptState, receiptTimestamp) : undefined,
    });

    if (!beforeDelivered && updated.delivered) {
      deliveredMessageIds.push(messageId);
    }
    if (!beforeRead && updated.read) {
      readMessageIds.push(messageId);
    }
  }

  return {
    deliveredMessageIds,
    readMessageIds,
    deliveredCount: deliveredMessageIds.length,
    readCount: readMessageIds.length,
    actorHasOnlineDevice: receiptState.hasOnlineDevice,
    actorHasFocusedChatDevice: receiptState.hasFocusedChatDevice,
  };
}

export async function confirmOutboundChatDelivery(
  input: ConfirmOutboundChatDeliveryInput
): Promise<ConfirmOutboundChatDeliveryResult> {
  ensureFirebase();
  const db = admin.database();

  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const actorEmail = normalizeEmail(input.actorEmail);
  const partnerEmail = normalizeEmail(input.partnerEmail);
  const targetedIds = Array.isArray(input.deliveredMessageIds)
    ? Array.from(new Set(input.deliveredMessageIds.map((entry) => String(entry || '').trim()).filter(Boolean)))
    : [];

  if (!tenantId || !actorEmail || !partnerEmail) {
    throw new ChatMessageActionError('Actor, partner, and tenant are required', 'invalid_payload');
  }

  if (!targetedIds.length) {
    return {
      deliveredMessageIds: [],
      deliveredCount: 0,
    };
  }

  const deliveredMessageIds: string[] = [];
  const baseProvenance = normalizeChatDeliveryProvenance(input.provenance);

  for (const messageId of targetedIds) {
    const context = await loadMessageContext(db, tenantId, messageId);
    if (!context) {
      continue;
    }
    if (normalizeEmail(context.message.sender) !== actorEmail) {
      continue;
    }
    if (normalizeEmail(context.message.recipientId) !== partnerEmail) {
      continue;
    }
    if (context.message.deleted) {
      continue;
    }

    const beforeDelivered = Boolean(context.message.delivered);
    const deliveredAt = new Date().toISOString();
    const updated = await applyReceiptPatchToMessageContext(db, context, {
      markDelivered: true,
      deliveredAt,
      deliveryProvenance: baseProvenance ?? buildPushDeliveryProvenance({ acceptedDeviceCount: targetedIds.length }, deliveredAt),
    });

    if (!beforeDelivered && updated.delivered) {
      deliveredMessageIds.push(messageId);
    }
  }

  return {
    deliveredMessageIds,
    deliveredCount: deliveredMessageIds.length,
  };
}

// Count the unread-for-`viewer` messages inside a raw conversationMessages node.
// A message counts as unread when it is NOT explicitly read (`read !== true`, so
// a record MISSING the `read` field is treated as unread), is not `deleted`, and
// is addressed to `viewer`. Applied to the (bounded) subset returned by either
// indexed query, and to the full node returned by no-op query mocks.
function countUnreadInConversationNode(raw: Record<string, any>, viewer: string): number {
  let count = 0;
  for (const value of Object.values(raw)) {
    const data = value as Record<string, any> | null;
    if (!data || typeof data !== 'object') {
      continue;
    }
    // A missing `read` key is `undefined` (NOT `=== true`) → counted as unread.
    if (data.read === true || data.deleted === true) {
      continue;
    }
    if (normalizeEmail(data.recipientId) !== viewer) {
      continue;
    }
    count += 1;
  }
  return count;
}

// Bounded per-conversation true-unread recompute (server-side mirror of the
// client `computeTrueUnreadCount`).
//
// Primary path: the indexed `read == false` set so the read cost scales with the
// number of UNREAD messages, not the whole history (O(unread)). The remaining
// predicate (`recipientId == viewer` and not `deleted`) is re-applied to that
// bounded set because the index only narrows on `read`.
//
// Robustness (chat-production-hardening, finding P3-1): RTDB `equalTo(false)`
// matches ONLY records whose `read` value is exactly `false`; a record lacking a
// `read` key entirely is invisible to that index, so a legacy/foreign write
// missing `read` would be UNDER-counted. All first-party writers now force
// `read: false` on new messages (`sendChatMessage` here + client
// `sendMessageDirect`), so in steady state the `read` index is exact. To cover
// the residual legacy/foreign case WITHOUT regressing the hot path, a bounded
// fallback fires ONLY when the caller's `storedUnreadHint` claims MORE unread
// than the `read` index found (a suspected under-count/drift): it recounts over
// the indexed `recipientId == viewer` set (also `.indexOn` → O(messages-to-viewer),
// never a full-history scan) and treats a missing `read` as unread.
//
// Returns `null` when the primary read cannot complete so callers keep the
// previously stored count rather than wiping a genuine unread value. A failure of
// ONLY the fallback degrades to the primary `read`-index count, never null.
async function computeTrueUnreadForConversation(
  db: admin.database.Database,
  tenantId: string,
  viewerEmail: string,
  conversationKey: string,
  storedUnreadHint?: number | null
): Promise<number | null> {
  const viewer = normalizeEmail(viewerEmail);
  if (!viewer || !conversationKey) {
    return null;
  }
  const conversationRef = tenantChatRootRef(db, tenantId)
    .child('conversationMessages')
    .child(conversationKey);
  try {
    // Route the `read == false` primary read through the index helper so a
    // not-yet-deployed `read` `.indexOn` degrades to a bounded node read instead
    // of throwing "Index not defined" and wiping the counter to null (Part A,
    // defensive — same failure class as the delivered index).
    const unreadChildren = await getConversationMessagesByIndexedField(
      db,
      tenantId,
      conversationKey,
      'read',
      false
    );
    const indexedCount = countUnreadInConversationNode(unreadChildren, viewer);

    // Bounded missing-`read` fallback (P3-1): only when the stored counter
    // suspects more unread than the `read` index surfaced. `recipCount` is always
    // >= `indexedCount` (every `read == false` record for the viewer is also a
    // `recipientId == viewer` record), so this never under-counts.
    if (
      typeof storedUnreadHint === 'number' &&
      Number.isFinite(storedUnreadHint) &&
      storedUnreadHint > indexedCount
    ) {
      try {
        const recipientSnapshot = await conversationRef.orderByChild('recipientId').equalTo(viewer).get();
        return recipientSnapshot.exists()
          ? countUnreadInConversationNode((recipientSnapshot.val() || {}) as Record<string, any>, viewer)
          : 0;
      } catch {
        return indexedCount;
      }
    }

    return indexedCount;
  } catch {
    return null;
  }
}

// Reconcile ONE owner conversation's stored unread counter to the true-unread
// value without creating a partial summary node. Only mutates when the record
// already exists AND the stored value drifts, so the operation is idempotent and
// never resurrects a deleted summary.
async function reconcileOwnerConversationUnread(
  db: admin.database.Database,
  tenantId: string,
  ownerEmail: string,
  partnerEmail: string,
  conversationKey: string
): Promise<boolean> {
  const ownerKey = sanitizeKey(normalizeEmail(ownerEmail));
  const partnerKey = sanitizeKey(normalizeEmail(partnerEmail));
  if (!ownerKey || !partnerKey) {
    return false;
  }

  const summaryRef = tenantChatRootRef(db, tenantId)
    .child('conversationSummaries')
    .child(`${ownerKey}/${partnerKey}`);

  // Read the stored counter first so the recompute can detect a missing-`read`
  // under-count (P3-1) and fall back to the bounded recipientId index when the
  // stored value claims more unread than the `read` index surfaced. A single
  // summary-object read (not a scan); best-effort — a failure just leaves the
  // hint unset and the primary `read`-index path is used.
  let storedUnreadHint: number | null = null;
  try {
    const summarySnapshot = await summaryRef.get();
    const storedSummary = summarySnapshot.val() as ConversationSummary | null;
    if (storedSummary && typeof storedSummary === 'object' && typeof storedSummary.unreadCount === 'number') {
      storedUnreadHint = storedSummary.unreadCount;
    }
  } catch {
    storedUnreadHint = null;
  }

  const trueUnread = await computeTrueUnreadForConversation(
    db,
    tenantId,
    ownerEmail,
    conversationKey,
    storedUnreadHint
  );
  if (trueUnread === null) {
    return false;
  }

  // This convergence is best-effort: the messages have already been (or are being)
  // marked read by the caller's primary path, and `trueUnread` is authoritative, so
  // if the hot summary node is too contended to land the counter write right now
  // (RTDB `maxretry`), we log and move on rather than failing the whole read — the
  // next read/reconcile re-converges the badge. Retry-with-jitter first to absorb
  // the common transient contention.
  let changed = false;
  try {
    await runRtdbTransactionWithRetry(summaryRef, (current) => {
      if (!current || typeof current !== 'object') {
        return current;
      }
      if ((current as ConversationSummary).unreadCount === trueUnread) {
        return current;
      }
      changed = true;
      return { ...(current as ConversationSummary), unreadCount: trueUnread };
    }, { label: 'reconcile.summary' });
  } catch (error) {
    console.warn('[reconcileOwnerConversationUnread] summary counter converge skipped', {
      tenantId,
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const userConversationRef = tenantChatRootRef(db, tenantId)
    .child('userConversations')
    .child(`${ownerKey}/${conversationKey}`);
  try {
    await runRtdbTransactionWithRetry(userConversationRef, (current) => {
      if (!current || typeof current !== 'object') {
        return current;
      }
      if ((current as Record<string, unknown>).unreadCount === trueUnread) {
        return current;
      }
      return { ...(current as Record<string, unknown>), unreadCount: trueUnread };
    }, { label: 'reconcile.userConversation' });
  } catch (error) {
    console.warn('[reconcileOwnerConversationUnread] userConversation counter converge skipped', {
      tenantId,
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return changed;
}

// Mark every UNREAD incoming message (partner → actor) in a conversation as read
// (and delivered) on behalf of the authenticated reader. This is the server-side
// replacement for the client's direct-write `markConversationAsRead`
// (chat-production-hardening, finding P0-1 — Model A: backend is the only
// writer). Identity is bound to the auth token by the route, so a caller can
// only ever mark THEIR OWN incoming messages read. Idempotent: re-running after
// everything is read is a no-op. Bounded (O(unread)) via the `read == false`
// index. After marking, the actor's stored unread for the conversation is
// reconciled to the true value so the badge converges exactly.
export async function markChatConversationRead(
  input: MarkChatConversationReadInput
): Promise<MarkChatConversationReadResult> {
  ensureFirebase();
  const db = admin.database();

  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const actorEmail = normalizeEmail(input.actorEmail);
  const partnerEmail = normalizeEmail(input.partnerEmail);
  if (!tenantId || !actorEmail || !partnerEmail) {
    throw new ChatMessageActionError('Actor, partner, and tenant are required', 'invalid_payload');
  }

  const conversationKey = getConversationKey(actorEmail, partnerEmail);
  if (!conversationKey) {
    throw new ChatMessageActionError('Unable to resolve conversation', 'invalid_payload');
  }
  // A self-conversation is never a real inbox and cannot be "read"; reject at the
  // boundary so no self-conversation node is ever touched (mirrors send guard).
  if (actorEmail === partnerEmail || isSelfConversationKey(conversationKey)) {
    throw new ChatMessageActionError(
      'Self-addressed conversations cannot be marked read',
      'not_allowed',
      { actorEmail, partnerEmail, conversationKey }
    );
  }

  // Bounded (`read == false`) discovery routed through the index helper so a
  // not-yet-deployed `read` `.indexOn` degrades to a bounded node read instead of
  // hard-failing the read-marking (Part A, defensive).
  const unreadChildren = await getConversationMessagesByIndexedField(
    db,
    tenantId,
    conversationKey,
    'read',
    false
  );

  const candidateIds: string[] = [];
  for (const [messageId, rawValue] of Object.entries(unreadChildren)) {
    const raw = (rawValue || {}) as Record<string, any>;
    if (!messageId) {
      continue;
    }
    // Re-apply predicate: only UNREAD, non-deleted, genuinely-incoming
    // (partner → actor) messages qualify. The index only narrows on `read`.
    if (raw.read === true || raw.deleted === true) {
      continue;
    }
    if (normalizeEmail(raw.sender) !== partnerEmail) {
      continue;
    }
    if (normalizeEmail(raw.recipientId) !== actorEmail) {
      continue;
    }
    candidateIds.push(messageId);
  }

  const readMessageIds: string[] = [];
  const readAt = new Date().toISOString();

  for (const messageId of candidateIds) {
    const context = await loadMessageContext(db, tenantId, messageId);
    if (!context) {
      continue;
    }
    // Defense-in-depth: re-verify identity against the durable record.
    if (normalizeEmail(context.message.sender) !== partnerEmail) {
      continue;
    }
    if (normalizeEmail(context.message.recipientId) !== actorEmail) {
      continue;
    }
    if (context.message.deleted) {
      continue;
    }
    const beforeRead = Boolean(context.message.read);
    const updated = await applyReceiptPatchToMessageContext(db, context, {
      markRead: true,
      readAt,
    });
    if (!beforeRead && updated.read) {
      readMessageIds.push(messageId);
    }
  }

  // Converge the stored counter to the true-unread value (belt-and-suspenders in
  // case the stored count had drifted before this read). Best-effort: the read
  // receipts above are the durable result of this call, so a convergence failure
  // (e.g. transient hot-node contention) must not fail the request — the counter
  // self-heals on the next read/reconcile.
  try {
    await reconcileOwnerConversationUnread(db, tenantId, actorEmail, partnerEmail, conversationKey);
  } catch (error) {
    console.warn('[markChatConversationRead] unread reconcile skipped', {
      tenantId,
      conversationKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    readMessageIds,
    updatedCount: readMessageIds.length,
  };
}

// Durable, idempotent unread reconciliation for a user — the server-side
// replacement for the client's direct-write `reconcileUnreadForUser`
// (chat-production-hardening, finding P0-1 — Model A). Identity is bound to the
// auth token by the route. For the authenticated actor it:
//   - removes any stuck self-conversation summary, its userConversations mirror,
//     and the self conversationMessages node (self-messaging is unsupported and
//     this orphaned data can never be opened/read); and
//   - recomputes every non-self conversation's stored unreadCount from the
//     true-unread set (bounded, O(unread)) and writes it back ONLY when it drifts
//     so re-running is a no-op (no oscillation).
export async function reconcileChatUnreadForUser(
  input: ReconcileChatUnreadForUserInput
): Promise<ReconcileChatUnreadForUserResult> {
  ensureFirebase();
  const db = admin.database();

  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const actorEmail = normalizeEmail(input.actorEmail);
  const userKey = sanitizeKey(actorEmail);
  if (!tenantId || !actorEmail || !userKey) {
    throw new ChatMessageActionError('Actor and tenant are required', 'invalid_payload');
  }

  const summariesRef = tenantChatRootRef(db, tenantId).child('conversationSummaries').child(userKey);
  const snapshot = await summariesRef.get();
  if (!snapshot.exists()) {
    return { reconciledConversations: 0, selfConversationsCleaned: 0 };
  }

  const raw = (snapshot.val() || {}) as Record<string, any>;
  let reconciledConversations = 0;
  let selfConversationsCleaned = 0;

  for (const [partnerKey, value] of Object.entries(raw)) {
    const record = (value || {}) as Record<string, any>;
    const partnerEmail = normalizeEmail(record.partnerEmail);
    if (!partnerEmail) {
      continue;
    }

    const conversationKey = getConversationKey(actorEmail, partnerEmail);
    const isSelf = !conversationKey || isSelfConversationKey(conversationKey) || actorEmail === partnerEmail;

    if (isSelf) {
      await summariesRef.child(partnerKey).set(null);
      if (conversationKey) {
        await tenantChatRootRef(db, tenantId)
          .child('userConversations')
          .child(`${userKey}/${conversationKey}`)
          .set(null);
        await tenantChatRootRef(db, tenantId)
          .child('conversationMessages')
          .child(conversationKey)
          .set(null);
      }
      selfConversationsCleaned += 1;
      continue;
    }

    const storedUnread = typeof record.unreadCount === 'number' ? record.unreadCount : 0;
    // Pass the stored counter as the hint so a missing-`read` under-count (P3-1)
    // is caught by the bounded recipientId fallback when the stored value claims
    // more unread than the `read` index surfaced.
    const trueUnread = await computeTrueUnreadForConversation(
      db,
      tenantId,
      actorEmail,
      conversationKey,
      storedUnread
    );
    if (trueUnread !== null && trueUnread !== storedUnread) {
      await summariesRef.child(partnerKey).update({ unreadCount: trueUnread });
      await tenantChatRootRef(db, tenantId)
        .child('userConversations')
        .child(`${userKey}/${conversationKey}`)
        .update({ unreadCount: trueUnread });
      reconciledConversations += 1;
    }
  }

  return { reconciledConversations, selfConversationsCleaned };
}

// Given the user's own sanitized key and a sorted `keyA__keyB` conversation key,
// return the OTHER half (the partner's sanitized key). Mirrors the client
// `getPartnerKeyFromConversationKey` used by the direct rebuild path.
function getPartnerKeyFromConversationKey(userKey: string, conversationKey: string): string | null {
  if (!userKey) {
    return null;
  }
  const parts = conversationKey.split('__').filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  if (parts[0] === userKey) {
    return parts[1];
  }
  if (parts[1] === userKey) {
    return parts[0];
  }
  return null;
}

// Read + normalize the maintained `conversationLatest/{conv}` pointer into a
// `ConversationLatestRecord`. This is the PREFERRED source for the latest-message
// summary during a rebuild because it avoids a full-history scan of the
// conversation node. Returns null when the pointer is missing/legacy/malformed so
// the caller can fall back to a single bounded node read.
async function readConversationLatestRecord(
  db: admin.database.Database,
  tenantId: string,
  conversationKey: string
): Promise<ConversationLatestRecord | null> {
  try {
    const snapshot = await tenantChatRootRef(db, tenantId)
      .child('conversationLatest')
      .child(conversationKey)
      .get();
    if (!snapshot.exists()) {
      return null;
    }
    const raw = snapshot.val() as Record<string, any> | null;
    if (!raw || typeof raw !== 'object' || !raw.messageId || !raw.timestamp) {
      return null;
    }
    const record: ConversationLatestRecord = {
      messageId: String(raw.messageId),
      timestamp: String(raw.timestamp),
      sender: normalizeEmail(raw.sender),
      recipientId: normalizeEmail(raw.recipientId) || null,
      tenantId: typeof raw.tenantId === 'string' ? raw.tenantId : null,
      delivered: Boolean(raw.delivered),
      read: Boolean(raw.read),
      isSpecial: Boolean(raw.isSpecial),
      preview: {
        text: typeof raw.preview?.text === 'string' ? raw.preview.text : '',
        type: (raw.preview?.type as LastMessageType) || 'text',
      },
    };
    const provenance = normalizeChatDeliveryProvenance(raw.deliveryProvenance);
    if (provenance) {
      record.deliveryProvenance = provenance;
    }
    if (raw.deleted === true) {
      record.deleted = true;
    }
    if (typeof raw.editedAt === 'string') {
      record.editedAt = raw.editedAt;
    }
    if (typeof raw.preview?.attachmentCount === 'number') {
      record.preview.attachmentCount = raw.preview.attachmentCount;
    }
    return record;
  } catch {
    return null;
  }
}

// Build a conversation summary `lastMessage` from a maintained latest-pointer
// record (server-side mirror of the client `buildSummaryFromLatestRecord`).
function buildLastMessageSummaryFromLatestRecord(
  ownerEmail: string,
  record: ConversationLatestRecord
): ConversationSummary['lastMessage'] {
  const normalizedOwner = normalizeEmail(ownerEmail);
  const summary: NonNullable<ConversationSummary['lastMessage']> = {
    messageId: record.messageId,
    text: record.preview.text,
    timestamp: record.timestamp,
    sender: record.sender,
    isOwnMessage: record.sender === normalizedOwner,
    delivered: record.delivered,
    read: record.read,
    type: record.preview.type,
    isSpecial: record.isSpecial,
  };
  if (typeof record.preview.attachmentCount === 'number') {
    summary.attachmentCount = record.preview.attachmentCount;
  }
  if (record.editedAt) {
    summary.editedAt = record.editedAt;
  }
  if (record.deleted) {
    summary.deleted = true;
    summary.text = 'Message deleted';
    summary.type = 'deleted';
  }
  return summary;
}

// Legacy fallback for a conversation whose `conversationLatest` pointer is
// missing: read the conversation node ONCE and return the highest-timestamp
// message (plus a partner-email hint derived from the participants). Used only
// when the maintained pointer is absent so the common path stays bounded.
async function resolveLatestFromConversationNode(
  db: admin.database.Database,
  tenantId: string,
  conversationKey: string,
  viewerEmail: string
): Promise<{ record: ConversationLatestRecord | null; partnerEmail: string | null }> {
  let record: ConversationLatestRecord | null = null;
  let latestMs = -1;
  let partnerEmail: string | null = null;
  try {
    const snapshot = await tenantChatRootRef(db, tenantId)
      .child('conversationMessages')
      .child(conversationKey)
      .get();
    if (!snapshot.exists()) {
      return { record: null, partnerEmail: null };
    }
    const node = (snapshot.val() || {}) as Record<string, any>;
    for (const [messageId, rawValue] of Object.entries(node)) {
      const data = (rawValue || {}) as Record<string, any>;
      if (!messageId || typeof data !== 'object') {
        continue;
      }
      const sender = normalizeEmail(data.sender);
      const recipient = normalizeEmail(data.recipientId);
      if (!partnerEmail) {
        if (sender === viewerEmail && recipient) {
          partnerEmail = recipient;
        } else if (recipient === viewerEmail && sender) {
          partnerEmail = sender;
        }
      }
      const ts = getTimestampMs(data.timestamp);
      if (ts > latestMs) {
        latestMs = ts;
        const message: ChatMessageRecord = {
          ...(data as ChatMessageRecord),
          id: messageId,
          sender,
          recipientId: recipient || undefined,
          timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
          conversationKey,
          tenantId: typeof data.tenantId === 'string' ? data.tenantId : (tenantId ?? null),
          deleted: Boolean(data.deleted),
          delivered: Boolean(data.delivered),
          read: Boolean(data.read),
          isSpecial: Boolean(data.isSpecial),
        } as ChatMessageRecord;
        record = buildConversationLatestRecord(messageId, message);
      }
    }
  } catch {
    return { record, partnerEmail };
  }
  return { record, partnerEmail };
}

// Server-side reconstruction of the authenticated user's conversation summaries —
// the Admin-SDK replacement for the client's direct-write
// `rebuildConversationSummariesForUser` (chat-production-hardening, finding P0-1 —
// Model A: backend is the only writer; client chat write paths are locked to
// `.write:false`). Identity is bound to the auth token by the route.
//
// Semantics mirror the client rebuild:
//   - enumerate the user's conversations from `userConversations/{userKey}`;
//   - SKIP self-conversations (never (re)create a self summary) so any pre-existing
//     self summary is pruned below and cannot regenerate;
//   - for each conversation resolve the partner (from the userConversations entry,
//     the conversation-key halves, or an existing summary), derive the latest
//     message PREFERRING the maintained `conversationLatest/{conv}` pointer (only
//     falling back to a single bounded conversation-node read when the pointer is
//     missing/legacy), and recompute unread via the BOUNDED true-unread path
//     (`computeTrueUnreadForConversation`, O(unread));
//   - write the reconstructed `conversationSummaries/{userKey}/{partnerKey}` and
//     mirror `userConversations/{userKey}/{conv}`; and
//   - PRUNE `conversationSummaries` entries whose partner is no longer present.
// Idempotent: a re-run over converged data writes the same records and prunes
// nothing new.
export async function rebuildChatSummariesForUser(
  input: RebuildChatSummariesForUserInput
): Promise<RebuildChatSummariesForUserResult> {
  ensureFirebase();
  const db = admin.database();

  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  const actorEmail = normalizeEmail(input.actorEmail);
  const userKey = sanitizeKey(actorEmail);
  if (!tenantId || !actorEmail || !userKey) {
    throw new ChatMessageActionError('Actor and tenant are required', 'invalid_payload');
  }

  const userConversationsRef = tenantChatRootRef(db, tenantId).child('userConversations').child(userKey);
  const summariesRef = tenantChatRootRef(db, tenantId).child('conversationSummaries').child(userKey);

  const [conversationIndexSnap, existingSummariesSnap] = await Promise.all([
    userConversationsRef.get(),
    summariesRef.get(),
  ]);

  const conversationIndex = (conversationIndexSnap.val() || {}) as Record<string, any>;
  const existingSummaries = (existingSummariesSnap.val() || {}) as Record<string, ConversationSummary>;

  // partnerKey → partnerEmail hints from any existing summaries (used to resolve a
  // conversation whose userConversations entry lacks a partnerEmail).
  const knownPartnerEmails = new Map<string, string>();
  for (const [partnerKey, summary] of Object.entries(existingSummaries)) {
    const email = normalizeEmail((summary as any)?.partnerEmail);
    if (email) {
      knownPartnerEmails.set(partnerKey, email);
    }
  }

  const partnerEmails = new Set<string>();
  // Partner keys written in THIS pass — never pruned below even if the pre-read
  // existing-summaries snapshot held a stale/empty entry at the same key.
  const rebuiltPartnerKeys = new Set<string>();
  let rebuiltConversations = 0;

  for (const [conversationKey, entryRaw] of Object.entries(conversationIndex)) {
    // Never (re)build a self-conversation summary. Skipping means its partnerEmail
    // is never added to `partnerEmails`, so any pre-existing self summary is pruned
    // below and cannot regenerate.
    if (isSelfConversationKey(conversationKey)) {
      continue;
    }
    const entry = (entryRaw || {}) as Record<string, any>;

    let partnerEmail = normalizeEmail(entry.partnerEmail);
    const existingPartnerKey =
      typeof entry.partnerKey === 'string' && entry.partnerKey.trim() ? entry.partnerKey.trim().toLowerCase() : null;
    const partnerKeyFromConversation = getPartnerKeyFromConversationKey(userKey, conversationKey);

    for (const candidate of [existingPartnerKey, partnerKeyFromConversation]) {
      if (!partnerEmail && candidate) {
        const known = knownPartnerEmails.get(candidate);
        if (known) {
          partnerEmail = known;
        }
      }
    }

    // PREFER the maintained latest pointer (bounded — no full-history scan).
    let latestRecord = await readConversationLatestRecord(db, tenantId, conversationKey);

    // Legacy fallback: read the conversation node ONCE only when the pointer is
    // missing. This also supplies a partner hint when none was resolved above.
    if (!latestRecord) {
      const fallback = await resolveLatestFromConversationNode(db, tenantId, conversationKey, actorEmail);
      latestRecord = fallback.record;
      if (!partnerEmail && fallback.partnerEmail) {
        partnerEmail = fallback.partnerEmail;
      }
    }

    if (!partnerEmail && latestRecord) {
      if (latestRecord.sender === actorEmail && latestRecord.recipientId) {
        partnerEmail = latestRecord.recipientId;
      } else if (latestRecord.recipientId === actorEmail && latestRecord.sender) {
        partnerEmail = latestRecord.sender;
      }
    }

    if (!partnerEmail) {
      continue;
    }
    // Resolved partner is the user themselves — a self-conversation. Skip so it is
    // neither written nor kept (it is pruned below).
    if (partnerEmail === actorEmail) {
      continue;
    }

    const sanitizedPartnerKey = existingPartnerKey || partnerKeyFromConversation || sanitizeKey(partnerEmail);
    if (!sanitizedPartnerKey) {
      continue;
    }

    // A conversation with no resolvable latest message cannot produce a summary.
    if (!latestRecord) {
      continue;
    }

    // BOUNDED true-unread recompute (O(unread)). Pass the stored counter as the
    // hint so a missing-`read` under-count is caught by the bounded recipientId
    // fallback. A null result (read failed) preserves the stored value.
    const storedHint =
      typeof entry.unreadCount === 'number'
        ? entry.unreadCount
        : typeof existingSummaries[sanitizedPartnerKey]?.unreadCount === 'number'
          ? existingSummaries[sanitizedPartnerKey].unreadCount
          : 0;
    const trueUnread = await computeTrueUnreadForConversation(
      db,
      tenantId,
      actorEmail,
      conversationKey,
      storedHint
    );
    const unreadCount = trueUnread === null ? storedHint : trueUnread;

    partnerEmails.add(partnerEmail);
    rebuiltPartnerKeys.add(sanitizedPartnerKey);
    knownPartnerEmails.set(sanitizedPartnerKey, partnerEmail);

    const existingSummary = (existingSummaries[sanitizedPartnerKey] || {}) as ConversationSummary;
    const summaryLastMessage = buildLastMessageSummaryFromLatestRecord(actorEmail, latestRecord);
    const updatedAt = latestRecord.timestamp || new Date().toISOString();

    const summaryRecord: ConversationSummary = {
      partnerEmail,
      partnerId: existingSummary?.partnerId ?? null,
      partnerName: existingSummary?.partnerName ?? null,
      tenantId,
      lastMessage: summaryLastMessage ?? null,
      unreadCount,
      updatedAt,
    };

    await summariesRef.child(sanitizedPartnerKey).set(summaryRecord);
    await userConversationsRef.child(conversationKey).update({
      partnerEmail,
      partnerKey: sanitizedPartnerKey,
      lastMessageId: latestRecord.messageId,
      updatedAt,
      unreadCount,
      tenantId,
    });

    rebuiltConversations += 1;
  }

  // Prune stale summaries: any existing summary whose partner is no longer present
  // (including a self summary, whose partnerEmail == actorEmail and is therefore
  // never in `partnerEmails`, and any record missing a partnerEmail).
  let prunedConversations = 0;
  for (const [partnerKey, value] of Object.entries(existingSummaries)) {
    // Never prune a partner we just (re)built this pass.
    if (rebuiltPartnerKeys.has(partnerKey)) {
      continue;
    }
    const email = normalizeEmail((value as any)?.partnerEmail);
    if (email && partnerEmails.has(email)) {
      continue;
    }
    await summariesRef.child(partnerKey).set(null);
    prunedConversations += 1;
  }

  return { rebuiltConversations, prunedConversations };
}

export async function editChatMessage(input: EditChatMessageInput): Promise<ChatMessageRecord> {
  if (!input?.messageId) {
    throw new ChatMessageActionError('Message id is required', 'invalid_payload');
  }

  const normalizedEditor = normalizeEmail(input.editorEmail);
  if (!normalizedEditor && !input.force) {
    throw new ChatMessageActionError('Editor email is required', 'invalid_payload');
  }

  const nextText = (input.text || '').trim();
  if (!nextText) {
    throw new ChatMessageActionError('Edited message cannot be empty', 'invalid_payload');
  }

  ensureFirebase();
  const db = admin.database();

  const normalizedTenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  if (!normalizedTenantId) {
    throw new ChatMessageActionError('Tenant id is required', 'invalid_payload');
  }

  const context = await loadMessageContext(db, normalizedTenantId, input.messageId);
  if (!context) {
    throw new ChatMessageActionError('Message not found', 'not_found');
  }

  const { message, messageRef, indexRef } = context;

  if (typeof message.tenantId === 'string' && message.tenantId.trim() !== normalizedTenantId) {
    throw new ChatMessageActionError('Message does not belong to this tenant', 'not_authorized', {
      expectedTenantId: normalizedTenantId,
      messageTenantId: message.tenantId.trim(),
    });
  }

  if (message.deleted) {
    throw new ChatMessageActionError('Message has already been deleted', 'already_deleted');
  }

  const editorEmail = normalizedEditor || message.sender;

  if (!input.force) {
    if (!editorEmail || editorEmail !== message.sender) {
      throw new ChatMessageActionError('Only the original sender can edit this message', 'not_authorized');
    }
    if (!isTextEditableMessage(message)) {
      throw new ChatMessageActionError('Only plain text messages can be edited', 'not_allowed');
    }
    const timestampMs = Date.parse(message.timestamp || '');
    if (!Number.isFinite(timestampMs)) {
      throw new ChatMessageActionError('Message timestamp unavailable', 'not_allowed');
    }
    const ageMs = Date.now() - timestampMs;
    if (ageMs > CHAT_MESSAGE_EDIT_WINDOW_MS) {
      throw new ChatMessageActionError('Edit window has expired', 'too_old', {
        windowMs: CHAT_MESSAGE_EDIT_WINDOW_MS,
      });
    }
  }

  const currentText = (message.text || '').trim();
  if (currentText === nextText && !input.force) {
    throw new ChatMessageActionError('Message text is unchanged', 'invalid_payload');
  }

  const editedAt = new Date().toISOString();
  const nextEditCount = (message.editCount ?? 0) + 1;

  await messageRef.update({
    text: nextText,
    editedAt,
    editCount: nextEditCount,
  });

  await indexRef.update({
    editedAt,
    lastUpdated: editedAt,
  });

  message.text = nextText;
  message.editedAt = editedAt;
  message.editCount = nextEditCount;

  await applySummaryUpdatesForMessage(db, input.messageId, message, {
    recipientUnreadStrategy: 'preserve',
    recipientUnreadAmount: 0,
    forceUpdateLastMessage: true,
    updateIfSameMessageId: true,
  });

  return message;
}

export async function deleteChatMessage(input: DeleteChatMessageInput): Promise<ChatMessageRecord> {
  if (!input?.messageId) {
    throw new ChatMessageActionError('Message id is required', 'invalid_payload');
  }

  const normalizedRequester = normalizeEmail(input.requesterEmail);
  if (!normalizedRequester && !input.force) {
    throw new ChatMessageActionError('Requester email is required', 'invalid_payload');
  }

  ensureFirebase();
  const db = admin.database();

  const normalizedTenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  if (!normalizedTenantId) {
    throw new ChatMessageActionError('Tenant id is required', 'invalid_payload');
  }

  const context = await loadMessageContext(db, normalizedTenantId, input.messageId);
  if (!context) {
    throw new ChatMessageActionError('Message not found', 'not_found');
  }

  const { message, messageRef, indexRef } = context;

  if (typeof message.tenantId === 'string' && message.tenantId.trim() !== normalizedTenantId) {
    throw new ChatMessageActionError('Message does not belong to this tenant', 'not_authorized', {
      expectedTenantId: normalizedTenantId,
      messageTenantId: message.tenantId.trim(),
    });
  }

  if (message.deleted) {
    throw new ChatMessageActionError('Message has already been deleted', 'already_deleted');
  }

  const actorEmail = normalizedRequester || message.sender;

  if (!input.force) {
    if (!actorEmail || actorEmail !== message.sender) {
      throw new ChatMessageActionError('Only the original sender can delete this message', 'not_authorized');
    }
    const timestampMs = Date.parse(message.timestamp || '');
    if (!Number.isFinite(timestampMs)) {
      throw new ChatMessageActionError('Message timestamp unavailable', 'not_allowed');
    }
    const ageMs = Date.now() - timestampMs;
  if (CHAT_MESSAGE_DELETE_WINDOW_MS > 0 && ageMs > CHAT_MESSAGE_DELETE_WINDOW_MS) {
      throw new ChatMessageActionError('Delete window has expired', 'too_old', {
        windowMs: CHAT_MESSAGE_DELETE_WINDOW_MS,
      });
    }
  }

  await deleteStorageObjectsForMessage(message);

  const nowIso = new Date().toISOString();

  await messageRef.update({
    text: '',
    fileUrl: null,
    fileName: null,
    fileType: null,
    fileSize: null,
    thumbnailUrl: null,
    attachments: null,
    sticker: null,
    gif: null,
    deleted: true,
    deletedAt: nowIso,
    deletedBy: actorEmail || null,
  });

  await indexRef.update({
    hasAttachments: false,
    deleted: true,
    lastUpdated: nowIso,
  });

  message.text = '';
  message.fileUrl = undefined;
  message.fileName = undefined;
  message.fileType = undefined;
  message.fileSize = undefined;
  message.thumbnailUrl = undefined;
  message.attachments = undefined;
  message.sticker = undefined;
  message.gif = undefined;
  message.isSpecial = false;
  message.deleted = true;
  message.deletedAt = nowIso;
  message.deletedBy = actorEmail || undefined;

  await applySummaryUpdatesForMessage(db, input.messageId, message, {
    recipientUnreadStrategy: message.read ? 'preserve' : 'decrement',
    recipientUnreadAmount: 1,
    forceUpdateLastMessage: true,
    updateIfSameMessageId: true,
  });

  return message;
}

export async function toggleChatMessageReaction(
  input: ToggleChatReactionInput
): Promise<{ reactions: Record<string, string[]>; updatedUsers: string[] }> {
  if (!input?.messageId) {
    throw new ChatMessageActionError('Message id is required', 'invalid_payload');
  }

  const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
  if (!tenantId) {
    throw new ChatMessageActionError('Tenant id is required', 'invalid_payload');
  }

  const actorEmail = normalizeEmail(input.actorEmail);
  if (!actorEmail) {
    throw new ChatMessageActionError('Actor email is required', 'invalid_payload');
  }

  const reactionType = (input.reactionType || '').trim();
  if (!reactionType) {
    throw new ChatMessageActionError('Reaction type is required', 'invalid_payload');
  }
  if (reactionType.length > 32) {
    throw new ChatMessageActionError('Reaction type is too long', 'invalid_payload');
  }

  ensureFirebase();
  const db = admin.database();

  const context = await loadMessageContext(db, tenantId, input.messageId);
  if (!context) {
    throw new ChatMessageActionError('Message not found', 'not_found');
  }

  const { message, messageRef } = context;

  if (typeof message.tenantId === 'string' && message.tenantId.trim() !== tenantId) {
    throw new ChatMessageActionError('Message does not belong to this tenant', 'not_authorized', {
      expectedTenantId: tenantId,
      messageTenantId: message.tenantId.trim(),
    });
  }

  const sender = normalizeEmail(message.sender);
  const recipient = normalizeEmail(message.recipientId);
  if (!sender || !recipient) {
    throw new ChatMessageActionError('Message participants unavailable', 'not_allowed');
  }

  if (actorEmail !== sender && actorEmail !== recipient) {
    throw new ChatMessageActionError('Only conversation participants can react', 'not_authorized');
  }

  if (message.deleted) {
    throw new ChatMessageActionError('Message has been deleted', 'not_allowed');
  }

  const reactionsRef = messageRef.child('reactions');

  const result = await reactionsRef.transaction((current) => {
    const existing = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};

    const next: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(existing)) {
      if (Array.isArray(value)) {
        const cleaned = (value as unknown[])
          .map((v) => (typeof v === 'string' ? normalizeEmail(v) : ''))
          .filter((v): v is string => Boolean(v));
        if (cleaned.length > 0) {
          next[key] = Array.from(new Set(cleaned));
        }
      }
    }

    const isSpecialMessage = Boolean(message.isSpecial);

    if (!isSpecialMessage) {
      let removedFrom: string | null = null;
      for (const [key, users] of Object.entries(next)) {
        if (users.includes(actorEmail)) {
          removedFrom = key;
          next[key] = users.filter((u) => u !== actorEmail);
          if (next[key].length === 0) {
            delete next[key];
          }
          break;
        }
      }

      // If user tapped the same reaction they already had, toggling off ends here.
      if (removedFrom && removedFrom === reactionType) {
        return Object.keys(next).length > 0 ? next : null;
      }
    }

    const currentUsers = next[reactionType] ?? [];
    if (currentUsers.includes(actorEmail)) {
      const updated = currentUsers.filter((u) => u !== actorEmail);
      if (updated.length === 0) {
        delete next[reactionType];
      } else {
        next[reactionType] = updated;
      }
    } else {
      next[reactionType] = [...currentUsers, actorEmail];
    }

    return Object.keys(next).length > 0 ? next : null;
  });

  if (!result.committed) {
    throw new ChatMessageActionError('Reaction update failed', 'not_allowed');
  }

  const finalReactions = (result.snapshot?.val() as Record<string, string[]> | null) || {};
  const updatedUsers = Array.isArray(finalReactions[reactionType]) ? finalReactions[reactionType] : [];

  return { reactions: finalReactions, updatedUsers };
}
