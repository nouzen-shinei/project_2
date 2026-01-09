import { Queue, Worker } from 'bullmq';
import fetch from 'node-fetch';
import { buildFeeReminderTemplate, buildCustomMessageTemplate, FeeReminderTemplatePayload, CustomMessageQueuePayload } from './templateBuilders';
import { inc, observeDuration, metricNames, recordJobResult } from './metrics';
import { recordMessageMap } from './storage';
import { hydrateTenantTemplatePayload } from './tenantTemplateHydrator';
import * as admin from 'firebase-admin';
import { getFirestore } from './firebaseAdmin';
import { finalizeReminderQuotaFromHistory } from './lib/reminderQuota';

const connection = { connection: { url: process.env.REDIS_URL! } };
const queueName = process.env.WHATSAPP_QUEUE_NAME || 'wa-reminders';
const queue = new Queue(queueName, connection);
const LEGACY_TENANT_ID = 'legacy-unscoped';

function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined) as any;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype) {
      return value;
    }
    const out: Record<string, any> = {};
    for (const [key, entry] of Object.entries(value as any)) {
      const cleaned = stripUndefinedDeep(entry);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out as any;
  }
  return value;
}

const JOB_OPTIONS: any = { attempts: 4, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000, removeOnFail: 5000 };

function ensureTenant<T extends { tenantId?: string }>(payload: T): T & { tenantId: string } {
  const tenantId = typeof payload?.tenantId === 'string' && payload.tenantId.trim()
    ? payload.tenantId.trim()
    : LEGACY_TENANT_ID;
  if (payload.tenantId !== tenantId) {
    (payload as any).tenantId = tenantId;
  }
  return payload as T & { tenantId: string };
}

export async function enqueueReminder(payload: FeeReminderTemplatePayload) {
  const normalized = ensureTenant(payload);
  inc(metricNames.enqueued,{type:'fee', tenantId: normalized.tenantId});
  return (await queue.add('feeReminder', normalized, JOB_OPTIONS)).id;
}
export async function enqueueCustomMessage(payload: CustomMessageQueuePayload) {
  const normalized = ensureTenant(payload);
  inc(metricNames.enqueued,{type:'custom', tenantId: normalized.tenantId});
  return (await queue.add('customMessage', { ...normalized, __custom: true }, JOB_OPTIONS)).id;
}

function resolveTenant(data: any): string {
  const raw = typeof data?.tenantId === 'string' && data.tenantId.trim() ? data.tenantId.trim() : '';
  if (raw) return raw;
  return LEGACY_TENANT_ID;
}

export async function getJobStatus(id: string, tenantId?: string) {
  const job = await queue.getJob(id);
  if(!job) return undefined;
  const jobTenant = resolveTenant(job.data);
  if (tenantId && jobTenant !== tenantId) return undefined;
  const state = await job.getState();
  return { status: mapState(state), attempts: job.attemptsMade, error: job.failedReason, tenantId: jobTenant };
}
export async function listJobStatus(ids: string[], tenantId?: string) {
  const results = await Promise.all(ids.map(async id => {
    const job = await queue.getJob(id);
    if (!job) return { id, status: 'unknown' as const };
    const jobTenant = resolveTenant(job.data);
    if (tenantId && jobTenant !== tenantId) return { id, status: 'unauthorized' as const };
    const state = await job.getState();
    return { id, status: mapState(state), attempts: job.attemptsMade, error: job.failedReason, tenantId: jobTenant };
  }));
  return results.filter(entry => !(tenantId && entry.status === 'unauthorized'));
}
export async function getInMemoryQueueSnapshot() { const c = await queue.getJobCounts(); const queued = (c.waiting||0)+(c.delayed||0)+(c.prioritized||0); const processing = c.active||0; return { queued, processing }; }

const worker = new Worker(queueName, async job => {
  const start = Date.now();
  const isCustom = !!job.data.__custom;
  const p = job.data as (FeeReminderTemplatePayload | CustomMessageQueuePayload & { __custom?: boolean });
  const tenantId = resolveTenant(job.data);
  let result: any;
  let ok = false;
  let thrown: any = null;
  try {
    result = isCustom ? await sendCustom(p as any) : await sendFee(p as any);
    ok = !!result?.ok;
    if (result?.messageId) recordMessageMap(result.messageId, job.id!);
  } catch (e) {
    thrown = e;
    ok = false;
  }

  // Best-effort: reflect final WhatsApp delivery outcome in reminderHistory.
  // Also cover thrown exceptions so reminders don't stay 'pending' forever.
  try {
    const historyId = typeof (job.data as any)?.historyId === 'string' ? String((job.data as any).historyId).trim() : '';
    if (historyId) {
      const db = getFirestore();
      const ref = db.collection('reminderHistory').doc(historyId);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const existing = snap.exists ? snap.data() || {} : {};
        const existingCreatedAt = (existing as any)?.createdAt;
        const needsCreatedAt = !(existingCreatedAt instanceof admin.firestore.Timestamp);
        const errorMessage =
          ok
            ? undefined
            : typeof thrown?.message === 'string' && thrown.message.trim()
              ? thrown.message
              : 'whatsapp_send_failed';

        tx.set(
          ref,
          stripUndefinedDeep({
            ...(needsCreatedAt ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
            tenantId,
            reminderType: 'whatsapp',
            status: ok ? 'success' : 'failed',
            metadata: {
              ...(((job.data as any)?.metadata && typeof (job.data as any).metadata === 'object') ? (job.data as any).metadata : {}),
              ...(result?.messageId ? { messageId: result.messageId } : {}),
              deliveryStatus: ok ? 'sent' : 'failed',
            },
            errorMessage,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }),
          { merge: true }
        );
      });

      try {
        await finalizeReminderQuotaFromHistory(db, {
          historyId,
          finalStatus: ok ? 'success' : 'failed',
          fallbackTenantId: tenantId,
          fallbackChannel: 'whatsapp',
        });
      } catch (e) {
        console.warn('[BullMQ] quota finalize failed', e);
      }
    }
  } catch (e) {
    console.warn('[BullMQ] reminderHistory update failed', e);
  }

  observeDuration(Date.now()-start);
  inc(metricNames.completed,{status: ok? 'success':'failed', tenantId});
  recordJobResult(ok);
  if (!ok) {
    if (thrown instanceof Error) throw thrown;
    throw new Error('send_failed');
  }
}, { ...connection, concurrency: Number(process.env.WHATSAPP_QUEUE_CONCURRENCY||8) });
worker.on('failed', (job, err) => { console.error('[BullMQ] Job failed', job?.id, err?.message); });

function mapState(state: string){ if(state==='completed') return 'success'; if(state==='failed') return 'failed'; if(state==='active') return 'processing'; return 'queued'; }

async function sendFee(p: FeeReminderTemplatePayload){ await hydrateTenantTemplatePayload(p, { legacyTenantId: LEGACY_TENANT_ID }); const built = buildFeeReminderTemplate(p); return sendTemplate(p.to, built.templateName, built.language, built.parameters); }
async function sendCustom(p: CustomMessageQueuePayload){ await hydrateTenantTemplatePayload(p, { legacyTenantId: LEGACY_TENANT_ID }); const built = buildCustomMessageTemplate(p); return sendTemplate(p.to, built.templateName, built.language, built.parameters); }
async function sendTemplate(to:string, templateName:string, language:string, params:any[]){
  if(!process.env.WABA_PHONE_NUMBER_ID||!process.env.WABA_TOKEN) return { ok:true };
  const mappedParams = params.map(p => (p && typeof p === 'object' && 'type' in p) ? p : { type:'text', text: String(p ?? '') });
  if(params.length!==mappedParams.length) console.warn('[wa-bull] param length mismatch', { raw: params.length, mapped: mappedParams.length });
  console.log('[wa-bull] params preview', mappedParams.slice(0,5));
  const body = { messaging_product:'whatsapp', to, type:'template', template:{ name: templateName, language:{ code: language }, components:[{ type:'body', parameters: mappedParams }] } };
  const r = await fetch(`https://graph.facebook.com/v20.0/${process.env.WABA_PHONE_NUMBER_ID}/messages`, { method:'POST', headers:{ 'Authorization':`Bearer ${process.env.WABA_TOKEN}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  let messageId: string|undefined; try { const json:any = await r.json(); messageId = json?.messages?.[0]?.id; } catch {/*ignore*/}
  if(r.status===429||r.status>=500) return { ok:false, messageId };
  return { ok:r.ok, messageId };
}

