import { useCallback, useEffect } from 'react';
import { useEvent } from 'expo';
import {
  useVideoPlayer,
  type VideoSource,
  type VideoPlayer as ExpoVideoPlayer,
  type VideoPlayerStatus,
} from 'expo-video';

/**
 * The playback state reported by the native expo-video player.
 * Maps directly to the underlying expo-video player properties.
 */
export interface NativePlayerState {
  /** Whether the player is currently playing. */
  isPlaying: boolean;
  /** Maps directly to expo-video VideoPlayerStatus. */
  status: VideoPlayerStatus;
  /** Current playback position in seconds. */
  currentTime: number;
  /** Total duration of the media in seconds. */
  duration: number;
  /** Position up to which the media has been buffered, in seconds. */
  bufferedPosition: number;
  /** Human-readable error string if playback failed, or null. */
  error: string | null;
}

/**
 * Options for configuring the native video player hook.
 */
export interface UseNativeVideoPlayerOptions {
  /** The URI of the video to play. */
  uri: string;
  /** Whether to start playback automatically once the player is ready. */
  autoPlay?: boolean;
  /** Position (in seconds) to seek to before the first play. */
  initialPosition?: number;
  /** Initial playback speed multiplier (default: 1). */
  playbackSpeed?: number;
  /** Whether the player should start muted. */
  isMuted?: boolean;
  /** Called when the player is ready to play (status transitions to 'readyToPlay'). */
  onReady?: () => void;
  /** Called when a playback error occurs, with the error string. */
  onError?: (error: string) => void;
  /** Called when the video reaches the end. */
  onEnded?: () => void;
}

/**
 * Encapsulates expo-video player creation, event subscription, and cleanup for
 * native (iOS / Android) platforms.
 *
 * Requirements: 4.1
 */
export function useNativeVideoPlayer(options: UseNativeVideoPlayerOptions): {
  state: NativePlayerState;
  player: ExpoVideoPlayer;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setMuted: (muted: boolean) => void;
  setPlaybackSpeed: (speed: number) => void;
} {
  const {
    uri,
    autoPlay = false,
    initialPosition,
    playbackSpeed = 1,
    isMuted = false,
    onReady,
    onError,
    onEnded,
  } = options;

  // Use null source when uri is empty so expo-video does not probe the URL.
  // On web, VideoPlayerLoaded passes uri='' to prevent this hook from creating
  // a player that makes HEAD requests to Firebase Storage video URLs.
  const source: VideoSource | null = uri ? { uri } : null;

  const player = useVideoPlayer(source as unknown as VideoSource, (p: ExpoVideoPlayer) => {
    p.loop = false;
    p.muted = isMuted;
    p.timeUpdateEventInterval = 0.1;
    p.preservesPitch = true;
    try {
      p.playbackRate = playbackSpeed;
    } catch {
      // Some builds/platforms do not support setting playbackRate during init.
    }
  });

  // ── Event subscriptions ──────────────────────────────────────────────────────

  const { isPlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });

  const timeUpdate = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    bufferedPosition: player.bufferedPosition ?? 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });

  const statusEvent = useEvent(player, 'statusChange', {
    status: player.status,
    oldStatus: undefined,
  });

  const currentStatus: VideoPlayerStatus = statusEvent?.status ?? player.status;
  const statusError = (statusEvent as { error?: { message?: string } | null } | null)?.error ?? null;

  // ── Lifecycle callbacks ──────────────────────────────────────────────────────

  useEffect(() => {
    if (currentStatus === 'readyToPlay') {
      // Apply initial seek position once.
      if (initialPosition != null && initialPosition > 0) {
        try {
          player.currentTime = initialPosition;
        } catch {
          // Seek may fail before the player is fully ready; that's acceptable.
        }
      }
      onReady?.();
      if (autoPlay) {
        try {
          player.play();
        } catch {
          // Autoplay may be blocked; caller can handle via onReady if needed.
        }
      }
    }

    if (currentStatus === 'error') {
      const errorMsg =
        (statusError as { message?: string } | null)?.message ??
        String(statusError) ??
        'Unknown playback error';
      onError?.(errorMsg);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStatus]);

  // Detect when the video has ended (playing → idle after reaching end).
  useEffect(() => {
    if (!isPlaying && currentStatus === 'idle') {
      const duration = player.duration;
      const currentTime = player.currentTime;
      // Only fire onEnded if we were near the end (within 1 second).
      if (
        duration != null &&
        duration > 0 &&
        currentTime != null &&
        currentTime >= duration - 1
      ) {
        onEnded?.();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, currentStatus]);

  // ── Playback speed ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!Number.isFinite(playbackSpeed)) {
      return;
    }
    try {
      player.preservesPitch = true;
      player.playbackRate = playbackSpeed;
    } catch {
      // Playback rate API varies across expo-video versions; failure is non-fatal.
    }
  }, [player, playbackSpeed]);

  // ── Mute sync ────────────────────────────────────────────────────────────────

  useEffect(() => {
    try {
      player.muted = isMuted;
    } catch {
      // Non-fatal.
    }
  }, [player, isMuted]);

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      try {
        player.release();
      } catch {
        // Ignore errors during cleanup.
      }
    };
  // player reference is stable for the lifetime of this hook instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Stable action callbacks ──────────────────────────────────────────────────

  const play = useCallback(() => {
    try {
      player.play();
    } catch {
      // Non-fatal.
    }
  }, [player]);

  const pause = useCallback(() => {
    try {
      player.pause();
    } catch {
      // Non-fatal.
    }
  }, [player]);

  const seek = useCallback(
    (seconds: number) => {
      if (!Number.isFinite(seconds)) {
        return;
      }
      try {
        player.currentTime = seconds;
      } catch {
        // Non-fatal.
      }
    },
    [player]
  );

  const setMuted = useCallback(
    (muted: boolean) => {
      try {
        player.muted = muted;
      } catch {
        // Non-fatal.
      }
    },
    [player]
  );

  const setPlaybackSpeed = useCallback(
    (speed: number) => {
      if (!Number.isFinite(speed)) {
        return;
      }
      try {
        player.preservesPitch = true;
        player.playbackRate = speed;
      } catch {
        // Non-fatal.
      }
    },
    [player]
  );

  // ── Derived state ────────────────────────────────────────────────────────────

  const errorString: string | null = statusError
    ? ((statusError as { message?: string } | null)?.message ?? String(statusError))
    : null;

  const state: NativePlayerState = {
    isPlaying,
    status: currentStatus,
    currentTime: timeUpdate.currentTime ?? player.currentTime ?? 0,
    duration: player.duration ?? 0,
    bufferedPosition: timeUpdate.bufferedPosition ?? player.bufferedPosition ?? 0,
    error: errorString,
  };

  return {
    state,
    player,
    play,
    pause,
    seek,
    setMuted,
    setPlaybackSpeed,
  };
}
