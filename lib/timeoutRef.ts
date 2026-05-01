export type TimeoutRef = {
  current: ReturnType<typeof setTimeout> | null;
};

function normalizeDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return 0;
  }

  return Math.max(0, Math.floor(delayMs));
}

export function clearTimeoutRef(timeoutRef: TimeoutRef): void {
  if (!timeoutRef.current) {
    return;
  }

  clearTimeout(timeoutRef.current);
  timeoutRef.current = null;
}

export function scheduleTimeoutRef(
  timeoutRef: TimeoutRef,
  callback: () => void,
  delayMs: number
): void {
  clearTimeoutRef(timeoutRef);

  timeoutRef.current = setTimeout(() => {
    timeoutRef.current = null;
    callback();
  }, normalizeDelayMs(delayMs));
}