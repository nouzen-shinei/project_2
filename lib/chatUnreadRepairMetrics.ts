export interface ChatUnreadRepairRunPayload extends Record<string, unknown> {
  partnerEmail: string;
  fixedCount: number;
  durationMs: number;
}

export interface ChatUnreadRepairEligibilityInput {
  userEmail: unknown;
  partnerEmail: unknown;
  isFocused: boolean;
  isAppActive: boolean;
  inFlight: boolean;
  lastPartnerEmail: unknown;
  lastRunAtMs: unknown;
  nowMs?: number;
  throttleMs?: number;
}

export interface ChatUnreadRepairEligibilityResult {
  shouldRun: boolean;
  userEmail: string | null;
  partnerEmail: string | null;
  nowMs: number;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : 'unknown';
}

function normalizeParticipantEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeFixedCount(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function normalizeTime(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function resolveNowMs(value: unknown): number {
  const safeNow = normalizeTime(value);
  if (safeNow > 0) {
    return safeNow;
  }

  return Date.now();
}

function resolveThrottleMs(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 45000;
  }

  return Math.trunc(numeric);
}

export function resolveChatUnreadRepairEligibility(
  input: ChatUnreadRepairEligibilityInput
): ChatUnreadRepairEligibilityResult {
  const userEmail = normalizeParticipantEmail(input.userEmail);
  const partnerEmail = normalizeParticipantEmail(input.partnerEmail);
  const nowMs = resolveNowMs(input.nowMs);

  if (!userEmail || !partnerEmail) {
    return {
      shouldRun: false,
      userEmail,
      partnerEmail,
      nowMs,
    };
  }

  if (!input.isFocused || !input.isAppActive || input.inFlight) {
    return {
      shouldRun: false,
      userEmail,
      partnerEmail,
      nowMs,
    };
  }

  const lastPartnerEmail = normalizeParticipantEmail(input.lastPartnerEmail);
  const lastRunAtMs = normalizeTime(input.lastRunAtMs);
  const throttleMs = resolveThrottleMs(input.throttleMs);
  const withinThrottleWindow =
    throttleMs > 0 &&
    lastPartnerEmail === partnerEmail &&
    nowMs - lastRunAtMs < throttleMs;

  return {
    shouldRun: !withinThrottleWindow,
    userEmail,
    partnerEmail,
    nowMs,
  };
}

export function resolveChatUnreadRepairRunPayload(
  partnerEmail: unknown,
  fixedCount: unknown,
  repairStartedAtMs: number,
  nowMs: number = Date.now()
): ChatUnreadRepairRunPayload {
  const safeStartMs = normalizeTime(repairStartedAtMs);
  const safeNowMs = normalizeTime(nowMs);

  return {
    partnerEmail: normalizeEmail(partnerEmail),
    fixedCount: normalizeFixedCount(fixedCount),
    durationMs: Math.max(0, safeNowMs - safeStartMs),
  };
}