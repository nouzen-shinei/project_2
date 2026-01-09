import 'dotenv/config';
import express from 'express';
import { z } from 'zod';
import { registry } from './email/metrics.js';
import { notifyBackendRuntimeEmailResult } from './email/reminderHistoryCallback.js';
import crypto from 'crypto';
import { addSuppression, allSuppressions, purgeSuppression } from './email/suppressionStore.js';
import { sendEmail } from './email/orchestrator.js';
import { getConfigStatus } from './config.js';
import { getLastQuota } from './email/quotaPoller.js';
import pino from 'pino';
import { getIdempotent, setIdempotent, resolveIdempotent, clearIdempotentAll, idempotentSize } from './email/idempotencyStore.js';
import { validateSnsSignature, maybeAutoConfirm } from './email/snsValidator.js';
import { idempotentReplayTotal, adminRequestsTotal, adminRateLimitedTotal, emailSendTotal, emailRetryQueueSize, providerCircuitState } from './email/metrics.js';
import { enqueue } from './email/retryQueue.js';
import { audit } from './persistence/auditLogger.js';
import { renderTemplate, TemplateKind } from './email/templates.js';
import { logSend } from './persistence/sendLog.js';
import { adminRateCheck } from './rateLimit/adminLimiter.js';
import { getRedis, hasRedis } from './persistence/redisAdapter.js';
import jwt from 'jsonwebtoken';
import { initializeApp, applicationDefault, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { secondsUntilEndOfDay } from './util/dayKey.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export const app = express();
app.use(express.json({ limit: '256kb' }));
// Simple CORS (configure with CORS_ORIGINS, comma separated; default allow all)
app.use((req, res, next) => {
  const configured = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin as string | undefined;
  const allowAll = configured.includes('*');
  if (allowAll) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && configured.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-internal-key, idempotency-key, x-tenant');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Request ID + logging middleware
app.use((req,res,next)=>{
  const rid = req.header('x-request-id') || crypto.randomBytes(8).toString('hex');
  (req as any).rid = rid;
  res.setHeader('x-request-id', rid);
  const start = Date.now();
  res.on('finish', ()=>{
    logger.info({ msg:'req', rid, method:req.method, path:req.path, status:res.statusCode, ms: Date.now()-start });
  });
  next();
});

// === Backend-runtime style internal auth helpers ===
function signInternalToken(sub: string, ttlSec=300){
  const secret = process.env.INTERNAL_API_KEY;
  if(!secret) throw new Error('not_enabled');
  const exp = Math.floor(Date.now()/1000)+ttlSec;
  const payload = Buffer.from(JSON.stringify({ sub, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function verifyInternalToken(tok?: string){
  try {
    if(!tok) return false;
    const secrets = [process.env.INTERNAL_API_KEY, process.env.INTERNAL_API_KEY_PREV].filter(Boolean) as string[];
    if(secrets.length===0) return false;
    const [p,s] = tok.split('.') as [string,string];
    if(!p||!s) return false;
    // Check signature against any allowed secret (supports rotation)
    let sigOk = false;
    for(const sec of secrets){
      const expSig = crypto.createHmac('sha256', sec).update(p).digest('base64url');
      if(expSig===s){ sigOk = true; break; }
    }
    if(!sigOk) return false;
    const data = JSON.parse(Buffer.from(p,'base64url').toString('utf8')) as { exp?: number };
    if(!data.exp || data.exp < Math.floor(Date.now()/1000)) return false;
    return true;
  } catch { return false; }
}

// Firebase Admin init (needed for /auth/bridge). Uses application default credentials + projectId.
let fbInited = false;
function ensureFirebase(){
  if(fbInited) return;
  try {
    if(getApps().length===0){
      const projectId = process.env.FIREBASE_PROJECT_ID || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
      try { initializeApp({ credential: applicationDefault(), projectId: projectId as any }); }
      catch { initializeApp({ projectId: projectId as any }); }
    }
    fbInited = true;
  } catch (e) {
    logger.warn({ msg:'firebase_init_warn', err: (e as any)?.message });
  }
}

function sanitizeForFirestore(value: any): any {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(sanitizeForFirestore).filter((v) => v !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = sanitizeForFirestore(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

function normalizeMonthIdUtcNow(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

async function consumeEmailReminderReservationToken(opts: {
  tenantId: string;
  quotaBatchId: string;
  historyId?: string;
  history?: any;
}) {
  ensureFirebase();
  const db = getFirestore();
  const monthId = normalizeMonthIdUtcNow();
  const ref = db
    .collection('tenantReminderReservations')
    .doc(opts.tenantId)
    .collection('months')
    .doc(monthId)
    .collection('batches')
    .doc(opts.quotaBatchId);
  const usageRef = db.collection('tenantReminderUsage').doc(opts.tenantId).collection('months').doc(monthId);
  const historyRef = opts.historyId ? db.collection('reminderHistory').doc(opts.historyId) : null;

  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw Object.assign(new Error('reminder_quota_reservation_missing'), { code: 'reminder_quota_reservation_missing' });
    }
    const data = snap.data() || {};
    const expiresAt = (data as any).expiresAt;
    if (expiresAt && typeof (expiresAt as any).toMillis === 'function' && (expiresAt as any).toMillis() <= now) {
      throw Object.assign(new Error('reminder_quota_reservation_expired'), { code: 'reminder_quota_reservation_expired' });
    }
    const remaining = (data as any).remaining || {};
    const remainingEmail = typeof remaining.email === 'number' && Number.isFinite(remaining.email) ? Number(remaining.email) : 0;
    const totalRemaining =
      typeof (data as any).totalRemaining === 'number' && Number.isFinite((data as any).totalRemaining)
        ? Number((data as any).totalRemaining)
        : 0;
    if (remainingEmail <= 0 || totalRemaining <= 0) {
      throw Object.assign(new Error('reminder_quota_reservation_exhausted'), { code: 'reminder_quota_reservation_exhausted' });
    }

    const usageSnap = await tx.get(usageRef);
    const usagePayload: Record<string, any> = {
      tenantId: opts.tenantId,
      month: monthId,
      inFlightTotal: FieldValue.increment(1),
      inFlightEmail: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!usageSnap.exists) {
      usagePayload.createdAt = FieldValue.serverTimestamp();
    }
    tx.set(usageRef, usagePayload, { merge: true });

    if (historyRef) {
      const historySnap = await tx.get(historyRef);
      const base: Record<string, any> = {
        tenantId: opts.tenantId,
        reminderType: 'email',
        status: 'pending',
        quota: {
          tenantId: opts.tenantId,
          monthId,
          batchId: opts.quotaBatchId,
          channel: 'email',
          inFlight: true,
          billed: false,
        },
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!historySnap.exists) {
        base.createdAt = FieldValue.serverTimestamp();
      }
      tx.set(historyRef, sanitizeForFirestore({ ...(opts.history || {}), ...base }), { merge: true });
    }

    tx.set(
      ref,
      {
        'remaining.email': FieldValue.increment(-1),
        totalRemaining: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

// Bridge: verify Firebase ID token and mint short-lived internal token
app.post('/auth/bridge', async (req,res)=>{
  try {
    if(!process.env.INTERNAL_API_KEY) return res.status(501).json({ error:'not_enabled' });
    const auth = req.header('authorization');
    let idToken = auth?.startsWith('Bearer ')? auth.slice(7): undefined;
    if(!idToken) idToken = (req.body && (req.body as any).firebaseIdToken) || undefined;
    if(!idToken) return res.status(400).json({ error:'missing_id_token' });
  ensureFirebase();
  await getAuth().verifyIdToken(idToken);
    const ttl=300; const token = signInternalToken('app', ttl);
    return res.json({ token, expiresIn: ttl, expiresAt: Date.now()+ttl*1000 });
  } catch(e:any){ return res.status(401).json({ error:'invalid_id_token', details: e?.message }); }
});

app.get('/health', (_req,res)=>{
  const cfg = getConfigStatus();
  const healthy = cfg.missing.length === 0;
  res.status(healthy?200:500).json({ status: healthy?'ok':'degraded', ts: Date.now(), config: cfg, quota: getLastQuota() });
});
app.get('/metrics', async (_req,res)=>{
  try {
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  } catch(e:any){ res.status(500).send('metrics_error'); }
});

// Minimal metrics dashboard (unauthenticated; protect via gateway if needed)
app.get('/dashboard/metrics', async (req,res)=>{
  try {
    // Protect with INTERNAL_API_KEY if set
    const internalKey = process.env.INTERNAL_API_KEY;
    if(internalKey){
      const provided = req.header('x-internal-key');
      if(provided !== internalKey){ return res.status(401).json({ error:'unauthorized' }); }
    }
    const text = await registry.metrics();
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Email Metrics</title>
    <style>body{font-family:Inter,ui-sans-serif,system-ui,Arial;margin:24px} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px} .card{border:1px solid #e5e7eb;border-radius:8px;padding:12px} h2{font-size:20px;margin:0 0 12px} pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f9fafb;border-radius:8px;padding:12px}</style>
    </head><body>
    <h1>Email Service Metrics</h1>
    <div class="grid">
      <div class="card"><h2>Provider Circuit</h2><pre>${escapeHtml(text.match(/^provider_circuit_state[\s\S]*?(?=\n\n|$)/m)?.[0]||'')}</pre></div>
      <div class="card"><h2>Send Totals</h2><pre>${escapeHtml(text.match(/^email_send_total[\s\S]*?(?=\n\n|$)/m)?.[0]||'')}</pre></div>
      <div class="card"><h2>Retry</h2><pre>${escapeHtml(text.match(/^email_retry_[\s\S]*?(?=\n\n|$)/m)?.[0]||'')}</pre></div>
      <div class="card"><h2>Admin</h2><pre>${escapeHtml(text.match(/^admin_[\s\S]*?(?=\n\n|$)/m)?.[0]||'')}</pre></div>
      <div class="card"><h2>Suppression</h2><pre>${escapeHtml(text.match(/^suppression_[\s\S]*?(?=\n\n|$)/m)?.[0]||'')}</pre></div>
    </div>
    </body></html>`;
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.send(html);
  } catch(e:any){ res.status(500).send('dashboard_error'); }
});

function escapeHtml(s: string){ return s.replace(/[&<>]/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c] as string)); }

// SES SNS webhook placeholder (expects raw JSON from SNS subscription filtered to bounce/complaint)
app.post('/webhook/ses', async (req,res)=>{
  try {
    const body = req.body || {};
  if(process.env.SNS_VALIDATE_SIGNATURE==='1' && process.env.NODE_ENV!=='test'){
      const valid = await validateSnsSignature(body);
      if(!valid){
        logger.warn({ msg:'sns_sig_invalid' });
        return res.status(400).json({ ok:false, error:'invalid_signature' });
      }
    }
  await maybeAutoConfirm(body);
    // Minimal: look for bounce/complaint notification structure
    if(body.notificationType === 'Bounce' && body.bounce?.bouncedRecipients){
      for(const r of body.bounce.bouncedRecipients){
        if(r?.emailAddress) addSuppression(r.emailAddress, 'bounce');
      }
    } else if(body.notificationType === 'Complaint' && body.complaint?.complainedRecipients){
      for(const r of body.complaint.complainedRecipients){
        if(r?.emailAddress) addSuppression(r.emailAddress, 'complaint');
      }
    }
  logger.info({ msg:'sns_webhook', type: body.notificationType });
  audit('sns_webhook', { type: body.notificationType });
    res.json({ ok:true });
  } catch(e:any){ logger.warn({ msg:'sns_webhook_error', err:e?.message }); res.status(400).json({ ok:false }); }
});

// Resend webhook (optional): validate via HMAC if RESEND_WEBHOOK_SECRET set
app.post('/webhook/resend', async (req,res)=>{
  try {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if(secret){
      const sig = req.header('x-resend-signature') || '';
      const h = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body||{})).digest('hex');
      if(sig !== h){ return res.status(401).json({ ok:false, error:'invalid_signature' }); }
    }
    const body = req.body || {};
    // Minimal: mark suppressions on permanent failures if structure provides an email
    const email = body?.data?.to || body?.to;
    const status = body?.type || body?.event;
    if(email && /failed|bounced|complaint/i.test(String(status))) addSuppression(email, 'resend_failure');
    audit('resend_webhook', { type: status||'unknown' });
    res.json({ ok:true });
  } catch(e:any){ logger.warn({ msg:'resend_webhook_error', err:e?.message }); res.status(400).json({ ok:false }); }
});

// Optional INTERNAL_API_KEY auth. Protect only admin/dashboard and email ping.
// Public endpoints remain accessible (e.g., /email/send, /email/send-template, /metrics, /webhook/*, /health).
app.use((req,res,next)=>{
  const internalKey = process.env.INTERNAL_API_KEY;
  if(!internalKey) return next();
  const path = req.path;
  // Always allow these without INTERNAL_API_KEY
  const open = (
    path === '/health' ||
    path === '/metrics' ||
    path.startsWith('/webhook/') ||
    (path.startsWith('/email/') && path !== '/email/ping')
  );
  if(open) return next();
  const provided = req.header('x-internal-key');
  const prev = process.env.INTERNAL_API_KEY_PREV;
  if(provided !== internalKey && (!prev || provided !== prev)){
    logger.warn({ msg:'auth_fail', path:req.path });
    return res.status(401).json({ error:'unauthorized' });
  }
  next();
});

// Require backend-runtime style auth for sending endpoints
function requireInternalAuth(req: express.Request, res: express.Response, next: express.NextFunction){
  const master = process.env.INTERNAL_API_KEY;
  if(master && req.header('x-internal-key') === master) return next();
  const auth = req.header('authorization');
  const token = auth?.startsWith('Bearer ')? auth.slice(7): undefined;
  if(master && token === master) return next();
  if(verifyInternalToken(token)) return next();
  try {
  (req as any).rid && logger.warn({ msg:'auth_fail', rid:(req as any).rid, path:req.path, hasAuth: !!auth, kind:'internal_only' });
  } catch {}
  return res.status(401).json({ error:'unauthorized' });
}

function resolveTenantFromRequest(req: express.Request): string {
  const headerCandidates = [process.env.TENANT_HEADER, 'x-tenant'].filter(Boolean) as string[];
  for (const header of headerCandidates) {
    const value = req.header(header);
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  const queryTenant = req.query?.tenant;
  if (typeof queryTenant === 'string' && queryTenant.trim().length > 0) {
    return queryTenant.trim();
  }
  return '';
}

app.post('/email/send', requireInternalAuth, async (req,res)=>{
  try {
    const sanitize = (s:string)=> s.replace(/[\0\x08\x09\x1a\n\r"'\\]/g, ' ');
    const schema = z.object({
      to: z.string().email(),
      kind: z.enum(['fee','custom']),
      studentName: z.string().min(1).max(200),
      amount: z.string().optional(),
      dueDate: z.string().optional(),
      messages: z.object({ en: z.string().optional(), hi: z.string().optional() }).default({}),
      order: z.enum(['english-first','hindi-first']).default('english-first'),
  showLabels: z.boolean().optional(),
  tenant: z.string().min(1).max(100).optional()
    });
    const parsed = schema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({ error:'invalid_body', details: parsed.error.flatten() });
    const body = parsed.data;
    // Light sanitization on user-entered fields
    if(body.messages.en) body.messages.en = sanitize(body.messages.en);
    if(body.messages.hi) body.messages.hi = sanitize(body.messages.hi);
    const idemKey = req.header('idempotency-key');
    const headerName = (process.env.QUOTA_KEY_HEADER || 'x-internal-key').toLowerCase();
    const apiKeyHeader = req.header(headerName);
  let apiKey = apiKeyHeader || 'anon';
  let tenant: string | undefined = (process.env.TENANT_HEADER ? req.header(process.env.TENANT_HEADER) : req.header('x-tenant')) || body.tenant;
    // Optional: extract claim from JWT when QUOTA_KEY_CLAIM is set
    const claim = process.env.QUOTA_KEY_CLAIM;
    if(!apiKeyHeader && claim){
      try {
        const auth = req.header('authorization');
        const token = auth?.startsWith('Bearer ')? auth.slice(7): undefined;
        if(token){
          let decoded: any;
          if(process.env.QUOTA_JWT_VERIFY === '1'){
            const alg = (process.env.QUOTA_JWT_ALG || 'RS256').toUpperCase();
            if(alg.startsWith('HS')){
              const secret = process.env.QUOTA_JWT_SECRET || '';
              decoded = jwt.verify(token, secret, { algorithms: [alg as any] });
            } else {
              let pub = process.env.QUOTA_JWT_PUBLIC_KEY || '';
              if(!pub && process.env.QUOTA_JWT_PUBLIC_KEY_B64) try { pub = Buffer.from(process.env.QUOTA_JWT_PUBLIC_KEY_B64, 'base64').toString('utf8'); } catch {}
              decoded = jwt.verify(token, pub, { algorithms: [alg as any] });
            }
          } else {
            decoded = jwt.decode(token);
          }
          if(decoded && decoded[claim]) apiKey = String(decoded[claim]);
      const tenantClaim = process.env.TENANT_CLAIM;
      if(!tenant && tenantClaim && decoded && decoded[tenantClaim]) tenant = String(decoded[tenantClaim]);
        }
      } catch {}
    }
    // Enforce tenant when required
    const tenantRequired = process.env.TENANT_REQUIRED === '1';
    const poolsConfigured = !!process.env.SENDER_POOLS_JSON;
    if((tenantRequired || poolsConfigured) && !tenant && !process.env.DEFAULT_TENANT){
      return res.status(400).json({ error:'missing_tenant' });
    }
    // Per-key daily cap (optional). Enforced only when EMAIL_PER_KEY_DAILY_CAP is set.
    const perKeyCap = Number(process.env.EMAIL_PER_KEY_DAILY_CAP || '0');
    if(perKeyCap>0){
  if(!apiKeyHeader && !claim) return res.status(401).json({ error:`missing_${headerName}` });
      if(hasRedis()){
        try {
          const r = await getRedis();
          if(r){
            const key = `daily:${apiKey}`;
            const count = await r.incr(key);
            if(count === 1){ await r.expire(key, secondsUntilEndOfDay(process.env.TZ || undefined)); }
            if(count > perKeyCap) return res.status(429).json({ error:'per_key_daily_cap_exceeded' });
          }
        } catch{}
      }
    }
    if(idemKey){
      const cached = getIdempotent(idemKey);
      if(cached){
        logger.info({ msg:'email_idempotent_replay', key: idemKey });
        res.setHeader('idempotent-replay', 'true');
        idempotentReplayTotal.inc();
        return res.status(cached.status).json(cached.body);
      } else {
        res.setHeader('idempotent-replay', 'false');
      }
    }
    const sendReq = {
      to: body.to,
      kind: body.kind,
      studentName: body.studentName,
      amount: body.amount,
      dueDate: body.dueDate,
      messages: body.messages||{},
      order: body.order || 'english-first',
  showLabels: body.showLabels !== false,
  tenant: tenant || process.env.DEFAULT_TENANT
    } as const;
    // Async mode: always enqueue and return 202
    if(process.env.ASYNC_SENDS === '1'){
      enqueue(sendReq);
      logSend({ ts: Date.now(), to: body.to, tenant: tenant || process.env.DEFAULT_TENANT, status: 'accepted' });
      return res.status(202).json({ accepted: true });
    }
    const r = await sendEmail(sendReq);
    const code = r.success ? 200 : (r.error==='rate_limited'? 429: 502);
  // Send log entry
  logSend({ ts: Date.now(), to: body.to, tenant: tenant || process.env.DEFAULT_TENANT, status: r.success? 'sent' : (r.error==='rate_limited'?'rate_limited':'failed'), provider: r.provider, id: r.id, error: r.success? undefined : r.error });
  if(r.success) logger.info({ msg:'email_sent', to: body.to, provider: r.provider, id: r.id, fallback:r.fallbackUsed });
    else {
      logger.warn({ msg:'email_failed', to: body.to, err: r.error, transient: r.transient });
  if(r.transient){ enqueue(sendReq); }
    }
  if(idemKey) setIdempotent(idemKey, code, r);
    return res.status(code).json(r);
  } catch(e:any){
  logger.error({ msg:'email_exception', err: e?.message, stack: e?.stack });
  return res.status(500).json({ error:'internal', detail: e?.message });
  }
});

// New: Send using HTML templates that mirror your EmailJS templates
app.post('/email/send-template', requireInternalAuth, async (req,res)=>{
  try {
    const sanitize = (s:string)=> s.replace(/[\0\x08\x09\x1a\n\r"'\\]/g, ' ');
    const schema = z.object({
      to_email: z.string().email(),
      to_name: z.string().min(1).max(200).optional(),
      teacher_name: z.string().optional(),
      teacher_email: z.string().email().optional(),
      coaching_name: z.string().optional(),
      tenant_name: z.string().optional(),
      tenant_id: z.string().optional(),
      from_name: z.string().optional(),
      reply_to: z.string().email().optional(),
      subject: z.string().optional(),
      requester_name: z.string().optional(),
      requester_email: z.string().email().optional(),
      request_id: z.string().optional(),
      request_message: z.string().optional(),
      admin_portal_url: z.string().url().optional(),
      summary_title: z.string().max(400).optional(),
      summary_body: z.string().max(4000).optional(),
      deep_link: z.string().max(500).optional(),
      action_url: z.string().url().optional(),
      alert_url: z.string().url().optional(),
      metric_label: z.string().max(200).optional(),
      threshold: z.string().max(80).optional(),
      current_value: z.string().max(120).optional(),
      usage_limit: z.string().max(120).optional(),
      usage_percentage: z.string().max(80).optional(),
      month_id: z.string().max(30).optional(),
      invite_role: z.string().optional(),
      invite_message: z.string().optional(),
      invite_link: z.string().url().optional(),
      expires_at: z.string().optional(),
      expires_at_human: z.string().optional(),

      // team membership change (optional details)
      action: z.string().max(120).optional(),
      target_email: z.string().email().optional(),
      display_name: z.string().max(200).optional(),
      previous_role: z.string().max(120).optional(),
      target_role: z.string().max(120).optional(),
      actor_name: z.string().max(200).optional(),
      actor_email: z.string().email().optional(),
      reason: z.string().max(400).optional(),
      initiated_from: z.string().max(120).optional(),
      student_name: z.string().optional(),
      amount: z.string().optional(),
      due_date: z.string().optional(),
      custom_notes: z.string().optional(),
      custom_message: z.string().optional(),
      custom_message_english: z.string().optional(),
      custom_message_hindi: z.string().optional(),
      selectedLanguage: z.enum(['english','hindi','both']).default('english'),
      languageOrder: z.enum(['english-first','hindi-first']).default('english-first'),
      show_teacher_name: z.boolean().optional(),
      show_coaching_name: z.boolean().optional(),
      template: z.enum([
        'custom_message_bilingual',
        'fee_reminder',
        'billing_event',
        'tenant_join_request',
        'tenant_invite',
        'team_membership_change',
        'usage_alert',
      ])
      ,
      quotaBatchId: z.string().min(1).max(120).optional(),
      historyId: z.string().min(1).max(240).optional(),
      history: z.record(z.any()).optional(),
    });
    const parsed = schema.safeParse(req.body||{});
    if(!parsed.success) return res.status(400).json({ error:'invalid_body', details: parsed.error.flatten() });
    const b = parsed.data;
    // Prepare flags for Mustache template
    const englishFirst = b.languageOrder === 'english-first';
    const showEnglishBlock = b.selectedLanguage === 'english' || b.selectedLanguage === 'both';
    const showHindiBlock = b.selectedLanguage === 'hindi' || b.selectedLanguage === 'both';
    const vars = {
      to_email: b.to_email,
      to_name: b.to_name || 'Parent/Guardian',
      from_name: b.from_name || b.coaching_name || 'Tuition Management',
      reply_to: b.reply_to || b.teacher_email,
  teacher_email: b.teacher_email,
      subject: b.subject,
      student_name: b.student_name,
      coaching_name: b.coaching_name,
      tenant_name: b.tenant_name || b.coaching_name,
      tenant_id: b.tenant_id,
      show_teacher_name: !!b.show_teacher_name,
      show_coaching_name: !!b.show_coaching_name,
      teacher_name: b.teacher_name,
      requester_name: b.requester_name,
      requester_email: b.requester_email,
      request_id: b.request_id,
      request_message: b.request_message,
      admin_portal_url: b.admin_portal_url,
      summary_title: b.summary_title,
      summary_body: b.summary_body,
      deep_link: b.deep_link,
      action_url: b.action_url,
      alert_url: (b as any).alert_url,
      metric_label: (b as any).metric_label,
      threshold: (b as any).threshold,
      current_value: (b as any).current_value,
      usage_limit: (b as any).usage_limit,
      usage_percentage: (b as any).usage_percentage,
      month_id: (b as any).month_id,
      invite_role: b.invite_role,
      invite_message: b.invite_message,
      invite_link: b.invite_link,
      expires_at: b.expires_at,
      expires_at_human: b.expires_at_human,

      action: (b as any).action,
      target_email: (b as any).target_email,
      display_name: (b as any).display_name,
      previous_role: (b as any).previous_role,
      target_role: (b as any).target_role,
      actor_name: (b as any).actor_name,
      actor_email: (b as any).actor_email,
      reason: (b as any).reason,
      initiated_from: (b as any).initiated_from,
      // bilingual
      english_first: englishFirst,
      show_english_block: showEnglishBlock,
      show_hindi_block: showHindiBlock,
      custom_message_english: (b.custom_message_english||'').trim(),
      custom_message_hindi: (b.custom_message_hindi||'').trim(),
      // fee fields
      amount: b.amount,
      due_date: b.due_date,
      custom_notes: b.custom_notes,
      custom_message: b.custom_message
    };
    const kind: TemplateKind = b.template;
  const { subject, html, text } = renderTemplate(kind, vars);
  try { audit('send_template_req', { to: b.to_email, template: kind, teacher_email: b.teacher_email, reply_to: b.reply_to || b.teacher_email, subject_preview: String(subject).slice(0,120) }); } catch {}

    // Tenant resolution and per-key limits identical to /email/send
    const idemKey = req.header('idempotency-key');
    const headerName = (process.env.QUOTA_KEY_HEADER || 'x-internal-key').toLowerCase();
    const apiKeyHeader = req.header(headerName);
    let apiKey = apiKeyHeader || 'anon';
    let tenant: string | undefined = (process.env.TENANT_HEADER ? req.header(process.env.TENANT_HEADER) : req.header('x-tenant')) || (req.body?.tenant);
    const claim = process.env.QUOTA_KEY_CLAIM;
    if(!apiKeyHeader && claim){
      try {
        const auth = req.header('authorization');
        const token = auth?.startsWith('Bearer ')? auth.slice(7): undefined;
        if(token){
          let decoded: any;
          if(process.env.QUOTA_JWT_VERIFY==='1'){
            const alg = process.env.QUOTA_JWT_ALG || 'HS256';
            if(alg.startsWith('HS')){
              decoded = (await import('jsonwebtoken')).default.verify(token, process.env.QUOTA_JWT_SECRET || '', { algorithms:[alg as any] });
            } else {
              const pub = process.env.QUOTA_JWT_PUBLIC_KEY || Buffer.from(process.env.QUOTA_JWT_PUBLIC_KEY_B64||'', 'base64').toString('utf8');
              decoded = (await import('jsonwebtoken')).default.verify(token, pub, { algorithms:[alg as any] });
            }
          } else {
            decoded = (await import('jsonwebtoken')).default.decode(token);
          }
          if(decoded && decoded[claim!]) apiKey = String(decoded[claim!]);
          if(!tenant && process.env.TENANT_CLAIM && decoded && decoded[process.env.TENANT_CLAIM]) tenant = String(decoded[process.env.TENANT_CLAIM]);
        }
      } catch {}
    }
    if(process.env.TENANT_REQUIRED==='1' && !(tenant || process.env.DEFAULT_TENANT)){
      return res.status(400).json({ error:'tenant_required' });
    }

    // Optional: enforce reminder quota + persist reminder history when quotaBatchId is provided (crash-safe).
    const tenantIdForReminders = (b.tenant_id || tenant) ? String(b.tenant_id || tenant) : '';

    const sendReq = {
      to: b.to_email,
      kind: kind === 'fee_reminder' ? 'fee' : 'custom',
      studentName: b.student_name || 'Student',
      amount: b.amount,
      dueDate: b.due_date,
      messages: {
        en: b.custom_message_english || (kind==='fee_reminder'? b.custom_message : undefined),
        hi: b.custom_message_hindi
      },
      order: englishFirst ? 'english-first' : 'hindi-first',
      showLabels: true,
      tenant: tenant || process.env.DEFAULT_TENANT,
  fromName: b.coaching_name || b.from_name,
  replyTo: b.reply_to || b.teacher_email,
      pre: { subject, html, text },
      __reminder: b.historyId
        ? {
            historyId: b.historyId,
            tenantId: tenantIdForReminders || undefined,
          }
        : undefined,
    } as const;
    if (b.quotaBatchId) {
      if (!tenantIdForReminders) {
        return res.status(400).json({ error: 'tenant_required_for_quota' });
      }
      try {
        await consumeEmailReminderReservationToken({
          tenantId: tenantIdForReminders,
          quotaBatchId: b.quotaBatchId,
          historyId: b.historyId,
          history: b.history,
        });
      } catch (e: any) {
        const code = e?.code || e?.message;
        if (code === 'reminder_quota_reservation_missing' || code === 'reminder_quota_reservation_expired') {
          return res.status(409).json({ error: code });
        }
        if (code === 'reminder_quota_reservation_exhausted') {
          return res.status(409).json({ error: code, channel: 'email' });
        }
        logger.warn({ msg: 'email_quota_consume_failed', err: e?.message || String(e) });
        return res.status(503).json({ error: 'reminder_quota_check_failed' });
      }
    }

    if(idemKey){
      const cached = getIdempotent(idemKey);
      if(cached){
        res.setHeader('idempotent-replay','true');
        return res.status(cached.status).json(cached.body);
      } else res.setHeader('idempotent-replay','false');
    }

    if(process.env.ASYNC_SENDS==='1'){
      enqueue(sendReq);
      return res.status(202).json({ accepted:true });
    }
    const r = await sendEmail(sendReq);
    const code = r.success?200:(r.error==='rate_limited'?429:502);

    if (b.historyId && tenantIdForReminders) {
      await notifyBackendRuntimeEmailResult({
        historyId: b.historyId,
        tenantId: tenantIdForReminders,
        status: r.success ? 'success' : 'failed',
        deliveryStatus: r.success ? 'sent' : 'failed',
        emailId: r.success ? r.id : undefined,
        provider: r.provider,
        errorMessage: r.success ? undefined : (r.error || 'send_failed'),
      });
    }

    if (b.historyId && tenantIdForReminders) {
      try {
        ensureFirebase();
        const db = getFirestore();
        await db
          .collection('reminderHistory')
          .doc(b.historyId)
          .set(
            sanitizeForFirestore({
              tenantId: tenantIdForReminders,
              reminderType: 'email',
              status: r.success ? 'success' : 'failed',
              metadata: { emailId: r.success ? r.id : undefined, deliveryStatus: r.success ? 'sent' : 'failed' },
              errorMessage: r.success ? undefined : (r as any)?.error || 'send_failed',
              updatedAt: FieldValue.serverTimestamp(),
            }),
            { merge: true }
          );
      } catch (e) {
        logger.warn({ msg: 'email_history_update_failed', err: (e as any)?.message || String(e) });
      }
    }

    if(idemKey) setIdempotent(idemKey, code, r);
    return res.status(code).json(r);
  } catch(e:any){
    return res.status(500).json({ error:'internal', detail: e?.message });
  }
});

// Canary dry-run endpoint: performs a provider call to a test mailbox if configured
app.get('/email/ping', async (_req,res)=>{
  try {
    const to = process.env.PING_EMAIL;
    if(!to) return res.status(400).json({ error:'missing_PING_EMAIL' });
    const r = await sendEmail({
      to,
      kind:'custom',
      studentName:'Canary',
      messages:{ en: 'Ping from email-backend' },
      order:'english-first',
      showLabels:false
    });
    res.status(r.success?200:502).json(r);
  } catch(e:any){ res.status(500).json({ error:'internal', detail:e?.message }); }
});

// Admin suppression list (requires INTERNAL_API_KEY auth middleware earlier)
// Simple in-memory rate limiter for admin routes (dynamic limit via env)
const adminRate: Record<string,{ tokens:number; ts:number }> = {};
function currentAdminLimit(){ return Number(process.env.ADMIN_RATE_PER_MIN || '120'); }
async function adminTokenOkAsync(ip:string){
  const now = Date.now();
  const limit = currentAdminLimit();
  const bucket = adminRate[ip] || { tokens: limit, ts: now };
  if(now - bucket.ts > 60_000){ bucket.tokens = limit; bucket.ts = now; }
  if(bucket.tokens <=0) { adminRate[ip]=bucket; return false; }
  bucket.tokens--; adminRate[ip]=bucket; return true; }
// Wrapper that also checks Redis if configured
async function adminAllowed(ip:string){
  const memOk = await adminTokenOkAsync(ip);
  if(!memOk) return false;
  const limit = currentAdminLimit();
  const redisOk = await adminRateCheck(ip, limit).catch(()=>true);
  return redisOk;
}
export function __resetAdminRate(){ for(const k of Object.keys(adminRate)) delete adminRate[k]; }

app.get('/admin/suppressions', async (req,res)=>{
  try {
  adminRequestsTotal.inc({ route:'suppressions_list' });
  if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'suppressions_list' }); return res.status(429).json({ error:'rate_limited' }); }
    const page = Math.max(1, Number(req.query.page)||1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize)||50));
    const all = allSuppressions();
    const start = (page-1)*pageSize;
    const items = all.slice(start, start+pageSize);
  logger.info({ msg:'admin_list_suppressions', page, pageSize, total: all.length });
  audit('admin_list_suppressions', { page, pageSize, total: all.length });
    res.json({ items, count: all.length, page, pageSize, pages: Math.ceil(all.length/pageSize) });
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});
app.delete('/admin/suppressions/:email', async (req,res)=>{
  try {
  adminRequestsTotal.inc({ route:'suppressions_delete' });
  if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'suppressions_delete' }); return res.status(429).json({ error:'rate_limited' }); }
    await purgeSuppression(req.params.email);
  logger.info({ msg:'admin_purge_suppression', email:req.params.email });
  audit('admin_purge_suppression', { email:req.params.email });
    res.json({ ok:true });
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});
// Add/override suppression manually with reason
app.post('/admin/suppressions', async (req,res)=>{
  try {
    adminRequestsTotal.inc({ route:'suppressions_add' });
    if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'suppressions_add' }); return res.status(429).json({ error:'rate_limited' }); }
    const email = String(req.body?.email||'').toLowerCase();
    const reason = String(req.body?.reason||'manual_block');
    if(!email || !/^[^@]+@[^@]+$/.test(email)) return res.status(400).json({ error:'invalid_email' });
    if(!['unsubscribed','manual_block','bounce','complaint'].includes(reason)) return res.status(400).json({ error:'invalid_reason' });
    addSuppression(email, reason);
    logger.info({ msg:'admin_add_suppression', email, reason });
    audit('admin_add_suppression', { email, reason });
    res.json({ ok:true });
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});
app.get('/admin/idempotent/:key', async (req,res)=>{
  try {
  adminRequestsTotal.inc({ route:'idempotent_view' });
  if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'idempotent_view' }); return res.status(429).json({ error:'rate_limited' }); }
    const v = await resolveIdempotent(req.params.key);
    if(!v) return res.status(404).json({ error:'not_found' });
  logger.info({ msg:'admin_view_idempotent', key: req.params.key });
  audit('admin_view_idempotent', { key: req.params.key });
    res.json({ key: req.params.key, status: v.status, ts: v.ts });
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});
app.post('/admin/idempotent/clear', async (req,res)=>{
  try {
  adminRequestsTotal.inc({ route:'idempotent_clear' });
  if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'idempotent_clear' }); return res.status(429).json({ error:'rate_limited' }); }
    clearIdempotentAll();
  logger.info({ msg:'admin_clear_idempotent' });
  audit('admin_clear_idempotent', {});
    res.json({ ok:true, size: idempotentSize() });
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});

// Admin export: suppressions CSV
app.get('/admin/suppressions.csv', async (req,res)=>{
  try {
    adminRequestsTotal.inc({ route:'suppressions_export_csv' });
    if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'suppressions_export_csv' }); return res.status(429).json({ error:'rate_limited' }); }
    const items = allSuppressions();
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename="suppressions.csv"');
    res.write('email,reason,ts,provider\n');
    for(const it of items){ res.write(`${it.email},${it.reason},${it.ts},${it.provider||''}\n`); }
    res.end();
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});

// Admin export: metrics snapshot (selected gauges/counters)
app.get('/admin/metrics.json', async (req,res)=>{
  try {
    adminRequestsTotal.inc({ route:'metrics_export_json' });
    if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'metrics_export_json' }); return res.status(429).json({ error:'rate_limited' }); }
    const text = await registry.metrics();
    res.json({ prometheus: text });
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});

// Admin export: send log NDJSON (stream)
app.get('/admin/sendlog.ndjson', async (req,res)=>{
  try {
    adminRequestsTotal.inc({ route:'sendlog_export' });
    if(!await adminAllowed(req.ip || '')) { adminRateLimitedTotal.inc({ route:'sendlog_export' }); return res.status(429).json({ error:'rate_limited' }); }
    const tenant = resolveTenantFromRequest(req);
    if(!tenant){
      logger.warn({ msg:'sendlog_tenant_missing', rid: (req as any)?.rid });
      return res.status(400).json({ error:'tenant_required' });
    }
    const file = process.env.SEND_LOG_FILE || './logs/sendlog.ndjson';
    const fsMod = await import('fs');
    try {
      await fsMod.promises.access(file, fsMod.constants.R_OK);
    } catch {
      return res.status(404).json({ error:'sendlog_missing' });
    }
    res.setHeader('Content-Type','application/x-ndjson');
    res.setHeader('Content-Disposition',`attachment; filename="sendlog-${tenant}.ndjson"`);
    const stream = fsMod.createReadStream(file, { encoding: 'utf8' });
    let buffer = '';
    let matches = 0;
    const flushLine = (line: string)=>{
      const trimmed = line.trim();
      if(!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if(parsed && typeof parsed.tenant === 'string' && parsed.tenant === tenant){
          res.write(trimmed + '\n');
          matches++;
        }
      } catch {}
    };
    const finalize = ()=>{
      if(buffer) flushLine(buffer);
      res.end();
      try {
        audit('admin_sendlog_export', { tenant, matches });
      } catch {}
      logger.info({ msg:'admin_sendlog_export', tenant, matches });
    };
    stream.on('data', (chunk: string | Buffer)=>{
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while(idx >= 0){
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx+1);
        flushLine(line);
        idx = buffer.indexOf('\n');
      }
    });
    stream.on('end', finalize);
    stream.on('error', err=>{
      logger.warn({ msg:'sendlog_stream_error', err: err?.message });
      if(!res.headersSent) res.status(500).json({ error:'sendlog_stream_failed' }); else res.end();
    });
    req.on('close', ()=>{
      if(res.writableEnded) return;
      stream.destroy();
    });
  } catch(e:any){ res.status(500).json({ error:'internal'}); }
});

if(process.env.NODE_ENV !== 'test'){
  const PORT = process.env.PORT || 8090;
  app.listen(PORT, ()=> logger.info({ msg:'listening', port: PORT }));
}
