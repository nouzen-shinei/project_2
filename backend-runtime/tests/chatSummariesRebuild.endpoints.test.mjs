// Feature: chat-production-hardening (Phase 1, Task 2 — finding P0-1, Model A:
// backend is the ONLY chat writer).
//
// **Validates: chat-production-hardening finding P0-1 (RTDB least-privilege /
// backend-only writer) — the summary REBUILD path.**
//
// Covers the NEW authenticated endpoint that replaces the client's former direct
// RTDB summary rebuild (the last unmigrated client writer, which now fails under
// the `.write:false` lockdown):
//   POST /chat/summaries/rebuild   (was chatService.rebuildConversationSummariesForUser)
//
// Security invariants under test:
//   (1) auth is REQUIRED (401 without a token / context),
//   (2) tenant membership is enforced for the actor (403 when missing),
//   (3) a tenant mismatch is rejected (403),
//   (4) an invalid body (missing tenantId) fails validation (400),
//   (5) the acting identity is bound to the AUTH TOKEN and can NOT be forged from
//       the request body (a body-supplied actorEmail is ignored).
//
// Only the writer implementation + tenant guard are mocked (recording overrides);
// the real Express routing + zod validation + identity resolution
// (resolveAuthenticatedEmail) run unmodified from ../dist/app.js.

import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'chat-summaries-rebuild-secret';

const { createApp, TenantAccessError } = await import('../dist/app.js');

const DEFAULT_TENANT_ID = 'tenant-91';
const DEFAULT_ACTOR_EMAIL = 'owner@example.com';

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

async function startServer({ rejectActor = false } = {}) {
  const rebuildCalls = [];

  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
        if (rejectActor) {
          throw new TenantAccessError(403, { error: 'tenant_membership_required' });
        }
        const tenantId = (tenantIdRaw || DEFAULT_TENANT_ID).trim();
        return { tenantId, role: 'member', membershipId: `${tenantId}_mock-user` };
      },
      isTenantEmailActiveMember: async () => true,
      rebuildChatSummariesForUser: async (input) => {
        rebuildCalls.push(input);
        return { rebuiltConversations: 4, prunedConversations: 2 };
      },
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { server, base, rebuildCalls };
}

describe('chat-production-hardening (Task 2, P0-1) — /chat/summaries/rebuild', () => {
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

    const response = await fetch(`${base}/chat/summaries/rebuild`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: DEFAULT_TENANT_ID }),
    });

    assert.strictEqual(response.status, 401);
  });

  it('rejects when the actor lacks tenant membership', async () => {
    const { server, base } = await startServer({ rejectActor: true });
    servers.add(server);

    const response = await fetch(`${base}/chat/summaries/rebuild`, {
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

  it('rejects a request with no tenant context (tenant guard runs before the handler)', async () => {
    const { server, base } = await startServer({});
    servers.add(server);

    const response = await fetch(`${base}/chat/summaries/rebuild`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.strictEqual(body.error, 'tenant_required');
  });

  it('binds the actor to the auth token (a forged body actorEmail is ignored) and forwards actor/tenant', async () => {
    const { server, base, rebuildCalls } = await startServer({});
    servers.add(server);

    const response = await fetch(`${base}/chat/summaries/rebuild`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: DEFAULT_ACTOR_EMAIL })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: DEFAULT_TENANT_ID,
        // Attacker attempts to rebuild someone else's summaries — MUST be ignored.
        actorEmail: 'attacker@evil.com',
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.rebuiltConversations, 4);
    assert.strictEqual(body.prunedConversations, 2);

    assert.strictEqual(rebuildCalls.length, 1);
    assert.deepStrictEqual(rebuildCalls[0], {
      tenantId: DEFAULT_TENANT_ID,
      actorEmail: DEFAULT_ACTOR_EMAIL,
    });
  });
});
