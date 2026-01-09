import { describe, it, expect } from 'vitest';
import request from 'supertest';

const KEY='clear_idem_key';
process.env.INTERNAL_API_KEY = KEY;
process.env.NODE_ENV='test';
process.env.ASYNC_SENDS = '0';

import { app } from '../../server.js';
import { idempotentSize } from '../idempotencyStore.js';

// helper to perform send with idempotency header via HTTP route so cache stores
async function sendIdem(k:string){
  return request(app)
    .post('/email/send')
    .set('x-internal-key', KEY)
    .set('idempotency-key', k)
    .send({ to:`${k}@example.com`, kind:'custom', studentName:'Stu', messages:{ en:'Hi'}, order:'english-first' });
}

describe('admin clear idempotent cache', () => {
  it('clears cached entries', async () => {
    await sendIdem('idem-a');
    await sendIdem('idem-b');
    expect(idempotentSize()).toBeGreaterThanOrEqual(2);
    const r = await request(app).post('/admin/idempotent/clear').set('x-internal-key', KEY);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.size).toBe(0);
    expect(idempotentSize()).toBe(0);
  });
});
