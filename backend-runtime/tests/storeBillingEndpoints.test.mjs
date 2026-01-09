import assert from 'assert';
import { afterEach, describe, it } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'store-billing-suite';

const { createApp } = await import('../dist/app.js');

const TENANT_ID = 'tenant-store-billing';

function buildInternalToken({ uid = 'store-admin', email = 'store-admin@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

async function startServer() {
  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async () => ({ tenantId: TENANT_ID, role: 'admin', membershipId: 'member-1' }),
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
  return { server, base };
}

describe('store billing endpoints', () => {
  const servers = new Set();
  const originalFlag = process.env.STORE_BILLING_ENABLED;

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
    if (originalFlag === undefined) {
      delete process.env.STORE_BILLING_ENABLED;
    } else {
      process.env.STORE_BILLING_ENABLED = originalFlag;
    }
  });

  it('rejects verification calls when feature flag is off', async () => {
    delete process.env.STORE_BILLING_ENABLED;
    const { server, base } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/billing/play/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: TENANT_ID, purchaseToken: 'test-play-token-12345' }),
    });

    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'store_billing_disabled');
  });

  it('accepts verification calls when feature flag is on', async () => {
    process.env.STORE_BILLING_ENABLED = '1';
    const { server, base } = await startServer();
    servers.add(server);

    const playResponse = await fetch(`${base}/billing/play/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: TENANT_ID, purchaseToken: 'test-play-token-12345', productId: 'plan.pro' }),
    });
    assert.equal(playResponse.status, 200);
    const playPayload = await playResponse.json();
    assert.equal(playPayload.provider, 'google_play');

    const appStoreResponse = await fetch(`${base}/billing/appstore/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: TENANT_ID, transactionId: 'txn-12345', signedTransactionInfo: 'signed-info-stub-value-1234567890' }),
    });
    assert.equal(appStoreResponse.status, 200);
    const appStorePayload = await appStoreResponse.json();
    assert.equal(appStorePayload.provider, 'app_store');
  });

  it('honors feature flag for notification listeners', async () => {
    process.env.STORE_BILLING_ENABLED = '1';
    const { server, base } = await startServer();
    servers.add(server);

    const playNotification = await fetch(`${base}/billing/play/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'play-notification' }),
    });
    assert.equal(playNotification.status, 202);

    const appStoreNotification = await fetch(`${base}/billing/appstore/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'appstore-notification' }),
    });
    assert.equal(appStoreNotification.status, 202);

    delete process.env.STORE_BILLING_ENABLED;
    const disabledNotification = await fetch(`${base}/billing/play/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'play-notification' }),
    });
    assert.equal(disabledNotification.status, 503);
  });
});
