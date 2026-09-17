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

/**
 * Add `delta` to a counter, for accumulators whose unit is not "one event" —
 * bytes, primarily. `inc` cannot express them: `storage_orphan_sweep_orphan_bytes`
 * incremented by one per orphan would count orphans, not bytes.
 *
 * A non-finite or non-positive `delta` is a no-op rather than a subtraction: these
 * are counters, and a counter that can go down is not one. That also means a
 * zero-valued accumulation creates no series, which is the same behaviour `inc`
 * has for an event that never happened.
 *
 * Deliberately NOT fed to the windowed sampler — a window holds event timestamps,
 * and "n bytes at time t" is not n events at time t. No byte accumulator is in
 * the windowed allowlist, and none should be added.
 */
export function incBy(name: string, delta: number, labels?: Record<string,string>) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  const key = buildKey(name, labels);
  counters[key] = (counters[key]||0)+delta;
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
  storageUploadFailed: 'storage_upload_failed_total',
  storageUploadIdempotentOverwrite: 'storage_upload_idempotent_overwrite_total',
  storageUploadOverwriteProbeFailed: 'storage_upload_overwrite_probe_failed_total',
  // upload-idempotency follow-up F9: a conditional write lost a same-uploadKey race
  // (Storage answered 412), so the sibling's object stands and this request released
  // its reservation instead of double-counting it. Labelled by `purpose` ONLY — the
  // uploadKey, its hash, the filename and the object path are unbounded-cardinality
  // label values and a leak surface (Req 6.4, 8.4).
  storageUploadConcurrentRaceLost: 'storage_upload_concurrent_race_lost_total',

  // ── storage-orphan-cleanup (spec task 10.3) ────────────────────────────────
  //
  // Labels are restricted to `tenant_id`, `mode`, `reason`, `outcome` and
  // `abort_reason` — never an object path, a filename, an email or a download
  // token, for the reason the `storageUploadConcurrentRaceLost` note above already
  // records: an unbounded label value is both a cost and a leak surface
  // (Req 16.7, 16.8).
  //
  // ── READ THIS BEFORE RELYING ON ONE OF THESE ──────────────────────────────
  //
  // Everything in this file is an IN-PROCESS counter, scraped over the app's
  // `/metrics` endpoint. The orphan sweep runs as a Cloud Run **job**, which is
  // never scraped and whose heap is gone when the task ends — so an increment made
  // by the sweep is real, correct and invisible to Cloud Monitoring.
  //
  // The names are registered here regardless, because they are the shared
  // vocabulary: a future in-process caller (`POST /storage/reconcile` is the
  // obvious one) increments the same names, and the log-based metrics the job's
  // alert policy actually reads are created with these exact names too. What makes
  // the job's numbers reach Cloud Monitoring is the structured log line
  // `storageOrphanSweep.ts` emits alongside each of these increments; see the
  // "Observability" block there and `infra/monitoring/README.md`.
  storageOrphanSweepRuns: 'storage_orphan_sweep_runs_total',
  storageOrphanSweepObjectsScanned: 'storage_orphan_sweep_objects_scanned_total',
  storageOrphanSweepRetained: 'storage_orphan_sweep_retained_total',
  storageOrphanSweepOrphans: 'storage_orphan_sweep_orphans_total',
  storageOrphanSweepOrphanBytes: 'storage_orphan_sweep_orphan_bytes',
  storageOrphanSweepQuarantined: 'storage_orphan_sweep_quarantined_total',
  storageOrphanSweepQuarantinedBytes: 'storage_orphan_sweep_quarantined_bytes',
  storageOrphanSweepQuarantineFailures: 'storage_orphan_sweep_quarantine_failures_total',
  // The one to alert on: an abort means the sweep STOPPED rather than proceeded on
  // partial knowledge, so nothing was deleted — and that the tool is not running.
  storageOrphanSweepAborted: 'storage_orphan_sweep_aborted_total',
  // Expected to stay flat at zero. Also alerted on.
  storageOrphanSweepCrossTenantReferences: 'storage_orphan_sweep_cross_tenant_references_total',
  storageOrphanSweepDanglingReferences: 'storage_orphan_sweep_dangling_references_total',

  // ── storage-sweep-scale-hardening (spec task 3.3) ──────────────────────────
  //
  // A Tenant_Sweep_Failure: a tenant whose sweep raised rather than reaching
  // `completed` or `aborted`, now confined to that tenant instead of ending the
  // run for every later one. Alerted on (Req 10.10), because a tenant that is
  // never swept is how orphan growth resumes for that tenant unnoticed — the
  // confinement makes one failure cheap, and this counter is what stops it also
  // making it invisible.
  //
  // Labelled `tenant_id` and `mode` only. The eleven names above and their labels
  // are untouched (Req 10.12) — in particular `storage_orphan_sweep_runs_total`
  // still carries `outcome: 'in_progress'` for a confined failure, and does NOT
  // follow the recorded status value to `'failed'`.
  storageOrphanSweepTenantFailures: 'storage_orphan_sweep_tenant_failures_total',

  // ── storage-sweep-scale-hardening (spec task 5.3) ──────────────────────────
  //
  // Firestore reference pages read, one line per Reference_Source per tenant per
  // invocation, at INFO. Not alerted on: it is the number that says a keyset walk
  // actually walked — a source with references and a page count of 1 over a
  // collection larger than the page size is a cursor that never advanced.
  //
  // Labelled `tenant_id`, `mode` and **`reason`**, where `reason` carries the
  // Reference_Source identifier. There is deliberately NO `source` label: Req 10.1
  // permits exactly `tenant_id`, `mode`, `reason`, `outcome` and `abort_reason`, and
  // `SweepMetricLabels` is a closed type precisely so an excess key cannot be
  // expressed. A bounded set of eight source ids is the correct use of the `reason`
  // slot; widening the closed set to carry a synonym is the change Req 10.1 exists
  // to prevent.
  storageOrphanSweepReferencePages: 'storage_orphan_sweep_reference_pages_total',

  // ── storage-sweep-scale-hardening (spec task 6.3) ──────────────────────────
  //
  // Report_Document writes issued for one tenant's run, one line per tenant per
  // invocation, at INFO (Req 10.6). Not alerted on: it is the number that says the
  // write batching is in force. A count near the tenant's page count means the
  // cadence collapsed — the usual cause being a Quarantine_Write_Threshold that
  // resolved to `0`, which forces a write at every evaluation rather than
  // suppressing one, so the report's `params.quarantineWriteThreshold` is the field
  // to read next.
  //
  // Labelled `tenant_id` and `mode` only, and emitted through the existing
  // `emitSweepMetric` one-shot pair, so the in-process counter and the log line move
  // exactly once together.
  storageOrphanSweepReportWrites: 'storage_orphan_sweep_report_writes_total',

  // ── storage-sweep-scale-hardening (spec task 9.1) ──────────────────────────
  //
  // Run_Lease acquisition and fencing outcomes. Labelled `mode` and **`outcome`**
  // only — `acquired` | `contended` | `lost` — and NO `tenant_id`: a lease is
  // run-level, so there is no tenant the line is about. `SweepMetricLabels` is a
  // closed type and `compactLabels` drops an absent key rather than writing an
  // empty one, so the line still matches the documented
  // `jsonPayload.metric` filter (Req 10.1, 10.5).
  //
  // `contended` is alerted on (Req 10.11), at WARNING: a run that is ALWAYS
  // declined is indistinguishable, from the Report_Documents alone, from a run
  // that is quietly succeeding — the same reasoning that puts an alert on
  // `aborted_total`.
  //
  // ── Where each outcome is emitted from, recorded so no fourth site appears ──
  //
  // NOT from `jobs/storageOrphanSweepLease.ts`. That module's documented property
  // is that it performs exactly one transaction on exactly one document and
  // touches no other path (Req 5.2, 6.8), and it has no business also owning an
  // observability concern — the same reasoning that keeps
  // `reference_pages_total` out of the Reference_Collector. So:
  //
  //   `acquired`, `contended` → `runStorageOrphanSweep.ts` (spec task 9.2)
  //   `lost`                  → `storageOrphanSweep.ts`'s tenant loop (task 9.3)
  //
  // All three go through the existing `emitSweepMetric` / `logSweepMetric` pair so
  // the single-line JSON shape the deployed `infra/monitoring/` filters match is
  // inherited rather than reimplemented (Req 10.3).
  storageOrphanSweepLease: 'storage_orphan_sweep_lease_total'
};
export { successCount, failedCount };
