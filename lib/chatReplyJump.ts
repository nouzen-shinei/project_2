export interface ExecuteChatReplyJumpOptions {
  targetMessageId?: string | null;
  tryScrollToMessage: (messageId: string, animated: boolean) => boolean;
  canLoadMoreHistory: () => boolean;
  loadOlderMessages: () => Promise<void> | void;
  maxLoadAttempts?: number;
  shouldContinue?: () => boolean;
}

export type ChatReplyJumpResultReason = 'invalid-target' | 'found' | 'not-found' | 'cancelled';

export interface ChatReplyJumpResult {
  success: boolean;
  usedHistoryLoads: number;
  reason: ChatReplyJumpResultReason;
}

function resolveMaxLoadAttempts(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 4;
  }
  return Math.trunc(numeric);
}

function normalizeTargetMessageId(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function canContinue(options: ExecuteChatReplyJumpOptions): boolean {
  if (typeof options?.shouldContinue !== 'function') {
    return true;
  }

  try {
    return options.shouldContinue();
  } catch {
    return false;
  }
}

export async function executeChatReplyJump(options: ExecuteChatReplyJumpOptions): Promise<ChatReplyJumpResult> {
  const targetMessageId = normalizeTargetMessageId(options?.targetMessageId);
  if (!targetMessageId) {
    return {
      success: false,
      usedHistoryLoads: 0,
      reason: 'invalid-target',
    };
  }

  if (!canContinue(options)) {
    return {
      success: false,
      usedHistoryLoads: 0,
      reason: 'cancelled',
    };
  }

  if (options.tryScrollToMessage(targetMessageId, true)) {
    return {
      success: true,
      usedHistoryLoads: 0,
      reason: 'found',
    };
  }

  const maxLoadAttempts = resolveMaxLoadAttempts(options.maxLoadAttempts);
  let usedHistoryLoads = 0;

  while (usedHistoryLoads < maxLoadAttempts && options.canLoadMoreHistory()) {
    if (!canContinue(options)) {
      return {
        success: false,
        usedHistoryLoads,
        reason: 'cancelled',
      };
    }

    usedHistoryLoads += 1;
    await options.loadOlderMessages();

    if (!canContinue(options)) {
      return {
        success: false,
        usedHistoryLoads,
        reason: 'cancelled',
      };
    }

    if (options.tryScrollToMessage(targetMessageId, false)) {
      return {
        success: true,
        usedHistoryLoads,
        reason: 'found',
      };
    }
  }

  return {
    success: false,
    usedHistoryLoads,
    reason: 'not-found',
  };
}
