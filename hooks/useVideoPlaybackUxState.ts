import { useEffect, useMemo, useRef, useState } from 'react';
import type { VideoPlayerStatus } from 'expo-video';

export type VideoPlaybackPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'buffering'
  | 'stalled'
  | 'ended'
  | 'error';

export type VideoPlaybackUxState = {
  phase: VideoPlaybackPhase;
  isInitialLoading: boolean;
  isBuffering: boolean;
  isStalled: boolean;
  isReady: boolean;
  isEnded: boolean;
  isError: boolean;
  bufferedPercent: number | null;
  statusLabel: string | null;
  statusDetail: string | null;
  showOverlay: boolean;
  showSpinner: boolean;
  showPercent: boolean;
};

type UseVideoPlaybackUxStateParams = {
  status?: VideoPlayerStatus;
  isLoading: boolean;
  isPlaying: boolean;
  intendedPlaying: boolean;
  duration: number;
  currentTime: number;
  bufferedPosition?: number | null;
  bufferedPercentOverride?: number | null;
  isSeeking: boolean;
  hasResolvedUri: boolean;
  error?: string | null;
  ended?: boolean;
  externalBuffering?: boolean;
  externalStalled?: boolean;
  bufferingDelayMs?: number;
  bufferingExitDelayMs?: number;
  stallThresholdMs?: number;
  bufferGapSeconds?: number;
};

const clamp = (value: number, min = 0, max = 100) => Math.min(max, Math.max(min, value));

const useDelayedBoolean = (
  value: boolean,
  { enterDelayMs = 180, exitDelayMs = 140 }: { enterDelayMs?: number; exitDelayMs?: number } = {}
) => {
  const [resolved, setResolved] = useState(value);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (resolved === value) {
      return;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const delay = value ? enterDelayMs : exitDelayMs;
    timeoutRef.current = setTimeout(() => {
      setResolved(value);
      timeoutRef.current = null;
    }, delay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [enterDelayMs, exitDelayMs, resolved, value]);

  return resolved;
};

const useStallDetector = (active: boolean, currentTime: number, stallThresholdMs: number) => {
  const [isStalled, setIsStalled] = useState(false);
  const lastProgressRef = useRef({ time: currentTime, at: Date.now() });

  useEffect(() => {
    if (!active) {
      setIsStalled(false);
      lastProgressRef.current = { time: currentTime, at: Date.now() };
      return;
    }
    if (Math.abs(currentTime - lastProgressRef.current.time) > 0.05) {
      lastProgressRef.current = { time: currentTime, at: Date.now() };
      if (isStalled) {
        setIsStalled(false);
      }
    }
  }, [active, currentTime, isStalled]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setTimeout(() => {
      const elapsed = Date.now() - lastProgressRef.current.at;
      if (elapsed >= stallThresholdMs) {
        setIsStalled(true);
      }
    }, stallThresholdMs);
    return () => clearTimeout(timer);
  }, [active, currentTime, stallThresholdMs]);

  return isStalled;
};

export const useVideoPlaybackUxState = ({
  status = 'idle',
  isLoading,
  isPlaying,
  intendedPlaying,
  duration,
  currentTime,
  bufferedPosition,
  bufferedPercentOverride,
  isSeeking,
  hasResolvedUri,
  error,
  ended,
  externalBuffering,
  externalStalled,
  bufferingDelayMs,
  bufferingExitDelayMs,
  stallThresholdMs = 1800,
  bufferGapSeconds = 0.4,
}: UseVideoPlaybackUxStateParams): VideoPlaybackUxState => {
  const [hasReady, setHasReady] = useState(false);
  const lastBufferedPercentRef = useRef<number | null>(null);

  useEffect(() => {
    if (!hasReady && (status === 'readyToPlay' || duration > 0)) {
      setHasReady(true);
    }
  }, [duration, hasReady, status]);

  const computedBufferedPercent = useMemo(() => {
    if (typeof bufferedPercentOverride === 'number' && Number.isFinite(bufferedPercentOverride)) {
      return clamp(bufferedPercentOverride, 0, 100);
    }
    if (duration > 0 && typeof bufferedPosition === 'number' && Number.isFinite(bufferedPosition)) {
      return clamp((bufferedPosition / duration) * 100, 0, 100);
    }
    if (duration > 0 && Number.isFinite(currentTime) && currentTime >= 0) {
      return clamp((currentTime / duration) * 100, 0, 100);
    }
    return null;
  }, [bufferedPercentOverride, bufferedPosition, currentTime, duration]);

  useEffect(() => {
    if (computedBufferedPercent != null) {
      lastBufferedPercentRef.current = computedBufferedPercent;
    }
  }, [computedBufferedPercent]);

  const bufferedPercent = computedBufferedPercent ?? lastBufferedPercentRef.current;
  const hasError = status === 'error' || !!error;
  const endedResolved =
    ended ??
    (hasReady && duration > 0 && Number.isFinite(currentTime) && currentTime >= duration - 0.25 && !isPlaying);

  const isInitialLoading = !hasReady && (isLoading || status === 'loading' || !hasResolvedUri);
  const canBuffer = intendedPlaying && hasReady && !isSeeking && !hasError && !endedResolved;
  const bufferGap =
    typeof bufferedPosition === 'number' && Number.isFinite(bufferedPosition)
      ? bufferedPosition - currentTime
      : null;

  const bufferingRaw =
    !!externalBuffering ||
    (canBuffer &&
      (status === 'loading' ||
        (bufferGap != null && Number.isFinite(bufferGap) && bufferGap < bufferGapSeconds)));
  const isBuffering = useDelayedBoolean(bufferingRaw, {
    enterDelayMs: bufferingDelayMs,
    exitDelayMs: bufferingExitDelayMs,
  });

  const detectedStall = useStallDetector(canBuffer && !externalStalled, currentTime, stallThresholdMs);
  const stalledRaw = !!externalStalled || detectedStall;
  const isStalled = useDelayedBoolean(stalledRaw, { enterDelayMs: 380, exitDelayMs: 220 });

  const phase: VideoPlaybackPhase = useMemo(() => {
    if (hasError) return 'error';
    if (endedResolved) return 'ended';
    if (isInitialLoading) return 'loading';
    if (isStalled) return 'stalled';
    if (isBuffering) return 'buffering';
    if (hasReady) return 'ready';
    return 'idle';
  }, [endedResolved, hasError, hasReady, isBuffering, isInitialLoading, isStalled]);

  const { statusLabel, statusDetail } = useMemo(() => {
    switch (phase) {
      case 'loading':
        return {
          statusLabel: 'Preparing video',
          statusDetail: 'Setting up playback...',
        };
      case 'buffering':
        return {
          statusLabel: 'Buffering...',
          statusDetail: 'Loading data...',
        };
      case 'stalled':
        return {
          // "Reconnecting" implies a network drop which is rarely what's happening.
          // On web this state fires during normal heavy buffering; use neutral copy.
          statusLabel: 'Buffering…',
          statusDetail: 'Loading video data…',
        };
      case 'ended':
        return {
          statusLabel: 'Playback finished',
          statusDetail: 'Tap replay to watch again.',
        };
      case 'error':
        return {
          statusLabel: 'Video unavailable',
          statusDetail: 'This video could not be loaded. Tap retry to try again.',
        };
      default:
        return { statusLabel: null, statusDetail: null };
    }
  }, [phase]);

  return {
    phase,
    isInitialLoading,
    isBuffering,
    isStalled,
    isReady: phase === 'ready',
    isEnded: phase === 'ended',
    isError: phase === 'error',
    bufferedPercent: bufferedPercent ?? null,
    statusLabel,
    statusDetail,
    showOverlay: phase !== 'ready' && phase !== 'idle' && phase !== 'ended',
    showSpinner: phase === 'loading' || phase === 'buffering' || phase === 'stalled',
    showPercent: phase === 'loading' || phase === 'buffering' || phase === 'stalled',
  };
};
