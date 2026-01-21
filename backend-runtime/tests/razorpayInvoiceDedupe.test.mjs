import assert from 'assert';
import { describe, it } from 'node:test';

process.env.TEST_MODE = '1';

const { handleRazorpayWebhook } = await import('../dist/billing/razorpay.js');

function makeQueryableInMemoryFirestore() {
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
    return (
      Boolean(value) &&
      typeof value === 'object' &&
      value.constructor &&
      value.constructor.name === 'ServerTimestampTransform'
    );
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

  function listDocsInCollection(segments) {
    const prefix = `${key(segments)}/`;
    const docs = [];
    for (const [docKey, data] of store.entries()) {
      if (!docKey.startsWith(prefix)) continue;
      const remainder = docKey.slice(prefix.length);
      if (!remainder || remainder.includes('/')) continue;
      docs.push({ id: remainder, segments: [...segments, remainder], data });
    }
    return docs;
  }

  class DocumentRef {
    constructor(firestore, segments) {
      this._firestore = firestore;
      this._segments = segments;
      this.id = segments[segments.length - 1];
    }

    collection(name) {
      return new CollectionRef(this._firestore, [...this._segments, name]);
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

    async delete() {
      store.delete(key(this._segments));
    }
  }

  class QuerySnap {
    constructor(docs) {
      this.docs = docs;
      this.empty = docs.length === 0;
    }
  }

  class Query {
    constructor(collectionRef, filters, max) {
      this._collectionRef = collectionRef;
      this._filters = filters || [];
      this._limit = max || null;
    }

    where(field, op, value) {
      return new Query(this._collectionRef, [...this._filters, { field, op, value }], this._limit);
    }

    limit(n) {
      return new Query(this._collectionRef, this._filters, Math.max(0, Math.trunc(n)));
    }

    async get() {
      const candidates = listDocsInCollection(this._collectionRef._segments);
      const filtered = candidates.filter((doc) => {
        const data = doc.data || {};
        for (const f of this._filters) {
          if (f.op !== '==') return false;
          if (data[f.field] !== f.value) return false;
        }
        return true;
      });

      const limited = this._limit ? filtered.slice(0, this._limit) : filtered;
      const docs = limited.map((doc) => {
        const ref = new DocumentRef(this._collectionRef._firestore, doc.segments);
        return { ref, id: doc.id, data: () => clone(doc.data || {}) };
      });
      return new QuerySnap(docs);
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

    async add(data) {
      const id = `auto_${Math.random().toString(16).slice(2)}_${Date.now()}`;
      const ref = this.doc(id);
      await ref.set(data, { merge: false });
      return ref;
    }

    where(field, op, value) {
      return new Query(this, [{ field, op, value }], null);
    }

    limit(n) {
      return new Query(this, [], Math.max(0, Math.trunc(n)));
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

function listInvoiceDocKeys(db, tenantId) {
  const prefix = `billingInvoices/${tenantId}/invoices/`;
  return Array.from(db._store.keys()).filter((k) => k.startsWith(prefix));
}

describe('razorpay invoice dedupe', () => {
  it('promotes synthetic OPEN invoice to PAID on payment.captured (no duplicate doc)', async () => {
    const db = makeQueryableInMemoryFirestore();
    const tenantId = 't_invoice_dedupe_1';
    const subscriptionId = 'sub_TEST_123';

    const start = 1768770000;
    const end = start + 30 * 24 * 60 * 60;

    const subscriptionAuthenticated = {
      event: 'subscription.authenticated',
      created_at: start,
      payload: {
        subscription: {
          entity: {
            id: subscriptionId,
            status: 'authenticated',
            current_start: start,
            current_end: end,
            notes: { tenantId, planId: 'pro', planVariantId: 'test2' },
          },
        },
      },
    };

    await handleRazorpayWebhook({
      db,
      rawBody: JSON.stringify(subscriptionAuthenticated),
      parsedBody: subscriptionAuthenticated,
    });

    const afterOpenKeys = listInvoiceDocKeys(db, tenantId);
    assert.equal(afterOpenKeys.length, 1);
    const openKey = afterOpenKeys[0];
    const openData = db._store.get(openKey);
    assert.equal(openData.status, 'open');
    assert.equal(openData.isSynthetic, true);
    assert.equal(openData.providerSubscriptionId, subscriptionId);

    const paymentCaptured = {
      event: 'payment.captured',
      created_at: start + 10,
      payload: {
        subscription: {
          entity: {
            id: subscriptionId,
            current_start: start,
            current_end: end,
            notes: { tenantId, planId: 'pro', planVariantId: 'test2' },
          },
        },
        payment: {
          entity: {
            id: 'pay_TEST_1',
            subscription_id: subscriptionId,
            status: 'captured',
            amount: 1000,
            currency: 'INR',
            created_at: start + 10,
            captured_at: start + 10,
            method: 'upi',
            vpa: 'ab@upi',
            email: 'payer@example.com',
            notes: { tenantId, planId: 'pro', planVariantId: 'test2' },
          },
        },
      },
    };

    await handleRazorpayWebhook({
      db,
      rawBody: JSON.stringify(paymentCaptured),
      parsedBody: paymentCaptured,
    });

    const finalKeys = listInvoiceDocKeys(db, tenantId);
    assert.equal(finalKeys.length, 1);
    assert.equal(finalKeys[0], openKey);

    const paidData = db._store.get(openKey);
    assert.equal(paidData.status, 'paid');
    assert.equal(paidData.isSynthetic, false);
    assert.equal(paidData.providerPaymentId, 'pay_TEST_1');
    assert.equal(paidData.providerSubscriptionId, subscriptionId);
    assert.equal(paidData.billingPeriodStart, new Date(start * 1000).toISOString());
    assert.equal(paidData.billingPeriodEnd, new Date(end * 1000).toISOString());
  });
});
