export interface ChatAnchorTarget {
  type: 'bottom' | 'message';
  id?: string;
}

export interface ChatEnsureAnchorActionInput {
  anchor: ChatAnchorTarget | null;
  hasUserInteracted: boolean;
  startedAtMs: number;
  nowMs: number;
  stabilizeMs: number;
}

export interface ChatEnsureAnchorActionPlan {
  shouldStopStabilization: boolean;
  shouldScrollBottom: boolean;
  shouldScrollMessage: boolean;
  messageId?: string;
}

export interface ChatBottomAnchorAttemptInput {
  hasAnchoredInitialScroll: boolean;
  force: boolean;
  contentHeight: number;
  layoutHeight: number;
}

export interface ChatBottomAnchorAttemptPlan {
  shouldAnchor: boolean;
  shouldSkipAsAlreadyAnchored: boolean;
  shouldDeferForLayout: boolean;
}

export interface ChatPrependAnchorRetryPlanInput {
  attempts: number;
  maxAttempts: number;
}

export interface ChatPrependAnchorRetryPlan {
  shouldClearAnchor: boolean;
  shouldRetry: boolean;
  nextAttempts: number;
}

export interface ChatPrependAnchorRetrySchedulePlanInput {
  retryPlan: ChatPrependAnchorRetryPlan;
  anchorId: string;
  anchorOffset: number;
  retryDelayMs?: unknown;
}

export interface ChatPrependAnchorRetrySchedulePlan {
  shouldScheduleRetry: boolean;
  nextAnchor: { id: string; offset: number; attempts: number } | null;
  retryDelayMs: number;
}

export interface ChatPrependAnchorFallbackPlanInput {
  hasDisplayedMessages: boolean;
  fallbackIndex: number;
}

export interface ChatPrependAnchorFallbackPlan {
  shouldScrollToIndex: boolean;
  targetIndex: number | null;
}

export interface ChatPrependAnchorClearPlanInput {
  retryPlan: ChatPrependAnchorRetryPlan;
  shouldResolveFallback: boolean;
  hasDisplayedMessages?: boolean;
  fallbackIndex?: number;
}

export interface ChatPrependAnchorClearPlan {
  shouldClearAnchor: boolean;
  fallbackPlan: ChatPrependAnchorFallbackPlan;
}

export interface ChatPrependAnchorFailurePlanInput {
  attempts: number;
  maxAttempts: number;
  shouldResolveFallback: boolean;
  hasDisplayedMessages?: boolean;
  fallbackIndex?: number;
}

export interface ChatPrependAnchorFailurePlanInputPlanInput {
  attempts: unknown;
  maxAttempts: unknown;
  shouldResolveFallback: boolean;
  hasDisplayedMessages?: unknown;
  fallbackIndex?: unknown;
}

export interface ChatPrependAnchorFailureFallbackInputPlanInput {
  shouldResolveFallback: boolean;
  displayedMessages?: unknown;
  fallbackIndex?: unknown;
}

export interface ChatPrependAnchorFailureFallbackInputPlan {
  hasDisplayedMessages: boolean;
  fallbackIndex: number;
}

export interface ChatPrependAnchorFailurePlan {
  retryPlan: ChatPrependAnchorRetryPlan;
  clearPlan: ChatPrependAnchorClearPlan;
  shouldRetry: boolean;
}

export interface ChatPrependAnchorFailureRetrySchedulePlanInput {
  failurePlan: ChatPrependAnchorFailurePlan;
  anchorId: string;
  anchorOffset: number;
  retryDelayMs?: unknown;
}

export interface ChatPrependAnchorFailureClearActionPlanInput {
  failurePlan: ChatPrependAnchorFailurePlan;
  anchorOffset: number;
}

export interface ChatPrependAnchorFailureClearActionPlan {
  shouldClearAnchor: boolean;
  fallbackScrollPlan: ChatPrependAnchorFallbackScrollPlan;
}

export interface ChatPrependAnchorFailureActionPlansInput {
  failurePlan: ChatPrependAnchorFailurePlan;
  anchorId: string;
  anchorOffset: number;
  retryDelayMs?: unknown;
}

export interface ChatPrependAnchorFailureActionPlansFromInputInput {
  attempts: unknown;
  maxAttempts: unknown;
  shouldResolveFallback: boolean;
  hasDisplayedMessages?: unknown;
  fallbackIndex?: unknown;
  anchorId: string;
  anchorOffset: number;
  retryDelayMs?: unknown;
}

export interface ChatPrependAnchorFailureActionPlansRawInputPlanInput {
  attempts: unknown;
  maxAttempts: unknown;
  shouldResolveFallback: boolean;
  fallbackInputPlan?: ChatPrependAnchorFailureFallbackInputPlan | null;
  anchorId: string;
  anchorOffset: number;
  retryDelayMs?: unknown;
}

export interface ChatPrependAnchorFailureAnchorContextPlanInput {
  anchorAttempts: unknown;
  maxAttempts: unknown;
  anchorId: unknown;
  anchorOffset: unknown;
  retryDelayMs?: unknown;
}

export interface ChatPrependAnchorFailureAnchorContextPlan {
  attempts: number;
  maxAttempts: number;
  anchorId: string;
  anchorOffset: number;
  retryDelayMs?: number;
}

export interface ChatPrependAnchorFailureActionPlansFromContextInput {
  anchorContextPlan: ChatPrependAnchorFailureAnchorContextPlan;
  branchKind: ChatPrependAnchorFailureBranchKind;
  displayedMessages?: unknown;
  fallbackIndex?: unknown;
}

export interface ChatPrependAnchorFailureEffectIntentFromContextInput {
  anchorContextPlan: ChatPrependAnchorFailureAnchorContextPlan;
  branchKind: ChatPrependAnchorFailureBranchKind;
  displayedMessages?: unknown;
  fallbackIndex?: unknown;
}

export interface ChatPrependAnchorFailureExecutionContextPlanInput {
  branchKind: ChatPrependAnchorFailureBranchKind;
  anchorId: unknown;
  displayedMessages?: unknown;
  displayedMessageIndexById?: ReadonlyMap<string, number> | null;
}

export interface ChatPrependAnchorFailureExecutionContextPlan {
  branchKind: ChatPrependAnchorFailureBranchKind;
  displayedMessages?: unknown;
  fallbackIndex?: number;
}

export interface ChatPrependAnchorFailureEffectExecutionForAnchorInput {
  anchorContextPlan: ChatPrependAnchorFailureAnchorContextPlan;
  branchKind: ChatPrependAnchorFailureBranchKind;
  anchorId: unknown;
  displayedMessages?: unknown;
  displayedMessageIndexById?: ReadonlyMap<string, number> | null;
}

export interface ChatPrependAnchorFailureEffectExecutionPlansForAnchorInput {
  anchorContextPlan: ChatPrependAnchorFailureAnchorContextPlan;
  anchorId: unknown;
  displayedMessages?: unknown;
  displayedMessageIndexById?: ReadonlyMap<string, number> | null;
}

export interface ChatPrependAnchorFailureEffectExecutionPlansForAnchor {
  missingTargetExecutionPlan: ChatPrependAnchorFailureEffectExecutionPlan;
  scrollFailedExecutionPlan: ChatPrependAnchorFailureEffectExecutionPlan;
}

export interface ChatPrependAnchorFailureRestorePlansInput {
  anchorAttempts: unknown;
  maxAttempts: unknown;
  anchorId: unknown;
  anchorOffset: unknown;
  displayedMessages?: unknown;
  displayedMessageIndexById?: ReadonlyMap<string, number> | null;
}

export interface ChatPrependAnchorFailureRestorePlans {
  anchorContextPlan: ChatPrependAnchorFailureAnchorContextPlan;
  failureExecutionPlans: ChatPrependAnchorFailureEffectExecutionPlansForAnchor;
}

export interface ChatPrependAnchorFailureExecutionSelectionPlanInput {
  targetExists: boolean;
  failureExecutionPlans: ChatPrependAnchorFailureEffectExecutionPlansForAnchor;
}

export interface ChatPrependAnchorFailureExecutionPlanForRestoreInput
  extends ChatPrependAnchorFailureRestorePlansInput {
  targetExists: boolean;
}

export type ChatPrependAnchorFailureBranchKind =
  | 'missing-target'
  | 'scroll-failed';

export interface ChatPrependAnchorFailureFallbackResolutionPlan {
  shouldResolveFallback: boolean;
}

export interface ChatPrependAnchorFailureActionPlans {
  clearActionPlan: ChatPrependAnchorFailureClearActionPlan;
  retrySchedulePlan: ChatPrependAnchorRetrySchedulePlan;
}

export type ChatPrependAnchorFailureEffectIntentKind =
  | 'none'
  | 'clear'
  | 'retry';

export interface ChatPrependAnchorFailureEffectIntentPlan {
  kind: ChatPrependAnchorFailureEffectIntentKind;
  clearFallbackScrollPayload: ChatPrependAnchorFallbackScrollPayload | null;
  retrySchedulePlan: ChatPrependAnchorRetrySchedulePlan | null;
}

export interface ChatPrependAnchorFailureEffectExecutionPlan {
  shouldClearAnchor: boolean;
  clearFallbackScrollPayload: ChatPrependAnchorFallbackScrollPayload | null;
  retryNextAnchor: { id: string; offset: number; attempts: number } | null;
  retryDelayMs: number;
}

export interface ChatPrependAnchorFallbackScrollPlanInput {
  fallbackPlan: ChatPrependAnchorFallbackPlan;
  anchorOffset: number;
}

export interface ChatPrependAnchorFallbackScrollPayload {
  index: number;
  animated: boolean;
  viewPosition: number;
  viewOffset: number;
}

export interface ChatPrependAnchorFallbackScrollPlan {
  shouldInvokeScrollToIndex: boolean;
  payload: ChatPrependAnchorFallbackScrollPayload | null;
}

export interface ChatPrependAnchorRestoreOffsetPlanInput {
  targetY: unknown;
  anchorOffset: unknown;
}

export interface ChatPrependAnchorRestoreOffsetPlan {
  payload: {
    offset: number;
    animated: boolean;
  };
}

export interface ChatPrependAnchorCapturePlanInput {
  shouldUseManualAnchorPreservation: boolean;
  hasPendingAnchor: boolean;
  topVisibleId: string | null;
  topVisibleY: number | null;
  currentOffset: number;
}

export interface ChatPrependAnchorCapturePlan {
  shouldCapture: boolean;
  anchorId: string | null;
  anchorOffset: number;
}

const CHAT_PREPEND_ANCHOR_RETRY_DEFAULT_DELAY_MS = 50;

const CHAT_ENSURE_ANCHOR_ACTION_BASE: ChatEnsureAnchorActionPlan = {
  shouldStopStabilization: false,
  shouldScrollBottom: false,
  shouldScrollMessage: false,
};

const CHAT_PREPEND_ANCHOR_FALLBACK_NOOP_PLAN: ChatPrependAnchorFallbackPlan = {
  shouldScrollToIndex: false,
  targetIndex: null,
};

const CHAT_PREPEND_ANCHOR_FALLBACK_SCROLL_NOOP_PLAN: ChatPrependAnchorFallbackScrollPlan = {
  shouldInvokeScrollToIndex: false,
  payload: null,
};

const CHAT_PREPEND_ANCHOR_RETRY_SCHEDULE_NOOP_PLAN: ChatPrependAnchorRetrySchedulePlan = {
  shouldScheduleRetry: false,
  nextAnchor: null,
  retryDelayMs: 0,
};

const CHAT_PREPEND_ANCHOR_FAILURE_CLEAR_ACTION_NOOP_PLAN: ChatPrependAnchorFailureClearActionPlan = {
  shouldClearAnchor: false,
  fallbackScrollPlan: CHAT_PREPEND_ANCHOR_FALLBACK_SCROLL_NOOP_PLAN,
};

const CHAT_PREPEND_ANCHOR_FAILURE_FALLBACK_INPUT_NOOP_PLAN: ChatPrependAnchorFailureFallbackInputPlan = {
  hasDisplayedMessages: false,
  fallbackIndex: -1,
};

const CHAT_PREPEND_ANCHOR_FAILURE_EFFECT_NONE_PLAN: ChatPrependAnchorFailureEffectIntentPlan = {
  kind: 'none',
  clearFallbackScrollPayload: null,
  retrySchedulePlan: null,
};

const CHAT_PREPEND_ANCHOR_FAILURE_EFFECT_EXECUTION_NOOP_PLAN: ChatPrependAnchorFailureEffectExecutionPlan = {
  shouldClearAnchor: false,
  clearFallbackScrollPayload: null,
  retryNextAnchor: null,
  retryDelayMs: 0,
};

const CHAT_PREPEND_ANCHOR_FAILURE_FALLBACK_RESOLUTION_PLANS: Record<
  ChatPrependAnchorFailureBranchKind,
  ChatPrependAnchorFailureFallbackResolutionPlan
> = {
  'missing-target': { shouldResolveFallback: true },
  'scroll-failed': { shouldResolveFallback: false },
};

const CHAT_PREPEND_ANCHOR_CAPTURE_NOOP_PLAN: ChatPrependAnchorCapturePlan = {
  shouldCapture: false,
  anchorId: null,
  anchorOffset: 0,
};

function createChatEnsureAnchorActionPlan(
  overrides?: Partial<ChatEnsureAnchorActionPlan>
): ChatEnsureAnchorActionPlan {
  return {
    ...CHAT_ENSURE_ANCHOR_ACTION_BASE,
    ...(overrides || {}),
  };
}

export function resolveChatPrependAnchorCaptureTriggerOffset(
  offset: unknown
): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset)) {
    return 0;
  }

  return Math.max(0, offset);
}

export function resolveChatEnsureAnchorActionPlan(
  input: ChatEnsureAnchorActionInput
): ChatEnsureAnchorActionPlan {
  if (!input.anchor) {
    return createChatEnsureAnchorActionPlan();
  }

  if (input.hasUserInteracted) {
    return createChatEnsureAnchorActionPlan({
      shouldStopStabilization: true,
    });
  }

  if (
    input.startedAtMs > 0 &&
    input.nowMs - input.startedAtMs >= Math.max(0, input.stabilizeMs)
  ) {
    return createChatEnsureAnchorActionPlan({
      shouldStopStabilization: true,
    });
  }

  if (input.anchor.type === 'bottom') {
    return createChatEnsureAnchorActionPlan({
      shouldScrollBottom: true,
    });
  }

  if (input.anchor.type === 'message' && input.anchor.id) {
    return createChatEnsureAnchorActionPlan({
      shouldScrollMessage: true,
      messageId: input.anchor.id,
    });
  }

  return createChatEnsureAnchorActionPlan();
}

export function resolveChatBottomAnchorAttemptPlan(
  input: ChatBottomAnchorAttemptInput
): ChatBottomAnchorAttemptPlan {
  if (input.hasAnchoredInitialScroll && !input.force) {
    return {
      shouldAnchor: false,
      shouldSkipAsAlreadyAnchored: true,
      shouldDeferForLayout: false,
    };
  }

  if (input.contentHeight <= 0 || input.layoutHeight <= 0) {
    return {
      shouldAnchor: false,
      shouldSkipAsAlreadyAnchored: false,
      shouldDeferForLayout: true,
    };
  }

  return {
    shouldAnchor: true,
    shouldSkipAsAlreadyAnchored: false,
    shouldDeferForLayout: false,
  };
}

export function resolveChatPrependAnchorRetryPlan(
  input: ChatPrependAnchorRetryPlanInput
): ChatPrependAnchorRetryPlan {
  if (input.attempts >= input.maxAttempts) {
    return {
      shouldClearAnchor: true,
      shouldRetry: false,
      nextAttempts: input.attempts,
    };
  }

  return {
    shouldClearAnchor: false,
    shouldRetry: true,
    nextAttempts: input.attempts + 1,
  };
}

export function resolveChatPrependAnchorRetrySchedulePlan(
  input: ChatPrependAnchorRetrySchedulePlanInput
): ChatPrependAnchorRetrySchedulePlan {
  if (!input.retryPlan.shouldRetry) {
    return CHAT_PREPEND_ANCHOR_RETRY_SCHEDULE_NOOP_PLAN;
  }

  const delayCandidate = Number(input.retryDelayMs);
  const retryDelayMs =
    Number.isFinite(delayCandidate) && delayCandidate >= 0
      ? Math.trunc(delayCandidate)
      : CHAT_PREPEND_ANCHOR_RETRY_DEFAULT_DELAY_MS;

  return {
    shouldScheduleRetry: true,
    nextAnchor: {
      id: input.anchorId,
      offset: input.anchorOffset,
      attempts: input.retryPlan.nextAttempts,
    },
    retryDelayMs,
  };
}

export function resolveChatPrependAnchorFallbackPlan(
  input: ChatPrependAnchorFallbackPlanInput
): ChatPrependAnchorFallbackPlan {
  if (!input.hasDisplayedMessages || input.fallbackIndex < 0) {
    return CHAT_PREPEND_ANCHOR_FALLBACK_NOOP_PLAN;
  }

  return {
    shouldScrollToIndex: true,
    targetIndex: input.fallbackIndex,
  };
}

export function resolveChatPrependAnchorClearPlan(
  input: ChatPrependAnchorClearPlanInput
): ChatPrependAnchorClearPlan {
  if (!input.retryPlan.shouldClearAnchor) {
    return {
      shouldClearAnchor: false,
      fallbackPlan: CHAT_PREPEND_ANCHOR_FALLBACK_NOOP_PLAN,
    };
  }

  if (!input.shouldResolveFallback) {
    return {
      shouldClearAnchor: true,
      fallbackPlan: CHAT_PREPEND_ANCHOR_FALLBACK_NOOP_PLAN,
    };
  }

  const fallbackIndex =
    typeof input.fallbackIndex === 'number' && Number.isFinite(input.fallbackIndex)
      ? Math.trunc(input.fallbackIndex)
      : -1;

  return {
    shouldClearAnchor: true,
    fallbackPlan: resolveChatPrependAnchorFallbackPlan({
      hasDisplayedMessages: input.hasDisplayedMessages === true,
      fallbackIndex,
    }),
  };
}

export function resolveChatPrependAnchorFailurePlan(
  input: ChatPrependAnchorFailurePlanInput
): ChatPrependAnchorFailurePlan {
  const retryPlan = resolveChatPrependAnchorRetryPlan({
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
  });

  const clearPlan = resolveChatPrependAnchorClearPlan({
    retryPlan,
    shouldResolveFallback: input.shouldResolveFallback,
    hasDisplayedMessages: input.hasDisplayedMessages,
    fallbackIndex: input.fallbackIndex,
  });

  return {
    retryPlan,
    clearPlan,
    shouldRetry: retryPlan.shouldRetry && !clearPlan.shouldClearAnchor,
  };
}

export function resolveChatPrependAnchorFailurePlanInput(
  input: ChatPrependAnchorFailurePlanInputPlanInput
): ChatPrependAnchorFailurePlanInput {
  const attemptsCandidate = Number(input.attempts);
  const maxAttemptsCandidate = Number(input.maxAttempts);
  const fallbackIndexCandidate = Number(input.fallbackIndex);

  return {
    attempts:
      Number.isFinite(attemptsCandidate) && attemptsCandidate >= 0
        ? Math.trunc(attemptsCandidate)
        : 0,
    maxAttempts:
      Number.isFinite(maxAttemptsCandidate) && maxAttemptsCandidate >= 0
        ? Math.trunc(maxAttemptsCandidate)
        : 0,
    shouldResolveFallback: input.shouldResolveFallback === true,
    hasDisplayedMessages:
      input.shouldResolveFallback && input.hasDisplayedMessages === true,
    fallbackIndex:
      Number.isFinite(fallbackIndexCandidate)
        ? Math.trunc(fallbackIndexCandidate)
        : -1,
  };
}

export function resolveChatPrependAnchorFailureFallbackInputPlan(
  input: ChatPrependAnchorFailureFallbackInputPlanInput
): ChatPrependAnchorFailureFallbackInputPlan {
  if (!input.shouldResolveFallback) {
    return CHAT_PREPEND_ANCHOR_FAILURE_FALLBACK_INPUT_NOOP_PLAN;
  }

  const fallbackIndexCandidate = Number(input.fallbackIndex);

  return {
    hasDisplayedMessages:
      Array.isArray(input.displayedMessages) && input.displayedMessages.length > 0,
    fallbackIndex:
      Number.isFinite(fallbackIndexCandidate)
        ? Math.trunc(fallbackIndexCandidate)
        : -1,
  };
}

export function resolveChatPrependAnchorFailureRetrySchedulePlan(
  input: ChatPrependAnchorFailureRetrySchedulePlanInput
): ChatPrependAnchorRetrySchedulePlan {
  if (!input.failurePlan.shouldRetry) {
    return CHAT_PREPEND_ANCHOR_RETRY_SCHEDULE_NOOP_PLAN;
  }

  return resolveChatPrependAnchorRetrySchedulePlan({
    retryPlan: input.failurePlan.retryPlan,
    anchorId: input.anchorId,
    anchorOffset: input.anchorOffset,
    retryDelayMs: input.retryDelayMs,
  });
}

export function resolveChatPrependAnchorFailureClearActionPlan(
  input: ChatPrependAnchorFailureClearActionPlanInput
): ChatPrependAnchorFailureClearActionPlan {
  if (!input.failurePlan.clearPlan.shouldClearAnchor) {
    return CHAT_PREPEND_ANCHOR_FAILURE_CLEAR_ACTION_NOOP_PLAN;
  }

  return {
    shouldClearAnchor: true,
    fallbackScrollPlan: resolveChatPrependAnchorFallbackScrollPlan({
      fallbackPlan: input.failurePlan.clearPlan.fallbackPlan,
      anchorOffset: input.anchorOffset,
    }),
  };
}

export function resolveChatPrependAnchorFailureActionPlans(
  input: ChatPrependAnchorFailureActionPlansInput
): ChatPrependAnchorFailureActionPlans {
  return {
    clearActionPlan: resolveChatPrependAnchorFailureClearActionPlan({
      failurePlan: input.failurePlan,
      anchorOffset: input.anchorOffset,
    }),
    retrySchedulePlan: resolveChatPrependAnchorFailureRetrySchedulePlan({
      failurePlan: input.failurePlan,
      anchorId: input.anchorId,
      anchorOffset: input.anchorOffset,
      retryDelayMs: input.retryDelayMs,
    }),
  };
}

export function resolveChatPrependAnchorFailureActionPlansFromInput(
  input: ChatPrependAnchorFailureActionPlansFromInputInput
): ChatPrependAnchorFailureActionPlans {
  const failurePlan = resolveChatPrependAnchorFailurePlan(
    resolveChatPrependAnchorFailurePlanInput({
      attempts: input.attempts,
      maxAttempts: input.maxAttempts,
      shouldResolveFallback: input.shouldResolveFallback,
      hasDisplayedMessages: input.hasDisplayedMessages,
      fallbackIndex: input.fallbackIndex,
    })
  );

  return resolveChatPrependAnchorFailureActionPlans({
    failurePlan,
    anchorId: input.anchorId,
    anchorOffset: input.anchorOffset,
    retryDelayMs: input.retryDelayMs,
  });
}

export function resolveChatPrependAnchorFailureActionPlansRawInputPlan(
  input: ChatPrependAnchorFailureActionPlansRawInputPlanInput
): ChatPrependAnchorFailureActionPlansFromInputInput {
  const fallbackInputPlan = input.fallbackInputPlan ||
    CHAT_PREPEND_ANCHOR_FAILURE_FALLBACK_INPUT_NOOP_PLAN;

  return {
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
    shouldResolveFallback: input.shouldResolveFallback,
    hasDisplayedMessages: input.shouldResolveFallback
      ? fallbackInputPlan.hasDisplayedMessages
      : false,
    fallbackIndex: input.shouldResolveFallback
      ? fallbackInputPlan.fallbackIndex
      : -1,
    anchorId: input.anchorId,
    anchorOffset: input.anchorOffset,
    retryDelayMs: input.retryDelayMs,
  };
}

export function resolveChatPrependAnchorFailureAnchorContextPlan(
  input: ChatPrependAnchorFailureAnchorContextPlanInput
): ChatPrependAnchorFailureAnchorContextPlan {
  const attemptsCandidate = Number(input.anchorAttempts);
  const maxAttemptsCandidate = Number(input.maxAttempts);
  const anchorOffsetCandidate = Number(input.anchorOffset);
  const retryDelayCandidate = Number(input.retryDelayMs);

  return {
    attempts:
      Number.isFinite(attemptsCandidate) && attemptsCandidate >= 0
        ? Math.trunc(attemptsCandidate)
        : 0,
    maxAttempts:
      Number.isFinite(maxAttemptsCandidate) && maxAttemptsCandidate >= 0
        ? Math.trunc(maxAttemptsCandidate)
        : 0,
    anchorId: String(input.anchorId ?? ''),
    anchorOffset:
      Number.isFinite(anchorOffsetCandidate) && anchorOffsetCandidate >= 0
        ? anchorOffsetCandidate
        : 0,
    retryDelayMs:
      Number.isFinite(retryDelayCandidate) && retryDelayCandidate >= 0
        ? Math.trunc(retryDelayCandidate)
        : undefined,
  };
}

export function resolveChatPrependAnchorFailureActionPlansFromContext(
  input: ChatPrependAnchorFailureActionPlansFromContextInput
): ChatPrependAnchorFailureActionPlans {
  const fallbackResolutionPlan =
    resolveChatPrependAnchorFailureFallbackResolutionPlan(input.branchKind);
  const fallbackInputPlan = resolveChatPrependAnchorFailureFallbackInputPlan({
    shouldResolveFallback: fallbackResolutionPlan.shouldResolveFallback,
    displayedMessages: input.displayedMessages,
    fallbackIndex: input.fallbackIndex,
  });

  return resolveChatPrependAnchorFailureActionPlansFromInput(
    resolveChatPrependAnchorFailureActionPlansRawInputPlan({
      ...input.anchorContextPlan,
      shouldResolveFallback: fallbackResolutionPlan.shouldResolveFallback,
      fallbackInputPlan,
    })
  );
}

export function resolveChatPrependAnchorFailureFallbackResolutionPlan(
  branchKind: ChatPrependAnchorFailureBranchKind
): ChatPrependAnchorFailureFallbackResolutionPlan {
  return CHAT_PREPEND_ANCHOR_FAILURE_FALLBACK_RESOLUTION_PLANS[branchKind];
}

export function resolveChatPrependAnchorFailureEffectIntentFromContext(
  input: ChatPrependAnchorFailureEffectIntentFromContextInput
): ChatPrependAnchorFailureEffectIntentPlan {
  return resolveChatPrependAnchorFailureEffectIntentPlan(
    resolveChatPrependAnchorFailureActionPlansFromContext({
      anchorContextPlan: input.anchorContextPlan,
      branchKind: input.branchKind,
      displayedMessages: input.displayedMessages,
      fallbackIndex: input.fallbackIndex,
    })
  );
}

export function resolveChatPrependAnchorFailureEffectExecutionFromContext(
  input: ChatPrependAnchorFailureEffectIntentFromContextInput
): ChatPrependAnchorFailureEffectExecutionPlan {
  return resolveChatPrependAnchorFailureEffectExecutionPlan(
    resolveChatPrependAnchorFailureEffectIntentFromContext(input)
  );
}

export function resolveChatPrependAnchorFailureExecutionContextPlan(
  input: ChatPrependAnchorFailureExecutionContextPlanInput
): ChatPrependAnchorFailureExecutionContextPlan {
  if (input.branchKind === 'missing-target') {
    return {
      branchKind: 'missing-target',
      displayedMessages: input.displayedMessages,
      fallbackIndex:
        input.displayedMessageIndexById?.get(String(input.anchorId)) ?? -1,
    };
  }

  return {
    branchKind: 'scroll-failed',
  };
}

export function resolveChatPrependAnchorFailureEffectExecutionForAnchor(
  input: ChatPrependAnchorFailureEffectExecutionForAnchorInput
): ChatPrependAnchorFailureEffectExecutionPlan {
  const executionContextPlan = resolveChatPrependAnchorFailureExecutionContextPlan(
    {
      branchKind: input.branchKind,
      anchorId: input.anchorId,
      displayedMessages: input.displayedMessages,
      displayedMessageIndexById: input.displayedMessageIndexById,
    }
  );

  return resolveChatPrependAnchorFailureEffectExecutionFromContext({
    anchorContextPlan: input.anchorContextPlan,
    branchKind: executionContextPlan.branchKind,
    displayedMessages: executionContextPlan.displayedMessages,
    fallbackIndex: executionContextPlan.fallbackIndex,
  });
}

export function resolveChatPrependAnchorFailureEffectExecutionPlansForAnchor(
  input: ChatPrependAnchorFailureEffectExecutionPlansForAnchorInput
): ChatPrependAnchorFailureEffectExecutionPlansForAnchor {
  return {
    missingTargetExecutionPlan:
      resolveChatPrependAnchorFailureEffectExecutionForAnchor({
        anchorContextPlan: input.anchorContextPlan,
        branchKind: 'missing-target',
        anchorId: input.anchorId,
        displayedMessages: input.displayedMessages,
        displayedMessageIndexById: input.displayedMessageIndexById,
      }),
    scrollFailedExecutionPlan:
      resolveChatPrependAnchorFailureEffectExecutionForAnchor({
        anchorContextPlan: input.anchorContextPlan,
        branchKind: 'scroll-failed',
        anchorId: input.anchorId,
        displayedMessages: input.displayedMessages,
        displayedMessageIndexById: input.displayedMessageIndexById,
      }),
  };
}

export function resolveChatPrependAnchorFailureRestorePlans(
  input: ChatPrependAnchorFailureRestorePlansInput
): ChatPrependAnchorFailureRestorePlans {
  const anchorContextPlan = resolveChatPrependAnchorFailureAnchorContextPlan({
    anchorAttempts: input.anchorAttempts,
    maxAttempts: input.maxAttempts,
    anchorId: input.anchorId,
    anchorOffset: input.anchorOffset,
  });

  return {
    anchorContextPlan,
    failureExecutionPlans:
      resolveChatPrependAnchorFailureEffectExecutionPlansForAnchor({
        anchorContextPlan,
        anchorId: input.anchorId,
        displayedMessages: input.displayedMessages,
        displayedMessageIndexById: input.displayedMessageIndexById,
      }),
  };
}

export function resolveChatPrependAnchorFailureExecutionPlanForRestore(
  input: ChatPrependAnchorFailureExecutionPlanForRestoreInput
): ChatPrependAnchorFailureEffectExecutionPlan {
  const { targetExists, ...restorePlansInput } = input;
  const { failureExecutionPlans } =
    resolveChatPrependAnchorFailureRestorePlans(restorePlansInput);

  return resolveChatPrependAnchorFailureExecutionSelectionPlan({
    targetExists,
    failureExecutionPlans,
  });
}

export function resolveChatPrependAnchorFailureExecutionSelectionPlan(
  input: ChatPrependAnchorFailureExecutionSelectionPlanInput
): ChatPrependAnchorFailureEffectExecutionPlan {
  return input.targetExists
    ? input.failureExecutionPlans.scrollFailedExecutionPlan
    : input.failureExecutionPlans.missingTargetExecutionPlan;
}

export function resolveChatPrependAnchorFailureEffectIntentPlan(
  failureActionPlans: ChatPrependAnchorFailureActionPlans
): ChatPrependAnchorFailureEffectIntentPlan {
  if (failureActionPlans.clearActionPlan.shouldClearAnchor) {
    return {
      kind: 'clear',
      clearFallbackScrollPayload:
        failureActionPlans.clearActionPlan.fallbackScrollPlan.payload,
      retrySchedulePlan: null,
    };
  }

  if (
    failureActionPlans.retrySchedulePlan.shouldScheduleRetry &&
    failureActionPlans.retrySchedulePlan.nextAnchor
  ) {
    return {
      kind: 'retry',
      clearFallbackScrollPayload: null,
      retrySchedulePlan: failureActionPlans.retrySchedulePlan,
    };
  }

  return CHAT_PREPEND_ANCHOR_FAILURE_EFFECT_NONE_PLAN;
}

export function resolveChatPrependAnchorFailureEffectExecutionPlan(
  failureIntentPlan: ChatPrependAnchorFailureEffectIntentPlan
): ChatPrependAnchorFailureEffectExecutionPlan {
  if (failureIntentPlan.kind === 'clear') {
    return {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: failureIntentPlan.clearFallbackScrollPayload,
      retryNextAnchor: null,
      retryDelayMs: 0,
    };
  }

  if (failureIntentPlan.kind === 'retry' && failureIntentPlan.retrySchedulePlan) {
    return {
      shouldClearAnchor: false,
      clearFallbackScrollPayload: null,
      retryNextAnchor: failureIntentPlan.retrySchedulePlan.nextAnchor,
      retryDelayMs: failureIntentPlan.retrySchedulePlan.retryDelayMs,
    };
  }

  return CHAT_PREPEND_ANCHOR_FAILURE_EFFECT_EXECUTION_NOOP_PLAN;
}

export function resolveChatPrependAnchorFallbackScrollPlan(
  input: ChatPrependAnchorFallbackScrollPlanInput
): ChatPrependAnchorFallbackScrollPlan {
  if (
    !input.fallbackPlan.shouldScrollToIndex ||
    input.fallbackPlan.targetIndex === null
  ) {
    return CHAT_PREPEND_ANCHOR_FALLBACK_SCROLL_NOOP_PLAN;
  }

  const viewOffset =
    Number.isFinite(input.anchorOffset) && input.anchorOffset > 0
      ? Math.trunc(input.anchorOffset)
      : 0;

  return {
    shouldInvokeScrollToIndex: true,
    payload: {
      index: input.fallbackPlan.targetIndex,
      animated: false,
      viewPosition: 0,
      viewOffset,
    },
  };
}

export function resolveChatPrependAnchorRestoreOffsetPlan(
  input: ChatPrependAnchorRestoreOffsetPlanInput
): ChatPrependAnchorRestoreOffsetPlan {
  const normalizedTargetY =
    typeof input.targetY === 'number' && Number.isFinite(input.targetY)
      ? input.targetY
      : 0;
  const normalizedAnchorOffset =
    typeof input.anchorOffset === 'number' && Number.isFinite(input.anchorOffset)
      ? input.anchorOffset
      : 0;

  return {
    payload: {
      offset: Math.max(0, normalizedTargetY + normalizedAnchorOffset),
      animated: false,
    },
  };
}

export function resolveChatPrependAnchorCapturePlan(
  input: ChatPrependAnchorCapturePlanInput
): ChatPrependAnchorCapturePlan {
  if (
    !input.shouldUseManualAnchorPreservation ||
    input.hasPendingAnchor ||
    !input.topVisibleId
  ) {
    return CHAT_PREPEND_ANCHOR_CAPTURE_NOOP_PLAN;
  }

  const topVisibleY =
    typeof input.topVisibleY === 'number' && Number.isFinite(input.topVisibleY)
      ? input.topVisibleY
      : 0;

  return {
    shouldCapture: true,
    anchorId: input.topVisibleId,
    anchorOffset: Math.max(0, input.currentOffset - topVisibleY),
  };
}
