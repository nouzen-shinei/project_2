# Monitoring: billing-stale-pending-job

Project: `tution-app-6c0c3`
Region: `asia-south1`

This folder contains reproducible Monitoring/Logging setup for the `billing-stale-pending-job` Cloud Run Job.

## Log-based metrics (already created)

These are created via `gcloud logging metrics create ...`:

- `billing_stale_pending_execution_failed`
  - Audit-log based signal that a Cloud Run Job execution failed.
- `billing_stale_pending_fatal_error`
  - Matches the job summary line where `fatalError` is non-null.
- `billing_stale_pending_scan_saturated`
  - Matches logs that indicate candidate scanning hit its limit.
- `billing_stale_pending_run_skipped_locked`
  - Matches logs when the run-level lease prevents overlapping executions.

Usage jobs (create these too):

- `usage_rollup_execution_failed`
  - Audit-log based signal that `usage-rollup-job` executions failed.
- `usage_rollup_heartbeat`
  - Matches a successful rollup run completing (`[usage_rollup_scheduler] job completed`).
- `usage_refresh_execution_failed`
  - Audit-log based signal that `usage-refresh-job` executions failed.
- `usage_refresh_heartbeat`
  - Matches a refresh run completing (`[usage_refresh_worker] batch complete` or `no pending usage refresh requests`).

Storage orphan sweep (create these — they do not exist yet):

The sweep runs as a Cloud Run **job**, which nothing scrapes, so its in-process
`src/metrics.ts` counters never reach Cloud Monitoring. What reaches Monitoring is the job's
**logs**: `storageOrphanSweep.ts` emits one single-line JSON entry per metric per tenant, and
these log-based metrics are what the alert policy actually reads. The emitted shape is fixed
and the filters below depend on it:

```json
{"severity":"WARNING","message":"[orphan_sweep] metric storage_orphan_sweep_aborted_total","metric":"storage_orphan_sweep_aborted_total","value":1,"tenant_id":"acme","mode":"report","abort_reason":"reference_source_failed"}
```

Cloud Run parses that into `jsonPayload`, so `jsonPayload.metric` selects the series,
`jsonPayload.value` carries this process's delta, and the remaining fields are the labels.

- `storage_orphan_sweep_aborted_total`
  - Filter: `resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_aborted_total"`
  - **The one to alert on.** An abort means the sweep stopped rather than proceeded on partial knowledge, so nothing was deleted — but it also means the tool is not running, and a cleanup tool that silently stops running is how orphan growth resumes unnoticed.
  - Emitted once per aborted tenant run, `value: 1`, with `abort_reason` on the entry, so the entry count and the summed value agree.
- `storage_orphan_sweep_cross_tenant_references_total`
  - Filter: `resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_cross_tenant_references_total"`
  - Emitted once per tenant run that saw at least one cross-tenant reference, with `value` carrying the unbounded total (the sample recorded on the report document is capped, deliberately, so a truncated sample cannot silence this). As a **counter** metric the series therefore counts *tenant runs that saw one*, not references; both are zero together, which is all a threshold-on-zero alert needs. Read the exact total from `jsonPayload.value` or from `crossTenantReferences` on the report document.
- The remaining nine (`storage_orphan_sweep_runs_total`, `…_objects_scanned_total`, `…_retained_total`, `…_orphans_total`, `…_orphan_bytes`, `…_quarantined_total`, `…_quarantined_bytes`, `…_quarantine_failures_total`, `…_dangling_references_total`) are emitted the same way and are worth creating for dashboards, but nothing alerts on them. Each is `jsonPayload.metric="<name>"` with the delta in `jsonPayload.value`; for these, a **distribution** metric with `valueExtractor: EXTRACT(jsonPayload.value)` is what makes the numbers add up, since a counter would only count the summary lines.
- `storage_orphan_sweep_runs_total` is the one metric emitted on **every** invocation, including one that resolves no tenants at all — an `all_active` query that has stopped matching produces an otherwise completely silent green run, and a cleanup tool that silently stops running is what these metrics exist to catch. On that run the single entry carries `outcome: "completed"` and **no `tenant_id` field**, because there is no tenant it is about:

  ```json
  {"severity":"INFO","message":"[orphan_sweep] metric storage_orphan_sweep_runs_total","metric":"storage_orphan_sweep_runs_total","value":1,"mode":"report","outcome":"completed"}
  ```

  The filter above is unaffected — `resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_runs_total"` selects on `jsonPayload.metric` alone and never mentions `tenant_id`, so the entry parses and matches like any other. Worth knowing if you build `runs_total` from a config file with a `tenant_id: EXTRACT(jsonPayload.tenant_id)` extractor, as the `aborted_total` example below does: that field is absent on this one entry, so the point will not carry a tenant id. Verify how your dashboard groups it before relying on a per-tenant breakdown of this particular metric — a "did the job run at all" panel should group by `mode`/`outcome`, not by `tenant_id`.
- Labels are restricted to `tenant_id`, `mode`, `reason`, `outcome` and `abort_reason`. No object path, no filename, no email, no download token — the sweep cannot express them: the emitter takes a closed label type.

Create the two alerted metrics (simple counter form — enough for the policy below to fire):

```bash
export PROJECT_ID=tution-app-6c0c3

gcloud logging metrics create storage_orphan_sweep_aborted_total \
  --project=$PROJECT_ID \
  --description="Storage orphan sweep aborted a tenant's run (nothing deleted; the tool is not running)" \
  --log-filter='resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_aborted_total"'

gcloud logging metrics create storage_orphan_sweep_cross_tenant_references_total \
  --project=$PROJECT_ID \
  --description="Storage orphan sweep resolved a reference outside the swept tenant's scope (expected: zero)" \
  --log-filter='resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_cross_tenant_references_total"'
```

To carry the labels through to Monitoring — worth it for `abort_reason`, which is what the
runbook below tells you to read — create the metric from a config file instead
(`gcloud logging metrics create` has no `--label-extractors` flag; the advanced form is
`--config-from-file`, taking a
[LogMetric](https://cloud.google.com/logging/docs/reference/v2/rest/v2/projects.metrics#LogMetric)
in YAML or JSON):

```yaml
# storage_orphan_sweep_aborted_total.yaml
name: storage_orphan_sweep_aborted_total
description: Storage orphan sweep aborted a tenant's run
filter: resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_aborted_total"
labelExtractors:
  tenant_id: EXTRACT(jsonPayload.tenant_id)
  mode: EXTRACT(jsonPayload.mode)
  abort_reason: EXTRACT(jsonPayload.abort_reason)
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: tenant_id
    - key: mode
    - key: abort_reason
```

```bash
gcloud logging metrics create storage_orphan_sweep_aborted_total \
  --project=$PROJECT_ID --config-from-file=storage_orphan_sweep_aborted_total.yaml
```

## Alert policies

Create/update the **critical** alert policy from JSON:

```bash
export PROJECT_ID=tution-app-6c0c3

gcloud alpha monitoring policies create \
  --project=$PROJECT_ID \
  --policy-from-file=infra/monitoring/billing-stale-pending-alert-policies.json
```

Create the **warning** policy (scan saturation):

```bash
export PROJECT_ID=tution-app-6c0c3

gcloud alpha monitoring policies create --project=$PROJECT_ID --policy-from-file=infra/monitoring/billing-stale-pending-alert-policy-warning.json
```

Create usage job alert policies:

```bash
export PROJECT_ID=tution-app-6c0c3

gcloud alpha monitoring policies create --project=$PROJECT_ID --policy-from-file=infra/monitoring/usage-rollup-alert-policy.json
gcloud alpha monitoring policies create --project=$PROJECT_ID --policy-from-file=infra/monitoring/usage-refresh-alert-policy.json
```

Create the storage orphan sweep alert policy:

```bash
export PROJECT_ID=tution-app-6c0c3

gcloud alpha monitoring policies create --project=$PROJECT_ID --policy-from-file=infra/monitoring/storage-orphan-sweep-alert-policy.json
```

Applying this policy is a **maintainer action** and is part of the orphan-sweep rollout, not of any
deploy script. Create the two log-based metrics listed above first — a policy whose metric does not
exist never fires, which on a condition that is expected to stay at zero is indistinguishable from
everything being fine.

List policies:

```bash
gcloud alpha monitoring policies list --project=$PROJECT_ID \
  --format='table(displayName,name)'
```

## Notes

- The critical policy JSON includes a project-specific email notification channel. If you recreate this in a different GCP project, update/remove `notificationChannels`.
- The `scan saturated` policy is a **warning** signal; it means you should increase scanning capacity or add pagination/cursors.
- For `usage-rollup-job` (once per day), Cloud Monitoring `conditionAbsent` duration is capped at 23h30m, so the repo policy alerts on failures only.
