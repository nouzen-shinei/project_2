import { describe, it, expect } from 'vitest';
import request from 'supertest';

const KEY = 'admin_test_key';
process.env.INTERNAL_API_KEY = KEY;
process.env.NODE_ENV = 'test';

import { app } from '../../server.js';
import { addSuppression } from '../suppressionStore.js';

describe('admin endpoints', () => {
  it('requires auth for suppression list', async () => {
    const r = await request(app).get('/admin/suppressions');
    expect(r.status).toBe(401);
  });
  it('returns suppression list with auth', async () => {
    addSuppression('u1@example.com','bounce');
    const r = await request(app).get('/admin/suppressions').set('x-internal-key', KEY);
    expect(r.status).toBe(200);
    expect(r.body.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(r.body.items)).toBe(true);
  });
});
