#!/usr/bin/env ts-node
import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_COLLECTIONS = ['students', 'fees', 'attendance', 'device_actions', 'device_bans', 'deviceTracking'];
const DEFAULT_RTDB_NODES = ['conversationLatest', 'conversationSummaries', 'userConversations', 'messageIndex', 'conversationMessages'];

interface RunnerOptions {
  projectId: string;
  credentialsPath?: string;
  databaseUrl?: string;
  fallbackTenant: string;
  collections: string[];
  rtdbNodes: string[];
  includeDeviceTrackingArchives: boolean;
  coverageBatchSize: number;
  coverageField: string;
  coverageSampleSize: number;
  chatBatchSize: number;
  chatLimit?: number;
  firestoreBatchSize: number;
  firestoreLimit?: number;
  envLabel: 'staging' | 'production';
  outputRoot: string;
  tag?: string;
  skipCoverageBefore: boolean;
  skipCoverageAfter: boolean;
  skipChatDryRun: boolean;
  skipChatCommit: boolean;
  skipFirestoreDryRun: boolean;
  skipFirestoreCommit: boolean;
  skipDiff: boolean;
  dryRunOnly: boolean;
}

interface StepDescriptor {
  id: string;
  label: string;
}

const STEPS: StepDescriptor[] = [
  { id: 'coverage-before', label: 'Coverage (before)' },
  { id: 'chat-dry-run', label: 'Chat backfill (dry run)' },
  { id: 'chat-commit', label: 'Chat backfill (commit)' },
  { id: 'firestore-dry-run', label: 'Firestore backfill (dry run)' },
  { id: 'firestore-commit', label: 'Firestore backfill (commit)' },
  { id: 'coverage-after', label: 'Coverage (after)' },
  { id: 'coverage-diff', label: 'Coverage diff' },
];

function usage(): void {
  console.log(`Usage: ts-node scripts/runTenantMigrationPlan.ts --project <id> [options]\n\nOptions:\n  --credentials <path>          Path to service account JSON.\n  --database-url <url>          RTDB URL passed to child processes.\n  --env <staging|production>    Defaults to production; drives output folder tagging.\n  --tag <label>                 Override report folder tag (defaults to <env>-dry-run).\n  --output-root <path>          Where to store logs/reports (default: reports).\n  --collections a,b,c           Firestore collections for tenant backfill.\n  --rtdb-nodes a,b,c            RTDB nodes for coverage reports.\n  --fallback-tenant <id>        Fallback tenant for data lacking breadcrumbs (default legacy-coaching).\n  --include-device-tracking-archives  Include deviceTracking_* collections in coverage.\n  --coverage-batch <n>          Batch size for coverage script (default 400).\n  --coverage-sample <n>         Sample tenants to record per collection (default 5).\n  --chat-batch <n>              Batch size for chat backfill (default 25).\n  --chat-limit <n>              Optional limit for chat dry run/commit.\n  --firestore-batch <n>         Batch size for Firestore backfill (default 300).\n  --firestore-limit <n>         Optional limit per collection for Firestore runs.\n  --dry-run-only                Skip commit runs for chat + Firestore.\n  --skip-*                      Skip individual phases (e.g., --skip-chat-dry, --skip-coverage-before).\n  --skip-diff                   Do not generate coverage diff JSON.\n`);
}

function parseList(input?: string, fallback: string[] = []): string[] {
  if (!input) return [...fallback];
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    databaseUrl: process.env.FIREBASE_DATABASE_URL,
    fallbackTenant: 'legacy-coaching',
    collections: [...DEFAULT_COLLECTIONS],
    rtdbNodes: [...DEFAULT_RTDB_NODES],
    includeDeviceTrackingArchives: true,
    coverageBatchSize: 400,
    coverageField: 'tenantId',
    coverageSampleSize: 5,
    chatBatchSize: 25,
    chatLimit: undefined,
    firestoreBatchSize: 300,
    firestoreLimit: undefined,
    envLabel: 'production',
    outputRoot: path.resolve(process.cwd(), 'reports'),
    tag: undefined,
    skipCoverageBefore: false,
    skipCoverageAfter: false,
    skipChatDryRun: false,
    skipChatCommit: false,
    skipFirestoreDryRun: false,
    skipFirestoreCommit: false,
    skipDiff: false,
    dryRunOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--project':
        options.projectId = argv[i + 1] || '';
        i += 1;
        break;
      case '--credentials':
        options.credentialsPath = argv[i + 1];
        i += 1;
        break;
      case '--database-url':
        options.databaseUrl = argv[i + 1];
        i += 1;
        break;
      case '--fallback-tenant':
      case '--tenant':
        options.fallbackTenant = argv[i + 1] || options.fallbackTenant;
        i += 1;
        break;
      case '--collections':
        options.collections = parseList(argv[i + 1], DEFAULT_COLLECTIONS);
        i += 1;
        break;
      case '--rtdb-nodes':
        options.rtdbNodes = parseList(argv[i + 1], DEFAULT_RTDB_NODES);
        i += 1;
        break;
      case '--include-device-tracking-archives':
      case '--include-deviceTracking-archives':
        options.includeDeviceTrackingArchives = true;
        break;
      case '--no-include-device-tracking-archives':
        options.includeDeviceTrackingArchives = false;
        break;
      case '--coverage-batch':
        options.coverageBatchSize = Number(argv[i + 1]) || options.coverageBatchSize;
        i += 1;
        break;
      case '--coverage-sample':
        options.coverageSampleSize = Number(argv[i + 1]) || options.coverageSampleSize;
        i += 1;
        break;
      case '--coverage-field':
        options.coverageField = argv[i + 1] || options.coverageField;
        i += 1;
        break;
      case '--chat-batch':
        options.chatBatchSize = Number(argv[i + 1]) || options.chatBatchSize;
        i += 1;
        break;
      case '--chat-limit':
        options.chatLimit = Number(argv[i + 1]) || undefined;
        i += 1;
        break;
      case '--firestore-batch':
        options.firestoreBatchSize = Number(argv[i + 1]) || options.firestoreBatchSize;
        i += 1;
        break;
      case '--firestore-limit':
        options.firestoreLimit = Number(argv[i + 1]) || undefined;
        i += 1;
        break;
      case '--env': {
        const next = (argv[i + 1] || '').toLowerCase();
        if (next === 'staging' || next === 'production') {
          options.envLabel = next;
        }
        i += 1;
        break;
      }
      case '--tag':
        options.tag = argv[i + 1];
        i += 1;
        break;
      case '--output-root':
        options.outputRoot = path.resolve(process.cwd(), argv[i + 1]);
        i += 1;
        break;
      case '--skip-coverage-before':
        options.skipCoverageBefore = true;
        break;
      case '--skip-coverage-after':
        options.skipCoverageAfter = true;
        break;
      case '--skip-chat-dry':
        options.skipChatDryRun = true;
        break;
      case '--skip-chat-commit':
        options.skipChatCommit = true;
        break;
      case '--skip-firestore-dry':
        options.skipFirestoreDryRun = true;
        break;
      case '--skip-firestore-commit':
        options.skipFirestoreCommit = true;
        break;
      case '--skip-diff':
        options.skipDiff = true;
        break;
      case '--dry-run-only':
        options.dryRunOnly = true;
        break;
      default:
        break;
    }
  }

  return options;
}

function resolveCredentials(credentialsPath?: string): string | undefined {
  if (!credentialsPath) return undefined;
  return credentialsPath.startsWith('.')
    ? path.resolve(process.cwd(), credentialsPath)
    : path.resolve(credentialsPath);
}

function formatDateSegment(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

interface RunCommandOptions {
  label: string;
  command: string;
  args: string[];
  logFile?: string;
  env: NodeJS.ProcessEnv;
}

function runCommand({ label, command, args, logFile, env }: RunCommandOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n[runner] ${label}`);
    console.log(`         ${command} ${args.join(' ')}`);

    const logStream = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      logStream?.write(chunk);
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      logStream?.write(chunk);
    });

    child.on('error', (error) => {
      logStream?.end();
      reject(error);
    });

    child.on('close', (code) => {
      logStream?.end();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} failed with exit code ${code}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.projectId) {
    usage();
    throw new Error('Missing --project <id>');
  }

  const resolvedCreds = resolveCredentials(options.credentialsPath);
  const tag = options.tag || `${options.envLabel}-dry-run`;
  const dateSegment = formatDateSegment();
  const reportDir = path.join(options.outputRoot, tag, dateSegment);
  ensureDirectory(reportDir);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIREBASE_PROJECT_ID: options.projectId,
  };
  if (resolvedCreds) {
    env.GOOGLE_APPLICATION_CREDENTIALS = resolvedCreds;
  }
  if (options.databaseUrl) {
    env.FIREBASE_DATABASE_URL = options.databaseUrl;
  }

  const coverageBeforePath = path.join(reportDir, 'coverage-before.json');
  const coverageAfterPath = path.join(reportDir, 'coverage-after.json');
  const coverageDiffPath = path.join(reportDir, 'coverage-diff.json');
  const chatDryLog = path.join(reportDir, 'chat-backfill-dry-run.log');
  const chatCommitLog = path.join(reportDir, 'chat-backfill-run.log');
  const firestoreDryLog = path.join(reportDir, 'backfill-dry-run.log');
  const firestoreCommitLog = path.join(reportDir, 'backfill-run.log');

  const scriptPath = (name: string) => path.join(process.cwd(), 'scripts', name);

  try {
    if (!options.skipCoverageBefore) {
      const args = [
        'ts-node',
        scriptPath('reportTenantCoverage.ts'),
        '--collections',
        options.collections.join(','),
        '--field',
        options.coverageField,
        '--batch',
        String(options.coverageBatchSize),
        '--sample',
        String(options.coverageSampleSize),
        '--rtdb-nodes',
        options.rtdbNodes.join(','),
        '--output',
        coverageBeforePath,
      ];
      if (options.includeDeviceTrackingArchives) {
        args.push('--include-deviceTracking-archives');
      }
      if (resolvedCreds) {
        args.push('--credentials', resolvedCreds);
      }
      await runCommand({
        label: 'Coverage (before)',
        command: 'npx',
        args,
        logFile: path.join(reportDir, 'coverage-before.log'),
        env,
      });
    }

    if (!options.skipChatDryRun) {
      const args = [
        'ts-node',
        scriptPath('backfillChatTenantIds.ts'),
        '--dry-run',
        '--batch',
        String(options.chatBatchSize),
        '--fallback-tenant',
        options.fallbackTenant,
      ];
      if (options.chatLimit) {
        args.push('--limit', String(options.chatLimit));
      }
      await runCommand({
        label: 'Chat backfill (dry run)',
        command: 'npx',
        args,
        logFile: chatDryLog,
        env,
      });
    }

    if (!options.dryRunOnly && !options.skipChatCommit) {
      const args = [
        'ts-node',
        scriptPath('backfillChatTenantIds.ts'),
        '--batch',
        String(options.chatBatchSize),
        '--fallback-tenant',
        options.fallbackTenant,
      ];
      if (options.chatLimit) {
        args.push('--limit', String(options.chatLimit));
      }
      await runCommand({
        label: 'Chat backfill (commit)',
        command: 'npx',
        args,
        logFile: chatCommitLog,
        env,
      });
    }

    if (!options.skipFirestoreDryRun) {
      const args = [
        'ts-node',
        scriptPath('backfillTenantCollections.ts'),
        '--tenant',
        options.fallbackTenant,
        '--collections',
        options.collections.join(','),
        '--batch',
        String(options.firestoreBatchSize),
        '--dry-run',
      ];
      if (options.firestoreLimit) {
        args.push('--limit', String(options.firestoreLimit));
      }
      if (resolvedCreds) {
        args.push('--credentials', resolvedCreds);
      }
      await runCommand({
        label: 'Firestore backfill (dry run)',
        command: 'npx',
        args,
        logFile: firestoreDryLog,
        env,
      });
    }

    if (!options.dryRunOnly && !options.skipFirestoreCommit) {
      const args = [
        'ts-node',
        scriptPath('backfillTenantCollections.ts'),
        '--tenant',
        options.fallbackTenant,
        '--collections',
        options.collections.join(','),
        '--batch',
        String(options.firestoreBatchSize),
      ];
      if (options.firestoreLimit) {
        args.push('--limit', String(options.firestoreLimit));
      }
      if (resolvedCreds) {
        args.push('--credentials', resolvedCreds);
      }
      await runCommand({
        label: 'Firestore backfill (commit)',
        command: 'npx',
        args,
        logFile: firestoreCommitLog,
        env,
      });
    }

    if (!options.skipCoverageAfter) {
      const args = [
        'ts-node',
        scriptPath('reportTenantCoverage.ts'),
        '--collections',
        options.collections.join(','),
        '--field',
        options.coverageField,
        '--batch',
        String(options.coverageBatchSize),
        '--sample',
        String(options.coverageSampleSize),
        '--rtdb-nodes',
        options.rtdbNodes.join(','),
        '--output',
        coverageAfterPath,
      ];
      if (options.includeDeviceTrackingArchives) {
        args.push('--include-deviceTracking-archives');
      }
      if (resolvedCreds) {
        args.push('--credentials', resolvedCreds);
      }
      await runCommand({
        label: 'Coverage (after)',
        command: 'npx',
        args,
        logFile: path.join(reportDir, 'coverage-after.log'),
        env,
      });
    }

    const coverageBeforeExists = fs.existsSync(coverageBeforePath);
    const coverageAfterExists = fs.existsSync(coverageAfterPath);
    if (!options.skipDiff && coverageBeforeExists && coverageAfterExists) {
      const args = [
        'ts-node',
        scriptPath('compareCoverageReports.ts'),
        coverageBeforePath,
        coverageAfterPath,
        '--output',
        coverageDiffPath,
      ];
      await runCommand({
        label: 'Coverage diff',
        command: 'npx',
        args,
        logFile: path.join(reportDir, 'coverage-diff.log'),
        env,
      });
    } else if (!options.skipDiff) {
      console.warn('[runner] Skipping coverage diff because one or both coverage reports are missing.');
    }

    console.log('\n[runner] Migration plan complete. Artifacts stored under:', reportDir);
  } catch (error) {
    console.error('\n[runner] Failed:', (error as Error).message);
    process.exitCode = 1;
  }
}

main();
