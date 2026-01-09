import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'daily-quote-test';

const { createApp, TenantAccessError } = await import('../dist/app.js');

function buildInternalToken({ uid = 'staff-user', email = 'staff@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

async function startServer({ guardImpl, jobImpl, auditImpl } = {}) {
  const guardCalls = [];
  const jobCalls = [];
  const auditCalls = [];

  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (authContext, tenantId, options) => {
        guardCalls.push({ authContext, tenantId, options });
        if (guardImpl) {
          return await guardImpl(authContext, tenantId, options);
        }
        return { tenantId, role: 'staff', membershipId: `${tenantId}-member` };
      },
      runDailyQuoteJob: async (payload) => {
        jobCalls.push(payload);
        if (jobImpl) {
          return await jobImpl(payload);
        }
        return {
          sent: 2,
          failed: 0,
          attemptedDeliveries: 2,
          eligibleDevices: 2,
          totalDevices: 3,
          dryRun: Boolean(payload.dryRun),
        };
      },
      logTenantAuditEvent: async (payload) => {
        auditCalls.push(payload);
        if (auditImpl) {
          await auditImpl(payload);
        }
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

  return { server, base, guardCalls, jobCalls, auditCalls };
}

describe('daily quote notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('runs the daily quote job when guard passes', async () => {
    const { server, base, guardCalls, jobCalls, auditCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-daily',
        timeOfDay: 'morning',
        targetEmails: ['a@example.com', 'b@example.com'],
        dryRun: true,
      }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.stats.dryRun, true);
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-daily');
    assert.strictEqual(jobCalls.length, 1);
    assert.strictEqual(jobCalls[0].tenantId, 'tenant-daily');
    assert.strictEqual(jobCalls[0].targetEmails.length, 2);
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].action, 'daily_quotes_triggered');
  });

  it('rejects mismatched tenant IDs before running job', async () => {
    const guardImpl = async () => ({ tenantId: 'actual-tenant', role: 'staff', membershipId: 'actual-tenant-member' });
    const { server, base, jobCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'body-tenant', timeOfDay: 'evening' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(jobCalls.length, 0);
  });

  it('bubbles tenant guard errors', async () => {
    const guardImpl = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };
    const { server, base, jobCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'limited' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-guard' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(jobCalls.length, 0);
  });

  it('returns validation errors for invalid now strings', async () => {
    const { server, base } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-daily', now: 'not-a-date' }),
    });

    assert.strictEqual(response.status, 400);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'invalid_now');
  });

  it('passes through job execution failures', async () => {
    const jobImpl = async () => {
      throw new Error('job_failed');
    };
    const { server, base } = await startServer({ jobImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/daily-quotes/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-fail' }),
    });

    assert.strictEqual(response.status, 500);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'job_failed');
  });
});
