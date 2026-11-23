import type { ToastProps } from 'react-native-toast-message';

/**
 * Defaults for every toast host (the app root and each open Modal), so a toast
 * looks and times the same wherever it is drawn.
 */
export const APP_TOAST_DEFAULTS = {
  position: 'top',
  topOffset: 60,
  visibilityTime: 4000,
  autoHide: true,
} as const satisfies ToastProps;
