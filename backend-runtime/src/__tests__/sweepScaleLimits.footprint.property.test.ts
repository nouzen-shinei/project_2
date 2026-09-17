// Feature: storage-sweep-scale-hardening, Property 9: The footprint estimate never under-estimates, and the start-up refusal matches its predicate
/**
 * Property 9: The footprint estimate never under-estimates, and the start-up
 * refusal matches its predicate
 *
 * *For any* reference count — including `0`, negative, non-integral, `NaN`,
 * `Infinity` and values above the ceiling — `estimateRetainSetFootprintBytes`
 * returns a finite non-negative number, is monotone non-decreasing, is `0` at `0`
 * and for every unusable input, and is **at least**
 * `count * (RETAIN_PATH_STRING_BYTES + RETAIN_SET_ENTRY_BYTES)`.
 *
 * *For any* ceiling and *any* heap limit, `decideReferenceCeilingHeadroom` returns
 * `ok: false` **exactly** when the estimate exceeds `fraction * heapLimitBytes` or
 * the limit is not a finite positive number.
 *
 * **Validates: Requirements 8.4, 8.5, 8.6**
 *
 * ── The direction that matters ───────────────────────────────────────────────
 *
 * The never-under-estimate half is the load-bearing one: an estimate below the
 * true cost passes a check the process cannot survive, which is an exit 137 in
 * place of the documented `reference_cap_exceeded` abort. Exactly-at-the-guard is
 * generated explicitly, with fractions that are exact in binary so the boundary is
 * *on* the guard rather than one rounding away from it, because an inverted
 * comparison hides there and nowhere else.
 *
 * ── The Heap_Guard_Floor does not appear in this predicate, and its ABSENCE is
 *    asserted ────────────────────────────────────────────────────────────────
 *
 * The `small-limit region` arm generates ceilings whose estimate is *below*
 * 128 MiB against limits small enough that the estimate still exceeds
 * `0.7 × limit` — the region where a floor term would flip the verdict — and
 * requires the decision to still be `ok: false`. Req 8.6 compares an *estimate*;
 * the Heap_Guard_Floor qualifies a used-heap *measurement* (Property 10). The same
 * arm asserts `exceedsHeapGuard` does **not** trip on those same two numbers, so
 * the disagreement between the two predicates is a generated fact rather than a
 * comment, and a later edit that "harmonises" them fails here.
 *
 * ── Monotonicity is stated over the usable domain, deliberately ──────────────
 *
 * The estimate cannot be monotone over the whole of `number` while also being
 * total in the safe direction: the totality rule sends `1.5` to `0` while `1` maps
 * to `232`. So monotonicity is generated over the non-negative integers — the
 * domain on which the estimate is an estimate — and totality covers the rest.
 * Both halves are asserted; neither is weakened to accommodate the other.
 *
 * ── What this file deliberately does NOT assert ──────────────────────────────
 *
 * Property 9's remaining clause — that a refusing decision leaves Firebase
 * uninitialised and performs no read — is a claim about the *runner*, and nothing
 * imports this module yet (task 1 is pure by design). That clause lands with the
 * runner wiring in task 8 rather than being asserted vacuously here against a call
 * site that does not exist.
 *
 * ── No vacuous arms (Req 11.26) ──────────────────────────────────────────────
 *
 * No precondition below is established by catching an exception; every one of
 * these functions is total. Each arm the generators can select is counted and
 * asserted non-zero after `fc.assert` returns.
 *
 * _Requirements: 11.3, 11.4, 11.5_
 */
import * as fc from 'fast-check';

import {
  DEFAULT_HEAP_GUARD_FRACTION,
  HEAP_GUARD_FLOOR_BYTES,
  RETAIN_PATH_STRING_BYTES,
  RETAIN_SET_BYTES_PER_PATH,
  RETAIN_SET_ENTRY_BYTES,
  decideReferenceCeilingHeadroom,
  estimateRetainSetFootprintBytes,
  exceedsHeapGuard,
  heapGuardBytes,
} from '../lib/sweepScaleLimits';

/** The retain set alone costs at least this much per path. */
const LOWER_BOUND_PER_PATH = RETAIN_PATH_STRING_BYTES + RETAIN_SET_ENTRY_BYTES;

/** `[-10, 5e6]` as the design's table asks, plus every unusable shape. */
const countArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: -10, max: 5_000_000 }) },
  { weight: 2, arbitrary: fc.constantFrom(NaN, Infinity, -Infinity) },
  {
    weight: 2,
    arbitrary: fc
      .double({ min: -10, max: 5_000_000, noNaN: true, noDefaultInfinity: true })
      .filter((value) => !Number.isInteger(value)),
  },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, 500_000, 2_000_000, -1, 0.5, -0.5) }
);

/** Heap limits including `0`, negatives and `NaN`, as the design's table asks. */
const heapLimitArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 2_000_000_000 }) },
  { weight: 3, arbitrary: fc.constantFrom(0, -1, NaN, Infinity, -Infinity) },
  { weight: 2, arbitrary: fc.constantFrom(1, 25_000_000, 400_000_000, 939_524_096) }
);

/**
 * `undefined` (the production path), exact-in-binary fractions a test can pin a
 * boundary with, and unusable values that must fall back to `0.7`.
 */
const fractionArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant(undefined) },
  { weight: 3, arbitrary: fc.constantFrom(0.5, 0.25, 0.7, 0.9) },
  { weight: 2, arbitrary: fc.constantFrom(0, -1, NaN, Infinity) }
);

function resolveFraction(fraction: number | undefined): number {
  return typeof fraction === 'number' && Number.isFinite(fraction) && fraction > 0
    ? fraction
    : DEFAULT_HEAP_GUARD_FRACTION;
}

function limitIsUsable(heapLimitBytes: number): boolean {
  return Number.isFinite(heapLimitBytes) && heapLimitBytes > 0;
}

describe('Property 9: the footprint estimate and the start-up refusal', () => {
  it('is total, non-negative and never under-estimates the retain set', () => {
    const arms = { usable: 0, unusable: 0 };

    fc.assert(
      fc.property(countArb, (count) => {
        const estimate = estimateRetainSetFootprintBytes(count);

        // Total in the safe direction: never `NaN`, never negative, always finite
        // for every count a ceiling could plausibly name.
        expect(Number.isNaN(estimate)).toBe(false);
        expect(Number.isFinite(estimate)).toBe(true);
        expect(estimate).toBeGreaterThanOrEqual(0);

        if (Number.isInteger(count) && count > 0) {
          arms.usable += 1;
          expect(estimate).toBe(count * RETAIN_SET_BYTES_PER_PATH);
          // The half that matters: at least the retain set's own cost.
          expect(estimate).toBeGreaterThanOrEqual(count * LOWER_BOUND_PER_PATH);
        } else {
          // `0` at `0`, and `0` for every unusable input — never `NaN`, because a
          // `NaN` comparison reads as "proceed".
          arms.unusable += 1;
          expect(estimate).toBe(0);
        }
      }),
      { numRuns: 100 }
    );

    expect(arms.usable).toBeGreaterThan(0);
    expect(arms.unusable).toBeGreaterThan(0);
  });

  it('is monotone non-decreasing over the non-negative integers', () => {
    let pairs = 0;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          pairs += 1;
          expect(estimateRetainSetFootprintBytes(lo)).toBeLessThanOrEqual(
            estimateRetainSetFootprintBytes(hi)
          );
        }
      ),
      { numRuns: 100 }
    );
    expect(pairs).toBeGreaterThan(0);
  });

  it('refuses EXACTLY when the estimate exceeds the guard or the limit is unreadable', () => {
    const arms = { accepted: 0, refusedEstimate: 0, refusedUnreadable: 0, invalidFraction: 0 };

    fc.assert(
      fc.property(countArb, heapLimitArb, fractionArb, (maxReferences, heapLimitBytes, fraction) => {
        const decision = decideReferenceCeilingHeadroom({ maxReferences, heapLimitBytes, fraction });

        const estimateBytes = estimateRetainSetFootprintBytes(maxReferences);
        const usable = limitIsUsable(heapLimitBytes);
        const guardBytes = usable ? resolveFraction(fraction) * heapLimitBytes : 0;
        if (fraction !== undefined && resolveFraction(fraction) === DEFAULT_HEAP_GUARD_FRACTION && fraction !== 0.7) {
          arms.invalidFraction += 1;
        }

        // The predicate, stated as a biconditional rather than as two one-way
        // checks: `ok: false` exactly when the estimate exceeds the guard or the
        // limit is unreadable, and `ok: true` in every other case.
        expect(decision.ok).toBe(usable && !(estimateBytes > guardBytes));

        // All three numbers travel on both branches, so the runner's log line and
        // the report's `params` state what was compared, not only the verdict.
        expect(decision.estimateBytes).toBe(estimateBytes);
        expect(decision.guardBytes).toBe(guardBytes);
        expect(Object.is(decision.heapLimitBytes, heapLimitBytes)).toBe(true);
        expect(decision.guardBytes).toBe(heapGuardBytes(heapLimitBytes, fraction));

        if (decision.ok) {
          arms.accepted += 1;
          return;
        }
        if (usable) {
          arms.refusedEstimate += 1;
          expect(decision.reason).toBe('estimate_exceeds_guard');
        } else {
          // An unreadable limit REFUSES rather than proceeding: a limit we cannot
          // read is a limit we cannot check against.
          arms.refusedUnreadable += 1;
          expect(decision.reason).toBe('heap_limit_unreadable');
          expect(decision.guardBytes).toBe(0);
        }
      }),
      { numRuns: 100 }
    );

    expect(arms.accepted).toBeGreaterThan(0);
    expect(arms.refusedEstimate).toBeGreaterThan(0);
    expect(arms.refusedUnreadable).toBeGreaterThan(0);
    expect(arms.invalidFraction).toBeGreaterThan(0);
  });

  /**
   * Exactly-at-the-guard, generated explicitly. `>` not `>=`, so a ceiling whose
   * estimate lands precisely on the guard **proceeds**; one byte less of limit
   * refuses. An implementation with the comparison inverted passes every other
   * arm in this file and fails here.
   */
  it('proceeds exactly ON the guard and refuses one byte below it', () => {
    const arms = { boundary: 0 };

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000 }),
        // Exact in binary, so `fraction * (estimate / fraction)` is the estimate
        // itself rather than a value near it.
        fc.constantFrom(0.5, 0.25, 0.125),
        (maxReferences, fraction) => {
          const estimateBytes = estimateRetainSetFootprintBytes(maxReferences);
          const heapLimitBytes = estimateBytes / fraction;
          arms.boundary += 1;

          const onTheGuard = decideReferenceCeilingHeadroom({ maxReferences, heapLimitBytes, fraction });
          expect(onTheGuard.guardBytes).toBe(estimateBytes);
          expect(onTheGuard.ok).toBe(true);

          const belowTheGuard = decideReferenceCeilingHeadroom({
            maxReferences,
            heapLimitBytes: heapLimitBytes - 1,
            fraction,
          });
          expect(belowTheGuard.ok).toBe(false);
          expect(belowTheGuard.ok === false && belowTheGuard.reason).toBe('estimate_exceeds_guard');

          const aboveTheGuard = decideReferenceCeilingHeadroom({
            maxReferences,
            heapLimitBytes: heapLimitBytes + 1,
            fraction,
          });
          expect(aboveTheGuard.ok).toBe(true);
        }
      ),
      { numRuns: 100 }
    );

    expect(arms.boundary).toBeGreaterThan(0);
  });

  /**
   * ── THE ARM THAT PINS THE ABSENCE OF A FLOOR TERM (Req 8.6) ───────────────
   *
   * Ceilings whose estimate is *beneath* the 128 MiB Heap_Guard_Floor, against
   * limits small enough that the estimate still exceeds `0.7 × limit`. That is
   * exactly the region where a floor term would flip the verdict, so the refusal
   * asserted here is what a "harmonising" edit breaks.
   *
   * The same two numbers are also pushed through `exceedsHeapGuard`, which must
   * **not** trip on them — the estimate predicate and the measurement predicate
   * disagree on purpose, and this makes that disagreement a generated fact.
   */
  it('refuses a sub-128-MiB estimate against a small limit, where a floor term would not', () => {
    const arms = { smallLimit: 0 };

    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 500_000 })
          .chain((maxReferences) => {
            const estimateBytes = maxReferences * RETAIN_SET_BYTES_PER_PATH;
            // Every limit in this range satisfies `0.7 * limit < estimate`.
            const limitMax = Math.max(1, Math.floor(estimateBytes / DEFAULT_HEAP_GUARD_FRACTION) - 1);
            return fc.tuple(
              fc.constant(maxReferences),
              fc.integer({ min: 1, max: limitMax })
            );
          }),
        ([maxReferences, heapLimitBytes]) => {
          const decision = decideReferenceCeilingHeadroom({ maxReferences, heapLimitBytes });

          // We are genuinely in the region the clause is about.
          expect(decision.estimateBytes).toBeLessThan(HEAP_GUARD_FLOOR_BYTES);
          expect(decision.estimateBytes).toBeGreaterThan(decision.guardBytes);
          arms.smallLimit += 1;

          // Req 8.6: it refuses, floor or no floor.
          expect(decision.ok).toBe(false);
          expect(decision.ok === false && decision.reason).toBe('estimate_exceeds_guard');

          // And the MEASUREMENT predicate does not trip on the same two numbers,
          // because the reading is beneath the floor (Reqs 8.8, 8.18).
          expect(exceedsHeapGuard(decision.estimateBytes, heapLimitBytes)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );

    expect(arms.smallLimit).toBeGreaterThan(0);
  });
});
