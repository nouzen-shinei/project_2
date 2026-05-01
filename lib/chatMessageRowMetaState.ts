export interface ChatMessageRowMetaStateInput {
  displayedMessages: any[];
  normalizeMessageId: (value: unknown) => string;
  sanitizeDateSeparatorLabel: (value: unknown) => string;
  resolveDateSeparator: (currentTimestamp: unknown, previousTimestamp: unknown) => unknown;
  nowMs?: number;
}

export interface ChatMessageRowMetaState {
  dateLabelById: Map<string, string>;
  separatorLabelById: Map<string, string>;
}

export function resolveChatMessageDateLabel(
  timestamp: unknown,
  nowMs: number = Date.now()
): string {
  try {
    const messageDate = new Date(timestamp as any);
    if (!Number.isFinite(messageDate.getTime())) {
      return 'Today';
    }

    const now = new Date(nowMs);
    const today = new Date(nowMs);
    today.setHours(0, 0, 0, 0);

    const messageDay = new Date(messageDate);
    messageDay.setHours(0, 0, 0, 0);

    const diffInDays = Math.floor(
      (today.getTime() - messageDay.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (diffInDays === 0) {
      return 'Today';
    }
    if (diffInDays === 1) {
      return 'Yesterday';
    }
    if (diffInDays <= 6) {
      return messageDate.toLocaleDateString([], { weekday: 'long' });
    }

    if (messageDate.getFullYear() === now.getFullYear()) {
      return messageDate.toLocaleDateString([], {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
    }

    return messageDate.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return 'Today';
  }
}

export function resolveChatMessageRowMetaState(
  input: ChatMessageRowMetaStateInput
): ChatMessageRowMetaState {
  const displayedMessages = Array.isArray(input.displayedMessages)
    ? input.displayedMessages
    : [];
  const dateLabelById = new Map<string, string>();
  const separatorLabelById = new Map<string, string>();

  for (let index = 0; index < displayedMessages.length; index += 1) {
    const message = displayedMessages[index];
    const messageId = input.normalizeMessageId(message?.id);
    if (!messageId) {
      continue;
    }

    dateLabelById.set(
      messageId,
      resolveChatMessageDateLabel(message?.timestamp, input.nowMs)
    );

    const previousTimestamp =
      index > 0 ? displayedMessages[index - 1]?.timestamp : undefined;
    const rawSeparator = input.resolveDateSeparator(
      message?.timestamp,
      previousTimestamp
    );
    if (typeof rawSeparator !== 'string') {
      continue;
    }

    const trimmedSeparator = rawSeparator.trim();
    if (!trimmedSeparator) {
      continue;
    }

    separatorLabelById.set(
      messageId,
      input.sanitizeDateSeparatorLabel(trimmedSeparator)
    );
  }

  return {
    dateLabelById,
    separatorLabelById,
  };
}
