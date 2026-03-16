import assert from 'assert';
import { describe, it, afterEach } from 'node:test';
import crypto from 'crypto';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'chat-receipts-secret';

const { createApp, TenantAccessError } = await import('../dist/app.js');

const DEFAULT_TENANT_ID = 'tenant-42';
const DEFAULT_ACTOR_EMAIL = 'recipient@example.com';
const DEFAULT_PARTNER_EMAIL = 'sender@example.com';

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
  const syncCalls = [];
  const outboundDeliveryCalls = [];

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
      syncChatConversationReceipts: async (input) => {
        syncCalls.push(input);
        return {
          deliveredMessageIds: ['message-1'],
          readMessageIds: ['message-1'],
          deliveredCount: 1,
          readCount: 1,
          actorHasOnlineDevice: true,
          actorHasFocusedChatDevice: true,
        };
      },
      confirmOutboundChatDelivery: async (input) => {
        outboundDeliveryCalls.push(input);
        return {
          deliveredMessageIds: ['message-3'],
          deliveredCount: 1,
        };
      },
    },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return { server, base, syncCalls, outboundDeliveryCalls };
}

describe('chat receipt sync endpoint', () => {
  const servers = new Set();

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('rejects receipt sync when the actor lacks tenant membership', async () => {
    const { server, base } = await startServer({
      rejectActor: true,
      allowedPartners: new Set([DEFAULT_PARTNER_EMAIL]),
    });
    servers.add(server);

    const response = await fetch(`${base}/chat/receipts/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: DEFAULT_TENANT_ID,
        partnerEmail: DEFAULT_PARTNER_EMAIL,
        readMessageIds: ['message-1'],
      }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'tenant_membership_required');
  });

  it('rejects receipt sync when the partner is not an active tenant member', async () => {
    const { server, base } = await startServer({ allowedPartners: new Set() });
    servers.add(server);

    const response = await fetch(`${base}/chat/receipts/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: DEFAULT_TENANT_ID,
        partnerEmail: 'outsider@example.com',
        markConversationDelivered: true,
      }),
    });

    assert.strictEqual(response.status, 403);
    const body = await response.json();
    assert.strictEqual(body.error, 'partner_not_in_tenant');
  });

  it('forwards actor, partner, and requested ids to the receipt sync implementation', async () => {
    const { server, base, syncCalls } = await startServer({
      allowedPartners: new Set([DEFAULT_PARTNER_EMAIL]),
    });
    servers.add(server);

    const response = await fetch(`${base}/chat/receipts/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: DEFAULT_TENANT_ID,
        partnerEmail: DEFAULT_PARTNER_EMAIL,
        readMessageIds: ['message-1', 'message-2'],
        deliveredMessageIds: ['message-3'],
        markConversationDelivered: true,
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(syncCalls.length, 1);
    assert.deepStrictEqual(syncCalls[0], {
      tenantId: DEFAULT_TENANT_ID,
      actorEmail: DEFAULT_ACTOR_EMAIL,
      partnerEmail: DEFAULT_PARTNER_EMAIL,
      deliveredMessageIds: ['message-3'],
      readMessageIds: ['message-1', 'message-2'],
      markConversationDelivered: true,
    });
    assert.deepStrictEqual(body.readMessageIds, ['message-1']);
    assert.deepStrictEqual(body.deliveredMessageIds, ['message-1']);
  });

  it('forwards outbound delivery confirmations to the runtime implementation', async () => {
    const outboundActorEmail = 'sender@example.com';
    const outboundPartnerEmail = 'recipient@example.com';
    const { server, base, outboundDeliveryCalls } = await startServer({
      allowedPartners: new Set([outboundPartnerEmail]),
    });
    servers.add(server);

    const response = await fetch(`${base}/chat/receipts/outbound-delivered`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildInternalToken({ email: outboundActorEmail })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: DEFAULT_TENANT_ID,
        partnerEmail: outboundPartnerEmail,
        deliveredMessageIds: ['message-3', 'message-4'],
        provenance: {
          sources: ['push'],
          lastSource: 'push',
          push: {
            acceptedDeviceCount: 2,
            mobileAcceptedCount: 1,
            webAcceptedCount: 1,
          },
        },
      }),
    });

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(outboundDeliveryCalls.length, 1);
    assert.deepStrictEqual(outboundDeliveryCalls[0], {
      tenantId: DEFAULT_TENANT_ID,
      actorEmail: outboundActorEmail,
      partnerEmail: outboundPartnerEmail,
      deliveredMessageIds: ['message-3', 'message-4'],
      provenance: {
        sources: ['push'],
        lastSource: 'push',
        push: {
          acceptedDeviceCount: 2,
          mobileAcceptedCount: 1,
          webAcceptedCount: 1,
        },
      },
    });
    assert.deepStrictEqual(body.deliveredMessageIds, ['message-3']);
    assert.strictEqual(body.deliveredCount, 1);
  });
});