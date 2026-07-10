// Feature: stuck-message-delivery-fix — grace-window release hardening.
//
// The shared conversation watcher multiplexes one Firebase listen per
// conversation across all subscribers. Previously the watch was torn down
// SYNCHRONOUSLY the instant its last subscriber left; a quick re-subscribe then
// re-attached `.on()` for the same path and could trip Firebase's internal
// assert "listen() called twice for same path/queryId", killing the realtime
// stream.
//
// The hardened watcher keeps the listeners alive for a short grace window after
// the last subscriber leaves. This test asserts:
//   (a) after the last subscriber unsubscribes the Firebase listener is NOT
//       detached immediately (still attached during the grace window);
//   (b) a new subscriber attaching within the window reuses the live watch and
//       `.off()` is never called (no re-attach);
//   (c) once the window elapses with zero subscribers, `.off()` runs exactly
//       once and the cache entry is removed;
//   (d) messages still deliver across subscribe -> last-unsubscribe ->
//       resubscribe-within-window.
//
// Time is advanced deterministically with Node's fake timers — no real sleeps.
// Only the Firebase transport is mocked; the watcher logic runs unmodified from
// `../dist/chatRealtime.js`.

import assert from 'assert';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createRequire } from 'module';

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

const GRACE_MS = 5000;

function createDataSnapshot(key, value) {
  return {
    key,
    val: () => value,
  };
}

function createRealtimeDbHarness() {
  const listeners = {
    child_added: null,
    child_changed: null,
  };

  const onCalls = [];
  const offCalls = [];
  let onceCalls = 0;
  let seed = [];

  const conversationRef = {
    once: async (eventName) => {
      assert.strictEqual(eventName, 'value');
      onceCalls += 1;
      const items = seed;
      return {
        forEach: (callback) => {
          for (const item of items) {
            callback(createDataSnapshot(item.id, item.value));
          }
          return false;
        },
      };
    },
    on: (eventName, callback) => {
      onCalls.push({ eventName, callback });
      listeners[eventName] = callback;
    },
    off: (eventName, callback) => {
      offCalls.push({ eventName, callback });
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

  const countOff = (eventName) => offCalls.filter((entry) => entry.eventName === eventName).length;
  const countOn = (eventName) => onCalls.filter((entry) => entry.eventName === eventName).length;

  return {
    db,
    listeners,
    onCalls,
    offCalls,
    countOn,
    countOff,
    getOnceCalls: () => onceCalls,
    setSeed: (items) => {
      seed = items;
    },
    emitChildAdded: (id, value) => {
      assert.strictEqual(typeof listeners.child_added, 'function', 'child_added listener must be attached');
      listeners.child_added(createDataSnapshot(id, value));
    },
  };
}

const makeMessage = (text, timestamp = '2026-04-15T00:00:01.000Z') => ({
  sender: 'alice@example.com',
  recipientId: 'bob@example.com',
  text,
  timestamp,
});

const TENANT = 'tenant-1';
const CONVERSATION_KEY = 'alice_example_com__bob_example_com';

describe('chat realtime watcher multiplexing + grace-window release', () => {
  beforeEach(() => {
    chatRealtime.__setSharedWatchReleaseGraceMs(GRACE_MS);
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    chatRealtime.__resetSharedWatchReleaseGraceMs();
    assert.deepStrictEqual(
      chatRealtime.getConversationWatchStats(),
      { activeWatches: 0, totalSubscribers: 0 },
      'each test must leave the watch cache empty'
    );
  });

  it('shares one Firebase listener set for concurrent subscribers', async () => {
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;
    harness.setSeed([
      {
        id: 'existing-1',
        value: {
          sender: 'alice@example.com',
          recipientId: 'bob@example.com',
          text: 'seed',
          timestamp: '2026-04-15T00:00:00.000Z',
        },
      },
    ]);

    const eventsA = [];
    const eventsB = [];

    const watchPromiseA = chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: (payload) => eventsA.push(payload),
    });
    const watchPromiseB = chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: (payload) => eventsB.push(payload),
    });

    const cleanupA = await watchPromiseA;
    const cleanupB = await watchPromiseB;

    // One shared listen and one initial read across both subscribers.
    assert.strictEqual(harness.getOnceCalls(), 1);
    assert.strictEqual(harness.countOn('child_added'), 1);
    assert.strictEqual(harness.countOn('child_changed'), 1);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 2 });

    harness.emitChildAdded('new-1', makeMessage('hello'));
    assert.strictEqual(eventsA.length, 1);
    assert.strictEqual(eventsB.length, 1);
    assert.strictEqual(eventsA[0].id, 'new-1');
    assert.strictEqual(eventsB[0].id, 'new-1');

    // Dropping one of two subscribers must not schedule a release or detach.
    cleanupA();
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });
    assert.strictEqual(chatRealtime.__hasPendingRelease(TENANT, CONVERSATION_KEY), false);
    assert.strictEqual(harness.offCalls.length, 0);

    // Last unsubscribe -> release the watch after the grace window elapses.
    cleanupB();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('(a) does not detach the Firebase listener immediately when the last subscriber leaves', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: () => {},
    });
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });

    cleanup();

    // The listener is STILL attached during the grace window: no `.off()` yet,
    // the watch is still cached, and a release is pending.
    assert.strictEqual(harness.offCalls.length, 0);
    assert.strictEqual(typeof harness.listeners.child_added, 'function');
    assert.strictEqual(typeof harness.listeners.child_changed, 'function');
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 0 });
    assert.strictEqual(chatRealtime.__hasPendingRelease(TENANT, CONVERSATION_KEY), true);

    // Partway through the window the watch is still alive.
    mock.timers.tick(GRACE_MS - 1);
    assert.strictEqual(harness.offCalls.length, 0);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 0 });

    // Let it release so the afterEach cache assertion holds.
    mock.timers.tick(1);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('(b) reuses the live watch when a new subscriber attaches within the window (never re-attaches)', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const cleanupA = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: () => {},
    });
    assert.strictEqual(harness.countOn('child_added'), 1);
    assert.strictEqual(harness.countOn('child_changed'), 1);

    cleanupA();
    assert.strictEqual(chatRealtime.__hasPendingRelease(TENANT, CONVERSATION_KEY), true);

    // Re-subscribe partway through the grace window.
    mock.timers.tick(GRACE_MS - 1);
    const cleanupB = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: () => {},
    });

    // Reused the same watch: no second `.on()` (no re-attach), no `.off()`, one
    // shared `once()`, and the pending release was cancelled.
    assert.strictEqual(harness.countOn('child_added'), 1);
    assert.strictEqual(harness.countOn('child_changed'), 1);
    assert.strictEqual(harness.offCalls.length, 0);
    assert.strictEqual(harness.getOnceCalls(), 1);
    assert.strictEqual(chatRealtime.__hasPendingRelease(TENANT, CONVERSATION_KEY), false);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });

    // The originally scheduled release must NOT fire now that it was cancelled.
    mock.timers.tick(GRACE_MS * 5);
    assert.strictEqual(harness.offCalls.length, 0);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });

    cleanupB();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('(c) detaches exactly once and drops the cache entry when the window elapses with zero subscribers', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const cleanup = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: () => {},
    });
    cleanup();

    mock.timers.tick(GRACE_MS);

    assert.strictEqual(harness.countOff('child_added'), 1);
    assert.strictEqual(harness.countOff('child_changed'), 1);
    assert.strictEqual(harness.listeners.child_added, null);
    assert.strictEqual(harness.listeners.child_changed, null);
    assert.strictEqual(chatRealtime.__hasPendingRelease(TENANT, CONVERSATION_KEY), false);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    // Advancing further must not detach again (idempotent teardown).
    mock.timers.tick(GRACE_MS * 3);
    assert.strictEqual(harness.countOff('child_added'), 1);
    assert.strictEqual(harness.countOff('child_changed'), 1);
  });

  it('(d) keeps delivering across subscribe -> last-unsubscribe -> resubscribe-within-window', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const eventsA = [];
    const cleanupA = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: (payload) => eventsA.push(payload),
    });

    harness.emitChildAdded('m1', makeMessage('first'));
    assert.strictEqual(eventsA.length, 1);
    assert.strictEqual(eventsA[0].id, 'm1');

    // Last subscriber leaves; watch stays alive within the grace window.
    cleanupA();
    assert.strictEqual(chatRealtime.__hasPendingRelease(TENANT, CONVERSATION_KEY), true);

    // Re-subscribe within the window (reuses live listeners, no re-attach).
    const eventsB = [];
    mock.timers.tick(GRACE_MS - 1);
    const cleanupB = await chatRealtime.watchConversationRealtime(TENANT, CONVERSATION_KEY, {
      onMessage: (payload) => eventsB.push(payload),
    });

    // A fresh message is delivered to the new subscriber on the reused watch.
    harness.emitChildAdded('m2', makeMessage('second', '2026-04-15T00:00:02.000Z'));
    assert.strictEqual(eventsB.length, 1);
    assert.strictEqual(eventsB[0].id, 'm2');
    // The old subscriber (already gone) receives nothing further.
    assert.strictEqual(eventsA.length, 1);

    cleanupB();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });
});
