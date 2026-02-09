// globalErrorFilter.ts

import { Platform } from 'react-native';
import { maybeShowStorageLimitReachedAlert } from './services/storageLimitAlert';
import { authService } from './hooks/useAuthUnified';

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
  let reloginHandling = false;

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
  function maybeHandleReloginRequired(args: any[], context: string) {
    if (reloginHandling) return;
    try {
      reloginHandling = true;
      for (const arg of args) {
        authService.flagReloginRequired?.(context, arg);
      }
    } finally {
      reloginHandling = false;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function patchedConsoleError(...args: any[]) {
    // App-level: surface relogin-required flow on Firestore permission errors.
    maybeHandleReloginRequired(args, 'globalErrorFilter.console.error');

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
    maybeHandleReloginRequired(args, 'globalErrorFilter.console.warn');
    maybeHandleStorageLimit(args, 'globalErrorFilter.console.warn');
    if (Platform.OS === 'web') {
      const first = typeof args[0] === 'string' ? args[0] : '';
      if (
        first.includes('"shadow*" style props are deprecated') ||
        first.includes('props.pointerEvents is deprecated')
      ) {
        return;
      }
    }
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
          authService.flagReloginRequired?.('globalErrorFilter.unhandledrejection', (event as any)?.reason);
        } catch {
          // ignore
        }
      });
      window.addEventListener('error', (event) => {
        try {
          const err = (event as any)?.error ?? (event as any)?.message;
          maybeShowStorageLimitReachedAlert(err, 'globalErrorFilter.window.error');
          authService.flagReloginRequired?.('globalErrorFilter.window.error', err);
        } catch {
          // ignore
        }
      });
    }
  }

  // @ts-ignore – mark patched
  (console.error as any).__patchedForAppErrorFilter = true;
} 