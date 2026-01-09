import assert from 'assert';
import { describe, it, beforeEach, afterEach, after } from 'node:test';
import crypto from 'crypto';
import { createRequire } from 'module';

const writes = [];
const require = createRequire(import.meta.url);
const firebaseAdmin = require('firebase-admin');
const adminPrototype = Object.getPrototypeOf(firebaseAdmin);
const adminCleanup = [];

function overrideDescriptor(target, name, descriptor) {
  const original = Object.getOwnPropertyDescriptor(target, name);
  adminCleanup.push(() => {
    if (original) {
      Object.defineProperty(target, name, original);
    } else {
      delete target[name];
    }
  });
  Object.defineProperty(target, name, descriptor);
}

function createFirestoreStub() {
  const recordWrite = (pathParts, data, options) => {
    writes.push({ path: pathParts.join('/'), data, options });
  };

  const createDocApi = (pathParts) => ({
    collection: (name) => createCollectionApi([...pathParts, name]),
    set: async (data, options) => recordWrite(pathParts, data, options),
  });

  const createCollectionApi = (pathParts) => ({
    doc: (id) => createDocApi([...pathParts, id]),
  });

  const firestore = () => ({
    collection: (name) => createCollectionApi([name]),
  });

  const fieldValue = {
    arrayUnion: (...values) => ({ __op: 'arrayUnion', values }),
    serverTimestamp: () => ({ __op: 'serverTimestamp', at: Date.now() }),
  };

  firestore.FieldValue = fieldValue;
  return firestore;
}

const firestoreStub = createFirestoreStub();
const appsStore = [];
const appInstance = { delete: async () => {} };

overrideDescriptor(adminPrototype, 'firestore', {
  configurable: true,
  enumerable: true,
  get: () => firestoreStub,
});

overrideDescriptor(adminPrototype, 'initializeApp', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: () => {
    appsStore[0] = appInstance;
    return appInstance;
  },
});

overrideDescriptor(adminPrototype, 'app', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: () => appInstance,
});

overrideDescriptor(adminPrototype, 'apps', {
  configurable: true,
  enumerable: true,
  get: () => appsStore,
});

overrideDescriptor(firebaseAdmin, 'credential', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: {
    applicationDefault: () => ({}),
    cert: () => ({}),
  },
});

after(() => {
  while (adminCleanup.length) {
    const restore = adminCleanup.pop();
    try {
      restore?.();
    } catch {
      // ignore restoration failures in test cleanup
    }
  }
});

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'device-ping-secret';

const { createApp } = await import('../dist/app.js');

function buildInternalToken({ uid = 'device-user', email = 'coach@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.INTERNAL_API_KEY).update(body).digest('base64url');
  return `${body}.${signature}`;
}

describe('device ping tenant enforcement', () => {
  const servers = new Set();

  beforeEach(() => {
    writes.length = 0;
  });

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  async function startServer(overrides = {}) {
    const app = createApp({
      overrides: {
        requireTenantMembershipAccess: async (auth, tenantIdRaw) => {
          const tenantId = (tenantIdRaw || '').trim() || 'tenant-default';
          if (typeof overrides.resolveTenantId === 'function') {
            return overrides.resolveTenantId(auth, tenantIdRaw);
          }
          return {
            tenantId,
            role: 'staff',
            membershipId: `${tenantId}:${auth?.uid || 'uid'}`,
          };
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
    servers.add(server);
    return { base, server };
  }

  it('stamps metadata and updates both device + user docs', async () => {
    const { base } = await startServer();

    const response = await fetch(`${base}/devices/ping`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: 'Coach@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-a',
        userEmail: 'coach@example.com',
        deviceId: 'device-123',
        pingType: 'heartbeat',
        requestId: 'req-1',
      }),
    });

    assert.strictEqual(response.status, 200);
    const payload = await response.json();
    assert.strictEqual(payload.ok, true);
    assert.strictEqual(payload.tenantId, 'tenant-a');
    assert.strictEqual(payload.deviceId, 'device-123');

    const deviceWrite = writes.find((entry) => entry.path === 'user_devices/coach@example.com/devices/device-123');
    assert.ok(deviceWrite, 'device document should be updated');
    assert.strictEqual(deviceWrite.options?.merge, true);
    assert.strictEqual(deviceWrite.data.ownerEmail, 'coach@example.com');
    assert.strictEqual(deviceWrite.data.activeTenantId, 'tenant-a');
    assert.strictEqual(deviceWrite.data.lastPingType, 'heartbeat');

    const userWrite = writes.find((entry) => entry.path === 'user_devices/coach@example.com');
    assert.ok(userWrite, 'user aggregate doc should be updated');
    assert.strictEqual(userWrite.options?.merge, true);
    assert.strictEqual(userWrite.data.email, 'coach@example.com');
  });

  it('rejects tenant mismatches before writing', async () => {
    const { base } = await startServer({
      resolveTenantId: async () => ({ tenantId: 'tenant-guard', role: 'staff', membershipId: 'tenant-guard::uid' }),
    });

    const response = await fetch(`${base}/devices/ping`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-other',
        userEmail: 'coach@example.com',
        deviceId: 'device-123',
      }),
    });

    assert.strictEqual(response.status, 403);
    const data = await response.json();
    assert.strictEqual(data.error, 'tenant_mismatch');
    assert.strictEqual(writes.length, 0);
  });

  it('rejects email mismatches to prevent cross-user writes', async () => {
    const { base } = await startServer();

    const response = await fetch(`${base}/devices/ping`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: 'admin@example.com' })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: 'tenant-a',
        userEmail: 'coach@example.com',
        deviceId: 'device-123',
      }),
    });

    assert.strictEqual(response.status, 403);
    const data = await response.json();
    assert.strictEqual(data.error, 'email_mismatch');
    assert.strictEqual(writes.length, 0);
  });
});
