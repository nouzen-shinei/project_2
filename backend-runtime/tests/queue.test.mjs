import assert from 'assert';
import { enqueueReminder, getJobStatus } from '../dist/queueProvider.js';

// Basic runtime test (build must be run first)
const id = await enqueueReminder({ to:'123', studentName:'Stu', amount:100, dueDate:new Date().toISOString() });
assert.ok(id, 'Job id should be returned');
// poll for completion
for(let i=0;i<20;i++){ const st = await getJobStatus(id); if(st?.status==='success') break; await new Promise(r=>setTimeout(r,50)); }
const st = await getJobStatus(id);
assert.ok(st && ['success','failed','processing','queued'].includes(st.status), 'Status should be valid');
console.log('queue.test ok', id, st.status);
