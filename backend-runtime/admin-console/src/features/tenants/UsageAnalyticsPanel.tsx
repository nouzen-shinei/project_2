import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, Download, HardDrive, RefreshCcw, TrendingUp, Users, UserPlus } from 'lucide-react';
import { SectionCard } from '../../components/SectionCard';
import { StatCard } from '../../components/StatCard';
import { Sparkline } from '../../components/Sparkline';
import {
  ApiError,
  fetchUsageHistory,
  fetchUsageSummary,
  type UsageAlertRecord,
  type UsageHistoryPoint,
  type UsageMetricKey,
  type UsageMetricStatus,
  type UsageMetricStatusMap,
  type UsageStorageSource,
  type UsageSummaryResponse,
} from '../../lib/apiClient';
import { formatNumber } from '../../lib/metrics';
import { getPlanLimits, type UsageStatus } from '@shared/planLimits';

const DEFAULT_FILTERS = { tenantId: '', months: 6 } as const;
const HISTORY_MONTH_OPTIONS = [3, 6, 9, 12];
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

type FilterState = {
  tenantId: string;
  months: number;
};

type TenantInspectorDetail = {
  tenantId: string;
  focus?: 'memberships' | 'audit';
};

type DeltaMap = {
  students?: number | null;
  staff?: number | null;
  remindersTotal?: number | null;
  storageBytes?: number | null;
};

const usageBadgeClass = (status?: UsageStatus) => {
  if (status === 'critical') return 'badge offline';
  if (status === 'warning') return 'badge offline';
  return 'badge online';
};

const formatStorage = (bytes?: number | null) => {
  if (!bytes || Number.isNaN(bytes)) {
    return '0 MB';
  }
  if (bytes >= GB) {
    const value = bytes / GB;
    return `${Number.isInteger(value) ? value : value.toFixed(2)} GB`;
  }
  return `${((bytes || 0) / MB).toFixed(0)} MB`;
};

const describeHeadroom = (limit?: number, used?: number, isStorage = false) => {
  if (!Number.isFinite(limit)) {
    return 'Plan limit unavailable';
  }
  const normalizedUsed = Number.isFinite(used) ? (used as number) : 0;
  const delta = (limit as number) - normalizedUsed;
  if (delta <= 0) {
    const overText = isStorage ? formatStorage(Math.abs(delta)) : formatNumber(Math.abs(Math.round(delta)));
    return `Over by ${overText}`;
  }
  const formatted = isStorage ? formatStorage(delta) : formatNumber(Math.round(delta));
  return `${formatted} headroom`;
};

const describeDelta = (delta?: number | null, isStorage = false) => {
  if (delta === undefined || delta === null || Number.isNaN(delta) || delta === 0) {
    return 'Flat MoM';
  }
  const prefix = delta > 0 ? '+' : '-';
  const formatted = isStorage ? formatStorage(Math.abs(delta)) : formatNumber(Math.abs(delta));
  return `${prefix}${formatted} MoM`;
};

const formatUsageMetricValue = (metric: UsageMetricKey, value?: number | null) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (metric === 'storage') {
    return formatStorage(value);
  }
  return formatNumber(value);
};

const escapeCsvValue = (value: unknown) => {
  if (value === undefined || value === null) return '""';
  const stringValue = String(value).replace(/"/g, '""');
  return `"${stringValue}"`;
};

const buildHistoryFileName = (tenantId: string, months: number) => {
  const safeTenant = tenantId ? tenantId.replace(/[^a-z0-9_-]/gi, '-').replace(/-+/g, '-') : 'unknown-tenant';
  return `tenant-usage-${safeTenant}-${months}m-${Date.now()}.csv`;
};

const orderHistoryChronologically = (history: UsageHistoryPoint[]) => {
  return [...history].reverse();
};

const computeDeltaMap = (history: UsageHistoryPoint[]): DeltaMap => {
  if (history.length < 2) {
    return {};
  }
  const current = history[0];
  const previous = history[1];
  return {
    students: current.students - previous.students,
    staff: current.staff - previous.staff,
    remindersTotal: current.remindersTotal - previous.remindersTotal,
    storageBytes: current.storageBytes - previous.storageBytes,
  };
};

function renderStatusBadge(status?: UsageMetricStatus) {
  if (!status) return null;
  return (
    <span className={usageBadgeClass(status.status)}>
      {status.status === 'ok' ? 'OK' : status.status === 'warning' ? 'Warning' : 'Critical'} · {status.percentage}%
    </span>
  );
}

function renderStorageSources(sources?: UsageStorageSource[]) {
  if (!sources?.length) return null;
  return (
    <div className="muted small-text" style={{ marginTop: '0.5rem' }}>
      <p style={{ marginBottom: '0.25rem' }}>Storage sources</p>
      <ul>
        {sources.map((source) => (
          <li key={source.label}>
            {source.label}: {formatStorage(source.bytes)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderDiagnostics(summary?: UsageSummaryResponse | null) {
  if (!summary?.diagnostics?.warnings?.length) {
    return null;
  }
  return (
    <div className="muted small-text" style={{ marginTop: '0.5rem' }}>
      <p style={{ marginBottom: '0.25rem' }}>Diagnostics</p>
      <ul>
        {summary.diagnostics.warnings.map((warning, index) => (
          <li key={`${warning}-${index}`}>{warning}</li>
        ))}
      </ul>
      {summary.diagnostics.generatedAt && (
        <p>Generated {new Date(summary.diagnostics.generatedAt).toLocaleString()}</p>
      )}
    </div>
  );
}

function renderAlerts(alerts?: UsageAlertRecord[]) {
  if (!alerts?.length) {
    return null;
  }
  return (
    <div className="muted small-text" style={{ marginTop: '0.5rem' }}>
      <p style={{ marginBottom: '0.25rem' }}>Alerts</p>
      <ul>
        {alerts.map((alert) => {
          const valueLabel = formatUsageMetricValue(alert.metric, alert.value);
          const limitLabel = formatUsageMetricValue(alert.metric, alert.limit);
          const ratioPercent = Number.isFinite(alert.ratio)
            ? Math.round((alert.ratio as number) * 100)
            : typeof alert.value === 'number' && typeof alert.limit === 'number' && alert.limit > 0
              ? Math.round((alert.value / alert.limit) * 100)
              : null;
          return (
            <li key={alert.id}>
              {alert.metric}: {alert.type}
              {valueLabel && limitLabel && ` · ${valueLabel} / ${limitLabel}`}
              {ratioPercent !== null && Number.isFinite(ratioPercent) && ` · ${ratioPercent}%`}
              {alert.acknowledgedAt && ` · Ack ${new Date(alert.acknowledgedAt).toLocaleString()}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function UsageAnalyticsPanel() {
  const [filterDraft, setFilterDraft] = useState<FilterState>(DEFAULT_FILTERS);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [summary, setSummary] = useState<UsageSummaryResponse | null>(null);
  const [history, setHistory] = useState<UsageHistoryPoint[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [summaryNonce, setSummaryNonce] = useState(0);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [exporting, setExporting] = useState(false);
  const summaryCache = useRef<Map<string, UsageSummaryResponse>>(new Map());
  const historyCache = useRef<Map<string, UsageHistoryPoint[]>>(new Map());

  const activeTenant = filters.tenantId.trim();
  const description = activeTenant
    ? `Usage rollups for ${activeTenant} · ${filters.months}-month window`
    : 'Enter a tenant ID to explore trend lines, alerts, and quota headroom.';

  useEffect(() => {
    if (!activeTenant) {
      setSummary(null);
      setSummaryError(null);
      setSummaryLoading(false);
      return;
    }
    const cached = summaryCache.current.get(activeTenant);
    if (cached) {
      setSummary(cached);
    }
    let cancelled = false;
    setSummaryLoading(!cached || summaryNonce > 0);
    setSummaryError(null);
    fetchUsageSummary({ tenantId: activeTenant })
      .then((payload) => {
        if (!cancelled) {
          setSummary(payload);
          summaryCache.current.set(activeTenant, payload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          if (error instanceof ApiError && error.status === 404) {
            setSummary(null);
            setSummaryError('Usage snapshot not found for that tenant.');
          } else if (error instanceof Error) {
            setSummaryError(error.message);
          } else {
            setSummaryError('Unable to load usage summary.');
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSummaryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTenant, summaryNonce]);

  useEffect(() => {
    if (!activeTenant) {
      setHistory([]);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
    const cacheKey = `${activeTenant}:${filters.months}`;
    const cached = historyCache.current.get(cacheKey);
    if (cached) {
      setHistory(cached);
    }
    let cancelled = false;
    setHistoryLoading(!cached || historyNonce > 0);
    setHistoryError(null);
    fetchUsageHistory({ tenantId: activeTenant, months: filters.months })
      .then((payload) => {
        if (!cancelled) {
          setHistory(payload);
          historyCache.current.set(cacheKey, payload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          if (error instanceof Error) {
            setHistoryError(error.message);
          } else {
            setHistoryError('Unable to load usage history.');
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeTenant, filters.months, historyNonce]);

  const orderedHistory = useMemo(() => orderHistoryChronologically(history), [history]);
  const deltaMap = useMemo(() => computeDeltaMap(history), [history]);
  const planLimits = summary ? summary.planLimits ?? getPlanLimits(summary.planId) : null;
  const statuses: UsageMetricStatusMap | undefined = summary?.statuses;

  const reminderBreakdownLine = useMemo(() => {
    if (!summary?.reminders) return null;
    const pieces = [
      `WA ${formatNumber(summary.reminders.whatsapp)}`,
      `SMS ${formatNumber(summary.reminders.sms)}`,
      `Email ${formatNumber(summary.reminders.email)}`,
    ];
    if ((summary.reminders.voice ?? 0) > 0) {
      pieces.push(`Voice ${formatNumber(summary.reminders.voice ?? 0)}`);
    }
    if ((summary.reminders.other ?? 0) > 0) {
      pieces.push(`Other ${formatNumber(summary.reminders.other ?? 0)}`);
    }
    return pieces.join(' · ');
  }, [summary?.reminders]);

  const chartData = useMemo(
    () =>
      orderedHistory.map((point) => ({
        month: point.month,
        students: point.students,
        staff: point.staff,
        remindersTotal: point.remindersTotal,
        remindersWhatsApp: point.remindersWhatsApp ?? 0,
        remindersSms: point.remindersSms ?? 0,
        remindersEmail: point.remindersEmail ?? 0,
        storageBytes: point.storageBytes ?? 0,
        storageGb: Number(((point.storageBytes ?? 0) / GB).toFixed(2)),
      })),
    [orderedHistory],
  );

  const handleFilterSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters({ tenantId: filterDraft.tenantId.trim(), months: filterDraft.months });
  };

  const handleFilterReset = () => {
    setFilterDraft(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
  };

  const handleRefresh = () => {
    if (!activeTenant) return;
    setSummaryNonce((value) => value + 1);
    setHistoryNonce((value) => value + 1);
  };

  const handleOpenTenantInspector = () => {
    if (!activeTenant || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'tenants');
    url.searchParams.set('view', 'membership-inspector');
    url.searchParams.set('tenantId', activeTenant);
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  };

  const handleExportHistory = () => {
    if (typeof window === 'undefined') {
      console.warn('[UsageAnalyticsPanel] CSV export unavailable in this environment');
      return;
    }
    if (!history.length) {
      window.alert('Load usage history before exporting.');
      return;
    }
    try {
      setExporting(true);
      const columns = [
        { key: 'month', label: 'Month' },
        { key: 'students', label: 'Active Students' },
        { key: 'studentsAdded', label: 'Students Added' },
        { key: 'staff', label: 'Team Seats Used' },
        { key: 'remindersTotal', label: 'Reminders Total' },
        { key: 'remindersWhatsApp', label: 'Reminders WhatsApp' },
        { key: 'remindersSms', label: 'Reminders SMS' },
        { key: 'remindersEmail', label: 'Reminders Email' },
        { key: 'noticePosts', label: 'Notice Posts' },
        { key: 'deviceActions', label: 'Device Actions' },
        { key: 'storageBytes', label: 'Storage Bytes' },
        { key: 'storageReadable', label: 'Storage (Readable)' },
        { key: 'chatMessages', label: 'Chat Messages' },
      ];

      const lines = history.map((point) => {
        const row: Record<string, string | number> = {
          month: point.month,
          students: point.students,
          studentsAdded: point.studentsAdded ?? 0,
          staff: point.staff,
          remindersTotal: point.remindersTotal,
          remindersWhatsApp: point.remindersWhatsApp ?? 0,
          remindersSms: point.remindersSms ?? 0,
          remindersEmail: point.remindersEmail ?? 0,
          noticePosts: point.noticePosts ?? 0,
          deviceActions: point.deviceActions ?? 0,
          storageBytes: point.storageBytes ?? 0,
          storageReadable: formatStorage(point.storageBytes ?? 0),
          chatMessages: point.chatMessages ?? 0,
        };
        return columns.map((column) => escapeCsvValue(row[column.key])).join(',');
      });

      const metadataLines = [
        `${escapeCsvValue('Tenant ID')},${escapeCsvValue(activeTenant || 'Not set')}`,
        `${escapeCsvValue('Months')},${escapeCsvValue(filters.months)}`,
        `${escapeCsvValue('Exported At')},${escapeCsvValue(new Date().toISOString())}`,
        '',
      ];

      const headerLine = columns.map((column) => escapeCsvValue(column.label)).join(',');
      const csvContent = [...metadataLines, headerLine, ...lines].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = buildHistoryFileName(activeTenant || 'tenant', filters.months);
      window.document.body.appendChild(link);
      link.click();
      window.document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('[UsageAnalyticsPanel] CSV export failed', error);
      window.alert('Failed to export usage history. Check console for details.');
    } finally {
      setExporting(false);
    }
  };

  const summaryCards = useMemo(() => {
    if (!summary || !planLimits) {
      return [];
    }
    return [
      {
        key: 'students' as UsageMetricKey,
        title: 'Students',
        value: formatNumber(summary.students),
        subtitle: `${describeHeadroom(planLimits.students, summary.students)}${summary.studentsAdded ? ` · ${formatNumber(summary.studentsAdded)} added` : ''}`,
        badge: renderStatusBadge(statuses?.students),
        trend: <Sparkline data={chartData} dataKey="students" color="#38bdf8" />,
        icon: <Users size={22} />,
        delta: describeDelta(deltaMap.students ?? null),
      },
      {
        key: 'staff' as UsageMetricKey,
        title: 'Team seats',
        value: formatNumber(summary.staff),
        subtitle: describeHeadroom(planLimits.staffSeats, summary.staff),
        badge: renderStatusBadge(statuses?.staff),
        trend: <Sparkline data={chartData} dataKey="staff" color="#f472b6" />,
        icon: <UserPlus size={22} />,
        delta: describeDelta(deltaMap.staff ?? null),
      },
      {
        key: 'reminders' as UsageMetricKey,
        title: 'Reminders sent',
        value: formatNumber(summary.reminders.total),
        subtitle: reminderBreakdownLine || describeHeadroom(planLimits.reminders.total, summary.reminders.total),
        badge: renderStatusBadge(statuses?.reminders),
        trend: <Sparkline data={chartData} dataKey="remindersTotal" color="#facc15" />,
        icon: <TrendingUp size={22} />,
        delta: describeDelta(deltaMap.remindersTotal ?? null),
      },
      {
        key: 'storage' as UsageMetricKey,
        title: 'Storage',
        value: formatStorage(summary.storageBytes),
        subtitle: describeHeadroom(planLimits.storageBytes, summary.storageBytes, true),
        badge: renderStatusBadge(statuses?.storage),
        trend: <Sparkline data={chartData} dataKey="storageBytes" color="#34d399" />,
        icon: <HardDrive size={22} />,
        delta: describeDelta(deltaMap.storageBytes ?? null, true),
      },
    ];
  }, [summary, planLimits, statuses, chartData, reminderBreakdownLine, deltaMap]);

  return (
    <SectionCard
      title="Usage analytics"
      description={description}
      headerExtra={
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="text-button" type="button" onClick={handleRefresh} disabled={!activeTenant || summaryLoading || historyLoading}>
            <RefreshCcw size={14} /> Refresh
          </button>
          <button className="text-button" type="button" onClick={handleOpenTenantInspector} disabled={!activeTenant}>
            Inspect tenant
          </button>
        </div>
      }
    >
      <form className="tenant-search-form" onSubmit={handleFilterSubmit} style={{ marginBottom: '1.25rem' }}>
        <label>
          Tenant ID
          <input
            value={filterDraft.tenantId}
            onChange={(event) =>
              setFilterDraft((prev) => ({
                ...prev,
                tenantId: event.target.value,
              }))
            }
            placeholder="tenant_abc123"
          />
        </label>
        <label>
          Months
          <select
            value={String(filterDraft.months)}
            onChange={(event) =>
              setFilterDraft((prev) => ({
                ...prev,
                months: Number(event.target.value) || DEFAULT_FILTERS.months,
              }))
            }
          >
            {HISTORY_MONTH_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option} months
              </option>
            ))}
          </select>
        </label>
        <div className="tenant-search-actions">
          <button className="primary-button" type="submit" disabled={!filterDraft.tenantId.trim()}>
            Load analytics
          </button>
          <button className="text-button" type="button" onClick={handleFilterReset}>
            Reset
          </button>
        </div>
      </form>

      {summaryError && (
        <div className="tenant-error" style={{ marginBottom: '1rem' }}>
          <strong>Summary issue:</strong> {summaryError}
        </div>
      )}
      {historyError && (
        <div className="tenant-error" style={{ marginBottom: '1rem' }}>
          <strong>History issue:</strong> {historyError}
        </div>
      )}
      {!activeTenant && <p className="muted">Provide a tenant ID to view analytics.</p>}

      {summaryLoading && <p className="muted small-text">Loading usage snapshot…</p>}
      {historyLoading && <p className="muted small-text">Fetching trend data…</p>}

      {summaryCards.length > 0 && (
        <div className="stat-grid" style={{ marginTop: '1rem' }}>
          {summaryCards.map((card) => (
            <StatCard
              key={card.key}
              icon={card.icon}
              title={card.title}
              value={<span className="stat-value">{card.value}</span>}
              subtitle={`${card.subtitle} · ${card.delta}`}
              badge={card.badge}
              trend={card.trend}
            />
          ))}
        </div>
      )}

      {summary && (
        <div className="muted small-text" style={{ marginTop: '1rem' }}>
          <p>
            Plan {summary.planLimits?.label || summary.planId} · Metrics version {summary.metricsVersion ?? '1'} · Last refreshed{' '}
            {summary.lastRefreshedAt ? new Date(summary.lastRefreshedAt).toLocaleString() : 'unknown'}
          </p>
        </div>
      )}

      {orderedHistory.length > 0 && (
        <div className="chart-grid" style={{ marginTop: '1.5rem' }}>
          <div className="chart-card">
            <header>
              <p>Headcount trend</p>
              <span className="muted">Students vs staff</span>
            </header>
            <div className="chart-wrapper">
              <ResponsiveContainer>
                <AreaChart data={chartData} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <YAxis tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }} labelStyle={{ fontWeight: 600 }} />
                  <Area type="monotone" dataKey="students" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.25} strokeWidth={3} name="Students" />
                  <Area type="monotone" dataKey="staff" stroke="#f472b6" fill="#f472b6" fillOpacity={0.2} strokeWidth={2} name="Staff" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="chart-card">
            <header>
              <p>Communication load</p>
              <span className="muted">Reminders by channel & storage footprint</span>
            </header>
            <div className="chart-wrapper">
              <ResponsiveContainer>
                <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} />
                  <YAxis yAxisId="left" tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }} allowDecimals={false} />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tickFormatter={(value: number) => `${value} GB`}
                    tick={{ fill: 'rgba(248,250,252,0.6)', fontSize: 10 }}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)' }}
                    labelStyle={{ fontWeight: 600 }}
                    formatter={(value: number, name: string) => {
                      if (name === 'Storage GB') {
                        return [`${value} GB`, 'Storage'] as [string, string];
                      }
                      return [formatNumber(value), name];
                    }}
                  />
                  <Area
                    yAxisId="left"
                    type="monotone"
                    dataKey="remindersTotal"
                    stroke="#facc15"
                    fill="#facc15"
                    fillOpacity={0.3}
                    strokeWidth={3}
                    name="Reminders"
                  />
                  <Area yAxisId="left" type="monotone" dataKey="remindersWhatsApp" stroke="#60a5fa" fillOpacity={0.15} name="WhatsApp" />
                  <Area yAxisId="left" type="monotone" dataKey="remindersSms" stroke="#fb7185" fillOpacity={0.15} name="SMS" />
                  <Area yAxisId="left" type="monotone" dataKey="remindersEmail" stroke="#34d399" fillOpacity={0.15} name="Email" />
                  <Line yAxisId="right" type="monotone" dataKey="storageGb" stroke="#34d399" name="Storage GB" strokeWidth={2} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <div className="tenant-membership-actions" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <strong>Monthly breakdown</strong>
            <button className="text-button" onClick={handleExportHistory} type="button" disabled={exporting}>
              <Download size={14} /> Export CSV
            </button>
          </div>
          <div className="tenant-table-wrapper">
            <table className="table tenant-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Students</th>
                  <th>Staff</th>
                  <th>Reminders</th>
                  <th>Storage</th>
                  <th>Notice posts</th>
                  <th>Device actions</th>
                  <th>Chat messages</th>
                </tr>
              </thead>
              <tbody>
                {history.map((point) => (
                  <tr key={point.month}>
                    <td>{point.month}</td>
                    <td>
                      {formatNumber(point.students)}
                      {point.studentsAdded ? <span className="muted small-text"> · +{formatNumber(point.studentsAdded)} added</span> : null}
                    </td>
                    <td>{formatNumber(point.staff)}</td>
                    <td>
                      {formatNumber(point.remindersTotal)}
                      <p className="muted small-text">
                        WA {formatNumber(point.remindersWhatsApp ?? 0)} · SMS {formatNumber(point.remindersSms ?? 0)} · Email {formatNumber(point.remindersEmail ?? 0)}
                      </p>
                    </td>
                    <td>{formatStorage(point.storageBytes)}</td>
                    <td>{formatNumber(point.noticePosts ?? 0)}</td>
                    <td>{formatNumber(point.deviceActions ?? 0)}</td>
                    <td>{point.chatMessages === null ? '—' : formatNumber(point.chatMessages ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {renderAlerts(summary?.alerts)}
      {renderStorageSources(summary?.storageSources)}
      {renderDiagnostics(summary)}

      {summary?.lastRefreshedAt && (
        <p className="muted small-text" style={{ marginTop: '0.5rem' }}>
          Snapshot last refreshed {new Date(summary.lastRefreshedAt).toLocaleString()}
        </p>
      )}
    </SectionCard>
  );
}
