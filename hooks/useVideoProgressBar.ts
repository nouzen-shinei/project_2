import { useCallback, useRef, useMemo, useEffect } from 'react';
import { PanResponder, Animated, View, Platform, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

type UseVideoProgressBarOptions = {
  duration: number;
  onScrubChange: (time: number) => void;
  onScrubCommit: (time: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /**
   * When provided, set synchronously on every move/grant for zero-lag visual position.
   * Range [0, 1] — 0 = start, 1 = end of bar.
   */
  thumbAnimValue?: Animated.Value;
};

/**
 * Encapsulates all progress bar gesture logic.
 * Returns refs, layout handlers, a pan responder, and progressBarWidthRef.
 *
 * Key improvements over previous version:
 * - durationRef decouples resolveProgress identity from duration changes
 *   so the panResponder is never rebuilt when only duration changes.
 * - thumbAnimValue is set synchronously on every event for zero-lag visual position.
 * - RAF throttle coalesces state updates to at most 1 per frame.
 * - Fresh measure() on grant eliminates stale pageX offset bugs.
 * - progressBarWidthRef is exported for use in animated interpolations.
 */
export function useVideoProgressBar({
  duration,
  onScrubChange,
  onScrubCommit,
  onDragStart,
  onDragEnd,
  thumbAnimValue,
}: UseVideoProgressBarOptions) {
  const progressBarRef = useRef<View>(null);
  const progressBarWidthRef = useRef(1);
  const progressBarPageXRef = useRef<number | null>(null);

  // Stable ref for duration — resolveProgress closes over this instead of the
  // raw `duration` prop so its useCallback identity never changes when duration updates.
  const durationRef = useRef(duration);
  // RAF throttle state — ensures onScrubChange fires at most once per frame.
  const rafPendingRef = useRef(false);
  const lastEvtRef = useRef<GestureResponderEvent | null>(null);

  // Keep durationRef current without destabilising resolveProgress.
  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width } = event.nativeEvent.layout;
    if (Number.isFinite(width) && width > 0) {
      progressBarWidthRef.current = width;
    }
    if (progressBarRef.current && typeof progressBarRef.current.measure === 'function') {
      progressBarRef.current.measure((_x, _y, measuredWidth, _height, pageX) => {
        if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
          progressBarWidthRef.current = measuredWidth;
        }
        if (typeof pageX === 'number' && Number.isFinite(pageX)) {
          progressBarPageXRef.current = pageX;
        }
      });
    }
  }, []);

  // Stable — no deps that change after mount. Uses durationRef.current instead of
  // capturing `duration` directly so this callback is never recreated.
  const resolveProgress = useCallback((evt: GestureResponderEvent): number | null => {
    const { locationX, pageX } = evt.nativeEvent;
    let x: number | null = null;
    if (typeof locationX === 'number' && Number.isFinite(locationX)) {
      x = locationX;
    } else if (
      typeof pageX === 'number' &&
      Number.isFinite(pageX) &&
      progressBarPageXRef.current != null
    ) {
      x = pageX - progressBarPageXRef.current;
    }
    if (x == null) return null;
    const width = progressBarWidthRef.current;
    if (!Number.isFinite(width) || width <= 0) return null;
    return clamp(x / width, 0, 1) * durationRef.current;
  }, []); // intentionally empty — stable for the lifetime of the hook

  // Synchronously drives thumbAnimValue from a gesture event.
  // Fires on every raw pointer event — bypasses React state for zero-lag visual.
  const setThumbFromEvent = useCallback((evt: GestureResponderEvent) => {
    if (!thumbAnimValue) return;
    const { locationX, pageX } = evt.nativeEvent;
    let x: number | null = null;
    if (typeof locationX === 'number' && Number.isFinite(locationX)) {
      x = locationX;
    } else if (
      typeof pageX === 'number' &&
      Number.isFinite(pageX) &&
      progressBarPageXRef.current != null
    ) {
      x = pageX - progressBarPageXRef.current;
    }
    if (x == null) return;
    const width = progressBarWidthRef.current;
    if (!Number.isFinite(width) || width <= 0) return;
    thumbAnimValue.setValue(clamp(x / width, 0, 1));
  }, [thumbAnimValue]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          // Re-measure at gesture start to eliminate any stale pageX offset.
          if (progressBarRef.current && typeof progressBarRef.current.measure === 'function') {
            progressBarRef.current.measure((_x, _y, measuredWidth, _height, pageX) => {
              if (Number.isFinite(measuredWidth) && measuredWidth > 0) {
                progressBarWidthRef.current = measuredWidth;
              }
              if (Number.isFinite(pageX)) {
                progressBarPageXRef.current = pageX;
              }
            });
          }
          // Visual: synchronous, zero-lag (bypasses React state).
          setThumbFromEvent(evt);
          onDragStart?.();
          const t = resolveProgress(evt);
          if (t != null) onScrubChange(t);
        },
        onPanResponderMove: (evt) => {
          // Visual: synchronous every event — zero-lag thumb tracking.
          setThumbFromEvent(evt);
          // State: RAF-throttled — at most 1 re-render per frame.
          lastEvtRef.current = evt;
          if (!rafPendingRef.current) {
            rafPendingRef.current = true;
            const flush = () => {
              rafPendingRef.current = false;
              const latestEvt = lastEvtRef.current;
              if (latestEvt == null) return;
              const t = resolveProgress(latestEvt);
              if (t != null) onScrubChange(t);
            };
            if (Platform.OS === 'web' && typeof requestAnimationFrame !== 'undefined') {
              requestAnimationFrame(flush);
            } else {
              // On native, defer one tick to avoid synchronous setState inside PanResponder.
              setTimeout(flush, 0);
            }
          }
        },
        onPanResponderRelease: (evt) => {
          rafPendingRef.current = false;
          lastEvtRef.current = null;
          setThumbFromEvent(evt);
          onDragEnd?.();
          const t = resolveProgress(evt);
          if (t != null) onScrubCommit(t);
        },
        onPanResponderTerminate: (evt) => {
          rafPendingRef.current = false;
          lastEvtRef.current = null;
          setThumbFromEvent(evt);
          onDragEnd?.();
          const t = resolveProgress(evt);
          if (t != null) onScrubCommit(t);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    // resolveProgress and setThumbFromEvent are both stable (no deps that change).
    // The 4 callbacks are wrapped in useCallback by callers for stable identity.
    [resolveProgress, setThumbFromEvent, onScrubChange, onScrubCommit, onDragStart, onDragEnd]
  );

  return { progressBarRef, handleLayout, panResponder, progressBarWidthRef };
}
