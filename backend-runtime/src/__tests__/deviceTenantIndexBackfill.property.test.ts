// Feature: device-tenant-index, Property 7: Backfill converges and is idempotent

/**
 * Property 7: Backfill converges and is idempotent
 * **Validates: Requirements 4.1, 4.5, 4.8**
 *
 * *For any* initial population of device documents (each with an arbitrary,
 * possibly-missing or possibly-stale `tenantIndex`), running the backfill to
 * completion leaves every device's `tenantIndex` equal to `deriveTenantIndex`
 * of its source; running it again performs no writes (each device is skipped as
 * already-correct) and preserves that equality.
 *
 * The property drives the REAL, exported `runDeviceTenantIndexBackfill` core
 * (backend-runtime/src/jobs/deviceTenantIndexBackfill.ts) against an in-memory
 * Firestore store MODEL that implements exactly the surface the core uses:
 *   - `db.doc(path).get()/.set(data, { merge })` for the Backfill_Progress doc
 *     (and cursor-resume snapshots),
 *   - `db.collectionGroup('devices').orderBy(documentId()).startAfter(snap)
 *     .limit(n).get()` for stable, document-id-ordered pagination, and
 *   - `db.batch()` → `batch.update(ref, patch)` / `batch.commit()` for the
 *     changed-only WriteBatch.
 * The store counts device `update` writes so the "second run performs ZERO
 * writes" half of the property is asserted directly.
 *
 * To exercise skip-when-correct convergence (not just the completed-state
 * short-circuit), the SECOND run is invoked with `force: true` so it re-sweeps
 * the whole population and must still stage zero writes because every device is
 * already correct. No mocking of the core, no real Firestore.
 */

import * as fc from 'fast-check';
import * as admin from 'firebase-admin';

import { deriveTenantIndex } from '../deviceAdminService';
import { runDeviceTenantIndexBackfill } from '../jobs/deviceTenantIndexBackfill';

const PROGRESS_PATH = 'migrationProgress/deviceTenantIndexBackfill';

// ---------------------------------------------------------------------------
// In-memory Firestore store model (only the surface the backfill core uses)
// ---------------------------------------------------------------------------

interface StoredDoc {
  path: string;
  data: Record<string, unknown>;
}

interface WriteCounters {
  deviceUpdates: number; // device-doc `tenantIndex` writes staged via batch.update
}

class FakeSnap {
  constructor(
    private readonly store: FakeStore,
    readonly ref: { path: string; id: string },
    private readonly _data: Record<string, unknown> | undefined
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  get id(): string {
    return this.ref.id;
  }
  data(): Record<string, unknown> | undefined {
    return this._data ? { ...this._data } : undefined;
  }
  get(field: string): unknown {
    return this._data ? this._data[field] : undefined;
  }
}

function idOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

function isDevicePath(path: string): boolean {
  // user_devices/{email}/devices/{deviceId}
  const parts = path.split('/');
  return parts.length === 4 && parts[0] === 'user_devices' && parts[2] === 'devices';
}

class FakeStore {
  private readonly docs = new Map<string, Record<string, unknown>>();
  readonly counters: WriteCounters = { deviceUpdates: 0 };

  constructor(devices: StoredDoc[]) {
    for (const d of devices) {
      this.docs.set(d.path, { ...d.data });
    }
  }

  getRaw(path: string): Record<string, unknown> | undefined {
    return this.docs.get(path);
  }

  private mergeSet(path: string, patch: Record<string, unknown>): void {
    const existing = this.docs.get(path) ?? {};
    const next: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value instanceof DeleteSentinel) {
        delete next[key];
      } else if (value instanceof ServerTimestampSentinel) {
        next[key] = new Date().toISOString();
      } else {
        next[key] = value;
      }
    }
    this.docs.set(path, next);
  }

  doc(path: string) {
    const store = this;
    return {
      path,
      id: idOf(path),
      async get() {
        const data = store.docs.get(path);
        return new FakeSnap(store, { path, id: idOf(path) }, data ? { ...data } : undefined);
      },
      async set(patch: Record<string, unknown>, options?: { merge?: boolean }) {
        if (options?.merge) {
          store.mergeSet(path, patch);
        } else {
          store.docs.set(path, { ...patch });
        }
      },
    };
  }

  collectionGroup(name: string) {
    if (name !== 'devices') {
      throw new Error(`unexpected collectionGroup: ${name}`);
    }
    const store = this;
    const build = (state: { after?: string; limit?: number }) => ({
      orderBy(_field: unknown) {
        return build({ ...state });
      },
      startAfter(cursor: unknown) {
        // The core passes a DocumentSnapshot; read its ref.path (document-id
        // ordering over the collection group => order by full resource path).
        const afterPath =
          cursor && typeof cursor === 'object' && 'ref' in (cursor as any)
            ? (cursor as any).ref.path
            : String(cursor);
        return build({ ...state, after: afterPath });
      },
      limit(n: number) {
        return build({ ...state, limit: n });
      },
      async get() {
        let paths = [...store.docs.keys()].filter(isDevicePath).sort();
        if (state.after) {
          paths = paths.filter((p) => p > state.after!);
        }
        if (typeof state.limit === 'number') {
          paths = paths.slice(0, state.limit);
        }
        const docs = paths.map(
          (p) => new FakeSnap(store, { path: p, id: idOf(p) }, { ...store.docs.get(p)! })
        );
        return { docs };
      },
    });
    return build({});
  }

  batch() {
    const store = this;
    const ops: Array<{ path: string; patch: Record<string, unknown> }> = [];
    return {
      update(ref: { path: string }, patch: Record<string, unknown>) {
        store.counters.deviceUpdates += 1;
        ops.push({ path: ref.path, patch });
      },
      async commit() {
        for (const op of ops) {
          store.mergeSet(op.path, op.patch);
        }
      },
    };
  }
}

// Marker classes to recognize the firebase-admin FieldValue sentinels inside the
// fake store's merge without needing a live Firestore. We swap the real
// `admin.firestore.FieldValue` factory for these markers for the duration of the
// suite (the sentinels are opaque objects in production too).
class DeleteSentinel {}
class ServerTimestampSentinel {}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const TENANTS = ['t1', 't2', 't3', 't4'] as const;
const tenantIdArb = fc.constantFrom<string>(...TENANTS);

const membershipArb = fc.record(
  {
    tenantId: fc.oneof(tenantIdArb, fc.constant(''), fc.constant('  ')),
    status: fc.constantFrom<string | undefined>('active', 'Active', 'ACTIVE', 'inactive', 'revoked', undefined),
  },
  { requiredKeys: ['tenantId'] }
);

const scopeArb = fc.record(
  {
    tenantIds: fc.array(fc.oneof(tenantIdArb, fc.constant(''), fc.constant(' ')), { maxLength: 4 }),
    activeTenantId: fc.oneof(tenantIdArb, fc.constant(''), fc.constant(null)),
    tenantMemberships: fc.array(membershipArb, { maxLength: 3 }),
  },
  { requiredKeys: [] }
);

// An arbitrary preexisting `tenantIndex`: missing, empty, stale, wrong-order, or
// carrying junk — the backfill must converge all of these to the derived value.
const preexistingIndexArb = fc.oneof(
  fc.constant<undefined>(undefined),
  fc.constant<string[]>([]),
  fc.array(fc.oneof(tenantIdArb, fc.constant('stale-x'), fc.constant('zzz')), { maxLength: 5 })
);

/** A population of device docs across a handful of owners with unique paths. */
const populationArb = fc
  .array(
    fc.record({
      ownerIndex: fc.integer({ min: 0, max: 3 }),
      scope: scopeArb,
      preexisting: preexistingIndexArb,
    }),
    { maxLength: 14 }
  )
  .map((entries) =>
    entries.map((entry, i) => {
      const email = `owner-${entry.ownerIndex}@example.com`;
      const deviceId = `dev-${i}`;
      const data: Record<string, unknown> = { deviceId, ...entry.scope };
      if (entry.preexisting !== undefined) {
        data.tenantIndex = entry.preexisting;
      }
      return {
        path: `user_devices/${email}/devices/${deviceId}`,
        data,
      } as StoredDoc;
    })
  );

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 7 — backfill converges and is idempotent', () => {
  let realFieldValue: typeof admin.firestore.FieldValue;

  beforeAll(() => {
    realFieldValue = admin.firestore.FieldValue;
    // Replace the sentinel factory so the in-memory store can recognize
    // serverTimestamp()/delete() without a live Firestore connection.
    (admin.firestore as unknown as { FieldValue: unknown }).FieldValue = {
      serverTimestamp: () => new ServerTimestampSentinel(),
      delete: () => new DeleteSentinel(),
    };
  });

  afterAll(() => {
    (admin.firestore as unknown as { FieldValue: unknown }).FieldValue = realFieldValue;
  });

  it(
    'converges every device to deriveTenantIndex(source) and a second (forced) run performs zero writes (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          populationArb,
          fc.integer({ min: 1, max: 5 }),
          async (population, batchSize) => {
            const store = new FakeStore(population);
            const db = store as unknown as admin.firestore.Firestore;

            // Expected canonical index per device path (source of truth).
            const expected = new Map<string, string[]>();
            for (const dev of population) {
              expected.set(dev.path, deriveTenantIndex(dev.data as any));
            }

            // --- First run: converge from arbitrary/stale/missing indexes. ---
            const first = await runDeviceTenantIndexBackfill(db, { batchSize });
            expect(first.completed).toBe(true);
            expect(first.processedCount).toBe(population.length);

            for (const dev of population) {
              const stored = store.getRaw(dev.path);
              expect(stored).toBeDefined();
              expect(stored!.tenantIndex).toEqual(expected.get(dev.path));
            }

            // Completion recorded (Req 4.9).
            expect(store.getRaw(PROGRESS_PATH)?.status).toBe('completed');

            // --- Second run (forced re-sweep): must stage ZERO device writes. ---
            store.counters.deviceUpdates = 0;
            const second = await runDeviceTenantIndexBackfill(db, { batchSize, force: true });
            expect(second.completed).toBe(true);
            expect(store.counters.deviceUpdates).toBe(0); // idempotent (Req 4.5, 4.8)

            // Equality preserved after the second run.
            for (const dev of population) {
              expect(store.getRaw(dev.path)!.tenantIndex).toEqual(expected.get(dev.path));
            }
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    60_000
  );
});
