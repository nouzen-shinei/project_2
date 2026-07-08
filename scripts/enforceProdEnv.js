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

function isTruthy(val) {
  return val === '1' || /^(true|yes)$/i.test(val || '');
}

// Rules
if (buildEnv !== 'development') {
  if (isTruthy(env.EXPO_PUBLIC_DEBUG_AUTH)) {
    fail('EXPO_PUBLIC_DEBUG_AUTH must not be enabled for ' + buildEnv + ' builds.');
  }
  if ((env.EXPO_PUBLIC_LOG_LEVEL || '').toLowerCase() === 'debug') {
    warn('LOG_LEVEL=debug in ' + buildEnv + ' (consider lowering to info).');
  }

  // Dev-only bypass values that must never ship in a client bundle for
  // preview/production. These are all "insecure by design" escape hatches
  // (direct third-party API tokens, internal auth bypass secrets, or a
  // reviewer bypass join code) that are safe only on developer machines.
  if ((env.EXPO_PUBLIC_WABA_ACCESS_TOKEN || '').trim()) {
    fail('EXPO_PUBLIC_WABA_ACCESS_TOKEN (dev-only direct WhatsApp token) must not be set for ' + buildEnv + ' builds. Use the backend proxy instead.');
  }
  if ((env.EXPO_PUBLIC_INTERNAL_TOKEN_DEV_SECRET || '').trim()) {
    fail('EXPO_PUBLIC_INTERNAL_TOKEN_DEV_SECRET (dev-only auth bypass) must not be set for ' + buildEnv + ' builds.');
  }
  if (isTruthy(env.EXPO_PUBLIC_REVIEWER_QUICK_JOIN_ENABLED)) {
    warn('EXPO_PUBLIC_REVIEWER_QUICK_JOIN_ENABLED=1 in ' + buildEnv + '. Confirm this temporary reviewer bypass is still intended before shipping; disable it after the review window (see docs/reviewer-quick-join-temporary.md).');
  }
}

// Optional future rule: enforce CSP hash generation once inline styles removed.

console.log('[enforceProdEnv] Environment checks passed for buildEnv=' + buildEnv);
