// Feature: device-tenant-index, Property 6: Read cost is proportional to the tenant's device count and invariant to other-tenant growth

/**
 * Property 6: Read cost is proportional to the tenant's device count and invariant to other-tenant growth
 * **Validates: Requirements 9.1, 9.2, 9.3, 9.4**
 *
 * The scoped listing must read only what the requested tenant needs:
 *   - device-doc reads == |{ devices whose `tenantIndex` contains `t` }|
 *     (the array-contains query returns exactly those docs) — Req 9.1, 9.2;
 *   - parent-doc reads == the number of DISTINCT owners of those matched devices
 *     (owner attribution reads only distinct parents via `getAll`) — Req 9.3;
 *   - and the device-doc read count is INVARIANT when devices associated only
 *     with OTHER tenants are added to the population — Req 9.4.
 *
 * The property drives the REAL, exported `listTenantDevices` in scoped mode
 * (flag on + backfill "completed") against an INSTRUMENTED in-memory Firestore
 * fake that counts (a) the device docs returned by the scoped array-contains
 * query and (b) the parent refs passed to `getAll`. No real Firestore.
 */

import * as fc from 'fast-check';

import { listTenantDevices, deriveTenantIndex } from '../deviceAdminService';

jest.mock('../firebaseAdmin', () => ({
  getFirestore: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getFirestore } = require('../firebaseAdmin') as { getFirestore: jest.Mock };

const FLAG = 'DEVICE_TENANT_INDEX_LISTING_ENABLED';
const OTHER_TENANT = 'other-tenant-zzz'; // disjoint from the probe pool

// ---------------------------------------------------------------------------
// Instrumented in-memory Firestore fake
// ---------------------------------------------------------------------------

interface SeedDevice {
  deviceId: string;
  ownerEmail: string;
  data: Record<string, unknown>;
}

interface ReadCounters {
  deviceReads: number; // device docs returned by the scoped array-contains query
  parentReads: number; // parent refs read via getAll
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

function buildInstrumentedDb(devices: SeedDevice[], counters: ReadCounters) {
  const parentEmails = new Set(devices.map((d) => d.ownerEmail));
  const deviceSnaps = devices.map(
    (d) => new FakeDocSnap(d.deviceId, d.data, { parent: { parent: { id: d.ownerEmail } } })
  );

  return {
    collection(name: string) {
      if (name === 'device_bans') {
        return {
          where(_field: string, _op: string, _value: unknown) {
            return { async get() { return { docs: [] as FakeDocSnap[] }; } };
          },
        };
      }
      if (name === 'user_devices') {
        return {
          async get() {
            // Full-scan path is not exercised in scoped mode; return parents anyway.
            const docs = [...parentEmails].map((email) => new FakeDocSnap(email, {}));
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
      if (name !== 'devices') throw new Error(`unexpected collectionGroup: ${name}`);
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
              // Instrument: an index-backed query reads exactly the matched docs.
              counters.deviceReads += docs.length;
              return { docs };
            },
          };
        },
      };
    },
    async getAll(...refs: Array<{ __userDeviceDocId: string }>) {
      // Instrument: owner attribution reads only the DISTINCT matched parents.
      counters.parentReads += refs.length;
      return refs.map((ref) => new FakeDocSnap(ref.__userDeviceDocId, {}));
    },
    doc(path: string) {
      if (path === 'migrationProgress/deviceTenantIndexBackfill') {
        return {
          async get() {
            return new FakeDocSnap('deviceTenantIndexBackfill', { status: 'completed' });
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

const membershipArb = fc.record({
  tenantId: tenantIdArb,
  status: fc.constantFrom<string | undefined>('active', 'Active', 'inactive', undefined),
});

const scopeArb = fc.record(
  {
    tenantIds: fc.uniqueArray(tenantIdArb, { maxLength: TENANTS.length }),
    activeTenantId: tenantIdArb,
    tenantMemberships: fc.array(membershipArb, { maxLength: 3 }),
  },
  { requiredKeys: [] }
);

/** A population of devices spread across a handful of owners. */
const populationArb = fc
  .array(
    fc.record({
      ownerIndex: fc.integer({ min: 0, max: 3 }),
      scope: scopeArb,
    }),
    { maxLength: 12 }
  )
  .map((entries) =>
    entries.map((entry, i) => {
      const ownerEmail = `owner-${entry.ownerIndex}@example.com`;
      const data: Record<string, unknown> = { ...entry.scope, tenantIndex: deriveTenantIndex(entry.scope) };
      return { deviceId: `dev-${i}`, ownerEmail, data } as SeedDevice;
    })
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchedDevices(devices: SeedDevice[], t: string): SeedDevice[] {
  return devices.filter((d) => {
    const idx = d.data.tenantIndex;
    return Array.isArray(idx) && idx.includes(t);
  });
}

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 6 — read cost is proportional and invariant to other-tenant growth', () => {
  const originalFlag = process.env[FLAG];
  beforeAll(() => {
    process.env[FLAG] = '1'; // scoped mode for every case
  });
  afterAll(() => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  it(
    'device reads == matched count, parent reads == distinct matched owners, and device reads are invariant to added other-tenant devices (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          populationArb,
          tenantIdArb,
          fc.array(fc.integer({ min: 100, max: 199 }), { maxLength: 8 }),
          async (devices, t, extraOwnerIdxs) => {
            const matched = matchedDevices(devices, t);
            const expectedDeviceReads = matched.length;
            const expectedParentReads = new Set(matched.map((d) => d.ownerEmail)).size;

            // --- Baseline scoped run ---
            const counters = { deviceReads: 0, parentReads: 0 } as ReadCounters;
            getFirestore.mockReturnValue(buildInstrumentedDb(devices, counters));
            await listTenantDevices(t);

            expect(counters.deviceReads).toBe(expectedDeviceReads); // Req 9.1, 9.2
            expect(counters.parentReads).toBe(expectedParentReads); // Req 9.3

            // --- Add devices associated ONLY with a disjoint OTHER tenant ---
            const otherDevices: SeedDevice[] = extraOwnerIdxs.map((ownerIdx, i) => {
              const scope = { tenantIds: [OTHER_TENANT] };
              return {
                deviceId: `other-${i}`,
                ownerEmail: `owner-${ownerIdx}@example.com`,
                data: { ...scope, tenantIndex: deriveTenantIndex(scope) },
              };
            });
            const grown = [...devices, ...otherDevices];

            const grownCounters = { deviceReads: 0, parentReads: 0 } as ReadCounters;
            getFirestore.mockReturnValue(buildInstrumentedDb(grown, grownCounters));
            await listTenantDevices(t);

            // Device reads are invariant to other-tenant growth (Req 9.4).
            expect(grownCounters.deviceReads).toBe(expectedDeviceReads);
            // Parent reads are likewise unaffected (matched owners unchanged).
            expect(grownCounters.parentReads).toBe(expectedParentReads);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    60_000
  );
});
