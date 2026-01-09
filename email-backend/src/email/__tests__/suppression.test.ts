import { describe, it, expect } from 'vitest';
import { __setProviders, sendEmail } from '../orchestrator.js';
import { isSuppressed } from '../suppressionStore.js';
import type { EmailProvider } from '../types.js';

describe('suppression addition', () => {
  it('adds suppression on bounce-like error', async () => {
    const prov: EmailProvider = { name:'p', async send(){ return { success:false, transient:false, errorMessage:'HardBounce detected', errorType:'permanent' }; } };
    __setProviders({ only: prov } as any);
    const res = await sendEmail({ to:'bounced@example.com', kind:'custom', studentName:'B', messages:{ en:'Hi' }, order:'english-first' });
    expect(res.success).toBe(false);
    expect(isSuppressed('bounced@example.com')).toBe(true);
  });
});
