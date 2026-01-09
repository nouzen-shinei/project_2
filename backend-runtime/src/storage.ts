import fs from 'fs';
import path from 'path';
const FILE = process.env.JOB_AUDIT_FILE || path.join(process.cwd(),'jobs-audit.json');
let saveTimer: NodeJS.Timeout|undefined;
let messageIdToJob: Record<string,string> = {};
let retentionMs = Number(process.env.JOB_RETENTION_MS || 7*24*60*60*1000);

export function loadPersisted(){
  try { if(fs.existsSync(FILE)) { const raw = JSON.parse(fs.readFileSync(FILE,'utf8')); messageIdToJob = raw.messageMap||{}; return raw.jobs||{}; } } catch(e){ console.warn('[storage] load failed', e); }
  return {}; }
export function persistSnapshot(jobs: any){ if(saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(()=>{ try { fs.writeFileSync(FILE, JSON.stringify({ jobs: prune(jobs), messageMap: messageIdToJob }, null, 2)); } catch(e){ console.warn('[storage] save failed', e); } }, 200); }
export function recordMessageMap(messageId:string, jobId:string){ messageIdToJob[messageId]=jobId; persistSnapshot({}); }
export function findJobByMessageId(messageId:string){ return messageIdToJob[messageId]; }
export function prune(jobs:any){ const now=Date.now(); const out: any={}; Object.values(jobs).forEach((j:any)=>{ if(['success','failed'].includes(j.status)){ if(now - (j.startedAt||j.enqueuedAt) <= retentionMs) out[j.id]=j; } else out[j.id]=j; }); return out; }

