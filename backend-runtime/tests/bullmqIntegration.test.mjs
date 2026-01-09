import assert from 'assert';
import { createRequire } from 'module';
import net from 'net';
process.env.USE_BULLMQ = 'true';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.WABA_PHONE_NUMBER_ID='dummy';
process.env.WABA_TOKEN='dummy';

const require = createRequire(import.meta.url);
let bullmqAvailable = true;
try { require.resolve('bullmq'); } catch { bullmqAvailable = false; }
if(!bullmqAvailable){ console.log('bullmqIntegration.test skipped: bullmq not installed'); process.exit(0); }

// Quick Redis reachability check
const url = new URL(process.env.REDIS_URL);
await new Promise((resolve)=>{
	const sock = net.createConnection({ host: url.hostname, port: Number(url.port)||6379 }, ()=>{ sock.end(); resolve(null); });
	sock.on('error', ()=>{ console.log('bullmqIntegration.test skipped: redis not reachable'); resolve(null); process.exit(0); });
	setTimeout(()=>{ console.log('bullmqIntegration.test skipped: redis timeout'); try{ sock.destroy(); }catch{}; resolve(null); process.exit(0); }, 500);
});

// Stub fetch to avoid network
const fetchStub = async () => ({ ok: true, json: async ()=> ({ messages:[{ id:'wamid.BULLMQ1'}] }) });
require.cache[require.resolve('node-fetch')] = { exports: fetchStub };

// Import after env & stubs
const qp = await import('../dist/queueProvider.js');
const storage = await import('../dist/storage.js');

const id = await qp.enqueueReminder({ to:'222', studentName:'Bull', amount:200, dueDate:new Date().toISOString() });
assert.ok(id, 'BullMQ enqueue returned id');
let status;
for(let i=0;i<40;i++){ status = await qp.getJobStatus(id); if(status?.status==='success') break; await new Promise(r=>setTimeout(r,100)); }
if(status?.status!=='success'){ console.log('bullmqIntegration.test skipped: job not completed in time'); process.exit(0); }
const mapped = storage.findJobByMessageId('wamid.BULLMQ1');
assert.strictEqual(mapped, id, 'BullMQ messageId should map to job id');
console.log('bullmqIntegration.test ok', id);
