#!/usr/bin/env ts-node
/**
 * Backfill `tenantId` onto legacy `payments` sub-collection documents
 * (`fees/{feeId}/payments/{paymentId}`).
 *
 * WHY: security-rules-hardening Phase 3.5 tenant-scoped the payments
 * collection-group. The payments-history screen (`usePaymentsHistory`) now issues
 * `collectionGroup('payments').where('tenantId','==',tenantId)`, and the Firestore
 * rule authorises payment reads by `resource.data.tenantId`. Newer payment docs are
 * written with `tenantId` (see `fees.tsx`), but any docs created before that — the
 * ones the old client used to tenant-infer at read time — lack it and would become
 * INVISIBLE in payments history (and denied by the rule). This one-time migration
 * copies each payment's tenantId from its PARENT fee document.
 *
 * Runs via the Admin SDK, which bypasses security rules.
 *
 * Usage:
 *   ts-node scripts/backfillPaymentTenantIds.ts --dry-run
 *   ts-node scripts/backfillPaymentTenantIds.ts --credentials ./service-account.json
 *   ts-node scripts/backfillPaymentTenantIds.ts --tenant <id>   # optional: only this tenant's fees
 *
 * Flags:
 *   --dry-run              log intended writes without committing
 *   --credentials <path>   path to a service-account JSON (else application-default)
 *   --tenant <tenantId>    restrict to payments whose parent fee is in this tenant
 *   --batch <n>            page size for the collection-group scan (default 300)
 *   --verbose              log every doc decision
 */
import 'dotenv/config';
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import {
  getFirestore,
  FieldPath,
  type Firestore,
  type QueryDocumentSnapshot,
  type WriteBatch,
  type DocumentReference,
} from 'firebase-admin/firestore';
import fs from 'node:fs';

interface ScriptOptions {
  dryRun: boolean;
  verbose: boolean;
  batchSize: number;
  tenantId?: string;
  credentialsPath?: string;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    batchSize: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--tenant':
        options.tenantId = (argv[i + 1] || '').trim() || undefined;
        i += 1;
        break;
      case '--batch':
      case '--batch-size':
        options.batchSize = Number(argv[i + 1]) || options.batchSize;
        i += 1;
        break;
      case '--credentials':
        options.credentialsPath = argv[i + 1];
        i += 1;
        break;
      default:
        break;
    }
  }
  return options;
}

function initializeFirebase(credentialPath?: string): Firestore {
  const appOptions: Parameters<typeof initializeApp>[0] = {};
  if (credentialPath) {
    const resolvedPath = credentialPath.startsWith('.')
      ? `${process.cwd()}/${credentialPath}`
      : credentialPath;
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Credentials file not found at ${resolvedPath}`);
    }
    appOptions.credential = cert(JSON.parse(fs.readFileSync(resolvedPath, 'utf8')));
  } else {
    try {
      appOptions.credential = applicationDefault();
    } catch (error) {
      console.warn('[init] Unable to load application default credentials:', (error as Error).message);
    }
  }
  const g = global as unknown as { __paymentBackfillInit?: boolean };
  if (!g.__paymentBackfillInit) {
    initializeApp(appOptions);
    g.__paymentBackfillInit = true;
  }
  return getFirestore();
}

function normalizeTenantId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  console.log('[payment-tenant-backfill] starting');
  console.log('  dryRun:', options.dryRun ? 'yes' : 'no');
  console.log('  batchSize:', options.batchSize);
  if (options.tenantId) console.log('  restrict to tenant:', options.tenantId);

  const db = initializeFirebase(options.credentialsPath);

  // Cache parent-fee tenantId lookups so we don't re-read a fee for every payment.
  const feeTenantCache = new Map<string, string | null>();
  const resolveFeeTenant = async (feeRef: DocumentReference): Promise<string | null> => {
    const cached = feeTenantCache.get(feeRef.path);
    if (cached !== undefined) return cached;
    let resolved: string | null = null;
    try {
      const snap = await feeRef.get();
      resolved = snap.exists ? normalizeTenantId((snap.data() as any)?.tenantId) : null;
    } catch (error) {
      console.warn(`  ! failed reading parent fee ${feeRef.path}:`, (error as Error).message);
    }
    feeTenantCache.set(feeRef.path, resolved);
    return resolved;
  };

  const stats = { scanned: 0, alreadyTagged: 0, updated: 0, skippedNoParentTenant: 0, tenantMismatchSkipped: 0, errors: 0 };

  let batch: WriteBatch = db.batch();
  let batchOps = 0;
  const flush = async () => {
    if (options.dryRun || batchOps === 0) return;
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  let lastDoc: QueryDocumentSnapshot | null = null;
  for (;;) {
    let query = db.collectionGroup('payments').orderBy(FieldPath.documentId()).limit(options.batchSize);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snapshot = await query.get();
    if (snapshot.empty) break;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    for (const docSnap of snapshot.docs) {
      stats.scanned += 1;
      const data = docSnap.data() as any;
      const existing = normalizeTenantId(data?.tenantId);

      // Parent fee ref: fees/{feeId}/payments/{paymentId} -> .parent(payments) -> .parent(fee)
      const feeRef = docSnap.ref.parent.parent;
      if (!feeRef) {
        stats.errors += 1;
        continue;
      }
      const parentTenant = await resolveFeeTenant(feeRef);

      if (options.tenantId && parentTenant && parentTenant !== options.tenantId) {
        continue; // outside the requested tenant scope
      }

      if (existing) {
        stats.alreadyTagged += 1;
        // Optional integrity note: flag payments whose own tenantId disagrees with the parent fee.
        if (parentTenant && parentTenant !== existing) {
          stats.tenantMismatchSkipped += 1;
          console.warn(`  ! ${docSnap.ref.path}: payment.tenantId=${existing} != fee.tenantId=${parentTenant} (left as-is)`);
        }
        continue;
      }

      if (!parentTenant) {
        stats.skippedNoParentTenant += 1;
        if (options.verbose) console.warn(`  ? ${docSnap.ref.path}: parent fee has no tenantId; skipped`);
        continue;
      }

      if (options.dryRun) {
        console.log(`[dry-run] ${docSnap.ref.path} -> tenantId=${parentTenant}`);
      } else {
        batch.update(docSnap.ref, { tenantId: parentTenant });
        batchOps += 1;
        if (batchOps >= 400) await flush();
      }
      stats.updated += 1;
    }
  }

  await flush();

  console.log('\n[payment-tenant-backfill] summary');
  console.table([stats]);
  if (stats.skippedNoParentTenant > 0) {
    console.log(
      `\nNOTE: ${stats.skippedNoParentTenant} payment(s) had a parent fee with no tenantId — run ` +
        `backfillTenantCollections.ts for the 'fees' collection first, then re-run this script.`,
    );
  }
  console.log('\nDone.');
}

main().catch((error) => {
  console.error('[payment-tenant-backfill] unexpected failure', error);
  process.exitCode = 1;
});
