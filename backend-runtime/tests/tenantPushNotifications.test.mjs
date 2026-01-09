import assert from 'assert';
import { describe, it, afterEach, after } from 'node:test';
import crypto from 'crypto';

const ORIGINAL_TEST_MODE = process.env.TEST_MODE;
process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'push-proxy-test';

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
  executorImpl,
  auditImpl,
} = {}) {
  const guardCalls = [];
  const executorCalls = [];
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
      executeExpoPushProxyRequest: async (options) => {
        executorCalls.push(options);
        if (executorImpl) {
          return await executorImpl(options);
        }
        return { status: 200, ok: true, body: { data: { status: 'ok', id: 'stub' } } };
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

  return { server, base, guardCalls, executorCalls, auditCalls };
}

describe('tenant push notifications', () => {
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

  it('sends push notifications when guard passes', async () => {
    const previousMode = process.env.TEST_MODE;
    process.env.TEST_MODE = '0';
    try {
      const auditEvents = [];
      const { server, base, guardCalls, executorCalls, auditCalls } = await startServer({
        auditImpl: async (payload) => auditEvents.push(payload),
      });
      servers.add(server);

      const response = await fetch(`${base}/notifications/push`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${buildInternalToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tenantId: 'tenant-push',
          to: ['ExponentPushToken[abc]', 'ExponentPushToken[def]'],
          title: 'Hello',
          body: 'World',
        }),
      });

      assert.strictEqual(response.status, 200);
      const payload = await response.json();
      assert.deepStrictEqual(payload, { data: { status: 'ok', id: 'stub' } });
      assert.strictEqual(guardCalls.length, 1);
      assert.strictEqual(guardCalls[0].tenantId, 'tenant-push');
      assert.strictEqual(executorCalls.length, 1);
      assert.strictEqual(executorCalls[0].payload.to.length, 2);
      assert.strictEqual(auditCalls.length, 1);
      assert.strictEqual(auditEvents.length, 1);
      assert.strictEqual(auditEvents[0].tenantId, 'tenant-push');
      assert.strictEqual(auditEvents[0].metadata.status, 200);
    } finally {
      if (typeof previousMode === 'string') {
        process.env.TEST_MODE = previousMode;
      } else {
        delete process.env.TEST_MODE;
      }
    }
  });

  it('rejects mismatched tenant payloads before hitting executor', async () => {
    const guardImpl = async () => ({ tenantId: 'tenant-actual', role: 'staff', membershipId: 'tenant-actual-member' });
    const { server, base, executorCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'wrong-tenant', to: 'ExponentPushToken[token]' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(executorCalls.length, 0);
  });

  it('bubbles tenant guard errors', async () => {
    const guardImpl = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };
    const { server, base, executorCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/notifications/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'staff-limited' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-guard', to: 'ExponentPushToken[token]' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(executorCalls.length, 0);
  });

  it('returns expo errors verbatim when executor reports failure', async () => {
    const previousMode = process.env.TEST_MODE;
    process.env.TEST_MODE = '0';
    try {
      const executorImpl = async () => ({
        status: 500,
        ok: false,
        body: { error: 'expo_error' },
        rawBody: '{"error":"expo_error"}',
      });
      const { server, base, auditCalls } = await startServer({ executorImpl });
      servers.add(server);

      const response = await fetch(`${base}/notifications/push`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${buildInternalToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tenantId: 'tenant-fail', to: 'ExponentPushToken[token]' }),
      });

      assert.strictEqual(response.status, 500);
      const payload = await response.json();
      assert.deepStrictEqual(payload, { error: 'expo_error' });
      assert.strictEqual(auditCalls.length, 0);
    } finally {
      if (typeof previousMode === 'string') {
        process.env.TEST_MODE = previousMode;
      } else {
        delete process.env.TEST_MODE;
      }
    }
  });

  it('short-circuits when TEST_MODE is enabled', async () => {
    process.env.TEST_MODE = '1';
    const { server, base, executorCalls, auditCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/notifications/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-test', to: 'ExponentPushToken[token]' }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.data.status, 'ok');
    assert.strictEqual(payload.data.details, 'expo push skipped in test mode');
    assert.strictEqual(executorCalls.length, 0);
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].metadata.testMode, true);
  });
});
