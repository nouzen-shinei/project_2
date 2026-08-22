import { resolveUploadObjectPath } from './uploadObjectPath';

/**
 * The single authoritative mapping between a *stored reference* and a *bucket
 * object path*, plus the tenant-scope predicate and the quarantine namespace.
 *
 * Same posture as `src/lib/uploadObjectPath.ts`, deliberately: this module
 * performs NO I/O and imports neither `express` nor `firebase-admin` (it imports
 * only `./uploadObjectPath`, which itself imports only `node:crypto`). Every
 * function here is pure and total, so the whole safety judgement is
 * property-testable against hostile generated input with no harness.
 *
 * ── Why this module exists at all ────────────────────────────────────────────
 *
 * The comparison that decides whether an object is an orphan is
 * `retainPaths.has(file.name)`. Both sides of that comparison must be produced
 * by the *same* parser, byte for byte: a retain path that does not compare equal
 * to the listing spelling is a deletion, not a mismatch.
 *
 * `chatMessageWriter.parseStorageObjectPath` is the closest existing parser and
 * is NOT reused, because of how it decodes: it splits `URL.pathname` on `/`,
 * locates the `o` marker with `indexOf('o')`, rejoins the remainder with `/` and
 * only then calls `decodeURIComponent`. Two consequences:
 *
 *  - the marker is located by value rather than by position, so the parse
 *    depends on what the surrounding segments happen to spell;
 *  - decoding after a split/rejoin cannot distinguish a `/` that separated
 *    segments from one that arrived as a literal `%2F` inside a single segment.
 *
 * Neither shape occurs in today's data, which is why that bug is latent rather
 * than live — and why it must not be reproduced here. This module therefore
 * takes the encoded object segment WHOLE, anchored by position, and decodes it
 * exactly once with `decodeURIComponent`, BEFORE any split on `/`.
 *
 * A bare object path is the one form that is NOT decoded: it is already the
 * decoded `file.name` spelling (that is what `notices.audioStoragePath` and
 * `videoTranscodes.originalPath` store), so decoding it again would corrupt any
 * name containing a literal `%` and would break the idempotence postcondition
 * `resolve(resolve(x).objectPath, bucket, { allowBarePath: true }) === resolve(x).objectPath`.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The six managed categories, and from here on the single source of truth for
 * them. Today the list is duplicated in four places — the route-local const in
 * `app.ts` used by `/storage/delete` and `/video/request-transcode`,
 * `estimateTenantStorageBytes`'s prefix list, `tenantUsageRollup`'s
 * `DEFAULT_STORAGE_PREFIXES`, and two test files. Those copies are retired
 * separately; the sweep reads this one, so a future seventh category cannot be
 * listed and swept before its reference source exists.
 *
 * NOTE the inconsistent separator: `student_profiles` is snake_case while the
 * other five are kebab-case. That is existing production data. Do not "fix" it.
 */
export const STORAGE_TENANT_CATEGORIES = [
  'chat-files',
  'tenant-branding',
  'notices',
  'student_profiles',
  'receipts',
  'profile-pictures',
] as const;

export type StorageTenantCategory = (typeof STORAGE_TENANT_CATEGORIES)[number];

/** O(1) membership for `classifyTenantScopedPath`. Derived, never a second list. */
const MANAGED_CATEGORY_SET: ReadonlySet<string> = new Set<string>(STORAGE_TENANT_CATEGORIES);

/**
 * Quarantine namespace. Deliberately NOT a managed category, and that omission
 * is load-bearing in four separate places:
 *  - `estimateTenantStorageBytes` sums only managed categories, so quarantined
 *    bytes leave the tenant's quota the moment they move, while staying
 *    recoverable;
 *  - `/storage/delete` and `/video/request-transcode` reject any path whose
 *    first segment is not a managed category, so no client can reach quarantine;
 *  - `classifyTenantScopedPath` rejects it, so a quarantined object can never be
 *    judged as a live object;
 *  - conversely `parseQuarantinePath` *requires* it, which makes the two
 *    domains provably disjoint and confines the hard delete (Property 8).
 * The leading `_` cannot collide with any category name.
 */
export const QUARANTINE_PREFIX = '_orphan-quarantine';

/**
 * The GCS object-name limit. A longer decoded path cannot name a real object.
 *
 * ── BYTES, not UTF-16 code units ─────────────────────────────────────────────
 *
 * GCS caps an object name at 1024 **bytes** of UTF-8. This was checked with
 * `path.length`, which counts UTF-16 code units — so a path of 1024 astral-plane
 * characters measured 1024 and weighed 4096 bytes, and was accepted as an object
 * path that cannot name an object.
 *
 * Such a value can only arrive from a stored REFERENCE, never from a listing: GCS
 * would not have created the object, so `getFiles` cannot return the name. Which is
 * precisely why the measure matters — deciding what a stored reference names is the
 * whole job, and a value accepted as a path but incapable of being one is a value
 * that has been mis-measured.
 *
 * Switching the measure only ever REJECTS more: `Buffer.byteLength(s, 'utf8')` is
 * ≥ `s.length` for every string, because every UTF-16 code unit contributes at
 * least one byte. So every path rejected under the old check is still rejected, and
 * the accept side is narrowed to exactly what GCS would accept.
 */
const MAX_OBJECT_PATH_LENGTH_BYTES = 1024;

/** Filenames this codebase mints under `profile-pictures/{tenantId}/`. */
const DERIVED_PROFILE_PICTURE_FILENAME = /^[0-9a-f]{20}\.jpg$/;

// ─── The reference → object path mapping ─────────────────────────────────────

export type ResolveBucketObjectPathResult =
  | { ok: true; objectPath: string }
  | {
      ok: false;
      /**
       * Why the value is not an object path in OUR bucket. `empty`,
       * `not_a_storage_url` and `foreign_bucket` are the ordinary cases (a
       * cleared field, a raw path offered to a url field, a Giphy sticker, a
       * Google avatar) and the collector ignores them. `malformed` is the
       * interesting one, and it is the reason this returns a discriminated union
       * rather than `string | null`: a reference we cannot parse is NOT the same
       * as a reference to somewhere else. The former means some object is
       * referenced and we cannot tell which, so the caller must be able to treat
       * it as "unproven ⇒ abort" while ignoring the latter.
       */
      reason: 'empty' | 'not_a_storage_url' | 'foreign_bucket' | 'malformed';
    };

type ResolveFailureReason = 'empty' | 'not_a_storage_url' | 'foreign_bucket' | 'malformed';

function fail(reason: ResolveFailureReason): ResolveBucketObjectPathResult {
  return { ok: false, reason };
}

/**
 * A value carries a URI scheme when it matches `scheme:` before any `/`. Used to
 * refuse `javascript:`, `data:`, `mailto:` and friends as bare paths: a value
 * with a scheme is a URL, and a URL we do not recognise must never be
 * reinterpreted as a path that then retains an unrelated object.
 *
 * No object path we manage can match: the scheme character class excludes `/`,
 * and every managed path begins with a category segment that contains no `:`.
 */
const URI_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * `decodeURIComponent` exactly once, with its throw converted into a result.
 * A lone `%`, a `%zz` and an overlong sequence all land here.
 */
function decodeOnce(value: string): { ok: true; value: string } | { ok: false } {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false };
  }
}

/**
 * Coerce an untrusted Firestore/RTDB field into a string without ever throwing.
 *
 * `null` / `undefined` are the ordinary "cleared field" case ⇒ `empty`. A value
 * whose own string conversion throws (a throwing `toString`, a symbol) is
 * `malformed`: we cannot see what it says, so we cannot prove anything about it.
 * Every other value is coerced and then judged on its text, which for a number
 * or a plain object means the ordinary `not_a_storage_url` — deliberately not
 * `malformed`, so one field holding a stray number cannot abort a whole tenant.
 */
function coerceReferenceValue(
  value: unknown
): { ok: true; raw: string } | { ok: false; reason: 'empty' | 'malformed' } {
  if (value === null || value === undefined) return { ok: false, reason: 'empty' };
  if (typeof value === 'string') return { ok: true, raw: value };
  try {
    return { ok: true, raw: String(value) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/**
 * Normalise and validate a DECODED object path, in the documented order: strip a
 * single leading `/`; reject an empty, `.` or `..` segment; reject NUL; reject a
 * UTF-8 BYTE length above the GCS limit. Every rejection is `malformed`.
 *
 * Only ONE leading `/` is stripped, so `//a` fails on its empty first segment
 * rather than being quietly flattened to `a`.
 *
 * Loop invariant: every segment inspected so far is non-empty and is neither `.`
 * nor `..`. The first violation returns immediately, so a partially validated
 * path can never escape as `ok: true`.
 */
function normaliseObjectPath(decoded: string): ResolveBucketObjectPathResult {
  const path = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  for (const segment of path.split('/')) {
    if (!segment || segment === '.' || segment === '..') return fail('malformed');
  }
  if (path.includes('\u0000')) return fail('malformed');
  if (Buffer.byteLength(path, 'utf8') > MAX_OBJECT_PATH_LENGTH_BYTES) return fail('malformed');
  return { ok: true, objectPath: path };
}

/** Decode the whole encoded object segment exactly once, then normalise it. */
function resolveEncodedSegment(encoded: string): ResolveBucketObjectPathResult {
  const decoded = decodeOnce(encoded);
  if (!decoded.ok) return fail('malformed');
  return normaliseObjectPath(decoded.value);
}

/** Strip the single leading `/` that `URL.pathname` always carries. */
function stripPathnameSlash(pathname: string): string {
  return pathname.startsWith('/') ? pathname.slice(1) : pathname;
}

/**
 * Turn a stored reference into an object path in `bucketName`, or say precisely
 * why it is not one. Total: every input returns, nothing throws.
 *
 * Accepts every form a reference is stored in anywhere in this codebase:
 *   - Firebase download URL  https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{enc}?alt=media&token=…
 *   - Newer Firebase host    https://{bucket}/…  ·  https://{bucket}.firebasestorage.app/…
 *   - GCS URL                https://storage.googleapis.com/{bucket}/{path}
 *                            https://{bucket}.storage.googleapis.com/{path}
 *   - gs:// URI              gs://{bucket}/{path}
 *   - Bare object path       notices/acme/audio/notice_audio_k_….m4a   (see `allowBarePath`)
 *
 * The named bucket is verified against `bucketName` in EVERY form, `gs://` and
 * both GCS host forms included, because a reference into a foreign bucket must
 * not be credited as a retention proof for a same-named path in ours. An empty
 * `bucketName` therefore fails every value: with no bucket identity, nothing can
 * be *proven* to be ours (the same guard `isOwnBucketStorageUrl` applies).
 *
 * The input value is trimmed once before parsing — an accidentally padded stored
 * reference resolves to the object it names, which is the retention-safe
 * direction, and this codebase's own writer (`sanitizeStorageSegment`) cannot
 * produce an object name containing a space at all. The decoded object path is
 * never altered, so a round trip through `buildFirebaseDownloadUrl` is exact.
 */
export function resolveBucketObjectPath(
  value: unknown,
  bucketName: string,
  options?: {
    /**
     * Whether a value with no scheme may be treated as a bare object path.
     * TRUE for fields that store a raw path (`notices.audioStoragePath`,
     * `notices.imageStoragePath`, `videoTranscodes.originalPath` /
     * `transcodedPath`), FALSE for url fields, so a garbage url is never
     * reinterpreted as a path that then retains an unrelated object.
     */
    allowBarePath?: boolean;
  }
): ResolveBucketObjectPathResult {
  const coerced = coerceReferenceValue(value);
  if (!coerced.ok) return fail(coerced.reason);

  const trimmed = coerced.raw.trim();
  if (!trimmed) return fail('empty');

  const bucket = typeof bucketName === 'string' ? bucketName.trim() : '';
  if (!bucket) return fail('foreign_bucket');
  const bucketLower = bucket.toLowerCase();

  const lower = trimmed.toLowerCase();

  // A protocol-relative reference (`//host/path`) is a URL, not a path, and
  // `new URL` cannot parse it without a base. Refuse it explicitly so it is
  // never reinterpreted as a rooted object path.
  if (trimmed.startsWith('//')) return fail('not_a_storage_url');

  // gs://{bucket}/{path}
  if (lower.startsWith('gs://')) {
    const remainder = trimmed.slice('gs://'.length);
    const slash = remainder.indexOf('/');
    if (slash <= 0) return fail('malformed');
    const namedBucket = decodeOnce(remainder.slice(0, slash));
    if (!namedBucket.ok) return fail('malformed');
    if (namedBucket.value.toLowerCase() !== bucketLower) return fail('foreign_bucket');
    return resolveEncodedSegment(remainder.slice(slash + 1));
  }

  if (lower.startsWith('https://') || lower.startsWith('http://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return fail('malformed');
    }
    const host = parsed.hostname.toLowerCase();

    // `URL.pathname` preserves percent-encoding, so the object segment below is
    // still encoded here and is isolated by POSITION, never by searching for a
    // segment that happens to spell `o`.
    const firebaseObject = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);

    const isFirebaseApiHost = host === 'firebasestorage.googleapis.com';
    const isOwnBucketHost = host === bucketLower || host === `${bucketLower}.firebasestorage.app`;

    if (isFirebaseApiHost || isOwnBucketHost) {
      if (firebaseObject) {
        const namedBucket = decodeOnce(firebaseObject[1]);
        if (!namedBucket.ok) return fail('malformed');
        if (namedBucket.value.toLowerCase() !== bucketLower) return fail('foreign_bucket');
        return resolveEncodedSegment(firebaseObject[2]);
      }
      if (isFirebaseApiHost) {
        // The Firebase Storage API host with no `/v0/b/{bucket}/o/{object}`
        // shape names no object. Unparseable rather than foreign: we cannot tell
        // what it refers to, so the caller must not silently ignore it.
        return fail('malformed');
      }
      // Virtual-hosted download URL on our own bucket host: the whole pathname
      // is the encoded object segment.
      return resolveEncodedSegment(stripPathnameSlash(parsed.pathname));
    }

    // https://storage.googleapis.com/{bucket}/{path}
    if (host === 'storage.googleapis.com') {
      const rest = stripPathnameSlash(parsed.pathname);
      const slash = rest.indexOf('/');
      if (slash <= 0) return fail('malformed');
      const namedBucket = decodeOnce(rest.slice(0, slash));
      if (!namedBucket.ok) return fail('malformed');
      if (namedBucket.value.toLowerCase() !== bucketLower) return fail('foreign_bucket');
      return resolveEncodedSegment(rest.slice(slash + 1));
    }

    // https://{bucket}.storage.googleapis.com/{path} — the bucket is the host,
    // so the whole pathname is the object segment. Note that
    // `chatMessageWriter.parseStorageObjectPath` reads the first path segment as
    // the bucket for every `*.storage.googleapis.com` host and so mis-parses
    // this form; that is one of the reasons it is not reused.
    if (host === `${bucketLower}.storage.googleapis.com`) {
      return resolveEncodedSegment(stripPathnameSlash(parsed.pathname));
    }

    // Any other http(s) host names an object somewhere else — a Giphy sticker, a
    // Google avatar, another project's bucket. Ordinary, and ignored.
    return fail('foreign_bucket');
  }

  // Some other scheme (`javascript:`, `data:`, `mailto:`): a URL we do not
  // recognise, never a path.
  if (URI_SCHEME_PREFIX.test(trimmed)) return fail('not_a_storage_url');

  if (options?.allowBarePath !== true) return fail('not_a_storage_url');

  // A bare path is already the decoded `file.name` spelling and is NOT decoded
  // again — see the module header.
  return normaliseObjectPath(trimmed);
}

/**
 * Inverse of the download-URL form, mirroring `videoTranscoder.buildDownloadUrl`
 * exactly (including leaving the token uninterpolated-as-is, so the two cannot
 * disagree about what a stored url looks like). Used only by the round-trip
 * property test.
 */
export function buildFirebaseDownloadUrl(
  bucketName: string,
  objectPath: string,
  token: string
): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

// ─── The tenant scope guard ──────────────────────────────────────────────────

export type TenantScope =
  | { ok: true; category: StorageTenantCategory }
  | { ok: false; reason: 'not_managed_category' | 'tenant_mismatch' | 'too_shallow' };

/**
 * A value usable as one whole path segment: non-empty, no `/`, no NUL, and not a
 * dot segment. Both `tenantId` and `sweepId` must satisfy this or the quarantine
 * path would not be invertible.
 */
function isPlainPathSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\u0000') &&
    value !== '.' &&
    value !== '..'
  );
}

/**
 * `{category}/{tenantId}/…` with at least one further segment — the same
 * predicate `/storage/delete` and `/video/request-transcode` enforce inline
 * today, and the guard the sweep applies at all three of its mutation-adjacent
 * points (retain-set admission, immediately before a quarantine move, and again
 * on the reconstructed original path before a hard delete).
 *
 * The tenant segment is compared as a WHOLE segment, never with `startsWith`, so
 * tenant `acme` cannot reach `acme-2`.
 *
 * Total: a non-string path is treated as `''` and falls out as `too_shallow`; a
 * `tenantId` that is not a single plain segment (empty, dotted, slashed) is a
 * `tenant_mismatch`, so an empty tenant identifier cannot match the empty
 * segment of a path like `notices//x.jpg`.
 */
export function classifyTenantScopedPath(objectPath: string, tenantId: string): TenantScope {
  const path = typeof objectPath === 'string' ? objectPath : '';
  const segments = path.split('/');
  if (segments.length < 3 || !segments.slice(2).some((segment) => segment.length > 0)) {
    return { ok: false, reason: 'too_shallow' };
  }
  if (!MANAGED_CATEGORY_SET.has(segments[0])) {
    return { ok: false, reason: 'not_managed_category' };
  }
  if (!isPlainPathSegment(tenantId) || segments[1] !== tenantId) {
    return { ok: false, reason: 'tenant_mismatch' };
  }
  return { ok: true, category: segments[0] as StorageTenantCategory };
}

/**
 * Raised by `assertTenantScoped`. Classified non-retryable so no retry wrapper
 * can convert a scope violation into an eventual write: a violation here is a
 * programming error, and retrying it can only make it happen again.
 *
 * The message carries the tenant and the reason but NOT the object path — the
 * path is available as a field for a caller that needs it, which keeps a
 * client-supplied filename out of every incidental error log.
 */
export class TenantScopeViolation extends Error {
  readonly retryable = false as const;
  readonly reason: 'not_managed_category' | 'tenant_mismatch' | 'too_shallow';
  readonly tenantId: string;
  readonly objectPath: string;

  constructor(
    objectPath: string,
    tenantId: string,
    reason: 'not_managed_category' | 'tenant_mismatch' | 'too_shallow'
  ) {
    super(`tenant scope violation (${reason}) for tenant ${tenantId}`);
    this.name = 'TenantScopeViolation';
    this.reason = reason;
    this.tenantId = typeof tenantId === 'string' ? tenantId : '';
    this.objectPath = typeof objectPath === 'string' ? objectPath : '';
  }
}

/**
 * The guard at every mutation point. Throws exactly when
 * `classifyTenantScopedPath` returns `ok: false`.
 */
export function assertTenantScoped(objectPath: string, tenantId: string): void {
  const scope = classifyTenantScopedPath(objectPath, tenantId);
  if (!scope.ok) {
    throw new TenantScopeViolation(objectPath, tenantId, scope.reason);
  }
}

// ─── The quarantine namespace ────────────────────────────────────────────────

/**
 * `_orphan-quarantine/{tenantId}/{sweepId}/{originalPath}`.
 *
 * Asserts tenant scope on the input FIRST, so the destination is only ever built
 * out of an already-asserted path; the caller never assembles it by hand.
 *
 * Throws a `TypeError` for a `sweepId` that is not a single plain path segment,
 * because such an id would make `parseQuarantinePath` a non-inverse and the
 * hard-delete stage would then reconstruct the wrong original path.
 */
export function buildQuarantinePath(args: {
  tenantId: string;
  sweepId: string;
  objectPath: string;
}): string {
  assertTenantScoped(args.objectPath, args.tenantId);
  if (!isPlainPathSegment(args.sweepId)) {
    throw new TypeError('buildQuarantinePath: sweepId must be a single non-empty path segment');
  }
  return `${QUARANTINE_PREFIX}/${args.tenantId}/${args.sweepId}/${args.objectPath}`;
}

/**
 * Exact inverse of `buildQuarantinePath`; `null` for anything that is not a
 * well-formed quarantine path.
 *
 * This is what confines the hard delete. The purger's input domain is exactly
 * the set of strings this function accepts, and that set is DISJOINT from
 * `classifyTenantScopedPath`'s: acceptance here requires a first segment of
 * `_orphan-quarantine`, acceptance there requires a first segment in
 * `STORAGE_TENANT_CATEGORIES`, and `QUARANTINE_PREFIX` is deliberately not a
 * member of that tuple. So no live tenant-scoped path can parse as a quarantine
 * path and no quarantine path can pass the scope guard. That is a structural
 * guarantee, not a procedural "we check first" (Property 8).
 *
 * The scope of the *reconstructed* original path is deliberately NOT checked
 * here: the purger applies `assertTenantScoped` to it as its own third guard, so
 * this function stays a pure structural parse.
 */
export function parseQuarantinePath(
  path: string
): { tenantId: string; sweepId: string; objectPath: string } | null {
  if (typeof path !== 'string') return null;
  const segments = path.split('/');
  if (segments.length < 4) return null;
  if (segments[0] !== QUARANTINE_PREFIX) return null;
  const tenantId = segments[1];
  const sweepId = segments[2];
  if (!isPlainPathSegment(tenantId) || !isPlainPathSegment(sweepId)) return null;
  const objectPath = segments.slice(3).join('/');
  if (!objectPath) return null;
  return { tenantId, sweepId, objectPath };
}

// ─── Profile pictures ───────────────────────────────────────────────────────

/**
 * The object path a profile picture for `email` in `tenantId` would occupy,
 * obtained by INVOKING the writer's own resolver rather than by re-deriving it.
 *
 * `hashStorageKey` and `sanitizeStorageSegment` are never re-implemented here:
 * this prefix is retained by derivation rather than by field reading (a user who
 * switches back to their Google picture keeps a live object with no document
 * field pointing at it), so a sweep that hashed emails its own way would delete
 * exactly the avatars it is meant to protect.
 *
 * Returns `null` when the email is blank after the writer's own normalisation —
 * there is no such object to retain.
 */
export function deriveProfilePicturePath(args: { tenantId: string; email: string }): string | null {
  const resolved = resolveUploadObjectPath({
    purpose: 'profilePicture',
    tenantId: args.tenantId,
    email: args.email,
    // The `profilePicture` branch is deterministic on tenant + email: it accepts
    // and ignores an upload key, and never reads `now` or `randomSuffix`. They
    // are passed as fixed values so this derivation is pure.
    uploadKeyHash: null,
    now: 0,
    randomSuffix: '',
  });
  return resolved.ok ? resolved.objectPath : null;
}

/**
 * Whether a filename under `profile-pictures/{tenantId}/` is one this codebase
 * mints — `hashStorageKey`'s 20 hex characters plus `.jpg`.
 *
 * An object here whose name fails this predicate is retained as `unmanaged_path`
 * rather than reported: an unexpected shape means the derivation above does not
 * describe it, and an undescribed object is not a proven orphan.
 */
export function isDerivedProfilePictureFilename(name: string): boolean {
  return typeof name === 'string' && DERIVED_PROFILE_PICTURE_FILENAME.test(name);
}
