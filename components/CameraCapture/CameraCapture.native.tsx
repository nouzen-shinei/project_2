/**
 * CameraCapture.native.tsx
 *
 * iOS / Android camera component built on top of expo-camera's CameraView.
 * Renders a full-screen React Native Modal containing the live preview,
 * capture controls, recording timer, and permission-denied fallback UI.
 *
 * State machine:
 *   INITIALIZING → (permission check)
 *     → DENIED      (show permission message + Open Settings)
 *     → READY       (show live preview)
 *       → CAPTURING (photo in progress)
 *       → RECORDING (video in progress — show timer + red dot)
 *       → ERROR      (show dismissible banner, stay on READY)
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  Platform,
  BackHandler,
  Alert,
} from 'react-native';
import * as Linking from 'expo-linking';
import {
  CameraView,
  type CameraType,
  useCameraPermissions as useExpoCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import { X, RotateCcw, Circle } from 'lucide-react-native';
import { useCameraPermissions } from '@/hooks/useCameraPermissions';
import { useRecordingTimer } from '@/hooks/useRecordingTimer';
import { styles } from './CameraCapture.styles';
import type { CameraCaptureProps, CaptureResult } from '@/types/camera';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function CameraCapture({ mode, onCapture, onCancel }: CameraCaptureProps) {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const [cameraReady, setCameraReady] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const [isRecording, setIsRecording] = useState(false);
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [hasMulipleCameras, setHasMulipleCameras] = useState(false);

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------
  const cameraRef = useRef<CameraView | null>(null);
  /** Set to true when the user cancels during an active recording. */
  const recordingAbortedRef = useRef(false);

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------
  const { requestCamera, requestMicrophone } = useCameraPermissions();

  // No limit on native — expo-camera's recordAsync enforces a 300 s hard cap.
  const timer = useRecordingTimer({ maxSeconds: 0, onExpire: undefined });

  // expo-camera permission hooks (used for reading current status if needed)
  const [cameraPermission, requestExpoCamera] = useExpoCameraPermissions();
  const [micPermission, requestExpoMic] = useMicrophonePermissions();

  // -------------------------------------------------------------------------
  // Initialisation — permission check + camera type enumeration
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const result = await requestCamera();

        if (cancelled) return;

        if (result === 'denied') {
          setPermissionError(
            'Camera access is required. Please open Settings and allow camera access for this app.',
          );
          return;
        }

        // Detect number of available cameras (front + rear).
        // Note: `getAvailableCameraTypesAsync` is not a public static on CameraView in
        // expo-camera v16; fall back to showing the toggle on native platforms where
        // front + rear cameras are almost universally available.
        try {
          // Cast to any to gracefully handle versions where the API may exist
          const cameraViewAny = CameraView as any;
          if (typeof cameraViewAny.getAvailableCameraTypesAsync === 'function') {
            const types: string[] = await cameraViewAny.getAvailableCameraTypesAsync();
            if (!cancelled && types.length >= 2) {
              setHasMulipleCameras(true);
            }
          } else {
            // Default to true on native — most iOS/Android devices have both cameras.
            if (!cancelled && Platform.OS !== 'web') {
              setHasMulipleCameras(true);
            }
          }
        } catch (typeErr) {
          // Non-fatal — default to showing the toggle on native.
          logger.error('CameraCapture: failed to enumerate camera types', typeErr);
          if (!cancelled && Platform.OS !== 'web') {
            setHasMulipleCameras(true);
          }
        }
      } catch (err) {
        logger.error('CameraCapture: init failed', err);
        const msg =
          err instanceof Error ? err.message : 'Camera could not be initialised.';
        if (!cancelled) setPermissionError(msg);
        onCancel();
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [requestCamera, onCancel]);

  // -------------------------------------------------------------------------
  // Android hardware back button
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      handleCancel();
      return true; // prevent default back navigation
    });

    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]); // re-register when isRecording changes so handleCancel closure is fresh

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleCancel = useCallback(() => {
    if (isRecording) {
      recordingAbortedRef.current = true;
      cameraRef.current?.stopRecording();
    }
    onCancel();
  }, [isRecording, onCancel]);

  const handleShutter = useCallback(async () => {
    if (!cameraRef.current || isTakingPhoto) return;
    setIsTakingPhoto(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
        base64: false,
      });
      if (!photo?.uri) throw new Error('No photo URI returned');
      // Requirement 1.12: dismiss first, then call onCapture.
      onCapture({ type: 'photo', uri: photo.uri, fileType: 'image/jpeg' });
    } catch (e) {
      logger.error('CameraCapture: photo capture failed', e);
      setErrorMessage(
        e instanceof Error ? e.message : 'Photo capture failed. Please try again.',
      );
    } finally {
      setIsTakingPhoto(false);
    }
  }, [isTakingPhoto, onCapture]);

  const handleRecord = useCallback(async () => {
    if (!cameraRef.current || isRecording) return;

    // Request microphone permission before starting video recording.
    if (mode === 'video' || mode === 'photo-video') {
      try {
        const micResult = await requestMicrophone();
        if (micResult === 'denied') {
          setErrorMessage(
            'Microphone access is required for video recording. Please open Settings and allow microphone access.',
          );
          return;
        }
      } catch (micErr) {
        logger.error('CameraCapture: microphone permission request failed', micErr);
        setErrorMessage('Could not request microphone permission. Please try again.');
        return;
      }
    }

    recordingAbortedRef.current = false;
    setIsRecording(true);
    timer.reset();
    timer.start();

    try {
      // Force H.264 ('avc1') on iOS so recordings play in every browser/platform.
      // Ignored on Android (which records H.264 by default). Prevents HEVC output.
      // recordAsync is typed as `{ uri: string } | undefined`; some platforms
      // additionally surface a `duration`, so widen the type to read it safely.
      const result = (await cameraRef.current.recordAsync({
        maxDuration: 300,
        codec: 'avc1',
      })) as { uri: string; duration?: number } | undefined;

      timer.stop();
      setIsRecording(false);

      if (recordingAbortedRef.current) {
        // User cancelled mid-recording — discard the data.
        onCancel();
        return;
      }

      if (result?.uri && (result.duration ?? 0) > 0) {
        onCapture({
          type: 'video',
          uri: result.uri,
          fileType: 'video/mp4',
          duration: result.duration ?? 0,
        });
      } else {
        // Recording produced no usable data.
        onCapture({
          type: 'video',
          uri: result?.uri ?? '',
          duration: 0,
          fileType: 'video/mp4',
          error: 'Recording produced no data',
        });
      }
    } catch (e) {
      timer.stop();
      setIsRecording(false);

      if (recordingAbortedRef.current) {
        onCancel();
        return;
      }

      logger.error('CameraCapture: video recording failed', e);
      setErrorMessage(
        e instanceof Error ? e.message : 'Video recording failed. Please try again.',
      );
    }
  }, [isRecording, mode, requestMicrophone, timer, onCapture, onCancel]);

  const handleStopRecording = useCallback(() => {
    cameraRef.current?.stopRecording();
  }, []);

  const handleToggleCamera = useCallback(() => {
    setFacing((prev) => (prev === 'back' ? 'front' : 'back'));
  }, []);

  // -------------------------------------------------------------------------
  // Permission-denied UI
  // -------------------------------------------------------------------------
  if (permissionError !== null) {
    return (
      <Modal
        visible={true}
        animationType="slide"
        transparent={false}
        onRequestClose={handleCancel}
      >
        <View style={[styles.container, { backgroundColor: '#000' }]}>
          <View style={styles.permissionContainer}>
            <Text style={styles.permissionTitle} accessibilityRole="alert">
              Camera Unavailable
            </Text>
            <Text style={styles.permissionText}>{permissionError}</Text>
            <TouchableOpacity
              style={styles.openSettingsButton}
              onPress={() => Linking.openSettings()}
              accessibilityLabel="Open Settings"
              accessibilityRole="button"
            >
              <Text style={styles.openSettingsText}>Open Settings</Text>
            </TouchableOpacity>
          </View>

          {/* Allow user to dismiss even when permission is denied */}
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={handleCancel}
            accessibilityLabel="Close camera"
            accessibilityRole="button"
          >
            <X size={24} color="#fff" />
          </TouchableOpacity>
        </View>
      </Modal>
    );
  }

  // -------------------------------------------------------------------------
  // Main render
  // -------------------------------------------------------------------------
  return (
    <Modal
      visible={true}
      animationType="slide"
      transparent={false}
      onRequestClose={handleCancel}
    >
      <View style={styles.container}>
        {/* Live camera preview */}
        <CameraView
          ref={cameraRef}
          style={styles.preview}
          facing={facing}
          onCameraReady={() => setCameraReady(true)}
        />

        {/* Cancel button — top left */}
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={handleCancel}
          accessibilityLabel="Close camera"
          accessibilityRole="button"
        >
          <X size={24} color="#fff" />
        </TouchableOpacity>

        {/* Front/rear toggle — top right */}
        {hasMulipleCameras && (
          <TouchableOpacity
            style={styles.toggleButton}
            onPress={handleToggleCamera}
            accessibilityLabel="Switch camera"
            accessibilityRole="button"
          >
            <RotateCcw size={24} color="#fff" />
          </TouchableOpacity>
        )}

        {/* Recording indicator row — elapsed timer + red dot */}
        {isRecording && (
          <View
            style={styles.recordingRow}
            accessibilityLiveRegion="polite"
            accessibilityLabel="Recording in progress"
          >
            <View style={styles.recordingDot} />
            <Text style={styles.timerText}>{timer.formattedElapsed}</Text>
          </View>
        )}

        {/* Controls row */}
        <View style={styles.controls}>
          {/* Shutter button — photo modes, not while recording */}
          {(mode === 'photo' || mode === 'photo-video') && !isRecording && (
            <TouchableOpacity
              style={[
                styles.shutterButton,
                (!cameraReady || isTakingPhoto) && { opacity: 0.5 },
              ]}
              onPress={handleShutter}
              disabled={!cameraReady || isTakingPhoto}
              accessibilityLabel="Take photo"
              accessibilityRole="button"
            />
          )}

          {/* Record button — video modes, not while recording */}
          {(mode === 'video' || mode === 'photo-video') && !isRecording && (
            <TouchableOpacity
              style={[styles.recordButton, !cameraReady && { opacity: 0.5 }]}
              onPress={handleRecord}
              disabled={!cameraReady}
              accessibilityLabel="Start video recording"
              accessibilityRole="button"
            />
          )}

          {/* Stop recording button */}
          {isRecording && (
            <TouchableOpacity
              style={styles.stopButton}
              onPress={handleStopRecording}
              accessibilityLabel="Stop recording"
              accessibilityRole="button"
            />
          )}
        </View>

        {/* Dismissible error banner */}
        {errorMessage !== null && (
          <View
            style={styles.errorBanner}
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
          >
            <Text style={styles.errorText}>{errorMessage}</Text>
            <TouchableOpacity
              style={styles.errorDismiss}
              onPress={() => setErrorMessage(null)}
              accessibilityLabel="Dismiss error"
              accessibilityRole="button"
            >
              <X size={16} color="#fff" />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

export { CameraCapture };
