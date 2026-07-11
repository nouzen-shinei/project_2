// App-level outbox self-heal core (chat-production-hardening, finding P1-1).
//
// Background
// ----------
// The original outbox self-heal driver (`driveUnconfirmedOutbox` /
// `reDriveUnconfirmedPendingMessage` in `app/(tabs)/chat.tsx`) was gated on
// `selectedTeamMember.id` and only ran while the chat SCREEN was mounted, so a
// message queued/unconfirmed in a DIFFERENT conversation never resumed until the
// user reopened that conversation. This module hoists the driver's reusable,
// side-effect-free decision logic to an app-level scope so a new hook
// (`hooks/useOutboxSelfHeal.ts`, mounted high in the tree) can iterate ALL
// persisted pending items (grouped by recipient) via `PendingMessageStorage` and
// heal every conversation — not just the open one.
//
// The self-heal contract is preserved exactly:
//   * bounded exponential backoff (`resolveOutboxBackoffMs`) with an initial
//     stale-grace window so a still-in-flight send is never double-driven,
//   * clientMsgId-idempotent re-drive (the server upserts by clientMsgId so a
//     retry produces at most one durable record),
//   * dead-lettering to `failed` once the bounded attempt cap is exhausted, and
//   * authoritative "Sent" confirmation via the confirmed-id set + an existence
//     check (`chatService.messageExistsById`) BEFORE dead-lettering, so a message
//     that is durably persisted for the intended recipient is never falsely
//     failed (chat-production-hardening, P1-2).
//
// Duplicate-drive avoidance
// -------------------------
// When the chat screen is mounted it still drives ITS OWN selected conversation
// for immediate UI feedback. To avoid two competing drivers racing the same
// pending items, the chat screen registers a CLAIM for its selected recipient
// (`claimOutboxConversation`) and this app-level driver skips any recipient that
// is currently claimed. Because the chat screen only ever loads/drives the
// selected conversation's pending items, the split is clean: the screen owns the
// open conversation, this driver owns every other conversation.
//
// Everything here is pure or dependency-injected so it can be unit/property
// tested in isolation without React, AsyncStorage, or a live backend.

import { resolveChatPendingConversationDerivedState } from './chatPendingConversationDerived';
import { resolveExhaustedOutboxAction } from './chatSendConfirmationState';
import { normalizePendingMessageStatus } from './pendingMessageState';

// ── Backoff / timing policy (single source of truth, shared with chat.tsx) ────
// A send accepted locally but not yet confirmed durable for the intended
// recipient is re-driven with bounded exponential backoff, then dead-lettered to
// `failed` once the attempt cap is exhausted (never left as a misleading "Sent").
export const OUTBOX_MAX_REDRIVE_ATTEMPTS = 5;
// Grace period before the first re-drive so we never race the initial in-flight
// send that is still awaiting its own promise.
export const OUTBOX_MIN_STALE_MS = 8000;
export const OUTBOX_BASE_BACKOFF_MS = 8000;
export const OUTBOX_MAX_BACKOFF_MS = 5 * 60 * 1000;
export const OUTBOX_DRIVER_TICK_MS = 5000;

export const resolveOutboxBackoffMs = (attempts: number): number =>
  Math.min(OUTBOX_MAX_BACKOFF_MS, OUTBOX_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempts)));

/**
 * Robustly resolve a pending item's timestamp to epoch millis. Handles numeric,
 * `Date`, ISO-string (the on-disk `PendingMessage.timestamp` shape), and Firebase
 * `toMillis()` timestamps. An unparseable/missing timestamp resolves to `0`
 * (epoch) so a persisted item that lost its timestamp is treated as OLD (past the
 * grace window) and therefore eligible for healing rather than stuck forever.
 */
export function resolveOutboxTimestampMs(timestamp: unknown): number {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (timestamp instanceof Date) {
    const ms = timestamp.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (timestamp && typeof timestamp === 'object' && 'toMillis' in timestamp) {
    const toMillis = (timestamp as { toMillis?: unknown }).toMillis;
    if (typeof toMillis === 'function') {
      const ms = (toMillis as () => number).call(timestamp);
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : 0;
    }
  }
  return 0;
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// ── Cross-driver coordination: conversation claims ───────────────────────────
// The mounted chat screen registers a claim for its selected recipient so the
// app-level driver never re-drives the same pending items in parallel.
const claimedRecipients = new Map<string, number>();

/**
 * Claim a recipient conversation for the mounted chat screen's own driver.
 * Reference-counted so overlapping mounts (e.g. a fast remount) never release a
 * still-active claim prematurely. Returns an idempotent release function.
 */
export function claimOutboxConversation(recipientId: unknown): () => void {
  const key = typeof recipientId === 'string' ? recipientId.trim() : '';
  if (!key) {
    return () => undefined;
  }
  claimedRecipients.set(key, (claimedRecipients.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const count = claimedRecipients.get(key) ?? 0;
    if (count <= 1) {
      claimedRecipients.delete(key);
    } else {
      claimedRecipients.set(key, count - 1);
    }
  };
}

/** True when the chat screen currently owns (is driving) this recipient. */
export function isOutboxRecipientClaimed(recipientId: unknown): boolean {
  const key = typeof recipientId === 'string' ? recipientId.trim() : '';
  return key ? claimedRecipients.has(key) : false;
}

/** Test-only: clear all claims between tests. */
export function __resetOutboxClaimsForTests(): void {
  claimedRecipients.clear();
}

// ── Per-item scheduling (pure) ───────────────────────────────────────────────
export interface OutboxRedriveBookkeeping {
  attempts: number;
  nextAt: number;
}

export type OutboxScheduleAction = 'wait' | 'arm' | 'redrive';

export interface OutboxScheduleInput {
  now: number;
  timestampMs: number;
  retryCount: number;
  existing?: OutboxRedriveBookkeeping;
}

export interface OutboxScheduleDecision {
  action: OutboxScheduleAction;
  /** Present when `action === 'arm'`: the initial backoff window to record. */
  state?: OutboxRedriveBookkeeping;
}

/**
 * Decide whether a not-yet-confirmed pending item should be re-driven now. This
 * mirrors the per-item logic of the original `driveUnconfirmedOutbox`:
 *   - `wait`    : still inside the initial stale-grace window, or inside the
 *                 armed backoff window.
 *   - `arm`     : first time we notice a stranded item past the grace window —
 *                 record the initial backoff window instead of firing immediately.
 *   - `redrive` : the armed backoff window has elapsed; fire a re-drive.
 */
export function resolveOutboxSchedule(input: OutboxScheduleInput): OutboxScheduleDecision {
  const ageMs = input.now - input.timestampMs;
  if (ageMs < OUTBOX_MIN_STALE_MS) {
    return { action: 'wait' };
  }
  if (!input.existing) {
    return {
      action: 'arm',
      state: {
        attempts: input.retryCount ?? 0,
        nextAt: input.now + OUTBOX_BASE_BACKOFF_MS,
      },
    };
  }
  if (input.now < input.existing.nextAt) {
    return { action: 'wait' };
  }
  return { action: 'redrive' };
}

/**
 * Compute the next attempt count + backoff window for a re-drive. The attempt
 * count advances from whichever is larger of the persisted `retryCount` and the
 * in-memory bookkeeping, so restarts don't reset the bounded budget.
 */
export function resolveNextRedriveState(
  existing: OutboxRedriveBookkeeping | undefined,
  retryCount: number,
  now: number
): OutboxRedriveBookkeeping {
  const base = existing?.attempts ?? retryCount ?? 0;
  const attempts = base + 1;
  return { attempts, nextAt: now + resolveOutboxBackoffMs(attempts) };
}

// ── Driver (dependency-injected, testable) ───────────────────────────────────
export interface OutboxPendingMessageLike {
  id?: string;
  text?: string;
  sender?: string;
  recipientId?: string;
  timestamp?: unknown;
  status?: unknown;
  serverMessageId?: string;
  clientMsgId?: string;
  retryCount?: number;
  replyTo?: unknown;
}

export interface OutboxSelfHealDeps {
  /** Load ALL persisted pending text messages (device-wide, all conversations). */
  loadPendingMessages: () => Promise<Map<string, OutboxPendingMessageLike>>;
  /** Persist a single pending item (used to dead-letter to `failed`). */
  savePendingMessage: (id: string, message: OutboxPendingMessageLike) => Promise<void>;
  /** Remove pending items that have been confirmed durably delivered. */
  removePendingMessages: (ids: string[]) => Promise<void>;
  /**
   * Re-drive a send to the intended recipient, reusing `clientMsgId` so the
   * server upsert is idempotent. Resolves with the durable serverMessageId.
   */
  sendMessage: (message: {
    text: string;
    sender: string;
    recipientId: string;
    clientMsgId?: string;
    isSpecial?: boolean;
    replyTo?: unknown;
  }) => Promise<string>;
  /** Authoritative existence check for the intended (non-self) recipient. */
  messageExistsById: (
    sender: string,
    recipientId: string,
    serverMessageId: string
  ) => Promise<boolean>;
  now: () => number;
  normalizeMessageId: (value: unknown) => string;
  /** True when the mounted chat screen currently owns this recipient. */
  isRecipientClaimed?: (recipientId: string) => boolean;
  onError?: (context: string, error: unknown) => void;
}

export interface OutboxSelfHealRuntimeState {
  /** Per-item backoff bookkeeping (attempts + next eligible time). */
  bookkeeping: Map<string, OutboxRedriveBookkeeping>;
  /** Normalized serverMessageIds independently confirmed durable this session. */
  confirmedIds: Set<string>;
  /** Items with an in-flight re-drive, so overlapping ticks never double-fire. */
  inFlight: Set<string>;
}

export function createOutboxSelfHealState(): OutboxSelfHealRuntimeState {
  return {
    bookkeeping: new Map<string, OutboxRedriveBookkeeping>(),
    confirmedIds: new Set<string>(),
    inFlight: new Set<string>(),
  };
}

const EMPTY_MAP: ReadonlyMap<string, never> = new Map<string, never>();

/**
 * Run one pass of the app-level outbox self-heal driver across ALL persisted
 * pending items (every conversation), skipping any recipient currently claimed by
 * the mounted chat screen. Returns a small summary useful for tests/telemetry.
 */
export async function driveOutboxSelfHealOnce(
  deps: OutboxSelfHealDeps,
  state: OutboxSelfHealRuntimeState
): Promise<{
  redriven: string[];
  confirmed: string[];
  deadLettered: string[];
  skippedClaimed: string[];
}> {
  const redriven: string[] = [];
  const confirmed: string[] = [];
  const deadLettered: string[] = [];
  const skippedClaimed: string[] = [];

  let all: Map<string, OutboxPendingMessageLike>;
  try {
    all = await deps.loadPendingMessages();
  } catch (error) {
    deps.onError?.('outboxSelfHeal.load', error);
    return { redriven, confirmed, deadLettered, skippedClaimed };
  }
  if (!all || all.size === 0) {
    // Prune stale bookkeeping for items that no longer exist.
    state.bookkeeping.clear();
    return { redriven, confirmed, deadLettered, skippedClaimed };
  }

  // Group by recipient so we can reuse the per-conversation eligibility classifier.
  const groups = new Map<string, Map<string, OutboxPendingMessageLike>>();
  for (const [tempId, message] of all) {
    const recipientId = typeof message?.recipientId === 'string' ? message.recipientId : '';
    if (!recipientId) {
      continue;
    }
    let group = groups.get(recipientId);
    if (!group) {
      group = new Map<string, OutboxPendingMessageLike>();
      groups.set(recipientId, group);
    }
    group.set(tempId, message);
  }

  const isClaimed = deps.isRecipientClaimed ?? isOutboxRecipientClaimed;
  const toRemove: string[] = [];

  const finalizeConfirmed = (tempId: string, serverId: string): void => {
    if (serverId) {
      state.confirmedIds.add(serverId);
    }
    state.bookkeeping.delete(tempId);
    toRemove.push(tempId);
    confirmed.push(tempId);
  };

  for (const [recipientId, group] of groups) {
    // Duplicate-drive avoidance: the mounted chat screen owns its selected
    // conversation, so never re-drive the same items in parallel here.
    if (isClaimed(recipientId)) {
      for (const tempId of group.keys()) {
        skippedClaimed.push(tempId);
      }
      continue;
    }

    // Reuse the shared classifier so eligibility stays identical to the chat
    // screen. Finding P1-1 covers BOTH self-heal paths that were gated on the
    // open conversation:
    //   * `autoRedriveTextIds` — accepted-but-unconfirmed sends (`sending`/`sent`),
    //     the cross-conversation equivalent of `driveUnconfirmedOutbox`, and
    //   * `queuedTextIds` — offline-queued sends, the cross-conversation
    //     equivalent of queued-retry-on-reconnect (`retryAllQueuedPendingSends`).
    // Both must resume in the background; the mounted chat screen still handles
    // the open conversation promptly.
    const derived = resolveChatPendingConversationDerivedState({
      selectedRecipientId: recipientId,
      pendingMessages: group,
      pendingMedia: EMPTY_MAP as ReadonlyMap<string, { recipientId?: unknown; status?: unknown }>,
      pendingAttachments: EMPTY_MAP as ReadonlyMap<
        string,
        { recipientId?: unknown; status?: unknown }
      >,
      resolvePendingMessageStatus: (message) => normalizePendingMessageStatus(message.status),
    });

    const eligibleIds = Array.from(
      new Set<string>([...derived.autoRedriveTextIds, ...derived.queuedTextIds])
    );

    for (const tempId of eligibleIds) {
      const message = group.get(tempId);
      if (!message) {
        continue;
      }
      const sender = typeof message.sender === 'string' ? message.sender : '';
      // Defensive self-address skip (should already be blocked upstream): never
      // re-drive a self-addressed item — it can never confirm for a real recipient.
      if (!sender || normalizeEmail(sender) === normalizeEmail(recipientId)) {
        continue;
      }
      if (state.inFlight.has(tempId)) {
        continue;
      }

      const serverId = deps.normalizeMessageId(message.serverMessageId);
      // Already confirmed durable this session — finalize and stop re-driving.
      if (serverId && state.confirmedIds.has(serverId)) {
        finalizeConfirmed(tempId, serverId);
        continue;
      }

      const existing = state.bookkeeping.get(tempId);
      const decision = resolveOutboxSchedule({
        now: deps.now(),
        timestampMs: resolveOutboxTimestampMs(message.timestamp),
        retryCount: typeof message.retryCount === 'number' ? message.retryCount : 0,
        existing,
      });

      if (decision.action === 'wait') {
        continue;
      }

      if (decision.action === 'arm') {
        // First sighting past the grace window. Before arming a re-drive, consult
        // the authoritative existence check: a message that is ALREADY durably
        // persisted for the intended recipient (delivered but never reconciled
        // because the conversation was never reopened) must be finalized, not
        // re-sent (chat-production-hardening, P1-2 authoritative confirmation).
        if (serverId) {
          let recordExists = false;
          try {
            recordExists = await deps.messageExistsById(sender, recipientId, serverId);
          } catch (error) {
            deps.onError?.('outboxSelfHeal.existsCheck', error);
            recordExists = false;
          }
          if (recordExists) {
            finalizeConfirmed(tempId, serverId);
            continue;
          }
        }
        if (decision.state) {
          state.bookkeeping.set(tempId, decision.state);
        }
        continue;
      }

      // decision.action === 'redrive'
      const nextState = resolveNextRedriveState(
        existing,
        typeof message.retryCount === 'number' ? message.retryCount : 0,
        deps.now()
      );

      // Bounded policy exhausted: confirm from an authoritative record check
      // BEFORE dead-lettering so a persisted-but-unreconciled message is never
      // flipped to a misleading `failed`.
      if (nextState.attempts > OUTBOX_MAX_REDRIVE_ATTEMPTS) {
        state.bookkeeping.delete(tempId);
        let recordExists = false;
        if (serverId) {
          try {
            recordExists = await deps.messageExistsById(sender, recipientId, serverId);
          } catch (error) {
            deps.onError?.('outboxSelfHeal.existsCheck', error);
            recordExists = false;
          }
        }
        const action = resolveExhaustedOutboxAction({
          serverMessageId: serverId,
          confirmedDeliveredIds: state.confirmedIds,
          recordExists,
        });
        if (action === 'confirm') {
          finalizeConfirmed(tempId, serverId);
        } else {
          try {
            await deps.savePendingMessage(tempId, { ...message, status: 'failed' });
          } catch (error) {
            deps.onError?.('outboxSelfHeal.deadLetter', error);
          }
          deadLettered.push(tempId);
        }
        continue;
      }

      // Reserve the next backoff window BEFORE awaiting so an overlapping tick
      // never double-drives the same item.
      state.bookkeeping.set(tempId, nextState);
      state.inFlight.add(tempId);
      try {
        const newServerId = await deps.sendMessage({
          text: typeof message.text === 'string' ? message.text : '',
          sender,
          recipientId,
          clientMsgId: message.clientMsgId || tempId,
          isSpecial: false,
          replyTo: message.replyTo,
        });
        // A resolved send is authoritative proof of a durable record for the
        // intended (non-self) recipient (self-address is rejected at the write
        // boundary). Confirm and finalize so it is never re-driven again.
        const normalizedNew = deps.normalizeMessageId(newServerId);
        finalizeConfirmed(tempId, normalizedNew);
        redriven.push(tempId);
      } catch (error) {
        // Leave the item eligible; the next tick retries after the backoff window.
        deps.onError?.('outboxSelfHeal.redrive', error);
      } finally {
        state.inFlight.delete(tempId);
      }
    }
  }

  if (toRemove.length > 0) {
    try {
      await deps.removePendingMessages(toRemove);
    } catch (error) {
      deps.onError?.('outboxSelfHeal.remove', error);
    }
  }

  // Prune bookkeeping for items no longer present so the map can't grow unbounded.
  for (const tempId of Array.from(state.bookkeeping.keys())) {
    if (!all.has(tempId)) {
      state.bookkeeping.delete(tempId);
    }
  }

  return { redriven, confirmed, deadLettered, skippedClaimed };
}
