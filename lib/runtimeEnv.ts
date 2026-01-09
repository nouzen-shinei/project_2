// Centralized runtime environment helpers for Expo client.
// All values derived from EXPO_PUBLIC_* variables (public, non-secret).

type BuildEnv = 'development' | 'preview' | 'production';

const RAW_BUILD_ENV = (process.env.EXPO_PUBLIC_BUILD_ENV || 'development').toLowerCase() as BuildEnv;
export const BUILD_ENV: BuildEnv = ['development', 'preview', 'production'].includes(RAW_BUILD_ENV)
  ? (RAW_BUILD_ENV as BuildEnv)
  : 'development';

export const isDev = BUILD_ENV === 'development';
export const isPreview = BUILD_ENV === 'preview';
export const isProd = BUILD_ENV === 'production';

// Logging level resolution: default 'debug' only in dev, else 'info'
export const effectiveLogLevel = (() => {
  const raw = (process.env.EXPO_PUBLIC_LOG_LEVEL || '').toLowerCase();
  if (!raw) return isProd ? 'info' : 'debug';
  if (isProd && ['debug', 'trace', 'silly', 'verbose'].includes(raw)) return 'info';
  return raw;
})();

// Debug auth flag (should only be allowed in dev)
export const debugAuthEnabled = (() => {
  const raw = process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true';
  if (!raw) return false;
  return isDev; // force off automatically outside dev
})();

// Presence tuning (client hints; server authoritative)
export const presenceMode = process.env.EXPO_PUBLIC_PRESENCE_MODE === 'flag' ? 'flag' : 'last_seen';
export const presenceOnlineThresholdMinutes = Number(process.env.EXPO_PUBLIC_FIRESTORE_ONLINE_THRESHOLD_MIN || '0.5');

// Whether to show verbose UI diagnostics
export const verboseUI = isDev || isPreview;

// Hard guard at runtime to warn if disallowed flags are active in production bundles.
let safetyChecked = false;
export function enforceClientSafety() {
  if (safetyChecked) return; // idempotent
  safetyChecked = true;
  try {
    if (isProd && process.env.EXPO_PUBLIC_DEBUG_AUTH === '1') {
      // eslint-disable-next-line no-console
      console.warn('[runtimeEnv] EXPO_PUBLIC_DEBUG_AUTH is set in production build; forcing disabled.');
    }
  } catch { /* noop */ }
}

export function summarizeRuntimeEnv() {
  return {
    BUILD_ENV,
    effectiveLogLevel,
    debugAuthEnabled,
    presenceMode,
    presenceOnlineThresholdMinutes,
  };
}

// Simple feature flag helper
export function featureFlag(name: string, defaultEnabled = false) {
  const key = `EXPO_PUBLIC_FF_${name.toUpperCase()}`;
  const val = (process.env as any)[key];
  if (val == null) return defaultEnabled;
  return val === '1' || val === 'true' || val === 'enabled';
}
