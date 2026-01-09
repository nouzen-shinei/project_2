import fs from 'fs';
import path from 'path';
import pino from 'pino';

const baseLogger = pino({ level: process.env.LOG_LEVEL || 'info' });
const filePath = process.env.AUDIT_LOG_FILE;
let stream: fs.WriteStream | null = null;
if(filePath){
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir,{ recursive:true });
    stream = fs.createWriteStream(filePath, { flags:'a' });
  } catch(e:any){ baseLogger.warn({ msg:'audit_log_file_open_error', err:e?.message }); }
}

function maskEmail(val: string){
  const [user, domain] = val.split('@');
  if(!domain) return val;
  const maskedUser = user.length ? user[0] + '***' : '***';
  const dParts = domain.split('.');
  const tld = dParts.pop();
  const dRoot = dParts.join('.');
  const maskedDomain = (dRoot ? dRoot[0] + '***' : '***') + (tld?'.'+tld:'');
  return maskedUser + '@' + maskedDomain;
}

const SENSITIVE_FIELDS = new Set(['email','to','studentName','key']);
function sanitize(obj: Record<string,any>){
  const out: Record<string,any> = {};
  for(const [k,v] of Object.entries(obj)){
    if(typeof v === 'string'){
      if(/body|html|text|content/i.test(k) && process.env.AUDIT_REDACT_BODIES==='1'){
        out[k] = '[REDACTED]';
        continue;
      }
      if(SENSITIVE_FIELDS.has(k)){
        if(v.includes('@')) out[k] = maskEmail(v); else out[k] = v.slice(0,8)+'…';
      } else if(v.includes('@')){
        out[k] = maskEmail(v);
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function audit(event: string, payload: Record<string, any> = {}){
  const record = { ts: Date.now(), event, ...sanitize(payload) };
  if(stream){
    try { stream.write(JSON.stringify(record)+'\n'); } catch(e:any){ baseLogger.warn({ msg:'audit_log_write_error', err:e?.message }); }
  } else {
    baseLogger.info({ audit:true, event, ...payload });
  }
}

export function closeAudit(){ if(stream){ try { stream.end(); } catch{} } }