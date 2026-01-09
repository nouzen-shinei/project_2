import { getFirestore } from './firebaseAdmin';
import { runBillingBackfill } from './jobs/billingBackfill';

function parseBoolean(value?: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseMs(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'string' ? value.trim() : '';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseOptionalInt(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;
let lastRunAt: Date | null = null;
let isRunning = false;

export type BillingBackfillSchedulerStatus = {
  enabled: boolean;
  schedulerStarted: boolean;
  intervalMs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  isRunning: boolean;
};

export function getBillingBackfillSchedulerStatus(): BillingBackfillSchedulerStatus {
  const intervalMs = parseMs(process.env.BILLING_BACKFILL_SCHEDULER_INTERVAL_MS, 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
  const enabled = parseBoolean(process.env.BILLING_BACKFILL_SCHEDULER_ENABLED);
  return {
    enabled,
    schedulerStarted,
    intervalMs,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    isRunning,
  };
}

export function startBillingBackfillScheduler(): void {
  const enabled = parseBoolean(process.env.BILLING_BACKFILL_SCHEDULER_ENABLED);
  if (!enabled) {
    return;
  }

  if (schedulerStarted) return;
  schedulerStarted = true;

  const runOnStart = parseBoolean(process.env.BILLING_BACKFILL_SCHEDULER_RUN_ON_START);
  if (runOnStart) {
    const startDelayMs = parseMs(process.env.BILLING_BACKFILL_SCHEDULER_START_DELAY_MS, 30_000, 0, 10 * 60_000);
    const timer = setTimeout(() => {
      runBillingBackfillJob({ reason: 'startup' }).catch((err) => {
        console.error('[billing_backfill_scheduler] startup run failed', err);
      });
    }, startDelayMs);
    timer.unref?.();
  }

  scheduleNext();
}

export function stopBillingBackfillScheduler(): void {
  schedulerStarted = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  nextRunAt = null;
}

function scheduleNext(): void {
  if (!schedulerStarted) return;

  const enabled = parseBoolean(process.env.BILLING_BACKFILL_SCHEDULER_ENABLED);
  if (!enabled) return;

  const intervalMs = parseMs(process.env.BILLING_BACKFILL_SCHEDULER_INTERVAL_MS, 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
  nextRunAt = new Date(Date.now() + intervalMs);

  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    runBillingBackfillJob({ reason: 'interval' })
      .catch((err) => {
        console.error('[billing_backfill_scheduler] scheduled run failed', err);
      })
      .finally(() => {
        if (schedulerStarted) {
          scheduleNext();
        }
      });
  }, intervalMs);

  schedulerTimer.unref?.();
}

async function runBillingBackfillJob(options: { reason: 'startup' | 'interval' }): Promise<void> {
  if (isRunning) {
    console.warn('[billing_backfill_scheduler] skipped: already running', { reason: options.reason });
    return;
  }

  isRunning = true;
  lastRunAt = new Date();

  const dryRun = parseBoolean(process.env.BILLING_BACKFILL_SCHEDULER_DRY_RUN);
  const maxTenants = parseOptionalInt(process.env.BILLING_BACKFILL_MAX_TENANTS);
  const maxPaymentsPerSubscription = parseOptionalInt(process.env.BILLING_BACKFILL_MAX_PAYMENTS_PER_SUBSCRIPTION);
  const runnerId = (process.env.BILLING_BACKFILL_RUNNER_ID || 'scheduler').trim() || 'scheduler';

  try {
    const db = getFirestore();
    await runBillingBackfill(db, {
      dryRun,
      verbose: false,
      jobLabel: `scheduler:${options.reason}`,
      runnerId,
      maxTenants,
      maxPaymentsPerSubscription,
    });
  } finally {
    isRunning = false;
  }
}
