type SummaryLike = {
  unreadCount: number;
};

export function normalizeConversationEmail(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// A self-conversation key has two identical participant halves (emailA == emailB),
// e.g. "krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com".
export function isSelfConversationKey(conversationKey?: string | null): boolean {
  if (typeof conversationKey !== 'string') {
    return false;
  }
  const halves = conversationKey.split('__').filter(Boolean);
  return halves.length === 2 && halves[0] === halves[1];
}

export interface SelfConversationInput {
  conversationKey?: string | null;
  partnerEmail?: string | null;
  viewerEmail?: string | null;
  sender?: string | null;
  recipientId?: string | null;
}

// Shared self-conversation predicate. A conversation is a self-conversation when
// ANY of the following holds:
//   - its conversationKey has two identical participant halves, OR
//   - its stored message has sender == recipientId, OR
//   - its summary partnerEmail equals the viewer.
// Self-messaging is not a supported feature, so self-conversations must never
// contribute to the unread badge, the unread total, or the conversation list.
export function isSelfConversation(input: SelfConversationInput): boolean {
  if (isSelfConversationKey(input.conversationKey)) {
    return true;
  }

  const viewer = normalizeConversationEmail(input.viewerEmail);
  const partner = normalizeConversationEmail(input.partnerEmail);
  if (viewer && partner && viewer === partner) {
    return true;
  }

  const sender = normalizeConversationEmail(input.sender);
  const recipient = normalizeConversationEmail(input.recipientId);
  if (sender && recipient && sender === recipient) {
    return true;
  }

  return false;
}

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