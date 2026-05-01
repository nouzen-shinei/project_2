/**
 * Pure helpers for pending-message storage hydration.
 */

export const CHAT_PENDING_STORAGE_EMPTY_EMAIL = '';

export function resolveChatPendingSenderEmail(
  effectiveUserEmail?: string | null,
  userEmail?: string | null
): string {
  if (typeof effectiveUserEmail === 'string' && effectiveUserEmail.trim().length > 0) {
    return effectiveUserEmail;
  }
  if (typeof userEmail === 'string' && userEmail.trim().length > 0) {
    return userEmail;
  }
  return CHAT_PENDING_STORAGE_EMPTY_EMAIL;
}

export function shouldLoadChatPendingMessages(
  selectedRecipientId?: string | null,
  senderEmail?: string | null
): boolean {
  if (typeof selectedRecipientId !== 'string' || selectedRecipientId.trim().length === 0) {
    return false;
  }
  if (typeof senderEmail !== 'string' || senderEmail.trim().length === 0) {
    return false;
  }
  return true;
}

export function resolveChatNormalizedPendingMessages<T extends Record<string, any>>(
  storedPendingMessages: Map<string, T> | undefined,
  resolvePendingMessageStatus: (message: T) => string
): Map<string, T & { status: string }> {
  const normalized = new Map<string, T & { status: string }>();
  if (!storedPendingMessages || storedPendingMessages.size === 0) {
    return normalized;
  }

  for (const [id, message] of storedPendingMessages.entries()) {
    normalized.set(id, {
      ...message,
      status: resolvePendingMessageStatus(message),
    });
  }

  return normalized;
}
