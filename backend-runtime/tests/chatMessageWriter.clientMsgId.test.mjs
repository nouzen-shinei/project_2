// Feature: stuck-message-delivery-fix (production hotfix — Fix A)
// Path-safe clientMsgId sanitization at the backend write boundary.
//
// **Validates: Requirements 2.1, 2.2, 2.4 (delivery / idempotent upsert)**
//
// REGRESSION TEST:
//   A pending/temp id minted on the client becomes the message `clientMsgId`,
//   which the backend uses as a `.child(<clientMsgId>)` path segment in the
//   per-conversation idempotency index
//   (`conversationClientMsgIndex/<conversationKey>/<clientMsgId>`). Firebase RTDB
//   rejects any path segment containing `.`, `#`, `$`, `[`, `]`, or `/`. The
//   offline-queued text path used to mint `pending_${Date.now()}_${Math.random()}`
//   — raw `Math.random()` yields e.g. `0.2959597461785538`, whose `.` is illegal —
//   so every auto-resend of a queued message failed with HTTP 500 `send_failed`.
//
//   This test drives the REAL compiled `sendChatMessage` write path against a
//   functional in-memory Realtime Database. It proves that a clientMsgId
//   containing illegal path characters:
//     (a) does NOT crash the writer (no throw / no 500),
//     (b) is persisted + indexed under the SANITIZED key (illegal chars -> `_`),
//     (c) is idempotent — a retried send with the SAME raw clientMsgId returns the
//         SAME durable record and creates no duplicate.
//
// WHAT IS EXERCISED FOR REAL:
//   Only the Firebase transport is mocked; the sanitization + idempotent-upsert
//   logic under test runs unmodified from `../dist/chatMessageWriter.js`.

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';
import fc from 'fast-check';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory Realtime Database + firebase-admin mock (same functional tree store
// pattern used by chatMessageWriter.selfAddress.test.mjs).
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

// The six characters Firebase RTDB forbids in a path segment.
const ILLEGAL_RTDB_PATH_CHARS = ['.', '#', '$', '[', ']', '/'];

function resetStore() {
  currentDb = createInMemoryDatabase();
}

function getStore() {
  return currentDb.__store;
}

// Mirror of the production sanitizer (must stay identical to lib/pendingId.ts +
// chatMessageWriter.ts) — used only to compute the EXPECTED sanitized value.
function expectedSanitize(id) {
  return String(id).trim().replace(/[.#$[\]/]/g, '_');
}

function containsIllegalPathChar(value) {
  return ILLEGAL_RTDB_PATH_CHARS.some((ch) => String(value).includes(ch));
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

function collectClientMsgIndexKeys(store) {
  const out = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const index = tenants[tenantId]?.conversationClientMsgIndex ?? {};
    for (const convKey of Object.keys(index)) {
      const entries = index[convKey] ?? {};
      for (const indexKey of Object.keys(entries)) {
        out.push({ convKey, indexKey, messageId: entries[indexKey] });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix (Fix A) — path-safe clientMsgId sanitization at the backend write boundary', () => {
  beforeEach(() => {
    resetStore();
  });

  it('ANCHOR (incident): a clientMsgId containing a dot (raw Math.random) does NOT crash the writer and is indexed under the sanitized key', async () => {
    const sender = 'krvikrantsingh51@gmail.com';
    const recipient = 'invipika@gmail.com'; // a REAL, distinct recipient
    const rawClientMsgId = 'pending_1731000000000_0.2959597461785538';

    // Must NOT throw (no HTTP 500). The unfixed writer would reject the `.` path.
    const record = await sendChatMessage({
      senderEmail: sender,
      recipientEmail: recipient,
      tenantId: TENANT_ID,
      clientMsgId: rawClientMsgId,
      text: 'hgghdsghs',
      isSpecial: false,
    });

    assert.ok(record && typeof record.id === 'string', 'send should return a durable record');

    // The stored clientMsgId is the sanitized value (dot -> underscore).
    const sanitized = expectedSanitize(rawClientMsgId);
    assert.strictEqual(record.clientMsgId, sanitized, 'stored clientMsgId should be sanitized');
    assert.ok(!containsIllegalPathChar(sanitized), 'sanitized id must be path-safe');

    // Exactly one durable message; recipient is the real (non-self) recipient.
    const durable = collectDurableMessages(getStore());
    assert.strictEqual(durable.length, 1, 'exactly one durable record created');
    assert.strictEqual(durable[0].recipientId, recipient);

    // The idempotency index is keyed under the sanitized clientMsgId and points to
    // the message id — and NO index key contains an illegal path char.
    const indexKeys = collectClientMsgIndexKeys(getStore());
    assert.strictEqual(indexKeys.length, 1, 'exactly one client-msg index entry');
    assert.strictEqual(indexKeys[0].indexKey, sanitized);
    assert.strictEqual(indexKeys[0].messageId, record.id);
    assert.ok(!containsIllegalPathChar(indexKeys[0].indexKey), 'index key must be path-safe');
  });

  it('IDEMPOTENT: a retried send with the SAME raw (illegal) clientMsgId returns the same record and creates no duplicate', async () => {
    const sender = 'krvikrantsingh51@gmail.com';
    const recipient = 'invipika@gmail.com';
    const rawClientMsgId = 'pending_1731000000000_0.42#weird$[id]/x';

    const first = await sendChatMessage({
      senderEmail: sender,
      recipientEmail: recipient,
      tenantId: TENANT_ID,
      clientMsgId: rawClientMsgId,
      text: 'first',
    });
    const second = await sendChatMessage({
      senderEmail: sender,
      recipientEmail: recipient,
      tenantId: TENANT_ID,
      clientMsgId: rawClientMsgId, // same raw id -> same sanitized key -> dedupe
      text: 'second (retry / re-drive)',
    });

    assert.strictEqual(second.id, first.id, 'idempotent upsert returns the existing record');

    const durable = collectDurableMessages(getStore());
    assert.strictEqual(durable.length, 1, 'no duplicate durable record for the same clientMsgId');
    assert.strictEqual(durable[0].text, 'first', 'the original record is preserved');

    const indexKeys = collectClientMsgIndexKeys(getStore());
    assert.strictEqual(indexKeys.length, 1, 'exactly one index entry survives');
    assert.ok(!containsIllegalPathChar(indexKeys[0].indexKey), 'index key must be path-safe');
  });

  it('for any clientMsgId containing illegal path chars, the writer never throws and never writes an illegal index/record key', async () => {
    const alnum = fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
        minLength: 1,
        maxLength: 8,
      })
      .map((chars) => chars.join(''));
    const illegalRun = fc
      .array(fc.constantFrom(...ILLEGAL_RTDB_PATH_CHARS), { minLength: 1, maxLength: 4 })
      .map((chars) => chars.join(''));
    const clientMsgIdArb = fc
      .tuple(alnum, illegalRun, alnum)
      .map(([a, ill, b]) => `${a}${ill}${b}`);

    await fc.assert(
      fc.asyncProperty(clientMsgIdArb, fc.string({ minLength: 1, maxLength: 40 }), async (rawClientMsgId, text) => {
        resetStore();
        const sender = 'sender@example.com';
        const recipient = 'recipient@example.com'; // real, distinct recipient

        // Must not throw for any illegal clientMsgId.
        const record = await sendChatMessage({
          senderEmail: sender,
          recipientEmail: recipient,
          tenantId: TENANT_ID,
          clientMsgId: rawClientMsgId,
          text,
        });

        const sanitized = expectedSanitize(rawClientMsgId);
        assert.strictEqual(record.clientMsgId, sanitized);
        assert.ok(!containsIllegalPathChar(record.clientMsgId));

        // No path segment key under the client-msg index may contain an illegal char.
        for (const entry of collectClientMsgIndexKeys(getStore())) {
          assert.ok(
            !containsIllegalPathChar(entry.indexKey),
            `index key must be path-safe, got: ${entry.indexKey}`
          );
        }

        // A second send with the same raw id must dedupe to one record.
        const retry = await sendChatMessage({
          senderEmail: sender,
          recipientEmail: recipient,
          tenantId: TENANT_ID,
          clientMsgId: rawClientMsgId,
          text: `${text}-retry`,
        });
        assert.strictEqual(retry.id, record.id);
        assert.strictEqual(collectDurableMessages(getStore()).length, 1);
      }),
      { numRuns: 50 }
    );
  });
});
