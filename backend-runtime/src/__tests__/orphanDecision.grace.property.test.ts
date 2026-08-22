// Feature: storage-orphan-cleanup, Property 5: Grace-period respect
/**
 * Property 5: Grace-period respect
 *
 * For any `nowMs`, any `graceDays > 0` and any object whose `lastTouchedMs`
 * satisfies `nowMs - lastTouchedMs < graceDays * DAY_MS`, the disposition is
 * `retain`, regardless of the retain set. Equivalently: no object younger than
 * the grace period is ever a candidate.
 *
 * `lastTouchedMs` is `max(timeCreated, updated)`, so a GCS overwrite — which is
 * what an `upload-idempotency` retry performs on a deterministic path — re-enters
 * the window rather than inheriting the first write's age. And `graceCutoffMs` is
 * computed **once per run**, so for a run spanning hours the verdict on an object
 * does not depend on when in the run it was reached.
 *
 * **Validates: Requirements 1.4, 2.1, 2.5**
 *
 * ---------------------------------------------------------------------------
 * The load-bearing half of this file is the **injected-cutoff invariant**, which
 * is asserted three ways because it is what stops a multi-hour run from
 * re-judging objects it has already retained:
 *
 *   1. `decideObjectDisposition` reads **no clock at all**. Asserted by counting
 *      `Date.now()` calls and `new Date()` constructions during the call, not by
 *      inspecting the source — so a clock read added later fails the test
 *      wherever it is hidden.
 *   2. A verdict is a function of the **injected** `graceCutoffMs` alone: two
 *      different `(nowMs, graceDays)` pairs that compute the same cutoff produce
 *      the identical verdict.
 *   3. The invariant has teeth: for a drifting cutoff there EXIST objects whose
 *      verdict would flip mid-run, so injecting one cutoff per run is what
 *      prevents it rather than being a stylistic choice.
 *
 * Note the boundary. Property 5 constrains ages strictly BELOW the grace period;
 * at exactly `graceDays * DAY_MS` the comparison in the module is strict
 * (`lastTouchedMs < graceCutoffMs`), matching the documented strictness of
 * `isStaleForPrune` in `jobs/offlineDevicePrune.ts`, so the object is retained.
 * Only an age strictly greater than the grace period can report.
 *
 * _Requirements: 18.2, 18.3, 18.4_
 */
import * as fc from 'fast-check';

import { DAY_MS, computeGraceCutoffMs, decideObjectDisposition } from '../lib/orphanDecision';
import type { DecisionContext, ObjectDisposition, ObjectFacts } from '../lib/orphanDecision';
import { QUARANTINE_PREFIX, STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';

const TENANT = 'acme';

// ---------------------------------------------------------------------------
// Generators.
//
// `nowMs` is kept far enough above the epoch that `nowMs - 365 days` is still a
// non-negative — i.e. usable — timestamp, so an age generated near the top of the
// range does not accidentally test the `age_unknown` branch instead of the grace
// branch.
// ---------------------------------------------------------------------------
const nowMsArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(Date.parse('2026-04-01T00:00:00Z'), Date.parse('2024-01-01T00:00:00Z')) },
  { weight: 7, arbitrary: fc.integer({ min: 400 * DAY_MS, max: 4_000_000_000_000 }) },
);

const graceDaysArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(1, 7, 30, 365) },
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 365 }) },
);

/** In-scope paths, so the grace branch is actually reached. */
const inScopePathArb = fc
  .tuple(
    fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
    fc.constantFrom(
      'object.bin',
      'fee_77/k_beefbeefbeefbeefbeef_march.pdf',
      'c_9f2a/k_3b1c9d0e5f7a2b4c6d8e_clip_h264.mp4',
      'audio/notice_audio_k_dead0dead0dead0dead0.m4a',
      '0123456789abcdef0123.jpg',
      'holiday photo.jpg',
    ),
  )
  .map(([category, remainder]) => `${category}/${TENANT}/${remainder}`);

/** Every path shape, in scope or not — the property holds "regardless". */
const anyPathArb = fc.oneof(
  { weight: 6, arbitrary: inScopePathArb },
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'receipts/other/fee_4/k_dddd_d.pdf',
      'receipts/acme-2/x.pdf',
      'invoices/acme/march.pdf',
      `${QUARANTINE_PREFIX}/acme/sweep_1/receipts/acme/x.pdf`,
      'receipts/acme',
      '',
      '../../etc/passwd',
    ),
  },
);

/**
 * Retain sets that sometimes contain the path under test and sometimes do not —
 * "regardless of the retain set" is part of the property statement, so the set is
 * varied rather than fixed at empty.
 */
function retainSets(objectPath: string): ReadonlySet<string>[] {
  return [
    new Set<string>(),
    new Set([objectPath]),
    new Set(['receipts/acme/fee_1/k_aaaa_a.pdf', 'notices/acme/other.png']),
    new Set([objectPath, 'receipts/acme/fee_1/k_aaaa_a.pdf']),
  ];
}

/** A `(graceDays, ageMs)` pair with the age strictly INSIDE the grace window. */
const youngCaseArb = graceDaysArb.chain((graceDays) =>
  fc.record({
    graceDays: fc.constant(graceDays),
    ageMs: fc.oneof(
      // Strictly inside, including 0 (just written) and one ms short of the edge.
      { weight: 6, arbitrary: fc.integer({ min: 0, max: graceDays * DAY_MS - 1 }) },
      { weight: 2, arbitrary: fc.constantFrom(0, 1, graceDays * DAY_MS - 1) },
      // A clock-skewed object, "touched" in the future: even younger than young.
      { weight: 2, arbitrary: fc.integer({ min: -400 * DAY_MS, max: -1 }) },
    ),
  }),
);

/** A `(graceDays, ageMs)` pair with the age strictly OUTSIDE the grace window. */
const oldCaseArb = graceDaysArb.chain((graceDays) =>
  fc.record({
    graceDays: fc.constant(graceDays),
    ageMs: fc.oneof(
      { weight: 6, arbitrary: fc.integer({ min: graceDays * DAY_MS + 1, max: 366 * DAY_MS }) },
      { weight: 4, arbitrary: fc.constantFrom(graceDays * DAY_MS + 1, graceDays * DAY_MS + 1000, 366 * DAY_MS) },
    ),
  }),
);

// ---------------------------------------------------------------------------
// A clock watcher.
//
// Counting reads is a stronger assertion than comparing verdicts across two wall
// clocks: it fails for ANY clock read, including one whose effect happens to be
// invisible for the generated input. The window is exactly the one call — every
// `expect` runs after `Date` has been restored, because jest's own matchers read
// the clock.
// ---------------------------------------------------------------------------
function decideWatchingTheClock(
  facts: ObjectFacts,
  context: DecisionContext,
): { disposition: ObjectDisposition; clockReads: number } {
  const RealDate = globalThis.Date;
  let clockReads = 0;

  const watched = new Proxy(RealDate, {
    construct(target, args) {
      // `new Date()` with no arguments is a clock read; `new Date(ms)` is not.
      if (args.length === 0) clockReads += 1;
      return Reflect.construct(target as ObjectConstructor, args);
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
    return { disposition: decideObjectDisposition(facts, context), clockReads };
  } finally {
    globalThis.Date = RealDate;
  }
}

describe('Property 5: Grace-period respect', () => {
  // -------------------------------------------------------------------------
  // No young object is ever reported.
  // -------------------------------------------------------------------------
  it('never reports an object younger than the grace period, whatever the retain set', () => {
    const reasons = new Set<string>();

    fc.assert(
      fc.property(
        nowMsArb,
        youngCaseArb,
        anyPathArb,
        fc.integer({ min: 0, max: 3 }),
        (nowMs, { graceDays, ageMs }, objectPath, retainSetIndex) => {
          const graceCutoffMs = computeGraceCutoffMs(nowMs, graceDays);
          const lastTouchedMs = nowMs - ageMs;

          // The precondition, restated exactly as Property 5 words it.
          expect(nowMs - lastTouchedMs).toBeLessThan(graceDays * DAY_MS);

          const retainPaths = retainSets(objectPath)[retainSetIndex];

          const disposition = decideObjectDisposition(
            { objectPath, lastTouchedMs, bytes: 1024 },
            { tenantId: TENANT, retainPaths, graceCutoffMs },
          );

          expect(disposition.action).toBe('retain');
          reasons.add(disposition.reason);
        },
      ),
      { numRuns: 400 },
    );

    // Non-vacuity: the corpus reached the grace branch itself, not only the
    // scope and reference branches that retain for other reasons.
    expect(reasons.has('within_grace')).toBe(true);
  });

  it('retains a young in-scope unreferenced object specifically as within_grace', () => {
    fc.assert(
      fc.property(nowMsArb, youngCaseArb, inScopePathArb, (nowMs, { graceDays, ageMs }, objectPath) => {
        const disposition = decideObjectDisposition(
          { objectPath, lastTouchedMs: nowMs - ageMs, bytes: 1 },
          { tenantId: TENANT, retainPaths: new Set(), graceCutoffMs: computeGraceCutoffMs(nowMs, graceDays) },
        );
        expect(disposition).toEqual({ action: 'retain', reason: 'within_grace' });
      }),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // The boundary, and the other direction.
  // -------------------------------------------------------------------------
  it('retains at exactly graceDays * DAY_MS and reports only strictly beyond it', () => {
    fc.assert(
      fc.property(nowMsArb, graceDaysArb, inScopePathArb, (nowMs, graceDays, objectPath) => {
        const graceCutoffMs = computeGraceCutoffMs(nowMs, graceDays);
        const context: DecisionContext = { tenantId: TENANT, retainPaths: new Set(), graceCutoffMs };
        const at = (ageMs: number): ObjectDisposition =>
          decideObjectDisposition({ objectPath, lastTouchedMs: nowMs - ageMs, bytes: 1 }, context);

        const graceMs = graceDays * DAY_MS;
        // One ms younger than the window: retained.
        expect(at(graceMs - 1)).toEqual({ action: 'retain', reason: 'within_grace' });
        // Exactly at the window: retained, because the comparison is strict.
        expect(at(graceMs)).toEqual({ action: 'retain', reason: 'within_grace' });
        // One ms older: the first reportable age.
        expect(at(graceMs + 1)).toEqual({ action: 'report', reason: 'unreferenced' });
      }),
      { numRuns: 300 },
    );
  });

  it('reports an old in-scope unreferenced object, and retains the identical object once referenced', () => {
    fc.assert(
      fc.property(nowMsArb, oldCaseArb, inScopePathArb, (nowMs, { graceDays, ageMs }, objectPath) => {
        const graceCutoffMs = computeGraceCutoffMs(nowMs, graceDays);
        const lastTouchedMs = nowMs - ageMs;
        const facts: ObjectFacts = { objectPath, lastTouchedMs, bytes: 1 };

        expect(nowMs - lastTouchedMs).toBeGreaterThan(graceDays * DAY_MS);

        expect(
          decideObjectDisposition(facts, { tenantId: TENANT, retainPaths: new Set(), graceCutoffMs }),
        ).toEqual({ action: 'report', reason: 'unreferenced' });

        // The grace window is not the only thing standing between an object and a
        // report: a reference still overrides age entirely.
        expect(
          decideObjectDisposition(facts, {
            tenantId: TENANT,
            retainPaths: new Set([objectPath]),
            graceCutoffMs,
          }),
        ).toEqual({ action: 'retain', reason: 'referenced' });
      }),
      { numRuns: 300 },
    );
  });

  it('lowering graceDays can only ever expose more objects, never fewer', () => {
    // Monotonicity in the grace period: a longer window retains everything a
    // shorter one retains. This is why a mis-configured LOW `graceDays` is the
    // dangerous direction, and why the runner refuses a non-positive value.
    fc.assert(
      fc.property(
        nowMsArb,
        graceDaysArb,
        graceDaysArb,
        inScopePathArb,
        fc.integer({ min: 0, max: 400 * DAY_MS }),
        (nowMs, a, b, objectPath, ageMs) => {
          const shorter = Math.min(a, b);
          const longer = Math.max(a, b);
          const facts: ObjectFacts = { objectPath, lastTouchedMs: nowMs - ageMs, bytes: 1 };
          const decide = (graceDays: number): ObjectDisposition =>
            decideObjectDisposition(facts, {
              tenantId: TENANT,
              retainPaths: new Set(),
              graceCutoffMs: computeGraceCutoffMs(nowMs, graceDays),
            });

          if (decide(longer).action === 'report') {
            expect(decide(shorter).action).toBe('report');
          }
          if (decide(shorter).action === 'retain') {
            expect(decide(longer).action).toBe('retain');
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // The injected-cutoff invariant.
  // -------------------------------------------------------------------------
  it('reads no clock: a verdict comes from the injected graceCutoffMs alone', () => {
    fc.assert(
      fc.property(
        nowMsArb,
        graceDaysArb,
        anyPathArb,
        fc.oneof(
          fc.integer({ min: -400 * DAY_MS, max: 400 * DAY_MS }),
          fc.constantFrom(0, 1, -1),
        ),
        (nowMs, graceDays, objectPath, ageMs) => {
          const facts: ObjectFacts = { objectPath, lastTouchedMs: nowMs - ageMs, bytes: 1 };
          const context: DecisionContext = {
            tenantId: TENANT,
            retainPaths: new Set(),
            graceCutoffMs: computeGraceCutoffMs(nowMs, graceDays),
          };

          const watched = decideWatchingTheClock(facts, context);
          // Zero clock reads. Were the function to consult `Date.now()` instead
          // of the injected cutoff, a run spanning hours would re-judge objects
          // it had already retained.
          expect(watched.clockReads).toBe(0);
          // And the verdict is the ordinary one, so the watcher did not change
          // what was measured.
          expect(watched.disposition).toEqual(decideObjectDisposition(facts, context));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('depends on the cutoff alone: different (nowMs, graceDays) pairs with one cutoff agree', () => {
    fc.assert(
      fc.property(
        nowMsArb,
        graceDaysArb,
        graceDaysArb,
        anyPathArb,
        fc.integer({ min: -400 * DAY_MS, max: 400 * DAY_MS }),
        (nowMs, graceDaysA, graceDaysB, objectPath, ageMs) => {
          const graceCutoffMs = computeGraceCutoffMs(nowMs, graceDaysA);
          // A different `nowMs` and a different `graceDays` computing the SAME
          // cutoff — which is the only time input the function has.
          const otherNowMs = graceCutoffMs + graceDaysB * DAY_MS;
          expect(computeGraceCutoffMs(otherNowMs, graceDaysB)).toBe(graceCutoffMs);

          const facts: ObjectFacts = { objectPath, lastTouchedMs: nowMs - ageMs, bytes: 1 };
          const first = decideObjectDisposition(facts, {
            tenantId: TENANT,
            retainPaths: new Set(),
            graceCutoffMs,
          });
          const second = decideObjectDisposition(facts, {
            tenantId: TENANT,
            retainPaths: new Set(),
            graceCutoffMs: computeGraceCutoffMs(otherNowMs, graceDaysB),
          });
          expect(second).toEqual(first);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('gives one cutoff the same verdict for every object however long the run takes', () => {
    // The run-level claim, asserted on the pure function: a fixed cutoff applied
    // to a batch of objects reached at different wall-clock instants produces one
    // partition. And the counter-factual — recomputing the cutoff as the run
    // progresses — is shown to flip a verdict, so the injection is load-bearing
    // rather than decorative.
    fc.assert(
      fc.property(
        nowMsArb,
        graceDaysArb,
        inScopePathArb,
        fc.integer({ min: 1, max: 12 * 60 * 60 * 1000 }), // up to a 12-hour run
        (runStartMs, graceDays, objectPath, driftMs) => {
          const runCutoffMs = computeGraceCutoffMs(runStartMs, graceDays);
          const context: DecisionContext = {
            tenantId: TENANT,
            retainPaths: new Set(),
            graceCutoffMs: runCutoffMs,
          };

          // An object sitting between the run's cutoff and where the cutoff would
          // have drifted to. It is INSIDE the grace window as the run measures it.
          const lastTouchedMs = runCutoffMs + Math.floor(driftMs / 2);
          const facts: ObjectFacts = { objectPath, lastTouchedMs, bytes: 1 };

          // Reached at the start of the run, and again hours later: one verdict.
          expect(decideObjectDisposition(facts, context)).toEqual({
            action: 'retain',
            reason: 'within_grace',
          });
          expect(decideObjectDisposition(facts, { ...context })).toEqual({
            action: 'retain',
            reason: 'within_grace',
          });

          // Had the cutoff been recomputed from a later clock, the identical
          // object would have been reported instead. That is the drift the
          // injected cutoff exists to prevent.
          if (driftMs >= 2) {
            const driftedCutoffMs = computeGraceCutoffMs(runStartMs + driftMs, graceDays);
            expect(driftedCutoffMs).toBeGreaterThan(lastTouchedMs);
            expect(
              decideObjectDisposition(facts, { ...context, graceCutoffMs: driftedCutoffMs }),
            ).toEqual({ action: 'report', reason: 'unreferenced' });
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // `lastTouchedMs = max(timeCreated, updated)`.
  // -------------------------------------------------------------------------
  it('re-enters the window on an overwrite, because lastTouchedMs is the max of the two timestamps', () => {
    // The `max` itself is computed by the sweep when it builds `ObjectFacts`
    // (task 6.2); what is asserted here is the consequence the definition exists
    // for: an ancient `timeCreated` cannot drag a freshly overwritten object out
    // of the grace window. An `upload-idempotency` retry overwrites a
    // deterministic path, and GCS gives the new generation a fresh timestamp.
    fc.assert(
      fc.property(
        nowMsArb,
        graceDaysArb,
        inScopePathArb,
        fc.integer({ min: 0, max: 400 * DAY_MS }),
        youngCaseArb,
        (nowMs, graceDays, objectPath, createdAgeMs, young) => {
          const timeCreatedMs = nowMs - createdAgeMs;
          const updatedMs = nowMs - Math.min(young.ageMs, graceDays * DAY_MS - 1);
          const lastTouchedMs = Math.max(timeCreatedMs, updatedMs);

          expect(
            decideObjectDisposition(
              { objectPath, lastTouchedMs, bytes: 1 },
              {
                tenantId: TENANT,
                retainPaths: new Set(),
                graceCutoffMs: computeGraceCutoffMs(nowMs, graceDays),
              },
            ),
          ).toEqual({ action: 'retain', reason: 'within_grace' });

          // Taking the MINIMUM instead would have reported a recently written
          // object whenever its creation was old enough — the false positive the
          // definition rules out.
          const minimum = Math.min(timeCreatedMs, updatedMs);
          if (nowMs - minimum > graceDays * DAY_MS) {
            expect(
              decideObjectDisposition(
                { objectPath, lastTouchedMs: minimum, bytes: 1 },
                {
                  tenantId: TENANT,
                  retainPaths: new Set(),
                  graceCutoffMs: computeGraceCutoffMs(nowMs, graceDays),
                },
              ),
            ).toEqual({ action: 'report', reason: 'unreferenced' });
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // -------------------------------------------------------------------------
  // `computeGraceCutoffMs` itself.
  // -------------------------------------------------------------------------
  it('computes the cutoff as exactly nowMs - graceDays * DAY_MS', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        fc.oneof(graceDaysArb, fc.constantFrom(0.5, 1.5, 0, -1, 3650)),
        (nowMs, graceDays) => {
          const cutoff = computeGraceCutoffMs(nowMs, graceDays);
          expect(cutoff).toBe(nowMs - graceDays * DAY_MS);
          if (graceDays > 0) {
            expect(cutoff).toBeLessThan(nowMs);
            expect(nowMs - cutoff).toBe(graceDays * DAY_MS);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is strictly decreasing in graceDays and strictly increasing in nowMs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4_000_000_000_000 }),
        graceDaysArb,
        graceDaysArb,
        fc.integer({ min: 1, max: 10 * DAY_MS }),
        (nowMs, a, b, delta) => {
          if (a < b) {
            expect(computeGraceCutoffMs(nowMs, b)).toBeLessThan(computeGraceCutoffMs(nowMs, a));
          }
          expect(computeGraceCutoffMs(nowMs + delta, a)).toBeGreaterThan(computeGraceCutoffMs(nowMs, a));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('gives a young object the same verdict under every retain set the collector can build', () => {
    fc.assert(
      fc.property(nowMsArb, youngCaseArb, inScopePathArb, (nowMs, { graceDays, ageMs }, objectPath) => {
        const facts: ObjectFacts = { objectPath, lastTouchedMs: nowMs - ageMs, bytes: 1 };
        const graceCutoffMs = computeGraceCutoffMs(nowMs, graceDays);
        for (const retainPaths of retainSets(objectPath)) {
          const disposition = decideObjectDisposition(facts, {
            tenantId: TENANT,
            retainPaths,
            graceCutoffMs,
          });
          expect(disposition.action).toBe('retain');
          // Only the REASON varies with the retain set; the action does not.
          expect(disposition.reason).toBe(retainPaths.has(objectPath) ? 'referenced' : 'within_grace');
        }
      }),
      { numRuns: 200 },
    );
  });
});
