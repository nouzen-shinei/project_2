// Feature: offline-device-prune, Property 1: Staleness predicate — prune iff a resolvable last-seen is strictly before the cutoff

/**
 * Property 1: Staleness predicate is resolvable-last-seen strictly-before-cutoff
 * **Validates: backend offline-device prune — pure staleness decision**
 *
 * *For any* device whose last-seen time is representable (as the numeric
 * `lastSeenMs` companion, an ISO `lastSeen` string, or a Firestore
 * `Timestamp`-like `{toMillis}` / `{toDate}` value) and *any* cutoff, the pure
 * {@link isStaleForPrune} returns `true` IFF the resolved last-seen epoch-ms is
 * strictly less than the cutoff — independent of which representation carries
 * the time. When the last-seen is NOT resolvable (missing / non-finite /
 * unparseable), it returns `false` (such a device is NEVER pruned). The
 * comparison is strict, so a device seen exactly at the cutoff is NOT stale.
 *
 * The test drives the REAL exported `isStaleForPrune` (and the config helpers
 * `clampBatchSize` / `resolveMaxAgeDays` / `computeCutoffMs`) with no mocking.
 */

import * as fc from 'fast-check';

import {
  isStaleForPrune,
  clampBatchSize,
  resolveMaxAgeDays,
  computeCutoffMs,
  DAY_MS,
  DEFAULT_PRUNE_BATCH_SIZE,
  MAX_PRUNE_BATCH_SIZE,
  DEFAULT_PRUNE_MAX_AGE_DAYS,
} from '../jobs/offlineDevicePrune';

// Epoch-ms range that round-trips cleanly through `new Date(ms).toISOString()`
// (integer ms, 1970-01-01 .. ~2100). Both last-seen and cutoff are drawn here.
const MIN_MS = 0;
const MAX_MS = 4_102_444_800_000; // 2100-01-01T00:00:00Z
const msArb = fc.integer({ min: MIN_MS, max: MAX_MS });

type Representation = 'lastSeenMs' | 'lastSeenIso' | 'timestampToMillis' | 'timestampToDate';

const representationArb = fc.constantFrom<Representation>(
  'lastSeenMs',
  'lastSeenIso',
  'timestampToMillis',
  'timestampToDate'
);

/** Build a device doc carrying a resolvable last-seen `ms` in a given shape. */
function deviceWithLastSeen(ms: number, rep: Representation): Record<string, unknown> {
  switch (rep) {
    case 'lastSeenMs':
      return { lastSeenMs: ms };
    case 'lastSeenIso':
      return { lastSeen: new Date(ms).toISOString() };
    case 'timestampToMillis':
      return { lastSeen: { toMillis: () => ms } };
    case 'timestampToDate':
      return { lastSeen: { toDate: () => new Date(ms) } };
  }
}

describe('offline-device prune — config constants', () => {
  it('exposes the documented safe defaults', () => {
    expect(DEFAULT_PRUNE_BATCH_SIZE).toBe(300);
    expect(MAX_PRUNE_BATCH_SIZE).toBe(500);
    expect(DEFAULT_PRUNE_MAX_AGE_DAYS).toBe(14);
    expect(DAY_MS).toBe(86_400_000);
  });
});

describe('Property 1 — isStaleForPrune: prune iff resolvable last-seen < cutoff', () => {
  it('matches (resolvedMs < cutoff) across every last-seen representation (property)', () => {
    fc.assert(
      fc.property(msArb, msArb, representationArb, (lastSeenMs, cutoffMs, rep) => {
        const device = deviceWithLastSeen(lastSeenMs, rep);
        expect(isStaleForPrune(device, cutoffMs)).toBe(lastSeenMs < cutoffMs);
      }),
      { numRuns: 300 }
    );
  });

  it('never prunes a device whose last-seen is unresolvable (property)', () => {
    const unresolvableArb = fc.constantFrom<Record<string, unknown>>(
      {},
      { lastSeen: null },
      { lastSeen: undefined },
      { lastSeenMs: null },
      { lastSeenMs: NaN },
      { lastSeenMs: Infinity },
      { lastSeenMs: -Infinity },
      { lastSeen: '' },
      { lastSeen: '   ' },
      { lastSeen: 'not-a-real-date' },
      { lastSeen: {} },
      { lastSeen: { toMillis: () => NaN } },
      { lastSeen: { toMillis: () => Infinity } },
      { lastSeen: 'device-42' }
    );
    fc.assert(
      fc.property(unresolvableArb, fc.integer(), (device, cutoffMs) => {
        expect(isStaleForPrune(device, cutoffMs)).toBe(false);
      }),
      { numRuns: 200 }
    );
  });

  it('treats a device seen exactly at the cutoff as NOT stale (strict <)', () => {
    fc.assert(
      fc.property(msArb, representationArb, (cutoffMs, rep) => {
        const device = deviceWithLastSeen(cutoffMs, rep);
        expect(isStaleForPrune(device, cutoffMs)).toBe(false);
      }),
      { numRuns: 150 }
    );
  });

  it('prefers a finite numeric lastSeenMs over the lastSeen field (property)', () => {
    fc.assert(
      fc.property(msArb, msArb, fc.integer({ min: MIN_MS, max: MAX_MS }), (numericMs, isoMs, cutoffMs) => {
        // A finite `lastSeenMs` must win even when `lastSeen` disagrees.
        const device = { lastSeenMs: numericMs, lastSeen: new Date(isoMs).toISOString() };
        expect(isStaleForPrune(device, cutoffMs)).toBe(numericMs < cutoffMs);
      }),
      { numRuns: 150 }
    );
  });

  it('example: a 30-day-old device is stale under the 14-day default; a fresh device is not', () => {
    const now = Date.parse('2024-06-01T00:00:00Z');
    const cutoff = computeCutoffMs(now, DEFAULT_PRUNE_MAX_AGE_DAYS);
    const thirtyDaysAgo = now - 30 * DAY_MS;
    const oneHourAgo = now - 60 * 60 * 1000;

    expect(isStaleForPrune({ lastSeenMs: thirtyDaysAgo }, cutoff)).toBe(true);
    expect(isStaleForPrune({ lastSeen: new Date(thirtyDaysAgo).toISOString() }, cutoff)).toBe(true);
    expect(isStaleForPrune({ lastSeen: { toMillis: () => thirtyDaysAgo } }, cutoff)).toBe(true);
    expect(isStaleForPrune({ lastSeenMs: oneHourAgo }, cutoff)).toBe(false);
    expect(isStaleForPrune({}, cutoff)).toBe(false);
  });
});

describe('clampBatchSize — clamps to [1, 500] with a safe default', () => {
  it('is always within [1, 500] for any input (property)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.double(),
          fc.constant(NaN),
          fc.constant(Infinity),
          fc.constant(-Infinity),
          fc.constant(undefined)
        ),
        (value) => {
          const result = clampBatchSize(value as number | undefined);
          expect(result).toBeGreaterThanOrEqual(1);
          expect(result).toBeLessThanOrEqual(MAX_PRUNE_BATCH_SIZE);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('examples: fallback + clamping boundaries', () => {
    expect(clampBatchSize(undefined)).toBe(300);
    expect(clampBatchSize(NaN)).toBe(300);
    expect(clampBatchSize(0)).toBe(300); // non-positive → default, then within range
    expect(clampBatchSize(-10)).toBe(300);
    expect(clampBatchSize(1)).toBe(1);
    expect(clampBatchSize(2.9)).toBe(2); // truncated
    expect(clampBatchSize(300)).toBe(300);
    expect(clampBatchSize(500)).toBe(500);
    expect(clampBatchSize(501)).toBe(500);
    expect(clampBatchSize(100000)).toBe(500);
  });
});

describe('resolveMaxAgeDays — env day threshold parsing', () => {
  it('examples: default fallback + positive parsing + truncation', () => {
    expect(resolveMaxAgeDays(undefined)).toBe(14);
    expect(resolveMaxAgeDays(null)).toBe(14);
    expect(resolveMaxAgeDays('')).toBe(14);
    expect(resolveMaxAgeDays('   ')).toBe(14);
    expect(resolveMaxAgeDays('abc')).toBe(14);
    expect(resolveMaxAgeDays('0')).toBe(14); // non-positive → default
    expect(resolveMaxAgeDays('-5')).toBe(14);
    expect(resolveMaxAgeDays('7')).toBe(7);
    expect(resolveMaxAgeDays('30')).toBe(30);
    expect(resolveMaxAgeDays('3.9')).toBe(3); // truncated
  });

  it('any positive integer string round-trips to itself (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3650 }), (days) => {
        expect(resolveMaxAgeDays(String(days))).toBe(days);
      }),
      { numRuns: 150 }
    );
  });
});

describe('computeCutoffMs — nowMs - days*DAY_MS', () => {
  it('computes the cutoff arithmetically (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: MIN_MS, max: MAX_MS }), fc.integer({ min: 1, max: 3650 }), (now, days) => {
        expect(computeCutoffMs(now, days)).toBe(now - days * DAY_MS);
      }),
      { numRuns: 150 }
    );
  });
});
