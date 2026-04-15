#!/usr/bin/env ts-node
import 'dotenv/config';
import { runTenantUsageRollup, shutdownFirebase } from '../backend-runtime/src/jobs/tenantUsageRollup';

type RollupJobConfig = {
  tenantIds: string[];
  month: string | null;
  backfill: number;
  dryRun: boolean;
  requireWrite: boolean;
  verbose: boolean;
  jobLabel: string;
};

function parseTenantIds(value?: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBoolean(value?: string | null): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseBackfill(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function loadConfig(): RollupJobConfig {
  const tenantIds = parseTenantIds(process.env.USAGE_ROLLUP_TENANT_IDS);
  const monthEnv = process.env.USAGE_ROLLUP_MONTH?.trim();
  return {
    tenantIds,
    month: monthEnv && monthEnv.length > 0 ? monthEnv : null,
    backfill: parseBackfill(process.env.USAGE_ROLLUP_BACKFILL),
    dryRun: parseBoolean(process.env.USAGE_ROLLUP_DRY_RUN),
    requireWrite: parseBoolean(process.env.USAGE_ROLLUP_REQUIRE_WRITE),
    verbose: parseBoolean(process.env.USAGE_ROLLUP_VERBOSE),
    jobLabel: process.env.USAGE_ROLLUP_JOB_LABEL?.trim() || 'usage_rollup_scheduler',
  };
}

function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[usage_rollup_scheduler] ${message}`, extra);
  } else {
    console.log(`[usage_rollup_scheduler] ${message}`);
  }
}

async function runScheduledRollup(): Promise<void> {
  const config = loadConfig();
  if (config.requireWrite && config.dryRun) {
    throw new Error('USAGE_ROLLUP_REQUIRE_WRITE is enabled but USAGE_ROLLUP_DRY_RUN resolved true. Refusing to run.');
  }
  const targets = config.tenantIds.length > 0 ? config.tenantIds : [null];
  const startedAt = new Date().toISOString();
  log('job started', {
    startedAt,
    jobLabel: config.jobLabel,
    tenantTargets: targets.length,
    month: config.month,
    backfill: config.backfill,
    dryRun: config.dryRun,
    requireWrite: config.requireWrite,
    verbose: config.verbose,
  });

  let successes = 0;
  let failures = 0;

  for (const tenantId of targets) {
    const targetLabel = tenantId ?? '<all active tenants>';
    try {
      log('running rollup for target', { tenantId: targetLabel });
      await runTenantUsageRollup({
        tenantId: tenantId ?? undefined,
        month: config.month,
        backfill: config.backfill,
        dryRun: config.dryRun,
        verbose: config.verbose,
      });
      successes += 1;
      log('rollup succeeded', { tenantId: targetLabel });
    } catch (error) {
      failures += 1;
      log('rollup failed', {
        tenantId: targetLabel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log('job completed', {
    finishedAt: new Date().toISOString(),
    jobLabel: config.jobLabel,
    successes,
    failures,
  });

  if (failures > 0) {
    process.exitCode = 1;
  }
}

runScheduledRollup()
  .catch((error) => {
    log('job crashed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownFirebase();
  });
