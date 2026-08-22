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
 * ── Two refusals, both BEFORE `initFirebase()` ───────────────────────────────
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
 *
 * Suggested rollout (the maintainer-performed sequence is spec task 12): leave
 * disabled → enable once in report mode and read `countsBySource` and
 * `sampleOrphanPaths` by eye → apply with a low
 * `STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT` and restore one object by hand
 * → raise the ceiling → enable the purge only after the retention window has
 * passed. Rollback at any point: `STORAGE_ORPHAN_SWEEP_ENABLED=0`.
 */

import 'dotenv/config';
import admin from 'firebase-admin';

import { initFirebase, shutdownFirebase } from './tenantUsageRollup';
import {
  DEFAULT_MAX_QUARANTINE_PER_TENANT,
  DEFAULT_MAX_REFERENCES,
  DEFAULT_PAGE_SIZE,
  purgeExpiredQuarantine,
  quarantineObject,
  runStorageOrphanSweep,
  type SweepBucket,
  type SweepConfig,
} from './storageOrphanSweep';
import { DEFAULT_GRACE_DAYS, DEFAULT_QUARANTINE_RETENTION_DAYS } from '../lib/orphanDecision';

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
  | { action: 'refuse'; reason: 'missing_database_url' | 'missing_storage_bucket'; message: string }
  | { action: 'run'; mode: 'report' | 'sweep'; apply: boolean; purgeEnabled: boolean };

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
 * The gate, as a pure function of the config.
 *
 * Ordered deliberately: the enable check comes FIRST, so a disabled job is a
 * no-op even in an environment that is missing everything else. A disabled job
 * must not fail; it must do nothing.
 */
export function decideStartup(
  config: StorageOrphanSweepRunnerConfig
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
  return {
    action: 'run',
    // `apply` is what makes it a sweep. Absent ⇒ report mode (Req 10.9).
    mode: config.apply ? 'sweep' : 'report',
    apply: config.apply,
    purgeEnabled: config.purgeEnabled,
  };
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
  const decision = decideStartup(config);

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

  const sweepConfig: SweepConfig = {
    tenantIds: config.tenantIds,
    mode: decision.mode,
    apply: decision.apply,
    graceDays: config.graceDays,
    quarantineRetentionDays: config.quarantineRetentionDays,
    pageSize: config.pageSize,
    maxQuarantinePerTenant: config.maxQuarantinePerTenant,
    maxReferences: config.maxReferences,
    force: config.force,
    runnerId: config.runnerId,
    nowMs,
  };

  const result = await runStorageOrphanSweep({
    db,
    rtdb,
    bucket,
    config: sweepConfig,
    // Passed EXPLICITLY, and unconditionally: the core throws rather than report a
    // `completed` destructive run that moved nothing when apply mode is requested
    // with no mover installed. Report mode never calls it.
    quarantineObject,
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

  // ── Stage 3, under its OWN switch, AFTER the sweep ─────────────────────────
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
    log(purge.applied ? 'quarantine purge finished (APPLIED)' : 'quarantine purge finished (COUNTED ONLY)', {
      retentionDays: purge.retentionDays,
      examined: purge.examined,
      deleteEligible: purge.deleteEligible,
      deleted: purge.deleted,
      deletedBytes: purge.deletedBytes,
      retained: purge.retained,
      retainedByReason: purge.retainedByReason,
      failures: purge.failures,
    });
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
      // A listing page failure propagates out of the core to here, so the Cloud
      // Run task is VISIBLY failed rather than a green run that examined half a
      // bucket (Req 13.15). `maxRetries: 0` on the job definition then makes the
      // retry a human decision.
      log('job crashed', { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    })
    .finally(async () => {
      await shutdownFirebase();
    });
}
