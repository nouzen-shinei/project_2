#!/usr/bin/env bash
set -euo pipefail

# Switch Cloud Scheduler HTTP targets between prod and dev Cloud Run jobs.
# Usage:
#   ./switch-scheduler-targets.sh dev
#   ./switch-scheduler-targets.sh prod
#   PROJECT_ID=tution-app-6c0c3 REGION=asia-south1 ./switch-scheduler-targets.sh prod

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <prod|dev>"
  exit 1
fi

MODE="${1}"
if [[ "${MODE}" != "prod" && "${MODE}" != "dev" ]]; then
  echo "Usage: $0 <prod|dev>"
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-$(gcloud config get-value run/region 2>/dev/null || true)}"
OAUTH_SERVICE_ACCOUNT_EMAIL="${OAUTH_SERVICE_ACCOUNT_EMAIL:-}"

if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  echo "ERROR: PROJECT_ID is not set and gcloud project is unset."
  echo "Set PROJECT_ID env var or run: gcloud config set project <project-id>"
  exit 1
fi

if [[ -z "${REGION}" || "${REGION}" == "(unset)" ]]; then
  echo "ERROR: REGION is not set and gcloud run/region is unset."
  echo "Set REGION env var or run: gcloud config set run/region <region>"
  exit 1
fi

suffix=""
if [[ "${MODE}" == "dev" ]]; then
  suffix="-dev"
fi

declare -a mappings=(
  "usage-refresh-queue:usage-refresh-job"
  "billing-stale-pending-hourly:billing-stale-pending-job"
  "usage-rollup-nightly:usage-rollup-job"
)

echo "Switching scheduler targets"
echo "Project: ${PROJECT_ID}"
echo "Region:  ${REGION}"
echo "Mode:    ${MODE}"

for mapping in "${mappings[@]}"; do
  scheduler_name="${mapping%%:*}"
  base_job_name="${mapping##*:}"
  target_job_name="${base_job_name}${suffix}"

  run_uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${target_job_name}:run"

  echo ""
  echo "==> ${scheduler_name} -> ${target_job_name}"
  update_args=(
    scheduler jobs update http "${scheduler_name}"
    --location="${REGION}"
    --project="${PROJECT_ID}"
    --uri="${run_uri}"
  )

  # By default keep the scheduler job's current auth config unchanged.
  # Optionally allow explicit override via env var.
  if [[ -n "${OAUTH_SERVICE_ACCOUNT_EMAIL}" ]]; then
    update_args+=(
      --http-method=POST
      --oauth-service-account-email="${OAUTH_SERVICE_ACCOUNT_EMAIL}"
      --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform"
    )
  fi

  gcloud "${update_args[@]}"
done

echo ""
echo "Scheduler targets switched to ${MODE}."
