export type ChatConversationSearchUxRollupEventKind =
  | 'scope-switch'
  | 'no-result-recovery';

export interface ChatConversationSearchUxRollupState {
  totalEvents: number;
  scopeSwitches: number;
  noResultRecoveries: number;
  shortcutScopeSwitches: number;
  shortcutNoResultRecoveries: number;
  bySource: Record<string, number>;
  lastMetricAt: number;
}

export interface ChatConversationSearchUxRollupPayload extends Record<string, unknown> {
  totalEvents: number;
  scopeSwitches: number;
  noResultRecoveries: number;
  shortcutScopeSwitches: number;
  shortcutNoResultRecoveries: number;
  source: string;
  sourceCount: number;
  eventKind: ChatConversationSearchUxRollupEventKind;
}

const CHAT_CONVERSATION_SEARCH_UX_EMIT_EVERY_EVENTS = 10;
const CHAT_CONVERSATION_SEARCH_UX_EMIT_INTERVAL_MS = 60000;

function normalizeSource(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

export function createChatConversationSearchUxRollupState(): ChatConversationSearchUxRollupState {
  return {
    totalEvents: 0,
    scopeSwitches: 0,
    noResultRecoveries: 0,
    shortcutScopeSwitches: 0,
    shortcutNoResultRecoveries: 0,
    bySource: {},
    lastMetricAt: 0,
  };
}

export function recordChatConversationSearchUxRollup(
  state: ChatConversationSearchUxRollupState,
  eventKind: ChatConversationSearchUxRollupEventKind,
  source: string,
  nowMs: number = Date.now()
): ChatConversationSearchUxRollupPayload | null {
  state.totalEvents += 1;

  if (eventKind === 'scope-switch') {
    state.scopeSwitches += 1;
  } else {
    state.noResultRecoveries += 1;
  }

  const normalizedSource = normalizeSource(source);
  state.bySource[normalizedSource] = (state.bySource[normalizedSource] || 0) + 1;

  if (normalizedSource.startsWith('shortcut')) {
    if (eventKind === 'scope-switch') {
      state.shortcutScopeSwitches += 1;
    } else {
      state.shortcutNoResultRecoveries += 1;
    }
  }

  const safeNowMs = Number.isFinite(nowMs)
    ? Math.max(0, Math.floor(nowMs))
    : 0;
  const shouldEmit =
    state.totalEvents === 1 ||
    state.totalEvents % CHAT_CONVERSATION_SEARCH_UX_EMIT_EVERY_EVENTS === 0 ||
    safeNowMs - state.lastMetricAt >= CHAT_CONVERSATION_SEARCH_UX_EMIT_INTERVAL_MS;

  if (!shouldEmit) {
    return null;
  }

  state.lastMetricAt = safeNowMs;

  return {
    totalEvents: state.totalEvents,
    scopeSwitches: state.scopeSwitches,
    noResultRecoveries: state.noResultRecoveries,
    shortcutScopeSwitches: state.shortcutScopeSwitches,
    shortcutNoResultRecoveries: state.shortcutNoResultRecoveries,
    source: normalizedSource,
    sourceCount: state.bySource[normalizedSource],
    eventKind,
  };
}