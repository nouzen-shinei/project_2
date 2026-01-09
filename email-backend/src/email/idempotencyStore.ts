// In-memory idempotency store: maps key -> result
// Replace with persistent storage (Redis/DB) in production.
interface StoredResult { status: number; body: any; ts: number; }
import { idempotentStoreSize } from './metrics.js';
import { loadJSON, saveJSON } from '../persistence/filePersistence.js';
import { hasRedis, redisGetJSON, redisSetJSON } from '../persistence/redisAdapter.js';

const store = new Map<string, StoredResult>();
const TTL_MS = 1000 * 60 * 30; // 30 minutes

// Load persisted idempotent cache (best-effort)
const seed = loadJSON<[string, StoredResult][]>('idempotency.json');
if(seed){
  const now = Date.now();
  for(const [k,v] of seed){ if(now - v.ts < TTL_MS) store.set(k,v); }
  idempotentStoreSize.set(store.size);
}
// Optionally hydrate from Redis keys list (simple approach: rely on on-demand fetch if not in memory)
export async function resolveIdempotent(key: string){
  const local = getIdempotent(key);
  if(local) return local;
  if(hasRedis()){
    try {
      const v = await redisGetJSON<StoredResult>(`idem:${key}`);
      if(v && Date.now()-v.ts < TTL_MS){ store.set(key,v); idempotentStoreSize.set(store.size); return v; }
    } catch {}
  }
  return undefined;
}

export function getIdempotent(key: string){
  const v = store.get(key);
  if(!v) return undefined;
  if(Date.now() - v.ts > TTL_MS){ store.delete(key); return undefined; }
  return v;
}

export function setIdempotent(key: string, status: number, body: any){
  store.set(key, { status, body, ts: Date.now() });
  idempotentStoreSize.set(store.size);
  // Fire-and-forget redis write with TTL
  if(hasRedis()) redisSetJSON(`idem:${key}`, { status, body, ts: Date.now() }, Math.floor(TTL_MS/1000)).catch(()=>{});
}

export function cleanupIdempotency(){
  const now = Date.now();
  for(const [k,v] of store.entries()){
    if(now - v.ts > TTL_MS) store.delete(k);
  }
  idempotentStoreSize.set(store.size);
}
setInterval(cleanupIdempotency, 10*60*1000).unref();

// Periodic flush of idempotent cache
setInterval(()=>{
  try { saveJSON('idempotency.json', Array.from(store.entries())); } catch {}
}, 30_000).unref();

export function clearIdempotentAll(){
  store.clear();
  idempotentStoreSize.set(store.size);
  try { saveJSON('idempotency.json', Array.from(store.entries())); } catch {}
}
export function idempotentSize(){ return store.size; }
