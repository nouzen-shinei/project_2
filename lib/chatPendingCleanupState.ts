/**
 * Helpers for pending-message cleanup after server delivery reconciliation.
 */

export function shouldRunChatPendingDeliveredCleanup(
  pendingCount: number,
  deliveredCount: number
): boolean {
  return pendingCount > 0 && deliveredCount > 0;
}

export function hasChatPendingResolvedIds(resolvedIds?: string[] | null): boolean {
  return Array.isArray(resolvedIds) && resolvedIds.length > 0;
}

export function resolveChatPendingMapAfterRemovingIds<T>(
  prev: Map<string, T>,
  resolvedIds: string[]
): Map<string, T> {
  if (!hasChatPendingResolvedIds(resolvedIds)) {
    return prev;
  }

  const next = new Map(prev);
  for (const tempId of resolvedIds) {
    next.delete(tempId);
  }
  return next;
}

export function resolveChatPendingActiveIdSet(ids: Iterable<string>): Set<string> {
  return new Set<string>(Array.from(ids));
}
