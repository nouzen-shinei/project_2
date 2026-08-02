import { logger } from '@/lib/logger';
import { resolveChatAttachmentAutoText } from '@/lib/chatAttachmentMessage';
import {
  createChatUploadProgressEmitter,
  normalizeChatUploadProgressPercent,
  resolveChatUploadProgressPercentFromBytes,
} from '@/lib/chatUploadProgress';
import { resolveChatUploadFolder, type ChatUploadParticipants } from '@/lib/chatUploadUtils';
import { sanitizeClientMsgId } from '@/lib/pendingId';
import { buildBackgroundUploadUrl, type BackgroundUploadMediaKind } from '@/lib/chatBackgroundUpload';
import {
  newUploadKey,
  stableIdForFileIndex,
  uploadKeyForFileIndex,
  uploadKeyFromStableId,
} from '@/lib/uploadKey';
import { deriveStableUploadFileName } from '@/lib/uploadFileName';
import {
  UPLOAD_MAX_ATTEMPTS,
  isTransientUploadStatus,
  uploadRetryBackoffMs,
  uploadRetryDelay,
} from '@/lib/uploadRetry';
import { sharedFileService } from '@/services/sharedFileService';
import { database, storage, auth } from '@/config/firebase';
import { Alert, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { ref, push, set, get, onValue, onChildAdded, onChildChanged, off, query, orderByChild, child, update, endAt, limitToLast, runTransaction, equalTo } from 'firebase/database';
import { deleteStorageObjectViaBackend } from './backendStorageUploadService';
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { maybeShowStorageLimitReachedAlert } from './storageLimitAlert';
import { tryPresentModalAlert } from './modalAlertService';
import { chatRealtimeStream, type ChatRealtimeCallbacks } from './chatRealtimeStream';
import { chatInboxStream } from './chatInboxStream';
import { tenantService } from './tenantService';
import { runtimeEndpoints } from './runtimeEndpoints';
type AuthServiceType = typeof import('../hooks/useAuthUnified').authService;
let __authService: AuthServiceType | null = null;
function getAuthService(): AuthServiceType {
  if (!__authService) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../hooks/useAuthUnified');
    __authService = mod.authService as AuthServiceType;
  }
  return __authService;
}

export interface FileAttachment {
  url: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  thumbnailUrl?: string;
  /** H.264 transcoded URL produced by the server-side transcoder (may be undefined while transcoding). */
  transcodedUrl?: string;
}

export interface ChatReplyContext {
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

export type ChatDeliverySource = 'presence' | 'push';

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

export interface ChatMessage {
  id?: string;
  text: string;
  sender: string; // Email address of the sender
  recipientId?: string; // For targeting specific users
  // Stable, client-generated identity minted once per user send. Threaded into
  // the send payload and used as the server idempotency/dedupe key so that an
  // automatic re-drive of a not-yet-confirmed message upserts the same durable
  // record instead of creating a duplicate. See stuck-message-delivery-fix.
  clientMsgId?: string;
  timestamp: string;
  conversationKey?: string;
  tenantId?: string | null;
  isSpecial: boolean;
  reactions?: Record<string, string[]>;
  // Backward-compatible single file support
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  thumbnailUrl?: string; // For images and videos
  // New multiple files support
  attachments?: FileAttachment[];
  replyTo?: ChatReplyContext;
  // Sticker and GIF support (WhatsApp-style)
  sticker?: {
    url: string;
    name: string;
    pack?: string;
    width?: number;
    height?: number;
  };
  gif?: {
    url: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    title?: string;
    source?: string; // e.g., 'giphy', 'klipy'
  };
  // Message status for WhatsApp-style ticks
  delivered?: boolean; // Double tick
  read?: boolean; // Blue tick
  deliveredAt?: string; // Timestamp when delivered
  readAt?: string; // Timestamp when read
  deliveryProvenance?: ChatDeliveryProvenance;
  editedAt?: string;
  editCount?: number;
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
}

export interface ConversationSummary {
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
    editedAt?: string;
    editCount?: number;
    deleted?: boolean;
    deletedAt?: string;
    deletedBy?: string;
    isSpecial?: boolean;
  };
  unreadCount: number;
  updatedAt: string;
}

type LastMessageType = 'text' | 'sticker' | 'gif' | 'attachment' | 'special' | 'unknown';

type SummaryUpdateStrategy = 'increment' | 'decrement' | 'reset' | 'preserve';

interface SummaryUpdateOptions {
  unreadStrategy: SummaryUpdateStrategy;
  unreadAmount?: number;
  forceUpdateLastMessage?: boolean;
  updateIfSameMessageId?: boolean;
}

interface MessageIndexRecord {
  conversationKey: string;
  sender: string;
  recipientId: string | null;
  tenantId?: string | null;
  timestamp: string;
  delivered?: boolean;
  read?: boolean;
  deliveryProvenance?: ChatDeliveryProvenance;
  isSpecial?: boolean;
  hasAttachments?: boolean;
  lastUpdated?: string;
}

// Compact inbound event streamed by the backend per-user inbox stream
// (`/chat/inbox-stream`). Mirrors the fields the old client `messageIndex`
// reader mapped into a lightweight ChatMessage for notifications.
interface InboxInboundPayload {
  id: string;
  sender: string;
  recipientId?: string;
  timestamp: string;
  conversationKey?: string;
  delivered?: boolean;
  read?: boolean;
  isSpecial?: boolean;
  tenantId?: string;
}

export interface ConversationLatestRecord {
  messageId: string;
  timestamp: string;
  sender: string;
  recipientId: string | null;
  tenantId?: string | null;
  delivered: boolean;
  read: boolean;
  deliveryProvenance?: ChatDeliveryProvenance;
  isSpecial: boolean;
  preview: {
    text: string;
    type: LastMessageType;
    attachmentCount?: number;
  };
}

export interface ChatReceiptSyncResult {
  ok: boolean;
  deliveredMessageIds: string[];
  readMessageIds: string[];
  deliveredCount: number;
  readCount: number;
  actorHasOnlineDevice: boolean;
  actorHasFocusedChatDevice: boolean;
}

export interface ChatOutboundDeliverySyncResult {
  ok: boolean;
  deliveredMessageIds: string[];
  deliveredCount: number;
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
    ? {
        deliveredAt: typeof raw.presence.deliveredAt === 'string' && raw.presence.deliveredAt.trim()
          ? raw.presence.deliveredAt
          : undefined,
        onlineDeviceCount: sanitizeNonNegativeCount(raw.presence.onlineDeviceCount),
        focusedDeviceCount: sanitizeNonNegativeCount(raw.presence.focusedDeviceCount),
      }
    : undefined;
  const push = raw.push && typeof raw.push === 'object'
    ? {
        deliveredAt: typeof raw.push.deliveredAt === 'string' && raw.push.deliveredAt.trim()
          ? raw.push.deliveredAt
          : undefined,
        acceptedDeviceCount: sanitizeNonNegativeCount(raw.push.acceptedDeviceCount),
        mobileAcceptedCount: sanitizeNonNegativeCount(raw.push.mobileAcceptedCount),
        webAcceptedCount: sanitizeNonNegativeCount(raw.push.webAcceptedCount),
      }
    : undefined;

  const sources = normalizeDeliverySources([
    ...(Array.isArray(raw.sources) ? raw.sources : []),
    lastSource,
    presence ? 'presence' : undefined,
    push ? 'push' : undefined,
  ]);

  const normalized: ChatDeliveryProvenance = {
    lastSource,
    lastUpdatedAt: typeof raw.lastUpdatedAt === 'string' && raw.lastUpdatedAt.trim()
      ? raw.lastUpdatedAt
      : undefined,
    presence,
    push,
  };

  if (sources.length) {
    normalized.sources = sources;
  }

  if (!normalized.sources && !normalized.lastSource && !normalized.lastUpdatedAt && !normalized.presence && !normalized.push) {
    return undefined;
  }

  return normalized;
}

function normalizeChatReplyContext(input: unknown): ChatReplyContext | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const raw = input as Record<string, unknown>;
  const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : '';
  const sender = typeof raw.sender === 'string' ? raw.sender.trim().toLowerCase() : '';
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
  const hasSticker = Boolean(raw.hasSticker);
  const hasGif = Boolean(raw.hasGif);
  const normalized: ChatReplyContext = {
    messageId,
    sender,
    senderName: senderName || undefined,
    text: normalizedText || undefined,
    isSpecial: raw.isSpecial === true ? true : undefined,
    hasAttachments: hasAttachments ? true : undefined,
    attachmentCount,
    hasSticker: hasSticker ? true : undefined,
    hasGif: hasGif ? true : undefined,
  };

  return normalized;
}

export class ChatRateLimitError extends Error {
  retryAfterMs: number;
  blockedUntil?: number | null;

  constructor(message: string, retryAfterMs?: number, blockedUntil?: number | null) {
    super(message);
    this.name = 'ChatRateLimitError';
    this.retryAfterMs = retryAfterMs ?? 0;
    this.blockedUntil = blockedUntil ?? null;
  }
}

export class ChatMessageActionError extends Error {
  code: 'not_found' | 'not_authorized' | 'too_old' | 'invalid_payload' | 'not_allowed' | 'already_deleted';
  details?: Record<string, unknown> | undefined;

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

export class ChatUploadCanceledError extends Error {
  constructor(message: string = 'Upload canceled by user') {
    super(message);
    this.name = 'ChatUploadCanceledError';
  }
}

export interface UploadSessionOptions {
  registerCancel?: (cancel: () => void | Promise<void>) => void;
  /**
   * Optional idempotency key for `POST /storage/upload` (see `lib/uploadKey.ts`).
   * When present the backend resolves a DETERMINISTIC object path, so a retry after
   * a lost response overwrites the first attempt's object instead of orphaning a
   * second one.
   *
   * The CALLER owns minting: the key must be stable for one logical user action
   * (one chat send, including a foreground fallback after a failed background
   * start) and fresh for the next, which is knowledge only the call site has.
   * `uploadFile` therefore never mints one itself — it only forwards what it is
   * given, and omits the query parameter entirely when it is not.
   */
  uploadKey?: string;
  /**
   * The human-visible name for this upload, when it differs from the storage
   * filename (`POST /storage/upload`'s `displayName` param — see
   * `backend-runtime/src/app.ts`).
   *
   * A caller that sends a DETERMINISTIC storage filename to get a stable object
   * path (`lib/uploadFileName.ts`) passes the OS-supplied name here, so every
   * user-visible label the backend writes from an upload — the pre-created
   * `sharedFiles` doc's `file.fileName`, and the client-side
   * `ensureSmartShareLink` fallback below — keeps showing the real name instead of
   * the machine one. Omitted ⇒ the query parameter is absent and the backend falls
   * back to `filename`, byte-identical to before this option existed.
   */
  displayName?: string;
}

// chat-production-hardening (Task 9, finding P2-1). A single, ref-counted RTDB
// `onValue` listen on a user's conversationSummaries node, multiplexed to every
// consumer (the app-global unread badge hook + the chat screen). Mirrors the
// shared-watcher pattern used by the backend conversation realtime watch
// (backend-runtime/src/chatRealtime.ts): consumers attach/detach by id and the
// underlying Firebase listen is torn down only when the LAST consumer leaves.
// A burst of summary-node changes is coalesced into ONE recompute pass, and each
// pass recomputes true-unread ONLY for the conversation(s) whose summary record
// actually changed (diffed against the last-seen snapshot), backed by a
// short-TTL per-conversation cache so unchanged conversations are never
// re-queried.
interface SharedSummarySubscription {
  key: string;
  tenantScopeId: string;
  normalizedUser: string;
  userKey: string;
  subscribers: Map<number, (summaries: Record<string, ConversationSummary>) => void>;
  nextSubscriberId: number;
  detachFirebase: (() => void) | null;
  torndown: boolean;
  // Latest raw snapshot awaiting a coalesced recompute pass.
  pendingRaw: Record<string, unknown> | null;
  hasPending: boolean;
  // A recompute pass is currently running (async).
  isRecomputing: boolean;
  // Whether at least one recompute pass has started. The FIRST pass runs on the
  // leading edge (immediately, no added latency for the initial paint); later
  // passes are trailing-debounced to coalesce bursts.
  hasStartedFirstPass: boolean;
  // Trailing-debounce handle for coalescing a burst of snapshots into one pass.
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  // Last broadcast result, replayed immediately to a newly-attached consumer so
  // it does not have to wait for the next snapshot.
  lastResult: Record<string, ConversationSummary> | null;
  // Per-partnerEmail signature of the last-seen summary record (change detection).
  lastSeenSignatures: Map<string, string>;
  // Short-TTL per-conversationKey true-unread cache (avoids redundant indexed
  // queries for conversations that did not change this pass).
  unreadCache: Map<string, { count: number; expiresAt: number }>;
}

class ChatService {
  // Tenant-partitioned chat data root (RTDB)
  // Structure:
  // tenantChat/{tenantId}/conversationMessages/{conversationKey}/{messageId}
  // tenantChat/{tenantId}/conversationLatest/{conversationKey}
  // tenantChat/{tenantId}/userConversations/{userKey}/{conversationKey}
  // tenantChat/{tenantId}/conversationSummaries/{userKey}/{partnerKey}
  // tenantChat/{tenantId}/messageIndex/{messageId}
  // Reactions are stored on the message record (conversationMessages/.../{messageId}/reactions)
  // Typing is handled via the presence system (Firestore authorizedEmails.typingTo)
  private tenantChatRef = ref(database, 'tenantChat');
  private serverDeltasEnabled = this.parseEnvFlag(process.env.EXPO_PUBLIC_CHAT_DELTAS_ENABLED, true);
  private realtimeStreamEnabled = this.parseEnvFlag(process.env.EXPO_PUBLIC_CHAT_STREAM_ENABLED, true);
  private static readonly ENABLE_CHAT_UPLOAD_DEBUG = false;
  private static readonly NETWORK_ALERT_COOLDOWN_MS = 5000;
  private lastUploadNetworkAlertAt = 0;

  // --- Client-side unread-reconcile throttle + in-flight guard --------------
  // chat-production-hardening (Task 7, finding P3-4). `reconcileUnreadForUser`
  // fires on several redundant client triggers (summary refresh, mark-as-read)
  // and, with multiple devices, produces redundant/racy (though idempotent)
  // writes. On a SINGLE client we (a) coalesce near-simultaneous triggers into
  // the one reconcile already in flight and (b) throttle repeat calls inside a
  // short window. Callers that just mutated state (e.g. after mark-as-read) may
  // pass `{ force: true }` so a genuinely-needed reconcile is never starved by
  // the throttle. This is purely a client-side noise reducer: the reconcile
  // itself stays idempotent and only-on-drift.
  //
  // NOTE: authoritative reconciliation should eventually live entirely
  // server-side. The backend `/chat/unread/reconcile` endpoint already performs
  // only-on-drift counter writes and self-conversation cleanup bound to the
  // caller's auth token (see backend-runtime/src/chatMessageWriter.ts). This
  // client throttle is a stopgap to reduce cross-device churn until then.
  private static readonly UNREAD_RECONCILE_THROTTLE_MS = 4000;
  private unreadReconcileThrottleMs = ChatService.UNREAD_RECONCILE_THROTTLE_MS;
  private unreadReconcileState = new Map<string, { inFlight: Promise<void> | null; lastRunAt: number }>();
  // Injectable clock so tests can advance the throttle window deterministically.
  private unreadReconcileNow: () => number = () => Date.now();

  // --- Shared summaries subscription + coalesced true-unread recompute -------
  // chat-production-hardening (Task 9, finding P2-1). Previously BOTH
  // `useUnreadChatCount` (app-global badge) and `app/(tabs)/chat.tsx` each opened
  // their OWN `onValue` listen on conversationSummaries and, on EVERY change,
  // recomputed true-unread for ALL K conversations via a per-conversation indexed
  // query (`orderByChild('read').equalTo(false)`) — a read/callback storm of
  // ~2·K reads per event. `onConversationSummariesChange` now:
  //   (1) shares ONE underlying listen per (user, tenant) across all consumers,
  //       ref-counted and torn down when the last consumer unsubscribes;
  //   (2) coalesces a burst of snapshots into a single recompute pass; and
  //   (3) recomputes true-unread ONLY for conversations whose summary record
  //       changed (diffed against the last-seen snapshot), serving unchanged
  //       conversations from a short-TTL per-conversation cache.
  // The badge stays correct: any change to a conversation's unread state is
  // reflected in its stored summary record, so its true-unread is recomputed on
  // the next pass; the cache only elides re-queries for records that did not
  // change within the TTL.
  private static readonly SUMMARY_RECOMPUTE_COALESCE_MS = 50;
  private static readonly SUMMARY_UNREAD_CACHE_TTL_MS = 3000;
  private summaryCoalesceWindowMs = ChatService.SUMMARY_RECOMPUTE_COALESCE_MS;
  private summaryUnreadCacheTtlMs = ChatService.SUMMARY_UNREAD_CACHE_TTL_MS;
  private summarySubscriptions = new Map<string, SharedSummarySubscription>();
  // Injectable clock so tests can drive the cache TTL deterministically.
  private summaryNow: () => number = () => Date.now();

  private requireTenantId(value: string | null | undefined): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      throw new Error('Select a coaching center before using chat.');
    }
    return normalized;
  }

  private tenantChild(tenantId: string, path: string) {
    const safeTenantId = this.requireTenantId(tenantId);
    const safePath = (path || '').replace(/^\/+/, '');
    return child(this.tenantChatRef, `${safeTenantId}/${safePath}`);
  }

  private tenantConversationMessagesRef(tenantId: string, conversationKey: string) {
    return this.tenantChild(tenantId, `conversationMessages/${conversationKey}`);
  }

  private tenantConversationLatestRef(tenantId: string, conversationKey: string) {
    return this.tenantChild(tenantId, `conversationLatest/${conversationKey}`);
  }

  private tenantUserConversationsRef(tenantId: string, userKey: string) {
    return this.tenantChild(tenantId, `userConversations/${userKey}`);
  }

  private tenantConversationSummariesRef(tenantId: string, userKey: string) {
    return this.tenantChild(tenantId, `conversationSummaries/${userKey}`);
  }

  private tenantMessageIndexRootRef(tenantId: string) {
    return this.tenantChild(tenantId, 'messageIndex');
  }

  private getChatBackendBaseUrl(): string | undefined {
    const s = runtimeEndpoints.getSnapshot();
    const baseUrl = s.chatApiBaseUrl || runtimeEndpoints.getPreferredBackendBaseUrl();
    if (baseUrl) {
      internalTokenManager.setBaseUrl(baseUrl);
    }
    return baseUrl;
  }

  private requireChatBackendBaseUrl(): string {
    const baseUrl = this.getChatBackendBaseUrl();
    if (!baseUrl) {
      throw new Error(
        'Chat backend URL not configured. Set Firestore appSettings/runtimeEndpoints.chatApiBaseUrl (or apiBaseUrl).',
      );
    }
    return baseUrl;
  }

  private normalizeRealtimePayload(payload: any, fallbackConversationKey?: string | null): ChatMessage | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const messageId = typeof payload.id === 'string' && payload.id.trim().length > 0 ? payload.id : null;
    if (!messageId) {
      return null;
    }

    const sender = this.normalizeEmail(payload.sender);
    const recipientId = this.normalizeEmail(payload.recipientId);

    const candidateConversationKey =
      typeof payload.conversationKey === 'string' && payload.conversationKey.length > 0
        ? payload.conversationKey
        : null;

    const derivedConversationKey =
      candidateConversationKey ?? fallbackConversationKey ?? this.getConversationKey(sender, recipientId);

    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as FileAttachment[])
      : undefined;

    return this.pruneUndefined({
      id: messageId,
      sender,
      recipientId: recipientId || undefined,
      text: typeof payload.text === 'string' ? payload.text : '',
      timestamp:
        typeof payload.timestamp === 'string' && payload.timestamp
          ? payload.timestamp
          : new Date().toISOString(),
      conversationKey: derivedConversationKey || undefined,
      tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : undefined,
      isSpecial: Boolean(payload.isSpecial),
      reactions: payload && typeof payload.reactions === 'object' && !Array.isArray(payload.reactions)
        ? (payload.reactions as Record<string, string[]>)
        : undefined,
      fileUrl: typeof payload.fileUrl === 'string' ? payload.fileUrl : undefined,
      fileName: typeof payload.fileName === 'string' ? payload.fileName : undefined,
      fileType: typeof payload.fileType === 'string' ? payload.fileType : undefined,
      fileSize: typeof payload.fileSize === 'number' ? payload.fileSize : undefined,
      thumbnailUrl: typeof payload.thumbnailUrl === 'string' ? payload.thumbnailUrl : undefined,
      attachments,
      replyTo: normalizeChatReplyContext(payload.replyTo),
      sticker: payload.sticker,
      gif: payload.gif,
      delivered: typeof payload.delivered === 'boolean' ? payload.delivered : undefined,
      read: typeof payload.read === 'boolean' ? payload.read : undefined,
      deliveredAt: typeof payload.deliveredAt === 'string' ? payload.deliveredAt : undefined,
      readAt: typeof payload.readAt === 'string' ? payload.readAt : undefined,
      deliveryProvenance: normalizeChatDeliveryProvenance(payload.deliveryProvenance),
      editedAt: typeof payload.editedAt === 'string' ? payload.editedAt : undefined,
      editCount: typeof payload.editCount === 'number' ? payload.editCount : undefined,
      deleted: typeof payload.deleted === 'boolean' ? payload.deleted : undefined,
      deletedAt: typeof payload.deletedAt === 'string' ? payload.deletedAt : undefined,
      deletedBy: this.normalizeEmail(payload.deletedBy) || undefined,
    });
  }

  private appendTenantQuery(endpoint: string, tenantId: string): string {
    const separator = endpoint.includes('?') ? '&' : '?';
    return `${endpoint}${separator}tenantId=${encodeURIComponent(tenantId)}`;
  }

  private requireCurrentUserEmail(): string {
    const candidate = this.normalizeEmail(auth.currentUser?.email || getAuthService().getCurrentUser()?.email);
    if (!candidate) {
      throw new Error('User not authenticated');
    }
    return candidate;
  }

  private async performChatAction(
    method: 'PATCH' | 'POST' | 'DELETE',
    endpoint: string,
    options: { body?: Record<string, unknown>; tenantId: string }
  ): Promise<any> {
    const baseUrl = this.requireChatBackendBaseUrl();
    const normalizedTenantId = (options.tenantId || '').trim();
    if (!normalizedTenantId) {
      throw new Error('Tenant context is required for chat actions');
    }

    let requestEndpoint = endpoint;
    let requestBody: string | undefined;
    if (method === 'PATCH' || method === 'POST') {
      requestBody = JSON.stringify({ ...(options.body ?? {}), tenantId: normalizedTenantId });
    } else {
      requestEndpoint = this.appendTenantQuery(endpoint, normalizedTenantId);
      if (options.body) {
        requestBody = JSON.stringify(options.body);
      }
    }

    const sendRequest = async (token: string) =>
      await fetch(`${baseUrl}${requestEndpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: requestBody,
      });

    let token = await internalTokenManager.getToken(baseUrl);
    if (!token) {
      throw new Error('Unable to acquire internal auth token');
    }

    let response = await sendRequest(token);
    if (response.status === 401) {
      token = (await internalTokenManager.forceRefresh(baseUrl)) ?? '';
      if (!token) {
        throw new Error('Unable to refresh internal auth token');
      }
      response = await sendRequest(token);
    }

    if (response.status >= 400 && response.status < 500) {
      let detail: any = null;
      try {
        detail = await response.json();
      } catch {}

      const allowedCodes: ChatMessageActionError['code'][] = [
        'not_found',
        'not_authorized',
        'too_old',
        'invalid_payload',
        'not_allowed',
        'already_deleted',
      ];

      const codeCandidate = typeof detail?.error === 'string' ? detail.error : 'invalid_payload';
      const resolvedCode = allowedCodes.includes(codeCandidate as ChatMessageActionError['code'])
        ? (codeCandidate as ChatMessageActionError['code'])
        : 'invalid_payload';

      const message =
        typeof detail?.message === 'string'
          ? detail.message
          : `chat backend action failed (${response.status})`;

      const details =
        detail?.details && typeof detail.details === 'object'
          ? (detail.details as Record<string, unknown>)
          : undefined;

      throw new ChatMessageActionError(message, resolvedCode, details);
    }

    if (response.status >= 500) {
      const text = await response.text().catch(() => '');
      maybeShowMaintenanceAlertFromRaw(response.status, text);
      throw new Error(text || `chat backend action failed (${response.status})`);
    }

    if (response.status === 204) {
      return null;
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  public async subscribeToRealtimeConversation(
    currentUserEmail: string,
    chatPartnerEmail: string,
    callbacks: ChatRealtimeCallbacks<ChatMessage>
  ): Promise<(() => void) | null> {
    const baseUrl = this.getChatBackendBaseUrl();
    if (!baseUrl || !this.realtimeStreamEnabled) {
      return null;
    }

    const me = this.normalizeEmail(currentUserEmail);
    const them = this.normalizeEmail(chatPartnerEmail);
    const conversationKey = this.getConversationKey(me, them);
    if (!conversationKey || !me || !them) {
      return null;
    }

    let tenantId: string;
    try {
      tenantId = await this.ensureTenantChatScope(me, them);
    } catch (error) {
      logger.debug('chat.realtime.tenant_scope.failed', { error });
      return null;
    }

    try {
      const close = await chatRealtimeStream.subscribe<ChatMessage>({
        baseUrl,
        tenantId,
        userEmail: me,
        partnerEmail: them,
        onOpen: callbacks.onOpen,
        onError: callbacks.onError,
        onStatus: callbacks.onStatus,
        onMessage: (payload) => {
          const normalized = this.normalizeRealtimePayload(payload, conversationKey);
          if (normalized) {
            callbacks.onMessage?.(normalized);
          }
        },
        onMessageUpdate: (payload) => {
          const normalized = this.normalizeRealtimePayload(payload, conversationKey);
          if (normalized) {
            callbacks.onMessageUpdate?.(normalized);
          }
        },
        onMessageDelete: (payload) => {
          const normalized = this.normalizeRealtimePayload(payload, conversationKey);
          if (normalized) {
            callbacks.onMessageDelete?.(normalized);
          }
        },
      });
      return close;
    } catch (error) {
      logger.debug('chat.realtime.subscribe.failed', { error });
      return null;
    }
  }

  private parseEnvFlag(value: string | undefined, defaultValue: boolean): boolean {
    if (value == null) {
      return defaultValue;
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return defaultValue;
    }
    if (['0', 'false', 'off', 'disabled', 'no'].includes(normalized)) {
      return false;
    }
    if (['1', 'true', 'on', 'enabled', 'yes'].includes(normalized)) {
      return true;
    }
    return defaultValue;
  }

  private normalizeEmail(value?: string | null): string {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim().toLowerCase();
  }

  private sanitizeEmailKey(value?: string | null): string | null {
    const normalized = this.normalizeEmail(value);
    if (!normalized) {
      return null;
    }
    return normalized.replace(/[.@]/g, '_');
  }

  private normalizeKey(value?: string | null): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed.toLowerCase() : null;
  }

  private pruneUndefined<T extends Record<string, unknown>>(value: T): T {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = entry;
      }
    }
    return result as T;
  }

  private getConversationKey(emailA?: string | null, emailB?: string | null): string | null {
    const keyA = this.sanitizeEmailKey(emailA);
    const keyB = this.sanitizeEmailKey(emailB);
    if (!keyA || !keyB) {
      return null;
    }
    return [keyA, keyB].sort().join('__');
  }

  // A self-conversation key has two identical participant halves (emailA == emailB).
  private isSelfConversationKey(conversationKey?: string | null): boolean {
    if (typeof conversationKey !== 'string') {
      return false;
    }
    const halves = conversationKey.split('__').filter(Boolean);
    return halves.length === 2 && halves[0] === halves[1];
  }

  // True when the resolved recipient equals the sender (self-addressed send).
  private isSelfAddressed(sender?: string | null, recipientId?: string | null): boolean {
    const normalizedSender = this.normalizeEmail(sender);
    const normalizedRecipient = this.normalizeEmail(recipientId);
    if (!normalizedSender || !normalizedRecipient) {
      return false;
    }
    return normalizedSender === normalizedRecipient;
  }

  // Throws a non-falling-back validation error for a self-addressed send. Used as
  // a guard at every send entry point so recipient resolution can never fall back
  // to the sender and persist a self-conversation.
  private assertNotSelfAddressed(sender?: string | null, recipientId?: string | null): void {
    if (this.isSelfAddressed(sender, recipientId)) {
      const err = new Error('You cannot send a message to yourself.');
      (err as any).preventFallback = true;
      (err as any).selfAddressed = true;
      throw err;
    }
  }

  private getConversationMessagesPath(emailA?: string | null, emailB?: string | null, messageId?: string | null): string | null {
    const conversationKey = this.getConversationKey(emailA, emailB);
    if (!conversationKey) {
      return null;
    }
    return messageId ? `${conversationKey}/${messageId}` : conversationKey;
  }

  public async getConversationLatestRecord(
    currentUserEmail: string,
    chatPartnerEmail: string,
    tenantId?: string | null
  ): Promise<ConversationLatestRecord | null> {
    const me = this.normalizeEmail(currentUserEmail);
    const them = this.normalizeEmail(chatPartnerEmail);
    const conversationKey = this.getConversationKey(me, them);
    if (!conversationKey) {
      return null;
    }

    const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
    const tenantScopeId = this.requireTenantId(resolvedTenantId);
    try {
      const snapshot = await get(this.tenantConversationLatestRef(tenantScopeId, conversationKey));
      if (!snapshot.exists()) {
        return null;
      }
      const raw = snapshot.val() as ConversationLatestRecord | null;
      if (!raw || !raw.messageId) {
        return null;
      }
      return {
        messageId: raw.messageId,
        timestamp: raw.timestamp,
        sender: this.normalizeEmail((raw as any).sender),
        recipientId: this.normalizeEmail((raw as any).recipientId) || null,
        tenantId: typeof (raw as any).tenantId === 'string' ? raw.tenantId : null,
        delivered: Boolean(raw.delivered),
        read: Boolean(raw.read),
        deliveryProvenance: normalizeChatDeliveryProvenance((raw as any).deliveryProvenance),
        isSpecial: Boolean(raw.isSpecial),
        preview: raw.preview,
      };
    } catch (error) {
      logger.debug('Failed to read latest conversation pointer', {
        conversationKey,
        error,
      });
      return null;
    }
  }

  public conversationKeyForUsers(emailA?: string | null, emailB?: string | null): string | null {
    return this.getConversationKey(emailA, emailB);
  }

  /**
   * Authoritative, cheap existence check for a single durable message record in
   * the intended (non-self) conversation (chat-production-hardening, P1-2).
   *
   * This is a single keyed `get` on
   * `tenantChat/{tenantId}/conversationMessages/{conversationKey}/{serverMessageId}`
   * — NOT a scan — used as a safety net before the outbox driver dead-letters an
   * exhausted send to `failed`. It returns true only when a live record exists
   * that is addressed to the intended recipient (`recipientId == recipient`),
   * is not self-addressed, and is not deleted — i.e. the recipient's listener can
   * surface it. Best-effort: any resolution/read error returns false so genuine
   * failures still dead-letter.
   */
  public async messageExistsById(
    senderEmail: string,
    recipientEmail: string,
    serverMessageId: string,
    tenantId?: string | null
  ): Promise<boolean> {
    const sender = this.normalizeEmail(senderEmail);
    const recipient = this.normalizeEmail(recipientEmail);
    const messageId = typeof serverMessageId === 'string' ? serverMessageId.trim() : '';
    if (!sender || !recipient || !messageId) {
      return false;
    }
    // Never confirm a self-addressed record: self-conversations are not a
    // delivered state (stuck-message-delivery-fix, Defect A).
    if (this.isSelfAddressed(sender, recipient)) {
      return false;
    }
    const conversationKey = this.getConversationKey(sender, recipient);
    if (!conversationKey || this.isSelfConversationKey(conversationKey)) {
      return false;
    }
    try {
      const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      const messageRef = child(
        this.tenantConversationMessagesRef(tenantScopeId, conversationKey),
        messageId
      );
      const snapshot = await get(messageRef);
      if (!snapshot.exists()) {
        return false;
      }
      const raw = snapshot.val() as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') {
        return false;
      }
      if ((raw as { deleted?: unknown }).deleted === true) {
        return false;
      }
      // The durable record must target the intended (non-self) recipient.
      if (this.normalizeEmail((raw as { recipientId?: string }).recipientId) !== recipient) {
        return false;
      }
      if (this.normalizeEmail((raw as { sender?: string }).sender) === recipient) {
        return false;
      }
      return true;
    } catch (error) {
      logger.debug('chat.messageExistsById.failed', { conversationKey, messageId, error });
      return false;
    }
  }

  private async ensureTenantChatScope(senderEmail: string, recipientEmail?: string | null): Promise<string> {
    const tenantId = await tenantService.getCachedSelectedTenant();
    if (!tenantId) {
      throw new Error('Select a coaching center before sending messages.');
    }

    const normalizedSender = this.normalizeEmail(senderEmail);
    if (!normalizedSender) {
      throw new Error('Sender email is unavailable.');
    }

    const currentUser = getAuthService().getCurrentUser();
    if (!currentUser?.uid) {
      throw new Error('Sign in again to continue chatting.');
    }

    let memberships = await tenantService.getCachedMemberships();
    if (!memberships.length) {
      memberships = await tenantService.getMembershipsForUser(currentUser.uid);
      await tenantService.cacheMemberships(memberships);
    }

    const senderHasMembership = memberships.some(
      (membership) =>
        membership.tenantId === tenantId &&
        membership.status === 'active' &&
        membership.email?.toLowerCase() === normalizedSender
    );

    if (!senderHasMembership) {
      throw new Error('You no longer have access to this coaching center.');
    }

    if (recipientEmail) {
      const normalizedRecipient = this.normalizeEmail(recipientEmail);
      if (!normalizedRecipient) {
        throw new Error('Recipient email is invalid.');
      }

      const isRecipientMember = await tenantService.isEmailActiveMemberOfTenant(tenantId, normalizedRecipient);
      if (!isRecipientMember) {
        throw new Error('Recipient is not a member of this coaching center.');
      }
    }

    return tenantId;
  }

  private buildMessageIndexRecord(messageId: string, message: ChatMessage): MessageIndexRecord {
    const normalizedSender = this.normalizeEmail(message.sender);
    const normalizedRecipient = this.normalizeEmail(message.recipientId);
    const conversationKey = message.conversationKey || this.getConversationKey(normalizedSender, normalizedRecipient);
    if (!conversationKey) {
      throw new Error(`Unable to derive conversation key for message index ${messageId}`);
    }
    return {
      conversationKey,
      sender: normalizedSender,
      recipientId: normalizedRecipient || null,
      tenantId: message.tenantId || null,
      timestamp: message.timestamp,
      delivered: Boolean(message.delivered),
      read: Boolean(message.read),
      deliveryProvenance: normalizeChatDeliveryProvenance(message.deliveryProvenance),
      isSpecial: Boolean(message.isSpecial),
      hasAttachments: Boolean((message.attachments && message.attachments.length > 0) || message.fileUrl),
      lastUpdated: new Date().toISOString(),
    };
  }

  private async writeMessageIndexRecord(messageId: string, message: ChatMessage): Promise<void> {
    const tenantId = typeof message.tenantId === 'string' ? message.tenantId : null;
    if (!tenantId) {
      throw new Error('Missing tenantId for message index write');
    }

    const indexRecord = this.buildMessageIndexRecord(messageId, message);
    if (!indexRecord.conversationKey) {
      return;
    }
    await set(child(this.tenantMessageIndexRootRef(tenantId), messageId), indexRecord);
  }

  private async fetchChatPageViaBackend(
    currentUserEmail: string,
    otherUserEmail: string,
    pageSize: number,
    beforeTimestamp: string | undefined,
    tenantId: string
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean; oldestTimestamp: string | null } | null> {
    const baseUrl = this.getChatBackendBaseUrl();
    if (!baseUrl || !this.serverDeltasEnabled) {
      return null;
    }

    const me = this.normalizeEmail(currentUserEmail);
    const them = this.normalizeEmail(otherUserEmail);
    if (!me || !them) {
      return null;
    }

    const payload = {
      userEmail: me,
      partnerEmail: them,
      direction: beforeTimestamp ? 'older' : 'latest',
      limit: pageSize,
      cursor: beforeTimestamp ? { timestamp: beforeTimestamp } : undefined,
      tenantId,
    } as Record<string, unknown>;

    const requestBody = JSON.stringify(payload);

    const send = async (token: string) =>
      await fetch(`${baseUrl}/chat/delta`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: requestBody,
      });

    try {
      let token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        return null;
      }

      let response = await send(token);
      if (response.status === 401) {
        token = await internalTokenManager.forceRefresh(baseUrl) ?? '';
        if (!token) {
          return null;
        }
        response = await send(token);
      }

      if (!response.ok) {
        if (response.status >= 500) {
          const text = await response.text().catch(() => '');
          maybeShowMaintenanceAlertFromRaw(response.status, text);
          throw new Error(text || `chat-delta failed (${response.status})`);
        }
        return null;
      }

      const data = (await response.json()) as {
        messages?: ChatMessage[];
        hasMore?: boolean;
        cursor?: { oldestTimestamp?: string | null } | null;
      };

      if (!Array.isArray(data?.messages)) {
        return null;
      }

      const normalized = data.messages
        .map((message) => ({
          ...message,
          sender: this.normalizeEmail(message?.sender),
          recipientId: this.normalizeEmail(message?.recipientId) || undefined,
          tenantId: typeof message?.tenantId === 'string' ? message.tenantId : undefined,
        }))
        .filter((message) => Boolean(message.timestamp)) as ChatMessage[];

      normalized.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      return {
        messages: normalized,
        hasMore: Boolean(data.hasMore),
        oldestTimestamp: (data.cursor?.oldestTimestamp as string | null | undefined) ?? (normalized[0]?.timestamp ?? null),
      };
    } catch (error) {
      logger.debug('Server-driven chat delta failed; falling back to RTDB pagination', {
        error,
      });
      return null;
    }
  }

  async fetchChatPage(
    currentUserEmail: string,
    otherUserEmail: string,
    pageSize: number = 50,
    beforeTimestamp?: string,
    maxGlobalBatch: number = 500
  ): Promise<{ messages: ChatMessage[]; hasMore: boolean; oldestTimestamp: string | null }> {
    const tenantId = await this.ensureTenantChatScope(currentUserEmail, otherUserEmail);

    const serverResult = await this.fetchChatPageViaBackend(
      currentUserEmail,
      otherUserEmail,
      pageSize,
      beforeTimestamp,
      tenantId
    );
    if (serverResult) {
      return serverResult;
    }

    const me = this.normalizeEmail(currentUserEmail);
    const them = this.normalizeEmail(otherUserEmail);
    if (!me || !them) {
      return { messages: [], hasMore: false, oldestTimestamp: null };
    }

    const conversationKey = this.getConversationKey(me, them);
    if (!conversationKey) {
      return { messages: [], hasMore: false, oldestTimestamp: null };
    }

    const conversationRef = this.tenantConversationMessagesRef(tenantId, conversationKey);
    const convoQuery = beforeTimestamp
      ? query(conversationRef, orderByChild('timestamp'), endAt(beforeTimestamp), limitToLast(pageSize))
      : query(conversationRef, orderByChild('timestamp'), limitToLast(pageSize));

    const snapshot = await get(convoQuery);
    if (!snapshot.exists()) {
      return { messages: [], hasMore: false, oldestTimestamp: null };
    }

    const messages: ChatMessage[] = [];
    snapshot.forEach((childSnap) => {
      const value = childSnap.val();
      messages.push({
        ...value,
        id: childSnap.key || value?.id,
        sender: this.normalizeEmail(value?.sender),
        recipientId: this.normalizeEmail(value?.recipientId) || undefined,
        tenantId: typeof value?.tenantId === 'string' ? value.tenantId : undefined,
        replyTo: normalizeChatReplyContext(value?.replyTo),
      });
    });

    messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const oldestTimestamp = messages[0]?.timestamp ?? null;
    const hasMore = messages.length === pageSize;

    return {
      messages,
      hasMore,
      oldestTimestamp,
    };
  }

  private async registerConversationForUsers(
    userEmailA?: string | null,
    userEmailB?: string | null,
    messageId?: string | null,
    timestamp?: string,
    tenantId?: string | null
  ): Promise<void> {
    const normalizedTenantId = this.requireTenantId(tenantId ?? null);
    const normalizedA = this.normalizeEmail(userEmailA);
    const normalizedB = this.normalizeEmail(userEmailB);
    const keyA = this.sanitizeEmailKey(normalizedA);
    const keyB = this.sanitizeEmailKey(normalizedB);
    const conversationKey = this.getConversationKey(normalizedA, normalizedB);
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
      tenantId: normalizedTenantId,
    };

    const payloadForB = {
      conversationKey,
      partnerEmail: normalizedA,
      partnerKey: keyA,
      lastMessageId: messageId ?? null,
      updatedAt,
      unreadCount: 0,
      tenantId: normalizedTenantId,
    };

    await Promise.all([
      set(child(this.tenantUserConversationsRef(normalizedTenantId, keyA), conversationKey), payloadForA),
      set(child(this.tenantUserConversationsRef(normalizedTenantId, keyB), conversationKey), payloadForB),
    ]);
  }

  private getPartnerKeyFromConversationKey(userKey: string | null, conversationKey: string): string | null {
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

  // Reconstruct a user's conversation summaries (repair path used before a
  // summary refresh and on chat bootstrap).
  //
  // chat-production-hardening (finding P0-1 — Model A: backend is the only chat
  // writer): when the chat backend is configured, the rebuild runs through the
  // authenticated `/chat/summaries/rebuild` endpoint so the RTDB writes happen
  // server-side, bound to the caller's token. Under the deployed rules the client
  // chat write paths are locked to `.write:false`, so the former direct
  // `set(...)`/`update(...)` here fail with permission_denied — this dispatcher is
  // the fix. The direct-write path is retained ONLY as the no-backend fallback
  // (parity with `markConversationAsRead` / `reconcileUnreadForUser`).
  async rebuildConversationSummariesForUser(userEmail: string, tenantId?: string | null): Promise<void> {
    const normalizedUser = this.normalizeEmail(userEmail);
    const userKey = this.sanitizeEmailKey(normalizedUser);
    if (!normalizedUser || !userKey) {
      return;
    }

    if (this.getChatBackendBaseUrl()) {
      try {
        const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
        const tenantScopeId = this.requireTenantId(resolvedTenantId);
        await this.performChatAction('POST', '/chat/summaries/rebuild', {
          tenantId: tenantScopeId,
        });
      } catch (error) {
        logger.warn('Failed to rebuild conversation summaries via backend', { error });
      }
      return;
    }

    await this.rebuildConversationSummariesForUserDirect(userEmail, tenantId);
  }

  // No-backend fallback: the original client direct-write rebuild. Under a
  // backend-only-writer deployment this path is NOT reached (the dispatcher above
  // routes to the endpoint); it remains for local/no-backend configurations.
  private async rebuildConversationSummariesForUserDirect(
    userEmail: string,
    tenantId?: string | null
  ): Promise<void> {
    const normalizedUser = this.normalizeEmail(userEmail);
    const userKey = this.sanitizeEmailKey(normalizedUser);
    if (!normalizedUser || !userKey) {
      return;
    }

    const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
    const tenantScopeId = this.requireTenantId(resolvedTenantId);

    const startedAt = Date.now();

    const [conversationIndexSnapshot, existingSummariesSnapshot] = await Promise.all([
      get(this.tenantUserConversationsRef(tenantScopeId, userKey)),
      get(this.tenantConversationSummariesRef(tenantScopeId, userKey)),
    ]);

    const conversationIndex = (conversationIndexSnapshot.val() ?? {}) as Record<string, any>;
    const existingSummaries = (existingSummariesSnapshot.val() ?? {}) as Record<string, ConversationSummary>;
    const knownPartnerEmails = new Map<string, string>();

    for (const [partnerKey, summary] of Object.entries(existingSummaries)) {
      const normalizedPartnerEmail = this.normalizeEmail(summary?.partnerEmail);
      if (normalizedPartnerEmail) {
        knownPartnerEmails.set(partnerKey, normalizedPartnerEmail);
      }
    }
    const partnerEmails = new Set<string>();
    const summaryWrites: Promise<void>[] = [];

    for (const [conversationKey, entry] of Object.entries(conversationIndex)) {
      // Never (re)build a self-conversation summary. A self-conversation is not a
      // supported feature; skipping it here means its partnerEmail is never added
      // to `partnerEmails`, so any pre-existing self summary is pruned below and
      // cannot regenerate from a stray self message node.
      if (this.isSelfConversationKey(conversationKey)) {
        continue;
      }

      let partnerEmail = this.normalizeEmail(entry?.partnerEmail);
      const existingPartnerKey = this.normalizeKey(entry?.partnerKey);
      const partnerKeyFromConversation = this.getPartnerKeyFromConversationKey(userKey, conversationKey);

      const candidateKeys = [existingPartnerKey, partnerKeyFromConversation].filter(Boolean) as string[];
      for (const candidate of candidateKeys) {
        if (!partnerEmail) {
          const known = knownPartnerEmails.get(candidate);
          if (known) {
            partnerEmail = known;
          }
        }
      }

      let latestRecord: ConversationLatestRecord | null = null;
      try {
        const latestSnapshot = await get(this.tenantConversationLatestRef(tenantScopeId, conversationKey));
        if (latestSnapshot.exists()) {
          const raw = latestSnapshot.val() as ConversationLatestRecord;
          if (raw && typeof raw === 'object' && raw.messageId && raw.timestamp) {
            latestRecord = {
              messageId: raw.messageId,
              timestamp: raw.timestamp,
              sender: this.normalizeEmail((raw as any).sender),
              recipientId: this.normalizeEmail((raw as any).recipientId) || null,
              tenantId: typeof (raw as any).tenantId === 'string' ? raw.tenantId : null,
              delivered: Boolean((raw as any).delivered),
              read: Boolean((raw as any).read),
              isSpecial: Boolean((raw as any).isSpecial),
              preview: {
                text: (raw.preview?.text as string) || '',
                type: (raw.preview?.type as LastMessageType) || 'text',
              },
            };

            if (typeof raw.preview?.attachmentCount === 'number') {
              latestRecord.preview.attachmentCount = raw.preview.attachmentCount;
            }
          }
        }
      } catch (error) {
        logger.debug('Failed to read conversation latest pointer', {
          conversationKey,
          error,
        });
      }

      if (!partnerEmail && latestRecord) {
        if (latestRecord.sender === normalizedUser && latestRecord.recipientId) {
          partnerEmail = latestRecord.recipientId;
        } else if (latestRecord.recipientId === normalizedUser && latestRecord.sender) {
          partnerEmail = latestRecord.sender;
        }
      }

  const fallbackSummary = existingPartnerKey ? existingSummaries?.[existingPartnerKey] : undefined;
  let conversationSnapshot: any = null;
  let latestMessageData: { id: string; message: ChatMessage } | null = null;
  let unreadCount = typeof entry?.unreadCount === 'number' ? entry.unreadCount : fallbackSummary?.unreadCount ?? 0;
  const needsUnreadScan = true;

      const ensureSnapshot = async () => {
        if (conversationSnapshot) {
          return;
        }
        conversationSnapshot = await get(this.tenantConversationMessagesRef(tenantScopeId, conversationKey));
      };

      if ((!partnerEmail || !latestRecord || needsUnreadScan) && !conversationSnapshot) {
        await ensureSnapshot();
      }

      if (conversationSnapshot && conversationSnapshot.exists()) {
        let computedUnread = 0;

        conversationSnapshot.forEach((childSnapshot: any) => {
          const data = childSnapshot.val();
          if (!data) {
            return undefined;
          }

          const normalizedRecipient = this.normalizeEmail(data.recipientId);
          if (normalizedRecipient === normalizedUser && !data.read && !data.deleted) {
            computedUnread += 1;
          }

          const currentTimestamp = this.getTimestampMs(data.timestamp);
          if (!latestMessageData || currentTimestamp > this.getTimestampMs(latestMessageData.message.timestamp)) {
            const id = childSnapshot.key || data?.id;
            if (!id) {
              return undefined;
            }
            const message: ChatMessage = {
              ...(data as ChatMessage),
              id,
              sender: this.normalizeEmail(data.sender),
              recipientId: this.normalizeEmail(data.recipientId) || undefined,
              timestamp: data.timestamp || new Date().toISOString(),
              conversationKey,
              tenantId: typeof data.tenantId === 'string' ? data.tenantId : undefined,
              deleted: Boolean(data.deleted),
            };
            latestMessageData = { id, message };
          }

          if (!partnerEmail) {
            const sender = this.normalizeEmail(data.sender);
            const recipient = this.normalizeEmail(data.recipientId);
            if (sender === normalizedUser && recipient) {
              partnerEmail = recipient;
            } else if (recipient === normalizedUser && sender) {
              partnerEmail = sender;
            }
          }

          return undefined;
        });

        unreadCount = computedUnread;

        const snapshotLatest = latestMessageData;
        if (!latestRecord && snapshotLatest) {
          const { id: latestMessageId, message: latestMessage } = snapshotLatest;
          latestRecord = this.buildConversationLatestRecord(latestMessageId, latestMessage);
          if (latestRecord) {
            summaryWrites.push(
              this.updateConversationLatest(conversationKey, latestRecord.messageId, latestMessage)
            );
          }
        }
      }

      if (!partnerEmail) {
        continue;
      }

      partnerEmail = this.normalizeEmail(partnerEmail);
      if (!partnerEmail) {
        continue;
      }

      // Resolved partner is the user themselves — a self-conversation. Skip so it
      // is neither written nor kept (it will be pruned below).
      if (partnerEmail === normalizedUser) {
        continue;
      }

      const sanitizedPartnerKeyCandidate =
        existingPartnerKey || partnerKeyFromConversation || this.sanitizeEmailKey(partnerEmail);
      if (!sanitizedPartnerKeyCandidate) {
        continue;
      }
      const sanitizedPartnerKey = sanitizedPartnerKeyCandidate;

      const resolvedLatest = latestMessageData;
      if (!latestRecord && resolvedLatest) {
        const { id: latestMessageId, message: latestMessage } = resolvedLatest;
        latestRecord = this.buildConversationLatestRecord(latestMessageId, latestMessage);
      }

      if (!latestRecord) {
        continue;
      }

      partnerEmails.add(partnerEmail);
      knownPartnerEmails.set(sanitizedPartnerKey, partnerEmail);

      const existingSummary = existingSummaries?.[sanitizedPartnerKey] ?? {};
      const summaryLastMessage = this.buildSummaryFromLatestRecord(normalizedUser, latestRecord);
      const updatedAt = latestRecord.timestamp || new Date().toISOString();

      const summaryRecord: ConversationSummary = {
        partnerEmail,
        partnerId: existingSummary?.partnerId ?? null,
        partnerName: existingSummary?.partnerName ?? null,
        tenantId: tenantScopeId,
        lastMessage: summaryLastMessage,
        unreadCount,
        updatedAt,
      };

      summaryWrites.push(
        set(child(this.tenantConversationSummariesRef(tenantScopeId, userKey), sanitizedPartnerKey), summaryRecord)
      );

      summaryWrites.push(
        update(child(this.tenantUserConversationsRef(tenantScopeId, userKey), conversationKey), {
          partnerEmail,
          partnerKey: sanitizedPartnerKey,
          lastMessageId: latestRecord.messageId,
          updatedAt: summaryRecord.updatedAt,
          unreadCount,
          tenantId: summaryRecord.tenantId ?? null,
        })
      );
    }

    await Promise.all(summaryWrites);

    const pruneWrites: Promise<void>[] = [];
    Object.entries(existingSummaries).forEach(([partnerKey, value]: [string, any]) => {
      const partnerEmail = this.normalizeEmail(value?.partnerEmail);
      if (!partnerEmail || partnerEmails.has(partnerEmail)) {
        return;
      }
      pruneWrites.push(set(child(this.tenantConversationSummariesRef(tenantScopeId, userKey), partnerKey), null));
    });

    await Promise.all(pruneWrites);

    logger.metric('chat.summary.rebuild', {
      user: normalizedUser,
      partnerCount: partnerEmails.size,
      durationMs: Date.now() - startedAt,
      summaryWrites: summaryWrites.length,
      prunedEntries: pruneWrites.length,
    });
  }

  private getTimestampMs(value?: string | number | Date | null): number {
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

  private computeMessagePreview(message: ChatMessage): {
    text: string;
    type: LastMessageType;
    attachmentCount?: number;
  } {
    if (message.deleted) {
      return { text: 'Message removed', type: 'text' };
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

  private buildConversationLatestRecord(messageId: string, message: ChatMessage): ConversationLatestRecord | null {
    const sender = this.normalizeEmail(message.sender);
    if (!sender) {
      return null;
    }

    const preview = this.computeMessagePreview(message);
    const timestamp = message.timestamp || new Date().toISOString();

    const record: ConversationLatestRecord = {
      messageId,
      timestamp,
      sender,
      recipientId: this.normalizeEmail(message.recipientId) || null,
      tenantId: message.tenantId || null,
      delivered: Boolean(message.delivered),
      read: Boolean(message.read),
      deliveryProvenance: normalizeChatDeliveryProvenance(message.deliveryProvenance),
      isSpecial: Boolean(message.isSpecial),
      preview: {
        text: preview.text,
        type: preview.type,
      },
    };

    if (typeof preview.attachmentCount === 'number') {
      record.preview.attachmentCount = preview.attachmentCount;
    }

    return record;
  }

  private buildSummaryFromLatestRecord(
    ownerEmail: string,
    record: ConversationLatestRecord
  ): ConversationSummary['lastMessage'] {
    const normalizedOwner = this.normalizeEmail(ownerEmail);
    const summary: ConversationSummary['lastMessage'] = {
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

    return summary;
  }

  private async updateConversationLatest(
    conversationKey: string,
    messageId: string,
    message: ChatMessage
  ): Promise<void> {
    try {
      if (!conversationKey) {
        return;
      }

      const tenantId = typeof message.tenantId === 'string' ? message.tenantId : null;
      if (!tenantId) {
        return;
      }

      const record = this.buildConversationLatestRecord(messageId, message);
      if (!record) {
        return;
      }

      await set(this.tenantConversationLatestRef(tenantId, conversationKey), record);
    } catch (error) {
      logger.debug('Failed to update conversation latest pointer', {
        conversationKey,
        messageId,
        error,
      });
    }
  }

  private async updateUserConversationState(
    userKey: string | null,
    conversationKey: string | null,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      if (!userKey || !conversationKey) {
        return;
      }

      const cleaned = this.pruneUndefined(payload);
      if (!Object.keys(cleaned).length) {
        return;
      }

      const payloadTenantId = typeof (cleaned as any)?.tenantId === 'string' ? String((cleaned as any).tenantId) : null;
      const resolvedTenantId = payloadTenantId ? payloadTenantId : await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      await update(child(this.tenantUserConversationsRef(tenantScopeId, userKey), conversationKey), cleaned);
    } catch (error) {
      logger.debug('Failed to update user conversation state', {
        userKey,
        conversationKey,
        error,
      });
    }
  }

  private buildLastMessageSummary(
    ownerEmail: string,
    messageId: string,
    message: ChatMessage
  ): ConversationSummary['lastMessage'] {
    const normalizedOwner = this.normalizeEmail(ownerEmail);
    const preview = this.computeMessagePreview(message);
    const sender = this.normalizeEmail(message.sender);
    const timestamp = message.timestamp || new Date().toISOString();

    const summary: ConversationSummary['lastMessage'] = {
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

    return summary;
  }

  private async updateConversationSummaryForMessage(
    ownerEmail: string,
    partnerEmail: string | undefined,
    messageId: string,
    message: ChatMessage,
    options: SummaryUpdateOptions
  ): Promise<ConversationSummary | null> {
    const normalizedOwner = this.normalizeEmail(ownerEmail);
    const normalizedPartner = this.normalizeEmail(partnerEmail);
    if (!normalizedOwner || !normalizedPartner) {
      return null;
    }

    const ownerKey = this.sanitizeEmailKey(normalizedOwner);
    const partnerKey = this.sanitizeEmailKey(normalizedPartner);
    if (!ownerKey || !partnerKey) {
      return null;
    }

    const tenantIdFromMessage = typeof message.tenantId === 'string' ? message.tenantId : null;
    const resolvedTenantId = tenantIdFromMessage ? tenantIdFromMessage : await tenantService.getCachedSelectedTenant();
    const tenantScopeId = this.requireTenantId(resolvedTenantId);

    const summaryRef = child(this.tenantConversationSummariesRef(tenantScopeId, ownerKey), partnerKey);
    const unreadAmount = options.unreadAmount ?? 1;

    const result = await runTransaction(summaryRef, (currentValue) => {
      const current = currentValue && typeof currentValue === 'object' ? currentValue : {};
      const currentUnread = typeof current.unreadCount === 'number' ? current.unreadCount : 0;

      let nextUnread = currentUnread;
      switch (options.unreadStrategy) {
        case 'increment':
          nextUnread = currentUnread + unreadAmount;
          break;
        case 'decrement':
          nextUnread = Math.max(0, currentUnread - unreadAmount);
          break;
        case 'reset':
          nextUnread = 0;
          break;
        default:
          nextUnread = currentUnread;
          break;
      }

      const incomingTimestampMs = this.getTimestampMs(message.timestamp);
      const existingTimestampMs = this.getTimestampMs(current?.lastMessage?.timestamp);
      const isSameMessage = current?.lastMessage?.messageId === messageId;

      const shouldUpdateLastMessage =
        options.forceUpdateLastMessage ||
        !current?.lastMessage ||
        incomingTimestampMs >= existingTimestampMs ||
        (options.updateIfSameMessageId && isSameMessage);

      const updatedLastMessage = shouldUpdateLastMessage
        ? this.buildLastMessageSummary(normalizedOwner, messageId, message)
        : current?.lastMessage;

      const updatedAt =
        (shouldUpdateLastMessage && updatedLastMessage?.timestamp) ||
        current?.updatedAt ||
        message.timestamp ||
        new Date().toISOString();

      return {
        partnerEmail: normalizedPartner,
        partnerId: current?.partnerId ?? null,
        partnerName: current?.partnerName ?? null,
        tenantId:
          (typeof message.tenantId === 'string' && message.tenantId) ||
          (typeof current?.tenantId === 'string' ? current.tenantId : null),
        lastMessage: updatedLastMessage,
        unreadCount: nextUnread,
        updatedAt,
      } as ConversationSummary;
    });

    return (result?.snapshot?.val() as ConversationSummary) ?? null;
  }

  private async applySummaryUpdatesForMessage(
    messageId: string,
    message: ChatMessage,
    options: {
      recipientUnreadStrategy?: SummaryUpdateStrategy;
      recipientUnreadAmount?: number;
      forceUpdateLastMessage?: boolean;
      updateIfSameMessageId?: boolean;
    } = {}
  ): Promise<void> {
    const sender = this.normalizeEmail(message.sender);
    const recipient = this.normalizeEmail(message.recipientId);
    if (!sender || !recipient) {
      return;
    }

    const normalizedMessage: ChatMessage = {
      ...message,
      sender,
      recipientId: recipient,
    };

    let conversationKey = normalizedMessage.conversationKey || null;
    if (!conversationKey) {
      conversationKey = this.getConversationKey(sender, recipient);
      if (conversationKey) {
        normalizedMessage.conversationKey = conversationKey;
      }
    }

    const pointerPromise = conversationKey
      ? this.updateConversationLatest(conversationKey, messageId, normalizedMessage)
      : Promise.resolve();

    const senderSummaryPromise = this.updateConversationSummaryForMessage(
      sender,
      recipient,
      messageId,
      normalizedMessage,
      {
        unreadStrategy: 'preserve',
        unreadAmount: 0,
        forceUpdateLastMessage: options.forceUpdateLastMessage ?? false,
        updateIfSameMessageId: options.updateIfSameMessageId ?? false,
      }
    ).catch((error) => {
      logger.warn('Failed to update sender conversation summary', { messageId, error });
      return null;
    });

    const recipientSummaryPromise = this.updateConversationSummaryForMessage(
      recipient,
      sender,
      messageId,
      normalizedMessage,
      {
        unreadStrategy: options.recipientUnreadStrategy ?? 'preserve',
        unreadAmount: options.recipientUnreadAmount ?? 1,
        forceUpdateLastMessage: options.forceUpdateLastMessage ?? false,
        updateIfSameMessageId: options.updateIfSameMessageId ?? false,
      }
    ).catch((error) => {
      logger.warn('Failed to update recipient conversation summary', { messageId, error });
      return null;
    });

    const [senderSummary, recipientSummary] = await Promise.all([senderSummaryPromise, recipientSummaryPromise]);

    await pointerPromise;

    if (!conversationKey) {
      return;
    }

    const senderKey = this.sanitizeEmailKey(sender);
    const recipientKey = this.sanitizeEmailKey(recipient);
    const senderPartnerKey = this.sanitizeEmailKey(recipient);
    const recipientPartnerKey = this.sanitizeEmailKey(sender);
    const timestamp = normalizedMessage.timestamp || new Date().toISOString();

    const metadataUpdates: Promise<void>[] = [];
    if (senderKey) {
      metadataUpdates.push(
        this.updateUserConversationState(senderKey, conversationKey, {
          partnerEmail: recipient,
          partnerKey: senderPartnerKey,
          lastMessageId: messageId,
          updatedAt: senderSummary?.updatedAt ?? timestamp,
          unreadCount: senderSummary?.unreadCount ?? 0,
          tenantId: normalizedMessage.tenantId || null,
        })
      );
    }

    if (recipientKey) {
      metadataUpdates.push(
        this.updateUserConversationState(recipientKey, conversationKey, {
          partnerEmail: sender,
          partnerKey: recipientPartnerKey,
          lastMessageId: messageId,
          updatedAt: recipientSummary?.updatedAt ?? timestamp,
          unreadCount: recipientSummary?.unreadCount ?? 0,
          tenantId: normalizedMessage.tenantId || null,
        })
      );
    }

    await Promise.all(metadataUpdates);
  }

  // Count the unread-for-`viewer` messages inside a raw conversationMessages
  // node. A message counts as unread when it is NOT explicitly read
  // (`read !== true`, so a record MISSING the `read` field is treated as unread),
  // is not `deleted`, and is addressed to `viewer`. Applied to the (bounded)
  // subset returned by either indexed query, and to the full node returned by
  // no-op query mocks — the predicate is what makes the result correct either way.
  private countUnreadInRawNode(raw: Record<string, unknown>, viewer: string): number {
    let count = 0;
    for (const value of Object.values(raw)) {
      const data = value as any;
      if (!data || typeof data !== 'object') {
        continue;
      }
      // A missing `read` key is `undefined` (NOT `=== true`) → counted as unread.
      if (data.read === true || data.deleted === true) {
        continue;
      }
      if (this.normalizeEmail(data.recipientId) !== viewer) {
        continue;
      }
      count += 1;
    }
    return count;
  }

  // Bounded unread recompute for a single conversation.
  //
  // Primary path: query over the indexed `read == false` set so the read cost
  // scales with the number of UNREAD messages, not the whole history (O(unread),
  // not O(all messages)). The remaining predicate (`recipientId == viewer` and
  // not `deleted`) is applied to that bounded set.
  //
  // Robustness (chat-production-hardening, finding P3-1): RTDB `equalTo(false)`
  // matches ONLY records whose `read` value is exactly `false`; a record that
  // lacks a `read` key entirely is invisible to that index, so a legacy/foreign
  // write missing `read` would be UNDER-counted. All first-party writers now
  // force `read: false` on new messages (client `sendMessageDirect` + backend
  // `sendChatMessage`), so in steady state the `read` index already covers every
  // record and the primary path is exact. To cover the residual legacy/foreign
  // case WITHOUT regressing the hot path, a bounded fallback fires ONLY when the
  // caller's `storedUnreadHint` claims MORE unread than the `read` index found
  // (a suspected under-count/drift): it recounts over the indexed
  // `recipientId == viewer` set (also `.indexOn` → O(messages-to-viewer), never a
  // full-history `get`) and treats a missing `read` as unread. The fallback never
  // runs on the common in-sync path, so the O(unread) bound is preserved there.
  //
  // Returns the true unread count for `viewerEmail`, or `null` when the primary
  // bounded read could not be completed (caller keeps the previously stored count
  // so a transient read failure never wipes a genuine unread count). A failure of
  // ONLY the fallback query degrades to the primary `read`-index count, never null.
  private async computeTrueUnreadCount(
    tenantId: string,
    viewerEmail: string,
    conversationKey: string,
    storedUnreadHint?: number | null
  ): Promise<number | null> {
    const viewer = this.normalizeEmail(viewerEmail);
    if (!viewer || !conversationKey) {
      return null;
    }

    try {
      const messagesRef = this.tenantConversationMessagesRef(tenantId, conversationKey);
      const unreadQuery = query(messagesRef, orderByChild('read'), equalTo(false));
      const snapshot = await get(unreadQuery);
      const indexedCount = snapshot.exists()
        ? this.countUnreadInRawNode(snapshot.val() || {}, viewer)
        : 0;

      // Bounded missing-`read` fallback (P3-1): only when the stored counter
      // suspects more unread than the `read` index surfaced. Recounting over the
      // `recipientId == viewer` index catches records missing a `read` key while
      // staying bounded (indexed) — never a full-history scan. `recipCount` is
      // always >= `indexedCount` (every `read == false` record for the viewer is
      // also a `recipientId == viewer` record), so this never under-counts.
      if (
        typeof storedUnreadHint === 'number' &&
        Number.isFinite(storedUnreadHint) &&
        storedUnreadHint > indexedCount
      ) {
        try {
          const recipientQuery = query(messagesRef, orderByChild('recipientId'), equalTo(viewer));
          const recipientSnapshot = await get(recipientQuery);
          return recipientSnapshot.exists()
            ? this.countUnreadInRawNode(recipientSnapshot.val() || {}, viewer)
            : 0;
        } catch (fallbackError) {
          logger.debug('Bounded recipientId unread fallback failed; using read-index count', {
            conversationKey,
            error: fallbackError,
          });
          return indexedCount;
        }
      }

      return indexedCount;
    } catch (error) {
      logger.debug('Bounded unread recompute failed; retaining stored count', {
        conversationKey,
        error,
      });
      return null;
    }
  }

  // Turn a raw conversationSummaries node into the reconciled, self-aware map the
  // badge / unread total / conversation list consume:
  //   - self-conversations (identical key halves, OR sender == recipientId, OR
  //     partnerEmail == viewer) are forced to unreadCount 0 so they can never
  //     light the badge or contribute to the total; and
  //   - non-self conversations have their stored unreadCount recomputed from the
  //     true-unread set so a desynced/stale counter (e.g. soft-deleted-while-
  //     unread) converges to reality.
  // Cost is O(summaries) plus O(total unread) across the bounded per-conversation
  // recomputes.
  // Collect summary records from a conversationSummaries node. A summary record
  // is identified by a string `partnerEmail` field; recursion stops as soon as
  // one is found so nested record fields (e.g. lastMessage) are never mistaken
  // for records. Walking recursively also tolerates partner keys that contain a
  // path separator (so a record nested a level deeper is still surfaced).
  private collectSummaryRecordsFromNode(node: unknown, out: any[] = []): any[] {
    if (!node || typeof node !== 'object') {
      return out;
    }
    if (typeof (node as any).partnerEmail === 'string') {
      out.push(node);
      return out;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      this.collectSummaryRecordsFromNode(value, out);
    }
    return out;
  }

  private async deriveReconciledSummaryMap(
    tenantId: string,
    viewerEmail: string,
    rawSummaries: Record<string, unknown>
  ): Promise<Record<string, ConversationSummary>> {
    const viewer = this.normalizeEmail(viewerEmail);
    const normalized: ConversationSummary[] = [];
    this.collectSummaryRecordsFromNode(rawSummaries).forEach((value: any) => {
      const summary = this.normalizeConversationSummaryRecord(value);
      if (summary) {
        normalized.push(summary);
      }
    });

    const now = this.summaryNow();
    const result: Record<string, ConversationSummary> = {};
    await Promise.all(
      normalized.map(async (summary) => {
        // One-shot derivation (getConversationSummaries): no persistent cache, so
        // every non-self conversation is recomputed. This preserves the exact
        // pre-Task-9 behavior for callers that read summaries once.
        result[summary.partnerEmail] = await this.reconcileSummaryRecordCached(
          tenantId,
          viewer,
          summary,
          null,
          now,
          true
        );
      })
    );

    return result;
  }

  // Reconcile a single summary record into its badge/list-ready form:
  //   - self-conversations (identical key halves, OR sender == recipientId, OR
  //     partnerEmail == viewer) are forced to unreadCount 0 so they can never
  //     light the badge or contribute to the total; and
  //   - non-self conversations have their stored unreadCount replaced with the
  //     true-unread set so a desynced/stale counter converges to reality.
  // When an `unreadCache` is supplied and the record did NOT change this pass
  // (`forceRecompute === false`) a still-valid cached count is served WITHOUT a
  // fresh indexed query — this is what lets a coalesced pass recompute only the
  // conversation(s) that actually changed. A failed recompute retains the stored
  // count and does not poison the cache.
  private async reconcileSummaryRecordCached(
    tenantId: string,
    viewer: string,
    summary: ConversationSummary,
    unreadCache: Map<string, { count: number; expiresAt: number }> | null,
    now: number,
    forceRecompute: boolean
  ): Promise<ConversationSummary> {
    const partnerEmail = summary.partnerEmail;
    const conversationKey = this.getConversationKey(viewer, partnerEmail);

    if (
      !conversationKey ||
      this.isSelfConversationKey(conversationKey) ||
      this.isSelfAddressed(viewer, partnerEmail)
    ) {
      return { ...summary, unreadCount: 0 };
    }

    if (!forceRecompute && unreadCache) {
      const cached = unreadCache.get(conversationKey);
      if (cached && cached.expiresAt > now) {
        return { ...summary, unreadCount: cached.count };
      }
    }

    // Pass the stored `unreadCount` as the hint so a missing-`read` under-count
    // (P3-1) is caught by the bounded recipientId fallback when the stored
    // counter claims more unread than the `read` index surfaced.
    const trueUnread = await this.computeTrueUnreadCount(
      tenantId,
      viewer,
      conversationKey,
      summary.unreadCount
    );
    if (trueUnread === null) {
      // Recompute failed (e.g. transient query error) — retain the stored count
      // and leave any existing cache entry untouched so we retry next pass.
      return { ...summary, unreadCount: summary.unreadCount };
    }

    if (unreadCache) {
      unreadCache.set(conversationKey, {
        count: trueUnread,
        expiresAt: now + this.summaryUnreadCacheTtlMs,
      });
    }
    return { ...summary, unreadCount: trueUnread };
  }

  // Compact, change-indicating signature for a normalized summary record. When a
  // message arrives, is delivered, or is read, the stored `unreadCount`,
  // `updatedAt`, and/or the last-message receipt flags change — so a change to a
  // conversation's unread state always changes this signature, and unchanged
  // conversations keep a stable signature (served from cache).
  private buildSummarySignature(summary: ConversationSummary): string {
    const last = summary.lastMessage;
    return JSON.stringify([
      summary.unreadCount,
      summary.updatedAt,
      summary.tenantId,
      last?.messageId ?? null,
      last?.timestamp ?? null,
      last?.read ?? null,
      last?.delivered ?? null,
    ]);
  }

  // Durable, idempotent unread reconciliation for a user. Cleans up the confirmed
  // phantom-dot source and folds in the general true-unread reconciliation:
  //   - removes any pre-existing self-conversation summary
  //     (conversationSummaries/{user}/{selfKey}), its userConversations mirror
  //     (userConversations/{user}/{selfConversationKey}), and the self
  //     conversationMessages node, so the stuck dot clears and cannot regenerate;
  //   - for every non-self conversation, recomputes the stored unreadCount from
  //     the true-unread set (bounded, O(unread)) and writes it back ONLY when it
  //     differs, so re-running is a no-op (no oscillation).
  // Safe to call on cheap triggers (conversation open, foreground/summary load,
  // after mark-as-read).
  //
  // chat-production-hardening (finding P0-1 — Model A: backend is the only chat
  // writer): when the chat backend is configured, reconciliation runs through the
  // authenticated `/chat/unread/reconcile` endpoint so the destructive self-node
  // cleanup and counter rewrites happen server-side, bound to the caller's token
  // (client chat write paths are locked to `.write:false`). The direct-write path
  // is retained ONLY as the no-backend fallback.
  async reconcileUnreadForUser(
    userEmail: string,
    tenantId?: string | null,
    options?: { force?: boolean }
  ): Promise<void> {
    const normalizedUser = this.normalizeEmail(userEmail);
    const userKey = this.sanitizeEmailKey(normalizedUser);
    if (!normalizedUser || !userKey) {
      return;
    }

    const state = this.unreadReconcileState.get(userKey);

    // In-flight guard: coalesce near-simultaneous triggers on this client into
    // the single reconcile already running. Every caller awaits the same
    // promise, so N triggers collapse to one network/direct call.
    if (state?.inFlight) {
      return state.inFlight;
    }

    // Throttle: suppress repeat calls inside the window unless explicitly forced
    // (e.g. immediately after a state-changing mark-as-read). A genuinely-needed
    // reconcile after the window still runs. `lastRunAt` starts at -Infinity so
    // the first-ever call is never throttled.
    const force = Boolean(options?.force);
    const now = this.unreadReconcileNow();
    const lastRunAt = state ? state.lastRunAt : Number.NEGATIVE_INFINITY;
    if (!force && now - lastRunAt < this.unreadReconcileThrottleMs) {
      return;
    }

    // Register the in-flight entry synchronously (before any await) so that
    // sibling triggers arriving in the same tick observe it and coalesce.
    const entry: { inFlight: Promise<void> | null; lastRunAt: number } = {
      inFlight: null,
      lastRunAt,
    };
    this.unreadReconcileState.set(userKey, entry);

    const run = (async () => {
      try {
        await this.runReconcileUnreadForUser(normalizedUser, userKey, tenantId);
      } finally {
        entry.inFlight = null;
        entry.lastRunAt = this.unreadReconcileNow();
      }
    })();
    entry.inFlight = run;
    return run;
  }

  // Actual dispatch: routes to the authenticated backend endpoint when the chat
  // backend is configured, else the direct-RTDB fallback. Wrapped by
  // `reconcileUnreadForUser`'s throttle + in-flight guard.
  private async runReconcileUnreadForUser(
    normalizedUser: string,
    userKey: string,
    tenantId?: string | null
  ): Promise<void> {
    if (this.getChatBackendBaseUrl()) {
      try {
        const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
        const tenantScopeId = this.requireTenantId(resolvedTenantId);
        await this.performChatAction('POST', '/chat/unread/reconcile', {
          tenantId: tenantScopeId,
        });
      } catch (error) {
        logger.debug('Failed to reconcile unread state for user via backend', { error });
      }
      return;
    }

    await this.reconcileUnreadForUserDirect(normalizedUser, userKey, tenantId);
  }

  // Test-only hooks for the client unread-reconcile throttle (Task 7). Not part
  // of the public API; used by unit tests to control the throttle window and
  // clock and to reset coalescing state between cases.
  /** @internal */
  __setUnreadReconcileThrottleMs(ms: number): void {
    this.unreadReconcileThrottleMs = Math.max(0, ms);
  }
  /** @internal */
  __setUnreadReconcileClock(now: (() => number) | null): void {
    this.unreadReconcileNow = now ?? (() => Date.now());
  }
  /** @internal */
  __resetUnreadReconcileState(): void {
    this.unreadReconcileState.clear();
    this.unreadReconcileThrottleMs = ChatService.UNREAD_RECONCILE_THROTTLE_MS;
    this.unreadReconcileNow = () => Date.now();
  }

  private async reconcileUnreadForUserDirect(
    normalizedUser: string,
    userKey: string,
    tenantId?: string | null
  ): Promise<void> {
    const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
    const tenantScopeId = this.requireTenantId(resolvedTenantId);

    try {
      const summariesRef = this.tenantConversationSummariesRef(tenantScopeId, userKey);
      const snapshot = await get(summariesRef);
      if (!snapshot.exists()) {
        return;
      }

      const raw = (snapshot.val() ?? {}) as Record<string, any>;
      const writes: Promise<unknown>[] = [];

      for (const [partnerKey, value] of Object.entries(raw)) {
        const summary = this.normalizeConversationSummaryRecord(value);
        if (!summary) {
          continue;
        }

        const partnerEmail = summary.partnerEmail;
        const conversationKey = this.getConversationKey(normalizedUser, partnerEmail);
        const isSelf =
          !conversationKey ||
          this.isSelfConversationKey(conversationKey) ||
          this.isSelfAddressed(normalizedUser, partnerEmail);

        if (isSelf) {
          // Remove the stuck self-conversation summary, its mirror, and the self
          // message node. Self-messaging is unsupported; this data is orphaned
          // and can never be opened/read.
          writes.push(Promise.resolve(set(child(summariesRef, partnerKey), null)));
          if (conversationKey) {
            writes.push(
              Promise.resolve(
                set(child(this.tenantUserConversationsRef(tenantScopeId, userKey), conversationKey), null)
              )
            );
            writes.push(
              Promise.resolve(set(this.tenantConversationMessagesRef(tenantScopeId, conversationKey), null))
            );
          }
          continue;
        }

        const trueUnread = await this.computeTrueUnreadCount(
          tenantScopeId,
          normalizedUser,
          conversationKey,
          summary.unreadCount
        );
        if (trueUnread !== null && trueUnread !== summary.unreadCount) {
          writes.push(Promise.resolve(update(child(summariesRef, partnerKey), { unreadCount: trueUnread })));
          writes.push(
            Promise.resolve(
              update(child(this.tenantUserConversationsRef(tenantScopeId, userKey), conversationKey), {
                unreadCount: trueUnread,
              })
            )
          );
        }
      }

      await Promise.all(writes);
    } catch (error) {
      logger.debug('Failed to reconcile unread state for user', { error });
    }
  }

  private normalizeConversationSummaryRecord(raw: any): ConversationSummary | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const partnerEmail = this.normalizeEmail(raw.partnerEmail);
    if (!partnerEmail) {
      return null;
    }

    let lastMessage: ConversationSummary['lastMessage'] | undefined;
    if (raw.lastMessage && typeof raw.lastMessage === 'object') {
      const rawLast = raw.lastMessage as any;
      const messageId = typeof rawLast.messageId === 'string' ? rawLast.messageId : String(rawLast.messageId || '');
      const timestamp = rawLast.timestamp || new Date().toISOString();
      lastMessage = {
        messageId,
        text: typeof rawLast.text === 'string' ? rawLast.text : '',
        timestamp,
        sender: this.normalizeEmail(rawLast.sender),
        isOwnMessage: Boolean(rawLast.isOwnMessage),
        delivered: Boolean(rawLast.delivered),
        read: Boolean(rawLast.read),
        type: rawLast.type || 'unknown',
        attachmentCount: typeof rawLast.attachmentCount === 'number' ? rawLast.attachmentCount : undefined,
        isSpecial: Boolean(rawLast.isSpecial),
      };
    }

    return {
      partnerEmail,
      partnerId: raw.partnerId ?? null,
      partnerName: raw.partnerName ?? null,
      tenantId: typeof raw.tenantId === 'string' ? raw.tenantId : null,
      lastMessage,
      unreadCount: typeof raw.unreadCount === 'number' ? raw.unreadCount : 0,
      updatedAt: raw.updatedAt || lastMessage?.timestamp || new Date().toISOString(),
    };
  }

  async getConversationSummaries(
    userEmail: string,
    tenantId?: string | null
  ): Promise<Record<string, ConversationSummary>> {
    const userKey = this.sanitizeEmailKey(userEmail);
    if (!userKey) {
      return {};
    }

    const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
    const tenantScopeId = this.requireTenantId(resolvedTenantId);

    try {
      const snapshot = await get(this.tenantConversationSummariesRef(tenantScopeId, userKey));
      if (!snapshot.exists()) {
        return {};
      }

      const raw = snapshot.val() || {};
      // Self-aware, self-healing derivation: excludes self-conversations from the
      // unread total and recomputes non-self counts from the true-unread set.
      return await this.deriveReconciledSummaryMap(tenantScopeId, userEmail, raw);
    } catch (error) {
      logger.warn('Error fetching conversation summaries:', error);
      return {};
    }
  }

  onConversationSummariesChange(
    userEmail: string,
    callback: (summaries: Record<string, ConversationSummary>) => void,
    tenantId?: string | null
  ): () => void {
    const normalizedUser = this.normalizeEmail(userEmail);
    const userKey = this.sanitizeEmailKey(normalizedUser);
    if (!normalizedUser || !userKey) {
      return () => {};
    }

    let cancelled = false;
    let sub: SharedSummarySubscription | null = null;
    let subscriberId: number | null = null;

    const attach = async () => {
      const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      // The unsubscribe may have fired while we were resolving the tenant.
      if (cancelled) {
        return;
      }

      const subscription = this.getOrCreateSummarySubscription(tenantScopeId, normalizedUser, userKey);
      sub = subscription;
      const id = subscription.nextSubscriberId++;
      subscriberId = id;
      subscription.subscribers.set(id, callback);

      // A newly-attached consumer joining an already-live subscription gets the
      // last broadcast immediately, so it doesn't wait for the next snapshot.
      if (subscription.lastResult) {
        try {
          callback(subscription.lastResult);
        } catch (error) {
          logger.debug('Summary subscriber callback threw on replay', { error });
        }
      }
    };

    void attach().catch((error) => {
      if (!cancelled) {
        logger.warn('Failed to subscribe to conversation summaries', { error });
      }
    });

    return () => {
      cancelled = true;
      if (sub && subscriberId !== null) {
        sub.subscribers.delete(subscriberId);
        subscriberId = null;
        if (sub.subscribers.size === 0) {
          this.teardownSummarySubscription(sub);
        }
      }
    };
  }

  // Get-or-create the shared, ref-counted summaries subscription for a
  // (user, tenant) pair. The underlying `onValue` listen is attached exactly once
  // per subscription; concurrent consumers reuse it (finding P2-1, Task 9).
  private getOrCreateSummarySubscription(
    tenantScopeId: string,
    normalizedUser: string,
    userKey: string
  ): SharedSummarySubscription {
    const key = `${userKey}::${tenantScopeId}`;
    const existing = this.summarySubscriptions.get(key);
    if (existing && !existing.torndown) {
      return existing;
    }

    const sub: SharedSummarySubscription = {
      key,
      tenantScopeId,
      normalizedUser,
      userKey,
      subscribers: new Map(),
      nextSubscriberId: 1,
      detachFirebase: null,
      torndown: false,
      pendingRaw: null,
      hasPending: false,
      isRecomputing: false,
      hasStartedFirstPass: false,
      coalesceTimer: null,
      lastResult: null,
      lastSeenSignatures: new Map(),
      unreadCache: new Map(),
    };
    this.summarySubscriptions.set(key, sub);

    const userRef = this.tenantConversationSummariesRef(tenantScopeId, userKey);
    const listener = (snapshot: any) => {
      if (sub.torndown) {
        return;
      }
      sub.pendingRaw = (snapshot?.val() || {}) as Record<string, unknown>;
      sub.hasPending = true;
      this.scheduleSummaryRecompute(sub);
    };

    onValue(userRef, listener);
    sub.detachFirebase = () => {
      try {
        off(userRef, 'value', listener);
      } catch {}
    };

    return sub;
  }

  // Coalesce a burst of summary-node changes into a single recompute pass. The
  // FIRST pass runs on the leading edge (immediately) so the initial paint has no
  // added latency; subsequent passes are trailing-debounced so a burst of
  // near-simultaneous changes collapses into one pass.
  private scheduleSummaryRecompute(sub: SharedSummarySubscription): void {
    if (sub.torndown) {
      return;
    }
    // A pass is already running or already scheduled — the latest `pendingRaw`
    // will be picked up, so do not schedule another.
    if (sub.isRecomputing || sub.coalesceTimer !== null) {
      return;
    }

    if (!sub.hasStartedFirstPass) {
      void this.runSummaryRecomputePass(sub);
      return;
    }

    const windowMs = this.summaryCoalesceWindowMs;
    if (windowMs <= 0) {
      void this.runSummaryRecomputePass(sub);
      return;
    }

    const timer = setTimeout(() => {
      sub.coalesceTimer = null;
      void this.runSummaryRecomputePass(sub);
    }, windowMs);
    // Node timers expose unref() to avoid holding the event loop open; RN/web
    // timers are numbers with no such method — guard by feature-detection.
    (timer as unknown as { unref?: () => void }).unref?.();
    sub.coalesceTimer = timer;
  }

  // A single coalesced recompute pass. Diffs the pending snapshot against the
  // last-seen one and recomputes true-unread ONLY for changed conversations;
  // unchanged conversations are served from the short-TTL cache. Broadcasts the
  // reconciled map to every consumer.
  private async runSummaryRecomputePass(sub: SharedSummarySubscription): Promise<void> {
    if (sub.torndown) {
      return;
    }

    const raw = (sub.pendingRaw || {}) as Record<string, unknown>;
    sub.pendingRaw = null;
    sub.hasPending = false;
    sub.hasStartedFirstPass = true;
    sub.isRecomputing = true;

    const viewer = sub.normalizedUser;
    const tenantId = sub.tenantScopeId;
    const now = this.summaryNow();

    try {
      const normalized: ConversationSummary[] = [];
      this.collectSummaryRecordsFromNode(raw).forEach((value: any) => {
        const summary = this.normalizeConversationSummaryRecord(value);
        if (summary) {
          normalized.push(summary);
        }
      });

      const nextSignatures = new Map<string, string>();
      const seenPartners = new Set<string>();
      const result: Record<string, ConversationSummary> = {};

      await Promise.all(
        normalized.map(async (summary) => {
          const partnerEmail = summary.partnerEmail;
          seenPartners.add(partnerEmail);
          const signature = this.buildSummarySignature(summary);
          nextSignatures.set(partnerEmail, signature);
          // Recompute only when the record changed since the last pass; otherwise
          // serve the still-valid cached true-unread (no fresh indexed query).
          const changed = sub.lastSeenSignatures.get(partnerEmail) !== signature;
          result[partnerEmail] = await this.reconcileSummaryRecordCached(
            tenantId,
            viewer,
            summary,
            sub.unreadCache,
            now,
            changed
          );
        })
      );

      // Drop cache/signature entries for conversations no longer present so the
      // subscription's memory stays bounded to the live conversation set.
      for (const partner of Array.from(sub.lastSeenSignatures.keys())) {
        if (!seenPartners.has(partner)) {
          const staleKey = this.getConversationKey(viewer, partner);
          if (staleKey) {
            sub.unreadCache.delete(staleKey);
          }
        }
      }
      sub.lastSeenSignatures = nextSignatures;

      if (sub.torndown) {
        return;
      }
      sub.lastResult = result;
      this.broadcastSummaries(sub, result);
      this.emitSummaryListenerMetric(raw);
    } catch (error) {
      if (!sub.torndown) {
        logger.debug('Failed to derive reconciled conversation summaries; emitting self-excluded fallback', {
          error,
        });
        const fallback = this.buildSelfExcludedFallbackMap(viewer, raw);
        sub.lastResult = fallback;
        this.broadcastSummaries(sub, fallback);
        this.emitSummaryListenerMetric(raw);
      }
    } finally {
      sub.isRecomputing = false;
    }

    // A snapshot may have arrived while we were recomputing — run once more so no
    // change is dropped (the badge always converges to the true value).
    if (!sub.torndown && sub.hasPending) {
      this.scheduleSummaryRecompute(sub);
    }
  }

  private broadcastSummaries(
    sub: SharedSummarySubscription,
    result: Record<string, ConversationSummary>
  ): void {
    for (const cb of Array.from(sub.subscribers.values())) {
      try {
        cb(result);
      } catch (error) {
        logger.debug('Summary subscriber callback threw', { error });
      }
    }
  }

  private emitSummaryListenerMetric(raw: Record<string, unknown>): void {
    let payloadBytes = 0;
    try {
      payloadBytes = JSON.stringify(raw).length;
    } catch (error) {
      logger.debug('Failed to measure summary listener payload size', { error });
    }
    logger.metric('chat.summary.listener_payload', { bytes: payloadBytes });
  }

  // Synchronous, self-conversation-excluding fallback used if the bounded
  // true-unread recompute cannot complete. Self summaries are still forced to 0 so
  // a self-conversation can never light the badge.
  private buildSelfExcludedFallbackMap(
    normalizedUser: string,
    raw: Record<string, unknown>
  ): Record<string, ConversationSummary> {
    const fallback: Record<string, ConversationSummary> = {};
    this.collectSummaryRecordsFromNode(raw).forEach((value: any) => {
      const summary = this.normalizeConversationSummaryRecord(value);
      if (!summary) {
        return;
      }
      const conversationKey = this.getConversationKey(normalizedUser, summary.partnerEmail);
      const isSelf =
        !conversationKey ||
        this.isSelfConversationKey(conversationKey) ||
        this.isSelfAddressed(normalizedUser, summary.partnerEmail);
      fallback[summary.partnerEmail] = isSelf ? { ...summary, unreadCount: 0 } : summary;
    });
    return fallback;
  }

  private teardownSummarySubscription(sub: SharedSummarySubscription): void {
    sub.torndown = true;
    if (sub.coalesceTimer !== null) {
      clearTimeout(sub.coalesceTimer);
      sub.coalesceTimer = null;
    }
    try {
      sub.detachFirebase?.();
    } catch {}
    sub.detachFirebase = null;
    if (this.summarySubscriptions.get(sub.key) === sub) {
      this.summarySubscriptions.delete(sub.key);
    }
  }

  // Test-only hooks for the shared summaries subscription + coalesced recompute
  // (Task 9). Not part of the public API; used by unit tests to drive coalescing,
  // the per-conversation cache TTL, and to assert ref-counted sharing.
  /** @internal */
  __setSummaryCoalesceWindowMs(ms: number): void {
    this.summaryCoalesceWindowMs = Math.max(0, ms);
  }
  /** @internal */
  __setSummaryUnreadCacheTtlMs(ms: number): void {
    this.summaryUnreadCacheTtlMs = Math.max(0, ms);
  }
  /** @internal */
  __setSummaryClock(now: (() => number) | null): void {
    this.summaryNow = now ?? (() => Date.now());
  }
  /** @internal */
  __getSummarySubscriptionStats(): { activeSubscriptions: number; totalSubscribers: number } {
    let totalSubscribers = 0;
    for (const sub of this.summarySubscriptions.values()) {
      totalSubscribers += sub.subscribers.size;
    }
    return { activeSubscriptions: this.summarySubscriptions.size, totalSubscribers };
  }
  /** @internal */
  __resetSummarySubscriptionState(): void {
    for (const sub of Array.from(this.summarySubscriptions.values())) {
      this.teardownSummarySubscription(sub);
    }
    this.summarySubscriptions.clear();
    this.summaryCoalesceWindowMs = ChatService.SUMMARY_RECOMPUTE_COALESCE_MS;
    this.summaryUnreadCacheTtlMs = ChatService.SUMMARY_UNREAD_CACHE_TTL_MS;
    this.summaryNow = () => Date.now();
  }

  // Typing indicators
  async setTypingStatus(userEmail: string, recipientEmail: string, isTyping: boolean) {
    try {
      const normalizedUserEmail = (userEmail || '').trim().toLowerCase();
      const normalizedRecipientEmail = (recipientEmail || '').trim().toLowerCase();

      if (!normalizedUserEmail || !normalizedRecipientEmail) {
        return;
      }

      if (normalizedUserEmail === normalizedRecipientEmail) {
        return;
      }

      if (isTyping) {
        try {
          await getAuthService().updateTypingStatus(normalizedUserEmail, normalizedRecipientEmail);
        } catch (profileError) {
          logger.warn('Failed to update user profile typing status:', profileError);
        }

        // Auto-clear typing status after 3 seconds
        setTimeout(() => {
          this.setTypingStatus(normalizedUserEmail, normalizedRecipientEmail, false);
        }, 3000);
      } else {
        try {
          await getAuthService().updateTypingStatus(normalizedUserEmail, null);
        } catch (profileError) {
          logger.warn('Failed to clear user profile typing status:', profileError);
        }
      }
    } catch (error) {
      logger.error('Error setting typing status:', error);
    }
  }

  onTypingStatusChange(userEmail: string, recipientEmail: string, callback: (isTyping: boolean) => void): () => void {
    // Typing presence is represented via user profile (Firestore) and surfaced to chat UI
    // via existing presence/member subscriptions. Keep this method as a no-op for
    // backward compatibility.
    callback(false);
    return () => {};
  }

  private isFetchNetworkError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error || '');
    return /failed to fetch|network request failed|load failed/i.test(message);
  }

  private maybeShowUploadNetworkErrorAlert(context: string): void {
    const now = Date.now();
    if (now - this.lastUploadNetworkAlertAt < ChatService.NETWORK_ALERT_COOLDOWN_MS) {
      return;
    }
    this.lastUploadNetworkAlertAt = now;

    const title = 'Upload failed';
    const message = 'We could not reach the upload service. Please check your internet connection and try again.';

    try {
      const shown = tryPresentModalAlert({
        title,
        message,
        buttons: [{ text: 'OK', style: 'primary' }],
        variant: 'warning',
      });
      if (!shown) {
        Alert.alert(title, message, [{ text: 'OK' }]);
      }
    } catch {
      // ignore alert failures
    }

    logger.warn('chat.upload.network_error', { context });
  }

  private buildUploadPreflightUrl(baseUrl: string, tenantId: string, bytes: number): string {
    const url = new URL(`${baseUrl}/storage/upload/preflight`);
    url.searchParams.set('tenantId', tenantId);
    url.searchParams.set('bytes', String(Math.max(0, Math.floor(bytes))));
    return url.toString();
  }

  /**
   * Resolve the `/storage/upload` request (URL + auth headers) for a Phase-2
   * background upload that ALSO creates its chat message server-side. Reuses the
   * same base URL / tenant scope / token / conversation-folder resolution as the
   * foreground `uploadFile`, and carries `createMessage=1` + `clientMsgId` so the
   * server writes the message idempotently on upload completion (even if the app
   * is killed). The actual transfer is performed by the native background uploader.
   */
  async buildChatBackgroundUploadRequest(params: {
    fileName: string;
    fileType: string;
    senderEmail: string;
    recipientEmail: string;
    mediaKind: BackgroundUploadMediaKind;
    clientMsgId: string;
    text?: string;
    /**
     * The pending item's `source` marker (`'keyboard'` | `'picker'`), passed
     * straight through to `deriveStableUploadFileName` so the storage filename
     * this builds matches the one the FOREGROUND path derives for the same send.
     * The marker only picks the `kb_`/`pick_` prefix, but a mismatch there is
     * enough to resolve a different object, which is the whole thing this closes.
     */
    source?: string;
    /**
     * The staged local uri, used only as the extension fallback when `fileType`
     * carries no mime subtype — again the same input the foreground call passes,
     * so the two derivations cannot diverge on a degenerate mime type.
     */
    localUri?: string;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    const baseUrl = this.requireChatBackendBaseUrl();
    const tenantId = await this.ensureTenantChatScope(params.senderEmail, params.recipientEmail);
    internalTokenManager.setBaseUrl(baseUrl);
    const token = await internalTokenManager.getToken(baseUrl);
    if (!token) {
      throw new Error('Authentication token missing. Please sign in again.');
    }
    const conversationFolder = resolveChatUploadFolder({
      senderEmail: params.senderEmail,
      recipientEmail: params.recipientEmail,
    });
    const clientMsgId = sanitizeClientMsgId(params.clientMsgId) || params.clientMsgId;
    // The OS-supplied name, reduced to the same charset it has always been sent in.
    // It is no longer the storage name — it is the DISPLAY name (below), so what the
    // recipient sees is unchanged by this transport going deterministic.
    const sanitizedFileName = (params.fileName || 'file').replace(/[^a-zA-Z0-9.-]/g, '_') || 'file.bin';
    // Storage filename derived from the SAME `clientMsgId` the `uploadKey` below is
    // derived from (`lib/uploadFileName.ts`). Both halves of the object's identity
    // matter: the backend's deterministic chat path is
    // `chat-files/{tenant}/{folder}/k_{hash(uploadKey)}_{safeName}`, so a stable key
    // with an OS-supplied name still resolves to a different object than a
    // foreground attempt for the same send. Sending `file.fileName` here was the
    // last orphan source in the chat media path: a background upload that
    // TRANSFERRED bytes and then failed, followed by a foreground retry, wrote a
    // second blob (the message stayed deduped by `clientMsgId`, so the surplus blob
    // was a pure orphan). Now both transports derive the same pair from the same
    // `tempId`/`clientMsgId` and land on one object.
    //
    // Seeded through `stableIdForFileIndex(clientMsgId, 0)` — byte-identical to the
    // bare `clientMsgId` — so this single-file transport and the foreground
    // multi-file fan-out (`sendMessageWithMultipleFiles`, which seeds file i with
    // `stableIdForFileIndex(clientMsgId, i)`) read the SAME convention from the same
    // helper. A single file is just file 0, and if that convention ever moves, both
    // transports move with it instead of silently drifting apart.
    const fileStableId = stableIdForFileIndex(clientMsgId, 0);
    const storageFileName = deriveStableUploadFileName({
      stableId: fileStableId,
      source: params.source,
      mime: params.fileType,
      uri: params.localUri || params.fileName,
    });
    const url = buildBackgroundUploadUrl(baseUrl, {
      tenantId,
      conversationFolder,
      fileName: storageFileName,
      // Carries the real name through to every user-visible label the backend
      // writes (the created sticker's `name` / attachment's `fileName`, and the
      // pre-created `sharedFiles` doc), so the deterministic storage name above
      // never reaches a bubble or a share sheet.
      displayName: sanitizedFileName,
      clientMsgId,
      recipientId: params.recipientEmail,
      mediaKind: params.mediaKind,
      text: params.text,
      // The highest-value uploadKey in the app. The native uploader retries
      // internally, outside JS control, replaying exactly this URL — so without a
      // stable key each internal retry would land on a fresh timestamped path and
      // store a separate object. Derived from the SAME `clientMsgId` value sent
      // above (post-sanitization) so the key and the message identity can never
      // disagree, and from the same id the foreground path uses, so a foreground
      // fallback after a failed background start targets that one object too —
      // whether that fallback is the sticker/GIF path (`chatService.uploadFile` with
      // `uploadKeyFromStableId(tempId)`, which this equals) or the attachment path
      // (`sendMessageWithMultipleFiles` file 0, which derives the same value from
      // the same seed).
      uploadKey: uploadKeyFromStableId(fileStableId),
    });
    return {
      url,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': params.fileType || 'application/octet-stream',
      },
    };
  }

  private async ensureUploadPreflight(
    baseUrl: string,
    tenantId: string,
    bytes: number,
    context: string,
    authToken?: string,
  ): Promise<void> {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return;
    }

    const preflightUrl = this.buildUploadPreflightUrl(baseUrl, tenantId, bytes);
    const runRequest = async (token?: string) =>
      await fetch(preflightUrl, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });

    let response: Response;
    try {
      response = await runRequest(authToken);
    } catch (error) {
      if (this.isFetchNetworkError(error)) {
        this.maybeShowUploadNetworkErrorAlert(`${context}:network`);
      }
      throw error;
    }

    if (response.status === 401) {
      try {
        await internalTokenManager.forceRefresh(baseUrl);
      } catch {}
      const retryToken = await internalTokenManager.getToken(baseUrl);
      try {
        response = await runRequest(retryToken || undefined);
      } catch (error) {
        if (this.isFetchNetworkError(error)) {
          this.maybeShowUploadNetworkErrorAlert(`${context}:network-retry`);
        }
        throw error;
      }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      maybeShowMaintenanceAlertFromRaw(response.status, text);
      maybeShowStorageLimitReachedAlert(text, context, { incrementBytes: bytes });
      throw new Error(text || `upload_preflight_failed_${response.status}`);
    }
  }

  private async resolveWebUploadBlob(uri: string, sourceBlob?: Blob): Promise<Blob> {
    if (sourceBlob && typeof (sourceBlob as any).size === 'number') {
      return sourceBlob;
    }

    const normalizedUri = String(uri || '').trim();
    const isBlobSource = /^blob:/i.test(normalizedUri);

    try {
      const response = await fetch(normalizedUri);
      if (!response.ok) {
        throw new Error(`Failed to read file data from URI: ${normalizedUri}`);
      }
      return await response.blob();
    } catch (error) {
      if (isBlobSource) {
        // Blob URLs can be revoked/expired locally; this is not a network outage.
        const localSourceError = new Error('local_file_reference_unavailable');
        (localSourceError as any).cause = error;
        throw localSourceError;
      }
      if (this.isFetchNetworkError(error)) {
        this.maybeShowUploadNetworkErrorAlert('chatService.uploadFile(web source)');
      }
      throw error;
    }
  }

  async uploadFile(
    uri: string,
    fileName: string,
    fileType: string,
    participants: ChatUploadParticipants,
    onProgress?: (progress: number) => void,
    options?: UploadSessionOptions,
    sourceBlob?: Blob
  ): Promise<{ url: string; size: number }> {
    try {
      const conversationFolder = resolveChatUploadFolder(participants);
      const sanitizedFileName = (fileName || 'file').replace(/[^a-zA-Z0-9.-]/g, '_') || 'file.bin';
      // The human-visible name, when the caller sends a deterministic STORAGE name
      // as `fileName` (see `UploadSessionOptions.displayName`). Same client-side
      // reduction the outgoing name has always had, plus the endpoint's 255-char
      // bound so an unusually long OS name can never turn into a
      // `400 validation_failed`. Empty ⇒ the parameter is omitted entirely and the
      // backend keeps deriving every visible label from `filename`, as before.
      const sanitizedDisplayName = (options?.displayName || '')
        .trim()
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .slice(0, 255);
      // What a share sheet / the shared-files list should render for this upload.
      const shareDisplayName = sanitizedDisplayName || sanitizedFileName;

      const baseUrl = this.requireChatBackendBaseUrl();

      const tenantId = await this.ensureTenantChatScope(participants.senderEmail || '', participants.recipientEmail);
      internalTokenManager.setBaseUrl(baseUrl);
      const token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        throw new Error('Authentication token missing. Please sign in again.');
      }

      const progressEmitter = createChatUploadProgressEmitter({ onProgress });
      progressEmitter.emit(0, { force: true });
      const emitUploadProgressFromBytes = (sentBytes: unknown, totalBytes: unknown): void => {
        const progressPercent = resolveChatUploadProgressPercentFromBytes(
          sentBytes,
          totalBytes
        );
        if (progressPercent === null) {
          return;
        }

        progressEmitter.emit(progressPercent);
      };

      // Built ONCE here, before every send/retry/token-refresh path below: the web
      // XHR's 401 re-open and the native `createUploadTask` 401 retry both reuse
      // this same `uploadUrl.toString()`, so an `uploadKey` set here is guaranteed
      // identical on every attempt. Minting or mutating it per attempt would defeat
      // the idempotency it exists for.
      const uploadUrl = new URL(`${baseUrl}/storage/upload`);
      uploadUrl.searchParams.set('tenantId', tenantId);
      uploadUrl.searchParams.set('purpose', 'chat');
      uploadUrl.searchParams.set('conversationFolder', conversationFolder);
      uploadUrl.searchParams.set('filename', sanitizedFileName);
      if (options?.uploadKey) {
        uploadUrl.searchParams.set('uploadKey', options.uploadKey);
      }
      if (sanitizedDisplayName) {
        uploadUrl.searchParams.set('displayName', sanitizedDisplayName);
      }

      // Web: XHR for progress support
      if (Platform.OS === 'web') {
        const blob = await this.resolveWebUploadBlob(uri, sourceBlob);
        await this.ensureUploadPreflight(baseUrl, tenantId, blob.size, 'chatService.uploadFile(preflight web)', token);

        return await new Promise<{ url: string; size: number }>((resolve, reject) => {
          let cancelled = false;
          let retried = false;
          let xhr: XMLHttpRequest | null = null;

          const start = async () => {
            xhr = new XMLHttpRequest();
            xhr.open('POST', uploadUrl.toString());
            xhr.setRequestHeader('Content-Type', fileType || blob.type || 'application/octet-stream');
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            xhr.upload.onprogress = (evt) => {
              if (!evt.lengthComputable) return;
              emitUploadProgressFromBytes(evt.loaded, evt.total);
            };

            xhr.onerror = () => {
              if (cancelled) {
                reject(new ChatUploadCanceledError());
                return;
              }
              this.maybeShowUploadNetworkErrorAlert('chatService.uploadFile(web)');
              reject(new Error('upload_failed_network'));
            };

            xhr.onload = async () => {
              if (!xhr) return;
              if (cancelled) {
                reject(new ChatUploadCanceledError());
                return;
              }
              if (xhr.status === 401 && !retried) {
                retried = true;
                try {
                  await internalTokenManager.forceRefresh(baseUrl);
                } catch {}
                // Retry once using fresh token from token manager.
                const retryToken = await internalTokenManager.getToken(baseUrl);
                xhr = new XMLHttpRequest();
                xhr.open('POST', uploadUrl.toString());
                xhr.setRequestHeader('Content-Type', fileType || blob.type || 'application/octet-stream');
                if (retryToken) {
                  xhr.setRequestHeader('Authorization', `Bearer ${retryToken}`);
                }
                xhr.upload.onprogress = (evt) => {
                  if (!evt.lengthComputable) return;
                  emitUploadProgressFromBytes(evt.loaded, evt.total);
                };
                xhr.onerror = () => {
                  if (cancelled) {
                    reject(new ChatUploadCanceledError());
                    return;
                  }
                  this.maybeShowUploadNetworkErrorAlert('chatService.uploadFile(web retry)');
                  reject(new Error('upload_failed_network'));
                };
                xhr.onload = () => {
                  if (!xhr) return;
                  if (cancelled) {
                    reject(new ChatUploadCanceledError());
                    return;
                  }
                  if (xhr.status !== 200) {
                    if (xhr.status === 0) {
                      this.maybeShowUploadNetworkErrorAlert('chatService.uploadFile(web retry)');
                      reject(new Error('upload_failed_network'));
                      return;
                    }
                    maybeShowMaintenanceAlertFromRaw(xhr.status, xhr.responseText || '');
                    maybeShowStorageLimitReachedAlert(xhr.responseText, 'chatService.uploadFile(web retry)');
                    reject(new Error(xhr.responseText || `upload_failed_${xhr.status}`));
                    return;
                  }
                  try {
                    const parsed = JSON.parse(xhr.responseText || '{}');
                    const url = String(parsed.url);
                    const size = Number(parsed.bytes || blob.size || 0);
                    const shareToken = typeof parsed.shareToken === 'string' ? parsed.shareToken.trim() : '';
                    if (shareToken && tenantId) {
                      void sharedFileService.recordUploadShareToken({ tenantId, fileUrl: url, shareToken });
                    } else if (url && tenantId) {
                      // Best-effort: ensure a cached share link exists for later.
                      void sharedFileService.ensureSmartShareLink({ fileUrl: url, fileName: shareDisplayName, fileType, fileSize: size, tenantId });
                    }
                    progressEmitter.emit(100, { force: true });
                    resolve({ url, size });
                  } catch (e) {
                    reject(e);
                  }
                };
                xhr.send(blob);
                return;
              }

              if (xhr.status !== 200) {
                if (xhr.status === 0) {
                  this.maybeShowUploadNetworkErrorAlert('chatService.uploadFile(web)');
                  reject(new Error('upload_failed_network'));
                  return;
                }
                maybeShowMaintenanceAlertFromRaw(xhr.status, xhr.responseText || '');
                maybeShowStorageLimitReachedAlert(xhr.responseText, 'chatService.uploadFile(web)');
                reject(new Error(xhr.responseText || `upload_failed_${xhr.status}`));
                return;
              }

              try {
                const parsed = JSON.parse(xhr.responseText || '{}');
                const url = String(parsed.url);
                const size = Number(parsed.bytes || blob.size || 0);
                const shareToken = typeof parsed.shareToken === 'string' ? parsed.shareToken.trim() : '';
                if (shareToken && tenantId) {
                  void sharedFileService.recordUploadShareToken({ tenantId, fileUrl: url, shareToken });
                } else if (url && tenantId) {
                  void sharedFileService.ensureSmartShareLink({ fileUrl: url, fileName: shareDisplayName, fileType, fileSize: size, tenantId });
                }
                progressEmitter.emit(100, { force: true });
                resolve({ url, size });
              } catch (e) {
                reject(e);
              }
            };

            xhr.send(blob);
          };

          if (options?.registerCancel) {
            options.registerCancel(() => {
              if (cancelled) return;
              cancelled = true;
              try {
                xhr?.abort();
              } catch {}
            });
          }

          void start();
        });
      }

      // Native: Expo FileSystem upload task for progress + cancellation without Blob buffering.
      let sourcePath = uri;
      const timestamp = Date.now();
      const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

      if (/^https?:\/\//i.test(uri)) {
        const tempPath = `${FileSystem.cacheDirectory}upl_${timestamp}_${sanitizedFileName}`;
        const dl = await FileSystem.downloadAsync(uri, tempPath);
        sourcePath = dl.uri;
      }

      const info = await FileSystem.getInfoAsync(sourcePath, { size: true });
      const sizeFromSource = info ? ((info as any)?.size as number | undefined) : undefined;
      if (typeof sizeFromSource === 'number' && sizeFromSource > MAX_SIZE_BYTES) {
        throw new Error(`File exceeds the 50 MB limit (size=${sizeFromSource} bytes)`);
      }
      if (typeof sizeFromSource === 'number' && sizeFromSource > 0) {
        await this.ensureUploadPreflight(baseUrl, tenantId, sizeFromSource, 'chatService.uploadFile(preflight native)', token);
      }

      let cancelled = false;
      const uploadOnce = async (authHeader?: string) => {
        const task = FileSystem.createUploadTask(
          uploadUrl.toString(),
          sourcePath,
          {
            headers: {
              ...(authHeader ? { Authorization: authHeader } : {}),
              'Content-Type': fileType || 'application/octet-stream',
            },
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          },
          (progressEvent) => {
            emitUploadProgressFromBytes(
              progressEvent.totalBytesSent,
              progressEvent.totalBytesExpectedToSend
            );
          }
        );

        const cancelUpload = async () => {
          if (cancelled) return;
          cancelled = true;
          try {
            await task.cancelAsync();
          } catch {}
        };

        if (options?.registerCancel) {
          options.registerCancel(cancelUpload);
        }

        const result = await task.uploadAsync();
        return result;
      };

      let result = await uploadOnce(`Bearer ${token}`);
      if (!result) {
        throw new Error('upload_failed');
      }
      if (result.status === 401) {
        await internalTokenManager.forceRefresh(baseUrl);
        const retryToken = await internalTokenManager.getToken(baseUrl);
        result = await uploadOnce(retryToken ? `Bearer ${retryToken}` : undefined);
      }

      if (!result) {
        throw new Error('upload_failed');
      }

      if (cancelled) {
        throw new ChatUploadCanceledError();
      }

      if (result.status !== 200) {
        const bodyText = typeof result.body === 'string' ? result.body : '';
        maybeShowMaintenanceAlertFromRaw(result.status, bodyText);
        maybeShowStorageLimitReachedAlert(bodyText, 'chatService.uploadFile(native)');
        throw new Error(bodyText || `upload_failed_${result.status}`);
      }

      const parsed = JSON.parse((typeof result.body === 'string' ? result.body : '') || '{}');
      const finalUrl = String(parsed.url || '');
      const finalSize = Number(parsed.bytes || sizeFromSource || 0) || 0;
      const shareToken = typeof parsed.shareToken === 'string' ? parsed.shareToken.trim() : '';
      if (!finalUrl) {
        throw new Error('upload_failed_missing_url');
      }

      if (shareToken && tenantId) {
        void sharedFileService.recordUploadShareToken({ tenantId, fileUrl: finalUrl, shareToken });
      } else if (tenantId) {
        void sharedFileService.ensureSmartShareLink({ fileUrl: finalUrl, fileName: shareDisplayName, fileType, fileSize: finalSize, tenantId });
      }

      progressEmitter.emit(100, { force: true });

      return { url: finalUrl, size: finalSize };
      
    } catch (error) {
      if (error instanceof ChatUploadCanceledError) {
        if (ChatService.ENABLE_CHAT_UPLOAD_DEBUG) {
          logger.info('Upload canceled by user');
        }
        throw error;
      }
      if (this.isFetchNetworkError(error)) {
        this.maybeShowUploadNetworkErrorAlert('chatService.uploadFile');
      }
      logger.error('Error uploading file:', error);
      throw error;
    }
  }

  async uploadProfilePicture(uri: string, userEmail: string, onProgress?: (progress: number) => void): Promise<string> {
    try {
      const baseUrl = this.requireChatBackendBaseUrl();

      const tenantId = await this.ensureTenantChatScope(userEmail);
      internalTokenManager.setBaseUrl(baseUrl);
      const token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        throw new Error('Authentication token missing. Please sign in again.');
      }
      const progressEmitter = createChatUploadProgressEmitter({ onProgress });
      progressEmitter.emit(0, { force: true });
      const emitUploadProgressFromBytes = (sentBytes: unknown, totalBytes: unknown): void => {
        const progressPercent = resolveChatUploadProgressPercentFromBytes(
          sentBytes,
          totalBytes
        );
        if (progressPercent === null) {
          return;
        }

        progressEmitter.emit(progressPercent);
      };

      const uploadUrl = new URL(`${baseUrl}/storage/upload`);
      uploadUrl.searchParams.set('tenantId', tenantId);
      uploadUrl.searchParams.set('purpose', 'profilePicture');
      uploadUrl.searchParams.set('email', userEmail);
      uploadUrl.searchParams.set('filename', 'profile.jpg');

      // Web: use XHR for progress
      if (Platform.OS === 'web') {
        const response = await fetch(uri);
        if (!response.ok) {
          throw new Error(`Failed to read file data from URI: ${uri}`);
        }
        const blob = await response.blob();
        await this.ensureUploadPreflight(baseUrl, tenantId, blob.size, 'chatService.uploadProfilePicture(preflight web)', token);

        return await new Promise<string>((resolve, reject) => {
          // `refreshedFor401`: one-shot token refresh per attempt (reset on a
          // transient retry). `transientAttempt`: bounded transient-failure retries
          // (network drop / 502-503-504), shared policy with the native path. The
          // profilePicture object path is deterministic, so a retry overwrites — no orphan.
          let refreshedFor401 = false;
          let transientAttempt = 1;

          const retryTransient = (): boolean => {
            if (transientAttempt >= UPLOAD_MAX_ATTEMPTS) {
              return false;
            }
            const backoff = uploadRetryBackoffMs(transientAttempt);
            transientAttempt += 1;
            refreshedFor401 = false; // allow a fresh 401 refresh on the retried attempt
            void uploadRetryDelay(backoff).then(() => sendOnce(token));
            return true;
          };

          const sendOnce = async (authToken: string | null) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', uploadUrl.toString());
            xhr.setRequestHeader('Content-Type', blob.type || 'image/jpeg');
            if (authToken) {
              xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
            }
            xhr.upload.onprogress = (evt) => {
              if (!evt.lengthComputable) return;
              emitUploadProgressFromBytes(evt.loaded, evt.total);
            };
            // Network-level failure -> retry transiently if attempts remain.
            xhr.onerror = () => {
              if (retryTransient()) return;
              reject(new Error('upload_failed'));
            };
            xhr.onload = async () => {
              if (xhr.status === 401 && !refreshedFor401) {
                refreshedFor401 = true;
                try {
                  await internalTokenManager.forceRefresh(baseUrl);
                } catch {}
                const retryToken = await internalTokenManager.getToken(baseUrl);
                await sendOnce(retryToken ?? null);
                return;
              }
              if (isTransientUploadStatus(xhr.status) && retryTransient()) {
                return;
              }
              if (xhr.status !== 200) {
                maybeShowMaintenanceAlertFromRaw(xhr.status, xhr.responseText || '');
                maybeShowStorageLimitReachedAlert(xhr.responseText, 'chatService.uploadProfilePicture(web)');
                reject(new Error(xhr.responseText || `upload_failed_${xhr.status}`));
                return;
              }
              try {
                const parsed = JSON.parse(xhr.responseText || '{}');
                const finalUrl = String(parsed.url || '');
                if (!finalUrl) {
                  reject(new Error('upload_failed_missing_url'));
                  return;
                }
                progressEmitter.emit(100, { force: true });
                resolve(finalUrl);
              } catch (e) {
                reject(e);
              }
            };
            xhr.send(blob);
          };

          void sendOnce(token);
        });
      }

      // Native: upload file directly via Expo FileSystem for better memory behavior
      let sourcePath = uri;
      const timestamp = Date.now();
      if (/^https?:\/\//i.test(uri)) {
        const tempPath = `${FileSystem.cacheDirectory}pp_${timestamp}.jpg`;
        const dl = await FileSystem.downloadAsync(uri, tempPath);
        sourcePath = dl.uri;
      }

      const sourceInfo = await FileSystem.getInfoAsync(sourcePath, { size: true });
      const sourceSize = sourceInfo ? ((sourceInfo as any)?.size as number | undefined) : undefined;
      if (typeof sourceSize === 'number' && sourceSize > 0) {
        await this.ensureUploadPreflight(baseUrl, tenantId, sourceSize, 'chatService.uploadProfilePicture(preflight native)', token);
      }

      const uploadOnce = async (authHeader?: string) => {
        const task = FileSystem.createUploadTask(
          uploadUrl.toString(),
          sourcePath,
          {
            headers: {
              ...(authHeader ? { Authorization: authHeader } : {}),
              'Content-Type': 'image/jpeg',
            },
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
          },
          (progressEvent) => {
            emitUploadProgressFromBytes(
              progressEvent.totalBytesSent,
              progressEvent.totalBytesExpectedToSend
            );
          }
        );
        return await task.uploadAsync();
      };

      // One full attempt including the (one-shot) 401 token refresh.
      const runNativeAttempt = async () => {
        let attemptResult = await uploadOnce(`Bearer ${token}`);
        if (attemptResult && attemptResult.status === 401) {
          await internalTokenManager.forceRefresh(baseUrl);
          const retryToken = await internalTokenManager.getToken(baseUrl);
          attemptResult = await uploadOnce(retryToken ? `Bearer ${retryToken}` : undefined);
        }
        return attemptResult;
      };

      // Retry transient failures (network drop / 502-503-504) with bounded backoff.
      // The profile-picture object path is deterministic (email hash) so a retry
      // overwrites the same object — no orphaned duplicate.
      for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
        let result: Awaited<ReturnType<typeof uploadOnce>> | undefined;
        try {
          result = await runNativeAttempt();
        } catch (networkError) {
          if (attempt < UPLOAD_MAX_ATTEMPTS) {
            await uploadRetryDelay(uploadRetryBackoffMs(attempt));
            continue;
          }
          throw networkError;
        }

        if (!result) {
          throw new Error('upload_failed');
        }

        if (isTransientUploadStatus(result.status) && attempt < UPLOAD_MAX_ATTEMPTS) {
          await uploadRetryDelay(uploadRetryBackoffMs(attempt));
          continue;
        }

        if (result.status !== 200) {
          const bodyText = typeof result.body === 'string' ? result.body : '';
          maybeShowMaintenanceAlertFromRaw(result.status, bodyText);
          maybeShowStorageLimitReachedAlert(bodyText, 'chatService.uploadProfilePicture(native)');
          throw new Error(bodyText || `upload_failed_${result.status}`);
        }

        const parsed = JSON.parse((typeof result.body === 'string' ? result.body : '') || '{}');
        const finalUrl = String(parsed.url || '');
        if (!finalUrl) {
          throw new Error('upload_failed_missing_url');
        }
        progressEmitter.emit(100, { force: true });
        return finalUrl;
      }
      // Unreachable: the final iteration always returns or throws.
      throw new Error('upload_failed');
    } catch (error) {
      logger.error('Error uploading profile picture:', error);
      throw error;
    }
  }

  async deleteProfilePicture(photoURL: string, tenantId: string): Promise<void> {
    try {
      // Server-mediated delete (security-rules-hardening M1): client deleteObject
      // is disabled in storage.rules; the backend verifies the object is under
      // this tenant's `profile-pictures/{tenantId}/…` prefix before deleting.
      await deleteStorageObjectViaBackend({ tenantId, target: photoURL });
      logger.debug('Profile picture deleted successfully from storage');
    } catch (error) {
      logger.error('Error deleting profile picture:', error);
      throw error;
    }
  }

  async sendMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>): Promise<string> {
    // Self-address prevention (stuck-message-delivery-fix, Defect A / Property 3).
    // A send whose resolved recipient equals the sender must be rejected at the
    // entry point and NEVER persisted — self-messaging is not a supported feature
    // and this is precisely the outage path that stranded a message in a
    // self-conversation. Reject before any tenant resolution or durable write so
    // no message record, self-conversation node, or self summary is ever created.
    this.assertNotSelfAddressed(message.sender, message.recipientId);

    const tenantId = await this.ensureTenantChatScope(message.sender, message.recipientId);
    const messageWithTenant: Omit<ChatMessage, 'id' | 'timestamp'> = {
      ...message,
      tenantId,
    };

    if (!this.getChatBackendBaseUrl()) {
      return await this.sendMessageDirect(messageWithTenant);
    }

    try {
      const backendResult = await this.sendMessageViaBackend(messageWithTenant);
      if (!backendResult?.messageId) {
        const err = new Error('chat backend response missing message id');
        (err as any).preventFallback = true;
        throw err;
      }
      return backendResult.messageId;
    } catch (error) {
      if (error instanceof ChatRateLimitError) {
        throw error;
      }
      logger.error('Chat backend send failed:', error);
      throw error;
    }
  }

  private async sendMessageDirect(message: Omit<ChatMessage, 'id' | 'timestamp'>): Promise<string> {
    try {
      const normalizedSender = this.normalizeEmail(message.sender);
      const normalizedRecipient = this.normalizeEmail(message.recipientId);
      const conversationKey = this.getConversationKey(normalizedSender, normalizedRecipient);
      const tenantId = typeof message.tenantId === 'string' ? message.tenantId : null;

      // Defense-in-depth self-address guard at the durable-write boundary: never
      // persist a self-addressed message or a self-conversation node/summary.
      this.assertNotSelfAddressed(normalizedSender, normalizedRecipient);
      if (this.isSelfConversationKey(conversationKey)) {
        const err = new Error('You cannot send a message to yourself.');
        (err as any).preventFallback = true;
        (err as any).selfAddressed = true;
        throw err;
      }

      if (!normalizedSender || !conversationKey) {
        throw new Error('Unable to resolve conversation key for message send');
      }
      if (!tenantId) {
        throw new Error('Unable to determine coaching center for this chat message.');
      }

      const conversationRef = this.tenantConversationMessagesRef(tenantId, conversationKey);
      const newMessageRef = push(conversationRef);
      if (!newMessageRef.key) {
        throw new Error('Failed to allocate message id');
      }

      const timestamp = new Date().toISOString();
      const messageRecord: ChatMessage = {
        ...message,
        id: newMessageRef.key,
        sender: normalizedSender,
        recipientId: normalizedRecipient || undefined,
        // Sanitize to an RTDB-path-safe form before persisting. The stored value
        // must match the sanitized index key the backend computes so idempotent
        // re-drives dedupe correctly, and it recovers messages already stuck in
        // the offline queue whose persisted tempId contains a dot
        // (stuck-message-delivery-fix hotfix, Fix A).
        clientMsgId:
          typeof message.clientMsgId === 'string'
            ? sanitizeClientMsgId(message.clientMsgId) || undefined
            : undefined,
        timestamp,
        conversationKey,
        tenantId,
        replyTo: normalizeChatReplyContext(message.replyTo),
        // Receipt integrity (chat-production-hardening, P2-4): a brand-new message
        // is never already delivered/read — force both false on the initial write
        // so the direct-write path matches the backend write boundary and the
        // recipient unread always INCREMENTS (never forged/decremented) on send.
        delivered: false,
        read: false,
        isSpecial: Boolean(message.isSpecial),
      };

      await set(newMessageRef, messageRecord);
      await this.writeMessageIndexRecord(newMessageRef.key, messageRecord);
      await this.registerConversationForUsers(
        messageRecord.sender,
        messageRecord.recipientId,
        newMessageRef.key,
        timestamp,
        tenantId
      );

      if (messageRecord.recipientId) {
        await this.applySummaryUpdatesForMessage(
          newMessageRef.key,
          { ...messageRecord },
          {
            recipientUnreadStrategy: 'increment',
            recipientUnreadAmount: 1,
            forceUpdateLastMessage: true,
            updateIfSameMessageId: true,
          }
        ).catch((error) => {
          logger.warn('Failed to update conversation summaries after send', {
            messageId: newMessageRef.key,
            error,
          });
        });
      }

      logger.metric('chat.message.sent', {
        conversationKey,
        hasAttachments: Boolean(messageRecord.attachments?.length || messageRecord.fileUrl),
      });

      return newMessageRef.key;
    } catch (error) {
      logger.error('Error sending message:', error);
      throw error;
    }
  }

  private async sendMessageViaBackend(
    message: Omit<ChatMessage, 'id' | 'timestamp'>
  ): Promise<{ messageId: string; timestamp?: string } | null> {
    const baseUrl = this.getChatBackendBaseUrl();
    if (!baseUrl) {
      return null;
    }

    const normalizedSender = this.normalizeEmail(message.sender);
    const normalizedRecipient = this.normalizeEmail(message.recipientId);
    const tenantId = typeof message.tenantId === 'string' ? message.tenantId : null;
    if (!normalizedSender || !normalizedRecipient) {
      return null;
    }
    // Defense-in-depth self-address guard at the backend send boundary.
    this.assertNotSelfAddressed(normalizedSender, normalizedRecipient);
    if (!tenantId) {
      throw new Error('Unable to determine coaching center for this chat message.');
    }

    const payload = this.pruneUndefined<{ [key: string]: unknown }>({
      recipientId: normalizedRecipient,
      tenantId,
      // Sanitize the clientMsgId to an RTDB-path-safe form before it leaves the
      // client so the backend can use it as a `.child()` index segment without a
      // 500, and so an already-queued message whose tempId contains a dot is
      // recovered on re-send (stuck-message-delivery-fix hotfix, Fix A).
      clientMsgId:
        typeof message.clientMsgId === 'string'
          ? sanitizeClientMsgId(message.clientMsgId) || undefined
          : undefined,
      text: message.text,
      isSpecial: message.isSpecial,
      fileUrl: message.fileUrl,
      fileName: message.fileName,
      fileType: message.fileType,
      fileSize: message.fileSize,
      thumbnailUrl: message.thumbnailUrl,
      attachments: message.attachments,
      replyTo: normalizeChatReplyContext(message.replyTo),
      sticker: message.sticker,
      gif: message.gif,
      // delivered/read are intentionally NOT sent on the initial send: the backend
      // write boundary forces both false and sets receipts only via the dedicated
      // delivery/read endpoints (chat-production-hardening, P2-4).
    });

    const requestBody = JSON.stringify(payload);

    const sendRequest = async (token: string) =>
      await fetch(`${baseUrl}/chat/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: requestBody,
      });

    try {
      let token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        const err = new Error('Unable to acquire internal auth token');
        (err as any).preventFallback = true;
        throw err;
      }

      let response = await sendRequest(token);
      if (response.status === 401) {
        token = (await internalTokenManager.forceRefresh(baseUrl)) ?? '';
        if (!token) {
          const err = new Error('Unable to refresh internal auth token');
          (err as any).preventFallback = true;
          throw err;
        }
        response = await sendRequest(token);
      }

      if (response.status === 429) {
        let data: any = {};
        try {
          data = await response.json();
        } catch {}
        throw new ChatRateLimitError(
          'Rate limit exceeded',
          typeof data?.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
          typeof data?.blockedUntil === 'number' ? data.blockedUntil : undefined
        );
      }

      if (response.status >= 400 && response.status < 500) {
        let detail: any = {};
        try {
          detail = await response.json();
        } catch {}
        const err = new Error(detail?.error || `chat backend rejected (${response.status})`);
        (err as any).preventFallback = true;
        (err as any).status = response.status;
        throw err;
      }

      if (response.status >= 500) {
        const text = await response.text().catch(() => '');
        maybeShowMaintenanceAlertFromRaw(response.status, text);
        const err = new Error(text || `chat backend send failed (${response.status})`);
        (err as any).preventFallback = true;
        throw err;
      }

      if (!response.ok) {
        const err = new Error(`chat backend send returned status ${response.status}`);
        (err as any).preventFallback = true;
        throw err;
      }

      let data: any = null;
      try {
        data = await response.json();
      } catch {}

      const messagePayload = data?.message;
      if (messagePayload && typeof messagePayload.id === 'string') {
        return {
          messageId: messagePayload.id,
          timestamp: typeof messagePayload.timestamp === 'string' ? messagePayload.timestamp : undefined,
        };
      }

      const err = new Error('chat backend response missing message payload');
      (err as any).preventFallback = true;
      throw err;
    } catch (error) {
      if (error instanceof ChatRateLimitError) {
        throw error;
      }
      if (this.isFetchNetworkError(error)) {
        this.maybeShowUploadNetworkErrorAlert('chatService.sendMessageViaBackend');
      }
      throw error;
    }
  }

  async sendMessageWithFile(
    text: string,
    fileUri: string,
    fileName: string,
    fileType: string,
    sender: string,
    recipientId?: string,
    onProgress?: (progress: number) => void,
    options?: UploadSessionOptions,
    replyTo?: ChatReplyContext
  ): Promise<string> {
    try {
      const { url, size } = await this.uploadFile(
        fileUri,
        fileName,
        fileType,
        { senderEmail: sender, recipientEmail: recipientId },
        onProgress,
        options
      );
      
      // Normalize sender and recipientId to lowercase
      return this.sendMessage({
        text: resolveChatAttachmentAutoText({
          text,
          files: [{ fileType, fileName }],
        }),
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
        replyTo: normalizeChatReplyContext(replyTo),
        fileUrl: url,
        fileName,
        fileType,
        fileSize: size,
      });
    } catch (error) {
      if (error instanceof ChatUploadCanceledError) {
        if (ChatService.ENABLE_CHAT_UPLOAD_DEBUG) {
          logger.info('Send with file canceled by user');
        }
        throw error;
      }
      logger.error('Error sending message with file:', error);
      throw error;
    }
  }

  async sendMessageWithMultipleFiles(
    text: string,
    files: {
      uri: string;
      fileName: string;
      fileType: string;
      fileSize?: number;
      webFile?: Blob;
    }[],
    sender: string,
    // upload-idempotency (Requirement 7.1/7.4, follow-up F7): `clientMsgId` below is
    // REQUIRED, because it is the only thing that makes this fan-out idempotent
    // ACROSS invocations. TypeScript forbids a required parameter after an optional
    // one (TS1016), so the four parameters between `sender` and it are declared as
    // required-but-`undefined`-able instead of optional. That keeps every argument
    // POSITION exactly where it was — no call site's arguments shift — while
    // omitting the id becomes a compile error rather than a silent downgrade to the
    // degraded path below.
    recipientId: string | undefined,
    onProgress: ((progress: number) => void) | undefined,
    options: UploadSessionOptions | undefined,
    replyTo: ChatReplyContext | undefined,
    /**
     * The caller's DURABLE, re-drive-stable id for this one logical send — the chat
     * `tempId`, which is both the `pendingAttachments` map key and the key of the
     * persisted outbox record (`PendingMessageStorage`), so the user-tapped retry,
     * the auto-retry-on-reconnect pass and the resume-on-relaunch pass all re-drive
     * with the identical value. Non-empty is not sufficient: a freshly minted id per
     * attempt would type-check and still orphan.
     */
    clientMsgId: string
  ): Promise<string> {
    try {
      if (files.length === 0) {
        throw new Error('No files provided');
      }

      // Check file size limit (50 MB = 50 * 1024 * 1024 bytes)
      const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
      const oversizedFiles = files.filter(file => {
        const fileSize = file.fileSize || 0;
        return fileSize > MAX_FILE_SIZE;
      });

      if (oversizedFiles.length > 0) {
        const fileNames = oversizedFiles.map(file => file.fileName).join(', ');
        throw new Error(`The following file(s) exceed the 50 MB limit: ${fileNames}`);
      }

      const progressEmitter = createChatUploadProgressEmitter({ onProgress });
      const fileProgress = new Array(files.length).fill(0);
      let progressTotal = 0;
      progressEmitter.emit(0, { force: true });

      const updateOverallProgress = (index: number, progress: unknown): void => {
        const nextProgress = normalizeChatUploadProgressPercent(progress);
        const previousProgress = fileProgress[index] || 0;
        if (nextProgress <= previousProgress) {
          return;
        }

        fileProgress[index] = nextProgress;
        progressTotal += nextProgress - previousProgress;
        progressEmitter.emit(progressTotal / files.length);
      };

      const cancelFns: ((() => void | Promise<void>) | undefined)[] = [];
      if (options?.registerCancel) {
        options.registerCancel(async () => {
          const executions = cancelFns
            .filter((fn): fn is () => void | Promise<void> => typeof fn === 'function')
            .map(async (fn) => {
              try {
                await fn();
              } catch (cancelError) {
                if (ChatService.ENABLE_CHAT_UPLOAD_DEBUG) {
                  logger.warn('Attachment cancel function failed', cancelError);
                }
              }
            });
          await Promise.allSettled(executions);
        });
      }

      // upload-idempotency (Requirements 7.1–7.3, 7.7): one DISTINCT, retry-stable
      // object identity per attachment — BOTH halves of it, the `uploadKey` and the
      // storage filename, derived from the same `(clientMsgId, index)` seed
      // (`stableIdForFileIndex`).
      //
      // DISTINCTNESS is mandatory, not cosmetic. The backend's deterministic chat
      // path is `chat-files/{tenant}/{folder}/k_{hash(uploadKey)}_{safeName}`
      // (`backend-runtime/src/lib/uploadObjectPath.ts`), so N files sharing ONE key
      // would resolve to paths differing only by filename — and two attachments
      // carrying the same filename in one send would collapse onto a single object,
      // silently losing a file. The per-index key is what keeps them apart; the
      // filename difference is not something this may lean on.
      //
      // STABILITY is what makes a re-drive idempotent. `clientMsgId` is the chat
      // `tempId`: minted once per send, used as the `pendingAttachments` map key,
      // and passed back UNCHANGED by the user-tapped retry, the
      // auto-retry-on-reconnect pass and the outbox re-drive
      // (`app/(tabs)/chat.tsx` `retryPendingAttachment`, which re-sends the same
      // `entry.files` array in the same order). So file i of a re-driven send
      // derives the same key and overwrites its own first attempt instead of
      // orphaning it. The base is captured HERE, outside the map, and
      // `uploadFile` builds its URL once before its own retry/401-refresh paths, so
      // no attempt can ever see a re-minted key.
      //
      // Two separate user actions get two different `tempId`s and therefore two
      // disjoint key sets, so deliberately sending the same file twice still
      // produces two objects (Requirement 7.3) — this is retry dedupe, not
      // content-addressed dedupe.
      //
      // BLANK `clientMsgId` — the DEGRADED path, and no longer reachable from a
      // type-checked caller. The parameter is required (see the signature), so a
      // TypeScript call site cannot omit it; this branch exists only for a JS caller
      // or an `any`-typed call, and for a caller that passes an empty/whitespace
      // string. It mints ONE random base for this invocation and indexes that, which
      // keeps the N files distinct from one another and still gives the transport's
      // own retries (the 401 re-open, the native task retry) one object apiece — but
      // it provides NO dedupe across invocations, so a re-drive writes new objects
      // and orphans the first attempt's. That lost guarantee is what the warning
      // below names: the weak path is unreachable by construction and loud if it
      // somehow happens anyway, rather than a crash that would cost the user their
      // send. Omitting `uploadKey` entirely would give up the within-invocation win
      // and gain nothing, and a single shared key for all N files is unsafe for the
      // same-filename reason above.
      const stableBase = typeof clientMsgId === 'string' ? clientMsgId.trim() : '';
      if (!stableBase) {
        logger.warn('chat.upload.multi_file_missing_client_msg_id', {
          fileCount: files.length,
          lostGuarantee:
            'no cross-invocation upload dedupe: a re-drive of this send will write new objects and orphan this attempt\'s',
        });
      }
      const uploadKeyBase = stableBase || newUploadKey('chat_multi');

      // Upload all files with individual progress tracking
      const uploadPromises = files.map((file, index) => {
        // The seed for file `index` of this send. BOTH halves of the stored
        // object's identity come from it: the `uploadKey` below and the storage
        // filename beside it. The backend's deterministic chat path is
        // `chat-files/{tenant}/{folder}/k_{hash(uploadKey)}_{safeName}`, so a
        // stable key paired with the OS-supplied name is only half-stable — which
        // is precisely how this path used to disagree with the native background
        // transport for a SINGLE-file send: background keyed on the bare
        // `clientMsgId` with a `clientMsgId`-derived filename, foreground keyed on
        // `uploadKeyForFileIndex(clientMsgId, 0)` with `file.fileName`. Both halves
        // differed, so a background attachment that TRANSFERRED bytes and then
        // failed, followed by a foreground re-drive of the same send, wrote a
        // second object — a pure orphan, since the message stays deduped by
        // `clientMsgId`. `stableIdForFileIndex` returns the bare base for
        // `index === 0`, so the two transports now derive the identical pair.
        const fileStableId = stableIdForFileIndex(uploadKeyBase, index);
        return this.uploadFile(
          file.uri,
          // The STORAGE name, not the display name. Deterministic in
          // `(clientMsgId, index)` — index participates, so two attachments that
          // share an OS filename still resolve to different objects, and a
          // re-driven send overwrites its own first attempt instead of orphaning
          // it. `file.fileName` rides along as `displayName` below, and the
          // `attachments` array built after these uploads carries it verbatim, so
          // nothing user-visible moves (this path builds its own message payload;
          // it does not use the server's `createMessage=1` path).
          deriveStableUploadFileName({
            stableId: fileStableId,
            // Not `'keyboard'`: these files come from the picker/share sheet, which
            // is also what the background attachment request passes, so the
            // `pick_` marker matches on both transports.
            source: 'picker',
            mime: file.fileType,
            uri: file.uri,
          }),
          file.fileType,
          { senderEmail: sender, recipientEmail: recipientId },
          (progress: number) => {
            updateOverallProgress(index, progress);
          },
          {
            registerCancel: (fn: () => void | Promise<void>) => {
              cancelFns[index] = fn;
            },
            uploadKey: uploadKeyForFileIndex(uploadKeyBase, index),
            // Keeps the real name on every label the upload writes server-side
            // (the pre-created `sharedFiles` doc) and client-side
            // (`ensureSmartShareLink`), unchanged by the storage name above.
            displayName: file.fileName,
          },
          file.webFile
        );
      });
      
      const uploadResults = await Promise.all(uploadPromises);
      progressEmitter.emit(100, { force: true });
      
      // Create attachments array.
      //
      // `fileName` is the OS-supplied name, taken straight from the input `files`
      // and INDEPENDENT of the storage filename sent above — this client builds the
      // message payload itself rather than relying on the server's
      // `createMessage=1` path, so making the upload filename deterministic has
      // zero effect on what the recipient sees.
      const attachments: FileAttachment[] = files.map((file, index) => ({
        url: uploadResults[index].url,
        fileName: file.fileName,
        fileType: file.fileType,
        fileSize: uploadResults[index].size,
      }));

      const messageText = resolveChatAttachmentAutoText({
        text,
        files,
      });
      
      // Send message with attachments
      return this.sendMessage({
        text: messageText,
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
        attachments,
        replyTo: normalizeChatReplyContext(replyTo),
        clientMsgId,
      });
    } catch (error) {
      if (error instanceof ChatUploadCanceledError) {
        if (ChatService.ENABLE_CHAT_UPLOAD_DEBUG) {
          logger.info('Send with multiple files canceled by user');
        }
        throw error;
      }
      logger.error('Error sending message with multiple files:', error);
      throw error;
    }
  }

  // Send sticker message (WhatsApp-style)
  async sendSticker(
    sticker: {
      url: string;
      name: string;
      pack?: string;
      width?: number;
      height?: number;
    },
    sender: string,
    recipientId?: string,
    options?: { replyTo?: ChatReplyContext; clientMsgId?: string }
  ): Promise<string> {
    try {
      return this.sendMessage({
  text: '', // No attached text for sticker messages
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
        replyTo: normalizeChatReplyContext(options?.replyTo),
        clientMsgId: options?.clientMsgId,
        sticker,
      });
    } catch (error) {
      logger.error('Error sending sticker:', error);
      throw error;
    }
  }

  // Send GIF message (WhatsApp-style)
  async sendGif(
    gif: {
      url: string;
      thumbnailUrl?: string;
      width?: number;
      height?: number;
      title?: string;
      source?: string;
    },
    sender: string,
    recipientId?: string,
    options?: { replyTo?: ChatReplyContext; clientMsgId?: string }
  ): Promise<string> {
    try {
      return this.sendMessage({
  text: '', // No attached text for GIF messages
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
        replyTo: normalizeChatReplyContext(options?.replyTo),
        clientMsgId: options?.clientMsgId,
        gif,
      });
    } catch (error) {
      logger.error('Error sending GIF:', error);
      throw error;
    }
  }

  async editMessage(messageId: string, text: string): Promise<ChatMessage> {
    const trimmed = (text || '').trim();
    if (!messageId) {
      throw new ChatMessageActionError('Message id is required', 'invalid_payload');
    }
    if (!trimmed) {
      throw new ChatMessageActionError('Edited message cannot be empty', 'invalid_payload');
    }

    const actorEmail = this.requireCurrentUserEmail();
    const tenantId = await this.ensureTenantChatScope(actorEmail);

    const data = await this.performChatAction('PATCH', `/chat/messages/${encodeURIComponent(messageId)}`, {
      body: { text: trimmed },
      tenantId,
    });

    const normalized = this.normalizeRealtimePayload(data?.message, data?.message?.conversationKey);
    if (!normalized) {
      throw new Error('chat backend response missing updated message payload');
    }
    return normalized;
  }

  async deleteMessage(messageId: string): Promise<ChatMessage> {
    if (!messageId) {
      throw new ChatMessageActionError('Message id is required', 'invalid_payload');
    }

    const actorEmail = this.requireCurrentUserEmail();
    const tenantId = await this.ensureTenantChatScope(actorEmail);

    const data = await this.performChatAction('DELETE', `/chat/messages/${encodeURIComponent(messageId)}`, {
      tenantId,
    });

    const normalized = this.normalizeRealtimePayload(data?.message, data?.message?.conversationKey);
    if (!normalized) {
      throw new Error('chat backend response missing deleted message payload');
    }
    return normalized;
  }

  // Map a compact server inbound event to the lightweight ChatMessage shape the
  // notification hook expects (identical to the record shape the prior RTDB
  // `messageIndex` reader produced: no message body, just routing + status).
  private mapInboxPayloadToMessage(
    payload: InboxInboundPayload,
    tenantScopeId: string
  ): ChatMessage | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    const id = typeof payload.id === 'string' && payload.id.trim().length > 0 ? payload.id : null;
    const sender = this.normalizeEmail(payload.sender);
    if (!id || !sender || !payload.timestamp) {
      return null;
    }
    return {
      id,
      sender,
      recipientId: this.normalizeEmail(payload.recipientId) || undefined,
      text: '',
      timestamp: payload.timestamp,
      isSpecial: Boolean(payload.isSpecial),
      delivered: Boolean(payload.delivered),
      read: Boolean(payload.read),
      conversationKey: payload.conversationKey,
      tenantId: payload.tenantId ?? tenantScopeId,
    } as ChatMessage;
  }

  // Global per-user "a new inbound message arrived for me" signal that powers
  // in-app chat notifications (hooks/useNotifications.ts).
  //
  // chat-production-hardening (messageIndex read lockdown): this NO LONGER reads
  // the RTDB `tenantChat/{tenantId}/messageIndex` node from the client. Instead
  // it subscribes to the authenticated backend per-user inbound stream
  // (`chatInboxStream` -> `/chat/inbox-stream`), where the server watches the
  // caller's own inbound index records via the Admin SDK (which bypasses rules).
  // The callback contract is preserved: it is invoked with lightweight
  // ChatMessage records (empty `text`, routing + status only), so the hook's
  // filtering/dedup/notification logic is unchanged. Each stream event carries a
  // single newly-arrived inbound message; the hook already filters by recency
  // and dedups by id.
  onMessagesChange(recipientEmail: string, callback: (messages: ChatMessage[]) => void): () => void {
    if (typeof callback !== 'function') {
      logger.warn('onMessagesChange invoked without a valid callback', {
        recipientEmail,
        callbackType: typeof callback,
      });
      return () => {};
    }

    const normalizedRecipient = this.normalizeEmail(recipientEmail);
    if (!normalizedRecipient) {
      callback([]);
      return () => {};
    }

    const baseUrl = this.getChatBackendBaseUrl();
    if (!baseUrl || !this.realtimeStreamEnabled) {
      // No server-side inbox stream available. Emit an empty set (parity with the
      // prior no-data path) and read nothing from RTDB.
      callback([]);
      return () => {};
    }

    let close: (() => void) | null = null;
    let cancelled = false;

    const attach = async () => {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      if (cancelled) {
        return;
      }

      const subscriptionClose = await chatInboxStream.subscribe<InboxInboundPayload>({
        baseUrl,
        tenantId: tenantScopeId,
        userEmail: normalizedRecipient,
        onInbound: (payload) => {
          const message = this.mapInboxPayloadToMessage(payload, tenantScopeId);
          if (!message) {
            return;
          }
          logger.metric('chat.listener.userInbox', {
            recipient: normalizedRecipient,
            count: 1,
          });
          callback([message]);
        },
      });

      if (cancelled) {
        subscriptionClose?.();
        return;
      }
      close = subscriptionClose;
    };

    void attach().catch((error) => {
      if (!cancelled) {
        logger.warn('Failed to subscribe to inbound message stream', { error });
      }
    });

    return () => {
      cancelled = true;
      close?.();
      close = null;
    };
  }

  // Enhanced listener for new messages with animation trigger
  onNewMessageForChat(
    currentUserEmail: string,
    chatPartnerEmail: string,
    callback: (newMessage: ChatMessage) => void
  ): () => void {
    const me = this.normalizeEmail(currentUserEmail);
    const them = this.normalizeEmail(chatPartnerEmail);
    const conversationKey = this.getConversationKey(me, them);
    if (!conversationKey || !me || !them) {
      return () => {};
    }

    let conversationQuery: ReturnType<typeof query> | null = null;
    const processedMessageIds = new Set<string>();
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    const primeAndSubscribe = async () => {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      const conversationRef = this.tenantConversationMessagesRef(tenantScopeId, conversationKey);
      conversationQuery = query(conversationRef, orderByChild('timestamp'));

      try {
        const snapshot = await get(conversationQuery);
        if (snapshot.exists()) {
          snapshot.forEach((childSnapshot) => {
            const key = childSnapshot.key;
            if (key) {
              processedMessageIds.add(key);
            }
            return undefined;
          });
        }
      } catch (error) {
        logger.warn('Failed to prime conversation listener', { conversationKey, error });
      }

      if (cancelled) {
        return;
      }

      const listener = onChildAdded(conversationQuery, (snapshot) => {
        const msg = snapshot.val();
        const key = snapshot.key;
        if (!msg || !key) {
          return;
        }

        if (processedMessageIds.has(key)) {
          return;
        }
        processedMessageIds.add(key);

        const newMessage: ChatMessage = {
          id: key,
          sender: this.normalizeEmail(msg.sender),
          recipientId: this.normalizeEmail(msg.recipientId) || undefined,
          text: msg.text,
          timestamp: msg.timestamp,
          isSpecial: msg.isSpecial,
          tenantId: typeof msg.tenantId === 'string' ? msg.tenantId : undefined,
          fileUrl: msg.fileUrl,
          fileName: msg.fileName,
          fileType: msg.fileType,
          fileSize: msg.fileSize,
          thumbnailUrl: msg.thumbnailUrl,
          attachments: msg.attachments,
          replyTo: normalizeChatReplyContext(msg.replyTo),
          sticker: msg.sticker,
          gif: msg.gif,
          delivered: msg.delivered,
          read: msg.read,
          deliveredAt: msg.deliveredAt,
          readAt: msg.readAt,
          conversationKey,
        };

        callback(newMessage);
      });

      cleanup = () => {
        if (conversationQuery) {
          off(conversationQuery, 'child_added', listener);
        }
      };
    };

    void primeAndSubscribe();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }

  onChatMessageStatusChange(
    currentUserEmail: string,
    chatPartnerEmail: string,
    callback: (updatedMessage: ChatMessage) => void
  ): () => void {
    const me = this.normalizeEmail(currentUserEmail);
    const them = this.normalizeEmail(chatPartnerEmail);
    const conversationKey = this.getConversationKey(me, them);
    if (!conversationKey) {
      return () => {};
    }

    let detached: (() => void) | null = null;
    let cancelled = false;

    const attach = async () => {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      const conversationRef = this.tenantConversationMessagesRef(tenantScopeId, conversationKey);
      const conversationQuery = query(conversationRef, orderByChild('timestamp'));

      const listener = onChildChanged(conversationQuery, (snapshot) => {
        const msg = snapshot.val();
        if (!msg) {
          return;
        }

        const updatedMessage: ChatMessage = {
          id: snapshot.key || undefined,
          sender: this.normalizeEmail(msg.sender),
          recipientId: this.normalizeEmail(msg.recipientId) || undefined,
          text: msg.text,
          timestamp: msg.timestamp,
          isSpecial: msg.isSpecial,
          tenantId: typeof msg.tenantId === 'string' ? msg.tenantId : tenantScopeId,
          fileUrl: msg.fileUrl,
          fileName: msg.fileName,
          fileType: msg.fileType,
          fileSize: msg.fileSize,
          thumbnailUrl: msg.thumbnailUrl,
          attachments: msg.attachments,
          replyTo: normalizeChatReplyContext(msg.replyTo),
          sticker: msg.sticker,
          gif: msg.gif,
          delivered: msg.delivered,
          read: msg.read,
          deliveredAt: msg.deliveredAt,
          readAt: msg.readAt,
          conversationKey,
          editedAt: typeof msg.editedAt === 'string' ? msg.editedAt : undefined,
          editCount: typeof msg.editCount === 'number' ? msg.editCount : undefined,
          deleted: typeof msg.deleted === 'boolean' ? msg.deleted : undefined,
          deletedAt: typeof msg.deletedAt === 'string' ? msg.deletedAt : undefined,
          deletedBy: this.normalizeEmail(msg.deletedBy) || undefined,
          reactions:
            msg.reactions && typeof msg.reactions === 'object' && !Array.isArray(msg.reactions)
              ? (msg.reactions as Record<string, string[]>)
              : undefined,
        };

        callback(updatedMessage);
      });

      detached = () => {
        try {
          off(conversationQuery, 'child_changed', listener);
        } catch {}
      };
    };

    void attach().catch((error) => {
      if (!cancelled) {
        logger.warn('Failed to subscribe to conversation status changes', { error });
      }
    });

    return () => {
      cancelled = true;
      detached?.();
    };
  }

  async sendSpecialMessage(text: string, senderEmail: string, recipientId?: string): Promise<string> {
    return this.sendMessage({
      text,
      sender: senderEmail,
      recipientId,
      isSpecial: true,
    });
  }

  async syncConversationReceipts(
    partnerEmail: string,
    options: {
      deliveredMessageIds?: string[];
      readMessageIds?: string[];
      markConversationDelivered?: boolean;
      tenantId?: string | null;
    } = {}
  ): Promise<ChatReceiptSyncResult> {
    const normalizedPartner = this.normalizeEmail(partnerEmail);
    if (!normalizedPartner) {
      throw new Error('Partner email is required for receipt sync');
    }

    const resolvedTenantId = options.tenantId ?? await tenantService.getCachedSelectedTenant();
    const tenantScopeId = this.requireTenantId(resolvedTenantId);
    const response = await this.performChatAction('POST', '/chat/receipts/sync', {
      tenantId: tenantScopeId,
      body: this.pruneUndefined({
        partnerEmail: normalizedPartner,
        deliveredMessageIds: options.deliveredMessageIds?.filter(Boolean),
        readMessageIds: options.readMessageIds?.filter(Boolean),
        markConversationDelivered: options.markConversationDelivered,
      }),
    });

    return {
      ok: Boolean(response?.ok),
      deliveredMessageIds: Array.isArray(response?.deliveredMessageIds) ? response.deliveredMessageIds : [],
      readMessageIds: Array.isArray(response?.readMessageIds) ? response.readMessageIds : [],
      deliveredCount: typeof response?.deliveredCount === 'number' ? response.deliveredCount : 0,
      readCount: typeof response?.readCount === 'number' ? response.readCount : 0,
      actorHasOnlineDevice: response?.actorHasOnlineDevice === true,
      actorHasFocusedChatDevice: response?.actorHasFocusedChatDevice === true,
    };
  }

  async confirmOutboundDelivery(
    partnerEmail: string,
    deliveredMessageIds: string[],
    options: {
      tenantId?: string | null;
      provenance?: ChatDeliveryProvenance;
    } = {}
  ): Promise<ChatOutboundDeliverySyncResult> {
    const normalizedPartner = this.normalizeEmail(partnerEmail);
    if (!normalizedPartner) {
      throw new Error('Partner email is required for outbound delivery confirmation');
    }

    const normalizedIds = Array.from(new Set(deliveredMessageIds.map((entry) => String(entry || '').trim()).filter(Boolean)));
    if (!normalizedIds.length) {
      return {
        ok: true,
        deliveredMessageIds: [],
        deliveredCount: 0,
      };
    }

    const resolvedTenantId = options.tenantId ?? await tenantService.getCachedSelectedTenant();
    const tenantScopeId = this.requireTenantId(resolvedTenantId);
    const response = await this.performChatAction('POST', '/chat/receipts/outbound-delivered', {
      tenantId: tenantScopeId,
      body: this.pruneUndefined({
        partnerEmail: normalizedPartner,
        deliveredMessageIds: normalizedIds,
        provenance: normalizeChatDeliveryProvenance(options.provenance),
      }),
    });

    return {
      ok: Boolean(response?.ok),
      deliveredMessageIds: Array.isArray(response?.deliveredMessageIds) ? response.deliveredMessageIds : [],
      deliveredCount: typeof response?.deliveredCount === 'number' ? response.deliveredCount : 0,
    };
  }

  // Mark every unread incoming message in a conversation as read.
  //
  // chat-production-hardening (finding P0-1 — Model A: backend is the only chat
  // writer): when the chat backend is configured, the read is performed through
  // the authenticated `/chat/conversations/read` endpoint so the reader identity
  // is bound to the token and the RTDB write happens server-side (client chat
  // write paths are locked to `.write:false`). The direct-write path is retained
  // ONLY as the no-backend fallback (parity with `sendMessage`/`sendMessageDirect`).
  async markConversationAsRead(currentUserEmail: string, otherUserEmail: string): Promise<number> {
    const me = this.normalizeEmail(currentUserEmail);
    const them = this.normalizeEmail(otherUserEmail);
    const conversationKey = this.getConversationKey(me, them);
    if (!conversationKey || !me || !them) {
      return 0;
    }
    // A self-conversation has no incoming messages to read; return gracefully
    // without touching the backend (the endpoint rejects self-conversations).
    if (this.isSelfConversationKey(conversationKey) || this.isSelfAddressed(me, them)) {
      return 0;
    }

    if (this.getChatBackendBaseUrl()) {
      try {
        const tenantId = await this.ensureTenantChatScope(me, them);
        const response = await this.performChatAction('POST', '/chat/conversations/read', {
          tenantId,
          body: { partnerEmail: them },
        });
        const updatedCount =
          typeof response?.updatedCount === 'number'
            ? response.updatedCount
            : Array.isArray(response?.readMessageIds)
              ? response.readMessageIds.length
              : 0;
        logger.metric('chat.conversation.read_all', {
          conversationKey,
          updatedCount,
        });
        return updatedCount;
      } catch (error) {
        logger.error('Error marking conversation as read via backend:', error);
        return 0;
      }
    }

    return this.markConversationAsReadDirect(me, them, conversationKey);
  }

  private async markConversationAsReadDirect(
    me: string,
    them: string,
    conversationKey: string
  ): Promise<number> {
    try {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      const conversationRef = this.tenantConversationMessagesRef(tenantScopeId, conversationKey);
      // chat-production-hardening (Task 10, finding P2-2). Build the read-receipt
      // patch from a BOUNDED indexed query over the `read == false` set so the
      // read cost scales with the number of UNREAD messages, not the whole
      // conversation history (O(unread), not O(all messages)). This mirrors the
      // server-side writer `markChatConversationRead`
      // (backend-runtime/src/chatMessageWriter.ts) — the primary hot path — which
      // already uses the same bounded query. The remaining predicate
      // (genuinely-incoming `partner → viewer`, not deleted) is re-applied to the
      // bounded set because the index only narrows on `read` (a non-indexed
      // fallback / mock store may return a superset).
      const unreadQuery = query(conversationRef, orderByChild('read'), equalTo(false));
      const snapshot = await get(unreadQuery);
      if (!snapshot.exists()) {
        return 0;
      }

      const nowIso = new Date().toISOString();
      const patch: Record<string, any> = {};
      let updatedCount = 0;

      snapshot.forEach((childSnapshot) => {
        const messageId = childSnapshot.key;
        const data = childSnapshot.val();
        if (!messageId || !data) {
          return undefined;
        }

        const sender = this.normalizeEmail(data.sender);
        const recipient = this.normalizeEmail(data.recipientId);
        const isUnreadIncoming = sender === them && recipient === me && !data.read && !data.deleted;
        if (!isUnreadIncoming) {
          return undefined;
        }

        patch[`${messageId}/read`] = true;
        patch[`${messageId}/readAt`] = nowIso;
        if (!data.delivered) {
          patch[`${messageId}/delivered`] = true;
        }
        if (!data.deliveredAt) {
          patch[`${messageId}/deliveredAt`] = nowIso;
        }
        updatedCount += 1;
        return undefined;
      });

      if (!updatedCount) {
        return 0;
      }

      await update(conversationRef, patch);
      // Drive the summary refresh from the BOUNDED reconcile (recomputes the
      // affected conversation's stored unreadCount from the true-unread set and
      // writes back only on drift, O(unread)) rather than the full-history
      // `rebuildConversationSummariesForUser`, which loops every conversation and
      // reads each one's entire message node — negating the bounded-unread
      // benefit on this hot path (finding P2-2). This mirrors the backend hot
      // path (`reconcileOwnerConversationUnread`), which reconciles only the
      // affected conversation's counter; the full rebuild is retained for
      // explicit repair only. Reconcile also cleans up any stuck
      // self-conversation summary so the badge converges. Idempotent and bounded
      // (O(unread)). `force` bypasses the client throttle because we just mutated
      // read state — this reconcile is genuinely needed and must not be
      // suppressed by a recent read-path trigger.
      await this.reconcileUnreadForUser(me, tenantScopeId, { force: true });

      logger.metric('chat.conversation.read_all', {
        conversationKey,
        updatedCount,
      });

      return updatedCount;
    } catch (error) {
      logger.error('Error marking conversation as read:', error);
      return 0;
    }
  }

  // Get unread message count for a specific conversation between two users
  async getUnreadMessageCount(currentUserEmail: string, otherUserEmail: string): Promise<number> {
    try {
      const me = this.normalizeEmail(currentUserEmail);
      const them = this.normalizeEmail(otherUserEmail);
      const conversationKey = this.getConversationKey(me, them);
      if (!conversationKey || !me || !them) {
        return 0;
      }

      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      const conversationRef = this.tenantConversationMessagesRef(tenantScopeId, conversationKey);
      const snapshot = await get(conversationRef);
      if (!snapshot.exists()) {
        return 0;
      }

      let unreadCount = 0;
      snapshot.forEach((child) => {
        const data = child.val();
        if (
          this.normalizeEmail(data.recipientId) === me &&
          this.normalizeEmail(data.sender) === them &&
          !data.read &&
          !data.deleted
        ) {
          unreadCount += 1;
        }
        return undefined;
      });

      return unreadCount;
    } catch (error) {
      logger.error('Error getting unread message count:', error);
      return 0;
    }
  }

  // Get last message between two users (for preview)
  async getLastMessage(userEmail1: string, userEmail2: string): Promise<ChatMessage | null> {
    try {
      const a = this.normalizeEmail(userEmail1);
      const b = this.normalizeEmail(userEmail2);
      const conversationKey = this.getConversationKey(a, b);
      if (!conversationKey || !a || !b) {
        return null;
      }

      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      const conversationRef = this.tenantConversationMessagesRef(tenantScopeId, conversationKey);
      const lastQuery = query(conversationRef, orderByChild('timestamp'), limitToLast(1));
      const snapshot = await get(lastQuery);
      if (!snapshot.exists()) {
        return null;
      }

      let lastMessage: ChatMessage | null = null;
      snapshot.forEach((child) => {
        const data = child.val();
        lastMessage = {
          ...data,
          id: child.key || data?.id,
        };
        return undefined;
      });

      return lastMessage;
    } catch (error) {
      logger.error('Error getting last message:', error);
      return null;
    }
  }

  // Message Reactions functionality - Special messages allow multiple reactions per user
  async toggleMessageReaction(messageId: string, reactionType: string, userEmail: string) {
    try {
      const normalizedUser = this.normalizeEmail(userEmail);
      if (!normalizedUser) {
        return [];
      }

      const baseUrl = this.requireChatBackendBaseUrl();
      const tenantId = await this.ensureTenantChatScope(normalizedUser);

      const payload = JSON.stringify({
        tenantId,
        reactionType: (reactionType || '').trim(),
      });

      const sendRequest = async (token: string) =>
        await fetch(`${baseUrl}/chat/messages/${encodeURIComponent(messageId)}/reactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: payload,
        });

      let token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        throw new Error('Unable to acquire internal auth token');
      }

      let response = await sendRequest(token);
      if (response.status === 401) {
        token = (await internalTokenManager.forceRefresh(baseUrl)) ?? '';
        if (!token) {
          throw new Error('Unable to refresh internal auth token');
        }
        response = await sendRequest(token);
      }

      if (!response.ok) {
        let detail: any = null;
        try {
          detail = await response.json();
        } catch {}
        const err = new Error(detail?.message || detail?.error || `reaction failed (${response.status})`);
        (err as any).status = response.status;
        throw err;
      }

      let data: any = null;
      try {
        data = await response.json();
      } catch {}

      const updatedUsers = Array.isArray(data?.updatedUsers) ? (data.updatedUsers as string[]) : [];

      logger.debug('✅ Reaction updated via backend:', {
        messageId,
        reactionType,
        userEmail: normalizedUser,
        updatedUsersCount: updatedUsers.length,
      });

      return updatedUsers;
    } catch (error) {
      logger.error('❌ Error toggling message reaction:', error);
      throw error;
    }
  }
}

export const chatService = new ChatService();