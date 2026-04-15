// Simple in-memory metrics counters
interface Counter { [k: string]: number }
const counters: Counter = {};
const windowedEvents: Record<string, number[]> = {};
const durations: { sum: number; count: number; max: number } = { sum: 0, count: 0, max: 0 };
let successCount = 0; let failedCount = 0;
const bucketsDef = [50,100,250,500,1000,2000,5000,10000];
const bucketCounts: Record<number, number> = Object.fromEntries(bucketsDef.map(b=>[b,0]));

const DEFAULT_WINDOWED_METRICS = new Set([
  'billing_webhook_signature_failures_total',
  'billing_webhook_invalid_json_total',
  'billing_webhook_handler_failures_total',
  'billing_webhook_accepted_total',
  'billing_webhook_idempotency_hits_total',
  'billing_webhook_unknown_events_total',
  'billing_invoice_write_failures_total',
  'billing_state_write_failures_total',
  'wa_http_requests_total',
  'wa_http_responses_error_total',
  'wa_http_responses_4xx_total',
  'wa_http_responses_5xx_total',
  'wa_http_auth_unauthorized_total',
  'wa_http_rate_limited_total',
  'wa_http_maintenance_blocked_total',
]);

function getWindowedAllowlist(): Set<string> {
  const raw = (process.env.METRICS_WINDOWED_NAMES || '').trim();
  if (!raw) return DEFAULT_WINDOWED_METRICS;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

const windowedAllowlist = getWindowedAllowlist();

function buildKey(name: string, labels?: Record<string, string>) {
  return labels ? `${name}{${Object.entries(labels).map(([k,v])=>`${k}=${v}`).join(',')}}` : name;
}

function recordWindowEvent(key: string) {
  const now = Date.now();
  const list = windowedEvents[key] || (windowedEvents[key] = []);
  list.push(now);

  // Opportunistic pruning to keep memory bounded.
  const maxAgeMs = 24 * 60 * 60 * 1000; // keep at most 24h of samples
  const cutoff = now - maxAgeMs;
  let drop = 0;
  while (drop < list.length && list[drop] < cutoff) drop++;
  if (drop > 0) list.splice(0, drop);

  const hardCap = 100_000;
  if (list.length > hardCap) {
    list.splice(0, list.length - hardCap);
  }
}

export function inc(name: string, labels?: Record<string,string>) {
  const key = buildKey(name, labels);
  counters[key] = (counters[key]||0)+1;

  if (windowedAllowlist.has(name)) {
    recordWindowEvent(key);
  }
}

export function getWindowCount(name: string, windowMs: number, labels?: Record<string, string>) {
  const key = buildKey(name, labels);
  const list = windowedEvents[key] || [];
  if (!list.length) return 0;
  const now = Date.now();
  const cutoff = now - Math.max(0, Math.trunc(windowMs));
  // list is sorted ascending by construction.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < cutoff) lo = mid + 1;
    else hi = mid;
  }
  return list.length - lo;
}
export function observeDuration(ms: number){ durations.sum += ms; durations.count += 1; if(ms>durations.max) durations.max=ms; for(const b of bucketsDef){ if(ms <= b){ bucketCounts[b]++; break; } } }
export function recordJobResult(ok:boolean){ if(ok) successCount++; else failedCount++; }
export function getFailureRate(){ const total = successCount+failedCount; return total ? failedCount/total : 0; }
export function metricsText(extra: string){
  let lines = ['# HELP wa_queue_basic Basic queue metrics', '# TYPE wa_queue_depth gauge'];
  // queue metrics appended externally via extra
  lines.push(extra.trim());
  lines.push('# TYPE wa_counter_total counter');
  for (const [k,v] of Object.entries(counters)) lines.push(`${sanitize(k)} ${v}`);
  if(durations.count>0){
    lines.push(`# TYPE wa_job_duration_ms histogram`);
    let cumulative=0;
    for(const b of bucketsDef){ cumulative += bucketCounts[b]; lines.push(`wa_job_duration_ms_bucket{le="${b}"} ${cumulative}`); }
    lines.push(`wa_job_duration_ms_bucket{le="+Inf"} ${durations.count}`);
    lines.push(`wa_job_duration_ms_sum ${durations.sum}`);
    lines.push(`wa_job_duration_ms_count ${durations.count}`);
    lines.push(`wa_job_duration_ms_max ${durations.max}`);
  }
  return lines.filter(Boolean).join('\n')+'\n';
}
function sanitize(s:string){ return s.replace(/[^a-zA-Z0-9_{}=,]/g,'_'); }

export const metricNames = {
  enqueued: 'wa_jobs_enqueued_total',
  completed: 'wa_jobs_completed_total',
  messageStatus: 'wa_message_status_total',
  cspViolation: 'wa_csp_violation_total',
  cspViolationPersistFailure: 'wa_csp_violation_persist_failure_total',
  cspViolationPruned: 'wa_csp_violation_pruned_total',
  httpRequestsTotal: 'wa_http_requests_total',
  httpResponsesTotal: 'wa_http_responses_total',
  httpResponsesErrorTotal: 'wa_http_responses_error_total',
  httpResponses4xxTotal: 'wa_http_responses_4xx_total',
  httpResponses5xxTotal: 'wa_http_responses_5xx_total',
  httpAuthUnauthorizedTotal: 'wa_http_auth_unauthorized_total',
  httpRateLimitedTotal: 'wa_http_rate_limited_total',
  httpMaintenanceBlockedTotal: 'wa_http_maintenance_blocked_total',
  storageUploadPreflightRequests: 'storage_upload_preflight_requests_total',
  storageUploadPreflightAllowed: 'storage_upload_preflight_allowed_total',
  storageUploadPreflightBlocked: 'storage_upload_preflight_blocked_total',
  storageUploadPreflightQuotaCheckFailed: 'storage_upload_preflight_quota_check_failed_total',
  storageUploadRejected: 'storage_upload_rejected_total',
  storageUploadQuotaCheckFailed: 'storage_upload_quota_check_failed_total',
  storageUploadAccepted: 'storage_upload_accepted_total',
  storageUploadFailed: 'storage_upload_failed_total'
};
export { successCount, failedCount };
