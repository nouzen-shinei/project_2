export interface ChatPendingRetrySummaryToastPayload {
  type: 'success' | 'info' | 'error';
  text1: string;
  text2: string;
  position: 'top';
}

export interface ResolveChatPendingRetrySummaryToastPayloadInput {
  successCount: number;
  totalCount: number;
}

function normalizeCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

export function resolveChatPendingRetrySuccessCount(
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

export function resolveChatPendingRetrySummaryToastPayload(
  input: ResolveChatPendingRetrySummaryToastPayloadInput
): ChatPendingRetrySummaryToastPayload {
  const totalCount = normalizeCount(input.totalCount);
  const successCount = Math.min(totalCount, normalizeCount(input.successCount));

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
