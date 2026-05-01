export interface ChatPendingMessageReconciliationItem {
  status?: unknown;
  serverMessageId?: unknown;
}

export interface ChatPendingMediaReconciliationItem {
  status?: unknown;
  serverMessageId?: unknown;
}

export interface ChatPendingAttachmentReconciliationItem {
  status?: unknown;
  serverMessageId?: unknown;
}

interface ResolveChatPendingReconciledIdsInput<TPendingItem extends { serverMessageId?: unknown }> {
  pendingEntries: ReadonlyMap<string, TPendingItem>;
  deliveredMessageIds: ReadonlySet<string>;
  normalizeMessageId: (value: unknown) => string;
  shouldInclude: (item: TPendingItem) => boolean;
}

interface ResolveChatPendingTextMessageReconciledIdsInput<TPendingMessage extends ChatPendingMessageReconciliationItem> {
  pendingMessages: ReadonlyMap<string, TPendingMessage>;
  deliveredMessageIds: ReadonlySet<string>;
  normalizeMessageId: (value: unknown) => string;
  resolvePendingMessageStatus: (message: TPendingMessage) => unknown;
}

interface ResolveChatPendingMediaMessageReconciledIdsInput<TPendingMedia extends ChatPendingMediaReconciliationItem> {
  pendingMedia: ReadonlyMap<string, TPendingMedia>;
  deliveredMessageIds: ReadonlySet<string>;
  normalizeMessageId: (value: unknown) => string;
}

interface ResolveChatPendingAttachmentMessageReconciledIdsInput<TPendingAttachment extends ChatPendingAttachmentReconciliationItem> {
  pendingAttachments: ReadonlyMap<string, TPendingAttachment>;
  deliveredMessageIds: ReadonlySet<string>;
  normalizeMessageId: (value: unknown) => string;
}

function resolveChatPendingReconciledIds<TPendingItem extends { serverMessageId?: unknown }>(
  input: ResolveChatPendingReconciledIdsInput<TPendingItem>
): string[] {
  const resolvedIds: string[] = [];

  input.pendingEntries.forEach((item, tempId) => {
    if (!item || !input.shouldInclude(item)) {
      return;
    }

    const normalizedServerMessageId = input.normalizeMessageId(item.serverMessageId);
    if (!normalizedServerMessageId || !input.deliveredMessageIds.has(normalizedServerMessageId)) {
      return;
    }

    resolvedIds.push(tempId);
  });

  return resolvedIds;
}

export function resolveChatPendingTextMessageReconciledIds<
  TPendingMessage extends ChatPendingMessageReconciliationItem,
>(
  input: ResolveChatPendingTextMessageReconciledIdsInput<TPendingMessage>
): string[] {
  return resolveChatPendingReconciledIds({
    pendingEntries: input.pendingMessages,
    deliveredMessageIds: input.deliveredMessageIds,
    normalizeMessageId: input.normalizeMessageId,
    shouldInclude: (message) => {
      const status = input.resolvePendingMessageStatus(message);
      return status === 'sending' || status === 'sent';
    },
  });
}

export function resolveChatPendingMediaMessageReconciledIds<
  TPendingMedia extends ChatPendingMediaReconciliationItem,
>(
  input: ResolveChatPendingMediaMessageReconciledIdsInput<TPendingMedia>
): string[] {
  return resolveChatPendingReconciledIds({
    pendingEntries: input.pendingMedia,
    deliveredMessageIds: input.deliveredMessageIds,
    normalizeMessageId: input.normalizeMessageId,
    shouldInclude: (item) => item.status === 'sent',
  });
}

export function resolveChatPendingAttachmentMessageReconciledIds<
  TPendingAttachment extends ChatPendingAttachmentReconciliationItem,
>(
  input: ResolveChatPendingAttachmentMessageReconciledIdsInput<TPendingAttachment>
): string[] {
  return resolveChatPendingReconciledIds({
    pendingEntries: input.pendingAttachments,
    deliveredMessageIds: input.deliveredMessageIds,
    normalizeMessageId: input.normalizeMessageId,
    shouldInclude: (item) => item.status === 'finalizing' || item.status === 'sent',
  });
}
