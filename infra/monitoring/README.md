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

List policies:

```bash
gcloud alpha monitoring policies list --project=$PROJECT_ID \
  --format='table(displayName,name)'
```

## Notes

- The critical policy JSON includes a project-specific email notification channel. If you recreate this in a different GCP project, update/remove `notificationChannels`.
- The `scan saturated` policy is a **warning** signal; it means you should increase scanning capacity or add pagination/cursors.
- For `usage-rollup-job` (once per day), Cloud Monitoring `conditionAbsent` duration is capped at 23h30m, so the repo policy alerts on failures only.
