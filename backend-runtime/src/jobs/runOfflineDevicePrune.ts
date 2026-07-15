import 'dotenv/config';
import admin from 'firebase-admin';
import { initFirebase, shutdownFirebase } from './tenantUsageRollup';
import {
  runOfflineDevicePrune,
  clampBatchSize,
  resolveMaxAgeDays,
  DEFAULT_PRUNE_BATCH_SIZE,
  type PruneConfig,
} from './offlineDevicePrune';

/**
 * Runnable entrypoint for the offline-device prune maintenance job
 * (`node dist/jobs/runOfflineDevicePrune.js`).
 *
 * Follows the device tenant-index backfill runner convention
 * (`runDeviceTenantIndexBackfill.ts`): load env config, `initFirebase()`, invoke
 * the core {@link runOfflineDevicePrune}, log the result, `shutdownFirebase()`.
 *
 * SAFE-BY-DEFAULT gating lives here (NOT in the core, which tests invoke
 * directly):
 *   - `OFFLINE_DEVICE_PRUNE_ENABLED` (default FALSE) — when not enabled the
 *     runner logs "disabled" and exits 0 WITHOUT scanning or deleting anything.
 *   - `OFFLINE_DEVICE_PRUNE_DRY_RUN` (default TRUE) — when not explicitly false
 *     the run scans + counts what WOULD be deleted but performs NO deletes.
 *
 * Suggested rollout: leave disabled → enable once with dry-run to review the
 * counts on the progress doc → set DRY_RUN=false to actually delete → schedule
 * it on the existing cron/runner mechanism.
 */

type Config = {
  enabled: boolean;
  dryRun: boolean;
  maxAgeDays: number;
  batchSize: number;
  force: boolean;
  runnerId: string;
};

function parseBoolean(value: string | undefined | null, fallback: boolean): boolean {
  if (value === undefined || value === null || value.trim().length === 0) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function loadConfig(): Config {
  return {
    // Opt-in: default OFF. Only an explicit 1/true/yes enables the job.
    enabled: parseBoolean(process.env.OFFLINE_DEVICE_PRUNE_ENABLED, false),
    // Dry-run: default ON. Only an explicit false/0/no performs deletes.
    dryRun: parseBoolean(process.env.OFFLINE_DEVICE_PRUNE_DRY_RUN, true),
    maxAgeDays: resolveMaxAgeDays(process.env.OFFLINE_DEVICE_PRUNE_MAX_AGE_DAYS),
    batchSize: clampBatchSize(
      parsePositiveInt(process.env.OFFLINE_DEVICE_PRUNE_BATCH_SIZE, DEFAULT_PRUNE_BATCH_SIZE)
    ),
    force: parseBoolean(process.env.OFFLINE_DEVICE_PRUNE_FORCE, false),
    runnerId:
      (process.env.OFFLINE_DEVICE_PRUNE_RUNNER_ID || '').trim() ||
      (process.env.GITHUB_SHA || '').trim() ||
      (process.env.USER || '').trim() ||
      (process.env.USERNAME || '').trim() ||
      'local-dev',
  };
}

function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[offline_device_prune_runner] ${message}`, extra);
  } else {
    console.log(`[offline_device_prune_runner] ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Opt-in gate: when disabled, do NOT initialize Firebase, scan, or delete.
  if (!config.enabled) {
    log('disabled — set OFFLINE_DEVICE_PRUNE_ENABLED=1 to run (no scan, no deletes performed)');
    return;
  }

  log('starting job', {
    dryRun: config.dryRun,
    maxAgeDays: config.maxAgeDays,
    batchSize: config.batchSize,
    force: config.force,
    runnerId: config.runnerId,
  });

  initFirebase();
  const db = admin.firestore();

  const pruneConfig: PruneConfig = {
    batchSize: config.batchSize,
    maxAgeDays: config.maxAgeDays,
    dryRun: config.dryRun,
    force: config.force,
    runnerId: config.runnerId,
  };

  const result = await runOfflineDevicePrune(db, pruneConfig);

  log(result.dryRun ? 'job finished (DRY RUN — no deletes performed)' : 'job finished', {
    processedCount: result.processedCount,
    staleCount: result.staleCount,
    deletedCount: result.deletedCount,
    completed: result.completed,
    dryRun: result.dryRun,
  });
}

main()
  .catch((error) => {
    log('job crashed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownFirebase();
  });
