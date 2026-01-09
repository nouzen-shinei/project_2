import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../server.js';

describe('admin metrics counters', () => {
  beforeAll(()=>{
    process.env.INTERNAL_API_KEY = 'adminkey';
    process.env.ADMIN_RATE_PER_MIN = '2';
  });

  it('increments admin_requests_total and admin_rate_limited_total', async () => {
    // First two should pass (limit=2)
    await request(app).get('/admin/suppressions').set('x-internal-key','adminkey').expect(200);
    await request(app).get('/admin/suppressions').set('x-internal-key','adminkey').expect(200);
    // Third should rate limit
    await request(app).get('/admin/suppressions').set('x-internal-key','adminkey').expect(429);
    const metrics = await request(app).get('/metrics').expect(200);
    const body = metrics.text;
    const reqLine = body.split('\n').find(l=>l.startsWith('admin_requests_total{route="suppressions_list"')); 
    const rateLine = body.split('\n').find(l=>l.startsWith('admin_rate_limited_total{route="suppressions_list"'));
    expect(reqLine).toBeTruthy();
    expect(rateLine).toBeTruthy();
    // requests should be 3
    if(reqLine) expect(parseInt(reqLine.split(' ').pop()||'0',10)).toBeGreaterThanOrEqual(3);
    // rate limited should be at least 1
    if(rateLine) expect(parseInt(rateLine.split(' ').pop()||'0',10)).toBeGreaterThanOrEqual(1);
  });
});
