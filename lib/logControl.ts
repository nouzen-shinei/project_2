import { logger } from '@/lib/logger';
// Centralized runtime log control. This runs very early (import from root layout entry)
// It allows toggling all console.* outputs (except error and warn optionally) via env flag.

const rawDisable = process.env.EXPO_PUBLIC_DISABLE_LOGS;
const shouldDisable = rawDisable === '1' || rawDisable === 'true';

// Optional: allow keeping warnings
const keepWarn = process.env.EXPO_PUBLIC_KEEP_WARN === '1' || process.env.EXPO_PUBLIC_KEEP_WARN === 'true';

if (shouldDisable) {
  const noop = () => {};
  // Preserve original error & (optionally) warn for critical visibility
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.trace = noop;
  console.group = noop as any;
  console.groupCollapsed = noop as any;
  console.groupEnd = noop as any;
  if (!keepWarn) {
    console.warn = noop;
  }
  // Provide one-time notice (cannot use console.log anymore, so use error)
  try { logger.error('[logControl] Non-error console output disabled'); } catch {}
}

export const loggingDisabled = shouldDisable;