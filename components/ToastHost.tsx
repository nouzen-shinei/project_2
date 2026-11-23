import React, { createContext, useEffect, useSyncExternalStore } from 'react';
import Toast, { type ToastProps } from 'react-native-toast-message';
import { ToastHostStack, type ToastHostKind } from '@/lib/toastHostStack';
import { APP_TOAST_DEFAULTS } from './toastDefaults';

/**
 * Native (iOS/Android) toast hosts. See lib/toastHostStack.ts for the routing
 * rules. Web does not use this file: AppToast.web.tsx draws a single toast
 * layer above every popup instead.
 */

type ToastStatics = {
  show: typeof Toast.show;
  hide: typeof Toast.hide;
};

// Keep the library's own show/hide once, even if this module is re-evaluated
// by Fast Refresh, so the replacements never wrap each other.
const ORIGINALS_KEY = '__appToastOriginals';
const toastStatics = Toast as unknown as ToastStatics & { [ORIGINALS_KEY]?: ToastStatics };
const originals: ToastStatics =
  toastStatics[ORIGINALS_KEY] ??
  (toastStatics[ORIGINALS_KEY] = { show: Toast.show, hide: Toast.hide });

export const toastHostStack = new ToastHostStack({
  show: (params) => originals.show(params),
  hide: () => originals.hide(),
  defaultVisibilityTime: APP_TOAST_DEFAULTS.visibilityTime,
  defaultAutoHide: APP_TOAST_DEFAULTS.autoHide,
});

// Every existing `Toast.show(...)` / `Toast.hide()` call goes through the
// stack, so call sites do not change.
Toast.show = toastHostStack.show;
Toast.hide = toastHostStack.hide;

/** Host id of the nearest enclosing AppModal, for nested-modal ordering. */
export const ToastHostParentContext = createContext<number | null>(null);

type ToastHostProps = {
  hostId: number;
  kind: ToastHostKind;
  parentId?: number | null;
  /** Modal hosts pass the Modal's `visible`, so a closing modal hands the toast over at once. */
  enabled?: boolean;
  toastProps?: ToastProps;
};

export function ToastHost({
  hostId,
  kind,
  parentId = null,
  enabled = true,
  toastProps,
}: ToastHostProps) {
  useEffect(() => {
    if (!enabled) return undefined;
    toastHostStack.registerHost(hostId, kind, parentId);
    return () => toastHostStack.unregisterHost(hostId);
  }, [enabled, hostId, kind, parentId]);

  const isTop = useSyncExternalStore(
    toastHostStack.subscribe,
    () => enabled && toastHostStack.getTopHostId() === hostId,
  );

  // Runs after the <Toast> below has mounted and registered its ref, so a
  // toast moved here is shown on this instance.
  useEffect(() => {
    if (!isTop) return undefined;
    toastHostStack.hostMounted(hostId);
    return () => toastHostStack.hostUnmounted(hostId);
  }, [isTop, hostId]);

  if (!isTop) return null;
  return <Toast {...APP_TOAST_DEFAULTS} {...toastProps} />;
}
