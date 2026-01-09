import { logger } from '@/lib/logger';
import { maybeEmitBillingPastDueFromRaw } from '@/lib/billingPastDue';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
// Lightweight client for backend WhatsApp queue endpoints.
// NOTE: Backend internal auth (INTERNAL_API_KEY) should NOT be exposed in production build.
// If backend is secured, expose a safer auth mechanism (e.g., short‑lived token via your own auth API).
// Using relative import to avoid Jest alias config dependency in consumer environments
import { internalTokenManager } from './internalTokenManager';
import { runtimeEndpoints } from './runtimeEndpoints';

export interface QueueFeeReminderPayload {
  tenantId: string;
  tenantName?: string;
  to: string;
  parentName?: string;
  studentName: string;
  amount: number;
  dueDate: string; // already formatted or raw; backend will format template display
  greeting?: string;
  customNotes?: string;
  customNotesEnglish?: string | null;
  customNotesHindi?: string | null;
  teacherName?: string;
  coachingName?: string;
  selectedLanguage?: 'english' | 'hindi' | 'both';
  languageOrder?: 'english-first' | 'hindi-first';
  quotaBatchId?: string;
  historyId?: string;
  history?: any;
}

export interface QueueCustomMessagePayload {
  tenantId: string;
  tenantName?: string;
  to: string;
  message: string;
  teacherName?: string;
  coachingName?: string;
  selectedLanguage?: 'english' | 'hindi' | 'both';
  languageOrder?: 'english-first' | 'hindi-first';
  englishMessage?: string;
  hindiMessage?: string;
  quotaBatchId?: string;
  historyId?: string;
  history?: any;
}

export interface QueuePaymentConfirmationPayload {
  tenantId: string;
  tenantName?: string;
  to: string;
  parentName?: string;
  studentName: string;
  amount: number;
  paymentDate: string; // formatted or raw date
  greeting?: string;
  additionalNote?: string;
  teacherName?: string;
  coachingName?: string;
  selectedLanguage?: 'english' | 'hindi' | 'both';
  languageOrder?: 'english-first' | 'hindi-first';
  quotaBatchId?: string;
  historyId?: string;
  history?: any;
}

interface QueueResult { jobId?: string; queued?: boolean; error?: string }

export class WhatsAppQueueClient {
  // Legacy direct master key path removed: we no longer support EXPO_PUBLIC_INTERNAL_API_KEY in production.
  // Dev-only shortcut using EXPO_PUBLIC_INTERNAL_TOKEN_DEV_SECRET is handled by internalTokenManager.
  private debug = (process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true');
  private log(...args:any[]){ if(this.debug) logger.debug('[wa-queue-debug]', ...args); }

  constructor() {
    // URL is resolved at runtime from Firestore (appSettings/runtimeEndpoints)
  }

  private resolveBase(): string {
    const snap = runtimeEndpoints.getSnapshot();
    const base = snap.wabaApiBaseUrl || runtimeEndpoints.getPreferredBackendBaseUrl();
    if (!base) {
      throw new Error(
        'WhatsApp backend URL not configured. Set Firestore appSettings/runtimeEndpoints.wabaApiBaseUrl (or apiBaseUrl).',
      );
    }
    internalTokenManager.setBaseUrl(base);
    return base;
  }

  private assertTenant(tenantId?: string) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new Error('tenantId is required for WhatsApp queue jobs');
    }
  }

  private async buildHeaders(base: string) {
    const h: Record<string,string> = { 'Content-Type': 'application/json' };
    const token = await internalTokenManager.getToken(base);
    if (token) h['Authorization'] = `Bearer ${token}`;
    if(this.debug) this.log('buildHeaders', { haveToken: !!token });
    return h;
  }

  async queueFeeReminder(payload: QueueFeeReminderPayload): Promise<QueueResult> {
    const base = this.resolveBase();
    this.assertTenant(payload.tenantId);
    let res = await fetch(`${base}/whatsapp/queue/fee-reminder`, {
      method: 'POST',
      headers: await this.buildHeaders(base),
      body: JSON.stringify(payload),
    });
    if (res.status === 401) { // retry once after forced refresh
      if(this.debug) this.log('401 fee-reminder first attempt');
      await internalTokenManager.forceRefresh(base);
      res = await fetch(`${base}/whatsapp/queue/fee-reminder`, { method: 'POST', headers: await this.buildHeaders(base), body: JSON.stringify(payload) });
    }
    if(this.debug && !res.ok){ try { const t=await res.text(); this.log('fee-reminder error', t.slice(0,200)); } catch {} }
    if (!res.ok) return { error: await this.safeText(res) };
    return await res.json();
  }

  async queueCustomMessage(payload: QueueCustomMessagePayload): Promise<QueueResult> {
    const base = this.resolveBase();
    this.assertTenant(payload.tenantId);
    let res = await fetch(`${base}/whatsapp/queue/custom-message`, {
      method: 'POST',
      headers: await this.buildHeaders(base),
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      if(this.debug) this.log('401 custom-message first attempt');
      await internalTokenManager.forceRefresh(base);
      res = await fetch(`${base}/whatsapp/queue/custom-message`, { method: 'POST', headers: await this.buildHeaders(base), body: JSON.stringify(payload) });
    }
    if(this.debug && !res.ok){ try { const t=await res.text(); this.log('custom-message error', t.slice(0,200)); } catch {} }
    if (!res.ok) return { error: await this.safeText(res) };
    return await res.json();
  }

  async queuePaymentConfirmation(payload: QueuePaymentConfirmationPayload): Promise<QueueResult> {
    const base = this.resolveBase();
    this.assertTenant(payload.tenantId);
    let res = await fetch(`${base}/whatsapp/queue/payment-confirmation`, {
      method: 'POST',
      headers: await this.buildHeaders(base),
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      if(this.debug) this.log('401 payment-confirmation first attempt');
      await internalTokenManager.forceRefresh(base);
      res = await fetch(`${base}/whatsapp/queue/payment-confirmation`, { method: 'POST', headers: await this.buildHeaders(base), body: JSON.stringify(payload) });
    }
    if(this.debug && !res.ok){ try { const t=await res.text(); this.log('payment-confirmation error', t.slice(0,200)); } catch {} }
    if (!res.ok) return { error: await this.safeText(res) };
    return await res.json();
  }

  async previewCustomTemplate(payload: QueueCustomMessagePayload) {
    const base = this.resolveBase();
    this.assertTenant(payload.tenantId);
    let res = await fetch(`${base}/whatsapp/preview/custom-template`, {
      method: 'POST',
      headers: await this.buildHeaders(base),
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      if(this.debug) this.log('401 preview-custom first attempt');
      await internalTokenManager.forceRefresh(base);
      res = await fetch(`${base}/whatsapp/preview/custom-template`, { method: 'POST', headers: await this.buildHeaders(base), body: JSON.stringify(payload) });
    }
    if(this.debug && !res.ok){ try { const t=await res.text(); this.log('preview-custom error', t.slice(0,200)); } catch {} }
    if (!res.ok) return { error: await this.safeText(res) };
    return await res.json();
  }

  async getJobStatus(id: string, tenantId?: string) {
    const base = this.resolveBase();
    const tenantQ = tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : '';
    let res = await fetch(`${base}/whatsapp/queue/status?jobId=${encodeURIComponent(id)}${tenantQ}`, { headers: await this.buildHeaders(base) });
    if (res.status === 401) {
      if(this.debug) this.log('401 single-status first attempt');
      await internalTokenManager.forceRefresh(base);
      res = await fetch(`${base}/whatsapp/queue/status?jobId=${encodeURIComponent(id)}${tenantQ}`, { headers: await this.buildHeaders(base) });
    }
    if(this.debug && !res.ok){ try { const t=await res.text(); this.log('single-status error', t.slice(0,200)); } catch {} }
    if (!res.ok) return { error: await this.safeText(res) };
    return await res.json();
  }

  async getMultipleJobStatus(ids: string[], tenantId?: string) {
    const base = this.resolveBase();
    const tenantQ = tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : '';
    let res = await fetch(`${base}/whatsapp/queue/status?jobIds=${encodeURIComponent(ids.join(','))}${tenantQ}`, { headers: await this.buildHeaders(base) });
    if (res.status === 401) {
      if(this.debug) this.log('401 multi-status first attempt');
      await internalTokenManager.forceRefresh(base);
      res = await fetch(`${base}/whatsapp/queue/status?jobIds=${encodeURIComponent(ids.join(','))}${tenantQ}`, { headers: await this.buildHeaders(base) });
    }
    if(this.debug && !res.ok){ try { const t=await res.text(); this.log('multi-status error', t.slice(0,200)); } catch {} }
    if (!res.ok) return { error: await this.safeText(res) };
    return await res.json();
  }

  private async safeText(res: Response) {
    try {
      const text = await res.text();
      maybeShowMaintenanceAlertFromRaw(res.status, text);
      maybeEmitBillingPastDueFromRaw(res.status, text);
      return text;
    } catch {
      return String(res.status);
    }
  }
}

export const whatsappQueueClient = new WhatsAppQueueClient();
