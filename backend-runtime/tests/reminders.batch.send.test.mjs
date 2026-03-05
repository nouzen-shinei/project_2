import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createApp } from '../dist/app.js';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = 'test-internal';

delete process.env.EMAIL_BACKEND_BASE_URL;
delete process.env.EXPO_PUBLIC_EMAIL_API_BASE_URL;
delete process.env.EMAIL_BACKEND_INTERNAL_KEY;
delete process.env.INTERNAL_API_KEY_BEARER;
delete process.env.EMAIL_BACKEND_BEARER;

const TEST_TENANT_ID = 'tenant-reminders-suite';

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

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
  }
  forEach(cb) {
    for (const doc of this.docs) cb(doc);
  }
}

function isNumericIncrementTransform(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.constructor &&
    value.constructor.name === 'NumericIncrementTransform' &&
    typeof value.operand === 'number'
  );
}

function isServerTimestampTransform(value) {
  return value && typeof value === 'object' && value.constructor && value.constructor.name === 'ServerTimestampTransform';
}

function toComparableMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  return null;
}

function clone(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => clone(v));
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'Timestamp') {
    return value;
  }
  if (isNumericIncrementTransform(value) || isServerTimestampTransform(value)) {
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
  if (incomingValue === undefined) {
    return existingValue;
  }
  if (isNumericIncrementTransform(incomingValue)) {
    const base = typeof existingValue === 'number' && Number.isFinite(existingValue) ? existingValue : 0;
    return base + incomingValue.operand;
  }
  if (isServerTimestampTransform(incomingValue)) {
    return new Date();
  }
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
      !isNumericIncrementTransform(incoming) &&
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

class QueryRef {
  constructor(firestore, collectionSegments, whereClause) {
    this._firestore = firestore;
    this._collectionSegments = collectionSegments;
    this._where = whereClause;
  }
  async get() {
    const docs = this._firestore._queryCollection(this._collectionSegments, this._where);
    return new QuerySnapshot(docs);
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
  where(field, op, value) {
    return new QueryRef(this._firestore, this._segments, { field, op, value });
  }
  async add(data) {
    const id = `auto_${Math.random().toString(16).slice(2)}`;
    const ref = this.doc(id);
    await ref.set(data, { merge: false });
    return { id };
  }
}

class Transaction {
  constructor(firestore) {
    this._firestore = firestore;
  }
  async get(refOrQuery) {
    return refOrQuery.get();
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
  _queryCollection(collectionSegments, whereClause) {
    const prefix = collectionSegments.join('/') + '/';
    const desiredLen = collectionSegments.length + 1;

    const out = [];
    for (const [key, value] of this._docs.entries()) {
      if (!key.startsWith(prefix)) continue;
      const segs = key.split('/');
      if (segs.length !== desiredLen) continue;

      if (whereClause) {
        const fieldValue = getNested(value, whereClause.field);
        if (whereClause.op === '>') {
          const a = toComparableMillis(fieldValue);
          const b = toComparableMillis(whereClause.value);
          if (a === null || b === null) continue;
          if (!(a > b)) continue;
        }
      }

      const id = segs[segs.length - 1];
      out.push(new DocumentSnapshot(id, clone(value)));
    }

    return out;
  }
}

let server;
let base;
const origFetch = global.fetch;

describe('reminders batch send endpoint', () => {
  const firestore = new InMemoryFirestore();
  let sendSmsCalls = 0;
  let sendVoiceCalls = 0;
  let enqueueCustomCalls = 0;

  before(async () => {
    const app = createApp({
      overrides: {
        getFirestore: () => firestore,
        requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
          const tenantId = typeof tenantIdRaw === 'string' && tenantIdRaw.trim().length ? tenantIdRaw.trim() : TEST_TENANT_ID;
          return { tenantId, role: 'staff', membershipId: 'member-test' };
        },
        logTenantAuditEvent: async () => {},
        sendSMS: async () => {
          sendSmsCalls += 1;
          return { success: true, sid: 'SM-MOCK' };
        },
        sendVoiceCall: async () => {
          sendVoiceCalls += 1;
          return { success: true, sid: 'CA-MOCK' };
        },
        enqueueCustomMessage: () => {
          enqueueCustomCalls += 1;
          return 'JOB-MOCK-1';
        },
        enqueueReminder: () => 'JOB-MOCK-FEE',
      },
    });

    server = app.listen(0);
    base = 'http://127.0.0.1:' + server.address().port;

    const issue = await fetch(base + '/internal/auth/issue', {
      method: 'POST',
      headers: { 'x-internal-secret': process.env.INTERNAL_API_KEY },
    });
    const data = await issue.json();
    process.env.__TOKEN = data.token;
  });

  after(() => {
    server?.close();
    global.fetch = origFetch;
  });

  function auth() {
    return { Authorization: 'Bearer ' + process.env.__TOKEN, 'Content-Type': 'application/json' };
  }

  it('returns per-item results for mixed batch', async () => {
    const payload = {
      tenantId: TEST_TENANT_ID,
      batchId: 'batch-1',
      items: [
        {
          type: 'sms',
          studentId: 's1',
          to: '+15551230001',
          message: 'Hello SMS',
          historyId: 'hist-sms-1',
          history: { studentId: 's1', studentName: 'A', destination: '+15551230001' },
        },
        {
          type: 'voice',
          studentId: 's2',
          to: '+15551230002',
          message: 'Hello voice',
          language: 'english',
          historyId: 'hist-voice-1',
          history: { studentId: 's2', studentName: 'B', destination: '+15551230002' },
        },
        {
          type: 'whatsapp',
          kind: 'custom',
          studentId: 's3',
          to: '+15551230003',
          message: 'Hello WA',
          historyId: 'hist-wa-1',
          history: { studentId: 's3', studentName: 'C', destination: '+15551230003' },
        },
        {
          type: 'email',
          studentId: 's4',
          email: {
            template: 'fee_reminder',
            to_email: 'test@example.com',
            to_name: 'Test',
          },
          historyId: 'hist-email-1',
          history: { studentId: 's4', studentName: 'D', destination: 'test@example.com' },
        },
      ],
    };

    const r = await fetch(base + '/reminders/batch/send', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify(payload),
    });

    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.tenantId, TEST_TENANT_ID);
    assert.equal(body.batchId, 'batch-1');

    assert.equal(Array.isArray(body.results), true);
    assert.equal(body.results.length, 4);

    const sms = body.results.find((x) => x.type === 'sms');
    const voice = body.results.find((x) => x.type === 'voice');
    const wa = body.results.find((x) => x.type === 'whatsapp');
    const email = body.results.find((x) => x.type === 'email');

    assert.equal(sms.status, 'success');
    assert.equal(voice.status, 'success');
    assert.equal(wa.status, 'queued');
    assert.equal(typeof wa.jobId, 'string');
    assert.equal(email.status, 'failed');
    assert.equal(email.message, 'email_backend_not_configured');

    assert.equal(sendSmsCalls, 1);
    assert.equal(sendVoiceCalls, 1);
    assert.equal(enqueueCustomCalls, 1);
  });

  it('skips send when historyId already exists', async () => {
    await firestore
      .collection('reminderHistory')
      .doc('hist-skip-1')
      .set({ tenantId: TEST_TENANT_ID, reminderType: 'sms', status: 'success', updatedAt: new Date() }, { merge: false });

    const r = await fetch(base + '/reminders/batch/send', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        tenantId: TEST_TENANT_ID,
        batchId: 'batch-2',
        items: [
          {
            type: 'sms',
            studentId: 's10',
            to: '+15551239999',
            message: 'Should not send',
            historyId: 'hist-skip-1',
          },
        ],
      }),
    });

    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].status, 'success');

    const reservationSnap = await firestore
      .collection('tenantReminderReservations')
      .doc(TEST_TENANT_ID)
      .collection('months')
      .doc(body.monthId)
      .collection('batches')
      .doc('batch-2')
      .get();
    assert.equal(reservationSnap.exists, true);
    const reservation = reservationSnap.data() || {};
    assert.equal(reservation.totalRemaining, 0);
    assert.equal((reservation.remaining || {}).sms, 0);

    assert.equal(sendSmsCalls, 1);
  });

  it('skips send for existing history even when reservation is expired', async () => {
    const now = new Date();
    const monthId = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

    await firestore
      .collection('tenantReminderReservations')
      .doc(TEST_TENANT_ID)
      .collection('months')
      .doc(monthId)
      .collection('batches')
      .doc('batch-expired-skip')
      .set(
        {
          tenantId: TEST_TENANT_ID,
          month: monthId,
          batchId: 'batch-expired-skip',
          requested: { email: 0, sms: 1, whatsapp: 0, voice: 0 },
          remaining: { email: 0, sms: 1, whatsapp: 0, voice: 0 },
          totalRequested: 1,
          totalRemaining: 1,
          expiresAt: new Date(Date.now() - 60_000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        { merge: false },
      );

    await firestore
      .collection('reminderHistory')
      .doc('hist-skip-expired-1')
      .set({ tenantId: TEST_TENANT_ID, reminderType: 'sms', status: 'success', updatedAt: new Date() }, { merge: false });

    const r = await fetch(base + '/reminders/batch/send', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({
        tenantId: TEST_TENANT_ID,
        batchId: 'batch-expired-skip',
        items: [
          {
            type: 'sms',
            studentId: 's11',
            to: '+15551238888',
            message: 'Should not send (expired reservation + existing history)',
            historyId: 'hist-skip-expired-1',
          },
        ],
      }),
    });

    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].status, 'success');

    const reservationSnap = await firestore
      .collection('tenantReminderReservations')
      .doc(TEST_TENANT_ID)
      .collection('months')
      .doc(monthId)
      .collection('batches')
      .doc('batch-expired-skip')
      .get();
    assert.equal(reservationSnap.exists, true);
    const reservation = reservationSnap.data() || {};
    assert.equal(reservation.totalRemaining, 0);
    assert.equal((reservation.remaining || {}).sms, 0);

    // No new SMS should be sent because history was already finalized.
    assert.equal(sendSmsCalls, 1);
  });
});
