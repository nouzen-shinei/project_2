// Feature: device-console-migration, Property 18: Notification and bulk-action completeness

/**
 * Property 18: Notification and bulk-action completeness
 * **Validates: Requirements 12.2, 12.5, 12.7, 14.7, 14.8**
 *
 * For a `notify` OR a `bulkForceLogout` over N selected targets (0 < N <= max),
 * the aggregate result must be COMPLETE and every target must be accounted for
 * exactly once:
 *   - `successful + failed === results.length === N` — every target produces
 *     exactly one outcome (Requirements 12.2, 14.8);
 *   - each `(email, deviceId)` target appears EXACTLY ONCE in `results`;
 *   - a failure for one target never prevents the others from being processed,
 *     so every expected-success still succeeds even alongside failing targets
 *     (Requirements 12.7, 14.7); and
 *   - for `notify`, when the Push_Delivery_Service is unavailable (its send
 *     calls throw), EVERY delivery is counted as failed (Requirements 12.5,
 *     12.7).
 *
 * The test drives the real, exported `notify` / `bulkForceLogout` orchestrators
 * from `deviceAdminService.ts` (unmodified). `./firebaseAdmin` is replaced with
 * `jest.mock` so `getFirestore()` returns an in-memory Firestore fake covering
 * exactly the surface these orchestrators touch: the per-target device `get`,
 * the `bulkForceLogout` `WriteBatch` (device `update` + `logout_signals/...`
 * `set` + parent `user_devices/{email}` merge `set`), and the `deviceAuditLogs`
 * collection `add`. `./pushUtils` and `./webPush` are also mocked so the test
 * controls each target's delivery outcome (success, failure, or a thrown
 * service-unavailable error). `firebase-admin` itself is NOT mocked, so the
 * `FieldValue` sentinels used by the orchestrators are the real ones.
 *
 * Target lists mix in-tenant devices carrying expo tokens or web subscriptions
 * (each generated to deliver-ok or deliver-fail), in-tenant devices with no push
 * channel, out-of-tenant devices, and missing devices — so the generated sets
 * span every success and failure mode while the completeness invariants must
 * always hold.
 */

import * as fc from 'fast-check';

import { getFirestore } from '../firebaseAdmin';
import { sendExpoMessages } from '../pushUtils';
import { sendWebPushNotification } from '../webPush';
import { notify, bulkForceLogout } from '../deviceAdminService';

jest.mock('../firebaseAdmin');

// Mock the push transports so we can control per-target delivery outcomes.
// `sanitizeWebPushSubscription` keeps its real (pure) validation semantics so
// `notify` still routes web targets through `sendWebPushNotification`.
jest.mock('../pushUtils', () => ({
  sendExpoMessages: jest.fn(),
}));
jest.mock('../webPush', () => ({
  sendWebPushNotification: jest.fn(),
  sanitizeWebPushSubscription: (input: any) => {
    if (!input || typeof input !== 'object') {
      return null;
    }
    const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
    const p256dh = typeof input?.keys?.p256dh === 'string' ? input.keys.p256dh.trim() : '';
    const auth = typeof input?.keys?.auth === 'string' ? input.keys.auth.trim() : '';
    if (!endpoint || !p256dh || !auth) {
      return null;
    }
    return { endpoint, keys: { p256dh, auth } };
  },
}));

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;
const mockedSendExpo = sendExpoMessages as jest.MockedFunction<typeof sendExpoMessages>;
const mockedSendWeb = sendWebPushNotification as jest.MockedFunction<typeof sendWebPushNotification>;

// ---------------------------------------------------------------------------
// Push-transport mock behavior
// ---------------------------------------------------------------------------
//
// Delivery outcome is encoded in the target's push address: a token/endpoint
// containing `FAIL` fails delivery, otherwise it succeeds. When
// `pushServiceUnavailable` is set, both transports THROW to simulate the
// Push_Delivery_Service being unavailable (Requirement 12.7).

let pushServiceUnavailable = false;

function configurePushMocks(): void {
  mockedSendExpo.mockImplementation(async (messages: any[]) => {
    if (pushServiceUnavailable) {
      throw new Error('expo_push_service_unavailable');
    }
    const to = typeof messages?.[0]?.to === 'string' ? messages[0].to : '';
    const ok = !to.includes('FAIL');
    return { sent: ok ? 1 : 0, failed: ok ? 0 : 1, invalidTokens: [] };
  });
  mockedSendWeb.mockImplementation(async (options: any) => {
    if (pushServiceUnavailable) {
      throw new Error('web_push_service_unavailable');
    }
    const endpoint =
      typeof options?.subscription?.endpoint === 'string' ? options.subscription.endpoint : '';
    const ok = !endpoint.includes('FAIL');
    return ok ? { ok: true } : { ok: false, errorCode: 'web_push_delivery_failed' };
  });
}

// ---------------------------------------------------------------------------
// In-memory Firestore fake
// ---------------------------------------------------------------------------
//
// Documents are addressed by their full slash-joined path so a
// `DocumentReference` handed to a batch writes back to the same store the reads
// came from. Seeded docs go straight into `docs`; every mutation performed by
// the code under test is applied to `docs` and recorded so we can count signals
// and audit entries.

class FakeStore {
  readonly docs = new Map<string, Record<string, any>>();
  private auditSeq = 0;

  seed(path: string, data: Record<string, any>): void {
    this.docs.set(path, { ...data });
  }

  docsWithPrefix(prefix: string): Array<[string, Record<string, any>]> {
    return [...this.docs.entries()].filter(([path]) => path.startsWith(prefix));
  }

  nextAutoId(): string {
    this.auditSeq += 1;
    return `auto_${this.auditSeq}`;
  }

  applyUpdate(path: string, data: Record<string, any>): void {
    const current = this.docs.get(path) ?? {};
    this.docs.set(path, { ...current, ...data });
  }

  applySet(path: string, data: Record<string, any>, merge: boolean): void {
    if (merge) {
      const current = this.docs.get(path) ?? {};
      this.docs.set(path, { ...current, ...data });
    } else {
      this.docs.set(path, { ...data });
    }
  }

  applyAdd(collectionPath: string, data: Record<string, any>): string {
    const id = this.nextAutoId();
    this.docs.set(`${collectionPath}/${id}`, { ...data });
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
    for (const op of this.ops) {
      op();
    }
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const TENANT = 'tenant-A';
const OTHER_TENANT = 'tenant-B';

/** Acting administrator identity (each field independently present or absent). */
const actorArb = fc.record(
  {
    id: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
    email: fc.option(fc.string({ minLength: 1, maxLength: 16 }), { nil: undefined }),
    name: fc.option(fc.string({ maxLength: 16 }), { nil: undefined }),
  },
  { requiredKeys: [] }
);

/** The seven notify target kinds spanning every success/failure mode. */
type NotifyKind =
  | 'expo-ok'
  | 'expo-fail'
  | 'web-ok'
  | 'web-fail'
  | 'no-channel'
  | 'out-of-tenant'
  | 'missing';

const notifyKindArb = fc.constantFrom<NotifyKind>(
  'expo-ok',
  'expo-fail',
  'web-ok',
  'web-fail',
  'no-channel',
  'out-of-tenant',
  'missing'
);

/** The four bulk-force-logout target kinds. */
type BulkKind = 'live' | 'deleted' | 'out-of-tenant' | 'missing';

const bulkKindArb = fc.constantFrom<BulkKind>('live', 'deleted', 'out-of-tenant', 'missing');

/** In-tenant push kinds used for the "service unavailable" scenario. */
type PushKind = 'expo' | 'web';
const pushKindArb = fc.constantFrom<PushKind>('expo', 'web');

/** A stable, unique target address per list index (deviceId is globally unique). */
function targetAddress(index: number): { email: string; deviceId: string } {
  return { email: `owner${index % 3}@example.com`, deviceId: `dev-${index}` };
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('Property 18 — notification and bulk-action completeness', () => {
  it(
    'notify: successful + failed === N, every target appears once, and failures never block successes (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(notifyKindArb, { minLength: 1, maxLength: 24 }),
          actorArb,
          async (kinds, actor) => {
            pushServiceUnavailable = false;
            configurePushMocks();

            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const targets = kinds.map((kind, index) => ({ ...targetAddress(index), kind }));

            for (let i = 0; i < targets.length; i += 1) {
              const { email, deviceId, kind } = targets[i];
              if (kind === 'missing') {
                continue; // intentionally not seeded → device_not_found
              }
              const data: Record<string, any> = {
                tenantIds: [kind === 'out-of-tenant' ? OTHER_TENANT : TENANT],
              };
              if (kind === 'expo-ok') {
                data.expoPushToken = `ExpoToken-ok-${i}`;
              } else if (kind === 'expo-fail') {
                data.expoPushToken = `ExpoToken-FAIL-${i}`;
              } else if (kind === 'web-ok') {
                data.webPushSubscription = {
                  endpoint: `https://push.example/ok-${i}`,
                  keys: { p256dh: 'p', auth: 'a' },
                };
              } else if (kind === 'web-fail') {
                data.webPushSubscription = {
                  endpoint: `https://push.example/FAIL-${i}`,
                  keys: { p256dh: 'p', auth: 'a' },
                };
              }
              // 'no-channel' / 'out-of-tenant' get no push channel.
              store.seed(`user_devices/${email}/devices/${deviceId}`, data);
            }

            const result = await notify({
              tenantId: TENANT,
              title: 'Title',
              body: 'Body',
              targets: targets.map(({ email, deviceId }) => ({ email, deviceId })),
              actor,
            });

            const n = targets.length;
            const expectOk = (kind: NotifyKind): boolean => kind === 'expo-ok' || kind === 'web-ok';
            const expectedSuccessful = targets.filter((t) => expectOk(t.kind)).length;

            // Completeness: one outcome per target and the counts partition N.
            expect(result.results).toHaveLength(n);
            expect(result.successful + result.failed).toBe(n);
            expect(result.successful).toBe(expectedSuccessful);
            expect(result.failed).toBe(n - expectedSuccessful);

            // Every target appears EXACTLY once, with the expected outcome —
            // proving a failing target never suppressed a succeeding one.
            for (const t of targets) {
              const matches = result.results.filter(
                (r) => r.email === t.email && r.deviceId === t.deviceId
              );
              expect(matches).toHaveLength(1);
              expect(matches[0].ok).toBe(expectOk(t.kind));
            }

            // Exactly one notify audit entry is written for the whole action.
            expect(store.docsWithPrefix('deviceAuditLogs/')).toHaveLength(1);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );

  it(
    'bulkForceLogout: succeeded + failed === N, every target appears once, and failures never block successes (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(bulkKindArb, { minLength: 1, maxLength: 24 }),
          actorArb,
          async (kinds, actor) => {
            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const targets = kinds.map((kind, index) => ({ ...targetAddress(index), kind }));

            for (const { email, deviceId, kind } of targets) {
              if (kind === 'missing') {
                continue; // not seeded → device_not_found
              }
              const data: Record<string, any> = {
                tenantIds: [kind === 'out-of-tenant' ? OTHER_TENANT : TENANT],
                isDeleted: kind === 'deleted',
              };
              store.seed(`user_devices/${email}/devices/${deviceId}`, data);
            }

            const result = await bulkForceLogout({
              tenantId: TENANT,
              targets: targets.map(({ email, deviceId }) => ({ email, deviceId })),
              actor,
              reason: 'bulk admin action',
            });

            const n = targets.length;
            const expectOk = (kind: BulkKind): boolean => kind === 'live';
            const expectedSucceeded = targets.filter((t) => expectOk(t.kind)).length;

            // Completeness: one outcome per target and the counts partition N.
            expect(result.results).toHaveLength(n);
            expect(result.succeeded + result.failed).toBe(n);
            expect(result.succeeded).toBe(expectedSucceeded);
            expect(result.failed).toBe(n - expectedSucceeded);

            // Every target appears EXACTLY once, with the expected outcome.
            for (const t of targets) {
              const matches = result.results.filter(
                (r) => r.email === t.email && r.deviceId === t.deviceId
              );
              expect(matches).toHaveLength(1);
              expect(matches[0].ok).toBe(expectOk(t.kind));
            }

            // Each success independently performed its work: one unconsumed
            // signal and one audit entry per succeeded target (failures aside).
            expect(store.docsWithPrefix('logout_signals/')).toHaveLength(expectedSucceeded);
            expect(store.docsWithPrefix('deviceAuditLogs/')).toHaveLength(expectedSucceeded);
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );

  it(
    'notify: when the push service is unavailable, every in-tenant delivery is counted as failed (property, Req 12.7)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(pushKindArb, { minLength: 1, maxLength: 24 }),
          actorArb,
          async (kinds, actor) => {
            pushServiceUnavailable = true; // both transports throw
            configurePushMocks();

            const store = new FakeStore();
            mockedGetFirestore.mockReturnValue(store as any);

            const targets = kinds.map((kind, index) => ({ ...targetAddress(index), kind }));

            for (let i = 0; i < targets.length; i += 1) {
              const { email, deviceId, kind } = targets[i];
              const data: Record<string, any> = { tenantIds: [TENANT] };
              if (kind === 'expo') {
                data.expoPushToken = `ExpoToken-ok-${i}`;
              } else {
                data.webPushSubscription = {
                  endpoint: `https://push.example/ok-${i}`,
                  keys: { p256dh: 'p', auth: 'a' },
                };
              }
              store.seed(`user_devices/${email}/devices/${deviceId}`, data);
            }

            const result = await notify({
              tenantId: TENANT,
              title: 'Title',
              body: 'Body',
              targets: targets.map(({ email, deviceId }) => ({ email, deviceId })),
              actor,
            });

            const n = targets.length;
            // Every delivery is a failure; the counts still partition N.
            expect(result.results).toHaveLength(n);
            expect(result.successful).toBe(0);
            expect(result.failed).toBe(n);
            expect(result.successful + result.failed).toBe(n);
            for (const r of result.results) {
              expect(r.ok).toBe(false);
            }

            // Every target still appears exactly once.
            for (const t of targets) {
              const matches = result.results.filter(
                (r) => r.email === t.email && r.deviceId === t.deviceId
              );
              expect(matches).toHaveLength(1);
            }
          }
        ),
        { numRuns: 120, verbose: false }
      );
    },
    30_000
  );
});
