import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clampUploadProgressPercent,
  resolveUploadProgressDisplayStep,
  type UploadProgressDisplayEasingOptions,
} from '@/lib/uploadProgressDisplayEasing';

export interface UseEasedUploadProgressOptions
  extends UploadProgressDisplayEasingOptions {
  isActive?: boolean;
  resetWhenInactive?: boolean;
}

const DISPLAY_PROGRESS_CATCH_UP_EPSILON = 0.05;

export function useEasedUploadProgress(
  targetProgress: number,
  options: UseEasedUploadProgressOptions = {}
): number {
  const {
    isActive = true,
    resetWhenInactive = true,
    smoothingPerSecond,
    minStepPercent,
    completionSnapThresholdPercent,
    nearCompletionBoostStartPercent,
    nearCompletionBoostMultiplier,
  } = options;

  const easingOptions = useMemo<UploadProgressDisplayEasingOptions>(
    () => ({
      smoothingPerSecond,
      minStepPercent,
      completionSnapThresholdPercent,
      nearCompletionBoostStartPercent,
      nearCompletionBoostMultiplier,
    }),
    [
      completionSnapThresholdPercent,
      minStepPercent,
      nearCompletionBoostMultiplier,
      nearCompletionBoostStartPercent,
      smoothingPerSecond,
    ]
  );

  const initialProgress = clampUploadProgressPercent(targetProgress);
  const [displayProgress, setDisplayProgress] =
    useState<number>(initialProgress);
  const displayProgressRef = useRef<number>(initialProgress);
  const targetProgressRef = useRef<number>(initialProgress);
  const frameRequestRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  const stopAnimation = useCallback(() => {
    if (
      frameRequestRef.current !== null &&
      typeof cancelAnimationFrame === 'function'
    ) {
      cancelAnimationFrame(frameRequestRef.current);
    }
    frameRequestRef.current = null;
    lastFrameAtRef.current = null;
  }, []);

  const updateDisplayProgress = useCallback((nextProgress: number) => {
    const normalized = clampUploadProgressPercent(nextProgress);
    if (displayProgressRef.current === normalized) {
      return;
    }

    displayProgressRef.current = normalized;
    setDisplayProgress(normalized);
  }, []);

  const tick = useCallback(
    (frameNowMs: number) => {
      const elapsedMs =
        typeof lastFrameAtRef.current === 'number'
          ? Math.max(0, frameNowMs - lastFrameAtRef.current)
          : 16;
      lastFrameAtRef.current = frameNowMs;

      const nextProgress = resolveUploadProgressDisplayStep(
        displayProgressRef.current,
        targetProgressRef.current,
        elapsedMs,
        easingOptions
      );

      updateDisplayProgress(nextProgress);

      const shouldContinue =
        targetProgressRef.current - displayProgressRef.current >
        DISPLAY_PROGRESS_CATCH_UP_EPSILON;

      if (shouldContinue && typeof requestAnimationFrame === 'function') {
        frameRequestRef.current = requestAnimationFrame(tick);
        return;
      }

      frameRequestRef.current = null;
      lastFrameAtRef.current = null;
    },
    [easingOptions, updateDisplayProgress]
  );

  const ensureAnimation = useCallback(() => {
    if (targetProgressRef.current <= displayProgressRef.current) {
      return;
    }

    if (typeof requestAnimationFrame !== 'function') {
      updateDisplayProgress(targetProgressRef.current);
      return;
    }

    if (frameRequestRef.current !== null) {
      return;
    }

    frameRequestRef.current = requestAnimationFrame(tick);
  }, [tick, updateDisplayProgress]);

  useEffect(() => {
    const normalizedTarget = clampUploadProgressPercent(targetProgress);
    targetProgressRef.current = normalizedTarget;

    if (normalizedTarget <= 0 && displayProgressRef.current > 0) {
      stopAnimation();
      updateDisplayProgress(0);
      return;
    }

    if (resetWhenInactive && !isActive && normalizedTarget <= 0) {
      stopAnimation();
      updateDisplayProgress(0);
      return;
    }

    ensureAnimation();
  }, [
    ensureAnimation,
    isActive,
    resetWhenInactive,
    stopAnimation,
    targetProgress,
    updateDisplayProgress,
  ]);

  useEffect(
    () => () => {
      stopAnimation();
    },
    [stopAnimation]
  );

  return displayProgress;
}
