// Feature: device-console-migration, Property 13: Force-logout-all targets exactly the user's active in-tenant devices

/**
 * Property 13: Force-logout-all targets exactly the user's active in-tenant devices
 * Validates: Requirements 11.1, 11.3
 *
 * For any user and any set of that user's device documents, `forceLogoutAll`
 * records a `Force_Logout_Signal` for EXACTLY the devices that simultaneously
 * satisfy all three selection conditions:
 *   (a) are associated with the Selected_Tenant (per `matchesTenantDevice`,
 *       via `tenantIds` / `activeTenantId` / an ACTIVE `tenantMemberships`
 *       entry — the same predicate `assertTenantScope` delegates to),
 *   (b) are not soft-deleted (`isDeleted !== true`), and
 *   (c) have an active session (`sessionActive !== false`).
 * The number of signals written equals the returned `affected` count, and when
 * NO device qualifies the action records zero signals and reports `affected: 0`
 * (Requirement 11.3). Requirement 11.1 requires a signal for each active,
 * in-tenant device of the user; Requirement 11.3 requires the zero-signal /
 * zero-affected outcome when none qualify.
 *
 * The test drives the real, exported `forceLogoutAll` orchestrator from
 * `deviceAdminService.ts` against an in-memory Firestore fake (the `firebaseAdmin`
 * accessor is mocked), so it exercises the production selection + signal-writing
 * path rather than a re-interpretation of it. Tenant association is checked
 * against an independent oracle (re-derived from the documented
 * `matchesTenantDevice` semantics) so the test cross-checks behavior. Devices
 * are generated with a mix of tenant channels (t1/t2/t3), `isDeleted`, and
 * `sessionActive` so the generated sets span qualifying and every kind of
 * non-qualifying device.
 */

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// In-memory Firestore fake (injected via the mocked `firebaseAdmin` accessor).
//
// It implements only the surface `forceLogoutAll` (and `writeAudit`) touch:
//   - collection('user_devices').doc(email).collection('devices').get()
//   - db.batch() with per-device update()/set() + commit()
//   - collection('logout_signals').doc(`${email}_${deviceId}`)
//   - collection('user_devices').doc(email).set(..., { merge: true })
//   - collection('deviceAuditLogs').add(entry)
// `admin.firestore.FieldValue` sentinels flow through untouched (stored as-is).
// ---------------------------------------------------------------------------

type DocData = Record<string, unknown>;

class FakeFirestore {
  private collections = new Map<string, Map<string, DocData>>();
  private autoId = 0;

  col(path: string): Map<string, DocData> {
    let map = this.collections.get(path);
    if (!map) {
      map = new Map<string, DocData>();
      this.collections.set(path, map);
    }
    return map;
  }

  nextAutoId(): string {
    this.autoId += 1;
    return `auto_${this.autoId}`;
  }

  collection(path: string): FakeCollectionRef {
    return new FakeCollectionRef(this, path);
  }

  batch(): FakeBatch {
    return new FakeBatch();
  }

  /** Seed a user's devices subcollection at `user_devices/{email}/devices`. */
  seedDevices(email: string, devices: Array<{ deviceId: string; data: DocData }>): void {
    const map = this.col(`user_devices/${email}/devices`);
    for (const device of devices) {
      map.set(device.deviceId, device.data);
    }
  }

  /** The `Force_Logout_Signal` documents written to the top-level collection. */
  signalsWritten(): DocData[] {
    return Array.from(this.col('logout_signals').values());
  }

  /** The audit entries appended to `deviceAuditLogs`. */
  auditEntries(): DocData[] {
    return Array.from(this.col('deviceAuditLogs').values());
  }
}

class FakeCollectionRef {
  constructor(private db: FakeFirestore, private path: string) {}

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.db, this.path, id);
  }

  async get(): Promise<{ docs: FakeDocSnap[]; size: number; empty: boolean }> {
    const map = this.db.col(this.path);
    const docs = Array.from(map.entries()).map(
      ([id, data]) => new FakeDocSnap(this.db, this.path, id, data)
    );
    return { docs, size: docs.length, empty: docs.length === 0 };
  }

  async add(data: DocData): Promise<{ id: string }> {
    const id = this.db.nextAutoId();
    this.db.col(this.path).set(id, { ...data });
    return { id };
  }
}

class FakeDocRef {
  readonly path: string;

  constructor(private db: FakeFirestore, private collectionPath: string, readonly id: string) {
    this.path = `${collectionPath}/${id}`;
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this.db, `${this.path}/${name}`);
  }

  async get(): Promise<FakeDocSnap> {
    const map = this.db.col(this.collectionPath);
    return new FakeDocSnap(this.db, this.collectionPath, this.id, map.get(this.id));
  }

  async set(data: DocData, opts?: { merge?: boolean }): Promise<void> {
    const map = this.db.col(this.collectionPath);
    if (opts?.merge && map.has(this.id)) {
      map.set(this.id, { ...map.get(this.id), ...data });
    } else {
      map.set(this.id, { ...data });
    }
  }

  async update(data: DocData): Promise<void> {
    const map = this.db.col(this.collectionPath);
    map.set(this.id, { ...(map.get(this.id) ?? {}), ...data });
  }
}

class FakeDocSnap {
  readonly exists: boolean;
  readonly ref: FakeDocRef;

  constructor(
    db: FakeFirestore,
    collectionPath: string,
    readonly id: string,
    private _data: DocData | undefined
  ) {
    this.exists = _data !== undefined;
    this.ref = new FakeDocRef(db, collectionPath, id);
  }

  data(): DocData | undefined {
    return this._data;
  }
}

type BatchOp =
  | { type: 'update'; ref: FakeDocRef; data: DocData }
  | { type: 'set'; ref: FakeDocRef; data: DocData; opts?: { merge?: boolean } };

class FakeBatch {
  private ops: BatchOp[] = [];

  update(ref: FakeDocRef, data: DocData): this {
    this.ops.push({ type: 'update', ref, data });
    return this;
  }

  set(ref: FakeDocRef, data: DocData, opts?: { merge?: boolean }): this {
    this.ops.push({ type: 'set', ref, data, opts });
    return this;
  }

  async commit(): Promise<void> {
    for (const op of this.ops) {
      if (op.type === 'update') {
        // eslint-disable-next-line no-await-in-loop
        await op.ref.update(op.data);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await op.ref.set(op.data, op.opts);
      }
    }
  }
}

// The fake the mocked accessor hands out; reassigned before each generated case.
// Prefixed with `mock` so the jest.mock factory may reference it.
let mockDb: FakeFirestore;

jest.mock('../firebaseAdmin', () => ({
  getFirestore: () => mockDb,
  ensureFirebase: () => undefined,
  resetFirebaseForTests: () => undefined,
}));

// Imported AFTER the mock is declared (jest hoists the mock above imports).
import { forceLogoutAll } from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Tenant pool + generators (mirroring the tenant-scope property test).
// ---------------------------------------------------------------------------

const TENANTS = ['t1', 't2', 't3'] as const;
const tenantIdArb = fc.constantFrom(...TENANTS);

/** Membership status: active (any letter case), several non-active values, or absent. */
const statusArb = fc.constantFrom<string | undefined>(
  'active',
  'Active',
  'ACTIVE',
  'inactive',
  'pending',
  'suspended',
  undefined
);

const membershipArb = fc.record({ tenantId: tenantIdArb, status: statusArb });

/** Lifecycle flags: each of the disqualifying values, their negations, and absence. */
const isDeletedArb = fc.constantFrom<boolean | undefined>(true, false, undefined);
const sessionActiveArb = fc.constantFrom<boolean | undefined>(true, false, undefined);

/**
 * A single device document whose tenant association is set through a MIX of
 * channels (each independently present or absent), plus independently varied
 * `isDeleted` / `sessionActive` lifecycle flags.
 */
const deviceShapeArb = fc.record(
  {
    tenantIds: fc.uniqueArray(tenantIdArb, { maxLength: TENANTS.length }),
    activeTenantId: tenantIdArb,
    tenantMemberships: fc.array(membershipArb, { maxLength: 4 }),
    isDeleted: isDeletedArb,
    sessionActive: sessionActiveArb,
  },
  { requiredKeys: [] }
);

/** A user's devices with unique, stable device ids. */
const devicesArb = fc
  .array(deviceShapeArb, { maxLength: 12 })
  .map((shapes) => shapes.map((data, index) => ({ deviceId: `d${index}`, data: { ...data } })));

// ---------------------------------------------------------------------------
// Independent oracle — re-derived from the documented `matchesTenantDevice`
// semantics (allowUntagged = false, as `assertTenantScope` uses) rather than
// importing the production predicate, so the test cross-checks behavior.
// ---------------------------------------------------------------------------

/** A membership is active when status is absent/non-string, or lowercases to 'active'. */
function membershipActiveOracle(status: unknown): boolean {
  const normalized = typeof status === 'string' ? status.toLowerCase() : 'active';
  return normalized === 'active';
}

/** Whether `data` is associated with `tenantId` (mirrors matchesTenantDevice, allowUntagged=false). */
function associatedOracle(data: DocData, tenantId: string): boolean {
  const target = tenantId.trim();
  if (!target) {
    return true; // not exercised (generators use non-empty ids); mirror "match all".
  }

  const tenantIds = Array.isArray(data.tenantIds)
    ? (data.tenantIds as unknown[])
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    : [];
  if (tenantIds.includes(target)) {
    return true;
  }

  const active = typeof data.activeTenantId === 'string' ? data.activeTenantId.trim() : '';
  if (active === target) {
    return true;
  }

  if (Array.isArray(data.tenantMemberships)) {
    const hit = (data.tenantMemberships as unknown[]).some((entry) => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      const membership = entry as { tenantId?: unknown; status?: unknown };
      const membershipTenantId =
        typeof membership.tenantId === 'string' ? membership.tenantId.trim() : '';
      if (membershipTenantId !== target) {
        return false;
      }
      return membershipActiveOracle(membership.status);
    });
    if (hit) {
      return true;
    }
  }

  return false;
}

/** The three-condition selection oracle for force-logout-all (Req 11.1). */
function qualifiesOracle(data: DocData, tenantId: string): boolean {
  if (data.isDeleted === true) {
    return false;
  }
  if (data.sessionActive === false) {
    return false;
  }
  return associatedOracle(data, tenantId);
}

const ACTOR = { id: 'admin-uid', email: 'admin@example.com', name: 'Admin Operator' };
const EMAIL = 'owner@example.com';

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 13 — force-logout-all targets exactly the active in-tenant devices', () => {
  it(
    'writes a Force_Logout_Signal for exactly the active + non-deleted + in-tenant devices, with affected matching (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(devicesArb, tenantIdArb, async (devices, tenant) => {
          mockDb = new FakeFirestore();
          mockDb.seedDevices(EMAIL, devices);

          const expectedIds = devices
            .filter((device) => qualifiesOracle(device.data, tenant))
            .map((device) => device.deviceId)
            .sort();

          const result = await forceLogoutAll({
            tenantId: tenant,
            email: EMAIL,
            actor: ACTOR,
            reason: 'admin action',
          });

          // Affected count equals the number of qualifying devices (Req 11.1/11.3).
          expect(result.ok).toBe(true);
          expect(result.affected).toBe(expectedIds.length);

          // The set of signals written equals EXACTLY the qualifying devices.
          const signals = mockDb.signalsWritten();
          const signaledIds = signals.map((signal) => signal.deviceId as string).sort();
          expect(signaledIds).toEqual(expectedIds);

          // Every signal is unconsumed, for the right user, and a qualifying device.
          for (const signal of signals) {
            expect(signal.consumed).toBe(false);
            expect(signal.userEmail).toBe(EMAIL);
            expect(expectedIds).toContain(signal.deviceId as string);
          }

          // No signal is written for any non-qualifying device.
          for (const device of devices) {
            if (!qualifiesOracle(device.data, tenant)) {
              expect(signaledIds).not.toContain(device.deviceId);
            }
          }

          // Exactly one audit entry, recording the affected count (Req 11.2 support).
          const audits = mockDb.auditEntries();
          expect(audits.length).toBe(1);
          expect(audits[0].action).toBe('force_logout_all');
          expect(audits[0].affectedCount).toBe(expectedIds.length);
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'records zero signals and reports affected 0 when no device qualifies (property, Req 11.3)',
    async () => {
      // Each generated device is disqualified by at least one condition: it is
      // tagged only to a different tenant, or it is in-tenant but deleted, or it
      // is in-tenant but has an inactive session. None can qualify for `tenant`.
      const disqualifiedFor = (tenant: string) => {
        const others = TENANTS.filter((candidate) => candidate !== tenant);
        const otherTenantArb = fc.constantFrom(...others);

        const outOfTenant = fc
          .record({
            channel: fc.constantFrom('tenantIds', 'activeTenantId', 'membership'),
            other: otherTenantArb,
            isDeleted: isDeletedArb,
            sessionActive: sessionActiveArb,
          })
          .map(({ channel, other, isDeleted, sessionActive }) => {
            const data: DocData = { isDeleted, sessionActive };
            if (channel === 'tenantIds') {
              data.tenantIds = [other];
            } else if (channel === 'activeTenantId') {
              data.activeTenantId = other;
            } else {
              data.tenantMemberships = [{ tenantId: other, status: 'active' }];
            }
            return data;
          });

        const inTenantDeleted = fc
          .record({ sessionActive: sessionActiveArb })
          .map(({ sessionActive }): DocData => ({
            activeTenantId: tenant,
            isDeleted: true,
            sessionActive,
          }));

        const inTenantInactive = fc
          .record({ isDeleted: fc.constantFrom<boolean | undefined>(false, undefined) })
          .map(({ isDeleted }): DocData => ({
            activeTenantId: tenant,
            isDeleted,
            sessionActive: false,
          }));

        return fc.oneof(outOfTenant, inTenantDeleted, inTenantInactive);
      };

      await fc.assert(
        fc.asyncProperty(
          tenantIdArb.chain((tenant) =>
            fc.record({
              tenant: fc.constant(tenant),
              devices: fc.array(disqualifiedFor(tenant), { maxLength: 10 }),
            })
          ),
          async ({ tenant, devices }) => {
            const seeded = devices.map((data, index) => ({ deviceId: `d${index}`, data }));

            // Sanity: the generator really produced only non-qualifying devices.
            for (const device of seeded) {
              expect(qualifiesOracle(device.data, tenant)).toBe(false);
            }

            mockDb = new FakeFirestore();
            mockDb.seedDevices(EMAIL, seeded);

            const result = await forceLogoutAll({
              tenantId: tenant,
              email: EMAIL,
              actor: ACTOR,
            });

            // Zero affected, zero signals (Requirement 11.3).
            expect(result.affected).toBe(0);
            expect(mockDb.signalsWritten()).toEqual([]);

            // Still exactly one audit entry, recorded with a count of zero.
            const audits = mockDb.auditEntries();
            expect(audits.length).toBe(1);
            expect(audits[0].action).toBe('force_logout_all');
            expect(audits[0].affectedCount).toBe(0);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );
});
