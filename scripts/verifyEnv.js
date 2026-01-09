#!/usr/bin/env node
// Enforce presence of required EXPO_PUBLIC_* environment variables at build/start time.
// Reads from both process.env and the local .env file (if present) to validate values.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const profileIdx = args.findIndex(a => a === '--profile');
const profile = profileIdx >= 0 ? (args[profileIdx + 1] || 'development') : (process.env.EXPO_PUBLIC_BUILD_ENV || 'development');

function parseDotEnv(dotEnvPath) {
  if (!fs.existsSync(dotEnvPath)) return {};
  const content = fs.readFileSync(dotEnvPath, 'utf8');
  const result = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.substring(0, eq).trim();
    const value = line.substring(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

function getEnvValue(key, fileEnv) {
  return (process.env[key] && String(process.env[key]).trim()) || (fileEnv[key] && String(fileEnv[key]).trim()) || '';
}

function assertPresent(key, fileEnv, issues) {
  const val = getEnvValue(key, fileEnv);
  if (!val) issues.push(`Missing required env: ${key}`);
}

function run() {
  const root = process.cwd();
  const baseEnv = parseDotEnv(path.join(root, '.env'));
  let profileEnv = {};
  if (profile && profile !== 'development') {
    profileEnv = parseDotEnv(path.join(root, `.env.${profile}`));
  }
  const fileEnv = { ...baseEnv, ...profileEnv };

  const issues = [];

  // Always required
  const REQUIRED = [
    'EXPO_PUBLIC_FIREBASE_API_KEY',
    'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'EXPO_PUBLIC_FIREBASE_DATABASE_URL',
    'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
    'EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET',
    'EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
    'EXPO_PUBLIC_FIREBASE_APP_ID',
    'EXPO_PUBLIC_BUILD_ENV',
    'EXPO_PUBLIC_RELEASE_MONTH'
  ];
  REQUIRED.forEach(k => assertPresent(k, fileEnv, issues));

  // We enforce web-facing app metadata globally so web remains consistent
  assertPresent('EXPO_PUBLIC_APP_VERSION', fileEnv, issues);
  assertPresent('EXPO_PUBLIC_APP_BUILD', fileEnv, issues);

  // Basic format checks (non-fatal warnings unless production)
  const version = getEnvValue('EXPO_PUBLIC_APP_VERSION', fileEnv);
  const build = getEnvValue('EXPO_PUBLIC_APP_BUILD', fileEnv);
  const versionOk = /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version);
  const buildOk = /^\d{6}\.\d+$/.test(build);
  if (!versionOk) issues.push(`EXPO_PUBLIC_APP_VERSION should be semver (e.g., 1.2.3). Current: '${version}'`);
  if (!buildOk) issues.push(`EXPO_PUBLIC_APP_BUILD should be YYYYMM.n (e.g., 202509.1). Current: '${build}'`);

  // Production safety checks
  const isProd = profile === 'production' || getEnvValue('EXPO_PUBLIC_BUILD_ENV', fileEnv) === 'production';
  if (isProd) {
    const debugAuth = getEnvValue('EXPO_PUBLIC_DEBUG_AUTH', fileEnv);
    if (debugAuth === '1' || debugAuth === 'true') {
      issues.push('EXPO_PUBLIC_DEBUG_AUTH must be disabled in production');
    }
  }

  if (issues.length) {
    console.error('\n[verifyEnv] Environment validation failed:');
    for (const msg of issues) console.error(' -', msg);
    console.error('\nFix the above .env / EAS env before continuing.');
    process.exit(1);
  } else {
    console.log(`[verifyEnv] OK for profile '${profile}'.`);
  }
}

run();
