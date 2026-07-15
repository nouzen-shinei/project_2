import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Emulator integration test for the offline-device PRUNE maintenance job
// (backend Recommendation #3).
//
// Exercises the REAL `runOfflineDevicePrune` core
// (backend-runtime/src/jobs/offlineDevicePrune.ts) against a live Firestore
// emulator. In one ordered lifecycle it asserts:
//   1. DRY-RUN: nothing is deleted, the stale count equals the number of stale
//      docs, and the progress doc records `dryRun: true` + `status: 'completed'`.
//   2. APPLY: stale docs are HARD-DELETED, while the fresh device and the device
//      with NO last-seen REMAIN; pagination resumes across batches (batchSize=1)
//      even when a batch's cursor doc was just deleted.
//   3. IDEMPOTENT: a second APPLY run after completion performs no scan/deletes
//      (no-op) — until `force` re-sweeps the (now smaller) population.
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

const PROGRESS_PATH = 'deviceMaintenanceJobs/offlineDevicePrune';
const DAY_MS = 86_400_000;

describe('offline-device prune: dry-run safety, hard-delete apply, resume + idempotency', { skip }, () => {
  let runOfflineDevicePrune;
  let getFirestore;
  let db;

  before(async () => {
    ({ runOfflineDevicePrune } = await import('../dist/jobs/offlineDevicePrune.js'));
    ({ getFirestore } = await import('../dist/firebaseAdmin.js'));
    db = getFirestore();
  });

  after(async () => {
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

  async function exists(email, deviceId) {
    const snap = await deviceRef(email, deviceId).get();
    return snap.exists;
  }

  it('dry-run counts but deletes nothing; apply hard-deletes only stale docs, resumes across batches, and is idempotent', async () => {
    const stamp = `prune-${Date.now()}`;
    // Unique owner so this test's collection-group scan is isolated from any
    // devices seeded by sibling suites.
    const email = `owner-${stamp}@example.com`;

    const nowMs = Date.parse('2024-06-01T00:00:00Z');
    const maxAgeDays = 14;
    const freshMs = nowMs - 60 * 60 * 1000; // 1 hour ago → NOT stale
    const staleMs = nowMs - 30 * DAY_MS; // 30 days ago → stale

    // (a) fresh, (b) stale, (c) no last-seen at all, (d) another stale doc.
    const fresh = { deviceId: 'dev-a-fresh', lastSeenMs: freshMs };
    const staleB = { deviceId: 'dev-b-stale', lastSeen: new Date(staleMs).toISOString() };
    const noLastSeen = { deviceId: 'dev-c-nolastseen', platformOS: 'web' };
    const staleD = { deviceId: 'dev-d-stale', lastSeenMs: staleMs };

    await deviceRef(email, fresh.deviceId).set(fresh);
    await deviceRef(email, staleB.deviceId).set(staleB);
    await deviceRef(email, noLastSeen.deviceId).set(noLastSeen);
    await deviceRef(email, staleD.deviceId).set(staleD);

    const baseConfig = { batchSize: 1, maxAgeDays, runnerId: 'emulator-test', nowMs };

    // --- DRY-RUN: count stale docs but delete NOTHING. -----------------------
    const dry = await runOfflineDevicePrune(db, { ...baseConfig, dryRun: true });
    assert.strictEqual(dry.completed, true, 'dry-run should complete the sweep');
    assert.strictEqual(dry.dryRun, true, 'result flagged dryRun');
    assert.strictEqual(dry.staleCount, 2, 'dry-run identifies exactly the 2 stale docs');
    assert.strictEqual(dry.deletedCount, 0, 'dry-run deletes nothing');

    // Every seeded doc still present after a dry-run.
    assert.strictEqual(await exists(email, fresh.deviceId), true);
    assert.strictEqual(await exists(email, staleB.deviceId), true, 'dry-run must NOT delete stale docs');
    assert.strictEqual(await exists(email, noLastSeen.deviceId), true);
    assert.strictEqual(await exists(email, staleD.deviceId), true, 'dry-run must NOT delete stale docs');

    const dryProgress = await readProgress();
    assert.ok(dryProgress, 'progress doc exists after dry-run');
    assert.strictEqual(dryProgress.status, 'completed');
    assert.strictEqual(dryProgress.dryRun, true, 'progress records dryRun:true');
    assert.strictEqual(dryProgress.staleCount, 2);
    assert.strictEqual(dryProgress.deletedCount, 0);
    assert.strictEqual(dryProgress.maxAgeDays, maxAgeDays);

    // --- APPLY: hard-delete stale docs (force past the dry-run completion). ---
    const applied = await runOfflineDevicePrune(db, { ...baseConfig, dryRun: false, force: true });
    assert.strictEqual(applied.completed, true, 'apply run completes the sweep across batches (Req: resumable)');
    assert.strictEqual(applied.dryRun, false);
    assert.strictEqual(applied.staleCount, 2, 'apply identifies the 2 stale docs');
    assert.strictEqual(applied.deletedCount, 2, 'apply hard-deletes exactly the 2 stale docs');

    // Stale docs are gone; fresh + no-last-seen docs remain (safety).
    assert.strictEqual(await exists(email, staleB.deviceId), false, 'stale doc hard-deleted');
    assert.strictEqual(await exists(email, staleD.deviceId), false, 'stale doc hard-deleted');
    assert.strictEqual(await exists(email, fresh.deviceId), true, 'fresh device must remain');
    assert.strictEqual(
      await exists(email, noLastSeen.deviceId),
      true,
      'device with unknown last-seen must NEVER be pruned',
    );

    const applyProgress = await readProgress();
    assert.strictEqual(applyProgress.status, 'completed');
    assert.strictEqual(applyProgress.dryRun, false);
    assert.strictEqual(applyProgress.deletedCount, 2);
    assert.ok(!applyProgress.resumeCursor, 'resume cursor cleared on completion');

    // --- IDEMPOTENT: a plain re-run after completion is a no-op. --------------
    // Instrument db.batch to prove the completed re-run stages ZERO deletes.
    let noopDeletes = 0;
    const realBatch = db.batch.bind(db);
    db.batch = () => {
      const b = realBatch();
      const realDelete = b.delete.bind(b);
      b.delete = (...args) => {
        noopDeletes += 1;
        return realDelete(...args);
      };
      return b;
    };
    let noop;
    try {
      noop = await runOfflineDevicePrune(db, { ...baseConfig, dryRun: false });
    } finally {
      db.batch = realBatch;
    }
    assert.strictEqual(noop.completed, true, 'completed re-run reports completion');
    assert.strictEqual(noopDeletes, 0, 'a completed re-run performs no deletes (idempotent no-op)');

    // --- FORCE: re-sweep the now-smaller population; nothing left to prune. ---
    const forced = await runOfflineDevicePrune(db, { ...baseConfig, dryRun: false, force: true });
    assert.strictEqual(forced.completed, true);
    assert.strictEqual(forced.deletedCount, 0, 'no stale docs remain after the apply run');
    // The two survivors are still present.
    assert.strictEqual(await exists(email, fresh.deviceId), true);
    assert.strictEqual(await exists(email, noLastSeen.deviceId), true);
  });
});
