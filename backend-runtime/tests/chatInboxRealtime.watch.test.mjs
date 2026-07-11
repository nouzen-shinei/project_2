// Feature: chat-production-hardening (messageIndex read lockdown).
//
// The client used to read the RTDB `tenantChat/{tenantId}/messageIndex` node
// directly (a `orderByChild('recipientId').equalTo(me)` query) to drive the
// global "a new inbound message arrived for me" signal that powers in-app chat
// notifications. That client read is what forced `messageIndex .read` open.
//
// `watchUserInboxRealtime` replaces it: the backend (Admin SDK, which bypasses
// RTDB rules) watches the CALLER'S OWN inbound index records and streams a
// compact inbound event per newly-arrived message, so `messageIndex .read` can
// be locked to `false`.
//
// THIS TEST proves the watcher:
//   1. queries `messageIndex` scoped to the caller (`orderByChild('recipientId')`
//      + `equalTo(recipient)`) — i.e. only the caller's inbound is watched,
//   2. suppresses the initial burst (records that already exist when the watch
//      starts are seeded, not emitted) and emits only genuinely NEW inbound,
//   3. scopes watches per (tenant, recipient) so tenants/users never share a
//      watch,
//   4. keeps the shared listener alive for a grace window and tears it down
//      exactly once (idempotent), driven with Node fake timers.
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

const GRACE_MS = 5000;
const RECIPIENT = 'bob@example.com';

function createDataSnapshot(key, value) {
  return { key, val: () => value };
}

/**
 * A messageIndex-query harness. The watcher builds
 *   db.ref('tenantChat').child(tenant).child('messageIndex')
 *     .orderByChild('recipientId').equalTo(recipient)
 * and then calls `.once('value')` + `.on('child_added', cb)`. This harness
 * records the orderByChild/equalTo args (to prove per-recipient scoping) and the
 * on/off calls, and can seed the `once('value')` result.
 */
function createInboxDbHarness() {
  const listeners = { child_added: null };
  const onCalls = [];
  const offCalls = [];
  const orderByChildArgs = [];
  const equalToArgs = [];
  let seed = [];

  const query = {
    orderByChild: (field) => {
      orderByChildArgs.push(field);
      return query;
    },
    equalTo: (value) => {
      equalToArgs.push(value);
      return query;
    },
    once: async (eventName) => {
      assert.strictEqual(eventName, 'value');
      const items = seed;
      return {
        forEach: (cb) => {
          for (const item of items) {
            cb(createDataSnapshot(item.id, item.value));
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

  const messageIndexRef = query;
  const tenantRef = { child: (segment) => (segment === 'messageIndex' ? messageIndexRef : tenantRef) };
  const tenantChatRef = { child: () => tenantRef };
  const db = { ref: () => tenantChatRef };

  return {
    db,
    listeners,
    onCalls,
    offCalls,
    orderByChildArgs,
    equalToArgs,
    countOff: (eventName) => offCalls.filter((e) => e.eventName === eventName).length,
    setSeed: (items) => {
      seed = items;
    },
    emitChildAdded: (id, value) => {
      assert.strictEqual(typeof listeners.child_added, 'function', 'child_added listener must be attached');
      listeners.child_added(createDataSnapshot(id, value));
    },
  };
}

const makeIndexRecord = (sender, overrides = {}) => ({
  sender,
  recipientId: RECIPIENT,
  conversationKey: 'alice_example_com__bob_example_com',
  timestamp: '2026-04-15T00:00:01.000Z',
  delivered: false,
  read: false,
  ...overrides,
});

describe('watchUserInboxRealtime — per-user inbound watch (messageIndex read lockdown)', () => {
  beforeEach(() => {
    chatRealtime.__setSharedWatchReleaseGraceMs(GRACE_MS);
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    chatRealtime.__resetSharedWatchReleaseGraceMs();
    assert.deepStrictEqual(
      chatRealtime.getInboxWatchStats(),
      { activeWatches: 0, totalSubscribers: 0 },
      'each test must leave the inbox watch cache empty'
    );
  });

  it('queries messageIndex scoped to the caller and emits only NEW inbound (initial burst suppressed)', async () => {
    const harness = createInboxDbHarness();
    activeDatabaseFactory = () => harness.db;
    // A record that already exists when the watch starts must NOT be emitted.
    harness.setSeed([{ id: 'existing-1', value: makeIndexRecord('alice@example.com') }]);

    const events = [];
    const cleanup = await chatRealtime.watchUserInboxRealtime('tenant-1', RECIPIENT, {
      onInbound: (payload) => events.push(payload),
    });

    // Scoped to the caller's inbound only.
    assert.deepStrictEqual(harness.orderByChildArgs, ['recipientId']);
    assert.deepStrictEqual(harness.equalToArgs, [RECIPIENT]);
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 1, totalSubscribers: 1 });

    // The pre-existing (seeded) record is known -> re-emitting it is suppressed.
    harness.emitChildAdded('existing-1', makeIndexRecord('alice@example.com'));
    assert.strictEqual(events.length, 0);

    // A genuinely new inbound record is emitted as a compact payload.
    harness.emitChildAdded('m-new', makeIndexRecord('alice@example.com', { isSpecial: true }));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].id, 'm-new');
    assert.strictEqual(events[0].sender, 'alice@example.com');
    assert.strictEqual(events[0].recipientId, RECIPIENT);
    assert.strictEqual(events[0].isSpecial, true);
    assert.strictEqual(events[0].tenantId, 'tenant-1');

    cleanup();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('scopes watches per (tenant, recipient) — different tenants/users never share a watch', async () => {
    const harnessA = createInboxDbHarness();
    const harnessB = createInboxDbHarness();
    const harnessC = createInboxDbHarness();
    // The watcher only builds the ref inside `admin.database()`; every watch here
    // targets a distinct (tenant, recipient) so each must create its own watch.
    let nextHarness = harnessA;
    activeDatabaseFactory = () => nextHarness.db;

    nextHarness = harnessA;
    const cleanupA = await chatRealtime.watchUserInboxRealtime('tenant-1', RECIPIENT, { onInbound: () => {} });
    nextHarness = harnessB;
    const cleanupB = await chatRealtime.watchUserInboxRealtime('tenant-2', RECIPIENT, { onInbound: () => {} });
    nextHarness = harnessC;
    const cleanupC = await chatRealtime.watchUserInboxRealtime('tenant-1', 'carol@example.com', { onInbound: () => {} });

    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 3, totalSubscribers: 3 });

    cleanupA();
    cleanupB();
    cleanupC();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('shares one listener across concurrent subscribers for the same (tenant, recipient)', async () => {
    const harness = createInboxDbHarness();
    activeDatabaseFactory = () => harness.db;

    const eventsA = [];
    const eventsB = [];
    const cleanupA = await chatRealtime.watchUserInboxRealtime('tenant-1', RECIPIENT, {
      onInbound: (p) => eventsA.push(p),
    });
    const cleanupB = await chatRealtime.watchUserInboxRealtime('tenant-1', RECIPIENT, {
      onInbound: (p) => eventsB.push(p),
    });

    // One shared listen for both subscribers.
    assert.strictEqual(harness.onCalls.filter((e) => e.eventName === 'child_added').length, 1);
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 1, totalSubscribers: 2 });

    harness.emitChildAdded('m1', makeIndexRecord('alice@example.com'));
    assert.strictEqual(eventsA.length, 1);
    assert.strictEqual(eventsB.length, 1);

    // Dropping one subscriber keeps the watch alive with no teardown.
    cleanupA();
    assert.strictEqual(harness.offCalls.length, 0);
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 1, totalSubscribers: 1 });

    // Last unsubscribe schedules a grace-window release, then tears down once.
    cleanupB();
    assert.strictEqual(chatRealtime.__hasPendingInboxRelease('tenant-1', RECIPIENT), true);
    assert.strictEqual(harness.offCalls.length, 0);

    mock.timers.tick(GRACE_MS);
    assert.strictEqual(harness.countOff('child_added'), 1);
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 0, totalSubscribers: 0 });

    // Idempotent: further ticks / late cleanup calls never detach again.
    cleanupB();
    mock.timers.tick(GRACE_MS * 3);
    assert.strictEqual(harness.countOff('child_added'), 1);
  });

  it('normalizes recipient email when scoping the watch', async () => {
    const harness = createInboxDbHarness();
    activeDatabaseFactory = () => harness.db;

    const cleanup = await chatRealtime.watchUserInboxRealtime('tenant-1', '  Bob@Example.COM ', {
      onInbound: () => {},
    });

    assert.deepStrictEqual(harness.equalToArgs, [RECIPIENT]);
    // A pending-release lookup with the same email (any case) resolves the watch.
    assert.strictEqual(chatRealtime.__hasPendingInboxRelease('tenant-1', 'BOB@example.com'), false);

    cleanup();
    mock.timers.tick(GRACE_MS);
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });

  it('rejects missing tenant / recipient', async () => {
    activeDatabaseFactory = () => createInboxDbHarness().db;
    await assert.rejects(
      () => chatRealtime.watchUserInboxRealtime('', RECIPIENT, { onInbound: () => {} }),
      /Missing tenantId/
    );
    await assert.rejects(
      () => chatRealtime.watchUserInboxRealtime('tenant-1', '', { onInbound: () => {} }),
      /Missing recipient/
    );
    assert.deepStrictEqual(chatRealtime.getInboxWatchStats(), { activeWatches: 0, totalSubscribers: 0 });
  });
});
