/*
 * Set Firestore runtime endpoints: appSettings/runtimeEndpoints
 *
 * Usage:
 *   node scripts/setRuntimeEndpoints.js \
 *     --apiBaseUrl https://api.example.com \
 *     --emailApiBaseUrl https://email.example.com
 *
 * Options:
 *   --notificationsApiBaseUrl <url>
 *   --wabaApiBaseUrl <url>
 *   --chatApiBaseUrl <url>
 *   --projectId <firebase-project-id>   (optional; otherwise reads .firebaserc)
 *   --dry-run                           (prints payload, does not write)
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      out._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function normalizeUrl(value) {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

function readDefaultProjectId(repoRoot) {
  try {
    const firebasercPath = path.join(repoRoot, '.firebaserc');
    if (!fs.existsSync(firebasercPath)) return undefined;
    const raw = fs.readFileSync(firebasercPath, 'utf8');
    const json = JSON.parse(raw);
    return json?.projects?.default;
  } catch {
    return undefined;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const repoRoot = path.resolve(__dirname, '..');
  const projectId =
    normalizeUrl(args.projectId) ||
    (process.env.FIREBASE_PROJECT_ID ? String(process.env.FIREBASE_PROJECT_ID) : undefined) ||
    readDefaultProjectId(repoRoot);

  if (!projectId) {
    throw new Error(
      'Missing project id. Provide --projectId, set FIREBASE_PROJECT_ID, or set .firebaserc projects.default.',
    );
  }

  const now = new Date().toISOString();

  const payload = {
    apiBaseUrl: normalizeUrl(args.apiBaseUrl),
    emailApiBaseUrl: normalizeUrl(args.emailApiBaseUrl),
    notificationsApiBaseUrl: normalizeUrl(args.notificationsApiBaseUrl),
    wabaApiBaseUrl: normalizeUrl(args.wabaApiBaseUrl),
    chatApiBaseUrl: normalizeUrl(args.chatApiBaseUrl),
    updatedAt: now,
  };

  // Drop undefined fields so we don't overwrite existing values with undefined.
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined) delete payload[k];
  }

  if (Object.keys(payload).length <= 1) {
    // Only updatedAt present
    throw new Error(
      'No endpoints provided. Pass at least one of: --apiBaseUrl, --emailApiBaseUrl, --notificationsApiBaseUrl, --wabaApiBaseUrl, --chatApiBaseUrl',
    );
  }

  if (args['dry-run']) {
    console.log('[set-runtime-endpoints] dry-run enabled');
    console.log('[set-runtime-endpoints] projectId:', projectId);
    console.log('[set-runtime-endpoints] would write:', JSON.stringify(payload, null, 2));
    return;
  }

  const useEmu = !!process.env.FIRESTORE_EMULATOR_HOST;
  if (useEmu) {
    initializeApp({ projectId });
  } else {
    initializeApp({ projectId, credential: applicationDefault() });
  }

  const db = getFirestore();
  const ref = db.collection('appSettings').doc('runtimeEndpoints');

  const snap = await ref.get();
  const isCreate = !snap.exists;

  if (isCreate) {
    payload.createdAt = now;
  }

  await ref.set(payload, { merge: true });

  console.log(
    `[set-runtime-endpoints] ${isCreate ? 'created' : 'updated'} appSettings/runtimeEndpoints in project ${projectId}`,
  );
  console.log('[set-runtime-endpoints] wrote:', JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error('[set-runtime-endpoints] error:', e?.stack || e);
  process.exitCode = 2;
});
