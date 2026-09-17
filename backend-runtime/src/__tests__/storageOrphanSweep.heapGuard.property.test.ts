// Feature: storage-sweep-scale-hardening, Property 10: The mid-collection heap guard needs both conditions, aborts cleanly, names the breach, and moves nothing
/**
 * **Validates: Requirements 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.16, 8.17, 8.18**
 *
 * *For any* admitted-reference count at which an injected heap reader crosses
 * **both** the Heap_Guard_Floor and `0.7 × heapLimitBytes`, and *for any* configured
 * ceiling:
 *
 *  - admission stops within `HEAP_GUARD_SAMPLE_INTERVAL` references of the crossing;
 *  - the tenant's run ends `abortReason: 'reference_cap_exceeded'` with
 *    `capBreach: 'memory_guard'`;
 *  - when the configured ceiling binds first instead, the same abort reason is
 *    returned with `capBreach: 'configured'`;
 *  - `SweepAbortReason` has exactly its five members in both cases;
 *  - zero objects are quarantined and no bucket mutator is invoked.
 *
 * ── The two regions where the guard must NOT trip are the point ───────────────
 *
 * Generating the *crossing* distinguishes a guard that is **checked** from one that
 * is merely present: a guard evaluated once before the loop passes every fixture
 * whose footprint is small at the start. Generating the **non**-crossing regions is
 * what distinguishes a guard that is **correct** from one that is merely present and
 * eager — because a guard reduced to `used > 0.7 × limit` passes every clause above,
 * and it aborts a healthy tenant on the day a container reports a limit nobody
 * expected:
 *
 *  - the **degenerate limit** — `used <= 128 MiB` while `used > 0.7 × limit`,
 *    generated down to and including `used = 1, limit = 1` (Req 8.18);
 *  - **above the fraction, beneath the floor** — the same region stated as the guard
 *    sees it, at realistic magnitudes rather than degenerate ones.
 *
 * Plus the two boundaries, generated explicitly because an inverted comparison hides
 * in exactly one of them: `used` exactly **at** the floor with `used > 0.7 × limit`
 * does not trip, and `used` exactly **at** `0.7 × limit` with `used > floor` does not
 * trip. `>` in both comparisons, so exactly-at either threshold **proceeds**.
 *
 * ── Every arm asserts the reader was CONSULTED ────────────────────────────────
 *
 * A non-tripping arm over a fixture too small to be sampled would be vacuously
 * green: "the guard did not trip" is free where the guard was never evaluated. The
 * heap is sampled once per `HEAP_GUARD_SAMPLE_INTERVAL` admitted references
 * (Req 8.7), so every fixture here is sized to be sampled at least once and the call
 * count is asserted rather than assumed.
 *
 * ── The fixture, and why it is one Firestore document ─────────────────────────
 *
 * Reaching a sample needs 10,000 admitted references. A `fees` document carries a
 * `receipts` ARRAY and every entry's `storagePath` is offered as a bare path, so one
 * document admits as many references as it has entries — 10,000 admissions through
 * one page of one collection rather than 10,000 documents through ten pages. The
 * arrays are built once at module load and shared by every generated run, because
 * this property generates the heap READING and the ceiling, not the fixture.
 */

import * as fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  runStorageOrphanSweep,
  tenantReportPath,
  type SweepAbortReason,
} from '../jobs/storageOrphanSweep';
import {
  DEFAULT_HEAP_GUARD_FRACTION,
  HEAP_GUARD_FLOOR_BYTES,
  HEAP_GUARD_SAMPLE_INTERVAL,
  exceedsHeapGuard,
} from '../lib/sweepScaleLimits';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  createTestQuarantineMover,
  iso,
  sweepConfig,
  type DocData,
  type FakeObject,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 120 * DAY);
const SWEEP_ID = 'sweep_heap_guard_property';

/** A ceiling no generated fixture here can reach, so only the heap guard can bind. */
const CEILING_OUT_OF_REACH = 1_000_000;

/**
 * The crossing arm's fixture size: two full sample intervals, so a generated
 * crossing count anywhere in `[1, 2 × SAMPLE]` has a reachable sample at or after
 * it. The non-tripping arms need only one interval, and pay for a full collection —
 * sort, fingerprint and the whole listing — on every generated run, so they get the
 * smaller one.
 */
const CROSSING_REFERENCES = 2 * HEAP_GUARD_SAMPLE_INTERVAL;
const COMPLETING_REFERENCES = HEAP_GUARD_SAMPLE_INTERVAL;

/**
 * The five abort reasons, as a RUNTIME list (Req 8.10).
 *
 * `SweepAbortReason` is a type union with no runtime counterpart, and a compile-time
 * exhaustiveness assertion would prove nothing in a test file: `backend-runtime`'s
 * `tsconfig.json` excludes `**​/*.test.ts` from `tsc --noEmit`, and the ts-jest
 * transform runs with `diagnostics: false`, so a `@ts-expect-error` or a
 * `type _ = AssertNever<…>` here is never checked in either direction. So the claim
 * is asserted twice over instead, both times at runtime: every abort reason any
 * generated run produces is a member of this list, and the union's DECLARATION in
 * the source is parsed and counted below.
 */
const ABORT_REASONS = [
  'reference_source_failed',
  'malformed_reference',
  'reference_cap_exceeded',
  'quarantine_cap_reached',
  'tenant_scope_violation',
] as const;

/** One aged, unreferenced object, so "quarantined nothing" is a claim about a run that would have moved something. */
function agedOrphans(count: number): FakeObject[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `notices/${TENANT}/notice_k_${index}.png`,
    size: 100 + index,
    timeCreated: OLD,
    updated: OLD,
  }));
}

/**
 * One `fees` document whose `receipts` array admits exactly `count` references.
 *
 * `storagePath` rather than `url`, because `offer(storagePath, 'fees', true)` takes
 * the bare-path branch of the Path_Mapper: the cheapest admission this collector has,
 * and the one that keeps the cost of 10,000 admissions in the Path_Mapper rather than
 * in URL parsing.
 */
function feesFixture(count: number): Record<string, Record<string, DocData>> {
  const receipts = Array.from({ length: count }, (_, index) => ({
    url: null,
    storagePath: `receipts/${TENANT}/fee_${String(index).padStart(6, '0')}/k_r.pdf`,
  }));
  return { fees: { fee_bulk: { tenantId: TENANT, receipts } } };
}

// Built ONCE and shared by every generated run: this property generates the heap
// reading and the ceiling, and a per-run rebuild of 20,000 receipt entries would be
// the dominant cost of the suite for no added coverage.
const CROSSING_COLLECTIONS = feesFixture(CROSSING_REFERENCES);
const COMPLETING_COLLECTIONS = feesFixture(COMPLETING_REFERENCES);

interface HeapReader {
  read: () => { usedBytes: number; limitBytes: number };
  /** How many times the collector actually sampled (Req 8.7). */
  calls: () => number;
}

/**
 * A reader modelling a heap that grows **with admissions** and crosses both
 * thresholds at admitted-reference count `crossingAt`.
 *
 * The collector calls this once per `HEAP_GUARD_SAMPLE_INTERVAL` admissions, so call
 * `n` observes admission `n × SAMPLE`. "Crosses at `crossingAt`" is therefore
 * modelled as: report a safe reading while `n × SAMPLE < crossingAt`, and a reading
 * above **both** the floor and the fraction from the first sample at or after it. The
 * guard can only ever observe at a sample point, which is exactly why the property is
 * "stops **within** `HEAP_GUARD_SAMPLE_INTERVAL` references of the crossing" rather
 * than "stops at it".
 */
function growingHeapReader(crossingAt: number, limitBytes: number): HeapReader {
  let calls = 0;
  const crossed = Math.max(
    HEAP_GUARD_FLOOR_BYTES + 1,
    Math.ceil(DEFAULT_HEAP_GUARD_FRACTION * limitBytes) + 1
  );
  // Beneath the floor AND beneath the fraction: safe on both counts, so a run that
  // never reaches the crossing cannot trip on the pre-crossing readings either.
  const safe = Math.min(
    Math.floor(HEAP_GUARD_FLOOR_BYTES / 2),
    Math.floor(DEFAULT_HEAP_GUARD_FRACTION * limitBytes) - 1
  );
  return {
    read: () => {
      calls += 1;
      const admitted = calls * HEAP_GUARD_SAMPLE_INTERVAL;
      return { usedBytes: admitted >= crossingAt ? crossed : safe, limitBytes };
    },
    calls: () => calls,
  };
}

/** A reader that reports the same reading at every sample. */
function constantHeapReader(usedBytes: number, limitBytes: number): HeapReader {
  let calls = 0;
  return {
    read: () => {
      calls += 1;
      return { usedBytes, limitBytes };
    },
    calls: () => calls,
  };
}

interface RunOutcome {
  status: string;
  abortReason: SweepAbortReason | undefined;
  capBreach: 'configured' | 'memory_guard' | undefined;
  referenceCount: number;
  objectsScanned: number;
  quarantinedCount: number;
  report: DocData | undefined;
  log: OperationLog;
  listingCalls: number;
}

/**
 * One apply-mode run with a real mover installed.
 *
 * APPLY mode deliberately: "zero objects are quarantined" (Req 8.12) is only a claim
 * about a run that was **able** to move something. In report mode it would be true of
 * every run for a reason that has nothing to do with the heap guard.
 */
async function runWithReader(args: {
  collections: Record<string, Record<string, DocData>>;
  reader: HeapReader;
  maxReferences: number;
  orphanCount?: number;
}): Promise<RunOutcome> {
  const log = createOperationLog();
  const db = createFakeFirestore({ log, collections: args.collections });
  const objects = agedOrphans(args.orphanCount ?? 2);
  const bucket = createFakeBucket({ log, objects });

  const result = await runStorageOrphanSweep({
    db: db as never,
    rtdb: createFakeRtdb({ log, tree: {} }) as never,
    bucket: bucket as never,
    config: sweepConfig({
      mode: 'sweep',
      apply: true,
      sweepId: SWEEP_ID,
      nowMs: NOW,
      maxReferences: args.maxReferences,
      maxQuarantinePerTenant: 10_000,
    }) as never,
    quarantineObject: createTestQuarantineMover(log) as never,
    readHeapUsage: args.reader.read,
    now: () => NOW,
  });

  const tenant = result.tenants[0];
  return {
    status: tenant.status,
    abortReason: tenant.abortReason,
    capBreach: tenant.capBreach,
    referenceCount: Number((db.read(tenantReportPath(TENANT)) ?? {}).referenceCount ?? 0),
    objectsScanned: tenant.objectsScanned,
    quarantinedCount: tenant.quarantinedCount,
    report: db.read(tenantReportPath(TENANT)),
    log,
    listingCalls: bucket.getFilesCalls.filter((call) => call.maxResults !== undefined).length,
  };
}

/** Every bucket mutator the run attempted. Empty is what Req 8.12 asks for. */
function bucketMutations(log: OperationLog): string[] {
  return log
    .writes()
    .filter((entry) => entry.store === 'bucket')
    .map((entry) => `${entry.method} ${entry.target}`);
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

describe('Property 10: the mid-collection heap guard', () => {
  it(
    'stops within one sample of the crossing, names the breach, and moves nothing',
    async () => {
      /**
       * Both arms must be reached. The generator can in principle produce only one of
       * them, and a property that explored only the memory-guard arm would say nothing
       * about `capBreach: 'configured'` while looking complete.
       */
      const arms = { memoryGuard: 0, configured: 0 };

      await fc.assert(
        fc.asyncProperty(
          // WHERE the heap crosses both thresholds, in admitted references. Generated
          // freely rather than in multiples of the sample interval, so "within
          // HEAP_GUARD_SAMPLE_INTERVAL of the crossing" is a real bound and not a
          // restatement of where the sample happens to fall.
          fc.integer({ min: 1, max: CROSSING_REFERENCES }),
          // The Heap_Limit the reader reports. Realistic magnitudes, so the fraction is
          // well above the floor and the crossing is a genuine two-condition crossing.
          fc.integer({ min: 512, max: 4096 }).map((mib) => mib * 1024 * 1024),
          // The configured ceiling, so EITHER limit may bind first: out of reach, or
          // low enough to bind before the crossing's sample.
          fc.oneof(
            fc.constant(CEILING_OUT_OF_REACH),
            fc.integer({ min: 100, max: CROSSING_REFERENCES - 1 })
          ),
          async (crossingAt, limitBytes, maxReferences) => {
            const reader = growingHeapReader(crossingAt, limitBytes);
            const outcome = await runWithReader({
              collections: CROSSING_COLLECTIONS,
              reader,
              maxReferences,
            });

            // The sample the guard would trip on, derived from the model rather than
            // from the implementation: the first sample at or after the crossing.
            const tripAdmission =
              Math.ceil(crossingAt / HEAP_GUARD_SAMPLE_INTERVAL) * HEAP_GUARD_SAMPLE_INTERVAL;
            // The configured ceiling is evaluated FIRST and after every insertion
            // (Req 8.16), so it binds at admission `ceiling + 1` — and wins a tie,
            // because it is the `if` and the heap sample is the `else if`.
            const configuredBindsAt = maxReferences + 1;
            const configuredBindsFirst = configuredBindsAt <= tripAdmission;

            // Both breaches abort the same way, which is precisely why `capBreach`
            // exists and why `SweepAbortReason` did not need a sixth value (Req 8.10).
            expect(outcome.status).toBe('aborted');
            expect(outcome.abortReason).toBe('reference_cap_exceeded');
            expect(ABORT_REASONS).toContain(outcome.abortReason);

            if (configuredBindsFirst) {
              arms.configured += 1;
              // Req 8.16: unchanged from the shipped behaviour — only the label is new.
              expect(outcome.capBreach).toBe('configured');
              expect(outcome.referenceCount).toBe(configuredBindsAt);
            } else {
              arms.memoryGuard += 1;
              // Req 8.8, 8.9.
              expect(outcome.capBreach).toBe('memory_guard');
              // Req 8.7: the guard was CHECKED, not merely present.
              expect(reader.calls()).toBeGreaterThanOrEqual(1);
              // Admission stopped at the first sample at or after the crossing, so it
              // stopped within one sample interval of it — the overshoot the design
              // bounds at `10,000 × 232 B ≈ 2.3 MB`.
              expect(outcome.referenceCount).toBe(tripAdmission);
              expect(outcome.referenceCount).toBeGreaterThanOrEqual(crossingAt);
              expect(outcome.referenceCount - crossingAt).toBeLessThan(HEAP_GUARD_SAMPLE_INTERVAL);
            }

            // Req 8.12 — zero objects quarantined and no bucket mutator invoked, for
            // BOTH breach kinds, because the gate in `sweepTenant` precedes any
            // listing. The listing call count is asserted too: "moved nothing" would
            // also hold of a run that listed everything and decided to move nothing.
            expect(outcome.quarantinedCount).toBe(0);
            expect(outcome.objectsScanned).toBe(0);
            expect(outcome.listingCalls).toBe(0);
            expect(bucketMutations(outcome.log)).toEqual([]);

            // Req 8.13 — the report states what was compared, on the abort path too.
            const params = (outcome.report ?? {}).params as Record<string, unknown>;
            expect(params.maxReferences).toBe(maxReferences);
            expect(typeof params.footprintEstimateBytes).toBe('number');
            expect(outcome.report?.capBreach).toBe(outcome.capBreach);
          }
        ),
        { numRuns: 100 }
      );

      expect(arms.memoryGuard).toBeGreaterThan(0);
      expect(arms.configured).toBeGreaterThan(0);
    },
    240_000
  );

  /**
   * The clause a fraction-only implementation fails, and the whole reason the floor
   * exists (Reqs 8.17, 8.18).
   *
   * One byte used of a one-byte reported limit satisfies `used > 0.7 × limit`, so a
   * guard without the floor aborts a tenant holding a handful of references — and it
   * does so on the reading a *misreporting* environment produces, which is precisely
   * the environment an operator is least able to diagnose from an abort. A mechanism
   * whose whole purpose is to convert an unexplained kill into an explained abort must
   * not manufacture explained aborts out of nothing.
   */
  it(
    'does not trip on a degenerate limit, however small, and collection runs to completion',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // The degenerate region, generated down to and INCLUDING `used = 1, limit = 1`.
          fc
            .integer({ min: 1, max: HEAP_GUARD_FLOOR_BYTES })
            .chain((usedBytes) =>
              fc.record({
                usedBytes: fc.constant(usedBytes),
                // Any limit small enough that `used > 0.7 × limit`: the fraction is
                // breached and only the floor is holding the guard back.
                limitBytes: fc.integer({
                  min: 1,
                  max: Math.max(1, Math.floor(usedBytes / DEFAULT_HEAP_GUARD_FRACTION) - 1),
                }),
              })
            ),
          async ({ usedBytes, limitBytes }) => {
            // The generated region is the one claimed: above the fraction, at or
            // beneath the floor. Asserted so a generator drift cannot quietly move the
            // arm somewhere the claim is trivial.
            expect(usedBytes).toBeGreaterThan(DEFAULT_HEAP_GUARD_FRACTION * limitBytes);
            expect(usedBytes).toBeLessThanOrEqual(HEAP_GUARD_FLOOR_BYTES);
            // The pure predicate agrees, which is what ties this arm to Req 8.18's own
            // wording rather than only to the collector's behaviour.
            expect(exceedsHeapGuard(usedBytes, limitBytes)).toBe(false);

            const reader = constantHeapReader(usedBytes, limitBytes);
            const outcome = await runWithReader({
              collections: COMPLETING_COLLECTIONS,
              reader,
              maxReferences: CEILING_OUT_OF_REACH,
            });

            // Not vacuous: the guard WAS evaluated and declined to trip.
            expect(reader.calls()).toBeGreaterThanOrEqual(1);
            expect(outcome.capBreach).toBeUndefined();
            expect(outcome.abortReason).toBeUndefined();
            // Collection ran to completion — every reference admitted — and the tenant
            // was swept normally rather than aborted before its listing.
            expect(outcome.referenceCount).toBe(COMPLETING_REFERENCES);
            expect(outcome.status).toBe('completed');
            expect(outcome.listingCalls).toBeGreaterThan(0);
            expect(outcome.objectsScanned).toBe(2);
          }
        ),
        { numRuns: 100 }
      );
    },
    240_000
  );

  /**
   * The same region at realistic magnitudes — above the fraction, beneath the floor —
   * stated as the guard sees it rather than as a degenerate reading. A container
   * reporting a 150 MB limit while holding 100 MB is not a memory problem this guard
   * exists to catch, and aborting it would be manufacturing an incident.
   */
  it(
    'does not trip above the fraction while beneath the floor at realistic magnitudes',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc
            .integer({ min: 8 * 1024 * 1024, max: HEAP_GUARD_FLOOR_BYTES })
            .chain((usedBytes) =>
              fc.record({
                usedBytes: fc.constant(usedBytes),
                limitBytes: fc.integer({
                  min: Math.floor(usedBytes / 0.95),
                  max: Math.max(
                    Math.floor(usedBytes / 0.95),
                    Math.floor(usedBytes / DEFAULT_HEAP_GUARD_FRACTION) - 1
                  ),
                }),
              })
            ),
          async ({ usedBytes, limitBytes }) => {
            expect(usedBytes).toBeGreaterThan(DEFAULT_HEAP_GUARD_FRACTION * limitBytes);
            expect(usedBytes).toBeLessThanOrEqual(HEAP_GUARD_FLOOR_BYTES);
            expect(exceedsHeapGuard(usedBytes, limitBytes)).toBe(false);

            const reader = constantHeapReader(usedBytes, limitBytes);
            const outcome = await runWithReader({
              collections: COMPLETING_COLLECTIONS,
              reader,
              maxReferences: CEILING_OUT_OF_REACH,
            });

            expect(reader.calls()).toBeGreaterThanOrEqual(1);
            expect(outcome.capBreach).toBeUndefined();
            expect(outcome.status).toBe('completed');
            expect(outcome.referenceCount).toBe(COMPLETING_REFERENCES);
          }
        ),
        { numRuns: 100 }
      );
    },
    240_000
  );

  /**
   * The two boundaries, generated explicitly because an inverted comparison hides in
   * exactly one of them and passes every non-boundary case.
   *
   * `>` in BOTH conditions, so a reading exactly at either threshold **proceeds** —
   * which is Req 8.18's "at or below … SHALL continue collecting" read literally.
   */
  it(
    'proceeds at exactly the floor and at exactly the fraction',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<'at_floor' | 'at_fraction'>('at_floor', 'at_fraction'),
          fc.integer({ min: 256, max: 4096 }).map((mib) => mib * 1024 * 1024),
          async (boundary, limitBytes) => {
            const guardBytes = DEFAULT_HEAP_GUARD_FRACTION * limitBytes;
            const usedBytes =
              boundary === 'at_floor'
                ? // Exactly at the floor, with the fraction already breached: only the
                  // floor's `>` is under test.
                  HEAP_GUARD_FLOOR_BYTES
                : // Exactly at the fraction, with the floor already exceeded: only the
                  // fraction's `>` is under test.
                  guardBytes;

            if (boundary === 'at_floor') {
              // The fixture's limit is large, so put the fraction beneath the floor for
              // this arm by shrinking the limit rather than the reading.
              const smallLimit = Math.floor(HEAP_GUARD_FLOOR_BYTES / 0.8);
              expect(usedBytes).toBeGreaterThan(DEFAULT_HEAP_GUARD_FRACTION * smallLimit);
              expect(exceedsHeapGuard(usedBytes, smallLimit)).toBe(false);
              const reader = constantHeapReader(usedBytes, smallLimit);
              const outcome = await runWithReader({
                collections: COMPLETING_COLLECTIONS,
                reader,
                maxReferences: CEILING_OUT_OF_REACH,
              });
              expect(reader.calls()).toBeGreaterThanOrEqual(1);
              expect(outcome.capBreach).toBeUndefined();
              expect(outcome.status).toBe('completed');
              return;
            }

            expect(usedBytes).toBeGreaterThan(HEAP_GUARD_FLOOR_BYTES);
            expect(exceedsHeapGuard(usedBytes, limitBytes)).toBe(false);
            const reader = constantHeapReader(usedBytes, limitBytes);
            const outcome = await runWithReader({
              collections: COMPLETING_COLLECTIONS,
              reader,
              maxReferences: CEILING_OUT_OF_REACH,
            });
            expect(reader.calls()).toBeGreaterThanOrEqual(1);
            expect(outcome.capBreach).toBeUndefined();
            expect(outcome.status).toBe('completed');
            // One byte over the fraction, with the floor already exceeded, DOES trip —
            // so the boundary above is the boundary and not a dead guard.
            expect(exceedsHeapGuard(usedBytes + 1, limitBytes)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    },
    240_000
  );
});

/**
 * Req 8.10 as a claim about the DECLARATION, not only about what ran.
 *
 * A sixth `SweepAbortReason` value would invalidate every existing metric label
 * value, the `infra/monitoring/` log-based metric filters and the alert policy that
 * matches on them — machines outside this repository, which a deploy cannot update
 * transactionally. The configured-versus-memory distinction therefore rides on
 * `capBreach`, and this is the assertion that keeps it there.
 *
 * The union is parsed out of the source because a type-level assertion is unchecked
 * in a test file here — see `ABORT_REASONS` above for why.
 */
describe('SweepAbortReason has exactly five members (Req 8.10)', () => {
  it('declares the five the metric labels and monitoring filters already carry', () => {
    const source = readFileSync(resolve(__dirname, '../jobs/storageOrphanSweep.ts'), 'utf8');

    /** The string literals of one `export type X = …;` declaration, in source order. */
    const literalsOf = (name: string): string[] => {
      const declaration = new RegExp(`export type ${name} =([\\s\\S]*?);`).exec(source);
      expect(declaration).not.toBeNull();
      return [...declaration![1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    };

    // `SweepAbortReason` is composed rather than flat — the three Phase 1 reasons
    // widened with the two that can only arise in Phase 2 — so BOTH declarations are
    // parsed and the composition is asserted. Reading only the outer one would have
    // seen two literals and passed a length check for the wrong reason.
    const phaseOne = literalsOf('ReferenceAbortReason');
    const outer = literalsOf('SweepAbortReason');
    expect(/export type SweepAbortReason =[\s\S]*?ReferenceAbortReason/.test(source)).toBe(true);

    expect(phaseOne).toEqual([
      'reference_source_failed',
      'malformed_reference',
      'reference_cap_exceeded',
    ]);
    expect(outer).toEqual(['tenant_scope_violation', 'quarantine_cap_reached']);
    expect(new Set([...phaseOne, ...outer])).toEqual(new Set(ABORT_REASONS));
    expect(phaseOne.length + outer.length).toBe(5);
  });
});
