const KEY = 'test_internal_key';
process.env.INTERNAL_API_KEY = KEY; // ensure set before server import
process.env.NODE_ENV = 'test';
process.env.ASYNC_SENDS = '0';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { __setProviders } from '../orchestrator.js';
import type { EmailProvider } from '../types.js';
import { isSuppressed } from '../suppressionStore.js';
import { app } from '../../server.js';

describe('integration endpoints', () => {
  it('returns same result with idempotency replay header', async () => {
    const prov: EmailProvider = { name:'mock', async send(){ return { success:true, id:'fixed-id' }; } };
    __setProviders({ mock: prov } as any);
    const idem = 'idem-123';
  const first = await request(app)
      .post('/email/send')
      .set('x-internal-key', KEY)
      .set('idempotency-key', idem)
      .send({ to:'idem@example.com', kind:'custom', studentName:'I', messages:{ en:'Hello'}, order:'english-first' });
  expect(first.status).toBe(200);
  expect(first.headers['idempotent-replay']).toBe('false');
    const second = await request(app)
      .post('/email/send')
      .set('x-internal-key', KEY)
      .set('idempotency-key', idem)
      .send({ to:'idem@example.com', kind:'custom', studentName:'I', messages:{ en:'Hello'}, order:'english-first' });
  expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
  });

  it('adds suppression via webhook bounce notification', async () => {
    const email = 'webhookbounce@example.com';
    const resp = await request(app)
      .post('/webhook/ses')
      .send({ notificationType:'Bounce', bounce:{ bouncedRecipients:[ { emailAddress: email } ] } });
    expect(resp.status).toBe(200);
    expect(isSuppressed(email)).toBe(true);
  });
});
