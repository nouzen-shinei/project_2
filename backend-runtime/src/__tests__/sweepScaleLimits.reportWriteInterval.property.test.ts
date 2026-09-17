// Feature: storage-sweep-scale-hardening, Property 7: The write scheduler obeys both intervals in both directions, with a closed exception list
/**
 * Property 7: The write scheduler obeys both intervals in both directions, with a
 * closed exception list
 *
 * *For any* sequence of page and move events, *any* pair of intervals and *any*
 * Quarantine_Write_Threshold:
 *
 *  - no two consecutive writes are separated by more than `pageInterval` pages or
 *    by more than `timeIntervalMs` milliseconds;
 *  - reaching the threshold in moved objects, completing a Managed_Category
 *    prefix, and a terminal event each write;
 *  - **every write is attributable to exactly one of five causes** and no write
 *    occurs that none of the five explains (Reqs 7.17, 7.18);
 *  - the write count for a listing of `P` pages over `C` categories that moved `M`
 *    objects at threshold `T` is at most `ceil(M / T) + floor(P / pageInterval) + C + 1`
 *    (Req 7.8);
 *  - the writes attributable to moves are bounded by `ceil(M / T)` **independently
 *    of the page size and of how the moved objects are distributed across pages**
 *    (Req 7.9);
 *  - a threshold that is non-finite, not positive or truncates to zero resolves to
 *    the default and **never to zero** (Reqs 7.20, 7.21);
 *  - the decision is monotone in all three dimensions.
 *
 * **Validates: Requirements 7.1, 7.2, 7.4, 7.5, 7.8, 7.9, 7.16, 7.17, 7.18, 7.20, 7.21, 7.23**
 *
 * ── Both directions, because each alone is satisfiable by a broken scheduler ──
 *
 * A scheduler that never writes satisfies the upper bound; one that writes on every
 * page satisfies the lower. So the no-gap invariants (a write must happen by the
 * bound) and the closure arm (no write may happen that no rule permits) are both
 * asserted, on every generated input.
 *
 * ── Where the count bound's time term went ───────────────────────────────────
 *
 * Req 7.8's bound has no time term: time-driven writes add to it on a slow
 * listing, bounded by the run's wall-clock duration divided by the interval. So the
 * bound is asserted as `writes - timeAttributed <= ceil(M/T) + floor(P/PI) + C + 1`
 * on every input, **plus** the unqualified `writes <= bound` on the frozen-clock
 * arm where no time-driven write can occur. Each of the four terms is also
 * asserted separately against the cause it bounds, so a scheduler that stayed
 * under the total by over-counting one term and under-counting another still fails.
 *
 * ── Why the ms gap is stated at the evaluation points ────────────────────────
 *
 * A pure predicate cannot bound wall-clock time that elapses while nobody consults
 * it. The lower bound is therefore asserted in the only form it has: at **every**
 * evaluation, if the elapsed milliseconds since the last write have reached the
 * interval, a write happens — so `msSinceWrite < timeIntervalMs` holds after every
 * evaluation. The elapsed-ms sequence is generated to advance arbitrarily fast,
 * which is Req 7.23: no clause here depends on the caller pausing between writes.
 *
 * ── The reset is the harness's contract with the call site ───────────────────
 *
 * After every write the simulator sets `pagesSinceWrite` and `movedSinceWrite` to
 * `0` and rebases `msSinceWrite`, exactly as task 6.1's call site will. That reset
 * is what makes the count bound a consequence of the scheduler rather than of this
 * harness.
 *
 * ── No vacuous arms (Req 11.26) ──────────────────────────────────────────────
 *
 * No precondition here is established by catching an exception — the function is
 * total. Every arm is counted and asserted non-zero after `fc.assert` returns:
 * each of the five causes, the frozen and fast clocks, valid and invalid
 * thresholds, all four page-size × distribution combinations, and both halves of
 * the monotonicity implication.
 *
 * _Requirements: 11.3, 11.4, 11.5_
 */
import * as fc from 'fast-check';

import {
  DEFAULT_QUARANTINE_WRITE_THRESHOLD,
  DEFAULT_REPORT_WRITE_PAGE_INTERVAL,
  DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS,
  shouldWriteTenantReport,
} from '../lib/sweepScaleLimits';
import type { ReportWriteEvent, ReportWriteState } from '../lib/sweepScaleLimits';

// ---------------------------------------------------------------------------
// The contract's own fallback rules, restated as oracles.
//
// These are not a copy of the implementation for its own sake: the attribution
// claim ("every write is explained by one of five causes") is only checkable
// against the RESOLVED intervals, and resolution is part of the contract
// (Reqs 7.12, 7.20, 7.21). Both are asserted directly as well, so a divergence
// between these and the module fails rather than hiding.
// ---------------------------------------------------------------------------
function resolveInterval(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveThreshold(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_QUARANTINE_WRITE_THRESHOLD;
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : DEFAULT_QUARANTINE_WRITE_THRESHOLD;
}

/** The five causes, in the documented attribution order (Req 7.18). */
type Cause = 'threshold' | 'prefix' | 'terminal' | 'page' | 'time';

type Step =
  | { kind: 'move'; msDelta: number }
  | { kind: 'page'; msDelta: number; prefixCompleted: boolean }
  | { kind: 'terminal'; msDelta: number };

interface Intervals {
  pageInterval: number;
  timeIntervalMs: number;
  quarantineThreshold: number;
}

interface Evaluation {
  kind: Step['kind'];
  wrote: boolean;
  /** Every cause that held at this evaluation, in attribution order. */
  causes: Cause[];
  pagesAtDecision: number;
  msAtDecision: number;
  movedAtDecision: number;
  pagesAfter: number;
  msAfter: number;
}

interface Trace {
  evaluations: Evaluation[];
  resolved: Intervals;
  /** `M`, `P` and `C` of the Req 7.8 bound. */
  moves: number;
  pages: number;
  prefixes: number;
  /** Writes per attributed cause. */
  attributed: Record<Cause, number>;
  writes: number;
  /** Pages during which at least one object moved — the rejected trigger's `Q`. */
  pagesThatMoved: number;
}

/**
 * Drive the scheduler over a step sequence exactly as task 6.1's call site will:
 * evaluate after **each move** as well as at **each page boundary**, and reset the
 * two counters and rebase the clock after every write.
 *
 * The RAW generated intervals are handed to the function, invalid values included,
 * so the fallbacks are exercised through the contract rather than around it.
 */
function runScheduler(steps: readonly Step[], intervals: Intervals): Trace {
  const resolved: Intervals = {
    pageInterval: resolveInterval(intervals.pageInterval, DEFAULT_REPORT_WRITE_PAGE_INTERVAL),
    timeIntervalMs: resolveInterval(intervals.timeIntervalMs, DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS),
    quarantineThreshold: resolveThreshold(intervals.quarantineThreshold),
  };

  const state: ReportWriteState = { pagesSinceWrite: 0, msSinceWrite: 0, movedSinceWrite: 0 };
  const evaluations: Evaluation[] = [];
  const attributed: Record<Cause, number> = { threshold: 0, prefix: 0, terminal: 0, page: 0, time: 0 };
  let moves = 0;
  let pages = 0;
  let prefixes = 0;
  let writes = 0;
  let pagesThatMoved = 0;
  let movedOnThisPage = 0;

  for (const step of steps) {
    state.msSinceWrite += step.msDelta;

    let event: ReportWriteEvent;
    if (step.kind === 'move') {
      state.movedSinceWrite += 1;
      moves += 1;
      movedOnThisPage += 1;
      event = { prefixCompleted: false, terminal: false };
    } else if (step.kind === 'page') {
      state.pagesSinceWrite += 1;
      pages += 1;
      if (step.prefixCompleted) prefixes += 1;
      if (movedOnThisPage > 0) pagesThatMoved += 1;
      movedOnThisPage = 0;
      event = { prefixCompleted: step.prefixCompleted, terminal: false };
    } else {
      event = { prefixCompleted: false, terminal: true };
    }

    const causes: Cause[] = [];
    if (state.movedSinceWrite >= resolved.quarantineThreshold) causes.push('threshold');
    if (event.prefixCompleted) causes.push('prefix');
    if (event.terminal) causes.push('terminal');
    if (state.pagesSinceWrite >= resolved.pageInterval) causes.push('page');
    if (state.msSinceWrite >= resolved.timeIntervalMs) causes.push('time');

    const pagesAtDecision = state.pagesSinceWrite;
    const msAtDecision = state.msSinceWrite;
    const movedAtDecision = state.movedSinceWrite;

    const wrote = shouldWriteTenantReport(state, event, intervals);
    if (wrote) {
      writes += 1;
      if (causes.length > 0) attributed[causes[0]] += 1;
      // The call site's reset, which is what makes the bound the scheduler's.
      state.pagesSinceWrite = 0;
      state.movedSinceWrite = 0;
      state.msSinceWrite = 0;
    }

    evaluations.push({
      kind: step.kind,
      wrote,
      causes,
      pagesAtDecision,
      msAtDecision,
      movedAtDecision,
      pagesAfter: state.pagesSinceWrite,
      msAfter: state.msSinceWrite,
    });
  }

  return { evaluations, resolved, moves, pages, prefixes, attributed, writes, pagesThatMoved };
}

/**
 * Every clause that holds for *any* trace, asserted in one place so the four arms
 * below assert the same core rather than four drifting subsets.
 */
function assertCoreClauses(trace: Trace): void {
  const { resolved } = trace;

  for (const evaluation of trace.evaluations) {
    // ── The biconditional: attribution AND no suppression (Reqs 7.17, 7.18) ──
    //
    // `true` ⇒ at least one of the five causes held, so every write is
    // attributable. `false` ⇒ none held, so nothing in the composition suppressed
    // a write another rule required. A sixth, undocumented forcing condition fails
    // the second half; a missed forcing condition fails the first.
    expect(evaluation.wrote).toBe(evaluation.causes.length > 0);

    // The three exceptions, restated as their own assertion: each one writes.
    if (
      evaluation.causes.includes('threshold') ||
      evaluation.causes.includes('prefix') ||
      evaluation.causes.includes('terminal')
    ) {
      expect(evaluation.wrote).toBe(true);
    }

    // ── The two no-gap bounds, as invariants after each evaluation ────────────
    expect(evaluation.pagesAfter).toBeLessThan(resolved.pageInterval);
    expect(evaluation.msAfter).toBeLessThan(resolved.timeIntervalMs);

    // ── The page gap, stated directly on the write ────────────────────────────
    if (evaluation.wrote) {
      expect(evaluation.pagesAtDecision).toBeLessThanOrEqual(resolved.pageInterval);
    }
  }

  // ── Each term of the Req 7.8 bound against the cause it bounds ─────────────
  const moveBound = Math.ceil(trace.moves / resolved.quarantineThreshold);
  expect(trace.attributed.threshold).toBeLessThanOrEqual(moveBound);
  expect(trace.attributed.page).toBeLessThanOrEqual(
    Math.floor(trace.pages / resolved.pageInterval)
  );
  expect(trace.attributed.prefix).toBeLessThanOrEqual(trace.prefixes);
  expect(trace.attributed.terminal).toBeLessThanOrEqual(1);

  // ── And the total, less the time-driven writes the bound does not model ────
  const bound = moveBound + Math.floor(trace.pages / resolved.pageInterval) + trace.prefixes + 1;
  expect(trace.writes - trace.attributed.time).toBeLessThanOrEqual(bound);
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------
const pageIntervalArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 12 }) },
  { weight: 2, arbitrary: fc.constantFrom(0, -1, NaN, Infinity, -Infinity) },
  { weight: 1, arbitrary: fc.constant(DEFAULT_REPORT_WRITE_PAGE_INTERVAL) }
);

const timeIntervalArb = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(1, 10, 100, 1_000, 30_000) },
  { weight: 2, arbitrary: fc.constantFrom(0, -1, NaN, Infinity, -Infinity) }
);

/** Valid thresholds plus the five invalid values that must resolve to 25. */
const thresholdArb = fc.oneof(
  { weight: 5, arbitrary: fc.integer({ min: 1, max: 30 }) },
  { weight: 3, arbitrary: fc.constantFrom(0, -1, 0.5, NaN, Infinity) },
  { weight: 1, arbitrary: fc.constant(DEFAULT_QUARANTINE_WRITE_THRESHOLD) }
);

/**
 * `frozen` never advances the clock, `fast` advances it far enough to cross any
 * generated interval in a single step. Req 7.23: no clause depends on the caller
 * pausing, so the bounds must hold for a clock that runs arbitrarily fast.
 */
const clockModeArb = fc.constantFrom('frozen' as const, 'slow' as const, 'fast' as const);

interface RawStep {
  move: boolean;
  msDelta: number;
  prefixCompleted: boolean;
}

const rawStepArb: fc.Arbitrary<RawStep> = fc.record({
  move: fc.boolean(),
  msDelta: fc.integer({ min: 0, max: 60_000 }),
  // Rare, because a Managed_Category prefix completes a handful of times per
  // listing. A coin flip here would let `prefixCompleted` force most of the
  // writes and starve the two interval arms.
  prefixCompleted: fc.oneof(
    { weight: 1, arbitrary: fc.constant(true) },
    { weight: 7, arbitrary: fc.constant(false) }
  ),
});

function toSteps(raw: readonly RawStep[], clockMode: 'frozen' | 'slow' | 'fast', movesAllowed: boolean): Step[] {
  const steps: Step[] = raw.map((step) => {
    const msDelta = clockMode === 'frozen' ? 0 : clockMode === 'slow' ? step.msDelta % 7 : step.msDelta;
    if (step.move && movesAllowed) return { kind: 'move', msDelta };
    return { kind: 'page', msDelta, prefixCompleted: step.prefixCompleted };
  });
  // Every tenant's listing ends with a terminal event (Req 7.5).
  steps.push({ kind: 'terminal', msDelta: 0 });
  return steps;
}

// ---------------------------------------------------------------------------
// Arm 1: the general sequence.
// ---------------------------------------------------------------------------
describe('Property 7: the write scheduler over generated event sequences', () => {
  it('obeys both intervals, keeps the exception list closed, and stays within the count bound', () => {
    const arms = {
      threshold: 0,
      prefix: 0,
      terminal: 0,
      page: 0,
      time: 0,
      frozenClock: 0,
      fastClock: 0,
      invalidThreshold: 0,
      validThreshold: 0,
      invalidInterval: 0,
    };

    fc.assert(
      fc.property(
        fc.array(rawStepArb, { minLength: 1, maxLength: 40 }),
        pageIntervalArb,
        timeIntervalArb,
        thresholdArb,
        clockModeArb,
        (raw, pageInterval, timeIntervalMs, quarantineThreshold, clockMode) => {
          const intervals: Intervals = { pageInterval, timeIntervalMs, quarantineThreshold };
          const steps = toSteps(raw, clockMode, true);
          const trace = runScheduler(steps, intervals);

          assertCoreClauses(trace);

          // The terminal event always writes, and — because a move that reaches
          // the threshold has already written and reset the counter — the write it
          // forces is always attributed to `terminal` itself.
          const last = trace.evaluations[trace.evaluations.length - 1];
          expect(last.kind).toBe('terminal');
          expect(last.wrote).toBe(true);
          expect(trace.attributed.terminal).toBe(1);

          // The threshold never resolves to zero, whatever was configured: at zero
          // every evaluation would be threshold-attributed, since `moved >= 0`
          // always holds.
          expect(trace.resolved.quarantineThreshold).toBeGreaterThanOrEqual(1);
          if (resolveThreshold(quarantineThreshold) !== quarantineThreshold) {
            arms.invalidThreshold += 1;
            expect(trace.resolved.quarantineThreshold).toBe(DEFAULT_QUARANTINE_WRITE_THRESHOLD);
          } else {
            arms.validThreshold += 1;
          }
          if (!Number.isFinite(pageInterval) || pageInterval <= 0) {
            arms.invalidInterval += 1;
            expect(trace.resolved.pageInterval).toBe(DEFAULT_REPORT_WRITE_PAGE_INTERVAL);
          }
          if (!Number.isFinite(timeIntervalMs) || timeIntervalMs <= 0) {
            arms.invalidInterval += 1;
            expect(trace.resolved.timeIntervalMs).toBe(DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS);
          }

          if (clockMode === 'frozen') {
            arms.frozenClock += 1;
            // No time-driven write is possible, so the unqualified Req 7.8 bound
            // holds — which is the form the design states.
            expect(trace.attributed.time).toBe(0);
            const bound =
              Math.ceil(trace.moves / trace.resolved.quarantineThreshold) +
              Math.floor(trace.pages / trace.resolved.pageInterval) +
              trace.prefixes +
              1;
            expect(trace.writes).toBeLessThanOrEqual(bound);
          }
          if (
            clockMode === 'fast' &&
            steps.some((step) => step.msDelta >= trace.resolved.timeIntervalMs)
          ) {
            arms.fastClock += 1;
          }

          for (const cause of ['threshold', 'prefix', 'terminal', 'page', 'time'] as const) {
            if (trace.attributed[cause] > 0) arms[cause] += 1;
          }
        }
      ),
      { numRuns: 100 }
    );

    // Req 11.25: an arm reached zero times means this property stopped checking
    // something, and it must say so in red.
    expect(arms.threshold).toBeGreaterThan(0);
    expect(arms.prefix).toBeGreaterThan(0);
    expect(arms.terminal).toBeGreaterThan(0);
    expect(arms.page).toBeGreaterThan(0);
    expect(arms.time).toBeGreaterThan(0);
    expect(arms.frozenClock).toBeGreaterThan(0);
    expect(arms.fastClock).toBeGreaterThan(0);
    expect(arms.invalidThreshold).toBeGreaterThan(0);
    expect(arms.validThreshold).toBeGreaterThan(0);
    expect(arms.invalidInterval).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Arm 2: page-size independence (Req 7.9) — the clause the rejected per-page
// trigger fails.
// ---------------------------------------------------------------------------
/**
 * Build one tenant's listing as a step sequence: each page's moves, then the page
 * boundary. `pageSize` fixes how many objects a page holds — and therefore both
 * the page count and the maximum moves one page can contain — and `distribution`
 * fixes where the orphans sit.
 */
function buildListing(opts: {
  pageSize: number;
  totalObjects: number;
  moves: number;
  distribution: 'spread' | 'clustered';
}): Step[] {
  const pageCount = Math.max(1, Math.ceil(opts.totalObjects / opts.pageSize));
  const perPage = new Array<number>(pageCount).fill(0);
  let left = opts.moves;

  if (opts.distribution === 'clustered') {
    // Every orphan as early in the listing as it will fit — the shape that lets a
    // single page move a whole ceiling's worth of objects.
    for (let page = 0; page < pageCount && left > 0; page += 1) {
      const take = Math.min(opts.pageSize, left);
      perPage[page] = take;
      left -= take;
    }
  } else {
    // One at a time round the pages: at `pageSize: 1` this is the
    // one-object-per-page listing the per-page trigger failed on.
    let page = 0;
    while (left > 0) {
      if (perPage[page] < opts.pageSize) {
        perPage[page] += 1;
        left -= 1;
      }
      page = (page + 1) % pageCount;
    }
  }

  const steps: Step[] = [];
  for (const movesOnPage of perPage) {
    for (let i = 0; i < movesOnPage; i += 1) steps.push({ kind: 'move', msDelta: 0 });
    steps.push({ kind: 'page', msDelta: 0, prefixCompleted: false });
  }
  steps.push({ kind: 'terminal', msDelta: 0 });
  return steps;
}

describe('Property 7: the move-attributable write count hides the page size', () => {
  /**
   * The same total `M` under **two page sizes** and **two distributions**, one of
   * them the one-object-per-page listing, requiring the move-attributable write
   * count to match `ceil(M / T)` in all four combinations.
   *
   * ── Why the page interval is taken out of the way here ────────────────────
   *
   * An interval-driven write also resets `movedSinceWrite`, which *lowers* the
   * move-attributable count and makes it depend on the page count again — so the
   * equality is only stateable with the interval term isolated. The inequality is
   * asserted **without** that isolation in the second case below, where the
   * generated page interval interleaves freely: the bound is page-size independent
   * either way, and only the exact equality needs the isolation.
   *
   * `M` is generated as a multiple of the threshold so `ceil(M / T)` is exact
   * rather than a rounding, and `T >= 2` so `ceil(M / T) < M` — which is what
   * gives this arm teeth. A scheduler that kept the per-page trigger and merely
   * renamed its field produces one write per quarantining page: `M` writes for the
   * one-object-per-page listing, against the `M / T` asserted here.
   */
  it('matches ceil(M / T) for both page sizes and both distributions', () => {
    const combos = ['1:spread', '1:clustered', '4:spread', '4:clustered'] as const;
    const arms: Record<string, number> = { '1:spread': 0, '1:clustered': 0, '4:spread': 0, '4:clustered': 0 };
    let perPageTriggerWouldOverWrite = 0;

    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 25 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 10 }),
        (threshold, multiple, interleavingPageInterval) => {
          const moves = multiple * threshold; // `M`, an exact multiple of `T`
          const expectedMoveWrites = Math.ceil(moves / threshold);
          expect(expectedMoveWrites).toBe(multiple);

          const isolated: number[] = [];

          for (const combo of combos) {
            const [pageSizeText, distribution] = combo.split(':') as [string, 'spread' | 'clustered'];
            const pageSize = Number(pageSizeText);
            const steps = buildListing({
              pageSize,
              // Twice `M` objects, so a listing has pages that move nothing as
              // well as pages that move something.
              totalObjects: moves * 2,
              moves,
              distribution,
            });
            arms[combo] += 1;

            // ── The equality, with the interval term isolated ────────────────
            const isolatedTrace = runScheduler(steps, {
              pageInterval: steps.length + 1,
              timeIntervalMs: DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS,
              quarantineThreshold: threshold,
            });
            assertCoreClauses(isolatedTrace);
            expect(isolatedTrace.moves).toBe(moves);
            expect(isolatedTrace.attributed.time).toBe(0);
            expect(isolatedTrace.attributed.page).toBe(0);
            expect(isolatedTrace.attributed.threshold).toBe(expectedMoveWrites);
            expect(isolatedTrace.writes).toBe(expectedMoveWrites + 1); // + the terminal write
            isolated.push(isolatedTrace.attributed.threshold);

            // The rejected trigger's `Q`: pages that moved an object. Whenever it
            // exceeds `ceil(M / T)`, a per-page trigger writes strictly more often
            // than this arm permits — which is the failure the arm exists to force.
            if (isolatedTrace.pagesThatMoved > expectedMoveWrites) perPageTriggerWouldOverWrite += 1;

            // ── The inequality, with the page interval interleaving freely ────
            const interleaved = runScheduler(steps, {
              pageInterval: interleavingPageInterval,
              timeIntervalMs: DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS,
              quarantineThreshold: threshold,
            });
            assertCoreClauses(interleaved);
            expect(interleaved.attributed.threshold).toBeLessThanOrEqual(expectedMoveWrites);
          }

          // Identical across all four combinations — which is the claim: the count
          // is a function of `M` and `T` alone.
          expect(isolated).toEqual([
            expectedMoveWrites,
            expectedMoveWrites,
            expectedMoveWrites,
            expectedMoveWrites,
          ]);
        }
      ),
      { numRuns: 100 }
    );

    for (const combo of combos) expect(arms[combo]).toBeGreaterThan(0);
    expect(perPageTriggerWouldOverWrite).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Arm 3: the closure arm (Req 7.18).
// ---------------------------------------------------------------------------
describe('Property 7: no write occurs that none of the five causes explains', () => {
  /**
   * Sequences in which no forcing event occurs and neither interval is reached.
   * The scheduler must return `false` on **every** page.
   *
   * This is the third trap the design names: a scheduler with a fourth,
   * undocumented forcing condition satisfies both interval bounds *and* the count
   * bound while writing more often than any rule here permits — and the count
   * bound is exactly what a future reader would use to conclude the cadence is
   * safe.
   */
  it('returns false on every page of a no-forcing, sub-interval sequence', () => {
    const arms = { pagesEvaluated: 0, movesEvaluated: 0, invalidThreshold: 0, validThreshold: 0, clockAdvanced: 0 };

    fc.assert(
      fc.property(
        fc.integer({ min: 4, max: 12 }).chain((pageInterval) =>
          fc.record({
            pageInterval: fc.constant(pageInterval),
            // Strictly fewer pages than the upper bound permits, so the page
            // interval is never reached.
            pageCount: fc.integer({ min: 1, max: pageInterval - 1 }),
            timeIntervalMs: fc.constantFrom(1_000, 30_000),
            thresholdCandidate: fc.oneof(
              fc.integer({ min: 8, max: 30 }),
              fc.constantFrom(0, -1, 0.5, NaN, Infinity)
            ),
            movesPerPage: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 12, maxLength: 12 }),
            msRaw: fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 60, maxLength: 60 }),
          })
        ),
        (input) => {
          const threshold = resolveThreshold(input.thresholdCandidate);
          if (threshold === input.thresholdCandidate) arms.validThreshold += 1;
          else arms.invalidThreshold += 1;

          // Keep the total moves strictly beneath the resolved threshold and the
          // total elapsed milliseconds strictly beneath the time interval. Both
          // are CONSTRUCTED, never established by catching anything.
          let movesBudget = threshold - 1;
          const steps: Step[] = [];
          const msCap = Math.floor((input.timeIntervalMs - 1) / 60);
          let msIndex = 0;
          const nextMs = (): number => {
            const raw = input.msRaw[msIndex % input.msRaw.length];
            msIndex += 1;
            const delta = msCap > 0 ? raw % (msCap + 1) : 0;
            if (delta > 0) arms.clockAdvanced += 1;
            return delta;
          };

          for (let page = 0; page < input.pageCount; page += 1) {
            const wanted = input.movesPerPage[page % input.movesPerPage.length];
            const moves = Math.min(wanted, movesBudget);
            movesBudget -= moves;
            for (let i = 0; i < moves; i += 1) {
              steps.push({ kind: 'move', msDelta: nextMs() });
              arms.movesEvaluated += 1;
            }
            steps.push({ kind: 'page', msDelta: nextMs(), prefixCompleted: false });
            arms.pagesEvaluated += 1;
          }

          // No terminal step: a terminal event is one of the three sanctioned
          // exceptions, so including it would put a permitted write in an arm
          // whose whole claim is that no write is permitted.
          const trace = runScheduler(steps, {
            pageInterval: input.pageInterval,
            timeIntervalMs: input.timeIntervalMs,
            quarantineThreshold: input.thresholdCandidate,
          });

          assertCoreClauses(trace);
          expect(trace.writes).toBe(0);
          for (const evaluation of trace.evaluations) {
            expect(evaluation.wrote).toBe(false);
            expect(evaluation.causes).toEqual([]);
            expect(evaluation.movedAtDecision).toBeLessThan(trace.resolved.quarantineThreshold);
            expect(evaluation.pagesAtDecision).toBeLessThan(trace.resolved.pageInterval);
            expect(evaluation.msAtDecision).toBeLessThan(trace.resolved.timeIntervalMs);
          }
        }
      ),
      { numRuns: 100 }
    );

    expect(arms.pagesEvaluated).toBeGreaterThan(0);
    expect(arms.movesEvaluated).toBeGreaterThan(0);
    expect(arms.invalidThreshold).toBeGreaterThan(0);
    expect(arms.validThreshold).toBeGreaterThan(0);
    expect(arms.clockAdvanced).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Arm 4: Report_Mode (Req 7.16).
// ---------------------------------------------------------------------------
describe('Property 7: Report_Mode gets the identical cadence', () => {
  /**
   * The moved-object delta held `0` throughout — which is what Report_Mode is, a
   * mode in which the threshold exception is simply unreachable. Both interval
   * bounds must hold unchanged, so the cadence is proven mode-independent rather
   * than assumed. Report_Mode is the case the batching exists for: the
   * million-object tenant at `pageSize: 1000` is 1000 pages of it.
   */
  it('applies both intervals exactly as Apply_Mode does, with no move-driven write', () => {
    const arms = { page: 0, time: 0, prefix: 0, terminal: 0 };

    fc.assert(
      fc.property(
        fc.array(rawStepArb, { minLength: 1, maxLength: 40 }),
        pageIntervalArb,
        timeIntervalArb,
        thresholdArb,
        clockModeArb,
        (raw, pageInterval, timeIntervalMs, quarantineThreshold, clockMode) => {
          const steps = toSteps(raw, clockMode, false); // movesAllowed: false
          const trace = runScheduler(steps, { pageInterval, timeIntervalMs, quarantineThreshold });

          assertCoreClauses(trace);
          expect(trace.moves).toBe(0);
          // The threshold exception is unreachable, as arithmetic rather than as a
          // separate code path — which is why the function takes no mode parameter.
          expect(trace.attributed.threshold).toBe(0);
          for (const evaluation of trace.evaluations) {
            expect(evaluation.movedAtDecision).toBe(0);
            expect(evaluation.causes).not.toContain('threshold');
          }
          // Req 7.8 with `M = 0`: the two intervals plus the prefix and terminal
          // exceptions, and nothing else.
          expect(trace.writes - trace.attributed.time).toBeLessThanOrEqual(
            Math.floor(trace.pages / trace.resolved.pageInterval) + trace.prefixes + 1
          );

          for (const cause of ['page', 'time', 'prefix', 'terminal'] as const) {
            if (trace.attributed[cause] > 0) arms[cause] += 1;
          }
        }
      ),
      { numRuns: 100 }
    );

    expect(arms.page).toBeGreaterThan(0);
    expect(arms.time).toBeGreaterThan(0);
    expect(arms.prefix).toBeGreaterThan(0);
    expect(arms.terminal).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Arm 5: monotonicity in all three dimensions.
// ---------------------------------------------------------------------------
describe('Property 7: monotone in all three dimensions', () => {
  /**
   * For a fixed event, increasing elapsed pages, elapsed milliseconds **or** moved
   * objects can only turn `false` into `true`. So a scheduler that writes cannot
   * be made not to write by waiting longer or by moving more — which sounds
   * trivial and is exactly the inversion an off-by-one in a comparison produces.
   *
   * Both halves of the implication are counted: an implication whose antecedent
   * never held would pass while asserting nothing.
   *
   * The state is generated as an **offset from each resolved bound** rather than
   * over a flat range, because that is the only region where a bump of a few units
   * can cross a boundary — and it is the region an off-by-one lives in. A flat
   * range over milliseconds against a 30-second interval reaches the flip about
   * once in four thousand inputs, which is how a monotonicity property ends up
   * asserting only its trivial half.
   */
  it('never turns true back into false', () => {
    const arms = { antecedentHeld: 0, flippedFalseToTrue: 0 };

    const boundaryOffset = fc.integer({ min: -8, max: 3 });
    const inputArb = fc
      .record({
        pageInterval: pageIntervalArb,
        timeIntervalMs: timeIntervalArb,
        quarantineThreshold: thresholdArb,
      })
      .chain((intervals) => {
        const resolved: Intervals = {
          pageInterval: resolveInterval(intervals.pageInterval, DEFAULT_REPORT_WRITE_PAGE_INTERVAL),
          timeIntervalMs: resolveInterval(
            intervals.timeIntervalMs,
            DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS
          ),
          quarantineThreshold: resolveThreshold(intervals.quarantineThreshold),
        };
        return fc.record({
          intervals: fc.constant(intervals),
          state: fc.record({
            pagesSinceWrite: boundaryOffset.map((offset) =>
              Math.max(0, Math.trunc(resolved.pageInterval) + offset)
            ),
            msSinceWrite: boundaryOffset.map((offset) =>
              Math.max(0, Math.trunc(resolved.timeIntervalMs) + offset)
            ),
            movedSinceWrite: boundaryOffset.map((offset) =>
              Math.max(0, resolved.quarantineThreshold + offset)
            ),
          }),
          event: fc.record({
            prefixCompleted: fc.oneof(
              { weight: 1, arbitrary: fc.constant(true) },
              { weight: 6, arbitrary: fc.constant(false) }
            ),
            terminal: fc.oneof(
              { weight: 1, arbitrary: fc.constant(true) },
              { weight: 6, arbitrary: fc.constant(false) }
            ),
          }),
          bump: fc.integer({ min: 1, max: 8 }),
        });
      });

    fc.assert(
      fc.property(inputArb, ({ state, event, intervals, bump }) => {
        const before = shouldWriteTenantReport(state, event, intervals);
        if (before) arms.antecedentHeld += 1;

        for (const dimension of ['pagesSinceWrite', 'msSinceWrite', 'movedSinceWrite'] as const) {
          const bumped: ReportWriteState = { ...state, [dimension]: state[dimension] + bump };
          const after = shouldWriteTenantReport(bumped, event, intervals);
          if (before) expect(after).toBe(true);
          if (!before && after) arms.flippedFalseToTrue += 1;
        }
      }),
      { numRuns: 100 }
    );

    expect(arms.antecedentHeld).toBeGreaterThan(0);
    expect(arms.flippedFalseToTrue).toBeGreaterThan(0);
  });
});
