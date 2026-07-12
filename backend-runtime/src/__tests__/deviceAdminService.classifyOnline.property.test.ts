// Feature: device-console-migration, Property 1: Online classification uses the 300-second window

/**
 * Property 1: Online classification uses the 300-second window
 * Validates: Requirements 1.6
 *
 * For any last-seen timestamp `lastSeenMs` and current time `nowMs`, the Device
 * Console classifies a device as online iff `nowMs - lastSeenMs <= 300000ms`
 * (the default 300-second / 5-minute window), and offline otherwise. A custom
 * `windowMs` argument, when supplied, is honored in place of the default, and a
 * non-finite last-seen value (e.g. `NaN`) is treated as offline.
 *
 * This test drives the real `classifyOnline` helper exported from
 * `deviceAdminService.ts` against an independent boolean oracle, so it exercises
 * production behavior rather than a re-interpretation of it.
 */

import * as fc from 'fast-check';

import {
  classifyOnline,
  DEFAULT_ONLINE_WINDOW_MS,
} from '../deviceAdminService';

// The window under test (Requirement 1.6): 300 seconds expressed in ms.
const WINDOW_MS = 300_000;

// Sanity-check that the module's exported default matches the requirement so a
// future change to the constant is caught here as well.
describe('classifyOnline — default window constant', () => {
  it('defaults to the 300-second (300000 ms) console window', () => {
    expect(DEFAULT_ONLINE_WINDOW_MS).toBe(WINDOW_MS);
  });
});

describe('Property 1 — online classification uses the 300-second window', () => {
  it(
    'is online iff (now - lastSeen) <= 300000 for arbitrary integer timestamps (property)',
    () => {
      fc.assert(
        fc.property(
          // Wide integer range covers both now >= lastSeen and now < lastSeen.
          fc.integer({ min: -8_640_000_000, max: 8_640_000_000 }),
          fc.integer({ min: -8_640_000_000, max: 8_640_000_000 }),
          (lastSeenMs, nowMs) => {
            const expected = nowMs - lastSeenMs <= WINDOW_MS;
            expect(classifyOnline(lastSeenMs, nowMs)).toBe(expected);
          }
        ),
        { numRuns: 300 }
      );
    }
  );

  it(
    'holds around the 300000 ms boundary (delta clustered on the edge) (property)',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -8_640_000_000, max: 8_640_000_000 }),
          // Deltas concentrated on the boundary plus a spread on either side,
          // including negative deltas where now < lastSeen.
          fc.oneof(
            fc.integer({ min: WINDOW_MS - 5, max: WINDOW_MS + 5 }),
            fc.integer({ min: -10, max: 10 }),
            fc.integer({ min: -1_000_000, max: 1_000_000 })
          ),
          (lastSeenMs, delta) => {
            const nowMs = lastSeenMs + delta;
            const expected = delta <= WINDOW_MS;
            expect(classifyOnline(lastSeenMs, nowMs)).toBe(expected);
          }
        ),
        { numRuns: 300 }
      );
    }
  );

  it('classifies the exact 299999/300000/300001 ms boundary correctly', () => {
    const base = 1_700_000_000_000; // arbitrary fixed epoch-ms reference
    expect(classifyOnline(base, base + (WINDOW_MS - 1))).toBe(true); // 299999 ms → online
    expect(classifyOnline(base, base + WINDOW_MS)).toBe(true); //        300000 ms → online (inclusive)
    expect(classifyOnline(base, base + (WINDOW_MS + 1))).toBe(false); // 300001 ms → offline
  });

  it(
    'honors a custom windowMs argument in place of the default (property)',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -8_640_000_000, max: 8_640_000_000 }),
          fc.integer({ min: -8_640_000_000, max: 8_640_000_000 }),
          // Arbitrary non-negative custom windows, including 0.
          fc.integer({ min: 0, max: 10_000_000 }),
          (lastSeenMs, nowMs, windowMs) => {
            const expected = nowMs - lastSeenMs <= windowMs;
            expect(classifyOnline(lastSeenMs, nowMs, windowMs)).toBe(expected);
          }
        ),
        { numRuns: 200 }
      );
    }
  );

  it(
    'treats a non-finite last-seen (NaN) as offline for any now/window (property)',
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -8_640_000_000, max: 8_640_000_000 }),
          fc.integer({ min: 0, max: 10_000_000 }),
          (nowMs, windowMs) => {
            expect(classifyOnline(Number.NaN, nowMs)).toBe(false);
            expect(classifyOnline(Number.NaN, nowMs, windowMs)).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    }
  );

  it('treats other non-finite last-seen values (±Infinity) as offline', () => {
    const now = 1_700_000_000_000;
    expect(classifyOnline(Number.POSITIVE_INFINITY, now)).toBe(false);
    expect(classifyOnline(Number.NEGATIVE_INFINITY, now)).toBe(false);
  });
});
