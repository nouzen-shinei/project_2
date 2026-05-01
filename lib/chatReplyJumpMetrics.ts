import type { ChatReplyJumpResultReason } from '@/lib/chatReplyJump';

export type ChatReplyJumpMetricReason = ChatReplyJumpResultReason;
export type ChatReplyJumpMetricSource = 'interactive' | 'silent';
export type ChatReplyJumpMetricEmitMode = 'cadence' | 'flush';

const MIN_EVENTS_FOR_ANOMALY = 6;
const NOT_FOUND_ANOMALY_THRESHOLD = 0.4;
const CANCELLED_ANOMALY_THRESHOLD = 0.3;

export interface ChatReplyJumpMetricEvent {
  reason: ChatReplyJumpMetricReason;
  success: boolean;
  usedHistoryLoads: number;
  source: ChatReplyJumpMetricSource;
  platformOS: string;
}

export interface ChatReplyJumpMetricRollupState {
  totalEvents: number;
  successCount: number;
  failureCount: number;
  totalHistoryLoads: number;
  byReason: Record<ChatReplyJumpMetricReason, number>;
  bySource: Record<ChatReplyJumpMetricSource, number>;
  byPlatform: Record<string, number>;
  lastMetricAt: number;
  lastEmittedTotalEvents: number;
  lastReason: ChatReplyJumpMetricReason;
  lastSource: ChatReplyJumpMetricSource;
  lastPlatformOS: string;
}

export interface ChatReplyJumpMetricRollupPayload extends Record<string, unknown> {
  totalEvents: number;
  successCount: number;
  failureCount: number;
  totalHistoryLoads: number;
  avgHistoryLoads: number;
  reason: ChatReplyJumpMetricReason;
  reasonCount: number;
  source: ChatReplyJumpMetricSource;
  sourceCount: number;
  platformOS: string;
  platformCount: number;
  notFoundRate: number;
  cancelledRate: number;
  hasElevatedNotFoundRate: boolean;
  hasElevatedCancelledRate: boolean;
  anomalyLevel: 'none' | 'elevated' | 'high';
  emittedBy: ChatReplyJumpMetricEmitMode;
}

function normalizeUsedHistoryLoads(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function normalizePlatformOS(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : 'unknown';
}

function roundRate(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Number(value.toFixed(3));
}

function resolveAnomalyState(
  totalEvents: number,
  notFoundRate: number,
  cancelledRate: number
): {
  hasElevatedNotFoundRate: boolean;
  hasElevatedCancelledRate: boolean;
  anomalyLevel: 'none' | 'elevated' | 'high';
} {
  const hasSample = totalEvents >= MIN_EVENTS_FOR_ANOMALY;
  const hasElevatedNotFoundRate = hasSample && notFoundRate >= NOT_FOUND_ANOMALY_THRESHOLD;
  const hasElevatedCancelledRate = hasSample && cancelledRate >= CANCELLED_ANOMALY_THRESHOLD;

  if (hasElevatedNotFoundRate && hasElevatedCancelledRate) {
    return {
      hasElevatedNotFoundRate,
      hasElevatedCancelledRate,
      anomalyLevel: 'high',
    };
  }

  if (hasElevatedNotFoundRate || hasElevatedCancelledRate) {
    return {
      hasElevatedNotFoundRate,
      hasElevatedCancelledRate,
      anomalyLevel: 'elevated',
    };
  }

  return {
    hasElevatedNotFoundRate,
    hasElevatedCancelledRate,
    anomalyLevel: 'none',
  };
}

function buildRollupPayload(
  state: ChatReplyJumpMetricRollupState,
  reason: ChatReplyJumpMetricReason,
  source: ChatReplyJumpMetricSource,
  platformOS: string,
  emittedBy: ChatReplyJumpMetricEmitMode
): ChatReplyJumpMetricRollupPayload {
  const notFoundRate = roundRate((state.byReason['not-found'] || 0) / Math.max(1, state.totalEvents));
  const cancelledRate = roundRate((state.byReason.cancelled || 0) / Math.max(1, state.totalEvents));
  const anomaly = resolveAnomalyState(state.totalEvents, notFoundRate, cancelledRate);

  return {
    totalEvents: state.totalEvents,
    successCount: state.successCount,
    failureCount: state.failureCount,
    totalHistoryLoads: state.totalHistoryLoads,
    avgHistoryLoads:
      state.totalEvents > 0 ? Number((state.totalHistoryLoads / state.totalEvents).toFixed(3)) : 0,
    reason,
    reasonCount: state.byReason[reason] || 0,
    source,
    sourceCount: state.bySource[source] || 0,
    platformOS,
    platformCount: state.byPlatform[platformOS] || 0,
    notFoundRate,
    cancelledRate,
    hasElevatedNotFoundRate: anomaly.hasElevatedNotFoundRate,
    hasElevatedCancelledRate: anomaly.hasElevatedCancelledRate,
    anomalyLevel: anomaly.anomalyLevel,
    emittedBy,
  };
}

export function createChatReplyJumpMetricRollupState(): ChatReplyJumpMetricRollupState {
  return {
    totalEvents: 0,
    successCount: 0,
    failureCount: 0,
    totalHistoryLoads: 0,
    byReason: {
      'invalid-target': 0,
      found: 0,
      'not-found': 0,
      cancelled: 0,
    },
    bySource: {
      interactive: 0,
      silent: 0,
    },
    byPlatform: {},
    lastMetricAt: 0,
    lastEmittedTotalEvents: 0,
    lastReason: 'found',
    lastSource: 'interactive',
    lastPlatformOS: 'unknown',
  };
}

export function recordChatReplyJumpMetricRollup(
  state: ChatReplyJumpMetricRollupState,
  event: ChatReplyJumpMetricEvent,
  nowMs: number = Date.now()
): ChatReplyJumpMetricRollupPayload | null {
  state.totalEvents += 1;

  if (event.success) {
    state.successCount += 1;
  } else {
    state.failureCount += 1;
  }

  const normalizedLoads = normalizeUsedHistoryLoads(event.usedHistoryLoads);
  state.totalHistoryLoads += normalizedLoads;

  state.byReason[event.reason] = (state.byReason[event.reason] || 0) + 1;
  state.bySource[event.source] = (state.bySource[event.source] || 0) + 1;

  const normalizedPlatform = normalizePlatformOS(event.platformOS);
  state.byPlatform[normalizedPlatform] = (state.byPlatform[normalizedPlatform] || 0) + 1;
  state.lastReason = event.reason;
  state.lastSource = event.source;
  state.lastPlatformOS = normalizedPlatform;

  const shouldEmit =
    state.totalEvents === 1 ||
    state.totalEvents % 10 === 0 ||
    nowMs - state.lastMetricAt >= 60000;

  if (!shouldEmit) {
    return null;
  }

  state.lastMetricAt = nowMs;
  state.lastEmittedTotalEvents = state.totalEvents;

  return buildRollupPayload(
    state,
    event.reason,
    event.source,
    normalizedPlatform,
    'cadence'
  );
}

export function flushChatReplyJumpMetricRollup(
  state: ChatReplyJumpMetricRollupState,
  nowMs: number = Date.now()
): ChatReplyJumpMetricRollupPayload | null {
  if (state.totalEvents <= 0) {
    return null;
  }

  if (state.lastEmittedTotalEvents >= state.totalEvents) {
    return null;
  }

  const normalizedPlatform = normalizePlatformOS(state.lastPlatformOS);
  state.lastMetricAt = nowMs;
  state.lastEmittedTotalEvents = state.totalEvents;

  return buildRollupPayload(
    state,
    state.lastReason,
    state.lastSource,
    normalizedPlatform,
    'flush'
  );
}
