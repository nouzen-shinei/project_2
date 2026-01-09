import 'dotenv/config';
import admin from 'firebase-admin';
import { initFirebase, shutdownFirebase } from './tenantUsageRollup';
import { runBillingBackfill } from './billingBackfill';

type Config = {
  tenantIds: string[];
  maxTenants?: number;
  maxPaymentsPerSubscription?: number;
  dryRun: boolean;
  verbose: boolean;
  jobLabel: string;
  runnerId: string;
};

function parseTenantIds(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBoolean(value?: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseOptionalInt(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.trunc(parsed);
}

function loadConfig(): Config {
  return {
    tenantIds: parseTenantIds(process.env.BILLING_BACKFILL_TENANT_IDS),
    maxTenants: parseOptionalInt(process.env.BILLING_BACKFILL_MAX_TENANTS),
    maxPaymentsPerSubscription: parseOptionalInt(process.env.BILLING_BACKFILL_MAX_PAYMENTS_PER_SUBSCRIPTION),
    dryRun: parseBoolean(process.env.BILLING_BACKFILL_DRY_RUN),
    verbose: parseBoolean(process.env.BILLING_BACKFILL_VERBOSE),
    jobLabel: (process.env.BILLING_BACKFILL_JOB_LABEL || '').trim() || 'billing_backfill',
    runnerId:
      (process.env.BILLING_BACKFILL_RUNNER_ID || '').trim() ||
      (process.env.GITHUB_SHA || '').trim() ||
      (process.env.USER || '').trim() ||
      (process.env.USERNAME || '').trim() ||
      'local-dev',
  };
}

function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[billing_backfill_runner] ${message}`, extra);
  } else {
    console.log(`[billing_backfill_runner] ${message}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  log('starting job', {
    jobLabel: config.jobLabel,
    dryRun: config.dryRun,
    tenantTargets: config.tenantIds.length || '<auto>',
    maxTenants: config.maxTenants || null,
    maxPaymentsPerSubscription: config.maxPaymentsPerSubscription || null,
    verbose: config.verbose,
    runnerId: config.runnerId,
  });

  initFirebase();
  const db = admin.firestore();

  const stats = await runBillingBackfill(db, {
    tenantIds: config.tenantIds,
    maxTenants: config.maxTenants,
    maxPaymentsPerSubscription: config.maxPaymentsPerSubscription,
    dryRun: config.dryRun,
    verbose: config.verbose,
    jobLabel: config.jobLabel,
    runnerId: config.runnerId,
  });

  log('job finished', {
    runId: stats.runId,
    errors: stats.errors.length,
    tenantsProcessed: stats.tenantsProcessed,
    invoicesUpserted: stats.invoicesUpserted,
  });

  if (stats.errors.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    log('job crashed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownFirebase();
  });
