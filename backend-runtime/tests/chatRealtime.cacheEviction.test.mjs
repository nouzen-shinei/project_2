// Feature: chat-production-hardening — Task 8 (finding P3-3).
//
// ROOT CAUSE:
//   The shared conversation watcher used to keep a full-payload `messageCache`
//   trimmed together with `knownMessageIds` when it exceeded 1200 entries. For a
//   conversation with more messages than the cap, an older message whose entry
//   was EVICTED produced `previous === undefined` inside the `child_changed`
//   handler. The diff logic then treated the evicted message as brand-new:
//     - `statusChanged` was true (`!previous`)         -> phantom onStatus
//     - `didMessageContentChange(undefined, ...)` true -> phantom onMessageUpdate
//     - `payload.deleted && !previous?.deleted`        -> phantom onMessageDelete
//   So a receipt/edit on an old message (or any re-emitted child_changed for an
//   evicted id) re-broadcast fake status/update/delete events to EVERY
//   subscriber.
//
// FIX (this test proves):
//   The watcher now retains a COMPACT per-message diff signature. A `child_changed`
//   with no prior signature (never-seen OR merely evicted) only RE-SEEDS the
//   signature and broadcasts nothing. A genuine transition diffed against a real
//   prior signature still broadcasts exactly once.
//
//   (a) a child_changed for an EVICTED id that carries no real change emits
//       NONE of onStatus / onMessageUpdate / onMessageDelete;
//   (b) once the signature is re-seeded, a real status change (delivered
//       false -> true) for that (evicted) id still emits onStatus exactly once;
//   (c) a genuine new message emits onMessage once, a real content edit emits
//       onMessageUpdate once, and a real delete emits onMessageDelete once.
//
// The diff-signature cap is overridden to a small value so eviction is forced
// with a handful of messages. The grace window is set to 0 so watches release
// immediately (no fake timers needed). Only the Firebase transport is mocked;
// the watcher logic runs unmodified from `../dist/chatRealtime.js`.

import assert from 'node:assert';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';

process.env.TEST_MODE = '1';

const require = createRequire(import.meta.url);
const firebaseAdmin = require('firebase-admin');
const firebaseAdminHelpers = require('../dist/firebaseAdmin.js');
const adminPrototype = Object.getPrototypeOf(firebaseAdmin);
const cleanupStack = [];

function overrideDescriptor(target, name, descriptor) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  cleanupStack.push(() => {
    if (original) {
      Object.defineProperty(target, name, original);
    } else {
      delete target[name];
    }
  });
  Object.defineProperty(target, name, descriptor);
}

let activeDatabaseFactory = () => {
  throw new Error('database mock not configured');
};

overrideDescriptor(adminPrototype, 'database', {
  configurable: true,
  enumerable: true,
  get: () => activeDatabaseFactory,
});

overrideDescriptor(firebaseAdminHelpers, 'ensureFirebase', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: () => {},
});

after(() => {
  while (cleanupStack.length) {
    const restore = cleanupStack.pop();
    try {
      restore?.();
    } catch {
      // Ignore restoration failures in test cleanup.
    }
  }
});

const chatRealtime = await import('../dist/chatRealtime.js');

const TENANT = 'tenant-1';
const CONVERSATION_KEY = 'alice_example_com__bob_example_com';
const CACHE_CAP = 3;

function createDataSnapshot(key, value) {
  return { key, val: () => value };
}

function createRealtimeDbHarness() {
  const listeners = { child_added: null, child_changed: null };

  const conversationRef = {
    once: async (eventName) => {
      assert.strictEqual(eventName, 'value');
      return { forEach: () => false }; // no seed messages
    },
    on: (eventName, callback) => {
      listeners[eventName] = callback;
    },
    off: (eventName, callback) => {
      if (!callback || listeners[eventName] === callback) {
        listeners[eventName] = null;
      }
    },
  };

  const conversationMessagesRef = { child: () => conversationRef };
  const tenantRef = {
    child: (segment) => (segment === 'conversationMessages' ? conversationMessagesRef : tenantRef),
  };
  const tenantChatRef = { child: () => tenantRef };
  const db = { ref: () => tenantChatRef };

  return {
    db,
    listeners,
    emitChildAdded: (id, value) => {
      assert.strictEqual(typeof listeners.child_added, 'function', 'child_added listener must be attached');
      listeners.child_added(createDataSnapshot(id, value));
    },
    emitChildChanged: (id, value) => {
      assert.strictEqual(typeof listeners.child_changed, 'function', 'child_changed listener must be attached');
      listeners.child_changed(createDataSnapshot(id, value));
    },
  };
}

const makeMessage = (overrides = {}) => ({
  sender: 'alice@example.com',
  recipientId: 'bob@example.com',
  text: 'hello',
  timestamp: '2026-04-15T00:00:01.000Z',
  ...overrides,
});

function createCollectingHandlers() {
  const events = { onMessage: [], onStatus: [], onMessageUpdate: [], onMessageDelete: [] };
  const handlers = {
    onMessage: (payload) => events.onMessage.push(payload),
    onStatus: (payload) => events.onStatus.push(payload),
    onMessageUpdate: (payload) => events.onMessageUpdate.push(payload),
    onMessageDelete: (payload) => events.onMessageDelete.push(payload),
  };
  return { events, handlers };
}

// Add enough distinct messages to overflow the cap and evict the earliest id.
// With CACHE_CAP = 3, adding m1..m4 evicts m1's diff signature.
function fillPastCap(harness) {
  harness.emitChildAdded('m1', makeMessage({ text: 'm1' }));
  harness.emitChildAdded('m2', makeMessage({ text: 'm2' }));
  harness.emitChildAdded('m3', makeMessage({ text: 'm3' }));
  harness.emitChildAdded('m4', makeMessage({ text: 'm4' }));
}

describe('chat realtime shared watch — cache eviction without spurious re-broadcast (P3-3)', () => {
  beforeEach(() => {
    chatRealtime.__setSharedWatchCacheCap(CACHE_CAP);
    chatRealtime.__setSharedWatchReleaseGraceMs(0); // release immediately, no timers
  });

  afterEach(() => {
    chatRealtime.__resetSharedWatchCacheCap();
    chatRealtime.__resetSharedWatchReleaseGraceMs();
    assert.deepStrictEqual(
      chatRealtime.getConversationWatchStats(),
      { activeWatches: 0, totalSubscribers: 0 },
      'each test must leave the watch cache empty'
    );
  });

  it('(a) a child_changed for an EVICTED id with no real change emits no phantom status/update/delete', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const { events, handlers } = createCollectingHandlers();
    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, handlers);

    fillPastCap(harness); // m1's diff signature is now evicted
    assert.strictEqual(events.onMessage.length, 4, 'four genuinely new messages should have broadcast onMessage');

    // A child_changed for the evicted id carrying the SAME data the client
    // already has. With the old code this fired phantom onStatus + onMessageUpdate.
    harness.emitChildChanged('m1', makeMessage({ text: 'm1' }));

    assert.strictEqual(events.onStatus.length, 0, 'no phantom onStatus for an evicted id');
    assert.strictEqual(events.onMessageUpdate.length, 0, 'no phantom onMessageUpdate for an evicted id');
    assert.strictEqual(events.onMessageDelete.length, 0, 'no phantom onMessageDelete for an evicted id');

    cleanup();
  });

  it('(a2) a child_changed for an evicted id that happens to be marked deleted does NOT re-broadcast a phantom delete', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const { events, handlers } = createCollectingHandlers();
    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, handlers);

    fillPastCap(harness); // m1 evicted

    // The evicted message is already deleted in the DB; a re-emitted child_changed
    // must NOT resurface it as a fresh delete (old code fired onMessageDelete).
    harness.emitChildChanged('m1', makeMessage({ text: 'm1', deleted: true, deletedAt: '2026-04-15T00:05:00.000Z' }));

    assert.strictEqual(events.onMessageDelete.length, 0, 'no phantom onMessageDelete from a cache miss');
    assert.strictEqual(events.onStatus.length, 0, 'no phantom onStatus from a cache miss');
    assert.strictEqual(events.onMessageUpdate.length, 0, 'no phantom onMessageUpdate from a cache miss');

    cleanup();
  });

  it('(b) after re-seeding an evicted id, a real status change (delivered false -> true) still emits onStatus once', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const { events, handlers } = createCollectingHandlers();
    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, handlers);

    fillPastCap(harness); // m1 evicted

    // First child_changed after eviction re-seeds the compact signature (no emit).
    harness.emitChildChanged('m1', makeMessage({ text: 'm1', delivered: false }));
    assert.strictEqual(events.onStatus.length, 0, 're-seed of an evicted id must not emit');

    // A genuine delivered false -> true transition now diffs against real prior
    // state and broadcasts exactly once.
    harness.emitChildChanged('m1', makeMessage({ text: 'm1', delivered: true, deliveredAt: '2026-04-15T00:10:00.000Z' }));

    assert.strictEqual(events.onStatus.length, 1, 'a real status change must still emit onStatus once');
    assert.strictEqual(events.onStatus[0].id, 'm1');
    assert.strictEqual(events.onStatus[0].delivered, true);
    assert.strictEqual(events.onMessageUpdate.length, 0, 'a pure status change is not a content update');
    assert.strictEqual(events.onMessageDelete.length, 0);

    cleanup();
  });

  it('(c1) a genuinely new message broadcasts onMessage exactly once', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const { events, handlers } = createCollectingHandlers();
    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, handlers);

    harness.emitChildAdded('new-1', makeMessage({ text: 'brand new' }));
    // A duplicate child_added for the same id must be deduped.
    harness.emitChildAdded('new-1', makeMessage({ text: 'brand new' }));

    assert.strictEqual(events.onMessage.length, 1, 'a new message broadcasts onMessage exactly once');
    assert.strictEqual(events.onMessage[0].id, 'new-1');

    cleanup();
  });

  it('(c2) a real content edit on a cached message broadcasts onMessageUpdate exactly once', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const { events, handlers } = createCollectingHandlers();
    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, handlers);

    harness.emitChildAdded('edit-1', makeMessage({ text: 'original' }));
    assert.strictEqual(events.onMessage.length, 1);

    harness.emitChildChanged('edit-1', makeMessage({ text: 'edited', editedAt: '2026-04-15T00:20:00.000Z' }));

    assert.strictEqual(events.onMessageUpdate.length, 1, 'a real content edit broadcasts onMessageUpdate once');
    assert.strictEqual(events.onMessageUpdate[0].id, 'edit-1');
    assert.strictEqual(events.onMessageUpdate[0].text, 'edited');
    assert.strictEqual(events.onStatus.length, 0, 'a pure content edit is not a status change');
    assert.strictEqual(events.onMessageDelete.length, 0);

    cleanup();
  });

  it('(c3) a real delete on a cached message broadcasts onMessageDelete exactly once', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const { events, handlers } = createCollectingHandlers();
    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, handlers);

    harness.emitChildAdded('del-1', makeMessage({ text: 'to be deleted' }));

    harness.emitChildChanged('del-1', makeMessage({ text: 'to be deleted', deleted: true, deletedAt: '2026-04-15T00:30:00.000Z' }));

    assert.strictEqual(events.onMessageDelete.length, 1, 'a real delete transition broadcasts onMessageDelete once');
    assert.strictEqual(events.onMessageDelete[0].id, 'del-1');
    assert.strictEqual(events.onMessageDelete[0].deleted, true);

    // Re-emitting the same deleted state must not fire a second delete.
    harness.emitChildChanged('del-1', makeMessage({ text: 'to be deleted', deleted: true, deletedAt: '2026-04-15T00:30:00.000Z' }));
    assert.strictEqual(events.onMessageDelete.length, 1, 'a re-emitted deleted state must not re-fire onMessageDelete');

    cleanup();
  });
});
