import assert from 'assert';
import { afterEach, describe, it } from 'node:test';

process.env.TEST_MODE = '1';

const { createApp } = await import('../dist/app.js');

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('server address unavailable');
  }
  const base = `http://127.0.0.1:${address.port}`;
  return { server, base };
}

describe('billing webhook endpoints', () => {
  const servers = new Set();
  const originalFlag = process.env.BILLING_WEBHOOKS_ENABLED;

  afterEach(async () => {
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
    if (originalFlag === undefined) {
      delete process.env.BILLING_WEBHOOKS_ENABLED;
    } else {
      process.env.BILLING_WEBHOOKS_ENABLED = originalFlag;
    }
  });

  it('returns disabled error when flag is off (razorpay only)', async () => {
    delete process.env.BILLING_WEBHOOKS_ENABLED;
    const { server, base } = await startServer();
    servers.add(server);

    const stripeResponse = await fetch(`${base}/billing/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test.event' }),
    });
    assert.equal(stripeResponse.status, 410);
    const stripePayload = await stripeResponse.json();
    assert.equal(stripePayload.error, 'stripe_disabled');

    const razorpayResponse = await fetch(`${base}/billing/razorpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'razorpay.test' }),
    });
    assert.equal(razorpayResponse.status, 503);
    const razorpayPayload = await razorpayResponse.json();
    assert.equal(razorpayPayload.error, 'billing_webhooks_disabled');
  });

  it('accepts payloads when flag is on (razorpay only)', async () => {
    process.env.BILLING_WEBHOOKS_ENABLED = '1';
    const { server, base } = await startServer();
    servers.add(server);

    const stripeResponse = await fetch(`${base}/billing/stripe/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'stripe.test' }),
    });
    assert.equal(stripeResponse.status, 410);
    const stripePayload = await stripeResponse.json();
    assert.equal(stripePayload.error, 'stripe_disabled');

    const razorpayResponse = await fetch(`${base}/billing/razorpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'razorpay.test' }),
    });
    assert.equal(razorpayResponse.status, 202);
    const razorpayPayload = await razorpayResponse.json();
    assert.equal(razorpayPayload.provider, 'razorpay');
  });
});
