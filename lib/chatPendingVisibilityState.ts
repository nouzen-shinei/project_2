export interface ResolveChatPendingServerMatchVisibilityInput {
  selectedRecipientId: unknown;
  itemRecipientId: unknown;
  serverMessageId: unknown;
  deliveredMessageIds: ReadonlySet<string>;
  normalizeMessageId: (value: unknown) => string;
}

export interface ChatPendingServerMatchVisibilityState {
  shouldRender: boolean;
  shouldHideAsDelivered: boolean;
  normalizedServerMessageId: string;
}

export interface ResolveChatPendingTextVisibilityStateInput {
  selectedRecipientId: unknown;
  itemRecipientId: unknown;
  status: unknown;
  serverMessageId: unknown;
  deliveredMessageIds: ReadonlySet<string>;
  normalizeMessageId: (value: unknown) => string;
  resolveFallbackServerMessageId?: () => unknown;
}

export interface ChatPendingTextVisibilityState extends ChatPendingServerMatchVisibilityState {
  canUseDeliveredHideRule: boolean;
}

function hasMatchingRecipient(selectedRecipientId: unknown, itemRecipientId: unknown): boolean {
  return Boolean(selectedRecipientId) && itemRecipientId === selectedRecipientId;
}

function canHidePendingTextByDeliveredServerMatch(status: unknown): boolean {
  return status === 'sending' || status === 'sent';
}

export function resolveChatPendingServerMatchVisibility(
  input: ResolveChatPendingServerMatchVisibilityInput
): ChatPendingServerMatchVisibilityState {
  if (!hasMatchingRecipient(input.selectedRecipientId, input.itemRecipientId)) {
    return {
      shouldRender: false,
      shouldHideAsDelivered: false,
      normalizedServerMessageId: '',
    };
  }

  const normalizedServerMessageId = input.normalizeMessageId(input.serverMessageId);
  const shouldHideAsDelivered = Boolean(
    normalizedServerMessageId && input.deliveredMessageIds.has(normalizedServerMessageId)
  );

  return {
    shouldRender: !shouldHideAsDelivered,
    shouldHideAsDelivered,
    normalizedServerMessageId,
  };
}

export function resolveChatPendingTextVisibilityState(
  input: ResolveChatPendingTextVisibilityStateInput
): ChatPendingTextVisibilityState {
  if (!hasMatchingRecipient(input.selectedRecipientId, input.itemRecipientId)) {
    return {
      shouldRender: false,
      shouldHideAsDelivered: false,
      normalizedServerMessageId: '',
      canUseDeliveredHideRule: false,
    };
  }

  const canUseDeliveredHideRule = canHidePendingTextByDeliveredServerMatch(input.status);
  let normalizedServerMessageId = input.normalizeMessageId(input.serverMessageId);

  if (
    !normalizedServerMessageId &&
    canUseDeliveredHideRule &&
    typeof input.resolveFallbackServerMessageId === 'function'
  ) {
    normalizedServerMessageId = input.normalizeMessageId(input.resolveFallbackServerMessageId());
  }

  const shouldHideAsDelivered = Boolean(
    canUseDeliveredHideRule &&
      normalizedServerMessageId &&
      input.deliveredMessageIds.has(normalizedServerMessageId)
  );

  return {
    shouldRender: !shouldHideAsDelivered,
    shouldHideAsDelivered,
    normalizedServerMessageId,
    canUseDeliveredHideRule,
  };
}
