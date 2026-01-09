#!/usr/bin/env node
/*
 * Fails the build if dangerous dev-only flags are present in a production/preview build.
 * Usage: node scripts/enforceProdEnv.js <buildEnv>
 * buildEnv should be one of: development | preview | production
 */

const fs = require('fs');
const path = require('path');

const buildEnv = (process.argv[2] || '').toLowerCase();
if (!buildEnv) {
  console.error('[enforceProdEnv] Missing buildEnv argument.');
  process.exit(1);
}
if (!['development', 'preview', 'production'].includes(buildEnv)) {
  console.error('[enforceProdEnv] Invalid buildEnv: ' + buildEnv);
  process.exit(1);
}

// Load .env (simple parse) if present
const envPath = path.resolve(process.cwd(), '.env');
let fileEnv = {};
function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const parsed = {};
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    parsed[key] = val;
  }
  return parsed;
}

fileEnv = parseEnvFile(envPath);
if (buildEnv && buildEnv !== 'development') {
  const profilePath = path.resolve(process.cwd(), `.env.${buildEnv}`);
  if (fs.existsSync(profilePath)) {
    fileEnv = { ...fileEnv, ...parseEnvFile(profilePath) };
  }
}

// Merge process.env (EAS injects) over file values
const env = { ...fileEnv, ...process.env };

function fail(msg) {
  console.error('\n[enforceProdEnv] ERROR: ' + msg + '\n');
  process.exit(2);
}

function warn(msg) {
  console.warn('[enforceProdEnv] WARN: ' + msg);
}

// Rules
if (buildEnv !== 'development') {
  if (env.EXPO_PUBLIC_DEBUG_AUTH === '1' || /^(true|yes)$/i.test(env.EXPO_PUBLIC_DEBUG_AUTH || '')) {
    fail('EXPO_PUBLIC_DEBUG_AUTH must not be enabled for ' + buildEnv + ' builds.');
  }
  if ((env.EXPO_PUBLIC_LOG_LEVEL || '').toLowerCase() === 'debug') {
    warn('LOG_LEVEL=debug in ' + buildEnv + ' (consider lowering to info).');
  }
}

// Optional future rule: enforce CSP hash generation once inline styles removed.

console.log('[enforceProdEnv] Environment checks passed for buildEnv=' + buildEnv);
