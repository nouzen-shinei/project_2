import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import crypto from 'crypto';
import { createRequire } from 'module';

// Emulator integration test for the /devices/ping WRITE-PATH `tenantIndex`
// maintenance (device-tenant-index Stage 3; Requirements 2.1, 2.2, 2.5, 2.6,
// 3.1, 3.3).
//
// Exercises the REAL `/devices/ping` express handler (backend-runtime/src/app.ts)
// against a live Firestore emulator, driving it over HTTP via `createApp` +
// `fetch` — the same supertest-style convention as `devicePingTenantGuards.test.mjs`
// — while pointing firebase-admin at the emulator like the sibling
// `deviceTenantIndexListing.test.mjs`. It asserts:
//   1. REGISTER pings recompute the whole index transactionally: the persisted
//      `tenantIndex` equals `deriveTenantIndex(resulting source)` IN THE SAME
//      doc, and a scope shrink (client removed a tenant) drops the stale entry
//      (Req 2.1, 2.2, 2.4, 2.5).
//   2. HEARTBEAT / FULL pings are ADDITIVE: they union the pinged tenant into
//      `tenantIndex` in the same atomic write and never drop existing tenants;
//      the persisted index still equals `deriveTenantIndex(resulting source)`
//      (Req 2.3, 2.5, 3.1).
//   3. A presence-only heartbeat whose pinged tenant is ALREADY in scope changes
//      no scope field yet still leaves the pinged tenant present and drops no
//      existing tenant (Req 3.3).
//   4. An injected REGISTER-path transaction failure leaves scope + `tenantIndex`
//      unchanged and surfaces `500 internal_error` (not swallowed) (Req 2.6).
//
// `FIRESTORE_EMULATOR_HOST` is a HARD precondition; when unset the suite skips
// entirely. Import from `../dist/*.js` (build first), matching the convention.

const require = createRequire(import.meta.url);

const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const HAS_EMULATOR = EMULATOR_HOST.length > 0;
const skip = HAS_EMULATOR
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

if (HAS_EMULATOR) {
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-device-console';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
  process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'device-ping-index-secret';
}

describe('device-tenant-index ping write-path maintenance (Requirements 2.1, 2.2, 2.5, 2.6, 3.1, 3.3)', { skip }, () => {
  let createApp;
  let deriveTenantIndex;
  let getFirestore;
  let db;
  const servers = new Set();

  before(async () => {
    ({ createApp } = await import('../dist/app.js'));
    ({ deriveTenantIndex } = await import('../dist/deviceAdminService.js'));
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    db = getFirestore();
  });

  after(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
    try {
      await require('firebase-admin').app().delete();
    } catch {
      // ignore teardown failures
    }
  });

  function buildInternalToken({ uid = 'device-user', email } = {}) {
    const payload = { sub: uid, email, exp: Math.floor(Date.now() / 1000) + 300 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', process.env.INTERNAL_API_KEY)
      .update(body)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  async function startServer() {
    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (auth, tenantIdRaw) => {
          const tenantId = (tenantIdRaw || '').trim() || 'tenant-default';
          return { tenantId, role: 'staff', membershipId: `${tenantId}:${auth?.uid || 'uid'}` };
        },
      },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('server address unavailable');
    }
    const base = `http://127.0.0.1:${address.port}`;
    servers.add(server);
    return { base };
  }

  async function ping({ base, tenantId, email, deviceId, pingType, isOnline }) {
    const body = { tenantId, userEmail: email, deviceId, pingType };
    if (isOnline !== undefined) body.isOnline = isOnline;
    return fetch(`${base}/devices/ping`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  function deviceRef(email, deviceId) {
    return db.collection('user_devices').doc(email).collection('devices').doc(deviceId);
  }

  async function readDevice(email, deviceId) {
    const snap = await deviceRef(email, deviceId).get();
    return snap.exists ? snap.data() : null;
  }

  // The resulting Tenant_Scoping_Source persisted on the doc; deriving over it
  // must reproduce the stored `tenantIndex` (the co-write invariant).
  function derivedFromStored(data) {
    return deriveTenantIndex({
      tenantIds: data.tenantIds,
      activeTenantId: data.activeTenantId,
      tenantMemberships: data.tenantMemberships,
    });
  }

  it('register ping recomputes tenantIndex = deriveTenantIndex(resulting source) and drops removed tenants', async () => {
    const { base } = await startServer();
    const stamp = `reg-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;
    const membershipTenant = `member-tenant-${stamp}`;
    const removedTenant = `removed-tenant-${stamp}`;

    // Represent the state AFTER the client's registration setDoc(merge): the
    // client dropped `removedTenant` from tenantIds but a stale tenantIndex still
    // carries it; an active membership contributes `membershipTenant`.
    await deviceRef(email, deviceId).set({
      deviceId,
      tenantIds: [],
      activeTenantId: null,
      tenantMemberships: [
        { tenantId: membershipTenant, role: 'member', status: 'active' },
        { tenantId: `inactive-${stamp}`, role: 'member', status: 'revoked' },
      ],
      tenantIndex: [removedTenant, tenantId], // stale
    });

    const response = await ping({ base, tenantId, email, deviceId, pingType: 'register' });
    assert.strictEqual(response.status, 200);

    const stored = await readDevice(email, deviceId);
    assert.ok(stored, 'device doc should exist after register');

    // Scope reflects this ping's contribution.
    assert.strictEqual(stored.activeTenantId, tenantId);
    assert.ok(Array.isArray(stored.tenantIds) && stored.tenantIds.includes(tenantId));

    // Index equals deriveTenantIndex of the resulting source in the SAME doc.
    assert.deepStrictEqual(stored.tenantIndex, derivedFromStored(stored));
    // Full recompute drops the client-removed tenant and includes the active
    // membership tenant + the pinged tenant, excluding the inactive membership.
    assert.deepStrictEqual(stored.tenantIndex, [membershipTenant, tenantId].sort());
    assert.strictEqual(stored.tenantIndex.includes(removedTenant), false, 'register recompute must drop removed tenants');
    assert.strictEqual(stored.tenantIndex.includes(`inactive-${stamp}`), false, 'inactive membership must be excluded');
  });

  it('heartbeat ping additively unions the pinged tenant into tenantIndex without dropping existing tenants', async () => {
    const { base } = await startServer();
    const stamp = `hb-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const existingTenant = `existing-${stamp}`;
    const tenantId = `tenant-${stamp}`;

    // Pre-existing scope for a DIFFERENT tenant, with a fresh index.
    await deviceRef(email, deviceId).set({
      deviceId,
      tenantIds: [existingTenant],
      activeTenantId: existingTenant,
      tenantIndex: [existingTenant],
    });

    const response = await ping({ base, tenantId, email, deviceId, pingType: 'heartbeat' });
    assert.strictEqual(response.status, 200);

    const stored = await readDevice(email, deviceId);
    // Additive: existing tenant retained, pinged tenant added.
    assert.strictEqual(stored.tenantIndex.includes(existingTenant), true, 'existing tenant must not be dropped');
    assert.strictEqual(stored.tenantIndex.includes(tenantId), true, 'pinged tenant must be present');
    assert.deepStrictEqual(stored.tenantIndex, [existingTenant, tenantId].sort());
    // Co-write invariant still holds against the resulting source.
    assert.deepStrictEqual(stored.tenantIndex, derivedFromStored(stored));
  });

  it('full ping additively maintains tenantIndex consistent with the resulting source', async () => {
    const { base } = await startServer();
    const stamp = `full-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;

    // New device (no prior doc) — full ping should create it with the index.
    const response = await ping({ base, tenantId, email, deviceId, pingType: 'full' });
    assert.strictEqual(response.status, 200);

    const stored = await readDevice(email, deviceId);
    assert.deepStrictEqual(stored.tenantIndex, [tenantId]);
    assert.deepStrictEqual(stored.tenantIndex, derivedFromStored(stored));
  });

  it('presence-only heartbeat (pinged tenant already in scope) changes no scope field yet keeps the index intact', async () => {
    const { base } = await startServer();
    const stamp = `presence-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;
    const otherExisting = `other-${stamp}`;

    // The pinged tenant is already active and in tenantIds; another tenant is
    // also present. The heartbeat's arrayUnion(tenantId) is a no-op on scope.
    await deviceRef(email, deviceId).set({
      deviceId,
      tenantIds: [tenantId, otherExisting],
      activeTenantId: tenantId,
      tenantIndex: [otherExisting, tenantId],
    });

    const response = await ping({ base, tenantId, email, deviceId, pingType: 'heartbeat', isOnline: true });
    assert.strictEqual(response.status, 200);

    const stored = await readDevice(email, deviceId);
    // Pinged tenant still present, existing tenant not dropped (additive no-op).
    assert.strictEqual(stored.tenantIndex.includes(tenantId), true);
    assert.strictEqual(stored.tenantIndex.includes(otherExisting), true);
    assert.deepStrictEqual(stored.tenantIndex, [otherExisting, tenantId].sort());
    assert.deepStrictEqual(stored.tenantIndex, derivedFromStored(stored));
  });

  it('an injected register-path transaction failure leaves scope + tenantIndex unchanged and surfaces 500 internal_error', async () => {
    const { base } = await startServer();
    const stamp = `txfail-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;
    const seededTenant = `seeded-${stamp}`;

    const seeded = {
      deviceId,
      tenantIds: [seededTenant],
      activeTenantId: seededTenant,
      tenantIndex: [seededTenant],
    };
    await deviceRef(email, deviceId).set(seeded);

    // Inject a failure into the singleton Firestore's runTransaction (the app
    // shares this instance via admin.firestore()). Only the register path uses a
    // transaction, so heartbeat/full are unaffected.
    const originalRunTransaction = db.runTransaction;
    db.runTransaction = () => Promise.reject(new Error('injected transaction failure'));

    let response;
    try {
      response = await ping({ base, tenantId, email, deviceId, pingType: 'register' });
    } finally {
      db.runTransaction = originalRunTransaction;
    }

    assert.strictEqual(response.status, 500);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'internal_error', 'the transaction failure must be surfaced, not swallowed');

    // Scope + index are exactly as seeded — nothing changed.
    const stored = await readDevice(email, deviceId);
    assert.deepStrictEqual(stored.tenantIds, [seededTenant]);
    assert.strictEqual(stored.activeTenantId, seededTenant);
    assert.deepStrictEqual(stored.tenantIndex, [seededTenant]);
  });
});
