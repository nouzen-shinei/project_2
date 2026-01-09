import assert from 'assert';
import { describe, it } from 'node:test';

import { finalizeReminderQuotaFromHistory } from '../dist/lib/reminderQuota.js';

class DocumentSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = data;
    this.exists = data !== undefined;
  }
  data() {
    return this._data;
  }
}

function isServerTimestampTransform(value) {
  return value && typeof value === 'object' && value.constructor && value.constructor.name === 'ServerTimestampTransform';
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => clone(v));
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Timestamp') {
    return value;
  }
  if (isServerTimestampTransform(value)) {
    return value;
  }
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clone(v);
    return out;
  }
  return value;
}

function getNested(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setNested(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyFieldValue(existingValue, incomingValue) {
  if (incomingValue === undefined) return existingValue;
  if (isServerTimestampTransform(incomingValue)) return new Date();
  return incomingValue;
}

function mergeInto(target, patch) {
  for (const [key, incoming] of Object.entries(patch || {})) {
    if (key.includes('.')) {
      const existing = getNested(target, key);
      const next = applyFieldValue(existing, incoming);
      setNested(target, key, next);
      continue;
    }

    const existing = target[key];
    if (
      incoming &&
      typeof incoming === 'object' &&
      !Array.isArray(incoming) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      !isServerTimestampTransform(incoming)
    ) {
      mergeInto(existing, incoming);
      continue;
    }

    target[key] = applyFieldValue(existing, incoming);
  }
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
    const data = this._firestore._get(this._segments);
    return new DocumentSnapshot(this.id, data);
  }
  async set(data, options = {}) {
    this._firestore._set(this._segments, data, options);
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
  constructor(firestore) {
    this._firestore = firestore;
  }
  async get(ref) {
    return ref.get();
  }
  set(docRef, data, options = {}) {
    this._firestore._set(docRef._segments, data, options);
  }
}

class InMemoryFirestore {
  constructor() {
    this._docs = new Map();
  }
  collection(name) {
    return new CollectionRef(this, [name]);
  }
  async runTransaction(fn) {
    const tx = new Transaction(this);
    return await fn(tx);
  }
  _key(segments) {
    return segments.join('/');
  }
  _get(segments) {
    const key = this._key(segments);
    const data = this._docs.get(key);
    return data === undefined ? undefined : clone(data);
  }
  _set(segments, data, options = {}) {
    const key = this._key(segments);
    const merge = options && options.merge === true;

    const existing = this._docs.get(key);
    if (!merge || existing === undefined) {
      const next = clone(data) || {};
      this._docs.set(key, next);
      return;
    }

    const next = clone(existing) || {};
    mergeInto(next, clone(data) || {});
    this._docs.set(key, next);
  }
}

function usageDocPath(tenantId, monthId) {
  return ['tenantReminderUsage', tenantId, 'months', monthId];
}

describe('finalizeReminderQuotaFromHistory', () => {
  it('decrements in-flight once on failed and never goes negative', async () => {
    const db = new InMemoryFirestore();

    const tenantId = 'tenant-1';
    const monthId = '2025-12';
    const historyId = 'hist-1';

    await db
      .collection('tenantReminderUsage')
      .doc(tenantId)
      .collection('months')
      .doc(monthId)
      .set({
        tenantId,
        month: monthId,
        total: 0,
        sms: 0,
        inFlightTotal: 1,
        inFlightSms: 1,
      });

    await db
      .collection('reminderHistory')
      .doc(historyId)
      .set({
        tenantId,
        reminderType: 'sms',
        status: 'queued',
        createdAt: new Date('2025-12-10T00:00:00Z'),
        quota: { tenantId, channel: 'sms', monthId, inFlight: true, billed: false },
      });

    await finalizeReminderQuotaFromHistory(db, { historyId, finalStatus: 'failed' });

    const usage1 = db._get(usageDocPath(tenantId, monthId));
    assert.equal(usage1.inFlightTotal, 0);
    assert.equal(usage1.inFlightSms, 0);
    assert.equal(usage1.total, 0);
    assert.equal(usage1.sms, 0);

    // Second finalize should be idempotent.
    await finalizeReminderQuotaFromHistory(db, { historyId, finalStatus: 'failed' });

    const usage2 = db._get(usageDocPath(tenantId, monthId));
    assert.equal(usage2.inFlightTotal, 0);
    assert.equal(usage2.inFlightSms, 0);
    assert.equal(usage2.total, 0);
    assert.equal(usage2.sms, 0);

    const history = db._get(['reminderHistory', historyId]);
    assert.equal(history.quota.inFlight, false);
    assert.equal(history.quota.billed, false);
    assert.equal(history.quota.finalStatus, 'failed');
  });

  it('decrements in-flight and bills once on success (idempotent)', async () => {
    const db = new InMemoryFirestore();

    const tenantId = 'tenant-2';
    const monthId = '2025-12';
    const historyId = 'hist-2';

    await db
      .collection('tenantReminderUsage')
      .doc(tenantId)
      .collection('months')
      .doc(monthId)
      .set({
        tenantId,
        month: monthId,
        total: 0,
        sms: 0,
        inFlightTotal: 1,
        inFlightSms: 1,
      });

    await db
      .collection('reminderHistory')
      .doc(historyId)
      .set({
        tenantId,
        reminderType: 'sms',
        status: 'queued',
        createdAt: new Date('2025-12-11T00:00:00Z'),
        quota: { tenantId, channel: 'sms', monthId, inFlight: true, billed: false },
      });

    await finalizeReminderQuotaFromHistory(db, { historyId, finalStatus: 'success' });
    await finalizeReminderQuotaFromHistory(db, { historyId, finalStatus: 'success' });

    const usage = db._get(usageDocPath(tenantId, monthId));
    assert.equal(usage.inFlightTotal, 0);
    assert.equal(usage.inFlightSms, 0);
    assert.equal(usage.total, 1);
    assert.equal(usage.sms, 1);

    const history = db._get(['reminderHistory', historyId]);
    assert.equal(history.quota.inFlight, false);
    assert.equal(history.quota.billed, true);
    assert.equal(history.quota.finalStatus, 'success');
  });

  it('best-effort bills on success even if quota metadata is missing', async () => {
    const db = new InMemoryFirestore();

    const tenantId = 'tenant-3';
    const historyId = 'hist-3';
    const monthId = '2025-12';

    await db
      .collection('reminderHistory')
      .doc(historyId)
      .set({
        tenantId,
        reminderType: 'sms',
        status: 'queued',
        createdAt: new Date('2025-12-02T00:00:00Z'),
      });

    await finalizeReminderQuotaFromHistory(db, { historyId, finalStatus: 'success', fallbackMonthId: monthId });

    const usage = db._get(usageDocPath(tenantId, monthId));
    assert.equal(usage.total, 1);
    assert.equal(usage.sms, 1);
    assert.equal(usage.inFlightTotal || 0, 0);
    assert.equal(usage.inFlightSms || 0, 0);

    const history = db._get(['reminderHistory', historyId]);
    assert.equal(history.quota.tenantId, tenantId);
    assert.equal(history.quota.channel, 'sms');
    assert.equal(history.quota.monthId, monthId);
    assert.equal(history.quota.billed, true);
    assert.equal(history.quota.finalStatus, 'success');
  });
});
