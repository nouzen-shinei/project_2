export interface ChatPendingCancelAllGuardInput {
  selectedRecipientId: unknown;
  totalCount: number;
  isCancelingAllPending: boolean;
}

export interface ChatPendingCancelAllGuardResult {
  shouldRun: boolean;
}

function normalizeCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

/**
 * Cancel-all is a purely local operation (no network round trip), so unlike
 * the retry-all guard it does not need to check offline state.
 */
export function resolveChatPendingCancelAllGuard(
  input: ChatPendingCancelAllGuardInput
): ChatPendingCancelAllGuardResult {
  if (!input.selectedRecipientId) {
    return { shouldRun: false };
  }

  if (normalizeCount(input.totalCount) === 0 || input.isCancelingAllPending) {
    return { shouldRun: false };
  }

  return { shouldRun: true };
}
