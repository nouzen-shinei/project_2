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
- `storage_orphan_sweep_tenant_failures_total`
  - Filter: `resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_tenant_failures_total"`
  - **Alerted on.** A Tenant_Sweep_Failure means the run was asked to sweep a tenant and could not — the reference collector raised, or a listing page failed. The failure is *confined*: every other tenant is still swept and nothing was deleted for the failing one, so this is not an outage. It is the one shape in which the estate quietly stops being cleaned for a single tenant while every run looks healthy everywhere else, and a tenant that is never swept is how orphan growth resumes for that tenant unnoticed.
  - Emitted once per failed tenant per invocation, `value: 1`, with `tenant_id` and `mode` on the entry. The run also exits non-zero, so the Cloud Run execution is visibly failed as well.
- `storage_orphan_sweep_lease_total`
  - Filter: `resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_lease_total"`
  - **Alerted on, filtered to `outcome="contended"`.** The Run_Lease admits one execution at a time; a declined acquisition means another execution held an unexpired lease, so this run listed nothing, swept nothing and exited **zero** — deliberately, because nothing was skipped. That is exactly why it needs an alert rather than an exit code: a run that is *always* declined is indistinguishable, from the report documents alone, from a run that is quietly succeeding.
  - Three outcomes on one metric: `acquired` and `contended` from the runner, `lost` from the core's tenant loop when a renewal reads a foreign token. One line per outcome per invocation, `value: 1`, labelled `mode` and `outcome` and **no `tenant_id`** — a lease is run-level and names no tenant.
  - **This one needs the label extractor**, because the alert condition filters on `outcome`. Created in the simple counter form the series carries no `outcome` at all, the condition can never fire, and on a threshold-on-zero condition that is indistinguishable from everything being fine. Use the `--config-from-file` form below.
- The remaining eleven (`storage_orphan_sweep_runs_total`, `…_objects_scanned_total`, `…_retained_total`, `…_orphans_total`, `…_orphan_bytes`, `…_quarantined_total`, `…_quarantined_bytes`, `…_quarantine_failures_total`, `…_dangling_references_total`, `…_report_writes_total`, `…_reference_pages_total`) are emitted the same way and are worth creating for dashboards, but nothing alerts on them. Each is `jsonPayload.metric="<name>"` with the delta in `jsonPayload.value`; for these, a **distribution** metric with `valueExtractor: EXTRACT(jsonPayload.value)` is what makes the numbers add up, since a counter would only count the summary lines.
  - `storage_orphan_sweep_report_writes_total` is the one to watch after the write-batching change: it is the Report_Document write count per tenant per invocation, and the whole point of the batching is that this number is now far below the listing's page count. A value that tracks the page count again means the cadence has regressed to one write per page on the single document the resume cursor lives on.
  - `storage_orphan_sweep_reference_pages_total` carries the Reference_Source identifier on the **`reason`** label — eight bounded values, not a new `source` label, because the permitted label set is closed at `tenant_id`, `mode`, `reason`, `outcome` and `abort_reason`. A source that read no page emits nothing at all, so an absent series means "read no page" rather than "was not instrumented".
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

Create the two **new** alerted metrics (`storage-sweep-scale-hardening` task 10.1 — the policy's
conditions 3 and 4 read these, so create them before applying the policy update):

```bash
export PROJECT_ID=tution-app-6c0c3

gcloud logging metrics create storage_orphan_sweep_tenant_failures_total \
  --project=$PROJECT_ID \
  --description="Storage orphan sweep could not sweep a tenant (confined to that tenant; the run exits non-zero)" \
  --log-filter='resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_tenant_failures_total"'

gcloud logging metrics create storage_orphan_sweep_lease_total \
  --project=$PROJECT_ID \
  --config-from-file=storage_orphan_sweep_lease_total.yaml
```

The lease metric is the one that **cannot** use the simple form: the policy's condition filters to
`metric.label.outcome="contended"`, and a counter created without label extractors carries no
`outcome` at all — so the condition would never receive a point, which on a threshold-on-zero
condition is indistinguishable from everything being fine. Its config file, whose `filter` is the
same `jsonPayload.metric` selector as every other metric here:

```yaml
# storage_orphan_sweep_lease_total.yaml
name: storage_orphan_sweep_lease_total
description: Storage orphan sweep Run_Lease outcomes (acquired / contended / lost)
filter: resource.type="cloud_run_job" AND jsonPayload.metric="storage_orphan_sweep_lease_total"
labelExtractors:
  mode: EXTRACT(jsonPayload.mode)
  outcome: EXTRACT(jsonPayload.outcome)
metricDescriptor:
  metricKind: DELTA
  valueType: INT64
  labels:
    - key: mode
    - key: outcome
```

There is deliberately **no `tenant_id` extractor** on that one: a lease is run-level, the emitted
line carries no `tenant_id` field, and an extractor for an absent field would produce an empty label
rather than a useful one. The `tenant_failures_total` metric is the opposite case and is worth
creating from a config file too if you want the per-tenant breakdown the runbook tells you to read —
same shape as the `aborted_total` example below, with `tenant_id` and `mode` extractors.

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
deploy script. Create the four log-based metrics listed above first — a policy whose metric does not
exist never fires, which on a condition that is expected to stay at zero is indistinguishable from
everything being fine.

That policy is now **deployed and enabled**, and `storage-sweep-scale-hardening` task 10.1 **added
two conditions to it** rather than rebuilding it: `tenant_failures_total > 0` and `lease_total`
filtered to `outcome="contended"`. So the maintainer action for those two is an *update* of the
existing policy, and the two new metrics have to exist first:

```bash
export PROJECT_ID=tution-app-6c0c3

# The policy name, which is not the display name.
gcloud alpha monitoring policies list --project=$PROJECT_ID \
  --filter='displayName="Storage orphan sweep: investigate"' --format='value(name)'

gcloud alpha monitoring policies update POLICY_NAME \
  --project=$PROJECT_ID \
  --policy-from-file=infra/monitoring/storage-orphan-sweep-alert-policy.json
```

The display name, the combiner, the enabled flag, the notification channel and both original
conditions are unchanged in that file, so the update adds conditions 3 and 4 and touches nothing
that is already firing.

List policies:

```bash
gcloud alpha monitoring policies list --project=$PROJECT_ID \
  --format='table(displayName,name)'
```

## Notes

- The critical policy JSON includes a project-specific email notification channel. If you recreate this in a different GCP project, update/remove `notificationChannels`.
- The `scan saturated` policy is a **warning** signal; it means you should increase scanning capacity or add pagination/cursors.
- For `usage-rollup-job` (once per day), Cloud Monitoring `conditionAbsent` duration is capped at 23h30m, so the repo policy alerts on failures only.
