import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'twilio-tenant-tests';

const { createApp, TenantAccessError } = await import('../dist/app.js');

function createFirestoreStub() {
  const docs = new Map();

  function defaultTenantDoc() {
    return {
      billingTier: 'free',
      quotas: {
        // 0 = unlimited in enforcement helper (treated as "no quota"), keeps tests deterministic.
        maxMonthlyReminders: 0,
      },
    };
  }

  function snapshotFor(path) {
    if (path.startsWith('tenants/') && !docs.has(path)) {
      docs.set(path, defaultTenantDoc());
    }
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

function buildInternalToken({ uid = 'staff-user', email = 'staff@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

async function startServer({ guardImpl, smsImpl, voiceImpl, auditImpl } = {}) {
  const guardCalls = [];
  const smsCalls = [];
  const voiceCalls = [];
  const auditCalls = [];
  const db = createFirestoreStub();

  const app = createApp({
    overrides: {
      getFirestore: () => db,
      requireTenantMembershipAccess: async (authContext, tenantId, options) => {
        guardCalls.push({ authContext, tenantId, options });
        if (guardImpl) {
          return await guardImpl(authContext, tenantId, options);
        }
        return { tenantId, role: 'staff', membershipId: `${tenantId}-member` };
      },
      sendSMS: async (payload) => {
        smsCalls.push(payload);
        if (smsImpl) {
          return await smsImpl(payload);
        }
        return { success: true, sid: 'sms-sid' };
      },
      sendVoiceCall: async (payload) => {
        voiceCalls.push(payload);
        if (voiceImpl) {
          return await voiceImpl(payload);
        }
        return { success: true, sid: 'voice-sid', fallback: null };
      },
      logTenantAuditEvent: async (payload) => {
        auditCalls.push(payload);
        if (auditImpl) {
          await auditImpl(payload);
        }
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

  return { server, base, guardCalls, smsCalls, voiceCalls, auditCalls };
}

describe('twilio tenant notifications', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('dispatches tenant-scoped SMS with audit logging', async () => {
    const { server, base, guardCalls, smsCalls, auditCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/twilio/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-sms', to: '+15550001', message: 'Hello world' }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.success, true);
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(guardCalls[0].tenantId, 'tenant-sms');
    assert.strictEqual(smsCalls.length, 1);
    assert.strictEqual(smsCalls[0].to, '+15550001');
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].metadata.channel, 'twilio_sms');
  });

  it('rejects SMS payloads when tenantId mismatches guard', async () => {
    const guardImpl = async () => ({ tenantId: 'actual-tenant', role: 'staff', membershipId: 'member' });
    const { server, base, smsCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/twilio/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'body-tenant', to: '+15550002', message: 'Mismatch' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_mismatch');
    assert.strictEqual(smsCalls.length, 0);
  });

  it('bubbles tenant guard errors for SMS endpoint', async () => {
    const guardImpl = async () => {
      throw new TenantAccessError(403, { error: 'tenant_role_insufficient' });
    };
    const { server, base, smsCalls } = await startServer({ guardImpl });
    servers.add(server);

    const response = await fetch(`${base}/twilio/sms`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ uid: 'limited' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-guard', to: '+15550003', message: 'Denied' }),
    });

    assert.strictEqual(response.status, 403);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'tenant_role_insufficient');
    assert.strictEqual(smsCalls.length, 0);
  });

  it('returns 500 when Twilio voice call fails', async () => {
    const voiceImpl = async () => ({ success: false, error: 'twilio_down' });
    const { server, base, voiceCalls } = await startServer({ voiceImpl });
    servers.add(server);

    const response = await fetch(`${base}/twilio/voice-call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-voice', to: '+15550004', message: 'Call now' }),
    });

    assert.strictEqual(response.status, 500);
    const payload = await response.json();
    assert.strictEqual(payload.error, 'twilio_down');
    assert.strictEqual(voiceCalls.length, 1);
  });

  it('logs audit metadata for successful voice calls', async () => {
    const { server, base, guardCalls, voiceCalls, auditCalls } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/twilio/voice-call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: 'tenant-voice', to: '+15550005', message: 'Hello', language: 'hindi' }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.success, true);
    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(voiceCalls.length, 1);
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].metadata.channel, 'twilio_voice');
    assert.strictEqual(auditCalls[0].metadata.language, 'hindi');
  });
});
