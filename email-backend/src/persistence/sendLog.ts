import fs from 'fs';
import path from 'path';

export interface SendLogEntry {
  ts: number;
  to: string;
  tenant?: string;
  status: 'accepted' | 'sent' | 'failed' | 'suppressed' | 'rate_limited';
  provider?: string;
  id?: string;
  error?: string;
}

function getFile(){
  const p = process.env.SEND_LOG_FILE || path.resolve(process.cwd(), 'logs/sendlog.ndjson');
  const dir = path.dirname(p);
  if(!fs.existsSync(dir)){
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
  return p;
}

export function logSend(entry: SendLogEntry){
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFile(getFile(), line, ()=>{});
  } catch {}
}
