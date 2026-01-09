import 'dotenv/config';
import { runPlayBillingReconcileOnce } from '../playBillingReconcileJob';

function log(message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[play_billing_reconcile_runner] ${message}`, extra);
  } else {
    console.log(`[play_billing_reconcile_runner] ${message}`);
  }
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

function parseTenantIds(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main(): Promise<void> {
  const tenantIds = parseTenantIds(process.env.PLAY_BILLING_RECONCILE_TENANT_IDS);
  const maxTenants = parseOptionalInt(process.env.PLAY_BILLING_RECONCILE_MAX_TENANTS);
  const dryRun = parseBoolean(process.env.PLAY_BILLING_RECONCILE_DRY_RUN);
  const verbose = parseBoolean(process.env.PLAY_BILLING_RECONCILE_VERBOSE);

  log('starting job', {
    mode: tenantIds.length > 0 ? 'targeted' : 'auto-scan',
    tenantIds: tenantIds.length > 0 ? tenantIds : undefined,
    maxTenants: maxTenants ?? null,
    dryRun,
    verbose,
  });
  const stats = await runPlayBillingReconcileOnce();
  log('job finished', stats);

  const errors = stats.tenantErrors + stats.configErrors;
  if (errors > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  log('job crashed', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
