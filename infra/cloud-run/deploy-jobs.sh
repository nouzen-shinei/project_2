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
  # Both ship with STORAGE_ORPHAN_SWEEP_ENABLED=0 and STORAGE_ORPHAN_SWEEP_APPLY=0,
  # so deploying them deploys a job that logs its decision and exits 0 without
  # initialising Firebase. Enabling it is a maintainer action. Repin the image
  # digest to a build containing dist/jobs/runStorageOrphanSweep.js first.
  "${SCRIPT_DIR}/storage-orphan-sweep-job.yaml"
  "${SCRIPT_DIR}/billing-stale-pending-job-dev.yaml"
  "${SCRIPT_DIR}/play-billing-reconcile-job-dev.yaml"
  "${SCRIPT_DIR}/usage-refresh-job-dev.yaml"
  "${SCRIPT_DIR}/usage-rollup-job-dev.yaml"
  "${SCRIPT_DIR}/storage-orphan-sweep-job-dev.yaml"
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

# ─── Storage orphan-sweep quarantine retention (NOT applied by this script) ───
#
# `infra/storage/quarantine-lifecycle.json` holds the GCS lifecycle rule that is
# the load-bearing retention mechanism for the orphan sweep's quarantine
# namespace: delete anything under `_orphan-quarantine/` once it is 7 days old.
# `purgeExpiredQuarantine` in the job implements the same deletion as a redundant
# path that does not depend on this rule.
#
# Applying it to the live bucket is a MAINTAINER action and is deliberately left
# out of this script's deploy loop, because it changes a bucket-wide policy rather
# than a job definition. Run it from the repository root:
#
#   gcloud storage buckets update gs://tution-app-6c0c3.firebasestorage.app \
#     --lifecycle-file=infra/storage/quarantine-lifecycle.json
#
# Read the current rule back with:
#
#   gcloud storage buckets describe gs://tution-app-6c0c3.firebasestorage.app \
#     --format='value(lifecycle_config)'
#
# Two notes on the semantics of `age: 7`, both in the safe direction:
#
#   * Lifecycle evaluation is ASYNCHRONOUS. Google runs it in daily cycles, so a
#     deletion may lag the condition by roughly a day. `age: 7` therefore means
#     "at least 7 days", never "exactly 7" — a quarantined object is retained for
#     longer than the window, never less.
#   * `age` counts from the object's own creation time, which for a quarantined
#     object is the time the sweep COPIED it into `_orphan-quarantine/`, not the
#     original upload time. That is exactly when the recovery window should start.
