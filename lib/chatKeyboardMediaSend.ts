/**
 * Pure, dependency-free normalization + validation for media that arrives from
 * the device keyboard / clipboard (web clipboard paste today; a native
 * `commitContent` bridge could feed the same path later).
 *
 * Intentionally free of React / Expo / platform imports so it is trivially
 * unit-testable and reusable. The actual upload + send is delegated to the chat
 * file-attachment pipeline (`previewSelectedFiles` -> `handleSendWithFiles`),
 * so this module only decides "is this sendable, and in what shape".
 */

export interface KeyboardMediaCandidate {
  /** Local URI or object URL for the media. */
  uri: string;
  /** MIME type if known (e.g. from a pasted Blob's `type`). */
  mimeType?: string | null;
  /** Original file name if the source provided one. */
  fileName?: string | null;
  /** Size in bytes if known. */
  fileSize?: number | null;
  /**
   * Android paste origin, when known: `'keyboard'` for soft-keyboard
   * commitContent (the GIF button / sticker keyboards) or `'clipboard'` for an
   * OS clipboard paste. Absent on web/iOS. Lets the caller send keyboard
   * stickers/GIFs immediately while clipboard media goes through the preview.
   */
  source?: string | null;
  /**
   * Web only: the raw Blob. Preferred for upload because object URLs can be
   * revoked before the upload starts.
   */
  webFile?: Blob;
}

/**
 * Shape consumed by the chat attachment preview/upload pipeline (`selectedFiles`).
 * Includes both `name`/`fileName` and `size`/`fileSize` aliases because different
 * layers of the existing pipeline read different keys.
 */
export interface KeyboardMediaFile {
  uri: string;
  name: string;
  fileName: string;
  mimeType: string;
  fileType: string;
  size: number;
  fileSize: number;
  lastModified: number;
  /** Normalized paste origin, when the platform supplied it (Android). */
  source?: 'keyboard' | 'clipboard';
  webFile?: Blob;
}

export type KeyboardMediaRejectionReason = 'missing_uri' | 'unsupported_type' | 'too_large';

/**
 * Hard client-side ceiling. The server enforces the authoritative storage/size
 * limit (via the upload preflight); this is an early guard that matches the
 * attachment preview modal's 50 MB check so oversized pastes fail fast with a
 * clear message instead of after a long upload.
 */
export const KEYBOARD_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

const SUPPORTED_MIME_PREFIXES = ['image/', 'video/'] as const;

function isSupportedMediaType(mime: string): boolean {
  return SUPPORTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix));
}

function extensionForMime(mime: string): string {
  const subtype = mime.split('/')[1] || '';
  // Normalize a few common subtypes to friendly file extensions.
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'quicktime') return 'mov';
  if (subtype === 'x-msvideo') return 'avi';
  if (subtype === 'svg+xml') return 'svg';
  return subtype || 'bin';
}

export interface NormalizeKeyboardMediaOptions {
  /**
   * Injected MIME inference from a URI extension (keeps this module free of the
   * heavy media-picker/native imports). Only consulted when `mimeType` is absent.
   */
  inferType?: (uri: string) => string;
  /** Override the max byte ceiling (defaults to KEYBOARD_MEDIA_MAX_BYTES). */
  maxBytes?: number;
  /** Clock injection for deterministic filenames in tests. */
  now?: () => number;
}

export type NormalizeKeyboardMediaResult =
  | { ok: true; file: KeyboardMediaFile }
  | { ok: false; reason: KeyboardMediaRejectionReason };

/**
 * Validate + normalize a keyboard/clipboard media candidate into the file shape
 * the chat attachment pipeline expects. Returns a discriminated result so the
 * caller can surface a specific rejection message.
 */
export function normalizeKeyboardMediaCandidate(
  candidate: KeyboardMediaCandidate | null | undefined,
  options: NormalizeKeyboardMediaOptions = {}
): NormalizeKeyboardMediaResult {
  const uri = typeof candidate?.uri === 'string' ? candidate.uri.trim() : '';
  if (!uri) {
    return { ok: false, reason: 'missing_uri' };
  }

  let mimeType = typeof candidate?.mimeType === 'string' ? candidate.mimeType.trim().toLowerCase() : '';
  if (!mimeType && typeof options.inferType === 'function') {
    mimeType = (options.inferType(uri) || '').trim().toLowerCase();
  }

  if (!mimeType || !isSupportedMediaType(mimeType)) {
    return { ok: false, reason: 'unsupported_type' };
  }

  const maxBytes =
    typeof options.maxBytes === 'number' && options.maxBytes > 0 ? options.maxBytes : KEYBOARD_MEDIA_MAX_BYTES;
  const rawSize =
    typeof candidate?.fileSize === 'number' && Number.isFinite(candidate.fileSize) && candidate.fileSize > 0
      ? Math.trunc(candidate.fileSize)
      : 0;
  if (rawSize > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }

  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const providedName = typeof candidate?.fileName === 'string' ? candidate.fileName.trim() : '';
  const fileName = providedName || `keyboard_${now}.${extensionForMime(mimeType)}`;

  const rawSource = typeof candidate?.source === 'string' ? candidate.source.trim().toLowerCase() : '';
  const source: 'keyboard' | 'clipboard' | undefined =
    rawSource === 'keyboard' ? 'keyboard' : rawSource === 'clipboard' ? 'clipboard' : undefined;

  const file: KeyboardMediaFile = {
    uri,
    name: fileName,
    fileName,
    mimeType,
    fileType: mimeType,
    size: rawSize,
    fileSize: rawSize,
    lastModified: now,
    ...(source ? { source } : {}),
    webFile: candidate?.webFile,
  };
  return { ok: true, file };
}

/**
 * How a normalized keyboard/clipboard media file should be sent:
 *  - `'sticker'`: send immediately as a sticker/gif message (one-shot, like the picker).
 *  - `'preview'`: route through the normal attachment preview → upload pipeline.
 */
export type KeyboardMediaSendMode = 'sticker' | 'preview';

/**
 * Decide the send mode for a keyboard/clipboard media file.
 *
 * Priority:
 *  1. Video is never a sticker/gif → always `'preview'`.
 *  2. The reliable native `source` (Android, via the patched paste module):
 *       `'keyboard'` (soft-keyboard commitContent: GIF button / sticker keyboards) → `'sticker'`,
 *       `'clipboard'` (OS clipboard paste)                                          → `'preview'`.
 *  3. Unknown source (web paste, iOS, a pasted web-image URL) → format fallback:
 *       GIF/WebP are effectively only ever stickers/GIFs → `'sticker'`; everything
 *       else (JPEG/PNG photos & screenshots) → `'preview'`, so a pasted screenshot
 *       never auto-sends.
 */
export function resolveKeyboardMediaSendMode(
  file: Pick<KeyboardMediaFile, 'mimeType' | 'source'>
): KeyboardMediaSendMode {
  const mime = (file?.mimeType || '').toLowerCase();
  if (!mime.startsWith('image/')) {
    return 'preview';
  }
  if (file.source === 'keyboard') {
    return 'sticker';
  }
  if (file.source === 'clipboard') {
    return 'preview';
  }
  return mime === 'image/gif' || mime === 'image/webp' ? 'sticker' : 'preview';
}

/** Human-facing copy for a rejection reason (title + message for a Toast). */
export function describeKeyboardMediaRejection(
  reason: KeyboardMediaRejectionReason
): { title: string; message: string } {
  switch (reason) {
    case 'unsupported_type':
      return {
        title: 'Unsupported media',
        message: 'Only images and videos can be pasted into the chat.',
      };
    case 'too_large':
      return {
        title: 'Media too large',
        message: 'That media is too large to send. Please choose a smaller file.',
      };
    case 'missing_uri':
    default:
      return {
        title: 'Could not read media',
        message: 'The pasted media could not be read. Please try again.',
      };
  }
}
