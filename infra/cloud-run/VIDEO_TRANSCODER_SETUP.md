# Video Transcoder — Setup & Deployment Guide

## What was built

Server-side HEVC → H.264 transcoding so videos uploaded from iPhones, VN Video
Editor, or any desktop tool play in every mobile browser (Chrome/Edge Android).

The transcoder runs **inside the existing backend-runtime Cloud Run service**
(the Express app). No separate Cloud Run Job is needed for the transcoder itself —
it fires asynchronously after every video upload and writes the result to Firestore.

---

## Step 1 — Rebuild and push the Docker image (adds ffmpeg)

The `Dockerfile` now includes `RUN apk add --no-cache ffmpeg`.

```bash
# From project_2/backend-runtime/
PROJECT_ID=tution-app-6c0c3
REGION=asia-south1   # or your region

docker build -t gcr.io/$PROJECT_ID/backend-runtime:latest .
docker push gcr.io/$PROJECT_ID/backend-runtime:latest
```

Or if you use Cloud Build:

```bash
gcloud builds submit \
  --project=$PROJECT_ID \
  --tag gcr.io/$PROJECT_ID/backend-runtime:latest \
  .
```

---

## Step 2 — Update the Cloud Run service to use more CPU/memory

ffmpeg transcoding is CPU-intensive. Update the main backend service to at least:
- **CPU**: 2 vCPU  (currently likely 1)
- **Memory**: 2Gi  (ffmpeg uses ~500MB for 1080p)

```bash
gcloud run services update YOUR_BACKEND_SERVICE_NAME \
  --project=$PROJECT_ID \
  --region=$REGION \
  --cpu=2 \
  --memory=2Gi \
  --image=gcr.io/$PROJECT_ID/backend-runtime:latest
```

Replace `YOUR_BACKEND_SERVICE_NAME` with your actual service name (check in
Google Cloud Console → Cloud Run, or run `gcloud run services list`).

> **Note:** Cloud Run bills per CPU-second only while a request is being handled.
> Since transcoding runs async (after the HTTP response), Cloud Run will keep
> the instance alive while background work is happening. This is fine for typical
> chat video clips (< 60s). You can set `--min-instances=1` if you want
> guaranteed warmth, but it's not required.

---

## Step 3 — Update the Cloud Run Jobs image (if applicable)

The existing Cloud Run Jobs (usage-rollup, billing, etc.) each pin a specific
image SHA. After building the new image, update them too:

```bash
# Get the new SHA after pushing
NEW_SHA=$(gcloud container images describe gcr.io/$PROJECT_ID/backend-runtime:latest \
  --format='value(image_summary.digest)')

echo "New SHA: $NEW_SHA"

# Update all YAML files in infra/cloud-run/ to point to the new SHA
# (replace the sha256:... in the image: field)
# Then redeploy:
cd infra/cloud-run/
./deploy-jobs.sh
```

---

## Step 4 — Deploy Firestore indexes and rules

```bash
# Deploy the new videoTranscodes composite index
firebase deploy --only firestore:indexes --project=$PROJECT_ID

# Deploy the updated Firestore security rules (adds videoTranscodes read access)
firebase deploy --only firestore:rules --project=$PROJECT_ID
```

---

## Step 5 — No separate Cloud Run Job needed

The transcoder runs inside the existing backend-runtime service process as a
fire-and-forget async task. The architecture is:

```
Client uploads video
     ↓
POST /storage/upload (backend-runtime Cloud Run service)
     ↓
1. Save original to Firebase Storage          ← immediate
2. Return {url, path, ...} to client         ← immediate (< 1s)
3. scheduleVideoTranscode() fires setImmediate ← async, no blocking
     ↓
   [Background in same process]
   - Download original from Storage
   - ffprobe: is it HEVC? (skip if already H.264)
   - ffmpeg: transcode to H.264/AAC
   - Upload _h264.mp4 to Storage
   - Write videoTranscodes/{docId} to Firestore
```

---

## Step 6 — Verify it works

### A. Upload a test HEVC video

1. Export a video from iPhone or VN Video Editor (these produce HEVC)
2. Upload it in the chat on desktop Chrome
3. Check Firestore Console → `videoTranscodes` collection
   - After ~30-60 seconds you should see a document with `status: "done"`
   - It will have a `transcodedUrl` field pointing to the `_h264.mp4` file

### B. Verify the transcoded video plays on Android Chrome

1. Open the chat on Android Chrome
2. The video should now play (the client picks up `transcodedUrl` automatically)

### C. Check backend logs

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND textPayload=~"videoTranscoder"' \
  --project=$PROJECT_ID \
  --limit=50 \
  --freshness=1h
```

You should see:
```
[videoTranscoder] starting transcode: chat-files/...
[videoTranscoder] downloaded chat-files/...
[videoTranscoder] transcode complete: chat-files/...
[videoTranscoder] uploaded transcoded file: chat-files/..._h264.mp4
[videoTranscoder] job done for chat-files/... → https://firebasestorage...
```

---

## Timeouts and resource notes

| Scenario | Approx time |
|---|---|
| 17 MB / 17s HEVC clip (from screenshot) | ~15-25 seconds on 2 vCPU |
| 50 MB / 5-minute video | ~2-3 minutes |
| Already H.264 (skipped) | ~5 seconds (just ffprobe) |

Cloud Run default request timeout is 5 minutes. Transcoding runs async (not inside
the request), so the request finishes immediately. Cloud Run will keep the instance
alive until background tasks complete (up to the instance's max lifetime, 60 minutes).

---

## Already-uploaded HEVC videos

Videos uploaded BEFORE this fix was deployed will still show "Video format not
supported" on Android browsers. The client-side codec detection message is correct
in those cases — there's no automatic backfill. If you want to backfill, you can
create a Cloud Run Job that iterates all chat-files in Storage, finds HEVC videos,
and runs the transcoder on them. Let me know if you want that built.
