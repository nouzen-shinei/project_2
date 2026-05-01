export interface ChatConversationSearchMatchCollections {
  matchIdSet: Set<string>;
  matchIndexById: Map<string, number>;
}

export function resolveChatConversationSearchMatchCollections(
  matchIds: string[]
): ChatConversationSearchMatchCollections {
  const normalizedMatchIds = Array.isArray(matchIds) ? matchIds : [];
  const matchIdSet = new Set<string>();
  const matchIndexById = new Map<string, number>();

  normalizedMatchIds.forEach((matchId, index) => {
    if (!matchId) {
      return;
    }

    matchIdSet.add(matchId);
    matchIndexById.set(matchId, index);
  });

  return {
    matchIdSet,
    matchIndexById,
  };
}
