import { getTenantMetadata } from './tenantMetadataCache';

const HYDRATED_FLAG = '__tenantMetadataHydrated';

type HydratablePayload = {
  tenantId?: string;
  tenantName?: string;
  coachingName?: string;
  [HYDRATED_FLAG]?: boolean;
};

interface HydrateOptions {
  legacyTenantId?: string;
}

export async function hydrateTenantTemplatePayload<T extends HydratablePayload>(
  payload: T,
  options: HydrateOptions = {}
): Promise<T> {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  if ((payload as any)[HYDRATED_FLAG]) {
    return payload;
  }

  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId.trim() : '';
  const legacyTenantId = options.legacyTenantId?.trim();
  if (!tenantId || (legacyTenantId && tenantId === legacyTenantId)) {
    (payload as any)[HYDRATED_FLAG] = true;
    return payload;
  }

  try {
    const metadata = await getTenantMetadata(tenantId);
    const fallbackCoaching = metadata.coachingName || metadata.name;
    if (fallbackCoaching && !payload.coachingName) {
      (payload as any).coachingName = fallbackCoaching;
    }
    if (metadata.name && !payload.tenantName) {
      (payload as any).tenantName = metadata.name;
    }
  } catch (error) {
    console.warn('[tenant-metadata] hydration failed', {
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    (payload as any)[HYDRATED_FLAG] = true;
  }

  return payload;
}
