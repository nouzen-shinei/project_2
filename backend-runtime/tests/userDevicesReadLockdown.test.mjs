// Feature: device-push-fanout-migration, Task 14.2 — Firestore security-rules
// tests for the user_devices read lockdown + write non-regression.
//
// Verifies the Stage 4 tightening applied to the ACTUAL workspace-root
// `firestore.rules` (loaded verbatim below — never inlined), where the
// `user_devices/{ownerEmail}` parent doc and its nested `{devicePath=**}`
// subtree had their `read` rule changed from `isSignedIn()` to
// `isDeviceOwner(ownerEmail)` (Task 14.1). Both directions are asserted:
//
//   Owner-Only_Read (Req 8.2, 8.3, 10.1/10.2/10.4, 11.4):
//     - a signed-in NON-owner is DENIED a read of another user's
//       user_devices/{ownerEmail} parent doc (Req 8.2);
//     - a signed-in NON-owner is DENIED a read of that owner's
//       {devicePath=**} subtree — nested devices/{id} doc AND a devices
//       subcollection list query (Req 8.2);
//     - the owner IS GRANTED a read of their own parent doc AND their own
//       {devicePath=**} subtree (nested doc + subcollection list) (Req 8.3).
//
//   Write non-regression (Req 8.5, 11.5): the owner-only write rule and its
//     `doesNotWriteTenantIndex()` constraint are unchanged — an owner write of
//     a non-`tenantIndex` field is still ALLOWED, while a write that touches
//     `tenantIndex` is still DENIED.
//
//   Enforcement-read non-regression (Req 10.1/10.2/10.4, 11.5): the
//     `device_bans` and `logout_signals` rules are untouched — `device_bans`
//     reads by any signed-in caller still succeed, and `logout_signals`
//     self-reads (matched on `userEmail == request.auth.token.email`) plus
//     reads of an absent/non-existent signal doc still succeed.
//
// Harness matches tests/firestore-rules/deviceCollections.rules.test.mjs
// exactly: @firebase/rules-unit-testing against the Firestore emulator
// (project `demo-device-console`) on 127.0.0.1:8080 (or FIRESTORE_EMULATOR_HOST
// when set automatically under `firebase emulators:exec`). Pre-existing docs are
// seeded with the emulator-privileged `withSecurityRulesDisabled` admin context
// so ownership reads have data to read; the assertions themselves run through
// authenticated client contexts whose mock token carries `email` (+ uid) so the
// rules' `request.auth.token.email` comparisons resolve (device docs are keyed
// by the account EMAIL, and `isDeviceOwner` matches on that claim). The suite is
// gated on FIRESTORE_EMULATOR_HOST and SKIPS cleanly when it is unset.

import { readFileSync } from 'node:fs';
import { describe, it, before, after, beforeEach } from 'node:test';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  collection,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  Timestamp,
} from 'firebase/firestore';

// The real rules file at the workspace root (two levels up from this test file,
// which lives in backend-runtime/tests/).
const RULES_PATH = new URL('../../firestore.rules', import.meta.url);

// Gate on FIRESTORE_EMULATOR_HOST — set automatically under
// `firebase emulators:exec`. When unset the whole suite SKIPS cleanly rather
// than touching a live datastore or hard-failing in an emulator-less sandbox.
const EMULATOR_HOST = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
const skip = EMULATOR_HOST
  ? false
  : 'FIRESTORE_EMULATOR_HOST not set — Firestore emulator unavailable';

// Resolve host/port from FIRESTORE_EMULATOR_HOST, defaulting to the
// repo-standard 127.0.0.1:8080.
function parseEmulatorHost() {
  const raw = EMULATOR_HOST;
  if (raw) {
    const withoutProto = raw.replace(/^https?:\/\//, '');
    const idx = withoutProto.lastIndexOf(':');
    if (idx > -1) {
      const host = withoutProto.slice(0, idx) || '127.0.0.1';
      const port = Number(withoutProto.slice(idx + 1));
      if (Number.isFinite(port)) return { host, port };
    }
  }
  return { host: '127.0.0.1', port: 8080 };
}

const { host: EMU_HOST, port: EMU_PORT } = parseEmulatorHost();

// The owner of the device tree under test, and a signed-in non-owner intruder.
const OWNER = { uid: 'uid-owner', email: 'owner@example.com' };
const INTRUDER = { uid: 'uid-intruder', email: 'intruder@example.com' };

const DEVICE_ID = 'dev-owner-1';

describe('firestore.rules — user_devices read lockdown to owner-only (Req 8.2/8.3/8.5, 10, 11.4/11.5)', { skip }, () => {
  let testEnv;

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: process.env.GCLOUD_PROJECT || 'demo-device-console',
      firestore: {
        host: EMU_HOST,
        port: EMU_PORT,
        rules: readFileSync(RULES_PATH, 'utf8'),
      },
    });
  });

  after(async () => {
    if (testEnv) await testEnv.cleanup();
  });

  beforeEach(async () => {
    if (testEnv) await testEnv.clearFirestore();
  });

  // Authenticated client contexts — the mock token carries `email` so the
  // rules' `isDeviceOwner(ownerEmail)` / `request.auth.token.email` comparisons
  // resolve. Device docs are keyed by the account EMAIL.
  const ownerDb = () =>
    testEnv.authenticatedContext(OWNER.uid, { email: OWNER.email }).firestore();
  const intruderDb = () =>
    testEnv.authenticatedContext(INTRUDER.uid, { email: INTRUDER.email }).firestore();

  // Emulator-privileged seeding for docs a test needs to pre-exist (bypasses
  // the security rules so ownership reads have real data to read).
  const seed = (fn) =>
    testEnv.withSecurityRulesDisabled(async (ctx) => {
      await fn(ctx.firestore());
    });

  const parentPath = (email) => `user_devices/${email}`;
  const devicePath = (email, deviceId = DEVICE_ID) =>
    `user_devices/${email}/devices/${deviceId}`;
  const devicesCollPath = (email) => `user_devices/${email}/devices`;

  // Seed the owner's parent doc + one nested device doc.
  const seedOwnerTree = () =>
    seed(async (db) => {
      await setDoc(doc(db, parentPath(OWNER.email)), {
        email: OWNER.email,
        lastSeen: Timestamp.now(),
      });
      await setDoc(doc(db, devicePath(OWNER.email)), {
        deviceId: DEVICE_ID,
        ownerEmail: OWNER.email,
        isOnline: true,
        lastSeen: Timestamp.now(),
        tenantIds: ['tenant-a'],
      });
    });

  // ─────────────── Owner-Only_Read: NON-owner is DENIED (Req 8.2) ───────────

  describe("a signed-in non-owner cannot read another user's user_devices", () => {
    it("DENIES reading another user's user_devices/{ownerEmail} parent doc (Req 8.2)", async () => {
      await seedOwnerTree();
      const db = intruderDb();
      await assertFails(getDoc(doc(db, parentPath(OWNER.email))));
    });

    it("DENIES reading another user's nested {devicePath=**} devices/{id} doc (Req 8.2)", async () => {
      await seedOwnerTree();
      const db = intruderDb();
      await assertFails(getDoc(doc(db, devicePath(OWNER.email))));
    });

    it("DENIES listing another user's {devicePath=**} devices subcollection (Req 8.2)", async () => {
      await seedOwnerTree();
      const db = intruderDb();
      await assertFails(getDocs(collection(db, devicesCollPath(OWNER.email))));
    });
  });

  // ─────────────── Owner-Only_Read: OWNER is GRANTED (Req 8.3) ──────────────

  describe('the owner can read their own user_devices tree', () => {
    it('ALLOWS reading their own user_devices/{ownerEmail} parent doc (Req 8.3)', async () => {
      await seedOwnerTree();
      const db = ownerDb();
      await assertSucceeds(getDoc(doc(db, parentPath(OWNER.email))));
    });

    it('ALLOWS reading their own nested {devicePath=**} devices/{id} doc (Req 8.3)', async () => {
      await seedOwnerTree();
      const db = ownerDb();
      await assertSucceeds(getDoc(doc(db, devicePath(OWNER.email))));
    });

    it('ALLOWS listing their own {devicePath=**} devices subcollection (Req 8.3)', async () => {
      await seedOwnerTree();
      const db = ownerDb();
      await assertSucceeds(getDocs(collection(db, devicesCollPath(OWNER.email))));
    });
  });

  // ─────────── Write non-regression: owner write rule unchanged (Req 8.5) ───

  describe('owner-only write rule + doesNotWriteTenantIndex() unchanged (Req 8.5, 11.5)', () => {
    it('ALLOWS an owner CREATE of a non-tenantIndex field (presence/heartbeat)', async () => {
      const db = ownerDb();
      await assertSucceeds(
        setDoc(doc(db, devicePath(OWNER.email)), {
          deviceId: DEVICE_ID,
          isOnline: true,
          lastSeen: Timestamp.now(),
        }),
      );
    });

    it('ALLOWS an owner UPDATE of a non-tenantIndex field', async () => {
      await seedOwnerTree();
      const db = ownerDb();
      await assertSucceeds(
        updateDoc(doc(db, devicePath(OWNER.email)), {
          isOnline: false,
          lastSeen: Timestamp.now(),
        }),
      );
    });

    it('DENIES an owner UPDATE that touches tenantIndex', async () => {
      await seedOwnerTree();
      const db = ownerDb();
      await assertFails(
        updateDoc(doc(db, devicePath(OWNER.email)), { tenantIndex: ['tenant-a'] }),
      );
    });

    it('DENIES an owner CREATE that carries tenantIndex', async () => {
      const db = ownerDb();
      await assertFails(
        setDoc(doc(db, devicePath(OWNER.email, 'dev-owner-2')), {
          deviceId: 'dev-owner-2',
          isOnline: true,
          tenantIndex: ['tenant-a'],
        }),
      );
    });
  });

  // ─────────── device_bans non-regression: signed-in reads succeed (Req 10.1) ──

  describe('device_bans reads by any signed-in caller still succeed (Req 10.1, 11.5)', () => {
    it('ALLOWS a signed-in non-owner to read an active ban (enforcement query)', async () => {
      await seed((db) =>
        setDoc(doc(db, 'device_bans/fp-active'), {
          deviceFingerprint: 'fp-active',
          isActive: true,
          reason: 'active ban',
          lastChecked: Timestamp.now(),
        }),
      );
      const db = intruderDb();
      await assertSucceeds(getDoc(doc(db, 'device_bans/fp-active')));
    });

    it('ALLOWS a signed-in caller to read a non-existent ban doc', async () => {
      const db = ownerDb();
      await assertSucceeds(getDoc(doc(db, 'device_bans/fp-missing')));
    });
  });

  // ─────────── logout_signals non-regression: self + absent reads (Req 10.2/10.4) ──

  describe('logout_signals self-reads and absent-doc reads still succeed (Req 10.2/10.4, 11.5)', () => {
    it('ALLOWS reading own signal (matched on userEmail == token.email)', async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${OWNER.email}_${DEVICE_ID}`), {
          userEmail: OWNER.email,
          deviceId: DEVICE_ID,
          consumed: false,
        }),
      );
      const db = ownerDb();
      await assertSucceeds(getDoc(doc(db, `logout_signals/${OWNER.email}_${DEVICE_ID}`)));
    });

    it('ALLOWS reading a non-existent signal (polling with no signal present)', async () => {
      const db = ownerDb();
      await assertSucceeds(getDoc(doc(db, `logout_signals/${OWNER.email}_absent`)));
    });

    it("DENIES reading ANOTHER user's signal (self-scoping intact)", async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${OWNER.email}_${DEVICE_ID}`), {
          userEmail: OWNER.email,
          deviceId: DEVICE_ID,
          consumed: false,
        }),
      );
      const db = intruderDb();
      await assertFails(getDoc(doc(db, `logout_signals/${OWNER.email}_${DEVICE_ID}`)));
    });
  });
});
