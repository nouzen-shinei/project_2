import CryptoJS from 'crypto-js';

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

function hashConversationKey(value: string): string {
  return CryptoJS.SHA256(value).toString(CryptoJS.enc.Hex).slice(0, 20);
}

export function resolveChatUploadFolder(participants: ChatUploadParticipants): string {
  const senderKey = sanitizeEmailKey(participants?.senderEmail);
  const recipientKey = sanitizeEmailKey(participants?.recipientEmail);

  if (senderKey && recipientKey) {
    return `c_${hashConversationKey([senderKey, recipientKey].sort().join('__'))}`;
  }

  const single = senderKey ?? recipientKey;
  if (!single) return 'unassigned';
  return `c_${hashConversationKey(single)}`;
}
