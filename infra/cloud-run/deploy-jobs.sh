#!/usr/bin/env bash
set -euo pipefail

# Deploy all Cloud Run job manifests in this folder (prod + dev).
# Usage:
#   ./deploy-jobs.sh
#   PROJECT_ID=tution-app-6c0c3 REGION=asia-south1 ./deploy-jobs.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${REGION:-$(gcloud config get-value run/region 2>/dev/null || true)}"

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

manifests=(
  "${SCRIPT_DIR}/billing-stale-pending-job.yaml"
  "${SCRIPT_DIR}/play-billing-reconcile-job.yaml"
  "${SCRIPT_DIR}/usage-refresh-job.yaml"
  "${SCRIPT_DIR}/usage-rollup-job.yaml"
  "${SCRIPT_DIR}/billing-stale-pending-job-dev.yaml"
  "${SCRIPT_DIR}/play-billing-reconcile-job-dev.yaml"
  "${SCRIPT_DIR}/usage-refresh-job-dev.yaml"
  "${SCRIPT_DIR}/usage-rollup-job-dev.yaml"
)

echo "Deploying Cloud Run jobs"
echo "Project: ${PROJECT_ID}"
echo "Region:  ${REGION}"

for manifest in "${manifests[@]}"; do
  if [[ ! -f "${manifest}" ]]; then
    echo "ERROR: Missing manifest: ${manifest}"
    exit 1
  fi

  echo ""
  echo "==> Replacing from $(basename "${manifest}")"
  gcloud run jobs replace "${manifest}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}"
done

echo ""
echo "All Cloud Run job manifests deployed successfully."
