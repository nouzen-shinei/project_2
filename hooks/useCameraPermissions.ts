import { useState, useCallback } from 'react';
import { Platform } from 'react-native';
import { Camera } from 'expo-camera';

/** Normalized permission state for camera and microphone. */
type PermissionStatus = 'undetermined' | 'granted' | 'denied';

/**
 * Return value of the `useCameraPermissions` hook.
 */
interface CameraPermissionsResult {
  /** Current camera permission status. Starts as `'undetermined'`. */
  cameraStatus: PermissionStatus;
  /** Current microphone permission status. Starts as `'undetermined'`. */
  micStatus: PermissionStatus;
  /**
   * Requests camera permission.
   *
   * - **Web**: returns `'granted'` immediately — the browser prompts the user
   *   implicitly when `getUserMedia` is called.
   * - **Native (iOS / Android)**: calls `Camera.requestCameraPermissionsAsync()`
   *   and normalizes the result to `PermissionStatus`. Updates `cameraStatus`.
   */
  requestCamera: () => Promise<PermissionStatus>;
  /**
   * Requests microphone permission.
   *
   * - **Web**: returns `'granted'` immediately — the browser prompts the user
   *   implicitly when `getUserMedia` is called.
   * - **Native (iOS / Android)**: calls `Camera.requestMicrophonePermissionsAsync()`
   *   and normalizes the result to `PermissionStatus`. Updates `micStatus`.
   */
  requestMicrophone: () => Promise<PermissionStatus>;
}

/**
 * Wraps `expo-camera` permission APIs with platform awareness.
 *
 * On web, both `requestCamera` and `requestMicrophone` return `'granted'`
 * immediately because the browser handles permission prompts implicitly via
 * `getUserMedia`. On native the system permission dialog is triggered and the
 * resulting status is stored in local state so callers can read the current
 * value without re-requesting.
 *
 * @example
 * ```tsx
 * const { cameraStatus, requestCamera } = useCameraPermissions();
 *
 * useEffect(() => {
 *   requestCamera();
 * }, [requestCamera]);
 * ```
 */
export function useCameraPermissions(): CameraPermissionsResult {
  const [cameraStatus, setCameraStatus] = useState<PermissionStatus>('undetermined');
  const [micStatus, setMicStatus] = useState<PermissionStatus>('undetermined');

  const requestCamera = useCallback(async (): Promise<PermissionStatus> => {
    // Web: getUserMedia handles the permission prompt implicitly.
    if (Platform.OS === 'web') return 'granted';

    const { status } = await Camera.requestCameraPermissionsAsync();
    const normalized = status as PermissionStatus;
    setCameraStatus(normalized);
    return normalized;
  }, []);

  const requestMicrophone = useCallback(async (): Promise<PermissionStatus> => {
    // Web: getUserMedia handles the permission prompt implicitly.
    if (Platform.OS === 'web') return 'granted';

    const { status } = await Camera.requestMicrophonePermissionsAsync();
    const normalized = status as PermissionStatus;
    setMicStatus(normalized);
    return normalized;
  }, []);

  return { cameraStatus, micStatus, requestCamera, requestMicrophone };
}
