import React, { useState } from 'react';
import type { ToastProps } from 'react-native-toast-message';
import { ToastHost, toastHostStack } from './ToastHost';

/**
 * Root toast host for iOS/Android (web uses AppToast.web.tsx).
 *
 * A react-native `Modal` is a separate native window, so this root host is
 * hidden behind any open Modal. Each Modal from components/AppModal carries
 * its own host, and toasts are drawn by whichever host is on top; this one
 * takes over again when the last modal closes. Defaults live in
 * toastDefaults.ts so every host matches.
 */
export default function AppToast(props: ToastProps) {
  const [hostId] = useState(toastHostStack.nextHostId);
  return <ToastHost hostId={hostId} kind="root" toastProps={props} />;
}
