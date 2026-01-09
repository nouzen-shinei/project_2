import { describe, it, expect } from 'vitest';
import request from 'supertest';

const KEY='pag_key';
process.env.INTERNAL_API_KEY = KEY;
process.env.NODE_ENV='test';
process.env.ADMIN_RATE_PER_MIN='5';

import { app, __resetAdminRate } from '../../server.js';
import { addSuppression } from '../suppressionStore.js';

describe('admin pagination & rate limit', () => {
  it('paginates suppression list', async () => {
    // Seed > 60 entries
    for(let i=0;i<65;i++) addSuppression(`p${i}@e.com`, 'bounce');
    const r1 = await request(app).get('/admin/suppressions?page=1&pageSize=20').set('x-internal-key', KEY);
    expect(r1.status).toBe(200);
    expect(r1.body.items.length).toBe(20);
    const r4 = await request(app).get('/admin/suppressions?page=4&pageSize=20').set('x-internal-key', KEY);
    expect(r4.status).toBe(200);
    expect(r4.body.page).toBe(4);
  });
  it('enforces rate limit', async () => {
    __resetAdminRate();
    const results:number[]=[];
    for(let i=0;i<7;i++){
      const r = await request(app).get('/admin/suppressions').set('x-internal-key', KEY);
      results.push(r.status);
    }
    // At least one should be 429 after limit 5/min
    expect(results.filter(s=>s===429).length).toBeGreaterThanOrEqual(1);
  });
});
