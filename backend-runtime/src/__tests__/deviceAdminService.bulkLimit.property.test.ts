// Feature: device-console-migration, Property 19: Bulk size limit and single-device gating

/**
 * Property 19: Bulk size limit and single-device gating
 * **Validates: Requirements 14.2, 14.3, 14.6**
 *
 * Two guarantees are exercised here against the real, exported orchestrators in
 * `deviceAdminService.ts` (the module is NOT modified):
 *
 *  1. Bulk size limit (Requirement 14.2). `notify` and `bulkForceLogout` are the
 *     only bulk actions; both accept a selection of up to `DEFAULT_MAX_TARGETS`
 *     (500) targets and reject a larger selection with a `DeviceAdminError`
 *     carrying `code: 'too_many_targets'` and `status: 400`. The property drives
 *     small all-succeed selections (so acceptance is fast) across many generated
 *     sizes, and two explicit boundary checks pin the cap exactly at 500
 *     (accepted) / 501 (rejected).
 *
 *  2. Single-device gating (Requirements 14.3, 14.6). `ban`, `softDelete`, and
 *     `permanentDelete` are single-device: their parameter types accept exactly
 *     one `deviceId: string` (never an array), there is NO bulk variant of any
 *     of them exported from the service, and a runtime single-device call
 *     mutates exactly the one addressed device. The compile-time shape guards
 *     below document the type contract; the runtime introspection + single
 *     device calls enforce it during the test run.
 *
 * Firestore is replaced via `jest.mock('../firebaseAdmin')` with a minimal
 * in-memory fake covering only the reads/writes these orchestrators perform
 * (device-doc `get`, `WriteBatch` update/set/delete, and `deviceAuditLogs.add`).
 * `firebase-admin` itself is real, so the `FieldValue` sentinels the code writes
 * are genuine. `../pushUtils` and `../webPush` are mocked so that, for the
 * accepted (<=500) notify case, every delivery succeeds.
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import { sendExpoMessages } from '../pushUtils';
import { sendWebPushNotification, sanitizeWebPushSubscription } from '../webPush';
import * as deviceAdminService from '../deviceAdminService';
import {
  notify,
  bulkForceLogout,
  softDelete,
  permanentDelete,
  DeviceAdminError,
  DEFAULT_MAX_TARGETS,
  type BanParams,
  type SoftDeleteParams,
  type PermanentDeleteParams,
  type DeviceTarget,
  type ForceLogoutActor,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin');
jest.mock('../pushUtils', () => ({
  __esModule: true,
  sendExpoMessages: jest.fn(),
}));
jest.mock('../webPush', () => ({
  __esModule: true,
  sendWebPushNotification: jest.fn(),
  sanitizeWebPushSubscription: jest.fn(() => null),
}));

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;
const mockedSendExpo = sendExpoMessages as jest.MockedFunction<typeof sendExpoMessages>;
const mockedSendWebPush = sendWebPushNotification as jest.MockedFunction<
  typeof sendWebPushNotification
>;
const mockedSanitize = sanitizeWebPushSubscription as jest.MockedFunction<
  typeof sanitizeWebPushSubscription
>;

// ---------------------------------------------------------------------------
// Compile-time single-device shape guards (Requirement 14.3; design Property 19)
// ---------------------------------------------------------------------------
//
// These fail `tsc` if any single-device orchestrator's `deviceId` becomes
// non-string (e.g. an array) or a bulk array field is introduced. They are
// type-only and erased at runtime; the runtime introspection below enforces the
// same intent during the jest run.

type Expect<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type HasNoBulkField<T> = 'deviceIds' extends keyof T
  ? false
  : 'targets' extends keyof T
    ? false
    : 'devices' extends keyof T
      ? false
      : true;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _BanDeviceIdIsString = Expect<Equals<BanParams['deviceId'], string>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _DeleteDeviceIdIsString = Expect<Equals<SoftDeleteParams['deviceId'], string>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _PermDeviceIdIsString = Expect<Equals<PermanentDeleteParams['deviceId'], string>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _BanNoBulk = Expect<HasNoBulkField<BanParams>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _DeleteNoBulk = Expect<HasNoBulkField<SoftDeleteParams>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _PermNoBulk = Expect<HasNoBulkField<PermanentDeleteParams>>;

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Documents are addressed by their full slash-joined path so a
// `DocumentReference` handed to a batch resolves to the same store the reads
// came from. Seeded docs go straight into `docs`; every mutation the code under
// test performs is applied AND appended to `writes`, so a rejected/no-op path is
// verifiable as "zero writes" and single-device calls can be shown to touch only
// the one addressed device.

interface WriteRecord {
  type: 'update' | 'set' | 'delete' | 'add';
  path: string;
  merge?: boolean;
}

class FakeStore {
  readonly docs = new Map<string, Record<string, any>>();
  readonly writes: WriteRecord[] = [];
  readonly auditPaths: string[] = [];
  private auditSeq = 0;

  seed(path: string, data: Record<string, any>): void {
    this.docs.set(path, { ...data });
  }

  docsWithPrefix(prefix: string): Array<[string, Record<string, any>]> {
    return [...this.docs.entries()].filter(([path]) => path.startsWith(prefix));
  }

  private nextAuditId(): string {
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

  applyDelete(path: string): void {
    this.docs.delete(path);
    this.writes.push({ type: 'delete', path });
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

  delete(ref: FakeDocRef): this {
    this.ops.push(() => this.store.applyDelete(ref.path));
    return this;
  }

  async commit(): Promise<void> {
    // Applied together, mirroring an atomic WriteBatch.
    for (const op of this.ops) {
      op();
    }
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures / generators
// ---------------------------------------------------------------------------

const TENANT = 't1';
const ACTOR: ForceLogoutActor = { id: 'uid_admin', email: 'admin@example.com', name: 'Admin' };

/** A safe, slash-free lowercase token (used for email local parts / ids). */
const token = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: min,
      maxLength: max,
    })
    .map((chars) => chars.join(''));

/** Build N distinct targets sharing one owner email but with unique device ids. */
function buildTargets(email: string, prefix: string, n: number): DeviceTarget[] {
  return Array.from({ length: n }, (_unused, i) => ({ email, deviceId: `${prefix}-${i}` }));
}

/** Seed one in-tenant, deliverable, non-deleted device per target. */
function seedDeliverableDevices(store: FakeStore, targets: DeviceTarget[]): void {
  for (const { email, deviceId } of targets) {
    store.seed(`user_devices/${email}/devices/${deviceId}`, {
      deviceId,
      tenantIds: [TENANT],
      isDeleted: false,
      sessionActive: true,
      expoPushToken: `ExponentPushToken[${deviceId}]`,
    });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  // Accepted (<=500) notify case: every delivery succeeds.
  mockedSendExpo.mockResolvedValue({ sent: 1, failed: 0, tickets: [] } as any);
  mockedSendWebPush.mockResolvedValue({ ok: true } as any);
  mockedSanitize.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Property 19a — bulk size limit: notify / bulkForceLogout accept up to 500
// ---------------------------------------------------------------------------

describe('Property 19 — bulk size limit (notify & bulkForceLogout accept up to 500 targets)', () => {
  it(
    'accepts any selection of 1..N (<=500) with no too_many_targets rejection (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          token(1, 8),
          token(1, 6),
          fc.integer({ min: 1, max: 8 }),
          async (emailLocal, prefix, n) => {
            const email = `${emailLocal}@example.com`;
            const targets = buildTargets(email, prefix, n);

            // notify accepts the selection and every delivery succeeds.
            const notifyStore = new FakeStore();
            mockedGetFirestore.mockReturnValue(notifyStore as any);
            seedDeliverableDevices(notifyStore, targets);
            const notifyResult = await notify({
              tenantId: TENANT,
              title: 'Title',
              body: 'Body',
              targets,
              actor: ACTOR,
            });
            expect(notifyResult.ok).toBe(true);
            expect(notifyResult.successful).toBe(n);
            expect(notifyResult.failed).toBe(0);
            expect(notifyResult.results).toHaveLength(n);

            // bulkForceLogout accepts the same selection; each target succeeds.
            const bulkStore = new FakeStore();
            mockedGetFirestore.mockReturnValue(bulkStore as any);
            seedDeliverableDevices(bulkStore, targets);
            const bulkResult = await bulkForceLogout({
              tenantId: TENANT,
              targets,
              actor: ACTOR,
              reason: 'bulk force logout',
            });
            expect(bulkResult.ok).toBe(true);
            expect(bulkResult.succeeded).toBe(n);
            expect(bulkResult.failed).toBe(0);
            expect(bulkResult.results).toHaveLength(n);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );

  it('accepts a selection of exactly DEFAULT_MAX_TARGETS (500) — boundary', async () => {
    const email = 'boundary@example.com';
    const targets = buildTargets(email, 'd', DEFAULT_MAX_TARGETS);
    expect(targets).toHaveLength(500);

    const notifyStore = new FakeStore();
    mockedGetFirestore.mockReturnValue(notifyStore as any);
    seedDeliverableDevices(notifyStore, targets);
    const notifyResult = await notify({
      tenantId: TENANT,
      title: 'Title',
      body: 'Body',
      targets,
      actor: ACTOR,
    });
    expect(notifyResult.successful).toBe(DEFAULT_MAX_TARGETS);
    expect(notifyResult.failed).toBe(0);

    const bulkStore = new FakeStore();
    mockedGetFirestore.mockReturnValue(bulkStore as any);
    seedDeliverableDevices(bulkStore, targets);
    const bulkResult = await bulkForceLogout({
      tenantId: TENANT,
      targets,
      actor: ACTOR,
    });
    expect(bulkResult.succeeded).toBe(DEFAULT_MAX_TARGETS);
    expect(bulkResult.failed).toBe(0);
  }, 30_000);

  it('rejects a selection of 501 (> DEFAULT_MAX_TARGETS) with too_many_targets / 400 — boundary', async () => {
    const email = 'over@example.com';
    const targets = buildTargets(email, 'd', DEFAULT_MAX_TARGETS + 1);
    expect(targets).toHaveLength(501);

    const store = new FakeStore();
    mockedGetFirestore.mockReturnValue(store as any);

    const notifyErr = await notify({
      tenantId: TENANT,
      title: 'Title',
      body: 'Body',
      targets,
      actor: ACTOR,
    }).catch((e) => e);
    expect(notifyErr).toBeInstanceOf(DeviceAdminError);
    expect((notifyErr as DeviceAdminError).code).toBe('too_many_targets');
    expect((notifyErr as DeviceAdminError).status).toBe(400);

    const bulkErr = await bulkForceLogout({
      tenantId: TENANT,
      targets,
      actor: ACTOR,
    }).catch((e) => e);
    expect(bulkErr).toBeInstanceOf(DeviceAdminError);
    expect((bulkErr as DeviceAdminError).code).toBe('too_many_targets');
    expect((bulkErr as DeviceAdminError).status).toBe(400);

    // Rejected before any write — nothing was persisted.
    expect(store.writes).toHaveLength(0);
    expect(store.auditPaths).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Property 19b — single-device gating (ban / delete / permanent-delete)
// ---------------------------------------------------------------------------

describe('Property 19 — single-device gating (ban / softDelete / permanentDelete are single-device)', () => {
  it('exposes single-device orchestrators and NO bulk variant of ban/delete/permanent-delete', () => {
    // The single-device orchestrators exist and are the only ban/delete/perm surface.
    expect(typeof deviceAdminService.ban).toBe('function');
    expect(typeof deviceAdminService.softDelete).toBe('function');
    expect(typeof deviceAdminService.permanentDelete).toBe('function');

    // The bulk-capable actions exist (contrast: notify + force-logout are bulk).
    expect(typeof deviceAdminService.notify).toBe('function');
    expect(typeof deviceAdminService.bulkForceLogout).toBe('function');

    // There is NO bulk variant of the single-device actions (Req 14.3, 14.6).
    const service = deviceAdminService as unknown as Record<string, unknown>;
    for (const name of [
      'bulkBan',
      'banDevices',
      'bulkSoftDelete',
      'softDeleteDevices',
      'bulkDelete',
      'deleteDevices',
      'bulkPermanentDelete',
      'permanentDeleteDevices',
    ]) {
      expect(service[name]).toBeUndefined();
    }
  });

  it('softDelete accepts a single deviceId: string and mutates exactly the one device', async () => {
    const store = new FakeStore();
    mockedGetFirestore.mockReturnValue(store as any);

    const email = 'owner@example.com';
    const deviceId = 'device-1';
    const devicePath = `user_devices/${email}/devices/${deviceId}`;
    store.seed(devicePath, { deviceId, tenantIds: [TENANT], isDeleted: false, sessionActive: true });

    const params: SoftDeleteParams = {
      tenantId: TENANT,
      email,
      deviceId, // a single string, never an array
      actor: ACTOR,
      reason: 'policy violation',
    };
    const result = await softDelete(params);
    expect(result).toEqual({ ok: true });

    // The addressed device is soft-deleted.
    expect((store.docs.get(devicePath) as Record<string, any>).isDeleted).toBe(true);

    // Exactly one force-logout signal for exactly this device, and one audit entry.
    const signals = store.docsWithPrefix('logout_signals/');
    expect(signals).toHaveLength(1);
    expect(signals[0][0]).toBe(`logout_signals/${email}_${deviceId}`);
    expect(store.auditPaths).toHaveLength(1);

    // Only the single addressed device doc exists under the owner's devices.
    const deviceDocs = store.docsWithPrefix(`user_devices/${email}/devices/`);
    expect(deviceDocs).toHaveLength(1);
  });

  it('permanentDelete accepts a single deviceId: string and removes exactly the one device', async () => {
    const store = new FakeStore();
    mockedGetFirestore.mockReturnValue(store as any);

    const email = 'owner@example.com';
    const deviceId = 'device-1';
    const devicePath = `user_devices/${email}/devices/${deviceId}`;
    store.seed(devicePath, { deviceId, tenantIds: [TENANT], isDeleted: false });

    const params: PermanentDeleteParams = {
      tenantId: TENANT,
      email,
      deviceId, // a single string, never an array
      actor: ACTOR,
      reason: 'permanent removal',
    };
    const result = await permanentDelete(params);
    expect(result).toEqual({ ok: true });

    // The one addressed device doc is gone; no device docs remain for the owner.
    expect(store.docs.get(devicePath)).toBeUndefined();
    expect(store.docsWithPrefix(`user_devices/${email}/devices/`)).toHaveLength(0);

    // Exactly one audit entry recorded for the single device.
    expect(store.auditPaths).toHaveLength(1);
  });
});
