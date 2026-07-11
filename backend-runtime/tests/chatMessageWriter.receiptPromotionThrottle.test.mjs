// Feature: chat-production-hardening — receipt-promotion resilience + perf hardening (Part B)
// Throttle/coalesce receipt promotion on the devices/ping hot path.
//
// **Validates: receipt-promotion resilience + perf hardening (Part B — throttle)**
//
// PERFORMANCE TEST:
//   `devices/ping` fires `markPendingChatMessagesDeliveredForRecipient` on EVERY
//   ping (fire-and-forget), and each promotion enumerates ALL of the recipient's
//   conversations. Pings are frequent/bursty, so
//   `promotePendingDeliveryForRecipientThrottled` coalesces a burst for the same
//   (tenant, recipient) into AT MOST one underlying promotion per short window.
//   The raw function stays unthrottled for direct/test callers.
//
//   This drives the REAL compiled wrapper. A skipped (throttled) call resolves to
//   `null`; a call that actually promotes resolves to the promotion result
//   object. Each real promotion reads the recipient's Firestore devices exactly
//   once (the device cache is disabled under the test runner), so the device-read
//   count is a second, independent witness of how many underlying promotions ran.
//   Proves:
//     (a) N rapid calls within the window run the underlying promotion ONCE;
//     (b) a call after the window runs it again;
//     (c) distinct (tenant, recipient) keys are independent.

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal in-memory RTDB — the throttle only needs the promotion to run without
// throwing; it does no conversation work when there are no conversations.
function createInMemoryDatabase() {
  const store = {};
  const splitPath = (p) => String(p ?? '').split('/').filter((seg) => seg.length > 0);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const readNode = (segments) => {
    let cur = store;
    for (const seg of segments) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[seg];
    }
    return cur;
  };
  const makeSnapshot = (segments, key) => {
    const value = readNode(segments);
    return {
      key,
      exists: () => value !== undefined && value !== null,
      val: () => clone(value),
      forEach: () => false,
    };
  };
  const makeRef = (path) => {
    const segments = splitPath(path);
    const ref = {
      path,
      key: segments.length ? segments[segments.length - 1] : null,
      child: (sub) => makeRef(`${path}/${sub}`),
      async get() {
        return makeSnapshot(segments, ref.key);
      },
      async once() {
        return makeSnapshot(segments, ref.key);
      },
      async set() {},
      async update() {},
      push: () => makeRef(`${path}/-Mock${Math.random().toString(36).slice(2, 8)}`),
      async transaction(fn) {
        const next = fn(undefined);
        return { committed: next !== undefined, snapshot: makeSnapshot(segments, ref.key) };
      },
      orderByChild: () => ref,
      equalTo: () => ref,
      limitToLast: () => ref,
    };
    return ref;
  };
  return { ref: (path = '') => makeRef(path), __store: store };
}

let currentDb = createInMemoryDatabase();
let deviceReads = 0;

function makeOnlineDevice(tenantId) {
  return { tenantIds: [tenantId], isOnline: true, lastSeen: Date.now(), updatedAt: Date.now() };
}

// Every recipient is treated as online so a real promotion is meaningful; the
// device read is counted per actual resolve (cache is disabled under the runner).
const firestoreMock = () => {
  const makeCollection = (name) => ({
    doc: (id) => makeDoc(name, id),
    get: async () => {
      if (name.endsWith('/devices')) {
        deviceReads += 1;
        return { docs: [{ data: () => makeOnlineDevice(TENANT_A) }, { data: () => makeOnlineDevice(TENANT_B) }] };
      }
      return { docs: [] };
    },
  });
  const makeDoc = (col, id) => ({
    set: async () => {},
    get: async () => ({ exists: false, data: () => ({}) }),
    collection: (sub) => makeCollection(`${col}/${id}/${sub}`),
  });
  return { settings: () => {}, collection: (name) => makeCollection(name) };
};

const adminMock = {
  apps: [{}],
  database: () => currentDb,
  firestore: firestoreMock,
  credential: { cert: () => ({}), applicationDefault: () => ({}) },
  initializeApp: () => {},
  app: () => ({ delete: async () => {} }),
};
adminMock.default = adminMock;

const firebaseAdminPath = require.resolve('firebase-admin');
require.cache[firebaseAdminPath] = {
  id: firebaseAdminPath,
  filename: firebaseAdminPath,
  loaded: true,
  exports: adminMock,
};

const {
  promotePendingDeliveryForRecipientThrottled,
  __setReceiptPromotionThrottleMs,
  __resetReceiptPromotionThrottleMs,
  __resetReceiptStateCache,
} = await import('../dist/chatMessageWriter.js');

const TENANT_A = 'CGnHGq43PFF8WD2DJekx';
const TENANT_B = 'TenantBxxxxxxxxxxxxx';
const RECIPIENT_A = 'alice@example.com';
const RECIPIENT_B = 'bob@example.com';

function resetAll() {
  currentDb = createInMemoryDatabase();
  deviceReads = 0;
  __resetReceiptPromotionThrottleMs();
  __resetReceiptStateCache(); // keep the device cache disabled (test default)
}

describe('receipt-promotion resilience + perf (Part B) — promotePendingDeliveryForRecipientThrottled', () => {
  beforeEach(() => {
    resetAll();
  });

  it('coalesces N rapid calls for the same (tenant, recipient) into a single underlying promotion', async () => {
    __setReceiptPromotionThrottleMs(60000); // large window so all repeats are inside it

    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await promotePendingDeliveryForRecipientThrottled({ tenantId: TENANT_A, recipientEmail: RECIPIENT_A })
      );
    }

    const ran = results.filter((r) => r !== null);
    const skipped = results.filter((r) => r === null);
    assert.strictEqual(ran.length, 1, 'exactly one call actually promoted');
    assert.strictEqual(skipped.length, 5, 'the other five were coalesced (skipped)');
    // Independent witness: exactly one Firestore device read for one real run.
    assert.strictEqual(deviceReads, 1, 'underlying promotion ran once (one device read)');
    // The one that ran returned a real result object.
    assert.strictEqual(ran[0].recipientHasOnlineDevice, true);
  });

  it('runs again after the window elapses', async () => {
    __setReceiptPromotionThrottleMs(30); // small window

    const first = await promotePendingDeliveryForRecipientThrottled({ tenantId: TENANT_A, recipientEmail: RECIPIENT_A });
    const secondImmediate = await promotePendingDeliveryForRecipientThrottled({
      tenantId: TENANT_A,
      recipientEmail: RECIPIENT_A,
    });

    assert.notStrictEqual(first, null, 'first call promoted');
    assert.strictEqual(secondImmediate, null, 'immediate repeat inside the window was skipped');
    assert.strictEqual(deviceReads, 1);

    await sleep(70); // wait past the window

    const afterWindow = await promotePendingDeliveryForRecipientThrottled({
      tenantId: TENANT_A,
      recipientEmail: RECIPIENT_A,
    });
    assert.notStrictEqual(afterWindow, null, 'a call after the window promotes again');
    assert.strictEqual(deviceReads, 2, 'a second underlying promotion ran after the window');
  });

  it('treats distinct (tenant, recipient) keys independently', async () => {
    __setReceiptPromotionThrottleMs(60000); // large window

    const r1 = await promotePendingDeliveryForRecipientThrottled({ tenantId: TENANT_A, recipientEmail: RECIPIENT_A });
    const r2 = await promotePendingDeliveryForRecipientThrottled({ tenantId: TENANT_A, recipientEmail: RECIPIENT_B });
    const r3 = await promotePendingDeliveryForRecipientThrottled({ tenantId: TENANT_B, recipientEmail: RECIPIENT_A });

    // All three distinct keys promoted despite being inside the window.
    assert.notStrictEqual(r1, null);
    assert.notStrictEqual(r2, null);
    assert.notStrictEqual(r3, null);
    assert.strictEqual(deviceReads, 3, 'each distinct key ran its own promotion');

    // A repeat of an already-run key is still coalesced.
    const repeat = await promotePendingDeliveryForRecipientThrottled({ tenantId: TENANT_A, recipientEmail: RECIPIENT_A });
    assert.strictEqual(repeat, null, 'repeat of an existing key is skipped');
    assert.strictEqual(deviceReads, 3, 'no extra promotion for the coalesced repeat');
  });
});
