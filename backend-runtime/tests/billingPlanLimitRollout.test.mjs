import assert from 'assert';
import { describe, it } from 'node:test';

process.env.TEST_MODE = '1';

const { resolveEffectivePlanLimitsForTenant } = await import('../dist/lib/effectivePlanLimits.js');
const { createApp } = await import('../dist/app.js');

function makeInMemoryFirestore() {
  const store = new Map();

  function key(collectionName, docId) {
    return `${collectionName}/${docId}`;
  }

  function listCollection(collectionName) {
    const prefix = `${collectionName}/`;
    const out = [];
    for (const [k, v] of store.entries()) {
      if (k.startsWith(prefix)) {
        const id = k.slice(prefix.length);
        out.push({ id, data: v });
      }
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  function docRef(collectionName, docId) {
    const docKey = key(collectionName, docId);
    return {
      id: docId,
      async get() {
        const data = store.get(docKey);
        return {
          exists: data !== undefined,
          id: docId,
          ref: docRef(collectionName, docId),
          data: () => (data === undefined ? undefined : data),
        };
      },
      async set(data, options) {
        const merge = options && options.merge;
        if (merge) {
          const existing = store.get(docKey) || {};
          store.set(docKey, { ...existing, ...(data || {}) });
        } else {
          store.set(docKey, data || {});
        }
      },
    };
  }

  function queryRef(collectionName, limiter) {
    return {
      limit(n) {
        return queryRef(collectionName, typeof n === 'number' ? n : limiter);
      },
      async get() {
        const rows = listCollection(collectionName);
        const sliced = typeof limiter === 'number' ? rows.slice(0, limiter) : rows;
        const docs = sliced.map((row) => ({
          id: row.id,
          exists: true,
          ref: docRef(collectionName, row.id),
          data: () => row.data,
        }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
  }

  return {
    _store: store,
    collection(collectionName) {
      return {
        doc(docId) {
          return docRef(collectionName, docId);
        },
        limit(n) {
          return queryRef(collectionName, n);
        },
        async get() {
          return queryRef(collectionName).get();
        },
      };
    },
  };
}

async function startServer({ db }) {
  const app = createApp({
    overrides: {
      getFirestore: () => db,
      // Keep tenant guard out of the way for this test.
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
        const tenantId = typeof tenantIdRaw === 'string' ? tenantIdRaw.trim() : '';
        return { tenantId, role: 'admin', membershipId: 'm1' };
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

describe('plan limit rollout', () => {
  it('immediate + soft applies increases but defers decreases', async () => {
    const db = makeInMemoryFirestore();
    const tenantId = 't_soft';

    await db.collection('tenants').doc(tenantId).set({ billingTier: 'pro', quotas: null });

    await db.collection('billingPlanVariants').doc('pro_basic').set({
      planId: 'pro',
      displayName: 'Pro Basic',
      active: true,
      sortOrder: 10,
      priceInr: 999,
      applyChangesMode: 'immediate',
      decreasePolicy: 'soft',
      limits: {
        staffSeats: 25,
        reminders: { total: 1000 },
      },
    });

    await db.collection('tenantBilling').doc(tenantId).set({
      planId: 'pro',
      planVariantId: 'pro_basic',
      limitsSnapshot: {
        staffSeats: 50,
        students: 200,
        reminders: { total: 5000, whatsapp: 2500, sms: 1500, voice: 1500, email: 5000 },
        storageBytes: 20 * 1024 * 1024 * 1024,
      },
    });

    const limits = await resolveEffectivePlanLimitsForTenant(db, tenantId, { billingTier: 'pro', quotas: null });
    assert.equal(limits.staffSeats, 50);
    // Metered limits are always enforced from live catalog.
    assert.equal(limits.reminders.total, 1000);
  });

  it('next_billing uses snapshot even if live is higher', async () => {
    const db = makeInMemoryFirestore();
    const tenantId = 't_next';

    await db.collection('tenants').doc(tenantId).set({ billingTier: 'pro', quotas: null });

    await db.collection('billingPlanVariants').doc('pro_basic').set({
      planId: 'pro',
      displayName: 'Pro Basic',
      active: true,
      sortOrder: 10,
      priceInr: 999,
      applyChangesMode: 'next_billing',
      decreasePolicy: 'soft',
      limits: {
        staffSeats: 60,
        reminders: { total: 1200 },
      },
    });

    await db.collection('tenantBilling').doc(tenantId).set({
      planId: 'pro',
      planVariantId: 'pro_basic',
      limitsSnapshot: {
        staffSeats: 25,
        students: 200,
        reminders: { total: 5000, whatsapp: 2500, sms: 1500, voice: 1500, email: 5000 },
        storageBytes: 20 * 1024 * 1024 * 1024,
      },
    });

    const limits = await resolveEffectivePlanLimitsForTenant(db, tenantId, { billingTier: 'pro', quotas: null });
    assert.equal(limits.staffSeats, 25);
    // Even in next_billing, metered limits are always live.
    assert.equal(limits.reminders.total, 1200);
  });

  it('backfill endpoint writes limitsSnapshot from canonical variant', async () => {
    process.env.INTERNAL_API_KEY = 'test_master_key';

    const db = makeInMemoryFirestore();

    // Canonical pro variant with an override so the snapshot is not just hardcoded defaults.
    await db.collection('billingPlanVariants').doc('pro').set({
      planId: 'pro',
      displayName: 'Pro (Canonical)',
      active: true,
      sortOrder: 0,
      priceInr: 999,
      applyChangesMode: 'next_billing',
      decreasePolicy: 'soft',
      limits: {
        staffSeats: 30,
        students: 210,
        reminders: { total: 5100, whatsapp: 2500, sms: 1500, voice: 1500, email: 5100 },
        storageMb: 20480,
      },
    });

    await db.collection('tenantBilling').doc('t1').set({ planId: 'pro', planVariantId: null });

    const { server, base } = await startServer({ db });
    try {
      const response = await fetch(`${base}/billing/admin/limits-snapshot/backfill`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
        },
        body: JSON.stringify({ confirm: true, limit: 10 }),
      });

      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.dryRun, false);
      assert.equal(payload.updated, 1);

      const snap = await db.collection('tenantBilling').doc('t1').get();
      const data = snap.data() || {};
      assert.ok(data.limitsSnapshot);
      assert.equal(data.limitsSnapshot.staffSeats, 30);
      assert.equal(data.limitsSnapshot.students, 210);
      assert.equal(data.limitsSnapshot.reminders.total, 5100);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
