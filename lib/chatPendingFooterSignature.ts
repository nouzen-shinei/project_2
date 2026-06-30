/**
 * Builds a compact signature string describing the optimistic "pending" footer
 * state (text / media / attachment bubbles + typing indicator) for the
 * currently selected conversation.
 *
 * Why this exists:
 * The chat message list is a memoized FlashList whose footer renders the
 * optimistic bubbles, and that footer is delivered through a stable ref
 * callback. FlashList only re-renders the footer when its `data` or `extraData`
 * change. Pending-message state lives outside `data`, so without a dedicated
 * signal the sender's optimistic bubble would not paint until the real server
 * message later mutates `data` (which is exactly what produced the
 * sender-only "message appears late" delay). Feeding this signature into
 * `extraData` makes the list reactively re-render the instant pending state
 * changes — bubble appears, clock -> sent, upload progress, failure, typing.
 */

export interface ChatPendingFooterSignatureItemLike {
  recipientId?: unknown;
  status?: unknown;
  serverMessageId?: unknown;
  progress?: unknown;
}

export interface ResolveChatPendingFooterSignatureInput<
  TPendingMessage extends ChatPendingFooterSignatureItemLike,
  TPendingMedia extends ChatPendingFooterSignatureItemLike,
  TPendingAttachment extends ChatPendingFooterSignatureItemLike,
> {
  selectedRecipientId: unknown;
  pendingMessages: ReadonlyMap<string, TPendingMessage>;
  pendingMedia: ReadonlyMap<string, TPendingMedia>;
  pendingAttachments: ReadonlyMap<string, TPendingAttachment>;
  isTyping?: boolean;
  resolvePendingMessageStatus?: (message: TPendingMessage) => unknown;
}

function normalizeStatus(value: unknown): string {
  return typeof value === 'string' && value ? value : 'unknown';
}

// Round progress to a coarse bucket so frequent upload-progress ticks do not
// trigger an excessive number of list re-renders (keeps long conversations
// smooth) while still animating the progress bar reasonably.
function bucketProgress(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const clamped = Math.min(100, Math.max(0, numeric));
  return Math.round(clamped / 5) * 5;
}

function matchesRecipient(itemRecipientId: unknown, selectedRecipientId: unknown): boolean {
  return Boolean(selectedRecipientId) && itemRecipientId === selectedRecipientId;
}

export function resolveChatPendingFooterSignature<
  TPendingMessage extends ChatPendingFooterSignatureItemLike,
  TPendingMedia extends ChatPendingFooterSignatureItemLike,
  TPendingAttachment extends ChatPendingFooterSignatureItemLike,
>(
  input: ResolveChatPendingFooterSignatureInput<
    TPendingMessage,
    TPendingMedia,
    TPendingAttachment
  >
): string {
  const selectedRecipientId = input.selectedRecipientId;
  const typingFlag = input.isTyping ? 'typing:1' : 'typing:0';

  if (!selectedRecipientId) {
    return typingFlag;
  }

  const parts: string[] = [];

  input.pendingMessages.forEach((message, tempId) => {
    if (!message || !matchesRecipient(message.recipientId, selectedRecipientId)) {
      return;
    }
    const status = input.resolvePendingMessageStatus
      ? input.resolvePendingMessageStatus(message)
      : message.status;
    const hasServerId = message.serverMessageId ? 1 : 0;
    parts.push(`t:${tempId}:${normalizeStatus(status)}:${hasServerId}`);
  });

  input.pendingMedia.forEach((item, tempId) => {
    if (!item || !matchesRecipient(item.recipientId, selectedRecipientId)) {
      return;
    }
    parts.push(`m:${tempId}:${normalizeStatus(item.status)}:${bucketProgress(item.progress)}`);
  });

  input.pendingAttachments.forEach((item, tempId) => {
    if (!item || !matchesRecipient(item.recipientId, selectedRecipientId)) {
      return;
    }
    parts.push(`a:${tempId}:${normalizeStatus(item.status)}:${bucketProgress(item.progress)}`);
  });

  // Sort so the signature is independent of Map iteration order. Map iteration
  // is insertion-order (already stable), but sorting guards against future
  // reordering and keeps equal states comparing equal.
  parts.sort();
  parts.push(typingFlag);
  return parts.join('|');
}
