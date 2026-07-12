// Feature: device-tenant-index, Task 10.3 — Firestore rules test for the
// `tenantIndex` client-write protection (Requirements 5.3, 5.4).
//
// Verifies the constraint added to the ACTUAL workspace-root `firestore.rules`
// (loaded verbatim below — never inlined) via the `doesNotWriteTenantIndex()`
// helper applied to the `user_devices/{ownerEmail}` doc and its nested
// `{devicePath=**}` (device subcollection) write rules:
//
//   MUST-DENY (Req 5.3): an owner client-SDK write that CREATES or CHANGES the
//     denormalized `tenantIndex` field on their OWN device doc is rejected —
//     that field is maintained exclusively by the Admin SDK (ping/backfill).
//   MUST-ALLOW (Req 5.4): an owner presence/registration self-write of every
//     OTHER field (no `tenantIndex` in the payload) still succeeds, preserving
//     the device-console-migration lockdown's permitted runtime self-writes.
//
// Harness matches deviceCollections.rules.test.mjs exactly:
//   @firebase/rules-unit-testing against the Firestore emulator on
//   127.0.0.1:8080 (or FIRESTORE_EMULATOR_HOST). Pre-existing docs are seeded
//   with the emulator-privileged withSecurityRulesDisabled admin context;
//   assertions run through an authenticated client context whose mock token
//   carries `email` (+ uid) so `request.auth.token.email` matches the rules.
//   If the emulator is unavailable (e.g. JDK missing) the suite SKIPS cleanly.

import { readFileSync } from 'node:fs';
import net from 'node:net';
import { describe, it, before, after, beforeEach } from 'node:test';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, deleteDoc, Timestamp } from 'firebase/firestore';

// The real rules file at the workspace root (two levels up from this test).
const RULES_PATH = new URL('../../firestore.rules', import.meta.url);

// Resolve the emulator host/port from FIRESTORE_EMULATOR_HOST when present
// (set automatically under `firebase emulators:exec`), else default to the
// repo-standard 127.0.0.1:8080.
function parseEmulatorHost() {
  const raw = (process.env.FIRESTORE_EMULATOR_HOST || '').trim();
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

// Best-effort TCP reachability probe used as the skip gate — keeps the suite
// green in environments without the emulator / JDK instead of hard-failing.
function canReach(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

const { host: EMU_HOST, port: EMU_PORT } = parseEmulatorHost();
const reachable = await canReach(EMU_HOST, EMU_PORT);
const skip = reachable
  ? false
  : `Firestore emulator not reachable at ${EMU_HOST}:${EMU_PORT} — skipping rules tests`;

const ALICE = { uid: 'uid-alice', email: 'alice@example.com' };

describe('firestore.rules — tenantIndex client-write protection (Req 5.3/5.4)', { skip }, () => {
  let testEnv;

  before(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: process.env.GCLOUD_PROJECT || 'demo-device-console-rules',
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

  // Authenticated client context — mock token carries `email` so the rules'
  // `request.auth.token.email` comparisons resolve.
  const aliceDb = () => testEnv.authenticatedContext(ALICE.uid, { email: ALICE.email }).firestore();

  // Emulator-privileged seeding for docs a test needs to pre-exist.
  const seed = (fn) =>
    testEnv.withSecurityRulesDisabled(async (ctx) => {
      await fn(ctx.firestore());
    });

  const deviceRef = (db) => doc(db, `user_devices/${ALICE.email}/devices/dev-alice-1`);
  const parentRef = (db) => doc(db, `user_devices/${ALICE.email}`);

  // ───────────────────────────── MUST-DENY (Req 5.3) ───────────────────────

  describe('nested devices/{id} — client cannot create/alter tenantIndex on OWN doc', () => {
    it('DENIES a CREATE that carries tenantIndex', async () => {
      const db = aliceDb();
      await assertFails(
        setDoc(deviceRef(db), {
          isOnline: true,
          lastSeen: Timestamp.now(),
          tenantIndex: ['tenant-a'],
        }),
      );
    });

    it('DENIES an UPDATE that adds tenantIndex to an existing doc', async () => {
      await seed((db) =>
        setDoc(deviceRef(db), {
          isOnline: true,
          lastSeen: Timestamp.now(),
          tenantIds: ['tenant-a'],
        }),
      );
      const db = aliceDb();
      await assertFails(updateDoc(deviceRef(db), { tenantIndex: ['tenant-a'] }));
    });

    it('DENIES an UPDATE that CHANGES an existing tenantIndex', async () => {
      await seed((db) =>
        setDoc(deviceRef(db), {
          isOnline: true,
          lastSeen: Timestamp.now(),
          tenantIds: ['tenant-a'],
          tenantIndex: ['tenant-a'],
        }),
      );
      const db = aliceDb();
      await assertFails(
        updateDoc(deviceRef(db), { tenantIndex: ['tenant-a', 'tenant-evil'] }),
      );
    });

    it('DENIES a merge SET that alters tenantIndex alongside a legit field', async () => {
      await seed((db) =>
        setDoc(deviceRef(db), {
          isOnline: false,
          tenantIndex: ['tenant-a'],
        }),
      );
      const db = aliceDb();
      await assertFails(
        setDoc(
          deviceRef(db),
          { isOnline: true, lastSeen: Timestamp.now(), tenantIndex: ['tenant-a', 'tenant-b'] },
          { merge: true },
        ),
      );
    });
  });

  describe('parent user_devices/{ownerEmail} doc — same tenantIndex protection', () => {
    it('DENIES a CREATE that carries tenantIndex on the parent doc', async () => {
      const db = aliceDb();
      await assertFails(
        setDoc(parentRef(db), {
          email: ALICE.email,
          lastSeen: Timestamp.now(),
          tenantIndex: ['tenant-a'],
        }),
      );
    });

    it('DENIES an UPDATE that adds tenantIndex on the parent doc', async () => {
      await seed((db) => setDoc(parentRef(db), { email: ALICE.email }));
      const db = aliceDb();
      await assertFails(updateDoc(parentRef(db), { tenantIndex: ['tenant-a'] }));
    });
  });

  // ─────────────────────────── MUST-ALLOW (Req 5.4) ────────────────────────

  describe('owner self-writes of OTHER fields (no tenantIndex) stay permitted', () => {
    it('ALLOWS a presence/heartbeat write with no tenantIndex (nested doc)', async () => {
      const db = aliceDb();
      await assertSucceeds(
        setDoc(deviceRef(db), { isOnline: true, lastSeen: Timestamp.now() }),
      );
    });

    it('ALLOWS a registration-style self-write of scope source fields (no tenantIndex)', async () => {
      const db = aliceDb();
      await assertSucceeds(
        setDoc(deviceRef(db), {
          deviceId: 'dev-alice-1',
          isOnline: true,
          lastSeen: Timestamp.now(),
          tenantIds: ['tenant-a', 'tenant-b'],
          activeTenantId: 'tenant-a',
          tenantMemberships: [{ tenantId: 'tenant-a', role: 'staff', status: 'active' }],
        }),
      );
    });

    it('ALLOWS an UPDATE of other fields while leaving an existing tenantIndex untouched', async () => {
      await seed((db) =>
        setDoc(deviceRef(db), {
          isOnline: false,
          tenantIds: ['tenant-a'],
          tenantIndex: ['tenant-a'],
        }),
      );
      const db = aliceDb();
      await assertSucceeds(
        updateDoc(deviceRef(db), { isOnline: true, lastSeen: Timestamp.now() }),
      );
    });

    it('ALLOWS the owner to DELETE their own device doc (whole doc, incl. index)', async () => {
      await seed((db) =>
        setDoc(deviceRef(db), { isOnline: false, tenantIndex: ['tenant-a'] }),
      );
      const db = aliceDb();
      await assertSucceeds(deleteDoc(deviceRef(db)));
    });

    it('ALLOWS a parent-doc self-write with no tenantIndex', async () => {
      const db = aliceDb();
      await assertSucceeds(
        setDoc(parentRef(db), { email: ALICE.email, lastSeen: Timestamp.now() }),
      );
    });
  });
});
