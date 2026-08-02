// Feature: upload-idempotency, Property 8: Rollback releases exactly what was reserved
/**
 * Property 8, applied to the RESERVATION step rather than the write step.
 *
 * Property 8 (design.md): "For any upload that fails at the storage-write step, the
 * amount released equals `delta.reserveBytes` for that request, so recorded usage
 * returns to its pre-request value." That guarantee rests on an invariant the route
 * documents but never asserted: when the reservation step hands control on to the
 * write, the bytes it holds are EXACTLY `delta.reserveBytes`, and when it returns an
 * error response instead, it holds NOTHING — because the route returns those
 * responses without a release.
 *
 * This file drives the real exported `reserveUploadQuotaBytes` (`src/app.ts`) over
 * generated fault sequences and asserts, for every one of them:
 *
 *   1. `outcome: 'reserved'` ⇒ exactly one reservation applied, holding exactly
 *      `reserveBytes` — so the route's `reservedBytes = quotaDelta.reserveBytes` is
 *      the true amount and the rollback releases exactly it.
 *   2. any other outcome ⇒ zero reservations applied, holding zero bytes — no leak
 *      on a path the route exits without releasing.
 *   3. the call is total: it resolves for every fault shape, never rejects.
 *   4. each outcome carries the status, metric and stage the route has always used,
 *      and at most one reconcile is ever paid for.
 *
 * **Validates: Requirements 3.7**
 *
 * ---------------------------------------------------------------------------
 * The regression
 * ---------------------------------------------------------------------------
 * Clause 2 is what the pre-fix code violated: a limit error whose reconcile-and-retry
 * SUCCEEDED fell through to `503 storage_quota_check_failed` while holding
 * `reserveBytes`, and the route's `reservedBytes` was still `0`, so nothing released
 * it. Clause 1 is the other half — that same case never reached the write at all.
 *
 * ---------------------------------------------------------------------------
 * What is real and what is faked
 * ---------------------------------------------------------------------------
 * The control flow and the error classification are real. Only `reserve` (a ledger
 * modelling the atomic `reserveTenantStorageBytes` transaction — a rejection holds
 * nothing) and `reconcileUsageBytes` are injected fakes. The test never re-derives
 * the decision it is checking.
 */

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import * as fc from 'fast-check';

import { reserveUploadQuotaBytes, TenantStorageLimitError } from '../app';
import { metricNames } from '../metrics';

// ---------------------------------------------------------------------------
// Fault specs (plain data, materialized inside the property body)
// ---------------------------------------------------------------------------

/** What the fake `reserve()` does on one call. */
type ReserveFaultSpec =
  /** Honest: hold the bytes unless the limit forbids it. */
  | { kind: 'honest' }
  /** The real `TenantStorageLimitError`, thrown in-process. */
  | { kind: 'limitErrorInstance' }
  /**
   * A limit error that lost its prototype crossing a transaction boundary — still
   * classifiable through its `name` plus its numeric fields.
   */
  | { kind: 'limitErrorPlainObject' }
  /** A limit error flattened to a bare string, classified by text. */
  | { kind: 'limitErrorFlattenedString' }
  /** A limit error carried on a nested `cause`. */
  | { kind: 'limitErrorNested' }
  /** Something `tryExtractTenantStorageLimitError` cannot classify. */
  | {
      kind: 'unclassified';
      value: 'error' | 'string' | 'number' | 'null' | 'undefined' | 'object' | 'nonNumericFields';
    };

type ReconcileSpec = { kind: 'ok'; bytes: number } | { kind: 'throws' };

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const reserveFaultSpecArb: fc.Arbitrary<ReserveFaultSpec> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ kind: 'honest' as const }) },
  { weight: 4, arbitrary: fc.constant({ kind: 'limitErrorInstance' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'limitErrorPlainObject' as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: 'limitErrorFlattenedString' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'limitErrorNested' as const }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('unclassified' as const),
      value: fc.constantFrom(
        'error',
        'string',
        'number',
        'null',
        'undefined',
        'object',
        'nonNumericFields',
      ),
    }) as fc.Arbitrary<ReserveFaultSpec>,
  },
);

const reconcileSpecArb: fc.Arbitrary<ReconcileSpec> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant('ok' as const),
      bytes: fc.integer({ min: 0, max: 8 * MAX_UPLOAD_BYTES }),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'throws' as const }) },
);

interface ScenarioSpec {
  reserveBytes: number;
  limitBytes: number;
  initialUsedBytes: number;
  /** Consumed one per `reserve()` call; a shorter list falls back to `honest`. */
  faults: ReserveFaultSpec[];
  reconcile: ReconcileSpec;
}

const scenarioArb: fc.Arbitrary<ScenarioSpec> = fc.record({
  // The route only calls the seam when `reserveBytes > 0`.
  reserveBytes: fc.integer({ min: 1, max: MAX_UPLOAD_BYTES }),
  // `0` is the "no plan limit" convention, so it must be well represented.
  limitBytes: fc.oneof(
    { weight: 2, arbitrary: fc.constant(0) },
    { weight: 8, arbitrary: fc.integer({ min: 1, max: 8 * MAX_UPLOAD_BYTES }) },
  ),
  initialUsedBytes: fc.integer({ min: 0, max: 8 * MAX_UPLOAD_BYTES }),
  faults: fc.array(reserveFaultSpecArb, { minLength: 0, maxLength: 3 }),
  reconcile: reconcileSpecArb,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  args: Parameters<typeof reserveUploadQuotaBytes>[0];
  usedBytes: () => number;
  /** Bytes this request is holding right now. */
  heldBytes: () => number;
  appliedReserves: () => number;
  reserveCalls: () => number;
  reconcileCalls: () => number;
}

function materializeUnclassified(value: Extract<ReserveFaultSpec, { kind: 'unclassified' }>['value']): unknown {
  switch (value) {
    case 'error':
      return new Error('DEADLINE_EXCEEDED: firestore transaction failed');
    case 'string':
      return 'transaction aborted';
    case 'number':
      return 500;
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'object':
      return { code: 'UNAVAILABLE' };
    case 'nonNumericFields':
      // Shaped like a limit error but carrying nothing numeric, so classification
      // must reject it.
      return { limitBytes: 'lots', usedBytes: null, incrementBytes: {} };
  }
}

function makeHarness(spec: ScenarioSpec): Harness {
  const faults = [...spec.faults];
  let used = spec.initialUsedBytes;
  let held = 0;
  let appliedReserves = 0;
  let reserveCalls = 0;
  let reconcileCalls = 0;

  const reserve = async (): Promise<void> => {
    reserveCalls += 1;
    const fault = faults.shift() ?? { kind: 'honest' as const };

    // Every rejection below holds nothing: the real reservation is one Firestore
    // transaction, so it either commits the increment or throws.
    switch (fault.kind) {
      case 'limitErrorInstance':
        throw new TenantStorageLimitError(spec.limitBytes, used, spec.reserveBytes);
      case 'limitErrorPlainObject':
        throw {
          name: 'TenantStorageLimitError',
          message: 'tenant_storage_limit_reached',
          limitBytes: spec.limitBytes,
          usedBytes: used,
          incrementBytes: spec.reserveBytes,
        };
      case 'limitErrorFlattenedString':
        throw `tenant_storage_limit_reached limitBytes=${spec.limitBytes} usedBytes=${used} incrementBytes=${spec.reserveBytes}`;
      case 'limitErrorNested': {
        const outer: any = new Error('transaction failed');
        outer.cause = new TenantStorageLimitError(spec.limitBytes, used, spec.reserveBytes);
        throw outer;
      }
      case 'unclassified':
        throw materializeUnclassified(fault.value);
      case 'honest':
      default:
        break;
    }

    if (spec.limitBytes > 0 && used + spec.reserveBytes > spec.limitBytes) {
      throw new TenantStorageLimitError(spec.limitBytes, used, spec.reserveBytes);
    }
    used += spec.reserveBytes;
    held += spec.reserveBytes;
    appliedReserves += 1;
  };

  const reconcileUsageBytes = async (): Promise<number> => {
    reconcileCalls += 1;
    if (spec.reconcile.kind === 'throws') {
      throw new Error('bucket listing unavailable');
    }
    // A reconcile REPLACES recorded usage with bucket truth, subsuming anything this
    // request was holding.
    used = spec.reconcile.bytes;
    held = 0;
    return spec.reconcile.bytes;
  };

  return {
    args: { reserveBytes: spec.reserveBytes, limitBytes: spec.limitBytes, reserve, reconcileUsageBytes },
    usedBytes: () => used,
    heldBytes: () => held,
    appliedReserves: () => appliedReserves,
    reserveCalls: () => reserveCalls,
    reconcileCalls: () => reconcileCalls,
  };
}

const REJECT_STAGES = ['reserve_reconcile', 'reserve_retry', 'last_chance'];

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------
// Feature: upload-idempotency, Property 8: Rollback releases exactly what was reserved
describe('Property 8 (reservation step): a reservation is either exactly reserveBytes or nothing at all', () => {
  it('holds exactly reserveBytes on "reserved" and exactly zero on every failure outcome', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (spec) => {
        const harness = makeHarness(spec);

        // Totality: whatever the fakes threw, this resolves.
        const result = await reserveUploadQuotaBytes(harness.args);

        if (result.outcome === 'reserved') {
          // Clause 1 — the route sets `reservedBytes = quotaDelta.reserveBytes` right
          // after this, and that is exactly what is held, so the rollback releases
          // exactly what this request took (Req 3.7).
          expect(harness.appliedReserves()).toBe(1);
          expect(harness.heldBytes()).toBe(spec.reserveBytes);
        } else {
          // Clause 2 — the route returns 409/503 here WITHOUT releasing, so anything
          // held would leak until the next reconcile. Pre-fix, the limit-error case
          // whose retry succeeded landed here holding `reserveBytes`.
          expect(harness.appliedReserves()).toBe(0);
          expect(harness.heldBytes()).toBe(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never spends more than one reconcile, and never more than two reserve attempts', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (spec) => {
        const harness = makeHarness(spec);

        await reserveUploadQuotaBytes(harness.args);

        // A reconcile lists the tenant's whole storage prefix. The recovery is
        // allowed one, on exactly one of the two branches — never both. Pre-fix, a
        // successful retry paid for a second listing on its way to the wrong 503.
        expect(harness.reconcileCalls()).toBeLessThanOrEqual(1);
        expect(harness.reserveCalls()).toBeGreaterThanOrEqual(1);
        expect(harness.reserveCalls()).toBeLessThanOrEqual(2);
      }),
      { numRuns: 300 },
    );
  });

  it('carries the unchanged status, metric and stage for every non-reserved outcome', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (spec) => {
        const harness = makeHarness(spec);

        const result = await reserveUploadQuotaBytes(harness.args);

        if (result.outcome === 'rejected') {
          expect(result.status).toBe(409);
          expect(result.metric).toBe(metricNames.storageUploadRejected);
          expect(REJECT_STAGES).toContain(result.stage);
          expect(result.body.error).toBe('storage_limit_reached');
          expect(result.body.incrementBytes).toBeGreaterThan(0);
          expect(Number.isFinite(result.body.limitBytes)).toBe(true);
        } else if (result.outcome === 'check_failed') {
          expect(result.status).toBe(503);
          expect(result.metric).toBe(metricNames.storageUploadQuotaCheckFailed);
          expect(result.stage).toBe('reserve_unknown');
          expect(result.body).toEqual({ error: 'storage_quota_check_failed' });
        } else {
          // A success carries no HTTP decision at all, so it cannot become a 409/503.
          expect(result).toEqual({ outcome: 'reserved' });
        }
      }),
      { numRuns: 300 },
    );
  });

  it('reaches the last-chance check for an unclassified failure, and rejects it only when reconciled usage proves it', async () => {
    // The last-chance deterministic check must keep running for failures the limit
    // classifier cannot read — that is the only thing standing between an
    // unclassified reserve failure and an over-limit tenant slipping through.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: MAX_UPLOAD_BYTES }),
        fc.integer({ min: 1, max: 8 * MAX_UPLOAD_BYTES }),
        fc.integer({ min: 0, max: 8 * MAX_UPLOAD_BYTES }),
        fc.constantFrom<Extract<ReserveFaultSpec, { kind: 'unclassified' }>['value']>(
          'error',
          'string',
          'number',
          'null',
          'undefined',
          'object',
          'nonNumericFields',
        ),
        async (reserveBytes, limitBytes, reconciledBytes, unclassified) => {
          const harness = makeHarness({
            reserveBytes,
            limitBytes,
            initialUsedBytes: 0,
            faults: [{ kind: 'unclassified', value: unclassified }],
            reconcile: { kind: 'ok', bytes: reconciledBytes },
          });

          const result = await reserveUploadQuotaBytes(harness.args);

          // The check ran, and no retry was attempted for a failure that was never
          // classified as a limit error.
          expect(harness.reconcileCalls()).toBe(1);
          expect(harness.reserveCalls()).toBe(1);

          const overLimit = reconciledBytes + reserveBytes > limitBytes;
          if (overLimit) {
            expect(result.outcome).toBe('rejected');
            if (result.outcome !== 'rejected') return;
            expect(result.stage).toBe('last_chance');
            expect(result.body).toEqual({
              error: 'storage_limit_reached',
              limitBytes,
              usedBytes: reconciledBytes,
              incrementBytes: reserveBytes,
            });
          } else {
            // Unchanged behavior: an unclassified failure under the limit is still a
            // 503, not a silent success.
            expect(result.outcome).toBe('check_failed');
            if (result.outcome !== 'check_failed') return;
            expect(result.stage).toBe('reserve_unknown');
          }
          expect(harness.heldBytes()).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('lets a stale-counter limit error through once the reconcile frees room, for any size and limit', async () => {
    // The recovery path's whole reason to exist: recorded usage says full, bucket
    // truth says otherwise. Pre-fix this returned a 503 on every input.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: MAX_UPLOAD_BYTES }),
        fc.integer({ min: 0, max: 4 * MAX_UPLOAD_BYTES }),
        fc.constantFrom<ReserveFaultSpec['kind']>(
          'limitErrorInstance',
          'limitErrorPlainObject',
          'limitErrorFlattenedString',
          'limitErrorNested',
        ),
        async (reserveBytes, headroom, limitErrorKind) => {
          // Bucket truth leaves room for this upload; the stale counter did not.
          const reconciledBytes = headroom;
          const limitBytes = reconciledBytes + reserveBytes + headroom;
          const harness = makeHarness({
            reserveBytes,
            limitBytes,
            initialUsedBytes: limitBytes,
            faults: [{ kind: limitErrorKind } as ReserveFaultSpec],
            reconcile: { kind: 'ok', bytes: reconciledBytes },
          });

          const result = await reserveUploadQuotaBytes(harness.args);

          expect(result).toEqual({ outcome: 'reserved' });
          expect(harness.appliedReserves()).toBe(1);
          expect(harness.heldBytes()).toBe(reserveBytes);
          expect(harness.usedBytes()).toBe(reconciledBytes + reserveBytes);
          expect(harness.reserveCalls()).toBe(2);
          expect(harness.reconcileCalls()).toBe(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
