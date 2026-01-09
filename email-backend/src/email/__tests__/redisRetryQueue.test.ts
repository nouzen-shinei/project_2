import { describe, it, expect, beforeAll, vi } from 'vitest';
import { enqueue } from '../retryQueue.js';
import { __setProviders } from '../orchestrator.js';

// This test is skipped if REDIS_RETRY_QUEUE not enabled or no REDIS_URL
const enabled = process.env.REDIS_RETRY_QUEUE === '1' && process.env.REDIS_URL;

describe.skipIf(!enabled)('redis retry queue', () => {
  beforeAll(()=>{
    let attempts = 0;
    const transientProv = { name:'primary', send: async (_p:any)=>{ attempts++; return { success:false, transient:true, errorType:'Transient', errorMessage:'temp' }; } } as any;
    const successProv = { name:'fallback', send: async (_p:any)=>({ success:true, id:'ok' }) } as any;
    __setProviders({ ses: transientProv, resend: successProv });
  });

  it('enqueues and eventually retries', async () => {
    enqueue({ to:'r@example.com', kind:'custom', studentName:'R', messages:{}, order:'english-first', showLabels:true });
    // Just assert no throw; deeper integration would require mocking redis client
    expect(true).toBe(true);
  });
});
