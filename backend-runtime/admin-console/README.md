# Backend Runtime Admin Console

Dedicated React/Vite dashboard that surfaces every operational endpoint in `/backend-runtime` so it can be hosted separately from the Expo app.

## Features
- **Connection & Auth** – configure backend base URL, store/persist master key, mint short-lived `/internal/auth/issue` tokens.
- **Diagnostics** – live `/health` heartbeat plus Prometheus `/metrics` viewer with queue depth/failure rate extraction.
- **WhatsApp queue control** – enqueue fee reminders, custom messages, payment confirmations, and query `/whatsapp/queue/status` jobs.
- **Notifications** – trigger daily quotes, birthday blasts/test runs, Expo push proxying, and `/notifications/team-membership` events.
- **Twilio tools** – send SMS or initiate voice calls via `/twilio/sms` and `/twilio/voice-call`.
- **Chat operations** – fetch `/chat/delta`, push/edit/delete `/chat/messages`, and connect to `/chat/stream` SSE for realtime monitoring.

## Getting started

```bash
cd backend-runtime/admin-console
npm install
npm run dev
```

The dev server defaults to `http://localhost:5174`. Build with `npm run build` and deploy the static `dist/` output anywhere (Netlify, Vercel, S3 + CloudFront, etc.).

## Config tips
- The console never proxies secrets; you enter the `INTERNAL_API_KEY` plus base URL directly in the browser. Set "persist" only on trusted devices.
- To connect, ensure the backend exposes HTTPS to the console's origin via `CORS_ALLOW_ORIGINS`.
- Issue a token once per session with the master key and copy/paste it anywhere else if you want to call APIs manually.

## Deployment
Add the `dist/` directory to any static host or plug it behind an internal reverse proxy. No server-side rendering is required.
