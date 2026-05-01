export type ChatMessageListItemType =
  | 'unknown'
  | 'sticker'
  | 'gif'
  | 'attachment'
  | 'special'
  | 'text';

export function resolveChatMessageListItemType(item: any): ChatMessageListItemType {
  if (!item) {
    return 'unknown';
  }

  if (item.sticker) {
    return 'sticker';
  }

  if (item.gif) {
    return 'gif';
  }

  if (Array.isArray(item.attachments) && item.attachments.length > 0) {
    return 'attachment';
  }

  if (item.isSpecial) {
    return 'special';
  }

  return 'text';
}

export function resolveChatMessageListItemKey(params: {
  item: any;
  index: number;
  resolveDisplayKey: (item: any) => string;
}): string {
  const { item, index, resolveDisplayKey } = params;

  if (!item) {
    return `ghost:${index}`;
  }

  if (item.id != null) {
    return `id:${String(item.id)}`;
  }

  if (item.localId) {
    return `local:${String(item.localId)}`;
  }

  const fallback = resolveDisplayKey(item);
  if (fallback) {
    return `display:${fallback}`;
  }

  if (item.timestamp) {
    return `timestamp:${item.timestamp}:${index}`;
  }

  return `index:${index}`;
}

export function resolveChatMessageLayoutSize(
  itemType: ChatMessageListItemType
): number | undefined {
  if (itemType === 'sticker') {
    return 188;
  }

  if (itemType === 'gif') {
    return 280;
  }

  if (itemType === 'attachment') {
    return 220;
  }

  return undefined;
}
