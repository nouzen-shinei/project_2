import React, { useMemo, useCallback } from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, Share } from 'react-native';
import type { Tenant } from '@/types';
import type {
  UsageSummaryResponse,
  UsageHistoryPoint,
  UsageMetricKey,
  UsageAlertRecord,
} from '@/types/usage';
import { useTheme } from '../hooks/useTheme';

interface AdminUsageModalProps {
  visible: boolean;
  onClose: () => void;
  tenant: Tenant | null;
  tenantMembersCount: number;
  pendingJoinRequests: number;
  usageSummary: UsageSummaryResponse | null;
  usageLoading: boolean;
  usageError: string | null;
  onRefreshUsage?: () => void | Promise<void>;
  usageLastUpdated?: Date | null;
  usageHistory?: UsageHistoryPoint[] | null;
  usageHistoryLoading?: boolean;
  usageHistoryError?: string | null;
  usageHistoryLastUpdated?: Date | null;
  onRefreshUsageHistory?: () => void | Promise<void>;
  onAcknowledgeAlert?: (alertId: string) => void | Promise<void>;
  acknowledgingAlertId?: string | null;
  onRequestUsageRegeneration?: () => void | Promise<void>;
  requestingUsageRegeneration?: boolean;
}

type HistoryChartMetricKey = 'reminders' | 'students' | 'chat' | 'storage';

interface HistoryChartPoint {
  month: string;
  monthLabel: string;
  shortLabel: string;
  reminders: number;
  students: number;
  chat: number;
  storage: number;
}

const metricLabelByKey: Record<UsageMetricKey, string> = {
  students: 'Students',
  staff: 'Staff seats',
  reminders: 'Reminders',
  storage: 'Storage',
};

const formatUsageWindow = (monthId?: string | null) => {
  if (!monthId) {
    return null;
  }
  const [yearStr, monthStr] = monthId.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) {
    return null;
  }
  const windowStart = new Date(year, monthIndex, 1);
  const windowEnd = new Date(year, monthIndex + 1, 0);
  const startLabel = windowStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const endLabel = windowEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${startLabel} – ${endLabel}`;
};

const formatHistoryMonthLabel = (monthId?: string | null) => {
  if (!monthId) {
    return 'Unknown month';
  }
  const [yearStr, monthStr] = monthId.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) {
    return monthId;
  }
  const date = new Date(year, monthIndex, 1);
  if (Number.isNaN(date.getTime())) {
    return monthId;
  }
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
};

const formatTimestampLabel = (timestamp?: string | null) => {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getTimestampMs = (timestamp?: string | null) => {
  if (!timestamp) {
    return 0;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 0;
  }
  return date.getTime();
};

const formatCount = (value: number | null | undefined) => {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return value.toLocaleString();
  }
  return '—';
};

const formatStorageMbValue = (value: number | null | undefined) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—';
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} GB`;
  }
  return `${value.toLocaleString()} MB`;
};

const formatStorageBytesValue = (value: number | null | undefined) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '—';
  }
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  const mb = value / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
};

const computeAlertPercentage = (alert: UsageAlertRecord) => {
  if (typeof alert.ratio === 'number' && Number.isFinite(alert.ratio)) {
    return Math.round(alert.ratio * 100);
  }
  if (
    typeof alert.value === 'number'
    && Number.isFinite(alert.value)
    && typeof alert.limit === 'number'
    && Number.isFinite(alert.limit)
    && alert.limit > 0
  ) {
    return Math.round((alert.value / alert.limit) * 100);
  }
  return null;
};

const formatAlertMetricValue = (metric: UsageMetricKey, value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (metric === 'storage') {
    return formatStorageBytesValue(value);
  }
  return value.toLocaleString();
};

const describeAlert = (alert: UsageAlertRecord) => {
  const metricLabel = metricLabelByKey[alert.metric] ?? alert.metric;
  const percentage = computeAlertPercentage(alert);
  const valueLabel = formatAlertMetricValue(alert.metric, alert.value);
  const limitLabel = formatAlertMetricValue(alert.metric, alert.limit);

  if (percentage !== null && valueLabel && limitLabel) {
    return `${percentage}% of ${metricLabel} quota (${valueLabel} / ${limitLabel})`;
  }
  if (valueLabel && limitLabel) {
    return `${valueLabel} used of ${limitLabel}`;
  }
  if (valueLabel) {
    return `${valueLabel} ${metricLabel.toLowerCase()} used`;
  }
  return `Monitoring ${metricLabel.toLowerCase()} usage`;
};

const AdminUsageModal: React.FC<AdminUsageModalProps> = ({
  visible,
  onClose,
  tenant,
  tenantMembersCount,
  pendingJoinRequests,
  usageSummary,
  usageLoading,
  usageError,
  onRefreshUsage,
  usageLastUpdated,
  usageHistory,
  usageHistoryLoading = false,
  usageHistoryError,
  usageHistoryLastUpdated,
  onRefreshUsageHistory,
  onAcknowledgeAlert,
  acknowledgingAlertId,
  onRequestUsageRegeneration,
  requestingUsageRegeneration = false,
}) => {
  const { theme } = useTheme();

  const usageLastUpdatedLabel = useMemo(() => {
    if (!usageLastUpdated) {
      return null;
    }
    return usageLastUpdated.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [usageLastUpdated]);

  const usageHistoryLastUpdatedLabel = useMemo(() => {
    if (!usageHistoryLastUpdated) {
      return null;
    }
    return usageHistoryLastUpdated.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }, [usageHistoryLastUpdated]);

  const usageWindowLabel = useMemo(() => formatUsageWindow(usageSummary?.month), [usageSummary?.month]);

  const effectivePlanLimits = useMemo(() => {
    return usageSummary?.planLimits ?? null;
  }, [usageSummary?.planLimits]);

  const quotaLimits = useMemo(
    () => ({
      maxStudents: tenant?.quotas?.maxStudents ?? effectivePlanLimits?.students ?? null,
      maxStaff: tenant?.quotas?.maxStaff ?? effectivePlanLimits?.staffSeats ?? null,
      maxMonthlyReminders: tenant?.quotas?.maxMonthlyReminders ?? effectivePlanLimits?.reminders?.total ?? null,
      maxStorageMb:
        tenant?.quotas?.maxStorageMb ??
        (typeof effectivePlanLimits?.storageBytes === 'number'
          ? Math.round(effectivePlanLimits.storageBytes / (1024 * 1024))
          : null),
    }),
    [
      tenant?.quotas?.maxStudents,
      tenant?.quotas?.maxStaff,
      tenant?.quotas?.maxMonthlyReminders,
      tenant?.quotas?.maxStorageMb,
      effectivePlanLimits?.students,
      effectivePlanLimits?.staffSeats,
      effectivePlanLimits?.reminders?.total,
      effectivePlanLimits?.storageBytes,
    ],
  );

  const quotaMetrics = useMemo(
    () => {
      const staffBreakdown = usageSummary?.staffBreakdown;
      const staffHelper = staffBreakdown
        ? `Owners, admins, and staff with panel access. Active: ${formatCount(staffBreakdown.active)} · Pending invites: ${formatCount(staffBreakdown.pendingInvites)}`
        : 'Owners, admins, and staff with panel access.';

      const reminderValue = usageLoading
        ? `Loading… / ${formatCount(quotaLimits.maxMonthlyReminders)}`
        : `${formatCount(usageSummary?.reminders?.total)} / ${formatCount(quotaLimits.maxMonthlyReminders)}`;
      const reminderHelper = usageWindowLabel
        ? `Tracking ${usageWindowLabel}`
        : usageSummary
          ? 'Current calendar month.'
          : 'Usage data unavailable.';

      const studentValue = usageSummary
        ? `${formatCount(usageSummary.students)} / ${formatCount(quotaLimits.maxStudents)}`
        : `— / ${formatCount(quotaLimits.maxStudents)}`;

      const storageUsageMb = usageSummary ? Math.round((usageSummary.storageBytes || 0) / (1024 * 1024)) : null;
      const storageValue = usageSummary
        ? `${formatStorageMbValue(storageUsageMb)} / ${formatStorageMbValue(quotaLimits.maxStorageMb)}`
        : `— / ${formatStorageMbValue(quotaLimits.maxStorageMb)}`;
      const storageHelper = usageSummary?.storageSources?.length
        ? `Top sources: ${usageSummary.storageSources
            .slice(0, 2)
            .map((source) => `${source.label}`)
            .join(', ')}${usageSummary.storageSources.length > 2 ? '…' : ''}`
        : 'Connect media uploads to monitor storage.';

      return [
        {
          key: 'team',
          label: 'Team Seats',
          value: `${formatCount(usageSummary?.staff ?? tenantMembersCount)} / ${formatCount(quotaLimits.maxStaff)}`,
          helper: staffHelper,
        },
        {
          key: 'reminders',
          label: 'Monthly Reminders',
          value: reminderValue,
          helper: reminderHelper,
        },
        {
          key: 'students',
          label: 'Student Capacity',
          value: studentValue,
          helper: 'Active students counted toward plan limits.',
        },
        {
          key: 'storage',
          label: 'Storage Usage',
          value: storageValue,
          helper: storageHelper,
        },
      ];
    },
    [usageLoading, usageSummary, tenantMembersCount, quotaLimits, usageWindowLabel],
  );

  const historyRows = useMemo(() => {
    if (!usageHistory || usageHistory.length === 0) {
      return [] as {
        month: string;
        monthLabel: string;
        reminders: string;
        staff: string;
        students: string;
        chat: string;
        storage: string;
      }[];
    }
    return usageHistory.map((point) => {
      const storageMb = typeof point.storageBytes === 'number' ? Math.round(point.storageBytes / (1024 * 1024)) : null;
      return {
        month: point.month,
        monthLabel: formatHistoryMonthLabel(point.month),
        reminders: formatCount(point.remindersTotal),
        staff: formatCount(point.staff),
        students: formatCount(point.students),
        chat: formatCount(point.chatMessages),
        storage: formatStorageMbValue(storageMb),
      };
    });
  }, [usageHistory]);

  const historyChartSeries = useMemo<HistoryChartPoint[]>(() => {
    if (!usageHistory || usageHistory.length === 0) {
      return [];
    }
    const sorted = [...usageHistory].sort((a, b) => {
      if (!a.month || !b.month) {
        return 0;
      }
      return a.month.localeCompare(b.month);
    });
    const windowed = sorted.slice(-6);
    return windowed.map((point) => {
      const monthValue = point.month ?? 'unknown';
      const storageMb = typeof point.storageBytes === 'number'
        ? Math.max(0, Math.round(point.storageBytes / (1024 * 1024)))
        : 0;
      const monthLabel = formatHistoryMonthLabel(monthValue);
      const [shortLabel] = monthLabel.split(' ');
      return {
        month: monthValue,
        monthLabel,
        shortLabel: shortLabel || monthLabel,
        reminders: Math.max(0, point.remindersTotal ?? 0),
        students: Math.max(0, point.students ?? 0),
        chat: Math.max(0, point.chatMessages ?? 0),
        storage: storageMb,
      } satisfies HistoryChartPoint;
    });
  }, [usageHistory]);

  const historyChartMaxima = useMemo<Record<HistoryChartMetricKey, number>>(() => {
    return historyChartSeries.reduce<Record<HistoryChartMetricKey, number>>((acc, point) => {
      acc.reminders = Math.max(acc.reminders, point.reminders);
      acc.students = Math.max(acc.students, point.students);
      acc.chat = Math.max(acc.chat, point.chat);
      acc.storage = Math.max(acc.storage, point.storage);
      return acc;
    }, {
      reminders: 0,
      students: 0,
      chat: 0,
      storage: 0,
    });
  }, [historyChartSeries]);

  const latestHistoryChartPoint = historyChartSeries.length
    ? historyChartSeries[historyChartSeries.length - 1]
    : null;

  const chartMetricConfigs = useMemo(
    () => [
      {
        key: 'reminders' as const,
        label: 'Reminders sent',
        color: theme.primary,
        format: (value: number) => formatCount(value),
      },
      {
        key: 'students' as const,
        label: 'Active students',
        color: theme.success,
        format: (value: number) => formatCount(value),
      },
      {
        key: 'chat' as const,
        label: 'Chat messages',
        color: theme.warning,
        format: (value: number) => formatCount(value),
      },
      {
        key: 'storage' as const,
        label: 'Storage (MB)',
        color: theme.text,
        format: (value: number) => formatStorageMbValue(value),
      },
    ],
    [theme.primary, theme.success, theme.warning, theme.text],
  );

  const canExportHistory = !!(usageHistory && usageHistory.length > 0);

  const handleExportUsageHistory = useCallback(() => {
    if (!usageHistory || usageHistory.length === 0) {
      return;
    }
    const header = ['Month', 'Reminders', 'Staff', 'Students', 'Chat Messages', 'Storage (MB)'];
    const csvLines = [
      header.join(','),
      ...usageHistory.map((point) => {
        const storageMb = typeof point.storageBytes === 'number'
          ? Math.max(0, Math.round(point.storageBytes / (1024 * 1024)))
          : '';
        return [
          point.month ?? '',
          point.remindersTotal ?? '',
          point.staff ?? '',
          point.students ?? '',
          point.chatMessages ?? '',
          storageMb,
        ].join(',');
      }),
    ].join('\n');

    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const blob = new Blob([csvLines], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `tenant-usage-${tenant?.id ?? 'history'}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }

    Share.share({
      title: 'Tenant usage history (CSV)',
      message: csvLines,
    }).catch((shareError) => {
      console.warn('Usage history export failed', shareError);
    });
  }, [tenant?.id, usageHistory]);

  const { activeAlerts, acknowledgedAlerts } = useMemo(() => {
    const alerts = usageSummary?.alerts ?? [];
    const activeRaw = alerts.filter((alert) => !alert.acknowledgedAt);

    // Backend should avoid duplicates, but concurrent rollups or data backfills can produce
    // multiple open alerts for the same metric + severity. De-dupe for display clarity.
    const deduped = new Map<string, UsageAlertRecord>();
    for (const alert of activeRaw) {
      const key = `${String(alert.metric)}:${String(alert.type)}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, alert);
        continue;
      }
      const existingTime = getTimestampMs(existing.createdAt);
      const nextTime = getTimestampMs(alert.createdAt);
      if (nextTime >= existingTime) {
        deduped.set(key, alert);
      }
    }

    const active = Array.from(deduped.values()).sort((a, b) => {
      const weight = (type: UsageAlertRecord['type']) => (type === 'critical' ? 2 : type === 'warning' ? 1 : 0);
      const delta = weight(b.type) - weight(a.type);
      if (delta !== 0) return delta;
      return getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt);
    });
    const acknowledged = alerts
      .filter((alert) => !!alert.acknowledgedAt)
      .sort((a, b) => {
        const aTime = getTimestampMs(a.acknowledgedAt || a.createdAt);
        const bTime = getTimestampMs(b.acknowledgedAt || b.createdAt);
        return bTime - aTime;
      });
    return { activeAlerts: active, acknowledgedAlerts: acknowledged };
  }, [usageSummary?.alerts]);

  const hasAlerts = activeAlerts.length > 0 || acknowledgedAlerts.length > 0;
  const acknowledgingId = acknowledgingAlertId ?? null;
  const alertTypeLabel: Record<UsageAlertRecord['type'], string> = {
    critical: 'Critical alert',
    warning: 'Warning alert',
    info: 'Information',
  };
  const getAlertAccentColor = (type: UsageAlertRecord['type']) => {
    if (type === 'critical') {
      return theme.error;
    }
    if (type === 'warning') {
      return theme.warning;
    }
    return theme.primary;
  };

  return (
    <Modal
      visible={visible}
      transparent={true}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContent, { backgroundColor: theme.surface }]}> 
          <Text style={[styles.modalTitle, { color: theme.text }]}>Usage & Quotas</Text>
          <Text style={[styles.modalSubheading, { color: theme.textSecondary }]}>
            {tenant?.name || 'Current coaching center'}
          </Text>
          {(usageLastUpdatedLabel || onRefreshUsage || onRequestUsageRegeneration) && (
            <View style={styles.modalMetaRow}>
              {!!usageLastUpdatedLabel && (
                <Text style={[styles.modalMetaText, { color: theme.textSecondary }]}> 
                  Updated {usageLastUpdatedLabel}
                </Text>
              )}
              {(onRefreshUsage || onRequestUsageRegeneration) && (
                <View style={styles.modalMetaActions}>
                  {onRequestUsageRegeneration && (
                    <TouchableOpacity
                      style={[
                        styles.forceRefreshButton,
                        { borderColor: theme.border },
                        requestingUsageRegeneration && styles.forceRefreshButtonDisabled,
                      ]}
                      onPress={() => {
                        if (!requestingUsageRegeneration) {
                          void onRequestUsageRegeneration();
                        }
                      }}
                      disabled={requestingUsageRegeneration}
                    >
                      <Text
                        style={[
                          styles.forceRefreshButtonText,
                          { color: requestingUsageRegeneration ? theme.textSecondary : theme.primary },
                        ]}
                      >
                        {requestingUsageRegeneration ? 'Requesting…' : 'Force regenerate'}
                      </Text>
                    </TouchableOpacity>
                  )}
                  {onRefreshUsage && (
                    <TouchableOpacity
                      style={styles.refreshButton}
                      onPress={() => {
                        void onRefreshUsage();
                      }}
                    >
                      <Text style={[styles.refreshButtonText, { color: theme.primary }]}>Refresh</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
            </View>
          )}

          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: Platform.select({ web: 0, default: 10 }) },
            ]}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: theme.textSecondary }]}>Billing Tier</Text>
              <Text style={[styles.metaValue, { color: theme.text }]}>{tenant?.billingTier ?? '—'}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: theme.textSecondary }]}>Tenant Status</Text>
              <Text style={[styles.metaValue, { color: theme.text }]}>{tenant?.status ?? '—'}</Text>
            </View>
            <View style={styles.metaRow}>
              <Text style={[styles.metaLabel, { color: theme.textSecondary }]}>Pending Join Requests</Text>
              <Text style={[styles.metaValue, { color: theme.text }]}>{pendingJoinRequests}</Text>
            </View>
            {!tenant && (
              <Text style={[styles.metaError, { color: theme.error }]}>
                Select a coaching center to view usage details.
              </Text>
            )}
            {usageError && (
              <Text style={[styles.metaError, { color: theme.error }]}>{usageError}</Text>
            )}

            <View style={styles.metricsContainer}>
              {quotaMetrics.map((metric) => (
                <View
                  key={metric.key}
                  style={[styles.metricCard, { borderColor: theme.border, backgroundColor: theme.background }]}
                >
                  <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>{metric.label}</Text>
                  <Text style={[styles.metricValue, { color: theme.text }]}>{metric.value}</Text>
                  {!!metric.helper && (
                    <Text style={[styles.metricHelper, { color: theme.textSecondary }]}>{metric.helper}</Text>
                  )}
                </View>
              ))}
            </View>

            {hasAlerts && (
              <View style={styles.alertSection}>
                <View style={styles.alertHeaderRow}>
                  <Text style={[styles.alertTitle, { color: theme.text }]}>Usage alerts</Text>
                  <Text style={[styles.alertHeaderMeta, { color: theme.textSecondary }]}>
                    {activeAlerts.length ? `${activeAlerts.length} open` : 'All caught up'}
                  </Text>
                </View>

                {activeAlerts.length === 0 && (
                  <Text style={[styles.alertEmptyState, { color: theme.textSecondary }]}> 
                    No open alerts. Threshold notifications will appear here when usage spikes.
                  </Text>
                )}

                {activeAlerts.map((alert) => {
                  const accent = getAlertAccentColor(alert.type);
                  const acknowledging = acknowledgingId === alert.id;
                  const createdLabel = formatTimestampLabel(alert.createdAt);
                  return (
                    <View
                      key={alert.id}
                      style={[styles.alertCard, { borderColor: accent, backgroundColor: theme.background }]}
                    >
                      <View style={styles.alertCardBody}>
                        <View style={styles.alertBadgeRow}>
                          <View style={[styles.alertBadge, { backgroundColor: accent }]}>
                            <Text style={styles.alertBadgeText}>{alertTypeLabel[alert.type] ?? 'Alert'}</Text>
                          </View>
                          <Text style={[styles.alertMetricLabel, { color: theme.text }]}>
                            {metricLabelByKey[alert.metric] ?? alert.metric}
                          </Text>
                        </View>
                        <Text style={[styles.alertDescription, { color: theme.text }]}>{describeAlert(alert)}</Text>
                        {!!createdLabel && (
                          <Text style={[styles.alertMeta, { color: theme.textSecondary }]}>Triggered {createdLabel}</Text>
                        )}
                      </View>
                      {onAcknowledgeAlert && (
                        <TouchableOpacity
                          style={[styles.alertAckButton, { backgroundColor: acknowledging ? theme.border : theme.primary }]}
                          disabled={acknowledging}
                          onPress={() => {
                            if (!acknowledging) {
                              void onAcknowledgeAlert(alert.id);
                            }
                          }}
                        >
                          <Text style={styles.alertAckButtonText}>{acknowledging ? 'Saving…' : 'Acknowledge'}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}

                {acknowledgedAlerts.length > 0 && (
                  <View style={[styles.alertHistorySection, { borderColor: theme.border }]}> 
                    <Text style={[styles.alertHistoryTitle, { color: theme.textSecondary }]}>Recently acknowledged</Text>
                    {acknowledgedAlerts.slice(0, 3).map((alert) => (
                      <View key={`${alert.id}-ack`} style={styles.alertHistoryRow}>
                        <Text style={[styles.alertHistoryLabel, { color: theme.text }]}>
                          {metricLabelByKey[alert.metric] ?? alert.metric}
                        </Text>
                        <Text style={[styles.alertHistoryMeta, { color: theme.textSecondary }]}> 
                          {formatTimestampLabel(alert.acknowledgedAt) || '—'}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            )}

            <View style={styles.historySection}>
              <View style={styles.historyHeaderRow}>
                <View>
                  <Text style={[styles.historyTitle, { color: theme.text }]}>Usage history</Text>
                  {!!usageHistoryLastUpdatedLabel && (
                    <Text style={[styles.historySubtitle, { color: theme.textSecondary }]}> 
                      Updated {usageHistoryLastUpdatedLabel}
                    </Text>
                  )}
                </View>
                <View style={styles.historyActionRow}>
                  {onRefreshUsageHistory && (
                    <TouchableOpacity
                      style={[styles.historyRefreshButton, { borderColor: theme.primary }]}
                      onPress={() => {
                        void onRefreshUsageHistory();
                      }}
                    >
                      <Text style={[styles.historyRefreshText, { color: theme.primary }]}>Refresh</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[
                      styles.historyExportButton,
                      { borderColor: theme.border, opacity: canExportHistory ? 1 : 0.6 },
                    ]}
                    disabled={!canExportHistory}
                    onPress={handleExportUsageHistory}
                  >
                    <Text style={[styles.historyExportText, { color: theme.text }]}>Export CSV</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {usageHistoryLoading && (
                <Text style={[styles.historyHint, { color: theme.textSecondary }]}>Fetching history…</Text>
              )}
              {usageHistoryError && (
                <Text style={[styles.historyError, { color: theme.error }]}>{usageHistoryError}</Text>
              )}
              {!usageHistoryLoading && !usageHistoryError && historyRows.length === 0 && (
                <Text style={[styles.historyHint, { color: theme.textSecondary }]}> 
                  Usage history appears after at least one rollup cycle.
                </Text>
              )}

              {historyChartSeries.length > 0 && (
                <View
                  style={[
                    styles.historyChartContainer,
                    { borderColor: theme.border, backgroundColor: theme.background },
                  ]}
                >
                  <Text style={[styles.historyChartTitle, { color: theme.textSecondary }]}> 
                    Last {historyChartSeries.length} months overview
                  </Text>
                  <View style={styles.historyChartGrid}>
                    {chartMetricConfigs.map((config) => {
                      const latestValue = latestHistoryChartPoint
                        ? latestHistoryChartPoint[config.key]
                        : 0;
                      return (
                        <View
                          key={config.key}
                          style={[
                            styles.historyChartCard,
                            { backgroundColor: theme.surface, borderColor: theme.border },
                          ]}
                        >
                          <View style={styles.historyChartCardHeader}>
                            <Text style={[styles.historyChartLabel, { color: theme.textSecondary }]}>
                              {config.label}
                            </Text>
                            <Text style={[styles.historyChartValue, { color: theme.text }]}>
                              {config.format(latestValue)}
                            </Text>
                          </View>
                          <View style={styles.historyChartBars}>
                            {historyChartSeries.map((point) => {
                              const value = point[config.key];
                              const maxValue = historyChartMaxima[config.key] || 1;
                              const barHeight = maxValue > 0 ? Math.max(6, (value / maxValue) * 60) : 6;
                              const isLatestPoint = point.month === latestHistoryChartPoint?.month;
                              return (
                                <View key={`${config.key}-${point.month}`} style={styles.historyChartBarWrapper}>
                                  <View
                                    style={[
                                      styles.historyChartBar,
                                      {
                                        height: barHeight,
                                        backgroundColor: config.color,
                                        opacity: isLatestPoint ? 1 : 0.45,
                                      },
                                    ]}
                                  />
                                  <Text style={[styles.historyChartBarLabel, { color: theme.textSecondary }]}>
                                    {point.shortLabel}
                                  </Text>
                                </View>
                              );
                            })}
                          </View>
                        </View>
                      );
                    })}
                  </View>
                </View>
              )}

              {historyRows.map((row) => (
                <View
                  key={row.month}
                  style={[styles.historyRow, { borderColor: theme.border, backgroundColor: theme.background }]}
                >
                  <Text style={[styles.historyMonthText, { color: theme.text }]}>{row.monthLabel}</Text>
                  <View style={styles.historyMetricRow}>
                    <Text style={[styles.historyMetricText, { color: theme.text }]}>Reminders: {row.reminders}</Text>
                    <Text style={[styles.historyMetricText, { color: theme.text }]}>Staff: {row.staff}</Text>
                  </View>
                  <View style={styles.historyMetricRow}>
                    <Text style={[styles.historyMetricText, { color: theme.text }]}>Students: {row.students}</Text>
                    <Text style={[styles.historyMetricText, { color: theme.text }]}>Chat: {row.chat}</Text>
                  </View>
                  <Text style={[styles.historyStorageText, { color: theme.textSecondary }]}>Storage: {row.storage}</Text>
                </View>
              ))}
            </View>
          </ScrollView>

          <TouchableOpacity
            style={[styles.closeButton, { backgroundColor: theme.primary }]}
            onPress={onClose}
          >
            <Text style={styles.closeButtonText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  modalContent: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 16,
    padding: 20,
    maxHeight: '60%',
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    textAlign: 'center',
  },
  modalSubheading: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginTop: 6,
  },
  modalMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  modalMetaActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  modalMetaText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  refreshButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  forceRefreshButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  forceRefreshButtonDisabled: {
    opacity: 0.6,
  },
  refreshButtonText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  forceRefreshButtonText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  scrollArea: {
    marginTop: 16,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  metaLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metaValue: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  metaError: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 6,
  },
  metricsContainer: {
    marginTop: 12,
    gap: 12,
  },
  metricCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  metricLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metricValue: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 6,
  },
  metricHelper: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 6,
  },
  alertSection: {
    marginTop: 20,
    gap: 12,
  },
  alertHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  alertTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  alertHeaderMeta: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
  },
  alertEmptyState: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  alertCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 8,
  },
  alertCardBody: {
    gap: 6,
  },
  alertBadgeRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  alertBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  alertBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    color: '#ffffff',
    textTransform: 'uppercase',
  },
  alertMetricLabel: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  alertDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  alertMeta: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  alertAckButton: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  alertAckButtonText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    color: '#ffffff',
  },
  alertHistorySection: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  alertHistoryTitle: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
  },
  alertHistoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  alertHistoryLabel: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
  alertHistoryMeta: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  historySection: {
    marginTop: 20,
    gap: 12,
  },
  historyHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  historyActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  historyTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  historySubtitle: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  historyRefreshButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  historyRefreshText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  historyExportButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  historyExportText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  historyHint: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  historyError: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  historyChartContainer: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  historyChartTitle: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  historyChartGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  historyChartCard: {
    flexBasis: '48%',
    flexGrow: 1,
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
  },
  historyChartCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  historyChartLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
  },
  historyChartValue: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 4,
  },
  historyChartBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
    marginTop: 12,
  },
  historyChartBarWrapper: {
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  historyChartBar: {
    width: 10,
    borderRadius: 6,
  },
  historyChartBarLabel: {
    fontSize: 10,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  historyRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 6,
  },
  historyMonthText: {
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
  },
  historyMetricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  historyMetricText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
  historyStorageText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  closeButton: {
    marginTop: 16,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    color: '#ffffff',
  },
});

export default AdminUsageModal;
