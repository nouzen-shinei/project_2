import fs from 'fs';
import path from 'path';
import pino from 'pino';
import crypto from 'crypto';
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const dir = process.env.PERSIST_DIR;

function ensureDir(){
  if(!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

const encKeyHex = process.env.PERSIST_ENCRYPT_KEY; // 64 hex chars for 32 bytes
let encKey: Buffer | null = null;
if(encKeyHex){
  try { encKey = Buffer.from(encKeyHex, 'hex'); if(encKey.length !== 32){ logger.warn({ msg:'persist_enc_key_invalid_length'}); encKey=null; } } catch { logger.warn({ msg:'persist_enc_key_parse_error'}); }
}

interface EncFile { v:1; iv:string; tag:string; data:string; }

function decryptIfNeeded(raw: Buffer): string {
  if(!encKey) return raw.toString('utf8');
  try {
    const obj: EncFile = JSON.parse(raw.toString('utf8'));
    if(obj.v!==1) throw new Error('version');
    const iv = Buffer.from(obj.iv,'base64');
    const tag = Buffer.from(obj.tag,'base64');
    const cipherText = Buffer.from(obj.data,'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey!, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return dec.toString('utf8');
  } catch(e:any){ logger.warn({ msg:'persist_decrypt_error', err:e?.message }); return raw.toString('utf8'); }
}

function encryptIfNeeded(plain: string): string {
  if(!encKey) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const enc = Buffer.concat([cipher.update(plain,'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out: EncFile = { v:1, iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
  return JSON.stringify(out);
}

export function loadJSON<T=any>(name: string): T | undefined {
  if(!dir) return undefined;
  try {
    const file = path.join(dir, name);
    if(!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file);
    const txt = decryptIfNeeded(raw);
    return JSON.parse(txt);
  } catch(e:any){ logger.warn({ msg:'persist_load_error', file:name, err:e?.message }); return undefined; }
}

export function saveJSON(name: string, data: any){
  if(!dir) return;
  try {
    ensureDir();
    const file = path.join(dir, name);
  const json = JSON.stringify(data, null, 2);
  const payload = encryptIfNeeded(json);
  fs.writeFileSync(file, payload);
  } catch(e:any){ logger.warn({ msg:'persist_save_error', file:name, err:e?.message }); }
}
