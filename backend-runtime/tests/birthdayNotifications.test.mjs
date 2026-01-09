import assert from 'assert';
import { describe, it, afterEach, after } from 'node:test';
import crypto from 'crypto';

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'birthday-trigger-test';

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
      runBirthdayNotificationJob: async (payload) => {
        jobCalls.push(payload);
        if (jobImpl) {
          return await jobImpl(payload);
        }
        return {
          sent: 1,
          failed: 0,
          attemptedDeliveries: 1,
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

const basePayload = {
  emails: ['student@example.com'],
  dryRun: true,
};

describe('birthday notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
    process.env.TEST_MODE = '1';
  });

  after(() => {
    if (typeof ORIGINAL_TEST_MODE === 'string') {
      process.env.TEST_MODE = ORIGINAL_TEST_MODE;
    } else {
      delete process.env.TEST_MODE;
    }
  });

  it('runs birthday job when guard passes', async () => {
    const { server, base, guardCalls, jobCalls, auditCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/notifications/birthday/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-bday', ...basePayload }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-bday');
    assert.strictEqual(jobCalls.length, 1);
    assert.strictEqual(jobCalls[0].tenantId, 'tenant-bday');
    assert.deepStrictEqual(jobCalls[0].targetEmails, basePayload.emails);
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].action, 'birthday_job_triggered');
  });

  it('rejects tenant mismatches before job invocation', async () => {
    const guardImpl = async () => ({ tenantId: 'actual-tenant', role: 'staff', membershipId: 'actual-member' });
    const { server, base, jobCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/birthday/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'body-tenant', ...basePayload }),
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

    const response = await fetch(`${base}/notifications/birthday/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'limited-staff' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-guard', ...basePayload }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(jobCalls.length, 0);
  });

  it('validates now parameter', async () => {
    const { server, base } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/notifications/birthday/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-bday', now: 'not-a-date', ...basePayload }),
    });

    assert.strictEqual(response.status, 400);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'invalid_now');
  });

  it('propagates job failures to the response', async () => {
    const jobImpl = async () => {
      throw new Error('birthday_failed');
    };
    const { server, base } = await startServer({ jobImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/birthday/trigger`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-error', ...basePayload }),
    });

    assert.strictEqual(response.status, 500);
    const payload = await response.json();
    assert.strictEqual(payload.ok, false);
    assert.strictEqual(payload.error, 'birthday_failed');
  });
});
