import { Alert } from 'react-native';

const DEFAULT_MESSAGE = 'We are currently performing maintenance. Please try again shortly.';
const COOLDOWN_MS = 15_000;

let lastShownAt = 0;
let maintenanceScreenVisible = false;

export function setMaintenanceScreenVisible(visible: boolean): void {
  maintenanceScreenVisible = Boolean(visible);
}

export function isMaintenanceScreenVisible(): boolean {
  return maintenanceScreenVisible;
}

function now(): number {
  return Date.now();
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function maybeShowMaintenanceAlertFromRaw(status: number, rawBody?: string | null): void {
  if (status !== 503) return;
  if (maintenanceScreenVisible) return;

  const body = (rawBody || '').toString();
  const parsed = body ? safeJsonParse(body) : null;
  const isMaintenance = parsed && typeof parsed === 'object' && parsed.error === 'maintenance';
  if (!isMaintenance) return;

  const t = now();
  if (t - lastShownAt < COOLDOWN_MS) return;
  lastShownAt = t;

  const message = typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message.trim() : DEFAULT_MESSAGE;
  try {
    Alert.alert('Maintenance', message, [{ text: 'OK' }]);
  } catch {
    // ignore
  }
}

export async function maybeShowMaintenanceAlertFromResponse(res: any): Promise<void> {
  if (!res || typeof res.status !== 'number') return;
  if (res.status !== 503) return;

  // Use clone() when available so callers can still read the main response body.
  try {
    const clone = typeof res.clone === 'function' ? res.clone() : null;
    if (!clone || typeof clone.text !== 'function') {
      return;
    }

    const text = await clone.text();
    maybeShowMaintenanceAlertFromRaw(res.status, text);
  } catch {
    // ignore
  }
}
