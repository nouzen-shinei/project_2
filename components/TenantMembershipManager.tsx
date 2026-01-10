import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  Clock,
  Plus,
  RefreshCcw,
  Search,
  Users,
  X,
} from 'lucide-react-native';

import * as ImagePicker from 'expo-image-picker';
import { useTenant } from '@/hooks/useTenantContext';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@/hooks/useAuthUnified';
import { logger } from '@/lib/logger';
import { formatDateToString } from '@/lib/utils';
import {
  tenantBackendClient,
  TenantBackendError,
  TenantJoinCodeClaimResponse,
  TenantJoinCodePreviewResponse,
} from '@/services/tenantBackendClient';
import { tenantService } from '@/services/tenantService';
import { uploadTenantLogo, TENANT_LOGO_MAX_BYTES, TenantLogoAsset } from '@/services/tenantBrandingService';
import type { Tenant, TenantMembership, TenantMembershipStatus, TenantMembershipStatusEvent } from '@/types';
import ConfirmationModal from './ConfirmationModal';

interface CreateTenantFormState {
  name: string;
  address: string;
  timezone: string;
  defaultCurrency: string;
  contactEmail: string;
  contactPhone: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  staff: 'Staff',
  member: 'Member',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  pending_invite: 'Pending invite',
  pending_request: 'Pending approval',
  revoked: 'Revoked',
  rejected: 'Rejected',
};

interface MembershipRow {
  membership: ReturnType<typeof useTenant>['memberships'][number];
  tenant: Tenant | null;
}

interface LeaveConfirmContext {
  tenantId: string;
  tenantName?: string;
  pending?: boolean;
}

const sanitizeCode = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
const LOGO_SIZE_LIMIT_MB = Math.round(TENANT_LOGO_MAX_BYTES / (1024 * 1024));
const formatStatusLabel = (value?: string | null) => {
  if (!value) {
    return 'Pending';
  }
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
};

const parseIsoDate = (value?: string | null): Date | null => {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const STATUS_REASON_LABELS: Record<string, string> = {
  tenant_owner_created: 'Owner added automatically',
  membership_created: 'Membership created',
  join_code_claim: 'Requested via join code',
  join_request_approved: 'Approved by admin',
  join_request_rejected: 'Rejected by admin',
  invite_received: 'Invite received',
  invite_accepted: 'Invite accepted',
  invite_rejected_by_user: 'Invite rejected',
  invite_revoked: 'Invite revoked',
  invite_expired: 'Invite expired',
  membership_revoked: 'Access revoked',
  self_leave: 'Left by user',
};

const formatStatusHistoryReason = (reason?: string | null): string | null => {
  if (!reason) {
    return null;
  }
  const direct = STATUS_REASON_LABELS[reason];
  if (direct) {
    return direct;
  }
  if (reason.startsWith('status_changed_from_')) {
    const previous = reason.replace('status_changed_from_', '');
    return `Changed from ${formatStatusLabel(previous)}`;
  }
  return reason.replace(/_/g, ' ');
};

const formatStatusHistoryDetail = (event: TenantMembershipStatusEvent): string | null => {
  const parts: string[] = [];
  const reasonLabel = formatStatusHistoryReason(event.reason);
  if (reasonLabel) {
    parts.push(reasonLabel);
  }
  const actorLabel = event.actorName || event.actorEmail;
  if (actorLabel) {
    parts.push(actorLabel);
  }
  return parts.length ? parts.join(' • ') : null;
};

interface StatusTimelineItem {
  id: string;
  status: TenantMembershipStatus;
  label: string;
  isoDate: string;
  displayDate: string;
  detail?: string | null;
}

const buildMembershipTimeline = (membership: TenantMembership): StatusTimelineItem[] => {
  const fallbackAt = membership.updatedAt || membership.createdAt || new Date().toISOString();
  const history = Array.isArray(membership.statusHistory) ? membership.statusHistory : [];
  const events: TenantMembershipStatusEvent[] = history.length
    ? [...history]
    : [{ status: membership.status, at: fallbackAt } satisfies TenantMembershipStatusEvent];
  const hasCurrentStatus = events.some((event) => event.status === membership.status);
  if (!hasCurrentStatus) {
    events.unshift({ status: membership.status, at: fallbackAt });
  }
  const items: StatusTimelineItem[] = [];

  events.forEach((event, index) => {
    if (!event?.status) {
      return;
    }
    const atIso = typeof event.at === 'string' ? event.at : fallbackAt;
    const parsed = parseIsoDate(atIso) || parseIsoDate(fallbackAt);
    if (!parsed) {
      return;
    }
    items.push({
      id: `${membership.id}-${event.status}-${index}-${atIso}`,
      status: event.status,
      label: STATUS_LABELS[event.status] || formatStatusLabel(event.status),
      isoDate: parsed.toISOString(),
      displayDate: formatDateToString(parsed),
      detail: formatStatusHistoryDetail(event),
    });
  });

  return items.sort((a, b) => (a.isoDate < b.isoDate ? 1 : -1));
};

const TenantMembershipManager = () => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const {
    memberships,
    tenants,
    activeMembership,
    loading,
    error,
    selectTenant,
    refreshTenants,
  } = useTenant();

  const [incomingInviteError, setIncomingInviteError] = useState<string | null>(null);
  const [incomingInviteLoading, setIncomingInviteLoading] = useState(false);
  const [acceptingInviteMembershipId, setAcceptingInviteMembershipId] = useState<string | null>(null);
  const [rejectingInviteMembershipId, setRejectingInviteMembershipId] = useState<string | null>(null);

  const getStatusColor = useCallback(
    (status: string) => {
      if (status === 'active') {
        return theme.success;
      }
      if (status === 'rejected') {
        return theme.error;
      }
      if (status === 'revoked') {
        return theme.textSecondary;
      }
      return theme.warning;
    },
    [theme.error, theme.success, theme.textSecondary, theme.warning],
  );

  const tenantMap = useMemo(() => {
    return tenants.reduce<Record<string, Tenant>>((acc, tenant) => {
      acc[tenant.id] = tenant;
      return acc;
    }, {});
  }, [tenants]);

  useEffect(() => {
    const email = user?.email?.trim().toLowerCase();
    if (!email) {
      setIncomingInviteError(null);
      setIncomingInviteLoading(false);
      return;
    }

    setIncomingInviteLoading(true);
    const unsubscribe = tenantService.listenToIncomingInvites(
      email,
      (invites) => {
        setIncomingInviteError(null);
        setIncomingInviteLoading(false);

        // Merge invite status into tenantMemberships/{tenantId}_{uid} so the UI shows a single
        // entry per coaching center, just like join-code claim updates the existing membership doc.
        if (user?.uid) {
          void tenantService
            .syncIncomingInvitesToMembershipsForUser({
              userId: user.uid,
              email,
              displayName: user.displayName || undefined,
              invites,
            })
            .catch((error) => logger.warn('TenantMembershipManager: invite->membership sync failed', error));
        }
      },
      (error) => {
        logger.warn('TenantMembershipManager: incoming invite listen failed', error);
        setIncomingInviteError('Unable to load invitations.');
        setIncomingInviteLoading(false);
      },
    );
    return unsubscribe;
  }, [user?.displayName, user?.email, user?.uid]);

  const membershipRows = useMemo<MembershipRow[]>(() => {
    return memberships.map((membership) => ({
      membership,
      tenant: tenantMap[membership.tenantId] || null,
    }));
  }, [memberships, tenantMap]);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'pending' | 'rejected' | 'revoked'>('all');

  const filteredMembershipRows = useMemo(() => {
    const queryValue = searchQuery.trim().toLowerCase();
    return membershipRows.filter(({ membership, tenant }) => {
      const status = membership.status;

      if (statusFilter === 'active' && status !== 'active') {
        return false;
      }
      if (statusFilter === 'pending') {
        const isPending = status === 'pending_invite' || status === 'pending_request';
        if (!isPending) {
          return false;
        }
      }
      if (statusFilter === 'rejected' && status !== 'rejected') {
        return false;
      }
      if (statusFilter === 'revoked' && status !== 'revoked') {
        return false;
      }
      if (!queryValue) {
        return true;
      }

      const haystack = [
        tenant?.name,
        tenant?.slug,
        tenant?.code,
        membership.tenantId,
        membership.email,
        membership.role,
        membership.status,
      ]
        .filter(Boolean)
        .map((value) => value!.toLowerCase());
      return haystack.some((value) => value.includes(queryValue));
    });
  }, [membershipRows, searchQuery, statusFilter]);

  const pendingCount = useMemo(() => {
    return membershipRows.filter(({ membership }) =>
      membership.status === 'pending_invite' || membership.status === 'pending_request'
    ).length;
  }, [membershipRows]);

  const activeCount = useMemo(() => {
    return membershipRows.filter(({ membership }) => membership.status === 'active').length;
  }, [membershipRows]);

  const rejectedCount = useMemo(() => {
    return membershipRows.filter(({ membership }) => membership.status === 'rejected').length;
  }, [membershipRows]);

  const revokedCount = useMemo(() => {
    return membershipRows.filter(({ membership }) => membership.status === 'revoked').length;
  }, [membershipRows]);

  const pendingRequestRows = useMemo(
    () => membershipRows.filter(({ membership }) => membership.status === 'pending_request'),
    [membershipRows],
  );

  const pendingBannerTitle = useMemo(() => {
    if (!pendingRequestRows.length) {
      return null;
    }
    if (pendingRequestRows.length === 1) {
      const name = pendingRequestRows[0].tenant?.name;
      return name ? `Waiting for ${name}` : 'Request pending approval';
    }
    return 'Requests awaiting approval';
  }, [pendingRequestRows]);

  const pendingBannerCopy = useMemo(() => {
    if (!pendingRequestRows.length) {
      return null;
    }
    if (pendingRequestRows.length === 1) {
      return 'We notified the coaching center. We\'ll email you as soon as an admin responds.';
    }
    return `We notified all ${pendingRequestRows.length} coaching centers. We\'ll email you as soon as admins respond.`;
  }, [pendingRequestRows]);

  const [refreshing, setRefreshing] = useState(false);
  const [switchingTenantId, setSwitchingTenantId] = useState<string | null>(null);
  const [leavingTenantId, setLeavingTenantId] = useState<string | null>(null);
  const [leaveConfirmContext, setLeaveConfirmContext] = useState<LeaveConfirmContext | null>(null);
  const [expandedTimelines, setExpandedTimelines] = useState<Record<string, boolean>>({});

  const handleRefresh = useCallback(async () => {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    try {
      await refreshTenants();
    } catch (refreshError) {
      logger.warn('TenantMembershipManager: refresh failed', refreshError);
    } finally {
      setRefreshing(false);
    }
  }, [refreshTenants, refreshing]);

  const handleSelectTenant = useCallback(
    async (tenantId: string) => {
      if (switchingTenantId === tenantId) {
        return;
      }
      setSwitchingTenantId(tenantId);
      try {
        await selectTenant(tenantId);
      } catch (selectError) {
        logger.warn('TenantMembershipManager: failed to switch tenant', selectError);
      } finally {
        setSwitchingTenantId(null);
      }
    },
    [selectTenant, switchingTenantId],
  );


  const handleAcceptPendingInviteMembership = useCallback(
    async (membership: TenantMembership) => {
      if (!user?.uid || !user.email) {
        Alert.alert('Sign in required', 'Sign in again to accept this invite.');
        return;
      }
      const token = typeof membership.inviteToken === 'string' ? membership.inviteToken.trim() : '';
      if (!token) {
        Alert.alert('Invite missing', 'This invite link is missing. Ask an admin for a fresh invite.');
        return;
      }
      if (acceptingInviteMembershipId === membership.id) {
        return;
      }
      setAcceptingInviteMembershipId(membership.id);
      try {
        await tenantService.acceptInvite(token);
        await refreshTenants();
        await selectTenant(membership.tenantId);
        Alert.alert('Invite accepted', 'You now have access to this coaching center.');
      } catch (error) {
        logger.warn('TenantMembershipManager: accept invite failed', error);
        Alert.alert('Unable to accept invite', error instanceof Error ? error.message : 'Please try again.');
      } finally {
        setAcceptingInviteMembershipId(null);
      }
    },
    [acceptingInviteMembershipId, refreshTenants, selectTenant, user?.email, user?.uid],
  );

  const handleRejectPendingInviteMembership = useCallback(
    async (membership: TenantMembership) => {
      if (!user?.uid) {
        Alert.alert('Sign in required', 'Sign in again to reject this invite.');
        return;
      }
      const token = typeof membership.inviteToken === 'string' ? membership.inviteToken.trim() : '';
      if (!token) {
        Alert.alert('Invite missing', 'This invite link is missing. Ask an admin for a fresh invite.');
        return;
      }
      if (rejectingInviteMembershipId === membership.id) {
        return;
      }
      setRejectingInviteMembershipId(membership.id);
      try {
        await tenantService.rejectInviteByToken(token, user.uid);
        // Membership doc will be updated by the invite->membership sync listener.
        await refreshTenants();
        Alert.alert('Invite rejected', 'This invite was moved to Rejected.');
      } catch (error) {
        logger.warn('TenantMembershipManager: reject invite failed', error);
        Alert.alert('Unable to reject invite', error instanceof Error ? error.message : 'Please try again.');
      } finally {
        setRejectingInviteMembershipId(null);
      }
    },
    [refreshTenants, rejectingInviteMembershipId, user?.uid],
  );

  const leaveTenant = useCallback(
    async (tenantId: string, tenantName?: string) => {
      if (!user?.uid) {
        Alert.alert('Unable to leave', 'Sign in again to manage coaching center access.');
        return;
      }
      setLeavingTenantId(tenantId);
      try {
        await tenantService.leaveMembership(tenantId, user.uid, user.email || undefined, {
          tenantName,
        });
        await refreshTenants();
      } catch (leaveError) {
        logger.warn('TenantMembershipManager: leave center failed', leaveError);
        const message = leaveError instanceof Error ? leaveError.message : 'Failed to leave coaching center.';
        Alert.alert('Unable to leave', message);
      } finally {
        setLeavingTenantId(null);
      }
    },
    [refreshTenants, user?.email, user?.uid],
  );

  const confirmLeaveTenant = useCallback(
    (tenantId: string, tenantName?: string, options?: { pending?: boolean }) => {
      setLeaveConfirmContext({ tenantId, tenantName, pending: Boolean(options?.pending) });
    },
    [],
  );

  const closeLeaveConfirmModal = useCallback(() => {
    setLeaveConfirmContext(null);
  }, []);

  const handleConfirmLeave = useCallback(async () => {
    if (!leaveConfirmContext) {
      return;
    }
    await leaveTenant(leaveConfirmContext.tenantId, leaveConfirmContext.tenantName);
    setLeaveConfirmContext(null);
  }, [leaveConfirmContext, leaveTenant]);

  const leaveWarningMessage = leaveConfirmContext?.pending
    ? null
    : 'Leaving removes your access to classes, chat, attendance, and reports right away. Owners must transfer or downgrade their role before leaving.';
  const toggleTimeline = useCallback((membershipId: string) => {
    setExpandedTimelines((prev) => ({
      ...prev,
      [membershipId]: !prev[membershipId],
    }));
  }, []);

  const [joinModalVisible, setJoinModalVisible] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinPreview, setJoinPreview] = useState<TenantJoinCodePreviewResponse | null>(null);
  const [joinSuccess, setJoinSuccess] = useState<TenantJoinCodeClaimResponse | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [checkingCode, setCheckingCode] = useState(false);
  const [claimingCode, setClaimingCode] = useState(false);

  const deviceTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch (error) {
      logger.warn('TenantMembershipManager: failed to detect timezone', error);
      return 'UTC';
    }
  }, []);

  const buildBlankCreateForm = (): CreateTenantFormState => ({
    name: '',
    address: '',
    timezone: deviceTimezone,
    defaultCurrency: 'INR',
    contactEmail: user?.email || '',
    contactPhone: '',
  });

  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [createForm, setCreateForm] = useState<CreateTenantFormState>(() => buildBlankCreateForm());
  const [creatingTenant, setCreatingTenant] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createLogoAsset, setCreateLogoAsset] = useState<TenantLogoAsset | null>(null);
  const [createLogoPreviewUrl, setCreateLogoPreviewUrl] = useState<string | null>(null);
  const [pickingCreateLogo, setPickingCreateLogo] = useState(false);

  const normalizedCode = sanitizeCode(joinCode);
  const canSubmitCode = normalizedCode.length >= 5;
  const membershipStatus = joinPreview?.membership?.status;
  const alreadyMember = membershipStatus === 'active';
  const alreadyInvitePending = membershipStatus === 'pending_invite' || joinPreview?.pendingInvite === true;
  const alreadyPendingRequest = membershipStatus === 'pending_request';
  const alreadyPending = alreadyInvitePending || alreadyPendingRequest;

  const resetJoinModalState = () => {
    setJoinCode('');
    setJoinPreview(null);
    setJoinSuccess(null);
    setJoinError(null);
    setCheckingCode(false);
    setClaimingCode(false);
  };

  const openJoinModal = () => {
    resetJoinModalState();
    setJoinModalVisible(true);
  };

  const closeJoinModal = () => {
    setJoinModalVisible(false);
  };

  const resetCreateForm = () => {
    setCreateForm(buildBlankCreateForm());
    setCreateError(null);
    setCreateLogoAsset(null);
    setCreateLogoPreviewUrl(null);
  };

  const openCreateModal = () => {
    resetCreateForm();
    setCreateModalVisible(true);
  };

  const closeCreateModal = () => {
    setCreateModalVisible(false);
  };

  const handleCreateFieldChange = (field: keyof CreateTenantFormState, value: string) => {
    setCreateForm((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handlePickCreateLogo = async () => {
    if (pickingCreateLogo) {
      return;
    }
    setPickingCreateLogo(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Permission needed', 'Allow photo library access to pick a logo.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.85,
      });
      if (result.canceled || !result.assets?.length) {
        return;
      }
      const asset = result.assets[0];
      if (!asset.uri) {
        Alert.alert('Invalid image', 'Unable to use that image. Please pick another logo.');
        return;
      }
      setCreateLogoAsset({
        uri: asset.uri,
        mimeType: asset.mimeType,
        fileName: asset.fileName || undefined,
      });
      setCreateLogoPreviewUrl(asset.uri);
    } catch (pickerError) {
      logger.warn('TenantMembershipManager: logo picker failed', pickerError);
      Alert.alert('Unable to pick logo', 'Something went wrong while choosing that image.');
    } finally {
      setPickingCreateLogo(false);
    }
  };

  const handleRemoveCreateLogo = () => {
    setCreateLogoAsset(null);
    setCreateLogoPreviewUrl(null);
  };

  const handleLookupCode = async () => {
    if (!canSubmitCode) {
      setJoinError('Enter a valid join code to continue.');
      setJoinPreview(null);
      return;
    }
    setCheckingCode(true);
    setJoinError(null);
    setJoinSuccess(null);
    try {
      const preview = await tenantBackendClient.resolveJoinCode(normalizedCode);
      setJoinPreview(preview);
    } catch (lookupError) {
      if (lookupError instanceof TenantBackendError) {
        setJoinError(lookupError.message);
      } else {
        setJoinError('Unable to look up that join code right now.');
      }
      setJoinPreview(null);
    } finally {
      setCheckingCode(false);
    }
  };

  const handleClaimCode = async () => {
    if (!joinPreview || alreadyMember || alreadyPending) {
      return;
    }
    setClaimingCode(true);
    setJoinError(null);
    try {
      const response = await tenantBackendClient.claimJoinCode({
        code: normalizedCode,
        displayName: user?.displayName || undefined,
      });
      setJoinSuccess(response);
      setJoinPreview({
        tenant: response.tenant,
        code: {
          id: response.code.id,
          status: response.code.status || 'active',
          createdAt: response.code.createdAt || null,
          expiresAt: response.code.expiresAt || null,
          lastUsedAt: response.code.lastUsedAt || null,
          usageCount: response.code.usageCount ?? 0,
          usageCap: response.code.usageCap ?? null,
        },
        membership: response.membership,
      });
      await refreshTenants();
    } catch (claimError) {
      if (claimError instanceof TenantBackendError) {
        if (claimError.code === 'invite_pending') {
          Alert.alert(
            'Invite already waiting',
            'You already have a pending invite for this coaching center. Accept it from the Pending tab instead of using a join code.',
            [
              {
                text: 'View pending',
                onPress: () => {
                  setJoinModalVisible(false);
                  setStatusFilter('pending');
                },
              },
              { text: 'OK' },
            ],
          );
          return;
        }
        setJoinError(claimError.message);
      } else {
        setJoinError('Unable to join that coaching center right now.');
      }
    } finally {
      setClaimingCode(false);
    }
  };

  const handleCreateTenant = async () => {
    if (!user?.uid || !user.email) {
      Alert.alert('Unable to create', 'Sign in again to create a coaching center.');
      return;
    }

    if (!createForm.name.trim()) {
      setCreateError('Center name is required.');
      return;
    }

    if (!createForm.timezone.trim()) {
      setCreateError('Timezone is required.');
      return;
    }

    setCreatingTenant(true);
    setCreateError(null);
    try {
      const tenant = await tenantService.createTenant({
        name: createForm.name.trim(),
        ownerUserId: user.uid,
        ownerEmail: user.email,
        address: createForm.address.trim() || undefined,
        timezone: createForm.timezone.trim() || undefined,
        defaultCurrency: createForm.defaultCurrency.trim() || undefined,
        contactEmail: createForm.contactEmail.trim() || user.email,
        contactPhone: createForm.contactPhone.trim() || undefined,
      });
      if (createLogoAsset) {
        try {
          const uploadResult = await uploadTenantLogo(tenant.id, createLogoAsset);
          if (uploadResult.url) {
            await tenantService.updateTenant({
              id: tenant.id,
              logoUrl: uploadResult.url,
              branding: { ...(tenant.branding || {}), logoUrl: uploadResult.url },
              updatedBy: user.uid,
            });
          } else if (uploadResult.skippedBecauseStorageLimit) {
            Alert.alert(
              'Logo upload skipped',
              'The center was created, but the logo upload was skipped because your storage limit was reached. Clear space and try again from Admin Settings.',
            );
          } else {
            Alert.alert(
              'Logo upload failed',
              'The center was created but the logo could not be uploaded. Try again from Admin Settings.',
            );
          }
        } catch (logoError) {
          logger.warn('TenantMembershipManager: tenant logo upload failed', logoError);
          Alert.alert(
            'Logo upload failed',
            'The center was created but the logo could not be uploaded. Try again from Admin Settings.',
          );
        }
      }
      await refreshTenants();
      await selectTenant(tenant.id);
      resetCreateForm();
      setCreateModalVisible(false);
      Alert.alert('Coaching center created', `${tenant.name} is ready to use. You are the owner.`);
    } catch (createTenantError) {
      logger.warn('TenantMembershipManager: create center failed', createTenantError);
      const message =
        createTenantError instanceof Error
          ? createTenantError.message
          : 'Failed to create coaching center.';
      setCreateError(message);
    } finally {
      setCreatingTenant(false);
    }
  };

  const renderStatusBadge = (status: string) => {
    const label = STATUS_LABELS[status] || status;
    const color = getStatusColor(status);
    return (
      <View style={[styles.statusBadge, { backgroundColor: `${color}1A` }]}> 
        <Text style={[styles.statusBadgeText, { color }]}>{label}</Text>
      </View>
    );
  };

  const renderMembershipCard = (row: MembershipRow) => {
    const { membership, tenant } = row;
    const isCurrent = activeMembership?.tenantId === membership.tenantId;
    const canSwitch = membership.status === 'active' && !isCurrent;
    const canLeave = membership.role !== 'owner';
    const isPendingRequest = membership.status === 'pending_request';
    const isRejected = membership.status === 'rejected';
    const isRevoked = membership.status === 'revoked';

    const revokedReason = (() => {
      if (!isRevoked) return null;
      const history = Array.isArray(membership.statusHistory) ? membership.statusHistory : [];
      for (let i = history.length - 1; i >= 0; i -= 1) {
        const event = history[i];
        if (event?.status === 'revoked' && typeof event.reason === 'string' && event.reason) {
          return event.reason;
        }
      }
      return null;
    })();

    const statusDate = parseIsoDate(membership.updatedAt || membership.createdAt);
    const pendingTimelineLabel = statusDate ? `Requested ${formatDateToString(statusDate)}` : 'Request submitted';
    const rejectionTimelineLabel = statusDate ? `Reviewed ${formatDateToString(statusDate)}` : 'Request reviewed';
    const revokedTimelineLabel = (() => {
      const base = statusDate ? `Removed ${formatDateToString(statusDate)}` : 'Access removed';
      if (revokedReason === 'invite_revoked') {
        return statusDate ? `Invite revoked ${formatDateToString(statusDate)}` : 'Invite revoked';
      }
      if (revokedReason === 'invite_expired') {
        return statusDate ? `Invite expired ${formatDateToString(statusDate)}` : 'Invite expired';
      }
      return base;
    })();
    const logoUrl = tenant?.branding?.logoUrl || tenant?.logoUrl || null;
    const leaveCtaLabel = isPendingRequest ? 'Withdraw request' : 'Leave this center';
    const showLeaveButton = canLeave && !isRejected && !isRevoked && membership.status !== 'pending_invite';
    const showInviteDecisionButtons = membership.status === 'pending_invite' && !!membership.inviteToken;
    const isInviteDecisionBusy =
      acceptingInviteMembershipId === membership.id || rejectingInviteMembershipId === membership.id;
    const showDecisionBlock = isRejected || isRevoked;
    const decisionTone = isRejected ? theme.error : theme.textSecondary;
    const decisionLabel = isRejected ? rejectionTimelineLabel : revokedTimelineLabel;
    const decisionMessage = (() => {
      if (isRejected) {
        return `Admins from ${tenant?.name || 'this center'} rejected your request. You can reach out to them or try a new join code.`;
      }
      if (revokedReason === 'invite_revoked') {
        return `This invite was revoked by an admin from ${tenant?.name || 'this center'}. Ask them to send a new invite or use a join code to request access again.`;
      }
      if (revokedReason === 'invite_expired') {
        return `This invite has expired for ${tenant?.name || 'this center'}. Ask an admin to resend a new invite link or use a join code to request access again.`;
      }
      return `Access to ${tenant?.name || 'this center'} was revoked. Use a fresh join code or contact an admin to regain access.`;
    })();
    const decisionButtonLabel = isRejected ? 'Try another join code' : 'Request access again';
    const timelineItems = buildMembershipTimeline(membership);
    const showTimeline = timelineItems.length > 0;
    const timelineExpanded = Boolean(expandedTimelines[membership.id]);
    const timelineToggleLabel = timelineExpanded ? 'Hide status history' : 'Show status history';
    return (
      <View
        key={membership.id}
        style={[styles.membershipCard, { borderColor: theme.border, backgroundColor: theme.surface }]}
      >
        <View style={styles.membershipHeader}>
          <View style={styles.membershipTitleRow}>
            {logoUrl ? (
              <Image source={{ uri: logoUrl }} style={styles.membershipLogo} resizeMode="cover" />
            ) : (
              <View style={[styles.membershipLogoFallback, { backgroundColor: `${theme.primary}1A` }]}> 
                <Building2 size={16} color={theme.primary} />
              </View>
            )}
            <View style={styles.membershipTitleText}>
              <Text style={[styles.membershipName, { color: theme.text }]}> 
                {tenant?.name || 'Coaching center'}
              </Text>
              <Text style={[styles.membershipMeta, { color: theme.textSecondary }]}> 
                {ROLE_LABELS[membership.role] || membership.role}
              </Text>
            </View>
          </View>
          {isCurrent && (
            <View style={[styles.currentBadge, { backgroundColor: `${theme.primary}1A` }]}> 
              <Text style={[styles.currentBadgeText, { color: theme.primary }]}>Current</Text>
            </View>
          )}
          {!isCurrent && canSwitch && (
            <TouchableOpacity
              onPress={() => handleSelectTenant(membership.tenantId)}
              style={[styles.switchButton, { borderColor: theme.border }]}
              disabled={switchingTenantId === membership.tenantId}
            >
              {switchingTenantId === membership.tenantId ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Text style={[styles.switchButtonText, { color: theme.primary }]}>Switch</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.membershipFooter}>
          {renderStatusBadge(membership.status)}
          <View style={styles.metaRow}>
            <Users size={16} color={theme.textSecondary} />
            <Text style={[styles.metaText, { color: theme.textSecondary }]}> 
              {tenant?.slug || membership.tenantId}
            </Text>
          </View>
        </View>
        {isPendingRequest && (
          <View
            style={[
              styles.pendingRequestInfo,
              { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
            ]}
          >
            <View style={styles.pendingRequestInfoRow}>
              <Clock size={14} color={theme.warning} />
              <Text style={[styles.pendingRequestInfoLabel, { color: theme.warning }]}>{pendingTimelineLabel}</Text>
            </View>
            <Text style={[styles.pendingRequestInfoText, { color: theme.textSecondary }]}> 
              {`Admins from ${tenant?.name || 'this center'} need to approve your request. We'll let you know as soon as it's reviewed.`}
            </Text>
          </View>
        )}
        {showDecisionBlock && (
          <View
            style={[
              styles.rejectedInfo,
              { borderColor: `${decisionTone}30`, backgroundColor: `${decisionTone}10` },
            ]}
          >
            <View style={styles.rejectedInfoRow}>
              <AlertCircle size={14} color={decisionTone} />
              <Text style={[styles.rejectedInfoLabel, { color: decisionTone }]}>{decisionLabel}</Text>
            </View>
            <Text style={[styles.rejectedInfoText, { color: theme.textSecondary }]}>{decisionMessage}</Text>
            <TouchableOpacity
              style={[styles.rejoinButton, { borderColor: decisionTone }]}
              onPress={openJoinModal}
            >
              <Text style={[styles.rejoinButtonText, { color: decisionTone }]}>{decisionButtonLabel}</Text>
            </TouchableOpacity>
          </View>
        )}
        {showTimeline && (
          <View style={styles.timelineSection}>
            <TouchableOpacity
              style={[styles.timelineToggle, { borderColor: theme.border, backgroundColor: theme.surface }]}
              onPress={() => toggleTimeline(membership.id)}
            >
              <Text style={[styles.timelineToggleText, { color: theme.text }]}>{timelineToggleLabel}</Text>
              <ChevronDown
                size={16}
                color={theme.textSecondary}
                style={timelineExpanded ? styles.timelineToggleIconExpanded : styles.timelineToggleIcon}
              />
            </TouchableOpacity>
            {timelineExpanded && (
              <View style={[styles.timelineContainer, { borderColor: theme.border }]}> 
                <Text style={[styles.timelineHeader, { color: theme.textSecondary }]}>Status history</Text>
                {timelineItems.map((item, index) => {
                  const color = getStatusColor(item.status);
                  const isLast = index === timelineItems.length - 1;
                  return (
                    <View key={item.id} style={styles.timelineRow}>
                      <View style={styles.timelineMarkerColumn}>
                        <View
                          style={[styles.timelineMarker, { borderColor: color, backgroundColor: `${color}1A` }]}
                        />
                        {!isLast && <View style={[styles.timelineConnector, { backgroundColor: theme.border }]} />}
                      </View>
                      <View style={styles.timelineDetails}>
                        <Text style={[styles.timelineStatusLabel, { color: theme.text }]}>{item.label}</Text>
                        <Text style={[styles.timelineDate, { color: theme.textSecondary }]}>{item.displayDate}</Text>
                        {item.detail ? (
                          <Text style={[styles.timelineDetail, { color: theme.textSecondary }]}>{item.detail}</Text>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        )}
        {showLeaveButton && (
          <View style={styles.cardActions}>
            <TouchableOpacity
              style={[styles.leaveButton, { borderColor: theme.border }]}
              onPress={() =>
                confirmLeaveTenant(
                  membership.tenantId,
                  tenant?.name,
                  isPendingRequest ? { pending: true } : undefined,
                )
              }
              disabled={leavingTenantId === membership.tenantId}
            >
              {leavingTenantId === membership.tenantId ? (
                <ActivityIndicator size="small" color={theme.error} />
              ) : (
                <Text style={[styles.leaveButtonText, { color: theme.error }]}>{leaveCtaLabel}</Text>
              )}
            </TouchableOpacity>
          </View>
        )}

        {showInviteDecisionButtons && (
          <View style={styles.cardActions}>
            <View style={styles.inviteDecisionRow}>
              <TouchableOpacity
                style={[
                  styles.inviteAcceptButton,
                  {
                    backgroundColor: theme.primary,
                    borderColor: theme.primary,
                    opacity: isInviteDecisionBusy ? 0.7 : 1,
                  },
                ]}
                onPress={() => handleAcceptPendingInviteMembership(membership)}
                disabled={isInviteDecisionBusy}
              >
                {acceptingInviteMembershipId === membership.id ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.inviteAcceptButtonText}>Accept</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.leaveButton,
                  { borderColor: theme.border, opacity: isInviteDecisionBusy ? 0.7 : 1, flex: 1 },
                ]}
                onPress={() => handleRejectPendingInviteMembership(membership)}
                disabled={isInviteDecisionBusy}
              >
                {rejectingInviteMembershipId === membership.id ? (
                  <ActivityIndicator size="small" color={theme.error} />
                ) : (
                  <Text style={[styles.leaveButtonText, { color: theme.error }]}>Reject</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <Building2 size={18} color={theme.primary} />
          <Text style={[styles.cardTitle, { color: theme.text }]}>Coaching centers</Text>
        </View>
        <TouchableOpacity onPress={handleRefresh} style={styles.headerIconButton}>
          {refreshing ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <RefreshCcw size={18} color={theme.textSecondary} />
          )}
        </TouchableOpacity>
      </View>

      {error && (
        <View style={[styles.alertRow, { backgroundColor: `${theme.error}10` }]}> 
          <AlertCircle size={16} color={theme.error} />
          <Text style={[styles.alertText, { color: theme.error }]}>{error}</Text>
        </View>
      )}

      {incomingInviteError && (
        <View style={[styles.alertRow, { backgroundColor: `${theme.error}10` }]}> 
          <AlertCircle size={16} color={theme.error} />
          <Text style={[styles.alertText, { color: theme.error }]}>{incomingInviteError}</Text>
        </View>
      )}

      {membershipRows.length > 0 && (
        <View style={styles.filterContainer}>
          <View style={[styles.searchInputWrapper, { borderColor: theme.border, backgroundColor: theme.surface }]}>
            <Search size={16} color={theme.textSecondary} style={{ marginRight: 8 }} />
            <TextInput
              style={[styles.searchInput, { color: theme.text }]}
              placeholder="Search by name, code, or role"
              placeholderTextColor={theme.textSecondary}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <X size={16} color={theme.textSecondary} />
              </TouchableOpacity>
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.filterChipsScroll}
            contentContainerStyle={styles.filterChipsRow}
          >
            {(
              [
                { value: 'all' as const, label: 'All' },
                { value: 'active' as const, label: `Active (${activeCount})` },
                { value: 'pending' as const, label: `Pending (${pendingCount})` },
                { value: 'rejected' as const, label: `Rejected (${rejectedCount})` },
                { value: 'revoked' as const, label: `Revoked (${revokedCount})` },
              ]
            ).map((option) => {
              const active = statusFilter === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  onPress={() => setStatusFilter(option.value)}
                  style={[
                    styles.filterChip,
                    {
                      backgroundColor: active ? theme.primary : theme.surface,
                      borderColor: active ? theme.primary : theme.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      {
                        color: active ? '#fff' : theme.text,
                      },
                    ]}
                  >
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {pendingBannerTitle && pendingBannerCopy && (
        <View
          style={[
            styles.pendingBanner,
            { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
          ]}
        >
          <AlertCircle size={18} color={theme.warning} />
          <View style={styles.pendingBannerText}>
            <Text style={[styles.pendingBannerTitle, { color: theme.warning }]}>{pendingBannerTitle}</Text>
            <Text style={[styles.pendingBannerSubtitle, { color: theme.textSecondary }]}>{pendingBannerCopy}</Text>
          </View>
        </View>
      )}

      {loading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading centers…</Text>
        </View>
      ) : incomingInviteLoading ? (
        <View style={styles.loadingState}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading invitations…</Text>
        </View>
      ) : membershipRows.length ? (
        filteredMembershipRows.length ? (
          <View style={styles.membershipListShell}>
            <ScrollView
              style={styles.membershipListScroll}
              contentContainerStyle={styles.membershipListContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {filteredMembershipRows.map((row) => renderMembershipCard(row))}
            </ScrollView>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No matching centers</Text>
            <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>Adjust your search or filters to see more results.</Text>
          </View>
        )
      ) : (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>No centers yet</Text>
          <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}> 
            Ask your admin for a join code to connect this account.
          </Text>
        </View>
      )}

      <View style={styles.actionStack}>
        <TouchableOpacity
          style={[styles.actionCard, styles.actionCardFirst, styles.secondaryActionCard, { borderColor: theme.border, backgroundColor: theme.surface }]}
          onPress={openCreateModal}
        >
          <View style={[styles.actionIcon, { backgroundColor: `${theme.primary}1A` }]}>
            <CheckCircle2 size={18} color={theme.primary} />
          </View>
          <View style={styles.actionContent}>
            <Text style={[styles.actionTitle, { color: theme.text }]}>Create a coaching center</Text>
            <Text style={[styles.actionSubtitle, { color: theme.textSecondary }]}>Spin up a new workspace as owner</Text>
          </View>
          <ChevronRight size={18} color={theme.textSecondary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionCard, styles.primaryActionCard, { backgroundColor: theme.primary }]}
          onPress={openJoinModal}
        >
          <View style={[styles.actionIcon, styles.primaryActionIcon]}>
            <Plus size={18} color="#fff" />
          </View>
          <View style={styles.actionContent}>
            <Text style={[styles.actionTitle, styles.primaryActionText]}>Join a coaching center</Text>
            <Text style={[styles.actionSubtitle, styles.primaryActionTextMuted]}>Use a join code from an admin</Text>
          </View>
          <ChevronRight size={18} color="rgba(255,255,255,0.85)" />
        </TouchableOpacity>
      </View>

      <Modal
        visible={createModalVisible}
        animationType="slide"
        onRequestClose={closeCreateModal}
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}> 
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}> 
            <TouchableOpacity onPress={closeCreateModal}>
              <X size={22} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>New coaching center</Text>
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
              Set up a dedicated workspace for a coaching center. You will be assigned as the owner and can invite your team later.
            </Text>

            <Text style={[styles.modalLabel, { color: theme.text }]}>Center name *</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={createForm.name}
              placeholder="e.g., Sunrise Academy"
              placeholderTextColor={theme.textSecondary}
              onChangeText={(value) => handleCreateFieldChange('name', value)}
            />

            <Text style={[styles.modalLabel, { color: theme.text }]}>Address</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={createForm.address}
              placeholder="Street, city"
              placeholderTextColor={theme.textSecondary}
              onChangeText={(value) => handleCreateFieldChange('address', value)}
            />

            <Text style={[styles.modalLabel, { color: theme.text }]}>Timezone *</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={createForm.timezone}
              placeholder="Asia/Kolkata"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              onChangeText={(value) => handleCreateFieldChange('timezone', value)}
            />
            <Text style={[styles.modalHelper, { color: theme.textSecondary }]}>We detected {deviceTimezone}. Update if the center operates elsewhere.</Text>

            <Text style={[styles.modalLabel, { color: theme.text }]}>Default currency</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={createForm.defaultCurrency}
              placeholder="INR"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="characters"
              onChangeText={(value) => handleCreateFieldChange('defaultCurrency', value)}
              maxLength={3}
            />

            <Text style={[styles.modalLabel, { color: theme.text }]}>Contact email</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={createForm.contactEmail}
              placeholder="owner@example.com"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              keyboardType="email-address"
              onChangeText={(value) => handleCreateFieldChange('contactEmail', value)}
            />

            <Text style={[styles.modalLabel, { color: theme.text }]}>Contact phone</Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={createForm.contactPhone}
              placeholder="+91-9876543210"
              placeholderTextColor={theme.textSecondary}
              keyboardType="phone-pad"
              onChangeText={(value) => handleCreateFieldChange('contactPhone', value)}
            />

            <Text style={[styles.modalLabel, { color: theme.text }]}>Coaching logo</Text>
            <View style={[styles.logoPreviewContainer, { borderColor: theme.border, backgroundColor: theme.surface }]}>
              {createLogoPreviewUrl ? (
                <Image
                  source={{ uri: createLogoPreviewUrl }}
                  style={styles.logoPreviewImage}
                  resizeMode="contain"
                />
              ) : (
                <View style={styles.logoPlaceholder}>
                  <Building2 size={28} color={theme.textSecondary} />
                  <Text style={[styles.logoPlaceholderText, { color: theme.textSecondary }]}>PNG/JPG up to {LOGO_SIZE_LIMIT_MB} MB</Text>
                </View>
              )}
            </View>
            <View style={styles.logoButtonRow}>
              <TouchableOpacity
                style={[
                  styles.logoButton,
                  { borderColor: theme.border, backgroundColor: theme.surface },
                  createLogoPreviewUrl ? { marginRight: 12 } : null,
                ]}
                onPress={handlePickCreateLogo}
                disabled={pickingCreateLogo}
              >
                {pickingCreateLogo ? (
                  <ActivityIndicator color={theme.text} />
                ) : (
                  <Text style={[styles.logoButtonText, { color: theme.text }]}>Choose image</Text>
                )}
              </TouchableOpacity>
              {createLogoPreviewUrl && (
                <TouchableOpacity
                  style={[
                    styles.logoRemoveButton,
                    { borderColor: theme.border, backgroundColor: theme.surface },
                  ]}
                  onPress={handleRemoveCreateLogo}
                  disabled={pickingCreateLogo}
                >
                  <Text style={[styles.logoRemoveButtonText, { color: theme.textSecondary }]}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={[styles.modalHelper, { color: theme.textSecondary }]}>Add a crisp square logo to personalize invites and receipts. You can change it later.</Text>

            {createError && (
              <View style={[styles.alertRow, { backgroundColor: `${theme.error}10` }]}> 
                <AlertCircle size={16} color={theme.error} />
                <Text style={[styles.alertText, { color: theme.error }]}>{createError}</Text>
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.primaryButton,
                {
                  backgroundColor: theme.primary,
                  opacity: createForm.name.trim() ? 1 : 0.5,
                  marginTop: 4,
                },
              ]}
              onPress={handleCreateTenant}
              disabled={creatingTenant || !createForm.name.trim()}
            >
              {creatingTenant ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>Create coaching center</Text>
              )}
            </TouchableOpacity>
            <Text style={[styles.modalHelper, { color: theme.textSecondary }]}>You can configure branding, invites, and quotas after creation.</Text>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={joinModalVisible}
        animationType="slide"
        onRequestClose={closeJoinModal}
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}> 
          <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}> 
            <TouchableOpacity onPress={closeJoinModal}>
              <X size={22} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Join a coaching center</Text>
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
              Enter the join code shared by the coaching center admin to add this account.
            </Text>
            <TextInput
              style={[styles.input, { borderColor: theme.border, color: theme.text, backgroundColor: theme.surface }]}
              value={joinCode}
              placeholder="ABC1234"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="characters"
              autoCorrect={false}
              onChangeText={(value) => setJoinCode(sanitizeCode(value))}
              maxLength={10}
            />
            <TouchableOpacity
              style={[styles.primaryButton, { opacity: canSubmitCode ? 1 : 0.5, backgroundColor: theme.primary }]}
              onPress={handleLookupCode}
              disabled={!canSubmitCode || checkingCode}
            >
              {checkingCode ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryButtonText}>Check code</Text>
              )}
            </TouchableOpacity>

            {joinError && (
              <View style={[styles.alertRow, { backgroundColor: `${theme.error}10` }]}> 
                <AlertCircle size={16} color={theme.error} />
                <Text style={[styles.alertText, { color: theme.error }]}>{joinError}</Text>
              </View>
            )}

            {joinPreview && (
              <View style={[styles.previewCard, { borderColor: theme.border, backgroundColor: theme.surface }]}> 
                <Text style={[styles.previewTitle, { color: theme.text }]}>{joinPreview.tenant.name}</Text>
                <Text style={[styles.previewSubtitle, { color: theme.textSecondary }]}> 
                  {joinPreview.tenant.slug || joinPreview.tenant.id}
                </Text>
                {alreadyMember && (
                  <Text style={[styles.previewInfo, { color: theme.textSecondary }]}> 
                    This account is already a member of this coaching center.
                  </Text>
                )}
                {alreadyPending && (
                  <Text style={[styles.previewInfo, { color: theme.textSecondary }]}> 
                    {alreadyInvitePending
                      ? 'An invite is already waiting for this account. Close this modal and accept it from the Pending tab.'
                      : "Your request is waiting for an admin to approve it. We'll keep you posted."}
                  </Text>
                )}
                {!alreadyMember && !alreadyPending && !joinSuccess && (
                  <TouchableOpacity
                    style={[styles.primaryButton, { backgroundColor: theme.success, marginTop: 16 }]}
                    onPress={handleClaimCode}
                    disabled={claimingCode}
                  >
                    {claimingCode ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.primaryButtonText}>Join this center</Text>
                    )}
                  </TouchableOpacity>
                )}
                {joinSuccess && (() => {
                  const pendingOutcome =
                    joinSuccess.pendingRequest || joinSuccess.membership.status === 'pending_request';
                  const accentColor = pendingOutcome ? theme.warning : theme.success;
                  return (
                    <View style={styles.successRow}>
                      <CheckCircle2 size={20} color={accentColor} />
                      <Text style={[styles.successText, { color: accentColor }]}> 
                        {pendingOutcome
                          ? "Request submitted. You'll be added once an admin approves it."
                          : 'Joined successfully!'}
                      </Text>
                    </View>
                  );
                })()}
                {joinSuccess?.joinRequest && (
                  <Text style={[styles.previewInfo, { color: theme.textSecondary }]}> 
                    Status: {formatStatusLabel(joinSuccess.joinRequest.status)}
                  </Text>
                )}
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      <ConfirmationModal
        visible={Boolean(leaveConfirmContext)}
        onClose={closeLeaveConfirmModal}
        onCancel={closeLeaveConfirmModal}
        title={leaveConfirmContext?.pending ? 'Withdraw request' : 'Leave coaching center'}
        message={leaveConfirmContext?.pending
          ? `Cancel your request to join ${leaveConfirmContext?.tenantName || 'this coaching center'}?`
          : `This will remove your access to ${leaveConfirmContext?.tenantName || 'this coaching center'}. You can rejoin later with a fresh code.`}
        confirmText={leaveConfirmContext?.pending ? 'Withdraw' : 'Leave'}
        cancelText={leaveConfirmContext?.pending ? 'Keep request' : 'Cancel'}
        confirmStyle="destructive"
        confirmDisabled={leaveConfirmContext ? leavingTenantId === leaveConfirmContext.tenantId : false}
        confirmLoading={leaveConfirmContext ? leavingTenantId === leaveConfirmContext.tenantId : false}
        cancelDisabled={leaveConfirmContext ? leavingTenantId === leaveConfirmContext.tenantId : false}
        autoCloseOnConfirm={false}
        onConfirm={handleConfirmLeave}
        statusMessage={leaveWarningMessage}
        statusType={leaveWarningMessage ? 'error' : 'neutral'}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 24,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  cardHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIconButton: {
    padding: 6,
    borderRadius: 999,
  },
  cardTitle: {
    marginLeft: 8,
    fontSize: 16,
    fontWeight: '600',
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
  },
  alertText: {
    flex: 1,
    fontSize: 13,
    marginLeft: 8,
  },
  loadingState: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
  },
  loadingText: {
    marginLeft: 8,
    fontSize: 14,
  },
  membershipCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  membershipHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  membershipTitleRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
  },
  membershipLogo: {
    width: 42,
    height: 42,
    borderRadius: 12,
    marginRight: 12,
    backgroundColor: '#fff',
  },
  membershipLogoFallback: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  membershipTitleText: {
    flex: 1,
  },
  membershipName: {
    fontSize: 15,
    fontWeight: '600',
  },
  membershipMeta: {
    fontSize: 13,
    marginTop: 2,
  },
  membershipFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  pendingRequestInfo: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 12,
    gap: 6,
  },
  pendingRequestInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pendingRequestInfoLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  pendingRequestInfoText: {
    fontSize: 12,
    lineHeight: 18,
  },
  rejectedInfo: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 12,
    gap: 8,
  },
  rejectedInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  rejectedInfoLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  rejectedInfoText: {
    fontSize: 12,
    lineHeight: 18,
  },
  rejoinButton: {
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  rejoinButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  timelineContainer: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
  timelineHeader: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  timelineMarkerColumn: {
    alignItems: 'center',
    marginRight: 12,
  },
  timelineMarker: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  timelineConnector: {
    width: 2,
    flex: 1,
    marginTop: 2,
  },
  timelineDetails: {
    flex: 1,
  },
  timelineStatusLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  timelineDate: {
    fontSize: 12,
    marginTop: 2,
  },
  timelineDetail: {
    fontSize: 12,
    marginTop: 2,
  },
  timelineSection: {
    marginTop: 12,
    gap: 8,
  },
  timelineToggle: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  timelineToggleText: {
    fontSize: 13,
    fontWeight: '600',
  },
  timelineToggleIcon: {
    transform: [{ rotate: '0deg' }],
  },
  timelineToggleIconExpanded: {
    transform: [{ rotate: '180deg' }],
  },
  membershipListShell: {
    maxHeight: 420,
  },
  membershipListScroll: {
    flexGrow: 0,
  },
  membershipListContent: {
    paddingBottom: 4,
  },
  currentBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  currentBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  switchButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    minWidth: 72,
    alignItems: 'center',
  },
  switchButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 6,
  },
  metaText: {
    fontSize: 12,
  },
  cardActions: {
    marginTop: 12,
  },
  leaveButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
  },
  leaveButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  inviteDecisionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  inviteAcceptButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    flex: 1,
  },
  inviteAcceptButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  emptyState: {
    alignItems: 'flex-start',
    paddingVertical: 8,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 13,
  },
  filterContainer: {
    marginBottom: 16,
  },
  pendingBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    gap: 12,
  },
  pendingBannerText: {
    flex: 1,
    gap: 4,
  },
  pendingBannerTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  pendingBannerSubtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  searchInputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 0,
  },
  filterChipsRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
    paddingRight: 8,
  },
  filterChipsScroll: {
    marginTop: 10,
  },
  filterChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 6,
    marginBottom: 0,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  actionStack: {
    marginTop: 16,
  },
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginTop: 12,
  },
  actionCardFirst: {
    marginTop: 0,
  },
  secondaryActionCard: {
    borderWidth: 1,
  },
  primaryActionCard: {
    borderWidth: 0,
  },
  actionIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  primaryActionIcon: {
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  actionContent: {
    flex: 1,
  },
  actionTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  actionSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  primaryActionText: {
    color: '#fff',
  },
  primaryActionTextMuted: {
    color: 'rgba(255,255,255,0.85)',
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
  },
  modalDescription: {
    fontSize: 14,
    marginBottom: 12,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  modalHelper: {
    fontSize: 12,
    marginBottom: 12,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    marginBottom: 12,
  },
  logoPreviewContainer: {
    borderWidth: 1,
    borderRadius: 16,
    height: 120,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    overflow: 'hidden',
  },
  logoPreviewImage: {
    width: '100%',
    height: '100%',
  },
  logoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoPlaceholderText: {
    fontSize: 12,
    marginTop: 6,
  },
  logoButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 12,
  },
  logoButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  logoRemoveButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 110,
  },
  logoRemoveButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  primaryButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  previewCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
  },
  previewTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  previewSubtitle: {
    fontSize: 13,
    marginTop: 4,
  },
  previewInfo: {
    fontSize: 13,
    marginTop: 12,
  },
  successRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
  },
  successText: {
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
});

export default TenantMembershipManager;
