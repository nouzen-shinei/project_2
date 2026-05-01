export interface ChatPendingRetrySummaryToastPayload {
  type: 'success' | 'info' | 'error';
  text1: string;
  text2: string;
  position: 'top';
}

export interface ChatPendingRetryOutcomeSummary {
  attemptedCount: number;
  successCount: number;
  failedCount: number;
  successRatio: number;
  toastPayload: ChatPendingRetrySummaryToastPayload;
}

function normalizeAttemptedCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function resolveChatPendingRetrySuccessCount(
  settledResults: PromiseSettledResult<boolean>[]
): number {
  if (!Array.isArray(settledResults) || settledResults.length === 0) {
    return 0;
  }

  return settledResults.reduce((count, result) => {
    if (result.status === 'fulfilled' && result.value === true) {
      return count + 1;
    }
    return count;
  }, 0);
}

function resolveChatPendingRetrySummaryToastPayload(
  successCount: number,
  totalCount: number
): ChatPendingRetrySummaryToastPayload {
  if (totalCount > 0 && successCount === totalCount) {
    return {
      type: 'success',
      text1: 'Retry Complete',
      text2: 'All pending items were sent.',
      position: 'top',
    };
  }

  if (successCount > 0) {
    return {
      type: 'info',
      text1: 'Partial Retry Success',
      text2: `${successCount} of ${totalCount} pending items were sent.`,
      position: 'top',
    };
  }

  return {
    type: 'error',
    text1: 'Retry Failed',
    text2: 'Could not resend pending items. Please try again.',
    position: 'top',
  };
}

export function resolveChatPendingRetryOutcomeSummary(
  settledResults: PromiseSettledResult<boolean>[],
  attemptedCount: number
): ChatPendingRetryOutcomeSummary {
  const normalizedAttemptedCount = normalizeAttemptedCount(attemptedCount);
  const successCount = Math.min(
    normalizedAttemptedCount,
    resolveChatPendingRetrySuccessCount(settledResults)
  );
  const failedCount = Math.max(0, normalizedAttemptedCount - successCount);
  const successRatio = clampRatio(
    normalizedAttemptedCount > 0 ? successCount / normalizedAttemptedCount : 0
  );

  return {
    attemptedCount: normalizedAttemptedCount,
    successCount,
    failedCount,
    successRatio,
    toastPayload: resolveChatPendingRetrySummaryToastPayload(
      successCount,
      normalizedAttemptedCount
    ),
  };
}
