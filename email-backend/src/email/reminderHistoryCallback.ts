import fetch from 'node-fetch';
import pino from 'pino';
import { getPreferredBackendBaseUrl } from '../runtimeEndpoints.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export type ReminderHistoryEmailCallbackPayload = {
  historyId: string;
  tenantId?: string;
  status?: 'queued' | 'success' | 'failed';
  deliveryStatus?: 'queued' | 'retrying' | 'sent' | 'failed';
  emailId?: string;
  provider?: string;
  errorMessage?: string;
};

async function getCallbackUrl(): Promise<string | null> {
  const envBase = (process.env.BACKEND_RUNTIME_URL || '').trim();
  const base = (await getPreferredBackendBaseUrl()) || envBase || '';
  if (!base) return null;
  return base.replace(/\/+$/, '') + '/internal/reminder-history/email-result';
}

function getCallbackAuthToken(): string | null {
  const token = (process.env.BACKEND_RUNTIME_INTERNAL_KEY || process.env.INTERNAL_API_KEY || '').trim();
  return token || null;
}

function clampString(s: unknown, maxLen: number): string | undefined {
  if (typeof s !== 'string') return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

export async function notifyBackendRuntimeEmailResult(input: ReminderHistoryEmailCallbackPayload): Promise<void> {
  const url = await getCallbackUrl();
  const token = getCallbackAuthToken();
  const historyId = clampString(input.historyId, 240);

  if (!url || !token || !historyId) return;

  const payload: ReminderHistoryEmailCallbackPayload = {
    historyId,
    tenantId: clampString(input.tenantId, 120),
    status: input.status,
    deliveryStatus: input.deliveryStatus,
    emailId: clampString(input.emailId, 500),
    provider: clampString(input.provider, 100),
    errorMessage: clampString(input.errorMessage, 2000),
  };

  const controller = new AbortController();
  const timeoutMs = Number(process.env.BACKEND_RUNTIME_CALLBACK_TIMEOUT_MS || '3000');
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 3000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.warn({
        msg: 'backend_runtime_reminder_history_callback_failed',
        status: res.status,
        body: text.slice(0, 200),
      });
    }
  } catch (error: any) {
    logger.warn({
      msg: 'backend_runtime_reminder_history_callback_error',
      err: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}
