// Feature: storage-sweep-scale-hardening, Property 4: The Run_Lease is mutually exclusive, fenced, and self-healing
/**
 * Property 4: The Run_Lease is mutually exclusive, fenced, and self-healing
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.11, 5.12, 5.14, 5.18, 5.19, 5.20, 5.21, 5.22, 6.8, 9.8**
 *
 * *For any* generated interleaving of 2–4 simulated executions against one lease
 * document — acquisitions, renewals, releases, crashes without release, an absent
 * initial document, an expired one, a document with a non-numeric `expiresAtMs`,
 * and a foreign token written mid-run, in any order at any simulated instant.
 *
 * ── WHAT THE SIMULATION IS, AND WHAT IT IS NOT ──────────────────────────────
 *
 * `main()` in `runStorageOrphanSweep.ts` is unexported and reachable only under
 * `require.main === module`, so a *schedule* of overlapping runs cannot be driven
 * through it. What is driven here is every piece of the mechanism that holds state:
 * the real `acquireRunLease`, the real `RunLeaseHandle.renew` / `release`, the real
 * `runStorageOrphanSweep` tenant loop with its fencing check, the real
 * `emitSweepMetric`, and the real `sweepRunExitCode`. What is *mirrored* from the
 * runner rather than invoked is the seven-line outcome mapping around them —
 * "declined ⇒ emit `contended`, list nothing, exit 0", "granted ⇒ sweep, renew per
 * tenant, release in a `finally`" — because that mapping lives inside `main()`.
 * Its ORDER and PRESENCE are asserted over the runner's source by
 * `runStorageOrphanSweep.test.ts` (spec task 9.2); its BEHAVIOUR is asserted here.
 * Neither test alone would be enough, and the pair is why 9.2's assertions are
 * ordering-only.
 *
 * ── How two executions overlap inside one process ───────────────────────────
 *
 *  - Every execution runs concurrently under one `Promise.all`, and each awaits a
 *    **generated number of microtask ticks** before its acquisition and before each
 *    renewal. Node's event loop is deterministic, so a fixed program produces one
 *    interleaving; the generated tick counts are what make the *arrival order* at
 *    the lease operations a generated variable rather than a constant. A schedule is
 *    therefore reproducible from its seed, and no wall-clock timing is involved.
 *  - `runTransaction` **serialises**: `serialisingFirestore` chains every
 *    transaction onto the previous one, so two bodies never interleave their
 *    `tx.get` / `tx.set`. That is what the real SDK guarantees, and without it the
 *    fake would manufacture a mutual-exclusion failure the code does not have —
 *    both executions would read "absent" and both would write. The harness's
 *    `runTransaction` deliberately does not retry (see its note), so the lease's
 *    correctness must not depend on a retry, and here it does not.
 *  - The **simulated instants** are generated inside a 60-second window, which is
 *    shorter than `MIN_RUN_LEASE_MS`. That is required rather than tidy: the lease
 *    is *designed* to become acquirable after its expiry, so a schedule whose
 *    instants straddle an expiry would make two executions legitimately concurrent
 *    and the exclusivity clause false. Exclusivity is asserted over a window in
 *    which no lease can expire; the expiry handover is asserted separately, in its
 *    own case, where the post-expiry instant is the point.
 *
 * **What this does not cover.** Real concurrency is not simulated — there are no
 * two OS processes, no real Firestore contention window and no partial write. The
 * transaction boundary is the fake's, so a bug that needs a real commit race
 * (two clients both passing a precondition inside Firestore's own retry loop)
 * stays invisible here. That residue is what task 12's first cautious apply run is
 * for. Everything this simulation *does* cover is the state machine: who may write
 * the document, what each outcome returns, and what the exit code becomes.
 *
 * ── One boundary the code and Req 5.12's wording disagree on ────────────────
 *
 * Req 5.12 says an unreleased lease becomes acquirable "strictly after the recorded
 * Lease_Expiry". `acquireRunLease` treats the lease as held only while
 * `recordedExpiryMs > nowMs`, so at `nowMs === expiresAtMs` **exactly** it is
 * granted rather than declined — the same comparison `billingAutoCancelStalePending`
 * uses, which this module's shape follows. The difference is one instant at a
 * boundary with no operational meaning, and the code's direction is the safe one:
 * it never grants while a holder's own window is still open. So the assertion below
 * is the precise form — **declined at every instant strictly before the recorded
 * expiry, granted at the expiry instant and after** — rather than a restatement of
 * the wording. Recorded in `tasks.md` under task 9.4 for review.
 */

import * as fc from 'fast-check';

import {
  DEFAULT_RUN_LEASE_MS,
  MAX_RUN_LEASE_MS,
  MIN_RUN_LEASE_MS,
  RUN_LEASE_JOB_NAME,
  acquireRunLease,
  clampRunLeaseMs,
  runLeasePath,
  type AcquireRunLeaseResult,
  type RunLeaseHandle,
} from '../jobs/storageOrphanSweepLease';
// The real core, and the real metric emitter it exports for the runner's two lease
// outcomes (Req 10.3) — imported rather than reimplemented, so the single-line JSON
// shape the deployed `infra/monitoring/` filters match is the one asserted here.
import { emitSweepMetric, runStorageOrphanSweep } from '../jobs/storageOrphanSweep';
// The real exit-code decision, exported as a seam precisely so a claim about it
// needs no process (Reqs 2.1, 5.21).
import { sweepRunExitCode } from '../jobs/runStorageOrphanSweep';
import { metricNames } from '../metrics';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  iso,
  sweepConfig,
  type DocData,
  type FakeFirestore,
  type FakeObject,
} from './support/storageOrphanSweepHarness';

// Importing the runner module for `sweepRunExitCode` must not load
// `backend-runtime/.env` into `process.env`: jest runs one worker's suites in a
// single process, so that would leak real configuration into every suite scheduled
// after this one. Same mock, same reasoning, as `runStorageOrphanSweep.test.ts`.
jest.mock('dotenv/config', () => ({}));

// ─── The shared fixture, built ONCE at module load ───────────────────────────
//
// Deliberately tiny, and deliberately built here rather than per generated
// schedule: a schedule runs the whole sweep core up to four times, so the fixture
// is the one cost multiplied by `numRuns`. Three tenants is the minimum that makes
// "a foreign token before tenant *k*'s renewal yields exactly *k* tenants swept" a
// claim with more than one value of *k*; one object each is enough for a listing to
// happen at all. Nothing here is referenced, so every object is an orphan candidate
// — which costs nothing in report mode and keeps the fixture from depending on the
// reference sources.

const TENANTS = ['t_alpha', 't_beta', 't_gamma'] as const;
const BASE = Date.parse('2026-05-01T00:00:00Z');
const DAY = 86_400_000;
/** Older than the 7-day grace window, so age is never the reason for a retention. */
const OLD = iso(BASE - 120 * DAY);

const OBJECTS: FakeObject[] = TENANTS.map((tenantId) => ({
  name: `notices/${tenantId}/orphan.bin`,
  size: 1_024,
  timeCreated: OLD,
  updated: OLD,
}));

/** The instants a schedule may use, all inside one window shorter than the minimum lease. */
const INSTANT_WINDOW_MS = 60_000;
/** A foreign holder's window, long enough that no generated instant can outlive it. */
const FOREIGN_LEASE_MS = 45 * 60_000;

// ─── Serialising the transaction surface ─────────────────────────────────────

/**
 * One fake Firestore whose `runTransaction` **serialises**: each transaction body
 * is chained onto the completion of the previous one, so no two bodies interleave.
 *
 * Everything else — `documents`, `doc`, `collection`, `queries` — is shared by
 * reference, so all executions contend on the same lease document and write to the
 * same Report_Documents, which is the point.
 */
function serialisingFirestore(db: FakeFirestore): FakeFirestore {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    ...db,
    runTransaction: <T>(body: Parameters<FakeFirestore['runTransaction']>[0]): Promise<T> => {
      const result = tail.then(() => db.runTransaction(body)) as Promise<T>;
      // The chain must survive a rejected body, or one failed transaction would
      // wedge every later one.
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  };
}

/**
 * The **failed** acquisition of Req 5.20: the execution's FIRST transaction throws.
 *
 * Injected on a per-execution view of the shared store rather than through the
 * harness's `failures` map, which keys on the first path segment and would fail
 * every read of `storageMaintenanceJobs/` — including the Report_Document reads a
 * *different* execution is making at that moment. The first transaction an
 * execution issues is its acquisition, so this is exactly "acquiring threw".
 */
function throwOnFirstTransaction(db: FakeFirestore, error: unknown): FakeFirestore {
  let thrown = false;
  return {
    ...db,
    runTransaction: <T>(body: Parameters<FakeFirestore['runTransaction']>[0]): Promise<T> => {
      if (!thrown) {
        thrown = true;
        return Promise.reject(error);
      }
      return db.runTransaction(body) as Promise<T>;
    },
  };
}

// ─── Recording an outcome as a VALUE, never as a caught precondition ─────────

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Turn a promise into a recorded outcome.
 *
 * Req 11.26 forbids establishing a precondition by catching an exception, and this
 * does not: every assertion below is a **biconditional** against the generated
 * spec — an execution's outcome is `acquire_failed` *if and only if* its spec asked
 * the acquisition to throw. If `acquireRunLease` stopped throwing, this property
 * would fail rather than become vacuously true, which is the failure mode Req 11.26
 * exists to prevent.
 */
async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
}

/** A crash that terminates an execution WITHOUT releasing its lease (Req 5.12). */
class SimulatedCrash extends Error {
  constructor(readonly tenantsSwept: number) {
    super(`simulated crash after ${tenantsSwept} tenants`);
  }
}

/** Yield the event loop `count` times, which is what makes the arrival order generated. */
async function ticks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

// ─── The simulated execution ─────────────────────────────────────────────────

interface ExecutionSpec {
  id: number;
  startTicks: number;
  renewTicks: number;
  instantOffsetMs: number;
  /** Including values `clampRunLeaseMs` must reject (Req 5.11). */
  leaseMs: number | undefined;
  throwOnAcquire: boolean;
  /** A foreign token written immediately before this execution's renewal for tenant `atTenant`. */
  fenceAtTenant: number | null;
  /** This execution dies before tenant `atTenant`, never reaching its release. */
  crashAtTenant: number | null;
}

type ExecutionOutcome =
  | { kind: 'declined'; exitCode: number; tenantsSwept: 0; listings: number; heldUntilMs: number }
  | { kind: 'acquire_failed'; exitCode: number; tenantsSwept: 0; listings: number }
  | {
      kind: 'granted';
      exitCode: number;
      tenantsSwept: number;
      listings: number;
      token: string;
      leaseLost: boolean;
      crashed: boolean;
      released: boolean;
    };

interface SharedState {
  db: FakeFirestore;
  /** The count of executions currently inside their swept region, and its maximum. */
  region: { inside: number; max: number };
  /** A deep clone of the foreign holder's write, taken the instant it landed. */
  foreignSnapshot: DocData | null;
  /**
   * Declines that arrived while another execution was **inside** its swept region.
   *
   * This is what makes the exclusivity clause non-vacuous, and it is the one number
   * worth stating plainly: a schedule in which every acquisition happened to be
   * sequential would satisfy "at most one holder" without the lease doing anything
   * at all. A positive count here is evidence that the generated tick counts really
   * do land a second acquisition in the middle of a live sweep.
   */
  contentionWitnessed: number;
}

/** The foreign holder's document: the ten declared fields, with a token nobody here owns. */
function foreignLeaseDoc(atMs: number, marker: string): DocData {
  return {
    jobName: RUN_LEASE_JOB_NAME,
    token: `foreign-token-${marker}`,
    runnerId: `foreign-runner-${marker}`,
    sweepId: `sweep_foreign_${marker}`,
    mode: 'report',
    acquiredAtMs: atMs,
    acquiredAtIso: new Date(atMs).toISOString(),
    expiresAtMs: atMs + FOREIGN_LEASE_MS,
    renewals: 0,
    updatedAt: new Date(atMs),
  };
}

const clone = (data: DocData | undefined): DocData | null =>
  data === undefined ? null : (JSON.parse(JSON.stringify(data)) as DocData);

/**
 * One execution, wired exactly as `main()` wires one: acquire, then either decline
 * (green, no listing), fail (red, no listing) or sweep under the lease with the
 * renewal injected and the release in a `finally`.
 */
async function simulate(spec: ExecutionSpec, shared: SharedState): Promise<ExecutionOutcome> {
  const log = createOperationLog();
  const bucket = createFakeBucket({ log, objects: OBJECTS });
  const rtdb = createFakeRtdb({ log, tree: {} });
  const listings = (): number => log.filter((entry) => entry.method === 'getFiles').length;

  const runnerId = `exec-${spec.id}`;
  const sweepId = `sweep_lease_${spec.id}`;
  const nowMs = BASE + spec.instantOffsetMs;

  await ticks(spec.startTicks);

  const acquisitionDb = spec.throwOnAcquire
    ? throwOnFirstTransaction(shared.db, new Error('FAILED_PRECONDITION: firestore unavailable'))
    : shared.db;

  const acquisition: Settled<AcquireRunLeaseResult> = await settle(
    acquireRunLease({
      db: acquisitionDb as never,
      runnerId,
      sweepId,
      mode: 'report',
      leaseMs: spec.leaseMs,
      nowMs,
    })
  );

  // ── FAILED: the transaction threw. No listing, no tenant, non-zero (Req 5.20) ──
  //
  // The runner does not catch this at all — it propagates to `main().catch`, which
  // sets `process.exitCode = 1`. Mirrored here as the exit code 1 that path
  // produces.
  if (!acquisition.ok) {
    return { kind: 'acquire_failed', exitCode: 1, tenantsSwept: 0, listings: listings() };
  }

  const lease = acquisition.value;

  // ── DECLINED: an unexpired lease is held. No listing, no tenant, ZERO (Req 5.4) ──
  if (!lease.ok) {
    if (shared.region.inside > 0) shared.contentionWitnessed += 1;
    emitSweepMetric(
      metricNames.storageOrphanSweepLease,
      { mode: 'report', outcome: 'contended' },
      1,
      'WARNING'
    );
    return {
      kind: 'declined',
      exitCode: 0,
      tenantsSwept: 0,
      listings: listings(),
      heldUntilMs: lease.heldBy.expiresAtMs,
    };
  }

  emitSweepMetric(metricNames.storageOrphanSweepLease, { mode: 'report', outcome: 'acquired' }, 1);

  const handle: RunLeaseHandle = lease.handle;
  shared.region.inside += 1;
  shared.region.max = Math.max(shared.region.max, shared.region.inside);

  let tenantIndex = 0;
  const run = await settle(
    runStorageOrphanSweep({
      db: shared.db as never,
      rtdb: rtdb as never,
      bucket: bucket as never,
      config: sweepConfig({
        tenantIds: [...TENANTS],
        mode: 'report',
        apply: false,
        pageSize: 5,
        nowMs: BASE,
        sweepId,
        runnerId,
        leaseToken: handle.token,
        // Req 5.14: `force` does not exempt the lease — and it also keeps every
        // execution re-listing rather than returning early off another execution's
        // `completed` Report_Document, so a listing count of zero means "declined"
        // rather than "resumed".
        force: true,
      }) as never,
      // The ONE lease coupling the core has (Req 5.8, 5.16), called as the first
      // statement of each tenant iteration.
      renewRunLease: async () => {
        const index = tenantIndex;
        tenantIndex += 1;
        await ticks(spec.renewTicks);
        // The crash is checked FIRST, and the order is what keeps the two
        // disturbances unambiguous: a crash at the same tenant index pre-empts the
        // foreign write entirely, so a recorded foreign write always means the
        // fencing branch really ran. Conversely a fence breaks the tenant loop, so a
        // crash at a LATER index is unreachable — one disturbance per execution
        // fires, whichever comes first.
        if (spec.crashAtTenant === index) {
          throw new SimulatedCrash(index);
        }
        if (spec.fenceAtTenant === index) {
          const doc = foreignLeaseDoc(BASE, `${spec.id}`);
          shared.db.documents.set(runLeasePath(), doc);
          shared.foreignSnapshot = clone(doc);
        }
        return handle.renew(nowMs + index + 1);
      },
    })
  );

  shared.region.inside -= 1;

  if (!run.ok) {
    // The only throw this simulation injects. Anything else is a real failure and
    // must surface rather than be absorbed into an outcome.
    if (!(run.error instanceof SimulatedCrash)) throw run.error;
    // Crashed: the `finally` never runs, so the lease is left behind to expire
    // (Req 5.12). That is what the self-healing case below then acquires.
    return {
      kind: 'granted',
      exitCode: 1,
      tenantsSwept: run.error.tenantsSwept,
      listings: listings(),
      token: handle.token,
      leaseLost: false,
      crashed: true,
      released: false,
    };
  }

  // Released on completion and on failure alike (Req 5.6), token-matched (Req 5.7).
  await handle.release();

  return {
    kind: 'granted',
    exitCode: sweepRunExitCode(run.value),
    tenantsSwept: run.value.tenants.length,
    listings: listings(),
    token: handle.token,
    leaseLost: run.value.leaseLost === true,
    crashed: false,
    released: true,
  };
}

// ─── Generators ──────────────────────────────────────────────────────────────

type InitialDocShape = 'absent' | 'expired' | 'unexpired' | 'expiry_string' | 'expiry_null' | 'expiry_nan';

const initialDocArb = fc.constantFrom<InitialDocShape>(
  'absent',
  'expired',
  'unexpired',
  'expiry_string',
  'expiry_null',
  'expiry_nan'
);

/**
 * A configured lease duration, including every shape `clampRunLeaseMs` must send to
 * the documented default (Req 5.11). `undefined` is the "nothing configured" case.
 */
const leaseMsArb = fc.oneof(
  fc.constant<number | undefined>(undefined),
  fc.constantFrom<number | undefined>(0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY),
  fc.integer({ min: 1, max: 8 * 60 * 60_000 })
);

function installInitialDoc(db: FakeFirestore, shape: InitialDocShape): void {
  if (shape === 'absent') return;
  const base = foreignLeaseDoc(BASE - FOREIGN_LEASE_MS, 'initial');
  const expiresAtMs: unknown =
    shape === 'expired'
      ? BASE - 1_000
      : shape === 'unexpired'
        ? BASE + 30 * 60_000
        : shape === 'expiry_string'
          ? '2026-05-01T00:30:00Z'
          : shape === 'expiry_null'
            ? null
            : Number.NaN;
  db.documents.set(runLeasePath(), { ...base, expiresAtMs });
}

/**
 * Every acquirable initial shape (Req 5.3's negative: an absent, non-numeric,
 * non-finite or past `expiresAtMs` is a lease nobody holds). `'unexpired'` is the
 * only one that must decline.
 */
const ACQUIRABLE_SHAPES: InitialDocShape[] = [
  'absent',
  'expired',
  'expiry_string',
  'expiry_null',
  'expiry_nan',
];

// ─── Metric line capture ─────────────────────────────────────────────────────

interface MetricLine {
  metric: string;
  value: number;
  mode?: string;
  outcome?: string;
  tenant_id?: string;
  severity?: string;
}

let capturedLines: string[] = [];
let consoleLog: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string') capturedLines.push(args[0]);
  });
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
});

function leaseMetricLines(outcome: string): MetricLine[] {
  const lines: MetricLine[] = [];
  for (const raw of capturedLines) {
    if (!raw.startsWith('{')) continue;
    const parsed = JSON.parse(raw) as MetricLine;
    if (parsed.metric === metricNames.storageOrphanSweepLease && parsed.outcome === outcome) {
      lines.push(parsed);
    }
  }
  return lines;
}

// ─── The property ────────────────────────────────────────────────────────────

describe('Property 4: the Run_Lease is mutually exclusive, fenced and self-healing', () => {
  jest.setTimeout(120_000);

  it('admits at most one holder, and no execution without the lease sweeps or lists anything', async () => {
    /** Vacuity guard: every outcome this property is about must be reached (Req 11.25). */
    const arms = {
      granted: 0,
      declined: 0,
      acquireFailed: 0,
      fenced: 0,
      crashed: 0,
      listed: 0,
      declinedMidSweep: 0,
    };

    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 2, max: 4 })
          .chain((count) =>
            fc.record({
              count: fc.constant(count),
              startTicks: fc.array(fc.integer({ min: 0, max: 6 }), {
                minLength: count,
                maxLength: count,
              }),
              renewTicks: fc.array(fc.integer({ min: 0, max: 3 }), {
                minLength: count,
                maxLength: count,
              }),
              instantOffsets: fc.array(fc.integer({ min: 0, max: INSTANT_WINDOW_MS }), {
                minLength: count,
                maxLength: count,
              }),
              leaseMsValues: fc.array(leaseMsArb, { minLength: count, maxLength: count }),
              // Weighted one-in-four rather than a fair coin: a failed acquisition
              // performs no work, so a fair coin spends half of every schedule
              // asserting the cheapest outcome and starves the interleaving of
              // executions that actually reach the tenant loop.
              throwOnAcquire: fc.array(
                fc.integer({ min: 0, max: 3 }).map((value) => value === 0),
                { minLength: count, maxLength: count }
              ),
              initialDoc: initialDocArb,
              // At most one foreign overwrite and at most one crash per schedule, each
              // aimed at a named execution: two simultaneous foreign writers would make
              // "the document at the end is byte-identical to the foreign write"
              // ambiguous about WHICH write, and the mechanism under test is the same
              // either way.
              fence: fc.option(
                fc.record({
                  execution: fc.integer({ min: 0, max: count - 1 }),
                  atTenant: fc.integer({ min: 0, max: TENANTS.length - 1 }),
                }),
                { nil: null }
              ),
              crash: fc.option(
                fc.record({
                  execution: fc.integer({ min: 0, max: count - 1 }),
                  atTenant: fc.integer({ min: 0, max: TENANTS.length - 1 }),
                }),
                { nil: null }
              ),
            })
          ),
        async (schedule) => {
          capturedLines = [];

          const firestoreLog = createOperationLog();
          const db = serialisingFirestore(createFakeFirestore({ log: firestoreLog, collections: {} }));
          installInitialDoc(db, schedule.initialDoc);

          const shared: SharedState = {
            db,
            region: { inside: 0, max: 0 },
            foreignSnapshot: null,
            contentionWitnessed: 0,
          };

          const specs: ExecutionSpec[] = Array.from({ length: schedule.count }, (_, id) => ({
            id,
            startTicks: schedule.startTicks[id],
            renewTicks: schedule.renewTicks[id],
            instantOffsetMs: schedule.instantOffsets[id],
            leaseMs: schedule.leaseMsValues[id],
            throwOnAcquire: schedule.throwOnAcquire[id],
            fenceAtTenant:
              schedule.fence && schedule.fence.execution === id ? schedule.fence.atTenant : null,
            crashAtTenant:
              schedule.crash && schedule.crash.execution === id ? schedule.crash.atTenant : null,
          }));

          const outcomes = await Promise.all(specs.map((spec) => simulate(spec, shared)));

          // ── 1. At most one execution inside its swept region at any instant ──────
          //
          // The counter is incremented on the grant and decremented on the release
          // (or on the crash), and JavaScript is single-threaded, so this maximum is
          // exact rather than sampled.
          expect(shared.region.max).toBeLessThanOrEqual(1);

          const granted = outcomes.filter((outcome) => outcome.kind === 'granted');
          const declined = outcomes.filter((outcome) => outcome.kind === 'declined');
          const failed = outcomes.filter((outcome) => outcome.kind === 'acquire_failed');
          expect(granted.length + declined.length + failed.length).toBe(schedule.count);

          // ── 2. Req 5.22: no tenant is ever swept without a granted lease ─────────
          //
          // Stated as the sum over every execution that did NOT hold the lease,
          // including the ones whose acquisition threw — which is the half of this
          // clause a `try` that fell back to sweeping leaseless would break.
          const sweptWithoutLease = [...declined, ...failed].reduce(
            (sum, outcome) => sum + outcome.tenantsSwept,
            0
          );
          expect(sweptWithoutLease).toBe(0);

          // ── 3. Declined and failed are the SAME no-work outcome with OPPOSITE exit
          //       codes (Reqs 5.4, 5.20, 5.21) ───────────────────────────────────────
          for (const outcome of declined) {
            expect(outcome.listings).toBe(0);
            expect(outcome.tenantsSwept).toBe(0);
            expect(outcome.exitCode).toBe(0);
          }
          for (const outcome of failed) {
            expect(outcome.listings).toBe(0);
            expect(outcome.tenantsSwept).toBe(0);
            expect(outcome.exitCode).not.toBe(0);
          }
          // A failure happens exactly where one was injected — the biconditional that
          // keeps this from passing vacuously if `acquireRunLease` stopped throwing.
          expect(failed.length).toBe(specs.filter((spec) => spec.throwOnAcquire).length);

          // ── 4. Exactly one `contended` line per declined acquisition (Req 5.5) ───
          expect(leaseMetricLines('contended')).toHaveLength(declined.length);
          expect(leaseMetricLines('acquired')).toHaveLength(granted.length);
          // Every lease line is run-level: `mode` and `outcome`, and no `tenant_id`.
          for (const outcome of ['contended', 'acquired', 'lost']) {
            for (const line of leaseMetricLines(outcome)) {
              expect(line.mode).toBe('report');
              expect(line.tenant_id).toBeUndefined();
              expect(line.value).toBe(1);
            }
          }

          // ── 5. An unexpired initial lease declines EVERY execution that reached the
          //       transaction at all, so nothing is listed and nothing is swept ──────
          if (schedule.initialDoc === 'unexpired') {
            expect(granted).toHaveLength(0);
            expect(declined.length).toBe(schedule.count - failed.length);
            for (const outcome of declined) {
              expect(outcome.heldUntilMs).toBe(BASE + 30 * 60_000);
            }
          }

          // ── 6. The fence: exactly *k* tenants swept, a non-zero exit, and a lease
          //       document byte-identical to the foreign write (Reqs 5.9, 5.18, 5.19) ─
          const fenced = granted.filter((outcome) => outcome.leaseLost);
          if (shared.foreignSnapshot !== null) {
            // The foreign write landed, so the execution it was aimed at was granted
            // and reached that tenant. Established from the recorded write, not from a
            // caught exception.
            expect(fenced).toHaveLength(1);
            expect(fenced[0].tenantsSwept).toBe(schedule.fence!.atTenant);
            expect(fenced[0].exitCode).not.toBe(0);
            expect(leaseMetricLines('lost')).toHaveLength(1);

            // Neither renewed, nor deleted, nor touched in the `finally`: the document
            // is exactly what the foreign holder wrote. The foreign window outlives
            // every generated instant, so no later acquisition can have replaced it
            // either — a release with a non-matching token deletes nothing (Req 5.7).
            const after = clone(db.documents.get(runLeasePath()));
            expect(after).not.toBeNull();
            expect(after).toEqual(shared.foreignSnapshot);
            expect(JSON.stringify(after)).toBe(JSON.stringify(shared.foreignSnapshot));
            arms.fenced += 1;
          } else {
            expect(fenced).toHaveLength(0);
            expect(leaseMetricLines('lost')).toHaveLength(0);
          }

          // ── 7. A completed, released execution leaves no lease behind; a crashed one
          //       does (Reqs 5.6, 5.12) ────────────────────────────────────────────────
          const crashed = granted.filter((outcome) => outcome.crashed);
          if (
            shared.foreignSnapshot === null &&
            crashed.length === 0 &&
            granted.length > 0 &&
            ACQUIRABLE_SHAPES.includes(schedule.initialDoc)
          ) {
            expect(db.documents.get(runLeasePath())).toBeUndefined();
          }
          if (crashed.length > 0 && shared.foreignSnapshot === null) {
            const left = db.documents.get(runLeasePath());
            expect(left).toBeDefined();
            expect(typeof left!.expiresAtMs).toBe('number');
          }

          arms.granted += granted.length;
          arms.declined += declined.length;
          arms.acquireFailed += failed.length;
          arms.crashed += crashed.length;
          arms.listed += granted.filter((outcome) => outcome.listings > 0).length;
          arms.declinedMidSweep += shared.contentionWitnessed;
        }
      ),
      { numRuns: 100 }
    );

    // Req 11.25 as a unit claim: a schedule set that reached none of these would be
    // a green suite asserting nothing about the outcome it is named for.
    expect(arms.granted).toBeGreaterThan(0);
    // And the one that makes the exclusivity clause mean something: at least one
    // acquisition was declined while another execution was genuinely mid-sweep.
    expect(arms.declinedMidSweep).toBeGreaterThan(0);
    expect(arms.declined).toBeGreaterThan(0);
    expect(arms.acquireFailed).toBeGreaterThan(0);
    expect(arms.fenced).toBeGreaterThan(0);
    expect(arms.crashed).toBeGreaterThan(0);
    expect(arms.listed).toBeGreaterThan(0);
  });

  /**
   * Req 5.12 — the self-healing half, and the only liveness mechanism the lease
   * has. A crashed execution never reaches its `finally`, so the document is left
   * behind; the expiry is what makes it acquirable again with no operator action.
   *
   * The crash is at tenant 0, so no tenant is swept at all: this case is about the
   * handover, and paying for three tenant sweeps per generated schedule to reach it
   * would buy nothing.
   */
  it('hands an abandoned lease to exactly one waiting execution, and not one instant early', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: INSTANT_WINDOW_MS }),
        leaseMsArb,
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 5 * 60_000 }),
        async (instantOffsetMs, leaseMs, waiters, afterExpiryMs) => {
          capturedLines = [];
          const firestoreLog = createOperationLog();
          const db = serialisingFirestore(createFakeFirestore({ log: firestoreLog, collections: {} }));
          const shared: SharedState = {
            db,
            region: { inside: 0, max: 0 },
            foreignSnapshot: null,
            contentionWitnessed: 0,
          };

          const holder = await simulate(
            {
              id: 0,
              startTicks: 0,
              renewTicks: 0,
              instantOffsetMs,
              leaseMs,
              throwOnAcquire: false,
              fenceAtTenant: null,
              crashAtTenant: 0,
            },
            shared
          );
          expect(holder.kind).toBe('granted');
          expect(holder.crashed).toBe(true);

          // The abandoned lease, and the expiry it recorded.
          const abandoned = db.documents.get(runLeasePath());
          expect(abandoned).toBeDefined();
          const expiresAtMs = abandoned!.expiresAtMs as number;
          expect(expiresAtMs).toBe(BASE + instantOffsetMs + clampRunLeaseMs(leaseMs));

          // ── One instant BEFORE the recorded expiry: still held ─────────────────
          const early = await acquireRunLease({
            db: db as never,
            runnerId: 'waiter-early',
            sweepId: 'sweep_waiter_early',
            mode: 'report',
            nowMs: expiresAtMs - 1,
          });
          expect(early.ok).toBe(false);
          expect(db.documents.get(runLeasePath())).toEqual(abandoned);

          // ── At the recorded expiry and after: exactly ONE of the waiting
          //    executions acquires it, and the rest are declined ──────────────────
          //
          // `afterExpiryMs === 0` is the boundary instant itself, which the code
          // grants — see the note at the top of this file on Req 5.12's "strictly
          // after" wording.
          const at = expiresAtMs + afterExpiryMs;
          const results = await Promise.all(
            Array.from({ length: waiters }, (_unused, index) =>
              acquireRunLease({
                db: db as never,
                runnerId: `waiter-${index}`,
                sweepId: `sweep_waiter_${index}`,
                mode: 'report',
                nowMs: at,
              })
            )
          );
          const winners = results.filter((result) => result.ok);
          expect(winners).toHaveLength(1);
          for (const loser of results.filter((result) => !result.ok)) {
            expect(loser.ok).toBe(false);
          }

          // The winner owns the document, and the losers wrote nothing to it.
          const held = db.documents.get(runLeasePath());
          expect(held).toBeDefined();
          expect(held!.token).toBe((winners[0] as { handle: RunLeaseHandle }).handle.token);
          expect(held!.renewals).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Req 5.7 stated on its own, because it is the one way this mechanism could itself
   * CAUSE an overlap: a release that ignored the recorded token would strip a new
   * holder of exclusivity it legitimately acquired.
   */
  it('never deletes a lease it does not hold, however many times release is called', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: INSTANT_WINDOW_MS }),
        fc.integer({ min: 1, max: 4 }),
        async (instantOffsetMs, releases) => {
          const firestoreLog = createOperationLog();
          const db = serialisingFirestore(createFakeFirestore({ log: firestoreLog, collections: {} }));
          const nowMs = BASE + instantOffsetMs;

          const first = await acquireRunLease({
            db: db as never,
            runnerId: 'holder',
            sweepId: 'sweep_holder',
            mode: 'report',
            nowMs,
          });
          expect(first.ok).toBe(true);
          const handle = (first as { handle: RunLeaseHandle }).handle;

          // A foreign holder replaces the record, exactly as a fence sees it.
          const foreign = foreignLeaseDoc(nowMs, 'release');
          db.documents.set(runLeasePath(), foreign);
          const snapshot = clone(foreign);

          // Renewal is fenced and writes nothing …
          const renewal = await handle.renew(nowMs + 1);
          expect(renewal).toEqual({ ok: false, reason: 'fenced' });
          expect(clone(db.documents.get(runLeasePath()))).toEqual(snapshot);

          // … and release, however often it is called, deletes nothing.
          for (let index = 0; index < releases; index += 1) {
            await handle.release();
          }
          expect(clone(db.documents.get(runLeasePath()))).toEqual(snapshot);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Req 5.11, over the whole of `unknown`. Total, idempotent, and never zero — a
   * resolved zero would be a lease that had already expired at the instant it was
   * written.
   */
  it('clamps every configured duration into [5 min, 6 h] and defaults every unusable one', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -10_000, max: 8 * 60 * 60_000 }),
          fc.double({ noNaN: false }),
          fc.constantFrom<unknown>(
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            0,
            -1,
            0.5,
            '2700000',
            null,
            undefined,
            {},
            [],
            true
          )
        ),
        (value) => {
          const clamped = clampRunLeaseMs(value);
          expect(Number.isInteger(clamped)).toBe(true);
          expect(clamped).toBeGreaterThanOrEqual(MIN_RUN_LEASE_MS);
          expect(clamped).toBeLessThanOrEqual(MAX_RUN_LEASE_MS);
          // Idempotent, which is what lets the runner clamp once and pass the result on.
          expect(clampRunLeaseMs(clamped)).toBe(clamped);

          const unusable =
            typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || Math.trunc(value) <= 0;
          if (unusable) expect(clamped).toBe(DEFAULT_RUN_LEASE_MS);
        }
      ),
      { numRuns: 100 }
    );
  });
});
