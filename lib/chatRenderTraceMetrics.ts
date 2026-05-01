export type ChatRenderTraceReason = 'initial' | 'refresh';

export interface ChatRenderTraceProfile {
  hydration?: number | null;
  downloads?: number | null;
  deviceType?: string | number | null;
  totalMemory?: number | null;
}

export interface ChatRenderTraceState {
  startedAt: number;
  conversationId: string;
  reason: ChatRenderTraceReason;
  profile?: ChatRenderTraceProfile | null;
}

export interface ChatRenderTraceStartPayload extends Record<string, unknown> {
  conversationId: string;
  reason: ChatRenderTraceReason;
  messageCount: number;
}

export interface ChatRenderTraceCompletePayload extends Record<string, unknown> {
  conversationId: string;
  reason: ChatRenderTraceReason;
  durationMs: number;
  messageCount: number;
  hydrationConcurrency: number | null;
  downloadConcurrency: number | null;
  deviceType: string | number | null;
  totalMemoryBytes: number | null;
}

function normalizeReason(value: unknown): ChatRenderTraceReason {
  return value === 'refresh' ? 'refresh' : 'initial';
}

function normalizeConversationId(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : 'unknown';
}

function normalizePositiveInteger(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }

  return Math.trunc(numeric);
}

function normalizeDeviceType(value: unknown): string | number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTime(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function normalizeProfile(
  value: ChatRenderTraceProfile | null | undefined
): ChatRenderTraceProfile | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const hydration = normalizeNullableInteger(value.hydration);
  const downloads = normalizeNullableInteger(value.downloads);
  const totalMemory = normalizeNullableInteger(value.totalMemory);
  const deviceType = normalizeDeviceType(value.deviceType);

  if (
    hydration === null &&
    downloads === null &&
    totalMemory === null &&
    deviceType === null
  ) {
    return null;
  }

  return {
    hydration,
    downloads,
    deviceType,
    totalMemory,
  };
}

export function createChatRenderTraceState(
  conversationId: unknown,
  reason: unknown,
  startedAtMs: number = Date.now(),
  profile?: ChatRenderTraceProfile | null
): ChatRenderTraceState {
  return {
    startedAt: normalizeTime(startedAtMs),
    conversationId: normalizeConversationId(conversationId),
    reason: normalizeReason(reason),
    profile: normalizeProfile(profile),
  };
}

export function resolveChatRenderTraceStartPayload(
  conversationId: unknown,
  reason: unknown,
  messageCount: unknown
): ChatRenderTraceStartPayload {
  return {
    conversationId: normalizeConversationId(conversationId),
    reason: normalizeReason(reason),
    messageCount: normalizePositiveInteger(messageCount),
  };
}

export function resolveChatRenderTraceCompletePayload(
  state: ChatRenderTraceState,
  messageCount: unknown,
  profileFallback?: ChatRenderTraceProfile | null,
  nowMs: number = Date.now()
): ChatRenderTraceCompletePayload {
  const safeNowMs = normalizeTime(nowMs);
  const safeStartedAt = normalizeTime(state.startedAt);
  const profile = normalizeProfile(state.profile) || normalizeProfile(profileFallback);

  return {
    conversationId: normalizeConversationId(state.conversationId),
    reason: normalizeReason(state.reason),
    durationMs: Math.max(0, safeNowMs - safeStartedAt),
    messageCount: normalizePositiveInteger(messageCount),
    hydrationConcurrency: normalizeNullableInteger(profile?.hydration),
    downloadConcurrency: normalizeNullableInteger(profile?.downloads),
    deviceType: normalizeDeviceType(profile?.deviceType),
    totalMemoryBytes: normalizeNullableInteger(profile?.totalMemory),
  };
}