// Sends test notification emails via backend-runtime's email helpers.
// Usage: node scripts/sendTestEmails.cjs krvikrantsingh51@gmail.com

require('dotenv/config');

const path = require('path');

const distModulePath = path.join(__dirname, '..', 'dist', 'tenantNotificationEmail.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  sendTenantJoinRequestEmails,
  sendTenantInviteEmail,
  sendTeamMembershipChangeEmails,
  sendUsageAlertEmails,
} = require(distModulePath);

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Missing recipient email. Example: node scripts/sendTestEmails.cjs you@example.com');
    process.exit(2);
  }

  const tenantId = process.env.TEST_TENANT_ID || 'test-tenant';
  const tenantName = process.env.TEST_TENANT_NAME || 'Test Tenant';

  console.log('[config] EMAIL_BACKEND_BASE_URL:', process.env.EMAIL_BACKEND_BASE_URL || process.env.EXPO_PUBLIC_EMAIL_API_BASE_URL || '(missing)');
  console.log('[config] has EMAIL_BACKEND_INTERNAL_KEY:', Boolean(process.env.EMAIL_BACKEND_INTERNAL_KEY || process.env.INTERNAL_API_KEY));

  const results = {};

  results.joinRequest = await sendTenantJoinRequestEmails(
    {
      tenantId,
      tenantName,
      requestId: `req_${Date.now()}`,
      requesterEmail: 'requester@example.com',
      requesterName: 'Test Requester',
      message: 'Test join request email (backend-runtime).',
    },
    [to]
  );

  results.membershipChange = await sendTeamMembershipChangeEmails(
    {
      tenantId,
      tenantName,
      action: 'role_changed',
      targetEmail: 'member@example.com',
      targetRole: 'admin',
      previousRole: 'member',
      actorEmail: 'admin@example.com',
      actorName: 'Test Admin',
      displayName: 'Test Member',
      reason: 'test_email',
      initiatedFrom: 'system',
      summaryTitle: 'Team role updated',
      summaryBody: 'Test membership change email (backend-runtime).',
    },
    [to]
  );

  results.invite = await sendTenantInviteEmail({
    tenantId,
    tenantName,
    inviteId: `inv_${Date.now()}`,
    inviteToken: `token_${Math.random().toString(16).slice(2)}`,
    inviteeEmail: to,
    role: 'member',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    message: 'Test invite email (backend-runtime).',
  });

  results.usageAlert = await sendUsageAlertEmails(
    {
      tenantId,
      tenantName,
      monthId: '2025-12',
      metric: 'reminders',
      metricLabel: 'Reminders',
      threshold: 'warning',
      currentValueLabel: '80',
      limitLabel: '100',
      percentageText: '80%',
      severityLabel: 'Warning',
      alertUrl: process.env.TEST_ALERT_URL,
      alertId: `alert_${Date.now()}`,
    },
    [to]
  );

  console.log('\n[results]');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('[sendTestEmails] failed', err);
  process.exit(1);
});
