// Feature: video-transcoding-compatibility

/**
 * The set of video codecs whose decode capability can be queried.
 */
export type SupportedCodec = 'h265' | 'h264' | 'vp9' | 'av1';

/**
 * MIME type strings used for browser canPlayType queries.
 */
const CODEC_MIME: Record<SupportedCodec, string> = {
  h265: 'video/mp4; codecs="hvc1"',
  h264: 'video/mp4; codecs="avc1.42E01E"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.05M.08"',
};

/**
 * Module-level cache so each codec is queried at most once per page/process
 * lifetime. Satisfies Requirements 5.3.
 */
const codecCache = new Map<SupportedCodec, boolean>();

// ---------------------------------------------------------------------------
// Platform detection — intentionally avoids importing React, RN, or Expo.
// ---------------------------------------------------------------------------

/**
 * Returns true when running inside a web browser (DOM environment).
 */
function isWeb(): boolean {
  return typeof document !== 'undefined';
}

// ---------------------------------------------------------------------------
// Web implementation
// ---------------------------------------------------------------------------

/**
 * Queries `HTMLVideoElement.canPlayType` for a single MIME string.
 * Creates a detached element that is never attached to the DOM.
 *
 * @returns `true` for `"probably"` or `"maybe"`, `false` for `""`.
 */
function queryWebCodecSupport(mime: string): boolean {
  const video = document.createElement('video');
  const result = video.canPlayType(mime);
  return result === 'probably' || result === 'maybe';
}

// ---------------------------------------------------------------------------
// Native implementation
// ---------------------------------------------------------------------------

/**
 * Returns native codec support for `vp9` and `av1`.
 *
 * Attempts to call a platform capability API if available (e.g. a native
 * bridge that exposes `global.__nativeVideoCapabilities`). Defaults to
 * `false` when no such API is present, per Requirement 5.2.
 */
function queryNativeCodecSupport(codec: 'vp9' | 'av1'): boolean {
  try {
    // Some native bridges expose a synchronous capabilities map at a
    // well-known global. Fall back gracefully if it is absent.
    const capabilities =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (typeof global !== 'undefined' && (global as any).__nativeVideoCapabilities) ||
      null;

    if (capabilities && typeof capabilities[codec] === 'boolean') {
      return capabilities[codec] as boolean;
    }
  } catch {
    // Ignore — default to false below.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns whether the current platform can decode the given video codec.
 *
 * - Synchronous. No network calls. (Requirement 5.1)
 * - Web: uses `HTMLVideoElement.canPlayType` with the codec's primary MIME
 *   type string; treats `"probably"` or `"maybe"` as supported and `""` as
 *   unsupported. Results are cached in a module-level Map for the lifetime
 *   of the current page load so subsequent calls for the same codec do not
 *   invoke `canPlayType` again. (Requirement 5.3)
 * - Native (iOS / Android): returns `true` unconditionally for `h264` and
 *   `h265`; queries the native platform capability API for `vp9`/`av1`,
 *   defaulting to `false` if that API is unavailable. (Requirement 5.2)
 *
 * Requirement 5.6: this module imports nothing from React, React Native,
 * or Expo so it is safe to use from plain service files.
 */
export function canPlayCodec(codec: SupportedCodec): boolean {
  // Return cached result if available (covers both web and native paths).
  const cached = codecCache.get(codec);
  if (cached !== undefined) {
    return cached;
  }

  let result: boolean;

  if (isWeb()) {
    // --- Web path (Requirement 5.3) ---
    result = queryWebCodecSupport(CODEC_MIME[codec]);
  } else {
    // --- Native path — iOS / Android (Requirement 5.2) ---
    // h264 and h265 are universally supported on all modern iOS and Android devices.
    if (codec === 'h264' || codec === 'h265') {
      result = true;
    } else {
      // vp9 / av1: query the native platform capability API, default false.
      result = queryNativeCodecSupport(codec);
    }
  }

  codecCache.set(codec, result);
  return result;
}
