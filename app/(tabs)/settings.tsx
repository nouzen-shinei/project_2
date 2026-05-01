import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  TextInput,
  Modal,
  Platform,
  Linking,
  Share,
  Image,
  Pressable,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { User, Bell, Shield, Palette, CircleHelp as HelpCircle, LogOut, ChevronRight, Moon, Sun, Mail, MessageSquare, Phone, Download, Trash2, Plus, X, UserCheck, Upload, Pencil, Save, Camera, FileText, ExternalLink, Settings as SettingsIcon, Monitor, Calendar, RefreshCw, CreditCard } from 'lucide-react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { doc, getDoc } from 'firebase/firestore';

import { useAuth, authService } from '../../hooks/useAuthUnified';
import { useEasedUploadProgress } from '@/hooks/useEasedUploadProgress';
import useStudents from '../../hooks/useStudents';
import useFees from '../../hooks/useFees';
import { useTheme } from '../../hooks/useTheme';
import { useBirthdays } from '../../components/BirthdayProvider';
import { useSettings } from '../../hooks/useSettings';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';
import AdminSettings from '../../components/AdminSettings';
import DownloadReportsPage from '@/components/DownloadReportsPage';
import TenantMembershipManager from '@/components/TenantMembershipManager';
import NotificationsPage from '../../components/NotificationSettings';
import { dataManagementService } from '../../services/dataManagementService';
import { useTenant } from '../../hooks/useTenantContext';
import { chatService } from '../../services/chatService';
import { chatCacheService } from '../../services/chatCacheService';
import { MediaPickerUtil } from '../../lib/mediaPickerUtil';
import { formatDateToString } from '../../lib/utils';
import { auth, firestore } from '../../config/firebase';
import { logger } from '@/lib/logger';
import { tenantService } from '@/services/tenantService';
import type { TenantInvite, TenantMembership, TenantMembershipRole } from '@/types';
import { STORAGE_KEYS, PROTECTED_CACHE_KEYS } from '@/lib/storageKeys';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import { ROLE_BADGE_MAP, type RoleBadgeConfig } from '@/lib/roleBadges';
import { canShowInstallPrompt, isAppInstalled, showInstallPrompt } from '../../lib/pwa';

const formatBytes = (bytes: number): string => {
  if (!bytes) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatTimestamp = (value: string | null): string => {
  if (!value) {
    return 'Never';
  }
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    logger.warn('Failed to format timestamp', { value, error });
    return 'Never';
  }
};

const getByteSize = (value: string): number => {
  if (!value) {
    return 0;
  }
  try {
    if (typeof Blob !== 'undefined') {
      return new Blob([value]).size;
    }
    // Fallback for environments without Blob (e.g., web tests)
    return value.length;
  } catch {
    return value.length;
  }
};

const LEGACY_USER_PROFILE_STORAGE_KEY = 'userProfile';
const MAX_DISPLAY_NAME_LENGTH = 80;

const normalizeDisplayName = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_DISPLAY_NAME_LENGTH);
};

const fallbackDisplayNameFromEmail = (email: string | null | undefined): string => {
  if (!email) {
    return '';
  }
  const localPart = email.split('@')[0]?.trim() || '';
  return localPart.slice(0, MAX_DISPLAY_NAME_LENGTH);
};

const normalizeNameForComparison = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

const isEmailPrefixFallbackDisplayName = (
  displayName: unknown,
  email: string | null | undefined
): boolean => {
  const normalizedDisplayName = normalizeDisplayName(displayName);
  if (!normalizedDisplayName || !email) {
    return false;
  }

  const localPart = email.split('@')[0]?.trim() || '';
  if (!localPart) {
    return false;
  }

  const rawFallback = localPart.slice(0, MAX_DISPLAY_NAME_LENGTH);
  const spacedFallback = rawFallback.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const titleFallback = spacedFallback.replace(/\b\w/g, (letter: string) => letter.toUpperCase());

  const candidates = new Set<string>([
    normalizeNameForComparison(rawFallback),
    normalizeNameForComparison(spacedFallback),
    normalizeNameForComparison(titleFallback),
  ]);

  return candidates.has(normalizeNameForComparison(normalizedDisplayName));
};

const resolveDisplayName = (...candidates: unknown[]): string => {
  for (const candidate of candidates) {
    const normalized = normalizeDisplayName(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return '';
};

const resolveDisplayNamePreferringGoogle = (
  profileDisplayName: unknown,
  googleDisplayName: unknown,
  email: string | null | undefined
): string => {
  const normalizedProfileDisplayName = normalizeDisplayName(profileDisplayName);
  const normalizedGoogleDisplayName = normalizeDisplayName(googleDisplayName);

  if (
    normalizedGoogleDisplayName &&
    normalizedProfileDisplayName &&
    isEmailPrefixFallbackDisplayName(normalizedProfileDisplayName, email)
  ) {
    return normalizedGoogleDisplayName;
  }

  return resolveDisplayName(
    normalizedProfileDisplayName,
    normalizedGoogleDisplayName,
    fallbackDisplayNameFromEmail(email)
  );
};

const getUserProfileStorageKey = (email: string | null | undefined): string => {
  if (!email) {
    return LEGACY_USER_PROFILE_STORAGE_KEY;
  }
  return `${LEGACY_USER_PROFILE_STORAGE_KEY}:${email.toLowerCase()}`;
};

type CacheInsights = {
  totalBytes: number;
  removableBytes: number;
  totalKeys: number;
  removableKeys: number;
  protectedKeys: number;
  topRemovableKeys: { key: string; bytes: number }[];
};

const EMPTY_CACHE_INSIGHTS: CacheInsights = {
  totalBytes: 0,
  removableBytes: 0,
  totalKeys: 0,
  removableKeys: 0,
  protectedKeys: 0,
  topRemovableKeys: [],
};

type CacheClearSummary = {
  storageItemsRemoved: number;
  storageBytesFreed: number;
  mediaFilesDeleted: number;
  mediaPreviewFilesDeleted: number;
  mediaBytesFreed: number;
  totalMediaFiles: number;
  totalFreedBytes: number;
};

export default function Settings() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { theme, isDarkMode, themeMode, setThemeMode } = useTheme();
  const { user, signOut, loading: authLoading } = useAuth();
  const { activeTenant, activeMembership, loading: tenantLoading } = useTenant();
  const { students } = useStudents();
  const { fees } = useFees();
  const {
    settings: appSettings,
    contactInfo,
    appInfo,
    supportInfo,
    updatedAt,
    loading: settingsLoading,
  } = useSettings();
  const { headerCompensation } = useBirthdays();
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);
  const sharedTopPadding = useSharedTopPadding();
  const modalTopPadding = 16;

  const tenantUnavailable = !tenantLoading && !activeTenant?.id;

  const [authorizedMembers, setAuthorizedMembers] = useState<TenantMembership[]>([]);
  const [authorizedMembersLoading, setAuthorizedMembersLoading] = useState(false);
  const [authorizedMembersError, setAuthorizedMembersError] = useState<string | null>(null);
  const [pendingInvites, setPendingInvites] = useState<TenantInvite[]>([]);
  const [pendingInvitesLoading, setPendingInvitesLoading] = useState(false);
  const [pendingInvitesError, setPendingInvitesError] = useState<string | null>(null);

  useEffect(() => {
    if (tenantUnavailable) {
      setAuthorizedMembers([]);
      setAuthorizedMembersLoading(false);
      setAuthorizedMembersError(null);
      setPendingInvites([]);
      setPendingInvitesLoading(false);
      setPendingInvitesError(null);
    }
  }, [tenantUnavailable]);

  const isAdmin = useMemo(() => {
    if (user?.role === 'admin') {
      return true;
    }
    if (!activeMembership) {
      return false;
    }
    return activeMembership.role === 'owner' || activeMembership.role === 'admin';
  }, [user?.role, activeMembership]);

  const derivedRole: TenantMembershipRole | null = activeMembership?.role
    ? activeMembership.role
    : user?.role === 'admin'
      ? 'admin'
      : null;

  const roleBadge = useMemo<RoleBadgeConfig | null>(() => {
    if (!derivedRole) {
      return null;
    }
    return ROLE_BADGE_MAP[derivedRole] ?? null;
  }, [derivedRole]);

  const canShowTeamMembersList = isAdmin || !appSettings?.hideAuthorizedEmailsForNonAdmins;

  const [componentLoading, setComponentLoading] = useState(true);

  const { showLoading: showOfflineLoadingSettings, offlineHint: offlineHintSettings } = useOfflineDataGate(
    [students, fees],
    [authLoading, settingsLoading]
  );

  const [showEmailModal, setShowEmailModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showAppInfoModal, setShowAppInfoModal] = useState(false);
  const [showBugReportModal, setShowBugReportModal] = useState(false);
  const [showSignOutModal, setShowSignOutModal] = useState(false);
  const [showClearCacheModal, setShowClearCacheModal] = useState(false);
  const [showExportConfirmModal, setShowExportConfirmModal] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [showDownloadReports, setShowDownloadReports] = useState(false);
  const [showDeletionRequestModal, setShowDeletionRequestModal] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [showLegalConfirmModal, setShowLegalConfirmModal] = useState(false);
  const [pendingLegalType, setPendingLegalType] = useState<'privacy' | 'terms' | null>(null);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);

  const openPolicy = useCallback(
    (type: 'privacy' | 'terms') => {
      try {
        const urlFromSettings =
          type === 'privacy' ? appSettings?.legal?.privacyPolicyUrl : appSettings?.legal?.termsOfServiceUrl;
        const fallbackWeb = type === 'privacy' ? '/privacy-policy.html' : '/terms-of-service.html';
        const target = urlFromSettings || (Platform.OS === 'web' ? fallbackWeb : undefined);
        if (!target) {
          Alert.alert('Missing link', 'The policy link is not set yet.');
          return;
        }
        Linking.openURL(target).catch(() => {
          Alert.alert('Unable to open link', 'Please try again later.');
        });
      } catch (error) {
        logger.error('Open policy error:', error);
        Alert.alert('Error', 'Failed to open link.');
      }
    },
    [appSettings?.legal?.privacyPolicyUrl, appSettings?.legal?.termsOfServiceUrl]
  );

  // Profile editing
  type ProfileFormData = {
    displayName: string;
    email: string;
    photoURL: string;
    phone: string;
    school: string;
    bio: string;
    dateOfBirth: string;
    salutation: '' | 'Mr.' | 'Ms.';
    subjects: string[];
  };

  const [pwaInstalled, setPwaInstalled] = useState(false);
  const [pwaInstallAvailable, setPwaInstallAvailable] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    try {
      setPwaInstalled(isAppInstalled());
    } catch {
      // ignore
    }

    const update = () => {
      try {
        setPwaInstallAvailable(canShowInstallPrompt());
      } catch {
        // ignore
      }
    };

    update();

    const onAvailable = () => update();
    const onInstalled = () => {
      try {
        setPwaInstalled(true);
      } catch {
        // ignore
      }
      update();
    };

    window.addEventListener('tm:pwa-install-available', onAvailable);
    window.addEventListener('tm:pwa-installed', onInstalled);
    return () => {
      window.removeEventListener('tm:pwa-install-available', onAvailable);
      window.removeEventListener('tm:pwa-installed', onInstalled);
    };
  }, []);

  const handleInstallWebApp = useCallback(async () => {
    if (Platform.OS !== 'web') {
      return;
    }

    try {
      const accepted = await showInstallPrompt();
      if (accepted) {
        setPwaInstalled(true);
        return;
      }
    } catch {
      // fall through
    }

    Alert.alert(
      'Install Tuition Manager',
      "If you don't see an install popup, use your browser menu:\n\n- Chrome/Edge (desktop): menu → Install app\n- Android Chrome: menu → Add to Home screen\n- iPhone/iPad Safari: Share → Add to Home Screen"
    );
  }, []);
  const [editingProfile, setEditingProfile] = useState(false);
  const [hasRemoteProfileLoaded, setHasRemoteProfileLoaded] = useState(false);
  const [profileData, setProfileData] = useState<ProfileFormData>({
    displayName: resolveDisplayName(user?.displayName, fallbackDisplayNameFromEmail(user?.email)),
    email: user?.email || '',
    photoURL: user?.photoURL || '',
    phone: '',
    school: '',
    bio: '',
    dateOfBirth: '',
    salutation: '' as '' | 'Mr.' | 'Ms.',
    subjects: [] as string[],
  });
  const [originalProfileData, setOriginalProfileData] = useState<ProfileFormData>({
    displayName: resolveDisplayName(user?.displayName, fallbackDisplayNameFromEmail(user?.email)),
    email: user?.email || '',
    photoURL: user?.photoURL || '',
    phone: '',
    school: '',
    bio: '',
    dateOfBirth: '',
    salutation: '' as '' | 'Mr.' | 'Ms.',
    subjects: [] as string[],
  });

  // Profile picture management - simplified (no useCustomImage needed)
  const [customProfilePicture, setCustomProfilePicture] = useState<string | null>(null);
  const [currentProfilePictureURL, setCurrentProfilePictureURL] = useState<string>('');
  const [originalProfilePictureURL, setOriginalProfilePictureURL] = useState<string>('');
  const [newCustomPictureUploaded, setNewCustomPictureUploaded] = useState<boolean>(false);
  const [pendingProfilePictureUri, setPendingProfilePictureUri] = useState<string | null>(null);
  const [uploadingProfilePicture, setUploadingProfilePicture] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const easedUploadProgress = useEasedUploadProgress(uploadProgress, {
    isActive: uploadingProfilePicture,
    smoothingPerSecond: 9,
    minStepPercent: 0.12,
    completionSnapThresholdPercent: 99.2,
    nearCompletionBoostStartPercent: 96,
    nearCompletionBoostMultiplier: 1.3,
  });
  const [showImagePickerModal, setShowImagePickerModal] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [selectedImageFileName, setSelectedImageFileName] = useState<string | null>(null);
  const [selectedImageFileSize, setSelectedImageFileSize] = useState<number | null>(null);
  const resolvedDisplayName = useMemo(
    () =>
      resolveDisplayNamePreferringGoogle(
        profileData.displayName,
        user?.displayName,
        user?.email
      ),
    [profileData.displayName, user?.displayName, user?.email]
  );
  const resolvedDisplayInitial = useMemo(
    () => (resolvedDisplayName.charAt(0) || 'U').toUpperCase(),
    [resolvedDisplayName]
  );
  const hasUnsavedChanges = useMemo(() => {
    if (!editingProfile) return false;
    const fieldsToCheck: (keyof ProfileFormData)[] = ['displayName', 'phone', 'school', 'bio', 'dateOfBirth', 'salutation'];
    for (const key of fieldsToCheck) {
      if ((profileData[key] || '') !== (originalProfileData[key] || '')) return true;
    }
    const origSubs = originalProfileData.subjects || [];
    const currSubs = profileData.subjects || [];
    if (origSubs.length !== currSubs.length) return true;
    for (let i = 0; i < origSubs.length; i++) {
      if (origSubs[i] !== currSubs[i]) return true;
    }
    if (pendingProfilePictureUri) return true;
    if (currentProfilePictureURL !== originalProfilePictureURL) return true;
    return false;
  }, [editingProfile, profileData, originalProfileData, pendingProfilePictureUri, currentProfilePictureURL, originalProfilePictureURL]);
  const [subjectInput, setSubjectInput] = useState('');
  const tryAddSubject = () => {
    const name = subjectInput.trim();
    if (!name) return;
    const exists = profileData.subjects?.some((s) => s.toLowerCase() === name.toLowerCase());
    if (exists) {
      setSubjectInput('');
      return;
    }
    setProfileData({ ...profileData, subjects: [...(profileData.subjects || []), name] });
    setSubjectInput('');
  };

  const [cacheSize, setCacheSize] = useState(formatBytes(0));
  const [cacheInsights, setCacheInsights] = useState<CacheInsights>(EMPTY_CACHE_INSIGHTS);
  const [lastCacheClearAt, setLastCacheClearAt] = useState<string | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  const protectedCacheKeys = useMemo(() => new Set(PROTECTED_CACHE_KEYS), []);
  const isProtectedKey = useCallback((key: string) => protectedCacheKeys.has(key), [protectedCacheKeys]);

  const openDownloadReports = useCallback(
    (source?: string) => {
      router.setParams({
        downloadReports: '1',
        source: source ?? undefined,
      });
      setShowDownloadReports(true);
    },
    [router]
  );

  const closeDownloadReports = useCallback(() => {
    router.setParams({ downloadReports: undefined, source: undefined });
    setShowDownloadReports(false);
  }, [router]);

  useEffect(() => {
    setHasRemoteProfileLoaded(false);
  }, [user?.email]);

  useEffect(() => {
    const paramValue = Array.isArray(params.downloadReports) ? params.downloadReports[0] : params.downloadReports;

    if (paramValue === '1' || paramValue === 'true') {
      setShowDownloadReports(true);
    }
  }, [params.downloadReports]);

  // Backup management - TODO: Implement these features
  // const [showBackupModal, setShowBackupModal] = useState(false);
  // const [backups, setBackups] = useState<Array<{ key: string; date: string; size: number }>>([]);
  // const [loadingBackups, setLoadingBackups] = useState(false);
  // Handle component loading state based on auth status
  useEffect(() => {
    logger.debug('Settings: Auth loading state changed', { authLoading, user: user?.email });
    
    // Set a timeout to prevent indefinite loading
    const authTimeout = setTimeout(() => {
      logger.debug('Settings: Auth timeout reached, stopping component loading');
      setComponentLoading(false);
    }, 2000); // 2 second timeout

    let isCancelled = false;
    
    if (!authLoading && user) {
      // Auth is complete and user is available
      clearTimeout(authTimeout);
      setComponentLoading(false);

      if (editingProfile) {
        return () => {
          isCancelled = true;
          clearTimeout(authTimeout);
        };
      }
      
      // Update profile data when user becomes available and fetch latest from Firebase
      const loadUserProfile = async () => {
        try {
          const profile = await authService.getUserProfile(user.email);
          if (isCancelled) {
            return;
          }
          const normalizedDisplayName = resolveDisplayNamePreferringGoogle(
            profile?.displayName,
            user.displayName,
            user.email
          );
          const updatedProfileData: ProfileFormData = {
            displayName: normalizedDisplayName,
            email: user.email || '',
            photoURL: profile?.photoURL || user.photoURL || '',
            school: typeof profile?.school === 'string' ? profile.school : '',
            bio: typeof profile?.bio === 'string' ? profile.bio : '',
            phone: typeof profile?.phone === 'string' ? profile.phone : '',
            dateOfBirth: typeof profile?.dateOfBirth === 'string' ? profile.dateOfBirth : '',
            salutation: (profile?.salutation as 'Mr.' | 'Ms.' | undefined) || '',
            subjects: Array.isArray(profile?.subjects)
              ? (profile.subjects as string[])
                  .map((subject) => String(subject || '').trim())
                  .filter(Boolean)
              : [],
          };
          setHasRemoteProfileLoaded(true);
          setProfileData(updatedProfileData);
          setOriginalProfileData(updatedProfileData);
          
          // Update current profile picture URL with the actual photoURL from tenant profile collection
          setCurrentProfilePictureURL(profile?.photoURL || user.photoURL || '');
        } catch (error) {
          if (isCancelled) {
            return;
          }
          logger.error('Error loading user profile:', error);
          const fallbackProfileData: ProfileFormData = {
            displayName: resolveDisplayName(user.displayName, fallbackDisplayNameFromEmail(user.email)),
            email: user.email || '',
            photoURL: user.photoURL || '',
            school: '',
            bio: '',
            phone: '',
            dateOfBirth: '',
            salutation: '',
            subjects: [],
          };
          setProfileData(fallbackProfileData);
          setOriginalProfileData(fallbackProfileData);
          
          // Fallback: use user's photoURL if profile loading fails
          setCurrentProfilePictureURL(user.photoURL || '');
        }
      };
      
      loadUserProfile();
    } else if (!authLoading && !user) {
      // Auth is complete but no user (not logged in)
      clearTimeout(authTimeout);
      setComponentLoading(false);
    }
    
    return () => {
      isCancelled = true;
      clearTimeout(authTimeout);
    };
  }, [authLoading, user, editingProfile]);
  // Define functions using useCallback to avoid hoisting issues
  const loadSettings = useCallback(async () => {
    try {
      if (!user || editingProfile || hasRemoteProfileLoaded) {
        if (user?.customImageURL) {
          setCustomProfilePicture(user.customImageURL);
        } else {
          setCustomProfilePicture(null);
        }
        return;
      }

      const scopedProfileKey = getUserProfileStorageKey(user.email);
      let cachedProfileRaw = await AsyncStorage.getItem(scopedProfileKey);
      let loadedFromLegacyKey = false;

      if (!cachedProfileRaw && scopedProfileKey !== LEGACY_USER_PROFILE_STORAGE_KEY) {
        const legacyProfileRaw = await AsyncStorage.getItem(LEGACY_USER_PROFILE_STORAGE_KEY);
        if (legacyProfileRaw) {
          cachedProfileRaw = legacyProfileRaw;
          loadedFromLegacyKey = true;
        }
      }

      if (cachedProfileRaw) {
        const parsed = JSON.parse(cachedProfileRaw);
        const parsedEmail = typeof parsed?.email === 'string' ? parsed.email.toLowerCase() : '';
        const currentEmail = (user.email || '').toLowerCase();

        if (parsedEmail && currentEmail && parsedEmail !== currentEmail) {
          logger.warn('Ignoring cached profile for a different account', {
            parsedEmail,
            currentEmail,
          });
        } else {
        const profileData: ProfileFormData = {
          displayName: resolveDisplayNamePreferringGoogle(
            parsed.displayName,
            user.displayName,
            user.email
          ),
          email: parsed.email || user.email || '',
          photoURL: parsed.photoURL || user.photoURL || '',
          phone: typeof parsed.phone === 'string' ? parsed.phone : '',
          school: typeof parsed.school === 'string' ? parsed.school : '',
          bio: typeof parsed.bio === 'string' ? parsed.bio : '',
          dateOfBirth: typeof parsed.dateOfBirth === 'string' ? parsed.dateOfBirth : '',
          salutation: (parsed.salutation as 'Mr.' | 'Ms.' | '') || '',
          subjects: Array.isArray(parsed.subjects)
            ? parsed.subjects
                .map((subject: unknown) => String(subject || '').trim())
                .filter(Boolean)
            : [],
        };
        setProfileData(profileData);
        setOriginalProfileData(profileData);

          if (loadedFromLegacyKey && scopedProfileKey !== LEGACY_USER_PROFILE_STORAGE_KEY) {
            await AsyncStorage.setItem(scopedProfileKey, JSON.stringify(profileData));
            await AsyncStorage.removeItem(LEGACY_USER_PROFILE_STORAGE_KEY);
          }
        }
      } else if (user) {
        // If no saved profile but user exists, initialize with user data
        const profileData: ProfileFormData = {
          displayName: resolveDisplayName(user.displayName, fallbackDisplayNameFromEmail(user.email)),
          email: user.email || '',
          photoURL: user.photoURL || '',
          phone: '',
          school: '',
          bio: '',
          dateOfBirth: '',
          salutation: '' as '' | 'Mr.' | 'Ms.',
          subjects: [] as string[],
        };
        setProfileData(profileData);
        setOriginalProfileData(profileData);
      }
      
      // Load custom profile picture from Firestore (user object) - simplified logic
      if (user?.customImageURL) {
        setCustomProfilePicture(user.customImageURL);
      } else {
        setCustomProfilePicture(null);
      }
    } catch (error) {
      logger.error('Error loading settings:', error);
    }
  }, [user, editingProfile, hasRemoteProfileLoaded]);

  const calculateCacheSize = useCallback(async () => {
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      let totalBytes = 0;
      let removableBytes = 0;
      const keyDetails: { key: string; bytes: number; protected: boolean }[] = [];

      for (const key of allKeys) {
        try {
          const value = await AsyncStorage.getItem(key);
          const bytes = value ? getByteSize(value) : 0;
          const protectedEntry = isProtectedKey(key);
          totalBytes += bytes;
          if (!protectedEntry) {
            removableBytes += bytes;
          }
          keyDetails.push({ key, bytes, protected: protectedEntry });
        } catch (error) {
          logger.warn(`Error reading key ${key}:`, error);
        }
      }

      const removableEntries = keyDetails.filter((entry) => !entry.protected);
      const topRemovableKeys = removableEntries
        .filter((entry) => entry.bytes > 0)
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 3)
        .map((entry) => ({ key: entry.key, bytes: entry.bytes }));

      setCacheSize(formatBytes(removableBytes));
      setCacheInsights({
        totalBytes,
        removableBytes,
        totalKeys: allKeys.length,
        removableKeys: removableEntries.length,
        protectedKeys: allKeys.length - removableEntries.length,
        topRemovableKeys,
      });

      const lastCleared = await AsyncStorage.getItem(STORAGE_KEYS.cacheLastClearedAt);
      setLastCacheClearAt(lastCleared);
    } catch (error) {
      logger.error('Error calculating cache size:', error);
      setCacheSize(formatBytes(0));
      setCacheInsights(EMPTY_CACHE_INSIGHTS);
    }
  }, [isProtectedKey]);

  const clearCacheInternal = useCallback(async (): Promise<CacheClearSummary> => {
    const freedBytesEstimate = cacheInsights.removableBytes;
    const allKeys = await AsyncStorage.getAllKeys();
    const keysToRemove = allKeys.filter((key) => !isProtectedKey(key));

    let mediaCleanupSummary = {
      mediaFilesDeleted: 0,
      previewFilesDeleted: 0,
      bytesFreed: 0,
    };

    if (keysToRemove.length > 0) {
      await AsyncStorage.multiRemove(keysToRemove);
      logger.debug(`Cleared ${keysToRemove.length} cache items:`, keysToRemove);
    }

    try {
      mediaCleanupSummary = await chatCacheService.clearAllMediaCaches();
    } catch (mediaError) {
      logger.warn('Failed to clear chat media cache', mediaError);
    }

    const clearedStorage = keysToRemove.length > 0;
    const totalMediaFiles = mediaCleanupSummary.mediaFilesDeleted + mediaCleanupSummary.previewFilesDeleted;
    const clearedMedia = totalMediaFiles > 0;

    if (clearedStorage || clearedMedia) {
      const nowIso = new Date().toISOString();
      await AsyncStorage.setItem(STORAGE_KEYS.cacheLastClearedAt, nowIso);
      setLastCacheClearAt(nowIso);
    }

    await calculateCacheSize();

    const storageBytesFreed = clearedStorage ? freedBytesEstimate : 0;
    const totalFreedBytes = storageBytesFreed + mediaCleanupSummary.bytesFreed;

    logger.info('Cache cleared summary', {
      storageItemsRemoved: keysToRemove.length,
      storageBytesFreed,
      mediaFilesDeleted: mediaCleanupSummary.mediaFilesDeleted,
      mediaPreviewFilesDeleted: mediaCleanupSummary.previewFilesDeleted,
      mediaBytesFreed: mediaCleanupSummary.bytesFreed,
      totalFreedBytes,
    });

    return {
      storageItemsRemoved: keysToRemove.length,
      storageBytesFreed,
      mediaFilesDeleted: mediaCleanupSummary.mediaFilesDeleted,
      mediaPreviewFilesDeleted: mediaCleanupSummary.previewFilesDeleted,
      mediaBytesFreed: mediaCleanupSummary.bytesFreed,
      totalMediaFiles,
      totalFreedBytes,
    };
  }, [cacheInsights.removableBytes, calculateCacheSize, isProtectedKey]);

  // TODO: Implement backup loading feature
  // const loadBackups = useCallback(async () => {
  //   try {
  //     setLoadingBackups(true);
  //     const backupList = await dataManagementService.listBackups();
  //     setBackups(backupList);
  //   } catch (error) {
  //     logger.error('Error loading backups:', error);
  //     Alert.alert('Error', 'Failed to load backups');
  //   } finally {
  //     setLoadingBackups(false);
  //   }
  // }, []);

  // Load settings profile cache until remote profile has been hydrated.
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]); // TODO: Add loadBackups when implemented

  useEffect(() => {
    void calculateCacheSize();
  }, [calculateCacheSize]);

  // Watch for changes in user's customImageURL from Firestore - simplified
  useEffect(() => {
    if (user?.customImageURL) {
      setCustomProfilePicture(user.customImageURL);
    } else {
      setCustomProfilePicture(null);
    }
  }, [user?.customImageURL]);

  const loadAuthorizedMembers = useCallback(async () => {
    if (!activeTenant?.id) {
      return;
    }
    setAuthorizedMembersLoading(true);
    setAuthorizedMembersError(null);
    try {
      const memberships = await tenantService.getActiveMembershipsForTenant(activeTenant.id);
      const roleOrder: Record<TenantMembershipRole, number> = {
        owner: 0,
        admin: 1,
        staff: 2,
        member: 3,
      };
      const sorted = [...memberships].sort((a, b) => {
        const rankDiff = roleOrder[a.role] - roleOrder[b.role];
        if (rankDiff !== 0) {
          return rankDiff;
        }
        return (a.email || '').localeCompare(b.email || '');
      });
      setAuthorizedMembers(sorted);
    } catch (error) {
      logger.warn('Settings: failed to load tenant members', error);
      setAuthorizedMembersError('Unable to load team members. Please try again.');
      setAuthorizedMembers([]);
    } finally {
      setAuthorizedMembersLoading(false);
    }
  }, [activeTenant?.id]);

  useEffect(() => {
    if (!activeTenant?.id || !canShowTeamMembersList) {
      return;
    }
    loadAuthorizedMembers();
  }, [activeTenant?.id, canShowTeamMembersList, loadAuthorizedMembers]);

  useEffect(() => {
    if (!showEmailModal || !activeTenant?.id) {
      return;
    }
    loadAuthorizedMembers();
  }, [showEmailModal, activeTenant?.id, loadAuthorizedMembers]);

  useEffect(() => {
    if (!showEmailModal || !activeTenant?.id || tenantUnavailable || !canShowTeamMembersList) {
      setPendingInvites([]);
      setPendingInvitesLoading(false);
      setPendingInvitesError(null);
      return () => undefined;
    }

    setPendingInvitesLoading(true);
    setPendingInvitesError(null);
    const roleOrder: Record<TenantMembershipRole, number> = {
      owner: 0,
      admin: 1,
      staff: 2,
      member: 3,
    };

    const unsubscribe = tenantService.listenToInvites(
      activeTenant.id,
      (invites) => {
        const filtered = invites
          .filter((invite) => invite.status === 'pending')
          .sort((a, b) => {
            const rankDiff = roleOrder[a.role] - roleOrder[b.role];
            if (rankDiff !== 0) {
              return rankDiff;
            }
            return (a.email || '').localeCompare(b.email || '');
          });
        setPendingInvites(filtered);
        setPendingInvitesLoading(false);
      },
      (error) => {
        logger.warn('Settings: pending invite listener failed', error);
        setPendingInvitesError('Unable to load pending invites.');
        setPendingInvites([]);
        setPendingInvitesLoading(false);
      },
    );

    return () => {
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        logger.warn('Settings: failed to cleanup invite listener', cleanupError);
      }
    };
  }, [showEmailModal, activeTenant?.id, tenantUnavailable, canShowTeamMembersList]);

  // Safe early return after all hooks and effects are registered
  if (showOfflineLoadingSettings) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={{ fontSize: 16, fontFamily: 'Inter-Regular', color: theme.textSecondary, marginTop: 16 }}>
          Loading settings…
        </Text>
        {!!offlineHintSettings && (
          <Text style={{ fontSize: 14, fontFamily: 'Inter-Regular', color: theme.textSecondary, marginTop: 8 }}>
            {offlineHintSettings}
          </Text>
        )}
      </View>
    );
  }

  // Show loading screen while authentication or settings are being processed
  if (authLoading || componentLoading || settingsLoading) {
    return (
      <View style={[styles.container, styles.loadingContainer, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingSubtext, { color: theme.textSecondary, marginTop: 16 }]}>Loading settings…</Text>
        <Text style={[styles.loadingSubtext, { color: theme.textSecondary }]}>Please wait while we load your settings</Text>
      </View>
    );
  }

  // Show error if user is not available after loading
  if (!user) {
    return (
      <View style={[styles.container, styles.loadingContainer, { backgroundColor: theme.surface }]}>
        <Text style={[styles.loadingText, { color: theme.text }]}>Please log in to access settings.</Text>
      </View>
    );
  }



  const saveProfile = async () => {
    try {
  setSavingProfile(true);
      const normalizedDisplayName = resolveDisplayNamePreferringGoogle(
        profileData.displayName,
        user?.displayName,
        user?.email
      );
      if (!normalizedDisplayName) {
        Alert.alert('Display name required', 'Please enter a display name before saving.');
        return;
      }

      const normalizedProfileData: ProfileFormData = {
        ...profileData,
        displayName: normalizedDisplayName,
        email: user?.email || profileData.email || '',
        phone: profileData.phone.trim(),
        school: profileData.school.trim(),
        bio: profileData.bio.trim(),
        subjects: Array.from(
          new Set((profileData.subjects || []).map((subject) => subject.trim()).filter(Boolean))
        ),
      };
      setProfileData((prev) => ({
        ...prev,
        ...normalizedProfileData,
      }));

      const googlePhotoURLRaw = user?.email ? await getOriginalGooglePhotoURL(user.email) : '';
      const fallbackGooglePhotoURL = isRemoteProfileImageUrl(googlePhotoURLRaw)
        ? googlePhotoURLRaw
        : (isRemoteProfileImageUrl(user?.photoURL) ? (user?.photoURL as string) : '');
      const previousProfilePictureUrl =
        originalProfilePictureURL ||
        (isRemoteProfileImageUrl(user?.photoURL) ? (user?.photoURL as string) : '') ||
        (isRemoteProfileImageUrl(profileData.photoURL) ? (profileData.photoURL as string) : '');
      let forceGoogleFallback = false;
      let clearCustomImageUrl = false;
      let showGoogleFallbackNotice = false;
      let uploadedPhotoUrlFromPending: string | undefined;
      let savedProfileData: ProfileFormData = {
        ...normalizedProfileData,
      };

      // If there's a pending local image preview and it's selected as current, upload it now
      if (pendingProfilePictureUri && user?.email) {
        const currentPhotoBeforeUpload = getCurrentProfilePictureURL();
        const shouldUploadPendingImage =
          currentPhotoBeforeUpload === pendingProfilePictureUri ||
          !isRemoteProfileImageUrl(currentPhotoBeforeUpload);

        if (shouldUploadPendingImage) {
          setUploadingProfilePicture(true);
          setUploadProgress(0);
          try {
            const uploaded = await uploadCustomProfilePicture(pendingProfilePictureUri);
            if (isRemoteProfileImageUrl(uploaded)) {
              uploadedPhotoUrlFromPending = uploaded;
            }
          } catch (uploadError) {
            // Any upload failure (including quota) must fall back to Google and clear custom URL.
            forceGoogleFallback = true;
            clearCustomImageUrl = true;
            setCurrentProfilePictureURL(fallbackGooglePhotoURL || previousProfilePictureUrl || '');
            setCustomProfilePicture(null);
            setPendingProfilePictureUri(null);
            setSelectedImageFileName(null);
            setSelectedImageFileSize(null);
            logger.warn('Profile upload failed; forcing Google profile photo fallback', uploadError);
            showGoogleFallbackNotice = true;
          }
          // Clear pending after successful upload
          if (!forceGoogleFallback) {
            setPendingProfilePictureUri(null);
            setSelectedImageFileName(null);
            setSelectedImageFileSize(null);
          }
          setUploadingProfilePicture(false);
        } else {
          // Pending exists but user selected Google; discard pending
          setPendingProfilePictureUri(null);
          setSelectedImageFileName(null);
          setSelectedImageFileSize(null);
        }
      }

      // Save profile data to AsyncStorage
      const profileStorageKey = getUserProfileStorageKey(user?.email || normalizedProfileData.email);
      await AsyncStorage.setItem(profileStorageKey, JSON.stringify(normalizedProfileData));
      if (profileStorageKey !== LEGACY_USER_PROFILE_STORAGE_KEY) {
        await AsyncStorage.removeItem(LEGACY_USER_PROFILE_STORAGE_KEY);
      }
      
      // Save custom profile picture to AsyncStorage (if exists)
      const effectiveCustomPhoto = uploadedPhotoUrlFromPending || customProfilePicture || '';
      if (!forceGoogleFallback && isRemoteProfileImageUrl(effectiveCustomPhoto)) {
        await AsyncStorage.setItem('customProfilePicture', effectiveCustomPhoto);
      } else if (forceGoogleFallback) {
        await AsyncStorage.removeItem('customProfilePicture');
      }
      
      // Update user profile in Firebase - photoURL is current active image
      if (user?.email) {
        const currentPhotoURL = getCurrentProfilePictureURL();
        const uploadedCustomPhotoURL = isRemoteProfileImageUrl(uploadedPhotoUrlFromPending)
          ? uploadedPhotoUrlFromPending
          : isRemoteProfileImageUrl(customProfilePicture)
          ? customProfilePicture
          : undefined;
        const currentPhotoIsRemote = isRemoteProfileImageUrl(currentPhotoURL);
        const photoURLToPersist =
          forceGoogleFallback
            ? fallbackGooglePhotoURL
            : uploadedCustomPhotoURL
            ? uploadedCustomPhotoURL
            : currentPhotoIsRemote
            ? currentPhotoURL
            : fallbackGooglePhotoURL;

        if (currentPhotoURL && !currentPhotoIsRemote && !uploadedCustomPhotoURL) {
          logger.warn('Skipping non-remote profile photo URL during saveProfile', {
            length: currentPhotoURL.length,
          });
          clearCustomImageUrl = true;
        }

        // Determine if the currently selected image is a custom image
        let customUrlToSave: string | undefined;
        if (!clearCustomImageUrl) {
          try {
            const googlePhotoURL = fallbackGooglePhotoURL;
            if (photoURLToPersist && photoURLToPersist !== googlePhotoURL) {
            // Selected is a custom image; store it in customImageURL
              customUrlToSave = photoURLToPersist;
            } else if (uploadedCustomPhotoURL && isRemoteProfileImageUrl(uploadedCustomPhotoURL)) {
            // Prefer URL returned by current upload attempt
              customUrlToSave = uploadedCustomPhotoURL;
            } else if (customProfilePicture && isRemoteProfileImageUrl(customProfilePicture)) {
            // Fallback: we have a known custom profile picture URL
              customUrlToSave = customProfilePicture;
            } else if (user?.customImageURL && isRemoteProfileImageUrl(user.customImageURL)) {
            // Preserve existing customImageURL if any
              customUrlToSave = user.customImageURL;
            }
          } catch {}
        }

        await authService.updateUserProfileSafe(user.email, {
          displayName: normalizedProfileData.displayName,
          ...(photoURLToPersist ? { photoURL: photoURLToPersist } : {}),
          ...(clearCustomImageUrl
            ? { customImageURL: null }
            : (customUrlToSave ? { customImageURL: customUrlToSave } : {})),
          school: normalizedProfileData.school,
          bio: normalizedProfileData.bio,
          phone: normalizedProfileData.phone,
          dateOfBirth: normalizedProfileData.dateOfBirth || undefined,
          salutation: normalizedProfileData.salutation || undefined,
          subjects: normalizedProfileData.subjects || undefined,
        });
        
        // Update profileData with the current photo URL for consistency
        if (photoURLToPersist) {
          setCurrentProfilePictureURL(photoURLToPersist);
          savedProfileData = {
            ...savedProfileData,
            photoURL: photoURLToPersist,
          };
        }

        if (clearCustomImageUrl) {
          setCustomProfilePicture(null);
        }
      }

      const latestPhotoURL = getCurrentProfilePictureURL();
      if (isRemoteProfileImageUrl(latestPhotoURL)) {
        savedProfileData = {
          ...savedProfileData,
          photoURL: latestPhotoURL,
        };
      }
      
  // Update original data to current data
      setProfileData(savedProfileData);
      setOriginalProfileData(savedProfileData);
      setHasRemoteProfileLoaded(true);
  // Reset the upload tracking flag since changes are saved
      setNewCustomPictureUploaded(false);
  setEditingProfile(false);
      if (showGoogleFallbackNotice) {
        Alert.alert(
          'Profile photo reverted',
          'Custom photo upload failed (including storage quota errors). We switched back to your Google profile photo.'
        );
      }
  // Removed success alert for silent save UX
    } catch (error) {
      logger.error('Error saving profile:', error);
      Alert.alert('Error', 'Failed to save profile');
    } finally {
      // Ensure we don't leave the UI in loading state
      setUploadingProfilePicture(false);
      setUploadProgress(0);
  setSavingProfile(false);
    }
  };

  const cancelEditProfile = async () => {
    // Reset to original data
    setProfileData({...originalProfileData});
    // Drop any pending local preview
    if (pendingProfilePictureUri) {
      setPendingProfilePictureUri(null);
  setSelectedImageFileName(null);
  setSelectedImageFileSize(null);
    }
    
    // Only reset profile picture if no new custom picture was uploaded during editing
    if (!newCustomPictureUploaded && originalProfilePictureURL) {
      setCurrentProfilePictureURL(originalProfilePictureURL);
      setProfileData(prev => ({ ...prev, photoURL: originalProfilePictureURL }));
      
      // Also revert in Firestore if the profile picture was changed during editing
      if (user?.email && currentProfilePictureURL !== originalProfilePictureURL) {
        try {
          await authService.updateUserProfileSafe(user.email, {
            photoURL: originalProfilePictureURL,
          });
        } catch (error) {
          logger.error('Failed to revert profile picture:', error);
        }
      }
    } else if (newCustomPictureUploaded) {
      // If a new custom picture was uploaded, keep the current state
      // Update profileData to reflect the current profile picture URL
      setProfileData(prev => ({ ...prev, photoURL: currentProfilePictureURL }));
    }
    
    // Reset custom profile picture to Firestore state (unless new one was uploaded)
    if (!newCustomPictureUploaded) {
      if (user?.customImageURL) {
        setCustomProfilePicture(user.customImageURL);
      } else {
        setCustomProfilePicture(null);
      }
    }
    
    // Reset the upload tracking flag
    setNewCustomPictureUploaded(false);
    setEditingProfile(false);
  };

  const startEditProfile = () => {
    // Store current data as original before editing
    setOriginalProfileData({...profileData});
    // Store original profile picture URL for cancel functionality
    setOriginalProfilePictureURL(currentProfilePictureURL || user?.photoURL || '');
    // Reset the upload tracking flag
    setNewCustomPictureUploaded(false);
  // Clear any pending preview left from previous session
  setPendingProfilePictureUri(null);
  setSelectedImageFileName(null);
  setSelectedImageFileSize(null);
    setEditingProfile(true);
  };

  const handleProfilePictureChange = async () => {
    if (uploadingProfilePicture) return;
    
    setShowImagePickerModal(true);
  };

  const selectFromCamera = async () => {
    try {
      const result = await MediaPickerUtil.captureProfileImage() as any;
      if (!result.canceled && result.assets && result.assets[0]) {
        // Defer upload until Save; show local preview immediately
        const asset = result.assets[0];
        const uri = asset.uri;
        setPendingProfilePictureUri(uri);
        setCurrentProfilePictureURL(uri);
        // Capture file metadata where possible
        try {
          const name = (asset.fileName as string | undefined) || (uri?.split('/')?.pop() ?? null);
          let size: number | null = null;
          if (typeof asset.fileSize === 'number') {
            size = asset.fileSize as number;
          } else if (uri) {
            const info = await FileSystem.getInfoAsync(uri);
            if (info && info.exists && typeof info.size === 'number') {
              size = info.size as number;
            }
          }
          setSelectedImageFileName(name || null);
          setSelectedImageFileSize(size);
        } catch (metaErr) {
          logger.warn('Could not get camera image metadata:', metaErr);
          setSelectedImageFileName((uri?.split('/')?.pop() ?? null));
          setSelectedImageFileSize(null);
        }
      }
    } catch (error) {
      logger.error('Error capturing image:', error);
      Alert.alert('Error', 'Failed to capture image');
    } finally {
      setShowImagePickerModal(false);
      setUploadingProfilePicture(false);
      setUploadProgress(0);
    }
  };

  const selectFromGallery = async () => {
    try {
      const result = await MediaPickerUtil.selectProfileImage() as any;
      if (!result.canceled && result.assets && result.assets[0]) {
        // Defer upload until Save; show local preview immediately
        const asset = result.assets[0];
        const uri = asset.uri;
        setPendingProfilePictureUri(uri);
        setCurrentProfilePictureURL(uri);
        // Capture file metadata where possible (web provides fileName/fileSize)
        try {
          const name = (asset.fileName as string | undefined) || (uri?.split('/')?.pop() ?? null);
          let size: number | null = null;
          if (typeof asset.fileSize === 'number') {
            size = asset.fileSize as number;
          } else if (uri) {
            const info = await FileSystem.getInfoAsync(uri);
            if (info && info.exists && typeof info.size === 'number') {
              size = info.size as number;
            }
          }
          setSelectedImageFileName(name || null);
          setSelectedImageFileSize(size);
        } catch (metaErr) {
          logger.warn('Could not get gallery image metadata:', metaErr);
          setSelectedImageFileName((uri?.split('/')?.pop() ?? null));
          setSelectedImageFileSize(null);
        }
      }
    } catch (error) {
      logger.error('Error selecting image:', error);
      Alert.alert('Error', 'Failed to select image');
    } finally {
      setShowImagePickerModal(false);
      setUploadingProfilePicture(false);
      setUploadProgress(0);
    }
  };

  const uploadCustomProfilePicture = async (uri: string): Promise<string> => {
    try {
      if (!user?.email) {
        throw new Error('User email missing for profile upload');
      }
      // Overwrite upload (legacy cleanup removed)
      const photoURL = await chatService.uploadProfilePicture(uri, user.email, (progress) => {
        setUploadProgress(progress);
      });
      
      // Save as custom profile picture in local state
      setCustomProfilePicture(photoURL);
      // Update current profile picture URL immediately for UI
      setCurrentProfilePictureURL(photoURL);
      // Mark that a new custom picture was uploaded during this editing session
      setNewCustomPictureUploaded(true);

      // Update local profileData for consistency
      setProfileData(prev => ({ ...prev, photoURL: photoURL }));

      return photoURL;

  // Previous image deletion removed intentionally (single overwrite path)
      
  // Removed success alert after custom profile picture upload for cleaner UX
    } catch (error) {
      logger.error('❌ ERROR: Profile picture upload failed:', error);
      throw error;
    }
  };

  const toggleProfilePictureSource = async (useCustom: boolean) => {
    try {
      const googlePhotoURL = user?.email ? await getOriginalGooglePhotoURL(user.email) : '';
      const newPhotoURL = useCustom && (pendingProfilePictureUri || customProfilePicture)
        ? (pendingProfilePictureUri || customProfilePicture)!
        : googlePhotoURL;

      // Always update local preview selection
      setCurrentProfilePictureURL(newPhotoURL);
      if (!editingProfile && user?.email) {
          // Also upsert customImageURL when switching to Custom so it's created if missing
          await authService.updateUserProfileSafe(user.email, {
            photoURL: newPhotoURL, // Update current active image
            ...(useCustom && customProfilePicture ? { customImageURL: customProfilePicture } : {}),
          });
      }
    } catch (error) {
      logger.error('❌ ERROR: Profile picture toggle failed:', error);
    }
  };

  // Helper function to get original Google photo URL from users collection
  const getOriginalGooglePhotoURL = async (email: string): Promise<string> => {
    try {
      // Get the original Google photo from users collection (static) using current user's UID
      if (auth.currentUser?.uid) {
        
        const userRef = doc(firestore, 'users', auth.currentUser.uid);
        const docSnap = await getDoc(userRef);
        
        if (docSnap.exists()) {
          const userData = docSnap.data();
          const googlePhotoURL = userData.photoURL;
          return googlePhotoURL || '';
        }
      }
      
      // Fallback to current user photoURL  
      return user?.photoURL || profileData.photoURL || '';
    } catch (error) {
      logger.error('❌ ERROR: Failed to get original Google photo:', error);
      // Fallback to current user photoURL
      return user?.photoURL || profileData.photoURL || '';
    }
  };

  // Get the current profile picture URL - show what's currently selected in UI first
  const getCurrentProfilePictureURL = () => {
    return currentProfilePictureURL || user?.photoURL || profileData.photoURL || '';
  };

  const isRemoteProfileImageUrl = (value: string | null | undefined): boolean => {
    if (!value) return false;
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith('https://') || normalized.startsWith('http://');
  };

  // Helper: format bytes to human-readable text
  const formatFileSize = (bytes: number | null): string => {
    if (bytes == null || isNaN(bytes as any)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
  };





  const handleSignOut = () => {
    setShowSignOutModal(true);
  };

  const performSignOut = async () => {
    setSigningOut(true);
    setShowSignOutModal(false);
    
    try {
      try {
        await clearCacheInternal();
      } catch (cacheError) {
        logger.warn('Sign out cache clear failed', cacheError);
      }

      await signOut();
      // The authService handles navigation and user feedback
    } catch (error) {
      logger.error('Settings: Sign out error:', error);
      // Even on error, the user is typically signed out locally
    } finally {
      setSigningOut(false);
    }
  };

  const handleExportDataClick = () => {
    setShowExportConfirmModal(true);
  };

  const handleExportData = async () => {
    try {
      if (!user?.email) {
        Alert.alert('Error', 'User not authenticated');
        return;
      }
      if (!activeTenant?.id) {
        Alert.alert('Select coaching center', 'Pick a coaching center before exporting data.');
        return;
      }

      Alert.alert('Exporting Data...', 'Please wait while we prepare your data for export.');

      // Export data using the data management service
      const exportData = await dataManagementService.exportAllData(activeTenant.id, user.email);
      
      // Convert to JSON string with pretty formatting
      const jsonString = JSON.stringify(exportData, null, 2);
      const fileName = dataManagementService.generateExportFilename();

      if (Platform.OS === 'web') {
        // For web platform
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        Alert.alert(
          'Export Successful!', 
          `Data exported successfully!\n\nFile: ${fileName}\nStudents: ${exportData.metadata.totalStudents}\nFee Records: ${exportData.metadata.totalFees}\nAttendance Records: ${exportData.metadata.totalAttendance}\nDevice Tracking: ${exportData.metadata.totalDevices}\nQuotes/Notifications: ${exportData.metadata.totalNotifications}\n\nYou can use this file to import data into another device or as a backup.`
        );
      } else {
        // For mobile platforms - use Share API
        await Share.share({
          message: jsonString,
          title: 'Export Tuition Data',
        });
        
        Alert.alert(
          'Export Successful!', 
          `Data prepared for sharing!\n\nStudents: ${exportData.metadata.totalStudents}\nFee Records: ${exportData.metadata.totalFees}\nAttendance Records: ${exportData.metadata.totalAttendance}\nDevice Tracking: ${exportData.metadata.totalDevices}\nQuotes/Notifications: ${exportData.metadata.totalNotifications}\n\nChoose an app to save or share your data.`
        );
      }

      // Cleanup old backups
      await dataManagementService.cleanupOldBackups(activeTenant.id);

    } catch (error) {
      logger.error('Export error:', error);
      const message = error instanceof Error ? error.message : 'Failed to export data. Please try again.';
      Alert.alert('Export Error', message);
    }
  };

  // TODO: Implement import data feature
  // const handleImportData = async () => {
  //   try {
  //     if (!user?.email) {
  //       Alert.alert('Error', 'User not authenticated');
  //       return;
  //     }

  //     if (Platform.OS === 'web') {
  //       // Create a file input element
  //       const input = document.createElement('input');
  //       input.type = 'file';
  //       input.accept = '.json';
  //       input.onchange = (event: any) => {
  //         const file = event.target.files[0];
  //         if (file) {
  //           const reader = new FileReader();
  //           reader.onload = (e: any) => {
  //             try {
  //               const importedData = JSON.parse(e.target.result);
  //               processImportedData(importedData);
  //             } catch (error) {
  //               Alert.alert('Error', 'Invalid JSON file format');
  //             }
  //           };
  //           reader.readAsText(file);
  //         }
  //       };
  //       input.click();
  //     } else {
  //       // For mobile platforms
  //       const result = await MediaPickerUtil.selectDocument('application/json') as any;

  //       if (!result.canceled && result.assets && result.assets[0]) {
  //         // For mobile, you would need to read the file content
  //         Alert.alert('Import', 'File selected. Processing import...');
          
  //         // Note: In a real implementation, you'd need to read the file content
  //         // This is a simplified version - you may need to use expo-document-picker
  //         // and expo-file-system to read the actual file content on mobile
  //         Alert.alert('Import', 'Mobile file reading implementation needed');
  //       }
  //     }
  //   } catch (error) {
  //     logger.error('Import error:', error);
  //     Alert.alert('Error', 'Failed to import data');
  //   }
  // };

  // TODO: Implement data import processing
  // const processImportedData = async (data: any) => {
  //   try {
  //     if (!user?.email) {
  //       Alert.alert('Error', 'User not authenticated');
  //       return;
  //     }

  //     // Show preview of data to be imported
  //     const preview = `Found:\n• ${data.students?.length || 0} students\n• ${data.fees?.length || 0} fee records\n• Settings and preferences\n• Dashboard data\n\nVersion: ${data.version || 'Unknown'}\nExported: ${data.exportDate ? new Date(data.exportDate).toLocaleDateString() : 'Unknown'}`;

  //     Alert.alert(
  //       'Import Data',
  //       preview + '\n\nDo you want to import this data? This will add to your existing data.',
  //       [
  //         { text: 'Cancel', style: 'cancel' },
  //         {
  //           text: 'Create Backup First',
  //           onPress: async () => {
  //             try {
  //               // Create backup before importing
  //               Alert.alert('Creating Backup...', 'Please wait while we backup your current data.');
  //               const backupKey = await dataManagementService.createBackup(user.email);
                
  //               Alert.alert(
  //                 'Backup Created',
  //                 'Your current data has been backed up. Now importing new data...',
  //                 [
  //                   { text: 'Cancel', style: 'cancel' },
  //                   { text: 'Import', onPress: () => performImport(data) }
  //                 ]
  //               );
  //             } catch (error) {
  //               Alert.alert('Backup Error', `Failed to create backup: ${error}`);
  //             }
  //           }
  //         },
  //         { text: 'Import Now', onPress: () => performImport(data) }
  //       ]
  //     );
  //   } catch (error) {
  //     logger.error('Error processing import data:', error);
  //     Alert.alert('Error', 'Failed to process import data');
  //   }
  // };

  // TODO: Implement data import execution
  // const performImport = async (data: any) => {
  //   try {
  //     if (!user?.email) {
  //       Alert.alert('Error', 'User not authenticated');
  //       return;
  //     }

  //     Alert.alert('Importing Data...', 'Please wait while we import your data. This may take a few moments.');

  //     // Import data using the data management service
  //     const result = await dataManagementService.importAllData(data, user.email);

  //     if (result.success) {
  //       // Update local state for immediate UI feedback
  //       if (data.settings) {
  //         if (data.settings.isDarkMode !== undefined) {
  //           setDarkMode(data.settings.isDarkMode);
  //         }
  //         setNotifications(data.settings.notifications !== false);
  //         setEmailReminders(data.settings.emailReminders !== false);
  //         setSmsReminders(data.settings.smsReminders !== false);
  //         setWhatsappReminders(data.settings.whatsappReminders !== false);
  //         setSpecialMessages(data.settings.specialMessages !== false);
  //       }

  //       if (data.profile) {
  //         setProfileData(data.profile);
  //       }

  //       if (data.teamMembers) {
  //         // Team members will be automatically updated through the subscription
  //       }

  //       let successMessage = result.message;
  //       if (result.errors.length > 0) {
  //         successMessage += `\n\nSome items had issues:\n${result.errors.slice(0, 3).join('\n')}`;
  //         if (result.errors.length > 3) {
  //           successMessage += `\n... and ${result.errors.length - 3} more.`;
  //         }
  //       }

  //       Alert.alert(
  //         'Import Successful!', 
  //         successMessage + '\n\nPlease restart the app to see all changes.',
  //         [
  //           { text: 'OK', onPress: () => {
  //             // Optionally refresh the page/app here
  //           }}
  //         ]
  //       );
  //     } else {
  //       Alert.alert(
  //         'Import Failed', 
  //         result.message + (result.errors.length > 0 ? `\n\nErrors:\n${result.errors.slice(0, 3).join('\n')}` : '')
  //       );
  //     }
  //   } catch (error) {
  //     logger.error('Error performing import:', error);
  //     Alert.alert('Import Error', `Failed to import data: ${error}`);
  //   }
  // };

  const handleClearCache = () => {
    calculateCacheSize();
    setShowClearCacheModal(true);
  };

  const performClearCache = async () => {
    try {
      setClearingCache(true);
      const summary = await clearCacheInternal();
      setShowClearCacheModal(false);

      if (summary.storageItemsRemoved === 0 && summary.totalMediaFiles === 0) {
        Alert.alert('Cache Already Optimized', 'Only essential items are stored right now, so there was nothing to clear.');
        return;
      }

      const storageSummary = summary.storageItemsRemoved
        ? `${summary.storageItemsRemoved} storage item${summary.storageItemsRemoved === 1 ? '' : 's'}`
        : null;
      const mediaSummary = summary.totalMediaFiles
        ? `${summary.totalMediaFiles} downloaded media file${summary.totalMediaFiles === 1 ? '' : 's'}`
        : null;
      const parts = [storageSummary, mediaSummary].filter(Boolean).join(' and ');
      const mediaDetailLine = summary.totalMediaFiles
        ? `\n\nMedia cleanup: Deleted ${summary.totalMediaFiles} file${summary.totalMediaFiles === 1 ? '' : 's'} (~${formatBytes(
            summary.mediaBytesFreed
          )}).`
        : '';

      Alert.alert(
        'Cache Cleared',
        `${parts || 'Cache data'} removed. Approx. ${formatBytes(summary.totalFreedBytes)} freed.${mediaDetailLine}`,
        [{ text: 'OK' }]
      );
    } catch (error) {
      logger.error('Error clearing cache:', error);
      Alert.alert('Error', 'Failed to clear cache. Please try again.');
      setShowClearCacheModal(false);
    } finally {
      setClearingCache(false);
    }
  };

  const handleContactSupport = () => {
    // Directly open the Help modal with FAQ
    setShowHelpModal(true);
  };

  // Modal: Request Account Deletion (set in Help & FAQ)
  const sendDeletionEmail = async () => {
    const supportEmail = contactInfo?.supportEmail || appSettings?.supportEmail || '';
    try {
      const subject = encodeURIComponent('Account deletion request');
      const body = encodeURIComponent(
        `Hello Support,\n\nI would like to request deletion of my account and associated personal data.\n\nAccount email: ${user?.email || ''}\nUser ID: ${user?.uid || ''}\nReason (optional): \n\nI understand this action may be irreversible and certain records may be retained if legally required.\n\nThank you.`
      );
      if (!supportEmail) {
        Alert.alert('Support unavailable', 'Support email is not configured yet. Please contact your administrator.');
        return;
      }
      const mailto = `mailto:${supportEmail}?subject=${subject}&body=${body}`;
      const canOpen = await Linking.canOpenURL(mailto);
      if (canOpen) {
        await Linking.openURL(mailto);
      } else {
        // Fallbacks
        if (contactInfo?.bugReportFormUrl) {
          await Linking.openURL(contactInfo.bugReportFormUrl);
        } else {
          await Linking.openURL(`mailto:${supportEmail}`);
        }
      }
    } catch (e) {
      logger.error('Open deletion email error:', e);
      Alert.alert('Could not open email', `Please email ${supportEmail} with your deletion request.`);
    } finally {
      setShowDeletionRequestModal(false);
      setShowHelpModal(false);
    }
  };

  // TODO: Implement backup management feature
  // const handleManageBackups = () => {
  //   setShowBackupModal(true);
  //   loadBackups();
  // };

  // TODO: Implement backup creation feature
  // const handleCreateBackup = async () => {
  //   try {
  //     if (!user?.email) {
  //       Alert.alert('Error', 'User not authenticated');
  //       return;
  //     }

  //     Alert.alert('Creating Backup...', 'Please wait while we backup your data.');
  //     const backupKey = await dataManagementService.createBackup(user.email);
      
  //     Alert.alert('Backup Created', 'Your data has been backed up successfully!');
  //     loadBackups(); // Refresh backup list
  //   } catch (error) {
  //     logger.error('Error creating backup:', error);
  //     Alert.alert('Backup Error', `Failed to create backup: ${error}`);
  //   }
  // };

  // TODO: Implement backup restore feature
  // const handleRestoreBackup = async (backupKey: string, backupDate: string) => {
  //   try {
  //     if (!user?.email) {
  //       Alert.alert('Error', 'User not authenticated');
  //       return;
  //     }

  //     Alert.alert(
  //       'Restore Backup',
  //       `Are you sure you want to restore from backup created on ${new Date(backupDate).toLocaleDateString()}?\n\nThis will replace your current data.`,
  //       [
  //         { text: 'Cancel', style: 'cancel' },
  //         {
  //           text: 'Restore',
  //           style: 'destructive',
  //           onPress: async () => {
  //             try {
  //               Alert.alert('Restoring...', 'Please wait while we restore your data.');
  //               const result = await dataManagementService.restoreFromBackup(backupKey, user.email);
                
  //               if (result.success) {
  //                 Alert.alert(
  //                   'Restore Successful!',
  //                   result.message + '\n\nPlease restart the app to see all changes.'
  //                 );
  //               } else {
  //                 Alert.alert('Restore Failed', result.message);
  //               }
  //             } catch (error) {
  //               Alert.alert('Restore Error', `Failed to restore backup: ${error}`);
  //             }
  //           }
  //         }
  //       ]
  //     );
  //   } catch (error) {
  //     logger.error('Error restoring backup:', error);
  //     Alert.alert('Restore Error', `Failed to restore backup: ${error}`);
  //   }
  // };

  // TODO: Implement backup delete feature
  // const handleDeleteBackup = async (backupKey: string, backupDate: string) => {
  //   Alert.alert(
  //     'Delete Backup',
  //     `Are you sure you want to delete the backup from ${new Date(backupDate).toLocaleDateString()}?`,
  //     [
  //       { text: 'Cancel', style: 'cancel' },
  //       {
  //         text: 'Delete',
  //         style: 'destructive',
  //         onPress: async () => {
  //           try {
  //             await AsyncStorage.removeItem(backupKey);
  //             loadBackups(); // Refresh backup list
  //           } catch (error) {
  //             Alert.alert('Error', 'Failed to delete backup');
  //           }
  //         }
  //       }
  //     ]
  //   );
  // };

  type SettingSection = {
    title: string;
    items: any[];
    extraContent?: React.ReactNode;
  };

  const teamMembersSubtitle = tenantUnavailable
    ? 'Select a coaching center to view'
    : authorizedMembersLoading
      ? 'Loading team members...'
      : authorizedMembersError
        ? 'Unable to load members'
        : `${authorizedMembers.length} team member${authorizedMembers.length !== 1 ? 's' : ''}`;

  const adminSettingsSubtitle = tenantUnavailable
    ? 'Select a coaching center to manage'
    : 'Manage app configuration and contact info';

  const canViewUsageAndQuotas = activeMembership?.role !== 'member';

  const settingSections: SettingSection[] = [
    {
      title: 'Account',
      items: [
        {
          icon: User,
          title: 'Profile Information',
          subtitle: resolvedDisplayName || 'Update your personal details',
          onPress: () => setShowProfileModal(true),
        },
        {
          icon: CreditCard,
          title: 'Plan & Billing',
          subtitle: tenantUnavailable ? 'Select a coaching center to view' : 'View your current plan and limits',
          onPress: tenantUnavailable ? undefined : () => router.push('/(tabs)/plan'),
          disabled: tenantUnavailable,
        },
        ...(canViewUsageAndQuotas
          ? [
              {
                icon: FileText,
                title: 'Usage & quotas',
                subtitle: tenantUnavailable
                  ? 'Select a coaching center to view'
                  : 'View workspace usage against plan limits',
                onPress: tenantUnavailable
                  ? undefined
                  : () =>
                      router.push({
                        pathname: '/(tabs)/usage',
                        params: { from: 'settings' },
                      }),
                disabled: tenantUnavailable,
              },
            ]
          : []),
        ...(canShowTeamMembersList && !tenantUnavailable
          ? [
              {
                icon: UserCheck,
                title: 'Team Members',
                subtitle: teamMembersSubtitle,
                onPress: tenantUnavailable ? undefined : () => setShowEmailModal(true),
                disabled: tenantUnavailable,
              },
            ]
          : []),
        ...(isAdmin
          ? [
              {
                icon: SettingsIcon,
                title: 'Admin Settings',
                subtitle: adminSettingsSubtitle,
                onPress: tenantUnavailable ? undefined : () => setShowAdminModal(true),
                disabled: tenantUnavailable,
              },
            ]
          : []),

        ...(Platform.OS === 'web' && !pwaInstalled
          ? [
              {
                icon: Download,
                title: 'Install app',
                subtitle: pwaInstallAvailable ? 'Install Tuition Manager on this device' : 'Install from your browser menu (⋮)',
                onPress: handleInstallWebApp,
              },
            ]
          : []),
      ],
      extraContent: <TenantMembershipManager />,
    },
    {
      title: 'Appearance',
      items: [
        {
          icon: themeMode === 'dark' ? Moon : themeMode === 'light' ? Sun : Monitor,
          title: 'Theme',
          subtitle: themeMode === 'system' ? 'Follow device setting' : themeMode === 'dark' ? 'Dark theme' : 'Light theme',
          onPress: () => setShowThemeModal(true),
        },
      ],
    },
    {
      title: 'Notifications',
      items: [
        {
          icon: Bell,
          title: 'Notification Settings',
          subtitle: 'Manage push, chat, and daily quote alerts',
          onPress: () => setShowNotificationSettings(true),
        },
      ],
    },
    {
      title: 'Data & Storage',
      items: [
        ...(!tenantUnavailable ? [
          {
            icon: FileText,
            title: 'Download Reports',
            subtitle: 'Generate student and fee Excel reports',
            onPress: () => openDownloadReports(),
          },
          {
            icon: Download,
            title: 'Export Data',
            subtitle: 'Download your data as JSON file',
            onPress: handleExportDataClick,
          },
        ] : []),
        // TODO: Implement Import Data feature
        // {
        //   icon: Upload,
        //   title: 'Import Data',
        //   subtitle: 'Import data from JSON file',
        //   onPress: handleImportData,
        // },
        // TODO: Implement Backup Management feature
        // {
        //   icon: Shield,
        //   title: 'Backup Management',
        //   subtitle: `Manage automatic backups (${backups.length} available)`,
        //   onPress: handleManageBackups,
        // },
        {
          icon: Trash2,
          title: 'Clear Cache',
          subtitle: `Free up storage space (${cacheSize})`,
          onPress: handleClearCache,
        },
      ],
    },
    {
      title: 'Support',
      items: [
        {
          icon: HelpCircle,
          title: 'Help & Support',
          subtitle: 'Get help or contact support',
          onPress: handleContactSupport,
        },
        
        {
          icon: FileText,
          title: 'Privacy Policy',
          subtitle: appSettings?.legal?.privacyPolicyUrl || (Platform.OS === 'web' ? '/privacy-policy.html' : 'Opens in browser'),
          onPress: () => {
            setPendingLegalType('privacy');
            setShowLegalConfirmModal(true);
          },
        },
        {
          icon: FileText,
          title: 'Terms of Service',
          subtitle: appSettings?.legal?.termsOfServiceUrl || (Platform.OS === 'web' ? '/terms-of-service.html' : 'Opens in browser'),
          onPress: () => {
            setPendingLegalType('terms');
            setShowLegalConfirmModal(true);
          },
        },
        {
          icon: LogOut,
          title: 'Sign Out',
          subtitle: signingOut ? 'Signing out...' : 'Log out of your account',
          onPress: signingOut ? undefined : handleSignOut,
          textColor: theme.error,
          disabled: signingOut,
        },
      ],
    },
  ];
  const renderSettingItem = (item: any, index: number, total: number) => (
    <TouchableOpacity
      key={index}
      style={[
        styles.settingItem,
        { backgroundColor: theme.surface, borderBottomColor: theme.border },
        index === 0 && styles.firstSettingItem,
        index === total - 1 && styles.lastSettingItem
      ]}
      onPress={item.onPress}
      disabled={!item.onPress || item.disabled}
    >
      <View style={styles.settingLeft}>
        <View style={[
          styles.settingIcon,
          { backgroundColor: item.textColor ? `${item.textColor}15` : `${theme.primary}15` }
        ]}>
          <item.icon 
            size={20} 
            color={item.textColor || theme.primary} 
          />
        </View>
        <View style={styles.settingContent}>
          <Text style={[
            styles.settingTitle,
            { color: item.textColor || theme.text }
          ]}>
            {item.title}
          </Text>
          <Text style={[styles.settingSubtitle, { color: theme.textSecondary }]}>
            {item.subtitle}
          </Text>
        </View>
      </View>
      <View style={styles.settingRight}>
        {item.rightComponent || (
          item.onPress && <ChevronRight size={20} color={theme.textSecondary} />
        )}
      </View>
    </TouchableOpacity>
  );
  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: theme.surface, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
        <Text allowFontScaling={false} style={[styles.title, { color: theme.text }]}>Settings</Text>
      </View>

      {/* Settings Content */}
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Profile Card */}
        <TouchableOpacity 
          style={[styles.profileCard, { backgroundColor: theme.surface }]}
          onPress={() => setShowProfileModal(true)}
        >
          <View
            style={[
              styles.profileAvatar,
              { backgroundColor: theme.primary },
              ...(roleBadge
                ? [
                    styles.adminProfileFrame,
                    {
                      borderColor: roleBadge.backgroundColor,
                      shadowColor: roleBadge.backgroundColor,
                    },
                  ]
                : [])
            ]}
          >
            {getCurrentProfilePictureURL() ? (
              <Image 
                source={{ uri: getCurrentProfilePictureURL() }} 
                style={[styles.profileImage, roleBadge && styles.adminProfileImage]}
              />
            ) : (
              <Text style={styles.profileInitial}>
                {resolvedDisplayInitial}
              </Text>
            )}
          </View>
          <View style={styles.profileInfo}>
            <View style={styles.profileNameContainer}>
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[styles.profileName, { color: theme.text }]}
              >
                {resolvedDisplayName || 'Teacher Name'}
              </Text>
              {roleBadge && (
                <View style={[styles.adminTextBadge, { backgroundColor: roleBadge.backgroundColor }]}>
                  <Text style={[styles.adminTextBadgeText, { color: roleBadge.textColor }]}>
                    {roleBadge.label}
                  </Text>
                </View>
              )}
            </View>
            <Text style={[styles.profileEmail, { color: theme.textSecondary }]}>
              {profileData.email || user?.email || 'teacher@example.com'}
            </Text>
            <View style={[styles.authBadge, { backgroundColor: `${theme.success}15` }]}>
              <Shield size={12} color={theme.success} />
              <Text style={[styles.authBadgeText, { color: theme.success }]}>
                {roleBadge?.accessLabel ?? 'Authorized Access'}
              </Text>
            </View>
          </View>
          <ChevronRight size={20} color={theme.textSecondary} />
        </TouchableOpacity>

        {/* Settings Sections */}
        {settingSections.map((section, sectionIndex) => (
          <View key={sectionIndex} style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>
              {section.title}
            </Text>
            <View style={[styles.sectionContent, { backgroundColor: theme.surface }]}>
              {section.items.map((item, itemIndex) => 
                renderSettingItem(item, itemIndex, section.items.length)
              )}
            </View>
            {section.extraContent && (
              <View style={styles.sectionExtraContent}>{section.extraContent}</View>
            )}
          </View>
        ))}

        {/* App Info */}
        <View style={styles.appInfo}>
          <Text style={[styles.appInfoText, { color: theme.textSecondary }]}>
            Tuition Manager {Platform.OS === 'web' ? '' : 'v'}{appInfo?.version || '1.0.0'}
          </Text>
          <Text style={[styles.appInfoText, { color: theme.textSecondary }]}>
            Made with ❤️ for amazing teachers
          </Text>
          <Text style={[styles.appInfoText, { color: theme.textSecondary }]}>
            Built with {appInfo?.frontend.framework || 'React Native'}
          </Text>
        </View>
      </ScrollView>

      {/* Notifications Modal */}
      <Modal
        visible={showNotificationSettings}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowNotificationSettings(false)}
      >
        <NotificationsPage onClose={() => setShowNotificationSettings(false)} />
      </Modal>

      {/* Profile Modal */}
      <Modal
        visible={showProfileModal}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <TouchableOpacity onPress={async () => {
              if (editingProfile) {
                await cancelEditProfile();
              } else {
                setShowProfileModal(false);
              }
            }}>
              {editingProfile ? (
                <X size={24} color={theme.textSecondary} />
              ) : (
                <X size={24} color={theme.textSecondary} />
              )}
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>
              {editingProfile ? 'Edit Profile' : 'Profile'}
            </Text>
              <TouchableOpacity
              disabled={editingProfile && ((uploadingProfilePicture || savingProfile) || !hasUnsavedChanges)}
              onPress={() => {
                if (editingProfile) {
                  if (!(uploadingProfilePicture || savingProfile) && hasUnsavedChanges) saveProfile();
                } else {
                  startEditProfile();
                }
              }}
            >
              {editingProfile ? (
                (uploadingProfilePicture || savingProfile) ? (
                  <ActivityIndicator size="small" color={theme.primary} />
                ) : (
                  <Save size={24} color={hasUnsavedChanges ? theme.primary : theme.textSecondary} />
                )
              ) : (
                <Pencil size={24} color={theme.primary} />
              )}
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 30 }),
            }}
          >
            <View style={styles.profileSection}>
              <View style={[
                styles.profileAvatarLarge, 
                { backgroundColor: theme.primary },
                ...(roleBadge
                  ? [
                      styles.adminProfileFrameLarge,
                      {
                        borderColor: roleBadge.backgroundColor,
                        shadowColor: roleBadge.backgroundColor,
                      },
                    ]
                  : [])
              ]}>
                {getCurrentProfilePictureURL() ? (
                  <Image 
                    source={{ uri: getCurrentProfilePictureURL() }} 
                    style={[styles.profileImageLarge, roleBadge && styles.adminProfileImageLarge]}
                  />
                ) : (
                  <Text style={styles.profileInitialLarge}>
                    {resolvedDisplayInitial}
                  </Text>
                )}
                {editingProfile && (
                  <TouchableOpacity 
                    style={[styles.cameraButton, { backgroundColor: theme.surface }]}
                    onPress={handleProfilePictureChange}
                    disabled={uploadingProfilePicture}
                  >
                    {uploadingProfilePicture ? (
                      <Text style={{ color: theme.primary, fontSize: 12 }}>...</Text>
                    ) : (
                      <Camera size={16} color={theme.primary} />
                    )}
                  </TouchableOpacity>
                )}
                {roleBadge && (
                  <View style={styles.adminBadgeContainerLarge}>
                    <View style={[styles.adminBadgeLarge, { backgroundColor: roleBadge.backgroundColor }]}>
                      <Text style={[styles.adminBadgeTextLarge, { color: roleBadge.textColor }]}>
                        {roleBadge.initial}
                      </Text>
                    </View>
                  </View>
                )}
              </View>

              {/* Profile Picture Source Toggle - Simplified */}
              {editingProfile && (
                <View style={[styles.profilePictureToggle, { marginTop: 16 }]}> 
                  <Text style={[styles.toggleLabel, { color: theme.text }]}>Profile Picture Source</Text>
                  <View style={styles.toggleOptions}>
                    {/* Google profile option (always available) */}
                    <TouchableOpacity
                      style={[
                        styles.toggleOption,
                        // If no custom picture yet, default Google as active
                        (customProfilePicture || pendingProfilePictureUri
                          ? (getCurrentProfilePictureURL() !== (pendingProfilePictureUri || customProfilePicture))
                          : true) && styles.activeToggleOption,
                        {
                          backgroundColor: (customProfilePicture || pendingProfilePictureUri
                            ? (getCurrentProfilePictureURL() !== (pendingProfilePictureUri || customProfilePicture))
                            : true)
                            ? theme.primary
                            : theme.surface,
                          borderColor: theme.border,
                        },
                      ]}
                      onPress={() => {
                        if (editingProfile) {
                          // In edit mode, use local preview for Google (original) without persisting
                          (async () => {
                            const googlePhotoURL = await getOriginalGooglePhotoURL(user?.email || '');
                            setCurrentProfilePictureURL(googlePhotoURL || '');
                          })();
                        } else {
                          toggleProfilePictureSource(false);
                        }
                      }}
                    >
                      <Text
                        style={[
                          styles.toggleOptionText,
                          {
                            color: (
                              (customProfilePicture || pendingProfilePictureUri
                                ? (getCurrentProfilePictureURL() !== (pendingProfilePictureUri || customProfilePicture))
                                : true)
                            )
                              ? 'white'
                              : theme.text,
                          },
                        ]}
                      >
                        Google Profile
                      </Text>
                    </TouchableOpacity>

                    {/* Custom picture option (disabled until a custom picture exists) */}
                    <TouchableOpacity
                      style={[
                        styles.toggleOption,
                        (customProfilePicture || pendingProfilePictureUri) && getCurrentProfilePictureURL() === (pendingProfilePictureUri || customProfilePicture) && styles.activeToggleOption,
                        {
                          backgroundColor:
                            (customProfilePicture || pendingProfilePictureUri) && getCurrentProfilePictureURL() === (pendingProfilePictureUri || customProfilePicture)
                              ? theme.primary
                              : theme.surface,
                          borderColor: theme.border,
                          opacity: (customProfilePicture || pendingProfilePictureUri) ? 1 : 0.6,
                        },
                      ]}
                      onPress={() => {
                        if (pendingProfilePictureUri || customProfilePicture) {
                          if (editingProfile && pendingProfilePictureUri) {
                            setCurrentProfilePictureURL(pendingProfilePictureUri);
                          } else if (!editingProfile) {
                            toggleProfilePictureSource(true);
                          } else if (customProfilePicture) {
                            setCurrentProfilePictureURL(customProfilePicture);
                          }
                        } else {
                          handleProfilePictureChange();
                        }
                      }}
                      disabled={!(customProfilePicture || pendingProfilePictureUri)}
                    >
                      <Text
                        style={[
                          styles.toggleOptionText,
                          { color: (customProfilePicture || pendingProfilePictureUri) && getCurrentProfilePictureURL() === (pendingProfilePictureUri || customProfilePicture) ? 'white' : theme.text },
                        ]}
                      >
                        Custom Picture
                      </Text>
                    </TouchableOpacity>
                  </View>
                  {uploadingProfilePicture && (
                    <View style={styles.uploadProgressContainer}>
                      <Text style={[styles.uploadingText, { color: theme.textSecondary }]}> 
                        Uploading profile picture... {Math.round(easedUploadProgress)}%
                      </Text>
                      <View style={[styles.progressBar, { backgroundColor: theme.border }]}>
                        <View
                          style={[
                            styles.progressFill,
                            {
                              backgroundColor: theme.primary,
                              width: `${easedUploadProgress}%`,
                            },
                          ]}
                        />
                      </View>
                    </View>
                  )}
                  {/* Selected file info (when custom image preview is active and pending) */}
                  {editingProfile && pendingProfilePictureUri && (
                    <View style={{ marginTop: 8 }}>
                      <Text style={[styles.fieldHint, { color: theme.textSecondary }]}>Selected image: {selectedImageFileName || 'Unknown'} ({formatFileSize(selectedImageFileSize)})</Text>
                    </View>
                  )}
                </View>
              )}
            </View>

            <View style={styles.formSection}>
              <View style={styles.formGroup}>
                <View style={styles.labelContainer}>
                  <Text style={[styles.labelText, { color: theme.text }]}>Display Name</Text>
                  {roleBadge && (
                    <View style={[styles.adminFormBadge, { backgroundColor: roleBadge.backgroundColor }]}>
                      <Text style={[styles.adminFormBadgeText, { color: roleBadge.textColor }]}>
                        {roleBadge.label}
                      </Text>
                    </View>
                  )}
                </View>
                {editingProfile ? (
                  <TextInput
                    style={[
                      styles.input,
                      { 
                        backgroundColor: theme.surface, 
                        borderColor: theme.border, 
                        color: theme.text 
                      }
                    ]}
                    placeholder="Enter your name"
                    placeholderTextColor={theme.textSecondary}
                    value={profileData.displayName}
                    maxLength={MAX_DISPLAY_NAME_LENGTH}
                    onChangeText={(text) => setProfileData((prev) => ({ ...prev, displayName: text }))}
                    editable={true}
                  />
                ) : (
                  <View style={[
                    styles.readOnlyField,
                    { 
                      backgroundColor: theme.background, 
                      borderColor: theme.border, 
                    }
                  ]}>
                    <Text style={[styles.readOnlyText, { color: theme.text }]}>
                      {resolvedDisplayName || 'Not set'}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.formGroup}>
                <Text style={[styles.labelText, { color: theme.text }]}>Email</Text>
                <View style={[
                  styles.readOnlyField,
                  { 
                    backgroundColor: theme.background, 
                    borderColor: theme.border, 
                  }
                ]}>
                  <Text style={[styles.readOnlyText, { color: theme.text }]}>
                    {profileData.email || user?.email || 'Not set'}
                  </Text>
                </View>
                {!editingProfile && (
                  <Text style={[styles.fieldHint, { color: theme.textSecondary }]}>
                    Email cannot be changed
                  </Text>
                )}
              </View>

              <View style={styles.formGroup}>
                <Text style={[styles.labelText, { color: theme.text }]}>Phone</Text>
                {editingProfile ? (
                  <TextInput
                    style={[
                      styles.input,
                      { 
                        backgroundColor: theme.surface, 
                        borderColor: theme.border, 
                        color: theme.text 
                      }
                    ]}
                    placeholder="Enter your phone number"
                    placeholderTextColor={theme.textSecondary}
                    value={profileData.phone}
                    onChangeText={(text) => setProfileData({...profileData, phone: text})}
                    editable={true}
                  />
                ) : (
                  <View style={[
                    styles.readOnlyField,
                    { 
                      backgroundColor: theme.background, 
                      borderColor: theme.border, 
                    }
                  ]}>
                    <Text style={[styles.readOnlyText, { color: theme.text }]}>
                      {profileData.phone || 'Not set'}
                    </Text>
                  </View>
                )}
              </View>

              {/* Date of Birth */}
              <View style={styles.formGroup}>
                <Text style={[styles.labelText, { color: theme.text }]}>Date of Birth</Text>
                {editingProfile ? (
                  <DatePicker 
                    selectedDate={profileData.dateOfBirth}
                    onSelect={(date) => setProfileData({ ...profileData, dateOfBirth: date })}
                    theme={theme}
                    placeholder="Select date"
                    allowFutureDates={false}
                  />
                ) : (
                  <View style={[
                    styles.readOnlyField,
                    { 
                      backgroundColor: theme.background, 
                      borderColor: theme.border, 
                    }
                  ]}>
                    <Text style={[styles.readOnlyText, { color: theme.text }]}>
                      {profileData.dateOfBirth ? new Date(profileData.dateOfBirth).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not set'}
                    </Text>
                  </View>
                )}
                {!editingProfile && (
                  <Text style={[styles.fieldHint, { color: theme.textSecondary }]}>Add your birthday to receive a special greeting.</Text>
                )}
              </View>

              {/* Salutation */}
              <View style={styles.formGroup}>
                <Text style={[styles.labelText, { color: theme.text }]}>Salutation</Text>
                {editingProfile ? (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {(['', 'Mr.', 'Ms.'] as ('' | 'Mr.' | 'Ms.')[]).map((opt) => (
                      <TouchableOpacity
                        key={opt || 'none'}
                        style={[
                          styles.toggleOption,
                          {
                            backgroundColor: profileData.salutation === opt ? theme.primary : theme.surface,
                            borderColor: theme.border,
                          },
                        ]}
                        onPress={() => setProfileData({ ...profileData, salutation: opt })}
                      >
                        <Text
                          style={{
                            color: profileData.salutation === opt ? 'white' : theme.text,
                            fontWeight: '600',
                          }}
                        >
                          {opt === '' ? 'None' : opt}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : (
                  <View
                    style={[
                      styles.readOnlyField,
                      { backgroundColor: theme.background, borderColor: theme.border },
                    ]}
                  >
                    <Text style={[styles.readOnlyText, { color: theme.text }]}>
                      {profileData.salutation || 'Not set'}
                    </Text>
                  </View>
                )}
              </View>

              {/* Subjects */}
              <View style={styles.formGroup}>
                <Text style={[styles.labelText, { color: theme.text }]}>Subjects</Text>
                {editingProfile ? (
                  <View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {profileData.subjects.map((subj, idx) => (
                        <View key={`${subj}-${idx}`} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16 }}>
                          <Text style={{ color: theme.text, marginRight: 6 }}>{subj}</Text>
                          <TouchableOpacity onPress={() => {
                            const next = profileData.subjects.filter((_, i) => i !== idx);
                            setProfileData({ ...profileData, subjects: next });
                          }}>
                            <X size={14} color={theme.textSecondary} />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                    <TextInput
                      style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.border, color: theme.text, marginTop: 8 }]}
                      placeholder="Type a subject and press Add"
                      placeholderTextColor={theme.textSecondary}
                      value={subjectInput}
                      onChangeText={setSubjectInput}
                      onSubmitEditing={() => tryAddSubject()}
                      returnKeyType="done"
                    />
                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 }}>
                      <TouchableOpacity
                        style={[styles.actionButton, { borderWidth: 1, borderColor: theme.border, backgroundColor: theme.surface }]}
                        onPress={() => tryAddSubject()}
                      >
                        <Text style={{ color: theme.text }}>Add</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={[styles.fieldHint, { color: theme.textSecondary }]}>Examples: Math, Science, English</Text>
                  </View>
                ) : (
                  <View
                    style={[
                      styles.readOnlyField,
                      { backgroundColor: theme.background, borderColor: theme.border },
                    ]}
                  >
                    <Text style={[styles.readOnlyText, { color: theme.text }]}>
                      {profileData.subjects?.length ? profileData.subjects.join(', ') : 'Not set'}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.formGroup}>
                <Text style={[styles.labelText, { color: theme.text }]}>School/Institution</Text>
                {editingProfile ? (
                  <TextInput
                    style={[
                      styles.input,
                      { 
                        backgroundColor: theme.surface, 
                        borderColor: theme.border, 
                        color: theme.text 
                      }
                    ]}
                    placeholder="Enter your school name"
                    placeholderTextColor={theme.textSecondary}
                    value={profileData.school}
                    onChangeText={(text) => setProfileData({...profileData, school: text})}
                    editable={true}
                  />
                ) : (
                  <View style={[
                    styles.readOnlyField,
                    { 
                      backgroundColor: theme.background, 
                      borderColor: theme.border, 
                    }
                  ]}>
                    <Text style={[styles.readOnlyText, { color: theme.text }]}>
                      {profileData.school || 'Not set'}
                    </Text>
                  </View>
                )}
              </View>

              <View style={styles.formGroup}>
                <Text style={[styles.labelText, { color: theme.text }]}>Bio</Text>
                {editingProfile ? (
                  <TextInput
                    style={[
                      styles.input,
                      styles.textArea,
                      { 
                        backgroundColor: theme.surface, 
                        borderColor: theme.border, 
                        color: theme.text 
                      }
                    ]}
                    placeholder="Tell us about yourself"
                    placeholderTextColor={theme.textSecondary}
                    value={profileData.bio}
                    onChangeText={(text) => setProfileData({...profileData, bio: text})}
                    multiline
                    numberOfLines={4}
                    editable={true}
                  />
                ) : (
                  <View style={[
                    styles.readOnlyField,
                    styles.readOnlyBio,
                    { 
                      backgroundColor: theme.background, 
                      borderColor: theme.border, 
                    }
                  ]}>
                    <Text style={[styles.readOnlyText, { color: theme.text }]}>
                      {profileData.bio || 'No bio added yet'}
                    </Text>
                  </View>
                )}
              </View>

              {/* Edit Mode Action Buttons */}
              {editingProfile && hasUnsavedChanges && (
                <Text style={[
                  styles.fieldHint,
                  { 
                    fontSize: 14, // Slightly bigger
                    color: theme.warning, // Pending/warning color
                    textAlign: 'center', 
                    marginTop: 8 
                  }
                ]}>You have unsaved changes.</Text>
              )}
              {editingProfile && (
                <View style={[styles.editActionButtons, { marginBottom: 60 }]}> 
                  <TouchableOpacity 
                    style={[styles.actionButton, styles.cancelButton, { borderColor: theme.border }]}
                    onPress={async () => await cancelEditProfile()}
                  >
                    <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity 
                    style={[
                      styles.actionButton,
                      styles.saveButton,
                      hasUnsavedChanges
                        ? { backgroundColor: theme.primary, opacity: (uploadingProfilePicture || savingProfile) ? 0.7 : 1 }
                        : { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, opacity: 0.6 },
                    ]}
                    onPress={saveProfile}
                    disabled={uploadingProfilePicture || savingProfile || !hasUnsavedChanges}
                    accessibilityState={{ disabled: (uploadingProfilePicture || savingProfile || !hasUnsavedChanges) }}
                  >
                    {(uploadingProfilePicture || savingProfile) ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <ActivityIndicator size="small" color="#ffffff" />
                        <Text style={styles.saveButtonText}>{uploadingProfilePicture ? 'Uploading…' : 'Saving…'}</Text>
                      </View>
                    ) : hasUnsavedChanges ? (
                      <Text style={styles.saveButtonText}>Save Changes</Text>
                    ) : (
                      <Text style={[styles.saveButtonText, { color: theme.textSecondary }]}>Save Changes</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Download Reports Modal */}
      <Modal
        visible={showDownloadReports}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeDownloadReports}
      >
        <View
          style={[styles.modalContainer, { backgroundColor: theme.background }]}
          accessibilityViewIsModal
        >
          <View
            style={[
              styles.modalHeader,
              { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding },
            ]}
          >
            <TouchableOpacity
              onPress={closeDownloadReports}
              accessibilityRole="button"
              accessibilityLabel="Close download reports"
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Download Reports</Text>
            <View style={{ width: 24 }} />
          </View>

          <View style={[styles.downloadReportsContent, { backgroundColor: theme.background }]}>
            <DownloadReportsPage />
          </View>
        </View>
      </Modal>

      {/* Legal Links Confirmation Modal (Privacy/Terms) */}
      <Modal
        visible={showLegalConfirmModal}
        animationType="fade"
        transparent={true}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.confirmationModal, { backgroundColor: theme.surface }]}> 
            <View style={styles.confirmationContent}>
              <FileText size={48} color={theme.primary} style={styles.confirmationIcon} />
              <Text style={[styles.confirmationTitle, { color: theme.text }]}>
                {pendingLegalType === 'privacy' ? 'Open Privacy Policy' : 'Open Terms of Service'}
              </Text>
              <Text style={[styles.confirmationMessage, { color: theme.textSecondary }]}> 
                We will open this link in your browser. Do you want to continue?
              </Text>
            </View>
            <View style={styles.confirmationButtons}>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => {
                  setShowLegalConfirmModal(false);
                  setPendingLegalType(null);
                }}
              >
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.saveButton, { backgroundColor: theme.primary }]}
                onPress={() => {
                  const type = pendingLegalType;
                  setShowLegalConfirmModal(false);
                  setPendingLegalType(null);
                  if (type) {
                    openPolicy(type);
                  }
                }}
              >
                <Text style={styles.saveButtonText}>Open Link</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Team Members Modal */}
      <Modal
        visible={showEmailModal && canShowTeamMembersList}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <TouchableOpacity onPress={() => setShowEmailModal(false)}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Team Members</Text>
            <View style={{ width: 24 }} />
          </View>

          <View style={styles.modalContent}>
            {tenantUnavailable ? (
              <TenantSelectionEmptyState
                title="Select a coaching center first"
                description="Choose, create, or join a coaching center from the Coaching centers panel in Settings before viewing team members."
                primaryActionLabel="Manage Coaching Centers"
                onPrimaryAction={() => setShowEmailModal(false)}
              />
            ) : (
              <>
                <Text style={[styles.modalDescription, { color: theme.textSecondary }] }>
                  These are all active team members in this coaching center. {isAdmin || !appSettings?.hideAuthorizedEmailsForNonAdmins ? 'All members can view this list for transparency.' : 'Only admins can view this list (as configured in Admin Settings).'}
                </Text>
                
                {/* Admin-only note */}
                <View style={[styles.infoBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.infoText, { color: theme.textSecondary }]}>
                    To add or remove team members, please use the Admin Settings page. Only administrators can manage membership.
                  </Text>
                </View>

                {/* Team Members List */}
                <View style={styles.emailsList}>
                  <View style={styles.emailsListHeader}>
                    <Text style={[styles.sectionLabel, { color: theme.text }]}>
                      Team Members ({authorizedMembersLoading ? '...' : authorizedMembers.length})
                    </Text>
                    {!authorizedMembersLoading && !tenantUnavailable && (
                      <TouchableOpacity onPress={loadAuthorizedMembers} style={styles.refreshButtonInline}>
                        <RefreshCw size={16} color={theme.primary} />
                        <Text style={[styles.refreshButtonInlineText, { color: theme.primary }]}>Refresh</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  <ScrollView style={styles.emailsScrollView}>
                    {authorizedMembersLoading ? (
                      <View style={[styles.loadingContainer, { padding: 20 }]}> 
                        <Text style={[styles.loadingText, { color: theme.textSecondary }]}> 
                          Loading authorized emails...
                        </Text>
                      </View>
                    ) : authorizedMembersError ? (
                      <View style={[styles.loadingContainer, { padding: 20 }]}> 
                        <Text style={[styles.loadingSubtext, { color: theme.error }]}> 
                          {authorizedMembersError}
                        </Text>
                      </View>
                    ) : authorizedMembers.length === 0 ? (
                      <View style={[styles.loadingContainer, { padding: 20 }]}> 
                        <Text style={[styles.loadingSubtext, { color: theme.textSecondary }]}> 
                          No authorized emails found
                        </Text>
                      </View>
                    ) : (
                      authorizedMembers.map((member) => {
                        const memberRoleBadge = ROLE_BADGE_MAP[member.role];
                        return (
                          <View key={member.id} style={[styles.emailItem, { backgroundColor: theme.surface }]}> 
                            <View style={styles.emailInfo}>
                              <Mail size={16} color={theme.primary} />
                              <View style={styles.emailTextContainer}>
                                <Text style={[styles.emailNameText, { color: theme.text }]}> 
                                  {member.displayName || member.email}
                                </Text>
                                <Text style={[styles.emailText, { color: theme.textSecondary }]}>{member.email}</Text>
                              </View>
                              {member.email === user?.email && (
                                <View style={[styles.currentUserBadge, { backgroundColor: theme.primary }]}> 
                                  <Text style={styles.currentUserText}>You</Text>
                                </View>
                              )}
                              {memberRoleBadge && (
                                <View
                                  style={[
                                    styles.currentUserBadge,
                                    {
                                      backgroundColor: memberRoleBadge.backgroundColor,
                                      marginLeft: member.email === user?.email ? 4 : 8,
                                    },
                                  ]}
                                >
                                  <Text style={[styles.currentUserText, { color: memberRoleBadge.textColor }]}>
                                    {memberRoleBadge.displayLabel}
                                  </Text>
                                </View>
                              )}
                            </View>
                          </View>
                        );
                      })
                    )}

                    {pendingInvitesLoading ? (
                      <View style={[styles.loadingContainer, { padding: 20 }]}> 
                        <Text style={[styles.loadingText, { color: theme.textSecondary }]}> 
                          Loading pending invites...
                        </Text>
                      </View>
                    ) : pendingInvitesError ? (
                      <View style={[styles.loadingContainer, { padding: 20 }]}> 
                        <Text style={[styles.loadingSubtext, { color: theme.error }]}> 
                          {pendingInvitesError}
                        </Text>
                      </View>
                    ) : pendingInvites.length > 0 ? (
                      <>
                        <Text style={[styles.sectionLabel, { color: theme.text, marginTop: 12 }]}> 
                          Pending Invites ({pendingInvites.length})
                        </Text>
                        {pendingInvites.map((invite) => {
                          const roleBadge = ROLE_BADGE_MAP[invite.role];
                          return (
                            <View key={invite.id} style={[styles.emailItem, { backgroundColor: theme.surface }]}> 
                              <View style={styles.emailInfo}>
                                <Mail size={16} color={theme.warning} />
                                <View style={styles.emailTextContainer}>
                                  <Text style={[styles.emailNameText, { color: theme.text }]}> 
                                    {invite.email}
                                  </Text>
                                  <Text style={[styles.emailText, { color: theme.textSecondary }]}>
                                    {invite.email}
                                  </Text>
                                </View>
                                <View style={[styles.currentUserBadge, { backgroundColor: theme.warning + '20' }]}> 
                                  <Text style={[styles.currentUserText, { color: theme.warning }]}>Pending</Text>
                                </View>
                                {roleBadge && (
                                  <View
                                    style={[
                                      styles.currentUserBadge,
                                      {
                                        backgroundColor: roleBadge.backgroundColor,
                                        marginLeft: 8,
                                      },
                                    ]}
                                  >
                                    <Text style={[styles.currentUserText, { color: roleBadge.textColor }]}>
                                      {roleBadge.displayLabel}
                                    </Text>
                                  </View>
                                )}
                              </View>
                            </View>
                          );
                        })}
                      </>
                    ) : null}
                  </ScrollView>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Help Modal */}
      <Modal
        visible={showHelpModal}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <TouchableOpacity onPress={() => setShowHelpModal(false)}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Help & FAQ</Text>
            <View style={{ width: 24 }} />
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 20 }),
            }}
          >
            {/* Quick Actions */}
            <View style={styles.quickActionsSection}>
              <Text style={[styles.sectionLabel, { color: theme.text }]}>Quick Help</Text>
              <View style={styles.quickActionsGrid}>
                <TouchableOpacity 
                  style={[styles.quickActionButton, { backgroundColor: theme.surface }]}
                  onPress={() => {
                    const email = contactInfo?.supportEmail || appSettings?.supportEmail || '';
                    if (!email) {
                      Alert.alert('Support unavailable', 'Support email is not configured yet. Please contact your administrator.');
                      return;
                    }
                    const subject = 'Support Request - Tuition Manager';
                    const body = `Hi Support Team,\n\nI need help with:\n\n[Please describe your issue here]\n\nApp Version: ${appInfo?.version || '1.0.0'}\nUser: ${user?.email}\nDevice: ${Platform.OS}\nTime: ${new Date().toISOString()}\n\nThank you!`;
                    
                    if (Platform.OS === 'web') {
                      window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
                    } else {
                      Linking.openURL(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
                    }
                  }}
                >
                  <Mail size={24} color={theme.primary} />
                  <Text style={[styles.quickActionText, { color: theme.text }]}>Email Support</Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                  style={[styles.quickActionButton, { backgroundColor: theme.surface }]}
                  onPress={() => {
                    const whatsappNumber = contactInfo?.whatsappNumber || appSettings?.supportPhone || '';
                    const message = 'Hi, I need help with Tuition Manager app';
                    if (!whatsappNumber) {
                      Alert.alert('Contact unavailable', 'Support WhatsApp number is not configured yet.');
                      return;
                    }
                    if (Platform.OS === 'web') {
                      window.open(`https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`);
                    } else {
                      Linking.openURL(`whatsapp://send?phone=${whatsappNumber}&text=${encodeURIComponent(message)}`);
                    }
                  }}
                >
                  <MessageSquare size={24} color={theme.primary} />
                  <Text style={[styles.quickActionText, { color: theme.text }]}>WhatsApp</Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                  style={[styles.quickActionButton, { backgroundColor: theme.surface }]}
                  onPress={() => {
                    const phoneNumber = contactInfo?.supportPhone || appSettings?.supportPhone || '';
                    if (!phoneNumber) {
                      Alert.alert('Contact unavailable', 'Support phone is not configured yet.');
                      return;
                    }
                    if (Platform.OS === 'web') {
                      window.open(`tel:${phoneNumber}`);
                    } else {
                      Linking.openURL(`tel:${phoneNumber}`);
                    }
                  }}
                >
                  <Phone size={24} color={theme.primary} />
                  <Text style={[styles.quickActionText, { color: theme.text }]}>Call Support</Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                  style={[styles.quickActionButton, { backgroundColor: theme.surface }]}
                  onPress={() => {
                    setShowAppInfoModal(true);
                  }}
                >
                  <FileText size={24} color={theme.primary} />
                  <Text style={[styles.quickActionText, { color: theme.text }]}>App Info</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* FAQ Section */}
            <View style={styles.faqMainSection}>
              <Text style={[styles.sectionLabel, { color: theme.text }]}>Frequently Asked Questions</Text>
              
              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  🎓 How do I add a new student?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  Go to the Students tab and tap the + button in the top right corner. Fill in the student details including name, class, subjects, and contact information, then save.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  💰 How do I manage student fees?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  In the Fees tab, you can add fee records, mark payments as received, and track pending amounts. Tap on a student to view their complete fee history.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  📱 How do I send fee reminders?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  In the Fees tab, find students with pending fees and tap {'"Send Reminder"'}. Choose your preferred method (Email, WhatsApp, or SMS). You can customize the message before sending.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  💬 How does the chat feature work?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  The Chat tab allows you to communicate with students and parents. You can send text messages, images, documents, and voice notes. All conversations are organized by student.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  📊 Can I export my data?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  Yes! Go to Settings → Data & Storage → Export Data to download all your application data as a comprehensive JSON file. This includes student information, fee records, attendance tracking, device data, system notifications, settings, and profile information. Private messages, reminders, and admin notifications are excluded for privacy.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  🔐 How do I authorize new users?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  In Settings → Authorized Emails, you can view all email addresses that are allowed to access the app. Visibility for non-admins can be disabled from Admin Settings. To add or remove emails from the authorized list, administrators should use the Admin Settings page.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  🌙 How do I change the app theme?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  Go to Settings → Appearance → Theme to choose between light, dark, or system themes. System theme automatically follows your device appearance setting.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  🔔 How do I manage notifications?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  In Settings → Notifications, you can control push notifications, email reminders, WhatsApp messages, and SMS alerts. Toggle each option as needed.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  🗑️ How do I clear app cache?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  Go to Settings → Data & Storage → Clear Cache. This will remove temporary files but keep your important data like students and fees.
                </Text>
              </View>

              <View style={styles.faqSection}>
                <Text style={[styles.faqQuestion, { color: theme.text }]}>
                  🔄 How do I backup and restore data?
                </Text>
                <Text style={[styles.faqAnswer, { color: theme.textSecondary }]}>
                  Use Export Data to create backups and Import Data to restore from a backup file. Regular backups are recommended to protect your data.
                </Text>
              </View>
            </View>

            {/* Support Contact Section */}
            <View style={styles.supportContactSection}>
              <Text style={[styles.sectionLabel, { color: theme.text }]}>Need More Help?</Text>
              <Text style={[styles.supportDescription, { color: theme.textSecondary }]}>
                Cannot find what you are looking for? Our support team is here to help you with any questions or issues.
              </Text>
              
              <View style={styles.supportOptionsContainer}>
                <TouchableOpacity 
                  style={[styles.supportOption, { backgroundColor: theme.surface }]}
                  onPress={() => {
                    setShowHelpModal(false);
                    const email = contactInfo?.supportEmail || appSettings?.supportEmail || '';
                    if (!email) {
                      Alert.alert('Support unavailable', 'Support email is not configured yet. Please contact your administrator.');
                      return;
                    }
                    const subject = 'Support Request - Tuition Manager';
                    const body = `Hi Support Team,\n\nI need help with:\n\n[Please describe your issue here]\n\nApp Version: ${appInfo?.version || '1.0.0'}\nUser: ${user?.email}\nDevice: ${Platform.OS}\nTime: ${new Date().toISOString()}\n\nThank you!`;
                    
                    if (Platform.OS === 'web') {
                      window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
                    } else {
                      Linking.openURL(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
                    }
                  }}
                >
                  <Mail size={20} color={theme.primary} />
                  <View style={styles.supportOptionContent}>
                    <Text style={[styles.supportOptionTitle, { color: theme.text }]}>Email Support</Text>
                    <Text style={[styles.supportOptionSubtitle, { color: theme.textSecondary }]}>
                      Get detailed help via email
                    </Text>
                  </View>
                  <ExternalLink size={16} color={theme.textSecondary} />
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.supportOption, { backgroundColor: theme.surface }]}
                  onPress={() => {
                    setShowBugReportModal(true);
                  }}
                >
                  <FileText size={20} color={theme.error} />
                  <View style={styles.supportOptionContent}>
                    <Text style={[styles.supportOptionTitle, { color: theme.text }]}>Report Bug</Text>
                    <Text style={[styles.supportOptionSubtitle, { color: theme.textSecondary }]}>
                      Report issues or bugs
                    </Text>
                  </View>
                  <ExternalLink size={16} color={theme.textSecondary} />
                </TouchableOpacity>

                {/* Request Account Deletion - moved here per policy */}
                <TouchableOpacity 
                  style={[styles.supportOption, { backgroundColor: theme.surface }]}
                  onPress={() => setShowDeletionRequestModal(true)}
                >
                  <Trash2 size={20} color={theme.error} />
                  <View style={styles.supportOptionContent}>
                    <Text style={[styles.supportOptionTitle, { color: theme.text }]}>Request Account Deletion</Text>
                    <Text style={[styles.supportOptionSubtitle, { color: theme.textSecondary }]}>Email support to delete your account</Text>
                  </View>
                  <ExternalLink size={16} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>
            </View>

            {/* App Information */}
            <View style={styles.appInfoSection}>
              <Text style={[styles.sectionLabel, { color: theme.text }]}>App Information</Text>
              <View style={[styles.infoCard, { backgroundColor: theme.surface }]}>
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Version:</Text>
                  <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo?.version || '1.0.0'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Build:</Text>
                  <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo?.build || '202412.1'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Platform:</Text>
                  <Text style={[styles.infoValue, { color: theme.text }]}>
                    {Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web'}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>User:</Text>
                  <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1}>
                    {user?.email || 'Not logged in'}
                  </Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Released:</Text>
                  <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo?.releaseDate || 'Unknown'}</Text>
                </View>
                <View style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Framework:</Text>
                  <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo?.frontend.framework || 'React Native'}</Text>
                </View>
              </View>
              
              {/* Support Information */}
              {supportInfo && (
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginTop: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>Support</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Business Hours:</Text>
                    <Text style={[styles.infoValue, { color: theme.text, fontSize: 12 }]}>{supportInfo.businessHours}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Response Time:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{supportInfo.responseTime}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Languages:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{supportInfo.languages.join(', ')}</Text>
                  </View>
                </View>
              )}
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* App Info Modal */}
      <Modal
        visible={showAppInfoModal}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <TouchableOpacity onPress={() => setShowAppInfoModal(false)}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>App Technical Information</Text>
            <View style={{ width: 24 }} />
          </View>

          {/* Last Updated Timestamp */}
          {updatedAt && (
            <View style={[styles.timestampContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
              <Text style={[styles.timestampText, { color: theme.textSecondary }]}>
                Last updated: {new Date(updatedAt).toLocaleDateString('en-US', { 
                  year: 'numeric', 
                  month: 'short', 
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </Text>
            </View>
          )}

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 15 }),
            }}
          >
            {appInfo ? (
              <View>
                {/* Header */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🚀 App Details</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Version:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.version}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Build:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.build}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Released:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.releaseDate || 'Unknown'}</Text>
                  </View>
                </View>

                {/* Frontend */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>📱 Frontend</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Framework:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.frontend.framework}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Language:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.frontend.language}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>UI:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.frontend.ui.join(', ')}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Navigation:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.frontend.navigation}</Text>
                  </View>
                </View>

                {/* Backend */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🛠️ Backend</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Database:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.backend.database.join(', ')}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Auth:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.backend.authentication}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Storage:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.backend.storage}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Hosting:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.backend.hosting}</Text>
                  </View>
                </View>

                {/* APIs & Services */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🔌 APIs & Services</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Messaging:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.apis.messaging.join(', ')}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Notifications:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.apis.notifications}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>File Upload:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.apis.fileUpload}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Maps:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.apis.maps}</Text>
                  </View>
                </View>

                {/* Development */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>💻 Development</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>IDE:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.development.ide}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Version Control:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.development.versionControl}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Package Manager:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.development.packageManager}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Build Tool:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.development.buildTool}</Text>
                  </View>
                </View>

                {/* Libraries */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>📚 Libraries</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>UI:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.libraries.ui.join(', ')}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Icons:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.libraries.icons}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Fonts:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.libraries.fonts.join(', ')}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Utilities:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.libraries.utilities.join(', ')}</Text>
                  </View>
                </View>

                {/* Features */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>✨ Features ({appInfo.features.length})</Text>
                  {appInfo.features.map((feature, index) => (
                    <View key={index} style={styles.infoRow}>
                      <Text style={[styles.infoValue, { color: theme.text }]}>• {feature}</Text>
                    </View>
                  ))}
                </View>

                {/* Security */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🔒 Security</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Auth:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.security.authentication.join(', ')}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Authorization:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.security.authorization}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Encryption:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.security.dataEncryption}</Text>
                  </View>
                </View>

                {/* Performance */}
                <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                  <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>⚡ Performance</Text>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Caching:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.performance.caching}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Monitoring:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.performance.monitoring}</Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Optimization:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.performance.optimization.join(', ')}</Text>
                  </View>
                </View>

                {appInfo.media && (
                  <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                    <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🎞️ Media</Text>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Capture:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.media.capture.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Playback:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.media.playback.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>File Types:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.media.fileTypes.join(', ')}</Text>
                    </View>
                  </View>
                )}

                {appInfo.deviceServices && (
                  <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                    <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🧩 Device Services</Text>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Sensors:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.deviceServices.sensors.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>System:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.deviceServices.system.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Intl:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.deviceServices.internationalization.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Network:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.deviceServices.network.join(', ')}</Text>
                    </View>
                  </View>
                )}

                {appInfo.dataAndStorage && (
                  <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 16 }]}>
                    <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🗄️ Data & Storage</Text>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Export/Import:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.dataAndStorage.exportImport.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Local:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.dataAndStorage.local.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Cloud:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.dataAndStorage.cloud.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Audit:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.dataAndStorage.audit.join(', ')}</Text>
                    </View>
                  </View>
                )}

                {appInfo.tooling && (
                  <View style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 32 }]}>
                    <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>🛠️ Tooling</Text>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Scripts:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.tooling.scripts.join(', ')}</Text>
                    </View>
                    <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Deployment:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.tooling.deployment.join(', ')}</Text>
                    </View>
                      <View style={styles.infoRow}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Quality:</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo.tooling.quality.join(', ')}</Text>
                    </View>
                  </View>
                )}
              </View>
            ) : (
              <View style={[styles.infoCard, { backgroundColor: theme.surface }]}>
                <Text style={[styles.infoValue, { color: theme.textSecondary }]}>Loading app information...</Text>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Bug Report Modal */}
      <Modal
        visible={showBugReportModal}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <TouchableOpacity onPress={() => setShowBugReportModal(false)}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Report Bug</Text>
            <View style={{ width: 24 }} />
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 45 }),
            }}
          >
            <Text style={[styles.modalDescription, { color: theme.textSecondary, marginBottom: 20 }]}>
              Help us improve the app by reporting bugs or issues you have encountered.
            </Text>

            {/* Bug Report Options */}
            <View style={styles.supportOptionsContainer}>
              {contactInfo?.bugReportFormUrl && contactInfo.bugReportFormUrl.includes('forms.google.com') ? (
                <TouchableOpacity 
                  style={[styles.supportOption, { backgroundColor: theme.surface, marginBottom: 16 }]}
                  onPress={() => {
                    setShowBugReportModal(false);
                    if (Platform.OS === 'web') {
                      window.open(contactInfo.bugReportFormUrl, '_blank');
                    } else {
                      Linking.openURL(contactInfo.bugReportFormUrl);
                    }
                  }}
                >
                  <FileText size={20} color={theme.primary} />
                  <View style={styles.supportOptionContent}>
                    <Text style={[styles.supportOptionTitle, { color: theme.text }]}>Online Bug Report Form</Text>
                    <Text style={[styles.supportOptionSubtitle, { color: theme.textSecondary }]}>
                      Fill out our detailed bug report form
                    </Text>
                  </View>
                  <ExternalLink size={16} color={theme.textSecondary} />
                </TouchableOpacity>
              ) : null}

              <TouchableOpacity 
                style={[styles.supportOption, { backgroundColor: theme.surface, marginBottom: 16 }]}
                onPress={() => {
                  setShowBugReportModal(false);
                  const email = contactInfo?.supportEmail || appSettings?.supportEmail || '';
                  if (!email) {
                    Alert.alert('Support unavailable', 'Support email is not configured yet. Please contact your administrator.');
                    return;
                  }
                  const subject = 'Bug Report - Tuition Manager';
                  const body = `Bug Report:

App Version: ${appInfo?.version || '1.0.0'}
User: ${user?.email}
Device: ${Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web'}
Time: ${new Date().toISOString()}

Bug Description:
[Please describe the bug here]

Steps to Reproduce:
1. 
2. 
3. 

Expected Behavior:
[What should have happened]

Actual Behavior:
[What actually happened]

Additional Notes:
[Any other relevant information]`;
                  
                  if (Platform.OS === 'web') {
                    window.open(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
                  } else {
                    Linking.openURL(`mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`);
                  }
                }}
              >
                <Mail size={20} color={theme.primary} />
                <View style={styles.supportOptionContent}>
                  <Text style={[styles.supportOptionTitle, { color: theme.text }]}>Email Bug Report</Text>
                  <Text style={[styles.supportOptionSubtitle, { color: theme.textSecondary }]}>
                    Send a detailed bug report via email
                  </Text>
                </View>
                <ExternalLink size={16} color={theme.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Bug Report Tips */}
            <View style={[styles.infoCard, { backgroundColor: theme.surface, marginTop: 20 }]}>
              <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>💡 Tips for Better Bug Reports</Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary, marginBottom: 8 }]}>
                • Be specific about what you were doing when the bug occurred
              </Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary, marginBottom: 8 }]}>
                • Include step-by-step instructions to reproduce the issue
              </Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary, marginBottom: 8 }]}>
                • Describe what you expected to happen vs. what actually happened
              </Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary, marginBottom: 8 }]}>
                • Include screenshots if possible (for visual issues)
              </Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary }]}>
                • Mention if the issue happens consistently or randomly
              </Text>
            </View>

            {/* Current Session Info */}
            <View style={[styles.infoCard, { backgroundColor: theme.surface, marginTop: 16 }]}>
              <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>📱 Current Session Info</Text>
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>App Version:</Text>
                <Text style={[styles.infoValue, { color: theme.text }]}>{appInfo?.version || '1.0.0'}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Platform:</Text>
                <Text style={[styles.infoValue, { color: theme.text }]}>
                  {Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : 'Web'}
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>User:</Text>
                <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1}>
                  {user?.email || 'Not logged in'}
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Time:</Text>
                <Text style={[styles.infoValue, { color: theme.text }]}>
                  {new Date().toLocaleString()}
                </Text>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Sign Out Confirmation Modal */}
      <Modal
        visible={showSignOutModal}
        animationType="fade"
        transparent={true}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.confirmationModal, { backgroundColor: theme.surface }]}>
            <View style={styles.confirmationContent}>
              <LogOut size={48} color={theme.error} style={styles.confirmationIcon} />
              <Text style={[styles.confirmationTitle, { color: theme.text }]}>Sign Out</Text>
              <Text style={[styles.confirmationMessage, { color: theme.textSecondary }]}>
                Are you sure you want to sign out of your account?
              </Text>
            </View>
            <View style={styles.confirmationButtons}>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => setShowSignOutModal(false)}
              >
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.destructiveButton, { backgroundColor: theme.error }]}
                onPress={performSignOut}
                disabled={signingOut}
              >
                <Text style={styles.destructiveButtonText}>
                  {signingOut ? 'Signing Out...' : 'Sign Out'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Clear Cache Confirmation Modal */}
      <Modal
        visible={showClearCacheModal}
        animationType="fade"
        transparent={true}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.confirmationModal, { backgroundColor: theme.surface }]}>
            <View style={styles.confirmationContent}>
              <Trash2 size={48} color={theme.error} style={styles.confirmationIcon} />
              <Text style={[styles.confirmationTitle, { color: theme.text }]}>Clear Cache</Text>
              <Text style={[styles.confirmationMessage, { color: theme.textSecondary }]}>
                This will clear all cached data. Your important data like students and fees will be preserved.
              </Text>
              <Text style={[styles.confirmationSubtext, { color: theme.textSecondary }]}>
                Current cache size: {cacheSize}
              </Text>
              <View style={[styles.cacheInsightsContainer, { borderColor: theme.border, backgroundColor: theme.background }]}>
                <Text style={[styles.cacheInsightLabel, { color: theme.textSecondary, marginBottom: 8 }]}>What happens</Text>
                <Text style={[styles.cacheInsightValue, { color: theme.text, marginBottom: 6 }]}>
                  We will remove about {formatBytes(cacheInsights.removableBytes)} of temporary files to free up space.
                </Text>
                <Text style={[styles.cacheInsightValue, { color: theme.text, marginBottom: 6 }]}>
                  Essential info (logins, students, fees) stays safe and downloaded chat media will be refreshed.
                </Text>
                <Text style={[styles.cacheInsightFootnote, { color: theme.textSecondary }]}>Last cleared: {formatTimestamp(lastCacheClearAt)}</Text>
              </View>
            </View>
            <View style={styles.confirmationButtons}>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => setShowClearCacheModal(false)}
                disabled={clearingCache}
              >
                <Text style={[styles.cancelButtonText, { color: theme.text, opacity: clearingCache ? 0.6 : 1 }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.destructiveButton, { backgroundColor: theme.error }]}
                onPress={performClearCache}
                disabled={clearingCache}
              >
                {clearingCache ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.destructiveButtonText}>Clear Cache</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Export Data Confirmation Modal */}
      <Modal
        visible={showExportConfirmModal}
        animationType="fade"
        transparent={true}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.confirmationModal, { backgroundColor: theme.surface }]}>
            <View style={styles.confirmationContent}>
              <Download size={48} color={theme.primary} style={styles.confirmationIcon} />
              <Text style={[styles.confirmationTitle, { color: theme.text }]}>Export Data</Text>
              <Text style={[styles.confirmationMessage, { color: theme.textSecondary }]}>
                This will export all your data including student information, fee records, attendance tracking, device data, and system notifications as a comprehensive JSON file.
              </Text>
              <Text style={[styles.confirmationSubtext, { color: theme.textSecondary }]}>
                Includes: Students, Fees, Attendance, Device Tracking, Quotes/Notifications, Settings & Profile. Excludes: Private messages, reminders, and admin notifications for privacy.
              </Text>
            </View>
            <View style={styles.confirmationButtons}>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => setShowExportConfirmModal(false)}
              >
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.saveButton, { backgroundColor: theme.primary }]}
                onPress={() => {
                  setShowExportConfirmModal(false);
                  handleExportData();
                }}
              >
                <Text style={styles.saveButtonText}>Export Data</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Account Deletion Request Confirmation Modal */}
      <Modal
        visible={showDeletionRequestModal}
        animationType="fade"
        transparent={true}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.confirmationModal, { backgroundColor: theme.surface }]}> 
            <View style={styles.confirmationContent}>
              <Trash2 size={48} color={theme.error} style={styles.confirmationIcon} />
              <Text style={[styles.confirmationTitle, { color: theme.text }]}>Request Account Deletion</Text>
              <Text style={[styles.confirmationMessage, { color: theme.textSecondary }]}> 
                We will open your email app to send a deletion request to our support team.
              </Text>
              <View style={[styles.infoCard, { backgroundColor: theme.surface, padding: 12 }]}> 
                <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Support Email</Text>
                {/* Override flex:1 from styles.infoValue for vertical stack to avoid tall gaps on Android */}
                <Text style={[styles.infoValue, { color: theme.text, flex: 0, textAlign: 'left' }]}>
                  {contactInfo?.supportEmail || appSettings?.supportEmail || 'Not configured'}
                </Text>
                <Text style={[styles.infoLabel, { color: theme.textSecondary, marginTop: 8 }]}>Your Account</Text>
                <Text style={[styles.infoValue, { color: theme.text, flex: 0, textAlign: 'left' }]}>
                  {user?.email || 'Not available'}
                </Text>
                <Text style={[styles.infoLabel, { color: theme.textSecondary, marginTop: 8 }]}>User ID</Text>
                <Text style={[styles.infoValue, { color: theme.text, flex: 0, textAlign: 'left' }]} numberOfLines={1}>
                  {user?.uid || 'Not available'}
                </Text>
              </View>
              <Text style={[styles.confirmationSubtext, { color: theme.textSecondary }]}> 
                Note: Deletion is irreversible. Some records may be retained to comply with legal or accounting requirements.
              </Text>
            </View>
            <View style={styles.confirmationButtons}>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => setShowDeletionRequestModal(false)}
              >
                <Text style={[styles.cancelButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmationButton, styles.destructiveButton, { backgroundColor: theme.error }]} 
                onPress={sendDeletionEmail}
              >
                <Text style={styles.destructiveButtonText}>Send Request</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* TODO: Implement Backup Management Modal 
      <Modal
        visible={showBackupModal}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <TouchableOpacity onPress={() => setShowBackupModal(false)}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Backup Management</Text>
            <TouchableOpacity onPress={handleCreateBackup}>
              <Plus size={24} color={theme.primary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 20 }),
            }}
          >
            <Text style={[styles.modalDescription, { color: theme.textSecondary }]}>
              Manage your data backups. Create backups before making major changes and restore from previous backups if needed.
            </Text>

            <TouchableOpacity 
              style={[styles.supportOption, { backgroundColor: theme.surface, marginBottom: 20 }]}
              onPress={handleCreateBackup}
            >
              <Shield size={20} color={theme.success} />
              <View style={styles.supportOptionContent}>
                <Text style={[styles.supportOptionTitle, { color: theme.text }]}>Create New Backup</Text>
                <Text style={[styles.supportOptionSubtitle, { color: theme.textSecondary }]}>
                  Backup all your current data
                </Text>
              </View>
              <Plus size={16} color={theme.textSecondary} />
            </TouchableOpacity>

            <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>Available Backups</Text>
            
            {loadingBackups ? (
              <View style={[styles.infoCard, { backgroundColor: theme.surface }]}>
                <Text style={[styles.infoValue, { color: theme.textSecondary }]}>Loading backups...</Text>
              </View>
            ) : backups.length > 0 ? (
              backups.map((backup, index) => (
                <View key={backup.key} style={[styles.infoCard, { backgroundColor: theme.surface, marginBottom: 12 }]}>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Date:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>
                      {new Date(backup.date).toLocaleDateString()} {new Date(backup.date).toLocaleTimeString()}
                    </Text>
                  </View>
                  <View style={styles.infoRow}>
                    <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>Size:</Text>
                    <Text style={[styles.infoValue, { color: theme.text }]}>
                      {(backup.size / 1024).toFixed(1)} KB
                    </Text>
                  </View>
                  
                  <View style={[styles.confirmationButtons, { marginTop: 12 }]}>
                    <TouchableOpacity
                      style={[styles.confirmationButton, styles.cancelButton, { backgroundColor: theme.surface, borderColor: theme.border }]}
                      onPress={() => handleRestoreBackup(backup.key, backup.date)}
                    >
                      <Text style={[styles.cancelButtonText, { color: theme.primary }]}>Restore</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.confirmationButton, styles.destructiveButton, { backgroundColor: theme.error }]}
                      onPress={() => handleDeleteBackup(backup.key, backup.date)}
                    >
                      <Text style={styles.destructiveButtonText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            ) : (
              <View style={[styles.infoCard, { backgroundColor: theme.surface }]}>
                <Text style={[styles.infoValue, { color: theme.textSecondary, textAlign: 'center', marginVertical: 20 }]}>
                  No backups available.{'\n'}Create your first backup to get started.
                </Text>
              </View>
            )}

            <View style={[styles.infoCard, { backgroundColor: theme.surface, marginTop: 20 }]}>
              <Text style={[styles.sectionLabel, { color: theme.text, marginBottom: 12 }]}>💡 About Backups</Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary, marginBottom: 8 }]}>
                • Backups include all students, fees, settings, and preferences
              </Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary, marginBottom: 8 }]}>
                • Automatic backups are created before imports
              </Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary, marginBottom: 8 }]}>
                • Only the latest 5 backups are kept automatically
              </Text>
              <Text style={[styles.infoValue, { color: theme.textSecondary }]}>
                • Backups are stored locally on your device
              </Text>
            </View>
          </ScrollView>
        </View>
      </Modal>
      */}

      {/* Theme Selection Modal */}
      <Modal
        visible={showThemeModal}
        animationType="slide"
        presentationStyle="pageSheet"
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          <View style={[styles.modalHeader, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <TouchableOpacity onPress={() => setShowThemeModal(false)}>
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Theme</Text>
            <View style={{ width: 24 }} />
          </View>

          <View style={styles.modalContent}>
            <Text style={[styles.modalDescription, { color: theme.textSecondary }]}>
              Choose your preferred theme. System will automatically switch between light and dark based on your device settings.
            </Text>
            
            <View style={styles.themeOptions}>
              <TouchableOpacity 
                style={[
                  styles.themeOption, 
                  { backgroundColor: theme.surface, borderColor: themeMode === 'light' ? theme.primary : theme.border }
                ]}
                onPress={() => setThemeMode('light')}
              >
                <View style={[styles.themeOptionIcon, { backgroundColor: `${theme.primary}15` }]}>
                  <Sun size={24} color={theme.primary} />
                </View>
                <View style={styles.themeOptionContent}>
                  <Text style={[styles.themeOptionTitle, { color: theme.text }]}>Light</Text>
                  <Text style={[styles.themeOptionDescription, { color: theme.textSecondary }]}>
                    Use light theme
                  </Text>
                </View>
                {themeMode === 'light' && (
                  <View style={[styles.selectedIndicator, { backgroundColor: theme.primary }]}>
                    <Text style={styles.checkmark}>✓</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity 
                style={[
                  styles.themeOption, 
                  { backgroundColor: theme.surface, borderColor: themeMode === 'dark' ? theme.primary : theme.border }
                ]}
                onPress={() => setThemeMode('dark')}
              >
                <View style={[styles.themeOptionIcon, { backgroundColor: `${theme.primary}15` }]}>
                  <Moon size={24} color={theme.primary} />
                </View>
                <View style={styles.themeOptionContent}>
                  <Text style={[styles.themeOptionTitle, { color: theme.text }]}>Dark</Text>
                  <Text style={[styles.themeOptionDescription, { color: theme.textSecondary }]}>
                    Use dark theme
                  </Text>
                </View>
                {themeMode === 'dark' && (
                  <View style={[styles.selectedIndicator, { backgroundColor: theme.primary }]}>
                    <Text style={styles.checkmark}>✓</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity 
                style={[
                  styles.themeOption, 
                  { backgroundColor: theme.surface, borderColor: themeMode === 'system' ? theme.primary : theme.border }
                ]}
                onPress={() => setThemeMode('system')}
              >
                <View style={[styles.themeOptionIcon, { backgroundColor: `${theme.primary}15` }]}>
                  <Monitor size={24} color={theme.primary} />
                </View>
                <View style={styles.themeOptionContent}>
                  <Text style={[styles.themeOptionTitle, { color: theme.text }]}>System</Text>
                  <Text style={[styles.themeOptionDescription, { color: theme.textSecondary }]}>
                    Follow device setting
                  </Text>
                </View>
                {themeMode === 'system' && (
                  <View style={[styles.selectedIndicator, { backgroundColor: theme.primary }]}>
                    <Text style={styles.checkmark}>✓</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            <View style={[styles.infoBox, { backgroundColor: theme.surface, borderColor: theme.border, marginTop: 20 }]}>
              <Text style={[styles.infoText, { color: theme.textSecondary }]}>
                <Text style={{ fontWeight: 'bold' }}>System:</Text> Automatically switches between light and dark based on your device appearance settings.
              </Text>
            </View>
          </View>
        </View>
      </Modal>

      {/* Admin Settings Modal */}
      {isAdmin && (
        <Modal
          visible={showAdminModal}
          animationType="slide"
          presentationStyle="fullScreen"
        >
          <AdminSettings onClose={() => setShowAdminModal(false)} />
        </Modal>
      )}


      {/* Image Picker Modal */}
      <Modal
        visible={showImagePickerModal}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowImagePickerModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.imagePickerModal, { backgroundColor: theme.surface }]}>
            <View style={styles.imagePickerContent}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Select Photo</Text>
              <Text style={[styles.modalSubtitle, { color: theme.textSecondary }]}>Choose a photo for your profile</Text>

              <View style={styles.modalButtons}>
                <TouchableOpacity 
                  style={[styles.modalButton, { backgroundColor: theme.primary + '10', borderColor: theme.primary }]}
                  onPress={selectFromCamera}
                >
                  <Camera size={24} color={theme.primary} />
                  <Text style={[styles.modalButtonText, { color: theme.primary }]}>Camera</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.modalButton, { backgroundColor: theme.primary + '10', borderColor: theme.primary }]}
                  onPress={selectFromGallery}
                >
                  <User size={24} color={theme.primary} />
                  <Text style={[styles.modalButtonText, { color: theme.primary }]}>Photo Library</Text>
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity 
              style={[styles.modalCancelButton, { 
                backgroundColor: theme.background,
                borderColor: theme.border,
              }]}
              onPress={() => setShowImagePickerModal(false)}
            >
              <Text style={[styles.modalCancelText, { color: theme.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Reusable Date Picker (same pattern as Students/Fees)
interface DatePickerProps {
  selectedDate: string;
  onSelect: (date: string) => void;
  theme: any;
  placeholder?: string;
  allowFutureDates?: boolean;
}

function DatePicker({ selectedDate, onSelect, theme, placeholder = 'Select date', allowFutureDates = true }: DatePickerProps) {
  const [showOptions, setShowOptions] = useState(false);
  const [currentMonth, setCurrentMonth] = useState<Date>(() => {
    if (selectedDate) {
      const parsed = new Date(selectedDate);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return new Date();
  });
  const [showMonthPicker, setShowMonthPicker] = useState(false);
  const [showYearPicker, setShowYearPicker] = useState(false);

  // Keep the calendar anchored to the provided selection when editing existing values.
  useEffect(() => {
    if (!selectedDate) {
      setCurrentMonth((prev) => {
        const today = new Date();
        if (prev.getFullYear() === today.getFullYear() && prev.getMonth() === today.getMonth()) {
          return prev;
        }
        return today;
      });
      return;
    }

    const parsed = new Date(selectedDate);
    if (isNaN(parsed.getTime())) return;
    setCurrentMonth((prev) => {
      if (prev.getFullYear() === parsed.getFullYear() && prev.getMonth() === parsed.getMonth()) {
        return prev;
      }
      return parsed;
    });
  }, [selectedDate]);

  const formatPretty = (dateString: string) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const generateCalendarDays = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDate = new Date(firstDay);
    const endDate = new Date(lastDay);
    startDate.setDate(startDate.getDate() - startDate.getDay());
    endDate.setDate(endDate.getDate() + (6 - endDate.getDay()));
    const days: Date[] = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      days.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }
    return days;
  };

  const generateYearRange = () => {
    const currentYear = new Date().getFullYear();
    const years: number[] = [];
    for (let year = currentYear; year >= 1900; year--) years.push(year);
    for (let year = currentYear + 1; year <= currentYear + 20; year++) years.push(year);
    return years;
  };

  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const isSelectedDate = (date: Date) => {
    if (!selectedDate) return false;
    const selected = new Date(selectedDate);
    return date.toDateString() === selected.toDateString();
  };

  const isCurrentMonth = (date: Date) => date.getMonth() === currentMonth.getMonth();

  const isFutureDate = (date: Date) => {
    const today = new Date();
    const dateWithoutTime = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const todayWithoutTime = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return dateWithoutTime > todayWithoutTime;
  };

  const handleDateSelect = (date: Date) => {
    if (!allowFutureDates && isFutureDate(date)) return;
    const dateString = formatDateToString(date);
    onSelect(dateString);
    setShowOptions(false);
  };

  const navigateMonth = (direction: 'prev' | 'next') => {
    const newMonth = new Date(currentMonth);
    if (direction === 'prev') newMonth.setMonth(newMonth.getMonth() - 1);
    else newMonth.setMonth(newMonth.getMonth() + 1);
    setCurrentMonth(newMonth);
  };

  const handleMonthSelect = (monthIndex: number) => {
    const newMonth = new Date(currentMonth);
    newMonth.setMonth(monthIndex);
    setCurrentMonth(newMonth);
    setShowMonthPicker(false);
  };

  const handleYearSelect = (year: number) => {
    const newMonth = new Date(currentMonth);
    newMonth.setFullYear(year);
    setCurrentMonth(newMonth);
    setShowYearPicker(false);
  };

  return (
    <View>
      <TouchableOpacity
        style={[datePickerStyles.datePickerButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
        onPress={() => {
          if (!showOptions) {
            const tentative = selectedDate ? new Date(selectedDate) : new Date();
            const baseDate = !isNaN(tentative.getTime()) ? tentative : new Date();
            setCurrentMonth((prev) => {
              if (prev.getFullYear() === baseDate.getFullYear() && prev.getMonth() === baseDate.getMonth()) {
                return prev;
              }
              return baseDate;
            });
            setShowMonthPicker(false);
            setShowYearPicker(false);
            setShowOptions(true);
          } else {
            setShowOptions(false);
          }
        }}
      >
        <Calendar size={16} color={theme.textSecondary} />
        <Text style={[datePickerStyles.datePickerText, { color: selectedDate ? theme.text : theme.textSecondary }]}>
          {selectedDate ? formatPretty(selectedDate) : placeholder}
        </Text>
      </TouchableOpacity>

      {showOptions && (
        <Modal
          visible={showOptions}
          transparent={true}
          animationType="fade"
          onRequestClose={() => setShowOptions(false)}
        >
          <Pressable
            style={datePickerStyles.modalOverlay}
            onPress={() => {
              setShowOptions(false);
              setShowMonthPicker(false);
              setShowYearPicker(false);
            }}
          >
            <Pressable
              style={[datePickerStyles.datePickerModal, { backgroundColor: theme.surface, borderColor: theme.border }]}
              onPress={() => {}}
            >
              {/* Header */}
              <View style={datePickerStyles.datePickerHeader}>
                <TouchableOpacity style={datePickerStyles.monthNavButton} onPress={() => navigateMonth('prev')}>
                  <Text style={[datePickerStyles.monthNavText, { color: theme.primary }]}>‹</Text>
                </TouchableOpacity>

                <View style={datePickerStyles.monthYearContainer}>
                  <TouchableOpacity
                    style={[datePickerStyles.monthYearButton, { borderColor: theme.border }]}
                    onPress={() => {
                      setShowMonthPicker(true);
                      setShowYearPicker(false);
                    }}
                  >
                    <Text style={[datePickerStyles.monthYearButtonText, { color: theme.text }]}>
                      {currentMonth.toLocaleDateString('en-US', { month: 'long' })}
                    </Text>
                    <Text style={[datePickerStyles.dropdownArrow, { color: theme.textSecondary }]}>▼</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[datePickerStyles.monthYearButton, { borderColor: theme.border }]}
                    onPress={() => {
                      setShowYearPicker(true);
                      setShowMonthPicker(false);
                    }}
                  >
                    <Text style={[datePickerStyles.monthYearButtonText, { color: theme.text }]}>
                      {currentMonth.getFullYear()}
                    </Text>
                    <Text style={[datePickerStyles.dropdownArrow, { color: theme.textSecondary }]}>▼</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity style={datePickerStyles.monthNavButton} onPress={() => navigateMonth('next')}>
                  <Text style={[datePickerStyles.monthNavText, { color: theme.primary }]}>›</Text>
                </TouchableOpacity>
              </View>

              {/* Month Picker */}
              {showMonthPicker && (
                <View style={[datePickerStyles.pickerDropdown, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <View style={[datePickerStyles.pickerHeader, { borderBottomColor: theme.border }]}>
                    <Text style={[datePickerStyles.pickerHeaderText, { color: theme.text }]}>Select Month</Text>
                    <TouchableOpacity
                      style={[datePickerStyles.pickerCloseButton, { backgroundColor: theme.primary + '15' }]}
                      onPress={() => setShowMonthPicker(false)}
                    >
                      <Text style={[datePickerStyles.pickerCloseText, { color: theme.primary }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={months}
                    keyExtractor={(item, index) => index.toString()}
                    style={[datePickerStyles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={datePickerStyles.pickerScrollContent}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={Platform.OS === 'android'}
                    keyboardShouldPersistTaps="handled"
                    bounces={Platform.OS === 'ios'}
                    overScrollMode={Platform.OS === 'android' ? 'always' : undefined}
                    renderItem={({ item: month, index }) => (
                      <TouchableOpacity
                        style={[
                          datePickerStyles.pickerItem,
                          { backgroundColor: currentMonth.getMonth() === index ? theme.primary + '20' : theme.surface },
                        ]}
                        onPress={() => handleMonthSelect(index)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            datePickerStyles.pickerItemText,
                            {
                              color: currentMonth.getMonth() === index ? theme.primary : theme.text,
                              fontWeight: currentMonth.getMonth() === index ? '600' : '400',
                            },
                          ]}
                        >
                          {month}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {/* Year Picker */}
              {showYearPicker && (
                <View style={[datePickerStyles.pickerDropdown, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <View style={[datePickerStyles.pickerHeader, { borderBottomColor: theme.border }]}>
                    <Text style={[datePickerStyles.pickerHeaderText, { color: theme.text }]}>Select Year</Text>
                    <TouchableOpacity
                      style={[datePickerStyles.pickerCloseButton, { backgroundColor: theme.primary + '15' }]}
                      onPress={() => setShowYearPicker(false)}
                    >
                      <Text style={[datePickerStyles.pickerCloseText, { color: theme.primary }]}>✕</Text>
                    </TouchableOpacity>
                  </View>
                  <FlatList
                    data={generateYearRange()}
                    keyExtractor={(item) => item.toString()}
                    style={[datePickerStyles.pickerScrollView, { backgroundColor: theme.background }]}
                    contentContainerStyle={datePickerStyles.pickerScrollContent}
                    showsVerticalScrollIndicator={true}
                    nestedScrollEnabled={Platform.OS === 'android'}
                    keyboardShouldPersistTaps="handled"
                    bounces={Platform.OS === 'ios'}
                    overScrollMode={Platform.OS === 'android' ? 'always' : undefined}
                    renderItem={({ item: year }) => (
                      <TouchableOpacity
                        style={[
                          datePickerStyles.pickerItem,
                          { backgroundColor: currentMonth.getFullYear() === year ? theme.primary + '20' : theme.surface },
                        ]}
                        onPress={() => handleYearSelect(year)}
                        activeOpacity={0.7}
                      >
                        <Text
                          style={[
                            datePickerStyles.pickerItemText,
                            {
                              color: currentMonth.getFullYear() === year ? theme.primary : theme.text,
                              fontWeight: currentMonth.getFullYear() === year ? '600' : '400',
                            },
                          ]}
                        >
                          {year}
                        </Text>
                      </TouchableOpacity>
                    )}
                  />
                </View>
              )}

              {!showMonthPicker && !showYearPicker && (
                <View>
                  <View style={datePickerStyles.daysOfWeekRow}>
                    {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
                      <Text key={index} style={[datePickerStyles.dayOfWeekText, { color: theme.textSecondary }]}>
                        {day}
                      </Text>
                    ))}
                  </View>
                  <View style={datePickerStyles.calendarGrid}>
                    {generateCalendarDays().map((date, index) => {
                      const disabled = !allowFutureDates && isFutureDate(date);
                      return (
                        <TouchableOpacity
                          key={index}
                          style={[
                            datePickerStyles.calendarDay,
                            { backgroundColor: isSelectedDate(date) ? theme.primary : 'transparent', opacity: isCurrentMonth(date) ? (disabled ? 0.3 : 1) : 0.3 },
                          ]}
                          onPress={() => handleDateSelect(date)}
                          disabled={disabled}
                        >
                          <Text
                            style={[
                              datePickerStyles.calendarDayText,
                              { color: isSelectedDate(date) ? '#fff' : disabled ? theme.textSecondary : theme.text, fontWeight: isSelectedDate(date) ? '600' : '400' },
                            ]}
                          >
                            {date.getDate()}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              )}
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

const datePickerStyles = StyleSheet.create({
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  datePickerText: {
    fontSize: 16,
    fontWeight: '500',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  datePickerModal: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 20,
    width: 320,
    maxWidth: '90%',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  datePickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  monthNavButton: { width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  monthNavText: { fontSize: 24, fontWeight: '600' },
  monthYearContainer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  monthYearButton: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderRadius: 6, gap: 4 },
  monthYearButtonText: { fontSize: 14, fontWeight: '600' },
  dropdownArrow: { fontSize: 10, marginLeft: 4 },
  daysOfWeekRow: { flexDirection: 'row', marginBottom: 8 },
  dayOfWeekText: { flex: 1, textAlign: 'center', fontSize: 12, fontWeight: '600', paddingVertical: 4 },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  calendarDay: { width: '14.28%', aspectRatio: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
  calendarDayText: { fontSize: 14 },
  pickerDropdown: {
    marginTop: 16,
    borderWidth: 1,
    borderRadius: 8,
    height: 280,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  pickerScrollView: { flex: 1, height: 220 },
  pickerScrollContent: { paddingVertical: 8 },
  pickerItem: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 0.5, borderBottomColor: 'rgba(0,0,0,0.1)' },
  pickerItemText: { fontSize: 14, fontWeight: '500', textAlign: 'center' },
  pickerHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  pickerHeaderText: { fontSize: 16, fontWeight: '600' },
  pickerCloseButton: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  pickerCloseText: { fontSize: 12, fontWeight: '700' },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontFamily: 'Poppins-Bold',
  },
  content: {
    flex: 1,
  },
  profileCard: {
    marginHorizontal: 20,
    marginTop: 20,
    padding: 20,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  profileAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
    overflow: 'hidden',
  },
  profileImage: {
    width: '100%',
    height: '100%',
    borderRadius: 32,
  },
  profileInitial: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
    color: '#ffffff',
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 4,
    flexShrink: 1,
  },
  profileEmail: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginBottom: 8,
  },
  authBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    alignSelf: 'flex-start',
  },
  authBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 4,
  },
  section: {
    marginTop: 32,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginHorizontal: 20,
    marginBottom: 12,
  },
  sectionContent: {
    marginHorizontal: 20,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  sectionExtraContent: {
    marginHorizontal: 20,
    marginTop: 16,
  },
  settingItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
  },
  firstSettingItem: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
  },
  lastSettingItem: {
    borderBottomWidth: 0,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  settingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  settingIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  settingContent: {
    flex: 1,
  },
  settingTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 2,
  },
  settingSubtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  settingRight: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  appInfo: {
    alignItems: 'center',
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  appInfoText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginBottom: 4,
  },
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  timestampContainer: {
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  timestampText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    fontStyle: 'italic',
  },
  modalContent: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 20,
  },
  downloadReportsContent: {
    flex: 1,
  },
  modalDescription: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginBottom: 24,
    lineHeight: 20,
  },
  profileSection: {
    alignItems: 'center',
    marginBottom: 32,
  },
  profileAvatarLarge: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  profileImageLarge: {
    width: '100%',
    height: '100%',
    borderRadius: 60,
  },
  profileInitialLarge: {
    fontSize: 48,
    fontFamily: 'Poppins-Bold',
    color: '#ffffff',
  },
  cameraButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  formSection: {
    flex: 1,
  },
  formGroup: {
    marginBottom: 20,
  },
  labelText: {
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
  textArea: {
    height: 100,
    textAlignVertical: 'top',
  },
  addEmailSection: {
    marginBottom: 32,
  },
  sectionLabel: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 12,
  },
  addEmailContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  emailInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  addButton: {
    width: 48,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emailsList: {
    flex: 1,
  },
  emailsListHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  emailsScrollView: {
    flex: 1,
  },
  emailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
  },
  emailInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  emailTextContainer: {
    marginLeft: 8,
    flex: 1,
  },
  emailNameText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  emailText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    flex: 1,
  },
  currentUserBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 8,
  },
  currentUserText: {
    fontSize: 10,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  refreshButtonInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  refreshButtonInlineText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  removeButton: {
    padding: 8,
  },
  faqSection: {
    marginBottom: 24,
  },
  faqQuestion: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  faqAnswer: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 20,
  },
  contactButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 12,
    marginTop: 20,
    marginBottom: 40,
  },
  contactButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
    marginLeft: 8,
  },
  infoBox: {
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginVertical: 12,
  },
  infoText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  loadingSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginTop: 8,
  },
  // Help & Support Modal Styles
  quickActionsSection: {
    marginBottom: 32,
  },
  quickActionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'stretch',
    marginTop: 0,
    marginBottom: 0,
    gap: 0,
  },
  quickActionButton: {
    width: '48%',
    minWidth: 160,
    maxWidth: '48%',
    height: 90,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
    borderRadius: 16,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    padding: 0,
  },
  quickActionText: {
    marginTop: 8,
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  faqMainSection: {
    marginBottom: 32,
  },
  supportContactSection: {
    marginBottom: 32,
  },
  supportDescription: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 20,
    marginBottom: 20,
  },
  supportOptionsContainer: {
    gap: 12,
  },
  supportOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  supportOptionContent: {
    flex: 1,
    marginLeft: 12,
  },
  supportOptionTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 2,
  },
  supportOptionSubtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  appInfoSection: {
    marginBottom: 32,
  },
  infoCard: {
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  infoLabel: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  infoValue: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    flex: 1,
    textAlign: 'right',
  },
  // Confirmation Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  confirmationModal: {
    borderRadius: 16,
    padding: 24,
    maxWidth: 400,
    width: '100%',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 8,
    },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 8,
  },
  confirmationContent: {
    alignItems: 'center',
    marginBottom: 24,
  },
  confirmationIcon: {
    marginBottom: 16,
  },
  confirmationTitle: {
    fontSize: 20,
    fontFamily: 'Inter-Bold',
    marginBottom: 8,
    textAlign: 'center',
  },
  confirmationMessage: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 22,
  },
  confirmationSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginTop: 8,
    fontStyle: 'italic',
  },
  cacheInsightsContainer: {
    width: '100%',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 16,
  },
  cacheInsightRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cacheInsightLabel: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  cacheInsightValue: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },
  cacheLargestWrapper: {
    marginTop: 8,
  },
  cacheLargestItem: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  cacheInsightFootnote: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 10,
    textAlign: 'center',
  },
  confirmationButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  confirmationButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  cancelButton: {
    borderWidth: 1,
  },
  cancelButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  destructiveButton: {
    // backgroundColor is set inline
  },
  destructiveButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    color: '#ffffff',
  },
  
  // Admin-related styles
  adminProfileFrame: {
    borderWidth: 3,
    borderColor: '#FFD700',
    shadowColor: '#FFD700',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  adminProfileImage: {
    borderRadius: 29, // Slightly smaller to account for the golden border
  },
  adminBadgeContainer: {
    position: 'absolute',
    top: -8,
    right: -8,
    zIndex: 10,
  },
  adminBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#ffffff',
    shadowColor: '#000000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 3,
  },
  adminBadgeText: {
    fontSize: 12,
    color: '#000000',
    fontWeight: 'bold',
  },
  profileNameContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
    minWidth: 0,
  },
  adminTextBadge: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adminTextBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter-Bold',
    color: '#000000',
    fontWeight: 'bold',
  },
  
  // Large profile admin styles for modal
  adminProfileFrameLarge: {
    borderWidth: 4,
    borderColor: '#FFD700',
    shadowColor: '#FFD700',
    shadowOffset: {
      width: 0,
      height: 3,
    },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 8,
  },
  adminProfileImageLarge: {
    borderRadius: 46, // Slightly smaller to account for the golden border
  },
  adminBadgeContainerLarge: {
    position: 'absolute',
    top: -12,
    right: -12,
    zIndex: 10,
  },
  adminBadgeLarge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#ffffff',
    shadowColor: '#000000',
    shadowOffset: {
      width: 0,
      height: 3,
    },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  adminBadgeTextLarge: {
    fontSize: 16,
    color: '#000000',
    fontWeight: 'bold',
  },
  
  // Form label admin badge styles
  labelContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  adminFormBadge: {
    marginLeft: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adminFormBadgeText: {
    fontSize: 8,
    fontFamily: 'Inter-Bold',
    color: '#000000',
    fontWeight: 'bold',
  },
  // Read-only field styles
  readOnlyField: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: 'center',
  },
  readOnlyBio: {
    minHeight: 80,
    alignItems: 'flex-start',
    paddingVertical: 16,
  },
  readOnlyText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    lineHeight: 20,
  },
  fieldHint: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
    fontStyle: 'italic',
  },
  // Action button styles for profile editing
  editActionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 20,
    paddingHorizontal: 20,
  },
  actionButton: {
    flex: 0.4,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveButton: {
    // backgroundColor will be set dynamically
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: 'white',
  },
  // Profile picture toggle styles
  profilePictureToggle: {
    alignItems: 'center',
  },
  toggleLabel: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 12,
  },
  toggleOptions: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  toggleOption: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  activeToggleOption: {
    // Active state styling handled by backgroundColor
  },
  toggleOptionText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  uploadingText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    fontStyle: 'italic',
    marginBottom: 8,
  },
  uploadProgressContainer: {
    alignItems: 'center',
    marginTop: 8,
  },
  progressBar: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    marginTop: 4,
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
  },
  imagePickerModal: {
    backgroundColor: 'white',
    margin: 20,
  borderRadius: 20,
  paddingTop: 0,
  paddingHorizontal: 0,
  paddingBottom: 0,
  alignItems: 'stretch',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  modalSubtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginBottom: 20,
    marginTop: 8,
  },
  imagePickerContent: {
    width: '100%',
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 0,
    alignItems: 'center',
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    gap: 8,
  },
  modalButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    textAlign: 'center',
  },
  modalCancelButton: {
  alignSelf: 'stretch',
  marginHorizontal: 12, // Leave ~8px inset on each side (20 padding - 12 = 8)
  paddingVertical: 12, // Increased for better mobile touch target
  marginVertical: 12,
  paddingHorizontal: 0, // Edge-to-edge inside modal width
    borderRadius: 12,
    alignItems: 'center',
  borderTopWidth: 1,
  borderLeftWidth: 1,
  borderRightWidth: 1,
  borderBottomWidth: 1,
  },
  modalCancelText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  // Theme selection styles
  themeOptions: {
    gap: 12,
    marginTop: 20,
  },
  themeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    gap: 16,
  },
  themeOptionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  themeOptionContent: {
    flex: 1,
  },
  themeOptionTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  themeOptionDescription: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  selectedIndicator: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkmark: {
    fontSize: 14,
    fontWeight: 'bold',
    color: 'white',
  },
});