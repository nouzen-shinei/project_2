// Feature: storage-sweep-scale-hardening, Property 8: Batched resumption preserves the examined union
/**
 * Property 8: Batched resumption preserves the examined union
 * **Validates: Requirements 7.6, 7.7, 7.10, 7.24**
 *
 * *For any* interruption page index, *any* report-write page interval, *any*
 * Quarantine_Write_Threshold, *any* page size and *any* listing order:
 *
 *  - the union of objects examined across the interrupted run and its resumption
 *    equals the set an uninterrupted run over the same fixture examines, and no
 *    object is skipped (Reqs 7.6, 7.7);
 *  - the per-page invariant check is evaluated **once per page**, regardless of
 *    whether that page wrote the Report_Document (Req 7.10), counted through an
 *    injected spy;
 *  - a **mid-page** threshold write persists an **UNADVANCED** cursor — the token
 *    the page in flight was fetched with, i.e. the token for the last fully
 *    completed page (Req 7.24).
 *
 * This is the parent's Property 7 re-asserted under batching, and batching is
 * precisely what could break it: a correct write cadence that advances the cursor
 * one page early satisfies Property 7 and skips an object. Generating the interval
 * as well as the interruption point separates the two failure modes; generating the
 * threshold is what covers the mid-page write, which is the one write in this design
 * that persists while a page is only partly examined.
 *
 * ── This property is the one most at risk of going vacuous ────────────────────
 *
 * And the reason is specific: its subject **is** the interruption that Requirement 1
 * converts from a throw into a recorded result. A `try`/`catch`-gated version of it
 * would go green on exactly the change it exists to check — the catch would never
 * fire, the precondition would never hold, and 100 generated schedules would assert
 * nothing while the suite stayed green. So, following the three parts of the same
 * fix applied to `storageOrphanSweep.resumability.property.test.ts`:
 *
 *  1. the interruption is established from the **recorded Report_Document `status`
 *     and the run result's `tenantFailures`** — returned and recorded values, which
 *     exist whether or not anything was thrown (Reqs 11.23, 11.26);
 *  2. there is **no early return**: a schedule whose interruption index this fixture
 *     never reaches is asserted as an *uninterrupted* run (Req 11.24);
 *  3. a **vacuity guard** counts the schedules reaching each arm and fails if any was
 *     reached zero times, asserted after `fc.assert` returns (Req 11.25).
 *
 * ── Why the invariant check needs an injected spy ─────────────────────────────
 *
 * Req 7.10 is a claim about a COUNT — once per page, independently of the write
 * interval — and the check is silent unless it throws, so there is no outcome to
 * read it off. `sweepTenant` resolves the module-local declaration, which a spy on
 * the module's export never sees, so `SweepTenantArgs.assertInvariants` exists as
 * the seam. The spy delegates to the real `assertSweepInvariants`, which is what
 * keeps the count honest about the check that actually ran.
 */

import * as fc from 'fast-check';

import { STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';
import {
  assertSweepInvariants,
  runStorageOrphanSweep,
  tenantReportPath,
} from '../jobs/storageOrphanSweep';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  createTestQuarantineMover,
  downloadUrl,
  iso,
  sweepConfig,
  type DocData,
  type FakeObject,
  type Operation,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 120 * DAY);
const FRESH = iso(NOW - 2 * DAY);
const SWEEP_ID = 'sweep_batched_resume_property';

/**
 * One Managed_Category prefix, so a generated page index names a page of ONE
 * listing and a mid-page write is a statement about a cursor inside it. Six
 * prefixes would put a prefix-completed write (Req 7.4) between most pages and the
 * interval would stop being the thing under test.
 */
const CATEGORY = 'notices';
const PREFIX_INDEX = STORAGE_TENANT_CATEGORIES.indexOf(CATEGORY);

interface Fixture {
  objects: FakeObject[];
  collections: Record<string, Record<string, DocData>>;
  /** The generated listing order: every object name, permuted. */
  order: string[];
}

/**
 * `objectCount` objects in one prefix, every `orphanEvery`-th one an aged
 * candidate and the rest inside the grace window, plus one genuinely referenced
 * object so the Reference_Fingerprint the resume is checked against is not the
 * fingerprint of an empty set.
 */
function buildFixture(objectCount: number, orphanEvery: number, order: number[]): Fixture {
  const objects: FakeObject[] = [];
  for (let index = 0; index < objectCount; index += 1) {
    const candidate = index % orphanEvery === 0;
    const stamp = candidate ? OLD : FRESH;
    objects.push({
      name: `${CATEGORY}/${TENANT}/obj_${String(index).padStart(3, '0')}.bin`,
      size: 10 + index,
      timeCreated: stamp,
      updated: stamp,
    });
  }
  // Aged AND referenced: retained by reference rather than by grace, so the retain
  // set is non-empty and the fingerprint is a real one.
  const referenced = `${CATEGORY}/${TENANT}/obj_referenced.bin`;
  objects.push({ name: referenced, size: 5, timeCreated: OLD, updated: OLD });

  return {
    objects,
    collections: { notices: { notice_live: { tenantId: TENANT, imageUrl: downloadUrl(referenced) } } },
    // The referenced object is appended last so the generated permutation covers
    // the candidates, which are what an ordering can reorder the moves of.
    order: [...order.map((index) => objects[index].name), referenced],
  };
}

/** Object names returned by the PAGED listing calls: the objects a run examined. */
function examinedNames(log: OperationLog, from = 0): string[] {
  const names: string[] = [];
  for (const entry of log.entries.slice(from)) {
    if (entry.method !== 'getFiles.page' || entry.detail?.maxResults === null) continue;
    for (const name of (entry.detail?.names ?? []) as string[]) names.push(name);
  }
  return names;
}

/** Successfully fetched pages of the paged listing, i.e. the pages that were examined. */
function fetchedPages(log: OperationLog, from = 0): Operation[] {
  return log.entries
    .slice(from)
    .filter((entry) => entry.method === 'getFiles.page' && entry.detail?.maxResults !== null);
}

/** One captured Report_Document write, and where in the log it landed. */
interface CapturedWrite {
  data: DocData;
  logIndex: number;
}

/**
 * A `doc()` decorator over the harness's Firestore that captures what each
 * Report_Document write CARRIED.
 *
 * The operation log records that a write happened, not its payload, and Req 7.24 is
 * a claim about the payload — the cursor a mid-page write persists. Decorating in
 * the test rather than extending the harness keeps every other suite reading the
 * fake it already reads.
 */
function captureReportWrites(
  db: ReturnType<typeof createFakeFirestore>,
  log: OperationLog,
  captured: CapturedWrite[]
): ReturnType<typeof createFakeFirestore> {
  const reportPath = tenantReportPath(TENANT);
  return {
    ...db,
    doc: (path: string) => {
      const handle = db.doc(path) as Record<string, unknown> & {
        set(data: DocData, options?: { merge?: boolean }): Promise<void>;
      };
      if (path !== reportPath) return handle;
      return {
        ...handle,
        async set(data: DocData, options?: { merge?: boolean }) {
          // The log index BEFORE the write is appended, so it is the position the
          // write was issued from — which is what places it inside or after a page.
          captured.push({ data, logIndex: log.entries.length });
          await handle.set(data, options);
        },
      };
    },
  } as ReturnType<typeof createFakeFirestore>;
}

interface WriteClassification {
  /** True when the page in flight had not finished being examined. */
  midPage: boolean;
  /** The `pageToken` the page in flight was FETCHED with. */
  fetchToken: string | null;
  /** The `pageToken` this write persisted. */
  writeToken: string | null;
}

/**
 * Classify one captured write as mid-page or at a boundary, from observables alone.
 *
 * At a page boundary `objectsScanned` equals the number of objects every
 * successfully fetched page has returned so far; mid-page it is strictly fewer,
 * because the page in flight has objects still to examine. Both counts are over the
 * same objects, so the comparison needs no knowledge of the fixture.
 *
 * `inheritedScanned` is what the execution started from — `0` for the fresh
 * execution this is applied to.
 */
function classifyWrite(
  write: CapturedWrite,
  log: OperationLog,
  inheritedScanned: number
): WriteClassification {
  let fetched = 0;
  let fetchToken: string | null = null;
  for (const entry of log.entries.slice(0, write.logIndex)) {
    if (entry.method === 'getFiles' && entry.detail?.maxResults !== null) {
      fetchToken = (entry.detail?.pageToken as string | null) ?? null;
    }
    if (entry.method === 'getFiles.page' && entry.detail?.maxResults !== null) {
      fetched += ((entry.detail?.names ?? []) as string[]).length;
    }
  }
  const scanned = Number(write.data.objectsScanned ?? 0) - inheritedScanned;
  const resume = write.data.resume as { pageToken?: unknown } | null;
  return {
    midPage: scanned < fetched,
    fetchToken,
    writeToken:
      resume && typeof resume.pageToken === 'string' && resume.pageToken ? resume.pageToken : null,
  };
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

describe('Property 8: batched resumption preserves the examined union', () => {
  it(
    'skips no object across a batched interruption, evaluates the invariant once per page, and persists an unadvanced cursor mid-page',
    async () => {
      /**
       * The vacuity guard (Req 11.25). `interrupted` and `uninterrupted` are the two
       * arms; the other three are the shapes this property exists for, each of which
       * could go unexercised and leave a green suite checking less than it claims: a
       * page that was examined without writing (Req 7.10's "regardless of whether
       * that page wrote"), a write issued mid-page (Req 7.24), and a mid-page write
       * followed by the crash that makes its cursor matter.
       *
       * A guard that cannot fail is not a guard: force `failGetFiles` and the mover
       * never to fire and `interrupted` must go to `0` and this test must FAIL.
       */
      const arms = {
        interrupted: 0,
        uninterrupted: 0,
        silentPage: 0,
        midPageWrite: 0,
        midPageWriteThenCrash: 0,
        advancedBoundaryWrite: 0,
      };

      await fc.assert(
        fc.asyncProperty(
          fc
            .record({
              objectCount: fc.integer({ min: 4, max: 18 }),
              orphanEvery: fc.integer({ min: 1, max: 3 }),
            })
            .chain((shape) =>
              fc.record({
                objectCount: fc.constant(shape.objectCount),
                orphanEvery: fc.constant(shape.orphanEvery),
                // The generated listing order: a full permutation, so the property is
                // asserted against orders the sweep did not choose.
                order: fc.shuffledSubarray(
                  Array.from({ length: shape.objectCount }, (_, index) => index),
                  { minLength: shape.objectCount, maxLength: shape.objectCount }
                ),
              })
            ),
          fc.integer({ min: 1, max: 6 }),
          // The report-write page interval. `1` reproduces the shipped
          // one-write-per-page cadence; the larger values are the batched one.
          fc.integer({ min: 1, max: 8 }),
          // The Quarantine_Write_Threshold, small so a page can contain more than one
          // threshold's worth of moves and a MID-PAGE write is reachable.
          fc.integer({ min: 1, max: 4 }),
          // Where the interruption lands: fetching a page, or MID-PAGE on a mover
          // call — the latter being the interruption point this property adds to the
          // parent's, because it is the only one that can land after a threshold
          // write while a page is only partly examined.
          fc.constantFrom<'page' | 'move'>('page', 'move'),
          fc.integer({ min: 1, max: 12 }),
          async (fixtureShape, pageSize, pageInterval, threshold, interruptionKind, interruptionIndex) => {
            const fixture = buildFixture(
              fixtureShape.objectCount,
              fixtureShape.orphanEvery,
              fixtureShape.order
            );
            const config = sweepConfig({
              mode: 'sweep',
              apply: true,
              sweepId: SWEEP_ID,
              nowMs: NOW,
              pageSize,
              reportWritePages: pageInterval,
              quarantineWriteThreshold: threshold,
              // High enough that the ceiling never binds: this property is about the
              // examined union, and a ceiling abort would stop the listing for a
              // reason Property 6 owns.
              maxQuarantinePerTenant: 10_000,
            });

            // ── The uninterrupted baseline, over the same fixture ───────────────
            const baselineLog = createOperationLog();
            const baselineDb = createFakeFirestore({
              log: baselineLog,
              collections: fixture.collections,
            });
            let baselineInvariants = 0;
            const baseline = await runStorageOrphanSweep({
              db: baselineDb as never,
              rtdb: createFakeRtdb({ log: baselineLog, tree: {} }) as never,
              bucket: createFakeBucket({
                log: baselineLog,
                objects: fixture.objects,
                order: fixture.order,
              }) as never,
              config: config as never,
              quarantineObject: createTestQuarantineMover(baselineLog) as never,
              now: () => NOW,
              assertInvariants: (...args) => {
                baselineInvariants += 1;
                return assertSweepInvariants(...args);
              },
            });
            expect(baseline.tenants[0].status).toBe('completed');
            const baselineExamined = [...new Set(examinedNames(baselineLog))].sort();
            // Req 7.10 on a run with no interruption at all: once per page, whatever
            // the interval did.
            expect(baselineInvariants).toBe(fetchedPages(baselineLog).length);

            // ── The interrupted run ────────────────────────────────────────────
            const log = createOperationLog();
            const rawDb = createFakeFirestore({ log, collections: fixture.collections });
            const captured: CapturedWrite[] = [];
            const db = captureReportWrites(rawDb, log, captured);

            let pagedFetches = 0;
            let moverCalls = 0;
            let crashedOnMove = false;
            const bucket = createFakeBucket({
              log,
              objects: fixture.objects,
              order: fixture.order,
              failGetFiles: (call) => {
                if (call.maxResults === undefined) return undefined;
                pagedFetches += 1;
                return interruptionKind === 'page' && pagedFetches === interruptionIndex
                  ? new Error('listing page failed')
                  : undefined;
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
              if (interruptionKind === 'move' && moverCalls === interruptionIndex) {
                crashedOnMove = true;
                throw new Error('quarantine move crashed');
              }
              return baseMover(args);
            };

            let invariantCalls = 0;
            const firstRun = await runStorageOrphanSweep({
              db: db as never,
              rtdb: createFakeRtdb({ log, tree: {} }) as never,
              bucket: bucket as never,
              config: config as never,
              quarantineObject: mover as never,
              now: () => NOW,
              assertInvariants: (...args) => {
                invariantCalls += 1;
                return assertSweepInvariants(...args);
              },
            });

            // ── Part 1: the interruption read off an OUTCOME, never a catch ─────
            const recorded = rawDb.read(tenantReportPath(TENANT));
            expect(recorded).toBeDefined();
            const interrupted = firstRun.tenants[0].status === 'failed';
            expect(firstRun.tenantFailures).toBe(interrupted ? 1 : 0);

            // ── Req 7.10: once per page, whether or not that page wrote ────────
            //
            // Every successfully fetched page reaches its boundary and evaluates the
            // check — except the one page a crashed MOVE abandoned part way, which
            // never reaches its boundary at all. A failed page FETCH returns no page,
            // so it is not among the pages examined and is not expected to have been
            // checked.
            const pagesExamined = fetchedPages(log).length;
            expect(invariantCalls).toBe(pagesExamined - (crashedOnMove ? 1 : 0));

            const reportWrites = captured.length;
            if (reportWrites < pagesExamined) arms.silentPage += 1;

            // ── Req 7.24: a MID-PAGE write persists the UNADVANCED cursor ───────
            //
            // The token the page in flight was fetched with — i.e. the token for the
            // last fully completed page. The counters on that same write already
            // include the moves made so far on the page in flight, so the counters
            // may LEAD the cursor and can never LAG it, which is the safe asymmetry:
            // a resume re-examines a partly handled page and finds its already-moved
            // objects gone from the listing.
            let lastMidPageIndex = -1;
            // The mid-listing PROGRESS writes only. The two terminal shapes carry no
            // page position to classify: the `completed` write persists `resume: null`
            // by construction, and the catch's write sets `status`, `lastError`,
            // `runnerId` and `updatedAt` and nothing else — deliberately, so the
            // previous page's cursor and counters stand exactly as the failing attempt
            // left them (Req 1.6).
            for (const write of captured.filter((entry) => entry.data.status === 'in_progress')) {
              const classified = classifyWrite(write, log, 0);
              if (classified.midPage) {
                arms.midPageWrite += 1;
                lastMidPageIndex = write.logIndex;
                expect(classified.writeToken).toBe(classified.fetchToken);
                expect((write.data.resume as { prefixIndex?: unknown }).prefixIndex).toBe(
                  PREFIX_INDEX
                );
              } else if (classified.writeToken !== classified.fetchToken) {
                // The cursor genuinely DOES advance at a boundary, so the mid-page
                // claim above is not vacuously true of a cursor that never moves.
                arms.advancedBoundaryWrite += 1;
              }
            }

            // ── Part 2: EVERY generated schedule reaches assertions ────────────
            if (interrupted) {
              arms.interrupted += 1;
              expect(recorded!.status).toBe('failed');
              expect(typeof recorded!.lastError).toBe('string');
              if (crashedOnMove && lastMidPageIndex >= 0) arms.midPageWriteThenCrash += 1;
            } else {
              arms.uninterrupted += 1;
              // The interruption index named a page or a move this fixture never
              // reached. That is a case to ASSERT as an uninterrupted run, not to
              // skip: the whole fixture was examined and the recorded status says so.
              expect(firstRun.tenants[0].status).toBe('completed');
              expect(recorded!.status).toBe('completed');
              expect([...new Set(examinedNames(log))].sort()).toEqual(baselineExamined);
            }

            // ── The resumption, against the same bucket and Firestore ──────────
            //
            // Reached by BOTH arms. After an uninterrupted first run it is the
            // recorded-`completed` no-op, which lists nothing and leaves the union
            // equal to the baseline all the same.
            const boundary = log.entries.length;
            let resumedInvariants = 0;
            const resumed = await runStorageOrphanSweep({
              db: db as never,
              rtdb: createFakeRtdb({ log, tree: {} }) as never,
              bucket: bucket as never,
              config: config as never,
              quarantineObject: createTestQuarantineMover(log) as never,
              now: () => NOW,
              assertInvariants: (...args) => {
                resumedInvariants += 1;
                return assertSweepInvariants(...args);
              },
            });
            expect(resumed.tenants[0].status).toBe('completed');
            expect(resumed.tenantFailures).toBe(0);
            expect(resumedInvariants).toBe(fetchedPages(log, boundary).length);

            // Req 7.7 — nothing is SKIPPED. Re-examining a page is harmless; missing
            // one is the failure a cursor advanced one page early produces.
            const union = [...new Set(examinedNames(log))].sort();
            expect(union).toEqual(baselineExamined);

            // And no object was moved twice within one Sweep_Id.
            const moved = log
              .filter((entry) => entry.method === 'file.copy')
              .map((entry) => entry.target);
            expect(new Set(moved).size).toBe(moved.length);

            // The completed report carries no cursor.
            expect(rawDb.read(tenantReportPath(TENANT))!.resume).toBeNull();
          }
        ),
        { numRuns: 100 }
      );

      // Vacuity is a visible failure, not a silent pass (Req 11.25).
      expect(arms.interrupted).toBeGreaterThan(0);
      expect(arms.uninterrupted).toBeGreaterThan(0);
      expect(arms.silentPage).toBeGreaterThan(0);
      expect(arms.midPageWrite).toBeGreaterThan(0);
      expect(arms.midPageWriteThenCrash).toBeGreaterThan(0);
      expect(arms.advancedBoundaryWrite).toBeGreaterThan(0);
    },
    120_000
  );
});
