import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

export type PlanTierId = 'free' | 'pro' | 'enterprise';

export type PlanTierReminders = {
  total: number;
  whatsapp: number;
  sms: number;
  voice: number;
  email: number;
};

export type PlanTierDisplay = {
  id: PlanTierId;
  label: string;
  monthlyPriceInr: number | null;
  staffSeats: number;
  students: number;
  reminders: PlanTierReminders;
  storageBytes: number;
};

function formatInr(amountInr: number | null): string {
  if (amountInr === null) {
    return 'Custom';
  }
  if (amountInr === 0) {
    return '₹0';
  }
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(amountInr);
  } catch {
    return `₹${amountInr}`;
  }
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 KB';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes < kb) return `${bytes} B`;
  if (bytes < mb) return `${(bytes / kb).toFixed(1)} KB`;
  if (bytes < gb) return `${(bytes / mb).toFixed(1)} MB`;
  return `${(bytes / gb).toFixed(1)} GB`;
}

export interface PlanTierCardProps {
  plan: PlanTierDisplay;
  isCurrent?: boolean;
  actionLabel?: string;
  onPressAction?: () => void;
  actionDisabled?: boolean;
}

export default function PlanTierCard({
  plan,
  isCurrent,
  actionLabel,
  onPressAction,
  actionDisabled,
}: PlanTierCardProps) {
  const { theme } = useTheme();

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.surface,
          borderColor: isCurrent ? theme.primary : theme.border,
        },
      ]}
    >
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <Text style={[styles.planName, { color: theme.text }]}>{plan.label}</Text>
          <Text style={[styles.planPrice, { color: theme.textSecondary }]}>
            {formatInr(plan.monthlyPriceInr)} / month
          </Text>
        </View>
        {isCurrent ? (
          <View style={[styles.badge, { backgroundColor: `${theme.primary}15` }]}> 
            <Text style={[styles.badgeText, { color: theme.primary }]}>Current</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.limits}>
        <Text style={[styles.limitLine, { color: theme.text }]}>Staff seats: {plan.staffSeats}</Text>
        <Text style={[styles.limitLine, { color: theme.text }]}>Students: {plan.students}</Text>
        <Text style={[styles.limitLine, { color: theme.text }]}>Monthly reminders: {plan.reminders.total}</Text>
        <Text style={[styles.limitLine, { color: theme.textSecondary }]}>
          WhatsApp {plan.reminders.whatsapp} · SMS {plan.reminders.sms} · Voice {plan.reminders.voice} · Email{' '}
          {plan.reminders.email}
        </Text>
        <Text style={[styles.limitLine, { color: theme.text }]}>Storage: {formatBytes(plan.storageBytes)}</Text>
      </View>

      {actionLabel ? (
        <TouchableOpacity
          style={[
            styles.actionButton,
            {
              backgroundColor: actionDisabled ? `${theme.primary}40` : theme.primary,
            },
          ]}
          onPress={onPressAction}
          disabled={actionDisabled}
        >
          <Text style={[styles.actionText, { color: theme.background }]}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  headerLeft: {
    flex: 1,
    gap: 4,
  },
  planName: {
    fontSize: 18,
    fontWeight: '700',
  },
  planPrice: {
    fontSize: 14,
    fontWeight: '600',
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  limits: {
    gap: 6,
  },
  limitLine: {
    fontSize: 14,
    fontWeight: '500',
  },
  actionButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
