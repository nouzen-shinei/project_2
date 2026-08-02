import crypto from 'node:crypto';

/**
 * Pure object-path + quota arithmetic for `POST /storage/upload`.
 *
 * Extracted from `src/app.ts` so per-purpose path correctness, determinism,
 * traversal safety and backward compatibility are unit-testable without an
 * Express / Firebase Admin harness (same precedent as
 * `src/lib/backgroundUploadMessage.ts`).
 *
 * This module performs NO I/O: it imports neither `express` nor `firebase-admin`,
 * only `node:crypto` for hashing. Probing the bucket and reserving quota stay in
 * `app.ts`.
 *
 * Every path produced here stays under `{category}/{tenantId}/…` for one of the
 * six categories in `STORAGE_TENANT_CATEGORIES` (`app.ts`), so `/storage/delete`
 * authorization, `/video/request-transcode`'s tenant guard,
 * `estimateTenantStorageBytes`'s prefix summing and `storage.rules` keep working
 * unchanged:
 *   chat-files | tenant-branding | notices | student_profiles | receipts |
 *   profile-pictures
 */

export type StorageUploadPurpose =
  | 'chat'
  | 'tenantLogo'
  | 'noticeImage'
  | 'noticeAudio'
  | 'studentProfile'
  | 'receipt'
  | 'profilePicture';

/**
 * Marker prefixing the upload-key hash in a deterministic path. Keeps
 * deterministic objects visually identifiable and cannot collide with the legacy
 * namespace, because every legacy variable segment begins with a decimal
 * timestamp.
 */
const DETERMINISTIC_MARKER = 'k_';

/** Domain separator for `deriveUploadKeyHash`, versioned so it can be rotated. */
const UPLOAD_KEY_HASH_DOMAIN = 'upload-key-v1';

/**
 * Relocated unchanged from `app.ts`: reduces a path segment to `[A-Za-z0-9._-]`,
 * so `/`, `\` and NUL cannot survive. Returns `''` for a blank input — callers
 * that use the value as a whole path segment must supply a fallback.
 */
export function sanitizeStorageSegment(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Relocated unchanged from `app.ts`. */
export function inferExtensionFromContentType(contentType?: string | null, fallback = 'bin'): string {
  const ct = (contentType ?? '').trim().toLowerCase();
  if (ct === 'image/png') return 'png';
  if (ct === 'image/jpeg' || ct === 'image/jpg') return 'jpg';
  if (ct === 'image/webp') return 'webp';
  if (ct === 'image/svg+xml') return 'svg';
  if (ct === 'audio/mpeg' || ct === 'audio/mp3') return 'mp3';
  if (ct === 'audio/wav') return 'wav';
  if (ct === 'audio/ogg') return 'ogg';
  if (ct === 'audio/mp4' || ct === 'audio/m4a') return 'm4a';
  if (ct === 'application/pdf') return 'pdf';
  return fallback;
}

/** Relocated unchanged from `app.ts`: sha256 of `value`, truncated to 20 hex chars. */
export function hashStorageKey(value: string): string {
  return crypto.createHash('sha256').update(value ?? '', 'utf8').digest('hex').slice(0, 20);
}

/** Relocated unchanged from `app.ts`: keeps an existing `c_…` folder, hashes anything else. */
export function normalizeConversationFolder(value: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return 'unassigned';
  if (trimmed.startsWith('c_') && trimmed.length >= 10) return trimmed;
  return `c_${hashStorageKey(trimmed)}`;
}

export interface DeriveUploadKeyHashArgs {
  /** Raw, untrusted client value. Never interpolated into a path. */
  uploadKey?: string | null;
  /** From `req.tenantAccess`, never from the query string. */
  tenantId: string;
  purpose: StorageUploadPurpose;
  /** From `req.authContext`. */
  actorUid: string;
}

/**
 * Bind a client-supplied `uploadKey` to server-derived scope before hashing, so
 * the same literal key from a different tenant, purpose or actor can never
 * resolve to the same object.
 *
 * Returns `null` when the key is absent or blank after trimming (⇒ legacy path).
 * Otherwise returns exactly 20 lowercase hex characters, which is the only
 * `uploadKey`-derived content that ever reaches an object path.
 */
export function deriveUploadKeyHash(args: DeriveUploadKeyHashArgs): string | null {
  const trimmedKey = (args.uploadKey ?? '').trim();
  if (!trimmedKey) return null;

  // NUL-separated so the server-derived scope fields cannot be spoofed by a key
  // that embeds the separator (the untrusted value is always last).
  const material = [
    UPLOAD_KEY_HASH_DOMAIN,
    args.tenantId ?? '',
    args.purpose,
    args.actorUid ?? '',
    trimmedKey,
  ].join('\u0000');

  return hashStorageKey(material);
}

export interface ResolveUploadObjectPathArgs {
  purpose: StorageUploadPurpose;
  /** Server-derived (`tenantAccess.tenantId`). */
  tenantId: string;
  /** Raw client value; sanitized internally. */
  filename?: string;
  contentType?: string | null;
  /** chat only. */
  conversationFolder?: string;
  /** receipt only. */
  feeId?: string;
  /** profilePicture only. */
  email?: string;
  /** Result of `deriveUploadKeyHash()`. `null` ⇒ legacy timestamped path. */
  uploadKeyHash: string | null;
  /** Injected for testability; the route passes `Date.now()`. Ignored when deterministic. */
  now: number;
  /**
   * Injected for testability; the route passes `crypto.randomBytes(3).toString('hex')`.
   * Ignored when deterministic.
   */
  randomSuffix: string;
}

export type ResolveUploadObjectPathResult =
  | {
      ok: true;
      objectPath: string;
      deterministic: boolean;
      safeExt: string;
      safeName: string;
    }
  | { ok: false; error: 'missing_email' | 'invalid_upload_purpose' };

/**
 * Sanitize a client value that is used as a WHOLE path segment.
 *
 * `sanitizeStorageSegment` keeps `.`, so a value of exactly `.` or `..` would
 * otherwise become a relative-path segment. Those two inputs fall back instead;
 * every other input is byte-identical to what `app.ts` produces today.
 */
function sanitizeWholeSegment(value: string | undefined, fallback: string): string {
  const sanitized = sanitizeStorageSegment(value || fallback) || fallback;
  if (sanitized === '.' || sanitized === '..') return fallback;
  return sanitized;
}

/**
 * Single source of truth for object placement: owns all fourteen formats (seven
 * legacy, seven deterministic).
 *
 * Legacy output (when `uploadKeyHash === null` and the purpose is not
 * `profilePicture`) reproduces today's `app.ts` formats character-for-character —
 * `now` and `randomSuffix` are the only variability. A deterministic path is
 * independent of both.
 */
export function resolveUploadObjectPath(
  args: ResolveUploadObjectPathArgs
): ResolveUploadObjectPathResult {
  const tenantId = args.tenantId;
  const timestamp = args.now;

  // Mirrors app.ts's derivation order exactly (filename -> ext fallback -> ext).
  const filename = sanitizeStorageSegment(args.filename || 'file');
  const extFallback = filename.split('.').pop() || 'bin';
  const ext = inferExtensionFromContentType(args.contentType, extFallback);
  const safeExt = sanitizeStorageSegment(ext) || 'bin';

  const deterministic = args.uploadKeyHash !== null || args.purpose === 'profilePicture';
  // Defense in depth: a well-formed hash from deriveUploadKeyHash is already
  // `[0-9a-f]{20}`, so this is the identity for every valid input.
  const keyHash = args.uploadKeyHash === null ? null : sanitizeStorageSegment(args.uploadKeyHash);
  const keyed = keyHash !== null;
  const keySegment = `${DETERMINISTIC_MARKER}${keyHash ?? ''}`;

  // `randomSuffix` is server-generated hex; sanitizing it is the identity, and
  // guarantees no separator can reach the path even if a caller passes garbage.
  const randomSuffix = sanitizeStorageSegment(args.randomSuffix ?? '');

  const genericSafeName = filename || `file.${safeExt}`;

  switch (args.purpose) {
    case 'chat': {
      // No dot-segment guard needed: normalizeConversationFolder always returns a
      // `c_…`-prefixed value (or a pre-existing `c_…` folder), never `.`/`..`.
      const rawConversationFolder =
        sanitizeStorageSegment(args.conversationFolder || 'unassigned') || 'unassigned';
      const conversationFolder = normalizeConversationFolder(rawConversationFolder);
      const safeName = genericSafeName;
      const variable = keyed ? `${keySegment}_${safeName}` : `${timestamp}_${safeName}`;
      return {
        ok: true,
        objectPath: `chat-files/${tenantId}/${conversationFolder}/${variable}`,
        deterministic,
        safeExt,
        safeName,
      };
    }
    case 'tenantLogo': {
      const variable = keyed ? `logo_${keySegment}.${safeExt}` : `logo_${timestamp}.${safeExt}`;
      return {
        ok: true,
        objectPath: `tenant-branding/${tenantId}/${variable}`,
        deterministic,
        safeExt,
        safeName: genericSafeName,
      };
    }
    case 'noticeImage': {
      const variable = keyed
        ? `notice_${keySegment}.${safeExt}`
        : `notice_${timestamp}_${randomSuffix}.${safeExt}`;
      return {
        ok: true,
        objectPath: `notices/${tenantId}/${variable}`,
        deterministic,
        safeExt,
        safeName: genericSafeName,
      };
    }
    case 'noticeAudio': {
      const variable = keyed
        ? `notice_audio_${keySegment}.${safeExt}`
        : `notice_audio_${timestamp}_${randomSuffix}.${safeExt}`;
      return {
        ok: true,
        objectPath: `notices/${tenantId}/audio/${variable}`,
        deterministic,
        safeExt,
        safeName: genericSafeName,
      };
    }
    case 'studentProfile': {
      const variable = keyed
        ? `${keySegment}_profile.${safeExt}`
        : `${timestamp}_profile.${safeExt}`;
      return {
        ok: true,
        objectPath: `student_profiles/${tenantId}/${variable}`,
        deterministic,
        safeExt,
        safeName: genericSafeName,
      };
    }
    case 'receipt': {
      const feeId = sanitizeWholeSegment(args.feeId, 'unknown');
      const safeName = filename || `receipt.${safeExt}`;
      const variable = keyed ? `${keySegment}_${safeName}` : `${timestamp}_${safeName}`;
      return {
        ok: true,
        objectPath: `receipts/${tenantId}/${feeId}/${variable}`,
        deterministic,
        safeExt,
        safeName,
      };
    }
    case 'profilePicture': {
      // Already deterministic before this feature existed: one stable object per
      // user, keyed on email. An `uploadKey` is accepted and deliberately ignored.
      const emailKeyRaw = sanitizeStorageSegment((args.email || '').toLowerCase().replace(/\s+/g, ''));
      if (!emailKeyRaw) {
        return { ok: false, error: 'missing_email' };
      }
      const emailKey = hashStorageKey(emailKeyRaw);
      return {
        ok: true,
        objectPath: `profile-pictures/${tenantId}/${emailKey}.jpg`,
        deterministic: true,
        safeExt,
        safeName: genericSafeName,
      };
    }
    default:
      // Unreachable for the typed union; still required for untyped JS callers so
      // no input combination can fall through to an empty path.
      return { ok: false, error: 'invalid_upload_purpose' };
  }
}

export interface UploadQuotaDelta {
  /** Bytes to reserve before writing. 0 when the replacement is same-size or smaller. */
  reserveBytes: number;
  /** Bytes to release AFTER a successful write, when the replacement is smaller. */
  shrinkBytes: number;
  /** True when an object already existed at the deterministic path. */
  isOverwrite: boolean;
}

export interface ComputeUploadQuotaDeltaArgs {
  newBytes: number;
  /** `0` means "no existing object". */
  existingBytes: number;
}

function normalizeByteCount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * Pure quota arithmetic. `existingBytes === 0` reproduces today's full-file
 * reservation exactly.
 *
 * Invariant: `reserveBytes - shrinkBytes === newBytes - existingBytes`, at most
 * one of the two is non-zero, and both are non-negative — so applying
 * `+reserveBytes` then `-shrinkBytes` moves recorded usage by exactly the true
 * change in stored bytes.
 */
export function computeUploadQuotaDelta(args: ComputeUploadQuotaDeltaArgs): UploadQuotaDelta {
  const newBytes = normalizeByteCount(args.newBytes);
  const existingBytes = normalizeByteCount(args.existingBytes);
  const diff = newBytes - existingBytes;
  return {
    reserveBytes: diff > 0 ? diff : 0,
    shrinkBytes: diff < 0 ? -diff : 0,
    isOverwrite: existingBytes > 0,
  };
}
