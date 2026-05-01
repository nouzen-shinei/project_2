export function resolveChatNormalizedMessageId(id: unknown): string {
  if (id === null || id === undefined) {
    return '';
  }
  return String(id);
}

export function resolveChatNormalizedParticipantEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

export function resolveChatNormalizedMessageValue(value?: string | null): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}
