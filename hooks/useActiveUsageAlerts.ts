import { useMemo } from 'react';
import { useTenantUsageSummary } from './useTenantUsageSummary';
import type { UsageAlertRecord, UsageMetricKey } from '@/types/usage';

interface ActiveUsageAlertsResult {
  highlightedAlert: UsageAlertRecord | null;
  alertCount: number;
  monthId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const computeAlertRatio = (alert: UsageAlertRecord): number => {
  if (typeof alert.ratio === 'number' && Number.isFinite(alert.ratio)) {
    return alert.ratio;
  }
  if (
    typeof alert.value === 'number'
    && typeof alert.limit === 'number'
    && Number.isFinite(alert.value)
    && Number.isFinite(alert.limit)
    && alert.limit > 0
  ) {
    return alert.value / alert.limit;
  }
  return 0;
};

const sortAlertsByPriority = (alerts: UsageAlertRecord[]): UsageAlertRecord[] => {
  const weight = (alert: UsageAlertRecord) => {
    if (alert.type === 'critical') return 2;
    if (alert.type === 'warning') return 1;
    return 0;
  };
  return [...alerts].sort((a, b) => {
    const typeDelta = weight(b) - weight(a);
    if (typeDelta !== 0) {
      return typeDelta;
    }
    return computeAlertRatio(b) - computeAlertRatio(a);
  });
};

export const useActiveUsageAlerts = (
  tenantId: string | null,
  options?: { metrics?: UsageMetricKey[] }
): ActiveUsageAlertsResult => {
  const { usageSummary, loading, error, refresh } = useTenantUsageSummary(tenantId);

  const metricFilterKey = useMemo(() => {
    const raw = Array.isArray(options?.metrics) ? options?.metrics : [];
    const normalized = raw.filter((metric): metric is UsageMetricKey => typeof metric === 'string' && metric.length > 0);
    if (normalized.length === 0) {
      return '';
    }
    return Array.from(new Set(normalized)).sort().join('|');
  }, [Array.isArray(options?.metrics) ? options?.metrics.join('|') : '']);

  const activeAlerts = useMemo(() => {
    if (!usageSummary?.alerts?.length) {
      return [] as UsageAlertRecord[];
    }
    return usageSummary.alerts.filter((alert) => !alert.acknowledgedAt);
  }, [usageSummary?.alerts]);

  const filteredAlerts = useMemo(() => {
    // Default behavior: include all metrics.
    if (!metricFilterKey) {
      return activeAlerts;
    }
    const allowed = new Set(metricFilterKey.split('|').filter(Boolean) as UsageMetricKey[]);
    if (allowed.size === 0) {
      return activeAlerts;
    }
    return activeAlerts.filter((alert) => allowed.has(alert.metric));
  }, [activeAlerts, metricFilterKey]);

  const highlightedAlert = useMemo(() => {
    if (!filteredAlerts.length) {
      return null;
    }
    return sortAlertsByPriority(filteredAlerts)[0];
  }, [filteredAlerts]);

  return {
    highlightedAlert,
    alertCount: filteredAlerts.length,
    monthId: usageSummary?.month ?? null,
    loading,
    error,
    refresh,
  };
};
