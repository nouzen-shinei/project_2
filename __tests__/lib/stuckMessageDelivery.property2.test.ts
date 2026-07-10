// Feature: stuck-message-delivery-fix
// Property 2 (Bug Condition) — Self-healing, idempotent retry to the intended
// recipient.
//
// **Validates: Requirements 2.2, 2.3, 2.4**
//
// EXPLORATION TEST (exploratory bugfix workflow):
//   This property-based test is written BEFORE the fix and is EXPECTED TO FAIL on
//   the current UNFIXED code. Its failure is the SUCCESS signal — it surfaces the
//   counterexample that proves the bug exists: a not-yet-confirmed send that was
//   promoted to the terminal `sent` state (during the outage its only durable
//   record is self-addressed) is NEVER auto-re-driven to the intended recipient,
//   because `sent` is treated as terminal and is excluded from the retry pipeline,
//   and reconciliation only *subtracts* delivered items — it never re-drives.
//
//   Do NOT "fix" this test or the production code to make it pass here. Once the
//   delivery / self-heal fix lands (retriable un-confirmed items + idempotent
//   re-drive keyed on clientMsgId + bounded dead-letter to `failed`), this same
//   test will pass (fix checking, task 12.2).
//
// WHAT IS EXERCISED FOR REAL:
//   The two production classifiers that own the self-heal decisions run
//   unmodified as the system under test:
//     - `resolveChatPendingConversationDerivedState` (lib/chatPendingConversationDerived.ts)
//       decides whether a pending item is eligible for automatic self-heal
//       re-drive (`autoRedriveTextIds`), decoupled from the manual retry banner.
//     - `resolveChatPendingTextMessageReconciledIds` (lib/chatPendingReconciliationState.ts)
//       decides whether a pending item is confirmed durably delivered (and thus
//       may be finalized/removed) by matching its serverMessageId against the set
//       of ids delivered to the INTENDED recipient's conversation.
//
//   A minimal in-test self-heal driver plays random re-drive triggers (reconnect /
//   foreground / relaunch) and defers BOTH decisions to those real functions:
//     * "is this un-confirmed item eligible for auto re-drive?" -> autoRedriveTextIds
//     * "is this item now durably confirmed for the intended recipient?" -> reconciled ids
//   The driver only performs a state transition that the current code actually
//   enables. Because the unfixed classifier never admits a `sent` item into the
//   retry pipeline, the driver never re-drives it and never dead-letters it — it
//   just sits at `sent` forever, exactly as observed in production.
//
// THE INCIDENT (tenant CGnHGq43PFF8WD2DJekx):
//   The stranded record `-OwLnPs_TYzsdesLA6gC` (text "hgghdsghs", `delivered:false`)
//   was written self-addressed into the self conversation
//   `krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com` (`sender == recipientId`).
//   The sender's outbox shows it as terminal `sent`, so it is neither delivered to
//   the intended recipient nor re-attempted.

import * as fc from 'fast-check';

import { resolveChatPendingConversationDerivedState } from '../../lib/chatPendingConversationDerived';
import { resolveChatPendingTextMessageReconciledIds } from '../../lib/chatPendingReconciliationState';

// ---------------------------------------------------------------------------
// Model types — a faithful, minimal shape of a text pending outbox item.
// ---------------------------------------------------------------------------
type PendingStatus = 'queued' | 'sending' | 'sent' | 'failed';

interface PendingTextItem {
  recipientId: string; // the INTENDED recipient (the outbox item always targets them)
  status: PendingStatus;
  serverMessageId: string | null; // last known server id (initially the self-addressed record)
  clientMsgId: string; // stable client identity used for idempotent re-drive
}

type ReDriveTrigger = 'reconnect' | 'foreground' | 'relaunch';

// Bounded retry policy: after this many un-confirmed re-drive attempts, an
// un-confirmed item must dead-letter to `failed` (never remain a phantom `sent`).
const POLICY_MAX_ATTEMPTS = 4;

const TEMP_ID = 'temp-outbox-1';

function normalizeEmail(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const resolveStatus = (m: PendingTextItem): PendingStatus => m.status;
const normalizeMessageId = (v: unknown): string => (typeof v === 'string' ? v : '');

interface SelfHealResult {
  finalStatus: PendingStatus;
  retriableObserved: boolean; // did the real classifier ever admit the item to the retry pipeline?
  confirmedForIntended: boolean; // durable record for the intended recipient confirmed?
  durableRecordsForIntended: number; // idempotency ledger size (must be <= 1)
  reDriveAttempts: number;
}

/**
 * Drive the self-heal loop for a stranded, un-confirmed `sent` item across a
 * sequence of re-drive triggers. Every branch decision is delegated to the REAL
 * production classifiers; the driver only applies a transition the current code
 * actually supports.
 *
 * @param recoverAfterAttempts the re-drive attempt on which the backend accepts
 *   the write to the intended recipient (Infinity models a persistent outage).
 */
function runSelfHeal(params: {
  intendedRecipient: string;
  selfAddressedServerId: string;
  clientMsgId: string;
  triggers: ReDriveTrigger[];
  recoverAfterAttempts: number;
}): SelfHealResult {
  const pending: PendingTextItem = {
    recipientId: params.intendedRecipient,
    // Promoted to terminal `sent` during the outage even though the only durable
    // record is self-addressed (this is exactly what handleSendMessage does today).
    status: 'sent',
    serverMessageId: params.selfAddressedServerId,
    clientMsgId: params.clientMsgId,
  };

  // Durable message ids delivered to the INTENDED recipient's conversation.
  const deliveredToIntended = new Set<string>();
  // Idempotency ledger: clientMsgId -> serverId of the intended-recipient record.
  const intendedRecordByClientMsgId = new Map<string, string>();

  let retriableObserved = false;
  let reDriveAttempts = 0;

  for (const _trigger of params.triggers) {
    void _trigger; // trigger kind is immaterial to the classifier decisions

    const pendingMap = new Map<string, PendingTextItem>([[TEMP_ID, pending]]);

    // (1) Confirmed durably for the intended recipient? -> real reconciliation.
    const reconciledIds = resolveChatPendingTextMessageReconciledIds({
      pendingMessages: pendingMap,
      deliveredMessageIds: deliveredToIntended,
      normalizeMessageId,
      resolvePendingMessageStatus: resolveStatus,
    });
    if (reconciledIds.includes(TEMP_ID)) {
      // Legitimately terminal: a durable record for the intended recipient exists.
      break;
    }

    // (2) Not confirmed. A self-healing system must keep an un-confirmed item
    //     eligible for automatic re-drive. Self-heal eligibility now lives on the
    //     dedicated `autoRedriveTextIds` seam (sending/sent), decoupled from the
    //     manual "N pending items not sent" retry banner (`retryableTextIds`,
    //     failed/queued only) so a healthy in-flight send never flashes the
    //     banner (stuck-message-delivery-fix hotfix, Fix B).
    const derived = resolveChatPendingConversationDerivedState({
      selectedRecipientId: params.intendedRecipient,
      pendingMessages: pendingMap,
      pendingMedia: new Map(),
      pendingAttachments: new Map(),
      resolvePendingMessageStatus: resolveStatus,
    });

    if (!derived.autoRedriveTextIds.includes(TEMP_ID)) {
      // The item is not eligible for automatic re-drive. It is therefore never
      // re-driven AND never dead-lettered — it is stuck at its current status.
      break;
    }

    retriableObserved = true;

    // (3) Bounded policy exhausted without confirmation -> dead-letter to `failed`.
    if (reDriveAttempts >= POLICY_MAX_ATTEMPTS) {
      pending.status = 'failed';
      break;
    }

    // (4) Re-drive idempotently keyed on clientMsgId. A retried send reuses the
    //     same identity, so at most one durable record is ever produced.
    reDriveAttempts += 1;
    if (reDriveAttempts >= params.recoverAfterAttempts) {
      let serverId = intendedRecordByClientMsgId.get(pending.clientMsgId);
      if (!serverId) {
        serverId = `-Intended_${pending.clientMsgId}`;
        intendedRecordByClientMsgId.set(pending.clientMsgId, serverId);
      }
      deliveredToIntended.add(serverId);
      // Point the outbox item at the intended-recipient record so the next tick's
      // reconciliation can confirm it.
      pending.serverMessageId = serverId;
    }
    // Otherwise the re-drive did not land (still outage); keep looping.
  }

  const confirmedForIntended =
    pending.serverMessageId != null && deliveredToIntended.has(pending.serverMessageId);

  return {
    finalStatus: pending.status,
    retriableObserved,
    confirmedForIntended,
    durableRecordsForIntended: intendedRecordByClientMsgId.size,
    reDriveAttempts,
  };
}

// A trigger sequence long enough for the bounded policy to fully play out
// (either self-heal to confirmed, or exhaust and dead-letter to `failed`).
const triggerSequenceArb = fc.array(
  fc.constantFrom<ReDriveTrigger>('reconnect', 'foreground', 'relaunch'),
  { minLength: POLICY_MAX_ATTEMPTS + 2, maxLength: POLICY_MAX_ATTEMPTS + 6 }
);

// ---------------------------------------------------------------------------
// Property 2 — Bug Condition
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 2 (Bug Condition): self-healing, idempotent retry to the intended recipient', () => {
  // Anchored to the confirmed incident before generalizing.
  it('ANCHOR (incident): the stranded self-addressed "sent" item is admitted to retry and self-heals to the intended recipient (backend recovers)', () => {
    const clientMsgId = 'client-hgghdsghs';
    const selfAddressedServerId = '-OwLnPs_TYzsdesLA6gC'; // the durable self-addressed record

    const result = runSelfHeal({
      intendedRecipient: 'invipika@gmail.com',
      selfAddressedServerId,
      clientMsgId,
      triggers: ['reconnect', 'foreground', 'relaunch', 'reconnect', 'foreground', 'relaunch'],
      recoverAfterAttempts: 1, // backend recovers immediately once a re-drive fires
    });

    // Property 2(a): an un-confirmed pending item SHALL stay eligible for auto
    // re-drive (the `autoRedriveTextIds` self-heal seam).
    expect(result.retriableObserved).toBe(true);

    // Property 2(b): the re-drive self-heals to the intended recipient with at
    // most one durable record. UNFIXED: no re-drive ever happens -> not confirmed.
    expect(result.confirmedForIntended).toBe(true);
    expect(result.durableRecordsForIntended).toBeLessThanOrEqual(1);

    // With the backend recovering on the first re-drive, the item self-heals and
    // ends as a genuinely-backed terminal `sent` (a real durable record now
    // exists for the intended recipient — not a phantom sent). UNFIXED code never
    // admits the item to retry, so it never reaches this recovered `sent`.
    expect(result.finalStatus).toBe('sent');
  });

  it('RECOVERY: an un-confirmed "sent" item stays retriable and self-heals to the intended recipient exactly once (idempotent on clientMsgId)', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.emailAddress(),
        fc.string({ minLength: 1, maxLength: 40 }),
        triggerSequenceArb,
        fc.integer({ min: 1, max: POLICY_MAX_ATTEMPTS - 1 }),
        (sender, intendedRecipient, clientSeed, triggers, recoverAfterAttempts) => {
          // A genuine one-to-one conversation: the intended recipient is not the sender.
          fc.pre(normalizeEmail(sender) !== normalizeEmail(intendedRecipient));

          const result = runSelfHeal({
            intendedRecipient,
            selfAddressedServerId: `-Self_${normalizeEmail(sender)}`,
            clientMsgId: `client_${clientSeed}`,
            triggers,
            recoverAfterAttempts,
          });

          // (a) The un-confirmed item must have been admitted to the retry pipeline.
          expect(result.retriableObserved).toBe(true);
          // (b) It self-heals to the intended recipient with at most one durable record.
          expect(result.confirmedForIntended).toBe(true);
          expect(result.durableRecordsForIntended).toBeLessThanOrEqual(1);
          // A confirmed self-heal ends as `sent`, now genuinely backed by an
          // intended-recipient record (never a phantom sent).
          expect(result.finalStatus).toBe('sent');
        }
      ),
      { numRuns: 60 }
    );
  });

  it('PERSISTENT OUTAGE: after the bounded retry policy is exhausted without confirmation, the item becomes "failed", never "sent"', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        fc.emailAddress(),
        fc.string({ minLength: 1, maxLength: 40 }),
        triggerSequenceArb,
        (sender, intendedRecipient, clientSeed, triggers) => {
          fc.pre(normalizeEmail(sender) !== normalizeEmail(intendedRecipient));

          const result = runSelfHeal({
            intendedRecipient,
            selfAddressedServerId: `-Self_${normalizeEmail(sender)}`,
            clientMsgId: `client_${clientSeed}`,
            triggers,
            recoverAfterAttempts: Number.POSITIVE_INFINITY, // never recovers
          });

          // (a) The un-confirmed item must stay retriable while un-confirmed.
          expect(result.retriableObserved).toBe(true);
          // (c) Bounded policy exhausted without confirmation -> explicit `failed`.
          expect(result.finalStatus).toBe('failed');
          // Never a phantom terminal `sent` with no intended-recipient record.
          expect(result.finalStatus).not.toBe('sent');
          expect(result.confirmedForIntended).toBe(false);
          // (b) Idempotency holds even across a full exhausted retry window.
          expect(result.durableRecordsForIntended).toBeLessThanOrEqual(1);
        }
      ),
      { numRuns: 60 }
    );
  });
});
