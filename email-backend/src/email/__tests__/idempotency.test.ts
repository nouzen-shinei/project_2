import { describe, it, expect } from 'vitest';
import { setIdempotent, getIdempotent } from '../idempotencyStore.js';

describe('idempotencyStore', () => {
  it('stores and retrieves within TTL', () => {
    setIdempotent('key1', 200, { ok: true });
    const v = getIdempotent('key1');
    expect(v).toBeTruthy();
    expect(v?.status).toBe(200);
  });
});
