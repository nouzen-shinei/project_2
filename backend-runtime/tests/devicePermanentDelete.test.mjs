import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Task 6.5 — Integration test for permanent-delete atomicity (Firestore emulator).
//
// Exercises the real `permanentDelete` orchestrator
// (backend-runtime/src/deviceAdminService.ts) against a live Firestore emulator
// and asserts the end-to-end effect of a permanent deletion (Requirements 10.1,
// 10.6):
//   - HAPPY PATH (Req 10.1): the device doc and its related `logout_signals`
//     doc are both removed in a single atomic batch, the parent
//     `user_devices/{email}` counter is decremented, and EXACTLY ONE
//     `permanent_delete` `deviceAuditLogs` entry is written.
//   - NOT-FOUND / no-op safety (Req 10.6): a mid-transaction failure against the
//     real emulator is hard to inject, so instead we assert the closely related
//     "reject before any write" guarantee — calling `permanentDelete` for a
//     device that does not exist rejects with `DeviceNotFoundError` and writes
//     NOTHING (no audit entry, no counter mutation). Full injected-failure
//     rollback (the batch rolls back all-or-nothing on a mid-op commit failure)
//     is covered by the unit property test 6.4
//     (deviceAdminService permanent-delete atomicity, design Property 17).
//
// Like the sibling `deviceForceLogout.test.mjs` / `deviceAuditLog.test.mjs`
// suites, this talks to real Firestore only through the emulator. Running the
// destructive deletion against production Firestore would be a real side effect,
// so `FIRESTORE_EMULATOR_HOST` is treated as a HARD precondition: when it is
// unset the suite skips entirely rather than touching a live datastore.

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
}

describe('permanentDelete atomicity (Requirements 10.1, 10.6)', { skip }, () => {
  // Exercise the exact production code path via the built output (matches the
  // `../dist/*.js` import convention used by the sibling `*.test.mjs` suites).
  let permanentDelete;
  let DeviceNotFoundError;
  let DEVICE_AUDIT_LOG_COLLECTION;
  let getFirestore;
  let db;

  before(async () => {
    ({ permanentDelete, DeviceNotFoundError, DEVICE_AUDIT_LOG_COLLECTION } = await import(
      '../dist/deviceAdminService.js'
    ));
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
  // plus its parent counter doc, directly via the admin client. Tagged to
  // `tenantId` (via `tenantIds`) so the orchestrator's tenant-scope assertion
  // passes. `totalDevices` is seeded above 1 so we can prove the decrement.
  async function seedDeviceWithParent({ tenantId, email, deviceId, totalDevices }) {
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
      lastSeen: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
    });
    // Parent doc mirrors production layout and holds the device counter.
    await db.collection('user_devices').doc(email).set({ totalDevices }, { merge: true });
    return deviceRef;
  }

  it(
    'removes the device doc and its logout signal, decrements the parent counter, and writes exactly one permanent_delete audit entry',
    async () => {
      const stamp = Date.now();
      const tenantId = `tenant-perm-delete-${stamp}`;
      const email = `owner-${stamp}@example.com`;
      const deviceId = `device-${stamp}`;
      const actor = { id: 'admin-uid-1', email: 'ops@example.com', name: 'Ops Admin' };
      const reason = 'Permanent-delete atomicity integration coverage';
      const seededTotal = 3;

      const deviceRef = await seedDeviceWithParent({
        tenantId,
        email,
        deviceId,
        totalDevices: seededTotal,
      });

      // Seed a related tracking record: an existing logout signal for the pair
      // that permanentDelete must remove alongside the device (Req 10.1).
      const signalRef = db.collection('logout_signals').doc(`${email}_${deviceId}`);
      await signalRef.set({
        userEmail: email,
        deviceId,
        consumed: false,
        reason: 'pre-existing signal',
      });

      // Act: run the real orchestrator against the emulator.
      const result = await permanentDelete({ tenantId, email, deviceId, actor, reason });
      assert.deepStrictEqual(result, { ok: true }, 'permanentDelete should resolve { ok: true }');

      // --- Assertion 1: the device doc is gone (Req 10.1) ---
      const deviceSnap = await deviceRef.get();
      assert.strictEqual(deviceSnap.exists, false, 'the device doc should be removed');

      // --- Assertion 2: the related logout signal doc is gone (Req 10.1) ---
      const signalSnap = await signalRef.get();
      assert.strictEqual(signalSnap.exists, false, 'the related logout signal doc should be removed');

      // --- Assertion 3: the parent counter was decremented atomically ---
      const parentSnap = await db.collection('user_devices').doc(email).get();
      assert.strictEqual(parentSnap.exists, true, 'the parent user_devices doc should still exist');
      assert.strictEqual(
        parentSnap.data().totalDevices,
        seededTotal - 1,
        'the parent totalDevices counter should be decremented by one',
      );

      // --- Assertion 4: EXACTLY ONE permanent_delete audit entry (Req 10.3) ---
      // The tenant id is unique to this run, so scoping the query to it isolates
      // the entry written by this action.
      const auditQuery = await db
        .collection(DEVICE_AUDIT_LOG_COLLECTION)
        .where('tenantId', '==', tenantId)
        .get();
      const permanentDeleteEntries = auditQuery.docs
        .map((docSnap) => docSnap.data())
        .filter((entry) => entry.action === 'permanent_delete');
      assert.strictEqual(
        permanentDeleteEntries.length,
        1,
        'exactly one permanent_delete audit entry should be written',
      );
      const audit = permanentDeleteEntries[0];
      assert.strictEqual(audit.tenantId, tenantId, 'audit entry should be scoped to the tenant');
      assert.strictEqual(audit.targetDeviceId, deviceId, 'audit entry should target the device');
      assert.strictEqual(audit.targetUserEmail, email, 'audit entry should record the target user');
      assert.strictEqual(audit.actorEmail, actor.email, 'audit entry should attribute the actor');
      assert.strictEqual(audit.reason, reason, 'audit entry should carry the supplied reason');
      assert.strictEqual(typeof audit.actionTimeMs, 'number', 'audit entry should carry actionTimeMs');
      assert.strictEqual(typeof audit.createdAt, 'string', 'audit entry should carry an ISO createdAt');
    },
  );

  it(
    'rejects a permanent delete for a non-existent device with DeviceNotFoundError and writes nothing (Req 10.6 no-op safety)',
    async () => {
      const stamp = Date.now();
      // A tenant/email/device that were never seeded: nothing exists to remove.
      const tenantId = `tenant-missing-${stamp}`;
      const email = `ghost-${stamp}@example.com`;
      const deviceId = `missing-device-${stamp}`;
      const actor = { id: 'admin-uid-2', email: 'ops@example.com', name: 'Ops Admin' };
      const reason = 'Attempt to permanently delete a missing device';

      // Act + assert: the missing device is rejected BEFORE any write.
      await assert.rejects(
        permanentDelete({ tenantId, email, deviceId, actor, reason }),
        (err) => {
          assert.ok(
            err instanceof DeviceNotFoundError,
            'should reject with a DeviceNotFoundError',
          );
          assert.strictEqual(err.code, 'device_not_found', 'error code should be device_not_found');
          return true;
        },
      );

      // --- Assertion: NOTHING was written — no audit entry for this tenant ---
      const auditQuery = await db
        .collection(DEVICE_AUDIT_LOG_COLLECTION)
        .where('tenantId', '==', tenantId)
        .get();
      assert.strictEqual(
        auditQuery.empty,
        true,
        'a rejected permanent delete must not write any audit entry',
      );

      // --- Assertion: no parent counter doc was fabricated for the ghost user ---
      const parentSnap = await db.collection('user_devices').doc(email).get();
      assert.strictEqual(
        parentSnap.exists,
        false,
        'a rejected permanent delete must not create the parent user_devices doc',
      );
    },
  );
});
