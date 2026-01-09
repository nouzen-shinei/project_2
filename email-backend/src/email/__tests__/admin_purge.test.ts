import { describe, it, expect } from 'vitest';
import request from 'supertest';

const KEY='purge_key';
process.env.INTERNAL_API_KEY = KEY;
process.env.NODE_ENV='test';
import { app } from '../../server.js';
import { addSuppression } from '../suppressionStore.js';

describe('admin purge suppression', () => {
  it('purges a suppression entry', async () => {
    addSuppression('purge@example.com','bounce');
    const list1 = await request(app).get('/admin/suppressions').set('x-internal-key', KEY);
    const countBefore = list1.body.count;
    expect(countBefore).toBeGreaterThanOrEqual(1);
    const del = await request(app).delete('/admin/suppressions/purge@example.com').set('x-internal-key', KEY);
    expect(del.status).toBe(200);
    const list2 = await request(app).get('/admin/suppressions').set('x-internal-key', KEY);
    expect(list2.body.count).toBeLessThanOrEqual(countBefore-1);
  });
});
