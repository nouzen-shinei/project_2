import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'tenant-invite-guard';

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

async function startServer({ loadInvite, guardBehavior, sendResult, recordCalls = [] } = {}) {
  if (typeof loadInvite !== 'function') {
    throw new Error('loadInvite override is required');
  }

  const sendCalls = [];
  const guardCalls = [];

  const app = createApp({
    overrides: {
      loadTenantInvite: loadInvite,
      requireTenantMembershipAccess: async (authContext, tenantId, options) => {
        guardCalls.push({ authContext, tenantId, options });
        if (guardBehavior) {
          return await guardBehavior(authContext, tenantId, options);
        }
        return { tenantId, role: 'staff', membershipId: `${tenantId}-member` };
      },
      sendTenantInviteEmail: async (payload) => {
        sendCalls.push(payload);
        if (sendResult) {
          return sendResult;
        }
        return { attempted: 1, sent: 1, failed: 0, skipped: 0 };
      },
      recordTenantInviteSend: async (inviteId, actorId) => {
        recordCalls.push({ inviteId, actorId });
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

  return { server, base, sendCalls, guardCalls, recordCalls };
}

describe('tenant invite notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('sends invite emails when tenant guard passes and metadata is recorded', async () => {
    const record = {
      id: 'invite-123',
      tenantId: 'tenant-one',
      tenantName: 'Tenant One',
      email: 'newuser@example.com',
      role: 'admin',
      token: 'INVITE_TOKEN',
      invitationMessage: 'Join us',
    };

    const recordCalls = [];
    const { server, base, sendCalls, guardCalls } = await startServer({
      loadInvite: async () => record,
      recordCalls,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-invite`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-one', inviteId: 'invite-123' }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].inviteId, 'invite-123');
    assert.strictEqual(sendCalls[0].inviteeEmail, 'newuser@example.com');
    assert.strictEqual(sendCalls[0].inviteToken, 'INVITE_TOKEN');
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-one');
    assert.strictEqual(recordCalls.length, 1);
    assert.deepStrictEqual(recordCalls[0], { inviteId: 'invite-123', actorId: 'staff-user' });
  });

  it('rejects invite notifications when tenant mismatch occurs', async () => {
    const record = {
      id: 'invite-xyz',
      tenantId: 'actual-tenant',
      email: 'user@example.com',
      token: 'TOKEN',
    };

    const { server, base, sendCalls, recordCalls } = await startServer({
      loadInvite: async () => record,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-invite`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'body-tenant', inviteId: 'invite-xyz' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(sendCalls.length, 0);
    assert.strictEqual(recordCalls.length, 0);
  });

  it('propagates tenant guard errors for insufficient roles', async () => {
    const record = {
      id: 'invite-guard',
      tenantId: 'tenant-guard',
      email: 'user@example.com',
      token: 'TOKEN',
    };

    const guardBehavior = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };

    const { server, base, sendCalls } = await startServer({
      loadInvite: async () => record,
      guardBehavior,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-invite`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'not-admin' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-guard', inviteId: 'invite-guard' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(sendCalls.length, 0);
  });

  it('fails when invite token is missing', async () => {
    const record = {
      id: 'invite-no-token',
      tenantId: 'tenant-1',
      email: 'user@example.com',
    };

    const { server, base } = await startServer({
      loadInvite: async () => record,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-invite`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-1', inviteId: 'invite-no-token' }),
    });

    assert.strictEqual(response.status, 400);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'invite_token_missing');
  });
});
