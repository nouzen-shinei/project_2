#!/usr/bin/env ts-node
import 'dotenv/config';
import fs from 'node:fs';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

type PlanId = 'free' | 'pro' | 'enterprise';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

const PLAN_LIMITS: Record<PlanId, { staffSeats: number; students: number; reminders: { total: number; voice: number }; storageBytes: number }> = {
  free: {
    staffSeats: 3,
    students: 75,
    reminders: { total: 150, voice: 60 },
    storageBytes: 1 * GB,
  },
  pro: {
    staffSeats: 25,
    students: 1200,
    reminders: { total: 5000, voice: 1500 },
    storageBytes: 20 * GB,
  },
  enterprise: {
    staffSeats: 100,
    students: 5000,
    reminders: { total: 25000, voice: 8000 },
    storageBytes: 100 * GB,
  },
};

type ScriptOptions = {
  dryRun: boolean;
  confirm: boolean;
  tenantId?: string;
  limit?: number;
  credentialsPath?: string;
};

function usage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: ts-node scripts/clearAutoDerivedQuotas.ts [options]\n\nOptions:\n  --dry-run                 Preview updates (default)\n  --confirm                 Apply updates (required if not --dry-run)\n  --tenant <tenantId>        Only update a single tenant\n  --limit <n>                Max tenants to scan\n  --credentials <path>       Path to service account JSON (optional)\n`);
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    dryRun: true,
    confirm: argv.includes('--confirm'),
    tenantId: undefined,
    limit: undefined,
    credentialsPath: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--confirm':
        options.confirm = true;
        options.dryRun = false;
        break;
      case '--tenant':
        options.tenantId = (argv[i + 1] || '').trim() || undefined;
        i += 1;
        break;
      case '--limit':
        options.limit = Number(argv[i + 1]) || undefined;
        i += 1;
        break;
      case '--credentials':
        options.credentialsPath = argv[i + 1];
        i += 1;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
      default:
        break;
    }
  }

  if (!options.dryRun && !options.confirm) {
    // Safety: require explicit confirm for writes.
    // eslint-disable-next-line no-console
    console.error('Write mode requires --confirm. Use --dry-run to preview changes.');
    process.exit(1);
  }

  return options;
}

function initializeFirestore(credentialsPath?: string): Firestore {
  const appOptions: Parameters<typeof initializeApp>[0] = {};

  if (credentialsPath) {
    const resolvedPath = credentialsPath.startsWith('.')
      ? `${process.cwd()}/${credentialsPath}`
      : credentialsPath;
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Credentials file not found at ${resolvedPath}`);
    }
    const content = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    appOptions.credential = cert(content);
  } else {
    try {
      appOptions.credential = applicationDefault();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[clear-auto-derived-quotas] Unable to load application default credentials:', (error as Error).message);
    }
  }

  const globalSlot = global as unknown as { __clearAutoDerivedQuotasInit?: boolean };
  if (!globalSlot.__clearAutoDerivedQuotasInit) {
    initializeApp(appOptions);
    globalSlot.__clearAutoDerivedQuotasInit = true;
  }

  return getFirestore();
}

function normalizePlanId(value: unknown): PlanId {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'pro' || raw === 'enterprise') return raw;
  return 'free';
}

type Quotas = {
  maxStudents?: unknown;
  maxStaff?: unknown;
  maxMonthlyReminders?: unknown;
  maxMonthlyVoiceReminders?: unknown;
  maxStorageMb?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function computeDefaultQuotas(planId: PlanId) {
  const limits = PLAN_LIMITS[planId] ?? PLAN_LIMITS.free;
  return {
    maxStudents: limits.students,
    maxStaff: limits.staffSeats,
    maxMonthlyReminders: limits.reminders.total,
    maxMonthlyVoiceReminders: limits.reminders.voice,
    maxStorageMb: Math.round(limits.storageBytes / MB),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAutoDerivedQuotaSnapshot(quotas: Quotas, defaults: ReturnType<typeof computeDefaultQuotas>): boolean {
  // Conservative: only clear when all numeric quota fields are present and exactly equal to defaults.
  // This avoids wiping legitimate overrides.
  if (!isFiniteNumber(quotas.maxStudents)) return false;
  if (!isFiniteNumber(quotas.maxStaff)) return false;
  if (!isFiniteNumber(quotas.maxMonthlyReminders)) return false;
  if (!isFiniteNumber(quotas.maxStorageMb)) return false;

  const hasVoice = quotas.maxMonthlyVoiceReminders !== undefined;
  if (hasVoice && !isFiniteNumber(quotas.maxMonthlyVoiceReminders)) {
    return false;
  }

  return (
    quotas.maxStudents === defaults.maxStudents &&
    quotas.maxStaff === defaults.maxStaff &&
    quotas.maxMonthlyReminders === defaults.maxMonthlyReminders &&
    quotas.maxStorageMb === defaults.maxStorageMb &&
    (!hasVoice || quotas.maxMonthlyVoiceReminders === defaults.maxMonthlyVoiceReminders)
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = initializeFirestore(options.credentialsPath);

  const tenantCollection = db.collection('tenants');
  let tenantQuery = options.tenantId
    ? tenantCollection.where('__name__', '==', options.tenantId)
    : tenantCollection;
  if (typeof options.limit === 'number' && options.limit > 0) {
    tenantQuery = tenantQuery.limit(options.limit);
  }

  const snapshot = await tenantQuery.get();
  const docs = snapshot.docs;

  let scanned = 0;
  let wouldClear = 0;
  let cleared = 0;
  let skipped = 0;

  for (const docSnap of docs) {
    scanned += 1;
    const tenantId = docSnap.id;
    const data = docSnap.data() || {};

    const planId = normalizePlanId((data as any).billingTier);
    const defaults = computeDefaultQuotas(planId);

    const quotasRaw = asRecord((data as any).quotas);
    if (!quotasRaw) {
      skipped += 1;
      continue;
    }

    const quotas: Quotas = {
      maxStudents: quotasRaw.maxStudents,
      maxStaff: quotasRaw.maxStaff,
      maxMonthlyReminders: quotasRaw.maxMonthlyReminders,
      maxMonthlyVoiceReminders: quotasRaw.maxMonthlyVoiceReminders,
      maxStorageMb: quotasRaw.maxStorageMb,
    };

    if (!isAutoDerivedQuotaSnapshot(quotas, defaults)) {
      skipped += 1;
      continue;
    }

    wouldClear += 1;

    if (options.dryRun) {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] would clear quotas for tenant ${tenantId} (billingTier=${planId})`);
      continue;
    }

    await docSnap.ref.set(
      {
        quotas: {
          maxStudents: null,
          maxStaff: null,
          maxMonthlyReminders: null,
          maxMonthlyVoiceReminders: null,
          maxStorageMb: null,
        },
      },
      { merge: true },
    );

    cleared += 1;
    // eslint-disable-next-line no-console
    console.log(`[ok] cleared quotas for tenant ${tenantId} (billingTier=${planId})`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[done] scanned=${scanned} skipped=${skipped} matched=${wouldClear} ${options.dryRun ? 'would-clear' : 'cleared'}=${options.dryRun ? wouldClear : cleared}`,
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[clear-auto-derived-quotas] failed', error);
  process.exit(1);
});
