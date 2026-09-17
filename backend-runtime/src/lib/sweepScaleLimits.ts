/**
 * The two scale decisions `storage-sweep-scale-hardening` adds, extracted so that
 * "may this ceiling start at all?" and "should the Report_Document be written
 * now?" are answered by pure, total functions with no I/O and no clock read — and
 * can therefore be asserted over generated input before any code exists that is
 * able to read a heap or write a document.
 *
 * Same posture as `src/lib/orphanDecision.ts` (Req 11.17): no `express`, no
 * `firebase-admin`, no `v8`, no bucket handle, no `Date.now`. This module has no
 * imports at all — the heap *reading* is the caller's problem, and so is the live
 * clock.
 *
 * ── The one asymmetry to read before editing anything here ───────────────────
 *
 * Two predicates in this file compare a number against `0.7 × heapLimitBytes` and
 * they **disagree on a small reading, deliberately**:
 *
 *  - `decideReferenceCeilingHeadroom` compares a computed **estimate** and has
 *    **no floor term** (Req 8.6);
 *  - `exceedsHeapGuard` compares a measured **used heap** and requires the
 *    Heap_Guard_Floor **as well** (Reqs 8.8, 8.18).
 *
 * "Harmonising" the two is the obvious-looking edit, and it breaks Req 8.6. Both
 * declarations say so at length, and `sweepScaleLimits.test.ts` plus
 * `sweepScaleLimits.footprint.property.test.ts` each carry a case whose only
 * purpose is to make that edit fail loudly.
 */

// ─── The retain-set footprint ────────────────────────────────────────────────

/** V8 one-byte string: object header plus a path of the length this codebase mints. */
export const RETAIN_PATH_STRING_BYTES = 120;

/** A `Set` hash-table slot plus its pointer, amortised over V8's load factor. */
export const RETAIN_SET_ENTRY_BYTES = 48;

/** The `Array.from(retainPaths)` snapshot and the sorted array the fingerprint builds. */
export const RETAIN_SET_SNAPSHOT_BYTES = 16;

/**
 * The per-path cost, exported so a report and a log line can state it:
 *
 *     120  RETAIN_PATH_STRING_BYTES   the path string itself
 *   +  48  RETAIN_SET_ENTRY_BYTES     its slot in `retainPaths`
 *   +  48  RETAIN_SET_ENTRY_BYTES     `derivedPaths`, charged a SECOND full entry
 *   +  16  RETAIN_SET_SNAPSHOT_BYTES  the two pointer arrays
 *   = 232
 *
 * `derivedPaths` is charged a full entry per path even though it is a strict
 * subset (profile pictures and `_h264.mp4` derivations only). That over-charge is
 * the point: under-estimating is what produces an exit 137 in place of the
 * documented `reference_cap_exceeded` abort, so every term rounds up.
 *
 * `sweepScaleLimits.test.ts` asserts this equals the sum above rather than
 * trusting the literal, so an edit to one term cannot leave the total stale.
 */
export const RETAIN_SET_BYTES_PER_PATH = 232;

/**
 * The Retain_Set_Footprint_Estimate for a retained-path count (Req 8.4).
 *
 * `referenceCount * RETAIN_SET_BYTES_PER_PATH`, and **total**: a non-finite,
 * negative or non-integral count yields `0`, never `NaN`.
 *
 * Why `0` and not `NaN`: this feeds a comparison that decides whether the run
 * starts at all, and every comparison against `NaN` is `false` — which reads as
 * "the estimate does not exceed the guard", i.e. **proceed**. That is the wrong
 * direction for an input we could not read. `0` proceeds too, but it proceeds
 * having stated a number an operator can see in the log line and recognise as
 * nonsense, and the *configured* ceiling that produced it is itself logged
 * beside it. The refusal that matters for an unreadable input is
 * `heap_limit_unreadable`, which is about the limit rather than the count.
 *
 * Monotone non-decreasing **over its usable domain** — the non-negative
 * integers. It is not monotone over the whole of `number`, and cannot be: the
 * totality rule above sends `1.5` to `0` while `1` maps to `232`. The design's
 * "monotone non-decreasing" claim is therefore asserted where the estimate is an
 * estimate, and totality covers the rest.
 *
 * A count large enough to overflow the multiplication returns `Infinity`, which
 * refuses. Deliberately not clamped to a finite value: a clamp would be an
 * under-estimate, and under-estimating is the one direction this function must
 * never take.
 */
export function estimateRetainSetFootprintBytes(referenceCount: number): number {
  // `Number.isInteger` is `false` for `NaN`, `Infinity`, `-Infinity` and every
  // non-integral value, so one test covers all four unusable shapes.
  if (typeof referenceCount !== 'number' || !Number.isInteger(referenceCount)) return 0;
  if (referenceCount <= 0) return 0;
  return referenceCount * RETAIN_SET_BYTES_PER_PATH;
}

// ─── The heap guard ──────────────────────────────────────────────────────────

/**
 * Req 8.11. **NOT configurable**, and no environment variable reaches it
 * (Req 8.19): the only use for a knob here is to disable the guard, and a guard
 * an operator can turn off is one that will be off on the run that needed it.
 */
export const DEFAULT_HEAP_GUARD_FRACTION = 0.7;

/**
 * Req 8.17 — 128 MiB. The used-heap reading at or beneath which the
 * **MID-COLLECTION** guard keeps collecting, whatever fraction of the reported
 * Heap_Limit that reading represents (Req 8.18).
 *
 * Fixed, and overridable by **no** environment variable (Req 8.19), for the same
 * reason as the fraction above.
 *
 * ── Why 128 MiB, which is arithmetic rather than taste ───────────────────────
 *
 * At `RETAIN_SET_BYTES_PER_PATH` this floor is ≈ 578,000 retained paths —
 * marginally *above* the ≈ 116 MB the estimator produces for the whole Retain_Set
 * at the 500,000 default ceiling. So a used-heap reading beneath the floor
 * **cannot** be a Retain_Set that outgrew the default ceiling, which is the only
 * failure the mid-collection guard exists to catch. The floor is not a margin
 * traded against sensitivity; it is the largest value that provably masks no
 * in-scope failure. `sweepScaleLimits.test.ts` asserts that arithmetic, so an
 * edit to this constant or to `RETAIN_SET_BYTES_PER_PATH` that invalidates the
 * justification fails there rather than in production.
 *
 * ── Why a floor is required rather than tidy ─────────────────────────────────
 *
 * A fraction of the Heap_Limit is the right shape only where the Heap_Limit is a
 * real number. One byte used of a one-byte reported limit satisfies
 * `used > 0.7 × limit`, so a fraction-only guard aborts a tenant holding a
 * handful of references — and it does so on the reading a *misreporting*
 * environment produces, which is precisely the environment an operator is least
 * able to diagnose from an abort. A mechanism whose whole purpose is to convert
 * an unexplained kill into an explained abort must not manufacture explained
 * aborts out of nothing.
 */
export const HEAP_GUARD_FLOOR_BYTES = 134_217_728;

/** Admitted references between two heap samples (Req 8.7). */
export const HEAP_GUARD_SAMPLE_INTERVAL = 10_000;

/**
 * Whether a reported Heap_Limit is usable at all. `0`, a negative, `NaN` and
 * `±Infinity` are not limits we can compare against.
 */
function usableHeapLimit(heapLimitBytes: number): boolean {
  return typeof heapLimitBytes === 'number' && Number.isFinite(heapLimitBytes) && heapLimitBytes > 0;
}

/**
 * `fraction * heapLimitBytes`, or `0` for an unusable limit — and `0` **refuses**
 * at start-up, because `decideReferenceCeilingHeadroom` reads a non-positive
 * guard as `heap_limit_unreadable` rather than as "no limit to worry about".
 *
 * A non-finite or non-positive `fraction` falls back to
 * `DEFAULT_HEAP_GUARD_FRACTION`. The parameter exists so a test can drive the
 * boundary exactly (`fraction: 0.5` with `limit: 2 × estimate` puts the guard
 * *on* the estimate with no floating-point slack); the runner and the collector
 * never pass it.
 */
export function heapGuardBytes(
  heapLimitBytes: number,
  fraction: number = DEFAULT_HEAP_GUARD_FRACTION
): number {
  if (!usableHeapLimit(heapLimitBytes)) return 0;
  const resolved =
    typeof fraction === 'number' && Number.isFinite(fraction) && fraction > 0
      ? fraction
      : DEFAULT_HEAP_GUARD_FRACTION;
  return resolved * heapLimitBytes;
}

/**
 * The pure comparison the mid-collection guard makes. **BOTH** conditions are
 * required (Reqs 8.8, 8.18):
 *
 *     usedHeapBytes > floorBytes  &&  usedHeapBytes > fraction * heapLimitBytes
 *
 * `>` in **both**, so a reading exactly at either threshold **proceeds** — which
 * is Req 8.18's "at or below … SHALL continue collecting" read literally. An
 * inverted comparison in either place passes every non-boundary case, so all
 * four boundaries the two conditions create are unit-asserted.
 *
 * Consequences worth stating, because each is a named test case:
 *  - `false` for every `usedHeapBytes <= HEAP_GUARD_FLOOR_BYTES` whatever the
 *    limit reports, including the degenerate `used = 1, limit = 1` that a
 *    fraction-only guard would trip;
 *  - `false` for a limit that is not a finite positive number. An unreadable
 *    limit mid-collection is not evidence of a memory problem, and the
 *    readable-limit case was already settled at start-up by
 *    `decideReferenceCeilingHeadroom`, which **refuses** on exactly that input.
 *    The two functions therefore disagree on an unusable limit **on purpose**:
 *    refusing to start is cheap, aborting a tenant mid-collection on a bad
 *    reading is not;
 *  - `false` for a used-heap reading that is not a finite number, for the same
 *    reason and in the same direction.
 *
 * `floorBytes` is a parameter **only** so a test can drive the boundary without
 * allocating 128 MiB. Neither the runner nor the collector passes it, and no
 * environment variable reaches it (Req 8.19).
 *
 * ── NOTE the deliberate asymmetry with `decideReferenceCeilingHeadroom` ──────
 *
 * That function compares an **ESTIMATE** and applies **no floor**. This one
 * compares a **MEASUREMENT** and requires one. Do not "harmonise" them: adding a
 * floor there lets a ceiling whose computed footprint cannot fit the declared
 * limit start anyway (Req 8.6's exact failure), and dropping the floor here
 * aborts a tenant on a misreported one-byte limit (Req 8.18's exact failure).
 *
 * Monotone in `usedHeapBytes` and antitone in `heapLimitBytes`. Pure and
 * constant-time: no clock, no I/O, no `v8` import — the reading is the caller's.
 */
export function exceedsHeapGuard(
  usedHeapBytes: number,
  heapLimitBytes: number,
  fraction: number = DEFAULT_HEAP_GUARD_FRACTION,
  floorBytes: number = HEAP_GUARD_FLOOR_BYTES
): boolean {
  const guardBytes = heapGuardBytes(heapLimitBytes, fraction);
  if (guardBytes <= 0) return false;
  if (typeof usedHeapBytes !== 'number' || !Number.isFinite(usedHeapBytes)) return false;
  const resolvedFloor =
    typeof floorBytes === 'number' && Number.isFinite(floorBytes) && floorBytes >= 0
      ? floorBytes
      : HEAP_GUARD_FLOOR_BYTES;
  return usedHeapBytes > resolvedFloor && usedHeapBytes > guardBytes;
}

/**
 * The start-up verdict. All three numbers travel on **both** branches, so the
 * runner's log line (Req 8.14) and the Report_Document's `params` (Req 8.13)
 * state what was compared rather than only the verdict.
 *
 * `heapLimitBytes` echoes the reading **as given**, including an unusable one:
 * on the `heap_limit_unreadable` branch the whole point of the log line is to
 * show the operator what the process actually reported.
 */
export type ReferenceCeilingHeadroom =
  | { ok: true; estimateBytes: number; guardBytes: number; heapLimitBytes: number }
  | {
      ok: false;
      reason: 'estimate_exceeds_guard' | 'heap_limit_unreadable';
      estimateBytes: number;
      guardBytes: number;
      heapLimitBytes: number;
    };

/**
 * The start-up decision (Req 8.6), pure in its inputs so the runner can make it
 * **before** `initFirebase()` and a test can make it without a process.
 *
 * `ok: false` **exactly when** the estimate exceeds `fraction * heapLimitBytes`,
 * or the limit is not a finite positive number. `>` rather than `>=`, so
 * exactly-at-the-guard proceeds.
 *
 * `heap_limit_unreadable` **refuses** rather than proceeds: a limit we cannot
 * read is a limit we cannot check against, and the failure this exists to
 * prevent is precisely the one that looks like a successful start.
 *
 * ── NO Heap_Guard_Floor TERM HERE, DELIBERATELY ──────────────────────────────
 *
 * Unchanged by Req 8.17, and the asymmetry with `exceedsHeapGuard` above is the
 * design rather than an oversight. Req 8.6 compares a computed **estimate**; the
 * floor qualifies a used-heap **measurement**. A ceiling whose footprint
 * provably cannot fit the declared limit must refuse to start whether that
 * footprint is 20 MB or 2 GB — adding a floor here would let a small declared
 * limit pass the pre-flight check purely because the estimate happened to be
 * under 128 MiB, which is the exact failure this check exists to catch.
 *
 * So this function and `exceedsHeapGuard` return different verdicts for the same
 * pair of small numbers, on purpose. `sweepScaleLimits.test.ts` pins one such
 * pair (a 20 MB estimate against a 25 MB declared limit: this refuses, the
 * measurement predicate does not trip) and
 * `sweepScaleLimits.footprint.property.test.ts` generates the whole region.
 */
export function decideReferenceCeilingHeadroom(args: {
  maxReferences: number;
  heapLimitBytes: number;
  fraction?: number;
}): ReferenceCeilingHeadroom {
  const estimateBytes = estimateRetainSetFootprintBytes(args.maxReferences);
  const guardBytes = heapGuardBytes(args.heapLimitBytes, args.fraction);
  const heapLimitBytes = args.heapLimitBytes;

  if (guardBytes <= 0) {
    return { ok: false, reason: 'heap_limit_unreadable', estimateBytes, guardBytes, heapLimitBytes };
  }
  if (estimateBytes > guardBytes) {
    return { ok: false, reason: 'estimate_exceeds_guard', estimateBytes, guardBytes, heapLimitBytes };
  }
  return { ok: true, estimateBytes, guardBytes, heapLimitBytes };
}

// ─── The report-write cadence ────────────────────────────────────────────────

/** Req 7.11 — the upper bound on write frequency, in fully examined listing pages. */
export const DEFAULT_REPORT_WRITE_PAGE_INTERVAL = 10;

/** Req 7.11 — the lower bound on write frequency, in milliseconds. */
export const DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS = 30_000;

/**
 * Req 7.19 — **25 objects**, and the number is not arbitrary: it **equals the
 * per-tenant Quarantine ceiling that
 * `infra/cloud-run/storage-orphan-sweep-job-dev.yaml` documents for a first
 * cautious Apply_Mode run** — in its header runbook and in the comment beside
 * `STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT` — the **dev definition being
 * the only one of the two Cloud Run Job definitions that documents such a run**.
 * The prod definition sets that ceiling to `1000` and describes no cautious first
 * run, and **both** files set the variable itself to `"1000"`: the 25 is the
 * override the cautious run applies, not a configured value in either file. That
 * run therefore writes the Report_Document **once at the end of its moves** rather
 * than 25 times. `sweepScaleLimits.test.ts` asserts the equality from this side
 * and task 8.4 asserts it from the **dev** manifest's side, so the two cannot
 * drift apart silently.
 *
 * What *both* definitions owe is the separate cross-file obligation of Req 7.25:
 * each configures `STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD` so that it
 * resolves to this default, so an operator reading either definition reads the
 * write cadence in force in both.
 *
 * Resolved to **at least 1**, and to the default rather than to zero (Reqs 7.20,
 * 7.21). The failure a resolved `0` produces is the **write storm**, not a
 * suppressed write: Req 7.3's condition is
 * `movedSinceWrite >= quarantineThreshold`, it is checked **first and
 * unconditionally**, and `movedSinceWrite` is never negative — so `0` holds at
 * **every** evaluation and forces a Report_Document write on every move, every
 * page boundary and every terminal event alike. That collapses the batching
 * entirely and reproduces the one-write-per-page contention on the single document
 * the resume cursor lives on.
 */
export const DEFAULT_QUARANTINE_WRITE_THRESHOLD = 25;

/**
 * The three **since-the-last-write** accumulators. Every one of them is compared
 * against a configured bound, and every one is reset or rebased by the caller
 * after a write — which is why `movedSinceWrite` lives here and not in
 * `ReportWriteEvent`.
 */
export interface ReportWriteState {
  /** Listing pages fully examined since the last Report_Document write. */
  pagesSinceWrite: number;
  /**
   * Milliseconds since the last write. **INJECTED** — this module reads no clock.
   *
   * `config.nowMs` is frozen for the whole run on purpose: the parent design
   * freezes it so a multi-hour sweep cannot have its Grace_Cutoff drift
   * underneath it. The cadence needs a *live* clock, so the caller owns it and
   * hands the elapsed milliseconds in. A future edit that reaches into this
   * module for a cutoff would silently break Property 5 of the parent spec.
   */
  msSinceWrite: number;
  /**
   * Req 7.3. Objects **QUARANTINED** since the last write — a count in objects,
   * never a per-page flag.
   *
   * ── This is a load-bearing type, not a naming preference ─────────────────
   *
   * The rejected shape was `ReportWriteEvent.quarantinedOnThisPage: boolean`. It
   * was not moved and renamed for tidiness: the point is that
   * `{ quarantinedOnThisPage, prefixCompleted, terminal }` is now a **compile
   * error twice over** — an excess property on `ReportWriteEvent` and a missing
   * one on `ReportWriteState` — rather than a silent success. It has to be a
   * compile error, because the runtime failure mode is the dangerous direction:
   * `true` coerced into a count is `1`, `1 >= 25` is `false`, and the write
   * would then never fire on account of a move at all, reopening the ceiling
   * breach under a scheduler that reads as though it closed it.
   *
   * `shouldWriteTenantReport` additionally normalises a non-finite, negative or
   * non-integral value here to `0` — which fails the same silent way — so the
   * **type** is the guard and the normalisation is only totality.
   *
   * **Do NOT relax this to `number | boolean`** for a caller's convenience.
   *
   * A per-page boolean also described the wrong thing: it named the page just
   * examined rather than the lag since the last write, which is precisely why it
   * could not bound that lag, and why a listing whose orphans fall one per page
   * forced one write per page instead of `ceil(M / T)`.
   */
  movedSinceWrite: number;
}

/**
 * The two genuine per-occurrence forcing facts, and **nothing else**.
 *
 * Together with `movedSinceWrite` these are the **closed list of three**
 * exceptions (Req 7.17). The closure claim is stated over both types at once:
 * **`ReportWriteState` and `ReportWriteEvent` have exactly five fields between
 * them, one per attributable cause** (Req 7.18) — three since-the-last-write
 * accumulators compared against three configured bounds, plus these two flags. A
 * sixth field is a contract change, not an extension, so adding a fourth forcing
 * condition is a visible edit to Reqs 7.17 and 7.18 rather than a quiet one.
 *
 * **Do NOT relax `prefixCompleted` or `terminal` to `number | boolean`**, and do
 * not re-add a per-page moved flag here: see `ReportWriteState.movedSinceWrite`
 * for the failure that shape reopens.
 */
export interface ReportWriteEvent {
  /** Req 7.4 — the Object_Listing finished a Managed_Category prefix. */
  prefixCompleted: boolean;
  /** Req 7.5 — the tenant's run completed, aborted, or is about to rethrow. */
  terminal: boolean;
}

/** Req 7.12 — a non-finite or non-positive interval falls back to its default. */
function resolveInterval(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

/**
 * Reqs 7.20, 7.21 — non-finite, not greater than zero, or truncating to zero all
 * fall back to `DEFAULT_QUARANTINE_WRITE_THRESHOLD` and **never to zero**. The
 * truncation is what makes `0.5` a fallback rather than a threshold of `0`: the
 * threshold counts whole objects, so a fractional value has no reading, and the
 * dangerous resolution of a value with no reading is `0`.
 *
 * ── Exported as the ONE reference implementation of Req 7.20 ─────────────────
 *
 * The scheduler below resolves the threshold it is handed, and the two
 * configuration layers upstream of it — `runStorageOrphanSweep`'s
 * `loadRunnerConfig` and `storageOrphanSweep`'s `ResolvedSweepConfig` — resolve
 * the configured value before it ever gets here. Those layers call **this**
 * function rather than restating the rule, because they had drifted: a generic
 * positive-integer normaliser paired with a floor of `1` resolves a configured
 * `0.5` to `1`, which is Req 7.21 satisfied and Req 7.20 broken — the operator
 * gets a write after every move instead of the documented `25`. Total over a
 * value of any runtime type, so a config field that arrives as a string is the
 * fallback rather than a coercion.
 */
export function resolveQuarantineWriteThreshold(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_QUARANTINE_WRITE_THRESHOLD;
  }
  const truncated = Math.trunc(value);
  return truncated > 0 ? truncated : DEFAULT_QUARANTINE_WRITE_THRESHOLD;
}

/** Totality only — the type is what actually prevents a boolean reaching here. */
function usableMovedCount(value: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Total, pure, and the **only** place the cadence is decided, so Reqs 7.1–7.5
 * are one function's postcondition rather than five call sites' behaviour.
 *
 * The five rules **compose rather than compete**, and the composition is one
 * line (Reqs 7.17, 7.18):
 *
 *     movedSinceWrite >= quarantineThreshold  ||  prefixCompleted  ||  terminal
 *       ||  pagesSinceWrite >= pageInterval   ||  msSinceWrite >= timeIntervalMs
 *              ↑                                       ↑                    ↑
 *   the 3 enumerated exceptions              the UPPER bound (7.1)   the LOWER bound (7.2)
 *
 * The three exceptions are checked **first and unconditionally**. There is no
 * precedence question to settle, because the exceptions can only ever **force** a
 * write and the intervals can only ever **permit** one — nothing in the
 * composition can suppress a write another rule requires. Every write a listing
 * issues is therefore attributable to exactly one of those five causes
 * (Req 7.18), in that evaluation order, and the caller derives the cause for its
 * `reportWrites` accounting from the same inputs.
 *
 * ── The threshold is counted in OBJECTS, and that is what makes it a bound ───
 *
 * The persisted `quarantinedCount` a resume inherits therefore lags the objects
 * actually moved by fewer than the threshold, so a crash-and-resume pair
 * overshoots the per-tenant Quarantine ceiling by at most the threshold
 * (Req 7.22) — and the Apply_Mode writes attributable to moves are at most
 * `ceil(M / T)`, **independently of the listing page size and of how the moved
 * objects are distributed across pages** (Req 7.9). The caller therefore
 * evaluates this **after each move** as well as at each page boundary: a
 * boundary-only evaluation leaves the breach open, because one page at
 * `pageSize: 1000` can move a whole ceiling's worth of objects before any
 * boundary is reached. And no delay is ever inserted between writes — bounding
 * the lag in objects removes the exposure without making a run's wall-clock
 * duration depend on a Firestore write quota (Req 7.23).
 *
 * ── No mode parameter, and none may be added (Req 7.16) ─────────────────────
 *
 * Report_Mode applies both intervals exactly as Apply_Mode does. `movedSinceWrite`
 * is simply always `0` in a mode that moves no object, so Report_Mode's write
 * count reduces to the two intervals plus `prefixCompleted` and `terminal` as a
 * matter of arithmetic rather than of a separate code path — which is what makes
 * the million-object Report_Mode tenant the case this batching exists for.
 *
 * Monotone in all three dimensions: for a fixed event, increasing
 * `pagesSinceWrite`, `msSinceWrite` or `movedSinceWrite` can only turn `false`
 * into `true`. That sounds trivial and is exactly the inversion an off-by-one in
 * a comparison produces.
 *
 * Totality of the two interval accumulators is the comparison's own: `NaN`
 * compares `false` in both directions, so an unreadable page or millisecond
 * count declines an *interval-driven* write and can suppress no exception, since
 * the exceptions are evaluated above and independently. `Infinity` compares
 * `true` and writes, which is the safe direction — a write persists progress and
 * can skip nothing.
 */
export function shouldWriteTenantReport(
  state: ReportWriteState,
  event: ReportWriteEvent,
  intervals?: {
    pageInterval?: number;
    timeIntervalMs?: number;
    quarantineThreshold?: number;
  }
): boolean {
  // ── The three exceptions, first and unconditionally ──────────────────────
  const quarantineThreshold = resolveQuarantineWriteThreshold(intervals?.quarantineThreshold);
  if (usableMovedCount(state.movedSinceWrite) >= quarantineThreshold) return true; // Req 7.3
  if (event.prefixCompleted === true) return true; // Req 7.4
  if (event.terminal === true) return true; // Req 7.5

  // ── Otherwise the two intervals: an upper bound and a lower bound ─────────
  const pageInterval = resolveInterval(intervals?.pageInterval, DEFAULT_REPORT_WRITE_PAGE_INTERVAL);
  const timeIntervalMs = resolveInterval(
    intervals?.timeIntervalMs,
    DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS
  );
  return state.pagesSinceWrite >= pageInterval || state.msSinceWrite >= timeIntervalMs; // Req 7.1, 7.2
}
