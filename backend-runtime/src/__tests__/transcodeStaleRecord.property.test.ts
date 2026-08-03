// Feature: upload-idempotency, Property 15: A recorded transcode is reused exactly when the original's content is unchanged

/**
 * Property 15: A recorded transcode is reused exactly when the original's content
 * is unchanged (upload-idempotency follow-up F21).
 *
 * Validates: Requirements 5.4
 *
 * `decideTranscodeReuse` is the single decision point that separates an ORDINARY
 * RETRY of one logical upload (same `uploadKey`, same bytes, first response lost —
 * must still dedupe) from a GENUINELY DIFFERENT upload that reuses the same key
 * (must get a fresh transcode). Both directions are asserted here, because getting
 * either one wrong is a user-visible defect:
 *
 *   - re-transcoding a retry undoes the idempotency the whole feature exists for;
 *   - reusing across a content change serves the PREVIOUS video forever, since the
 *     recorded `transcodedUrl` points at `{base}_h264.mp4` — a different object that
 *     still exists and still plays.
 *
 * The migration posture is part of the property, not an exception to it: when either
 * side carries no content identity the answer is "unknown", and "unknown" must
 * resolve to today's behaviour (reuse) rather than to a retroactive re-transcode of
 * every pre-existing document.
 */

import * as fc from 'fast-check';

// firebase-admin is imported by the module under test. Nothing here touches it —
// `decideTranscodeReuse` and `videoContentIdentity` are pure — so a bare stub keeps
// the suite hermetic and fast.
jest.mock('firebase-admin', () => ({
  firestore: Object.assign(jest.fn(), {
    FieldValue: {
      serverTimestamp: jest.fn(),
      delete: jest.fn(),
    },
  }),
  storage: jest.fn(),
}));

import { decideTranscodeReuse, videoContentIdentity } from '../videoTranscoder';

const NUM_RUNS = 200;

/** A non-empty content-identity string, in the shape the module actually stores. */
const contentHash = fc
  .string({
    unit: fc.constantFrom(...'0123456789abcdef'.split('')),
    minLength: 8,
    maxLength: 64,
  })
  .map((hex) => `sha256:${hex}`);

/** Anything Firestore can hand back in a field the decision reads. */
const anyFieldValue = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(''),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant({}),
  fc.constant([]),
);

const transcodedUrl = fc.webUrl({ withQueryParameters: true }).filter((u) => u.length > 0);

describe('Property 15: a recorded transcode is reused exactly when the content is unchanged', () => {
  // ── The invariant: a same-bytes retry must NEVER schedule a second transcode ──
  it('reuses the recorded transcode for any identical content identity (same-bytes retry)', () => {
    fc.assert(
      fc.property(transcodedUrl, contentHash, (url, hash) => {
        const decision = decideTranscodeReuse(
          { transcodedUrl: url, originalContentHash: hash },
          hash
        );
        expect(decision).toEqual({ action: 'reuse', reason: 'content_unchanged' });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // ── The defect: different bytes at the same path must get a fresh transcode ──
  it('re-transcodes for any pair of differing content identities', () => {
    fc.assert(
      fc.property(
        transcodedUrl,
        contentHash,
        contentHash,
        (url, recorded, incoming) => {
          fc.pre(recorded !== incoming);
          const decision = decideTranscodeReuse(
            { transcodedUrl: url, originalContentHash: recorded },
            incoming
          );
          expect(decision).toEqual({ action: 'retranscode', reason: 'content_changed' });
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  // ── Migration posture: absent identity preserves today's behaviour ──
  it('reuses (never re-transcodes) whenever either side carries no usable content identity', () => {
    fc.assert(
      fc.property(transcodedUrl, anyFieldValue, anyFieldValue, (url, recorded, incoming) => {
        const recordedUsable = typeof recorded === 'string' && recorded.length > 0;
        const incomingUsable = typeof incoming === 'string' && incoming.length > 0;
        fc.pre(!recordedUsable || !incomingUsable);

        const decision = decideTranscodeReuse(
          { transcodedUrl: url, originalContentHash: recorded },
          incoming as string | undefined
        );
        expect(decision).toEqual({ action: 'reuse', reason: 'content_identity_unknown' });
      }),
      { numRuns: NUM_RUNS }
    );
  });

  // ── No recorded output ⇒ the guard never fires, whatever the identities are ──
  it('always transcodes when the document carries no usable transcodedUrl', () => {
    fc.assert(
      fc.property(
        anyFieldValue.filter((v) => !(typeof v === 'string' && v.length > 0)),
        anyFieldValue,
        anyFieldValue,
        (url, recorded, incoming) => {
          const decision = decideTranscodeReuse(
            { transcodedUrl: url, originalContentHash: recorded },
            incoming as string | undefined
          );
          expect(decision).toEqual({ action: 'transcode', reason: 'no_existing_output' });
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  // ── Totality: this runs on the critical path of every transcode job ──
  it('is total over arbitrary document shapes and never returns anything outside the union', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant({}),
          fc.dictionary(fc.string(), anyFieldValue),
          fc.record({ transcodedUrl: anyFieldValue, originalContentHash: anyFieldValue }),
        ),
        anyFieldValue,
        (existing, incoming) => {
          const decision = decideTranscodeReuse(
            existing as Record<string, unknown> | null | undefined,
            incoming as string | undefined
          );
          expect(['transcode', 'reuse', 'retranscode']).toContain(decision.action);
          if (decision.action === 'retranscode') {
            // A re-transcode is destructive (it clears the recorded output and will
            // delete a fresh original), so it may only ever be reached from two
            // usable, DIFFERENT identities.
            expect(typeof (existing as any)?.originalContentHash).toBe('string');
            expect(typeof incoming).toBe('string');
            expect((existing as any).originalContentHash).not.toBe(incoming);
          }
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });
});

describe('videoContentIdentity', () => {
  it('is deterministic: identical bytes always yield the identical identity', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const a = videoContentIdentity(Buffer.from(bytes));
        const b = videoContentIdentity(Buffer.from(bytes));
        expect(a).toBe(b);
        expect(a.startsWith('sha256:')).toBe(true);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('distinguishes differing byte sequences', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 512 }),
        fc.uint8Array({ maxLength: 512 }),
        (left, right) => {
          fc.pre(Buffer.compare(Buffer.from(left), Buffer.from(right)) !== 0);
          expect(videoContentIdentity(Buffer.from(left))).not.toBe(
            videoContentIdentity(Buffer.from(right))
          );
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('is total for an empty body', () => {
    expect(videoContentIdentity(Buffer.alloc(0))).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
