import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';
import http from 'node:http';

// Task 7.4 — Integration test for push wiring (Firestore emulator).
//
// Exercises the real `notify` orchestrator
// (backend-runtime/src/deviceAdminService.ts) against a live Firestore emulator
// and proves the TRANSPORT WIRING (Requirements 12.2, 12.3):
//   - a target that carries an `expoPushToken` is routed through the Expo push
//     path (`pushUtils.sendExpoMessages`), and
//   - a target that carries a `webPushSubscription` (and no Expo token) is
//     routed through the web-push path (`webPush.sendWebPushNotification`),
//   - and the call writes EXACTLY ONE `deviceAuditLogs` entry with action
//     'notify' carrying the delivery counts.
//
// The real push transports must not touch the external network in a test, so
// each transport is given a network-free seam:
//   - Expo: `sendExpoMessages` POSTs to `process.env.EXPO_PUSH_ENDPOINT`. We
//     point that at a local loopback HTTP stub that records the request and
//     returns an "ok" receipt. Observing the stub receive the seeded Expo token
//     proves the Expo path was invoked (without any real Expo network call).
//   - Web push: `sendWebPushNotification` short-circuits with
//     `web_push_not_configured` when VAPID credentials are absent — a graceful,
//     network-free failure. That error code is emitted ONLY from the web-push
//     branch, so seeing it on the web target proves the web-push path was taken.
//
// Like the sibling emulator suites (deviceForceLogout / deviceAuditLog), this
// talks to real Firestore only through the emulator. Running the mutation
// against production Firestore would be a destructive side effect, so
// `FIRESTORE_EMULATOR_HOST` is a HARD precondition: when unset the suite skips
// entirely rather than touching a live datastore.

const require = createRequire(import.meta.url);

const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const HAS_EMULATOR = EMULATOR_HOST.length > 0;
const skip = HAS_EMULATOR
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

// Pin a deterministic emulator project id (overridable) before any backend code
// initializes the Admin SDK, matching the sibling emulator suites so the seeder
// and the orchestrator share one namespace.
if (HAS_EMULATOR) {
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-device-console';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
  // Force the web-push transport to short-circuit with `web_push_not_configured`
  // (a network-free graceful failure) instead of dialing a real push service:
  // strip any ambient VAPID credentials before the module configures itself.
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_VAPID_SUBJECT;
}

describe('notify push wiring (Requirements 12.2, 12.3)', { skip }, () => {
  // Exercise the exact production code path via the built output (matches the
  // `../dist/*.js` import convention used by the sibling `*.test.mjs` suites).
  let notify;
  let DEVICE_AUDIT_LOG_COLLECTION;
  let getFirestore;
  let db;

  // Local loopback stub standing in for the Expo push endpoint.
  let expoStub;
  const expoRequests = [];

  function startExpoStub() {
    return new Promise((resolve) => {
      expoStub = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          const messages = Array.isArray(parsed) ? parsed : [parsed];
          expoRequests.push(...messages);
          // Mirror the Expo push API success shape: one `ok` receipt per message.
          const data = messages.map((_, i) => ({ status: 'ok', id: `stub-receipt-${i}` }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data }));
        });
      });
      expoStub.listen(0, '127.0.0.1', () => resolve(expoStub.address().port));
    });
  }

  before(async () => {
    const port = await startExpoStub();
    // Read at call time by `sendExpoMessages`, so setting it before `notify`
    // reroutes the Expo transport to the loopback stub.
    process.env.EXPO_PUSH_ENDPOINT = `http://127.0.0.1:${port}/push`;

    ({ notify, DEVICE_AUDIT_LOG_COLLECTION } = await import('../dist/deviceAdminService.js'));
    // Seed and read back through the SAME Firestore client the orchestrator uses.
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    db = getFirestore();
  });

  after(async () => {
    if (expoStub) {
      await new Promise((resolve) => expoStub.close(resolve));
    }
    // Best-effort teardown of the default Admin app so the process can exit.
    try {
      await require('firebase-admin').app().delete();
    } catch {
      // ignore teardown failures
    }
  });

  // Seed an active, in-tenant device carrying the requested push channel.
  // `tenantIds`/`activeTenantId` satisfy the orchestrator's tenant-scope check.
  async function seedDevice({ tenantId, email, deviceId, expoPushToken, webPushSubscription }) {
    const deviceRef = db
      .collection('user_devices')
      .doc(email)
      .collection('devices')
      .doc(deviceId);
    await deviceRef.set({
      deviceId,
      deviceType: expoPushToken ? 'mobile' : 'web',
      deviceName: expoPushToken ? 'Seed iPhone' : 'Seed Chrome on macOS',
      ownerEmail: email,
      tenantIds: [tenantId],
      activeTenantId: tenantId,
      isDeleted: false,
      isOnline: true,
      sessionActive: true,
      ...(expoPushToken ? { expoPushToken, pushTokenStatus: 'synced' } : {}),
      ...(webPushSubscription ? { webPushSubscription } : {}),
    });
    await db.collection('user_devices').doc(email).set({ totalDevices: 1 }, { merge: true });
    return deviceRef;
  }

  it(
    'routes an Expo-token target through the Expo path and a web-subscription target through the web-push path, writing one notify audit entry',
    async () => {
      const stamp = Date.now();
      const tenantId = `tenant-notify-${stamp}`;
      const actor = { id: 'admin-uid-1', email: 'ops@example.com', name: 'Ops Admin' };
      const title = 'Console broadcast';
      const body = 'Please re-authenticate your session.';

      // Representative example #1: Expo-token target.
      const expoEmail = `expo-owner-${stamp}@example.com`;
      const expoDeviceId = `expo-device-${stamp}`;
      const expoToken = `ExponentPushToken[notify-${stamp}]`;

      // Representative example #2: web-push-subscription target (no Expo token).
      const webEmail = `web-owner-${stamp}@example.com`;
      const webDeviceId = `web-device-${stamp}`;
      const webSubscription = {
        endpoint: `https://push.example.com/sub/${stamp}`,
        expirationTime: null,
        keys: { p256dh: 'seed-p256dh-key', auth: 'seed-auth-key' },
      };

      await seedDevice({ tenantId, email: expoEmail, deviceId: expoDeviceId, expoPushToken: expoToken });
      await seedDevice({ tenantId, email: webEmail, deviceId: webDeviceId, webPushSubscription: webSubscription });

      const targets = [
        { email: expoEmail, deviceId: expoDeviceId },
        { email: webEmail, deviceId: webDeviceId },
      ];

      // Act: run the real orchestrator against the emulator.
      const result = await notify({ tenantId, title, body, targets, actor });

      // --- Shape: one outcome per seeded target (Requirement 12.5) ---
      assert.strictEqual(result.ok, true, 'notify should resolve ok');
      assert.strictEqual(result.results.length, targets.length, 'one outcome per target');

      const expoOutcome = result.results.find((r) => r.deviceId === expoDeviceId);
      const webOutcome = result.results.find((r) => r.deviceId === webDeviceId);
      assert.ok(expoOutcome, 'an outcome for the Expo target should be present');
      assert.ok(webOutcome, 'an outcome for the web-push target should be present');

      // --- Assertion 1: the Expo path was invoked (Requirement 12.2) ---
      // The loopback stub received exactly the seeded Expo token — proving the
      // Expo transport (sendExpoMessages) carried this target, not the web path.
      assert.strictEqual(expoRequests.length, 1, 'exactly one Expo push message should be sent');
      assert.strictEqual(expoRequests[0].to, expoToken, 'Expo message should carry the seeded token');
      assert.strictEqual(expoRequests[0].title, title, 'Expo message should carry the notification title');
      assert.strictEqual(expoRequests[0].body, body, 'Expo message should carry the notification body');
      assert.strictEqual(expoOutcome.ok, true, 'the Expo target should be delivered via the Expo path');

      // --- Assertion 2: the web-push path was invoked (Requirement 12.3) ---
      // `web_push_not_configured` is emitted ONLY from the web-push branch, so
      // its presence on the web target proves the web-push transport was called
      // (and did so without any real network egress). The seeded web endpoint
      // never appears among the Expo requests, confirming no cross-routing.
      assert.strictEqual(webOutcome.ok, false, 'the web target uses the (unconfigured) web-push path');
      assert.strictEqual(
        webOutcome.error,
        'web_push_not_configured',
        'the web target should be routed through the web-push transport',
      );
      assert.ok(
        !expoRequests.some((m) => m.to === webSubscription.endpoint),
        'the web target must not be routed through the Expo transport',
      );

      // --- Assertion 3: EXACTLY ONE notify audit entry with delivery counts ---
      // The tenant id is unique to this run, so scoping the query to it isolates
      // the entry written by this action.
      const auditQuery = await db
        .collection(DEVICE_AUDIT_LOG_COLLECTION)
        .where('tenantId', '==', tenantId)
        .get();
      const notifyEntries = auditQuery.docs
        .map((docSnap) => docSnap.data())
        .filter((entry) => entry.action === 'notify');
      assert.strictEqual(notifyEntries.length, 1, 'exactly one notify audit entry should be written');

      const audit = notifyEntries[0];
      assert.strictEqual(audit.tenantId, tenantId, 'audit entry should be scoped to the tenant');
      assert.strictEqual(audit.actorEmail, actor.email, 'audit entry should attribute the actor');
      // One Expo success + one (unconfigured) web-push failure => partial outcome.
      assert.strictEqual(audit.affectedCount, 1, 'audit affectedCount should equal successful deliveries');
      assert.strictEqual(audit.outcome, 'partial', 'audit outcome should reflect the mixed result');
      assert.ok(audit.metadata, 'audit entry should carry delivery-count metadata');
      assert.strictEqual(audit.metadata.successful, 1, 'metadata should record one successful delivery');
      assert.strictEqual(audit.metadata.failed, 1, 'metadata should record one failed delivery');
      assert.strictEqual(audit.metadata.total, targets.length, 'metadata should record the target total');
      assert.strictEqual(typeof audit.actionTimeMs, 'number', 'audit entry should carry actionTimeMs');
      assert.strictEqual(typeof audit.createdAt, 'string', 'audit entry should carry an ISO createdAt');

      // Mirror the returned counts against the persisted audit metadata.
      assert.strictEqual(result.successful, 1, 'result should report one successful delivery');
      assert.strictEqual(result.failed, 1, 'result should report one failed delivery');
    },
  );
});
