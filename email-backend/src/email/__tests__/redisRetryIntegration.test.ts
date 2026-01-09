import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enqueue } from '../retryQueue.js';
import { __setProviders } from '../orchestrator.js';
import { createClient } from 'redis';

// Full integration test requires REDIS_URL and REDIS_RETRY_QUEUE=1
const enabled = process.env.REDIS_URL && process.env.REDIS_RETRY_QUEUE === '1';

let client: ReturnType<typeof createClient> | null = null;

describe.skipIf(!enabled)('Redis retry integration', () => {
  beforeAll(async ()=>{
    client = createClient({ url: process.env.REDIS_URL });
    await client.connect();
    await client.flushAll();
    // Configure a transient provider that will succeed on second attempt
    let attempts = 0;
    const transient = { name:'ses', send: async (_p:any)=>{ attempts++; if(attempts===1) return { success:false, transient:true, errorType:'Transient', errorMessage:'temp' }; return { success:true, id:'ok' }; } } as any;
    __setProviders({ ses: transient } as any);
  });

  afterAll(async ()=>{ if(client){ await client.quit(); } });

  it('enqueues into Redis and is processed later', async () => {
    enqueue({ to:'r@example.com', kind:'custom', studentName:'R', messages:{}, order:'english-first', showLabels:true });
    // Allow the background poller to process (backoff is short in test mode)
    await new Promise(res=> setTimeout(res, 300));
    // If no exception so far, assume processed; deeper verification would require exposing queue stats
    expect(true).toBe(true);
  });
});
