export interface ChatStickyDateScrollPlanInput {
  topVisibleMessageId: unknown;
  previousSourceMessageId: string | null;
  currentStickyDateText: string;
  currentStickyDateVisible: boolean;
  dateLabelById: Map<string, string>;
}

export interface ChatStickyDateScrollPlan {
  shouldSetSourceMessageId: boolean;
  nextSourceMessageId: string | null;
  shouldClearSourceMessageId: boolean;
  shouldSetStickyDateText: boolean;
  nextStickyDateText: string;
  shouldSetStickyDateVisible: boolean;
  nextStickyDateVisible: boolean;
}

export interface ChatStickyDateIdleHidePlanInput {
  shouldHideStickyDateOnIdle: boolean;
  currentStickyDateVisible: boolean;
}

export interface ChatStickyDateIdleHidePlan {
  shouldHideStickyDate: boolean;
}

function normalizeSourceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveChatStickyDateScrollPlan(
  input: ChatStickyDateScrollPlanInput
): ChatStickyDateScrollPlan {
  const normalizedTopMessageId = normalizeSourceId(input.topVisibleMessageId);
  const normalizedPreviousSourceMessageId = normalizeSourceId(
    input.previousSourceMessageId
  );
  const hasCurrentStickyDateText =
    typeof input.currentStickyDateText === 'string' &&
    input.currentStickyDateText.length > 0;

  const shouldReuseCurrentStickyDate = Boolean(
    normalizedTopMessageId &&
      normalizedPreviousSourceMessageId === normalizedTopMessageId &&
      hasCurrentStickyDateText
  );

  let nextDateText = '';
  if (shouldReuseCurrentStickyDate) {
    nextDateText = input.currentStickyDateText;
  } else if (normalizedTopMessageId) {
    nextDateText = input.dateLabelById.get(normalizedTopMessageId) || '';
  }

  const shouldSetSourceMessageId = Boolean(
    nextDateText && normalizedTopMessageId
  );
  const shouldClearSourceMessageId = Boolean(
    !normalizedTopMessageId || !nextDateText
  );

  const hasNextDateText = nextDateText.length > 0;
  const nextStickyDateVisible = hasNextDateText;
  const shouldSetStickyDateText =
    hasNextDateText && nextDateText !== input.currentStickyDateText;

  return {
    shouldSetSourceMessageId,
    nextSourceMessageId: shouldSetSourceMessageId ? normalizedTopMessageId : null,
    shouldClearSourceMessageId,
    shouldSetStickyDateText,
    nextStickyDateText: hasNextDateText
      ? nextDateText
      : input.currentStickyDateText,
    shouldSetStickyDateVisible:
      nextStickyDateVisible !== input.currentStickyDateVisible,
    nextStickyDateVisible,
  };
}

export function resolveChatStickyDateIdleHidePlan(
  input: ChatStickyDateIdleHidePlanInput
): ChatStickyDateIdleHidePlan {
  return {
    shouldHideStickyDate:
      input.shouldHideStickyDateOnIdle && input.currentStickyDateVisible,
  };
}
