import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'tenant-join-request-outcome-guard';

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

async function startServer({ loadJoinRequest, guardBehavior, sendResult } = {}) {
  if (typeof loadJoinRequest !== 'function') {
    throw new Error('loadJoinRequest override is required');
  }

  const guardCalls = [];
  const sendCalls = [];

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
      sendTenantJoinRequestOutcomeNotification: async (payload) => {
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

  return { server, base, guardCalls, sendCalls };
}

describe('tenant join request outcome notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('sends outcome notifications for staff reviewers when tenant ids match', async () => {
    const record = {
      id: 'req-outcome',
      tenantId: 'tenant-outcome',
      tenantName: 'Outcome Academy',
      email: 'applicant@example.com',
      displayName: 'Applicant',
    };

    const { server, base, guardCalls, sendCalls } = await startServer({
      loadJoinRequest: async (requestId) => (requestId === 'req-outcome' ? record : null),
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request/outcome`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-outcome',
        requestId: 'req-outcome',
        outcome: 'approved',
        assignedRole: 'staff',
        reviewerName: 'Reviewer',
      }),
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].tenantId, 'tenant-outcome');
    assert.strictEqual(sendCalls[0].requesterEmail, 'applicant@example.com');
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-outcome');
  });

  it('rejects notifications when stored request tenant mismatches guard tenant', async () => {
    const record = {
      id: 'req-mismatch',
      tenantId: 'tenant-different',
      email: 'applicant@example.com',
    };

    const { server, base, sendCalls } = await startServer({
      loadJoinRequest: async () => record,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request/outcome`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-body', requestId: 'req-mismatch', outcome: 'rejected' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(sendCalls.length, 0);
  });

  it('propagates tenant guard failures before hitting the loader', async () => {
    const guardBehavior = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };

    const { server, base, sendCalls } = await startServer({
      loadJoinRequest: async () => ({
        id: 'req-guard',
        tenantId: 'tenant-guard',
        email: 'applicant@example.com',
      }),
      guardBehavior,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request/outcome`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'non-admin' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-guard', requestId: 'req-guard', outcome: 'approved' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(sendCalls.length, 0);
  });

  it('returns requester email unavailable when loader lacks email', async () => {
    const record = {
      id: 'req-no-email',
      tenantId: 'tenant-email',
    };

    const { server, base } = await startServer({
      loadJoinRequest: async () => record,
    });
    servers.add(server);

    const response = await fetch(`${base}/notifications/tenant-join-request/outcome`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-email', requestId: 'req-no-email', outcome: 'approved' }),
    });

    assert.strictEqual(response.status, 400);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'requester_email_unavailable');
  });
});
