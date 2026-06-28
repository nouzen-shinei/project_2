import { useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';

/**
 * Shared "is the app/tab in the foreground?" tracker.
 *
 * Why this exists:
 * Several screens and hooks run `setInterval` polling loops and periodic
 * network probes. When a browser tab or the native app is backgrounded the
 * OS/browser heavily throttles timers and then fires the backlog in a burst
 * the moment the app returns to the foreground. That burst (AsyncStorage
 * reads, Firestore refetches, RTT probes, re-renders) is the main reason the
 * app feels frozen/laggy for a moment right after switching back to it.
 *
 * This module exposes a single source of truth for foreground state across
 * web (`visibilitychange` / `focus` / `blur`) and native (`AppState`), plus a
 * `useForegroundInterval` helper that only ticks while foregrounded and runs
 * once on resume so data stays fresh without the backlog.
 */

let isForeground = true;
const listeners = new Set<(active: boolean) => void>();
let initialized = false;

function computeWebVisible(): boolean {
  if (typeof document === 'undefined') return true;
  // `visibilityState` covers tab switches; `document.hasFocus()` is intentionally
  // not used here because a visible-but-unfocused window should still poll.
  return document.visibilityState !== 'hidden';
}

function setForeground(next: boolean) {
  if (next === isForeground) return;
  isForeground = next;
  listeners.forEach((listener) => {
    try {
      listener(next);
    } catch {
      // A listener throwing must not break foreground propagation for others.
    }
  });
}

function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined') {
      isForeground = computeWebVisible();
      document.addEventListener('visibilitychange', () => setForeground(computeWebVisible()));
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => setForeground(true));
      // Don't treat blur as background on web: a blurred-but-visible tab should
      // keep working. Only `visibilitychange` flips us to background.
    }
    return;
  }

  // Native: AppState is authoritative.
  isForeground = (AppState.currentState ?? 'active') === 'active';
  AppState.addEventListener('change', (next: AppStateStatus) => {
    setForeground(next === 'active');
  });
}

/** Imperative access to the current foreground state. */
export function isAppForeground(): boolean {
  ensureInitialized();
  return isForeground;
}

/** Subscribe to foreground changes. Returns an unsubscribe function. */
export function subscribeAppForeground(listener: (active: boolean) => void): () => void {
  ensureInitialized();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook returning whether the app/tab is currently foregrounded. */
export function useAppForeground(): boolean {
  const [active, setActive] = useState<boolean>(() => isAppForeground());

  useEffect(() => {
    // Re-sync immediately in case state changed between render and subscribe.
    setActive(isAppForeground());
    return subscribeAppForeground(setActive);
  }, []);

  return active;
}

/**
 * Returns `value` immediately when it becomes true, but delays the transition
 * to false by `lingerMs`. Useful for keeping an expensive subscription alive
 * across brief background/blur episodes (e.g. a quick tab switch) so it does
 * not tear down and immediately rebuild, which is costly.
 */
export function useLingeringFlag(value: boolean, lingerMs: number): boolean {
  const [active, setActive] = useState<boolean>(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setActive(true);
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setActive(false);
    }, lingerMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, lingerMs]);

  return active;
}

export interface ForegroundIntervalOptions {
  /** When false the interval is fully disabled regardless of foreground state. */
  enabled?: boolean;
  /**
   * Run the callback immediately when (re)starting in the foreground. Defaults
   * to true so data is refreshed once on resume instead of waiting a full tick.
   */
  runOnResume?: boolean;
}

/**
 * Like `setInterval`, but the timer only runs while the app/tab is foregrounded.
 * When the app goes to the background the timer is cleared; when it returns the
 * callback fires once immediately (unless `runOnResume` is false) and the
 * interval resumes. This eliminates the throttled-timer backlog burst on resume.
 */
export function useForegroundInterval(
  callback: () => void,
  intervalMs: number,
  options: ForegroundIntervalOptions = {}
): void {
  const { enabled = true, runOnResume = true } = options;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) {
      return;
    }

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = (runNow: boolean) => {
      if (timer) return;
      if (runNow) {
        try {
          callbackRef.current();
        } catch {
          // Swallow: a failing tick should not tear down the interval.
        }
      }
      timer = setInterval(() => {
        try {
          callbackRef.current();
        } catch {
          // ignore individual tick failures
        }
      }, intervalMs);
    };

    if (isAppForeground()) {
      start(true);
    }

    const unsubscribe = subscribeAppForeground((active) => {
      if (active) {
        start(runOnResume);
      } else {
        stop();
      }
    });

    return () => {
      unsubscribe();
      stop();
    };
  }, [enabled, intervalMs, runOnResume]);
}
