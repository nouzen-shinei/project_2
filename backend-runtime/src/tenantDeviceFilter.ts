export interface TenantTaggedDocument {
  tenantIds?: unknown;
  activeTenantId?: unknown;
  tenantMemberships?: unknown;
}

interface TenantMatchOptions {
  allowUntagged?: boolean;
}

export function matchesTenantDevice(
  data: TenantTaggedDocument | null | undefined,
  tenantId?: string | null,
  options: TenantMatchOptions = {}
): boolean {
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!normalizedTenantId) {
    return true;
  }
  if (!data) {
    return false;
  }

  const tenantIds = Array.isArray((data as any).tenantIds)
    ? (data as any).tenantIds
        .map((value: unknown) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    : [];
  if (tenantIds.includes(normalizedTenantId)) {
    return true;
  }

  const activeTenantId = typeof (data as any).activeTenantId === 'string' ? (data as any).activeTenantId.trim() : '';
  if (activeTenantId === normalizedTenantId) {
    return true;
  }

  if (Array.isArray((data as any).tenantMemberships)) {
    const hasMatch = (data as any).tenantMemberships.some((entry: any) => {
      if (!entry || typeof entry !== 'object') return false;
      const membershipTenantId = typeof entry.tenantId === 'string' ? entry.tenantId.trim() : '';
      if (membershipTenantId !== normalizedTenantId) return false;
      const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : 'active';
      return status === 'active';
    });
    if (hasMatch) {
      return true;
    }
  }

  if (options.allowUntagged) {
    const hasTenantMetadata = tenantIds.length > 0 || Boolean(activeTenantId);
    const membershipCount = Array.isArray((data as any).tenantMemberships) ? (data as any).tenantMemberships.length : 0;
    return !hasTenantMetadata && membershipCount === 0;
  }

  return false;
}
