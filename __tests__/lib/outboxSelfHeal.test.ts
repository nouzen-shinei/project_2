// Feature: chat-production-hardening — Task 5 (finding P1-1)
// App-level outbox self-heal driver: re-drive not-yet-confirmed / offline-queued
// sends across ALL conversations (not just the open chat screen's), while never
// competing with the mounted chat screen's own driver for the same items.
//
// These tests exercise the REAL dependency-injected driver
// (`driveOutboxSelfHealOnce`) and the shared pure scheduling helpers in
// `lib/outboxSelfHeal.ts`. Only the storage/transport boundary is faked (an
// in-memory store + recording `sendMessage` / `messageExistsById`); the
// eligibility classification reuses the production
// `resolveChatPendingConversationDerivedState` and the dead-letter decision
// reuses `resolveExhaustedOutboxAction`.

import * as fc from 'fast-check';

import {
  driveOutboxSelfHealOnce,
  createOutboxSelfHealState,
  resolveOutboxBackoffMs,
  resolveOutboxSchedule,
  resolveOutboxTimestampMs,
  resolveNextRedriveState,
  claimOutboxConversation,
  isOutboxRecipientClaimed,
  __resetOutboxClaimsForTests,
  OUTBOX_MAX_REDRIVE_ATTEMPTS,
  OUTBOX_MIN_STALE_MS,
  OUTBOX_BASE_BACKOFF_MS,
  OUTBOX_MAX_BACKOFF_MS,
  type OutboxPendingMessageLike,
  type OutboxSelfHealDeps,
} from '../../lib/outboxSelfHeal';

// ---------------------------------------------------------------------------
// Test harness — in-memory PendingMessageStorage + recording backend
// ---------------------------------------------------------------------------
interface HarnessOptions {
  sendImpl?: (msg: { recipientId: string; clientMsgId?: string }) => Promise<string>;
  existsImpl?: (sender: string, recipient: string, id: string) => Promise<boolean>;
  claimed?: Set<string>;
  useRealClaims?: boolean;
  baseNow?: number;
}

function makeHarness(
  initial: [string, OutboxPendingMessageLike][],
  opts: HarnessOptions = {}
) {
  const store = new Map<string, OutboxPendingMessageLike>(
    initial.map(([k, v]) => [k, { ...v }])
  );
  let nowMs = opts.baseNow ?? 1_000_000;

  const sends: { recipientId: string; sender: string; clientMsgId?: string; text: string }[] = [];
  const removed: string[] = [];
  const saved: { id: string; message: OutboxPendingMessageLike }[] = [];

  const deps: OutboxSelfHealDeps = {
    loadPendingMessages: async () =>
      new Map(Array.from(store.entries()).map(([k, v]) => [k, { ...v }])),
    savePendingMessage: async (id, message) => {
      store.set(id, { ...message });
      saved.push({ id, message: { ...message } });
    },
    removePendingMessages: async (ids) => {
      ids.forEach((id) => store.delete(id));
      removed.push(...ids);
    },
    sendMessage: async (msg) => {
      sends.push({
        recipientId: msg.recipientId,
        sender: msg.sender,
        clientMsgId: msg.clientMsgId,
        text: msg.text,
      });
      if (opts.sendImpl) {
        return opts.sendImpl(msg);
      }
      return `-srv_${msg.clientMsgId}`;
    },
    messageExistsById: opts.existsImpl ?? (async () => false),
    now: () => nowMs,
    normalizeMessageId: (v) => (v === null || v === undefined ? '' : String(v)),
    isRecipientClaimed: opts.claimed
      ? (r: string) => opts.claimed!.has(r)
      : opts.useRealClaims
        ? undefined
        : () => false,
  };

  const state = createOutboxSelfHealState();

  return {
    deps,
    state,
    store,
    sends,
    removed,
    saved,
    advance: (ms: number) => {
      nowMs += ms;
    },
    getNow: () => nowMs,
    run: () => driveOutboxSelfHealOnce(deps, state),
  };
}

function item(overrides: Partial<OutboxPendingMessageLike>): OutboxPendingMessageLike {
  return {
    text: 'hello',
    sender: 'me@example.com',
    recipientId: 'b@example.com',
    status: 'sending',
    timestamp: 0, // epoch → always past the stale-grace window
    clientMsgId: 'client-1',
    ...overrides,
  };
}

const PAST_BACKOFF = OUTBOX_BASE_BACKOFF_MS + 1;

beforeEach(() => {
  __resetOutboxClaimsForTests();
});

// ---------------------------------------------------------------------------
// Pure scheduling helpers
// ---------------------------------------------------------------------------
describe('outboxSelfHeal — pure scheduling helpers', () => {
  it('resolveOutboxBackoffMs is monotonic non-decreasing and bounded by the cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 40 }), (n) => {
        const a = resolveOutboxBackoffMs(n);
        const b = resolveOutboxBackoffMs(n + 1);
        expect(a).toBeLessThanOrEqual(b);
        expect(b).toBeLessThanOrEqual(OUTBOX_MAX_BACKOFF_MS);
        expect(a).toBeGreaterThanOrEqual(OUTBOX_BASE_BACKOFF_MS);
      }),
      { numRuns: 60 }
    );
  });

  it('resolveOutboxTimestampMs handles number / Date / ISO-string / invalid', () => {
    expect(resolveOutboxTimestampMs(1234)).toBe(1234);
    const d = new Date('2020-01-02T03:04:05.000Z');
    expect(resolveOutboxTimestampMs(d)).toBe(d.getTime());
    expect(resolveOutboxTimestampMs('2020-01-02T03:04:05.000Z')).toBe(d.getTime());
    expect(resolveOutboxTimestampMs('not-a-date')).toBe(0);
    expect(resolveOutboxTimestampMs(undefined)).toBe(0);
    expect(resolveOutboxTimestampMs(null)).toBe(0);
  });

  it('resolveOutboxSchedule: waits during grace, arms once, then re-drives after backoff', () => {
    const now = 1_000_000;
    // Fresh item (within grace) → wait.
    expect(resolveOutboxSchedule({ now, timestampMs: now, retryCount: 0 }).action).toBe('wait');
    // Stale, first sighting → arm with an initial backoff window.
    const armed = resolveOutboxSchedule({ now, timestampMs: 0, retryCount: 0 });
    expect(armed.action).toBe('arm');
    expect(armed.state?.nextAt).toBe(now + OUTBOX_BASE_BACKOFF_MS);
    // Armed but window not elapsed → wait.
    expect(
      resolveOutboxSchedule({ now, timestampMs: 0, retryCount: 0, existing: armed.state }).action
    ).toBe('wait');
    // Window elapsed → redrive.
    expect(
      resolveOutboxSchedule({
        now: now + OUTBOX_BASE_BACKOFF_MS,
        timestampMs: 0,
        retryCount: 0,
        existing: armed.state,
      }).action
    ).toBe('redrive');
  });

  it('resolveNextRedriveState advances attempts from the larger of bookkeeping/persisted count', () => {
    expect(resolveNextRedriveState(undefined, 0, 0).attempts).toBe(1);
    expect(resolveNextRedriveState({ attempts: 3, nextAt: 0 }, 0, 0).attempts).toBe(4);
    expect(resolveNextRedriveState(undefined, 2, 0).attempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Conversation claim registry (cross-driver coordination)
// ---------------------------------------------------------------------------
describe('outboxSelfHeal — conversation claim registry', () => {
  it('claims and releases (reference counted, idempotent release)', () => {
    expect(isOutboxRecipientClaimed('a@x.com')).toBe(false);
    const release1 = claimOutboxConversation('a@x.com');
    const release2 = claimOutboxConversation('a@x.com');
    expect(isOutboxRecipientClaimed('a@x.com')).toBe(true);
    release1();
    // Still claimed: a second claimant remains.
    expect(isOutboxRecipientClaimed('a@x.com')).toBe(true);
    release2();
    expect(isOutboxRecipientClaimed('a@x.com')).toBe(false);
    // Idempotent: releasing again does not underflow.
    release2();
    expect(isOutboxRecipientClaimed('a@x.com')).toBe(false);
  });

  it('ignores empty/invalid recipient ids', () => {
    const release = claimOutboxConversation('');
    expect(isOutboxRecipientClaimed('')).toBe(false);
    release();
  });
});

// ---------------------------------------------------------------------------
// Cross-conversation flush — the core P1-1 fix
// ---------------------------------------------------------------------------
describe('outboxSelfHeal — cross-conversation flush (finding P1-1)', () => {
  it('re-drives un-confirmed sends in MULTIPLE conversations, not just one', async () => {
    const h = makeHarness([
      ['t1', item({ recipientId: 'b@example.com', status: 'sending', clientMsgId: 'cb' })],
      [
        't2',
        item({
          recipientId: 'c@example.com',
          status: 'sent',
          clientMsgId: 'cc',
          serverMessageId: '-selfC',
        }),
      ],
    ]);

    // Tick 1: both stale items are armed (no premature send). t2 has a stale
    // serverMessageId; the authoritative check reports it is NOT durable for the
    // intended recipient, so it is armed rather than finalized.
    await h.run();
    expect(h.sends).toHaveLength(0);
    expect(h.state.bookkeeping.size).toBe(2);

    // Tick 2 (after the backoff window): both conversations self-heal.
    h.advance(PAST_BACKOFF);
    const res = await h.run();

    expect(h.sends.map((s) => s.recipientId).sort()).toEqual(['b@example.com', 'c@example.com']);
    // Idempotency: each re-drive reuses the item's clientMsgId.
    expect(h.sends.map((s) => s.clientMsgId).sort()).toEqual(['cb', 'cc']);
    // Confirmed + removed from the outbox (durably delivered).
    expect(h.store.has('t1')).toBe(false);
    expect(h.store.has('t2')).toBe(false);
    expect(res.confirmed.sort()).toEqual(['t1', 't2']);
  });

  it('also flushes offline-queued sends (queued-retry-on-reconnect equivalent)', async () => {
    const h = makeHarness([
      ['t1', item({ recipientId: 'b@example.com', status: 'queued', clientMsgId: 'cb', serverMessageId: undefined })],
    ]);
    await h.run(); // arm (no serverMessageId → no early exists check)
    expect(h.sends).toHaveLength(0);
    h.advance(PAST_BACKOFF);
    await h.run(); // redrive → send
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].recipientId).toBe('b@example.com');
    expect(h.sends[0].clientMsgId).toBe('cb');
    expect(h.store.has('t1')).toBe(false);
  });

  it('falls back to the tempId as the idempotency key when clientMsgId is absent', async () => {
    const h = makeHarness([
      ['temp-xyz', item({ recipientId: 'b@example.com', status: 'sending', clientMsgId: undefined })],
    ]);
    await h.run();
    h.advance(PAST_BACKOFF);
    await h.run();
    expect(h.sends[0].clientMsgId).toBe('temp-xyz');
  });
});

// ---------------------------------------------------------------------------
// No-duplicate-drive — the mounted chat screen owns its open conversation
// ---------------------------------------------------------------------------
describe('outboxSelfHeal — no duplicate drive for claimed conversations', () => {
  it('never re-drives items whose recipient is claimed by the chat screen', async () => {
    const claimed = new Set(['a@example.com']);
    const h = makeHarness(
      [
        ['t1', item({ recipientId: 'a@example.com', status: 'sending', clientMsgId: 'ca' })],
        ['t2', item({ recipientId: 'b@example.com', status: 'sending', clientMsgId: 'cb' })],
      ],
      { claimed }
    );

    await h.run();
    h.advance(PAST_BACKOFF);
    const res = await h.run();

    // Only the UNCLAIMED conversation was driven.
    expect(h.sends.map((s) => s.recipientId)).toEqual(['b@example.com']);
    // The claimed conversation's item is untouched (owned by the chat screen).
    expect(h.store.has('t1')).toBe(true);
    expect(h.store.get('t1')?.status).toBe('sending');
    expect(res.skippedClaimed).toContain('t1');
    // The unclaimed conversation healed.
    expect(h.store.has('t2')).toBe(false);
  });

  it('honours the real claim registry (chat screen claim → skipped here)', async () => {
    const release = claimOutboxConversation('a@example.com');
    const h = makeHarness(
      [['t1', item({ recipientId: 'a@example.com', status: 'sending', clientMsgId: 'ca' })]],
      { useRealClaims: true }
    );

    await h.run();
    h.advance(PAST_BACKOFF);
    await h.run();
    expect(h.sends).toHaveLength(0);
    expect(h.store.has('t1')).toBe(true);

    // Once the chat screen releases the claim, the app-level driver takes over.
    release();
    h.advance(PAST_BACKOFF);
    await h.run();
    // First unclaimed sighting arms; advance + run to actually re-drive.
    h.advance(PAST_BACKOFF);
    await h.run();
    expect(h.sends.map((s) => s.recipientId)).toEqual(['a@example.com']);
    expect(h.store.has('t1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bounded backoff, dead-lettering, and authoritative confirmation
// ---------------------------------------------------------------------------
describe('outboxSelfHeal — dead-letter and authoritative confirmation', () => {
  it('dead-letters to `failed` once the bounded attempt cap is exhausted without confirmation', async () => {
    const h = makeHarness(
      [
        [
          't1',
          item({
            recipientId: 'b@example.com',
            status: 'sending',
            serverMessageId: '-self',
            retryCount: OUTBOX_MAX_REDRIVE_ATTEMPTS, // one more attempt exhausts the budget
          }),
        ],
      ],
      { sendImpl: async () => { throw new Error('backend down'); }, existsImpl: async () => false }
    );

    await h.run(); // arm (attempts primed to the cap; exists check → false)
    h.advance(PAST_BACKOFF);
    const res = await h.run(); // exhausted → authoritative check false → dead-letter

    expect(res.deadLettered).toContain('t1');
    expect(h.store.get('t1')?.status).toBe('failed');
    // Never a phantom "sent"; and no send was attempted on the exhausted tick.
    expect(h.sends).toHaveLength(0);
  });

  it('confirms (never dead-letters) when the authoritative record check finds the durable message', async () => {
    let calls = 0;
    const h = makeHarness(
      [
        [
          't1',
          item({
            recipientId: 'b@example.com',
            status: 'sending',
            serverMessageId: '-srv-real',
            retryCount: OUTBOX_MAX_REDRIVE_ATTEMPTS,
          }),
        ],
      ],
      {
        sendImpl: async () => { throw new Error('backend down'); },
        // False during arm (call #1), true at exhaustion (call #2).
        existsImpl: async () => {
          calls += 1;
          return calls >= 2;
        },
      }
    );

    await h.run(); // arm; exists #1 → false
    h.advance(PAST_BACKOFF);
    const res = await h.run(); // exhausted; exists #2 → true → confirm

    expect(res.confirmed).toContain('t1');
    expect(res.deadLettered).not.toContain('t1');
    expect(h.store.has('t1')).toBe(false);
  });

  it('finalizes immediately (no re-send) when the message is already durable for the intended recipient', async () => {
    const h = makeHarness(
      [
        [
          't1',
          item({
            recipientId: 'b@example.com',
            status: 'sent',
            serverMessageId: '-srv-existing',
          }),
        ],
      ],
      { existsImpl: async () => true }
    );

    const res = await h.run(); // arm branch → authoritative check true → finalize
    expect(h.sends).toHaveLength(0);
    expect(res.confirmed).toContain('t1');
    expect(h.store.has('t1')).toBe(false);
  });

  it('leaves a failed re-drive eligible for the next tick (does not lose the item)', async () => {
    let attempts = 0;
    const h = makeHarness(
      [['t1', item({ recipientId: 'b@example.com', status: 'sending', clientMsgId: 'cb' })]],
      {
        sendImpl: async () => {
          attempts += 1;
          if (attempts < 2) {
            throw new Error('transient');
          }
          return '-srv_cb';
        },
      }
    );

    await h.run(); // arm
    h.advance(PAST_BACKOFF);
    await h.run(); // redrive #1 → throws → item retained
    expect(h.store.has('t1')).toBe(true);
    expect(h.store.get('t1')?.status).toBe('sending');

    h.advance(resolveOutboxBackoffMs(2) + 1);
    await h.run(); // redrive #2 → success → healed
    expect(h.store.has('t1')).toBe(false);
    expect(attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Grace window
// ---------------------------------------------------------------------------
describe('outboxSelfHeal — stale-grace window', () => {
  it('does not touch a freshly-created send (still within the grace window)', async () => {
    const base = 5_000_000;
    const h = makeHarness(
      [['t1', item({ recipientId: 'b@example.com', status: 'sending', timestamp: base })]],
      { baseNow: base }
    );
    const res = await h.run();
    expect(h.sends).toHaveLength(0);
    expect(h.state.bookkeeping.size).toBe(0);
    expect(res.redriven).toHaveLength(0);
    expect(h.store.has('t1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property: claimed recipients are NEVER sent to, regardless of item mix
// ---------------------------------------------------------------------------
describe('outboxSelfHeal — property: claimed conversations never receive a re-drive', () => {
  it('no send ever targets a claimed recipient', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            recipientId: fc.constantFrom('a', 'b', 'c', 'd'),
            status: fc.constantFrom('sending', 'sent', 'queued', 'failed'),
            seed: fc.string({ minLength: 1, maxLength: 6 }),
          }),
          { maxLength: 8 }
        ),
        fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 4 }),
        async (items, claimedArr) => {
          const claimed = new Set(claimedArr);
          const initial: [string, OutboxPendingMessageLike][] = items.map((it, i) => [
            `t${i}`,
            item({
              recipientId: it.recipientId,
              status: it.status as OutboxPendingMessageLike['status'],
              clientMsgId: `c${i}_${it.seed}`,
              serverMessageId: undefined,
              timestamp: 0,
            }),
          ]);

          const h = makeHarness(initial, { claimed });
          // Drive several ticks, advancing well past the max backoff each time so
          // every eligible unclaimed item gets a chance to arm and re-drive.
          for (let k = 0; k < 8; k += 1) {
            await h.run();
            h.advance(OUTBOX_MAX_BACKOFF_MS + 1);
          }

          expect(h.sends.every((s) => !claimed.has(s.recipientId))).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });
});
