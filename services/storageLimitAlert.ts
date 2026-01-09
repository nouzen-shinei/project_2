import { Alert } from 'react-native';
import { logger } from '@/lib/logger';
import { tryPresentModalAlert } from './modalAlertService';

export type StorageLimitReachedInfo = {
  limitBytes: number;
  usedBytes: number;
  incrementBytes?: number;
};

let lastShownKey = '';
let lastShownAt = 0;

export function wasStorageLimitReachedAlertShownRecently(windowMs: number = 3000): boolean {
  const now = Date.now();
  return lastShownAt > 0 && now - lastShownAt <= windowMs;
}

function bytesToMB(bytes: number): string {
  if (!Number.isFinite(bytes)) return '0';
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
}

function tryParseJson(text: string): any | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function tryExtractStorageLimitReachedInfo(input: unknown): StorageLimitReachedInfo | null {
  if (!input) return null;

  // Common patterns: Error(message=JSON string), raw JSON string, or already-parsed object.
  const asAny = input as any;

  const maybeObj =
    typeof input === 'string'
      ? tryParseJson(input)
      : input instanceof Error
        ? tryParseJson(input.message)
        : typeof asAny?.message === 'string'
          ? tryParseJson(asAny.message)
          : typeof input === 'object'
            ? input
            : null;

  if (!maybeObj || typeof maybeObj !== 'object') return null;

  const errCode = String((maybeObj as any).error || '');
  if (errCode !== 'storage_limit_reached') return null;

  const limitBytes = Number((maybeObj as any).limitBytes);
  const usedBytes = Number((maybeObj as any).usedBytes);
  const incrementBytes = (maybeObj as any).incrementBytes;

  if (!Number.isFinite(limitBytes) || !Number.isFinite(usedBytes)) return null;

  const info: StorageLimitReachedInfo = {
    limitBytes,
    usedBytes,
  };

  const inc = Number(incrementBytes);
  if (Number.isFinite(inc)) {
    info.incrementBytes = inc;
  }

  return info;
}

export function maybeShowStorageLimitReachedAlert(input: unknown, context?: string): boolean {
  const info = tryExtractStorageLimitReachedInfo(input);
  if (!info) return false;

  const key = `${info.usedBytes}|${info.limitBytes}|${info.incrementBytes ?? ''}`;
  const now = Date.now();
  if (key === lastShownKey && now - lastShownAt < 5000) {
    return true;
  }

  lastShownKey = key;
  lastShownAt = now;

  const used = bytesToMB(info.usedBytes);
  const limit = bytesToMB(info.limitBytes);
  const inc = typeof info.incrementBytes === 'number' ? bytesToMB(info.incrementBytes) : null;

  const messageLines = [
    `Your storage is full (${used} MB used of ${limit} MB).`,
    inc ? `This upload needs about ${inc} MB.` : null,
    'Please delete some existing uploads (receipts/images/files) and try again.',
  ].filter(Boolean) as string[];

  const message = messageLines.join('\n');

  try {
    const shown = tryPresentModalAlert({
      title: 'Storage limit reached',
      message,
      buttons: [{ text: 'OK', style: 'primary' }],
      variant: 'warning',
    });

    if (!shown) {
      Alert.alert('Storage limit reached', message, [{ text: 'OK' }]);
    }
  } catch (error) {
    logger.warn('[storageLimitAlert] Failed to present alert', { error, context });
  }

  logger.warn('[storageLimitAlert] storage_limit_reached', {
    context,
    limitBytes: info.limitBytes,
    usedBytes: info.usedBytes,
    incrementBytes: info.incrementBytes,
  });

  return true;
}
