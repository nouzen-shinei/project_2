// Feature: upload-idempotency, Property 6: Quota delta conserves recorded usage
/**
 * Property-based tests for `computeUploadQuotaDelta` — the pure quota arithmetic
 * behind delta-based reservation (`backend-runtime/src/lib/uploadObjectPath.ts`).
 *
 * Property 6: Quota delta conserves recorded usage
 *   For any positive `newBytes` and non-negative `existingBytes`,
 *   `computeUploadQuotaDelta` returns non-negative `reserveBytes` and `shrinkBytes`
 *   with at most one non-zero, satisfying
 *   `reserveBytes - shrinkBytes === newBytes - existingBytes`.
 *   **Validates: Requirements 3.1, 3.2, 3.4**
 *
 * Property 7: A no-existing-object delta reproduces today's reservation
 *   For any positive `newBytes`, `computeUploadQuotaDelta({ newBytes, existingBytes: 0 })`
 *   equals `{ reserveBytes: newBytes, shrinkBytes: 0, isOverwrite: false }`.
 *   **Validates: Requirements 2.3, 3.3**
 *
 * ---------------------------------------------------------------------------
 * Why the conservation equation is the whole point
 * ---------------------------------------------------------------------------
 * The route applies `+reserveBytes` before the write and `-shrinkBytes` after a
 * successful write. `reserveBytes - shrinkBytes === newBytes - existingBytes` is
 * therefore the statement that recorded usage moves by exactly the true change in
 * stored bytes (Requirement 3.1) — no drift when a retry replaces a same-size
 * object, no double count when it replaces a larger or smaller one.
 *
 * ---------------------------------------------------------------------------
 * Normalization: asserted on NORMALIZED inputs in the robustness suite
 * ---------------------------------------------------------------------------
 * The module normalizes a byte count with "non-number / non-finite / <= 0 ⇒ 0,
 * otherwise `Math.floor`" (`normalizeByteCount`). That matters because
 * `existingBytes` comes from a metadata probe whose `size` field can realistically
 * arrive absent, as a string, negative or `NaN` (design Property 13). So:
 *   - Properties 6 and 7 below generate integers, where normalization is the
 *     identity and the conservation equation holds on the raw inputs.
 *   - The robustness suite feeds `NaN`, `±Infinity`, negatives and non-integers and
 *     asserts conservation against the *normalized* inputs, pinning that documented
 *     behavior rather than restating the implementation.
 * `isOverwrite === (existingBytes > 0)` is likewise asserted over the integer space:
 * for `Infinity` or `0.5` the normalized existing size is `0`, so a raw `> 0` test
 * would be the wrong expectation there (the robustness suite covers those).
 */
import * as fc from 'fast-check';

import { computeUploadQuotaDelta, type UploadQuotaDelta } from '../lib/uploadObjectPath';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** The route's hard cap: 50 MB (`app.ts`). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * `newBytes` is a positive integer: the route rejects `0` with `missing_file_body`
 * and anything above the cap with `file_too_large`, but the arithmetic must stay
 * correct well beyond the cap so the function cannot become the thing that breaks
 * if the cap is ever raised.
 */
const newBytesArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: MAX_UPLOAD_BYTES }) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 4 * MAX_UPLOAD_BYTES }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      1,
      2,
      1024,
      MAX_UPLOAD_BYTES - 1,
      MAX_UPLOAD_BYTES,
      MAX_UPLOAD_BYTES + 1,
      2 * MAX_UPLOAD_BYTES,
      Number.MAX_SAFE_INTEGER,
    ),
  },
);

/** `existingBytes` is non-negative; `0` means "no existing object". */
const existingBytesArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0, max: MAX_UPLOAD_BYTES }) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 4 * MAX_UPLOAD_BYTES }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      0,
      1,
      1024,
      MAX_UPLOAD_BYTES - 1,
      MAX_UPLOAD_BYTES,
      MAX_UPLOAD_BYTES + 1,
      Number.MAX_SAFE_INTEGER,
    ),
  },
);

/**
 * Bounded sizes for the ledger simulations below. Deliberately excludes the
 * `Number.MAX_SAFE_INTEGER` boundary that `newBytesArb` carries: the ledger tests
 * *accumulate* sizes, and a sum past 2^53 would lose precision in the test's own
 * model rather than in the code under test.
 */
const ledgerBytesArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: MAX_UPLOAD_BYTES }) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 4 * MAX_UPLOAD_BYTES }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      1,
      1024,
      MAX_UPLOAD_BYTES - 1,
      MAX_UPLOAD_BYTES,
      MAX_UPLOAD_BYTES + 1,
    ),
  },
);

/** Every numeric shape a malformed metadata probe result could realistically carry. */
const hostileNumberArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: -4 * MAX_UPLOAD_BYTES, max: 4 * MAX_UPLOAD_BYTES }) },
  { weight: 3, arbitrary: fc.double() },
  { weight: 3, arbitrary: fc.double({ min: -1e12, max: 1e12, noNaN: true }) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -0,
      -1,
      -1024,
      0.5,
      -0.5,
      1.999_999,
      1e21,
      -1e21,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MAX_SAFE_INTEGER + 2,
      Number.EPSILON,
    ),
  },
);

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/**
 * The module's documented normalization contract, restated so the robustness suite
 * can express conservation over inputs the route should never produce but a
 * malformed probe result could.
 */
function normalizedByteCount(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Shape invariants that must hold for every input, valid or not. */
function assertWellFormedDelta(delta: UploadQuotaDelta): void {
  expect(typeof delta.reserveBytes).toBe('number');
  expect(typeof delta.shrinkBytes).toBe('number');
  expect(typeof delta.isOverwrite).toBe('boolean');

  // Never negative, never non-finite: either value is fed straight into a Firestore
  // increment, so a `NaN` or a negative would corrupt the usage record.
  expect(Number.isFinite(delta.reserveBytes)).toBe(true);
  expect(Number.isFinite(delta.shrinkBytes)).toBe(true);
  expect(delta.reserveBytes).toBeGreaterThanOrEqual(0);
  expect(delta.shrinkBytes).toBeGreaterThanOrEqual(0);
  expect(Number.isInteger(delta.reserveBytes)).toBe(true);
  expect(Number.isInteger(delta.shrinkBytes)).toBe(true);

  // At most one non-zero: reserving and shrinking in the same request would mean
  // two opposing writes to the usage record for one upload.
  expect(delta.reserveBytes === 0 || delta.shrinkBytes === 0).toBe(true);
}

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------
// Feature: upload-idempotency, Property 6: Quota delta conserves recorded usage
describe('Property 6: Quota delta conserves recorded usage', () => {
  it('returns non-negative reserve/shrink with at most one non-zero, conserving newBytes - existingBytes', () => {
    fc.assert(
      fc.property(newBytesArb, existingBytesArb, (newBytes, existingBytes) => {
        const delta = computeUploadQuotaDelta({ newBytes, existingBytes });

        assertWellFormedDelta(delta);

        // The conservation equation (Requirement 3.1 / 3.2): applying `+reserveBytes`
        // then `-shrinkBytes` moves recorded usage by exactly the change in stored bytes.
        expect(delta.reserveBytes - delta.shrinkBytes).toBe(newBytes - existingBytes);
      }),
      { numRuns: 300 },
    );
  });

  it('flags an overwrite exactly when an object already occupied the path', () => {
    fc.assert(
      fc.property(newBytesArb, existingBytesArb, (newBytes, existingBytes) => {
        const delta = computeUploadQuotaDelta({ newBytes, existingBytes });
        expect(delta.isOverwrite).toBe(existingBytes > 0);
      }),
      { numRuns: 300 },
    );
  });

  it('shrinks only when the replacement is smaller, and reserves only when it is larger (Req 3.4)', () => {
    fc.assert(
      fc.property(newBytesArb, existingBytesArb, (newBytes, existingBytes) => {
        const delta = computeUploadQuotaDelta({ newBytes, existingBytes });

        if (newBytes > existingBytes) {
          expect(delta.reserveBytes).toBe(newBytes - existingBytes);
          expect(delta.shrinkBytes).toBe(0);
        } else if (newBytes < existingBytes) {
          expect(delta.reserveBytes).toBe(0);
          expect(delta.shrinkBytes).toBe(existingBytes - newBytes);
        } else {
          // The retry case: a same-size overwrite reserves nothing, so a retry of an
          // upload that already succeeded can never be rejected for quota (Req 3.6).
          expect(delta).toEqual({ reserveBytes: 0, shrinkBytes: 0, isOverwrite: existingBytes > 0 });
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------
// Feature: upload-idempotency, Property 7: A no-existing-object delta reproduces today's reservation
describe("Property 7: A no-existing-object delta reproduces today's reservation", () => {
  it('reserves the full byte count and shrinks nothing when no object exists', () => {
    fc.assert(
      fc.property(newBytesArb, (newBytes) => {
        // Backward compatibility for every non-opted-in caller (Req 2.3): with no
        // probe there is no existing object, and the reservation is today's.
        expect(computeUploadQuotaDelta({ newBytes, existingBytes: 0 })).toEqual({
          reserveBytes: newBytes,
          shrinkBytes: 0,
          isOverwrite: false,
        });
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Totality / robustness (supports Properties 6 and 7 over malformed probe input)
// ---------------------------------------------------------------------------
// Feature: upload-idempotency, Property 6: Quota delta conserves recorded usage
describe('Property 6 (totality): the delta is well-formed for any numeric input', () => {
  it('never throws and never returns a negative or non-finite value', () => {
    fc.assert(
      fc.property(hostileNumberArb, hostileNumberArb, (newBytes, existingBytes) => {
        // A malformed metadata probe result (`size` absent / string / negative / NaN)
        // can realistically reach this function, so it must be total.
        const delta = computeUploadQuotaDelta({ newBytes, existingBytes });
        assertWellFormedDelta(delta);
      }),
      { numRuns: 300 },
    );
  });

  it('conserves usage over the normalized inputs, treating non-finite/negative sizes as absent', () => {
    fc.assert(
      fc.property(hostileNumberArb, hostileNumberArb, (newBytes, existingBytes) => {
        const delta = computeUploadQuotaDelta({ newBytes, existingBytes });
        const normalizedNew = normalizedByteCount(newBytes);
        const normalizedExisting = normalizedByteCount(existingBytes);

        expect(delta.reserveBytes - delta.shrinkBytes).toBe(normalizedNew - normalizedExisting);
        expect(delta.isOverwrite).toBe(normalizedExisting > 0);
      }),
      { numRuns: 300 },
    );
  });

  it('degrades a garbage existing size to a full reservation rather than a corrupt one', () => {
    fc.assert(
      fc.property(
        newBytesArb,
        fc.constantFrom(
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          -1,
          -MAX_UPLOAD_BYTES,
          0,
          -0,
          0.5,
        ),
        (newBytes, garbageExisting) => {
          // Fails toward over-reserving (Req 9.4), never toward under-counting.
          expect(computeUploadQuotaDelta({ newBytes, existingBytes: garbageExisting })).toEqual({
            reserveBytes: newBytes,
            shrinkBytes: 0,
            isOverwrite: false,
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Applying the delta to a ledger (Requirement 3.1 end-to-end over the pure part)
// ---------------------------------------------------------------------------
// Feature: upload-idempotency, Property 6: Quota delta conserves recorded usage
describe('Property 6 (ledger): applying the delta never drifts recorded usage', () => {
  it('moves recorded usage by exactly newBytes - existingBytes for an overwrite', () => {
    fc.assert(
      fc.property(
        ledgerBytesArb,
        fc.integer({ min: 1, max: 4 * MAX_UPLOAD_BYTES }),
        fc.integer({ min: 0, max: 8 * MAX_UPLOAD_BYTES }),
        (newBytes, existingBytes, otherTenantsBytes) => {
          // `used` starts at the existing object's size plus unrelated usage, which is
          // what the usage record holds when a retry arrives.
          const before = otherTenantsBytes + existingBytes;
          const delta = computeUploadQuotaDelta({ newBytes, existingBytes });
          expect(delta.isOverwrite).toBe(true);

          // Route order: reserve before the write, release the shrink after it succeeds.
          const afterReserve = before + delta.reserveBytes;
          const after = afterReserve - delta.shrinkBytes;

          expect(after - before).toBe(newBytes - existingBytes);
          // The invariant that matters: recorded usage still equals stored bytes.
          expect(after).toBe(otherTenantsBytes + newBytes);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('keeps the ledger equal to stored bytes across a sequence of retries for one key', () => {
    fc.assert(
      fc.property(
        fc.array(ledgerBytesArb, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 8 * MAX_UPLOAD_BYTES }),
        (attemptSizes, otherTenantsBytes) => {
          // Simulated ledger + the single object at one deterministic path. Each
          // attempt probes the path, applies the delta, then last-writer-wins.
          let used = otherTenantsBytes;
          let stored = 0; // 0 == no object at the path yet

          attemptSizes.forEach((bytes, index) => {
            const delta = computeUploadQuotaDelta({ newBytes: bytes, existingBytes: stored });
            expect(delta.isOverwrite).toBe(index > 0);

            used += delta.reserveBytes;
            stored = bytes; // the write succeeds, replacing whatever was there
            used -= delta.shrinkBytes;

            // Replacing a file never drifts the counter, however many attempts run.
            expect(used).toBe(otherTenantsBytes + stored);
          });

          expect(used).toBe(otherTenantsBytes + attemptSizes[attemptSizes.length - 1]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('leaves the ledger untouched when a retry stores the same bytes (Req 3.6, 3.8)', () => {
    fc.assert(
      fc.property(ledgerBytesArb, fc.integer({ min: 0, max: 8 * MAX_UPLOAD_BYTES }), (bytes, otherTenantsBytes) => {
        const used = otherTenantsBytes + bytes;
        const delta = computeUploadQuotaDelta({ newBytes: bytes, existingBytes: bytes });

        expect(delta).toEqual({ reserveBytes: 0, shrinkBytes: 0, isOverwrite: true });
        expect(used + delta.reserveBytes - delta.shrinkBytes).toBe(used);
      }),
      { numRuns: 300 },
    );
  });
});
