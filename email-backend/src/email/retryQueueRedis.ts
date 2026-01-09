import { emailRetryEnqueued, emailRetryAttempt, emailRetryGiveup, emailRetryQueueSize } from './metrics.js';
import { sendEmail } from './orchestrator.js';
import { notifyBackendRuntimeEmailResult } from './reminderHistoryCallback.js';
import pino from 'pino';
import { createClient } from 'redis';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const REDIS_URL = process.env.REDIS_URL;
const ENABLE_REDIS_RETRY = process.env.REDIS_RETRY_QUEUE === '1';
const testMode = process.env.NODE_ENV === 'test';

interface RetryJob { req: any; attempt: number; maxAttempts: number; }

let client: ReturnType<typeof createClient> | null = null;
const qKey = 'email:retry:zset';

async function getClient(){
  if(!ENABLE_REDIS_RETRY) return null;
  if(!client){
    client = createClient({ url: REDIS_URL });
    client.on('error', err=> logger.error({ msg:'redis_retry_error', err: err.message }));
    await client.connect();
  }
  return client;
}

export async function enqueueRedis(req: any, attempt=0, maxAttempts=5){
  if(!ENABLE_REDIS_RETRY) return; // feature flag
  const c = await getClient(); if(!c) return;
  const delayBase = testMode ? 50 : 1000;
  const backoff = Math.min(testMode? 500:60_000, delayBase * Math.pow(2, attempt) + (testMode?0:Math.random()*200));
  const runAt = Date.now() + backoff;
  const job: RetryJob = { req, attempt, maxAttempts };
  await c.zAdd(qKey, [{ score: runAt, value: JSON.stringify(job) }]);
  emailRetryEnqueued.inc();
  await updateSize();
}

async function updateSize(){
  const c = await getClient(); if(!c) return;
  const size = await c.zCard(qKey);
  emailRetryQueueSize.set(size);
}

async function poll(){
  try {
    const c = await getClient();
    if(c){
      const now = Date.now();
      const jobs = await c.zRangeByScore(qKey, 0, now, { LIMIT: { offset:0, count: 25 } });
      for(const raw of jobs){
        const multi = c.multi();
        multi.zRem(qKey, raw);
        try {
          const job: RetryJob = JSON.parse(raw);
          await multi.exec();
          emailRetryAttempt.inc();
          const res = await sendEmail(job.req);

          const reminder = job.req && typeof job.req === 'object' ? (job.req as any).__reminder : undefined;
          const hasReminder = reminder && typeof reminder.historyId === 'string' && reminder.historyId.trim();
          const willRetry = !res.success && !!res.transient && job.attempt+1 < job.maxAttempts;
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

          if(!res.success && res.transient && job.attempt+1 < job.maxAttempts){
            await enqueueRedis(job.req, job.attempt+1, job.maxAttempts);
          } else if(!res.success && job.attempt+1 >= job.maxAttempts){
            emailRetryGiveup.inc();
            logger.warn({ msg:'retry_giveup', to: job.req.to, attempts: job.attempt+1, lastError: res.error });
          } else if(res.success){
            logger.info({ msg:'retry_success', to: job.req.to, attempts: job.attempt+1 });
          }
        } catch(e:any){
          try {
            const reminder = (raw && typeof raw === 'string') ? ((): any => { try { return JSON.parse(raw)?.req?.__reminder; } catch { return undefined; } })() : undefined;
            const hasReminder = reminder && typeof reminder.historyId === 'string' && reminder.historyId.trim();
            if (hasReminder) {
              await notifyBackendRuntimeEmailResult({
                historyId: String(reminder.historyId),
                tenantId: typeof reminder.tenantId === 'string' ? reminder.tenantId : undefined,
                status: 'queued',
                deliveryStatus: 'retrying',
                errorMessage: e?.message || 'send_exception',
              });
            }
          } catch {}
          logger.error({ msg:'retry_redis_process_error', err:e?.message });
        }
      }
      await updateSize();
    }
  } catch(e:any){
    logger.error({ msg:'retry_redis_poll_error', err:e?.message });
  } finally {
    setTimeout(poll, testMode? 50: 1000).unref();
  }
}

if(ENABLE_REDIS_RETRY){
  poll();
}
