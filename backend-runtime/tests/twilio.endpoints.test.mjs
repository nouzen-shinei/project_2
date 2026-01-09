import assert from 'assert';
import { describe, it, before, after } from 'node:test';
import { createApp } from '../dist/app.js';
import * as twilio from '../dist/twilio.js';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = 'test-internal';
process.env.TWILIO_ACCOUNT_SID = 'ACXXXX';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_PHONE_NUMBER = '+15551234567';

let server; let base; const origFetch = global.fetch;
const TEST_TENANT_ID = 'tenant-test-suite';

function createFirestoreStub() {
  const docs = new Map();
  docs.set(`tenants/${TEST_TENANT_ID}`, {
    billingTier: 'free',
    quotas: {
      // 0 = unlimited in enforcement helper (treated as "no quota"), keeps tests deterministic.
      maxMonthlyReminders: 0,
    },
  });

  function snapshotFor(path) {
    const value = docs.get(path);
    return {
      exists: value !== undefined,
      data: () => (value !== undefined ? { ...value } : undefined),
    };
  }

  function makeDocRef(path) {
    return {
      path,
      async get() {
        return snapshotFor(path);
      },
      async set(payload, options = {}) {
        const existing = docs.get(path) || {};
        docs.set(path, options.merge ? { ...existing, ...payload } : payload);
      },
      collection(name) {
        return makeCollectionRef(`${path}/${name}`);
      },
    };
  }

  function makeCollectionRef(path) {
    return {
      path,
      doc(id) {
        return makeDocRef(`${path}/${id}`);
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
function mock(){
  twilio.setFetchForTests(async (url, init) => {
    if(typeof url==='string' && url.includes('/Messages.json')) return { ok:true, json: async ()=>({ sid: 'SM-MOCK' }), text: async ()=> 'ok' };
    if(typeof url==='string' && url.includes('/Calls.json')) return { ok:true, json: async ()=>({ sid: 'CA-MOCK' }), text: async ()=> 'ok' };
    return { ok:true, json: async ()=>({}), text: async ()=> 'ok'};
  });
}

describe('twilio endpoints', () => {
  before(async () => {
    mock();
    const db = createFirestoreStub();
    const app = createApp({
      overrides: {
        getFirestore: () => db,
        requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
          const tenantId = typeof tenantIdRaw === 'string' && tenantIdRaw.trim().length
            ? tenantIdRaw.trim()
            : TEST_TENANT_ID;
          return { tenantId, role: 'staff', membershipId: 'member-test' };
        },
        logTenantAuditEvent: async () => {},
      },
    });
    server = app.listen(0);
    base = 'http://127.0.0.1:' + server.address().port;
    const issue = await fetch(base + '/internal/auth/issue', { method: 'POST', headers: { 'x-internal-secret': process.env.INTERNAL_API_KEY } });
    const data = await issue.json();
    process.env.__TOKEN = data.token;
  });
  after(()=>{ server?.close(); global.fetch = origFetch; });

  function auth(){ return { 'Authorization': 'Bearer ' + process.env.__TOKEN, 'Content-Type': 'application/json' }; }

  it('validation failure', async () => {
    const r = await fetch(base + '/twilio/sms', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ to: '123', message: '', tenantId: TEST_TENANT_ID }),
    });
    assert.equal(r.status, 400);
  });
  it('sms success', async () => {
    const r = await fetch(base + '/twilio/sms', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ to: '9998887777', message: 'Hello', tenantId: TEST_TENANT_ID }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.success, true);
  });
  it('voice success', async () => {
    const r = await fetch(base + '/twilio/voice-call', {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ to: '9998887777', message: 'Hello voice', language: 'english', tenantId: TEST_TENANT_ID }),
    });
    assert.equal(r.status, 200);
  });
  it('rate limit engages', async () => {
    process.env.TEST_MODE='0';
    let limited=false;
    for(let i=0;i<40;i++){
      const r = await fetch(base + '/twilio/sms', {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ to: '9998887777', message: 'Hello', tenantId: TEST_TENANT_ID }),
      });
      if(r.status===429){ limited=true; break; }
    }
    assert.equal(limited, true);
    process.env.TEST_MODE='1';
  });
});
