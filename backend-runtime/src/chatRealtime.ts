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
}

const MAX_SHARED_WATCH_CACHE_ENTRIES = 1200;

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

function trimWatchCaches(
  knownMessageIds: Set<string>,
  messageCache: Map<string, ChatMessagePayload>
): void {
  if (messageCache.size <= MAX_SHARED_WATCH_CACHE_ENTRIES) {
    return;
  }

  while (messageCache.size > MAX_SHARED_WATCH_CACHE_ENTRIES) {
    const oldestEntry = messageCache.keys().next();
    if (oldestEntry.done || typeof oldestEntry.value !== 'string') {
      break;
    }

    const oldestMessageId = oldestEntry.value;
    messageCache.delete(oldestMessageId);
    knownMessageIds.delete(oldestMessageId);
  }
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

  if (!watch) {
    const db = admin.database();
    const conversationRef = db
      .ref('tenantChat')
      .child(normalizedTenantId)
      .child('conversationMessages')
      .child(normalizedConversationKey);

    const knownMessageIds = new Set<string>();
    const messageCache = new Map<string, ChatMessagePayload>();

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
        messageCache.set(snapshot.key, payload);
        trimWatchCaches(knownMessageIds, messageCache);
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

        const previous = messageCache.get(snapshot.key);
        messageCache.set(snapshot.key, payload);
          trimWatchCaches(knownMessageIds, messageCache);

        const statusChanged =
          !previous ||
          previous.delivered !== payload.delivered ||
          previous.read !== payload.read ||
          previous.deliveredAt !== payload.deliveredAt ||
          previous.readAt !== payload.readAt;

        if (statusChanged) {
          const statusPayload = deriveStatusPayload(snapshot);
          if (statusPayload) {
            broadcast(watchKey, (subscriber) => subscriber.onStatus?.(statusPayload));
          }
        }

        if (didMessageContentChange(previous, payload)) {
          broadcast(watchKey, (subscriber) => subscriber.onMessageUpdate?.(payload));
        }

        if (payload.deleted && !previous?.deleted) {
          broadcast(watchKey, (subscriber) => subscriber.onMessageDelete?.(payload));
        }
      },
    };

    watch = {
      subscribers: new Map<number, ConversationWatcherHandlers>(),
      nextSubscriberId: 1,
      cleanupFirebase: null,
      initPromise: Promise.resolve(),
    };

    watch.initPromise = (async () => {
      const initialSnapshot = await conversationRef.once('value');
      initialSnapshot.forEach((child) => {
        if (child.key) {
          knownMessageIds.add(child.key);
          const payload = normalizeSnapshot(child, normalizedConversationKey);
          if (payload) {
            messageCache.set(child.key, payload);
            trimWatchCaches(knownMessageIds, messageCache);
          }
        }
        return false;
      });

      conversationRef.on('child_added', listeners.messageListener);
      conversationRef.on('child_changed', listeners.changeListener);

      watch!.cleanupFirebase = () => {
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
      sharedConversationWatches.delete(watchKey);
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
      current.cleanupFirebase?.();
      sharedConversationWatches.delete(watchKey);
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

function didMessageContentChange(
  previous: ChatMessagePayload | undefined,
  next: ChatMessagePayload
): boolean {
  if (!previous) {
    return true;
  }

  return (
    buildChatRealtimeMessageContentSignature(previous) !==
    buildChatRealtimeMessageContentSignature(next)
  );
}
