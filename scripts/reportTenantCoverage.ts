#!/usr/bin/env ts-node
import 'dotenv/config';
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore, FieldPath, QueryDocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import type { database } from 'firebase-admin';
import fs from 'node:fs';

interface ScriptOptions {
  collections: string[];
  fieldPath: string;
  batchSize: number;
  limit?: number;
  credentialsPath?: string;
  verbose: boolean;
  sampleSize: number;
  outputPath?: string;
  includeDeviceTrackingArchives: boolean;
  rtdbNodes: string[];
  rtdbFieldPath: string;
}

interface CollectionCoverageSummary {
  collection: string;
  scanned: number;
  populated: number;
  missing: number;
  nullish: number;
  uniqueTenantIds: number;
  sampleTenants: string[];
  errors?: number;
}

const DEFAULT_COLLECTIONS = [
  'students',
  'fees',
  'attendance',
  'device_actions',
  'device_bans',
  'deviceTracking',
];

const DEFAULT_RTDB_NODES = [
  'conversationLatest',
  'conversationSummaries',
  'userConversations',
  'messageIndex',
  'conversationMessages',
];

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    collections: [...DEFAULT_COLLECTIONS],
    fieldPath: 'tenantId',
    batchSize: 500,
    limit: undefined,
    credentialsPath: undefined,
    verbose: argv.includes('--verbose'),
    sampleSize: 5,
    outputPath: undefined,
    includeDeviceTrackingArchives: argv.includes('--include-deviceTracking-archives') || argv.includes('--include-device-tracking-archives'),
    rtdbNodes: [],
    rtdbFieldPath: 'tenantId',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
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
      case '--field':
        options.fieldPath = argv[i + 1] || options.fieldPath;
        i += 1;
        break;
      case '--batch':
      case '--batch-size':
        options.batchSize = Math.max(1, Number(argv[i + 1]) || options.batchSize);
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
      case '--sample':
      case '--sample-size':
        options.sampleSize = Math.max(1, Number(argv[i + 1]) || options.sampleSize);
        i += 1;
        break;
      case '--output':
        options.outputPath = argv[i + 1];
        i += 1;
        break;
      case '--rtdb-nodes': {
        const raw = argv[i + 1] || '';
        const entries = raw
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        const expanded: string[] = [];
        for (const entry of entries) {
          if (entry === 'default') {
            expanded.push(...DEFAULT_RTDB_NODES);
          } else {
            expanded.push(entry);
          }
        }
        options.rtdbNodes = Array.from(new Set(expanded));
        i += 1;
        break;
      }
      case '--rtdb-field':
        options.rtdbFieldPath = argv[i + 1] || options.rtdbFieldPath;
        i += 1;
        break;
      case '--rtdb-defaults':
        options.rtdbNodes = [...DEFAULT_RTDB_NODES];
        break;
      default:
        break;
    }
  }

  if (!options.collections.length) {
    options.collections = [...DEFAULT_COLLECTIONS];
  }

  options.collections = Array.from(new Set(options.collections));
  return options;
}

function resolveCredentialContent(credentialsPath?: string): any | undefined {
  if (!credentialsPath) {
    return undefined;
  }
  const resolved = credentialsPath.startsWith('.')
    ? `${process.cwd()}/${credentialsPath}`
    : credentialsPath;
  if (!fs.existsSync(resolved)) {
    throw new Error(`Credentials file not found at ${resolved}`);
  }
  const content = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return content;
}

function initFirestore(credentialsPath?: string): Firestore {
  const alreadyInitialized = (global as unknown as { __tenantCoverageInit?: boolean }).__tenantCoverageInit;
  if (!alreadyInitialized) {
    const options: Parameters<typeof initializeApp>[0] = {};
    const credentialContent = resolveCredentialContent(credentialsPath);
    if (credentialContent) {
      options.credential = cert(credentialContent);
    } else {
      try {
        options.credential = applicationDefault();
      } catch (error) {
        console.warn('[tenant-coverage] falling back to unauthenticated admin SDK init:', (error as Error).message);
      }
    }
    const databaseUrl = process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.DATABASE_URL;
    if (databaseUrl) {
      options.databaseURL = databaseUrl;
    }
    initializeApp(options);
    (global as unknown as { __tenantCoverageInit?: boolean }).__tenantCoverageInit = true;
  }
  return getFirestore();
}

function initRealtimeDatabase(): database.Database {
  return getDatabase();
}

function readNestedField(data: Record<string, any> | null, pathSegments: string[]): unknown {
  let current: any = data;
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function normalizeTenantId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed;
}

async function auditCollection(
  db: Firestore,
  collection: string,
  options: ScriptOptions
): Promise<CollectionCoverageSummary> {
  const stats: CollectionCoverageSummary = {
    collection,
    scanned: 0,
    populated: 0,
    missing: 0,
    nullish: 0,
    uniqueTenantIds: 0,
    sampleTenants: [],
  };

  const uniqueTenants = new Set<string>();
  const fieldSegments = options.fieldPath.split('.').map((segment) => segment.trim()).filter(Boolean);
  let lastDoc: QueryDocumentSnapshot | null = null;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  while (stats.scanned < limit) {
    let query = db.collection(collection).orderBy(FieldPath.documentId()).limit(options.batchSize);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }
    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    for (const doc of snapshot.docs) {
      if (stats.scanned >= limit) {
        break;
      }
      updateCoverageStats(doc.data(), stats, fieldSegments, uniqueTenants);
    }

    if (options.verbose) {
      console.log(
        `[tenant-coverage] ${collection}: scanned=${stats.scanned} populated=${stats.populated} missing=${stats.missing} nullish=${stats.nullish}`
      );
    }
  }

  stats.uniqueTenantIds = uniqueTenants.size;
  stats.sampleTenants = Array.from(uniqueTenants).sort().slice(0, options.sampleSize);
  return stats;
}

function updateCoverageStats(
  value: Record<string, any> | null,
  stats: CollectionCoverageSummary,
  fieldSegments: string[],
  uniqueTenants: Set<string>
): void {
  stats.scanned += 1;
  const fieldValue = fieldSegments.length ? readNestedField(value ?? {}, fieldSegments) : value;
  if (fieldValue === undefined) {
    stats.missing += 1;
    return;
  }
  if (fieldValue === null) {
    stats.nullish += 1;
    return;
  }

  const normalized = normalizeTenantId(fieldValue);
  if (!normalized) {
    stats.nullish += 1;
    return;
  }

  stats.populated += 1;
  uniqueTenants.add(normalized);
}

const MULTI_LEVEL_RTDB_NODES = new Set(['conversationSummaries', 'userConversations']);

async function auditRealtimeNode(
  db: database.Database,
  nodePath: string,
  options: ScriptOptions
): Promise<CollectionCoverageSummary> {
  const stats: CollectionCoverageSummary = {
    collection: `rtdb:${nodePath}`,
    scanned: 0,
    populated: 0,
    missing: 0,
    nullish: 0,
    uniqueTenantIds: 0,
    sampleTenants: [],
  };

  const uniqueTenants = new Set<string>();
  const fieldSegments = (options.rtdbFieldPath || options.fieldPath)
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);

  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  let lastKey: string | null = null;

  while (stats.scanned < limit) {
    let query: database.Query = db.ref(nodePath).orderByKey().limitToFirst(options.batchSize);
    if (lastKey) {
      query = query.startAfter(lastKey);
    }

    const snapshot = await query.get();
    if (!snapshot.exists()) {
      break;
    }

    const children: database.DataSnapshot[] = [];
    snapshot.forEach((child) => {
      children.push(child);
      return false;
    });

    lastKey = children[children.length - 1]?.key ?? null;

    for (const child of children) {
      if (stats.scanned >= limit) {
        break;
      }

      if (nodePath === 'conversationMessages') {
        const messageNodes: database.DataSnapshot[] = [];
        child.forEach((messageSnap) => {
          messageNodes.push(messageSnap);
          return false;
        });

        for (const message of messageNodes) {
          if (stats.scanned >= limit) {
            break;
          }
          updateCoverageStats(message.val() as Record<string, any>, stats, fieldSegments, uniqueTenants);
        }
        continue;
      }

      if (MULTI_LEVEL_RTDB_NODES.has(nodePath)) {
        const nestedNodes: database.DataSnapshot[] = [];
        child.forEach((grandchild) => {
          nestedNodes.push(grandchild);
          return false;
        });
        for (const nested of nestedNodes) {
          if (stats.scanned >= limit) {
            break;
          }
          updateCoverageStats(nested.val() as Record<string, any>, stats, fieldSegments, uniqueTenants);
        }
        continue;
      }

      updateCoverageStats(child.val() as Record<string, any>, stats, fieldSegments, uniqueTenants);
    }

    if (options.verbose) {
      console.log(
        `[tenant-coverage] rtdb:${nodePath}: scanned=${stats.scanned} populated=${stats.populated} missing=${stats.missing} nullish=${stats.nullish}`
      );
    }
  }

  stats.uniqueTenantIds = uniqueTenants.size;
  stats.sampleTenants = Array.from(uniqueTenants).sort().slice(0, options.sampleSize);
  return stats;
}

async function resolveCollectionList(db: Firestore, options: ScriptOptions): Promise<string[]> {
  let names = [...options.collections];
  if (options.includeDeviceTrackingArchives) {
    const allCollections = await db.listCollections();
    const archiveNames = allCollections
      .map((col) => col.id)
      .filter((name) => name.startsWith('deviceTracking_'));
    names.push(...archiveNames);
  }
  names = Array.from(new Set(names));
  return names;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  console.log('[tenant-coverage] starting audit');
  console.log('  collections:', options.collections.join(', '));
  console.log('  field:', options.fieldPath);
  console.log('  batchSize:', options.batchSize);
  if (options.limit) {
    console.log('  limit per collection:', options.limit);
  }
  if (options.outputPath) {
    console.log('  output:', options.outputPath);
  }

  const firestore = initFirestore(options.credentialsPath);
  options.collections = await resolveCollectionList(firestore, options);
  const summaries: CollectionCoverageSummary[] = [];

  for (const collection of options.collections) {
    try {
      console.log(`\n[tenant-coverage] auditing ${collection}`);
      const summary = await auditCollection(firestore, collection, options);
      summaries.push(summary);
      console.log(
        `  scanned=${summary.scanned} populated=${summary.populated} missing=${summary.missing} nullish=${summary.nullish} uniqueTenants=${summary.uniqueTenantIds}`
      );
    } catch (error) {
      console.error(`[tenant-coverage] failed to audit ${collection}`, error);
      summaries.push({
        collection,
        scanned: 0,
        populated: 0,
        missing: 0,
        nullish: 0,
        uniqueTenantIds: 0,
        sampleTenants: [],
        errors: 1,
      });
    }
  }

  if (options.rtdbNodes.length) {
    const realtimeDb = initRealtimeDatabase();
    for (const node of options.rtdbNodes) {
      try {
        console.log(`\n[tenant-coverage] auditing rtdb node ${node}`);
        const summary = await auditRealtimeNode(realtimeDb, node, options);
        summaries.push(summary);
        console.log(
          `  scanned=${summary.scanned} populated=${summary.populated} missing=${summary.missing} nullish=${summary.nullish} uniqueTenants=${summary.uniqueTenantIds}`
        );
      } catch (error) {
        console.error(`[tenant-coverage] failed to audit rtdb node ${node}`, error);
        summaries.push({
          collection: `rtdb:${node}`,
          scanned: 0,
          populated: 0,
          missing: 0,
          nullish: 0,
          uniqueTenantIds: 0,
          sampleTenants: [],
          errors: 1,
        });
      }
    }
    // Close RTDB sockets so the process can exit cleanly.
    try {
      realtimeDb.goOffline();
    } catch (error) {
      console.warn('[tenant-coverage] failed to shut down RTDB connection', (error as Error).message);
    }
  }

  console.log('\n[tenant-coverage] summary');
  console.table(
    summaries.map((summary) => ({
      collection: summary.collection,
      scanned: summary.scanned,
      populated: summary.populated,
      missing: summary.missing,
      nullish: summary.nullish,
      uniqueTenants: summary.uniqueTenantIds,
    }))
  );

  if (options.outputPath) {
    const payload = {
      generatedAt: new Date().toISOString(),
      field: options.fieldPath,
      summaries,
    };
    fs.writeFileSync(options.outputPath, JSON.stringify(payload, null, 2));
    console.log(`[tenant-coverage] wrote report to ${options.outputPath}`);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('[tenant-coverage] unexpected failure', error);
    process.exit(1);
  });
