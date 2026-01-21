import assert from 'assert';
import { afterEach, describe, it } from 'node:test';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = '';

const { createApp } = await import('../dist/app.js');

function makeInMemoryFirestore() {
  const store = new Map();

  function key(segments) {
    return segments.join('/');
  }

  function clone(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (Array.isArray(value)) return value.map((entry) => clone(entry));
    if (typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      // Preserve non-plain objects (e.g., firebase-admin FieldValue transforms)
      if (proto && proto !== Object.prototype) {
        return value;
      }
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = clone(v);
      }
      return out;
    }
    return value;
  }

  function isDeleteTransform(value) {
    return Boolean(value) && typeof value === 'object' && value.constructor && value.constructor.name === 'DeleteTransform';
  }

  function isServerTimestampTransform(value) {
    return Boolean(value) && typeof value === 'object' && value.constructor && value.constructor.name === 'ServerTimestampTransform';
  }

  function applyFieldTransforms(existing, patch) {
    const out = { ...(existing || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
      if (isDeleteTransform(v)) {
        delete out[k];
        continue;
      }
      if (isServerTimestampTransform(v)) {
        out[k] = new Date().toISOString();
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  class DocumentRef {
    constructor(firestore, segments) {
      this._firestore = firestore;
      this._segments = segments;
      this.id = segments[segments.length - 1];
    }

    async get() {
      const docKey = key(this._segments);
      const data = store.get(docKey);
      return {
        exists: data !== undefined,
        id: this.id,
        data: () => (data === undefined ? undefined : clone(data)),
      };
    }

    async set(data, options) {
      const merge = options && options.merge === true;
      const docKey = key(this._segments);
      if (!merge) {
        store.set(docKey, clone(data) || {});
        return;
      }
      const existing = store.get(docKey) || {};
      const existingCloned = clone(existing) || {};
      const nextPatch = clone(data) || {};
      store.set(docKey, applyFieldTransforms(existingCloned, nextPatch));
    }
  }

  class CollectionRef {
    constructor(firestore, segments) {
      this._firestore = firestore;
      this._segments = segments;
    }
    doc(id) {
      return new DocumentRef(this._firestore, [...this._segments, id]);
    }
  }

  class Transaction {
    async get(ref) {
      return await ref.get();
    }
    set(ref, data, options) {
      return ref.set(data, options);
    }
  }

  return {
    _store: store,
    collection(name) {
      return new CollectionRef(this, [name]);
    },
    async runTransaction(fn) {
      const tx = new Transaction();
      return await fn(tx);
    },
  };
}

async function startServer({ tenantId, role = 'admin', db, auditEvents }) {
  const app = createApp({
    overrides: {
      getFirestore: () => db,
      cancelRazorpaySubscription: async () => ({ ok: true }),
      resumeRazorpaySubscription: async () => ({ ok: true }),
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
        const normalized = typeof tenantIdRaw === 'string' ? tenantIdRaw.trim() : '';
        return { tenantId: normalized, role, membershipId: 'm1' };
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
  return { server, base: `http://127.0.0.1:${address.port}`, tenantId };
}

describe('billing cancellation policies', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('switch-to-free/immediate downgrades tenant immediately and writes audit metadata', async () => {
    const tenantId = 't_cancel_immediate_1';
    const db = makeInMemoryFirestore();
    const auditEvents = [];

    await db.collection('tenantBilling').doc(tenantId).set({ planId: 'pro', status: 'active' }, { merge: false });
    await db.collection('tenants').doc(tenantId).set({ billingTier: 'pro' }, { merge: false });

    const { server, base } = await startServer({ tenantId, db, auditEvents });
    servers.add(server);

    const response = await fetch(`${base}/billing/switch-to-free/immediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.planId, 'free');
    assert.equal(payload.scheduled, false);

    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    assert.equal(billingSnap.exists, true);
    assert.equal(billingSnap.data().planId, 'free');

    const tenantSnap = await db.collection('tenants').doc(tenantId).get();
    assert.equal(tenantSnap.exists, true);
    assert.equal(tenantSnap.data().billingTier, 'free');

    const found = auditEvents.find((entry) => entry.action === 'billing_downgrade_to_free');
    assert.ok(found);
    assert.equal(found.tenantId, tenantId);
    assert.equal(found.metadata.mode, 'immediate');
  });

  it('switch-to-free downgrades immediately when no provider subscription exists and writes mode=immediate', async () => {
    const tenantId = 't_switch_to_free_fallback_1';
    const db = makeInMemoryFirestore();
    const auditEvents = [];

    await db.collection('tenantBilling').doc(tenantId).set({ planId: 'pro', status: 'active' }, { merge: false });
    await db.collection('tenants').doc(tenantId).set({ billingTier: 'pro' }, { merge: false });

    const { server, base } = await startServer({ tenantId, db, auditEvents });
    servers.add(server);

    const response = await fetch(`${base}/billing/switch-to-free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.scheduled, false);
    assert.equal(payload.planId, 'free');

    const found = auditEvents.find((entry) => entry.action === 'billing_downgrade_to_free');
    assert.ok(found);
    assert.equal(found.tenantId, tenantId);
    assert.equal(found.metadata.mode, 'immediate');
  });

  it('switch-to-free schedules a Razorpay cancel-at-cycle-end and writes audit metadata', async () => {
    const tenantId = 't_schedule_razorpay_1';
    const db = makeInMemoryFirestore();
    const auditEvents = [];

    const renewalDate = new Date(Date.now() + 14 * 86400 * 1000).toISOString();
    await db.collection('tenantBilling').doc(tenantId).set(
      {
        planId: 'pro',
        status: 'active',
        billingProvider: 'razorpay',
        subscriptionId: 'sub_test_123',
        renewalDate,
      },
      { merge: false }
    );

    let cancelArgs = null;
    const app = createApp({
      overrides: {
        getFirestore: () => db,
        requireTenantMembershipAccess: async () => ({ tenantId, role: 'admin', membershipId: 'm1' }),
        logTenantAuditEvent: async (event) => auditEvents.push(event),
        cancelRazorpaySubscription: async (args) => {
          cancelArgs = args;
          return { ok: true };
        },
      },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    servers.add(server);
    const base = `http://127.0.0.1:${server.address().port}`;

    const response = await fetch(`${base}/billing/switch-to-free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.scheduled, true);
    assert.equal(payload.scheduledDowngradePlanId, 'free');

    assert.ok(cancelArgs);
    assert.equal(cancelArgs.subscriptionId, 'sub_test_123');
    assert.equal(cancelArgs.cancelAtCycleEnd, true);

    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    const billing = billingSnap.data();
    assert.equal(Boolean(billing.cancelAtCycleEnd), true);
    assert.equal(billing.scheduledDowngradePlanId, 'free');
    assert.equal(billing.scheduledDowngradeAt, renewalDate);

    const found = auditEvents.find((entry) => entry.action === 'billing_downgrade_to_free_scheduled');
    assert.ok(found);
    assert.equal(found.tenantId, tenantId);
    assert.equal(found.metadata.provider, 'razorpay');
    assert.equal(found.metadata.subscriptionId, 'sub_test_123');
  });

  it('switch-to-free is blocked when the plan is organization-managed (admin override)', async () => {
    const tenantId = 't_switch_to_free_locked_1';
    const db = makeInMemoryFirestore();
    const auditEvents = [];

    await db
      .collection('tenantBilling')
      .doc(tenantId)
      .set({ planId: 'pro', status: 'active', planLockedByOrg: true }, { merge: false });
    await db.collection('tenants').doc(tenantId).set({ billingTier: 'pro' }, { merge: false });

    const { server, base } = await startServer({ tenantId, db, auditEvents });
    servers.add(server);

    const response = await fetch(`${base}/billing/switch-to-free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error, 'plan_locked_by_org');
    assert.ok(typeof payload.message === 'string');

    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    assert.equal(billingSnap.data().planId, 'pro');
    assert.equal(auditEvents.length, 0);
  });

  it('switch-to-free/immediate is blocked when the plan is organization-managed (admin override)', async () => {
    const tenantId = 't_switch_to_free_locked_2';
    const db = makeInMemoryFirestore();
    const auditEvents = [];

    await db
      .collection('tenantBilling')
      .doc(tenantId)
      .set({ planId: 'pro', status: 'active', planLockedByOrg: true }, { merge: false });
    await db.collection('tenants').doc(tenantId).set({ billingTier: 'pro' }, { merge: false });

    const { server, base } = await startServer({ tenantId, db, auditEvents });
    servers.add(server);

    const response = await fetch(`${base}/billing/switch-to-free/immediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });

    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.error, 'plan_locked_by_org');
    assert.ok(typeof payload.message === 'string');

    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    assert.equal(billingSnap.data().planId, 'pro');
    assert.equal(auditEvents.length, 0);
  });
});
