export interface ChatRealtimeReplyPayload {
  messageId: string;
  sender: string;
  senderName?: string;
  text?: string;
  isSpecial?: boolean;
  hasAttachments?: boolean;
  attachmentCount?: number;
  hasSticker?: boolean;
  hasGif?: boolean;
}

export interface ChatRealtimeMessageForSignature {
  text?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  thumbnailUrl?: string;
  isSpecial?: boolean;
  editedAt?: string;
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  attachments?: unknown[];
  replyTo?: ChatRealtimeReplyPayload | null;
  sticker?: unknown;
  gif?: unknown;
  reactions?: Record<string, string[]>;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function normalizeStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStableValue(item));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, normalizeStableValue(entryValue)] as const)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    const normalized: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) {
      normalized[key] = entryValue;
    }
    return normalized;
  }

  return value;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(normalizeStableValue(value)) ?? '';
  } catch {
    return '';
  }
}

export function normalizeChatRealtimeReplyPayload(input: unknown): ChatRealtimeReplyPayload | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const raw = input as Record<string, unknown>;
  const messageId = typeof raw.messageId === 'string' ? raw.messageId.trim() : '';
  const sender = normalizeEmail(raw.sender);
  if (!messageId || !sender) {
    return undefined;
  }

  const attachmentCountNumeric = Number(raw.attachmentCount);
  const attachmentCount = Number.isFinite(attachmentCountNumeric) && attachmentCountNumeric > 0
    ? Math.trunc(attachmentCountNumeric)
    : undefined;
  const senderName = typeof raw.senderName === 'string' ? raw.senderName.trim() : '';
  const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : '';
  const hasAttachments = raw.hasAttachments === true || Boolean(attachmentCount);
  const isSpecial = raw.isSpecial === true;
  const hasSticker = raw.hasSticker === true;
  const hasGif = raw.hasGif === true;

  const normalized: ChatRealtimeReplyPayload = {
    messageId,
    sender,
  };

  if (senderName) {
    normalized.senderName = senderName;
  }

  if (text) {
    normalized.text = text;
  }

  if (isSpecial) {
    normalized.isSpecial = true;
  }

  if (hasAttachments) {
    normalized.hasAttachments = true;
  }

  if (attachmentCount) {
    normalized.attachmentCount = attachmentCount;
  }

  if (hasSticker) {
    normalized.hasSticker = true;
  }

  if (hasGif) {
    normalized.hasGif = true;
  }

  return normalized;
}

export function buildChatRealtimeMessageContentSignature(payload: ChatRealtimeMessageForSignature): string {
  return [
    payload.text || '',
    payload.fileUrl || '',
    payload.fileName || '',
    payload.fileType || '',
    typeof payload.fileSize === 'number' ? payload.fileSize : '',
    payload.thumbnailUrl || '',
    payload.isSpecial ? '1' : '0',
    payload.editedAt || '',
    payload.deleted ? '1' : '0',
    payload.deletedAt || '',
    payload.deletedBy || '',
    stableStringify(payload.attachments || []),
    stableStringify(payload.replyTo || null),
    stableStringify(payload.sticker || null),
    stableStringify(payload.gif || null),
    stableStringify(payload.reactions || null),
  ].join('|');
}
