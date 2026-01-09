import { getFirestore } from './firebaseAdmin';

const TENANT_CACHE_TTL_MS = Number(process.env.TENANT_METADATA_CACHE_TTL_MS || 30_000);
type FirestoreLike = ReturnType<typeof getFirestore>;

export interface TenantMetadataCacheEntry {
  name?: string;
  coachingName?: string;
}

const tenantMetadataCache = new Map<string, { fetchedAt: number; data: TenantMetadataCacheEntry }>();
let firestoreOverride: FirestoreLike | null = null;

function getActiveFirestore(): FirestoreLike {
  if (firestoreOverride) {
    return firestoreOverride;
  }
  return getFirestore();
}

export async function getTenantMetadata(tenantId: string): Promise<TenantMetadataCacheEntry> {
  const normalized = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!normalized) {
    return {};
  }

  const cached = tenantMetadataCache.get(normalized);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TENANT_CACHE_TTL_MS) {
    return cached.data;
  }

  const db = getActiveFirestore();
  const snap = await db.collection('tenants').doc(normalized).get();
  const data = snap.exists ? snap.data() ?? {} : {};
  const metadata: TenantMetadataCacheEntry = {
    name: typeof data.name === 'string' ? data.name.trim() : undefined,
    coachingName: typeof data.coachingName === 'string' ? data.coachingName.trim() : undefined,
  };

  tenantMetadataCache.set(normalized, { fetchedAt: now, data: metadata });
  return metadata;
}

export function clearTenantMetadataCache() {
  tenantMetadataCache.clear();
}

export function setTenantMetadataCacheOverrides(options: { firestore?: FirestoreLike | null } = {}) {
  firestoreOverride = options.firestore ?? null;
}
