// Feature: device-console-migration, Property 22: Timeline ascending order with stable tie-break

/**
 * Property 22: Timeline ascending order with stable tie-break
 * **Validates: Requirements 19.1, 19.4**
 *
 * For any device's recorded actions, `fetchTimeline` returns ONLY that
 * tenant+device's entries, ordered by `actionTimeMs` from oldest to newest
 * (ascending — Requirement 19.1), and entries that share an identical
 * `actionTimeMs` are ordered deterministically by their audit-entry `id`
 * (Requirement 19.4) so the sequence is identical across repeated openings of
 * the same device's timeline.
 *
 * `fetchTimeline` reads through Firestore, so this suite replaces
 * `getFirestore()` (from `../firebaseAdmin`) with an in-memory Firestore fake
 * that supports exactly the query chain the helper builds:
 *
 *   collection('deviceAuditLogs')
 *     .where('tenantId', '==', x)
 *     .where('targetDeviceId', '==', d)
 *     .orderBy('actionTimeMs', 'asc')
 *     .get()
 *
 * Crucially, the fake honours `orderBy('actionTimeMs','asc')` but returns docs
 * in a RANDOMIZED order AMONG EQUAL `actionTimeMs` values (Firestore itself
 * makes no promise about the intra-tie order). It also re-shuffles the
 * underlying order on every `.get()` — so the two calls in the stability check
 * receive different physical orderings. That way the ONLY thing that can make
 * the output deterministic is the in-memory id tie-break inside `fetchTimeline`
 * — which is exactly what this property exercises.
 *
 * The seeded docs mix the target tenant+device entries with other-tenant and
 * other-device noise (which must be excluded), and pack `actionTimeMs` into a
 * tiny pool so ties are plentiful. `deviceAdminService.ts` is exercised
 * unmodified.
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import { fetchTimeline, DEVICE_AUDIT_LOG_COLLECTION } from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

// ---------------------------------------------------------------------------
// Deterministic PRNG + Fisher-Yates shuffle
// ---------------------------------------------------------------------------
//
// A tiny mulberry32 PRNG seeded from a fast-check-generated integer keeps the
// fake's shuffling reproducible for any counterexample while still varying
// between successive `.get()` calls (the generator state advances each call).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// In-memory Firestore fake supporting the timeline query chain
// ---------------------------------------------------------------------------

interface SeededDoc {
  id: string;
  data: Record<string, unknown>;
}

interface EqualityFilter {
  field: string;
  value: unknown;
}

/** Snapshot shape consumed by `fetchTimeline` (`doc.id` + `doc.data()`). */
interface FakeQuerySnapshot {
  docs: Array<{ id: string; data: () => Record<string, unknown> }>;
  empty: boolean;
  size: number;
}

/** Snapshot returned by a direct `docRef.get()` (existence check). */
interface FakeDocSnapshot {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

/**
 * A direct document reference addressed by full path (e.g.
 * `user_devices/{email}/devices/{deviceId}`). Supports `.collection()` for
 * nesting and `.get()` for the existence + tenant-scope check `fetchTimeline`
 * now performs before reading the audit log.
 */
class FakeDocRef {
  constructor(
    private readonly store: FakeFirestore,
    private readonly path: string
  ) {}

  collection(name: string): FakeQuery {
    return new FakeQuery(this.store, `${this.path}/${name}`, [], null, null);
  }

  async get(): Promise<FakeDocSnapshot> {
    const data = this.store.getDoc(this.path);
    return { exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
  }
}

/**
 * A chainable query over one collection. `where(field,'==',value)` accumulates
 * an equality filter; `orderBy(field,'asc')` records the primary sort;
 * `limit(n)` caps the returned docs; `doc(id)` addresses a single document.
 * `.get()` filters, then shuffles (via the store's advancing PRNG) and
 * stable-sorts by the ordered field — leaving equal-key docs in a randomized
 * order — before applying any `limit`.
 */
class FakeQuery {
  constructor(
    private readonly store: FakeFirestore,
    private readonly collectionName: string,
    private readonly filters: EqualityFilter[],
    private readonly orderField: string | null,
    private readonly limitN: number | null
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== '==') {
      throw new Error(`FakeQuery only supports '==' filters, got '${op}'`);
    }
    return new FakeQuery(
      this.store,
      this.collectionName,
      [...this.filters, { field, value }],
      this.orderField,
      this.limitN
    );
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): FakeQuery {
    if (direction !== 'asc') {
      throw new Error(`FakeQuery only exercises ascending orderBy, got '${direction}'`);
    }
    return new FakeQuery(this.store, this.collectionName, this.filters, field, this.limitN);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.store, this.collectionName, this.filters, this.orderField, n);
  }

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.store, `${this.collectionName}/${id}`);
  }

  async get(): Promise<FakeQuerySnapshot> {
    const source = this.store.collectionDocs(this.collectionName);
    const matched = source.filter((doc) =>
      this.filters.every((f) => doc.data[f.field] === f.value)
    );

    // Randomize the physical order (differently on every `.get()`), then a
    // STABLE sort by the ordered field leaves equal-key docs shuffled — faithful
    // to Firestore's unspecified intra-tie ordering.
    const shuffled = this.store.shuffle(matched);
    if (this.orderField !== null) {
      const field = this.orderField;
      shuffled.sort((a, b) => {
        const av = a.data[field] as number;
        const bv = b.data[field] as number;
        return av === bv ? 0 : av - bv;
      });
    }

    const limited = this.limitN !== null ? shuffled.slice(0, this.limitN) : shuffled;

    return {
      docs: limited.map((doc) => ({ id: doc.id, data: () => ({ ...doc.data }) })),
      empty: limited.length === 0,
      size: limited.length,
    };
  }
}

class FakeFirestore {
  private readonly collections = new Map<string, SeededDoc[]>();
  private readonly docs = new Map<string, Record<string, unknown>>();
  private readonly rng: () => number;

  constructor(shuffleSeed: number) {
    this.rng = mulberry32(shuffleSeed);
  }

  /** Seed one audit doc directly (test setup only). */
  seed(collectionName: string, doc: SeededDoc): void {
    const list = this.collections.get(collectionName) ?? [];
    list.push({ id: doc.id, data: { ...doc.data } });
    this.collections.set(collectionName, list);
  }

  /** Seed a single document addressed by full path (test setup only). */
  seedDoc(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, { ...data });
  }

  /** Read a single document by full path, or `undefined` when absent. */
  getDoc(path: string): Record<string, unknown> | undefined {
    return this.docs.get(path);
  }

  collectionDocs(collectionName: string): SeededDoc[] {
    return this.collections.get(collectionName) ?? [];
  }

  /** Fisher-Yates shuffle using the shared, advancing PRNG (varies per call). */
  shuffle(docs: SeededDoc[]): SeededDoc[] {
    const copy = [...docs];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  collection(name: string): FakeQuery {
    return new FakeQuery(this, name, [], null, null);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const TARGET_TENANT = 't1';
const TARGET_DEVICE = 'device-target';
const OTHER_TENANTS = ['tenant-other-1', 'tenant-other-2'];
const OTHER_DEVICES = ['device-other-1', 'device-other-2'];

/** A slash-free lowercase/digit token used for random, unique audit-doc ids. */
const idTokenArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(''));

// Tenant/device pools biased toward the target so target entries (and ties)
// are plentiful, while still emitting other-tenant / other-device noise.
const tenantArb = fc.constantFrom(TARGET_TENANT, TARGET_TENANT, TARGET_TENANT, ...OTHER_TENANTS);
const deviceArb = fc.constantFrom(TARGET_DEVICE, TARGET_DEVICE, TARGET_DEVICE, ...OTHER_DEVICES);

// A tiny action-time pool (3 distinct values) => frequent `actionTimeMs` ties.
const actionTimeMsArb = fc.constantFrom(1000, 2000, 3000);

const actionArb = fc.constantFrom(
  'ban',
  'unban',
  'force_logout',
  'delete',
  'restore',
  'notify'
);

/** One generated audit doc, including its (globally unique) Firestore id. */
const auditDocArb = fc.record({
  id: idTokenArb,
  tenantId: tenantArb,
  targetDeviceId: deviceArb,
  actionTimeMs: actionTimeMsArb,
  action: actionArb,
  actorEmail: fc.option(idTokenArb.map((s) => `admin_${s}@example.com`), { nil: undefined }),
});

type GeneratedAuditDoc = {
  id: string;
  tenantId: string;
  targetDeviceId: string;
  actionTimeMs: number;
  action: string;
  actorEmail?: string;
};

/** Distinct-id set of audit docs (Firestore ids are unique). */
const auditDocsArb = fc.uniqueArray(auditDocArb, {
  selector: (doc) => doc.id,
  minLength: 1,
  maxLength: 50,
});

// ---------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------

describe('Property 22 — timeline ascending order with stable id tie-break', () => {
  it(
    'fetchTimeline returns only the target tenant+device entries, oldest-first, with a deterministic id tie-break that is stable across repeated calls (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          auditDocsArb,
          fc.integer({ min: 1, max: 0x7fffffff }),
          idTokenArb.map((s) => `${s}@example.com`),
          async (docs: GeneratedAuditDoc[], shuffleSeed, email) => {
            const db = new FakeFirestore(shuffleSeed);
            mockedGetFirestore.mockReturnValue(db as never);

            // `fetchTimeline` now asserts the device exists and is tenant-scoped
            // before reading the audit log, so seed a target device doc scoped
            // to TARGET_TENANT (this property covers ordering, not the 404/403
            // paths — those are exercised by the fetchTimeline unit suite).
            db.seedDoc(`user_devices/${email}/devices/${TARGET_DEVICE}`, {
              tenantIds: [TARGET_TENANT],
            });

            for (const doc of docs) {
              const data: Record<string, unknown> = {
                tenantId: doc.tenantId,
                targetDeviceId: doc.targetDeviceId,
                actionTimeMs: doc.actionTimeMs,
                action: doc.action,
                createdAt: new Date(doc.actionTimeMs).toISOString(),
              };
              if (doc.actorEmail !== undefined) {
                data.actorEmail = doc.actorEmail;
              }
              db.seed(DEVICE_AUDIT_LOG_COLLECTION, { id: doc.id, data });
            }

            // Independent oracle: the target entries in the exact order the helper
            // must produce (actionTimeMs asc, then id via localeCompare asc).
            const expectedTargets = docs.filter(
              (doc) => doc.tenantId === TARGET_TENANT && doc.targetDeviceId === TARGET_DEVICE
            );
            const expectedIds = [...expectedTargets]
              .sort((a, b) =>
                a.actionTimeMs !== b.actionTimeMs
                  ? a.actionTimeMs - b.actionTimeMs
                  : a.id.localeCompare(b.id)
              )
              .map((doc) => doc.id);

            const first = await fetchTimeline({
              tenantId: TARGET_TENANT,
              email,
              deviceId: TARGET_DEVICE,
            });
            // Second call re-runs the query; the fake reshuffles the physical
            // return order, so identical output can only come from the tie-break.
            const second = await fetchTimeline({
              tenantId: TARGET_TENANT,
              email,
              deviceId: TARGET_DEVICE,
            });

            const entries = first.entries;

            // (1) Only the requested tenant + device entries are surfaced (noise
            //     from other tenants / other devices is excluded).
            for (const entry of entries) {
              expect(entry.tenantId).toBe(TARGET_TENANT);
              expect(entry.targetDeviceId).toBe(TARGET_DEVICE);
            }
            expect(entries).toHaveLength(expectedTargets.length);

            // (2) actionTimeMs is non-decreasing (ascending, oldest-first — Req 19.1).
            for (let i = 1; i < entries.length; i += 1) {
              expect(entries[i].actionTimeMs).toBeGreaterThanOrEqual(entries[i - 1].actionTimeMs);
            }

            // (3) Within equal actionTimeMs, entries are strictly ordered by id
            //     ascending (deterministic tie-break — Req 19.4).
            for (let i = 1; i < entries.length; i += 1) {
              if (entries[i].actionTimeMs === entries[i - 1].actionTimeMs) {
                expect(entries[i - 1].id.localeCompare(entries[i].id)).toBeLessThan(0);
              }
            }

            // Exact ordering matches the independent oracle.
            expect(entries.map((e) => e.id)).toEqual(expectedIds);

            // (4) Stability: a repeated opening yields the identical id sequence,
            //     even though the fake shuffled the underlying order differently.
            expect(second.entries.map((e) => e.id)).toEqual(entries.map((e) => e.id));
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );
});
