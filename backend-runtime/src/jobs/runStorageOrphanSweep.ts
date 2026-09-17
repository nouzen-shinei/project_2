/**
 * Runnable entrypoint for the storage orphan sweep
 * (`node dist/jobs/runStorageOrphanSweep.js`, i.e. `npm run storage:orphan-sweep`).
 *
 * Follows `runOfflineDevicePrune.ts` exactly: load env config, refuse an unsafe
 * environment, `initFirebase()`, invoke the core, log the result,
 * `shutdownFirebase()`. **Every gate lives here**, never in the core, which tests
 * invoke directly.
 *
 * ── The gates, and why each default is the one it is ─────────────────────────
 *
 *  - `STORAGE_ORPHAN_SWEEP_ENABLED` (default FALSE) — not explicitly true ⇒ log
 *    the decision and exit 0 **without initialising Firebase**, so rollback is a
 *    single environment variable and a disabled job cannot read, list or write
 *    anything at all (Req 10.8).
 *  - `STORAGE_ORPHAN_SWEEP_APPLY` (default FALSE) — not explicitly true ⇒
 *    `mode: 'report'`, which mutates nothing outside `storageMaintenanceJobs/`
 *    (Req 10.9).
 *  - `STORAGE_ORPHAN_SWEEP_PURGE_ENABLED` (default FALSE) — the hard-delete
 *    stage, and a **separate** switch on a **separate** entrypoint (Req 12.7).
 *
 * The last two are independent on purpose: quarantining and hard-deleting are
 * different decisions with different reversibility, so no single mistyped variable
 * can destroy anything. `purgeExpiredQuarantine` is called here, after the sweep,
 * under its own switch — the sweep core never calls it, and must not start doing
 * so: report mode's "mutates nothing" claim is only checkable while the
 * irreversible stage is unreachable from the sweep.
 *
 * ── Three refusals, all BEFORE `initFirebase()` ──────────────────────────────
 *
 * A misconfiguration that makes a source unreadable is far worse here than a
 * crash, because it does not look like a failure — it looks like a *successful*
 * run over a tenant that turned out to be entirely unreferenced:
 *
 *  - **No `FIREBASE_DATABASE_URL`** ⇒ no Realtime Database handle ⇒ no chat
 *    reference enumeration ⇒ the whole of `chat-files/{tenantId}/`, the largest
 *    prefix in the bucket, reads as orphaned. Refused with an explanatory error
 *    before init, before any Object_Listing and before any read (Req 5.7),
 *    following `tenantUsageRollup.collectChatActivity`'s precedent.
 *  - **No `FIREBASE_STORAGE_BUCKET`** ⇒ an unnamed bucket ⇒ every stored
 *    reference resolves as `foreign_bucket` and the retain set is empty. The core
 *    already refuses this; refusing here too keeps the failure explanatory rather
 *    than a raw SDK throw, and keeps every gate in the runner.
 *  - **A reference ceiling whose retain set cannot fit the observed Heap_Limit**
 *    ⇒ the documented `reference_cap_exceeded` abort could not fire, because the
 *    container is killed first: exit 137, no Report_Document, no explanation. The
 *    third refusal is the newest and the least obvious, and it is the one that
 *    converts an unexplained kill into a start-up error naming the four numbers
 *    involved (Req 8.6). Appended AFTER the two above so their messages and their
 *    order are untouched (Req 11.2).
 *
 * ── The Run_Lease, acquired AFTER `initFirebase()` and before any read ──────
 *
 * The three refusals above happen before Firebase exists; the lease needs a
 * Firestore handle, so it is acquired immediately after `initFirebase()` and before
 * the Reference_Collector reads anything for the first tenant (Req 5.1). It is taken
 * in **both** modes and regardless of `force` (Req 5.13, 5.14), because the
 * Report_Document's resume cursor and counters are written in both modes and are
 * last-writer-wins — so an overlapping Report_Mode run can move another execution's
 * cursor backward without moving a byte.
 *
 * Three outcomes, and the exit codes are the whole point (Req 5.21):
 *
 *  - **granted** ⇒ sweep, renew once per tenant, release in a `finally`;
 *  - **declined** (an unexpired lease is held) ⇒ list nothing, sweep nothing,
 *    **exit 0**. Another execution is doing the work, so nothing was skipped.
 *    Visible through `lease_total{outcome:'contended'}`, which is alerted on
 *    precisely because a run that is always declined looks, from the
 *    Report_Documents alone, exactly like one that is quietly succeeding;
 *  - **failed** (the transaction threw — a Firestore outage, a permission change on
 *    the Lease_Namespace) ⇒ list nothing, sweep nothing, **exit non-zero** via
 *    `main().catch`. There is deliberately no fallback to sweeping leaseless: that
 *    would reintroduce the overlap the lease prevents, at the moment Firestore is
 *    least healthy (Req 5.20, 5.22).
 *
 * Suggested rollout (the maintainer-performed sequence is spec task 12): leave
 * disabled → enable once in report mode and read `countsBySource` and
 * `sampleOrphanPaths` by eye → apply with a low
 * `STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT` and restore one object by hand
 * → raise the ceiling → enable the purge only after the retention window has
 * passed. Rollback at any point: `STORAGE_ORPHAN_SWEEP_ENABLED=0`.
 */

import 'dotenv/config';
// Node's built-in heap statistics. The Heap_Limit is read HERE, at start-up, and
// handed to `decideStartup` as a value (Req 8.5) — a built-in, so no dependency is
// added and the reading costs one native call before anything is initialised.
import v8 from 'node:v8';
import admin from 'firebase-admin';

import { initFirebase, shutdownFirebase } from './tenantUsageRollup';
import {
  DEFAULT_FIRESTORE_PAGE_SIZE,
  DEFAULT_MAX_QUARANTINE_PER_TENANT,
  DEFAULT_MAX_REFERENCES,
  DEFAULT_PAGE_SIZE,
  // ── The metric emitter, imported rather than reimplemented (Req 10.3) ─────────
  //
  // The Run_Lease's `acquired` and `contended` outcomes are emitted from HERE,
  // because acquisition happens in the runner — before the core is entered at all —
  // and the lease module's own documented property is that it performs one
  // transaction on one document and owns no observability concern. `emitSweepMetric`
  // and `SweepMetricLabels` were made `export` for exactly these two call sites.
  //
  // The alternative was a third hand-rolled `console.log(JSON.stringify(...))` here,
  // and it is REJECTED: Req 10.3 requires the single-line JSON shape the deployed
  // `infra/monitoring/` filters match to be *inherited rather than reimplemented*,
  // and a copy of that shape is precisely how it drifts away from a filter that no
  // deploy can update transactionally.
  emitSweepMetric,
  mintSweepId,
  purgeExpiredQuarantine,
  quarantineObject,
  runStorageOrphanSweep,
  type StorageOrphanSweepRunResult,
  type SweepBucket,
  type SweepConfig,
} from './storageOrphanSweep';
// The Run_Lease. Imported by the RUNNER, never by the core: the import direction is
// lease → core and runner → both, so the core stays structurally incapable of
// depending on the mechanism whose whole point is that no guarantee depends on it
// (Req 5.16).
import {
  DEFAULT_RUN_LEASE_MS,
  acquireRunLease,
  clampRunLeaseMs,
  runLeasePath,
} from './storageOrphanSweepLease';
import { metricNames } from '../metrics';
import { DEFAULT_GRACE_DAYS, DEFAULT_QUARANTINE_RETENTION_DAYS } from '../lib/orphanDecision';
import {
  DEFAULT_QUARANTINE_WRITE_THRESHOLD,
  DEFAULT_REPORT_WRITE_PAGE_INTERVAL,
  DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS,
  decideReferenceCeilingHeadroom,
  estimateRetainSetFootprintBytes,
  resolveQuarantineWriteThreshold,
} from '../lib/sweepScaleLimits';

/** The environment shape the parsing seams read, so a test needs no `process.env`. */
export type RunnerEnv = Record<string, string | undefined>;

/**
 * Everything the runner decided from the environment, before anything is read.
 *
 * `tenantIds` is `'all_active'` or an explicit allow-list — and in both cases the
 * identifier reaching a listing prefix or a scope check comes from here or from
 * the active-tenant query, never from a value read out of a record (Req 4.11).
 */
export interface StorageOrphanSweepRunnerConfig {
  enabled: boolean;
  apply: boolean;
  purgeEnabled: boolean;
  force: boolean;
  graceDays: number;
  quarantineRetentionDays: number;
  maxQuarantinePerTenant: number;
  pageSize: number;
  maxReferences: number;
  /**
   * Documents per Firestore page for the seven Reference_Sources and for the
   * active-tenant query (`STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE`).
   *
   * Parsed by `parsePositiveIntEnv`, which falls back to
   * `DEFAULT_FIRESTORE_PAGE_SIZE` rather than to zero for a non-finite,
   * non-positive or unparseable value (Req 3.13) — a resolved zero would make every
   * page empty and every reference invisible, which is the direction that reports a
   * whole tenant as orphaned.
   */
  firestorePageSize: number;
  /**
   * The Report_Document write cadence
   * (`STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES`,
   * `STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS`).
   *
   * The page count is the **upper** bound on write frequency, the millisecond count
   * the **lower** bound (Reqs 7.1, 7.2). Both parse through `parsePositiveIntEnv`,
   * which falls back to the documented default rather than to zero (Req 7.12), and
   * both are **mode-independent** (Req 7.16): there is no Report_Mode override and
   * none may be added, because a Report_Mode tenant with a million objects is the
   * case the batching exists for.
   */
  reportWritePages: number;
  reportWriteMs: number;
  /**
   * Objects quarantined since the last Report_Document write that force one
   * (`STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD`, Req 7.3).
   *
   * Counted in **objects**, which is what makes its bound a bound: the persisted
   * `quarantinedCount` a resume inherits lags the objects actually moved by fewer
   * than this, so a crash-and-resume pair overshoots the per-tenant Quarantine
   * ceiling by at most this threshold (Req 7.22), and the Apply_Mode writes
   * attributable to moves are at most `ceil(M / T)` — independently of the listing
   * page size and of how the moved objects are distributed across pages (Req 7.9).
   *
   * Mode-independent like the two intervals (Req 7.16): it is simply unreachable in
   * a mode that moves no object.
   *
   * ── Resolved to at least 1, and the floor is NOT belt-and-braces (Req 7.21) ──
   *
   * `parsePositiveIntEnv` already refuses a non-finite, non-positive or
   * truncate-to-zero value, so the floor below is unreachable through the
   * environment today — but it is applied anyway, because the failure a resolved `0`
   * produces is the **opposite** of the one it looks like. A `0` does not suppress
   * the move-driven write: `shouldWriteTenantReport` checks
   * `movedSinceWrite >= threshold` **first and unconditionally**, and
   * `movedSinceWrite` is never negative, so `0` holds at **every** evaluation and
   * forces a Report_Document write on every move, every page boundary and every
   * terminal event alike. That is the one-write-per-page contention on the single
   * document the resume cursor lives on — the write storm this whole requirement
   * exists to eliminate, reintroduced by a configuration that merely looks unusual.
   */
  quarantineWriteThreshold: number;
  /**
   * The Run_Lease duration, in milliseconds
   * (`STORAGE_ORPHAN_SWEEP_LEASE_MS`, Req 5.11). Both Cloud Run Job definitions set
   * `2700000`, which is `DEFAULT_RUN_LEASE_MS`.
   *
   * Parsed by `parsePositiveIntEnv`, so a non-finite, non-positive, unparseable or
   * truncate-to-zero value falls back to the documented 45 minutes rather than to
   * zero — and a resolved zero here would be a lease that had already expired at the
   * instant it was written, i.e. no lease at all while appearing to be one.
   *
   * ── The value here is the CONFIGURED one; the clamp lives in the lease module ──
   *
   * `clampRunLeaseMs` is what bounds it to `[5 min, 6 h]`, and it is stated once,
   * beside the document it bounds and beside `DEFAULT_RUN_LEASE_MS`'s own comparison
   * against the manifests' `timeoutSeconds`. `main()` resolves through it exactly
   * once and records the resolved number both in the start-up log and in the
   * Report_Document's `params.leaseMs`, so no layer restates the clamp — the same
   * "one rule in one place" discipline `resolveQuarantineWriteThreshold` exists for.
   */
  leaseMs: number;
  tenantIds: string[] | 'all_active';
  databaseUrl: string;
  storageBucket: string;
  runnerId: string;
}

/**
 * What the runner does about a config, as a value, so the gates are assertable
 * without spawning a process (task 10.5).
 *
 *  - `skip` — not enabled: log and exit 0, with **no** Firebase initialisation.
 *  - `refuse` — a misconfiguration that would look like a successful run: throw
 *    before `initFirebase()`.
 *  - `run` — proceed, in the resolved mode.
 */
export type StorageOrphanSweepStartupDecision =
  | { action: 'skip'; reason: string; message: string }
  | {
      action: 'refuse';
      reason:
        | 'missing_database_url'
        | 'missing_storage_bucket'
        // Req 8.6. APPENDED to the union, and its check is appended after the two
        // above, so neither of their messages nor their order changes (Req 11.2).
        | 'reference_ceiling_exceeds_heap';
      message: string;
    }
  | { action: 'run'; mode: 'report' | 'sweep'; apply: boolean; purgeEnabled: boolean };

/**
 * The Heap_Limit this process believes it may use, in bytes (Req 8.5).
 *
 * ── Why it is a seam, and why the seam is here rather than inside the gate ────
 *
 * `decideStartup` must stay a pure function of its arguments — it is the one place
 * every gate lives, and a gate that reads the process is a gate no test can drive.
 * So the *reading* happens here, once, and travels into the decision as a number.
 * A test asserts the refusal by passing a limit; nothing has to make a real heap
 * small.
 *
 * ── What the number actually means, which is the whole reason it is logged ────
 *
 * `heap_size_limit` reports what **V8 believes** it may use, not what the container
 * allows. With no `--max-old-space-size`, V8 derives it from *system* memory —
 * which on Cloud Run is the **host's**, not the cgroup's — so a `512Mi` container
 * can report a limit near 2 GB and every heap comparison this job makes is against
 * a fiction. Both Cloud Run Job definitions therefore declare
 * `NODE_OPTIONS=--max-old-space-size=896` under a `1Gi` limit, and this reading is
 * logged at start-up (Req 8.14) precisely so an operator can tell whether the
 * declaration reached the process: a logged limit near 2 GB on a `1Gi` container
 * means it did not.
 *
 * Total. `NaN` for an unreadable statistic, which `decideReferenceCeilingHeadroom`
 * treats as `heap_limit_unreadable` and **refuses** on: a limit we cannot read is a
 * limit we cannot check against, and the failure this exists to prevent is
 * precisely the one that looks like a successful start.
 */
export function readHeapLimitBytes(): number {
  try {
    const limit = v8.getHeapStatistics().heap_size_limit;
    return typeof limit === 'number' ? limit : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * Only `1`, `true` and `yes` are true (Req 10.10), case-insensitively and after
 * trimming. Everything else — including `on`, `y`, `TRUE-ish` typos, an empty
 * string and an unset variable — is the fallback, which for every switch this job
 * has is `false`.
 */
export function parseBooleanEnv(value: string | undefined | null, fallback: boolean): boolean {
  if (value === undefined || value === null || value.trim().length === 0) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

/**
 * A positive integer, or the documented default — **never zero** (Req 10.11).
 *
 * The truncation is checked as well as the parse, which is the difference that
 * matters: `Number('0.5')` is finite and positive, and `Math.trunc(0.5)` is `0`.
 * A `graceDays` of `0` would report every unreferenced object regardless of age,
 * turning the grace period — the thing that protects the non-atomic gap between a
 * successful upload and its record write — silently off.
 */
export function parsePositiveIntEnv(value: string | undefined | null, fallback: number): number {
  if (value === undefined || value === null || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  const truncated = Math.trunc(parsed);
  return truncated > 0 ? truncated : fallback;
}

/**
 * The comma-separated allow-list, or `'all_active'` when it is empty.
 *
 * Duplicates and blank entries are dropped here rather than left for the core, so
 * the logged tenant count is the number of tenants that will actually be swept.
 */
export function parseTenantIdsEnv(value: string | undefined | null): string[] | 'all_active' {
  if (value === undefined || value === null) return 'all_active';
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return ids.length > 0 ? ids : 'all_active';
}

/** Load every gate from the environment. Pure in `env`, so a test can stub it. */
export function loadRunnerConfig(env: RunnerEnv = process.env): StorageOrphanSweepRunnerConfig {
  return {
    // Opt-in: default OFF. Only an explicit 1/true/yes enables the job.
    enabled: parseBooleanEnv(env.STORAGE_ORPHAN_SWEEP_ENABLED, false),
    // The destructive switch: default OFF. Absent ⇒ report mode.
    apply: parseBooleanEnv(env.STORAGE_ORPHAN_SWEEP_APPLY, false),
    // The IRREVERSIBLE switch, independent of the one above: default OFF.
    purgeEnabled: parseBooleanEnv(env.STORAGE_ORPHAN_SWEEP_PURGE_ENABLED, false),
    force: parseBooleanEnv(env.STORAGE_ORPHAN_SWEEP_FORCE, false),
    graceDays: parsePositiveIntEnv(env.STORAGE_ORPHAN_SWEEP_GRACE_DAYS, DEFAULT_GRACE_DAYS),
    quarantineRetentionDays: parsePositiveIntEnv(
      env.STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS,
      DEFAULT_QUARANTINE_RETENTION_DAYS
    ),
    maxQuarantinePerTenant: parsePositiveIntEnv(
      env.STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT,
      DEFAULT_MAX_QUARANTINE_PER_TENANT
    ),
    pageSize: parsePositiveIntEnv(env.STORAGE_ORPHAN_SWEEP_PAGE_SIZE, DEFAULT_PAGE_SIZE),
    maxReferences: parsePositiveIntEnv(
      env.STORAGE_ORPHAN_SWEEP_MAX_REFERENCES,
      DEFAULT_MAX_REFERENCES
    ),
    firestorePageSize: parsePositiveIntEnv(
      env.STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE,
      DEFAULT_FIRESTORE_PAGE_SIZE
    ),
    reportWritePages: parsePositiveIntEnv(
      env.STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES,
      DEFAULT_REPORT_WRITE_PAGE_INTERVAL
    ),
    reportWriteMs: parsePositiveIntEnv(
      env.STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS,
      DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS
    ),
    // Two obligations, in order, and the middle one is the point: `parsePositiveIntEnv`
    // applies Req 7.20's rule for a string environment value — including the
    // truncate-to-zero case, since `Number('0.5')` clears its finite-and-positive
    // guard and `Math.trunc(0.5)` is `0` — and `resolveQuarantineWriteThreshold` is the
    // pure module's own statement of that same rule, which the Sweep_Core's resolver
    // also calls. It is the IDENTITY on what the parser returns today, because the
    // parser already returns a positive integer or the default. It is applied anyway so
    // the rule lives in ONE place: the core resolver drifted from it once, resolving a
    // configured `0.5` to `1` instead of `25`, and a future edit to the shared numeric
    // parser cannot reintroduce that divergence here without failing there too.
    //
    // The floor at 1 is the separate Req 7.21 and STAYS: it is what makes a resolved
    // `0` unreachable by any path, and a resolved `0` is a write STORM rather than a
    // suppressed write — see the field's doc comment. It is a backstop, never a
    // substitute for the fallback to the documented default above.
    quarantineWriteThreshold: Math.max(
      1,
      resolveQuarantineWriteThreshold(
        parsePositiveIntEnv(
          env.STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD,
          DEFAULT_QUARANTINE_WRITE_THRESHOLD
        )
      )
    ),
    // The CONFIGURED lease duration. `main()` resolves it through the lease module's
    // `clampRunLeaseMs` exactly once; the clamp is deliberately not restated here.
    leaseMs: parsePositiveIntEnv(env.STORAGE_ORPHAN_SWEEP_LEASE_MS, DEFAULT_RUN_LEASE_MS),
    tenantIds: parseTenantIdsEnv(env.STORAGE_ORPHAN_SWEEP_TENANT_IDS),
    databaseUrl: (env.FIREBASE_DATABASE_URL || '').trim(),
    storageBucket: (env.FIREBASE_STORAGE_BUCKET || '').trim(),
    runnerId:
      (env.STORAGE_ORPHAN_SWEEP_RUNNER_ID || '').trim() ||
      (env.GITHUB_SHA || '').trim() ||
      (env.USER || '').trim() ||
      (env.USERNAME || '').trim() ||
      'local-dev',
  };
}

/**
 * The gate, as a pure function of the config and the Heap_Limit reading.
 *
 * Ordered deliberately: the enable check comes FIRST, so a disabled job is a
 * no-op even in an environment that is missing everything else. A disabled job
 * must not fail; it must do nothing.
 *
 * ── The third refusal is APPENDED, and the order is a requirement ─────────────
 *
 * `reference_ceiling_exceeds_heap` is checked **after** the two existing refusals,
 * so neither of their messages nor their relative order changes (Req 11.2), and
 * after `enabled` for the same reason the other two are: a disabled job must not
 * fail on a ceiling it is never going to use.
 *
 * ── `heapLimitBytes` is a READING, and omitting it means "none was taken" ─────
 *
 * The parameter carries the reading `readHeapLimitBytes()` produced. It is optional
 * because "no reading was taken" and "the limit is unreadable" are different facts:
 * an unusable *reading* — `NaN`, `0`, a negative — is evidence about the process and
 * **refuses** (`heap_limit_unreadable`, Req 8.6), whereas no reading at all is a
 * caller that is not asking this question, and the decision is then exactly the
 * shipped one. `main()` below is the only production caller and it always reads,
 * unconditionally, so the omitted case is not reachable in a deployed run.
 *
 * Pure in its inputs whichever way it is called: no clock, no `v8`, no I/O.
 */
export function decideStartup(
  config: StorageOrphanSweepRunnerConfig,
  heapLimitBytes?: number
): StorageOrphanSweepStartupDecision {
  if (!config.enabled) {
    return {
      action: 'skip',
      reason: 'disabled',
      message:
        'disabled — set STORAGE_ORPHAN_SWEEP_ENABLED=1 to run (no Firebase init, no listing, no reads, no mutations)',
    };
  }
  if (!config.databaseUrl) {
    return {
      action: 'refuse',
      reason: 'missing_database_url',
      message:
        'Realtime Database is not configured; set FIREBASE_DATABASE_URL. Chat attachments are referenced ONLY from the Realtime Database, so a sweep without it would report the whole of chat-files/ as orphaned. Refusing to start.',
    };
  }
  if (!config.storageBucket) {
    return {
      action: 'refuse',
      reason: 'missing_storage_bucket',
      message:
        'Storage bucket is not configured; set FIREBASE_STORAGE_BUCKET. An unnamed bucket resolves every stored reference as foreign and would report an entire tenant as orphaned. Refusing to start.',
    };
  }
  // ── Req 8.6: a ceiling whose retain set provably cannot fit refuses to start ──
  //
  // The predicate is the pure `decideReferenceCeilingHeadroom` — NOT reimplemented
  // here — so the arithmetic that justifies the ceiling lives in one place and is
  // property-tested without a process. It deliberately applies NO Heap_Guard_Floor:
  // it compares a computed ESTIMATE, and a ceiling that cannot fit the declared
  // limit must refuse whether the estimate is 20 MB or 2 GB. The floor qualifies a
  // used-heap MEASUREMENT and belongs only to the mid-collection guard.
  //
  // Refusing is the safe direction and the honest one. The shipped default of
  // 2,000,000 against a `512Mi` container is exactly the configuration this catches:
  // it produced an exit-137 container kill in place of the documented
  // `reference_cap_exceeded` abort, i.e. a tenant with no Report_Document and no
  // explanation. Better to fail at start-up, having initialised nothing.
  if (heapLimitBytes !== undefined) {
    const headroom = decideReferenceCeilingHeadroom({
      maxReferences: config.maxReferences,
      heapLimitBytes,
    });
    if (!headroom.ok) {
      return {
        action: 'refuse',
        reason: 'reference_ceiling_exceeds_heap',
        // All four numbers, because the verdict alone tells an operator nothing
        // actionable: the ceiling is what they can lower, the estimate is what it
        // costs, the guard is what it had to fit inside, and the observed limit is
        // how they find out whether NODE_OPTIONS reached the process.
        message:
          headroom.reason === 'heap_limit_unreadable'
            ? `Heap limit is unreadable (observed ${headroom.heapLimitBytes}); cannot verify that the reference ceiling of ${config.maxReferences} paths (estimated ${headroom.estimateBytes} bytes) fits. A limit we cannot read is a limit we cannot check against. Refusing to start.`
            : `Reference ceiling of ${config.maxReferences} paths is estimated at ${headroom.estimateBytes} bytes, which exceeds the heap guard of ${headroom.guardBytes} bytes (observed heap limit ${headroom.heapLimitBytes} bytes). The documented reference_cap_exceeded abort could not fire before the process ran out of heap. Lower STORAGE_ORPHAN_SWEEP_MAX_REFERENCES or raise the container memory limit and --max-old-space-size. Refusing to start.`,
      };
    }
  }
  return {
    action: 'run',
    // `apply` is what makes it a sweep. Absent ⇒ report mode (Req 10.9).
    mode: config.apply ? 'sweep' : 'report',
    apply: config.apply,
    purgeEnabled: config.purgeEnabled,
  };
}

/**
 * The run's exit code, as a value (Req 2.1).
 *
 * Exported as a pure seam for the same reason `decideStartup` is: `main()` is
 * reachable only under `require.main === module`, so a decision left inline in it
 * is a decision no test can assert without spawning a process — and asserting it by
 * mutating `process.exitCode` inside a test runner would leak into the runner's own
 * exit status.
 *
 * ── The asymmetry is deliberate ────────────────────────────────────────────────
 *
 * A run in which every tenant `aborted` exits **zero**, and for every one of the
 * five abort reasons alike — `reference_source_failed`, `malformed_reference`,
 * `reference_cap_exceeded`, `quarantine_cap_reached` and `tenant_scope_violation`
 * (Req 2.2). An abort is a designed safe outcome, not a failure.
 * `tenant_scope_violation` is the one a reader will most want to make red and is
 * the clearest case for green: it is the Scope_Guard *working*, catching a
 * derivation this code produced before a single byte moved, and making it red would
 * train an operator to treat a functioning safety guard as an incident.
 *
 * Only "we were asked to sweep this tenant and could not" is red. So the predicate
 * reads `tenantFailures`, which counts Tenant_Sweep_Failures — results recorded
 * `status: 'failed'` — and `leaseLost`, and nothing else.
 *
 * ── The second input, and why a LOST lease is red where a DECLINED one is green ──
 *
 * `leaseLost` is Req 5.9: a renewal read a foreign Lease_Token, so the loop stopped
 * and the tenants after it were never started. That is the same shape as a tenant
 * failure — we were asked to sweep and did not — so it is red.
 *
 * A *declined* acquisition is the opposite and exits **zero** (Req 5.4), and it does
 * so without reaching this function at all: `main()` returns before the core is
 * entered, so there is no run result to score. Another execution is doing the work,
 * so nothing was skipped. Those two outcomes are the pair Req 5.21 requires to stay
 * distinct, and the third — a *failed* acquisition — is a thrown transaction that
 * reaches `main().catch` (Req 5.20), so it too never reaches here.
 *
 * `leaseLost` is `Partial` in the parameter type rather than required, so a caller
 * that predates the Run_Lease still type-checks and still gets the shipped verdict.
 * The check is written `=== true` rather than left to truthiness so an absent field
 * cannot be mistaken for a lease that was lost.
 */
export function sweepRunExitCode(
  result: Pick<StorageOrphanSweepRunResult, 'tenantFailures'> &
    Partial<Pick<StorageOrphanSweepRunResult, 'leaseLost'>>
): 0 | 1 {
  return result.tenantFailures > 0 || result.leaseLost === true ? 1 : 0;
}

function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[orphan_sweep_runner] ${message}`, extra);
  } else {
    console.log(`[orphan_sweep_runner] ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadRunnerConfig();
  // Read BEFORE the gate, so the ceiling check happens before `initFirebase()` and
  // therefore before Storage, Firestore or the Realtime Database is touched and
  // before any lease could be acquired (Req 8.5, 8.6).
  const heapLimitBytes = readHeapLimitBytes();
  const footprintEstimateBytes = estimateRetainSetFootprintBytes(config.maxReferences);
  const decision = decideStartup(config, heapLimitBytes);

  // Not enabled ⇒ say so and stop, with no Firebase app, no bucket handle and no
  // read of any kind (Req 10.8).
  if (decision.action === 'skip') {
    log(decision.message);
    return;
  }
  // Refused BEFORE `initFirebase()`, so the process cannot have touched Storage,
  // Firestore or the Realtime Database by the time it fails (Req 5.7).
  if (decision.action === 'refuse') {
    throw new Error(decision.message);
  }

  // ONE clock read for the whole run, passed into the config and reused by the
  // purge stage, so a multi-hour sweep judges its last page by the same grace
  // cutoff as its first (Req 2.3, 2.4).
  const nowMs = Date.now();

  // ── The run's Sweep_Id is minted HERE, not by the core, and the reason is an
  //    ordering rather than a preference ────────────────────────────────────────
  //
  // The Run_Lease document records the Sweep_Id (`RunLeaseDoc.sweepId`) so a
  // Report_Document and the lease that produced it can be tied together — and the
  // lease is acquired before the core is entered (Req 5.1), so the id has to exist
  // before then. `mintSweepId` is imported rather than reimplemented because its
  // format is a constraint: a single plain path segment, since `buildQuarantinePath`
  // interpolates it.
  const sweepId = mintSweepId(nowMs);

  // The clamp is applied ONCE, here, through the lease module's own rule (Req 5.11).
  // Everything downstream — the log line, `acquireRunLease`, and the report's
  // `params.leaseMs` — reads this one resolved number, so no layer restates the
  // clamp and the recorded value is the duration actually in force.
  const leaseMs = clampRunLeaseMs(config.leaseMs);

  log('starting job', {
    mode: decision.mode,
    apply: decision.apply,
    dryRun: !decision.apply,
    purgeEnabled: decision.purgeEnabled,
    graceDays: config.graceDays,
    quarantineRetentionDays: config.quarantineRetentionDays,
    pageSize: config.pageSize,
    maxQuarantinePerTenant: config.maxQuarantinePerTenant,
    maxReferences: config.maxReferences,
    // ── Req 8.14: the ceiling, what it costs, and what it had to fit inside ─────
    //
    // Logged together on purpose. `footprintEstimateBytes` makes the ceiling's real
    // price visible without an operator having to know the 232 bytes per path, and
    // `heapLimitBytes` is the OBSERVED limit — the one number that tells them whether
    // `NODE_OPTIONS=--max-old-space-size=896` reached the process. A limit near 2 GB
    // logged by a `1Gi` container means it did not, and every heap comparison this
    // run makes is then against a fiction. Read this line FIRST when verifying a
    // deploy (spec task 12).
    footprintEstimateBytes,
    heapLimitBytes,
    firestorePageSize: config.firestorePageSize,
    reportWritePages: config.reportWritePages,
    reportWriteMs: config.reportWriteMs,
    quarantineWriteThreshold: config.quarantineWriteThreshold,
    // The RESOLVED lease duration, and the document it will contend on. The
    // Lease_Token and the Lease_Expiry cannot ride on this line: both are produced by
    // the acquisition, which must happen after `initFirebase()` — so they are logged
    // by the `lease acquired` line below, which is still part of the start-up
    // sequence and still precedes every read (Req 5.17).
    leaseMs,
    leasePath: runLeasePath(),
    sweepId,
    tenantIds: config.tenantIds === 'all_active' ? 'all_active' : config.tenantIds.length,
    force: config.force,
    runnerId: config.runnerId,
    nowMs,
  });

  initFirebase();
  const db = admin.firestore();

  // Both handles are obtained eagerly and neither failure is tolerated: the
  // corresponding misconfiguration reads as "nothing is referenced", not as an
  // error. `FIREBASE_DATABASE_URL` was already checked above; this catch covers
  // the case where it is set but unusable.
  let rtdb: admin.database.Database;
  try {
    rtdb = admin.database();
  } catch (error) {
    throw new Error(
      `Realtime Database handle unavailable (FIREBASE_DATABASE_URL=${config.databaseUrl}): ${
        error instanceof Error ? error.message : String(error)
      }. Refusing to sweep without the chat reference source.`
    );
  }
  const bucket: SweepBucket = admin.storage().bucket();

  // ═══════════════════════════════════════════════════════════════════════════
  // The Run_Lease — acquired here, AFTER `initFirebase()` and BEFORE any read
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Req 5.1: before the Reference_Collector reads anything for the first tenant.
  // The handles above are constructed but nothing has been read or listed with
  // them yet, so this is the last point at which declining still prevents
  // everything.
  //
  // ── In BOTH modes (Req 5.13), and `force` does NOT exempt it (Req 5.14) ─────
  //
  // A Report_Mode run looks harmless and is not, for one reason: the
  // Report_Document's resume cursor and counters are written in **both** modes and
  // are last-writer-wins on a single document. So an overlapping Report_Mode
  // execution can move another execution's resume cursor **backward**, and leave a
  // report naming its own Sweep_Id while half the objects the other run moved sit
  // under a different Sweep_Id folder — all without moving a single byte itself.
  // `force` is the same argument: it changes which tenants are re-swept, not who
  // may write that document.
  //
  // ── NO `try` AROUND THIS, and that is the requirement (Req 5.20, 5.22) ──────
  //
  // A thrown transaction — a Firestore outage, a permission change on the
  // Lease_Namespace — propagates to `main().catch`, which logs and sets a non-zero
  // exit code, having listed nothing and swept no tenant. Wrapping this in a `try`
  // that fell back to sweeping without a lease would reintroduce exactly the
  // overlap the lease exists to prevent, at the moment Firestore is least healthy.
  //
  // A lease mechanism that cannot be **reached** stops the sweep rather than
  // proceeding without it. "Advisory" describes what the lease *guarantees* — no
  // correctness property of `storage-orphan-cleanup` depends on it — not whether it
  // may be skipped when acquiring it is inconvenient. **Once the lease is
  // installed** there is no path here that sweeps a tenant without a granted lease
  // (Req 5.22); the core's `renewRunLease` parameter stays optional for a different
  // reason, so that the parent spec's entire suite can run leaseless and Req 5.16
  // is true of the module graph.
  const lease = await acquireRunLease({
    db,
    runnerId: config.runnerId,
    sweepId,
    mode: decision.mode,
    leaseMs,
    nowMs,
  });

  if (!lease.ok) {
    // ── DECLINED, and therefore GREEN (Req 5.4, 5.5) ─────────────────────────
    //
    // The asymmetry with a Tenant_Sweep_Failure is the whole point: a failed tenant
    // means "we were asked to sweep this and could not", which is red. A declined
    // acquisition means **another execution is doing the work**, so nothing was
    // skipped — and a scheduled run that declines every time it overlaps a manual
    // one must not page anybody.
    //
    // What makes the decline *visible* despite being green is the metric, which is
    // why Req 10.11 alerts on it: a run that is ALWAYS declined is
    // indistinguishable, from the Report_Documents alone, from a run that is
    // quietly succeeding.
    //
    // Note what does NOT happen below: no `runStorageOrphanSweep`, so no
    // Object_Listing and no tenant swept; and no purge stage either, because the
    // holder's own run will reach its own purge. `return` rather than `throw`, and
    // `process.exitCode` is left exactly as it was found.
    emitSweepMetric(
      metricNames.storageOrphanSweepLease,
      { mode: decision.mode, outcome: 'contended' },
      1,
      'WARNING'
    );
    log('DECLINED — an unexpired run lease is held by another execution', {
      leasePath: runLeasePath(),
      heldByRunnerId: lease.heldBy.runnerId,
      heldUntilMs: lease.heldBy.expiresAtMs,
      heldUntilIso: Number.isFinite(lease.heldBy.expiresAtMs)
        ? new Date(lease.heldBy.expiresAtMs).toISOString()
        : null,
      nowMs,
      // Stated rather than implied: this is the green outcome, and an operator
      // reading the log should not have to infer that from the absence of an error.
      swept: 'nothing — no listing was performed; exiting 0',
    });
    return;
  }

  emitSweepMetric(metricNames.storageOrphanSweepLease, { mode: decision.mode, outcome: 'acquired' }, 1);
  // ── Req 5.17: the Lease_Token and the Lease_Expiry, at start-up ─────────────
  //
  // Its own line rather than a field on `starting job`, because that line is emitted
  // before `initFirebase()` and neither value exists until the acquisition above.
  // This is still the start-up sequence and still precedes every read.
  //
  // Logging the token is safe: it is a **fence, not a credential**. Holding it
  // grants no access to anything — it only identifies which execution may renew or
  // release this lease, an authority anyone who can read this log already has over
  // the Maintenance_Namespace. Its operator value is diagnostic: a Report_Document
  // whose `leaseToken` differs from the one on this line was written by another
  // execution.
  log('run lease acquired', {
    leasePath: runLeasePath(),
    token: lease.handle.token,
    expiresAtMs: lease.handle.expiresAtMs,
    expiresAtIso: new Date(lease.handle.expiresAtMs).toISOString(),
    leaseMs,
    sweepId,
    mode: decision.mode,
  });

  const sweepConfig: SweepConfig = {
    tenantIds: config.tenantIds,
    mode: decision.mode,
    apply: decision.apply,
    graceDays: config.graceDays,
    quarantineRetentionDays: config.quarantineRetentionDays,
    pageSize: config.pageSize,
    maxQuarantinePerTenant: config.maxQuarantinePerTenant,
    maxReferences: config.maxReferences,
    firestorePageSize: config.firestorePageSize,
    reportWritePages: config.reportWritePages,
    reportWriteMs: config.reportWriteMs,
    quarantineWriteThreshold: config.quarantineWriteThreshold,
    // Req 8.13 — the OBSERVED limit, forwarded so every Report_Document records what
    // the start-up check of Req 8.6 was decided against. The core normalises an
    // unusable reading to `null` rather than substituting a default; it compares
    // against nothing here, because the mid-collection guard takes its own reading.
    heapLimitBytes,
    // The RESOLVED lease duration and the holding execution's Lease_Token, forwarded
    // so every Report_Document records the lease in force and WHICH execution wrote
    // it (`params.leaseMs`, root `leaseToken`). The core echoes both rather than
    // resolving either, because resolving would mean importing the lease module and
    // the import direction is lease → core (Req 5.16).
    leaseMs,
    leaseToken: lease.handle.token,
    // Minted above so the Run_Lease and every Report_Document this run writes name
    // the same Sweep_Id.
    sweepId,
    force: config.force,
    runnerId: config.runnerId,
    nowMs,
  };

  // ── Everything from here is under the lease, and the lease is released in a
  //    `finally` on BOTH completion and failure (Req 5.6) ───────────────────────
  //
  // The `finally` is what makes the release unconditional, and it is safe to call
  // even when the run ended because the lease was FENCED: `release` is transactional
  // and a no-op unless the recorded Lease_Token is still ours (Req 5.7), so a fenced
  // execution finds a foreign token and deletes nothing — leaving the document
  // exactly as its current holder recorded it (Req 5.19). Releasing a lease we no
  // longer hold would strip the new holder of the exclusivity it legitimately
  // acquired and manufacture the overlap this whole mechanism exists to prevent.
  try {
    const result = await runStorageOrphanSweep({
      db,
      rtdb,
      bucket,
      config: sweepConfig,
      // Passed EXPLICITLY, and unconditionally: the core throws rather than report a
      // `completed` destructive run that moved nothing when apply mode is requested
      // with no mover installed. Report mode never calls it.
      quarantineObject,
      // ── The ONLY lease coupling the core has (Req 5.8, 5.16) ────────────────
      //
      // A zero-argument callback, not a handle: the core checks that the recorded
      // Lease_Token is still ours as the first statement of each tenant iteration
      // and knows nothing else about the lease. `renew` re-reads the token on every
      // call and either extends or fences, so it is safe to call once per tenant.
      //
      // Bound to the handle rather than passed as `lease.handle.renew`, because that
      // method closes over the handle to update `expiresAtMs` and would lose its
      // receiver if detached.
      renewRunLease: () => lease.handle.renew(),
      // `invalidateLiveCount` is deliberately NOT wired. See the note below.
    });

    for (const tenant of result.tenants) {
      // Counts, reasons and the tenant id only — no object path, no filename, no
      // email, no download token (Req 16.8, 16.9, 16.10). The bounded
      // `sampleOrphanPaths` an operator reads by eye lives on the Report_Document,
      // which is access-controlled; the log line does not carry it.
      log('tenant finished', {
        tenantId: tenant.tenantId,
        status: tenant.status,
        abortReason: tenant.abortReason ?? null,
        objectsScanned: tenant.objectsScanned,
        retainedByReason: tenant.retainedByReason,
        orphanCount: tenant.orphanCount,
        orphanBytes: tenant.orphanBytes,
        quarantinedCount: tenant.quarantinedCount,
        quarantinedBytes: tenant.quarantinedBytes,
        quarantineFailures: tenant.quarantineFailures,
        danglingReferenceCount: tenant.danglingReferenceCount,
        usageBytesBefore: tenant.usageBytesBefore,
        usageBytesAfter: tenant.usageBytesAfter,
        usageError: tenant.usageError ?? null,
      });
    }

    // ── One line per Tenant_Sweep_Failure (Req 2.3) ──────────────────────────
    //
    // The tenant id and the coerced message, and NOTHING else: no object path, no
    // filename, no email address, no download token (Req 16.8, 16.9, 16.10). The
    // predicate is `status === 'failed'`, not `'in_progress'` — after the per-tenant
    // confinement the core returns `'in_progress'` for no tenant at all, so a result
    // carrying it would be a bug rather than a case to handle here.
    for (const tenant of result.tenants) {
      if (tenant.status !== 'failed') continue;
      log('tenant FAILED — not swept', {
        tenantId: tenant.tenantId,
        message: tenant.failureMessage ?? null,
      });
    }

    // ── The Run_Lease was lost mid-run (Req 5.9, 5.18, 5.19) ─────────────────
    //
    // Its own line, because the run summary below reads as a complete run and this
    // one is not: the tenants after the fenced iteration were never started. The
    // core has already emitted `lease_total{outcome:'lost'}` at WARNING at the
    // instant of the reading; this line is what an operator finds in the job's own
    // log.
    //
    // Reaching this means either a second execution acquired an expired lease —
    // which needs a task that outlived `timeoutSeconds`, something the platform does
    // not permit — or someone edited the lease document by hand. Both are worth
    // understanding before another destructive run starts.
    if (result.leaseLost) {
      log('run lease LOST — no further tenant was started', {
        token: lease.handle.token,
        leasePath: runLeasePath(),
        tenantsSwept: result.tenants.length,
        // The release in the `finally` below is a token-matched no-op, so the
        // document is left exactly as its current holder recorded it (Req 5.19).
        leaseDocument: 'left untouched — release is a no-op for a foreign token',
      });
    }

    // Req 2.4. `failed` reads off the core's own count rather than being recomputed,
    // so the number in the log and the number driving the exit code are the same one.
    log('run summary', {
      sweepId: result.sweepId,
      tenants: result.tenants.length,
      completed: result.tenants.filter((tenant) => tenant.status === 'completed').length,
      aborted: result.tenants.filter((tenant) => tenant.status === 'aborted').length,
      failed: result.tenantFailures,
      leaseLost: result.leaseLost,
    });

    log(
      result.dryRun
        ? 'sweep finished (REPORT — no mutations performed)'
        : 'sweep finished (APPLIED — objects were quarantined)',
      {
        sweepId: result.sweepId,
        tenants: result.tenants.length,
        aborted: result.tenants.filter((tenant) => tenant.status === 'aborted').length,
        quarantinedCount: result.tenants.reduce((sum, tenant) => sum + tenant.quarantinedCount, 0),
      }
    );

    // ── Red, without throwing (Req 2.1) ──────────────────────────────────────
    //
    // Converting a throw into a recorded outcome is what lets the run continue past
    // one tenant's failure; converting it into a GREEN run is what would make the
    // confinement a regression. So the exit code is set and `main()` returns
    // normally:
    //
    //  - the purge stage below must still run for a partially failed run (Req 2.5) —
    //    the Quarantine_Purger's input domain is Quarantine paths only and is
    //    independent of any tenant's Object_Listing;
    //  - the `finally` below must still release the Run_Lease (Req 5.6);
    //  - `maxRetries: 0` in both Cloud Run Job definitions is unchanged, so retrying
    //    a partially applied sweep stays a human decision (Req 2.6).
    //
    // `main().catch` stays in place for genuinely unexpected failures — including the
    // two run-level precondition refusals, which still raise before the tenant loop
    // begins (Req 1.8), and a FAILED lease acquisition, which raises before this
    // `try` is entered at all (Req 5.20).
    //
    // Two inputs now: `tenantFailures` and `leaseLost` (Req 5.9). A DECLINED
    // acquisition never reaches here — it returned above with the exit status
    // untouched, which is the green half of Req 5.21.
    //
    // Assigned only when non-zero, so a green run leaves the process exit status
    // exactly as it found it.
    const exitCode = sweepRunExitCode(result);
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }

    // ── Stage 3, under its OWN switch, AFTER the sweep ───────────────────────
    //
    // A separate entrypoint invoked separately, on purpose. `runStorageOrphanSweep`
    // never calls `purgeExpiredQuarantine` and must not start doing so: report
    // mode's "no irreversible operation is reachable" claim (Property 6) holds
    // because the hard-delete stage is not reachable from the sweep at all, and
    // that is a structural argument this wiring must preserve.
    //
    // It still needs BOTH switches to delete: `purgeEnabled` gets it to list, and
    // `apply` gets it to delete rather than count (Req 12.6, 12.7). Redundant with
    // the GCS lifecycle rule in `infra/storage/quarantine-lifecycle.json`, which is
    // the mechanism that does not depend on this job running at all.
    //
    // It runs under the lease, which is correct rather than incidental: the purger
    // hard-deletes, and two executions purging the same expired Quarantine entries
    // concurrently is exactly the overlap the lease exists to prevent.
    if (decision.purgeEnabled) {
      const purge = await purgeExpiredQuarantine({
        bucket,
        db,
        purgeEnabled: true,
        apply: decision.apply,
        retentionDays: config.quarantineRetentionDays,
        pageSize: config.pageSize,
        nowMs,
      });
      log(
        purge.applied
          ? 'quarantine purge finished (APPLIED)'
          : 'quarantine purge finished (COUNTED ONLY)',
        {
          retentionDays: purge.retentionDays,
          examined: purge.examined,
          deleteEligible: purge.deleteEligible,
          deleted: purge.deleted,
          deletedBytes: purge.deletedBytes,
          retained: purge.retained,
          retainedByReason: purge.retainedByReason,
          failures: purge.failures,
        }
      );
    }
  } finally {
    // ── Req 5.6: released on completion AND on failure ───────────────────────
    //
    // Transactional and token-matched (Req 5.7), so this is a no-op for an execution
    // that was fenced — it finds a foreign token and deletes nothing, leaving the
    // document exactly as its current holder recorded it (Req 5.19).
    //
    // The release error is SWALLOWED, deliberately: a failed release must not mask
    // the run's own outcome, and it costs nothing to leave the document behind
    // because `expiresAtMs` makes an unreleased lease acquirable again within one
    // lease duration with no operator action (Req 5.12). That expiry is the only
    // liveness mechanism the lease has, and it is what makes swallowing here safe
    // rather than lazy.
    try {
      await lease.handle.release();
    } catch (error) {
      log('run lease release failed (ignored — the lease expires on its own)', {
        token: lease.handle.token,
        expiresAtMs: lease.handle.expiresAtMs,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// ─── OPEN QUESTION, RESOLVED: why `invalidateLiveCount` is not wired ─────────
//
// `sweepTenant` accepts an `invalidateLiveCount` callback and calls it in apply
// mode after writing `tenantStorageUsage` (Req 14.5). This runner passes NOTHING,
// and that is a decision rather than an omission.
//
// What the cache actually is: `liveCountCache` in `app.ts` is a module-level
// `Map<string, { value, fetchedAtMs }>` with a TTL of `LIVE_COUNT_CACHE_TTL_MS`
// (default 10_000 ms), read through `getCachedLiveCount('storageBytes:{tenantId}',
// …)` and cleared by a module-private `invalidateLiveCount`. It is neither
// exported nor shared: it lives in the heap of whichever process serves requests.
//
// This job is a Cloud Run **job**, a different process from the Cloud Run
// **service** that runs `app.ts`. So there is nothing in this process's heap for
// a job-side invalidation to clear:
//
//   * importing `app.ts` here would construct a SECOND, empty `Map` in this
//     process and clear an entry that no request will ever read — an invalidation
//     that is inert while looking wired, which is the outcome worth avoiding;
//   * it would also pull `express` and the entire route surface into the job
//     image, for a call that does nothing.
//
// A cross-process bust would need a mechanism that does not exist today: a pub/sub
// invalidation channel, a shared cache, or a version counter the serving process
// re-reads. Adding one is a change to the request path, well outside this feature.
//
// Operator-visible consequence, in full: after an apply run writes
// `tenantStorageUsage/{tenantId}.bytes`, a quota reader in the serving process may
// answer from a cache entry populated up to `LIVE_COUNT_CACHE_TTL_MS` earlier and
// report the PRE-sweep, larger byte count. It is stale by at most that TTL —
// 10 seconds by default — after which the next read repopulates from Firestore and
// the reclaimed bytes appear. Nothing is lost, no quota decision is made on a
// value that outlives its TTL, and the direction of the staleness is
// conservative: the tenant briefly looks fuller than it is, never emptier.
//
// The seam stays in `sweepTenant` because the requirement is expressible and
// testable there, and because a future in-process caller — `POST
// /storage/reconcile` already invalidates the same key from inside `app.ts` — can
// pass the real function. From a job, passing nothing is the honest wiring.

// Only when executed directly, following the `require.main === module` guard
// `app.ts` uses. The gates and parsers above are exported so task 10.5 can assert
// them without spawning a process, and importing this module must therefore never
// start a job — least of all one that could be enabled by the ambient environment.
/* c8 ignore start */
if (require.main === module) {
  main()
    .catch((error) => {
      // For genuinely UNEXPECTED failures only, and no longer for a listing page
      // failure: that one is now confined to its tenant, recorded `status: 'failed'`
      // and turned into the non-zero exit code `main()` sets before returning
      // normally (Req 1.1, 2.1). What still reaches here is a refusal raised before
      // the tenant loop begins — an empty bucket name, apply mode with no
      // quarantine mover, an unusable Realtime Database handle, and a FAILED
      // Run_Lease acquisition whose transaction threw (Req 5.20) — plus anything
      // unforeseen. A *declined* acquisition is the one lease outcome that does NOT
      // arrive here: it returns normally and exits 0, because another execution is
      // doing the work (Req 5.4, 5.21). Either way the Cloud Run task is VISIBLY
      // failed rather than a
      // green run that examined half a bucket (Req 13.15), and `maxRetries: 0` on
      // the job definition makes the retry a human decision (Req 2.6).
      log('job crashed', { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    })
    .finally(async () => {
      await shutdownFirebase();
    });
}
