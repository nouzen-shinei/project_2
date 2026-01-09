import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { AlertCircle, Check, Link2, MailPlus, RefreshCw, X } from 'lucide-react-native';

import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { useAuth } from '@/hooks/useAuthUnified';
import { useTenantUsageSummary } from '@/hooks/useTenantUsageSummary';
import { tenantService } from '@/services/tenantService';
import type { TenantInvite, TenantMembershipRole } from '@/types';
import { formatDateToString } from '@/lib/utils';
import { logger } from '@/lib/logger';

const ROLE_OPTIONS: TenantMembershipRole[] = ['owner', 'admin', 'staff', 'member'];
const EXPIRY_OPTIONS = [3, 7, 14, 30];
const INVITE_PAGE_SIZE = 5;

const statusLabel: Record<TenantInvite['status'], string> = {
  pending: 'Pending',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Revoked',
};

const inviteFilterOptions: { id: 'all' | TenantInvite['status']; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'accepted', label: 'Accepted' },
  { id: 'expired', label: 'Expired' },
  { id: 'revoked', label: 'Revoked' },
];

const statusChipColor = (
  status: TenantInvite['status'],
  theme: ReturnType<typeof useTheme>['theme'],
): { backgroundColor: string; color: string } => {
  switch (status) {
    case 'accepted':
      return { backgroundColor: `${theme.success}1A`, color: theme.success };
    case 'expired':
      return { backgroundColor: `${theme.warning}1A`, color: theme.warning };
    case 'revoked':
      return { backgroundColor: `${theme.textSecondary}1A`, color: theme.textSecondary };
    default:
      return { backgroundColor: `${theme.primary}1A`, color: theme.primary };
  }
};

const DEFAULT_WEB_APP_BASE_URL = 'https://tuitionmanager.app';

const normalizeBaseUrl = (value?: string | null): string | null => {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
};

const resolveWebAppBaseUrl = (): string => {
  const fromEnv = normalizeBaseUrl(process.env.EXPO_PUBLIC_WEB_APP_URL);
  if (fromEnv) return fromEnv;

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const origin = normalizeBaseUrl(window.location?.origin);
    if (origin) return origin;
  }

  return DEFAULT_WEB_APP_BASE_URL;
};

const parseIsoDate = (value?: string | null): Date | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export interface TenantInviteManagerHandle {
  openInviteModal: () => void;
}

type TenantInviteManagerProps = {
  onUpgradePress?: () => void;
};

const TenantInviteManager = forwardRef<TenantInviteManagerHandle, TenantInviteManagerProps>(({ onUpgradePress }, ref) => {
  const { theme } = useTheme();
  const router = useRouter();
  const { activeTenant, activeMembership, memberships } = useTenant();
  const { user } = useAuth();

  const { usageSummary } = useTenantUsageSummary(activeTenant?.id ?? null);
  const [invites, setInvites] = useState<TenantInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteModalVisible, setInviteModalVisible] = useState(false);
  const [formEmail, setFormEmail] = useState('');
  const [formRole, setFormRole] = useState<TenantMembershipRole>('staff');
  const [formExpiresInDays, setFormExpiresInDays] = useState<number>(7);
  const [formMessage, setFormMessage] = useState('');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [resendingInviteId, setResendingInviteId] = useState<string | null>(null);
  const [revokingInviteId, setRevokingInviteId] = useState<string | null>(null);
  const [visibleInviteCount, setVisibleInviteCount] = useState(INVITE_PAGE_SIZE);
  const [pendingRevokeInvite, setPendingRevokeInvite] = useState<TenantInvite | null>(null);
  const [pendingResendInvite, setPendingResendInvite] = useState<TenantInvite | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | TenantInvite['status']>('pending');
  const [copiedInviteId, setCopiedInviteId] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const seatLimit =
    activeTenant?.quotas?.maxStaff ??
    usageSummary?.planLimits?.staffSeats ??
    null;
  const activeSeatCount = useMemo(() => {
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
  }, [memberships, activeTenant?.id, activeTenant?.membershipCounts]);

  const pendingSeatInviteCount = useMemo(
    () => invites.filter((invite) => invite.status === 'pending' && (invite.role === 'owner' || invite.role === 'admin' || invite.role === 'staff')).length,
    [invites],
  );

  const seatsUsed = activeSeatCount + pendingSeatInviteCount;
  const seatsFull = typeof seatLimit === 'number' && seatLimit > 0 && seatsUsed >= seatLimit;
  const filteredInvites = useMemo(() => {
    if (statusFilter === 'all') {
      return invites;
    }
    return invites.filter((invite) => invite.status === statusFilter);
  }, [invites, statusFilter]);

  const filteredInviteCount = filteredInvites.length;

  const visibleInvites = useMemo(
    () => filteredInvites.slice(0, visibleInviteCount),
    [filteredInvites, visibleInviteCount],
  );


  const canManageInvites = useMemo(() => {
    if (!activeMembership) {
      return false;
    }
    return activeMembership.role === 'owner' || activeMembership.role === 'admin';
  }, [activeMembership]);

  useEffect(() => {
    setFormRole('staff');
    setFormExpiresInDays(activeTenant?.settings?.inviteExpiryDaysDefault ?? 7);
  }, [activeTenant?.id, activeTenant?.settings?.inviteExpiryDaysDefault]);

  useEffect(() => {
    return () => {
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
        copyResetRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setVisibleInviteCount(INVITE_PAGE_SIZE);
    setStatusFilter('pending');
  }, [activeTenant?.id]);

  useEffect(() => {
    setVisibleInviteCount((prev) => {
      if (!filteredInviteCount) {
        return INVITE_PAGE_SIZE;
      }
      return Math.min(prev, filteredInviteCount);
    });
  }, [filteredInviteCount]);

  useEffect(() => {
    setVisibleInviteCount(INVITE_PAGE_SIZE);
  }, [statusFilter]);

  useEffect(() => {
    if (!activeTenant?.id || !canManageInvites) {
      setInvites([]);
      return () => undefined;
    }
    setLoading(true);
    setError(null);
    const unsubscribe = tenantService.listenToInvites(
      activeTenant.id,
      (list) => {
        setInvites(list);
        setLoading(false);
      },
      (listenerError) => {
        logger.warn('TenantInviteManager: invite listener failed', listenerError);
        setError(listenerError?.message || 'Failed to load invites');
        setLoading(false);
      },
    );
    return () => {
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        logger.warn('TenantInviteManager: failed to cleanup invite listener', cleanupError);
      }
    };
  }, [activeTenant?.id, canManageInvites]);

  const openModal = useCallback(() => {
    if (seatsFull) {
      if (onUpgradePress) {
        onUpgradePress();
      } else {
        router.push('/(tabs)/plan');
      }
      return;
    }
    setFormEmail('');
    setFormRole('staff');
    setFormExpiresInDays(activeTenant?.settings?.inviteExpiryDaysDefault ?? 7);
    setFormMessage('');
    setFormError(null);
    setInviteModalVisible(true);
  }, [activeTenant?.settings?.inviteExpiryDaysDefault, onUpgradePress, router, seatsFull]);

  const closeModal = () => {
    if (creatingInvite) {
      return;
    }
    setInviteModalVisible(false);
  };

  useImperativeHandle(
    ref,
    () => ({
      openInviteModal: () => {
        openModal();
      },
    }),
    [openModal],
  );

  const composeInviteLink = useCallback((token: string) => {
    const safeToken = encodeURIComponent((token || '').trim());
    const base = resolveWebAppBaseUrl();
    return `${base}/invite/${safeToken}`;
  }, []);

  const handleCopyLink = useCallback(
    async (invite: TenantInvite) => {
      try {
        const link = composeInviteLink(invite.token);
        await Clipboard.setStringAsync(link);
        if (copyResetRef.current) {
          clearTimeout(copyResetRef.current);
        }
        setCopiedInviteId(invite.id);
        copyResetRef.current = setTimeout(() => {
          setCopiedInviteId(null);
          copyResetRef.current = null;
        }, 2000);
        Toast.show({
          type: 'success',
          text1: 'Link copied',
          text2: 'Share it with your teammate privately.',
          position: 'top',
          topOffset: 60,
        });
      } catch (copyError) {
        logger.warn('TenantInviteManager: copy link failed', copyError);
        Toast.show({
          type: 'error',
          text1: 'Copy failed',
          text2: 'Unable to copy invite link. Try again.',
          position: 'top',
          topOffset: 60,
        });
      }
    },
    [composeInviteLink],
  );

  const handleCreateInvite = async () => {
    if (!user?.uid || !activeTenant?.id) {
      Alert.alert('Unable to invite', 'Sign in and select a coaching center first.');
      return;
    }
    if (seatsFull) {
      Alert.alert('Seat limit reached', 'Remove an existing member or upgrade your plan to invite more teammates.');
      return;
    }
    const normalizedEmail = formEmail.trim().toLowerCase();
    if (!normalizedEmail) {
      setFormError('Email is required.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setFormError('Enter a valid email address.');
      return;
    }
    const duplicateInvite = invites.find(
      (invite) => invite.status === 'pending' && invite.email?.trim().toLowerCase() === normalizedEmail,
    );
    if (duplicateInvite) {
      setFormError('You already have an invite pending for this email. Resend or revoke it first.');
      return;
    }
    setCreatingInvite(true);
    setFormError(null);
    try {
      await tenantService.createInvite({
        tenantId: activeTenant.id,
        email: normalizedEmail,
        role: formRole,
        issuedBy: user.uid,
        expiresInDays: formExpiresInDays,
        message: formMessage.trim() || undefined,
      });
      setInviteModalVisible(false);
      Toast.show({
        type: 'success',
        text1: 'Invite sent',
        text2: `${normalizedEmail} can join via the link.`,
        position: 'top',
        topOffset: 60,
      });
    } catch (createError) {
      logger.error('TenantInviteManager: create invite failed', createError);
      const errorMessage =
        createError instanceof Error ? createError.message : 'Failed to create invite. Try again later.';
      setFormError(errorMessage);
    } finally {
      setCreatingInvite(false);
    }
  };

  const confirmRevokeInvite = (invite: TenantInvite) => {
    if (invite.status !== 'pending') {
      Toast.show({
        type: 'info',
        text1: 'Invite already closed',
        text2: 'Only pending invites can be revoked.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    setPendingRevokeInvite(invite);
  };

  const confirmResendInvite = (invite: TenantInvite) => {
    if (invite.status !== 'pending') {
      Toast.show({
        type: 'info',
        text1: 'Invite is closed',
        text2: 'Only pending invites can be resent.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    setPendingResendInvite(invite);
  };

  const dismissRevokeModal = () => {
    if (revokingInviteId) {
      return;
    }
    setPendingRevokeInvite(null);
  };

  const dismissResendModal = () => {
    if (resendingInviteId && resendingInviteId === pendingResendInvite?.id) {
      return;
    }
    setPendingResendInvite(null);
  };

  const handleConfirmRevoke = async () => {
    if (!pendingRevokeInvite) {
      return;
    }
    if (pendingRevokeInvite.status !== 'pending') {
      Toast.show({
        type: 'info',
        text1: 'Invite already closed',
        text2: 'Only pending invites can be revoked.',
        position: 'top',
        topOffset: 60,
      });
      setPendingRevokeInvite(null);
      return;
    }
    await handleRevokeInvite(pendingRevokeInvite.id);
    setPendingRevokeInvite(null);
  };

  const handleConfirmResend = async () => {
    if (!pendingResendInvite) {
      return;
    }
    if (pendingResendInvite.status !== 'pending') {
      Toast.show({
        type: 'info',
        text1: 'Invite is closed',
        text2: 'Only pending invites can be resent.',
        position: 'top',
        topOffset: 60,
      });
      setPendingResendInvite(null);
      return;
    }
    await handleResendInvite(pendingResendInvite);
    setPendingResendInvite(null);
  };

  const handleRevokeInvite = async (inviteId: string) => {
    if (!user?.uid) {
      Alert.alert('Unable to revoke', 'Sign in again to manage invites.');
      return;
    }
    setRevokingInviteId(inviteId);
    try {
      await tenantService.revokeInvite(inviteId, user.uid);
      Toast.show({
        type: 'info',
        text1: 'Invite revoked',
        text2: 'The link can no longer be used.',
        position: 'top',
        topOffset: 60,
      });
    } catch (revokeError) {
      logger.warn('TenantInviteManager: revoke failed', revokeError);
      Toast.show({
        type: 'error',
        text1: 'Unable to revoke',
        text2: revokeError instanceof Error ? revokeError.message : 'Please try again.',
        position: 'top',
        topOffset: 60,
      });
    } finally {
      setRevokingInviteId(null);
    }
  };

  const handleResendInvite = async (invite: TenantInvite) => {
    if (!user?.uid || !activeTenant?.id) {
      Alert.alert('Unable to resend', 'Sign in again to manage invites.');
      return;
    }
    if (invite.status !== 'pending') {
      Toast.show({
        type: 'info',
        text1: 'Invite is closed',
        text2: 'Only pending invites can be resent.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    setResendingInviteId(invite.id);
    try {
      await tenantService.resendInvite(invite.id, user.uid);
      Toast.show({
        type: 'success',
        text1: 'Invite email sent',
        text2: `We re-sent the invite to ${invite.email}.`,
        position: 'top',
        topOffset: 60,
      });
    } catch (resendError) {
      logger.warn('TenantInviteManager: resend failed', resendError);
      Toast.show({
        type: 'error',
        text1: 'Unable to resend',
        text2: resendError instanceof Error ? resendError.message : 'Please try again later.',
        position: 'top',
        topOffset: 60,
      });
    } finally {
      setResendingInviteId(null);
    }
  };

  const handleLoadMoreInvites = useCallback(() => {
    setVisibleInviteCount((prev) => Math.min(prev + INVITE_PAGE_SIZE, filteredInviteCount));
  }, [filteredInviteCount]);

  if (!canManageInvites) {
    return null;
  }

  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <MailPlus size={18} color={theme.primary} />
          <Text style={[styles.title, { color: theme.text }]}>Team invites</Text>
        </View>
        <TouchableOpacity
          style={[styles.iconButton, { opacity: seatsFull ? 0.5 : 1 }]}
          onPress={openModal}
          disabled={seatsFull}
        >
          <Text style={[styles.iconButtonText, { color: theme.primary }]}>Invite</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        style={styles.filterScroll}
      >
        {inviteFilterOptions.map(({ id, label }) => {
          const active = statusFilter === id;
          return (
            <TouchableOpacity
              key={id}
              style={[
                styles.filterChip,
                {
                  borderColor: active ? theme.primary : theme.border,
                  backgroundColor: active ? `${theme.primary}12` : 'transparent',
                },
              ]}
              onPress={() => setStatusFilter(id)}
            >
              <Text style={[styles.filterChipLabel, { color: active ? theme.primary : theme.text }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <Text style={[styles.filterSummary, { color: theme.textSecondary }]}>
        {statusFilter === 'all'
          ? `${filteredInviteCount} invite${filteredInviteCount === 1 ? '' : 's'} total`
          : `${filteredInviteCount} ${statusFilter} invite${filteredInviteCount === 1 ? '' : 's'}`}
      </Text>

      {seatsFull && (
        <View style={[styles.alertRow, { backgroundColor: `${theme.warning}10` }]}> 
          <AlertCircle size={16} color={theme.warning} />
          <Text style={[styles.alertText, { color: theme.warning }]}>
            You’ve used all {seatLimit} staff seats (Active: {activeSeatCount}, Pending invites: {pendingSeatInviteCount}). Remove a member, revoke a pending invite, or upgrade to invite more teammates.
          </Text>
          <TouchableOpacity
            onPress={() => (onUpgradePress ? onUpgradePress() : router.push('/(tabs)/plan'))}
            style={[styles.actionButton, { borderColor: theme.warning, marginLeft: 8 }]}
          >
            <Text style={[styles.actionButtonText, { color: theme.warning }]}>Upgrade</Text>
          </TouchableOpacity>
        </View>
      )}

      {error && (
        <View style={[styles.alertRow, { backgroundColor: `${theme.error}10` }]}> 
          <AlertCircle size={16} color={theme.error} />
          <Text style={[styles.alertText, { color: theme.error }]}>{error}</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading invites…</Text>
        </View>
      ) : filteredInvites.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}> 
            {invites.length === 0 ? 'No team invites yet' : 'No invites match this filter'}
          </Text>
          <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}> 
            {invites.length === 0
              ? 'Invite your staff to collaborate.'
              : 'Try selecting a different status to continue.'}
          </Text>
        </View>
      ) : (
        <>
        <View style={styles.listWindow}>
          <ScrollView
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
            style={styles.listWindowScroll}
            contentContainerStyle={styles.listWindowContent}
          >
        {visibleInvites.map((invite) => {
          const statusColors = statusChipColor(invite.status, theme);
          const expiresAtDate = parseIsoDate(invite.expiresAt);
          const lastSentAtDate = parseIsoDate(invite.lastSentAt);
          const shouldShowExpiry = invite.status === 'pending' || invite.status === 'expired';
          const copyActive = copiedInviteId === invite.id;
          const successColor = theme.success ?? theme.primary;
          return (
            <View key={invite.id} style={[styles.inviteCard, { borderColor: theme.border }]}> 
              <View style={styles.inviteHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.inviteEmail, { color: theme.text }]}>{invite.email}</Text>
                  <Text style={[styles.inviteSubtext, { color: theme.textSecondary }]}>Role · {invite.role}</Text>
                </View>
                <View
                  style={[styles.statusChip, { backgroundColor: statusColors.backgroundColor }]}
                >
                  <Text style={[styles.statusChipText, { color: statusColors.color }]}>
                    {statusLabel[invite.status]}
                  </Text>
                </View>
              </View>
              <View style={styles.inviteMetaRow}>
                {shouldShowExpiry && expiresAtDate && (
                  <Text style={[styles.inviteMeta, { color: theme.textSecondary }]}> 
                    {invite.status === 'expired' ? 'Expired' : 'Expires'} {formatDateToString(expiresAtDate)}
                  </Text>
                )}
                {lastSentAtDate && (
                  <Text style={[styles.inviteMeta, { color: theme.textSecondary }]}>Last sent {formatDateToString(lastSentAtDate)}</Text>
                )}
                {!!invite.invitationMessage && (
                  <Text style={[styles.inviteMeta, { color: theme.textSecondary }]}>Memo: {invite.invitationMessage}</Text>
                )}
              </View>
              <View style={styles.inviteActions}>
                <TouchableOpacity
                  style={[styles.actionButton, { borderColor: theme.border }]}
                  onPress={() => handleCopyLink(invite)}
                >
                  {copyActive ? (
                    <Check size={16} color={successColor} />
                  ) : (
                    <Link2 size={16} color={theme.textSecondary} />
                  )}
                  <Text
                    style={[
                      styles.actionButtonText,
                      { color: copyActive ? successColor : theme.textSecondary },
                    ]}
                  >
                    {copyActive ? 'Copied' : 'Copy link'}
                  </Text>
                </TouchableOpacity>
                {invite.status === 'pending' && (
                  <>
                    <TouchableOpacity
                      style={[styles.actionButton, { borderColor: theme.border }]}
                      onPress={() => confirmResendInvite(invite)}
                      disabled={resendingInviteId === invite.id}
                    >
                      {resendingInviteId === invite.id ? (
                        <ActivityIndicator size="small" color={theme.primary} />
                      ) : (
                        <RefreshCw size={16} color={theme.textSecondary} />
                      )}
                      <Text style={[styles.actionButtonText, { color: theme.textSecondary }]}>Resend</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.actionButton, { borderColor: theme.border }]}
                      onPress={() => confirmRevokeInvite(invite)}
                      disabled={revokingInviteId === invite.id}
                    >
                      {revokingInviteId === invite.id ? (
                        <ActivityIndicator size="small" color={theme.error} />
                      ) : (
                        <Text style={[styles.actionButtonText, { color: theme.error }]}>Revoke</Text>
                      )}
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          );
        })}
        </ScrollView>
        </View>
        {filteredInvites.length > visibleInvites.length && (
          <TouchableOpacity
            style={[styles.loadMoreButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
            onPress={handleLoadMoreInvites}
          >
            <Text style={[styles.loadMoreButtonText, { color: theme.primary }]}>Load more invites</Text>
          </TouchableOpacity>
        )}
        </>
      )}

      <Modal
        visible={inviteModalVisible}
        animationType="slide"
        onRequestClose={closeModal}
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}> 
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}> 
            <TouchableOpacity onPress={closeModal}>
              <X size={22} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Invite teammate</Text>
            <View style={{ width: 22 }} />
          </View>
          <ScrollView
            contentContainerStyle={[
              styles.modalContent,
              { paddingBottom: Platform.select({ web: 0, default: 20 }) },
            ]}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[styles.modalDescription, { color: theme.textSecondary }]}> 
              Send a private invite link to give a teammate access to this coaching center.
            </Text>

            <Text style={[styles.modalLabel, { color: theme.text }]}>Email address *</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={formEmail}
              placeholder="teammate@example.com"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
              onChangeText={setFormEmail}
            />

            <Text style={[styles.modalLabel, { color: theme.text }]}>Role</Text>
            <View style={styles.roleChipRow}>
              {ROLE_OPTIONS.map((role) => {
                const active = formRole === role;
                return (
                  <TouchableOpacity
                    key={role}
                    style={[
                      styles.roleChip,
                      {
                        backgroundColor: active ? theme.primary : theme.surface,
                        borderColor: active ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setFormRole(role)}
                  >
                    <Text
                      style={[
                        styles.roleChipText,
                        { color: active ? '#fff' : theme.text },
                      ]}
                    >
                      {role.charAt(0).toUpperCase() + role.slice(1)}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.modalLabel, { color: theme.text }]}>Expires in</Text>
            <View style={styles.roleChipRow}>
              {EXPIRY_OPTIONS.map((days) => {
                const active = formExpiresInDays === days;
                return (
                  <TouchableOpacity
                    key={days}
                    style={[
                      styles.roleChip,
                      {
                        backgroundColor: active ? theme.primary : theme.surface,
                        borderColor: active ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setFormExpiresInDays(days)}
                  >
                    <Text
                      style={[
                        styles.roleChipText,
                        { color: active ? '#fff' : theme.text },
                      ]}
                    >
                      {days} days
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[styles.modalLabel, { color: theme.text }]}>Message (optional)</Text>
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: theme.border,
                  color: theme.text,
                  backgroundColor: theme.surface,
                  height: 100,
                  textAlignVertical: 'top',
                },
              ]}
              multiline
              value={formMessage}
              placeholder="Add context for your teammate"
              placeholderTextColor={theme.textSecondary}
              onChangeText={setFormMessage}
            />

            {formError && (
              <View style={[styles.alertRow, { backgroundColor: `${theme.error}10` }]}> 
                <AlertCircle size={16} color={theme.error} />
                <Text style={[styles.alertText, { color: theme.error }]}>{formError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.primaryButton,
                {
                  backgroundColor: theme.primary,
                  opacity: formEmail.trim() ? 1 : 0.6,
                },
              ]}
              onPress={handleCreateInvite}
              disabled={creatingInvite || !formEmail.trim()}
            >
              {creatingInvite ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>Send invite</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={!!pendingResendInvite}
        transparent
        animationType="fade"
        onRequestClose={dismissResendModal}
      >
        <View style={styles.confirmBackdrop}>
          <View style={[styles.confirmCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.confirmTitle, { color: theme.text }]}>Resend invite?</Text>
            <Text style={[styles.confirmBody, { color: theme.textSecondary }]}> 
              {pendingResendInvite
                ? `We’ll send a fresh invite email to ${pendingResendInvite.email}.`
                : 'We’ll send a fresh invite email.'}
            </Text>
            <View style={styles.confirmActions}>
              <TouchableOpacity
                style={[styles.confirmSecondary, { borderColor: theme.border }]}
                onPress={dismissResendModal}
                disabled={resendingInviteId === pendingResendInvite?.id}
              >
                <Text style={[styles.confirmSecondaryText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmPrimary, { backgroundColor: theme.primary }]}
                onPress={handleConfirmResend}
                disabled={resendingInviteId === pendingResendInvite?.id}
                activeOpacity={0.9}
              >
                {resendingInviteId === pendingResendInvite?.id ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.confirmPrimaryText}>Resend email</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!pendingRevokeInvite}
        transparent
        animationType="fade"
        onRequestClose={dismissRevokeModal}
      >
        <View style={styles.confirmBackdrop}>
          <View style={[styles.confirmCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
            <Text style={[styles.confirmTitle, { color: theme.text }]}>Revoke invite?</Text>
            <Text style={[styles.confirmBody, { color: theme.textSecondary }]}> 
              {pendingRevokeInvite
                ? `This removes access for ${pendingRevokeInvite.email}. Their link will immediately stop working.`
                : 'This removes access to the invite link.'}
            </Text>
            <View style={styles.confirmActions}>
              <TouchableOpacity
                style={[styles.confirmSecondary, { borderColor: theme.border }]}
                onPress={dismissRevokeModal}
                disabled={!!revokingInviteId}
              >
                <Text style={[styles.confirmSecondaryText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmPrimary, { backgroundColor: theme.error }]}
                onPress={handleConfirmRevoke}
                disabled={revokingInviteId === pendingRevokeInvite?.id}
                activeOpacity={0.9}
              >
                {revokingInviteId === pendingRevokeInvite?.id ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.confirmPrimaryText}>Revoke invite</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
});

TenantInviteManager.displayName = 'TenantInviteManager';

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginTop: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    marginLeft: 8,
    fontSize: 16,
    fontWeight: '600',
  },
  iconButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  iconButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  filterScroll: {
    marginVertical: 8,
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    paddingRight: 8,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  filterChipLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  filterSummary: {
    fontSize: 12,
    marginBottom: 8,
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
  },
  alertText: {
    marginLeft: 8,
    fontSize: 13,
    flex: 1,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  loadingText: {
    marginLeft: 8,
    fontSize: 13,
  },
  emptyState: {
    paddingVertical: 12,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 13,
  },
  inviteCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  inviteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inviteEmail: {
    fontSize: 15,
    fontWeight: '600',
  },
  inviteSubtext: {
    fontSize: 13,
    marginTop: 2,
  },
  statusChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  inviteMetaRow: {
    marginTop: 8,
  },
  inviteMeta: {
    fontSize: 12,
  },
  inviteActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 12,
    gap: 8,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  actionButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  loadMoreButton: {
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadMoreButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  listWindow: {
    maxHeight: 360,
    width: '100%',
    overflow: 'hidden',
  },
  listWindowScroll: {
    flexGrow: 0,
  },
  listWindowContent: {
    paddingBottom: 8,
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  modalContent: {
    padding: 20,
    paddingBottom: 40,
  },
  modalDescription: {
    fontSize: 13,
    marginBottom: 16,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  roleChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
    gap: 8,
  },
  roleChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  roleChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 15,
    marginBottom: 12,
  },
  primaryButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  confirmBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  confirmCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 24,
    padding: 24,
    gap: 16,
  },
  confirmTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  confirmBody: {
    fontSize: 15,
    lineHeight: 22,
  },
  confirmActions: {
    flexDirection: 'row',
    gap: 12,
  },
  confirmSecondary: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmSecondaryText: {
    fontSize: 15,
    fontWeight: '600',
  },
  confirmPrimary: {
    flex: 1,
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmPrimaryText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});

export default TenantInviteManager;
