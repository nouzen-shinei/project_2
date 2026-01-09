# Cloud Scheduler Triggers for Usage Jobs

These commands wire the production Cloud Run jobs defined under `../cloud-run` to Cloud Scheduler using the real project (`tution-app-6c0c3`) and service accounts.

## Prerequisites

```bash
export PROJECT_ID=tution-app-6c0c3
export REGION=asia-south1
export IMAGE=gcr.io/$PROJECT_ID/backend-runtime:latest
export ROLLOUT_SA=usage-rollup-job@$PROJECT_ID.iam.gserviceaccount.com
export REFRESH_SA=usage-refresh-job@$PROJECT_ID.iam.gserviceaccount.com
export SCHEDULER_SA=backend-auth-bridge@$PROJECT_ID.iam.gserviceaccount.com
```

Ensure the service accounts exist and that:

- `usage-rollup-job@…` and `usage-refresh-job@…` have the minimum IAM needed for Firestore/Storage/RTDB.
- `backend-auth-bridge@…` has **Cloud Run Invoker** on `usage-rollup-job`, `usage-refresh-job`, and `billing-stale-pending-job`.

## Deploy or Update the Cloud Run Jobs

```bash
gcloud beta run jobs replace infra/cloud-run/usage-rollup-job.yaml \
  --project=$PROJECT_ID --region=$REGION

gcloud beta run jobs replace infra/cloud-run/usage-refresh-job.yaml \
  --project=$PROJECT_ID --region=$REGION

gcloud beta run jobs replace infra/cloud-run/billing-stale-pending-job.yaml \
  --project=$PROJECT_ID --region=$REGION
```

## Scheduler for Nightly Rollup

```bash
gcloud scheduler jobs create http usage-rollup-nightly \
  --project=$PROJECT_ID --location=$REGION \
  --schedule="0 2 * * *" \
  --http-method=POST \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/usage-rollup-job:run" \
  --oauth-service-account-email=$SCHEDULER_SA \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  --headers="Content-Type=application/json" \
  --max-retry-attempts=3 --max-retry-duration=3600s \
  --message-body='{}'
```

Use `gcloud scheduler jobs update http usage-rollup-nightly …` to tweak schedules without recreating the job.

## Scheduler for Refresh Queue Drainer

```bash
gcloud scheduler jobs create http usage-refresh-queue \
  --project=$PROJECT_ID --location=$REGION \
  --schedule="*/5 * * * *" \
  --http-method=POST \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/usage-refresh-job:run" \
  --oauth-service-account-email=$SCHEDULER_SA \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  --headers="Content-Type=application/json" \
  --max-retry-attempts=3 --max-retry-duration=3600s \
  --message-body='{}'
```

## Scheduler for Auto-cancel Stale Pending Billing

Runs the `billing:stale-pending` sweeper which cancels subscriptions, marks open invoices as failed, and downgrades to Free when no first payment is made within the threshold.

```bash
gcloud scheduler jobs create http billing-stale-pending-hourly \
  --project=$PROJECT_ID --location=$REGION \
  --schedule="0 * * * *" \
  --http-method=POST \
  --uri="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$PROJECT_ID/jobs/billing-stale-pending-job:run" \
  --oauth-service-account-email=$SCHEDULER_SA \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  --headers="Content-Type=application/json" \
  --max-retry-attempts=3 --max-retry-duration=3600s \
  --message-body='{}'
```

## Listing Scheduler Jobs

Some `gcloud scheduler` commands require the location to be specified:

```bash
gcloud scheduler jobs list --project=$PROJECT_ID --location=$REGION
```

## Monitoring Hints

- Create Cloud Monitoring alerts comparing `run.googleapis.com/job/completed_count` vs `failed_count` for both jobs.
- Add log-based metrics for the `[usage_rollup_scheduler]` and `[usage_refresh_worker]` prefixes; alert if no success logs arrive for >24h (rollup) or >15m (refresh).
- Set a Firestore metric-based alert when any `tenantUsageRefreshRequests` document exceeds 10 minutes in the `PENDING` state; this catches refresh-job stalls quickly.
