import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'notification-guard-secret';

const { createApp } = await import('../dist/app.js');

const DEFAULT_TENANT_ID = 'tenant-guarded';
const DEFAULT_EMAIL = 'coach@example.com';

function buildInternalToken({ uid = 'user-tenant', email = DEFAULT_EMAIL } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function buildDailyQuoteStats(overrides = {}) {
  const now = new Date().toISOString();
  return {
    runStartedAt: now,
    runCompletedAt: now,
    dryRun: Boolean(overrides.dryRun),
    reason: overrides.reason ?? 'test',
    totalUserDocs: 1,
    totalDevices: 2,
    eligibleDevices: 2,
    attemptedDeliveries: 2,
    sent: 2,
    failed: 0,
    skipped: {
      notificationsDisabled: 0,
      dailyQuotesDisabled: 0,
      missingToken: 0,
      webDevice: 0,
      duplicateToken: 0,
      outsideWindow: 0,
      deletedDevice: 0,
    },
    timeOfDayBreakdown: {
      morning: { attempted: 1, sent: 1 },
      evening: { attempted: 1, sent: 1 },
      immediate: { attempted: 0, sent: 0 },
    },
    quote: { text: 'sample quote', author: 'tester', category: 'test' },
    recipientsSample: [],
  };
}

function buildBirthdayStats() {
  return {
    totalDocuments: 5,
    matchedToday: 1,
    notifiedCount: 1,
    tokensSent: 1,
    alreadySent: 0,
    missingDateOfBirth: 0,
    noTokens: 0,
    skippedOptOut: 0,
    whatsappEnqueued: 1,
    whatsappFailed: 0,
    forcedRecipients: 0,
  };
}

async function startServer({
  resolvedTenantId = DEFAULT_TENANT_ID,
  dailyQuoteStatsFactory = (options) => buildDailyQuoteStats(options ?? {}),
  birthdayStatsFactory = () => buildBirthdayStats(),
} = {}) {
  const auditEvents = [];
  const dailyQuoteCalls = [];
  const birthdayCalls = [];
  const smsCalls = [];
  const voiceCalls = [];
  const pushRequests = [];

  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => ({
        tenantId: resolvedTenantId,
        role: 'staff',
        membershipId: `${resolvedTenantId}-member`,
      }),
      runDailyQuoteJob: async (input) => {
        dailyQuoteCalls.push(input);
        return dailyQuoteStatsFactory(input);
      },
      runBirthdayNotificationJob: async (input) => {
        birthdayCalls.push(input);
        return birthdayStatsFactory(input);
      },
      logTenantAuditEvent: async (event) => {
        auditEvents.push(event);
      },
      sendSMS: async (payload) => {
        smsCalls.push(payload);
        return { success: true, sid: 'sms-test' };
      },
      sendVoiceCall: async (payload) => {
        voiceCalls.push(payload);
        return { success: true, sid: 'voice-test' };
      },
      fetch: async (url, init = {}) => {
        pushRequests.push({ url, init });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [{ status: 'ok' }] }),
        };
      },
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('server address unavailable');
  }
  const base = `http://127.0.0.1:${address.port}`;

  return { server, base, auditEvents, dailyQuoteCalls, birthdayCalls, smsCalls, voiceCalls, pushRequests };
}

describe('notification trigger guards', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('rejects tenant mismatches for daily quote triggers', async () => {
    const resolvedTenantId = 'tenant-guard-value';
    const { server, base, dailyQuoteCalls } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'body-tenant', timeOfDay: 'morning' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(dailyQuoteCalls.length, 0);
  });

  it('uses guard tenant for daily quotes and logs audit metadata', async () => {
    const resolvedTenantId = 'daily-guard-tenant';
    const { server, base, dailyQuoteCalls, auditEvents } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: resolvedTenantId,
        dryRun: true,
        reason: 'manual_test',
        targetEmails: ['one@example.com', 'two@example.com'],
        timeOfDay: 'evening',
      }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(dailyQuoteCalls.length, 1);
    assert.strictEqual(dailyQuoteCalls[0].tenantId, resolvedTenantId);
    assert.strictEqual(Array.isArray(dailyQuoteCalls[0].targetEmails), true);
    assert.strictEqual(auditEvents.length, 1);
    assert.strictEqual(auditEvents[0].tenantId, resolvedTenantId);
    assert.strictEqual(auditEvents[0].action, 'daily_quotes_triggered');
    assert.strictEqual(auditEvents[0].targetType, 'job');
    assert.strictEqual(auditEvents[0].metadata?.stats?.sent, 2);
  });

  it('runs birthday triggers with guard tenant and records audit entry', async () => {
    const resolvedTenantId = 'birthday-tenant';
    const { server, base, birthdayCalls, auditEvents } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/notifications/birthday/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: resolvedTenantId,
        emails: ['friend@example.com', 'friend@example.com'],
        deviceIds: ['device-1', 'device-2'],
        dryRun: true,
        skipWhatsApp: true,
        reason: 'manual_check',
      }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(birthdayCalls.length, 1);
    assert.strictEqual(birthdayCalls[0].tenantId, resolvedTenantId);
    assert.deepStrictEqual(birthdayCalls[0].targetEmails, ['friend@example.com']);
    assert.strictEqual(auditEvents.length, 1);
    const event = auditEvents[0];
    assert.strictEqual(event.action, 'birthday_job_triggered');
    assert.strictEqual(event.targetType, 'job');
    assert.strictEqual(event.metadata?.targetEmailsCount, 1);
    assert.strictEqual(event.metadata?.targetDeviceIdsCount, 2);
  });

  it('rejects tenant mismatches for Twilio SMS', async () => {
    const resolvedTenantId = 'sms-guarded';
    const { server, base, smsCalls } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/twilio/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'other-tenant', to: '+919999888877', message: 'Hello world' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(smsCalls.length, 0);
  });

  it('logs audit metadata for Twilio SMS sends', async () => {
    const resolvedTenantId = 'sms-logger';
    const { server, base, smsCalls, auditEvents } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/twilio/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: resolvedTenantId, to: '+919111222333', message: 'Fee reminder' }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.success, true);
    assert.strictEqual(smsCalls.length, 1);
    assert.strictEqual(smsCalls[0].to, '+919111222333');
    assert.strictEqual(auditEvents.length, 1);
    assert.strictEqual(auditEvents[0].metadata?.channel, 'twilio_sms');
    assert.strictEqual(auditEvents[0].metadata?.destination, '+919111222333');
  });

  it('rejects tenant mismatches for push notifications', async () => {
    const resolvedTenantId = 'push-tenant';
    const { server, base } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/notifications/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'wrong', to: 'ExponentPushToken[abc]' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
  });

  it('logs audit metadata for push notifications (test mode path)', async () => {
    const resolvedTenantId = 'push-logger';
    const { server, base, auditEvents } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/notifications/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: resolvedTenantId,
        to: 'ExponentPushToken[test]',
        title: 'Hello',
        body: 'Sample',
      }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.data.status, 'ok');
    assert.strictEqual(auditEvents.length, 1);
    assert.strictEqual(auditEvents[0].metadata?.channel, 'expo_push');
    assert.strictEqual(auditEvents[0].metadata?.testMode, true);
    assert.strictEqual(auditEvents[0].metadata?.targetCount, 1);
  });
});
