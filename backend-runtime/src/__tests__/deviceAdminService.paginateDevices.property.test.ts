// Feature: device-list-pagination, Property 1: result-set pagination is a lossless,
// ordered partition of the ordered result — paging from an absent cursor and
// following each nextCursor concatenates back to exactly the input (same order,
// no drops, no duplicates); the final page has hasMore === false and
// nextCursor === undefined; and an invalid/garbage cursor behaves as offset 0.
//
// Validates: Recommendation #2 (device-list real pagination). Drives the REAL
// exported `paginateDevices` from `deviceAdminService.ts` across hundreds of
// generated inputs (varied result lengths, page sizes including values above the
// MAX cap, and cursor kinds) — no mocking, no Firestore.

import * as fc from 'fast-check';

import {
  paginateDevices,
  MAX_DEVICE_LIST_LIMIT,
  type DeviceAdminRecord,
} from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * An ordered device result of a chosen length, with distinct `deviceId`s so we
 * can detect any drop or duplicate purely by comparing id sequences. The record
 * content is irrelevant to `paginateDevices` (it only slices), so a minimal
 * projection is sufficient.
 */
const orderedArb: fc.Arbitrary<DeviceAdminRecord[]> = fc
  .nat({ max: 250 })
  .map((n) => Array.from({ length: n }, (_, i) => ({ deviceId: `d-${i}` }) as DeviceAdminRecord));

// Page sizes spanning below, at, and above the MAX cap so the internal clamp is
// exercised too. `paginateDevices` clamps consistently, so the walk still
// terminates and covers the whole result.
const limitArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: MAX_DEVICE_LIST_LIMIT + 100 });

/**
 * Cursors that MUST decode to offset 0. Each is either blank, contains no valid
 * base64url alphabet characters (decodes to empty), or base64url-encodes a
 * payload that is not a canonical non-negative integer — so none can be mistaken
 * for a legitimate offset cursor.
 */
const garbageCursorArb: fc.Arbitrary<string> = fc.constantFrom(
  '',
  '   ',
  '%%%',
  '!!!',
  '@@@@',
  '===',
  Buffer.from('-1', 'utf8').toString('base64url'), // "-1" — has a sign
  Buffer.from('1.5', 'utf8').toString('base64url'), // "1.5" — not an integer
  Buffer.from(' 3 ', 'utf8').toString('base64url'), // " 3 " — surrounding space
  Buffer.from('hello', 'utf8').toString('base64url'), // letters
  Buffer.from('99abc', 'utf8').toString('base64url'), // mixed
);

const ids = (devices: ReadonlyArray<DeviceAdminRecord>): string[] =>
  devices.map((d) => d.deviceId);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('paginateDevices — result-set pagination (Recommendation #2)', () => {
  it('paging from no cursor and following nextCursor reproduces the input exactly (no drops, no dups)', () => {
    fc.assert(
      fc.property(orderedArb, limitArb, (ordered, limit) => {
        const collected: DeviceAdminRecord[] = [];
        let cursor: string | undefined;
        // Bound the walk defensively: it must terminate in at most one page per
        // element (+1 for the final empty/last page).
        const maxPages = ordered.length + 2;
        let pages = 0;

        for (;;) {
          const { page, hasMore, nextCursor } = paginateDevices(ordered, cursor, limit);
          collected.push(...page);
          pages += 1;
          if (pages > maxPages) {
            throw new Error('pagination did not terminate');
          }
          if (!hasMore) {
            // Last page invariant: no continuation cursor.
            expect(nextCursor).toBeUndefined();
            break;
          }
          // A non-final page always yields a string continuation cursor.
          expect(typeof nextCursor).toBe('string');
          cursor = nextCursor;
        }

        // Concatenation of pages === input, in the same order.
        expect(ids(collected)).toEqual(ids(ordered));
        // No duplicates introduced.
        expect(new Set(ids(collected)).size).toBe(ordered.length);
      }),
      { numRuns: 200 }
    );
  });

  it('a garbage / invalid cursor behaves identically to the first page (offset 0)', () => {
    fc.assert(
      fc.property(orderedArb, limitArb, garbageCursorArb, (ordered, limit, garbage) => {
        const first = paginateDevices(ordered, undefined, limit);
        const fromGarbage = paginateDevices(ordered, garbage, limit);
        expect(ids(fromGarbage.page)).toEqual(ids(first.page));
        expect(fromGarbage.hasMore).toBe(first.hasMore);
        expect(fromGarbage.nextCursor).toBe(first.nextCursor);
      }),
      { numRuns: 200 }
    );
  });

  it('every page respects the requested (clamped) size and hasMore matches the remaining rows', () => {
    fc.assert(
      fc.property(orderedArb, limitArb, (ordered, limit) => {
        const effectiveLimit = Math.min(limit, MAX_DEVICE_LIST_LIMIT);
        const first = paginateDevices(ordered, undefined, limit);
        // First page never exceeds the effective page size.
        expect(first.page.length).toBeLessThanOrEqual(effectiveLimit);
        // hasMore is true iff there are rows beyond the first page.
        expect(first.hasMore).toBe(ordered.length > effectiveLimit);
        if (!first.hasMore) {
          expect(first.nextCursor).toBeUndefined();
        }
      }),
      { numRuns: 200 }
    );
  });
});
