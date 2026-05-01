export type ChatPrependAnchorFailureEffectExecutionPlan = {
  shouldClearAnchor: boolean;
  clearFallbackScrollPayload: {
    index: number;
    animated: boolean;
    viewPosition: number;
    viewOffset: number;
  } | null;
  retryNextAnchor: { id: string; offset: number; attempts: number } | null;
  retryDelayMs: number;
};

export type ChatPrependAnchorFailureBranchKind =
  | 'missing-target'
  | 'scroll-failed';

export type ChatPrependAnchorFailureBranchExecutionPlans = {
  missingTargetExecutionPlan: ChatPrependAnchorFailureEffectExecutionPlan;
  scrollFailedExecutionPlan: ChatPrependAnchorFailureEffectExecutionPlan;
};

export type ChatPendingPrependAnchorRefValue = {
  id: string;
  offset: number;
  attempts: number;
};

export type ChatMutableRefObject<T> = {
  current: T;
};

export type ChatPrependAnchorScrollable = {
  scrollToIndex?: (params: {
    index: number;
    animated?: boolean;
    viewPosition?: number;
    viewOffset?: number;
  }) => void;
  scrollToOffset?: (params: {
    offset: number;
    animated?: boolean;
  }) => void;
};

export function applyChatPrependAnchorFailureExecutionPlan(input: {
  executionPlan: ChatPrependAnchorFailureEffectExecutionPlan;
  pendingPrependAnchorRef: ChatMutableRefObject<
    ChatPendingPrependAnchorRefValue | null
  >;
  list: ChatPrependAnchorScrollable | null;
  scheduleRetry: () => void;
  scheduleTimeout?: (callback: () => void, delayMs: number) => void;
}): boolean {
  if (input.executionPlan.shouldClearAnchor) {
    input.pendingPrependAnchorRef.current = null;
    if (input.executionPlan.clearFallbackScrollPayload) {
      try {
        input.list?.scrollToIndex?.(input.executionPlan.clearFallbackScrollPayload);
      } catch {}
    }
    return true;
  }

  if (input.executionPlan.retryNextAnchor) {
    input.pendingPrependAnchorRef.current = input.executionPlan.retryNextAnchor;
    const scheduleTimeout =
      input.scheduleTimeout ??
      ((callback: () => void, delayMs: number) => {
        setTimeout(callback, delayMs);
      });
    scheduleTimeout(input.scheduleRetry, input.executionPlan.retryDelayMs);
  }

  return false;
}

export function createChatPrependAnchorFailureExecutor(input: {
  pendingPrependAnchorRef: ChatMutableRefObject<
    ChatPendingPrependAnchorRefValue | null
  >;
  list: ChatPrependAnchorScrollable | null;
  scheduleRetry: () => void;
  scheduleTimeout?: (callback: () => void, delayMs: number) => void;
}): (executionPlan: ChatPrependAnchorFailureEffectExecutionPlan) => boolean {
  return (executionPlan: ChatPrependAnchorFailureEffectExecutionPlan) => {
    return applyChatPrependAnchorFailureExecutionPlan({
      executionPlan,
      pendingPrependAnchorRef: input.pendingPrependAnchorRef,
      list: input.list,
      scheduleRetry: input.scheduleRetry,
      scheduleTimeout: input.scheduleTimeout,
    });
  };
}

export function createChatPrependAnchorFailureSelectedExecutor(
  input: {
    pendingPrependAnchorRef: ChatMutableRefObject<
      ChatPendingPrependAnchorRefValue | null
    >;
    list: ChatPrependAnchorScrollable | null;
    scheduleRetry: () => void;
    scheduleTimeout?: (callback: () => void, delayMs: number) => void;
  },
  executionPlan: ChatPrependAnchorFailureEffectExecutionPlan
): () => boolean {
  return () =>
    applyChatPrependAnchorFailureExecutionPlan({
      executionPlan,
      pendingPrependAnchorRef: input.pendingPrependAnchorRef,
      list: input.list,
      scheduleRetry: input.scheduleRetry,
      scheduleTimeout: input.scheduleTimeout,
    });
}

export function applyChatPrependAnchorFailureBranchExecution(input: {
  branchKind: ChatPrependAnchorFailureBranchKind;
  failureExecutionPlans: ChatPrependAnchorFailureBranchExecutionPlans;
  pendingPrependAnchorRef: ChatMutableRefObject<
    ChatPendingPrependAnchorRefValue | null
  >;
  list: ChatPrependAnchorScrollable | null;
  scheduleRetry: () => void;
  scheduleTimeout?: (callback: () => void, delayMs: number) => void;
}): boolean {
  const applyFailureExecutionPlan = createChatPrependAnchorFailureExecutor({
    pendingPrependAnchorRef: input.pendingPrependAnchorRef,
    list: input.list,
    scheduleRetry: input.scheduleRetry,
    scheduleTimeout: input.scheduleTimeout,
  });

  return applyFailureExecutionPlan(
    input.branchKind === 'missing-target'
      ? input.failureExecutionPlans.missingTargetExecutionPlan
      : input.failureExecutionPlans.scrollFailedExecutionPlan
  );
}

export function applyChatPrependAnchorRestoreWithFallback(input: {
  scrollAction: () => void;
  failureExecutionPlan: ChatPrependAnchorFailureEffectExecutionPlan;
  pendingPrependAnchorRef: ChatMutableRefObject<
    ChatPendingPrependAnchorRefValue | null
  >;
  list: ChatPrependAnchorScrollable | null;
  scheduleRetry: () => void;
  scheduleTimeout?: (callback: () => void, delayMs: number) => void;
}): void {
  try {
    input.scrollAction();
    input.pendingPrependAnchorRef.current = null;
  } catch {
    applyChatPrependAnchorFailureExecutionPlan({
      executionPlan: input.failureExecutionPlan,
      pendingPrependAnchorRef: input.pendingPrependAnchorRef,
      list: input.list,
      scheduleRetry: input.scheduleRetry,
      scheduleTimeout: input.scheduleTimeout,
    });
  }
}