import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'tenant-guard-secret';

const { createApp, TenantAccessError } = await import('../dist/app.js');

const DEFAULT_TENANT_ID = 'tenant-42';
const DEFAULT_SENDER_EMAIL = 'coach@example.com';
const DEFAULT_RECIPIENT_EMAIL = 'parent@example.com';

function buildInternalToken({ uid = 'user-1', email = DEFAULT_SENDER_EMAIL } = {}) {
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

async function startServer({ rejectSender = false, allowedRecipients } = {}) {
  const normalizedAllowed = new Set(
    Array.from(allowedRecipients ?? new Set()).map((email) => email.trim().toLowerCase())
  );
  const sendCalls = [];
  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (_authContext, tenantIdRaw) => {
        if (rejectSender) {
          throw new TenantAccessError(403, { error: 'tenant_membership_required' });
        }
        const tenantId = (tenantIdRaw || DEFAULT_TENANT_ID).trim();
        return { tenantId, role: 'member', membershipId: `${tenantId}_mock-user` };
      },
      isTenantEmailActiveMember: async (_tenantId, email) => {
        return normalizedAllowed.has(email.trim().toLowerCase());
      },
      sendChatMessage: async (input) => {
        sendCalls.push(input);
        return {
          id: `mock-${sendCalls.length}`,
          text: input.text ?? '',
          sender: input.senderEmail,
          recipientId: input.recipientEmail,
          timestamp: new Date().toISOString(),
          conversationKey: 'mock-convo',
          tenantId: input.tenantId,
          isSpecial: Boolean(input.isSpecial),
          delivered: Boolean(input.delivered),
          read: Boolean(input.read),
        };
      },
      checkChatRateLimit: async () => ({ allowed: true }),
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { server, base, sendCalls };
}

describe('chat tenant guards', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('rejects when sender lacks tenant membership', async () => {
    const { server, base } = await startServer({
      rejectSender: true,
      allowedRecipients: new Set([DEFAULT_RECIPIENT_EMAIL]),
    });
    servers.add(server);

    const response = await fetch(`${base}/chat/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipientId: DEFAULT_RECIPIENT_EMAIL,
        tenantId: DEFAULT_TENANT_ID,
        text: 'Hello',
      }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'tenant_membership_required');
  });

  it('rejects when recipient is not an active tenant member', async () => {
    const { server, base } = await startServer({
      allowedRecipients: new Set(),
    });
    servers.add(server);

    const response = await fetch(`${base}/chat/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipientId: 'outsider@example.com',
        tenantId: DEFAULT_TENANT_ID,
        text: 'Tenant scoped hello',
      }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'recipient_not_in_tenant');
  });

  it('allows chat sends when both parties are tenant members', async () => {
    const allowedRecipients = new Set([DEFAULT_RECIPIENT_EMAIL]);
    const { server, base, sendCalls } = await startServer({ allowedRecipients });
    servers.add(server);

    const response = await fetch(`${base}/chat/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipientId: DEFAULT_RECIPIENT_EMAIL,
        tenantId: DEFAULT_TENANT_ID,
        text: 'Tenant safe hello',
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].tenantId, DEFAULT_TENANT_ID);
    assert.strictEqual(sendCalls[0].recipientEmail, DEFAULT_RECIPIENT_EMAIL);
    assert.strictEqual(sendCalls[0].senderEmail, DEFAULT_SENDER_EMAIL);
  });

  it('rejects chat delta requests when user email mismatches the authenticated member', async () => {
    const { server, base } = await startServer({ allowedRecipients: new Set([DEFAULT_RECIPIENT_EMAIL]) });
    servers.add(server);

    const response = await fetch(`${base}/chat/delta`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userEmail: 'other-user@example.com',
        partnerEmail: DEFAULT_RECIPIENT_EMAIL,
        tenantId: DEFAULT_TENANT_ID,
      }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'not_authorized');
  });

  it('rejects chat delta requests when the partner is not a tenant member', async () => {
    const { server, base } = await startServer({ allowedRecipients: new Set() });
    servers.add(server);

    const response = await fetch(`${base}/chat/delta`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userEmail: DEFAULT_SENDER_EMAIL,
        partnerEmail: 'outsider@example.com',
        tenantId: DEFAULT_TENANT_ID,
      }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'partner_not_in_tenant');
  });
});
