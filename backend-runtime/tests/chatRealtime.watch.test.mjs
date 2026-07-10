// Feature: stuck-message-delivery-fix (production hotfix — Fix C)
// Harden the shared realtime watcher against the teardown/re-attach race.
//
// ROOT CAUSE:
//   `watchConversationRealtime` shares one Firebase listen per conversation. When
//   the last subscriber disconnects it calls `.off()` and drops the cache entry.
//   Under connection churn a new subscriber can re-attach `.on()` for the same
//   path before the SDK released the prior listen, producing the internal assert
//   `listen() called twice for same path/queryId`. When that throws, the realtime
//   stream dies (breaking live delivery + chat notifications).
//
// HARDENING: the watcher now keeps the shared listen alive for a short grace
// window after the LAST subscriber leaves, instead of tearing it down
// synchronously. A quick re-subscribe within the window reuses the live
// listeners (no `.off()`, no re-attach) — which is what eliminates the churn
// that produced the "listen() called twice" assert.
//
// THIS TEST proves the hardened watcher:
//   1. subscribe -> unsubscribe (last) -> immediate resubscribe for the SAME
//      conversation reuses the live watch, does NOT throw, and re-delivers,
//   2. after the grace window elapses (real teardown), survives a `.on()` that
//      throws the "listen() called twice" assertion on re-attach (defensive off
//      + single re-attach), and
//   3. tears down the Firebase listener at most once (idempotent cleanup),
//      driven deterministically with Node's fake timers (no real sleeps).
//
// Only the Firebase transport is mocked; the watcher logic runs unmodified from
// `../dist/chatRealtime.js`.

import assert from 'node:assert';
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test';
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

const CONVERSATION_KEY = 'alice_example_com__bob_example_com';

function createDataSnapshot(key, value) {
  return { key, val: () => value };
}

/**
 * A conversation-ref harness. `once('value')` resolves immediately with an empty
 * seed. `on()` records listeners and can be told to throw the "listen() called
 * twice" assertion exactly once for a given event (to exercise the defensive
 * re-attach path). `off()` clears the active listener.
 */
function createRealtimeDbHarness() {
  const listeners = { child_added: null, child_changed: null };
  const onCalls = [];
  const offCalls = [];
  const throwListenTwiceOnce = { child_added: false, child_changed: false };

  const conversationRef = {
    once: async (eventName) => {
      assert.strictEqual(eventName, 'value');
      return {
        forEach: () => false, // no seed messages
      };
    },
    on: (eventName, callback) => {
      if (throwListenTwiceOnce[eventName]) {
        throwListenTwiceOnce[eventName] = false;
        throw new Error(
          'Firebase Database INTERNAL ASSERT FAILED: listen() called twice for same path/queryId'
        );
      }
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
  const tenantRef = { child: (segment) => (segment === 'conversationMessages' ? conversationMessagesRef : tenantRef) };
  const tenantChatRef = { child: () => tenantRef };
  const db = { ref: () => tenantChatRef };

  return {
    db,
    listeners,
    onCalls,
    offCalls,
    scheduleListenTwiceThrow: (eventName) => {
      throwListenTwiceOnce[eventName] = true;
    },
    emitChildAdded: (id, value) => {
      assert.strictEqual(typeof listeners.child_added, 'function', 'child_added listener must be attached');
      listeners.child_added(createDataSnapshot(id, value));
    },
  };
}

const makeMessage = (text) => ({
  sender: 'alice@example.com',
  recipientId: 'bob@example.com',
  text,
  timestamp: '2026-04-15T00:00:01.000Z',
});

const GRACE_MS = 5000;

describe('stuck-message-delivery-fix (Fix C) — realtime watcher survives teardown/re-attach churn', () => {
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

  it('subscribe -> unsubscribe (last) -> immediate resubscribe reuses the live watch, does NOT throw, and re-delivers', async () => {
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    // --- First subscription ---
    const eventsA = [];
    const cleanupA = await chatRealtime.watchConversationRealtime('tenant-1', CONVERSATION_KEY, {
      onMessage: (payload) => eventsA.push(payload),
    });
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });
    assert.strictEqual(harness.onCalls.filter((e) => e.eventName === 'child_added').length, 1);

    harness.emitChildAdded('m1', makeMessage('hello'));
    assert.strictEqual(eventsA.length, 1);
    assert.strictEqual(eventsA[0].id, 'm1');

    // --- Last unsubscribe schedules a deferred release; the listener STAYS
    //     attached during the grace window (no `.off()` yet). ---
    cleanupA();
    assert.strictEqual(harness.offCalls.length, 0);
    assert.strictEqual(chatRealtime.__hasPendingRelease('tenant-1', CONVERSATION_KEY), true);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 0 });

    // --- Immediate resubscribe for the SAME conversation must NOT throw and
    //     must reuse the live listeners (no re-attach, no `.off()`). ---
    const eventsB = [];
    const cleanupB = await chatRealtime.watchConversationRealtime('tenant-1', CONVERSATION_KEY, {
      onMessage: (payload) => eventsB.push(payload),
    });
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });
    assert.strictEqual(harness.onCalls.filter((e) => e.eventName === 'child_added').length, 1); // no re-attach
    assert.strictEqual(harness.offCalls.length, 0); // no detach
    assert.strictEqual(chatRealtime.__hasPendingRelease('tenant-1', CONVERSATION_KEY), false); // release cancelled

    // Delivery works on the reused watch (m1 already known, so m2 is new).
    harness.emitChildAdded('m2', makeMessage('world'));
    assert.strictEqual(eventsB.length, 1);
    assert.strictEqual(eventsB[0].id, 'm2');

    // The originally scheduled release must not fire after cancellation.
    mock.timers.tick(GRACE_MS * 5);
    assert.strictEqual(harness.offCalls.length, 0);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });

    cleanupB();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('recovers when .on() throws "listen() called twice" on re-attach after the grace window and still delivers', async () => {
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const cleanupA = await chatRealtime.watchConversationRealtime('tenant-2', CONVERSATION_KEY, {
      onMessage: () => {},
    });
    cleanupA();

    // Let the grace window elapse so the watch is fully torn down (`.off()` ran).
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    // Simulate the SDK not having released the prior child_added listen yet: the
    // next .on('child_added') throws the internal assert exactly once. The
    // hardened watcher must catch it, .off(), and re-attach once — no throw.
    harness.scheduleListenTwiceThrow('child_added');

    const eventsB = [];
    const cleanupB = await chatRealtime.watchConversationRealtime('tenant-2', CONVERSATION_KEY, {
      onMessage: (payload) => eventsB.push(payload),
    });
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });

    // Despite the transient assertion, a live listener is attached and delivers.
    harness.emitChildAdded('m3', makeMessage('after recovery'));
    assert.strictEqual(eventsB.length, 1);
    assert.strictEqual(eventsB[0].id, 'm3');

    cleanupB();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('cleanup is idempotent: calling the returned unsubscribe twice detaches at most once after the window', async () => {
    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const cleanup = await chatRealtime.watchConversationRealtime('tenant-3', CONVERSATION_KEY, {
      onMessage: () => {},
    });

    cleanup();
    cleanup(); // second call must not schedule a second release

    // Still inside the grace window: nothing detached yet, one release pending.
    assert.strictEqual(harness.offCalls.length, 0);
    assert.strictEqual(chatRealtime.__hasPendingRelease('tenant-3', CONVERSATION_KEY), true);
    assert.strictEqual(chatRealtime.__getPendingReleaseCount(), 1);

    // Elapse the window: exactly one .off() per event across everything.
    mock.timers.tick(GRACE_MS);
    assert.strictEqual(harness.offCalls.filter((e) => e.eventName === 'child_added').length, 1);
    assert.strictEqual(harness.offCalls.filter((e) => e.eventName === 'child_changed').length, 1);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    // A third late cleanup call and further ticks are harmless no-ops.
    cleanup();
    mock.timers.tick(GRACE_MS * 3);
    assert.strictEqual(harness.offCalls.filter((e) => e.eventName === 'child_added').length, 1);
    assert.strictEqual(harness.offCalls.filter((e) => e.eventName === 'child_changed').length, 1);
  });
});
