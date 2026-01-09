import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { logger } from '@/lib/logger';
import { usageAnalyticsService } from '@/services/usageAnalyticsService';
import type { UsageSummaryResponse } from '@/types/usage';
import { useTenant } from '@/hooks/useTenantContext';

interface UsageSummaryHookResult {
  usageSummary: UsageSummaryResponse | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}
export const useTenantUsageSummary = (
  tenantId: string | null,
  month?: string | null,
  options?: { enabled?: boolean }
): UsageSummaryHookResult => {
  const { activeMembership } = useTenant();
  const [usageSummary, setUsageSummary] = useState<UsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const enabled = options?.enabled !== false;
  const isViewOnlyMember = activeMembership?.role === 'member';
  const effectiveEnabled = enabled && !isViewOnlyMember;
  const lastTenantIdRef = useRef<string | null>(null);

  const inFlightRef = useRef(false);
  const lastFetchAtRef = useRef<number>(0);

  const fetchUsage = useCallback(async () => {
    if (!effectiveEnabled) {
      return;
    }
    if (!tenantId) {
      setUsageSummary(null);
      setError(null);
      return;
    }

    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;

    setLoading(true);
    setError(null);
    try {
      const summary = await usageAnalyticsService.getCurrentUsageSnapshot(tenantId, { month });
      setUsageSummary(summary);
      const refreshedAt = summary.lastRefreshedAt ? new Date(summary.lastRefreshedAt) : new Date();
      setLastUpdated(Number.isNaN(refreshedAt.getTime()) ? new Date() : refreshedAt);
      lastFetchAtRef.current = Date.now();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load usage snapshot.';
      logger.warn('useTenantUsageSummary: failed to load usage snapshot', err);
      setError(message);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [tenantId, month, effectiveEnabled]);

  useEffect(() => {
    if (isViewOnlyMember) {
      setUsageSummary(null);
      setError(null);
      setLastUpdated(null);
    }
  }, [isViewOnlyMember]);

  useEffect(() => {
    if (!tenantId) {
      setUsageSummary(null);
      setError(null);
      setLastUpdated(null);
      lastTenantIdRef.current = null;
      return;
    }

    // Prevent flashing stale values when switching tenants.
    if (lastTenantIdRef.current !== tenantId) {
      lastTenantIdRef.current = tenantId;
      setUsageSummary(null);
      setError(null);
      setLastUpdated(null);
    }

    if (!effectiveEnabled) {
      return;
    }

    fetchUsage().catch((err) => logger.warn('useTenantUsageSummary: bootstrap failed', err));
  }, [tenantId, fetchUsage, effectiveEnabled]);

  useFocusEffect(
    useCallback(() => {
      if (!tenantId) {
        return;
      }

      if (!effectiveEnabled) {
        return;
      }

      // Throttle to avoid double-fetching immediately after mount.
      const now = Date.now();
      if (now - lastFetchAtRef.current < 2500) {
        return;
      }

      fetchUsage().catch((err) => logger.warn('useTenantUsageSummary: focus refresh failed', err));
    }, [tenantId, fetchUsage, effectiveEnabled])
  );

  const refresh = useCallback(async () => {
    if (!effectiveEnabled) {
      return;
    }
    await fetchUsage();
  }, [fetchUsage, effectiveEnabled]);

  return {
    usageSummary,
    loading,
    error,
    lastUpdated,
    refresh,
  };
};
