// Feature: chat-production-hardening (Phase 1, Task 2 — finding P0-1, Model A:
// backend is the ONLY chat writer).
//
// **Validates: chat-production-hardening finding P0-1 (server-side summary
// rebuild replacing the client's direct RTDB writes).**
//
// Drives the REAL compiled `rebuildChatSummariesForUser` write path against a
// functional in-memory Realtime Database (only the Firebase transport is mocked —
// same tree-store pattern used by chatMessageWriter.readReconcile.test.mjs).
// Proves:
//   - a missing summary is reconstructed from the maintained `conversationLatest`
//     pointer (even when the conversation message node is gone — proving the
//     pointer, not a full-history scan, is the source);
//   - a drifted stored unread counter converges to the bounded true-unread value;
//   - a stale summary (partner no longer present) is pruned;
//   - a self-conversation summary is NEVER (re)created and any pre-existing one is
//     pruned;
//   - a re-run over converged data is a no-op (idempotent, prunes nothing new).

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
  collection: () => ({ doc: () => ({ set: async () => {}, collection: () => ({ get: async () => ({ docs: [] }) }) }) }),
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

const { sendChatMessage, rebuildChatSummariesForUser } = await import('../dist/chatMessageWriter.js');

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
function tenantRoot() {
  return getStore()?.tenantChat?.[TENANT_ID] ?? {};
}
function ownerSummary(ownerEmail, partnerEmail) {
  return tenantRoot()?.conversationSummaries?.[sanitizeKey(ownerEmail)]?.[sanitizeKey(partnerEmail)] ?? null;
}
function conversationLatest(a, b) {
  return tenantRoot()?.conversationLatest?.[conversationKeyOf(a, b)] ?? null;
}
async function refPath(path) {
  return currentDb.ref(path);
}

describe('chat-production-hardening (Task 2, P0-1) — rebuildChatSummariesForUser', () => {
  beforeEach(() => {
    resetStore();
  });

  it('reconstructs a missing summary from the conversationLatest pointer (not a full-history scan)', async () => {
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'hello there' });

    const convKey = conversationKeyOf(ACTOR, PARTNER);
    const pointer = conversationLatest(ACTOR, PARTNER);
    assert.ok(pointer && pointer.messageId, 'pointer seeded by send');

    // Simulate a lost summary AND remove the message node entirely so the ONLY
    // possible source for the reconstructed lastMessage is the maintained pointer.
    (await refPath(`tenantChat/${TENANT_ID}/conversationSummaries/${sanitizeKey(ACTOR)}/${sanitizeKey(PARTNER)}`)).set(null);
    (await refPath(`tenantChat/${TENANT_ID}/conversationMessages/${convKey}`)).set(null);
    assert.strictEqual(ownerSummary(ACTOR, PARTNER), null, 'summary is gone before rebuild');

    const result = await rebuildChatSummariesForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });
    assert.strictEqual(result.rebuiltConversations, 1);

    const rebuilt = ownerSummary(ACTOR, PARTNER);
    assert.ok(rebuilt, 'summary reconstructed');
    assert.strictEqual(rebuilt.partnerEmail, PARTNER);
    assert.strictEqual(rebuilt.lastMessage.messageId, pointer.messageId, 'lastMessage came from the pointer');
    assert.strictEqual(rebuilt.lastMessage.text, 'hello there');
    // No messages remain to count → unread converges to 0.
    assert.strictEqual(rebuilt.unreadCount, 0);
  });

  it('converges a drifted stored unread counter to the bounded true-unread value', async () => {
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'unread one' });
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 1);

    const actorKey = sanitizeKey(ACTOR);
    const partnerKey = sanitizeKey(PARTNER);
    const convKey = conversationKeyOf(ACTOR, PARTNER);

    // Corrupt BOTH the summary and its userConversations mirror (simulate drift
    // from a stale/racy prior write) so the stored hint is wrong.
    (await refPath(`tenantChat/${TENANT_ID}/conversationSummaries/${actorKey}/${partnerKey}`)).update({ unreadCount: 9 });
    (await refPath(`tenantChat/${TENANT_ID}/userConversations/${actorKey}/${convKey}`)).update({ unreadCount: 9 });
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 9);

    const result = await rebuildChatSummariesForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });
    assert.strictEqual(result.rebuiltConversations, 1);
    assert.strictEqual(ownerSummary(ACTOR, PARTNER).unreadCount, 1, 'converges to the true unread count');
  });

  it('prunes a stale summary whose partner is no longer present', async () => {
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'real' });

    const actorKey = sanitizeKey(ACTOR);
    const ghostEmail = 'ghost@example.com';
    const ghostKey = sanitizeKey(ghostEmail);

    // Seed a stale summary with NO userConversations entry backing it.
    (await refPath(`tenantChat/${TENANT_ID}/conversationSummaries/${actorKey}/${ghostKey}`)).set({
      partnerEmail: ghostEmail,
      unreadCount: 2,
      updatedAt: new Date().toISOString(),
    });
    assert.ok(ownerSummary(ACTOR, ghostEmail), 'ghost summary seeded');

    const result = await rebuildChatSummariesForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });

    assert.ok(result.prunedConversations >= 1, 'a stale summary is pruned');
    assert.ok(ownerSummary(ACTOR, ghostEmail) == null, 'ghost summary removed');
    assert.ok(ownerSummary(ACTOR, PARTNER), 'the real partner summary is kept');
  });

  it('never (re)creates a self-conversation summary and prunes a pre-existing one', async () => {
    // A real conversation so the rebuild has legitimate work.
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'real' });

    const actorKey = sanitizeKey(ACTOR);
    const selfConvKey = conversationKeyOf(ACTOR, ACTOR);

    // Seed an orphaned self summary + its userConversations mirror.
    (await refPath(`tenantChat/${TENANT_ID}/conversationSummaries/${actorKey}/${actorKey}`)).set({
      partnerEmail: ACTOR,
      unreadCount: 3,
      updatedAt: new Date().toISOString(),
    });
    (await refPath(`tenantChat/${TENANT_ID}/userConversations/${actorKey}/${selfConvKey}`)).set({
      partnerEmail: ACTOR,
      partnerKey: actorKey,
      conversationKey: selfConvKey,
      unreadCount: 3,
    });

    await rebuildChatSummariesForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });

    assert.ok(ownerSummary(ACTOR, ACTOR) == null, 'self summary removed and never regenerated');
    assert.ok(ownerSummary(ACTOR, PARTNER), 'the real partner summary is kept');
  });

  it('is idempotent: a re-run over converged data changes nothing and prunes nothing new', async () => {
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'one' });
    await sendChatMessage({ senderEmail: PARTNER, recipientEmail: ACTOR, tenantId: TENANT_ID, text: 'two' });

    const first = await rebuildChatSummariesForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });
    const afterFirst = JSON.stringify(ownerSummary(ACTOR, PARTNER));

    const second = await rebuildChatSummariesForUser({ tenantId: TENANT_ID, actorEmail: ACTOR });
    const afterSecond = JSON.stringify(ownerSummary(ACTOR, PARTNER));

    assert.strictEqual(first.rebuiltConversations, 1);
    assert.strictEqual(second.rebuiltConversations, 1, 'still resolves the same conversation');
    assert.strictEqual(second.prunedConversations, 0, 're-run prunes nothing new');
    assert.strictEqual(afterFirst, afterSecond, 'the stored summary is unchanged (no oscillation)');
  });
});
