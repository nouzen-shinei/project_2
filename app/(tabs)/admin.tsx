import { logger } from '@/lib/logger';
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Platform,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Plus, Trash2, RefreshCw, Shield, User, Bell, Settings, Search, X, PieChart, KeyRound } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import { useBirthdays } from '../../components/BirthdayProvider';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuthUnified';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import AdminNotificationCenter from '../../components/AdminNotificationCenter';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';
import { useTenant } from '@/hooks/useTenantContext';
import { tenantService } from '@/services/tenantService';
import { usageAnalyticsService } from '@/services/usageAnalyticsService';
import type { TenantInvite, TenantMembership, TenantMembershipRole, TenantJoinRequestStatus } from '@/types';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import TenantInviteManager, { TenantInviteManagerHandle } from '@/components/TenantInviteManager';
import TenantJoinCodeManager from '@/components/TenantJoinCodeManager';
import AdminUsageModal from '@/components/AdminUsageModal';
import UsageAlertInlineBanner from '@/components/UsageAlertInlineBanner';
import { useTenantUsageSummary } from '@/hooks/useTenantUsageSummary';
import { useTenantUsageHistory } from '@/hooks/useTenantUsageHistory';
import { useActiveUsageAlerts } from '@/hooks/useActiveUsageAlerts';
import SkeletonBar, { SkeletonCard, SkeletonRow, SkeletonCircle } from '../../components/Skeleton';

const JOIN_REQUEST_PAGE_SIZE = 5;
const JOIN_REQUEST_STATUS_FILTERS: TenantJoinRequestStatus[] = ['pending', 'approved', 'rejected', 'expired'];
const MEMBER_ROLE_FILTERS: { label: string; value: 'all' | TenantMembershipRole }[] = [
  { label: 'All roles', value: 'all' },
  { label: 'Owners', value: 'owner' },
  { label: 'Admins', value: 'admin' },
  { label: 'Staff', value: 'staff' },
  { label: 'Members', value: 'member' },
];

const ROLE_OPTIONS: TenantMembershipRole[] = ['owner', 'admin', 'staff', 'member'];
const USAGE_HISTORY_MONTHS = 6;


export default function AdminPanel() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const sharedTopPadding = useSharedTopPadding();
  const { theme } = useTheme();
  const skeletonBaseColor = `${theme.textSecondary}15`;
  const skeletonHighlightColor = `${theme.textSecondary}35`;
  const { headerCompensation } = useBirthdays();
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);
  const { user, loading: authLoading } = useAuth();
  const { isOffline, wasOffline } = useNetworkStatus();
  const { memberships, activeTenant, activeMembership, loading: tenantLoading, refreshTenants, joinRequests } = useTenant();
  const tenantId = activeTenant?.id ?? null;

  const {
    highlightedAlert: seatUsageAlert,
    alertCount: seatUsageAlertCount,
    monthId: seatUsageMonthId,
    loading: seatUsageAlertLoading,
    error: seatUsageAlertError,
    refresh: refreshSeatUsageAlerts,
  } = useActiveUsageAlerts(tenantId, { metrics: ['staff'] });
  const shouldShowSeatUsageBanner = Boolean(
    seatUsageAlertLoading || seatUsageAlertError || seatUsageAlertCount > 0,
  );

  const tenantIdRef = useRef<string | null>(tenantId);
  const [tenantMembers, setTenantMembers] = useState<TenantMembership[]>([]);
  const [tenantMembersLoading, setTenantMembersLoading] = useState(false);
  const [tenantInvites, setTenantInvites] = useState<TenantInvite[]>([]);
  useEffect(() => {
    tenantIdRef.current = tenantId;
  }, [tenantId]);
  const tenantMemberEmails = useMemo(() => tenantMembers.map((member) => member.email), [tenantMembers]);
  const tenantSeatMembersCount = useMemo(
    () => tenantMembers.filter((member) => member.role === 'owner' || member.role === 'admin' || member.role === 'staff').length,
    [tenantMembers],
  );
  const tenantJoinRequests = useMemo(
    () => joinRequests.filter((req) => req.tenantId === tenantId),
    [joinRequests, tenantId],
  );
  const reviewerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    memberships.forEach((membership) => {
      if (!membership.userId) {
        return;
      }
      const preferred = membership.displayName?.trim();
      map[membership.userId] = preferred && preferred.length ? preferred : membership.email;
    });
    return map;
  }, [memberships]);
  const [loadingAction, setLoadingAction] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'users' | 'team' | 'notifications'>('users'); // New tab state
  // Role change confirmation modal state
  const [showRoleChangeModal, setShowRoleChangeModal] = useState(false);
  const [roleChangeEmail, setRoleChangeEmail] = useState<string>('');
  const [roleChangeFromRole, setRoleChangeFromRole] = useState<TenantMembershipRole>('member');
  const [roleChangeSelectedRole, setRoleChangeSelectedRole] = useState<TenantMembershipRole>('member');
  const [roleChangeMembership, setRoleChangeMembership] = useState<TenantMembership | null>(null);
  const [memberToDelete, setMemberToDelete] = useState<TenantMembership | null>(null);
  const inviteButtonVisible = activeTab === 'users' || activeTab === 'team';
  const needsInvitePortal = inviteButtonVisible && activeTab !== 'users';
  // Users search state
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const userSearchInputRef = useRef<TextInput | null>(null);
  const inviteManagerRef = useRef<TenantInviteManagerHandle | null>(null);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [requestRoles, setRequestRoles] = useState<Record<string, TenantMembershipRole>>({});
  const [joinRequestStatusFilter, setJoinRequestStatusFilter] = useState<TenantJoinRequestStatus>('pending');
  const [joinRequestSort, setJoinRequestSort] = useState<'newest' | 'oldest'>('newest');
  const [joinRequestVisibleCount, setJoinRequestVisibleCount] = useState(JOIN_REQUEST_PAGE_SIZE);
  const [showQuotaModal, setShowQuotaModal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [teamRefreshPending, setTeamRefreshPending] = useState(false);
  const [memberRoleFilter, setMemberRoleFilter] = useState<'all' | TenantMembershipRole>('all');
  const [acknowledgingAlertId, setAcknowledgingAlertId] = useState<string | null>(null);
  const [requestingUsageRegeneration, setRequestingUsageRegeneration] = useState(false);
  const {
    usageSummary,
    loading: usageLoading,
    error: usageError,
    lastUpdated: usageLastUpdated,
    refresh: refreshUsageSummary,
  } = useTenantUsageSummary(tenantId);

  const {
    history: usageHistory,
    loading: usageHistoryLoading,
    error: usageHistoryError,
    lastUpdated: usageHistoryLastUpdated,
    refresh: refreshUsageHistory,
  } = useTenantUsageHistory(tenantId, USAGE_HISTORY_MONTHS);

  // Compute filtered visible emails based on search term (matches email or displayName)
  const filteredMembers = useMemo(() => {
    const q = userSearchQuery.trim().toLowerCase();
    return tenantMembers.filter((member) => {
      if (memberRoleFilter !== 'all' && member.role !== memberRoleFilter) {
        return false;
      }
      if (!q) {
        return true;
      }
      const email = member.email.toLowerCase();
      if (email.includes(q)) {
        return true;
      }
      const name = (member.displayName || '').toLowerCase();
      return name.includes(q);
    });
  }, [tenantMembers, userSearchQuery, memberRoleFilter]);

  const pendingInvites = useMemo(
    () => tenantInvites.filter((invite) => invite.status === 'pending'),
    [tenantInvites],
  );

  const filteredPendingInvites = useMemo(() => {
    const q = userSearchQuery.trim().toLowerCase();
    return pendingInvites.filter((invite) => {
      if (memberRoleFilter !== 'all' && invite.role !== memberRoleFilter) {
        return false;
      }
      if (!q) {
        return true;
      }
      return invite.email.toLowerCase().includes(q);
    });
  }, [pendingInvites, userSearchQuery, memberRoleFilter]);

  const filteredJoinRequests = useMemo(
    () => tenantJoinRequests.filter((request) => request.status === joinRequestStatusFilter),
    [tenantJoinRequests, joinRequestStatusFilter],
  );
  const pendingJoinRequestCount = useMemo(
    () => tenantJoinRequests.filter((request) => request.status === 'pending').length,
    [tenantJoinRequests],
  );

  const loadTenantMembers = useCallback(
    async (options?: { showErrorToast?: boolean }) => {
      if (!tenantId) {
        setTenantMembers([]);
        setTenantMembersLoading(false);
        return;
      }
      const targetTenantId = tenantId;
      setTenantMembersLoading(true);
      try {
        const members = await tenantService.getActiveMembershipsForTenant(targetTenantId);
        if (tenantIdRef.current !== targetTenantId) {
          return;
        }
        setTenantMembers(members);
      } catch (error) {
        logger.warn('AdminPanel: failed to load tenant members', error);
        if (options?.showErrorToast) {
          Toast.show({ type: 'error', text1: 'Unable to load team', text2: 'Please try again.' });
        }
      } finally {
        if (tenantIdRef.current === targetTenantId) {
          setTenantMembersLoading(false);
        }
      }
    },
    [tenantId],
  );

  useEffect(() => {
    void loadTenantMembers();
  }, [loadTenantMembers]);

  useEffect(() => {
    setMemberRoleFilter('all');
  }, [tenantId]);

  const tenantAdminRoleList: TenantMembershipRole[] = ['owner', 'admin'];
  const hasTenantAdminAccess = tenantAdminRoleList.includes(activeMembership?.role ?? 'member');
  const isLegacyAdmin = user?.role === 'admin';
  const canManageMembers = Boolean(user?.isAuthorized) && (hasTenantAdminAccess || isLegacyAdmin);
  const initiatedFrom = Platform.OS === 'web' ? 'web' : 'mobile';
  const canAssignOwnerRole = activeMembership?.role === 'owner';

  useEffect(() => {
    if (!tenantId || !canManageMembers) {
      setTenantInvites([]);
      return () => undefined;
    }

    const targetTenantId = tenantId;
    const unsubscribe = tenantService.listenToInvites(
      targetTenantId,
      (invites) => {
        if (tenantIdRef.current !== targetTenantId) {
          return;
        }
        setTenantInvites(invites);
      },
      (error) => {
        logger.warn('AdminPanel: invite listener failed', error);
        if (tenantIdRef.current === targetTenantId) {
          setTenantInvites([]);
        }
      },
    );

    return () => {
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        logger.warn('AdminPanel: failed to cleanup invite listener', cleanupError);
      }
    };
  }, [tenantId, canManageMembers]);

  const formatRequestStatusLabel = (status: TenantJoinRequestStatus) => {
    switch (status) {
      case 'approved':
        return 'Approved';
      case 'rejected':
        return 'Rejected';
      case 'expired':
        return 'Expired';
      default:
        return 'Pending';
    }
  };

  const getRequestStatusAccent = (status: TenantJoinRequestStatus) => {
    switch (status) {
      case 'approved':
        return {
          background: `${theme.success}15`,
          border: `${theme.success}30`,
          text: theme.success,
        };
      case 'rejected':
        return {
          background: `${theme.error}10`,
          border: `${theme.error}30`,
          text: theme.error,
        };
      case 'expired':
        return {
          background: `${theme.textSecondary}10`,
          border: `${theme.textSecondary}30`,
          text: theme.textSecondary,
        };
      default:
        return {
          background: `${theme.warning}10`,
          border: `${theme.warning}30`,
          text: theme.warning,
        };
    }
  };

  const sortedJoinRequests = useMemo(() => {
    const sorted = [...filteredJoinRequests];
    sorted.sort((a, b) => {
      const aTime = new Date(a.requestedAt).getTime();
      const bTime = new Date(b.requestedAt).getTime();
      return joinRequestSort === 'newest' ? bTime - aTime : aTime - bTime;
    });
    return sorted;
  }, [filteredJoinRequests, joinRequestSort]);

  const joinRequestCodeStats = useMemo(() => {
    let viaCodes = 0;
    filteredJoinRequests.forEach((request) => {
      if (request.joinCodeId || request.joinCodeValue) {
        viaCodes += 1;
      }
    });
    return { viaCodes, total: filteredJoinRequests.length };
  }, [filteredJoinRequests]);

  const emptyStateMessage = useMemo(() => {
    switch (joinRequestStatusFilter) {
      case 'approved':
        return 'No approved requests yet.';
      case 'rejected':
        return 'No rejected requests yet.';
      case 'expired':
        return 'No expired requests.';
      default:
        return 'No pending join requests.';
    }
  }, [joinRequestStatusFilter]);

  useEffect(() => {
    setJoinRequestVisibleCount(JOIN_REQUEST_PAGE_SIZE);
  }, [joinRequestStatusFilter, tenantId]);

  useEffect(() => {
    setJoinRequestVisibleCount((prev) => {
      if (!sortedJoinRequests.length) {
        return JOIN_REQUEST_PAGE_SIZE;
      }
      return Math.min(prev, sortedJoinRequests.length);
    });
  }, [sortedJoinRequests.length]);

  const visibleJoinRequests = useMemo(
    () => sortedJoinRequests.slice(0, joinRequestVisibleCount),
    [sortedJoinRequests, joinRequestVisibleCount],
  );

  const roleChangeModalName = roleChangeMembership?.displayName || roleChangeEmail || 'this member';
  const roleChangeSelectionDirty = roleChangeSelectedRole !== roleChangeFromRole;


  // Check admin privileges strictly by role fetched from Firestore
  // Centralized offline-aware loading gate (prevents zeroed UI on cold offline start)
  const { showLoading: showOfflineLoadingAdmin, offlineHint: offlineHintAdmin } = useOfflineDataGate(
    [tenantMembers],
    [authLoading, tenantLoading]
  );
  // Defer early return until after all hooks are declared
  const basePanelLoading = authLoading || showOfflineLoadingAdmin;
  const usageSkeletonActive = basePanelLoading || usageLoading;
  const joinRequestsSkeletonActive = basePanelLoading;
  const teamSkeletonActive = basePanelLoading;
  
  const getRoleLabel = (role: TenantMembershipRole) => {
    switch (role) {
      case 'owner':
        return 'Owner';
      case 'admin':
        return 'Admin';
      case 'staff':
        return 'Staff';
      default:
        return 'Member';
    }
  };

  const usagePlanLimits = useMemo(() => usageSummary?.planLimits ?? null, [usageSummary?.planLimits]);

  const resolvedQuotas = useMemo(
    () => ({
      maxStaff: activeTenant?.quotas?.maxStaff ?? usagePlanLimits?.staffSeats ?? null,
      maxMonthlyReminders:
        activeTenant?.quotas?.maxMonthlyReminders ?? usagePlanLimits?.reminders?.total ?? null,
    }),
    [activeTenant?.quotas?.maxStaff, activeTenant?.quotas?.maxMonthlyReminders, usagePlanLimits?.staffSeats, usagePlanLimits?.reminders?.total],
  );

  const seatUsageRatio = useMemo(() => {
    const maxStaff = resolvedQuotas.maxStaff;
    if (!maxStaff || maxStaff <= 0) {
      return null;
    }
    const usedSeats = typeof usageSummary?.staff === 'number' ? usageSummary.staff : tenantSeatMembersCount;
    return Math.min(1, usedSeats / maxStaff);
  }, [resolvedQuotas.maxStaff, usageSummary?.staff, tenantSeatMembersCount]);

  const reminderUsageRatio = useMemo(() => {
    const maxReminders = resolvedQuotas.maxMonthlyReminders;
    if (!maxReminders || maxReminders <= 0 || !usageSummary) {
      return null;
    }
    return Math.min(1, usageSummary.reminders.total / maxReminders);
  }, [resolvedQuotas.maxMonthlyReminders, usageSummary]);

  const overallUsagePercent = useMemo(() => {
    const ratios = [seatUsageRatio, reminderUsageRatio].filter(
      (ratio): ratio is number => typeof ratio === 'number' && !Number.isNaN(ratio),
    );
    if (!ratios.length) {
      return null;
    }
    const average = ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length;
    return Math.round(Math.min(1, average) * 100);
  }, [seatUsageRatio, reminderUsageRatio]);

  const usageSummaryHelperText = useMemo(() => {
    if (!tenantId) {
      return 'Select a coaching center to view usage.';
    }
    if (usageError) {
      return usageError;
    }
    if (overallUsagePercent !== null) {
      return 'Average of reminder and team quotas.';
    }
    if (usageLoading) {
      return 'Crunching the latest usage...';
    }
    return 'Usage data will appear once quotas refresh.';
  }, [tenantId, usageError, overallUsagePercent, usageLoading]);

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

  const handleUsageDetailsPress = () => {
    if (tenantId) {
      void refreshUsageSummary();
      void refreshUsageHistory();
    }
    setShowQuotaModal(true);
  };

  const handleAcknowledgeUsageAlert = useCallback(
    async (alertId: string) => {
      if (!alertId || acknowledgingAlertId === alertId) {
        return;
      }
      if (!tenantId) {
        Toast.show({ type: 'info', text1: 'Select a coaching center first' });
        return;
      }
      setAcknowledgingAlertId(alertId);
      try {
        await usageAnalyticsService.acknowledgeUsageAlert(alertId, tenantId);
        await refreshUsageSummary();
        Toast.show({ type: 'success', text1: 'Alert acknowledged' });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to acknowledge alert.';
        logger.warn('AdminPanel: usage alert acknowledgement failed', error);
        Toast.show({ type: 'error', text1: 'Alert acknowledgement failed', text2: message });
      } finally {
        setAcknowledgingAlertId((current) => (current === alertId ? null : current));
      }
    },
    [acknowledgingAlertId, refreshUsageSummary, tenantId]
  );

  const handleRequestUsageRegeneration = useCallback(async () => {
    if (!tenantId) {
      Toast.show({ type: 'info', text1: 'Select a coaching center first' });
      return;
    }

    if (!activeMembership || (activeMembership.role !== 'owner' && activeMembership.role !== 'admin')) {
      Toast.show({ type: 'info', text1: 'Admin access required' });
      return;
    }
    if (requestingUsageRegeneration) {
      return;
    }
    setRequestingUsageRegeneration(true);
    try {
      const month = usageSummary?.month;
      const result = await usageAnalyticsService.requestUsageRefresh(tenantId, { month });
      if (result?.alreadyQueued) {
        Toast.show({
          type: 'info',
          text1: 'Already queued',
          text2: 'A usage regeneration request is already pending for this month.',
        });
      } else {
        Toast.show({ type: 'success', text1: 'Rollup regeneration requested' });
      }
      await Promise.all([
        refreshUsageSummary().catch((e) => logger.warn('AdminPanel: usage summary refresh after regenerate request failed', e)),
        refreshUsageHistory().catch((e) => logger.warn('AdminPanel: usage history refresh after regenerate request failed', e)),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to request rollup refresh.';
      logger.warn('AdminPanel: usage refresh request failed', error);
      Toast.show({ type: 'error', text1: 'Request failed', text2: message });
    } finally {
      setRequestingUsageRegeneration(false);
    }
  }, [tenantId, requestingUsageRegeneration, usageSummary?.month, activeMembership, refreshUsageSummary, refreshUsageHistory]);

  const handleLoadMoreJoinRequests = () => {
    setJoinRequestVisibleCount((prev) =>
      Math.min(prev + JOIN_REQUEST_PAGE_SIZE, sortedJoinRequests.length),
    );
  };

  const handlePanelRefresh = useCallback(async () => {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    try {
      const tasks: Promise<unknown>[] = [refreshTenants(), loadTenantMembers({ showErrorToast: true })];
      if (tenantId) {
        tasks.push(refreshUsageSummary());
        tasks.push(refreshUsageHistory());
      }
      await Promise.all(tasks);
    } catch (error) {
      logger.warn('AdminPanel: pull-to-refresh failed', error);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, refreshTenants, refreshUsageSummary, refreshUsageHistory, tenantId, loadTenantMembers]);

  const handleManualTeamRefresh = useCallback(async () => {
    if (teamRefreshPending) {
      return;
    }
    if (isOffline) {
      Toast.show({ type: 'info', text1: 'Offline', text2: 'Reconnect before refreshing members.' });
      return;
    }
    setTeamRefreshPending(true);
    try {
      const tasks: Promise<unknown>[] = [loadTenantMembers({ showErrorToast: true })];
      if (tenantId) {
        tasks.push(refreshTenants());
      }
      await Promise.all(tasks);
    } catch (error) {
      logger.warn('AdminPanel: manual member refresh failed', error);
      Toast.show({ type: 'error', text1: 'Refresh failed', text2: 'Try again in a moment.' });
    } finally {
      setTeamRefreshPending(false);
    }
  }, [teamRefreshPending, isOffline, loadTenantMembers, tenantId, refreshTenants]);

  // Show message if completely offline - NetworkBanner will handle UI notification
  if (isOffline && !wasOffline) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <Text style={[styles.message, { color: theme.text }]}>Admin panel is offline</Text>
        <Text style={[styles.loadingSubtext, { color: theme.textSecondary }]}>
          Admin panel requires an internet connection to manage users and roles.
        </Text>
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: theme.primary, marginTop: 20 }]}
          onPress={() => {
            refreshTenants().catch((error) => logger.warn('AdminPanel: tenant refresh failed', error));
          }}
        >
          <Text style={styles.addButtonText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Early returns after all hooks have been called
  if (!user && !authLoading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.surface }]}>
        <Text style={[styles.message, { color: theme.text }]}>
          Please log in to access the admin panel.
        </Text>
      </View>
    );
  }

  if (user && !user.isAuthorized) {
    return (
      <View style={[styles.container, { backgroundColor: theme.surface }]}>
        <Text style={[styles.message, { color: theme.text }]}>
          You are not authorized to access this application.
        </Text>
      </View>
    );
  }

  if (tenantLoading && !activeTenant) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingSubtext, { color: theme.textSecondary, marginTop: 16 }]}>Loading admin…</Text>
      </View>
    );
  }

  if (!tenantLoading && !activeTenant) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <TenantSelectionEmptyState
          title="No coaching center selected"
          description="Open the Settings tab to create or join a coaching center before managing admin tools."
          primaryActionLabel="Open Settings"
          onPrimaryAction={() => router.push('/(tabs)/settings')}
        />
      </View>
    );
  }

  if (!canManageMembers) {
    return (
      <View style={[styles.container, { backgroundColor: theme.surface }]}>
        <Text style={[styles.message, { color: theme.text }]}>
          You do not have admin privileges for {activeTenant?.name || 'this coaching center'}.
        </Text>
        <Text style={[styles.debugText, { color: theme.textSecondary }]}>
          Debug Info:
        </Text>
        <Text style={[styles.debugText, { color: theme.textSecondary }]}> 
          • Your Email: {user?.email || 'N/A'}
        </Text>
        <Text style={[styles.debugText, { color: theme.textSecondary }]}> 
          • Tenant Role: {activeMembership?.role || 'unknown'}
        </Text>
      </View>
    );
  }

  const renderUsageSkeletonCard = () => (
    <SkeletonCard style={[styles.usageSummaryCard, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <SkeletonRow
        isCard
        lines={[{ width: '40%', height: 14 }, { width: '60%', height: 10 }]}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
      />
      <View style={{ marginTop: 16 }}>
        <SkeletonBar
          style={{ width: '100%', height: 10, borderRadius: 999 }}
          baseColor={skeletonBaseColor}
          highlightColor={skeletonHighlightColor}
        />
        <SkeletonBar
          style={{ width: '60%', height: 10, borderRadius: 999, marginTop: 8 }}
          baseColor={skeletonBaseColor}
          highlightColor={skeletonHighlightColor}
        />
      </View>
      <SkeletonBar
        style={{ width: '50%', height: 12, borderRadius: 6, marginTop: 16 }}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
      />
      <SkeletonBar
        style={{ width: '35%', height: 12, borderRadius: 6, marginTop: 8 }}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
      />
      <SkeletonBar
        style={{ width: '100%', height: 40, borderRadius: 10, marginTop: 20 }}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
      />
    </SkeletonCard>
  );

  const renderInviteSkeletonCard = () => (
    <SkeletonCard
      style={{
        borderWidth: 1,
        borderRadius: 12,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        padding: 16,
      }}
    >
      <SkeletonRow
        lines={[{ width: '60%', height: 14 }]}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
      />
      <SkeletonRow
        lines={[{ width: '80%', height: 12 }]}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
        style={{ marginTop: 8 }}
      />
      <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
        <SkeletonBar
          style={{ flex: 1, height: 40, borderRadius: 10 }}
          baseColor={skeletonBaseColor}
          highlightColor={skeletonHighlightColor}
        />
        <SkeletonBar
          style={{ flex: 1, height: 40, borderRadius: 10 }}
          baseColor={skeletonBaseColor}
          highlightColor={skeletonHighlightColor}
        />
      </View>
    </SkeletonCard>
  );

  const renderJoinRequestSkeletonList = () => (
    <View>
      {[0, 1, 2].map((index) => (
        <View
          key={`join-request-skeleton-${index}`}
          style={[styles.joinCard, { borderColor: theme.border, backgroundColor: theme.surface }]}
        >
          <SkeletonBar
            style={{ width: '60%', height: 14, borderRadius: 6 }}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <SkeletonBar
            style={{ width: '50%', height: 12, borderRadius: 6, marginTop: 6 }}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <SkeletonBar
            style={{ width: '70%', height: 12, borderRadius: 6, marginTop: 6 }}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <SkeletonBar
            style={{ width: '40%', height: 10, borderRadius: 6, marginTop: 12 }}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <SkeletonBar
              style={{ flex: 1, height: 40, borderRadius: 10 }}
              baseColor={skeletonBaseColor}
              highlightColor={skeletonHighlightColor}
            />
            <SkeletonBar
              style={{ flex: 1, height: 40, borderRadius: 10 }}
              baseColor={skeletonBaseColor}
              highlightColor={skeletonHighlightColor}
            />
          </View>
        </View>
      ))}
    </View>
  );

  const renderTeamSkeletonList = () => (
    [0, 1, 2].map((index) => (
      <View
        key={`team-skeleton-${index}`}
        style={[styles.userCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
          <SkeletonCircle
            size={40}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
            style={{ marginRight: 12 }}
          />
          <View style={{ flex: 1 }}>
            <SkeletonBar
              style={{ width: '70%', height: 14, borderRadius: 6 }}
              baseColor={skeletonBaseColor}
              highlightColor={skeletonHighlightColor}
            />
            <SkeletonBar
              style={{ width: '50%', height: 12, borderRadius: 6, marginTop: 6 }}
              baseColor={skeletonBaseColor}
              highlightColor={skeletonHighlightColor}
            />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <SkeletonCircle size={36} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
          <SkeletonCircle size={36} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        </View>
      </View>
    ))
  );

  const renderJoinCodeSkeletonCard = () => (
    <SkeletonCard
      style={{
        borderWidth: 1,
        borderRadius: 12,
        borderColor: theme.border,
        backgroundColor: theme.surface,
        padding: 16,
      }}
    >
      <SkeletonRow
        lines={[{ width: '50%', height: 14 }, { width: '70%', height: 12 }]}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
      />
      <SkeletonBar
        style={{ width: '100%', height: 36, borderRadius: 10, marginTop: 16 }}
        baseColor={skeletonBaseColor}
        highlightColor={skeletonHighlightColor}
      />
    </SkeletonCard>
  );

  const renderUserManagementSection = () => (
    <>
      {usageSkeletonActive ? (
        renderUsageSkeletonCard()
      ) : (
        <View style={[styles.usageSummaryCard, { borderColor: theme.border, backgroundColor: theme.surface }]}>
          <View style={styles.usageSummaryMeta}>
            <View style={styles.usageSummaryHeading}>
              <PieChart size={18} color={theme.primary} />
              <Text style={[styles.usageSummaryLabel, { color: theme.text }]}>Overall Usage</Text>
            </View>
            <View style={styles.usageProgressWrapper}>
              <View style={[styles.usageProgressTrack, { backgroundColor: theme.border }]}>
                <View
                  style={[
                    styles.usageProgressFill,
                    {
                      width: `${overallUsagePercent ?? 0}%`,
                      backgroundColor: usageError ? theme.error : theme.primary,
                      opacity: usageLoading && overallUsagePercent === null ? 0.4 : 1,
                    },
                  ]}
                />
              </View>
              <Text style={[styles.usageProgressLabel, { color: theme.textSecondary }]}> 
                {overallUsagePercent !== null
                  ? `${overallUsagePercent}% used`
                  : usageLoading
                  ? 'Loading…'
                  : 'Awaiting data'}
              </Text>
            </View>
            <Text
              style={[
                styles.usageSummaryHelper,
                { color: usageError ? theme.error : theme.textSecondary },
              ]}
            >
              {usageSummaryHelperText}
            </Text>
            {!!usageLastUpdatedLabel && (
              <Text style={[styles.usageSummaryTimestamp, { color: theme.textSecondary }]}> 
                Updated {usageLastUpdatedLabel}
              </Text>
            )}
          </View>
          <View style={styles.usageSummaryActions}>
            <TouchableOpacity
              style={[
                styles.usageSummaryButton,
                { backgroundColor: tenantId ? theme.primary : theme.border },
              ]}
              onPress={handleUsageDetailsPress}
              disabled={!tenantId}
            >
              <Text
                style={[
                  styles.usageSummaryButtonText,
                  { color: tenantId ? '#ffffff' : theme.textSecondary },
                ]}
              >
                Check Usage
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={{ marginTop: 16, marginBottom: 20 }}>
        {basePanelLoading ? renderInviteSkeletonCard() : <TenantInviteManager ref={inviteManagerRef} />}
      </View>

      <View style={[styles.cardSection, { borderColor: theme.border, backgroundColor: theme.surface }]}> 
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Join Requests</Text>
          <View style={styles.chipRow}>
            {(['newest', 'oldest'] as const).map((sortOption) => {
              const active = joinRequestSort === sortOption;
              return (
                <TouchableOpacity
                  key={sortOption}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: active ? theme.primary : theme.surface,
                      borderColor: active ? theme.primary : theme.border,
                    },
                  ]}
                  onPress={() => setJoinRequestSort(sortOption)}
                >
                  <Text style={[styles.chipText, { color: active ? '#fff' : theme.text }]}>
                    {sortOption === 'newest' ? 'Newest' : 'Oldest'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
        <View style={[styles.chipRow, styles.statusChipRow]}>
          {JOIN_REQUEST_STATUS_FILTERS.map((status) => {
            const active = joinRequestStatusFilter === status;
            return (
              <TouchableOpacity
                key={status}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? theme.primary : theme.surface,
                    borderColor: active ? theme.primary : theme.border,
                  },
                ]}
                onPress={() => setJoinRequestStatusFilter(status)}
              >
                <Text style={[styles.chipText, { color: active ? '#fff' : theme.text }]}>
                  {formatRequestStatusLabel(status)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {joinRequestsSkeletonActive ? (
          renderJoinRequestSkeletonList()
        ) : filteredJoinRequests.length === 0 ? (
          <View style={[styles.joinEmpty, { borderColor: theme.border, backgroundColor: theme.background }]}>
            <Text style={[styles.joinEmptyText, { color: theme.textSecondary }]}>{emptyStateMessage}</Text>
          </View>
        ) : (
          <>
          {joinRequestStatusFilter === 'pending' && joinRequestCodeStats.viaCodes > 0 && (
            <View
              style={[
                styles.joinInfoBanner,
                { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
              ]}
            >
              <KeyRound size={14} color={theme.warning} />
              <Text style={[styles.joinInfoBannerText, { color: theme.warning }]}> 
                {joinRequestCodeStats.viaCodes} of {joinRequestCodeStats.total} pending requests came from join codes.
              </Text>
            </View>
          )}
          <View style={styles.joinListWindow}>
            <ScrollView
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
              style={styles.joinListScroll}
              contentContainerStyle={styles.joinListContent}
            >
          {visibleJoinRequests.map((request) => {
            const selectedRole = requestRoles[request.id] || 'staff';
            const requestedAt = new Date(request.requestedAt);
            const expiresAt = request.expiresAt ? new Date(request.expiresAt) : null;
            const reviewedAt = request.reviewedAt ? new Date(request.reviewedAt) : null;
            const requestedLabel = requestedAt.toLocaleDateString();
            const expiresLabel = expiresAt ? expiresAt.toLocaleDateString() : null;
            const reviewedLabel = reviewedAt ? reviewedAt.toLocaleDateString() : null;
            const fromJoinCode = Boolean(request.joinCodeId || request.joinCodeValue);
            const isPending = request.status === 'pending';
            const statusAccent = getRequestStatusAccent(request.status);
            const statusLabel = formatRequestStatusLabel(request.status);
            const expiryMeta = (() => {
              if (!expiresLabel) {
                return '';
              }
              if (request.status === 'expired') {
                return ` • Expired ${expiresLabel}`;
              }
              if (isPending) {
                return ` • Expires ${expiresLabel}`;
              }
              return '';
            })();
            const reviewerName = request.reviewedBy
              ? reviewerNameMap[request.reviewedBy] || request.reviewedBy
              : null;
            const reviewMetaText = (() => {
              if (request.status === 'expired') {
                return expiresLabel ? `Auto-expired on ${expiresLabel}` : 'Auto-expired';
              }
              if (!isPending && (reviewerName || reviewedLabel)) {
                const byLine = reviewerName ? ` by ${reviewerName}` : '';
                const dateLine = reviewedLabel ? ` • ${reviewedLabel}` : '';
                return `Reviewed${byLine}${dateLine}`;
              }
              return null;
            })();
            return (
              <View key={request.id} style={[styles.joinCard, { borderColor: theme.border, backgroundColor: theme.surface }]}>
                <View style={styles.joinHeaderRow}>
                  <Text style={[styles.joinName, styles.joinHeaderName, { color: theme.text }]}>
                    {request.displayName || request.email}
                  </Text>
                  <View style={styles.joinStatusContainer}>
                    <View
                      style={[
                        styles.joinStatusBadge,
                        { backgroundColor: statusAccent.background, borderColor: statusAccent.border },
                      ]}
                    >
                      <Text style={[styles.joinStatusText, { color: statusAccent.text }]}>{statusLabel}</Text>
                    </View>
                  </View>
                </View>
                <Text style={[styles.joinEmail, { color: theme.textSecondary }]}>{request.email}</Text>
                <Text style={[styles.joinMeta, { color: theme.textSecondary }]}>
                  {`Requested ${requestedLabel}${expiryMeta}`}
                </Text>
                {fromJoinCode && (
                  <View
                    style={[
                      styles.joinCodeBadge,
                      { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
                    ]}
                  >
                    <KeyRound size={14} color={theme.warning} />
                    <Text style={[styles.joinCodeBadgeText, { color: theme.warning }]}> 
                      {request.joinCodeValue ? `Join code ${request.joinCodeValue}` : 'Requested via join code'}
                    </Text>
                  </View>
                )}
                {!!request.message && (
                  <Text style={[styles.joinMessage, { color: theme.textSecondary }]}>{request.message}</Text>
                )}
                {isPending ? (
                  <>
                    <View style={styles.joinRoleRow}>
                      {(['owner', 'admin', 'staff', 'member'] as TenantMembershipRole[]).map((roleOption) => {
                        const active = selectedRole === roleOption;
                        return (
                          <TouchableOpacity
                            key={roleOption}
                            style={[
                              styles.roleChip,
                              {
                                backgroundColor: active ? theme.primary : theme.surface,
                                borderColor: active ? theme.primary : theme.border,
                              },
                            ]}
                            onPress={() =>
                              setRequestRoles((prev) => ({
                                ...prev,
                                [request.id]: roleOption,
                              }))
                            }
                          >
                            <Text style={[styles.roleChipText, { color: active ? '#fff' : theme.text }]}> 
                              {roleOption.charAt(0).toUpperCase() + roleOption.slice(1)}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    <View style={styles.joinActions}>
                      <TouchableOpacity
                        style={[styles.joinButton, { borderColor: theme.border }]}
                        onPress={() => handleRejectJoinRequest(request.id)}
                        disabled={processingRequestId === request.id}
                      >
                        <Text style={[styles.joinButtonText, { color: theme.error }]}>
                          {processingRequestId === request.id ? 'Working…' : 'Reject'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.joinButton, { backgroundColor: theme.primary, borderWidth: 0 }]}
                        onPress={() => handleApproveJoinRequest(request.id)}
                        disabled={processingRequestId === request.id}
                      >
                        <Text style={[styles.joinButtonText, { color: '#fff' }]}>
                          {processingRequestId === request.id ? 'Working…' : 'Approve'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <View style={[styles.joinDecisionSummary, { borderColor: theme.border }]}> 
                    <Text style={[styles.joinDecisionText, { color: theme.textSecondary }]}>Decision: {statusLabel}</Text>
                    {!!reviewMetaText && (
                      <Text style={[styles.joinDecisionText, { color: theme.textSecondary }]}>{reviewMetaText}</Text>
                    )}
                  </View>
                )}
              </View>
            );
          })}
            </ScrollView>
          </View>
          {sortedJoinRequests.length > visibleJoinRequests.length && (
            <TouchableOpacity
              style={[styles.loadMoreButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
              onPress={handleLoadMoreJoinRequests}
            >
              <Text style={[styles.loadMoreButtonText, { color: theme.primary }]}>Load more requests</Text>
            </TouchableOpacity>
          )}
          </>
        )}
      </View>

      <View style={{ marginTop: 20 }}>
        <TenantJoinCodeManager isRefreshing={refreshing} />
      </View>
    </>
  );

  const renderTeamMembersSection = () => {
    const refreshDisabled = isOffline || teamRefreshPending;
    return (
      <>
        {shouldShowSeatUsageBanner && (
          <UsageAlertInlineBanner
            alert={seatUsageAlert}
            totalAlerts={seatUsageAlertCount}
            loading={seatUsageAlertLoading}
            error={seatUsageAlertError}
            monthLabel={seatUsageMonthId}
            horizontalInset={0}
            onPress={() => setShowQuotaModal(true)}
            onRefresh={refreshSeatUsageAlerts}
          />
        )}
        <View style={styles.memberSearchRow}>
          <View
            style={[
              styles.userSearchBox,
              { backgroundColor: theme.surface, borderColor: theme.border, flex: 1 },
            ]}
          > 
            <Search size={18} color={theme.textSecondary} />
            <TextInput
              ref={userSearchInputRef}
              style={[styles.userSearchInput, { color: theme.text }]}
              placeholder="Search by email or name..."
              placeholderTextColor={theme.textSecondary}
              value={userSearchQuery}
              onChangeText={setUserSearchQuery}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
            {userSearchQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => setUserSearchQuery('')}
                style={styles.clearSearchButton}
                accessibilityLabel="Clear search"
              >
                <X size={16} color={theme.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={[
              styles.memberRefreshButton,
              {
                borderColor: theme.border,
                backgroundColor: theme.surface,
                opacity: refreshDisabled ? 0.5 : 1,
              },
            ]}
            onPress={handleManualTeamRefresh}
            disabled={refreshDisabled}
            accessibilityRole="button"
            accessibilityLabel="Refresh team members"
          >
            {teamRefreshPending ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <RefreshCw size={18} color={refreshDisabled ? theme.textSecondary : theme.primary} />
            )}
          </TouchableOpacity>
        </View>

        <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.memberFilterScroll, { marginTop: 4 }]}
        contentContainerStyle={styles.memberFilterScrollContent}
      >
        {MEMBER_ROLE_FILTERS.map((filter) => {
          const isActive = memberRoleFilter === filter.value;
          return (
            <TouchableOpacity
              key={filter.value}
              style={[
                styles.memberFilterChip,
                {
                  borderColor: isActive ? theme.primary : theme.border,
                  backgroundColor: isActive ? theme.primary + '15' : theme.surface,
                },
              ]}
              onPress={() => setMemberRoleFilter(filter.value)}
              accessibilityLabel={`Filter members by ${filter.label}`}
            >
              <Text
                style={[
                  styles.memberFilterChipText,
                  { color: isActive ? theme.primary : theme.text },
                ]}
              >
                {filter.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <Text style={[styles.sectionTitle, { color: theme.text }]}>
        Team Members ({filteredMembers.length}{userSearchQuery ? ` of ${tenantMembers.length}` : ''})
      </Text>

      {(tenantMembersLoading || tenantLoading) && tenantMembers.length === 0 ? (
        renderTeamSkeletonList()
      ) : filteredMembers.length === 0 ? (
        <View style={[styles.centered, { paddingVertical: 40, paddingHorizontal: 20 }]}> 
          <Text style={[styles.message, { color: theme.text }]}>
            {userSearchQuery ? 'No members match your search.' : 'No members yet.'}
          </Text>
          <Text style={[styles.loadingSubtext, { color: theme.textSecondary, textAlign: 'center' }]}> 
            {userSearchQuery
              ? 'Try adjusting your search terms.'
              : 'Invite your first team member using the button above.'}
          </Text>
        </View>
      ) : (
        filteredMembers.map((member) => {
          const email = member.email;
          const role = member.role;
          const isAdminRole = tenantAdminRoleList.includes(role);
          return (
            <View key={member.id || email} style={[styles.userCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
              <View style={styles.userInfo}>
                <View style={styles.userIcon}>
                  {isAdminRole ? (
                    <Shield size={20} color={theme.warning} />
                  ) : (
                    <User size={20} color={theme.textSecondary} />
                  )}
                </View>
                <View style={styles.userDetails}>
                  <Text style={[styles.userEmail, { color: theme.text }]}>{member.displayName || email}</Text>
                  <Text style={[styles.userRole, { color: theme.textSecondary }]}> 
                    {getRoleLabel(role)} · {email}
                  </Text>
                </View>
              </View>

              <View style={styles.userActions}>
                {email === user?.email ? (
                  <Text
                    style={[
                      styles.youBadge,
                      {
                        backgroundColor: theme.primary + '20',
                        borderColor: theme.primary,
                        color: theme.primary,
                      },
                    ]}
                  >
                    You
                  </Text>
                ) : (
                  <>
                    <TouchableOpacity
                      style={[
                        styles.actionButton,
                        {
                          backgroundColor: theme.warning + '20',
                          opacity: isOffline || loadingAction ? 0.5 : 1,
                        },
                      ]}
                      onPress={() => handleToggleRole(member)}
                      disabled={isOffline || loadingAction}
                    >
                      <RefreshCw size={16} color={theme.warning} />
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={[
                        styles.actionButton,
                        {
                          backgroundColor: theme.error + '20',
                          opacity: isOffline || loadingAction ? 0.5 : 1,
                        },
                      ]}
                      onPress={() => handleRemoveMember(member)}
                      disabled={isOffline || loadingAction}
                      activeOpacity={0.7}
                    >
                      <Trash2 size={16} color={theme.error} />
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          );
        })
      )}

      {pendingInvites.length > 0 ? (
        <>
          <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 12 }]}> 
            Pending Invites ({filteredPendingInvites.length}{userSearchQuery ? ` of ${pendingInvites.length}` : ''})
          </Text>

          {filteredPendingInvites.length === 0 ? (
            <View style={[styles.centered, { paddingVertical: 16, paddingHorizontal: 20 }]}> 
              <Text style={[styles.loadingSubtext, { color: theme.textSecondary, textAlign: 'center' }]}> 
                {userSearchQuery ? 'No pending invites match your search.' : 'No pending invites.'}
              </Text>
            </View>
          ) : (
            filteredPendingInvites.map((invite) => (
              <View
                key={invite.id}
                style={[styles.userCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <View style={styles.userInfo}>
                  <View style={styles.userIcon}>
                    <User size={20} color={theme.textSecondary} />
                  </View>
                  <View style={styles.userDetails}>
                    <Text style={[styles.userEmail, { color: theme.text }]}>{invite.email}</Text>
                    <Text style={[styles.userRole, { color: theme.textSecondary }]}> 
                      {getRoleLabel(invite.role)} · Pending
                    </Text>
                  </View>
                </View>

                <View style={styles.userActions}>
                  <Text
                    style={[
                      styles.youBadge,
                      {
                        backgroundColor: theme.warning + '20',
                        borderColor: theme.warning,
                        color: theme.warning,
                      },
                    ]}
                  >
                    Pending
                  </Text>
                </View>
              </View>
            ))
          )}
        </>
      ) : null}
      </>
    );
  };

  const handleApproveJoinRequest = async (requestId: string) => {
    if (!user?.uid || !activeTenant?.id) {
      Toast.show({ type: 'error', text1: 'Not ready', text2: 'Sign in and select a coaching center first.' });
      return;
    }
    if (!canManageMembers) {
      Toast.show({ type: 'error', text1: 'Permission denied', text2: 'Only admins can review join requests.' });
      return;
    }
    const role = requestRoles[requestId] || 'staff';
    setProcessingRequestId(requestId);
    try {
      await tenantService.approveJoinRequest(requestId, user.uid, role, { actorName: user.displayName || user.email || undefined });
      Toast.show({ type: 'success', text1: 'Request approved', text2: `Assigned role: ${role}.` });
      await refreshTenants();
      await loadTenantMembers();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to approve request.';
      logger.error('AdminPanel: approve join request failed', error);
      Toast.show({ type: 'error', text1: 'Action failed', text2: message });
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleRejectJoinRequest = async (requestId: string) => {
    if (!user?.uid || !activeTenant?.id) {
      Toast.show({ type: 'error', text1: 'Not ready', text2: 'Sign in and select a coaching center first.' });
      return;
    }
    if (!canManageMembers) {
      Toast.show({ type: 'error', text1: 'Permission denied', text2: 'Only admins can review join requests.' });
      return;
    }
    setProcessingRequestId(requestId);
    try {
      await tenantService.rejectJoinRequest(requestId, user.uid, { actorName: user.displayName || user.email || undefined });
      Toast.show({ type: 'info', text1: 'Request rejected' });
      await refreshTenants();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to reject request.';
      logger.error('AdminPanel: reject join request failed', error);
      Toast.show({ type: 'error', text1: 'Action failed', text2: message });
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleRemoveMember = (member: TenantMembership) => {
    logger.debug('AdminPanel: delete requested for', member.email);
    if (member.role === 'owner' && activeMembership?.role !== 'owner') {
      Toast.show({
        type: 'info',
        text1: 'Owner Locked',
        text2: 'Only owners can remove another owner.',
        visibilityTime: 4000,
        autoHide: true,
        topOffset: 60,
      });
      return;
    }
    setMemberToDelete(member);
    setShowDeleteModal(true);
  };

  const resetRoleChangeModalState = () => {
    setRoleChangeMembership(null);
    setRoleChangeEmail('');
    setRoleChangeFromRole('member');
    setRoleChangeSelectedRole('member');
  };

  const closeRoleChangeModal = () => {
    setShowRoleChangeModal(false);
    resetRoleChangeModalState();
  };

  const confirmRemoveMember = async () => {
    if (!memberToDelete || !tenantId) {
      setShowDeleteModal(false);
      setMemberToDelete(null);
      return;
    }

    if (isOffline) {
      Toast.show({
        type: 'error',
        text1: 'Offline',
        text2: 'Cannot remove members while offline. Please reconnect and try again.',
        visibilityTime: 4000,
        autoHide: true,
        topOffset: 60,
      });
      setShowDeleteModal(false);
      setMemberToDelete(null);
      return;
    }

    if (!canManageMembers) {
      Toast.show({
        type: 'error',
        text1: 'Permission Denied',
        text2: 'Only tenant admins can remove members.',
        visibilityTime: 4000,
        autoHide: true,
        topOffset: 60,
      });
      setShowDeleteModal(false);
      setMemberToDelete(null);
      return;
    }

    if (!memberToDelete.userId) {
      Toast.show({
        type: 'error',
        text1: 'Member Missing ID',
        text2: 'Cannot remove this member because their account is incomplete.',
        visibilityTime: 4000,
        autoHide: true,
        topOffset: 60,
      });
      setShowDeleteModal(false);
      setMemberToDelete(null);
      return;
    }

    setLoadingAction(true);
    try {
      await tenantService.updateMembershipStatus(tenantId, memberToDelete.userId, 'revoked', {
        actorId: user?.uid,
        actorEmail: user?.email,
        actorName: user?.displayName,
        actorRole: activeMembership?.role,
        reason: 'admin_panel_member_removed',
        initiatedFrom,
      });
      await refreshTenants();
      await loadTenantMembers();
      Toast.show({
        type: 'success',
        text1: 'Member Removed',
        text2: `${memberToDelete.email} no longer has access to ${activeTenant?.name}.`,
        visibilityTime: 4000,
        autoHide: true,
        topOffset: 60,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('AdminPanel: failed to remove member', error);
      Toast.show({
        type: 'error',
        text1: 'Failed to Remove Member',
        text2: errorMessage,
        visibilityTime: 4000,
        autoHide: true,
        topOffset: 60,
      });
    } finally {
      setLoadingAction(false);
      setShowDeleteModal(false);
      setMemberToDelete(null);
    }
  };

  const handleToggleRole = (member: TenantMembership) => {
    if (loadingAction) {
      return;
    }
    if (!canManageMembers) {
      Toast.show({ type: 'error', text1: 'Permission Denied', text2: 'Only admins can change roles.' });
      return;
    }
    if (member.role === 'owner' && activeMembership?.role !== 'owner') {
      Toast.show({
        type: 'info',
        text1: 'Owner Role Locked',
        text2: 'Only an owner can manage another owner.',
        visibilityTime: 4000,
        autoHide: true,
        topOffset: 60,
      });
      return;
    }

    setRoleChangeMembership(member);
    setRoleChangeEmail(member.email);
    setRoleChangeFromRole(member.role);
    setRoleChangeSelectedRole(member.role);
    setShowRoleChangeModal(true);
  };

  const confirmRoleChange = async () => {
    if (!roleChangeMembership || !tenantId) {
      setShowRoleChangeModal(false);
      return;
    }

    if (isOffline) {
      Toast.show({ type: 'error', text1: 'Offline', text2: 'Cannot change roles while offline.' });
      return;
    }

    if (!canManageMembers) {
      Toast.show({ type: 'error', text1: 'Permission Denied', text2: 'Only tenant admins can change roles.' });
      setShowRoleChangeModal(false);
      return;
    }

    if (!roleChangeMembership.userId) {
      Toast.show({ type: 'error', text1: 'Member Missing ID', text2: 'Cannot update role for this member yet.' });
      setShowRoleChangeModal(false);
      return;
    }

    const targetRole = roleChangeSelectedRole;
    const currentRole = roleChangeFromRole;
    if (targetRole === currentRole) {
      Toast.show({ type: 'info', text1: 'No Changes Detected', text2: 'Select a different role before confirming.' });
      return;
    }

    const actorRole = activeMembership?.role ?? 'member';
    const isOwnerActor = actorRole === 'owner';
    if (targetRole === 'owner' && !isOwnerActor) {
      Toast.show({ type: 'error', text1: 'Owner Required', text2: 'Only owners can assign the Owner role.' });
      return;
    }
    if (currentRole === 'owner' && !isOwnerActor) {
      Toast.show({ type: 'error', text1: 'Owner Required', text2: 'Only owners can modify another owner.' });
      return;
    }

    setLoadingAction(true);
    try {
      await tenantService.updateMembershipRole(tenantId, roleChangeMembership.userId, targetRole, {
        actorId: user?.uid,
        actorEmail: user?.email,
        actorName: user?.displayName,
        actorRole: activeMembership?.role,
        reason: 'admin_panel_role_update',
        initiatedFrom,
      });
      await refreshTenants();
      await loadTenantMembers();
      Toast.show({ type: 'success', text1: 'Role Updated', text2: `${roleChangeMembership.email} is now ${getRoleLabel(targetRole)}.` });
      closeRoleChangeModal();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unable to update role.';
      logger.error('AdminPanel: failed to change role', error);
      Toast.show({ type: 'error', text1: 'Failed to Change Role', text2: errorMessage });
    } finally {
      setLoadingAction(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Header */}
  {/* Header */}
  <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
  <Text allowFontScaling={false} style={[styles.headerTitle, { color: theme.text }]}>Admin Panel</Text>
        <View style={styles.headerActions}>
          {inviteButtonVisible && (
            <TouchableOpacity
              style={[
                styles.addButton, 
                { 
                  backgroundColor: isOffline ? theme.textSecondary : theme.primary,
                  opacity: isOffline ? 0.5 : 1,
                }
              ]}
              onPress={() => inviteManagerRef.current?.openInviteModal()}
              disabled={isOffline}
            >
              <Plus size={20} color="#ffffff" />
              <Text allowFontScaling={false} style={styles.addButtonText}>Invite</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Tab Navigation */}
      <View style={[styles.tabContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === 'users' && [styles.activeTab, { borderBottomColor: theme.primary }]
          ]}
          onPress={() => setActiveTab('users')}
        >
          <Settings size={20} color={activeTab === 'users' ? theme.primary : theme.textSecondary} />
          <Text
            allowFontScaling={false}
            style={[
              styles.tabText,
              { color: activeTab === 'users' ? theme.primary : theme.textSecondary }
            ]}
          >
            User Management
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === 'team' && [styles.activeTab, { borderBottomColor: theme.primary }]
          ]}
          onPress={() => setActiveTab('team')}
        >
          <User size={20} color={activeTab === 'team' ? theme.primary : theme.textSecondary} />
          <Text
            allowFontScaling={false}
            style={[
              styles.tabText,
              { color: activeTab === 'team' ? theme.primary : theme.textSecondary }
            ]}
          >
            Members
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.tabButton,
            activeTab === 'notifications' && [styles.activeTab, { borderBottomColor: theme.primary }]
          ]}
          onPress={() => setActiveTab('notifications')}
        >
          <Bell size={20} color={activeTab === 'notifications' ? theme.primary : theme.textSecondary} />
          <Text
            allowFontScaling={false}
            style={[
              styles.tabText,
              { color: activeTab === 'notifications' ? theme.primary : theme.textSecondary }
            ]}
          >
            Notifications
          </Text>
        </TouchableOpacity>
      </View>

      {/* Tab Content */}
      {activeTab === 'notifications' ? (
        <AdminNotificationCenter 
          adminEmail={user?.email || ''} 
          adminName={user?.displayName || user?.email || 'Admin'}
          authorizedEmails={tenantMemberEmails}
        />
      ) : (
        <ScrollView
          style={styles.content}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 24 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handlePanelRefresh}
              tintColor={theme.primary}
              colors={[theme.primary]}
            />
          }
        >
          {activeTab === 'users' ? renderUserManagementSection() : renderTeamMembersSection()}
        </ScrollView>
      )}

      {needsInvitePortal && (
        <View style={[styles.hiddenInviteManagerHost, { pointerEvents: 'none' }]}>
          <TenantInviteManager ref={inviteManagerRef} />
        </View>
      )}

      <AdminUsageModal
        visible={showQuotaModal}
        onClose={() => setShowQuotaModal(false)}
        tenant={activeTenant}
        tenantMembersCount={tenantSeatMembersCount}
        pendingJoinRequests={pendingJoinRequestCount}
        usageSummary={usageSummary}
        usageLoading={usageLoading}
        usageError={usageError}
        onRefreshUsage={refreshUsageSummary}
        usageLastUpdated={usageLastUpdated}
        usageHistory={usageHistory}
        usageHistoryLoading={usageHistoryLoading}
        usageHistoryError={usageHistoryError}
        usageHistoryLastUpdated={usageHistoryLastUpdated}
        onRefreshUsageHistory={refreshUsageHistory}
        onAcknowledgeAlert={handleAcknowledgeUsageAlert}
        acknowledgingAlertId={acknowledgingAlertId}
        onRequestUsageRegeneration={handleRequestUsageRegeneration}
        requestingUsageRegeneration={requestingUsageRegeneration}
      />

      {/* Delete Confirmation Modal */}
      <Modal
        visible={showDeleteModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowDeleteModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Remove Member</Text>
            <Text style={[styles.modalMessage, { color: theme.text }]}>
              Are you sure you want to remove {memberToDelete?.displayName || memberToDelete?.email || 'this member'} from {activeTenant?.name}?
              {'\n\n'}This will revoke their access to the application.
            </Text>
            
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton, { backgroundColor: theme.border }]}
                onPress={() => setShowDeleteModal(false)}
                disabled={loadingAction}
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>
                  Cancel
                </Text>
              </TouchableOpacity>
              
              <TouchableOpacity
                style={[styles.modalButton, styles.deleteButton, { backgroundColor: '#dc3545' }]}
                onPress={confirmRemoveMember}
                disabled={loadingAction}
              >
                <Text style={[styles.modalButtonText, { color: '#ffffff' }]}>
                  {loadingAction ? 'Removing...' : 'Remove'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Role Change Confirmation Modal */}
      <Modal
        visible={showRoleChangeModal}
        transparent={true}
        animationType="fade"
        onRequestClose={closeRoleChangeModal}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.surface }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Update Member Role</Text>
            <Text style={[styles.modalMessage, { color: theme.text }]}>
              Set the access level for {roleChangeModalName}.
            </Text>
            <Text style={[styles.currentRoleLabel, { color: theme.textSecondary }]}>Current role: {getRoleLabel(roleChangeFromRole)}</Text>
            <View style={styles.roleSelector}>
              <Text style={[styles.roleLabel, { color: theme.text }]}>Choose a new role</Text>
              <View style={styles.roleButtons}>
                {ROLE_OPTIONS.map((roleOption) => {
                  const isActive = roleChangeSelectedRole === roleOption;
                  const optionDisabled = roleOption === 'owner' && !canAssignOwnerRole;
                  return (
                    <TouchableOpacity
                      key={roleOption}
                      style={[
                        styles.roleButton,
                        {
                          borderColor: isActive ? theme.primary : theme.border,
                          backgroundColor: isActive ? theme.primary + '15' : theme.surface,
                          opacity: optionDisabled ? 0.5 : 1,
                        },
                      ]}
                      disabled={optionDisabled}
                      onPress={() => {
                        if (!optionDisabled) {
                          setRoleChangeSelectedRole(roleOption);
                        }
                      }}
                    >
                      <Text
                        style={[
                          styles.roleButtonText,
                          { color: isActive ? theme.primary : theme.text },
                        ]}
                      >
                        {getRoleLabel(roleOption)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            {!canAssignOwnerRole && (
              <Text style={[styles.roleHint, { color: theme.textSecondary }]}>Only owners can assign the Owner role.</Text>
            )}
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.cancelButton, { backgroundColor: theme.border }]}
                onPress={closeRoleChangeModal}
                disabled={loadingAction}
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.deleteButton,
                  {
                    backgroundColor:
                      loadingAction || !roleChangeSelectionDirty ? theme.border : theme.warning,
                  },
                ]}
                onPress={confirmRoleChange}
                disabled={loadingAction || !roleChangeSelectionDirty}
              >
                <Text
                  style={[
                    styles.modalButtonText,
                    { color: loadingAction || !roleChangeSelectionDirty ? theme.text : '#ffffff' },
                  ]}
                > 
                  {loadingAction
                    ? 'Changing...'
                    : roleChangeSelectionDirty
                    ? 'Apply Role'
                    : 'Select Role'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Platform.select({ web: 10, default: 20 }),
    paddingTop: 60,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 8,
  },
  addButtonText: {
    color: '#ffffff',
    fontFamily: 'Inter-Medium',
    fontSize: 14,
  },
  content: {
    flex: 1,
    paddingHorizontal: Platform.select({ web: 10, default: 20 }),
  },
  hiddenInviteManagerHost: {
    height: 0,
    width: 0,
    opacity: 0,
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginVertical: 20,
  },
  memberFilterScroll: {
    marginBottom: -8,
    marginTop: 0,
  },
  memberFilterScrollContent: {
    paddingHorizontal: 4,
  },
  memberSearchRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 12,
    marginTop: 16,
    marginBottom: 8,
  },
  userSearchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: Platform.select({ web: 10, default: 6 }),
    minHeight: Platform.select({ web: undefined as any, default: 34 }),
  },
  userSearchInput: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    paddingVertical: Platform.select({ web: undefined as any, default: 0 }),
    minHeight: Platform.select({ web: undefined as any, default: 20 }),
    textAlignVertical: Platform.select({ android: 'center', default: undefined as any }),
  },
  clearSearchButton: {
    padding: 4,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  memberRefreshButton: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 44,
  },
  userCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  userIcon: {
    marginRight: 12,
  },
  userDetails: {
    flex: 1,
  },
  userEmail: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  userRole: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  memberFilterChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginRight: 10,
  },
  memberFilterChipText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
  userActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    padding: 12,
    borderRadius: 8,
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 16,
  },
  errorSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    maxWidth: 400,
    borderRadius: 16,
    padding: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 20,
    textAlign: 'center',
  },
  emailInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    marginBottom: 20,
  },
  roleSelector: {
    marginBottom: 24,
  },
  currentRoleLabel: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
    marginBottom: 12,
  },
  roleLabel: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginBottom: 12,
  },
  roleButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  roleButton: {
    flexGrow: 1,
    minWidth: '46%',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  roleButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  roleHint: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
    marginBottom: 16,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  modalButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  message: {
    fontSize: 18,
    fontFamily: 'Poppins-Medium',
    textAlign: 'center',
    marginVertical: 16,
  },
  debugText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginTop: 8,
    opacity: 0.7,
  },
  loadingSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginTop: 8,
    marginHorizontal: Platform.select({ web: 10, default: 20 }),
  },
  modalMessage: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
  },
  deleteButton: {
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: 'transparent',
    borderBottomWidth: 1,
    paddingHorizontal: Platform.select({ web: 10, default: 20 }),
  },
  tabButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginRight: 20,
    gap: 8,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomWidth: 2,
  },
  tabText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  youBadge: {
  fontSize: 12,
  fontFamily: 'Inter-Medium',
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 999,
  borderWidth: 1,
  overflow: 'hidden',
  },
  usageSummaryCard: {
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    borderWidth: 1,
    borderRadius: 14,
    marginTop: 16,
  },
  usageSummaryMeta: {
    flex: 1,
  },
  usageSummaryHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  usageSummaryLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  usageSummaryActions: {
    width: '100%',
  },
  usageProgressWrapper: {
    marginTop: 12,
    gap: 8,
  },
  usageProgressTrack: {
    width: '100%',
    height: 10,
    borderRadius: 999,
    overflow: 'hidden',
  },
  usageProgressFill: {
    height: '100%',
    borderRadius: 999,
  },
  usageProgressLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  usageSummaryValue: {
    fontSize: 32,
    fontFamily: 'Poppins-Bold',
    marginTop: 8,
  },
  usageSummaryHelper: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 6,
  },
  usageSummaryTimestamp: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  usageSummaryButton: {
    width: '100%',
    paddingVertical: 12,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  usageSummaryButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  cardSection: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 20,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 0,
  },
  chipRow: {
    flexDirection: 'row',
    gap: 8,
  },
  statusChipRow: {
    flexWrap: 'wrap',
    marginTop: -8,
    marginBottom: 8,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  joinEmpty: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  joinEmptyText: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
  },
  joinInfoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  joinInfoBannerText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    flex: 1,
  },
  joinCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  joinHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  joinName: {
    fontSize: 15,
    fontFamily: 'Poppins-SemiBold',
  },
  joinHeaderName: {
    flex: 1,
    marginRight: 8,
  },
  joinEmail: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  joinMeta: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  joinStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  joinStatusBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  joinStatusText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  joinCodeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  joinCodeBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  joinMessage: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 8,
  },
  joinDecisionSummary: {
    marginTop: 12,
    padding: 10,
    borderWidth: 1,
    borderRadius: 10,
  },
  joinDecisionText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  joinRoleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  roleChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  roleChipText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  joinActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  joinButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 8,
    alignItems: 'center',
  },
  joinButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  loadMoreButton: {
    marginTop: 8,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadMoreButtonText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
  joinListWindow: {
    maxHeight: 360,
    width: '100%',
    overflow: 'hidden',
  },
  joinListScroll: {
    flexGrow: 0,
  },
  joinListContent: {
    paddingBottom: 8,
  },
});
