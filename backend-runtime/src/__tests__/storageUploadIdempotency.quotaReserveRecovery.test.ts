/**
 * Example-based tests for the quota-reservation recovery step of
 * `POST /storage/upload` — the REAL exported `reserveUploadQuotaBytes` seam in
 * `src/app.ts`, driven against an in-memory quota ledger.
 *
 * Validates: Requirements 3.5, 3.7, 9.8
 *
 * ---------------------------------------------------------------------------
 * The regression these tests exist for
 * ---------------------------------------------------------------------------
 * The reconcile-and-retry recovery path (a stale usage counter after deletions
 * makes the first reservation throw a limit error, a reconcile trues the counter up,
 * the retry then fits) used to be DEAD CODE: control fell out of the successful
 * retry into the "last-chance" check and then unconditionally into
 * `503 storage_quota_check_failed`. The caller got a spurious `503` for an upload
 * that could have proceeded, and because the route assigns `reservedBytes` only
 * AFTER the reservation step returns normally, the bytes the retry had just reserved
 * were never released by the rollback — recorded usage stayed inflated by one file
 * size until the next reconcile (Req 3.7).
 *
 * `reserveWithStaleCounterThenRetrySucceeds` below is that case. It asserts
 * `outcome: 'reserved'` (no `409`, no `503`), exactly `reserveBytes` held, and
 * exactly one reconcile — all three of which the pre-fix code failed.
 *
 * ---------------------------------------------------------------------------
 * What is real and what is faked
 * ---------------------------------------------------------------------------
 * The control flow, the error classification (`TenantStorageLimitError` /
 * `tryExtractTenantStorageLimitError`), the status codes, the response bodies and
 * the metric stage labels all come from the real `reserveUploadQuotaBytes`. Only the
 * two injected callbacks are fakes: `reserve` (a ledger modelling
 * `reserveTenantStorageBytes`: atomic, so a rejection holds nothing) and
 * `reconcileUsageBytes` (modelling the bucket-truth recompute).
 */

// createApp() is never called here, but importing app.ts must not start schedulers.
process.env.TEST_MODE = '1';

import { reserveUploadQuotaBytes, TenantStorageLimitError, type UploadQuotaReservationResult } from '../app';
import { metricNames } from '../metrics';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** What the fake `reserve()` does on a given call. */
type ReserveFault =
  /** Behave honestly: hold the bytes unless the limit says otherwise. */
  | { kind: 'honest' }
  /** Reject with the real `TenantStorageLimitError`, holding nothing. */
  | { kind: 'limitError'; usedBytes?: number }
  /** Reject with something `tryExtractTenantStorageLimitError` cannot classify. */
  | { kind: 'unclassified'; value?: unknown };

/** What the fake `reconcileUsageBytes()` does. */
type ReconcileBehavior = { kind: 'ok'; bytes: number } | { kind: 'throws'; value?: unknown };

interface HarnessArgs {
  reserveBytes: number;
  limitBytes: number;
  /** Recorded usage before the request. */
  initialUsedBytes: number;
  /** Consumed one per `reserve()` call; later calls fall back to `honest`. */
  reserveFaults?: ReserveFault[];
  reconcile: ReconcileBehavior;
}

interface Harness {
  args: Parameters<typeof reserveUploadQuotaBytes>[0];
  /** Recorded tenant usage, as the ledger currently holds it. */
  usedBytes: () => number;
  /** Bytes this request is holding (sum of reservations that actually applied). */
  heldBytes: () => number;
  reserveCalls: () => number;
  appliedReserves: () => number;
  reconcileCalls: () => number;
}

function makeHarness(input: HarnessArgs): Harness {
  const { reserveBytes, limitBytes } = input;
  const faults = [...(input.reserveFaults ?? [])];

  let used = input.initialUsedBytes;
  let held = 0;
  let reserveCalls = 0;
  let appliedReserves = 0;
  let reconcileCalls = 0;

  const reserve = async (): Promise<void> => {
    reserveCalls += 1;
    const fault = faults.shift() ?? { kind: 'honest' as const };

    if (fault.kind === 'limitError') {
      // Atomic, exactly like the real transaction: a rejection holds nothing.
      throw new TenantStorageLimitError(limitBytes, fault.usedBytes ?? used, reserveBytes);
    }
    if (fault.kind === 'unclassified') {
      throw fault.value ?? new Error('DEADLINE_EXCEEDED: firestore transaction failed');
    }
    if (limitBytes > 0 && used + reserveBytes > limitBytes) {
      throw new TenantStorageLimitError(limitBytes, used, reserveBytes);
    }
    used += reserveBytes;
    held += reserveBytes;
    appliedReserves += 1;
  };

  const reconcileUsageBytes = async (): Promise<number> => {
    reconcileCalls += 1;
    if (input.reconcile.kind === 'throws') {
      throw input.reconcile.value ?? new Error('bucket listing unavailable');
    }
    // A reconcile REPLACES recorded usage with bucket truth, so anything this
    // request was holding is subsumed by it.
    used = input.reconcile.bytes;
    held = 0;
    return input.reconcile.bytes;
  };

  return {
    args: { reserveBytes, limitBytes, reserve, reconcileUsageBytes },
    usedBytes: () => used,
    heldBytes: () => held,
    reserveCalls: () => reserveCalls,
    appliedReserves: () => appliedReserves,
    reconcileCalls: () => reconcileCalls,
  };
}

const MB = 1024 * 1024;

/** The two shapes the route forwards: a `409` body and a `503` body. */
function rejectedBody(result: UploadQuotaReservationResult) {
  if (result.outcome !== 'rejected') throw new Error(`expected a rejection, got ${result.outcome}`);
  return result.body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reserveUploadQuotaBytes — the happy path', () => {
  it('reserves on the first attempt without reconciling', async () => {
    const harness = makeHarness({
      reserveBytes: 4 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 10 * MB,
      reconcile: { kind: 'ok', bytes: 10 * MB },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    expect(result).toEqual({ outcome: 'reserved' });
    expect(harness.heldBytes()).toBe(4 * MB);
    expect(harness.usedBytes()).toBe(14 * MB);
    expect(harness.reserveCalls()).toBe(1);
    // A reconcile lists the whole tenant prefix; it must not run when nothing failed.
    expect(harness.reconcileCalls()).toBe(0);
  });
});

describe('reserveUploadQuotaBytes — a limit error whose reconcile-and-retry SUCCEEDS', () => {
  /**
   * THE FIXED BUG. Recorded usage says the tenant is full, the bucket says otherwise
   * (files were deleted since the counter was last trued up), so the reconcile frees
   * room and the retry fits.
   */
  it('reserves and lets the request proceed — no 409, no 503', async () => {
    const harness = makeHarness({
      reserveBytes: 5 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 99 * MB,
      // Stale counter said 99 MB; bucket truth is 20 MB.
      reserveFaults: [{ kind: 'limitError', usedBytes: 99 * MB }],
      reconcile: { kind: 'ok', bytes: 20 * MB },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    // Pre-fix this returned `check_failed` (the route's 503) even though the retry
    // had already reserved the bytes.
    expect(result).toEqual({ outcome: 'reserved' });
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('stage');

    // The reservation the request now holds is EXACTLY the delta, so the route's
    // `reservedBytes = quotaDelta.reserveBytes` matches what the ledger holds and the
    // rollback would release exactly that (Req 3.7).
    expect(harness.heldBytes()).toBe(5 * MB);
    expect(harness.appliedReserves()).toBe(1);
    expect(harness.usedBytes()).toBe(25 * MB);

    // One failed attempt, one successful retry.
    expect(harness.reserveCalls()).toBe(2);
    // Pre-fix this was 2: the successful retry fell through into the last-chance
    // check, paying for a second full bucket listing before returning its 503.
    expect(harness.reconcileCalls()).toBe(1);
  });

  it('reserves even with no plan limit at all (limitBytes === 0)', async () => {
    const harness = makeHarness({
      reserveBytes: 2 * MB,
      limitBytes: 0,
      initialUsedBytes: 7 * MB,
      reserveFaults: [{ kind: 'limitError', usedBytes: 7 * MB }],
      reconcile: { kind: 'ok', bytes: 3 * MB },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    expect(result.outcome).toBe('reserved');
    expect(harness.heldBytes()).toBe(2 * MB);
  });
});

describe('reserveUploadQuotaBytes — a limit error the reconcile confirms', () => {
  it('rejects with 409 storage_limit_reached at stage reserve_reconcile and holds nothing', async () => {
    const harness = makeHarness({
      reserveBytes: 5 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 99 * MB,
      reserveFaults: [{ kind: 'limitError', usedBytes: 99 * MB }],
      // Bucket truth agrees: the tenant really is out of room.
      reconcile: { kind: 'ok', bytes: 98 * MB },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') return;
    expect(result.status).toBe(409);
    expect(result.stage).toBe('reserve_reconcile');
    expect(result.metric).toBe(metricNames.storageUploadRejected);
    expect(rejectedBody(result)).toEqual({
      error: 'storage_limit_reached',
      limitBytes: 100 * MB,
      usedBytes: 98 * MB,
      incrementBytes: 5 * MB,
    });

    // The retry never ran, so nothing is held and no release is owed.
    expect(harness.reserveCalls()).toBe(1);
    expect(harness.appliedReserves()).toBe(0);
    expect(harness.heldBytes()).toBe(0);
    expect(harness.usedBytes()).toBe(98 * MB);
  });
});

describe('reserveUploadQuotaBytes — a limit error whose retry fails again', () => {
  it('rejects with 409 at stage reserve_retry, carrying the retry error’s numbers', async () => {
    const harness = makeHarness({
      reserveBytes: 5 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 99 * MB,
      reserveFaults: [
        { kind: 'limitError', usedBytes: 99 * MB },
        // A concurrent upload consumed the room the reconcile had just freed.
        { kind: 'limitError', usedBytes: 97 * MB },
      ],
      reconcile: { kind: 'ok', bytes: 20 * MB },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') return;
    expect(result.status).toBe(409);
    expect(result.stage).toBe('reserve_retry');
    expect(result.metric).toBe(metricNames.storageUploadRejected);
    expect(rejectedBody(result)).toEqual({
      error: 'storage_limit_reached',
      limitBytes: 100 * MB,
      usedBytes: 97 * MB,
      incrementBytes: 5 * MB,
    });

    expect(harness.reserveCalls()).toBe(2);
    expect(harness.appliedReserves()).toBe(0);
    expect(harness.heldBytes()).toBe(0);
  });

  it('rejects with 409 at stage reserve_retry when the reconcile itself throws', async () => {
    const harness = makeHarness({
      reserveBytes: 5 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 99 * MB,
      reserveFaults: [{ kind: 'limitError', usedBytes: 99 * MB }],
      reconcile: { kind: 'throws' },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') return;
    expect(result.stage).toBe('reserve_retry');
    // Falls back to the ORIGINAL limit error's numbers, since the reconcile that
    // would have produced fresher ones is what failed.
    expect(rejectedBody(result)).toEqual({
      error: 'storage_limit_reached',
      limitBytes: 100 * MB,
      usedBytes: 99 * MB,
      incrementBytes: 5 * MB,
    });
    // The retry never got the chance to run.
    expect(harness.reserveCalls()).toBe(1);
    expect(harness.heldBytes()).toBe(0);
  });
});

describe('reserveUploadQuotaBytes — an unclassified reserve failure', () => {
  it('still reports 503 storage_quota_check_failed at stage reserve_unknown when the reconcile is under limit', async () => {
    const failure = new Error('DEADLINE_EXCEEDED: firestore transaction failed');
    const harness = makeHarness({
      reserveBytes: 5 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 10 * MB,
      reserveFaults: [{ kind: 'unclassified', value: failure }],
      reconcile: { kind: 'ok', bytes: 10 * MB },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    // Unchanged behavior: an unclassified failure is a quota-check failure, not a
    // limit rejection, and the retry path is not for it.
    expect(result.outcome).toBe('check_failed');
    if (result.outcome !== 'check_failed') return;
    expect(result.status).toBe(503);
    expect(result.stage).toBe('reserve_unknown');
    expect(result.metric).toBe(metricNames.storageUploadQuotaCheckFailed);
    expect(result.body).toEqual({ error: 'storage_quota_check_failed' });
    // The original failure is handed back for the route's warning log.
    expect(result.error).toBe(failure);

    // The last-chance check still ran (that is what makes this a deterministic
    // decision rather than a blind 503), and no retry was attempted.
    expect(harness.reconcileCalls()).toBe(1);
    expect(harness.reserveCalls()).toBe(1);
    expect(harness.heldBytes()).toBe(0);
  });

  it('rejects with 409 at stage last_chance when the reconcile proves the tenant is over limit', async () => {
    const harness = makeHarness({
      reserveBytes: 5 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 10 * MB,
      reserveFaults: [{ kind: 'unclassified' }],
      reconcile: { kind: 'ok', bytes: 99 * MB },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    expect(result.outcome).toBe('rejected');
    if (result.outcome !== 'rejected') return;
    expect(result.status).toBe(409);
    expect(result.stage).toBe('last_chance');
    expect(result.metric).toBe(metricNames.storageUploadRejected);
    expect(rejectedBody(result)).toEqual({
      error: 'storage_limit_reached',
      limitBytes: 100 * MB,
      usedBytes: 99 * MB,
      incrementBytes: 5 * MB,
    });
    expect(harness.heldBytes()).toBe(0);
  });

  it('keeps the 503 fallback when the last-chance reconcile is itself unavailable', async () => {
    const harness = makeHarness({
      reserveBytes: 5 * MB,
      limitBytes: 100 * MB,
      initialUsedBytes: 10 * MB,
      reserveFaults: [{ kind: 'unclassified' }],
      reconcile: { kind: 'throws' },
    });

    const result = await reserveUploadQuotaBytes(harness.args);

    expect(result.outcome).toBe('check_failed');
    if (result.outcome !== 'check_failed') return;
    expect(result.stage).toBe('reserve_unknown');
    expect(result.body).toEqual({ error: 'storage_quota_check_failed' });
    expect(harness.heldBytes()).toBe(0);
  });
});

describe('reserveUploadQuotaBytes — no failure outcome leaks a reservation', () => {
  it('holds zero bytes on every outcome that is not "reserved"', async () => {
    const scenarios: Array<{ name: string; harness: Harness }> = [
      {
        name: 'reserve_reconcile',
        harness: makeHarness({
          reserveBytes: 5 * MB,
          limitBytes: 100 * MB,
          initialUsedBytes: 99 * MB,
          reserveFaults: [{ kind: 'limitError' }],
          reconcile: { kind: 'ok', bytes: 98 * MB },
        }),
      },
      {
        name: 'reserve_retry (retry rejected)',
        harness: makeHarness({
          reserveBytes: 5 * MB,
          limitBytes: 100 * MB,
          initialUsedBytes: 99 * MB,
          reserveFaults: [{ kind: 'limitError' }, { kind: 'limitError' }],
          reconcile: { kind: 'ok', bytes: 20 * MB },
        }),
      },
      {
        name: 'reserve_retry (reconcile threw)',
        harness: makeHarness({
          reserveBytes: 5 * MB,
          limitBytes: 100 * MB,
          initialUsedBytes: 99 * MB,
          reserveFaults: [{ kind: 'limitError' }],
          reconcile: { kind: 'throws' },
        }),
      },
      {
        name: 'last_chance',
        harness: makeHarness({
          reserveBytes: 5 * MB,
          limitBytes: 100 * MB,
          initialUsedBytes: 10 * MB,
          reserveFaults: [{ kind: 'unclassified' }],
          reconcile: { kind: 'ok', bytes: 99 * MB },
        }),
      },
      {
        name: 'reserve_unknown',
        harness: makeHarness({
          reserveBytes: 5 * MB,
          limitBytes: 100 * MB,
          initialUsedBytes: 10 * MB,
          reserveFaults: [{ kind: 'unclassified' }],
          reconcile: { kind: 'ok', bytes: 10 * MB },
        }),
      },
      {
        name: 'reserve_unknown (reconcile threw)',
        harness: makeHarness({
          reserveBytes: 5 * MB,
          limitBytes: 100 * MB,
          initialUsedBytes: 10 * MB,
          reserveFaults: [{ kind: 'unclassified' }],
          reconcile: { kind: 'throws' },
        }),
      },
    ];

    for (const { name, harness } of scenarios) {
      const result = await reserveUploadQuotaBytes(harness.args);
      expect(result.outcome).not.toBe('reserved');
      // The route returns 409/503 WITHOUT a release on these paths, which is only
      // correct because nothing is held (Req 3.7).
      expect({ name, held: harness.heldBytes(), applied: harness.appliedReserves() }).toEqual({
        name,
        held: 0,
        applied: 0,
      });
    }
  });
});
