import assert from 'assert';
import { afterEach, describe, it } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'usage-billing-suite';

const { createApp } = await import('../dist/app.js');

const TENANT_ID = 'tenant-usage-billing';

function buildInternalToken({ uid = 'test-admin', email = 'admin@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function formatMonthId(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function monthIdOffset(offset) {
  const base = new Date();
  const shifted = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - offset, 1));
  return formatMonthId(shifted);
}

function createUsageDocRef(monthId, alertStore) {
  return {
    path: `tenantUsage/${TENANT_ID}/months/${monthId}`,
    collection(collectionName) {
      if (collectionName !== 'alerts') {
        throw new Error(`unexpected collection ${collectionName}`);
      }
      return {
        doc(alertId) {
          const key = `${monthId}:${alertId}`;
          return {
            async get() {
              const record = alertStore.get(key);
              return {
                exists: Boolean(record),
                data: () => ({ ...(record ?? {}) }),
              };
            },
            async set(payload, options = {}) {
              const existing = alertStore.get(key) || {};
              const next = options.merge ? { ...existing, ...payload } : payload;
              alertStore.set(key, next);
            },
          };
        },
      };
    },
  };
}

function buildFixtures() {
  const currentMonthId = monthIdOffset(0);
  const previousMonthId = monthIdOffset(1);
  const usageSnapshots = new Map([
    [currentMonthId, {
      activeStudents: 120,
      staffSeatsUsed: 12,
      remindersSent: { whatsapp: 240, sms: 60, email: 12, total: 312 },
      storageMb: 3,
    }],
    [previousMonthId, {
      activeStudents: 80,
      staffSeatsUsed: 9,
      remindersSent: { total: 150 },
      storageMb: 1,
    }],
  ]);
  const alertStore = new Map([
    [`${currentMonthId}:alert-1`, {
      metric: 'reminders',
      type: 'warning',
      createdAt: new Date().toISOString(),
      details: 'Monthly reminder usage over 80% of quota',
    }],
  ]);
  const tenantSummary = {
    id: TENANT_ID,
    billingTier: 'free',
    membershipCounts: {
      total: 15,
      owners: 1,
      admins: 2,
      staff: 3,
    },
    seatUsage: {
      adminSeatsUsed: 6,
      adminSeatLimit: 10,
      remaining: 4,
    },
  };
  const billingSummary = {
    tenantId: TENANT_ID,
    planId: 'free',
    status: 'trial',
    renewalDate: new Date().toISOString(),
    checkoutRequired: true,
    invoices: [
      {
        id: 'invoice-1',
        amountInr: 4999,
        status: 'paid',
        issuedAt: new Date().toISOString(),
        provider: 'stripe',
      },
    ],
  };
  const auditEvents = [];

  return {
    usageSnapshots,
    alertStore,
    tenantSummary,
    billingSummary,
    auditEvents,
    currentMonthId,
  };
}

function createFirestoreStub() {
  const docs = new Map();
  let nextId = 0;

  // Minimal paid variant so /billing/checkout can succeed in tests.
  docs.set('billingPlanVariants/pro', {
    planId: 'pro',
    displayName: 'Pro',
    priceInr: 4999,
    active: true,
    sortOrder: 1,
    razorpayPlanId: 'plan_test_pro',
  });

  function snapshotFor(path) {
    const value = docs.get(path);
    return {
      exists: value !== undefined,
      data: () => (value !== undefined ? { ...value } : undefined),
      id: path.split('/').pop(),
    };
  }

  function makeDocRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      async get() {
        return snapshotFor(path);
      },
      async set(payload, options = {}) {
        const existing = docs.get(path) || {};
        docs.set(path, options.merge ? { ...existing, ...payload } : payload);
      },
    };
  }

  function makeCollectionRef(path) {
    return {
      path,
      doc(id) {
        const resolvedId = id ?? `doc-${++nextId}`;
        return makeDocRef(`${path}/${resolvedId}`);
      },
      async get() {
        const prefix = `${path}/`;
        const matched = Array.from(docs.entries())
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => {
            const id = key.slice(prefix.length);
            return { id, data: () => ({ ...value }) };
          });
        return { docs: matched };
      },
    };
  }

  return {
    collection(name) {
      return makeCollectionRef(name);
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          return snapshotFor(ref.path);
        },
        set(ref, payload, options = {}) {
          const existing = docs.get(ref.path) || {};
          docs.set(ref.path, options.merge ? { ...existing, ...payload } : payload);
        },
      };
      return await fn(tx);
    },
  };
}

async function startServer() {
  const fixtures = buildFixtures();
  const db = createFirestoreStub();
  const app = createApp({
    overrides: {
      getFirestore: () => db,
      requireTenantMembershipAccess: async () => ({ tenantId: TENANT_ID, role: 'admin', membershipId: 'member-1' }),
      loadTenantAdminSummary: async () => fixtures.tenantSummary,
      loadUsageMonthSnapshot: async (_tenantId, monthId) => ({
        ref: createUsageDocRef(monthId, fixtures.alertStore),
        data: fixtures.usageSnapshots.get(monthId) || {},
      }),
      loadUsageAlerts: async (_ref, monthId) => {
        return Array.from(fixtures.alertStore.entries())
          .filter(([key]) => key.startsWith(`${monthId}:`))
          .map(([key, record]) => ({
            id: key,
            metric: record.metric,
            type: record.type,
            createdAt: record.createdAt,
            acknowledgedAt: record.acknowledgedAt ?? null,
            details: record.details,
          }));
      },
      loadTenantBillingSummary: async () => fixtures.billingSummary,
      createRazorpaySubscription: async () => ({ subscriptionId: 'sub_test_1', shortUrl: 'https://rzp.io/i/test' }),
      logTenantAuditEvent: async (event) => {
        fixtures.auditEvents.push(event);
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
  return { server, base, fixtures };
}

describe('usage and billing endpoints', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('returns current usage summary with alerts', async () => {
    const { server, base, fixtures } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/usage/current?tenantId=${TENANT_ID}`, {
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
      },
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.tenantId, TENANT_ID);
    assert.equal(payload.planId, 'free');
    assert.equal(payload.reminders.total, 312);
    assert.equal(payload.reminders.whatsapp, 240);
    assert.equal(payload.alerts.length, 1);
    assert.equal(payload.alerts[0].id, `${fixtures.currentMonthId}:alert-1`);
  });

  it('returns usage history across months', async () => {
    const { server, base } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/usage/history?tenantId=${TENANT_ID}&months=2`, {
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
      },
    });

    assert.equal(response.status, 200);
    const history = await response.json();
    assert.equal(history.length, 2);
    assert.equal(typeof history[0].remindersTotal, 'number');
    assert.ok(history[0].month);
  });

  it('acknowledges usage alerts and logs an audit event', async () => {
    const { server, base, fixtures } = await startServer();
    servers.add(server);
    const alertId = `${fixtures.currentMonthId}:alert-1`;

    const response = await fetch(`${base}/usage/alerts/${encodeURIComponent(alertId)}/ack?tenantId=${TENANT_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
      },
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.ok(payload.acknowledgedAt);
    const stored = fixtures.alertStore.get(alertId);
    assert.ok(stored.acknowledgedAt);
    assert.equal(fixtures.auditEvents.some((event) => event.action === 'usage_alert_acknowledged'), true);
  });

  it('returns billing summary for the tenant', async () => {
    const { server, base, fixtures } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/billing/summary?tenantId=${TENANT_ID}`, {
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
      },
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, fixtures.billingSummary);
  });

  it('creates billing checkout sessions and audits them', async () => {
    const { server, base, fixtures } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/billing/checkout?tenantId=${TENANT_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: TENANT_ID,
        planId: 'pro',
        provider: 'razorpay',
        successUrl: 'https://admin.example.com/billing/success',
        cancelUrl: 'https://admin.example.com/billing',
        metadata: { source: 'admin_console' },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.provider, 'razorpay');
    assert.ok(typeof payload.sessionId === 'string' && payload.sessionId.length > 0);
    assert.match(payload.checkoutUrl, /\?sessionId=/);
    assert.match(payload.checkoutUrl, /tenantId=tenant-usage-billing/);
    assert.equal(fixtures.auditEvents.some((event) => event.action === 'billing_checkout_started'), true);
  });
});
