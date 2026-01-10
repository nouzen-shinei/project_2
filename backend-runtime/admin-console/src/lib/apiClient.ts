import { AuthMode, resolveAuthHeader, resolveBaseUrl, useConfigStore } from '../store/configStore';
import {
  getPlanLimits,
  getUsagePercentage,
  getUsageStatus,
  type PlanId,
  type PlanLimits,
  type UsageStatus,
} from '@shared/planLimits';

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: AuthMode;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  responseType?: 'json' | 'text' | 'blob';
  signal?: AbortSignal;
  includeSecretHeader?: boolean;
}

export async function apiRequest<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const base = resolveBaseUrl();
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  const normalizedPath = path.startsWith('http') ? path : `${baseWithSlash}${path.replace(/^\//, '')}`;
  const url = new URL(normalizedPath);

  if (options.query) {
    Object.entries(options.query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      url.searchParams.set(key, String(value));
    });
  }

  const headers = new Headers(options.headers || {});
  let body: BodyInit | undefined;

  if (options.body instanceof FormData) {
    body = options.body;
  } else if (typeof options.body === 'string' || options.body instanceof Blob) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const authHeader = resolveAuthHeader(options.auth ?? 'auto');
  if (authHeader) {
    headers.set('Authorization', authHeader);
  }

  if (options.includeSecretHeader) {
    const secret = useConfigStore.getState().masterKey;
    if (secret) {
      headers.set('X-Internal-Secret', secret);
    }
  }

  const response = await fetch(url, {
    method: options.method || (body ? 'POST' : 'GET'),
    body,
    headers,
    signal: options.signal,
  });

  const responseType = options.responseType ?? 'json';
  let parsed: unknown = null;

  if (responseType === 'blob') {
    parsed = await response.blob();
  } else if (responseType === 'text') {
    parsed = await response.text();
  } else {
    const text = await response.text();
    parsed = text ? safeJsonParse(text) : null;
  }

  if (!response.ok) {
    const parsedForError =
      responseType === 'blob'
        ? await (parsed instanceof Blob
            ? parsed
                .text()
                .then((t) => (t ? safeJsonParse(t) : t))
                .catch(() => null)
            : Promise.resolve(null))
        : response.status === 503 && typeof parsed === 'string'
          ? safeJsonParse(parsed)
          : parsed;
    let message = `Request failed with status ${response.status}`;

    if (response.status === 503 && parsedForError && typeof parsedForError === 'object') {
      const candidate = parsedForError as { error?: unknown; message?: unknown };
      if (candidate.error === 'maintenance') {
        const maintenanceMessage = typeof candidate.message === 'string' ? candidate.message.trim() : '';
        message = maintenanceMessage || 'Server is in maintenance mode. Please try again shortly.';
      }
    }

    throw new ApiError(message, response.status, parsedForError);
  }

  return parsed as T;
}

export function fetchBillingInvoicePdf(query: { tenantId: string; invoiceId: string; force?: boolean }) {
  return apiRequest<Blob>('/billing/invoice/download', { query, responseType: 'blob' });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface TokenResponse {
  token: string;
  expiresIn: number;
  expiresAt: number;
}

export function issueInternalToken() {
  return apiRequest<TokenResponse>('/internal/auth/issue', {
    method: 'POST',
    includeSecretHeader: true,
    auth: 'master',
  });
}

export function fetchHealth() {
  return apiRequest<{ status: string; uptime: number; ts: number }>('/health', { auth: 'none' });
}

export type RuntimeEndpointsDoc = {
  apiBaseUrl?: string;
  emailApiBaseUrl?: string;
  notificationsApiBaseUrl?: string;
  wabaApiBaseUrl?: string;
  chatApiBaseUrl?: string;
  webAppBaseUrl?: string;
  createdAt?: string;
  updatedAt?: string;
};

export function fetchRuntimeEndpoints() {
  return apiRequest<{ ok: true; data: RuntimeEndpointsDoc | null }>('/admin/settings/runtime-endpoints', {
    auth: 'auto',
  });
}

export function updateRuntimeEndpoints(payload: Partial<RuntimeEndpointsDoc>) {
  return apiRequest<{ ok: true; data: RuntimeEndpointsDoc | null }>('/admin/settings/runtime-endpoints', {
    method: 'POST',
    auth: 'auto',
    body: payload,
  });
}

export type MaintenanceModeDoc = {
  enabled?: boolean;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
};

export function fetchMaintenanceMode() {
  return apiRequest<{ ok: true; data: MaintenanceModeDoc | null }>('/admin/settings/maintenance', {
    auth: 'auto',
  });
}

export function updateMaintenanceMode(payload: Partial<MaintenanceModeDoc>) {
  return apiRequest<{ ok: true; data: MaintenanceModeDoc | null }>('/admin/settings/maintenance', {
    method: 'POST',
    auth: 'auto',
    body: payload,
  });
}

export type ReminderChannelKey = 'email' | 'sms' | 'whatsapp' | 'voice';

export type TenantReminderSettingsDoc = {
  enabledChannels?: Partial<Record<ReminderChannelKey, boolean>>;
  channelMessages?: Partial<Record<ReminderChannelKey, string>>;
  hideDisabledReminderTypes?: boolean;
  createdAt?: string;
  updatedAt?: string;
} & Record<string, unknown>;

export function fetchTenantReminderSettings(query: { tenantId: string }) {
  return apiRequest<{ ok: true; data: TenantReminderSettingsDoc | null }>('/admin/tenants/reminder-settings', {
    auth: 'auto',
    query,
  });
}

export function updateTenantReminderSettings(payload: {
  tenantId: string;
  enabledChannels: Partial<Record<ReminderChannelKey, boolean>>;
  channelMessages?: Partial<Record<ReminderChannelKey, string>>;
  // null clears the tenant override (inherit global)
  hideDisabledReminderTypes?: boolean | null;
}) {
  return apiRequest<{ ok: true; data: TenantReminderSettingsDoc | null }>('/admin/tenants/reminder-settings', {
    method: 'POST',
    auth: 'auto',
    body: payload,
  });
}

export type ReminderChannelsPolicyDoc = {
  enabledChannels?: Partial<Record<ReminderChannelKey, boolean>>;
  channelMessages?: Partial<Record<ReminderChannelKey, string>>;
  hideDisabledReminderTypes?: boolean;
  createdAt?: string;
  updatedAt?: string;
} & Record<string, unknown>;

export function fetchReminderChannelsPolicy() {
  return apiRequest<{ ok: true; data: ReminderChannelsPolicyDoc | null }>('/admin/settings/reminder-channels', {
    auth: 'auto',
  });
}

export function updateReminderChannelsPolicy(payload: {
  enabledChannels?: Partial<Record<ReminderChannelKey, boolean>>;
  channelMessages?: Partial<Record<ReminderChannelKey, string>>;
  hideDisabledReminderTypes?: boolean;
}) {
  return apiRequest<{ ok: true; data: ReminderChannelsPolicyDoc | null }>('/admin/settings/reminder-channels', {
    method: 'POST',
    auth: 'auto',
    body: payload,
  });
}

export function fetchMetrics() {
  return apiRequest<string>('/metrics', { responseType: 'text' });
}

export type BillingMetricsSummary = {
  ok: true;
  provider: string;
  gauges: {
    billing_webhook_signature_failures_15m: number;
    billing_webhook_invalid_json_15m: number;
    billing_webhook_handler_failures_15m: number;
    billing_invoice_write_failures_15m: number;
    billing_state_write_failures_15m: number;
    billing_unknown_events_24h: number;
  };
  backfill: {
    schedulerEnabled: boolean;
    schedulerStarted: boolean;
    lastRunAt: string | null;
    lastRunAgeSeconds: number | null;
  };
  thresholds: {
    signatureFailures15m: number | null;
    invalidJson15m: number | null;
    handlerFailures15m: number | null;
    invoiceWriteFailures15m: number | null;
    stateWriteFailures15m: number | null;
    unknownEvents24h: number | null;
    backfillStaleHours: number | null;
  };
  alerts: {
    signatureFailures15mExceeded: boolean;
    invalidJson15mExceeded: boolean;
    handlerFailures15mExceeded: boolean;
    invoiceWriteFailures15mExceeded: boolean;
    stateWriteFailures15mExceeded: boolean;
    unknownEvents24hExceeded: boolean;
    backfillStaleExceeded: boolean;
  };
  activeAlerts: string[];
  generatedAtIso: string;
};

export function fetchBillingMetricsSummary() {
  return apiRequest<BillingMetricsSummary>('/billing/admin/metrics-summary', {
    auth: 'auto',
  });
}

export interface FeeReminderPayload {
  tenantId?: string;
  to: string;
  studentName: string;
  amount: number;
  dueDate: string;
  language?: string;
  bilingual?: boolean;
}

export interface CustomMessagePayload {
  tenantId?: string;
  to: string;
  message: string;
  language?: string;
}

export interface PaymentConfirmationPayload {
  tenantId?: string;
  to: string;
  studentName: string;
  amount: number;
  paymentDate: string;
}

export interface QueueResponse {
  jobId: string;
}

export function enqueueFeeReminder(payload: FeeReminderPayload) {
  return apiRequest<QueueResponse>('/whatsapp/queue/fee-reminder', { method: 'POST', body: payload });
}

export function enqueueCustomMessage(payload: CustomMessagePayload) {
  return apiRequest<QueueResponse>('/whatsapp/queue/custom-message', { method: 'POST', body: payload });
}

export function enqueuePaymentConfirmation(payload: PaymentConfirmationPayload) {
  return apiRequest<QueueResponse>('/whatsapp/queue/payment-confirmation', { method: 'POST', body: payload });
}

export interface JobStatusEntry {
  id: string;
  state?: string;
  status?: string;
  attemptsMade?: number;
  attempts?: number;
  failedReason?: string;
  updatedAt?: number;
  finishedOn?: number | null;
  processedOn?: number | null;
  tenantId?: string;
}

export function fetchJobStatus(params: { jobId?: string; jobIds?: string; messageId?: string; tenantId?: string }) {
  return apiRequest<{ jobs: JobStatusEntry[] }>('/whatsapp/queue/status', { query: params });
}

export interface DailyQuoteTriggerPayload {
  tenantId: string;
  timeOfDay?: 'morning' | 'evening' | 'immediate' | 'auto';
  targetEmails?: string[];
  dryRun?: boolean;
  reason?: string;
  now?: string;
}

export function triggerDailyQuotes(payload: DailyQuoteTriggerPayload) {
  return apiRequest('/notifications/daily-quotes/trigger', { method: 'POST', body: payload });
}

export interface DailyQuoteStatus {
  lastRunAt?: number | string | null;
  nextRunAt?: number | string | null;
  timeOfDay?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export function getDailyQuoteStatus() {
  return apiRequest<DailyQuoteStatus>('/notifications/daily-quotes/status', {
    auth: 'master',
  });
}

export interface BillingCatalogPlanVariant {
  id: string;
  planId: PlanId;
  displayName: string;
  currency: 'INR';
  priceInr: number;
  interval: 'month';
  provider: 'razorpay';
  razorpayPlanId?: string;
  playProductId?: string;
  applyChangesMode?: 'immediate' | 'next_billing';
  decreasePolicy?: 'soft' | 'hard';
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
  updatedAt?: string;
  createdAt?: string;
}

export interface BillingCatalogCoupon {
  id: string;
  code: string;
  mapsToPlanVariantId: string;
  active: boolean;
  startsAt?: string;
  endsAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

export function fetchBillingCatalogAdmin() {
  return apiRequest<{ plans: BillingCatalogPlanVariant[]; coupons: BillingCatalogCoupon[] }>('/billing/catalog/admin', {
    auth: 'auto',
  });
}

export function upsertBillingPlanVariant(payload: {
  id: string;
  planId: PlanId;
  displayName: string;
  priceInr: number;
  razorpayPlanId?: string;
  playProductId?: string;
  applyChangesMode?: 'immediate' | 'next_billing';
  decreasePolicy?: 'soft' | 'hard';
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
}) {
  return apiRequest('/billing/catalog/admin/plans/upsert', {
    method: 'POST',
    body: {
      ...payload,
      interval: 'month',
      provider: 'razorpay',
    },
    auth: 'auto',
  });
}

export function upsertBillingCoupon(payload: {
  id: string;
  code: string;
  mapsToPlanVariantId: string;
  active: boolean;
  startsAt?: string;
  endsAt?: string;
}) {
  return apiRequest('/billing/catalog/admin/coupons/upsert', {
    method: 'POST',
    body: payload,
    auth: 'auto',
  });
}

export interface BillingOpsEventRecord {
  id: string;
  provider?: string;
  type?: string;
  severity?: 'info' | 'warn' | 'error' | string;
  message?: string;
  createdAtIso?: string;
  tenantId?: string | null;
  event?: string | null;
  subscriptionId?: string | null;
  paymentId?: string | null;
  httpStatus?: number | null;
  requestPath?: string | null;
  payloadPreview?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function fetchBillingOpsEvents(params: {
  limit?: number;
  before?: string;
  tenantId?: string;
}) {
  return apiRequest<{ ok: true; items: BillingOpsEventRecord[]; nextCursor: string | null }>(
    '/billing/admin/ops-events',
    {
      auth: 'auto',
      query: params,
    }
  );
}

export interface BillingBackfillRunRecord {
  id: string;
  runId?: string;
  status?: string;
  jobLabel?: string;
  runnerId?: string;
  dryRun?: boolean;
  startedAtIso?: string;
  finishedAtIso?: string;
  stats?: {
    tenantsTargeted?: number;
    tenantsProcessed?: number;
    tenantsSkipped?: number;
    subscriptionsFetched?: number;
    paymentsFetched?: number;
    invoicesUpserted?: number;
    invoicesPatched?: number;
    billingDocsUpdated?: number;
    tenantDocsUpdated?: number;
    errors?: number;
    reconciliation?: {
      scope?: string;
      maxPaymentsPerSubscription?: number;
      providerCapturedPayments?: number;
      firestorePaidInvoices?: number;
      missingPaidInvoices?: number;
      extraPaidInvoices?: number;
      missingSamples?: Array<{
        tenantId: string;
        subscriptionId: string;
        paymentId: string;
        amountInr: number | null;
        issuedAt: string | null;
      }>;
      extraSamples?: Array<{
        tenantId: string;
        subscriptionId: string;
        paymentId: string;
        status: string | null;
        issuedAt: string | null;
      }>;
    };
    reconciliationTenantsPreview?: Array<{
      tenantId: string;
      subscriptionId: string;
      providerCapturedPayments: number;
      firestorePaidInvoices: number;
      missingPaidInvoices: number;
      extraPaidInvoices: number;
      missingSamplePaymentIds: string[];
      extraSamplePaymentIds: string[];
    }>;
  };
}

export function fetchBillingBackfillRuns(params: { limit?: number; before?: string }) {
  return apiRequest<{ ok: true; items: BillingBackfillRunRecord[]; nextCursor: string | null }>(
    '/billing/admin/backfill/runs',
    {
      auth: 'auto',
      query: params,
    }
  );
}

export interface BillingBackfillSchedulerStatus {
  enabled: boolean;
  schedulerStarted: boolean;
  intervalMs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  isRunning: boolean;
}

export function fetchBillingBackfillSchedulerStatus() {
  return apiRequest<{ ok: true; scheduler: BillingBackfillSchedulerStatus }>('/billing/admin/backfill/status', {
    auth: 'auto',
  });
}

export function triggerBillingBackfillForTenant(payload: {
  tenantId: string;
  maxPaymentsPerSubscription?: number;
  dryRun?: boolean;
  confirm?: boolean;
  verbose?: boolean;
  jobLabel?: string;
}) {
  return apiRequest(
    '/billing/admin/backfill',
    {
      method: 'POST',
      body: payload,
      auth: 'auto',
    }
  );
}

export interface BirthdayTriggerPayload {
  tenantId: string;
  email?: string;
  emails?: string[];
  deviceId?: string;
  deviceIds?: string[];
  dryRun?: boolean;
  forceSend?: boolean;
  skipWhatsApp?: boolean;
  suppressStateUpdates?: boolean;
  reason?: string;
  now?: string;
}

export function triggerBirthday(payload: BirthdayTriggerPayload) {
  return apiRequest('/notifications/birthday/trigger', { method: 'POST', body: payload });
}

export function testBirthday(payload: BirthdayTriggerPayload) {
  return apiRequest('/notifications/birthday/test', { method: 'POST', body: payload });
}

export interface TenantAdminSummary {
  id: string;
  name?: string;
  slug?: string;
  code?: string;
  status?: string;
  billingTier?: string;
  ownerEmail?: string;
  ownerUserId?: string;
  contactEmail?: string;
  contactPhone?: string;
  logoUrl?: string | null;
  heroImageUrl?: string | null;
  branding?: {
    logoUrl?: string;
    heroImageUrl?: string;
    accentImageUrl?: string;
    tagline?: string;
    missionStatement?: string;
  };
  quotas?: {
    maxStudents?: number;
    maxStaff?: number;
    maxMonthlyReminders?: number;
    maxMonthlyWhatsappReminders?: number;
    maxMonthlySmsReminders?: number;
    maxMonthlyEmailReminders?: number;
    maxMonthlyVoiceReminders?: number;
    maxStorageMb?: number;
  };
  membershipCounts?: {
    total?: number;
    active?: number;
    pending?: number;
    owners?: number;
    admins?: number;
    staff?: number;
  };
  flags?: {
    allowJoinRequests?: boolean;
    notifyOnJoinRequest?: boolean;
    notifyViaEmail?: boolean;
  };
  createdAt?: string;
  updatedAt?: string;
  seatUsage?: {
    adminSeatsUsed: number | null;
    adminSeatLimit: number | null;
    remaining: number | null;
  };
}

export interface TenantSearchResponse {
  results: TenantAdminSummary[];
  total: number;
  diagnostics: {
    query?: string;
    matchedBy: string[];
    fallbackApplied: boolean;
  };
}

export interface TenantUserDeviceRecord {
  deviceId: string;
  isOnline?: boolean;
  lastSeen?: string;
  lastTenantPingAt?: string;
  lastActivityType?: string;
  lastPingType?: string;
  activeTenantId?: string;
  lastTenantId?: string;
  tenantIds?: string[];
  notificationsEnabled?: boolean;
  isDeleted?: boolean;
}

export interface TenantUserDevicesResponse {
  ok: boolean;
  tenantId: string;
  email: string;
  devices: TenantUserDeviceRecord[];
}

export function fetchTenantUserDevices(payload: { tenantId: string; email: string }) {
  return apiRequest<TenantUserDevicesResponse>('/admin/tenants/user-devices', {
    method: 'POST',
    body: payload,
    auth: 'master',
  });
}

export type TenantMembershipRole = 'owner' | 'admin' | 'staff' | 'member';

export interface TenantMembershipAdminRecord {
  id: string;
  tenantId: string;
  userId?: string;
  email?: string;
  displayName?: string;
  role?: TenantMembershipRole;
  status?: string;
  joinedVia?: string;
  joinCodeId?: string;
  invitedByUserId?: string;
  invitedByEmail?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
}

export interface MembershipSummaryBuckets {
  count: number;
  byRole: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface TenantMembershipInspectorResponse {
  tenant: TenantAdminSummary;
  members: TenantMembershipAdminRecord[];
  total: number;
  hasMore: boolean;
  stats: {
    filtered: MembershipSummaryBuckets;
    scanned: MembershipSummaryBuckets;
    snapshot?: TenantAdminSummary['membershipCounts'];
  };
  filters: {
    limit: number;
    role: TenantMembershipRole | 'all';
    status: string;
    search?: string;
  };
}

export interface TenantMembershipInspectorRequest {
  tenantId: string;
  limit?: number;
  role?: TenantMembershipRole | 'all';
  status?: string;
  search?: string;
}

export function fetchTenantMemberships(payload: TenantMembershipInspectorRequest) {
  return apiRequest<TenantMembershipInspectorResponse>('/admin/tenants/memberships', {
    method: 'POST',
    body: payload,
  });
}

export interface TenantMembershipRoleUpdateRequest {
  tenantId: string;
  userId: string;
  role: TenantMembershipRole;
  metadata?: {
    reason?: string;
    initiatedFrom?: 'web' | 'mobile' | 'system';
    actorName?: string;
  };
}

export interface TenantMembershipRoleUpdateResponse {
  ok: boolean;
  changed: boolean;
  membership: {
    id: string;
    tenantId: string;
    userId: string;
    role: TenantMembershipRole;
    status?: string;
    updatedAt?: string;
  };
}

export function updateTenantMembershipRole(payload: TenantMembershipRoleUpdateRequest) {
  return apiRequest<TenantMembershipRoleUpdateResponse>('/admin/tenants/memberships/role', {
    method: 'POST',
    body: payload,
    auth: 'master',
  });
}

export interface TenantInviteAdminRecord {
  id: string;
  tenantId: string;
  email?: string;
  role?: string;
  status?: string;
  issuedBy?: string;
  issuedAt?: string;
  expiresAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  lastSentAt?: string;
  lastSentBy?: string;
  invitationMessage?: string;
}

export interface TenantInviteInspectorResponse {
  tenant: TenantAdminSummary;
  invites: TenantInviteAdminRecord[];
  total: number;
  hasMore: boolean;
  stats: {
    byStatus: Record<string, number>;
  };
  filters: {
    limit: number;
    status: string;
    search?: string;
  };
}

export interface TenantInviteInspectorRequest {
  tenantId: string;
  limit?: number;
  status?: string;
  search?: string;
}

export function fetchTenantInvites(payload: TenantInviteInspectorRequest) {
  return apiRequest<TenantInviteInspectorResponse>('/admin/tenants/invites', {
    method: 'POST',
    body: payload,
  });
}

export function resendTenantInvite(inviteId: string, tenantId: string) {
  return apiRequest('/notifications/tenant-invite', {
    method: 'POST',
    body: { tenantId, inviteId },
  });
}

export interface TenantAuditAdminRecord {
  id: string;
  tenantId: string;
  action: string;
  actorId?: string;
  actorEmail?: string;
  targetId?: string;
  targetType?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface TenantAuditInspectorResponse {
  tenant: TenantAdminSummary;
  entries: TenantAuditAdminRecord[];
  total: number;
  hasMore: boolean;
  stats: {
    byAction: Record<string, number>;
  };
  filters: {
    limit: number;
    action: string;
    search?: string;
  };
}

export interface TenantAuditInspectorRequest {
  tenantId: string;
  limit?: number;
  action?: string;
  search?: string;
}

export function fetchTenantAuditLogs(payload: TenantAuditInspectorRequest) {
  return apiRequest<TenantAuditInspectorResponse>('/admin/tenants/audit', {
    method: 'POST',
    body: payload,
  });
}

export interface NotificationHistoryEntry {
  id: string;
  tenantId?: string | null;
  tenantName?: string | null;
  adminEmail?: string | null;
  adminName?: string | null;
  title: string;
  body?: string;
  type: string;
  priority: string;
  deliveryMethod?: string;
  totalTargets: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  failureReasonSummary?: Record<string, number>;
  onlineOnly?: boolean;
  sentAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotificationHistoryResponse {
  entries: NotificationHistoryEntry[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface NotificationHistoryRequest {
  tenantId?: string;
  adminEmail?: string;
  limit?: number;
  cursor?: string;
}

export interface NotificationStatsResponse {
  windowDays: number;
  startDate: string;
  totalNotifications: number;
  totalRecipients: number;
  successfulRecipients: number;
  failedRecipients: number;
  averageSuccessRate: number;
  notificationsByType: Record<string, number>;
  notificationsByPriority: Record<string, number>;
  failureReasons: Record<string, number>;
  tenantBreakdown: Array<{ tenantId: string; tenantName?: string | null; count: number; failedDeliveries: number }>;
  lastSentAt?: string;
}

export interface NotificationStatsRequest {
  tenantId?: string;
  adminEmail?: string;
  days?: number;
}

export function fetchNotificationHistory(payload: NotificationHistoryRequest = {}) {
  return apiRequest<NotificationHistoryResponse>('/admin/notifications/history', {
    method: 'POST',
    body: payload,
    auth: 'master',
  });
}

export function fetchNotificationStats(payload: NotificationStatsRequest = {}) {
  return apiRequest<NotificationStatsResponse>('/admin/notifications/stats', {
    method: 'POST',
    body: payload,
    auth: 'master',
  });
}

export interface TenantQuotaOverridePayload {
  tenantId: string;
  quotas: {
    maxStudents?: number | null;
    maxStaff?: number | null;
    maxMonthlyReminders?: number | null;
    maxMonthlyWhatsappReminders?: number | null;
    maxMonthlySmsReminders?: number | null;
    maxMonthlyEmailReminders?: number | null;
    maxMonthlyVoiceReminders?: number | null;
    maxStorageMb?: number | null;
  };
  note?: string;
}

export interface TenantQuotaOverrideResponse {
  ok: boolean;
  tenant: TenantAdminSummary;
}

export function updateTenantQuotas(payload: TenantQuotaOverridePayload) {
  return apiRequest<TenantQuotaOverrideResponse>('/admin/tenants/quotas', {
    method: 'POST',
    body: payload,
    auth: 'master',
  });
}

export interface TenantBillingPlanVariantOverridePayload {
  tenantId: string;
  planVariantId: string;
  note?: string;
}

export interface TenantBillingPlanVariantOverrideResponse {
  ok: boolean;
  tenant: TenantAdminSummary;
}

export function overrideTenantBillingPlanVariant(payload: TenantBillingPlanVariantOverridePayload) {
  return apiRequest<TenantBillingPlanVariantOverrideResponse>('/admin/tenants/billing/plan-variant', {
    method: 'POST',
    body: payload,
    auth: 'master',
  });
}

export function searchTenants(
  payload: { query?: string; limit?: number },
  options?: { signal?: AbortSignal },
) {
  return apiRequest<TenantSearchResponse>('/admin/tenants/search', {
    method: 'POST',
    body: payload,
    auth: 'master',
    signal: options?.signal,
  });
}

export interface SmsPayload {
  to: string;
  message: string;
}

export function sendSms(payload: SmsPayload) {
  return apiRequest('/twilio/sms', { method: 'POST', body: payload });
}

export interface VoiceCallPayload {
  to: string;
  message: string;
  language?: 'english' | 'hindi' | 'both';
  voice?: string;
  hindiVoice?: string;
  englishVoice?: string;
  pauseSeconds?: number;
}

export function sendVoiceCall(payload: VoiceCallPayload) {
  return apiRequest('/twilio/voice-call', { method: 'POST', body: payload });
}

export type ExpoPushMessage = {
  to: string | string[];
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: string;
  subtitle?: string;
  channelId?: string;
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
  expiration?: number | string;
  badge?: number;
  mutableContent?: boolean;
  categoryId?: string;
  collapseId?: string;
} & Record<string, unknown>;

export type ExpoPushBatchPayload = {
  messages: ExpoPushMessage[];
  dryRun?: boolean;
};

export type ExpoPushPayload = ExpoPushMessage | ExpoPushBatchPayload;

export type TenantScopedExpoPushPayload = ExpoPushPayload & { tenantId: string };

export function proxyExpoPush(payload: TenantScopedExpoPushPayload) {
  return apiRequest('/notifications/push', { method: 'POST', body: payload });
}

export interface TeamMembershipPayload {
  tenantId: string;
  action: 'added' | 'removed' | 'role_changed';
  targetEmail: string;
  targetRole?: 'user' | 'admin';
  previousRole?: 'user' | 'admin';
  metadata?: {
    displayName?: string;
    reason?: string;
    initiatedFrom?: 'web' | 'mobile' | 'system';
    actorName?: string;
  };
}

export function sendTeamMembershipEvent(payload: TeamMembershipPayload) {
  return apiRequest('/notifications/team-membership', { method: 'POST', body: payload });
}

export interface ChatMessagePayload {
  recipientId: string;
  tenantId: string;
  text?: string;
  isSpecial?: boolean;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  thumbnailUrl?: string;
  attachments?: Array<{
    url: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
    thumbnailUrl?: string;
  }>;
  sticker?: {
    url: string;
    name: string;
    pack?: string;
    width?: number;
    height?: number;
  };
  gif?: {
    url: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    title?: string;
    source?: string;
  };
  delivered?: boolean;
  read?: boolean;
}

export function sendChatMessage(payload: ChatMessagePayload) {
  return apiRequest('/chat/messages', { method: 'POST', body: payload });
}

export function editChatMessage(id: string, payload: { text: string; tenantId: string }) {
  return apiRequest(`/chat/messages/${id}`, { method: 'PATCH', body: payload });
}

export function deleteChatMessage(id: string, tenantId: string) {
  return apiRequest(`/chat/messages/${id}?tenantId=${encodeURIComponent(tenantId)}`, {
    method: 'DELETE',
  });
}

export interface ChatDeltaRequest {
  userEmail: string;
  partnerEmail: string;
  tenantId: string;
  direction?: 'latest' | 'older' | 'newer';
  limit?: number;
  cursor?: {
    timestamp?: string;
    messageId?: string;
  };
}

export function fetchChatDelta(payload: ChatDeltaRequest) {
  return apiRequest('/chat/delta', { method: 'POST', body: payload });
}

export type UsageMetricKey = 'students' | 'staff' | 'reminders' | 'storage';

export interface UsageStorageSource {
  label: string;
  bytes: number;
}

export interface UsageDiagnostics {
  warnings?: string[];
  generatedAt?: string;
}

export interface UsageMetricStatus {
  value: number;
  limit: number;
  percentage: number;
  status: UsageStatus;
}

export type UsageMetricStatusMap = Partial<Record<UsageMetricKey, UsageMetricStatus>>;

export interface UsageAlertRecord {
  id: string;
  metric: UsageMetricKey;
  type: 'warning' | 'critical';
  createdAt: string;
  acknowledgedAt?: string | null;
  details?: string;
  value?: number;
  limit?: number;
  ratio?: number;
}

export interface UsageSummaryResponse {
  tenantId?: string;
  month: string;
  planId: PlanId;
  planLimits: PlanLimits;
  students: number;
  studentsAdded: number;
  staff: number;
  reminders: {
    total: number;
    whatsapp: number;
    sms: number;
    email: number;
    voice?: number;
    other?: number;
  };
  paymentsReceived?: {
    count: number;
    amount: number;
  };
  noticePosts: number;
  deviceActions: number;
  chatMessages: number | null;
  storageBytes: number;
  storageSources: UsageStorageSource[];
  alerts?: UsageAlertRecord[];
  metricsVersion?: number;
  lastRefreshedAt?: string;
  diagnostics?: UsageDiagnostics;
  statuses: UsageMetricStatusMap;
}

export interface UsageHistoryPoint {
  month: string;
  students: number;
  studentsAdded?: number;
  staff: number;
  remindersTotal: number;
  remindersWhatsApp?: number;
  remindersSms?: number;
  remindersEmail?: number;
  storageBytes: number;
  noticePosts?: number;
  deviceActions?: number;
  chatMessages?: number | null;
  paymentsReceivedCount?: number;
  paymentsReceivedAmount?: number;
}

function buildUsageMetricStatus(value: number, limit: number): UsageMetricStatus {
  return {
    value,
    limit,
    percentage: getUsagePercentage(value, limit),
    status: getUsageStatus(value, limit),
  };
}

function buildUsageStatuses(summary: UsageSummaryResponse): UsageMetricStatusMap {
  const limits = summary.planLimits ?? getPlanLimits(summary.planId);
  return {
    students: buildUsageMetricStatus(summary.students, limits.students),
    staff: buildUsageMetricStatus(summary.staff, limits.staffSeats),
    reminders: buildUsageMetricStatus(summary.reminders.total, limits.reminders.total),
    storage: buildUsageMetricStatus(summary.storageBytes, limits.storageBytes),
  };
}

function buildUsageFallback(planId: PlanId = 'free'): UsageSummaryResponse {
  const planLimits = getPlanLimits(planId);
  const summary: UsageSummaryResponse = {
    planId,
    planLimits,
    month: new Date().toISOString().slice(0, 7),
    students: 0,
    studentsAdded: 0,
    staff: 0,
    reminders: {
      total: 0,
      whatsapp: 0,
      sms: 0,
      email: 0,
      voice: 0,
      other: 0,
    },
    noticePosts: 0,
    deviceActions: 0,
    chatMessages: 0,
    storageBytes: 0,
    storageSources: [],
    alerts: [],
    metricsVersion: 1,
    lastRefreshedAt: new Date().toISOString(),
    diagnostics: { warnings: ['Usage data not yet available'] },
    statuses: {},
  };
  summary.statuses = buildUsageStatuses(summary);
  return summary;
}

export async function fetchUsageSummary(params: { tenantId?: string; month?: string; planId?: PlanId } = {}) {
  try {
    return await apiRequest<UsageSummaryResponse>('/usage/current', { query: params });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return buildUsageFallback(params.planId ?? 'free');
    }
    throw error;
  }
}

export async function fetchUsageHistory(params: { tenantId?: string; months?: number } = {}) {
  return apiRequest<UsageHistoryPoint[]>('/usage/history', { query: params });
}

export function acknowledgeUsageAlert(alertId: string, payload: { tenantId: string }) {
  return apiRequest(`/usage/alerts/${alertId}/ack`, { method: 'POST', body: payload });
}

export interface BillingInvoiceRecord {
  id: string;
  invoiceNumber?: string;
  amountInr: number;
  status: 'paid' | 'open' | 'failed' | 'void' | 'uncollectible';
  issuedAt?: string;
  dueAt?: string;
  downloadUrl?: string;
  provider?: string;
}

export type BillingHistoryCursor = {
  at: string;
  id: string;
};

export type BillingHistoryResponse = {
  tenantId: string;
  invoices: BillingInvoiceRecord[];
  changes: Array<{ id: string; action: string; actorEmail?: string; createdAt?: string; metadata?: Record<string, unknown> }>;
  totals?: { invoices?: number; changes?: number };
  matchingTotals?: { invoices?: number; changes?: number };
  pageInfo?: {
    invoices: { nextCursor?: BillingHistoryCursor };
    changes: { nextCursor?: BillingHistoryCursor };
  };
};

export interface BillingSummaryResponse {
  tenantId?: string;
  planId: PlanId;
  planVariantId?: string;
  status: 'trial' | 'active' | 'delinquent' | 'canceled';
  renewalDate?: string;
  checkoutRequired?: boolean;
  invoices: BillingInvoiceRecord[];
}

function buildBillingFallback(planId: PlanId = 'free'): BillingSummaryResponse {
  const isFree = planId === 'free';
  return {
    planId,
    status: isFree ? 'trial' : 'active',
    checkoutRequired: !isFree,
    invoices: [],
  };
}

export async function fetchBillingSummary(params: { tenantId?: string; planId?: PlanId } = {}) {
  try {
    return await apiRequest<BillingSummaryResponse>('/billing/summary', { query: params });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return buildBillingFallback(params.planId ?? 'free');
    }
    throw error;
  }
}

export async function fetchBillingHistory(
  params: {
    tenantId?: string;
    pageSize?: number;
    limitInvoices?: number;
    limitChanges?: number;
    cursorInvoiceAt?: string;
    cursorInvoiceId?: string;
    cursorChangeAt?: string;
    cursorChangeId?: string;
    includeTotals?: boolean;
    invoiceStatus?: BillingInvoiceRecord['status'];
  } = {}
) {
  return apiRequest<BillingHistoryResponse>('/billing/history', { query: params });
}

export interface BillingInvoiceDownloadUrlResponse {
  ok: true;
  downloadUrl: string;
}

export function fetchBillingInvoiceDownloadUrl(query: { tenantId: string; invoiceId: string; force?: boolean }) {
  return apiRequest<BillingInvoiceDownloadUrlResponse>('/billing/invoice/download-url', { query });
}

export interface BillingCheckoutPayload {
  tenantId: string;
  planId: PlanId;
  provider?: 'stripe' | 'razorpay';
  successUrl?: string;
  cancelUrl?: string;
  metadata?: Record<string, string>;
}

export interface BillingCheckoutResponse {
  checkoutUrl: string;
  provider: string;
  sessionId?: string;
}

export async function startBillingCheckout(payload: BillingCheckoutPayload) {
  try {
    return await apiRequest<BillingCheckoutResponse>('/billing/checkout', { method: 'POST', body: payload });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return {
        checkoutUrl: '#',
        provider: payload.provider ?? 'stripe',
        sessionId: 'preview-only',
      } satisfies BillingCheckoutResponse;
    }
    throw error;
  }
}
