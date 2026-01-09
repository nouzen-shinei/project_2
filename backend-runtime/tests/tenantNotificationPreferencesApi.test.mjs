import assert from 'assert';
import { afterEach, describe, it } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'tenant-pref-suite';

const { createApp } = await import('../dist/app.js');

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
  currentPrefs,
  tenantExists = true,
} = {}) {
  const updateCalls = [];
  const auditEvents = [];
  const guardCalls = [];
  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (_authContext, tenantId) => {
        guardCalls.push(tenantId);
        return { tenantId, role: 'admin', membershipId: `${tenantId}-member` };
      },
      loadTenantNotificationPreferencesRecord: async (tenantId) => {
        if (!tenantExists) {
          return null;
        }
        return {
          tenantId,
          currentPreferences:
            currentPrefs ?? {
              membershipEventsEmail: true,
              membershipEventsPush: true,
              joinRequestEmail: true,
              joinRequestPush: true,
            },
          update: async (payload) => {
            updateCalls.push(payload);
          },
        };
      },
      logTenantAuditEvent: async (event) => {
        auditEvents.push(event);
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
  return { server, base, updateCalls, auditEvents, guardCalls };
}

describe('tenant notification preferences API', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('updates preferences with metadata, logging audit context', async () => {
    const { server, base, updateCalls, auditEvents } = await startServer({
      currentPrefs: {
        membershipEventsEmail: true,
        membershipEventsPush: true,
        joinRequestEmail: true,
        joinRequestPush: true,
      },
    });
    servers.add(server);

    const response = await fetch(`${base}/tenants/tenant-123/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
        'x-app-version': '1.2.3',
      },
      body: JSON.stringify({
        notificationPreferences: {
          joinRequestPush: false,
          membershipEventsEmail: true,
        },
        metadata: {
          initiatedFrom: 'admin_settings',
          actorName: 'Casey Admin',
          reason: 'Quiet hours',
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.changedKeys, ['joinRequestPush']);
    assert.equal(payload.notificationPreferences.joinRequestPush, false);
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].notificationPreferences.joinRequestPush, false);
    assert.equal(auditEvents.length, 1);
    assert.equal(auditEvents[0].tenantId, 'tenant-123');
    assert.equal(auditEvents[0].action, 'notification_preferences_updated');
    assert.equal(auditEvents[0].metadata.initiatedFrom, 'admin_settings');
    assert.equal(auditEvents[0].metadata.actorName, 'Casey Admin');
    assert.equal(auditEvents[0].metadata.reason, 'Quiet hours');
    assert.equal(auditEvents[0].metadata.clientVersion, '1.2.3');
    assert.deepEqual(auditEvents[0].metadata.changedKeys, ['joinRequestPush']);
  });

  it('rejects unknown preference keys', async () => {
    const { server, base, updateCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/tenants/tenant-999/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        notificationPreferences: {
          joinRequestEmail: true,
          unexpectedKey: false,
        },
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, 'validation_failed');
    assert.equal(updateCalls.length, 0);
  });

  it('returns 404 when tenant data is missing', async () => {
    const { server, base } = await startServer({ tenantExists: false });
    servers.add(server);

    const response = await fetch(`${base}/tenants/tenant-missing/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        notificationPreferences: {
          membershipEventsPush: false,
        },
      }),
    });

    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error, 'tenant_not_found');
  });
});
