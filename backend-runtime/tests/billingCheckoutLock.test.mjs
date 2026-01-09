import assert from 'assert';
import { after, afterEach, describe, it } from 'node:test';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = '';

const { createApp } = await import('../dist/app.js');

function makeInMemoryFirestore() {
  const store = new Map();

  function key(segments) {
    return segments.join('/');
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function randomId() {
    return `auto_${Math.random().toString(16).slice(2)}`;
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
      store.set(docKey, { ...clone(existing), ...(clone(data) || {}) });
    }
    async delete() {
      store.delete(key(this._segments));
    }
  }

  class CollectionRef {
    constructor(firestore, segments) {
      this._firestore = firestore;
      this._segments = segments;
    }
    doc(id) {
      const finalId = id || randomId();
      return new DocumentRef(this._firestore, [...this._segments, finalId]);
    }
    async add(data) {
      const ref = this.doc();
      await ref.set(data, { merge: false });
      return { id: ref.id };
    }
    async get() {
      const prefix = key(this._segments) + '/';
      const desiredLen = this._segments.length + 1;
      const docs = [];
      for (const [docKey, value] of store.entries()) {
        if (!docKey.startsWith(prefix)) continue;
        const segs = docKey.split('/');
        if (segs.length !== desiredLen) continue;
        docs.push({
          id: segs[segs.length - 1],
          data: () => clone(value),
          exists: true,
        });
      }
      return { docs };
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
    collection(name) {
      return new CollectionRef(this, [name]);
    },
    async runTransaction(fn) {
      const tx = new Transaction();
      return await fn(tx);
    },
  };
}

async function startServer({ db }) {
  const app = createApp({
    overrides: {
      getFirestore: () => db,
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw, _options) => {
        const tenantId = typeof tenantIdRaw === 'string' ? tenantIdRaw.trim() : '';
        return { tenantId, role: 'admin', membershipId: 'm1' };
      },
      createRazorpaySubscription: async () => ({ subscriptionId: 'sub_test', shortUrl: 'https://rzp.io/i/test', raw: {} }),
      logTenantAuditEvent: async () => {},
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

describe('billing checkout lock', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  after(() => {
    delete process.env.BILLING_CHECKOUT_LOCK_TTL_MINUTES;
  });

  it('returns 409 when another checkout is in progress', async () => {
    process.env.BILLING_CHECKOUT_LOCK_TTL_MINUTES = '15';

    const tenantId = 't_lock_1';
    const db = makeInMemoryFirestore();

    // Catalog needs at least one active plan variant with a Razorpay mapping.
    await db.collection('billingPlanVariants').doc('pro_299').set(
      {
        planId: 'pro',
        displayName: 'Pro 299',
        priceInr: 299,
        interval: 'month',
        provider: 'razorpay',
        razorpayPlanId: 'plan_test_299',
        active: true,
        sortOrder: 10,
      },
      { merge: false }
    );

    const { server, base } = await startServer({ db });
    servers.add(server);

    const body = { tenantId, provider: 'razorpay', planId: 'pro', planVariantId: 'pro_299' };

    const first = await fetch(`${base}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 200);
    const firstJson = await first.json();
    assert.equal(firstJson.provider, 'razorpay');
    assert.ok(firstJson.sessionId);
    assert.ok(firstJson.checkoutUrl);

    const second = await fetch(`${base}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(second.status, 409);
    const secondJson = await second.json();
    assert.equal(secondJson.error, 'billing_checkout_in_progress');
    assert.equal(secondJson.sessionId, firstJson.sessionId);
    assert.equal(secondJson.checkoutUrl, firstJson.checkoutUrl);
  });

  it('allows a new checkout once the lock expires', async () => {
    process.env.BILLING_CHECKOUT_LOCK_TTL_MINUTES = '15';

    const tenantId = 't_lock_2';
    const db = makeInMemoryFirestore();

    await db.collection('billingPlanVariants').doc('pro_599').set(
      {
        planId: 'pro',
        displayName: 'Pro 599',
        priceInr: 599,
        interval: 'month',
        provider: 'razorpay',
        razorpayPlanId: 'plan_test_599',
        active: true,
        sortOrder: 10,
      },
      { merge: false }
    );

    // Pre-create an expired lock.
    await db.collection('billingCheckoutLocks').doc(tenantId).set(
      {
        tenantId,
        sessionId: 'old_session',
        checkoutUrl: 'https://rzp.io/i/old',
        expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      },
      { merge: false }
    );

    const { server, base } = await startServer({ db });
    servers.add(server);

    const body = { tenantId, provider: 'razorpay', planId: 'pro', planVariantId: 'pro_599' }; 
    const res = await fetch(`${base}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.sessionId);
    assert.notEqual(json.sessionId, 'old_session');
  });
});
