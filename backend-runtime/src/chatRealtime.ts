import crypto from 'crypto';
import * as admin from 'firebase-admin';
import { ensureFirebase } from './firebaseAdmin';

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
  const recipientId = normalizeEmail(raw.recipientId);
  const payload: ChatMessagePayload = {
    id: snapshot.key,
    text: typeof raw.text === 'string' ? raw.text : undefined,
    sender,
    recipientId: recipientId || undefined,
    timestamp: raw.timestamp,
    isSpecial: Boolean(raw.isSpecial),
    conversationKey,
    tenantId: typeof raw.tenantId === 'string' ? raw.tenantId : undefined,
    fileUrl: raw.fileUrl,
    fileName: raw.fileName,
    fileType: raw.fileType,
    fileSize: typeof raw.fileSize === 'number' ? raw.fileSize : undefined,
    thumbnailUrl: raw.thumbnailUrl,
    attachments: Array.isArray(raw.attachments) ? raw.attachments : undefined,
    sticker: raw.sticker,
    gif: raw.gif,
    delivered: raw.delivered,
    read: raw.read,
    deliveredAt: raw.deliveredAt,
    readAt: raw.readAt,
    editedAt: typeof raw.editedAt === 'string' ? raw.editedAt : undefined,
    editCount: typeof raw.editCount === 'number' ? raw.editCount : undefined,
    deleted: Boolean(raw.deleted),
    deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : undefined,
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
  if (raw.delivered !== undefined) {
    payload.delivered = Boolean(raw.delivered);
  }
  if (raw.read !== undefined) {
    payload.read = Boolean(raw.read);
  }
  if (raw.deliveredAt) {
    payload.deliveredAt = raw.deliveredAt;
  }
  if (raw.readAt) {
    payload.readAt = raw.readAt;
  }
  return payload;
}

export async function watchConversationRealtime(
  tenantId: string,
  conversationKey: string,
  handlers: ConversationWatcherHandlers
): Promise<() => void> {
  ensureFirebase();
  const db = admin.database();
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!normalizedTenantId) {
    throw new Error('Missing tenantId for watchConversationRealtime');
  }
  const conversationRef = db
    .ref('tenantChat')
    .child(normalizedTenantId)
    .child('conversationMessages')
    .child(conversationKey);
  const knownMessageIds = new Set<string>();
  const messageCache = new Map<string, ChatMessagePayload>();

  const initialSnapshot = await conversationRef.once('value');
  initialSnapshot.forEach((child) => {
    if (child.key) {
      knownMessageIds.add(child.key);
      const payload = normalizeSnapshot(child, conversationKey);
      if (payload) {
        messageCache.set(child.key, payload);
      }
    }
    return false;
  });

  const messageListener = (snapshot: admin.database.DataSnapshot) => {
    if (!snapshot.key) {
      return;
    }
    if (knownMessageIds.has(snapshot.key)) {
      return;
    }
    knownMessageIds.add(snapshot.key);
    const payload = normalizeSnapshot(snapshot, conversationKey);
    if (payload) {
      messageCache.set(snapshot.key, payload);
      handlers.onMessage?.(payload);
    }
  };

  const changeListener = (snapshot: admin.database.DataSnapshot) => {
    if (!snapshot.key) {
      return;
    }

    const payload = normalizeSnapshot(snapshot, conversationKey);
    if (!payload) {
      return;
    }

    const previous = messageCache.get(snapshot.key);
    messageCache.set(snapshot.key, payload);

    const statusChanged =
      !previous ||
      previous.delivered !== payload.delivered ||
      previous.read !== payload.read ||
      previous.deliveredAt !== payload.deliveredAt ||
      previous.readAt !== payload.readAt;

    if (statusChanged) {
      const statusPayload = deriveStatusPayload(snapshot);
      if (statusPayload) {
        handlers.onStatus?.(statusPayload);
      }
    }

    if (didMessageContentChange(previous, payload)) {
      handlers.onMessageUpdate?.(payload);
    }

    if (payload.deleted && !previous?.deleted) {
      handlers.onMessageDelete?.(payload);
    }
  };

  conversationRef.on('child_added', messageListener);
  conversationRef.on('child_changed', changeListener);

  return () => {
    conversationRef.off('child_added', messageListener);
    conversationRef.off('child_changed', changeListener);
  };
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function didMessageContentChange(
  previous: ChatMessagePayload | undefined,
  next: ChatMessagePayload
): boolean {
  if (!previous) {
    return true;
  }

  const signature = (payload: ChatMessagePayload) =>
    [
      payload.text || '',
      payload.fileUrl || '',
      payload.fileName || '',
      payload.fileType || '',
      typeof payload.fileSize === 'number' ? payload.fileSize : '',
      payload.thumbnailUrl || '',
      payload.isSpecial ? '1' : '0',
      payload.editedAt || '',
      payload.deleted ? '1' : '0',
      payload.deletedAt || '',
      payload.deletedBy || '',
      stableStringify(payload.attachments || []),
      stableStringify(payload.sticker || null),
      stableStringify(payload.gif || null),
    ].join('|');

  return signature(previous) !== signature(next);
}
