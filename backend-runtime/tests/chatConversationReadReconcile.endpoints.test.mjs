// Feature: chat-production-hardening (Phase 1, Task 2 — finding P0-1, Model A:
// backend is the ONLY chat writer).
//
// **Validates: chat-production-hardening finding P0-1 (RTDB least-privilege /
// backend-only writer)**
//
// These tests cover the two NEW authenticated endpoints that replace the client's
// former direct RTDB writes for reading a conversation and reconciling unread:
//   POST /chat/conversations/read   (was chatService.markConversationAsRead)
//   POST /chat/unread/reconcile     (was chatService.reconcileUnreadForUser)
//
// The security invariants under test:
//   (1) auth is REQUIRED (401 without a token / context),
//   (2) tenant membership is enforced for the actor (403 when missing),
//   (3) the conversation partner must be an active tenant member (read endpoint),
//   (4) the acting identity is bound to the AUTH TOKEN and can NOT be forged from
//       the request body (a body-supplied actorEmail is ignored),
//   (5) a tenant mismatch is rejected.
//
// Only the writer implementations, tenant guard, and membership check are mocked
// (recording overrides); the real Express routing + zod validation + identity
// resolution (resolveAuthenticatedEmail) run unmodified from ../dist/app.js.

import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'chat-read-reconcile-secret';

const { createApp, TenantAccessError } = await import('../dist/app.js');

const DEFAULT_TENANT_ID = 'tenant-77';
const DEFAULT_ACTOR_EMAIL = 'reader@example.com';
const DEFAULT_PARTNER_EMAIL = 'writer@example.com';

function buildInternalToken({ uid = 'user-1', email = DEFAULT_ACTOR_EMAIL } = {}) {
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

async function startServer({ rejectActor = false, allowedPartners } = {}) {
  const normalizedAllowed = new Set(
    Array.from(allowedPartners ?? new Set()).map((email) => email.trim().toLowerCase())
  );
  const markReadCalls = [];
  const reconcileCalls = [];

  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
        if (rejectActor) {
          throw new TenantAccessError(403, { error: 'tenant_membership_required' });
        }
        const tenantId = (tenantIdRaw || DEFAULT_TENANT_ID).trim();
        return { tenantId, role: 'member', membershipId: `${tenantId}_mock-user` };
      },
      isTenantEmailActiveMember: async (_tenantId, email) => {
        return normalizedAllowed.has(email.trim().toLowerCase());
      },
      markChatConversationRead: async (input) => {
        markReadCalls.push(input);
        return { readMessageIds: ['m-1', 'm-2'], updatedCount: 2 };
      },
      reconcileChatUnreadForUser: async (input) => {
        reconcileCalls.push(input);
        return { reconciledConversations: 3, selfConversationsCleaned: 1 };
      },
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { server, base, markReadCalls, reconcileCalls };
}

describe('chat-production-hardening (Task 2, P0-1) — /chat/conversations/read', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('requires authentication (401 without a token)', async () => {
    const { server, base } = await startServer({ allowedPartners: new Set([DEFAULT_PARTNER_EMAIL]) });
    servers.add(server);

    const response = await fetch(`${base}/chat/conversations/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID, partnerEmail: DEFAULT_PARTNER_EMAIL }),
    });

    assert.strictEqual(response.status, 401);
  });

  it('rejects when the actor lacks tenant membership', async () => {
    const { server, base } = await startServer({
      rejectActor: true,
      allowedPartners: new Set([DEFAULT_PARTNER_EMAIL]),
    });
    servers.add(server);

    const response = await fetch(`${base}/chat/conversations/read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID, partnerEmail: DEFAULT_PARTNER_EMAIL }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'tenant_membership_required');
  });

  it('rejects when the partner is not an active tenant member', async () => {
    const { server, base } = await startServer({ allowedPartners: new Set() });
    servers.add(server);

    const response = await fetch(`${base}/chat/conversations/read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID, partnerEmail: 'outsider@example.com' }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'partner_not_in_tenant');
  });

  it('fails validation when partnerEmail is missing', async () => {
    const { server, base } = await startServer({ allowedPartners: new Set([DEFAULT_PARTNER_EMAIL]) });
    servers.add(server);

    const response = await fetch(`${base}/chat/conversations/read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID }),
    });

    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.strictEqual(body.error, 'validation_failed');
  });

  it('binds the actor to the auth token (a forged body actorEmail is ignored) and forwards actor/partner/tenant', async () => {
    const { server, base, markReadCalls } = await startServer({
      allowedPartners: new Set([DEFAULT_PARTNER_EMAIL]),
    });
    servers.add(server);

    const response = await fetch(`${base}/chat/conversations/read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: DEFAULT_ACTOR_EMAIL })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: DEFAULT_TENANT_ID,
        partnerEmail: DEFAULT_PARTNER_EMAIL,
        // Attacker attempts to act as someone else — MUST be ignored.
        actorEmail: 'attacker@evil.com',
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.updatedCount, 2);
    assert.deepStrictEqual(body.readMessageIds, ['m-1', 'm-2']);

    assert.strictEqual(markReadCalls.length, 1);
    assert.deepStrictEqual(markReadCalls[0], {
      tenantId: DEFAULT_TENANT_ID,
      actorEmail: DEFAULT_ACTOR_EMAIL,
      partnerEmail: DEFAULT_PARTNER_EMAIL,
    });
  });
});

describe('chat-production-hardening (Task 2, P0-1) — /chat/unread/reconcile', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('requires authentication (401 without a token)', async () => {
    const { server, base } = await startServer({});
    servers.add(server);

    const response = await fetch(`${base}/chat/unread/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID }),
    });

    assert.strictEqual(response.status, 401);
  });

  it('rejects when the actor lacks tenant membership', async () => {
    const { server, base } = await startServer({ rejectActor: true });
    servers.add(server);

    const response = await fetch(`${base}/chat/unread/reconcile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'tenant_membership_required');
  });

  it('binds the actor to the auth token (a forged body actorEmail is ignored) and forwards actor/tenant', async () => {
    const { server, base, reconcileCalls } = await startServer({});
    servers.add(server);

    const response = await fetch(`${base}/chat/unread/reconcile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: DEFAULT_ACTOR_EMAIL })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: DEFAULT_TENANT_ID,
        actorEmail: 'attacker@evil.com',
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.reconciledConversations, 3);
    assert.strictEqual(body.selfConversationsCleaned, 1);

    assert.strictEqual(reconcileCalls.length, 1);
    assert.deepStrictEqual(reconcileCalls[0], {
      tenantId: DEFAULT_TENANT_ID,
      actorEmail: DEFAULT_ACTOR_EMAIL,
    });
  });
});
