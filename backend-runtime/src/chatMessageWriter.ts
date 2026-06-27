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

async function resolveRecipientDeviceReceiptState(
  tenantId: string,
  recipientEmail: string,
  partnerEmail: string
): Promise<{
  hasOnlineDevice: boolean;
  hasFocusedChatDevice: boolean;
  onlineDeviceCount: number;
  focusedChatDeviceCount: number;
}> {
  ensureFirebase();
  const db = admin.firestore();
  const normalizedRecipient = normalizeEmail(recipientEmail);
  const normalizedPartner = normalizeEmail(partnerEmail);
  if (!normalizedRecipient || !normalizedPartner) {
    return {
      hasOnlineDevice: false,
      hasFocusedChatDevice: false,
      onlineDeviceCount: 0,
      focusedChatDeviceCount: 0,
    };
  }

  const devicesSnap = await db
    .collection('user_devices')
    .doc(normalizedRecipient)
    .collection('devices')
    .get();

  const nowMs = Date.now();
  let onlineDeviceCount = 0;
  let focusedChatDeviceCount = 0;

  for (const doc of devicesSnap.docs) {
    const data = (doc.data() || {}) as Record<string, any>;
    if (isOnlineTenantDevice(data, tenantId, nowMs)) {
      onlineDeviceCount += 1;
    }
    if (isFocusedChatTenantDevice(data, tenantId, normalizedPartner, nowMs)) {
      focusedChatDeviceCount += 1;
    }
  }

  return {
    hasOnlineDevice: onlineDeviceCount > 0,
    hasFocusedChatDevice: focusedChatDeviceCount > 0,
    onlineDeviceCount,
    focusedChatDeviceCount,
  };
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

  const result = await summaryRef.transaction((currentValue) => {
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
  const normalizedSender = normalizeEmail(raw.sender);
  const normalizedRecipient = normalizeEmail(raw.recipientId);

  const messageTenantId =
    typeof raw.tenantId === 'string'
      ? raw.tenantId
      : raw.tenantId === null
      ? null
      : undefined;

  const message: ChatMessageRecord = {
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

  const conversationRef = tenantChatRootRef(db, tenantId).child('conversationMessages').child(conversationKey);
  const newMessageRef = conversationRef.push();
  const messageId = newMessageRef.key;
  if (!messageId) {
    throw new Error('Failed to allocate message id');
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
    delivered: Boolean(input.delivered),
    read: Boolean(input.read),
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

  const indexQuery = tenantChatRootRef(db, tenantId)
    .child('messageIndex')
    .orderByChild('recipientId')
    .equalTo(recipientEmail);
  const indexSnapshot = await indexQuery.get();
  if (!indexSnapshot.exists()) {
    return {
      deliveredMessageIds: [],
      deliveredCount: 0,
      recipientHasOnlineDevice: true,
    };
  }

  const candidates = indexSnapshot.val() as Record<string, Record<string, any>>;
  const deliveredMessageIds: string[] = [];

  for (const [messageId, record] of Object.entries(candidates)) {
    if (record?.delivered === true) {
      continue;
    }
    const context = await loadMessageContext(db, tenantId, messageId);
    if (!context || context.message.deleted || normalizeEmail(context.message.recipientId) !== recipientEmail) {
      continue;
    }
    const updated = await applyReceiptPatchToMessageContext(db, context, {
      markDelivered: true,
      deliveryProvenance: buildPresenceDeliveryProvenance(receiptState, new Date().toISOString()),
    });
    if (updated.delivered) {
      deliveredMessageIds.push(messageId);
    }
  }

  return {
    deliveredMessageIds,
    deliveredCount: deliveredMessageIds.length,
    recipientHasOnlineDevice: true,
  };
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
    const conversationSnapshot = await tenantChatRootRef(db, tenantId)
      .child('conversationMessages')
      .child(conversationKey)
      .get();
    if (conversationSnapshot.exists()) {
      conversationSnapshot.forEach((child) => {
        const raw = (child.val() || {}) as Record<string, any>;
        const messageId = child.key;
        if (!messageId) {
          return false;
        }
        if (normalizeEmail(raw.sender) !== partnerEmail) {
          return false;
        }
        if (normalizeEmail(raw.recipientId) !== actorEmail) {
          return false;
        }
        if (raw.deleted === true || raw.delivered === true) {
          return false;
        }
        deliveredTargets.add(messageId);
        return false;
      });
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
