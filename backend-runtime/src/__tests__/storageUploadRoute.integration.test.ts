// Feature: upload-idempotency, Follow-up F6: route-level integration coverage for
// POST /storage/upload
//
// Every SEAM of this endpoint is already unit-tested in isolation
// (`resolveUploadObjectPath`, `computeUploadQuotaDelta`, `probeExistingUploadObject`,
// `selectUploadDownloadToken`, `buildUploadDownloadUrl`, `resolveShareTokenForUpload`,
// `reserveUploadQuotaBytes`, `storageUploadQuerySchema`,
// `buildBackgroundUploadChatMessageInput`). What had no automated coverage at any
// level is the ROUTE BODY that stitches them together: the `reservedBytes`
// threading, the zero-delta skip, the forwarding of the reservation outcome, and
// the wiring of each seam's output into the next.
//
// This suite drives the REAL handler through `createApp()`, following the
// `deviceAdminRoutes.test.ts` / `tenantMembersForceLogoutRoute.test.ts` precedent:
// an ephemeral `http` listener exercised with `fetch` (no HTTP client dependency),
// `createApp`'s `overrides` for the Firestore handle and the tenant guard, and
// HMAC-signed internal tokens for auth. Firebase Storage is a fake bucket whose
// `file()` handles record every `getMetadata`/`save`, and Firestore is an
// in-memory fake in the shape of the one `tests/razorpayInvoiceDedupe.test.mjs`
// already uses (queryable + `runTransaction`), extended with the nested-field
// `where('file.url', …)` and `orderBy` that `findLatestActiveShareForFile` needs.
//
// Both fakes push into ONE shared operation log, so ordering claims — "the shrink
// release happens only AFTER a successful write" — are assertable directly.
//
// Validates (route level): Requirements 1.1, 1.7, 2.2, 2.3, 2.5, 3.4, 3.6, 3.7,
// 3.8, 4.1, 4.2, 5.1, 5.2, 8.1, 8.4, 9.6, 10.9

import crypto from 'crypto';
import type { Server } from 'http';

// Must be set before `createApp` (and the auth middleware) read them.
process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'storage-upload-route-secret';

// ---------------------------------------------------------------------------
// Mocks (hoisted above the imports below)
// ---------------------------------------------------------------------------

// `/storage/upload` is NOT in the maintenance-bypass list, so the maintenance
// middleware would otherwise reach Firestore. Same stub as the precedent suites.
jest.mock('../maintenanceMode', () => ({
  __esModule: true,
  getMaintenanceMode: jest.fn(async () => null),
}));

// `ensureFirebase()` would find `backend-runtime/firebase_sa.b64` and initialize a
// REAL Admin app against a REAL bucket. Neutralize it: the route gets its Firestore
// from the `getFirestore` override and its bucket from the `admin.storage()` mock
// below, so nothing here needs a live Firebase app.
jest.mock('../firebaseAdmin', () => ({
  __esModule: true,
  ensureFirebase: jest.fn(),
  getFirestore: jest.fn(() => {
    throw new Error('firebaseAdmin.getFirestore must not be used in this suite');
  }),
  resetFirebaseForTests: jest.fn(),
}));

// Only `app()` (the configured-bucket probe) and `storage()` are faked; every other
// namespace is delegated to the real module, notably `admin.firestore.FieldValue
// .serverTimestamp()`, which the reservation/release transactions write.
//
// A Proxy rather than an object spread: firebase-admin exposes its namespaces as
// non-enumerable lazy getters, so `{ ...jest.requireActual('firebase-admin') }`
// silently drops `firestore`, `storage` and friends.
jest.mock('firebase-admin', () => {
  const actual = jest.requireActual('firebase-admin');
  const overrides: Record<string, unknown> = {
    apps: [],
    initializeApp: jest.fn(),
    app: jest.fn(() => ({ options: { storageBucket: 'test-bucket.appspot.com' } })),
    storage: jest.fn(() => ({ bucket: jest.fn(() => currentBucket) })),
  };
  return new Proxy(actual, {
    get: (target: any, prop: string | symbol) =>
      typeof prop === 'string' && prop in overrides ? overrides[prop] : target[prop],
    has: (target: any, prop: string | symbol) =>
      (typeof prop === 'string' && prop in overrides) || prop in target,
  });
});

// The chat-video branch must not spawn ffmpeg.
jest.mock('../videoTranscoder', () => {
  const actual = jest.requireActual('../videoTranscoder');
  return {
    __esModule: true,
    ...actual,
    scheduleVideoTranscode: jest.fn(),
  };
});

// Real counters, plus a spy so metric name + labels are assertable.
jest.mock('../metrics', () => {
  const actual = jest.requireActual('../metrics');
  return {
    __esModule: true,
    ...actual,
    inc: jest.fn(actual.inc),
  };
});

import { createApp } from '../app';
import { inc, metricNames } from '../metrics';
import type { ChatMessageRecord, SendChatMessageInput } from '../chatMessageWriter';
import { scheduleVideoTranscode } from '../videoTranscoder';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET = process.env.INTERNAL_API_KEY as string;
const TENANT = 'acme';
const ACTOR_UID = 'uid_staff_1';
const ACTOR_EMAIL = 'staff@example.com';
const BUCKET_NAME = 'test-bucket.appspot.com';
const UPLOAD_KEY = 'upload_key_route_integration_0001';
const MIB = 1024 * 1024;

const asMock = (fn: unknown): jest.Mock => fn as unknown as jest.Mock;

/** What the injected chat-message writer hands back to the `createMessage=1` branch. */
const CREATED_MESSAGE: ChatMessageRecord = {
  id: 'msg_created_1',
  text: '',
  sender: ACTOR_EMAIL,
  timestamp: '2024-01-01T00:00:00.000Z',
  conversationKey: 'conv_route_integration',
  isSpecial: false,
  delivered: false,
  read: false,
};

/**
 * The `createMessage=1` branch goes through `createApp`'s own `sendChatMessage`
 * override seam — the same injection point the `/chat/messages` route uses — so no
 * `jest.mock('../chatMessageWriter')` is needed. Declared at module scope because
 * `createApp` reads its overrides once, in `beforeAll`.
 */
const sendChatMessageMock = jest.fn(
  async (_input: SendChatMessageInput): Promise<ChatMessageRecord> => CREATED_MESSAGE
);

/** Chronological log shared by the Storage and Firestore fakes. */
let opLog: string[] = [];

// ---------------------------------------------------------------------------
// Fake Storage bucket
// ---------------------------------------------------------------------------

interface StoredObject {
  bytes: number;
  contentType: string;
  downloadToken: string | null;
  /**
   * Storage object generation (upload-idempotency follow-up F9). A real one is an
   * int64 serialized as a string; the fake keeps that shape (and stays above
   * `Number.MAX_SAFE_INTEGER`) so a route that coerced it to a number would be
   * caught here rather than only in production.
   */
  generation: string;
}

interface SaveCall {
  path: string;
  bytes: number;
  contentType: string;
  downloadToken: string | null;
  /** `undefined` when the route sent no `preconditionOpts` at all. */
  precondition: { ifGenerationMatch?: string | number } | undefined;
  /** Whether the options object carried the key at all — `{}` vs absent. */
  hasPreconditionOpts: boolean;
}

class FakeBucket {
  readonly name = BUCKET_NAME;
  readonly objects = new Map<string, StoredObject>();
  readonly getMetadataCalls: string[] = [];
  readonly saveCalls: SaveCall[] = [];
  readonly getFilesCalls: string[] = [];
  /** When set, every `save()` rejects with it. */
  saveError: Error | null = null;
  /** When set, every `getMetadata()` rejects with it (non-404 probe failure). */
  metadataError: unknown = null;
  /** When true, `getMetadata()` omits `generation`, as an old/odd backend might. */
  omitGeneration = false;
  /**
   * Runs once at the START of the next `save()`, then clears — i.e. inside the
   * window between the route's probe and its write. This is what makes a genuine
   * same-`uploadKey` race reproducible: the sibling attempt lands exactly there.
   */
  beforeNextSave: (() => void) | null = null;
  /** Same one-shot idea for the next metadata read (used for "the object vanished"). */
  beforeNextGetMetadata: (() => void) | null = null;
  /** Monotonic generation source; starts far above Number.MAX_SAFE_INTEGER. */
  private generationCounter = 1712345678901234567n;

  nextGeneration(): string {
    this.generationCounter += 1n;
    return this.generationCounter.toString();
  }

  /** Write an object outside the route, i.e. what a concurrent sibling attempt does. */
  put(objectPath: string, object: Omit<StoredObject, 'generation'>): StoredObject {
    const stored: StoredObject = { ...object, generation: this.nextGeneration() };
    this.objects.set(objectPath, stored);
    return stored;
  }

  file(objectPath: string) {
    const self = this;
    return {
      name: objectPath,
      async getMetadata(): Promise<[Record<string, unknown>, unknown]> {
        const before = self.beforeNextGetMetadata;
        self.beforeNextGetMetadata = null;
        if (before) before();
        self.getMetadataCalls.push(objectPath);
        opLog.push(`bucket.getMetadata:${objectPath}`);
        if (self.metadataError !== null) {
          throw self.metadataError;
        }
        const existing = self.objects.get(objectPath);
        if (!existing) {
          throw Object.assign(new Error('No such object'), { code: 404 });
        }
        return [
          {
            size: String(existing.bytes),
            contentType: existing.contentType,
            ...(self.omitGeneration ? {} : { generation: existing.generation }),
            metadata: { firebaseStorageDownloadTokens: existing.downloadToken ?? undefined },
          },
          {},
        ];
      },
      async save(body: Buffer, options: any): Promise<void> {
        const before = self.beforeNextSave;
        self.beforeNextSave = null;
        if (before) before();

        opLog.push(`bucket.save:${objectPath}`);
        const downloadToken =
          options?.metadata?.metadata?.firebaseStorageDownloadTokens ?? null;
        const hasPreconditionOpts = Object.prototype.hasOwnProperty.call(options ?? {}, 'preconditionOpts');
        self.saveCalls.push({
          path: objectPath,
          bytes: body.length,
          contentType: options?.contentType,
          downloadToken,
          precondition: options?.preconditionOpts,
          hasPreconditionOpts,
        });

        // Real precondition enforcement, so a race is genuinely ASSERTED rather than
        // simulated at a distance: `ifGenerationMatch: 0` means "the object must not
        // exist", any other value means "the live object must be exactly this
        // generation". Anything else is a `412`, the same shape the Storage client
        // surfaces.
        const ifGenerationMatch = options?.preconditionOpts?.ifGenerationMatch;
        if (ifGenerationMatch !== undefined) {
          const existing = self.objects.get(objectPath);
          const wants = String(ifGenerationMatch);
          const holds = wants === '0' ? existing === undefined : existing?.generation === wants;
          if (!holds) {
            opLog.push(`bucket.save412:${objectPath}`);
            throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold.'), {
              code: 412,
            });
          }
        }

        if (self.saveError) {
          throw self.saveError;
        }
        self.objects.set(objectPath, {
          bytes: body.length,
          contentType: options?.contentType,
          downloadToken,
          generation: self.nextGeneration(),
        });
      },
    };
  }

  /** Used by `estimateTenantStorageBytes` during reconcile / usage bootstrap. */
  async getFiles(options: { prefix: string; pageToken?: string }): Promise<[any[], unknown, any]> {
    this.getFilesCalls.push(options.prefix);
    opLog.push(`bucket.getFiles:${options.prefix}`);
    const files = Array.from(this.objects.entries())
      .filter(([name]) => name.startsWith(options.prefix))
      .map(([name, object]) => ({ name, metadata: { size: String(object.bytes) } }));
    return [files, null, {}];
  }
}

// ---------------------------------------------------------------------------
// Fake Firestore (in-memory, queryable, transactional)
// ---------------------------------------------------------------------------

function readFieldPath(data: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<any>((acc, part) => (acc == null ? undefined : acc[part]), data);
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as unknown as T;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    // Preserve Firestore sentinels (FieldValue.serverTimestamp() etc.).
    if (proto && proto !== Object.prototype) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = clone(entry);
    }
    return out as unknown as T;
  }
  return value;
}

class FakeFirestore {
  readonly store = new Map<string, Record<string, any>>();
  /** Every `bytes` value written to `tenantStorageUsage/{tenant}`, in order. */
  readonly usageWrites: number[] = [];
  /** Runs once at the start of the next transaction, then clears. */
  beforeNextTransaction: (() => void) | null = null;
  /** Thrown by the next transaction, then clears. */
  throwOnNextTransaction: Error | null = null;

  collection(name: string) {
    return new FakeCollectionRef(this, [name]);
  }

  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    opLog.push('db.txBegin');
    const before = this.beforeNextTransaction;
    this.beforeNextTransaction = null;
    if (before) before();
    const failure = this.throwOnNextTransaction;
    this.throwOnNextTransaction = null;
    if (failure) throw failure;
    return await fn(new FakeTransaction(this));
  }

  /** Test helper: read a document's raw data by `collection/doc` key. */
  peek(key: string): Record<string, any> | undefined {
    return this.store.get(key);
  }

  /**
   * Test helper: write a document's raw data by `collection/doc` key. Deliberately
   * bypasses `_write`, so `usageWrites` only ever records writes the ROUTE made.
   */
  seed(key: string, data: Record<string, any>): void {
    this.store.set(key, data);
  }

  _read(key: string): Record<string, any> | undefined {
    return this.store.get(key);
  }

  _write(key: string, data: Record<string, any>, merge: boolean): void {
    const next = merge ? { ...(this.store.get(key) ?? {}), ...clone(data) } : clone(data);
    this.store.set(key, next);
    if (key === `tenantStorageUsage/${TENANT}` && typeof next.bytes === 'number') {
      this.usageWrites.push(next.bytes);
    }
  }

  _list(collectionKey: string): { id: string; data: Record<string, any> }[] {
    const prefix = `${collectionKey}/`;
    const out: { id: string; data: Record<string, any> }[] = [];
    for (const [key, data] of this.store.entries()) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (!remainder || remainder.includes('/')) continue;
      out.push({ id: remainder, data });
    }
    return out;
  }
}

class FakeDocumentRef {
  readonly id: string;

  constructor(private readonly db: FakeFirestore, readonly segments: string[]) {
    this.id = segments[segments.length - 1];
  }

  get key(): string {
    return this.segments.join('/');
  }

  collection(name: string) {
    return new FakeCollectionRef(this.db, [...this.segments, name]);
  }

  async get() {
    opLog.push(`db.get:${this.key}`);
    return this.snapshot();
  }

  snapshot() {
    const data = this.db._read(this.key);
    return {
      exists: data !== undefined,
      id: this.id,
      ref: this,
      data: () => (data === undefined ? undefined : clone(data)),
    };
  }

  async set(data: Record<string, any>, options?: { merge?: boolean }) {
    opLog.push(`db.set:${this.key}`);
    this.db._write(this.key, data || {}, options?.merge === true);
  }

  async delete() {
    this.db.store.delete(this.key);
  }
}

interface QueryFilter {
  field: string;
  op: string;
  value: unknown;
}

class FakeQuery {
  constructor(
    private readonly db: FakeFirestore,
    private readonly segments: string[],
    private readonly filters: QueryFilter[],
    private readonly order: { field: string; dir: 'asc' | 'desc' } | null,
    private readonly max: number | null
  ) {}

  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.db, this.segments, [...this.filters, { field, op, value }], this.order, this.max);
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(this.db, this.segments, this.filters, { field, dir }, this.max);
  }

  limit(n: number) {
    return new FakeQuery(this.db, this.segments, this.filters, this.order, Math.max(0, Math.trunc(n)));
  }

  async get() {
    const collectionKey = this.segments.join('/');
    opLog.push(`db.query:${collectionKey}`);
    let rows = this.db._list(collectionKey).filter((row) =>
      this.filters.every((filter) => {
        if (filter.op !== '==') return false;
        return readFieldPath(row.data, filter.field) === filter.value;
      })
    );
    if (this.order) {
      const { field, dir } = this.order;
      rows = rows.slice().sort((a, b) => {
        const av = readFieldPath(a.data, field) as any;
        const bv = readFieldPath(b.data, field) as any;
        if (av === bv) return 0;
        const cmp = av > bv ? 1 : -1;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    if (this.max !== null) rows = rows.slice(0, this.max);
    const docs = rows.map((row) => ({
      id: row.id,
      exists: true,
      ref: new FakeDocumentRef(this.db, [...this.segments, row.id]),
      data: () => clone(row.data),
    }));
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach: (cb: (doc: any) => void) => docs.forEach(cb),
    };
  }
}

class FakeCollectionRef {
  constructor(private readonly db: FakeFirestore, readonly segments: string[]) {}

  doc(id: string) {
    return new FakeDocumentRef(this.db, [...this.segments, id]);
  }

  async add(data: Record<string, any>) {
    const ref = this.doc(`auto_${crypto.randomBytes(6).toString('hex')}`);
    await ref.set(data);
    return ref;
  }

  where(field: string, op: string, value: unknown) {
    return new FakeQuery(this.db, this.segments, [{ field, op, value }], null, null);
  }

  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
    return new FakeQuery(this.db, this.segments, [], { field, dir }, null);
  }

  limit(n: number) {
    return new FakeQuery(this.db, this.segments, [], null, n);
  }

  async get() {
    return new FakeQuery(this.db, this.segments, [], null, null).get();
  }
}

class FakeTransaction {
  constructor(private readonly db: FakeFirestore) {}

  async get(ref: FakeDocumentRef) {
    opLog.push(`db.txGet:${ref.key}`);
    return ref.snapshot();
  }

  set(ref: FakeDocumentRef, data: Record<string, any>, options?: { merge?: boolean }) {
    opLog.push(`db.txSet:${ref.key}`);
    this.db._write(ref.key, data || {}, options?.merge === true);
    return this;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let currentBucket: FakeBucket;
let currentDb: FakeFirestore;
let server: Server;
let base: string;

function actorToken(): string {
  const body = Buffer.from(
    JSON.stringify({
      sub: ACTOR_UID,
      email: ACTOR_EMAIL,
      exp: Math.floor(Date.now() / 1000) + 300,
    })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

interface UploadOptions {
  purpose?: string;
  filename?: string;
  displayName?: string;
  uploadKey?: string;
  conversationFolder?: string;
  feeId?: string;
  email?: string;
  createMessage?: string;
  clientMsgId?: string;
  recipientId?: string;
  mediaKind?: string;
  contentType?: string;
  tenantId?: string;
}

async function upload(
  bodyBytes: number | Buffer,
  options: UploadOptions = {}
): Promise<{ status: number; body: any }> {
  const { contentType = 'image/jpeg', tenantId = TENANT, ...query } = options;
  const params = new URLSearchParams();
  params.set('tenantId', tenantId);
  params.set('purpose', query.purpose ?? 'chat');
  for (const [key, value] of Object.entries(query)) {
    if (key === 'purpose' || value === undefined) continue;
    params.set(key, String(value));
  }
  const body = Buffer.isBuffer(bodyBytes) ? bodyBytes : Buffer.alloc(bodyBytes, 7);
  const res = await fetch(`${base}/storage/upload?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      Authorization: `Bearer ${actorToken()}`,
    },
    body,
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/** Seed the plan limit (via `tenants.quotas.maxStorageMb`) and recorded usage. */
function seedTenant(options: { usageBytes?: number; maxStorageMb?: number } = {}): void {
  currentDb.seed(`tenants/${TENANT}`, {
    billingTier: 'free',
    quotas: options.maxStorageMb ? { maxStorageMb: options.maxStorageMb } : null,
  });
  currentDb.seed(`tenantStorageUsage/${TENANT}`, {
    tenantId: TENANT,
    bytes: options.usageBytes ?? 0,
  });
}

function usageBytes(): number | undefined {
  return currentDb.peek(`tenantStorageUsage/${TENANT}`)?.bytes;
}

function sharedFileDocs(): { id: string; data: Record<string, any> }[] {
  return currentDb._list('sharedFiles');
}

/** `inc()` calls for one metric name, as label objects. */
function metricCalls(name: string): (Record<string, string> | undefined)[] {
  return asMock(inc)
    .mock.calls.filter((call) => call[0] === name)
    .map((call) => call[1]);
}

/** Every label VALUE passed to `inc()` during the current test. */
function allMetricLabelValues(): string[] {
  const values: string[] = [];
  for (const call of asMock(inc).mock.calls) {
    const labels = call[1];
    if (!labels || typeof labels !== 'object') continue;
    for (const value of Object.values(labels as Record<string, unknown>)) {
      values.push(String(value));
    }
  }
  return values;
}

function tokenFromUrl(url: string): string {
  return new URL(url).searchParams.get('token') || '';
}

beforeAll(async () => {
  const app = createApp({
    overrides: {
      // The route's Firestore handle. Reassigned per test via `currentDb`.
      getFirestore: () => currentDb as any,
      // Satisfy the staff tenant guard without Firestore membership reads.
      requireTenantMembershipAccess: async (_ctx: any, tenantId: string) => ({
        tenantId,
        role: 'owner' as const,
        membershipId: null,
      }),
      // The chat-message create the `createMessage=1` branch performs.
      sendChatMessage: sendChatMessageMock,
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server address unavailable');
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    // `fetch` keeps its sockets alive, which would otherwise hold the listener
    // open past the suite.
    (server as any).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  sendChatMessageMock.mockResolvedValue(CREATED_MESSAGE);
  opLog = [];
  currentBucket = new FakeBucket();
  currentDb = new FakeFirestore();
  seedTenant();
});

// ---------------------------------------------------------------------------
// 1. Legacy path: byte-identical, zero extra Storage round trips
// ---------------------------------------------------------------------------

describe('legacy path (no uploadKey) is unchanged — the backward-compatibility gate', () => {
  it('resolves a timestamped path, never probes, reserves the full body size, and returns today\'s keys', async () => {
    const res = await upload(1_000, { filename: 'photo.jpg', purpose: 'chat' });

    expect(res.status).toBe(200);
    // Timestamped variable segment, i.e. the pre-feature format.
    expect(res.body.path).toMatch(/^chat-files\/acme\/c_[0-9a-f]{20}\/\d{13}_photo\.jpg$/);

    // Requirement 2.5 / 9.7: a caller that sends no uploadKey adds ZERO Storage
    // round trips — no metadata probe, and no bucket listing either.
    expect(currentBucket.getMetadataCalls).toEqual([]);
    expect(currentBucket.getFilesCalls).toEqual([]);
    expect(currentBucket.saveCalls).toHaveLength(1);

    // Requirement 2.3: the FULL body size is reserved, matching today.
    expect(currentDb.usageWrites).toEqual([1_000]);
    expect(usageBytes()).toBe(1_000);

    // Requirement 2.2: exactly today's response keys.
    expect(Object.keys(res.body).sort()).toEqual(['bytes', 'contentType', 'path', 'shareToken', 'url']);
    expect(res.body.bytes).toBe(1_000);
    expect(res.body.contentType).toBe('image/jpeg');
    // A fresh random token is minted, stored on the object, and embedded in the
    // returned url — asserted against the token `save()` actually received, so the
    // url is reconstructed from independent facts rather than from itself.
    const storedToken = currentBucket.saveCalls[0].downloadToken;
    expect(storedToken).toMatch(/^[0-9a-f-]{32,36}$/);
    expect(res.body.url).toBe(
      `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/${encodeURIComponent(res.body.path)}?alt=media&token=${storedToken}`
    );
  });

  it('omits shareToken for a purpose that has never received one (tenantLogo)', async () => {
    const res = await upload(512, { purpose: 'tenantLogo', filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/^tenant-branding\/acme\/logo_\d{13}\.png$/);
    expect(Object.keys(res.body).sort()).toEqual(['bytes', 'contentType', 'path', 'url']);
    expect(currentBucket.getMetadataCalls).toEqual([]);
    expect(sharedFileDocs()).toHaveLength(0);
  });

  it('two legacy uploads of the same bytes leave TWO objects (the orphan this feature fixes)', async () => {
    const first = await upload(1_000, { filename: 'photo.jpg' });
    const second = await upload(1_000, { filename: 'photo.jpg' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(currentBucket.objects.size).toBe(2);
    expect(second.body.path).not.toBe(first.body.path);
    expect(usageBytes()).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// 2. First opted-in upload
// ---------------------------------------------------------------------------

describe('first opted-in upload (uploadKey present, probe 404s)', () => {
  it('writes a deterministic k_ path, reserves the full size, and mints one fresh token used by both save() and the url', async () => {
    const res = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/^chat-files\/acme\/c_[0-9a-f]{20}\/k_[0-9a-f]{20}_photo\.jpg$/);

    // Exactly one probe of exactly that path (Requirement 1.7).
    expect(currentBucket.getMetadataCalls).toEqual([res.body.path]);
    expect(currentBucket.saveCalls).toHaveLength(1);

    // Probe 404'd ⇒ not an overwrite ⇒ full reservation (Requirement 3.3).
    expect(currentDb.usageWrites).toEqual([2_048]);

    const saved = currentBucket.saveCalls[0];
    expect(saved.path).toBe(res.body.path);
    expect(saved.downloadToken).toBeTruthy();
    // The token in the returned url is the token written into the object's
    // metadata — one value, two places (Requirement 4.3).
    expect(tokenFromUrl(res.body.url)).toBe(saved.downloadToken);
    expect(currentBucket.objects.get(res.body.path)!.downloadToken).toBe(saved.downloadToken);
  });
});

// ---------------------------------------------------------------------------
// 3. The retry — the whole point of the feature
// ---------------------------------------------------------------------------

describe('the retry: same uploadKey, same size', () => {
  it('skips the reservation block entirely, reuses the stored token, and returns a byte-identical url', async () => {
    const first = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    const usageAfterFirst = usageBytes();

    // Second attempt of the SAME logical action.
    opLog = [];
    currentDb.usageWrites.length = 0;
    const second = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(second.status).toBe(200);
    expect(second.body.path).toBe(first.body.path);

    // Requirement 4.2 / design Property 12: byte-identical url, so a URL already
    // persisted from the lost first response keeps resolving.
    expect(second.body.url).toBe(first.body.url);
    expect(second.body).toEqual(first.body);

    // Requirement 3.8: the ENTIRE reservation path is skipped — no usage read and
    // no reservation transaction.
    expect(opLog.filter((op) => op.includes('tenantStorageUsage'))).toEqual([]);
    expect(opLog.filter((op) => op === 'db.txBegin')).toEqual([]);
    expect(currentDb.usageWrites).toEqual([]);
    expect(usageBytes()).toBe(usageAfterFirst);

    // Requirement 1.1: exactly one stored object attributable to the key.
    expect(Array.from(currentBucket.objects.keys())).toEqual([first.body.path]);
    // The token was READ off the stored object and rewritten, not rotated.
    expect(currentBucket.saveCalls.map((call) => call.downloadToken)).toEqual([
      currentBucket.saveCalls[0].downloadToken,
      currentBucket.saveCalls[0].downloadToken,
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. reservedBytes threading on a failed write
// ---------------------------------------------------------------------------

describe('reservedBytes threading when the write fails (Requirement 3.7)', () => {
  it('releases the DELTA, not the body size, when overwriting a smaller object', async () => {
    // Establish the object through the real route, then shrink it so the retry
    // grows it: existing 400, new 1000 ⇒ reserveBytes 600.
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    currentBucket.objects.get(first.body.path)!.bytes = 400;

    // Known pre-request usage.
    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 5_000 });
    currentDb.usageWrites.length = 0;
    currentBucket.saveError = new Error('storage exploded');

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'upload_failed' });

    // Reserve took exactly the delta (5_000 -> 5_600); the rollback gave back
    // exactly the delta (5_600 -> 5_000). Releasing the body size would have
    // landed on 4_600.
    expect(currentDb.usageWrites).toEqual([5_600, 5_000]);
    expect(usageBytes()).toBe(5_000);

    // The previous object is untouched — the retry re-derives the same path.
    expect(currentBucket.objects.get(first.body.path)!.bytes).toBe(400);
  });

  it('releases nothing on a same-size retry whose write fails (it reserved nothing)', async () => {
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);

    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 5_000 });
    currentDb.usageWrites.length = 0;
    currentBucket.saveError = new Error('storage exploded');

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(500);
    expect(currentDb.usageWrites).toEqual([]);
    expect(usageBytes()).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// 5. Zero-delta retry is never rejected for quota
// ---------------------------------------------------------------------------

describe('a same-size retry is never rejected for quota (Requirement 3.6)', () => {
  it('returns 200 even when the tenant is already exactly at its limit', async () => {
    seedTenant({ maxStorageMb: 1, usageBytes: 0 });
    const first = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);

    // Park the tenant right on its limit.
    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: MIB });
    currentDb.usageWrites.length = 0;
    opLog = [];

    const retry = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(retry.status).toBe(200);
    expect(retry.body.url).toBe(first.body.url);
    expect(usageBytes()).toBe(MIB);
    expect(opLog.filter((op) => op === 'db.txBegin')).toEqual([]);
  });

  it('still rejects a GROWING overwrite that does not fit, leaving the stored object intact', async () => {
    seedTenant({ maxStorageMb: 1, usageBytes: 0 });
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    currentBucket.objects.get(first.body.path)!.bytes = 400;
    // Bucket truth exceeds the limit, so the precheck reconcile cannot rescue it.
    currentBucket.put(`chat-files/${TENANT}/filler`, {
      bytes: MIB,
      contentType: 'application/octet-stream',
      downloadToken: null,
    });
    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: MIB });
    currentDb.usageWrites.length = 0;

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('storage_limit_reached');
    // Judged on the DELTA (600), not the body size (Requirement 3.5).
    expect(res.body.incrementBytes).toBe(600);
    expect(res.body.limitBytes).toBe(MIB);
    // Nothing was written and nothing was held.
    expect(currentBucket.saveCalls).toHaveLength(1); // only the first request's
    expect(currentBucket.objects.get(first.body.path)!.bytes).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 6. Shrink release ordering + best-effort failure
// ---------------------------------------------------------------------------

describe('post-write shrink release', () => {
  it('runs only AFTER a successful write, and credits exactly the shrink amount', async () => {
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    currentBucket.objects.get(first.body.path)!.bytes = 4_000;

    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 9_000 });
    currentDb.usageWrites.length = 0;
    opLog = [];

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    // shrinkBytes = 4_000 - 1_000 = 3_000, released once.
    expect(currentDb.usageWrites).toEqual([6_000]);
    expect(usageBytes()).toBe(6_000);

    // Ordering: the release transaction comes after the object write.
    const saveIndex = opLog.indexOf(`bucket.save:${first.body.path}`);
    const releaseIndex = opLog.indexOf('db.txBegin');
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(saveIndex);
  });

  it('does NOT release the shrink amount when the write fails (the larger object is still stored)', async () => {
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    currentBucket.objects.get(first.body.path)!.bytes = 4_000;

    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 9_000 });
    currentDb.usageWrites.length = 0;
    currentBucket.saveError = new Error('storage exploded');

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(500);
    expect(currentDb.usageWrites).toEqual([]);
    expect(usageBytes()).toBe(9_000);
  });

  it('still returns 200 when the best-effort release itself fails (Requirement 9.6)', async () => {
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    currentBucket.objects.get(first.body.path)!.bytes = 4_000;

    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 9_000 });
    currentDb.usageWrites.length = 0;
    currentDb.throwOnNextTransaction = new Error('release transaction unavailable');

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe(first.body.url);
    // Usage stays over-counted until the next reconcile, by design.
    expect(currentDb.usageWrites).toEqual([]);
    expect(usageBytes()).toBe(9_000);
    // The bytes really are stored.
    expect(currentBucket.objects.get(first.body.path)!.bytes).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// 7. The reservation outcome is forwarded faithfully
// ---------------------------------------------------------------------------

describe('the reservation outcome is forwarded verbatim', () => {
  it('a reserve-time limit error whose reconcile still does not fit becomes 409 storage_limit_reached with stage reserve_reconcile', async () => {
    seedTenant({ maxStorageMb: 1, usageBytes: 0 });
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    currentBucket.objects.get(first.body.path)!.bytes = 400;
    currentBucket.put(`chat-files/${TENANT}/filler`, {
      bytes: MIB,
      contentType: 'application/octet-stream',
      downloadToken: null,
    });

    // Recorded usage passes the deterministic precheck (0 + 600 <= 1 MiB) but the
    // reservation transaction sees the tenant already at its limit, so it throws
    // the real TenantStorageLimitError the seam classifies.
    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 0 });
    currentDb.beforeNextTransaction = () => {
      currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: MIB });
    };
    currentDb.usageWrites.length = 0;
    const savesBeforeRejection = currentBucket.saveCalls.length;
    jest.clearAllMocks();

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('storage_limit_reached');
    expect(res.body.limitBytes).toBe(MIB);
    // Reconciled from bucket truth: the filler plus the 400-byte object.
    expect(res.body.usedBytes).toBe(MIB + 400);
    // The DELTA, not the body size.
    expect(res.body.incrementBytes).toBe(600);

    expect(metricCalls(metricNames.storageUploadRejected)).toEqual([
      { purpose: 'chat', stage: 'reserve_reconcile' },
    ]);
    // Nothing was written by the rejected request (only the setup upload's save),
    // and nothing is held: recorded usage is exactly the reconciled value.
    expect(currentBucket.saveCalls).toHaveLength(savesBeforeRejection);
    expect(usageBytes()).toBe(MIB + 400);
  });
});

// ---------------------------------------------------------------------------
// 8. Metric labels
// ---------------------------------------------------------------------------

describe('metric labels carry { purpose } and nothing else (Requirements 6.4, 8.4)', () => {
  it('fires the idempotent-overwrite counter exactly once on an overwrite and zero times on a fresh upload', async () => {
    const first = await upload(1_500, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    // Fresh upload: the probe found nothing, so nothing was overwritten.
    expect(metricCalls(metricNames.storageUploadIdempotentOverwrite)).toEqual([]);
    expect(metricCalls(metricNames.storageUploadAccepted)).toEqual([{ purpose: 'chat' }]);

    jest.clearAllMocks();
    const retry = await upload(1_500, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(retry.status).toBe(200);

    expect(metricCalls(metricNames.storageUploadIdempotentOverwrite)).toEqual([{ purpose: 'chat' }]);
    // No probe failure on a clean 200-metadata read.
    expect(metricCalls(metricNames.storageUploadOverwriteProbeFailed)).toEqual([]);

    // No label value leaks the uploadKey, the filename or the object path — and
    // since the key hash is the path's variable segment, "not the path" covers it.
    const values = allMetricLabelValues();
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).not.toContain(UPLOAD_KEY);
      expect(value).not.toContain('photo.jpg');
      expect(value).not.toContain(retry.body.path);
      expect(value).not.toMatch(/[0-9a-f]{20}/);
    }
  });

  it('counts a degraded probe once, labelled by purpose only, and still stores the object', async () => {
    currentBucket.metadataError = new Error('metadata backend unavailable');

    const res = await upload(1_500, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    expect(metricCalls(metricNames.storageUploadOverwriteProbeFailed)).toEqual([{ purpose: 'chat' }]);
    // Requirement 9.4: degrade to "new object" ⇒ the FULL size is reserved.
    expect(currentDb.usageWrites).toEqual([1_500]);
    // Requirement 9.4: and the write still lands on the deterministic path.
    expect(res.body.path).toMatch(/k_[0-9a-f]{20}_photo\.jpg$/);
    expect(currentBucket.objects.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. displayName vs the path-driving filename (createMessage=1)
// ---------------------------------------------------------------------------

describe('createMessage=1: displayName names the message, filename names the object', () => {
  it('passes displayName to the created chat message while the deterministic filename drives the path', async () => {
    const res = await upload(3_000, {
      purpose: 'chat',
      uploadKey: UPLOAD_KEY,
      // What a post-F5 client sends: a deterministic storage name…
      filename: 'pick_abc123_9f2c41e07f3a.jpg',
      // …and the real OS name for anything a human reads.
      displayName: 'Holiday.jpg',
      createMessage: '1',
      clientMsgId: 'tmp_client_msg_1',
      recipientId: 'friend@example.com',
      mediaKind: 'attachment',
    });

    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe('msg_created_1');
    // The object path follows `filename`.
    expect(res.body.path).toMatch(/\/k_[0-9a-f]{20}_pick_abc123_9f2c41e07f3a\.jpg$/);

    expect(sendChatMessageMock).toHaveBeenCalledTimes(1);
    const input = sendChatMessageMock.mock.calls[0][0];
    expect(input.clientMsgId).toBe('tmp_client_msg_1');
    expect(input.senderEmail).toBe(ACTOR_EMAIL);
    expect(input.recipientEmail).toBe('friend@example.com');
    // The user-visible label is the displayName, and it carries the stored url.
    expect(input.attachments).toEqual([
      {
        url: res.body.url,
        fileName: 'Holiday.jpg',
        fileType: 'image/jpeg',
        fileSize: 3_000,
      },
    ]);

    // The share doc a chat upload pre-creates also gets the human name.
    const shares = sharedFileDocs();
    expect(shares).toHaveLength(1);
    expect(shares[0].data.file.fileName).toBe('Holiday.jpg');
  });

  it('a chat video upload schedules one transcode job keyed on the deterministic path', async () => {
    const first = await upload(4_000, {
      purpose: 'chat',
      uploadKey: UPLOAD_KEY,
      filename: 'clip.mp4',
      contentType: 'video/mp4',
    });
    expect(first.status).toBe(200);

    const retry = await upload(4_000, {
      purpose: 'chat',
      uploadKey: UPLOAD_KEY,
      filename: 'clip.mp4',
      contentType: 'video/mp4',
    });
    expect(retry.status).toBe(200);

    // Both attempts schedule against the SAME originalPath, which is what makes
    // `transcodeDocId = sha256(originalPath)` dedupe them (Requirement 5.4).
    const paths = asMock(scheduleVideoTranscode).mock.calls.map((call) => call[0].originalPath);
    expect(paths).toEqual([first.body.path, first.body.path]);
  });
});

// ---------------------------------------------------------------------------
// 10. Share-token reuse on overwrite
// ---------------------------------------------------------------------------

describe('share-token reuse on an overwrite (Requirements 5.1, 5.2)', () => {
  it('reuses the existing sharedFiles doc instead of writing a second one', async () => {
    const first = await upload(1_200, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    expect(first.body.shareToken).toBeTruthy();
    expect(sharedFileDocs()).toHaveLength(1);

    const retry = await upload(1_200, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(retry.status).toBe(200);
    // Same token handed back, and no second capability minted.
    expect(retry.body.shareToken).toBe(first.body.shareToken);
    expect(sharedFileDocs()).toHaveLength(1);
    expect(sharedFileDocs()[0].data.file.url).toBe(first.body.url);
  });

  it('mints a fresh doc per legacy upload, since each one is a distinct url', async () => {
    await upload(1_200, { filename: 'photo.jpg' });
    await upload(1_200, { filename: 'photo.jpg' });
    expect(sharedFileDocs()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 11. Conditional writes: the same-uploadKey race (follow-up F9)
// ---------------------------------------------------------------------------
//
// The gap this closes: two attempts of one logical action in flight at once — most
// plausibly the native background uploader's internal retry firing while the first
// attempt is still connected. Both probe before either writes, so both used to see
// no existing object and both reserved the FULL file size. The file outcome was
// always right (last-writer-wins leaves one object) but recorded usage was
// over-counted by one file size per racing pair until a reconcile.
//
// The fake bucket enforces `ifGenerationMatch` for real and `beforeNextSave` drops
// the sibling's write into the exact window between the route's probe and its write,
// so these are genuine races rather than stubbed 412s.
//
// Validates (route level): Requirements 4.1, 4.2, 9.4, 9.5, 9.8, 9.9, 9.10, 9.11,
// 9.12, 9.13, 9.14; design Property 14.

/** Learn the deterministic path for a given key, then reset to a clean slate. */
async function learnDeterministicPath(options: UploadOptions & { bytes?: number }): Promise<string> {
  const { bytes = 1_000, ...uploadOptions } = options;
  const probe = await upload(bytes, uploadOptions);
  expect(probe.status).toBe(200);
  const path = probe.body.path as string;
  currentBucket.objects.clear();
  currentBucket.saveCalls.length = 0;
  currentBucket.getMetadataCalls.length = 0;
  currentDb.usageWrites.length = 0;
  currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 0 });
  jest.clearAllMocks();
  opLog = [];
  return path;
}

function expectedUrl(objectPath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET_NAME}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

describe('the same-uploadKey race is closed by a write precondition (F9)', () => {
  it('sends ifGenerationMatch: 0 on a first opted-in write, so a concurrent creator cannot go unnoticed', async () => {
    const res = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    expect(currentBucket.saveCalls).toHaveLength(1);
    // Create-only: the probe found nothing, so the write asserts nothing is there.
    expect(currentBucket.saveCalls[0].precondition).toEqual({ ifGenerationMatch: 0 });
  });

  it('(a) the loser of a race returns the WINNER\'s exact url and token, and releases its reservation', async () => {
    const objectPath = await learnDeterministicPath({ filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    const WINNER_TOKEN = 'winner-token-9f2c41e0-7f3a-4d21';

    // The sibling attempt lands in the window between our probe and our write.
    currentBucket.beforeNextSave = () => {
      currentBucket.put(objectPath, { bytes: 2_048, contentType: 'image/jpeg', downloadToken: WINNER_TOKEN });
    };

    const res = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    // A lost race is a SUCCESS: the bytes the user asked to store ARE stored, by the
    // sibling, so this must never surface as a 4xx/5xx (Req 9.5).
    expect(res.status).toBe(200);
    // Byte-identical to what the winning request returned (Req 4.1, 4.2): a url
    // already persisted against a fee, notice or message keeps resolving.
    expect(res.body.url).toBe(expectedUrl(objectPath, WINNER_TOKEN));
    expect(tokenFromUrl(res.body.url)).toBe(WINNER_TOKEN);
    expect(res.body.path).toBe(objectPath);
    expect(res.body.bytes).toBe(2_048);

    // Our conditional write was attempted and rejected; we did NOT then write again.
    expect(currentBucket.saveCalls).toHaveLength(1);
    expect(currentBucket.saveCalls[0].precondition).toEqual({ ifGenerationMatch: 0 });
    expect(opLog).toContain(`bucket.save412:${objectPath}`);
    // Exactly one object, still the winner's — we skipped a redundant full write.
    expect(Array.from(currentBucket.objects.keys())).toEqual([objectPath]);
    expect(currentBucket.objects.get(objectPath)!.downloadToken).toBe(WINNER_TOKEN);

    // Reserved the full size, then released exactly that on losing: net zero.
    expect(currentDb.usageWrites).toEqual([2_048, 0]);
    expect(usageBytes()).toBe(0);

    // Counted as a lost race, not as an overwrite: no write happened, so the two
    // counters stay disjoint. Labelled by purpose only (Req 6.4, 8.4).
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([{ purpose: 'chat' }]);
    expect(metricCalls(metricNames.storageUploadIdempotentOverwrite)).toEqual([]);
    expect(metricCalls(metricNames.storageUploadAccepted)).toEqual([{ purpose: 'chat' }]);
    expect(metricCalls(metricNames.storageUploadFailed)).toEqual([]);
    for (const value of allMetricLabelValues()) {
      expect(value).not.toContain(UPLOAD_KEY);
      expect(value).not.toContain('photo.jpg');
      expect(value).not.toContain(objectPath);
    }
  });

  it('(b) a racing pair leaves exactly ONE object and exactly ONE net reservation', async () => {
    const objectPath = await learnDeterministicPath({ filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    const SIZE = 4_096;

    // The winner's own accounting: it reserved the full size before writing.
    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: SIZE });
    currentDb.usageWrites.length = 0;
    currentBucket.beforeNextSave = () => {
      currentBucket.put(objectPath, { bytes: SIZE, contentType: 'image/jpeg', downloadToken: 'winner-token' });
    };

    const loser = await upload(SIZE, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(loser.status).toBe(200);
    // This is the whole point of F9. Before it, both attempts reserved and recorded
    // usage sat at 2 × SIZE until a reconcile.
    expect(currentBucket.objects.size).toBe(1);
    expect(usageBytes()).toBe(SIZE);
    // Reserved (2 × SIZE) then released back to exactly one file's worth.
    expect(currentDb.usageWrites).toEqual([SIZE * 2, SIZE]);
  });

  it('(c) a sequential same-key retry pins the probed generation and still returns 200', async () => {
    const first = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    const storedGeneration = currentBucket.objects.get(first.body.path)!.generation;
    // A real generation: int64-shaped and beyond what a JS number holds exactly.
    expect(storedGeneration).toMatch(/^[1-9][0-9]{18}$/);
    expect(Number.isSafeInteger(Number(storedGeneration))).toBe(false);

    const retry = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(currentBucket.saveCalls).toHaveLength(2);
    // Overwrite exactly the version that was probed — sent as a STRING, so no
    // precision was lost on the way through the route.
    expect(currentBucket.saveCalls[1].precondition).toEqual({ ifGenerationMatch: storedGeneration });
    expect(typeof currentBucket.saveCalls[1].precondition!.ifGenerationMatch).toBe('string');
    // The write really landed: one object, at a new generation.
    expect(currentBucket.objects.size).toBe(1);
    expect(currentBucket.objects.get(first.body.path)!.generation).not.toBe(storedGeneration);
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([]);
  });

  it('(d) a probe that carried no generation degrades to NO precondition and still returns 200', async () => {
    const first = await upload(1_500, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);

    // The metadata read no longer reports `generation` — an odd backend, a shape we
    // cannot parse. Degrade, never fail: today's last-writer-wins.
    currentBucket.omitGeneration = true;
    jest.clearAllMocks();

    const retry = await upload(1_500, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(currentBucket.saveCalls).toHaveLength(2);
    expect(currentBucket.saveCalls[1].hasPreconditionOpts).toBe(false);
    expect(currentBucket.saveCalls[1].precondition).toBeUndefined();
    // Still an overwrite of one object, and still counted as one.
    expect(currentBucket.objects.size).toBe(1);
    expect(metricCalls(metricNames.storageUploadIdempotentOverwrite)).toEqual([{ purpose: 'chat' }]);
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([]);
  });

  it('(e) the legacy path never sends a precondition, and stays byte-for-byte unchanged', async () => {
    const res = await upload(1_000, { filename: 'photo.jpg', purpose: 'chat' });

    expect(res.status).toBe(200);
    expect(res.body.path).toMatch(/^chat-files\/acme\/c_[0-9a-f]{20}\/\d{13}_photo\.jpg$/);
    expect(currentBucket.saveCalls).toHaveLength(1);
    // No `preconditionOpts` KEY at all, so the options object the route hands
    // Storage is identical to the pre-F9 one. A precondition here would be wrong on
    // its own terms: a collision on a timestamped path is two UNRELATED uploads, so
    // "return the winner's url" would hand back a different file.
    expect(currentBucket.saveCalls[0].hasPreconditionOpts).toBe(false);
    expect(currentBucket.saveCalls[0].precondition).toBeUndefined();
    // And still: no probe, no listing, full body size reserved.
    expect(currentBucket.getMetadataCalls).toEqual([]);
    expect(currentBucket.getFilesCalls).toEqual([]);
    expect(currentDb.usageWrites).toEqual([1_000]);
    expect(Object.keys(res.body).sort()).toEqual(['bytes', 'contentType', 'path', 'shareToken', 'url']);
  });

  it('(e2) profilePicture without an uploadKey keeps last-writer-wins, unconditioned', async () => {
    // A deterministic path, but NOT a keyed one: two concurrent writes here may be
    // two genuinely different avatar picks, and handing the second one the first
    // one's url while dropping its bytes would be wrong. Only a key hash certifies
    // that the racers are attempts of one logical action.
    const first = await upload(900, { purpose: 'profilePicture', email: ACTOR_EMAIL, filename: 'me.jpg' });
    expect(first.status).toBe(200);
    expect(first.body.path).toMatch(/^profile-pictures\/acme\/[0-9a-f]{20}\.jpg$/);

    const second = await upload(950, { purpose: 'profilePicture', email: ACTOR_EMAIL, filename: 'me.jpg' });

    expect(second.status).toBe(200);
    expect(second.body.path).toBe(first.body.path);
    expect(currentBucket.saveCalls.map((call) => call.hasPreconditionOpts)).toEqual([false, false]);
    // The later bytes win, exactly as before F9.
    expect(currentBucket.objects.get(first.body.path)!.bytes).toBe(950);
  });

  it('(f) a 412 whose object then vanishes falls back to an unconditioned write, keeping the reservation', async () => {
    const objectPath = await learnDeterministicPath({ filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    currentBucket.beforeNextSave = () => {
      // A sibling creates the object (so our ifGenerationMatch: 0 fails)…
      currentBucket.put(objectPath, { bytes: 2_048, contentType: 'image/jpeg', downloadToken: 'ghost-token' });
      // …and it is gone again by the time we re-probe (deleted, lifecycle rule, a
      // transcode that consumed the original).
      currentBucket.beforeNextGetMetadata = () => {
        currentBucket.objects.delete(objectPath);
      };
    };

    const res = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    // Two write attempts: the conditional one that 412'd, then exactly one
    // unconditioned retry — today's behavior — and never a loop.
    expect(currentBucket.saveCalls).toHaveLength(2);
    expect(currentBucket.saveCalls[0].precondition).toEqual({ ifGenerationMatch: 0 });
    expect(currentBucket.saveCalls[1].hasPreconditionOpts).toBe(false);
    // Our bytes and our token are what is stored, and the url reflects them.
    const stored = currentBucket.objects.get(objectPath)!;
    expect(stored.bytes).toBe(2_048);
    expect(tokenFromUrl(res.body.url)).toBe(stored.downloadToken);
    expect(res.body.url).toBe(expectedUrl(objectPath, stored.downloadToken!));

    // The reservation was KEPT, because our bytes really are stored. Releasing here
    // would under-count — the one direction Requirement 9.4 forbids.
    expect(currentDb.usageWrites).toEqual([2_048]);
    expect(usageBytes()).toBe(2_048);
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([]);
    expect(metricCalls(metricNames.storageUploadAccepted)).toEqual([{ purpose: 'chat' }]);
  });

  it('a shrinking overwrite that loses the race does NOT release the shrink amount', async () => {
    // Both racers computed the same shrink from the same probed version. If the
    // loser released it too, recorded usage would drop by twice the real change —
    // an under-count. The winner's release is the only one that may happen.
    const first = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(first.status).toBe(200);
    const objectPath = first.body.path as string;
    currentBucket.objects.get(objectPath)!.bytes = 4_000;

    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 9_000 });
    currentDb.usageWrites.length = 0;
    jest.clearAllMocks();
    // The sibling overwrites first, moving the generation on.
    currentBucket.beforeNextSave = () => {
      currentBucket.put(objectPath, {
        bytes: 1_000,
        contentType: 'image/jpeg',
        downloadToken: currentBucket.objects.get(objectPath)!.downloadToken,
      });
    };

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    // No release of any kind from the loser: it reserved nothing (zero delta) and it
    // must not credit a shrink it did not perform.
    expect(currentDb.usageWrites).toEqual([]);
    expect(usageBytes()).toBe(9_000);
    expect(currentBucket.objects.size).toBe(1);
    // Both racers reused the probed token, so the writer is undecidable — reported
    // as a lost race (the url is identical either way) with no release.
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([{ purpose: 'chat' }]);
  });

  it('a 412 never becomes a 500, even when the release that follows it fails', async () => {
    const objectPath = await learnDeterministicPath({ filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    currentBucket.beforeNextSave = () => {
      currentBucket.put(objectPath, { bytes: 2_048, contentType: 'image/jpeg', downloadToken: 'winner-token' });
      // The release transaction is unavailable at exactly the wrong moment.
      currentDb.throwOnNextTransaction = new Error('release transaction unavailable');
    };

    const res = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    // Still a success with the winner's url: the file is stored and the url resolves.
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(expectedUrl(objectPath, 'winner-token'));
    // Usage stays over-counted until the next reconcile (Req 9.8) — never
    // under-counted, and never a failed upload.
    expect(usageBytes()).toBe(2_048);
    expect(metricCalls(metricNames.storageUploadFailed)).toEqual([]);
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([{ purpose: 'chat' }]);
  });

  it('a non-412 write failure still rolls back and returns 500', async () => {
    // The recovery must not swallow real failures: F9 changed nothing here.
    currentDb.seed(`tenantStorageUsage/${TENANT}`, { tenantId: TENANT, bytes: 5_000 });
    currentDb.usageWrites.length = 0;
    currentBucket.saveError = Object.assign(new Error('storage exploded'), { code: 503 });

    const res = await upload(1_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'upload_failed' });
    expect(currentDb.usageWrites).toEqual([6_000, 5_000]);
    expect(usageBytes()).toBe(5_000);
    // One attempt only: a non-412 is not a race signal.
    expect(currentBucket.saveCalls).toHaveLength(1);
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([]);
  });
});
// ---------------------------------------------------------------------------
// 12. A probe that could not read the object state must not condition the write
//     (follow-up F10)
// ---------------------------------------------------------------------------
//
// The regression F9 introduced. `probeExistingUploadObject` returned `null` for BOTH
// "the object is genuinely not there" (404) and "I could not read the object state"
// (a non-404 metadata failure, or metadata whose normalization threw), and
// `resolveUploadSavePrecondition` mapped both to `ifGenerationMatch: 0` — an
// assertion about state the request never observed.
//
// On an object that DOES exist, that assertion fails: the write 412s, the recovery
// re-probes, and if the metadata backend recovered in the interim the re-probe finds
// the pre-existing object carrying its own token. Our token was freshly minted (the
// degraded probe gave us nothing to reuse), so `carriesOurToken` is false, the
// outcome is reported as a lost race, the reservation is released, and the caller
// gets `200` with the PRE-EXISTING object's url while its bytes are never written —
// a silently dropped upload, and a response whose `bytes` disagree with what is
// stored.
//
// Requirement 9.13 requires the opposite: where the observed state cannot be read,
// send NO write condition and complete the upload. That is also exactly what the
// pre-F9 code did — an unconditioned write, with usage over-counted until the next
// reconcile (Req 9.2, 9.4, 9.8).
//
// Validates (route level): Requirements 9.2, 9.4, 9.13; design Property 13.

describe('an unreadable probe sends no write condition and still stores the caller\'s bytes (F10)', () => {
  const PRE_EXISTING_TOKEN = 'pre-existing-token-2b7c-41d0';

  it('writes the caller\'s bytes, returns the url of the token actually stored, and never hands back the pre-existing object\'s url', async () => {
    const objectPath = await learnDeterministicPath({ filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    // An object really IS at the deterministic path — the first attempt of this same
    // logical action stored it, and its url may already be persisted somewhere.
    currentBucket.put(objectPath, {
      bytes: 1_000,
      contentType: 'image/jpeg',
      downloadToken: PRE_EXISTING_TOKEN,
    });

    // The metadata backend is down for the route's probe…
    currentBucket.metadataError = new Error('metadata backend unavailable');
    // …and back up for the read that would follow a 412. This is the interleaving
    // that produced the silent drop: pre-F10 the write carried
    // `ifGenerationMatch: 0`, 412'd against the object above, and the recovering
    // re-probe then handed the caller the pre-existing object's url.
    currentBucket.beforeNextGetMetadata = () => {
      currentBucket.beforeNextGetMetadata = () => {
        currentBucket.metadataError = null;
      };
    };

    const res = await upload(3_000, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(res.status).toBe(200);
    expect(res.body.path).toBe(objectPath);

    // Req 9.13: the state was unknown, so the write asserts nothing about it. No
    // `preconditionOpts` KEY at all, i.e. byte-for-byte the pre-F9 options object.
    expect(currentBucket.saveCalls).toHaveLength(1);
    expect(currentBucket.saveCalls[0].hasPreconditionOpts).toBe(false);
    expect(currentBucket.saveCalls[0].precondition).toBeUndefined();
    // One probe, and no 412 recovery round trip, because there was no 412.
    expect(currentBucket.getMetadataCalls).toEqual([objectPath]);

    // THE BUG: the caller's bytes are stored, not dropped.
    const stored = currentBucket.objects.get(objectPath)!;
    expect(stored.bytes).toBe(3_000);
    expect(res.body.bytes).toBe(3_000);
    expect(currentBucket.saveCalls[0].bytes).toBe(3_000);
    expect(currentBucket.objects.size).toBe(1);

    // The url is built from the token that is actually stored — a fresh one, since a
    // degraded probe gave nothing to reuse (Req 4.3) — and is NOT the pre-existing
    // object's url, which is what the lost-race path used to hand back.
    expect(stored.downloadToken).toBe(currentBucket.saveCalls[0].downloadToken);
    expect(stored.downloadToken).not.toBe(PRE_EXISTING_TOKEN);
    expect(tokenFromUrl(res.body.url)).toBe(stored.downloadToken);
    expect(res.body.url).toBe(expectedUrl(objectPath, stored.downloadToken!));
    expect(res.body.url).not.toBe(expectedUrl(objectPath, PRE_EXISTING_TOKEN));

    // Accounting is unchanged from a degraded probe pre-F9: the full size is
    // reserved (existingBytes read as 0) and nothing is released, so usage is
    // OVER-counted until the next reconcile — never under-counted (Req 9.4, 9.8).
    expect(currentDb.usageWrites).toEqual([3_000]);
    expect(usageBytes()).toBe(3_000);

    // The probe failure is counted exactly once, labelled by purpose only (Req 8.2).
    expect(metricCalls(metricNames.storageUploadOverwriteProbeFailed)).toEqual([{ purpose: 'chat' }]);
    // Not a race, and not an overwrite: nothing was observed to overwrite, so the
    // three success counters stay disjoint.
    expect(metricCalls(metricNames.storageUploadConcurrentRaceLost)).toEqual([]);
    expect(metricCalls(metricNames.storageUploadIdempotentOverwrite)).toEqual([]);
    expect(metricCalls(metricNames.storageUploadAccepted)).toEqual([{ purpose: 'chat' }]);
    expect(metricCalls(metricNames.storageUploadFailed)).toEqual([]);
  });

  it('still sends ifGenerationMatch: 0 for a GENUINE 404, so the concurrency fix is not weakened', async () => {
    // The two cases side by side in one route: a 404 keeps the create-only condition
    // that closes the same-`uploadKey` race, while a failed read does not.
    const clean = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });
    expect(clean.status).toBe(200);
    expect(currentBucket.saveCalls[0].precondition).toEqual({ ifGenerationMatch: 0 });

    const objectPath = clean.body.path as string;
    currentBucket.metadataError = new Error('metadata backend unavailable');

    const degraded = await upload(2_048, { filename: 'photo.jpg', uploadKey: UPLOAD_KEY });

    expect(degraded.status).toBe(200);
    expect(currentBucket.saveCalls).toHaveLength(2);
    expect(currentBucket.saveCalls[1].hasPreconditionOpts).toBe(false);
    // Same path, one object, and the bytes of the second request are what is stored.
    expect(degraded.body.path).toBe(objectPath);
    expect(currentBucket.objects.size).toBe(1);
    expect(tokenFromUrl(degraded.body.url)).toBe(currentBucket.objects.get(objectPath)!.downloadToken);
  });
});
