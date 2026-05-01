export type ChatMessageReactionMap = Record<string, Set<string>>;

function cloneChatMessageReactionMap(reactions?: ChatMessageReactionMap): ChatMessageReactionMap {
  const next: ChatMessageReactionMap = {};

  if (!reactions) {
    return next;
  }

  Object.entries(reactions).forEach(([reactionType, users]) => {
    if (users instanceof Set) {
      next[reactionType] = new Set(users);
    }
  });

  return next;
}

function findCurrentUserReaction(
  reactions: ChatMessageReactionMap,
  userEmail: string
): string | null {
  for (const [reactionType, users] of Object.entries(reactions)) {
    if (users.has(userEmail)) {
      return reactionType;
    }
  }

  return null;
}

export function resolveChatOptimisticReactionMap(
  previousReactionsByMessage: Map<string, ChatMessageReactionMap>,
  messageId: string,
  reactionType: string,
  userEmail: string,
  isSpecialMessage: boolean
): Map<string, ChatMessageReactionMap> {
  const nextReactionsByMessage = new Map(previousReactionsByMessage);
  const baseReaction = cloneChatMessageReactionMap(nextReactionsByMessage.get(messageId));

  if (isSpecialMessage) {
    const existingSet = baseReaction[reactionType];
    const hasThisReaction = existingSet?.has(userEmail) === true;

    if (hasThisReaction) {
      const nextSet = new Set(existingSet);
      nextSet.delete(userEmail);
      if (nextSet.size === 0) {
        delete baseReaction[reactionType];
      } else {
        baseReaction[reactionType] = nextSet;
      }
    } else {
      const nextSet = new Set(existingSet ?? []);
      nextSet.add(userEmail);
      baseReaction[reactionType] = nextSet;
    }
  } else {
    const currentUserReaction = findCurrentUserReaction(baseReaction, userEmail);

    if (currentUserReaction === reactionType) {
      const existingSet = baseReaction[reactionType];
      const nextSet = new Set(existingSet ?? []);
      nextSet.delete(userEmail);
      if (nextSet.size === 0) {
        delete baseReaction[reactionType];
      } else {
        baseReaction[reactionType] = nextSet;
      }
    } else {
      if (currentUserReaction) {
        const previousSet = baseReaction[currentUserReaction];
        const nextPrevSet = new Set(previousSet ?? []);
        nextPrevSet.delete(userEmail);
        if (nextPrevSet.size === 0) {
          delete baseReaction[currentUserReaction];
        } else {
          baseReaction[currentUserReaction] = nextPrevSet;
        }
      }

      const nextSet = new Set(baseReaction[reactionType] ?? []);
      nextSet.add(userEmail);
      baseReaction[reactionType] = nextSet;
    }
  }

  if (Object.keys(baseReaction).length === 0) {
    nextReactionsByMessage.set(messageId, {});
  } else {
    nextReactionsByMessage.set(messageId, baseReaction);
  }

  return nextReactionsByMessage;
}

export function shouldKeepChatOptimisticReactionUntil(
  until: number | undefined,
  now: number
): boolean {
  if (typeof until !== 'number') {
    return false;
  }

  return until > now;
}

export function resolveChatOptimisticReactionExpiryIds(
  untilByMessage: Map<string, number>,
  activeMessageIds: ReadonlySet<string>,
  now: number
): Set<string> {
  const expiryIds = new Set<string>();

  untilByMessage.forEach((until, messageId) => {
    if (!shouldKeepChatOptimisticReactionUntil(until, now) || !activeMessageIds.has(messageId)) {
      expiryIds.add(messageId);
    }
  });

  return expiryIds;
}

export function resolveChatPrunedLocalMessageReactions(
  previousReactionsByMessage: Map<string, ChatMessageReactionMap>,
  visibleMessageIds: ReadonlySet<string>
): Map<string, ChatMessageReactionMap> {
  if (previousReactionsByMessage.size === 0) {
    return previousReactionsByMessage;
  }

  let changed = false;
  const next = new Map<string, ChatMessageReactionMap>();

  previousReactionsByMessage.forEach((value, messageId) => {
    if (visibleMessageIds.has(messageId)) {
      next.set(messageId, value);
      return;
    }

    changed = true;
  });

  return changed ? next : previousReactionsByMessage;
}
