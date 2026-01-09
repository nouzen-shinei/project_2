import Mustache from 'mustache';
import fs from 'fs';
import path from 'path';

export type TemplateKind =
  | 'custom_message_bilingual'
  | 'fee_reminder'
  | 'billing_event'
  | 'tenant_join_request'
  | 'tenant_invite'
  | 'team_membership_change'
  | 'usage_alert';

const TEMPLATE_FILES: Record<TemplateKind, string> = {
  custom_message_bilingual: 'custom_message_bilingual.html',
  fee_reminder: 'fee_reminder.html',
  billing_event: 'billing_event.html',
  tenant_join_request: 'tenant_join_request.html',
  tenant_invite: 'tenant_invite.html',
  team_membership_change: 'team_membership_change.html',
  usage_alert: 'usage_alert.html',
};

function templatePath(kind: TemplateKind){
  return path.resolve(process.cwd(), 'templates', TEMPLATE_FILES[kind]);
}

function loadTemplate(kind: TemplateKind){
  const p = templatePath(kind);
  return fs.readFileSync(p, 'utf8');
}

function capitalize(word: string): string {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function toHumanDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function normalizeOrigin(raw?: string): string | undefined {
  const v = (raw || '').trim();
  if (!v) return undefined;
  return v.replace(/\/+$/, '');
}

function inferInviteDeepLinkPath(inviteLink: string): string | undefined {
  const raw = (inviteLink || '').trim();
  if (!raw) return undefined;

  // Common patterns we support:
  // - https://tuitionmanager.app/invite/<token>
  // - https://tuitionmanager.app/invite?token=<token>
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/').filter(Boolean);
    const inviteIdx = parts.indexOf('invite');
    if (inviteIdx >= 0 && parts[inviteIdx + 1]) {
      const token = parts[inviteIdx + 1];
      return `invite/${token}`;
    }
    const tokenParam = (u.searchParams.get('token') || '').trim();
    if (tokenParam) return `invite/${tokenParam}`;
  } catch {
    // ignore
  }

  return undefined;
}

function toSmartLink(url: any, deepLinkPath?: any) {
  const origin = normalizeOrigin(process.env.PUBLIC_WEB_APP_ORIGIN);
  const rawUrl = typeof url === 'string' ? url.trim() : '';
  if (!origin || !rawUrl) return rawUrl || undefined;

  const dl = typeof deepLinkPath === 'string' ? deepLinkPath.trim() : '';
  const q = new URLSearchParams();
  q.set('u', rawUrl);
  if (dl) q.set('dl', dl);
  return `${origin}/l?${q.toString()}`;
}

export function renderTemplate(kind: TemplateKind, vars: Record<string, any>){
  const tpl = loadTemplate(kind);
  const provided = !!(vars.subject && String(vars.subject).trim().length > 0);

  if (kind === 'billing_event') {
    const tenantName = (vars.tenant_name || vars.coaching_name || vars.from_name || 'your coaching center').toString();
    const subject = provided ? String(vars.subject).trim() : `Billing update • ${tenantName}`;
    const templateVars: Record<string, any> = {
      ...vars,
      subject,
      tenant_name: vars.tenant_name || tenantName,
      summary_title: vars.summary_title || vars.summaryTitle || subject,
      summary_body: vars.summary_body || vars.summaryBody || '',
      action_url: toSmartLink(vars.action_url || vars.actionUrl, vars.deep_link),
    };
    const html = Mustache.render(tpl, templateVars);
    const textLines: string[] = [];
    textLines.push(subject);
    textLines.push('');
    if (templateVars.summary_title) textLines.push(String(templateVars.summary_title));
    if (templateVars.summary_body) textLines.push(String(templateVars.summary_body));
    textLines.push('');
    textLines.push(`Tenant: ${templateVars.tenant_name}`);
    if (templateVars.action_url) {
      textLines.push('');
      textLines.push(`Open: ${templateVars.action_url}`);
    }
    return { subject, html, text: textLines.join('\n') };
  }

  if (kind === 'team_membership_change') {
    const tenantName = (vars.tenant_name || vars.coaching_name || vars.from_name || 'your coaching center').toString();
    const subject = provided
      ? String(vars.subject).trim()
      : `Team update • ${tenantName}`;
    const templateVars: Record<string, any> = {
      ...vars,
      subject,
      tenant_name: vars.tenant_name || tenantName,
      summary_title: vars.summary_title || vars.summaryTitle || subject,
      summary_body: vars.summary_body || vars.summaryBody || '',
    };
    const html = Mustache.render(tpl, templateVars);
    const textLines: string[] = [];
    textLines.push(subject);
    textLines.push('');
    if (templateVars.summary_title) textLines.push(String(templateVars.summary_title));
    if (templateVars.summary_body) textLines.push(String(templateVars.summary_body));
    textLines.push('');
    textLines.push(`Tenant: ${templateVars.tenant_name}`);
    if (templateVars.action) textLines.push(`Action: ${templateVars.action}`);
    if (templateVars.target_email) textLines.push(`Target: ${templateVars.target_email}`);
    if (templateVars.previous_role) textLines.push(`Previous role: ${templateVars.previous_role}`);
    if (templateVars.target_role) textLines.push(`New role: ${templateVars.target_role}`);
    if (templateVars.actor_name) textLines.push(`By: ${templateVars.actor_name}`);
    if (templateVars.reason) textLines.push(`Reason: ${templateVars.reason}`);
    return { subject, html, text: textLines.join('\n') };
  }

  if (kind === 'usage_alert') {
    const tenantName = (vars.tenant_name || vars.coaching_name || vars.from_name || 'your coaching center').toString();
    const metricLabel = (vars.metric_label || vars.metricLabel || 'Usage').toString();
    const subject = provided
      ? String(vars.subject).trim()
      : `Usage alert • ${metricLabel}${tenantName ? ` • ${tenantName}` : ''}`;
    const templateVars: Record<string, any> = {
      ...vars,
      subject,
      tenant_name: vars.tenant_name || tenantName,
      metric_label: vars.metric_label || vars.metricLabel || metricLabel,
      current_value: vars.current_value || vars.currentValue || vars.current_value_label || vars.currentValueLabel,
      usage_limit: vars.usage_limit || vars.limit_label || vars.limitLabel,
      usage_percentage: vars.usage_percentage || vars.percentage_text || vars.percentageText,
      alert_url: toSmartLink(vars.alert_url || vars.alertUrl, vars.deep_link),
      month_id: vars.month_id || vars.monthId,
    };
    const html = Mustache.render(tpl, templateVars);
    const textLines: string[] = [];
    textLines.push(subject);
    textLines.push('');
    textLines.push(`Tenant: ${templateVars.tenant_name}`);
    textLines.push(`Metric: ${templateVars.metric_label}`);
    if (templateVars.threshold) textLines.push(`Severity: ${templateVars.threshold}`);
    if (templateVars.current_value) textLines.push(`Current: ${templateVars.current_value}`);
    if (templateVars.usage_limit) textLines.push(`Limit: ${templateVars.usage_limit}`);
    if (templateVars.usage_percentage) textLines.push(`Usage: ${templateVars.usage_percentage}`);
    if (templateVars.month_id) textLines.push(`Month: ${templateVars.month_id}`);
    if (templateVars.alert_url) {
      textLines.push('');
      textLines.push(`Open: ${templateVars.alert_url}`);
    }
    return { subject, html, text: textLines.join('\n') };
  }

  if (kind === 'tenant_join_request') {
    const tenantName = (vars.tenant_name || vars.coaching_name || vars.from_name || 'your coaching center').toString();
    const applicant = (vars.applicant_display || vars.requester_name || vars.requester_email || 'New applicant').toString();
    const requestMessage = typeof vars.request_message === 'string' ? vars.request_message.trim() : '';
    const requestId = vars.request_id ? String(vars.request_id) : '';
    const tenantId = vars.tenant_id ? String(vars.tenant_id) : '';
    const rawAdminHref = typeof vars.admin_portal_url === 'string' ? vars.admin_portal_url.trim() : '';
    const adminHref = toSmartLink(rawAdminHref, vars.deep_link) || '';
    const subject = provided ? String(vars.subject).trim() : `New join request • ${tenantName}`;
    const templateVars = {
      ...vars,
      subject,
      tenant_display: tenantName,
      applicant_display: applicant,
      request_message: requestMessage,
      has_request_message: requestMessage.length > 0,
      tenant_id: tenantId || undefined,
      has_admin_link: adminHref.length > 0,
      admin_portal_url: adminHref || undefined,
    };
    const html = Mustache.render(tpl, templateVars);
    const textLines: string[] = [];
    textLines.push(subject);
    textLines.push('');
    textLines.push(`${applicant} requested to join ${tenantName}.`);
    if (vars.requester_email) {
      textLines.push(`Email: ${vars.requester_email}`);
    }
    if (requestMessage) {
      textLines.push('');
      textLines.push('Message:');
      textLines.push(requestMessage);
    }
    if (requestId) {
      textLines.push('');
      textLines.push(`Request ID: ${requestId}`);
    }
    if (tenantId) {
      textLines.push(`Tenant ID: ${tenantId}`);
    }
    if (adminHref) {
      textLines.push('');
      textLines.push(`Review: ${adminHref}`);
    }
    textLines.push('');
    textLines.push('Open Admin Settings → Join Requests to review pending submissions.');
    return { subject, html, text: textLines.join('\n') };
  }

  if (kind === 'tenant_invite') {
    const tenantName = (vars.tenant_name || vars.coaching_name || vars.from_name || 'your coaching center').toString();
    const role = (vars.invite_role || vars.role || 'member').toString();
    const roleLabel = vars.invite_role_label || capitalize(role);
    const rawInviteLink = typeof vars.invite_link === 'string' ? vars.invite_link.trim() : '';
    const inferredDeepLink = (typeof vars.deep_link === 'string' && vars.deep_link.trim())
      ? vars.deep_link.trim()
      : inferInviteDeepLinkPath(rawInviteLink);
    const inviteLink = toSmartLink(rawInviteLink, inferredDeepLink) || '';
    const inviteMessage = typeof vars.invite_message === 'string' ? vars.invite_message.trim() : '';
    const expiresHuman = vars.expires_at_human || toHumanDate(vars.expires_at);
    const subject = provided ? String(vars.subject).trim() : `You're invited to join ${tenantName}`;
    const templateVars = {
      ...vars,
      subject,
      tenant_display: tenantName,
      invite_role_label: roleLabel,
      has_invite_message: inviteMessage.length > 0,
      invite_message: inviteMessage,
      invite_link: inviteLink || undefined,
      expires_at_human: expiresHuman,
    };
    const html = Mustache.render(tpl, templateVars);
    const textLines: string[] = [];
    textLines.push(subject);
    textLines.push('');
    textLines.push(`Role: ${roleLabel}`);
    if (expiresHuman) {
      textLines.push(`Expires: ${expiresHuman}`);
    }
    if (inviteLink) {
      textLines.push('');
      textLines.push(`Accept: ${inviteLink}`);
    }
    if (inviteMessage) {
      textLines.push('');
      textLines.push('Message:');
      textLines.push(inviteMessage);
    }
    return { subject, html, text: textLines.join('\n') };
  }

  let base: string;
  if (kind === 'custom_message_bilingual') {
    const who = vars.coaching_name || vars.from_name || 'Tuition Management';
    base = `New Message - ${who}`;
  } else {
    const who = vars.student_name ? String(vars.student_name) : 'Student';
    const due = vars.due_date ? ` - Due ${vars.due_date}` : '';
    base = `Fee Reminder - ${who}${due}`;
  }
  const emailSubject = kind === 'custom_message_bilingual'
    ? base
    : (provided ? String(vars.subject).trim() : base);
  const htmlSubject = kind === 'custom_message_bilingual'
    ? (provided ? String(vars.subject) : base)
    : emailSubject;

  const html = Mustache.render(tpl, { ...vars, subject: htmlSubject });
  const text = Mustache.render(
    `{{subject}}\n\nDear {{to_name}},\n{{#student_name}}Student: {{student_name}}\n{{/student_name}}{{#amount}}Amount: ₹{{amount}}\n{{/amount}}{{#due_date}}Due: {{due_date}}\n{{/due_date}}{{#custom_notes}}Notes: {{custom_notes}}\n{{/custom_notes}}{{#custom_message}}Message: {{custom_message}}\n{{/custom_message}}`,
    { ...vars, subject: htmlSubject }
  );
  return { subject: emailSubject, html, text };
}

