# Email Backend

High-volume email delivery microservice (SES primary, Resend fallback) for fee reminders & custom bilingual messages.

## Endpoints
- GET /health
- POST /email/send
- GET /email/ping
- POST /webhook/ses
- POST /webhook/resend
- Admin:
  - GET /admin/suppressions
  - DELETE /admin/suppressions/:email
  - POST /admin/suppressions { email, reason: unsubscribed|manual_block|bounce|complaint }
  - GET /admin/idempotent/:key
  - POST /admin/idempotent/clear
  - GET /admin/suppressions.csv
  - GET /admin/metrics.json
  - GET /admin/sendlog.ndjson (requires tenant header; returns only matching entries)
   - GET /dashboard/metrics (requires INTERNAL_API_KEY via x-internal-key)
```
{
  "to": "parent@example.com",
  "kind": "fee" | "custom",
  "studentName": "John Doe",
  "amount": "2000",
  "dueDate": "2025-09-01",
  "messages": { "en": "Hello", "hi": "नमस्ते" },
  "order": "english-first" | "hindi-first",
  "showLabels": true
}
```

## Env Vars (core & advanced)
```
PORT=8090
EMAIL_PROVIDER_PRIMARY=ses
EMAIL_PROVIDER_FALLBACK=resend
EMAIL_RATE_LIMIT_PER_MIN=600
EMAIL_DAILY_CAP=8000
WARMUP_START_TS=0              # ms epoch when warm-up started; ramps 300/600/1200/2400/5000 capped by EMAIL_RATE_LIMIT_PER_MIN
EMAIL_PER_KEY_DAILY_CAP=0      # per x-internal-key cap; requires Redis; when >0, x-internal-key is required on /email/send
TZ=Asia/Kolkata                # optional timezone for day reset
QUOTA_KEY_HEADER=x-internal-key # header to use for per-key quotas
QUOTA_KEY_CLAIM=tenantId        # optional JWT claim to use when header absent
QUOTA_JWT_VERIFY=0              # when 1, verify JWT; set QUOTA_JWT_ALG and a key/secret below
QUOTA_JWT_ALG=RS256             # RS256 or HS256
QUOTA_JWT_PUBLIC_KEY=           # PEM public key for RS256
QUOTA_JWT_PUBLIC_KEY_B64=       # alt: base64-encoded PEM
QUOTA_JWT_SECRET=               # secret for HS256
INTERNAL_API_KEY=replace_with_internal_key
ASYNC_SENDS=0                  # when 1, accept immediately with 202 and process via background queue
SEND_LOG_FILE=./logs/sendlog.ndjson # path to append-only NDJSON send log
GLOBAL_LIMIT_REDIS=0           # when 1 and Redis is configured, enforce global per-minute and daily caps in Redis

# Multi-tenant sender pools
DEFAULT_TENANT=                 # optional default tenant key
TENANT_HEADER=x-tenant          # header to read the tenant from (fallback to x-tenant if unset; also scopes admin sendlog export)
TENANT_CLAIM=tenant_id          # optional JWT claim name for tenant (used if TENANT_HEADER missing and Authorization Bearer is present)
SENDER_POOLS_JSON={"schoolA":{"email":"noreply@schoolA.com","name":"School A"},"schoolB":{"email":"mail@schoolB.org"}}
TENANT_REQUIRED=0               # when 1, reject requests missing tenant (unless DEFAULT_TENANT is set)

# Provider credentials
AWS_SES_REGION=ap-south-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
SES_SENDER_EMAIL=no-reply@yourdomain.com
RESEND_API_KEY=...
RESEND_DOMAIN=mg.yourdomain.com
RESEND_WEBHOOK_SECRET=         # optional HMAC secret for /webhook/resend

# Admin rate limiting
ADMIN_RATE_PER_MIN=120

# Circuit breaker
PROVIDER_CB_FAILS=5
PROVIDER_CB_HALF_OPEN_MS=30000

# Redis (optional)
REDIS_URL=redis://localhost:6379
REDIS_RETRY_QUEUE=0

# SNS webhook security
SNS_VALIDATE_SIGNATURE=1
SNS_AUTO_CONFIRM=1

# Audit logging & redaction
AUDIT_LOG_FILE=./logs/audit.log
AUDIT_REDACT_BODIES=1

# Canary
PING_EMAIL=you+canary@yourdomain.com

# Backend-runtime callback (optional but recommended for reminders)
# Prefer remote-config via Firestore: appSettings/runtimeEndpoints.apiBaseUrl
# Env fallback is used only when Firestore is unavailable or the field is missing.
BACKEND_RUNTIME_URL=https://your-backend-runtime-host
BACKEND_RUNTIME_INTERNAL_KEY=               # should match backend-runtime INTERNAL_API_KEY
BACKEND_RUNTIME_CALLBACK_TIMEOUT_MS=3000
```

## Features
- SES primary + Resend fallback provider chain
- Circuit breaker per provider (metrics: provider_circuit_state)
- Idempotency with replay header & cache clear admin endpoint
- Suppression (bounce/complaint from SNS webhook)
- Retry queue (in-memory or Redis ZSET when REDIS_RETRY_QUEUE=1)
- Exponential backoff with metrics (queue size, attempts, giveups)
- Admin endpoints (suppressions list/purge, idempotent view/clear) with per-IP rate limiting (memory + Redis)
- Prometheus metrics (send totals, latency, retries, suppressions, idempotent store, circuit breaker, admin limits)
- Audit logging with PII masking & optional body redaction
- SNS signature validation & subscription auto-confirm
- Resend webhook with optional HMAC validation
- File persistence + optional Redis adapters
- Multi-tenant sender pools: select From address/name by tenant via TENANT_HEADER/body.tenant/JWT TENANT_CLAIM; fallback to DEFAULT_TENANT.
- Optional async mode (202 Accepted) with background queue
- Append-only send log with admin export

## Admin Metrics & Rate Limiting
Admin endpoints are protected via API key (`INTERNAL_API_KEY`) and dual-layer rate limiting (in-memory + optional Redis). Metrics:

- `admin_requests_total{route="<name>"}`: Total admin requests per route.
- `admin_rate_limited_total{route="<name>"}`: Count of requests rejected by rate limit.
- `provider_circuit_state{provider}`: 0 (closed) or 1 (open) for each provider circuit breaker.

Tuning:

- `ADMIN_RATE_PER_MIN` sets per-IP tokens per minute.
- Redis usage (set `REDIS_URL`) enables distributed counters.

Circuit Breaker:

- `PROVIDER_CB_FAILS` consecutive failures open the breaker (state=1) for that provider.
- After `PROVIDER_CB_HALF_OPEN_MS`, one trial request is allowed; success closes the breaker (state=0), failure re-opens.

## Dev
```
npm install
npm run dev
```

To run Redis retry integration tests (optional):
```
export REDIS_URL=redis://localhost:6379
export REDIS_RETRY_QUEUE=1
npm test
```

Tenant-based From selection quick start:
```
export DEFAULT_TENANT=schoolA
export TENANT_HEADER=x-tenant
export SENDER_POOLS_JSON='{"schoolA":{"email":"noreply@schoolA.com","name":"School A"},"schoolB":{"email":"mail@schoolB.org"}}'

# Request header
x-tenant: schoolB
# or body.tenant: "schoolB"
# or set TENANT_CLAIM=tenant_id and include a JWT with {"tenant_id":"schoolB"}
```

## Build & Run
```
npm run build
npm start
```

## Deploy

Docker (generic):
```
docker build -t email-backend:latest .
docker run --rm -p 8090:8090 \
  -e PORT=8090 \
  -e AWS_SES_REGION=ap-south-1 \
  -e AWS_ACCESS_KEY_ID=... \
  -e AWS_SECRET_ACCESS_KEY=... \
  -e SES_SENDER_EMAIL=no-reply@yourdomain.com \
  -e EMAIL_PROVIDER_PRIMARY=ses \
  -e EMAIL_PROVIDER_FALLBACK=resend \
  -e RESEND_API_KEY=... -e RESEND_DOMAIN=... \
  -e INTERNAL_API_KEY=... \
  -e REDIS_URL=... -e REDIS_RETRY_QUEUE=0 \
  email-backend:latest
```

Fly.io (optional):
```
fly launch --copy-config --now # or use existing fly.toml
fly secrets set AWS_SES_REGION=ap-south-1 AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  SES_SENDER_EMAIL=no-reply@yourdomain.com INTERNAL_API_KEY=... RESEND_API_KEY=... RESEND_DOMAIN=...
fly deploy
```

Environment on the platform should mirror `.env` values; avoid committing secrets.

## Notes
- Warm-up is enabled via WARMUP_START_TS and respects EMAIL_RATE_LIMIT_PER_MIN and EMAIL_DAILY_CAP.
- SES SNS webhook and Resend webhook supported for suppression updates.
- Day boundaries and TTLs are computed with Luxon for accurate timezone handling.
- Ensure SPF/DKIM/DMARC for SES & Resend domain.
