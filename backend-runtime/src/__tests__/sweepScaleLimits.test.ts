/**
 * Feature: storage-sweep-scale-hardening — task 1.3 unit tests for both scale
 * decisions in `src/lib/sweepScaleLimits.ts`.
 *
 * Pure jest: no Firebase, no Express, no bucket, no harness and no clock — the
 * same posture as `orphanDecision.test.ts`, which is the whole point of putting
 * these two decisions in a module that imports nothing (Req 11.17).
 *
 * Three groups of cases here are not "coverage" and must not be simplified away:
 *
 *  1. **The arithmetic that justifies `HEAP_GUARD_FLOOR_BYTES`** is asserted
 *     rather than left in prose, so an edit to that constant or to
 *     `RETAIN_SET_BYTES_PER_PATH` which invalidates the justification fails here
 *     rather than in production.
 *  2. **The deliberate disagreement between the two heap predicates.** One pair
 *     of numbers (a 20 MB estimate against a 25 MB declared limit) makes the
 *     start-up check refuse while the mid-collection guard does not trip. That
 *     case exists so that "harmonising" the two predicates fails loudly; the
 *     estimate predicate has no floor term on purpose (Req 8.6) and the
 *     measurement predicate requires one on purpose (Reqs 8.8, 8.18).
 *  3. **The threshold's five bad values, one assertion each.** Zero is the
 *     dangerous resolution, so `0`, `-1`, `0.5`, `NaN` and `Infinity` each get
 *     their own case rather than one representative (Reqs 7.20, 7.21).
 *
 * _Requirements: 7.16, 7.18, 7.19, 7.20, 7.21, 8.17, 8.18, 11.15_
 */
import {
  DEFAULT_HEAP_GUARD_FRACTION,
  DEFAULT_QUARANTINE_WRITE_THRESHOLD,
  DEFAULT_REPORT_WRITE_PAGE_INTERVAL,
  DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS,
  HEAP_GUARD_FLOOR_BYTES,
  HEAP_GUARD_SAMPLE_INTERVAL,
  RETAIN_PATH_STRING_BYTES,
  RETAIN_SET_BYTES_PER_PATH,
  RETAIN_SET_ENTRY_BYTES,
  RETAIN_SET_SNAPSHOT_BYTES,
  decideReferenceCeilingHeadroom,
  estimateRetainSetFootprintBytes,
  exceedsHeapGuard,
  heapGuardBytes,
  shouldWriteTenantReport,
} from '../lib/sweepScaleLimits';
import type { ReportWriteEvent, ReportWriteState } from '../lib/sweepScaleLimits';

const MIB = 1024 * 1024;

/**
 * The reference ceiling this spec makes the default (Req 8.1). It lives in the
 * runner rather than in the pure module, and task 8 lands it there; it is named
 * here because the floor's justification is stated *against* it.
 */
const DEFAULT_MAX_REFERENCES = 500_000;

/**
 * The per-tenant Quarantine ceiling that
 * `infra/cloud-run/storage-orphan-sweep-job-dev.yaml` documents for a first
 * cautious Apply_Mode run — `STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT=25`,
 * both in that file's header runbook and in the comment on the variable itself.
 * The **dev definition is the only one of the two Cloud Run Job definitions that
 * documents such a run**: the prod definition sets the ceiling to `1000` and
 * describes no cautious first run, and both files set the variable itself to
 * `"1000"`, so the 25 is the override the cautious run applies rather than a
 * configured value in either file.
 *
 * Task 8.4 asserts this equality from the dev manifest's side by reading the file; the
 * assertion below states it from the constant's side, so the two cannot drift
 * apart silently. The equality is the entire reason the threshold is 25: that
 * run then writes the Report_Document **once at the end of its moves** rather
 * than 25 times.
 */
const FIRST_CAUTIOUS_APPLY_CEILING = 25;

const idleState: ReportWriteState = { pagesSinceWrite: 0, msSinceWrite: 0, movedSinceWrite: 0 };
const quietEvent: ReportWriteEvent = { prefixCompleted: false, terminal: false };

function state(partial: Partial<ReportWriteState>): ReportWriteState {
  return { ...idleState, ...partial };
}

// ---------------------------------------------------------------------------
// The constants, and the arithmetic behind them.
// ---------------------------------------------------------------------------
describe('the per-path footprint constants', () => {
  it('are the four documented values', () => {
    expect(RETAIN_PATH_STRING_BYTES).toBe(120);
    expect(RETAIN_SET_ENTRY_BYTES).toBe(48);
    expect(RETAIN_SET_SNAPSHOT_BYTES).toBe(16);
    expect(RETAIN_SET_BYTES_PER_PATH).toBe(232);
  });

  it('sum to RETAIN_SET_BYTES_PER_PATH with derivedPaths charged a SECOND full entry', () => {
    // The second `RETAIN_SET_ENTRY_BYTES` is `derivedPaths`, charged per path even
    // though it holds a strict subset. Asserting the sum rather than trusting the
    // literal is what stops an edit to one term leaving the total stale.
    expect(RETAIN_SET_BYTES_PER_PATH).toBe(
      RETAIN_PATH_STRING_BYTES + 2 * RETAIN_SET_ENTRY_BYTES + RETAIN_SET_SNAPSHOT_BYTES
    );
  });

  it('fixes the guard fraction at 0.7 and the sample interval at 10,000', () => {
    expect(DEFAULT_HEAP_GUARD_FRACTION).toBe(0.7);
    expect(HEAP_GUARD_SAMPLE_INTERVAL).toBe(10_000);
  });
});

describe('HEAP_GUARD_FLOOR_BYTES', () => {
  it('is exactly 134,217,728 bytes, which is 128 MiB', () => {
    expect(HEAP_GUARD_FLOOR_BYTES).toBe(134_217_728);
    expect(HEAP_GUARD_FLOOR_BYTES).toBe(128 * MIB);
  });

  /**
   * The number is fixed by the estimator's own arithmetic rather than picked, and
   * this is that arithmetic: the floor in retained paths must exceed the retained
   * path count the default ceiling implies. Only then can "a reading beneath the
   * floor is not a Retain_Set that outgrew the default ceiling" be true — which
   * is the sole failure the mid-collection guard exists to catch.
   */
  it('is more retained paths than the 500,000 default ceiling implies', () => {
    const pathsAtTheFloor = HEAP_GUARD_FLOOR_BYTES / RETAIN_SET_BYTES_PER_PATH;
    expect(pathsAtTheFloor).toBeGreaterThan(DEFAULT_MAX_REFERENCES);
    // ≈ 578,000, as the design states.
    expect(Math.round(pathsAtTheFloor)).toBe(578_525);
    // The same claim from the other side: the whole Retain_Set at the default
    // ceiling estimates to LESS than the floor, so the floor masks it entirely.
    expect(estimateRetainSetFootprintBytes(DEFAULT_MAX_REFERENCES)).toBeLessThan(
      HEAP_GUARD_FLOOR_BYTES
    );
  });
});

// ---------------------------------------------------------------------------
// `estimateRetainSetFootprintBytes`.
// ---------------------------------------------------------------------------
describe('estimateRetainSetFootprintBytes', () => {
  it('is count * 232 for a usable count', () => {
    expect(estimateRetainSetFootprintBytes(0)).toBe(0);
    expect(estimateRetainSetFootprintBytes(1)).toBe(232);
    expect(estimateRetainSetFootprintBytes(500_000)).toBe(116_000_000);
    expect(estimateRetainSetFootprintBytes(2_000_000)).toBe(464_000_000);
  });

  /**
   * `0`, never `NaN`. A `NaN` comparison is `false`, which reads as "the estimate
   * does not exceed the guard" — i.e. proceed — and proceeding is the wrong
   * direction for an input we could not read.
   */
  it('yields 0 rather than NaN for every unusable count', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, -0.5, 0.5, 1.5]) {
      expect(estimateRetainSetFootprintBytes(bad)).toBe(0);
      expect(Number.isNaN(estimateRetainSetFootprintBytes(bad))).toBe(false);
    }
  });

  it('never under-estimates the retain set alone', () => {
    for (const count of [1, 10, 1_000, 500_000, 2_000_000]) {
      expect(estimateRetainSetFootprintBytes(count)).toBeGreaterThanOrEqual(
        count * (RETAIN_PATH_STRING_BYTES + RETAIN_SET_ENTRY_BYTES)
      );
    }
  });
});

// ---------------------------------------------------------------------------
// `heapGuardBytes`.
// ---------------------------------------------------------------------------
describe('heapGuardBytes', () => {
  it('is the fraction of a usable limit', () => {
    expect(heapGuardBytes(1_000_000_000)).toBeCloseTo(700_000_000, 0);
    // An explicit fraction of a power of two is exact, which is what lets the
    // boundary cases below sit ON the guard rather than near it.
    expect(heapGuardBytes(1_000_000_000, 0.5)).toBe(500_000_000);
  });

  it('is 0 for every unusable limit — which refuses at start-up', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(heapGuardBytes(bad)).toBe(0);
    }
  });

  it('falls back to the default fraction for an unusable fraction', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(heapGuardBytes(1_000_000_000, bad)).toBe(heapGuardBytes(1_000_000_000));
    }
  });
});

// ---------------------------------------------------------------------------
// `exceedsHeapGuard` — all four boundaries the two conditions create.
//
// Every comparison in the module is `>`, so a reading exactly AT either threshold
// proceeds (Req 8.18). An inverted comparison passes every non-boundary case,
// which is why all four are named individually.
// ---------------------------------------------------------------------------
describe('exceedsHeapGuard', () => {
  // A limit whose fraction is far ABOVE the floor: the fraction binds.
  const fractionBindingLimit = 1_000_000_000;
  const fractionGuard = heapGuardBytes(fractionBindingLimit);
  // A limit whose fraction is far BENEATH the floor: the floor binds.
  const floorBindingLimit = 100_000_000;

  it('boundary 1: exactly at 0.7 x limit with a used heap above the floor PROCEEDS', () => {
    expect(fractionGuard).toBeGreaterThan(HEAP_GUARD_FLOOR_BYTES);
    expect(exceedsHeapGuard(fractionGuard, fractionBindingLimit)).toBe(false);
  });

  it('boundary 2: one byte above both REFUSES', () => {
    // With the fraction binding.
    expect(exceedsHeapGuard(fractionGuard + 1, fractionBindingLimit)).toBe(true);
    // And with the floor binding, which is the same boundary from the other side.
    expect(heapGuardBytes(floorBindingLimit)).toBeLessThan(HEAP_GUARD_FLOOR_BYTES);
    expect(exceedsHeapGuard(HEAP_GUARD_FLOOR_BYTES + 1, floorBindingLimit)).toBe(true);
  });

  it('boundary 3: exactly at the floor with a used heap above the fraction PROCEEDS', () => {
    expect(HEAP_GUARD_FLOOR_BYTES).toBeGreaterThan(heapGuardBytes(floorBindingLimit));
    expect(exceedsHeapGuard(HEAP_GUARD_FLOOR_BYTES, floorBindingLimit)).toBe(false);
  });

  it('boundary 4: one byte above the floor but beneath the fraction PROCEEDS', () => {
    expect(HEAP_GUARD_FLOOR_BYTES + 1).toBeLessThan(fractionGuard);
    expect(exceedsHeapGuard(HEAP_GUARD_FLOOR_BYTES + 1, fractionBindingLimit)).toBe(false);
  });

  /**
   * The two cases the floor exists for. A fraction-only implementation fails
   * exactly these two and passes everything else, which is why they are named
   * individually rather than folded into a table.
   */
  it('does not trip on the degenerate reading: used = 1 of a 1-byte limit', () => {
    expect(1).toBeGreaterThan(DEFAULT_HEAP_GUARD_FRACTION * 1); // a fraction-only guard trips
    expect(exceedsHeapGuard(1, 1)).toBe(false);
  });

  it('does not trip at 100 MiB used of a 120 MiB limit', () => {
    const used = 100 * MIB;
    const limit = 120 * MIB;
    expect(used).toBeGreaterThan(heapGuardBytes(limit)); // above the fraction
    expect(used).toBeLessThan(HEAP_GUARD_FLOOR_BYTES); // beneath the floor
    expect(exceedsHeapGuard(used, limit)).toBe(false);
  });

  it('trips when both conditions genuinely hold', () => {
    const used = 200 * MIB;
    const limit = 256 * MIB;
    expect(used).toBeGreaterThan(HEAP_GUARD_FLOOR_BYTES);
    expect(used).toBeGreaterThan(heapGuardBytes(limit));
    expect(exceedsHeapGuard(used, limit)).toBe(true);
  });

  it('takes floorBytes only so a test can drive the boundary', () => {
    // Guard 50, floor 4: above the floor, beneath the fraction ⇒ proceeds.
    expect(exceedsHeapGuard(10, 100, 0.5, 4)).toBe(false);
    // Above both ⇒ refuses. No environment variable reaches this parameter.
    expect(exceedsHeapGuard(60, 100, 0.5, 4)).toBe(true);
  });

  it('does not trip on an unusable limit or an unusable reading', () => {
    for (const badLimit of [0, -1, NaN, Infinity, -Infinity]) {
      expect(exceedsHeapGuard(1_000_000_000, badLimit)).toBe(false);
    }
    for (const badUsed of [NaN, Infinity, -Infinity]) {
      expect(exceedsHeapGuard(badUsed, fractionBindingLimit)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// `decideReferenceCeilingHeadroom` — the design's ceiling table, plus the row
// that pins the ABSENCE of a floor term.
// ---------------------------------------------------------------------------
describe('decideReferenceCeilingHeadroom', () => {
  /** A `512Mi` container with a declared ~400 MB old-space limit. */
  const DECLARED_512MI = 400_000_000;
  /** The `1Gi` container this spec moves to, declaring `--max-old-space-size=896`. */
  const DECLARED_1GI = 896 * MIB;

  it('REFUSES the shipped default against the shipped container', () => {
    // The row that is the whole point of the mechanism: the pre-flight check,
    // run against the shipped container, refuses the shipped default.
    const decision = decideReferenceCeilingHeadroom({
      maxReferences: 2_000_000,
      heapLimitBytes: DECLARED_512MI,
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toBe('estimate_exceeds_guard');
    expect(decision.estimateBytes).toBe(464_000_000);
    expect(decision.guardBytes).toBeCloseTo(280_000_000, 0);
    expect(decision.heapLimitBytes).toBe(DECLARED_512MI);
  });

  it('passes 2,000,000 against the 1Gi container', () => {
    const decision = decideReferenceCeilingHeadroom({
      maxReferences: 2_000_000,
      heapLimitBytes: DECLARED_1GI,
    });
    expect(decision.ok).toBe(true);
    expect(decision.estimateBytes).toBe(464_000_000);
  });

  it('passes the 500,000 default against the 1Gi container with headroom to spare', () => {
    const decision = decideReferenceCeilingHeadroom({
      maxReferences: DEFAULT_MAX_REFERENCES,
      heapLimitBytes: DECLARED_1GI,
    });
    expect(decision.ok).toBe(true);
    expect(decision.estimateBytes).toBe(116_000_000);
    expect(decision.guardBytes / decision.estimateBytes).toBeGreaterThan(5);
  });

  it('REFUSES an unreadable limit rather than proceeding', () => {
    // A limit we cannot read is a limit we cannot check against, and the failure
    // this exists to prevent is precisely the one that looks like a successful
    // start.
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      const decision = decideReferenceCeilingHeadroom({
        maxReferences: DEFAULT_MAX_REFERENCES,
        heapLimitBytes: bad,
      });
      expect(decision.ok).toBe(false);
      expect(decision.ok === false && decision.reason).toBe('heap_limit_unreadable');
      expect(decision.guardBytes).toBe(0);
      // All three numbers travel on the refusing branch too, including the
      // unusable reading itself: the log line's job is to show what was reported.
      expect(decision.estimateBytes).toBe(116_000_000);
      expect(Object.is(decision.heapLimitBytes, bad)).toBe(true);
    }
  });

  it('proceeds when the estimate sits EXACTLY on the guard', () => {
    // `>` not `>=`. Constructed with an exact fraction so the boundary is exact
    // rather than one rounding away from it.
    const estimateBytes = estimateRetainSetFootprintBytes(100_000);
    const decision = decideReferenceCeilingHeadroom({
      maxReferences: 100_000,
      heapLimitBytes: estimateBytes * 2,
      fraction: 0.5,
    });
    expect(decision.guardBytes).toBe(estimateBytes);
    expect(decision.ok).toBe(true);
    // One byte less of limit and it refuses.
    expect(
      decideReferenceCeilingHeadroom({
        maxReferences: 100_000,
        heapLimitBytes: estimateBytes * 2 - 1,
        fraction: 0.5,
      }).ok
    ).toBe(false);
  });

  /**
   * ── THE ROW THAT PINS THE ASYMMETRY (Req 8.6) ─────────────────────────────
   *
   * A ceiling whose estimate is 20 MB against a 25 MB declared limit **refuses**,
   * even though 20 MB is far beneath the 128 MiB Heap_Guard_Floor. The start-up
   * predicate compares an ESTIMATE and has no floor term; the mid-collection
   * predicate compares a MEASUREMENT and requires one. This case asserts both
   * verdicts on the SAME two numbers, so a later "harmonisation" of the two
   * fails here rather than in production: adding a floor to the start-up check
   * would flip this refusal into a pass, which is the exact failure Req 8.6
   * exists to catch.
   */
  it('REFUSES a 20 MB estimate against a 25 MB limit — no floor term here', () => {
    const maxReferences = 86_207; // 20,000,024 bytes ≈ 20 MB
    const heapLimitBytes = 25_000_000;
    const decision = decideReferenceCeilingHeadroom({ maxReferences, heapLimitBytes });

    expect(decision.estimateBytes).toBeLessThan(HEAP_GUARD_FLOOR_BYTES);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toBe('estimate_exceeds_guard');

    // The same numbers through the MEASUREMENT predicate: no trip, because the
    // reading is beneath the floor. The two predicates disagree on purpose.
    expect(exceedsHeapGuard(decision.estimateBytes, heapLimitBytes)).toBe(false);
  });

  it('carries the estimate the estimator produces, not its own arithmetic', () => {
    for (const maxReferences of [0, 1, NaN, -1, 0.5, DEFAULT_MAX_REFERENCES]) {
      const decision = decideReferenceCeilingHeadroom({ maxReferences, heapLimitBytes: DECLARED_1GI });
      expect(decision.estimateBytes).toBe(estimateRetainSetFootprintBytes(maxReferences));
    }
  });
});

// ---------------------------------------------------------------------------
// `shouldWriteTenantReport`.
// ---------------------------------------------------------------------------
describe('DEFAULT_QUARANTINE_WRITE_THRESHOLD', () => {
  it('is exactly 25 objects, equal to the first cautious apply run ceiling', () => {
    expect(DEFAULT_QUARANTINE_WRITE_THRESHOLD).toBe(25);
    expect(DEFAULT_QUARANTINE_WRITE_THRESHOLD).toBe(FIRST_CAUTIOUS_APPLY_CEILING);
  });

  it('sits beside the two documented intervals', () => {
    expect(DEFAULT_REPORT_WRITE_PAGE_INTERVAL).toBe(10);
    expect(DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS).toBe(30_000);
  });
});

describe('shouldWriteTenantReport: the three forcing conditions in isolation', () => {
  it('writes when the moved-object count reaches the threshold (Req 7.3)', () => {
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 25 }), quietEvent)).toBe(true);
  });

  it('writes when a Managed_Category prefix completes (Req 7.4)', () => {
    expect(shouldWriteTenantReport(idleState, { prefixCompleted: true, terminal: false })).toBe(true);
  });

  it('writes on a terminal event (Req 7.5)', () => {
    expect(shouldWriteTenantReport(idleState, { prefixCompleted: false, terminal: true })).toBe(true);
  });

  it('does not write when none of the five causes holds', () => {
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 24 }), quietEvent)).toBe(false);
  });
});

describe('shouldWriteTenantReport: the two intervals at their boundaries', () => {
  it('applies the page interval at the boundary and one either side', () => {
    expect(shouldWriteTenantReport(state({ pagesSinceWrite: 9 }), quietEvent)).toBe(false);
    expect(shouldWriteTenantReport(state({ pagesSinceWrite: 10 }), quietEvent)).toBe(true);
    expect(shouldWriteTenantReport(state({ pagesSinceWrite: 11 }), quietEvent)).toBe(true);
  });

  it('applies the time interval at the boundary and one either side', () => {
    expect(shouldWriteTenantReport(state({ msSinceWrite: 29_999 }), quietEvent)).toBe(false);
    expect(shouldWriteTenantReport(state({ msSinceWrite: 30_000 }), quietEvent)).toBe(true);
    expect(shouldWriteTenantReport(state({ msSinceWrite: 30_001 }), quietEvent)).toBe(true);
  });

  it('honours configured intervals at their boundaries', () => {
    const intervals = { pageInterval: 3, timeIntervalMs: 500 };
    expect(shouldWriteTenantReport(state({ pagesSinceWrite: 2 }), quietEvent, intervals)).toBe(false);
    expect(shouldWriteTenantReport(state({ pagesSinceWrite: 3 }), quietEvent, intervals)).toBe(true);
    expect(shouldWriteTenantReport(state({ msSinceWrite: 499 }), quietEvent, intervals)).toBe(false);
    expect(shouldWriteTenantReport(state({ msSinceWrite: 500 }), quietEvent, intervals)).toBe(true);
  });

  it('falls back to each interval default for an unusable configured value (Req 7.12)', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(shouldWriteTenantReport(state({ pagesSinceWrite: 9 }), quietEvent, { pageInterval: bad })).toBe(
        false
      );
      expect(
        shouldWriteTenantReport(state({ pagesSinceWrite: 10 }), quietEvent, { pageInterval: bad })
      ).toBe(true);
      expect(
        shouldWriteTenantReport(state({ msSinceWrite: 29_999 }), quietEvent, { timeIntervalMs: bad })
      ).toBe(false);
      expect(
        shouldWriteTenantReport(state({ msSinceWrite: 30_000 }), quietEvent, { timeIntervalMs: bad })
      ).toBe(true);
    }
  });
});

describe('shouldWriteTenantReport: the threshold at T - 1, T and T + 1', () => {
  it('at the default threshold of 25', () => {
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 24 }), quietEvent)).toBe(false);
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 25 }), quietEvent)).toBe(true);
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 26 }), quietEvent)).toBe(true);
  });

  it('at a configured threshold of 4', () => {
    const intervals = { quarantineThreshold: 4 };
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 3 }), quietEvent, intervals)).toBe(false);
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 4 }), quietEvent, intervals)).toBe(true);
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 5 }), quietEvent, intervals)).toBe(true);
  });

  it('truncates a fractional threshold above one rather than rejecting it', () => {
    // `4.7` counts whole objects, so it reads as 4 — which is a resolution, not a
    // fallback. Only a truncation to ZERO falls back (below).
    const intervals = { quarantineThreshold: 4.7 };
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 3 }), quietEvent, intervals)).toBe(false);
    expect(shouldWriteTenantReport(state({ movedSinceWrite: 4 }), quietEvent, intervals)).toBe(true);
  });

  /**
   * ── Zero is the dangerous resolution, so each bad value gets its own case ──
   *
   * Reqs 7.20 and 7.21: `0`, `-1`, `0.5`, `NaN` and `Infinity` each resolve to
   * `25` and never to zero. A resolved zero stops the threshold bounding the lag
   * between the persisted `quarantinedCount` and the objects actually moved,
   * which reopens the per-tenant ceiling breach Req 7.3 closes — under a
   * scheduler that still reads as though it closed it.
   */
  it.each([0, -1, 0.5, NaN, Infinity])(
    'resolves a configured threshold of %p to the default of 25, never to zero',
    (bad) => {
      const intervals = { quarantineThreshold: bad };
      // Resolved to zero, EVERY state would write on account of a move; resolved
      // to 25, these two states pin the default's boundary exactly.
      expect(shouldWriteTenantReport(state({ movedSinceWrite: 0 }), quietEvent, intervals)).toBe(false);
      expect(shouldWriteTenantReport(state({ movedSinceWrite: 24 }), quietEvent, intervals)).toBe(false);
      expect(shouldWriteTenantReport(state({ movedSinceWrite: 25 }), quietEvent, intervals)).toBe(true);
    }
  );

  it('normalises an unusable moved count to 0 — the type is the real guard', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, 0.5, 1.5]) {
      expect(shouldWriteTenantReport(state({ movedSinceWrite: bad }), quietEvent)).toBe(false);
    }
  });
});

/**
 * Req 7.18's closure, stated as a unit case: with no forcing condition met and
 * neither interval reached, the answer is `false` on **every** page. This is what
 * catches a fourth, undocumented forcing condition — which would satisfy both
 * interval bounds and the count bound while writing more often than any rule in
 * this design permits.
 */
describe('shouldWriteTenantReport: the closed list of five causes (Req 7.18)', () => {
  it('returns false on every page of a sub-interval, no-forcing sequence', () => {
    const intervals = { pageInterval: 10, timeIntervalMs: 30_000, quarantineThreshold: 25 };
    let moved = 0;
    let ms = 0;
    for (let page = 1; page <= 9; page += 1) {
      moved += 2; // 18 moves total, short of the threshold
      ms += 3_000; // 27,000 ms total, short of the interval
      expect(
        shouldWriteTenantReport(
          { pagesSinceWrite: page, msSinceWrite: ms, movedSinceWrite: moved },
          quietEvent,
          intervals
        )
      ).toBe(false);
    }
    // And the tenth page reaches the upper bound, which is the interval doing its
    // job rather than a sixth cause.
    expect(
      shouldWriteTenantReport(
        { pagesSinceWrite: 10, msSinceWrite: ms, movedSinceWrite: moved },
        quietEvent,
        intervals
      )
    ).toBe(true);
  });
});

/**
 * Monotone in all three dimensions. An inverted comparison in any one of them
 * passes every isolated forcing case above, which is why this is asserted as its
 * own case rather than inferred.
 */
describe('shouldWriteTenantReport: monotonicity in all three dimensions', () => {
  const intervals = { pageInterval: 5, timeIntervalMs: 1_000, quarantineThreshold: 6 };

  it('more elapsed pages can only turn false into true', () => {
    for (let pages = 0; pages < 12; pages += 1) {
      const before = shouldWriteTenantReport(state({ pagesSinceWrite: pages }), quietEvent, intervals);
      const after = shouldWriteTenantReport(state({ pagesSinceWrite: pages + 1 }), quietEvent, intervals);
      if (before) expect(after).toBe(true);
    }
  });

  it('more elapsed milliseconds can only turn false into true', () => {
    for (const ms of [0, 1, 500, 999, 1_000, 1_001, 5_000]) {
      const before = shouldWriteTenantReport(state({ msSinceWrite: ms }), quietEvent, intervals);
      const after = shouldWriteTenantReport(state({ msSinceWrite: ms + 1 }), quietEvent, intervals);
      if (before) expect(after).toBe(true);
    }
  });

  it('more moved objects can only turn false into true', () => {
    for (let moved = 0; moved < 12; moved += 1) {
      const before = shouldWriteTenantReport(state({ movedSinceWrite: moved }), quietEvent, intervals);
      const after = shouldWriteTenantReport(state({ movedSinceWrite: moved + 1 }), quietEvent, intervals);
      if (before) expect(after).toBe(true);
    }
  });
});

/**
 * Req 11.17, asserted rather than reviewed. The elapsed milliseconds are an
 * INPUT: `config.nowMs` is frozen for the whole run so a multi-hour sweep cannot
 * have its Grace_Cutoff drift underneath it, and a future edit that reached into
 * this module for a live clock would silently break the parent spec's Property 5.
 *
 * Counting reads is stronger than comparing verdicts across two wall clocks: it
 * fails for ANY clock read, including one whose effect is invisible for the input
 * at hand. The watched window is exactly the one call, because jest's own
 * matchers read the clock.
 */
describe('the module reads no clock', () => {
  function countingClockReads(body: () => void): number {
    const RealDate = globalThis.Date;
    let clockReads = 0;
    const watched = new Proxy(RealDate, {
      construct(target, args) {
        if (args.length === 0) clockReads += 1;
        return Reflect.construct(target as unknown as ObjectConstructor, args);
      },
      get(target, prop, receiver) {
        if (prop === 'now') {
          return () => {
            clockReads += 1;
            return RealDate.now();
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    globalThis.Date = watched as DateConstructor;
    try {
      body();
    } finally {
      globalThis.Date = RealDate;
    }
    return clockReads;
  }

  it('decides the cadence without reading one', () => {
    const reads = countingClockReads(() => {
      shouldWriteTenantReport(state({ pagesSinceWrite: 4, msSinceWrite: 900, movedSinceWrite: 3 }), quietEvent);
    });
    expect(reads).toBe(0);
  });

  it('decides the ceiling headroom without reading one', () => {
    const reads = countingClockReads(() => {
      decideReferenceCeilingHeadroom({ maxReferences: 500_000, heapLimitBytes: 896 * MIB });
      exceedsHeapGuard(200 * MIB, 256 * MIB);
      estimateRetainSetFootprintBytes(1_000);
    });
    expect(reads).toBe(0);
  });
});
