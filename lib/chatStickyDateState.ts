export interface ChatStickyDateSourcePlanInput {
  topVisibleMessageId: unknown;
  previousSourceMessageId: string | null;
  currentStickyDateText: string;
}

export interface ChatStickyDateSourcePlan {
  normalizedTopMessageId: string | null;
  shouldReuseCurrentStickyDate: boolean;
  shouldResolveTopMessageDate: boolean;
  shouldClearSourceMessageId: boolean;
}

export interface ChatStickyDateVisibilityPlanInput {
  nextDateText: string;
  currentStickyDateText: string;
  currentStickyDateVisible: boolean;
}

export interface ChatStickyDateVisibilityPlan {
  shouldSetStickyDateText: boolean;
  nextStickyDateText: string;
  shouldSetStickyDateVisible: boolean;
  nextStickyDateVisible: boolean;
}

function normalizeStickyDateSourceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveChatStickyDateSourcePlan(
  input: ChatStickyDateSourcePlanInput
): ChatStickyDateSourcePlan {
  const normalizedTopMessageId = normalizeStickyDateSourceId(input.topVisibleMessageId);
  const normalizedPreviousSourceMessageId = normalizeStickyDateSourceId(input.previousSourceMessageId);
  const hasCurrentStickyDateText =
    typeof input.currentStickyDateText === 'string' && input.currentStickyDateText.length > 0;

  const shouldReuseCurrentStickyDate = Boolean(
    normalizedTopMessageId &&
      normalizedPreviousSourceMessageId === normalizedTopMessageId &&
      hasCurrentStickyDateText
  );

  return {
    normalizedTopMessageId,
    shouldReuseCurrentStickyDate,
    shouldResolveTopMessageDate: Boolean(normalizedTopMessageId && !shouldReuseCurrentStickyDate),
    shouldClearSourceMessageId: !normalizedTopMessageId,
  };
}

export function resolveChatStickyDateVisibilityPlan(
  input: ChatStickyDateVisibilityPlanInput
): ChatStickyDateVisibilityPlan {
  const nextDateText = typeof input.nextDateText === 'string' ? input.nextDateText : '';
  const hasNextDateText = nextDateText.length > 0;
  const nextStickyDateVisible = hasNextDateText;

  return {
    shouldSetStickyDateText: hasNextDateText && nextDateText !== input.currentStickyDateText,
    nextStickyDateText: hasNextDateText ? nextDateText : input.currentStickyDateText,
    shouldSetStickyDateVisible: nextStickyDateVisible !== input.currentStickyDateVisible,
    nextStickyDateVisible,
  };
}
