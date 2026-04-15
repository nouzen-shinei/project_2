import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Activity, AlertTriangle, Clock3, Gauge, MemoryStick, MessageCircle, RefreshCcw, Users } from 'lucide-react';
import { SectionCard } from '../../components/SectionCard';
import { Sparkline } from '../../components/Sparkline';
import { StatCard } from '../../components/StatCard';
import { useMetricsFeed } from '../../hooks/useMetricsFeed';
import { formatNumber, formatPercent } from '../../lib/metrics';

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatLatency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 ms';
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ms`;
}

function formatAgeSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return 'Not available';
  }
  const total = Math.floor(value);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h ago`;
  if (hours > 0) return `${hours}h ${minutes}m ago`;
  if (minutes > 0) return `${minutes}m ${seconds}s ago`;
  return `${seconds}s ago`;
}

function formatInSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return 'Not scheduled';
  }
  const total = Math.floor(value);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `In ${days}d ${hours}h`;
  if (hours > 0) return `In ${hours}h ${minutes}m`;
  if (minutes > 0) return `In ${minutes}m ${seconds}s`;
  return `In ${seconds}s`;
}

function humanizeAlert(name: string): string {
  const cleaned = name.replace(/^wa_alert_/, '').replace(/_exceeded$/, '');
  return cleaned
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function readMetric(metrics: Record<string, number>, key: string, fallback = 0): number {
  const value = metrics[key];
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function RuntimeMetricsPanel() {
  const metricsFeed = useMetricsFeed({ refetchInterval: 7000 });
  const latest = metricsFeed.latestMetrics;

  const requests5m = readMetric(latest, 'wa_http_requests_5m');
  const errors5m = readMetric(latest, 'wa_http_errors_5m');
  const errorRate5m = readMetric(latest, 'wa_http_error_rate_5m');
  const p95Latency5m = readMetric(latest, 'wa_http_request_duration_p95_ms_5m');
  const p99Latency5m = readMetric(latest, 'wa_http_request_duration_p99_ms_5m');
  const eventLoopP99 = readMetric(latest, 'wa_runtime_event_loop_lag_p99_ms');
  const rssBytes = readMetric(latest, 'wa_runtime_memory_rss_bytes');
  const inFlight = readMetric(latest, 'wa_http_requests_in_flight');
  const chatWatchCount = readMetric(latest, 'wa_chat_realtime_watches_active');
  const chatWatchSubscribers = readMetric(latest, 'wa_chat_realtime_watch_subscribers');

  const activeAlerts = useMemo(() => {
    return Object.entries(latest)
      .filter(([name, value]) => name.startsWith('wa_alert_') && Number.isFinite(value) && value > 0)
      .map(([name, value]) => ({ name, label: humanizeAlert(name), value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [latest]);

  const throughputTrend = useMemo(
    () =>
      metricsFeed.history.map((entry) => ({
        timestamp: entry.label,
        requests: readMetric(entry.metrics, 'wa_http_requests_5m'),
        errors: readMetric(entry.metrics, 'wa_http_errors_5m'),
        serverErrors: readMetric(entry.metrics, 'wa_http_5xx_5m'),
      })),
    [metricsFeed.history],
  );

  const latencyTrend = useMemo(
    () =>
      metricsFeed.history.map((entry) => ({
        timestamp: entry.label,
        p95: readMetric(entry.metrics, 'wa_http_request_duration_p95_ms_5m'),
        p99: readMetric(entry.metrics, 'wa_http_request_duration_p99_ms_5m'),
        loopP99: readMetric(entry.metrics, 'wa_runtime_event_loop_lag_p99_ms'),
      })),
    [metricsFeed.history],
  );

  const resourceTrend = useMemo(
    () =>
      metricsFeed.history.map((entry) => ({
        timestamp: entry.label,
        rssMb: readMetric(entry.metrics, 'wa_runtime_memory_rss_bytes') / (1024 * 1024),
        heapMb: readMetric(entry.metrics, 'wa_runtime_memory_heap_used_bytes') / (1024 * 1024),
        inFlight: readMetric(entry.metrics, 'wa_http_requests_in_flight'),
      })),
    [metricsFeed.history],
  );

  const chatRealtimeTrend = useMemo(
    () =>
      metricsFeed.history.map((entry) => ({
        timestamp: entry.label,
        watches: readMetric(entry.metrics, 'wa_chat_realtime_watches_active'),
        subscribers: readMetric(entry.metrics, 'wa_chat_realtime_watch_subscribers'),
      })),
    [metricsFeed.history],
  );

  const schedulerRows = [
    {
      name: 'Billing backfill',
      enabled: readMetric(latest, 'wa_billing_backfill_scheduler_enabled') > 0,
      running: readMetric(latest, 'wa_billing_backfill_scheduler_running') > 0,
      ageSeconds: readMetric(latest, 'wa_billing_backfill_last_run_age_seconds', -1),
      nextInSeconds: -1,
    },
    {
      name: 'Play reconcile',
      enabled: readMetric(latest, 'wa_billing_play_reconcile_scheduler_enabled') > 0,
      running: readMetric(latest, 'wa_billing_play_reconcile_scheduler_running') > 0,
      ageSeconds: readMetric(latest, 'wa_billing_play_reconcile_last_run_age_seconds', -1),
      nextInSeconds: readMetric(latest, 'wa_billing_play_reconcile_next_run_in_seconds', -1),
    },
    {
      name: 'Daily quotes',
      enabled: readMetric(latest, 'wa_daily_quotes_scheduler_enabled') > 0,
      running: readMetric(latest, 'wa_daily_quotes_scheduler_running') > 0,
      ageSeconds: readMetric(latest, 'wa_daily_quotes_last_run_age_seconds', -1),
      nextInSeconds: readMetric(latest, 'wa_daily_quotes_next_run_in_seconds', -1),
    },
  ];

  return (
    <SectionCard
      title="Runtime Metrics"
      description="Production telemetry for throughput, latency, resource pressure, and scheduler freshness."
      headerExtra={
        <button
          className="primary-button"
          type="button"
          onClick={() => metricsFeed.metricsQuery.refetch()}
          disabled={metricsFeed.metricsQuery.isFetching || !metricsFeed.enabled}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <RefreshCcw size={16} />
            {metricsFeed.metricsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </span>
        </button>
      }
    >
      <div className="stat-grid">
        <StatCard
          icon={<Activity size={22} />}
          title="Requests (5m)"
          value={<span className="stat-value">{formatNumber(requests5m)}</span>}
          subtitle={`Errors ${formatNumber(errors5m)} in same window`}
          trend={<Sparkline data={throughputTrend} dataKey="requests" color="#60a5fa" />}
        />
        <StatCard
          icon={<AlertTriangle size={22} />}
          title="HTTP error rate"
          value={<span className="stat-value">{formatPercent(errorRate5m)}</span>}
          subtitle="4xx + 5xx over last 5 minutes"
          badge={activeAlerts.some((item) => item.name === 'wa_alert_http_error_rate_5m_exceeded') ? <span className="alert-pill">Alert</span> : null}
          trend={<Sparkline data={throughputTrend} dataKey="errors" color="#fb7185" />}
        />
        <StatCard
          icon={<Clock3 size={22} />}
          title="P95 latency (5m)"
          value={<span className="stat-value">{formatLatency(p95Latency5m)}</span>}
          subtitle={`P99 ${formatLatency(p99Latency5m)}`}
          badge={activeAlerts.some((item) => item.name === 'wa_alert_http_p95_ms_5m_exceeded') ? <span className="alert-pill">Alert</span> : null}
          trend={<Sparkline data={latencyTrend} dataKey="p95" color="#facc15" />}
        />
        <StatCard
          icon={<Gauge size={22} />}
          title="Event loop p99"
          value={<span className="stat-value">{formatLatency(eventLoopP99)}</span>}
          subtitle="Node.js event loop lag"
          badge={activeAlerts.some((item) => item.name === 'wa_alert_runtime_event_loop_p99_ms_exceeded') ? <span className="alert-pill">Alert</span> : null}
          trend={<Sparkline data={latencyTrend} dataKey="loopP99" color="#34d399" />}
        />
        <StatCard
          icon={<MemoryStick size={22} />}
          title="Memory RSS"
          value={<span className="stat-value">{formatBytes(rssBytes)}</span>}
          subtitle="Resident process memory"
          trend={<Sparkline data={resourceTrend} dataKey="rssMb" color="#a78bfa" />}
        />
        <StatCard
          icon={<Activity size={22} />}
          title="In-flight requests"
          value={<span className="stat-value">{formatNumber(inFlight)}</span>}
          subtitle="Current concurrent handlers"
          trend={<Sparkline data={resourceTrend} dataKey="inFlight" color="#22d3ee" />}
        />
        <StatCard
          icon={<MessageCircle size={22} />}
          title="Realtime watches"
          value={<span className="stat-value">{formatNumber(chatWatchCount)}</span>}
          subtitle="Active conversation watcher roots"
          badge={
            activeAlerts.some((item) => item.name === 'wa_alert_chat_realtime_watches_active_exceeded') ? (
              <span className="alert-pill">Alert</span>
            ) : null
          }
          trend={<Sparkline data={chatRealtimeTrend} dataKey="watches" color="#f97316" />}
        />
        <StatCard
          icon={<Users size={22} />}
          title="Realtime subscribers"
          value={<span className="stat-value">{formatNumber(chatWatchSubscribers)}</span>}
          subtitle="Connected stream and websocket listeners"
          badge={
            activeAlerts.some((item) => item.name === 'wa_alert_chat_realtime_watch_subscribers_exceeded') ? (
              <span className="alert-pill">Alert</span>
            ) : null
          }
          trend={<Sparkline data={chatRealtimeTrend} dataKey="subscribers" color="#fb7185" />}
        />
      </div>

      <div className="chart-grid">
        <div className="chart-card">
          <header>
            <p>Throughput and errors</p>
            <span className="muted">Rolling 5-minute counters</span>
          </header>
          {throughputTrend.length ? (
            <div className="chart-wrapper">
              <ResponsiveContainer>
                <AreaChart data={throughputTrend} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="timestamp" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <YAxis allowDecimals={false} tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }} />
                  <Area type="monotone" dataKey="requests" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.25} strokeWidth={3} name="Requests (5m)" />
                  <Area type="monotone" dataKey="errors" stroke="#fb7185" fill="#fb7185" fillOpacity={0.15} strokeWidth={2} name="Errors (5m)" />
                  <Area type="monotone" dataKey="serverErrors" stroke="#f97316" fill="#f97316" fillOpacity={0.1} strokeWidth={2} name="5xx (5m)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="muted">Waiting for metric samples…</p>
          )}
        </div>

        <div className="chart-card">
          <header>
            <p>Latency profile</p>
            <span className="muted">P95/P99 request latency and event-loop lag</span>
          </header>
          {latencyTrend.length ? (
            <div className="chart-wrapper">
              <ResponsiveContainer>
                <AreaChart data={latencyTrend} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="timestamp" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
                    formatter={(value: number) => [`${Number(value).toFixed(1)} ms`, 'Latency']}
                  />
                  <Area type="monotone" dataKey="p95" stroke="#facc15" fill="#facc15" fillOpacity={0.25} strokeWidth={3} name="HTTP p95" />
                  <Area type="monotone" dataKey="p99" stroke="#f97316" fill="#f97316" fillOpacity={0.2} strokeWidth={2} name="HTTP p99" />
                  <Area type="monotone" dataKey="loopP99" stroke="#34d399" fill="#34d399" fillOpacity={0.15} strokeWidth={2} name="Event loop p99" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="muted">Waiting for metric samples…</p>
          )}
        </div>

        <div className="chart-card">
          <header>
            <p>Memory and concurrency</p>
            <span className="muted">Runtime RSS + heap usage + in-flight requests</span>
          </header>
          {resourceTrend.length ? (
            <div className="chart-wrapper">
              <ResponsiveContainer>
                <AreaChart data={resourceTrend} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="timestamp" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
                    formatter={(value: number, name: string) => {
                      if (name === 'rssMb' || name === 'heapMb') {
                        return [`${Number(value).toFixed(1)} MB`, name === 'rssMb' ? 'RSS' : 'Heap used'];
                      }
                      return [formatNumber(value), 'In flight'];
                    }}
                  />
                  <Area type="monotone" dataKey="rssMb" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.25} strokeWidth={3} name="rssMb" />
                  <Area type="monotone" dataKey="heapMb" stroke="#22d3ee" fill="#22d3ee" fillOpacity={0.16} strokeWidth={2} name="heapMb" />
                  <Area type="monotone" dataKey="inFlight" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.12} strokeWidth={2} name="inFlight" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="muted">Waiting for metric samples…</p>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        <div>
          <h3 style={{ margin: 0 }}>Active Alerts</h3>
          {activeAlerts.length === 0 ? (
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              No active metric alerts.
            </p>
          ) : (
            <ul style={{ marginTop: '0.5rem', paddingLeft: '1.1rem' }}>
              {activeAlerts.map((alert) => (
                <li key={alert.name} style={{ color: '#f87171' }}>
                  {alert.label}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h3 style={{ margin: 0 }}>Scheduler Freshness</h3>
          <div style={{ marginTop: '0.5rem', overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Scheduler</th>
                  <th>Enabled</th>
                  <th>Running</th>
                  <th>Last run</th>
                  <th>Next run</th>
                </tr>
              </thead>
              <tbody>
                {schedulerRows.map((row) => (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.enabled ? 'Yes' : 'No'}</td>
                    <td>{row.running ? 'Yes' : 'No'}</td>
                    <td>{formatAgeSeconds(row.ageSeconds)}</td>
                    <td>{formatInSeconds(row.nextInSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {!metricsFeed.enabled && <p className="muted">Set the backend URL and auth token to start metric polling.</p>}
    </SectionCard>
  );
}
