export interface ChatPendingRetryAllGuardInput {
  selectedRecipientId: unknown;
  isOffline: boolean;
  totalCount: number;
  isRetryingAllPending: boolean;
}

export interface ChatPendingRetryAllGuardResult {
  shouldRun: boolean;
  toastPayload?: {
    type: 'info';
    text1: 'Offline';
    text2: 'Reconnect to retry pending messages.';
    position: 'top';
  };
}

function normalizeCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

export function resolveChatPendingRetryAllGuard(
  input: ChatPendingRetryAllGuardInput
): ChatPendingRetryAllGuardResult {
  if (!input.selectedRecipientId) {
    return {
      shouldRun: false,
    };
  }

  if (input.isOffline) {
    return {
      shouldRun: false,
      toastPayload: {
        type: 'info',
        text1: 'Offline',
        text2: 'Reconnect to retry pending messages.',
        position: 'top',
      },
    };
  }

  if (normalizeCount(input.totalCount) === 0 || input.isRetryingAllPending) {
    return {
      shouldRun: false,
    };
  }

  return {
    shouldRun: true,
  };
}
