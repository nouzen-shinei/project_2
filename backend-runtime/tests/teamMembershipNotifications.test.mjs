import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'team-membership-guard';

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

async function startServer({
  guardImpl,
  sendResult,
} = {}) {
  const guardCalls = [];
  const sendCalls = [];

  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (authContext, tenantId, options) => {
        guardCalls.push({ authContext, tenantId, options });
        if (guardImpl) {
          return await guardImpl(authContext, tenantId, options);
        }
        return { tenantId, role: 'admin', membershipId: `${tenantId}-member` };
      },
      sendTeamMembershipChangeNotification: async (payload) => {
        sendCalls.push(payload);
        if (sendResult) {
          return sendResult;
        }
        return { ok: true };
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

  return { server, base, guardCalls, sendCalls };
}

describe('team membership notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('sends notifications when tenant guard matches request tenant', async () => {
    const { server, base, guardCalls, sendCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/notifications/team-membership`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: 'admin@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-123',
        action: 'added',
        targetEmail: 'newuser@example.com',
        targetRole: 'staff',
        metadata: { actorName: 'Admin' },
      }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-123');
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].tenantId, 'tenant-123');
    assert.strictEqual(sendCalls[0].targetEmail, 'newuser@example.com');
  });

  it('bubbles tenant guard errors before reaching handler', async () => {
    const guardImpl = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };
    const { server, base, sendCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/team-membership`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: 'admin@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-err',
        action: 'removed',
        targetEmail: 'user@example.com',
      }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(sendCalls.length, 0);
  });

  it('rejects requests missing tenantId before calling the guard', async () => {
    const { server, base, guardCalls, sendCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/notifications/team-membership`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: 'viewer@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'added',
        targetEmail: 'member@example.com',
      }),
    });

    assert.strictEqual(response.status, 400);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_required');
    assert.strictEqual(guardCalls.length, 0);
    assert.strictEqual(sendCalls.length, 0);
  });

  it('returns tenant_mismatch when guard tenant differs from payload', async () => {
    const guardImpl = async (authContext, tenantId, options) => {
      return { tenantId: 'other-tenant', role: 'admin', membershipId: `${tenantId}-member` };
    };
    const { server, base } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/team-membership`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: 'admin@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-xyz',
        action: 'role_changed',
        targetEmail: 'member@example.com',
        targetRole: 'staff',
      }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
  });
});
