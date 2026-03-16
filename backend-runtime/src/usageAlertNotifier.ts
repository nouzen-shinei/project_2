import * as admin from 'firebase-admin';
import fetch from 'node-fetch';
import { enqueueCustomMessage } from './queueProvider';
import { ensureFirebase, getFirestore } from './firebaseAdmin';
import {
  markPushTokensInvalid,
  sendExpoMessages,
  type ExpoPushMessage,
  type PushTokenRecord,
} from './pushUtils';
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
  usageAlertPush: true,
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
  push?: {
    recipients: number;
    attempted: number;
    sent: number;
    failed: number;
    skipped?: number;
  } | null;
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
      push: number;
      whatsapp: number;
      slack: boolean;
    };
    channelPreferences: {
      email: boolean;
      push: boolean;
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

interface TenantAdminContact {
  email: string;
  phone?: string;
  usageAlertEmailEnabled: boolean;
  usageAlertPushEnabled: boolean;
}

interface TenantAdminContacts {
  admins: TenantAdminContact[];
  phones: string[];
}

interface UsageAlertDeviceRecord {
  token: string;
  deviceDocPath: string;
  deviceId?: string;
  ownerEmail: string;
  notificationsEnabled?: boolean;
  noticeNotificationsEnabled?: boolean;
  usageAlertNotificationsEnabled?: boolean;
  isDeleted?: boolean;
  isOnline?: boolean;
  sessionActive?: boolean;
  logoutType?: string;
}

export async function notifyUsageAlert(params: NotifyUsageAlertParams): Promise<UsageAlertNotificationSummary | null> {
  ensureFirebase();
  const db = getFirestore();
  const tenantContext = await loadTenantAlertContext(db, params.tenantId, params.tenantName);
  const tenantName = tenantContext.tenantName;
  const contacts = await loadTenantAdminContacts(db, params.tenantId);
  const slackWebhook = (process.env.USAGE_ALERT_SLACK_WEBHOOK_URL || '').trim();

  const allowWhatsApp = tenantContext.preferences.usageAlertWhatsApp !== false;
  const allowSlack = tenantContext.preferences.usageAlertSlack !== false;

  const emailRecipients = contacts.admins
    .filter((contact) => contact.usageAlertEmailEnabled !== false)
    .map((contact) => contact.email);
  const whatsappRecipients = allowWhatsApp ? contacts.phones : [];
  const slackTargetWebhook = allowSlack ? slackWebhook : '';
  const pushRecipients = contacts.admins
    .filter((contact) => contact.usageAlertPushEnabled !== false)
    .map((contact) => contact.email);

  if (!emailRecipients.length && !pushRecipients.length && !whatsappRecipients.length && !slackTargetWebhook) {
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
        push: pushRecipients.length,
        whatsapp: whatsappRecipients.length,
        slack: Boolean(slackTargetWebhook),
      },
      channelPreferences: {
        email: emailRecipients.length > 0,
        push: pushRecipients.length > 0,
        whatsapp: allowWhatsApp,
        slack: allowSlack,
      },
    },
  };

  if (pushRecipients.length) {
    summary.push = await sendUsagePushNotifications({
      db,
      tenantId: params.tenantId,
      tenantName,
      recipients: pushRecipients,
      severityLabel,
      metric: params.metric,
      metricLabel: params.metricLabel,
      threshold: params.threshold,
      percentage,
      valueLabel: metricsCopy.valueLabel,
      limitLabel: metricsCopy.limitLabel,
      monthId: params.monthId,
      ackUrl,
      alertId: params.alertId,
    });
  }

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
  const hasPush = Boolean(summary.push && summary.push.recipients > 0);
  const hasWhatsApp = Boolean(summary.whatsapp && summary.whatsapp.recipients > 0);
  const hasSlack = Boolean(summary.slack);

  if (!hasEmail && !hasPush && !hasWhatsApp && !hasSlack) {
    return null;
  }

  return summary;
}

async function getDevicesForUser(
  db: admin.firestore.Firestore,
  email: string
): Promise<UsageAlertDeviceRecord[]> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return [];

  const devicesSnap = await db
    .collection('user_devices')
    .doc(normalized)
    .collection('devices')
    .select(
      'expoPushToken',
      'notificationsEnabled',
      'noticeNotificationsEnabled',
      'usageAlertNotificationsEnabled',
      'isDeleted',
      'isOnline',
      'sessionActive',
      'logoutType',
      'deviceId'
    )
    .get();

  return devicesSnap.docs
    .map((doc) => {
      const data = doc.data();
      const token = typeof data?.expoPushToken === 'string' ? data.expoPushToken.trim() : '';
      return {
        token,
        deviceDocPath: doc.ref.path,
        deviceId: data?.deviceId,
        ownerEmail: normalized,
        notificationsEnabled: data?.notificationsEnabled,
        noticeNotificationsEnabled: data?.noticeNotificationsEnabled,
        usageAlertNotificationsEnabled: data?.usageAlertNotificationsEnabled,
        isDeleted: data?.isDeleted,
        isOnline: data?.isOnline,
        sessionActive: data?.sessionActive,
        logoutType: typeof data?.logoutType === 'string' ? data.logoutType : undefined,
      } satisfies UsageAlertDeviceRecord;
    })
    .filter((record) => Boolean(record.token));
}

function shouldDeliverPushToDevice(device: UsageAlertDeviceRecord): boolean {
  if (!device.token) return false;
  if (device.isDeleted) return false;
  if (device.sessionActive === false) return false;
  if (device.logoutType === 'manual' || device.logoutType === 'forced') return false;
  if (device.isOnline !== true) return false;
  if (device.notificationsEnabled === false) return false;
  if (device.noticeNotificationsEnabled === false) return false;
  if (device.usageAlertNotificationsEnabled === false) return false;
  return true;
}

async function collectDeliverableUsageAlertDevices(
  db: admin.firestore.Firestore,
  recipients: string[]
): Promise<Map<string, UsageAlertDeviceRecord>> {
  const tokenToDevice = new Map<string, UsageAlertDeviceRecord>();
  const blockedTokens = new Set<string>();

  for (const recipient of recipients) {
    const devices = await getDevicesForUser(db, recipient);
    for (const device of devices) {
      if (!shouldDeliverPushToDevice(device)) {
        if (device.token && (device.noticeNotificationsEnabled === false || device.usageAlertNotificationsEnabled === false)) {
          blockedTokens.add(device.token);
          tokenToDevice.delete(device.token);
        }
        continue;
      }

      if (device.token && !blockedTokens.has(device.token) && !tokenToDevice.has(device.token)) {
        tokenToDevice.set(device.token, device);
      }
    }
  }

  for (const token of blockedTokens) {
    tokenToDevice.delete(token);
  }

  return tokenToDevice;
}

async function sendUsagePushNotifications(options: {
  db: admin.firestore.Firestore;
  tenantId: string;
  tenantName?: string;
  recipients: string[];
  severityLabel: string;
  metric: UsageMetricKey;
  metricLabel: string;
  threshold: 'warning' | 'critical';
  percentage: number;
  valueLabel: string;
  limitLabel: string;
  monthId: string;
  ackUrl?: string;
  alertId: string;
}): Promise<UsageAlertNotificationSummary['push']> {
  const tokenToDevice = await collectDeliverableUsageAlertDevices(options.db, options.recipients);
  if (!tokenToDevice.size) {
    return {
      recipients: 0,
      attempted: 0,
      sent: 0,
      failed: 0,
      skipped: options.recipients.length,
    };
  }

  const title = options.threshold === 'critical'
    ? `Usage limit hit: ${options.metricLabel}`
    : `Usage warning: ${options.metricLabel}`;
  const body = `${options.metricLabel} is at ${options.percentage}% (${options.valueLabel} of ${options.limitLabel}) for ${options.monthId}.`;
  const timestamp = new Date().toISOString();

  const messages: ExpoPushMessage[] = [];
  for (const device of tokenToDevice.values()) {
    messages.push({
      to: device.token,
      title,
      body,
      sound: 'default',
      priority: options.threshold === 'critical' ? 'high' : 'default',
      data: {
        type: 'usage_alert',
        priority: options.threshold === 'critical' ? 'high' : 'medium',
        tenantId: options.tenantId,
        tenantName: options.tenantName || null,
        metric: options.metric,
        metricLabel: options.metricLabel,
        threshold: options.threshold,
        monthId: options.monthId,
        percentage: options.percentage,
        valueLabel: options.valueLabel,
        limitLabel: options.limitLabel,
        alertId: options.alertId,
        ackUrl: options.ackUrl || null,
        timestamp,
      },
    });
  }

  const result = await sendExpoMessages(messages, { context: 'usage_alert' });

  if (result.invalidTokens.length) {
    const invalidRecords: PushTokenRecord[] = [];
    for (const token of result.invalidTokens) {
      const device = tokenToDevice.get(token);
      if (device) {
        invalidRecords.push({
          token,
          deviceDocPath: device.deviceDocPath,
          deviceId: device.deviceId,
          ownerEmail: device.ownerEmail,
        });
      }
    }
    if (invalidRecords.length) {
      await markPushTokensInvalid(invalidRecords, { context: 'usage_alert' });
    }
  }

  return {
    recipients: tokenToDevice.size,
    attempted: messages.length,
    sent: result.sent,
    failed: result.failed,
    skipped: Math.max(0, options.recipients.length - tokenToDevice.size),
  };
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
  if (typeof raw.usageAlertPush === 'boolean') {
    normalized.usageAlertPush = raw.usageAlertPush;
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

  const adminsByEmail = new Map<string, TenantAdminContact>();
  const phones = new Set<string>();

  snapshot.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const role = typeof data.role === 'string' ? data.role.trim().toLowerCase() : '';
    if (!ADMIN_ROLES.has(role)) {
      return;
    }
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (email) {
      const membershipPrefs =
        (data.notificationPreferences && typeof data.notificationPreferences === 'object'
          ? (data.notificationPreferences as Record<string, unknown>)
          : {}) || {};
      const existing = adminsByEmail.get(email);
      const usageAlertEmailEnabled =
        typeof membershipPrefs.usageAlertEmail === 'boolean' ? membershipPrefs.usageAlertEmail : true;
      const usageAlertPushEnabled =
        typeof membershipPrefs.usageAlertPush === 'boolean' ? membershipPrefs.usageAlertPush : true;

      if (!existing) {
        adminsByEmail.set(email, {
          email,
          usageAlertEmailEnabled,
          usageAlertPushEnabled,
        });
      }
    }
    const phone = extractPhoneNumber(data);
    if (phone) {
      phones.add(phone);
      if (email) {
        const existing = adminsByEmail.get(email);
        if (existing && !existing.phone) {
          existing.phone = phone;
          adminsByEmail.set(email, existing);
        }
      }
    }
  });

  return {
    admins: Array.from(adminsByEmail.values()),
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
