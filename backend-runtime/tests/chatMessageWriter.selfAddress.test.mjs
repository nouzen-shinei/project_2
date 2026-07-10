// Feature: stuck-message-delivery-fix
// Property 3 (Bug Condition) — Self-address prevention (backend write layer).
//
// **Validates: Requirements 2.5, 2.9**
//
// EXPLORATION TEST (exploratory bugfix workflow):
//   This property-based test is written BEFORE the fix and is EXPECTED TO FAIL on
//   the current UNFIXED code. Its failure is the SUCCESS signal — it surfaces the
//   counterexample that proves the bug exists at the SERVER write boundary
//   (`backend-runtime/src/chatMessageWriter.ts` `sendChatMessage`, reached via the
//   `chatRealtime.ts` / `chatWebsocket.ts` entry points): a send whose resolved
//   recipient equals the sender (`normalizeEmail(recipientEmail) == normalizeEmail(senderEmail)`)
//   is ACCEPTED and durably persisted, creating a self-addressed message record
//   AND a self-conversation node/summary (identical `conversationKey` halves,
//   `sender == recipientId`, `partnerEmail == sender`) — exactly the export state
//   `conversationMessages/krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com/…`.
//
//   Do NOT "fix" this test or the production code to make it pass here. Once the
//   server-side self-address guard lands (reject the write; create no record, no
//   self conversationMessages node, no conversationSummaries/userConversations self
//   summary), this same test will pass (fix checking, task 12.3).
//
// WHAT IS EXERCISED FOR REAL:
//   The REAL compiled `sendChatMessage` write path runs against a functional
//   in-memory Realtime Database (a mock of `firebase-admin`). Only the Firebase
//   transport is mocked; the bug logic under test — no self-address guard before
//   `getConversationKey(sender, recipient)` collapses to a self key, then the
//   message `set`, `registerConversationForUsers`, and
//   `applySummaryUpdatesForMessage` persisting the self record + self summary —
//   runs unmodified from `../dist/chatMessageWriter.js`.

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';
import fc from 'fast-check';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory Realtime Database + firebase-admin mock.
// A functional tree store so the REAL sendChatMessage write path actually
// persists records we can then inspect.
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

// A firestore stub that satisfies applyFirestoreSettings() (`.settings`) and the
// best-effort videoTranscodes write-back (`.collection().doc().set()`), which is
// only reached for video attachments (never in these text-only sends).
const firestoreStub = () => ({
  settings: () => {},
  collection: () => ({
    doc: () => ({
      set: async () => {},
    }),
  }),
});

const adminMock = {
  // apps.length > 0 makes ensureFirebase() short-circuit without initializing.
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

// Inject the mock BEFORE importing the compiled module so its `require("firebase-admin")`
// resolves to our in-memory implementation.
const firebaseAdminPath = require.resolve('firebase-admin');
require.cache[firebaseAdminPath] = {
  id: firebaseAdminPath,
  filename: firebaseAdminPath,
  loaded: true,
  exports: adminMock,
};

const { sendChatMessage } = await import('../dist/chatMessageWriter.js');

const TENANT_ID = 'CGnHGq43PFF8WD2DJekx';

function resetStore() {
  currentDb = createInMemoryDatabase();
}

function getStore() {
  return currentDb.__store;
}

// ---------------------------------------------------------------------------
// Assertion-side helpers — read/interpret only what the real write path wrote.
// ---------------------------------------------------------------------------
function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isSelfConversationKey(key) {
  const halves = String(key).split('__').filter(Boolean);
  return halves.length === 2 && halves[0] === halves[1];
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

function collectConversationKeys(store) {
  const out = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const conversations = tenants[tenantId]?.conversationMessages ?? {};
    out.push(...Object.keys(conversations));
  }
  return out;
}

function collectSummaries(store) {
  const out = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const owners = tenants[tenantId]?.conversationSummaries ?? {};
    for (const ownerKey of Object.keys(owners)) {
      const partners = owners[ownerKey] ?? {};
      for (const partnerKey of Object.keys(partners)) {
        const entry = partners[partnerKey];
        if (entry && typeof entry === 'object') {
          out.push({ ownerKey, partnerKey, ...entry });
        }
      }
    }
  }
  return out;
}

function collectUserConversationKeys(store) {
  const out = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const users = tenants[tenantId]?.userConversations ?? {};
    for (const userKey of Object.keys(users)) {
      out.push(...Object.keys(users[userKey] ?? {}));
    }
  }
  return out;
}

/**
 * Drive one self-addressed send through the real sendChatMessage. Returns whether
 * the write was rejected (threw). Property assertions inspect the store either way.
 */
async function runSelfAddressedSend(email, text) {
  try {
    await sendChatMessage({
      senderEmail: email,
      recipientEmail: email, // self-addressed: resolved recipient equals the sender
      tenantId: TENANT_ID,
      text,
      isSpecial: false,
    });
    return { rejected: false };
  } catch {
    return { rejected: true };
  }
}

/**
 * The core Property 3 assertion: a self-addressed send must persist NOTHING —
 * no message record, no self-conversation node, no self summary, no self
 * userConversations entry. On UNFIXED code every one of these is created.
 */
function assertNoSelfAddressedPersistence(store, email) {
  const normalized = normalizeEmail(email);
  const senderKey = normalized.replace(/[.@]/g, '_');

  const durable = collectDurableMessages(store);
  const selfAddressed = durable.filter(
    (m) => normalizeEmail(m.sender) === normalizeEmail(m.recipientId)
  );
  assert.strictEqual(
    selfAddressed.length,
    0,
    `expected no self-addressed message record, found: ${JSON.stringify(selfAddressed)}`
  );
  assert.strictEqual(
    durable.length,
    0,
    `expected no durable message record for a self-addressed send, found: ${JSON.stringify(durable)}`
  );

  const selfNodes = collectConversationKeys(store).filter(isSelfConversationKey);
  assert.strictEqual(
    selfNodes.length,
    0,
    `expected no self-conversation node, found: ${JSON.stringify(selfNodes)}`
  );

  const selfSummaries = collectSummaries(store).filter(
    (s) => s.ownerKey === s.partnerKey || normalizeEmail(s.partnerEmail) === normalized
  );
  assert.strictEqual(
    selfSummaries.length,
    0,
    `expected no self-conversation summary, found: ${JSON.stringify(selfSummaries)}`
  );

  const selfUserConversations = collectUserConversationKeys(store).filter(
    (convKey) => isSelfConversationKey(convKey) || convKey === `${senderKey}__${senderKey}`
  );
  assert.strictEqual(
    selfUserConversations.length,
    0,
    `expected no self userConversations entry, found: ${JSON.stringify(selfUserConversations)}`
  );
}

// ---------------------------------------------------------------------------
// Property 3 — Bug Condition (backend write layer)
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 3 (Bug Condition): self-address prevention (chatMessageWriter.sendChatMessage)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('ANCHOR (incident): a self-addressed send persists a self-conversation record + summary instead of being rejected', async () => {
    const email = 'krvikrantsingh51@gmail.com';
    const text = 'hgghdsghs';

    await runSelfAddressedSend(email, text);

    // Property 3: a self-addressed send SHALL be rejected — nothing persisted.
    // On UNFIXED code this fails: the self record + self summary are created,
    // reproducing conversationMessages/krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com.
    assertNoSelfAddressedPersistence(getStore(), email);
  });

  it('for any send whose resolved recipient equals the sender, no record and no self-conversation node/summary is created', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (email, text) => {
          resetStore();

          await runSelfAddressedSend(email, text);

          // The self-addressed send must leave the durable store free of any self
          // record / self-conversation node / self summary. UNFIXED code violates
          // this by persisting all three.
          assertNoSelfAddressedPersistence(getStore(), email);
        }
      ),
      { numRuns: 50 }
    );
  });
});
