// Feature: chat-production-hardening (Phase 3, Task 11 — finding P2-3)
// Bound backend receipt/delivery scans with indexed queries.
//
// **Validates: chat-production-hardening finding P2-3 (bounded delivery scans)**
//
// SCALABILITY REGRESSION TEST:
//   `markPendingChatMessagesDeliveredForRecipient` used to query the FLAT global
//   `messageIndex` by `recipientId` (returning EVERY message ever addressed to the
//   recipient — delivered ones included) and then did an N+1 `loadMessageContext`
//   per undelivered item. `syncChatConversationReceipts({ markConversationDelivered })`
//   used to `get()` the ENTIRE conversation node and scan all messages.
//
//   The fix constrains both to the UNDELIVERED subset via the indexed
//   `orderByChild('delivered').equalTo(false)` query (re-applying the remaining
//   predicate on the bounded set), and reuses the already-fetched records to
//   build the receipt-patch context instead of paying for a per-item read.
//
//   This test drives the REAL compiled write paths against a functional in-memory
//   Realtime Database whose query layer ACTUALLY implements
//   `orderByChild(...).equalTo(...)` filtering and records telemetry, so it can
//   prove:
//     (a) only genuinely-undelivered INCOMING messages are delivered (already
//         delivered / deleted / outgoing are untouched);
//     (b) the delivery path uses the bounded `delivered == false` query and does
//         NOT fully rescan a large already-delivered history, and does NOT do an
//         N+1 per-message context read;
//     (c) a re-run is idempotent (no-op);
//     (d) delivery provenance (presence source) is preserved.

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory Realtime Database with a FUNCTIONAL query layer + telemetry.
// Unlike the no-op `orderByChild/equalTo` stubs used by the other suites, this
// mock actually filters children on `orderByChild(field).equalTo(value)` and
// records which conversation reads were bounded vs full scans — so the test can
// prove the delivered-subset query is exercised and the whole history is never
// rescanned.
// ---------------------------------------------------------------------------
let telemetry;

function resetTelemetry() {
  telemetry = {
    fullConversationScans: [], // conversationMessages/<conv> read WITHOUT a filter
    boundedDeliveredQueries: [], // conversationMessages/<conv> read WITH delivered==false
    otherBoundedQueries: [], // any other filtered conversation read
    deliveredFalseChildrenScanned: 0, // total children a delivered==false query returns
    messageNodeReads: [], // conversationMessages/<conv>/<msgId> single-record reads
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
  const isMessageNode = (segments) =>
    segments.length === 5 && segments[0] === 'tenantChat' && segments[2] === 'conversationMessages';

  const recordGet = (segments, filter) => {
    const active = filter && filter.hasValue;
    if (isConversationNode(segments)) {
      const conv = segments[3];
      if (active && filter.field === 'delivered') {
        telemetry.boundedDeliveredQueries.push(conv);
        const node = readNode(segments) || {};
        for (const v of Object.values(node)) {
          if (v && typeof v === 'object' && v.delivered === filter.value) {
            telemetry.deliveredFalseChildrenScanned += 1;
          }
        }
      } else if (active) {
        telemetry.otherBoundedQueries.push({ conv, field: filter.field });
      } else {
        telemetry.fullConversationScans.push(conv);
      }
    } else if (isMessageNode(segments)) {
      telemetry.messageNodeReads.push(segments[4]);
    }
  };

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
            // Child snapshots read the actual stored child (never re-filtered).
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
        recordGet(segments, filter);
        return makeSnapshot(segments, ref.key, filter);
      },
      async once() {
        recordGet(segments, filter);
        return makeSnapshot(segments, ref.key, filter);
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

// Recipients (normalized email) considered to have an online device this test.
let onlineRecipients = new Set();

function makeOnlineDevice(tenantId) {
  return {
    tenantIds: [tenantId],
    isOnline: true,
    lastSeen: Date.now(),
    updatedAt: Date.now(),
  };
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
  return {
    settings: () => {},
    collection: (name) => makeCollection(name),
  };
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

const { sendChatMessage, markPendingChatMessagesDeliveredForRecipient, syncChatConversationReceipts } = await import(
  '../dist/chatMessageWriter.js'
);

const TENANT_ID = 'CGnHGq43PFF8WD2DJekx';
const RECIPIENT = 'recipient@example.com';
const PARTNER = 'sender@example.com';
const PARTNER_TWO = 'second-sender@example.com';

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
function seedDeliveredMessage(convKey, id, { sender, recipientId, deliveredAt }) {
  return currentDb
    .ref(`tenantChat/${TENANT_ID}/conversationMessages/${convKey}/${id}`)
    .set({
      id,
      text: `seeded ${id}`,
      sender: String(sender).trim().toLowerCase(),
      recipientId: String(recipientId).trim().toLowerCase(),
      conversationKey: convKey,
      timestamp: new Date().toISOString(),
      delivered: true,
      read: false,
      deliveredAt: deliveredAt ?? 'SEED_DELIVERED_AT',
    });
}

function resetAll() {
  currentDb = createInMemoryDatabase();
  onlineRecipients = new Set();
  resetTelemetry();
}

describe('chat-production-hardening (Task 11, P2-3) — markPendingChatMessagesDeliveredForRecipient (bounded)', () => {
  beforeEach(() => {
    resetAll();
  });

  it('delivers only genuinely-undelivered incoming messages via the bounded delivered==false query, with no full scan and no N+1', async () => {
    onlineRecipients.add(RECIPIENT);
    const convA = conversationKeyOf(PARTNER, RECIPIENT);
    const convB = conversationKeyOf(PARTNER_TWO, RECIPIENT);

    // Conversation A: 2 undelivered incoming (partner -> recipient).
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'A1' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'A2' });
    // Conversation A: 1 OUTGOING (recipient -> partner) — must never be delivered
    // on the recipient's behalf. It stays undelivered but is excluded by predicate.
    await sendChatMessage({ senderEmail: RECIPIENT, recipientEmail: PARTNER, tenantId: TENANT_ID, text: 'outgoing' });
    // Conversation B: 1 undelivered incoming from a second partner.
    await sendChatMessage({ senderEmail: PARTNER_TWO, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'B1' });

    // Large already-delivered history in conversation A (50 records). These must
    // NOT be rescanned by the delivered==false bounded query.
    for (let i = 0; i < 50; i++) {
      await seedDeliveredMessage(convA, `-delivered${i}`, { sender: PARTNER, recipientId: RECIPIENT });
    }

    // Snapshot before-state to prove already-delivered records are untouched.
    const seededBefore = conversationMessages(convA)['-delivered0'];
    assert.strictEqual(seededBefore.delivered, true);
    assert.strictEqual(seededBefore.deliveredAt, 'SEED_DELIVERED_AT');

    // Reset telemetry so only the delivery call is measured.
    resetTelemetry();

    const result = await markPendingChatMessagesDeliveredForRecipient({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
    });

    // (a) Exactly the 3 genuinely-undelivered INCOMING messages (2 in A + 1 in B).
    assert.strictEqual(result.deliveredCount, 3, 'only the 3 undelivered incoming messages are delivered');
    assert.strictEqual(result.recipientHasOnlineDevice, true);

    // (b1) The bounded delivered==false query was used for each enumerated
    // conversation, and NO full-conversation scan happened.
    assert.strictEqual(telemetry.fullConversationScans.length, 0, 'no full-conversation scan');
    assert.ok(telemetry.boundedDeliveredQueries.includes(convA), 'bounded delivered query used on conv A');
    assert.ok(telemetry.boundedDeliveredQueries.includes(convB), 'bounded delivered query used on conv B');

    // (b2) The 50 already-delivered records are excluded by the index and never
    // scanned: the bounded query only returns the 4 undelivered children
    // (2 incoming A + 1 outgoing A + 1 incoming B), not 54.
    assert.strictEqual(
      telemetry.deliveredFalseChildrenScanned,
      4,
      'delivered==false query returns only the undelivered subset (50 delivered excluded)'
    );

    // (b3) No N+1 per-message context read: the bounded query records are reused
    // directly, so no single-message conversationMessages reads occur.
    assert.strictEqual(telemetry.messageNodeReads.length, 0, 'no per-message N+1 context reads');

    // (a-cont) The 2 incoming A messages are delivered.
    const msgsA = conversationMessages(convA);
    const incomingA = Object.values(msgsA).filter((m) => m.text === 'A1' || m.text === 'A2');
    assert.strictEqual(incomingA.length, 2, 'both incoming A messages present');
    for (const m of incomingA) {
      assert.strictEqual(m.delivered, true, 'incoming A message delivered');
    }
    const outgoing = Object.values(msgsA).find((m) => m.text === 'outgoing');
    assert.ok(outgoing, 'outgoing message exists');
    assert.strictEqual(outgoing.delivered, false, 'recipient\'s own outgoing message is never delivered');

    // Already-delivered seeded records untouched (delivered flag + timestamp).
    const seededAfter = conversationMessages(convA)['-delivered0'];
    assert.strictEqual(seededAfter.delivered, true, 'seeded delivered record stays delivered');
    assert.strictEqual(seededAfter.deliveredAt, 'SEED_DELIVERED_AT', 'seeded deliveredAt untouched (not rescanned/rewritten)');

    // (d) Delivery provenance preserved (presence source recorded).
    const deliveredIncoming = Object.values(conversationMessages(convB)).find((m) => m.text === 'B1');
    assert.ok(deliveredIncoming, 'B1 exists');
    assert.strictEqual(deliveredIncoming.delivered, true);
    assert.ok(deliveredIncoming.deliveryProvenance, 'deliveryProvenance is set');
    assert.strictEqual(deliveredIncoming.deliveryProvenance.lastSource, 'presence');
    assert.ok(
      (deliveredIncoming.deliveryProvenance.presence?.onlineDeviceCount ?? 0) >= 1,
      'presence provenance records an online device'
    );

    // (c) Idempotent re-run: everything genuinely-incoming is already delivered.
    resetTelemetry();
    const second = await markPendingChatMessagesDeliveredForRecipient({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
    });
    assert.strictEqual(second.deliveredCount, 0, 're-run delivers nothing (idempotent)');
    assert.strictEqual(telemetry.fullConversationScans.length, 0, 're-run also avoids full scans');
  });

  it('returns early (no delivery) when the recipient has no online device', async () => {
    // Recipient is NOT in onlineRecipients → no online device.
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'offline' });
    resetTelemetry();

    const result = await markPendingChatMessagesDeliveredForRecipient({
      tenantId: TENANT_ID,
      recipientEmail: RECIPIENT,
    });
    assert.strictEqual(result.recipientHasOnlineDevice, false);
    assert.strictEqual(result.deliveredCount, 0);
    // Nothing was even queried at the conversation level.
    assert.strictEqual(telemetry.boundedDeliveredQueries.length, 0);
    assert.strictEqual(telemetry.fullConversationScans.length, 0);
  });
});

describe('chat-production-hardening (Task 11, P2-3) — syncChatConversationReceipts markConversationDelivered (bounded)', () => {
  beforeEach(() => {
    resetAll();
  });

  it('marks the conversation\'s undelivered incoming messages delivered via the bounded query, without a full scan', async () => {
    // The actor (reader) is online; delivery on conversation-open applies.
    onlineRecipients.add(RECIPIENT);
    const conv = conversationKeyOf(PARTNER, RECIPIENT);

    // 3 undelivered incoming (partner -> actor).
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'm1' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'm2' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: RECIPIENT, tenantId: TENANT_ID, text: 'm3' });
    // 1 outgoing (actor -> partner) — excluded.
    await sendChatMessage({ senderEmail: RECIPIENT, recipientEmail: PARTNER, tenantId: TENANT_ID, text: 'mine' });
    // Large already-delivered history — must not be rescanned.
    for (let i = 0; i < 30; i++) {
      await seedDeliveredMessage(conv, `-old${i}`, { sender: PARTNER, recipientId: RECIPIENT });
    }

    resetTelemetry();

    const result = await syncChatConversationReceipts({
      tenantId: TENANT_ID,
      actorEmail: RECIPIENT,
      partnerEmail: PARTNER,
      markConversationDelivered: true,
    });

    // Only the 3 undelivered incoming messages are delivered.
    assert.strictEqual(result.deliveredCount, 3, 'exactly the 3 undelivered incoming messages delivered');

    // Bounded query used; no full-conversation scan.
    assert.strictEqual(telemetry.fullConversationScans.length, 0, 'no full-conversation scan');
    assert.ok(telemetry.boundedDeliveredQueries.includes(conv), 'bounded delivered query used');
    // Only the undelivered subset (3 incoming + 1 outgoing) is returned by the
    // index — the 30 delivered are excluded (would be 34 on a full scan).
    assert.strictEqual(telemetry.deliveredFalseChildrenScanned, 4, '30 already-delivered records excluded by index');

    // Outgoing stays undelivered; delivered incoming carry presence provenance.
    const msgs = conversationMessages(conv);
    const outgoing = Object.values(msgs).find((m) => m.text === 'mine');
    assert.strictEqual(outgoing.delivered, false, 'actor\'s own outgoing message untouched');
    const m1 = Object.values(msgs).find((m) => m.text === 'm1');
    assert.strictEqual(m1.delivered, true);
    assert.strictEqual(m1.read, false, 'delivery does not mark read');
    assert.ok(m1.deliveryProvenance, 'deliveryProvenance preserved');
    assert.strictEqual(m1.deliveryProvenance.lastSource, 'presence');

    // Already-delivered seeded record untouched.
    assert.strictEqual(msgs['-old0'].delivered, true);
    assert.strictEqual(msgs['-old0'].deliveredAt, 'SEED_DELIVERED_AT');

    // Idempotent re-run.
    resetTelemetry();
    const second = await syncChatConversationReceipts({
      tenantId: TENANT_ID,
      actorEmail: RECIPIENT,
      partnerEmail: PARTNER,
      markConversationDelivered: true,
    });
    assert.strictEqual(second.deliveredCount, 0, 're-run delivers nothing (idempotent)');
    assert.strictEqual(telemetry.fullConversationScans.length, 0);
  });
});
