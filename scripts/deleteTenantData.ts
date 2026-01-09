#!/usr/bin/env ts-node
import 'dotenv/config';
import fs from 'node:fs';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore, type Query } from 'firebase-admin/firestore';

const DEFAULT_COLLECTIONS = [
  'students',
  'fees',
  'attendance',
  'deviceTracking',
  'device_actions',
  'quotes',
  'reminderHistory',
  'notifications',
  'tenantAuditLogs',
  'tenantInvites',
  'tenantJoinRequests',
];

type DeleteStats = {
  collection: string;
  scanned: number;
  skipped: number;
  deleted: number;
  errors: number;
};

interface ScriptOptions {
  tenantId: string;
  collections: string[];
  dryRun: boolean;
  confirm: boolean;
  batchSize: number;
  maxDocs?: number;
  olderThan?: string;
  credentialsPath?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    tenantId: '',
    collections: [],
    dryRun: argv.includes('--dry-run'),
    confirm: argv.includes('--confirm'),
    batchSize: 150,
    maxDocs: undefined,
    olderThan: undefined,
    credentialsPath: undefined,
    verbose: argv.includes('--verbose'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--tenant':
        options.tenantId = argv[i + 1] || '';
        i += 1;
        break;
      case '--collections':
      case '--collection':
      case '-c': {
        const raw = argv[i + 1] || '';
        options.collections = raw
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        i += 1;
        break;
      }
      case '--batch':
      case '--batch-size':
        options.batchSize = Math.max(1, Number(argv[i + 1]) || options.batchSize);
        i += 1;
        break;
      case '--max':
        options.maxDocs = Number(argv[i + 1]) || undefined;
        i += 1;
        break;
      case '--older-than':
        options.olderThan = argv[i + 1];
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

  if (!options.collections.length) {
    options.collections = [...DEFAULT_COLLECTIONS];
  }

  if (!options.dryRun && !options.confirm) {
    console.error('Destructive mode requires --confirm. Use --dry-run to preview deletions.');
    process.exit(1);
  }

  return options;
}

function normalizeTenantId(value: string): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_-]{4,}$/.test(trimmed) ? trimmed : null;
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
      console.warn('[delete-tenant-data] Unable to load application default credentials:', (error as Error).message);
    }
  }

  const globalSlot = global as unknown as { __deleteTenantDataInit?: boolean };
  if (!globalSlot.__deleteTenantDataInit) {
    initializeApp(appOptions);
    globalSlot.__deleteTenantDataInit = true;
  }

  return getFirestore();
}

function toMillis(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  if (typeof value === 'object' && value && 'toDate' in value && typeof (value as any).toDate === 'function') {
    try {
      return (value as any).toDate().getTime();
    } catch {
      return null;
    }
  }
  if (typeof (value as Record<string, any>)?.seconds === 'number') {
    const data = value as Record<string, any>;
    const seconds = Number(data.seconds) || 0;
    const nanos = Number(data.nanoseconds) || 0;
    return seconds * 1000 + Math.floor(nanos / 1_000_000);
  }
  return null;
}

function shouldDeleteDoc(data: Record<string, unknown>, cutoff?: number): boolean {
  if (!cutoff) {
    return true;
  }
  const candidateFields = ['deletedAt', 'archivedAt', 'updatedAt', 'createdAt', 'timestamp'];
  for (const field of candidateFields) {
    const value = data[field];
    const millis = toMillis(value);
    if (typeof millis === 'number' && millis <= cutoff) {
      return true;
    }
  }
  return false;
}

async function deleteTenantDocs(
  db: Firestore,
  collectionName: string,
  options: ScriptOptions,
  cutoffMillis?: number
): Promise<DeleteStats> {
  const stats: DeleteStats = { collection: collectionName, scanned: 0, skipped: 0, deleted: 0, errors: 0 };
  const tenantId = options.tenantId;
  const limit = options.batchSize;
  const maxDeletes = options.maxDocs;

  try {
    let hasMore = true;
    while (hasMore) {
      let query: Query = db.collection(collectionName).where('tenantId', '==', tenantId).limit(limit);
      const snapshot = await query.get();
      if (snapshot.empty) {
        break;
      }

      const batch = db.batch();
      let batchOps = 0;

      for (const doc of snapshot.docs) {
        stats.scanned += 1;
        const data = doc.data();
        if (!shouldDeleteDoc(data, cutoffMillis)) {
          stats.skipped += 1;
          continue;
        }

        if (options.dryRun) {
          if (options.verbose) {
            console.log(`[dry-run] ${collectionName}/${doc.id}`);
          }
        } else {
          batch.delete(doc.ref);
          batchOps += 1;
        }
        stats.deleted += 1;

        if (maxDeletes && stats.deleted >= maxDeletes) {
          hasMore = false;
          break;
        }
      }

      if (!options.dryRun && batchOps > 0) {
        await batch.commit();
      }

      if (snapshot.size < limit) {
        hasMore = false;
      }
    }
  } catch (error) {
    stats.errors += 1;
    console.error(`[delete-tenant-data] Failed on ${collectionName}`, error);
  }

  return stats;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const tenantId = normalizeTenantId(options.tenantId);
  if (!tenantId) {
    console.error('Error: --tenant <tenantId> is required (alphanumeric / dash / underscore, min 4 chars).');
    process.exitCode = 1;
    return;
  }
  options.tenantId = tenantId;

  if (!options.collections.length) {
    console.error('Error: at least one collection must be provided.');
    process.exitCode = 1;
    return;
  }

  const cutoffMillis = options.olderThan ? Date.parse(options.olderThan) : undefined;
  if (options.olderThan && !cutoffMillis) {
    console.error('Invalid --older-than value. Use an ISO date (e.g. 2025-01-15).');
    process.exitCode = 1;
    return;
  }

  console.log('[delete-tenant-data] starting');
  console.log('  tenantId:', tenantId);
  console.log('  collections:', options.collections.join(', '));
  console.log('  batchSize:', options.batchSize);
  console.log('  dryRun:', options.dryRun ? 'yes' : 'no');
  if (cutoffMillis) {
    console.log('  olderThan:', new Date(cutoffMillis).toISOString());
  }
  if (options.maxDocs) {
    console.log('  maxDeletes:', options.maxDocs);
  }

  const db = initializeFirestore(options.credentialsPath);

  const summaries: DeleteStats[] = [];
  for (const collectionName of options.collections) {
    console.log(`\n[delete-tenant-data] scanning collection: ${collectionName}`);
    const stats = await deleteTenantDocs(db, collectionName, options, cutoffMillis);
    console.log(
      `  scanned=${stats.scanned} deleted=${stats.deleted} skipped=${stats.skipped} errors=${stats.errors}`
    );
    summaries.push(stats);

    if (options.maxDocs && stats.deleted >= options.maxDocs) {
      console.log('\nReached max delete threshold. Stopping early.');
      break;
    }
  }

  console.log('\n[delete-tenant-data] summary');
  console.table(
    summaries.map((entry) => ({
      collection: entry.collection,
      scanned: entry.scanned,
      deleted: entry.deleted,
      skipped: entry.skipped,
      errors: entry.errors,
    }))
  );

  if (options.dryRun) {
    console.log('\nDry run complete. Re-run with --confirm (without --dry-run) to execute deletions.');
  } else {
    console.log('\nDeletion complete.');
  }
}

main().catch((error) => {
  console.error('[delete-tenant-data] unexpected failure', error);
  process.exitCode = 1;
});
