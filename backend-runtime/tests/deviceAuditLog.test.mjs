import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createRequire } from 'module';

// Task 3.4 — Integration test for audit durability (Firestore emulator).
//
// Verifies that `writeAudit` (backend-runtime/src/deviceAdminService.ts) persists
// Device Console audit entries DURABLY to the append-only `deviceAuditLogs`
// collection (Requirement 17.3):
//   - an entry survives a client reconnect: it is written through the production
//     code path and then read back through a brand-new, independent Firestore
//     client instance, and
//   - the persisted entry carries NO TTL / expiry field (no automatic deletion).
//
// This suite talks to real Firestore only through the emulator. Writing audit
// entries against production Firestore would be a destructive side effect, so the
// emulator host is treated as a HARD precondition: when `FIRESTORE_EMULATOR_HOST`
// is unset the suite skips entirely rather than touching a live datastore.

const require = createRequire(import.meta.url);
const admin = require('firebase-admin');

const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const HAS_EMULATOR = EMULATOR_HOST.length > 0;
const skip = HAS_EMULATOR
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

// Pin a deterministic emulator project id (overridable) before any backend code
// initializes the Admin SDK, so the writer and the fresh reader share a namespace.
if (HAS_EMULATOR) {
  process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'demo-device-console';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
  process.env.TEST_MODE = process.env.TEST_MODE || '1';
}

describe('deviceAuditLogs durability (Requirement 17.3)', { skip }, () => {
  // Exercise the exact production code path via the built output (matches the
  // `../dist/*.js` import convention used by the sibling `*.test.mjs` suites).
  let writeAudit;
  let DEVICE_AUDIT_LOG_COLLECTION;
  const readerApps = [];

  before(async () => {
    ({ writeAudit, DEVICE_AUDIT_LOG_COLLECTION } = await import('../dist/deviceAdminService.js'));
  });

  after(async () => {
    // Tear down every fresh reader client created during the run.
    while (readerApps.length) {
      const app = readerApps.pop();
      try {
        await app.delete();
      } catch {
        // ignore teardown failures
      }
    }
  });

  // Build a brand-new Firestore client instance — a separate Admin app pointed at
  // the same emulator project as the writer — to emulate a client reconnect that
  // reads persisted state back rather than any in-memory value.
  function freshFirestoreClient() {
    const defaultApp = admin.apps.find((app) => app && app.name === '[DEFAULT]');
    const projectId =
      (defaultApp && defaultApp.options && defaultApp.options.projectId) ||
      process.env.FIREBASE_PROJECT_ID ||
      'demo-device-console';
    const app = admin.initializeApp({ projectId }, `audit-reader-${readerApps.length}-${Date.now()}`);
    readerApps.push(app);
    return app.firestore();
  }

  it('persists an audit entry that a freshly reconnected client can read back', async () => {
    const tenantId = `tenant-durability-${Date.now()}`;
    const entry = {
      tenantId,
      action: 'permanent_delete',
      actorId: 'admin-uid-1',
      actorEmail: 'ops@example.com',
      actorName: 'Ops Admin',
      targetDeviceId: 'device-xyz',
      targetUserEmail: 'owner@example.com',
      reason: 'Durability integration coverage',
      actionTimeMs: 1_700_000_000_000,
    };

    // Write through the production accessor (its own, already-connected client).
    const { id } = await writeAudit(entry);
    assert.ok(id, 'writeAudit should return the new document id');

    // Reconnect with an independent Firestore client and read the entry back.
    const readerDb = freshFirestoreClient();
    const snap = await readerDb.collection(DEVICE_AUDIT_LOG_COLLECTION).doc(id).get();

    assert.strictEqual(snap.exists, true, 'audit entry should survive the client reconnect');
    const data = snap.data();
    assert.strictEqual(data.tenantId, tenantId);
    assert.strictEqual(data.action, 'permanent_delete');
    assert.strictEqual(data.actorId, 'admin-uid-1');
    assert.strictEqual(data.actorEmail, 'ops@example.com');
    assert.strictEqual(data.targetDeviceId, 'device-xyz');
    assert.strictEqual(data.targetUserEmail, 'owner@example.com');
    assert.strictEqual(data.reason, 'Durability integration coverage');
    assert.strictEqual(data.actionTimeMs, 1_700_000_000_000);
    assert.strictEqual(typeof data.createdAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(data.createdAt)), 'createdAt should be a valid ISO timestamp');
  });

  it('stores audit entries with no TTL / expiry field (no automatic deletion)', async () => {
    const tenantId = `tenant-no-ttl-${Date.now()}`;
    const { id } = await writeAudit({
      tenantId,
      action: 'ban',
      actorEmail: 'ops@example.com',
      targetDeviceId: 'device-ttl',
      reason: 'No expiry expected',
    });

    const readerDb = freshFirestoreClient();
    const snap = await readerDb.collection(DEVICE_AUDIT_LOG_COLLECTION).doc(id).get();
    assert.strictEqual(snap.exists, true, 'audit entry should be persisted');

    const data = snap.data();
    // Requirement 17.3: entries are retained with no expiry period and no
    // automatic deletion, so none of the conventional TTL/expiry markers may be
    // present on the stored document.
    const ttlFieldNames = [
      'expiresAt',
      'expireAt',
      'expiry',
      'expires',
      'ttl',
      'timeToLive',
      'deleteAt',
      'purgeAt',
    ];
    for (const field of ttlFieldNames) {
      assert.strictEqual(
        data[field],
        undefined,
        `audit entry must not carry a "${field}" TTL/expiry field`,
      );
    }
  });
});
