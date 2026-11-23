import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

/**
 * How long a submit button stays in its red "failed" state after an attempt
 * fails before it re-enables. Long enough to read the label next to the error
 * message and to stop rapid repeat taps; short enough not to hold up a retry.
 */
export const SUBMIT_FAILED_RESET_MS = 3000;

const SHAKE_OFFSETS = [8, -8, 6, -6, 3, 0];
const SHAKE_STEP_MS = 50;

export type SubmitFailure = {
  /** True while the button should show its failed state (and stay disabled). */
  failed: boolean;
  /** Call when a submit attempt fails. Restarts the timer if already failed. */
  trigger: () => void;
  /** Drop the failed state early, e.g. when the form is closed or reset. */
  clear: () => void;
  /** Horizontal offset for the failed label; pass to `SubmitFailedContent`. */
  shake: Animated.Value;
};

/**
 * Failed-state feedback for a submit button: on `trigger()` the button flips to
 * `failed` for SUBMIT_FAILED_RESET_MS, the phone gives an error haptic, and the
 * label shakes once (skipped when the user has asked for reduced motion).
 *
 * Pair with `components/SubmitFailedContent` for the label, and include
 * `failed` in the button's `disabled` prop.
 */
export function useSubmitFailure(resetMs: number = SUBMIT_FAILED_RESET_MS): SubmitFailure {
  const [failed, setFailed] = useState(false);
  // Bumped on every trigger so the shake effect re-runs even if `failed` was
  // already true (a second failure inside the window).
  const [failureCount, setFailureCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shake = useRef(new Animated.Value(0)).current;

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setFailed(false);
  }, []);

  const trigger = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setFailed(true);
    setFailureCount((count) => count + 1);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setFailed(false);
    }, resetMs);

    if (Platform.OS !== 'web') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    }
  }, [resetMs]);

  // Run the shake after the render that mounted the failed label.
  useEffect(() => {
    if (failureCount === 0) return;
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduceMotion) => {
        if (cancelled || reduceMotion) return;
        const useNativeDriver = Platform.OS !== 'web';
        shake.setValue(0);
        Animated.sequence(
          SHAKE_OFFSETS.map((toValue) =>
            Animated.timing(shake, { toValue, duration: SHAKE_STEP_MS, useNativeDriver }),
          ),
        ).start();
      });
    return () => {
      cancelled = true;
    };
  }, [failureCount, shake]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { failed, trigger, clear, shake };
}
