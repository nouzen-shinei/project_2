import 'dotenv/config';
import admin from 'firebase-admin';
import { initFirebase, shutdownFirebase } from './tenantUsageRollup';
import {
  runDeviceTenantIndexBackfill,
  DEFAULT_BACKFILL_BATCH_SIZE,
  type BackfillConfig,
} from './deviceTenantIndexBackfill';

/**
 * Runnable entrypoint for the device tenant-index backfill (Stage 4 of the
 * `device-tenant-index` feature; design Component 7).
 *
 * Follows the billing-backfill convention (`runBillingBackfill.ts`): load env
 * config, `initFirebase()`, invoke the core {@link runDeviceTenantIndexBackfill},
 * log the result, `shutdownFirebase()`. It is a one-shot operational migration
 * invoked as a compiled node script (`node dist/jobs/runDeviceTenantIndexBackfill.js`),
 * NOT an HTTP endpoint.
 */

type Config = {
  batchSize: number;
  force: boolean;
  runnerId: string;
};

function parseBoolean(value?: string | null): boolean {
  if (!value) return false;
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
    batchSize: parsePositiveInt(
      process.env.DEVICE_TENANT_INDEX_BACKFILL_BATCH_SIZE,
      DEFAULT_BACKFILL_BATCH_SIZE
    ),
    force: parseBoolean(process.env.DEVICE_TENANT_INDEX_BACKFILL_FORCE),
    runnerId:
      (process.env.DEVICE_TENANT_INDEX_BACKFILL_RUNNER_ID || '').trim() ||
      (process.env.GITHUB_SHA || '').trim() ||
      (process.env.USER || '').trim() ||
      (process.env.USERNAME || '').trim() ||
      'local-dev',
  };
}

function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[device_tenant_index_backfill_runner] ${message}`, extra);
  } else {
    console.log(`[device_tenant_index_backfill_runner] ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  log('starting job', {
    batchSize: config.batchSize,
    force: config.force,
    runnerId: config.runnerId,
  });

  initFirebase();
  const db = admin.firestore();

  const backfillConfig: BackfillConfig = {
    batchSize: config.batchSize,
    force: config.force,
    runnerId: config.runnerId,
  };

  const result = await runDeviceTenantIndexBackfill(db, backfillConfig);

  log('job finished', {
    processedCount: result.processedCount,
    updatedCount: result.updatedCount,
    completed: result.completed,
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
