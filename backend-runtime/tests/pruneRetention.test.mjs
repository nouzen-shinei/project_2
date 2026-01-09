import assert from 'assert';
import path from 'path';
import fs from 'fs';
process.env.JOB_AUDIT_FILE = path.join(process.cwd(),'jobs-audit-test-prune.json');
process.env.JOB_RETENTION_MS = '1000';
// Seed file with old + fresh jobs
const oldId='oldjob'; const freshId='freshjob';
const now = Date.now();
const seedJobs = { [oldId]: { id: oldId, status:'success', startedAt: now-5000, enqueuedAt: now-5000 }, [freshId]: { id: freshId, status:'success', startedAt: now-100, enqueuedAt: now-100 } };
fs.writeFileSync(process.env.JOB_AUDIT_FILE, JSON.stringify({ jobs: seedJobs, messageMap:{} }, null,2));
// Import storage functions
const storage = await import('../dist/storage.js');
// Persist snapshot to trigger prune
storage.persistSnapshot(seedJobs);
await new Promise(r=>setTimeout(r,400));
const reloaded = JSON.parse(fs.readFileSync(process.env.JOB_AUDIT_FILE,'utf8'));
assert.ok(!reloaded.jobs[oldId], 'Old job should be pruned');
assert.ok(reloaded.jobs[freshId], 'Fresh job should remain');
console.log('pruneRetention.test ok');
