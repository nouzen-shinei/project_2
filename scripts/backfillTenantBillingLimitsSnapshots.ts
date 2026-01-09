#!/usr/bin/env ts-node
import 'dotenv/config';
import fs from 'node:fs';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import * as admin from 'firebase-admin';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { resolvePlanLimitsFromCatalog, toTenantBillingLimitsSnapshot } from '../backend-runtime/src/lib/effectivePlanLimits';

type PlanId = 'free' | 'pro' | 'enterprise';

type ScriptOptions = {
  dryRun: boolean;
  confirm: boolean;
  tenantId?: string;
  limit?: number;
  force?: boolean;
  credentialsPath?: string;
};

function usage(): void {
  // eslint-disable-next-line no-console
  console.log(`Usage: ts-node scripts/backfillTenantBillingLimitsSnapshots.ts [options]\n\nOptions:\n  --dry-run                 Preview updates (default)\n  --confirm                 Apply updates (required if not --dry-run)\n  --tenant <tenantId>        Only update a single tenantBilling doc\n  --limit <n>                Max tenantBilling docs to scan\n  --force                    Overwrite existing limitsSnapshot\n  --credentials <path>       Path to service account JSON (optional)\n`);
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    dryRun: true,
    confirm: argv.includes('--confirm'),
    tenantId: undefined,
    limit: undefined,
    force: argv.includes('--force'),
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
      case '--force':
        options.force = true;
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
    // eslint-disable-next-line no-console
    console.error('Write mode requires --confirm. Use --dry-run to preview changes.');
    process.exit(1);
  }

  return options;
}

function initializeFirestore(credentialsPath?: string): Firestore {
  const appOptions: Parameters<typeof initializeApp>[0] = {};

  if (credentialsPath) {
    const resolvedPath = credentialsPath.startsWith('.') ? `${process.cwd()}/${credentialsPath}` : credentialsPath;
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
      console.warn('[backfill-limits-snapshots] Unable to load application default credentials:', (error as Error).message);
    }
  }

  const globalSlot = global as unknown as { __backfillTenantBillingLimitsSnapshotsInit?: boolean };
  if (!globalSlot.__backfillTenantBillingLimitsSnapshotsInit) {
    initializeApp(appOptions);
    globalSlot.__backfillTenantBillingLimitsSnapshotsInit = true;
  }

  // Ensure admin.firestore.FieldValue is available.
  void admin;
  return getFirestore();
}

function normalizePlanId(value: unknown): PlanId {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'pro' || raw === 'enterprise') return raw;
  return 'free';
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = initializeFirestore(options.credentialsPath);

  const billingCollection = db.collection('tenantBilling');
  let billingQuery = options.tenantId
    ? billingCollection.where('__name__', '==', options.tenantId)
    : billingCollection;
  if (typeof options.limit === 'number' && options.limit > 0) {
    billingQuery = billingQuery.limit(options.limit);
  }

  const snapshot = await billingQuery.get();
  const docs = snapshot.docs;

  let scanned = 0;
  let skipped = 0;
  let wouldWrite = 0;
  let written = 0;

  for (const docSnap of docs) {
    scanned += 1;
    const tenantId = docSnap.id;
    const data = docSnap.data() || {};

    const planId = normalizePlanId((data as any).planId ?? (data as any).plan);
    if (planId === 'free') {
      skipped += 1;
      continue;
    }

    const existingSnapshot = (data as any).limitsSnapshot;
    if (existingSnapshot && !options.force) {
      skipped += 1;
      continue;
    }

    const planVariantId =
      typeof (data as any).planVariantId === 'string' && (data as any).planVariantId.trim()
        ? (data as any).planVariantId.trim()
        : null;

    const resolved = await resolvePlanLimitsFromCatalog(db as any, {
      planId,
      planVariantId,
    });
    const limitsSnapshot = toTenantBillingLimitsSnapshot(resolved);

    wouldWrite += 1;

    if (options.dryRun) {
      // eslint-disable-next-line no-console
      console.log(
        `[dry-run] would ${options.force ? 'overwrite' : 'set'} limitsSnapshot for tenantBilling ${tenantId} (planId=${planId}, planVariantId=${planVariantId || '—'})`
      );
      continue;
    }

    await docSnap.ref.set(
      {
        limitsSnapshot,
        limitsSnapshotAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    written += 1;
    // eslint-disable-next-line no-console
    console.log(
      `[ok] ${options.force ? 'overwrote' : 'set'} limitsSnapshot for tenantBilling ${tenantId} (planId=${planId}, planVariantId=${planVariantId || '—'})`
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `[done] scanned=${scanned} skipped=${skipped} matched=${wouldWrite} ${options.dryRun ? 'would-write' : 'written'}=${
      options.dryRun ? wouldWrite : written
    }`
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[backfill-limits-snapshots] failed', err);
  process.exit(1);
});
