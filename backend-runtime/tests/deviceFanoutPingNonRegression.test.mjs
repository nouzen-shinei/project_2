import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import crypto from 'crypto';
import { createRequire } from 'module';

// device-push-fanout-migration, Task 14.3 — `/devices/ping` heartbeat
// NON-REGRESSION after the Stage 4 `user_devices` read-rule tightening.
//
// Stage 4 (task 14.1) tightened the `user_devices` Device_Read_Rule from
// `allow read: if isSignedIn()` to `allow read: if isDeviceOwner(ownerEmail)`
// (parent doc + `{devicePath=**}` subtree). This suite proves EMPIRICALLY that
// the tightening changes NOTHING about the backend `/devices/ping` heartbeat
// path: `/devices/ping` writes through the Firebase Admin SDK, which BYPASSES
// Firestore security rules entirely (Requirement 8.4), so a read-rule change
// cannot affect it. We exercise the REAL `/devices/ping` express handler
// (backend-runtime/src/app.ts) against a live Firestore emulator — driving it
// over HTTP via `createApp` + `fetch` and reading the persisted docs back with
// the Admin SDK — and assert register / heartbeat / full behavior plus the
// tenant/validation guards match exactly what the pre-existing
// `devicePingTenantGuards.test.mjs` / `deviceTenantIndexPing.test.mjs` already
// assert. (Requirements 10.3, 11.5.)
//
// Convention (matches the sibling emulator suites): `FIRESTORE_EMULATOR_HOST`
// is a HARD precondition — when unset the suite skips entirely. Imports come
// from `../dist/*.js`, so the backend must be built first (`npm run build`).

const require = createRequire(import.meta.url);

const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const HAS_EMULATOR = EMULATOR_HOST.length > 0;
const skip = HAS_EMULATOR
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

// Pin a deterministic emulator project id (overridable) before any backend code
// initializes the Admin SDK, matching the sibling emulator suites so the seeder
// and the ping handler share one namespace.
if (HAS_EMULATOR) {
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-device-console';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
  process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'device-ping-nonregression-secret';
}

describe('/devices/ping heartbeat non-regression after user_devices read lockdown (Requirements 10.3, 11.5)', { skip }, () => {
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

  // Build the real app with a stubbed tenant membership guard (mirrors
  // devicePingTenantGuards.test.mjs / deviceTenantIndexPing.test.mjs). By
  // default the guard resolves the body tenant with role `member`, exercising
  // the `requireMemberTenantAccess` min-role for `/devices/ping`. A caller can
  // override `resolveTenantId` to force a specific tenant (used for the
  // tenant-mismatch guard case).
  async function startServer(overrides = {}) {
    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (auth, tenantIdRaw) => {
          const tenantId = (tenantIdRaw || '').trim() || 'tenant-default';
          if (typeof overrides.resolveTenantId === 'function') {
            return overrides.resolveTenantId(auth, tenantIdRaw);
          }
          return { tenantId, role: 'member', membershipId: `${tenantId}:${auth?.uid || 'uid'}` };
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
    const body = { tenantId, userEmail: email, deviceId };
    if (pingType !== undefined) body.pingType = pingType;
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

  async function readUserDoc(email) {
    const snap = await db.collection('user_devices').doc(email).get();
    return snap.exists ? snap.data() : null;
  }

  // The resulting Tenant_Scoping_Source persisted on the doc; deriving over it
  // must reproduce the stored `tenantIndex` (the co-write invariant enforced by
  // the register recompute path).
  function derivedFromStored(data) {
    return deriveTenantIndex({
      tenantIds: data.tenantIds,
      activeTenantId: data.activeTenantId,
      tenantMemberships: data.tenantMemberships,
    });
  }

  // ── 1. Heartbeat ping (the hot path) is unchanged ──────────────────────────
  it('a member heartbeat ping succeeds and stamps heartbeat metadata + additive tenantIndex', async () => {
    const { base } = await startServer();
    const stamp = `hb-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;

    const response = await ping({ base, tenantId, email, deviceId, pingType: 'heartbeat' });
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.deepStrictEqual(payload, { ok: true, tenantId, deviceId });

    const stored = await readDevice(email, deviceId);
    assert.ok(stored, 'device doc should exist after heartbeat');
    assert.strictEqual(stored.lastActivityType, 'heartbeat');
    assert.strictEqual(stored.lastPingType, 'heartbeat');
    assert.strictEqual(stored.isOnline, true, 'isOnline defaults to true when omitted');
    assert.strictEqual(stored.ownerEmail, email);
    assert.strictEqual(stored.activeTenantId, tenantId);
    assert.ok(Array.isArray(stored.tenantIds) && stored.tenantIds.includes(tenantId), 'tenantIds must contain the pinged tenant');
    // Additive arrayUnion: the pinged tenant is present in the derived index.
    assert.ok(Array.isArray(stored.tenantIndex) && stored.tenantIndex.includes(tenantId), 'tenantIndex must contain the pinged tenant');
    assert.deepStrictEqual(stored.tenantIndex, derivedFromStored(stored));
  });

  // ── 2. Full ping is unchanged ───────────────────────────────────────────────
  it('a full ping stamps full_update metadata and additively keeps the tenant in tenantIndex', async () => {
    const { base } = await startServer();
    const stamp = `full-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;

    const response = await ping({ base, tenantId, email, deviceId, pingType: 'full', isOnline: false });
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.deepStrictEqual(payload, { ok: true, tenantId, deviceId });

    const stored = await readDevice(email, deviceId);
    assert.ok(stored, 'device doc should exist after full ping');
    assert.strictEqual(stored.lastActivityType, 'full_update');
    assert.strictEqual(stored.lastPingType, 'full');
    assert.strictEqual(stored.isOnline, false, 'explicit isOnline:false must be honored');
    assert.ok(stored.tenantIndex.includes(tenantId), 'additive tenantIndex must contain the pinged tenant');
    assert.deepStrictEqual(stored.tenantIndex, derivedFromStored(stored));
  });

  // ── 3. Register ping is unchanged (full transactional recompute) ────────────
  it('a register ping stamps device_registration metadata and a recomputed, consistent tenantIndex', async () => {
    const { base } = await startServer();
    const stamp = `reg-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;

    const response = await ping({ base, tenantId, email, deviceId, pingType: 'register' });
    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.deepStrictEqual(payload, { ok: true, tenantId, deviceId });

    const stored = await readDevice(email, deviceId);
    assert.ok(stored, 'device doc should exist after register');
    assert.strictEqual(stored.lastActivityType, 'device_registration');
    assert.strictEqual(stored.lastPingType, 'register');
    assert.strictEqual(stored.activeTenantId, tenantId);
    assert.ok(stored.tenantIds.includes(tenantId));
    // The register path recomputes the whole index via deriveTenantIndex and
    // co-writes it: the persisted index is present, contains the pinged tenant,
    // and equals deriveTenantIndex(resulting source) in the same doc.
    assert.ok(Array.isArray(stored.tenantIndex) && stored.tenantIndex.includes(tenantId), 'recomputed tenantIndex must contain the pinged tenant');
    assert.deepStrictEqual(stored.tenantIndex, derivedFromStored(stored));
  });

  // ── 4. Parent aggregate doc still receives arrayUnion(tenantId) ─────────────
  it('the parent user_devices/{email} doc receives arrayUnion(tenantId) on tenantIds', async () => {
    const { base } = await startServer();
    const stamp = `parent-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;
    const tenantId = `tenant-${stamp}`;

    const response = await ping({ base, tenantId, email, deviceId, pingType: 'heartbeat' });
    assert.strictEqual(response.status, 200);

    const parent = await readUserDoc(email);
    assert.ok(parent, 'parent user_devices doc should exist after ping');
    assert.strictEqual(parent.email, email);
    assert.ok(Array.isArray(parent.tenantIds) && parent.tenantIds.includes(tenantId), 'parent tenantIds must union the pinged tenant');
  });

  // ── 5. Guard non-regression: tenant mismatch + malformed body ───────────────
  it('rejects a body/guard tenant mismatch with 403 tenant_mismatch and writes nothing', async () => {
    const { base } = await startServer({
      resolveTenantId: async () => ({ tenantId: 'tenant-guard', role: 'member', membershipId: 'tenant-guard::uid' }),
    });
    const stamp = `mismatch-${Date.now()}`;
    const email = `owner-${stamp}@example.com`;
    const deviceId = `dev-${stamp}`;

    const response = await ping({ base, tenantId: 'tenant-other', email, deviceId, pingType: 'heartbeat' });
    assert.strictEqual(response.status, 403);
    const data = await response.json();
    assert.strictEqual(data.error, 'tenant_mismatch');
    // The mismatch is rejected before any write, so no device doc is created.
    assert.strictEqual(await readDevice(email, deviceId), null, 'a rejected mismatch must not write a device doc');
  });

  it('rejects a malformed body with 400 validation_failed', async () => {
    const { base } = await startServer();

    // Missing userEmail + a too-short deviceId (< 4 chars) violate devicePingSchema.
    const response = await fetch(`${base}/devices/ping`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: 'coach@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-a', deviceId: 'ab' }),
    });

    assert.strictEqual(response.status, 400);
    const data = await response.json();
    assert.strictEqual(data.error, 'validation_failed');
    assert.ok(Array.isArray(data.issues), 'validation errors should be reported');
  });
});
