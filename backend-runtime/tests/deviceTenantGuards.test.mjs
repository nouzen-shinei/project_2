import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Task 9.5 — Integration test for tenant isolation of actions (Firestore emulator).
//
// Design Property 4 ("Tenant isolation for actions and bulk actions"):
// EVERY Device Admin mutation — the single-device actions (force-logout, ban,
// unban, delete, restore, permanent-delete) AND the bulk actions (bulk
// force-logout, notify) — must refuse to touch a device that is NOT associated
// with the Selected_Tenant. A cross-tenant target (tagged to a different tenant)
// or an unscoped target (no tenant association at all) is rejected with a tenant
// scope violation and leaves EVERY record unchanged (Requirements 3.2, 3.3, 3.6,
// 14.4).
//
// This mirrors the conceptual shape of `adminTenantGuards.test.mjs` (assert that
// a guard rejects out-of-tenant work) but uses the same live-emulator harness as
// the sibling device suites (`deviceForceLogout` / `devicePermanentDelete` /
// `deviceNotify`): it exercises the REAL orchestrators from `../dist/*.js`
// against a running Firestore emulator, because the guarantee under test is "no
// Firestore state changed", which only a real datastore can prove. Running these
// destructive mutations against production Firestore would be a real side
// effect, so `FIRESTORE_EMULATOR_HOST` is a HARD precondition: when it is unset
// the suite skips entirely rather than touching a live datastore.

const require = createRequire(import.meta.url);

const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const HAS_EMULATOR = EMULATOR_HOST.length > 0;
const skip = HAS_EMULATOR
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

// Pin a deterministic emulator project id (overridable) before any backend code
// initializes the Admin SDK, matching the sibling emulator suites so the seeder
// and the orchestrators share one namespace.
if (HAS_EMULATOR) {
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-device-console';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
}

// Related tracking collections a leaked mutation would touch.
const DEVICE_BANS_COLLECTION = 'device_bans';
const LOGOUT_SIGNALS_COLLECTION = 'logout_signals';

describe('Device Admin action tenant isolation (Requirements 3.2, 3.3, 3.6, 14.4)', { skip }, () => {
  // Exercise the exact production code path via the built output (matches the
  // `../dist/*.js` import convention used by the sibling `*.test.mjs` suites).
  let svc;
  let TenantScopeError;
  let DEVICE_AUDIT_LOG_COLLECTION;
  let getFirestore;
  let db;

  before(async () => {
    svc = await import('../dist/deviceAdminService.js');
    ({ TenantScopeError, DEVICE_AUDIT_LOG_COLLECTION } = svc);
    // Seed and read back through the SAME Firestore client the orchestrators use
    // (the default Admin app initialized by `firebaseAdmin`), so we observe the
    // persisted state the production writes would (or would not) have produced.
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

  const actor = { id: 'admin-uid-guard', email: 'ops@example.com', name: 'Ops Admin' };
  const reason = 'Tenant isolation guard coverage';

  function deviceRefFor(email, deviceId) {
    return db.collection('user_devices').doc(email).collection('devices').doc(deviceId);
  }

  // Seed one active device at `user_devices/{email}/devices/{deviceId}`. When
  // `tenantIds`/`activeTenantId` are supplied the device is tagged to that
  // owning tenant (the cross-tenant case); when omitted the device carries NO
  // tenant association at all (the unscoped case). Only plain, JSON-serializable
  // values are written (no server timestamps) so the seeded doc round-trips
  // byte-for-byte, letting us prove "no state change" with a deep equality.
  async function seedDevice({ email, deviceId, tenantIds, activeTenantId }) {
    const data = {
      deviceId,
      deviceType: 'web',
      deviceName: 'Seed Chrome on macOS',
      manufacturer: 'Seed Corp',
      modelName: 'SeedBook',
      userAgent: 'Mozilla/5.0 (SeedOS) Seed/1.0',
      ownerEmail: email,
      isDeleted: false,
      isOnline: true,
      sessionActive: true,
      lastSeenMs: 1_700_000_000_000,
    };
    if (Array.isArray(tenantIds)) {
      data.tenantIds = tenantIds;
    }
    if (typeof activeTenantId === 'string') {
      data.activeTenantId = activeTenantId;
    }
    const ref = deviceRefFor(email, deviceId);
    await ref.set(data);
    await db.collection('user_devices').doc(email).set({ totalDevices: 1 }, { merge: true });
    return ref;
  }

  // Prove a rejected action left NO trace (Requirements 3.2, 3.3, 3.6, 14.4):
  //   - the device doc still exists and is byte-for-byte identical to `baseline`
  //     (no provenance/lifecycle mutation, and no permanent delete removed it);
  //   - no `logout_signals/{email}_{deviceId}` doc was written;
  //   - no `device_bans` doc targeting the device was written;
  //   - no `deviceAuditLogs` entry targeting the device was written (a rejected
  //     action never audits; the aggregate notify audit carries no
  //     `targetDeviceId`, so this device-scoped query stays empty for it too).
  async function assertNoStateChange({ ref, baseline, email, deviceId }) {
    const snap = await ref.get();
    assert.strictEqual(snap.exists, true, 'the device doc must still exist after a rejected action');
    assert.deepStrictEqual(
      snap.data(),
      baseline,
      'the device doc must be byte-for-byte unchanged after a rejected action',
    );

    const signalSnap = await db
      .collection(LOGOUT_SIGNALS_COLLECTION)
      .doc(`${email}_${deviceId}`)
      .get();
    assert.strictEqual(signalSnap.exists, false, 'no force-logout signal may be written for a rejected action');

    const bans = await db
      .collection(DEVICE_BANS_COLLECTION)
      .where('targetDeviceId', '==', deviceId)
      .get();
    assert.strictEqual(bans.empty, true, 'no device ban may be written for a rejected action');

    const audits = await db
      .collection(DEVICE_AUDIT_LOG_COLLECTION)
      .where('targetDeviceId', '==', deviceId)
      .get();
    assert.strictEqual(audits.empty, true, 'no audit entry may be written for a rejected action');
  }

  // The six single-device Device Admin mutations, each invoked against a target
  // that is NOT in the scoped tenant. Every one asserts tenant scope BEFORE any
  // write, so all must reject identically.
  const SINGLE_DEVICE_ACTIONS = [
    { name: 'forceLogout', run: (p) => svc.forceLogout({ ...p, reason }) },
    { name: 'ban', run: (p) => svc.ban({ ...p, reason }) },
    { name: 'unban', run: (p) => svc.unban({ ...p, reason }) },
    { name: 'softDelete (delete)', run: (p) => svc.softDelete({ ...p, reason }) },
    { name: 'restore', run: (p) => svc.restore({ ...p, reason }) },
    { name: 'permanentDelete', run: (p) => svc.permanentDelete({ ...p, reason }) },
  ];

  function assertTenantScopeRejection(actionName, err) {
    assert.ok(
      err instanceof TenantScopeError,
      `${actionName} should reject a mis-scoped target with a TenantScopeError`,
    );
    assert.strictEqual(err.code, 'tenant_scope_violation', `${actionName} error code should be tenant_scope_violation`);
    assert.strictEqual(err.status, 403, `${actionName} should map to HTTP 403`);
    return true;
  }

  it('rejects every cross-tenant single-device action with tenant_scope_violation and no state change', async () => {
    for (const { name, run } of SINGLE_DEVICE_ACTIONS) {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ownerTenant = `tenant-owner-${stamp}`;
      const otherTenant = `tenant-other-${stamp}`;
      const email = `owner-${stamp}@example.com`;
      const deviceId = `device-${stamp}`;

      // Device belongs to `ownerTenant`; the action is scoped to `otherTenant`.
      const ref = await seedDevice({
        email,
        deviceId,
        tenantIds: [ownerTenant],
        activeTenantId: ownerTenant,
      });
      const baseline = (await ref.get()).data();

      await assert.rejects(
        run({ tenantId: otherTenant, email, deviceId, actor }),
        (err) => assertTenantScopeRejection(name, err),
        `${name} must reject a cross-tenant target`,
      );

      await assertNoStateChange({ ref, baseline, email, deviceId });
    }
  });

  it('rejects every single-device action against an unscoped device with tenant_scope_violation and no state change', async () => {
    for (const { name, run } of SINGLE_DEVICE_ACTIONS) {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const scopedTenant = `tenant-real-${stamp}`;
      const email = `owner-${stamp}@example.com`;
      const deviceId = `device-${stamp}`;

      // Device carries NO tenant association at all; the action names a real tenant.
      const ref = await seedDevice({ email, deviceId });
      const baseline = (await ref.get()).data();

      await assert.rejects(
        run({ tenantId: scopedTenant, email, deviceId, actor }),
        (err) => assertTenantScopeRejection(name, err),
        `${name} must reject an unscoped device`,
      );

      await assertNoStateChange({ ref, baseline, email, deviceId });
    }
  });

  it('rejects cross-tenant and unscoped bulk force-logout targets, reporting each failed with no state change', async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerTenant = `tenant-owner-${stamp}`;
    const otherTenant = `tenant-other-${stamp}`;

    // Target 1: a device tagged to a DIFFERENT tenant (cross-tenant).
    const crossEmail = `cross-${stamp}@example.com`;
    const crossDeviceId = `cross-device-${stamp}`;
    const crossRef = await seedDevice({
      email: crossEmail,
      deviceId: crossDeviceId,
      tenantIds: [ownerTenant],
      activeTenantId: ownerTenant,
    });
    const crossBaseline = (await crossRef.get()).data();

    // Target 2: a device with NO tenant association (unscoped).
    const unscopedEmail = `unscoped-${stamp}@example.com`;
    const unscopedDeviceId = `unscoped-device-${stamp}`;
    const unscopedRef = await seedDevice({ email: unscopedEmail, deviceId: unscopedDeviceId });
    const unscopedBaseline = (await unscopedRef.get()).data();

    const targets = [
      { email: crossEmail, deviceId: crossDeviceId },
      { email: unscopedEmail, deviceId: unscopedDeviceId },
    ];

    const result = await svc.bulkForceLogout({ tenantId: otherTenant, targets, actor, reason });

    // Every target is reported, and every one failed with a scope violation
    // (Requirement 14.4; design Property 18 completeness on the failure path).
    assert.strictEqual(result.ok, true, 'bulkForceLogout resolves ok even when all targets fail');
    assert.strictEqual(result.succeeded, 0, 'no mis-scoped target may succeed');
    assert.strictEqual(result.failed, targets.length, 'every mis-scoped target is counted as failed');
    assert.strictEqual(result.results.length, targets.length, 'one outcome per target');
    for (const outcome of result.results) {
      assert.strictEqual(outcome.ok, false, `${outcome.deviceId} must not be forced out`);
      assert.strictEqual(
        outcome.error,
        'tenant_scope_violation',
        `${outcome.deviceId} must be rejected for a tenant scope violation`,
      );
    }

    // Neither target changed, and no signal / ban / audit was written for either.
    await assertNoStateChange({
      ref: crossRef,
      baseline: crossBaseline,
      email: crossEmail,
      deviceId: crossDeviceId,
    });
    await assertNoStateChange({
      ref: unscopedRef,
      baseline: unscopedBaseline,
      email: unscopedEmail,
      deviceId: unscopedDeviceId,
    });
  });

  it('rejects cross-tenant and unscoped bulk notify targets, reporting each failed with no state change', async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerTenant = `tenant-owner-${stamp}`;
    const otherTenant = `tenant-other-${stamp}`;

    // Target 1: a device tagged to a DIFFERENT tenant (cross-tenant). It carries
    // a push token, so a scope leak would attempt a real delivery — the scope
    // check must short-circuit BEFORE any push resolution.
    const crossEmail = `cross-${stamp}@example.com`;
    const crossDeviceId = `cross-device-${stamp}`;
    const crossRef = await seedDevice({
      email: crossEmail,
      deviceId: crossDeviceId,
      tenantIds: [ownerTenant],
      activeTenantId: ownerTenant,
    });
    await crossRef.set({ expoPushToken: 'ExponentPushToken[guard-token]' }, { merge: true });
    const crossBaseline = (await crossRef.get()).data();

    // Target 2: a device with NO tenant association (unscoped).
    const unscopedEmail = `unscoped-${stamp}@example.com`;
    const unscopedDeviceId = `unscoped-device-${stamp}`;
    const unscopedRef = await seedDevice({ email: unscopedEmail, deviceId: unscopedDeviceId });
    const unscopedBaseline = (await unscopedRef.get()).data();

    const targets = [
      { email: crossEmail, deviceId: crossDeviceId },
      { email: unscopedEmail, deviceId: unscopedDeviceId },
    ];

    const result = await svc.notify({
      tenantId: otherTenant,
      title: 'Guard broadcast',
      body: 'This must never reach a mis-scoped device.',
      targets,
      actor,
    });

    // Every target is reported, and every delivery failed with a scope violation
    // (Requirement 14.4; design Property 18 completeness on the failure path).
    assert.strictEqual(result.ok, true, 'notify resolves ok even when all targets fail');
    assert.strictEqual(result.successful, 0, 'no mis-scoped target may be delivered');
    assert.strictEqual(result.failed, targets.length, 'every mis-scoped target is counted as failed');
    assert.strictEqual(result.results.length, targets.length, 'one outcome per target');
    for (const outcome of result.results) {
      assert.strictEqual(outcome.ok, false, `${outcome.deviceId} must not be delivered to`);
      assert.strictEqual(
        outcome.error,
        'tenant_scope_violation',
        `${outcome.deviceId} must be rejected for a tenant scope violation`,
      );
    }

    // Neither device was mutated, and no per-device signal / ban / device-scoped
    // audit was written. (`notify` writes a single aggregate audit row with no
    // `targetDeviceId`, so the device-scoped audit query below stays empty.)
    await assertNoStateChange({
      ref: crossRef,
      baseline: crossBaseline,
      email: crossEmail,
      deviceId: crossDeviceId,
    });
    await assertNoStateChange({
      ref: unscopedRef,
      baseline: unscopedBaseline,
      email: unscopedEmail,
      deviceId: unscopedDeviceId,
    });
  });
});
