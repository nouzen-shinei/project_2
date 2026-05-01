export interface ChatScrollInteractionPlanInput {
  isInitialAnchorSettled: boolean;
  isAutoScrolling: boolean;
  isDragging: boolean;
  isCurrentlyScrolling: boolean;
  scrollY: number;
  stickyDateVisible: boolean;
}

export interface ChatScrollInteractionPlan {
  shouldMarkUserInteracted: boolean;
  shouldAllowTopAutoPagination: boolean;
  shouldStopAnchorStabilization: boolean;
  shouldSetScrollingTrue: boolean;
  shouldHideStickyDateImmediate: boolean;
  shouldHideStickyDateOnIdle: boolean;
  shouldExitEarly: boolean;
  idleHideDelayMs: number;
}

export function resolveChatScrollInteractionPlan(
  input: ChatScrollInteractionPlanInput
): ChatScrollInteractionPlan {
  const shouldMarkUserInteracted =
    input.isInitialAnchorSettled &&
    !input.isAutoScrolling &&
    input.isDragging;
  const shouldExitEarly = input.scrollY <= 50;

  return {
    shouldMarkUserInteracted,
    shouldAllowTopAutoPagination: shouldMarkUserInteracted,
    shouldStopAnchorStabilization: shouldMarkUserInteracted,
    shouldSetScrollingTrue: !input.isCurrentlyScrolling,
    shouldHideStickyDateImmediate:
      shouldExitEarly && input.stickyDateVisible,
    shouldHideStickyDateOnIdle: !shouldExitEarly,
    shouldExitEarly,
    idleHideDelayMs: shouldExitEarly ? 200 : 1500,
  };
}