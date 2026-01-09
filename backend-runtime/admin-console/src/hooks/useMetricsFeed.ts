import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { fetchMetrics } from '../lib/apiClient';
import { parsePromMetrics, type RuntimeMetrics } from '../lib/metrics';
import { useConfigStore, type ConfigState } from '../store/configStore';

export interface MetricsSnapshot {
  timestamp: number;
  label: string;
  metrics: RuntimeMetrics;
}

const HISTORY_LIMIT = 60;

export function useMetricsFeed(options?: { refetchInterval?: number }) {
  const enabled = useConfigStore((state: ConfigState) => Boolean(state.baseUrl));
  const [history, setHistory] = useState<MetricsSnapshot[]>([]);

  const metricsQuery = useQuery({
    queryKey: ['metrics-feed'],
    queryFn: fetchMetrics,
    enabled,
    refetchInterval: enabled ? options?.refetchInterval ?? 10000 : false,
    staleTime: 5000,
  });

  useEffect(() => {
    if (!metricsQuery.data) {
      return;
    }

    const parsed = parsePromMetrics(metricsQuery.data);
    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      label: dayjs().format('HH:mm:ss'),
      metrics: parsed,
    };

    setHistory((prev) => {
      const next = [...prev, snapshot];
      if (next.length > HISTORY_LIMIT) {
        return next.slice(next.length - HISTORY_LIMIT);
      }
      return next;
    });
  }, [metricsQuery.data]);

  const latestMetrics = useMemo(() => {
    return history.length ? history[history.length - 1].metrics : {};
  }, [history]);

  const queueTrend = useMemo(
    () =>
      history.map((entry) => ({
        timestamp: entry.label,
        queueDepth: entry.metrics['wa_queue_depth'] ?? 0,
        inFlight: entry.metrics['wa_queue_in_flight'] ?? 0,
      })),
    [history],
  );

  const failureTrend = useMemo(
    () =>
      history.map((entry) => ({
        timestamp: entry.label,
        failureRate: entry.metrics['wa_failure_rate'] ?? 0,
        alerts: entry.metrics['wa_alert_failure_rate_exceeded'] ?? 0,
      })),
    [history],
  );

  return {
    enabled,
    latestMetrics,
    history,
    queueTrend,
    failureTrend,
    metricsText: metricsQuery.data,
    metricsQuery,
  };
}
