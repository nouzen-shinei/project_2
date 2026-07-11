// Feature: chat-production-hardening (Task 4 — Confirm "Sent" from an
// authoritative record check, not loaded-page presence; finding P1-2).
//
// Unit tests for the pure send-confirmation helpers that the chat screen wires
// its delivered-reconciliation effect and outbox self-heal driver to. The key
// behavior under test:
//   * A message present ONLY in the authoritative confirmed set (i.e. it was
//     successfully sent but is not on the currently loaded page) is treated as
//     confirmed — so it is never re-driven or dead-lettered.
//   * A message present in neither the loaded page nor the confirmed set is
//     unconfirmed.
//   * An exhausted send is confirmed (not dead-lettered) when an authoritative
//     existence check finds its durable record, and a truly-absent send still
//     dead-letters to `failed`.

import {
  resolveConfirmedDeliveredIds,
  isPendingSendConfirmed,
  resolveExhaustedOutboxAction,
} from '../../lib/chatSendConfirmationState';

describe('chatSendConfirmationState — resolveConfirmedDeliveredIds', () => {
  it('unions the loaded-page ids and the confirmed ids', () => {
    const union = resolveConfirmedDeliveredIds(['-loaded1', '-loaded2'], ['-confirmed1']);
    expect(union.has('-loaded1')).toBe(true);
    expect(union.has('-loaded2')).toBe(true);
    expect(union.has('-confirmed1')).toBe(true);
    expect(union.size).toBe(3);
  });

  it('dedupes ids present in both sources', () => {
    const union = resolveConfirmedDeliveredIds(['-shared', '-loaded'], ['-shared', '-confirmed']);
    expect(union.size).toBe(3);
    expect([...union].sort()).toEqual(['-confirmed', '-loaded', '-shared']);
  });

  it('normalizes non-string ids and drops empty/nullish entries', () => {
    // Numeric ids are coerced to their string form; null/undefined are dropped.
    const union = resolveConfirmedDeliveredIds(
      [123 as unknown as string, '' as string],
      [null as unknown as string, undefined as unknown as string, '-ok']
    );
    expect(union.has('123')).toBe(true);
    expect(union.has('-ok')).toBe(true);
    expect(union.has('')).toBe(false);
    expect(union.size).toBe(2);
  });

  it('tolerates missing sources', () => {
    expect(resolveConfirmedDeliveredIds(null, undefined).size).toBe(0);
    expect([...resolveConfirmedDeliveredIds(['-a'], null)]).toEqual(['-a']);
    expect([...resolveConfirmedDeliveredIds(null, ['-b'])]).toEqual(['-b']);
  });
});

describe('chatSendConfirmationState — isPendingSendConfirmed', () => {
  it('confirms a message present only in the confirmed set (NOT on the loaded page)', () => {
    // This is the P1-2 case: durably persisted for the intended recipient but
    // absent from the loaded page. It MUST still be confirmed.
    expect(
      isPendingSendConfirmed({
        serverMessageId: '-persisted',
        displayedIds: ['-otherLoaded'],
        confirmedIds: ['-persisted'],
      })
    ).toBe(true);
  });

  it('confirms a message present only on the loaded page', () => {
    expect(
      isPendingSendConfirmed({
        serverMessageId: '-onPage',
        displayedIds: ['-onPage'],
        confirmedIds: [],
      })
    ).toBe(true);
  });

  it('does NOT confirm a message present in neither source', () => {
    expect(
      isPendingSendConfirmed({
        serverMessageId: '-missing',
        displayedIds: ['-loaded'],
        confirmedIds: ['-confirmed'],
      })
    ).toBe(false);
  });

  it('does NOT confirm when the serverMessageId is empty/nullish', () => {
    expect(
      isPendingSendConfirmed({ serverMessageId: '', displayedIds: ['-a'], confirmedIds: ['-b'] })
    ).toBe(false);
    expect(
      isPendingSendConfirmed({
        serverMessageId: null,
        displayedIds: ['-a'],
        confirmedIds: ['-b'],
      })
    ).toBe(false);
  });

  it('matches under id normalization (numeric vs string)', () => {
    // The confirmed set may hold the normalized string form while the pending
    // item carries a numeric id; normalization must make them match.
    expect(
      isPendingSendConfirmed({
        serverMessageId: 456 as unknown as string,
        displayedIds: [],
        confirmedIds: ['456'],
      })
    ).toBe(true);
  });
});

describe('chatSendConfirmationState — resolveExhaustedOutboxAction', () => {
  it('confirms (never dead-letters) when the id is already in the confirmed/delivered set', () => {
    expect(
      resolveExhaustedOutboxAction({
        serverMessageId: '-confirmed',
        confirmedDeliveredIds: new Set(['-confirmed']),
        recordExists: false,
      })
    ).toBe('confirm');
  });

  it('confirms an exhausted-but-persisted item when the existence check returns true', () => {
    // Not in the confirmed set (e.g. listener gap), but the authoritative record
    // check found the durable record for the intended recipient.
    expect(
      resolveExhaustedOutboxAction({
        serverMessageId: '-persisted',
        confirmedDeliveredIds: new Set(['-other']),
        recordExists: true,
      })
    ).toBe('confirm');
  });

  it('dead-letters a truly-absent item (no confirmation, no durable record)', () => {
    expect(
      resolveExhaustedOutboxAction({
        serverMessageId: '-gone',
        confirmedDeliveredIds: new Set(['-other']),
        recordExists: false,
      })
    ).toBe('dead-letter');
  });

  it('dead-letters when there is no server id and no durable record (genuine failure)', () => {
    expect(
      resolveExhaustedOutboxAction({
        serverMessageId: '',
        confirmedDeliveredIds: new Set(['-other']),
        recordExists: false,
      })
    ).toBe('dead-letter');
  });

  it('tolerates a missing confirmed set and falls back to the record check', () => {
    expect(
      resolveExhaustedOutboxAction({
        serverMessageId: '-x',
        confirmedDeliveredIds: null,
        recordExists: true,
      })
    ).toBe('confirm');
    expect(
      resolveExhaustedOutboxAction({
        serverMessageId: '-x',
        confirmedDeliveredIds: undefined,
        recordExists: false,
      })
    ).toBe('dead-letter');
  });
});
