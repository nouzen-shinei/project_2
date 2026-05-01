const DEFAULT_CHAT_REPLY_PREVIEW_MAX_LENGTH = 120;

export interface ChatReplyPreviewInput {
  text?: string | null;
  isSpecial?: boolean;
  hasAttachments?: boolean;
  attachmentCount?: number;
  hasSticker?: boolean;
  hasGif?: boolean;
  maxLength?: number;
}

function normalizeAttachmentCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.trunc(numeric);
}

function normalizeReplyText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

function truncatePreviewText(text: string, maxLength: number): string {
  if (!text) {
    return '';
  }
  const safeMaxLength = Number.isFinite(maxLength) && maxLength > 8
    ? Math.trunc(maxLength)
    : DEFAULT_CHAT_REPLY_PREVIEW_MAX_LENGTH;

  if (text.length <= safeMaxLength) {
    return text;
  }

  return `${text.slice(0, safeMaxLength - 1)}…`;
}

export function resolveChatReplyPreviewText(input?: ChatReplyPreviewInput | null): string {
  const maxLength = input?.maxLength ?? DEFAULT_CHAT_REPLY_PREVIEW_MAX_LENGTH;
  const normalizedText = truncatePreviewText(normalizeReplyText(input?.text), maxLength);
  if (normalizedText) {
    return normalizedText;
  }

  if (input?.isSpecial) {
    return 'Special message';
  }

  if (input?.hasGif) {
    return 'GIF';
  }

  if (input?.hasSticker) {
    return 'Sticker';
  }

  const attachmentCount = normalizeAttachmentCount(input?.attachmentCount);
  const effectiveAttachmentCount = attachmentCount > 0
    ? attachmentCount
    : input?.hasAttachments
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
