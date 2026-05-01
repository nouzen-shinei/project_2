export interface ChatTypingPair {
  userEmail: string;
  recipientEmail: string;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

export function createChatTypingPair(userEmail: unknown, recipientEmail: unknown): ChatTypingPair | null {
  const normalizedUserEmail = normalizeEmail(userEmail);
  const normalizedRecipientEmail = normalizeEmail(recipientEmail);

  if (!normalizedUserEmail || !normalizedRecipientEmail) {
    return null;
  }

  if (normalizedUserEmail === normalizedRecipientEmail) {
    return null;
  }

  return {
    userEmail: normalizedUserEmail,
    recipientEmail: normalizedRecipientEmail,
  };
}

export function areChatTypingPairsEqual(
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
