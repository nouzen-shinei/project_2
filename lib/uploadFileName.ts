/**
 * Deterministic storage FILENAMES for chat pending-media uploads
 * (upload-idempotency spec, Requirements 1.1, 7.1, 7.4, 7.7).
 *
 * `lib/uploadKey.ts` gives an upload a stable idempotency *key*. That is only half
 * of the object's identity: the backend's deterministic chat path is
 *
 *     chat-files/{tenantId}/{conversationFolder}/k_{hash(uploadKey)}_{safeName}
 *
 * — it embeds the sanitized FILENAME as well as the key hash (see
 * `backend-runtime/src/lib/uploadObjectPath.ts` and design.md's "Object path
 * formats" table). So a caller that keeps its `uploadKey` stable but mints a fresh
 * filename per attempt still resolves to a DIFFERENT object every time, and the
 * orphan the feature exists to prevent comes back: the chat retry path used to
 * build `${'kb'|'pick'}_${Date.now()}.${ext}`, so a second "Retry all" tap, the
 * auto-retry-on-reconnect pass and the resume-on-relaunch pass each wrote a new
 * blob for one pending item (the message itself stayed deduped by `clientMsgId`,
 * so the surplus blobs were pure orphans).
 *
 * This module derives that filename from the pending item's `tempId` — which IS
 * its `clientMsgId`, is minted once per send, and survives in the durable outbox
 * across a relaunch — so every re-drive of one pending item targets one object.
 *
 * Every chat upload transport uses it: the original media send
 * (`sendKeyboardMediaAsSticker`), every media re-drive (`retryPendingMedia`), the
 * native background uploader (`chatService.buildChatBackgroundUploadRequest`), and
 * the foreground attachment fan-out (`chatService.sendMessageWithMultipleFiles`,
 * which seeds file i with `stableIdForFileIndex(clientMsgId, i)` — a single-file
 * send is file 0, seeded by the bare `clientMsgId`, which is exactly what the
 * background transport uses). So a retry after a lost response overwrites the
 * FIRST attempt rather than only agreeing with later retries, and a background
 * upload that transfers bytes and then fails is overwritten by the foreground
 * retry instead of orphaned — for stickers/GIFs and for attachments alike. The
 * OS-supplied `file.fileName` rides along as the backend's separate `displayName`
 * parameter, so the recipient still sees the real name — see the call-site
 * comments in `app/(tabs)/chat.tsx` and `services/chatService.ts`.
 *
 * Guarantees (all pinned by `__tests__/lib/uploadFileName.test.ts`):
 *   - **Stable**: same `stableId` (+ same mime/uri/source) ⇒ same filename, on
 *     every invocation and across a process restart. No clock, no randomness.
 *   - **Distinct per item**: two different `stableId` values yield different
 *     filenames, including ids that differ ONLY in characters the backend's
 *     `sanitizeStorageSegment` rewrites to `_` (that is what the fingerprint is
 *     for — a plain sanitize would collapse `pm_a+b` and `pm_a_b` into one name).
 *   - **Sanitizer-stable**: the output is already inside `[A-Za-z0-9._-]`, so the
 *     backend's `sanitizeStorageSegment` is the identity on it and the path the
 *     client predicts is the path the server writes.
 *
 * Pure module: no React, no network, no `react-native` imports.
 */

import { stableFingerprint } from './uploadKey';

/**
 * Everything outside `[A-Za-z0-9_-]` becomes `_`. Deliberately TIGHTER than the
 * backend's `[A-Za-z0-9._-]`: keeping `.` out of the id head means the only dot in
 * the result is the extension separator, so nothing downstream can mistake part of
 * a `tempId` for the extension.
 */
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_-]/g;

/** Enough to hold a whole `generatePendingId('pm')` value (~29 chars) verbatim. */
const MAX_ID_HEAD_LENGTH = 40;

/** Longest plausible real extension; anything longer is a parse artifact. */
const MAX_EXT_LENGTH = 12;

const DEFAULT_EXT = 'bin';

function sanitizeNameSegment(value: string): string {
  return value.replace(UNSAFE_NAME_CHARS, '_');
}

export interface DeriveUploadExtensionArgs {
  /** The pending item's mime type (`item.mime` / `file.mimeType`). */
  mime?: string | null;
  /** The local source uri, used only when the mime type carries no subtype. */
  uri?: string | null;
}

/**
 * Mime subtypes that name no format at all, so they must not become an extension.
 * `application/octet-stream` is what every chat call site falls back to when the
 * picker supplies no mime type (`f.mimeType || 'application/octet-stream'`), and it
 * is precisely the case where the OS filename still knows what the file is. Letting
 * `octet-stream` through would name a picked `IMG_0001.MOV` `….octet-stream`, which
 * loses the extension arm of the backend's chat-video detection
 * (`/\.(mp4|mov|m4v|…)$/i` in `backend-runtime/src/app.ts`) — and with a generic
 * content type its `contentType.startsWith('video/')` arm cannot cover for it, so
 * the transcode would silently never be scheduled.
 */
const GENERIC_MIME_SUBTYPES = new Set(['octet-stream']);

/**
 * Guess the upload extension, preserving the chat retry path's existing logic:
 * the mime subtype when there is one, else the uri's trailing extension (query and
 * fragment stripped), else `bin`.
 *
 * A generic subtype (`application/octet-stream`) counts as no subtype, so the uri's
 * extension is used instead — see `GENERIC_MIME_SUBTYPES`.
 *
 * The result is sanitized and length-capped, which is a no-op for every real case
 * (`image/png` → `png`, `.../pic.webp` → `webp`) and only bites on degenerate
 * input: `image/svg+xml` → `svg_xml`, and a dot-less uri (whose `split('.').pop()`
 * returns the WHOLE uri) → `bin` instead of a path-shaped "extension".
 */
export function deriveUploadExtension(args: DeriveUploadExtensionArgs): string {
  const mime = typeof args.mime === 'string' ? args.mime : '';
  const uri = typeof args.uri === 'string' ? args.uri : '';
  const mimeSubtype = mime ? mime.split('/')[1] || '' : '';
  const fromMime = GENERIC_MIME_SUBTYPES.has(mimeSubtype.trim().toLowerCase())
    ? ''
    : mimeSubtype;
  const fromUri = uri.split('?')[0].split('#')[0].split('.').pop() || '';
  const guessed = fromMime || fromUri;
  const safe = sanitizeNameSegment(guessed.trim());
  if (!safe || safe.length > MAX_EXT_LENGTH) {
    return DEFAULT_EXT;
  }
  return safe;
}

export interface DeriveStableUploadFileNameArgs extends DeriveUploadExtensionArgs {
  /**
   * The pending item's stable id — the chat `tempId`, which is also its
   * `clientMsgId` and the seed of its `uploadKey`. Must NOT be re-minted per
   * attempt; that is the whole point.
   */
  stableId: string;
  /** `item.source` — kept only as a human-readable `kb`/`pick` marker. */
  source?: string | null;
}

/**
 * Build the object filename for a pending-media upload:
 * `{kb|pick}_{sanitized id head}_{fingerprint(id)}.{ext}`.
 *
 * The `kb`/`pick` marker and the readable id head are for debugging (you can grep
 * a stored object path back to the pending item); the fingerprint is what carries
 * the correctness. Since it is taken over the RAW id, two ids that sanitize to the
 * same head still get different names.
 *
 * The fingerprint is ~64 bits, so a collision between two pending items on one
 * device is not a practical concern — and even then the objects stay separate,
 * because the path also embeds `hash(uploadKey)`, which is derived from the same
 * distinct ids server-side.
 */
export function deriveStableUploadFileName(args: DeriveStableUploadFileNameArgs): string {
  const rawId = typeof args.stableId === 'string' ? args.stableId.trim() : '';
  const prefix = args.source === 'keyboard' ? 'kb' : 'pick';
  const head = sanitizeNameSegment(rawId).slice(0, MAX_ID_HEAD_LENGTH) || 'id';
  return `${prefix}_${head}_${stableFingerprint(rawId)}.${deriveUploadExtension(args)}`;
}
