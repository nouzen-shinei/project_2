import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Emulator integration test for the SCOPED tenant-index listing path and its
// transparent index-unavailable fallback (device-tenant-index Stage 2;
// Requirements 6.1, 6.3, 7.1, 8.4).
//
// Exercises the real `listTenantDevices` orchestrator
// (backend-runtime/src/deviceAdminService.ts) against a live Firestore emulator:
//   1. Seeds a multi-tenant / multi-owner population with a FRESH `tenantIndex`
//      (derived from each device's scoping source via the real
//      `deriveTenantIndex`), then asserts the SCOPED path
//      (`collectionGroup('devices').where('tenantIndex','array-contains', t)`)
//      returns EXACTLY the in-tenant records with the SAME owner attribution and
//      active-ban state as the retained FULL SCAN (Req 6.1, 6.3, 7.1).
//   2. Simulates a missing collection-group index (a Firestore
//      `FAILED_PRECONDITION` from the scoped query) and asserts `listTenantDevices`
//      transparently falls back to the full scan and STILL returns the correct
//      records (Req 8.4).
//
// Like the sibling emulator suites, this talks to real Firestore only through
// the emulator: `FIRESTORE_EMULATOR_HOST` is a HARD precondition; when unset the
// suite skips entirely rather than touching a live datastore. Import from
// `../dist/*.js` (build first), matching the `*.test.mjs` convention.

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
}

const FLAG = 'DEVICE_TENANT_INDEX_LISTING_ENABLED';
const BACKFILL_PROGRESS_PATH = 'migrationProgress/deviceTenantIndexBackfill';

describe('device-tenant-index scoped listing + fallback (Requirements 6.1, 6.3, 7.1, 8.4)', { skip }, () => {
  let listTenantDevices;
  let deriveTenantIndex;
  let DEVICE_BANS_COLLECTION;
  let getFirestore;
  let db;

  before(async () => {
    ({ listTenantDevices, deriveTenantIndex, DEVICE_BANS_COLLECTION } = await import(
      '../dist/deviceAdminService.js'
    ));
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    db = getFirestore();
    // Mark the backfill complete so the rollout decision can select the scoped
    // path (gated on `status === 'completed'`).
    await db.doc(BACKFILL_PROGRESS_PATH).set({ status: 'completed' }, { merge: true });
  });

  after(async () => {
    delete process.env[FLAG];
    try {
      await require('firebase-admin').app().delete();
    } catch {
      // ignore teardown failures
    }
  });

  // Seed a device doc at `user_devices/{email}/devices/{deviceId}` with the
  // supplied scoping fields + a FRESH derived `tenantIndex`, then merge the
  // parent doc (owner attribution: doc id is the email, `displayName` the name).
  async function seedDevice({ email, deviceId, parent, device }) {
    const tenantIndex = deriveTenantIndex(device);
    await db
      .collection('user_devices')
      .doc(email)
      .collection('devices')
      .doc(deviceId)
      .set({ deviceId, ...device, tenantIndex });
    await db.collection('user_devices').doc(email).set(parent, { merge: true });
  }

  async function seedPopulation(stamp) {
    const tenantId = `tenant-scoped-${stamp}`;
    const otherTenantId = `tenant-other-${stamp}`;

    const emailA = `owner-a-${stamp}@example.com`;
    const emailB = `owner-b-${stamp}@example.com`;
    const emailC = `owner-c-${stamp}@example.com`;
    const emailD = `owner-d-${stamp}@example.com`;

    const deviceA1 = `dev-a1-${stamp}`; // in-tenant via tenantIds + hard banned
    const deviceA2 = `dev-a2-${stamp}`; // in-tenant via activeTenantId
    const deviceB1 = `dev-b1-${stamp}`; // in-tenant via active membership; no display name
    const deviceC1 = `dev-c1-${stamp}`; // cross-tenant → excluded
    const deviceD1 = `dev-d1-${stamp}`; // unscoped/untagged → excluded

    const bannedFingerprint = `seed-fp-${stamp}`;

    await seedDevice({
      email: emailA,
      deviceId: deviceA1,
      parent: { totalDevices: 2, displayName: 'Alice Anderson' },
      device: { deviceType: 'web', deviceName: 'Alice Chrome', tenantIds: [tenantId], deviceSeedHash: bannedFingerprint },
    });
    await seedDevice({
      email: emailA,
      deviceId: deviceA2,
      parent: { totalDevices: 2, displayName: 'Alice Anderson' },
      device: { deviceType: 'mobile', deviceName: 'Alice iPhone', activeTenantId: tenantId },
    });
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
    await seedDevice({
      email: emailC,
      deviceId: deviceC1,
      parent: { totalDevices: 1, displayName: 'Carol Cross' },
      device: { deviceType: 'web', deviceName: 'Carol Firefox', tenantIds: [otherTenantId], activeTenantId: otherTenantId },
    });
    await seedDevice({
      email: emailD,
      deviceId: deviceD1,
      parent: { totalDevices: 1, displayName: 'Dave Detached' },
      device: { deviceType: 'web', deviceName: 'Dave Safari' },
    });

    await db.collection(DEVICE_BANS_COLLECTION).add({
      banType: 'hard',
      deviceFingerprint: bannedFingerprint,
      isActive: true,
      reason: 'Scoped listing integration coverage',
      adminEmail: 'ops@example.com',
      targetDeviceId: deviceA1,
      targetUserEmail: emailA,
      createdAt: require('firebase-admin').firestore.FieldValue.serverTimestamp(),
    });

    return { tenantId, inTenantIds: [deviceA1, deviceA2, deviceB1], deviceC1, deviceD1, emailA, emailB };
  }

  it('scoped query returns exactly the in-tenant records with identical attribution/ban state as the full scan', async () => {
    const stamp = `s1-${Date.now()}`;
    const seed = await seedPopulation(stamp);

    // Full scan (flag off).
    delete process.env[FLAG];
    const fullScan = await listTenantDevices(seed.tenantId);

    // Scoped (flag on + backfill completed).
    process.env[FLAG] = '1';
    const scoped = await listTenantDevices(seed.tenantId);

    const sortById = (records) => [...records].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    const scopedSorted = sortById(scoped);
    const fullSorted = sortById(fullScan);

    // Exactly the three in-tenant devices on both paths.
    assert.deepStrictEqual(
      scopedSorted.map((r) => r.deviceId),
      [...seed.inTenantIds].sort(),
      'scoped listing should return exactly the in-tenant devices',
    );
    assert.deepStrictEqual(
      fullSorted.map((r) => r.deviceId),
      [...seed.inTenantIds].sort(),
      'full scan should return exactly the in-tenant devices',
    );

    // Cross-tenant + unscoped devices excluded.
    const scopedIds = new Set(scoped.map((r) => r.deviceId));
    assert.strictEqual(scopedIds.has(seed.deviceC1), false, 'cross-tenant device must be excluded');
    assert.strictEqual(scopedIds.has(seed.deviceD1), false, 'unscoped device must be excluded');

    // Field-identical records between the two paths (attribution + ban state).
    assert.deepStrictEqual(scopedSorted, fullSorted, 'scoped records must be field-identical to the full scan');

    // Spot-check attribution + ban enrichment on the scoped result.
    const byId = new Map(scoped.map((r) => [r.deviceId, r]));
    const a1 = byId.get(seed.inTenantIds[0]);
    assert.strictEqual(a1.ownerEmail, seed.emailA);
    assert.strictEqual(a1.ownerDisplayName, 'Alice Anderson');
    assert.strictEqual(a1.isHardBanned, true, 'the banned in-tenant device should be hard banned');
    const b1 = byId.get(seed.inTenantIds[2]);
    assert.strictEqual(b1.ownerEmail, seed.emailB);
    assert.strictEqual(b1.ownerDisplayName, null, 'owner with no display name → null');

    // No projected record surfaces the internal `tenantIndex` field.
    for (const record of scoped) {
      assert.strictEqual('tenantIndex' in record, false, 'tenantIndex must not be surfaced');
    }
  });

  it('a simulated missing index (FAILED_PRECONDITION) transparently falls back to the full scan', async () => {
    const stamp = `s2-${Date.now()}`;
    const seed = await seedPopulation(stamp);

    process.env[FLAG] = '1'; // scoped path selected (backfill already completed)

    // Force the scoped `collectionGroup('devices').where('tenantIndex',...)`
    // query to raise a Firestore index-unavailable error, while leaving the
    // plain `collectionGroup('devices').get()` used by the full-scan fallback
    // intact.
    const realCollectionGroup = db.collectionGroup.bind(db);
    db.collectionGroup = (name) => {
      const query = realCollectionGroup(name);
      if (name === 'devices') {
        const originalWhere = query.where.bind(query);
        query.where = (...args) => {
          void originalWhere; // (the real filter is intentionally bypassed)
          const err = new Error('9 FAILED_PRECONDITION: The query requires an index.');
          err.code = 9;
          return { get: async () => { throw err; } };
        };
      }
      return query;
    };

    let records;
    try {
      records = await listTenantDevices(seed.tenantId);
    } finally {
      db.collectionGroup = realCollectionGroup; // restore
    }

    const returnedIds = records.map((r) => r.deviceId).sort();
    assert.deepStrictEqual(
      returnedIds,
      [...seed.inTenantIds].sort(),
      'the fallback must still return exactly the in-tenant devices',
    );

    // Attribution/ban state preserved through the fallback.
    const byId = new Map(records.map((r) => [r.deviceId, r]));
    assert.strictEqual(byId.get(seed.inTenantIds[0]).isHardBanned, true);
    assert.strictEqual(byId.get(seed.inTenantIds[0]).ownerEmail, seed.emailA);
  });
});
