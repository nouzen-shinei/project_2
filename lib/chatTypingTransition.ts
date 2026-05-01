export interface ChatTypingPair {
  userEmail: string;
  recipientEmail: string;
}

export interface ChatTypingTransitionInput {
  activePair: ChatTypingPair | null;
  isTypingActive: boolean;
  nextPair: ChatTypingPair | null;
  hasMessageContent: boolean;
}

export interface ChatTypingTransition {
  pairToClear: ChatTypingPair | null;
  pairToActivate: ChatTypingPair | null;
  nextActivePair: ChatTypingPair | null;
  nextIsTypingActive: boolean;
  shouldScheduleTimeout: boolean;
}

function areChatTypingPairsEqual(
  first: ChatTypingPair | null | undefined,
  second: ChatTypingPair | null | undefined
): boolean {
  if (!first && !second) {
    return true;
  }

  if (!first || !second) {
    return false;
  }

  return first.userEmail === second.userEmail && first.recipientEmail === second.recipientEmail;
}

export function resolveChatTypingTransition({
  activePair,
  isTypingActive,
  nextPair,
  hasMessageContent,
}: ChatTypingTransitionInput): ChatTypingTransition {
  if (!hasMessageContent || !nextPair) {
    return {
      pairToClear: activePair,
      pairToActivate: null,
      nextActivePair: null,
      nextIsTypingActive: false,
      shouldScheduleTimeout: false,
    };
  }

  const isSamePair = areChatTypingPairsEqual(activePair, nextPair);
  const shouldActivatePair = !isTypingActive || !isSamePair;

  return {
    pairToClear: activePair && !isSamePair ? activePair : null,
    pairToActivate: shouldActivatePair ? nextPair : null,
    nextActivePair: nextPair,
    nextIsTypingActive: true,
    shouldScheduleTimeout: true,
  };
}
