import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Platform,
  LayoutChangeEvent,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { settingsService, AppSettings } from '../services/settingsService';
import { tenantService, DEFAULT_TENANT_NOTIFICATION_PREFERENCES } from '@/services/tenantService';
import { useTheme } from '../hooks/useTheme';
import { useRouter } from 'expo-router';
import { useTenant } from '@/hooks/useTenantContext';
import { useAuth } from '@/hooks/useAuthUnified';
import { formatDateToString } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { Save, RefreshCw, ImagePlus, Trash2, KeyRound, Info } from 'lucide-react-native';
import type { TenantMembershipRole, TenantNotificationPreferences, TenantJoinRequestStatus, TenantSettings } from '@/types';
import TenantMembershipManager from './TenantMembershipManager';
import TenantInviteManager, { TenantInviteManagerHandle } from './TenantInviteManager';
import TenantJoinCodeManager, { TenantJoinCodeManagerHandle } from './TenantJoinCodeManager';
import TenantUsageSummary from './TenantUsageSummary';
import TenantOnboardingChecklist, { OnboardingTarget } from './TenantOnboardingChecklist';
import ConfirmationModal from './ConfirmationModal';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import TenantSelectionEmptyState from './TenantSelectionEmptyState';
import * as ImagePicker from 'expo-image-picker';
import {
  uploadTenantLogo,
  deleteTenantLogoByUrl,
  TENANT_LOGO_MAX_BYTES,
  TenantLogoAsset,
} from '@/services/tenantBrandingService';
import { MediaPickerUtil } from '@/lib/mediaPickerUtil';
import { reconcileTenantStorageUsageViaBackend } from '@/services/backendStorageUploadService';

const DEFAULT_JOIN_REQUEST_PAGE = 5;
const JOIN_ROLE_STORAGE_KEY = 'admin_join_request_roles';
const DEFAULT_NOTIFICATION_PREFS: TenantNotificationPreferences = {
  ...DEFAULT_TENANT_NOTIFICATION_PREFERENCES,
};

interface AdminSettingsProps {
  onClose: () => void;
}

export default function AdminSettings({ onClose }: AdminSettingsProps) {
  const { theme } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const {
    tenants,
    memberships,
    pendingMemberships,
    joinRequests,
    activeTenant,
    loading: tenantLoading,
    refreshTenants,
    applyTenantNotificationPreferencesSnapshot,
  } = useTenant();
  const tenantUnavailable = !tenantLoading && !activeTenant?.id;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [processingRequestId, setProcessingRequestId] = useState<string | null>(null);
  const [requestRoles, setRequestRoles] = useState<Record<string, TenantMembershipRole>>({});
  const [joinRequestLimit, setJoinRequestLimit] = useState(DEFAULT_JOIN_REQUEST_PAGE);
  const [joinRequestSort, setJoinRequestSort] = useState<'newest' | 'oldest'>('newest');
  const [joinRequestTenantFilter, setJoinRequestTenantFilter] = useState<'all' | string>('all');
  const [joinRequestStatusFilter, setJoinRequestStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'expired'>('pending');
  const rolesHydrated = useRef(false);
  const scrollRef = useRef<ScrollView | null>(null);
  const sectionOffsets = useRef<Partial<Record<OnboardingTarget, number>>>({});
  const inviteManagerRef = useRef<TenantInviteManagerHandle | null>(null);
  const joinCodeManagerRef = useRef<TenantJoinCodeManagerHandle | null>(null);
  const supportEmailInputRef = useRef<TextInput | null>(null);
  const coachingNameInputRef = useRef<TextInput | null>(null);
  const [notificationPrefs, setNotificationPrefs] = useState<TenantNotificationPreferences>(DEFAULT_NOTIFICATION_PREFS);
  const [notificationPrefsOriginal, setNotificationPrefsOriginal] = useState<TenantNotificationPreferences>(DEFAULT_NOTIFICATION_PREFS);
  const [savingNotificationPrefs, setSavingNotificationPrefs] = useState(false);
  const [reconcilingStorage, setReconcilingStorage] = useState(false);
  const [reconcileStorageConfirmVisible, setReconcileStorageConfirmVisible] = useState(false);
  const [coachingCentersTooltipVisible, setCoachingCentersTooltipVisible] = useState(false);
  
  // Track original form values to determine if changes were made
  type FormValues = {
    supportEmail: string;
    supportPhone: string;
    whatsappNumber: string;
    bugReportFormUrl: string;
    coachingName: string;
    allowNonAdminAllReminderHistory: boolean;
    hideAuthorizedEmailsForNonAdmins: boolean;
    logoUrl: string | null;
  };
  const [originalValues, setOriginalValues] = useState<FormValues | null>(null);

  // Form state
  const [supportEmail, setSupportEmail] = useState('');
  const [supportPhone, setSupportPhone] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [bugReportFormUrl, setBugReportFormUrl] = useState('');
  const [coachingName, setCoachingName] = useState('');
  const [allowNonAdminAllReminderHistory, setAllowNonAdminAllReminderHistory] = useState(false);
  const [hideAuthorizedEmailsForNonAdmins, setHideAuthorizedEmailsForNonAdmins] = useState(false);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(null);
  const [pendingLogoAsset, setPendingLogoAsset] = useState<TenantLogoAsset | null>(null);
  const [pickingLogo, setPickingLogo] = useState(false);
  const logoSizeLimitMb = Math.round(TENANT_LOGO_MAX_BYTES / (1024 * 1024));

  const handleSectionLayout = (key: OnboardingTarget) => (event: LayoutChangeEvent) => {
    sectionOffsets.current[key] = event.nativeEvent.layout.y;
  };

  const focusInputAfterNavigate = (inputRef: React.RefObject<TextInput | null>) => {
    if (!inputRef.current) {
      return;
    }
    requestAnimationFrame(() => {
      setTimeout(() => inputRef.current?.focus(), 80);
    });
  };

  const handleNavigateToPlanAndBilling = useCallback(() => {
    onClose();
    requestAnimationFrame(() => {
      setTimeout(() => router.push('/(tabs)/plan'), 80);
    });
  }, [onClose, router]);

  const formatBytesShort = (bytes: number) => {
    const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
    const gb = value / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(2)} GB`;
    }
    const mb = value / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  const handleReconcileStorageUsage = useCallback(() => {
    if (!activeTenant?.id) {
      Toast.show({
        type: 'info',
        text1: 'Select a center first',
        text2: 'Choose a coaching center before reconciling storage usage.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    if (reconcilingStorage) {
      return;
    }
    setReconcileStorageConfirmVisible(true);
  }, [activeTenant?.id, reconcilingStorage]);

  const handleConfirmReconcileStorageUsage = useCallback(async () => {
    if (!activeTenant?.id) {
      return;
    }
    if (reconcilingStorage) {
      return;
    }
    setReconcilingStorage(true);
    try {
      const result = await reconcileTenantStorageUsageViaBackend({ tenantId: activeTenant.id });
      Toast.show({
        type: 'success',
        text1: 'Storage usage updated',
        text2: `Now using ${formatBytesShort(result.bytes)}.`,
        position: 'top',
        topOffset: 60,
      });
      setReconcileStorageConfirmVisible(false);
    } catch (error) {
      logger.warn('AdminSettings: storage reconcile failed', error);
      Toast.show({
        type: 'error',
        text1: 'Reconcile failed',
        text2: 'Unable to rescan storage right now. Please try again.',
        position: 'top',
        topOffset: 60,
      });
      setReconcileStorageConfirmVisible(false);
    } finally {
      setReconcilingStorage(false);
    }
  }, [activeTenant?.id, reconcilingStorage]);

  const handlePickBrandingLogo = async () => {
    if (!activeTenant?.id) {
      Toast.show({
        type: 'info',
        text1: 'Select a center first',
        text2: 'Choose or create a coaching center before updating branding.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    if (pickingLogo) {
      return;
    }

    // Show source picker: "Take Photo" or "Choose from Gallery"
    const getSource = (): Promise<'camera' | 'gallery' | 'cancel'> =>
      new Promise((resolve) => {
        if (Platform.OS === 'web') {
          // On web, Alert.alert is available but shows a browser dialog.
          // Use it for simplicity — matches the native pattern.
          Alert.alert(
            'Pick Logo',
            'Choose how you want to add your logo',
            [
              { text: 'Take Photo', onPress: () => resolve('camera') },
              { text: 'Choose from Gallery', onPress: () => resolve('gallery') },
              { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
            ],
            { cancelable: true, onDismiss: () => resolve('cancel') }
          );
        } else {
          Alert.alert(
            'Pick Logo',
            'Choose how you want to add your logo',
            [
              { text: 'Take Photo', onPress: () => resolve('camera') },
              { text: 'Choose from Gallery', onPress: () => resolve('gallery') },
              { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
            ],
            { cancelable: true }
          );
        }
      });

    const source = await getSource();
    if (source === 'cancel') return;

    setPickingLogo(true);
    try {
      let result: { canceled: boolean; assets?: Array<{ uri: string; mimeType?: string; fileName?: string | null }> | null };

      if (source === 'camera') {
        result = await MediaPickerUtil.captureImage();
      } else {
        // Existing gallery path — preserve behaviour exactly
        const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted) {
          Alert.alert('Permission needed', 'Allow photo access to pick a logo.');
          return;
        }
        result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.9,
        });
      }

      if (result.canceled || !result.assets?.length) {
        return;
      }

      const asset = result.assets[0];
      if (!asset.uri) {
        Toast.show({
          type: 'error',
          text1: 'Invalid image',
          text2: 'Unable to use that image. Please pick another file.',
          position: 'top',
          topOffset: 60,
        });
        return;
      }

      setPendingLogoAsset({
        uri: asset.uri,
        mimeType: asset.mimeType,
        fileName: asset.fileName || undefined,
      });
      setLogoPreviewUrl(asset.uri);
    } catch (pickerError) {
      logger.warn('AdminSettings: logo picker failed', pickerError);
      const errorMessage = pickerError instanceof Error ? pickerError.message : '';
      if (errorMessage.toLowerCase().includes('permission') || errorMessage.toLowerCase().includes('denied')) {
        Toast.show({
          type: 'error',
          text1: 'Camera access denied',
          text2: 'Please update your device settings to allow camera access.',
          position: 'top',
          topOffset: 60,
        });
      } else {
        Toast.show({
          type: 'error',
          text1: 'Unable to pick logo',
          text2: 'Something went wrong while picking that image.',
          position: 'top',
          topOffset: 60,
        });
      }
    } finally {
      setPickingLogo(false);
    }
  };

  const handleRemoveBrandingLogo = () => {
    setPendingLogoAsset(null);
    setLogoPreviewUrl(null);
  };

  const handleOnboardingNavigate = (target: OnboardingTarget) => {
    const offset = sectionOffsets.current[target];
    if (offset == null) {
      return;
    }
    scrollRef.current?.scrollTo({ y: Math.max(offset - 24, 0), animated: true });

    if (target === 'contact') {
      focusInputAfterNavigate(supportEmailInputRef);
    } else if (target === 'branding') {
      focusInputAfterNavigate(coachingNameInputRef);
    } else if (target === 'invites') {
      inviteManagerRef.current?.openInviteModal();
    } else if (target === 'joinCodes') {
      joinCodeManagerRef.current?.flashGenerateHint();
    }
  };

  useEffect(() => {
    let isMounted = true;
    if (!activeTenant) {
      setNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
      setNotificationPrefsOriginal(DEFAULT_NOTIFICATION_PREFS);
      return () => {
        isMounted = false;
      };
    }
    const merged = {
      ...DEFAULT_NOTIFICATION_PREFS,
      ...(activeTenant.notificationPreferences || {}),
    } as TenantNotificationPreferences;
    setNotificationPrefs(merged);
    setNotificationPrefsOriginal(merged);

    tenantService
      .getNotificationPreferenceDraft(activeTenant.id)
      .then((draft) => {
        if (!isMounted || !draft) {
          return;
        }
        setNotificationPrefs({ ...draft });
      })
      .catch((error) => logger.warn('AdminSettings: failed to load notification draft', error));

    return () => {
      isMounted = false;
    };
  }, [activeTenant?.id, activeTenant?.notificationPreferences]);

  const persistNotificationPrefDraft = useCallback(
    (prefs: TenantNotificationPreferences | null) => {
      if (!activeTenant?.id) {
        return;
      }
      tenantService
        .setNotificationPreferenceDraft(activeTenant.id, prefs)
        .catch((error) => logger.warn('AdminSettings: failed to persist notification draft', error));
    },
    [activeTenant?.id],
  );

  useEffect(() => {
    let isMounted = true;
    AsyncStorage.getItem(JOIN_ROLE_STORAGE_KEY)
      .then((raw) => {
        if (!isMounted || !raw) {
          return;
        }
        try {
          const parsed = JSON.parse(raw) as Record<string, TenantMembershipRole>;
          setRequestRoles(parsed || {});
        } catch (error) {
          logger.warn('AdminSettings: failed to parse stored join roles', error);
        }
      })
      .catch((error) => logger.warn('AdminSettings: failed to load join roles', error))
      .finally(() => {
        rolesHydrated.current = true;
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!rolesHydrated.current) {
      return;
    }
    AsyncStorage.setItem(JOIN_ROLE_STORAGE_KEY, JSON.stringify(requestRoles)).catch((error) =>
      logger.warn('AdminSettings: failed to persist join roles', error),
    );
  }, [requestRoles]);

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const currentSettings = await settingsService.getSettings();
      setSettings(currentSettings);
      
      // Populate form fields
      setSupportEmail(currentSettings.supportEmail);
      setSupportPhone(currentSettings.supportPhone);
      setWhatsappNumber(currentSettings.whatsappNumber);
      setBugReportFormUrl(currentSettings.bugReportFormUrl);
      const tenantBrandName = (activeTenant?.name || '').trim();
      const settingsBrandName = (currentSettings as any)?.coachingName || '';
      const resolvedBrandName = tenantBrandName || settingsBrandName || 'S.S Tuition Classes';
      setCoachingName(resolvedBrandName);
      const resolvedLogoUrl = activeTenant?.branding?.logoUrl || activeTenant?.logoUrl || null;
      setLogoPreviewUrl(resolvedLogoUrl || null);
      setPendingLogoAsset(null);
      // H2: these visibility flags are now TENANT-scoped (tenants/{id}.settings),
      // not global appSettings. Read them from the active tenant.
      const tenantSettings = (activeTenant?.settings || {}) as Partial<TenantSettings>;
      setAllowNonAdminAllReminderHistory(!!tenantSettings.allowNonAdminAllReminderHistory);
      setHideAuthorizedEmailsForNonAdmins(!!tenantSettings.hideAuthorizedEmailsForNonAdmins);
      // Capture original snapshot for dirty tracking
      setOriginalValues({
        supportEmail: currentSettings.supportEmail,
        supportPhone: currentSettings.supportPhone,
        whatsappNumber: currentSettings.whatsappNumber,
        bugReportFormUrl: currentSettings.bugReportFormUrl,
        coachingName: resolvedBrandName,
        allowNonAdminAllReminderHistory: !!tenantSettings.allowNonAdminAllReminderHistory,
        hideAuthorizedEmailsForNonAdmins: !!tenantSettings.hideAuthorizedEmailsForNonAdmins,
        logoUrl: resolvedLogoUrl || null,
      });
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Failed to load',
        text2: 'Could not load settings. Pull to refresh or try again.',
        position: 'top',
        topOffset: 60,
      });
    } finally {
      setLoading(false);
    }
  }, [activeTenant?.id, activeTenant?.name, activeTenant?.settings]);

  useEffect(() => {
    if (tenantUnavailable) {
      setLoading(false);
      return;
    }
    loadSettings();
  }, [loadSettings, tenantUnavailable]);

  useEffect(() => {
    if (!activeTenant?.id) {
      setLogoPreviewUrl(null);
      setPendingLogoAsset(null);
    }
  }, [activeTenant?.id]);

  const currentValues = useMemo<FormValues>(() => ({
    supportEmail,
    supportPhone,
    whatsappNumber,
    bugReportFormUrl,
    coachingName,
    allowNonAdminAllReminderHistory,
    hideAuthorizedEmailsForNonAdmins,
    logoUrl: logoPreviewUrl || null,
  }), [
    supportEmail,
    supportPhone,
    whatsappNumber,
    bugReportFormUrl,
    coachingName,
    allowNonAdminAllReminderHistory,
    hideAuthorizedEmailsForNonAdmins,
    logoPreviewUrl,
  ]);

  const isDirty = useMemo(() => {
    if (!originalValues) return false;
    return (
      originalValues.supportEmail !== currentValues.supportEmail ||
      originalValues.supportPhone !== currentValues.supportPhone ||
      originalValues.whatsappNumber !== currentValues.whatsappNumber ||
      originalValues.bugReportFormUrl !== currentValues.bugReportFormUrl ||
        originalValues.coachingName !== currentValues.coachingName ||
      originalValues.allowNonAdminAllReminderHistory !== currentValues.allowNonAdminAllReminderHistory ||
      originalValues.hideAuthorizedEmailsForNonAdmins !== currentValues.hideAuthorizedEmailsForNonAdmins ||
      originalValues.logoUrl !== currentValues.logoUrl
    );
  }, [originalValues, currentValues]);

  const notificationPrefsDirty = useMemo(() => {
    return JSON.stringify(notificationPrefsOriginal) !== JSON.stringify(notificationPrefs);
  }, [notificationPrefsOriginal, notificationPrefs]);

  const pendingJoinRequests = useMemo(
    () => joinRequests.filter((request) => request.status === 'pending'),
    [joinRequests],
  );

  const filteredByStatusJoinRequests = useMemo(
    () => joinRequests.filter((request) => request.status === joinRequestStatusFilter),
    [joinRequests, joinRequestStatusFilter],
  );
  const tenantFilterOptions = useMemo(() => {
    const named = new Map<string, string>();
    tenants.forEach((tenant) => named.set(tenant.id, tenant.name));
    filteredByStatusJoinRequests.forEach((request) => {
      if (request.tenantId && request.tenantName && !named.has(request.tenantId)) {
        named.set(request.tenantId, request.tenantName);
      }
    });
    return Array.from(named.entries()).map(([id, name]) => ({ id, name }));
  }, [tenants, filteredByStatusJoinRequests]);
  const filteredJoinRequests = useMemo(
    () =>
      filteredByStatusJoinRequests.filter((request) =>
        joinRequestTenantFilter === 'all' ? true : request.tenantId === joinRequestTenantFilter,
      ),
    [filteredByStatusJoinRequests, joinRequestTenantFilter],
  );
  const joinRequestCodeStats = useMemo(() => {
    let viaCodes = 0;
    filteredJoinRequests.forEach((request) => {
      if (request.joinCodeId || request.joinCodeValue) {
        viaCodes += 1;
      }
    });
    return { viaCodes, total: filteredJoinRequests.length };
  }, [filteredJoinRequests]);
  const sortedJoinRequests = useMemo(() => {
    const list = [...filteredJoinRequests];
    list.sort((a, b) => {
      const aTime = new Date(a.requestedAt).getTime() || 0;
      const bTime = new Date(b.requestedAt).getTime() || 0;
      return joinRequestSort === 'newest' ? bTime - aTime : aTime - bTime;
    });
    return list;
  }, [filteredJoinRequests, joinRequestSort]);
  const visibleJoinRequests = useMemo(
    () => sortedJoinRequests.slice(0, joinRequestLimit),
    [sortedJoinRequests, joinRequestLimit],
  );
  const reviewerNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    [...memberships, ...pendingMemberships].forEach((membership) => {
      const preferred = membership.displayName?.trim();
      map[membership.userId] = preferred && preferred.length ? preferred : membership.email;
    });
    return map;
  }, [memberships, pendingMemberships]);
  const hasMoreJoinRequests = sortedJoinRequests.length > visibleJoinRequests.length;
  const canCollapseJoinRequests = joinRequestLimit > DEFAULT_JOIN_REQUEST_PAGE;
  const statusBaselineCount = joinRequestStatusFilter === 'pending'
    ? pendingJoinRequests.length
    : filteredByStatusJoinRequests.length;
  const filterIsActive = joinRequestTenantFilter !== 'all' || joinRequestStatusFilter !== 'pending';
  const statusLabel = joinRequestStatusFilter.charAt(0).toUpperCase() + joinRequestStatusFilter.slice(1);
  const filterSummaryDetails = filterIsActive
    ? joinRequestTenantFilter !== 'all'
      ? ` (filtered from ${statusBaselineCount})`
      : ` (${statusLabel} only)`
    : '';
  const emptyStateMessage = (() => {
    switch (joinRequestStatusFilter) {
      case 'pending':
        return "No pending requests. You're all caught up!";
      case 'approved':
        return 'No approved requests yet.';
      case 'rejected':
        return 'No rejected requests yet.';
      case 'expired':
        return 'No expired requests. Everything is up to date.';
      default:
        return 'No join requests found.';
    }
  })();

  const formatRequestStatusLabel = (status: TenantJoinRequestStatus): string => {
    switch (status) {
      case 'approved':
        return 'Approved';
      case 'rejected':
        return 'Rejected';
      case 'expired':
        return 'Expired';
      default:
        return 'Pending review';
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

  useEffect(() => {
    setJoinRequestLimit((prev) => {
      if (!sortedJoinRequests.length) {
        return DEFAULT_JOIN_REQUEST_PAGE;
      }
      const maxVisible = sortedJoinRequests.length;
      return Math.min(Math.max(DEFAULT_JOIN_REQUEST_PAGE, prev), maxVisible);
    });
  }, [sortedJoinRequests.length]);

  useEffect(() => {
    const activeIds = new Set(filteredByStatusJoinRequests.map((request) => request.id));
    setRequestRoles((prev) => {
      let changed = false;
      const next: Record<string, TenantMembershipRole> = {};
      Object.entries(prev).forEach(([id, role]) => {
        if (activeIds.has(id)) {
          next[id] = role;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [filteredByStatusJoinRequests]);

  const handleTenantFilterChange = (value: 'all' | string) => {
    setJoinRequestTenantFilter(value);
    setJoinRequestLimit(DEFAULT_JOIN_REQUEST_PAGE);
  };

  const handleStatusFilterChange = (value: 'pending' | 'approved' | 'rejected' | 'expired') => {
    setJoinRequestStatusFilter(value);
    setJoinRequestTenantFilter('all');
    setJoinRequestLimit(DEFAULT_JOIN_REQUEST_PAGE);
  };

  const handleToggleNotificationPref = (key: keyof TenantNotificationPreferences) => {
    setNotificationPrefs((prev) => {
      const next = {
        ...prev,
        [key]: !prev[key],
      };
      persistNotificationPrefDraft(next);
      return next;
    });
  };

  const renderNotificationToggle = (
    key: keyof TenantNotificationPreferences,
    label: string,
    description: string,
  ) => {
    const enabled = notificationPrefs[key];
    return (
      <View key={key} style={[styles.notificationRow, { borderColor: theme.border, backgroundColor: theme.surface }]}>
        <View style={styles.notificationTextContainer}>
          <Text style={[styles.notificationLabel, { color: theme.text }]}>{label}</Text>
          <Text style={[styles.notificationDescription, { color: theme.textSecondary }]}>{description}</Text>
        </View>
        <TouchableOpacity
          accessibilityRole="switch"
          accessibilityState={{ checked: enabled }}
          onPress={() => handleToggleNotificationPref(key)}
          style={[
            styles.notificationToggle,
            {
              backgroundColor: enabled ? theme.primary : theme.surface,
              borderColor: enabled ? theme.primary : theme.border,
            },
          ]}
        >
          <Text style={[styles.notificationToggleText, { color: enabled ? '#fff' : theme.text }]}>
            {enabled ? 'On' : 'Off'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  const handleReviewJoinRequest = async (
    requestId: string,
    action: 'approve' | 'reject',
    role?: TenantMembershipRole,
  ) => {
    if (!user?.uid) {
      Toast.show({
        type: 'error',
        text1: 'Not signed in',
        text2: 'Sign in again to manage join requests.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    setProcessingRequestId(requestId);
    try {
      if (action === 'approve') {
        await tenantService.approveJoinRequest(requestId, user.uid, role || 'staff', {
          actorName: user.displayName || user.email || undefined,
        });
        Toast.show({
          type: 'success',
          text1: 'Request approved',
          text2: `Member added as ${role || 'staff'}.`,
          position: 'top',
          topOffset: 60,
        });
      } else {
        await tenantService.rejectJoinRequest(requestId, user.uid, {
          actorName: user.displayName || user.email || undefined,
        });
        Toast.show({
          type: 'info',
          text1: 'Request rejected',
          text2: 'The applicant has been notified.',
          position: 'top',
          topOffset: 60,
        });
      }
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Action failed',
        text2: error instanceof Error ? error.message : 'Unable to update join request. Please try again.',
        position: 'top',
        topOffset: 60,
      });
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleSaveNotificationPrefs = async () => {
    if (!activeTenant?.id) {
      Toast.show({
        type: 'error',
        text1: 'No coaching center',
        text2: 'Select a coaching center to update notifications.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    setSavingNotificationPrefs(true);
    try {
      const result = await tenantService.updateNotificationPreferences({
        tenantId: activeTenant.id,
        notificationPreferences: notificationPrefs,
        metadata: {
          initiatedFrom: Platform.OS === 'web' ? 'web_admin_settings' : `${Platform.OS}_admin_settings`,
          actorName: user?.displayName || user?.email || undefined,
        },
      });
      const nextPrefs = { ...result.notificationPreferences };
      setNotificationPrefs(nextPrefs);
      setNotificationPrefsOriginal(nextPrefs);
      persistNotificationPrefDraft(null);
      applyTenantNotificationPreferencesSnapshot(activeTenant.id, nextPrefs);
      if (result.changedKeys.length) {
        await refreshTenants();
      }
      Toast.show({
        type: result.changedKeys.length ? 'success' : 'info',
        text1: result.changedKeys.length ? 'Preferences saved' : 'No changes detected',
        text2: result.changedKeys.length
          ? 'Membership notifications updated.'
          : 'Your settings were already up to date.',
        position: 'top',
        topOffset: 60,
      });
    } catch (error) {
      logger.warn('AdminSettings: failed to update notification prefs', error);
      Toast.show({
        type: 'error',
        text1: 'Save failed',
        text2: error instanceof Error ? error.message : 'Unable to update notifications.',
        position: 'top',
        topOffset: 60,
      });
    } finally {
      setSavingNotificationPrefs(false);
    }
  };

  const handleSave = async () => {
    const trimmedCoachingName = coachingName.trim();
    if (!trimmedCoachingName) {
      Toast.show({
        type: 'error',
        text1: 'Missing coaching name',
        text2: 'Enter a coaching name to continue.',
        position: 'top',
        topOffset: 60,
      });
      return;
    }
    try {
      setSaving(true);

      // H2: the two visibility flags are TENANT-scoped now and written via the
      // backend (tenants/{id}.settings). AdminSettings no longer writes the global
      // appSettings/globalSettings doc at all (that is global-admin-only, edited
      // from the operator admin-console). Support-contact fields were never
      // editable here.
      const nameChanged = activeTenant?.id && trimmedCoachingName !== (activeTenant.name || '').trim();
      const flagsChanged =
        (originalValues?.allowNonAdminAllReminderHistory ?? false) !== allowNonAdminAllReminderHistory ||
        (originalValues?.hideAuthorizedEmailsForNonAdmins ?? false) !== hideAuthorizedEmailsForNonAdmins;
      const existingLogoUrl = originalValues?.logoUrl || null;
      let finalLogoUrl = logoPreviewUrl || null;
      const hasPendingLogoUpload = Boolean(pendingLogoAsset);
      let logoSkippedBecauseStorageLimit = false;
      let logoUploadFailed = false;

      if (activeTenant?.id && hasPendingLogoUpload && pendingLogoAsset) {
        const uploadResult = await uploadTenantLogo(activeTenant.id, pendingLogoAsset);
        if (uploadResult.url) {
          finalLogoUrl = uploadResult.url;
          setLogoPreviewUrl(uploadResult.url);
          setPendingLogoAsset(null);
        } else {
          // Upload did not happen; keep existing tenant logo.
          finalLogoUrl = existingLogoUrl;
          if (uploadResult.skippedBecauseStorageLimit) logoSkippedBecauseStorageLimit = true;
          if (uploadResult.failed) logoUploadFailed = true;
        }
      }

      const logoChanged = (existingLogoUrl || null) !== (finalLogoUrl || null);

      if (activeTenant?.id && (nameChanged || logoChanged || flagsChanged)) {
        const tenantUpdatePayload: Parameters<typeof tenantService.updateTenant>[0] = {
          id: activeTenant.id,
          updatedBy: user?.uid,
        };
        if (nameChanged) {
          tenantUpdatePayload.name = trimmedCoachingName;
        }
        if (logoChanged) {
          tenantUpdatePayload.logoUrl = finalLogoUrl || null;
          tenantUpdatePayload.branding = {
            ...(activeTenant.branding || {}),
            logoUrl: finalLogoUrl || null,
          };
        }
        if (flagsChanged) {
          tenantUpdatePayload.settings = {
            allowNonAdminAllReminderHistory,
            hideAuthorizedEmailsForNonAdmins,
          };
        }
        await tenantService.updateTenant(tenantUpdatePayload);
        await refreshTenants();
      }

      let deleteOldLogoError: Error | null = null;
      const shouldDeletePreviousLogo = Boolean(existingLogoUrl && logoChanged && existingLogoUrl !== (finalLogoUrl || null));
      if (shouldDeletePreviousLogo) {
        try {
          await deleteTenantLogoByUrl(activeTenant?.id || '', existingLogoUrl);
        } catch (deleteError) {
          deleteOldLogoError = deleteError instanceof Error ? deleteError : new Error('Old logo could not be removed.');
          logger.warn('AdminSettings: delete tenant logo failed', deleteError);
        }
      }

      setCoachingName(trimmedCoachingName);
      // Keep modal open; show success toast and update originals so Save disables again
      const successText2 = logoSkippedBecauseStorageLimit
        ? 'Saved settings, but logo upload was skipped (storage limit reached).'
        : logoUploadFailed
          ? 'Saved settings, but the logo could not be uploaded.'
          : 'Your changes have been applied.';

      Toast.show({
        type: 'success',
        text1: 'Settings saved',
        text2: successText2,
        position: 'top',
        topOffset: 60,
        visibilityTime: 3000,
      });
      setOriginalValues({
        supportEmail,
        supportPhone,
        whatsappNumber,
        bugReportFormUrl,
        coachingName: trimmedCoachingName,
        allowNonAdminAllReminderHistory,
        hideAuthorizedEmailsForNonAdmins,
        logoUrl: finalLogoUrl || null,
      });
      // Optionally update local settings state to reflect latest
      setSettings(prev => prev ? {
        ...prev,
        supportEmail,
        supportPhone,
        whatsappNumber,
        bugReportFormUrl,
        allowNonAdminAllReminderHistory,
        hideAuthorizedEmailsForNonAdmins,
        coachingName: trimmedCoachingName,
      } : prev);

      if (deleteOldLogoError) {
        Toast.show({
          type: 'error',
          text1: 'Previous logo not removed',
          text2: deleteOldLogoError.message,
          position: 'top',
          topOffset: 60,
          visibilityTime: 4000,
        });
      }
    } catch (error) {
      logger.warn('AdminSettings: save failed', error);
      const message = error instanceof Error ? error.message : 'Failed to update settings. Please try again.';
      Toast.show({
        type: 'error',
        text1: 'Save failed',
        text2: message,
        position: 'top',
        topOffset: 60,
        visibilityTime: 4000,
      });
    } finally {
      setSaving(false);
    }
  };

  if (tenantUnavailable) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}> 
        <TenantSelectionEmptyState
          title="Select a coaching center"
          description="Choose, create, or join a coaching center from the Coaching centers section before managing admin settings."
          primaryActionLabel="Close"
          onPrimaryAction={onClose}
        />
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading admin settings…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={onClose}>
          <Text style={[styles.cancelButton, { color: theme.textSecondary }]}>Cancel</Text>
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Admin Settings</Text>
        {/** Save button disabled until changes are made (or while saving) **/}
        <TouchableOpacity onPress={handleSave} disabled={saving || !isDirty}>
          <View style={styles.saveButton}>
            <Save size={20} color={(saving || !isDirty) ? theme.textSecondary : theme.primary} />
            <Text style={[styles.saveButtonText, { color: (saving || !isDirty) ? theme.textSecondary : theme.primary }]}>
              {saving ? 'Saving...' : 'Save'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      <ScrollView ref={scrollRef} style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Branding */}
        <View style={styles.section} onLayout={handleSectionLayout('branding')}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Branding</Text>

          <View style={styles.formGroup}>
            <Text style={[styles.label, { color: theme.text }]}>Coaching Name</Text>
            <TextInput
              ref={coachingNameInputRef}
              style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text }]}
              placeholder="e.g., S.S Tuition Classes"
              placeholderTextColor={theme.textSecondary}
              value={coachingName}
              onChangeText={setCoachingName}
              autoCapitalize="words"
            />
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 8 }}>
              This name will appear in reminders, emails, and receipts.
            </Text>
            <View
              style={[
                styles.logoCard,
                { borderColor: theme.border, backgroundColor: theme.surface },
                logoPreviewUrl ? styles.logoCardFilled : null,
              ]}
            >
              {logoPreviewUrl ? (
                <>
                  <Image source={{ uri: logoPreviewUrl }} style={styles.logoSelectedImage} resizeMode="contain" />
                  <View style={[styles.logoBadge, { backgroundColor: `${theme.primary}E0` }]}> 
                    <Text style={styles.logoBadgeText}>Selected logo</Text>
                  </View>
                  <View style={[styles.logoActionRow, { borderTopColor: theme.border, backgroundColor: theme.surface }]}> 
                    <TouchableOpacity
                      style={[styles.logoActionButton, { borderColor: theme.primary }]}
                      onPress={handlePickBrandingLogo}
                      disabled={pickingLogo}
                    >
                      {pickingLogo ? (
                        <ActivityIndicator color={theme.primary} />
                      ) : (
                        <>
                          <ImagePlus size={16} color={theme.primary} />
                          <Text style={[styles.logoActionButtonText, { color: theme.primary }]}>Change image</Text>
                        </>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.logoActionButton, styles.logoActionButtonDestructive, { borderColor: theme.border }]}
                      onPress={handleRemoveBrandingLogo}
                      disabled={pickingLogo}
                    >
                      <Trash2 size={16} color={theme.textSecondary} />
                      <Text style={[styles.logoActionButtonText, { color: theme.textSecondary }]}>Remove</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <View style={styles.logoEmptyState}> 
                  <View style={[styles.logoPlaceholderIcon, { borderColor: theme.border, backgroundColor: `${theme.primary}10` }]}> 
                    <ImagePlus size={28} color={theme.primary} />
                  </View>
                  <Text style={[styles.logoTitle, { color: theme.text }]}>Add a logo</Text>
                  <Text style={[styles.logoSubtitle, { color: theme.textSecondary }]}> 
                    PNG/JPG up to {logoSizeLimitMb} MB. Transparent backgrounds look best.
                  </Text>
                  <TouchableOpacity
                    style={[styles.logoPrimaryButton, { backgroundColor: theme.primary }]}
                    onPress={handlePickBrandingLogo}
                    disabled={pickingLogo}
                  >
                    {pickingLogo ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <>
                        <ImagePlus size={16} color="#fff" />
                        <Text style={[styles.logoPrimaryButtonText, { color: '#fff' }]}>Choose image</Text>
                      </>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </View>
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 8 }}>
              Square images around 512×512 px keep your logo crisp on invites, reminders, and receipts.
            </Text>
          </View>
        </View>

        {/* Permissions */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Permissions</Text>

          <View style={styles.formGroup}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={[styles.label, { color: theme.text }]}>Allow non-admins to view ALL reminder history</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                  {"When enabled, non-admin users can switch to \"All reminders\" in history. When off, only admins can see all reminders."}
                </Text>
              </View>
              <TouchableOpacity
                accessibilityRole="switch"
                accessibilityState={{ checked: allowNonAdminAllReminderHistory }}
                onPress={() => setAllowNonAdminAllReminderHistory(v => !v)}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: allowNonAdminAllReminderHistory ? theme.primary : theme.surface
                }}
              >
                <Text style={{ color: allowNonAdminAllReminderHistory ? '#fff' : theme.text }}>
                  {allowNonAdminAllReminderHistory ? 'Enabled' : 'Disabled'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.formGroup}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={[styles.label, { color: theme.text }]}>{"Hide \"Authorized Emails\" from non-admins"}</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                  When enabled, only admins can view the Authorized Emails page. Non-admins won’t see it in Settings.
                </Text>
              </View>
              <TouchableOpacity
                accessibilityRole="switch"
                accessibilityState={{ checked: hideAuthorizedEmailsForNonAdmins }}
                onPress={() => setHideAuthorizedEmailsForNonAdmins(v => !v)}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: theme.border,
                  backgroundColor: hideAuthorizedEmailsForNonAdmins ? theme.primary : theme.surface
                }}
              >
                <Text style={{ color: hideAuthorizedEmailsForNonAdmins ? '#fff' : theme.text }}>
                  {hideAuthorizedEmailsForNonAdmins ? 'Enabled' : 'Disabled'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <TenantOnboardingChecklist onNavigate={handleOnboardingNavigate} />
        </View>

        <View style={styles.section}>
          <TenantUsageSummary
            onUpgradePress={handleNavigateToPlanAndBilling}
            onReconcileStorageUsage={handleReconcileStorageUsage}
            reconcilingStorage={reconcilingStorage}
          />
        </View>

        {/* Coaching Centers */}
        <View style={styles.section}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Coaching Centers</Text>
            <TouchableOpacity
              onPress={() => setCoachingCentersTooltipVisible((prev) => !prev)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Coaching centers info"
            >
              <Info size={18} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          {coachingCentersTooltipVisible ? (
            <View
              style={{
                marginTop: 10,
                marginBottom: 12,
                padding: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: theme.border,
                backgroundColor: theme.surface,
              }}
            >
              <Text style={{ color: theme.text, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>
                What these mean
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
                Centers: coaching centers (workspaces) this account can access.{"\n"}
                Members: memberships for this account across centers (not authorized emails).{"\n"}
                Pending: memberships/invites not active yet for this account.{"\n"}
                Join requests: pending requests to join any of your centers.
              </Text>
            </View>
          ) : null}
          <View style={styles.metricsRow}>
            <View style={[styles.metricCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>Centers</Text>
              <Text style={[styles.metricValue, { color: theme.text }]}>{tenants.length}</Text>
            </View>
            <View style={[styles.metricCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>Members</Text>
              <Text style={[styles.metricValue, { color: theme.text }]}>{memberships.length}</Text>
            </View>
            <View style={[styles.metricCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>Pending</Text>
              <Text style={[styles.metricValue, { color: theme.text }]}>{pendingMemberships.length}</Text>
            </View>
            <View style={[styles.metricCard, { backgroundColor: theme.surface, borderColor: theme.border }]}
            >
              <Text style={[styles.metricLabel, { color: theme.textSecondary }]}>Join requests</Text>
              <Text style={[styles.metricValue, { color: theme.text }]}>{pendingJoinRequests.length}</Text>
            </View>
          </View>
          <Text style={{ color: theme.textSecondary, fontSize: 13, marginBottom: 16 }}>
            Review which coaching centers this account belongs to, switch the active workspace, or use join codes
            without leaving the admin panel.
          </Text>
          <TenantMembershipManager />
        </View>

        <View style={styles.section} onLayout={handleSectionLayout('invites')}>
          <TenantInviteManager ref={inviteManagerRef} onUpgradePress={handleNavigateToPlanAndBilling} />
        </View>

        <View style={styles.section} onLayout={handleSectionLayout('joinCodes')}>
          <TenantJoinCodeManager ref={joinCodeManagerRef} />
        </View>

        {/* Notification Preferences */}
        <View style={styles.section} onLayout={handleSectionLayout('notifications')}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Notifications</Text>
          {!activeTenant ? (
            <View style={[styles.notificationEmpty, { borderColor: theme.border, backgroundColor: theme.surface }]}>
              <Text style={{ color: theme.textSecondary }}>
                Select a coaching center to manage membership alerts.
              </Text>
            </View>
          ) : (
            <>
              <Text style={[styles.notificationContext, { color: theme.textSecondary }]}>
                Applies to {activeTenant.name}. Switch centers to configure another workspace.
              </Text>
              {renderNotificationToggle(
                'membershipEventsEmail',
                'Email me when membership roles change',
                'Owner/admins receive an email whenever someone is added, removed, or promoted.',
              )}
              {renderNotificationToggle(
                'membershipEventsPush',
                'Send push notifications for membership changes',
                'Requires the mobile app to be installed and push permissions granted.',
              )}
              {renderNotificationToggle(
                'joinRequestEmail',
                'Email me about join requests',
                'Get notified when applicants request access to this coaching center.',
              )}
              {renderNotificationToggle(
                'joinRequestPush',
                'Push notifications for join requests',
                'Get a mobile push whenever a new join request arrives.',
              )}
              <View style={styles.notificationActions}>
                <TouchableOpacity
                  style={[
                    styles.notificationActionButton,
                    {
                      borderColor: theme.border,
                      backgroundColor: theme.surface,
                      opacity: notificationPrefsDirty && !savingNotificationPrefs ? 1 : 0.6,
                    },
                  ]}
                  disabled={!notificationPrefsDirty || savingNotificationPrefs}
                  onPress={() => setNotificationPrefs(notificationPrefsOriginal)}
                >
                  <RefreshCw size={16} color={theme.textSecondary} />
                  <Text style={[styles.notificationActionText, { color: theme.textSecondary }]}>Reset</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.notificationActionButton,
                    {
                      backgroundColor: notificationPrefsDirty ? theme.primary : theme.surface,
                      borderColor: notificationPrefsDirty ? theme.primary : theme.border,
                      opacity: notificationPrefsDirty && !savingNotificationPrefs ? 1 : 0.6,
                    },
                  ]}
                  disabled={!notificationPrefsDirty || savingNotificationPrefs}
                  onPress={handleSaveNotificationPrefs}
                >
                  <Save size={16} color={notificationPrefsDirty ? '#fff' : theme.textSecondary} />
                  <Text
                    style={[
                      styles.notificationActionText,
                      { color: notificationPrefsDirty ? '#fff' : theme.textSecondary },
                    ]}
                  >
                    {savingNotificationPrefs ? 'Saving…' : 'Save changes'}
                  </Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>

        {/* Join Requests */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Join Requests</Text>
          <View style={styles.joinRequestControls}>
            <View style={styles.joinRequestControlGroup}>
              <Text style={[styles.joinRequestControlLabel, { color: theme.textSecondary }]}>Status</Text>
              <View style={styles.joinRequestControlChips}>
                {(['pending', 'approved', 'rejected', 'expired'] as ('pending' | 'approved' | 'rejected' | 'expired')[]).map((status) => {
                  const active = joinRequestStatusFilter === status;
                  return (
                    <TouchableOpacity
                      key={status}
                      style={[
                        styles.joinRequestControlChip,
                        {
                          backgroundColor: active ? theme.primary : theme.surface,
                          borderColor: active ? theme.primary : theme.border,
                        },
                      ]}
                      onPress={() => handleStatusFilterChange(status)}
                    >
                      <Text
                        style={[
                          styles.joinRequestControlChipText,
                          { color: active ? '#fff' : theme.text },
                        ]}
                      >
                        {status.charAt(0).toUpperCase() + status.slice(1)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={styles.joinRequestControlGroup}>
              <Text style={[styles.joinRequestControlLabel, { color: theme.textSecondary }]}>Sort by</Text>
              <View style={styles.joinRequestControlChips}>
                {(['newest', 'oldest'] as ('newest' | 'oldest')[]).map((option) => {
                  const active = joinRequestSort === option;
                  return (
                    <TouchableOpacity
                      key={option}
                      style={[
                        styles.joinRequestControlChip,
                        {
                          backgroundColor: active ? theme.primary : theme.surface,
                          borderColor: active ? theme.primary : theme.border,
                        },
                      ]}
                      onPress={() => setJoinRequestSort(option)}
                    >
                      <Text
                        style={[
                          styles.joinRequestControlChipText,
                          { color: active ? '#fff' : theme.text },
                        ]}
                      >
                        {option === 'newest' ? 'Newest first' : 'Oldest first'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={styles.joinRequestControlGroup}>
              <Text style={[styles.joinRequestControlLabel, { color: theme.textSecondary }]}>Filter by center</Text>
              <View style={styles.joinRequestControlChips}>
                <TouchableOpacity
                  style={[
                    styles.joinRequestControlChip,
                    {
                      backgroundColor: joinRequestTenantFilter === 'all' ? theme.primary : theme.surface,
                      borderColor: joinRequestTenantFilter === 'all' ? theme.primary : theme.border,
                    },
                  ]}
                  onPress={() => handleTenantFilterChange('all')}
                >
                  <Text
                    style={[
                      styles.joinRequestControlChipText,
                      { color: joinRequestTenantFilter === 'all' ? '#fff' : theme.text },
                    ]}
                  >
                    All centers
                  </Text>
                </TouchableOpacity>
                {tenantFilterOptions.map((option) => {
                  const active = joinRequestTenantFilter === option.id;
                  return (
                    <TouchableOpacity
                      key={option.id}
                      style={[
                        styles.joinRequestControlChip,
                        {
                          backgroundColor: active ? theme.primary : theme.surface,
                          borderColor: active ? theme.primary : theme.border,
                        },
                      ]}
                      onPress={() => handleTenantFilterChange(option.id)}
                    >
                      <Text
                        numberOfLines={1}
                        style={[
                          styles.joinRequestControlChipText,
                          { color: active ? '#fff' : theme.text },
                        ]}
                      >
                        {option.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>
          {filteredByStatusJoinRequests.length === 0 ? (
            <View style={[styles.joinRequestEmpty, { borderColor: theme.border, backgroundColor: theme.surface }]}>
              <Text style={{ color: theme.textSecondary }}>{emptyStateMessage}</Text>
            </View>
          ) : (
            <>
              {joinRequestStatusFilter === 'pending' && joinRequestCodeStats.viaCodes > 0 && (
                <View
                  style={[
                    styles.joinRequestInfoBanner,
                    { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
                  ]}
                >
                  <KeyRound size={14} color={theme.warning} />
                  <Text style={[styles.joinRequestInfoText, { color: theme.warning }]}> 
                    {joinRequestCodeStats.viaCodes} of {joinRequestCodeStats.total} pending requests came from join codes.
                  </Text>
                </View>
              )}
              <View style={styles.joinRequestListWindow}>
                <ScrollView
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                  style={styles.joinRequestListScroll}
                  contentContainerStyle={styles.joinRequestListContent}
                >
                  {visibleJoinRequests.map((request) => {
                    const selectedRole = requestRoles[request.id] || 'staff';
                    const requestedAtDate = new Date(request.requestedAt);
                    const reviewedAtDate = request.reviewedAt ? new Date(request.reviewedAt) : null;
                    const expiresAtDate = request.expiresAt ? new Date(request.expiresAt) : null;
                    const fromJoinCode = Boolean(request.joinCodeId || request.joinCodeValue);
                    const isPending = request.status === 'pending';
                    const isExpired = request.status === 'expired';
                    const requestedLabel = formatDateToString(requestedAtDate);
                    const expiresLabel = expiresAtDate ? formatDateToString(expiresAtDate) : null;
                    const expiryMeta = (() => {
                      if (!expiresLabel) {
                        return '';
                      }
                      if (isExpired) {
                        return ` • Expired ${expiresLabel}`;
                      }
                      if (isPending) {
                        return ` • Expires ${expiresLabel}`;
                      }
                      return '';
                    })();
                    const statusAccent = getRequestStatusAccent(request.status);
                    const statusLabel = formatRequestStatusLabel(request.status);
                    const reviewedLabel = reviewedAtDate ? formatDateToString(reviewedAtDate) : null;
                    const reviewerDisplayName = request.reviewedBy
                      ? reviewerNameMap[request.reviewedBy] || request.reviewedBy
                      : null;
                    const autoExpireLabel = reviewedLabel || (expiresAtDate ? formatDateToString(expiresAtDate) : null);
                    const reviewMetaText = (() => {
                      if (isExpired) {
                        return `Auto-expired${autoExpireLabel ? ` on ${autoExpireLabel}` : ''}`;
                      }
                      if (!isPending && (reviewerDisplayName || reviewedLabel)) {
                        return `Reviewed${reviewerDisplayName ? ` by ${reviewerDisplayName}` : ''}${
                          reviewedLabel ? ` • ${reviewedLabel}` : ''
                        }`;
                      }
                      return null;
                    })();
                    return (
                      <View
                        key={request.id}
                        style={[styles.joinRequestCard, { borderColor: theme.border, backgroundColor: theme.surface }]}
                      >
                        <View style={styles.joinRequestHeaderRow}>
                          <Text style={[styles.joinRequestName, styles.joinRequestHeaderName, { color: theme.text }]}> 
                            {request.displayName || request.email}
                          </Text>
                          <View style={styles.joinRequestStatusContainer}>
                            <View
                              style={[
                                styles.joinRequestStatusBadge,
                                {
                                  backgroundColor: statusAccent.background,
                                  borderColor: statusAccent.border,
                                },
                              ]}
                            >
                              <Text style={[styles.joinRequestStatusText, { color: statusAccent.text }]}> 
                                {statusLabel}
                              </Text>
                            </View>
                          </View>
                        </View>
                        <Text style={[styles.joinRequestEmail, { color: theme.textSecondary }]}>{request.email}</Text>
                        <Text style={[styles.joinRequestMeta, { color: theme.textSecondary }]}> 
                          Requested {requestedLabel}
                          {expiryMeta}
                        </Text>
                        {fromJoinCode && (
                          <View
                            style={[
                              styles.joinRequestCodeBadge,
                              { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
                            ]}
                          >
                            <KeyRound size={14} color={theme.warning} />
                            <Text style={[styles.joinRequestCodeBadgeText, { color: theme.warning }]}> 
                              {request.joinCodeValue ? `Join code ${request.joinCodeValue}` : 'Requested via join code'}
                            </Text>
                          </View>
                        )}
                        {!!request.message && (
                          <Text style={[styles.joinRequestMessage, { color: theme.textSecondary }]}>
                            {request.message}
                          </Text>
                        )}
                        {isPending ? (
                          <>
                            <View style={styles.joinRequestRoleRow}>
                              <Text style={[styles.joinRequestRoleLabel, { color: theme.textSecondary }]}>Assign role</Text>
                              <View style={styles.joinRequestRoleChips}>
                                {(['owner', 'admin', 'staff', 'member'] as TenantMembershipRole[]).map((roleOption) => {
                                  const active = selectedRole === roleOption;
                                  return (
                                    <TouchableOpacity
                                      key={roleOption}
                                      style={[
                                        styles.joinRequestRoleChip,
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
                                      <Text
                                        style={[
                                          styles.joinRequestRoleChipText,
                                          { color: active ? '#fff' : theme.text },
                                        ]}
                                      >
                                        {roleOption.charAt(0).toUpperCase() + roleOption.slice(1)}
                                      </Text>
                                    </TouchableOpacity>
                                  );
                                })}
                              </View>
                            </View>
                            <View style={styles.joinRequestActions}>
                              <TouchableOpacity
                                style={[styles.joinRequestButton, styles.joinRequestRejectButton, { borderColor: theme.border }]}
                                onPress={() => handleReviewJoinRequest(request.id, 'reject')}
                                disabled={processingRequestId === request.id}
                              >
                                <Text style={[styles.joinRequestButtonText, { color: theme.error }]}> 
                                  {processingRequestId === request.id ? 'Working…' : 'Reject'}
                                </Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={[styles.joinRequestButton, styles.joinRequestApproveButton, { backgroundColor: theme.primary }]}
                                onPress={() => handleReviewJoinRequest(request.id, 'approve', selectedRole)}
                                disabled={processingRequestId === request.id}
                              >
                                <Text style={[styles.joinRequestButtonText, { color: '#fff' }]}> 
                                  {processingRequestId === request.id ? 'Working…' : 'Approve'}
                                </Text>
                              </TouchableOpacity>
                            </View>
                          </>
                        ) : (
                          <View style={[styles.joinRequestDecisionSummary, { borderColor: theme.border }]}> 
                            <Text style={[styles.joinRequestDecisionText, { color: theme.textSecondary }]}> 
                              Decision: {statusLabel}
                            </Text>
                            {reviewMetaText && (
                              <Text style={[styles.joinRequestDecisionText, { color: theme.textSecondary }]}> 
                                {reviewMetaText}
                              </Text>
                            )}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
              {(hasMoreJoinRequests || canCollapseJoinRequests) && (
                <View style={styles.joinRequestPaginationRow}>
                  <Text style={[styles.joinRequestPaginationSummary, { color: theme.textSecondary }]}> 
                    Showing {visibleJoinRequests.length} of {sortedJoinRequests.length}
                    {filterSummaryDetails}
                  </Text>
                  <View style={styles.joinRequestPaginationButtons}>
                    {canCollapseJoinRequests && (
                      <TouchableOpacity
                        style={[styles.joinRequestPaginationButton, { borderColor: theme.border }]}
                        onPress={() => setJoinRequestLimit(DEFAULT_JOIN_REQUEST_PAGE)}
                      >
                        <Text style={[styles.joinRequestPaginationText, { color: theme.textSecondary }]}>Show fewer</Text>
                      </TouchableOpacity>
                    )}
                    {hasMoreJoinRequests && (
                      <TouchableOpacity
                        style={[styles.joinRequestPaginationButton, { backgroundColor: theme.primary }]}
                        onPress={() =>
                          setJoinRequestLimit((prev) =>
                            Math.min(prev + DEFAULT_JOIN_REQUEST_PAGE, sortedJoinRequests.length),
                          )
                        }
                      >
                        <Text style={[styles.joinRequestPaginationText, { color: '#fff' }]}>Show more</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              )}
            </>
          )}
        </View>

        <View style={styles.bottomPadding} />
      </ScrollView>

        <ConfirmationModal
          visible={reconcileStorageConfirmVisible}
          onClose={() => setReconcileStorageConfirmVisible(false)}
          title="Reconcile storage usage"
          message="This will rescan your storage bucket and update the storage usage counter for this center. Use this if storage numbers look wrong after manual deletions or migrations."
          confirmText="Reconcile"
          cancelText="Cancel"
          onConfirm={handleConfirmReconcileStorageUsage}
          confirmStyle="primary"
          autoCloseOnConfirm={false}
          confirmLoading={reconcilingStorage}
          confirmDisabled={reconcilingStorage}
          cancelDisabled={reconcilingStorage}
        />

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 50 : 20,
    paddingBottom: 15,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  cancelButton: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  saveButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    fontWeight: '500',
  },
  section: {
    marginTop: 24,
  },
  metricsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
    marginHorizontal: -6,
  },
  metricCard: {
    flexGrow: 1,
    minWidth: 120,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginHorizontal: 6,
    marginBottom: 12,
  },
  metricLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metricValue: {
    marginTop: 6,
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 16,
  },
  formGroup: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  logoCard: {
    borderWidth: 1,
    borderRadius: 20,
    marginTop: 16,
    padding: 16,
    position: 'relative',
  },
  logoCardFilled: {
    padding: 0,
    overflow: 'hidden',
  },
  logoSelectedImage: {
    width: '100%',
    height: 190,
    backgroundColor: '#fff',
  },
  logoBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  logoBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    color: '#fff',
  },
  logoActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  logoActionButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  logoActionButtonDestructive: {
    backgroundColor: 'transparent',
  },
  logoActionButtonText: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },
  logoEmptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    paddingHorizontal: 16,
  },
  logoPlaceholderIcon: {
    width: 68,
    height: 68,
    borderWidth: 1,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  logoTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 6,
    textAlign: 'center',
  },
  logoSubtitle: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginBottom: 16,
  },
  logoPrimaryButton: {
    borderRadius: 999,
    paddingHorizontal: 24,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  logoPrimaryButtonText: {
    fontSize: 15,
    fontFamily: 'Inter-SemiBold',
  },
  notificationEmpty: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  notificationContext: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    marginBottom: 12,
  },
  notificationRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 16,
  },
  notificationTextContainer: {
    flex: 1,
  },
  notificationLabel: {
    fontSize: 15,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  notificationDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  notificationToggle: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minWidth: 72,
    alignItems: 'center',
  },
  notificationToggleText: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },
  notificationActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 8,
  },
  notificationActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  notificationActionText: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },
  bottomPadding: {
    height: 40,
  },
  joinRequestEmpty: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#F8FAFC',
  },
  joinRequestInfoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  joinRequestInfoText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    flex: 1,
  },
  joinRequestCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  joinRequestHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  joinRequestName: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  joinRequestHeaderName: {
    flex: 1,
    marginRight: 8,
  },
  joinRequestEmail: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    marginTop: 4,
  },
  joinRequestMeta: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  joinRequestStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  joinRequestStatusBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  joinRequestStatusText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    textTransform: 'capitalize',
  },
  joinRequestCodeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 12,
    marginTop: 8,
    alignSelf: 'flex-start',
  },
  joinRequestCodeBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  joinRequestMessage: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 8,
    lineHeight: 18,
  },
  joinRequestControls: {
    marginBottom: 16,
  },
  joinRequestListWindow: {
    maxHeight: 360,
  },
  joinRequestListScroll: {
    flexGrow: 0,
  },
  joinRequestListContent: {
    paddingBottom: 8,
  },
  joinRequestControlGroup: {
    marginBottom: 12,
  },
  joinRequestControlLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginBottom: 6,
  },
  joinRequestControlChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  joinRequestControlChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginHorizontal: 4,
    marginBottom: 8,
  },
  joinRequestControlChipText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  joinRequestRoleRow: {
    marginTop: 12,
  },
  joinRequestRoleLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginBottom: 6,
  },
  joinRequestRoleChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  joinRequestRoleChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginHorizontal: 4,
    marginBottom: 8,
  },
  joinRequestRoleChipText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  joinRequestActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  joinRequestDecisionSummary: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginTop: 16,
  },
  joinRequestDecisionText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
  joinRequestButton: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderWidth: 1,
    marginLeft: 10,
  },
  joinRequestRejectButton: {
    backgroundColor: 'transparent',
  },
  joinRequestApproveButton: {
    borderColor: 'transparent',
  },
  joinRequestButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  joinRequestPaginationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 8,
    flexWrap: 'wrap',
    width: '100%',
  },
  joinRequestPaginationSummary: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginBottom: 8,
    marginRight: 12,
  },
  joinRequestPaginationButtons: {
    flexDirection: 'row',
    marginTop: 8,
  },
  joinRequestPaginationButton: {
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    marginLeft: 10,
  },
  joinRequestPaginationText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
});
