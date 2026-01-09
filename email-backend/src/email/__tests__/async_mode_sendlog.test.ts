import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app } from '../../server.js';

const logPath = path.resolve(process.cwd(), 'logs/test-sendlog.ndjson');

describe('async send mode and sendlog export', ()=>{
  beforeEach(()=>{
    process.env.ASYNC_SENDS = '1';
    process.env.INTERNAL_API_KEY = 'k';
    process.env.SEND_LOG_FILE = logPath;
    process.env.TENANT_REQUIRED = '0';
    try { fs.rmSync(logPath, { force: true }); } catch {}
  });

  it('returns 202 Accepted in async mode and exports sendlog', async ()=>{
    const res = await request(app)
      .post('/email/send')
      .set('x-internal-key','k')
      .set('x-tenant','tenant-a')
      .send({
        to: 'async@example.com',
        kind: 'custom',
        studentName: 'Async',
        messages: { en: 'Hello' },
        order: 'english-first',
        showLabels: true
      });
    expect(res.status).toBe(202);

    // Give a brief moment for appendFile to flush
    await new Promise(r=>setTimeout(r, 10));

    const exp = await request(app)
      .get('/admin/sendlog.ndjson')
      .set('x-internal-key','k')
      .set('x-tenant','tenant-a');

    // If file hasn't materialized yet, allow a short retry
    if(exp.status === 404){
      await new Promise(r=>setTimeout(r, 25));
    }
    const exp2 = await request(app)
      .get('/admin/sendlog.ndjson')
      .set('x-internal-key','k')
      .set('x-tenant','tenant-a');

    expect([200,404]).toContain(exp.status);
    expect(exp2.status).toBe(200);
    expect(exp2.text).toMatch(/async@example.com/);
    expect(exp2.text).toMatch(/"accepted"/);
  });

  it('requires tenant context for sendlog export', async ()=>{
    const exp = await request(app)
      .get('/admin/sendlog.ndjson')
      .set('x-internal-key','k');
    expect(exp.status).toBe(400);
    expect(exp.body?.error).toBe('tenant_required');
  });
});
