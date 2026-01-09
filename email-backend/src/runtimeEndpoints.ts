import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

type RuntimeEndpoints = {
  apiBaseUrl?: string;
  emailApiBaseUrl?: string;
  notificationsApiBaseUrl?: string;
  wabaApiBaseUrl?: string;
  chatApiBaseUrl?: string;
};

const COLLECTION = 'appSettings';
const DOC_ID = 'runtimeEndpoints';
const FALLBACK_DOC_ID = 'globalSettings';

const CACHE_TTL_MS = 30_000;

let cache:
  | {
      fetchedAt: number;
      value: RuntimeEndpoints | null;
    }
  | undefined;

let inFlight: Promise<RuntimeEndpoints | null> | undefined;

function ensureFirebase(): void {
  if (getApps().length > 0) return;
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  try {
    initializeApp({ credential: applicationDefault(), projectId: projectId as any });
  } catch {
    initializeApp({ projectId: projectId as any });
  }
}

function normalizeBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

function normalizeEndpoints(raw: unknown): RuntimeEndpoints | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const endpoints: RuntimeEndpoints = {
    apiBaseUrl: normalizeBaseUrl(obj.apiBaseUrl),
    emailApiBaseUrl: normalizeBaseUrl(obj.emailApiBaseUrl),
    notificationsApiBaseUrl: normalizeBaseUrl(obj.notificationsApiBaseUrl),
    wabaApiBaseUrl: normalizeBaseUrl(obj.wabaApiBaseUrl),
    chatApiBaseUrl: normalizeBaseUrl(obj.chatApiBaseUrl),
  };

  const hasAny = Object.values(endpoints).some(Boolean);
  return hasAny ? endpoints : null;
}

export async function getRuntimeEndpoints(): Promise<RuntimeEndpoints | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      ensureFirebase();
      const db = getFirestore();
      const ref = db.collection(COLLECTION).doc(DOC_ID);
      const snap = await ref.get();
      if (snap.exists) {
        const normalized = normalizeEndpoints(snap.data());
        cache = { fetchedAt: Date.now(), value: normalized };
        return normalized;
      }

      const fallbackRef = db.collection(COLLECTION).doc(FALLBACK_DOC_ID);
      const fallbackSnap = await fallbackRef.get();
      const normalized = fallbackSnap.exists ? normalizeEndpoints(fallbackSnap.data()) : null;
      cache = { fetchedAt: Date.now(), value: normalized };
      return normalized;
    } catch {
      cache = { fetchedAt: Date.now(), value: null };
      return null;
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}

export async function getPreferredBackendBaseUrl(): Promise<string | null> {
  const endpoints = await getRuntimeEndpoints();
  return endpoints?.apiBaseUrl || null;
}

export async function getEmailBackendBaseUrl(): Promise<string | null> {
  const endpoints = await getRuntimeEndpoints();
  return endpoints?.emailApiBaseUrl || null;
}
