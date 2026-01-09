import { describe, it, expect } from 'vitest';
import { __setProviders } from '../orchestrator.js';
import type { EmailProvider } from '../types.js';
import { enqueue, __queueLength } from '../retryQueue.js';

const events: string[] = [];
const mk = (name:string, list:any[]): EmailProvider => ({ name, async send(){ return list.shift(); } });

describe('retryQueue', () => {
  it('retries transient failures and eventually succeeds', async () => {
    const seq = [ { success:false, transient:true, errorMessage:'t1' }, { success:false, transient:true, errorMessage:'t2' }, { success:true, id:'ok' } ];
    __setProviders({ only: mk('only', seq as any) } as any);
    enqueue({ to:'x@example.com', kind:'custom', studentName:'X', messages:{ en:'Hi'}, order:'english-first' });
    await new Promise((resolve, reject)=>{
      const start = Date.now();
      const interval = setInterval(()=>{
        if(seq.length===0 && __queueLength()===0){ clearInterval(interval); resolve(null); }
        else if(Date.now()-start>1500){ clearInterval(interval); reject(new Error('timeout waiting for retries')); }
      }, 50);
    });
  });
});
