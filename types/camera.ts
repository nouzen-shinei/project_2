/**
 * Shared TypeScript types for the CameraCapture feature.
 *
 * These interfaces are used across the CameraCapture component (native + web),
 * the useWebCamera / useRecordingTimer hooks, and the MediaPickerUtil integration
 * layer. They mirror the relevant subset of expo-image-picker's return shape so
 * that captured assets and gallery-picked assets are interchangeable throughout
 * the upload pipeline.
 */

// ---------------------------------------------------------------------------
// Primitive discriminators
// ---------------------------------------------------------------------------

/**
 * The capture mode the CameraCapture component is opened in.
 *
 * - `'photo'`       — shutter button only; video controls hidden.
 * - `'video'`       — record/stop buttons only; shutter button hidden.
 * - `'photo-video'` — both shutter and record/stop buttons are shown.
 */
export type CaptureMode = 'photo' | 'video' | 'photo-video';

/**
 * Discriminator tag that indicates whether a {@link CaptureResult} carries
 * a still image or a video clip.
 */
export type CaptureResultType = 'photo' | 'video';

// ---------------------------------------------------------------------------
// Core result type
// ---------------------------------------------------------------------------

/**
 * Normalised output from any capture operation (photo or video).
 *
 * Mirrors the subset of `expo-image-picker` `ImagePickerAsset` that is
 * required by the upload pipeline, so captured assets and gallery-picked
 * assets are interchangeable downstream.
 */
export interface CaptureResult {
  /** Whether the result is a still image or a video clip. */
  type: CaptureResultType;

  /**
   * Local file path on native (e.g. `file:///…/photo.jpg`) or a
   * `blob:` object-URL on web created via `URL.createObjectURL`.
   */
  uri: string;

  /**
   * Suggested file name for the asset, e.g. `"photo_1234567890.jpg"`.
   * Defaults to a timestamp string when absent.
   */
  fileName?: string;

  /**
   * MIME type of the captured file, e.g. `"image/jpeg"` or `"video/mp4"`.
   * May be absent when the MIME type cannot be determined at capture time.
   */
  fileType?: string;

  /**
   * File size in bytes.
   * `null` when the size is unavailable (common for web `blob:` URLs).
   */
  fileSize?: number | null;

  /**
   * Duration of the video clip in seconds (video captures only).
   * Absent for photo captures.
   */
  duration?: number;

  /**
   * Set when the capture partially succeeded but encountered a non-fatal
   * error (e.g. video recording stopped early with salvageable data).
   * Callers should surface this to the user while still processing the asset.
   */
  error?: string;

  /**
   * Crop hint for callers that enforce a fixed aspect ratio.
   * `1` indicates a square crop (used for profile images).
   * `undefined` means no constraint.
   */
  aspectRatio?: number;
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

/**
 * Props accepted by the platform-agnostic `CameraCapture` component.
 *
 * The component renders a full-screen camera UI and calls back exactly one of
 * `onCapture` or `onCancel` per capture attempt — never both.
 */
export interface CameraCaptureProps {
  /** Controls which capture controls are rendered. */
  mode: CaptureMode;

  /**
   * Called with the normalised capture result when the user takes a photo or
   * finishes recording a video.
   *
   * Mutually exclusive with `onCancel` for any single capture attempt.
   */
  onCapture: (result: CaptureResult) => void;

  /**
   * Called when the user dismisses the camera UI without capturing anything,
   * or when capture fails with no recoverable data.
   *
   * Mutually exclusive with `onCapture` for any single capture attempt.
   */
  onCancel: () => void;

  /**
   * Web only. Maximum recording duration in seconds (valid range: 1–3600).
   *
   * - Values ≤ 0 or absent default to `60`.
   * - Values > 3600 are clamped to `3600`.
   * - Ignored on native platforms (native uses a 300-second hard cap via
   *   `CameraView.recordAsync({ maxDuration: 300 })`).
   */
  webVideoMaxDurationSeconds?: number;

  /**
   * Which tab to show as active when the camera first opens in `photo-video`
   * mode. Defaults to `'photo'`. Ignored when `mode` is `'photo'` or `'video'`.
   */
  initialCaptureMode?: 'photo' | 'video';
}

// ---------------------------------------------------------------------------
// Picker result shape (mirrors expo-image-picker)
// ---------------------------------------------------------------------------

/**
 * Normalised picker result returned by `MediaPickerUtil` capture and select
 * methods. Shape is intentionally identical to the `expo-image-picker`
 * `ImagePickerResult` so callers require no branching logic.
 */
export interface PickerResult {
  /** `true` when the user dismissed the picker without selecting an asset. */
  canceled: boolean;

  /**
   * Array of selected or captured assets.
   * Empty when `canceled` is `true`.
   */
  assets: PickerAsset[];
}

/**
 * A single asset returned inside a {@link PickerResult}.
 *
 * For gallery picks this mirrors `expo-image-picker` `ImagePickerAsset`.
 * For camera captures it is constructed by `mountCameraCaptureOnWeb` /
 * the native `MediaPickerUtil` shim from a {@link CaptureResult}.
 */
export interface PickerAsset {
  /**
   * Local file path (native) or `blob:` object-URL (web).
   * Passed directly to the upload pipeline.
   */
  uri: string;

  /**
   * Broad media type derived from the file's MIME prefix.
   * `"image"` for photos, `"video"` for clips.
   */
  type: 'image' | 'video';

  /**
   * File name including extension, e.g. `"photo_1234567890.jpg"`.
   * Always present (falls back to a generated timestamp name when the
   * underlying platform does not supply one).
   */
  fileName: string;

  /**
   * File size in bytes.
   * `null` when unavailable (common for web `blob:` URLs).
   */
  fileSize: number | null;

  /**
   * Duration in seconds for video assets; `null` for photos.
   */
  duration: number | null;

  /**
   * Crop hint for callers that enforce a fixed aspect ratio.
   * `1` indicates a square crop (used for profile images).
   * Absent when no constraint applies.
   */
  aspectRatio?: number;

  /**
   * Full MIME type string, e.g. `"image/jpeg"` or `"video/mp4"`.
   * Provided when known; absent for assets whose MIME type cannot be
   * reliably determined.
   */
  mimeType?: string;
}
