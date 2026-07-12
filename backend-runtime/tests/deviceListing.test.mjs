import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Integration test for the `listTenantDevices` read model (Firestore emulator).
//
// Exercises the real `listTenantDevices` orchestrator
// (backend-runtime/src/deviceAdminService.ts) against a live Firestore emulator
// and locks in the behavior of its performance refactor (a single
// `collectionGroup('devices')` read + one `user_devices` read for owner
// attribution, replacing the previous per-user N+1 reads). It proves that for a
// seeded population spanning multiple users and tenants the listing returns
// EXACTLY the in-tenant devices, with the correct owner attribution and ban
// state (Requirements 1.2, 3.1; design Property 3):
//   - in-tenant devices matched via `tenantIds`, `activeTenantId`, and an active
//     `tenantMemberships` entry are all returned;
//   - a cross-tenant device and an unscoped (untagged) device are excluded;
//   - `ownerEmail` is the parent `user_devices/{email}` doc id and
//     `ownerDisplayName` is resolved from the parent doc (null when absent);
//   - a device whose derived fingerprint matches an active `device_bans` record
//     is reported with `isHardBanned === true`.
//
// Like the sibling emulator suites (deviceForceLogout / deviceNotify /
// deviceAuditLog), this talks to real Firestore only through the emulator.
// Reading/scanning production Firestore would be inappropriate, so
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
}

describe('listTenantDevices tenant-scoped listing (Requirements 1.2, 3.1)', { skip }, () => {
  // Exercise the exact production code path via the built output (matches the
  // `../dist/*.js` import convention used by the sibling `*.test.mjs` suites).
  let listTenantDevices;
  let DEVICE_BANS_COLLECTION;
  let getFirestore;
  let db;

  before(async () => {
    ({ listTenantDevices, DEVICE_BANS_COLLECTION } = await import('../dist/deviceAdminService.js'));
    // Seed and read back through the SAME Firestore client the orchestrator uses
    // (the default Admin app initialized by `firebaseAdmin`), so we observe the
    // persisted state the production read will scan.
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

  // Seed a device doc at `user_devices/{email}/devices/{deviceId}` with the
  // supplied tenant tagging + extra fields, then merge the parent doc (which
  // supplies owner attribution: the doc id is the email, `displayName` the name).
  async function seedDevice({ email, deviceId, parent, device }) {
    await db
      .collection('user_devices')
      .doc(email)
      .collection('devices')
      .doc(deviceId)
      .set({ deviceId, ...device });
    await db.collection('user_devices').doc(email).set(parent, { merge: true });
  }

  it(
    'returns exactly the in-tenant devices with correct owner attribution and ban state',
    async () => {
      const stamp = Date.now();
      const tenantId = `tenant-listing-${stamp}`;
      const otherTenantId = `tenant-other-${stamp}`;

      // Owners (unique per run so the run is isolated within the shared emulator).
      const emailA = `owner-a-${stamp}@example.com`;
      const emailB = `owner-b-${stamp}@example.com`;
      const emailC = `owner-c-${stamp}@example.com`;
      const emailD = `owner-d-${stamp}@example.com`;

      // Device ids.
      const deviceA1 = `dev-a1-${stamp}`; // in-tenant via tenantIds + hard banned
      const deviceA2 = `dev-a2-${stamp}`; // in-tenant via activeTenantId
      const deviceB1 = `dev-b1-${stamp}`; // in-tenant via active membership; no display name
      const deviceC1 = `dev-c1-${stamp}`; // cross-tenant → excluded
      const deviceD1 = `dev-d1-${stamp}`; // unscoped/untagged → excluded

      // A unique fingerprint carried by deviceA1 and matched by an active ban.
      const bannedFingerprint = `seed-fp-${stamp}`;

      // Owner A: parent doc WITH a display name; two in-tenant devices.
      await seedDevice({
        email: emailA,
        deviceId: deviceA1,
        parent: { totalDevices: 2, displayName: 'Alice Anderson' },
        device: {
          deviceType: 'web',
          deviceName: 'Alice Chrome',
          tenantIds: [tenantId],
          deviceSeedHash: bannedFingerprint,
        },
      });
      await seedDevice({
        email: emailA,
        deviceId: deviceA2,
        parent: { totalDevices: 2, displayName: 'Alice Anderson' },
        device: {
          deviceType: 'mobile',
          deviceName: 'Alice iPhone',
          activeTenantId: tenantId,
        },
      });

      // Owner B: parent doc WITHOUT a display name; one in-tenant device via an
      // active tenant membership entry.
      await seedDevice({
        email: emailB,
        deviceId: deviceB1,
        parent: { totalDevices: 1 },
        device: {
          deviceType: 'tablet',
          deviceName: 'Bob iPad',
          tenantMemberships: [{ tenantId, role: 'member', status: 'active' }],
        },
      });

      // Owner C: a device belonging to a DIFFERENT tenant → must be excluded.
      await seedDevice({
        email: emailC,
        deviceId: deviceC1,
        parent: { totalDevices: 1, displayName: 'Carol Cross' },
        device: {
          deviceType: 'web',
          deviceName: 'Carol Firefox',
          tenantIds: [otherTenantId],
          activeTenantId: otherTenantId,
        },
      });

      // Owner D: an unscoped/untagged device (no tenant metadata) → must be
      // excluded (untagged devices are not associated with any specific tenant).
      await seedDevice({
        email: emailD,
        deviceId: deviceD1,
        parent: { totalDevices: 1, displayName: 'Dave Detached' },
        device: {
          deviceType: 'web',
          deviceName: 'Dave Safari',
        },
      });

      // An active hard ban whose fingerprint matches deviceA1's deviceSeedHash.
      await db.collection(DEVICE_BANS_COLLECTION).add({
        banType: 'hard',
        deviceFingerprint: bannedFingerprint,
        isActive: true,
        reason: 'Listing integration coverage',
        adminEmail: 'ops@example.com',
        targetDeviceId: deviceA1,
        targetUserEmail: emailA,
        createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
      });

      // Act: run the real read model against the emulator.
      const records = await listTenantDevices(tenantId);

      // The tenant id is unique to this run, so every returned record is one of
      // the three we seeded in-tenant (the shared emulator holds other tenants'
      // devices, but none match this tenant id).
      const byId = new Map(records.map((r) => [r.deviceId, r]));

      // --- Exactly the three in-tenant devices are returned ---
      const returnedIds = records.map((r) => r.deviceId).sort();
      assert.deepStrictEqual(
        returnedIds,
        [deviceA1, deviceA2, deviceB1].sort(),
        'listing should return exactly the three in-tenant devices',
      );
      assert.strictEqual(byId.has(deviceC1), false, 'the cross-tenant device must be excluded');
      assert.strictEqual(byId.has(deviceD1), false, 'the unscoped device must be excluded');

      // --- deviceA1: owner attribution + hard-ban state via fingerprint ---
      const a1 = byId.get(deviceA1);
      assert.ok(a1, 'deviceA1 should be present');
      assert.strictEqual(a1.ownerEmail, emailA, 'deviceA1 ownerEmail should be the parent doc id');
      assert.strictEqual(
        a1.ownerDisplayName,
        'Alice Anderson',
        'deviceA1 ownerDisplayName should come from the parent doc',
      );
      assert.strictEqual(
        a1.isHardBanned,
        true,
        'deviceA1 should be hard banned via its active-ban fingerprint',
      );

      // --- deviceA2: same owner, matched via activeTenantId, not banned ---
      const a2 = byId.get(deviceA2);
      assert.ok(a2, 'deviceA2 should be present');
      assert.strictEqual(a2.ownerEmail, emailA, 'deviceA2 ownerEmail should be the parent doc id');
      assert.strictEqual(
        a2.ownerDisplayName,
        'Alice Anderson',
        'deviceA2 ownerDisplayName should come from the parent doc',
      );
      assert.strictEqual(a2.isHardBanned, false, 'deviceA2 should not be hard banned');

      // --- deviceB1: matched via active membership; parent has NO display name ---
      const b1 = byId.get(deviceB1);
      assert.ok(b1, 'deviceB1 should be present');
      assert.strictEqual(b1.ownerEmail, emailB, 'deviceB1 ownerEmail should be the parent doc id');
      assert.strictEqual(
        b1.ownerDisplayName,
        null,
        'deviceB1 ownerDisplayName should be null when the parent has no name field',
      );
      assert.strictEqual(b1.isHardBanned, false, 'deviceB1 should not be hard banned');
    },
  );
});
