import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Building2, Clock } from 'lucide-react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { formatDateToString } from '@/lib/utils';

interface TenantSelectionEmptyStateProps {
  title?: string;
  description?: string;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

const TenantSelectionEmptyState = ({
  title,
  description,
  primaryActionLabel,
  onPrimaryAction,
  secondaryActionLabel,
  onSecondaryAction,
}: TenantSelectionEmptyStateProps) => {
  const { theme } = useTheme();
  const { pendingMemberships, tenants } = useTenant();

  const pendingRequests = useMemo(
    () => pendingMemberships.filter((membership) => membership.status === 'pending_request'),
    [pendingMemberships],
  );

  const tenantNameById = useMemo(() => {
    const lookup: Record<string, string> = {};
    tenants.forEach((tenant) => {
      lookup[tenant.id] = tenant.name;
    });
    return lookup;
  }, [tenants]);

  const pendingSummaries = useMemo(() => {
    return pendingRequests.map((membership) => {
      const name = tenantNameById[membership.tenantId] || 'Coaching center';
      const requestedAt =
        'requestedAt' in membership
          ? (membership as { requestedAt?: string }).requestedAt
          : undefined;
      const timelineIso = requestedAt || membership.updatedAt || membership.createdAt;
      const requestedDate = timelineIso ? new Date(timelineIso) : null;
      return {
        id: membership.id,
        name,
        requestedLabel: requestedDate ? `Requested ${formatDateToString(requestedDate)}` : 'Request submitted',
      };
    });
  }, [pendingRequests, tenantNameById]);

  const hasPending = pendingSummaries.length > 0;
  const pendingDisplayCount = pendingSummaries.slice(0, 3);
  const pendingOverflow = pendingSummaries.length - pendingDisplayCount.length;

  const defaultTitle = hasPending ? 'Waiting for approval' : 'No coaching center selected';
  const defaultDescription = hasPending
    ? pendingSummaries.length === 1
      ? 'Your join request is pending. We will notify you as soon as an admin responds.'
      : 'You have multiple join requests pending. We will notify you as soon as admins respond.'
    : 'Open the Coaching centers panel to choose, create, or join a workspace before using this page.';
  const resolvedTitle = title ?? defaultTitle;
  const resolvedDescription = description ?? defaultDescription;
  const resolvedPrimaryActionLabel = primaryActionLabel ?? 'Open Coaching Centers';

  return (
    <View style={[styles.wrapper, { backgroundColor: theme.background }]}> 
      <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}> 
        <View style={styles.iconBadge}>
          <Building2 size={28} color={theme.primary} />
        </View>
        <Text style={[styles.title, { color: theme.text }]}>{resolvedTitle}</Text>
        <Text style={[styles.description, { color: theme.textSecondary }]}>{resolvedDescription}</Text>

        {hasPending && (
          <View
            style={[
              styles.pendingCard,
              { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
            ]}
          >
            <View style={styles.pendingCardHeader}>
              <Clock size={16} color={theme.warning} />
              <Text style={[styles.pendingCardTitle, { color: theme.warning }]}>Pending approval</Text>
            </View>
            {pendingDisplayCount.map((summary) => (
              <View key={summary.id} style={styles.pendingRow}>
                <Text style={[styles.pendingTenantName, { color: theme.text }]}>{summary.name}</Text>
                <Text style={[styles.pendingMeta, { color: theme.textSecondary }]}>{summary.requestedLabel}</Text>
              </View>
            ))}
            {pendingOverflow > 0 && (
              <Text style={[styles.pendingMeta, { color: theme.textSecondary }]}> 
                +{pendingOverflow} more request{pendingOverflow > 1 ? 's' : ''} awaiting review
              </Text>
            )}
            <Text style={[styles.pendingHint, { color: theme.textSecondary }]}> 
              We will email you as soon as an admin approves your access.
            </Text>
          </View>
        )}

        <View style={styles.actions}>
          {onPrimaryAction && (
            <TouchableOpacity
              onPress={onPrimaryAction}
              style={[styles.primaryButton, { backgroundColor: theme.primary }]}
            >
              <Text style={styles.primaryButtonText}>{resolvedPrimaryActionLabel}</Text>
            </TouchableOpacity>
          )}
          {onSecondaryAction && secondaryActionLabel && (
            <TouchableOpacity
              onPress={onSecondaryAction}
              style={[styles.secondaryButton, { borderColor: theme.border }]}
            >
              <Text style={[styles.secondaryButtonText, { color: theme.text }]}>{secondaryActionLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 480,
    borderWidth: 1,
    borderRadius: 24,
    paddingHorizontal: 28,
    paddingVertical: 32,
    alignItems: 'center',
  },
  iconBadge: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: 'rgba(99, 102, 241, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 20,
  },
  actions: {
    width: '100%',
    gap: 12,
  },
  pendingCard: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 20,
  },
  pendingCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  pendingCardTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  pendingRow: {
    marginBottom: 6,
  },
  pendingTenantName: {
    fontSize: 14,
    fontWeight: '600',
  },
  pendingMeta: {
    fontSize: 12,
  },
  pendingHint: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 18,
  },
  primaryButton: {
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButton: {
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default TenantSelectionEmptyState;
