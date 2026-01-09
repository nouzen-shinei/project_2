import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendEmail, __setProviders, __resetBreakers } from '../orchestrator.js';
import type { EmailProvider, ProviderResult } from '../types.js';

function makeProvider(name:string, capture: { lastPayload?: any }): EmailProvider {
  return {
    name,
    async send(payload){ capture.lastPayload = payload; return { success: true, id: name+':ok' } as ProviderResult; }
  };
}

describe('tenant-based sender selection', ()=>{
  beforeEach(()=>{ __resetBreakers(); vi.resetModules(); });
  it('selects From by tenant using SENDER_POOLS_JSON', async ()=>{
    const cap: any = {};
    const primary = makeProvider('ses', cap);
    const fallback = makeProvider('resend', cap);
    __setProviders({ ses: primary, resend: fallback });

    const old = process.env.SENDER_POOLS_JSON;
    const oldDef = process.env.DEFAULT_TENANT;
    process.env.SENDER_POOLS_JSON = JSON.stringify({ a:{ email:'noreply@a.com', name:'A' }, b:{ email:'mail@b.com' } });
    process.env.DEFAULT_TENANT = 'b';

    const r = await sendEmail({
      to: 'u@example.com',
      kind: 'custom',
      studentName: 'X',
      messages: { en: 'hi' },
      order: 'english-first',
      showLabels: true,
      tenant: 'a'
    });

    expect(r.success).toBe(true);
    expect(cap.lastPayload.fromEmail).toBe('noreply@a.com');
    expect(cap.lastPayload.fromName).toBe('A');

    // Fallback to DEFAULT_TENANT when tenant missing
    const r2 = await sendEmail({
      to: 'u2@example.com',
      kind: 'custom',
      studentName: 'Y',
      messages: { en: 'hi' },
      order: 'english-first',
      showLabels: true
    });
    expect(r2.success).toBe(true);
    expect(cap.lastPayload.fromEmail).toBe('mail@b.com');

    process.env.SENDER_POOLS_JSON = old;
    process.env.DEFAULT_TENANT = oldDef;
  });
});
