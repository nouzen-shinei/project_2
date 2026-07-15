// Feature: device-console-migration, Property 2: Count integrity (online + offline = total)

/**
 * Property 2: Count integrity (online + offline = total)
 * Validates: Requirements 1.3, 1.8
 *
 * For any set of tenant devices and any current time, the counts computed by
 * `computeCounts(devices, nowMs)` satisfy the partition invariant
 * `online + offline === total`, `total === devices.length`, and the empty set
 * yields `{ total: 0, online: 0, offline: 0 }`.
 *
 * This test exercises the real, exported `computeCounts` pure helper from
 * `deviceAdminService.ts` (no mocking, no Firestore) across hundreds of
 * generated device sets whose `lastSeenMs` / `lastSeen` values vary widely —
 * including devices with missing, null, blank, and otherwise-invalid last-seen
 * data — and an arbitrary current time `nowMs`.
 */

import * as fc from 'fast-check';

import { computeCounts, classifyOnline, type DeviceAdminRecord } from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// A broad but realistic epoch-ms range: 1970-01-01 .. ~2100-01-01.
const finiteMsArb = fc.integer({ min: 0, max: 4_102_444_800_000 });

/**
 * `lastSeenMs` companion: a valid finite epoch-ms, or one of the
 * missing/invalid variants the classifier must treat as offline (NaN,
 * ±Infinity, undefined, null).
 */
const lastSeenMsArb = fc.oneof(
  finiteMsArb,
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(undefined),
  fc.constant(null)
);

/**
 * ISO `lastSeen` string: a valid ISO 8601 timestamp, or a missing/invalid
 * variant (unparseable string, blank, whitespace-only, undefined, null).
 */
const lastSeenArb = fc.oneof(
  finiteMsArb.map((ms) => new Date(ms).toISOString()),
  fc.constant('not-a-real-timestamp'),
  fc.constant(''),
  fc.constant('   '),
  fc.constant(undefined),
  fc.constant(null)
);

/** Optional boolean lifecycle flag: true / false / omitted. */
const optionalBoolArb = fc.option(fc.boolean(), { nil: undefined });

/**
 * A device-like record carrying the fields `computeCounts` reads. All keys are
 * optional (`requiredKeys: []`) so some generated devices omit last-seen and
 * lifecycle data entirely, in addition to the explicit null/undefined/invalid
 * values inside the field generators above. `isDeleted` / `isHardBanned` are
 * included so the property exercises the exclusion of deleted/banned devices
 * from the online count.
 */
const deviceArb: fc.Arbitrary<
  Pick<DeviceAdminRecord, 'lastSeen' | 'lastSeenMs' | 'isDeleted' | 'isHardBanned'>
> = fc.record(
  {
    lastSeen: lastSeenArb,
    lastSeenMs: lastSeenMsArb,
    isDeleted: optionalBoolArb,
    isHardBanned: optionalBoolArb,
  },
  { requiredKeys: [] }
);

// Include the empty set (minLength 0) and reasonably large tenant device sets.
const devicesArb = fc.array(deviceArb, { minLength: 0, maxLength: 60 });

/** Arbitrary current time, including non-finite values the helper must tolerate. */
const nowMsArb = fc.oneof(
  finiteMsArb,
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY)
);

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

describe('Property 2 — count integrity (online + offline = total)', () => {
  it(
    'online + offline always equals total, and total equals the device count (property)',
    () => {
      fc.assert(
        fc.property(devicesArb, nowMsArb, (devices, nowMs) => {
          const counts = computeCounts(devices, nowMs);

          // Partition invariant (Requirement 1.3).
          expect(counts.online + counts.offline).toBe(counts.total);
          // Total reflects exactly the input set size.
          expect(counts.total).toBe(devices.length);
          // Neither sub-count can be negative or exceed the total.
          expect(counts.online).toBeGreaterThanOrEqual(0);
          expect(counts.offline).toBeGreaterThanOrEqual(0);
          expect(counts.online).toBeLessThanOrEqual(counts.total);
          expect(counts.offline).toBeLessThanOrEqual(counts.total);

          // A deleted / hard-banned device is never counted online: the online
          // count equals the number of non-deleted, non-banned devices that are
          // within the 300s window (an independent recomputation).
          const expectedOnline = devices.filter(
            (d) =>
              d.isDeleted !== true &&
              d.isHardBanned !== true &&
              classifyOnline(
                typeof d.lastSeenMs === 'number' && Number.isFinite(d.lastSeenMs)
                  ? d.lastSeenMs
                  : typeof d.lastSeen === 'string'
                    ? Date.parse(d.lastSeen)
                    : Number.NaN,
                nowMs
              )
          ).length;
          expect(counts.online).toBe(expectedOnline);
        }),
        { numRuns: 200, verbose: false }
      );
    },
    30_000
  );

  it(
    'the empty set yields { total: 0, online: 0, offline: 0 } for any current time (property)',
    () => {
      fc.assert(
        fc.property(nowMsArb, (nowMs) => {
          expect(computeCounts([], nowMs)).toEqual({ total: 0, online: 0, offline: 0 });
        }),
        { numRuns: 100, verbose: false }
      );
    },
    20_000
  );

  it('a soft-deleted device with a fresh lastSeen is counted offline, not online', () => {
    const nowMs = 1_700_000_000_000;
    const counts = computeCounts(
      [{ lastSeenMs: nowMs, isDeleted: true }], // last-seen "now" but deleted
      nowMs
    );
    expect(counts).toEqual({ total: 1, online: 0, offline: 1 });
  });

  it('a hard-banned device with a fresh lastSeen is counted offline, not online', () => {
    const nowMs = 1_700_000_000_000;
    const counts = computeCounts([{ lastSeenMs: nowMs, isHardBanned: true }], nowMs);
    expect(counts).toEqual({ total: 1, online: 0, offline: 1 });
  });

  it('mixes online, deleted-but-fresh, banned-but-fresh, and stale devices correctly', () => {
    const nowMs = 1_700_000_000_000;
    const counts = computeCounts(
      [
        { lastSeenMs: nowMs }, // online
        { lastSeenMs: nowMs, isDeleted: true }, // fresh but deleted -> offline
        { lastSeenMs: nowMs, isHardBanned: true }, // fresh but banned -> offline
        { lastSeenMs: nowMs - 10 * 60_000 }, // stale -> offline
      ],
      nowMs
    );
    expect(counts).toEqual({ total: 4, online: 1, offline: 3 });
  });
});
