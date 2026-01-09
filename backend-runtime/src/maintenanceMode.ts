import { getFirestore } from './firebaseAdmin';

export type MaintenanceMode = {
  enabled: boolean;
  message?: string;
  updatedAt?: string;
};

const COLLECTION = 'appConfig';
const DOC_ID = 'maintenance';

const CACHE_TTL_MS = 5_000;

let cache:
  | {
      fetchedAt: number;
      value: MaintenanceMode | null;
    }
  | undefined;

let inFlight: Promise<MaintenanceMode | null> | undefined;

function normalizeString(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMaintenance(raw: unknown): MaintenanceMode | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const enabled = Boolean(obj.enabled);
  const message = normalizeString(obj.message);
  const updatedAt = normalizeString(obj.updatedAt);
  return { enabled, message, updatedAt };
}

export async function getMaintenanceMode(): Promise<MaintenanceMode | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const db = getFirestore();
      const ref = db.collection(COLLECTION).doc(DOC_ID);
      const snap = await ref.get();
      const normalized = snap.exists ? normalizeMaintenance(snap.data()) : null;
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
