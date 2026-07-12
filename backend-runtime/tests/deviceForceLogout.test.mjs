import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Task 4.4 — Integration test for force-logout end-to-end (Firestore emulator).
//
// Exercises the real `forceLogout` orchestrator
// (backend-runtime/src/deviceAdminService.ts) against a live Firestore emulator
// and asserts the full end-to-end effect of a single-device force logout
// (Requirements 7.1, 7.4):
//   - a Force_Logout_Signal doc is (re)created UNCONSUMED at
//     `logout_signals/{email}_{deviceId}` (consumed === false), so the on-device
//     runtime will pick it up on its next poll (Req 7.1);
//   - EXACTLY ONE `deviceAuditLogs` entry with action === 'force_logout' is
//     written, attributed to the acting admin and target device (Req 7.4);
//   - the device doc carries the `forcedLogout*` provenance and its live
//     presence is torn down (isOnline === false).
//
// Like the sibling `deviceAuditLog.test.mjs`, this suite talks to real Firestore
// only through the emulator. Running the mutation against production Firestore
// would be a destructive side effect, so `FIRESTORE_EMULATOR_HOST` is treated as
// a HARD precondition: when it is unset the suite skips entirely rather than
// touching a live datastore.

const require = createRequire(import.meta.url);

const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const HAS_EMULATOR = EMULATOR_HOST.length > 0;
const skip = HAS_EMULATOR
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

// Pin a deterministic emulator project id (overridable) before any backend code
// initializes the Admin SDK, matching the sibling emulator suite so the seeder
// and the orchestrator share one namespace.
if (HAS_EMULATOR) {
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-device-console';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
}

describe('forceLogout end-to-end (Requirements 7.1, 7.4)', { skip }, () => {
  // Exercise the exact production code path via the built output (matches the
  // `../dist/*.js` import convention used by the sibling `*.test.mjs` suites).
  let forceLogout;
  let DEVICE_AUDIT_LOG_COLLECTION;
  let getFirestore;
  let db;

  before(async () => {
    ({ forceLogout, DEVICE_AUDIT_LOG_COLLECTION } = await import('../dist/deviceAdminService.js'));
    // Seed and read back through the SAME Firestore client the orchestrator uses
    // (the default Admin app initialized by `firebaseAdmin`), so we observe the
    // persisted state the production write produced.
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    db = getFirestore();
  });

  after(async () => {
    // Best-effort teardown of the default Admin app so the process can exit.
    try {
      await require('firebase-admin').app().delete();
    } catch {
      // ignore teardown failures
    }
  });

  // Seed a single active, in-tenant device at `user_devices/{email}/devices/{id}`
  // directly via the admin client. Tagged to `tenantId` (via `tenantIds`) so the
  // orchestrator's tenant-scope assertion passes; `isOnline: true` /
  // `sessionActive: true` / no prior logout provenance so we can prove the
  // force-logout transition.
  async function seedActiveDevice({ tenantId, email, deviceId }) {
    const deviceRef = db
      .collection('user_devices')
      .doc(email)
      .collection('devices')
      .doc(deviceId);
    await deviceRef.set({
      deviceId,
      deviceType: 'web',
      deviceName: 'Seed Chrome on macOS',
      ownerEmail: email,
      tenantIds: [tenantId],
      activeTenantId: tenantId,
      isDeleted: false,
      isOnline: true,
      sessionActive: true,
      expoPushToken: 'ExponentPushToken[seed-token]',
      pushTokenStatus: 'synced',
      lastSeen: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
    });
    // Parent doc (mirrors production layout; force logout merges lastActivity).
    await db.collection('user_devices').doc(email).set({ totalDevices: 1 }, { merge: true });
    return deviceRef;
  }

  it(
    'creates an unconsumed logout signal, one force_logout audit entry, and force-logout provenance on the device',
    async () => {
      const stamp = Date.now();
      const tenantId = `tenant-force-logout-${stamp}`;
      const email = `owner-${stamp}@example.com`;
      const deviceId = `device-${stamp}`;
      const actor = { id: 'admin-uid-1', email: 'ops@example.com', name: 'Ops Admin' };
      const reason = 'Force-logout end-to-end integration coverage';

      const deviceRef = await seedActiveDevice({ tenantId, email, deviceId });

      // Act: run the real orchestrator against the emulator.
      const result = await forceLogout({ tenantId, email, deviceId, actor, reason });
      assert.deepStrictEqual(result, { ok: true }, 'forceLogout should resolve { ok: true }');

      // --- Assertion 1: an UNCONSUMED force-logout signal exists (Req 7.1) ---
      const signalSnap = await db
        .collection('logout_signals')
        .doc(`${email}_${deviceId}`)
        .get();
      assert.strictEqual(signalSnap.exists, true, 'a logout signal doc should exist for the pair');
      const signal = signalSnap.data();
      assert.strictEqual(signal.consumed, false, 'the logout signal must be unconsumed');
      assert.strictEqual(signal.userEmail, email, 'signal should record the target user email');
      assert.strictEqual(signal.deviceId, deviceId, 'signal should record the target device id');
      assert.strictEqual(signal.adminEmail, actor.email, 'signal should attribute the acting admin');
      assert.strictEqual(signal.reason, reason, 'signal should carry the supplied reason');

      // --- Assertion 2: EXACTLY ONE force_logout audit entry (Req 7.4) ---
      // The tenant id is unique to this run, so scoping the query to it isolates
      // the entry written by this action.
      const auditQuery = await db
        .collection(DEVICE_AUDIT_LOG_COLLECTION)
        .where('tenantId', '==', tenantId)
        .get();
      const forceLogoutEntries = auditQuery.docs
        .map((docSnap) => docSnap.data())
        .filter((entry) => entry.action === 'force_logout');
      assert.strictEqual(
        forceLogoutEntries.length,
        1,
        'exactly one force_logout audit entry should be written',
      );
      const audit = forceLogoutEntries[0];
      assert.strictEqual(audit.tenantId, tenantId, 'audit entry should be scoped to the tenant');
      assert.strictEqual(audit.targetDeviceId, deviceId, 'audit entry should target the device');
      assert.strictEqual(audit.targetUserEmail, email, 'audit entry should record the target user');
      assert.strictEqual(audit.actorEmail, actor.email, 'audit entry should attribute the actor');
      assert.strictEqual(typeof audit.actionTimeMs, 'number', 'audit entry should carry actionTimeMs');
      assert.strictEqual(typeof audit.createdAt, 'string', 'audit entry should carry an ISO createdAt');

      // --- Assertion 3: device force-logout provenance + torn-down presence ---
      const deviceSnap = await deviceRef.get();
      assert.strictEqual(deviceSnap.exists, true, 'device doc should still exist after force logout');
      const device = deviceSnap.data();
      assert.strictEqual(device.isOnline, false, 'device should be marked offline');
      assert.strictEqual(device.sessionActive, false, 'device session should be inactive');
      assert.strictEqual(device.logoutSignal, true, 'device should carry the logoutSignal flag');
      assert.strictEqual(device.logoutType, 'forced', 'device logoutType should be forced');
      assert.strictEqual(
        device.lastActivityType,
        'forced_logout',
        'device lastActivityType should be forced_logout',
      );
      assert.strictEqual(device.forcedLogoutBy, actor.email, 'device should record who forced the logout');
      assert.strictEqual(
        device.forcedLogoutByName,
        actor.name,
        'device should record the actor display name',
      );
      assert.strictEqual(
        device.forcedLogoutReason,
        reason,
        'device should record the force-logout reason',
      );
      assert.ok(device.forcedLogoutAt, 'device should record a forcedLogoutAt timestamp');
    },
  );
});
