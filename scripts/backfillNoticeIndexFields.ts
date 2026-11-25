#!/usr/bin/env ts-node
/**
 * Upgrades every `notices/{id}` document to schemaVersion 2 by adding the
 * denormalized query fields the app now relies on:
 *
 *   visibleToRoles, roleRestricted, hasImage, hasAudio, hasLink, source,
 *   schemaVersion, reactionCount   (+ createdByRole 'system' for backend notices)
 *
 * Usage Monitor notices that had no audience become admins-only
 * (targetTenantRoles = ['owner', 'admin']).
 *
 * The field logic lives in backend-runtime/src/lib/noticeIndexFields.ts and is
 * shared with the backend notice writers. Safe to re-run: documents that are
 * already current are skipped, and only changed fields are written.
 *
 * Run BEFORE shipping the app version that queries these fields (and after the
 * new indexes in firestore.indexes.json are built):
 *
 *   npm run backfill:notices                  # dry run
 *   npm run backfill:notices -- --confirm     # write
 *
 * (The npm script compiles as CommonJS; plain `npx ts-node` uses the app's
 * bundler tsconfig and can't resolve the backend-runtime import.)
 */
import 'dotenv/config';
import fs from 'node:fs';
import { applicationDefault, cert, initializeApp } from 'firebase-admin/app';
import {
  FieldPath,
  getFirestore,
  type DocumentData,
  type Firestore,
  type Query,
  type UpdateData,
} from 'firebase-admin/firestore';
import { computeNoticeIndexPatch } from '../backend-runtime/src/lib/noticeIndexFields';

type ScriptOptions = {
  dryRun: boolean;
  tenantId?: string;
  limit?: number;
  pageSize: number;
  credentialsPath?: string;
  projectId?: string;
  verbose: boolean;
};

const LOG = '[backfill-notice-index-fields]';
// Firestore allows 500 writes per batch; stay below it.
const MAX_BATCH_WRITES = 400;

function usage(): void {
  console.log(`Usage: npm run backfill:notices -- [options]

Options:
  --dry-run                 Preview changes (default)
  --confirm                 Write changes
  --tenant <tenantId>       Only notices of one tenant
  --limit <n>               Stop after scanning n notices
  --page-size <n>           Documents read per page (default 300)
  --credentials <path>      Service account JSON (default: application default credentials)
  --project <projectId>     Project id (needed for the emulator)
  --verbose                 Print every changed notice
`);
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = { dryRun: true, pageSize: 300, verbose: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--confirm':
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
      case '--page-size':
        options.pageSize = Math.min(500, Math.max(1, Number(argv[i + 1]) || 300));
        i += 1;
        break;
      case '--credentials':
        options.credentialsPath = argv[i + 1];
        i += 1;
        break;
      case '--project':
        options.projectId = (argv[i + 1] || '').trim() || undefined;
        i += 1;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        console.error(`${LOG} Unknown option ${arg}`);
        usage();
        process.exit(1);
    }
  }
  return options;
}

function initializeFirestore(options: ScriptOptions): Firestore {
  const appOptions: Parameters<typeof initializeApp>[0] = {};
  if (options.projectId) appOptions.projectId = options.projectId;

  if (options.credentialsPath) {
    const resolvedPath = options.credentialsPath.startsWith('.')
      ? `${process.cwd()}/${options.credentialsPath}`
      : options.credentialsPath;
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Credentials file not found at ${resolvedPath}`);
    }
    appOptions.credential = cert(JSON.parse(fs.readFileSync(resolvedPath, 'utf8')));
  } else if (!process.env.FIRESTORE_EMULATOR_HOST) {
    appOptions.credential = applicationDefault();
  }

  initializeApp(appOptions);
  return getFirestore();
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = initializeFirestore(options);

  console.log(
    `${LOG} ${options.dryRun ? 'DRY RUN (no writes; pass --confirm to write)' : 'WRITING'}` +
      `${options.tenantId ? ` tenant=${options.tenantId}` : ' all tenants'}` +
      `${process.env.FIRESTORE_EMULATOR_HOST ? ` emulator=${process.env.FIRESTORE_EMULATOR_HOST}` : ''}`,
  );

  let baseQuery: Query = db.collection('notices');
  if (options.tenantId) baseQuery = baseQuery.where('tenantId', '==', options.tenantId);
  baseQuery = baseQuery.orderBy(FieldPath.documentId());

  let scanned = 0;
  let current = 0;
  let changed = 0;
  let written = 0;
  let madeAdminsOnly = 0;
  const fieldCounts: Record<string, number> = {};

  let batch = db.batch();
  let batchSize = 0;
  const flush = async () => {
    if (batchSize === 0) return;
    await batch.commit();
    written += batchSize;
    batch = db.batch();
    batchSize = 0;
  };

  let cursor: string | undefined;
  for (;;) {
    let pageQuery = baseQuery.limit(options.pageSize);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const page = await pageQuery.get();
    if (page.empty) break;

    for (const docSnap of page.docs) {
      if (options.limit !== undefined && scanned >= options.limit) break;
      scanned += 1;
      const patch = computeNoticeIndexPatch(docSnap.data() as Record<string, unknown>, docSnap.id);
      const keys = Object.keys(patch);
      if (keys.length === 0) {
        current += 1;
        continue;
      }

      changed += 1;
      keys.forEach((key) => {
        fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
      });
      if ('targetTenantRoles' in patch) madeAdminsOnly += 1;
      if (options.verbose) {
        console.log(`${LOG} ${docSnap.id} (tenant ${docSnap.get('tenantId')}): ${JSON.stringify(patch)}`);
      }

      if (!options.dryRun) {
        batch.update(docSnap.ref, patch as UpdateData<DocumentData>);
        batchSize += 1;
        if (batchSize >= MAX_BATCH_WRITES) await flush();
      }
    }

    if (options.limit !== undefined && scanned >= options.limit) break;
    cursor = page.docs[page.docs.length - 1].id;
    if (page.size < options.pageSize) break;
  }

  if (!options.dryRun) await flush();

  console.log(
    `${LOG} done scanned=${scanned} alreadyCurrent=${current} ` +
      `${options.dryRun ? 'wouldUpdate' : 'updated'}=${options.dryRun ? changed : written} ` +
      `usageMonitorMadeAdminsOnly=${madeAdminsOnly}`,
  );
  console.log(`${LOG} fields ${options.dryRun ? 'to set' : 'set'}: ${JSON.stringify(fieldCounts)}`);
}

main().catch((err) => {
  console.error(`${LOG} failed`, err);
  process.exit(1);
});
