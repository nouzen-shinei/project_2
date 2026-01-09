import assert from 'assert';
import { inc, observeDuration, metricNames, metricsText } from '../dist/metrics.js';
// Simulate various durations to hit multiple buckets
[10,60,120,300,800,1500,3000,7000,12000].forEach(d=>observeDuration(d));
inc(metricNames.enqueued,{type:'fee'});
inc(metricNames.completed,{status:'success'});
const text = metricsText('wa_queue_depth 0\nwa_queue_in_flight 0');
assert.ok(text.includes('wa_job_duration_ms_bucket{le="50"}'), 'Histogram bucket present');
assert.ok(/wa_job_duration_ms_sum \d+/.test(text), 'Sum present');
console.log('metrics.test ok');