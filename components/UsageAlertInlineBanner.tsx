import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import type { UsageAlertRecord, UsageMetricKey } from '@/types/usage';
import { useTheme } from '@/hooks/useTheme';

interface UsageAlertInlineBannerProps {
  alert: UsageAlertRecord | null;
  totalAlerts: number;
  loading?: boolean;
  error?: string | null;
  monthLabel?: string | null;
  onPress?: () => void;
  onRefresh?: () => void;
  horizontalInset?: number;
}

const metricLabelByKey: Record<UsageMetricKey, string> = {
  students: 'Students',
  staff: 'Team seats',
  reminders: 'Monthly reminders',
  storage: 'Storage',
};

const formatValue = (metric: UsageMetricKey, value?: number | null) => {
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

const getPercentage = (alert: UsageAlertRecord) => {
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

const formatMonthLabel = (monthId?: string | null) => {
  if (!monthId) {
    return null;
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

export const UsageAlertInlineBanner: React.FC<UsageAlertInlineBannerProps> = ({
  alert,
  totalAlerts,
  loading,
  error,
  monthLabel,
  onPress,
  onRefresh,
  horizontalInset,
}) => {
  const { theme } = useTheme();
  const resolvedInset = horizontalInset ?? 20;

  if (loading && !alert && !error) {
    return (
      <View style={[styles.banner, { borderColor: theme.border, backgroundColor: `${theme.border}30`, marginHorizontal: resolvedInset }]}> 
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={[styles.bannerMeta, { color: theme.textSecondary }]}>Loading usage alerts…</Text>
        </View>
      </View>
    );
  }

  if (!alert) {
    if (error) {
      return (
        <View style={[styles.banner, { borderColor: theme.border, backgroundColor: `${theme.border}20`, marginHorizontal: resolvedInset }]}> 
          <Text style={[styles.bannerErrorTitle, { color: theme.error }]}>Usage alerts unavailable</Text>
          <Text style={[styles.bannerMeta, { color: theme.textSecondary }]}>{error}</Text>
          {onRefresh && (
            <TouchableOpacity
              onPress={() => {
                void onRefresh();
              }}
              style={[styles.ctaButton, { borderColor: theme.border }]}
            >
              <Text style={[styles.ctaButtonText, { color: theme.text }]}>Retry</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }
    return null;
  }

  const severityColor = alert.type === 'critical' ? theme.error : theme.warning;
  const metricLabel = metricLabelByKey[alert.metric] ?? alert.metric;
  const percentage = getPercentage(alert);
  const valueLabel = formatValue(alert.metric, alert.value);
  const limitLabel = formatValue(alert.metric, alert.limit);
  const windowLabel = formatMonthLabel(monthLabel);

  return (
    <View
      style={[
        styles.banner,
        {
          borderColor: severityColor,
          backgroundColor: `${severityColor}15`,
          marginHorizontal: resolvedInset,
        },
      ]}
    >
      <View style={styles.bannerHeader}>
        <View style={styles.bannerTitleRow}>
          <AlertTriangle size={16} color={severityColor} />
          <Text style={[styles.bannerTitle, { color: theme.text }]}>
            Usage {alert.type === 'critical' ? 'limit' : 'warning'} · {metricLabel}
          </Text>
        </View>
        {onPress && (
          <TouchableOpacity
            style={[styles.ctaButton, { borderColor: severityColor }]}
            onPress={onPress}
          >
            <Text style={[styles.ctaButtonText, { color: severityColor }]}>Review usage</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={[styles.bannerMetric, { color: theme.text }]}>
        {percentage !== null ? `${percentage}% of plan` : 'Quota status'}
        {valueLabel && limitLabel ? ` · ${valueLabel} / ${limitLabel}` : ''}
      </Text>
      <Text style={[styles.bannerHelper, { color: theme.textSecondary }]}> 
        {windowLabel ? `${windowLabel} · ` : ''}
        Alert triggered when usage exceeded plan limits. Values reflect current usage.
        {alert.metric === 'staff' ? ' Team seats include active owners/admins/staff plus pending seat invites.' : ''}
      </Text>
      {totalAlerts > 1 && (
        <Text style={[styles.bannerMeta, { color: theme.textSecondary }]}>+{totalAlerts - 1} other alert{totalAlerts - 1 > 1 ? 's' : ''}</Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
    marginTop: 20,
    gap: 6,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 10,
    paddingVertical: 4,
  },
  bannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bannerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  bannerTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  bannerMetric: {
    fontSize: 16,
    fontWeight: '600',
  },
  bannerHelper: {
    fontSize: 13,
  },
  bannerMeta: {
    fontSize: 12,
  },
  bannerErrorTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  ctaButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  ctaButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
});

export default UsageAlertInlineBanner;
