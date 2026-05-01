import type { ChatReplyContext } from '../services/chatService';

export type ChatPendingRenderableStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface ChatPendingStatusDisplayInput {
  status: unknown;
  isOffline: boolean;
  isRetrying?: boolean;
}

export interface ChatPendingStatusDisplayState {
  effectiveStatus: ChatPendingRenderableStatus;
  statusLabel: string;
  canRetry: boolean;
}

export interface ChatPendingReplyPreviewStateInput {
  replyTo?: ChatReplyContext | null;
  maxLength: number;
  resolvePreviewText: (input: {
    text?: string;
    isSpecial?: boolean;
    hasAttachments?: boolean;
    attachmentCount?: number;
    hasSticker?: boolean;
    hasGif?: boolean;
    maxLength?: number;
  }) => string;
}

export interface ChatPendingReplyPreviewState {
  previewText: string;
  shouldShowPreview: boolean;
}

function normalizePendingRenderableStatus(value: unknown): ChatPendingRenderableStatus {
  if (value === 'sending' || value === 'sent' || value === 'failed' || value === 'queued') {
    return value;
  }

  return 'queued';
}

function normalizePreviewMaxLength(value: unknown, fallback = 120): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const truncated = Math.trunc(numeric);
  if (truncated <= 0) {
    return fallback;
  }

  return truncated;
}

export function resolveChatPendingStatusDisplayState(
  input: ChatPendingStatusDisplayInput
): ChatPendingStatusDisplayState {
  const normalizedStatus = normalizePendingRenderableStatus(input.status);
  const isRetrying = input.isRetrying === true;

  const effectiveStatus: ChatPendingRenderableStatus = isRetrying ? 'sending' : normalizedStatus;
  const statusLabel = effectiveStatus === 'sending'
    ? (isRetrying ? 'Retrying...' : 'Sending...')
    : effectiveStatus === 'sent'
      ? 'Sent'
      : effectiveStatus === 'queued'
        ? 'Queued'
        : 'Not sent';

  const canRetry = !isRetrying && (
    effectiveStatus === 'failed' ||
    (effectiveStatus === 'queued' && !input.isOffline)
  );

  return {
    effectiveStatus,
    statusLabel,
    canRetry,
  };
}

export function resolveChatPendingReplyPreviewState(
  input: ChatPendingReplyPreviewStateInput
): ChatPendingReplyPreviewState {
  const replyTo = input.replyTo;
  if (!replyTo || typeof input.resolvePreviewText !== 'function') {
    return {
      previewText: '',
      shouldShowPreview: false,
    };
  }

  const previewTextResult = input.resolvePreviewText({
    text: replyTo.text,
    isSpecial: replyTo.isSpecial,
    hasAttachments: replyTo.hasAttachments,
    attachmentCount: replyTo.attachmentCount,
    hasSticker: replyTo.hasSticker,
    hasGif: replyTo.hasGif,
    maxLength: normalizePreviewMaxLength(input.maxLength),
  });
  const previewText = typeof previewTextResult === 'string' ? previewTextResult : '';

  return {
    previewText,
    shouldShowPreview: previewText.length > 0,
  };
}
