// Feature: device-console-migration, Property 11: Delete ↔ restore round trip and idempotence

/**
 * Property 11: Delete ↔ restore round trip and idempotence
 * **Validates: Requirements 9.1, 9.3, 9.5, 9.6**
 *
 * For any existing, non-deleted device with a valid reason (1–500 characters):
 *   - `softDelete` marks the device deleted (deletion provenance) AND records an
 *     unconsumed `Force_Logout_Signal` at `logout_signals/{email}_{deviceId}`
 *     (`consumed: false`) — Requirement 9.1; and
 *   - a subsequent `restore` returns the device to the active state
 *     (`isDeleted: false`, `isRestored: true`) with access restored —
 *     Requirement 9.3.
 *
 * Idempotence / lifecycle rejections (checks run BEFORE any write, so a rejected
 * request performs no mutation):
 *   - deleting an already-deleted device rejects with
 *     `DeviceConflictError('already_deleted')`, makes NO state change and records
 *     NO additional `Force_Logout_Signal` — Requirement 9.5; and
 *   - restoring a non-deleted device rejects with
 *     `DeviceConflictError('not_deleted')` and makes no change — Requirement 9.6.
 *
 * The test drives the real, exported `softDelete` / `restore` orchestrators from
 * `deviceAdminService.ts`. The `./firebaseAdmin` module is replaced with
 * `jest.mock` so `getFirestore()` returns an in-memory Firestore fake covering
 * exactly the reads/writes these orchestrators perform: the device-doc `get`,
 * the `WriteBatch` (device `update`, `logout_signals/{email}_{deviceId}` `set`,
 * and the parent `user_devices/{email}` merge `set`), and the `deviceAuditLogs`
 * collection `add`. `firebase-admin` itself is NOT mocked, so the `FieldValue`
 * sentinels used by the orchestrators are the real ones. `deviceAdminService.ts`
 * is exercised unmodified; the fake records every write so we can assert both the
 * presence (round trip) and the total absence (reject paths) of the signal +
 * audit + device mutations across many generated inputs.
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import {
  softDelete,
  restore,
  DeviceConflictError,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Models only the surface `softDelete` / `restore` touch, addressing documents
// by their full slash-joined path so a `DocumentReference` handed to a batch
// writes back to the same store the reads came from. Seeded docs are placed
// directly into `docs` (no write is logged); every mutation performed by the
// orchestrators (batch update/set and collection add) is applied to `docs` AND
// appended to `writes`, so a reject path is verifiable as "zero writes".

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
    // Applied together, mirroring an atomic WriteBatch (Requirement 9.1).
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

// The single tenant every seeded device is scoped to, so the round trip stays
// in-scope (out-of-tenant / not-found rejections are covered by Property 12's
// force-logout test and the tenant-scope property test).
const SCOPED_TENANT = 't1';

/** The three channels through which a device is associated with the tenant. */
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

/** A valid destructive-action reason (1–500 characters, per Requirement 9.1). */
const reasonArb = fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0);

/** Optional reason accepted by `restore` (recorded on the audit entry). */
const optionalReasonArb = fc.option(fc.string({ minLength: 1, maxLength: 60 }), { nil: undefined });

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

describe('Property 11 — delete ↔ restore round trip and idempotence', () => {
  it(
    'soft delete then restore round-trips a live in-tenant device, recording one signal on delete (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          reasonArb,
          optionalReasonArb,
          async (email, deviceId, channel, base, actor, reason, restoreReason) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            store.seed(devicePath, withTenant({ ...base, isDeleted: false }, channel, SCOPED_TENANT));

            // --- Soft delete (Requirement 9.1) ---
            const deleteResult = await softDelete({
              tenantId: SCOPED_TENANT,
              email,
              deviceId,
              actor,
              reason,
            });
            expect(deleteResult).toEqual({ ok: true });

            // Device is marked deleted with deletion provenance.
            const deleted = store.docs.get(devicePath) as Record<string, any>;
            expect(deleted.isDeleted).toBe(true);
            expect(deleted.deletionReason).toBe(reason);
            expect(deleted.logoutSignal).toBe(true);
            expect(deleted.isOnline).toBe(false);

            // Exactly one unconsumed signal at the deterministic pair key.
            const signals = store.docsWithPrefix('logout_signals/');
            expect(signals).toHaveLength(1);
            const [signalPath, signalData] = signals[0];
            expect(signalPath).toBe(`logout_signals/${email}_${deviceId}`);
            expect(signalData.consumed).toBe(false);

            // Exactly one audit entry for the delete.
            expect(store.auditPaths).toHaveLength(1);

            // --- Restore (Requirement 9.3) ---
            const restoreResult = await restore({
              tenantId: SCOPED_TENANT,
              email,
              deviceId,
              actor,
              reason: restoreReason,
            });
            expect(restoreResult).toEqual({ ok: true });

            // Device returned to active with access restored.
            const restored = store.docs.get(devicePath) as Record<string, any>;
            expect(restored.isDeleted).toBe(false);
            expect(restored.isRestored).toBe(true);

            // No new signal was recorded by the restore (still exactly one).
            expect(store.docsWithPrefix('logout_signals/')).toHaveLength(1);
            // A second audit entry for the restore.
            expect(store.auditPaths).toHaveLength(2);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );

  it(
    'deleting an already-deleted device rejects with already_deleted, changing nothing and recording no new signal (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          reasonArb,
          async (email, deviceId, channel, base, actor, reason) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            // Already deleted, and carrying a pre-existing (consumed) signal so we
            // can prove softDelete records NO additional signal (Requirement 9.5).
            store.seed(
              devicePath,
              withTenant({ ...base, isDeleted: true, deletionReason: 'prior' }, channel, SCOPED_TENANT)
            );
            const priorSignalPath = `logout_signals/${email}_${deviceId}`;
            store.seed(priorSignalPath, { consumed: true, reason: 'prior' });

            const error = await softDelete({
              tenantId: SCOPED_TENANT,
              email,
              deviceId,
              actor,
              reason,
            }).catch((e) => e);
            expect(error).toBeInstanceOf(DeviceConflictError);
            expect((error as DeviceConflictError).code).toBe('already_deleted');

            // No writes at all: no new signal, no audit, device untouched.
            expect(store.writes).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
            // Exactly the one pre-seeded signal remains, still consumed (unchanged).
            const signals = store.docsWithPrefix('logout_signals/');
            expect(signals).toHaveLength(1);
            expect(signals[0][1].consumed).toBe(true);
            // Device state unchanged.
            const device = store.docs.get(devicePath) as Record<string, any>;
            expect(device.isDeleted).toBe(true);
            expect(device.deletionReason).toBe('prior');
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );

  it(
    'restoring a non-deleted device rejects with not_deleted and writes nothing (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          optionalReasonArb,
          async (email, deviceId, channel, base, actor, reason) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            store.seed(devicePath, withTenant({ ...base, isDeleted: false }, channel, SCOPED_TENANT));

            const error = await restore({
              tenantId: SCOPED_TENANT,
              email,
              deviceId,
              actor,
              reason,
            }).catch((e) => e);
            expect(error).toBeInstanceOf(DeviceConflictError);
            expect((error as DeviceConflictError).code).toBe('not_deleted');

            // No writes at all — state unchanged, no signal, no audit.
            expect(store.writes).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
            expect(store.docsWithPrefix('logout_signals/')).toHaveLength(0);
            expect((store.docs.get(devicePath) as Record<string, any>).isDeleted).toBe(false);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );
});
