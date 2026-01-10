import { Alert } from 'react-native';
import { logger } from '@/lib/logger';
import { tryPresentModalAlert } from './modalAlertService';

export type StorageLimitReachedInfo = {
  limitBytes: number;
  usedBytes: number;
  incrementBytes?: number;
};

export type StorageLimitAlertOptions = {
  /** Override the incremental bytes shown in the message (e.g., actual blob size). */
  incrementBytes?: number;
  /** Additional message lines to append for contextual guidance. */
  extraMessageLines?: string[];
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

export function maybeShowStorageLimitReachedAlert(
  input: unknown,
  context?: string,
  options?: StorageLimitAlertOptions,
): boolean {
  const info = tryExtractStorageLimitReachedInfo(input);
  if (!info) return false;

  // Include extra lines in dedup key so different contextual alerts show (e.g., notice upload vs receipt upload).
  const extraKey = Array.isArray(options?.extraMessageLines) ? options!.extraMessageLines.join('|') : '';
  const key = `${info.usedBytes}|${info.limitBytes}|${info.incrementBytes ?? ''}|${extraKey}`;
  const now = Date.now();
  if (key === lastShownKey && now - lastShownAt < 5000) {
    return true;
  }

  lastShownKey = key;
  lastShownAt = now;

  const used = bytesToMB(info.usedBytes);
  const limit = bytesToMB(info.limitBytes);
  const resolvedIncrementBytes =
    typeof options?.incrementBytes === 'number' && Number.isFinite(options.incrementBytes)
      ? options.incrementBytes
      : info.incrementBytes;
  const inc = typeof resolvedIncrementBytes === 'number' ? bytesToMB(resolvedIncrementBytes) : null;

  const messageLines = [
    `Your storage is full (${used} MB used of ${limit} MB).`,
    inc ? `This upload needs about ${inc} MB.` : null,
    'Please delete some existing uploads (receipts/images/files) and try again.',
    'You can also upgrade your plan for more storage.',
    ...(Array.isArray(options?.extraMessageLines) ? options!.extraMessageLines.filter(Boolean) : []),
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
