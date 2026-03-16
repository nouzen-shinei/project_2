import { logger } from '@/lib/logger';
import { resolveChatUploadFolder, type ChatUploadParticipants } from '@/lib/chatUploadUtils';
import { sharedFileService } from '@/services/sharedFileService';
import { database, storage, auth } from '@/config/firebase';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { ref, push, set, get, onValue, onChildAdded, onChildChanged, off, query, orderByChild, child, update, endAt, limitToLast, runTransaction, equalTo } from 'firebase/database';
import { ref as storageRef, deleteObject } from 'firebase/storage';
type AuthServiceType = typeof import('../hooks/useAuthUnified').authService;
let __authService: AuthServiceType | null = null;
function getAuthService(): AuthServiceType {
  if (!__authService) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../hooks/useAuthUnified');
    __authService = mod.authService as AuthServiceType;
  }
  return __authService;
}
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { maybeShowStorageLimitReachedAlert } from './storageLimitAlert';
import { chatRealtimeStream, type ChatRealtimeCallbacks } from './chatRealtimeStream';
import { tenantService } from './tenantService';
import { runtimeEndpoints } from './runtimeEndpoints';

export interface FileAttachment {
  url: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  thumbnailUrl?: string;
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
    source?: string; // e.g., 'giphy', 'tenor'
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

  private async updateMessageIndexRecord(
    tenantId: string,
    messageId: string,
    patch: Partial<MessageIndexRecord>
  ): Promise<void> {
    if (!patch || Object.keys(patch).length === 0) {
      return;
    }
    await update(child(this.tenantMessageIndexRootRef(tenantId), messageId), {
      ...patch,
      lastUpdated: new Date().toISOString(),
    });
  }

  private async getMessageIndexRecord(tenantId: string, messageId: string): Promise<MessageIndexRecord | null> {
    const snapshot = await get(child(this.tenantMessageIndexRootRef(tenantId), messageId));
    if (!snapshot.exists()) {
      return null;
    }
    return snapshot.val() as MessageIndexRecord;
  }

  private async loadMessageById(
    messageId: string,
    tenantId: string
  ): Promise<{ message: ChatMessage; index: MessageIndexRecord } | null> {
    const indexRecord = await this.getMessageIndexRecord(tenantId, messageId);
    if (!indexRecord || !indexRecord.conversationKey) {
      logger.debug('🔍 Missing message index record while loading message', { messageId });
      return null;
    }

    const conversationRef = child(this.tenantConversationMessagesRef(tenantId, indexRecord.conversationKey), messageId);
    const convoSnapshot = await get(conversationRef);
    if (!convoSnapshot.exists()) {
      logger.warn('⚠️ Message index present but conversation record missing', {
        messageId,
        conversationKey: indexRecord.conversationKey,
      });
      return null;
    }

    const message = convoSnapshot.val() as ChatMessage;
    const hydrated: ChatMessage = {
      ...message,
      id: messageId,
      sender: this.normalizeEmail(message?.sender),
      recipientId: this.normalizeEmail(message?.recipientId) || undefined,
      conversationKey: indexRecord.conversationKey,
      tenantId: indexRecord.tenantId ?? message.tenantId,
      deliveryProvenance: normalizeChatDeliveryProvenance(message?.deliveryProvenance ?? indexRecord.deliveryProvenance),
    };

    return { message: hydrated, index: indexRecord };
  }

  private async applyConversationMessagePatch(
    messageId: string,
    message: ChatMessage,
    patch: Partial<ChatMessage>
  ): Promise<void> {
    const tenantId = typeof message.tenantId === 'string' ? message.tenantId : null;
    if (!tenantId) {
      throw new Error('Missing tenantId for chat patch write');
    }

    const normalizedSender = this.normalizeEmail(message.sender);
    const normalizedRecipient = this.normalizeEmail(message.recipientId);
    const conversationKey = message.conversationKey || this.getConversationKey(normalizedSender, normalizedRecipient);
    if (!conversationKey) {
      return;
    }

    await update(child(this.tenantConversationMessagesRef(tenantId, conversationKey), messageId), patch);

    const indexPatch: Partial<MessageIndexRecord> = {};
    if (patch.timestamp) {
      indexPatch.timestamp = patch.timestamp;
    }
    if (patch.delivered !== undefined) {
      indexPatch.delivered = patch.delivered;
    }
    if (patch.read !== undefined) {
      indexPatch.read = patch.read;
    }
    if (patch.deliveryProvenance !== undefined) {
      indexPatch.deliveryProvenance = normalizeChatDeliveryProvenance(patch.deliveryProvenance);
    }
    if (patch.isSpecial !== undefined) {
      indexPatch.isSpecial = patch.isSpecial;
    }
    if (patch.attachments || patch.fileUrl !== undefined) {
      indexPatch.hasAttachments = Boolean(
        (patch.attachments && patch.attachments.length > 0) ||
          patch.fileUrl !== undefined ||
          message.attachments?.length ||
          message.fileUrl
      );
    }
    if (Object.keys(indexPatch).length) {
      await this.updateMessageIndexRecord(tenantId, messageId, indexPatch);
    }

    await this.registerConversationForUsers(
      normalizedSender,
      normalizedRecipient,
      messageId,
      patch.timestamp ?? message.timestamp,
      tenantId
    );
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

  async rebuildConversationSummariesForUser(userEmail: string, tenantId?: string | null): Promise<void> {
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
    const summaryWrites: Array<Promise<void>> = [];

    for (const [conversationKey, entry] of Object.entries(conversationIndex)) {
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

    const pruneWrites: Array<Promise<void>> = [];
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
      const result: Record<string, ConversationSummary> = {};
      Object.values(raw).forEach((value: any) => {
        const summary = this.normalizeConversationSummaryRecord(value);
        if (summary) {
          result[summary.partnerEmail] = summary;
        }
      });

      return result;
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

    let detached: (() => void) | null = null;
    let cancelled = false;

    const attach = async () => {
      const resolvedTenantId = tenantId ? tenantId : await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);
      const userRef = this.tenantConversationSummariesRef(tenantScopeId, userKey);

      const listener = (snapshot: any) => {
        const raw = snapshot?.val() || {};
        const result: Record<string, ConversationSummary> = {};
        Object.values(raw).forEach((value: any) => {
          const summary = this.normalizeConversationSummaryRecord(value);
          if (summary) {
            result[summary.partnerEmail] = summary;
          }
        });
        callback(result);

        let payloadBytes = 0;
        try {
          payloadBytes = JSON.stringify(raw).length;
        } catch (error) {
          logger.debug('Failed to measure summary listener payload size', {
            error,
          });
        }

        logger.metric('chat.summary.listener_payload', {
          bytes: payloadBytes,
        });
      };

      onValue(userRef, listener);
      detached = () => {
        try {
          off(userRef, 'value', listener);
        } catch {}
      };
    };

    void attach().catch((error) => {
      if (!cancelled) {
        logger.warn('Failed to subscribe to conversation summaries', { error });
      }
    });

    return () => {
      cancelled = true;
      detached?.();
    };
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

  async uploadFile(
    uri: string,
    fileName: string,
    fileType: string,
    participants: ChatUploadParticipants,
    onProgress?: (progress: number) => void,
    options?: UploadSessionOptions
  ): Promise<{ url: string; size: number }> {
    try {
      const conversationFolder = resolveChatUploadFolder(participants);
      const sanitizedFileName = (fileName || 'file').replace(/[^a-zA-Z0-9.-]/g, '_') || 'file.bin';

      const baseUrl = this.requireChatBackendBaseUrl();

      const tenantId = await this.ensureTenantChatScope(participants.senderEmail || '', participants.recipientEmail);
      internalTokenManager.setBaseUrl(baseUrl);
      const token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        throw new Error('Authentication token missing. Please sign in again.');
      }

      const uploadUrl = new URL(`${baseUrl}/storage/upload`);
      uploadUrl.searchParams.set('tenantId', tenantId);
      uploadUrl.searchParams.set('purpose', 'chat');
      uploadUrl.searchParams.set('conversationFolder', conversationFolder);
      uploadUrl.searchParams.set('filename', sanitizedFileName);

      // Web: XHR for progress support
      if (Platform.OS === 'web') {
        const response = await fetch(uri);
        if (!response.ok) {
          throw new Error(`Failed to read file data from URI: ${uri}`);
        }
        const blob = await response.blob();

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
              if (!onProgress) return;
              if (!evt.lengthComputable) return;
              onProgress((evt.loaded / evt.total) * 100);
            };

            xhr.onerror = () => {
              if (cancelled) {
                reject(new ChatUploadCanceledError());
                return;
              }
              reject(new Error('upload_failed'));
            };

            xhr.onload = async () => {
              if (!xhr) return;
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
                  if (!onProgress) return;
                  if (!evt.lengthComputable) return;
                  onProgress((evt.loaded / evt.total) * 100);
                };
                xhr.onerror = () => reject(new Error('upload_failed'));
                xhr.onload = () => {
                  if (!xhr) return;
                  if (xhr.status !== 200) {
                    maybeShowMaintenanceAlertFromRaw(xhr.status, xhr.responseText || '');
                    if (xhr.status === 409) {
                      maybeShowStorageLimitReachedAlert(xhr.responseText, 'chatService.uploadFile(web retry)');
                    }
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
                      void sharedFileService.ensureSmartShareLink({ fileUrl: url, fileName: sanitizedFileName, fileType, fileSize: size, tenantId });
                    }
                    resolve({ url, size });
                  } catch (e) {
                    reject(e);
                  }
                };
                xhr.send(blob);
                return;
              }

              if (xhr.status !== 200) {
                maybeShowMaintenanceAlertFromRaw(xhr.status, xhr.responseText || '');
                if (xhr.status === 409) {
                  maybeShowStorageLimitReachedAlert(xhr.responseText, 'chatService.uploadFile(web)');
                }
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
                  void sharedFileService.ensureSmartShareLink({ fileUrl: url, fileName: sanitizedFileName, fileType, fileSize: size, tenantId });
                }
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
            if (onProgress && progressEvent.totalBytesExpectedToSend) {
              const progress = (progressEvent.totalBytesSent / progressEvent.totalBytesExpectedToSend) * 100;
              onProgress(Math.max(0, Math.min(100, progress)));
            }
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
        if (result.status === 409) {
          maybeShowStorageLimitReachedAlert(bodyText, 'chatService.uploadFile(native)');
        }
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
        void sharedFileService.ensureSmartShareLink({ fileUrl: finalUrl, fileName: sanitizedFileName, fileType, fileSize: finalSize, tenantId });
      }

      return { url: finalUrl, size: finalSize };
      
    } catch (error) {
      if (error instanceof ChatUploadCanceledError) {
        if (ChatService.ENABLE_CHAT_UPLOAD_DEBUG) {
          logger.info('Upload canceled by user');
        }
        throw error;
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

      if (onProgress) onProgress(0);

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

        return await new Promise<string>((resolve, reject) => {
          let retried = false;
          const sendOnce = async (authToken: string | null) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', uploadUrl.toString());
            xhr.setRequestHeader('Content-Type', blob.type || 'image/jpeg');
            if (authToken) {
              xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
            }
            xhr.upload.onprogress = (evt) => {
              if (!onProgress) return;
              if (!evt.lengthComputable) return;
              onProgress((evt.loaded / evt.total) * 100);
            };
            xhr.onerror = () => reject(new Error('upload_failed'));
            xhr.onload = async () => {
              if (xhr.status === 401 && !retried) {
                retried = true;
                try {
                  await internalTokenManager.forceRefresh(baseUrl);
                } catch {}
                const retryToken = await internalTokenManager.getToken(baseUrl);
                await sendOnce(retryToken ?? null);
                return;
              }
              if (xhr.status !== 200) {
                maybeShowMaintenanceAlertFromRaw(xhr.status, xhr.responseText || '');
                if (xhr.status === 409) {
                  reject(new Error(xhr.responseText || `upload_failed_${xhr.status}`));
                  maybeShowStorageLimitReachedAlert(xhr.responseText, 'chatService.uploadProfilePicture(web)');
                  return;
                }
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
                if (onProgress) onProgress(100);
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
            if (onProgress && progressEvent.totalBytesExpectedToSend) {
              const progress = (progressEvent.totalBytesSent / progressEvent.totalBytesExpectedToSend) * 100;
              onProgress(Math.max(0, Math.min(100, progress)));
            }
          }
        );
        return await task.uploadAsync();
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

      if (result.status !== 200) {
        const bodyText = typeof result.body === 'string' ? result.body : '';
        maybeShowMaintenanceAlertFromRaw(result.status, bodyText);
        if (result.status === 409) {
          maybeShowStorageLimitReachedAlert(bodyText, 'chatService.uploadProfilePicture(native)');
        }
        throw new Error(bodyText || `upload_failed_${result.status}`);
      }

      const parsed = JSON.parse((typeof result.body === 'string' ? result.body : '') || '{}');
      const finalUrl = String(parsed.url || '');
      if (!finalUrl) {
        throw new Error('upload_failed_missing_url');
      }
      if (onProgress) onProgress(100);
      return finalUrl;
    } catch (error) {
      logger.error('Error uploading profile picture:', error);
      throw error;
    }
  }

  async deleteProfilePicture(photoURL: string): Promise<void> {
    try {
      // Create storage reference from the URL
      const fileRef = storageRef(storage, photoURL);
      await deleteObject(fileRef);
      logger.debug('Profile picture deleted successfully from storage');
    } catch (error) {
      logger.error('Error deleting profile picture:', error);
      throw error;
    }
  }

  async sendMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>): Promise<string> {
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
        timestamp,
        conversationKey,
        tenantId,
        delivered: Boolean(message.delivered),
        read: Boolean(message.read),
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
    if (!tenantId) {
      throw new Error('Unable to determine coaching center for this chat message.');
    }

    const payload = this.pruneUndefined<{ [key: string]: unknown }>({
      recipientId: normalizedRecipient,
      tenantId,
      text: message.text,
      isSpecial: message.isSpecial,
      fileUrl: message.fileUrl,
      fileName: message.fileName,
      fileType: message.fileType,
      fileSize: message.fileSize,
      thumbnailUrl: message.thumbnailUrl,
      attachments: message.attachments,
      sticker: message.sticker,
      gif: message.gif,
      delivered: message.delivered,
      read: message.read,
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
    options?: UploadSessionOptions
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
        text: text || `Sent ${fileType.includes('image') ? 'an image' : 'a file'}`,
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
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
    files: Array<{
      uri: string;
      fileName: string;
      fileType: string;
      fileSize?: number;
    }>,
    sender: string,
    recipientId?: string,
    onProgress?: (progress: number) => void,
    options?: UploadSessionOptions
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

      let totalProgress = 0;
      const fileProgressMap = new Map<number, number>();
      
      // Function to update overall progress
      const updateOverallProgress = () => {
        const avgProgress = Array.from(fileProgressMap.values()).reduce((sum, progress) => sum + progress, 0) / files.length;
        if (onProgress) {
          onProgress(avgProgress);
        }
      };

      const cancelFns: Array<(() => void | Promise<void>) | undefined> = [];
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

      // Upload all files with individual progress tracking
      const uploadPromises = files.map((file, index) =>
        this.uploadFile(
          file.uri,
          file.fileName,
          file.fileType,
          { senderEmail: sender, recipientEmail: recipientId },
          (progress: number) => {
            fileProgressMap.set(index, progress);
            updateOverallProgress();
          },
          {
            registerCancel: (fn: () => void | Promise<void>) => {
              cancelFns[index] = fn;
            },
          }
        )
      );
      
      const uploadResults = await Promise.all(uploadPromises);
      
      // Create attachments array
      const attachments: FileAttachment[] = files.map((file, index) => ({
        url: uploadResults[index].url,
        fileName: file.fileName,
        fileType: file.fileType,
        fileSize: uploadResults[index].size,
      }));

      // Generate appropriate message text if none provided
      let messageText = text;
      if (!messageText.trim()) {
        if (files.length === 1) {
          const file = files[0];
          messageText = `Sent ${file.fileType.includes('image') ? 'an image' : file.fileType.includes('video') ? 'a video' : 'a file'}`;
        } else {
          const imageCount = files.filter(f => f.fileType.includes('image')).length;
          const videoCount = files.filter(f => f.fileType.includes('video')).length;
          const docCount = files.length - imageCount - videoCount;
          
          const parts = [];
          if (imageCount > 0) parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
          if (videoCount > 0) parts.push(`${videoCount} video${videoCount > 1 ? 's' : ''}`);
          if (docCount > 0) parts.push(`${docCount} file${docCount > 1 ? 's' : ''}`);
          
          messageText = `Sent ${parts.join(', ')}`;
        }
      }
      
      // Send message with attachments
      return this.sendMessage({
        text: messageText,
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
        attachments,
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
    recipientId?: string
  ): Promise<string> {
    try {
      return this.sendMessage({
  text: '', // No attached text for sticker messages
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
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
    recipientId?: string
  ): Promise<string> {
    try {
      return this.sendMessage({
  text: '', // No attached text for GIF messages
        sender: sender.toLowerCase(),
        recipientId: recipientId?.toLowerCase(),
        isSpecial: false,
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

  async getAllMessages(): Promise<ChatMessage[]> {
    try {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const snapshot = await get(this.tenantMessageIndexRootRef(tenantScopeId));
      if (!snapshot.exists()) {
        return [];
      }

      const indexEntries = snapshot.val() as Record<string, MessageIndexRecord>;
      const resolvedMessages = await Promise.all(
        Object.keys(indexEntries).map(async (messageId) => {
          const record = await this.loadMessageById(messageId, tenantScopeId);
          return record?.message ?? null;
        })
      );

      const messages = resolvedMessages.filter((msg): msg is ChatMessage => Boolean(msg));
      messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      logger.metric('chat.fetchAllMessages', { count: messages.length });
      return messages;
    } catch (error) {
      logger.error('Error getting messages:', error);
      throw error;
    }
  }

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

    let detached: (() => void) | null = null;
    let cancelled = false;

    const attach = async () => {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const recipientQuery = query(
        this.tenantMessageIndexRootRef(tenantScopeId),
        orderByChild('recipientId'),
        equalTo(normalizedRecipient)
      );

      const listener = async (snapshot: any) => {
        if (!snapshot.exists()) {
          callback([]);
          return;
        }

        const indexEntries = snapshot.val() as Record<string, MessageIndexRecord>;
        const messages = Object.entries(indexEntries).map(([messageId, record]) => ({
          id: messageId,
          sender: record.sender,
          recipientId: record.recipientId || undefined,
          text: '',
          timestamp: record.timestamp,
          isSpecial: Boolean(record.isSpecial),
          delivered: Boolean(record.delivered),
          read: Boolean(record.read),
          conversationKey: record.conversationKey,
          tenantId: record.tenantId ?? tenantScopeId,
        })) as ChatMessage[];

        logger.metric('chat.listener.userIndex', {
          recipient: normalizedRecipient,
          count: messages.length,
        });

        callback(messages);
      };

      onValue(recipientQuery, listener);
      detached = () => {
        try {
          off(recipientQuery, 'value', listener);
        } catch {}
      };
    };

    void attach().catch((error) => {
      if (!cancelled) {
        logger.warn('Failed to subscribe to message index', { error });
      }
      callback([]);
    });

    return () => {
      cancelled = true;
      detached?.();
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

  // Mark message as delivered (double tick)
  async markMessageAsDelivered(messageId: string): Promise<void> {
    try {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const record = await this.loadMessageById(messageId, tenantScopeId);
      if (!record) {
        return;
      }

      const { message } = record;
      if (message.delivered) {
        return;
      }

      const deliveredAt = new Date().toISOString();
      await this.applyConversationMessagePatch(messageId, message, {
        delivered: true,
        deliveredAt,
      });

      await this.applySummaryUpdatesForMessage(
        messageId,
        { ...message, delivered: true, deliveredAt },
        { updateIfSameMessageId: true }
      );

      logger.metric('chat.message.delivered', {
        conversationKey: message.conversationKey,
      });
    } catch (error) {
      logger.error('Error marking message as delivered:', error);
      throw error;
    }
  }

  // Mark message as read (blue tick)
  async markMessageAsRead(messageId: string): Promise<void> {
    try {
      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const record = await this.loadMessageById(messageId, tenantScopeId);
      if (!record) {
        return;
      }

      const { message } = record;
      if (message.read) {
        return;
      }

      const readAt = new Date().toISOString();
      const deliveredAt = message.deliveredAt ?? readAt;

      await this.applyConversationMessagePatch(messageId, message, {
        read: true,
        readAt,
        delivered: true,
        deliveredAt,
      });

      await this.applySummaryUpdatesForMessage(
        messageId,
        { ...message, read: true, readAt, delivered: true, deliveredAt },
        {
          recipientUnreadStrategy: 'decrement',
          recipientUnreadAmount: 1,
          updateIfSameMessageId: true,
        }
      );
      logger.metric('chat.message.read', {
        conversationKey: message.conversationKey,
      });
    } catch (error) {
      logger.error('Error marking message as read:', error);
      throw error;
    }
  }

  // Mark multiple messages as delivered
  async markMessagesAsDelivered(messageIds: string[]): Promise<void> {
    try {
      if (!messageIds.length) {
        return;
      }

      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const records = await Promise.all(messageIds.map((id) => this.loadMessageById(id, tenantScopeId)));
      const pending = records
        .map((record, index) => (record ? { id: messageIds[index], message: record.message } : null))
        .filter((entry): entry is { id: string; message: ChatMessage } => Boolean(entry && !entry.message.delivered));
      if (!pending.length) {
        return;
      }

      const deliveredAt = new Date().toISOString();

      await Promise.all(
        pending.map(({ id, message }) =>
          this.applyConversationMessagePatch(id, message, {
            delivered: true,
            deliveredAt,
          })
        )
      );

      await Promise.all(
        pending.map(({ id, message }) =>
          this.applySummaryUpdatesForMessage(
            id,
            { ...message, delivered: true, deliveredAt },
            { updateIfSameMessageId: true }
          )
        )
      );

      logger.debug('✓✓ Batch delivered:', pending.length, 'messages');
    } catch (error) {
      logger.error('Error marking messages as delivered:', error);
      throw error;
    }
  }

  // Mark multiple messages as read
  async markMessagesAsRead(messageIds: string[]): Promise<void> {
    try {
      if (!messageIds.length) {
        return;
      }

      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const records = await Promise.all(messageIds.map((id) => this.loadMessageById(id, tenantScopeId)));
      const pending = records
        .map((record, index) => (record ? { id: messageIds[index], message: record.message } : null))
        .filter((entry): entry is { id: string; message: ChatMessage } => Boolean(entry && !entry.message.read));
      if (!pending.length) {
        return;
      }

      const readAt = new Date().toISOString();

      await Promise.all(
        pending.map(({ id, message }) =>
          this.applyConversationMessagePatch(id, message, {
            read: true,
            readAt,
            delivered: true,
            deliveredAt: message.deliveredAt ?? readAt,
          })
        )
      );

      await Promise.all(
        pending.map(({ id, message }) =>
          this.applySummaryUpdatesForMessage(
            id,
            {
              ...message,
              read: true,
              readAt,
              delivered: true,
              deliveredAt: message.deliveredAt ?? readAt,
            },
            {
              recipientUnreadStrategy: 'decrement',
              recipientUnreadAmount: 1,
              updateIfSameMessageId: true,
            }
          )
        )
      );

      logger.debug('👁️ Batch read:', pending.length, 'messages');
    } catch (error) {
      logger.error('Error marking messages as read:', error);
      throw error;
    }
  }

  // Get undelivered messages for a user
  async getUndeliveredMessages(recipientEmail: string): Promise<ChatMessage[]> {
    try {
      const normalizedRecipient = this.normalizeEmail(recipientEmail);
      if (!normalizedRecipient) {
        return [];
      }

      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const recipientQuery = query(
        this.tenantMessageIndexRootRef(tenantScopeId),
        orderByChild('recipientId'),
        equalTo(normalizedRecipient)
      );
      const snapshot = await get(recipientQuery);
      if (!snapshot.exists()) {
        return [];
      }

      const indexEntries = snapshot.val() as Record<string, MessageIndexRecord>;
      const pendingIds = Object.entries(indexEntries)
        .filter(([, record]) => !record.delivered)
        .map(([messageId]) => messageId);

      const resolved = await Promise.all(pendingIds.map((id) => this.loadMessageById(id, tenantScopeId)));
      const messages = resolved
        .map((record) => record?.message ?? null)
        .filter((msg): msg is ChatMessage => Boolean(msg));

      return messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    } catch (error) {
      logger.error('Error getting undelivered messages:', error);
      return [];
    }
  }

  // Get unread messages for a user
  async getUnreadMessages(recipientEmail: string): Promise<ChatMessage[]> {
    try {
      const normalizedRecipient = this.normalizeEmail(recipientEmail);
      if (!normalizedRecipient) {
        return [];
      }

      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const recipientQuery = query(
        this.tenantMessageIndexRootRef(tenantScopeId),
        orderByChild('recipientId'),
        equalTo(normalizedRecipient)
      );
      const snapshot = await get(recipientQuery);
      if (!snapshot.exists()) {
        return [];
      }

      const indexEntries = snapshot.val() as Record<string, MessageIndexRecord>;
      const pendingIds = Object.entries(indexEntries)
        .filter(([, record]) => !record.read)
        .map(([messageId]) => messageId);

      const resolved = await Promise.all(pendingIds.map((id) => this.loadMessageById(id, tenantScopeId)));
      const messages = resolved
        .map((record) => record?.message ?? null)
        .filter((msg): msg is ChatMessage => Boolean(msg));

      return messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    } catch (error) {
      logger.error('Error getting unread messages:', error);
      return [];
    }
  }

  // Mark messages as delivered when recipient comes online
  async markPendingMessagesAsDelivered(recipientEmail: string): Promise<number> {
    try {
      const normalizedRecipient = this.normalizeEmail(recipientEmail);
      if (!normalizedRecipient) {
        return 0;
      }

      const resolvedTenantId = await tenantService.getCachedSelectedTenant();
      const tenantScopeId = this.requireTenantId(resolvedTenantId);

      const recipientQuery = query(
        this.tenantMessageIndexRootRef(tenantScopeId),
        orderByChild('recipientId'),
        equalTo(normalizedRecipient)
      );
      const snapshot = await get(recipientQuery);
      if (!snapshot.exists()) {
        return 0;
      }

      const indexEntries = snapshot.val() as Record<string, MessageIndexRecord>;
      const messagesToDeliver = Object.entries(indexEntries)
        .filter(([, record]) => !record.delivered && record.timestamp)
        .map(([messageId]) => messageId);

      if (messagesToDeliver.length > 0) {
        logger.debug('📨 Marking pending messages as delivered for online user:', {
          recipient: recipientEmail,
          messageCount: messagesToDeliver.length
        });
        
        await this.markMessagesAsDelivered(messagesToDeliver);
        return messagesToDeliver.length;
      }

      return 0;
    } catch (error) {
      logger.error('Error marking pending messages as delivered:', error);
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
        if (this.normalizeEmail(data.recipientId) === me && this.normalizeEmail(data.sender) === them && !data.read) {
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

  // Listen for message status changes for real-time updates
  onMessageStatusChange(userEmail: string, callback: () => void): () => void {
    try {
      logger.debug('🔄 Setting up message status listener for user:', userEmail);
      
      // Use a more targeted approach - listen for changes to messages
      // We'll throttle the callback to avoid too many refreshes
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const normalizedUser = this.normalizeEmail(userEmail);
      if (!normalizedUser) {
        return () => {};
      }

      let detached: (() => void) | null = null;
      let cancelled = false;

      const attach = async () => {
        const resolvedTenantId = await tenantService.getCachedSelectedTenant();
        const tenantScopeId = this.requireTenantId(resolvedTenantId);

        const queries = [
          query(this.tenantMessageIndexRootRef(tenantScopeId), orderByChild('recipientId'), equalTo(normalizedUser)),
          query(this.tenantMessageIndexRootRef(tenantScopeId), orderByChild('sender'), equalTo(normalizedUser)),
        ];

        const listeners = queries.map((q) =>
          onValue(q, (snapshot) => {
            if (!snapshot.exists()) {
              return;
            }
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            timeoutId = setTimeout(() => {
              logger.metric('chat.listener.statusTick', {
                user: normalizedUser,
                buckets: queries.length,
              });
              callback();
              timeoutId = null;
            }, 2000);
          })
        );

        detached = () => {
          logger.debug('🔄 Cleaning up message status listener');
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          listeners.forEach((listener, index) => {
            try {
              off(queries[index], 'value', listener);
            } catch (error) {
              logger.debug('Failed to remove status listener', { error });
            }
          });
        };
      };

      void attach().catch((error) => {
        if (!cancelled) {
          logger.warn('Failed to subscribe to message status changes', { error });
        }
      });

      return () => {
        cancelled = true;
        detached?.();
      };
    } catch (error) {
      logger.error('Error setting up message status listener:', error);
      return () => {}; // Return empty cleanup function
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