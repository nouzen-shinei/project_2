import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'tenant-guard-secret';

const { createApp } = await import('../dist/app.js');

const DEFAULT_TENANT_ID = 'tenant-abc123';
const DEFAULT_EMAIL = 'coach@example.com';

function buildInternalToken({ uid = 'user-1', email = DEFAULT_EMAIL } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', process.env.INTERNAL_API_KEY)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

function buildMembershipInspectorResponse(tenantId = DEFAULT_TENANT_ID) {
  return {
    tenant: { id: tenantId },
    members: [],
    total: 0,
    hasMore: false,
    stats: {
      filtered: { count: 0, byRole: {}, byStatus: {} },
      scanned: { count: 0, byRole: {}, byStatus: {} },
      snapshot: undefined,
    },
    filters: {
      limit: 75,
      role: 'all',
      status: 'all',
      search: undefined,
    },
  };
}

async function startServer({ resolvedTenantId = DEFAULT_TENANT_ID } = {}) {
  let lastMembershipCheckTenantId = null;
  const membershipInspectorCalls = [];
  const notificationHistoryCalls = [];

  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
        lastMembershipCheckTenantId = typeof tenantIdRaw === 'string' ? tenantIdRaw : null;
        return { tenantId: resolvedTenantId, role: 'staff', membershipId: `${resolvedTenantId}_member` };
      },
      runTenantMembershipInspector: async (input) => {
        membershipInspectorCalls.push(input);
        return buildMembershipInspectorResponse(input.tenantId);
      },
      runNotificationHistoryInspector: async (input) => {
        notificationHistoryCalls.push(input);
        return { entries: [], hasMore: false, nextCursor: undefined };
      },
      runNotificationStatsInspector: async () => ({
        windowDays: 7,
        startDate: new Date().toISOString(),
        totalNotifications: 0,
        totalRecipients: 0,
        successfulRecipients: 0,
        failedRecipients: 0,
        averageSuccessRate: 100,
        notificationsByType: {},
        notificationsByPriority: {},
        failureReasons: {},
        tenantBreakdown: [],
        lastSentAt: undefined,
      }),
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

  return {
    server,
    base,
    membershipInspectorCalls,
    notificationHistoryCalls,
    getLastMembershipCheckTenantId: () => lastMembershipCheckTenantId,
  };
}

describe('admin tenant guard endpoints', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('uses guard-resolved tenant for membership inspector payloads', async () => {
    const resolvedTenantId = 'guard-sourced-tenant';
    const { server, base, membershipInspectorCalls, getLastMembershipCheckTenantId } = await startServer({
      resolvedTenantId,
    });
    servers.add(server);

    const response = await fetch(`${base}/admin/tenants/memberships`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'body-provided-tenant', limit: 5 }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.tenant.id, resolvedTenantId);
    assert.strictEqual(membershipInspectorCalls.length, 1);
    assert.strictEqual(membershipInspectorCalls[0].tenantId, resolvedTenantId);
    assert.strictEqual(getLastMembershipCheckTenantId(), 'body-provided-tenant');
  });

  it('requires tenant context for notification history inspector when using staff tokens', async () => {
    const { server, base } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/admin/notifications/history`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 20 }),
    });

    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.strictEqual(body.error, 'tenant_required');
  });

  it('passes guard tenant to notification history inspector', async () => {
    const resolvedTenantId = 'audit-tenant-99';
    const { server, base, notificationHistoryCalls } = await startServer({ resolvedTenantId });
    servers.add(server);

    const response = await fetch(`${base}/admin/notifications/history`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'body-tenant', limit: 25 }),
    });

    assert.strictEqual(response.status, 200);
    await response.json();
    assert.strictEqual(notificationHistoryCalls.length, 1);
    assert.strictEqual(notificationHistoryCalls[0].tenantId, resolvedTenantId);
  });
});
