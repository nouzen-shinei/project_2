// Simple in-memory suppression + events (replace with persistent storage later)
export interface SuppressionEntry { reason: string; ts: number; provider?: string; }
import { suppressionStoreSize, suppressionAddedTotal } from './metrics.js';
import { loadJSON, saveJSON } from '../persistence/filePersistence.js';
import { hasRedis, redisGetJSON, redisSetJSON, redisDel } from '../persistence/redisAdapter.js';

const suppressed = new Map<string, SuppressionEntry>();

// Load persisted data if available
const seed = loadJSON<[string, SuppressionEntry][]>('suppressions.json');
if(seed){
  for(const [email, entry] of seed){ suppressed.set(email, entry); }
  suppressionStoreSize.set(suppressed.size);
}

export function isSuppressed(email: string){ return suppressed.has(email.toLowerCase()); }
export function getSuppression(email: string){ return suppressed.get(email.toLowerCase()); }
export function addSuppression(email: string, reason: string, provider?: string){
  suppressed.set(email.toLowerCase(), { reason, ts: Date.now(), provider });
  suppressionStoreSize.set(suppressed.size);
  suppressionAddedTotal.inc({ reason });
  if(hasRedis()) redisSetJSON(`suppress:${email.toLowerCase()}`, { reason, ts: Date.now(), provider }).catch(()=>{});
}
export function allSuppressions(){ return Array.from(suppressed.entries()).map(([email,entry])=>({ email, ...entry })); }
export function suppressionSize(){ return suppressed.size; }
export async function purgeSuppression(email: string){
  const key = email.toLowerCase();
  suppressed.delete(key);
  suppressionStoreSize.set(suppressed.size);
  if(hasRedis()) redisDel(`suppress:${key}`).catch(()=>{});
}

// Periodic flush
setInterval(()=>{
  try { saveJSON('suppressions.json', Array.from(suppressed.entries())); } catch {}
}, 30_000).unref();

// Lazy hydrate from Redis on miss
export async function fetchSuppression(email: string){
  const key = email.toLowerCase();
  if(suppressed.has(key)) return suppressed.get(key);
  if(hasRedis()){
    try {
      const v = await redisGetJSON<SuppressionEntry>(`suppress:${key}`);
      if(v){ suppressed.set(key,v); suppressionStoreSize.set(suppressed.size); return v; }
    } catch {}
  }
  return undefined;
}
