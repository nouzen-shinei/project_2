#!/usr/bin/env ts-node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, applicationDefault, cert, getApps, deleteApp, type AppOptions } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getDatabase, type Database } from 'firebase-admin/database';

interface CliOptions {
  credentialsPath?: string;
  verbose: boolean;
}

interface FirestoreSample {
  collection: string;
  docId: string;
  description: string;
}

interface RtdbSample {
  path: string;
  description: string;
}

const FIRESTORE_SAMPLES: FirestoreSample[] = [
  { collection: 'students', docId: 'HGHxoxyipkLNkA3L6rlb', description: 'Representative student record' },
  { collection: 'fees', docId: '0Crooz7QtOwlgmARcXIL', description: 'Fee ledger entry' },
  { collection: 'attendance', docId: '7OgLb0yD0unHHbLa24me', description: 'Attendance record' },
  { collection: 'device_actions', docId: '00QBs5Y8nZPQTg3V7RzE', description: 'Device action log' },
  { collection: 'device_bans', docId: 'OZNkrDNOHcipE0QSa7ew', description: 'Device ban record' },
];

const RTDB_SAMPLES: RtdbSample[] = [
  {
    path: 'conversationLatest/invipika_gmail_com__krvikrantsingh51_gmail_com',
    description: 'Conversation latest metadata',
  },
  {
    path: 'conversationSummaries/invipika_gmail_com/krvikrantsingh51_gmail_com',
    description: 'Conversation summary node',
  },
  {
    path: 'userConversations/invipika_gmail_com/invipika_gmail_com__krvikrantsingh51_gmail_com',
    description: 'User conversation mapping',
  },
  {
    path: 'conversationMessages/invipika_gmail_com__krvikrantsingh51_gmail_com/-OeP1LHqODlq-aMujGey',
    description: 'Conversation message record',
  },
  {
    path: 'messageIndex/-OeP1LHqODlq-aMujGey',
    description: 'Message index entry',
  },
];

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { verbose: argv.includes('--verbose'), credentialsPath: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--credentials' || arg === '-c') {
      options.credentialsPath = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

function resolveCredentials(credentialsPath?: string): Record<string, any> | undefined {
  if (!credentialsPath) {
    return undefined;
  }
  const resolved = path.isAbsolute(credentialsPath) ? credentialsPath : path.join(process.cwd(), credentialsPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Credentials file not found at ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function initFirebase(options: CliOptions): { db: Firestore; rtdb: Database } {
  if (!getApps().length) {
    const appOptions: AppOptions = {};
    const credentialsContent = resolveCredentials(options.credentialsPath || process.env.GOOGLE_APPLICATION_CREDENTIALS);
    if (credentialsContent) {
      appOptions.credential = cert(credentialsContent);
    } else {
      appOptions.credential = applicationDefault();
    }
    const databaseUrl = process.env.FIREBASE_DATABASE_URL;
    if (databaseUrl) {
      appOptions.databaseURL = databaseUrl;
    }
    initializeApp(appOptions);
  }
  return { db: getFirestore(), rtdb: getDatabase() };
}

async function verifyFirestoreSamples(db: Firestore, verbose: boolean): Promise<void> {
  console.log('\n[spot-check] Firestore samples');
  for (const sample of FIRESTORE_SAMPLES) {
    const snap = await db.collection(sample.collection).doc(sample.docId).get();
    if (!snap.exists) {
      console.warn(`  ✗ ${sample.collection}/${sample.docId} (${sample.description}) missing`);
      continue;
    }
    const data = snap.data() ?? {};
    const tenantId = data.tenantId ?? null;
    if (tenantId) {
      console.log(`  ✓ ${sample.collection}/${sample.docId} tenantId=${tenantId}`);
    } else {
      console.warn(`  ⚠ ${sample.collection}/${sample.docId} missing tenantId`);
    }
    if (verbose) {
      console.log(`    → data keys: ${Object.keys(data).join(', ')}`);
    }
  }
}

async function verifyRtdbSamples(rtdb: Database, verbose: boolean): Promise<void> {
  console.log('\n[spot-check] RTDB samples');
  for (const sample of RTDB_SAMPLES) {
    const snapshot = await rtdb.ref(sample.path).get();
    if (!snapshot.exists()) {
      console.warn(`  ✗ ${sample.path} (${sample.description}) missing`);
      continue;
    }
    const value = snapshot.val();
    const tenantId = value?.tenantId ?? null;
    if (tenantId) {
      console.log(`  ✓ ${sample.path} tenantId=${tenantId}`);
    } else {
      console.warn(`  ⚠ ${sample.path} missing tenantId`);
    }
    if (verbose) {
      const preview = typeof value === 'object' && value !== null ? JSON.stringify(value).slice(0, 200) : String(value);
      console.log(`    → sample value: ${preview}`);
    }
  }
}

async function shutdownFirebase(): Promise<void> {
  const apps = getApps();
  await Promise.all(apps.map((app) => deleteApp(app)));
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { db, rtdb } = initFirebase(options);
    await verifyFirestoreSamples(db, options.verbose);
    await verifyRtdbSamples(rtdb, options.verbose);
    console.log('\n[spot-check] complete');
  } catch (error) {
    console.error('[spot-check] failed:', (error as Error).stack ?? (error as Error).message);
    process.exitCode = 1;
  } finally {
    await shutdownFirebase();
  }
}

void main();
