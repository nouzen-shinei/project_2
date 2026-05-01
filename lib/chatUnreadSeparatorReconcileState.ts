export interface ChatUnreadSeparatorReconcileInput {
  showUnreadSeparator: boolean;
  unreadSeparatorMessageId: string | null;
  unreadSeparatorAnchorMessageId: string | null;
  anchorExists: boolean;
}

export interface ChatUnreadSeparatorReconcilePlan {
  shouldUpdateAnchor: boolean;
  nextAnchorMessageId: string | null;
  shouldClearUnreadSeparator: boolean;
}

export function resolveChatUnreadSeparatorReconcilePlan(
  input: ChatUnreadSeparatorReconcileInput
): ChatUnreadSeparatorReconcilePlan {
  if (!input.showUnreadSeparator || !input.unreadSeparatorMessageId) {
    return {
      shouldUpdateAnchor: false,
      nextAnchorMessageId: null,
      shouldClearUnreadSeparator: false,
    };
  }

  if (input.anchorExists) {
    return {
      shouldUpdateAnchor: false,
      nextAnchorMessageId: null,
      shouldClearUnreadSeparator: false,
    };
  }

  if (
    input.unreadSeparatorAnchorMessageId &&
    input.unreadSeparatorAnchorMessageId !== input.unreadSeparatorMessageId
  ) {
    return {
      shouldUpdateAnchor: true,
      nextAnchorMessageId: input.unreadSeparatorAnchorMessageId,
      shouldClearUnreadSeparator: false,
    };
  }

  if (!input.unreadSeparatorAnchorMessageId) {
    return {
      shouldUpdateAnchor: false,
      nextAnchorMessageId: null,
      shouldClearUnreadSeparator: true,
    };
  }

  return {
    shouldUpdateAnchor: false,
    nextAnchorMessageId: null,
    shouldClearUnreadSeparator: false,
  };
}
