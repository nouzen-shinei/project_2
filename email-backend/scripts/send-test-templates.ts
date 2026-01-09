import 'dotenv/config';

import { sendEmail } from '../src/email/orchestrator.js';
import { renderTemplate, type TemplateKind } from '../src/email/templates.js';

const to = 'krvikrantsingh51@gmail.com';

function randId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function must(value: string | undefined, name: string): string {
  const v = (value || '').trim();
  if (!v) throw new Error(`Missing required value: ${name}`);
  return v;
}

async function main() {
  // Ensure smart-link wrapping works in test emails.
  process.env.PUBLIC_WEB_APP_ORIGIN ||= 'https://tuitionmanager.app';

  const baseWeb = 'https://tuitionmanager.app';
  const testId = randId('tmpl');

  const common = {
    to_email: to,
    to_name: 'Krvi (Test)',
    from_name: 'Tuition Manager (Test)',
    reply_to: 'support@tuitionmanager.app',
    tenant_name: 'Central Coaching (Test)',
    tenant_id: `tenant_${testId}`,
  };

  const samples: Array<{ kind: TemplateKind; vars: Record<string, any> }> = [
    {
      kind: 'billing_event',
      vars: {
        ...common,
        subject: `Test: Billing update (${testId})`,
        summary_title: 'Payment received',
        summary_body: 'This is a test billing event email with sample values.',
        amount: '₹1,499',
        due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
        quotaBatchId: `batch_${testId}`,
        historyId: `hist_${testId}`,
        action_url: `${baseWeb}/billing`,
      },
    },
    {
      kind: 'usage_alert',
      vars: {
        ...common,
        subject: `Test: Usage alert (${testId})`,
        summary_body: 'This is a test usage alert email.',
        metric_label: 'SMS reminders',
        threshold: 'Warning',
        current_value: '412',
        usage_limit: '500',
        usage_percentage: '82%',
        month_id: new Date().toISOString().slice(0, 7),
        alert_url: `${baseWeb}/admin/settings/usage`,
      },
    },
    {
      kind: 'team_membership_change',
      vars: {
        ...common,
        subject: `Test: Team membership change (${testId})`,
        summary_title: 'Role updated',
        summary_body: 'This is a test email for team membership changes.',
        action: 'role_changed',
        target_email: 'new.member@example.com',
        display_name: 'New Member',
        previous_role: 'member',
        target_role: 'admin',
        actor_name: 'Owner Admin',
        actor_email: 'owner@example.com',
        initiated_from: 'Admin Console',
        reason: 'Testing email templates',
      },
    },
    {
      kind: 'tenant_invite',
      vars: {
        ...common,
        subject: `Test: Tenant invite (${testId})`,
        invite_role: 'admin',
        invite_message: 'Welcome! This is a test invite message.\n\nIf you received this by mistake, ignore it.',
        invite_link: `${baseWeb}/invite/${encodeURIComponent(randId('invite'))}`,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    },
    {
      kind: 'tenant_join_request',
      vars: {
        ...common,
        subject: `Test: Join request (${testId})`,
        requester_name: 'Applicant Tester',
        requester_email: 'applicant@example.com',
        request_id: `req_${testId}`,
        request_message: 'Hi! Please approve my join request. (Test message)',
        admin_portal_url: `${baseWeb}/admin/settings/join-requests`,
      },
    },
  ];

  // Quick config sanity so failures are obvious.
  const primary = (process.env.EMAIL_PROVIDER_PRIMARY || 'ses').trim();
  if (primary === 'ses') {
    must(process.env.AWS_SES_REGION || process.env.SES_REGION, 'AWS_SES_REGION/SES_REGION');
    must(process.env.SES_SENDER_EMAIL, 'SES_SENDER_EMAIL');
  }
  if (primary === 'resend') {
    must(process.env.RESEND_API_KEY, 'RESEND_API_KEY');
    must(process.env.RESEND_DOMAIN, 'RESEND_DOMAIN');
  }

  for (const sample of samples) {
    const rendered = renderTemplate(sample.kind, sample.vars);
    const res = await sendEmail({
      to,
      kind: sample.kind === 'fee_reminder' ? 'fee' : 'custom',
      studentName: 'Test Student',
      messages: { en: 'Template test', hi: '' },
      order: 'english-first',
      showLabels: true,
      tenant: (sample.vars.tenant_id || '').toString(),
      fromName: sample.vars.from_name,
      replyTo: sample.vars.reply_to,
      pre: rendered,
    });

    // eslint-disable-next-line no-console
    console.log(`[${sample.kind}] ->`, res);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('send-test-templates failed:', err?.message || err);
  process.exitCode = 1;
});
