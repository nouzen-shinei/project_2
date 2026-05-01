export interface ChatViewabilityWindowSummaryInput {
  viewableItems?: Iterable<unknown>;
  unreadMessageId?: unknown;
}

export interface ChatViewabilityWindowSummary {
  hasUnreadTarget: boolean;
  isUnreadVisible: boolean;
  topVisibleIndex: number | null;
  topVisibleMessageId: string | null;
  bottomVisibleIndex: number | null;
}

export interface ChatUnreadSeparatorVisibilityPlanInput {
  hasUnreadTarget: boolean;
  isUnreadVisible: boolean;
  hasAcknowledgedUnread: boolean;
  incomingUnreadCount: number;
  unreadDividerSeedCount: number;
}

export interface ChatUnreadSeparatorVisibilityPlan {
  nextUnreadSeparatorIsVisible: boolean;
  shouldAcknowledgeUnread: boolean;
  shouldClearDismissTimeout: boolean;
  shouldScheduleDismiss: boolean;
}

export interface ChatTopWindowActionPlanInput {
  topVisibleIndex: number | null;
  topVisibleMessageId: string | null;
  shouldUseManualAnchorPreservation: boolean;
  hasPendingPrependAnchor: boolean;
  isInitialAnchorSettled: boolean;
  hasUserInteracted: boolean;
  allowTopAutoPagination: boolean;
  topAutoLoadThreshold: number;
  currentAutoLoadAnchorId: string | null;
  topPrefetchThreshold: number;
}

export interface ChatTopWindowActionPlan {
  shouldUpdateTopVisibleMessage: boolean;
  nextTopVisibleIndex: number | null;
  nextTopVisibleMessageId: string | null;
  shouldRequestOlder: boolean;
  shouldWarmNextPage: boolean;
  shouldResetAutoLoadAnchor: boolean;
  nextAutoLoadAnchorId: string | null;
}

const CHAT_UNREAD_SEPARATOR_VISIBILITY_NOOP_PLAN: ChatUnreadSeparatorVisibilityPlan = {
  nextUnreadSeparatorIsVisible: false,
  shouldAcknowledgeUnread: false,
  shouldClearDismissTimeout: false,
  shouldScheduleDismiss: false,
};

const CHAT_UNREAD_SEPARATOR_VISIBILITY_ACTIVE_PLAN: ChatUnreadSeparatorVisibilityPlan = {
  nextUnreadSeparatorIsVisible: true,
  shouldAcknowledgeUnread: true,
  shouldClearDismissTimeout: true,
  shouldScheduleDismiss: false,
};

const CHAT_TOP_WINDOW_ACTION_ABSENT_PLAN: ChatTopWindowActionPlan = {
  shouldUpdateTopVisibleMessage: false,
  nextTopVisibleIndex: null,
  nextTopVisibleMessageId: null,
  shouldRequestOlder: false,
  shouldWarmNextPage: false,
  shouldResetAutoLoadAnchor: true,
  nextAutoLoadAnchorId: null,
};

function createChatUnreadSeparatorVisibilityPlan(
  overrides?: Partial<ChatUnreadSeparatorVisibilityPlan>
): ChatUnreadSeparatorVisibilityPlan {
  return {
    ...CHAT_UNREAD_SEPARATOR_VISIBILITY_NOOP_PLAN,
    ...(overrides || {}),
  };
}

function createChatTopWindowActionPlan(
  overrides?: Partial<ChatTopWindowActionPlan>
): ChatTopWindowActionPlan {
  return {
    ...CHAT_TOP_WINDOW_ACTION_ABSENT_PLAN,
    ...(overrides || {}),
  };
}

function normalizeMessageId(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function resolveEntryIndex(entry: unknown): number | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const rawIndex = (entry as { index?: unknown }).index;
  if (typeof rawIndex !== 'number' || !Number.isFinite(rawIndex) || rawIndex < 0) {
    return null;
  }

  return rawIndex;
}

function resolveEntryMessageId(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const rawId = (entry as { item?: { id?: unknown } }).item?.id;
  if (rawId === null || rawId === undefined) {
    return null;
  }

  return String(rawId);
}

export function resolveChatViewabilityWindowSummary(
  input: ChatViewabilityWindowSummaryInput
): ChatViewabilityWindowSummary {
  const unreadTargetId = normalizeMessageId(input.unreadMessageId);
  const hasUnreadTarget = unreadTargetId.length > 0;

  let isUnreadVisible = false;
  let topVisibleIndex: number | null = null;
  let topVisibleMessageId: string | null = null;
  let bottomVisibleIndex: number | null = null;

  for (const entry of input.viewableItems || []) {
    const entryIndex = resolveEntryIndex(entry);
    if (entryIndex === null) {
      continue;
    }

    if (topVisibleIndex === null || entryIndex < topVisibleIndex) {
      topVisibleIndex = entryIndex;
      topVisibleMessageId = resolveEntryMessageId(entry);
    }

    if (bottomVisibleIndex === null || entryIndex > bottomVisibleIndex) {
      bottomVisibleIndex = entryIndex;
    }

    if (hasUnreadTarget && !isUnreadVisible) {
      const entryMessageId = normalizeMessageId(
        (entry as { item?: { id?: unknown } })?.item?.id
      );
      isUnreadVisible = entryMessageId === unreadTargetId;
    }
  }

  return {
    hasUnreadTarget,
    isUnreadVisible,
    topVisibleIndex,
    topVisibleMessageId,
    bottomVisibleIndex,
  };
}

export function resolveChatUnreadSeparatorVisibilityPlan(
  input: ChatUnreadSeparatorVisibilityPlanInput
): ChatUnreadSeparatorVisibilityPlan {
  if (!input.hasUnreadTarget) {
    return createChatUnreadSeparatorVisibilityPlan();
  }

  if (input.isUnreadVisible) {
    return CHAT_UNREAD_SEPARATOR_VISIBILITY_ACTIVE_PLAN;
  }

  const shouldScheduleDismiss =
    input.hasAcknowledgedUnread &&
    input.incomingUnreadCount === 0 &&
    input.unreadDividerSeedCount === 0;

  return createChatUnreadSeparatorVisibilityPlan({
    shouldScheduleDismiss,
  });
}

export function resolveChatTopWindowActionPlan(
  input: ChatTopWindowActionPlanInput
): ChatTopWindowActionPlan {
  if (input.topVisibleIndex === null || input.topVisibleMessageId === null) {
    return createChatTopWindowActionPlan();
  }

  const anchorBlocked =
    input.shouldUseManualAnchorPreservation && input.hasPendingPrependAnchor;
  const canAutoPaginate =
    input.isInitialAnchorSettled &&
    input.hasUserInteracted &&
    input.allowTopAutoPagination;

  let shouldRequestOlder = false;
  let shouldResetAutoLoadAnchor = false;
  let nextAutoLoadAnchorId: string | null = input.currentAutoLoadAnchorId;

  if (canAutoPaginate) {
    if (input.topVisibleIndex <= input.topAutoLoadThreshold) {
      if (input.topVisibleMessageId !== input.currentAutoLoadAnchorId && !anchorBlocked) {
        shouldRequestOlder = true;
        nextAutoLoadAnchorId = input.topVisibleMessageId;
      }
    } else if (input.topVisibleIndex > input.topAutoLoadThreshold + 1) {
      shouldResetAutoLoadAnchor = true;
      nextAutoLoadAnchorId = null;
    }
  }

  return createChatTopWindowActionPlan({
    shouldUpdateTopVisibleMessage: true,
    nextTopVisibleIndex: input.topVisibleIndex,
    nextTopVisibleMessageId: input.topVisibleMessageId,
    shouldRequestOlder,
    shouldWarmNextPage: input.topVisibleIndex <= input.topPrefetchThreshold,
    shouldResetAutoLoadAnchor,
    nextAutoLoadAnchorId,
  });
}