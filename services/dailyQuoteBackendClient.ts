import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { runtimeEndpoints } from './runtimeEndpoints';

export type DailyQuoteTimeOfDay = 'morning' | 'evening' | 'immediate' | 'auto';

export interface DailyQuoteJobStats {
  runStartedAt: string;
  runCompletedAt: string;
  dryRun: boolean;
  reason: string;
  totalUserDocs: number;
  totalDevices: number;
  eligibleDevices: number;
  attemptedDeliveries: number;
  sent: number;
  failed: number;
  skipped: {
    notificationsDisabled: number;
    dailyQuotesDisabled: number;
    missingToken: number;
    webDevice: number;
    duplicateToken: number;
    outsideWindow: number;
    deletedDevice: number;
  };
  timeOfDayBreakdown: Record<'morning' | 'evening' | 'immediate', { attempted: number; sent: number }>;
  quote: {
    text: string;
    author: string;
    category: string;
    source?: string;
  };
  recipientsSample: Array<{ userEmail: string; deviceId: string; timeOfDay: 'morning' | 'evening' | 'immediate'; timezone?: string }>;
}

export interface DailyQuoteBackendStatus {
  enabled: boolean;
  schedulerStarted: boolean;
  schedulerMode: 'interval' | 'time_of_day';
  intervalMs: number;
  windowMinutes: number;
  nextRunAt: string | null;
  nextRunByTimeOfDay?: Partial<Record<'morning' | 'evening', string | null>>;
  lastRunAt: string | null;
  isRunning: boolean;
  lastRunStats: DailyQuoteJobStats | null;
}

export interface DailyQuoteTriggerResponse {
  ok: boolean;
  stats?: DailyQuoteJobStats;
  error?: string;
}

interface TriggerPayload {
  tenantId: string;
  timeOfDay?: DailyQuoteTimeOfDay;
  targetEmails?: string[];
  dryRun?: boolean;
  reason?: string;
  now?: string;
}

class DailyQuoteBackendClient {
  private debug = process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true';

  private getBaseUrl(): string | undefined {
    const s = runtimeEndpoints.getSnapshot();
    const baseUrl = s.notificationsApiBaseUrl || runtimeEndpoints.getPreferredBackendBaseUrl();
    if (baseUrl) {
      internalTokenManager.setBaseUrl(baseUrl);
    }
    return baseUrl;
  }

  private requireBase(): string {
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) {
      throw new Error(
        'Backend URL not configured. Set Firestore appSettings/runtimeEndpoints.apiBaseUrl (or notificationsApiBaseUrl) to enable daily quotes backend.',
      );
    }
    return baseUrl;
  }

  private async buildHeaders() {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const baseUrl = this.getBaseUrl();
    if (!baseUrl) return headers;
    const token = await internalTokenManager.getToken(baseUrl);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (this.debug) {
      logger.debug('[daily-quote-backend] headers built', { haveToken: Boolean(token) });
    }
    return headers;
  }

  async trigger(payload: TriggerPayload): Promise<DailyQuoteTriggerResponse> {
    const baseUrl = this.requireBase();
    const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId.trim() : '';
    if (!tenantId) {
      return { ok: false, error: 'tenant_required' };
    }
    try {
      let response = await fetch(`${baseUrl}/notifications/daily-quotes/trigger`, {
        method: 'POST',
        headers: await this.buildHeaders(),
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        await internalTokenManager.forceRefresh(baseUrl);
        response = await fetch(`${baseUrl}/notifications/daily-quotes/trigger`, {
          method: 'POST',
          headers: await this.buildHeaders(),
          body: JSON.stringify(payload),
        });
      }

      if (!response.ok) {
        const text = await this.safeText(response);
        if (this.debug) {
          logger.debug('[daily-quote-backend] trigger failed', { status: response.status, text });
        }
        return { ok: false, error: text };
      }

      const data = await response.json();
      return data as DailyQuoteTriggerResponse;
    } catch (error) {
      logger.warn('[daily-quote-backend] trigger error', error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getStatus(): Promise<DailyQuoteBackendStatus | null> {
    const baseUrl = this.requireBase();
    try {
      let response = await fetch(`${baseUrl}/notifications/daily-quotes/status`, {
        headers: await this.buildHeaders(),
      });

      if (response.status === 401) {
        await internalTokenManager.forceRefresh(baseUrl);
        response = await fetch(`${baseUrl}/notifications/daily-quotes/status`, {
          headers: await this.buildHeaders(),
        });
      }

      if (!response.ok) {
        const text = await this.safeText(response);
        if (this.debug) {
          logger.debug('[daily-quote-backend] status failed', { status: response.status, text });
        }
        return null;
      }

      return (await response.json()) as DailyQuoteBackendStatus;
    } catch (error) {
      logger.warn('[daily-quote-backend] status error', error);
      return null;
    }
  }

  private async safeText(response: Response): Promise<string> {
    try {
      const text = await response.text();
      maybeShowMaintenanceAlertFromRaw(response.status, text);
      return text;
    } catch {
      return String(response.status);
    }
  }
}

export const dailyQuoteBackendClient = new DailyQuoteBackendClient();
