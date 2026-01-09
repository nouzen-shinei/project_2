import { createClient, RedisClientType } from 'redis';
import pino from 'pino';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

let client: RedisClientType | null = null;
let connecting: Promise<any> | null = null;

export function hasRedis(){ return !!process.env.REDIS_URL; }

export async function getRedis(): Promise<RedisClientType | null> {
  if(!process.env.REDIS_URL) return null;
  if(client) return client;
  if(!connecting){
    connecting = (async()=>{
      try {
        client = createClient({ url: process.env.REDIS_URL });
        client.on('error', err=> logger.warn({ msg:'redis_error', err: err.message }));
        await client.connect();
        logger.info({ msg:'redis_connected' });
        return client;
      } catch(e:any){ logger.error({ msg:'redis_connect_failed', err:e?.message }); client=null; }
    })();
  }
  await connecting;
  return client;
}

export async function redisSetJSON(key: string, value: any, ttlSeconds?: number){
  const c = await getRedis(); if(!c) return;
  const payload = JSON.stringify(value);
  if(ttlSeconds) await c.set(key, payload, { EX: ttlSeconds }); else await c.set(key, payload);
}
export async function redisGetJSON<T=any>(key: string): Promise<T | undefined>{
  const c = await getRedis(); if(!c) return undefined;
  const v = await c.get(key); if(!v) return undefined; try { return JSON.parse(v); } catch { return undefined; }
}
export async function redisDel(key: string){ const c = await getRedis(); if(!c) return; await c.del(key); }

