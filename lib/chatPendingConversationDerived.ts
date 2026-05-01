export interface ChatPendingConversationDerivedState<
  TPendingMessage,
  TPendingMedia,
  TPendingAttachment,
> {
  mediaEntries: [string, TPendingMedia][];
  messageEntries: [string, TPendingMessage][];
  attachmentEntries: [string, TPendingAttachment][];
  retryableTextIds: string[];
  retryableMediaIds: string[];
  retryableAttachmentIds: string[];
  retryAllCount: number;
}

export interface ResolveChatPendingConversationDerivedStateInput<
  TPendingMessage extends { recipientId?: unknown },
  TPendingMedia extends { recipientId?: unknown; status?: unknown },
  TPendingAttachment extends { recipientId?: unknown; status?: unknown },
> {
  selectedRecipientId: unknown;
  pendingMessages: ReadonlyMap<string, TPendingMessage>;
  pendingMedia: ReadonlyMap<string, TPendingMedia>;
  pendingAttachments: ReadonlyMap<string, TPendingAttachment>;
  resolvePendingMessageStatus: (pendingMessage: TPendingMessage) => unknown;
}

function shouldRetryPendingTextStatus(status: unknown): boolean {
  return status === 'failed' || status === 'queued';
}

function shouldRetryPendingMediaStatus(status: unknown): boolean {
  return status === 'failed' || status === 'queued';
}

function shouldRetryPendingAttachmentStatus(status: unknown): boolean {
  return status === 'failed';
}

function hasSelectedRecipient(value: unknown): boolean {
  return Boolean(value);
}

function hasMatchingRecipient(itemRecipientId: unknown, selectedRecipientId: unknown): boolean {
  return itemRecipientId === selectedRecipientId;
}

export function resolveChatPendingConversationDerivedState<
  TPendingMessage extends { recipientId?: unknown },
  TPendingMedia extends { recipientId?: unknown; status?: unknown },
  TPendingAttachment extends { recipientId?: unknown; status?: unknown },
>(
  input: ResolveChatPendingConversationDerivedStateInput<
    TPendingMessage,
    TPendingMedia,
    TPendingAttachment
  >
): ChatPendingConversationDerivedState<TPendingMessage, TPendingMedia, TPendingAttachment> {
  if (!hasSelectedRecipient(input.selectedRecipientId)) {
    return {
      mediaEntries: [],
      messageEntries: [],
      attachmentEntries: [],
      retryableTextIds: [],
      retryableMediaIds: [],
      retryableAttachmentIds: [],
      retryAllCount: 0,
    };
  }

  const selectedRecipientId = input.selectedRecipientId;
  const mediaEntries: [string, TPendingMedia][] = [];
  const messageEntries: [string, TPendingMessage][] = [];
  const attachmentEntries: [string, TPendingAttachment][] = [];
  const retryableTextIds: string[] = [];
  const retryableMediaIds: string[] = [];
  const retryableAttachmentIds: string[] = [];

  input.pendingMessages.forEach((pendingMessage, tempId) => {
    if (!pendingMessage || !hasMatchingRecipient(pendingMessage.recipientId, selectedRecipientId)) {
      return;
    }

    messageEntries.push([tempId, pendingMessage]);
    const status = input.resolvePendingMessageStatus(pendingMessage);
    if (shouldRetryPendingTextStatus(status)) {
      retryableTextIds.push(tempId);
    }
  });

  input.pendingMedia.forEach((pendingMediaItem, tempId) => {
    if (!pendingMediaItem || !hasMatchingRecipient(pendingMediaItem.recipientId, selectedRecipientId)) {
      return;
    }

    mediaEntries.push([tempId, pendingMediaItem]);
    if (shouldRetryPendingMediaStatus(pendingMediaItem.status)) {
      retryableMediaIds.push(tempId);
    }
  });

  input.pendingAttachments.forEach((pendingAttachmentItem, tempId) => {
    if (
      !pendingAttachmentItem ||
      !hasMatchingRecipient(pendingAttachmentItem.recipientId, selectedRecipientId)
    ) {
      return;
    }

    attachmentEntries.push([tempId, pendingAttachmentItem]);
    if (shouldRetryPendingAttachmentStatus(pendingAttachmentItem.status)) {
      retryableAttachmentIds.push(tempId);
    }
  });

  return {
    mediaEntries,
    messageEntries,
    attachmentEntries,
    retryableTextIds,
    retryableMediaIds,
    retryableAttachmentIds,
    retryAllCount:
      retryableTextIds.length + retryableMediaIds.length + retryableAttachmentIds.length,
  };
}
