import { describe, it, expect } from 'vitest';
import { __setProviders, sendEmail } from '../orchestrator.js';
import type { EmailProvider } from '../types.js';

const makeProvider = (name: string, responses: any[]): EmailProvider => ({
  name,
  async send(){ return responses.shift(); }
});

describe('orchestrator', () => {
  it('falls back on transient failure then succeeds', async () => {
    __setProviders({
      primary: makeProvider('primary', [ { success:false, transient:true, errorMessage:'temp' } ] as any[]),
      secondary: makeProvider('secondary', [ { success:true, id:'123' } ] as any[])
    } as any);
    const res = await sendEmail({
      to: 'a@example.com',
      kind: 'custom',
      studentName: 'A',
      messages: { en: 'Hi' },
      order: 'english-first'
    });
    expect(res.success).toBe(true);
    expect(res.provider).toBe('secondary');
    expect(res.fallbackUsed).toBe(true);
  });

  it('stops on permanent failure of primary', async () => {
    __setProviders({
      primary: makeProvider('primary', [ { success:false, transient:false, errorMessage:'perm' } ] as any[]),
      secondary: makeProvider('secondary', [ { success:true, id:'123' } ] as any[])
    } as any);
    const res = await sendEmail({
      to: 'b@example.com',
      kind: 'custom',
      studentName: 'B',
      messages: { en: 'Hi' },
      order: 'english-first'
    });
    expect(res.success).toBe(false);
    expect(res.provider).toBeUndefined();
  });
});
