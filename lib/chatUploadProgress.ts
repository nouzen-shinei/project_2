export interface ChatUploadProgressEmitter {
  emit: (progress: unknown, options?: { force?: boolean }) => void;
  getLastProgress: () => number;
}

export interface CreateChatUploadProgressEmitterOptions {
  onProgress?: (progress: number) => void;
  minDeltaPercent?: number;
  minIntervalMs?: number;
  nowMs?: () => number;
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return numeric;
}

export function normalizeChatUploadProgressPercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric >= 100) {
    return 100;
  }

  return numeric;
}

export function resolveChatUploadProgressPercentFromBytes(
  sentBytes: unknown,
  totalBytes: unknown
): number | null {
  const normalizedSentBytes = Number(sentBytes);
  const normalizedTotalBytes = Number(totalBytes);
  if (
    !Number.isFinite(normalizedSentBytes) ||
    !Number.isFinite(normalizedTotalBytes) ||
    normalizedTotalBytes <= 0
  ) {
    return null;
  }

  return normalizeChatUploadProgressPercent(
    (normalizedSentBytes / normalizedTotalBytes) * 100
  );
}

export function createChatUploadProgressEmitter(
  options: CreateChatUploadProgressEmitterOptions = {}
): ChatUploadProgressEmitter {
  const minDeltaPercent = normalizeNonNegativeNumber(options.minDeltaPercent, 0.4);
  const minIntervalMs = normalizeNonNegativeNumber(options.minIntervalMs, 40);
  const resolveNowMs =
    typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();

  let hasEmitted = false;
  let lastProgress = 0;
  let lastEmittedAtMs = 0;

  const emit = (progress: unknown, emitOptions?: { force?: boolean }): void => {
    if (typeof options.onProgress !== 'function') {
      return;
    }

    const nextProgress = normalizeChatUploadProgressPercent(progress);
    const force = emitOptions?.force === true;
    const nowMs = resolveNowMs();

    if (force) {
      if (!hasEmitted || nextProgress !== lastProgress) {
        options.onProgress(nextProgress);
        hasEmitted = true;
        lastProgress = nextProgress;
        lastEmittedAtMs = nowMs;
      }
      return;
    }

    if (!hasEmitted) {
      options.onProgress(nextProgress);
      hasEmitted = true;
      lastProgress = nextProgress;
      lastEmittedAtMs = nowMs;
      return;
    }

    if (nextProgress <= lastProgress) {
      return;
    }

    const progressDelta = nextProgress - lastProgress;
    const elapsedMs = nowMs - lastEmittedAtMs;
    const shouldThrottle =
      nextProgress < 100 &&
      progressDelta < minDeltaPercent &&
      elapsedMs < minIntervalMs;

    if (shouldThrottle) {
      return;
    }

    options.onProgress(nextProgress);
    lastProgress = nextProgress;
    lastEmittedAtMs = nowMs;
  };

  return {
    emit,
    getLastProgress: () => lastProgress,
  };
}
