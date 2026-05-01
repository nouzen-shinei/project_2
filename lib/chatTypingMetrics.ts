export interface ChatTypingStatusWriteRollupState {
  totalWrites: number;
  setTrueWrites: number;
  setFalseWrites: number;
  byReason: Record<string, number>;
  lastMetricAt: number;
}

export interface ChatTypingStatusWriteRollupPayload extends Record<string, unknown> {
  totalWrites: number;
  setTrueWrites: number;
  setFalseWrites: number;
  reason: string;
  reasonWrites: number;
}

const CHAT_TYPING_STATUS_WRITE_EMIT_EVERY_EVENTS = 10;
const CHAT_TYPING_STATUS_WRITE_EMIT_INTERVAL_MS = 60000;

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

export function createChatTypingStatusWriteRollupState(): ChatTypingStatusWriteRollupState {
  return {
    totalWrites: 0,
    setTrueWrites: 0,
    setFalseWrites: 0,
    byReason: {},
    lastMetricAt: 0,
  };
}

export function recordChatTypingStatusWriteRollup(
  state: ChatTypingStatusWriteRollupState,
  isTyping: boolean,
  reason: string,
  nowMs: number = Date.now()
): ChatTypingStatusWriteRollupPayload | null {
  state.totalWrites += 1;

  if (isTyping) {
    state.setTrueWrites += 1;
  } else {
    state.setFalseWrites += 1;
  }

  const normalizedReason = normalizeReason(reason);
  state.byReason[normalizedReason] = (state.byReason[normalizedReason] || 0) + 1;

  const safeNowMs = Number.isFinite(nowMs)
    ? Math.max(0, Math.floor(nowMs))
    : 0;
  const shouldEmit =
    state.totalWrites === 1 ||
    state.totalWrites % CHAT_TYPING_STATUS_WRITE_EMIT_EVERY_EVENTS === 0 ||
    safeNowMs - state.lastMetricAt >= CHAT_TYPING_STATUS_WRITE_EMIT_INTERVAL_MS;

  if (!shouldEmit) {
    return null;
  }

  state.lastMetricAt = safeNowMs;

  return {
    totalWrites: state.totalWrites,
    setTrueWrites: state.setTrueWrites,
    setFalseWrites: state.setFalseWrites,
    reason: normalizedReason,
    reasonWrites: state.byReason[normalizedReason],
  };
}