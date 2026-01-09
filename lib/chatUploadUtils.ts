export interface ChatUploadParticipants {
  senderEmail?: string | null;
  recipientEmail?: string | null;
}

function normalizeEmail(value?: string | null): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function sanitizeEmailKey(value?: string | null): string | null {
  const normalized = normalizeEmail(value);
  if (!normalized) {
    return null;
  }
  return normalized.replace(/[.@]/g, '_');
}

export function resolveChatUploadFolder(participants: ChatUploadParticipants): string {
  const senderKey = sanitizeEmailKey(participants?.senderEmail);
  const recipientKey = sanitizeEmailKey(participants?.recipientEmail);

  if (senderKey && recipientKey) {
    return [senderKey, recipientKey].sort().join('__');
  }

  return senderKey ?? recipientKey ?? 'unassigned';
}
