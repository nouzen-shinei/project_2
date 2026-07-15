import assert from 'assert';
import { describe, it, before, after, afterEach } from 'node:test';
import crypto from 'crypto';
import { createRequire } from 'module';

// device-push-fanout-migration, Task 10.2 — parity tests for the Stage 3
// resolution endpoints (design "Cross_User_Reader migration inventory";
// Req 5.4, 7.3, 7.5).
//
// Drives the REAL Express app (createApp) via HTTP + fetch against a live
// Firestore emulator and asserts that the server-side replacements for the
// client Cross_User_Readers preserve their observable behavior:
//   - POST /notifications/online-status returns EXACTLY the boolean "any device
//     online" the client `checkUserOnlineStatus` produced for the same device
//     shapes (Req 7.5), and never leaks tokens/endpoints/metadata (Req 5.4);
//   - POST /notifications/device-listing returns the SAME observable multi-user
//     listing the client `getAllUsersWithDevices` produced (Req 7.5) — same
//     users, same per-device online flags, same `totalDevices`/`tenantIds`, same
//     online-first-then-email ordering — with every device's raw push tokens,
//     web-push subscription endpoints, and device network metadata stripped
//     (Req 5.4).
//
// Like the sibling `deviceFanout.endpoints.test.mjs`, the authorized paths run
// the REAL resolution against the emulator, so `FIRESTORE_EMULATOR_HOST` is a
// HARD precondition (the suite skips entirely when it is unset). The tenant
// membership guard is stubbed via the `requireTenantMembershipAccess` override
// (mirroring the sibling suites) so the caller's tenant/role is controlled
// without seeding memberships.

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
  process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'device-fanout-secret';
}

// The 300-second (5-minute) online window shared with `deviceAdminService`
// (`DEFAULT_ONLINE_WINDOW_MS`, Req 1.6) — the server-side online standard the
// resolution paths recompute against.
const ONLINE_WINDOW_MS = 300_000;

// Device-document fields that must NEVER appear in a resolution response
// (Req 5.4): raw push tokens, the web-push subscription, and device network
// metadata. Asserted absent from every returned device.
const FORBIDDEN_DEVICE_KEYS = [
  'expoPushToken',
  'fcmToken',
  'apnsToken',
  'webPushSubscription',
  'ipAddress',
];

/** Parse a seeded timestamp (ISO string / epoch-ms) to epoch-ms, or NaN. */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Number.NaN : parsed;
  }
  return Number.NaN;
}

// Independent oracle for a device's observable online status — deliberately
// re-derived from the client `getUserDevices` semantics (recent presence within
// the window AND stored `isOnline !== false`) rather than importing the
// production predicate, so the test cross-checks behavior. Uses the shared 300s
// window so the seeded shapes agree with the server standard.
function oracleDeviceOnline(data, nowMs) {
  let freshest = Number.NaN;
  for (const value of [data.lastSeen, data.updatedAt, data.lastTenantPingAt]) {
    const ms = toMs(value);
    if (Number.isFinite(ms)) {
      freshest = Number.isNaN(freshest) ? ms : Math.max(freshest, ms);
    }
  }
  const fresh = Number.isFinite(freshest) && nowMs - freshest <= ONLINE_WINDOW_MS;
  return fresh && data.isOnline !== false;
}

describe('device fanout resolution endpoints (Requirements 5.4, 7.3, 7.5)', { skip }, () => {
  let createApp;
  let TenantAccessError;
  let getFirestore;
  let db;
  const servers = new Set();

  before(async () => {
    ({ createApp, TenantAccessError } = await import('../dist/app.js'));
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    db = getFirestore();
  });

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
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

  function buildInternalToken({ uid = 'member-uid', email = 'member@example.com' } = {}) {
    const payload = { sub: uid, email, exp: Math.floor(Date.now() / 1000) + 300 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', process.env.INTERNAL_API_KEY)
      .update(body)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  async function startServer({ guardImpl } = {}) {
    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (authContext, tenantIdRaw, options) => {
          const tenantId = (tenantIdRaw || '').trim() || 'tenant-default';
          if (guardImpl) {
            return guardImpl(authContext, tenantId, options);
          }
          return { tenantId, role: 'member', membershipId: `${tenantId}:${authContext?.uid || 'uid'}` };
        },
        verifyFirebaseIdToken: async () => {
          throw new Error('invalid_id_token');
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
    return { base, server };
  }

  async function seedDevice(recipientEmail, deviceId, data) {
    await db
      .collection('user_devices')
      .doc(recipientEmail)
      .collection('devices')
      .doc(deviceId)
      .set({ deviceId, ownerEmail: recipientEmail, ...data });
  }

  function post(base, path, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
  }

  it('online-status returns the prior "any device online" boolean for the same device shapes (Req 7.5)', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const tenantId = `tenant-${stamp}`;
    const otherTenant = `other-${stamp}`;
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const online = `alice-${stamp}@example.com`;
    const offline = `bob-${stamp}@example.com`;
    const scopedOut = `carol-${stamp}@example.com`;

    // alice: one non-deleted online mobile device (+ secrets to prove stripping).
    await seedDevice(online, `dev-on-1`, {
      deviceType: 'mobile',
      tenantIds: [tenantId],
      activeTenantId: tenantId,
      isOnline: true,
      lastSeen: nowIso,
      updatedAt: nowIso,
      expoPushToken: 'ExponentPushToken[secret-a]',
      apnsToken: 'apns-secret-a',
      ipAddress: '10.0.0.7',
    });
    // bob: only offline devices (stale lastSeen and explicit isOnline:false).
    await seedDevice(offline, `dev-off-1`, {
      deviceType: 'web',
      tenantIds: [tenantId],
      activeTenantId: tenantId,
      isOnline: false,
      lastSeen: oldIso,
      updatedAt: oldIso,
    });
    // carol: an ONLINE device but tagged to a DIFFERENT tenant — must be scoped
    // out, so carol resolves offline for `tenantId`.
    await seedDevice(scopedOut, `dev-other-1`, {
      deviceType: 'mobile',
      tenantIds: [otherTenant],
      activeTenantId: otherTenant,
      isOnline: true,
      lastSeen: nowIso,
      updatedAt: nowIso,
    });

    const { base } = await startServer({
      guardImpl: async (_auth, tenantIdRaw) => ({
        tenantId: tenantIdRaw,
        role: 'member',
        membershipId: `${tenantIdRaw}:member`,
      }),
    });
    const token = buildInternalToken();
    const nowMs = Date.now();

    for (const [recipient, seededInScope] of [
      [online, [{ isOnline: true, lastSeen: nowIso }]],
      [offline, [{ isOnline: false, lastSeen: oldIso }]],
      [scopedOut, []], // only other-tenant device -> none in scope
    ]) {
      const expected = seededInScope.some((d) => oracleDeviceOnline(d, nowMs));
      const res = await post(base, '/notifications/online-status', {
        token,
        body: { tenantId, recipientEmail: recipient },
      });
      assert.strictEqual(res.status, 200, `online-status should be 200 for ${recipient}`);
      const payload = await res.json();
      assert.deepStrictEqual(
        Object.keys(payload).sort(),
        ['online'],
        'online-status response must contain ONLY the boolean'
      );
      assert.strictEqual(typeof payload.online, 'boolean');
      assert.strictEqual(
        payload.online,
        expected,
        `online-status for ${recipient} must equal the prior "any device online" boolean`
      );
      // Req 5.4: no token/endpoint/metadata field may appear in the response.
      for (const forbidden of FORBIDDEN_DEVICE_KEYS) {
        assert.ok(
          !Object.prototype.hasOwnProperty.call(payload, forbidden),
          `online-status response must not include "${forbidden}"`
        );
      }
    }
  });

  it('device-listing matches the prior observable listing and leaks no secrets (Req 5.4, 7.5)', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const tenantId = `tenant-${stamp}`;
    const otherTenant = `other-${stamp}`;
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    const alice = `alice-${stamp}@example.com`;
    const bob = `bob-${stamp}@example.com`;
    const carol = `carol-${stamp}@example.com`;

    // The seeded device docs keyed by recipient — the oracle input. Each carries
    // the fields the client `getUserDevices` observes plus secret fields we must
    // see stripped from the response.
    const seed = {
      [alice]: {
        // Non-deleted online mobile device — makes alice online.
        'a-online': {
          deviceType: 'mobile',
          tenantIds: [tenantId],
          activeTenantId: tenantId,
          isOnline: true,
          lastSeen: nowIso,
          updatedAt: nowIso,
          expoPushToken: 'ExponentPushToken[secret-a]',
          fcmToken: 'fcm-secret-a',
          apnsToken: 'apns-secret-a',
          ipAddress: '10.0.0.1',
          webPushSubscription: { endpoint: 'https://push.example/a', keys: { p256dh: 'x', auth: 'y' } },
        },
        // Offline web device.
        'a-offline': {
          deviceType: 'web',
          tenantIds: [tenantId],
          activeTenantId: tenantId,
          isOnline: false,
          lastSeen: oldIso,
          updatedAt: oldIso,
          webPushSubscription: { endpoint: 'https://push.example/a2', keys: { p256dh: 'x', auth: 'y' } },
        },
        // Deleted-but-fresh device: device-level online, but excluded from the
        // user-level online flag (client `!device.isDeleted`).
        'a-deleted': {
          deviceType: 'mobile',
          tenantIds: [tenantId],
          activeTenantId: tenantId,
          isOnline: true,
          isDeleted: true,
          lastSeen: nowIso,
          updatedAt: nowIso,
          expoPushToken: 'ExponentPushToken[secret-a3]',
        },
      },
      [bob]: {
        // Only an offline device — bob is offline.
        'b-offline': {
          deviceType: 'mobile',
          tenantIds: [tenantId],
          activeTenantId: tenantId,
          isOnline: false,
          lastSeen: oldIso,
          updatedAt: oldIso,
          expoPushToken: 'ExponentPushToken[secret-b]',
        },
      },
      [carol]: {
        // Online, but tagged to a DIFFERENT tenant — scoped out entirely, so
        // carol surfaces with an empty device set.
        'c-other-tenant': {
          deviceType: 'mobile',
          tenantIds: [otherTenant],
          activeTenantId: otherTenant,
          isOnline: true,
          lastSeen: nowIso,
          updatedAt: nowIso,
        },
      },
    };

    for (const [recipient, devices] of Object.entries(seed)) {
      for (const [deviceId, data] of Object.entries(devices)) {
        await seedDevice(recipient, deviceId, data);
      }
    }

    const { base } = await startServer({
      guardImpl: async (_auth, tenantIdRaw) => ({
        tenantId: tenantIdRaw,
        role: 'member',
        membershipId: `${tenantIdRaw}:member`,
      }),
    });
    const token = buildInternalToken();

    const res = await post(base, '/notifications/device-listing', {
      token,
      body: { tenantId, recipientEmails: [carol, bob, alice] },
    });
    assert.strictEqual(res.status, 200);
    const payload = await res.json();
    assert.deepStrictEqual(Object.keys(payload), ['users'], 'listing response wraps the users array');
    const nowMs = Date.now();

    // --- Build the oracle listing from the seeded shapes (client parity) ------
    const oracleUsers = [carol, bob, alice].map((email) => {
      const scoped = Object.entries(seed[email])
        .filter(([, data]) => {
          const ids = Array.isArray(data.tenantIds) ? data.tenantIds : [];
          return ids.includes(tenantId) || data.activeTenantId === tenantId;
        })
        .map(([deviceId, data]) => ({ deviceId, data, online: oracleDeviceOnline(data, nowMs) }));
      const isOnline = scoped.some((d) => d.online && d.data.isDeleted !== true);
      return { email, deviceCount: scoped.length, isOnline };
    });
    // Client final sort: online users first, then email ascending.
    oracleUsers.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return a.email.localeCompare(b.email);
    });

    // --- Ordering + per-user parity ------------------------------------------
    assert.deepStrictEqual(
      payload.users.map((u) => u.email),
      oracleUsers.map((u) => u.email),
      'users must be ordered online-first then email-ascending, matching the client'
    );

    for (const oracle of oracleUsers) {
      const user = payload.users.find((u) => u.email === oracle.email);
      assert.ok(user, `listing must include ${oracle.email}`);
      assert.strictEqual(user.isOnline, oracle.isOnline, `${oracle.email} user online flag must match`);
      assert.strictEqual(user.totalDevices, oracle.deviceCount, `${oracle.email} totalDevices must match`);
      assert.strictEqual(
        Array.isArray(user.devices) ? user.devices.length : -1,
        oracle.deviceCount,
        `${oracle.email} devices array length must match totalDevices`
      );
      assert.ok(Array.isArray(user.tenantIds) && user.tenantIds.length > 0, `${oracle.email} tenantIds present`);

      // Per-device parity: the returned device set matches the tenant-scoped
      // seeded set, each device's recomputed `isOnline` matches the oracle, and
      // NO secret field leaks.
      const scopedSeed = Object.entries(seed[oracle.email]).filter(([, data]) => {
        const ids = Array.isArray(data.tenantIds) ? data.tenantIds : [];
        return ids.includes(tenantId) || data.activeTenantId === tenantId;
      });
      assert.deepStrictEqual(
        user.devices.map((d) => d.deviceId).sort(),
        scopedSeed.map(([deviceId]) => deviceId).sort(),
        `${oracle.email} returned device ids must equal the tenant-scoped seeded ids`
      );
      for (const device of user.devices) {
        const [, seededData] = scopedSeed.find(([deviceId]) => deviceId === device.deviceId);
        assert.strictEqual(
          device.isOnline,
          oracleDeviceOnline(seededData, nowMs),
          `${oracle.email}/${device.deviceId} recomputed isOnline must match the client derivation`
        );
        for (const forbidden of FORBIDDEN_DEVICE_KEYS) {
          assert.ok(
            !Object.prototype.hasOwnProperty.call(device, forbidden),
            `${oracle.email}/${device.deviceId} must not include "${forbidden}"`
          );
        }
      }
    }
  });

  it('rejects a request with no internal token with 401 (Req 5.1)', async () => {
    const { base } = await startServer();
    const res = await post(base, '/notifications/online-status', {
      body: { tenantId: 'tenant-a', recipientEmail: 'recipient@example.com' },
    });
    assert.strictEqual(res.status, 401);
  });

  it('rejects a malformed device-listing body with 400 validation_failed', async () => {
    const { base } = await startServer();
    const res = await post(base, '/notifications/device-listing', {
      token: buildInternalToken(),
      body: { tenantId: 'tenant-a' }, // recipientEmails omitted
    });
    assert.strictEqual(res.status, 400);
    const payload = await res.json();
    assert.strictEqual(payload.error, 'validation_failed');
  });

  it('rejects a tenantId mismatch between body and guard with 403 tenant_mismatch', async () => {
    const { base } = await startServer({
      guardImpl: async () => ({
        tenantId: 'tenant-actual',
        role: 'member',
        membershipId: 'tenant-actual:member',
      }),
    });
    const res = await post(base, '/notifications/online-status', {
      token: buildInternalToken(),
      body: { tenantId: 'wrong-tenant', recipientEmail: 'recipient@example.com' },
    });
    assert.strictEqual(res.status, 403);
    const payload = await res.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
  });
});
