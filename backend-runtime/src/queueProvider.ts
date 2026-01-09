/* eslint-disable @typescript-eslint/no-require-imports -- dynamic require preserves optional backend dependencies */
const useBull = process.env.USE_BULLMQ==='true' && !!process.env.REDIS_URL;
let backend: any;
if(useBull){
  try { backend = require('./bullmqQueue'); console.log('[queueProvider] BullMQ active'); }
  catch(e){ console.error('[queueProvider] BullMQ load failed, fallback to memory', e); backend = require('./queue'); }
} else { backend = require('./queue'); console.log('[queueProvider] In-memory queue'); }

export function enqueueReminder(p:any){ return backend.enqueueReminder(p); }
export function enqueueCustomMessage(p:any){ return backend.enqueueCustomMessage(p); }
export function enqueuePaymentConfirmation(p:any){ return backend.enqueuePaymentConfirmation(p); }
export function enqueueBirthdayGreeting(p:any){ return backend.enqueueBirthdayGreeting(p); }
export function getJobStatus(id:string, tenantId?: string){ return backend.getJobStatus(id, tenantId); }
export function listJobStatus(ids:string[], tenantId?: string){ return backend.listJobStatus(ids, tenantId); }
export function getInMemoryQueueSnapshot(){ return backend.getInMemoryQueueSnapshot(); }
export function shutdownQueue(){ return backend.shutdownQueue ? backend.shutdownQueue() : Promise.resolve(); }

