import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'tenant-export-secret';

const { createApp } = await import('../dist/app.js');

function buildInternalToken({ uid = 'export-user', email = 'owner@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

describe('tenant export API', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  async function startServer(overrides = {}) {
    const auditEvents = [];
    const accessCalls = [];
    const streamCalls = [];

    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (auth, tenantIdRaw) => {
          const fallbackTenant = overrides.forceTenantId || 'tenant-a';
          const normalizedTenant = (tenantIdRaw || '').trim() || fallbackTenant;
          accessCalls.push({ tenantIdRaw, authUid: auth?.uid });
          return {
            tenantId: normalizedTenant,
            role: 'staff',
            membershipId: `${normalizedTenant}:${auth?.uid || 'uid'}`,
          };
        },
        streamTenantExport: async (options) => {
          streamCalls.push(options);
          if (typeof overrides.streamTenantExport === 'function') {
            return overrides.streamTenantExport(options);
          }
          options.writer.write(
            JSON.stringify({
              meta: { stub: true },
              students: [{ id: 'student-1', tenantId: options.tenantId }],
              statistics: { datasetCounts: { students: 1 }, totalDocuments: 1 },
            })
          );
          return {
            datasetCounts: { students: 1 },
            totalDocuments: 1,
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
    servers.add(server);
    return { base, auditEvents, accessCalls, streamCalls };
  }

  it('streams gzip payload and records audit metadata', async () => {
    const { base, auditEvents, accessCalls, streamCalls } = await startServer();

    const response = await fetch(`${base}/tenants/tenant-a/export`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
      },
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('content-encoding'), 'gzip');
    const disposition = response.headers.get('content-disposition') || '';
    assert.ok(disposition.includes('tenant-tenant-a-export'), 'content-disposition includes tenant id');

    const payload = JSON.parse(await response.text());
    assert.strictEqual(payload.meta.stub, true);
    assert.strictEqual(payload.students?.length, 1);

    assert.strictEqual(streamCalls.length, 1);
    assert.strictEqual(streamCalls[0].tenantId, 'tenant-a');
    assert.ok(streamCalls[0].writer, 'stream call receives writer');

    assert.strictEqual(accessCalls.length, 1);
    assert.strictEqual(accessCalls[0].tenantIdRaw, 'tenant-a');

    assert.strictEqual(auditEvents.length, 1);
    assert.strictEqual(auditEvents[0].action, 'tenant_data_exported');
    assert.strictEqual(auditEvents[0].tenantId, 'tenant-a');
    assert.strictEqual(auditEvents[0].metadata?.datasetCounts?.students, 1);
    assert.strictEqual(auditEvents[0].metadata?.totalDocuments, 1);
  });
});
