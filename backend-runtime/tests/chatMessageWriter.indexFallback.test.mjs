// Feature: chat-production-hardening — receipt-promotion resilience + perf hardening (Part A)
// Index-not-defined graceful fallback for the bounded receipt/delivery queries.
//
// **Validates: receipt-promotion resilience (Part A — index-not-defined fallback)**
//
// LIVE-ERROR REGRESSION TEST:
//   In production the ping receipt promotion hard-failed with
//     "[devices/ping] receipt promotion failed { error: 'Index not defined,
//      add ".indexOn": "delivered", ... }"
//   because `markPendingChatMessagesDeliveredForRecipient` (and
//   `syncChatConversationReceipts` when `markConversationDelivered`) run
//   `orderByChild('delivered').equalTo(false)` and the `.indexOn` rule — although
//   present in database.rules.json — had not yet been DEPLOYED, so the Admin SDK
//   threw on every bounded query.
//
//   The fix routes those bounded queries through
//   `getConversationMessagesByIndexedField`, which catches the
//   "Index not defined" error and falls back to a SINGLE bounded read of the
//   conversation node, filtering children in memory to the same strict-equality
//   subset the index would have returned. Semantics are identical; the fallback
//   self-heals to the fast indexed path once the rules deploy.
//
//   This test drives the REAL compiled write paths against a functional in-memory
//   Realtime Database whose filtered `.get()` can be toggled to THROW
//   "Index not defined" (simulating a stale/undeployed index) while the plain
//   node `.get()` still works, so it proves:
//     (a) with the index present, the bounded indexed path is used (no node
//         fallback read);
//     (b) with the index missing, promotion STILL marks exactly the correct
//         undelivered-incoming subset via the bounded node fallback; and
//     (c) both `markPendingChatMessagesDeliveredForRecipient` and the
//         `markConversationDelivered` branch of `syncChatConversationReceipts`
//         are covered.

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory Realtime Database with a FUNCTIONAL query layer + a toggle that
// makes filtered `conversationMessages` `.get()` calls throw "Index not defined"
// (as the Admin SDK does when the `.indexOn` rule is not deployed).
// ---------------------------------------------------------------------------
let telemetry;
let indexAvailable = true; // when false, filtered conversation gets throw

function resetTelemetry() {
  telemetry = {
    filteredConversationGets: [], // { conv, field } — bounded indexed attempts
    fullConversationGets: [], // conv — unfiltered node reads (fallback path)
  };
}

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

  const writeNode = (segments, value) => {
    if (segments.length === 0) return;
    let cur = store;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (cur[seg] == null || typeof cur[seg] !== 'object') {
        cur[seg] = {};
      }
      cur = cur[seg];
    }
    if (value === undefined) {
      delete cur[segments[segments.length - 1]];
    } else {
      cur[segments[segments.length - 1]] = value;
    }
  };

  let pushCounter = 0;

  const isConversationNode = (segments) =>
    segments.length === 4 && segments[0] === 'tenantChat' && segments[2] === 'conversationMessages';

  const applyFilter = (node, filter) => {
    if (!filter || !filter.hasValue || node == null || typeof node !== 'object') {
      return node;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && v[filter.field] === filter.value) {
        out[k] = v;
      }
    }
    return out;
  };

  const makeSnapshot = (segments, key, filter) => {
    const rawValue = readNode(segments);
    const value = applyFilter(rawValue, filter);
    const filtered = Boolean(filter && filter.hasValue);
    return {
      key,
      exists: () => {
        if (value === undefined || value === null) return false;
        if (filtered && typeof value === 'object') return Object.keys(value).length > 0;
        return true;
      },
      val: () => clone(value),
      forEach: (cb) => {
        if (value && typeof value === 'object') {
          for (const childKey of Object.keys(value)) {
            const stop = cb(makeSnapshot([...segments, childKey], childKey, null));
            if (stop === true) return true;
          }
        }
        return false;
      },
    };
  };

  const makeRef = (path, filter) => {
    const segments = splitPath(path);
    const ref = {
      path,
      key: segments.length ? segments[segments.length - 1] : null,
      child(sub) {
        return makeRef(`${path}/${sub}`, null);
      },
      push() {
        pushCounter += 1;
        const key = `-Mock${String(pushCounter).padStart(6, '0')}${Math.random().toString(36).slice(2, 6)}`;
        return makeRef(`${path}/${key}`, null);
      },
      async set(value) {
        writeNode(splitPath(path), clone(value));
      },
      async update(patch) {
        const segs = splitPath(path);
        const existing = readNode(segs);
        const base = existing && typeof existing === 'object' ? existing : {};
        writeNode(segs, { ...base, ...clone(patch) });
      },
      async get() {
        const active = filter && filter.hasValue;
        if (isConversationNode(segments)) {
          if (active) {
            telemetry.filteredConversationGets.push({ conv: segments[3], field: filter.field });
            if (!indexAvailable) {
              // Mirror the Admin SDK error for a missing/undeployed `.indexOn`.
              throw new Error(
                `Index not defined, add ".indexOn": "${filter.field}", for path ` +
                  `"/tenantChat/${segments[1]}/conversationMessages/${segments[3]}", to the rules`
              );
            }
          } else {
            telemetry.fullConversationGets.push(segments[3]);
          }
        }
        return makeSnapshot(segments, ref.key, filter);
      },
      async once() {
        return ref.get();
      },
      async transaction(fn) {
        const segs = splitPath(path);
        const current = clone(readNode(segs));
        const next = fn(current);
        const committed = next !== undefined;
        if (committed) {
          writeNode(segs, clone(next));
        }
        return { committed, snapshot: makeSnapshot(segs, ref.key, null) };
      },
      orderByChild(field) {
        return makeRef(path, { field, value: undefined, hasValue: false });
      },
      equalTo(value) {
        return makeRef(path, { field: filter ? filter.field : undefined, value, hasValue: true });
      },
      limitToLast() {
        return ref;
      },
    };
    return ref;
  };

  return {
    ref: (path = '') => makeRef(path, null),
    __store: store,
  };
}

let currentDb = createInMemoryDatabase();
let onlineRecipients = new Set();

function makeOnlineDevice(tenantId) {
  return { tenantIds: [tenantId], isOnline: true, lastSeen: Date.now(), updatedAt: Date.now() };
}

const firestoreMock = () => {
  const makeCollection = (name, parentDocId) => ({
    doc: (id) => makeDoc(name, id),
    get: async () => {
      if (name.endsWith('/devices')) {
        const email = String(parentDocId || '').trim().toLowerCase();
        const devices = onlineRecipients.has(email) ? [makeOnlineDevice(TENANT_ID)] : [];
        return { docs: devices.map((d) => ({ data: () => d })) };
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
  sendChatMessage,
  markPendingChatMessagesDeliveredForRecipient,
  syncChatConversationReceipts,
  __resetIndexFallbackWarnings,
} = await import('../dist/chatMessageWriter.js');

const TENANT_ID = 'CGnHGq43PFF8WD2DJekx';
const RECIPIENT = 'recipient@example.com';
const PARTNER = 'sender@example.com';

function sanitizeKey(email) {
  return email.trim().toLowerCase().replace(/[.@]/g, '_');
}
function conversationKeyOf(a, b) {
  return [sanitizeKey(a), sanitizeKey(b)].sort().join('__');
}
function getStore() {
  return currentDb.__store;
}
function conversationMessages(convKey) {
  return getStore()?.tenantChat?.[TENANT_ID]?.conversationMessages?.[convKey] ?? {};
}

function resetAll() {
  currentDb = createInMemoryDatabase();
  onlineRecipients = new Set();
  indexAvailable = true;
  resetTelemetry();
  __resetIndexFallbackWarnings();
}

describe('receipt-promotion resilience (Part A) — index-not-defined fallback for markPendingChatMessagesDeliveredForRecipient', () => {
  beforeEach(() => {
    resetAll();
  });

  it('uses the bounded INDEXED path when the delivered index is present (no node fallback read)', async () => {
    onlineRecipients.add(RECIPIENT);
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'A1' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'A2' });

    indexAvailable = true;
    resetTelemetry();

    const result = await markPendingChatMessagesDeliveredForRecipient({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
    });

    assert.strictEqual(result.deliveredCount, 2, 'both incoming messages delivered');
    // The bounded delivered==false query succeeded → no unfiltered node fallback.
    assert.ok(
      telemetry.filteredConversationGets.some((q) => q.field === 'delivered'),
      'bounded delivered index query was used'
    );
    assert.strictEqual(
      telemetry.fullConversationGets.length,
      0,
      'no unfiltered node fallback read when the index is present'
    );
  });

  it('falls back to the bounded node read and marks the correct subset when the delivered index is NOT deployed', async () => {
    onlineRecipients.add(RECIPIENT);
    const conv = conversationKeyOf(PARTNER, RECIPIENT);

    // 2 undelivered incoming (partner -> recipient).
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'A1' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'A2' });
    // 1 outgoing (recipient -> partner) — must never be delivered on recipient's behalf.
    await sendChatMessage({ senderEmail: RECIPIENT, recipientEmail: PARTNER, tenantId: TENANT_ID, text: 'outgoing' });

    // Simulate the undeployed index: filtered conversation gets now throw.
    indexAvailable = false;
    resetTelemetry();

    const result = await markPendingChatMessagesDeliveredForRecipient({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
    });

    // Correctness preserved: exactly the 2 undelivered INCOMING messages.
    assert.strictEqual(result.deliveredCount, 2, 'the 2 undelivered incoming messages are still delivered via fallback');

    // The indexed attempt was made (and threw), then a bounded node fallback read happened.
    assert.ok(
      telemetry.filteredConversationGets.some((q) => q.field === 'delivered'),
      'bounded delivered index query was attempted first'
    );
    assert.ok(
      telemetry.fullConversationGets.includes(conv),
      'node fallback read engaged for the conversation'
    );

    const msgs = conversationMessages(conv);
    const incoming = Object.values(msgs).filter((m) => m.text === 'A1' || m.text === 'A2');
    assert.strictEqual(incoming.length, 2);
    for (const m of incoming) {
      assert.strictEqual(m.delivered, true, 'incoming message delivered via fallback');
    }
    const outgoing = Object.values(msgs).find((m) => m.text === 'outgoing');
    assert.strictEqual(outgoing.delivered, false, "recipient's own outgoing message is never delivered");

    // Idempotent re-run over the fallback path.
    const second = await markPendingChatMessagesDeliveredForRecipient({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
    });
    assert.strictEqual(second.deliveredCount, 0, 're-run delivers nothing (idempotent) even on the fallback path');
  });
});

describe('receipt-promotion resilience (Part A) — index-not-defined fallback for syncChatConversationReceipts (markConversationDelivered)', () => {
  beforeEach(() => {
    resetAll();
  });

  it('marks the conversation\'s undelivered incoming messages delivered via the node fallback when the index is NOT deployed', async () => {
    onlineRecipients.add(RECIPIENT);
    const conv = conversationKeyOf(PARTNER, RECIPIENT);

    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'm1' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'm2' });
    await sendChatMessage({ senderEmail: RECIPIENT, recipientEmail: PARTNER, tenantId: TENANT_ID, text: 'mine' });

    indexAvailable = false;
    resetTelemetry();

    const result = await syncChatConversationReceipts({
      tenantId: TENANT_ID,
      actorEmail: RECIPIENT,
      partnerEmail: PARTNER,
      markConversationDelivered: true,
    });

    assert.strictEqual(result.deliveredCount, 2, 'exactly the 2 undelivered incoming messages delivered via fallback');
    assert.ok(
      telemetry.filteredConversationGets.some((q) => q.field === 'delivered'),
      'bounded delivered index query was attempted first'
    );
    assert.ok(telemetry.fullConversationGets.includes(conv), 'node fallback read engaged');

    const msgs = conversationMessages(conv);
    assert.strictEqual(Object.values(msgs).find((m) => m.text === 'm1').delivered, true);
    assert.strictEqual(Object.values(msgs).find((m) => m.text === 'm2').delivered, true);
    assert.strictEqual(Object.values(msgs).find((m) => m.text === 'mine').delivered, false, 'outgoing untouched');
  });

  it('uses the bounded INDEXED path when the index is present (no node fallback read)', async () => {
    onlineRecipients.add(RECIPIENT);
    const conv = conversationKeyOf(PARTNER, RECIPIENT);
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'm1' });

    indexAvailable = true;
    resetTelemetry();

    const result = await syncChatConversationReceipts({
      tenantId: TENANT_ID,
      actorEmail: RECIPIENT,
      partnerEmail: PARTNER,
      markConversationDelivered: true,
    });

    assert.strictEqual(result.deliveredCount, 1);
    assert.ok(telemetry.filteredConversationGets.some((q) => q.field === 'delivered'));
    assert.strictEqual(telemetry.fullConversationGets.includes(conv), false, 'no node fallback when index present');
  });
});
