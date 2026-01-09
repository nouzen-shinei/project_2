import * as admin from 'firebase-admin';
import fetch from 'node-fetch';
import { enqueueCustomMessage } from './queueProvider';
import { ensureFirebase, getFirestore } from './firebaseAdmin';
import {
  sendUsageAlertEmails,
  type TenantNotificationEmailResult,
} from './tenantNotificationEmail';
import type { UsageMetricKey } from './lib/usageMetrics';

const ADMIN_ROLES = new Set(['owner', 'admin']);
const PHONE_FIELDS = ['phoneNumber', 'phone', 'mobile', 'mobileNumber', 'contactNumber', 'whatsapp', 'whatsappNumber'];
const DEFAULT_SENDER = process.env.USAGE_ALERT_SENDER_NAME?.trim() || 'Usage Monitor';
const DEFAULT_COACHING_FALLBACK = process.env.USAGE_ALERT_BRAND_NAME?.trim() || 'Tuition Manager';
const DEFAULT_USAGE_ALERT_PREFS = {
  usageAlertEmail: true,
  usageAlertWhatsApp: true,
  usageAlertSlack: true,
};
const WARNING_ACK_ESCALATION_HOURS = coerceEscalationHours(
  process.env.USAGE_ALERT_ACK_ESCALATION_WARNING_HOURS,
  24
);
const CRITICAL_ACK_ESCALATION_HOURS = coerceEscalationHours(
  process.env.USAGE_ALERT_ACK_ESCALATION_CRITICAL_HOURS,
  6
);

export interface UsageAlertNotificationSummary {
  email?: (TenantNotificationEmailResult & { recipients: number }) | null;
  whatsapp?: {
    recipients: number;
    attempted: number;
    sent: number;
    failed: number;
    skipped?: number;
  } | null;
  slack?: {
    ok: boolean;
    status?: number;
    error?: string;
  } | null;
  ack?: {
    requestedAt: string;
    requestedAtTimestamp: admin.firestore.Timestamp;
    ackUrl?: string;
    tenantName?: string;
    metric: UsageMetricKey;
    metricLabel: string;
    threshold: 'warning' | 'critical';
    severityLabel: string;
    monthId: string;
    percentage: number;
    valueLabel: string;
    limitLabel: string;
    escalateAfterHours: number;
    escalateAt?: string;
    escalateAtTimestamp?: admin.firestore.Timestamp;
    escalationCount: number;
    escalationLimitReached: boolean;
    lastEscalatedAt?: string;
    lastEscalatedAtTimestamp?: admin.firestore.Timestamp;
    lastEscalationStatus?: string;
    lastEscalationError?: string;
    pending: boolean;
    deliveredChannels: {
      email: number;
      whatsapp: number;
      slack: boolean;
    };
    channelPreferences: {
      email: boolean;
      whatsapp: boolean;
      slack: boolean;
    };
  };
}

interface NotifyUsageAlertParams {
  tenantId: string;
  tenantName?: string;
  monthId: string;
  metric: UsageMetricKey;
  metricLabel: string;
  threshold: 'warning' | 'critical';
  ratio: number;
  value: number;
  limit: number;
  alertId: string;
}

interface TenantAdminContacts {
  emails: string[];
  phones: string[];
}

export async function notifyUsageAlert(params: NotifyUsageAlertParams): Promise<UsageAlertNotificationSummary | null> {
  ensureFirebase();
  const db = getFirestore();
  const tenantContext = await loadTenantAlertContext(db, params.tenantId, params.tenantName);
  const tenantName = tenantContext.tenantName;
  const contacts = await loadTenantAdminContacts(db, params.tenantId);
  const slackWebhook = (process.env.USAGE_ALERT_SLACK_WEBHOOK_URL || '').trim();

  const allowEmail = tenantContext.preferences.usageAlertEmail !== false;
  const allowWhatsApp = tenantContext.preferences.usageAlertWhatsApp !== false;
  const allowSlack = tenantContext.preferences.usageAlertSlack !== false;

  const emailRecipients = allowEmail ? contacts.emails : [];
  const whatsappRecipients = allowWhatsApp ? contacts.phones : [];
  const slackTargetWebhook = allowSlack ? slackWebhook : '';

  if (!emailRecipients.length && !whatsappRecipients.length && !slackTargetWebhook) {
    return null;
  }

  const metricsCopy = buildMetricCopy(params.metric, params.value, params.limit);
  const percentage = Math.round(params.ratio * 100);
  const severityLabel = params.threshold === 'critical' ? 'Critical' : 'Warning';
  const ackUrl = buildUsageAlertUrl(params.tenantId, params.monthId, params.alertId);
  const ackRequestedAtDate = new Date();
  const ackRequestedAt = ackRequestedAtDate.toISOString();
  const ackEscalationHours = getAckEscalationHours(params.threshold);
  const ackEscalateAtDate = new Date(ackRequestedAtDate.getTime() + ackEscalationHours * 60 * 60 * 1000);
  const ackEscalateAt = ackEscalateAtDate.toISOString();
  const summary: UsageAlertNotificationSummary = {
    ack: {
      requestedAt: ackRequestedAt,
      requestedAtTimestamp: admin.firestore.Timestamp.fromDate(ackRequestedAtDate),
      ackUrl,
      tenantName,
      metric: params.metric,
      metricLabel: params.metricLabel,
      threshold: params.threshold,
      severityLabel,
      monthId: params.monthId,
      percentage,
      valueLabel: metricsCopy.valueLabel,
      limitLabel: metricsCopy.limitLabel,
      escalateAfterHours: ackEscalationHours,
      escalateAt: ackEscalateAt,
      escalateAtTimestamp: admin.firestore.Timestamp.fromDate(ackEscalateAtDate),
      escalationCount: 0,
      escalationLimitReached: false,
      pending: true,
      deliveredChannels: {
        email: emailRecipients.length,
        whatsapp: whatsappRecipients.length,
        slack: Boolean(slackTargetWebhook),
      },
      channelPreferences: {
        email: allowEmail,
        whatsapp: allowWhatsApp,
        slack: allowSlack,
      },
    },
  };

  if (emailRecipients.length) {
    try {
      const emailResult = await sendUsageAlertEmails(
        {
          tenantId: params.tenantId,
          tenantName,
          monthId: params.monthId,
          metric: params.metric,
          metricLabel: params.metricLabel,
          threshold: params.threshold,
          currentValueLabel: metricsCopy.valueLabel,
          limitLabel: metricsCopy.limitLabel,
          percentageText: `${percentage}%`,
          severityLabel,
          alertUrl: ackUrl,
          alertId: params.alertId,
        },
        emailRecipients
      );
      summary.email = { ...emailResult, recipients: emailRecipients.length };
    } catch (error) {
      console.error('[usage_alert_notifier] email delivery failed', { tenantId: params.tenantId, error });
      summary.email = {
        attempted: 0,
        sent: 0,
        failed: emailRecipients.length,
        skipped: 0,
        recipients: emailRecipients.length,
      };
    }
  }

  if (whatsappRecipients.length) {
    const whatsappResult = await sendWhatsAppNotifications({
      tenantId: params.tenantId,
      tenantName,
      recipients: whatsappRecipients,
      severityLabel,
      metricLabel: params.metricLabel,
      percentage,
      valueLabel: metricsCopy.valueLabel,
      limitLabel: metricsCopy.limitLabel,
      monthId: params.monthId,
      ackUrl,
    });
    summary.whatsapp = whatsappResult;
  }

  if (slackTargetWebhook) {
    summary.slack = await sendSlackNotification(slackTargetWebhook, {
      tenantId: params.tenantId,
      tenantName,
      severityLabel,
      metricLabel: params.metricLabel,
      percentage,
      valueLabel: metricsCopy.valueLabel,
      limitLabel: metricsCopy.limitLabel,
      monthId: params.monthId,
      ackUrl,
    });
  }

  const hasEmail = Boolean(summary.email && summary.email.recipients > 0);
  const hasWhatsApp = Boolean(summary.whatsapp && summary.whatsapp.recipients > 0);
  const hasSlack = Boolean(summary.slack);

  if (!hasEmail && !hasWhatsApp && !hasSlack) {
    return null;
  }

  return summary;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 MB';
  }
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  const mb = value / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(1)} MB`;
  }
  const kb = value / 1024;
  if (kb >= 1) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${value} B`;
}

export function buildMetricCopy(metric: UsageMetricKey, value: number, limit: number): { valueLabel: string; limitLabel: string } {
  if (metric === 'storage') {
    return {
      valueLabel: formatBytes(value),
      limitLabel: formatBytes(limit),
    };
  }
  return {
    valueLabel: value.toLocaleString('en-IN'),
    limitLabel: limit.toLocaleString('en-IN'),
  };
}

interface TenantAlertContext {
  tenantName?: string;
  preferences: typeof DEFAULT_USAGE_ALERT_PREFS;
}

async function loadTenantAlertContext(
  db: admin.firestore.Firestore,
  tenantId: string,
  provided?: string
): Promise<TenantAlertContext> {
  const context: TenantAlertContext = {
    tenantName: provided?.trim() || undefined,
    preferences: { ...DEFAULT_USAGE_ALERT_PREFS },
  };

  try {
    const snap = await db.collection('tenants').doc(tenantId).get();
    if (!snap.exists) {
      return context;
    }
    const data = snap.data() || {};
    if (!context.tenantName) {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (name) {
        context.tenantName = name;
      } else {
        const coaching = typeof data.coachingName === 'string' ? data.coachingName.trim() : '';
        if (coaching) {
          context.tenantName = coaching;
        }
      }
    }

    const prefsRaw = (data.notificationPreferences as Record<string, unknown> | undefined) || undefined;
    if (prefsRaw) {
      context.preferences = normalizeUsageAlertPreferences(prefsRaw);
    }
  } catch (error) {
    console.warn('[usage_alert_notifier] failed to resolve tenant alert context', { tenantId, error });
  }

  return context;
}

function normalizeUsageAlertPreferences(raw?: Record<string, unknown>): typeof DEFAULT_USAGE_ALERT_PREFS {
  const normalized = { ...DEFAULT_USAGE_ALERT_PREFS };
  if (!raw || typeof raw !== 'object') {
    return normalized;
  }
  if (typeof raw.usageAlertEmail === 'boolean') {
    normalized.usageAlertEmail = raw.usageAlertEmail;
  }
  if (typeof raw.usageAlertWhatsApp === 'boolean') {
    normalized.usageAlertWhatsApp = raw.usageAlertWhatsApp;
  }
  if (typeof raw.usageAlertSlack === 'boolean') {
    normalized.usageAlertSlack = raw.usageAlertSlack;
  }
  return normalized;
}

async function loadTenantAdminContacts(
  db: admin.firestore.Firestore,
  tenantId: string
): Promise<TenantAdminContacts> {
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active')
    .get();

  const emails = new Set<string>();
  const phones = new Set<string>();

  snapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const role = typeof data.role === 'string' ? data.role.trim().toLowerCase() : '';
    if (!ADMIN_ROLES.has(role)) {
      return;
    }
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (email) {
      emails.add(email);
    }
    const phone = extractPhoneNumber(data);
    if (phone) {
      phones.add(phone);
    }
  });

  return {
    emails: Array.from(emails),
    phones: Array.from(phones),
  };
}

function extractPhoneNumber(record: Record<string, unknown>): string | null {
  for (const field of PHONE_FIELDS) {
    const raw = record[field];
    if (typeof raw === 'string' && raw.trim()) {
      const normalized = normalizePhoneNumber(raw);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function normalizePhoneNumber(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('+')) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  if (digits.startsWith('91') && digits.length === 12) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+91${digits}`;
  }
  return `+${digits}`;
}

function buildUsageAlertUrl(tenantId: string, monthId: string, alertId: string): string | undefined {
  const base = (process.env.ADMIN_PORTAL_BASE_URL || process.env.EXPO_PUBLIC_ADMIN_BASE_URL || '').trim();
  if (!base) {
    return undefined;
  }
  const path = (process.env.ADMIN_USAGE_PANEL_PATH || '/admin/settings/usage').trim() || '/admin/settings/usage';
  const safePath = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams({ tenant: tenantId, month: monthId, alert: alertId });
  return `${base.replace(/\/$/, '')}${safePath}?${params.toString()}`;
}

function getAckEscalationHours(threshold: 'warning' | 'critical'): number {
  return threshold === 'critical' ? CRITICAL_ACK_ESCALATION_HOURS : WARNING_ACK_ESCALATION_HOURS;
}

function coerceEscalationHours(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

async function sendWhatsAppNotifications(options: {
  tenantId: string;
  tenantName?: string;
  recipients: string[];
  severityLabel: string;
  metricLabel: string;
  percentage: number;
  valueLabel: string;
  limitLabel: string;
  monthId: string;
  ackUrl?: string;
}): Promise<UsageAlertNotificationSummary['whatsapp']> {
  if (!options.recipients.length) {
    return null;
  }

  const sender = DEFAULT_SENDER;
  const coachingName = options.tenantName || DEFAULT_COACHING_FALLBACK;
  const message = buildWhatsappMessage(options, coachingName);
  const result = {
    recipients: options.recipients.length,
    attempted: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  const wabaConfigured = Boolean(process.env.WABA_PHONE_NUMBER_ID && process.env.WABA_TOKEN);
  if (!wabaConfigured) {
    result.skipped = options.recipients.length;
    console.warn('[usage_alert_notifier] whatsapp env missing, skipping admin blast');
    return result;
  }

  for (const phone of options.recipients) {
    try {
      await enqueueCustomMessage({
        tenantId: options.tenantId,
        tenantName: options.tenantName,
        to: phone,
        message,
        englishMessage: message,
        teacherName: sender,
        coachingName,
        selectedLanguage: 'english',
      });
      result.sent += 1;
      result.attempted += 1;
    } catch (error) {
      console.error('[usage_alert_notifier] whatsapp enqueue failed', { tenantId: options.tenantId, phone, error });
      result.failed += 1;
      result.attempted += 1;
    }
  }

  return result;
}

function buildWhatsappMessage(options: {
  severityLabel: string;
  metricLabel: string;
  percentage: number;
  valueLabel: string;
  limitLabel: string;
  monthId: string;
  ackUrl?: string;
}, coachingName: string): string {
  const intro = options.severityLabel === 'Critical' ? 'Usage limit hit' : 'Usage warning';
  const base = `${intro}: ${options.metricLabel} is at ${options.percentage}% (${options.valueLabel} of ${options.limitLabel}) for ${options.monthId}.`;
  if (options.ackUrl) {
    return `${base} Review: ${options.ackUrl} — ${coachingName}`;
  }
  return `${base} Open the Admin app → Usage to review. — ${coachingName}`;
}

export async function sendSlackNotification(
  webhookUrl: string,
  payload: {
    tenantId: string;
    tenantName?: string;
    severityLabel: string;
    metricLabel: string;
    percentage: number;
    valueLabel: string;
    limitLabel: string;
    monthId: string;
    ackUrl?: string;
  }
): Promise<UsageAlertNotificationSummary['slack']> {
  try {
    const text = buildSlackMessage(payload);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    console.error('[usage_alert_notifier] slack webhook failed', { tenantId: payload.tenantId, error });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function buildSlackMessage(payload: {
  tenantId: string;
  tenantName?: string;
  severityLabel: string;
  metricLabel: string;
  percentage: number;
  valueLabel: string;
  limitLabel: string;
  monthId: string;
  ackUrl?: string;
}): string {
  const tenantLabel = payload.tenantName ? `${payload.tenantName} (${payload.tenantId})` : payload.tenantId;
  const lines = [
    `*Usage ${payload.severityLabel}* — ${tenantLabel}`,
    `${payload.metricLabel}: ${payload.percentage}% (${payload.valueLabel} / ${payload.limitLabel}) for ${payload.monthId}`,
  ];
  if (payload.ackUrl) {
    lines.push(payload.ackUrl);
  }
  return lines.join('\n');
}
