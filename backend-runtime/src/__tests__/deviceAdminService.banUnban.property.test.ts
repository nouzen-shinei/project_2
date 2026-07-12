// Feature: device-console-migration, Property 9: Ban ↔ unban round trip

/**
 * Property 9: Ban ↔ unban round trip
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.7**
 *
 * For any selectable (existing, in-tenant) device with a valid 1–500 char
 * reason:
 *  - `ban` creates EXACTLY ONE active `device_bans` record for the device
 *    fingerprint (Requirement 8.1), storing `expiresAt` on the record IFF an
 *    expiration was provided (Requirement 8.2), and writes exactly one `ban`
 *    audit entry.
 *  - a subsequent `unban` deactivates that ban (`isActive: false`) and restores
 *    the device's access (`isDeleted: false`, `isRestored: true`) so no active
 *    ban remains for the fingerprint (Requirement 8.3), and writes exactly one
 *    `unban` audit entry.
 *  - `unban` on a device that has NO active ban rejects with
 *    `DeviceConflictError` (`code: 'no_active_ban'`) and changes nothing — no
 *    writes, no audit, device state untouched (Requirement 8.7).
 *
 * The test drives the real, exported `ban` / `unban` orchestrators from
 * `deviceAdminService.ts`. `./firebaseAdmin` is replaced with `jest.mock` so
 * `getFirestore()` returns an in-memory Firestore fake covering exactly the
 * surface these orchestrators touch: the device-doc `get`; the top-level
 * `device_bans` collection with `.doc()` auto-id create, `.where(...).where(...)`
 * equality queries, and `runTransaction(fn)` (a `tx` exposing `get(query)` and
 * `set(ref, data)`); the `WriteBatch` (ban `update` + device `update` + parent
 * `user_devices/{email}` merge `set`); and the `deviceAuditLogs` `add`.
 * `firebase-admin` itself is NOT mocked, so the `FieldValue`/`Timestamp`
 * sentinels the orchestrators use are the real ones. `deviceAdminService.ts` is
 * exercised unmodified; the fake records every write so a reject path is
 * verifiable as "zero writes".
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import {
  ban,
  unban,
  DeviceConflictError,
  DEVICE_BANS_COLLECTION,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Documents are addressed by their full slash-joined path so a
// `DocumentReference` handed to a transaction/batch writes back to the same
// store the reads came from. Seeded docs go straight into `docs` (no write is
// logged); every mutation performed by the code under test (transaction `set`,
// batch `update`/`set`, and collection `add`) is applied to `docs` AND appended
// to `writes`, so a reject path is verifiable as "zero writes".

interface WhereClause {
  field: string;
  value: unknown;
}

interface WriteRecord {
  type: 'update' | 'set' | 'add';
  path: string;
  merge?: boolean;
}

interface QueryDoc {
  id: string;
  ref: FakeDocRef;
  data: () => Record<string, any>;
}

interface QuerySnapshot {
  empty: boolean;
  size: number;
  docs: QueryDoc[];
}

class FakeStore {
  /** Current document state, keyed by full path (e.g. `device_bans/auto_1`). */
  readonly docs = new Map<string, Record<string, any>>();
  /** Every write applied by the code under test (empty ⇒ nothing was written). */
  readonly writes: WriteRecord[] = [];
  /** Paths of every doc appended to the `deviceAuditLogs` collection. */
  readonly auditPaths: string[] = [];
  private auditSeq = 0;
  private autoSeq = 0;

  /** Seed a pre-existing document without logging it as a write. */
  seed(path: string, data: Record<string, any>): void {
    this.docs.set(path, { ...data });
  }

  /** Entries whose path starts with `prefix` (e.g. the `device_bans/` collection). */
  docsWithPrefix(prefix: string): Array<[string, Record<string, any>]> {
    return [...this.docs.entries()].filter(([path]) => path.startsWith(prefix));
  }

  nextAuditId(): string {
    this.auditSeq += 1;
    return `audit_${this.auditSeq}`;
  }

  nextAutoId(): string {
    this.autoSeq += 1;
    return `auto_${this.autoSeq}`;
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

  /** Direct children of `collectionPath` matching every equality clause. */
  runQuery(collectionPath: string, clauses: WhereClause[]): QuerySnapshot {
    const prefix = `${collectionPath}/`;
    const matched = [...this.docs.entries()].filter(([path, data]) => {
      if (!path.startsWith(prefix)) {
        return false;
      }
      if (path.slice(prefix.length).includes('/')) {
        return false; // only direct docs, not sub-collections
      }
      return clauses.every((clause) => data[clause.field] === clause.value);
    });
    const docs: QueryDoc[] = matched.map(([path, data]) => ({
      id: path.split('/').pop() as string,
      ref: new FakeDocRef(this, path),
      data: () => ({ ...data }),
    }));
    return { empty: docs.length === 0, size: docs.length, docs };
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }

  batch(): FakeBatch {
    return new FakeBatch(this);
  }

  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx = new FakeTransaction(this);
    // Reads see pre-write state; buffered writes commit only if `fn` resolves,
    // so a thrown conflict leaves the store untouched (transaction atomicity).
    const result = await fn(tx);
    tx.commitBuffered();
    return result;
  }
}

class FakeDocRef {
  constructor(readonly store: FakeStore, readonly path: string) {}

  get id(): string {
    return this.path.split('/').pop() as string;
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this.store, `${this.path}/${name}`);
  }

  async get(): Promise<{ exists: boolean; id: string; data: () => Record<string, any> | undefined }> {
    const data = this.store.docs.get(this.path);
    return {
      exists: data !== undefined,
      id: this.id,
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

class FakeQuery {
  constructor(
    readonly store: FakeStore,
    readonly collectionPath: string,
    readonly clauses: WhereClause[]
  ) {}

  where(field: string, _op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.collectionPath, [...this.clauses, { field, value }]);
  }

  async get(): Promise<QuerySnapshot> {
    return this.store.runQuery(this.collectionPath, this.clauses);
  }
}

class FakeCollectionRef {
  constructor(readonly store: FakeStore, readonly path: string) {}

  doc(id?: string): FakeDocRef {
    const docId = id ?? this.store.nextAutoId();
    return new FakeDocRef(this.store, `${this.path}/${docId}`);
  }

  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.path, []).where(field, op, value);
  }

  async add(data: Record<string, any>): Promise<{ id: string }> {
    const id = this.store.applyAdd(this.path, data);
    return { id };
  }
}

class FakeTransaction {
  private readonly buffered: Array<() => void> = [];
  constructor(private readonly store: FakeStore) {}

  async get(target: FakeQuery | FakeDocRef): Promise<any> {
    return target.get();
  }

  set(ref: FakeDocRef, data: Record<string, any>, options?: { merge?: boolean }): this {
    this.buffered.push(() => this.store.applySet(ref.path, data, Boolean(options?.merge)));
    return this;
  }

  update(ref: FakeDocRef, data: Record<string, any>): this {
    this.buffered.push(() => this.store.applyUpdate(ref.path, data));
    return this;
  }

  commitBuffered(): void {
    for (const op of this.buffered) {
      op();
    }
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
    // Applied together, mirroring an atomic WriteBatch (Requirement 8.3).
    for (const op of this.ops) {
      op();
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Path-safe id characters (no '/'), so `user_devices/{email}/devices/{deviceId}`
// remains an unambiguous full path.
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._-@'.split('');
const idArb = fc
  .array(fc.constantFrom(...ID_CHARS), { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''));

// A non-empty, whitespace-free device fingerprint (stored as `deviceSeedHash`).
const FP_CHARS = 'abcdef0123456789'.split('');
const fingerprintArb = fc
  .array(fc.constantFrom(...FP_CHARS), { minLength: 8, maxLength: 20 })
  .map((chars) => chars.join(''));

const TENANTS = ['t1', 't2', 't3'] as const;
const tenantArb = fc.constantFrom(...TENANTS);

/** The three channels through which a device is associated with a tenant. */
const inTenantChannelArb = fc.constantFrom('tenantIds', 'activeTenantId', 'membership');

/** Base (tenant-agnostic) device metadata; `isDeleted` varies so unban's
 * restore (clearing a deleted flag) is meaningfully exercised. */
const deviceBaseArb = fc.record({
  deviceType: fc.constantFrom('mobile', 'web', 'tablet'),
  deviceName: fc.string({ maxLength: 24 }),
  isDeleted: fc.boolean(),
  sessionActive: fc.boolean(),
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

/** Valid ban reason: non-empty, 1–500 chars (after any trimming). */
const reasonArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .map((s) => (s.trim().length === 0 ? 'banned' : s));

/** Optional expiration strictly later than "now": absent, epoch ms, or ISO. */
const futureMsArb = fc.integer({ min: 60_000, max: 10_000_000 }).map((delta) => Date.now() + delta);
const expiresAtArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  futureMsArb,
  futureMsArb.map((ms) => new Date(ms).toISOString())
);

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

/** Active `device_bans` docs for a fingerprint currently in the store. */
function activeBansFor(store: FakeStore, fingerprint: string): Array<[string, Record<string, any>]> {
  return store
    .docsWithPrefix(`${DEVICE_BANS_COLLECTION}/`)
    .filter(([, data]) => data.deviceFingerprint === fingerprint && data.isActive === true);
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 9 — ban ↔ unban round trip', () => {
  it(
    'ban creates exactly one active ban (expiresAt iff provided); unban deactivates it and restores the device (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          fingerprintArb,
          tenantArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          reasonArb,
          expiresAtArb,
          async (email, deviceId, fingerprint, tenant, channel, base, actor, reason, expiresAt) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            store.seed(
              devicePath,
              withTenant({ ...base, deviceSeedHash: fingerprint }, channel, tenant)
            );

            const hasExpiration = expiresAt !== null && expiresAt !== undefined;

            // --- ban ---
            const banResult = await ban({
              tenantId: tenant,
              email,
              deviceId,
              actor,
              reason,
              expiresAt,
            });
            expect(banResult.ok).toBe(true);
            expect(typeof banResult.banId).toBe('string');

            // Exactly one active ban for the fingerprint.
            const active = activeBansFor(store, fingerprint);
            expect(active).toHaveLength(1);

            const banPath = `${DEVICE_BANS_COLLECTION}/${banResult.banId}`;
            const banData = store.docs.get(banPath) as Record<string, any>;
            expect(banData).toBeDefined();
            expect(banData.deviceFingerprint).toBe(fingerprint);
            expect(banData.isActive).toBe(true);
            expect(banData.banType).toBe('hard');
            expect(banData.reason).toBe(reason);

            // `expiresAt` stored on the record IFF an expiration was provided (Req 8.2).
            expect('expiresAt' in banData).toBe(hasExpiration);
            if (hasExpiration) {
              expect(banData.expiresAt).toBeDefined();
            }

            // Exactly one `ban` audit entry.
            expect(store.auditPaths).toHaveLength(1);
            expect((store.docs.get(store.auditPaths[0]) as Record<string, any>).action).toBe('ban');

            // --- unban ---
            const unbanResult = await unban({ tenantId: tenant, email, deviceId, actor, reason });
            expect(unbanResult).toEqual({ ok: true });

            // The ban is deactivated; no active ban remains for the fingerprint.
            const banAfter = store.docs.get(banPath) as Record<string, any>;
            expect(banAfter.isActive).toBe(false);
            expect(activeBansFor(store, fingerprint)).toHaveLength(0);

            // The device access is restored (Req 8.3).
            const device = store.docs.get(devicePath) as Record<string, any>;
            expect(device.isDeleted).toBe(false);
            expect(device.isRestored).toBe(true);

            // Exactly one additional `unban` audit entry.
            expect(store.auditPaths).toHaveLength(2);
            expect((store.docs.get(store.auditPaths[1]) as Record<string, any>).action).toBe('unban');
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );

  it(
    'unban on a device with no active ban rejects with DeviceConflictError(no_active_ban) and changes nothing (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          fingerprintArb,
          tenantArb,
          inTenantChannelArb,
          deviceBaseArb,
          actorArb,
          reasonArb,
          async (email, deviceId, fingerprint, tenant, channel, base, actor, reason) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const devicePath = `user_devices/${email}/devices/${deviceId}`;
            const seeded = withTenant({ ...base, deviceSeedHash: fingerprint }, channel, tenant);
            store.seed(devicePath, seeded);
            const before = { ...(store.docs.get(devicePath) as Record<string, any>) };

            const error = await unban({ tenantId: tenant, email, deviceId, actor, reason }).catch(
              (e) => e
            );
            expect(error).toBeInstanceOf(DeviceConflictError);
            expect((error as DeviceConflictError).code).toBe('no_active_ban');

            // No writes at all, no audit, device state unchanged (Req 8.7).
            expect(store.writes).toHaveLength(0);
            expect(store.auditPaths).toHaveLength(0);
            expect(store.docsWithPrefix(`${DEVICE_BANS_COLLECTION}/`)).toHaveLength(0);
            expect(store.docs.get(devicePath)).toEqual(before);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );
});
