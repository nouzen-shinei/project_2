// Feature: chat-production-hardening (Phase 3, Task 12 — finding P3-1)
// Make true-unread recompute robust to messages missing the `read` field.
//
// **Validates: chat-production-hardening finding P3-1 (missing-`read` under-count)**
//
// BACKGROUND:
//   `computeTrueUnreadForConversation` recounts unread via the indexed
//   `orderByChild('read').equalTo(false)` query. RTDB `equalTo(false)` matches
//   ONLY records whose `read` value is exactly `false`; a record that LACKS a
//   `read` key entirely is invisible to that index → the recompute UNDER-counts a
//   legacy/foreign write missing `read`.
//
//   The fix keeps the O(unread) `read == false` index as the primary path (all
//   first-party writers force `read: false`, so it is exact in steady state) and,
//   ONLY when the stored counter claims MORE unread than the `read` index found,
//   falls back to the bounded `orderByChild('recipientId').equalTo(viewer)` index
//   (also `.indexOn`) and treats a missing `read` as unread. The fallback stays
//   bounded — it never does a full-history `get()` of the conversation node.
//
//   This test drives the REAL compiled `reconcileChatUnreadForUser` path (which
//   reads the stored counter as the hint, then calls the recompute) against a
//   functional in-memory Realtime Database whose query layer ACTUALLY implements
//   `orderByChild(...).equalTo(...)` filtering and records telemetry, so it can
//   prove:
//     (a) a message MISSING `read` (recipientId == viewer, not deleted) is counted
//         as unread;
//     (b) `read: true` and `deleted: true` records are still excluded;
//     (c) outgoing / other-recipient records are excluded;
//     (d) the recompute stays bounded — every conversationMessages read is an
//         indexed query (`read` or `recipientId`), never a full-node scan.

import assert from 'node:assert';
import { describe, it, beforeEach } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// In-memory Realtime Database with a FUNCTIONAL query layer + telemetry.
// Filters children on `orderByChild(field).equalTo(value)` (exactly like RTDB:
// a record missing `field` is NOT matched by `equalTo`) and records which
// conversationMessages reads were bounded (and on which field) vs full scans.
// ---------------------------------------------------------------------------
let telemetry;

function resetTelemetry() {
  telemetry = {
    fullConversationScans: [], // conversationMessages/<conv> read WITHOUT a filter
    boundedReadQueries: [], // conversationMessages/<conv> read WITH read==<v>
    boundedRecipientQueries: [], // conversationMessages/<conv> read WITH recipientId==<v>
    otherBoundedQueries: [], // any other filtered conversation read
    messageNodeReads: [], // single-record conversationMessages/<conv>/<msgId> reads
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

  const isConversationNode = (segments) =>
    segments.length === 4 && segments[0] === 'tenantChat' && segments[2] === 'conversationMessages';
  const isMessageNode = (segments) =>
    segments.length === 5 && segments[0] === 'tenantChat' && segments[2] === 'conversationMessages';

  const recordGet = (segments, filter) => {
    const active = filter && filter.hasValue;
    if (isConversationNode(segments)) {
      const conv = segments[3];
      if (active && filter.field === 'read') {
        telemetry.boundedReadQueries.push(conv);
      } else if (active && filter.field === 'recipientId') {
        telemetry.boundedRecipientQueries.push({ conv, value: filter.value });
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
      // Mirrors RTDB: equalTo matches only records whose `field` is exactly the
      // value. A record MISSING `field` yields `undefined !== value` → excluded.
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

  let pushCounter = 0;

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

const { reconcileChatUnreadForUser } = await import('../dist/chatMessageWriter.js');

const TENANT_ID = 'CGnHGq43PFF8WD2DJekx';
const VIEWER = 'viewer@example.com';
const PARTNER = 'partner@example.com';
const OTHER = 'other@example.com';

function sanitizeKey(email) {
  return email.trim().toLowerCase().replace(/[.@]/g, '_');
}
function conversationKeyOf(a, b) {
  return [sanitizeKey(a), sanitizeKey(b)].sort().join('__');
}
function getStore() {
  return currentDb.__store;
}
function ownerSummary(ownerEmail, partnerEmail) {
  return (
    getStore()?.tenantChat?.[TENANT_ID]?.conversationSummaries?.[sanitizeKey(ownerEmail)]?.[sanitizeKey(partnerEmail)] ??
    null
  );
}

async function seedMessage(convKey, id, record) {
  await currentDb.ref(`tenantChat/${TENANT_ID}/conversationMessages/${convKey}/${id}`).set(record);
}
async function seedSummary(ownerEmail, partnerEmail, unreadCount) {
  const convKey = conversationKeyOf(ownerEmail, partnerEmail);
  await currentDb
    .ref(`tenantChat/${TENANT_ID}/conversationSummaries/${sanitizeKey(ownerEmail)}/${sanitizeKey(partnerEmail)}`)
    .set({ partnerEmail: partnerEmail.toLowerCase(), tenantId: TENANT_ID, unreadCount, updatedAt: new Date().toISOString() });
  await currentDb
    .ref(`tenantChat/${TENANT_ID}/userConversations/${sanitizeKey(ownerEmail)}/${convKey}`)
    .set({ partnerEmail: partnerEmail.toLowerCase(), conversationKey: convKey, unreadCount });
}

function resetAll() {
  currentDb = createInMemoryDatabase();
  resetTelemetry();
}

function assertBoundedNoFullScan(convKey) {
  // Every conversationMessages read must have been an indexed query on `read` or
  // `recipientId` — never an unfiltered full-node scan, and never an N+1
  // per-message read.
  assert.strictEqual(telemetry.fullConversationScans.length, 0, 'no full-conversation scan on the recompute path');
  assert.strictEqual(telemetry.messageNodeReads.length, 0, 'no per-message N+1 reads');
  assert.ok(telemetry.boundedReadQueries.includes(convKey), 'primary read==false index query was used');
}

describe('chat-production-hardening (Task 12, P3-1) — true-unread robust to missing `read`', () => {
  beforeEach(() => {
    resetAll();
  });

  it('(a) counts a message that is MISSING the `read` field (recipientId == viewer, not deleted) as unread', async () => {
    const convKey = conversationKeyOf(VIEWER, PARTNER);
    // Legacy/foreign write: NO `read` key at all. The `read == false` index can
    // never surface this record, so an unfixed recompute under-counts it to 0.
    await seedMessage(convKey, '-legacy-noread', {
      id: '-legacy-noread',
      sender: PARTNER,
      recipientId: VIEWER,
      conversationKey: convKey,
      text: 'legacy',
      // read: (absent)
      delivered: false,
    });
    // Stored counter says 1 unread → hint (1) > read-index count (0) → fallback.
    await seedSummary(VIEWER, PARTNER, 1);

    const result = await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: VIEWER });

    // The missing-`read` message is counted as unread (1), so the stored counter
    // stays consistent at 1 rather than being wiped to 0 (the unfixed behavior).
    assert.strictEqual(ownerSummary(VIEWER, PARTNER).unreadCount, 1, 'missing-read message counted as unread');
    assert.strictEqual(result.reconciledConversations, 0, 'stored counter already matched the true count');

    // (d) bounded — the recipientId fallback fired but it is an indexed query.
    assertBoundedNoFullScan(convKey);
    assert.ok(
      telemetry.boundedRecipientQueries.some((q) => q.conv === convKey && q.value === VIEWER),
      'bounded recipientId==viewer fallback query was used to catch the missing-read record'
    );
  });

  it('(a2) reconciles a drifted counter DOWN using the missing-read-aware fallback (never below the true count)', async () => {
    const convKey = conversationKeyOf(VIEWER, PARTNER);
    // One genuinely-unread record missing `read`, plus a stored counter drifted
    // high (5). The recompute must converge to 1, not 0 and not 5.
    await seedMessage(convKey, '-noread', {
      id: '-noread',
      sender: PARTNER,
      recipientId: VIEWER,
      conversationKey: convKey,
      text: 'noread',
    });
    await seedSummary(VIEWER, PARTNER, 5);

    const result = await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: VIEWER });

    assert.strictEqual(result.reconciledConversations, 1, 'drifted counter reconciled');
    assert.strictEqual(ownerSummary(VIEWER, PARTNER).unreadCount, 1, 'converges to the true unread count (1)');
    assertBoundedNoFullScan(convKey);
  });

  it('(b) still excludes `read: true` and `deleted: true` records even through the fallback', async () => {
    const convKey = conversationKeyOf(VIEWER, PARTNER);
    // Only-unread: the missing-read record. The read:true and deleted records
    // must NOT be counted.
    await seedMessage(convKey, '-noread', {
      id: '-noread',
      sender: PARTNER,
      recipientId: VIEWER,
      conversationKey: convKey,
      text: 'unread',
    });
    await seedMessage(convKey, '-alreadyread', {
      id: '-alreadyread',
      sender: PARTNER,
      recipientId: VIEWER,
      conversationKey: convKey,
      text: 'read',
      read: true,
    });
    await seedMessage(convKey, '-deleted', {
      id: '-deleted',
      sender: PARTNER,
      recipientId: VIEWER,
      conversationKey: convKey,
      text: 'deleted',
      read: false,
      deleted: true,
    });
    // Hint (5) forces the fallback (read-index count re-checks to 0: the only
    // read==false record is the deleted one, which the predicate drops).
    await seedSummary(VIEWER, PARTNER, 5);

    await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: VIEWER });

    // Exactly the one missing-read message counts; read:true and deleted excluded.
    assert.strictEqual(ownerSummary(VIEWER, PARTNER).unreadCount, 1, 'read:true and deleted:true excluded');
    assertBoundedNoFullScan(convKey);
  });

  it('(c) excludes outgoing and other-recipient records', async () => {
    const convKey = conversationKeyOf(VIEWER, PARTNER);
    // Incoming to viewer (missing read) — counts.
    await seedMessage(convKey, '-incoming', {
      id: '-incoming',
      sender: PARTNER,
      recipientId: VIEWER,
      conversationKey: convKey,
      text: 'incoming',
    });
    // Outgoing (viewer -> partner), missing read — must NOT count for viewer.
    await seedMessage(convKey, '-outgoing', {
      id: '-outgoing',
      sender: VIEWER,
      recipientId: PARTNER,
      conversationKey: convKey,
      text: 'outgoing',
    });
    // Addressed to a DIFFERENT recipient, missing read — must NOT count.
    await seedMessage(convKey, '-tothird', {
      id: '-tothird',
      sender: PARTNER,
      recipientId: OTHER,
      conversationKey: convKey,
      text: 'not for viewer',
    });
    await seedSummary(VIEWER, PARTNER, 3);

    await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: VIEWER });

    assert.strictEqual(ownerSummary(VIEWER, PARTNER).unreadCount, 1, 'only the incoming-to-viewer record counts');
    assertBoundedNoFullScan(convKey);
    // The fallback recipientId query is scoped to the viewer, so outgoing /
    // other-recipient records are excluded by the index itself.
    assert.ok(
      telemetry.boundedRecipientQueries.every((q) => q.value === VIEWER),
      'recipientId fallback is scoped to the viewer only'
    );
  });

  it('does NOT fire the recipientId fallback when the read index already matches the stored counter (hot path stays O(unread))', async () => {
    const convKey = conversationKeyOf(VIEWER, PARTNER);
    // A well-formed unread record (read: false) and a stored counter that agrees.
    await seedMessage(convKey, '-proper', {
      id: '-proper',
      sender: PARTNER,
      recipientId: VIEWER,
      conversationKey: convKey,
      text: 'proper',
      read: false,
    });
    await seedSummary(VIEWER, PARTNER, 1);

    const result = await reconcileChatUnreadForUser({ tenantId: TENANT_ID, actorEmail: VIEWER });

    assert.strictEqual(ownerSummary(VIEWER, PARTNER).unreadCount, 1);
    assert.strictEqual(result.reconciledConversations, 0, 'no drift, no write');
    // Primary read==false index used; the recipientId fallback was NOT needed.
    assert.ok(telemetry.boundedReadQueries.includes(convKey), 'primary read index used');
    assert.strictEqual(telemetry.boundedRecipientQueries.length, 0, 'recipientId fallback not fired on the in-sync path');
    assert.strictEqual(telemetry.fullConversationScans.length, 0, 'never a full scan');
  });
});
