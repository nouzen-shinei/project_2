import { useCallback, useEffect, useState } from 'react';
import { logger } from '@/lib/logger';
import { usageAnalyticsService } from '@/services/usageAnalyticsService';
import type { UsageHistoryPoint } from '@/types/usage';
import { useTenant } from '@/hooks/useTenantContext';

interface UsageHistoryHookResult {
  history: UsageHistoryPoint[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => Promise<void>;
}

export const useTenantUsageHistory = (
  tenantId: string | null,
  months: number = 6,
): UsageHistoryHookResult => {
  const { activeMembership } = useTenant();
  const [history, setHistory] = useState<UsageHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const canFetch = activeMembership?.role === 'owner' || activeMembership?.role === 'admin';

  const fetchHistory = useCallback(async () => {
    if (!canFetch) {
      setHistory([]);
      setError(null);
      setLastUpdated(null);
      return;
    }
    if (!tenantId) {
      setHistory([]);
      setError(null);
      setLastUpdated(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const points = await usageAnalyticsService.getUsageHistory(tenantId, months);
      setHistory(Array.isArray(points) ? points : []);
      setLastUpdated(new Date());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load usage history.';
      logger.warn('useTenantUsageHistory: failed to load usage history', err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [tenantId, months, canFetch]);

  useEffect(() => {
    if (!canFetch) {
      setHistory([]);
      setError(null);
      setLastUpdated(null);
      return;
    }
    if (!tenantId) {
      setHistory([]);
      setError(null);
      setLastUpdated(null);
      return;
    }
    fetchHistory().catch((err) => logger.warn('useTenantUsageHistory: bootstrap failed', err));
  }, [tenantId, fetchHistory, canFetch]);

  const refresh = useCallback(async () => {
    if (!canFetch) {
      return;
    }
    await fetchHistory();
  }, [fetchHistory, canFetch]);

  return {
    history,
    loading,
    error,
    lastUpdated,
    refresh,
  };
};
