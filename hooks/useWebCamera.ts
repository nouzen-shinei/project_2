import { useState, useCallback, useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebCameraHookState {
  stream: MediaStream | null;
  isRecording: boolean;
  deviceIds: string[];
  activeDeviceId: string | null;
  error: string | null;
}

interface WebCameraHookControls {
  startStream: (deviceId?: string) => Promise<void>;
  stopStream: () => void;
  capturePhoto: (videoEl: HTMLVideoElement) => Promise<{ uri: string; fileSize: number }>;
  startRecording: (
    onStop: (result: { uri: string; fileType: string; duration: number; fileSize: number }) => void
  ) => void;
  stopRecording: () => void;
  discardRecording: () => void;
  switchCamera: () => Promise<void>;
}

export type UseWebCameraReturn = WebCameraHookState & WebCameraHookControls;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWebCamera(): UseWebCameraReturn {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs — never cause re-renders
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  // Set to true by discardRecording() so onstop skips the onCapture callback
  const discardedRef = useRef(false);
  // Keep a stable ref to the latest stream so stopStream in the cleanup
  // closure always sees the current value even after state updates.
  const streamRef = useRef<MediaStream | null>(null);

  // Keep streamRef in sync with state
  const updateStream = (s: MediaStream | null) => {
    streamRef.current = s;
    setStream(s);
  };

  // ---------------------------------------------------------------------------
  // stopStream
  // ---------------------------------------------------------------------------
  const stopStream = useCallback(() => {
    const current = streamRef.current;
    if (current) {
      current.getTracks().forEach((t) => t.stop());
    }
    updateStream(null);
  }, []);

  // ---------------------------------------------------------------------------
  // startStream
  // ---------------------------------------------------------------------------
  const startStream = useCallback(async (deviceId?: string) => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return;
    }

    try {
      const videoConstraint: MediaTrackConstraints | boolean = deviceId
        ? { deviceId: { exact: deviceId } }
        : true;

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraint,
        audio: true,
      });

      updateStream(newStream);
      setError(null);

      // Enumerate video input devices and populate deviceIds
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices
        .filter((d) => d.kind === 'videoinput')
        .map((d) => d.deviceId)
        .filter(Boolean);

      setDeviceIds(videoInputs);

      // Determine which device is active
      const activeTracks = newStream.getVideoTracks();
      const activeId =
        activeTracks.length > 0
          ? activeTracks[0].getSettings().deviceId ?? deviceId ?? (videoInputs[0] || null)
          : deviceId ?? (videoInputs[0] || null);

      setActiveDeviceId(activeId ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to access camera';
      setError(message);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // capturePhoto — returns uri + actual blob size
  // ---------------------------------------------------------------------------
  const capturePhoto = useCallback(async (videoEl: HTMLVideoElement): Promise<{ uri: string; fileSize: number }> => {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth || 1280;
      canvas.height = videoEl.videoHeight || 720;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas 2D context'));
        return;
      }

      ctx.drawImage(videoEl, 0, 0);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Failed to capture photo: canvas.toBlob returned null'));
            return;
          }
          const url = URL.createObjectURL(blob);
          resolve({ uri: url, fileSize: blob.size });
        },
        'image/jpeg',
        0.9
      );
    });
  }, []);

  // ---------------------------------------------------------------------------
  // startRecording — callback includes fileSize
  // ---------------------------------------------------------------------------
  const startRecording = useCallback(
    (
      onStop: (result: { uri: string; fileType: string; duration: number; fileSize: number }) => void
    ) => {
      const currentStream = streamRef.current;
      if (!currentStream) {
        return;
      }

      // Pick the best supported MIME type
      const mimeType = (() => {
        if (typeof MediaRecorder === 'undefined') return 'video/webm';
        for (const t of ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']) {
          if (MediaRecorder.isTypeSupported(t)) return t;
        }
        return 'video/webm';
      })();

      const recorder = new MediaRecorder(currentStream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];
      startTimeRef.current = Date.now();
      discardedRef.current = false; // reset discard flag for this recording

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        setIsRecording(false);

        // If the recording was discarded, revoke the blob and skip the callback
        if (discardedRef.current) {
          chunksRef.current = [];
          discardedRef.current = false;
          return;
        }

        const blob = new Blob(chunksRef.current, { type: mimeType });
        const uri = URL.createObjectURL(blob);
        const rawDuration = (Date.now() - startTimeRef.current) / 1000;
        const duration = Math.round(rawDuration * 1000) / 1000;

        onStop({ uri, fileType: mimeType, duration, fileSize: blob.size });
      };

      recorder.start(100); // 100 ms timeslice
      setIsRecording(true);
    },
    []
  );

  // ---------------------------------------------------------------------------
  // stopRecording — fires the onStop callback with the recorded data
  // ---------------------------------------------------------------------------
  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  // ---------------------------------------------------------------------------
  // discardRecording — stops the recorder silently, no onCapture callback fired
  // ---------------------------------------------------------------------------
  const discardRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      discardedRef.current = true;
      recorderRef.current.stop();
    }
  }, []);

  // ---------------------------------------------------------------------------
  // switchCamera
  // ---------------------------------------------------------------------------
  const switchCamera = useCallback(async () => {
    if (deviceIds.length === 0) {
      return;
    }

    const currentIndex = activeDeviceId ? deviceIds.indexOf(activeDeviceId) : -1;
    const nextIndex = (currentIndex + 1) % deviceIds.length;
    const nextId = deviceIds[nextIndex];

    try {
      stopStream();
      await startStream(nextId);
    } catch {
      // Silently retain current stream on failure — no error state update
    }
  }, [deviceIds, activeDeviceId, stopStream, startStream]);

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      stopStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    // State
    stream,
    isRecording,
    deviceIds,
    activeDeviceId,
    error,
    // Controls
    startStream,
    stopStream,
    capturePhoto,
    startRecording,
    stopRecording,
    discardRecording,
    switchCamera,
  };
}
