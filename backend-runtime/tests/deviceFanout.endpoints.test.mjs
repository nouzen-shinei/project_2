import assert from 'assert';
import { describe, it, before, after, afterEach } from 'node:test';
import crypto from 'crypto';
import { createRequire } from 'module';

// device-push-fanout-migration, Task 4.2 — Fanout_Endpoint tests.
//
// Drives the REAL Express app (createApp) via HTTP + fetch and asserts the
// authorization + validation + response-contract behavior of
// `POST /notifications/fanout` (design "Components §1 Fanout_Endpoint" +
// "§3 Fanout_Authorization"):
//   - missing/invalid internal token -> 401 (global auth middleware; Req 5.1),
//   - authenticated NON-member sender -> 403 and NO device resolution (Req 5.2),
//   - member sender -> allowed; the success body carries EXACTLY the ten
//     DeviceNotificationFanoutResult count fields and no push tokens, web-push
//     endpoints, or device network metadata (Req 5.4),
//   - `data.type === 'team_membership_change'` from a member-only sender ->
//     403 insufficient_role, and from a staff sender -> allowed (Req 5.5),
//   - a malformed body -> 400 validation_failed (Req 1.4),
//   - a tenantId mismatch between body and guard -> 403 tenant_mismatch.
//
// Like the sibling emulator suites (deviceNotify / deviceForceLogout), the
// authorized paths run the REAL `deviceFanoutService.fanout` against a live
// Firestore emulator, so `FIRESTORE_EMULATOR_HOST` is a HARD precondition: when
// it is unset the suite skips entirely rather than touching a live datastore.
// The tenant membership guard is stubbed via the `requireTenantMembershipAccess`
// override (mirroring `tenantPushNotifications.test.mjs`) to control the sender's
// role, and a thin `deviceFanout` spy wraps the real fan-out so we can assert it
// is NEVER reached for a rejected request (proving no recipient devices are
// resolved for an unauthorized caller — Req 5.2).

const require = createRequire(import.meta.url);

const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const HAS_EMULATOR = EMULATOR_HOST.length > 0;
const skip = HAS_EMULATOR
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

// Pin a deterministic emulator project id (overridable) before any backend code
// initializes the Admin SDK, matching the sibling emulator suites so the seeder
// and the fan-out share one namespace.
if (HAS_EMULATOR) {
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-device-console';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
  process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'device-fanout-secret';
  // Belt-and-braces: if a seeded device were ever routed to web-push, force the
  // transport to short-circuit with a network-free graceful failure instead of
  // dialing a real push service. (The authorized tests below seed no push
  // channels, so no transport is exercised at all.)
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_VAPID_SUBJECT;
}

// The complete, canonical set of keys a serialized Fanout_Result may contain —
// the ten DeviceNotificationFanoutResult counts and NOTHING else (Req 5.4, 6.1).
const FANOUT_RESULT_KEYS = [
  'success',
  'failed',
  'deliverableDeviceCount',
  'onlineDeliverableCount',
  'presenceDeliveredCount',
  'pushAcceptedCount',
  'mobilePushAcceptedCount',
  'webPushAcceptedCount',
  'staleWebPushSubscriptionsCleaned',
  'deduplicatedWebPushSubscriptionsCleaned',
];

// Fields that would leak a recipient's push secrets or device network metadata —
// none may ever appear in the response body (Req 5.4).
const FORBIDDEN_RESPONSE_KEYS = [
  'expoPushToken',
  'fcmToken',
  'apnsToken',
  'webPushSubscription',
  'subscription',
  'endpoint',
  'ipAddress',
  'userAgent',
  'tokens',
  'devices',
];

describe('device fanout endpoint (Requirements 1.3, 1.4, 5.1, 5.2, 5.4, 5.5)', { skip }, () => {
  let createApp;
  let TenantAccessError;
  let getFirestore;
  let realFanout;
  let db;
  const servers = new Set();

  before(async () => {
    ({ createApp, TenantAccessError } = await import('../dist/app.js'));
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    ({ fanout: realFanout } = await import('../dist/deviceFanoutService.js'));
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
    // Best-effort teardown of the default Admin app so the process can exit.
    try {
      await require('firebase-admin').app().delete();
    } catch {
      // ignore teardown failures
    }
  });

  function buildInternalToken({ uid = 'sender-uid', email = 'sender@example.com' } = {}) {
    const payload = { sub: uid, email, exp: Math.floor(Date.now() / 1000) + 300 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', process.env.INTERNAL_API_KEY)
      .update(body)
      .digest('base64url');
    return `${body}.${signature}`;
  }

  // Build the real app with a stubbed tenant membership guard (controls the
  // sender's role) and a `deviceFanout` spy that wraps the REAL fan-out so we can
  // both run it against the emulator AND count invocations.
  async function startServer({ guardImpl } = {}) {
    const fanoutCalls = [];
    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (authContext, tenantIdRaw, options) => {
          const tenantId = (tenantIdRaw || '').trim() || 'tenant-default';
          if (guardImpl) {
            return guardImpl(authContext, tenantId, options);
          }
          return { tenantId, role: 'member', membershipId: `${tenantId}:${authContext?.uid || 'uid'}` };
        },
        // Reject any non-internal token network-free so the "invalid token" case
        // is deterministic (a garbage Bearer token never dials real Firebase).
        verifyFirebaseIdToken: async () => {
          throw new Error('invalid_id_token');
        },
        deviceFanout: async (params) => {
          fanoutCalls.push(params);
          return realFanout(params);
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
    return { base, server, fanoutCalls };
  }

  async function seedDevice(recipientEmail, tenantId, deviceId, extra = {}) {
    await db
      .collection('user_devices')
      .doc(recipientEmail)
      .collection('devices')
      .doc(deviceId)
      .set({
        deviceId,
        ownerEmail: recipientEmail,
        tenantIds: [tenantId],
        activeTenantId: tenantId,
        isDeleted: false,
        isOnline: true,
        ...extra,
      });
  }

  function post(base, { token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${base}/notifications/fanout`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body ?? {}),
    });
  }

  it('rejects a request with no internal token with 401 (Req 5.1)', async () => {
    const { base, fanoutCalls } = await startServer();
    const res = await post(base, {
      body: {
        tenantId: 'tenant-a',
        recipientEmail: 'recipient@example.com',
        notification: { title: 'Hi', body: 'There' },
      },
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(fanoutCalls.length, 0, 'fan-out must not run for an unauthenticated request');
  });

  it('rejects a request with an invalid internal token with 401 (Req 5.1)', async () => {
    const { base, fanoutCalls } = await startServer();
    const res = await post(base, {
      token: 'not-a-valid-internal-token',
      body: {
        tenantId: 'tenant-a',
        recipientEmail: 'recipient@example.com',
        notification: { title: 'Hi', body: 'There' },
      },
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(fanoutCalls.length, 0, 'fan-out must not run for an invalid token');
  });

  it('rejects an authenticated NON-member sender with 403 and resolves no devices (Req 5.2)', async () => {
    const { base, fanoutCalls } = await startServer({
      guardImpl: async () => {
        throw new TenantAccessError(403, { error: 'tenant_membership_required' });
      },
    });
    const res = await post(base, {
      token: buildInternalToken({ uid: 'outsider', email: 'outsider@example.com' }),
      body: {
        tenantId: 'tenant-a',
        recipientEmail: 'recipient@example.com',
        notification: { title: 'Hi', body: 'There', data: { type: 'chat_message' } },
      },
    });
    assert.strictEqual(res.status, 403);
    const payload = await res.json();
    assert.strictEqual(payload.error, 'tenant_membership_required');
    // Req 5.2: no fan-out (and therefore no recipient device resolution) occurs
    // for an unauthorized caller — rejection happens in the guard, before the
    // handler ever reaches the Server_Fanout.
    assert.strictEqual(fanoutCalls.length, 0, 'no push targets may be resolved for a non-member');
  });

  it('allows a member sender and returns exactly the ten counts with no secrets (Req 5.4)', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const tenantId = `tenant-member-${stamp}`;
    const recipient = `recipient-${stamp}@example.com`;
    // Seed an in-tenant device with NO usable push channel so the real fan-out
    // resolves it (proving server-side resolution ran) but delivers nothing —
    // keeping the assertion deterministic and network-free.
    await seedDevice(recipient, tenantId, `dev-${stamp}`, { deviceType: 'mobile' });

    const { base, fanoutCalls } = await startServer({
      guardImpl: async (_auth, tenantIdRaw) => ({
        tenantId: tenantIdRaw,
        role: 'member',
        membershipId: `${tenantIdRaw}:member`,
      }),
    });

    const res = await post(base, {
      token: buildInternalToken({ uid: 'member-uid', email: 'member@example.com' }),
      body: {
        tenantId,
        recipientEmail: recipient,
        notification: { title: 'Hi', body: 'There', data: { type: 'chat_message' } },
      },
    });

    assert.strictEqual(res.status, 200);
    const payload = await res.json();
    assert.strictEqual(fanoutCalls.length, 1, 'a member request reaches the Server_Fanout');

    // The response body contains EXACTLY the ten count fields, all numeric.
    assert.deepStrictEqual(
      Object.keys(payload).sort(),
      [...FANOUT_RESULT_KEYS].sort(),
      'response must carry exactly the ten Fanout_Result count keys'
    );
    for (const key of FANOUT_RESULT_KEYS) {
      assert.strictEqual(typeof payload[key], 'number', `${key} must be a number`);
    }
    // The response must NOT leak any push token, web-push endpoint, or device
    // network metadata (Req 5.4).
    for (const forbidden of FORBIDDEN_RESPONSE_KEYS) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(payload, forbidden),
        `response must not include a "${forbidden}" field`
      );
    }
  });

  it('rejects team_membership_change from a member-only sender with 403 insufficient_role (Req 5.5)', async () => {
    const { base, fanoutCalls } = await startServer({
      guardImpl: async (_auth, tenantIdRaw) => ({
        tenantId: tenantIdRaw,
        role: 'member',
        membershipId: `${tenantIdRaw}:member`,
      }),
    });

    const res = await post(base, {
      token: buildInternalToken({ uid: 'member-uid', email: 'member@example.com' }),
      body: {
        tenantId: 'tenant-elevated',
        recipientEmail: 'recipient@example.com',
        notification: { title: 'Team update', body: 'Roster changed', data: { type: 'team_membership_change' } },
      },
    });

    assert.strictEqual(res.status, 403);
    const payload = await res.json();
    assert.strictEqual(payload.error, 'insufficient_role');
    // Req 5.2/5.5: the elevated-type role check rejects BEFORE any resolution.
    assert.strictEqual(fanoutCalls.length, 0, 'no resolution for an under-privileged elevated-type caller');
  });

  it('allows team_membership_change from a staff sender (Req 5.5)', async () => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const tenantId = `tenant-staff-${stamp}`;
    const { base, fanoutCalls } = await startServer({
      guardImpl: async (_auth, tenantIdRaw) => ({
        tenantId: tenantIdRaw,
        role: 'staff',
        membershipId: `${tenantIdRaw}:staff`,
      }),
    });

    const res = await post(base, {
      token: buildInternalToken({ uid: 'staff-uid', email: 'staff@example.com' }),
      body: {
        // No recipient devices are seeded, so the real fan-out resolves an empty
        // device set and returns all-zero counts network-free.
        tenantId,
        recipientEmail: `recipient-${stamp}@example.com`,
        notification: { title: 'Team update', body: 'Roster changed', data: { type: 'team_membership_change' } },
      },
    });

    assert.strictEqual(res.status, 200);
    const payload = await res.json();
    assert.strictEqual(fanoutCalls.length, 1, 'a staff request reaches the Server_Fanout for an elevated type');
    assert.deepStrictEqual(
      Object.keys(payload).sort(),
      [...FANOUT_RESULT_KEYS].sort(),
      'response must carry exactly the ten Fanout_Result count keys'
    );
  });

  it('rejects a malformed body with 400 validation_failed before resolving devices (Req 1.4)', async () => {
    const { base, fanoutCalls } = await startServer();
    const res = await post(base, {
      token: buildInternalToken(),
      body: {
        // A valid tenantId lets the request pass the tenant guard so the handler
        // reaches schema validation; `notification` is intentionally omitted.
        tenantId: 'tenant-a',
        recipientEmail: 'recipient@example.com',
      },
    });
    assert.strictEqual(res.status, 400);
    const payload = await res.json();
    assert.strictEqual(payload.error, 'validation_failed');
    assert.ok(Array.isArray(payload.issues), 'validation errors should be reported');
    assert.strictEqual(fanoutCalls.length, 0, 'no resolution for a malformed request');
  });

  it('rejects a tenantId mismatch between body and guard with 403 tenant_mismatch', async () => {
    const { base, fanoutCalls } = await startServer({
      guardImpl: async () => ({
        tenantId: 'tenant-actual',
        role: 'member',
        membershipId: 'tenant-actual:member',
      }),
    });
    const res = await post(base, {
      token: buildInternalToken(),
      body: {
        tenantId: 'wrong-tenant',
        recipientEmail: 'recipient@example.com',
        notification: { title: 'Hi', body: 'There' },
      },
    });
    assert.strictEqual(res.status, 403);
    const payload = await res.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(fanoutCalls.length, 0, 'no resolution when the body tenant does not match the guard');
  });
});
