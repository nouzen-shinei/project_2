// Feature: chat-production-hardening (messageIndex read lockdown).
//
// Auth tests for the per-user inbound SSE endpoint `GET /chat/inbox-stream`.
// The endpoint streams the CALLER'S OWN inbound messages so the client no longer
// reads the RTDB `messageIndex` node directly. Its auth MUST:
//   - require a valid internal token (query `token`),
//   - require a tenantId,
//   - derive the actor from the TOKEN, not the query: the token's `email` claim
//     must match the `user` query param (a client cannot stream another user's
//     inbox by spoofing `?user=`),
//   - require the user to be an active member of the tenant.
//
// Only the rejection paths are exercised here (they return JSON before any
// streaming / Firebase access); the happy path opens a long-lived SSE stream and
// is covered at the watcher level in chatInboxRealtime.watch.test.mjs.

import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'inbox-stream-secret';

const { createApp } = await import('../dist/app.js');

const DEFAULT_TENANT_ID = 'tenant-42';
const DEFAULT_USER_EMAIL = 'coach@example.com';

function buildInternalToken({ uid = 'user-1', email = DEFAULT_USER_EMAIL } = {}) {
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

async function startServer({ allowedMembers } = {}) {
  const normalizedAllowed = new Set(
    Array.from(allowedMembers ?? new Set()).map((email) => email.trim().toLowerCase())
  );
  const app = createApp({
    overrides: {
      isTenantEmailActiveMember: async (_tenantId, email) => normalizedAllowed.has(email.trim().toLowerCase()),
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, base: `http://127.0.0.1:${port}` };
}

function inboxStreamUrl(base, params) {
  const url = new URL(`${base}/chat/inbox-stream`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

describe('GET /chat/inbox-stream auth', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('rejects a request with no token (401)', async () => {
    const { server, base } = await startServer({ allowedMembers: new Set([DEFAULT_USER_EMAIL]) });
    servers.add(server);

    const response = await fetch(inboxStreamUrl(base, { tenantId: DEFAULT_TENANT_ID, user: DEFAULT_USER_EMAIL }));
    assert.strictEqual(response.status, 401);
  });

  it('rejects an invalid token (401)', async () => {
    const { server, base } = await startServer({ allowedMembers: new Set([DEFAULT_USER_EMAIL]) });
    servers.add(server);

    const response = await fetch(
      inboxStreamUrl(base, { token: 'not-a-valid-token', tenantId: DEFAULT_TENANT_ID, user: DEFAULT_USER_EMAIL })
    );
    assert.strictEqual(response.status, 401);
  });

  it('rejects a valid token without a tenantId (400)', async () => {
    const { server, base } = await startServer({ allowedMembers: new Set([DEFAULT_USER_EMAIL]) });
    servers.add(server);

    const response = await fetch(inboxStreamUrl(base, { token: buildInternalToken(), user: DEFAULT_USER_EMAIL }));
    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.strictEqual(body.error, 'tenant_required');
  });

  it('rejects when the query user does not match the token identity (401) — actor is from the token', async () => {
    const { server, base } = await startServer({ allowedMembers: new Set([DEFAULT_USER_EMAIL, 'victim@example.com']) });
    servers.add(server);

    // Token belongs to coach@example.com but the caller tries to stream a
    // different user's inbox by spoofing ?user=.
    const response = await fetch(
      inboxStreamUrl(base, {
        token: buildInternalToken({ email: DEFAULT_USER_EMAIL }),
        tenantId: DEFAULT_TENANT_ID,
        user: 'victim@example.com',
      })
    );
    assert.strictEqual(response.status, 401);
    const body = await response.json();
    assert.strictEqual(body.error, 'unauthorized');
  });

  it('rejects when the user is not an active tenant member (403)', async () => {
    const { server, base } = await startServer({ allowedMembers: new Set() });
    servers.add(server);

    const response = await fetch(
      inboxStreamUrl(base, {
        token: buildInternalToken({ email: DEFAULT_USER_EMAIL }),
        tenantId: DEFAULT_TENANT_ID,
        user: DEFAULT_USER_EMAIL,
      })
    );
    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'not_authorized');
  });
});
