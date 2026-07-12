// Feature: device-console-migration, Property 21: History tenant-scoping, ordering, and all-or-nothing

/**
 * Property 21: History tenant-scoping, ordering, and all-or-nothing
 * **Validates: Requirements 13.1, 13.5, 17.5**
 *
 * For an append-only `deviceAuditLogs` collection whose entries span multiple
 * tenants (with varied `actionTimeMs` and `action` values), `fetchHistory` for a
 * Selected_Tenant:
 *   - returns ONLY that tenant's entries (tenant-scoping — Req 13.1, 17.5);
 *   - orders them by `actionTimeMs` most-recent-first / DESC (Req 13.1, 17.5);
 *   - respects the optional `action` equality filter when supplied;
 *   - paginates via `nextCursor` WITHOUT dropping or duplicating any entry (the
 *     concatenation of all pages is exactly the single-page result set); and
 *   - is ALL-OR-NOTHING on retrieval failure: when the underlying query `.get()`
 *     rejects, `fetchHistory` rejects and yields NO partial entries (Req 13.5).
 *
 * The test drives the real, exported `fetchHistory` from `deviceAdminService.ts`
 * unmodified. `../firebaseAdmin` is replaced with `jest.mock` so `getFirestore()`
 * returns an in-memory Firestore fake covering exactly the query chain
 * `fetchHistory` builds:
 *
 *   db.collection('deviceAuditLogs')
 *     .where('tenantId', '==', x)
 *     [.where('action', '==', a)]
 *     .orderBy('actionTimeMs', 'desc')
 *     [.startAfter(cursorSnapshot)]
 *     .limit(n)
 *     .get()
 *
 * plus `db.collection('deviceAuditLogs').doc(id).get()` for the cursor re-read.
 * `startAfter(snapshot)` is modelled by positioning after the cursor doc's exact
 * slot in the fake's stable total DESC order, mirroring the deterministic
 * cursoring `fetchHistory` relies on.
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import { fetchHistory, DEVICE_AUDIT_LOG_COLLECTION } from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Models a single flat collection (`deviceAuditLogs`) addressed by document id.
// Query building is immutable: each `.where` / `.orderBy` / `.startAfter` /
// `.limit` returns a new `FakeQuery` carrying the accumulated constraints, which
// are then evaluated together at `.get()` time using a stable total order so
// cursor pagination is exact (no drops / duplicates) even when `actionTimeMs`
// values tie.

interface StoredDoc {
  id: string;
  data: Record<string, any>;
}

interface DocSnapshot {
  exists: boolean;
  id: string;
  data: () => Record<string, any> | undefined;
}

interface EqualityFilter {
  field: string;
  value: unknown;
}

/** Stable total DESC order: `actionTimeMs` desc, tie-broken by id desc. */
function compareDesc(a: StoredDoc, b: StoredDoc): number {
  const at = typeof a.data.actionTimeMs === 'number' ? a.data.actionTimeMs : 0;
  const bt = typeof b.data.actionTimeMs === 'number' ? b.data.actionTimeMs : 0;
  if (at !== bt) {
    return bt - at; // most-recent-first
  }
  // Deterministic tie-break so paging is exact regardless of ties.
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
}

class FakeStore {
  /** collectionName -> (id -> data) */
  private readonly collections = new Map<string, Map<string, Record<string, any>>>();
  /** When true, every collection query `.get()` rejects (models a read failure). */
  failQueryGet = false;

  seed(collection: string, id: string, data: Record<string, any>): void {
    let coll = this.collections.get(collection);
    if (!coll) {
      coll = new Map();
      this.collections.set(collection, coll);
    }
    coll.set(id, { ...data });
  }

  rows(collection: string): StoredDoc[] {
    const coll = this.collections.get(collection);
    if (!coll) {
      return [];
    }
    return [...coll.entries()].map(([id, data]) => ({ id, data }));
  }

  getDoc(collection: string, id: string): Record<string, any> | undefined {
    const data = this.collections.get(collection)?.get(id);
    return data === undefined ? undefined : { ...data };
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }
}

class FakeQuery {
  constructor(
    private readonly store: FakeStore,
    private readonly collectionName: string,
    private readonly filters: EqualityFilter[] = [],
    private readonly ordered = false,
    private readonly startAfterId: string | null = null,
    private readonly limitN: number | null = null
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== '==') {
      throw new Error(`FakeQuery only supports '==', received '${op}'`);
    }
    return new FakeQuery(
      this.store,
      this.collectionName,
      [...this.filters, { field, value }],
      this.ordered,
      this.startAfterId,
      this.limitN
    );
  }

  orderBy(field: string, direction: string): FakeQuery {
    // fetchHistory only ever orders by actionTimeMs DESC.
    if (field !== 'actionTimeMs' || direction !== 'desc') {
      throw new Error(`Unexpected orderBy(${field}, ${direction})`);
    }
    return new FakeQuery(
      this.store,
      this.collectionName,
      this.filters,
      true,
      this.startAfterId,
      this.limitN
    );
  }

  startAfter(snapshot: DocSnapshot): FakeQuery {
    return new FakeQuery(
      this.store,
      this.collectionName,
      this.filters,
      this.ordered,
      snapshot.id,
      this.limitN
    );
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(
      this.store,
      this.collectionName,
      this.filters,
      this.ordered,
      this.startAfterId,
      n
    );
  }

  async get(): Promise<{ docs: DocSnapshot[]; empty: boolean; size: number }> {
    if (this.store.failQueryGet) {
      throw new Error('deviceAuditLogs query failed');
    }

    let rows = this.store.rows(this.collectionName);

    // Equality filters (tenantId, and optionally action).
    for (const f of this.filters) {
      rows = rows.filter((row) => row.data[f.field] === f.value);
    }

    // Stable total DESC order.
    if (this.ordered) {
      rows = rows.slice().sort(compareDesc);
    }

    // startAfter: skip up to and including the cursor doc's exact slot.
    if (this.startAfterId !== null) {
      const idx = rows.findIndex((row) => row.id === this.startAfterId);
      if (idx >= 0) {
        rows = rows.slice(idx + 1);
      }
    }

    // limit.
    if (this.limitN !== null) {
      rows = rows.slice(0, this.limitN);
    }

    const docs: DocSnapshot[] = rows.map((row) => ({
      exists: true,
      id: row.id,
      data: () => ({ ...row.data }),
    }));
    return { docs, empty: docs.length === 0, size: docs.length };
  }
}

class FakeDocRef {
  constructor(
    private readonly store: FakeStore,
    private readonly collectionName: string,
    private readonly id: string
  ) {}

  async get(): Promise<DocSnapshot> {
    const data = this.store.getDoc(this.collectionName, this.id);
    return {
      exists: data !== undefined,
      id: this.id,
      data: () => data,
    };
  }
}

class FakeCollectionRef {
  constructor(
    private readonly store: FakeStore,
    private readonly name: string
  ) {}

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.store, this.name, id);
  }

  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.name).where(field, op, value);
  }

  orderBy(field: string, direction: string): FakeQuery {
    return new FakeQuery(this.store, this.name).orderBy(field, direction);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.store, this.name).limit(n);
  }

  get(): Promise<{ docs: DocSnapshot[]; empty: boolean; size: number }> {
    return new FakeQuery(this.store, this.name).get();
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const TENANTS = ['t1', 't2', 't3'] as const;
const ACTIONS = ['force_logout', 'ban', 'unban', 'delete', 'restore'] as const;

const tenantArb = fc.constantFrom(...TENANTS);
const actionArb = fc.constantFrom(...ACTIONS);

/**
 * A single audit-doc spec. `actionTimeMs` is drawn from a small range so ties
 * occur, exercising the stable tie-break during ordering and pagination.
 */
const auditSpecArb = fc.record({
  tenantId: tenantArb,
  action: actionArb,
  actionTimeMs: fc.integer({ min: 1_700_000_000_000, max: 1_700_000_000_050 }),
});

/** A collection of audit docs spanning multiple tenants and actions. */
const auditSetArb = fc.array(auditSpecArb, { minLength: 0, maxLength: 25 });

/** Seed generated specs into a fresh store; return the stored docs. */
function seedAudits(
  store: FakeStore,
  specs: ReadonlyArray<{ tenantId: string; action: string; actionTimeMs: number }>
): StoredDoc[] {
  return specs.map((spec, index) => {
    const id = `audit_${index}`;
    const data = {
      tenantId: spec.tenantId,
      action: spec.action,
      actionTimeMs: spec.actionTimeMs,
      createdAt: new Date(spec.actionTimeMs).toISOString(),
      actorEmail: `admin${index}@example.com`,
    };
    store.seed(DEVICE_AUDIT_LOG_COLLECTION, id, data);
    return { id, data };
  });
}

/** Expected matching ids for a tenant (+ optional action) — the independent oracle. */
function expectedIds(
  seeded: StoredDoc[],
  tenantId: string,
  action?: string
): Set<string> {
  return new Set(
    seeded
      .filter(
        (doc) =>
          doc.data.tenantId === tenantId &&
          (action === undefined ? true : doc.data.action === action)
      )
      .map((doc) => doc.id)
  );
}

function assertDescOrdered(entries: Array<{ actionTimeMs: number }>): void {
  for (let i = 1; i < entries.length; i += 1) {
    expect(entries[i - 1].actionTimeMs).toBeGreaterThanOrEqual(entries[i].actionTimeMs);
  }
}

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

describe('Property 21 — history tenant-scoping, ordering, and all-or-nothing', () => {
  it(
    'returns ONLY the selected tenant\'s entries, DESC by actionTimeMs, honoring the optional action filter (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          auditSetArb,
          tenantArb,
          fc.option(actionArb, { nil: undefined }),
          async (specs, selectedTenant, actionFilter) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);
            const seeded = seedAudits(store, specs);

            const result = await fetchHistory({
              tenantId: selectedTenant,
              action: actionFilter,
              limit: 1000, // large enough to fetch everything in one page
            });

            // Tenant-scoping: every returned entry belongs to the selected tenant.
            for (const entry of result.entries) {
              expect(entry.tenantId).toBe(selectedTenant);
            }

            // Optional action filter respected.
            if (actionFilter !== undefined) {
              for (const entry of result.entries) {
                expect(entry.action).toBe(actionFilter);
              }
            }

            // Exactly the matching set — nothing from other tenants leaks in,
            // nothing matching is dropped.
            const gotIds = new Set(result.entries.map((e) => e.id));
            expect(gotIds).toEqual(expectedIds(seeded, selectedTenant, actionFilter));

            // Most-recent-first ordering.
            assertDescOrdered(result.entries);

            // Whole set fit in one page.
            expect(result.hasMore).toBe(false);
            expect(result.nextCursor).toBeUndefined();
          }
        ),
        { numRuns: 150 }
      );
    },
    30_000
  );

  it(
    'paginates via nextCursor without dropping or duplicating any entry (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          auditSetArb,
          tenantArb,
          fc.option(actionArb, { nil: undefined }),
          fc.integer({ min: 1, max: 6 }),
          async (specs, selectedTenant, actionFilter, pageSize) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);
            const seeded = seedAudits(store, specs);

            const collected: Array<{ id: string; actionTimeMs: number }> = [];
            let cursor: string | undefined;
            let guard = 0;

            // Walk every page.
            // eslint-disable-next-line no-constant-condition
            while (true) {
              const page = await fetchHistory({
                tenantId: selectedTenant,
                action: actionFilter,
                limit: pageSize,
                cursor,
              });

              // Each page stays scoped, filtered and DESC-ordered.
              for (const entry of page.entries) {
                expect(entry.tenantId).toBe(selectedTenant);
                if (actionFilter !== undefined) {
                  expect(entry.action).toBe(actionFilter);
                }
              }
              assertDescOrdered(page.entries);

              // nextCursor present iff there is more to read.
              if (page.hasMore) {
                expect(typeof page.nextCursor).toBe('string');
              } else {
                expect(page.nextCursor).toBeUndefined();
              }

              collected.push(
                ...page.entries.map((e) => ({ id: e.id, actionTimeMs: e.actionTimeMs }))
              );

              if (!page.hasMore) {
                break;
              }
              cursor = page.nextCursor;
              guard += 1;
              if (guard > 1000) {
                throw new Error('pagination did not terminate');
              }
            }

            // No duplicates across page boundaries.
            const ids = collected.map((c) => c.id);
            expect(new Set(ids).size).toBe(ids.length);

            // Nothing dropped, nothing extra vs. the independent oracle.
            expect(new Set(ids)).toEqual(expectedIds(seeded, selectedTenant, actionFilter));

            // The concatenation of all pages is globally DESC-ordered.
            assertDescOrdered(collected);
          }
        ),
        { numRuns: 150 }
      );
    },
    30_000
  );

  it(
    'is all-or-nothing: when the underlying query rejects, fetchHistory rejects and yields NO partial entries (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          auditSetArb,
          tenantArb,
          fc.option(actionArb, { nil: undefined }),
          async (specs, selectedTenant, actionFilter) => {
            const store = new FakeStore();
            store.failQueryGet = true; // the collection query `.get()` will throw
            mockedGetFirestore.mockReturnValue(store as any);
            seedAudits(store, specs);

            let settled: { entries: unknown } | undefined;
            let rejected = false;
            try {
              settled = await fetchHistory({
                tenantId: selectedTenant,
                action: actionFilter,
                // no cursor: the only `.get()` is the main query, which rejects
              });
            } catch {
              rejected = true;
            }

            // Rejected — so there is no resolved value carrying partial entries.
            expect(rejected).toBe(true);
            expect(settled).toBeUndefined();
          }
        ),
        { numRuns: 120 }
      );
    },
    30_000
  );
});
