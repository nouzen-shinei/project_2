#!/usr/bin/env ts-node
import 'dotenv/config';
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore, FieldPath, type Firestore, type QueryDocumentSnapshot, type WriteBatch } from 'firebase-admin/firestore';
import fs from 'node:fs';

const DEFAULT_COLLECTIONS = [
  'students',
  'fees',
  'attendance',
  'device_actions',
  'device_bans',
  'deviceTracking',
];

interface ScriptOptions {
  tenantId: string;
  collections: string[];
  dryRun: boolean;
  verbose: boolean;
  batchSize: number;
  limit?: number;
  credentialsPath?: string;
}

interface CollectionStats {
  collection: string;
  scanned: number;
  updated: number;
  skippedExisting: number;
  fallbackAssignments: number;
  errors: number;
}

interface TenantResolution {
  tenantId: string;
  source: string;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    tenantId: '',
    collections: [],
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    batchSize: 200,
    limit: undefined,
    credentialsPath: undefined,
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
        options.batchSize = Number(argv[i + 1]) || options.batchSize;
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
      default:
        break;
    }
  }

  if (!options.collections.length) {
    options.collections = [...DEFAULT_COLLECTIONS];
  }

  options.collections = Array.from(new Set(options.collections.map((name) => name.trim()).filter(Boolean)));

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
    const content = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    appOptions.credential = cert(content);
  } else {
    try {
      appOptions.credential = applicationDefault();
    } catch (error) {
      console.warn('[init] Unable to load application default credentials:', (error as Error).message);
    }
  }

  const alreadyInitialized = (global as unknown as { __tenantBackfillInit?: boolean }).__tenantBackfillInit;
  if (!alreadyInitialized) {
    initializeApp(appOptions);
    (global as unknown as { __tenantBackfillInit?: boolean }).__tenantBackfillInit = true;
  }

  return getFirestore();
}

function normalizeTenantId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{4,}$/.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((val): val is string => Boolean(val))));
}

function readNested(obj: Record<string, any>, path: string[]): unknown {
  let current: any = obj;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function deriveTenantId(data: Record<string, any>, fallbackTenantId: string): TenantResolution {
  const direct = normalizeTenantId(data.tenantId);
  if (direct) {
    return { tenantId: direct, source: 'existing' };
  }

  const candidates: TenantResolution[] = [];
  const pushCandidate = (value: unknown, source: string) => {
    const normalized = normalizeTenantId(value);
    if (normalized) {
      candidates.push({ tenantId: normalized, source });
    }
  };

  pushCandidate(data.activeTenantId, 'activeTenantId');

  if (Array.isArray(data.tenantIds)) {
    const unique = uniqueStrings(data.tenantIds.map((value) => (typeof value === 'string' ? value.trim() : null)));
    if (unique.length === 1) {
      pushCandidate(unique[0], 'tenantIds');
    }
  }

  if (Array.isArray(data.tenantMemberships)) {
    const unique = uniqueStrings(
      data.tenantMemberships.map((entry) => (entry && typeof entry === 'object' ? normalizeTenantId(entry.tenantId) : null))
    );
    if (unique.length === 1) {
      pushCandidate(unique[0], 'tenantMemberships');
    }
  }

  if (Array.isArray(data.tenants)) {
    const unique = uniqueStrings(
      data.tenants.map((entry) => {
        if (typeof entry === 'string') {
          return entry.trim();
        }
        if (entry && typeof entry === 'object') {
          return normalizeTenantId(entry.tenantId ?? entry.id ?? entry.code);
        }
        return null;
      })
    );
    if (unique.length === 1) {
      pushCandidate(unique[0], 'tenants[]');
    }
  }

  const nestedPaths: Array<{ path: string[]; label: string }> = [
    { path: ['tenant', 'id'], label: 'tenant.id' },
    { path: ['tenant', 'tenantId'], label: 'tenant.tenantId' },
    { path: ['tenant', 'legacyId'], label: 'tenant.legacyId' },
    { path: ['metadata', 'tenantId'], label: 'metadata.tenantId' },
    { path: ['meta', 'tenantId'], label: 'meta.tenantId' },
    { path: ['context', 'tenantId'], label: 'context.tenantId' },
    { path: ['payload', 'tenantId'], label: 'payload.tenantId' },
    { path: ['details', 'tenantId'], label: 'details.tenantId' },
    { path: ['device', 'tenantId'], label: 'device.tenantId' },
  ];

  for (const descriptor of nestedPaths) {
    const value = readNested(data, descriptor.path);
    if (value) {
      pushCandidate(value, descriptor.label);
    }
  }

  const uniqueCandidates = uniqueStrings(candidates.map((entry) => entry.tenantId));
  if (uniqueCandidates.length === 1) {
    const resolvedTenant = uniqueCandidates[0];
    const source = candidates.find((entry) => entry.tenantId === resolvedTenant)?.source ?? 'derived';
    return { tenantId: resolvedTenant, source };
  }

  return { tenantId: fallbackTenantId, source: 'fallback' };
}

async function backfillCollection(
  db: Firestore,
  collectionName: string,
  options: ScriptOptions
): Promise<CollectionStats> {
  const stats: CollectionStats = {
    collection: collectionName,
    scanned: 0,
    updated: 0,
    skippedExisting: 0,
    fallbackAssignments: 0,
    errors: 0,
  };

  const batchLimit = 400;
  let batch: WriteBatch = db.batch();
  let batchOps = 0;
  const flushBatch = async () => {
    if (options.dryRun || batchOps === 0) {
      return;
    }
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  const limitPerCollection = options.limit ?? Number.POSITIVE_INFINITY;

  let lastDoc: QueryDocumentSnapshot | null = null;
  let reachedLimit = false;

  while (!reachedLimit) {
    let query = db.collection(collectionName).orderBy(FieldPath.documentId()).limit(options.batchSize);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    for (const docSnap of snapshot.docs) {
      stats.scanned += 1;
      const data = docSnap.data();
      const existingTenant = normalizeTenantId(data.tenantId);
      if (existingTenant) {
        stats.skippedExisting += 1;
        continue;
      }

      const resolution = deriveTenantId(data, options.tenantId);
      if (resolution.source === 'fallback') {
        stats.fallbackAssignments += 1;
      }

      if (options.dryRun) {
        console.log(`[dry-run] ${collectionName}/${docSnap.id} -> ${resolution.tenantId} (${resolution.source})`);
      } else {
        batch.update(docSnap.ref, { tenantId: resolution.tenantId });
        batchOps += 1;
        if (batchOps >= batchLimit) {
          await flushBatch();
        }
      }

      stats.updated += 1;

      if (stats.updated >= limitPerCollection) {
        reachedLimit = true;
        break;
      }
    }
  }

  await flushBatch();
  return stats;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!normalizeTenantId(options.tenantId)) {
    console.error('Error: --tenant <tenantId> is required (alphanumeric / - / _ )');
    process.exitCode = 1;
    return;
  }

  if (!options.collections.length) {
    console.error('Error: at least one collection must be specified');
    process.exitCode = 1;
    return;
  }

  console.log('[tenant-backfill] starting');
  console.log('  tenantId:', options.tenantId);
  console.log('  collections:', options.collections.join(', '));
  console.log('  batchSize:', options.batchSize);
  if (options.limit) {
    console.log('  limit per collection:', options.limit);
  }
  console.log('  dryRun:', options.dryRun ? 'yes' : 'no');

  const firestore = initializeFirebase(options.credentialsPath);

  const summaries: CollectionStats[] = [];
  for (const collectionName of options.collections) {
    try {
      console.log(`\n[tenant-backfill] processing collection: ${collectionName}`);
      const stats = await backfillCollection(firestore, collectionName, options);
      console.log(
        `  scanned=${stats.scanned} updated=${stats.updated} existing=${stats.skippedExisting} fallback=${stats.fallbackAssignments}`
      );
      summaries.push(stats);
    } catch (error) {
      console.error(`[tenant-backfill] failed on ${collectionName}`, error);
      summaries.push({
        collection: collectionName,
        scanned: 0,
        updated: 0,
        skippedExisting: 0,
        fallbackAssignments: 0,
        errors: 1,
      });
    }
  }

  console.log('\n[tenant-backfill] summary');
  console.table(
    summaries.map((entry) => ({
      collection: entry.collection,
      scanned: entry.scanned,
      updated: entry.updated,
      existing: entry.skippedExisting,
      fallback: entry.fallbackAssignments,
      errors: entry.errors,
    }))
  );

  console.log('\nDone.');
}

main().catch((error) => {
  console.error('[tenant-backfill] unexpected failure', error);
  process.exitCode = 1;
});
