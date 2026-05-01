export type ChatIdentityAttachmentLike = {
  url?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  resolvedUrl?: string;
};

function resolveChatIdentityTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }

  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return '';
    }
  }

  return '';
}

function resolveChatAttachmentDisplaySignature(
  attachments: unknown,
  includeExtendedFields: boolean
): string {
  if (!Array.isArray(attachments)) {
    return '';
  }

  return (attachments as ChatIdentityAttachmentLike[])
    .map((attachment) => {
      if (!includeExtendedFields) {
        return `${attachment?.url ?? ''}:${attachment?.fileName ?? ''}`;
      }

      return `${attachment?.url ?? ''}:${attachment?.resolvedUrl ?? ''}:${attachment?.fileName ?? ''}:${attachment?.fileType ?? ''}:${attachment?.fileSize ?? ''}`;
    })
    .join(',');
}

export function resolveChatMessageDisplayKey(message: any): string {
  if (!message) {
    return '';
  }

  if (message.id) {
    return `id:${String(message.id)}`;
  }

  const sender = typeof message.sender === 'string' ? message.sender.toLowerCase() : '';
  const recipient =
    typeof message.recipientId === 'string' ? message.recipientId.toLowerCase() : '';
  const timestamp = resolveChatIdentityTimestamp(message?.timestamp);
  const text = typeof message.text === 'string' ? message.text : '';
  const attachmentsSignature = resolveChatAttachmentDisplaySignature(
    message.attachments,
    false
  );
  const gifUrl = typeof message?.gif?.url === 'string' ? message.gif.url : '';
  const stickerUrl =
    typeof message?.sticker?.url === 'string' ? message.sticker.url : '';

  return `fallback:${sender}|${recipient}|${timestamp}|${text}|${attachmentsSignature}|${gifUrl}|${stickerUrl}`;
}

export function resolveChatMessageRenderSignature(message: any): string {
  if (!message) {
    return '';
  }

  const sender = typeof message.sender === 'string' ? message.sender.toLowerCase() : '';
  const recipient =
    typeof message.recipientId === 'string' ? message.recipientId.toLowerCase() : '';
  const timestamp = resolveChatIdentityTimestamp(message?.timestamp);
  const text = typeof message.text === 'string' ? message.text : '';
  const editCount =
    typeof message.editCount === 'number' ? String(message.editCount) : '';
  const editedAt = message.editedAt ? String(message.editedAt) : '';
  const deleted = message.deleted ? '1' : '0';
  const delivered = message.delivered ? '1' : '0';
  const read = message.read ? '1' : '0';
  const isSpecial = message.isSpecial ? '1' : '0';
  const gifUrl = typeof message?.gif?.url === 'string' ? message.gif.url : '';
  const stickerUrl =
    typeof message?.sticker?.url === 'string' ? message.sticker.url : '';
  const attachmentsSignature = resolveChatAttachmentDisplaySignature(
    message.attachments,
    true
  );

  return [
    sender,
    recipient,
    timestamp,
    text,
    editCount,
    editedAt,
    deleted,
    delivered,
    read,
    isSpecial,
    gifUrl,
    stickerUrl,
    attachmentsSignature,
  ].join('|');
}
