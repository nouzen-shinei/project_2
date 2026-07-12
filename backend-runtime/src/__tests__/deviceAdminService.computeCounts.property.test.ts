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

import { computeCounts, type DeviceAdminRecord } from '../deviceAdminService';

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

/**
 * A device-like record carrying only the fields `computeCounts` reads. Both
 * keys are optional (`requiredKeys: []`) so some generated devices omit
 * last-seen data entirely, in addition to the explicit null/undefined/invalid
 * values inside the field generators above.
 */
const deviceArb: fc.Arbitrary<Pick<DeviceAdminRecord, 'lastSeen' | 'lastSeenMs'>> = fc.record(
  {
    lastSeen: lastSeenArb,
    lastSeenMs: lastSeenMsArb,
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
});
