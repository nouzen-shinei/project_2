import { describe, it, expect, vi } from 'vitest';

// Mock fetch to return cert
vi.mock('node-fetch', () => ({ default: vi.fn(async () => ({ ok:true, text: async ()=> '-----BEGIN CERTIFICATE-----\nMIIB...fake\n-----END CERTIFICATE-----' })) }));
// Mock crypto verify to fail
vi.mock('crypto', async () => {
  const actual: any = await vi.importActual('crypto');
  return {
    ...actual,
    createVerify: () => ({ update: ()=>{}, verify: ()=> false })
  };
});

import { validateSnsSignature } from '../snsValidator.js';

describe('SNS signature validation negative', () => {
  it('returns false when verification fails', async () => {
    const body = { Type:'Notification', Message:'Hi', MessageId:'1', Timestamp:new Date().toISOString(), TopicArn:'arn:aws:sns:::x', Signature:'abc', SigningCertURL:'https://example.com/cert.pem' };
    const ok = await validateSnsSignature(body);
    expect(ok).toBe(false);
  });
});
