import { useState, useCallback } from 'react';
import type { VideoPlayerStatus } from 'expo-video';

/**
 * Centralises web video element state (status, buffering, errors, etc.)
 * Separating this from the component keeps VideoPlayerLoaded focused on
 * orchestration rather than raw DOM event tracking.
 */
export type WebVideoState = {
  webStatus: VideoPlayerStatus;
  webBufferedPercent: number | null;
  webIsBuffering: boolean;
  webIsStalled: boolean;
  webPlaybackError: string | null;
  webEnded: boolean;
};

export type WebVideoHandlers = {
  handleWebLoadStart: () => void;
  handleWebCanPlay: () => void;
  handleWebWaiting: () => void;
  handleWebStalled: () => void;
  handleWebPlaying: () => void;
  handleWebError: (videoElement?: HTMLVideoElement | null) => void;
  handleWebEnded: () => void;
  resetWebState: () => void;
};

export function useWebVideoState(): WebVideoState & WebVideoHandlers & {
  setWebBufferedPercent: React.Dispatch<React.SetStateAction<number | null>>;
  setWebIsBuffering: React.Dispatch<React.SetStateAction<boolean>>;
  setWebIsStalled: React.Dispatch<React.SetStateAction<boolean>>;
  setWebStatus: React.Dispatch<React.SetStateAction<VideoPlayerStatus>>;
  setWebPlaybackError: React.Dispatch<React.SetStateAction<string | null>>;
  setWebEnded: React.Dispatch<React.SetStateAction<boolean>>;
} {
  const [webStatus, setWebStatus] = useState<VideoPlayerStatus>('idle');
  const [webBufferedPercent, setWebBufferedPercent] = useState<number | null>(null);
  const [webIsBuffering, setWebIsBuffering] = useState(false);
  const [webIsStalled, setWebIsStalled] = useState(false);
  const [webPlaybackError, setWebPlaybackError] = useState<string | null>(null);
  const [webEnded, setWebEnded] = useState(false);

  const handleWebLoadStart = useCallback(() => {
    setWebStatus('loading');
    setWebPlaybackError(null);
    setWebEnded(false);
  }, []);

  const handleWebCanPlay = useCallback(() => {
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

  const handleWebError = useCallback((videoElement?: HTMLVideoElement | null) => {
    // Distinguish codec/format errors from network errors for better UX.
    // MediaError codes: 3=MEDIA_ERR_DECODE, 4=MEDIA_ERR_SRC_NOT_SUPPORTED
    const mediaError = videoElement?.error;
    const isFormatError = mediaError && (mediaError.code === 4 || mediaError.code === 3);
    setWebPlaybackError(isFormatError ? 'unsupported-codec' : 'Playback failed');
    setWebStatus('error');
  }, []);

  const handleWebEnded = useCallback(() => {
    setWebEnded(true);
  }, []);

  const resetWebState = useCallback(() => {
    setWebStatus('loading');
    setWebPlaybackError(null);
    setWebEnded(false);
    setWebBufferedPercent(null);
    setWebIsBuffering(false);
    setWebIsStalled(false);
  }, []);

  return {
    webStatus,
    webBufferedPercent,
    webIsBuffering,
    webIsStalled,
    webPlaybackError,
    webEnded,
    setWebBufferedPercent,
    setWebIsBuffering,
    setWebIsStalled,
    setWebStatus,
    setWebPlaybackError,
    setWebEnded,
    handleWebLoadStart,
    handleWebCanPlay,
    handleWebWaiting,
    handleWebStalled,
    handleWebPlaying,
    handleWebError,
    handleWebEnded,
    resetWebState,
  };
}
