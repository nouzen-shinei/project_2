// Centralized application logger.
// Usage: import { logger } from '@/lib/logger'; logger.info('message', data)
// Honors env flags:
//   EXPO_PUBLIC_DISABLE_LOGS=1 -> suppresses all non-error output
//   EXPO_PUBLIC_LOG_LEVEL=debug|info|warn|error (default: debug unless disabled)
//   EXPO_PUBLIC_KEEP_WARN=1 (handled in logControl for console override, but we also respect here)

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const rawDisable = process.env.EXPO_PUBLIC_DISABLE_LOGS;
const globallyDisabled = rawDisable === '1' || rawDisable === 'true';
const keepWarn = process.env.EXPO_PUBLIC_KEEP_WARN === '1' || process.env.EXPO_PUBLIC_KEEP_WARN === 'true';
// Allow runtime override via URL query parameter (?log=info) on web for convenience.
let configuredLevel = (process.env.EXPO_PUBLIC_LOG_LEVEL as LogLevel) || 'debug';
try {
  if (typeof window !== 'undefined' && typeof URL !== 'undefined') {
    const lvl = new URL(window.location.href).searchParams.get('log') as LogLevel | null;
    if (lvl && lvl in LEVEL_ORDER) configuredLevel = lvl;
  }
} catch {}
const activeLevel: LogLevel = globallyDisabled ? 'error' : (configuredLevel in LEVEL_ORDER ? configuredLevel : 'debug');

interface LoggerConfig {
  level: LogLevel;
  redactKeys?: string[];
}

let dynamicConfig: LoggerConfig = {
  level: activeLevel,
};

let context: Record<string, unknown> = {};

function shouldLog(level: LogLevel) {
  if (globallyDisabled && level !== 'error' && !(keepWarn && level === 'warn')) return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[dynamicConfig.level];
}

function redact(value: any, redactKeys?: string[]): any {
  if (!redactKeys || !value) return value;
  try {
    if (Array.isArray(value)) return value.map(v => redact(v, redactKeys));
    if (typeof value === 'object') {
      const clone: any = Array.isArray(value) ? [] : {};
      for (const k of Object.keys(value)) {
        if (redactKeys.includes(k)) {
          clone[k] = '***';
        } else {
          clone[k] = redact(value[k], redactKeys);
        }
      }
      return clone;
    }
  } catch {}
  return value;
}

// Choose a stable output function for debug to avoid browser filtering (some browsers hide console.debug by default)
const debugWriter: (...a:any[])=>void = (() => {
  try {
    if (process && process.env && process.env.EXPO_PUBLIC_FORCE_DEBUG_TO_LOG === '1') {
      return console.log.bind(console);
    }
  } catch {}
  // Prefer console.log for web since console.debug is often hidden unless Verbose level selected
  try {
    if (typeof window !== 'undefined') return console.log.bind(console);
  } catch {}
  // Fallback to console.debug if available (native / Node envs)
  return (console.debug ? console.debug.bind(console) : console.log.bind(console));
})();

// Simple color mapping for web terminals (ignored by native consoles gracefully)
const COLOR: Record<LogLevel, string> = {
  debug: '#888',
  info: '#0366d6',
  warn: '#b7791f',
  error: '#d73a49'
};

function baseEmit(level: LogLevel, args: any[]) {
  if (!shouldLog(level)) return;
  const processed = dynamicConfig.redactKeys
    ? args.map(a => redact(a, dynamicConfig.redactKeys))
    : args;
  const ctx = Object.keys(context).length ? ['ctx:', context] : [];
  const writer = level === 'debug'
    ? debugWriter
    // @ts-ignore
    : (console[level] ? console[level].bind(console) : console.log.bind(console));

  // Keep color hint on web (applied to first argument if string) without adding any prefix text.
  try {
    if (typeof window !== 'undefined' && processed.length && typeof processed[0] === 'string') {
      const color = COLOR[level];
      writer(`%c${processed[0]}`, `color:${color}; font-weight:${level==='error'?'700':'500'};`, ...ctx, ...processed.slice(1));
      return;
    }
  } catch {}
  writer(...ctx, ...processed);
}

export const logger = {
  debug: (...a: any[]) => baseEmit('debug', a),
  info: (...a: any[]) => baseEmit('info', a),
  warn: (...a: any[]) => baseEmit('warn', a),
  error: (...a: any[]) => baseEmit('error', a),
  metric: (name: string, data?: Record<string, unknown>) => {
    const payload = data ? { ...data, _ts: new Date().toISOString() } : { _ts: new Date().toISOString() };
    baseEmit('info', [`metric:${name}`, payload]);
  },
  setContext(newCtx: Record<string, unknown>) {
    context = { ...context, ...newCtx };
  },
  clearContext(keys?: string[]) {
    if (!keys) { context = {}; return; }
    for (const k of keys) delete context[k];
  },
  configure(partial: Partial<LoggerConfig>) {
    dynamicConfig = { ...dynamicConfig, ...partial };
  },
  time(label: string) {
    return performanceNow(label);
  }
};

// Lightweight timer helper returning a closure
function performanceNow(label: string) {
  const start = Date.now();
  return () => {
    const ms = Date.now() - start;
    logger.debug(`${label} completed in ${ms}ms`);
    return ms;
  };
}

// Immediately log initial state (only once, and only if debug level active)
if (!globallyDisabled && LEVEL_ORDER[activeLevel] <= LEVEL_ORDER.debug) {
  logger.debug('Logger initialized', { level: activeLevel, disabled: globallyDisabled });
}

export type { LogLevel };