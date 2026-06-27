import { useEffect } from 'react';
import { Platform } from 'react-native';

type MediaSessionOptions = {
  isPlaying: boolean;
  title: string | null;
  duration: number;
  currentTime: number;
  playbackRate: number;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeekBackward: (offset: number) => void;
  onSeekForward: (offset: number) => void;
  onSeekTo: (time: number) => void;
};

/**
 * Registers Media Session API handlers so the browser's notification panel
 * pause/play/seek buttons work with the video player.
 * Only active on web; no-op on native.
 */
export function useMediaSession({
  isPlaying,
  title,
  duration,
  currentTime,
  playbackRate,
  onPlay,
  onPause,
  onStop,
  onSeekBackward,
  onSeekForward,
  onSeekTo,
}: MediaSessionOptions): void {
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const ms = (navigator as any).mediaSession;
    const handlers: Array<[string, ((args?: any) => void) | null]> = [
      ['play', onPlay],
      ['pause', onPause],
      ['stop', onStop],
      ['seekbackward', ({ seekOffset }: any) => onSeekBackward(seekOffset ?? 10)],
      ['seekforward', ({ seekOffset }: any) => onSeekForward(seekOffset ?? 10)],
      ['seekto', ({ seekTime }: any) => seekTime != null && onSeekTo(seekTime)],
    ];
    try {
      for (const [action, handler] of handlers) {
        ms.setActionHandler(action, handler);
      }
    } catch { /* Some browsers don't support all actions */ }
    return () => {
      try {
        for (const [action] of handlers) ms.setActionHandler(action, null);
      } catch { /* ignore */ }
    };
  }, [onPause, onPlay, onSeekBackward, onSeekForward, onSeekTo, onStop]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    const ms = (navigator as any).mediaSession;
    try {
      if (title) {
        ms.metadata = new (window as any).MediaMetadata({ title, artist: 'Tuition Manager' });
      }
      ms.playbackState = isPlaying ? 'playing' : 'paused';
    } catch { /* ignore */ }
  }, [isPlaying, title]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    if (!duration || duration <= 0) return;
    try {
      const ms = (navigator as any).mediaSession;
      if (typeof ms.setPositionState === 'function') {
        ms.setPositionState({ duration, playbackRate, position: Math.min(currentTime, duration) });
      }
    } catch { /* ignore */ }
  }, [currentTime, duration, playbackRate]);
}
