import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Emulator integration test for the device tenant-index BACKFILL migration
// (device-tenant-index Stage 4; Requirements 4.2, 4.3, 4.4, 4.6, 4.7, 4.9).
//
// Exercises the REAL `runDeviceTenantIndexBackfill` core
// (backend-runtime/src/jobs/deviceTenantIndexBackfill.ts) against a live
// Firestore emulator. In one ordered lifecycle it asserts:
//   1. Durable per-batch progress: after the FIRST batch commits, the
//      Backfill_Progress carries the processed count + resume cursor (Req 4.3).
//   2. Partial-failure retention: an injected mid-batch commit failure leaves
//      the last successful cursor/count intact and records `lastError`, and the
//      run surfaces the error (Req 4.6).
//   3. No-downtime listing: WHILE the backfill is incomplete (`status !==
//      'completed'`) the listing is still served via the full-scan fallback and
//      returns the correct in-tenant set (Req 4.7).
//   4. Resume-from-cursor: a subsequent run continues AFTER the persisted
//      cursor and does NOT revisit already-processed docs — proven by
//      corrupting an already-processed doc and asserting the resume leaves it
//      untouched (Req 4.4).
//   5. Batched writes never exceed the configured (clamped) batch size (Req 4.2).
//   6. Completion + correctness: a forced full re-sweep converges EVERY device's
//      `tenantIndex` to `deriveTenantIndex(source)` and records `status:
//      'completed'` (Req 4.1, 4.9), after which a plain re-run is an idempotent
//      no-op (Req 4.8).
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
}

const FLAG = 'DEVICE_TENANT_INDEX_LISTING_ENABLED';
const PROGRESS_PATH = 'migrationProgress/deviceTenantIndexBackfill';

describe('device-tenant-index backfill durability + resume + no-downtime (Requirements 4.2, 4.3, 4.4, 4.6, 4.7, 4.9)', { skip }, () => {
  let runDeviceTenantIndexBackfill;
  let deriveTenantIndex;
  let listTenantDevices;
  let getFirestore;
  let db;

  before(async () => {
    ({ runDeviceTenantIndexBackfill } = await import('../dist/jobs/deviceTenantIndexBackfill.js'));
    ({ deriveTenantIndex, listTenantDevices } = await import('../dist/deviceAdminService.js'));
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    db = getFirestore();
  });

  after(async () => {
    delete process.env[FLAG];
    try {
      await require('firebase-admin').app().delete();
    } catch {
      // ignore teardown failures
    }
  });

  function deviceRef(email, deviceId) {
    return db.collection('user_devices').doc(email).collection('devices').doc(deviceId);
  }

  async function readProgress() {
    const snap = await db.doc(PROGRESS_PATH).get();
    return snap.exists ? snap.data() : null;
  }

  it('persists progress per batch, retains it on mid-batch failure, serves listing via fallback, resumes from cursor, and completes with every tenantIndex correct', async () => {
    const stamp = `bf-${Date.now()}`;
    const tenantA = `tenant-a-${stamp}`; // unique → no other-test devices match
    const tenantB = `tenant-b-${stamp}`;

    const emailA = `a-${stamp}@example.com`;
    const emailB = `b-${stamp}@example.com`;
    const emailC = `c-${stamp}@example.com`;

    // Five devices with MISSING or STALE `tenantIndex`; three associated with
    // tenantA (via tenantIds / activeTenantId / active membership), one with
    // tenantB, one untagged. Every device therefore requires a write on run 1.
    const seeds = [
      { email: emailA, deviceId: 'dev-0', source: { tenantIds: [tenantA] }, stale: undefined, inA: true },
      { email: emailA, deviceId: 'dev-1', source: { activeTenantId: tenantA }, stale: ['stale-x'], inA: true },
      {
        email: emailB,
        deviceId: 'dev-2',
        source: { tenantMemberships: [{ tenantId: tenantA, role: 'member', status: 'active' }] },
        stale: undefined,
        inA: true,
      },
      { email: emailB, deviceId: 'dev-3', source: { tenantIds: [tenantB], activeTenantId: tenantB }, stale: ['zzz'], inA: false },
      { email: emailC, deviceId: 'dev-4', source: {}, stale: undefined, inA: false },
    ];

    for (const seed of seeds) {
      const doc = { deviceId: seed.deviceId, ...seed.source };
      if (seed.stale !== undefined) doc.tenantIndex = seed.stale;
      await deviceRef(seed.email, seed.deviceId).set(doc);
    }

    const pathOf = (seed) => `user_devices/${seed.email}/devices/${seed.deviceId}`;
    const sortedPaths = seeds.map(pathOf).sort();
    const expectedInA = new Set(seeds.filter((s) => s.inA).map((s) => s.deviceId));
    const expectedIndex = new Map(seeds.map((s) => [pathOf(s), deriveTenantIndex(s.source)]));

    const batchSize = 2;

    // --- Run 1: inject a failure on the SECOND batch commit. -----------------
    const realBatch = db.batch.bind(db);
    let commitCount = 0;
    let maxBatchOps = 0;
    db.batch = () => {
      const b = realBatch();
      const realUpdate = b.update.bind(b);
      let ops = 0;
      b.update = (...args) => {
        ops += 1;
        maxBatchOps = Math.max(maxBatchOps, ops);
        return realUpdate(...args);
      };
      const realCommit = b.commit.bind(b);
      b.commit = async () => {
        commitCount += 1;
        if (commitCount === 2) {
          throw new Error('injected mid-batch commit failure');
        }
        return realCommit();
      };
      return b;
    };

    let threw = false;
    try {
      await runDeviceTenantIndexBackfill(db, { batchSize });
    } catch (err) {
      threw = true;
      assert.match(String(err && err.message), /injected mid-batch commit failure/);
    } finally {
      db.batch = realBatch;
    }
    assert.strictEqual(threw, true, 'run 1 should surface the injected batch failure (Req 4.6)');

    // Per-batch progress persisted after batch 1, retained through the failure.
    const midProgress = await readProgress();
    assert.ok(midProgress, 'progress doc should exist mid-run');
    assert.strictEqual(midProgress.status, 'in_progress');
    assert.strictEqual(midProgress.processedCount, batchSize, 'processed count from the first committed batch (Req 4.3)');
    assert.strictEqual(midProgress.resumeCursor, sortedPaths[1], 'resume cursor = last doc of the first batch (Req 4.3, 4.6)');
    assert.ok(typeof midProgress.lastError === 'string' && midProgress.lastError.length > 0, 'lastError recorded (Req 4.6)');
    // Batched writes never exceed the configured batch size (Req 4.2).
    assert.ok(maxBatchOps <= batchSize, `batch staged <= ${batchSize} writes (Req 4.2)`);

    // No-downtime: while incomplete, the listing is served via the full-scan
    // fallback (status !== 'completed' forces fallback) and returns the correct
    // in-tenant set even with the flag ENABLED (Req 4.7).
    process.env[FLAG] = '1';
    const during = await listTenantDevices(tenantA);
    delete process.env[FLAG];
    assert.deepStrictEqual(
      new Set(during.map((r) => r.deviceId)),
      expectedInA,
      'listing must still serve the correct in-tenant set during the backfill (Req 4.7)',
    );

    // Corrupt an ALREADY-PROCESSED doc (first in sort order, committed in batch
    // 1). If the resume respects the cursor it will NOT revisit / fix it.
    const corruptedPath = sortedPaths[0];
    await db.doc(corruptedPath).set({ tenantIndex: ['CORRUPT-sentinel'] }, { merge: true });

    // --- Run 2: resume from the persisted cursor. ----------------------------
    const resumeResult = await runDeviceTenantIndexBackfill(db, { batchSize });
    assert.strictEqual(resumeResult.completed, true, 'resume run should complete the sweep (Req 4.4, 4.9)');

    // Resume-from-cursor proof: the corrupted already-processed doc is untouched.
    const corruptedSnap = await db.doc(corruptedPath).get();
    assert.deepStrictEqual(
      corruptedSnap.data().tenantIndex,
      ['CORRUPT-sentinel'],
      'resume must NOT revisit docs at/behind the cursor (Req 4.4)',
    );

    const afterResume = await readProgress();
    assert.strictEqual(afterResume.status, 'completed', 'status completed at end of sweep (Req 4.9)');
    assert.strictEqual(afterResume.processedCount, seeds.length, 'cumulative processed count across the resume');
    assert.ok(!afterResume.resumeCursor, 'resume cursor cleared on completion');

    // The devices AFTER the cursor were converged by the resume.
    for (const path of sortedPaths.slice(2)) {
      const snap = await db.doc(path).get();
      assert.deepStrictEqual(snap.data().tenantIndex, expectedIndex.get(path), `resume converged ${path}`);
    }

    // --- Run 3: forced full re-sweep fixes the corruption + every device. ----
    const forced = await runDeviceTenantIndexBackfill(db, { batchSize, force: true });
    assert.strictEqual(forced.completed, true);
    assert.strictEqual(forced.processedCount, seeds.length, 'forced re-run re-sweeps the whole population');

    for (const path of sortedPaths) {
      const snap = await db.doc(path).get();
      assert.deepStrictEqual(
        snap.data().tenantIndex,
        expectedIndex.get(path),
        `every device converged to deriveTenantIndex(source) (Req 4.1): ${path}`,
      );
    }
    const finalProgress = await readProgress();
    assert.strictEqual(finalProgress.status, 'completed', 'completion state recorded (Req 4.9)');
    assert.ok(!finalProgress.lastError, 'lastError cleared after a clean run');

    // --- Run 4: idempotent no-op once completed (Req 4.8). -------------------
    let noopWrites = 0;
    const realBatch2 = db.batch.bind(db);
    db.batch = () => {
      const b = realBatch2();
      const realUpdate = b.update.bind(b);
      b.update = (...args) => {
        noopWrites += 1;
        return realUpdate(...args);
      };
      return b;
    };
    let noop;
    try {
      noop = await runDeviceTenantIndexBackfill(db, { batchSize });
    } finally {
      db.batch = realBatch2;
    }
    assert.strictEqual(noop.completed, true, 'completed re-run reports completion');
    assert.strictEqual(noopWrites, 0, 'a completed re-run performs no device writes (Req 4.8)');
  });
});
