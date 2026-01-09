import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'tenant-join-request-guard';

const { createApp, TenantAccessError } = await import('../dist/app.js');

function buildInternalToken({ uid = 'user-default', email = 'user@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

async function startServer({ loadJoinRequest, guardBehavior, sendResult } = {}) {
  if (typeof loadJoinRequest !== 'function') {
    throw new Error('loadJoinRequest override is required for this test harness');
  }

  const sendCalls = [];
  const guardCalls = [];

  const app = createApp({
    overrides: {
      loadTenantJoinRequest: loadJoinRequest,
      requireTenantMembershipAccess: async (authContext, tenantId, options) => {
        guardCalls.push({ authContext, tenantId, options });
        if (guardBehavior) {
          return await guardBehavior(authContext, tenantId, options);
        }
        return { tenantId, role: 'staff', membershipId: `${tenantId}-member` };
      },
      sendTenantJoinRequestNotification: async (payload) => {
        sendCalls.push(payload);
        if (sendResult) {
          return sendResult;
        }
        return { ok: true, sent: 1, failed: 0, recipients: 1 };
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

  return { server, base, sendCalls, guardCalls };
}

describe('tenant join request notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('allows the requester to trigger notifications without tenant guard enforcement', async () => {
    const record = {
      id: 'req-owner',
      tenantId: 'tenant-alpha',
      tenantName: 'Alpha Academy',
      userId: 'applicant-uid',
      email: 'applicant@example.com',
      displayName: 'Applicant',
      message: 'Please approve me',
    };

    const { server, base, sendCalls, guardCalls } = await startServer({
      loadJoinRequest: async (requestId) => (requestId === 'req-owner' ? record : null),
      guardBehavior: () => {
        throw new Error('guard should not run for requester');
      },
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'applicant-uid', email: 'applicant@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-alpha', requestId: 'req-owner' }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].tenantId, 'tenant-alpha');
    assert.strictEqual(sendCalls[0].requesterEmail, 'applicant@example.com');
    assert.strictEqual(guardCalls.length, 0);
  });

  it('rejects requests whose tenant id does not match the stored request', async () => {
    const record = {
      id: 'req-mismatch',
      tenantId: 'tenant-actual',
      tenantName: 'Real Center',
      userId: 'another-user',
      email: 'applicant@example.com',
    };

    const { server, base } = await startServer({
      loadJoinRequest: async () => record,
      guardBehavior: () => {
        throw new Error('guard should not execute when tenant mismatch occurs first');
      },
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'staff-user', email: 'staff@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-body', requestId: 'req-mismatch' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
  });

  it('enforces staff membership for non-requester actors', async () => {
    const record = {
      id: 'req-staff',
      tenantId: 'tenant-guarded',
      tenantName: 'Guarded Center',
      userId: 'applicant-uid',
      email: 'applicant@example.com',
      displayName: 'Applicant',
    };

    const guardBehavior = async (_auth, tenantId) => ({ tenantId, role: 'admin', membershipId: `${tenantId}-member` });

    const { server, base, sendCalls, guardCalls } = await startServer({
      loadJoinRequest: async () => record,
      guardBehavior,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'admin-user', email: 'admin@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-guarded', requestId: 'req-staff' }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].tenantId, 'tenant-guarded');
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-guarded');
  });

  it('propagates tenant guard errors when membership is insufficient', async () => {
    const record = {
      id: 'req-denied',
      tenantId: 'tenant-protected',
      tenantName: 'Protected Center',
      userId: 'applicant-uid',
      email: 'applicant@example.com',
    };

    const guardBehavior = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };

    const { server, base, sendCalls } = await startServer({
      loadJoinRequest: async () => record,
      guardBehavior,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'not-admin', email: 'user@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-protected', requestId: 'req-denied' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(sendCalls.length, 0);
  });
});
