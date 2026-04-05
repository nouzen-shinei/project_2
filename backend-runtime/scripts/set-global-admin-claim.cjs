#!/usr/bin/env node
require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key || !key.startsWith('--')) continue;
    const name = key.slice(2);
    if (name === 'help') {
      out.help = '1';
      continue;
    }
    if (val && !val.startsWith('--')) {
      out[name] = val;
      i += 1;
    } else {
      out[name] = '1';
    }
  }
  return out;
}

function toBool(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function usage() {
  console.log('Usage: node scripts/set-global-admin-claim.cjs --uid <uid> [--admin true|false]');
  console.log('   or: node scripts/set-global-admin-claim.cjs --email <email> [--admin true|false]');
  console.log('Read-only check: node scripts/set-global-admin-claim.cjs --uid <uid> --get');
  console.log('            or: node scripts/set-global-admin-claim.cjs --email <email> --get');
  console.log('Bootstrap first admin only: --bootstrap (fails if any other admin claim exists)');
  console.log('Override bootstrap safety: --force');
  console.log('Optional: --project <firebaseProjectId>');
}

async function countExistingAdminClaims() {
  let count = 0;
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const user of page.users || []) {
      if (user && user.customClaims && user.customClaims.admin === true) {
        count += 1;
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return count;
}

function initFirebase(projectArg) {
  const projectId =
    projectArg ||
    process.env.FIREBASE_PROJECT_ID ||
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
    undefined;

  const filePath =
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE ||
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.resolve(__dirname, '../firebase_sa.b64');

  let serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  if (!serviceAccountRaw && filePath && fs.existsSync(filePath)) {
    serviceAccountRaw = fs.readFileSync(filePath, 'utf8').trim();
  }

  if (serviceAccountRaw) {
    const jsonStr = serviceAccountRaw.startsWith('{')
      ? serviceAccountRaw
      : Buffer.from(serviceAccountRaw, 'base64').toString('utf8');
    const credentialObject = JSON.parse(jsonStr);
    admin.initializeApp({
      credential: admin.credential.cert(credentialObject),
      projectId: projectId || credentialObject.project_id,
    });
    return;
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }

  const uidArg = typeof args.uid === 'string' ? args.uid.trim() : '';
  const emailArg = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
  const setAdmin = toBool(typeof args.admin === 'string' ? args.admin : 'true', true);
  const readOnlyGet = toBool(typeof args.get === 'string' ? args.get : 'false', false);
  const bootstrapOnly = toBool(typeof args.bootstrap === 'string' ? args.bootstrap : 'false', false);
  const forceOverride = toBool(typeof args.force === 'string' ? args.force : 'false', false);

  if (!uidArg && !emailArg) {
    usage();
    throw new Error('Either --uid or --email is required');
  }

  initFirebase(typeof args.project === 'string' ? args.project.trim() : undefined);

  const targetUser = uidArg
    ? await admin.auth().getUser(uidArg)
    : await admin.auth().getUserByEmail(emailArg);

  const currentClaims = Object.assign({}, targetUser.customClaims || {});
  const previousAdmin = currentClaims.admin === true;

  if (bootstrapOnly) {
    if (readOnlyGet) {
      throw new Error('Cannot use --bootstrap with --get');
    }
    if (!setAdmin) {
      throw new Error('--bootstrap is only valid when --admin true');
    }
    const existingAdmins = await countExistingAdminClaims();
    const effectiveExistingAdmins = previousAdmin ? Math.max(0, existingAdmins - 1) : existingAdmins;
    if (effectiveExistingAdmins > 0 && !forceOverride) {
      const err = new Error(
        `Bootstrap refused: found ${effectiveExistingAdmins} existing admin claim user(s). Re-run with --force to override.`
      );
      err.code = 'bootstrap_admin_exists';
      throw err;
    }
  }

  if (readOnlyGet) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          uid: targetUser.uid,
          email: targetUser.email || null,
          admin: previousAdmin,
          customClaims: currentClaims,
        },
        null,
        2
      )
    );
    return;
  }

  if (setAdmin) {
    currentClaims.admin = true;
  } else {
    delete currentClaims.admin;
  }

  await admin.auth().setCustomUserClaims(targetUser.uid, Object.keys(currentClaims).length ? currentClaims : null);
  await admin.auth().revokeRefreshTokens(targetUser.uid);

  console.log(
    JSON.stringify(
      {
        ok: true,
        uid: targetUser.uid,
        email: targetUser.email || null,
        previousAdmin,
        admin: setAdmin,
        bootstrap: bootstrapOnly,
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (code === 'auth/user-not-found') {
    console.error('User not found');
    process.exit(2);
  }
  if (code === 'bootstrap_admin_exists') {
    console.error(error && error.message ? error.message : 'Bootstrap admin already exists');
    process.exit(4);
  }
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
