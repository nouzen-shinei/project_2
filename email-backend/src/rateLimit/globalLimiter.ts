import { getRedis, hasRedis } from '../persistence/redisAdapter.js';
import { secondsUntilEndOfDay } from '../util/dayKey.js';

export async function takeGlobalTokens(n=1){
  if(process.env.GLOBAL_LIMIT_REDIS !== '1' || !hasRedis()) return true;
  const perMin = Number(process.env.EMAIL_RATE_LIMIT_PER_MIN || '600');
  const key = 'glob:permin';
  try {
    const r = await getRedis(); if(!r) return true;
  const v = await r.incrBy(key, n);
    if(v === n){ await r.expire(key, 60); }
    if(v > perMin) return false;
  } catch { return true; }
  return true;
}

export async function takeGlobalDaily(n=1){
  if(process.env.GLOBAL_LIMIT_REDIS !== '1' || !hasRedis()) return true;
  const cap = Number(process.env.EMAIL_DAILY_CAP || '0');
  if(cap<=0) return true;
  const key = 'glob:perday';
  try {
    const r = await getRedis(); if(!r) return true;
  const v = await r.incrBy(key, n);
    if(v === n){ await r.expire(key, secondsUntilEndOfDay(process.env.TZ || undefined)); }
    if(v > cap) return false;
  } catch { return true; }
  return true;
}
