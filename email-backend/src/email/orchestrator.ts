import { renderEmail } from './render.js';
import { RenderInput, ProviderResult, EmailProvider } from './types.js';
import { sesProvider } from './providers/sesProvider.js';
import { resendProvider } from './providers/resendProvider.js';
import { isSuppressed, addSuppression } from './suppressionStore.js';
import { emailSendTotal, emailSuppressedTotal, emailLatency, providerCircuitState } from './metrics.js';
import jwt from 'jsonwebtoken';
import { dayKeyForTimezone } from '../util/dayKey.js';
import { takeGlobalDaily, takeGlobalTokens } from '../rateLimit/globalLimiter.js';
import crypto from 'crypto';

function getPrimary(){ return process.env.EMAIL_PROVIDER_PRIMARY || 'ses'; }
function getFallback(){ return process.env.EMAIL_PROVIDER_FALLBACK || 'resend'; }

let providers: Record<string, EmailProvider> = {
  ses: sesProvider,
  resend: resendProvider
};
// test hook
export function __setProviders(p: Record<string, EmailProvider>){ providers = p; }
export function __resetBreakers(){ for(const k of Object.keys(breakers)) delete breakers[k]; }

// Simple circuit breaker per provider
interface Breaker { fails: number; openedAt: number | null; open: boolean; }
function breakerConfig(){
  return {
    failThreshold: Number(process.env.PROVIDER_CB_FAILS || 5),
    halfOpenAfterMs: Number(process.env.PROVIDER_CB_HALF_OPEN_MS || 30_000)
  };
}
const breakers: Record<string, Breaker> = {};
function bState(name:string){ if(!breakers[name]) breakers[name] = { fails:0, openedAt:null, open:false }; return breakers[name]; }
function circuitAllowed(name:string){ const cfg=breakerConfig(); const b=bState(name); if(!b.open) return true; if(b.openedAt && Date.now()-b.openedAt>cfg.halfOpenAfterMs){ // half-open trial permitted
  return true; }
  return false; }
function recordSuccess(name:string){ const b=bState(name); if(b.open){ b.open=false; b.openedAt=null; providerCircuitState.set({ provider:name },0); } b.fails=0; }
function recordFailure(name:string){ const cfg=breakerConfig(); const b=bState(name); b.fails++; if(!b.open && b.fails>=cfg.failThreshold){ b.open=true; b.openedAt=Date.now(); providerCircuitState.set({ provider:name },1); } }

function safeParseJSON<T=any>(s?: string): T | undefined { try { return s ? JSON.parse(s) as T : undefined; } catch { return undefined; } }

// Warm-up ramp and daily cap aware token bucket
function warmUpMaxPerMin(now = new Date()): number {
  // Ramps: 300, 600, 1200, 2400, 5000+ (min with configured)
  const base = [300, 600, 1200, 2400, 5000];
  const started = process.env.WARMUP_START_TS ? Number(process.env.WARMUP_START_TS) : 0;
  const days = started ? Math.floor((Date.now() - started) / (24*60*60*1000)) : 999;
  const idx = Math.min(days, base.length-1);
  const conf = Number(process.env.EMAIL_RATE_LIMIT_PER_MIN || '600');
  return Math.min(conf, base[idx]);
}
const DAILY_CAP = Number(process.env.EMAIL_DAILY_CAP || '0');
let dailyCount = 0; let dayKey = dayKeyForTimezone(new Date(), process.env.TZ || undefined);
let tokens = warmUpMaxPerMin();
setInterval(()=>{ tokens = warmUpMaxPerMin(); }, 60_000).unref();
function resetDailyIfNeeded(){
  const nowKey = dayKeyForTimezone(new Date(), process.env.TZ || undefined);
  if(nowKey!==dayKey){ dayKey=nowKey; dailyCount=0; }
}
function takeToken(){
  resetDailyIfNeeded();
  if(DAILY_CAP>0 && dailyCount>=DAILY_CAP) return false;
  if(tokens>0){ tokens--; dailyCount++; return true; }
  return false;
}

export interface SendRequest extends RenderInput { to: string; tenant?: string; replyTo?: string; fromName?: string; pre?: { subject: string; html: string; text: string } }
export interface SendResponse { success: boolean; provider?: string; id?: string; fallbackUsed?: boolean; error?: string; transient?: boolean; }

export async function sendEmail(req: SendRequest): Promise<SendResponse> {
  // Optionally enforce Redis-backed global limits for multi-instance
  const okPerMin = await takeGlobalTokens(1);
  const okPerDay = await takeGlobalDaily(1);
  if(!(okPerMin && okPerDay)) return { success:false, error:'rate_limited' };
  if(!takeToken()) return { success:false, error:'rate_limited' };
  if(isSuppressed(req.to)){
    emailSuppressedTotal.inc();
    return { success:false, error:'suppressed' };
  }
  const render = req.pre || renderEmail(req);
  // Generate a unique entity id for threading isolation and diagnostics
  const entityId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  // Tenant: use explicit req.tenant first, then DEFAULT_TENANT
  const tenant = req.tenant || process.env.DEFAULT_TENANT || undefined;
  const senderMap = process.env.SENDER_POOLS_JSON ? safeParseJSON<Record<string,{ email:string; name?:string }>>(process.env.SENDER_POOLS_JSON) : undefined;
  const sender = tenant && senderMap && senderMap[tenant] ? senderMap[tenant] : undefined;
  const payload = {
    to: req.to,
    subject: render.subject,
    html: render.html,
    text: render.text,
    metadata: { templateVersion: 'v1.0.0', kind: req.kind, entityId },
    headers: {
      'X-Entity-Ref': entityId,
      // Unique Message-Id strengthens de-threading; domain aligns with sender domain if present
      'Message-Id': `<${entityId}@${(sender?.email?.split('@')[1]) || (process.env.RESEND_DOMAIN) || 'mailer.local'}>`,
      // Precedence: bulk prevents auto-threading with personal emails sometimes
      'Precedence': 'bulk'
    },
    fromEmail: sender?.email,
  fromName: req.fromName || sender?.name,
    replyTo: req.replyTo
  } as any;
  const primaryName = getPrimary();
  const fallbackName = getFallback();
  let chain = [providers[primaryName], providers[fallbackName]].filter(Boolean);
  if(chain.length === 0){
    const vals = Object.values(providers);
    chain = vals.slice(0,2);
  }
  let firstError: ProviderResult | undefined;
  for(let i=0;i<chain.length;i++){
    const prov = chain[i];
    if(!prov) continue;
    if(!circuitAllowed(prov.name)) continue; // skip open circuit
    const start = Date.now();
    const res = await prov.send(payload);
    if(res.success){
      emailSendTotal.inc({ provider: prov.name, result:'success', fallback: String(i>0) });
      emailLatency.observe({ provider: prov.name }, Date.now()-start);
      recordSuccess(prov.name);
      return { success:true, provider: prov.name, id: res.id, fallbackUsed: i>0 };
    }
    emailSendTotal.inc({ provider: prov.name, result: res.transient?'transient_fail':'permanent_fail', fallback: String(i>0) });
    recordFailure(prov.name);
    if(!firstError) firstError = res;
    if(!res.transient) break; // don't continue if permanent failure
  }
  if(firstError && firstError.errorMessage && /Bounce|Complaint|Suppressed|blacklist/i.test(firstError.errorMessage)){
    addSuppression(req.to, firstError.errorMessage, firstError.errorType);
  }
  return { success:false, error: firstError?.errorMessage || 'unknown_failure', transient: firstError?.transient };
}
