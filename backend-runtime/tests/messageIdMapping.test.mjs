import assert from 'assert';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
process.env.WABA_PHONE_NUMBER_ID = 'dummy';
process.env.WABA_TOKEN = 'dummy';
process.env.JOB_AUDIT_FILE = path.join(process.cwd(),'jobs-audit-test-message.json');
// Clean file
try { fs.unlinkSync(process.env.JOB_AUDIT_FILE); } catch{}

const require = createRequire(import.meta.url);
// Stub node-fetch BEFORE importing queue code
const fetchStub = async () => ({ ok: true, json: async ()=> ({ messages:[{ id:'wamid.TEST123'}] }) });
require.cache[require.resolve('node-fetch')] = { exports: fetchStub };

const qp = await import('../dist/queueProvider.js');
const storage = await import('../dist/storage.js');

const id = await qp.enqueueReminder({ to:'111', studentName:'S', amount:50, dueDate:new Date().toISOString() });
assert.ok(id, 'Job id required');
for(let i=0;i<40;i++){ const st = await qp.getJobStatus(id); if(st?.status==='success') break; await new Promise(r=>setTimeout(r,25)); }
const mapped = storage.findJobByMessageId('wamid.TEST123');
assert.strictEqual(mapped, id, 'MessageId should map to job id');
console.log('messageIdMapping.test ok', id);
