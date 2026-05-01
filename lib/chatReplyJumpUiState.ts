export interface ChatReplyJumpFabState {
  showScrollToBottom: boolean;
  showReplyJumpToLatest: boolean;
}

export function normalizeReplyJumpTargetMessageId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveReplyJumpStateForJumpSuccess(): ChatReplyJumpFabState {
  return {
    showScrollToBottom: true,
    showReplyJumpToLatest: true,
  };
}

export function resolveReplyJumpStateForLatestReturn(): ChatReplyJumpFabState {
  return {
    showScrollToBottom: false,
    showReplyJumpToLatest: false,
  };
}

export function resolveReplyJumpStateForNearBottom(): ChatReplyJumpFabState {
  return {
    showScrollToBottom: false,
    showReplyJumpToLatest: false,
  };
}

export function resolveReplyJumpHighlightAfterTimeout(
  currentHighlightMessageId: string | null | undefined,
  targetMessageId: unknown
): string | null {
  const normalizedCurrent = normalizeReplyJumpTargetMessageId(currentHighlightMessageId);
  const normalizedTarget = normalizeReplyJumpTargetMessageId(targetMessageId);

  if (!normalizedCurrent || !normalizedTarget) {
    return normalizedCurrent;
  }

  return normalizedCurrent === normalizedTarget ? null : normalizedCurrent;
}
