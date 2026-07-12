// Feature: device-console-migration, Property 17: Permanent-delete atomicity

/**
 * Property 17: Permanent-delete atomicity
 * **Validates: Requirements 10.1, 10.6**
 *
 * For an existing, in-tenant device, `permanentDelete` is all-or-nothing:
 *   - SUCCESS PATH — when the underlying `WriteBatch` commits, the device
 *     document (`user_devices/{email}/devices/{deviceId}`) AND its related
 *     `logout_signals/{email}_{deviceId}` document are removed together, the
 *     parent `user_devices/{email}` counter is decremented (`totalDevices`
 *     receives an `increment(-1)` and `lastActivity` is refreshed), and EXACTLY
 *     ONE `permanent_delete` audit entry is appended to `deviceAuditLogs`
 *     (Requirements 10.1, 10.3).
 *   - FAILURE PATH — when the datastore op fails at commit, the batch rolls back
 *     atomically: `permanentDelete` rejects with `DeleteRolledBackError`
 *     (`code: 'delete_rolled_back'`) and every record is left exactly as seeded
 *     (device doc, signal doc, and parent doc unchanged), with NO audit entry
 *     written (Requirement 10.6). Because the read/scope checks and the commit
 *     both run before any durable mutation is applied, a rejected request
 *     performs zero writes.
 *   - Missing device → `DeviceNotFoundError`, and an out-of-tenant device →
 *     `TenantScopeError`, both rejected before any write (Requirement 10.4).
 *
 * The test drives the real, exported `permanentDelete` orchestrator from
 * `deviceAdminService.ts` (exercised unmodified). The `./firebaseAdmin` module
 * is replaced with `jest.mock` so `getFirestore()` returns an in-memory
 * Firestore fake covering exactly the surface `permanentDelete` touches: the
 * device-doc `get`, a `WriteBatch` supporting `delete`/`set`/`commit`, and the
 * `deviceAuditLogs` collection `add`. The fake's `commit()` can be configured to
 * FAIL (throw) WITHOUT applying any queued batch op — a true rollback — so the
 * failure scenario can assert every seeded record survives intact.
 *
 * `firebase-admin` itself is NOT mocked, so the `FieldValue.increment(-1)` /
 * `FieldValue.serverTimestamp()` sentinels the orchestrator writes to the parent
 * counter are the real ones; the test asserts the decrement intent via the
 * public `FieldValue.isEqual` API.
 */

import * as fc from 'fast-check';
import * as admin from 'firebase-admin';

import { getFirestore } from '../firebaseAdmin';
import {
  permanentDelete,
  DeleteRolledBackError,
  DeviceNotFoundError,
  TenantScopeError,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Models only the surface `permanentDelete` touches, addressing documents by
// their full slash-joined path so a `DocumentReference` handed to a batch reads
// and writes back the same store the `get` came from. Seeded docs are placed
// directly into `docs` (no write is logged); every mutation the code under test
// applies (batch delete/set and the `deviceAuditLogs` add) is applied to `docs`
// AND appended to `writes`, so a reject/rollback path is verifiable as
// "zero writes".
//
// `commitShouldThrow` toggles the failure scenario: when set, `commit()` throws
// and applies NONE of the queued ops (atomic rollback), exactly as Firestore
// leaves state on a failed `WriteBatch`.

interface WriteRecord {
  type: 'delete' | 'set' | 'update' | 'add';
  path: string;
  merge?: boolean;
}

class FakeStore {
  /** Current document state, keyed by full path. */
  readonly docs = new Map<string, Record<string, any>>();
  /** Every write applied by the code under test (empty ⇒ nothing was written). */
  readonly writes: WriteRecord[] = [];
  /** Paths of every doc appended to the `deviceAuditLogs` collection. */
  readonly auditPaths: string[] = [];
  /** When true, `batch.commit()` throws and applies no queued op. */
  commitShouldThrow = false;
  private auditSeq = 0;

  /** Seed a pre-existing document without logging it as a write. */
  seed(path: string, data: Record<string, any>): void {
    this.docs.set(path, { ...data });
  }

  /** Entries whose path starts with `prefix` (e.g. the `logout_signals/` collection). */
  docsWithPrefix(prefix: string): Array<[string, Record<string, any>]> {
    return [...this.docs.entries()].filter(([path]) => path.startsWith(prefix));
  }

  nextAuditId(): string {
    this.auditSeq += 1;
    return `audit_${this.auditSeq}`;
  }

  applyDelete(path: string): void {
    this.docs.delete(path);
    this.writes.push({ type: 'delete', path });
  }

  applySet(path: string, data: Record<string, any>, merge: boolean): void {
    if (merge) {
      const current = this.docs.get(path) ?? {};
      this.docs.set(path, { ...current, ...data });
    } else {
      this.docs.set(path, { ...data });
    }
    this.writes.push({ type: 'set', path, merge });
  }

  applyUpdate(path: string, data: Record<string, any>): void {
    const current = this.docs.get(path) ?? {};
    this.docs.set(path, { ...current, ...data });
    this.writes.push({ type: 'update', path });
  }

  applyAdd(collectionPath: string, data: Record<string, any>): string {
    const id = this.nextAuditId();
    const path = `${collectionPath}/${id}`;
    this.docs.set(path, { ...data });
    this.writes.push({ type: 'add', path });
    if (collectionPath === 'deviceAuditLogs') {
      this.auditPaths.push(path);
    }
    return id;
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }

  batch(): FakeBatch {
    return new FakeBatch(this);
  }
}

class FakeDocRef {
  constructor(readonly store: FakeStore, readonly path: string) {}

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this.store, `${this.path}/${name}`);
  }

  async get(): Promise<{ exists: boolean; id: string; data: () => Record<string, any> | undefined }> {
    const data = this.store.docs.get(this.path);
    const id = this.path.split('/').pop() as string;
    return {
      exists: data !== undefined,
      id,
      data: () => (data === undefined ? undefined : { ...data }),
    };
  }

  async set(data: Record<string, any>, options?: { merge?: boolean }): Promise<void> {
    this.store.applySet(this.path, data, Boolean(options?.merge));
  }

  async update(data: Record<string, any>): Promise<void> {
    this.store.applyUpdate(this.path, data);
  }

  async delete(): Promise<void> {
    this.store.applyDelete(this.path);
  }
}

class FakeCollectionRef {
  constructor(readonly store: FakeStore, readonly path: string) {}

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.store, `${this.path}/${id}`);
  }

  async add(data: Record<string, any>): Promise<{ id: string }> {
    const id = this.store.applyAdd(this.path, data);
    return { id };
  }
}

class FakeBatch {
  private readonly ops: Array<() => void> = [];
  constructor(private readonly store: FakeStore) {}

  delete(ref: FakeDocRef): this {
    this.ops.push(() => this.store.applyDelete(ref.path));
    return this;
  }

  set(ref: FakeDocRef, data: Record<string, any>, options?: { merge?: boolean }): this {
    this.ops.push(() => this.store.applySet(ref.path, data, Boolean(options?.merge)));
    return this;
  }

  update(ref: FakeDocRef, data: Record<string, any>): this {
    this.ops.push(() => this.store.applyUpdate(ref.path, data));
    return this;
  }

  async commit(): Promise<void> {
    // A failed WriteBatch is atomic: NONE of the queued ops are applied
    // (Requirement 10.6). Throw before touching `docs`, mirroring Firestore.
    if (this.store.commitShouldThrow) {
      throw new Error('simulated batch commit failure');
    }
    // Otherwise apply all queued ops together (all-or-nothing success).
    for (const op of this.ops) {
      op();
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Path-safe id characters (no '/'), so `user_devices/{email}/devices/{deviceId}`
// and `logout_signals/{email}_{deviceId}` remain unambiguous full paths.
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._-@'.split('');
const idArb = fc
  .array(fc.constantFrom(...ID_CHARS), { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''));

const TENANTS = ['t1', 't2', 't3'] as const;
const tenantArb = fc.constantFrom(...TENANTS);
const twoDistinctTenantsArb = fc
  .tuple(tenantArb, tenantArb)
  .filter(([selected, other]) => selected !== other);

/** The three channels through which a device is associated with a tenant. */
const inTenantChannelArb = fc.constantFrom('tenantIds', 'activeTenantId', 'membership');

/** Base (tenant-agnostic) device metadata. */
const deviceBaseArb = fc.record({
  deviceType: fc.constantFrom('mobile', 'web', 'tablet'),
  deviceName: fc.string({ maxLength: 24 }),
  isDeleted: fc.boolean(),
});

/** Acting administrator identity (each field independently present or absent). */
const actorArb = fc.record(
  {
    id: fc.option(idArb, { nil: undefined }),
    email: fc.option(idArb, { nil: undefined }),
    name: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  },
  { requiredKeys: [] }
);

/** Reason is required at the route layer (1–500 chars) and recorded on the audit. */
const reasonArb = fc.string({ minLength: 1, maxLength: 60 });

/** Seed data for the related logout signal doc. */
const signalSeedArb = fc.record({
  consumed: fc.boolean(),
  reason: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
});

/** Starting parent counter value (proves the decrement targets it). */
const totalDevicesArb = fc.integer({ min: 1, max: 50 });

/** Attach a tenant association to a device via the given channel. */
function withTenant(
  base: Record<string, any>,
  channel: string,
  tenant: string
): Record<string, any> {
  const device = { ...base };
  if (channel === 'tenantIds') {
    device.tenantIds = [tenant];
  } else if (channel === 'activeTenantId') {
    device.activeTenantId = tenant;
  } else {
    device.tenantMemberships = [{ tenantId: tenant, status: 'active' }];
  }
  return device;
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 17 — permanent-delete atomicity', () => {
  it(
    'success: removes the device doc + signal doc together, decrements the parent counter, and writes exactly one permanent_delete audit entry (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          tenantArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          reasonArb,
          signalSeedArb,
          totalDevicesArb,
          async (email, deviceId, tenant, channel, base, actor, reason, signalSeed, totalDevices) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            const signalPath = `logout_signals/${email}_${deviceId}`;
            const userPath = `user_devices/${email}`;

            store.seed(devicePath, withTenant({ ...base }, channel, tenant));
            store.seed(signalPath, { ...signalSeed });
            store.seed(userPath, { totalDevices });

            const result = await permanentDelete({
              tenantId: tenant,
              email,
              deviceId,
              actor,
              reason,
            });
            expect(result).toEqual({ ok: true });

            // Device doc + its related logout signal are removed together.
            expect(store.docs.has(devicePath)).toBe(false);
            expect(store.docs.has(signalPath)).toBe(false);
            // No stray leftover in the signal collection for this pair key.
            expect(store.docsWithPrefix(signalPath)).toHaveLength(0);

            // Parent counter doc still exists and was decremented + touched.
            const parent = store.docs.get(userPath) as Record<string, any>;
            expect(parent).toBeDefined();
            const expectedIncrement = admin.firestore.FieldValue.increment(-1);
            expect(expectedIncrement.isEqual(parent.totalDevices)).toBe(true);
            const expectedTimestamp = admin.firestore.FieldValue.serverTimestamp();
            expect(expectedTimestamp.isEqual(parent.lastActivity)).toBe(true);

            // Exactly one permanent_delete audit entry, and it is the ONLY add.
            expect(store.auditPaths).toHaveLength(1);
            const auditDoc = store.docs.get(store.auditPaths[0]) as Record<string, any>;
            expect(auditDoc.action).toBe('permanent_delete');
            expect(auditDoc.targetDeviceId).toBe(deviceId);
            expect(auditDoc.targetUserEmail).toBe(email);
            expect(auditDoc.reason).toBe(reason);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );

  it(
    'failure: a commit that throws rolls back atomically — rejects with DeleteRolledBackError, leaves the device + signal + parent docs exactly as seeded, and writes no audit entry (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          tenantArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          reasonArb,
          signalSeedArb,
          totalDevicesArb,
          async (email, deviceId, tenant, channel, base, actor, reason, signalSeed, totalDevices) => {
            const store = new FakeStore();
            store.commitShouldThrow = true; // datastore op fails mid-permanent-delete
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            const signalPath = `logout_signals/${email}_${deviceId}`;
            const userPath = `user_devices/${email}`;

            const seededDevice = withTenant({ ...base }, channel, tenant);
            const seededSignal = { ...signalSeed };
            const seededUser = { totalDevices };
            store.seed(devicePath, seededDevice);
            store.seed(signalPath, seededSignal);
            store.seed(userPath, seededUser);

            const error = await permanentDelete({
              tenantId: tenant,
              email,
              deviceId,
              actor,
              reason,
            }).catch((e) => e);

            expect(error).toBeInstanceOf(DeleteRolledBackError);
            expect((error as DeleteRolledBackError).code).toBe('delete_rolled_back');

            // Every record is left unchanged (all-or-nothing rollback).
            expect(store.docs.get(devicePath)).toEqual(seededDevice);
            expect(store.docs.get(signalPath)).toEqual(seededSignal);
            expect(store.docs.get(userPath)).toEqual(seededUser);

            // No write of any kind was applied, and no audit entry was recorded.
            expect(store.writes).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );

  it(
    'throws DeviceNotFoundError for a missing device and writes nothing (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          tenantArb,
          actorArb,
          reasonArb,
          async (email, deviceId, tenant, actor, reason) => {
            const store = new FakeStore(); // device intentionally not seeded
            mockedGetFirestore.mockReturnValue(store as any);

            const error = await permanentDelete({
              tenantId: tenant,
              email,
              deviceId,
              actor,
              reason,
            }).catch((e) => e);

            expect(error).toBeInstanceOf(DeviceNotFoundError);
            expect(store.writes).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );

  it(
    'rejects an out-of-tenant device with TenantScopeError and writes nothing (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          twoDistinctTenantsArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          reasonArb,
          signalSeedArb,
          async (email, deviceId, [selected, other], channel, base, actor, reason, signalSeed) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            const signalPath = `logout_signals/${email}_${deviceId}`;
            // Tagged ONLY to `other`, never to the scoped `selected` tenant.
            const seededDevice = withTenant({ ...base }, channel, other);
            const seededSignal = { ...signalSeed };
            store.seed(devicePath, seededDevice);
            store.seed(signalPath, seededSignal);

            const error = await permanentDelete({
              tenantId: selected,
              email,
              deviceId,
              actor,
              reason,
            }).catch((e) => e);

            expect(error).toBeInstanceOf(TenantScopeError);
            expect((error as TenantScopeError).code).toBe('tenant_scope_violation');

            // No mutation at all; both docs survive untouched.
            expect(store.writes).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
            expect(store.docs.get(devicePath)).toEqual(seededDevice);
            expect(store.docs.get(signalPath)).toEqual(seededSignal);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );
});
