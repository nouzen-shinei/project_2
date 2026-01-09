import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, BarChart3, HeartPulse } from 'lucide-react';
import { SectionCard } from '../../components/SectionCard';
import { Sparkline } from '../../components/Sparkline';
import { StatCard } from '../../components/StatCard';
import { fetchHealth } from '../../lib/apiClient';
import { formatNumber, formatPercent } from '../../lib/metrics';
import { useMetricsFeed } from '../../hooks/useMetricsFeed';
import { useConfigStore, type ConfigState } from '../../store/configStore';

export function OverviewPanel() {
  const { latestMetrics, queueTrend, failureTrend, metricsQuery } = useMetricsFeed({ refetchInterval: 8000 });
  const enabled = useConfigStore((state: ConfigState) => Boolean(state.baseUrl));
  const healthQuery = useQuery({ queryKey: ['health'], queryFn: fetchHealth, enabled, refetchInterval: enabled ? 20000 : false });

  const queueDepth = latestMetrics['wa_queue_depth'] ?? 0;
  const inFlight = latestMetrics['wa_queue_in_flight'] ?? 0;
  const failureRate = latestMetrics['wa_failure_rate'] ?? 0;
  const queueAlert = latestMetrics['wa_alert_queue_depth_exceeded'] ?? 0;
  const failureAlert = latestMetrics['wa_alert_failure_rate_exceeded'] ?? 0;

  const healthBadge = !enabled
    ? 'Disconnected'
    : healthQuery.isLoading
      ? 'Checking…'
      : healthQuery.isError
        ? 'Unreachable'
        : 'Healthy';

  return (
    <SectionCard
      title="Operations Overview"
      description="Live queue pressure, failure rates, and health insights at a glance."
      headerExtra={
        <button className="primary-button" onClick={() => metricsQuery.refetch()} disabled={!enabled}>
          Refresh now
        </button>
      }
    >
      <div className="stat-grid">
        <StatCard
          icon={<BarChart3 size={24} />}
          title="Queue depth"
          value={<span className="stat-value">{formatNumber(queueDepth)}</span>}
          subtitle="jobs waiting"
          badge={queueAlert ? <span className="alert-pill">Alert</span> : <span className="ok-pill">Nominal</span>}
          trend={<Sparkline data={queueTrend} dataKey="queueDepth" color="#60a5fa" />}
        />
        <StatCard
          icon={<Activity size={24} />}
          title="In-flight"
          value={<span className="stat-value">{formatNumber(inFlight)}</span>}
          subtitle="currently processing"
          trend={<Sparkline data={queueTrend} dataKey="inFlight" color="#f472b6" />}
        />
        <StatCard
          icon={<AlertTriangle size={24} />}
          title="Failure rate"
          value={<span className="stat-value">{formatPercent(failureRate)}</span>}
          subtitle="rolling window"
          badge={failureAlert ? <span className="alert-pill">Threshold</span> : null}
          trend={<Sparkline data={failureTrend} dataKey="failureRate" color="#facc15" />}
        />
        <StatCard
          icon={<HeartPulse size={24} />}
          title="Runtime health"
          value={<span className="stat-value">{healthBadge}</span>}
          subtitle={healthQuery.data ? `Uptime ${healthQuery.data.uptime.toFixed(0)}s` : '—'}
        />
      </div>

      <div className="chart-grid">
        <div className="chart-card">
          <header>
            <p>Queue pressure</p>
            <span className="muted">Depth vs in-flight</span>
          </header>
          {queueTrend.length ? (
            <div className="chart-wrapper">
              <ResponsiveContainer>
                <AreaChart data={queueTrend} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="timestamp" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }} labelStyle={{ fontWeight: 600 }} />
                  <Area type="monotone" dataKey="queueDepth" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.25} strokeWidth={3} name="Queued" />
                  <Area type="monotone" dataKey="inFlight" stroke="#f472b6" fill="#f472b6" fillOpacity={0.2} strokeWidth={2} name="In flight" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="muted">Waiting for metric samples…</p>
          )}
        </div>
        <div className="chart-card">
          <header>
            <p>Failure telemetry</p>
            <span className="muted">Rate & alert breaches</span>
          </header>
          {failureTrend.length ? (
            <div className="chart-wrapper">
              <ResponsiveContainer>
                <AreaChart data={failureTrend} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="timestamp" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <YAxis
                    tickFormatter={(value: number) => `${(Number(value) * 100).toFixed(1)}%`}
                    tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }}
                    domain={[0, 'dataMax']}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
                    labelStyle={{ fontWeight: 600 }}
                    formatter={(value: number) => [`${(value * 100).toFixed(2)}%`, 'Failure rate']}
                  />
                  <Area type="monotone" dataKey="failureRate" stroke="#facc15" fill="#facc15" fillOpacity={0.25} strokeWidth={3} name="Failure rate" />
                  <Area type="monotone" dataKey="alerts" stroke="#fb7185" fill="#fb7185" fillOpacity={0.15} strokeWidth={2} name="Alerts" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="muted">Waiting for metric samples…</p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
