import { logger } from '@/lib/logger';
import { runtimeEndpoints } from './runtimeEndpoints';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
// WhatsApp Business (Cloud API) direct integration service
// IMPORTANT: Do NOT ship permanent access tokens inside the mobile app.
// This client-side service is a thin wrapper that can:
// 1. (Preferred) Call your own backend proxy which holds the secure token.
// 2. (Temporary/dev) Call the Meta Graph API directly ONLY if you (insecurely) inject a short‑lived token at build time.
// Remove option #2 before production.

export interface WABATextMessage {
  to: string;              // E.164 e.g. +9198xxxxxxx
  text: string;            // Session message (only valid inside 24h window)
}

export interface WABATemplateComponentParam {
  type: 'text' | 'currency' | 'date_time';
  text?: string;
  currency?: { fallback_value: string; amount_1000: number; currency_code: string };
  date_time?: { fallback_value: string };
}

export interface WABATemplateMessage {
  to: string;                    // Recipient E.164
  templateName: string;          // Created & approved in WhatsApp Manager
  language: string;              // e.g. en_US
  bodyParams?: WABATemplateComponentParam[]; // Parameters for body placeholders
}

interface WABAServiceConfig {
  phoneNumberId?: string;        // WhatsApp Phone Number ID from Meta
  accessToken?: string;          // (DEV ONLY) temp token – avoid in production bundle
}

class WABAService {
  private config: WABAServiceConfig;

  constructor() {
    // Read only NON-sensitive values from public env
    const phoneNumberId = process.env.EXPO_PUBLIC_WABA_PHONE_NUMBER_ID;
    const insecureAccessToken = process.env.EXPO_PUBLIC_WABA_ACCESS_TOKEN; // SHOULD NOT be used in prod

    this.config = {
      phoneNumberId,
      accessToken: insecureAccessToken,
    };
  }

  private getBackendBaseUrl(): string | undefined {
    const s = runtimeEndpoints.getSnapshot();
    return s.wabaApiBaseUrl || runtimeEndpoints.getPreferredBackendBaseUrl();
  }

  private shouldUseBackendProxy(): boolean {
    return Boolean(this.getBackendBaseUrl()) && !this.config.accessToken;
  }

  /** Normalize a phone number to E.164 (+<digits>) */
  private normalizePhone(number: string): string {
    const digits = number.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    return '+' + digits.replace(/\D/g, '');
  }

  /** Send a template message (allowed to start a new conversation) */
  async sendTemplateMessage(msg: WABATemplateMessage): Promise<boolean> {
    try {
      if (this.shouldUseBackendProxy()) {
        const backendBaseUrl = this.getBackendBaseUrl();
        if (!backendBaseUrl) throw new Error('Backend base URL missing');
        const res = await fetch(`${backendBaseUrl}/whatsapp/send-template`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
        });
        if (!res.ok) {
          const text = await res.text();
          maybeShowMaintenanceAlertFromRaw(res.status, text);
          logger.error('Backend template send failed', text);
          return false;
        }
        return true;
      }

      // Direct (insecure) path for dev only
      if (!this.config.phoneNumberId || !this.config.accessToken) {
        logger.error('WABA direct config missing (phoneNumberId or accessToken)');
        return false;
      }

      const body: any = {
        messaging_product: 'whatsapp',
        to: this.normalizePhone(msg.to),
        type: 'template',
        template: {
          name: msg.templateName,
          language: { code: msg.language },
        },
      };
      if (msg.bodyParams?.length) {
        body.template.components = [
          {
            type: 'body',
            parameters: msg.bodyParams,
          },
        ];
      }

      const res = await fetch(`https://graph.facebook.com/v20.0/${this.config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        logger.error('WABA template send error:', json);
        return false;
      }
      logger.debug('WABA template message sent:', json.messages?.[0]?.id || json);
      return true;
    } catch (e) {
      logger.error('Error sending WABA template message', e);
      return false;
    }
  }

  /** Send a session text message (only valid inside 24h window) */
  async sendTextMessage(msg: WABATextMessage): Promise<boolean> {
    try {
      if (this.shouldUseBackendProxy()) {
        const backendBaseUrl = this.getBackendBaseUrl();
        if (!backendBaseUrl) throw new Error('Backend base URL missing');
        const res = await fetch(`${backendBaseUrl}/whatsapp/send-text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
        });
        if (!res.ok) {
          const text = await res.text();
          maybeShowMaintenanceAlertFromRaw(res.status, text);
          logger.error('Backend text send failed', text);
          return false;
        }
        return true;
      }

      if (!this.config.phoneNumberId || !this.config.accessToken) {
        logger.error('WABA direct config missing (phoneNumberId or accessToken)');
        return false;
      }
      const body = {
        messaging_product: 'whatsapp',
        to: this.normalizePhone(msg.to),
        type: 'text',
        text: { body: msg.text },
      };
      const res = await fetch(`https://graph.facebook.com/v20.0/${this.config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        logger.error('WABA text send error:', json);
        return false;
      }
      logger.debug('WABA text message sent:', json.messages?.[0]?.id || json);
      return true;
    } catch (e) {
      logger.error('Error sending WABA text message', e);
      return false;
    }
  }
}

export const whatsappBusinessService = new WABAService();
