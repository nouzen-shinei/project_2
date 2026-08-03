// Feature: device-tenant-index, Property 5: Scoped listing equals full-scan listing (and the predicate-associated set)

/**
 * Property 5: Scoped listing equals full-scan listing (and the predicate-associated set)
 * **Validates: Requirements 6.3, 6.4, 6.5, 7.1**
 *
 * For any generated multi-owner / multi-tenant population (with a FRESH
 * `tenantIndex` derived from each device's scoping source) and any Selected
 * tenant `t`, the scoped indexed path and the retained full-scan path must
 * return the SAME set of projected `DeviceAdminRecord`s — identical fields,
 * owner-email/display-name attribution, and active-ban enrichment — and that set
 * must equal the `matchesTenantDevice`-associated set. Because counts / ordering
 * / grouping are pure functions of the returned set, `computeCounts` and
 * `sortAndGroup` must also agree between the two paths.
 *
 * Both paths are exercised through the REAL, exported `listTenantDevices` by
 * toggling the feature flag (off ⇒ full-scan fallback; on + backfill "completed"
 * ⇒ scoped) against an in-memory Firestore fake that serves both the full scan
 * (`collection('user_devices').get()` + `collectionGroup('devices').get()`) and
 * the scoped query (`collectionGroup('devices').where('tenantIndex',
 * 'array-contains', t).get()` + `getAll(distinct parents)`). No real Firestore.
 */

import * as fc from 'fast-check';

import {
  listTenantDevices,
  deriveTenantIndex,
  computeCounts,
  sortAndGroup,
  type DeviceAdminRecord,
  type DeviceSort,
} from '../deviceAdminService';
import { matchesTenantDevice } from '../tenantDeviceFilter';

// The Firestore accessor is mocked so both listing paths run against our
// in-memory fake instead of a live client.
jest.mock('../firebaseAdmin', () => ({
  getFirestore: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getFirestore } = require('../firebaseAdmin') as { getFirestore: jest.Mock };

// The scoped-listing flag is always read/written through the literal key
// `process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED` (never `process.env[someVar]`)
// so the env var stays statically analysable — see `expo/no-dynamic-env-var`.

// ---------------------------------------------------------------------------
// In-memory Firestore fake (serves both the full scan and the scoped query)
// ---------------------------------------------------------------------------

interface SeedDevice {
  deviceId: string;
  data: Record<string, unknown>;
}
interface SeedOwner {
  email: string;
  parentData: Record<string, unknown>;
  devices: SeedDevice[];
}
interface SeedBan {
  deviceFingerprint: string;
  isActive: boolean;
}
interface Population {
  owners: SeedOwner[];
  bans: SeedBan[];
}

class FakeDocSnap {
  constructor(
    readonly id: string,
    private readonly _data: Record<string, unknown> | undefined,
    readonly ref: unknown = null
  ) {}
  get exists(): boolean {
    return this._data !== undefined;
  }
  data(): Record<string, unknown> | undefined {
    return this._data;
  }
  get(field: string): unknown {
    return this._data ? this._data[field] : undefined;
  }
}

function buildFakeDb(pop: Population, backfillCompleted: boolean) {
  const deviceSnaps: FakeDocSnap[] = [];
  const parentDataByEmail = new Map<string, Record<string, unknown>>();
  for (const owner of pop.owners) {
    parentDataByEmail.set(owner.email, owner.parentData);
    for (const d of owner.devices) {
      const ref = { parent: { parent: { id: owner.email } } };
      deviceSnaps.push(new FakeDocSnap(d.deviceId, d.data, ref));
    }
  }

  return {
    collection(name: string) {
      if (name === 'device_bans') {
        return {
          where(field: string, _op: string, value: unknown) {
            return {
              async get() {
                const docs = pop.bans
                  .filter((b) => (b as Record<string, unknown>)[field] === value)
                  .map((b, i) => new FakeDocSnap(`ban-${i}`, b as Record<string, unknown>));
                return { docs };
              },
            };
          },
        };
      }
      if (name === 'user_devices') {
        return {
          async get() {
            const docs = [...parentDataByEmail.entries()].map(
              ([email, data]) => new FakeDocSnap(email, data)
            );
            return { docs };
          },
          doc(id: string) {
            return { __userDeviceDocId: id };
          },
        };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
    collectionGroup(name: string) {
      if (name !== 'devices') {
        throw new Error(`unexpected collectionGroup: ${name}`);
      }
      return {
        async get() {
          return { docs: [...deviceSnaps] };
        },
        where(field: string, op: string, value: unknown) {
          if (field !== 'tenantIndex' || op !== 'array-contains') {
            throw new Error(`unexpected where: ${field} ${op}`);
          }
          return {
            async get() {
              const docs = deviceSnaps.filter((snap) => {
                const idx = snap.get('tenantIndex');
                return Array.isArray(idx) && idx.includes(value);
              });
              return { docs };
            },
          };
        },
      };
    },
    async getAll(...refs: Array<{ __userDeviceDocId: string }>) {
      return refs.map((ref) => {
        const id = ref.__userDeviceDocId;
        return new FakeDocSnap(id, parentDataByEmail.get(id));
      });
    },
    doc(path: string) {
      if (path === 'migrationProgress/deviceTenantIndexBackfill') {
        return {
          async get() {
            return new FakeDocSnap(
              'deviceTenantIndexBackfill',
              backfillCompleted ? { status: 'completed' } : undefined
            );
          },
        };
      }
      throw new Error(`unexpected doc: ${path}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const TENANTS = ['t1', 't2', 't3'] as const;
const tenantIdArb = fc.constantFrom(...TENANTS);
const fingerprintArb = fc.constantFrom('fp-a', 'fp-b', 'fp-c', 'fp-d');

const membershipArb = fc.record({
  tenantId: tenantIdArb,
  status: fc.constantFrom<string | undefined>('active', 'Active', 'inactive', 'pending', undefined),
});

/** A single device's scoping source + a few projected-through fields. */
const deviceShapeArb = fc.record(
  {
    tenantIds: fc.uniqueArray(tenantIdArb, { maxLength: TENANTS.length }),
    activeTenantId: tenantIdArb,
    tenantMemberships: fc.array(membershipArb, { maxLength: 3 }),
    deviceSeedHash: fingerprintArb, // deterministic ban fingerprint
    deviceType: fc.constantFrom('web', 'mobile', 'tablet'),
    deviceName: fc.string({ maxLength: 12 }),
    isHardBanned: fc.boolean(),
  },
  { requiredKeys: ['deviceSeedHash'] }
);

const ownerArb = fc.record({
  hasDisplayName: fc.boolean(),
  deviceShapes: fc.array(deviceShapeArb, { maxLength: 4 }),
});

const populationArb = fc.array(ownerArb, { maxLength: 4 }).chain((owners) =>
  fc
    .uniqueArray(fingerprintArb, { maxLength: 4 })
    .map((activeBanFps) => {
      let deviceCounter = 0;
      const seedOwners: SeedOwner[] = owners.map((owner, ownerIdx) => {
        const email = `owner-${ownerIdx}@example.com`;
        const parentData: Record<string, unknown> = owner.hasDisplayName
          ? { displayName: `Owner ${ownerIdx}` }
          : {};
        const devices: SeedDevice[] = owner.deviceShapes.map((shape) => {
          const deviceId = `dev-${deviceCounter++}`;
          // A FRESH index: exactly what deriveTenantIndex produces from the source.
          const data: Record<string, unknown> = { ...shape, tenantIndex: deriveTenantIndex(shape) };
          return { deviceId, data };
        });
        return { email, parentData, devices };
      });
      const bans: SeedBan[] = activeBanFps.map((fp) => ({ deviceFingerprint: fp, isActive: true }));
      // An inactive ban that must NOT enrich any device (isActive filter).
      bans.push({ deviceFingerprint: 'fp-a', isActive: false });
      return { owners: seedOwners, bans } as Population;
    })
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortById(records: DeviceAdminRecord[]): DeviceAdminRecord[] {
  return [...records].sort((a, b) => (a.deviceId ?? '').localeCompare(b.deviceId ?? ''));
}

/** deviceIds of the population's devices associated with `t` per matchesTenantDevice. */
function associatedDeviceIds(pop: Population, t: string): string[] {
  const ids: string[] = [];
  for (const owner of pop.owners) {
    for (const d of owner.devices) {
      if (matchesTenantDevice(d.data as never, t)) {
        ids.push(d.deviceId);
      }
    }
  }
  return ids.sort();
}

async function runFallback(pop: Population, t: string): Promise<DeviceAdminRecord[]> {
  delete process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED; // flag off ⇒ full-scan fallback
  getFirestore.mockReturnValue(buildFakeDb(pop, false));
  return listTenantDevices(t);
}

async function runScoped(pop: Population, t: string): Promise<DeviceAdminRecord[]> {
  process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED = '1'; // flag on + backfill completed ⇒ scoped
  getFirestore.mockReturnValue(buildFakeDb(pop, true));
  return listTenantDevices(t);
}

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 5 — scoped listing equals full-scan listing (and the predicate set)', () => {
  const originalFlag = process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED;
  afterAll(() => {
    if (originalFlag === undefined) delete process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED;
    else process.env.DEVICE_TENANT_INDEX_LISTING_ENABLED = originalFlag;
  });

  it(
    'scoped == full-scan == matchesTenantDevice-associated set (records, counts, grouping) (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          populationArb,
          tenantIdArb,
          fc.constantFrom<DeviceSort>('name', 'lastSeen', 'deviceType', 'status'),
          fc.integer({ min: 0, max: 5_000_000_000_000 }),
          async (pop, t, sort, nowMs) => {
            const fallback = await runFallback(pop, t);
            const scoped = await runScoped(pop, t);

            // 1) Same set of records (field-identical), order-independent.
            const fallbackSorted = sortById(fallback);
            const scopedSorted = sortById(scoped);
            expect(scopedSorted).toEqual(fallbackSorted);

            // 2) The returned device ids equal the predicate-associated set (Req 7.1).
            const expectedIds = associatedDeviceIds(pop, t);
            expect(scopedSorted.map((r) => r.deviceId).sort()).toEqual(expectedIds);
            expect(fallbackSorted.map((r) => r.deviceId).sort()).toEqual(expectedIds);

            // 3) Downstream pure views agree (Req 6.5): counts + grouping.
            expect(computeCounts(scoped, nowMs)).toEqual(computeCounts(fallback, nowMs));
            expect(sortAndGroup(scoped, sort, nowMs)).toEqual(sortAndGroup(fallback, sort, nowMs));

            // 4) Ban enrichment sanity: every record's isHardBanned is a boolean
            //    and no record leaks a `tenantIndex` field into the projection.
            for (const record of scoped) {
              expect(typeof record.isHardBanned).toBe('boolean');
              expect('tenantIndex' in record).toBe(false);
            }
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    60_000
  );
});
