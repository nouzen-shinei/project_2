// Feature: device-console-migration, Task 19.2 — Firestore security rules tests.
//
// Verifies the Stage 4 lockdown of the four device-tracking collections in the
// ACTUAL workspace-root `firestore.rules` (loaded verbatim below — never inlined):
//
//   - user_devices/{ownerEmail} (+ nested devices/**)
//   - device_bans/{banId}
//   - logout_signals/{signalId}
//   - deviceAuditLogs/**
//
// Both directions are asserted:
//   MUST-DENY  (Requirements 16.1 / 16.2): client-SDK privileged / cross-user
//     writes to the device collections are rejected.
//   MUST-ALLOW (Requirement 18 preserved runtime): the on-device
//     Device_Tracking_Runtime's legitimate reads and constrained self-writes
//     (presence/heartbeat, ban-enforcement bookkeeping, self-logout signal
//     consumption) still succeed.
//
// Harness: @firebase/rules-unit-testing (the standard Firestore rules test
// harness) against the Firestore emulator on 127.0.0.1:8080. Seeding of
// pre-existing docs uses the emulator-privileged `withSecurityRulesDisabled`
// admin context; the assertions themselves run through authenticated client
// contexts whose mock token carries `email` (+ uid) so `request.auth.token.email`
// matches the rules. If the emulator is unavailable (e.g. JDK missing) the whole
// suite SKIPS cleanly rather than failing.

import { readFileSync } from 'node:fs';
import net from 'node:net';
import { describe, it, before, after, beforeEach } from 'node:test';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  Timestamp,
} from 'firebase/firestore';

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
const BOB = { uid: 'uid-bob', email: 'bob@example.com' };

describe('firestore.rules — device-tracking collection lockdown (Req 16.1/16.2, 18)', { skip }, () => {
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

  // Authenticated client contexts — mock token carries `email` so the rules'
  // `request.auth.token.email` comparisons resolve.
  const aliceDb = () => testEnv.authenticatedContext(ALICE.uid, { email: ALICE.email }).firestore();
  const bobDb = () => testEnv.authenticatedContext(BOB.uid, { email: BOB.email }).firestore();

  // Emulator-privileged seeding for docs a test needs to pre-exist.
  const seed = (fn) =>
    testEnv.withSecurityRulesDisabled(async (ctx) => {
      await fn(ctx.firestore());
    });

  // ───────────────────────────── MUST-DENY (Req 16.1/16.2) ─────────────────

  describe('deviceAuditLogs — no client access of any kind', () => {
    it('DENIES a signed-in client create', async () => {
      const db = aliceDb();
      await assertFails(
        setDoc(doc(db, 'deviceAuditLogs/log-1'), {
          action: 'ban',
          actorEmail: 'attacker@example.com',
        }),
      );
    });

    it('DENIES a signed-in client read', async () => {
      await seed((db) =>
        setDoc(doc(db, 'deviceAuditLogs/log-seeded'), {
          action: 'ban',
          actorEmail: 'ops@example.com',
        }),
      );
      const db = aliceDb();
      await assertFails(getDoc(doc(db, 'deviceAuditLogs/log-seeded')));
    });
  });

  describe('device_bans — client cannot create/delete/tamper', () => {
    it('DENIES a client CREATE', async () => {
      const db = aliceDb();
      await assertFails(
        setDoc(doc(db, 'device_bans/fp-create'), {
          deviceFingerprint: 'fp-create',
          isActive: true,
          reason: 'self-issued ban',
          adminEmail: 'alice@example.com',
        }),
      );
    });

    it('DENIES a client DELETE', async () => {
      await seed((db) =>
        setDoc(doc(db, 'device_bans/fp-del'), {
          deviceFingerprint: 'fp-del',
          isActive: true,
          reason: 'seeded',
          lastChecked: Timestamp.now(),
        }),
      );
      const db = aliceDb();
      await assertFails(deleteDoc(doc(db, 'device_bans/fp-del')));
    });

    it('DENIES an admin-style self-unban (isActive:false on a NON-expired ban)', async () => {
      await seed((db) =>
        setDoc(doc(db, 'device_bans/fp-active'), {
          deviceFingerprint: 'fp-active',
          isActive: true,
          reason: 'active ban',
          // expires in the future → NOT expired → cannot be deactivated by a client
          expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
          lastChecked: Timestamp.now(),
        }),
      );
      const db = aliceDb();
      await assertFails(
        updateDoc(doc(db, 'device_bans/fp-active'), {
          isActive: false,
          expiredAt: Timestamp.now(),
        }),
      );
    });

    it('DENIES changing reason/target fields on a ban', async () => {
      await seed((db) =>
        setDoc(doc(db, 'device_bans/fp-active'), {
          deviceFingerprint: 'fp-active',
          isActive: true,
          reason: 'active ban',
          lastChecked: Timestamp.now(),
        }),
      );
      const db = aliceDb();
      await assertFails(
        updateDoc(doc(db, 'device_bans/fp-active'), { reason: 'tampered reason' }),
      );
    });
  });

  describe('logout_signals — backend-created; client limited to self-consume', () => {
    it('DENIES a client CREATE', async () => {
      const db = aliceDb();
      await assertFails(
        setDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`), {
          userEmail: ALICE.email,
          deviceId: 'dev-1',
          consumed: false,
        }),
      );
    });

    it('DENIES a client DELETE', async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`), {
          userEmail: ALICE.email,
          deviceId: 'dev-1',
          consumed: false,
        }),
      );
      const db = aliceDb();
      await assertFails(deleteDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`)));
    });

    it('DENIES updating fields other than consumed/consumedAt', async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`), {
          userEmail: ALICE.email,
          deviceId: 'dev-1',
          consumed: false,
        }),
      );
      const db = aliceDb();
      await assertFails(
        updateDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`), { userEmail: 'someone-else@example.com' }),
      );
    });

    it("DENIES updating ANOTHER user's signal", async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${BOB.email}_dev-9`), {
          userEmail: BOB.email,
          deviceId: 'dev-9',
          consumed: false,
        }),
      );
      const db = aliceDb();
      await assertFails(
        updateDoc(doc(db, `logout_signals/${BOB.email}_dev-9`), {
          consumed: true,
          consumedAt: Timestamp.now(),
        }),
      );
    });

    it("DENIES reading ANOTHER user's signal", async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${BOB.email}_dev-9`), {
          userEmail: BOB.email,
          deviceId: 'dev-9',
          consumed: false,
        }),
      );
      const db = aliceDb();
      await assertFails(getDoc(doc(db, `logout_signals/${BOB.email}_dev-9`)));
    });
  });

  describe('user_devices — no cross-user writes', () => {
    it("DENIES writing ANOTHER user's parent device doc", async () => {
      const db = aliceDb();
      await assertFails(
        setDoc(doc(db, `user_devices/${BOB.email}`), { lastSeen: Timestamp.now() }),
      );
    });

    it("DENIES writing ANOTHER user's nested devices/{id} doc", async () => {
      const db = aliceDb();
      await assertFails(
        setDoc(doc(db, `user_devices/${BOB.email}/devices/dev-1`), {
          isOnline: true,
          lastSeen: Timestamp.now(),
        }),
      );
    });
  });

  // ─────────────────────────── MUST-ALLOW (Req 18 runtime) ─────────────────

  describe('user_devices — owner self-writes and open reads', () => {
    it('ALLOWS a user to write their OWN parent device doc', async () => {
      const db = aliceDb();
      await assertSucceeds(
        setDoc(doc(db, `user_devices/${ALICE.email}`), {
          email: ALICE.email,
          lastSeen: Timestamp.now(),
        }),
      );
    });

    it('ALLOWS a user to write their OWN nested devices/{id} doc (presence/heartbeat)', async () => {
      const db = aliceDb();
      await assertSucceeds(
        setDoc(doc(db, `user_devices/${ALICE.email}/devices/dev-alice-1`), {
          isOnline: true,
          lastSeen: Timestamp.now(),
        }),
      );
    });

    it("ALLOWS reading device docs — own and a peer's (open-read enforcement query)", async () => {
      await seed(async (db) => {
        await setDoc(doc(db, `user_devices/${ALICE.email}`), { email: ALICE.email });
        await setDoc(doc(db, `user_devices/${BOB.email}`), { email: BOB.email });
      });
      const db = aliceDb();
      await assertSucceeds(getDoc(doc(db, `user_devices/${ALICE.email}`)));
      await assertSucceeds(getDoc(doc(db, `user_devices/${BOB.email}`)));
    });
  });

  describe('device_bans — enforcement reads and constrained self bookkeeping', () => {
    it('ALLOWS reading a ban (enforcement query)', async () => {
      await seed((db) =>
        setDoc(doc(db, 'device_bans/fp-active'), {
          deviceFingerprint: 'fp-active',
          isActive: true,
          reason: 'active ban',
          lastChecked: Timestamp.now(),
        }),
      );
      const db = aliceDb();
      await assertSucceeds(getDoc(doc(db, 'device_bans/fp-active')));
    });

    it('ALLOWS updating ONLY lastChecked on an active ban', async () => {
      await seed((db) =>
        setDoc(doc(db, 'device_bans/fp-active'), {
          deviceFingerprint: 'fp-active',
          isActive: true,
          reason: 'active ban',
          lastChecked: Timestamp.fromMillis(Date.now() - 10_000),
        }),
      );
      const db = aliceDb();
      await assertSucceeds(
        updateDoc(doc(db, 'device_bans/fp-active'), { lastChecked: Timestamp.now() }),
      );
    });

    it('ALLOWS deactivating a genuinely EXPIRED ban via {isActive:false, expiredAt}', async () => {
      await seed((db) =>
        setDoc(doc(db, 'device_bans/fp-expired'), {
          deviceFingerprint: 'fp-expired',
          isActive: true,
          reason: 'expired ban',
          // already in the past → server-verified expiry → deactivation permitted
          expiresAt: Timestamp.fromMillis(Date.now() - 60 * 1000),
          lastChecked: Timestamp.now(),
        }),
      );
      const db = aliceDb();
      await assertSucceeds(
        updateDoc(doc(db, 'device_bans/fp-expired'), {
          isActive: false,
          expiredAt: Timestamp.now(),
        }),
      );
    });
  });

  describe('logout_signals — self reads and self-consume', () => {
    it('ALLOWS reading own signal', async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`), {
          userEmail: ALICE.email,
          deviceId: 'dev-1',
          consumed: false,
        }),
      );
      const db = aliceDb();
      await assertSucceeds(getDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`)));
    });

    it('ALLOWS reading a non-existent signal (polling with no signal present)', async () => {
      const db = aliceDb();
      await assertSucceeds(getDoc(doc(db, `logout_signals/${ALICE.email}_missing`)));
    });

    it("ALLOWS updating own signal's {consumed, consumedAt}", async () => {
      await seed((db) =>
        setDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`), {
          userEmail: ALICE.email,
          deviceId: 'dev-1',
          consumed: false,
        }),
      );
      const db = aliceDb();
      await assertSucceeds(
        updateDoc(doc(db, `logout_signals/${ALICE.email}_dev-1`), {
          consumed: true,
          consumedAt: Timestamp.now(),
        }),
      );
    });
  });
});
