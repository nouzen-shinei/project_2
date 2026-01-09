import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'default-guard-test';

const { createApp } = await import('../dist/app.js');

function buildInternalToken({ uid = 'tenant-guard-user', email = 'tenant.guard@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

describe('default tenant guard', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('sets tenant access once for tenant body routes', async () => {
    let guardCalls = 0;
    const jobInvocations = [];

    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (_authContext, tenantId) => {
          guardCalls += 1;
          return { tenantId, role: 'owner', membershipId: `member-${tenantId}` };
        },
        runDailyQuoteJob: async (options) => {
          jobInvocations.push(options);
          return { ok: true, dispatched: 1 };
        },
        logTenantAuditEvent: async () => {},
      },
    });

    const server = app.listen(0);
    servers.add(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server address unavailable');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-quote', timeOfDay: 'morning' }),
    });

    const payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(payload, { ok: true, stats: { ok: true, dispatched: 1 } });
    assert.strictEqual(guardCalls, 1);
    assert.strictEqual(jobInvocations.length, 1);
    assert.strictEqual(jobInvocations[0].tenantId, 'tenant-quote');
  });

  it('bypasses default guard for join-request notifications', async () => {
    let guardCalls = 0;
    let notifyCalls = 0;

    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (...args) => {
          guardCalls += 1;
          return { tenantId: args[1], role: 'member', membershipId: 'member-pre' };
        },
        loadTenantJoinRequest: async () => ({
          id: 'req-123',
          tenantId: 'tenant-pre',
          tenantName: 'Tenant Pre',
          userId: 'applicant-user',
          email: 'applicant@example.com',
          displayName: 'Applicant',
          message: 'please approve',
        }),
        sendTenantJoinRequestNotification: async () => {
          notifyCalls += 1;
          return { ok: true };
        },
      },
    });

    const server = app.listen(0);
    servers.add(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server address unavailable');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/notifications/tenant-join-request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'applicant-user', email: 'applicant@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-pre', requestId: 'req-123' }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(guardCalls, 0);
    assert.strictEqual(notifyCalls, 1);
  });
});
