// Feature: device-console-migration, Property 10: No duplicate active ban

/**
 * Property 10: No duplicate active ban
 * **Validates: Requirements 8.6**
 *
 * For any device whose fingerprint ALREADY has an active `device_bans` record,
 * a further `ban` request is rejected with `DeviceConflictError`
 * (`code: 'active_ban_exists'`) — Requirement 8.6 — and:
 *   - no additional `device_bans` document is created, and
 *   - no audit entry is written,
 * so at most ONE active ban exists per fingerprint at any time.
 *
 * Conversely, for a fingerprint with NO active ban, `ban` succeeds, creates
 * EXACTLY ONE active `device_bans` record for that fingerprint, and writes
 * exactly one `ban` audit entry.
 *
 * The test drives the real, exported `ban` orchestrator from
 * `deviceAdminService.ts`. `./firebaseAdmin` is replaced with `jest.mock` so
 * `getFirestore()` returns an in-memory Firestore fake that covers exactly the
 * surface `ban` touches: the device-doc `get`, a `runTransaction(fn)` whose
 * `tx.get(query)` reflects the active `device_bans` already present (so the
 * assert-then-create sees pre-existing bans), the `device_bans` collection
 * auto-id `doc()` + `tx.set`, and the `deviceAuditLogs` collection `add`.
 * `firebase-admin` itself is NOT mocked, so the `FieldValue`/`Timestamp`
 * sentinels the orchestrator writes are the real ones. `deviceAdminService.ts`
 * is exercised unmodified.
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import {
  ban,
  DeviceConflictError,
  DEVICE_BANS_COLLECTION,
  type ForceLogoutActor,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Documents are addressed by their full slash-joined path so a
// `DocumentReference` handed to the transaction writes back to the same store
// the reads came from. Seeded docs are placed directly into `docs` (no write is
// logged); every write the code under test performs (transaction `set`,
// collection `add`) is applied to `docs` AND appended to `writes`, so a reject
// path is verifiable as "no new ban doc, no audit".

interface WriteRecord {
  type: 'set' | 'update' | 'add';
  path: string;
}

/** A `where(field, '==', value)` equality constraint. */
interface EqualityFilter {
  field: string;
  value: unknown;
}

class FakeStore {
  /** Current document state, keyed by full path (e.g. `device_bans/auto_1`). */
  readonly docs = new Map<string, Record<string, any>>();
  /** Every write applied by the code under test. */
  readonly writes: WriteRecord[] = [];
  private seq = 0;

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Seed a pre-existing document without logging it as a write. */
  seed(path: string, data: Record<string, any>): void {
    this.docs.set(path, { ...data });
  }

  /** Direct children of `collectionPath` (excludes nested sub-collections). */
  childDocs(collectionPath: string): Array<[string, Record<string, any>]> {
    const prefix = `${collectionPath}/`;
    return [...this.docs.entries()].filter(([path]) => {
      if (!path.startsWith(prefix)) {
        return false;
      }
      return !path.slice(prefix.length).includes('/');
    });
  }

  /** Count of active `device_bans` docs matching `fingerprint`. */
  activeBanCount(fingerprint: string): number {
    return this.childDocs(DEVICE_BANS_COLLECTION).filter(
      ([, data]) => data.isActive === true && data.deviceFingerprint === fingerprint
    ).length;
  }

  /** Total number of `device_bans` docs (active or not). */
  banDocCount(): number {
    return this.childDocs(DEVICE_BANS_COLLECTION).length;
  }

  /** Paths of every doc appended to the `deviceAuditLogs` collection. */
  auditPaths(): string[] {
    return this.writes.filter((w) => w.type === 'add' && w.path.startsWith('deviceAuditLogs/')).map(
      (w) => w.path
    );
  }

  applySet(path: string, data: Record<string, any>): void {
    this.docs.set(path, { ...data });
    this.writes.push({ type: 'set', path });
  }

  applyMerge(path: string, data: Record<string, any>): void {
    const current = this.docs.get(path) ?? {};
    this.docs.set(path, { ...current, ...data });
    this.writes.push({ type: 'update', path });
  }

  applyAdd(collectionPath: string, data: Record<string, any>): string {
    const id = `auto_${this.nextId()}`;
    const path = `${collectionPath}/${id}`;
    this.docs.set(path, { ...data });
    this.writes.push({ type: 'add', path });
    return id;
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }

  /**
   * Execute `fn` with a transaction whose reads reflect the current store and
   * whose writes are buffered until `fn` resolves — so a mid-transaction throw
   * (the duplicate-ban conflict) commits nothing (Requirement 8.6).
   */
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    const tx = new FakeTransaction(this);
    const result = await fn(tx);
    tx.commit();
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
}

class FakeQuery {
  constructor(
    readonly store: FakeStore,
    readonly collectionPath: string,
    readonly filters: EqualityFilter[]
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== '==') {
      throw new Error(`FakeQuery only supports '==' (got '${op}')`);
    }
    return new FakeQuery(this.store, this.collectionPath, [...this.filters, { field, value }]);
  }

  private matchingDocs(): Array<[string, Record<string, any>]> {
    return this.store
      .childDocs(this.collectionPath)
      .filter(([, data]) => this.filters.every((f) => data[f.field] === f.value));
  }

  async get(): Promise<{ empty: boolean; size: number; docs: any[] }> {
    const matches = this.matchingDocs();
    return {
      empty: matches.length === 0,
      size: matches.length,
      docs: matches.map(([path, data]) => ({
        id: path.split('/').pop() as string,
        data: () => ({ ...data }),
        ref: new FakeDocRef(this.store, path),
      })),
    };
  }
}

class FakeCollectionRef {
  constructor(readonly store: FakeStore, readonly path: string) {}

  doc(id?: string): FakeDocRef {
    const docId = id ?? `auto_${this.store.nextId()}`;
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
  private readonly ops: Array<() => void> = [];
  constructor(private readonly store: FakeStore) {}

  async get(target: FakeQuery | FakeDocRef): Promise<any> {
    if (target instanceof FakeQuery) {
      return target.get();
    }
    if (target instanceof FakeDocRef) {
      return target.get();
    }
    throw new Error('Unsupported tx.get target');
  }

  set(ref: FakeDocRef, data: Record<string, any>): this {
    this.ops.push(() => this.store.applySet(ref.path, data));
    return this;
  }

  update(ref: FakeDocRef, data: Record<string, any>): this {
    this.ops.push(() => this.store.applyMerge(ref.path, data));
    return this;
  }

  /** Apply buffered writes atomically once the transaction body has resolved. */
  commit(): void {
    for (const op of this.ops) {
      op();
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Path-safe id characters (no '/', no whitespace) so
// `user_devices/{email}/devices/{deviceId}` paths and the derived fingerprint
// (a trimmed `deviceSeedHash`) stay unambiguous and equal to the seed.
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._-@'.split('');
const idArb = fc
  .array(fc.constantFrom(...ID_CHARS), { minLength: 1, maxLength: 20 })
  .map((chars) => chars.join(''));

const TENANTS = ['t1', 't2', 't3'] as const;
const tenantArb = fc.constantFrom(...TENANTS);

/** Two distinct fingerprints, so "other-fingerprint" noise never collides. */
const twoDistinctFingerprintsArb = fc
  .tuple(idArb, idArb)
  .filter(([a, b]) => a !== b);

/** Acting administrator identity (each field independently present or absent). */
const actorArb: fc.Arbitrary<ForceLogoutActor> = fc.record(
  {
    id: fc.option(idArb, { nil: undefined }),
    email: fc.option(idArb, { nil: undefined }),
    name: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  },
  { requiredKeys: [] }
);

/** A non-empty ban reason (route-validated 1–500; stored on the ban record). */
const reasonArb = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0);

/** Optional expiration: absent, epoch-ms, or ISO string (always future here). */
const expiresAtArb = fc.option(
  fc.integer({ min: 1, max: 1_000_000 }).chain((offset) =>
    fc.constantFrom<string | number>(Date.now() + offset, new Date(Date.now() + offset).toISOString())
  ),
  { nil: undefined }
);

/** Whether to seed distractor bans that must NOT affect the outcome. */
const noiseArb = fc.record({
  inactiveSameFingerprint: fc.boolean(),
  activeOtherFingerprint: fc.boolean(),
});

/**
 * Seed the target device (tagged to the scoped tenant via `tenantIds`) with a
 * `deviceSeedHash` fingerprint, so `ban` derives exactly `fingerprint`.
 */
function seedDevice(
  store: FakeStore,
  email: string,
  deviceId: string,
  tenant: string,
  fingerprint: string
): void {
  store.seed(`user_devices/${email}/devices/${deviceId}`, {
    deviceId,
    tenantIds: [tenant],
    deviceSeedHash: fingerprint,
    isDeleted: false,
  });
}

/** Seed distractor bans (an inactive same-fp ban and/or an active other-fp ban). */
function seedNoise(
  store: FakeStore,
  fingerprint: string,
  otherFingerprint: string,
  noise: { inactiveSameFingerprint: boolean; activeOtherFingerprint: boolean }
): void {
  if (noise.inactiveSameFingerprint) {
    store.seed(`${DEVICE_BANS_COLLECTION}/noise_inactive`, {
      banType: 'hard',
      deviceFingerprint: fingerprint,
      isActive: false,
    });
  }
  if (noise.activeOtherFingerprint) {
    store.seed(`${DEVICE_BANS_COLLECTION}/noise_other`, {
      banType: 'hard',
      deviceFingerprint: otherFingerprint,
      isActive: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 10 — no duplicate active ban', () => {
  it(
    'rejects a ban for a fingerprint with an existing active ban (DeviceConflictError active_ban_exists), creates no new ban doc and writes no audit (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          tenantArb,
          twoDistinctFingerprintsArb,
          actorArb,
          reasonArb,
          expiresAtArb,
          noiseArb,
          async (email, deviceId, tenant, [fingerprint, otherFingerprint], actor, reason, expiresAt, noise) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            seedDevice(store, email, deviceId, tenant, fingerprint);
            // Pre-existing ACTIVE ban for this exact fingerprint.
            store.seed(`${DEVICE_BANS_COLLECTION}/existing_active`, {
              banType: 'hard',
              deviceFingerprint: fingerprint,
              isActive: true,
              reason: 'prior ban',
            });
            seedNoise(store, fingerprint, otherFingerprint, noise);

            const banDocsBefore = store.banDocCount();

            const error = await ban({
              tenantId: tenant,
              email,
              deviceId,
              actor,
              reason,
              expiresAt,
            }).catch((e) => e);

            // Rejected with the documented conflict (Requirement 8.6).
            expect(error).toBeInstanceOf(DeviceConflictError);
            expect((error as DeviceConflictError).code).toBe('active_ban_exists');

            // No new ban doc created, and still exactly one active ban for the fp.
            expect(store.banDocCount()).toBe(banDocsBefore);
            expect(store.activeBanCount(fingerprint)).toBe(1);

            // No audit entry, and nothing at all was written.
            expect(store.auditPaths()).toHaveLength(0);
            expect(store.writes).toHaveLength(0);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );

  it(
    'creates exactly one active ban and one audit entry for a fingerprint with no active ban (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          idArb,
          idArb,
          tenantArb,
          twoDistinctFingerprintsArb,
          actorArb,
          reasonArb,
          expiresAtArb,
          noiseArb,
          async (email, deviceId, tenant, [fingerprint, otherFingerprint], actor, reason, expiresAt, noise) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            seedDevice(store, email, deviceId, tenant, fingerprint);
            // No active ban for `fingerprint`; only unrelated distractor bans.
            seedNoise(store, fingerprint, otherFingerprint, noise);

            expect(store.activeBanCount(fingerprint)).toBe(0);

            const result = await ban({
              tenantId: tenant,
              email,
              deviceId,
              actor,
              reason,
              expiresAt,
            });

            expect(result.ok).toBe(true);
            expect(typeof result.banId).toBe('string');
            expect(result.banId.length).toBeGreaterThan(0);

            // Exactly one active ban now exists for the fingerprint (at-most-one
            // holds: 0 -> 1) — Requirement 8.6.
            expect(store.activeBanCount(fingerprint)).toBe(1);

            // The created ban record carries the fingerprint and is active.
            const created = store.docs.get(`${DEVICE_BANS_COLLECTION}/${result.banId}`) as Record<
              string,
              any
            >;
            expect(created).toBeDefined();
            expect(created.deviceFingerprint).toBe(fingerprint);
            expect(created.isActive).toBe(true);
            expect(created.targetDeviceId).toBe(deviceId);
            expect(created.targetUserEmail).toBe(email);

            // Exactly one audit entry for the successful ban (Requirement 8.5).
            expect(store.auditPaths()).toHaveLength(1);
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );
});
