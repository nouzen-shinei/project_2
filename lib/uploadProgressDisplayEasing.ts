export interface UploadProgressDisplayEasingOptions {
  smoothingPerSecond?: number;
  minStepPercent?: number;
  completionSnapThresholdPercent?: number;
  nearCompletionBoostStartPercent?: number;
  nearCompletionBoostMultiplier?: number;
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }

  return numeric;
}

export function clampUploadProgressPercent(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric >= 100) {
    return 100;
  }

  return numeric;
}

export function normalizeUploadProgressDisplayPercent(value: unknown): number {
  return Math.round(clampUploadProgressPercent(value));
}

export function resolveProgressPercentText(progressPercent: unknown): string {
  return `${normalizeUploadProgressDisplayPercent(progressPercent)}%`;
}

function resolveIdleDownloadLabel(idleLabel: unknown): string {
  if (typeof idleLabel !== 'string') {
    return 'Download';
  }

  const normalizedIdleLabel = idleLabel.trim();
  return normalizedIdleLabel || 'Download';
}

export function resolveDownloadProgressLabel(
  isDownloading: boolean,
  progressPercent: unknown,
  idleLabel: string = 'Download'
): string {
  if (!isDownloading) {
    return resolveIdleDownloadLabel(idleLabel);
  }

  return `Downloading ${resolveProgressPercentText(progressPercent)}`;
}

function resolveSmoothingAlpha(
  elapsedMs: number,
  smoothingPerSecond: number
): number {
  const normalizedElapsedMs = Math.max(0, elapsedMs);
  if (normalizedElapsedMs <= 0) {
    return 0;
  }

  return 1 - Math.exp((-smoothingPerSecond * normalizedElapsedMs) / 1000);
}

export function resolveUploadProgressDisplayStep(
  currentProgress: unknown,
  targetProgress: unknown,
  elapsedMs: unknown,
  options: UploadProgressDisplayEasingOptions = {}
): number {
  const current = clampUploadProgressPercent(currentProgress);
  const target = clampUploadProgressPercent(targetProgress);

  if (target <= current) {
    // Allow instant reset between upload sessions.
    return target <= 0 ? 0 : current;
  }

  const normalizedElapsedMs = normalizeNonNegativeNumber(elapsedMs, 0);
  if (normalizedElapsedMs <= 0) {
    return current;
  }

  const smoothingPerSecond = Math.max(
    0.1,
    normalizeNonNegativeNumber(options.smoothingPerSecond, 10)
  );
  const minStepPercent = Math.max(
    0,
    normalizeNonNegativeNumber(options.minStepPercent, 0.12)
  );
  const completionSnapThresholdPercent = Math.max(
    90,
    normalizeNonNegativeNumber(options.completionSnapThresholdPercent, 99.5)
  );
  const nearCompletionBoostStartPercent = Math.min(
    100,
    Math.max(
      80,
      normalizeNonNegativeNumber(options.nearCompletionBoostStartPercent, 96)
    )
  );
  const nearCompletionBoostMultiplier = Math.min(
    4,
    Math.max(
      1,
      normalizeNonNegativeNumber(options.nearCompletionBoostMultiplier, 1.35)
    )
  );

  let effectiveSmoothingPerSecond = smoothingPerSecond;
  if (
    target >= nearCompletionBoostStartPercent &&
    current >= nearCompletionBoostStartPercent
  ) {
    effectiveSmoothingPerSecond *= nearCompletionBoostMultiplier;
  }

  const alpha = resolveSmoothingAlpha(normalizedElapsedMs, effectiveSmoothingPerSecond);
  const easedProgress = current + (target - current) * alpha;
  const boundedMinStep = Math.min(minStepPercent, target - current);
  const nextProgress = Math.min(
    target,
    Math.max(easedProgress, current + boundedMinStep)
  );

  if (target >= 100 && nextProgress >= completionSnapThresholdPercent) {
    return 100;
  }

  return clampUploadProgressPercent(nextProgress);
}
