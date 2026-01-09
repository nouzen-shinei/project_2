import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'whatsapp-queue-tests';

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

async function startServer({ guardImpl, reminderImpl, customImpl, paymentImpl, auditImpl } = {}) {
  const guardCalls = [];
  const reminderCalls = [];
  const customCalls = [];
  const paymentCalls = [];
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
      enqueueReminder: (payload) => {
        reminderCalls.push(payload);
        if (reminderImpl) {
          return reminderImpl(payload);
        }
        return 'reminder-job';
      },
      enqueueCustomMessage: (payload) => {
        customCalls.push(payload);
        if (customImpl) {
          return customImpl(payload);
        }
        return 'custom-job';
      },
      enqueuePaymentConfirmation: (payload) => {
        paymentCalls.push(payload);
        if (paymentImpl) {
          return paymentImpl(payload);
        }
        return 'payment-job';
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

  return { server, base, guardCalls, reminderCalls, customCalls, paymentCalls, auditCalls };
}

describe('whatsapp queue notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('enqueues tenant fee reminders and logs audit data', async () => {
    const { server, base, guardCalls, reminderCalls, auditCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/whatsapp/queue/fee-reminder`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-fee',
        to: '+15550001',
        studentName: 'Student',
        amount: 1999,
        dueDate: '2025-12-31',
      }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.jobId, 'reminder-job');
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-fee');
    assert.strictEqual(reminderCalls.length, 1);
    assert.strictEqual(reminderCalls[0].tenantId, 'tenant-fee');
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].metadata.channel, 'whatsapp_fee');
  });

  it('rejects fee reminder payload when tenant mismatch occurs', async () => {
    const guardImpl = async () => ({ tenantId: 'actual-tenant', role: 'staff', membershipId: 'member' });
    const { server, base, reminderCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/whatsapp/queue/fee-reminder`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'body-tenant',
        to: '+15550002',
        studentName: 'Mismatch',
        amount: 1000,
        dueDate: '2025-12-31',
      }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(reminderCalls.length, 0);
  });

  it('bubbles tenant guard errors for fee reminders', async () => {
    const guardImpl = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };
    const { server, base, reminderCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/whatsapp/queue/fee-reminder`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'limited' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-guard',
        to: '+15550003',
        studentName: 'Denied',
        amount: 1500,
        dueDate: '2025-12-31',
      }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(reminderCalls.length, 0);
  });

  it('enqueues custom messages when tenant guard passes', async () => {
    const { server, base, customCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/whatsapp/queue/custom-message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-custom', to: '+15550004', message: 'Hello there' }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.jobId, 'custom-job');
    assert.strictEqual(customCalls.length, 1);
    assert.strictEqual(customCalls[0].tenantId, 'tenant-custom');
  });

  it('rejects payment confirmations when tenant mismatches guard', async () => {
    const guardImpl = async () => ({ tenantId: 'actual-tenant', role: 'staff', membershipId: 'member' });
    const { server, base, paymentCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/whatsapp/queue/payment-confirmation`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'body-tenant',
        to: '+15550005',
        studentName: 'Payment',
        amount: 2000,
        paymentDate: '2025-12-01',
      }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(paymentCalls.length, 0);
  });
});
