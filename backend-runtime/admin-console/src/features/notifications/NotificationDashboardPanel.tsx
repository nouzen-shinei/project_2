import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BellRing, Download, RefreshCcw, Target, Users } from 'lucide-react';
import { SectionCard } from '../../components/SectionCard';
import {
  fetchNotificationHistory,
  fetchNotificationStats,
  type NotificationHistoryEntry,
  type NotificationStatsResponse,
} from '../../lib/apiClient';
import { formatNumber } from '../../lib/metrics';

type FilterState = {
  tenantId: string;
  adminEmail: string;
  days: number;
};

type TenantInspectorLinkDetail = {
  tenantId: string;
  focus?: 'audit';
  searchTerm?: string;
};

const createDefaultFilters = (): FilterState => ({
  tenantId: '',
  adminEmail: '',
  days: 30,
});

const formatDateTime = (value?: string) => {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
};

const summarizeReasons = (entry: NotificationHistoryEntry) => {
  const summary = entry.failureReasonSummary;
  if (!summary) {
    return entry.failedDeliveries ? 'Failures recorded but no summary attached.' : '—';
  }
  const top = Object.entries(summary)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 3);
  if (!top.length) {
    return entry.failedDeliveries ? 'Failures recorded but no summary attached.' : '—';
  }
  return top.map(([reason, count]) => `${reason}: ${formatNumber(count)}`).join(' · ');
};

const percentLabel = (value?: number) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '0%';
  }
  return `${value.toFixed(1)}%`;
};

const escapeCsvValue = (value: unknown) => {
  if (value === undefined || value === null) return '""';
  const stringValue = String(value).replace(/"/g, '""');
  return `"${stringValue}"`;
};

const sanitizeFileSegment = (value?: string) => {
  if (!value) return 'all-tenants';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'all-tenants';
  return normalized.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
};

const buildHistoryExportFileName = (filters: FilterState) => {
  const tenantSegment = sanitizeFileSegment(filters.tenantId || 'all');
  const windowSegment = `${filters.days || 30}d`;
  return `notification-history-${tenantSegment}-${windowSegment}-${Date.now()}.csv`;
};

const downloadCsvContent = (content: string, fileName: string) => {
  if (typeof window === 'undefined') {
    console.warn('[NotificationDashboardPanel] CSV export unavailable (no window context)');
    return;
  }
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  window.document.body.appendChild(link);
  link.click();
  window.document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
};

export function NotificationDashboardPanel() {
  const [filterDraft, setFilterDraft] = useState<FilterState>(() => createDefaultFilters());
  const [filters, setFilters] = useState<FilterState>(() => createDefaultFilters());
  const [stats, setStats] = useState<NotificationStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [history, setHistory] = useState<NotificationHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [statsNonce, setStatsNonce] = useState(0);
  const [historyNonce, setHistoryNonce] = useState(0);
  const [exporting, setExporting] = useState(false);

  const activeTenantLabel = filters.tenantId ? `Tenant ${filters.tenantId}` : 'All tenants';

  const openTenantInspector = useCallback(
    (tenantId?: string | null, options?: { focus?: 'audit'; searchTerm?: string }) => {
      if (!tenantId || typeof window === 'undefined') return;
      const detail: TenantInspectorLinkDetail = {
        tenantId,
        focus: options?.focus,
        searchTerm: options?.searchTerm,
      };
      window.dispatchEvent(new CustomEvent<TenantInspectorLinkDetail>('tenant-inspector:open', { detail }));
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setStatsLoading(true);
    setStatsError(null);
    fetchNotificationStats({
      tenantId: filters.tenantId || undefined,
      adminEmail: filters.adminEmail || undefined,
      days: filters.days,
    })
      .then((payload) => {
        if (!cancelled) {
          setStats(payload);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (err instanceof Error) {
            setStatsError(err.message);
          } else {
            setStatsError('Unable to load notification stats.');
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStatsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filters, statsNonce]);

  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setHistoryCursor(null);
    setHistoryHasMore(false);
    setHistoryError(null);
    setHistoryLoading(true);
    fetchNotificationHistory({
      tenantId: filters.tenantId || undefined,
      adminEmail: filters.adminEmail || undefined,
      limit: 50,
    })
      .then((payload) => {
        if (!cancelled) {
          setHistory(payload.entries);
          setHistoryCursor(payload.hasMore ? payload.nextCursor ?? null : null);
          setHistoryHasMore(payload.hasMore);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (err instanceof Error) {
            setHistoryError(err.message);
          } else {
            setHistoryError('Unable to load notification history.');
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
  }, [filters, historyNonce]);

  const handleLoadMore = useCallback(async () => {
    if (!historyHasMore || historyLoading) {
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const payload = await fetchNotificationHistory({
        tenantId: filters.tenantId || undefined,
        adminEmail: filters.adminEmail || undefined,
        limit: 50,
        cursor: historyCursor || undefined,
      });
      setHistory((prev) => [...prev, ...payload.entries]);
      setHistoryCursor(payload.hasMore ? payload.nextCursor ?? null : null);
      setHistoryHasMore(payload.hasMore);
    } catch (err) {
      if (err instanceof Error) {
        setHistoryError(err.message);
      } else {
        setHistoryError('Unable to load additional history.');
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [filters.adminEmail, filters.tenantId, historyCursor, historyHasMore, historyLoading]);

  const handleFilterSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters({ ...filterDraft });
  };

  const handleFilterReset = () => {
    const defaults = createDefaultFilters();
    setFilterDraft(defaults);
    setFilters(defaults);
  };

  const handleRefresh = () => {
    setStatsNonce((value) => value + 1);
    setHistoryNonce((value) => value + 1);
  };

  const handleExportCsv = async () => {
    if (typeof window === 'undefined') {
      console.warn('[NotificationDashboardPanel] CSV export unavailable (no window context)');
      return;
    }
    if (history.length === 0) {
      window.alert('Load notification history before exporting.');
      return;
    }
    try {
      setExporting(true);
      const columns = [
        { key: 'sentAt', label: 'Sent At' },
        { key: 'tenant', label: 'Tenant' },
        { key: 'tenantId', label: 'Tenant ID' },
        { key: 'adminEmail', label: 'Admin Email' },
        { key: 'adminName', label: 'Admin Name' },
        { key: 'type', label: 'Type' },
        { key: 'priority', label: 'Priority' },
        { key: 'deliveryMethod', label: 'Delivery Method' },
        { key: 'totalTargets', label: 'Total Targets' },
        { key: 'successfulDeliveries', label: 'Successful' },
        { key: 'failedDeliveries', label: 'Failed' },
        { key: 'successRate', label: 'Success %' },
        { key: 'failureSummary', label: 'Failure Summary' },
      ];

      const headerLine = columns.map((column) => escapeCsvValue(column.label)).join(',');
      const lines = history.map((entry) => {
        const successRate = entry.totalTargets
          ? ((entry.successfulDeliveries / entry.totalTargets) * 100).toFixed(1)
          : '0.0';
        const row: Record<string, string | number> = {
          sentAt: formatDateTime(entry.sentAt ?? entry.createdAt ?? undefined),
          tenant: entry.tenantName || entry.tenantId || 'Unknown tenant',
          tenantId: entry.tenantId || '—',
          adminEmail: entry.adminEmail || '—',
          adminName: entry.adminName || '—',
          type: entry.type,
          priority: entry.priority,
          deliveryMethod: entry.deliveryMethod || '—',
          totalTargets: entry.totalTargets,
          successfulDeliveries: entry.successfulDeliveries,
          failedDeliveries: entry.failedDeliveries,
          successRate: `${successRate}%`,
          failureSummary: summarizeReasons(entry),
        };
        return columns.map((column) => escapeCsvValue(row[column.key])).join(',');
      });

      const metadataLines = [
        `${escapeCsvValue('Tenant Filter')},${escapeCsvValue(filters.tenantId || 'All tenants')}`,
        `${escapeCsvValue('Admin Filter')},${escapeCsvValue(filters.adminEmail || 'Any admin')}`,
        `${escapeCsvValue('Time Window')},${escapeCsvValue(`${filters.days || 30} days`)}`,
        `${escapeCsvValue('Exported At')},${escapeCsvValue(new Date().toISOString())}`,
        '',
      ];

      const csvContent = [...metadataLines, headerLine, ...lines].join('\n');
      downloadCsvContent(csvContent, buildHistoryExportFileName(filters));
    } catch (error) {
      console.error('[NotificationDashboardPanel] CSV export failed', error);
      window.alert('Failed to export notification history. Check console for details.');
    } finally {
      setExporting(false);
    }
  };

  const summaryCards = useMemo(
    () => [
      {
        title: 'Notifications sent',
        value: formatNumber(stats?.totalNotifications ?? 0),
        subtitle: stats?.startDate ? `Since ${new Date(stats.startDate).toLocaleDateString()}` : 'Window start unknown',
        icon: <BellRing size={20} />,
      },
      {
        title: 'Recipients reached',
        value: formatNumber(stats?.totalRecipients ?? 0),
        subtitle: `${formatNumber(stats?.successfulRecipients ?? 0)} successful · ${formatNumber(stats?.failedRecipients ?? 0)} failed`,
        icon: <Users size={20} />,
      },
      {
        title: 'Success rate',
        value: percentLabel(stats?.averageSuccessRate),
        subtitle: stats?.lastSentAt ? `Last sent ${formatDateTime(stats.lastSentAt)}` : 'No sends in range',
        icon: <Target size={20} />,
      },
      {
        title: 'Failure signals',
        value: formatNumber(stats?.failedRecipients ?? 0),
        subtitle:
          stats && stats.totalRecipients > 0
            ? `${percentLabel((stats.failedRecipients / stats.totalRecipients) * 100)} of recipients`
            : 'No failures recorded',
        icon: <AlertTriangle size={20} />,
      },
    ],
    [stats],
  );

  const tenantBreakdown = useMemo(() => stats?.tenantBreakdown ?? [], [stats]);
  const failureReasons = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.failureReasons || {})
      .sort((a, b) => (b[1] || 0) - (a[1] || 0))
      .slice(0, 6);
  }, [stats]);

  const typeChips = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.notificationsByType || {}).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  }, [stats]);

  const priorityChips = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.notificationsByPriority || {}).sort((a, b) => (b[1] || 0) - (a[1] || 0));
  }, [stats]);

  return (
    <SectionCard
      title="Notification dashboard"
      description={`${activeTenantLabel} · ${filters.days}-day lookback across delivery channels.`}
    >
      <form className="notification-filter-grid" onSubmit={handleFilterSubmit}>
        <label>
          Tenant ID (optional)
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
          Admin email (optional)
          <input
            type="email"
            value={filterDraft.adminEmail}
            onChange={(event) =>
              setFilterDraft((prev) => ({
                ...prev,
                adminEmail: event.target.value,
              }))
            }
            placeholder="ops@example.com"
          />
        </label>
        <label>
          Time window
          <select
            value={String(filterDraft.days)}
            onChange={(event) =>
              setFilterDraft((prev) => ({
                ...prev,
                days: Number(event.target.value) || 30,
              }))
            }
          >
            <option value="7">Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <div className="tenant-membership-filter-actions">
          <button className="primary-button" type="submit">
            Apply filters
          </button>
          <button type="button" className="text-button" onClick={handleFilterReset}>
            <RefreshCcw size={14} /> Reset
          </button>
          <button type="button" className="text-button" onClick={handleRefresh}>
            <RefreshCcw size={14} /> Refresh data
          </button>
          <button
            type="button"
            className="text-button"
            onClick={handleExportCsv}
            disabled={exporting || history.length === 0}
          >
            {exporting ? (
              <span>Preparing CSV…</span>
            ) : (
              <>
                <Download size={14} /> Export CSV
              </>
            )}
          </button>
        </div>
      </form>

      {statsError && (
        <div className="tenant-error">
          <strong>Stats error:</strong> {statsError}
        </div>
      )}

      <div className="stat-grid">
        {summaryCards.map((card) => (
          <div className="stat-card" key={card.title}>
            <div className="stat-card__header">
              <div className="stat-card__title-group">
                <span className="stat-card__icon">{card.icon}</span>
                <span className="stat-card__title">{card.title}</span>
              </div>
            </div>
            <div className="stat-card__value stat-value">{card.value}</div>
            <p className="stat-card__subtitle">{card.subtitle}</p>
          </div>
        ))}
      </div>

      {(typeChips.length > 0 || priorityChips.length > 0) && (
        <div className="notification-chip-grid">
          {typeChips.length > 0 && (
            <div>
              <p className="muted small-text">By type</p>
              <div className="notification-chip-group">
                {typeChips.map(([label, count]) => (
                  <span key={label} className="notification-chip">
                    {label}: {formatNumber(count)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {priorityChips.length > 0 && (
            <div>
              <p className="muted small-text">By priority</p>
              <div className="notification-chip-group">
                {priorityChips.map(([label, count]) => (
                  <span key={label} className="notification-chip">
                    {label}: {formatNumber(count)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="chart-grid">
        <div className="chart-card">
          <header>
            <strong>Top tenants</strong>
            <span className="muted small-text">Most active in window</span>
          </header>
          {tenantBreakdown.length === 0 && <p className="muted small-text">No tenant activity recorded.</p>}
          {tenantBreakdown.length > 0 && (
            <ul className="notification-trend-list">
              {tenantBreakdown.map((tenant) => (
                <li key={tenant.tenantId}>
                  <div>
                    <strong>{tenant.tenantName || tenant.tenantId}</strong>
                    <p className="muted small-text">
                      {formatNumber(tenant.count)} sends · {formatNumber(tenant.failedDeliveries)} failures
                    </p>
                    <button
                      type="button"
                      className="text-button small-link"
                      onClick={() => openTenantInspector(tenant.tenantId)}
                    >
                      Inspect tenant
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="chart-card">
          <header>
            <strong>Failure reasons</strong>
            <span className="muted small-text">Top signals</span>
          </header>
          {failureReasons.length === 0 && <p className="muted small-text">No recent failure reasons logged.</p>}
          {failureReasons.length > 0 && (
            <ul className="notification-trend-list">
              {failureReasons.map(([reason, count]) => (
                <li key={reason}>
                  <div>
                    <strong>{reason}</strong>
                    <p className="muted small-text">{formatNumber(count)} occurrences</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <header className="tenant-invite-header">
        <div>
          <h3>Recent deliveries</h3>
          <p className="muted small-text">
            {history.length} entries loaded · {historyHasMore ? 'scroll for more' : 'end of window'}
          </p>
        </div>
        <div className="tenant-membership-actions">
          <button type="button" className="text-button" onClick={handleRefresh} disabled={historyLoading}>
            <RefreshCcw size={14} /> Refresh
          </button>
        </div>
      </header>

      {historyError && (
        <div className="tenant-error">
          <strong>History error:</strong> {historyError}
        </div>
      )}

      {history.length === 0 && !historyLoading && !historyError && (
        <p className="muted">No notifications found for that filter set.</p>
      )}

      {history.length > 0 && (
        <div className="tenant-membership-table-wrapper">
          <table className="table notification-history-table">
            <thead>
              <tr>
                <th style={{ width: '32%' }}>Notification</th>
                <th style={{ width: '20%' }}>Tenant</th>
                <th style={{ width: '24%' }}>Delivery</th>
                <th style={{ width: '24%' }}>Failures</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>{entry.title}</strong>
                    <p className="muted small-text">{entry.type} · {entry.deliveryMethod || 'mixed'} · Admin {entry.adminEmail || entry.adminName || 'unknown'}</p>
                    <p className="muted small-text">Sent {formatDateTime(entry.sentAt)}</p>
                    <span className={`badge priority-${(entry.priority || 'normal').toLowerCase()}`}>
                      {entry.priority || 'normal'} priority
                    </span>
                  </td>
                  <td>
                    <p>{entry.tenantName || entry.tenantId || '—'}</p>
                    <p className="muted small-text">{entry.onlineOnly ? 'Online only' : 'All members'}</p>
                    <button
                      type="button"
                      className="text-button small-link"
                      onClick={() => openTenantInspector(entry.tenantId, { focus: 'audit' })}
                    >
                      Inspect tenant
                    </button>
                  </td>
                  <td>
                    <p className="muted small-text">
                      {formatNumber(entry.successfulDeliveries)} of{' '}
                      {formatNumber(
                        typeof entry.totalTargets === 'number' && entry.totalTargets > 0
                          ? entry.totalTargets
                          : entry.successfulDeliveries + entry.failedDeliveries
                      )}{' '}
                      succeeded
                    </p>
                    <p className="muted small-text">Failed: {formatNumber(entry.failedDeliveries)}</p>
                  </td>
                  <td>
                    <p className="muted small-text">{summarizeReasons(entry)}</p>
                    <button
                      type="button"
                      className="text-button small-link"
                      onClick={() =>
                        openTenantInspector(entry.tenantId, {
                          focus: 'audit',
                          searchTerm: entry.adminEmail || entry.title || entry.id,
                        })
                      }
                    >
                      View audit logs
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {historyHasMore && (
        <div className="tenant-membership-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="primary-button" type="button" onClick={handleLoadMore} disabled={historyLoading}>
            {historyLoading ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}

      {historyLoading && <p className="muted small-text">Loading notification data…</p>}
    </SectionCard>
  );
}
