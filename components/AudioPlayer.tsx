import { logger } from '@/lib/logger';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  PanResponder,
  ActivityIndicator,
  type GestureResponderEvent,
  type PanResponderInstance,
  type PanResponderGestureState,
  type LayoutChangeEvent,
} from 'react-native';
import { Play, Pause, Volume2, Download, Share, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { formatFileSize } from '../lib/fileUtils';
import { ShareModal } from './ShareModal';
import { chatCacheService } from '../services/chatCacheService';
import * as FileSystem from 'expo-file-system';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView, type VideoSource } from 'expo-video';

interface AudioPlayerProps {
  fileUrl: string;
  fileName: string;
  fileSize?: number;
  onDownload?: () => void;
  onShare?: () => void;
  shareUrl?: string;
}

interface InternalAudioPlayerProps extends AudioPlayerProps {
  resolvedUrl: string | null;
  resolving: boolean;
}

const ExpoVideoAudioPlayer: React.FC<InternalAudioPlayerProps> = ({
  fileUrl,
  fileName,
  fileSize,
  onDownload,
  onShare,
  shareUrl,
  resolvedUrl,
  resolving,
}) => {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [showShareModal, setShowShareModal] = useState(false);
  const [playbackUri, setPlaybackUri] = useState<string | null>(resolvedUrl ?? null);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubPosition, setScrubPosition] = useState<number | null>(null);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [hasEnded, setHasEnded] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const progressBarRef = useRef<any>(null);
  const progressMetricsRef = useRef({ width: 0, pageX: 0 });

  const sanitizeResolvedUri = useCallback(
    (candidate: string | null | undefined): string | null => {
      if (!candidate) {
        return null;
      }

      if (/^data:image\/svg/i.test(candidate)) {
        if (fileUrl && !/^data:image\/svg/i.test(fileUrl)) {
          return fileUrl;
        }

        if (shareUrl && !/^data:image\/svg/i.test(shareUrl)) {
          return shareUrl;
        }

        return null;
      }

      return candidate;
    },
    [fileUrl, shareUrl]
  );

  const effectiveResolvedUrl = useMemo(() => sanitizeResolvedUri(resolvedUrl), [sanitizeResolvedUri, resolvedUrl]);

  useEffect(() => {
    let cancelled = false;

    const resolvePlaybackUri = async () => {
      const candidate = effectiveResolvedUrl;

      if (!candidate) {
        if (!cancelled) {
          setPlaybackUri(null);
        }
        return;
      }

      if (Platform.OS === 'android' && candidate.startsWith('file://')) {
        try {
          const contentUri = await FileSystem.getContentUriAsync(candidate);
          if (!cancelled) {
            setPlaybackUri(contentUri ?? candidate);
          }
          return;
        } catch (uriError) {
          logger.debug('AudioPlayer: failed to map file URI to content URI on Android', uriError);
        }
      }

      if (!cancelled) {
        setPlaybackUri(candidate);
      }
    };

    void resolvePlaybackUri();

    return () => {
      cancelled = true;
    };
  }, [effectiveResolvedUrl]);

  const videoSource = useMemo<VideoSource>(() => playbackUri ?? null, [playbackUri]);

  const player = useVideoPlayer(videoSource, (instance) => {
    instance.loop = false;
    instance.muted = false;
    instance.timeUpdateEventInterval = 0.25;
    instance.staysActiveInBackground = true;
    instance.showNowPlayingNotification = false;
  });

  const playingChange = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const timeUpdate = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    bufferedPosition: player.bufferedPosition ?? 0,
    currentLiveTimestamp: player.currentLiveTimestamp,
    currentOffsetFromLive: player.currentOffsetFromLive,
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const playbackRateChange = useEvent(player, 'playbackRateChange', { playbackRate: player.playbackRate ?? 1 });

  const isPlaying = playingChange.isPlaying;
  const position = useMemo(() => {
    const next = timeUpdate.currentTime ?? player.currentTime ?? 0;
    return Number.isFinite(next) && next >= 0 ? next : 0;
  }, [player, timeUpdate]);

  const displayedPosition = scrubPosition ?? position;

  const duration = useMemo(() => {
    const next = player.duration;
    return Number.isFinite(next) && next > 0 ? next : 0;
  }, [player, status, timeUpdate]);

  const bufferedPercent = useMemo(() => {
    if (!duration) {
      return 0;
    }
    const buffered = timeUpdate.bufferedPosition ?? 0;
    if (!Number.isFinite(buffered) || buffered <= 0) {
      return 0;
    }
    const ratio = Math.min(1, Math.max(0, buffered / duration));
    return ratio * 100;
  }, [duration, timeUpdate]);

  const isLoading = resolving || status === 'loading';

  useEffect(() => {
    return () => {
      try {
        player.pause();
      } catch {}
    };
  }, [player]);

  useEffect(() => {
    try {
      player.preservesPitch = true;
      setPlaybackRate(player.playbackRate ?? 1);
    } catch (err) {
      logger.debug('AudioPlayer: unable to initialize playback rate', err);
    }
  }, [player]);

  useEffect(() => {
    const nextRate = playbackRateChange.playbackRate;
    if (typeof nextRate === 'number' && Number.isFinite(nextRate)) {
      setPlaybackRate(nextRate);
    }
  }, [playbackRateChange.playbackRate]);

  useEffect(() => {
    if (isPlaying) {
      setHasEnded(false);
    }
  }, [isPlaying]);

  useEffect(() => {
    if (!duration) {
      return;
    }

    const tolerance = 0.1;
    if (!isPlaying && position >= Math.max(0, duration - tolerance)) {
      setHasEnded(true);
    }
  }, [duration, isPlaying, position]);

  const formatTime = useCallback((seconds: number): string => {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return '0:00';
    }
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }, []);

  const togglePlayPause = useCallback(async () => {
    if (resolving) {
      return;
    }

    if (!playbackUri) {
      return;
    }

    try {
      if (isPlaying) {
        player.pause();
        return;
      }

      if (status === 'error') {
        try {
          await player.replaceAsync(videoSource ?? null);
        } catch (replaceError) {
          logger.error('AudioPlayer: failed to reload source', replaceError);
          return;
        }
      }

  const playbackDuration = duration ?? 0;
  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  const shouldRestart = hasEnded || (playbackDuration > 0 && currentTime >= playbackDuration - 0.1);
      if (shouldRestart) {
        try {
          player.currentTime = 0;
        } catch (resetError) {
          logger.debug('AudioPlayer: failed to reset playback after ending', resetError);
        }
        setHasEnded(false);
      }
      player.play();
    } catch (err) {
      logger.error('AudioPlayer: error toggling playback', err);
    }
  }, [duration, hasEnded, isPlaying, playbackUri, player, resolving, setHasEnded, status, videoSource]);

  const updateProgressMetrics = useCallback(() => {
    if (!progressBarRef.current) {
      return;
    }
    try {
      progressBarRef.current.measureInWindow((pageX: number, _pageY: number, width: number) => {
        if (Number.isFinite(width)) {
          progressMetricsRef.current.width = width;
        }
        if (Number.isFinite(pageX)) {
          progressMetricsRef.current.pageX = pageX;
        }
      });
    } catch (err) {
      logger.debug('AudioPlayer: failed to measure progress bar', err);
    }
  }, []);

  const clampToUnit = useCallback((value: number) => {
    return Math.min(1, Math.max(0, value));
  }, []);

  const ratioFromEvent = useCallback(
    (event: any): number | null => {
      const metrics = progressMetricsRef.current;
      if (!metrics.width) {
        return null;
      }

      const { locationX, pageX } = event?.nativeEvent ?? {};
      if (typeof locationX === 'number' && Number.isFinite(locationX)) {
        return clampToUnit(locationX / metrics.width);
      }

      if (
        typeof pageX === 'number' &&
        Number.isFinite(pageX) &&
        typeof metrics.pageX === 'number' &&
        Number.isFinite(metrics.pageX)
      ) {
        return clampToUnit((pageX - metrics.pageX) / metrics.width);
      }

      return null;
    },
    [clampToUnit]
  );

  const commitSeek = useCallback(
    (ratio: number | null, fallbackPosition: number) => {
      const targetRatio = ratio != null ? ratio : clampToUnit(fallbackPosition / Math.max(duration, 1));
      const newTime = targetRatio * duration;
      if (!Number.isFinite(newTime)) {
        return;
      }

      try {
        player.currentTime = newTime;
        setHasEnded(false);
      } catch (err) {
        logger.error('AudioPlayer: error seeking', err);
      }
    },
    [clampToUnit, duration, player, setHasEnded]
  );

  const handleProgressLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width } = event.nativeEvent.layout;
      if (Number.isFinite(width)) {
        progressMetricsRef.current.width = width;
      }
      updateProgressMetrics();
    },
    [updateProgressMetrics]
  );

  const handleProgressGrant = useCallback(
    (event: GestureResponderEvent) => {
      if (!duration || resolving) {
        return;
      }
      updateProgressMetrics();
      const ratio = ratioFromEvent(event);
      if (ratio == null) {
        return;
      }
      setIsScrubbing(true);
      setScrubPosition(ratio * duration);
    },
    [duration, ratioFromEvent, resolving, updateProgressMetrics]
  );

  const handleProgressMove = useCallback(
    (event: GestureResponderEvent) => {
      if (!duration || !isScrubbing) {
        return;
      }
      const ratio = ratioFromEvent(event);
      if (ratio == null) {
        return;
      }
      setScrubPosition(ratio * duration);
    },
    [duration, isScrubbing, ratioFromEvent]
  );

  const handleProgressRelease = useCallback(
    (event: GestureResponderEvent) => {
      if (!duration || !isScrubbing) {
        setIsScrubbing(false);
        setScrubPosition(null);
        return;
      }

      const ratio = ratioFromEvent(event);
      commitSeek(ratio, scrubPosition ?? position);
      setIsScrubbing(false);
      setScrubPosition(null);
    },
    [commitSeek, duration, isScrubbing, position, ratioFromEvent, scrubPosition]
  );

  const progressPanResponder = useMemo<PanResponderInstance>(() => {
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event: GestureResponderEvent, _gestureState: PanResponderGestureState) => {
        handleProgressGrant(event);
      },
      onPanResponderMove: (event: GestureResponderEvent, _gestureState: PanResponderGestureState) => {
        handleProgressMove(event);
      },
      onPanResponderRelease: (event: GestureResponderEvent, _gestureState: PanResponderGestureState) => {
        handleProgressRelease(event);
      },
      onPanResponderTerminate: (event: GestureResponderEvent, _gestureState: PanResponderGestureState) => {
        handleProgressRelease(event);
      },
    });
  }, [handleProgressGrant, handleProgressMove, handleProgressRelease]);

  const skipBackward = useCallback(() => {
    if (!duration || resolving || isScrubbing) {
      return;
    }

    try {
      setHasEnded(false);
      player.seekBy(-10);
    } catch (err) {
      logger.error('AudioPlayer: error skipping backward', err);
    }
  }, [duration, isScrubbing, player, resolving, setHasEnded]);

  const skipForward = useCallback(() => {
    if (!duration || resolving || isScrubbing) {
      return;
    }

    try {
      setHasEnded(false);
      player.seekBy(10);
    } catch (err) {
      logger.error('AudioPlayer: error skipping forward', err);
    }
  }, [duration, isScrubbing, player, resolving, setHasEnded]);

  const handleDownload = useCallback(() => {
    if (typeof onDownload === 'function') {
      try {
        onDownload();
      } catch (error) {
        logger.debug('AudioPlayer: onDownload handler error', error);
      }
      return;
    }

    Alert.alert('Download', 'Unable to download this audio file.');
  }, [onDownload]);

  const handleShare = useCallback(() => {
    if (onShare) {
      try {
        onShare();
      } catch (shareError) {
        logger.debug('AudioPlayer: onShare handler error', shareError);
      }
    }
    setShowShareModal(true);
  }, [onShare]);

  const progressPercent = useMemo(() => {
    if (!duration) {
      return 0;
    }
    return Math.max(0, Math.min(100, (displayedPosition / duration) * 100));
  }, [displayedPosition, duration]);

  const elapsedLabel = useMemo(() => formatTime(displayedPosition), [displayedPosition, formatTime]);
  const durationLabel = useMemo(() => (duration > 0 ? formatTime(duration) : '0:00'), [duration, formatTime]);

  const playbackRates = useMemo(() => [0.75, 1, 1.25, 1.5, 1.75, 2], []);

  const cyclePlaybackRate = useCallback(() => {
    const currentRate = playbackRate;
    const currentIndex = playbackRates.findIndex((rate) => Math.abs(rate - currentRate) < 0.001);
    const fallbackIndex = Math.max(playbackRates.indexOf(1), 0);
    const safeIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
    const nextIndex = (safeIndex + 1) % playbackRates.length;
    const nextRate = playbackRates[nextIndex];

    try {
      player.preservesPitch = true;
      player.playbackRate = nextRate;
      setPlaybackRate(nextRate);
    } catch (err) {
      logger.error('AudioPlayer: failed to change playback speed', err);
    }
  }, [playbackRate, playbackRates, player]);

  const playbackRateLabel = useMemo(() => {
    const rounded = Math.round(playbackRate * 100) / 100;
    const formatted = Number.isInteger(rounded)
      ? rounded.toFixed(0)
      : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${formatted}x`;
  }, [playbackRate]);

  const disableSpeed = isLoading || !playbackUri;

  const disableSkip = isLoading || resolving || !duration || isScrubbing;

  const crossOrigin = useMemo(() => {
    if (!playbackUri) {
      return undefined;
    }
    return /^https?:/i.test(playbackUri) ? 'anonymous' : undefined;
  }, [playbackUri]);

  return (
    <View style={styles.container}>
      <VideoView
        player={player}
        nativeControls={false}
        allowsFullscreen={false}
        allowsPictureInPicture={false}
        playsInline
        pointerEvents="none"
        crossOrigin={crossOrigin}
        style={styles.hiddenVideo}
      />

      <View style={styles.header}>
        <Volume2 size={24} color="#8B5CF6" style={styles.icon} />
        <View style={styles.fileInfo}>
          <Text style={styles.fileName}>{fileName}</Text>
          <Text style={styles.fileType}>Audio File</Text>
          {fileSize && <Text style={styles.fileSize}>{formatFileSize(fileSize)}</Text>}
        </View>
      </View>

      <View style={styles.controls}>
        <View style={styles.playbackRow}>
          <TouchableOpacity style={styles.skipButton} onPress={skipBackward} disabled={disableSkip}>
            <ChevronLeft size={20} color={theme.text} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.playButton, isPlaying ? styles.playButtonActive : null]}
            onPress={togglePlayPause}
            disabled={isLoading || resolving || !playbackUri}
          >
            {isLoading || resolving ? (
              <ActivityIndicator size="small" color="white" />
            ) : isPlaying ? (
              <Pause size={28} color="white" />
            ) : (
              <Play size={28} color="white" />
            )}
          </TouchableOpacity>

          <TouchableOpacity style={styles.skipButton} onPress={skipForward} disabled={disableSkip}>
            <ChevronRight size={20} color={theme.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.progressSection}>
          <View
            ref={progressBarRef}
            style={styles.progressBar}
            onLayout={handleProgressLayout}
            {...progressPanResponder.panHandlers}
          >
            <View style={[styles.progressBuffered, { width: `${bufferedPercent}%` }]} />
            <View style={[styles.progressFill, { width: `${progressPercent}%` }]} />
            <View style={[styles.progressHandle, { left: `${progressPercent}%` }]} />
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.timeText}>{elapsedLabel}</Text>
            <Text style={styles.timeText}>{durationLabel}</Text>
          </View>
        </View>

        <View style={styles.bottomRow}>
          <View style={styles.actionButtons}>
            <TouchableOpacity style={styles.actionButton} onPress={handleDownload} disabled={downloading}>
              <Download size={20} color={theme.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={handleShare}>
              <Share size={20} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.speedButton, disableSpeed ? styles.speedButtonDisabled : null]}
            onPress={cyclePlaybackRate}
            disabled={disableSpeed}
            accessibilityRole="button"
            accessibilityLabel="Toggle playback speed"
          >
            <Text style={styles.speedButtonText}>{playbackRateLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ShareModal
        visible={showShareModal}
        onClose={() => setShowShareModal(false)}
        fileUrl={shareUrl || resolvedUrl || fileUrl}
        fileName={fileName}
        fileSize={fileSize}
        onDownload={onDownload}
      />
    </View>
  );
};

// Create styles function
const createStyles = (theme: any) => StyleSheet.create({
  container: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 20,
    marginVertical: 12,
    borderWidth: 1,
    borderColor: theme.border,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12,
    elevation: 3,
  },
  hiddenVideo: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  icon: {
    marginRight: 12,
  },
  fileInfo: {
    flex: 1,
  },
  fileName: {
    fontSize: 16,
    fontWeight: '600',
    color: theme.text,
    marginBottom: 4,
  },
  fileType: {
    fontSize: 14,
    color: theme.textSecondary,
  },
  fileSize: {
    fontSize: 14,
    color: theme.textSecondary,
  },
  controls: {
    marginTop: 16,
    gap: 20,
  },
  playbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.primary,
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    flex: 1,
    marginRight: 12,
  },
  primaryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  playButton: {
    backgroundColor: theme.primary,
    borderRadius: 32,
    width: 64,
    height: 64,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  playButtonActive: {
    shadowOpacity: 0,
    elevation: 0,
  },
  skipButton: {
    backgroundColor: theme.surface,
    borderRadius: 20,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.border,
  },
  progressSection: {
    gap: 10,
  },
  progressBar: {
    position: 'relative',
    height: 8,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: theme.border,
    cursor: Platform.OS === 'web' ? 'pointer' : 'auto',
  },
  progressBuffered: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: theme.borderStrong ?? theme.border,
  },
  progressFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: theme.primary,
  },
  progressHandle: {
    position: 'absolute',
    top: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.primary,
    borderWidth: 2,
    borderColor: theme.surface,
    transform: [{ translateX: -10 }],
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowOffset: { width: 0, height: 3 },
    shadowRadius: 4,
    elevation: 2,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  timeText: {
    fontSize: 12,
    color: theme.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    padding: 8,
    borderRadius: 8,
    backgroundColor: theme.background,
  },
  speedButton: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    minWidth: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedButtonDisabled: {
    opacity: 0.6,
  },
  speedButtonText: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '600',
  },
  description: {
    fontSize: 14,
    color: theme.textSecondary,
    textAlign: 'center',
    marginTop: 8,
  },
});

// Main AudioPlayer component that chooses the right implementation
export function AudioPlayer(props: AudioPlayerProps) {
  const { theme } = useTheme();
  const [resolvedUrl, setResolvedUrl] = useState(props.fileUrl);
  const [resolving, setResolving] = useState(false);

  const defaultDownload = useCallback(async () => {
    const candidateUrl = props.shareUrl || resolvedUrl || props.fileUrl;
    if (!candidateUrl) {
      Alert.alert('Download', 'Missing download URL');
      return;
    }

    if (Platform.OS === 'web') {
      try {
        const anchor = document.createElement('a');
        anchor.href = candidateUrl;
        anchor.download = props.fileName || 'audio';
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } catch (error) {
        logger.debug('AudioPlayer: web download fallback', error);
        try {
          window.open(candidateUrl, '_blank', 'noopener,noreferrer');
        } catch {}
      }
      return;
    }

    try {
      const hint = candidateUrl.startsWith('file://') ? candidateUrl : undefined;
      const localUri = await chatCacheService.getMediaForDownload(
        candidateUrl,
        props.fileName,
        hint,
        'normal',
        { lazy: false }
      );

      const uriToShare = localUri || hint || candidateUrl;
      const Sharing = require('expo-sharing') as typeof import('expo-sharing');
      const available = typeof Sharing.isAvailableAsync === 'function' ? await Sharing.isAvailableAsync() : true;
      if (!available) {
        Alert.alert('Download', 'Sharing is not available on this device');
        return;
      }

      await Sharing.shareAsync(uriToShare, {
        dialogTitle: `Download ${props.fileName}`,
        mimeType: props.fileName?.toLowerCase?.().endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg',
        UTI: 'public.audio',
      } as any);
    } catch (error) {
      logger.error('AudioPlayer: download failed', error);
      Alert.alert('Download', 'Failed to download audio. Please try again.');
    }
  }, [props.fileName, props.fileUrl, props.shareUrl, resolvedUrl]);

  useEffect(() => {
    let cancelled = false;
    const resolveMedia = async () => {
      try {
        setResolving(true);
        const hint = props.fileUrl.startsWith('file://') ? props.fileUrl : undefined;
        const localUri = await chatCacheService.getMediaForDownload(
          props.fileUrl,
          props.fileName,
          hint,
          'normal',
          { lazy: true }
        );
        if (cancelled) {
          return;
        }

        if (localUri && /^data:image\/svg/i.test(localUri)) {
          setResolvedUrl(props.fileUrl);
          return;
        }

        if (localUri) {
          setResolvedUrl(localUri);
          return;
        }
        setResolvedUrl(props.fileUrl);
      } catch (error) {
        logger.debug('AudioPlayer: failed to resolve media, using remote', error);
        if (!cancelled) {
          setResolvedUrl(props.fileUrl);
        }
      } finally {
        if (!cancelled) {
          setResolving(false);
        }
      }
    };

    void resolveMedia();
    return () => {
      cancelled = true;
    };
  }, [props.fileUrl, props.fileName]);
  
  // Check if audio is supported based on platform and available APIs
  const isSupported = (() => {
    if (Platform.OS === 'web') {
      // For web, check if we have document API (browser environment)
      return typeof window !== 'undefined' && typeof document !== 'undefined';
    } else {
      // For native, assume audio support
      return true;
    }
  })();

  // If audio is not supported, show a simple file attachment
  if (!isSupported) {
    const styles = createStyles(theme);
    const downloadHandler = props.onDownload ?? (() => void defaultDownload());
    
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Volume2 size={24} color="#8B5CF6" style={styles.icon} />
          <View style={styles.fileInfo}>
            <Text style={styles.fileName}>{props.fileName}</Text>
            <Text style={styles.fileType}>Audio File</Text>
            {props.fileSize && (
              <Text style={styles.fileSize}>{formatFileSize(props.fileSize)}</Text>
            )}
          </View>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity 
            style={[styles.primaryButton, { backgroundColor: theme.border }]} 
            onPress={() => Alert.alert('Info', 'Audio playback not supported on this platform')}
          >
            <Play size={20} color={theme.textSecondary} />
            <Text style={[styles.primaryButtonText, { color: theme.textSecondary }]}>
              Audio Playback Not Supported
            </Text>
          </TouchableOpacity>

          <View style={styles.actionButtons}>
            <TouchableOpacity style={styles.actionButton} onPress={downloadHandler}>
              <Download size={20} color={theme.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={() => props.onShare?.()}>
              <Share size={20} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        <Text style={styles.description}>
          Download the file to play it with your preferred audio app
        </Text>
      </View>
    );
  }

  // Use appropriate player based on platform
  const playerProps: InternalAudioPlayerProps = {
    ...props,
    onDownload: props.onDownload ?? (() => void defaultDownload()),
    resolvedUrl,
    resolving,
  };

  return <ExpoVideoAudioPlayer {...playerProps} />;
}