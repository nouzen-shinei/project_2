import { buildFeeReminderTemplate, buildCustomMessageTemplate, buildPaymentConfirmationTemplate, buildBirthdayGreetingTemplate, FeeReminderTemplatePayload, CustomMessageQueuePayload, PaymentConfirmationQueuePayload, BirthdayGreetingPayload } from './templateBuilders';
import { inc, observeDuration, metricNames, recordJobResult } from './metrics';
import { persistSnapshot, loadPersisted, recordMessageMap } from './storage';
import fetch from 'node-fetch';
import { hydrateTenantTemplatePayload } from './tenantTemplateHydrator';
import * as admin from 'firebase-admin';
import { getFirestore } from './firebaseAdmin';
import { renderWhatsAppTemplateMessage } from './whatsappTemplateRenderer';
import { finalizeReminderQuotaFromHistory } from './lib/reminderQuota';

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

interface Job { id: string; type: 'fee'|'custom'|'payment'|'birthday'; payload: any; status: string; attempts: number; error?: string; enqueuedAt: number; startedAt?: number; durationMs?: number; tenantId: string; }
const LEGACY_TENANT_ID = 'legacy-unscoped';
const JOBS: Record<string, Job> = loadPersisted();
const PROCESSING = new Set<string>();
const CONCURRENCY = Number(process.env.WHATSAPP_QUEUE_CONCURRENCY||4);
let active = 0;
let shuttingDown = false;

function deriveTenantId(payload: any): string {
  const raw = typeof payload?.tenantId === 'string' ? payload.tenantId.trim() : '';
  if (raw) return raw;
  const fromMeta = typeof payload?.metadata?.tenantId === 'string' ? payload.metadata.tenantId.trim() : '';
  if (fromMeta) return fromMeta;
  return LEGACY_TENANT_ID;
}

let backfilledTenants = false;
Object.values(JOBS).forEach((job) => {
  if (!job.tenantId || typeof job.tenantId !== 'string') {
    job.tenantId = deriveTenantId(job.payload);
    backfilledTenants = true;
  }
});
if (backfilledTenants) {
  console.log('[queue] backfilled tenant metadata for existing jobs');
  persistSnapshot(JOBS);
}

export function enqueueReminder(p: FeeReminderTemplatePayload) { return enqueue('fee', p); }
export function enqueueCustomMessage(p: CustomMessageQueuePayload) { return enqueue('custom', p); }
export function enqueuePaymentConfirmation(p: PaymentConfirmationQueuePayload) { return enqueue('payment', p); }
export function enqueueBirthdayGreeting(p: BirthdayGreetingPayload) { return enqueue('birthday', p); }
function enqueue(type: Job['type'], payload: any) {
  if(shuttingDown) throw new Error('shutting_down');
  const id = `${Date.now()}-${Math.random().toString(36).slice(2,11)}`;
  const tenantId = deriveTenantId(payload);
  if (!payload.tenantId) payload.tenantId = tenantId; // ensure downstream payloads include tenant
  JOBS[id] = { id, type, payload, status: 'queued', attempts: 0, enqueuedAt: Date.now(), tenantId };
  console.log('[queue] enqueued', { id, type, tenantId, toMasked: maskRecipient(payload?.to), selectedLanguage: payload?.selectedLanguage, hasEnNote: !!payload?.customNotesEnglish, hasHiNote: !!payload?.customNotesHindi });
  inc(metricNames.enqueued, { type, tenantId });
  persistSnapshot(JOBS);
  drain();
  return id;
}

function drain() {
  while (active < CONCURRENCY) {
    const next = Object.values(JOBS).find(j => j.status==='queued' && !PROCESSING.has(j.id));
    if (!next) break;
    PROCESSING.add(next.id); active++;
    run(next).finally(()=>{ PROCESSING.delete(next.id); active--; setTimeout(drain,0); });
  }
}

async function run(job: Job) {
  job.status='processing'; job.startedAt=Date.now();
  console.log('[queue] start', { id: job.id, type: job.type });
  try {
    const result = job.type==='fee' ? await sendFee(job.payload)
      : job.type==='custom' ? await sendCustom(job.payload)
      : job.type==='birthday' ? await sendBirthday(job.payload)
      : await sendPayment(job.payload);
    if(result && typeof result === 'object') { // { ok, messageId }
      job.status = result.ok ? 'success':'failed';
      if(result.messageId) recordMessageMap(result.messageId, job.id);
      console.log('[queue] result', { id: job.id, ok: result.ok, messageId: result.messageId });

      // Best-effort: reflect final WhatsApp delivery outcome in reminderHistory.
      // This prevents reminders from staying 'pending' forever when using the in-memory queue.
      try {
        const historyId = typeof job.payload?.historyId === 'string' ? job.payload.historyId.trim() : '';
        if (historyId) {
          const db = getFirestore();
          const ref = db.collection('reminderHistory').doc(historyId);
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const existing = snap.exists ? snap.data() || {} : {};
            // L13: never overwrite a reminderHistory doc owned by a DIFFERENT tenant.
            // Guards against a job carrying a spoofed historyId that points at another
            // tenant's record. In normal operation the doc's tenantId equals
            // job.tenantId (the client created it in its own tenant) or the doc
            // doesn't exist yet.
            const existingTenantId = (existing as any)?.tenantId;
            if (snap.exists && typeof existingTenantId === 'string' && existingTenantId && existingTenantId !== job.tenantId) {
              return;
            }
            const existingCreatedAt = (existing as any)?.createdAt;
            const needsCreatedAt = !(existingCreatedAt instanceof admin.firestore.Timestamp);

            const whatsappTemplate = {
              name: (result as any).templateName,
              language: (result as any).language,
              components: (result as any).components,
            };

            const renderedMessage = renderWhatsAppTemplateMessage(
              typeof whatsappTemplate.name === 'string' ? whatsappTemplate.name : undefined,
              Array.isArray(whatsappTemplate.components) ? (whatsappTemplate.components as any) : undefined
            );

            tx.set(
              ref,
              stripUndefinedDeep({
                ...(needsCreatedAt ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
                tenantId: job.tenantId,
                reminderType: 'whatsapp',
                status: result.ok ? 'success' : 'failed',
                message: renderedMessage || undefined,
                metadata: {
                  ...(job.payload?.metadata && typeof job.payload.metadata === 'object' ? job.payload.metadata : {}),
                  ...(result.messageId ? { messageId: result.messageId } : {}),
                  deliveryStatus: result.ok ? 'sent' : 'failed',
                  whatsappTemplate,
                  whatsappRenderedMessage: renderedMessage || undefined,
                },
                errorMessage: result.ok ? undefined : (job.error || 'whatsapp_send_failed'),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              { merge: true }
            );
          });

          try {
            await finalizeReminderQuotaFromHistory(db, {
              historyId,
              finalStatus: result.ok ? 'success' : 'failed',
              fallbackTenantId: job.tenantId,
              expectedTenantId: job.tenantId,
              fallbackChannel: 'whatsapp',
            });
          } catch (e) {
            console.warn('[queue] quota finalize failed', e);
          }
        }
      } catch (e) {
        console.warn('[queue] reminderHistory update failed', e);
      }
    } else {
      const ok = !!result;
      job.status = ok ? 'success':'failed';
      console.log('[queue] primitive result', { id: job.id, ok });

      try {
        const historyId = typeof job.payload?.historyId === 'string' ? job.payload.historyId.trim() : '';
        if (historyId) {
          const db = getFirestore();
          const ref = db.collection('reminderHistory').doc(historyId);
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const existing = snap.exists ? snap.data() || {} : {};
            // L13: never overwrite a reminderHistory doc owned by a DIFFERENT tenant.
            // Guards against a job carrying a spoofed historyId that points at another
            // tenant's record. In normal operation the doc's tenantId equals
            // job.tenantId (the client created it in its own tenant) or the doc
            // doesn't exist yet.
            const existingTenantId = (existing as any)?.tenantId;
            if (snap.exists && typeof existingTenantId === 'string' && existingTenantId && existingTenantId !== job.tenantId) {
              return;
            }
            const existingCreatedAt = (existing as any)?.createdAt;
            const needsCreatedAt = !(existingCreatedAt instanceof admin.firestore.Timestamp);

            const whatsappTemplate = {
              name: (result as any)?.templateName,
              language: (result as any)?.language,
              components: (result as any)?.components,
            };

            const renderedMessage = renderWhatsAppTemplateMessage(
              typeof whatsappTemplate.name === 'string' ? whatsappTemplate.name : undefined,
              Array.isArray(whatsappTemplate.components) ? (whatsappTemplate.components as any) : undefined
            );

            tx.set(
              ref,
              stripUndefinedDeep({
                ...(needsCreatedAt ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
                tenantId: job.tenantId,
                reminderType: 'whatsapp',
                status: ok ? 'success' : 'failed',
                message: renderedMessage || undefined,
                metadata: {
                  ...(job.payload?.metadata && typeof job.payload.metadata === 'object' ? job.payload.metadata : {}),
                  deliveryStatus: ok ? 'sent' : 'failed',
                  whatsappTemplate,
                  whatsappRenderedMessage: renderedMessage || undefined,
                },
                errorMessage: ok ? undefined : (job.error || 'whatsapp_send_failed'),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              { merge: true }
            );
          });

          try {
            await finalizeReminderQuotaFromHistory(db, {
              historyId,
              finalStatus: ok ? 'success' : 'failed',
              fallbackTenantId: job.tenantId,
              expectedTenantId: job.tenantId,
              fallbackChannel: 'whatsapp',
            });
          } catch (e) {
            console.warn('[queue] quota finalize failed', e);
          }
        }
      } catch (e) {
        console.warn('[queue] reminderHistory update failed', e);
      }
    }
  } catch (e:any) {
    job.status = 'failed';
    job.error = typeof e?.message === 'string' && e.message.trim() ? e.message : String(e);

    // Best-effort: reflect thrown exceptions in reminderHistory as a final failed state.
    // Without this, reminders can get stuck in 'pending' when the job throws before returning a result.
    try {
      const historyId = typeof job.payload?.historyId === 'string' ? job.payload.historyId.trim() : '';
      if (historyId) {
        const db = getFirestore();
        const ref = db.collection('reminderHistory').doc(historyId);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          const existing = snap.exists ? snap.data() || {} : {};
          // L13: never overwrite a reminderHistory doc owned by a DIFFERENT tenant
          // (exception/throw path — mirrors the success-path guard).
          const existingTenantId = (existing as any)?.tenantId;
          if (snap.exists && typeof existingTenantId === 'string' && existingTenantId && existingTenantId !== job.tenantId) {
            return;
          }
          const existingCreatedAt = (existing as any)?.createdAt;
          const needsCreatedAt = !(existingCreatedAt instanceof admin.firestore.Timestamp);

          tx.set(
            ref,
            stripUndefinedDeep({
              ...(needsCreatedAt ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
              tenantId: job.tenantId,
              reminderType: 'whatsapp',
              status: 'failed',
              metadata: {
                ...(job.payload?.metadata && typeof job.payload.metadata === 'object' ? job.payload.metadata : {}),
                deliveryStatus: 'failed',
              },
              errorMessage: job.error || 'whatsapp_send_exception',
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }),
            { merge: true }
          );
        });

        try {
          await finalizeReminderQuotaFromHistory(db, {
            historyId,
            finalStatus: 'failed',
            fallbackTenantId: job.tenantId,
            expectedTenantId: job.tenantId,
            fallbackChannel: 'whatsapp',
          });
        } catch (quotaError) {
          console.warn('[queue] quota finalize failed', quotaError);
        }
      }
    } catch (historyError) {
      console.warn('[queue] reminderHistory update failed', historyError);
    }
  }
  job.durationMs=Date.now()-job.startedAt!;
  if(job.status==='failed') console.warn('[queue] failed', { id: job.id, error: job.error });
  observeDuration(job.durationMs!);
  if (job.status === 'success') {
    inc(metricNames.completed, { status: 'success', tenantId: job.tenantId });
  } else if (job.status === 'failed') {
    inc(metricNames.completed, { status: 'failed', tenantId: job.tenantId });
  }
  recordJobResult(job.status==='success');
  persistSnapshot(JOBS);
}

async function sendFee(p: FeeReminderTemplatePayload) {
  await hydrateTenantTemplatePayload(p, { legacyTenantId: LEGACY_TENANT_ID });
  const built = buildFeeReminderTemplate(p);
  return sendTemplate(p.to, built.templateName, built.language, built.parameters);
}
async function sendCustom(p: CustomMessageQueuePayload) {
  await hydrateTenantTemplatePayload(p, { legacyTenantId: LEGACY_TENANT_ID });
  const built = buildCustomMessageTemplate(p);
  return sendTemplate(p.to, built.templateName, built.language, built.parameters);
}
async function sendPayment(p: PaymentConfirmationQueuePayload) {
  await hydrateTenantTemplatePayload(p, { legacyTenantId: LEGACY_TENANT_ID });
  const built = buildPaymentConfirmationTemplate(p);
  return sendTemplate(p.to, built.templateName, built.language, built.parameters);
}
async function sendBirthday(p: BirthdayGreetingPayload) {
  await hydrateTenantTemplatePayload(p, { legacyTenantId: LEGACY_TENANT_ID });
  const built = buildBirthdayGreetingTemplate(p);
  return sendTemplate(p.to, built.templateName, built.language, built.parameters, built.headerParameters);
}

// Minimal, safe recipient normalization for the WhatsApp Cloud API.
// Strips formatting noise (spaces, dashes, parentheses, dots) that WABA rejects,
// while PRESERVING an already-valid number: a single leading '+' is kept and all
// digits are retained (including the country code). It intentionally does NOT
// infer or add a country code, so numbers that already deliver are unchanged.
function normalizeWhatsAppRecipient(raw: string): string {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return trimmed; // nothing usable; let WABA report the error
  return hasPlus ? `+${digits}` : digits;
}

// Mask a recipient phone number for logs — keep only the last 4 digits so logs
// stay debuggable without leaking full PII (security-rules-hardening L9).
function maskRecipient(value: unknown): string | undefined {
  const s = value == null ? '' : String(value);
  if (!s) return undefined;
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

async function sendTemplate(to: string, templateName: string, language: string, params: any[], headerParams?: any[]) {
  if (!process.env.WABA_PHONE_NUMBER_ID || !process.env.WABA_TOKEN) { console.log('[wa] dry-run (missing WABA env)'); return { ok: true }; }// dry-run
  to = normalizeWhatsAppRecipient(to);
  // WhatsApp Cloud API expects each parameter to be an object like { type: 'text', text: 'value' }
  const mappedParams = params.map(p => {
    if (p && typeof p === 'object' && 'type' in p) return p; // already structured
    return { type: 'text', text: String(p ?? '') };
  });
  if(params.length!==mappedParams.length) console.warn('[wa] param length mismatch', { raw: params.length, mapped: mappedParams.length });
  const components: any[] = [];
  if (headerParams && headerParams.length) {
    const mappedHeader = headerParams.map(p => {
      if (p && typeof p === 'object' && 'type' in p) return p;
      return { type: 'text', text: String(p ?? '') };
    });
    components.push({ type: 'header', parameters: mappedHeader });
  }
  components.push({ type: 'body', parameters: mappedParams });
  // Do NOT log rendered params (they contain parent names/amounts — PII, L9).
  console.log('[wa] params', { bodyCount: mappedParams.length, headerCount: headerParams?.length ?? 0 });
  const body = { messaging_product: 'whatsapp', to, type: 'template', template: { name: templateName, language: { code: language }, components } };
  const url = `https://graph.facebook.com/v20.0/${process.env.WABA_PHONE_NUMBER_ID}/messages`;
  console.log('[wa] sending', { toMasked: maskRecipient(to), templateName, language, url });
  const r = await fetch(url, { method:'POST', headers:{'Authorization':`Bearer ${process.env.WABA_TOKEN}`,'Content-Type':'application/json'}, body: JSON.stringify(body) });
  let messageId: string|undefined;
  let json: any = null;
  try { json = await r.json(); messageId = json?.messages?.[0]?.id; } catch(e){ console.warn('[wa] response parse error', e); }
  if(!r.ok) console.warn('[wa] send failed', { status: r.status, statusText: r.statusText, response: json, templateName, toMasked: maskRecipient(to) });
  else console.log('[wa] sent', { toMasked: maskRecipient(to), templateName, messageId });
  return { ok: r.ok, messageId, templateName, language, components };
}

function matchesTenant(job: Job | undefined, tenantId?: string) {
  if (!job) return false;
  if (!tenantId) return true;
  return job.tenantId === tenantId;
}

function serializeJob(job: Job) {
  return { status: job.status, attempts: job.attempts, error: job.error, tenantId: job.tenantId };
}

export function getJobStatus(id: string, tenantId?: string) {
  const job = JOBS[id];
  if (!matchesTenant(job, tenantId)) return undefined;
  return serializeJob(job!);
}

export function listJobStatus(ids: string[], tenantId?: string) {
  return ids
    .map((id) => {
      const candidate = JOBS[id];
      const job = matchesTenant(candidate, tenantId) ? candidate : undefined;
      if (job) return { id, ...serializeJob(job) };
      if (tenantId && candidate) return { id, status: 'unauthorized' as const };
      return { id, status: 'unknown' as const };
    })
    .filter((entry) => !(tenantId && entry.status === 'unauthorized'));
}
export function getInMemoryQueueSnapshot() { const queued = Object.values(JOBS).filter(j=>j.status==='queued').length; const processing = Object.values(JOBS).filter(j=>j.status==='processing').length; return { queued, processing }; }
export { JOBS };
export function shutdownQueue(){ shuttingDown = true; return new Promise<void>(resolve=>{ const poll=()=>{ if(active===0 && !Object.values(JOBS).some(j=>j.status==='processing')) return resolve(); setTimeout(poll,50); }; poll(); }); }

