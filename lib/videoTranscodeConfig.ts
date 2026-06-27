// Feature: video-transcoding-compatibility
//
// Single source of truth for whether client-side video transcoding behaviour is
// enabled. Controlled by the EXPO_PUBLIC_VIDEO_TRANSCODE_ENABLED build-time env
// flag. Defaults to enabled (backward compatible) — only an explicit disable
// value turns it off. Keep this in sync with the backend VIDEO_TRANSCODE_ENABLED
// flag (the backend is the authoritative gate; this drives client UX).

const DISABLED_VALUES = new Set(['false', '0', 'no', 'off', 'disabled']);

/**
 * Returns whether video transcoding behaviour is enabled on the client.
 *
 * When disabled:
 *  - The VideoPlayer never POSTs to /video/request-transcode.
 *  - Unsupported videos with no pre-existing transcoded copy show the
 *    "format not supported" error instead of a "Converting…" spinner.
 *  - Videos transcoded before disabling still play (their transcodedUrl is honored).
 *
 * Reads process.env on each call (no caching) so it stays correct under tests.
 * EXPO_PUBLIC_ vars are inlined at build time for the app bundle.
 */
export function isVideoTranscodeEnabled(): boolean {
  const raw = (process.env.EXPO_PUBLIC_VIDEO_TRANSCODE_ENABLED ?? '').trim().toLowerCase();
  if (!raw) {
    return true; // default: enabled (backward compatible)
  }
  return !DISABLED_VALUES.has(raw);
}
