// Feature: stuck-message-delivery-fix
// Property 7 (Preservation) — Offline queue and auto-send.
//
// **Validates: Requirements 3.2**
//
// PRESERVATION TEST (exploratory bugfix workflow, observation-first):
//   This property-based test is written BEFORE the fix and is EXPECTED TO PASS on
//   the current UNFIXED code. It captures the BASELINE offline-queue + auto-send
//   behavior that the upcoming delivery / self-address fix (tasks 10.x) must
//   preserve (re-checked at task 13.2). Following the observation-first
//   methodology, the assertions below encode what the UNFIXED code is observed to
//   do when a message is sent while offline and connectivity is later restored.
//
// OBSERVED BASELINE (recorded by running the UNFIXED code, then asserted here):
//   Mirroring `app/(tabs)/chat.tsx`:
//     1. A text send issued while `isOffline` does NOT hit the network — it is
//        enqueued as a `PendingMessage` with `status: 'queued'` and persisted via
//        `PendingMessageStorage.addPendingMessage` (the durable outbox).
//     2. While offline, the auto-retry effect never fires:
//        `resolveChatPendingAutoRetryPlan({ isOffline: true, ... })` returns
//        `{ shouldSchedule: false }`, so nothing is dispatched — the message just
//        waits in the queue.
//     3. On reconnect (`isOffline` flips false with queued items present), the REAL
//        classifier `resolveChatPendingConversationDerivedState` surfaces the item
//        in `queuedTextIds` / `queuedAllCount`, and `resolveChatPendingAutoRetryPlan`
//        returns `{ shouldSchedule: true }`, so the queued send is auto-dispatched.
//     4. Each queued message is dispatched EXACTLY ONCE: the per-item retry guard
//        (skip when status is already 'sending'/'sent') plus the queued
//        classification (only `status === 'queued'` is queued) mean that once a
//        message advances to 'sent' it leaves `queuedTextIds`, so subsequent
//        reconnect ticks never re-dispatch it — no duplicate is created, and the
//        outbox item keeps its stable identity (`tempId`).
//
// WHAT IS EXERCISED FOR REAL:
//   The production functions that own the offline-queue + auto-send decisions run
//   unmodified as the system under test:
//     - `resolveChatPendingConversationDerivedState` (lib/chatPendingConversationDerived.ts)
//       classifies which pending items are auto-send-eligible on reconnect
//       (`queuedTextIds`, `queuedAllCount` — the strict "queued because offline"
//       subset, not "failed").
//     - `resolveChatPendingAutoRetryPlan` (lib/chatPendingAutoRetryState.ts) is the
//       real gate that decides whether reconnect schedules the auto-send.
//     - `PendingMessageStorage` (lib/pendingMessageStorage.ts) is the real durable
//       outbox: the queued message is persisted, updated in place on send, and
//       keeps a single stable entry (no duplicate row).
//     - `resolveChatPendingStatusDisplayState` (lib/chatPendingRenderState.ts) is the
//       real status renderer: a queued item shows "Queued", is not retriable while
//       offline, and becomes manually retriable once online.
//   A minimal driver replays random offline-then-reconnect connectivity sequences
//   and, on each tick, defers the "should we auto-send now?" and "which items?"
//   decisions to those real functions, applying only the state transition the
//   current code actually performs (mirroring `retryPendingMessage`).
//
// THE INCIDENT (tenant CGnHGq43PFF8WD2DJekx):
//   Offline queue + auto-send is healthy, non-buggy behavior that the outage /
//   self-address fix must not regress. The anchor below mirrors the real
//   krvikrantsingh51 -> invipika conversation queuing a message while offline and
//   auto-sending it on reconnect.

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// In-memory AsyncStorage mock so the REAL PendingMessageStorage round-trips
// through a functional key/value store. Only get/set/remove are used by the
// PendingMessageStorage API under test.
// ---------------------------------------------------------------------------
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(async () => {
        store.clear();
      }),
      __getStore: () => store,
      __reset: () => store.clear(),
    },
  };
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    metric: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks are registered.
// ---------------------------------------------------------------------------
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PendingMessageStorage,
  type PendingMessage,
} from '../../lib/pendingMessageStorage';
import { resolveChatPendingConversationDerivedState } from '../../lib/chatPendingConversationDerived';
import { resolveChatPendingAutoRetryPlan } from '../../lib/chatPendingAutoRetryState';
import { resolveChatPendingStatusDisplayState } from '../../lib/chatPendingRenderState';

const resetStorage = (): void => (AsyncStorage as any).__reset?.();

const resolveStatus = (m: PendingMessage): unknown => m.status;

// ---------------------------------------------------------------------------
// Driver — replays a connectivity sequence and defers every auto-send decision
// to the REAL production classifiers, applying only the transition the current
// code performs (mirroring the reconnect auto-retry effect + retryPendingMessage).
// ---------------------------------------------------------------------------
interface OfflineQueueOutcome {
  // Number of times each pending item was actually dispatched to the network.
  dispatchCountByTempId: Map<string, number>;
  // Total sends dispatched across the whole connectivity sequence.
  totalDispatches: number;
  // Was a send EVER dispatched while the device was offline? (must stay false)
  dispatchedWhileOffline: boolean;
  // Final in-memory pending map after the sequence.
  finalPending: Map<string, PendingMessage>;
  // Distinct server message ids assigned (idempotent identity per tempId).
  serverIdByTempId: Map<string, string>;
}

/**
 * Enqueue `messages` while offline (as chat.tsx does), then replay the
 * `connectivity` sequence (each entry = isOffline for that tick). On every tick
 * the REAL classifier + auto-retry gate decide whether/what to auto-send; the
 * driver performs the single state transition the current code performs.
 */
async function runOfflineQueueThenReconnect(params: {
  selectedRecipientId: string;
  sender: string;
  messages: { tempId: string; text: string }[];
  connectivity: boolean[]; // isOffline per tick; at least one `false` guaranteed by caller
}): Promise<OfflineQueueOutcome> {
  const pending = new Map<string, PendingMessage>();

  // --- Offline enqueue phase (mirrors chat.tsx offline branch) ---------------
  for (const { tempId, text } of params.messages) {
    const queued: PendingMessage = {
      id: tempId,
      text,
      timestamp: new Date().toISOString(),
      recipientId: params.selectedRecipientId,
      sender: params.sender,
      status: 'queued',
    };
    pending.set(tempId, queued);
    // Persist to the REAL durable outbox.
    await PendingMessageStorage.addPendingMessage(tempId, queued);
  }

  const dispatchCountByTempId = new Map<string, number>();
  const serverIdByTempId = new Map<string, string>();
  let totalDispatches = 0;
  let dispatchedWhileOffline = false;

  // --- Connectivity replay ---------------------------------------------------
  for (const isOffline of params.connectivity) {
    // (1) REAL classification of what is auto-send-eligible right now.
    const derived = resolveChatPendingConversationDerivedState({
      selectedRecipientId: params.selectedRecipientId,
      pendingMessages: pending,
      pendingMedia: new Map(),
      pendingAttachments: new Map(),
      resolvePendingMessageStatus: resolveStatus,
    });

    // (2) REAL gate: does reconnect schedule an auto-send this tick?
    const plan = resolveChatPendingAutoRetryPlan({
      isOffline,
      pendingMessageCount: derived.queuedAllCount,
      defaultDelayMs: 1000,
    });

    if (!plan.shouldSchedule) {
      // While offline (or with nothing queued) nothing is dispatched.
      continue;
    }

    // (3) Auto-send the queued items — mirrors retryAllQueuedPendingSends ->
    //     retryPendingMessage for each queued id.
    for (const tempId of derived.queuedTextIds) {
      const current = pending.get(tempId);
      if (!current) {
        continue;
      }

      // retryPendingMessage guards: never send while offline; never re-send an
      // item already 'sending'/'sent' (idempotency guard preventing duplicates).
      if (isOffline) {
        dispatchedWhileOffline = true;
        continue;
      }
      const currentStatus = resolveStatus(current);
      if (currentStatus === 'sending' || currentStatus === 'sent') {
        continue;
      }

      // Dispatch exactly one send for this item. The server id is idempotent per
      // tempId (a retried send reuses the same identity), so no duplicate record.
      totalDispatches += 1;
      dispatchCountByTempId.set(tempId, (dispatchCountByTempId.get(tempId) ?? 0) + 1);

      let serverMessageId = serverIdByTempId.get(tempId);
      if (!serverMessageId) {
        serverMessageId = `-Server_${tempId}`;
        serverIdByTempId.set(tempId, serverMessageId);
      }

      const sent: PendingMessage = { ...current, status: 'sent', serverMessageId };
      pending.set(tempId, sent);
      // Persist the sent state in place (same tempId key — no duplicate row).
      await PendingMessageStorage.addPendingMessage(tempId, sent);
    }
  }

  return {
    dispatchCountByTempId,
    totalDispatches,
    dispatchedWhileOffline,
    finalPending: pending,
    serverIdByTempId,
  };
}

// A connectivity sequence that always ends online so a reconnect definitely
// happens; interior ticks are random offline/online toggles.
const connectivityArb = fc
  .array(fc.boolean(), { minLength: 1, maxLength: 8 })
  .map((ticks) => [...ticks, false]); // guarantee a final reconnect (online)

const realisticEmailArb: fc.Arbitrary<string> = fc
  .tuple(
    fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), {
        minLength: 1,
        maxLength: 16,
      })
      .map((chars) => chars.join(''))
      .filter((local) => /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(local)),
    fc.constantFrom('gmail.com', 'example.com', 'outlook.com', 'company.co', 'mail.org')
  )
  .map(([local, domain]) => `${local}@${domain}`);

// ---------------------------------------------------------------------------
// Property 7 — Preservation
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 7 (Preservation): offline queue and auto-send', () => {
  beforeEach(() => {
    resetStorage();
    jest.clearAllMocks();
  });

  it('render baseline: a queued item shows "Queued", is not retriable while offline, and becomes retriable online', () => {
    const offline = resolveChatPendingStatusDisplayState({ status: 'queued', isOffline: true });
    expect(offline.effectiveStatus).toBe('queued');
    expect(offline.statusLabel).toBe('Queued');
    // While offline the queued item waits — it is not manually retriable.
    expect(offline.canRetry).toBe(false);

    const online = resolveChatPendingStatusDisplayState({ status: 'queued', isOffline: false });
    expect(online.effectiveStatus).toBe('queued');
    // Once online, the queued item becomes retriable (and auto-retry fires).
    expect(online.canRetry).toBe(true);
  });

  // Anchored to a genuine (non-self) conversation from the export.
  it('ANCHOR (baseline): a message sent while offline is queued, then auto-sent exactly once on reconnect with no duplicate', async () => {
    const sender = 'krvikrantsingh51@gmail.com';
    const recipientId = 'invipika@gmail.com';
    const tempId = 'pending_anchor_1';

    // Enqueue while offline; assert it is queued and NOT scheduled for send yet.
    const outcome = await runOfflineQueueThenReconnect({
      selectedRecipientId: recipientId,
      sender,
      messages: [{ tempId, text: 'are we still on for today?' }],
      // Offline for two ticks (message waits), then reconnect.
      connectivity: [true, true, false],
    });

    // Never dispatched while offline (it just waited in the queue).
    expect(outcome.dispatchedWhileOffline).toBe(false);

    // Auto-sent exactly once on reconnect — no duplicate.
    expect(outcome.totalDispatches).toBe(1);
    expect(outcome.dispatchCountByTempId.get(tempId)).toBe(1);

    // Final in-memory state: single stable entry, now 'sent' with a server id.
    expect(outcome.finalPending.size).toBe(1);
    const finalMsg = outcome.finalPending.get(tempId)!;
    expect(finalMsg.status).toBe('sent');
    expect(typeof finalMsg.serverMessageId).toBe('string');
    expect(finalMsg.recipientId).toBe(recipientId);
    expect(finalMsg.text).toBe('are we still on for today?');

    // Durable outbox holds exactly one record for this tempId (no duplicate row).
    const stored = await PendingMessageStorage.loadPendingMessages();
    expect(stored.size).toBe(1);
    expect(stored.get(tempId)?.status).toBe('sent');
  });

  it('while offline, the auto-retry plan never schedules a send for queued items', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (queuedCount) => {
        const plan = resolveChatPendingAutoRetryPlan({
          isOffline: true,
          pendingMessageCount: queuedCount,
          defaultDelayMs: 1000,
        });
        // Offline => never auto-send, regardless of how many items are queued.
        expect(plan.shouldSchedule).toBe(false);
      }),
      { numRuns: 40 }
    );
  });

  it('for any offline-then-reconnect sequence, each queued message is auto-sent exactly once (no duplicate) and never while offline', async () => {
    await fc.assert(
      fc.asyncProperty(
        realisticEmailArb,
        realisticEmailArb,
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.string({ minLength: 1, maxLength: 24 }), { minLength: 1, maxLength: 4 }),
        connectivityArb,
        async (sender, recipientId, messageCount, texts, connectivity) => {
          // A genuine one-to-one conversation (recipient distinct from sender).
          fc.pre(sender !== recipientId);

          const messages = Array.from({ length: messageCount }, (_, i) => ({
            tempId: `pending_${i}`,
            text: texts[i % texts.length],
          }));

          resetStorage();

          const outcome = await runOfflineQueueThenReconnect({
            selectedRecipientId: recipientId,
            sender,
            messages,
            connectivity,
          });

          // (1) No send is EVER dispatched while offline — messages just wait.
          expect(outcome.dispatchedWhileOffline).toBe(false);

          // (2) On reconnect, every queued message is auto-sent EXACTLY ONCE.
          expect(outcome.totalDispatches).toBe(messageCount);
          for (const { tempId } of messages) {
            expect(outcome.dispatchCountByTempId.get(tempId)).toBe(1);
          }

          // (3) No duplicate: one stable outbox entry per message, each finalized
          //     to 'sent' with a single idempotent server id.
          expect(outcome.finalPending.size).toBe(messageCount);
          expect(outcome.serverIdByTempId.size).toBe(messageCount);
          for (const { tempId, text } of messages) {
            const finalMsg = outcome.finalPending.get(tempId)!;
            expect(finalMsg.status).toBe('sent');
            expect(finalMsg.recipientId).toBe(recipientId);
            expect(finalMsg.text).toBe(text);
          }

          // (4) The durable outbox mirrors that: exactly `messageCount` rows, all sent.
          const stored = await PendingMessageStorage.loadPendingMessages();
          expect(stored.size).toBe(messageCount);
          for (const { tempId } of messages) {
            expect(stored.get(tempId)?.status).toBe('sent');
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
