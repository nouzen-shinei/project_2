import type { ChatReplyContext } from '../services/chatService';

export interface ChatReplyContextMessageLike {
  id?: unknown;
  sender?: unknown;
  senderName?: unknown;
  text?: unknown;
  isSpecial?: unknown;
  attachments?: unknown;
  fileUrl?: unknown;
  sticker?: unknown;
  gif?: unknown;
  deleted?: unknown;
}

export interface ChatReplyContextStateInput {
  targetMessage: ChatReplyContextMessageLike;
  effectiveUserEmail?: string | null;
  selectedMemberEmail?: string | null;
  selectedMemberName?: string | null;
  maxPreviewLength?: number;
}

function normalizeChatReplyContextName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeChatReplyContextEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

function normalizeChatReplyContextText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function resolveChatReplyContextPreviewText(input: {
  text?: unknown;
  isSpecial?: unknown;
  hasAttachments?: unknown;
  attachmentCount?: unknown;
  hasSticker?: unknown;
  hasGif?: unknown;
  maxLength?: number;
}): string {
  const normalizedText = normalizeChatReplyContextText(input.text);
  if (normalizedText) {
    const safeMaxLength = Number.isFinite(input.maxLength) && (input.maxLength ?? 0) > 8
      ? Math.trunc(input.maxLength as number)
      : 120;

    if (normalizedText.length <= safeMaxLength) {
      return normalizedText;
    }

    return `${normalizedText.slice(0, safeMaxLength - 1)}…`;
  }

  if (input.isSpecial === true) {
    return 'Special message';
  }

  if (input.hasGif === true) {
    return 'GIF';
  }

  if (input.hasSticker === true) {
    return 'Sticker';
  }

  const attachmentCountCandidate = Number(input.attachmentCount);
  const attachmentCount = Number.isFinite(attachmentCountCandidate) && attachmentCountCandidate > 0
    ? Math.trunc(attachmentCountCandidate)
    : 0;
  const effectiveAttachmentCount = attachmentCount > 0
    ? attachmentCount
    : input.hasAttachments === true
      ? 1
      : 0;

  if (effectiveAttachmentCount > 1) {
    return `${effectiveAttachmentCount} attachments`;
  }

  if (effectiveAttachmentCount === 1) {
    return 'Attachment';
  }

  return 'Message';
}

export function resolveChatReplySenderLabel(input?: {
  sender?: unknown;
  senderName?: unknown;
  effectiveUserEmail?: string | null;
  selectedMemberEmail?: string | null;
  selectedMemberName?: string | null;
}): string {
  if (!input) {
    return 'Message';
  }

  const explicitName = normalizeChatReplyContextName(input.senderName);
  if (explicitName) {
    return explicitName;
  }

  const sender = normalizeChatReplyContextEmail(input.sender);
  if (!sender) {
    return 'Message';
  }

  const effectiveUserEmail = normalizeChatReplyContextEmail(input.effectiveUserEmail);
  if (effectiveUserEmail && sender === effectiveUserEmail) {
    return 'You';
  }

  const selectedEmail = normalizeChatReplyContextEmail(input.selectedMemberEmail);
  if (selectedEmail && sender === selectedEmail) {
    const selectedName = normalizeChatReplyContextName(input.selectedMemberName);
    return selectedName || 'Them';
  }

  return sender;
}

export function resolveChatReplyContextFromMessage(
  input: ChatReplyContextStateInput
): ChatReplyContext | null {
  const targetMessage = input?.targetMessage;
  if (!targetMessage || targetMessage.deleted === true) {
    return null;
  }

  const messageId = normalizeChatReplyContextText(targetMessage.id);
  if (!messageId) {
    return null;
  }

  const sender = normalizeChatReplyContextEmail(targetMessage.sender);
  if (!sender) {
    return null;
  }

  const attachmentCount = Array.isArray(targetMessage.attachments)
    ? targetMessage.attachments.length
    : 0;
  const hasAttachments = attachmentCount > 0 || Boolean(targetMessage.fileUrl);
  const hasSticker = Boolean(targetMessage.sticker);
  const hasGif = Boolean(targetMessage.gif);
  const previewText = resolveChatReplyContextPreviewText({
    text: typeof targetMessage.text === 'string' ? targetMessage.text : '',
    isSpecial: targetMessage.isSpecial === true,
    hasAttachments,
    attachmentCount: hasAttachments ? Math.max(1, attachmentCount) : undefined,
    hasSticker,
    hasGif,
    maxLength: input.maxPreviewLength,
  });

  return {
    messageId,
    sender,
    senderName: resolveChatReplySenderLabel({
      sender: targetMessage.sender,
      senderName: targetMessage.senderName,
      effectiveUserEmail: input.effectiveUserEmail,
      selectedMemberEmail: input.selectedMemberEmail,
      selectedMemberName: input.selectedMemberName,
    }) || undefined,
    text: previewText || undefined,
    isSpecial: targetMessage.isSpecial === true ? true : undefined,
    hasAttachments: hasAttachments ? true : undefined,
    attachmentCount: hasAttachments ? Math.max(1, attachmentCount) : undefined,
    hasSticker: hasSticker ? true : undefined,
    hasGif: hasGif ? true : undefined,
  };
}
