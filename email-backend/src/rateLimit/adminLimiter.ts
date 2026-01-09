import { hasRedis, getRedis } from '../persistence/redisAdapter.js';

const WINDOW_SEC = 60;

export async function adminRateCheck(ip: string, limit: number): Promise<boolean> {
  if(process.env.NODE_ENV === 'test') return true;
  if(!hasRedis()) return true; // fallback to in-memory (handled elsewhere)
  const client = await getRedis();
  if(!client) return true;
  const key = `adminrate:${ip}`;
  const lua = `local c = redis.call('INCR', KEYS[1]); if tonumber(c) == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return c;`;
  // Use EVAL to increment + set expire atomically
  const count = Number(await client.eval(lua,{ keys:[key], arguments:[String(WINDOW_SEC)] }));
  return count <= limit;
}