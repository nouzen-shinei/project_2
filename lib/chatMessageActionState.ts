export interface ChatMessageActionLike {
  id?: string | null;
  sender?: unknown;
  deleted?: boolean;
  isSpecial?: boolean;
  gif?: unknown;
  sticker?: unknown;
  attachments?: unknown;
  text?: unknown;
}

function normalizeChatActionEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

export function resolveChatIsOwnMessageEmail(
  message: ChatMessageActionLike | null | undefined,
  effectiveUserEmail: string | null | undefined
): boolean {
  if (!message || !effectiveUserEmail) {
    return false;
  }

  const sender = normalizeChatActionEmail(message.sender);
  return sender === normalizeChatActionEmail(effectiveUserEmail);
}

export function resolveChatCanEditMessage(
  message: ChatMessageActionLike | null | undefined,
  effectiveUserEmail: string | null | undefined
): boolean {
  if (!message || !message.id) {
    return false;
  }

  if (!resolveChatIsOwnMessageEmail(message, effectiveUserEmail)) {
    return false;
  }

  if (message.deleted) {
    return false;
  }

  if (message.isSpecial) {
    return false;
  }

  if (Boolean(message.gif) || Boolean(message.sticker)) {
    return false;
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    return false;
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  return text.length > 0;
}

export function resolveChatCanDeleteMessage(
  message: ChatMessageActionLike | null | undefined,
  effectiveUserEmail: string | null | undefined
): boolean {
  if (!message || !message.id) {
    return false;
  }

  if (!resolveChatIsOwnMessageEmail(message, effectiveUserEmail)) {
    return false;
  }

  return !message.deleted;
}

export function resolveChatCanReplyMessage(
  message: ChatMessageActionLike | null | undefined
): boolean {
  if (!message || !message.id) {
    return false;
  }

  if (message.deleted) {
    return false;
  }

  return Boolean(normalizeChatActionEmail(message.sender));
}

export function resolveChatFindLatestEditableOwnMessage(
  messages: readonly ChatMessageActionLike[] | readonly any[] | null | undefined,
  effectiveUserEmail: string | null | undefined
): ChatMessageActionLike | any | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (resolveChatCanEditMessage(candidate, effectiveUserEmail)) {
      return candidate;
    }
  }

  return null;
}
