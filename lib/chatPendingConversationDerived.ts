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
  // Self-heal / auto-redrive eligibility (distinct from the user-facing manual
  // retry banner). An accepted-but-not-yet-confirmed send (`sending`/`sent`) is
  // eligible for automatic, idempotent re-drive to the intended recipient, but it
  // MUST NOT inflate the manual "N pending items not sent" banner — a healthy
  // in-flight message is not a failure. The banner is driven by `retryableTextIds`
  // / `retryAllCount` (failed/queued only); the self-heal driver reads this seam.
  autoRedriveTextIds: string[];
  // "Queued" is a strict subset of "retryable" (retryable also includes items
  // that failed outright). Auto-retry-on-reconnect should only resend items
  // that were queued purely because the device was offline, not items that
  // failed for another reason (rate limiting, server error, etc.) — those
  // require an explicit user-initiated retry.
  queuedTextIds: string[];
  queuedMediaIds: string[];
  queuedAttachmentIds: string[];
  queuedAllCount: number;
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
  // Manual-retry / offline-queue semantics ONLY: an item is offered in the
  // user-facing "N pending items not sent" banner (`retryableTextIds` /
  // `retryAllCount`) exactly when it genuinely failed or is waiting offline.
  //
  // A healthy in-flight (`sending`) or optimistically-acknowledged (`sent`) item
  // is NOT a failure and must never light that banner (it would flash on every
  // send and clear on confirm). Automatic self-heal of un-confirmed sends is a
  // SEPARATE concern handled by `shouldAutoRedrivePendingTextStatus` /
  // `autoRedriveTextIds` and the independent outbox driver — not by this manual
  // classification (stuck-message-delivery-fix hotfix, Fix B).
  return status === 'failed' || status === 'queued';
}

function shouldAutoRedrivePendingTextStatus(status: unknown): boolean {
  // Self-heal / auto-redrive eligibility: an accepted-but-not-yet-confirmed send
  // (`sending` = in flight, `sent` = optimistically acknowledged but not yet
  // confirmed durable for the intended recipient) is eligible for automatic,
  // idempotent re-drive keyed on clientMsgId. Confirmed items are removed by
  // reconciliation, so anything still classified here after reconciliation is,
  // by definition, not yet confirmed and should self-heal — WITHOUT inflating the
  // manual retry banner (stuck-message-delivery-fix hotfix, Fix B / Property 2).
  return status === 'sending' || status === 'sent';
}

function shouldRetryPendingMediaStatus(status: unknown): boolean {
  return status === 'failed' || status === 'queued';
}

// Attachments now support an explicit 'queued' status for offline sends (see
// PendingAttachmentItem), so they are retryable in the same two cases as text
// and media.
function shouldRetryPendingAttachmentStatus(status: unknown): boolean {
  return status === 'failed' || status === 'queued';
}

function isQueuedStatus(status: unknown): boolean {
  return status === 'queued';
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
      autoRedriveTextIds: [],
      queuedTextIds: [],
      queuedMediaIds: [],
      queuedAttachmentIds: [],
      queuedAllCount: 0,
    };
  }

  const selectedRecipientId = input.selectedRecipientId;
  const mediaEntries: [string, TPendingMedia][] = [];
  const messageEntries: [string, TPendingMessage][] = [];
  const attachmentEntries: [string, TPendingAttachment][] = [];
  const retryableTextIds: string[] = [];
  const retryableMediaIds: string[] = [];
  const retryableAttachmentIds: string[] = [];
  const autoRedriveTextIds: string[] = [];
  const queuedTextIds: string[] = [];
  const queuedMediaIds: string[] = [];
  const queuedAttachmentIds: string[] = [];

  input.pendingMessages.forEach((pendingMessage, tempId) => {
    if (!pendingMessage || !hasMatchingRecipient(pendingMessage.recipientId, selectedRecipientId)) {
      return;
    }

    messageEntries.push([tempId, pendingMessage]);
    const status = input.resolvePendingMessageStatus(pendingMessage);
    if (shouldRetryPendingTextStatus(status)) {
      retryableTextIds.push(tempId);
    }
    if (shouldAutoRedrivePendingTextStatus(status)) {
      autoRedriveTextIds.push(tempId);
    }
    if (isQueuedStatus(status)) {
      queuedTextIds.push(tempId);
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
    if (isQueuedStatus(pendingMediaItem.status)) {
      queuedMediaIds.push(tempId);
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
    if (isQueuedStatus(pendingAttachmentItem.status)) {
      queuedAttachmentIds.push(tempId);
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
    autoRedriveTextIds,
    queuedTextIds,
    queuedMediaIds,
    queuedAttachmentIds,
    queuedAllCount: queuedTextIds.length + queuedMediaIds.length + queuedAttachmentIds.length,
  };
}
