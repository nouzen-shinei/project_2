import assert from 'assert';
import { afterEach, describe, it } from 'node:test';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'runtime-metrics-suite';

const { createApp } = await import('../dist/app.js');

const ALERT_ENV_NAMES = [
  'ALERT_CHAT_REALTIME_WATCHES_ACTIVE',
  'ALERT_CHAT_REALTIME_WATCH_SUBSCRIBERS',
];

const ORIGINAL_ALERT_ENVS = Object.fromEntries(ALERT_ENV_NAMES.map((name) => [name, process.env[name]]));

function restoreAlertEnvs() {
  for (const name of ALERT_ENV_NAMES) {
    const original = ORIGINAL_ALERT_ENVS[name];
    if (typeof original === 'string') {
      process.env[name] = original;
    } else {
      delete process.env[name];
    }
  }
}

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('server address unavailable');
  }
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
  };
}

describe('runtime metrics endpoint', () => {
  const servers = new Set();

  afterEach(async () => {
    restoreAlertEnvs();
    for (const server of Array.from(servers)) {
      await new Promise((resolve) => server.close(resolve));
      servers.delete(server);
    }
  });

  it('requires bearer auth when INTERNAL_API_KEY is set', async () => {
    const { server, base } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/metrics`);
    assert.strictEqual(response.status, 401);
  });

  it('emits chat realtime gauges and alert flags', async () => {
    process.env.ALERT_CHAT_REALTIME_WATCHES_ACTIVE = '-1';
    process.env.ALERT_CHAT_REALTIME_WATCH_SUBSCRIBERS = '-1';

    const { server, base } = await startServer();
    servers.add(server);

    const response = await fetch(`${base}/metrics`, {
      headers: {
        Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
      },
    });

    assert.strictEqual(response.status, 200);
    const body = await response.text();

    assert.match(body, /^wa_chat_realtime_watches_active 0$/m);
    assert.match(body, /^wa_chat_realtime_watch_subscribers 0$/m);
    assert.match(body, /^wa_alert_chat_realtime_watches_active_exceeded 1$/m);
    assert.match(body, /^wa_alert_chat_realtime_watch_subscribers_exceeded 1$/m);
  });
});
