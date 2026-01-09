import assert from 'assert';
import { after, afterEach, describe, it } from 'node:test';

process.env.TEST_MODE = '1';
process.env.BILLING_DELINQUENCY_ENFORCEMENT_ENABLED = '1';
process.env.BILLING_DELINQUENCY_GRACE_DAYS = '7';

const originalInternalApiKey = process.env.INTERNAL_API_KEY;
process.env.INTERNAL_API_KEY = '';

const { createApp } = await import('../dist/app.js');

function makeInMemoryFirestore() {
  const store = new Map();

  function key(collectionName, docId) {
    return `${collectionName}/${docId}`;
  }

  return {
    collection(collectionName) {
      return {
        doc(docId) {
          const docKey = key(collectionName, docId);
          return {
            async get() {
              const data = store.get(docKey);
              return {
                exists: data !== undefined,
                id: docId,
                data: () => (data === undefined ? undefined : { ...data }),
              };
            },
            async set(data, options) {
              const merge = options && options.merge;
              if (merge) {
                const existing = store.get(docKey) || {};
                store.set(docKey, { ...existing, ...(data || {}) });
              } else {
                store.set(docKey, { ...(data || {}) });
              }
            },
          };
        },
      };
    },
  };
}

async function startServer({ db, role }) {
  const app = createApp({
    overrides: {
      getFirestore: () => db,
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw, _options) => {
        const tenantId = typeof tenantIdRaw === 'string' ? tenantIdRaw.trim() : '';
        return { tenantId, role, membershipId: 'm1' };
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
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe('billing delinquency enforcement', () => {
  const servers = new Set();

  after(() => {
    if (originalInternalApiKey === undefined) {
      delete process.env.INTERNAL_API_KEY;
    } else {
      process.env.INTERNAL_API_KEY = originalInternalApiKey;
    }
  });

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('auto-downgrades to Free after grace period', async () => {
    const tenantId = 't_overdue';
    const db = makeInMemoryFirestore();

    const overdueSince = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('tenantBilling').doc(tenantId).set({
      planId: 'pro',
      status: 'delinquent',
      delinquentSinceIso: overdueSince,
    });

    const { server, base } = await startServer({ db, role: 'staff' });
    servers.add(server);

    const response = await fetch(`${base}/students/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    // Enforcement should downgrade to Free and allow handler logic to run.
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.notEqual(payload.error, 'billing_past_due');

    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    assert.equal(billingSnap.exists, true);
    assert.equal(billingSnap.data().planId, 'free');

    const tenantSnap = await db.collection('tenants').doc(tenantId).get();
    assert.equal(tenantSnap.exists, true);
    assert.equal(tenantSnap.data().billingTier, 'free');
  });

  it('allows tenant-scoped requests within grace period', async () => {
    const tenantId = 't_in_grace';
    const db = makeInMemoryFirestore();

    const delinquentSince = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('tenantBilling').doc(tenantId).set({
      planId: 'pro',
      status: 'delinquent',
      delinquentSinceIso: delinquentSince,
    });

    const { server, base } = await startServer({ db, role: 'staff' });
    servers.add(server);

    const response = await fetch(`${base}/students/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    // We expect normal handler logic to run (not the billing enforcement).
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.notEqual(payload.error, 'billing_past_due');
  });

  it('does not block billing checkout endpoints (recovery path)', async () => {
    const tenantId = 't_checkout_recovery';
    const db = makeInMemoryFirestore();

    const overdueSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('tenantBilling').doc(tenantId).set({
      planId: 'pro',
      status: 'delinquent',
      delinquentSinceIso: overdueSince,
    });

    const { server, base } = await startServer({ db, role: 'admin' });
    servers.add(server);

    const response = await fetch(`${base}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    // Any 4xx is fine here; we just want to ensure delinquency enforcement doesn't block /billing/*.
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.notEqual(payload.error, 'billing_past_due');
  });
});
