import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { logger } from '@/lib/logger';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface WebPlayerState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  bufferedPercent: number | null;
  isBuffering: boolean;
  isStalled: boolean;
  error: string | null;
  ended: boolean;
}

export interface UseWebVideoPlayerOptions {
  /** The source URI to load (after codec decision has been made by caller). */
  resolvedUri: string;
  autoPlay?: boolean;
  initialPosition?: number;
  isMuted?: boolean;
  playbackSpeed?: number;
  /** Called when an UnsupportedCodecError is detected (zero-dimension video or MediaError code 3/4). */
  onUnsupportedCodec?: (currentTime: number) => void;
  onError?: (error: string) => void;
  onEnded?: () => void;
  onReady?: () => void;
}

// ─── Initial state factory ────────────────────────────────────────────────────

const buildInitialState = (): WebPlayerState => ({
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  bufferedPercent: null,
  isBuffering: false,
  isStalled: false,
  error: null,
  ended: false,
});

// ─── Helper: resolve buffered percent from a video element ────────────────────

const resolveBufferedPercent = (el: HTMLVideoElement): number | null => {
  const duration = el.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  try {
    const { buffered } = el;
    if (!buffered || buffered.length === 0) {
      return null;
    }
    const end = buffered.end(buffered.length - 1);
    if (!Number.isFinite(end)) {
      return null;
    }
    return Math.min(100, Math.max(0, (end / duration) * 100));
  } catch {
    return null;
  }
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Manages a web `<video>` element for a given resolved URI.
 *
 * - The `videoRef.current` DOM element is stable across state-only re-renders;
 *   a new element is created only when `resolvedUri` changes.
 * - Event listeners are attached/detached cleanly on URI changes.
 * - UnsupportedCodecError is detected via zero videoWidth/videoHeight after
 *   `loadedmetadata` (with duration > 0) or MediaError code 3 / 4.
 *
 * Requirements: 4.2, 4.7
 */
export function useWebVideoPlayer(options: UseWebVideoPlayerOptions): {
  state: WebPlayerState;
  /** Stable ref — same HTMLVideoElement across state-only re-renders. */
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setMuted: (muted: boolean) => void;
  setPlaybackSpeed: (speed: number) => void;
} {
  const {
    resolvedUri,
    autoPlay = false,
    initialPosition = 0,
    isMuted = false,
    playbackSpeed = 1,
    onUnsupportedCodec,
    onError,
    onEnded,
    onReady,
  } = options;

  const [state, setState] = useState<WebPlayerState>(buildInitialState);

  // The video element ref is stable per resolvedUri — it is created once and
  // mutated in-place for mute/speed/position changes.
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Keep callback refs stable so event listeners don't capture stale closures.
  const onUnsupportedCodecRef = useRef(onUnsupportedCodec);
  const onErrorRef = useRef(onError);
  const onEndedRef = useRef(onEnded);
  const onReadyRef = useRef(onReady);
  const isMutedRef = useRef(isMuted);
  const playbackSpeedRef = useRef(playbackSpeed);
  const initialPositionRef = useRef(initialPosition);
  const autoPlayRef = useRef(autoPlay);
  const initialPositionAppliedRef = useRef(false);

  useEffect(() => { onUnsupportedCodecRef.current = onUnsupportedCodec; }, [onUnsupportedCodec]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onEndedRef.current = onEnded; }, [onEnded]);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { playbackSpeedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { initialPositionRef.current = initialPosition; }, [initialPosition]);
  useEffect(() => { autoPlayRef.current = autoPlay; }, [autoPlay]);

  // ── Wire up / re-wire the React DOM <video> element when resolvedUri changes ─
  //
  // WHY useLayoutEffect instead of useEffect:
  // React sets `videoRef.current` to the DOM element during the commit phase,
  // which happens BEFORE layout effects run but AFTER paint effects (useEffect).
  // Using useEffect would race with React's ref assignment — the effect could
  // see null or a stale element. useLayoutEffect is guaranteed to fire after
  // refs are set, so videoRef.current is the live DOM element here.
  //
  // WHY no document.createElement:
  // The previous implementation created an off-DOM element and stored it in
  // videoRef.current, which React then immediately overwrote with its own DOM
  // element when re-rendering <video ref={videoRef}>. The off-DOM element had
  // the src and listeners; the visible DOM element had neither — producing a
  // blank inline player while fullscreen (which used the off-DOM element's
  // source via requestFullscreen) still worked.
  useLayoutEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }

    // videoRef.current is the React-managed DOM element — guaranteed to be set
    // because useLayoutEffect fires after React's commit phase sets refs.
    const el = videoRef.current;
    if (!el) {
      return;
    }

    // When resolvedUri is empty the caller is waiting for a valid source (e.g.
    // waiting for the transcoded URL to arrive before loading). Reset the element
    // to an idle state without attaching any event listeners or src.
    if (!resolvedUri) {
      setState(buildInitialState());
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // best-effort
      }
      return;
    }

    initialPositionAppliedRef.current = false;

    // Reset state for the new URI.
    setState(buildInitialState());

    // ── Event handlers ───────────────────────────────────────────────────────

    const handleLoadedMetadata = () => {
      const duration = el.duration;

      // Detect UnsupportedCodecError: the container decoded metadata (so
      // duration is available) but the video track has zero pixel dimensions,
      // which means the browser cannot decode the video codec (e.g. H.265).
      const vw = el.videoWidth;
      const vh = el.videoHeight;
      if (vw === 0 && vh === 0 && duration > 0) {
        logger.warn?.('useWebVideoPlayer: zero-dimension video after loadedmetadata — likely unsupported codec', {
          resolvedUri,
          videoWidth: vw,
          videoHeight: vh,
          duration,
        });
        onUnsupportedCodecRef.current?.(el.currentTime);
        setState((prev) => ({ ...prev, error: 'unsupported-codec', duration }));
        return;
      }

      setState((prev) => ({
        ...prev,
        duration: Number.isFinite(duration) ? duration : 0,
        isBuffering: false,
        error: null,
      }));

      // Apply initial seek position before the first play.
      if (!initialPositionAppliedRef.current) {
        initialPositionAppliedRef.current = true;
        const pos = initialPositionRef.current;
        if (Number.isFinite(pos) && pos > 0) {
          try {
            el.currentTime = pos;
          } catch {
            // best-effort
          }
        }
      }

      // Apply configured playback speed.
      try {
        el.playbackRate = playbackSpeedRef.current;
      } catch {
        // best-effort
      }

      onReadyRef.current?.();

      // Auto-play if requested.
      if (autoPlayRef.current) {
        const playPromise = el.play();
        if (playPromise?.catch) {
          playPromise.catch((err: unknown) => {
            logger.debug?.('useWebVideoPlayer: autoplay rejected', err);
          });
        }
      }
    };

    const handleTimeUpdate = () => {
      const currentTime = el.currentTime;
      if (!Number.isFinite(currentTime)) {
        return;
      }
      const bufferedPercent = resolveBufferedPercent(el);
      setState((prev) => ({
        ...prev,
        currentTime,
        bufferedPercent: bufferedPercent ?? prev.bufferedPercent,
      }));
    };

    const handleProgress = () => {
      const bufferedPercent = resolveBufferedPercent(el);
      if (bufferedPercent == null) {
        return;
      }
      setState((prev) =>
        Math.abs((prev.bufferedPercent ?? 0) - bufferedPercent) < 0.5
          ? prev
          : { ...prev, bufferedPercent }
      );
    };

    const handleWaiting = () => {
      setState((prev) => ({ ...prev, isBuffering: true }));
    };

    const handleStalled = () => {
      setState((prev) => ({ ...prev, isStalled: true, isBuffering: true }));
    };

    const handlePlaying = () => {
      setState((prev) => ({
        ...prev,
        isPlaying: true,
        isBuffering: false,
        isStalled: false,
        error: null,
      }));
    };

    const handlePause = () => {
      setState((prev) => ({
        ...prev,
        isPlaying: false,
        isBuffering: false,
        isStalled: false,
      }));
    };

    const handleEnded = () => {
      setState((prev) => ({ ...prev, isPlaying: false, ended: true }));
      onEndedRef.current?.();
    };

    const handleError = () => {
      const mediaError = el.error;
      // MediaError.code 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED
      if (mediaError && (mediaError.code === 3 || mediaError.code === 4)) {
        logger.warn?.('useWebVideoPlayer: MediaError code indicates codec/format issue', {
          resolvedUri,
          code: mediaError.code,
          message: mediaError.message,
        });
        onUnsupportedCodecRef.current?.(el.currentTime);
        setState((prev) => ({ ...prev, error: 'unsupported-codec', isBuffering: false }));
        onErrorRef.current?.('unsupported-codec');
        return;
      }

      const errMsg = mediaError?.message ?? 'Playback failed';
      setState((prev) => ({
        ...prev,
        error: errMsg,
        isBuffering: false,
        isStalled: false,
      }));
      onErrorRef.current?.(errMsg);
    };

    // ── durationchange: fires when el.duration transitions from NaN → finite ─
    // On mobile Chrome, duration is sometimes NaN at loadedmetadata for
    // cross-origin videos. This event catches the late duration resolution.
    const handleDurationChange = () => {
      const dur = el.duration;
      if (Number.isFinite(dur) && dur > 0) {
        setState((prev) => (Math.abs(prev.duration - dur) < 0.01 ? prev : { ...prev, duration: dur }));
      }
    };

    // ── Attach listeners ─────────────────────────────────────────────────────

    el.addEventListener('loadedmetadata', handleLoadedMetadata);
    el.addEventListener('durationchange', handleDurationChange);
    el.addEventListener('timeupdate', handleTimeUpdate);
    el.addEventListener('progress', handleProgress);
    el.addEventListener('waiting', handleWaiting);
    el.addEventListener('stalled', handleStalled);
    el.addEventListener('playing', handlePlaying);
    el.addEventListener('pause', handlePause);
    el.addEventListener('ended', handleEnded);
    el.addEventListener('error', handleError);

    // ── Load the source ──────────────────────────────────────────────────────

    el.src = resolvedUri;
    el.load();

    // ── Cleanup: detach listeners and stop network activity ─────────────────
    // Do NOT null out videoRef.current — React owns the DOM element's lifetime.

    return () => {
      el.removeEventListener('loadedmetadata', handleLoadedMetadata);
      el.removeEventListener('durationchange', handleDurationChange);
      el.removeEventListener('timeupdate', handleTimeUpdate);
      el.removeEventListener('progress', handleProgress);
      el.removeEventListener('waiting', handleWaiting);
      el.removeEventListener('stalled', handleStalled);
      el.removeEventListener('playing', handlePlaying);
      el.removeEventListener('pause', handlePause);
      el.removeEventListener('ended', handleEnded);
      el.removeEventListener('error', handleError);

      // Detach the source so the browser stops network requests.
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        // best-effort
      }
    };
    // Intentionally only depends on resolvedUri — all other options are accessed
    // through refs so that the element is NOT re-wired when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedUri]);

  // ── Sync mute attribute in-place (no element recreation) ──────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.muted = isMuted;
  }, [isMuted]);

  // ── Sync playback speed in-place (no element recreation) ──────────────────
  useEffect(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    try {
      el.playbackRate = playbackSpeed;
    } catch {
      // best-effort
    }
  }, [playbackSpeed]);

  // ─── Imperative controls ───────────────────────────────────────────────────

  const play = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    const playPromise = el.play();
    if (playPromise?.catch) {
      playPromise.catch((err: unknown) => {
        logger.debug?.('useWebVideoPlayer: play() rejected', err);
      });
    }
  }, []);

  const pause = useCallback(() => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.pause();
  }, []);

  const seek = useCallback((seconds: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(seconds)) {
      return;
    }
    try {
      el.currentTime = seconds;
    } catch (err) {
      logger.debug?.('useWebVideoPlayer: seek failed', err);
    }
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    const el = videoRef.current;
    if (!el) {
      return;
    }
    el.muted = muted;
  }, []);

  const setPlaybackSpeed = useCallback((speed: number) => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(speed)) {
      return;
    }
    try {
      el.playbackRate = speed;
    } catch (err) {
      logger.debug?.('useWebVideoPlayer: setPlaybackSpeed failed', err);
    }
  }, []);

  return {
    state,
    videoRef,
    play,
    pause,
    seek,
    setMuted,
    setPlaybackSpeed,
  };
}
