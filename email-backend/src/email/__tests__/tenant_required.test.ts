import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../../server.js';

// Ensure missing tenant is rejected when enabled and no DEFAULT_TENANT

describe('tenant required enforcement', ()=>{
  beforeEach(()=>{
    process.env.TENANT_REQUIRED = '1';
    delete process.env.DEFAULT_TENANT;
    process.env.SENDER_POOLS_JSON = JSON.stringify({ a:{ email:'a@example.com' } });
    process.env.INTERNAL_API_KEY = 'k';
  });
  it('returns 400 missing_tenant', async ()=>{
    const res = await request(app)
      .post('/email/send')
      .set('x-internal-key','k')
      .send({
        to: 't@example.com',
        kind: 'custom',
        studentName: 'S',
        messages: { en: 'Hello' },
        order: 'english-first',
        showLabels: true
      });
    expect(res.status).toBe(400);
    expect(res.body?.error).toBe('missing_tenant');
  });
});
