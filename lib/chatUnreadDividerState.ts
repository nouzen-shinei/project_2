export interface ChatUnreadDividerDerivedStateInput {
  displayedMessages: any[];
  effectiveUserEmail?: string | null;
  selectedTeamMemberEmail?: string | null;
  unreadDividerSeedCount?: number;
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

  if (displayedMessages.length > 0 && userEmail && senderEmail) {
    displayedMessages.forEach((message: any) => {
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

  const liveCount = Math.max(0, Math.trunc(Number(incomingUnreadCount || 0)));
  const unreadDividerDisplayCount = Number.isFinite(liveCount)
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
    unreadSeparatorAnchorMessageId,
    unreadDividerDisplayCount,
    unreadDividerLabel: resolveUnreadDividerLabel(unreadDividerDisplayCount),
  };
}
