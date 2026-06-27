// Feature: video-transcoding-compatibility

/**
 * Minimal shape of a video attachment needed for source resolution.
 * Matches the fields on HydratedAttachment that are relevant for playback.
 */
export interface VideoAttachmentSource {
  /** The primary attachment URL stored in the RTDB message. For transcoded videos
   * whose original was deleted, the backend overwrites this with the H.264 URL
   * (via the RTDB canonical-URL replacement) and sets originalReplaced = true. */
  url: string;
  /** H.264 URL written by the transcoder after a successful transcode. When present,
   * the original H.265 file may have been deleted from Firebase Storage. */
  transcodedUrl?: string;
  /** True when the backend already overwrote `url` with the H.264 copy. */
  originalReplaced?: boolean;
}

/**
 * The result of resolving a video attachment's safe playback source.
 */
export interface ResolvedVideoSource {
  /**
   * The URL that may be safely loaded for playback.
   * - When `transcodedUrl` is present: equals `transcodedUrl` (H.264 copy).
   * - Otherwise: equals the attachment's `url` (original, assumed to still exist).
   */
  source: string;
  /**
   * True when the original file at `attachment.url` may have been deleted from
   * Firebase Storage (because a transcoded copy exists). Callers should NOT use
   * `attachment.url` as a network source when this is true — use `source` instead.
   */
  originalMayBeDeleted: boolean;
}

/**
 * Resolves the safe playback source for a video attachment.
 *
 * Invariant (Requirement 7.2): when `transcodedUrl` is present, the returned
 * `source` is always the transcoded H.264 URL and the original `url` is never
 * returned as a playback source. The caller MUST use `source` for VideoPlayer
 * `uri`/`transcodedUri` props and MUST use `attachment.url` ONLY as a stable
 * identity key (e.g. downloadKey) that is never used to issue a network request.
 *
 * This function has no side effects and makes no network calls.
 * It imports nothing from React, React Native, or Expo so it can be used in both
 * components and service files.
 */
export function resolveVideoSource(attachment: VideoAttachmentSource): ResolvedVideoSource {
  const trimmedTranscoded =
    typeof attachment.transcodedUrl === 'string' && attachment.transcodedUrl.trim().length > 0
      ? attachment.transcodedUrl.trim()
      : null;

  if (trimmedTranscoded !== null) {
    // Transcoded H.264 copy is available — always use it.
    // The original H.265 may have been deleted from Firebase Storage after transcoding.
    return {
      source: trimmedTranscoded,
      originalMayBeDeleted: true,
    };
  }

  // No transcoded copy — use the attachment's primary URL.
  // This is safe because: if there were ever a transcodedUrl, it would be set.
  return {
    source: attachment.url,
    originalMayBeDeleted: false,
  };
}
