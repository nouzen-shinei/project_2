import { useCallback, useRef, useMemo } from 'react';
import { PanResponder, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

type UseVideoProgressBarOptions = {
  duration: number;
  onScrubChange: (time: number) => void;
  onScrubCommit: (time: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
};

/**
 * Encapsulates all progress bar gesture logic.
 * Returns refs, layout handlers, and a pan responder — attach them
 * to the progress bar View to get drag-to-seek behaviour.
 */
export function useVideoProgressBar({
  duration,
  onScrubChange,
  onScrubCommit,
  onDragStart,
  onDragEnd,
}: UseVideoProgressBarOptions) {
  const progressBarRef = useRef<View>(null);
  const progressBarWidthRef = useRef(1);
  const progressBarPageXRef = useRef<number | null>(null);

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
    return clamp(x / width, 0, 1) * duration;
  }, [duration]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          onDragStart?.();
          const t = resolveProgress(evt);
          if (t != null) onScrubChange(t);
        },
        onPanResponderMove: (evt) => {
          const t = resolveProgress(evt);
          if (t != null) onScrubChange(t);
        },
        onPanResponderRelease: (evt) => {
          onDragEnd?.();
          const t = resolveProgress(evt);
          if (t != null) onScrubCommit(t);
        },
        onPanResponderTerminate: (evt) => {
          onDragEnd?.();
          const t = resolveProgress(evt);
          if (t != null) onScrubCommit(t);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolveProgress, onScrubChange, onScrubCommit, onDragStart, onDragEnd]
  );

  return { progressBarRef, handleLayout, panResponder };
}
