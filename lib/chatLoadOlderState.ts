export type ChatLoadOlderReason = 'auto' | 'manual';

export interface ChatLoadOlderStartPlanInput {
  reason: ChatLoadOlderReason;
  alreadyAtStart: boolean;
  isLoadOlderLocked: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  hasAttemptedBefore: boolean;
  hasLoadMoreFunction: boolean;
}

export interface ChatLoadOlderStartPlan {
  shouldProceed: boolean;
  shouldShowReachedStartToast: boolean;
}

export interface ChatReachedConversationStartPlanInput {
  isLoadingMore: boolean;
  hasMore: boolean;
  loadOlderAttempts: number;
}

export interface ChatReachedConversationStartPlan {
  shouldUpdate: boolean;
  nextReachedConversationStart: boolean;
}

export interface ChatLoadOlderFailurePlan {
  shouldClearPendingPrependAnchor: boolean;
}

export interface ChatLoadOlderFailureLogPayload {
  reason: ChatLoadOlderReason;
  error: unknown;
}

export interface ChatLoadOlderConversationResetPlan {
  nextLoadOlderAttempts: number;
  nextReachedConversationStart: boolean;
  shouldResetAutoLoadAnchor: boolean;
}

export interface ChatLoadOlderRunStartPlan {
  nextLoadOlderAttempts: number;
  shouldLockLoadOlder: boolean;
}

export interface ChatLoadOlderRunFinalizePlan {
  shouldUnlockLoadOlder: boolean;
}

export interface ChatLoadOlderRunCompletionPlan {
  shouldResetAutoLoadAnchor: boolean;
  shouldUnlockLoadOlder: boolean;
}

export interface ChatLoadOlderRetryAttemptPlanInput {
  reason: ChatLoadOlderReason;
  firstAttemptAdded: boolean;
  hasMore: boolean;
  hasManualLoadOptions: boolean;
}

export interface ChatLoadOlderRetryAttemptPlan {
  shouldRunRetryAttempt: boolean;
}

export interface ChatLoadOlderToastPayload {
  type: 'info';
  text1: string;
  text2: string;
  position: 'top';
}

export interface ChatLoadOlderToastEmissionPlan {
  shouldShow: boolean;
  payload: ChatLoadOlderToastPayload | null;
}

export type ChatLoadOlderToastKind = 'reached-start' | 'syncing';

const CHAT_LOAD_OLDER_START_BLOCKED_PLAN: ChatLoadOlderStartPlan = {
  shouldProceed: false,
  shouldShowReachedStartToast: false,
};

const CHAT_LOAD_OLDER_START_ALLOWED_PLAN: ChatLoadOlderStartPlan = {
  shouldProceed: true,
  shouldShowReachedStartToast: false,
};

const CHAT_LOAD_OLDER_REACHED_START_NOOP_PLAN: ChatReachedConversationStartPlan = {
  shouldUpdate: false,
  nextReachedConversationStart: false,
};

const CHAT_LOAD_OLDER_REACHED_START_CLEAR_PLAN: ChatReachedConversationStartPlan = {
  shouldUpdate: true,
  nextReachedConversationStart: false,
};

const CHAT_LOAD_OLDER_REACHED_START_SET_PLAN: ChatReachedConversationStartPlan = {
  shouldUpdate: true,
  nextReachedConversationStart: true,
};

const CHAT_LOAD_OLDER_FAILURE_PLAN: ChatLoadOlderFailurePlan = {
  shouldClearPendingPrependAnchor: true,
};

const CHAT_LOAD_OLDER_CONVERSATION_RESET_PLAN: ChatLoadOlderConversationResetPlan = {
  nextLoadOlderAttempts: 0,
  nextReachedConversationStart: false,
  shouldResetAutoLoadAnchor: true,
};

const CHAT_LOAD_OLDER_RUN_FINALIZE_PLAN: ChatLoadOlderRunFinalizePlan = {
  shouldUnlockLoadOlder: true,
};

const CHAT_LOAD_OLDER_MANUAL_ATTEMPT_OPTIONS: {
  aggressive: true;
  force: true;
} = {
  aggressive: true,
  force: true,
};

const CHAT_LOAD_OLDER_RETRY_ATTEMPT_PLAN_NOOP: ChatLoadOlderRetryAttemptPlan = {
  shouldRunRetryAttempt: false,
};

const CHAT_LOAD_OLDER_RETRY_ATTEMPT_PLAN_RUN: ChatLoadOlderRetryAttemptPlan = {
  shouldRunRetryAttempt: true,
};

const CHAT_LOAD_OLDER_TOAST_EMISSION_NOOP_PLAN: ChatLoadOlderToastEmissionPlan = {
  shouldShow: false,
  payload: null,
};

function createChatLoadOlderStartPlan(
  overrides?: Partial<ChatLoadOlderStartPlan>
): ChatLoadOlderStartPlan {
  return {
    ...CHAT_LOAD_OLDER_START_BLOCKED_PLAN,
    ...(overrides || {}),
  };
}

function resolveChatLoadOlderAttemptBaseCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

const CHAT_LOAD_OLDER_TOAST_PAYLOADS: Record<
  ChatLoadOlderToastKind,
  ChatLoadOlderToastPayload
> = {
  'reached-start': {
    type: 'info',
    text1: 'No older messages',
    text2: 'You have reached the beginning of this chat history.',
    position: 'top',
  },
  syncing: {
    type: 'info',
    text1: 'Syncing older messages…',
    text2: 'Fetching a fuller history from the server.',
    position: 'top',
  },
};

const CHAT_LOAD_OLDER_TOAST_EMISSION_PLANS: Record<
  ChatLoadOlderToastKind,
  ChatLoadOlderToastEmissionPlan
> = {
  'reached-start': {
    shouldShow: true,
    payload: CHAT_LOAD_OLDER_TOAST_PAYLOADS['reached-start'],
  },
  syncing: {
    shouldShow: true,
    payload: CHAT_LOAD_OLDER_TOAST_PAYLOADS.syncing,
  },
};

function resolveChatLoadOlderToastPayload(
  kind: ChatLoadOlderToastKind
): ChatLoadOlderToastPayload {
  return CHAT_LOAD_OLDER_TOAST_PAYLOADS[kind];
}

function resolveChatLoadOlderToastEmissionPlan(
  kind: ChatLoadOlderToastKind,
  shouldShow: boolean
): ChatLoadOlderToastEmissionPlan {
  if (!shouldShow) {
    return CHAT_LOAD_OLDER_TOAST_EMISSION_NOOP_PLAN;
  }

  return CHAT_LOAD_OLDER_TOAST_EMISSION_PLANS[kind];
}

export function resolveChatLoadOlderStartPlan(
  input: ChatLoadOlderStartPlanInput
): ChatLoadOlderStartPlan {
  if (input.isLoadOlderLocked || input.isLoadingMore) {
    return CHAT_LOAD_OLDER_START_BLOCKED_PLAN;
  }

  if (input.alreadyAtStart) {
    return createChatLoadOlderStartPlan({
      shouldShowReachedStartToast: input.reason === 'manual',
    });
  }

  if (!input.hasMore && input.reason === 'auto' && input.hasAttemptedBefore) {
    return CHAT_LOAD_OLDER_START_BLOCKED_PLAN;
  }

  if (!input.hasLoadMoreFunction) {
    return CHAT_LOAD_OLDER_START_BLOCKED_PLAN;
  }

  return CHAT_LOAD_OLDER_START_ALLOWED_PLAN;
}

export function resolveChatLoadOlderAttemptOptions(
  reason: ChatLoadOlderReason
): { aggressive: true; force: true } | undefined {
  if (reason !== 'manual') {
    return undefined;
  }

  return CHAT_LOAD_OLDER_MANUAL_ATTEMPT_OPTIONS;
}

export function shouldRetryChatLoadOlder(
  reason: ChatLoadOlderReason,
  added: boolean,
  hasMore: boolean
): boolean {
  return reason === 'manual' && !added && hasMore;
}

export function shouldShowChatLoadOlderSyncingToast(
  reason: ChatLoadOlderReason,
  added: boolean,
  hasMore: boolean
): boolean {
  return shouldRetryChatLoadOlder(reason, added, hasMore);
}

export function shouldResetChatLoadOlderAutoLoadAnchor(
  reason: ChatLoadOlderReason,
  added: boolean
): boolean {
  return reason === 'auto' && !added;
}

export function resolveChatReachedConversationStartPlan(
  input: ChatReachedConversationStartPlanInput
): ChatReachedConversationStartPlan {
  if (input.isLoadingMore) {
    return CHAT_LOAD_OLDER_REACHED_START_NOOP_PLAN;
  }

  if (input.hasMore) {
    return CHAT_LOAD_OLDER_REACHED_START_CLEAR_PLAN;
  }

  if (input.loadOlderAttempts > 0) {
    return CHAT_LOAD_OLDER_REACHED_START_SET_PLAN;
  }

  return CHAT_LOAD_OLDER_REACHED_START_NOOP_PLAN;
}

export function resolveChatLoadOlderFailurePlan(): ChatLoadOlderFailurePlan {
  return CHAT_LOAD_OLDER_FAILURE_PLAN;
}

export function resolveChatLoadOlderFailureLogPayload(
  reason: ChatLoadOlderReason,
  error: unknown
): ChatLoadOlderFailureLogPayload {
  return {
    reason,
    error,
  };
}

export function resolveChatLoadOlderConversationResetPlan(): ChatLoadOlderConversationResetPlan {
  return CHAT_LOAD_OLDER_CONVERSATION_RESET_PLAN;
}

export function resolveChatLoadOlderRunStartPlan(
  currentLoadOlderAttempts: number
): ChatLoadOlderRunStartPlan {
  return {
    nextLoadOlderAttempts:
      resolveChatLoadOlderAttemptBaseCount(currentLoadOlderAttempts) + 1,
    shouldLockLoadOlder: true,
  };
}

export function resolveChatLoadOlderRunFinalizePlan(): ChatLoadOlderRunFinalizePlan {
  return CHAT_LOAD_OLDER_RUN_FINALIZE_PLAN;
}

export function resolveChatLoadOlderRunCompletionPlan(
  reason: ChatLoadOlderReason,
  added: boolean
): ChatLoadOlderRunCompletionPlan {
  return {
    shouldResetAutoLoadAnchor: shouldResetChatLoadOlderAutoLoadAnchor(reason, added),
    shouldUnlockLoadOlder: CHAT_LOAD_OLDER_RUN_FINALIZE_PLAN.shouldUnlockLoadOlder,
  };
}

export function resolveChatLoadOlderRetryAttemptPlan(
  input: ChatLoadOlderRetryAttemptPlanInput
): ChatLoadOlderRetryAttemptPlan {
  const shouldRunRetryAttempt =
    shouldRetryChatLoadOlder(
      input.reason,
      input.firstAttemptAdded,
      input.hasMore
    ) && input.hasManualLoadOptions;

  return shouldRunRetryAttempt
    ? CHAT_LOAD_OLDER_RETRY_ATTEMPT_PLAN_RUN
    : CHAT_LOAD_OLDER_RETRY_ATTEMPT_PLAN_NOOP;
}

export function resolveChatLoadOlderFinalAddedState(
  firstAttemptAdded: boolean,
  retryAttemptAdded?: boolean
): boolean {
  if (typeof retryAttemptAdded === 'boolean') {
    return retryAttemptAdded;
  }

  return firstAttemptAdded;
}

export function resolveChatLoadOlderReachedStartToastPayload(): ChatLoadOlderToastPayload {
  return resolveChatLoadOlderToastPayload('reached-start');
}

export function resolveChatLoadOlderReachedStartToastEmissionPlan(
  shouldShowReachedStartToast: boolean
): ChatLoadOlderToastEmissionPlan {
  return resolveChatLoadOlderToastEmissionPlan(
    'reached-start',
    shouldShowReachedStartToast
  );
}

export function resolveChatLoadOlderSyncingToastPayload(): ChatLoadOlderToastPayload {
  return resolveChatLoadOlderToastPayload('syncing');
}

export function resolveChatLoadOlderSyncingToastEmissionPlan(
  reason: ChatLoadOlderReason,
  added: boolean,
  hasMore: boolean
): ChatLoadOlderToastEmissionPlan {
  const shouldShow = shouldRetryChatLoadOlder(reason, added, hasMore);
  return resolveChatLoadOlderToastEmissionPlan('syncing', shouldShow);
}
