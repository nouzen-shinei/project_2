// Feature: device-tenant-index, Property 8: The fallback is forced whenever the backfill is incomplete

/**
 * Property 8: The fallback is forced whenever the backfill is incomplete
 * **Validates: Requirements 8.1, 8.2, 8.3**
 *
 * The pure rollout decision `decideListingMode({ flagEnabled, backfillCompleted })`
 * (design Component 6) must:
 *   - return `'fallback'` whenever the feature flag is OFF, regardless of
 *     backfill completion (Req 8.1);
 *   - return `'fallback'` whenever the backfill is INCOMPLETE, regardless of the
 *     flag value (Req 8.3 — the fallback is forced while the index is not fully
 *     populated); and
 *   - return `'scoped'` ONLY when the flag is ON AND the backfill has completed
 *     (Req 8.2).
 *
 * The `{ flagEnabled, backfillCompleted }` input space is just four boolean
 * combinations, so the property both drives them exhaustively (a table) and
 * probes them with fast-check over arbitrary booleans (≥ 100 iterations) against
 * an independent oracle. The real, exported `decideListingMode` is exercised
 * directly (no mocking, no I/O).
 */

import * as fc from 'fast-check';

import { decideListingMode, type ListingMode } from '../deviceAdminService';

/** Independent oracle: scoped iff BOTH flag on AND backfill complete. */
function expectedMode(flagEnabled: boolean, backfillCompleted: boolean): ListingMode {
  return flagEnabled && backfillCompleted ? 'scoped' : 'fallback';
}

describe('decideListingMode — Property 8: incomplete backfill forces the fallback', () => {
  it('matches the oracle over arbitrary { flagEnabled, backfillCompleted } (property)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (flagEnabled, backfillCompleted) => {
        expect(decideListingMode({ flagEnabled, backfillCompleted })).toBe(
          expectedMode(flagEnabled, backfillCompleted)
        );
      }),
      { numRuns: 200, verbose: false }
    );
  });

  it('scoped is chosen ONLY when the flag is on AND the backfill has completed (property)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (flagEnabled, backfillCompleted) => {
        const scoped = decideListingMode({ flagEnabled, backfillCompleted }) === 'scoped';
        // scoped ⇒ (flag on AND completed), and (flag on AND completed) ⇒ scoped.
        expect(scoped).toBe(flagEnabled && backfillCompleted);
      }),
      { numRuns: 200, verbose: false }
    );
  });

  // Exhaustive truth table for the four combinations (Req 8.1, 8.2, 8.3).
  const cases: Array<{ flagEnabled: boolean; backfillCompleted: boolean; expected: ListingMode }> = [
    { flagEnabled: false, backfillCompleted: false, expected: 'fallback' }, // flag off (8.1)
    { flagEnabled: false, backfillCompleted: true, expected: 'fallback' }, // flag off (8.1)
    { flagEnabled: true, backfillCompleted: false, expected: 'fallback' }, // incomplete (8.3)
    { flagEnabled: true, backfillCompleted: true, expected: 'scoped' }, // both true (8.2)
  ];

  it.each(cases)(
    'flag=$flagEnabled, backfillCompleted=$backfillCompleted → $expected',
    ({ flagEnabled, backfillCompleted, expected }) => {
      expect(decideListingMode({ flagEnabled, backfillCompleted })).toBe(expected);
    }
  );

  it('an incomplete backfill forces the fallback for BOTH flag values (Req 8.3)', () => {
    expect(decideListingMode({ flagEnabled: true, backfillCompleted: false })).toBe('fallback');
    expect(decideListingMode({ flagEnabled: false, backfillCompleted: false })).toBe('fallback');
  });
});
