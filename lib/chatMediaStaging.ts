import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { logger } from '@/lib/logger';

/**
 * Chat media staging (outbox durability — Phase 0).
 *
 * Local media handed to the chat composer (keyboard commitContent `file://`
 * cache paths, clipboard `content://` URIs, picked files) is not guaranteed to
 * survive: cache dirs get evicted, `content://` read grants expire when the
 * source app closes, and object URLs are revoked. When a send is deferred
 * (offline queue) or retried, uploading from that volatile URI can fail.
 *
 * This module copies the media into an app-private, persistent directory
 * (`documentDirectory/chat-outbox/`) so the upload always has a stable source,
 * and it is the foundation the durable media outbox (see the spec) builds on for
 * true resume-after-kill.
 *
 * Native only. On web (no `documentDirectory`, media is a `Blob`/object URL) all
 * functions are no-ops and callers fall back to the original URI/Blob.
 */

const OUTBOX_DIRNAME = 'chat-outbox';

/** Resolved at call time (not module load) so it's robust + unit-testable. */
function outboxDir(): string | null {
  const base = FileSystem.documentDirectory;
  return base ? `${base}${OUTBOX_DIRNAME}/` : null;
}

/** True when staging is available (native + a document directory exists). */
export function isMediaStagingSupported(): boolean {
  return Platform.OS !== 'web' && !!FileSystem.documentDirectory;
}

function sanitizeExtension(ext?: string | null): string {
  if (!ext) return 'bin';
  const cleaned = ext.replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return cleaned || 'bin';
}

/**
 * Deterministic filename for a pending id so the orphan sweep can map a file
 * back to its owning pending item. The id is sanitized to a safe token; the
 * extension is preserved (best-effort) for correct MIME inference on re-upload.
 */
function stagedFileName(id: string, ext?: string | null): string {
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeId}.${sanitizeExtension(ext)}`;
}

/** Map a pending id to its safe filename token (extension stripped). */
function safeIdToken(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function ensureOutboxDir(dir: string): Promise<boolean> {
  // Create unconditionally: makeDirectoryAsync with intermediates:true is
  // idempotent (no throw if it already exists) and, unlike a getInfoAsync gate,
  // can't be fooled into skipping creation by a stale "exists" result — which was
  // leaving copyAsync writing into a non-existent directory on some devices.
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    return true;
  } catch (error) {
    // Tolerate "already exists"; only fail if the directory truly isn't there.
    try {
      const info = await FileSystem.getInfoAsync(dir);
      if (info.exists) {
        return true;
      }
    } catch {
      // fall through
    }
    logger.warn('[chatMediaStaging] ensureOutboxDir failed', error);
    return false;
  }
}

/** True when `uri` points inside the outbox directory (already staged). */
export function isStagedOutboxUri(uri?: string | null): boolean {
  const dir = outboxDir();
  return !!dir && typeof uri === 'string' && uri.startsWith(dir);
}

/**
 * True when `uri` refers to a local file that is verified present (non-empty).
 *
 * Only `file://` paths (staged outbox files, cache paths) are cheaply and reliably
 * stattable, so for any other scheme (`content://`, remote `http(s)://`), an empty
 * uri, or on web we return `true` (assume present) and let the uploader deal with
 * it. The guard's sole job is to catch a *known-missing* staged/local file before
 * it triggers the "Directory doesn't exist" upload IOException — not to second-guess
 * opaque uris the uploader can still resolve.
 */
export async function localMediaExists(uri?: string | null): Promise<boolean> {
  if (!isMediaStagingSupported()) {
    return true;
  }
  const value = typeof uri === 'string' ? uri.trim() : '';
  if (!value) {
    return true;
  }
  if (!value.startsWith('file://') && !isStagedOutboxUri(value)) {
    return true;
  }
  try {
    const info = await FileSystem.getInfoAsync(value, { size: true });
    return info.exists && (info.size ?? 0) > 0;
  } catch {
    // A stat error shouldn't block a send — fall back to letting the upload try.
    return true;
  }
}

/**
 * Copy a local media file into the persistent outbox directory.
 *
 * Returns the staged `file://` URI, or `null` when staging is unsupported, the
 * source is remote/empty, or the copy fails — in every `null` case the caller
 * should fall back to the original URI (never blocks a send).
 *
 * Idempotent: if the file is already staged (or the source already lives in the
 * outbox) it is returned as-is without re-copying.
 */
export async function stageOutboxMedia(
  id: string,
  sourceUri: string,
  ext?: string | null
): Promise<string | null> {
  const dir = outboxDir();
  if (!isMediaStagingSupported() || !dir) {
    return null;
  }
  const uri = typeof sourceUri === 'string' ? sourceUri.trim() : '';
  if (!uri) {
    return null;
  }
  // Remote sources are downloaded by the uploader itself; nothing to stage.
  if (/^https?:\/\//i.test(uri)) {
    return null;
  }
  // Already staged — reuse.
  if (uri.startsWith(dir)) {
    return uri;
  }
  try {
    const ready = await ensureOutboxDir(dir);
    if (!ready) {
      return null;
    }
    const dest = `${dir}${stagedFileName(id, ext)}`;
    const existing = await FileSystem.getInfoAsync(dest, { size: true });
    if (existing.exists && (existing.size ?? 0) > 0) {
      return dest;
    }
    await FileSystem.copyAsync({ from: uri, to: dest });
    // Verify the copy actually landed. On some devices copyAsync has been seen to
    // resolve without throwing while the destination file/dir is still missing
    // (the "Directory ... doesn't exist" upload IOException). Confirming here means
    // a phantom staged path is never handed back to the uploader — the caller
    // falls back to the original URI instead of failing on upload.
    const verified = await FileSystem.getInfoAsync(dest, { size: true });
    if (!verified.exists || (verified.size ?? 0) <= 0) {
      logger.warn('[chatMediaStaging] stageOutboxMedia copy not verified', {
        id,
        dest,
        exists: verified.exists,
        size: verified.exists ? verified.size : undefined,
      });
      return null;
    }
    return dest;
  } catch (error) {
    logger.warn('[chatMediaStaging] stageOutboxMedia failed', { id, error });
    return null;
  }
}

/**
 * Best-effort delete of a staged file. Accepts either a staged `file://` URI or
 * a pending id. A non-staged URI (e.g. a remote sticker/gif URL or an original
 * `content://`) is ignored, so this is always safe to call on any item.
 */
export async function removeOutboxMedia(idOrUri: string, ext?: string | null): Promise<void> {
  const dir = outboxDir();
  if (!dir) {
    return;
  }
  const value = typeof idOrUri === 'string' ? idOrUri.trim() : '';
  if (!value) {
    return;
  }
  try {
    let target: string | null = null;
    if (value.startsWith(dir)) {
      target = value; // already a staged URI
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      // Treat as a pending id -> derive the staged path.
      target = `${dir}${stagedFileName(value, ext)}`;
    }
    // A non-staged scheme URI (content://, http://) has no staged file — ignore.
    if (target) {
      await FileSystem.deleteAsync(target, { idempotent: true });
    }
  } catch (error) {
    logger.warn('[chatMediaStaging] removeOutboxMedia failed', { idOrUri, error });
  }
}

/**
 * Delete every staged file that is NOT owned by one of `activeIds`. Used once
 * per launch to reclaim files orphaned by a previous session (e.g. the app was
 * killed with staged media still queued). Never deletes files for currently
 * active pending items.
 */
export async function sweepOutboxOrphans(activeIds: Set<string>): Promise<void> {
  const dir = outboxDir();
  if (!isMediaStagingSupported() || !dir) {
    return;
  }
  try {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) {
      return;
    }
    const names = await FileSystem.readDirectoryAsync(dir);
    if (!names || names.length === 0) {
      return;
    }
    const activeTokens = new Set(Array.from(activeIds).map(safeIdToken));
    await Promise.all(
      names.map(async (name) => {
        const idToken = name.replace(/\.[^.]*$/, '');
        // Attachment files are staged per-file as `${tempId}__${index}`; treat the
        // parent tempId (before the `__<n>` suffix) as the owner so a multi-file
        // attachment's staged files are kept while its pending item is alive.
        const baseToken = idToken.replace(/__\d+$/, '');
        if (activeTokens.has(idToken) || activeTokens.has(baseToken)) {
          return;
        }
        try {
          await FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true });
        } catch {
          // best-effort
        }
      })
    );
  } catch (error) {
    logger.warn('[chatMediaStaging] sweepOutboxOrphans failed', error);
  }
}
