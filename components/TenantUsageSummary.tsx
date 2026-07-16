import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRouter } from 'expo-router';
import { RefreshCw } from 'lucide-react-native';
import Toast from 'react-native-toast-message';

import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import useStudents from '@/hooks/useStudents';
import { useTenantUsageSummary } from '@/hooks/useTenantUsageSummary';
import { usageAnalyticsService } from '@/services/usageAnalyticsService';
import { normalizeTenantNotificationPreferences, tenantService } from '@/services/tenantService';
import { logger } from '@/lib/logger';
import type { ThemeColors } from '@/types/theme';
import type { UsageAlertRecord, UsageMetricKey, UsageSummaryResponse } from '@/types/usage';

const getUsageMeta = (percent: number, themeColors: ThemeColors) => {
  if (percent >= 100) {
    return { color: themeColors.error, label: 'Limit reached' };
  }
  if (percent >= 85) {
    return { color: themeColors.warning, label: 'Close to limit' };
  }
  return { color: themeColors.primary, label: 'Within quota' };
};

const metricLabelByKey: Record<UsageMetricKey, string> = {
  students: 'Students',
  staff: 'Team seats',
  reminders: 'Monthly reminders',
  storage: 'Storage',
};

const formatAlertValue = (metric: UsageMetricKey, value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (metric === 'storage') {
    const gb = value / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    }
    const mb = value / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }
  return value.toLocaleString();
};

const describeAlertBriefly = (alert: UsageAlertRecord) => {
  const label = metricLabelByKey[alert.metric] ?? alert.metric;
  const valueLabel = formatAlertValue(alert.metric, alert.value);
  const limitLabel = formatAlertValue(alert.metric, alert.limit);
  if (valueLabel && limitLabel) {
    return `${valueLabel} of ${limitLabel}`;
  }
  if (valueLabel) {
    return `${valueLabel} used`;
  }
  return `Monitoring ${label.toLowerCase()} usage`;
};

const getAlertPercentage = (alert: UsageAlertRecord) => {
  if (typeof alert.ratio === 'number' && Number.isFinite(alert.ratio)) {
    return Math.round(alert.ratio * 100);
  }
  if (
    typeof alert.value === 'number'
    && typeof alert.limit === 'number'
    && Number.isFinite(alert.value)
    && Number.isFinite(alert.limit)
    && alert.limit > 0
  ) {
    return Math.round((alert.value / alert.limit) * 100);
  }
  return null;
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

const getTimestampMs = (value?: string | null) => {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

interface UsageRowProps {
  label: string;
  valueLabel: string;
  percent: number;
  loading?: boolean;
  helper?: string;
  action?: React.ReactNode;
  theme: ThemeColors;
}

const UsageRow = ({ label, valueLabel, percent, loading, helper, action, theme }: UsageRowProps) => {
  const meta = getUsageMeta(percent, theme);
  return (
    <View style={[styles.usageRow, { borderColor: theme.border }]}> 
      <View style={{ flex: 1 }}>
        <Text style={[styles.usageLabel, { color: theme.text }]}>{label}</Text>
        {helper ? <Text style={[styles.usageHelper, { color: theme.textSecondary }]}>{helper}</Text> : null}
      </View>
      <View style={styles.usageValueWrapper}>
        <View style={styles.usageValueMeta}>
          {loading ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <Text style={[styles.usageValue, { color: theme.text }]}>{valueLabel}</Text>
          )}
          <Text style={[styles.usageMeta, { color: meta.color }]}>{meta.label}</Text>
        </View>
        {action ? <View>{action}</View> : null}
      </View>
      <View style={[styles.progressTrack, { backgroundColor: `${theme.border}80` }]}> 
        <View
          style={[styles.progressFill, { width: `${Math.min(percent, 100)}%`, backgroundColor: meta.color }]}
        />
      </View>
    </View>
  );
};

type TenantUsageSummaryProps = {
  onUpgradePress?: () => void;
  onReconcileStorageUsage?: () => void;
  reconcilingStorage?: boolean;
  allowNonAdminMembers?: boolean;
  usageData?: {
    usageSummary: UsageSummaryResponse | null;
    loading: boolean;
    error: string | null;
    lastUpdated: Date | null;
    refresh: () => Promise<void>;
  };
};

const TenantUsageSummary = ({
  onUpgradePress,
  onReconcileStorageUsage,
  reconcilingStorage,
  allowNonAdminMembers,
  usageData,
}: TenantUsageSummaryProps) => {
  const { theme } = useTheme();
  const router = useRouter();
  const { activeTenant, activeMembership, memberships, applyTenantNotificationPreferencesSnapshot } = useTenant();
  const { students, loading: studentsLoading } = useStudents();
  const [alertsExpanded, setAlertsExpanded] = useState(false);

  const internalUsage = useTenantUsageSummary(
    activeTenant?.id ?? null,
    undefined,
    { enabled: !usageData }
  );

  const usageSummary = usageData?.usageSummary ?? internalUsage.usageSummary;
  const usageSummaryLoading = usageData?.loading ?? internalUsage.loading;
  const usageSummaryError = usageData?.error ?? internalUsage.error;
  const usageLastUpdated = usageData?.lastUpdated ?? internalUsage.lastUpdated;
  const refreshUsageSummary = usageData?.refresh ?? internalUsage.refresh;

  const canView = useMemo(() => {
    if (allowNonAdminMembers) {
      return true;
    }
    if (!activeMembership) {
      return false;
    }
    return activeMembership.role === 'owner' || activeMembership.role === 'admin';
  }, [activeMembership, allowNonAdminMembers]);

  const activeAlerts = useMemo(() => {
    const alerts = usageSummary?.alerts ?? [];
    if (!alerts.length) {
      return [] as UsageAlertRecord[];
    }

    const activeRaw = alerts.filter((alert) => !alert.acknowledgedAt);

    // Backend should avoid duplicates, but concurrent rollups/backfills can still temporarily
    // produce multiple open alerts for the same metric + severity. De-dupe for display clarity.
    const deduped = new Map<string, UsageAlertRecord>();
    for (const alert of activeRaw) {
      const key = `${String(alert.metric)}:${String(alert.type)}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, alert);
        continue;
      }

      const nextTime = getTimestampMs(alert.createdAt);
      const existingTime = getTimestampMs(existing.createdAt);
      if (nextTime >= existingTime) {
        deduped.set(key, alert);
      }
    }

    return Array.from(deduped.values());
  }, [usageSummary?.alerts]);

  const sortedAlerts = useMemo(() => {
    if (!activeAlerts.length) {
      return [] as UsageAlertRecord[];
    }
    return [...activeAlerts].sort((a, b) => {
      if (a.type === b.type) {
        const aRatio = a.ratio ?? 0;
        const bRatio = b.ratio ?? 0;
        return bRatio - aRatio;
      }
      if (a.type === 'critical') return -1;
      if (b.type === 'critical') return 1;
      return 0;
    });
  }, [activeAlerts]);

  const highlightedAlert = useMemo(() => {
    if (!sortedAlerts.length) {
      return null;
    }
    return sortedAlerts[0];
  }, [sortedAlerts]);

  const effectivePlanLimits = usageSummary?.planLimits ?? null;
  const quotas = {
    maxStudents: activeTenant?.quotas?.maxStudents ?? effectivePlanLimits?.students ?? null,
    maxStaff: activeTenant?.quotas?.maxStaff ?? effectivePlanLimits?.staffSeats ?? null,
    maxMonthlyReminders:
      activeTenant?.quotas?.maxMonthlyReminders ?? effectivePlanLimits?.reminders?.total ?? null,
    maxStorageMb:
      activeTenant?.quotas?.maxStorageMb ??
      (typeof effectivePlanLimits?.storageBytes === 'number'
        ? Math.round(effectivePlanLimits.storageBytes / (1024 * 1024))
        : null),
  };

  const staffCount = useMemo(() => {
    if (typeof usageSummary?.staff === 'number') {
      return usageSummary.staff;
    }
    if (!activeTenant) {
      return 0;
    }
    const scopedSeatMemberships = memberships.filter(
      (membership) =>
        membership.tenantId === activeTenant.id
        && membership.status === 'active'
        && (membership.role === 'owner' || membership.role === 'admin' || membership.role === 'staff'),
    );
    if (scopedSeatMemberships.length) {
      return scopedSeatMemberships.length;
    }
    const counts = activeTenant.membershipCounts;
    if (counts && typeof counts.owners === 'number' && typeof counts.admins === 'number' && typeof counts.staff === 'number') {
      return counts.owners + counts.admins + counts.staff;
    }
    return 0;
  }, [usageSummary?.staff, memberships, activeTenant?.id, activeTenant?.membershipCounts]);

  const studentCount = usageSummary?.students ?? students.length;

  const studentPercent =
    typeof quotas.maxStudents === 'number' && Number.isFinite(quotas.maxStudents) && quotas.maxStudents > 0
      ? Math.round((studentCount / quotas.maxStudents) * 100)
      : 0;
  const staffPercent =
    typeof quotas.maxStaff === 'number' && Number.isFinite(quotas.maxStaff) && quotas.maxStaff > 0
      ? Math.round((staffCount / quotas.maxStaff) * 100)
      : 0;
  const reminderCount = usageSummary?.reminders?.total ?? 0;
  const reminderPercent =
    typeof quotas.maxMonthlyReminders === 'number'
    && Number.isFinite(quotas.maxMonthlyReminders)
    && quotas.maxMonthlyReminders > 0
      ? Math.round((reminderCount / quotas.maxMonthlyReminders) * 100)
      : 0;

  const storageUsedBytes = typeof usageSummary?.storageBytes === 'number' && Number.isFinite(usageSummary.storageBytes)
    ? usageSummary.storageBytes
    : 0;
  const storageLimitBytes =
    typeof quotas.maxStorageMb === 'number' && Number.isFinite(quotas.maxStorageMb) && quotas.maxStorageMb > 0
      ? quotas.maxStorageMb * 1024 * 1024
      : 0;
  const storagePercent = storageLimitBytes
    ? Math.round((storageUsedBytes / storageLimitBytes) * 100)
    : storageUsedBytes > 0
      ? 100
      : 0;
  const storageUsedLabel = formatAlertValue('storage', storageUsedBytes) ?? `${storageUsedBytes} B`;
  const storageLimitLabel = storageLimitBytes > 0
    ? (formatAlertValue('storage', storageLimitBytes) ?? `${storageLimitBytes} B`)
    : null;
  const storageValueLabel = storageLimitLabel ? `${storageUsedLabel}/${storageLimitLabel}` : storageUsedLabel;

  const usageWindowLabel = useMemo(() => formatUsageWindow(usageSummary?.month), [usageSummary?.month]);

  const reminderHelper = useMemo(() => {
    if (usageSummaryError) {
      return usageSummaryError;
    }
    if (!usageSummary) {
      return 'Usage tracking unavailable';
    }
    const baseLabel = usageWindowLabel ? `Tracking ${usageWindowLabel}` : 'Current month usage';
    if (!usageLastUpdated) {
      return baseLabel;
    }
    return `${baseLabel} · Updated ${usageLastUpdated.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
    })}`;
  }, [usageSummary, usageWindowLabel, usageLastUpdated, usageSummaryError]);

  const canManagePlan = useMemo(() => {
    const role = activeMembership?.role;
    return role === 'owner' || role === 'admin';
  }, [activeMembership?.role]);

  const [acknowledgingAlertId, setAcknowledgingAlertId] = useState<string | null>(null);
  const [usageAlertEmailEnabled, setUsageAlertEmailEnabled] = useState(true);
  const [usageAlertPushEnabled, setUsageAlertPushEnabled] = useState(true);
  const [updatingPreferenceKey, setUpdatingPreferenceKey] = useState<'usageAlertEmail' | 'usageAlertPush' | null>(null);

  useEffect(() => {
    const normalized = normalizeTenantNotificationPreferences(activeTenant?.notificationPreferences);
    setUsageAlertEmailEnabled(normalized.usageAlertEmail);
    setUsageAlertPushEnabled(normalized.usageAlertPush);
  }, [activeTenant?.id, activeTenant?.notificationPreferences]);

  const handleAcknowledgeAlert = useCallback(async (alertIdRaw?: string | null) => {
    const alertId = alertIdRaw?.trim();
    const tenantId = activeTenant?.id?.trim();
    if (!canManagePlan || !alertId || !tenantId) {
      return;
    }
    if (acknowledgingAlertId === alertId) {
      return;
    }

    setAcknowledgingAlertId(alertId);
    try {
      await usageAnalyticsService.acknowledgeUsageAlert(alertId, tenantId);
      await refreshUsageSummary();
      Toast.show({ type: 'success', text1: 'Alert acknowledged' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to acknowledge alert.';
      logger.warn('TenantUsageSummary: usage alert acknowledgement failed', error);
      Toast.show({ type: 'error', text1: 'Alert acknowledgement failed', text2: message });
    } finally {
      setAcknowledgingAlertId((current) => (current === alertId ? null : current));
    }
  }, [activeTenant?.id, acknowledgingAlertId, canManagePlan, refreshUsageSummary]);

  const handleToggleUsageAlertPreference = useCallback(async (
    key: 'usageAlertEmail' | 'usageAlertPush',
    nextValue: boolean,
  ) => {
    const tenantId = activeTenant?.id?.trim();
    if (!canManagePlan || !tenantId) {
      return;
    }
    if (updatingPreferenceKey === key) {
      return;
    }

    setUpdatingPreferenceKey(key);
    const previousEmail = usageAlertEmailEnabled;
    const previousPush = usageAlertPushEnabled;
    if (key === 'usageAlertEmail') {
      setUsageAlertEmailEnabled(nextValue);
    } else {
      setUsageAlertPushEnabled(nextValue);
    }

    try {
      // Server-mediated (security-rules-hardening C1): tenant notification
      // preferences are owned by the backend (`tenants` is backend-only write).
      // These usage-alert toggles are tenant-level and gated to owner/admin.
      const { notificationPreferences: updatedPrefs } = await tenantService.updateNotificationPreferences({
        tenantId,
        notificationPreferences: { [key]: nextValue },
        metadata: {
          initiatedFrom: Platform.OS === 'web' ? 'web' : 'mobile',
          reason: 'usage_alert_preference_toggled',
        },
      });

      applyTenantNotificationPreferencesSnapshot(tenantId, updatedPrefs);
    } catch (error) {
      setUsageAlertEmailEnabled(previousEmail);
      setUsageAlertPushEnabled(previousPush);
      const message = error instanceof Error ? error.message : 'Unable to update preference.';
      logger.warn('TenantUsageSummary: failed to update usage alert preference', error);
      Toast.show({ type: 'error', text1: 'Preference update failed', text2: message });
    } finally {
      setUpdatingPreferenceKey(null);
    }
  }, [
    activeTenant?.id,
    activeTenant?.notificationPreferences,
    activeMembership?.id,
    applyTenantNotificationPreferencesSnapshot,
    canManagePlan,
    updatingPreferenceKey,
    usageAlertEmailEnabled,
    usageAlertPushEnabled,
  ]);

  const showUpgradeCta = canManagePlan && (studentPercent >= 90 || staffPercent >= 90 || reminderPercent >= 90);

  if (!activeTenant || !canView) {
    return null;
  }

  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}> 
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.text }]}>Usage & quotas</Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>Stay under plan limits</Text>
        {usageSummaryError ? (
          <Text style={[styles.errorText, { color: theme.error }]}>{usageSummaryError}</Text>
        ) : null}
      </View>
      {canManagePlan ? (
        <View style={[styles.preferenceCard, { borderColor: theme.border }]}> 
          <Text style={[styles.preferenceTitle, { color: theme.text }]}>Your usage alert channels</Text>
          <View style={styles.preferenceRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.preferenceLabel, { color: theme.text }]}>Email alerts</Text>
              <Text style={[styles.preferenceHelper, { color: theme.textSecondary }]}>Receive usage limit alerts by email for your account</Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                void handleToggleUsageAlertPreference('usageAlertEmail', !usageAlertEmailEnabled);
              }}
              style={[
                styles.preferenceToggle,
                {
                  borderColor: usageAlertEmailEnabled ? theme.primary : theme.border,
                  backgroundColor: usageAlertEmailEnabled ? `${theme.primary}1A` : theme.surface,
                  opacity: updatingPreferenceKey === 'usageAlertEmail' ? 0.7 : 1,
                },
              ]}
              disabled={updatingPreferenceKey === 'usageAlertEmail'}
              accessibilityRole="button"
              accessibilityLabel="Toggle usage alert email notifications"
            >
              {updatingPreferenceKey === 'usageAlertEmail' ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Text style={[styles.preferenceToggleText, { color: usageAlertEmailEnabled ? theme.primary : theme.textSecondary }]}> 
                  {usageAlertEmailEnabled ? 'On' : 'Off'}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={[styles.preferenceRow, { borderTopColor: `${theme.border}70` }]}> 
            <View style={{ flex: 1 }}>
              <Text style={[styles.preferenceLabel, { color: theme.text }]}>Push alerts</Text>
              <Text style={[styles.preferenceHelper, { color: theme.textSecondary }]}>Receive usage limit alerts as push notifications on your devices</Text>
            </View>
            <TouchableOpacity
              onPress={() => {
                void handleToggleUsageAlertPreference('usageAlertPush', !usageAlertPushEnabled);
              }}
              style={[
                styles.preferenceToggle,
                {
                  borderColor: usageAlertPushEnabled ? theme.primary : theme.border,
                  backgroundColor: usageAlertPushEnabled ? `${theme.primary}1A` : theme.surface,
                  opacity: updatingPreferenceKey === 'usageAlertPush' ? 0.7 : 1,
                },
              ]}
              disabled={updatingPreferenceKey === 'usageAlertPush'}
              accessibilityRole="button"
              accessibilityLabel="Toggle usage alert push notifications"
            >
              {updatingPreferenceKey === 'usageAlertPush' ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Text style={[styles.preferenceToggleText, { color: usageAlertPushEnabled ? theme.primary : theme.textSecondary }]}> 
                  {usageAlertPushEnabled ? 'On' : 'Off'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      {highlightedAlert && (
        <View
          style={[
            styles.alertBanner,
            {
              borderColor: highlightedAlert.type === 'critical' ? theme.error : theme.warning,
              backgroundColor: highlightedAlert.type === 'critical' ? `${theme.error}15` : `${theme.warning}15`,
            },
          ]}
        >
          <Text style={[styles.alertBannerTitle, { color: theme.text }]}>Usage alert</Text>
          <Text style={[styles.alertBannerMetric, { color: theme.text }]}> 
            {metricLabelByKey[highlightedAlert.metric] ?? highlightedAlert.metric}
            {(() => {
              const percent = getAlertPercentage(highlightedAlert);
              return percent !== null ? ` · ${percent}%` : '';
            })()}
          </Text>
          <Text style={[styles.alertBannerHelper, { color: theme.textSecondary }]}> 
            {describeAlertBriefly(highlightedAlert)}
          </Text>

          {canManagePlan && (
            <TouchableOpacity
              onPress={() => {
                void handleAcknowledgeAlert(highlightedAlert.id);
              }}
              style={[
                styles.alertAckButton,
                {
                  borderColor: highlightedAlert.type === 'critical' ? theme.error : theme.warning,
                  opacity: acknowledgingAlertId === highlightedAlert.id ? 0.7 : 1,
                },
              ]}
              disabled={acknowledgingAlertId === highlightedAlert.id}
              accessibilityRole="button"
              accessibilityLabel="Acknowledge usage alert"
            >
              {acknowledgingAlertId === highlightedAlert.id ? (
                <ActivityIndicator
                  size="small"
                  color={highlightedAlert.type === 'critical' ? theme.error : theme.warning}
                />
              ) : null}
              <Text
                style={[
                  styles.alertAckButtonText,
                  { color: highlightedAlert.type === 'critical' ? theme.error : theme.warning },
                ]}
              >
                Acknowledge
              </Text>
            </TouchableOpacity>
          )}
          {sortedAlerts.length > 1 && !alertsExpanded && (
            <Text style={[styles.alertBannerFooter, { color: theme.textSecondary }]}> 
              +{sortedAlerts.length - 1} other alert{sortedAlerts.length > 2 ? 's' : ''}
            </Text>
          )}

          {sortedAlerts.length > 1 && (
            <TouchableOpacity
              onPress={() => setAlertsExpanded((prev) => !prev)}
              style={styles.alertToggle}
              accessibilityRole="button"
              accessibilityLabel={alertsExpanded ? 'Hide usage alerts' : 'Show all usage alerts'}
            >
              <Text style={[styles.alertToggleText, { color: theme.textSecondary }]}> 
                {alertsExpanded ? 'Hide alerts' : `Show all alerts (${sortedAlerts.length})`}
              </Text>
            </TouchableOpacity>
          )}

          {alertsExpanded && sortedAlerts.length > 1 && (
            <View style={[styles.alertList, { borderTopColor: `${theme.border}80` }]}> 
              {sortedAlerts.map((alert, index) => {
                const metricLabel = metricLabelByKey[alert.metric] ?? alert.metric;
                const percent = getAlertPercentage(alert);
                const severityColor = alert.type === 'critical' ? theme.error : theme.warning;
                const key = alert.id || `${alert.metric}-${alert.type}-${index}`;
                return (
                  <View
                    key={key}
                    style={[
                      styles.alertListItem,
                      index > 0 && { borderTopColor: `${theme.border}60`, borderTopWidth: 1 },
                    ]}
                  >
                    <Text style={[styles.alertListTitle, { color: theme.text }]}> 
                      {metricLabel}
                      {percent !== null ? ` · ${percent}%` : ''}
                      {alert.type === 'critical' ? ' · Limit' : ' · Warning'}
                    </Text>
                    <Text style={[styles.alertListHelper, { color: theme.textSecondary }]}> 
                      {describeAlertBriefly(alert)}
                    </Text>
                    {canManagePlan && alert.id ? (
                      <TouchableOpacity
                        onPress={() => {
                          void handleAcknowledgeAlert(alert.id);
                        }}
                        style={[
                          styles.alertAckButton,
                          {
                            marginTop: 6,
                            borderColor: severityColor,
                            opacity: acknowledgingAlertId === alert.id ? 0.7 : 1,
                          },
                        ]}
                        disabled={acknowledgingAlertId === alert.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Acknowledge ${metricLabel} usage alert`}
                      >
                        {acknowledgingAlertId === alert.id ? (
                          <ActivityIndicator size="small" color={severityColor} />
                        ) : null}
                        <Text style={[styles.alertAckButtonText, { color: severityColor }]}>Acknowledge</Text>
                      </TouchableOpacity>
                    ) : null}
                    <View style={[styles.alertSeverityBar, { backgroundColor: `${severityColor}55` }]} />
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}
      <UsageRow
        label="Students"
        valueLabel={`${studentCount}/${quotas.maxStudents}`}
        percent={studentPercent}
        loading={studentsLoading && !usageSummary}
        helper="Total active students tracked in this workspace"
        theme={theme}
      />
      <UsageRow
        label="Team seats"
        valueLabel={`${staffCount}/${quotas.maxStaff}`}
        percent={staffPercent}
        helper={
          usageSummary?.staffBreakdown
            ? `Owners, admins, and staff members count toward the seat limit. Active: ${usageSummary.staffBreakdown.active} · Pending invites: ${usageSummary.staffBreakdown.pendingInvites}`
            : 'Owners, admins, and staff members count toward the seat limit'
        }
        theme={theme}
      />
      <UsageRow
        label="Monthly reminders"
        valueLabel={`${reminderCount}/${quotas.maxMonthlyReminders}`}
        percent={reminderPercent}
        loading={usageSummaryLoading}
        helper={reminderHelper}
        theme={theme}
      />
      <UsageRow
        label="Storage"
        valueLabel={storageValueLabel}
        percent={storagePercent}
        loading={usageSummaryLoading}
        helper="Storage used by uploaded media in this workspace"
        action={
          canManagePlan && onReconcileStorageUsage ? (
            <TouchableOpacity
              style={[
                styles.inlineActionButton,
                {
                  borderColor: theme.border,
                  backgroundColor: theme.surface,
                  opacity: reconcilingStorage ? 0.7 : 1,
                },
              ]}
              disabled={!!reconcilingStorage}
              onPress={onReconcileStorageUsage}
            >
              {reconcilingStorage ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <RefreshCw size={14} color={theme.textSecondary} />
              )}
              <Text style={[styles.inlineActionText, { color: theme.textSecondary }]}>
                {reconcilingStorage ? 'Reconciling…' : 'Reconcile'}
              </Text>
            </TouchableOpacity>
          ) : null
        }
        theme={theme}
      />
      {showUpgradeCta && (
        <TouchableOpacity
          style={[styles.ctaButton, { borderColor: theme.primary }]}
          onPress={() => (onUpgradePress ? onUpgradePress() : router.push('/(tabs)/plan'))}
        >
          <Text style={[styles.ctaButtonText, { color: theme.primary }]}>Need more capacity? Upgrade</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 16,
  },
  header: {
    gap: 4,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 13,
  },
  errorText: {
    fontSize: 12,
  },
  preferenceCard: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  preferenceTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  preferenceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  preferenceLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  preferenceHelper: {
    fontSize: 12,
  },
  preferenceToggle: {
    minWidth: 64,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  preferenceToggleText: {
    fontSize: 12,
    fontWeight: '700',
  },
  alertBanner: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  alertToggle: {
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  alertToggleText: {
    fontSize: 12,
    fontWeight: '600',
  },
  alertList: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    gap: 10,
  },
  alertListItem: {
    gap: 4,
    paddingTop: 10,
  },
  alertListTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  alertListHelper: {
    fontSize: 12,
  },
  alertSeverityBar: {
    height: 3,
    borderRadius: 999,
    marginTop: 4,
  },
  alertBannerTitle: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  alertBannerMetric: {
    fontSize: 14,
    fontWeight: '600',
  },
  alertBannerHelper: {
    fontSize: 12,
  },
  alertBannerFooter: {
    fontSize: 11,
    fontWeight: '600',
  },
  alertAckButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  alertAckButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  usageRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
  usageLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  usageHelper: {
    fontSize: 12,
  },
  usageValueWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  usageValueMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  usageValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  usageMeta: {
    fontSize: 12,
    fontWeight: '600',
  },
  inlineActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  inlineActionText: {
    fontSize: 12,
    fontWeight: '600',
  },
  progressTrack: {
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
  },
  ctaButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
  },
  ctaButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
});

export default TenantUsageSummary;
