// Feature: chat-production-hardening (Phase 1, Task 2 — finding P0-1, Model A:
// backend is the ONLY chat writer).
//
// **Validates: chat-production-hardening finding P0-1 (server-side mark-read +
// unread reconciliation replacing the client's direct RTDB writes)**
//
// Drives the REAL compiled `markChatConversationRead` and
// `reconcileChatUnreadForUser` write paths against a functional in-memory
// Realtime Database (only the Firebase transport is mocked — same tree-store
// pattern used by chatMessageWriter.receiptIntegrity.test.mjs). Proves:
//   - marking a conversation read only affects the actor's OWN incoming messages
//     (partner -> actor), never the actor's outgoing copies;
//   - the actor's stored unread converges to the true value and re-running is a
//     no-op (idempotent);
//   - a self-conversation can never be "read" (rejected at the boundary);
//   - reconciliation converges a drifted stored counter to the true value and
//     purges a stuck self-conversation (summary + mirror + message node).

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
  collection: () => ({ doc: () => ({ set: async () => {} }) }),
});

const adminMock = {
  apps: [{}],
  database: () => currentDb,
  firestore: firestoreStub,
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
  markChatConversationRead,
  reconcileChatUnreadForUser,
  ChatMessageActionError,
} = await import('../dist/chatMessageWriter.js');

const TENANT_ID = 'CGnHGq43PFF8WD2DJekx';
const ACTOR = 'reader@example.com';
const PARTNER = 'writer@example.com';

function resetStore() {
  currentDb = createInMemoryDatabase();
}
function getStore() {
  return currentDb.__store;
}
function sanitizeKey(email) {
  return email.trim().toLowerCase().replace(/[.@]/g, '_');
}
function conversationKeyOf(a, b) {
  return [sanitizeKey(a), sanitizeKey(b)].sort().join('__');
}
function ownerSummary(ownerEmail, partnerEmail) {
  const store = getStore();
  return store?.tenantChat?.[TENANT_ID]?.conversationSummaries?.[sanitizeKey(ownerEmail)]?.[sanitizeKey(partnerEmail)] ?? null;
}
function conversationMessages(a, b) {
  const store = getStore();
  return store?.tenantChat?.[TENANT_ID]?.conversationMessages?.[conversationKeyOf(a, b)] ?? {};
}

describe('chat-production-hardening (Task 2, P0-1) — markChatConversationRead', () => {
  beforeEach(() => {
    resetStore();
  });

  it('marks the actor\'s incoming unread messages read, converges unread to 0, and is idempotent', async () => {
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'one' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'two' });

    // Before reading, the actor (recipient) has 2 unread from the partner.
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 2);

    const first = await markChatConversationRead({ tenantId: TENANT_ID, actorEmail: ACTOR, partnerEmail: PARTNER });
    assert.strictEqual(first.updatedCount, 2, 'both incoming messages marked read');

    // All incoming messages are now read, and the stored unread has converged.
    const messages = conversationMessages(ACTOR, PARTNER);
    for (const record of Object.values(messages)) {
      assert.strictEqual(record.read, true, 'each incoming message must be read');
      assert.strictEqual(record.delivered, true, 'read implies delivered');
    }
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 0, 'actor unread converges to 0');

    // Re-running is a no-op.
    const second = await markChatConversationRead({ tenantId: TENANT_ID, actorEmail: ACTOR, partnerEmail: PARTNER });
    assert.strictEqual(second.updatedCount, 0, 're-read marks nothing');
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 0);
  });

  it('never marks the actor\'s OWN outgoing messages read', async () => {
    // Actor sends to partner; that outgoing copy must not be touched when the
    // actor marks THEIR view of the conversation read.
    await sendChatMessage({ senderEmail: ACTOR, recipientEmail: PARTNER, tenantId: TENANT_ID, text: 'outgoing' });

    const result = await markChatConversationRead({ tenantId: TENANT_ID, actorEmail: ACTOR, partnerEmail: PARTNER });
    assert.strictEqual(result.updatedCount, 0, 'no incoming messages to read');

    const messages = conversationMessages(ACTOR, PARTNER);
    const outgoing = Object.values(messages).find((m) => m.sender === ACTOR);
    assert.ok(outgoing, 'outgoing message exists');
    assert.strictEqual(outgoing.read, false, 'actor\'s own outgoing message stays unread');
  });

  it('rejects marking a self-conversation as read', async () => {
    await assert.rejects(
      () => markChatConversationRead({ tenantId: TENANT_ID, actorEmail: ACTOR, partnerEmail: ACTOR }),
      (error) => error instanceof ChatMessageActionError && error.code === 'not_allowed'
    );
  });
});

describe('chat-production-hardening (Task 2, P0-1) — reconcileChatUnreadForUser', () => {
  beforeEach(() => {
    resetStore();
  });

  it('converges a drifted stored unread counter to the true value', async () => {
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'unread' });
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 1);

    // Corrupt the stored counter (simulate drift from a stale/racy prior write).
    await currentDb
      .ref(`tenantChat/${TENANT_ID}/conversationSummaries/${sanitizeKey(ACTOR)}/${sanitizeKey(PARTNER)}`)
      .update({ unreadCount: 9 });
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 9);

    const result = await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });
    assert.strictEqual(result.reconciledConversations, 1, 'the drifted conversation is reconciled');
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 1, 'converges to the true unread count');

    // Idempotent: nothing drifts on a second pass.
    const second = await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });
    assert.strictEqual(second.reconciledConversations, 0);
  });

  it('purges a stuck self-conversation summary, its mirror, and its message node', async () => {
    const actorKey = sanitizeKey(ACTOR);
    const selfConvKey = conversationKeyOf(ACTOR, ACTOR);

    // Seed an orphaned self-conversation (self-messaging is unsupported, so this
    // data can never be legitimately opened or read).
    await currentDb
      .ref(`tenantChat/${TENANT_ID}/conversationSummaries/${actorKey}/${actorKey}`)
      .set({ partnerEmail: ACTOR, unreadCount: 3, updatedAt: new Date().toISOString() });
    await currentDb
      .ref(`tenantChat/${TENANT_ID}/userConversations/${actorKey}/${selfConvKey}`)
      .set({ partnerEmail: ACTOR, conversationKey: selfConvKey, unreadCount: 3 });
    await currentDb
      .ref(`tenantChat/${TENANT_ID}/conversationMessages/${selfConvKey}/-selfmsg`)
      .set({ sender: ACTOR, recipientId: ACTOR, text: 'stuck', read: false });

    const result = await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });
    assert.strictEqual(result.selfConversationsCleaned, 1);

    // Note: `set(null)` removes the node in real RTDB; the in-memory mock records
    // the removal as a `null` value, so a removed node reads back as `null`/absent.
    const store = getStore();
    const summaries = store?.tenantChat?.[TENANT_ID]?.conversationSummaries?.[actorKey] ?? {};
    assert.ok(summaries[actorKey] == null, 'self summary removed');
    const mirror = store?.tenantChat?.[TENANT_ID]?.userConversations?.[actorKey] ?? {};
    assert.ok(mirror[selfConvKey] == null, 'self userConversations mirror removed');
    const selfMessages = store?.tenantChat?.[TENANT_ID]?.conversationMessages ?? {};
    assert.ok(selfMessages[selfConvKey] == null, 'self conversationMessages node removed');
  });
});
