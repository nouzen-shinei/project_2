#!/usr/bin/env node
// Simple version bump utility for Expo app.json and package.json
// Usage:
//   node scripts/bumpVersion.js patch|minor|major
//   node scripts/bumpVersion.js set 1.2.3
// Also updates:
// - eas.json EXPO_PUBLIC_RELEASE_MONTH for preview/production to current Month YYYY
// - .env: EXPO_PUBLIC_APP_VERSION, EXPO_PUBLIC_APP_BUILD, EXPO_PUBLIC_RELEASE_MONTH

const fs = require('fs');
const path = require('path');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function bumpSemver(ver, type) {
  const m = ver.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) throw new Error(`Invalid semver: ${ver}`);
  let [major, minor, patch] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  if (type === 'major') {
    major += 1; minor = 0; patch = 0;
  } else if (type === 'minor') {
    minor += 1; patch = 0;
  } else if (type === 'patch') {
    patch += 1;
  } else {
    throw new Error(`Unknown bump type: ${type}`);
  }
  return `${major}.${minor}.${patch}`;
}

function monthYearString(date = new Date()) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function setReleaseMonth(eas) {
  const month = monthYearString();
  if (eas.build && eas.build.preview && eas.build.preview.env) {
    eas.build.preview.env.EXPO_PUBLIC_RELEASE_MONTH = month;
  }
  if (eas.build && eas.build.production && eas.build.production.env) {
    eas.build.production.env.EXPO_PUBLIC_RELEASE_MONTH = month;
  }
}

function ensureEnvLine(lines, key, value) {
  const idx = lines.findIndex(l => l.trim().startsWith(`${key}=`));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry; else lines.push(entry);
}

(function main() {
  const root = process.cwd();
  const appJsonPath = path.join(root, 'app.json');
  const pkgJsonPath = path.join(root, 'package.json');
  const easJsonPath = path.join(root, 'eas.json');
  const dotEnvPath = path.join(root, '.env');

  const appJson = readJson(appJsonPath);
  const pkgJson = readJson(pkgJsonPath);
  const easJson = readJson(easJsonPath);
  const envExists = fs.existsSync(dotEnvPath);
  const envRaw = envExists ? fs.readFileSync(dotEnvPath, 'utf8') : '';
  const envLines = envRaw.split(/\r?\n/).filter(Boolean);

  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node scripts/bumpVersion.js patch|minor|major | set <version>');
    process.exit(1);
  }

  let nextVersion;
  const curVersion = appJson.expo?.version || pkgJson.version;
  if (!curVersion) {
    console.error('Could not determine current version from app.json or package.json');
    process.exit(1);
  }

  if (args[0] === 'set') {
    nextVersion = args[1];
    if (!nextVersion) {
      console.error('Provide a version: node scripts/bumpVersion.js set 1.2.3');
      process.exit(1);
    }
  } else {
    nextVersion = bumpSemver(curVersion, args[0]);
  }

  // Update versions
  if (!appJson.expo) appJson.expo = {};
  appJson.expo.version = nextVersion;
  pkgJson.version = nextVersion;

  // Update release month env
  setReleaseMonth(easJson);

  // Update .env for web builds
  const month = monthYearString();
  // Compute a simple build code: YYYYMM.patch (increase patch per bump)
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  // Try to preserve existing build if present, else synthesize one
  const existingBuildLine = envLines.find(l => l.startsWith('EXPO_PUBLIC_APP_BUILD='));
  let nextBuild = `${yyyymm}.1`;
  if (existingBuildLine) {
    const val = existingBuildLine.split('=')[1] || '';
    const m = val.match(/^(\d{6})\.(\d+)$/);
    if (m && m[1] === yyyymm) {
      nextBuild = `${yyyymm}.${parseInt(m[2]) + 1}`;
    }
  }

  ensureEnvLine(envLines, 'EXPO_PUBLIC_APP_VERSION', nextVersion);
  ensureEnvLine(envLines, 'EXPO_PUBLIC_APP_BUILD', nextBuild);
  ensureEnvLine(envLines, 'EXPO_PUBLIC_RELEASE_MONTH', month);

  // Derive native build identifiers from EXPO_PUBLIC_APP_BUILD (format: YYYYMM.patch)
  // Android requires a monotonically increasing integer versionCode.
  // We'll map YYYYMM.patch -> YYYYMMpp (pp = patch padded to 2 digits), e.g., 202509.1 -> 20250901
  // iOS buildNumber is a string; we'll use the same YYYYMMpp format for consistency.
  try {
    const [buildYm, buildPatchRaw] = String(nextBuild).split('.')
    const patchNum = Math.max(0, parseInt(buildPatchRaw || '0', 10) || 0);
    const versionCodeStr = `${buildYm}${String(patchNum).padStart(2, '0')}`;
    const versionCodeInt = parseInt(versionCodeStr, 10);

    if (!appJson.expo.ios) appJson.expo.ios = {};
    if (!appJson.expo.android) appJson.expo.android = {};

    // iOS: use the same numeric string; Apple only requires monotonic increase.
    appJson.expo.ios.buildNumber = versionCodeStr;

    // Android: ensure we never decrease the versionCode.
    const currentVc = parseInt(appJson.expo.android.versionCode || '0', 10) || 0;
    appJson.expo.android.versionCode = Math.max(currentVc, versionCodeInt);
  } catch (e) {
    console.warn('Warning: failed to derive native build numbers from EXPO_PUBLIC_APP_BUILD:', e?.message || e);
  }

  writeJson(appJsonPath, appJson);
  writeJson(pkgJsonPath, pkgJson);
  writeJson(easJsonPath, easJson);
  fs.writeFileSync(dotEnvPath, envLines.join('\n') + '\n');

  console.log(`Bumped version: ${curVersion} -> ${nextVersion}`);
  console.log(`Updated EXPO_PUBLIC_RELEASE_MONTH to: ${monthYearString()}`);
  console.log(`Updated .env: EXPO_PUBLIC_APP_VERSION=${nextVersion}, EXPO_PUBLIC_APP_BUILD=${nextBuild}, EXPO_PUBLIC_RELEASE_MONTH=${month}`);
  if (appJson?.expo?.ios?.buildNumber) {
    console.log(`Set iOS buildNumber -> ${appJson.expo.ios.buildNumber}`);
  }
  if (appJson?.expo?.android?.versionCode != null) {
    console.log(`Set Android versionCode -> ${appJson.expo.android.versionCode}`);
  }
  console.log('Done. Commit changes before running EAS build.');
})();
