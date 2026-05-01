export interface ChatMessagePositionEntry {
  height?: number;
}

export interface ChatListEstimatedItemSizeInput {
  displayedMessages: any[];
  messagePositionsById: Record<string, ChatMessagePositionEntry>;
  normalizeMessageId: (value: unknown) => string;
}

export interface ChatListEstimatedSize {
  height: number;
  width: number;
}

export interface ChatListEstimatedSizeInput {
  screenHeight?: number;
  screenWidth?: number;
  fallbackHeight?: number;
  fallbackWidth?: number;
}

export function resolveChatEstimatedItemSize(
  input: ChatListEstimatedItemSizeInput
): number {
  const displayedMessages = Array.isArray(input.displayedMessages)
    ? input.displayedMessages
    : [];

  if (displayedMessages.length === 0) {
    return 112;
  }

  const sampledHeights: number[] = [];
  const sampleStep = Math.max(1, Math.floor(displayedMessages.length / 24));

  for (
    let index = displayedMessages.length - 1;
    index >= 0 && sampledHeights.length < 24;
    index -= sampleStep
  ) {
    const message = displayedMessages[index];
    const id = input.normalizeMessageId(message?.id);
    if (!id) {
      continue;
    }

    const height = input.messagePositionsById[id]?.height;
    if (typeof height === 'number' && height > 0) {
      sampledHeights.push(height);
    }
  }

  if (sampledHeights.length >= 6) {
    sampledHeights.sort((a, b) => a - b);
    const middleIndex = Math.floor(sampledHeights.length / 2);
    const median =
      sampledHeights.length % 2
        ? sampledHeights[middleIndex]
        : Math.round(
            (sampledHeights[middleIndex - 1] + sampledHeights[middleIndex]) / 2
          );

    return Math.max(72, Math.min(280, median));
  }

  const recentMessages = displayedMessages.slice(
    Math.max(0, displayedMessages.length - 20)
  );
  let weightedTotal = 0;

  recentMessages.forEach((message: any) => {
    if (message?.sticker || message?.gif) {
      weightedTotal += 196;
      return;
    }

    if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
      weightedTotal += 172;
      return;
    }

    const textLength =
      typeof message?.text === 'string' ? message.text.trim().length : 0;
    if (textLength > 240) {
      weightedTotal += 176;
    } else if (textLength > 120) {
      weightedTotal += 152;
    } else if (textLength > 40) {
      weightedTotal += 132;
    } else {
      weightedTotal += 112;
    }
  });

  const heuristic = Math.round(weightedTotal / Math.max(1, recentMessages.length));
  return Math.max(96, Math.min(220, heuristic));
}

export function resolveChatEstimatedListSize(
  input: ChatListEstimatedSizeInput
): ChatListEstimatedSize {
  const fallbackHeight =
    typeof input.fallbackHeight === 'number' ? input.fallbackHeight : 800;
  const fallbackWidth =
    typeof input.fallbackWidth === 'number' ? input.fallbackWidth : 400;

  const rawHeight =
    typeof input.screenHeight === 'number' ? input.screenHeight : fallbackHeight;
  const rawWidth =
    typeof input.screenWidth === 'number' ? input.screenWidth : fallbackWidth;

  return {
    height: Math.max(600, Math.round(rawHeight || fallbackHeight)),
    width: Math.max(360, Math.round(rawWidth || fallbackWidth)),
  };
}

export function resolveChatListDrawDistance(
  baseHeight: number,
  isWeb: boolean
): number {
  if (isWeb) {
    return Math.max(Math.round(baseHeight * 1.8), 1200);
  }

  return Math.max(Math.round(baseHeight * 1.2), 900);
}
