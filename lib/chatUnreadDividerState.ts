export interface ChatUnreadDividerDerivedStateInput {
  displayedMessages: any[];
  effectiveUserEmail?: string | null;
  selectedTeamMemberEmail?: string | null;
  unreadDividerSeedCount?: number;
  /**
   * A frozen anchor message id captured when the conversation was opened. When
   * provided (and the message still exists), the divider is pinned to this
   * message for the whole session, exactly like WhatsApp/Telegram — it does NOT
   * follow the live "first unread" pointer (which moves as messages are marked
   * read) and does NOT vanish when everything becomes read.
   */
  seedAnchorMessageId?: string | null;
  /**
   * Whether the open-time seed decision has been made for this conversation.
   * Once seeded, the divider is driven STRICTLY by the frozen seed anchor:
   *  - opened with unread  -> pinned to the captured first-unread message
   *  - opened with 0 unread -> never shown this session, even if new messages
   *    arrive while the user is actively present and viewing them.
   * This is what makes the divider behave like big chat apps. Before the seed
   * decision is made it falls back to the live first-unread pointer (legacy
   * behaviour) so existing callers/tests are unaffected.
   */
  unreadDividerSeeded?: boolean;
  normalizeParticipantEmail: (value: unknown) => string;
  normalizeMessageId: (id: unknown) => string;
}

export interface ChatUnreadDividerDerivedState {
  incomingConversationMessages: any[];
  incomingUnreadMessages: any[];
  incomingUnreadMessageIds: string[];
  firstUnreadMessageId: string | null;
  incomingUnreadCount: number;
  latestIncomingMessageId: string | null;
  unreadDividerSeedAnchorMessageId: string | null;
  unreadSeparatorAnchorMessageId: string | null;
  unreadDividerDisplayCount: number;
  unreadDividerLabel: string;
}

function resolveUnreadDividerLabel(unreadDividerDisplayCount: number): string {
  if (unreadDividerDisplayCount <= 0) {
    return 'Unread messages';
  }

  if (unreadDividerDisplayCount === 1) {
    return '1 unread message';
  }

  if (unreadDividerDisplayCount > 99) {
    return '99+ unread messages';
  }

  return `${unreadDividerDisplayCount} unread messages`;
}

export function resolveChatUnreadDividerDerivedState(
  input: ChatUnreadDividerDerivedStateInput
): ChatUnreadDividerDerivedState {
  const displayedMessages = Array.isArray(input.displayedMessages)
    ? input.displayedMessages
    : [];
  const userEmail = input.normalizeParticipantEmail(input.effectiveUserEmail);
  const senderEmail = input.normalizeParticipantEmail(input.selectedTeamMemberEmail);

  const incomingConversationMessages: any[] = [];
  const incomingUnreadMessages: any[] = [];
  const incomingUnreadMessageIds: string[] = [];

  const normalizedSeedAnchorId = input.normalizeMessageId(input.seedAnchorMessageId);
  let seedAnchorExists = false;

  if (displayedMessages.length > 0 && userEmail && senderEmail) {
    displayedMessages.forEach((message: any) => {
      if (
        normalizedSeedAnchorId &&
        !message?.deleted &&
        input.normalizeMessageId(message?.id) === normalizedSeedAnchorId
      ) {
        seedAnchorExists = true;
      }

      if (
        !message?.id ||
        message?.deleted ||
        input.normalizeParticipantEmail(message?.sender) !== senderEmail ||
        input.normalizeParticipantEmail(message?.recipientId) !== userEmail
      ) {
        return;
      }

      incomingConversationMessages.push(message);
      if (!message?.read) {
        incomingUnreadMessages.push(message);
        const normalizedMessageId = input.normalizeMessageId(message?.id);
        if (normalizedMessageId) {
          incomingUnreadMessageIds.push(normalizedMessageId);
        }
      }
    });
  }

  const firstUnreadMessageId =
    incomingUnreadMessageIds.length > 0 ? incomingUnreadMessageIds[0] : null;
  const incomingUnreadCount = incomingUnreadMessageIds.length;

  const latestIncomingMessageId =
    incomingConversationMessages.length > 0
      ? input.normalizeMessageId(
          incomingConversationMessages[incomingConversationMessages.length - 1]?.id
        ) || null
      : null;

  let unreadDividerSeedAnchorMessageId: string | null = null;
  const seedCount = Math.max(0, Math.trunc(Number(input.unreadDividerSeedCount || 0)));
  if (!firstUnreadMessageId && seedCount > 0) {
    if (!incomingConversationMessages.length) {
      unreadDividerSeedAnchorMessageId =
        input.normalizeMessageId(displayedMessages?.[0]?.id) || null;
    } else {
      const clampedUnreadCount = Math.min(seedCount, incomingConversationMessages.length);
      const boundaryIndex = Math.max(
        0,
        incomingConversationMessages.length - clampedUnreadCount
      );
      unreadDividerSeedAnchorMessageId =
        input.normalizeMessageId(incomingConversationMessages[boundaryIndex]?.id) || null;
    }
  }

  const unreadSeparatorAnchorMessageId =
    firstUnreadMessageId || unreadDividerSeedAnchorMessageId;

  // When a frozen seed anchor was captured at open time and it still exists in
  // the window, it takes priority: the divider stays pinned to that message for
  // the whole session (WhatsApp behaviour) instead of following the live
  // "first unread" pointer or vanishing once everything is marked read.
  const isSeededAnchorActive = Boolean(normalizedSeedAnchorId && seedAnchorExists);
  const resolvedUnreadSeparatorAnchorMessageId = input.unreadDividerSeeded
    ? // Strict seed-driven mode: ONLY the frozen open-time anchor controls the
      // divider. A conversation opened with zero unread shows no divider for
      // the rest of the session, so messages that arrive while the user is
      // present and viewing them never get a divider above them.
      isSeededAnchorActive
      ? normalizedSeedAnchorId
      : null
    : isSeededAnchorActive
      ? normalizedSeedAnchorId
      : unreadSeparatorAnchorMessageId;

  const liveCount = Math.max(0, Math.trunc(Number(incomingUnreadCount || 0)));
  const unreadDividerDisplayCount = isSeededAnchorActive
    ? seedCount > 0
      ? seedCount
      : liveCount
    : Number.isFinite(liveCount)
      ? liveCount > 0
        ? liveCount
        : seedCount
      : seedCount;

  return {
    incomingConversationMessages,
    incomingUnreadMessages,
    incomingUnreadMessageIds,
    firstUnreadMessageId,
    incomingUnreadCount,
    latestIncomingMessageId,
    unreadDividerSeedAnchorMessageId,
    unreadSeparatorAnchorMessageId: resolvedUnreadSeparatorAnchorMessageId,
    unreadDividerDisplayCount,
    unreadDividerLabel: resolveUnreadDividerLabel(unreadDividerDisplayCount),
  };
}
