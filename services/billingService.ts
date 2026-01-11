import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';
import { maybeEmitBillingPastDueFromRaw } from '@/lib/billingPastDue';
import { runtimeEndpoints } from './runtimeEndpoints';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';

export interface BillingCatalogPlanVariant {
  id: string;
  planId: 'free' | 'pro' | 'enterprise';
  displayName: string;
  currency: 'INR';
  priceInr: number;
  interval: 'month';
  provider: 'razorpay';
  playProductId?: string;
  limits?: {
    staffSeats?: number;
    students?: number;
    storageMb?: number;
    reminders?: {
      total?: number;
      whatsapp?: number;
      sms?: number;
      voice?: number;
      email?: number;
    };
  };
  active: boolean;
  sortOrder: number;
}

export interface BillingCatalogResponse {
  plans: BillingCatalogPlanVariant[];
}

export interface BillingCheckoutResponse {
  checkoutUrl: string;
  provider: 'razorpay' | 'stripe';
  sessionId: string;
  providerSessionId?: string;
}

export interface BillingPlayVerifyResponse {
  ok: true;
  provider: 'google_play';
  status: 'verified' | 'received';
  planId?: 'free' | 'pro' | 'enterprise';
  planVariantId?: string;
  renewalDate?: string | null;
  acknowledged?: boolean;
}

export interface BillingManageLinkResponse {
  ok: true;
  provider: 'razorpay';
  url: string;
  subscriptionId?: string;
}

export interface BillingCurrentResponse {
  tenantId: string;
  planId: 'free' | 'pro' | 'enterprise';
  planVariantId?: string;
  couponCode?: string;
  subscriptionProvider?: 'razorpay' | 'google_play' | 'unknown';
  status: 'trial' | 'active' | 'delinquent' | 'canceled';
  renewalDate?: string;
  checkoutRequired?: boolean;
  checkoutRequiredSince?: string;
  checkoutRequiredProvider?: string;
  cancelAtCycleEnd?: boolean;
  scheduledDowngradePlanId?: 'free' | 'pro' | 'enterprise';
  scheduledDowngradeAt?: string;
}

export interface BillingSwitchToFreeResponse {
  ok: true;
  scheduled: boolean;
  planId?: 'free';
  scheduledDowngradePlanId?: 'free';
  scheduledDowngradeAt?: string;
}

export interface BillingHistoryInvoice {
  id: string;
  invoiceNumber?: string;
  amountInr: number;
  status: 'paid' | 'open' | 'failed' | 'void' | 'uncollectible';
  issuedAt?: string;
  dueAt?: string;
  downloadUrl?: string;
  provider?: string;
  planId?: string;
  planVariantId?: string;
  couponCode?: string;
  isSynthetic?: boolean;
  sourceEvent?: string;
  providerPaymentId?: string;
  providerSubscriptionId?: string;
  subscriptionId?: string;
  rawEvent?: string;
  payerEmail?: string;
  method?: string;
  upiVpaMasked?: string;
  cardLast4?: string;
  cardNetwork?: string;
  authorizedAt?: string;
  capturedAt?: string;
  failedAt?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  createdByEmail?: string;
  createdByRole?: string;
  errorCode?: string;
  errorDescription?: string;
}

export interface BillingHistoryChange {
  id: string;
  action: string;
  actorEmail?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface BillingHistoryResponse {
  tenantId: string;
  invoices: BillingHistoryInvoice[];
  changes: BillingHistoryChange[];
  totals?: {
    invoices?: number;
    changes?: number;
  };
  matchingTotals?: {
    invoices?: number;
    changes?: number;
  };
  pageInfo?: {
    invoices: { nextCursor?: { at: string; id: string } };
    changes: { nextCursor?: { at: string; id: string } };
  };
}

export interface BillingInvoiceDownloadUrlResponse {
  ok: true;
  downloadUrl: string;
}

type LatestBillingChangeCacheEntry = {
  atMs: number;
  value: BillingHistoryChange | null;
};

const LATEST_BILLING_CHANGE_TTL_MS = 30_000;
const latestBillingChangeCache = new Map<string, LatestBillingChangeCacheEntry>();

class BillingService {
  constructor() {
    const base = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (base) internalTokenManager.setBaseUrl(base);
  }

  private ensureBaseUrl(): string {
    const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (!baseUrl) {
      throw new Error('Billing backend URL not configured. Set Firestore appSettings/runtimeEndpoints.apiBaseUrl.');
    }
    return baseUrl;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (!baseUrl) return headers;
    const token = await internalTokenManager.getToken(baseUrl);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options?: {
      body?: Record<string, any> | null;
    }
  ): Promise<T> {
    const baseUrl = this.ensureBaseUrl();
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = `${baseUrl}${normalizedPath}`;
    let headers = await this.buildHeaders();
    const payload = options?.body ? JSON.stringify(options.body) : undefined;

    let response = await fetch(url, { method, headers, body: payload });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await this.buildHeaders();
      response = await fetch(url, { method, headers, body: payload });
    }

    if (!response.ok) {
      const text = await response.text();
      maybeShowMaintenanceAlertFromRaw(response.status, text);
      maybeEmitBillingPastDueFromRaw(response.status, text);
      throw new Error(text || `billing_request_failed_${response.status}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      logger.warn('[billingService] Failed to parse response JSON', { url, error });
      throw error;
    }
  }

  async getCatalog(): Promise<BillingCatalogResponse> {
    return await this.request<BillingCatalogResponse>('GET', '/billing/catalog');
  }

  async getManageLink(tenantId: string): Promise<BillingManageLinkResponse> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) throw new Error('tenant_required');
    return await this.request<BillingManageLinkResponse>('POST', '/billing/manage-link', {
      body: { tenantId: normalizedTenantId },
    });
  }

  async getCurrentBilling(tenantId: string): Promise<BillingCurrentResponse> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) throw new Error('tenant_required');
    const baseUrl = this.ensureBaseUrl();
    const url = new URL(`${baseUrl}/billing/current`);
    url.searchParams.set('tenantId', normalizedTenantId);
    const base = baseUrl;
    let headers = await this.buildHeaders();
    let response = await fetch(url.toString(), { method: 'GET', headers });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(base);
      headers = await this.buildHeaders();
      response = await fetch(url.toString(), { method: 'GET', headers });
    }
    if (!response.ok) {
      const text = await response.text();
      maybeShowMaintenanceAlertFromRaw(response.status, text);
      maybeEmitBillingPastDueFromRaw(response.status, text);
      throw new Error(text || `billing_current_failed_${response.status}`);
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as BillingCurrentResponse) : (undefined as unknown as BillingCurrentResponse);
  }

  async startRazorpayCheckout(options: {
    tenantId: string;
    planVariantId: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<BillingCheckoutResponse> {
    const tenantId = options.tenantId.trim();
    const planVariantId = options.planVariantId.trim();
    const successUrl = typeof options.successUrl === 'string' ? options.successUrl.trim() : '';
    const cancelUrl = typeof options.cancelUrl === 'string' ? options.cancelUrl.trim() : '';
    if (!tenantId) throw new Error('tenant_required');
    if (!planVariantId) throw new Error('plan_variant_required');
    return await this.request<BillingCheckoutResponse>('POST', '/billing/checkout', {
      body: {
        tenantId,
        provider: 'razorpay',
        planId: 'pro',
        planVariantId,
        ...(successUrl ? { successUrl } : {}),
        ...(cancelUrl ? { cancelUrl } : {}),
      },
    });
  }

  async verifyGooglePlayPurchase(options: {
    tenantId: string;
    planVariantId: string;
    productId: string;
    purchaseToken: string;
    orderId?: string;
  }): Promise<BillingPlayVerifyResponse> {
    const tenantId = options.tenantId.trim();
    const planVariantId = options.planVariantId.trim();
    const productId = options.productId.trim();
    const purchaseToken = options.purchaseToken.trim();
    const orderId = typeof options.orderId === 'string' ? options.orderId.trim() : '';
    if (!tenantId) throw new Error('tenant_required');
    if (!planVariantId) throw new Error('plan_variant_required');
    if (!productId) throw new Error('product_id_required');
    if (!purchaseToken) throw new Error('purchase_token_required');

    return await this.request<BillingPlayVerifyResponse>('POST', '/billing/play/verify', {
      body: {
        tenantId,
        planVariantId,
        productId,
        purchaseToken,
        ...(orderId ? { orderId } : {}),
      },
    });
  }

  async switchToFree(options: { tenantId: string }): Promise<BillingSwitchToFreeResponse> {
    const tenantId = options.tenantId.trim();
    if (!tenantId) throw new Error('tenant_required');
    const result = await this.request<BillingSwitchToFreeResponse>('POST', '/billing/switch-to-free', {
      body: { tenantId },
    });

    latestBillingChangeCache.delete(tenantId);
    return result;
  }

  async switchToFreeImmediate(options: { tenantId: string }): Promise<BillingSwitchToFreeResponse> {
    const tenantId = options.tenantId.trim();
    if (!tenantId) throw new Error('tenant_required');
    const result = await this.request<BillingSwitchToFreeResponse>('POST', '/billing/switch-to-free/immediate', {
      body: { tenantId },
    });

    latestBillingChangeCache.delete(tenantId);
    return result;
  }

  invalidateLatestBillingChangeCache(options?: { tenantId?: string }): void {
    const tenantId = (options?.tenantId ?? '').trim();
    if (tenantId) {
      latestBillingChangeCache.delete(tenantId);
      return;
    }

    latestBillingChangeCache.clear();
  }

  async getBillingHistory(
    tenantId: string,
    options?: {
      pageSize?: number;
      limitInvoices?: number;
      limitChanges?: number;
      cursorInvoice?: { at: string; id: string };
      cursorChange?: { at: string; id: string };
      includeTotals?: boolean;
      invoiceStatus?: BillingHistoryInvoice['status'];
    }
  ): Promise<BillingHistoryResponse> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) throw new Error('tenant_required');
    const baseUrl = this.ensureBaseUrl();
    const url = new URL(`${baseUrl}/billing/history`);
    url.searchParams.set('tenantId', normalizedTenantId);
    if (typeof options?.pageSize === 'number' && Number.isFinite(options.pageSize)) {
      url.searchParams.set('pageSize', String(Math.trunc(options.pageSize)));
    }
    if (typeof options?.limitInvoices === 'number' && Number.isFinite(options.limitInvoices)) {
      url.searchParams.set('limitInvoices', String(Math.trunc(options.limitInvoices)));
    }
    if (typeof options?.limitChanges === 'number' && Number.isFinite(options.limitChanges)) {
      url.searchParams.set('limitChanges', String(Math.trunc(options.limitChanges)));
    }
    if (options?.cursorInvoice?.at && options?.cursorInvoice?.id) {
      url.searchParams.set('cursorInvoiceAt', options.cursorInvoice.at);
      url.searchParams.set('cursorInvoiceId', options.cursorInvoice.id);
    }
    if (options?.cursorChange?.at && options?.cursorChange?.id) {
      url.searchParams.set('cursorChangeAt', options.cursorChange.at);
      url.searchParams.set('cursorChangeId', options.cursorChange.id);
    }
    if (typeof options?.includeTotals === 'boolean') {
      url.searchParams.set('includeTotals', options.includeTotals ? '1' : '0');
    }
    if (typeof options?.invoiceStatus === 'string' && options.invoiceStatus) {
      url.searchParams.set('invoiceStatus', options.invoiceStatus);
    }

    const base = baseUrl;
    let headers = await this.buildHeaders();
    let response = await fetch(url.toString(), { method: 'GET', headers });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(base);
      headers = await this.buildHeaders();
      response = await fetch(url.toString(), { method: 'GET', headers });
    }
    if (!response.ok) {
      const text = await response.text();
      maybeEmitBillingPastDueFromRaw(response.status, text);
      throw new Error(text || `billing_history_failed_${response.status}`);
    }
    const text = await response.text();
    return text ? (JSON.parse(text) as BillingHistoryResponse) : (undefined as unknown as BillingHistoryResponse);
  }

  async getLatestBillingChange(tenantId: string): Promise<BillingHistoryChange | null> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) throw new Error('tenant_required');

    const cached = latestBillingChangeCache.get(normalizedTenantId);
    const now = Date.now();
    if (cached && now - cached.atMs <= LATEST_BILLING_CHANGE_TTL_MS) {
      return cached.value;
    }

    try {
      const data = await this.getBillingHistory(normalizedTenantId, {
        pageSize: 1,
        limitInvoices: 0,
        limitChanges: 1,
        includeTotals: false,
      });
      const entry = Array.isArray(data?.changes) && data.changes.length ? data.changes[0] : null;
      latestBillingChangeCache.set(normalizedTenantId, { atMs: now, value: entry });
      return entry;
    } catch {
      return null;
    }
  }

  async getInvoiceDownloadUrl(tenantId: string, invoiceId: string): Promise<BillingInvoiceDownloadUrlResponse> {
    const normalizedTenantId = tenantId.trim();
    const normalizedInvoiceId = invoiceId.trim();
    if (!normalizedTenantId) throw new Error('tenant_required');
    if (!normalizedInvoiceId) throw new Error('invoice_required');

    const baseUrl = this.ensureBaseUrl();
    const url = new URL(`${baseUrl}/billing/invoice/download-url`);
    url.searchParams.set('tenantId', normalizedTenantId);
    url.searchParams.set('invoiceId', normalizedInvoiceId);

    const base = baseUrl;
    let headers = await this.buildHeaders();
    let response = await fetch(url.toString(), { method: 'GET', headers });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(base);
      headers = await this.buildHeaders();
      response = await fetch(url.toString(), { method: 'GET', headers });
    }
    if (!response.ok) {
      const text = await response.text();
      maybeEmitBillingPastDueFromRaw(response.status, text);
      throw new Error(text || `billing_invoice_download_failed_${response.status}`);
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as BillingInvoiceDownloadUrlResponse) : (undefined as unknown as BillingInvoiceDownloadUrlResponse);
  }

  async downloadInvoicePdf(tenantId: string, invoiceId: string): Promise<Blob> {
    const normalizedTenantId = tenantId.trim();
    const normalizedInvoiceId = invoiceId.trim();
    if (!normalizedTenantId) throw new Error('tenant_required');
    if (!normalizedInvoiceId) throw new Error('invoice_required');

    const baseUrl = this.ensureBaseUrl();
    const url = new URL(`${baseUrl}/billing/invoice/download`);
    url.searchParams.set('tenantId', normalizedTenantId);
    url.searchParams.set('invoiceId', normalizedInvoiceId);

    const base = baseUrl;
    let headers = await this.buildHeaders();
    let response = await fetch(url.toString(), { method: 'GET', headers });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(base);
      headers = await this.buildHeaders();
      response = await fetch(url.toString(), { method: 'GET', headers });
    }
    if (!response.ok) {
      const text = await response.text();
      maybeEmitBillingPastDueFromRaw(response.status, text);
      throw new Error(text || `billing_invoice_download_failed_${response.status}`);
    }

    return await response.blob();
  }
}

export const billingService = new BillingService();
