export type PendingMessageStatus = 'queued' | 'sending' | 'sent' | 'failed';

export function normalizePendingMessageStatus(status: unknown): PendingMessageStatus {
  if (status === 'sending' || status === 'sent' || status === 'failed' || status === 'queued') {
    return status;
  }
  return 'queued';
}

export function shouldHidePendingMessageDuringTransition(
  pending: { status?: unknown; serverMessageId?: unknown } | null | undefined,
  deliveredMessageIds: Set<string>,
  normalizeMessageId: (id: unknown) => string
): boolean {
  if (!pending) {
    return false;
  }

  const normalizedStatus = normalizePendingMessageStatus(pending.status);
  if (normalizedStatus !== 'sent') {
    return false;
  }

  const serverMessageId = normalizeMessageId(pending.serverMessageId);
  return Boolean(serverMessageId && deliveredMessageIds.has(serverMessageId));
}
