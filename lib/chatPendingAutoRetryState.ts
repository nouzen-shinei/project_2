export interface ChatPendingAutoRetryPlanInput {
  isOffline: boolean;
  pendingMessageCount: number;
  defaultDelayMs?: number;
}

export interface ChatPendingAutoRetryPlan {
  shouldSchedule: boolean;
  delayMs: number;
}

function normalizeDelay(value: unknown, fallback = 1000): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return Math.trunc(numeric);
}

function normalizeCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

export function resolveChatPendingAutoRetryPlan(
  input: ChatPendingAutoRetryPlanInput
): ChatPendingAutoRetryPlan {
  const pendingMessageCount = normalizeCount(input.pendingMessageCount);

  if (input.isOffline || pendingMessageCount === 0) {
    return {
      shouldSchedule: false,
      delayMs: 0,
    };
  }

  return {
    shouldSchedule: true,
    delayMs: normalizeDelay(input.defaultDelayMs, 1000),
  };
}
