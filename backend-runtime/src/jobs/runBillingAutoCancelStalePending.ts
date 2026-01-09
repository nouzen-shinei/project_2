import 'dotenv/config';
import admin from 'firebase-admin';
import { initFirebase, shutdownFirebase } from './tenantUsageRollup';
import { runBillingAutoCancelStalePending } from './billingAutoCancelStalePending';

type Config = {
  tenantIds: string[];
  maxTenants?: number;
  thresholdHours: number;
  dryRun: boolean;
  verbose: boolean;
  jobLabel: string;
  tenantLeaseMs?: number;
  runLeaseMs?: number;
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
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function parseOptionalMs(value?: string | null): number | undefined {
  const parsed = parseOptionalInt(value);
  if (typeof parsed !== 'number') return undefined;
  // clamp to 30s..6h (tenant lease is clamped again inside acquireTenantLease)
  return Math.max(30_000, Math.min(6 * 60 * 60_000, parsed));
}

function parseHours(value?: string | null): number {
  const parsed = Number((value || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return 24;
  return Math.max(1, Math.min(168, Math.trunc(parsed)));
}

function loadConfig(): Config {
  return {
    tenantIds: parseTenantIds(process.env.BILLING_STALE_PENDING_TENANT_IDS),
    maxTenants: parseOptionalInt(process.env.BILLING_STALE_PENDING_MAX_TENANTS),
    thresholdHours: parseHours(process.env.BILLING_STALE_PENDING_THRESHOLD_HOURS),
    dryRun: parseBoolean(process.env.BILLING_STALE_PENDING_DRY_RUN),
    verbose: parseBoolean(process.env.BILLING_STALE_PENDING_VERBOSE),
    jobLabel: (process.env.BILLING_STALE_PENDING_JOB_LABEL || '').trim() || 'billing_stale_pending',
    tenantLeaseMs: parseOptionalMs(process.env.BILLING_STALE_PENDING_TENANT_LEASE_MS),
    runLeaseMs: parseOptionalMs(process.env.BILLING_STALE_PENDING_RUN_LEASE_MS),
  };
}

function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[billing_stale_pending_runner] ${message}`, extra);
  else console.log(`[billing_stale_pending_runner] ${message}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  log('starting job', {
    jobLabel: config.jobLabel,
    dryRun: config.dryRun,
    verbose: config.verbose,
    thresholdHours: config.thresholdHours,
    tenantTargets: config.tenantIds.length ? config.tenantIds.length : '<auto>',
    maxTenants: config.maxTenants ?? null,
    tenantLeaseMs: config.tenantLeaseMs ?? 180000,
    runLeaseMs: config.runLeaseMs ?? 2 * 60 * 60_000,
  });

  initFirebase();
  const db = admin.firestore();

  const stats = await runBillingAutoCancelStalePending(db, {
    tenantIds: config.tenantIds,
    maxTenants: config.maxTenants,
    thresholdHours: config.thresholdHours,
    dryRun: config.dryRun,
    verbose: config.verbose,
    jobLabel: config.jobLabel,
    tenantLeaseMs: config.tenantLeaseMs,
    runLeaseMs: config.runLeaseMs,
  });

  log('job finished', {
    runId: (stats as any).runId ?? null,
    candidatesFound: stats.candidatesFound,
    tenantsProcessed: stats.tenantsProcessed,
    tenantsSkippedLocked: (stats as any).tenantsSkippedLocked ?? 0,
    tenantsCancelled: stats.tenantsCancelled,
    invoicesFailed: stats.invoicesFailed,
    invoicesCreated: stats.invoicesCreated,
    providerCancelsAttempted: stats.providerCancelsAttempted,
    providerCancelsFailed: stats.providerCancelsFailed,
    errors: stats.errors.length,
    fatalError: (stats as any).fatalError ?? null,
  });

  if (stats.errors.length > 0) {
    log('errors', {
      sample: stats.errors.slice(0, 8),
    });
  }

  if (stats.errors.length > 0 || (stats as any).fatalError) {
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
