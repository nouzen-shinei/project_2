// Feature: chat-production-hardening — receipt-promotion resilience + perf hardening (Part C)
// Short-TTL in-memory cache for device receipt-state reads.
//
// **Validates: receipt-promotion resilience + perf hardening (Part C — device receipt-state cache)**
//
// PERFORMANCE TEST:
//   `resolveRecipientDeviceReceiptState` reads ALL of the recipient's Firestore
//   device docs on EVERY receipt sync/promotion. Under bursty pings/syncs this is
//   a lot of redundant reads because device presence does not change sub-second.
//   A short-TTL cache keyed by `${tenantId}::${recipient}::${partner}` returns the
//   cached state within the window. The partner is part of the key because the
//   FOCUS count is partner-scoped — a cached entry for one partner must never be
//   served for a different partner.
//
//   This exercises the cache through the REAL compiled `syncChatConversationReceipts`
//   (which calls `resolveRecipientDeviceReceiptState(tenant, actor, partner)`),
//   counting Firestore device-collection reads. Proves:
//     (a) N calls within the TTL read Firestore devices ONCE;
//     (b) after the TTL, it reads again;
//     (c) different partner keys are NOT conflated (each partner triggers its
//         own read; the cache hit only applies within the same partner key).

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal in-memory RTDB — `syncChatConversationReceipts` with no targets and no
// markConversationDelivered does no conversation reads; it only resolves the
// device receipt-state and returns.
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
// Count device-collection reads keyed by the recipient/actor email they were for.
let deviceReadsByEmail = new Map();

function totalDeviceReads() {
  let total = 0;
  for (const n of deviceReadsByEmail.values()) total += n;
  return total;
}

function makeFocusedDevice(tenantId, partnerEmail) {
  return {
    tenantIds: [tenantId],
    isOnline: true,
    lastSeen: Date.now(),
    updatedAt: Date.now(),
    activeChatIsFocused: true,
    activeChatPartner: partnerEmail,
    activeChatLastSeenAt: Date.now(),
  };
}

const firestoreMock = () => {
  const makeCollection = (name, parentDocId) => ({
    doc: (id) => makeDoc(name, id),
    get: async () => {
      if (name.endsWith('/devices')) {
        const email = String(parentDocId || '').trim().toLowerCase();
        deviceReadsByEmail.set(email, (deviceReadsByEmail.get(email) || 0) + 1);
        // One online device focused on PARTNER_A (so focus state differs per partner).
        return { docs: [{ data: () => makeFocusedDevice(TENANT_ID, PARTNER_A) }] };
      }
      return { docs: [] };
    },
  });
  const makeDoc = (col, id) => ({
    set: async () => {},
    get: async () => ({ exists: false, data: () => ({}) }),
    collection: (sub) => makeCollection(`${col}/${id}/${sub}`, id),
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
  syncChatConversationReceipts,
  __setReceiptStateCacheTtlMs,
  __resetReceiptStateCache,
  __resetReceiptPromotionThrottleMs,
} = await import('../dist/chatMessageWriter.js');

const TENANT_ID = 'CGnHGq43PFF8WD2DJekx';
const ACTOR = 'actor@example.com';
const PARTNER_A = 'partner-a@example.com';
const PARTNER_B = 'partner-b@example.com';

function resetAll() {
  currentDb = createInMemoryDatabase();
  deviceReadsByEmail = new Map();
  __resetReceiptStateCache();
  __resetReceiptPromotionThrottleMs();
}

// A minimal receipt sync that only resolves the device receipt-state (no targets,
// no markConversationDelivered) so the ONLY Firestore work is the device read.
function syncFor(partnerEmail) {
  return syncChatConversationReceipts({ tenantId: TENANT_ID, actorEmail: ACTOR, partnerEmail });
}

describe('receipt-promotion resilience + perf (Part C) — device receipt-state cache', () => {
  beforeEach(() => {
    resetAll();
  });

  it('reads Firestore devices ONCE for N calls within the TTL', async () => {
    __setReceiptStateCacheTtlMs(60000); // large TTL so all repeats are cache hits

    for (let i = 0; i < 5; i++) {
      await syncFor(PARTNER_A);
    }

    assert.strictEqual(
      deviceReadsByEmail.get(ACTOR) || 0,
      1,
      'devices were read exactly once for 5 calls within the TTL'
    );
    assert.strictEqual(totalDeviceReads(), 1);
  });

  it('reads Firestore devices again after the TTL expires', async () => {
    __setReceiptStateCacheTtlMs(30); // small TTL

    await syncFor(PARTNER_A);
    await syncFor(PARTNER_A);
    assert.strictEqual(deviceReadsByEmail.get(ACTOR) || 0, 1, 'first read caches within the window');

    await sleep(70); // wait past the TTL

    await syncFor(PARTNER_A);
    assert.strictEqual(deviceReadsByEmail.get(ACTOR) || 0, 2, 'a fresh Firestore read happens after the TTL');
  });

  it('does NOT conflate different partner keys (focus count is partner-scoped)', async () => {
    __setReceiptStateCacheTtlMs(60000); // large TTL

    // Partner A: device IS focused on A → focused count 1.
    const resultA = await syncFor(PARTNER_A);
    assert.strictEqual(deviceReadsByEmail.get(ACTOR) || 0, 1);
    assert.strictEqual(resultA.actorHasFocusedChatDevice, true, 'device is focused on partner A');

    // Partner B: DIFFERENT cache key → a fresh read; device is NOT focused on B.
    const resultB = await syncFor(PARTNER_B);
    assert.strictEqual(deviceReadsByEmail.get(ACTOR) || 0, 2, 'different partner triggers its own read (not conflated)');
    assert.strictEqual(resultB.actorHasFocusedChatDevice, false, 'not focused on partner B — A\'s state was not reused');

    // Re-query partner A within the TTL → served from A's cache (no new read),
    // and the focused state is A's (not B's), proving the entries are separate.
    const resultA2 = await syncFor(PARTNER_A);
    assert.strictEqual(deviceReadsByEmail.get(ACTOR) || 0, 2, 'partner A re-query is a cache hit (no new read)');
    assert.strictEqual(resultA2.actorHasFocusedChatDevice, true, 'partner A cache entry preserved its own focus state');
  });
});
