// globalErrorFilter.ts

import { Platform } from 'react-native';
import { maybeShowStorageLimitReachedAlert } from './services/storageLimitAlert';

/**
 * Suppress the noisy React-Native-Web warning:
 *   "Unexpected text node: . A text node cannot be a child of a <View>."
 * This comes from third-party libraries that sometimes inject an empty
 * text node (just a period). The warning is harmless but floods the
 * console and slows the app because `console.error` triggers expensive
 * stack traces and React DevTools overlays.
 *
 * We monkey-patch `console.error` on the **web** runtime only and drop
 * those specific messages while forwarding everything else.
 */
export function installErrorFilter() {
  // Already installed?
  // @ts-ignore – we attach a flag to the function itself.
  if ((console.error as any).__patchedForAppErrorFilter) return;

  const originalError = console.error;
  const originalWarn = console.warn;

  let handling = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function maybeHandleStorageLimit(args: any[], context: string) {
    if (handling) return;
    try {
      handling = true;
      for (const arg of args) {
        // Try each arg; helper is safe and returns boolean.
        if (maybeShowStorageLimitReachedAlert(arg, context)) {
          return;
        }
        // Sometimes the JSON is embedded as a string inside another string.
        if (typeof arg === 'string' && arg.includes('storage_limit_reached')) {
          maybeShowStorageLimitReachedAlert(arg, context);
          return;
        }
        if (arg instanceof Error && typeof arg.message === 'string' && arg.message.includes('storage_limit_reached')) {
          maybeShowStorageLimitReachedAlert(arg.message, context);
          return;
        }
      }
    } finally {
      handling = false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function patchedConsoleError(...args: any[]) {
    // App-level: surface tenant storage limit errors consistently.
    maybeHandleStorageLimit(args, 'globalErrorFilter.console.error');

    // Web-only: silence noisy RNW warning.
    if (Platform.OS === 'web') {
      if (
        typeof args[0] === 'string' &&
        args[0].includes('Unexpected text node') &&
        args[0].includes('A text node cannot be a child of a <View>')
      ) {
        return;
      }
    }
    // Forward everything else
    // @ts-ignore – preserve original signature
    originalError.apply(console, args);
  }

  // @ts-ignore – override
  console.error = patchedConsoleError;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function patchedConsoleWarn(...args: any[]) {
    maybeHandleStorageLimit(args, 'globalErrorFilter.console.warn');
    // @ts-ignore – preserve original signature
    originalWarn.apply(console, args);
  }

  // @ts-ignore – override
  console.warn = patchedConsoleWarn;

  // Web-only: also catch unhandled promise rejections/errors.
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const anyWindow = window as any;
    if (!anyWindow.__storageLimitGlobalHandlersInstalled) {
      anyWindow.__storageLimitGlobalHandlersInstalled = true;
      window.addEventListener('unhandledrejection', (event) => {
        try {
          maybeShowStorageLimitReachedAlert((event as any)?.reason, 'globalErrorFilter.unhandledrejection');
        } catch {
          // ignore
        }
      });
      window.addEventListener('error', (event) => {
        try {
          const err = (event as any)?.error ?? (event as any)?.message;
          maybeShowStorageLimitReachedAlert(err, 'globalErrorFilter.window.error');
        } catch {
          // ignore
        }
      });
    }
  }

  // @ts-ignore – mark patched
  (console.error as any).__patchedForAppErrorFilter = true;
} 