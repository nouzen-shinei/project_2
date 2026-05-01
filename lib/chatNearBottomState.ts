export interface ChatNearBottomStateInput {
  offsetY: number;
  contentHeight: number;
  layoutHeight: number;
  bottomVisibilityPadding: number;
  wasNearBottom: boolean;
  showUnreadSeparator: boolean;
  activeUnreadAnchorId: string | null;
  lastDismissedUnreadAnchorId: string | null;
  thresholdPadding?: number;
}

export interface ChatNearBottomStateResult {
  distanceFromBottom: number;
  nearBottomThreshold: number;
  nearBottom: boolean;
  enteredNearBottom: boolean;
  leftNearBottom: boolean;
  activeUnreadAnchorId: string | null;
  shouldDismissUnreadDivider: boolean;
  nextDismissedUnreadAnchorId: string | null;
}

const DEFAULT_NEAR_BOTTOM_THRESHOLD_PADDING = 32;

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeAnchorId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveChatNearBottomState(
  input: ChatNearBottomStateInput
): ChatNearBottomStateResult {
  const offsetY = toFiniteNumber(input.offsetY);
  const contentHeight = Math.max(0, toFiniteNumber(input.contentHeight));
  const layoutHeight = Math.max(0, toFiniteNumber(input.layoutHeight));
  const bottomVisibilityPadding = Math.max(0, toFiniteNumber(input.bottomVisibilityPadding));
  const thresholdPadding = Math.max(
    0,
    toFiniteNumber(input.thresholdPadding, DEFAULT_NEAR_BOTTOM_THRESHOLD_PADDING)
  );

  const distanceFromBottom = Math.max(0, contentHeight - (offsetY + layoutHeight));
  const nearBottomThreshold = bottomVisibilityPadding + thresholdPadding;
  const nearBottom = distanceFromBottom <= nearBottomThreshold;
  const enteredNearBottom = nearBottom && !input.wasNearBottom;
  const leftNearBottom = !nearBottom && input.wasNearBottom;

  const activeUnreadAnchorId = normalizeAnchorId(input.activeUnreadAnchorId);
  const lastDismissedUnreadAnchorId = normalizeAnchorId(input.lastDismissedUnreadAnchorId);

  const shouldDismissUnreadDivider = Boolean(
    nearBottom &&
      input.showUnreadSeparator === true &&
      activeUnreadAnchorId &&
      (enteredNearBottom || lastDismissedUnreadAnchorId !== activeUnreadAnchorId)
  );

  let nextDismissedUnreadAnchorId = lastDismissedUnreadAnchorId;
  if (!nearBottom) {
    nextDismissedUnreadAnchorId = null;
  } else if (shouldDismissUnreadDivider) {
    nextDismissedUnreadAnchorId = activeUnreadAnchorId;
  }

  return {
    distanceFromBottom,
    nearBottomThreshold,
    nearBottom,
    enteredNearBottom,
    leftNearBottom,
    activeUnreadAnchorId,
    shouldDismissUnreadDivider,
    nextDismissedUnreadAnchorId,
  };
}
