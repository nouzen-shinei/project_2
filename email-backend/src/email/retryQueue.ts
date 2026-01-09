import { emailRetryEnqueued, emailRetryAttempt, emailRetryGiveup, emailRetryQueueSize } from './metrics.js';
import { sendEmail } from './orchestrator.js';
import { enqueueRedis } from './retryQueueRedis.js';
import { notifyBackendRuntimeEmailResult } from './reminderHistoryCallback.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

interface RetryItem { req: any; attempt: number; nextAt: number; maxAttempts: number; }
const queue: RetryItem[] = [];
export function __queueLength(){ return queue.length; }
const testMode = process.env.NODE_ENV === 'test';

function schedule(){
  queue.sort((a,b)=>a.nextAt-b.nextAt);
  emailRetryQueueSize.set(queue.length);
  const now = Date.now();
  const due = queue.filter(q=>q.nextAt<=now);
  for(const item of due){
    const idx = queue.indexOf(item);
    if(idx>=0) queue.splice(idx,1);
    processItem(item);
  }
  setTimeout(schedule, testMode ? 25 : 1000).unref();
}

async function processItem(item: RetryItem){
  emailRetryAttempt.inc();
  try {
  const res = await sendEmail(item.req);
  const reminder = item.req && typeof item.req === 'object' ? (item.req as any).__reminder : undefined;
  const hasReminder = reminder && typeof reminder.historyId === 'string' && reminder.historyId.trim();
  const willRetry = !res.success && !!res.transient && item.attempt+1 < item.maxAttempts;

  if (hasReminder) {
    await notifyBackendRuntimeEmailResult({
      historyId: String(reminder.historyId),
      tenantId: typeof reminder.tenantId === 'string' ? reminder.tenantId : undefined,
      status: res.success ? 'success' : (willRetry ? 'queued' : 'failed'),
      deliveryStatus: res.success ? 'sent' : (willRetry ? 'retrying' : 'failed'),
      emailId: res.success ? res.id : undefined,
      provider: res.provider,
      errorMessage: res.success ? undefined : (res.error || 'send_failed'),
    });
  }

  if(!res.success && res.transient && item.attempt+1 < item.maxAttempts){
      enqueue(item.req, item.attempt+1, item.maxAttempts);
    } else if(!res.success && item.attempt+1 >= item.maxAttempts){
      emailRetryGiveup.inc();
      logger.warn({ msg:'retry_giveup', to: item.req.to, attempts: item.attempt+1, lastError: res.error });
    } else if(res.success){
      logger.info({ msg:'retry_success', to: item.req.to, attempts: item.attempt+1 });
    }
  } catch(e:any){
    const reminder = item.req && typeof item.req === 'object' ? (item.req as any).__reminder : undefined;
    const hasReminder = reminder && typeof reminder.historyId === 'string' && reminder.historyId.trim();
    const willRetry = item.attempt+1 < item.maxAttempts;
    if (hasReminder) {
      await notifyBackendRuntimeEmailResult({
        historyId: String(reminder.historyId),
        tenantId: typeof reminder.tenantId === 'string' ? reminder.tenantId : undefined,
        status: willRetry ? 'queued' : 'failed',
        deliveryStatus: willRetry ? 'retrying' : 'failed',
        errorMessage: e?.message || 'send_exception',
      });
    }
    if(item.attempt+1 < item.maxAttempts){
      enqueue(item.req, item.attempt+1, item.maxAttempts);
    } else {
      emailRetryGiveup.inc();
      logger.error({ msg:'retry_exception_giveup', to: item.req.to, err:e?.message });
    }
  }
}

export function enqueue(req: any, attempt=0, maxAttempts=5){
  if(process.env.REDIS_RETRY_QUEUE === '1'){
    enqueueRedis(req, attempt, maxAttempts);
    return;
  }
  const delayBase = testMode ? 50 : 1000; // shorter in tests
  const backoff = Math.min(testMode? 500:60_000, delayBase * Math.pow(2, attempt) + (testMode?0:Math.random()*200));
  const item: RetryItem = { req, attempt, maxAttempts, nextAt: Date.now()+backoff };
  queue.push(item);
  emailRetryEnqueued.inc();
  emailRetryQueueSize.set(queue.length);
}

schedule();
