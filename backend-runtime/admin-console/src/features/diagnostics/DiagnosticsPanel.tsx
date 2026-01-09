import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchHealth } from '../../lib/apiClient';
import { useConfigStore, type ConfigState } from '../../store/configStore';
import { SectionCard } from '../../components/SectionCard';
import { useMetricsFeed } from '../../hooks/useMetricsFeed';
import { parsePromMetrics } from '../../lib/metrics';

function useBackendEnabled() {
  return useConfigStore((state: ConfigState) => Boolean(state.baseUrl));
}

export function DiagnosticsPanel() {
  const enabled = useBackendEnabled();
  const queryClient = useQueryClient();
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: fetchHealth, enabled });
  const metricsFeed = useMetricsFeed();
  const parsedMetrics = useMemo(() => parsePromMetrics(metricsFeed.metricsText), [metricsFeed.metricsText]);
  const queueDepth = parsedMetrics['wa_queue_depth'];
  const inFlight = parsedMetrics['wa_queue_in_flight'];
  const failureRate = parsedMetrics['wa_failure_rate'];

  const statusBadge = healthQuery.isSuccess && healthQuery.data?.status === 'ok' ? (
    <span className="badge online">Healthy</span>
  ) : healthQuery.isError ? (
    <span className="badge offline">Unreachable</span>
  ) : (
    <span className="badge" style={{ background: 'rgba(14,165,233,0.18)', color: '#7dd3fc' }}>Pending</span>
  );

  return (
    <SectionCard
      title="Diagnostics"
      description="Live health + Prometheus metrics surfaced from the runtime."
      headerExtra={
        <button
          className="primary-button"
          type="button"
          onClick={() => {
            queryClient.invalidateQueries({ queryKey: ['health'] });
            metricsFeed.metricsQuery.refetch();
          }}
          disabled={!enabled}
        >
          Refresh
        </button>
      }
    >
      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>{statusBadge}</div>
      {healthQuery.data && (
        <p className="muted">Uptime: {healthQuery.data.uptime.toFixed(0)}s • Timestamp: {new Date(healthQuery.data.ts).toLocaleTimeString()}</p>
      )}
      {metricsFeed.metricsText && (
        <pre className="code-block" style={{ maxHeight: 180, overflow: 'auto' }}>{metricsFeed.metricsText}</pre>
      )}
      {(queueDepth !== undefined || inFlight !== undefined) && (
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {queueDepth !== undefined && (
            <div>
              <p className="muted">Queue depth</p>
              <strong style={{ fontSize: '1.6rem' }}>{queueDepth}</strong>
            </div>
          )}
          {inFlight !== undefined && (
            <div>
              <p className="muted">In-flight jobs</p>
              <strong style={{ fontSize: '1.6rem' }}>{inFlight}</strong>
            </div>
          )}
          {failureRate !== undefined && (
            <div>
              <p className="muted">Failure rate</p>
              <strong style={{ fontSize: '1.6rem' }}>{(failureRate * 100).toFixed(2)}%</strong>
            </div>
          )}
        </div>
      )}
      {!enabled && <p className="muted">Set a backend URL to begin polling.</p>}
    </SectionCard>
  );
}
