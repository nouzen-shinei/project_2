import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'global-admin-secret';

const { createApp } = await import('../dist/app.js');

function buildInternalToken({ uid = 'user-1', email = 'user@example.com' } = {}) {
  const payload = {
    sub: uid,
    email,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', process.env.INTERNAL_API_KEY)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

async function startServerWithAuthStubs() {
  const usersByUid = new Map([
    ['admin-uid', { uid: 'admin-uid', email: 'admin@example.com', customClaims: { admin: true } }],
    ['member-uid', { uid: 'member-uid', email: 'member@example.com', customClaims: {} }],
  ]);
  const uidByEmail = new Map([
    ['admin@example.com', 'admin-uid'],
    ['member@example.com', 'member-uid'],
  ]);
  const setClaimCalls = [];
  const revokeCalls = [];

  const app = createApp({
    overrides: {
      verifyFirebaseIdToken: async (token) => {
        if (token === 'firebase-admin-token') {
          return { uid: 'admin-uid', email: 'admin@example.com', admin: true };
        }
        if (token === 'firebase-member-token') {
          return { uid: 'member-uid', email: 'member@example.com', admin: false };
        }
        throw new Error('invalid token');
      },
      getAuthUserByUid: async (uid) => {
        const user = usersByUid.get(uid);
        if (!user) {
          const err = new Error('user not found');
          err.code = 'auth/user-not-found';
          throw err;
        }
        return { ...user, customClaims: { ...(user.customClaims || {}) } };
      },
      getAuthUserByEmail: async (email) => {
        const normalized = String(email || '').trim().toLowerCase();
        const uid = uidByEmail.get(normalized);
        if (!uid) {
          const err = new Error('user not found');
          err.code = 'auth/user-not-found';
          throw err;
        }
        const user = usersByUid.get(uid);
        return { ...user, customClaims: { ...(user.customClaims || {}) } };
      },
      setAuthCustomUserClaims: async (uid, claims) => {
        setClaimCalls.push({ uid, claims: claims ? { ...claims } : null });
        const user = usersByUid.get(uid);
        if (!user) {
          const err = new Error('user not found');
          err.code = 'auth/user-not-found';
          throw err;
        }
        user.customClaims = claims || {};
      },
      revokeAuthRefreshTokens: async (uid) => {
        revokeCalls.push(uid);
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

  const cleanup = async () => {
    await new Promise((resolve) => server.close(resolve));
  };

  return {
    base: `http://127.0.0.1:${address.port}`,
    cleanup,
    setClaimCalls,
    revokeCalls,
  };
}

describe('global admin claim endpoints', () => {
  const cleanups = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0, cleanups.length)) {
      await fn();
    }
  });

  it('allows firebase global admins to read /admin/auth/global-admin/me', async () => {
    const runtime = await startServerWithAuthStubs();
    cleanups.push(runtime.cleanup);

    const response = await fetch(`${runtime.base}/admin/auth/global-admin/me`, {
      headers: {
        Authorization: 'Bearer firebase-admin-token',
      },
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.isGlobalAdmin, true);
    assert.strictEqual(body.uid, 'admin-uid');
  });

  it('blocks non-admin firebase users from /admin/auth/global-admin/me', async () => {
    const runtime = await startServerWithAuthStubs();
    cleanups.push(runtime.cleanup);

    const response = await fetch(`${runtime.base}/admin/auth/global-admin/me`, {
      headers: {
        Authorization: 'Bearer firebase-member-token',
      },
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'not_authorized');
  });

  it('allows global admins to lookup claims but only master can mutate claims', async () => {
    const runtime = await startServerWithAuthStubs();
    cleanups.push(runtime.cleanup);

    const lookup = await fetch(`${runtime.base}/admin/auth/global-admin/get`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer firebase-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'admin@example.com' }),
    });
    assert.strictEqual(lookup.status, 200);
    const lookupBody = await lookup.json();
    assert.strictEqual(lookupBody.admin, true);

    const blockedSet = await fetch(`${runtime.base}/admin/auth/global-admin/set`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer firebase-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'member@example.com', admin: true }),
    });
    assert.strictEqual(blockedSet.status, 403);

    const allowedSet = await fetch(`${runtime.base}/admin/auth/global-admin/set`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'member@example.com', admin: true, reason: 'promote' }),
    });
    assert.strictEqual(allowedSet.status, 200);
    const setBody = await allowedSet.json();
    assert.strictEqual(setBody.ok, true);
    assert.strictEqual(setBody.admin, true);
    assert.strictEqual(runtime.setClaimCalls.length, 1);
    assert.strictEqual(runtime.revokeCalls.length, 1);
    assert.strictEqual(runtime.revokeCalls[0], 'member-uid');
  });

  it('allows firebase global admins to access master-style admin route guard', async () => {
    const runtime = await startServerWithAuthStubs();
    cleanups.push(runtime.cleanup);

    const response = await fetch(`${runtime.base}/admin/tenants/search`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer firebase-admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'alpha', limit: 5 }),
    });

    assert.notStrictEqual(response.status, 403);
  });
});
