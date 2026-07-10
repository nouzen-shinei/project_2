// Path-safe client message identity helpers (stuck-message-delivery-fix hotfix).
//
// Firebase Realtime Database rejects any path segment that contains one of the
// characters `.`, `#`, `$`, `[`, `]`, or `/`. A pending/temp id minted on the
// client becomes the message `clientMsgId`, which the backend uses as a
// `.child(<clientMsgId>)` path segment in the per-conversation idempotency index
// (`conversationClientMsgIndex/<conversationKey>/<clientMsgId>`). If the id
// contains any of those characters the write is rejected with an HTTP 500 and the
// send can never complete.
//
// The regression came from the OFFLINE-queued text path minting
// `pending_${Date.now()}_${Math.random()}` — raw `Math.random()` yields e.g.
// `0.2959597461785538`, whose `.` is illegal in an RTDB path. `generatePendingId`
// replaces every ad-hoc mint with a single, always-path-safe implementation, and
// `sanitizeClientMsgId` is the deterministic transform applied on BOTH the client
// (before a clientMsgId is placed on an outgoing payload) and the server (before a
// clientMsgId is used as a path segment) so the idempotency key matches on either
// side regardless of which computed it.

// The six characters Firebase RTDB forbids in a path segment: . # $ [ ] /
const ILLEGAL_RTDB_PATH_CHARS = /[.#$[\]/]/g;

/**
 * Deterministically map an id to an RTDB-path-safe form by replacing each illegal
 * path character (`.`, `#`, `$`, `[`, `]`, `/`) with `_`. Trims surrounding
 * whitespace first. Must remain byte-for-byte identical to the server-side
 * implementation in `backend-runtime/src/chatMessageWriter.ts` so the idempotency
 * index key matches on both sides.
 *
 * Idempotent: `sanitizeClientMsgId(sanitizeClientMsgId(x)) === sanitizeClientMsgId(x)`.
 */
export function sanitizeClientMsgId(id: unknown): string {
  if (typeof id !== 'string') {
    return '';
  }
  return id.trim().replace(ILLEGAL_RTDB_PATH_CHARS, '_');
}

/**
 * Mint a new pending/temp id that is guaranteed to be RTDB-path-safe. Uses
 * `Date.now()` for rough ordering plus base36 entropy from `Math.random()`
 * (never the raw `Math.random()` decimal, which contains a `.`). The whole result
 * is run through `sanitizeClientMsgId` as a final safety net so it can never
 * contain an illegal path character even if the prefix does.
 */
export function generatePendingId(prefix: string): string {
  const safePrefix = sanitizeClientMsgId(typeof prefix === 'string' ? prefix : '') || 'id';
  // Two base36 slices guarantee non-empty entropy even in the degenerate case
  // where a single `Math.random().toString(36)` yields a very short string.
  const entropy =
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return sanitizeClientMsgId(`${safePrefix}_${Date.now()}_${entropy}`);
}
