import test from 'node:test';
import assert from 'node:assert/strict';

import * as mod from '../dist/jobs/billingAutoCancelStalePending.js';

function createFakeFirestore() {
  const store = new Map();

  const makeRef = (path) => ({
    path,
    id: path.split('/').pop(),
  });

  const db = {
    collection(name) {
      return {
        doc(id) {
          const path = `${name}/${id}`;
          const ref = makeRef(path);

          return {
            id,
            path,
            async get() {
              if (!store.has(path)) {
                return { exists: false, data: () => undefined };
              }
              const data = store.get(path);
              return { exists: true, data: () => data };
            },
            set(data, _opts) {
              const prev = store.get(path) || {};
              store.set(path, { ...prev, ...data });
              return Promise.resolve();
            },
            delete() {
              store.delete(path);
              return Promise.resolve();
            },
            ref,
          };
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        async get(docRef) {
          const path = docRef.path;
          if (!store.has(path)) {
            return { exists: false, data: () => undefined };
          }
          const data = store.get(path);
          return { exists: true, data: () => data };
        },
        set(docRef, data, _opts) {
          const path = docRef.path;
          const prev = store.get(path) || {};
          store.set(path, { ...prev, ...data });
        },
        delete(docRef) {
          store.delete(docRef.path);
        },
      };
      return fn(tx);
    },
  };

  return { db, store };
}

test('computeAttemptKey is deterministic', () => {
  assert.ok(mod.__testOnly);
  const { computeAttemptKey } = mod.__testOnly;

  const a = computeAttemptKey({ provider: 'razorpay', subscriptionId: 'sub_123', sinceIso: '2026-01-01T00:00:00.000Z' });
  const b = computeAttemptKey({ provider: 'razorpay', subscriptionId: 'sub_123', sinceIso: '2026-01-01T00:00:00.000Z' });
  assert.equal(a, b);
  assert.equal(a, 'razorpay:sub_123:2026-01-01T00:00:00.000Z');
});

test('computeAttemptKey prefers billingAttemptId when present', () => {
  const { computeAttemptKey } = mod.__testOnly;
  const a = computeAttemptKey({
    attemptId: 'sess_abc',
    provider: 'razorpay',
    subscriptionId: 'sub_123',
    sinceIso: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(a, 'attempt:sess_abc');
});

test('computeSyntheticFailedInvoiceDocId is deterministic', () => {
  const { computeSyntheticFailedInvoiceDocId } = mod.__testOnly;
  const id1 = computeSyntheticFailedInvoiceDocId('razorpay:sub_123:2026-01-01T00:00:00.000Z');
  const id2 = computeSyntheticFailedInvoiceDocId('razorpay:sub_123:2026-01-01T00:00:00.000Z');
  assert.equal(id1, id2);
  assert.match(id1, /^auto_failed_[a-f0-9]{24}$/);
});

test('acquireTenantLease prevents concurrent acquisition', async () => {
  const { acquireTenantLease } = mod.__testOnly;
  const { db } = createFakeFirestore();

  const lease1 = await acquireTenantLease({
    db,
    tenantId: 't1',
    leaseMs: 180000,
    jobLabel: 'test',
    runId: 'runA',
  });
  assert.ok(lease1);

  const lease2 = await acquireTenantLease({
    db,
    tenantId: 't1',
    leaseMs: 180000,
    jobLabel: 'test',
    runId: 'runB',
  });
  assert.equal(lease2, null);

  await lease1.release();

  const lease3 = await acquireTenantLease({
    db,
    tenantId: 't1',
    leaseMs: 180000,
    jobLabel: 'test',
    runId: 'runC',
  });
  assert.ok(lease3);
  await lease3.release();
});
