import { describe, it, expect, vi } from 'vitest';
import { validateSnsSignature } from '../snsValidator.js';

// We'll mock fetch to return a simple self-signed cert containing a generated key pair; easier: stub crypto.verify

vi.mock('node-fetch', () => ({ default: vi.fn(async () => ({ ok:true, text: async ()=> '-----BEGIN CERTIFICATE-----\nMIIB...fake\n-----END CERTIFICATE-----' })) }));

import crypto from 'crypto';
const realCreateVerify = crypto.createVerify;
(crypto as any).createVerify = function(){
  const verifier = realCreateVerify('sha1');
  verifier.verify = () => true; // force success
  return verifier;
};

describe('SNS signature validation', () => {
  it('returns false on missing fields', async () => {
    const ok = await validateSnsSignature({});
    expect(ok).toBe(false);
  });
  it('validates a fabricated notification', async () => {
    const body = { Type:'Notification', Message:'Hi', MessageId:'1', Timestamp:new Date().toISOString(), TopicArn:'arn:aws:sns:::x', Signature:'abc', SigningCertURL:'https://example.com/cert.pem' };
    const ok = await validateSnsSignature(body);
    expect(ok).toBe(true);
  });
});
