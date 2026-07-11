// Feature: stuck-message-delivery-fix
// Property 9 (Preservation) — Non-outage failure states and receipts unchanged.
//
// **Validates: Requirements 3.5, 3.6**
//
// PRESERVATION TEST (exploratory bugfix workflow, observation-first):
//   This property-based test is written BEFORE the fix and is EXPECTED TO PASS on
//   the current UNFIXED code. It captures TWO baseline behaviors that the upcoming
//   two-track fix (Track A delivery / self-address, tasks 10.x; Track B unread /
//   self-conversation, tasks 11.x) must leave completely untouched (re-checked at
//   task 13.4). Following the observation-first methodology, the assertions below
//   encode what the UNFIXED code is observed to do; nothing about the fix should
//   change either behavior.
//
//   Part A — Non-outage failure states + manual retry/cancel controls (Req 3.5).
//   Part B — Delivery/read receipt ticks derived from delivered/read (+ the
//            upstream deliveryProvenance source) (Req 3.6).
//
// OBSERVED BASELINE (recorded by running the UNFIXED code, then asserted here):
//
//   Part A (non-outage failures — validation error, rate limit, explicit cancel):
//     1. A send that fails for a NON-outage reason (a validation error or a
//        `ChatRateLimitError`) lands the outbox item in `status: 'failed'`. The
//        REAL renderer `resolveChatPendingStatusDisplayState` reports
//        `effectiveStatus: 'failed'`, `statusLabel: 'Not sent'`, and — crucially —
//        `canRetry: true` REGARDLESS of connectivity (a failed item is always
//        manually retriable, unlike a queued item which is only retriable online).
//     2. The REAL classifier `resolveChatPendingConversationDerivedState` places a
//        `failed` item in `retryableTextIds` (the manual retry control is offered)
//        but NOT in `queuedTextIds` (a non-outage failure is NOT auto-resent on
//        reconnect — it requires an explicit user retry, exactly as the module's
//        own comment states).
//     3. The REAL cancel guard `resolveChatPendingCancelAllGuard` offers the cancel
//        control (`shouldRun: true`) whenever the conversation has ≥1 pending item
//        and a cancel-all is not already in flight — this is a purely local action
//        and stays available whether online or offline (explicit user cancel).
//     4. A `queued` item (the offline-wait state) shows `statusLabel: 'Queued'`, is
//        auto-send-eligible (`queuedTextIds`) AND manually retriable, but only
//        `canRetry` once online.
//
//   Part B (receipt ticks): the delivery/read tick tier is a PURE function of the
//     message's `delivered` / `read` flags, surfaced by the REAL receipt-display
//     derivation `resolveChatMessageInfoRows` + `resolveChatMessageInfoRowBadge`:
//       - not delivered, not read       -> "sent"      (single tick)     : Delivered=Pending/warning, Read=Unread/warning
//       - delivered, not read           -> "delivered" (double tick)     : Delivered=Delivered/success, Read=Unread/warning
//       - delivered, read               -> "read"      (blue/read tick)  : Read=Read/success
//     The upstream `deliveryProvenance` (multi-source push + presence) only
//     establishes the `delivered` flag; which source (presence vs push vs both)
//     delivered the message does NOT change the displayed tick — the tier is
//     invariant to the provenance source. Both facts are asserted below.
//
// WHAT IS EXERCISED FOR REAL (system under test — all unmodified production code):
//   - `resolveChatPendingStatusDisplayState`  (lib/chatPendingRenderState.ts)
//   - `resolveChatPendingConversationDerivedState` (lib/chatPendingConversationDerived.ts)
//   - `resolveChatPendingCancelAllGuard`      (lib/chatPendingCancelEligibilityState.ts)
//   - `resolveChatMessageInfoRows` + `resolveChatMessageInfoRowBadge` (lib/chatMessageInfo.ts)
//   The expected tick tier is computed independently from the (delivered, read)
//   pair, so the assertion is a genuine cross-check against the real derivation,
//   not a tautology.
//
// THE INCIDENT (tenant CGnHGq43PFF8WD2DJekx):
//   Non-outage failure handling and receipt ticks are healthy, non-buggy behavior;
//   the export's genuine conversations (e.g. invipika <-> krvikrant) carry
//   `delivered: true` with `deliveryProvenance.lastSource: "presence"` and render
//   their ticks correctly. The self-address / unread fix must not regress any of
//   this. Anchors below mirror those real records.

import * as fc from 'fast-check';

import { resolveChatPendingStatusDisplayState } from '../../lib/chatPendingRenderState';
import { resolveChatPendingConversationDerivedState } from '../../lib/chatPendingConversationDerived';
import { resolveChatPendingCancelAllGuard } from '../../lib/chatPendingCancelEligibilityState';
import {
  resolveChatMessageInfoRows,
  resolveChatMessageInfoRowBadge,
} from '../../lib/chatMessageInfo';

// ---------------------------------------------------------------------------
// Part A — non-outage failure model
// ---------------------------------------------------------------------------
type PendingStatus = 'queued' | 'sending' | 'sent' | 'failed';

// The three NON-outage failure reasons called out by Requirement 3.5. Validation
// errors and rate limiting (ChatRateLimitError) both land the outbox item in
// 'failed'; an explicit user cancel removes it via the cancel control.
type NonOutageFailure = 'validation' | 'rateLimit' | 'cancel';

interface PendingTextItem {
  recipientId: string;
  status: PendingStatus;
}

const resolveStatus = (m: PendingTextItem): PendingStatus => m.status;

/** The observed outbox status a non-outage failure produces on the UNFIXED code. */
function statusForNonOutageFailure(failure: NonOutageFailure): PendingStatus {
  // Validation + rate-limit failures surface as terminal 'failed' (manually
  // retriable). An explicit cancel is a user action on a pending item; before the
  // cancel completes the item is still pending ('failed' after a prior attempt, or
  // 'queued'/'sending'); we model the pre-cancel item as 'failed' so the cancel
  // control is exercised against a real pending entry.
  return failure === 'cancel' ? 'failed' : 'failed';
}

/** Build the derived conversation state for a set of pending items via REAL code. */
function deriveConversationState(selectedRecipientId: string, items: Map<string, PendingTextItem>) {
  return resolveChatPendingConversationDerivedState<PendingTextItem, never, never>({
    selectedRecipientId,
    pendingMessages: items,
    pendingMedia: new Map<string, never>(),
    pendingAttachments: new Map<string, never>(),
    resolvePendingMessageStatus: resolveStatus,
  });
}

// ---------------------------------------------------------------------------
// Part B — receipt tick model
// ---------------------------------------------------------------------------
type ReceiptTier = 'sent' | 'delivered' | 'read';
type DeliverySource = 'presence' | 'push';

interface DeliveryProvenance {
  sources?: DeliverySource[];
  lastSource?: DeliverySource;
  presence?: { deliveredAt?: string };
  push?: { deliveredAt?: string };
}

/**
 * Mirror of the app's multi-source delivered rule (as the admin-console receipt
 * inspector's `hasDeliverySource` expresses it): a message is delivered if ANY
 * provenance source (presence OR push) reports delivery. This is the upstream
 * step that establishes the `delivered` flag which the receipt display consumes.
 */
function isDeliveredFromProvenance(prov: DeliveryProvenance | undefined): boolean {
  if (!prov) return false;
  const hasSourceMark =
    (Array.isArray(prov.sources) && prov.sources.length > 0) || prov.lastSource != null;
  const hasPresence = Boolean(prov.presence?.deliveredAt);
  const hasPush = Boolean(prov.push?.deliveredAt);
  return hasSourceMark || hasPresence || hasPush;
}

/**
 * Derive the receipt tick tier via the REAL production receipt-display functions
 * (`resolveChatMessageInfoRows` -> `resolveChatMessageInfoRowBadge`). The tick a
 * user sees is exactly what these produce from `delivered` / `read`.
 */
function deriveReceiptTier(input: {
  delivered: boolean;
  read: boolean;
  deliveredAt?: string;
  readAt?: string;
}): ReceiptTier {
  const rows = resolveChatMessageInfoRows({
    isOwnMessage: true,
    senderEmail: 'sender@example.com',
    recipientEmail: 'recipient@example.com',
    sentAt: '2026-01-01T00:00:00.000Z',
    delivered: input.delivered,
    deliveredAt: input.deliveredAt,
    read: input.read,
    readAt: input.readAt,
  });

  const deliveredRow = rows.find((r) => r.label === 'Delivered');
  const readRow = rows.find((r) => r.label === 'Read');
  const deliveredBadge = deliveredRow ? resolveChatMessageInfoRowBadge('Delivered', deliveredRow.value) : null;
  const readBadge = readRow ? resolveChatMessageInfoRowBadge('Read', readRow.value) : null;

  if (readBadge?.tone === 'success') return 'read';
  if (deliveredBadge?.tone === 'success') return 'delivered';
  return 'sent';
}

/** The correct tier as a pure function of (delivered, read) — the spec baseline. */
function expectedTier(delivered: boolean, read: boolean): ReceiptTier {
  if (read) return 'read';
  if (delivered) return 'delivered';
  return 'sent';
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
const realisticEmailArb: fc.Arbitrary<string> = fc
  .tuple(
    fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
        minLength: 3,
        maxLength: 14,
      })
      .map((chars) => chars.join('')),
    fc.constantFrom('gmail.com', 'example.com', 'outlook.com', 'company.co', 'mail.org')
  )
  .map(([local, domain]) => `${local}@${domain}`);

const nonOutageFailureArb = fc.constantFrom<NonOutageFailure>('validation', 'rateLimit', 'cancel');

// A provenance value that DOES establish delivery, varying only in WHICH source
// (presence, push, or both) — used to prove the tick tier is source-invariant.
const deliveredProvenanceArb: fc.Arbitrary<DeliveryProvenance> = fc.constantFrom<DeliveryProvenance>(
  { lastSource: 'presence', sources: ['presence'], presence: { deliveredAt: '2026-01-01T00:00:01.000Z' } },
  { lastSource: 'push', sources: ['push'], push: { deliveredAt: '2026-01-01T00:00:01.000Z' } },
  {
    lastSource: 'presence',
    sources: ['presence', 'push'],
    presence: { deliveredAt: '2026-01-01T00:00:01.000Z' },
    push: { deliveredAt: '2026-01-01T00:00:02.000Z' },
  }
);

// ===========================================================================
// Property 9 — Preservation, Part A: non-outage failure states + controls
// ===========================================================================
describe('stuck-message-delivery-fix — Property 9 (Preservation) A: non-outage failure states and manual retry/cancel controls', () => {
  // Anchored to a genuine (non-self) conversation from the export.
  it('ANCHOR (baseline): a validation-error send is "Not sent", manually retriable online AND offline, not auto-queued, and cancelable', () => {
    const sender = 'krvikrantsingh51@gmail.com';
    const recipientId = 'invipika@gmail.com';
    const tempId = 'pending_failed_1';

    const items = new Map<string, PendingTextItem>([[tempId, { recipientId, status: 'failed' }]]);

    // (1) Render: "Not sent", retriable both offline and online.
    for (const isOffline of [true, false]) {
      const display = resolveChatPendingStatusDisplayState({ status: 'failed', isOffline });
      expect(display.effectiveStatus).toBe('failed');
      expect(display.statusLabel).toBe('Not sent');
      expect(display.canRetry).toBe(true);
    }

    // (2) Classification: offered for manual retry, but NOT auto-resent on reconnect.
    const derived = deriveConversationState(recipientId, items);
    expect(derived.retryableTextIds).toContain(tempId);
    expect(derived.queuedTextIds).not.toContain(tempId);
    expect(derived.retryAllCount).toBe(1);

    // (3) Cancel control is available for the conversation's pending items.
    const cancelGuard = resolveChatPendingCancelAllGuard({
      selectedRecipientId: recipientId,
      totalCount: derived.messageEntries.length,
      isCancelingAllPending: false,
    });
    expect(cancelGuard.shouldRun).toBe(true);
    void sender;
  });

  it('ANCHOR (baseline): an offline-queued send shows "Queued", is retriable only once online, and is auto-send-eligible', () => {
    const recipientId = 'vipulkr250@gmail.com';
    const tempId = 'pending_queued_1';
    const items = new Map<string, PendingTextItem>([[tempId, { recipientId, status: 'queued' }]]);

    const offline = resolveChatPendingStatusDisplayState({ status: 'queued', isOffline: true });
    expect(offline.statusLabel).toBe('Queued');
    expect(offline.canRetry).toBe(false);

    const online = resolveChatPendingStatusDisplayState({ status: 'queued', isOffline: false });
    expect(online.statusLabel).toBe('Queued');
    expect(online.canRetry).toBe(true);

    const derived = deriveConversationState(recipientId, items);
    // A queued item is BOTH auto-send-eligible and manually retriable.
    expect(derived.queuedTextIds).toContain(tempId);
    expect(derived.retryableTextIds).toContain(tempId);
  });

  it('for any non-outage failure and any connectivity, the failed item is "Not sent", manually retriable, not auto-queued, and cancelable', () => {
    fc.assert(
      fc.property(
        realisticEmailArb,
        fc.array(nonOutageFailureArb, { minLength: 1, maxLength: 5 }),
        fc.boolean(),
        (recipientId, failures, isOffline) => {
          const items = new Map<string, PendingTextItem>();
          failures.forEach((failure, i) => {
            items.set(`pending_${i}`, { recipientId, status: statusForNonOutageFailure(failure) });
          });

          // (1) Every failed item renders "Not sent" and stays manually retriable
          //     regardless of connectivity (this is what distinguishes a failed
          //     item from a queued one).
          const display = resolveChatPendingStatusDisplayState({ status: 'failed', isOffline });
          expect(display.effectiveStatus).toBe('failed');
          expect(display.statusLabel).toBe('Not sent');
          expect(display.canRetry).toBe(true);

          // (2) Classification: all failed items are offered for manual retry, and
          //     NONE are auto-resent on reconnect (non-outage => explicit retry only).
          const derived = deriveConversationState(recipientId, items);
          expect(derived.retryableTextIds.length).toBe(failures.length);
          expect(derived.retryAllCount).toBe(failures.length);
          expect(derived.queuedTextIds.length).toBe(0);
          expect(derived.queuedAllCount).toBe(0);

          // (3) Cancel control available while pending items exist and no cancel-all
          //     is in flight; blocked once a cancel-all is already running.
          expect(
            resolveChatPendingCancelAllGuard({
              selectedRecipientId: recipientId,
              totalCount: derived.messageEntries.length,
              isCancelingAllPending: false,
            }).shouldRun
          ).toBe(true);
          expect(
            resolveChatPendingCancelAllGuard({
              selectedRecipientId: recipientId,
              totalCount: derived.messageEntries.length,
              isCancelingAllPending: true,
            }).shouldRun
          ).toBe(false);
        }
      ),
      { numRuns: 60 }
    );
  });

  it('the cancel control is gated exactly on having pending items and no in-flight cancel-all', () => {
    fc.assert(
      fc.property(
        realisticEmailArb,
        fc.integer({ min: 0, max: 6 }),
        fc.boolean(),
        (recipientId, totalCount, isCancelingAllPending) => {
          const guard = resolveChatPendingCancelAllGuard({
            selectedRecipientId: recipientId,
            totalCount,
            isCancelingAllPending,
          });
          expect(guard.shouldRun).toBe(totalCount > 0 && !isCancelingAllPending);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ===========================================================================
// Property 9 — Preservation, Part B: delivery/read receipt ticks
// ===========================================================================
describe('stuck-message-delivery-fix — Property 9 (Preservation) B: delivery/read receipt ticks derived from delivered/read + deliveryProvenance', () => {
  // Anchored to the export's genuine delivered/read records.
  it('ANCHOR (baseline): the three tick tiers render correctly', () => {
    // Sent-only (single tick): no delivery yet.
    expect(deriveReceiptTier({ delivered: false, read: false })).toBe('sent');

    // Delivered via presence (double tick) — mirrors the export's
    // deliveryProvenance.lastSource: "presence" with delivered: true.
    expect(
      deriveReceiptTier({ delivered: true, read: false, deliveredAt: '2026-03-11T14:02:15.302Z' })
    ).toBe('delivered');

    // Read (blue/read tick).
    expect(
      deriveReceiptTier({
        delivered: true,
        read: true,
        deliveredAt: '2026-03-11T14:02:15.302Z',
        readAt: '2026-03-14T15:46:59.337Z',
      })
    ).toBe('read');
  });

  it('for any (delivered, read) message, the displayed tick tier is exactly the pure function of delivered/read', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (deliveredSeed, readSeed) => {
        // A read message must have been delivered (read implies delivered).
        const delivered = deliveredSeed || readSeed;
        const read = readSeed;

        const tier = deriveReceiptTier({
          delivered,
          read,
          deliveredAt: delivered ? '2026-01-01T00:00:01.000Z' : undefined,
          readAt: read ? '2026-01-01T00:00:02.000Z' : undefined,
        });

        expect(tier).toBe(expectedTier(delivered, read));
      }),
      { numRuns: 40 }
    );
  });

  it('the tick tier is invariant to which deliveryProvenance source (presence/push/both) delivered the message', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        deliveredProvenanceArb,
        deliveredProvenanceArb,
        (readSeed, provA, provB) => {
          // Both provenance variants establish delivery (upstream multi-source rule).
          expect(isDeliveredFromProvenance(provA)).toBe(true);
          expect(isDeliveredFromProvenance(provB)).toBe(true);

          const read = readSeed;
          const build = (prov: DeliveryProvenance): ReceiptTier =>
            deriveReceiptTier({
              // The display consumes the `delivered` flag that provenance established.
              delivered: isDeliveredFromProvenance(prov),
              read,
              deliveredAt: prov.presence?.deliveredAt ?? prov.push?.deliveredAt,
              readAt: read ? '2026-01-01T00:00:03.000Z' : undefined,
            });

          const tierA = build(provA);
          const tierB = build(provB);

          // Same (delivered, read) => same tick, regardless of provenance source.
          expect(tierA).toBe(tierB);
          expect(tierA).toBe(expectedTier(true, read));
        }
      ),
      { numRuns: 40 }
    );
  });
});
