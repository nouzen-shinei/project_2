import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { logger } from '@/lib/logger';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
  ActivityIndicator,
  PanResponder,
  Image,
  GestureResponderEvent,
  LayoutChangeEvent,
  Modal,
  SafeAreaView,
  StatusBar,
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
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource, type VideoPlayer as ExpoVideoPlayer } from 'expo-video';
import { ShareModal } from './ShareModal';
import { chatCacheService } from '../services/chatCacheService';

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

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

interface VideoPlayerProps {
  uri: string;
  fileName?: string;
  onDownload?: () => void;
  style?: any;
  autoPlay?: boolean;
  showControlsProp?: boolean;
  maxHeight?: number;
  onShare?: () => void;
  shareUrl?: string;
  thumbnailUrl?: string;
  controlVariant?: 'full' | 'minimal';
}

type VideoSourceCacheEntry = {
  resolvedUri: string | null;
  duration: number | null;
  previewUri: string | null;
  lastPosition: number;
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
    updatedAt: Date.now(),
  };

  const next: VideoSourceCacheEntry = {
    resolvedUri: patch.resolvedUri ?? previous.resolvedUri,
    duration: patch.duration ?? previous.duration,
    previewUri: patch.previewUri ?? previous.previewUri,
    lastPosition: patch.lastPosition ?? previous.lastPosition,
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
  showControlsProp: boolean;
  maxHeight: number;
  onSharePress: (event?: GestureResponderEvent) => void;
  playRequestId: number;
  onResolvedUriChange?: (uri: string | null) => void;
  onDurationChange?: (duration: number | null) => void;
  onPreviewAvailable?: (uri: string) => void;
  controlVariant: 'full' | 'minimal';
  cacheKey: string;
  initialPlaybackPosition: number;
  initialResolvedUri?: string | null;
}

type FullscreenSnapshot = {
  startTime: number;
  isMuted: boolean;
  playbackSpeed: number;
  wasPlaying: boolean;
};

type NativeFullscreenConfig = FullscreenSnapshot & {
  sourceUri: string;
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
}

export default function VideoPlayer({
  uri,
  fileName = 'video.mp4',
  onDownload,
  style,
  autoPlay = false,
  showControlsProp = true,
  maxHeight = 300,
  onShare,
  shareUrl,
  thumbnailUrl,
  controlVariant = 'full',
}: VideoPlayerProps) {
  const { theme } = useTheme();
  const isWeb = Platform.OS === 'web';
  const isMinimalControls = controlVariant === 'minimal';
  const forceImmediateLoad = isMinimalControls;
  const cacheKey = useMemo(() => `${uri}::${fileName}`, [uri, fileName]);
  const cachedEntry = useMemo(() => getCachedVideoEntry(cacheKey), [cacheKey]);
  const cachedResolvedUri = cachedEntry?.resolvedUri ?? null;
  const cachedDuration = cachedEntry?.duration ?? null;
  const cachedPreview = cachedEntry?.previewUri ?? null;
  const cachedInitialPosition = cachedEntry?.lastPosition ?? 0;

  const [shouldLoadVideo, setShouldLoadVideo] = useState(() => {
    if (autoPlay || !isWeb || forceImmediateLoad) {
      return true;
    }
    return Boolean(cachedResolvedUri);
  });
  const [playRequestId, setPlayRequestId] = useState(() => (autoPlay ? 1 : 0));
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
        setPreviewUri(thumbnailUrl);
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
      if (forceImmediateLoad || autoPlay || !isWeb) {
        setShouldLoadVideo((prev) => (prev ? prev : true));
      } else {
        setShouldLoadVideo((prev) => (prev ? false : prev));
      }
      setPlayRequestId(autoPlay ? 1 : 0);
      return;
    }

    setResolvedVideoUri(null);
    setDisplayDuration(null);
    setShowShareModal(false);
    setPreviewUri(thumbnailUrl || null);

    if (autoPlay || forceImmediateLoad || !isWeb) {
      setShouldLoadVideo(true);
      setPlayRequestId(autoPlay ? 1 : 0);
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

  const formattedDuration = displayDuration && displayDuration > 0 ? formatTime(displayDuration) : null;

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    if (previewUri) {
      return;
    }

    const candidate = resolvedVideoUri || uri;
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
  }, [previewUri, resolvedVideoUri, uri]);

  const renderPlaceholder = () => {
    const showPreviewImage = isWeb && !!previewUri;
    const showPreviewBadge = isWeb && !showPreviewImage;

    return (
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={handlePlayRequest}
        style={[styles.videoContainer, { height: maxHeight }]}
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
                      <Text style={styles.placeholderBadgeText}>No preview yet</Text>
                    </View>
                  ) : null}
                </View>

                <TouchableOpacity
                  style={styles.controlButton}
                  onPress={(event) => {
                    event.stopPropagation?.();
                    handleSharePress(event);
                  }}
                >
                  <Share2 size={20} color="white" />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={[styles.controlButton, styles.placeholderPlayButton]}
                onPress={(event) => {
                  event.stopPropagation?.();
                  handlePlayRequest();
                }}
              >
                <Play size={36} color="white" />
              </TouchableOpacity>

              <Text style={styles.placeholderHint}>Tap to load video</Text>
            </>
          ) : (
            <TouchableOpacity
              style={[styles.controlButton, styles.placeholderPlayButtonMinimal]}
              onPress={(event) => {
                event.stopPropagation?.();
                handlePlayRequest();
              }}
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
      onSharePress={handleSharePress}
      playRequestId={playRequestId}
      onResolvedUriChange={setResolvedVideoUri}
      onDurationChange={setDisplayDuration}
      onPreviewAvailable={(uri) => {
        setPreviewUri((existing) => existing || uri);
      }}
      controlVariant={controlVariant}
      cacheKey={cacheKey}
      initialPlaybackPosition={cachedInitialPosition}
      initialResolvedUri={effectiveInitialResolvedUri}
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
        onClose={() => setShowShareModal(false)}
        fileUrl={shareUrl || resolvedVideoUri || uri}
        fileName={fileName}
        onDownload={onDownload}
      />
    </View>
  );
}

function VideoPlayerLoaded({
  uri,
  fileName,
  onDownload,
  autoPlay,
  showControlsProp,
  maxHeight,
  onSharePress,
  playRequestId,
  onResolvedUriChange,
  onDurationChange,
  onPreviewAvailable,
  controlVariant,
  cacheKey,
  initialPlaybackPosition,
  initialResolvedUri,
}: VideoPlayerLoadedProps) {
  const { theme } = useTheme();
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [showControlsVisible, setShowControlsVisible] = useState(showControlsProp);
  const [isWebFullscreen, setIsWebFullscreen] = useState(false);
  const [nativeFullscreenConfig, setNativeFullscreenConfig] = useState<NativeFullscreenConfig | null>(null);
  const [resolving, setResolving] = useState(false);
  const [isDraggingProgress, setIsDraggingProgress] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [pendingPlayRequest, setPendingPlayRequest] = useState(autoPlay);
  const videoRef = useRef<any>(null);
  const videoViewRef = useRef<VideoView>(null as any);
  const controlsTimeoutRef = useRef<number | null>(null);
  const progressBarRef = useRef<View>(null);
  const progressBarWidthRef = useRef(1);
  const progressBarPageXRef = useRef<number | null>(null);
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
    playbackRateSyncedRef.current = false;
  }, [resolvedUri]);

  useEffect(() => {
    const normalized =
      Number.isFinite(initialPlaybackPosition) && initialPlaybackPosition > 0 ? initialPlaybackPosition : 0;
    initialPositionRef.current = normalized;
    hasAppliedInitialPositionRef.current = normalized <= 0;
  }, [initialPlaybackPosition]);

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
  const isNativeFullscreenVisible = !!nativeFullscreenConfig;
  const isFullscreen = Platform.OS === 'web' ? isWebFullscreen : isNativeFullscreenVisible;

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

  const nativeSource: VideoSource = useMemo(() => ({ uri: resolvedUri }), [resolvedUri]);
  const player = useVideoPlayer(nativeSource, (p: ExpoVideoPlayer) => {
    p.loop = false;
    p.muted = isMuted;
    p.timeUpdateEventInterval = 0.25;
    p.preservesPitch = true;
    try {
      p.playbackRate = playbackSpeed;
    } catch {}
  });

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

  const { isPlaying: nativePlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  const timeUpdate = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    bufferedPosition: player.bufferedPosition ?? 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const playbackRateChange = useEvent(player, 'playbackRateChange', {
    playbackRate: player.playbackRate ?? 1,
  });

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
      const durationSource =
        Platform.OS === 'web'
          ? durationRef.current ?? duration ?? 0
          : player.duration || durationRef.current || duration || 0;
      const baseDuration = Number.isFinite(durationSource) && durationSource > 0 ? durationSource : 0;
      const newTime = baseDuration * normalized;

      if (Number.isFinite(newTime)) {
        setCurrentTimeSafe(newTime);
      }

      if (!commit) {
        return;
      }

      if (Platform.OS === 'web' && videoRef.current) {
        videoRef.current.currentTime = newTime;
      } else if (Platform.OS !== 'web') {
        try {
          player.currentTime = newTime;
        } catch (error) {
          logger.debug?.('VideoPlayer: native seek failed', error);
        }
      }
    },
    [duration, player, setCurrentTimeSafe]
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
          setShowControlsVisible(true);
          applyScrubProgress(getProgressFromEvent(evt), false);
        },
        onPanResponderMove: (evt) => {
          setShowControlsVisible(true);
          applyScrubProgress(getProgressFromEvent(evt), false);
        },
        onPanResponderRelease: (evt) => {
          setIsDraggingProgress(false);
          setShowControlsVisible(true);
          applyScrubProgress(getProgressFromEvent(evt), true);
        },
        onPanResponderTerminate: (evt) => {
          setIsDraggingProgress(false);
          setShowControlsVisible(true);
          applyScrubProgress(getProgressFromEvent(evt), true);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [applyScrubProgress, getProgressFromEvent]
  );

  useEffect(() => {
    if (playRequestId !== lastPlayRequestIdRef.current) {
      lastPlayRequestIdRef.current = playRequestId;
      setPendingPlayRequest(true);
    }
  }, [playRequestId]);

  useEffect(() => {
    let cancelled = false;

    if (initialResolvedUri) {
      setResolving(false);
      setIsLoadingSafe(false);
      onResolvedUriChange?.(initialResolvedUri);
      patchVideoCacheEntry(cacheKeyRef.current, {
        resolvedUri: initialResolvedUri,
        lastPosition: initialPositionRef.current,
      });
      return () => {
        cancelled = true;
      };
    }

    setIsLoadingSafe(true);
    setCurrentTimeSafe(0);
    setDurationSafe(0);
    updateDuration(null);
    setResolving(true);
    onResolvedUriChange?.(null);

    (async () => {
      try {
        if (uri.startsWith('data:')) {
          if (!cancelled) {
            setResolvedUri(uri);
            onResolvedUriChange?.(uri);
            patchVideoCacheEntry(cacheKeyRef.current, { resolvedUri: uri });
          }
          return;
        }

        const hint = uri.startsWith('file://') ? uri : undefined;
        const localUri = await chatCacheService.getMediaForDownload(uri, fileName, hint, 'high');
        if (cancelled) {
          return;
        }
        const finalUri = localUri || uri;
        setResolvedUri(finalUri);
        onResolvedUriChange?.(finalUri);
        patchVideoCacheEntry(cacheKeyRef.current, { resolvedUri: finalUri });
      } catch (error) {
        logger.debug?.('VideoPlayer: failed to resolve cached media', error);
        if (!cancelled) {
          setResolvedUri(uri);
          onResolvedUriChange?.(uri);
          patchVideoCacheEntry(cacheKeyRef.current, { resolvedUri: uri });
        }
      } finally {
        if (!cancelled) {
          setResolving(false);
          setIsLoadingSafe(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, fileName, initialResolvedUri, onResolvedUriChange, setCurrentTimeSafe, setDurationSafe, setIsLoadingSafe, updateDuration, uri]);

  useEffect(() => {
    if (showControlsProp && isPlaying && !isDraggingProgress) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      controlsTimeoutRef.current = setTimeout(() => {
        setShowControlsVisible(false);
      }, 3000) as unknown as number;
    }
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
    };
  }, [showControlsProp, isPlaying, isDraggingProgress]);

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
        videoRef.current.pause();
      } else {
        restartIfEnded();
        const playPromise = videoRef.current.play();
        if (playPromise?.catch) {
          playPromise.catch((error: unknown) => {
            logger.debug?.('VideoPlayer: play() rejected', error);
          });
        }
      }
    } else if (Platform.OS !== 'web') {
      try {
        if (isPlaying) {
          player.pause();
        } else {
          restartIfEnded();
          player.play();
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: togglePlayPause error', error);
      }
    }
    setIsPlayingSafe(!isPlaying);
    setShowControlsVisible(true);
  };

  const toggleMute = () => {
    if (Platform.OS === 'web' && videoRef.current) {
      videoRef.current.muted = !isMuted;
    }
    setIsMuted(!isMuted);
    setShowControlsVisible(true);
  };

  const handleTimeUpdate = () => {
    if (Platform.OS === 'web' && videoRef.current) {
      setCurrentTimeSafe(videoRef.current.currentTime);
    }
  };

  const tryFulfillPendingPlay = useCallback(() => {
    if (!pendingPlayRequest) {
      return;
    }

    if (Platform.OS === 'web') {
      const element = videoRef.current;
      if (!element) {
        return;
      }
      try {
        const playPromise = element.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise
            .then(() => {
              setIsPlayingSafe(true);
              setPendingPlayRequest(false);
            })
            .catch((error: unknown) => {
              logger.debug?.('VideoPlayer: autoplay rejected', error);
              setPendingPlayRequest(false);
            });
        } else {
          setIsPlayingSafe(true);
          setPendingPlayRequest(false);
        }
      } catch (error) {
        logger.debug?.('VideoPlayer: autoplay threw', error);
      }
      return;
    }

    try {
      player.play();
      setPendingPlayRequest(false);
    } catch (error) {
      logger.debug?.('VideoPlayer: native autoplay failed', error);
    }
  }, [pendingPlayRequest, player, setIsPlayingSafe]);

  const handleLoadedMetadata = () => {
    if (Platform.OS === 'web' && videoRef.current) {
      const mediaDuration = videoRef.current.duration;
      setDurationSafe(mediaDuration);
      updateDuration(mediaDuration);
      applyPlaybackRate(playbackSpeed);
      if (onPreviewAvailable && typeof document !== 'undefined') {
        const frame = captureFrameFromElement(videoRef.current as any);
        if (frame) {
          onPreviewAvailable(frame);
        }
      }
      setIsLoadingSafe(false);
      seekToInitialPosition();
      tryFulfillPendingPlay();
    }
  };

  const handleVideoPress = () => {
    setShowControlsVisible(!showControlsProp || !showControlsVisible);
  };

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
    if (Platform.OS === 'web' && videoRef.current && typeof document !== 'undefined') {
      try {
        if (!isFullscreen) {
          const request =
            videoRef.current.requestFullscreen?.() || (videoRef.current as any).webkitRequestFullscreen?.();
          if (request instanceof Promise) {
            request.catch((error: unknown) => {
              logger.warn('VideoPlayer: failed to enter fullscreen', error);
            });
          }
          setIsWebFullscreen(true);
        } else {
          if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
            const exit = document.exitFullscreen?.() || (document as any).webkitExitFullscreen?.();
            if (exit instanceof Promise) {
              exit.catch((error: unknown) => {
                logger.warn('VideoPlayer: failed to exit fullscreen', error);
              });
            }
          }
          setIsWebFullscreen(false);
        }
      } catch (error) {
        logger.warn('VideoPlayer: fullscreen toggle error', error);
      }
    } else if (Platform.OS !== 'web') {
      setShowControlsVisible(true);
      if (isNativeFullscreenVisible) {
        return;
      }

      const wasPlayingBeforeFullscreen = isPlaying;
      pauseForFullscreenRef.current = true;

      try {
        player.pause();
      } catch (error) {
        logger.debug?.('VideoPlayer: failed to pause before fullscreen', error);
      }

      void (async () => {
        try {
          const sourceForFullscreen = await ensureFullscreenSource();
          if (!sourceForFullscreen) {
            if (wasPlayingBeforeFullscreen) {
              try {
                player.play();
                setIsPlayingSafe(true);
              } catch (resumeError) {
                logger.debug?.('VideoPlayer: failed to resume after fullscreen abort', resumeError);
                setIsPlayingSafe(false);
              }
            }
            return;
          }

          setNativeFullscreenConfig({
            sourceUri: sourceForFullscreen,
            startTime: Number.isFinite(currentTime) ? currentTime : 0,
            isMuted,
            playbackSpeed,
            wasPlaying: wasPlayingBeforeFullscreen,
          });
        } catch (error) {
          logger.debug?.('VideoPlayer: failed to prepare fullscreen source', { uri, error });
          if (wasPlayingBeforeFullscreen) {
            try {
              player.play();
              setIsPlayingSafe(true);
            } catch (resumeError) {
              logger.debug?.('VideoPlayer: failed to resume after fullscreen error', resumeError);
              setIsPlayingSafe(false);
            }
          }
        } finally {
          pauseForFullscreenRef.current = false;
        }
      })();
    }
  };

  const handleNativeFullscreenDismiss = useCallback(
    (result?: FullscreenReturnState) => {
      pauseForFullscreenRef.current = false;
      setNativeFullscreenConfig(null);

      if (!result) {
        try {
          player.pause();
        } catch (error) {
          logger.debug?.('VideoPlayer: failed to pause after fullscreen dismiss', error);
        }
        setIsPlayingSafe(false);
        return;
      }

      setIsMuted(result.isMuted);
  playbackRateSyncedRef.current = false;
      setPlaybackSpeed(result.playbackSpeed);

      const targetTime = Number.isFinite(result.currentTime) ? result.currentTime : 0;
      setCurrentTimeSafe(targetTime);
      try {
        player.currentTime = targetTime;
      } catch (error) {
        logger.debug?.('VideoPlayer: failed to sync time after fullscreen', error);
      }

      if (result.wasPlaying) {
        try {
          player.play();
          setIsPlayingSafe(true);
        } catch (error) {
          logger.debug?.('VideoPlayer: failed to resume after fullscreen', error);
          setIsPlayingSafe(false);
        }
      } else {
        try {
          player.pause();
        } catch (error) {
          logger.debug?.('VideoPlayer: pause after fullscreen failed', error);
        }
        setIsPlayingSafe(false);
      }
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
    if (!nativePlaying && pauseForFullscreenRef.current) {
      return;
    }
    setIsPlayingSafe(!!nativePlaying);
  }, [nativePlaying, setIsPlayingSafe]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setCurrentTimeSafe(timeUpdate?.currentTime ?? 0);
    }
  }, [setCurrentTimeSafe, timeUpdate?.currentTime]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setIsLoadingSafe(status === 'loading');
      const nativeDuration = player.duration || 0;
      if (nativeDuration > 0) {
        setDurationSafe(nativeDuration);
        updateDuration(nativeDuration);
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
    return () => {
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

  const effectiveDuration =
    Platform.OS === 'web'
      ? duration || durationRef.current || 0
      : player.duration || duration || durationRef.current || 0;

  const progressPercentage =
    effectiveDuration > 0 && Number.isFinite(currentTime)
      ? Math.min(100, Math.max(0, (currentTime / effectiveDuration) * 100))
      : 0;

  const renderWebVideo = () => (
    <TouchableOpacity
      style={[styles.videoContainer, { height: maxHeight }]}
      onPress={handleVideoPress}
      activeOpacity={1}
    >
      <video
        ref={videoRef}
        src={resolvedUri}
        style={{ width: '100%', height: '100%', backgroundColor: '#000', borderRadius: 8 }}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlayingSafe(true)}
        onPause={() => setIsPlayingSafe(false)}
        muted={isMuted}
        playsInline
        preload="auto"
      />
      {renderLoadingOverlay()}
      {renderControlsOverlay()}
    </TouchableOpacity>
  );

  const shouldShowLoading = isLoading || resolving;
  const shouldShowControls = showControlsProp && showControlsVisible && !shouldShowLoading;
  const disableSpeedControl = shouldShowLoading || !resolvedUri;
  const formattedProgressLabel = useMemo(() => {
    return `${formatTime(currentTime)} / ${formatTime(effectiveDuration)}`;
  }, [currentTime, effectiveDuration]);

  const renderLoadingOverlay = () => {
    if (!shouldShowLoading) {
      return null;
    }

    return (
      <View style={styles.loadingOverlay}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.text }]}>Loading video...</Text>
      </View>
    );
  };

  const renderControlsOverlay = () => {
    if (!shouldShowControls) {
      return null;
    }

    if (isMinimalControls) {
      return (
        <View style={[styles.controlsOverlay, styles.controlsOverlayMinimal]}>
          <TouchableOpacity style={[styles.controlButton, styles.playButton]} onPress={togglePlayPause}>
            {isPlaying ? <Pause size={32} color="white" /> : <Play size={32} color="white" />}
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <View style={styles.controlsOverlay}>
        <View style={styles.topControls}>
          <TouchableOpacity
            style={styles.controlButton}
            onPress={(event) => {
              event.stopPropagation?.();
              onSharePress(event);
            }}
          >
            <Share2 size={20} color="white" />
          </TouchableOpacity>
        </View>

        <View style={styles.mainControls}>
          <TouchableOpacity style={[styles.controlButton, styles.playButton]} onPress={togglePlayPause}>
            {isPlaying ? <Pause size={32} color="white" /> : <Play size={32} color="white" />}
          </TouchableOpacity>
        </View>

        <View style={styles.bottomControls}>
          <View style={styles.progressRow}>
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

          <View style={styles.actionsRow}>
            <View style={styles.actionsLeft}>
              <TouchableOpacity style={styles.controlButton} onPress={toggleMute}>
                {isMuted ? <VolumeX size={20} color="white" /> : <Volume2 size={20} color="white" />}
              </TouchableOpacity>

              {onDownload ? (
                <TouchableOpacity style={styles.controlButton} onPress={onDownload}>
                  <Download size={20} color="white" />
                </TouchableOpacity>
              ) : null}
            </View>

            <View style={styles.actionsRight}>
              <TouchableOpacity
                style={[
                  styles.controlButton,
                  styles.speedButton,
                  disableSpeedControl ? styles.controlButtonDisabled : null,
                ]}
                onPress={cyclePlaybackSpeed}
                disabled={disableSpeedControl}
                accessibilityRole="button"
                accessibilityLabel="Toggle playback speed"
              >
                <Gauge size={20} color="white" />
                <Text style={styles.speedLabel}>{playbackSpeedLabel}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.controlButton} onPress={handleFullscreenPress}>
                {Platform.OS === 'web' ? (
                  isWebFullscreen ? <Minimize size={20} color="white" /> : <Maximize size={20} color="white" />
                ) : (
                  <Maximize size={20} color="white" />
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    );
  };

  const renderNativeVideoSurface = () => (
    <View style={styles.inlineVideoWrapper}>
      <VideoView
        ref={videoViewRef as any}
        style={styles.inlineVideoSurface}
        player={player}
        nativeControls={false}
        allowsPictureInPicture
        allowsFullscreen
        contentFit="contain"
        {...(Platform.OS === 'android' ? { surfaceType: 'textureView' as const } : {})}
      />
      {renderLoadingOverlay()}
      {renderControlsOverlay()}
    </View>
  );

  const renderMobileVideo = () => (
    <>
      <TouchableOpacity
        activeOpacity={1}
        onPress={handleVideoPress}
        style={[
          styles.videoContainer,
          { height: maxHeight },
          isNativeFullscreenVisible ? styles.hiddenInlineWhileFullscreen : null,
        ]}
      >
        {renderNativeVideoSurface()}
      </TouchableOpacity>

      {nativeFullscreenConfig ? (
        <FullscreenVideoModal
          key={`${nativeFullscreenConfig.sourceUri}-${nativeFullscreenConfig.startTime}`}
          config={nativeFullscreenConfig}
          onDismiss={handleNativeFullscreenDismiss}
          onSharePress={onSharePress}
          onDownload={onDownload}
        />
      ) : null}
    </>
  );


  return Platform.OS === 'web' ? renderWebVideo() : renderMobileVideo();
}

function FullscreenVideoModal({ config, onDismiss, onSharePress, onDownload }: FullscreenVideoModalProps) {
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
  const initialSyncDoneRef = useRef(false);
  const playbackRateSyncedRef = useRef(false);

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

  const player = useVideoPlayer({ uri: sourceUri }, (p: ExpoVideoPlayer) => {
    p.loop = false;
    p.muted = initialMuted;
    p.timeUpdateEventInterval = 0.25;
    p.preservesPitch = true;
    try {
      p.playbackRate = initialSpeed;
    } catch {}
  });

  const { isPlaying: nativePlaying } = useEvent(player, 'playingChange', {
    isPlaying: player.playing,
  });
  const timeUpdate = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    bufferedPosition: player.bufferedPosition ?? 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
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

  useEffect(() => {
    initialSyncDoneRef.current = false;
    playbackRateSyncedRef.current = false;
    setIsPlayingSafe(wasPlaying);
    setIsMuted(initialMuted);
    setPlaybackSpeed(initialSpeed);
    setCurrentTimeSafe(startTime);
    setShowControls(true);
  }, [initialMuted, initialSpeed, setCurrentTimeSafe, setIsPlayingSafe, sourceUri, startTime, wasPlaying]);

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
    setIsPlayingSafe(!!nativePlaying);
  }, [nativePlaying, setIsPlayingSafe]);

  useEffect(() => {
    if (typeof timeUpdate?.currentTime === 'number') {
      setCurrentTimeSafe(timeUpdate.currentTime);
    }
  }, [setCurrentTimeSafe, timeUpdate?.currentTime]);

  useEffect(() => () => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    try {
      player.pause();
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: cleanup pause failed', error);
    }
  }, [player]);

  const effectiveDuration = player.duration || duration || 0;
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
    } else {
      restartIfEnded();
      try {
        player.play();
        setIsPlayingSafe(true);
      } catch (error) {
        logger.debug?.('FullscreenVideoModal: play error', error);
        setIsPlayingSafe(false);
      }
    }
    setShowControls(true);
  };

  const toggleMute = () => {
    setIsMuted((prev) => !prev);
    setShowControls(true);
  };

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

  const handleVideoPress = () => {
    setShowControls((visible) => !visible);
  };

  const handleClose = useCallback(() => {
    try {
      player.pause();
    } catch (error) {
      logger.debug?.('FullscreenVideoModal: pause on close failed', error);
    }
    onDismiss({
      currentTime,
      isMuted,
      playbackSpeed,
      wasPlaying: isPlaying,
    });
  }, [currentTime, isMuted, isPlaying, onDismiss, playbackSpeed, player]);

  const shouldShowLoading = isLoading;
  const shouldShowControls = showControls && !shouldShowLoading;
  const disableSpeedControl = shouldShowLoading;
  const formattedProgressLabel = useMemo(() => {
    return `${formatTime(currentTime)} / ${formatTime(effectiveDuration)}`;
  }, [currentTime, effectiveDuration]);

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
        <TouchableOpacity activeOpacity={1} style={styles.fullscreenTouchable} onPress={handleVideoPress}>
          <View style={styles.fullscreenVideoWrapper}>
            <VideoView
              style={styles.fullscreenVideoSurface}
              player={player}
              nativeControls={false}
              allowsPictureInPicture
              allowsFullscreen
              contentFit="contain"
              {...(Platform.OS === 'android' ? { surfaceType: 'textureView' as const } : {})}
            />

            {shouldShowLoading ? (
              <View style={styles.fullscreenLoadingOverlay}>
                <ActivityIndicator size="large" color={theme.primary} />
                <Text style={styles.fullscreenLoadingText}>Loading video...</Text>
              </View>
            ) : null}

            {shouldShowControls ? (
              <View style={styles.fullscreenOverlay}>
                <View style={styles.fullscreenTopRow}>
                  <TouchableOpacity
                    style={[styles.fullscreenControlButton, styles.fullscreenCloseButton]}
                    onPress={(event) => {
                      event.stopPropagation?.();
                      handleClose();
                    }}
                  >
                    <X size={20} color="white" />
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.fullscreenControlButton}
                    onPress={(event) => {
                      event.stopPropagation?.();
                      onSharePress(event);
                    }}
                  >
                    <Share2 size={20} color="white" />
                  </TouchableOpacity>
                </View>

                <View style={styles.fullscreenMainControls}>
                  <TouchableOpacity
                    style={[styles.fullscreenControlButton, styles.fullscreenPlayButton]}
                    onPress={togglePlayPause}
                  >
                    {isPlaying ? <Pause size={32} color="white" /> : <Play size={32} color="white" />}
                  </TouchableOpacity>
                </View>

                <View style={styles.fullscreenBottomControls}>
                  <View style={styles.fullscreenProgressRow}>
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

                  <View style={styles.fullscreenActionsRow}>
                    <View style={styles.fullscreenActionsLeft}>
                      <TouchableOpacity style={styles.fullscreenControlButton} onPress={toggleMute}>
                        {isMuted ? <VolumeX size={20} color="white" /> : <Volume2 size={20} color="white" />}
                      </TouchableOpacity>

                      {onDownload ? (
                        <TouchableOpacity
                          style={styles.fullscreenControlButton}
                          onPress={(event) => {
                            event.stopPropagation?.();
                            onDownload();
                          }}
                        >
                          <Download size={20} color="white" />
                        </TouchableOpacity>
                      ) : null}
                    </View>

                    <View style={styles.fullscreenActionsRight}>
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
              </View>
            ) : null}
          </View>
        </TouchableOpacity>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 8,
    overflow: 'hidden',
    marginVertical: 2,
  },
  videoContainer: {
    position: 'relative',
    backgroundColor: '#000',
    borderRadius: 8,
    overflow: 'hidden',
  },
  hiddenInlineWhileFullscreen: {
    opacity: 0,
    pointerEvents: 'none',
  },
  inlineVideoWrapper: {
    flex: 1,
    position: 'relative',
  },
  inlineVideoSurface: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
    borderRadius: 8,
  },
  fullscreenVideoWrapper: {
    flex: 1,
    position: 'relative',
  },
  fullscreenVideoSurface: {
    flex: 1,
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 8,
    fontSize: 14,
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
  },
  controlsOverlayMinimal: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 0,
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
  },
  fullscreenLoadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(6,10,24,0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 12,
  },
  fullscreenLoadingText: {
    marginTop: 8,
    fontSize: 14,
    color: 'rgba(255,255,255,0.92)',
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
