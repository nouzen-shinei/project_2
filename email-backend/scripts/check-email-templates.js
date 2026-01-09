/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const Mustache = require('mustache');

const kinds = [
  'billing_event',
  'usage_alert',
  'team_membership_change',
  'tenant_invite',
  'tenant_join_request',
];

const fileByKind = {
  billing_event: 'billing_event.html',
  usage_alert: 'usage_alert.html',
  team_membership_change: 'team_membership_change.html',
  tenant_invite: 'tenant_invite.html',
  tenant_join_request: 'tenant_join_request.html',
};

const samples = {
  billing_event: {
    to_name: 'Alex',
    to_email: 'alex@example.com',
    from_name: 'Acme Tuition',
    tenant_name: 'Acme Center',
    summary_title: 'Payment received',
    summary_body: 'We received your payment successfully.',
    action_url: 'https://example.com/billing',
    amount: '₹2,500',
    due_date: '2026-01-10',
    historyId: 'hist_123',
    quotaBatchId: 'batch_9',
    subject: 'Billing update • Acme Center',
  },
  usage_alert: {
    to_name: 'Alex',
    to_email: 'alex@example.com',
    from_name: 'Acme Tuition',
    tenant_name: 'Acme Center',
    metric_label: 'Email quota',
    threshold: 'High',
    current_value: '920 emails',
    usage_limit: '1000 emails',
    usage_percentage: '92%',
    month_id: '2026-01',
    alert_url: 'https://example.com/usage',
    tenant_id: 't_1',
    subject: 'Usage alert • Email quota • Acme Center',
  },
  team_membership_change: {
    to_name: 'Alex',
    to_email: 'alex@example.com',
    from_name: 'Acme Tuition',
    tenant_name: 'Acme Center',
    subject: 'Team update • Acme Center',
    summary_title: 'Role updated',
    summary_body: 'Sam was promoted to Admin.',
    action: 'role_change',
    display_name: 'Sam',
    target_email: 'sam@example.com',
    previous_role: 'member',
    target_role: 'admin',
    actor_name: 'Alex',
    actor_email: 'alex@example.com',
    initiated_from: 'Admin Settings',
    reason: 'Required to manage billing',
  },
  tenant_invite: {
    to_name: 'Alex',
    to_email: 'alex@example.com',
    from_name: 'Acme Tuition',
    tenant_display: 'Acme Center',
    subject: "You're invited to join Acme Center",
    invite_role_label: 'Admin',
    has_invite_message: true,
    invite_message: 'Welcome aboard! Please join today.',
    invite_link: 'https://example.com/invite',
    expires_at_human: 'Jan 20, 2026, 5:30 PM',
    reply_to: 'support@example.com',
  },
  tenant_join_request: {
    to_name: 'Alex',
    to_email: 'alex@example.com',
    from_name: 'Acme Tuition',
    tenant_display: 'Acme Center',
    subject: 'New join request • Acme Center',
    applicant_display: 'Jamie',
    requester_email: 'jamie@example.com',
    request_id: 'req_777',
    tenant_id: 't_1',
    request_message: 'I am a new teacher, please approve.',
    has_request_message: true,
    has_admin_link: true,
    admin_portal_url: 'https://example.com/admin',
    reply_to: 'support@example.com',
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const kind of kinds) {
  const file = fileByKind[kind];
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', file), 'utf8');
  const html = Mustache.render(tpl, samples[kind]);

  assert(html.includes('<html'), `bad render for ${kind}`);
  assert(!/\{\{[^}]+\}\}/.test(html), `unrendered tags for ${kind}`);

  console.log(`${kind}: ok (${html.length} chars)`);
}
