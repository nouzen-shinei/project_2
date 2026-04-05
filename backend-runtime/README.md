# Backend Runtime ![CI](https://github.com/OWNER/REPO/actions/workflows/backend-runtime-ci.yml/badge.svg) ![Coverage](https://img.shields.io/codecov/c/github/OWNER/REPO?flag=backend-runtime)

Isolated WhatsApp queue backend with optional BullMQ (Redis) for durable processing.

## Features
- Fee reminder & custom message template enqueue
- In-memory queue or BullMQ (set USE_BULLMQ=true and REDIS_URL)
 - BullMQ & ioredis now optionalDependencies; install omitted modules only if durability needed.
- Short-lived HMAC auth token issuance (/internal/auth/issue)
- Bearer auth middleware for all endpoints when INTERNAL_API_KEY set
- Minimal WhatsApp webhook endpoint placeholder
- Metrics endpoint (Prometheus text) with queue depth & in-flight
 - Latency histogram + counters with c8 coverage in CI (Codecov upload supported)
 - Alert gauges: queue depth & failure rate thresholds
- Dockerfile for container builds

## Environment Variables
- PORT (default 8080)
- INTERNAL_API_KEY (enables auth + token issuance)
- CORS_ALLOW_ORIGINS (comma-separated list of allowed origins; default '*' which allows all. Example: CORS_ALLOW_ORIGINS=https://app.example.com,https://admin.example.com)
- USE_BULLMQ=true to enable Redis-backed queue
- REDIS_URL=redis://host:6379 required when USE_BULLMQ
- WHATSAPP_QUEUE_CONCURRENCY (default 4 mem / 8 bull)
- WABA_PHONE_NUMBER_ID / WABA_TOKEN (set to actually send via Meta API; omit for dry-run)
- WHATSAPP_QUEUE_NAME (BullMQ queue name; default wa-reminders)
- WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY / WEB_PUSH_VAPID_SUBJECT (enable production Web Push delivery for browser devices)
 - REVIEWER_AUTO_APPROVE_ENABLED / REVIEWER_AUTO_APPROVE_JOIN_CODE (optional temporary join-code auto-approval gate)
 - REVIEWER_AUTO_APPROVE_TENANT_ID / REVIEWER_AUTO_APPROVE_TENANT_SLUG (optional tenant guardrails for the auto-approve code)
 - REVIEWER_AUTO_APPROVE_ROLE / REVIEWER_AUTO_APPROVE_ACTOR_NAME (optional role + actor label for auto-approved requests; role supports member/staff/admin)
 - ALERT_QUEUE_DEPTH (trigger wa_alert_queue_depth_exceeded)
 - ALERT_FAILURE_RATE (0-1 float triggers wa_alert_failure_rate_exceeded)
 - SHUTDOWN_TIMEOUT_MS (graceful shutdown max wait)

## Runtime Endpoints (Firestore)

Cross-service base URLs can be changed remotely via Firestore document `appSettings/runtimeEndpoints`.

Supported fields (stored as base URLs; trailing slashes are trimmed):
- `apiBaseUrl`
- `emailApiBaseUrl`
- `notificationsApiBaseUrl`
- `wabaApiBaseUrl`
- `chatApiBaseUrl`

Server-side resolution details:
- Cached for ~30s in-memory (see `src/runtimeEndpoints.ts`).
- If `appSettings/runtimeEndpoints` does not exist, the code also checks `appSettings/globalSettings`.
- For email sends, resolution order is: Firestore `emailApiBaseUrl` -> env `EMAIL_BACKEND_BASE_URL` -> legacy env `EXPO_PUBLIC_EMAIL_API_BASE_URL`.

Env vars remain supported as a fallback when Firestore is unavailable or the doc/field is missing.

### Operator API (edit runtime endpoints)

The backend exposes operator-only endpoints for editing this Firestore doc:
- `GET /admin/settings/runtime-endpoints` (reads the current doc)
- `POST /admin/settings/runtime-endpoints` (merge-updates provided fields)

Auth: requires operator auth (`INTERNAL_API_KEY` as master bearer token, or a short-lived internal token issued via `/internal/auth/issue`).

Example (master key as bearer):
```bash
curl -H "Authorization: Bearer $INTERNAL_API_KEY" \
	"$BASE_URL/admin/settings/runtime-endpoints"

curl -X POST \
	-H "Authorization: Bearer $INTERNAL_API_KEY" \
	-H "Content-Type: application/json" \
	-d '{"apiBaseUrl":"https://your-backend.example","wabaApiBaseUrl":"https://your-backend.example"}' \
	"$BASE_URL/admin/settings/runtime-endpoints"
```

### Admin Console

The Operator Console UI (`backend-runtime/admin-console`) includes a “Runtime Endpoints” panel under the Settings tab.
Use it to view/edit `appSettings/runtimeEndpoints` without deploying new builds.

## Run (In-memory)
```bash
npm install
npm run dev
```

## Run (BullMQ)
```bash
npm install bullmq ioredis   # only if not already present (optional)
export USE_BULLMQ=true REDIS_URL=redis://localhost:6379
npm run dev
```

## Build & Run Docker
```bash
docker build -t backend-runtime .
docker run -p 8080:8080 --env INTERNAL_API_KEY=secret backend-runtime
```

## API (Core)
POST /whatsapp/queue/fee-reminder { to, studentName, amount, dueDate, language?, bilingual? }
POST /whatsapp/queue/custom-message { to, message, language? }
GET /whatsapp/queue/status?jobId=ID or jobIds=ID1,ID2
GET /metrics
GET /health
POST /internal/auth/issue (header x-internal-secret required)
POST /webhooks/whatsapp (placeholder)
GET /notifications/daily-quotes/status
POST /notifications/daily-quotes/trigger { timeOfDay?, targetEmails?, dryRun?, reason?, now? }
POST /notifications/birthday/trigger { email?, emails?, deviceId?, deviceIds?, dryRun?, forceSend?, skipWhatsApp?, suppressStateUpdates?, reason?, now? }
POST /notifications/birthday/test { email?, emails?, deviceId?, deviceIds? } (defaults: forceSend, skipWhatsApp, suppressStateUpdates)
GET /notifications/web-push/config?tenantId=...
POST /notifications/web-push/subscribe { tenantId, deviceId, subscription, notificationPermission?, userAgent? }
POST /notifications/web-push/unsubscribe { tenantId, deviceId }
POST /notifications/web-push/send { tenantId, deviceId, title, body, data?, tag?, requireInteraction?, clickUrl?, ttl?, urgency? }
POST /notifications/web-push/test { tenantId, deviceId, title?, body?, type?, clickUrl?, requireInteraction? }

## Auth
Issue a token then use Authorization: Bearer <token>.
Master key (INTERNAL_API_KEY) may also be used directly as bearer for automation.

### Global Admin Custom Claims

Firestore rules now support global admin checks via Firebase Auth custom claim `admin=true`.

Set or revoke with the included script:

```bash
cd backend-runtime
npm run auth:set-global-admin -- --email admin@example.com --admin true
npm run auth:set-global-admin -- --uid <firebase-uid> --admin false
npm run auth:set-global-admin -- --email admin@example.com --get
npm run auth:set-global-admin -- --email ops@example.com --admin true --bootstrap
```

This script also revokes refresh tokens so claim changes take effect after the user refreshes auth.
`--bootstrap` is recommended for first production setup: it refuses to set a new admin if another admin claim already exists (unless you pass `--force`).

Operator endpoints:

- `GET /admin/auth/global-admin/me` (requires global admin or master)
- `POST /admin/auth/global-admin/get` with `{ "uid": "..." }` or `{ "email": "..." }` (requires global admin or master)
- `POST /admin/auth/global-admin/set` with `{ "uid"|"email", "admin": true|false, "reason"? }` (master token only)

## Future Enhancements
- Delivery/read webhook handling with status correlation
- Extended metrics (success/fail counters, latency histograms)
- Persistent job audit log
- OpenAPI spec generation
 - Replace placeholder badges (OWNER/REPO) with actual repository slug once known

## Operator Console (New)
- A standalone React/Vite dashboard now lives in `backend-runtime/admin-console`
- Covers every runtime endpoint: auth, diagnostics, WhatsApp queue, notifications, Twilio, chat tools
- Run with `npm install && npm run dev` inside the folder, or `npm run build` for static hosting
