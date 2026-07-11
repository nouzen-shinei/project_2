// Authoritative send-confirmation state (chat-production-hardening, finding P1-2).
//
// The delivered-reconciliation effect and the outbox self-heal driver in
// `app/(tabs)/chat.tsx` originally derived their "is this message durably
// delivered?" signal purely from the ids present in the CURRENTLY LOADED page
// (`displayedMessages`). That page can miss a message that WAS durably persisted
// for the intended recipient (listener gap, pagination trim, race), so a genuine
// send could be re-driven and eventually dead-lettered to a misleading `failed`.
//
// The stuck-message-delivery-fix guarantees that a self-addressed send is
// rejected at the client and the server write boundary, so a `sendMessage(...)`
// call that RESOLVES with a `serverMessageId` is authoritative proof that a
// durable record exists for the intended (non-self) recipient. These helpers fold
// that authoritative confirmation into the delivered signal so a successfully-sent
// message is treated as confirmed even when it is not on the loaded page — it is
// therefore never re-driven and never dead-lettered.
//
// Everything here is pure so it can be unit-tested in isolation and reused by the
// component without pulling in React state.

import { resolveChatNormalizedMessageId } from './chatNormalizationState';

/**
 * Build the authoritative delivered/confirmed id set as the UNION of:
 *  (a) ids present in the currently loaded page (`displayedIds`), and
 *  (b) ids independently confirmed by a resolved send/retry/re-drive
 *      (`confirmedIds`).
 *
 * Every id is normalized (via {@link resolveChatNormalizedMessageId}) and empty
 * ids are dropped so membership checks line up with `normalizeMessageId(...)`
 * used elsewhere.
 */
export function resolveConfirmedDeliveredIds(
  displayedIds: Iterable<string> | null | undefined,
  confirmedIds: Iterable<string> | null | undefined
): Set<string> {
  const union = new Set<string>();
  const add = (source: Iterable<string> | null | undefined): void => {
    if (!source) {
      return;
    }
    for (const id of source) {
      const normalized = resolveChatNormalizedMessageId(id);
      if (normalized) {
        union.add(normalized);
      }
    }
  };
  add(displayedIds);
  add(confirmedIds);
  return union;
}

export interface IsPendingSendConfirmedInput {
  /** The server message id returned when the send/re-drive resolved. */
  serverMessageId?: unknown;
  /** Ids present in the currently loaded page. */
  displayedIds: Iterable<string> | null | undefined;
  /** Ids independently confirmed by a resolved send/retry/re-drive. */
  confirmedIds: Iterable<string> | null | undefined;
}

/**
 * A pending send is confirmed when its (normalized) `serverMessageId` is present
 * either in the loaded page OR in the authoritative confirmed set. A message
 * confirmed only via the confirmed set (i.e. successfully sent but not on the
 * loaded page) is still treated as confirmed.
 */
export function isPendingSendConfirmed(input: IsPendingSendConfirmedInput): boolean {
  const normalizedServerId = resolveChatNormalizedMessageId(input.serverMessageId);
  if (!normalizedServerId) {
    return false;
  }
  const confirmed = resolveConfirmedDeliveredIds(input.displayedIds, input.confirmedIds);
  return confirmed.has(normalizedServerId);
}

export type ExhaustedOutboxAction = 'confirm' | 'dead-letter';

export interface ResolveExhaustedOutboxActionInput {
  /** The server message id returned when the send/re-drive resolved. */
  serverMessageId?: unknown;
  /**
   * The authoritative delivered/confirmed id set (union of the loaded page and
   * the confirmed set) — typically the value returned by
   * {@link resolveConfirmedDeliveredIds}.
   */
  confirmedDeliveredIds: ReadonlySet<string> | null | undefined;
  /**
   * Result of an authoritative existence check by `serverMessageId` in the
   * intended (non-self) conversation. Best-effort: pass `false` when the check
   * could not be performed or errored, so genuine failures still dead-letter.
   */
  recordExists: boolean;
}

/**
 * Decide what to do with a pending send whose bounded re-drive budget is
 * exhausted. Before flipping it to a misleading `failed`, confirm delivery from
 * an authoritative record check — not from loaded-page presence alone:
 *
 *  - `confirm`: the message is already in the confirmed set, or an authoritative
 *    existence check found the durable record for the intended recipient. Do NOT
 *    dead-letter — mark it confirmed instead.
 *  - `dead-letter`: no confirmation and no durable record — a genuine failure,
 *    surface an actionable `failed` state.
 */
export function resolveExhaustedOutboxAction(
  input: ResolveExhaustedOutboxActionInput
): ExhaustedOutboxAction {
  const normalizedServerId = resolveChatNormalizedMessageId(input.serverMessageId);
  if (
    normalizedServerId &&
    input.confirmedDeliveredIds &&
    input.confirmedDeliveredIds.has(normalizedServerId)
  ) {
    return 'confirm';
  }
  if (input.recordExists) {
    return 'confirm';
  }
  return 'dead-letter';
}
