// Feature: device-console-migration, Property 12: Force logout records a signal and no-ops on deleted devices

/**
 * Property 12: Force logout records a signal and no-ops on deleted devices
 * **Validates: Requirements 7.1, 7.3, 7.5**
 *
 * For any live, in-tenant device, `forceLogout` writes EXACTLY ONE unconsumed
 * `Force_Logout_Signal` at `logout_signals/{email}_{deviceId}` (with
 * `consumed: false`) — Requirements 7.1, 7.5. When the target device is already
 * soft-deleted, `forceLogout` rejects with `DeviceConflictError`
 * (`code: 'already_deleted'`) and leaves state unchanged (no signal, no audit,
 * no writes at all) — Requirement 7.3. When the target device is outside the
 * scoped tenant, it rejects with `TenantScopeError` and writes nothing; when the
 * target device does not exist it throws `DeviceNotFoundError` — the
 * scope/lifecycle checks run BEFORE any mutation, so a rejected request performs
 * no writes.
 *
 * The test drives the real, exported `forceLogout` orchestrator from
 * `deviceAdminService.ts`. The `./firebaseAdmin` module is replaced with
 * `jest.mock` so `getFirestore()` returns an in-memory Firestore fake that
 * covers exactly the reads/writes `forceLogout` performs: the device-doc `get`,
 * the `WriteBatch` (device `update`, `logout_signals/{email}_{deviceId}` `set`,
 * and the parent `user_devices/{email}` merge `set`), and the
 * `deviceAuditLogs` collection `add`. `firebase-admin` itself is NOT mocked, so
 * the `FieldValue` sentinels used by the orchestrator are the real ones.
 *
 * `deviceAdminService.ts` is exercised unmodified; the fake records every write
 * so we can assert both the presence (happy path) and the total absence (reject
 * paths) of the signal + audit + device mutations across many generated inputs.
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import {
  forceLogout,
  DeviceConflictError,
  TenantScopeError,
  DeviceNotFoundError,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Models only the surface `forceLogout` touches, addressing documents by their
// full slash-joined path so a `DocumentReference` handed to a batch writes back
// to the same store the reads came from. Seeded docs are placed directly into
// `docs` (no write is logged); every mutation performed by `forceLogout`
// (batch update/set and collection add) is applied to `docs` AND appended to
// `writes`, so a reject path is verifiable as "zero writes".

interface WriteRecord {
  type: 'update' | 'set' | 'add';
  path: string;
  merge?: boolean;
}

class FakeStore {
  /** Current document state, keyed by full path (e.g. `logout_signals/a_b`). */
  readonly docs = new Map<string, Record<string, any>>();
  /** Every write applied by the code under test (empty ⇒ nothing was written). */
  readonly writes: WriteRecord[] = [];
  /** Paths of every doc appended to the `deviceAuditLogs` collection. */
  readonly auditPaths: string[] = [];
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

  applyUpdate(path: string, data: Record<string, any>): void {
    const current = this.docs.get(path) ?? {};
    this.docs.set(path, { ...current, ...data });
    this.writes.push({ type: 'update', path });
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

  update(ref: FakeDocRef, data: Record<string, any>): this {
    this.ops.push(() => this.store.applyUpdate(ref.path, data));
    return this;
  }

  set(ref: FakeDocRef, data: Record<string, any>, options?: { merge?: boolean }): this {
    this.ops.push(() => this.store.applySet(ref.path, data, Boolean(options?.merge)));
    return this;
  }

  async commit(): Promise<void> {
    // Applied together, mirroring an atomic WriteBatch (Requirement 7.5).
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
  sessionActive: fc.boolean(),
  isOnline: fc.boolean(),
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

/** Optional destructive-action reason. */
const reasonArb = fc.option(fc.string({ minLength: 1, maxLength: 60 }), { nil: undefined });

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

describe('Property 12 — force logout records a signal and no-ops on deleted devices', () => {
  it(
    'records exactly one unconsumed force-logout signal for a live in-tenant device (property)',
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
          async (email, deviceId, tenant, channel, base, actor, reason) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            store.seed(devicePath, withTenant({ ...base, isDeleted: false }, channel, tenant));

            const result = await forceLogout({ tenantId: tenant, email, deviceId, actor, reason });
            expect(result).toEqual({ ok: true });

            // Exactly one unconsumed signal at the deterministic pair key.
            const signals = store.docsWithPrefix('logout_signals/');
            expect(signals).toHaveLength(1);
            const [signalPath, signalData] = signals[0];
            expect(signalPath).toBe(`logout_signals/${email}_${deviceId}`);
            expect(signalData.consumed).toBe(false);

            // Exactly one audit entry for the successful action.
            expect(store.auditPaths).toHaveLength(1);

            // Device carries force-logout provenance / offline state.
            const device = store.docs.get(devicePath) as Record<string, any>;
            expect(device.logoutSignal).toBe(true);
            expect(device.isOnline).toBe(false);
            expect(device.sessionActive).toBe(false);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );

  it(
    'rejects an already-deleted device with DeviceConflictError(already_deleted) and writes nothing (property)',
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
          async (email, deviceId, tenant, channel, base, actor, reason) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            store.seed(devicePath, withTenant({ ...base, isDeleted: true }, channel, tenant));

            const error = await forceLogout({ tenantId: tenant, email, deviceId, actor, reason }).catch(
              (e) => e
            );
            expect(error).toBeInstanceOf(DeviceConflictError);
            expect((error as DeviceConflictError).code).toBe('already_deleted');

            // No signal, no audit, and no writes at all — state unchanged.
            expect(store.docsWithPrefix('logout_signals/')).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
            expect(store.writes).toHaveLength(0);
            expect((store.docs.get(devicePath) as Record<string, any>).isDeleted).toBe(true);
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
          async (email, deviceId, [selected, other], channel, base, actor, reason) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            // Tagged ONLY to `other`, never to the scoped `selected` tenant.
            store.seed(devicePath, withTenant({ ...base, isDeleted: false }, channel, other));

            const error = await forceLogout({
              tenantId: selected,
              email,
              deviceId,
              actor,
              reason,
            }).catch((e) => e);
            expect(error).toBeInstanceOf(TenantScopeError);
            expect((error as TenantScopeError).code).toBe('tenant_scope_violation');

            expect(store.docsWithPrefix('logout_signals/')).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
            expect(store.writes).toHaveLength(0);
          }
        ),
        { numRuns: 120, verbose: false }
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

            const error = await forceLogout({ tenantId: tenant, email, deviceId, actor, reason }).catch(
              (e) => e
            );
            expect(error).toBeInstanceOf(DeviceNotFoundError);

            expect(store.writes).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
            expect(store.docsWithPrefix('logout_signals/')).toHaveLength(0);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );
});
