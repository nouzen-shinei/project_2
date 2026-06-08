/**
 * useRecordingTimer
 *
 * A 1-second interval timer designed for video recording UIs.
 * Tracks elapsed time, computes remaining time (when a max duration is set),
 * and formats both values as "MM:SS" strings. Automatically calls `onExpire`
 * and stops when `elapsed` reaches `maxSeconds` (only when `maxSeconds > 0`).
 *
 * Usage:
 *   const timer = useRecordingTimer({ maxSeconds: 60, onExpire: handleAutoStop });
 *   timer.start();   // begin counting
 *   timer.stop();    // pause without resetting
 *   timer.reset();   // stop and return to 0
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RecordingTimerOptions {
  /** Maximum recording duration in seconds. 0 means no limit. */
  maxSeconds: number;
  /** Called once when elapsed >= maxSeconds (only when maxSeconds > 0). */
  onExpire?: () => void;
}

export interface RecordingTimerResult {
  /** Seconds elapsed since start (or since last reset). */
  elapsed: number;
  /** Seconds remaining until maxSeconds. Infinity when maxSeconds is 0. */
  remaining: number;
  /** Elapsed formatted as "MM:SS". */
  formattedElapsed: string;
  /** Remaining formatted as "MM:SS". Infinity when maxSeconds is 0. */
  formattedRemaining: string;
  /** Start (or resume) the interval from the current elapsed value. */
  start: () => void;
  /** Clear the interval without resetting elapsed. */
  stop: () => void;
  /** Clear the interval and reset elapsed to 0. */
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Formats a non-negative integer of seconds as "MM:SS". */
const formatSeconds = (s: number): string => {
  const mins = Math.floor(s / 60).toString().padStart(2, '0');
  const secs = (s % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRecordingTimer({
  maxSeconds,
  onExpire,
}: RecordingTimerOptions): RecordingTimerResult {
  const [elapsed, setElapsed] = useState(0);

  // Keep stable ref to the interval so start/stop/reset don't need to be
  // recreated whenever elapsed changes.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Ref for onExpire so the interval closure always sees the latest value
  // without needing to be torn down and recreated on every render.
  const onExpireRef = useRef(onExpire);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  // Ref for maxSeconds for the same reason.
  const maxSecondsRef = useRef(maxSeconds);
  useEffect(() => {
    maxSecondsRef.current = maxSeconds;
  }, [maxSeconds]);

  // Track whether onExpire has already been fired for the current run so it
  // is called exactly once.
  const expiredRef = useRef(false);

  const stop = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stop();
    expiredRef.current = false;
    setElapsed(0);
  }, [stop]);

  const start = useCallback(() => {
    // Prevent double-starting.
    if (intervalRef.current !== null) return;

    intervalRef.current = setInterval(() => {
      setElapsed((prev) => {
        const next = prev + 1;
        const max = maxSecondsRef.current;

        if (max > 0 && next >= max && !expiredRef.current) {
          expiredRef.current = true;

          // Stop the interval on the next tick to avoid calling setElapsed
          // after the component may have unmounted.
          setTimeout(() => {
            if (intervalRef.current !== null) {
              clearInterval(intervalRef.current);
              intervalRef.current = null;
            }
            onExpireRef.current?.();
          }, 0);
        }

        return next;
      });
    }, 1000);
  }, []);

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  const remaining = maxSeconds > 0 ? Math.max(0, maxSeconds - elapsed) : Infinity;

  return {
    elapsed,
    remaining,
    formattedElapsed: formatSeconds(elapsed),
    formattedRemaining: maxSeconds > 0 ? formatSeconds(remaining) : '∞',
    start,
    stop,
    reset,
  };
}
