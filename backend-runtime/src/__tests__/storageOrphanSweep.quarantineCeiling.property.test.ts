// Feature: storage-sweep-scale-hardening, Property 6: The per-tenant quarantine ceiling holds across batching, crashes and resumption to within the threshold
/**
 * Property 6: The per-tenant quarantine ceiling holds across batching, crashes and
 * resumption to within the threshold
 * **Validates: Requirements 5.15, 7.3, 7.9, 7.22**
 *
 * *For any* ceiling, *any* interruption point, *any* report-write page interval,
 * *any* Quarantine_Write_Threshold and *any* number of sequential executions over
 * one tenant:
 *
 *  - the **tenant's total** moves across an interrupted run and every resumption
 *    never exceeds `ceiling + threshold - 1` (Req 7.22);
 *  - an **uninterrupted** run never exceeds the ceiling **at all**, so the
 *    tolerance is a crash-recovery allowance and not a slackening of the ceiling;
 *  - the persisted `quarantinedCount` a resumption inherits is behind the objects
 *    actually moved by **fewer than the threshold at every interruption point**
 *    (Req 7.3);
 *  - no object is moved twice within one Sweep_Id;
 *  - the bound **tightens as the threshold falls, and is exactly 0 at threshold 1**.
 *
 * ── Why the threshold is GENERATED, and generated WITH the interruption point ──
 *
 * Generating the threshold is what makes the claim a bound rather than a constant:
 * a fixed-ceiling claim is satisfied by any implementation that eventually writes,
 * whereas `ceiling + threshold - 1` pins the overshoot to the configured lag.
 *
 * Generating it *together with* the interruption point is what gives the property
 * teeth against the defect the amendment fixes. A per-PAGE trigger — write once
 * after any page that quarantined an object — passes the old fixed-ceiling claim
 * for a listing that moves one object per page, because every crash then lands at a
 * page boundary whose write already happened. It **fails this property** for a
 * listing whose orphans cluster on a single page: `config.pageSize` defaults to
 * 1000, so the entire ceiling can be moved inside one page and a crash lands before
 * any boundary — persisted count `0`, resume moves a further ceiling, total
 * `2 x ceiling`. That is why the generated distribution includes **all orphans
 * clustered on one page**, and why the interruption may land **on a mover call**
 * rather than only on a page fetch.
 *
 * The exact arithmetic the bound follows, so a reader can check it rather than
 * trust it. Crash on the `m`-th mover call of a single page at threshold `T`: the
 * crashed execution moved `m - 1` objects and persisted `floor((m-1)/T) * T`, so
 * the resumption inherits a count short by `(m-1) mod T` and moves that many past
 * the ceiling before it binds. The overshoot is therefore exactly `(m-1) mod T`,
 * which is `<= T - 1` for every `m` and **exactly 0 for `T = 1`**.
 *
 * ── The precondition is an OUTCOME, and every schedule reaches an assertion ────
 *
 * A listing failure and a crashed mover are both **confined and recorded** (Req
 * 1.1), so nothing is thrown to catch: the interruption is established from the
 * run result's `tenantFailures` and the recorded Report_Document `status`. A
 * generated schedule whose interruption index this fixture never reaches is not
 * skipped — it is asserted as an *uninterrupted* run — and the arm counters at the
 * end fail the test if either arm, or the ceiling itself, was never exercised
 * (Reqs 11.23–11.26).
 *
 * ── Precision note on the Req 7.9 independence this property validates ────────
 *
 * The page-size independence of the move-attributable write count is an *equality*
 * only with the page-interval term isolated: an interval-driven write also resets
 * `movedSinceWrite`, which lowers the move-attributable count and reintroduces the
 * dependence on the page count. Task 1.5 asserts both arms of that. The ceiling
 * bound asserted here holds either way, because a *more* frequent write can only
 * tighten the inherited counter's lag — which is why the page interval is generated
 * freely here rather than pinned.
 */

import * as fc from 'fast-check';

import { runStorageOrphanSweep, tenantReportPath } from '../jobs/storageOrphanSweep';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  createTestQuarantineMover,
  iso,
  sweepConfig,
  type FakeObject,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
/** Old enough that only a reference could retain it, and none exists here. */
const OLD = iso(NOW - 120 * DAY);
/** Inside the 7-day grace window, so a filler object is retained rather than moved. */
const FRESH = iso(NOW - 2 * DAY);
const SWEEP_ID = 'sweep_ceiling_property';

/**
 * One Managed_Category prefix for the whole fixture, so a generated page index and
 * a generated orphan distribution describe **one** listing.
 *
 * `notices/` rather than `profile-pictures/`, whose filenames must match the
 * derivation or the object is retained as `unmanaged_path` and never becomes a
 * candidate at all.
 */
const CATEGORY = 'notices';

/**
 * The page size that makes "every orphan on one page" reachable, and it is the
 * production default rather than a convenience: `config.pageSize` is 1000, which is
 * exactly why a boundary-only threshold check leaves the ceiling breach open.
 */
const CLUSTER_PAGE_SIZE = 1_000;

type Distribution = 'clustered' | 'onePerPage' | 'tail';

/**
 * `candidateCount` aged, unreferenced objects in one prefix, shaped by
 * `distribution`, padded with fresh (grace-retained) filler where a shape needs it.
 *
 * Names are minted in listing order — the fake lists lexicographically — so a slot
 * index is a page position.
 */
function buildObjects(
  candidateCount: number,
  pageSize: number,
  distribution: Distribution
): FakeObject[] {
  const isCandidate: boolean[] = [];
  if (distribution === 'clustered') {
    // Nothing but candidates, listed at `CLUSTER_PAGE_SIZE`: one page, every move.
    for (let index = 0; index < candidateCount; index += 1) isCandidate.push(true);
  } else if (distribution === 'onePerPage') {
    // The shape the rejected per-page trigger passes the weaker claim on.
    for (let index = 0; index < candidateCount; index += 1) {
      isCandidate.push(true);
      for (let filler = 1; filler < pageSize; filler += 1) isCandidate.push(false);
    }
  } else {
    // Every candidate behind a page's worth of retained objects, so the moves start
    // partway through the listing.
    for (let index = 0; index < candidateCount; index += 1) isCandidate.push(false);
    for (let index = 0; index < candidateCount; index += 1) isCandidate.push(true);
  }

  return isCandidate.map((candidate, index) => ({
    name: `${CATEGORY}/${TENANT}/obj_${String(index).padStart(4, '0')}.bin`,
    size: 10 + index,
    timeCreated: candidate ? OLD : FRESH,
    updated: candidate ? OLD : FRESH,
  }));
}

function effectivePageSize(distribution: Distribution, generated: number): number {
  return distribution === 'clustered' ? CLUSTER_PAGE_SIZE : generated;
}

interface LagObservation {
  /**
   * The objects actually moved as the RUNNING EXECUTION knows them: the count it
   * inherited when it started, plus the moves it has made since.
   *
   * ── Why per execution rather than per tenant, found while implementing this ────
   *
   * A crashed execution's unpersisted moves are lost from the persisted count
   * **permanently** — no later write can recover them, because a resumption starts
   * from the counter it inherited. So the lag against the tenant's *cumulative*
   * moves accumulates one crash's worth of loss per crash, and after two crashes it
   * reaches `2 x (threshold - 1)`. Req 7.3's subject is the persisted counter
   * against the objects the writing process has moved, and Req 7.22 is stated over
   * "a crash followed by a resumption" — one crash — which is why this property arms
   * exactly one interruption per tenant history. The bound composes additively per
   * crash rather than holding globally, and that is a property of the spec's
   * statement, not a gap in this assertion.
   */
  moved: number;
  /** The `quarantinedCount` a resumption starting at this instant would inherit. */
  persisted: number;
  where: 'move' | 'page';
}

interface Arm {
  page?: number | null;
  move?: number | null;
}

/**
 * One tenant's world: a bucket, a Firestore and a log that persist across
 * executions, so "the tenant's total" is a statement about one estate rather than
 * about one process.
 */
function createWorld(objects: FakeObject[], config: Record<string, unknown>) {
  const log = createOperationLog();
  const db = createFakeFirestore({ log, collections: { notices: {} } });
  const lags: LagObservation[] = [];

  let armedPage: number | null = null;
  let armedMove: number | null = null;
  let pagedFetches = 0;
  let moverCalls = 0;
  let totalMoved = 0;
  let movesThisExecution = 0;
  let inheritedAtStart = 0;

  const persistedCount = (): number => {
    const recorded = (db.read(tenantReportPath(TENANT)) ?? {}).quarantinedCount;
    return typeof recorded === 'number' && Number.isFinite(recorded) ? recorded : 0;
  };

  /**
   * Req 7.3, sampled at the two instants an interruption can land.
   *
   * Read BEFORE the move it precedes, so every write the PREVIOUS move forced has
   * already landed — which makes `moved - persisted` the lag a resumption starting
   * at this instant would actually inherit.
   *
   * Recorded rather than asserted here: an `expect` throwing inside the mover would
   * be caught by `sweepTenant`'s own catch and recorded as a tenant failure, so the
   * assertion would vanish into the mechanism under test. The observations are
   * asserted after the executions instead.
   */
  const observeLag = (where: 'move' | 'page'): void => {
    lags.push({
      moved: inheritedAtStart + movesThisExecution,
      persisted: persistedCount(),
      where,
    });
  };

  const bucket = createFakeBucket({
    log,
    objects,
    failGetFiles: (call) => {
      if (call.maxResults === undefined) return undefined;
      pagedFetches += 1;
      if (armedPage !== null && pagedFetches === armedPage) {
        observeLag('page');
        return new Error('listing page failed');
      }
      return undefined;
    },
  });

  const baseMover = createTestQuarantineMover(log);
  const mover = async (args: {
    bucket: unknown;
    tenantId: string;
    sweepId: string;
    objectPath: string;
    bytes: number | null;
  }) => {
    moverCalls += 1;
    observeLag('move');
    if (armedMove !== null && moverCalls === armedMove) {
      throw new Error('quarantine move crashed');
    }
    const outcome = await baseMover(args);
    if (outcome.ok) {
      totalMoved += 1;
      movesThisExecution += 1;
    }
    return outcome;
  };

  const execute = async (arm: Arm) => {
    armedPage = arm.page ?? null;
    armedMove = arm.move ?? null;
    // Per EXECUTION, so an armed index names a page or a move of the execution it
    // was armed for, and so the lag is measured against what THIS execution knows.
    pagedFetches = 0;
    moverCalls = 0;
    movesThisExecution = 0;
    inheritedAtStart = persistedCount();
    return runStorageOrphanSweep({
      db: db as never,
      rtdb: createFakeRtdb({ log, tree: {} }) as never,
      bucket: bucket as never,
      config: config as never,
      quarantineObject: mover as never,
      // Frozen, so no time-driven write perturbs a generated cadence. The page
      // interval and the threshold are then the only things deciding a write.
      now: () => NOW,
    });
  };

  return {
    db,
    log,
    execute,
    lags,
    /** Every object this tenant moved, across every execution, in order. */
    moves: () => log.filter((entry) => entry.method === 'file.copy').map((entry) => entry.target),
    totalMoved: () => totalMoved,
  };
}

function ceilingConfig(overrides: Record<string, unknown>): Record<string, unknown> {
  return sweepConfig({
    mode: 'sweep',
    apply: true,
    sweepId: SWEEP_ID,
    nowMs: NOW,
    ...overrides,
  });
}

let consoleLog: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
});

describe('Property 6: the quarantine ceiling holds across batching, crashes and resumption', () => {
  it(
    'never moves more than ceiling + threshold - 1 across an interruption and its resumptions, and never more than the ceiling without one',
    async () => {
      /**
       * The vacuity guard (Req 11.25), asserted AFTER `fc.assert` returns because it
       * is a statement about the generated population rather than about any one
       * input. Five counters, because five different things could go quietly
       * unexercised and each would leave a green suite checking less than it claims:
       * an interruption that never fired, a schedule that never completed, a ceiling
       * that never bound, an overshoot that never happened (which would make the
       * `+ threshold - 1` tolerance untested slack), and the threshold-1 arm whose
       * whole point is that the tolerance collapses to zero.
       */
      const arms = {
        interrupted: 0,
        uninterrupted: 0,
        ceilingBound: 0,
        overshot: 0,
        thresholdOne: 0,
      };

      await fc.assert(
        fc.asyncProperty(
          // The ceiling an operator sets for a cautious apply run, and above.
          fc.integer({ min: 1, max: 50 }),
          // Candidates RELATIVE to the ceiling, negative through positive, so both
          // the region where the ceiling binds and the region where it never does
          // are explored. Generating the count independently of the ceiling is what
          // a first draft did, and it made the overshoot arm reachable roughly twice
          // in a hundred runs: an overshoot needs candidates left over AFTER the
          // ceiling, and two independent uniform draws put that region in the tail.
          fc.integer({ min: -8, max: 12 }),
          fc.constantFrom<Distribution>('clustered', 'onePerPage', 'tail'),
          fc.constantFrom(1, 2, 3, 5),
          // The report-write page interval, freely interleaving with the threshold.
          fc.integer({ min: 1, max: 12 }),
          // The Quarantine_Write_Threshold, over the whole 1–50 range. `1` and the
          // small values are drawn explicitly as well: `1` because the overshoot must
          // be exactly 0 there, and the small values because the overshoot is
          // `(m - 1) mod threshold`, which a uniform draw over 1–50 leaves at 0 for
          // most generated crash points.
          fc.oneof(
            fc.constant(1),
            fc.integer({ min: 2, max: 10 }),
            fc.integer({ min: 1, max: 50 })
          ),
          // Where the interruption lands: on a page fetch, or MID-PAGE on a mover
          // call — the latter being the only shape that separates a per-move
          // evaluation from a boundary-only one.
          fc.constantFrom<'page' | 'move'>('page', 'move'),
          // The interruption PAGE index, as a page count.
          fc.integer({ min: 1, max: 24 }),
          // The interruption MOVE index, as a percentage of the reachable move
          // range. Scaled rather than absolute, and the scaling is required: the
          // mover is called at most `ceiling` times, so an absolute index over a
          // fixed range would place nearly every generated crash beyond the reach of
          // a small ceiling and the property would explore only the uninterrupted
          // arm. The range runs slightly PAST the ceiling so an out-of-reach index
          // is still generated and still asserted.
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 1, max: 3 }),
          async (
            ceiling,
            candidateOffset,
            distribution,
            generatedPageSize,
            pageInterval,
            threshold,
            interruptionKind,
            interruptionPageIndex,
            interruptionMovePercent,
            resumptions
          ) => {
            const candidateCount = Math.max(1, Math.min(40, ceiling + candidateOffset));
            const interruptionIndex =
              interruptionKind === 'page'
                ? interruptionPageIndex
                : 1 + Math.floor((interruptionMovePercent * (ceiling + 4)) / 100);
            const pageSize = effectivePageSize(distribution, generatedPageSize);
            const objects = buildObjects(candidateCount, pageSize, distribution);
            const config = ceilingConfig({
              pageSize,
              maxQuarantinePerTenant: ceiling,
              reportWritePages: pageInterval,
              quarantineWriteThreshold: threshold,
            });
            if (threshold === 1) arms.thresholdOne += 1;

            // ── The uninterrupted arm: no tolerance applies at all ──────────────
            //
            // Run to completion, then resumed once, so "never exceeds the ceiling"
            // is asserted over the tenant's whole history rather than over one
            // process. A resumption of a ceiling-aborted run inherits the count and
            // must move nothing further.
            const clean = createWorld(objects, config);
            const cleanFirst = await clean.execute({});
            expect(cleanFirst.tenantFailures).toBe(0);
            await clean.execute({});
            expect(clean.totalMoved()).toBeLessThanOrEqual(ceiling);
            expect(clean.totalMoved()).toBe(Math.min(ceiling, candidateCount));

            // ── The interrupted arm ────────────────────────────────────────────
            const world = createWorld(objects, config);
            const first = await world.execute(
              interruptionKind === 'page'
                ? { page: interruptionIndex }
                : { move: interruptionIndex }
            );

            // Req 11.23: read off returned and recorded values, both of which exist
            // whether or not anything was thrown.
            const recorded = world.db.read(tenantReportPath(TENANT));
            expect(recorded).toBeDefined();
            const interrupted = first.tenants[0].status === 'failed';
            expect(first.tenantFailures).toBe(interrupted ? 1 : 0);

            // Req 11.24: no early return. Both branches assert.
            if (interrupted) {
              arms.interrupted += 1;
              expect(recorded!.status).toBe('failed');
              expect(typeof recorded!.lastError).toBe('string');
            } else {
              arms.uninterrupted += 1;
              // The armed index named a page or a move this fixture never reached,
              // so this execution is an uninterrupted one — a case to assert, not to
              // skip. Under no interruption the ceiling admits no tolerance.
              expect(['completed', 'aborted']).toContain(first.tenants[0].status);
              expect(world.totalMoved()).toBeLessThanOrEqual(ceiling);
            }

            // ── The sequential resumptions ────────────────────────────────────
            for (let attempt = 0; attempt < resumptions; attempt += 1) {
              const resumed = await world.execute({});
              expect(resumed.tenantFailures).toBe(0);
              if (resumed.tenants[0].abortReason === 'quarantine_cap_reached') {
                arms.ceilingBound += 1;
              }
            }

            const moves = world.moves();
            const total = moves.length;
            expect(total).toBe(world.totalMoved());

            // No object moved twice within one Sweep_Id.
            expect(new Set(moves).size).toBe(total);

            // Req 7.22 — the tenant's TOTAL, which is what an operator relies on
            // when they set the ceiling to 25 for a first apply run.
            expect(total).toBeLessThanOrEqual(ceiling + threshold - 1);
            // And no more objects than existed to move.
            expect(total).toBeLessThanOrEqual(candidateCount);

            // The bound TIGHTENS as the threshold falls, and is exactly 0 at 1.
            const overshoot = Math.max(0, total - ceiling);
            expect(overshoot).toBeLessThanOrEqual(threshold - 1);
            if (threshold === 1) expect(overshoot).toBe(0);
            if (overshoot > 0) arms.overshot += 1;

            // Req 7.3 — at every interruption point, and in fact at every instant an
            // interruption could have landed, the persisted count a resumption would
            // inherit lags the objects actually moved by FEWER than the threshold.
            expect(world.lags.length).toBeGreaterThan(0);
            for (const lag of world.lags) {
              expect(lag.moved - lag.persisted).toBeLessThan(threshold);
            }
          }
        ),
        { numRuns: 100 }
      );

      // Vacuity is a visible failure, not a silent pass (Req 11.25).
      expect(arms.interrupted).toBeGreaterThan(0);
      expect(arms.uninterrupted).toBeGreaterThan(0);
      expect(arms.ceilingBound).toBeGreaterThan(0);
      expect(arms.overshot).toBeGreaterThan(0);
      expect(arms.thresholdOne).toBeGreaterThan(0);
    },
    120_000
  );
});
