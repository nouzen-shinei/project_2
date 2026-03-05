import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';
import type { UsageHistoryPoint, UsageSummaryResponse } from '@/types/usage';
import { maybeEmitBillingPastDueFromParsed, maybeEmitBillingPastDueFromRaw } from '@/lib/billingPastDue';
import { runtimeEndpoints } from './runtimeEndpoints';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';

export class ReminderQuotaReserveError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(status: number, code: string, details: any) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ReminderBatchSendError extends Error {
  status: number;
  code: string;
  details: any;

  constructor(status: number, code: string, details: any) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class UsageAnalyticsService {
  private readonly debug =
    process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true';

  private ensureBaseUrl(): string {
    const baseUrl = runtimeEndpoints.requirePreferredBackendBaseUrl();
    internalTokenManager.setBaseUrl(baseUrl);
    return baseUrl;
  }

  private async buildHeaders(baseUrl: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await internalTokenManager.getToken(baseUrl);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>) {
    const baseUrl = this.ensureBaseUrl();
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${baseUrl}${normalizedPath}`);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') {
          return;
        }
        url.searchParams.set(key, String(value));
      });
    }
    return url.toString();
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: Record<string, any> | null;
    }
  ): Promise<T> {
    const url = this.buildUrl(path, options?.query);
    const baseUrl = this.ensureBaseUrl();
    let headers = await this.buildHeaders(baseUrl);
    const payload = options?.body ? JSON.stringify(options.body) : undefined;

    let response = await fetch(url, { method, headers, body: payload });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await this.buildHeaders(baseUrl);
      response = await fetch(url, { method, headers, body: payload });
    }

    if (!response.ok) {
      const errorText = await response.text();
          maybeShowMaintenanceAlertFromRaw(response.status, errorText);
      maybeEmitBillingPastDueFromRaw(response.status, errorText);
      const code = errorText || `usage_request_failed_${response.status}`;
      throw new Error(code);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      logger.warn('[usageAnalyticsService] Failed to parse response JSON', { url, error });
      throw error;
    }
  }

  private async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  private async post<T>(
    path: string,
    options?: { body?: Record<string, any> | null; query?: Record<string, string | number | undefined> }
  ): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  async getCurrentUsageSnapshot(tenantId: string, options?: { month?: string | null }): Promise<UsageSummaryResponse> {
    const normalizedTenantId = tenantId?.trim();
    if (!normalizedTenantId) {
      throw new Error('Tenant id is required to load usage analytics.');
    }
    const month = options?.month?.trim();
    if (this.debug) {
      logger.debug('[usageAnalyticsService] Loading /usage/current', { tenantId: normalizedTenantId });
    }
    return await this.get<UsageSummaryResponse>('/usage/current', {
      tenantId: normalizedTenantId,
      month: month || undefined,
    });
  }

  async getUsageHistory(tenantId: string, months: number = 6): Promise<UsageHistoryPoint[]> {
    const normalizedTenantId = tenantId?.trim();
    if (!normalizedTenantId) {
      throw new Error('Tenant id is required to load usage history.');
    }
    return await this.get<UsageHistoryPoint[]>('/usage/history', {
      tenantId: normalizedTenantId,
      months,
    });
  }

  async acknowledgeUsageAlert(alertId: string, tenantId: string): Promise<void> {
    const normalizedId = alertId?.trim();
    if (!normalizedId) {
      throw new Error('Alert id is required to acknowledge usage alerts.');
    }
    const normalizedTenantId = tenantId?.trim();
    if (!normalizedTenantId) {
      throw new Error('Tenant id is required to acknowledge usage alerts.');
    }
    await this.post(`/usage/alerts/${encodeURIComponent(normalizedId)}/ack`, {
      body: { tenantId: normalizedTenantId },
    });
  }

  async requestUsageRefresh(
    tenantId: string,
    options?: { month?: string | null }
  ): Promise<{ requestId: string; month: string; alreadyQueued?: boolean; status?: 'pending' | 'processing' }> {
    const normalizedTenantId = tenantId?.trim();
    if (!normalizedTenantId) {
      throw new Error('Tenant id is required to refresh usage.');
    }
    const month = options?.month?.trim();
    return await this.post<{ requestId: string; month: string; alreadyQueued?: boolean; status?: 'pending' | 'processing' }>(
      '/usage/refresh',
      {
        query: { tenantId: normalizedTenantId },
        body: month ? { month } : undefined,
      },
    );
  }

  async reserveReminderQuotaBatch(
    tenantId: string,
    batchId: string,
    counts: Partial<{ email: number; sms: number; whatsapp: number; voice: number }>
  ): Promise<{ ok: true; monthId: string; reserved: { email: number; sms: number; whatsapp: number; voice: number }; batchId: string }> {
    const normalizedTenantId = tenantId?.trim();
    if (!normalizedTenantId) {
      throw new Error('Tenant id is required to reserve reminder quota.');
    }
    const normalizedBatchId = batchId?.trim();
    if (!normalizedBatchId) {
      throw new Error('Batch id is required to reserve reminder quota.');
    }

    const url = this.buildUrl('/reminders/quota/reserve-batch');
    const baseUrl = this.ensureBaseUrl();
    const payload = JSON.stringify({ tenantId: normalizedTenantId, batchId: normalizedBatchId, counts: counts || {} });

    let headers = await this.buildHeaders(baseUrl);
    let response = await fetch(url, { method: 'POST', headers, body: payload });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await this.buildHeaders(baseUrl);
      response = await fetch(url, { method: 'POST', headers, body: payload });
    }

    if (!response.ok) {
      let details: any = null;
      try {
        details = await response.json();
      } catch {
        details = { text: await response.text().catch(() => '') };
      }

      maybeEmitBillingPastDueFromParsed(response.status, details);

      const code = typeof details?.error === 'string' ? details.error : `reminder_quota_reserve_failed_${response.status}`;
      throw new ReminderQuotaReserveError(response.status, code, details);
    }

    return (await response.json()) as any;
  }

  async sendReminderBatch(
    tenantId: string,
    batchId: string,
    items: Array<Record<string, any>>
  ): Promise<{
    ok: true;
    tenantId: string;
    batchId: string;
    monthId: string;
    results: Array<{
      studentId: string;
      type: 'email' | 'sms' | 'whatsapp' | 'voice';
      status: 'pending' | 'queued' | 'success' | 'failed' | 'skipped';
      message?: string;
      jobId?: string;
    }>;
  }> {
    const normalizedTenantId = tenantId?.trim();
    if (!normalizedTenantId) {
      throw new Error('Tenant id is required to send reminder batch.');
    }
    const normalizedBatchId = batchId?.trim();
    if (!normalizedBatchId) {
      throw new Error('Batch id is required to send reminder batch.');
    }
    const normalizedItems = Array.isArray(items) ? items : [];
    if (normalizedItems.length === 0) {
      throw new Error('At least one reminder item is required to send reminder batch.');
    }

    const url = this.buildUrl('/reminders/batch/send');
    const baseUrl = this.ensureBaseUrl();
    const payload = JSON.stringify({ tenantId: normalizedTenantId, batchId: normalizedBatchId, items: normalizedItems });

    let headers = await this.buildHeaders(baseUrl);
    let response = await fetch(url, { method: 'POST', headers, body: payload });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await this.buildHeaders(baseUrl);
      response = await fetch(url, { method: 'POST', headers, body: payload });
    }

    if (!response.ok) {
      let details: any = null;
      try {
        details = await response.json();
      } catch {
        details = { text: await response.text().catch(() => '') };
      }

      maybeEmitBillingPastDueFromParsed(response.status, details);

      const code = typeof details?.error === 'string' ? details.error : `reminder_batch_send_failed_${response.status}`;
      throw new ReminderBatchSendError(response.status, code, details);
    }

    return (await response.json()) as any;
  }

  async getReminderHistoryStatuses(
    tenantId: string,
    historyIds: string[],
  ): Promise<{
    results: Array<{
      historyId: string;
      status: 'pending' | 'queued' | 'success' | 'failed' | 'skipped';
      message?: string;
    }>;
  }> {
    if (!Array.isArray(historyIds) || historyIds.length === 0) {
      return { results: [] };
    }

    return this.request('GET', '/reminders/history/status', {
      query: {
        tenantId,
        historyIds: historyIds.join(','),
      },
    });
  }
}

export const usageAnalyticsService = new UsageAnalyticsService();
