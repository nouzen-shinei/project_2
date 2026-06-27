import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { logger } from '@/lib/logger';
import {
  View,
  Text,
  StyleSheet,
  Animated,
  TouchableOpacity,
  Pressable,
  Platform,
  PanResponder,
  Image,
  GestureResponderEvent,
  AccessibilityActionEvent,
  LayoutChangeEvent,
  Modal,
  SafeAreaView,
  StatusBar,
  AppState,
  AppStateStatus,
  StyleProp,
  ViewStyle,
  ActivityIndicator,
} from 'react-native';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  X,
  Download,
  Gauge,
  Share2,
  Clapperboard,
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { useDownloadState } from '@/hooks/useDownloadState';
import { useEasedDownloadProgressPercent } from '@/hooks/useEasedDownloadProgressPercent';
import { useWebVideoPlayer } from '@/hooks/useWebVideoPlayer';
import { useVideoCodecFallback } from '@/hooks/useVideoCodecFallback';
import { canPlayCodec } from '@/utils/codecDetector';
import { isVideoTranscodeEnabled } from '@/lib/videoTranscodeConfig';
import { useTenant } from '@/hooks/useTenantContext';
import {
  resolveDownloadProgressLabel,
  resolveProgressPercentText,
} from '@/lib/uploadProgressDisplayEasing';
import { useEvent } from 'expo';
import {
  useVideoPlayer,
  VideoView,
  type VideoSource,
  type VideoPlayer as ExpoVideoPlayer,
  type VideoPlayerStatus,
} from 'expo-video';
import { useNativeVideoPlayer } from '../hooks/useNativeVideoPlayer';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { ShareModal } from './ShareModal';
import { chatCacheService } from '../services/chatCacheService';
import * as Haptics from 'expo-haptics';
import { DEFAULT_SEEK_STEP_SECONDS, useVideoSeekConfig } from '../hooks/useVideoSeekConfig';
import { useVideoPlaybackUxState } from '@/hooks/useVideoPlaybackUxState';
import { VideoBufferingOverlay } from './VideoBufferingOverlay';
import { useWebVideoState } from '@/hooks/useWebVideoSetup';
import { useVideoProgressBar } from '@/hooks/useVideoProgressBar';
import { useMediaSession } from '@/hooks/useMediaSession';

const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const MAX_THUMBNAIL_DIMENSION = 640;

type ThumbnailCacheRecord = {
  status: 'pending' | 'fulfilled' | 'rejected';
  promise: Promise<string | null>;
};

const webThumbnailCache = new Map<string, ThumbnailCacheRecord>();

const cleanupWebThumbnailRecord = (source: string, status: ThumbnailCacheRecord['status']) => {
  if (status !== 'fulfilled') {
    webThumbnailCache.delete(source);
  }
};

const captureFrameFromElement = (element: any): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }
  try {
    const width = element.videoWidth;
    const height = element.videoHeight;
    if (!width || !height) {
      return null;
    }

    const scale = Math.min(1, MAX_THUMBNAIL_DIMENSION / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(element, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch (error) {
    logger.debug?.('VideoPlayer: failed to capture frame from video element', error);
    return null;
  }
};

const resolveBufferedPercentFromElement = (element: HTMLVideoElement | null): number | null => {
  if (!element) {
    return null;
  }
  const duration = element.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  try {
    const buffered = element.buffered;
    if (!buffered || buffered.length === 0) {
      return null;
    }
    const end = buffered.end(buffered.length - 1);
    if (!Number.isFinite(end)) {
      return null;
    }
    return clamp((end / duration) * 100, 0, 100);
  } catch (error) {
    logger.debug?.('VideoPlayer: failed to resolve buffered percent', error);
    return null;
  }
};

const attemptWebThumbnail = (sourceUri: string, useCors: boolean): Promise<string | null> =>
  new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }

    const video = document.createElement('video');
    let resolved = false;

    const cleanup = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      resolve(result);
    };

    const handleError = () => cleanup(null);

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = useCors ? 'anonymous' : '';

    video.addEventListener('error', handleError, { once: true });
    video.addEventListener(
      'loadeddata',
      () => {
        const seekTo = Math.min(0.1, Number.isFinite(video.duration) ? video.duration : 0);
        const capture = () => {
          try {
            const frame = captureFrameFromElement(video);
            cleanup(frame);
          } catch (error) {
            logger.debug?.('VideoPlayer: failed to capture web thumbnail', error);
            cleanup(null);
          }
        };

        if (video.readyState >= 2) {
          capture();
        } else {
          video.currentTime = seekTo;
          video.addEventListener('seeked', capture, { once: true });
        }
      },
      { once: true }
    );

    try {
      video.src = sourceUri;
      video.load();
    } catch (error) {
      logger.debug?.('VideoPlayer: failed to start thumbnail load', error);
      cleanup(null);
    }
  });

const generateWebVideoThumbnail = async (sourceUri: string): Promise<string | null> => {
  if (typeof document === 'undefined') {
    return null;
  }

  const existing = webThumbnailCache.get(sourceUri);
  if (existing) {
    return existing.promise;
  }

  const record: ThumbnailCacheRecord = {
    status: 'pending',
    promise: Promise.resolve()
      .then(async () => {
        const withCors = await attemptWebThumbnail(sourceUri, true);
        if (withCors) {
          return withCors;
        }
        return await attemptWebThumbnail(sourceUri, false);
      })
      .then((result) => {
        record.status = 'fulfilled';
        return result;
      })
      .catch((error) => {
        record.status = 'rejected';
        logger.debug?.('VideoPlayer: unable to generate web thumbnail', { sourceUri, error });
        return null;
      })
      .finally(() => {
        cleanupWebThumbnailRecord(sourceUri, record.status);
      }),
  };

  webThumbnailCache.set(sourceUri, record);
  return record.promise;
};

const formatTime = (time: number) => {
  if (!time || Number.isNaN(time) || !Number.isFinite(time)) {
    return '0:00';
  }
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const formatSeekHint = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? seconds : SEEK_STEP_SECONDS;
  const rounded = Number.isInteger(safeSeconds)
    ? safeSeconds.toString()
    : safeSeconds.toFixed(1).replace(/\.0$/, '');
  const unit = Math.abs(safeSeconds) === 1 ? 'second' : 'seconds';
  return `Double tap left or right to seek ${rounded} ${unit}.`;
};

const clearWebSelection = () => {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return;
  }

  try {
    const selection = window.getSelection?.();
    if (!selection) {
      return;
    }
    if (typeof selection.removeAllRanges === 'function') {
      selection.removeAllRanges();
    }
    if (typeof (selection as any).empty === 'function') {
      (selection as any).empty();
    }
  } catch {
    // ignore
  }
};

const isKeyboardEventFromEditable = (event: any) => {
  const target = event?.target as any;
  if (!target) {
    return false;
  }

  const tag = (target.tagName || '').toString().toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    return true;
  }

  return Boolean(target.isContentEditable);
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

const SEEK_STEP_SECONDS = DEFAULT_SEEK_STEP_SECONDS;
const DOUBLE_TAP_WINDOW_MS = 260;
const SINGLE_TAP_DELAY_MS = 280;
const SEEK_SEQUENCE_WINDOW_MS = 650;
const SEEK_OVERLAY_HIDE_MS = 700;
const HAPTIC_MIN_INTERVAL_MS = 120;

type PauseHandler = () => void;

const videoPlaybackRegistry = new Map<string, PauseHandler>();
let playbackIdCounter = 0;

const createPlaybackId = () => {
  playbackIdCounter += 1;
  return `video-playback-${playbackIdCounter}`;
};

const registerPlaybackHandler = (id: string, pause: PauseHandler) => {
  videoPlaybackRegistry.set(id, pause);
  return () => {
    if (videoPlaybackRegistry.get(id) === pause) {
      videoPlaybackRegistry.delete(id);
    }
  };
};

const pauseOtherVideos = (activeId: string) => {
  videoPlaybackRegistry.forEach((pause, id) => {
    if (id !== activeId) {
      pause();
    }
  });
};

type SeekDirection = 'backward' | 'forward';

type SeekOverlayState = {
  visible: boolean;
  direction: SeekDirection;
  amountSeconds: number;
};

type SeekGestureConfig = {
  enabled: boolean;
  stepSeconds?: number;
  onSingleTap?: () => void;
  onSeekBySeconds: (deltaSeconds: number) => boolean;
};

const useSeekGesture = ({
  enabled,
  stepSeconds = SEEK_STEP_SECONDS,
  onSingleTap,
  onSeekBySeconds,
}: SeekGestureConfig) => {
  const overlayOpacity = useRef(new Animated.Value(0)).current;
  const overlayScale = useRef(new Animated.Value(0.92)).current;
  const overlayAnimationRef = useRef<Animated.CompositeAnimation | null>(null);
  const overlayHideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sequenceResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSingleTapRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapAtRef = useRef(0);
  const lastTapDirectionRef = useRef<SeekDirection | null>(null);
  const sequenceActiveRef = useRef(false);
  const accumulatedRef = useRef(0);
  const lastHapticAtRef = useRef(0);

  const [overlayState, setOverlayState] = useState<SeekOverlayState>({
    visible: false,
    direction: 'forward',
    amountSeconds: stepSeconds,
  });

  const clearPendingSingleTap = useCallback(() => {
    if (pendingSingleTapRef.current) {
      clearTimeout(pendingSingleTapRef.current);
      pendingSingleTapRef.current = null;
    }
  }, []);

  const clearSequenceReset = useCallback(() => {
    if (sequenceResetRef.current) {
      clearTimeout(sequenceResetRef.current);
      sequenceResetRef.current = null;
    }
  }, []);

  const clearOverlayHide = useCallback(() => {
    if (overlayHideRef.current) {
      clearTimeout(overlayHideRef.current);
      overlayHideRef.current = null;
    }
  }, []);

  const resetSequence = useCallback(() => {
    sequenceActiveRef.current = false;
    accumulatedRef.current = 0;
    clearSequenceReset();
  }, [clearSequenceReset]);

  const scheduleSequenceReset = useCallback(() => {
    clearSequenceReset();
    sequenceResetRef.current = setTimeout(() => {
      resetSequence();
    }, SEEK_SEQUENCE_WINDOW_MS);
  }, [clearSequenceReset, resetSequence]);

  const scheduleSingleTap = useCallback(() => {
    if (!onSingleTap) {
      return;
    }

    clearPendingSingleTap();
    pendingSingleTapRef.current = setTimeout(() => {
      pendingSingleTapRef.current = null;
      if (!sequenceActiveRef.current) {
        onSingleTap();
      }
    }, SINGLE_TAP_DELAY_MS);
  }, [clearPendingSingleTap, onSingleTap]);

  const triggerHaptic = useCallback(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const now = Date.now();
    if (now - lastHapticAtRef.current < HAPTIC_MIN_INTERVAL_MS) {
      return;
    }
    lastHapticAtRef.current = now;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }, []);

  const runOverlayAnimation = useCallback(
    (direction: SeekDirection, amountSeconds: number) => {
      setOverlayState({ visible: true, direction, amountSeconds });
      clearOverlayHide();

      overlayAnimationRef.current?.stop?.();
      overlayOpacity.setValue(0);
      overlayScale.setValue(0.92);

      const nativeDriver = Platform.OS !== 'web';
      overlayAnimationRef.current = Animated.parallel([
        Animated.timing(overlayOpacity, {
          toValue: 1,
          duration: 120,
          useNativeDriver: nativeDriver,
        }),
        Animated.spring(overlayScale, {
          toValue: 1,
          speed: 18,
          bounciness: 6,
          useNativeDriver: nativeDriver,
        }),
      ]);

      overlayAnimationRef.current.start(() => {
        clearOverlayHide();
        overlayHideRef.current = setTimeout(() => {
          Animated.timing(overlayOpacity, {
            toValue: 0,
            duration: 180,
            useNativeDriver: nativeDriver,
          }).start(() => {
            setOverlayState((prev) => ({ ...prev, visible: false }));
          });
        }, SEEK_OVERLAY_HIDE_MS);
      });
    },
    [clearOverlayHide, overlayOpacity, overlayScale]
  );

  const applySeek = useCallback(
    (direction: SeekDirection, amountSeconds: number) => {
      const delta = direction === 'forward' ? stepSeconds : -stepSeconds;
      const applied = onSeekBySeconds(delta);
      if (!applied) {
        return false;
      }
      clearWebSelection();
      runOverlayAnimation(direction, amountSeconds);
      triggerHaptic();
      return true;
    },
    [onSeekBySeconds, runOverlayAnimation, stepSeconds, triggerHaptic]
  );

  const handleSeekTap = useCallback(
    (direction: SeekDirection) => {
      if (!enabled) {
        scheduleSingleTap();
        return;
      }

      const now = Date.now();
      const lastTapAt = lastTapAtRef.current;
      const lastDirection = lastTapDirectionRef.current;
      const sameSide = lastDirection === direction;
      const withinDouble = now - lastTapAt <= DOUBLE_TAP_WINDOW_MS;

      if (sequenceActiveRef.current && !sameSide) {
        resetSequence();
      }

      if (sequenceActiveRef.current) {
        accumulatedRef.current += stepSeconds;
        lastTapAtRef.current = now;
        lastTapDirectionRef.current = direction;
        if (applySeek(direction, accumulatedRef.current)) {
          scheduleSequenceReset();
        }
        return;
      }

      if (withinDouble && sameSide) {
        clearPendingSingleTap();
        sequenceActiveRef.current = true;
        accumulatedRef.current = stepSeconds;
        lastTapAtRef.current = now;
        lastTapDirectionRef.current = direction;
        if (applySeek(direction, accumulatedRef.current)) {
          scheduleSequenceReset();
        }
        return;
      }

      lastTapAtRef.current = now;
      lastTapDirectionRef.current = direction;
      scheduleSingleTap();
    },
    [
      enabled,
      onSingleTap,
      applySeek,
      clearPendingSingleTap,
      resetSequence,
      scheduleSequenceReset,
      scheduleSingleTap,
      stepSeconds,
    ]
  );

  const handleKeyboardSeek = useCallback(
    (direction: SeekDirection) => {
      if (!enabled) {
        return;
      }

      const now = Date.now();
      const lastDirection = lastTapDirectionRef.current;
      const withinWindow = now - lastTapAtRef.current <= SEEK_SEQUENCE_WINDOW_MS;
      const sameSide = lastDirection === direction;

      if (!sequenceActiveRef.current || !withinWindow || !sameSide) {
        accumulatedRef.current = stepSeconds;
      } else {
        accumulatedRef.current += stepSeconds;
      }

      sequenceActiveRef.current = true;
      lastTapAtRef.current = now;
      lastTapDirectionRef.current = direction;

      if (applySeek(direction, accumulatedRef.current)) {
        scheduleSequenceReset();
      }
    },
    [applySeek, enabled, scheduleSequenceReset, stepSeconds]
  );

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const { actionName } = event.nativeEvent;
      if (actionName === 'increment') {
        handleKeyboardSeek('forward');
      } else if (actionName === 'decrement') {
        handleKeyboardSeek('backward');
      }
    },
    [handleKeyboardSeek]
  );

  const overlayAnimatedStyle = useMemo(
    () => ({
      opacity: overlayOpacity,
      transform: [{ scale: overlayScale }],
    }),
    [overlayOpacity, overlayScale]
  );

  useEffect(() => () => {
    clearPendingSingleTap();
    clearSequenceReset();
    clearOverlayHide();
    overlayAnimationRef.current?.stop?.();
  }, [clearOverlayHide, clearPendingSingleTap, clearSequenceReset]);

  useEffect(() => {
    if (enabled) {
      return;
    }
    clearPendingSingleTap();
    resetSequence();
  }, [clearPendingSingleTap, enabled, resetSequence]);

  return {
    overlayState,
    overlayAnimatedStyle,
    handleSeekTap,
    handleKeyboardSeek,
    handleAccessibilityAction,
  };
};

type SeekOverlayProps = {
  state: SeekOverlayState;
  animatedStyle: { opacity: Animated.Value; transform: { scale: Animated.Value }[] };
  variant?: 'inline' | 'fullscreen';
};

function SeekOverlay({ state, animatedStyle, variant = 'inline' }: SeekOverlayProps) {
  if (!state.visible) {
    return null;
  }

  const isBackward = state.direction === 'backward';
  const displaySeconds = Math.abs(state.amountSeconds);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.seekOverlay,
        variant === 'fullscreen' ? styles.seekOverlayFullscreen : null,
        isBackward ? styles.seekOverlayLeft : styles.seekOverlayRight,
        animatedStyle,
      ]}
    >
      <Text style={styles.seekOverlayArrow}>{isBackward ? '<<' : '>>'}</Text>
      <Text style={styles.seekOverlayText}>{`${displaySeconds}s`}</Text>
    </Animated.View>
  );
}

interface VideoPlayerProps {
  /** The primary video URL to play. Required. On web, used as the playback source unless `transcodedUri` is provided. */
  uri: string;
  /** The display name of the file, used for download and share labels. Defaults to `"video.mp4"`. */
  fileName?: string;
  /** Callback invoked when the user presses the download button. */
  onDownload?: () => void;
  /** Additional styles applied to the outermost container view. */
  style?: StyleProp<ViewStyle>;
  /** When `true`, playback begins immediately on mount without requiring a user tap. */
  autoPlay?: boolean;
  /** When `true`, the control bar is visible on mount. Defaults to `true`. */
  showControlsProp?: boolean;
  /** Maximum height in logical pixels that the video container may occupy. Defaults to `300`. */
  maxHeight?: number;
  /** Number of seconds to seek on a double-tap or keyboard shortcut. Falls back to the global seek config when omitted. */
  seekStepSeconds?: number;
  /** Callback invoked when the user opens the share sheet for this video. */
  onShare?: () => void;
  /** The canonical URL surfaced in the share sheet. Falls back to `uri` when omitted. */
  shareUrl?: string;
  /** Pre-computed thumbnail image URL shown as a poster before playback starts. */
  thumbnailUrl?: string;
  /** Selects between the full-featured control bar (`"full"`) and the compact variant (`"minimal"`). Defaults to `"full"`. */
  controlVariant?: 'full' | 'minimal';
  /** When `true`, the download button is replaced by a progress indicator. */
  isDownloading?: boolean;
  /** Download progress value in the range `[0, 1]` used by the progress indicator. */
  downloadProgress?: number;
  /** Stable key used to look up download state from the global download registry. Falls back to `shareUrl` then `uri`. */
  downloadKey?: string;
  /** The H.264 URL produced by the server transcoder. When non-empty, used as the primary playback source on web instead of `uri`. */
  transcodedUri?: string;
}

type VideoSourceCacheEntry = {
  resolvedUri: string | null;
  duration: number | null;
  previewUri: string | null;
  lastPosition: number;
  loadedOnce: boolean;
  lastKnownTime: number;
  lastKnownWasPlaying: boolean;
  updatedAt: number;
};

const videoSourceCache = new Map<string, VideoSourceCacheEntry>();

const getCachedVideoEntry = (key: string): VideoSourceCacheEntry | null => {
  return videoSourceCache.get(key) ?? null;
};

const patchVideoCacheEntry = (key: string, patch: Partial<VideoSourceCacheEntry>) => {
  const previous = videoSourceCache.get(key) ?? {
    resolvedUri: null,
    duration: null,
    previewUri: null,
    lastPosition: 0,
    loadedOnce: false,
    lastKnownTime: 0,
    lastKnownWasPlaying: false,
    updatedAt: Date.now(),
  };

  const next: VideoSourceCacheEntry = {
    resolvedUri: patch.resolvedUri ?? previous.resolvedUri,
    duration: patch.duration ?? previous.duration,
    previewUri: patch.previewUri ?? previous.previewUri,
    lastPosition: patch.lastPosition ?? previous.lastPosition,
    loadedOnce: patch.loadedOnce ?? previous.loadedOnce,
    lastKnownTime: patch.lastKnownTime ?? previous.lastKnownTime,
    lastKnownWasPlaying: patch.lastKnownWasPlaying ?? previous.lastKnownWasPlaying,
    updatedAt: Date.now(),
  };

  videoSourceCache.set(key, next);
  return next;
};

interface VideoPlayerLoadedProps {
  uri: string;
  fileName: string;
  onDownload?: () => void;
  autoPlay: boolean;
  initialWasPlaying: boolean;
  showControlsProp: boolean;
  maxHeight: number;
  seekStepSeconds?: number;
  onSharePress: (event?: GestureResponderEvent) => void;
  playRequestId: number;
  onResolvedUriChange?: (uri: string | null) => void;
  onDurationChange?: (duration: number | null) => void;
  onPreviewAvailable?: (uri: string) => void;
  posterUri?: string | null;
  controlVariant: 'full' | 'minimal';
  cacheKey: string;
  initialPlaybackPosition: number;
  initialResolvedUri?: string | null;
  isDownloading?: boolean;
  downloadProgress?: number;
  /** The H.264 URL produced by the server transcoder. Accepted but ignored on native; native always uses `uri`. */
  transcodedUri?: string;
}

type FullscreenSnapshot = {
  startTime: number;
  isMuted: boolean;
  playbackSpeed: number;
  wasPlaying: boolean;
};

type NativeFullscreenConfig = FullscreenSnapshot & {
  sourceUri: string;
  /** Poster image URI shown immediately while the fullscreen player loads. */
  posterUri?: string;
};

type WebFullscreenConfig = FullscreenSnapshot & {
  sourceUri: string;
  /** Poster image URI shown immediately while the fullscreen player loads. */
  posterUri?: string;
};

type FullscreenReturnState = {
  currentTime: number;
  isMuted: boolean;
  playbackSpeed: number;
  wasPlaying: boolean;
};

interface FullscreenVideoModalProps {
  config: NativeFullscreenConfig;
  onDismiss: (state: FullscreenReturnState) => void;
  onSharePress: (event?: GestureResponderEvent) => void;
  onDownload?: () => void;
  seekStepSeconds?: number;
  isDownloading?: boolean;
  downloadProgress?: number;
  /**
   * When provided, this player is used directly in the fullscreen VideoView instead
   * of creating a new player from `config.sourceUri`. The player is already loaded and
   * possibly playing — no rebuffering, no reload, instant transition.
   * expo-video supports multiple VideoViews sharing one player instance.
   */
  sharedPlayer?: ExpoVideoPlayer;
}

interface WebFullscreenModalProps {
  config: WebFullscreenConfig;
  onDismiss: (state: FullscreenReturnState) => void;
  onSharePress: (event?: GestureResponderEvent) => void;
  onDownload?: () => void;
  seekStepSeconds?: number;
  isDownloading?: boolean;
  downloadProgress?: number;
}

function usePrefetchShadowVideo(uri: string, enabled: boolean): void {
  const shadowRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }

    if (!enabled) {
      // Clean up shadow element if it exists
      const shadow = shadowRef.current;
      if (shadow) {
        try {
          shadow.src = '';
          shadow.load();
          shadow.remove();
        } catch {
          // ignore
        }
        shadowRef.current = null;
      }
      return;
    }

    // Skip for data: and blob: URIs
    if (!uri || uri.startsWith('data:') || uri.startsWith('blob:')) {
      return;
    }

    // Avoid creating duplicate shadow elements for the same URI
    const existingShadow = shadowRef.current;
    if (existingShadow && existingShadow.dataset?.prefetchUri === uri) {
      return;
    }

    // Clean up any previous shadow element
    if (existingShadow) {
      try {
        existingShadow.src = '';
        existingShadow.load();
        existingShadow.remove();
      } catch {
        // ignore
      }
      shadowRef.current = null;
    }

    try {
      const shadow = document.createElement('video');
      shadow.muted = true;
      shadow.preload = 'metadata';
      shadow.playsInline = true;
      shadow.style.display = 'none';
      shadow.style.position = 'absolute';
      shadow.style.width = '0';
      shadow.style.height = '0';
      shadow.style.pointerEvents = 'none';
      // Store URI for deduplication
      shadow.dataset.prefetchUri = uri;
      shadow.src = uri;
      document.body.appendChild(shadow);
      shadowRef.current = shadow;
    } catch {
      // ignore - prefetch is best-effort
    }

    return () => {
      // Cleanup handled by the next enabled=false run or unmount
    };
  }, [enabled, uri]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const shadow = shadowRef.current;
      if (shadow) {
        try {
          shadow.src = '';
          shadow.load();
          shadow.remove();
        } catch {
          // ignore
        }
        shadowRef.current = null;
      }
    };
  }, []);
}

function VideoPlayer({
  uri,
  fileName = 'video.mp4',
  onDownload,
  style,
  autoPlay = false,
  showControlsProp = true,
  maxHeight = 300,
  seekStepSeconds,
  onShare,
  shareUrl,
  thumbnailUrl,
  controlVariant = 'full',
  isDownloading,
  downloadProgress,
  downloadKey,
  transcodedUri,
}: VideoPlayerProps) {
  const { theme } = useTheme();
  const { seekStepSeconds: globalSeekStepSeconds } = useVideoSeekConfig();
  const isWeb = Platform.OS === 'web';
  const isMinimalControls = controlVariant === 'minimal';
  const effectiveSeekStepSeconds = seekStepSeconds ?? globalSeekStepSeconds ?? SEEK_STEP_SECONDS;
  const downloadState = useDownloadState(downloadKey || shareUrl || uri);
  const effectiveIsDownloading = typeof isDownloading === 'boolean'
    ? isDownloading
    : downloadState.isDownloading;
  const effectiveProgress = typeof downloadProgress === 'number'
    ? downloadProgress
    : downloadState.progress;
  const forceImmediateLoad = isMinimalControls;
  const cacheKey = useMemo(() => `${uri}::${fileName}`, [uri, fileName]);
  const cachedEntry = useMemo(() => getCachedVideoEntry(cacheKey), [cacheKey]);
  const cachedResolvedUri = cachedEntry?.resolvedUri ?? null;
  const cachedDuration = cachedEntry?.duration ?? null;
  const cachedPreview = cachedEntry?.previewUri ?? null;
  const cachedInitialPosition = Math.max(cachedEntry?.lastKnownTime ?? 0, cachedEntry?.lastPosition ?? 0);
  const cachedWasPlaying = cachedEntry?.lastKnownWasPlaying ?? false;

  const [shouldLoadVideo, setShouldLoadVideo] = useState(() => {
    if (autoPlay || !isWeb || forceImmediateLoad) {
      return true;
    }
    if (cachedEntry?.loadedOnce) {
      return true;
    }
    return Boolean(cachedResolvedUri);
  });
  const [playRequestId, setPlayRequestId] = useState(() => (autoPlay || cachedWasPlaying ? 1 : 0));
  const [showShareModal, setShowShareModal] = useState(false);
  const [resolvedVideoUri, setResolvedVideoUri] = useState<string | null>(() => cachedResolvedUri);
  const [displayDuration, setDisplayDuration] = useState<number | null>(() => cachedDuration);
  const [previewUri, setPreviewUri] = useState<string | null>(() => {
    if (thumbnailUrl) {
      return thumbnailUrl;
    }
    return cachedPreview ?? null;
  });
  const attemptedPreviewSources = useRef<Set<string>>(new Set());
  const hydratedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (hydratedKeyRef.current === cacheKey) {
      if (thumbnailUrl) {
        setPreviewUri((prev) => (prev === thumbnailUrl ? prev : thumbnailUrl));
      }
      if ((forceImmediateLoad || autoPlay || !isWeb) && !shouldLoadVideo) {
        setShouldLoadVideo(true);
      }
      return;
    }

    hydratedKeyRef.current = cacheKey;
    attemptedPreviewSources.current.clear();

    const cached = cachedEntry;
    if (cached) {
      setResolvedVideoUri(cached.resolvedUri ?? null);
      setDisplayDuration(cached.duration ?? null);
      setPreviewUri(thumbnailUrl || cached.previewUri || null);
      if (forceImmediateLoad || autoPlay || !isWeb || cached.loadedOnce || cached.lastKnownWasPlaying) {
        setShouldLoadVideo((prev) => (prev ? prev : true));
      } else {
        setShouldLoadVideo((prev) => (prev ? false : prev));
      }
      setPlayRequestId(autoPlay || cached.lastKnownWasPlaying ? 1 : 0);
      return;
    }

    setResolvedVideoUri(null);
    setDisplayDuration(null);
    setShowShareModal(false);
    setPreviewUri(thumbnailUrl || null);

    if (autoPlay || forceImmediateLoad || !isWeb) {
      setShouldLoadVideo(true);
      setPlayRequestId(autoPlay || cachedWasPlaying ? 1 : 0);
    } else {
      setShouldLoadVideo(false);
      setPlayRequestId(0);
    }
  }, [autoPlay, cacheKey, cachedEntry, forceImmediateLoad, isWeb, shouldLoadVideo, thumbnailUrl]);

  useEffect(() => {
    if (!previewUri) {
      return;
    }
    patchVideoCacheEntry(cacheKey, { previewUri });
  }, [cacheKey, previewUri]);

  useEffect(() => {
    if (!resolvedVideoUri) {
      return;
    }
    patchVideoCacheEntry(cacheKey, { resolvedUri: resolvedVideoUri });
  }, [cacheKey, resolvedVideoUri]);

  useEffect(() => {
    if (typeof displayDuration !== 'number' || displayDuration <= 0) {
      return;
    }
    patchVideoCacheEntry(cacheKey, { duration: displayDuration });
  }, [cacheKey, displayDuration]);

  const effectiveInitialResolvedUri = resolvedVideoUri ?? cachedResolvedUri ?? null;

  const handlePlayRequest = useCallback(() => {
    setShouldLoadVideo(true);
    setPlayRequestId((id) => id + 1);
  }, []);

  const handlePreviewAvailable = useCallback((nextUri: string) => {
    setPreviewUri((existing) => existing || nextUri);
  }, []);

  const closeShareModal = useCallback(() => {
    setShowShareModal(false);
  }, []);

  const handleSharePress = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation?.();
      if (onShare) {
        try {
          onShare();
        } catch (error) {
          logger.debug('VideoPlayer: onShare handler error', error);
        }
      }
      setShowShareModal(true);
    },
    [onShare]
  );

  const handlePlaceholderSharePress = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation?.();
      handleSharePress(event);
    },
    [handleSharePress]
  );

  const handlePlaceholderPlayPress = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation?.();
      handlePlayRequest();
    },
    [handlePlayRequest]
  );

  const formattedDuration = displayDuration && displayDuration > 0 ? formatTime(displayDuration) : null;
  const shareButtonA11yLabel = 'Share video';
  const placeholderVideoContainerStyle = useMemo(
    () => [styles.videoContainer, { height: maxHeight }],
    [styles, maxHeight]
  );

  // On H.265-unsupported browsers: only shadow-prefetch when the transcoded URL is
  // already resolved. When transcodedUri is absent, the original H.265 may have been
  // deleted from Firebase Storage after transcoding — prefetching it causes a 403.
  // Pass null to disable the shadow element until the H.264 URL arrives via chatCacheService.
  const h265UnsupportedForPrefetch = Platform.OS === 'web' && !canPlayCodec('h265');
  const trimmedTranscodedForPrefetch =
    typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
      ? transcodedUri.trim()
      : null;
  // Shadow-prefetch ONLY when the transcoded URL is already resolved.
  // Without it we cannot distinguish a deleted original (transcoded → original removed,
  // returns 403) from a live original (never transcoded, returns 200). Skipping the
  // shadow element for untranscoded videos costs a minor UX optimisation (no metadata
  // preload while the placeholder is visible) but eliminates all 403 console errors
  // from the shadow element on both H.265-capable and H.265-incapable browsers.
  const effectivePrefetchUri: string | null = trimmedTranscodedForPrefetch;

  usePrefetchShadowVideo(
    effectivePrefetchUri ?? '',
    Platform.OS === 'web' &&
      !shouldLoadVideo &&
      effectivePrefetchUri !== null &&
      !effectivePrefetchUri.startsWith('data:') &&
      !effectivePrefetchUri.startsWith('blob:')
  );

  // When transcodedUri first becomes available (chatCacheService resolved it),
  // clear the original URI from the attempted-preview set so the thumbnail effect
  // can retry with the H.264 URL. Without this, the original attempt's cache entry
  // would block the retry.
  const prevTranscodedUriRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const trimmed =
      typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
        ? transcodedUri.trim()
        : undefined;
    if (trimmed && !prevTranscodedUriRef.current) {
      // transcodedUri just arrived — clear the original URI so thumbnail retries
      attemptedPreviewSources.current.delete(uri);
      attemptedPreviewSources.current.delete(resolvedVideoUri ?? '');
      // Also clear the current previewUri if it was generated from a failed attempt
      // (a null-result thumbnail is not stored, so this is mainly a safety measure)
    }
    prevTranscodedUriRef.current = trimmed;
  }, [transcodedUri, uri, resolvedVideoUri]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    if (previewUri) {
      return;
    }

    if (shouldLoadVideo || autoPlay) {
      return;
    }

    // For transcoded videos, prefer the H.264 URL for thumbnail generation.
    // Android Chrome can't load H.265 for canvas capture, and the original file
    // is deleted from Firebase Storage after transcoding (returns 403).
    const effectiveTranscodedUriForThumb =
      typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
        ? transcodedUri.trim()
        : null;

    // Skip thumbnail generation until the transcoded H.264 URL is available on
    // ALL browsers — not just H.265-unsupported ones.
    //
    // On H.265-unsupported browsers: can't decode H.265 for canvas capture.
    // On H.265-capable browsers (e.g. desktop Chrome on macOS 13+): the original
    // may have been deleted from Firebase Storage after transcoding, so loading
    // it causes a 403 HEAD request.
    //
    // Videos that have a server thumbnail (thumbnailUrl prop) bypass this path
    // entirely — previewUri is already set and the guard above returns early.
    // Non-transcoded H.264 videos (no transcodedUri ever) will get their thumbnail
    // via the live frame capture (currentTime >= 0.5 s useEffect) after first play.
    if (!effectiveTranscodedUriForThumb) {
      return;
    }

    const candidate = effectiveTranscodedUriForThumb;
    if (!candidate || attemptedPreviewSources.current.has(candidate)) {
      return;
    }

    attemptedPreviewSources.current.add(candidate);
    let cancelled = false;

    generateWebVideoThumbnail(candidate)
      .then((generated) => {
        if (!cancelled && generated) {
          setPreviewUri(generated);
        }
      })
      .catch((error) => {
        logger.debug?.('VideoPlayer: web thumbnail generation failed', { candidate, error });
      });

    return () => {
      cancelled = true;
    };
    // transcodedUri added: when chatCacheService resolves the H.264 URL, this effect
    // re-runs and generates the thumbnail from the H.264 source (which is always accessible).
  }, [autoPlay, previewUri, resolvedVideoUri, shouldLoadVideo, transcodedUri, uri]);

  const renderPlaceholder = () => {
    const showPreviewImage = !!previewUri;
    const showPreviewBadge = !showPreviewImage;

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePlayRequest}
        style={placeholderVideoContainerStyle}
      >
        {showPreviewImage ? (
          <Image source={{ uri: previewUri as string }} style={styles.thumbnailImage} resizeMode="cover" />
        ) : (
          <View style={styles.thumbnailFallback} />
        )}

        <View style={[styles.placeholderOverlay, isMinimalControls ? styles.placeholderOverlayMinimal : null]}>
          {!isMinimalControls ? (
            <>
              <View style={styles.placeholderTopRow}>
                <View style={styles.placeholderTopLeft}>
                  {showPreviewBadge ? (
                    <View style={styles.placeholderBadge}>
                      <Clapperboard size={16} color="white" />
                      <Text style={styles.placeholderBadgeText}>Preview unavailable</Text>
                    </View>
                  ) : null}
                </View>

                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={handlePlaceholderSharePress}
                  accessibilityRole="button"
                  accessibilityLabel={shareButtonA11yLabel}
                >
                  <Share2 size={20} color="white" />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.controlButton, styles.placeholderPlayButton]}
                onPress={handlePlaceholderPlayPress}
              >
                <Play size={36} color="white" />
              </TouchableOpacity>

              <Text style={styles.placeholderHint}>Tap to play</Text>
            </>
          ) : (
            <TouchableOpacity
              style={[styles.controlButton, styles.placeholderPlayButtonMinimal]}
              onPress={handlePlaceholderPlayPress}
            >
              <Play size={36} color="white" />
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const videoSurface = shouldLoadVideo ? (
    <VideoPlayerLoaded
      uri={uri}
      fileName={fileName}
      onDownload={onDownload}
      autoPlay={autoPlay}
      showControlsProp={showControlsProp}
      maxHeight={maxHeight}
      seekStepSeconds={effectiveSeekStepSeconds}
      onSharePress={handleSharePress}
      playRequestId={playRequestId}
      onResolvedUriChange={setResolvedVideoUri}
      onDurationChange={setDisplayDuration}
      onPreviewAvailable={handlePreviewAvailable}
      posterUri={previewUri}
      controlVariant={controlVariant}
      cacheKey={cacheKey}
      initialPlaybackPosition={cachedInitialPosition}
      initialResolvedUri={effectiveInitialResolvedUri}
      initialWasPlaying={cachedWasPlaying}
      isDownloading={effectiveIsDownloading}
      downloadProgress={effectiveProgress}
      transcodedUri={transcodedUri}
    />
  ) : (
    renderPlaceholder()
  );

  return (
    <View style={[styles.container, style]}>
      {videoSurface}
      {controlVariant === 'full' ? (
        <View style={styles.videoInfo}>
          <Text style={[styles.fileName, { color: theme.text }]} numberOfLines={1}>
            {fileName}
          </Text>
          {formattedDuration ? (
            <Text style={[styles.videoDuration, { color: theme.textSecondary }]}>Duration: {formattedDuration}</Text>
          ) : null}
        </View>
      ) : null}

      <ShareModal
        visible={showShareModal}
        onClose={closeShareModal}
        fileUrl={shareUrl || resolvedVideoUri || uri}
        fileName={fileName}
        onDownload={onDownload}
      />
    </View>
  );
}

const areVideoPlayerPropsEqual = (prev: VideoPlayerProps, next: VideoPlayerProps) => {
  if (prev.uri !== next.uri) return false;
  if ((prev.fileName ?? '') !== (next.fileName ?? '')) return false;
  if ((prev.shareUrl ?? '') !== (next.shareUrl ?? '')) return false;
  if ((prev.thumbnailUrl ?? '') !== (next.thumbnailUrl ?? '')) return false;
  if ((prev.controlVariant ?? 'full') !== (next.controlVariant ?? 'full')) return false;
  if ((prev.maxHeight ?? 0) !== (next.maxHeight ?? 0)) return false;
  if ((prev.seekStepSeconds ?? 0) !== (next.seekStepSeconds ?? 0)) return false;
  if ((prev.autoPlay ?? false) !== (next.autoPlay ?? false)) return false;
  if ((prev.showControlsProp ?? true) !== (next.showControlsProp ?? true)) return false;
  if ((prev.isDownloading ?? false) !== (next.isDownloading ?? false)) return false;
  if ((prev.downloadProgress ?? 0) !== (next.downloadProgress ?? 0)) return false;
  if ((prev.downloadKey ?? '') !== (next.downloadKey ?? '')) return false;
  // transcodedUri changes when chatCacheService resolves the H.264 URL asynchronously.
  // Without this check, VideoPlayer never re-renders when the URL arrives, preventing
  // thumbnail updates and leaving VideoPlayerLoaded loading the deleted original.
  if ((prev.transcodedUri ?? '') !== (next.transcodedUri ?? '')) return false;
  return true;
};

export default React.memo(VideoPlayer, areVideoPlayerPropsEqual);

// ─── FullControls Props ──────────────────────────────────────────────────────

interface FullControlsProps {
  isPlaying: boolean;
  isMuted: boolean;
  isDownloading: boolean;
  isDraggingProgress: boolean;
  isWebFullscreenActive: boolean;
  disableSpeedControl: boolean;
  formattedProgressLabel: string;
  progressPercentage: number;
  bufferedPercentage: number;
  playbackSpeedLabel: string;
  normalizedProgress: number;
  downloadButtonA11yLabel: string;
  shareButtonA11yLabel: string;
  overlayAnimatedStyle: { opacity: Animated.Value; transform: { scale: Animated.Value }[] };
  overlayPointerEvents: 'box-none' | 'none';
  /** Optional style override for the controls overlay — used for web fullscreen. */
  overlayStyle?: object;
  progressBarRef: React.RefObject<View | null>;
  progressPanResponder: ReturnType<typeof PanResponder.create>;
  handleProgressBarLayout: (event: LayoutChangeEvent) => void;
  onTogglePlayPause: () => void;
  onToggleMute: () => void;
  onDownload?: () => void;
  onSharePress: (event?: GestureResponderEvent) => void;
  onFullscreenPress: () => void;
  onCyclePlaybackSpeed: () => void;
  /** When provided, renders an X close button in the top-left (web fullscreen mode). */
  onCloseFullscreen?: () => void;
}

/**
 * Full control bar: play/pause, scrubber, time, speed, mute, fullscreen, download, share.
 * Contains no conditional branch that selects between control variants.
 */
function FullControls({
  isPlaying,
  isMuted,
  isDownloading,
  isDraggingProgress,
  isWebFullscreenActive,
  disableSpeedControl,
  formattedProgressLabel,
  progressPercentage,
  bufferedPercentage,
  playbackSpeedLabel,
  normalizedProgress,
  downloadButtonA11yLabel,
  shareButtonA11yLabel,
  overlayAnimatedStyle,
  overlayPointerEvents,
  overlayStyle,
  progressBarRef,
  progressPanResponder,
  handleProgressBarLayout,
  onTogglePlayPause,
  onToggleMute,
  onDownload,
  onSharePress,
  onFullscreenPress,
  onCyclePlaybackSpeed,
  onCloseFullscreen,
}: FullControlsProps) {
  return (
    <Animated.View style={[styles.controlsOverlay, overlayStyle, overlayAnimatedStyle]} pointerEvents={overlayPointerEvents}>
      <View
        style={[styles.topControls, onCloseFullscreen ? { justifyContent: 'space-between' } : null]}
        pointerEvents="box-none"
      >
        {onCloseFullscreen ? (
          <TouchableOpacity
            style={styles.controlButton}
            onPress={onCloseFullscreen}
            accessibilityRole="button"
            accessibilityLabel="Exit fullscreen"
          >
            <X size={20} color="white" />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.controlButton}
          onPress={onSharePress}
          accessibilityRole="button"
          accessibilityLabel={shareButtonA11yLabel}
        >
          <Share2 size={20} color="white" />
        </TouchableOpacity>
      </View>

      <View style={styles.mainControls} pointerEvents="box-none">
        <TouchableOpacity style={[styles.controlButton, styles.playButton]} onPress={onTogglePlayPause}>
          {isPlaying ? <Pause size={32} color="white" /> : <Play size={32} color="white" />}
        </TouchableOpacity>
      </View>

      <View style={styles.bottomControls} pointerEvents="box-none">
        <View style={styles.progressRow} pointerEvents="box-none">
          <Text style={styles.timeText}>{formattedProgressLabel}</Text>

          <View style={styles.progressContainer}>
            <View
              ref={progressBarRef}
              collapsable={false}
              style={styles.progressBarTouchable}
              onLayout={handleProgressBarLayout}
              {...progressPanResponder.panHandlers}
            >
              <View style={styles.progressBar}>
                <View style={[styles.progressBuffered, { width: `${bufferedPercentage}%` }]} />
                <View style={[styles.progressFill, { width: `${progressPercentage}%` }]} />
                <View
                  style={[
                    styles.progressThumb,
                    {
                      left: `${progressPercentage}%`,
                      transform: [{ scale: isDraggingProgress ? 1.2 : 1 }],
                    },
                  ]}
                />
              </View>
            </View>
          </View>
        </View>

        <View style={styles.actionsRow} pointerEvents="box-none">
          <View style={styles.actionsLeft} pointerEvents="box-none">
            <TouchableOpacity style={styles.controlButton} onPress={onToggleMute}>
              {isMuted ? <VolumeX size={20} color="white" /> : <Volume2 size={20} color="white" />}
            </TouchableOpacity>

            {onDownload ? (
              <TouchableOpacity
                style={[styles.controlButton, isDownloading ? styles.controlButtonDisabled : null]}
                onPress={onDownload}
                disabled={isDownloading}
                accessibilityRole="button"
                accessibilityLabel={downloadButtonA11yLabel}
              >
                {isDownloading ? (
                  <Text style={styles.downloadProgressText}>{resolveProgressPercentText(normalizedProgress)}</Text>
                ) : (
                  <Download size={20} color="white" />
                )}
              </TouchableOpacity>
            ) : null}
          </View>

          <View style={styles.actionsRight} pointerEvents="box-none">
            <TouchableOpacity
              style={[
                styles.controlButton,
                styles.speedButton,
                disableSpeedControl ? styles.controlButtonDisabled : null,
              ]}
              onPress={onCyclePlaybackSpeed}
              disabled={disableSpeedControl}
              accessibilityRole="button"
              accessibilityLabel="Toggle playback speed"
            >
              <Gauge size={20} color="white" />
              <Text style={styles.speedLabel}>{playbackSpeedLabel}</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.controlButton} onPress={onFullscreenPress}>
              {Platform.OS === 'web' ? (
                isWebFullscreenActive ? <Minimize size={20} color="white" /> : <Maximize size={20} color="white" />
              ) : (
                <Maximize size={20} color="white" />
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

// ─── MinimalControls Props ───────────────────────────────────────────────────

interface MinimalControlsProps {
  isPlaying: boolean;
  overlayAnimatedStyle: { opacity: Animated.Value; transform: { scale: Animated.Value }[] };
  overlayPointerEvents: 'box-none' | 'none';
  onTogglePlayPause: () => void;
}

/**
 * Compact control bar: play/pause button only.
 * Contains no conditional branch that selects between control variants.
 * Has no shared internal code with FullControls.
 */
function MinimalControls({
  isPlaying,
  overlayAnimatedStyle,
  overlayPointerEvents,
  onTogglePlayPause,
}: MinimalControlsProps) {
  return (
    <Animated.View
      style={[styles.controlsOverlay, styles.controlsOverlayMinimal, overlayAnimatedStyle]}
      pointerEvents={overlayPointerEvents}
    >
      <TouchableOpacity style={[styles.controlButton, styles.playButton]} onPress={onTogglePlayPause}>
        {isPlaying ? <Pause size={32} color="white" /> : <Play size={32} color="white" />}
      </TouchableOpacity>
    </Animated.View>
  );
}

function VideoPlayerLoaded({
  uri,
  fileName,
  onDownload,
  autoPlay,
  initialWasPlaying,
  showControlsProp,
  maxHeight,
  seekStepSeconds,
  onSharePress,
  playRequestId,
  onResolvedUriChange,
  onDurationChange,
  onPreviewAvailable,
  posterUri,
  controlVariant,
  cacheKey,
  initialPlaybackPosition,
  initialResolvedUri,
  isDownloading = false,
  downloadProgress,
  transcodedUri,
}: VideoPlayerLoadedProps) {
  const { theme } = useTheme();

  // ── Tenant context (needed for on-demand transcode requests) ─────────────
  const { activeTenant } = useTenant();
  const activeTenantId = activeTenant?.id ?? '';

  // ── Effective transcodedUri — trim + empty-string guard ──────────────────
  // Requirements 2.7: whitespace-only or empty values are treated as absent.
  const effectiveTranscodedUri =
    typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
      ? transcodedUri.trim()
      : undefined;

  // ── Web codec fallback state machine ─────────────────────────────────────
  // Tracks whether the "Video is processing" spinner is visible.
  const [codecFallbackSpinnerVisible, setCodecFallbackSpinnerVisible] = useState(false);
  // Permanent error message set by the fallback (swap-target failure, no transcode job).
  const [codecFallbackError, setCodecFallbackError] = useState<string | null>(null);
  // Timeout error triggers a dismissible "Try again" message + retry button.
  const [codecFallbackTimeout, setCodecFallbackTimeout] = useState(false);
  // Whether h265 is supported by the current browser — determined once synchronously.
  const canPlayH265Ref = useRef<boolean | null>(null);
  if (Platform.OS === 'web' && canPlayH265Ref.current === null) {
    canPlayH265Ref.current = canPlayCodec('h265');
  }

  // The resolved web URI to pass to useWebVideoPlayer.
  // Initialised synchronously (lazy useState) so the first useLayoutEffect inside
  // useWebVideoPlayer sees the correct URL immediately — no double-load on mount.
  const [webResolvedUri, setWebResolvedUri] = useState<string>(() => {
    if (Platform.OS !== 'web') return '';
    const trimmedTranscoded =
      typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
        ? transcodedUri.trim()
        : undefined;
    // Always use the transcoded H.264 copy when available, regardless of H.265
    // support. The original H.265 may have been deleted from Firebase Storage
    // after transcoding — loading it on any browser causes 403 console errors.
    if (trimmedTranscoded) {
      return trimmedTranscoded;
    }
    // When transcoding is disabled the original is never deleted — load immediately
    // for ALL browsers. canPlayType reports '' for H.265 on Chrome/macOS even when
    // VideoToolbox decoding is available, so h265ok is unreliable as a gate here.
    // Browsers that truly can't decode the format will fire onUnsupportedCodec.
    if (!isVideoTranscodeEnabled()) {
      return uri;
    }
    // No transcodedUri yet on ANY browser: start empty so the <video> element
    // makes no network requests while we wait for transcodedUri to arrive from
    // RTDB (typically within 100–200 ms on a live subscription). The useEffect
    // below sets the correct URI once it resolves or a short timeout elapses.
    return '';
  });

  // Track the currently-active web source in a ref so handleFullscreenPress can
  // pass the correct URL (which may differ from resolvedUriRef after a codec swap).
  const webResolvedUriRef = useRef<string>(webResolvedUri);
  // Stable ref to handleCodecError so the fallback timeout can call it without
  // capturing a stale closure — handleCodecError identity changes between renders.
  // Initialized to a no-op because handleCodecError is defined later in this
  // component (from useVideoCodecFallback). The sync effect below updates the ref
  // after every render, so it is always current before the 200 ms timer fires.
  const handleCodecErrorRef = useRef<(currentTime: number) => void>(() => {});
  // Ref to tryFulfillPendingPlay — needed by onReady callback which is evaluated
  // before tryFulfillPendingPlay is declared in the render function body.
  const tryFulfillPendingPlayRef = useRef<() => void>(() => {});
  useEffect(() => {
    webResolvedUriRef.current = webResolvedUri;
  }, [webResolvedUri]);

  // Ref to hold the seek-to position that should be applied when the new source loads.
  const webPlayerSeekRef = useRef<number>(0);
  // State version of the seek position so it can update the useWebVideoPlayer initialPosition.
  const [webInitialPosition, setWebInitialPosition] = useState<number>(
    Number.isFinite(initialPlaybackPosition) && initialPlaybackPosition > 0 ? initialPlaybackPosition : 0
  );

  // ── useVideoCodecFallback: orchestrates detect → request → poll → swap ───
  const {
    phase: codecFallbackPhase,
    onCodecError: handleCodecError,
    onSwapTargetError: handleSwapTargetError,
    retry: retryCodecFallback,
    activeUri: codecActiveUri,
  } = useVideoCodecFallback({
    uri,
    transcodedUri: effectiveTranscodedUri,
    tenantId: activeTenantId,
    onSourceResolved: (resolvedUrl, seekTo) => {
      setWebResolvedUri(resolvedUrl);
      // Seek to the position recorded at the codec error moment (Requirement 1.6).
      webPlayerSeekRef.current = seekTo;
      setWebInitialPosition(seekTo);
      // Clear any previous error so the controls overlay unlocks when the
      // new compatible source starts playing.
      setWebPlaybackError(null);
      setWebStatus('loading');
      setIsLoadingSafe(true);
    },
    onSpinnerChange: setCodecFallbackSpinnerVisible,
    onPermanentError: setCodecFallbackError,
    onTimeoutError: () => setCodecFallbackTimeout(true),
  });

  // Keep handleCodecErrorRef current so the fallback timer can call it safely.
  useEffect(() => {
    handleCodecErrorRef.current = handleCodecError;
  }, [handleCodecError]);

  // Initialise webResolvedUri once we know the codec capability and have the URI.
  // This runs once on mount (and when uri/effectiveTranscodedUri change).
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    const h265ok = canPlayH265Ref.current ?? canPlayCodec('h265');
    if (effectiveTranscodedUri) {
      // Always prefer the transcoded H.264 copy when available — on ALL browsers.
      // The original H.265 may have been deleted after transcoding, so loading it
      // even on H.265-capable browsers (e.g. desktop Chrome macOS 13+) risks 403.
      setWebResolvedUri(effectiveTranscodedUri);
      return;
    }
    // When transcoding is disabled the original is never deleted — load immediately
    // for ALL browsers regardless of H.265 detection. canPlayType is unreliable:
    // Chrome on macOS 13+ decodes H.265 via VideoToolbox but reports "" for hvc1.
    // Browsers that truly can't decode the format fire onUnsupportedCodec → error.
    if (!isVideoTranscodeEnabled()) {
      setWebResolvedUri((prev) => (prev ? prev : uri));
      return;
    }
    // No transcodedUri yet — wait briefly then trigger the codec fallback pipeline.
    // Timeout rationale:
    //   • 200 ms on H.265-capable browsers: allows the RTDB live subscription
    //     (~100 ms) to deliver transcodedUrl before the fallback fires.
    //   • 1000 ms on H.265-unsupported browsers: more time for hydrateMessages
    //     (Firestore) to return the transcodedUrl on older messages.
    const fallbackDelayMs = h265ok ? 200 : 1000;
    const timer = setTimeout(() => {
      // If webResolvedUri was set by another path (transcodedUri arrived), skip.
      if (webResolvedUriRef.current) {
        return;
      }
      // Trigger the codec fallback which queries the backend for the correct URL.
      // For transcoded videos: backend returns the H.264 copy (no HEAD to original).
      // For H.264 videos:      backend returns the original URL (safe, not deleted).
      // onSourceResolved in useVideoCodecFallback will call setWebResolvedUri.
      handleCodecErrorRef.current?.(0);
    }, fallbackDelayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, effectiveTranscodedUri]);

  // Keep webResolvedUri in sync when the fallback hook resolves a new source
  // (reactive swap path). We also need to update the web player's position seek.
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    if (codecActiveUri && codecActiveUri !== webResolvedUri) {
      setWebResolvedUri(codecActiveUri);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codecActiveUri]);

  // ── useWebVideoPlayer: manages the <video> element ref ───────────────────
  // Only call on web; on native we use useNativeVideoPlayer.
  // The hook is always called (Rules of Hooks), but is a no-op on native because
  // resolvedUri is '' on native and the hook guards Platform.OS internally.
  const {
    state: webPlayerState,
    videoRef: webVideoRef,
    play: webPlay,
    pause: webPause,
    seek: webSeek,
    setMuted: webSetMuted,
    setPlaybackSpeed: webSetPlaybackSpeed,
  } = useWebVideoPlayer({
    resolvedUri: Platform.OS === 'web' ? webResolvedUri : '',
    autoPlay: autoPlay || initialWasPlaying,
    initialPosition: webInitialPosition,
    isMuted: false, // will be synced below
    playbackSpeed: 1, // will be synced below
    onUnsupportedCodec: (currentTime) => {
      if (Platform.OS === 'web') {
        // Immediately reset the video element to stop audio-only playback.
        // H.265 on Android Chrome: the browser can decode audio but not video,
        // so the element plays audio-only while the "Converting..." spinner shows.
        // Setting webResolvedUri to '' triggers the useWebVideoPlayer empty-guard
        // which calls el.pause() + removeAttribute('src') + load() — silencing it.
        setWebResolvedUri('');
        handleCodecError(currentTime);
      }
    },
    onError: (error) => {
      if (Platform.OS === 'web') {
        // `done` means we successfully swapped to the transcoded H.264 source.
        const isPlayingTranscodedSource =
          codecFallbackPhase === 'done' &&
          typeof effectiveTranscodedUri === 'string' &&
          effectiveTranscodedUri.length > 0;

        if (isPlayingTranscodedSource && error !== 'unsupported-codec') {
          // The H.264 transcoded source itself failed — show permanent error.
          handleSwapTargetError();
        } else if (!isPlayingTranscodedSource && codecFallbackPhase === 'idle') {
          // Any error on the original source (codec, network, 403 after transcoding).
          // Reset element immediately to stop audio-only H.265 playback, then
          // trigger the fallback: instant swap if transcodedUri is already known,
          // otherwise POST /video/request-transcode to get/start the transcoded copy.
          setWebResolvedUri('');
          handleCodecError(webPlayerState.currentTime ?? 0);
        }
      }
    },
    onEnded: () => {
      if (Platform.OS === 'web') {
        setWebEnded(true);
      }
    },
    onReady: () => {
      if (Platform.OS === 'web') {
        setIsLoadingSafe(false);
        setWebStatus('readyToPlay');
        // Fulfill any pending play request the user made while the buffer was
        // reloading (e.g. after tab background cleared the browser's video buffer).
        tryFulfillPendingPlayRef.current();
      }
    },
  });
  const [isPlaying, setIsPlaying] = useState(autoPlay || initialWasPlaying);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showControlsVisible, setShowControlsVisible] = useState(showControlsProp);
  // CSS-based fullscreen: a boolean is all that's needed.
  // The same <video> element expands via position:fixed — no new element, no rebuffering.
  const [isWebFullscreenExpanded, setIsWebFullscreenExpanded] = useState(false);
  const [nativeFullscreenConfig, setNativeFullscreenConfig] = useState<NativeFullscreenConfig | null>(null);
  const [resolving, setResolving] = useState(false);
  const [isDraggingProgress, setIsDraggingProgress] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [pendingPlayRequest, setPendingPlayRequest] = useState(autoPlay || initialWasPlaying || playRequestId > 0);
  // Ref mirrors pendingPlayRequest so callbacks with stale closures (e.g. canplay
  // event firing before React batches the state update) can still read the latest value.
  const pendingPlayRequestRef = useRef(autoPlay || initialWasPlaying || playRequestId > 0);
  const {
    webStatus, setWebStatus,
    webBufferedPercent, setWebBufferedPercent,
    webIsBuffering, setWebIsBuffering,
    webIsStalled, setWebIsStalled,
    webPlaybackError, setWebPlaybackError,
    webEnded, setWebEnded,
    handleWebLoadStart: _hookWebLoadStart,
    handleWebCanPlay: _hookWebCanPlay,
    handleWebWaiting: _hookWebWaiting,
    handleWebStalled: _hookWebStalled,
    handleWebPlaying: _hookWebPlaying,
    handleWebError: _hookWebError,
    handleWebEnded: _hookWebEnded,
    resetWebState,
  } = useWebVideoState();
  const videoViewRef = useRef<React.ElementRef<typeof VideoView> | null>(null);
  const playbackIdRef = useRef<string>(createPlaybackId());
  const controlsTimeoutRef = useRef<number | null>(null);
  // On native, we need a ref for the VideoView (native fallback). On web, we use
  // webVideoRef from useWebVideoPlayer for stable HTMLVideoElement identity.
  const nativeVideoRef = useRef<any>(null);
  // videoRef is the active ref: webVideoRef on web, nativeVideoRef on native.
  // Both are always created (Rules of Hooks); we just pick which one to use.
  const videoRef: React.MutableRefObject<any> = Platform.OS === 'web' ? webVideoRef : nativeVideoRef;
  const [resolvedUri, setResolvedUri] = useState<string>(initialResolvedUri || uri);
  const lastPlayRequestIdRef = useRef(playRequestId);
  const durationRef = useRef<number | null>(null);
  const isMinimalControls = controlVariant === 'minimal';
  const cacheKeyRef = useRef(cacheKey);
  const initialPositionRef = useRef<number>(
    Number.isFinite(initialPlaybackPosition) && initialPlaybackPosition > 0 ? initialPlaybackPosition : 0
  );
  const hasAppliedInitialPositionRef = useRef(initialPositionRef.current <= 0);
  const currentTimeRef = useRef(0);
  const resolvedUriRef = useRef(resolvedUri);
  const playbackRateSyncedRef = useRef(false);
  const pauseForFullscreenRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState ?? 'active');
  const backgroundSnapshotRef = useRef<{ time: number; wasPlaying: boolean } | null>(null);
  const pendingRestoreRef = useRef(false);
  const intendedPlayingRef = useRef(autoPlay || initialWasPlaying);
  const pauseRequestedRef = useRef(false);
  // Tracks ended state in a ref so the resumeIfNeeded closure (defined inside a
  // useEffect with potentially stale state captures) can check it reliably.
  // el.ended can reset to false when the browser drops the video buffer after
  // a tab is backgrounded, making the ref necessary as a second guard.
  const webEndedRef = useRef(false);
  const lastCacheSyncRef = useRef(0);
  const pendingCacheSyncRef = useRef<number | null>(null);
  const lastResumeAttemptRef = useRef(0);
  const readyOpacity = useSharedValue(0);
  const controlsOpacity = useRef(new Animated.Value(showControlsProp ? 1 : 0)).current;
  const controlsScale = useRef(new Animated.Value(1)).current;
  const normalizedProgress = useEasedDownloadProgressPercent(
    downloadProgress,
    isDownloading
  );
  const downloadButtonA11yLabel = resolveDownloadProgressLabel(
    isDownloading,
    normalizedProgress,
    'Download video'
  );
  const shareButtonA11yLabel = 'Share video';

  useEffect(() => {
    cacheKeyRef.current = cacheKey;
  }, [cacheKey]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    resolvedUriRef.current = resolvedUri;
  }, [resolvedUri]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    resetWebState();
  }, [resetWebState, resolvedUri]);

  // ── Sync useWebVideoPlayer state into local state variables ───────────────
  // This keeps the rest of the component logic (controls, cache, etc.) working
  // with no changes, as they read from the local state variables.
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    const s = webPlayerState;
    setCurrentTimeSafe(s.currentTime);
    if (Number.isFinite(s.currentTime)) {
      currentTimeRef.current = s.currentTime;
    }
    setIsPlayingSafe(s.isPlaying);
    setWebBufferedPercent(s.bufferedPercent ?? null);
    setWebIsBuffering(s.isBuffering);
    setWebIsStalled(s.isStalled);
    if (s.ended) {
      setWebEnded(true);
      webEndedRef.current = true;
      // Prevent tab-switch auto-replay. When the browser clears the video buffer
      // after the tab is hidden, el.ended resets to false. Resetting intendedPlayingRef
      // here is the reliable guard — resumeIfNeeded bails on !intendedPlayingRef.current.
      intendedPlayingRef.current = false;
      pauseRequestedRef.current = false;
      pendingPlayRequestRef.current = false;
      setPendingPlayRequest(false);
    }
    if (s.error && s.error !== 'unsupported-codec') {
      setWebPlaybackError(s.error);
      setWebStatus('error');
    } else if (s.error === 'unsupported-codec') {
      setWebPlaybackError('unsupported-codec');
      setWebStatus('error');
    }
    if (s.duration > 0) {
      setDurationSafe(s.duration);
      updateDuration(s.duration);
    }
    if (!s.isBuffering && !s.isStalled && (s.isPlaying || s.currentTime > 0)) {
      setIsLoadingSafe(false);
      // Always update to readyToPlay when the video is actually playing — this
      // clears the 'error' status set by the original source failure so that
      // the controls overlay unlocks after a successful source swap.
      setWebStatus('readyToPlay');
      // Also clear the playback error so shouldLockControls becomes false.
      setWebPlaybackError((prev) => (prev ? null : prev));
    }
  // Only depend on the stable webPlayerState reference to avoid running on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webPlayerState]);

  // Keep webEndedRef in sync with webEnded state so replay/retry actions
  // (which call setWebEnded(false)) correctly re-enable resumeIfNeeded.
  useEffect(() => {
    webEndedRef.current = webEnded;
  }, [webEnded]);

  // ── Sync isMuted → useWebVideoPlayer ─────────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    webSetMuted(isMuted);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMuted]);

  // ── Sync playbackSpeed → useWebVideoPlayer ────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    webSetPlaybackSpeed(playbackSpeed);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playbackSpeed]);

  useEffect(() => {
    playbackRateSyncedRef.current = false;
  }, [resolvedUri]);

  useEffect(() => {
    const normalized =
      Number.isFinite(initialPlaybackPosition) && initialPlaybackPosition > 0 ? initialPlaybackPosition : 0;
    initialPositionRef.current = normalized;
    hasAppliedInitialPositionRef.current = normalized <= 0;
  }, [initialPlaybackPosition]);

  useEffect(() => {
    if (!initialWasPlaying) {
      return;
    }
    intendedPlayingRef.current = true;
    pendingPlayRequestRef.current = true;
    setPendingPlayRequest(true);
  }, [initialWasPlaying]);

  useEffect(() => {
    if (!initialResolvedUri) {
      return;
    }
    setResolvedUri((prev) => (prev === initialResolvedUri ? prev : initialResolvedUri));
  }, [initialResolvedUri]);

  const setIsPlayingSafe = useCallback((next: boolean) => {
    setIsPlaying((prev) => (prev === next ? prev : next));
  }, []);

  const setCurrentTimeSafe = useCallback((next: number) => {
    if (!Number.isFinite(next)) {
      return;
    }
    setCurrentTime((prev) => (Math.abs(prev - next) < 1 / 60 ? prev : next));
  }, []);

  const setIsLoadingSafe = useCallback((next: boolean) => {
    setIsLoading((prev) => (prev === next ? prev : next));
  }, []);

  const setDurationSafe = useCallback((next: number) => {
    if (!Number.isFinite(next)) {
      return;
    }
    setDuration((prev) => (Math.abs(prev - next) < 1 / 60 ? prev : next));
  }, []);
  const syncPlaybackCache = useCallback(
    (force = false, override?: { time?: number; wasPlaying?: boolean }) => {
    const key = cacheKeyRef.current;
    if (!key) {
      return;
    }
    const now = Date.now();
    if (Platform.OS !== 'web' && !force && now - lastCacheSyncRef.current < 1200) {
      if (pendingCacheSyncRef.current == null) {
        pendingCacheSyncRef.current = setTimeout(() => {
          pendingCacheSyncRef.current = null;
          syncPlaybackCache(true, override);
        }, 1200) as unknown as number;
      }
      return;
    }
    lastCacheSyncRef.current = now;
    patchVideoCacheEntry(key, {
      lastKnownTime: override?.time ?? currentTimeRef.current,
      lastKnownWasPlaying: override?.wasPlaying ?? intendedPlayingRef.current,
    });
  }, []);
  const isNativeFullscreenVisible = !!nativeFullscreenConfig;
  const isWebFullscreenActive = isWebFullscreenExpanded;
  const isFullscreen = Platform.OS === 'web' ? isWebFullscreenActive : isNativeFullscreenVisible;

  const playbackSpeedLabel = useMemo(() => {
    const rounded = Math.round(playbackSpeed * 100) / 100;
    const formatted = Number.isInteger(rounded)
      ? rounded.toFixed(0)
      : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${formatted}x`;
  }, [playbackSpeed]);

  const updateDuration = useCallback(
    (value: number | null) => {
      const normalized = value && Number.isFinite(value) && value > 0 ? value : null;
      if (durationRef.current === normalized) {
        return;
      }
      durationRef.current = normalized;
      onDurationChange?.(normalized);
      if (normalized != null && cacheKeyRef.current) {
        patchVideoCacheEntry(cacheKeyRef.current, { duration: normalized });
      }
    },
    [onDurationChange]
  );

  // ── Native player (iOS / Android) ────────────────────────────────────────
  // useNativeVideoPlayer encapsulates expo-video player creation, event
  // subscriptions, and cleanup (Requirements 4.1). On native, we always play
  // `resolvedUri` regardless of any `transcodedUri` prop — the codec fallback
  // path is web-only (Requirement 4.8).
  const {
    state: nativePlayerState,
    player,
  } = useNativeVideoPlayer({
    // On web, VideoPlayer uses useWebVideoPlayer instead of expo-video.
    // Pass '' so useNativeVideoPlayer receives a null source and expo-video
    // does not probe the video URI — which would cause HEAD 403 errors for
    // deleted H.265 originals (removed from Firebase Storage after transcoding).
    uri: Platform.OS !== 'web' ? resolvedUri : '',
    autoPlay: autoPlay || initialWasPlaying,
    initialPosition: Number.isFinite(initialPlaybackPosition) && initialPlaybackPosition > 0
      ? initialPlaybackPosition
      : undefined,
    playbackSpeed,
    isMuted,
  });

  const pauseSelf = useCallback(() => {
    if (Platform.OS === 'web' && videoRef.current) {
      try {
        videoRef.current.pause();
      } catch (error) {
        logger.debug?.('VideoPlayer: pause other video failed', error);
      }
    } else if (Platform.OS !== 'web') {
      try {
        player.pause();
      } catch (error) {
        logger.debug?.('VideoPlayer: pause other video failed', error);
      }
    }

    intendedPlayingRef.current = false;
    pauseRequestedRef.current = false;
    pendingPlayRequestRef.current = false;
    setPendingPlayRequest(false);
    setIsPlayingSafe(false);
    syncPlaybackCache(true, { time: currentTimeRef.current, wasPlaying: false });
    // Show controls so the user sees the paused state and can resume playback.
    // Without this, controls stay hidden when another video takes over — the
    // user would see a paused video with no visible way to resume it.
    setShowControlsVisible(true);
  }, [player, setIsPlayingSafe, setPendingPlayRequest, setShowControlsVisible, syncPlaybackCache]);

  useEffect(() => registerPlaybackHandler(playbackIdRef.current, pauseSelf), [pauseSelf]);

  const restoreFromBackground = useCallback(() => {
    if (Platform.OS === 'web') {
      return;
    }
    const snapshot = backgroundSnapshotRef.current;
    if (!snapshot) {
      return;
    }
    const targetTime = Number.isFinite(snapshot.time) ? snapshot.time : 0;
    try {
      player.currentTime = targetTime;
    } catch (error) {
      logger.debug?.('VideoPlayer: failed to restore time after background', error);
    }
    setCurrentTimeSafe(targetTime);

    if (snapshot.wasPlaying) {
      try {
        pauseOtherVideos(playbackIdRef.current);
        player.play();
        setIsPlayingSafe(true);
      } catch (error) {
        logger.debug?.('VideoPlayer: failed to resume after background', error);
        setIsPlayingSafe(false);
      }
    }

    backgroundSnapshotRef.current = null;
    pendingRestoreRef.current = false;
  }, [player, setCurrentTimeSafe, setIsPlayingSafe]);

  const seekToInitialPosition = useCallback(() => {
    const target = initialPositionRef.current;
    if (!target || target <= 0 || hasAppliedInitialPositionRef.current) {
      return;
    }
    try {
      if (Platform.OS === 'web' && videoRef.current) {
        videoRef.current.currentTime = target;
      } else if (Platform.OS !== 'web') {
        player.currentTime = target;
      }
      setCurrentTimeSafe(target);
    } catch (error) {
      logger.debug?.('VideoPlayer: failed to restore playback position', error);
    }
    hasAppliedInitialPositionRef.current = true;
  }, [player, setCurrentTimeSafe]);

  // Map useNativeVideoPlayer hook outputs to the local variable names used
  // throughout the rest of this component.
  const nativePlaying = nativePlayerState.isPlaying;
  const timeUpdate = {
    currentTime: nativePlayerState.currentTime,
    bufferedPosition: nativePlayerState.bufferedPosition,
  };
  const status = nativePlayerState.status;
  const statusError: { message?: string } | null = nativePlayerState.error
    ? { message: nativePlayerState.error }
    : null;
  // playbackRateChange: synthesise a compatible shape so downstream effects
  // that read playbackRateChange.playbackRate continue to work unchanged.
  const playbackRateChange = { playbackRate: player.playbackRate ?? 1 };

  const applyPlaybackRate = useCallback(
    (rate: number) => {
      if (!Number.isFinite(rate)) {
        return;
      }

      if (Platform.OS === 'web' && videoRef.current) {
        try {
          videoRef.current.playbackRate = rate;
        } catch (error) {
          logger.debug?.('VideoPlayer: failed to set web playback rate', error);
        }
      }

      try {
        player.preservesPitch = true;
      } catch {}

      try {
        player.playbackRate = rate;
        return;
      } catch (error) {
        const nativePlayer = player as unknown as {
          setRate?: (value: number) => void;
          setPlaybackRate?: (value: number) => void;
          rate?: number;
        };

        try {
          if (typeof nativePlayer.setRate === 'function') {
            nativePlayer.setRate(rate);
            return;
          }
          if (typeof nativePlayer.setPlaybackRate === 'function') {
            nativePlayer.setPlaybackRate(rate);
            return;
          }
          if (typeof nativePlayer.rate === 'number') {
            nativePlayer.rate = rate;
            return;
          }
        } catch (fallbackError) {
          logger.debug?.('VideoPlayer: fallback playback rate apply failed', fallbackError);
        }
      }
    },
    [player]
  );

  useEffect(() => {
    try {
      player.preservesPitch = true;
    } catch {}

    const currentRate = player.playbackRate;
    if (typeof currentRate === 'number' && Number.isFinite(currentRate)) {
      setPlaybackSpeed((prev) => (Math.abs(prev - currentRate) < 0.001 ? prev : currentRate));
    }
  }, [player]);

  useEffect(() => {
    if (!playbackRateSyncedRef.current) {
      return;
    }
    const nextRate = playbackRateChange.playbackRate;
    if (typeof nextRate === 'number' && Number.isFinite(nextRate)) {
      setPlaybackSpeed((prev) => (Math.abs(prev - nextRate) < 0.001 ? prev : nextRate));
    }
  }, [playbackRateChange.playbackRate]);

  useEffect(() => {
    applyPlaybackRate(playbackSpeed);
    playbackRateSyncedRef.current = true;
  }, [applyPlaybackRate, playbackSpeed]);

  // Progress bar gesture handling is extracted to the useVideoProgressBar hook.
  // The hook call is placed after effectiveDuration is defined (below).

  useEffect(() => {
    if (playRequestId !== lastPlayRequestIdRef.current) {
      lastPlayRequestIdRef.current = playRequestId;
      pendingPlayRequestRef.current = true;
      setPendingPlayRequest(true);
    }
  }, [playRequestId]);

  useEffect(() => {
    let cancelled = false;

    const applyResolvedUri = (nextUri: string, patch?: Partial<VideoSourceCacheEntry>) => {
      if (!nextUri) {
        return;
      }
      setResolvedUri((prev) => (prev === nextUri ? prev : nextUri));
      onResolvedUriChange?.(nextUri);
      if (cacheKeyRef.current) {
        patchVideoCacheEntry(cacheKeyRef.current, { resolvedUri: nextUri, ...patch });
      }
    };

    // ── WEB: use the codec-aware resolved URI ─────────────────────────────────
    // On web, the effective source is managed by the codec fallback state machine
    // (useVideoCodecFallback + useWebVideoPlayer). We still call applyResolvedUri
    // to keep the cache and parent callbacks in sync, but the actual <video> src
    // is controlled by webResolvedUri / webVideoRef (not this local resolvedUri).
    if (Platform.OS === 'web') {
      setResolving(false);
      setIsLoadingSafe(true);
      // Use the effective transcoded URI if h265 is not supported (proactive path),
      // otherwise use the original URI as the cache / parent resolver source.
      const webCacheUri = (canPlayH265Ref.current === false && effectiveTranscodedUri)
        ? effectiveTranscodedUri
        : uri;
      applyResolvedUri(webCacheUri);
      return () => {
        cancelled = true;
      };
    }

    if (initialResolvedUri) {
      setResolving(false);
      setIsLoadingSafe(false);
      applyResolvedUri(initialResolvedUri, { lastPosition: initialPositionRef.current });
      return () => {
        cancelled = true;
      };
    }

    setIsLoadingSafe(true);
    setCurrentTimeSafe(0);
    setDurationSafe(0);
    updateDuration(null);
    setResolving(false);
    applyResolvedUri(uri);

    (async () => {
      try {
        if (uri.startsWith('data:')) {
          return;
        }

        const hint = uri.startsWith('file://') ? uri : undefined;
        const localUri = await chatCacheService.getMediaForDownload(uri, fileName, hint, 'normal', { lazy: true });
        if (cancelled) {
          return;
        }

        if (localUri) {
          const canSwapSource = currentTimeRef.current <= 0.1;
          if (canSwapSource) {
            applyResolvedUri(localUri);
          } else if (cacheKeyRef.current) {
            patchVideoCacheEntry(cacheKeyRef.current, { resolvedUri: localUri });
          }
        }

        if (/^https?:/i.test(uri) && !localUri) {
          chatCacheService
            .getMediaForDownload(uri, fileName, hint, 'low')
            .catch((error) => logger.debug?.('VideoPlayer: background cache warm failed', error));
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: failed to resolve cached media', error);
      } finally {
        if (!cancelled) {
          setResolving(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, effectiveTranscodedUri, fileName, initialResolvedUri, onResolvedUriChange, setCurrentTimeSafe, setDurationSafe, setIsLoadingSafe, updateDuration, uri]);

  useEffect(() => {
    // Keep controls visible when video ends so user can see play button to restart.
    // Use a ref guard to prevent this from causing a re-render loop.
    if (webEnded && showControlsProp) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
      setShowControlsVisible((prev) => (prev === true ? prev : true));
      return () => {};  // explicit cleanup to satisfy React
    }
    if (showControlsProp && isPlaying && !isDraggingProgress) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControlsVisible(false);
      }, 2000) as unknown as number;
    }
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showControlsProp, isPlaying, isDraggingProgress, webEnded]);

  const restartIfEnded = useCallback(() => {
    const epsilon = 0.35;
    const baseDuration = Platform.OS === 'web'
      ? videoRef.current?.duration ?? durationRef.current ?? duration ?? 0
      : player.duration || durationRef.current || duration || 0;

    if (!baseDuration || !Number.isFinite(baseDuration)) {
      return;
    }

    if (currentTime < baseDuration - epsilon) {
      return;
    }

    if (Platform.OS === 'web' && videoRef.current) {
      try {
        videoRef.current.currentTime = 0;
      } catch (error) {
        logger.debug?.('VideoPlayer: failed to reset web currentTime', error);
      }
    } else {
      try {
        player.currentTime = 0;
      } catch (error) {
        logger.debug?.('VideoPlayer: failed to reset native currentTime', error);
      }
    }

    setCurrentTimeSafe(0);
  }, [currentTime, duration, player, setCurrentTimeSafe]);

  const togglePlayPause = () => {
    if (Platform.OS === 'web' && videoRef.current) {
      if (isPlaying) {
        pauseRequestedRef.current = true;
        videoRef.current.pause();
        intendedPlayingRef.current = false;
        syncPlaybackCache(true, { time: currentTimeRef.current, wasPlaying: false });
      } else {
        pauseOtherVideos(playbackIdRef.current);
        // If the video ended, seek back to start before resuming.
        // Clear webEnded so the UX state leaves the 'ended' phase.
        if (webEnded) {
          setWebEnded(false);
          try { videoRef.current.currentTime = 0; } catch {}
          currentTimeRef.current = 0;
        } else {
          restartIfEnded();
        }
        // If the element has no data (e.g. tab was backgrounded for a long time
        // and the browser discarded the buffer), reload before playing.
        // Do NOT set isPlaying=true here — the play hasn't started yet.
        // onReady → tryFulfillPendingPlayRef.current() will initiate play once
        // the element has buffered enough metadata.
        if (videoRef.current.readyState === 0 && videoRef.current.src && !videoRef.current.error) {
          pendingPlayRequestRef.current = true;
          setPendingPlayRequest(true);
          intendedPlayingRef.current = true;
          setIsLoadingSafe(true);
          videoRef.current.load();
          return;
        }
        const playPromise = videoRef.current.play();
        if (playPromise?.catch) {
          playPromise.catch((error: unknown) => {
            logger.debug?.('VideoPlayer: play() rejected', error);
          });
        }
        intendedPlayingRef.current = true;
        syncPlaybackCache(true, { time: currentTimeRef.current, wasPlaying: true });
        pauseRequestedRef.current = false;
      }
    } else if (Platform.OS !== 'web') {
      try {
        if (isPlaying) {
          player.pause();
          intendedPlayingRef.current = false;
          setPendingPlayRequest(false);
          syncPlaybackCache(true, { time: currentTimeRef.current, wasPlaying: false });
        } else {
          pauseOtherVideos(playbackIdRef.current);
          restartIfEnded();
          player.play();
          intendedPlayingRef.current = true;
          syncPlaybackCache(true, { time: currentTimeRef.current, wasPlaying: true });
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: togglePlayPause error', error);
      }
    }
    setIsPlayingSafe(!isPlaying);
    setShowControlsVisible(true);
  };

  const handleRetry = useCallback(() => {
    if (!resolvedUri) {
      return;
    }
    setIsLoadingSafe(true);
    setWebPlaybackError(null);
    setWebEnded(false);
    setWebStatus('loading');
    setWebIsBuffering(false);
    setWebIsStalled(false);
    intendedPlayingRef.current = true;
    pauseRequestedRef.current = false;
    setPendingPlayRequest(true);

    if (Platform.OS === 'web' && videoRef.current) {
      try {
        videoRef.current.load();
        const playPromise = videoRef.current.play?.();
        if (playPromise?.catch) {
          playPromise.catch(() => undefined);
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: web retry failed', error);
      }
      return;
    }

    try {
      const replace = (player as unknown as { replaceAsync?: (source: VideoSource) => Promise<void> }).replaceAsync;
      if (typeof replace === 'function') {
        void replace({ uri: resolvedUri });
      } else {
        player.replace({ uri: resolvedUri }, true);
      }
    } catch (error) {
      logger.debug?.('VideoPlayer: native retry failed', error);
    }
  }, [player, resolvedUri, setIsLoadingSafe]);

  const handleReplay = useCallback(() => {
    setWebEnded(false);
    restartIfEnded();
    if (Platform.OS === 'web' && videoRef.current) {
      try {
        pauseOtherVideos(playbackIdRef.current);
        const playPromise = videoRef.current.play?.();
        if (playPromise?.catch) {
          playPromise.catch(() => undefined);
        }
        setIsPlayingSafe(true);
      } catch (error) {
        logger.debug?.('VideoPlayer: web replay failed', error);
      }
    } else if (Platform.OS !== 'web') {
      try {
        pauseOtherVideos(playbackIdRef.current);
        player.play();
        setIsPlayingSafe(true);
      } catch (error) {
        logger.debug?.('VideoPlayer: native replay failed', error);
      }
    }
    intendedPlayingRef.current = true;
    pauseRequestedRef.current = false;
    setShowControlsVisible(true);
  }, [player, restartIfEnded, setIsPlayingSafe]);

  const toggleMute = () => {
    if (Platform.OS === 'web' && videoRef.current) {
      videoRef.current.muted = !isMuted;
    }
    setIsMuted(!isMuted);
    setShowControlsVisible(true);
  };

  const handleSingleTap = useCallback(() => {
    setShowControlsVisible((prev) => (!showControlsProp ? true : !prev));
  }, [showControlsProp]);

  const seekBySeconds = useCallback(
    (deltaSeconds: number) => {
      const durationSource =
        Platform.OS === 'web'
          ? videoRef.current?.duration ?? durationRef.current ?? duration ?? 0
          : player.duration || durationRef.current || duration || 0;
      if (!durationSource || !Number.isFinite(durationSource)) {
        return false;
      }

      const baseTime = Number.isFinite(currentTimeRef.current) ? currentTimeRef.current : 0;
      const nextTime = clamp(baseTime + deltaSeconds, 0, durationSource);
      if (!Number.isFinite(nextTime)) {
        return false;
      }

      if (Platform.OS === 'web' && videoRef.current) {
        try {
          videoRef.current.currentTime = nextTime;
        } catch (error) {
          logger.debug?.('VideoPlayer: web seek failed', error);
        }
      } else if (Platform.OS !== 'web') {
        try {
          player.currentTime = nextTime;
        } catch (error) {
          logger.debug?.('VideoPlayer: native seek failed', error);
        }
      }

      setCurrentTimeSafe(nextTime);
      currentTimeRef.current = nextTime;
      syncPlaybackCache(true, { time: nextTime, wasPlaying: intendedPlayingRef.current });
      return true;
    },
    [duration, player, setCurrentTimeSafe, syncPlaybackCache]
  );

  const updateWebBufferedPercent = useCallback(() => {
    const nextBuffered = resolveBufferedPercentFromElement(videoRef.current as HTMLVideoElement | null);
    if (nextBuffered == null) {
      return;
    }
    setWebBufferedPercent((prev) => {
      if (prev != null && Math.abs(prev - nextBuffered) < 0.6) {
        return prev;
      }
      return nextBuffered;
    });
  }, []);

  const handleTimeUpdate = () => {
    if (Platform.OS === 'web' && videoRef.current) {
      const nextTime = videoRef.current.currentTime;
      if (Number.isFinite(nextTime)) {
        currentTimeRef.current = nextTime;
      }
      setCurrentTimeSafe(nextTime);
      updateWebBufferedPercent();

      if (Number.isFinite(nextTime)) {
        const key = cacheKeyRef.current;
        if (key) {
          patchVideoCacheEntry(key, {
            lastKnownTime: nextTime,
            lastKnownWasPlaying: intendedPlayingRef.current,
            lastPosition: nextTime,
          });
        }
      }

      // timeupdate is the source of truth on web; keep cache synced directly.
    }
  };

  const tryFulfillPendingPlay = useCallback(() => {
    // Use ref to avoid stale closure — canplay/canplaythrough events fire
    // before React batches setPendingPlayRequest(true) into the closure.
    if (!pendingPlayRequestRef.current) {
      return;
    }

    if (Platform.OS === 'web') {
      const element = videoRef.current;
      if (!element) {
        return;
      }
      try {
        pauseOtherVideos(playbackIdRef.current);
        const playPromise = element.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise
            .then(() => {
              setIsPlayingSafe(true);
              intendedPlayingRef.current = true;
              pauseRequestedRef.current = false;
              pendingPlayRequestRef.current = false;
              setPendingPlayRequest(false);
            })
            .catch((error: unknown) => {
              logger.debug?.('VideoPlayer: autoplay rejected', error);
              pendingPlayRequestRef.current = false;
              setPendingPlayRequest(false);
            });
        } else {
          setIsPlayingSafe(true);
          intendedPlayingRef.current = true;
          pauseRequestedRef.current = false;
          pendingPlayRequestRef.current = false;
          setPendingPlayRequest(false);
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: autoplay threw', error);
      }
      return;
    }

    try {
      pauseOtherVideos(playbackIdRef.current);
      player.play();
      pendingPlayRequestRef.current = false;
      setPendingPlayRequest(false);
    } catch (error) {
      logger.debug?.('VideoPlayer: native autoplay failed', error);
    }
  // Remove pendingPlayRequest from deps — we read via ref to avoid stale closures
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, setIsPlayingSafe]);

  // Keep the ref in sync so onReady (defined before tryFulfillPendingPlay) can call it.
  useEffect(() => {
    tryFulfillPendingPlayRef.current = tryFulfillPendingPlay;
  }, [tryFulfillPendingPlay]);

  const handleLoadedMetadata = () => {
    if (Platform.OS === 'web' && videoRef.current) {
      const mediaDuration = videoRef.current.duration;
      setDurationSafe(mediaDuration);
      updateDuration(mediaDuration);
      if (cacheKeyRef.current) {
        patchVideoCacheEntry(cacheKeyRef.current, { loadedOnce: true });
      }
      applyPlaybackRate(playbackSpeed);
      if (onPreviewAvailable && typeof document !== 'undefined') {
        const frame = captureFrameFromElement(videoRef.current as any);
        if (frame) {
          onPreviewAvailable(frame);
        }
      }

      // Detect unsupported video codec (e.g. H.265/HEVC from iPhone recordings):
      // the container parses and audio/duration are available, but the video track
      // has zero dimensions because the browser can't decode it. Mobile Chrome/Edge
      // on Android lack an HEVC decoder, so the video renders black / fails while
      // audio plays. Surface a clear error instead of a confusing black screen.
      const vw = videoRef.current.videoWidth;
      const vh = videoRef.current.videoHeight;
      if ((!vw || !vh) && mediaDuration > 0) {
        logger.warn?.('VideoPlayer: video track has zero dimensions — likely unsupported codec (HEVC)', {
          videoWidth: vw,
          videoHeight: vh,
        });
        setWebPlaybackError('unsupported-codec');
        setWebStatus('error');
        setIsLoadingSafe(false);
        return;
      }

      setIsLoadingSafe(false);
      setWebStatus('readyToPlay');
      setWebPlaybackError(null);
      setWebEnded(false);
      seekToInitialPosition();
      tryFulfillPendingPlay();
    }
  };

  const handleWebLoadStart = useCallback(() => {
    setIsLoadingSafe(true);
    _hookWebLoadStart();
  }, [setIsLoadingSafe, _hookWebLoadStart]);

  const handleWebCanPlay = useCallback(() => {
    _hookWebCanPlay();
    setIsLoadingSafe(false);
    tryFulfillPendingPlay();
  }, [_hookWebCanPlay, setIsLoadingSafe, tryFulfillPendingPlay]);

  const handleWebWaiting = useCallback(() => {
    _hookWebWaiting();
  }, [_hookWebWaiting]);

  const handleWebStalled = useCallback(() => {
    _hookWebStalled();
  }, [_hookWebStalled]);

  const handleWebPlaying = useCallback(() => {
    _hookWebPlaying();
    setIsLoadingSafe(false);
  }, [_hookWebPlaying, setIsLoadingSafe]);

  const handleWebError = useCallback(() => {
    _hookWebError(videoRef.current as HTMLVideoElement | null);
    setIsLoadingSafe(false);
  }, [_hookWebError, setIsLoadingSafe]);

  const handleWebEnded = useCallback(() => {
    // Explicitly pause — some browsers loop briefly after 'ended' before stopping.
    if (videoRef.current && !videoRef.current.paused) {
      try { videoRef.current.pause(); } catch { /* ignore */ }
    }
    _hookWebEnded();
    intendedPlayingRef.current = false;
    pauseRequestedRef.current = false;
    setIsPlayingSafe(false);
  }, [_hookWebEnded, setIsPlayingSafe]);

  const handleWebProgress = useCallback(() => {
    updateWebBufferedPercent();
  }, [updateWebBufferedPercent]);

  // Live frame capture: once the inline video has played past 0.5s on web,
  // capture a frame directly from the playing element. This is more reliable
  // than the hidden-video thumbnail approach because the element is already
  // decoded in the current browser (no CORS / codec uncertainty).
  const liveFrameCapturedRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    // Only capture once, and only if we don't already have a data: URI thumbnail.
    if (liveFrameCapturedRef.current) {
      return;
    }
    if (currentTime < 0.5) {
      return;
    }
    const el = webVideoRef.current as HTMLVideoElement | null;
    if (!el) {
      return;
    }
    const frame = captureFrameFromElement(el);
    if (frame) {
      liveFrameCapturedRef.current = true;
      // Update the outer component's preview and persist it to the video cache.
      onPreviewAvailable?.(frame);
      patchVideoCacheEntry(cacheKey, { previewUri: frame });
    }
  }, [cacheKey, currentTime, onPreviewAvailable]);

  const handleInlineWebSeeked = useCallback(() => {
    if (!videoRef.current) {
      return;
    }

    const nextTime = videoRef.current.currentTime;
    if (!Number.isFinite(nextTime)) {
      return;
    }

    currentTimeRef.current = nextTime;
    const key = cacheKeyRef.current;
    if (key) {
      patchVideoCacheEntry(key, {
        lastKnownTime: nextTime,
        lastKnownWasPlaying: intendedPlayingRef.current,
        lastPosition: nextTime,
      });
    }
  }, []);

  const handleInlineWebPlay = useCallback(() => {
    pauseOtherVideos(playbackIdRef.current);
    intendedPlayingRef.current = true;
    pauseRequestedRef.current = false;
    setIsPlayingSafe(true);
    setWebIsBuffering(false);
    setWebIsStalled(false);
    // NOTE: Do NOT reset webEnded here. The ended state is only cleared explicitly
    // by the user pressing Replay. Resetting it here caused a playback loop because
    // the browser fires the play event right after ended in some scenarios.
    setWebStatus('readyToPlay');
    setWebPlaybackError(null);
  }, [setIsPlayingSafe]);

  const handleInlineWebPause = useCallback(() => {
    setIsPlayingSafe(false);
    setWebIsBuffering(false);
    setWebIsStalled(false);
    if (pauseRequestedRef.current) {
      intendedPlayingRef.current = false;
      pauseRequestedRef.current = false;
    }
  }, [setIsPlayingSafe]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }

    const syncFromElement = () => {
      if (!videoRef.current) {
        return;
      }
      const elementTime = videoRef.current.currentTime;
      if (Number.isFinite(elementTime)) {
        currentTimeRef.current = elementTime;
        syncPlaybackCache(true, {
          time: elementTime,
          wasPlaying: intendedPlayingRef.current,
        });
      }
    };

    const resumeIfNeeded = () => {
      if (!videoRef.current) {
        return;
      }
      if (!intendedPlayingRef.current) {
        return;
      }
      if (document.visibilityState && document.visibilityState !== 'visible') {
        return;
      }
      // Never auto-resume after the video has ended — user must press Replay.
      // Check both the DOM property and the React ref: el.ended can reset to false
      // when the browser discards the video buffer on tab hide/show.
      if (videoRef.current.ended || webEndedRef.current) {
        return;
      }

      try {
        const el = videoRef.current;
        const resumeTime = currentTimeRef.current;

        if (Number.isFinite(resumeTime) && resumeTime > 0) {
          if (Math.abs(el.currentTime - resumeTime) > 0.5) {
            el.currentTime = resumeTime;
          }
        }

        // If the element is in a stale state after backgrounding (HAVE_NOTHING or
        // HAVE_METADATA with no data), force a reload so the browser re-fetches
        // the range it needs. The 'canplay' event will trigger the pending play.
        if (el.readyState < 3 && el.src && !el.error) {
          // Use pendingPlayRequestRef so onReady → tryFulfillPendingPlay handles
          // the play() call after the element has reloaded its metadata.
          // This avoids the fragile 400ms race between setTimeout and loadedmetadata.
          pendingPlayRequestRef.current = true;
          setPendingPlayRequest(true);
          el.load();
          return;
        }

        const playPromise = el.play?.();
        if (playPromise?.catch) {
          playPromise.catch(() => undefined);
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: resume after browser fullscreen failed', error);
      }
    };

    const handleFullscreenChange = () => {
      syncFromElement();
      // Do NOT call resumeIfNeeded() on fullscreenchange.
      // Entering/exiting native fullscreen via requestFullscreen() does not
      // change video playback state — the video keeps playing or stays paused.
      // Calling resumeIfNeeded() here caused the video to auto-play whenever
      // the user toggled between inline and fullscreen mode.
    };
    const handleVisibilityChange = () => {
      syncFromElement();
      resumeIfNeeded();
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange as EventListener);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange as EventListener);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [syncPlaybackCache]);

  // ─── Media Session API callbacks and hook call are placed after effectiveDuration below ───

  const handleInlineSharePress = useCallback((event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
    // Exit native fullscreen first — the ShareModal renders outside the
    // fullscreen element and would be hidden behind it otherwise.
    if (Platform.OS === 'web' && isWebFullscreenExpanded && typeof document !== 'undefined') {
      try {
        const doc = document as any;
        const exitFn = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen;
        if (exitFn) {
          const p = exitFn.call(document);
          if (p?.catch) p.catch(() => undefined);
        }
      } catch { /* ignore */ }
      setIsWebFullscreenExpanded(false);
    }
    onSharePress(event);
  }, [onSharePress, isWebFullscreenExpanded]);

  const handleWebFullscreenDismiss = useCallback(
    (state: FullscreenReturnState) => {
      setIsWebFullscreenExpanded(false);
      setIsMuted(state.isMuted);
      setPlaybackSpeed(state.playbackSpeed);
      setCurrentTimeSafe(state.currentTime);
      currentTimeRef.current = state.currentTime;
      intendedPlayingRef.current = state.wasPlaying;
      pauseRequestedRef.current = false;
      syncPlaybackCache(true, { time: state.currentTime, wasPlaying: state.wasPlaying });

      if (Platform.OS === 'web' && videoRef.current) {
        try {
          videoRef.current.muted = state.isMuted;
          videoRef.current.playbackRate = state.playbackSpeed;
          videoRef.current.currentTime = state.currentTime;
          if (state.wasPlaying) {
            pauseOtherVideos(playbackIdRef.current);
            const playPromise = videoRef.current.play?.();
            if (playPromise?.catch) {
              playPromise.catch(() => undefined);
            }
            setIsPlayingSafe(true);
          } else {
            videoRef.current.pause?.();
            setIsPlayingSafe(false);
          }
        } catch (error) {
          logger.debug?.('VideoPlayer: failed to restore inline web playback', error);
        }
      }
    },
    [setCurrentTimeSafe, setIsPlayingSafe, syncPlaybackCache]
  );

  // Web fullscreen handled via modal to avoid browser fullscreen resets.

  const cyclePlaybackSpeed = useCallback(() => {
    setShowControlsVisible(true);
    const currentRate = playbackSpeed;
    const currentIndex = PLAYBACK_SPEEDS.findIndex((rate) => Math.abs(rate - currentRate) < 0.001);
    const fallbackIndex = Math.max(PLAYBACK_SPEEDS.indexOf(1), 0);
    const safeIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
    const nextRate = PLAYBACK_SPEEDS[(safeIndex + 1) % PLAYBACK_SPEEDS.length];

    applyPlaybackRate(nextRate);
    setPlaybackSpeed(nextRate);
  }, [applyPlaybackRate, playbackSpeed]);

  const ensureFullscreenSource = useCallback(async () => {
    let candidate = resolvedUriRef.current || uri;
    if (candidate && (candidate.startsWith('file://') || candidate.startsWith('content://'))) {
      return candidate;
    }

    try {
      const hint = candidate && candidate.startsWith('file://') ? candidate : undefined;
      const localUri = await chatCacheService.getMediaForDownload(uri, fileName, hint, 'high');
      if (localUri && (localUri.startsWith('file://') || localUri.startsWith('content://'))) {
        resolvedUriRef.current = localUri;
        setResolvedUri((prev) => (prev === localUri ? prev : localUri));
        onResolvedUriChange?.(localUri);
        if (cacheKeyRef.current) {
          patchVideoCacheEntry(cacheKeyRef.current, { resolvedUri: localUri });
        }
        return localUri;
      }
      return localUri || candidate;
    } catch (error) {
      logger.debug?.('VideoPlayer: ensureFullscreenSource failed', { uri, error });
      return candidate;
    }
  }, [fileName, onResolvedUriChange, setResolvedUri, uri]);

  const handleFullscreenPress = () => {
    if (Platform.OS === 'web') {
      if (isWebFullscreenExpanded) {
        // Exit native fullscreen
        try {
          const doc = document as any;
          const exitFn = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen;
          if (exitFn) {
            const p = exitFn.call(document);
            if (p?.catch) p.catch(() => undefined);
          }
        } catch { /* ignore */ }
        setIsWebFullscreenExpanded(false);
      } else {
        // Enter native browser fullscreen — bypasses all ancestor CSS transforms.
        // The same <video> element keeps playing; the browser promotes the container
        // to a fullscreen layer. No reload, no rebuffering.
        const container = webWrapperRef.current as HTMLElement | null;
        if (container) {
          try {
            const requestFn =
              (container as any).requestFullscreen ||
              (container as any).webkitRequestFullscreen ||
              (container as any).mozRequestFullScreen;
            if (requestFn) {
              const p = requestFn.call(container);
              if (p?.catch) p.catch(() => undefined);
            }
          } catch { /* ignore — fallback handled by state */ }
        }
        setIsWebFullscreenExpanded(true);
      }
      setShowControlsVisible(true);
      return;
    } else {
      setShowControlsVisible(true);
      if (isNativeFullscreenVisible) {
        return;
      }

      // Shared player approach: the inline player keeps playing as the modal opens.
      // expo-video allows the fullscreen VideoView to share the same player instance,
      // so there is no reload or rebuffering — transition is instant.
      setNativeFullscreenConfig({
        // sourceUri is still passed so the modal can fall back to own player if needed,
        // but it won't be loaded since sharedPlayer is provided.
        sourceUri: resolvedUri || uri,
        startTime: Number.isFinite(currentTime) ? currentTime : 0,
        isMuted,
        playbackSpeed,
        wasPlaying: isPlaying,
        posterUri: posterUri ?? undefined,
      });
    }
  };

  const handleNativeFullscreenDismiss = useCallback(
    (result?: FullscreenReturnState) => {
      pauseForFullscreenRef.current = false;
      setNativeFullscreenConfig(null);

      if (!result) {
        // Dismissed without state — read actual player state to sync UI
        setIsPlayingSafe(player.playing ?? false);
        return;
      }

      setIsMuted(result.isMuted);
      playbackRateSyncedRef.current = false;
      setPlaybackSpeed(result.playbackSpeed);

      const targetTime = Number.isFinite(result.currentTime) ? result.currentTime : 0;
      setCurrentTimeSafe(targetTime);

      // Shared player: the player is already in the correct state after the modal
      // dismissed. We only sync the UI state variables — no need to seek or replay.
      // The player was controlled by FullscreenVideoModal and is already playing/paused
      // at the right position.
      setIsPlayingSafe(result.wasPlaying);
    },
    [player, setCurrentTimeSafe, setIsPlayingSafe, setNativeFullscreenConfig]
  );

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (videoRef.current) {
        videoRef.current.playbackRate = playbackSpeed;
      }
      return;
    }

    const nativePlayer = player as unknown as {
      setRate?: (rate: number) => void;
      setPlaybackRate?: (rate: number) => void;
      playbackRate?: number;
      rate?: number;
    };

    try {
      if (typeof nativePlayer.setRate === 'function') {
        nativePlayer.setRate(playbackSpeed);
      } else if (typeof nativePlayer.setPlaybackRate === 'function') {
        nativePlayer.setPlaybackRate(playbackSpeed);
      } else if (typeof nativePlayer.playbackRate === 'number') {
        nativePlayer.playbackRate = playbackSpeed;
      } else if (typeof nativePlayer.rate === 'number') {
        nativePlayer.rate = playbackSpeed;
      }
    } catch (error) {
      logger.debug?.('VideoPlayer: failed to set playback speed', error);
    }
  }, [playbackSpeed, player]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    if (pendingPlayRequest && status === 'readyToPlay') {
      tryFulfillPendingPlay();
    }
  }, [pendingPlayRequest, status, tryFulfillPendingPlay]);

  useEffect(() => {
    if (Platform.OS !== 'web' && status === 'readyToPlay') {
      seekToInitialPosition();
    }
  }, [seekToInitialPosition, status]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    if (pendingRestoreRef.current && status === 'readyToPlay') {
      restoreFromBackground();
    }
  }, [restoreFromBackground, status]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const handleAppStateChange = (nextState: AppStateStatus) => {
      const previous = appStateRef.current;
      appStateRef.current = nextState;

        if (isNativeFullscreenVisible) {
          return;
        }

      if (nextState !== 'active') {
        backgroundSnapshotRef.current = {
          time: currentTimeRef.current,
          wasPlaying: isPlaying,
        };
        pendingRestoreRef.current = true;
        try {
          player.pause();
        } catch (error) {
          logger.debug?.('VideoPlayer: pause on background failed', error);
        }
        setIsPlayingSafe(false);
        return;
      }

      if (previous !== 'active' && pendingRestoreRef.current && status === 'readyToPlay') {
        restoreFromBackground();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove?.();
    };
  }, [isNativeFullscreenVisible, isPlaying, player, restoreFromBackground, setIsPlayingSafe, status]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    if (!nativePlaying && pauseForFullscreenRef.current) {
      return;
    }
    setIsPlayingSafe(!!nativePlaying);
  }, [nativePlaying, setIsPlayingSafe]);

  useEffect(() => {
    if (isPlaying) {
      pauseOtherVideos(playbackIdRef.current);
    }
  }, [isPlaying]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setCurrentTimeSafe(timeUpdate?.currentTime ?? 0);
    }
  }, [setCurrentTimeSafe, timeUpdate?.currentTime]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      const nativeDuration = player.duration || 0;
      if (nativeDuration > 0) {
        setDurationSafe(nativeDuration);
        updateDuration(nativeDuration);
        if (cacheKeyRef.current) {
          patchVideoCacheEntry(cacheKeyRef.current, { loadedOnce: true });
        }
      }

      if (status === 'loading' && nativeDuration > 0) {
        setIsLoadingSafe(false);
      } else {
        setIsLoadingSafe(status === 'loading');
      }
    }
  }, [player, setDurationSafe, setIsLoadingSafe, status, updateDuration]);

  useEffect(() => {
    if (Platform.OS !== 'web') player.muted = isMuted;
  }, [isMuted, player]);

  useEffect(() => {
    if (isPlaying) {
      return;
    }
    const key = cacheKeyRef.current;
    if (!key) {
      return;
    }
    const finalUri = resolvedUriRef.current || uri;
    if (!finalUri) {
      return;
    }
    patchVideoCacheEntry(key, {
      resolvedUri: finalUri,
      lastPosition: currentTimeRef.current,
    });
  }, [isPlaying, uri]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    syncPlaybackCache(false);
  }, [currentTime, isPlaying, syncPlaybackCache]);

  useEffect(() => {
    return () => {
      if (pendingCacheSyncRef.current != null) {
        clearTimeout(pendingCacheSyncRef.current as unknown as number);
        pendingCacheSyncRef.current = null;
      }
      const key = cacheKeyRef.current;
      if (!key) {
        return;
      }
      const finalUri = resolvedUriRef.current || uri;
      if (!finalUri) {
        return;
      }
      patchVideoCacheEntry(key, {
        resolvedUri: finalUri,
        duration: durationRef.current ?? null,
        lastPosition: currentTimeRef.current,
        lastKnownTime: currentTimeRef.current,
        lastKnownWasPlaying: intendedPlayingRef.current,
      });
    };
  }, [uri]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const barAnimation = Platform.OS === 'android' ? 'fade' : 'fade';
    try {
      StatusBar.setHidden(isNativeFullscreenVisible, barAnimation);
    } catch (error) {
      logger.debug?.('VideoPlayer: status bar toggle failed', error);
    }

    return () => {
      try {
        StatusBar.setHidden(false, barAnimation);
      } catch (error) {
        logger.debug?.('VideoPlayer: status bar reset failed', error);
      }
    };
  }, [isNativeFullscreenVisible]);

  // Lock page scroll when web fullscreen is active so the underlying chat list
  // doesn't scroll behind the fullscreen video.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }
    if (isWebFullscreenExpanded) {
      const prevOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prevOverflow;
      };
    }
  }, [isWebFullscreenExpanded]);

  // Sync isWebFullscreenExpanded with the browser's native fullscreen state.
  // When the user presses Escape (which the browser handles automatically), or
  // when fullscreen is exited by any other means, update React state accordingly.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }
    const onFsChange = () => {
      const doc = document as any;
      const fsElement =
        doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement;
      if (!fsElement) {
        // Browser exited fullscreen (e.g. user pressed Escape)
        setIsWebFullscreenExpanded(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange as EventListener);
    document.addEventListener('mozfullscreenchange', onFsChange as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange as EventListener);
      document.removeEventListener('mozfullscreenchange', onFsChange as EventListener);
    };
  }, []); // Stable — setIsWebFullscreenExpanded is stable from useState

  const effectiveDuration =
    Platform.OS === 'web'
      ? duration || durationRef.current || 0
      : player.duration || duration || durationRef.current || 0;

  // ─── Progress bar gesture handling (useVideoProgressBar hook) ─────────────
  const {
    progressBarRef,
    handleLayout: handleProgressBarLayout,
    panResponder: progressPanResponder,
  } = useVideoProgressBar({
    duration: effectiveDuration,
    onScrubChange: (time) => {
      setShowControlsVisible(true);
      setCurrentTimeSafe(time);
    },
    onScrubCommit: (time) => {
      currentTimeRef.current = time;
      setCurrentTimeSafe(time);
      setShowControlsVisible(true);
      if (Platform.OS === 'web' && videoRef.current) {
        videoRef.current.currentTime = time;
      } else if (Platform.OS !== 'web') {
        try { player.currentTime = time; } catch {}
      }
      syncPlaybackCache(true, { time, wasPlaying: intendedPlayingRef.current });
    },
    onDragStart: () => setIsDraggingProgress(true),
    onDragEnd: () => setIsDraggingProgress(false),
  });
  // ──────────────────────────────────────────────────────────────────────────

  // ─── Media Session API — notification panel play/pause/seek support ───────
  const msOnPlay = useCallback(() => {
    if (!videoRef.current) return;
    pauseOtherVideos(playbackIdRef.current);
    videoRef.current.play().catch(() => undefined);
    intendedPlayingRef.current = true;
    setIsPlayingSafe(true);
  }, [pauseOtherVideos, setIsPlayingSafe]);

  const msOnPause = useCallback(() => {
    if (!videoRef.current) return;
    pauseRequestedRef.current = true;
    videoRef.current.pause();
    intendedPlayingRef.current = false;
    setIsPlayingSafe(false);
    syncPlaybackCache(true, { time: currentTimeRef.current, wasPlaying: false });
  }, [setIsPlayingSafe, syncPlaybackCache]);

  const msOnStop = useCallback(() => {
    if (!videoRef.current) return;
    pauseRequestedRef.current = true;
    videoRef.current.pause();
    videoRef.current.currentTime = 0;
    intendedPlayingRef.current = false;
    setIsPlayingSafe(false);
    syncPlaybackCache(true, { time: 0, wasPlaying: false });
  }, [setIsPlayingSafe, syncPlaybackCache]);

  const msOnSeekBackward = useCallback((offset: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - offset);
  }, []);

  const msOnSeekForward = useCallback((offset: number) => {
    if (!videoRef.current) return;
    const dur = videoRef.current.duration || 0;
    videoRef.current.currentTime = Math.min(dur, videoRef.current.currentTime + offset);
  }, []);

  const msOnSeekTo = useCallback((time: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = time;
  }, []);

  useMediaSession({
    isPlaying,
    title: fileName ? fileName.replace(/\.[^.]+$/, '') : null,
    duration: effectiveDuration,
    currentTime,
    playbackRate: playbackSpeed,
    onPlay: msOnPlay,
    onPause: msOnPause,
    onStop: msOnStop,
    onSeekBackward: msOnSeekBackward,
    onSeekForward: msOnSeekForward,
    onSeekTo: msOnSeekTo,
  });
  // ─────────────────────────────────────────────────────────────────────────

  // Centralize playback UX state so inline/fullscreen overlays stay in sync across platforms.
  const playbackUxState = useVideoPlaybackUxState({
    status: Platform.OS === 'web' ? webStatus : status,
    isLoading: isLoading || resolving,
    isPlaying,
    intendedPlaying: intendedPlayingRef.current,
    duration: effectiveDuration,
    currentTime,
    bufferedPosition:
      Platform.OS === 'web' ? null : timeUpdate?.bufferedPosition ?? player.bufferedPosition ?? null,
    bufferedPercentOverride: Platform.OS === 'web' ? webBufferedPercent : null,
    isSeeking: isDraggingProgress,
    hasResolvedUri: !!resolvedUri,
    error: Platform.OS === 'web' ? webPlaybackError : statusError?.message ?? null,
    ended: Platform.OS === 'web' ? webEnded : undefined,
    externalBuffering: Platform.OS === 'web' ? webIsBuffering : undefined,
    externalStalled: Platform.OS === 'web' ? webIsStalled : undefined,
    // 350ms enter delay on web: long enough to swallow brief 'waiting' events
    // during normal playback, short enough to feel responsive on slow connections.
    bufferingDelayMs: Platform.OS === 'web' ? 350 : 150,
    bufferingExitDelayMs: 150,
    // Stall threshold: show the overlay after 4 s of stalled playback on web
    // (down from 8 s). Matches production-grade players (YouTube ~3-5 s).
    stallThresholdMs: Platform.OS === 'web' ? 4000 : 2000,
    // Buffer gap tolerance: show buffering once playhead is within 0.3 s of
    // the buffer edge (was 0.5 s — tighter to catch real stalls sooner).
    bufferGapSeconds: Platform.OS === 'web' ? 0.3 : 0.3,
  });

  const progressPercentage =
    effectiveDuration > 0 && Number.isFinite(currentTime)
      ? Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100))
      : 0;
  const bufferedPercentage = Math.min(
    100,
    Math.max(progressPercentage, playbackUxState.bufferedPercent ?? 0)
  );

  // Only lock controls during initial loading — not during errors.
  // The error overlay (VideoBufferingOverlay / codec fallback overlays) handles the
  // error UX; keeping controls visible lets the user close fullscreen or retry.
  const shouldLockControls = playbackUxState.isInitialLoading;
  const shouldShowControls = showControlsProp && showControlsVisible && !shouldLockControls;
  const disableSpeedControl = (playbackUxState.isInitialLoading || playbackUxState.isError) || !resolvedUri;
  const formattedProgressLabel = useMemo(() => {
    return `${formatTime(currentTime)} / ${formatTime(effectiveDuration)}`;
  }, [currentTime, effectiveDuration]);
  const seekHint = useMemo(
    () => formatSeekHint(seekStepSeconds ?? SEEK_STEP_SECONDS),
    [seekStepSeconds]
  );

  const seekGestureEnabled =
    !shouldLockControls && !playbackUxState.isBuffering && !playbackUxState.isStalled && !isDraggingProgress;
  const { overlayState, overlayAnimatedStyle, handleSeekTap, handleKeyboardSeek, handleAccessibilityAction } =
    useSeekGesture({
      enabled: seekGestureEnabled,
      stepSeconds: seekStepSeconds,
      onSingleTap: handleSingleTap,
      onSeekBySeconds: seekBySeconds,
    });

  useEffect(() => {
    readyOpacity.value = 0;
  }, [readyOpacity, resolvedUri]);

  useEffect(() => {
    if (playbackUxState.isReady) {
      readyOpacity.value = withTiming(1, { duration: 160 });
    }
  }, [playbackUxState.isReady, readyOpacity]);

  const readyAnimatedStyle = useAnimatedStyle(() => ({
    opacity: readyOpacity.value,
    transform: [{ scale: 0.985 + 0.015 * readyOpacity.value }],
  }));

  // The ready fade-in is now handled by a CSS transition on a <div> cover overlay (web only).
  // The cover starts opaque and transitions to transparent when playbackUxState.isReady becomes true.
  // This avoids any Reanimated compositing layer on the video surface, fixing Chrome Android black screen.

  useEffect(() => {
    // useNativeDriver is not supported on web — use JS-based animation there
    const nativeDriver = Platform.OS !== 'web';
    Animated.parallel([
      Animated.timing(controlsOpacity, {
        toValue: shouldShowControls ? 1 : 0,
        duration: shouldShowControls ? 180 : 140,
        useNativeDriver: nativeDriver,
      }),
      Animated.spring(controlsScale, {
        toValue: shouldShowControls ? 1 : 0.98,
        speed: 18,
        bounciness: 4,
        useNativeDriver: nativeDriver,
      }),
    ]).start();
  }, [controlsOpacity, controlsScale, shouldShowControls]);

  useEffect(() => {
    if (!playbackUxState.isReady || playbackUxState.isBuffering || playbackUxState.isStalled) {
      return;
    }
    // Never auto-resume if the video has ended — user must press Replay explicitly.
    if (playbackUxState.isEnded) {
      return;
    }
    if (!intendedPlayingRef.current || isPlaying) {
      return;
    }
    const now = Date.now();
    if (now - lastResumeAttemptRef.current < 900) {
      return;
    }
    lastResumeAttemptRef.current = now;

    if (Platform.OS === 'web' && videoRef.current) {
      try {
        const playPromise = videoRef.current.play?.();
        if (playPromise?.catch) {
          playPromise.catch(() => undefined);
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: resume after buffering failed', error);
      }
      return;
    }

    try {
      player.play();
    } catch (error) {
      logger.debug?.('VideoPlayer: resume after buffering failed', error);
    }
  }, [isPlaying, playbackUxState.isBuffering, playbackUxState.isReady, playbackUxState.isStalled, player]);

  const handleKeyboardShortcut = useCallback(
    (event: any) => {
      if (Platform.OS !== 'web') {
        return false;
      }

      if (event?.defaultPrevented) {
        return false;
      }

      if (event?.metaKey || event?.ctrlKey || event?.altKey) {
        return false;
      }

      if (isKeyboardEventFromEditable(event)) {
        return false;
      }

      const key = event?.key;
      const code = event?.code;
      const lower = typeof key === 'string' ? key.toLowerCase() : '';

      const markHandled = () => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        clearWebSelection();
        setShowControlsVisible(true);
      };

      if (key === 'ArrowLeft' || lower === 'j') {
        markHandled();
        handleKeyboardSeek('backward');
        return true;
      }

      if (key === 'ArrowRight' || lower === 'l') {
        markHandled();
        handleKeyboardSeek('forward');
        return true;
      }

      const isSpace = code === 'Space' || key === ' ' || key === 'Spacebar';
      if (isSpace || lower === 'k') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        markHandled();
        togglePlayPause();
        return true;
      }

      if (lower === 'm') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        markHandled();
        toggleMute();
        return true;
      }

      if (lower === 'f') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        markHandled();
        handleFullscreenPress();
        return true;
      }

      if (key === 'Escape') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        if (isWebFullscreenExpanded) {
          markHandled();
          // Call browser exit fullscreen (also triggers fullscreenchange → state sync)
          try {
            const doc = document as any;
            const exitFn = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen;
            if (exitFn) {
              const p = exitFn.call(document);
              if (p?.catch) p.catch(() => undefined);
            }
          } catch { /* ignore */ }
          setIsWebFullscreenExpanded(false);
        }
        return true;
      }

      return false;
    },
    [handleFullscreenPress, handleKeyboardSeek, toggleMute, togglePlayPause]
  );

  const webFocusStyle = useMemo(
    () =>
      Platform.OS === 'web'
        ? ({ outline: 'none', caretColor: 'transparent', WebkitTapHighlightColor: 'transparent' } as any)
        : null,
    []
  );

  const handleWebFocus = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }
    try {
      document.documentElement?.setAttribute('data-tm-video-focus', 'true');
      document.body?.setAttribute('data-tm-video-focus', 'true');
    } catch {
      // ignore
    }
    clearWebSelection();
  }, []);

  const handleWebBlur = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }
    try {
      document.documentElement?.removeAttribute('data-tm-video-focus');
      document.body?.removeAttribute('data-tm-video-focus');
    } catch {
      // ignore
    }
  }, []);

  const webWrapperRef = useRef<any>(null);
  const webKeyboardActiveRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const container = webWrapperRef.current as Node | null;
      const isInside = !!(container && target && (container as any).contains?.(target));

      if (isInside) {
        webKeyboardActiveRef.current = true;
        handleWebFocus();
      } else {
        webKeyboardActiveRef.current = false;
        handleWebBlur();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [handleWebBlur, handleWebFocus]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return;
    }

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (!webKeyboardActiveRef.current) {
        return;
      }
      handleKeyboardShortcut(event);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
    };
  }, [handleKeyboardShortcut]);

  const handleKeyDown = useCallback(
    (event: any) => {
      if (handleKeyboardShortcut(event)) {
        clearWebSelection();
      }
    },
    [handleKeyboardShortcut]
  );

  const renderSeekGestureLayer = (variant: 'inline' | 'fullscreen' = 'inline') => (
    <View
      style={styles.seekGestureLayer}
      // When a permanent codec error is shown, disable the seek gesture layer entirely
      // so touches fall through to the Download link in the error overlay beneath it.
      pointerEvents={codecFallbackError ? 'none' : 'box-none'}
    >
      <Pressable
        style={[styles.seekZone, styles.seekZoneLeft]}
        onPress={() => handleSeekTap('backward')}
        accessible={false}
      />
      <Pressable
        style={[styles.seekZone, styles.seekZoneRight]}
        onPress={() => handleSeekTap('forward')}
        accessible={false}
      />
      <SeekOverlay state={overlayState} animatedStyle={overlayAnimatedStyle} variant={variant} />
    </View>
  );

  const renderWebVideo = () => {
    // ── Error state: h265 unsupported + no transcodedUri (Requirement 5.5) ──
    // The fallback hook transitions to 'error' phase on mount when codec is
    // unsupported and no transcoded copy is available. Render the error message
    // and do NOT create any <video> element.
    const isProactiveCodecError =
      codecFallbackPhase === 'error' &&
      !effectiveTranscodedUri &&
      webResolvedUri === '' &&
      !codecFallbackError; // permanent error set later for swap-target failures

    if (isProactiveCodecError) {
      return (
        <View
          style={[styles.videoContainer, { height: maxHeight }]}
          accessibilityRole="none"
          accessibilityLabel="Video unavailable"
        >
          <View style={styles.inlineVideoSurface}>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <Text style={{ color: theme.textSecondary, textAlign: 'center', fontSize: 14 }}>
                Video format not supported
              </Text>
              <Text style={{ color: theme.textSecondary, textAlign: 'center', fontSize: 12, marginTop: 8 }}>
                {"This video's format can't play in this browser. Try opening it in another browser or download it."}
              </Text>
            </View>
          </View>
        </View>
      );
    }

    return (
      <View
        ref={webWrapperRef}
        style={
          isWebFullscreenExpanded
            ? [styles.webFullscreenVideoWrapper, webFocusStyle]
            : [styles.videoContainer, { height: maxHeight }, webFocusStyle]
        }
        accessibilityRole="adjustable"
        accessibilityLabel="Video player"
        accessibilityHint={seekHint}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={handleAccessibilityAction}
        {...(Platform.OS === 'web'
          ? ({
              onKeyDown: handleKeyDown,
              onFocus: handleWebFocus,
              onBlur: handleWebBlur,
              onMouseDown: (event: any) => event.preventDefault?.(),
              tabIndex: -1,
              dataSet: { tmVideoPlayer: 'true' },
            } as any)
          : {})}
      >
        <View style={isWebFullscreenExpanded ? styles.fullscreenVideoSurface : styles.inlineVideoSurface}>
          {/* The <video> element is created and managed by useWebVideoPlayer via webVideoRef.
              We render an empty container element and attach the ref so React sees the node.
              useWebVideoPlayer sets el.src internally — we NEVER set src here directly.
              This ensures the original `uri` is never assigned when h265 is unsupported. */}
          <video
            ref={webVideoRef as React.RefObject<HTMLVideoElement>}
            style={{
              width: '100%',
              height: '100%',
              outline: 'none',
              objectFit: 'contain',
              // NOTE: do NOT set backgroundColor on the <video> element itself.
              // Mobile Chrome paints the background color OVER decoded video frames
              // (compositor z-order bug) causing a black surface while audio plays.
              // The black background lives on the wrapping container instead.
            } as any}
            onMouseDown={(event) => event.preventDefault?.()}
            muted={isMuted}
            playsInline
            preload="auto"
            crossOrigin="anonymous"
            {...(posterUri ? { poster: posterUri } : {})}
            disableRemotePlayback
            tabIndex={-1}
          />
        </View>

        {/* Codec fallback: spinner overlay (requesting / polling phase) */}
        {codecFallbackSpinnerVisible ? (
          <View
            style={{
              ...StyleSheet.absoluteFillObject,
              backgroundColor: 'rgba(0,0,0,0.72)',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            }}
            pointerEvents="box-none"
          >
            <ActivityIndicator size="small" color="white" />
            <Text style={{ color: 'white', textAlign: 'center', fontSize: 14, fontWeight: '500' }}>
              {codecFallbackPhase === 'polling'
                ? 'Converting for your browser…'
                : 'Loading compatible format…'}
            </Text>
            {codecFallbackPhase === 'polling' ? (
              <Text style={{ color: 'rgba(255,255,255,0.55)', textAlign: 'center', fontSize: 12 }}>
                First-time conversion may take a moment
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Codec fallback: timeout — show message + retry button */}
        {codecFallbackTimeout && !codecFallbackSpinnerVisible ? (
          <View
            style={{
              ...StyleSheet.absoluteFillObject,
              backgroundColor: 'rgba(0,0,0,0.72)',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}
          >
            <Text style={{ color: 'white', textAlign: 'center', fontSize: 14, marginBottom: 16 }}>
              Video is still processing. Try again in a moment.
            </Text>
            <TouchableOpacity
              onPress={() => {
                setCodecFallbackTimeout(false);
                retryCodecFallback();
              }}
              style={{
                backgroundColor: theme.primary ?? '#4A90E2',
                paddingHorizontal: 20,
                paddingVertical: 10,
                borderRadius: 6,
              }}
              accessibilityRole="button"
              accessibilityLabel="Retry video processing"
            >
              <Text style={{ color: 'white', fontSize: 14, fontWeight: '600' }}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* Codec fallback: permanent error (swap-target also failed) */}
        {codecFallbackError && !codecFallbackSpinnerVisible && !codecFallbackTimeout ? (
          <View
            style={{
              ...StyleSheet.absoluteFillObject,
              backgroundColor: 'rgba(0,0,0,0.72)',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}
          >
            <Text style={{ color: 'white', textAlign: 'center', fontSize: 14 }}>
              {codecFallbackError}
            </Text>
            {onDownload ? (
              <TouchableOpacity
                onPress={isDownloading ? undefined : onDownload}
                disabled={isDownloading}
                style={{ marginTop: 12 }}
                accessibilityRole="button"
                accessibilityLabel={downloadButtonA11yLabel}
              >
                <Text style={{ color: theme.primary ?? '#4A90E2', fontSize: 13 }}>
                  {isDownloading ? resolveProgressPercentText(normalizedProgress) : 'Download'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        {renderSeekGestureLayer(isWebFullscreenExpanded ? 'fullscreen' : 'inline')}
        {renderPlaybackOverlay()}
        {renderControlsOverlay()}
      </View>
    );
  };

  const renderPlaybackOverlay = () => {
    const overlayPhase =
      playbackUxState.phase === 'ready' || playbackUxState.phase === 'idle'
        ? 'loading'
        : playbackUxState.phase;
    const showPoster =
      !!posterUri && (playbackUxState.isInitialLoading || playbackUxState.isBuffering || playbackUxState.isStalled);

    // On web: suppress the loading/buffering overlay once the video has actually started.
    // The UX state machine can lag behind the real video state, keeping the overlay visible
    // even while video is playing. Trust the actual playback state instead.
    const videoActuallyPlaying = Platform.OS === 'web' && (isPlaying || currentTime > 0);
    // Suppress overlays when video is visibly playing. Mobile Chrome fires the
    // 'waiting' event frequently during normal playback of large files, causing
    // false-positive buffering overlays on top of running video.
    const suppressOverlay = videoActuallyPlaying && (
      playbackUxState.phase === 'loading' ||
      playbackUxState.isInitialLoading ||
      (playbackUxState.isBuffering && isPlaying)
    );

    // Custom messaging for unsupported video codec (e.g. HEVC on Android browsers).
    // When useVideoCodecFallback is active (swapping/polling/requesting), suppress this
    // overlay — the fallback hook handles the UX (spinner, error message, retry button).
    const codecFallbackActive = Platform.OS === 'web' && (
      codecFallbackPhase === 'swapping' ||
      codecFallbackPhase === 'requesting' ||
      codecFallbackPhase === 'polling' ||
      codecFallbackPhase === 'done' ||
      codecFallbackSpinnerVisible
    );
    const isUnsupportedCodec =
      Platform.OS === 'web' &&
      webPlaybackError === 'unsupported-codec' &&
      !codecFallbackActive;
    const overlayTitle = isUnsupportedCodec ? 'Video format not supported' : playbackUxState.statusLabel;
    const overlaySubtitle = isUnsupportedCodec
      ? "This video's format can't play in this browser. Try opening it in another browser or download it."
      : playbackUxState.statusDetail;

    return (
      <>
        {showPoster && !videoActuallyPlaying ? (
          <Image
            source={{ uri: posterUri as string }}
            style={styles.bufferingPoster}
            resizeMode="cover"
            blurRadius={Platform.OS === 'web' ? 0 : 8}
          />
        ) : null}
        <VideoBufferingOverlay
          visible={
            // Never show while the video is actually playing.
            suppressOverlay
              ? false
              // Suppress whenever the codec-fallback system is rendering its own overlay:
              //   • spinner — "Converting for your browser…" / "Loading compatible format…"
              //   • timeout — "Video is still processing. Try again in a moment."
              //   • permanent error — "Video playback failed." / "format not supported"
              //   • requesting/polling — brief transition before the spinner appears
              //   • error phase — disabled-transcode permanent error or swap-target failure
              // The check is NOT limited to playbackUxState.isError — the codec fallback
              // overlays also appear during initial loading (isLoading=true, isError=false),
              // and the buffering overlay must not cover them in that window.
              : Platform.OS === 'web' && (
                  codecFallbackSpinnerVisible ||
                  codecFallbackTimeout ||
                  codecFallbackError != null ||
                  codecFallbackPhase === 'requesting' ||
                  codecFallbackPhase === 'polling' ||
                  codecFallbackPhase === 'error' ||
                  (playbackUxState.isError && codecFallbackActive)
                )
              ? false
              : playbackUxState.showOverlay
          }
          phase={overlayPhase}
          title={overlayTitle}
          subtitle={overlaySubtitle}
          bufferedPercent={playbackUxState.bufferedPercent}
          accentColor={theme.primary}
          variant="inline"
          showSpinner={isUnsupportedCodec ? false : playbackUxState.showSpinner}
          showPercent={isUnsupportedCodec ? false : playbackUxState.showPercent}
          onRetry={playbackUxState.isError && !isUnsupportedCodec ? handleRetry : undefined}
          onReplay={undefined}
        />
      </>
    );
  };

  const renderControlsOverlay = () => {
    if (!showControlsProp) {
      return null;
    }
    const overlayPointerEvents = shouldShowControls ? 'box-none' : 'none';
    const overlayAnimatedStyle = {
      opacity: controlsOpacity,
      transform: [{ scale: controlsScale }],
    };

    if (isMinimalControls) {
      return (
        <MinimalControls
          isPlaying={isPlaying}
          overlayAnimatedStyle={overlayAnimatedStyle}
          overlayPointerEvents={overlayPointerEvents}
          onTogglePlayPause={togglePlayPause}
        />
      );
    }

    return (
      <FullControls
        isPlaying={isPlaying}
        isMuted={isMuted}
        isDownloading={isDownloading}
        isDraggingProgress={isDraggingProgress}
        isWebFullscreenActive={isWebFullscreenActive}
        disableSpeedControl={disableSpeedControl}
        formattedProgressLabel={formattedProgressLabel}
        progressPercentage={progressPercentage}
        bufferedPercentage={bufferedPercentage}
        playbackSpeedLabel={playbackSpeedLabel}
        normalizedProgress={normalizedProgress}
        downloadButtonA11yLabel={downloadButtonA11yLabel}
        shareButtonA11yLabel={shareButtonA11yLabel}
        overlayAnimatedStyle={overlayAnimatedStyle}
        overlayPointerEvents={overlayPointerEvents}
        progressBarRef={progressBarRef}
        progressPanResponder={progressPanResponder}
        handleProgressBarLayout={handleProgressBarLayout}
        onTogglePlayPause={togglePlayPause}
        onToggleMute={toggleMute}
        onDownload={onDownload}
        onSharePress={handleInlineSharePress}
        onFullscreenPress={handleFullscreenPress}
        onCyclePlaybackSpeed={cyclePlaybackSpeed}
        overlayStyle={isWebFullscreenExpanded ? styles.fullscreenOverlay : undefined}
        onCloseFullscreen={isWebFullscreenExpanded ? () => handleFullscreenPress() : undefined}
      />
    );
  };

  const renderNativeVideoSurface = () => (
    <View style={styles.inlineVideoWrapper}>
      <Reanimated.View style={[styles.inlineVideoSurface, readyAnimatedStyle]}>
        <VideoView
          ref={videoViewRef as any}
          style={StyleSheet.absoluteFillObject}
          player={player as unknown as any}
          nativeControls={false}
          allowsPictureInPicture
          allowsFullscreen
          contentFit="contain"
          {...(Platform.OS === 'android' ? { surfaceType: 'textureView' as const } : {})}
        />
      </Reanimated.View>
      {renderSeekGestureLayer()}
      {renderPlaybackOverlay()}
      {renderControlsOverlay()}
    </View>
  );

  const renderMobileVideo = () => (
    <>
      <View
        style={[
          styles.videoContainer,
          { height: maxHeight },
          isNativeFullscreenVisible ? styles.hiddenInlineWhileFullscreen : null,
        ]}
        accessibilityRole="adjustable"
        accessibilityLabel="Video player"
        accessibilityHint={seekHint}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={handleAccessibilityAction}
      >
        {renderNativeVideoSurface()}
      </View>

      {nativeFullscreenConfig ? (
        <FullscreenVideoModal
          key={`${nativeFullscreenConfig.sourceUri}-${nativeFullscreenConfig.startTime}`}
          config={nativeFullscreenConfig}
          onDismiss={handleNativeFullscreenDismiss}
          onSharePress={onSharePress}
          onDownload={onDownload}
          seekStepSeconds={seekStepSeconds}
          isDownloading={isDownloading}
          downloadProgress={downloadProgress}
          sharedPlayer={player}
        />
      ) : null}
    </>
  );

  return (
    <>
      {Platform.OS === 'web' ? renderWebVideo() : renderMobileVideo()}
      {/* WebFullscreenModal is no longer rendered — CSS-based fullscreen uses the same
          inline <video> element with position:fixed, eliminating rebuffering entirely. */}
    </>
  );
}

function FullscreenVideoModal({
  config,
  onDismiss,
  onSharePress,
  onDownload,
  seekStepSeconds,
  isDownloading = false,
  downloadProgress,
  sharedPlayer,
}: FullscreenVideoModalProps) {
  const { theme } = useTheme();
  const { sourceUri, startTime, isMuted: initialMuted, playbackSpeed: initialSpeed, wasPlaying } = config;

  const [isPlaying, setIsPlaying] = useState(wasPlaying);
  const [isMuted, setIsMuted] = useState(initialMuted);
  const [playbackSpeed, setPlaybackSpeed] = useState(initialSpeed);
  const [currentTime, setCurrentTime] = useState(startTime);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [isDraggingProgress, setIsDraggingProgress] = useState(false);

  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const progressBarRef = useRef<View>(null);
  const progressBarWidthRef = useRef(1);
  const progressBarPageXRef = useRef<number | null>(null);
  const playbackIdRef = useRef<string>(createPlaybackId());
  // When using a shared player, the player is already at the correct position and
  // play state — skip the initial sync that would redundantly seek and play.
  const initialSyncDoneRef = useRef(!!sharedPlayer);
  const playbackRateSyncedRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState ?? 'active');
  const backgroundSnapshotRef = useRef<{ time: number; wasPlaying: boolean } | null>(null);
  const pendingRestoreRef = useRef(false);
  const intendedPlayingRef = useRef(wasPlaying);
  const readyOpacity = useSharedValue(0);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const controlsScale = useRef(new Animated.Value(1)).current;
  const lastResumeAttemptRef = useRef(0);

  const setIsPlayingSafe = useCallback((next: boolean) => {
    setIsPlaying((prev) => (prev === next ? prev : next));
  }, []);

  const setCurrentTimeSafe = useCallback((next: number) => {
    if (!Number.isFinite(next)) {
      return;
    }
    setCurrentTime((prev) => (Math.abs(prev - next) < 1 / 60 ? prev : next));
  }, []);

  const setIsLoadingSafe = useCallback((next: boolean) => {
    setIsLoading((prev) => (prev === next ? prev : next));
  }, []);

  const setDurationSafe = useCallback((next: number) => {
    if (!Number.isFinite(next)) {
      return;
    }
    setDuration((prev) => (Math.abs(prev - next) < 1 / 60 ? prev : next));
  }, []);

  const playbackSpeedLabel = useMemo(() => {
    const rounded = Math.round(playbackSpeed * 100) / 100;
    const formatted = Number.isInteger(rounded)
      ? rounded.toFixed(0)
      : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${formatted}x`;
  }, [playbackSpeed]);
  const normalizedProgress = useEasedDownloadProgressPercent(
    downloadProgress,
    isDownloading
  );
  const downloadButtonA11yLabel = resolveDownloadProgressLabel(
    isDownloading,
    normalizedProgress,
    'Download video'
  );
  const shareButtonA11yLabel = 'Share video';

  // Create an own player as a fallback when no sharedPlayer is provided.
  // When sharedPlayer IS provided, we pass null as the source to create a dormant
  // (never-loaded) player — this satisfies the Rules of Hooks requirement (hooks
  // cannot be conditional) while consuming negligible resources.
  const ownPlayer = useVideoPlayer(sharedPlayer ? (null as unknown as { uri: string }) : { uri: sourceUri }, (p: ExpoVideoPlayer) => {
    if (sharedPlayer) {
      return; // Shared player already configured by the inline VideoPlayerLoaded
    }
    p.loop = false;
    p.muted = initialMuted;
    // More frequent time updates for a smoother progress bar (YouTube-level ~100ms)
    p.timeUpdateEventInterval = 0.1;
    p.preservesPitch = true;
    try {
      p.playbackRate = initialSpeed;
    } catch {}
  });

  // Use the shared player if provided; fall back to the own player.
  const player: ExpoVideoPlayer = (sharedPlayer ?? ownPlayer) as ExpoVideoPlayer;

  const pauseSelf = useCallback(() => {
    try {
      player.pause();
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: pause other video failed', error);
    }
    intendedPlayingRef.current = false;
    setIsPlayingSafe(false);
  }, [player, setIsPlayingSafe]);

  useEffect(() => registerPlaybackHandler(playbackIdRef.current, pauseSelf), [pauseSelf]);

  const { isPlaying: nativePlaying } = useEvent(player, 'playingChange', {
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
  const status = statusEvent?.status ?? player.status;
  const statusError = statusEvent?.error ?? null;
  const playbackRateChange = useEvent(player, 'playbackRateChange', {
    playbackRate: player.playbackRate ?? initialSpeed ?? 1,
  });

  const applyPlaybackRate = useCallback(
    (rate: number) => {
      if (!Number.isFinite(rate)) {
        return;
      }

      try {
        player.preservesPitch = true;
      } catch {}

      try {
        player.playbackRate = rate;
        return;
      } catch (error) {
        const nativePlayer = player as unknown as {
          setRate?: (value: number) => void;
          setPlaybackRate?: (value: number) => void;
          rate?: number;
        };

        try {
          if (typeof nativePlayer.setRate === 'function') {
            nativePlayer.setRate(rate);
            return;
          }
          if (typeof nativePlayer.setPlaybackRate === 'function') {
            nativePlayer.setPlaybackRate(rate);
            return;
          }
          if (typeof nativePlayer.rate === 'number') {
            nativePlayer.rate = rate;
            return;
          }
        } catch (fallbackError) {
          logger.debug?.('FullscreenVideoModal: fallback playback rate apply failed', fallbackError);
        }
      }
    },
    [player]
  );

  const restoreFromBackground = useCallback(() => {
    if (Platform.OS === 'web') {
      return;
    }
    const snapshot = backgroundSnapshotRef.current;
    if (!snapshot) {
      return;
    }
    const targetTime = Number.isFinite(snapshot.time) ? snapshot.time : 0;
    try {
      player.currentTime = targetTime;
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: restore time failed', error);
    }
    setCurrentTimeSafe(targetTime);

    if (snapshot.wasPlaying) {
      try {
        pauseOtherVideos(playbackIdRef.current);
        player.play();
        setIsPlayingSafe(true);
        intendedPlayingRef.current = true;
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: resume after background failed', error);
        setIsPlayingSafe(false);
        intendedPlayingRef.current = false;
      }
    }

    backgroundSnapshotRef.current = null;
    pendingRestoreRef.current = false;
  }, [player, setCurrentTimeSafe, setIsPlayingSafe]);

  useEffect(() => {
    initialSyncDoneRef.current = false;
    playbackRateSyncedRef.current = false;
    setIsPlayingSafe(wasPlaying);
    setIsMuted(initialMuted);
    setPlaybackSpeed(initialSpeed);
    setCurrentTimeSafe(startTime);
    setShowControls(true);
    intendedPlayingRef.current = wasPlaying;
    readyOpacity.value = 0;
  }, [initialMuted, initialSpeed, readyOpacity, setCurrentTimeSafe, setIsPlayingSafe, sourceUri, startTime, wasPlaying]);

  useEffect(() => {
    applyPlaybackRate(playbackSpeed);
    if (!playbackRateSyncedRef.current) {
      playbackRateSyncedRef.current = true;
    }
  }, [applyPlaybackRate, playbackSpeed]);

  useEffect(() => {
    const current = playbackRateChange.playbackRate;
    if (!playbackRateSyncedRef.current) {
      return;
    }
    if (typeof current === 'number' && Number.isFinite(current)) {
      setPlaybackSpeed((prev) => (Math.abs(prev - current) < 0.001 ? prev : current));
    }
  }, [playbackRateChange.playbackRate]);

  useEffect(() => {
    player.muted = isMuted;
  }, [isMuted, player]);

  useEffect(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }

    if (showControls && isPlaying && !isDraggingProgress) {
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000) as unknown as NodeJS.Timeout;
    }

    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    };
  }, [showControls, isPlaying, isDraggingProgress]);

  useEffect(() => {
    if (status === 'loading') {
      setIsLoadingSafe(true);
      return;
    }

    if (status === 'readyToPlay') {
      setIsLoadingSafe(false);

      const nativeDuration = player.duration || 0;
      if (nativeDuration > 0) {
        setDurationSafe(nativeDuration);
      }

      if (!initialSyncDoneRef.current) {
        const target = Number.isFinite(startTime) ? startTime : 0;
        try {
          player.currentTime = target;
        } catch (error) {
          logger.debug?.('FullscreenVideoModal: failed to resume position', error);
        }
        setCurrentTimeSafe(target);

        if (wasPlaying) {
          try {
            pauseOtherVideos(playbackIdRef.current);
            player.play();
            setIsPlayingSafe(true);
          } catch (error) {
            logger.debug?.('FullscreenVideoModal: autoplay rejected', error);
            setIsPlayingSafe(false);
          }
        } else {
          try {
            player.pause();
          } catch (error) {
            logger.debug?.('FullscreenVideoModal: pause after sync failed', error);
          }
          setIsPlayingSafe(false);
        }

        initialSyncDoneRef.current = true;
      }
    }
  }, [player, setCurrentTimeSafe, setDurationSafe, setIsLoadingSafe, setIsPlayingSafe, startTime, status, wasPlaying]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }
    if (pendingRestoreRef.current && status === 'readyToPlay') {
      restoreFromBackground();
    }
  }, [restoreFromBackground, status]);

  useEffect(() => {
    if (Platform.OS === 'web') {
      return;
    }

    const handleAppStateChange = (nextState: AppStateStatus) => {
      const previous = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState !== 'active') {
        backgroundSnapshotRef.current = {
          time: Number.isFinite(currentTime) ? currentTime : 0,
          wasPlaying: isPlaying,
        };
        pendingRestoreRef.current = true;
        try {
          player.pause();
        } catch (error) {
          logger.debug?.('FullscreenVideoModal: pause on background failed', error);
        }
        setIsPlayingSafe(false);
        return;
      }

      if (previous !== 'active' && pendingRestoreRef.current && status === 'readyToPlay') {
        restoreFromBackground();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove?.();
    };
  }, [currentTime, isPlaying, player, restoreFromBackground, setIsPlayingSafe, status]);

  useEffect(() => {
    setIsPlayingSafe(!!nativePlaying);
  }, [nativePlaying, setIsPlayingSafe]);

  useEffect(() => {
    if (isPlaying) {
      pauseOtherVideos(playbackIdRef.current);
    }
  }, [isPlaying]);

  useEffect(() => {
    if (typeof timeUpdate?.currentTime === 'number') {
      setCurrentTimeSafe(timeUpdate.currentTime);
    }
  }, [setCurrentTimeSafe, timeUpdate?.currentTime]);

  useEffect(() => () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    if (!sharedPlayer) {
      // Only pause when using the own player — the shared player stays under control
      // of VideoPlayerLoaded and should not be paused by this modal's cleanup.
      try {
        player.pause();
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: cleanup pause failed', error);
      }
    }
  }, [player, sharedPlayer]);

  const effectiveDuration = player.duration || duration || 0;
  const playbackUxState = useVideoPlaybackUxState({
    status,
    isLoading,
    isPlaying,
    intendedPlaying: intendedPlayingRef.current,
    duration: effectiveDuration,
    currentTime,
    bufferedPosition: timeUpdate?.bufferedPosition ?? player.bufferedPosition ?? null,
    isSeeking: isDraggingProgress,
    hasResolvedUri: true,
    error: statusError?.message ?? null,
    // Match the inline player's production-grade buffering thresholds
    bufferingDelayMs: 350,
    bufferingExitDelayMs: 150,
    stallThresholdMs: 4000,
    bufferGapSeconds: 0.4,
  });
  const progressPercentage =
    effectiveDuration > 0 && Number.isFinite(currentTime)
      ? Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100))
      : 0;
  const bufferedPercentage = useMemo(() => {
    if (!(effectiveDuration > 0)) {
      return 0;
    }
    const buffered = timeUpdate?.bufferedPosition ?? 0;
    if (!Number.isFinite(buffered) || buffered <= 0) {
      return 0;
    }
    return Math.min(100, Math.max(0, (buffered / effectiveDuration) * 100));
  }, [effectiveDuration, timeUpdate?.bufferedPosition]);

  const handleProgressBarLayout = useCallback(
    (event: LayoutChangeEvent) => {
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
    },
    []
  );

  const resolveLocationX = useCallback((evt: GestureResponderEvent) => {
    const { locationX, pageX } = evt.nativeEvent;
    if (typeof locationX === 'number' && Number.isFinite(locationX)) {
      return locationX;
    }
    if (
      typeof pageX === 'number' &&
      Number.isFinite(pageX) &&
      progressBarPageXRef.current != null &&
      Number.isFinite(progressBarPageXRef.current)
    ) {
      return pageX - (progressBarPageXRef.current as number);
    }
    return null;
  }, []);

  const calculateScrubProgress = useCallback((locationX: number | null) => {
    if (locationX == null) {
      return null;
    }
    const width = progressBarWidthRef.current;
    if (!Number.isFinite(width) || width <= 0) {
      return null;
    }
    const ratio = clamp(locationX / width, 0, 1);
    return ratio * 100;
  }, []);

  const applyScrubProgress = useCallback(
    (progressValue: number | null, commit: boolean) => {
      if (progressValue == null) {
        return;
      }

      const normalized = clamp(progressValue / 100, 0, 1);
      const baseDuration = effectiveDuration > 0 ? effectiveDuration : 0;
      const newTime = baseDuration * normalized;

      if (Number.isFinite(newTime)) {
        setCurrentTimeSafe(newTime);
      }

      if (!commit) {
        return;
      }

      try {
        player.currentTime = newTime;
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: native seek failed', error);
      }
    },
    [effectiveDuration, player, setCurrentTimeSafe]
  );

  const getProgressFromEvent = useCallback(
    (evt: GestureResponderEvent) => {
      const location = resolveLocationX(evt);
      return calculateScrubProgress(location);
    },
    [calculateScrubProgress, resolveLocationX]
  );

  const progressPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          setIsDraggingProgress(true);
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), false);
        },
        onPanResponderMove: (evt) => {
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), false);
        },
        onPanResponderRelease: (evt) => {
          setIsDraggingProgress(false);
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), true);
        },
        onPanResponderTerminate: (evt) => {
          setIsDraggingProgress(false);
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), true);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [applyScrubProgress, getProgressFromEvent]
  );

  const restartIfEnded = useCallback(() => {
    const epsilon = 0.35;
    if (!effectiveDuration || !Number.isFinite(effectiveDuration)) {
      return;
    }
    if (currentTime < effectiveDuration - epsilon) {
      return;
    }
    try {
      player.currentTime = 0;
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: failed to reset currentTime', error);
    }
    setCurrentTimeSafe(0);
  }, [currentTime, effectiveDuration, player, setCurrentTimeSafe]);

  const togglePlayPause = () => {
    if (isPlaying) {
      try {
        player.pause();
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: pause error', error);
      }
      setIsPlayingSafe(false);
      intendedPlayingRef.current = false;
    } else {
      restartIfEnded();
      try {
        pauseOtherVideos(playbackIdRef.current);
        player.play();
        setIsPlayingSafe(true);
        intendedPlayingRef.current = true;
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: play error', error);
        setIsPlayingSafe(false);
        intendedPlayingRef.current = false;
      }
    }
    setShowControls(true);
  };

  const toggleMute = () => {
    setIsMuted((prev) => !prev);
    setShowControls(true);
  };

  const handleSingleTap = useCallback(() => {
    setShowControls((visible) => !visible);
  }, []);

  const seekBySeconds = useCallback(
    (deltaSeconds: number) => {
      const durationSource = player.duration || duration || 0;
      if (!durationSource || !Number.isFinite(durationSource)) {
        return false;
      }

      const baseTime = Number.isFinite(currentTime) ? currentTime : 0;
      const nextTime = clamp(baseTime + deltaSeconds, 0, durationSource);
      if (!Number.isFinite(nextTime)) {
        return false;
      }

      try {
        player.currentTime = nextTime;
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: seek failed', error);
      }
      setCurrentTimeSafe(nextTime);
      return true;
    },
    [currentTime, duration, player, setCurrentTimeSafe]
  );

  const seekHint = useMemo(
    () => formatSeekHint(seekStepSeconds ?? SEEK_STEP_SECONDS),
    [seekStepSeconds]
  );

  // Don't hide controls on error — user needs close button and retry is in the overlay.
  const shouldLockControls = playbackUxState.isInitialLoading;
  const shouldShowControls = showControls && !shouldLockControls;
  const disableSpeedControl = playbackUxState.isInitialLoading || playbackUxState.isError;
  const formattedProgressLabel = useMemo(() => {
    return `${formatTime(currentTime)} / ${formatTime(effectiveDuration)}`;
  }, [currentTime, effectiveDuration]);

  const seekGestureEnabled =
    !shouldLockControls && !playbackUxState.isBuffering && !playbackUxState.isStalled && !isDraggingProgress;
  const { overlayState, overlayAnimatedStyle, handleSeekTap, handleAccessibilityAction } = useSeekGesture({
    enabled: seekGestureEnabled,
    stepSeconds: seekStepSeconds,
    onSingleTap: handleSingleTap,
    onSeekBySeconds: seekBySeconds,
  });

  useEffect(() => {
    if (playbackUxState.isReady) {
      readyOpacity.value = withTiming(1, { duration: 240 });
    }
  }, [playbackUxState.isReady, readyOpacity]);

  const readyAnimatedStyle = useAnimatedStyle(() => ({
    opacity: readyOpacity.value,
    transform: [{ scale: 0.985 + 0.015 * readyOpacity.value }],
  }));

  useEffect(() => {
    const nativeDriver = Platform.OS !== 'web';
    Animated.parallel([
      Animated.timing(controlsOpacity, {
        toValue: shouldShowControls ? 1 : 0,
        duration: shouldShowControls ? 180 : 140,
        useNativeDriver: nativeDriver,
      }),
      Animated.spring(controlsScale, {
        toValue: shouldShowControls ? 1 : 0.98,
        speed: 18,
        bounciness: 4,
        useNativeDriver: nativeDriver,
      }),
    ]).start();
  }, [controlsOpacity, controlsScale, shouldShowControls]);

  useEffect(() => {
    if (!playbackUxState.isReady || playbackUxState.isBuffering || playbackUxState.isStalled) {
      return;
    }
    if (!intendedPlayingRef.current || isPlaying) {
      return;
    }
    const now = Date.now();
    if (now - lastResumeAttemptRef.current < 900) {
      return;
    }
    lastResumeAttemptRef.current = now;
    try {
      player.play();
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: resume after buffering failed', error);
    }
  }, [isPlaying, playbackUxState.isBuffering, playbackUxState.isReady, playbackUxState.isStalled, player]);

  const renderSeekGestureLayer = () => (
    <View style={styles.seekGestureLayer} pointerEvents="box-none">
      <Pressable
        style={[styles.seekZone, styles.seekZoneLeft]}
        onPress={() => handleSeekTap('backward')}
        accessible={false}
      />
      <Pressable
        style={[styles.seekZone, styles.seekZoneRight]}
        onPress={() => handleSeekTap('forward')}
        accessible={false}
      />
      <SeekOverlay state={overlayState} animatedStyle={overlayAnimatedStyle} variant="fullscreen" />
    </View>
  );

  const cyclePlaybackSpeed = useCallback(() => {
    setShowControls(true);
    const currentRate = playbackSpeed;
    const currentIndex = PLAYBACK_SPEEDS.findIndex((rate) => Math.abs(rate - currentRate) < 0.001);
    const fallbackIndex = Math.max(PLAYBACK_SPEEDS.indexOf(1), 0);
    const safeIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
    const nextRate = PLAYBACK_SPEEDS[(safeIndex + 1) % PLAYBACK_SPEEDS.length];

    applyPlaybackRate(nextRate);
    setPlaybackSpeed(nextRate);
  }, [applyPlaybackRate, playbackSpeed]);

  const handleClose = useCallback(() => {
    if (!sharedPlayer) {
      // Only pause own player — shared player state is managed by VideoPlayerLoaded.
      try {
        player.pause();
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: pause on close failed', error);
      }
    }
    onDismiss({
      currentTime,
      isMuted,
      playbackSpeed,
      wasPlaying: isPlaying,
    });
  }, [currentTime, isMuted, isPlaying, onDismiss, playbackSpeed, player, sharedPlayer]);

  const handleShare = useCallback(() => {
    handleClose();
    setTimeout(() => {
      onSharePress();
    }, 0);
  }, [handleClose, onSharePress]);

  const handleClosePress = useCallback((event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
    handleClose();
  }, [handleClose]);

  const handleSharePress = useCallback((event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
    handleShare();
  }, [handleShare]);

  const handleDownloadPress = useCallback((event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
    onDownload?.();
  }, [onDownload]);

  const handleRetry = useCallback(() => {
    intendedPlayingRef.current = true;
    try {
      setIsLoadingSafe(true);
      const replace = (player as unknown as { replaceAsync?: (source: VideoSource) => Promise<void> }).replaceAsync;
      if (typeof replace === 'function') {
        void replace({ uri: sourceUri });
      } else {
        player.replace({ uri: sourceUri }, true);
      }
      player.play();
      setIsPlayingSafe(true);
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: retry failed', error);
    }
  }, [player, setIsLoadingSafe, setIsPlayingSafe, sourceUri]);

  const handleReplay = useCallback(() => {
    restartIfEnded();
    try {
      pauseOtherVideos(playbackIdRef.current);
      player.play();
      setIsPlayingSafe(true);
      intendedPlayingRef.current = true;
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: replay failed', error);
    }
  }, [player, restartIfEnded, setIsPlayingSafe]);

  const renderPlaybackOverlay = () => {
    const overlayPhase =
      playbackUxState.phase === 'ready' || playbackUxState.phase === 'idle'
        ? 'loading'
        : playbackUxState.phase;

    return (
      <VideoBufferingOverlay
        visible={playbackUxState.showOverlay}
        phase={overlayPhase}
        title={playbackUxState.statusLabel}
        subtitle={playbackUxState.statusDetail}
        bufferedPercent={playbackUxState.bufferedPercent}
        accentColor={theme.primary}
        variant="fullscreen"
        showSpinner={playbackUxState.showSpinner}
        showPercent={playbackUxState.showPercent}
        onRetry={playbackUxState.isError ? handleRetry : undefined}
        onReplay={playbackUxState.isEnded ? handleReplay : undefined}
      />
    );
  };

  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
      supportedOrientations={['portrait', 'landscape', 'landscape-left', 'landscape-right']}
      statusBarTranslucent
      hardwareAccelerated
    >
      <SafeAreaView style={styles.fullscreenModalRoot}>
        <View
          style={styles.fullscreenTouchable}
          accessibilityRole="adjustable"
          accessibilityLabel="Video player"
          accessibilityHint={seekHint}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={handleAccessibilityAction}
        >
          <View style={styles.fullscreenVideoWrapper}>
            {/* Poster image shown immediately while the fullscreen video loads — eliminates
                the blank black flash between pressing fullscreen and the first decoded frame. */}
            {config.posterUri && !playbackUxState.isReady ? (
              <Image
                source={{ uri: config.posterUri }}
                style={[StyleSheet.absoluteFillObject, { zIndex: 1 }]}
                resizeMode="cover"
              />
            ) : null}
            <Reanimated.View style={[styles.fullscreenVideoSurface, readyAnimatedStyle]}>
              <VideoView
                style={StyleSheet.absoluteFillObject}
                player={player as unknown as any}
                nativeControls={false}
                allowsPictureInPicture
                allowsFullscreen
                contentFit="contain"
                {...(Platform.OS === 'android' ? { surfaceType: 'textureView' as const } : {})}
              />
            </Reanimated.View>

            {renderSeekGestureLayer()}

            {renderPlaybackOverlay()}

            <Animated.View
              style={[
                styles.fullscreenOverlay,
                { opacity: controlsOpacity, transform: [{ scale: controlsScale }] },
              ]}
              pointerEvents={shouldShowControls ? 'box-none' : 'none'}
            >
              <View style={styles.fullscreenTopRow} pointerEvents="box-none">
                <TouchableOpacity
                  style={[styles.fullscreenControlButton, styles.fullscreenCloseButton]}
                  onPress={handleClosePress}
                >
                  <X size={20} color="white" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.fullscreenControlButton}
                  onPress={handleSharePress}
                  accessibilityRole="button"
                  accessibilityLabel={shareButtonA11yLabel}
                >
                  <Share2 size={20} color="white" />
                </TouchableOpacity>
              </View>

              <View style={styles.fullscreenMainControls} pointerEvents="box-none">
                <TouchableOpacity
                  style={[styles.fullscreenControlButton, styles.fullscreenPlayButton]}
                  onPress={togglePlayPause}
                >
                  {isPlaying ? <Pause size={32} color="white" /> : <Play size={32} color="white" />}
                </TouchableOpacity>
              </View>

              <View style={styles.fullscreenBottomControls} pointerEvents="box-none">
                <View style={styles.fullscreenProgressRow} pointerEvents="box-none">
                  <Text style={styles.fullscreenTimeText}>{formattedProgressLabel}</Text>

                  <View style={styles.fullscreenProgressContainer}>
                    <View
                      ref={progressBarRef}
                      collapsable={false}
                      style={styles.fullscreenProgressBarTouchable}
                      onLayout={handleProgressBarLayout}
                      {...progressPanResponder.panHandlers}
                    >
                      <View style={styles.fullscreenProgressBar}>
                        <View style={[styles.fullscreenProgressBuffered, { width: `${bufferedPercentage}%` }]} />
                        <View style={[styles.fullscreenProgressFill, { width: `${progressPercentage}%` }]} />
                        <View
                          style={[
                            styles.fullscreenProgressThumb,
                            {
                              left: `${progressPercentage}%`,
                              transform: [{ scale: isDraggingProgress ? 1.2 : 1 }],
                            },
                          ]}
                        />
                      </View>
                    </View>
                  </View>
                </View>

                <View style={styles.fullscreenActionsRow} pointerEvents="box-none">
                  <View style={styles.fullscreenActionsLeft} pointerEvents="box-none">
                    <TouchableOpacity style={styles.fullscreenControlButton} onPress={toggleMute}>
                      {isMuted ? <VolumeX size={20} color="white" /> : <Volume2 size={20} color="white" />}
                    </TouchableOpacity>

                    {onDownload ? (
                      <TouchableOpacity
                        style={[styles.fullscreenControlButton, isDownloading ? styles.controlButtonDisabled : null]}
                          onPress={handleDownloadPress}
                        disabled={isDownloading}
                        accessibilityRole="button"
                        accessibilityLabel={downloadButtonA11yLabel}
                      >
                        {isDownloading ? (
                          <Text style={styles.fullscreenDownloadProgressText}>
                            {resolveProgressPercentText(normalizedProgress)}
                          </Text>
                        ) : (
                          <Download size={20} color="white" />
                        )}
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  <View style={styles.fullscreenActionsRight} pointerEvents="box-none">
                    <TouchableOpacity
                      style={[
                        styles.fullscreenControlButton,
                        styles.fullscreenSpeedButton,
                        disableSpeedControl ? styles.fullscreenSpeedButtonDisabled : null,
                      ]}
                      onPress={cyclePlaybackSpeed}
                      disabled={disableSpeedControl}
                      accessibilityRole="button"
                      accessibilityLabel="Toggle playback speed"
                    >
                      <Text style={styles.fullscreenSpeedLabel}>{playbackSpeedLabel}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.fullscreenControlButton} onPress={handleClose}>
                      <Minimize size={20} color="white" />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Animated.View>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function WebFullscreenModal({
  config,
  onDismiss,
  onSharePress,
  onDownload,
  seekStepSeconds,
  isDownloading = false,
  downloadProgress,
}: WebFullscreenModalProps) {
  const { theme } = useTheme();
  const { sourceUri, startTime, isMuted: initialMuted, playbackSpeed: initialSpeed, wasPlaying } = config;

  const [isPlaying, setIsPlaying] = useState(wasPlaying);
  const [isMuted, setIsMuted] = useState(initialMuted);
  const [playbackSpeed, setPlaybackSpeed] = useState(initialSpeed);
  const [currentTime, setCurrentTime] = useState(startTime);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [isDraggingProgress, setIsDraggingProgress] = useState(false);
  const [webStatus, setWebStatus] = useState<VideoPlayerStatus>('idle');
  const [webBufferedPercent, setWebBufferedPercent] = useState<number | null>(null);
  const [webIsBuffering, setWebIsBuffering] = useState(false);
  const [webIsStalled, setWebIsStalled] = useState(false);
  const [webPlaybackError, setWebPlaybackError] = useState<string | null>(null);
  const [webEnded, setWebEnded] = useState(false);
  const normalizedProgress = useEasedDownloadProgressPercent(
    downloadProgress,
    isDownloading
  );
  const downloadButtonA11yLabel = resolveDownloadProgressLabel(
    isDownloading,
    normalizedProgress,
    'Download video'
  );
  const shareButtonA11yLabel = 'Share video';

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const intendedPlayingRef = useRef(wasPlaying);
  const pauseRequestedRef = useRef(false);
  const controlsTimeoutRef = useRef<number | null>(null);
  const progressBarRef = useRef<View>(null);
  const progressBarWidthRef = useRef(1);
  const progressBarPageXRef = useRef<number | null>(null);
  const webWrapperRef = useRef<any>(null);
  const webKeyboardActiveRef = useRef(true);
  const playbackIdRef = useRef<string>(createPlaybackId());
  const readyOpacity = useSharedValue(0);
  const controlsOpacity = useRef(new Animated.Value(1)).current;
  const controlsScale = useRef(new Animated.Value(1)).current;
  const lastResumeAttemptRef = useRef(0);

  const setCurrentTimeSafe = useCallback((next: number) => {
    if (!Number.isFinite(next)) {
      return;
    }
    setCurrentTime((prev) => (Math.abs(prev - next) < 1 / 60 ? prev : next));
  }, []);

  const applyPlaybackRate = useCallback((rate: number) => {
    if (!Number.isFinite(rate)) {
      return;
    }
    if (videoRef.current) {
      try {
        videoRef.current.playbackRate = rate;
      } catch (error) {
        logger.debug?.('WebFullscreenModal: failed to set playback rate', error);
      }
    }
  }, []);

  useEffect(() => {
    setIsPlaying(wasPlaying);
    setIsMuted(initialMuted);
    setPlaybackSpeed(initialSpeed);
    setCurrentTimeSafe(startTime);
    setIsLoading(true);
    setWebStatus('loading');
    setWebPlaybackError(null);
    setWebEnded(false);
    setWebBufferedPercent(null);
    setWebIsBuffering(false);
    setWebIsStalled(false);
    readyOpacity.value = 0;
    intendedPlayingRef.current = wasPlaying;
  }, [initialMuted, initialSpeed, readyOpacity, setCurrentTimeSafe, startTime, wasPlaying]);

  useEffect(() => {
    applyPlaybackRate(playbackSpeed);
  }, [applyPlaybackRate, playbackSpeed]);

  useEffect(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }

    if (showControls && isPlaying && !isDraggingProgress) {
      controlsTimeoutRef.current = window.setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }

    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    };
  }, [showControls, isPlaying, isDraggingProgress]);

  const updateWebBufferedPercent = useCallback(() => {
    const nextBuffered = resolveBufferedPercentFromElement(videoRef.current);
    if (nextBuffered == null) {
      return;
    }
    setWebBufferedPercent((prev) => {
      if (prev != null && Math.abs(prev - nextBuffered) < 0.6) {
        return prev;
      }
      return nextBuffered;
    });
  }, []);

  const handleLoadedMetadata = () => {
    if (!videoRef.current) {
      return;
    }
    const mediaDuration = videoRef.current.duration || 0;
    if (mediaDuration > 0) {
      setDuration(mediaDuration);
    }
    setIsLoading(false);
    setWebStatus('readyToPlay');
    setWebPlaybackError(null);
    setWebEnded(false);
    try {
      videoRef.current.currentTime = startTime || 0;
    } catch (error) {
      logger.debug?.('WebFullscreenModal: failed to set start time', error);
    }
    videoRef.current.muted = isMuted;
    applyPlaybackRate(playbackSpeed);

    if (wasPlaying) {
      pauseOtherVideos(playbackIdRef.current);
      const playPromise = videoRef.current.play?.();
      if (playPromise?.catch) {
        playPromise.catch(() => undefined);
      }
      intendedPlayingRef.current = true;
      pauseRequestedRef.current = false;
    }
  };

  const handleWebLoadStart = useCallback(() => {
    setIsLoading(true);
    setWebStatus('loading');
    setWebPlaybackError(null);
    setWebEnded(false);
  }, []);

  const handleWebCanPlay = useCallback(() => {
    setIsLoading(false);
    setWebStatus('readyToPlay');
    setWebIsBuffering(false);
    setWebIsStalled(false);
  }, []);

  const handleWebWaiting = useCallback(() => {
    setWebIsBuffering(true);
  }, []);

  const handleWebStalled = useCallback(() => {
    setWebIsStalled(true);
    setWebIsBuffering(true);
  }, []);

  const handleWebPlaying = useCallback(() => {
    setWebIsBuffering(false);
    setWebIsStalled(false);
    setWebStatus('readyToPlay');
  }, []);

  const handleWebError = useCallback(() => {
    setWebPlaybackError('Playback failed');
    setWebStatus('error');
    setIsLoading(false);
  }, []);

  const handleWebEnded = useCallback(() => {
    setWebEnded(true);
    intendedPlayingRef.current = false;
    pauseRequestedRef.current = false;
    setIsPlaying(false);
  }, []);

  const handleWebProgress = useCallback(() => {
    updateWebBufferedPercent();
  }, [updateWebBufferedPercent]);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const nextTime = videoRef.current.currentTime;
      setCurrentTimeSafe(nextTime);
      updateWebBufferedPercent();
      // Keep modal time in sync with the element on every update.
    }
  };

  const togglePlayPause = () => {
    if (!videoRef.current) {
      return;
    }
    if (isPlaying) {
      pauseRequestedRef.current = true;
      videoRef.current.pause();
      setIsPlaying(false);
      intendedPlayingRef.current = false;
    } else {
      pauseOtherVideos(playbackIdRef.current);
      const playPromise = videoRef.current.play?.();
      if (playPromise?.catch) {
        playPromise.catch(() => undefined);
      }
      setIsPlaying(true);
      intendedPlayingRef.current = true;
      pauseRequestedRef.current = false;
    }
    setShowControls(true);
  };

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const resumeIfNeeded = () => {
      if (!videoRef.current) {
        return;
      }
      if (!intendedPlayingRef.current) {
        return;
      }
      if (document.visibilityState && document.visibilityState !== 'visible') {
        return;
      }

      try {
        if (Number.isFinite(currentTime) && currentTime > 0) {
          if (Math.abs(videoRef.current.currentTime - currentTime) > 0.5) {
            videoRef.current.currentTime = currentTime;
          }
        }
        pauseOtherVideos(playbackIdRef.current);
        const playPromise = videoRef.current.play?.();
        if (playPromise?.catch) {
          playPromise.catch(() => undefined);
        }
      } catch (error) {
        logger.debug?.('WebFullscreenModal: resume after browser fullscreen failed', error);
      }
    };

    const handleFullscreenChange = () => {
      resumeIfNeeded();
    };
    const handleVisibilityChange = () => {
      resumeIfNeeded();
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange as EventListener);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange as EventListener);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentTime]);

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (videoRef.current) {
      videoRef.current.muted = nextMuted;
    }
    setShowControls(true);
  };

  const handleSingleTap = useCallback(() => {
    setShowControls((visible) => !visible);
  }, []);

  const seekBySeconds = useCallback(
    (deltaSeconds: number) => {
      const durationSource = videoRef.current?.duration ?? duration ?? 0;
      if (!durationSource || !Number.isFinite(durationSource)) {
        return false;
      }

      const baseTime = Number.isFinite(currentTime) ? currentTime : 0;
      const nextTime = clamp(baseTime + deltaSeconds, 0, durationSource);
      if (!Number.isFinite(nextTime)) {
        return false;
      }

      if (videoRef.current) {
        try {
          videoRef.current.currentTime = nextTime;
        } catch (error) {
          logger.debug?.('WebFullscreenModal: seek failed', error);
        }
      }

      setCurrentTimeSafe(nextTime);
      return true;
    },
    [currentTime, duration, setCurrentTimeSafe]
  );

  const seekHint = useMemo(
    () => formatSeekHint(seekStepSeconds ?? SEEK_STEP_SECONDS),
    [seekStepSeconds]
  );

  const cyclePlaybackSpeed = useCallback(() => {
    setShowControls(true);
    const currentRate = playbackSpeed;
    const currentIndex = PLAYBACK_SPEEDS.findIndex((rate) => Math.abs(rate - currentRate) < 0.001);
    const fallbackIndex = Math.max(PLAYBACK_SPEEDS.indexOf(1), 0);
    const safeIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
    const nextRate = PLAYBACK_SPEEDS[(safeIndex + 1) % PLAYBACK_SPEEDS.length];

    applyPlaybackRate(nextRate);
    setPlaybackSpeed(nextRate);
  }, [applyPlaybackRate, playbackSpeed]);

  const handleProgressBarLayout = useCallback(
    (event: LayoutChangeEvent) => {
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
    },
    []
  );

  const resolveLocationX = useCallback((evt: GestureResponderEvent) => {
    const { locationX, pageX } = evt.nativeEvent;
    if (typeof locationX === 'number' && Number.isFinite(locationX)) {
      return locationX;
    }
    if (
      typeof pageX === 'number' &&
      Number.isFinite(pageX) &&
      progressBarPageXRef.current != null &&
      Number.isFinite(progressBarPageXRef.current)
    ) {
      return pageX - (progressBarPageXRef.current as number);
    }
    return null;
  }, []);

  const calculateScrubProgress = useCallback((locationX: number | null) => {
    if (locationX == null) {
      return null;
    }
    const width = progressBarWidthRef.current;
    if (!Number.isFinite(width) || width <= 0) {
      return null;
    }
    const ratio = clamp(locationX / width, 0, 1);
    return ratio * 100;
  }, []);

  const applyScrubProgress = useCallback(
    (progressValue: number | null, commit: boolean) => {
      if (progressValue == null) {
        return;
      }

      const normalized = clamp(progressValue / 100, 0, 1);
      const baseDuration = duration > 0 ? duration : 0;
      const newTime = baseDuration * normalized;

      if (Number.isFinite(newTime)) {
        setCurrentTimeSafe(newTime);
      }

      if (!commit || !videoRef.current) {
        return;
      }

      try {
        videoRef.current.currentTime = newTime;
      } catch (error) {
        logger.debug?.('WebFullscreenModal: seek failed', error);
      }
    },
    [duration, setCurrentTimeSafe]
  );

  const getProgressFromEvent = useCallback(
    (evt: GestureResponderEvent) => {
      const location = resolveLocationX(evt);
      return calculateScrubProgress(location);
    },
    [calculateScrubProgress, resolveLocationX]
  );

  const progressPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          setIsDraggingProgress(true);
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), false);
        },
        onPanResponderMove: (evt) => {
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), false);
        },
        onPanResponderRelease: (evt) => {
          setIsDraggingProgress(false);
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), true);
        },
        onPanResponderTerminate: (evt) => {
          setIsDraggingProgress(false);
          setShowControls(true);
          applyScrubProgress(getProgressFromEvent(evt), true);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [applyScrubProgress, getProgressFromEvent]
  );

  const playbackUxState = useVideoPlaybackUxState({
    status: webStatus,
    isLoading,
    isPlaying,
    intendedPlaying: intendedPlayingRef.current,
    duration,
    currentTime,
    bufferedPercentOverride: webBufferedPercent,
    isSeeking: isDraggingProgress,
    hasResolvedUri: true,
    error: webPlaybackError,
    ended: webEnded,
    externalBuffering: webIsBuffering,
    externalStalled: webIsStalled,
    // Match the inline player's web-specific thresholds
    bufferingDelayMs: 600,
    bufferingExitDelayMs: 200,
    stallThresholdMs: 8000,
    bufferGapSeconds: 0.5,
  });

  const bufferedPercent = playbackUxState.bufferedPercent ?? 0;
  // Don't hide controls on error — user needs close button and retry is in the overlay.
  const shouldLockControls = playbackUxState.isInitialLoading;
  const shouldShowControls = showControls && !shouldLockControls;
  const formattedProgressLabel = useMemo(() => {
    return `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }, [currentTime, duration]);

  const seekGestureEnabled =
    !shouldLockControls && !playbackUxState.isBuffering && !playbackUxState.isStalled && !isDraggingProgress;
  const { overlayState, overlayAnimatedStyle, handleSeekTap, handleKeyboardSeek, handleAccessibilityAction } =
    useSeekGesture({
      enabled: seekGestureEnabled,
      stepSeconds: seekStepSeconds,
      onSingleTap: handleSingleTap,
      onSeekBySeconds: seekBySeconds,
    });

  useEffect(() => {
    if (playbackUxState.isReady) {
      readyOpacity.value = withTiming(1, { duration: 240 });
    }
  }, [playbackUxState.isReady, readyOpacity]);

  // The ready fade-in in WebFullscreenModal is handled by a CSS transition on a <div> cover overlay.
  // playbackUxState.isReady drives opacity: 0/1. No Reanimated opacity on the video surface.
  // This fixes Chrome Android black screen (no compositing context interference).

  useEffect(() => {
    const nativeDriver = Platform.OS !== 'web';
    Animated.parallel([
      Animated.timing(controlsOpacity, {
        toValue: shouldShowControls ? 1 : 0,
        duration: shouldShowControls ? 180 : 140,
        useNativeDriver: nativeDriver,
      }),
      Animated.spring(controlsScale, {
        toValue: shouldShowControls ? 1 : 0.98,
        speed: 18,
        bounciness: 4,
        useNativeDriver: nativeDriver,
      }),
    ]).start();
  }, [controlsOpacity, controlsScale, shouldShowControls]);

  useEffect(() => {
    if (!playbackUxState.isReady || playbackUxState.isBuffering || playbackUxState.isStalled) {
      return;
    }
    if (!intendedPlayingRef.current || isPlaying) {
      return;
    }
    const now = Date.now();
    if (now - lastResumeAttemptRef.current < 900) {
      return;
    }
    lastResumeAttemptRef.current = now;
    if (!videoRef.current) {
      return;
    }
    try {
      const playPromise = videoRef.current.play?.();
      if (playPromise?.catch) {
        playPromise.catch(() => undefined);
      }
    } catch (error) {
      logger.debug?.('WebFullscreenModal: resume after buffering failed', error);
    }
  }, [isPlaying, playbackUxState.isBuffering, playbackUxState.isReady, playbackUxState.isStalled]);

  const webFocusStyle = useMemo(
    () =>
      Platform.OS === 'web'
        ? ({ outline: 'none', caretColor: 'transparent', WebkitTapHighlightColor: 'transparent' } as any)
        : null,
    []
  );

  const handleWebFocus = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }
    try {
      document.documentElement?.setAttribute('data-tm-video-focus', 'true');
      document.body?.setAttribute('data-tm-video-focus', 'true');
    } catch {
      // ignore
    }
    clearWebSelection();
  }, []);

  const handleWebBlur = useCallback(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return;
    }
    try {
      document.documentElement?.removeAttribute('data-tm-video-focus');
      document.body?.removeAttribute('data-tm-video-focus');
    } catch {
      // ignore
    }
  }, []);

  const pauseSelf = useCallback(() => {
    if (videoRef.current) {
      try {
        videoRef.current.pause();
      } catch (error) {
        logger.debug?.('WebFullscreenModal: pause other video failed', error);
      }
    }

    intendedPlayingRef.current = false;
    pauseRequestedRef.current = false;
    setIsPlaying(false);
  }, [setIsPlaying]);

  useEffect(() => registerPlaybackHandler(playbackIdRef.current, pauseSelf), [pauseSelf]);

  useEffect(() => {
    if (isPlaying) {
      pauseOtherVideos(playbackIdRef.current);
    }
  }, [isPlaying]);

  const exitFullscreen = useCallback(() => {
    const element = videoRef.current;
    const latestTime =
      element && Number.isFinite(element.currentTime)
        ? element.currentTime
        : Number.isFinite(currentTime)
          ? currentTime
          : 0;
    const latestMuted = element ? element.muted : isMuted;
    const latestSpeed =
      element && Number.isFinite(element.playbackRate) ? element.playbackRate : playbackSpeed;
    const latestWasPlaying = element ? !element.paused : isPlaying;

    if (element) {
      try {
        element.pause();
      } catch (error) {
        logger.debug?.('WebFullscreenModal: pause on close failed', error);
      }
    }
    onDismiss({
      currentTime: latestTime,
      isMuted: latestMuted,
      playbackSpeed: latestSpeed,
      wasPlaying: latestWasPlaying,
    });
  }, [currentTime, isMuted, isPlaying, onDismiss, playbackSpeed]);

  const handleKeyboardShortcut = useCallback(
    (event: any) => {
      if (Platform.OS !== 'web') {
        return false;
      }

      if (event?.defaultPrevented) {
        return false;
      }

      if (event?.metaKey || event?.ctrlKey || event?.altKey) {
        return false;
      }

      if (isKeyboardEventFromEditable(event)) {
        return false;
      }

      const key = event?.key;
      const code = event?.code;
      const lower = typeof key === 'string' ? key.toLowerCase() : '';

      const markHandled = () => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        clearWebSelection();
        setShowControls(true);
      };

      if (key === 'ArrowLeft' || lower === 'j') {
        markHandled();
        handleKeyboardSeek('backward');
        return true;
      }

      if (key === 'ArrowRight' || lower === 'l') {
        markHandled();
        handleKeyboardSeek('forward');
        return true;
      }

      const isSpace = code === 'Space' || key === ' ' || key === 'Spacebar';
      if (isSpace || lower === 'k') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        markHandled();
        togglePlayPause();
        return true;
      }

      if (lower === 'm') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        markHandled();
        toggleMute();
        return true;
      }

      if (key === 'Escape') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        markHandled();
        exitFullscreen();
        return true;
      }

      if (lower === 'f') {
        if (event?.repeat) {
          markHandled();
          return true;
        }
        markHandled();
        exitFullscreen();
        return true;
      }

      return false;
    },
    [exitFullscreen, handleKeyboardSeek, toggleMute, togglePlayPause]
  );

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return;
    }

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (!webKeyboardActiveRef.current) {
        return;
      }
      handleKeyboardShortcut(event);
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    handleWebFocus();

    return () => {
      webKeyboardActiveRef.current = false;
      window.removeEventListener('keydown', handleGlobalKeyDown, true);
      handleWebBlur();
    };
  }, [handleKeyboardShortcut, handleWebBlur, handleWebFocus]);

  const handleKeyDown = useCallback(
    (event: any) => {
      if (handleKeyboardShortcut(event)) {
        clearWebSelection();
      }
    },
    [handleKeyboardShortcut]
  );

  const renderSeekGestureLayer = () => (
    <View style={styles.seekGestureLayer} pointerEvents="box-none">
      <Pressable
        style={[styles.seekZone, styles.seekZoneLeft]}
        onPress={() => handleSeekTap('backward')}
        accessible={false}
      />
      <Pressable
        style={[styles.seekZone, styles.seekZoneRight]}
        onPress={() => handleSeekTap('forward')}
        accessible={false}
      />
      <SeekOverlay state={overlayState} animatedStyle={overlayAnimatedStyle} variant="fullscreen" />
    </View>
  );

  const handleClose = useCallback(() => {
    exitFullscreen();
  }, [exitFullscreen]);

  const handleShare = useCallback(() => {
    handleClose();
    setTimeout(() => {
      onSharePress();
    }, 0);
  }, [handleClose, onSharePress]);

  const handleVideoSeeked = useCallback(() => {
    if (!videoRef.current) {
      return;
    }

    const nextTime = videoRef.current.currentTime;
    if (Number.isFinite(nextTime)) {
      setCurrentTimeSafe(nextTime);
    }
  }, [setCurrentTimeSafe]);

  const handleVideoPlay = useCallback(() => {
    pauseOtherVideos(playbackIdRef.current);
    intendedPlayingRef.current = true;
    pauseRequestedRef.current = false;
    setIsPlaying(true);
    setWebIsBuffering(false);
    setWebIsStalled(false);
    setWebEnded(false);
    setWebStatus('readyToPlay');
    setWebPlaybackError(null);
  }, [setIsPlaying]);

  const handleVideoPause = useCallback(() => {
    setIsPlaying(false);
    setWebIsBuffering(false);
    setWebIsStalled(false);
    if (pauseRequestedRef.current) {
      intendedPlayingRef.current = false;
      pauseRequestedRef.current = false;
    }
  }, []);

  const handleClosePress = useCallback((event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
    handleClose();
  }, [handleClose]);

  const handleSharePress = useCallback((event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
    handleShare();
  }, [handleShare]);

  const handleDownloadPress = useCallback((event?: GestureResponderEvent) => {
    event?.stopPropagation?.();
    onDownload?.();
  }, [onDownload]);

  const handleRetry = useCallback(() => {
    intendedPlayingRef.current = true;
    setIsLoading(true);
    setWebPlaybackError(null);
    setWebEnded(false);
    if (!videoRef.current) {
      return;
    }
    try {
      videoRef.current.load();
      const playPromise = videoRef.current.play?.();
      if (playPromise?.catch) {
        playPromise.catch(() => undefined);
      }
      setIsPlaying(true);
    } catch (error) {
      logger.debug?.('WebFullscreenModal: retry failed', error);
    }
  }, []);

  const handleReplay = useCallback(() => {
    if (!videoRef.current) {
      return;
    }
    try {
      videoRef.current.currentTime = 0;
    } catch (error) {
      logger.debug?.('WebFullscreenModal: reset time failed', error);
    }
    pauseOtherVideos(playbackIdRef.current);
    const playPromise = videoRef.current.play?.();
    if (playPromise?.catch) {
      playPromise.catch(() => undefined);
    }
    setIsPlaying(true);
    intendedPlayingRef.current = true;
    setWebEnded(false);
  }, []);

  const renderPlaybackOverlay = () => {
    const overlayPhase =
      playbackUxState.phase === 'ready' || playbackUxState.phase === 'idle'
        ? 'loading'
        : playbackUxState.phase;

    // Suppress the loading/buffering overlay when the video is visibly playing.
    // The browser 'waiting' event fires constantly during normal playback of large files
    // on mobile Chrome — don't show the spinner over a running video.
    const videoActuallyPlaying = isPlaying || currentTime > 0;
    const suppressOverlay = videoActuallyPlaying && (
      playbackUxState.phase === 'loading' ||
      playbackUxState.isInitialLoading ||
      (playbackUxState.isBuffering && isPlaying)
    );

    return (
      <VideoBufferingOverlay
        visible={suppressOverlay ? false : playbackUxState.showOverlay}
        phase={overlayPhase}
        title={playbackUxState.statusLabel}
        subtitle={playbackUxState.statusDetail}
        bufferedPercent={playbackUxState.bufferedPercent}
        accentColor={theme.primary}
        variant="fullscreen"
        showSpinner={playbackUxState.showSpinner}
        showPercent={playbackUxState.showPercent}
        onRetry={playbackUxState.isError ? handleRetry : undefined}
        onReplay={playbackUxState.isEnded ? handleReplay : undefined}
      />
    );
  };

  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <SafeAreaView style={styles.webFullscreenRoot}>
        <View
          ref={webWrapperRef}
          style={[styles.webFullscreenTouchable, webFocusStyle]}
          accessibilityRole="adjustable"
          accessibilityLabel="Video player"
          accessibilityHint={seekHint}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={handleAccessibilityAction}
          {...(Platform.OS === 'web'
            ? ({
                onKeyDown: handleKeyDown,
                onFocus: handleWebFocus,
                onBlur: handleWebBlur,
                onMouseDown: (event: any) => event.preventDefault?.(),
                tabIndex: -1,
                dataSet: { tmVideoPlayer: 'true' },
              } as any)
            : {})}
        >
          <View style={styles.webFullscreenVideoWrapper}>
            {/* Poster shown immediately while the web fullscreen video reloads — eliminates
                the black flash. Fades out once the video is playing. */}
            {config.posterUri && !playbackUxState.isReady ? (
              <Image
                source={{ uri: config.posterUri }}
                style={[StyleSheet.absoluteFillObject, { zIndex: 1, opacity: 0.92 }] as any}
                resizeMode="cover"
              />
            ) : null}
            {/* Video element is NOT inside an opacity-animated view — prevents mobile browser black screen. */}
            <View style={styles.fullscreenVideoSurface}>
              <video
                ref={videoRef}
                src={sourceUri}
                style={{
                  width: '100%',
                  height: '100%',
                  outline: 'none',
                  objectFit: 'contain',
                  // Do NOT set backgroundColor on <video> — mobile Chrome paints it over frames.
                } as any}
                onMouseDown={(event) => event.preventDefault?.()}
                onLoadStart={handleWebLoadStart}
                onCanPlay={handleWebCanPlay}
                onCanPlayThrough={handleWebCanPlay}
                onWaiting={handleWebWaiting}
                onStalled={handleWebStalled}
                onPlaying={handleWebPlaying}
                onError={handleWebError}
                onEnded={handleWebEnded}
                onProgress={handleWebProgress}
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onSeeked={handleVideoSeeked}
                onPlay={handleVideoPlay}
                onPause={handleVideoPause}
                muted={isMuted}
                playsInline
                preload="auto"
                disableRemotePlayback
                {...(config.posterUri ? { poster: config.posterUri } : {})}
                tabIndex={-1}
              />
              {/* No black cover div — it created a sibling GPU compositing layer that
                  stole the video's hardware surface on mobile Chrome, causing black screen. */}
            </View>

            {renderSeekGestureLayer()}

            {renderPlaybackOverlay()}

            <Animated.View
              style={[
                styles.fullscreenOverlay,
                { opacity: controlsOpacity, transform: [{ scale: controlsScale }] },
              ]}
              pointerEvents={shouldShowControls ? 'box-none' : 'none'}
            >
              <View style={styles.fullscreenTopRow} pointerEvents="box-none">
                <TouchableOpacity
                  style={[styles.fullscreenControlButton, styles.fullscreenCloseButton]}
                  onPress={handleClosePress}
                >
                  <X size={20} color="white" />
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.fullscreenControlButton}
                  onPress={handleSharePress}
                  accessibilityRole="button"
                  accessibilityLabel={shareButtonA11yLabel}
                >
                  <Share2 size={20} color="white" />
                </TouchableOpacity>
              </View>

              <View style={styles.fullscreenMainControls} pointerEvents="box-none">
                <TouchableOpacity
                  style={[styles.fullscreenControlButton, styles.fullscreenPlayButton]}
                  onPress={togglePlayPause}
                >
                  {isPlaying ? <Pause size={32} color="white" /> : <Play size={32} color="white" />}
                </TouchableOpacity>
              </View>

              <View style={styles.fullscreenBottomControls} pointerEvents="box-none">
                <View style={styles.fullscreenProgressRow} pointerEvents="box-none">
                  <Text style={styles.fullscreenTimeText}>{formattedProgressLabel}</Text>

                  <View style={styles.fullscreenProgressContainer}>
                    <View
                      ref={progressBarRef}
                      collapsable={false}
                      style={styles.fullscreenProgressBarTouchable}
                      onLayout={handleProgressBarLayout}
                      {...progressPanResponder.panHandlers}
                    >
                      <View style={styles.fullscreenProgressBar}>
                        <View style={[styles.fullscreenProgressBuffered, { width: `${bufferedPercent}%` }]} />
                        <View style={[styles.fullscreenProgressFill, { width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%` }]} />
                        <View
                          style={[
                            styles.fullscreenProgressThumb,
                            {
                              left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                              transform: [{ scale: isDraggingProgress ? 1.2 : 1 }],
                            },
                          ]}
                        />
                      </View>
                    </View>
                  </View>
                </View>

                <View style={styles.fullscreenActionsRow} pointerEvents="box-none">
                  <View style={styles.fullscreenActionsLeft} pointerEvents="box-none">
                    <TouchableOpacity style={styles.fullscreenControlButton} onPress={toggleMute}>
                      {isMuted ? <VolumeX size={20} color="white" /> : <Volume2 size={20} color="white" />}
                    </TouchableOpacity>

                    {onDownload ? (
                      <TouchableOpacity
                        style={[styles.fullscreenControlButton, isDownloading ? styles.controlButtonDisabled : null]}
                          onPress={handleDownloadPress}
                        disabled={isDownloading}
                        accessibilityRole="button"
                        accessibilityLabel={downloadButtonA11yLabel}
                      >
                        {isDownloading ? (
                          <Text style={styles.fullscreenDownloadProgressText}>{resolveProgressPercentText(normalizedProgress)}</Text>
                        ) : (
                          <Download size={20} color="white" />
                        )}
                      </TouchableOpacity>
                    ) : null}
                  </View>

                  <View style={styles.fullscreenActionsRight} pointerEvents="box-none">
                    <TouchableOpacity
                      style={[styles.fullscreenControlButton, styles.fullscreenSpeedButton]}
                      onPress={cyclePlaybackSpeed}
                      accessibilityRole="button"
                      accessibilityLabel="Toggle playback speed"
                    >
                      <Text style={styles.fullscreenSpeedLabel}>{`${Math.round(playbackSpeed * 100) / 100}x`}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.fullscreenControlButton} onPress={handleClose}>
                      <Minimize size={20} color="white" />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </Animated.View>
          </View>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    maxWidth: 360,
    minWidth: 220,
    alignSelf: 'stretch',
    borderRadius: 8,
    overflow: 'hidden',
    marginVertical: 2,
  },
  videoContainer: {
    position: 'relative',
    backgroundColor: '#000',
    borderRadius: 8,
    overflow: 'hidden',
    outlineStyle: 'solid',
    outlineWidth: 0,
    outlineColor: 'transparent',
    userSelect: 'none',
  },
  webFullscreenRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  webFullscreenTouchable: {
    flex: 1,
    outlineStyle: 'solid',
    outlineWidth: 0,
    outlineColor: 'transparent',
  },
  webFullscreenVideoWrapper: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000',
    outlineStyle: 'solid',
    outlineWidth: 0,
    outlineColor: 'transparent',
    userSelect: 'none',
  },
  hiddenInlineWhileFullscreen: {
    opacity: 0,
    pointerEvents: 'none',
  },
  inlineVideoWrapper: {
    flex: 1,
    position: 'relative',
    outlineStyle: 'solid',
    outlineWidth: 0,
    outlineColor: 'transparent',
    userSelect: 'none',
  },
  inlineVideoSurface: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
    borderRadius: 8,
    position: 'relative',
  },
  bufferingPoster: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 8,
    opacity: 0.92,
  },
  fullscreenVideoWrapper: {
    flex: 1,
    position: 'relative',
    outlineStyle: 'solid',
    outlineWidth: 0,
    outlineColor: 'transparent',
    userSelect: 'none',
  },
  fullscreenVideoSurface: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  controlsOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'space-between',
    padding: 16,
    userSelect: 'none',
  },
  controlsOverlayMinimal: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 0,
  },
  seekGestureLayer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
  },
  seekZone: {
    flex: 1,
    height: '100%',
  },
  seekZoneLeft: {
    alignItems: 'flex-start',
  },
  seekZoneRight: {
    alignItems: 'flex-end',
  },
  seekOverlay: {
    position: 'absolute',
    top: '32%',
    width: 120,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(8,12,24,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
    userSelect: 'none',
  },
  seekOverlayFullscreen: {
    width: 140,
    paddingVertical: 12,
    borderRadius: 18,
  },
  seekOverlayLeft: {
    left: 18,
  },
  seekOverlayRight: {
    right: 18,
  },
  seekOverlayArrow: {
    color: 'white',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: 2,
  },
  seekOverlayText: {
    marginTop: 4,
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
  fullscreenTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  fullscreenCloseButton: {
    paddingHorizontal: 12,
  },
  topControls: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  mainControls: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
  },
  controlButton: {
    padding: 8,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.5)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  downloadProgressText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  controlButtonDisabled: {
    opacity: 0.6,
  },
  playButton: {
    padding: 16,
  },
  bottomControls: {
    flexDirection: 'column',
    gap: 12,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  actionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  speedButton: {
    paddingHorizontal: 12,
  },
  speedLabel: {
    color: 'white',
    fontSize: 12,
    fontWeight: '500',
  },
  timeText: {
    color: 'white',
    fontSize: 12,
    minWidth: 80,
  },
  progressContainer: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  progressBarTouchable: {
    width: '100%',
    paddingVertical: 8,
    justifyContent: 'center',
  },
  progressBar: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    position: 'relative',
  },
  progressBuffered: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  progressFill: {
    height: '100%',
    backgroundColor: 'white',
  },
  progressThumb: {
    position: 'absolute',
    top: -6,
    width: 16,
    height: 16,
    backgroundColor: 'white',
    borderRadius: 8,
    marginLeft: -8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 4,
  },
  fullscreenOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(6,10,24,0.55)',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    paddingVertical: 36,
    gap: 16,
    userSelect: 'none',
  },
  fullscreenMainControls: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 24,
    marginBottom: 16,
  },
  fullscreenControlButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 24,
    backgroundColor: 'rgba(15,20,32,0.65)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minWidth: 44,
    minHeight: 44,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12,
    elevation: 3,
  },
  fullscreenDownloadProgressText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '600',
  },
  fullscreenPlayButton: {
    paddingHorizontal: 18,
    paddingVertical: 18,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 18,
    elevation: 4,
  },
  fullscreenBottomControls: {
    flexDirection: 'column',
    gap: 16,
    backgroundColor: 'rgba(6,10,24,0.45)',
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 16,
    elevation: 5,
  },
  fullscreenProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fullscreenTimeText: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    minWidth: 80,
    fontWeight: '600',
  },
  fullscreenProgressContainer: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    justifyContent: 'center',
  },
  fullscreenProgressBarTouchable: {
    width: '100%',
    paddingVertical: 10,
    justifyContent: 'center',
  },
  fullscreenProgressBar: {
    height: 6,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    position: 'relative',
    overflow: 'hidden',
  },
  fullscreenProgressBuffered: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.32)',
  },
  fullscreenProgressFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: '100%',
    backgroundColor: 'white',
  },
  fullscreenProgressThumb: {
    position: 'absolute',
    top: -7,
    width: 18,
    height: 18,
    backgroundColor: 'white',
    borderRadius: 9,
    marginLeft: -9,
    borderWidth: 2,
    borderColor: 'rgba(6,10,24,0.85)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 4,
  },
  fullscreenActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  fullscreenActionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fullscreenActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  fullscreenSpeedButton: {
    paddingHorizontal: 18,
    minWidth: 72,
  },
  fullscreenSpeedButtonDisabled: {
    opacity: 0.6,
  },
  fullscreenSpeedLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: 'white',
    letterSpacing: 0.3,
  },
  videoInfo: {
    padding: 8,
  },
  fileName: {
    fontSize: 14,
    fontWeight: '500',
  },
  videoDuration: {
    fontSize: 12,
    marginTop: 2,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
  },
  thumbnailFallback: {
    width: '100%',
    height: '100%',
    backgroundColor: '#121826',
  },
  placeholderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: 16,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  placeholderOverlayMinimal: {
    padding: 0,
  },
  placeholderTopRow: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  placeholderTopLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  placeholderBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  placeholderBadgeText: {
    marginLeft: 6,
    color: 'white',
    fontSize: 12,
    fontWeight: '500',
  },
  placeholderPlayButton: {
    padding: 24,
  },
  placeholderPlayButtonMinimal: {
    padding: 24,
  },
  placeholderHint: {
    marginTop: 12,
    color: 'white',
    fontSize: 14,
    fontWeight: '500',
  },
  fullscreenModalRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  fullscreenTouchable: {
    flex: 1,
  },
});
