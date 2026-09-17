/**
 * Unit and integration cases for the Run_Lease
 * (spec `storage-sweep-scale-hardening`, task 9.6).
 *
 * Everything here drives the real `storageOrphanSweepLease.ts` against the shared
 * harness's transaction-aware Firestore fake, so every claim is about the module's
 * own contract: one transaction on one document path (Req 6.8), the ten declared
 * fields and nothing else (Req 6.5), a release that fires only for a matching token
 * (Req 5.7), and a renewal that fences without writing (Reqs 5.18, 5.19).
 *
 * ── Why the operation log is the instrument for Req 6.8 ─────────────────────
 *
 * "Acquire, renew and release through Firestore transactions on a SINGLE document"
 * is a claim about which methods were invoked on which paths — not about the
 * resulting document. The harness logs every `tx.get` / `tx.set` / `tx.delete` at
 * the **call site**, with the full document path, so the claim reads directly off
 * `log.entries`: every lease entry is a `tx.` method, and every one of them targets
 * `storageMaintenanceJobs/orphanSweep/leases/run`. A `doc.set` outside a
 * transaction, or a second document touched inside one, both fail here.
 *
 * `clampRunLeaseMs` lives in this file rather than in `sweepScaleLimits.test.ts`
 * because it is a property of the **lease**, not of the scale limits — the same
 * reason the function itself lives beside the document it bounds.
 */

import {
  DEFAULT_RUN_LEASE_MS,
  MAX_RUN_LEASE_MS,
  MIN_RUN_LEASE_MS,
  ORPHAN_SWEEP_LEASE_COLLECTION,
  ORPHAN_SWEEP_RUN_LEASE_ID,
  RUN_LEASE_JOB_NAME,
  acquireRunLease,
  clampRunLeaseMs,
  runLeasePath,
  type RunLeaseHandle,
} from '../jobs/storageOrphanSweepLease';
import { ORPHAN_SWEEP_PROGRESS_PATH, tenantReportPath } from '../jobs/storageOrphanSweep';
import {
  createFakeFirestore,
  createOperationLog,
  type DocData,
  type FakeFirestore,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const NOW = Date.parse('2026-05-01T00:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The ten fields `RunLeaseDoc` declares — the whole permitted set (Req 6.5). */
const LEASE_FIELDS = [
  'acquiredAtIso',
  'acquiredAtMs',
  'expiresAtMs',
  'jobName',
  'mode',
  'renewals',
  'runnerId',
  'sweepId',
  'token',
  'updatedAt',
];

function harness(): { log: OperationLog; db: FakeFirestore } {
  const log = createOperationLog();
  return { log, db: createFakeFirestore({ log, collections: {} }) };
}

/** A lease record some other execution left behind, with a chosen `expiresAtMs`. */
function existingLease(expiresAtMs: unknown, overrides: DocData = {}): DocData {
  return {
    jobName: RUN_LEASE_JOB_NAME,
    token: 'other-token',
    runnerId: 'other-runner',
    sweepId: 'sweep_other_0001',
    mode: 'report',
    acquiredAtMs: NOW - HOUR,
    acquiredAtIso: new Date(NOW - HOUR).toISOString(),
    expiresAtMs,
    renewals: 0,
    updatedAt: new Date(NOW - HOUR),
    ...overrides,
  };
}

async function acquire(
  db: FakeFirestore,
  overrides: { runnerId?: string; sweepId?: string; mode?: 'report' | 'sweep'; leaseMs?: number; nowMs?: number } = {}
) {
  return acquireRunLease({
    db: db as never,
    runnerId: overrides.runnerId ?? 'runner-a',
    sweepId: overrides.sweepId ?? 'sweep_a_0001',
    mode: overrides.mode ?? 'report',
    ...(overrides.leaseMs === undefined ? {} : { leaseMs: overrides.leaseMs }),
    nowMs: overrides.nowMs ?? NOW,
  });
}

let consoleLog: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
});

// ─── The path ────────────────────────────────────────────────────────────────

describe('the Lease_Namespace (Reqs 6.1, 6.2, 6.10)', () => {
  it('is four segments inside the maintenance namespace, on a FIXED document id', () => {
    expect(ORPHAN_SWEEP_LEASE_COLLECTION).toBe(`${ORPHAN_SWEEP_PROGRESS_PATH}/leases`);
    expect(ORPHAN_SWEEP_RUN_LEASE_ID).toBe('run');
    expect(runLeasePath()).toBe('storageMaintenanceJobs/orphanSweep/leases/run');
    // An EVEN segment count is what makes it a document path rather than a collection
    // path, and Firestore rejects the odd case.
    expect(runLeasePath().split('/')).toHaveLength(4);
    expect(runLeasePath().startsWith('storageMaintenanceJobs/')).toBe(true);
    // Req 6.2 — nothing about this path is in `jobLeases/`.
    expect(runLeasePath().startsWith('jobLeases/')).toBe(false);
    // Req 6.10 — the Report_Document path is untouched, and is a sibling collection.
    expect(tenantReportPath('acme')).toBe('storageMaintenanceJobs/orphanSweep/tenants/acme');
  });

  /**
   * The id is fixed rather than per execution, and that IS the mechanism: mutual
   * exclusion requires two executions to contend on one document, so a uuid or the
   * Sweep_Id would give every execution its own uncontended document and every
   * acquisition would succeed.
   */
  it('resolves to the same document for every call', () => {
    expect(runLeasePath()).toBe(runLeasePath());
  });
});

// ─── The clamp ───────────────────────────────────────────────────────────────

describe('clampRunLeaseMs (Req 5.11)', () => {
  it('bounds a usable duration into [5 min, 6 h] at every boundary', () => {
    expect(MIN_RUN_LEASE_MS).toBe(5 * MINUTE);
    expect(MAX_RUN_LEASE_MS).toBe(6 * HOUR);
    expect(DEFAULT_RUN_LEASE_MS).toBe(45 * MINUTE);

    // One millisecond below the floor clamps UP to the floor — it is not a fallback
    // to the default, because a configured 4m59.999s is a readable intention.
    expect(clampRunLeaseMs(5 * MINUTE - 1)).toBe(MIN_RUN_LEASE_MS);
    expect(clampRunLeaseMs(5 * MINUTE)).toBe(MIN_RUN_LEASE_MS);
    expect(clampRunLeaseMs(45 * MINUTE)).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs(6 * HOUR)).toBe(MAX_RUN_LEASE_MS);
    expect(clampRunLeaseMs(6 * HOUR + 1)).toBe(MAX_RUN_LEASE_MS);
  });

  /**
   * Every unusable value resolves to the documented default and **never to zero**: a
   * resolved zero is a lease that had already expired at the instant it was written,
   * i.e. no lease at all while appearing to be one.
   */
  it('falls back to the 45-minute default for every unusable value', () => {
    expect(clampRunLeaseMs(0)).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs(-1)).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs(Number.NaN)).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_RUN_LEASE_MS);
    // A non-number, including the string form an environment variable would produce
    // if it ever reached here unparsed.
    expect(clampRunLeaseMs('2700000')).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs(undefined)).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs(null)).toBe(DEFAULT_RUN_LEASE_MS);
    expect(clampRunLeaseMs({})).toBe(DEFAULT_RUN_LEASE_MS);
    // Finite and positive, yet truncating to zero — the case a naive
    // `> 0` guard passes and `Math.trunc` then destroys.
    expect(clampRunLeaseMs(0.5)).toBe(DEFAULT_RUN_LEASE_MS);
  });

  it('exceeds the job definitions timeoutSeconds, which is why renewal is a fence', () => {
    // Both Cloud Run Job definitions set `timeoutSeconds: 1800`. The default lease
    // outliving it by design is what makes the expiry the only liveness mechanism
    // (Req 5.10) — task 8.4's manifest test asserts the same inequality from the
    // manifests' side.
    expect(DEFAULT_RUN_LEASE_MS / 1000).toBeGreaterThan(1800);
  });
});

// ─── Acquire ─────────────────────────────────────────────────────────────────

describe('acquireRunLease (Reqs 5.2, 5.3, 6.5, 6.8)', () => {
  it('grants against an ABSENT document and records exactly the ten declared fields', async () => {
    const { log, db } = harness();
    const result = await acquire(db, { leaseMs: 20 * MINUTE, mode: 'sweep', sweepId: 'sweep_a_0007' });

    expect(result.ok).toBe(true);
    const handle = (result as { handle: RunLeaseHandle }).handle;

    const lease = db.documents.get(runLeasePath())!;
    expect(Object.keys(lease).sort()).toEqual(LEASE_FIELDS);
    expect(lease.jobName).toBe(RUN_LEASE_JOB_NAME);
    expect(lease.token).toBe(handle.token);
    expect(lease.runnerId).toBe('runner-a');
    expect(lease.sweepId).toBe('sweep_a_0007');
    expect(lease.mode).toBe('sweep');
    expect(lease.acquiredAtMs).toBe(NOW);
    expect(lease.acquiredAtIso).toBe(new Date(NOW).toISOString());
    expect(lease.expiresAtMs).toBe(NOW + 20 * MINUTE);
    expect(lease.renewals).toBe(0);
    expect(lease.updatedAt).toBeInstanceOf(Date);
    expect(handle.expiresAtMs).toBe(NOW + 20 * MINUTE);

    // Req 6.8 — one transaction, one document, and every touched path is the lease's.
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get', 'tx.set']);
    for (const entry of log.entries) {
      expect(entry.store).toBe('firestore');
      expect(entry.method.startsWith('tx.')).toBe(true);
      expect(entry.target).toBe(runLeasePath());
      expect(entry.target.startsWith('storageMaintenanceJobs/orphanSweep/leases/')).toBe(true);
    }
  });

  it('clamps the recorded expiry through clampRunLeaseMs rather than trusting the caller', async () => {
    const { db } = harness();
    // A configured 1 ms is usable-looking and far below the floor.
    await acquire(db, { leaseMs: 1 });
    expect(db.documents.get(runLeasePath())!.expiresAtMs).toBe(NOW + MIN_RUN_LEASE_MS);
  });

  it('grants against an EXPIRED document, replacing every field of the previous holder', async () => {
    const { log, db } = harness();
    db.documents.set(runLeasePath(), existingLease(NOW - 1, { stowaway: 'application data' }));

    const result = await acquire(db);
    expect(result.ok).toBe(true);

    // A plain `set`, deliberately NOT `{ merge: true }`: an eleventh field an earlier
    // version wrote must not survive a fresh grant, which is what keeps "exactly ten
    // fields" a property of the DOCUMENT rather than only of the payload (Req 6.5).
    const lease = db.documents.get(runLeasePath())!;
    expect(Object.keys(lease).sort()).toEqual(LEASE_FIELDS);
    expect(lease.stowaway).toBeUndefined();
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get', 'tx.set']);
  });

  /**
   * An absent, `null`, non-numeric or non-finite `expiresAtMs` is a lease **nobody
   * holds**, and each is granted rather than treated as held.
   *
   * The alternative is the failure mode that made the parent design reject a lease in
   * the first place: one bad write — a hand edit, a partial write, a field rename —
   * would block every sweep forever, with no expiry to heal it.
   */
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', '2026-05-01T00:30:00Z'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('grants when the recorded expiresAtMs is %s', async (_label, value) => {
    const { db } = harness();
    const record = existingLease(value);
    if (value === undefined) delete record.expiresAtMs;
    db.documents.set(runLeasePath(), record);

    const result = await acquire(db);
    expect(result.ok).toBe(true);
    expect(db.documents.get(runLeasePath())!.token).toBe((result as { handle: RunLeaseHandle }).handle.token);
  });

  it('DECLINES an unexpired lease, writes nothing, and names the holder (Reqs 5.4, 5.5)', async () => {
    const { log, db } = harness();
    const held = existingLease(NOW + 30 * MINUTE);
    db.documents.set(runLeasePath(), held);

    const result = await acquire(db, { runnerId: 'runner-b' });
    expect(result).toEqual({
      ok: false,
      reason: 'held',
      heldBy: { runnerId: 'other-runner', expiresAtMs: NOW + 30 * MINUTE },
    });

    // Not a probe, not a counter, not a "declined at" marker: the holder's document is
    // exactly as the holder left it.
    expect(db.documents.get(runLeasePath())).toEqual(held);
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get']);
    expect(log.writes()).toEqual([]);
  });

  /**
   * The expiry boundary, stated precisely because Req 5.12's "strictly after" wording
   * and the code disagree by one instant.
   *
   * `acquireRunLease` treats the lease as held only while `recordedExpiryMs > nowMs`
   * — the same comparison `billingAutoCancelStalePending`'s own `acquireRunLease`
   * uses — so the expiry instant itself grants. The direction is the safe one: it
   * never grants while a holder's window is still open. Recorded in `tasks.md` under
   * task 9.4 for review.
   */
  it('declines one millisecond before the recorded expiry and grants at it', async () => {
    const { db } = harness();
    db.documents.set(runLeasePath(), existingLease(NOW));

    const early = await acquire(db, { nowMs: NOW - 1 });
    expect(early.ok).toBe(false);

    const atExpiry = await acquire(db, { nowMs: NOW });
    expect(atExpiry.ok).toBe(true);
  });

  it('reports a null holder id when the recorded runnerId is unusable', async () => {
    const { db } = harness();
    db.documents.set(runLeasePath(), existingLease(NOW + MINUTE, { runnerId: 42 }));
    const result = await acquire(db);
    expect(result).toEqual({
      ok: false,
      reason: 'held',
      heldBy: { runnerId: null, expiresAtMs: NOW + MINUTE },
    });
  });

  /**
   * Req 5.20, 5.21 — a FAILED acquisition is a thrown transaction, and it is not
   * convertible into a decline: nothing in `acquireRunLease` catches a transaction
   * error, so the only way to observe a failure is for the `await` to throw.
   */
  it('lets a transaction failure propagate rather than returning a decline', async () => {
    const { db } = harness();
    const outage = new Error('UNAVAILABLE: firestore is unavailable');
    const failing: FakeFirestore = {
      ...db,
      runTransaction: () => Promise.reject(outage),
    };

    await expect(acquire(failing)).rejects.toBe(outage);
    // Nothing was written, so a failure leaves no half-taken lease behind.
    expect(db.documents.get(runLeasePath())).toBeUndefined();
  });
});

// ─── Renew ───────────────────────────────────────────────────────────────────

describe('RunLeaseHandle.renew (Reqs 5.8, 5.18, 5.19)', () => {
  it('extends the expiry, increments renewals and leaves the other seven fields alone', async () => {
    const { log, db } = harness();
    const result = await acquire(db, { leaseMs: 10 * MINUTE });
    const handle = (result as { handle: RunLeaseHandle }).handle;
    const acquired = { ...db.documents.get(runLeasePath())! };
    log.clear();

    const first = await handle.renew(NOW + MINUTE);
    expect(first).toEqual({ ok: true, expiresAtMs: NOW + MINUTE + 10 * MINUTE });

    const afterFirst = db.documents.get(runLeasePath())!;
    expect(afterFirst.expiresAtMs).toBe(NOW + MINUTE + 10 * MINUTE);
    expect(afterFirst.renewals).toBe(1);
    // `{ merge: true }` is required here, unlike in the acquisition: the other seven
    // fields belong to a document this execution already owns.
    expect(afterFirst.token).toBe(acquired.token);
    expect(afterFirst.jobName).toBe(acquired.jobName);
    expect(afterFirst.runnerId).toBe(acquired.runnerId);
    expect(afterFirst.sweepId).toBe(acquired.sweepId);
    expect(afterFirst.mode).toBe(acquired.mode);
    expect(afterFirst.acquiredAtMs).toBe(acquired.acquiredAtMs);
    expect(afterFirst.acquiredAtIso).toBe(acquired.acquiredAtIso);
    expect(Object.keys(afterFirst).sort()).toEqual(LEASE_FIELDS);

    // The handle's own expiry follows, so a log line written later states the live
    // window rather than the acquisition-time one (Req 5.17).
    expect(handle.expiresAtMs).toBe(NOW + MINUTE + 10 * MINUTE);

    // `renewals` counts CALLS by design — it is "tenants started under this lease".
    const second = await handle.renew(NOW + 2 * MINUTE);
    expect(second).toEqual({ ok: true, expiresAtMs: NOW + 2 * MINUTE + 10 * MINUTE });
    expect(db.documents.get(runLeasePath())!.renewals).toBe(2);

    // Req 6.8 again: two transactions, one document, `tx.` methods only.
    expect(log.entries.map((entry) => entry.method)).toEqual([
      'tx.get',
      'tx.set',
      'tx.get',
      'tx.set',
    ]);
    for (const entry of log.entries) expect(entry.target).toBe(runLeasePath());
  });

  it("returns 'fenced' after a foreign overwrite and touches the document not at all", async () => {
    const { log, db } = harness();
    const result = await acquire(db);
    const handle = (result as { handle: RunLeaseHandle }).handle;

    const foreign = existingLease(NOW + HOUR, { token: 'foreign-token', renewals: 3 });
    db.documents.set(runLeasePath(), foreign);
    const before = JSON.stringify(foreign);
    log.clear();

    expect(await handle.renew(NOW + MINUTE)).toEqual({ ok: false, reason: 'fenced' });

    // Req 5.19 — byte-identical to what the foreign holder wrote. Not renewed, not
    // deleted, not touched: releasing on the way out would strip the new holder of
    // exclusivity it legitimately acquired.
    expect(JSON.stringify(db.documents.get(runLeasePath()))).toBe(before);
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get']);
    expect(log.writes()).toEqual([]);
    // And the handle's recorded expiry did not move either.
    expect(handle.expiresAtMs).toBe(NOW + DEFAULT_RUN_LEASE_MS);
  });

  it("returns 'missing' after the document is deleted, and still writes nothing", async () => {
    const { log, db } = harness();
    const result = await acquire(db);
    const handle = (result as { handle: RunLeaseHandle }).handle;

    db.documents.delete(runLeasePath());
    log.clear();

    expect(await handle.renew(NOW + MINUTE)).toEqual({ ok: false, reason: 'missing' });
    expect(db.documents.get(runLeasePath())).toBeUndefined();
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get']);
    expect(log.writes()).toEqual([]);
  });

  it('is safe to call repeatedly after a fence, and never throws for a lease it lost', async () => {
    const { db } = harness();
    const result = await acquire(db);
    const handle = (result as { handle: RunLeaseHandle }).handle;
    db.documents.set(runLeasePath(), existingLease(NOW + HOUR, { token: 'foreign-token' }));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await handle.renew(NOW + attempt)).toEqual({ ok: false, reason: 'fenced' });
    }
    expect(db.documents.get(runLeasePath())!.token).toBe('foreign-token');
  });
});

// ─── Release ─────────────────────────────────────────────────────────────────

describe('RunLeaseHandle.release (Reqs 5.6, 5.7)', () => {
  it('deletes the document when the recorded token matches', async () => {
    const { log, db } = harness();
    const result = await acquire(db);
    const handle = (result as { handle: RunLeaseHandle }).handle;
    log.clear();

    await handle.release();
    expect(db.documents.get(runLeasePath())).toBeUndefined();
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get', 'tx.delete']);
    for (const entry of log.entries) expect(entry.target).toBe(runLeasePath());
  });

  it('deletes NOTHING when the recorded token is foreign', async () => {
    const { log, db } = harness();
    const result = await acquire(db);
    const handle = (result as { handle: RunLeaseHandle }).handle;

    const foreign = existingLease(NOW + HOUR, { token: 'foreign-token' });
    db.documents.set(runLeasePath(), foreign);
    log.clear();

    await handle.release();
    // The one way this mechanism could itself CAUSE an overlap, and it does not.
    expect(db.documents.get(runLeasePath())).toEqual(foreign);
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get']);
    expect(log.writes()).toEqual([]);
  });

  it('is idempotent: a second release finds no document and returns', async () => {
    const { log, db } = harness();
    const result = await acquire(db);
    const handle = (result as { handle: RunLeaseHandle }).handle;

    await handle.release();
    log.clear();
    await expect(handle.release()).resolves.toBeUndefined();

    expect(db.documents.get(runLeasePath())).toBeUndefined();
    expect(log.entries.map((entry) => entry.method)).toEqual(['tx.get']);
    expect(log.writes()).toEqual([]);
  });
});

// ─── The whole lifecycle, as one operation log ───────────────────────────────

describe('every lease operation is a tx. method on ONE document path (Req 6.8)', () => {
  it('acquires, renews twice, releases — eight entries, all on the lease document', async () => {
    const { log, db } = harness();
    const result = await acquire(db);
    const handle = (result as { handle: RunLeaseHandle }).handle;
    await handle.renew(NOW + MINUTE);
    await handle.renew(NOW + 2 * MINUTE);
    await handle.release();

    expect(log.entries.map((entry) => entry.method)).toEqual([
      'tx.get',
      'tx.set',
      'tx.get',
      'tx.set',
      'tx.get',
      'tx.set',
      'tx.get',
      'tx.delete',
    ]);
    // One path, one store, and not a single non-transactional write.
    expect(new Set(log.entries.map((entry) => entry.target))).toEqual(new Set([runLeasePath()]));
    expect(new Set(log.entries.map((entry) => entry.store))).toEqual(new Set(['firestore']));
    expect(log.methods().every((method) => method.startsWith('firestore.tx.'))).toBe(true);
    // And no query was ever executed: the lease never scans a collection.
    expect(db.queries).toEqual([]);
  });
});
