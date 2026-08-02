// Feature: upload-idempotency, Property 8: Rollback releases exactly what was reserved
/**
 * Property-based tests for the reserve → write → (rollback | shrink-release)
 * sequence of `POST /storage/upload` (`backend-runtime/src/app.ts`), driven against
 * an in-memory quota ledger.
 *
 * Property 8: Rollback releases exactly what was reserved
 *   For any upload that fails at the storage-write step, the amount released equals
 *   `delta.reserveBytes` for that request, so recorded usage returns to its
 *   pre-request value and `shrinkBytes` is never released while the previous object
 *   still exists.
 *   **Validates: Requirements 3.7**
 *
 * ---------------------------------------------------------------------------
 * What is real here and what is modeled
 * ---------------------------------------------------------------------------
 * The reserve/release decision comes from the REAL `computeUploadQuotaDelta`
 * (`src/lib/uploadObjectPath.ts`). The test never re-derives the delta arithmetic —
 * if it did, it would only be checking itself.
 *
 * What the test models is the part `app.ts` inlines in the route handler and does
 * not expose: the ORDER of operations and the `reservedBytes` threading between
 * them. `simulateUploadRequest` below mirrors the route line-for-line:
 *
 *   1. `quotaDelta = computeUploadQuotaDelta({ newBytes, existingBytes })`
 *   2. `reservedBytes = 0`
 *   3. the whole reservation block is SKIPPED when `reserveBytes === 0`
 *      (same-size retry and shrink cases — no usage load, no transaction), and
 *      `reservedBytes` is assigned `quotaDelta.reserveBytes` only AFTER a
 *      successful `reserveTenantStorageBytes`
 *   4. `file.save(...)`
 *      - on success: `releaseTenantStorageBytes(shrinkBytes)` when `shrinkBytes > 0`
 *        (best effort — a failure still returns 200)
 *      - on failure: `releaseTenantStorageBytes(reservedBytes)`, never `bytes`,
 *        never `shrinkBytes`
 *
 * `QuotaLedger` mirrors the real `reserveTenantStorageBytes` /
 * `releaseTenantStorageBytes` semantics that matter for this property: a release
 * no-ops on a non-positive amount and clamps the stored total at zero.
 *
 * ---------------------------------------------------------------------------
 * Why the ledger starts ABOVE the existing object's size
 * ---------------------------------------------------------------------------
 * `releaseTenantStorageBytes` clamps at zero, which would MASK an over-release on a
 * near-empty tenant (releasing 5 MB from a 1 MB total still lands on 0, which could
 * look like a correct rollback). Every ledger below therefore starts at
 * `unrelatedBytes + existingBytes` with `unrelatedBytes` generated, and the ledger
 * counts how many times it had to clamp — a valid sequence clamps zero times, so
 * drift DOWN is observable, not absorbed.
 */
import * as fc from 'fast-check';

import { computeUploadQuotaDelta, type UploadQuotaDelta } from '../lib/uploadObjectPath';

// ---------------------------------------------------------------------------
// In-memory quota ledger (models tenantStorageUsage/{tenantId}.bytes)
// ---------------------------------------------------------------------------

interface LedgerOperation {
  op: 'reserve' | 'release';
  bytes: number;
  /** False when the real implementation would have short-circuited (`<= 0`). */
  applied: boolean;
}

class QuotaLedger {
  private used: number;

  readonly operations: LedgerOperation[] = [];

  /** Times a release had to clamp at zero — must stay 0 for a well-formed sequence. */
  clampCount = 0;

  constructor(initialBytes: number) {
    this.used = initialBytes;
  }

  get usedBytes(): number {
    return this.used;
  }

  /** Mirrors `reserveTenantStorageBytes`: adds the increment to the recorded total. */
  reserve(bytes: number): void {
    this.operations.push({ op: 'reserve', bytes, applied: true });
    this.used += bytes;
  }

  /** Mirrors `releaseTenantStorageBytes`: no-op on `<= 0`, clamped at zero. */
  release(bytes: number): void {
    if (bytes <= 0) {
      this.operations.push({ op: 'release', bytes, applied: false });
      return;
    }
    this.operations.push({ op: 'release', bytes, applied: true });
    const next = this.used - bytes;
    if (next < 0) this.clampCount += 1;
    this.used = Math.max(0, next);
  }

  totalFor(op: LedgerOperation['op']): number {
    return this.operations
      .filter((entry) => entry.op === op && entry.applied)
      .reduce((sum, entry) => sum + entry.bytes, 0);
  }
}

// ---------------------------------------------------------------------------
// The route's reserve → write → (rollback | shrink-release) sequence
// ---------------------------------------------------------------------------

interface SimulateUploadArgs {
  ledger: QuotaLedger;
  /** Body size for this attempt. */
  newBytes: number;
  /** Bytes currently stored at the resolved path; `0` means "no existing object". */
  existingBytes: number;
  /** Fault injection for `bucket.file(objectPath).save(...)`. */
  writeSucceeds: boolean;
  /** Fault injection for the best-effort post-write shrink release. */
  shrinkReleaseSucceeds?: boolean;
}

interface SimulateUploadResult {
  quotaDelta: UploadQuotaDelta;
  /** The route's `reservedBytes` local at the moment the write was attempted. */
  reservedBytes: number;
  /** Amount passed to the rollback release (0 when the write succeeded). */
  releasedOnRollback: number;
  /** Amount passed to the post-write shrink release (0 when it did not run). */
  releasedOnShrink: number;
  /** True when the modeled `save()` resolved. */
  stored: boolean;
}

function simulateUploadRequest(args: SimulateUploadArgs): SimulateUploadResult {
  // Step 1 — the REAL decision. Nothing below re-derives it.
  const quotaDelta = computeUploadQuotaDelta({
    newBytes: args.newBytes,
    existingBytes: args.existingBytes,
  });

  // Step 2 — the route's local starts at 0, NOT at the body size.
  let reservedBytes = 0;
  let releasedOnRollback = 0;
  let releasedOnShrink = 0;

  // Step 3 — the entire reservation block is skipped for a zero delta, and
  // `reservedBytes` is assigned only after the reservation succeeded.
  if (quotaDelta.reserveBytes > 0) {
    args.ledger.reserve(quotaDelta.reserveBytes);
    reservedBytes = quotaDelta.reserveBytes;
  }

  // Step 4 — the write.
  if (!args.writeSucceeds) {
    // Rollback: exactly what this request took. Never `newBytes`, never `shrinkBytes`.
    releasedOnRollback = reservedBytes;
    args.ledger.release(reservedBytes);
    return { quotaDelta, reservedBytes, releasedOnRollback, releasedOnShrink, stored: false };
  }

  // Post-write true-up for a smaller replacement, best effort.
  if (quotaDelta.shrinkBytes > 0) {
    releasedOnShrink = quotaDelta.shrinkBytes;
    if (args.shrinkReleaseSucceeds ?? true) {
      args.ledger.release(quotaDelta.shrinkBytes);
    }
  }

  return { quotaDelta, reservedBytes, releasedOnRollback, releasedOnShrink, stored: true };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** The route's hard cap: 50 MB (`app.ts`). */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * `newBytes` is a positive integer — the route rejects `0` with `missing_file_body`
 * and anything past the cap with `file_too_large`, but the rollback arithmetic must
 * stay exact well beyond the cap. Bounded away from `Number.MAX_SAFE_INTEGER`
 * because the ledger ACCUMULATES sizes, and a sum past 2^53 would lose precision in
 * the test's own model rather than in the code under test.
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
    ),
  },
);

/** `existingBytes` is non-negative; `0` is the no-existing-object / legacy case. */
const existingBytesArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 0, max: MAX_UPLOAD_BYTES }) },
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
      2 * MAX_UPLOAD_BYTES,
    ),
  },
);

/** Unrelated tenant usage the ledger already holds, so an over-release cannot clamp away. */
const unrelatedBytesArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 8 * MAX_UPLOAD_BYTES });

interface UploadCase {
  newBytes: number;
  existingBytes: number;
  writeSucceeds: boolean;
  unrelatedBytes: number;
}

/**
 * `(newBytes, existingBytes, writeSucceeds)` triples covering every size relation:
 * no existing object (`existingBytes === 0`), a growing overwrite, a shrinking
 * overwrite, and — explicitly weighted, because uniform generation almost never hits
 * it — the same-size retry (`newBytes === existingBytes`), which is the exact case
 * this feature exists for.
 */
const uploadCaseArb: fc.Arbitrary<UploadCase> = fc
  .record({
    newBytes: newBytesArb,
    relation: fc.oneof(
      { weight: 3, arbitrary: fc.constant('same' as const) },
      { weight: 2, arbitrary: fc.constant('fresh' as const) },
      { weight: 3, arbitrary: fc.constant('generated' as const) },
      { weight: 1, arbitrary: fc.constant('oneSmaller' as const) },
      { weight: 1, arbitrary: fc.constant('oneLarger' as const) },
    ),
    generatedExisting: existingBytesArb,
    writeSucceeds: fc.boolean(),
    unrelatedBytes: unrelatedBytesArb,
  })
  .map(({ newBytes, relation, generatedExisting, writeSucceeds, unrelatedBytes }) => {
    const existingBytes =
      relation === 'same'
        ? newBytes
        : relation === 'fresh'
          ? 0
          : relation === 'oneSmaller'
            ? Math.max(0, newBytes - 1)
            : relation === 'oneLarger'
              ? newBytes + 1
              : generatedExisting;
    return { newBytes, existingBytes, writeSucceeds, unrelatedBytes };
  });

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------
// Feature: upload-idempotency, Property 8: Rollback releases exactly what was reserved
describe('Property 8: Rollback releases exactly what was reserved', () => {
  it('returns recorded usage to EXACTLY its pre-request value when the write fails', () => {
    fc.assert(
      fc.property(uploadCaseArb, ({ newBytes, existingBytes, unrelatedBytes }) => {
        // The tenant's recorded usage before the request: unrelated files plus the
        // object currently sitting at the resolved path.
        const before = unrelatedBytes + existingBytes;
        const ledger = new QuotaLedger(before);

        const result = simulateUploadRequest({
          ledger,
          newBytes,
          existingBytes,
          writeSucceeds: false,
        });

        // No drift UP (a leaked reservation) and no drift DOWN (an over-release).
        expect(ledger.usedBytes).toBe(before);
        // The clamp never fired, so the equality above is a real round trip rather
        // than an over-release absorbed by the floor at zero.
        expect(ledger.clampCount).toBe(0);
        // The failed write left the previous object in place, so recorded usage
        // still equals the bytes actually stored.
        expect(ledger.usedBytes - unrelatedBytes).toBe(existingBytes);
        expect(result.stored).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it('releases exactly delta.reserveBytes on a failed write — never the raw body size', () => {
    fc.assert(
      fc.property(uploadCaseArb, ({ newBytes, existingBytes, unrelatedBytes }) => {
        const ledger = new QuotaLedger(unrelatedBytes + existingBytes);
        const result = simulateUploadRequest({
          ledger,
          newBytes,
          existingBytes,
          writeSucceeds: false,
        });

        // The rollback amount is the reservation amount, and the reservation amount
        // is whatever the real delta said — nothing else.
        expect(result.releasedOnRollback).toBe(result.quotaDelta.reserveBytes);
        expect(result.reservedBytes).toBe(result.quotaDelta.reserveBytes);
        expect(ledger.totalFor('release')).toBe(ledger.totalFor('reserve'));

        if (existingBytes > 0) {
          // An overwrite never reserves — and so never rolls back — the full body
          // size; that was the pre-feature bug this threading fixes.
          expect(result.releasedOnRollback).toBeLessThan(newBytes);
        } else {
          // With no existing object the delta is the whole file, exactly as today.
          expect(result.releasedOnRollback).toBe(newBytes);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('releases nothing when nothing was reserved — the same-size retry and the shrink case', () => {
    fc.assert(
      fc.property(
        newBytesArb,
        fc.integer({ min: 0, max: 4 * MAX_UPLOAD_BYTES }),
        unrelatedBytesArb,
        (newBytes, shrinkBy, unrelatedBytes) => {
          // `existingBytes >= newBytes` covers both zero-reservation shapes at once:
          // equal (same-size retry) and larger (shrink).
          const existingBytes = newBytes + shrinkBy;
          const before = unrelatedBytes + existingBytes;
          const ledger = new QuotaLedger(before);

          const result = simulateUploadRequest({
            ledger,
            newBytes,
            existingBytes,
            writeSucceeds: false,
          });

          expect(result.quotaDelta.reserveBytes).toBe(0);
          expect(result.reservedBytes).toBe(0);
          expect(result.releasedOnRollback).toBe(0);
          // Not one applied ledger write in either direction: the reservation block
          // was skipped entirely and the rollback release no-ops on 0.
          expect(ledger.operations.filter((entry) => entry.applied)).toHaveLength(0);
          expect(ledger.usedBytes).toBe(before);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('never credits shrinkBytes on a failed write — the larger previous object still owes them', () => {
    fc.assert(
      fc.property(
        newBytesArb,
        fc.integer({ min: 1, max: 4 * MAX_UPLOAD_BYTES }),
        unrelatedBytesArb,
        (newBytes, shrinkBy, unrelatedBytes) => {
          // Strictly larger existing object ⇒ `shrinkBytes > 0`.
          const existingBytes = newBytes + shrinkBy;
          const before = unrelatedBytes + existingBytes;
          const ledger = new QuotaLedger(before);

          const result = simulateUploadRequest({
            ledger,
            newBytes,
            existingBytes,
            writeSucceeds: false,
          });

          expect(result.quotaDelta.shrinkBytes).toBe(shrinkBy);
          // The shrink release never ran, so the bytes of the object that is STILL
          // stored were never credited back (Req 3.7).
          expect(result.releasedOnShrink).toBe(0);
          expect(
            ledger.operations.some(
              (entry) => entry.applied && entry.bytes === result.quotaDelta.shrinkBytes,
            ),
          ).toBe(false);
          expect(ledger.usedBytes).toBe(before);
          expect(ledger.usedBytes - unrelatedBytes).toBe(existingBytes);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('moves recorded usage by the real change in stored bytes when the write succeeds', () => {
    fc.assert(
      fc.property(uploadCaseArb, ({ newBytes, existingBytes, unrelatedBytes }) => {
        const before = unrelatedBytes + existingBytes;
        const ledger = new QuotaLedger(before);

        const result = simulateUploadRequest({
          ledger,
          newBytes,
          existingBytes,
          writeSucceeds: true,
        });

        expect(result.stored).toBe(true);
        // `newBytes - existingBytes` for an overwrite, `newBytes` for a new object.
        // Never the raw body size on an overwrite.
        expect(ledger.usedBytes - before).toBe(newBytes - existingBytes);
        expect(ledger.usedBytes).toBe(unrelatedBytes + newBytes);
        expect(ledger.clampCount).toBe(0);
        if (existingBytes === 0) {
          expect(ledger.usedBytes - before).toBe(newBytes);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('leaves usage over-counted by exactly shrinkBytes when the best-effort shrink release fails', () => {
    fc.assert(
      fc.property(
        newBytesArb,
        fc.integer({ min: 1, max: 4 * MAX_UPLOAD_BYTES }),
        unrelatedBytesArb,
        (newBytes, shrinkBy, unrelatedBytes) => {
          const existingBytes = newBytes + shrinkBy;
          const before = unrelatedBytes + existingBytes;
          const ledger = new QuotaLedger(before);

          const result = simulateUploadRequest({
            ledger,
            newBytes,
            existingBytes,
            writeSucceeds: true,
            shrinkReleaseSucceeds: false,
          });

          // The write still counts as a success (200), and the discrepancy is bounded
          // by `shrinkBytes` — over-counted, never under-counted (Req 9.6).
          expect(result.stored).toBe(true);
          expect(ledger.usedBytes).toBe(before);
          expect(ledger.usedBytes - (unrelatedBytes + newBytes)).toBe(
            result.quotaDelta.shrinkBytes,
          );
          expect(ledger.usedBytes).toBeGreaterThan(unrelatedBytes + newBytes);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('rolls back exactly at the byte-range extremes, including 0 and MAX_SAFE_INTEGER', () => {
    // Kept out of the generators above because those ACCUMULATE sizes into one
    // ledger, where a sum past 2^53 would lose precision in the test's own model.
    // Here each case runs against a fresh ledger holding nothing else, so the
    // extremes are exact. `0` is not reachable through the route (`missing_file_body`
    // rejects it first) but the arithmetic must stay total anyway.
    const extremes = fc.constantFrom(
      0,
      1,
      2,
      MAX_UPLOAD_BYTES,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    );

    fc.assert(
      fc.property(extremes, extremes, (newBytes, existingBytes) => {
        const ledger = new QuotaLedger(existingBytes);
        const result = simulateUploadRequest({
          ledger,
          newBytes,
          existingBytes,
          writeSucceeds: false,
        });

        expect(result.releasedOnRollback).toBe(result.quotaDelta.reserveBytes);
        expect(ledger.usedBytes).toBe(existingBytes);
        expect(ledger.clampCount).toBe(0);
        expect(ledger.usedBytes).toBeGreaterThanOrEqual(0);
        if (newBytes === existingBytes) {
          // The retry case at every magnitude: nothing reserved, nothing released.
          expect(result.quotaDelta.reserveBytes).toBe(0);
          expect(ledger.operations.filter((entry) => entry.applied)).toHaveLength(0);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never drives the ledger negative, for any sequence of failed and successful attempts', () => {
    fc.assert(
      fc.property(
        fc.array(uploadCaseArb, { minLength: 1, maxLength: 8 }),
        unrelatedBytesArb,
        (attempts, unrelatedBytes) => {
          // One deterministic path, retried N times: `stored` is the single object's
          // size (0 == nothing there yet) and only a successful write changes it.
          const ledger = new QuotaLedger(unrelatedBytes);
          let stored = 0;

          for (const attempt of attempts) {
            const before = ledger.usedBytes;
            const storedBefore = stored;
            const result = simulateUploadRequest({
              ledger,
              newBytes: attempt.newBytes,
              existingBytes: storedBefore,
              writeSucceeds: attempt.writeSucceeds,
            });

            // The probe saw an object exactly when one was already stored.
            expect(result.quotaDelta.isOverwrite).toBe(storedBefore > 0);

            if (attempt.writeSucceeds) {
              stored = attempt.newBytes;
            } else {
              // Every failed attempt is a complete round trip: no leak, no over-release.
              expect(ledger.usedBytes).toBe(before);
            }

            // Recorded usage tracks the bytes actually stored at every step, however
            // many attempts failed on the way.
            expect(ledger.usedBytes).toBe(unrelatedBytes + stored);
            expect(ledger.usedBytes).toBeGreaterThanOrEqual(0);
          }

          expect(ledger.clampCount).toBe(0);
          expect(ledger.usedBytes).toBe(unrelatedBytes + stored);
        },
      ),
      { numRuns: 300 },
    );
  });
});
