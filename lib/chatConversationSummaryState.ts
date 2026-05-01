export type ChatConversationSummaryMessageType =
  | 'text'
  | 'sticker'
  | 'gif'
  | 'attachment'
  | 'special'
  | 'unknown';

export interface ChatConversationSummaryLastMessage {
  messageId: string;
  text: string;
  timestamp: string;
  sender: string;
  isOwnMessage: boolean;
  delivered: boolean;
  read: boolean;
  type: ChatConversationSummaryMessageType;
  attachmentCount?: number;
  editedAt?: string;
  editCount?: number;
  deleted: boolean;
  deletedAt?: string;
  deletedBy?: string;
  isSpecial: boolean;
}

export interface ChatConversationSummary {
  partnerEmail: string;
  partnerId: string;
  partnerName: string | null;
  tenantId: string | null;
  unreadCount: number;
  updatedAt: string;
  lastMessage?: ChatConversationSummaryLastMessage;
}

export interface ChatConversationSummaryInput {
  displayedMessages: any[];
  partnerEmail?: string | null;
  partnerId?: string | null;
  partnerName?: string | null;
  tenantId?: string | null;
  userEmail?: string | null;
  incomingUnreadCount: number;
  isFocused: boolean;
  isAppActive: boolean;
}

function toIsoString(value: any): string {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

function resolveMessagePreview(msg: any): {
  text: string;
  type: ChatConversationSummaryMessageType;
} {
  if (!msg) {
    return { text: '', type: 'unknown' };
  }

  if (msg.deleted) {
    return { text: 'Message removed', type: 'text' };
  }

  if (msg.isSpecial) {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    return { text: text || 'Special message', type: 'special' };
  }

  if (msg.sticker) {
    return { text: 'Sticker', type: 'sticker' };
  }

  if (msg.gif) {
    return { text: 'GIF', type: 'gif' };
  }

  if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
    return { text: '📎 Attachment', type: 'attachment' };
  }

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  return { text: text || '📎 Attachment', type: 'text' };
}

export function resolveChatLiveConversationSummary(
  input: ChatConversationSummaryInput
): ChatConversationSummary | null {
  const partnerEmail =
    typeof input.partnerEmail === 'string'
      ? input.partnerEmail.trim().toLowerCase()
      : '';
  const userEmail =
    typeof input.userEmail === 'string' ? input.userEmail.trim().toLowerCase() : '';

  if (
    !partnerEmail ||
    !userEmail ||
    !Array.isArray(input.displayedMessages) ||
    input.displayedMessages.length === 0
  ) {
    return null;
  }

  let latestMessage: any = null;
  for (let index = input.displayedMessages.length - 1; index >= 0; index -= 1) {
    const candidate = input.displayedMessages[index];
    if (candidate?.id) {
      latestMessage = candidate;
      break;
    }
  }

  const effectiveUnread =
    input.isFocused && input.isAppActive
      ? 0
      : Math.max(0, Math.trunc(Number(input.incomingUnreadCount || 0)));

  const timestamp = toIsoString(latestMessage?.timestamp);
  const preview = resolveMessagePreview(latestMessage);
  const isOwnMessage = String(latestMessage?.sender || '').toLowerCase() === userEmail;

  return {
    partnerEmail,
    partnerId: String(input.partnerId || partnerEmail),
    partnerName:
      typeof input.partnerName === 'string' && input.partnerName.length > 0
        ? input.partnerName
        : null,
    tenantId: typeof input.tenantId === 'string' ? input.tenantId : null,
    unreadCount: effectiveUnread,
    updatedAt: timestamp,
    lastMessage: latestMessage
      ? {
          messageId: String(latestMessage.id),
          text: preview.text,
          timestamp,
          sender: String(latestMessage.sender || ''),
          isOwnMessage,
          delivered: Boolean(latestMessage.delivered),
          read: Boolean(latestMessage.read),
          type: preview.type,
          attachmentCount: Array.isArray(latestMessage.attachments)
            ? latestMessage.attachments.length
            : undefined,
          editedAt: latestMessage.editedAt
            ? String(latestMessage.editedAt)
            : undefined,
          editCount:
            typeof latestMessage.editCount === 'number'
              ? latestMessage.editCount
              : undefined,
          deleted: Boolean(latestMessage.deleted),
          deletedAt: latestMessage.deletedAt
            ? String(latestMessage.deletedAt)
            : undefined,
          deletedBy: latestMessage.deletedBy
            ? String(latestMessage.deletedBy)
            : undefined,
          isSpecial: Boolean(latestMessage.isSpecial),
        }
      : undefined,
  };
}
