// Feature: storage-sweep-scale-hardening, Property 3: Keyset pagination visits every document exactly once and hides the page size
/**
 * Property 3: Keyset pagination visits every document exactly once and hides the page size
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.8, 3.9, 3.10, 3.16, 3.17, 4.1, 4.2, 4.4, 4.8**
 *
 * *For any* Firestore Reference_Source, *any* collection contents — including documents
 * that all share one `tenantId`, documents whose `tenantId` field disagrees with their
 * document id, and counts exactly at, one below, one above and at exact multiples of a
 * page boundary — and *any* page size:
 *
 *  - the multiset of documents handed to the handler equals the set matching the query,
 *    exactly once each;
 *  - the visit order is ascending document name;
 *  - `retainPaths`, `referenceFingerprint` and `countsBySource` are IDENTICAL across two
 *    different page sizes over the same fixture;
 *  - the active-tenant list equals the sorted active document ids, de-duplicated, every
 *    identifier taken from `doc.id` rather than from a field;
 *  - a failure injected on page *k*, for every *k* INCLUDING THE LAST, lands in
 *    `failedSources`, aborts the tenant with `reference_source_failed`, and quarantines
 *    nothing;
 *  - the walk terminates for every generated page size.
 *
 * ── The page-size independence clause is the safety claim of the whole task ──
 *
 * Page size is an implementation detail and any leak of it into the output is a bug — and
 * it is the FINGERPRINT leaking that would be expensive, because the fingerprint is the
 * stale-resume detector: a page-size-dependent fingerprint would discard every in-flight
 * cursor the day someone changed the configuration. It cannot move structurally — sha256
 * over the SORTED set, and every document visited exactly once at any page size, so page
 * size can affect only insertion order, which the sort erases — and it has been checked
 * once by hand against the pre-pagination implementation extracted from `git show HEAD`.
 * This file makes it a standing assertion rather than a one-off measurement.
 *
 * ── `pageSize: 1` and exact multiples separate the TWO stop conditions ───────
 *
 * A short page ends the walk, and an empty page ends the walk on its own. They look like
 * one rule wearing two hats. A helper that treats the empty page as a redundant
 * restatement of the short-page test passes every fixture whose document count is NOT a
 * multiple of its page size — which is most of them. At `pageSize: 1` every non-empty
 * page is full, so the short-page test never fires and the empty page is the only
 * terminator; at an exact multiple the same is true of the final page. Both shapes are
 * generated.
 *
 * ── TERMINATION IS A BOUNDED PAGE COUNT, NOT A TEST TIMEOUT (Req 3.17) ──────
 *
 * The failure mode of a collapsed stop condition is an INFINITE LOOP, and a jest worker
 * spinning inside an `await` does not time out cleanly. So the fake carries a hard
 * per-collection page ceiling and throws the moment it is exceeded, naming the
 * collection and the bound. A non-terminating helper therefore produces a red test with
 * a diagnosis instead of a wedged process, and every case that drives a generated page
 * size additionally declares a low timeout.
 *
 * ── No vacuous arms (Req 11.26) ─────────────────────────────────────────────
 *
 * No precondition below is established by catching an exception: the failing-page arm
 * asserts on the RECORDED abort — `failedSources` and `abortReason` are return values
 * that exist whether or not anything was thrown — so nothing here can go quietly green
 * the day the collector stops raising. Every arm the generators can select is counted and
 * asserted non-zero after `fc.assert` returns: `pageSize: 1`, an exact-multiple count, a
 * shared-`tenantId` fixture spanning more than one page, a `tenantId` field disagreeing
 * with its document id, a failing LAST page and a failing non-last page.
 */

import * as fc from 'fast-check';

import {
  collectTenantReferenceSet,
  quarantineObject,
  runStorageOrphanSweep,
  tenantReportPath,
  type ReferenceSourceId,
  type TenantReferenceSet,
} from '../jobs/storageOrphanSweep';
import { deriveProfilePicturePath } from '../lib/storageObjectRef';
import {
  BUCKET_NAME,
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  downloadUrl,
  iso,
  sweepConfig,
  type DocData,
  type FakeDocSnapshot,
  type FakeFirestore,
  type FakeObject,
  type OperationLog,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
/** A second tenant whose documents must never appear on a page of the first's walk. */
const OTHER_TENANT = 'other_tenant';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
const OLD = iso(NOW - 120 * DAY);

// ─── The seven paged Firestore collections ───────────────────────────────────
//
// Deliberately duplicated from `storageOrphanSweep.referencePaging.test.ts` rather than
// factored into a third support module: task 5.5 and this task each name exactly one new
// file, and a shared helper would put a third file in the diff. The two copies are read
// together and neither depends on the other.

/**
 * One spec per collection `forEachQueryDocPaged` walks. Seven collections, six
 * Reference_Source ids — `tenantMemberships` and `tenantProfiles` are both
 * `profile_pictures_derived`, which is why `pagesBySource` accumulates both under one key
 * and why the order they are read in matters to the failing-page arm.
 *
 * Every document proves EXACTLY ONE in-scope path and every path is unique. That is what
 * makes the two counters a multiset check rather than a set check: `countsBySource`
 * counts ACCEPTED references, before de-duplication, while `retainPaths` counts distinct
 * paths — so a document visited twice inflates the first and leaves the second alone.
 */
interface PagedSourceSpec {
  collection: string;
  sourceId: ReferenceSourceId;
  path(tenantId: string, docId: string): string;
  doc(tenantId: string, docId: string): DocData;
}

const PAGED_SOURCES: readonly PagedSourceSpec[] = [
  {
    collection: 'videoTranscodes',
    sourceId: 'video_transcodes',
    // NOT a `chat-files/` path: a chat video path would additionally be offered as a
    // derived `_h264.mp4`, and the one-path-per-document arithmetic is what makes the
    // multiset assertions exact.
    path: (tenantId, docId) => `notices/${tenantId}/vt_${docId}.mp4`,
    doc: (tenantId, docId) => ({
      tenantId,
      status: 'ready',
      originalDeleted: true,
      transcodedPath: `notices/${tenantId}/vt_${docId}.mp4`,
    }),
  },
  {
    collection: 'sharedFiles',
    sourceId: 'shared_files',
    path: (tenantId, docId) => `notices/${tenantId}/sf_${docId}.png`,
    doc: (tenantId, docId) => ({
      tenantId,
      file: { url: downloadUrl(`notices/${tenantId}/sf_${docId}.png`) },
    }),
  },
  {
    collection: 'fees',
    sourceId: 'fees',
    path: (tenantId, docId) => `receipts/${tenantId}/fee_${docId}.pdf`,
    doc: (tenantId, docId) => ({
      tenantId,
      receipts: [{ url: downloadUrl(`receipts/${tenantId}/fee_${docId}.pdf`) }],
    }),
  },
  {
    collection: 'notices',
    sourceId: 'notices',
    path: (tenantId, docId) => `notices/${tenantId}/n_${docId}.png`,
    doc: (tenantId, docId) => ({
      tenantId,
      imageUrl: downloadUrl(`notices/${tenantId}/n_${docId}.png`),
    }),
  },
  {
    collection: 'students',
    sourceId: 'students',
    path: (tenantId, docId) => `student_profiles/${tenantId}/s_${docId}.jpg`,
    doc: (tenantId, docId) => ({
      tenantId,
      profileImageUrl: downloadUrl(`student_profiles/${tenantId}/s_${docId}.jpg`),
    }),
  },
  {
    collection: 'tenantMemberships',
    sourceId: 'profile_pictures_derived',
    // DERIVED, through the writer's own resolver rather than re-derived here.
    path: (tenantId, docId) =>
      deriveProfilePicturePath({ tenantId, email: membershipEmail(docId) }) ?? '',
    doc: (tenantId, docId) => ({ tenantId, email: membershipEmail(docId) }),
  },
  {
    collection: 'tenantProfiles',
    sourceId: 'profile_pictures_derived',
    path: (tenantId, docId) => `profile-pictures/${tenantId}/p_${docId}.jpg`,
    doc: (tenantId, docId) => ({
      tenantId,
      photoURL: downloadUrl(`profile-pictures/${tenantId}/p_${docId}.jpg`),
    }),
  },
];

const PAGED_COLLECTIONS = PAGED_SOURCES.map((source) => source.collection);

function membershipEmail(docId: string): string {
  return `member.${docId}@example.test`;
}

function specFor(collection: string): PagedSourceSpec {
  return PAGED_SOURCES.find((source) => source.collection === collection)!;
}

/** Pages a keyset walk over `documents` at `pageSize` reads, terminating page included. */
function expectedPageCount(documents: number, pageSize: number): number {
  // At an exact multiple the last page is FULL, so the empty page is the only terminator
  // and there is one page more than `documents / pageSize`. For every other count the
  // last page is short and this is `ceil(documents / pageSize)`. One expression covers
  // both, which is the arithmetic the two stop conditions produce together.
  return Math.floor(documents / pageSize) + 1;
}

interface Fixture {
  collections: Record<string, Record<string, DocData>>;
  /** Collection → the MATCHING document ids, ascending by name. */
  expectedIds: Record<string, string[]>;
  /** Every in-scope path the fixture proves, one per matching document. */
  expectedPaths: string[];
  matchingCount(collection: string): number;
}

/**
 * `count` matching documents per collection, ids `d000`, `d00{gap}`, … so a generated
 * `gap` of 1 puts them ADJACENT in name order and a larger one spreads them.
 *
 * Two deliberate hostilities:
 *
 *  - documents are inserted in REVERSE name order, because the fake's unordered path
 *    returns insertion order — so a walk that lost its `orderBy` would hand them back
 *    descending and the order assertion would fail rather than pass by accident;
 *  - a document of a DIFFERENT tenant is interleaved between every pair of matching ids
 *    (`d001` ⇒ `d001x`, which sorts strictly between `d001` and `d002`). Every matching
 *    document shares one `tenantId`, which is the shape a value cursor breaks on, and the
 *    interleaved neighbours mean a cursor that ignored the filter would visibly pick one
 *    up.
 */
function buildFixture(counts: Record<string, number>, gap: number): Fixture {
  const collections: Record<string, Record<string, DocData>> = {};
  const expectedIds: Record<string, string[]> = {};
  const expectedPaths: string[] = [];

  for (const source of PAGED_SOURCES) {
    const count = counts[source.collection] ?? 0;
    const ids = Array.from({ length: count }, (_unused, index) =>
      `d${String(index * gap).padStart(3, '0')}`
    );
    const documents: Record<string, DocData> = {};
    for (const docId of ids.slice().reverse()) {
      documents[docId] = source.doc(TENANT, docId);
      // The neighbour, so the walk has something to wrongly pick up.
      documents[`${docId}x`] = source.doc(OTHER_TENANT, `${docId}x`);
      expectedPaths.push(source.path(TENANT, docId));
    }
    collections[source.collection] = documents;
    expectedIds[source.collection] = ids;
  }

  return {
    collections,
    expectedIds,
    expectedPaths,
    matchingCount: (collection) => expectedIds[collection]?.length ?? 0,
  };
}

// ─── Query instrumentation ───────────────────────────────────────────────────

interface PagingProbe {
  /** Collection → the document ids delivered, page after page, in order. */
  visited(collection: string): string[];
  /** Collection → pages REQUESTED, the terminating empty page included. */
  requested(collection: string): number;
  /**
   * The diagnosis of a walk that asked for one page more than its bound, or `null`.
   * A non-null value here is a non-terminating keyset loop — asserted directly so the
   * outcome is a red test naming the collection rather than a spinning worker.
   */
  overrun: string | null;
}

interface QueryHooks {
  failPage?(collection: string, pageIndex: number): unknown | undefined;
  maxPages?(collection: string): number;
}

/**
 * Wrap `db.collection(name)`'s query so pages can be counted, capped and failed
 * individually, passing `doc`, `add` and every builder call straight through so the shape
 * the code under test sees is unchanged.
 *
 * Only queries that asked for a `limit` are instrumented: `estimateTenantStorageBytes`
 * issues its own unpaginated `videoTranscodes` query during Phase 2 — the residual the
 * design records as deliberately out of scope — and it must not consume a page of this
 * collection's budget, take a page index, or be selected by `failPage`.
 */
function instrumentQueries(
  db: FakeFirestore,
  hooks: QueryHooks = {}
): { db: FakeFirestore; probe: PagingProbe } {
  const requested = new Map<string, number>();
  const visited = new Map<string, string[]>();
  const probe: PagingProbe = {
    visited: (collection) => visited.get(collection) ?? [],
    requested: (collection) => requested.get(collection) ?? 0,
    overrun: null,
  };

  const wrap = (collection: string, target: Record<string, unknown>): Record<string, unknown> => {
    const call = (method: string, args: unknown[]): void => {
      (target[method] as (...rest: unknown[]) => unknown)(...args);
    };
    let paged = false;
    const wrapper: Record<string, unknown> = {
      where: (...args: unknown[]) => (call('where', args), wrapper),
      orderBy: (...args: unknown[]) => (call('orderBy', args), wrapper),
      limit: (...args: unknown[]) => ((paged = true), call('limit', args), wrapper),
      startAfter: (...args: unknown[]) => (call('startAfter', args), wrapper),
      doc: (id: string) => (target.doc as (id: string) => unknown)(id),
      add: (data: DocData) => (target.add as (data: DocData) => unknown)(data),
      async get() {
        if (!paged) return (target.get as () => Promise<unknown>)();

        const pageIndex = requested.get(collection) ?? 0;
        requested.set(collection, pageIndex + 1);

        // ── The bounded page count (Req 3.17) ─────────────────────────────
        //
        // Checked BEFORE the read, so a helper that would loop forever stops on its
        // first excess request instead of spinning inside an `await`.
        const ceiling = hooks.maxPages?.(collection);
        if (ceiling !== undefined && pageIndex >= ceiling) {
          const diagnosis =
            `${collection} requested page ${pageIndex + 1} of a walk bounded at ${ceiling} ` +
            `pages — the keyset loop did not terminate`;
          probe.overrun = probe.overrun ?? diagnosis;
          throw new Error(`[paging probe] ${diagnosis}`);
        }

        const page = (await (target.get as () => Promise<unknown>)()) as {
          docs: FakeDocSnapshot[];
        };

        const failure = hooks.failPage?.(collection, pageIndex);
        if (failure !== undefined) throw failure;

        // Recorded only for a page that was successfully READ. Nothing here evaluates
        // `shouldStop`, so every document a page delivers is a document the handler is
        // handed — which is what makes this the visit sequence rather than an
        // approximation of it.
        const seen = visited.get(collection) ?? [];
        for (const doc of page.docs) seen.push(doc.id);
        visited.set(collection, seen);

        return page;
      },
    };
    return wrapper;
  };

  return {
    db: {
      ...db,
      collection: (name: string) => wrap(name, db.collection(name) as Record<string, unknown>),
    },
    probe,
  };
}

// ─── Harnesses ───────────────────────────────────────────────────────────────

async function collectPaged(
  fixture: Fixture,
  firestorePageSize: number,
  hooks?: QueryHooks
): Promise<{ result: TenantReferenceSet; probe: PagingProbe; log: OperationLog }> {
  const log = createOperationLog();
  const base = createFakeFirestore({ log, collections: fixture.collections });
  const { db, probe } = instrumentQueries(base, {
    maxPages: (collection) =>
      expectedPageCount(fixture.matchingCount(collection), firestorePageSize),
    ...hooks,
  });

  const result = await collectTenantReferenceSet({
    db: db as never,
    rtdb: createFakeRtdb({ log, tree: {} }) as never,
    tenantId: TENANT,
    bucketName: BUCKET_NAME,
    maxReferences: 10_000,
    firestorePageSize,
  });

  return { result, probe, log };
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

/**
 * The pages each Reference_Source should report at `pageSize`.
 *
 * `profile_pictures_derived` is the sum of TWO collections' walks, which is the one place
 * the source-to-collection mapping is not one-to-one, and the two sources that issue no
 * paged query at all — the Realtime Database walk and `tenant_branding`'s single
 * `tenants/{tenantId}` read — are zero rather than absent.
 */
function expectedPagesBySource(fixture: Fixture, pageSize: number): Record<string, number> {
  const pages: Record<string, number> = { rtdb_chat_messages: 0, tenant_branding: 0 };
  for (const source of PAGED_SOURCES) {
    pages[source.sourceId] =
      (pages[source.sourceId] ?? 0) +
      expectedPageCount(fixture.matchingCount(source.collection), pageSize);
  }
  return pages;
}

function aged(objectPath: string): FakeObject {
  return { name: objectPath, size: 10, timeCreated: OLD, updated: OLD };
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

// ─── Arm 1: exactly once, in order, at two page sizes ────────────────────────

/** The five count shapes, relative to the first generated page size. */
const COUNT_SHAPES = ['zero', 'one', 'exact-multiple', 'one-below', 'one-above'] as const;

/**
 * The count each shape asks for, relative to `pageSize`.
 *
 * `exact-multiple` is `pageSize * multiple` UNCAPPED, and the generators are bounded so
 * it cannot need capping: clamping the product would quietly turn an exact multiple into
 * a nearby non-multiple and retire the arm that separates the two stop conditions, while
 * the vacuity counter — which tests the resolved count, not the shape — would keep
 * reporting the arm as reached.
 */
function resolveCount(shape: (typeof COUNT_SHAPES)[number], pageSize: number, multiple: number): number {
  switch (shape) {
    case 'zero':
      return 0;
    case 'one':
      return 1;
    case 'exact-multiple':
      return pageSize * multiple;
    case 'one-below':
      return Math.max(0, pageSize * multiple - 1);
    default:
      return pageSize * multiple + 1;
  }
}

describe('Property 3: keyset pagination visits every document exactly once and hides the page size', () => {
  it(
    'visits each matching document once in name order and returns the same retain set, fingerprint and counts at both page sizes',
    async () => {
      // ── The vacuity guard (Req 11.26) ─────────────────────────────────────
      const arms = { pageSizeOne: 0, exactMultiple: 0, sharedTenantMultiPage: 0 };

      await fc.assert(
        fc.asyncProperty(
          // `1` is generated explicitly rather than sampled from a range: it is the
          // page size at which every page is full and the empty page is the only
          // terminator.
          fc.constantFrom(1, 2, 3),
          fc.constantFrom(1, 2, 4, 7, 1_000),
          fc.array(fc.constantFrom(...COUNT_SHAPES), {
            minLength: PAGED_COLLECTIONS.length,
            maxLength: PAGED_COLLECTIONS.length,
          }),
          fc.integer({ min: 1, max: 3 }),
          // Adjacent in name order, or spread — the cursor is a document path either way.
          fc.constantFrom(1, 7),
          async (pageSizeA, pageSizeB, shapes, multiple, gap) => {
            const counts: Record<string, number> = {};
            PAGED_COLLECTIONS.forEach((collection, index) => {
              counts[collection] = resolveCount(shapes[index], pageSizeA, multiple);
            });
            const fixture = buildFixture(counts, gap);

            if (pageSizeA === 1 || pageSizeB === 1) arms.pageSizeOne += 1;
            if (
              PAGED_COLLECTIONS.some((collection) => {
                const count = counts[collection];
                return count > 0 && (count % pageSizeA === 0 || count % pageSizeB === 0);
              })
            ) {
              arms.exactMultiple += 1;
            }
            if (
              PAGED_COLLECTIONS.some(
                (collection) => expectedPageCount(counts[collection], pageSizeA) > 1
              )
            ) {
              // Every matching document in this fixture carries the same `tenantId`, and
              // the walk spans more than one page — the shape a value cursor breaks on.
              arms.sharedTenantMultiPage += 1;
            }

            const runA = await collectPaged(fixture, pageSizeA);
            const runB = await collectPaged(fixture, pageSizeB);

            for (const [run, pageSize] of [
              [runA, pageSizeA],
              [runB, pageSizeB],
            ] as const) {
              // ── Termination as a BOUNDED PAGE COUNT, not a timeout (Req 3.17) ──
              expect(run.probe.overrun).toBeNull();
              expect(run.result.failedSources).toEqual([]);
              expect(run.result.abortReason).toBeNull();

              for (const collection of PAGED_COLLECTIONS) {
                const expectedIds = fixture.expectedIds[collection];
                // ── Exactly once, and in ascending document-name order ──────────
                //
                // Asserted as an ARRAY, so it is the multiset AND the order in one
                // claim: a document delivered twice fails even though the SET would
                // still match, and a descending walk fails even though the multiset
                // would.
                expect(run.probe.visited(collection)).toEqual([...expectedIds].sort());
                expect(run.probe.requested(collection)).toBe(
                  expectedPageCount(expectedIds.length, pageSize)
                );
                // Not one document of the interleaved neighbour tenant.
                expect(run.probe.visited(collection).filter((id) => id.endsWith('x'))).toEqual([]);
              }

              // The handler's own view of the same claim: `countsBySource` counts
              // accepted references BEFORE de-duplication, so a double visit inflates
              // it while `retainPaths` stays put (Req 3.16).
              expect(sumCounts(run.result.countsBySource)).toBe(fixture.expectedPaths.length);
              expect([...run.result.retainPaths].sort()).toEqual([...fixture.expectedPaths].sort());
            }

            // ── The page size decides nothing (Req 3.10) ────────────────────────
            expect([...runB.result.retainPaths].sort()).toEqual([...runA.result.retainPaths].sort());
            expect(runB.result.countsBySource).toEqual(runA.result.countsBySource);
            // The stale-resume detector, byte for byte.
            expect(runB.result.referenceFingerprint).toBe(runA.result.referenceFingerprint);

            // ── The page COUNTS are the one thing that DOES follow the page size ──
            //
            // Asserted exactly, in both runs. Without this the clause above would be
            // satisfied by a helper that ignored `firestorePageSize` altogether and read
            // every collection in one unbounded page — which is the code this task
            // replaced.
            expect(runA.result.pagesBySource).toEqual(expectedPagesBySource(fixture, pageSizeA));
            expect(runB.result.pagesBySource).toEqual(expectedPagesBySource(fixture, pageSizeB));
          }
        ),
        { numRuns: 100 }
      );

      expect(arms.pageSizeOne).toBeGreaterThan(0);
      expect(arms.exactMultiple).toBeGreaterThan(0);
      expect(arms.sharedTenantMultiPage).toBeGreaterThan(0);
    },
    15_000
  );

  // ─── Arm 2: the active-tenant walk ─────────────────────────────────────────

  it(
    'resolves the active tenant list from document ids, ascending and de-duplicated',
    async () => {
      const arms = { pageSizeOne: 0, disagreeingField: 0, inactivePresent: 0 };

      await fc.assert(
        fc.asyncProperty(
          fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 6 }),
          fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
          fc.constantFrom(1, 2, 3, 1_000),
          async (numbers, activeMask, firestorePageSize) => {
            const tenants: Record<string, DocData> = {};
            const active: string[] = [];
            numbers.forEach((number, index) => {
              const docId = `t${String(number).padStart(3, '0')}`;
              const isActive = activeMask[index];
              tenants[docId] = {
                status: isActive ? 'active' : 'inactive',
                // ── The FIELD disagrees with the id, on every document ──────────
                //
                // Every listing prefix and every Scope_Guard check is built from the
                // resolved identifier, so an identifier sourced from a mutable field
                // would be a confinement hole (Req 4.2). A fixture whose `tenantId`
                // field says something else must yield the document id.
                tenantId: `field_${docId}_not_the_id`,
              };
              if (isActive) active.push(docId);
            });

            if (firestorePageSize === 1) arms.pageSizeOne += 1;
            if (numbers.length > 0) arms.disagreeingField += 1;
            if (active.length < numbers.length) arms.inactivePresent += 1;

            const log = createOperationLog();
            const base = createFakeFirestore({ log, collections: { tenants } });
            const { db, probe } = instrumentQueries(base, {
              // The subject is the `tenants` walk, bounded exactly. Every reference
              // collection is empty here and is walked once PER SWEPT TENANT, so its
              // bound is the number of tenants — the probe's counters are cumulative
              // across the run, which is what makes a bound a bound rather than a
              // per-call allowance.
              maxPages: (collection) =>
                collection === 'tenants'
                  ? expectedPageCount(active.length, firestorePageSize)
                  : Math.max(1, active.length),
            });

            const result = await runStorageOrphanSweep({
              db: db as never,
              rtdb: createFakeRtdb({ log, tree: {} }) as never,
              bucket: createFakeBucket({ log, objects: [] }) as never,
              config: sweepConfig({
                tenantIds: 'all_active',
                nowMs: NOW,
                firestorePageSize,
              }) as never,
            });

            expect(probe.overrun).toBeNull();

            const resolved = result.tenants.map((tenant) => tenant.tenantId);
            // Ascending document-name order (Req 4.4), de-duplicated (Req 4.8), every
            // identifier a document id (Req 4.2).
            expect(resolved).toEqual([...active].sort());
            expect(new Set(resolved).size).toBe(resolved.length);
            for (const tenantId of resolved) {
              expect(tenantId.startsWith('field_')).toBe(false);
              expect(Object.prototype.hasOwnProperty.call(tenants, tenantId)).toBe(true);
            }
            // The inactive documents are not swept, so the filter is applied per page
            // rather than to the first page only.
            expect(resolved).not.toContain(
              Object.keys(tenants).find((docId) => !active.includes(docId))
            );
            expect(probe.requested('tenants')).toBe(
              expectedPageCount(active.length, firestorePageSize)
            );
          }
        ),
        { numRuns: 100 }
      );

      expect(arms.pageSizeOne).toBeGreaterThan(0);
      expect(arms.disagreeingField).toBeGreaterThan(0);
      expect(arms.inactivePresent).toBeGreaterThan(0);
    },
    15_000
  );

  // ─── Arm 3: a failure on page k, for every k including the last ───────────

  it(
    'lands a failure on any page — the last included — in failedSources, aborts the tenant, and moves nothing',
    async () => {
      const arms = { lastPage: 0, nonLastPage: 0, pageSizeOne: 0 };

      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...PAGED_COLLECTIONS),
          fc.integer({ min: 0, max: 6 }),
          fc.constantFrom(1, 2, 3),
          // Resolved against the page count below, so "the last page" is reachable for
          // every generated count and page size rather than only for the large ones.
          fc.double({ min: 0, max: 1, noNaN: true }),
          async (failingCollection, count, firestorePageSize, position) => {
            const counts = Object.fromEntries(PAGED_COLLECTIONS.map((name) => [name, count]));
            const fixture = buildFixture(counts, 1);
            const pages = expectedPageCount(count, firestorePageSize);
            const failingPage = Math.min(pages - 1, Math.floor(position * pages));

            if (failingPage === pages - 1) arms.lastPage += 1;
            else arms.nonLastPage += 1;
            if (firestorePageSize === 1) arms.pageSizeOne += 1;

            const log = createOperationLog();
            const base = createFakeFirestore({ log, collections: fixture.collections });
            const { db, probe } = instrumentQueries(base, {
              maxPages: (collection) =>
                expectedPageCount(fixture.matchingCount(collection), firestorePageSize),
              failPage: (collection, pageIndex) =>
                collection === failingCollection && pageIndex === failingPage
                  ? new Error(`page ${pageIndex} of ${collection} failed`)
                  : undefined,
            });
            const bucket = createFakeBucket({
              log,
              objects: [aged(`notices/${TENANT}/loose_orphan.png`)],
            });

            // Apply mode with the real mover installed, because "moved nothing" is only
            // a claim in the mode that can move something.
            const result = await runStorageOrphanSweep({
              db: db as never,
              rtdb: createFakeRtdb({ log, tree: {} }) as never,
              bucket: bucket as never,
              config: sweepConfig({
                tenantIds: [TENANT],
                mode: 'sweep',
                apply: true,
                nowMs: NOW,
                firestorePageSize,
              }) as never,
              quarantineObject,
            });

            expect(probe.overrun).toBeNull();

            // ── The precondition is the RECORDED outcome, never a caught throw ──
            const tenant = result.tenants[0];
            const sourceId = specFor(failingCollection).sourceId;
            expect(tenant.status).toBe('aborted');
            expect(tenant.abortReason).toBe('reference_source_failed');
            expect(result.tenantFailures).toBe(0);

            const report = base.read(tenantReportPath(TENANT))!;
            const failed = report.failedSources as { id: string; message: string }[];
            expect(failed.map((entry) => entry.id)).toContain(sourceId);
            expect(failed.every((entry) => typeof entry.message === 'string')).toBe(true);
            expect(report.partial).toBe(true);

            // ── Nothing moved, and nothing was even listed ─────────────────────
            //
            // The gate precedes the Object_Listing, so this is structural rather than a
            // count that happened to come out at zero.
            expect(log.filter((entry) => entry.method === 'file.copy')).toEqual([]);
            expect(log.filter((entry) => entry.method === 'file.delete')).toEqual([]);
            expect(log.filter((entry) => entry.method === 'getFiles')).toEqual([]);
            expect(bucket.contents().has(`notices/${TENANT}/loose_orphan.png`)).toBe(true);
            expect(tenant.quarantinedCount).toBe(0);
            expect(tenant.quarantinedBytes).toBe(0);

            // The pages read BEFORE the failure are still reported: `onPage` fires once
            // per page successfully read, which is why the count travels by callback
            // rather than by return value — a return value would report nothing for
            // exactly the source an operator most wants to see.
            expect(probe.requested(failingCollection)).toBe(failingPage + 1);
          }
        ),
        { numRuns: 100 }
      );

      expect(arms.lastPage).toBeGreaterThan(0);
      expect(arms.nonLastPage).toBeGreaterThan(0);
      expect(arms.pageSizeOne).toBeGreaterThan(0);
    },
    15_000
  );
});
