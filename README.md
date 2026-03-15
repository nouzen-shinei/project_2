# Tuition Management App

This is a cross-platform tuition/coaching management app built with Expo and Firebase. It runs on Web, Android, and iOS and is designed for small coaching centers and independent tutors who need a straightforward way to manage their classes without heavy software.
I’ve been building this as a solo project for a while to simplify the everyday admin work that tutors usually handle through notebooks, spreadsheets, or scattered messages. It helps a teacher/admin manage students, attendance, fees, and parent communication from one place.

Who it’s for: independent tutors, coaching centers, and small institutes that need a lightweight, mobile-friendly admin + communication workflow.

## Download

Android users can download and install the latest APK directly from the GitHub releases page:

[![Download APK](https://img.shields.io/badge/Download-Android%20APK-green)](https://github.com/nouzen-shinei/project_2/releases)

Download the latest `.apk` file from the most recent release and install it on your Android device.

> You may need to enable **"Install unknown apps"** in Android settings to install the APK.

## App overview

What you can do:

- Manage students and profiles.
- Track attendance (calendar-based views).
- Track fees and payment status/history.
- Communicate with parents via email/WhatsApp/SMS (server-backed integrations).
- Use real-time chat for ongoing conversations (Firebase).

Typical workflow:

1) Add students and parent contact details.
2) Mark attendance daily/weekly.
3) Generate and review monthly fee status.
4) Send reminders (email/WhatsApp/SMS) for pending fees.
5) Use chat for follow-ups and coordination.

### Screens / key modules

- Dashboard: quick overview and shortcuts.
- Students: student profiles and organization.
- Attendance: mark and review attendance history.
- Fees: fee records, payment status, and history.
- Chat: real-time conversations.
- Settings/Admin: authorized users, configuration, and operational tools.

Cross-platform tuition/coaching management app (web + iOS + Android) built with Expo and Firebase, backed by a production-ready runtime service for billing, messaging, reminders, and operational jobs.

This repository is a monorepo:

- The Expo app (UI) lives at the repo root and in `app/`.
- The primary backend service is `backend-runtime/`.
- The email service is `email-backend/`.

## Features

- Authentication: Google OAuth (PKCE) + Firebase Auth.
- Tenant-based authorization: restrict access to approved emails/roles.
- Student management: profiles, attendance, performance.
- Fee management: monthly fees, payment status, history.
- Communications:
  - Email reminders via `email-backend/`.
  - WhatsApp templates via Meta WhatsApp Business Cloud API.
  - SMS/Voice (optional) via Twilio through server-side endpoints.
  - Push notifications and in-app notifications.
- Chat: real-time messaging (Firebase) and tenant-scoped tooling.
- Backend hardening: CSP middleware, metrics, audit logging, queueing, and background jobs.

## Repository layout

```
app/                    Expo Router screens
components/             Shared UI components
services/               Client-side service wrappers
backend-runtime/        Primary API + jobs + queue + webhooks
email-backend/          Email provider integration + templates
scripts/                Release/version tooling and utilities
docs/                   Project documentation
```

## Runtime endpoints (remote configurable)

The app does not rely on `.env` for backend/email base URLs at runtime.

Source of truth: Firestore document `appSettings/runtimeEndpoints`

Set one or more string fields (full `http://` or `https://` URLs):

- `apiBaseUrl` (primary backend)
- `emailApiBaseUrl` (email backend; falls back to `apiBaseUrl`)
- `notificationsApiBaseUrl`
- `wabaApiBaseUrl`
- `chatApiBaseUrl`

Behavior:

- The app reads a cached copy from AsyncStorage for fast/offline boot.
- The app refreshes from Firestore on startup and subscribes to live updates.
- Changes apply without rebuilding the app.

Server-to-server (also Firestore-first):

- `backend-runtime` -> `email-backend`: reads `emailApiBaseUrl` (env fallback: `EMAIL_BACKEND_BASE_URL`, then legacy `EXPO_PUBLIC_EMAIL_API_BASE_URL`).
- `email-backend` -> `backend-runtime` callbacks: reads `apiBaseUrl` (env fallback: `BACKEND_RUNTIME_URL`).

## Prerequisites

- Node.js (required: >=20 and <23)
- npm
- Firebase project (Auth + Firestore + optional RTDB/Storage)
- Expo account (for EAS builds)

## Quickstart (local development)

1) Install dependencies

```sh
npm install
```

2) Create a local env file

Copy `.env.example` to `.env` and fill in the client-side variables.

```sh
cp .env.example .env
```

3) Run the app

```sh
npm run dev
```

Optional: bootstrap Firestore data/settings (if you are setting up a new Firebase project):

```sh
npm run setup:data
npm run init:settings
```

Optional: set runtime endpoints (writes `appSettings/runtimeEndpoints`):

```sh
npm run firestore:set-runtime-endpoints
```

## Backends (local)

### backend-runtime

```sh
cd backend-runtime
npm install
cp .env.example .env
npm run build
npm run start
```

Run tests:

```sh
cd backend-runtime
npm test
```

### email-backend

```sh
cd email-backend
npm install
cp .env.example .env
npm run build
npm run start
```

Note: `email-backend/data/` contains local runtime state and is intentionally ignored by git.

## Configuration

### Expo client environment variables

The `EXPO_PUBLIC_*` variables are embedded in the client bundle and are intentionally public. Never put secrets into `EXPO_PUBLIC_*`.

Common variables:

```env
# Firebase (public config)
EXPO_PUBLIC_FIREBASE_API_KEY=...
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=...
EXPO_PUBLIC_FIREBASE_DATABASE_URL=...
EXPO_PUBLIC_FIREBASE_PROJECT_ID=...
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=...
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
EXPO_PUBLIC_FIREBASE_APP_ID=...

# Google OAuth client IDs
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=...
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=...

# Legacy fallbacks (only used if Firestore runtimeEndpoints is missing/unreachable)
EXPO_PUBLIC_API_BASE_URL=https://your-backend.example.com
EXPO_PUBLIC_EMAIL_API_BASE_URL=https://your-email-backend.example.com
```

### Firebase Auth on Vercel (production web)

If your web app is hosted on a custom domain (for example `https://tuitionmanager.app`), configure Firebase Auth to use that same domain in production.

Required setup:

- In Firebase Console -> Authentication -> Settings -> Authorized domains, add your custom domain (and `www` variant if applicable).
- In Vercel project environment variables (Production), set:

```env
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=tuitionmanager.app
```

- Ensure `vercel.json` includes rewrites for Firebase helper routes before the SPA catch-all:
  - `/__/auth/(.*)` -> `https://<your-firebase-project>.firebaseapp.com/__/auth/$1`
  - `/__/firebase/(.*)` -> `https://<your-firebase-project>.firebaseapp.com/__/firebase/$1`

Why this is needed:

- Firebase Auth web flows rely on `/__/auth/*` helper endpoints.
- Without these rewrites, sign-in may jump to the default `*.firebaseapp.com` domain and then back to your app domain.
- With matching `authDomain` + rewrites, the user-visible auth flow stays on your custom domain.

### Server-only secrets (never in Expo bundle)

- Internal auth: `INTERNAL_API_KEY`
- Meta WhatsApp: `WABA_TOKEN`, `WABA_PHONE_NUMBER_ID`, `META_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`
- Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
- Redis/BullMQ: `REDIS_URL`, `USE_BULLMQ`

## Internal API auth

The backend supports short-lived signed tokens (default 5 minutes) issued by:

- `POST /internal/auth/issue` (authenticated using the master `INTERNAL_API_KEY`)

Do not bundle `INTERNAL_API_KEY` in the client. Instead, have a secure server issue short-lived tokens for the app.

## WhatsApp (Meta Cloud API)

WhatsApp messaging is implemented via Meta WhatsApp Business Cloud API.

High-level capabilities:

- Template builders with strict parameter validation.
- Queueing with retries/backoff.
- Webhook handling for delivery/read/failed events.
- Metrics endpoint for operational visibility.

The canonical implementation lives in `backend-runtime/` (see its README and `backend-runtime/openapi.yaml`).

## Security notes

- Never commit secrets. This repo includes `.gitignore` rules for common key formats and service-account files.
- Use Firestore security rules and server-side tenant checks; client values are not trusted.
- CSP middleware is implemented in `backend-runtime/src/csp.ts` and wired early in app setup.

## Versioning and build numbers

This project uses `scripts/bumpVersion.js` to bump versions and keep native build numbers aligned with a `YYYYMM.patch` scheme.

- Web/UI env values in `.env`:
  - `EXPO_PUBLIC_APP_VERSION`: semantic version (matches `app.json:expo.version`)
  - `EXPO_PUBLIC_APP_BUILD`: `YYYYMM.patch` (e.g., `202509.1`)
  - `EXPO_PUBLIC_RELEASE_MONTH`: human-readable month (e.g., `September 2025`)

- Native build identifiers are derived automatically by the script:
  - iOS `buildNumber`: `YYYYMMpp` as string (e.g., `20250901`)
  - Android `versionCode`: `YYYYMMpp` as integer (e.g., `20250901`)
  - Android `versionCode` is never decreased; if a higher value is present, it is preserved.

We keep `autoIncrement: true` in `eas.json`. EAS may still auto-increment when needed, but since `versionCode`/`buildNumber` are monotonically increasing, values remain consistent.

Usage:

```sh
node scripts/bumpVersion.js patch   # or minor|major
node scripts/bumpVersion.js set 1.2.3
```

Run this before local or cloud EAS builds to sync values.

## Documentation

- Backend runtime service: [backend-runtime/README.md](backend-runtime/README.md)
- Email backend service: [email-backend/README.md](email-backend/README.md)
- Infrastructure notes:
  - Monitoring: [infra/monitoring/README.md](infra/monitoring/README.md)
  - Cloud Scheduler: [infra/cloud-scheduler/README.md](infra/cloud-scheduler/README.md)

## Contributing

- Keep secrets out of git.
- Prefer small, testable changes.
- Run `backend-runtime` tests before opening PRs.

Useful root scripts:

- `npm run lint`
- `npm run test:unit`
- `npm run test:firestore`

## License

This repository is publicly accessible for transparency and review.
No permission is granted to use, copy, modify, or distribute this code.
All rights reserved.
