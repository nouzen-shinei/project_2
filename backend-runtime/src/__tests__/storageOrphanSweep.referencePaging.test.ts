/**
 * Unit tests for the Reference_Page_Helper's QUERY SHAPE — storage-sweep-scale-hardening
 * task 5.5, Reqs 3.4, 3.6, 3.7, 3.17, 4.3, 4.5, 4.6, 11.8, 11.9, 11.10.
 *
 * Property 3 (`storageOrphanSweep.referencePaging.property.test.ts`) asserts what the
 * walk RETURNS across generated page sizes. This file asserts what it ASKS FOR, which
 * no observation of the returned retain set can reach: the ordering field, the limit,
 * the cursor, the single-document branding read, and the empty page that terminates a
 * walk whose last page is full.
 *
 * ── The harness has TWO surfaces and they are not interchangeable ────────────
 *
 * **Counts come from the operation log; ordering detail comes from `db.queries`.**
 * `query.get`'s log entry is byte-identical to the shipped one — same method, same
 * target, same `kind`, no `detail` — because an existing integration case asserts
 * `log.methods()` EXACTLY, and Req 11.2 forbids breaking it. So task 2.2 put
 * `orderBy`, `orderByDirections`, `limit` and `startAfterPath` on
 * `db.queries: FakeQueryRecord[]` instead, and "how many pages were requested" stays
 * a count of log entries. Every assertion below reads whichever of the two surfaces
 * carries the fact it is about.
 *
 * ── Why `orderBy(['__name__'])` and nothing else is worth its own test ───────
 *
 * Firestore EXCLUDES from a result set any document that lacks the ordering field, so
 * ordering by anything optional drops documents silently — and a dropped document is a
 * reference never collected, which makes the object it names an Orphan candidate. The
 * failure is invisible in the retain set of any fixture whose documents all happen to
 * carry the field, which is every fixture anyone writes by hand. So the ordering field
 * is asserted directly, for all seven paged collections (Req 3.4).
 *
 * ── The one-page memory bound is asserted STRUCTURALLY ───────────────────────
 *
 * Reqs 3.6, 3.7 and 4.3 bound what the walk holds. A test cannot measure that from a
 * heap reading, so the fake REVOKES instead: once page *k+1* has been requested, every
 * snapshot from page *k* throws when touched. A walk that kept a page alive fails; a
 * walk that holds one page plus the cursor passes.
 */

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
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;
/** Old enough that only a reference can retain it. */
const OLD = iso(NOW - 120 * DAY);

// ─── The seven paged Firestore collections ───────────────────────────────────

/**
 * One spec per collection `forEachQueryDocPaged` walks. Seven collections, six
 * Reference_Source ids: `tenantMemberships` and `tenantProfiles` are both
 * `profile_pictures_derived`, which is why `pagesBySource` accumulates the pages of
 * both under one key.
 *
 * Every document proves EXACTLY ONE in-scope path, and every path is unique. That is
 * what makes the two counters a multiset check rather than a set check:
 * `countsBySource` counts ACCEPTED references (before the de-duplication), while
 * `retainPaths` counts distinct paths — so a document visited twice inflates the first
 * and leaves the second alone, and asserting both catches a double visit that
 * asserting either alone would miss.
 */
interface PagedSourceSpec {
  collection: string;
  sourceId: ReferenceSourceId;
  /** The single object path a document with this id proves. */
  path(tenantId: string, docId: string): string;
  doc(tenantId: string, docId: string): DocData;
}

const PAGED_SOURCES: readonly PagedSourceSpec[] = [
  {
    collection: 'videoTranscodes',
    sourceId: 'video_transcodes',
    // Deliberately NOT a `chat-files/` path: a chat video path would additionally be
    // offered as a derived `_h264.mp4`, and this fixture's one-path-per-document
    // arithmetic is what makes the multiset assertions exact.
    path: (tenantId, docId) => `notices/${tenantId}/vt_${docId}.mp4`,
    doc: (tenantId, docId) => ({
      tenantId,
      status: 'ready',
      // With the original recorded as deleted and no transcode in flight, the
      // original is not offered — so `transcodedPath` is the document's one reference.
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
    // DERIVED, through the writer's own resolver rather than a re-derivation here —
    // the same reason the collector calls `deriveProfilePicturePath`.
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

/** `d00`, `d01`, … — zero-padded so lexicographic order is numeric order. */
function docIds(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `d${String(index).padStart(2, '0')}`);
}

/**
 * A fixture of `count` documents in each named collection.
 *
 * Inserted in REVERSE name order on purpose: the fake's unordered path returns
 * insertion order, so a walk that forgot its `orderBy` would hand documents back
 * descending and the ascending-order assertions would fail rather than pass by
 * accident.
 */
function pagedFixture(
  counts: Record<string, number>,
  tenantId = TENANT
): { collections: Record<string, Record<string, DocData>>; expectedPaths: string[] } {
  const collections: Record<string, Record<string, DocData>> = {};
  const expectedPaths: string[] = [];
  for (const source of PAGED_SOURCES) {
    const count = counts[source.collection] ?? 0;
    const documents: Record<string, DocData> = {};
    for (const docId of docIds(count).slice().reverse()) {
      documents[docId] = source.doc(tenantId, docId);
      expectedPaths.push(source.path(tenantId, docId));
    }
    collections[source.collection] = documents;
  }
  return { collections, expectedPaths };
}

/** Pages a keyset walk over `documents` at `pageSize` reads, terminating page included. */
function expectedPageCount(documents: number, pageSize: number): number {
  // A short page ends the walk and an empty page ends the walk; when the count is an
  // exact multiple of the page size the final page is FULL, so the empty page is the
  // only terminator and there is one more page than `documents / pageSize`.
  return Math.floor(documents / pageSize) + 1;
}

// ─── Query instrumentation ───────────────────────────────────────────────────

interface QueryHooks {
  /** Before the underlying `get()`, i.e. after `startAfter` has read its cursor. */
  beforePage?(collection: string, pageIndex: number): void;
  /** After a successful `get()`, with the page's snapshots. */
  onPage?(collection: string, pageIndex: number, docs: FakeDocSnapshot[]): void;
  /** Return a value to make that page's read fail, as Firestore would. */
  failPage?(collection: string, pageIndex: number): unknown | undefined;
  /**
   * A HARD per-collection page ceiling. Exceeding it throws with a diagnosis rather
   * than letting a non-terminating walk spin — a wedged worker is not a test result.
   */
  maxPages?(collection: string): number;
}

/**
 * Wrap `db.collection(name)`'s query with page-level hooks, passing `doc`, `add` and
 * every builder call straight through so the shape the code under test sees is
 * unchanged. `documents`, `read` and `queries` are the same objects the underlying
 * fake owns, so `db.queries` still records every executed query.
 */
function instrumentQueries(db: FakeFirestore, hooks: QueryHooks): FakeFirestore {
  const pagesRequested = new Map<string, number>();

  const wrap = (collection: string, target: Record<string, unknown>): Record<string, unknown> => {
    const call = (method: string, args: unknown[]): void => {
      (target[method] as (...rest: unknown[]) => unknown)(...args);
    };
    /**
     * Whether this query asked for a `limit`, i.e. whether it is a page of the keyset
     * walk at all.
     *
     * `estimateTenantStorageBytes` issues its own UNPAGINATED
     * `videoTranscodes.where('tenantId','==',t).where('originalDeleted','==',true)`
     * query during Phase 2 — the one residual the design records as deliberately out
     * of scope, since that module is shared with `POST /storage/reconcile`. It must not
     * consume a page of this collection's budget, take a page index, or be selected by
     * `failPage`, so every hook below applies to the limited queries only.
     */
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
        const pageIndex = pagesRequested.get(collection) ?? 0;
        pagesRequested.set(collection, pageIndex + 1);
        const ceiling = hooks.maxPages?.(collection);
        if (ceiling !== undefined && pageIndex >= ceiling) {
          throw new Error(
            `[paging probe] ${collection} requested page ${pageIndex + 1} of a walk bounded at ` +
              `${ceiling} pages — the keyset loop did not terminate`
          );
        }
        hooks.beforePage?.(collection, pageIndex);
        const page = (await (target.get as () => Promise<unknown>)()) as {
          docs: FakeDocSnapshot[];
        };
        hooks.onPage?.(collection, pageIndex, page.docs);
        const failure = hooks.failPage?.(collection, pageIndex);
        if (failure !== undefined) throw failure;
        return page;
      },
    };
    return wrapper;
  };

  return {
    ...db,
    collection: (name: string) => wrap(name, db.collection(name) as Record<string, unknown>),
  };
}

/** `query.get` entries in the log for one collection — a COUNT, so the log is right. */
function queryGetCount(log: OperationLog, collection: string): number {
  return log.filter((entry) => entry.method === 'query.get' && entry.target === collection).length;
}

/**
 * Pages of the KEYSET WALK for one collection, read off `db.queries`.
 *
 * A whole run also issues `estimateTenantStorageBytes`'s unpaginated `videoTranscodes`
 * query, which lands in both the log and `db.queries`; `limit !== null` is what tells
 * the two apart. The log count stays the right surface wherever no such query can
 * occur — the collector-only cases above.
 */
function pagedQueryCount(db: FakeFirestore, collection: string): number {
  return db.queries.filter((record) => record.collection === collection && record.limit !== null)
    .length;
}

// ─── Collector harness ───────────────────────────────────────────────────────

interface CollectOptions {
  counts: Record<string, number>;
  firestorePageSize?: number;
  hooks?: QueryHooks;
  extraCollections?: Record<string, Record<string, DocData>>;
  maxReferences?: number;
}

async function collect(options: CollectOptions): Promise<{
  result: TenantReferenceSet;
  db: FakeFirestore;
  log: OperationLog;
  expectedPaths: string[];
}> {
  const log = createOperationLog();
  const { collections, expectedPaths } = pagedFixture(options.counts);
  const base = createFakeFirestore({
    log,
    collections: { ...collections, ...(options.extraCollections ?? {}) },
  });
  const db = options.hooks ? instrumentQueries(base, options.hooks) : base;

  const result = await collectTenantReferenceSet({
    db: db as never,
    rtdb: createFakeRtdb({ log, tree: {} }) as never,
    tenantId: TENANT,
    bucketName: BUCKET_NAME,
    maxReferences: options.maxReferences ?? 10_000,
    firestorePageSize: options.firestorePageSize,
  });

  return { result, db: base, log, expectedPaths };
}

let consoleLog: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeAll(() => {
  // The collector logs one counts-only summary line per call, and the metric emitter
  // warns; silence both so the suite output stays readable.
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
});

// ─── Req 3.4 — the ordering field ────────────────────────────────────────────

describe('the paged reference query orders by __name__ and nothing else', () => {
  it('asks for exactly [__name__] ascending, with the configured limit, on all seven collections', async () => {
    const counts = Object.fromEntries(PAGED_COLLECTIONS.map((name) => [name, 3]));
    const { result, db } = await collect({ counts, firestorePageSize: 2 });

    // Every one of the seven, individually — a per-collection assertion rather than a
    // single sweep over `db.queries`, so a collection that issued NO query at all
    // fails here instead of passing vacuously.
    for (const collection of PAGED_COLLECTIONS) {
      const records = db.queries.filter((record) => record.collection === collection);
      expect(records.length).toBe(expectedPageCount(3, 2));
      for (const record of records) {
        expect(record.orderBy).toEqual(['__name__']);
        expect(record.orderByDirections).toEqual(['asc']);
        expect(record.limit).toBe(2);
        expect(record.filters).toEqual([{ field: 'tenantId', operator: '==', value: TENANT }]);
      }
    }

    // …and NOTHING else ordered by anything else, anywhere in the run: the clause
    // that catches an eighth query added later against an optional field.
    for (const record of db.queries) {
      expect(record.orderBy).toEqual(['__name__']);
    }
    expect(new Set(db.queries.map((record) => record.collection))).toEqual(
      new Set(PAGED_COLLECTIONS)
    );

    // The walk produced the references it was supposed to, so the shape above is the
    // shape of a query that WORKED.
    expect(result.failedSources).toEqual([]);
    expect(result.abortReason).toBeNull();
    expect(result.retainPaths.size).toBe(3 * PAGED_COLLECTIONS.length);
  });

  it('carries the cursor as a document path and refuses a bare field value', async () => {
    const { db } = await collect({ counts: { notices: 5 }, firestorePageSize: 2 });

    const records = db.queries.filter((record) => record.collection === 'notices');
    expect(records.length).toBe(expectedPageCount(5, 2));
    // Page 1 is uncursored; every later page resumes strictly after the last document
    // of the page before it (Req 3.3), read off `startAfterPath`.
    expect(records[0].startAfterPath).toBeNull();
    expect(records[1].startAfterPath).toBe('notices/d01');
    expect(records[2].startAfterPath).toBe('notices/d03');

    // ── A bare value fails LOUDLY (Req 3.3) ─────────────────────────────────
    //
    // `startAfter(someTenantId)` over documents that all share one `tenantId` either
    // returns nothing or returns everything, and the failure that matters is the
    // SKIP: a skipped document is a reference never collected. The fake
    // discriminates through a `WeakSet` of the snapshots it minted, so the snapshot
    // shape stays byte-identical to the shipped one.
    // The fake's query builder is deliberately an untyped bag
    // (`FakeFirestore.collection` returns `Record<string, unknown>`), so the chain
    // needs a local structural type to be type-checked at all.
    type PagedQueryBuilder = {
      where(field: string, operator: string, value: unknown): PagedQueryBuilder;
      orderBy(field: string): PagedQueryBuilder;
      limit(count: number): PagedQueryBuilder;
      startAfter(cursor: unknown): unknown;
    };
    const query = (db.collection('notices') as unknown as PagedQueryBuilder)
      .where('tenantId', '==', TENANT)
      .orderBy('__name__')
      .limit(2);
    expect(() => query.startAfter(TENANT)).toThrow(TypeError);
    expect(() => query.startAfter('notices/d01')).toThrow(/QueryDocumentSnapshot/);
  });
});

// ─── Reqs 4.5, 4.6 — the two reads that are NOT paged queries ────────────────

describe('the sources that issue no paged query', () => {
  it('reads tenant branding with a single doc.get and no query at all (Req 4.5)', async () => {
    const { result, db, log } = await collect({
      counts: { notices: 2 },
      firestorePageSize: 1,
      extraCollections: {
        tenants: {
          [TENANT]: { branding: { logoUrl: downloadUrl(`tenant-branding/${TENANT}/logo.png`) } },
        },
      },
    });

    expect(
      log.filter((entry) => entry.method === 'doc.get' && entry.target === `tenants/${TENANT}`)
    ).toHaveLength(1);
    expect(db.queries.filter((record) => record.collection === 'tenants')).toEqual([]);
    // The branding reference was collected all the same, so "no query" is not "no read".
    expect(result.retainPaths.has(`tenant-branding/${TENANT}/logo.png`)).toBe(true);
    // A source that issues no paged query reports zero pages rather than no key.
    expect(result.pagesBySource.tenant_branding).toBe(0);
    expect(result.pagesBySource.rtdb_chat_messages).toBe(0);
  });

  it('issues no tenants query for an allow-list run, and does for all_active (Req 4.6)', async () => {
    const tenantDocs: Record<string, DocData> = {
      // The FIELD disagrees with the id on purpose: every identifier is
      // document-id-derived, so record content cannot forge a listing prefix (Req 4.2).
      [TENANT]: { status: 'active', tenantId: 'not_the_document_id' },
      zzz_other: { status: 'active', tenantId: 'also_not_the_document_id' },
    };

    const allowListLog = createOperationLog();
    const allowListDb = createFakeFirestore({ log: allowListLog, collections: { tenants: tenantDocs } });
    const allowList = await runStorageOrphanSweep({
      db: allowListDb as never,
      rtdb: createFakeRtdb({ log: allowListLog, tree: {} }) as never,
      bucket: createFakeBucket({ log: allowListLog, objects: [] }) as never,
      config: sweepConfig({ tenantIds: [TENANT], nowMs: NOW, firestorePageSize: 1 }) as never,
    });

    expect(allowList.tenants.map((tenant) => tenant.tenantId)).toEqual([TENANT]);
    expect(allowListDb.queries.filter((record) => record.collection === 'tenants')).toEqual([]);

    // The same fixture resolved from the collection DOES query it, with the same
    // shape as every reference source — which is what makes the negative above a
    // discrimination rather than a tautology (Req 4.1, 4.4).
    const activeLog = createOperationLog();
    const activeDb = createFakeFirestore({ log: activeLog, collections: { tenants: tenantDocs } });
    const active = await runStorageOrphanSweep({
      db: activeDb as never,
      rtdb: createFakeRtdb({ log: activeLog, tree: {} }) as never,
      bucket: createFakeBucket({ log: activeLog, objects: [] }) as never,
      config: sweepConfig({ tenantIds: 'all_active', nowMs: NOW, firestorePageSize: 1 }) as never,
    });

    const tenantQueries = activeDb.queries.filter((record) => record.collection === 'tenants');
    expect(tenantQueries.length).toBe(expectedPageCount(2, 1));
    for (const record of tenantQueries) {
      expect(record.orderBy).toEqual(['__name__']);
      expect(record.limit).toBe(1);
      expect(record.filters).toEqual([{ field: 'status', operator: '==', value: 'active' }]);
    }
    // Ascending document-name order, from `doc.id` and not from the field.
    expect(active.tenants.map((tenant) => tenant.tenantId)).toEqual([TENANT, 'zzz_other']);
  });
});

// ─── Reqs 3.6, 3.7, 4.3 — one page in memory, asserted structurally ──────────

describe('the walk holds one page plus the cursor', () => {
  it('never touches a snapshot from a page it has already left behind', async () => {
    const revoked: FakeDocSnapshot[] = [];
    const live = new Map<string, FakeDocSnapshot[]>();

    /**
     * Poison every snapshot of a page the walk has moved past. Identity is preserved
     * — the properties are redefined on the same objects — so the fake's `WeakSet` of
     * minted snapshots still recognises the cursor and `startAfter` keeps working.
     *
     * `id` is the load-bearing one: the helper reads `doc.data()` inside a `try` and
     * would swallow a throw from `data`, but `handler(data, doc.id)` is outside it, so
     * touching a revoked page surfaces as a `failedSources` entry.
     */
    const revoke = (docs: FakeDocSnapshot[]): void => {
      for (const doc of docs) {
        const path = doc.ref.path;
        for (const key of ['id', 'ref', 'exists', 'data'] as const) {
          Object.defineProperty(doc, key, {
            configurable: true,
            get() {
              throw new Error(`revoked snapshot touched: ${path}.${key}`);
            },
          });
        }
        revoked.push(doc);
      }
    };

    const { result } = await collect({
      counts: { notices: 7, students: 4 },
      firestorePageSize: 2,
      hooks: {
        // Fires INSIDE `get()`, i.e. after `startAfter(cursor)` has already read the
        // cursor's path — which is exactly the boundary Reqs 3.6 and 3.7 draw: the
        // cursor is one document, not a handle onto its page.
        beforePage: (collection) => {
          const previous = live.get(collection);
          if (previous) {
            revoke(previous);
            live.delete(collection);
          }
        },
        onPage: (collection, _pageIndex, docs) => {
          live.set(collection, docs.slice());
        },
      },
    });

    // A walk that kept a previous page reachable would have thrown, and `runSource`
    // would have recorded it here.
    expect(result.failedSources).toEqual([]);
    expect(result.abortReason).toBeNull();
    expect(result.retainPaths.size).toBe(11);
    expect(result.pagesBySource.notices).toBe(expectedPageCount(7, 2));
    expect(result.pagesBySource.students).toBe(expectedPageCount(4, 2));

    // The revoking fake actually revoked, and a revoked snapshot really does throw —
    // without this the case above would pass just as well against a fake that did
    // nothing at all.
    expect(revoked.length).toBeGreaterThan(0);
    expect(() => revoked[0].id).toThrow(/revoked snapshot touched/);
  });
});

// ─── Req 3.17 — the empty page is its own terminator ─────────────────────────

describe('a walk whose last page is FULL terminates on the following empty page', () => {
  /**
   * The case that separates the two stop conditions. At a document count that is an
   * exact multiple of the page size every page is full, so the short-page test never
   * fires; at `pageSize: 1` that is true of every fixture. A helper treating the empty
   * page as a redundant restatement of the short-page test loops forever here — which
   * is why the probe caps the page count and throws rather than letting it spin.
   */
  it.each([
    { pageSize: 3, documents: 6 },
    { pageSize: 1, documents: 2 },
  ])(
    'reads documents/pageSize + 1 pages for $documents documents at pageSize $pageSize',
    async ({ pageSize, documents }) => {
      const pages = expectedPageCount(documents, pageSize);
      expect(pages).toBe(documents / pageSize + 1);

      const { result, log } = await collect({
        counts: { notices: documents },
        firestorePageSize: pageSize,
        hooks: { maxPages: () => pages },
      });

      // The walk RETURNED — a value to assert on at all is the first half of the claim.
      expect(result.failedSources).toEqual([]);
      expect(result.abortReason).toBeNull();
      expect(result.retainPaths.size).toBe(documents);
      // Counts come from the LOG (Req 3.17); `documents + 1` at `pageSize: 1`.
      expect(queryGetCount(log, 'notices')).toBe(pages);
      expect(result.pagesBySource.notices).toBe(pages);
      // …and the per-page limit and cursor behind that count come from `db.queries`.
      expect(result.countsBySource.notices).toBe(documents);
    },
    10_000
  );

  it('reads documents/pageSize + 1 pages on every one of the seven collections', async () => {
    const pageSize = 2;
    const perCollection = 4;
    const pages = expectedPageCount(perCollection, pageSize);
    const counts = Object.fromEntries(PAGED_COLLECTIONS.map((name) => [name, perCollection]));

    const { result, log, expectedPaths } = await collect({
      counts,
      firestorePageSize: pageSize,
      hooks: { maxPages: () => pages },
    });

    for (const collection of PAGED_COLLECTIONS) {
      expect(queryGetCount(log, collection)).toBe(perCollection / pageSize + 1);
    }
    // Every document visited exactly once, as a multiset: `countsBySource` counts
    // ACCEPTED references, so a double visit shows up here even though `retainPaths`
    // would look identical.
    expect([...result.retainPaths].sort()).toEqual([...expectedPaths].sort());
    expect(sumCounts(result.countsBySource)).toBe(expectedPaths.length);
    expect(result.pagesBySource.profile_pictures_derived).toBe(2 * pages);
  }, 10_000);
});

// ─── Integration — the whole run, paged ──────────────────────────────────────

function aged(objectPath: string): FakeObject {
  return { name: objectPath, size: 10, timeCreated: OLD, updated: OLD };
}

interface RunOptions {
  counts: Record<string, number>;
  firestorePageSize: number;
  objects?: FakeObject[];
  apply?: boolean;
  hooks?: QueryHooks;
}

async function run(options: RunOptions) {
  const log = createOperationLog();
  const { collections, expectedPaths } = pagedFixture(options.counts);
  const base = createFakeFirestore({ log, collections });
  const db = options.hooks ? instrumentQueries(base, options.hooks) : base;
  const bucket = createFakeBucket({ log, objects: options.objects ?? [] });

  const result = await runStorageOrphanSweep({
    db: db as never,
    rtdb: createFakeRtdb({ log, tree: {} }) as never,
    bucket: bucket as never,
    config: sweepConfig({
      tenantIds: [TENANT],
      nowMs: NOW,
      firestorePageSize: options.firestorePageSize,
      ...(options.apply === true ? { mode: 'sweep', apply: true } : {}),
    }) as never,
    ...(options.apply === true ? { quarantineObject } : {}),
  });

  return { result, db: base, log, bucket, expectedPaths, report: base.read(tenantReportPath(TENANT)) };
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

describe('a paged run decides exactly what an unpaged one decided', () => {
  it('spans three pages per source at firestorePageSize 2 and matches the single-page run byte for byte', async () => {
    const counts = Object.fromEntries(PAGED_COLLECTIONS.map((name) => [name, 5]));
    const objects = [aged(`notices/${TENANT}/loose_orphan.png`)];

    const paged = await run({
      counts,
      firestorePageSize: 2,
      objects,
      hooks: { maxPages: () => expectedPageCount(5, 2) },
    });
    const single = await run({ counts, firestorePageSize: 1_000, objects });

    // Three pages each, so the fixture genuinely spans pages rather than fitting.
    for (const collection of PAGED_COLLECTIONS) {
      expect(pagedQueryCount(paged.db, collection)).toBe(3);
      expect(pagedQueryCount(single.db, collection)).toBe(1);
    }
    // `notices` is untouched by the usage estimator, so the log's own count agrees.
    expect(queryGetCount(paged.log, 'notices')).toBe(3);
    expect(queryGetCount(single.log, 'notices')).toBe(1);

    // Every document visited once, at both page sizes.
    expect(sumCounts(paged.report!.countsBySource as Record<string, number>)).toBe(
      paged.expectedPaths.length
    );
    expect(paged.report!.referenceCount).toBe(single.report!.referenceCount);
    expect(paged.report!.countsBySource).toEqual(single.report!.countsBySource);
    // ── The clause that matters most ───────────────────────────────────────
    //
    // The fingerprint is the stale-resume detector, so a page-size-dependent
    // fingerprint would discard every in-flight cursor the day the page size
    // changed. sha256 over the SORTED set, byte-identical across the two runs.
    expect(paged.report!.referenceFingerprint).toBe(single.report!.referenceFingerprint);
    expect(typeof paged.report!.referenceFingerprint).toBe('string');

    // Only the pages and the recorded page size differ.
    expect(paged.report!.pagesBySource).not.toEqual(single.report!.pagesBySource);
    expect((paged.report!.params as Record<string, unknown>).firestorePageSize).toBe(2);
    expect((single.report!.params as Record<string, unknown>).firestorePageSize).toBe(1_000);

    // Same verdicts: the one aged, unreferenced object is the one orphan in both.
    expect(paged.report!.orphanCount).toBe(1);
    expect(paged.report!.orphanCount).toBe(single.report!.orphanCount);
    expect(paged.result.tenants[0].status).toBe('completed');
  }, 15_000);

  it('aborts the tenant and moves nothing when videoTranscodes fails on its LAST page', async () => {
    const counts = Object.fromEntries(PAGED_COLLECTIONS.map((name) => [name, 5]));
    const lastPage = expectedPageCount(5, 2) - 1;

    const { result, log, bucket, report } = await run({
      counts,
      firestorePageSize: 2,
      objects: [aged(`notices/${TENANT}/loose_orphan.png`)],
      apply: true,
      hooks: {
        // The LAST page, not the first: a `try` around only the first request passes
        // every single-page fixture and swallows exactly the case pagination adds.
        failPage: (collection, pageIndex) =>
          collection === 'videoTranscodes' && pageIndex === lastPage
            ? new Error('DEADLINE_EXCEEDED on the last page')
            : undefined,
        maxPages: () => expectedPageCount(5, 2),
      },
    });

    expect(result.tenants[0].status).toBe('aborted');
    expect(result.tenants[0].abortReason).toBe('reference_source_failed');
    expect(report!.failedSources).toEqual([
      { id: 'video_transcodes', message: expect.stringContaining('DEADLINE_EXCEEDED') },
    ]);
    expect(report!.partial).toBe(true);

    // Zero moves, in the one mode that can move: the gate precedes the listing, so
    // this is structural rather than a count that happened to come out at zero.
    expect(log.filter((entry) => entry.method === 'file.copy')).toEqual([]);
    expect(log.filter((entry) => entry.method === 'file.delete')).toEqual([]);
    expect(log.filter((entry) => entry.method === 'getFiles')).toEqual([]);
    expect(bucket.contents().has(`notices/${TENANT}/loose_orphan.png`)).toBe(true);
    expect(result.tenants[0].quarantinedCount).toBe(0);

    // The pages read BEFORE the failure are still reported — `onPage` fires per page
    // successfully read, which is why the page count is a callback and not a return
    // value: a return value reports nothing for exactly the source that failed.
    expect((report!.pagesBySource as Record<string, number>).video_transcodes).toBe(lastPage);
  }, 15_000);
});
