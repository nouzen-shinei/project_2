type SummaryLike = {
  unreadCount: number;
};

export function reconcileConversationUnreadCount<T extends SummaryLike>(
  previous: Map<string, T>,
  partnerEmail: string | undefined,
  incomingUnreadCount: number,
  options: {
    isFocused: boolean;
    isAppActive: boolean;
    loading: boolean;
  }
): Map<string, T> {
  const normalizedPartner = typeof partnerEmail === 'string' ? partnerEmail.trim().toLowerCase() : '';
  if (!normalizedPartner || !options.isFocused || !options.isAppActive || options.loading) {
    return previous;
  }

  const existing = previous.get(normalizedPartner);
  if (!existing || existing.unreadCount === incomingUnreadCount) {
    return previous;
  }

  const next = new Map(previous);
  next.set(normalizedPartner, {
    ...existing,
    unreadCount: incomingUnreadCount,
  });
  return next;
}

export function shouldRefreshChatSummariesOnForegroundResume(options: {
  isFocused: boolean;
  isAppActive: boolean;
  wasForegroundInteractive: boolean;
  hasUserEmail: boolean;
  hasTenantId: boolean;
  now: number;
  lastForegroundRefreshAt: number;
  throttleMs?: number;
}): boolean {
  const isForegroundInteractive = Boolean(options.isFocused && options.isAppActive);
  const resumed = isForegroundInteractive && !options.wasForegroundInteractive;
  if (!resumed || !options.hasUserEmail || !options.hasTenantId) {
    return false;
  }

  const throttleMs = typeof options.throttleMs === 'number' ? options.throttleMs : 1500;
  return options.now - options.lastForegroundRefreshAt >= throttleMs;
}