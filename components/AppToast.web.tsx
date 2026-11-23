import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import Toast, { type ToastProps } from 'react-native-toast-message';
import { APP_TOAST_DEFAULTS } from './toastDefaults';

/**
 * Web toast host that always renders above every other surface.
 *
 * Rendered in place, the toast lives inside the app root, while
 * react-native-web `Modal`s, `ConfirmationModal`, the alert portal and other
 * overlays are attached straight to `<body>` with z-index 9999 up to
 * 2147483647. Those layers paint over the root, so toasts fired from inside a
 * popup ended up behind it.
 *
 * This host portals the toast into a dedicated `<body>` child that:
 * - is fixed to the viewport with the maximum z-index, and
 * - is moved back to the end of `<body>` whenever something is appended after
 *   it, so it also wins over other max-z-index layers (equal z-index siblings
 *   paint in DOM order).
 *
 * The layer itself ignores pointer events; the toast's own container is
 * `box-none`, so only the toast card is clickable and the rest of the page
 * keeps working underneath.
 */

const TOAST_LAYER_ID = 'app-toast-layer';

let bodyObserver: MutationObserver | null = null;

function keepLayerLast(layer: HTMLElement) {
  const body = document.body;
  if (body && body.lastElementChild !== layer) {
    body.appendChild(layer);
  }
}

function ensureToastLayer(): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) {
    return null;
  }

  let layer = document.getElementById(TOAST_LAYER_ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = TOAST_LAYER_ID;
    layer.style.position = 'fixed';
    layer.style.inset = '0';
    layer.style.zIndex = '2147483647';
    layer.style.pointerEvents = 'none';
    document.body.appendChild(layer);
  }

  if (!bodyObserver && typeof MutationObserver !== 'undefined') {
    bodyObserver = new MutationObserver(() => {
      const current = document.getElementById(TOAST_LAYER_ID);
      if (current) keepLayerLast(current);
    });
    bodyObserver.observe(document.body, { childList: true });
  }

  keepLayerLast(layer);
  return layer;
}

export default function AppToast(props: ToastProps) {
  // Created during render (not in an effect) so the Toast ref registers in
  // the same commit as before; Toast.show() calls made by sibling effects on
  // first mount keep working. Web output is a client-only SPA, so there is
  // no hydration to mismatch.
  const [layer] = useState(ensureToastLayer);

  const toast = <Toast {...APP_TOAST_DEFAULTS} {...props} />;
  return layer ? createPortal(toast, layer) : toast;
}
