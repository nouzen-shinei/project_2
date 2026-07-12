// Feature: device-console-migration, Property 14: Audit completeness for destructive actions

/**
 * Property 14: Audit completeness for destructive actions
 * **Validates: Requirements 7.4, 8.5, 9.4, 10.3, 11.2, 16.3, 17.1, 17.2**
 *
 * Every successful destructive action writes EXACTLY ONE durable audit entry to
 * the append-only `deviceAuditLogs` collection recording:
 *   - the action type (`action`),
 *   - the actor identity (`actorId` / `actorEmail` / `actorName`),
 *   - the target device and/or target user (`targetDeviceId` / `targetUserEmail`),
 *   - the reason, when one was supplied,
 *   - the affected count, for `force_logout_all`, and
 *   - the action timestamp (`actionTimeMs` + ISO `createdAt`).
 *
 * Scope of THIS test: only the force-logout orchestrators exist so far
 * (`forceLogout`, `forceLogoutAll`), which both persist through the shared
 * `writeAudit` call. Testing audit completeness for these two establishes the
 * pattern reused by the later destructive orchestrators (ban/unban, delete/
 * restore/permanent-delete, notify), which is why the property is validated
 * against every listed requirement.
 *
 * The orchestrators DO touch Firestore, so this suite replaces `getFirestore()`
 * (from `../firebaseAdmin`) with a minimal in-memory Firestore fake that:
 *   - serves the device reads `forceLogout` / `forceLogoutAll` perform,
 *   - accepts the `batch()` provenance-update + `logout_signals` writes and the
 *     parent `user_devices/{email}` activity touch, and
 *   - records every `.collection('deviceAuditLogs').add(doc)` call so the test
 *     can assert exactly one audit document was written and inspect its fields.
 *
 * The device-doc `FieldValue` sentinels the orchestrators write come from the
 * real `firebase-admin` module (`FieldValue.serverTimestamp()` / `.delete()`),
 * which require no initialized app, so only `firebaseAdmin.getFirestore` is
 * mocked.
 */

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// In-memory Firestore fake (declared before the mock so the factory closure can
// read the current instance). The `mock`-prefixed name lets the hoisted
// `jest.mock` factory reference it.
// ---------------------------------------------------------------------------

/** A recorded `.add()` call: the collection it targeted and the persisted body. */
interface RecordedAdd {
  collectionPath: string;
  data: Record<string, unknown>;
  id: string;
}

/** Minimal document snapshot returned by `doc.get()`. */
interface FakeDocSnapshot {
  exists: boolean;
  id: string;
  data: () => Record<string, unknown> | undefined;
  ref: FakeDocRef;
}

class FakeDocRef {
  constructor(
    private readonly store: FakeFirestore,
    readonly path: string
  ) {}

  private get id(): string {
    const parts = this.path.split('/');
    return parts[parts.length - 1];
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this.store, `${this.path}/${name}`);
  }

  async get(): Promise<FakeDocSnapshot> {
    const has = this.store.docs.has(this.path);
    return {
      exists: has,
      id: this.id,
      data: () => this.store.docs.get(this.path),
      ref: this,
    };
  }

  async set(data: Record<string, unknown>, options?: { merge?: boolean }): Promise<void> {
    this.store.applySet(this.path, data, options);
  }
}

class FakeCollectionRef {
  constructor(
    private readonly store: FakeFirestore,
    readonly path: string
  ) {}

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.store, `${this.path}/${id}`);
  }

  async get(): Promise<{ docs: FakeDocSnapshot[]; empty: boolean; size: number }> {
    const prefix = `${this.path}/`;
    const docs: FakeDocSnapshot[] = [];
    for (const [docPath, data] of this.store.docs) {
      if (!docPath.startsWith(prefix)) {
        continue;
      }
      const rest = docPath.slice(prefix.length);
      if (rest.includes('/')) {
        continue; // belongs to a nested sub-collection, not this one
      }
      const ref = new FakeDocRef(this.store, docPath);
      docs.push({
        exists: true,
        id: rest,
        data: () => data,
        ref,
      });
    }
    return { docs, empty: docs.length === 0, size: docs.length };
  }

  async add(data: Record<string, unknown>): Promise<{ id: string }> {
    const id = `auto_${this.store.nextId()}`;
    this.store.adds.push({ collectionPath: this.path, data, id });
    this.store.docs.set(`${this.path}/${id}`, data);
    return { id };
  }
}

class FakeBatch {
  private readonly ops: Array<() => void> = [];

  constructor(private readonly store: FakeFirestore) {}

  update(ref: FakeDocRef, data: Record<string, unknown>): FakeBatch {
    this.ops.push(() => this.store.applyMerge(ref.path, data));
    return this;
  }

  set(ref: FakeDocRef, data: Record<string, unknown>, options?: { merge?: boolean }): FakeBatch {
    this.ops.push(() => this.store.applySet(ref.path, data, options));
    return this;
  }

  async commit(): Promise<void> {
    for (const op of this.ops) {
      op();
    }
  }
}

class FakeFirestore {
  /** Every persisted document keyed by its full slash-delimited path. */
  readonly docs = new Map<string, Record<string, unknown>>();
  /** Every `.add()` call, in order, so the test can assert audit completeness. */
  readonly adds: RecordedAdd[] = [];
  private counter = 0;

  nextId(): number {
    this.counter += 1;
    return this.counter;
  }

  collection(name: string): FakeCollectionRef {
    return new FakeCollectionRef(this, name);
  }

  batch(): FakeBatch {
    return new FakeBatch(this);
  }

  /** Seed a device / doc directly (test setup only). */
  seed(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, { ...data });
  }

  applySet(path: string, data: Record<string, unknown>, options?: { merge?: boolean }): void {
    if (options?.merge) {
      this.applyMerge(path, data);
    } else {
      this.docs.set(path, { ...data });
    }
  }

  applyMerge(path: string, data: Record<string, unknown>): void {
    const existing = this.docs.get(path) ?? {};
    this.docs.set(path, { ...existing, ...data });
  }

  /** Audit documents recorded so far (only the `deviceAuditLogs` collection). */
  auditDocs(): RecordedAdd[] {
    return this.adds.filter((entry) => entry.collectionPath === 'deviceAuditLogs');
  }
}

// The Firestore instance the mocked `getFirestore()` returns for the current
// property iteration. Reassigned before each orchestrator call.
let mockCurrentDb: FakeFirestore = new FakeFirestore();

jest.mock('../firebaseAdmin', () => ({
  __esModule: true,
  getFirestore: () => mockCurrentDb,
  ensureFirebase: () => undefined,
  resetFirebaseForTests: () => undefined,
}));

// Imported AFTER the mock is registered so the service picks up the fake.
import {
  forceLogout,
  forceLogoutAll,
  writeAudit,
  AuditWriteError,
  type ForceLogoutActor,
} from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const IN_TENANT = 't1';
const OTHER_TENANT = 'other-tenant';

/** A safe, slash-free lowercase token (used for email local parts / ids). */
const token = (min: number, max: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: min,
      maxLength: max,
    })
    .map((chars) => chars.join(''));

/** An email with no `/` (so Firestore paths stay well-formed). */
const emailArb: fc.Arbitrary<string> = token(1, 8).map((local) => `${local}@example.com`);

/** An actor whose email is always present; id/name are independently optional. */
const actorArb: fc.Arbitrary<ForceLogoutActor> = fc.record(
  {
    id: token(3, 10).map((s) => `uid_${s}`),
    email: token(1, 8).map((s) => `admin_${s}@example.com`),
    name: token(1, 8).map((s) => `Admin ${s}`),
  },
  { requiredKeys: ['email'] }
);

/** An optional non-empty reason (undefined => no reason supplied). */
const reasonArb: fc.Arbitrary<string | undefined> = fc.option(token(1, 40), { nil: undefined });

// ---------------------------------------------------------------------------
// Property 14 — single-device force logout writes exactly one audit entry
// ---------------------------------------------------------------------------

describe('Property 14 — audit completeness for force_logout (single device)', () => {
  it(
    'a successful forceLogout writes EXACTLY ONE force_logout audit entry with actor, target, reason (when supplied), and timestamp (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(emailArb, token(1, 12), actorArb, reasonArb, async (email, deviceId, actor, reason) => {
          const db = new FakeFirestore();
          mockCurrentDb = db;

          // A non-deleted, in-tenant device so the action succeeds.
          const devicePath = `user_devices/${email}/devices/${deviceId}`;
          db.seed(devicePath, {
            deviceId,
            tenantIds: [IN_TENANT],
            isDeleted: false,
            sessionActive: true,
          });

          const result = await forceLogout({
            tenantId: IN_TENANT,
            email,
            deviceId,
            actor,
            reason,
          });
          expect(result).toEqual({ ok: true });

          // Exactly one durable audit entry, and it is the only `.add()` at all.
          const audits = db.auditDocs();
          expect(audits).toHaveLength(1);
          expect(db.adds).toHaveLength(1);

          const entry = audits[0].data as Record<string, unknown>;

          // Action type (Req 17.1).
          expect(entry.action).toBe('force_logout');

          // Target device + user (Req 7.4, 17.1).
          expect(entry.targetDeviceId).toBe(deviceId);
          expect(entry.targetUserEmail).toBe(email);

          // Actor identity (Req 16.3): whatever the actor supplied is recorded.
          expect(entry.actorEmail).toBe(actor.email);
          if (typeof actor.id === 'string') {
            expect(entry.actorId).toBe(actor.id);
          }
          if (typeof actor.name === 'string') {
            expect(entry.actorName).toBe(actor.name);
          }

          // Reason recorded only when supplied (Req 17.2); absent otherwise.
          if (typeof reason === 'string') {
            expect(entry.reason).toBe(reason);
          } else {
            expect('reason' in entry).toBe(false);
          }

          // Action timestamp present and mutually consistent (Req 17.1, 17.2).
          expect(typeof entry.actionTimeMs).toBe('number');
          expect(Number.isFinite(entry.actionTimeMs as number)).toBe(true);
          expect(typeof entry.createdAt).toBe('string');
          expect(new Date(entry.createdAt as string).toISOString()).toBe(entry.createdAt);
        }),
        { numRuns: 150 }
      );
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// Property 14 — force-logout-all writes exactly one audit entry carrying the
// affected count of active, in-tenant devices signaled.
// ---------------------------------------------------------------------------

/** A generated device with an independently-known eligibility for force-logout-all. */
const flaDeviceArb = fc.record({
  inTenant: fc.boolean(),
  deleted: fc.boolean(),
  // `undefined` and `true` are both "active"; only explicit `false` is inactive.
  sessionActive: fc.constantFrom<boolean | undefined>(true, false, undefined),
});

describe('Property 14 — audit completeness for force_logout_all', () => {
  it(
    'a successful forceLogoutAll writes EXACTLY ONE force_logout_all audit entry whose affectedCount equals the number of active in-tenant devices signaled (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          emailArb,
          actorArb,
          reasonArb,
          fc.array(flaDeviceArb, { minLength: 0, maxLength: 10 }),
          async (email, actor, reason, deviceSpecs) => {
            const db = new FakeFirestore();
            mockCurrentDb = db;

            // Seed the user's devices with stable, unique ids.
            deviceSpecs.forEach((spec, index) => {
              const deviceId = `d${index}`;
              const data: Record<string, unknown> = {
                deviceId,
                tenantIds: [spec.inTenant ? IN_TENANT : OTHER_TENANT],
                isDeleted: spec.deleted,
              };
              if (spec.sessionActive !== undefined) {
                data.sessionActive = spec.sessionActive;
              }
              db.seed(`user_devices/${email}/devices/${deviceId}`, data);
            });

            // Independent oracle: active-session, non-deleted, in-tenant devices.
            const expectedAffected = deviceSpecs.filter(
              (spec) => spec.inTenant && !spec.deleted && spec.sessionActive !== false
            ).length;

            const result = await forceLogoutAll({
              tenantId: IN_TENANT,
              email,
              actor,
              reason,
            });
            expect(result).toEqual({ ok: true, affected: expectedAffected });

            // Exactly one durable audit entry regardless of how many devices
            // were signaled (including zero) — and it is the only `.add()`.
            const audits = db.auditDocs();
            expect(audits).toHaveLength(1);
            expect(db.adds).toHaveLength(1);

            const entry = audits[0].data as Record<string, unknown>;

            // Action type + user target (Req 11.2, 17.1).
            expect(entry.action).toBe('force_logout_all');
            expect(entry.targetUserEmail).toBe(email);
            expect('targetDeviceId' in entry).toBe(false);

            // Affected count of active in-tenant devices signaled (Req 11.2).
            expect(entry.affectedCount).toBe(expectedAffected);

            // All commits succeed in the fake, so the outcome is a clean success.
            expect(entry.outcome).toBe('success');

            // Actor identity (Req 16.3).
            expect(entry.actorEmail).toBe(actor.email);
            if (typeof actor.id === 'string') {
              expect(entry.actorId).toBe(actor.id);
            }
            if (typeof actor.name === 'string') {
              expect(entry.actorName).toBe(actor.name);
            }

            // Reason recorded only when supplied (Req 17.2).
            if (typeof reason === 'string') {
              expect(entry.reason).toBe(reason);
            } else {
              expect('reason' in entry).toBe(false);
            }

            // Action timestamp present and consistent (Req 17.1, 17.2).
            expect(typeof entry.actionTimeMs).toBe('number');
            expect(Number.isFinite(entry.actionTimeMs as number)).toBe(true);
            expect(typeof entry.createdAt).toBe('string');
            expect(new Date(entry.createdAt as string).toISOString()).toBe(entry.createdAt);
          }
        ),
        { numRuns: 150 }
      );
    },
    30_000
  );
});

// ---------------------------------------------------------------------------
// writeAudit failure path — a Firestore persistence failure must NOT be
// swallowed. It surfaces as a typed `AuditWriteError` (code
// `audit_write_failed`, status 500) carrying the underlying cause, so the route
// layer can report the (already-committed) action as "not recorded" with the
// distinct code rather than an endpoint's generic fallback (Requirement 17.4).
// ---------------------------------------------------------------------------

describe('writeAudit — persistence failure surfaces as AuditWriteError', () => {
  it('rejects with AuditWriteError (audit_write_failed / 500) and attaches the cause when the audit .add() fails', async () => {
    const cause = new Error('firestore unavailable');
    // A Firestore fake whose `deviceAuditLogs.add()` rejects.
    mockCurrentDb = {
      collection: () => ({
        add: async () => {
          throw cause;
        },
      }),
    } as unknown as FakeFirestore;

    const err = await writeAudit({ tenantId: IN_TENANT, action: 'force_logout' }).catch(
      (e) => e as unknown
    );

    expect(err).toBeInstanceOf(AuditWriteError);
    expect((err as AuditWriteError).code).toBe('audit_write_failed');
    expect((err as AuditWriteError).status).toBe(500);
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});
