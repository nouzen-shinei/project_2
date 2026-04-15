import assert from 'assert';
import { after, describe, it } from 'node:test';
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

function createDataSnapshot(key, value) {
  return {
    key,
    val: () => value,
  };
}

function createInitialSnapshot(items) {
  return {
    forEach: (callback) => {
      for (const item of items) {
        callback(createDataSnapshot(item.id, item.value));
      }
      return false;
    },
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
  let resolveInitialSnapshot = null;

  const initialSnapshotPromise = new Promise((resolve) => {
    resolveInitialSnapshot = resolve;
  });

  const conversationRef = {
    once: async (eventName) => {
      assert.strictEqual(eventName, 'value');
      onceCalls += 1;
      return initialSnapshotPromise;
    },
    on: (eventName, callback) => {
      onCalls.push({ eventName, callback });
      listeners[eventName] = callback;
    },
    off: (eventName, callback) => {
      offCalls.push({ eventName, callback });
      if (listeners[eventName] === callback) {
        listeners[eventName] = null;
      }
    },
  };

  const conversationMessagesRef = {
    child: (segment) => {
      assert.strictEqual(segment, 'alice_example_com__bob_example_com');
      return conversationRef;
    },
  };

  const tenantRef = {
    child: (segment) => {
      assert.strictEqual(segment, 'conversationMessages');
      return conversationMessagesRef;
    },
  };

  const tenantChatRef = {
    child: (segment) => {
      assert.strictEqual(segment, 'tenant-1');
      return tenantRef;
    },
  };

  const db = {
    ref: (segment) => {
      assert.strictEqual(segment, 'tenantChat');
      return tenantChatRef;
    },
  };

  return {
    db,
    listeners,
    onCalls,
    offCalls,
    getOnceCalls: () => onceCalls,
    resolveInitialSnapshot,
  };
}

describe('chat realtime watcher multiplexing', () => {
  it('shares one Firebase listener set for concurrent subscribers and tears down on final cleanup', async () => {
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    const harness = createRealtimeDbHarness();
    activeDatabaseFactory = () => harness.db;

    const eventsA = [];
    const eventsB = [];

    const watchPromiseA = chatRealtime.watchConversationRealtime('tenant-1', 'alice_example_com__bob_example_com', {
      onMessage: (payload) => eventsA.push(payload),
    });

    const watchPromiseB = chatRealtime.watchConversationRealtime('tenant-1', 'alice_example_com__bob_example_com', {
      onMessage: (payload) => eventsB.push(payload),
    });

    await Promise.resolve();
    assert.strictEqual(harness.getOnceCalls(), 1);

    harness.resolveInitialSnapshot(
      createInitialSnapshot([
        {
          id: 'existing-1',
          value: {
            sender: 'alice@example.com',
            recipientId: 'bob@example.com',
            text: 'seed',
            timestamp: '2026-04-15T00:00:00.000Z',
          },
        },
      ])
    );

    const cleanupA = await watchPromiseA;
    const cleanupB = await watchPromiseB;

    assert.strictEqual(harness.onCalls.filter((entry) => entry.eventName === 'child_added').length, 1);
    assert.strictEqual(harness.onCalls.filter((entry) => entry.eventName === 'child_changed').length, 1);
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 2 });

    assert.strictEqual(typeof harness.listeners.child_added, 'function');
    harness.listeners.child_added(
      createDataSnapshot('new-1', {
        sender: 'alice@example.com',
        recipientId: 'bob@example.com',
        text: 'hello',
        timestamp: '2026-04-15T00:00:01.000Z',
      })
    );

    assert.strictEqual(eventsA.length, 1);
    assert.strictEqual(eventsB.length, 1);
    assert.strictEqual(eventsA[0].id, 'new-1');
    assert.strictEqual(eventsB[0].id, 'new-1');

    cleanupA();
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 1, totalSubscribers: 1 });
    assert.strictEqual(harness.offCalls.length, 0);

    cleanupB();
    assert.deepStrictEqual(chatRealtime.getConversationWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
    assert.strictEqual(harness.offCalls.filter((entry) => entry.eventName === 'child_added').length, 1);
    assert.strictEqual(harness.offCalls.filter((entry) => entry.eventName === 'child_changed').length, 1);
  });
});
