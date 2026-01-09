/* c8 ignore start */
import fetch from 'node-fetch';
import { getEmailBackendBaseUrl } from './runtimeEndpoints';

type JoinRequestEmailContext = {
  tenantId: string;
  tenantName?: string;
  requestId: string;
  requesterEmail: string;
  requesterName?: string;
  message?: string;
};

type TenantNotificationEmailResult = {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  disabled?: boolean;
};

type JoinRequestEmailResult = TenantNotificationEmailResult;

type TenantInviteEmailContext = {
  tenantId: string;
  tenantName?: string;
  inviteId: string;
  inviteToken: string;
  inviteeEmail: string;
  role: string;
  expiresAt?: string;
  message?: string;
};

type TenantInviteEmailResult = TenantNotificationEmailResult;

type TeamMembershipChangeEmailContext = {
  tenantId: string;
  tenantName?: string;
  action: string;
  targetEmail: string;
  targetRole?: string;
  previousRole?: string;
  actorEmail?: string | null;
  actorName?: string | null;
  displayName?: string;
  reason?: string;
  initiatedFrom?: 'web' | 'mobile' | 'system';
  summaryTitle: string;
  summaryBody: string;
};

type UsageAlertEmailContext = {
  tenantId: string;
  tenantName?: string;
  monthId: string;
  metric: string;
  metricLabel: string;
  threshold: 'warning' | 'critical';
  currentValueLabel: string;
  limitLabel: string;
  percentageText: string;
  severityLabel: string;
  alertUrl?: string;
  alertId?: string;
};

type BillingEventEmailContext = {
  tenantId: string;
  tenantName?: string;
  summaryTitle: string;
  summaryBody?: string;
  actionUrl?: string;
  subject?: string;
};

function deriveActorLabel(event: TeamMembershipChangeEmailContext): string | undefined {
  return event.actorName || event.actorEmail || undefined;
}

const EMAIL_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(raw?: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim().replace(/\/$/, '');
  return trimmed.length ? trimmed : null;
}

function deriveDisplayName(email: string): string {
  const local = email.split('@')[0] || 'Admin';
  return local.replace(/[._-]/g, ' ').replace(/\s+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) || 'Admin';
}

async function getEmailBackendConfig(): Promise<{ url: string; headers: Record<string, string> } | null> {
  const remoteBase = await getEmailBackendBaseUrl();
  const base =
    normalizeBaseUrl(remoteBase) ||
    normalizeBaseUrl(process.env.EMAIL_BACKEND_BASE_URL) ||
    normalizeBaseUrl(process.env.EXPO_PUBLIC_EMAIL_API_BASE_URL);
  if (!base) {
    return null;
  }

  const internalKey = process.env.EMAIL_BACKEND_INTERNAL_KEY || process.env.INTERNAL_API_KEY;
  const bearerToken = process.env.EMAIL_BACKEND_BEARER;
  if (!internalKey && !bearerToken) {
    return null;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (internalKey) {
    headers['x-internal-key'] = internalKey;
  }
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  return {
    url: `${base}/email/send-template`,
    headers,
  };
}

function resolveAdminPortalBase(): string | null {
  return (
    normalizeBaseUrl(process.env.ADMIN_PORTAL_BASE_URL) ||
    normalizeBaseUrl(process.env.EXPO_PUBLIC_ADMIN_BASE_URL) ||
    normalizeBaseUrl(process.env.EXPO_PUBLIC_WEB_APP_URL)
  );
}

function buildAdminJoinRequestUrl(event: JoinRequestEmailContext): string | undefined {
  const base = resolveAdminPortalBase();
  if (!base) {
    return undefined;
  }
  const rawPath = (process.env.ADMIN_JOIN_REQUEST_PATH || '/admin/settings/join-requests').trim();
  const pathSegment = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const params = new URLSearchParams({ tenant: event.tenantId, request: event.requestId });
  return `${base}${pathSegment}?${params.toString()}`;
}

function resolveAppBaseUrl(): string | null {
  return (
    normalizeBaseUrl(process.env.TENANT_INVITE_BASE_URL) ||
    normalizeBaseUrl(process.env.EXPO_PUBLIC_APP_URL) ||
    normalizeBaseUrl(process.env.EXPO_PUBLIC_WEB_APP_URL) ||
    normalizeBaseUrl(process.env.EXPO_PUBLIC_APP_BASE_URL)
  );
}

function buildTenantInviteLink(token: string): string | undefined {
  const base = resolveAppBaseUrl();
  if (!base) {
    return undefined;
  }
  const rawPath = (process.env.TENANT_INVITE_PATH || '/invite').trim() || '/invite';
  const pathSegment = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const safeToken = encodeURIComponent(token);
  return `${base}${pathSegment}/${safeToken}`;
}

function formatInviteExpiration(iso?: string): string | undefined {
  if (!iso) {
    return undefined;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export async function sendTenantJoinRequestEmails(
  event: JoinRequestEmailContext,
  recipients: string[],
): Promise<JoinRequestEmailResult> {
  if (!recipients.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const backend = await getEmailBackendConfig();
  if (!backend) {
    return { attempted: 0, sent: 0, failed: 0, skipped: recipients.length, disabled: true };
  }

  const subject = event.tenantName ? `New join request • ${event.tenantName}` : 'New join request';
  const reviewUrl = buildAdminJoinRequestUrl(event);

  let sent = 0;
  let failed = 0;

  for (const email of recipients) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
    try {
      const response = await fetch(backend.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...backend.headers,
          ...(event.tenantId ? { 'x-tenant': event.tenantId } : {}),
        },
        body: JSON.stringify({
          template: 'tenant_join_request',
          to_email: email,
          to_name: deriveDisplayName(email),
          coaching_name: event.tenantName || 'Coaching Center',
          tenant_name: event.tenantName || 'Coaching Center',
          tenant_id: event.tenantId,
          from_name: event.tenantName || 'Coaching Center',
          subject,
          requester_name: event.requesterName,
          requester_email: event.requesterEmail,
          request_id: event.requestId,
          request_message: event.message?.trim() || '',
          admin_portal_url: reviewUrl,
        }),
      });
      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[tenant-email] join request email failed', error);
      }
      failed += 1;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    attempted: sent + failed,
    sent,
    failed,
    skipped: 0,
  };
}

export async function sendTenantInviteEmail(
  context: TenantInviteEmailContext,
): Promise<TenantInviteEmailResult> {
  const backend = await getEmailBackendConfig();
  if (!backend) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 1, disabled: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
  try {
    const response = await fetch(backend.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...backend.headers,
        ...(context.tenantId ? { 'x-tenant': context.tenantId } : {}),
      },
      body: JSON.stringify({
        template: 'tenant_invite',
        to_email: context.inviteeEmail,
        to_name: deriveDisplayName(context.inviteeEmail),
        tenant_name: context.tenantName || 'Coaching Center',
        from_name: context.tenantName || 'Coaching Center',
        invite_role: context.role,
        invite_message: context.message || '',
        invite_link: buildTenantInviteLink(context.inviteToken),
        expires_at: context.expiresAt,
        expires_at_human: formatInviteExpiration(context.expiresAt),
      }),
    });
    if (!response.ok) {
      return { attempted: 1, sent: 0, failed: 1, skipped: 0 };
    }
    return { attempted: 1, sent: 1, failed: 0, skipped: 0 };
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[tenant-email] invite email failed', error);
    }
    return { attempted: 1, sent: 0, failed: 1, skipped: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendTeamMembershipChangeEmails(
  event: TeamMembershipChangeEmailContext,
  recipients: string[],
): Promise<TenantNotificationEmailResult> {
  if (!recipients.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const backend = await getEmailBackendConfig();
  if (!backend) {
    return { attempted: 0, sent: 0, failed: 0, skipped: recipients.length, disabled: true };
  }

  const subject = event.summaryTitle
    ? event.summaryTitle
    : event.tenantName
      ? `Team update • ${event.tenantName}`
      : 'Team update';

  let sent = 0;
  let failed = 0;

  for (const email of recipients) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
    try {
      const response = await fetch(backend.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...backend.headers,
          ...(event.tenantId ? { 'x-tenant': event.tenantId } : {}),
        },
        body: JSON.stringify({
          template: 'team_membership_change',
          to_email: email,
          to_name: deriveDisplayName(email),
          tenant_id: event.tenantId,
          tenant_name: event.tenantName || 'Coaching Center',
          subject,
          summary_title: event.summaryTitle || subject,
          summary_body: event.summaryBody || '',
          action: event.action,
          target_email: event.targetEmail,
          target_role: event.targetRole,
          previous_role: event.previousRole,
          actor_email: event.actorEmail ?? undefined,
          actor_name: deriveActorLabel(event),
          display_name: event.displayName,
          reason: event.reason,
          initiated_from: event.initiatedFrom,
        }),
      });
      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[team_membership_email] send failed', error);
      }
      failed += 1;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    attempted: sent + failed,
    sent,
    failed,
    skipped: 0,
  };
}

export async function sendUsageAlertEmails(
  context: UsageAlertEmailContext,
  recipients: string[],
): Promise<TenantNotificationEmailResult> {
  if (!recipients.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const backend = await getEmailBackendConfig();
  if (!backend) {
    return { attempted: 0, sent: 0, failed: 0, skipped: recipients.length, disabled: true };
  }

  const subjectMetric = context.tenantName
    ? `${context.metricLabel} • ${context.tenantName}`
    : context.metricLabel;
  const subject = context.threshold === 'critical'
    ? `Usage limit hit • ${subjectMetric}`
    : `Usage warning • ${subjectMetric}`;

  let sent = 0;
  let failed = 0;

  for (const email of recipients) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
    try {
      const response = await fetch(backend.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...backend.headers,
          ...(context.tenantId ? { 'x-tenant': context.tenantId } : {}),
        },
        body: JSON.stringify({
          template: 'usage_alert',
          to_email: email,
          to_name: deriveDisplayName(email),
          tenant_id: context.tenantId,
          tenant_name: context.tenantName || 'Coaching Center',
          subject,
          severity: context.severityLabel,
          threshold: context.threshold,
          metric: context.metric,
          metric_label: context.metricLabel,
          current_value: context.currentValueLabel,
          usage_limit: context.limitLabel,
          usage_percentage: context.percentageText,
          month_id: context.monthId,
          alert_url: context.alertUrl,
          alert_id: context.alertId,
        }),
      });
      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[tenant-email] usage alert email failed', error);
      }
      failed += 1;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    attempted: sent + failed,
    sent,
    failed,
    skipped: 0,
  };
}

export async function sendBillingEventEmails(
  context: BillingEventEmailContext,
  recipients: string[],
): Promise<TenantNotificationEmailResult> {
  if (!recipients.length) {
    return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  }

  const backend = await getEmailBackendConfig();
  if (!backend) {
    return { attempted: 0, sent: 0, failed: 0, skipped: recipients.length, disabled: true };
  }

  const subject = (context.subject && context.subject.trim().length > 0)
    ? context.subject.trim()
    : (context.tenantName ? `Billing update • ${context.tenantName}` : 'Billing update');

  let sent = 0;
  let failed = 0;

  for (const email of recipients) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMAIL_TIMEOUT_MS);
    try {
      const response = await fetch(backend.url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...backend.headers,
          ...(context.tenantId ? { 'x-tenant': context.tenantId } : {}),
        },
        body: JSON.stringify({
          template: 'billing_event',
          to_email: email,
          to_name: deriveDisplayName(email),
          tenant_id: context.tenantId,
          tenant_name: context.tenantName || 'Coaching Center',
          from_name: context.tenantName || 'Coaching Center',
          subject,
          summary_title: context.summaryTitle || subject,
          summary_body: context.summaryBody || '',
          ...(context.actionUrl ? { action_url: context.actionUrl } : {}),
        }),
      });
      if (response.ok) {
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[tenant-email] billing event email failed', error);
      }
      failed += 1;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    attempted: sent + failed,
    sent,
    failed,
    skipped: 0,
  };
}

export type {
  JoinRequestEmailContext,
  JoinRequestEmailResult,
  TenantInviteEmailContext,
  TenantInviteEmailResult,
  TeamMembershipChangeEmailContext,
  TenantNotificationEmailResult,
  UsageAlertEmailContext,
  BillingEventEmailContext,
};
/* c8 ignore stop */
