import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Copy, Download, RefreshCcw, Search, X } from 'lucide-react';
import { SectionCard } from '../../components/SectionCard';
import {
  ApiError,
  acknowledgeUsageAlert,
  fetchBillingCatalogAdmin,
  fetchBillingHistory,
  fetchBillingInvoicePdf,
  fetchBillingSummary,
  fetchTenantAuditLogs,
  fetchTenantInvites,
  fetchTenantMemberships,
  fetchTenantUserDevices,
  overrideTenantBillingPlanVariant,
  startBillingCheckout,
  fetchUsageSummary,
  resendTenantInvite,
  searchTenants,
  fetchTenantReminderSettings,
  updateTenantReminderSettings,
  updateTenantQuotas,
  updateTenantMembershipRole,
  type ReminderChannelKey,
  type TenantReminderSettingsDoc,
  type BillingCatalogPlanVariant,
  type BillingHistoryCursor,
  type BillingInvoiceRecord,
  type BillingSummaryResponse,
  type TenantAdminSummary,
  type TenantMembershipAdminRecord,
  type TenantMembershipInspectorResponse,
  type TenantMembershipRole,
  type TenantAuditAdminRecord,
  type TenantAuditInspectorResponse,
  type TenantInviteAdminRecord,
  type TenantInviteInspectorResponse,
  type TenantSearchResponse,
  type TenantUserDeviceRecord,
  type UsageMetricKey,
  type UsageSummaryResponse,
} from '../../lib/apiClient';
import { formatNumber } from '../../lib/metrics';
import { getPlanLimits, getUsagePercentage, getUsageStatus, type PlanId, type UsageStatus } from '@shared/planLimits';

type MembershipFilters = {
  search: string;
  status: string;
  role: TenantMembershipInspectorResponse['filters']['role'];
};

const DEFAULT_LIMIT = 25;
const MEMBERSHIP_LIMIT = 100;
const INVITE_LIMIT = 100;
const AUDIT_LIMIT = 100;

const DEFAULT_MEMBER_FILTERS: MembershipFilters = {
  search: '',
  status: 'all',
  role: 'all',
};

type InviteFilters = {
  search: string;
  status: string;
};

const DEFAULT_INVITE_FILTERS: InviteFilters = {
  search: '',
  status: 'pending',
};

type QuotaField =
  | 'maxStudents'
  | 'maxStaff'
  | 'maxMonthlyReminders'
  | 'maxMonthlyWhatsappReminders'
  | 'maxMonthlySmsReminders'
  | 'maxMonthlyEmailReminders'
  | 'maxMonthlyVoiceReminders'
  | 'maxStorageMb';

type QuotaFormState = Record<QuotaField, string> & { note: string };

const DEFAULT_QUOTA_FORM: QuotaFormState = {
  maxStudents: '',
  maxStaff: '',
  maxMonthlyReminders: '',
  maxMonthlyWhatsappReminders: '',
  maxMonthlySmsReminders: '',
  maxMonthlyEmailReminders: '',
  maxMonthlyVoiceReminders: '',
  maxStorageMb: '',
  note: '',
};

const QUOTA_FIELDS: Array<{ key: QuotaField; label: string; helper: string }> = [
  { key: 'maxStudents', label: 'Max students', helper: 'Current limit is shown as placeholder.' },
  { key: 'maxStaff', label: 'Max team seats', helper: 'Applies to active owners/admins/staff plus pending seat invites.' },
  { key: 'maxMonthlyReminders', label: 'Monthly reminders (total)', helper: 'Total reminders allowed each month across channels.' },
  { key: 'maxMonthlyWhatsappReminders', label: 'Monthly WhatsApp reminders', helper: 'WhatsApp reminders allowed each month.' },
  { key: 'maxMonthlySmsReminders', label: 'Monthly SMS reminders', helper: 'SMS reminders allowed each month.' },
  { key: 'maxMonthlyEmailReminders', label: 'Monthly Email reminders', helper: 'Email reminders allowed each month.' },
  { key: 'maxMonthlyVoiceReminders', label: 'Monthly voice reminders', helper: 'Voice call reminders allowed each month.' },
  { key: 'maxStorageMb', label: 'Storage (MB)', helper: 'Used for media uploads + backups.' },
];

type AuditFilters = {
  search: string;
  action: string;
};

const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  search: '',
  action: 'all',
};

const KNOWN_AUDIT_ACTIONS = ['reminder_queued', 'quota_override', 'membership_change', 'invite_notification', 'tenant_flag_update'];

const KNOWN_PLAN_IDS: PlanId[] = ['free', 'pro', 'enterprise'];
const CUSTOM_ENTERPRISE_VARIANT_ID = 'enterprise_custom';

const GB = 1024 * 1024 * 1024;

type InvoiceFilters = {
  search: string;
  status: 'all' | 'paid' | 'open' | 'failed' | 'uncollectible';
};

const DEFAULT_INVOICE_FILTERS: InvoiceFilters = {
  search: '',
  status: 'all',
};

function normalizePlanId(raw?: string | null): PlanId {
  if (!raw) return 'free';
  const normalized = raw.trim().toLowerCase();
  return KNOWN_PLAN_IDS.includes(normalized as PlanId) ? (normalized as PlanId) : 'free';
}

function formatStorage(bytes?: number | null) {
  if (!bytes || !Number.isFinite(bytes)) {
    return '0 MB';
  }
  if (bytes >= GB) {
    const value = bytes / GB;
    return `${Number.isInteger(value) ? value : value.toFixed(1)} GB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function formatInr(amount?: number | null) {
  if (amount === null) return 'Custom pricing';
  if (amount === undefined) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);
}

function usageBadgeClass(status: UsageStatus) {
  if (status === 'critical') return 'badge offline';
  if (status === 'warning') return 'badge offline';
  return 'badge online';
}

function formatUsageMetricValue(metric: UsageMetricKey, value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  if (metric === 'storage') {
    return formatStorage(value);
  }
  return formatNumber(value);
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const asString = String(value).replace(/\r?\n/g, ' ').trim();
  if (!/[",]/.test(asString)) {
    return asString;
  }
  return `"${asString.replace(/"/g, '""')}"`;
}

function buildCsvContent(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const headerSet = new Set<string>();
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => headerSet.add(key));
  });
  const headers = Array.from(headerSet);
  const csvLines = [headers.join(',')];
  rows.forEach((row) => {
    const line = headers.map((key) => escapeCsvValue(row[key])).join(',');
    csvLines.push(line);
  });
  return csvLines.join('\n');
}

function downloadCsv(rows: Array<Record<string, unknown>>, fileName: string) {
  const content = buildCsvContent(rows);
  if (!content) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    console.warn('[TenantDirectoryPanel] CSV export unavailable in this environment');
    return;
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

type Diagnostics = TenantSearchResponse['diagnostics'];

type SeatUsageRow = {
  label: string;
  value: string;
};

type TenantInspectorEventDetail = {
  tenantId: string;
  focus?: 'memberships' | 'audit' | 'invites';
  searchTerm?: string;
};

export function TenantDirectoryPanel() {
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [results, setResults] = useState<TenantAdminSummary[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [inspectorTenant, setInspectorTenant] = useState<TenantAdminSummary | null>(null);
  const [membershipRows, setMembershipRows] = useState<TenantMembershipAdminRecord[]>([]);
  const [membershipMeta, setMembershipMeta] = useState<TenantMembershipInspectorResponse | null>(null);
  const [membershipFilters, setMembershipFilters] = useState<MembershipFilters>(DEFAULT_MEMBER_FILTERS);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const [membershipRoleDrafts, setMembershipRoleDrafts] = useState<Record<string, TenantMembershipRole>>({});
  const [membershipRoleSavingId, setMembershipRoleSavingId] = useState<string | null>(null);
  const [membershipRoleNotice, setMembershipRoleNotice] = useState<string | null>(null);
  const [membershipRoleError, setMembershipRoleError] = useState<string | null>(null);

  const [showMemberDevices, setShowMemberDevices] = useState(false);
  const [memberDeviceExpandedByEmail, setMemberDeviceExpandedByEmail] = useState<Record<string, boolean>>({});
  const [memberDevicesByEmail, setMemberDevicesByEmail] = useState<
    Record<
      string,
      {
        loading: boolean;
        error: string | null;
        devices: TenantUserDeviceRecord[] | null;
      }
    >
  >({});
  const [quotaForm, setQuotaForm] = useState<QuotaFormState>(DEFAULT_QUOTA_FORM);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [quotaSuccess, setQuotaSuccess] = useState<string | null>(null);
  const [inviteFilters, setInviteFilters] = useState<InviteFilters>(DEFAULT_INVITE_FILTERS);
  const [inviteRows, setInviteRows] = useState<TenantInviteAdminRecord[]>([]);
  const [inviteMeta, setInviteMeta] = useState<TenantInviteInspectorResponse | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const [auditFilters, setAuditFilters] = useState<AuditFilters>(DEFAULT_AUDIT_FILTERS);
  const [auditRows, setAuditRows] = useState<TenantAuditAdminRecord[]>([]);
  const [auditMeta, setAuditMeta] = useState<TenantAuditInspectorResponse | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [pendingInspectorContext, setPendingInspectorContext] = useState<TenantInspectorEventDetail | null>(null);
  const [usageSummary, setUsageSummary] = useState<UsageSummaryResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [billingSummary, setBillingSummary] = useState<BillingSummaryResponse | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);

  const [invoiceFilters, setInvoiceFilters] = useState<InvoiceFilters>(DEFAULT_INVOICE_FILTERS);
  const [billingInvoices, setBillingInvoices] = useState<BillingInvoiceRecord[]>([]);
  const [billingInvoicesLoading, setBillingInvoicesLoading] = useState(false);
  const [billingInvoicesError, setBillingInvoicesError] = useState<string | null>(null);
  const [billingInvoicesTotal, setBillingInvoicesTotal] = useState<number | null>(null);
  const [billingInvoiceCursor, setBillingInvoiceCursor] = useState<BillingHistoryCursor | null>(null);
  const [billingInvoiceCursorStack, setBillingInvoiceCursorStack] = useState<(BillingHistoryCursor | null)[]>([]);
  const [billingInvoiceNextCursor, setBillingInvoiceNextCursor] = useState<BillingHistoryCursor | null>(null);
  const [billingInvoicePageSize, setBillingInvoicePageSize] = useState<10 | 25 | 50>(25);
  const [invoiceDownloadBusyId, setInvoiceDownloadBusyId] = useState<string | null>(null);
  const [invoiceDownloadBusyAction, setInvoiceDownloadBusyAction] = useState<'download' | 'regenerate' | null>(null);
  const [invoiceDownloadError, setInvoiceDownloadError] = useState<string | null>(null);
  const [acknowledgingAlertId, setAcknowledgingAlertId] = useState<string | null>(null);
  const [usageAlertNotice, setUsageAlertNotice] = useState<string | null>(null);
  const [usageAlertError, setUsageAlertError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutNotice, setCheckoutNotice] = useState<string | null>(null);

  const [billingCatalogPlans, setBillingCatalogPlans] = useState<BillingCatalogPlanVariant[] | null>(null);
  const [billingCatalogLoading, setBillingCatalogLoading] = useState(false);
  const [billingCatalogError, setBillingCatalogError] = useState<string | null>(null);
  const [billingPlanVariantDraft, setBillingPlanVariantDraft] = useState<string>('');
  const [billingPlanVariantNote, setBillingPlanVariantNote] = useState<string>('');
  const [billingPlanVariantSaving, setBillingPlanVariantSaving] = useState(false);
  const [billingPlanVariantError, setBillingPlanVariantError] = useState<string | null>(null);
  const [billingPlanVariantSuccess, setBillingPlanVariantSuccess] = useState<string | null>(null);

  const [reminderSettingsLoading, setReminderSettingsLoading] = useState(false);
  const [reminderSettingsSaving, setReminderSettingsSaving] = useState(false);
  const [reminderSettingsError, setReminderSettingsError] = useState<string | null>(null);
  const [reminderSettingsSuccess, setReminderSettingsSuccess] = useState<string | null>(null);
  const [reminderSettingsBaseline, setReminderSettingsBaseline] = useState<Partial<Record<ReminderChannelKey, boolean>> | null>(null);
  const [reminderMessageBaseline, setReminderMessageBaseline] = useState<Record<ReminderChannelKey, string> | null>(null);
  const [reminderHideDisabledBaseline, setReminderHideDisabledBaseline] = useState<boolean | undefined | null>(null);
  const [reminderEnabledDraft, setReminderEnabledDraft] = useState<Record<ReminderChannelKey, boolean>>({
    email: true,
    sms: true,
    whatsapp: true,
    voice: true,
  });
  const [reminderMessageDraft, setReminderMessageDraft] = useState<Record<ReminderChannelKey, string>>({
    email: '',
    sms: '',
    whatsapp: '',
    voice: '',
  });
  const [reminderHideDisabledDraft, setReminderHideDisabledDraft] = useState<boolean | undefined>(undefined);

  const billingPlanOptions = useMemo(() => {
    const source = billingCatalogPlans || [];
    const hasCustom = source.some((plan) => plan?.id === CUSTOM_ENTERPRISE_VARIANT_ID);
    if (hasCustom) return source;
    return [
      ...source,
      {
        id: CUSTOM_ENTERPRISE_VARIANT_ID,
        planId: 'enterprise',
        displayName: 'Custom (Enterprise)',
        currency: 'INR',
        priceInr: 0,
        interval: 'month',
        provider: 'razorpay',
        active: true,
        sortOrder: 10_000,
      } satisfies BillingCatalogPlanVariant,
    ];
  }, [billingCatalogPlans]);

  const isCustomEnterpriseCurrent = useMemo(() => {
    const current = (billingSummary?.planVariantId || '').trim();
    return current === CUSTOM_ENTERPRISE_VARIANT_ID;
  }, [billingSummary?.planVariantId]);

  const isCustomEnterpriseDraft = useMemo(() => {
    return billingPlanVariantDraft.trim() === CUSTOM_ENTERPRISE_VARIANT_ID;
  }, [billingPlanVariantDraft]);

  const buildExportFileName = useCallback(
    (suffix: string) => {
      const base = inspectorTenant?.slug || inspectorTenant?.id || 'tenant';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      return `${base}_${suffix}_${timestamp}.csv`;
    },
    [inspectorTenant],
  );

  const searchAbortRef = useRef<AbortController | null>(null);
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    setMemberDeviceExpandedByEmail({});
    setMemberDevicesByEmail({});
  }, [inspectorTenant?.id]);

  const loadTenantReminderSettings = useCallback(async (tenantId: string) => {
    setReminderSettingsLoading(true);
    setReminderSettingsError(null);
    setReminderSettingsSuccess(null);
    try {
      const resp = await fetchTenantReminderSettings({ tenantId });
      const doc = (resp?.data ?? null) as TenantReminderSettingsDoc | null;
      const enabled = (doc?.enabledChannels ?? {}) as Partial<Record<ReminderChannelKey, boolean>>;
      const messages = (doc?.channelMessages ?? {}) as Partial<Record<ReminderChannelKey, string>>;
      const hideDisabled =
        typeof (doc as any)?.hideDisabledReminderTypes === 'boolean' ? (doc as any).hideDisabledReminderTypes : undefined;
      const resolved: Record<ReminderChannelKey, boolean> = {
        email: enabled.email !== false,
        sms: enabled.sms !== false,
        whatsapp: enabled.whatsapp !== false,
        voice: enabled.voice !== false,
      };
      setReminderEnabledDraft(resolved);
      const resolvedMessages: Record<ReminderChannelKey, string> = {
        email: messages.email ?? '',
        sms: messages.sms ?? '',
        whatsapp: messages.whatsapp ?? '',
        voice: messages.voice ?? '',
      };
      setReminderMessageDraft(resolvedMessages);
      setReminderHideDisabledDraft(hideDisabled);
      setReminderSettingsBaseline({
        email: resolved.email,
        sms: resolved.sms,
        whatsapp: resolved.whatsapp,
        voice: resolved.voice,
      });
      setReminderMessageBaseline(resolvedMessages);
      setReminderHideDisabledBaseline(hideDisabled);
    } catch (err) {
      console.warn('[TenantDirectoryPanel] reminder settings fetch failed', err);
      if (err instanceof ApiError) {
        setReminderSettingsError(`Reminder settings fetch failed (${err.status})`);
      } else if (err instanceof Error) {
        setReminderSettingsError(err.message);
      } else {
        setReminderSettingsError('Unable to load reminder settings.');
      }
    } finally {
      setReminderSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!inspectorTenant?.id) return;
    void loadTenantReminderSettings(inspectorTenant.id);
  }, [inspectorTenant?.id, loadTenantReminderSettings]);

  const reminderSettingsDirty = useMemo(() => {
    if (!reminderSettingsBaseline) return false;
    if (!reminderMessageBaseline) return false;
    if (reminderHideDisabledBaseline === null) return false;
    const sameMsg = (channel: ReminderChannelKey) =>
      (reminderMessageDraft[channel] || '').trim() === (reminderMessageBaseline[channel] || '').trim();
    return (
      reminderEnabledDraft.email !== (reminderSettingsBaseline.email !== false) ||
      reminderEnabledDraft.sms !== (reminderSettingsBaseline.sms !== false) ||
      reminderEnabledDraft.whatsapp !== (reminderSettingsBaseline.whatsapp !== false) ||
      reminderEnabledDraft.voice !== (reminderSettingsBaseline.voice !== false) ||
      reminderHideDisabledDraft !== reminderHideDisabledBaseline ||
      !sameMsg('email') ||
      !sameMsg('sms') ||
      !sameMsg('whatsapp') ||
      !sameMsg('voice')
    );
  }, [
    reminderEnabledDraft,
    reminderSettingsBaseline,
    reminderMessageBaseline,
    reminderMessageDraft,
    reminderHideDisabledBaseline,
    reminderHideDisabledDraft,
  ]);

  const handleReminderEnabledToggle = useCallback((channel: ReminderChannelKey) => {
    setReminderSettingsError(null);
    setReminderSettingsSuccess(null);
    setReminderEnabledDraft((prev) => ({
      ...prev,
      [channel]: !prev[channel],
    }));
  }, []);

  const handleReminderMessageChange = useCallback((channel: ReminderChannelKey, value: string) => {
    setReminderSettingsError(null);
    setReminderSettingsSuccess(null);
    setReminderMessageDraft((prev) => ({
      ...prev,
      [channel]: value,
    }));
  }, []);

  const handleReminderHideDisabledToggle = useCallback((value: boolean) => {
    setReminderSettingsError(null);
    setReminderSettingsSuccess(null);
    setReminderHideDisabledDraft(value);
  }, []);

  const handleReminderHideDisabledModeChange = useCallback((mode: 'inherit' | 'show' | 'hide') => {
    setReminderSettingsError(null);
    setReminderSettingsSuccess(null);
    if (mode === 'inherit') {
      setReminderHideDisabledDraft(undefined);
    } else if (mode === 'hide') {
      setReminderHideDisabledDraft(true);
    } else {
      setReminderHideDisabledDraft(false);
    }
  }, []);

  const handleReminderSettingsReload = useCallback(() => {
    if (!inspectorTenant?.id) return;
    void loadTenantReminderSettings(inspectorTenant.id);
  }, [inspectorTenant?.id, loadTenantReminderSettings]);

  const handleReminderSettingsSave = useCallback(async () => {
    if (!inspectorTenant?.id) return;
    setReminderSettingsSaving(true);
    setReminderSettingsError(null);
    setReminderSettingsSuccess(null);
    try {
      await updateTenantReminderSettings({
        tenantId: inspectorTenant.id,
        enabledChannels: {
          email: reminderEnabledDraft.email,
          sms: reminderEnabledDraft.sms,
          whatsapp: reminderEnabledDraft.whatsapp,
          voice: reminderEnabledDraft.voice,
        },
        channelMessages: {
          email: reminderMessageDraft.email,
          sms: reminderMessageDraft.sms,
          whatsapp: reminderMessageDraft.whatsapp,
          voice: reminderMessageDraft.voice,
        },
        hideDisabledReminderTypes: typeof reminderHideDisabledDraft === 'boolean' ? reminderHideDisabledDraft : null,
      });
      setReminderSettingsBaseline({
        email: reminderEnabledDraft.email,
        sms: reminderEnabledDraft.sms,
        whatsapp: reminderEnabledDraft.whatsapp,
        voice: reminderEnabledDraft.voice,
      });
      setReminderMessageBaseline({
        email: reminderMessageDraft.email,
        sms: reminderMessageDraft.sms,
        whatsapp: reminderMessageDraft.whatsapp,
        voice: reminderMessageDraft.voice,
      });
      setReminderHideDisabledBaseline(reminderHideDisabledDraft);
      setReminderSettingsSuccess('Reminder channel settings saved.');
    } catch (err) {
      console.warn('[TenantDirectoryPanel] reminder settings update failed', err);
      if (err instanceof ApiError) {
        setReminderSettingsError(`Reminder settings update failed (${err.status})`);
      } else if (err instanceof Error) {
        setReminderSettingsError(err.message);
      } else {
        setReminderSettingsError('Unable to save reminder settings.');
      }
    } finally {
      setReminderSettingsSaving(false);
    }
  }, [inspectorTenant?.id, reminderEnabledDraft, reminderMessageDraft, reminderHideDisabledDraft]);

  const executeSearch = useCallback(async (targetQuery: string) => {
    const trimmed = targetQuery.trim();
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const requestId = (searchRequestIdRef.current += 1);

    setLoading(true);
    setError(null);

    try {
      const payload = await searchTenants(
        { query: trimmed || undefined, limit: DEFAULT_LIMIT },
        { signal: controller.signal },
      );

      if (searchRequestIdRef.current !== requestId) return;
      setResults(payload.results);
      setDiagnostics(payload.diagnostics);
      setActiveQuery(trimmed);
      setLastUpdated(Date.now());
    } catch (err) {
      if (controller.signal.aborted) return;
      console.warn('[TenantDirectoryPanel] search failed', err);
      if (err instanceof ApiError) {
        setError(`Search failed (${err.status})`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Unexpected error while searching for tenants.');
      }
    } finally {
      if (searchRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
    };
  }, []);

  const inspectorTenantIdFromUrl = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const view = (params.get('view') || '').trim().toLowerCase();
    if (view !== 'membership-inspector') return null;
    return params.get('tenantId')?.trim() || null;
  }, []);

  const visibleResults = useMemo(() => {
    if (!inspectorTenantIdFromUrl) return results;
    return results.filter((tenant) => tenant.id === inspectorTenantIdFromUrl);
  }, [inspectorTenantIdFromUrl, results]);

  useEffect(() => {
    if (inspectorTenantIdFromUrl) {
      setQuery(inspectorTenantIdFromUrl);
      void executeSearch(inspectorTenantIdFromUrl);
      return;
    }
    void executeSearch('');
  }, [executeSearch, inspectorTenantIdFromUrl]);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await executeSearch(query);
    },
    [executeSearch, query],
  );

  const handleReset = async () => {
    setQuery('');
    await executeSearch('');
  };

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopiedValue(value);
      setTimeout(() => setCopiedValue((current) => (current === value ? null : current)), 1500);
    } catch (err) {
      console.warn('[TenantDirectoryPanel] clipboard unavailable', err);
      setCopiedValue(null);
    }
  };

  const normalizeEmailKey = useCallback((value: string) => value.trim().toLowerCase(), []);

  const ensureMemberDevicesLoaded = useCallback(
    async (emailKey: string, rawEmail: string) => {
      if (!inspectorTenant) return;
      const existing = memberDevicesByEmail[emailKey];
      if (existing?.loading) return;
      if (existing?.devices) return;

      setMemberDevicesByEmail((prev) => ({
        ...prev,
        [emailKey]: {
          loading: true,
          error: null,
          devices: prev[emailKey]?.devices ?? null,
        },
      }));

      try {
        const response = await fetchTenantUserDevices({ tenantId: inspectorTenant.id, email: rawEmail });
        setMemberDevicesByEmail((prev) => ({
          ...prev,
          [emailKey]: {
            loading: false,
            error: null,
            devices: response.devices || [],
          },
        }));
      } catch (err) {
        console.warn('[TenantDirectoryPanel] user devices lookup failed', err);
        let message = 'Unable to load devices.';
        if (err instanceof ApiError) {
          message = `Device lookup failed (${err.status})`;
        } else if (err instanceof Error) {
          message = err.message;
        }
        setMemberDevicesByEmail((prev) => ({
          ...prev,
          [emailKey]: {
            loading: false,
            error: message,
            devices: prev[emailKey]?.devices ?? null,
          },
        }));
      }
    },
    [inspectorTenant, memberDevicesByEmail],
  );

  const handleToggleMemberDevices = useCallback(
    (member: TenantMembershipAdminRecord) => {
      if (!inspectorTenant) return;
      if (!member.email) return;
      const emailKey = normalizeEmailKey(member.email);
      const isExpanded = Boolean(memberDeviceExpandedByEmail[emailKey]);
      const nextExpanded = !isExpanded;

      setMemberDeviceExpandedByEmail((prev) => ({
        ...prev,
        [emailKey]: nextExpanded,
      }));

      if (nextExpanded) {
        void ensureMemberDevicesLoaded(emailKey, member.email);
      }
    },
    [ensureMemberDevicesLoaded, inspectorTenant, memberDeviceExpandedByEmail, normalizeEmailKey],
  );

  const fetchMemberships = useCallback(
    async (tenantId: string, nextFilters?: MembershipFilters) => {
      const filtersToUse = nextFilters ?? membershipFilters;
      setMembershipLoading(true);
      setMembershipError(null);
      try {
        const payload = await fetchTenantMemberships({
          tenantId,
          limit: MEMBERSHIP_LIMIT,
          status: filtersToUse.status === 'all' ? undefined : filtersToUse.status,
          role: filtersToUse.role === 'all' ? undefined : filtersToUse.role,
          search: filtersToUse.search.trim() || undefined,
        });
        setMembershipRows(payload.members);
        setMembershipMeta(payload);
        if (nextFilters) {
          setMembershipFilters(nextFilters);
        }
      } catch (err) {
        console.warn('[TenantDirectoryPanel] membership lookup failed', err);
        if (err instanceof ApiError) {
          setMembershipError(`Membership lookup failed (${err.status})`);
        } else if (err instanceof Error) {
          setMembershipError(err.message);
        } else {
          setMembershipError('Unable to load memberships for that tenant.');
        }
      } finally {
        setMembershipLoading(false);
      }
    },
    [membershipFilters],
  );

  const fetchInvites = useCallback(
    async (tenantId: string, nextFilters?: InviteFilters) => {
      const filtersToUse = nextFilters ?? inviteFilters;
      setInviteLoading(true);
      setInviteError(null);
      setInviteNotice(null);
      try {
        const payload = await fetchTenantInvites({
          tenantId,
          limit: INVITE_LIMIT,
          status: filtersToUse.status === 'all' ? undefined : filtersToUse.status,
          search: filtersToUse.search.trim() || undefined,
        });
        setInviteRows(payload.invites);
        setInviteMeta(payload);
        if (nextFilters) {
          setInviteFilters(nextFilters);
        }
      } catch (err) {
        console.warn('[TenantDirectoryPanel] invite lookup failed', err);
        if (err instanceof ApiError) {
          setInviteError(`Invite lookup failed (${err.status})`);
        } else if (err instanceof Error) {
          setInviteError(err.message);
        } else {
          setInviteError('Unable to load invitations for that tenant.');
        }
      } finally {
        setInviteLoading(false);
      }
    },
    [inviteFilters],
  );

  const fetchAuditLogs = useCallback(
    async (tenantId: string, nextFilters?: AuditFilters) => {
      const filtersToUse = nextFilters ?? auditFilters;
      setAuditLoading(true);
      setAuditError(null);
      try {
        const payload = await fetchTenantAuditLogs({
          tenantId,
          limit: AUDIT_LIMIT,
          action: filtersToUse.action === 'all' ? undefined : filtersToUse.action,
          search: filtersToUse.search.trim() || undefined,
        });
        setAuditRows(payload.entries);
        setAuditMeta(payload);
        if (nextFilters) {
          setAuditFilters(nextFilters);
        }
      } catch (err) {
        console.warn('[TenantDirectoryPanel] audit lookup failed', err);
        if (err instanceof ApiError) {
          setAuditError(`Audit lookup failed (${err.status})`);
        } else if (err instanceof Error) {
          setAuditError(err.message);
        } else {
          setAuditError('Unable to load tenant audit logs.');
        }
      } finally {
        setAuditLoading(false);
      }
    },
    [auditFilters],
  );

  const applyInspectorFocus = useCallback(
    (tenantId: string, detail?: TenantInspectorEventDetail | null) => {
      if (!detail) return;
      if (detail.focus === 'audit') {
        const nextFilters: AuditFilters = {
          ...DEFAULT_AUDIT_FILTERS,
          search: detail.searchTerm ?? '',
          action: DEFAULT_AUDIT_FILTERS.action,
        };
        setAuditFilters(nextFilters);
        void fetchAuditLogs(tenantId, nextFilters);
      }
    },
    [fetchAuditLogs],
  );

  const handleInspectorEvent = useCallback(
    (event: Event) => {
      const custom = event as CustomEvent<TenantInspectorEventDetail>;
      const detail = custom.detail;
      if (!detail?.tenantId) return;
      if (inspectorTenant?.id === detail.tenantId) {
        applyInspectorFocus(detail.tenantId, detail);
        setPendingInspectorContext(null);
        return;
      }
      setPendingInspectorContext(detail);
      setQuery(detail.tenantId);
      void executeSearch(detail.tenantId);
    },
    [applyInspectorFocus, executeSearch, inspectorTenant],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.addEventListener('tenant-inspector:open', handleInspectorEvent as EventListener);
    return () => {
      window.removeEventListener('tenant-inspector:open', handleInspectorEvent as EventListener);
    };
  }, [handleInspectorEvent]);

  const hasAutoOpenedInspectorRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (hasAutoOpenedInspectorRef.current) return;
    const tenantId = new URLSearchParams(window.location.search).get('tenantId')?.trim();
    if (!tenantId) return;
    hasAutoOpenedInspectorRef.current = true;
    window.dispatchEvent(new CustomEvent('tenant-inspector:open', { detail: { tenantId } }));
  }, []);

  const handleOpenInspectorInNewTab = useCallback((tenantId: string) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'tenants');
    url.searchParams.set('view', 'membership-inspector');
    url.searchParams.set('tenantId', tenantId);
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }, []);

  const handleInspect = useCallback(
    (tenant: TenantAdminSummary) => {
      setInspectorTenant(tenant);
      setMembershipMeta(null);
      setMembershipRows([]);
      setMembershipError(null);
      const defaults: MembershipFilters = { ...DEFAULT_MEMBER_FILTERS };
      setMembershipFilters(defaults);
      void fetchMemberships(tenant.id, defaults);
      setQuotaForm({ ...DEFAULT_QUOTA_FORM });
      setQuotaError(null);
      setQuotaSuccess(null);
      const inviteDefaults: InviteFilters = { ...DEFAULT_INVITE_FILTERS };
      setInviteFilters(inviteDefaults);
      setInviteMeta(null);
      setInviteRows([]);
      setInviteError(null);
      setInviteNotice(null);
      void fetchInvites(tenant.id, inviteDefaults);
      const auditDefaults: AuditFilters = { ...DEFAULT_AUDIT_FILTERS };
      setAuditFilters(auditDefaults);
      setAuditMeta(null);
      setAuditRows([]);
      setAuditError(null);
      void fetchAuditLogs(tenant.id, auditDefaults);
    },
    [fetchAuditLogs, fetchInvites, fetchMemberships],
  );

  useEffect(() => {
    if (!pendingInspectorContext) return;
    if (inspectorTenant?.id === pendingInspectorContext.tenantId) {
      applyInspectorFocus(pendingInspectorContext.tenantId, pendingInspectorContext);
      setPendingInspectorContext(null);
      return;
    }
    const match = results.find((tenant) => tenant.id === pendingInspectorContext.tenantId);
    if (match) {
      handleInspect(match);
      applyInspectorFocus(match.id, pendingInspectorContext);
      setPendingInspectorContext(null);
    }
  }, [applyInspectorFocus, handleInspect, inspectorTenant, pendingInspectorContext, results]);

  const handleMembershipSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!inspectorTenant) return;
      await fetchMemberships(inspectorTenant.id);
    },
    [fetchMemberships, inspectorTenant],
  );

  const resolveMembershipRoleDraft = useCallback(
    (member: TenantMembershipAdminRecord): TenantMembershipRole => {
      const cached = membershipRoleDrafts[member.id];
      if (cached) return cached;
      const raw = (member.role || 'member').toLowerCase();
      if (raw === 'owner' || raw === 'admin' || raw === 'staff' || raw === 'member') {
        return raw;
      }
      return 'member';
    },
    [membershipRoleDrafts],
  );

  const handleMembershipRoleDraftChange = useCallback((memberId: string, role: TenantMembershipRole) => {
    setMembershipRoleDrafts((prev) => ({ ...prev, [memberId]: role }));
    setMembershipRoleNotice(null);
    setMembershipRoleError(null);
  }, []);

  const handleSaveMembershipRole = useCallback(
    async (member: TenantMembershipAdminRecord) => {
      if (!inspectorTenant) return;
      if (!member.userId) {
        setMembershipRoleError('Cannot edit role: missing user id for this member.');
        return;
      }

      const desiredRole = resolveMembershipRoleDraft(member);
      const currentRole = ((member.role || 'member') as string).toLowerCase();
      if (currentRole === desiredRole) {
        setMembershipRoleNotice('No change (role already set).');
        return;
      }

      setMembershipRoleSavingId(member.id);
      setMembershipRoleNotice(null);
      setMembershipRoleError(null);

      try {
        const response = await updateTenantMembershipRole({
          tenantId: inspectorTenant.id,
          userId: member.userId,
          role: desiredRole,
          metadata: { reason: 'tenant_directory_role_editor', initiatedFrom: 'system' },
        });
        if (response.changed) {
          setMembershipRows((prev) =>
            prev.map((row) => (row.id === member.id ? { ...row, role: response.membership.role } : row)),
          );
          setMembershipRoleNotice('Member role updated.');
        } else {
          setMembershipRoleNotice('No change (role already set).');
        }
      } catch (err) {
        console.warn('[TenantDirectoryPanel] membership role update failed', err);
        if (err instanceof ApiError) {
          setMembershipRoleError(`Role update failed (${err.status})`);
        } else if (err instanceof Error) {
          setMembershipRoleError(err.message);
        } else {
          setMembershipRoleError('Unable to update member role.');
        }
      } finally {
        setMembershipRoleSavingId(null);
      }
    },
    [inspectorTenant, resolveMembershipRoleDraft],
  );

  const handleMembershipReset = useCallback(() => {
    if (!inspectorTenant) return;
    const defaults: MembershipFilters = { ...DEFAULT_MEMBER_FILTERS };
    setMembershipFilters(defaults);
    void fetchMemberships(inspectorTenant.id, defaults);
  }, [fetchMemberships, inspectorTenant]);

  const handleMembershipRefresh = useCallback(() => {
    if (!inspectorTenant) return;
    void fetchMemberships(inspectorTenant.id);
  }, [fetchMemberships, inspectorTenant]);

  const handleCloseInspector = useCallback(() => {
    setInspectorTenant(null);
    setMembershipRows([]);
    setMembershipMeta(null);
    setMembershipError(null);
    setMembershipLoading(false);
    setMembershipFilters({ ...DEFAULT_MEMBER_FILTERS });
    setQuotaForm({ ...DEFAULT_QUOTA_FORM });
    setQuotaError(null);
    setQuotaSuccess(null);
    setInviteRows([]);
    setInviteMeta(null);
    setInviteError(null);
    setInviteLoading(false);
    setInviteFilters({ ...DEFAULT_INVITE_FILTERS });
    setInviteNotice(null);
    setResendingInviteId(null);
    setAuditRows([]);
    setAuditMeta(null);
    setAuditError(null);
    setAuditLoading(false);
    setAuditFilters({ ...DEFAULT_AUDIT_FILTERS });

    setShowMemberDevices(false);
    setMemberDeviceExpandedByEmail({});
    setMemberDevicesByEmail({});
  }, []);

  const handleInviteSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!inspectorTenant) return;
      await fetchInvites(inspectorTenant.id);
    },
    [fetchInvites, inspectorTenant],
  );

  const handleInviteReset = useCallback(() => {
    if (!inspectorTenant) return;
    const defaults: InviteFilters = { ...DEFAULT_INVITE_FILTERS };
    setInviteFilters(defaults);
    void fetchInvites(inspectorTenant.id, defaults);
  }, [fetchInvites, inspectorTenant]);

  const handleInviteRefresh = useCallback(() => {
    if (!inspectorTenant) return;
    void fetchInvites(inspectorTenant.id);
  }, [fetchInvites, inspectorTenant]);

  const handleResendInvite = useCallback(
    async (inviteId: string) => {
      if (!inspectorTenant) return;
      setResendingInviteId(inviteId);
      setInviteNotice(null);
      setInviteError(null);
      try {
        await resendTenantInvite(inviteId, inspectorTenant.id);
        setInviteNotice('Invite email sent.');
        await fetchInvites(inspectorTenant.id);
      } catch (err) {
        console.warn('[TenantDirectoryPanel] resend invite failed', err);
        if (err instanceof ApiError) {
          setInviteError(`Resend failed (${err.status})`);
        } else if (err instanceof Error) {
          setInviteError(err.message);
        } else {
          setInviteError('Unable to resend invite.');
        }
      } finally {
        setResendingInviteId(null);
      }
    },
    [fetchInvites, inspectorTenant],
  );

  const handleExportMemberships = useCallback(() => {
    if (!inspectorTenant || membershipRows.length === 0) return;
    const rows = membershipRows.map((member) => ({
      TenantId: inspectorTenant.id,
      MemberId: member.id,
      Email: member.email || '',
      DisplayName: member.displayName || '',
      Role: member.role || '',
      Status: member.status || '',
      JoinedVia: member.joinedVia || '',
      JoinCodeId: member.joinCodeId || '',
      InvitedByEmail: member.invitedByEmail || '',
      InvitedByUserId: member.invitedByUserId || '',
      CreatedAt: member.createdAt || '',
      UpdatedAt: member.updatedAt || '',
      LastActivityAt: member.lastActivityAt || '',
    }));
    downloadCsv(rows, buildExportFileName('memberships'));
  }, [buildExportFileName, inspectorTenant, membershipRows]);

  const handleExportInvites = useCallback(() => {
    if (!inspectorTenant || inviteRows.length === 0) return;
    const rows = inviteRows.map((invite) => ({
      TenantId: inspectorTenant.id,
      InviteId: invite.id,
      Email: invite.email || '',
      Role: invite.role || '',
      Status: invite.status || '',
      IssuedBy: invite.issuedBy || '',
      IssuedAt: invite.issuedAt || '',
      ExpiresAt: invite.expiresAt || '',
      AcceptedAt: invite.acceptedAt || '',
      AcceptedBy: invite.acceptedBy || '',
      LastSentAt: invite.lastSentAt || '',
      LastSentBy: invite.lastSentBy || '',
      InvitationMessage: invite.invitationMessage || '',
    }));
    downloadCsv(rows, buildExportFileName('invites'));
  }, [buildExportFileName, inspectorTenant, inviteRows]);

  const handleExportAudit = useCallback(() => {
    if (!inspectorTenant || auditRows.length === 0) return;
    const rows = auditRows.map((entry) => {
      let metadataString = '';
      if (entry.metadata) {
        try {
          metadataString = JSON.stringify(entry.metadata);
        } catch {
          metadataString = '[unserializable]';
        }
      }
      return {
        TenantId: entry.tenantId,
        EntryId: entry.id,
        Action: entry.action,
        ActorId: entry.actorId || 'system',
        ActorEmail: entry.actorEmail || '',
        TargetType: entry.targetType || '',
        TargetId: entry.targetId || '',
        Metadata: metadataString,
        CreatedAt: entry.createdAt || '',
      };
    });
    downloadCsv(rows, buildExportFileName('audit'));
  }, [auditRows, buildExportFileName, inspectorTenant]);

  const handleAuditSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!inspectorTenant) return;
      await fetchAuditLogs(inspectorTenant.id);
    },
    [fetchAuditLogs, inspectorTenant],
  );

  const handleAuditReset = useCallback(() => {
    if (!inspectorTenant) return;
    const defaults: AuditFilters = { ...DEFAULT_AUDIT_FILTERS };
    setAuditFilters(defaults);
    void fetchAuditLogs(inspectorTenant.id, defaults);
  }, [fetchAuditLogs, inspectorTenant]);

  const handleAuditRefresh = useCallback(() => {
    if (!inspectorTenant) return;
    void fetchAuditLogs(inspectorTenant.id);
  }, [fetchAuditLogs, inspectorTenant]);

  const diagnosticsSummary = useMemo(() => {
    if (!diagnostics) return null;
    const labelFor = (key: string) => {
      switch (key) {
        case 'id':
          return 'ID';
        case 'code':
          return 'Join code';
        case 'slug':
          return 'Slug';
        case 'ownerEmail':
          return 'Owner email';
        case 'contactEmail':
          return 'Contact email';
        case 'membershipEmail':
          return 'Member email';
        case 'name':
          return 'Name';
        case 'recent':
          return 'Recent';
        default:
          return key;
      }
    };

    if (diagnostics.fallbackApplied) {
      return 'Showing latest tenants';
    }

    if (diagnostics.matchedBy.length) {
      const labels = diagnostics.matchedBy.map(labelFor);
      return `Matched via ${labels.join(' + ')}`;
    }

    return 'Using cached listing';
  }, [diagnostics]);

  const membershipHeadline = useMemo(() => {
    if (!inspectorTenant) return null;
    const total = membershipMeta?.total ?? membershipRows.length;
    const base = `${membershipRows.length} of ${total} matches`;
    const suffix = membershipMeta?.hasMore ? ' (refine filters for more)' : '';
    return base + suffix;
  }, [inspectorTenant, membershipMeta, membershipRows.length]);

  const membershipStatusLine = useMemo(() => {
    if (!membershipMeta) return null;
    const entries = Object.entries(membershipMeta.stats.filtered.byStatus);
    if (!entries.length) return null;
    return entries.map(([label, count]) => `${label}: ${count}`).join(' · ');
  }, [membershipMeta]);

  const membershipSnapshotLine = useMemo(() => {
    const snapshot = membershipMeta?.stats.snapshot;
    if (!snapshot) return null;
    const parts: string[] = [];
    if (typeof snapshot.total === 'number') parts.push(`total ${snapshot.total}`);
    if (typeof snapshot.active === 'number') parts.push(`active ${snapshot.active}`);
    if (typeof snapshot.pending === 'number') parts.push(`pending ${snapshot.pending}`);
    if (typeof snapshot.admins === 'number') parts.push(`admins ${snapshot.admins}`);
    return parts.length ? parts.join(' · ') : null;
  }, [membershipMeta]);

  const inviteHeadline = useMemo(() => {
    if (!inspectorTenant) return null;
    const total = inviteMeta?.total ?? inviteRows.length;
    const base = `${inviteRows.length} of ${total} invites`;
    const suffix = inviteMeta?.hasMore ? ' (refine filters for more)' : '';
    return base + suffix;
  }, [inspectorTenant, inviteMeta, inviteRows.length]);

  const inviteStatusLine = useMemo(() => {
    if (!inviteMeta) return null;
    const entries = Object.entries(inviteMeta.stats.byStatus || {});
    if (!entries.length) return null;
    return entries.map(([label, count]) => `${label}: ${count}`).join(' · ');
  }, [inviteMeta]);

  const auditHeadline = useMemo(() => {
    if (!inspectorTenant) return null;
    const total = auditMeta?.total ?? auditRows.length;
    const base = `${auditRows.length} of ${total} entries`;
    const suffix = auditMeta?.hasMore ? ' (refine filters for more)' : '';
    return base + suffix;
  }, [auditMeta, auditRows.length, inspectorTenant]);

  const auditActionLine = useMemo(() => {
    if (!auditMeta) return null;
    const entries = Object.entries(auditMeta.stats.byAction || {});
    if (!entries.length) return null;
    return entries.map(([label, count]) => `${label}: ${count}`).join(' · ');
  }, [auditMeta]);

  const auditActionOptions = useMemo(() => {
    const set = new Set(KNOWN_AUDIT_ACTIONS);
    const stats = auditMeta?.stats.byAction || {};
    Object.keys(stats).forEach((key) => set.add(key));
    return Array.from(set).filter((key) => key && key !== 'all').sort();
  }, [auditMeta]);

  const seatLines = (tenant: TenantAdminSummary): SeatUsageRow[] => {
    const seat = tenant.seatUsage;
    const limit = typeof seat?.adminSeatLimit === 'number' ? seat.adminSeatLimit : null;
    const used = typeof seat?.adminSeatsUsed === 'number' ? seat.adminSeatsUsed : null;
    const remaining = typeof seat?.remaining === 'number' ? seat.remaining : null;
    const studentLimit = tenant.quotas?.maxStudents;
    const monthlyLimit = tenant.quotas?.maxMonthlyReminders;
    const lines: SeatUsageRow[] = [];
    lines.push({
      label: 'Admin seats',
      value:
        used === null
          ? '—'
          : `${used} ${limit === null ? 'of unlimited' : `of ${limit}`}${remaining !== null ? ` (${remaining} open)` : ''}`,
    });
    if (studentLimit) {
      lines.push({ label: 'Student cap', value: formatNumber(studentLimit) });
    }
    if (monthlyLimit) {
      lines.push({ label: 'Monthly reminders', value: formatNumber(monthlyLimit) });
    }
    const members = tenant.membershipCounts;
    if (members) {
      const owners = members.owners ?? 0;
      const admins = members.admins ?? 0;
      const staff = members.staff ?? 0;
      lines.push({ label: 'Team mix', value: `${owners} owners · ${admins} admins · ${staff} staff` });
    }
    return lines;
  };

  const formatDateTime = (value?: string | null) => {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString();
  };

  const formatMetadata = (metadata?: Record<string, unknown>) => {
    if (!metadata) return '—';
    const entries = Object.entries(metadata);
    if (!entries.length) return '—';
    return entries
      .slice(0, 6)
      .map(([key, value]) => {
        if (value === null || value === undefined) return `${key}: —`;
        if (typeof value === 'object') {
          try {
            return `${key}: ${JSON.stringify(value)}`;
          } catch {
            return `${key}: [object]`;
          }
        }
        return `${key}: ${String(value)}`;
      })
      .join(' · ');
  };

  const quotaPlaceholderFor = (field: QuotaField) => {
    if (!inspectorTenant?.quotas) return 'Not set';
    const value = inspectorTenant.quotas[field];
    if (value === null || value === undefined) return 'Unlimited';
    return formatNumber(value);
  };

  const handleQuotaFieldChange = (field: QuotaField, value: string) => {
    setQuotaForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleQuotaReset = () => {
    setQuotaForm({ ...DEFAULT_QUOTA_FORM });
    setQuotaError(null);
    setQuotaSuccess(null);
  };

  const handleQuotaSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!inspectorTenant) return;

      const quotasPayload: Partial<Record<QuotaField, number | null>> = {};
      let hasChange = false;
      for (const field of QUOTA_FIELDS) {
        const raw = quotaForm[field.key].trim();
        if (!raw) {
          continue;
        }
        if (/^unlimited$/i.test(raw) || raw === '∞') {
          quotasPayload[field.key] = null;
          hasChange = true;
          continue;
        }
        const normalized = raw.replace(/,/g, '');
        const parsed = Number(normalized);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setQuotaError(`Invalid value for ${field.label}.`);
          return;
        }
        quotasPayload[field.key] = Math.floor(parsed);
        hasChange = true;
      }

      if (!hasChange) {
        setQuotaError('Enter at least one quota change.');
        return;
      }

      setQuotaSaving(true);
      setQuotaError(null);
      setQuotaSuccess(null);

      try {
        const response = await updateTenantQuotas({
          tenantId: inspectorTenant.id,
          quotas: quotasPayload,
          note: quotaForm.note.trim() || undefined,
        });
        setQuotaSuccess('Quotas updated successfully.');
        setQuotaForm({ ...DEFAULT_QUOTA_FORM });
        setInspectorTenant(response.tenant);
        setResults((prev) => prev.map((tenant) => (tenant.id === response.tenant.id ? response.tenant : tenant)));
      } catch (err) {
        console.warn('[TenantDirectoryPanel] quota override failed', err);
        if (err instanceof ApiError) {
          setQuotaError(`Quota update failed (${err.status})`);
        } else if (err instanceof Error) {
          setQuotaError(err.message);
        } else {
          setQuotaError('Unable to update tenant quotas.');
        }
      } finally {
        setQuotaSaving(false);
      }
    },
    [inspectorTenant, quotaForm, setResults],
  );

  const handleAcknowledgeAlert = useCallback(
    async (alertId: string) => {
      if (!inspectorTenant) {
        return;
      }
      setAcknowledgingAlertId(alertId);
      setUsageAlertNotice(null);
      setUsageAlertError(null);
      try {
        const response = await acknowledgeUsageAlert(alertId, { tenantId: inspectorTenant.id });
        const acknowledgedAt =
          (response as { acknowledgedAt?: string } | undefined)?.acknowledgedAt || new Date().toISOString();
        setUsageSummary((prev) => {
          if (!prev) return prev;
          const alerts = prev.alerts?.map((alert) =>
            alert.id === alertId ? { ...alert, acknowledgedAt } : alert,
          );
          return { ...prev, alerts: alerts ?? [] };
        });
        setUsageAlertNotice('Alert acknowledged.');
      } catch (err) {
        console.warn('[TenantDirectoryPanel] acknowledge alert failed', err);
        if (err instanceof ApiError) {
          setUsageAlertError(`Acknowledge failed (${err.status})`);
        } else if (err instanceof Error) {
          setUsageAlertError(err.message);
        } else {
          setUsageAlertError('Unable to acknowledge usage alert.');
        }
      } finally {
        setAcknowledgingAlertId(null);
      }
    },
    [inspectorTenant],
  );

  const selectedPlanId = useMemo(() => normalizePlanId(inspectorTenant?.billingTier), [inspectorTenant?.billingTier]);
  const selectedPlan = useMemo(() => getPlanLimits(selectedPlanId), [selectedPlanId]);
  const inspectorTenantId = inspectorTenant?.id;
  const planDisplay = usageSummary?.planLimits ?? selectedPlan;

  const handleStartCheckout = useCallback(async () => {
    if (!inspectorTenant) {
      return;
    }
    setCheckoutLoading(true);
    setCheckoutError(null);
    setCheckoutNotice(null);
    try {
      const checkoutPlanId = selectedPlanId === 'free' ? 'pro' : selectedPlanId;
      const response = await startBillingCheckout({
        tenantId: inspectorTenant.id,
        planId: checkoutPlanId,
        provider: 'razorpay',
        successUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
        cancelUrl: typeof window !== 'undefined' ? window.location.origin : undefined,
      });
      if (response?.checkoutUrl && typeof window !== 'undefined') {
        window.open(response.checkoutUrl, '_blank', 'noopener,noreferrer');
        setCheckoutNotice('Checkout session opened in a new tab.');
      } else {
        setCheckoutNotice('Checkout session recorded. Follow up with billing.');
      }
    } catch (err) {
      console.warn('[TenantDirectoryPanel] start checkout failed', err);
      if (err instanceof ApiError) {
        setCheckoutError(`Checkout failed (${err.status})`);
      } else if (err instanceof Error) {
        setCheckoutError(err.message);
      } else {
        setCheckoutError('Unable to start checkout.');
      }
    } finally {
      setCheckoutLoading(false);
    }
  }, [inspectorTenant, selectedPlanId]);

  useEffect(() => {
    if (!inspectorTenant) {
      setUsageSummary(null);
      setUsageError(null);
      setUsageLoading(false);
      setBillingSummary(null);
      setBillingError(null);
      setBillingLoading(false);
      setUsageAlertNotice(null);
      setUsageAlertError(null);
      setAcknowledgingAlertId(null);
      setCheckoutError(null);
      setCheckoutNotice(null);
      setCheckoutLoading(false);

      setBillingCatalogPlans(null);
      setBillingCatalogLoading(false);
      setBillingCatalogError(null);
      setBillingPlanVariantDraft('');
      setBillingPlanVariantNote('');
      setBillingPlanVariantSaving(false);
      setBillingPlanVariantError(null);
      setBillingPlanVariantSuccess(null);
    }
  }, [inspectorTenant]);

  useEffect(() => {
    if (!inspectorTenant) return;
    let cancelled = false;
    setBillingCatalogLoading(true);
    setBillingCatalogError(null);
    fetchBillingCatalogAdmin()
      .then((payload) => {
        if (cancelled) return;
        const plans = Array.isArray(payload?.plans) ? payload.plans : [];
        setBillingCatalogPlans(plans);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[TenantDirectoryPanel] billing catalog admin fetch failed', err);
        if (err instanceof ApiError) {
          setBillingCatalogError(`Billing catalog lookup failed (${err.status})`);
        } else if (err instanceof Error) {
          setBillingCatalogError(err.message);
        } else {
          setBillingCatalogError('Unable to load billing catalog.');
        }
      })
      .finally(() => {
        if (cancelled) return;
        setBillingCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectorTenant]);

  useEffect(() => {
    const currentVariantId = (billingSummary?.planVariantId || '').trim();
    const currentPlanId = billingSummary?.planId;
    setBillingPlanVariantDraft((prev) => {
      if (prev) return prev;
      return currentVariantId || currentPlanId || '';
    });
  }, [billingSummary?.planId, billingSummary?.planVariantId]);

  useEffect(() => {
    if (!inspectorTenantId) return;
    let cancelled = false;
    setUsageLoading(true);
    setUsageError(null);
    fetchUsageSummary({ tenantId: inspectorTenantId, planId: selectedPlanId })
      .then((summary) => {
        if (!cancelled) setUsageSummary(summary);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[TenantDirectoryPanel] usage summary fetch failed', err);
        if (err instanceof ApiError) {
          setUsageError(`Usage lookup failed (${err.status})`);
        } else if (err instanceof Error) {
          setUsageError(err.message);
        } else {
          setUsageError('Unable to load usage summary.');
        }
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectorTenantId, selectedPlanId]);

  useEffect(() => {
    setInvoiceFilters(DEFAULT_INVOICE_FILTERS);
    setBillingInvoices([]);
    setBillingInvoicesError(null);
    setBillingInvoicesTotal(null);
    setBillingInvoiceCursor(null);
    setBillingInvoiceCursorStack([]);
    setBillingInvoiceNextCursor(null);
    setInvoiceDownloadBusyId(null);
    setInvoiceDownloadBusyAction(null);
    setInvoiceDownloadError(null);
  }, [inspectorTenantId]);

  const normalizedInvoiceSearch = useMemo(() => invoiceFilters.search.trim().toLowerCase(), [invoiceFilters.search]);

  const loadBillingInvoicesPage = useCallback(async () => {
    if (!inspectorTenantId) return;
    setBillingInvoicesLoading(true);
    setBillingInvoicesError(null);
    try {
      const includeTotals = billingInvoiceCursor === null;
      const invoiceStatusRaw = invoiceFilters.status === 'all' ? undefined : invoiceFilters.status;
      // Defensive: if any stale UI state contains 'void', treat it as failed.
      const invoiceStatus = invoiceStatusRaw === ('void' as any) ? 'failed' : invoiceStatusRaw;
      const resp = await fetchBillingHistory({
        tenantId: inspectorTenantId,
        pageSize: billingInvoicePageSize,
        limitInvoices: billingInvoicePageSize,
        limitChanges: 0,
        includeTotals,
        invoiceStatus,
        cursorInvoiceAt: billingInvoiceCursor?.at,
        cursorInvoiceId: billingInvoiceCursor?.id,
      });

      setBillingInvoices(Array.isArray(resp?.invoices) ? resp.invoices : []);
      const nextCursor = resp?.pageInfo?.invoices?.nextCursor;
      setBillingInvoiceNextCursor(nextCursor && nextCursor.at && nextCursor.id ? nextCursor : null);
      const total = resp?.totals?.invoices;
      if (typeof total === 'number' && Number.isFinite(total)) {
        setBillingInvoicesTotal(Math.max(0, Math.trunc(total)));
      } else if (includeTotals) {
        setBillingInvoicesTotal(null);
      }
    } catch (err) {
      console.warn('[TenantDirectoryPanel] billing history fetch failed', err);
      if (err instanceof ApiError) {
        setBillingInvoicesError(`Billing history lookup failed (${err.status})`);
      } else if (err instanceof Error) {
        setBillingInvoicesError(err.message);
      } else {
        setBillingInvoicesError('Unable to load billing invoices.');
      }
      setBillingInvoices([]);
        setBillingInvoiceNextCursor(null);
    } finally {
      setBillingInvoicesLoading(false);
    }
  }, [billingInvoiceCursor, billingInvoicePageSize, inspectorTenantId, invoiceFilters.status]);

  useEffect(() => {
    void loadBillingInvoicesPage();
  }, [loadBillingInvoicesPage]);

  useEffect(() => {
    setBillingInvoiceCursor(null);
    setBillingInvoiceCursorStack([]);
    setBillingInvoiceNextCursor(null);
  }, [billingInvoicePageSize, invoiceFilters.status]);

  const filteredBillingInvoices = useMemo(() => {
    const source = billingInvoices || [];
    if (!normalizedInvoiceSearch) return source;
    return source.filter((invoice) => {
      const statusLabel = invoice.status === 'void' ? 'failed' : invoice.status;
      const haystack = [
        invoice.id,
        invoice.invoiceNumber,
        statusLabel,
        invoice.provider,
        String(invoice.amountInr ?? ''),
        invoice.issuedAt,
        invoice.dueAt,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedInvoiceSearch);
    });
  }, [billingInvoices, normalizedInvoiceSearch]);

  const canInvoicePrev = billingInvoiceCursorStack.length > 0;
  const canInvoiceNext = Boolean(billingInvoiceNextCursor);

  const handleInvoicePrev = useCallback(() => {
    setBillingInvoiceCursorStack((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      const cursor = next.pop() ?? null;
      setBillingInvoiceCursor(cursor);
      return next;
    });
  }, []);

  const handleInvoiceNext = useCallback(
    (nextCursor: BillingHistoryCursor | undefined) => {
      if (!nextCursor) return;
      setBillingInvoiceCursorStack((prev) => [...prev, billingInvoiceCursor]);
      setBillingInvoiceCursor(nextCursor);
    },
    [billingInvoiceCursor]
  );

  const handleInvoiceDownload = useCallback(
    async (invoice: BillingInvoiceRecord, options?: { force?: boolean }) => {
      if (!inspectorTenantId) return;
      setInvoiceDownloadError(null);
      setInvoiceDownloadBusyId(invoice.id);
      setInvoiceDownloadBusyAction(options?.force ? 'regenerate' : 'download');
      try {
        const blob = await fetchBillingInvoicePdf({
          tenantId: inspectorTenantId,
          invoiceId: invoice.id,
          force: options?.force === true,
        });
        if (!(blob instanceof Blob) || blob.size === 0) {
          setInvoiceDownloadError('Invoice download failed (empty response).');
          return;
        }

        const filenameBase = invoice.invoiceNumber || invoice.id;
        const filename = `${String(filenameBase).trim() || invoice.id}.pdf`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.warn('[TenantDirectoryPanel] invoice download failed', err);
        if (err instanceof ApiError) {
          setInvoiceDownloadError(`Invoice download failed (${err.status})`);
        } else if (err instanceof Error) {
          setInvoiceDownloadError(err.message);
        } else {
          setInvoiceDownloadError('Unable to generate invoice.');
        }
      } finally {
        setInvoiceDownloadBusyId((current) => (current === invoice.id ? null : current));
        setInvoiceDownloadBusyAction(null);
      }
    },
    [inspectorTenantId]
  );

  const handleBillingPlanVariantSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!inspectorTenant) return;
      const planVariantId = billingPlanVariantDraft.trim();
      if (!planVariantId) {
        setBillingPlanVariantError('Select a plan variant.');
        return;
      }

      setBillingPlanVariantSaving(true);
      setBillingPlanVariantError(null);
      setBillingPlanVariantSuccess(null);

      try {
        const response = await overrideTenantBillingPlanVariant({
          tenantId: inspectorTenant.id,
          planVariantId,
          note: billingPlanVariantNote.trim() || undefined,
        });
        setBillingPlanVariantSuccess('Plan updated successfully.');
        setBillingPlanVariantNote('');
        setInspectorTenant(response.tenant);
        setResults((prev) => prev.map((tenant) => (tenant.id === response.tenant.id ? response.tenant : tenant)));
      } catch (err) {
        console.warn('[TenantDirectoryPanel] billing plan override failed', err);
        if (err instanceof ApiError) {
          setBillingPlanVariantError(`Plan update failed (${err.status})`);
        } else if (err instanceof Error) {
          setBillingPlanVariantError(err.message);
        } else {
          setBillingPlanVariantError('Unable to update tenant plan.');
        }
      } finally {
        setBillingPlanVariantSaving(false);
      }
    },
    [billingPlanVariantDraft, billingPlanVariantNote, inspectorTenant, setResults],
  );

  useEffect(() => {
    if (!inspectorTenantId) return;
    let cancelled = false;
    setBillingLoading(true);
    setBillingError(null);
    fetchBillingSummary({ tenantId: inspectorTenantId, planId: selectedPlanId })
      .then((summary) => {
        if (!cancelled) setBillingSummary(summary);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[TenantDirectoryPanel] billing summary fetch failed', err);
        if (err instanceof ApiError) {
          setBillingError(`Billing lookup failed (${err.status})`);
        } else if (err instanceof Error) {
          setBillingError(err.message);
        } else {
          setBillingError('Unable to load billing summary.');
        }
      })
      .finally(() => {
        if (!cancelled) setBillingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectorTenantId, selectedPlanId]);

  const usageRows = useMemo(() => {
    if (!inspectorTenant) return [];
    const planLimits = usageSummary?.planLimits ?? selectedPlan;
    const statusMap = usageSummary?.statuses;
    const studentsUsed = usageSummary?.students ?? inspectorTenant.membershipCounts?.total ?? 0;
    const staffUsed = usageSummary?.staff ?? inspectorTenant.membershipCounts?.staff ?? 0;
    const remindersUsed = usageSummary?.reminders?.total ?? 0;
    const storageUsed = usageSummary?.storageBytes ?? 0;
    const reminderBreakdown = usageSummary?.reminders;
    const reminderParts: string[] = [];
    if (reminderBreakdown) {
      reminderParts.push(`WA ${formatNumber(reminderBreakdown.whatsapp)}`);
      reminderParts.push(`SMS ${formatNumber(reminderBreakdown.sms)}`);
      reminderParts.push(`Email ${formatNumber(reminderBreakdown.email)}`);
      if ((reminderBreakdown.voice ?? 0) > 0) {
        reminderParts.push(`Voice ${formatNumber(reminderBreakdown.voice ?? 0)}`);
      }
      if ((reminderBreakdown.other ?? 0) > 0) {
        reminderParts.push(`Other ${formatNumber(reminderBreakdown.other ?? 0)}`);
      }
    }
    const studentsAdded = usageSummary?.studentsAdded ?? 0;

    const rows: Array<{
      key: UsageMetricKey;
      label: string;
      used: number;
      limit: number;
      detail: string;
      extra?: string;
    }> = [
      {
        key: 'students',
        label: 'Students',
        used: studentsUsed,
        limit: planLimits.students,
        detail: `${formatNumber(studentsUsed)} of ${formatNumber(planLimits.students)} students` +
          (studentsAdded > 0 ? ` · ${formatNumber(studentsAdded)} added this month` : ''),
      },
      {
        key: 'staff',
        label: 'Staff seats',
        used: staffUsed,
        limit: planLimits.staffSeats,
        detail: `${formatNumber(staffUsed)} of ${formatNumber(planLimits.staffSeats)} seats`,
      },
      {
        key: 'reminders',
        label: 'Monthly reminders',
        used: remindersUsed,
        limit: planLimits.reminders.total,
        detail: `${formatNumber(remindersUsed)} of ${formatNumber(planLimits.reminders.total)} messages`,
        extra: reminderParts.length ? reminderParts.join(' · ') : undefined,
      },
      {
        key: 'storage',
        label: 'Storage',
        used: storageUsed,
        limit: planLimits.storageBytes,
        detail: `${formatStorage(storageUsed)} of ${formatStorage(planLimits.storageBytes)}`,
      },
    ];

    return rows.map((row) => {
      const metricStatus = statusMap?.[row.key];
      const percent = metricStatus ? metricStatus.percentage : getUsagePercentage(row.used, row.limit);
      const status = metricStatus ? metricStatus.status : getUsageStatus(row.used, row.limit);
      return {
        ...row,
        percent,
        status,
      };
    });
  }, [inspectorTenant, selectedPlan, usageSummary]);

  return (
    <SectionCard
      title="Tenant Directory"
      description="Search tenants by ID, slug, join code, or member email to view quotas and contact metadata."
    >
      <form
        className="tenant-search-form"
        onSubmit={
          inspectorTenantIdFromUrl
            ? (event) => {
                event.preventDefault();
              }
            : handleSubmit
        }
      >
        <label>
          Lookup token
          <div className="tenant-search-input">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => {
                if (inspectorTenantIdFromUrl) return;
                setQuery(event.target.value);
              }}
              placeholder="tenant_abc123, slug, join code, or email"
              disabled={loading || Boolean(inspectorTenantIdFromUrl)}
            />
          </div>
        </label>
        {!inspectorTenantIdFromUrl && (
          <>
            <div className="tenant-search-actions">
              <button className="primary-button" type="submit" disabled={loading}>
                {loading ? 'Searching…' : 'Search'}
              </button>
              <button type="button" className="text-button" onClick={handleReset} disabled={loading || !query}>
                <RefreshCcw size={14} /> Reset
              </button>
            </div>
            <p className="muted" style={{ margin: '0.4rem 0 0' }}>
              {diagnosticsSummary || 'Tip: You can paste any tenant join code or member email to locate their workspace.'}
            </p>
          </>
        )}
      </form>
      {error && (
        <div className="tenant-error">
          <strong>Lookup failed:</strong> {error}
        </div>
      )}
      <div className="tenant-meta-row">
        <span className="muted">
          {activeQuery ? `Results for “${activeQuery}”` : 'Latest tenants'} · {visibleResults.length} shown (limit {DEFAULT_LIMIT})
        </span>
        {lastUpdated && (
          <span className="muted">Updated {new Date(lastUpdated).toLocaleTimeString()}</span>
        )}
      </div>
      {visibleResults.length === 0 && !loading && !error ? (
        <p className="muted">No tenants matched that query.</p>
      ) : null}
      {visibleResults.length > 0 && (
        <div className="tenant-table-wrapper">
          <table className="table tenant-table">
            <thead>
              <tr>
                <th style={{ width: '30%' }}>Tenant</th>
                <th style={{ width: '28%' }}>Seats & quotas</th>
                <th style={{ width: '22%' }}>Contacts</th>
                <th style={{ width: '20%' }}>Activity</th>
              </tr>
            </thead>
            <tbody>
              {visibleResults.map((tenant) => {
                const status = (tenant.status || 'unknown').toLowerCase();
                const statusClass = status === 'active' ? 'online' : 'offline';
                const copied = copiedValue === tenant.id;
                const tenantLogo = tenant.branding?.logoUrl || tenant.logoUrl || null;
                const tenantInitial = (tenant.name || tenant.slug || tenant.id || 'C').trim().charAt(0).toUpperCase() || 'C';
                return (
                  <tr key={tenant.id}>
                    <td>
                      <div className="tenant-name-block">
                        <div className="tenant-name-meta">
                          <div className="tenant-logo-frame" aria-hidden={!tenantLogo}>
                            {tenantLogo ? (
                              <img
                                src={tenantLogo}
                                alt={`${tenant.name || tenant.slug || 'Tenant'} logo`}
                                loading="lazy"
                              />
                            ) : (
                              <div className="tenant-logo-fallback">
                                {tenantInitial}
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="tenant-name-heading">
                              <Building2 size={16} />
                              <strong>{tenant.name || 'Unnamed tenant'}</strong>
                              <span className={`badge ${statusClass}`}>{status}</span>
                            </div>
                            <p className="muted small-text">ID: {tenant.id}</p>
                            {tenant.slug && <p className="muted small-text">Slug: {tenant.slug}</p>}
                            {tenant.code && <p className="muted small-text">Code: {tenant.code}</p>}
                            <p className="muted small-text">Tier: {tenant.billingTier || 'free'}</p>
                          </div>
                        </div>
                        <div className="tenant-row-actions">
                          <button type="button" className="text-button" onClick={() => handleCopy(tenant.id)}>
                            <Copy size={14} /> {copied ? 'Copied' : 'Copy ID'}
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => handleOpenInspectorInNewTab(tenant.id)}
                            disabled={membershipLoading && inspectorTenant?.id === tenant.id}
                          >
                            <Search size={14} />{' '}
                            {inspectorTenant?.id === tenant.id
                              ? membershipLoading
                                ? 'Loading…'
                                : 'Inspecting'
                              : 'Inspect members'}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td>
                      <ul className="tenant-seat-list">
                        {seatLines(tenant).map((line) => (
                          <li key={`${tenant.id}-${line.label}`}>
                            <span>{line.label}</span>
                            <span className="muted small-text">{line.value}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <p>{tenant.ownerEmail || '—'}</p>
                      {tenant.contactEmail && (
                        <p className="muted small-text">Contact: {tenant.contactEmail}</p>
                      )}
                      {tenant.contactPhone && (
                        <p className="muted small-text">Phone: {tenant.contactPhone}</p>
                      )}
                      {tenant.flags && (
                        <p className="muted small-text">
                          Join requests: {tenant.flags.allowJoinRequests === false ? 'disabled' : 'enabled'}
                        </p>
                      )}
                    </td>
                    <td>
                      <p className="muted small-text">
                        Updated {tenant.updatedAt ? new Date(tenant.updatedAt).toLocaleString() : '—'}
                      </p>
                      <p className="muted small-text">
                        Created {tenant.createdAt ? new Date(tenant.createdAt).toLocaleDateString() : '—'}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {inspectorTenant && (
        <div className="tenant-membership-panel">
          <div className="tenant-membership-header">
            <div>
              <h3>Membership inspector</h3>
              <p className="muted small-text">
                {inspectorTenant.name || inspectorTenant.id} · {membershipHeadline || 'Loading…'}
              </p>
              {membershipStatusLine && (
                <p className="muted small-text">Filtered status · {membershipStatusLine}</p>
              )}
              {membershipSnapshotLine && (
                <p className="muted small-text">Snapshot · {membershipSnapshotLine}</p>
              )}
            </div>
            <div className="tenant-membership-actions">
              <button
                type="button"
                className="text-button"
                onClick={handleExportMemberships}
                disabled={membershipLoading || membershipRows.length === 0}
              >
                <Download size={14} /> Export CSV
              </button>
              <button
                type="button"
                className="text-button"
                onClick={handleMembershipRefresh}
                disabled={membershipLoading}
              >
                <RefreshCcw size={14} /> Refresh
              </button>
              <button type="button" className="text-button" onClick={handleCloseInspector}>
                <X size={14} /> Close
              </button>
            </div>
          </div>
          <div className="tenant-plan-card tenant-quota-card">
            <div className="tenant-plan-header">
              <div>
                <h4>Plan usage</h4>
                <p className="muted small-text">
                  {planDisplay.label} plan · {formatInr(planDisplay.monthlyPriceInr)} per month
                </p>
                <p className="muted small-text">
                  Includes {formatNumber(planDisplay.staffSeats)} staff seats · {formatNumber(planDisplay.students)} students ·{' '}
                  {formatNumber(planDisplay.reminders.total)} reminders · {formatStorage(planDisplay.storageBytes)} storage
                </p>
              </div>
            </div>
            {usageError && (
              <div className="tenant-error">
                <strong>Usage issue:</strong> {usageError}
              </div>
            )}
            {usageAlertError && (
              <div className="tenant-error">
                <strong>Alert action:</strong> {usageAlertError}
              </div>
            )}
            {usageAlertNotice && (
              <div className="tenant-success">
                <strong>Alert update:</strong> {usageAlertNotice}
              </div>
            )}
            {usageLoading && <p className="muted small-text">Loading usage snapshot…</p>}
            {!usageLoading && (
              <ul className="tenant-seat-list tenant-plan-usage">
                {usageRows.map((row) => (
                  <li key={row.label}>
                    <div>
                      <strong>{row.label}</strong>
                      <p className="muted small-text">{row.detail}</p>
                      {row.extra && <p className="muted small-text">{row.extra}</p>}
                    </div>
                    <div className="tenant-plan-usage-meter">
                      <span className={usageBadgeClass(row.status)}>
                        {row.percent}%{row.status !== 'ok' ? ` · ${row.status}` : ''}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {usageSummary?.alerts && usageSummary.alerts.length > 0 && (
              <div className="tenant-plan-alerts">
                <p className="muted small-text">Alerts</p>
                <ul>
                  {usageSummary.alerts.map((alert) => {
                    const alertValue = formatUsageMetricValue(alert.metric, alert.value);
                    const alertLimit = formatUsageMetricValue(alert.metric, alert.limit);
                    const ratioPercent = Number.isFinite(alert.ratio)
                      ? Math.round((alert.ratio ?? 0) * 100)
                      : typeof alert.value === 'number' && typeof alert.limit === 'number' && alert.limit > 0
                        ? Math.round((alert.value / alert.limit) * 100)
                        : null;
                    return (
                      <li key={alert.id} className={`muted small-text ${alert.type}`}>
                        <div>
                          {alert.metric}: {alert.type} · {alert.details || 'Needs attention'}
                          {alertValue && alertLimit && (
                            <span>
                              {' '}
                              · {alertValue} / {alertLimit}
                            </span>
                          )}
                          {ratioPercent !== null && Number.isFinite(ratioPercent) && (
                            <span>
                              {' '}
                              · {ratioPercent}%
                            </span>
                          )}
                          {alert.acknowledgedAt && (
                            <span>
                              {' '}
                              · Ack {new Date(alert.acknowledgedAt).toLocaleString()}
                            </span>
                          )}
                        </div>
                        {!alert.acknowledgedAt && (
                          <div className="tenant-membership-actions-inline">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => handleAcknowledgeAlert(alert.id)}
                              disabled={acknowledgingAlertId === alert.id}
                            >
                              {acknowledgingAlertId === alert.id ? 'Acknowledging…' : 'Acknowledge'}
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {usageSummary?.storageSources?.length ? (
              <div className="tenant-plan-alerts">
                <p className="muted small-text">Storage sources</p>
                <ul>
                  {usageSummary.storageSources.map((source) => (
                    <li key={source.label} className="muted small-text">
                      {source.label}: {formatStorage(source.bytes)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {usageSummary?.diagnostics?.warnings?.length ? (
              <div className="tenant-plan-alerts">
                <p className="muted small-text">Diagnostics</p>
                <ul>
                  {usageSummary.diagnostics.warnings.map((warning, index) => (
                    <li key={warning || index} className="muted small-text warning">
                      {warning}
                    </li>
                  ))}
                </ul>
                {usageSummary.diagnostics.generatedAt && (
                  <p className="muted small-text">
                    Generated {new Date(usageSummary.diagnostics.generatedAt).toLocaleString()}
                  </p>
                )}
              </div>
            ) : null}
            {usageSummary?.lastRefreshedAt && (
              <p className="muted small-text">
                Last refreshed {new Date(usageSummary.lastRefreshedAt).toLocaleString()}
              </p>
            )}
          </div>
          <div className="tenant-plan-card tenant-quota-card">
            <div className="tenant-plan-header">
              <div>
                <h4>Billing</h4>
                <p className="muted small-text">
                  Status: {billingSummary?.status || 'unknown'}{' '}
                  {billingSummary?.renewalDate && `· Renews ${new Date(billingSummary.renewalDate).toLocaleDateString()}`}
                </p>
                {billingSummary?.planVariantId ? (
                  <p className="muted small-text">
                    Variant: {(() => {
                      const match = (billingCatalogPlans || []).find((plan) => plan.id === billingSummary.planVariantId);
                      if (match) {
                        return `${match.displayName} (${match.id})`;
                      }
                      return billingSummary.planVariantId;
                    })()}
                  </p>
                ) : null}
              </div>
              <div className="tenant-membership-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={handleStartCheckout}
                  disabled={checkoutLoading || !inspectorTenant}
                >
                  {checkoutLoading ? 'Starting…' : 'Start checkout'}
                </button>
              </div>
            </div>
            <div style={{ paddingTop: '0.6rem' }}>
              {billingCatalogError && (
                <p className="muted small-text">Catalog: {billingCatalogError}</p>
              )}
              <form className="tenant-membership-filters" onSubmit={handleBillingPlanVariantSubmit}>
                <label>
                  Assign plan variant
                  <select
                    value={billingPlanVariantDraft}
                    onChange={(event) => setBillingPlanVariantDraft(event.target.value)}
                    disabled={billingPlanVariantSaving || billingCatalogLoading}
                  >
                    <option value="">Select…</option>
                    {billingPlanOptions
                      .slice()
                      .sort((a, b) => (a.planId || '').localeCompare(b.planId || '') || (a.sortOrder || 0) - (b.sortOrder || 0))
                      .map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {plan.displayName} · {plan.planId} · {plan.id === CUSTOM_ENTERPRISE_VARIANT_ID ? 'Custom pricing' : formatInr(plan.priceInr)}{plan.active ? '' : ' (inactive)'}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Operator note
                  <input
                    value={billingPlanVariantNote}
                    onChange={(event) => setBillingPlanVariantNote(event.target.value)}
                    placeholder="Optional context to store in audit log"
                    disabled={billingPlanVariantSaving}
                  />
                </label>
                <div className="tenant-membership-filter-actions">
                  <button className="primary-button" type="submit" disabled={billingPlanVariantSaving || billingCatalogLoading}>
                    {billingPlanVariantSaving ? 'Saving…' : 'Assign plan'}
                  </button>
                </div>
              </form>
              {billingPlanVariantError && (
                <div className="tenant-error">
                  <strong>Plan update:</strong> {billingPlanVariantError}
                </div>
              )}
              {billingPlanVariantSuccess && (
                <div className="tenant-success">
                  <strong>Plan update:</strong> {billingPlanVariantSuccess}
                </div>
              )}
              <p className="muted small-text" style={{ marginTop: '0.5rem' }}>
                Assigning a plan variant is an operator action and does not charge the tenant.
              </p>
            </div>
            {billingError && (
              <div className="tenant-error">
                <strong>Billing issue:</strong> {billingError}
              </div>
            )}
            {checkoutError && (
              <div className="tenant-error">
                <strong>Checkout issue:</strong> {checkoutError}
              </div>
            )}
            {checkoutNotice && (
              <div className="tenant-success">
                <strong>Checkout update:</strong> {checkoutNotice}
              </div>
            )}
            {billingLoading && <p className="muted small-text">Loading billing snapshot…</p>}
            {!billingLoading && (
              <>
                {billingSummary?.checkoutRequired && (
                  <p className="muted small-text">Checkout session required before plan activation.</p>
                )}

                {isCustomEnterpriseCurrent ? (
                  <div className="tenant-quota-card" style={{ marginTop: '0.75rem' }}>
                    <div className="tenant-quota-header">
                      <div>
                        <h4>Quota overrides</h4>
                        <p className="muted small-text">
                          Adjust tenant quotas. Leave blank to keep the existing value or type “unlimited” to remove the cap.
                        </p>
                      </div>
                      <div className="tenant-membership-actions">
                        <button type="button" className="text-button" onClick={handleQuotaReset} disabled={quotaSaving}>
                          <RefreshCcw size={14} /> Clear
                        </button>
                      </div>
                    </div>
                    {quotaError && (
                      <div className="tenant-error">
                        <strong>Quota issue:</strong> {quotaError}
                      </div>
                    )}
                    {quotaSuccess && (
                      <div className="tenant-success">
                        <strong>Quota update:</strong> {quotaSuccess}
                      </div>
                    )}
                    <form className="tenant-quota-grid" onSubmit={handleQuotaSubmit}>
                      {QUOTA_FIELDS.map((field) => (
                        <label key={field.key}>
                          {field.label}
                          <input
                            value={quotaForm[field.key]}
                            onChange={(event) => handleQuotaFieldChange(field.key, event.target.value)}
                            placeholder={quotaPlaceholderFor(field.key)}
                            disabled={quotaSaving}
                          />
                          <span className="muted small-text">{field.helper}</span>
                        </label>
                      ))}
                      <label style={{ gridColumn: '1 / -1' }}>
                        Operator note
                        <input
                          value={quotaForm.note}
                          onChange={(event) =>
                            setQuotaForm((prev) => ({
                              ...prev,
                              note: event.target.value,
                            }))
                          }
                          placeholder="Optional context to store in audit log"
                          disabled={quotaSaving}
                        />
                      </label>
                      <div className="tenant-membership-filter-actions" style={{ gridColumn: '1 / -1' }}>
                        <button className="primary-button" type="submit" disabled={quotaSaving}>
                          {quotaSaving ? 'Saving…' : 'Save overrides'}
                        </button>
                        <button type="button" className="text-button" onClick={handleQuotaReset} disabled={quotaSaving}>
                          <RefreshCcw size={14} /> Reset
                        </button>
                      </div>
                    </form>
                  </div>
                ) : (
                  <div className="tenant-quota-card" style={{ marginTop: '0.75rem' }}>
                    <div className="tenant-quota-header">
                      <div>
                        <h4>Quota overrides</h4>
                        <p className="muted small-text">
                          Quota overrides are only available for the “Custom (Enterprise)” plan.
                          {isCustomEnterpriseDraft
                            ? ' Click “Assign plan variant” to apply it, then customize limits.'
                            : ' Select it in Billing → Assign plan variant to customize limits.'}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                <div style={{ paddingTop: '0.75rem' }}>
                  <p className="muted small-text">Payments</p>
                  <form className="tenant-membership-filters" onSubmit={(event) => event.preventDefault()}>
                    <label>
                      Status
                      <select
                        value={invoiceFilters.status}
                        onChange={(event) => setInvoiceFilters((prev) => ({ ...prev, status: event.target.value as any }))}
                        disabled={billingInvoicesLoading}
                      >
                        <option value="all">All</option>
                        <option value="paid">Paid</option>
                        <option value="open">Open</option>
                        <option value="failed">Failed</option>
                        <option value="uncollectible">Uncollectible</option>
                      </select>
                    </label>
                    <label>
                      Search
                      <input
                        value={invoiceFilters.search}
                        onChange={(event) => setInvoiceFilters((prev) => ({ ...prev, search: event.target.value }))}
                        placeholder="Search id, amount, provider"
                      />
                    </label>
                    <label>
                      Page size
                      <select
                        value={billingInvoicePageSize}
                        onChange={(event) => setBillingInvoicePageSize(Number(event.target.value) as 10 | 25 | 50)}
                        disabled={billingInvoicesLoading}
                      >
                        <option value={10}>10</option>
                        <option value={25}>25</option>
                        <option value={50}>50</option>
                      </select>
                    </label>
                  </form>

                  {invoiceDownloadError && (
                    <div className="tenant-error">
                      <strong>Invoice:</strong> {invoiceDownloadError}
                    </div>
                  )}
                  {billingInvoicesError && (
                    <div className="tenant-error">
                      <strong>Billing history:</strong> {billingInvoicesError}
                    </div>
                  )}

                  {billingInvoicesLoading ? <p className="muted small-text">Loading payments…</p> : null}

                  {filteredBillingInvoices.length ? (
                    <>
                      <p className="muted small-text">
                        Showing {filteredBillingInvoices.length}
                        {billingInvoicesTotal !== null ? ` / ${billingInvoicesTotal}` : ''}
                      </p>
                      <ul className="tenant-seat-list">
                        {filteredBillingInvoices.map((invoice) => (
                          <li key={invoice.id}>
                            <div>
                              <strong>{formatInr(invoice.amountInr)}</strong>
                              <p className="muted small-text">
                                {(invoice.status === 'void' ? 'failed' : invoice.status)} · Issued {invoice.issuedAt ? new Date(invoice.issuedAt).toLocaleDateString() : '—'}
                              </p>
                              {invoice.invoiceNumber ? <p className="muted small-text">Invoice #: {invoice.invoiceNumber}</p> : null}
                              <p className="muted small-text">ID: {invoice.id}</p>
                            </div>
                            <div className="tenant-row-actions">
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => handleInvoiceDownload(invoice)}
                                disabled={invoiceDownloadBusyId === invoice.id}
                              >
                                {invoiceDownloadBusyId === invoice.id && invoiceDownloadBusyAction === 'download'
                                  ? 'Downloading…'
                                  : 'Download'}
                              </button>

                              {invoice.downloadUrl ? (
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() => handleInvoiceDownload(invoice, { force: true })}
                                  disabled={invoiceDownloadBusyId === invoice.id}
                                >
                                  {invoiceDownloadBusyId === invoice.id && invoiceDownloadBusyAction === 'regenerate'
                                    ? 'Regenerating…'
                                    : 'Regenerate'}
                                </button>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                      <div className="tenant-membership-actions-inline">
                        <button
                          type="button"
                          className="text-button"
                          onClick={handleInvoicePrev}
                          disabled={!canInvoicePrev || billingInvoicesLoading}
                        >
                          Prev
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => handleInvoiceNext(billingInvoiceNextCursor ?? undefined)}
                          disabled={!canInvoiceNext || billingInvoicesLoading}
                        >
                          Next
                        </button>
                      </div>
                    </>
                  ) : billingInvoicesLoading ? null : (
                    <p className="muted small-text">No payments found.</p>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="tenant-quota-card">
            <div className="tenant-quota-header">
              <div>
                <h4>Reminder channels</h4>
                <p className="muted small-text">
                  Toggle which reminder channels are available in the mobile app for this tenant.
                  Disabled channels will be blocked server-side.
                </p>
              </div>
              <div className="tenant-membership-actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={handleReminderSettingsReload}
                  disabled={reminderSettingsLoading || reminderSettingsSaving || !inspectorTenant}
                >
                  <RefreshCcw size={14} /> Reload
                </button>
              </div>
            </div>

            {reminderSettingsError && (
              <div className="tenant-error">
                <strong>Reminder settings:</strong> {reminderSettingsError}
              </div>
            )}
            {reminderSettingsSuccess && (
              <div className="tenant-success">
                <strong>Reminder settings:</strong> {reminderSettingsSuccess}
              </div>
            )}
            {reminderSettingsLoading && <p className="muted small-text">Loading reminder settings…</p>}

            <form
              className="tenant-quota-grid"
              onSubmit={(e) => {
                e.preventDefault();
                void handleReminderSettingsSave();
              }}
            >
              <label style={{ gridColumn: '1 / -1' }}>
                Hide disabled reminder types in app
                <div className="muted small-text">
                  Default is “inherit global”. Disabled channels are blocked server-side either way.
                </div>
                <select
                  value={
                    reminderHideDisabledDraft === undefined
                      ? 'inherit'
                      : reminderHideDisabledDraft
                        ? 'hide'
                        : 'show'
                  }
                  onChange={(event) =>
                    handleReminderHideDisabledModeChange(event.target.value as 'inherit' | 'show' | 'hide')
                  }
                  disabled={reminderSettingsSaving || reminderSettingsLoading}
                  style={{ width: '100%', marginTop: '0.35rem' }}
                >
                  <option value="inherit">Inherit global setting</option>
                  <option value="show">Show disabled (recommended)</option>
                  <option value="hide">Hide disabled</option>
                </select>
              </label>

              <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={reminderEnabledDraft.email}
                  onChange={() => handleReminderEnabledToggle('email')}
                  disabled={reminderSettingsSaving || reminderSettingsLoading}
                />
                <span>
                  Email
                  <div className="muted small-text">Enable email reminders</div>
                  <div className="muted small-text" style={{ marginTop: '0.25rem' }}>Disabled message (optional)</div>
                  <input
                    value={reminderMessageDraft.email}
                    onChange={(event) => handleReminderMessageChange('email', event.target.value)}
                    placeholder="Shown in the app when Email is disabled"
                    disabled={reminderSettingsSaving || reminderSettingsLoading}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </span>
              </label>

              <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={reminderEnabledDraft.sms}
                  onChange={() => handleReminderEnabledToggle('sms')}
                  disabled={reminderSettingsSaving || reminderSettingsLoading}
                />
                <span>
                  SMS
                  <div className="muted small-text">Enable SMS reminders</div>
                  <div className="muted small-text" style={{ marginTop: '0.25rem' }}>Disabled message (optional)</div>
                  <input
                    value={reminderMessageDraft.sms}
                    onChange={(event) => handleReminderMessageChange('sms', event.target.value)}
                    placeholder="Shown in the app when SMS is disabled"
                    disabled={reminderSettingsSaving || reminderSettingsLoading}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </span>
              </label>

              <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={reminderEnabledDraft.whatsapp}
                  onChange={() => handleReminderEnabledToggle('whatsapp')}
                  disabled={reminderSettingsSaving || reminderSettingsLoading}
                />
                <span>
                  WhatsApp
                  <div className="muted small-text">Enable WhatsApp reminders</div>
                  <div className="muted small-text" style={{ marginTop: '0.25rem' }}>Disabled message (optional)</div>
                  <input
                    value={reminderMessageDraft.whatsapp}
                    onChange={(event) => handleReminderMessageChange('whatsapp', event.target.value)}
                    placeholder="Shown in the app when WhatsApp is disabled"
                    disabled={reminderSettingsSaving || reminderSettingsLoading}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </span>
              </label>

              <label style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={reminderEnabledDraft.voice}
                  onChange={() => handleReminderEnabledToggle('voice')}
                  disabled={reminderSettingsSaving || reminderSettingsLoading}
                />
                <span>
                  Voice
                  <div className="muted small-text">Enable voice call reminders</div>
                  <div className="muted small-text" style={{ marginTop: '0.25rem' }}>Disabled message (optional)</div>
                  <input
                    value={reminderMessageDraft.voice}
                    onChange={(event) => handleReminderMessageChange('voice', event.target.value)}
                    placeholder="Shown in the app when Voice is disabled"
                    disabled={reminderSettingsSaving || reminderSettingsLoading}
                    style={{ width: '100%', marginTop: '0.25rem' }}
                  />
                </span>
              </label>

              <div className="tenant-membership-filter-actions" style={{ gridColumn: '1 / -1' }}>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={reminderSettingsSaving || reminderSettingsLoading || !reminderSettingsDirty}
                >
                  {reminderSettingsSaving ? 'Saving…' : reminderSettingsDirty ? 'Save changes' : 'Saved'}
                </button>
              </div>
            </form>
          </div>

          <form className="tenant-membership-filters" onSubmit={handleMembershipSubmit}>
            <label>
              Search
              <input
                value={membershipFilters.search}
                onChange={(event) =>
                  setMembershipFilters((prev) => ({
                    ...prev,
                    search: event.target.value,
                  }))
                }
                placeholder="Email, display name, or UID"
                disabled={membershipLoading}
              />
            </label>
            <label>
              Status
              <select
                value={membershipFilters.status}
                onChange={(event) =>
                  setMembershipFilters((prev) => ({
                    ...prev,
                    status: event.target.value || 'all',
                  }))
                }
                disabled={membershipLoading}
              >
                <option value="all">All statuses</option>
                <option value="active">Active</option>
                <option value="pending">Pending</option>
                <option value="suspended">Suspended</option>
              </select>
            </label>
            <label>
              Role
              <select
                value={membershipFilters.role}
                onChange={(event) =>
                  setMembershipFilters((prev) => ({
                    ...prev,
                    role: event.target.value as MembershipFilters['role'],
                  }))
                }
                disabled={membershipLoading}
              >
                <option value="all">All roles</option>
                <option value="owner">Owners</option>
                <option value="admin">Admins</option>
                <option value="staff">Staff</option>
                <option value="member">Members</option>
              </select>
            </label>
            <label>
              Show devices
              <input
                type="checkbox"
                checked={showMemberDevices}
                onChange={(event) => setShowMemberDevices(event.target.checked)}
                disabled={membershipLoading}
              />
              <span className="muted small-text">Loads devices per member on demand.</span>
            </label>
            <div className="tenant-membership-filter-actions">
              <button className="primary-button" type="submit" disabled={membershipLoading}>
                {membershipLoading ? 'Filtering…' : 'Apply filters'}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={handleMembershipReset}
                disabled={membershipLoading}
              >
                <RefreshCcw size={14} /> Reset
              </button>
            </div>
          </form>
          {membershipError && (
            <div className="tenant-error">
              <strong>Lookup failed:</strong> {membershipError}
            </div>
          )}
          {membershipRoleError && (
            <div className="tenant-error">
              <strong>Role update:</strong> {membershipRoleError}
            </div>
          )}
          {membershipRoleNotice && (
            <div className="tenant-success">
              <strong>Role update:</strong> {membershipRoleNotice}
            </div>
          )}
          {membershipLoading && (
            <p className="muted small-text">Loading memberships…</p>
          )}
          {!membershipLoading && !membershipError && membershipRows.length === 0 && (
            <p className="muted">No members found for those filters.</p>
          )}
          {membershipRows.length > 0 && (
            <div className="tenant-membership-table-wrapper">
              <table className="table tenant-membership-table">
                <thead>
                  <tr>
                    <th style={{ width: '32%' }}>Member</th>
                    <th style={{ width: '20%' }}>Role & status</th>
                    <th style={{ width: '24%' }}>Timeline</th>
                    <th style={{ width: '24%' }}>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {membershipRows.map((member) => {
                    const roleLabel = (member.role || 'member').toLowerCase();
                    const statusLabel = (member.status || 'unknown').toLowerCase();
                    const badgeClass = statusLabel === 'active' ? 'online' : 'offline';
                    const emailKey = member.email ? normalizeEmailKey(member.email) : null;
                    const isDevicesExpanded = emailKey ? Boolean(memberDeviceExpandedByEmail[emailKey]) : false;
                    const devicePanel = emailKey ? memberDevicesByEmail[emailKey] : null;
                    return (
                      <>
                        <tr key={member.id}>
                          <td>
                            <strong>{member.displayName || member.email || 'Unnamed member'}</strong>
                            {member.email && <p className="muted small-text">{member.email}</p>}
                            {member.userId && <p className="muted small-text">UID: {member.userId}</p>}
                            <p className="muted small-text">Membership ID: {member.id}</p>
                            <div className="tenant-membership-actions-inline">
                              {member.email && (
                                <button type="button" className="text-button" onClick={() => handleCopy(member.email!)}>
                                  <Copy size={14} /> {copiedValue === member.email ? 'Copied' : 'Copy email'}
                                </button>
                              )}
                              <button type="button" className="text-button" onClick={() => handleCopy(member.id)}>
                                <Copy size={14} /> {copiedValue === member.id ? 'Copied' : 'Copy ID'}
                              </button>
                              {showMemberDevices && (
                                <>
                                  {member.email ? (
                                    <button
                                      type="button"
                                      className="text-button"
                                      onClick={() => handleToggleMemberDevices(member)}
                                      disabled={membershipLoading}
                                    >
                                      {devicePanel?.loading
                                        ? 'Loading devices…'
                                        : isDevicesExpanded
                                          ? 'Hide devices'
                                          : 'Show devices'}
                                    </button>
                                  ) : (
                                    <span className="muted small-text">No email (devices unavailable).</span>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                          <td>
                            <p className="muted small-text">Role: {roleLabel}</p>
                            <p className="muted small-text">
                              Status: <span className={`badge ${badgeClass}`}>{statusLabel}</span>
                            </p>
                            {member.joinedVia && <p className="muted small-text">Joined via: {member.joinedVia}</p>}
                            <div className="tenant-membership-actions-inline" style={{ marginTop: 8 }}>
                              <select
                                value={resolveMembershipRoleDraft(member)}
                                onChange={(event) =>
                                  handleMembershipRoleDraftChange(member.id, event.target.value as TenantMembershipRole)
                                }
                                disabled={membershipLoading || membershipRoleSavingId !== null || !member.userId}
                                aria-label="Edit member role"
                              >
                                <option value="owner">owner</option>
                                <option value="admin">admin</option>
                                <option value="staff">staff</option>
                                <option value="member">member</option>
                              </select>
                              <button
                                type="button"
                                className="text-button"
                                onClick={() => void handleSaveMembershipRole(member)}
                                disabled={membershipLoading || membershipRoleSavingId !== null || !member.userId}
                              >
                                {membershipRoleSavingId === member.id ? 'Saving…' : 'Save role'}
                              </button>
                            </div>
                            {!member.userId && (
                              <p className="muted small-text">Role edit unavailable (no user id).</p>
                            )}
                          </td>
                          <td>
                            <p className="muted small-text">Created {formatDateTime(member.createdAt)}</p>
                            <p className="muted small-text">Updated {formatDateTime(member.updatedAt)}</p>
                            <p className="muted small-text">Last activity {formatDateTime(member.lastActivityAt)}</p>
                          </td>
                          <td>
                            {member.joinCodeId && <p className="muted small-text">Join code: {member.joinCodeId}</p>}
                            {member.invitedByEmail && (
                              <p className="muted small-text">Invited by: {member.invitedByEmail}</p>
                            )}
                            {member.invitedByUserId && (
                              <p className="muted small-text">Invited UID: {member.invitedByUserId}</p>
                            )}
                          </td>
                        </tr>
                        {showMemberDevices && member.email && emailKey && isDevicesExpanded && (
                          <tr key={`${member.id}-devices`}>
                            <td colSpan={4}>
                              {devicePanel?.error && (
                                <div className="tenant-error">
                                  <strong>Devices:</strong> {devicePanel.error}
                                </div>
                              )}
                              {devicePanel?.loading && (
                                <p className="muted small-text">Loading devices for {member.email}…</p>
                              )}
                              {!devicePanel?.loading && !devicePanel?.error && (
                                <>
                                  {(devicePanel?.devices || []).length === 0 ? (
                                    <p className="muted small-text">No devices found for this user.</p>
                                  ) : (
                                    <ul className="tenant-seat-list">
                                      {(devicePanel?.devices || []).map((device) => {
                                        const online = Boolean(device.isOnline);
                                        const onlineBadge = online ? 'online' : 'offline';
                                        const notifLabel = device.notificationsEnabled === false ? 'notifications off' : 'notifications on';
                                        const tenantHint = device.activeTenantId || device.lastTenantId || '—';
                                        return (
                                          <li key={device.deviceId}>
                                            <div>
                                              <strong>{device.deviceId}</strong>{' '}
                                              <span className={`badge ${onlineBadge}`}>{online ? 'online' : 'offline'}</span>
                                              <p className="muted small-text">
                                                Last seen {formatDateTime(device.lastSeen)} · Tenant {tenantHint} · {notifLabel}
                                              </p>
                                              {(device.lastActivityType || device.lastPingType) && (
                                                <p className="muted small-text">
                                                  {device.lastActivityType ? `Activity: ${device.lastActivityType}` : ''}
                                                  {device.lastActivityType && device.lastPingType ? ' · ' : ''}
                                                  {device.lastPingType ? `Ping: ${device.lastPingType}` : ''}
                                                </p>
                                              )}
                                              {device.isDeleted && (
                                                <p className="muted small-text">Marked deleted.</p>
                                              )}
                                            </div>
                                            <div>
                                              <span className="muted small-text">Last tenant ping {formatDateTime(device.lastTenantPingAt)}</span>
                                            </div>
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  )}
                                </>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <hr className="tenant-panel-divider" />
          <div className="tenant-invite-header">
            <div>
              <h3>Invite queue</h3>
              <p className="muted small-text">
                {inviteHeadline || 'Loading invites…'}
              </p>
              {inviteStatusLine && <p className="muted small-text">Status mix · {inviteStatusLine}</p>}
            </div>
            <div className="tenant-membership-actions">
              <button
                type="button"
                className="text-button"
                onClick={handleExportInvites}
                disabled={inviteLoading || inviteRows.length === 0}
              >
                <Download size={14} /> Export CSV
              </button>
              <button type="button" className="text-button" onClick={handleInviteRefresh} disabled={inviteLoading}>
                <RefreshCcw size={14} /> Refresh
              </button>
            </div>
          </div>
          <form className="tenant-invite-filters" onSubmit={handleInviteSubmit}>
            <label>
              Search
              <input
                value={inviteFilters.search}
                onChange={(event) =>
                  setInviteFilters((prev) => ({
                    ...prev,
                    search: event.target.value,
                  }))
                }
                placeholder="Email or message keyword"
                disabled={inviteLoading}
              />
            </label>
            <label>
              Status
              <select
                value={inviteFilters.status}
                onChange={(event) =>
                  setInviteFilters((prev) => ({
                    ...prev,
                    status: event.target.value || 'all',
                  }))
                }
                disabled={inviteLoading}
              >
                <option value="pending">Pending</option>
                <option value="all">All statuses</option>
                <option value="accepted">Accepted</option>
                <option value="expired">Expired</option>
                <option value="revoked">Revoked</option>
              </select>
            </label>
            <div className="tenant-membership-filter-actions">
              <button className="primary-button" type="submit" disabled={inviteLoading}>
                {inviteLoading ? 'Filtering…' : 'Apply filters'}
              </button>
              <button type="button" className="text-button" onClick={handleInviteReset} disabled={inviteLoading}>
                <RefreshCcw size={14} /> Reset
              </button>
            </div>
          </form>
          {inviteNotice && (
            <div className="tenant-success">
              <strong>Invite updated:</strong> {inviteNotice}
            </div>
          )}
          {inviteError && (
            <div className="tenant-error">
              <strong>Invite issue:</strong> {inviteError}
            </div>
          )}
          {inviteLoading && <p className="muted small-text">Loading invites…</p>}
          {!inviteLoading && !inviteError && inviteRows.length === 0 && (
            <p className="muted">No invites matched those filters.</p>
          )}
          {inviteRows.length > 0 && (
            <div className="tenant-invite-table-wrapper">
              <table className="table tenant-invite-table">
                <thead>
                  <tr>
                    <th style={{ width: '32%' }}>Invitee</th>
                    <th style={{ width: '22%' }}>Status</th>
                    <th style={{ width: '24%' }}>Timeline</th>
                    <th style={{ width: '22%' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteRows.map((invite) => {
                    const statusLabel = (invite.status || 'unknown').toLowerCase();
                    const badgeClass = statusLabel === 'pending' || statusLabel === 'accepted' ? 'online' : 'offline';
                    const resendDisabled = statusLabel !== 'pending' || resendingInviteId === invite.id;
                    const shouldShowExpiry = statusLabel === 'pending' || statusLabel === 'expired';
                    return (
                      <tr key={invite.id}>
                        <td>
                          <strong>{invite.email || 'Unknown email'}</strong>
                          {invite.invitationMessage && (
                            <p className="muted small-text">Message: {invite.invitationMessage}</p>
                          )}
                          {invite.role && <p className="muted small-text">Role: {invite.role}</p>}
                          <div className="tenant-membership-actions-inline">
                            {invite.email && (
                              <button type="button" className="text-button" onClick={() => handleCopy(invite.email!)}>
                                <Copy size={14} /> {copiedValue === invite.email ? 'Copied' : 'Copy email'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td>
                          <p className="muted small-text">
                            Status: <span className={`badge ${badgeClass}`}>{statusLabel}</span>
                          </p>
                          {shouldShowExpiry && invite.expiresAt && (
                            <p className="muted small-text">
                              {statusLabel === 'expired' ? 'Expired' : 'Expires'} {formatDateTime(invite.expiresAt)}
                            </p>
                          )}
                          {invite.issuedBy && <p className="muted small-text">Issued by: {invite.issuedBy}</p>}
                        </td>
                        <td>
                          <p className="muted small-text">Issued {formatDateTime(invite.issuedAt)}</p>
                          <p className="muted small-text">Last sent {formatDateTime(invite.lastSentAt)}</p>
                          {invite.acceptedAt && (
                            <p className="muted small-text">Accepted {formatDateTime(invite.acceptedAt)}</p>
                          )}
                        </td>
                        <td>
                          <div className="tenant-membership-actions-inline">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => handleResendInvite(invite.id)}
                              disabled={resendDisabled}
                            >
                              <RefreshCcw size={14} />{' '}
                              {resendingInviteId === invite.id ? 'Sending…' : 'Resend email'}
                            </button>
                            {invite.lastSentBy && (
                              <p className="muted small-text">Last sent by {invite.lastSentBy}</p>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <hr className="tenant-panel-divider" />
          <div className="tenant-audit-header">
            <div>
              <h3>Audit activity</h3>
              <p className="muted small-text">{auditHeadline || 'Loading tenant audit logs…'}</p>
              {auditActionLine && <p className="muted small-text">Actions · {auditActionLine}</p>}
            </div>
            <div className="tenant-membership-actions">
              <button
                type="button"
                className="text-button"
                onClick={handleExportAudit}
                disabled={auditLoading || auditRows.length === 0}
              >
                <Download size={14} /> Export CSV
              </button>
              <button type="button" className="text-button" onClick={handleAuditRefresh} disabled={auditLoading}>
                <RefreshCcw size={14} /> Refresh
              </button>
            </div>
          </div>
          <form className="tenant-invite-filters tenant-audit-filters" onSubmit={handleAuditSubmit}>
            <label>
              Search
              <input
                value={auditFilters.search}
                onChange={(event) =>
                  setAuditFilters((prev) => ({
                    ...prev,
                    search: event.target.value,
                  }))
                }
                placeholder="Actor email, action metadata, or target ID"
                disabled={auditLoading}
              />
            </label>
            <label>
              Action
              <select
                value={auditFilters.action}
                onChange={(event) =>
                  setAuditFilters((prev) => ({
                    ...prev,
                    action: event.target.value || 'all',
                  }))
                }
                disabled={auditLoading}
              >
                <option value="all">All actions</option>
                {auditActionOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <div className="tenant-membership-filter-actions">
              <button className="primary-button" type="submit" disabled={auditLoading}>
                {auditLoading ? 'Filtering…' : 'Apply filters'}
              </button>
              <button type="button" className="text-button" onClick={handleAuditReset} disabled={auditLoading}>
                <RefreshCcw size={14} /> Reset
              </button>
            </div>
          </form>
          {auditError && (
            <div className="tenant-error">
              <strong>Audit issue:</strong> {auditError}
            </div>
          )}
          {auditLoading && <p className="muted small-text">Loading audit entries…</p>}
          {!auditLoading && !auditError && auditRows.length === 0 && (
            <p className="muted">No audit entries matched those filters.</p>
          )}
          {auditRows.length > 0 && (
            <div className="tenant-audit-table-wrapper">
              <table className="table tenant-audit-table">
                <thead>
                  <tr>
                    <th style={{ width: '28%' }}>Action</th>
                    <th style={{ width: '24%' }}>Actor</th>
                    <th style={{ width: '20%' }}>Target</th>
                    <th style={{ width: '28%' }}>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <strong>{entry.action}</strong>
                        <p className="muted small-text">Recorded {formatDateTime(entry.createdAt)}</p>
                        <div className="tenant-membership-actions-inline">
                          <button type="button" className="text-button" onClick={() => handleCopy(entry.id)}>
                            <Copy size={14} /> {copiedValue === entry.id ? 'Copied' : 'Copy ID'}
                          </button>
                        </div>
                      </td>
                      <td>
                        <p className="muted small-text">ID: {entry.actorId || 'system'}</p>
                        <p className="muted small-text">Email: {entry.actorEmail || '—'}</p>
                      </td>
                      <td>
                        <p className="muted small-text">Type: {entry.targetType || '—'}</p>
                        <p className="muted small-text">ID: {entry.targetId || '—'}</p>
                        <p className="muted small-text">Tenant: {entry.tenantId}</p>
                      </td>
                      <td>
                        <p className="muted small-text">{formatMetadata(entry.metadata)}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
