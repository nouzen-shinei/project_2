/**
 * Client-side idempotency keys for backend file uploads (upload-idempotency spec).
 *
 * `POST /storage/upload` accepts an optional `uploadKey`. When one is present the
 * backend hashes it with server-derived scope (tenant + purpose + actor) and writes
 * to a DETERMINISTIC object path, so a retry after a lost response *overwrites* the
 * first attempt's object instead of orphaning a second one.
 *
 * The contract that makes that work lives here, on the client:
 *
 *   - Mint the key ONCE per logical user action (one tap of "attach receipt", one
 *     chat send), BEFORE entering any retry loop, and pass the same value to every
 *     attempt — web XHR path, native fetch path and the native background uploader
 *     alike. Re-minting mid-loop defeats the entire feature.
 *   - A NEW user action gets a FRESH key, so deliberately repeating an action still
 *     produces a second object rather than silently clobbering the first.
 *   - Chat needs no new identifier: it already has a per-send stable `clientMsgId`
 *     (equal to the pending `tempId`), so it derives its key with
 *     `uploadKeyFromStableId`. That determinism is what lets a foreground fallback
 *     after a failed background start reuse the SAME key, and therefore the same
 *     stored object.
 *
 * Every value produced here is 8–200 characters, satisfying the endpoint's
 * `z.string().trim().min(8).max(200)` validation, and is restricted to
 * `[A-Za-z0-9_-]` so it survives URL query encoding untouched. That charset is
 * exactly what `lib/pendingId.ts#generatePendingId` emits, so a chat `clientMsgId`
 * passes through `uploadKeyFromStableId` byte-for-byte unchanged.
 *
 * Pure module: no React, no network, no `react-native` imports — safe to import
 * from both native and web code paths.
 */

/** The endpoint's validation window (`min(8).max(200)`). */
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 200;

/** Everything outside the conservative URL/path-safe set becomes `_`. */
const UNSAFE_KEY_CHARS = /[^A-Za-z0-9_-]/g;

/** A prefix is for log readability only; cap it so it can never crowd out entropy. */
const MAX_PREFIX_LENGTH = 32;

/** Length of `stableFingerprint()` output — two base36-padded 32-bit hashes. */
const FINGERPRINT_LENGTH = 14;

/**
 * Per-session monotonic counter, mixed into the non-`randomUUID` mint path so two
 * calls landing in the same millisecond can never produce the same key.
 */
let mintCounter = 0;

/** Replace every character outside `[A-Za-z0-9_-]` with `_` (length-preserving). */
function sanitizeKey(value: string): string {
  return value.replace(UNSAFE_KEY_CHARS, '_');
}

/**
 * Deterministic 14-char base36 fingerprint of a string (FNV-1a 32-bit + djb2
 * 32-bit, ~64 bits combined). Used to pad a too-short id and to disambiguate a
 * truncated too-long one, so `uploadKeyFromStableId` stays deterministic and
 * distinct ids keep distinct keys. Not a security primitive — the backend does its
 * own hashing with server-derived scope.
 *
 * Exported so `lib/uploadFileName.ts` derives its stable object *filename* from
 * the same one implementation rather than a second copy: the upload key and the
 * upload filename together identify the stored object (the backend's deterministic
 * chat path is `k_{hash(uploadKey)}_{safeName}`), so the two must not drift apart.
 * Output is `[0-9a-z]{14}`, i.e. already safe for a URL query value and for a
 * storage path segment.
 */
export function stableFingerprint(value: string): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    fnv = Math.imul((fnv ^ code) >>> 0, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + code) >>> 0;
  }
  return `${fnv.toString(36).padStart(7, '0')}${djb.toString(36).padStart(7, '0')}`;
}

/**
 * Bring any candidate into the sanitized 8–200 character window. `seed` is the
 * value the fingerprint is derived from (the raw, pre-sanitization input), so the
 * result is a pure function of the caller's input.
 */
function clampKey(candidate: string, seed: string): string {
  const safe = sanitizeKey(candidate);
  if (safe.length > MAX_KEY_LENGTH) {
    const head = safe.slice(0, MAX_KEY_LENGTH - FINGERPRINT_LENGTH - 1);
    return `${head}_${stableFingerprint(seed)}`;
  }
  if (safe.length < MIN_KEY_LENGTH) {
    return `${safe.length > 0 ? safe : 'id'}_${stableFingerprint(seed)}`;
  }
  return safe;
}

/**
 * `crypto.randomUUID()` when the runtime actually has it, else `null`.
 *
 * Feature-detected rather than assumed: it is absent on plain React Native /
 * Hermes without a `react-native-get-random-values`-style polyfill, and absent on
 * the web outside a secure context. Property access is wrapped because a partial
 * polyfill can throw from a getter or return a non-string.
 */
function cryptoRandomUuid(): string | null {
  try {
    const runtimeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (!runtimeCrypto || typeof runtimeCrypto.randomUUID !== 'function') {
      return null;
    }
    const uuid = runtimeCrypto.randomUUID();
    return typeof uuid === 'string' && uuid.length >= MIN_KEY_LENGTH ? uuid : null;
  } catch {
    return null;
  }
}

/**
 * `${Date.now().toString(36)}_${random}` fallback for runtimes without
 * `crypto.randomUUID`. Two base36 slices guarantee non-empty entropy even in the
 * degenerate case where one `Math.random().toString(36)` yields a very short
 * string (the same guard `lib/pendingId.ts#generatePendingId` uses), and the
 * monotonic counter covers same-millisecond calls.
 */
function fallbackKeyCore(): string {
  mintCounter += 1;
  const entropy =
    Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
  return `${Date.now().toString(36)}_${mintCounter.toString(36)}_${entropy}`;
}

/**
 * Mint a fresh, high-entropy upload key for ONE logical upload action.
 *
 * Call this once, before any retry loop, and pass the result to every attempt.
 * Two calls never return the same value, so two separate user actions produce two
 * distinct objects. The optional `prefix` (e.g. `'receipt'`) only aids log
 * readability; it is sanitized and capped and carries no meaning for the backend.
 */
export function newUploadKey(prefix?: string): string {
  const safePrefix =
    typeof prefix === 'string' ? sanitizeKey(prefix.trim()).slice(0, MAX_PREFIX_LENGTH) : '';
  const core = cryptoRandomUuid() ?? fallbackKeyCore();
  const candidate = safePrefix.length > 0 ? `${safePrefix}_${core}` : core;
  return clampKey(candidate, candidate);
}

/**
 * Reuse an existing stable id (a chat `clientMsgId` / pending `tempId`) as an
 * upload key, normalized and padded/truncated into the 8–200 character window.
 *
 * Deterministic: the same `id` always yields the same key. Chat depends on that —
 * a foreground fallback after a failed background start derives the key from the
 * same `clientMsgId` and therefore targets the same stored object.
 */
export function uploadKeyFromStableId(id: string): string {
  const raw = typeof id === 'string' ? id.trim() : '';
  return clampKey(raw, raw);
}

/**
 * The stable id that identifies file `index` of a logical action seeded by `base`.
 *
 * This is the ONE seed both halves of a stored object's identity come from: the
 * `uploadKey` (via `uploadKeyFromStableId`, i.e. `uploadKeyForFileIndex` below) and
 * the object filename (via `deriveStableUploadFileName` in `lib/uploadFileName.ts`).
 * The backend's deterministic chat path is
 * `chat-files/{tenant}/{folder}/k_{hash(uploadKey)}_{safeName}`, so a caller that
 * derives the two halves from different seeds resolves to a different object than a
 * caller that agrees on one — which is exactly how the background and foreground
 * transports used to disagree for a single-file attachment send.
 *
 * `index === 0` returns the base UNCHANGED, deliberately: a single-file send is
 * just file 0 of a one-file send, and the single-file transports (the native
 * background uploader, and the chat sticker/GIF path) key on the bare
 * `clientMsgId`. Making index 0 the canonical bare form is what lets the multi-file
 * fan-out and those single-file transports land on ONE object for the same send
 * without either side special-casing the other. Files 1..N-1 get an `__{index}`
 * suffix, so every file of one send stays distinct.
 *
 * (A base that itself ends in `__{n}` could in principle alias file `n` of a
 * shorter base. Real bases are `generatePendingId` values — `pm_{ts}_{rand}` — or a
 * `newUploadKey()`, neither of which ends that way, and an alias would merely
 * overwrite within one device's own sends.)
 */
export function stableIdForFileIndex(base: string, index: number): string {
  const rawBase = typeof base === 'string' ? base.trim() : '';
  const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  return safeIndex === 0 ? rawBase : `${rawBase}__${safeIndex}`;
}

/**
 * Derive the upload key for file `index` of a MULTI-file logical action from a
 * single base id (a chat `clientMsgId`, or a per-invocation `newUploadKey()` when
 * there is no stable id to key on).
 *
 * Every file of one send needs its own key, and one shared key for all N is not an
 * option. The backend's deterministic chat path is
 * `chat-files/{tenant}/{folder}/k_{hash(uploadKey)}_{safeName}`
 * (`backend-runtime/src/lib/uploadObjectPath.ts`), so N files sharing one key
 * resolve to paths that differ ONLY by filename — and two attachments with the same
 * filename in one send (two `image.jpg` picked from different folders, two
 * `IMG_0001.HEIC` off a camera roll) would collapse onto a single object and
 * silently lose a file. Indexing is what keeps them apart; the filename difference
 * must not be relied on.
 *
 * Deterministic in both arguments, so file `i` of a re-driven send derives the same
 * key and overwrites its own first attempt rather than orphaning it. Distinct
 * `index` values yield distinct keys even when the base is long enough to be
 * truncated, because the fingerprint is taken over the full seed.
 *
 * `index === 0` yields exactly `uploadKeyFromStableId(base)` — see
 * `stableIdForFileIndex` for why that canonical form matters: it is what makes a
 * single-file foreground attachment send agree with the native background
 * transport, which keys on the bare `clientMsgId`.
 */
export function uploadKeyForFileIndex(base: string, index: number): string {
  return uploadKeyFromStableId(stableIdForFileIndex(base, index));
}
