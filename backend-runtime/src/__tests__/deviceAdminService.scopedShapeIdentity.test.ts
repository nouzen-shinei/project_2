/**
 * Unit tests for scoped-vs-full-scan response-shape stability (Task 4.4).
 *
 * Example-based coverage that the scoped indexed path and the retained full-scan
 * path produce FIELD-IDENTICAL `DeviceAdminRecord`s for a fixed multi-owner /
 * multi-tenant population, and that `tenantIndex` is never surfaced in a
 * projected record (Req 6.5). Both paths are exercised through the REAL,
 * exported `listTenantDevices` by toggling the feature flag against a small
 * in-memory Firestore fake (no real Firestore).
 *
 * Requirements: 6.5
 */

import {
  listTenantDevices,
  deriveTenantIndex,
  type DeviceAdminRecord,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin', () => ({
  getFirestore: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getFirestore } = require('../firebaseAdmin') as { getFirestore: jest.Mock };

const FLAG = 'DEVICE_TENANT_INDEX_LISTING_ENABLED';
const TENANT = 'tenant-shape';
const OTHER = 'tenant-other';

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

interface Owner {
  email: string;
  parentData: Record<string, unknown>;
  devices: Array<{ deviceId: string; data: Record<string, unknown> }>;
}

// A fixed population: two owners, in-tenant devices via each channel, one
// cross-tenant device (excluded), plus an active ban matching one fingerprint.
function fixedPopulation(): { owners: Owner[]; bans: Array<Record<string, unknown>> } {
  const withIndex = (source: Record<string, unknown>) => ({
    ...source,
    tenantIndex: deriveTenantIndex(source),
  });

  return {
    owners: [
      {
        email: 'alice@example.com',
        parentData: { displayName: 'Alice Anderson' },
        devices: [
          {
            deviceId: 'a1',
            data: withIndex({
              deviceType: 'web',
              deviceName: 'Alice Chrome',
              tenantIds: [TENANT],
              deviceSeedHash: 'fp-a1',
            }),
          },
          {
            deviceId: 'a2',
            data: withIndex({
              deviceType: 'mobile',
              deviceName: 'Alice iPhone',
              activeTenantId: TENANT,
              deviceSeedHash: 'fp-a2',
            }),
          },
        ],
      },
      {
        email: 'bob@example.com',
        parentData: {}, // no display name → null
        devices: [
          {
            deviceId: 'b1',
            data: withIndex({
              deviceType: 'tablet',
              deviceName: 'Bob iPad',
              tenantMemberships: [{ tenantId: TENANT, role: 'member', status: 'active' }],
              deviceSeedHash: 'fp-b1',
            }),
          },
          {
            deviceId: 'c1',
            data: withIndex({
              deviceType: 'web',
              deviceName: 'Bob Cross',
              tenantIds: [OTHER],
              activeTenantId: OTHER,
              deviceSeedHash: 'fp-c1',
            }),
          },
        ],
      },
    ],
    bans: [{ deviceFingerprint: 'fp-a1', isActive: true }],
  };
}

function buildFakeDb(pop: { owners: Owner[]; bans: Array<Record<string, unknown>> }, backfillCompleted: boolean) {
  const deviceSnaps: FakeDocSnap[] = [];
  const parentByEmail = new Map<string, Record<string, unknown>>();
  for (const owner of pop.owners) {
    parentByEmail.set(owner.email, owner.parentData);
    for (const d of owner.devices) {
      deviceSnaps.push(new FakeDocSnap(d.deviceId, d.data, { parent: { parent: { id: owner.email } } }));
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
                  .filter((b) => b[field] === value)
                  .map((b, i) => new FakeDocSnap(`ban-${i}`, b));
                return { docs };
              },
            };
          },
        };
      }
      if (name === 'user_devices') {
        return {
          async get() {
            const docs = [...parentByEmail.entries()].map(([email, data]) => new FakeDocSnap(email, data));
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
        where(field: string, _op: string, value: unknown) {
          return {
            async get() {
              const docs = deviceSnaps.filter((snap) => {
                const idx = snap.get(field);
                return Array.isArray(idx) && idx.includes(value);
              });
              return { docs };
            },
          };
        },
      };
    },
    async getAll(...refs: Array<{ __userDeviceDocId: string }>) {
      return refs.map((ref) => new FakeDocSnap(ref.__userDeviceDocId, parentByEmail.get(ref.__userDeviceDocId)));
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

function sortById(records: DeviceAdminRecord[]): DeviceAdminRecord[] {
  return [...records].sort((a, b) => (a.deviceId ?? '').localeCompare(b.deviceId ?? ''));
}

describe('scoped vs full-scan — response-shape stability (Req 6.5)', () => {
  const originalFlag = process.env[FLAG];
  afterEach(() => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
  });

  async function fullScan(): Promise<DeviceAdminRecord[]> {
    delete process.env[FLAG];
    getFirestore.mockReturnValue(buildFakeDb(fixedPopulation(), false));
    return listTenantDevices(TENANT);
  }

  async function scoped(): Promise<DeviceAdminRecord[]> {
    process.env[FLAG] = '1';
    getFirestore.mockReturnValue(buildFakeDb(fixedPopulation(), true));
    return listTenantDevices(TENANT);
  }

  it('returns exactly the three in-tenant devices on both paths', async () => {
    const full = sortById(await fullScan());
    const sco = sortById(await scoped());
    expect(full.map((r) => r.deviceId)).toEqual(['a1', 'a2', 'b1']);
    expect(sco.map((r) => r.deviceId)).toEqual(['a1', 'a2', 'b1']);
  });

  it('produces field-identical records between scoped and full-scan paths', async () => {
    const full = sortById(await fullScan());
    const sco = sortById(await scoped());
    expect(sco).toEqual(full);
  });

  it('record key sets are identical between the two paths', async () => {
    const full = sortById(await fullScan());
    const sco = sortById(await scoped());
    for (let i = 0; i < full.length; i += 1) {
      expect(Object.keys(sco[i]).sort()).toEqual(Object.keys(full[i]).sort());
    }
  });

  it('never surfaces a `tenantIndex` field in a projected DeviceAdminRecord', async () => {
    for (const records of [await fullScan(), await scoped()]) {
      for (const record of records) {
        expect('tenantIndex' in record).toBe(false);
      }
    }
  });

  it('preserves owner attribution and active-ban enrichment identically', async () => {
    const byId = new Map((await scoped()).map((r) => [r.deviceId, r]));

    // a1: Alice, hard-banned via active fingerprint.
    expect(byId.get('a1')?.ownerEmail).toBe('alice@example.com');
    expect(byId.get('a1')?.ownerDisplayName).toBe('Alice Anderson');
    expect(byId.get('a1')?.isHardBanned).toBe(true);

    // a2: Alice, not banned.
    expect(byId.get('a2')?.ownerEmail).toBe('alice@example.com');
    expect(byId.get('a2')?.isHardBanned).toBe(false);

    // b1: Bob (no display name → null), matched via active membership, not banned.
    expect(byId.get('b1')?.ownerEmail).toBe('bob@example.com');
    expect(byId.get('b1')?.ownerDisplayName).toBeNull();
    expect(byId.get('b1')?.isHardBanned).toBe(false);
  });
});
