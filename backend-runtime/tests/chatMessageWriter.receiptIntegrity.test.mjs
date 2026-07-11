// Feature: chat-production-hardening (Phase 1, Task 3 — finding P2-4)
// Stop trusting client-supplied `delivered`/`read` on the INITIAL chat send.
//
// **Validates: chat-production-hardening finding P2-4 (receipt integrity / unread accuracy)**
//
// SECURITY REGRESSION TEST:
//   The `/chat/messages` route used to forward caller-supplied `delivered`/`read`
//   into `sendChatMessage`, which persisted them verbatim onto the durable record.
//   Because `applySummaryUpdatesForMessage` defaults `recipientUnreadStrategy` to
//   `'decrement'` when `message.read` (or `message.deleted`) is truthy, a sender
//   could POST a message with `read:true`/`delivered:true` and:
//     (a) forge receipt ticks (double/blue) on the recipient's copy, and
//     (b) DECREMENT the recipient's unread for a message they never saw —
//         wrongly clearing a legitimate badge.
//
//   The fix forces `delivered:false` and `read:false` at the write boundary on the
//   initial send, regardless of input. Receipts are set only later via the
//   dedicated delivery/read endpoints. This test drives the REAL compiled
//   `sendChatMessage` write path against a functional in-memory Realtime Database
//   and proves the forged flags are ignored and the recipient's unread INCREMENTS.
//
// WHAT IS EXERCISED FOR REAL:
//   Only the Firebase transport is mocked; the write-boundary + summary-update
//   logic under test runs unmodified from `../dist/chatMessageWriter.js`.

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory Realtime Database + firebase-admin mock (same functional tree store
// pattern used by chatMessageWriter.clientMsgId.test.mjs).
// ---------------------------------------------------------------------------
function createInMemoryDatabase() {
  const store = {};

  const splitPath = (p) =>
    String(p ?? '')
      .split('/')
      .filter((seg) => seg.length > 0);

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

  const makeSnapshot = (segments, key) => {
    const value = readNode(segments);
    return {
      key,
      exists: () => value !== undefined && value !== null,
      val: () => clone(value),
      forEach: (cb) => {
        const node = readNode(segments);
        if (node && typeof node === 'object') {
          for (const childKey of Object.keys(node)) {
            const stop = cb(makeSnapshot([...segments, childKey], childKey));
            if (stop === true) return true;
          }
        }
        return false;
      },
    };
  };

  const makeRef = (path) => {
    const segments = splitPath(path);
    return {
      path,
      key: segments.length ? segments[segments.length - 1] : null,
      child(sub) {
        return makeRef(`${path}/${sub}`);
      },
      push() {
        pushCounter += 1;
        const key = `-Mock${String(pushCounter).padStart(6, '0')}${Math.random().toString(36).slice(2, 6)}`;
        return makeRef(`${path}/${key}`);
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
        return makeSnapshot(splitPath(path), this.key);
      },
      async once() {
        return makeSnapshot(splitPath(path), this.key);
      },
      async transaction(fn) {
        const segs = splitPath(path);
        const current = clone(readNode(segs));
        const next = fn(current);
        const committed = next !== undefined;
        if (committed) {
          writeNode(segs, clone(next));
        }
        return { committed, snapshot: makeSnapshot(segs, this.key) };
      },
      orderByChild() {
        return this;
      },
      equalTo() {
        return this;
      },
      limitToLast() {
        return this;
      },
    };
  };

  return {
    ref: (path = '') => makeRef(path),
    __store: store,
  };
}

let currentDb = createInMemoryDatabase();

const firestoreStub = () => ({
  settings: () => {},
  collection: () => ({
    doc: () => ({
      set: async () => {},
    }),
  }),
});

const adminMock = {
  apps: [{}],
  database: () => currentDb,
  firestore: firestoreStub,
  credential: {
    cert: () => ({}),
    applicationDefault: () => ({}),
  },
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

const { sendChatMessage } = await import('../dist/chatMessageWriter.js');

const TENANT_ID = 'CGnHGq43PFF8WD2DJekx';
const SENDER = 'sender@example.com';
const RECIPIENT = 'recipient@example.com';

function resetStore() {
  currentDb = createInMemoryDatabase();
}

function getStore() {
  return currentDb.__store;
}

function collectDurableMessages(store) {
  const out = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const conversations = tenants[tenantId]?.conversationMessages ?? {};
    for (const convKey of Object.keys(conversations)) {
      const messages = conversations[convKey] ?? {};
      for (const messageId of Object.keys(messages)) {
        const record = messages[messageId];
        if (record && typeof record === 'object') {
          out.push({ id: messageId, conversationKey: convKey, ...record });
        }
      }
    }
  }
  return out;
}

// Collect every conversation summary as { ownerKey, partnerKey, ...summary }.
// Summaries live at tenantChat/<tenantId>/conversationSummaries/<ownerKey>/<partnerKey>.
function collectSummaries(store) {
  const out = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const owners = tenants[tenantId]?.conversationSummaries ?? {};
    for (const ownerKey of Object.keys(owners)) {
      const partners = owners[ownerKey] ?? {};
      for (const partnerKey of Object.keys(partners)) {
        const summary = partners[partnerKey];
        if (summary && typeof summary === 'object') {
          out.push({ ownerKey, partnerKey, ...summary });
        }
      }
    }
  }
  return out;
}

// The recipient's summary is the one whose last message is NOT their own.
function recipientSummary(store) {
  return collectSummaries(store).find((s) => s.lastMessage && s.lastMessage.isOwnMessage === false) ?? null;
}

// The sender's summary is the one whose last message IS their own.
function senderSummary(store) {
  return collectSummaries(store).find((s) => s.lastMessage && s.lastMessage.isOwnMessage === true) ?? null;
}

// ---------------------------------------------------------------------------
describe('chat-production-hardening (Task 3, P2-4) — initial send never trusts client delivered/read', () => {
  beforeEach(() => {
    resetStore();
  });

  it('ANCHOR: a send with forged delivered:true/read:true persists delivered:false/read:false AND increments recipient unread (never decrements)', async () => {
    const record = await sendChatMessage({
      senderEmail: SENDER,
      recipientEmail: RECIPIENT,
      tenantId: TENANT_ID,
      text: 'forged receipts attempt',
      // Malicious/buggy sender tries to pre-mark their outgoing message as
      // already delivered AND read by the recipient.
      delivered: true,
      read: true,
    });

    // (a) The returned record must NOT carry the forged flags.
    assert.strictEqual(record.delivered, false, 'returned record.delivered must be forced false');
    assert.strictEqual(record.read, false, 'returned record.read must be forced false');

    // (b) The persisted durable record must also be false/false.
    const durable = collectDurableMessages(getStore());
    assert.strictEqual(durable.length, 1, 'exactly one durable record created');
    assert.strictEqual(durable[0].delivered, false, 'persisted delivered must be false');
    assert.strictEqual(durable[0].read, false, 'persisted read must be false');

    // (c) The recipient's unread INCREMENTS to 1. If the forged read:true had been
    // trusted, applySummaryUpdatesForMessage would have DECREMENTED to max(0,0-1)=0.
    const recip = recipientSummary(getStore());
    assert.ok(recip, 'recipient summary must exist');
    assert.strictEqual(recip.unreadCount, 1, 'recipient unread must increment to 1, not decrement');
    assert.strictEqual(recip.lastMessage.delivered, false, 'recipient summary lastMessage.delivered must be false');
    assert.strictEqual(recip.lastMessage.read, false, 'recipient summary lastMessage.read must be false');

    // (d) The sender's own unread is unchanged (preserve).
    const sender = senderSummary(getStore());
    assert.ok(sender, 'sender summary must exist');
    assert.strictEqual(sender.unreadCount, 0, 'sender unread must remain 0');
  });

  it('forged read:true on repeated sends can never drive recipient unread below the true count', async () => {
    await sendChatMessage({
      senderEmail: SENDER,
      recipientEmail: RECIPIENT,
      tenantId: TENANT_ID,
      text: 'first (forged read)',
      delivered: true,
      read: true,
    });
    await sendChatMessage({
      senderEmail: SENDER,
      recipientEmail: RECIPIENT,
      tenantId: TENANT_ID,
      text: 'second (forged read)',
      delivered: true,
      read: true,
    });

    // Two genuine inbound messages → recipient unread must be exactly 2 (monotonic
    // increment). The forged read flags must never decrement the badge.
    const recip = recipientSummary(getStore());
    assert.ok(recip, 'recipient summary must exist');
    assert.strictEqual(recip.unreadCount, 2, 'recipient unread must be 2 after two forged sends');
  });

  it('a normal send (no flags) still increments recipient unread and leaves sender unread unchanged', async () => {
    const record = await sendChatMessage({
      senderEmail: SENDER,
      recipientEmail: RECIPIENT,
      tenantId: TENANT_ID,
      text: 'ordinary message',
    });

    assert.strictEqual(record.delivered, false, 'new message is not delivered yet');
    assert.strictEqual(record.read, false, 'new message is not read yet');

    const recip = recipientSummary(getStore());
    assert.ok(recip, 'recipient summary must exist');
    assert.strictEqual(recip.unreadCount, 1, 'recipient unread increments to 1 on a normal send');

    const sender = senderSummary(getStore());
    assert.ok(sender, 'sender summary must exist');
    assert.strictEqual(sender.unreadCount, 0, 'sender unread stays 0 on their own send');
  });
});
