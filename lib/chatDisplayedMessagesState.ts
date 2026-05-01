export type ChatStableMessageCacheEntry<TMessage> = {
  signature: string;
  message: TMessage;
};

export const CHAT_MESSAGE_POSITION_COMPACTION_DRIFT_THRESHOLD = 40;

export interface ResolveChatDisplayedMessagesStateParams<TMessage> {
  messages: TMessage[] | null | undefined;
  previousStableCache: Map<string, ChatStableMessageCacheEntry<TMessage>>;
  previousDisplayedMessages: TMessage[];
  resolveDisplayKey: (message: TMessage) => string;
  resolveRenderSignature: (message: TMessage) => string;
}

function resolveTimestampMs(value: unknown): number {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : 0;
  }

  if (value && typeof (value as { toDate?: () => unknown }).toDate === 'function') {
    try {
      const parsed = (value as { toDate: () => unknown }).toDate();
      return resolveTimestampMs(parsed);
    } catch {
      return 0;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function resolveStableMessageKey(message: any, fallbackDisplayKey: string): string {
  if (message?.id != null) {
    return `id:${String(message.id)}`;
  }

  if (message?.localId != null) {
    return `local:${String(message.localId)}`;
  }

  return `display:${fallbackDisplayKey}`;
}

export function resolveChatDisplayedMessagesState<TMessage>(
  params: ResolveChatDisplayedMessagesStateParams<TMessage>
): {
  displayedMessages: TMessage[];
  nextStableCache: Map<string, ChatStableMessageCacheEntry<TMessage>>;
} {
  const {
    messages,
    previousStableCache,
    previousDisplayedMessages,
    resolveDisplayKey,
    resolveRenderSignature,
  } = params;

  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      displayedMessages: [],
      nextStableCache: new Map(),
    };
  }

  const deduped = new Map<string, TMessage>();

  messages.forEach((message) => {
    if (!message) {
      return;
    }

    const key = resolveDisplayKey(message);
    if (!key) {
      return;
    }

    if (!deduped.has(key)) {
      deduped.set(key, message);
      return;
    }

    const existing = deduped.get(key) as any;
    const incoming = message as any;

    if (!existing?.id && incoming?.id) {
      deduped.set(key, message);
      return;
    }

    const existingTime = resolveTimestampMs(existing?.timestamp);
    const incomingTime = resolveTimestampMs(incoming?.timestamp);
    if (Number.isFinite(incomingTime) && (!Number.isFinite(existingTime) || incomingTime > existingTime)) {
      deduped.set(key, message);
    }
  });

  const nextStableCache = new Map<string, ChatStableMessageCacheEntry<TMessage>>();
  const displayedMessages = Array.from(deduped.entries()).map(([displayKey, message]) => {
    const stableKey = resolveStableMessageKey(message, displayKey);
    const signature = resolveRenderSignature(message);
    const cached = previousStableCache.get(stableKey);

    if (cached && cached.signature === signature) {
      nextStableCache.set(stableKey, cached);
      return cached.message;
    }

    const entry: ChatStableMessageCacheEntry<TMessage> = { signature, message };
    nextStableCache.set(stableKey, entry);
    return message;
  });

  displayedMessages.sort((a: any, b: any) => {
    const leftTime = resolveTimestampMs(a?.timestamp);
    const rightTime = resolveTimestampMs(b?.timestamp);
    return leftTime - rightTime;
  });

  if (
    previousDisplayedMessages.length === displayedMessages.length &&
    previousDisplayedMessages.every((message, index) => message === displayedMessages[index])
  ) {
    return {
      displayedMessages: previousDisplayedMessages,
      nextStableCache,
    };
  }

  return {
    displayedMessages,
    nextStableCache,
  };
}

export function resolveChatDisplayedMessageIdSet<TMessage>(
  displayedMessages: TMessage[],
  resolveMessageId: (message: TMessage) => string
): Set<string> {
  const activeMessageIds = new Set<string>();

  displayedMessages.forEach((message) => {
    const id = resolveMessageId(message);
    if (id) {
      activeMessageIds.add(id);
    }
  });

  return activeMessageIds;
}

export function shouldCompactChatMessagePositions(
  positionCount: number,
  displayedMessageCount: number,
  driftThreshold: number = CHAT_MESSAGE_POSITION_COMPACTION_DRIFT_THRESHOLD
): boolean {
  if (positionCount <= 0) {
    return false;
  }

  return positionCount > displayedMessageCount + driftThreshold;
}

export function resolveChatPrunedMessagePositions<T>(
  positions: Record<string, T>,
  validIds: ReadonlySet<string>
): Record<string, T> {
  const keys = Object.keys(positions);
  if (keys.length === 0) {
    return positions;
  }

  let changed = false;
  const next: Record<string, T> = {};

  keys.forEach((id) => {
    if (validIds.has(id)) {
      next[id] = positions[id];
      return;
    }
    changed = true;
  });

  return changed ? next : positions;
}
