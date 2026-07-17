import { logger } from '@/lib/logger';
import { STORAGE_KEYS } from '@/lib/storageKeys';
import { useState, useEffect, useCallback, useRef } from 'react';
import { auth, firestore } from '../config/firebase';
import { 
  signOut as firebaseSignOut,
  onAuthStateChanged,
  onIdTokenChanged,
  User,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithCredential,
} from 'firebase/auth';
import { 
  collection, 
  doc, 
  getDoc, 
  setDoc, 
  getDocs, 
  getDocsFromServer,
  deleteDoc,
  onSnapshot,
  Unsubscribe,
  updateDoc,
  deleteField,
  Timestamp,
  query,
  where,
  limit
} from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import { Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { teamMembershipNotifier, TeamMembershipChangePayload } from '@/services/teamMembershipNotifier';
import { tenantService } from '@/services/tenantService';
import { chatCacheService } from '@/services/chatCacheService';
import { notificationService } from '@/services/notificationService';
import { settingsService } from '@/services/settingsService';
import { tenantBackendClient } from '@/services/tenantBackendClient';
import type { TenantMembershipRole } from '@/types';
// Lazy-load deviceTrackingService to avoid import cycles (typed)
type DeviceTrackingServiceType = typeof import('../services/deviceTrackingService').deviceTrackingService;
// Minimal contract for methods this file uses; narrows surface and allows future refactors
interface IDeviceTrackingServiceContract {
  checkLoginDeviceBan(userEmail: string): Promise<{ banned: boolean; banInfo?: any; errorMessage?: string }>;
  getCurrentDeviceId(): string | null;
  logUserLogout(userEmail: string, deviceId: string): Promise<void>;
  updateLastLogin(userEmail: string): Promise<void>;
  forceLogoutAllUserDevices(userEmail: string, tenantId: string, reason?: string): Promise<void>;
}
let __deviceTrackingService: (DeviceTrackingServiceType & IDeviceTrackingServiceContract) | null = null;
function getDeviceTrackingService(): DeviceTrackingServiceType & IDeviceTrackingServiceContract {
  if (!__deviceTrackingService) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-var-requires
    const mod = require('../services/deviceTrackingService');
  __deviceTrackingService = mod.deviceTrackingService as DeviceTrackingServiceType & IDeviceTrackingServiceContract;
  }
  return __deviceTrackingService;
}

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  customImageURL?: string | null;
  isAuthorized: boolean;
  role: 'user' | 'admin';
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatar: string;
  photoURL?: string;
  customImageURL?: string | null;
  role: 'user' | 'admin';
  tenantRole?: TenantMembershipRole;
  isOnline?: boolean;
  lastSeen?: string;
  typingTo?: string;
  school?: string;
  bio?: string;
  phone?: string;
  dateOfBirth?: string;
  salutation?: 'Mr.' | 'Ms.';
  subjects?: string[];
}

// Global state for the unified auth system
let globalAuthState: {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  isInitialized: boolean;
  isOffline?: boolean;
  authorizationErrorPending?: boolean; // Flag to preserve authorization errors
  reloginRequired?: boolean;
  reloginReason?: string | null;
  roleChangeNotice?: { oldRole: 'user' | 'admin'; newRole: 'user' | 'admin'; at: number } | null;
} = {
  user: null,
  loading: true,
  error: null,
  isInitialized: false,
  isOffline: false,
  authorizationErrorPending: false,
  reloginRequired: false,
  reloginReason: null,
  roleChangeNotice: null,
};

// Constants for offline caching
const CACHED_USER_KEY = STORAGE_KEYS.cachedUserData;
const CACHED_AUTH_EMAILS_KEY = STORAGE_KEYS.cachedAuthorizedEmails;
const MAX_PROFILE_IMAGE_URL_LENGTH = 4096;
const MAX_PROFILE_DISPLAY_NAME_LENGTH = 120;

function sanitizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, MAX_PROFILE_DISPLAY_NAME_LENGTH);
}

function fallbackDisplayNameFromEmail(email: string): string {
  const localPart = email.split('@')[0]?.trim();
  if (!localPart) {
    return 'User';
  }
  return localPart.slice(0, MAX_PROFILE_DISPLAY_NAME_LENGTH);
}

function normalizeNameForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isEmailPrefixFallbackDisplayName(displayName: unknown, email: string): boolean {
  const normalizedDisplayName = sanitizeDisplayName(displayName);
  if (!normalizedDisplayName) {
    return false;
  }

  const localPart = email.split('@')[0]?.trim();
  if (!localPart) {
    return false;
  }

  const rawFallback = localPart.slice(0, MAX_PROFILE_DISPLAY_NAME_LENGTH);
  const spacedFallback = rawFallback.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const titleFallback = spacedFallback.replace(/\b\w/g, (letter: string) => letter.toUpperCase());

  const candidates = new Set<string>([
    normalizeNameForComparison(rawFallback),
    normalizeNameForComparison(spacedFallback),
    normalizeNameForComparison(titleFallback),
  ]);

  return candidates.has(normalizeNameForComparison(normalizedDisplayName));
}

function resolvePreferredDisplayName(params: {
  email: string;
  profileDisplayName?: unknown;
  authDisplayName?: unknown;
}): string {
  const profileDisplayName = sanitizeDisplayName(params.profileDisplayName);
  const authDisplayName = sanitizeDisplayName(params.authDisplayName);

  if (
    profileDisplayName &&
    authDisplayName &&
    isEmailPrefixFallbackDisplayName(profileDisplayName, params.email)
  ) {
    return authDisplayName;
  }

  return (
    profileDisplayName ||
    authDisplayName ||
    fallbackDisplayNameFromEmail(params.email)
  );
}

function syncAuthUserDisplayName(email: string, nextDisplayName?: string): void {
  if (!nextDisplayName || !globalAuthState.user) {
    return;
  }

  if (globalAuthState.user.email.toLowerCase() !== email.toLowerCase()) {
    return;
  }

  if (globalAuthState.user.displayName === nextDisplayName) {
    return;
  }

  globalAuthState.user = {
    ...globalAuthState.user,
    displayName: nextDisplayName,
  };
  notifyListeners();
}

function sanitizeProfileImageUrl(
  value: unknown,
  fieldName: 'photoURL' | 'customImageURL'
): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  const isRemoteUrl = lower.startsWith('https://') || lower.startsWith('http://');
  if (!isRemoteUrl) {
    logger.warn(`Skipping non-remote ${fieldName} value during profile sync`, {
      fieldName,
      length: trimmed.length,
    });
    return undefined;
  }

  if (trimmed.length > MAX_PROFILE_IMAGE_URL_LENGTH) {
    logger.warn(`Skipping oversized ${fieldName} value during profile sync`, {
      fieldName,
      length: trimmed.length,
      max: MAX_PROFILE_IMAGE_URL_LENGTH,
    });
    return undefined;
  }

  return trimmed;
}

// Presence configuration (client-side)
// EXPO_PUBLIC_PRESENCE_MODE: 'last_seen' | 'flag'
//  - 'last_seen' derives online from recent lastSeen
//  - 'flag' trusts stored isOnline field only
// EXPO_PUBLIC_FIRESTORE_ONLINE_THRESHOLD_MIN: number in minutes (e.g., 0.5 = 30 seconds)
const PRESENCE_MODE = (process.env.EXPO_PUBLIC_PRESENCE_MODE || 'last_seen').toLowerCase();
const getPresenceThresholdMin = (): number => {
  const raw = process.env.EXPO_PUBLIC_FIRESTORE_ONLINE_THRESHOLD_MIN;
  const val = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(val) && val > 0 ? val : 0.5; // default 30s
};

// PERF (P8): derive the presence heartbeat from the online threshold instead of a
// fixed 15s constant so the two can never desync. We refresh at half the threshold
// (a 2x safety margin, so a member never flickers offline between beats) with a
// sane floor. At the default 30s threshold this evaluates to exactly 15s (no
// behaviour change); relaxing EXPO_PUBLIC_FIRESTORE_ONLINE_THRESHOLD_MIN therefore
// *automatically* cuts presence write volume (and the tenant-wide presence read
// amplification) with zero risk of a false-offline. Full structural fix (RTDB
// onDisconnect) remains documented in docs/PERFORMANCE_AUDIT.md P8.
const PRESENCE_HEARTBEAT_MIN_MS = 15000;
const getPresenceHeartbeatMs = (): number => {
  const thresholdMs = getPresenceThresholdMin() * 60 * 1000;
  return Math.max(PRESENCE_HEARTBEAT_MIN_MS, Math.floor(thresholdMs / 2));
};

// Initialize Google Sign-In
const initializeGoogleSignIn = () => {
  if (Platform.OS !== 'web') {
    GoogleSignin.configure({
      webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, // Required for Firebase Auth
      offlineAccess: true,
      scopes: ['profile', 'email'],
    });
  }
};

// Initialize on module load
initializeGoogleSignIn();

let authListeners: Set<(state: typeof globalAuthState) => void> = new Set();
let firebaseUnsubscribe: (() => void) | null = null;
let idTokenUnsubscribe: (() => void) | null = null;
let authorizedEmails: string[] = [];
let teamMembersListeners: Set<(members: TeamMember[]) => void> = new Set();
let teamMembersUnsubscribe: Unsubscribe | null = null;
let teamMembersReinitUnsub: (() => void) | null = null;
let presenceInterval: ReturnType<typeof setInterval> | null = null;
const tenantPresenceTenantIdsCache = new Map<string, { tenantIds: string[]; at: number }>();
let isAppInBackground = false; // Track app state
let roleListenerUnsubscribe: Unsubscribe | null = null;
let lastRoleHeartbeatCheckAt = 0;
let roleBaselineEstablished = false;
let lastSyncedRole: 'user' | 'admin' | null = null;
let tokenRefreshInterval: ReturnType<typeof setInterval> | null = null;
// Track how authorized emails were last loaded: from Firestore (authoritative), from cache, or error
// Prevent concurrent revalidation attempts
let revalidationInProgress = false;
let permissionDeniedCounter = 0;
let lastPermissionDeniedAt = 0;
let permissionRecoveryInFlight: Promise<void> | null = null;

const firestoreReinitHandlers = new Set<(context?: string) => void>();
function registerFirestoreReinit(handler: (context?: string) => void): () => void {
  firestoreReinitHandlers.add(handler);
  return () => {
    firestoreReinitHandlers.delete(handler);
  };
}

function reinitFirestoreListeners(context?: string): void {
  firestoreReinitHandlers.forEach((handler) => {
    try {
      handler(context);
    } catch (error) {
      logger.warn('Failed to reinit Firestore listeners', { context, error });
    }
  });
}

function stopTokenRefreshTimer(): void {
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
  }
}

function startTokenRefreshTimer(user: User): void {
  stopTokenRefreshTimer();
  tokenRefreshInterval = setInterval(async () => {
    try {
      if (globalAuthState.isOffline) return;
      await user.getIdToken(true);
      reinitFirestoreListeners('periodic-token-refresh');
      await revalidateAuthorizationOnReconnect(2, 300);
      logger.debug('🔁 Periodic token refresh completed');
    } catch (error) {
      logger.warn('Periodic token refresh failed', error);
    }
  }, 30 * 60 * 1000);
}

// Global variable to track current presence user (for debugging)
let currentPresenceUser: string | null = null;

// Notify all listeners of state changes
function notifyListeners() {
  authListeners.forEach(listener => listener({ ...globalAuthState }));
}

const PERMISSION_DENIED_MARKERS = [
  'missing or insufficient permissions',
  'insufficient permissions',
  'permission-denied',
];

function isPermissionDeniedError(error: unknown): boolean {
  if (!error) return false;
  const errorAny = error as any;
  const code = (errorAny?.code || '').toString().toLowerCase();
  if (code === 'permission-denied') return true;
  const message = (typeof error === 'string' ? error : errorAny?.message || '').toString().toLowerCase();
  if (!message) return false;
  return PERMISSION_DENIED_MARKERS.some((marker) => message.includes(marker));
}

async function attemptPermissionRecovery(reason?: string): Promise<void> {
  if (permissionRecoveryInFlight) {
    return permissionRecoveryInFlight;
  }
  const user = auth.currentUser;
  if (!user) return;
  if (globalAuthState.isOffline) return;
  permissionRecoveryInFlight = (async () => {
    try {
      logger.debug('🔄 Attempting permission recovery via token refresh', { reason });
      await user.getIdToken(true);
      reinitFirestoreListeners('permission-recovery');
      await revalidateAuthorizationOnReconnect(2, 400);
      clearReloginRequired();
      logger.debug('✅ Permission recovery attempt completed');
    } catch (error) {
      logger.warn('⚠️ Permission recovery attempt failed', error);
    } finally {
      permissionRecoveryInFlight = null;
    }
  })();
  return permissionRecoveryInFlight;
}

async function bootstrapGlobalAdminClaim(user: User): Promise<void> {
  if (!user) return;
  if (globalAuthState.isOffline) return;
  try {
    const me = await tenantBackendClient.getGlobalAdminMe();
    if (!me) return;
    if (me.isGlobalAdmin === true) {
      await user.getIdToken(true);
      reinitFirestoreListeners('global-admin-claim-bootstrap');
      logger.debug('🔐 Global admin claim bootstrap refresh completed', {
        uid: user.uid,
      });
    }
  } catch (error) {
    logger.warn('Global admin claim bootstrap check failed', error);
  }
}

function flagReloginRequired(reason?: string, error?: unknown): void {
  if (globalAuthState.reloginRequired) return;
  const hasAuthUser = Boolean(globalAuthState.user || auth.currentUser);
  if (!hasAuthUser) return;
  if (globalAuthState.isOffline) return;
  if (!isPermissionDeniedError(error)) return;
  const now = Date.now();
  if (now - lastPermissionDeniedAt > 30000) {
    permissionDeniedCounter = 0;
  }
  lastPermissionDeniedAt = now;
  permissionDeniedCounter += 1;

  if (permissionDeniedCounter <= 1) {
    void attemptPermissionRecovery(reason);
    return;
  }

  globalAuthState.reloginRequired = true;
  globalAuthState.reloginReason = reason || null;
  notifyListeners();
}

function forceReloginRequired(reason?: string): void {
  if (globalAuthState.reloginRequired) return;
  const hasAuthUser = Boolean(globalAuthState.user || auth.currentUser);
  if (!hasAuthUser) return;
  if (globalAuthState.isOffline) return;
  globalAuthState.reloginRequired = true;
  globalAuthState.reloginReason = reason || null;
  notifyListeners();
}

let reloginErrorInterceptorInstalled = false;
function installReloginErrorInterceptor(): void {
  if (reloginErrorInterceptorInstalled) return;
  reloginErrorInterceptorInstalled = true;
  logger.setErrorInterceptor?.((level, args) => {
    if (level !== 'warn' && level !== 'error') return;
    for (const arg of args) {
      flagReloginRequired(`logger.${level}`, arg);
    }
  });
}

function clearReloginRequired(): void {
  const hadState = Boolean(globalAuthState.reloginRequired || globalAuthState.reloginReason);
  globalAuthState.reloginRequired = false;
  globalAuthState.reloginReason = null;
  permissionDeniedCounter = 0;
  lastPermissionDeniedAt = 0;
  if (hadState) {
    notifyListeners();
  }
}

installReloginErrorInterceptor();

async function clearUserScopedStorage(): Promise<void> {
  const explicitKeys: string[] = [
    STORAGE_KEYS.cachedUserData,
    STORAGE_KEYS.cachedAuthorizedEmails,
    STORAGE_KEYS.userProfile,
    STORAGE_KEYS.appSettings,
    STORAGE_KEYS.authorizedEmails,
    STORAGE_KEYS.customProfilePicture,
    STORAGE_KEYS.useCustomProfilePicture,
    STORAGE_KEYS.selectedTenantId,
    STORAGE_KEYS.cachedTenantMemberships,
    STORAGE_KEYS.tenantNotificationPreferenceDrafts,
    STORAGE_KEYS.cacheLastClearedAt,
    'userToken',
    'notificationPreferences',
    'pendingMessages',
    'pendingMediaMessages',
    'pendingAttachmentMessages',
    'notice_reaction_emojis_v1',
    'apiQuoteCache',
    'dashboardData',
    'pendingAutoFeeActions',
    'rejectedAutoFeeActions',
    'paymentReminderPrefs',
    'last_active_at',
    'chat_cache_v3_encryption_key',
  ];

  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const keysToRemove = new Set(explicitKeys);
    for (const key of allKeys) {
      if (key.startsWith('chat-cache:')) {
        keysToRemove.add(key);
      }
    }
    if (keysToRemove.size) {
      await AsyncStorage.multiRemove(Array.from(keysToRemove));
    }
  } catch (error) {
    logger.warn('⚠️ Failed to clear user-scoped storage:', error);
  }

  try {
    await chatCacheService.clearAllMediaCaches();
  } catch (error) {
    logger.warn('⚠️ Failed to clear chat media cache:', error);
  }

  try {
    await notificationService.cleanup();
  } catch (error) {
    logger.warn('⚠️ Failed to cleanup notification service:', error);
  }

  try {
    settingsService.clearCache();
  } catch (error) {
    logger.warn('⚠️ Failed to clear settings cache:', error);
  }
}

// Offline caching utilities
async function cacheUserData(user: AuthUser | null): Promise<void> {
  try {
    if (user) {
      await AsyncStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
      logger.debug('✅ User data cached successfully');
    } else {
      await AsyncStorage.removeItem(CACHED_USER_KEY);
      logger.debug('✅ User data cache cleared');
    }
  } catch (error) {
    logger.warn('⚠️ Failed to cache user data:', error);
  }
}

async function getCachedUserData(): Promise<AuthUser | null> {
  try {
    const cachedData = await AsyncStorage.getItem(CACHED_USER_KEY);
    if (cachedData) {
      const user = JSON.parse(cachedData) as AuthUser;
      logger.debug('✅ Retrieved cached user data:', user.email);
      return user;
    }
  } catch (error) {
    logger.warn('⚠️ Failed to retrieve cached user data:', error);
  }
  return null;
}

async function cacheAuthorizedEmails(emails: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHED_AUTH_EMAILS_KEY, JSON.stringify(emails));
    logger.debug('✅ Authorized emails cached successfully');
  } catch (error) {
    logger.warn('⚠️ Failed to cache authorized emails:', error);
  }
}

async function getCachedAuthorizedEmails(): Promise<string[]> {
  try {
    const cachedData = await AsyncStorage.getItem(CACHED_AUTH_EMAILS_KEY);
    if (cachedData) {
      const emails = JSON.parse(cachedData) as string[];
      logger.debug('✅ Retrieved cached authorized emails, count:', emails.length);
      return emails;
    }
  } catch (error) {
    logger.warn('⚠️ Failed to retrieve cached authorized emails:', error);
  }
  return [];
}

function resetRoleSyncTracking() {
  roleBaselineEstablished = false;
  lastSyncedRole = null;
  clearCachedUserRole();
}

function primeRoleSyncTracking(role: 'user' | 'admin' | null | undefined) {
  roleBaselineEstablished = false;
  lastSyncedRole = role ?? null;
}

function confirmRoleSyncTracking(role: 'user' | 'admin') {
  roleBaselineEstablished = true;
  lastSyncedRole = role;
}

async function applyAuthoritativeRoleUpdate(
  newRole: 'user' | 'admin',
  options?: { requireOnlineCheck?: boolean },
): Promise<void> {
  if (!globalAuthState.user) {
    confirmRoleSyncTracking(newRole);
    return;
  }

  const previousRole = globalAuthState.user.role;

  if (!roleBaselineEstablished) {
    confirmRoleSyncTracking(newRole);
    if (previousRole !== newRole) {
      globalAuthState.user.role = newRole;
      await cacheUserData(globalAuthState.user);
    }
    globalAuthState.roleChangeNotice = null;
    notifyListeners();
    return;
  }

  if (previousRole === newRole) {
    lastSyncedRole = newRole;
    return;
  }

  lastSyncedRole = newRole;
  globalAuthState.user.role = newRole;
  await cacheUserData(globalAuthState.user);

  const requireOnlineCheck = options?.requireOnlineCheck ?? true;
  if (requireOnlineCheck) {
    const online = await checkNetworkStatus();
    if (!online) {
      notifyListeners();
      return;
    }
  }

  globalAuthState.roleChangeNotice = { oldRole: previousRole, newRole, at: Date.now() };
  notifyListeners();
}

// Re-validate current user's authorization with exponential backoff on reconnect
async function revalidateAuthorizationOnReconnect(_: number = 3, __: number = 500): Promise<void> {
  try {
    if (revalidationInProgress) return;
    const stateUser = globalAuthState.user;
    if (!stateUser) return;
    revalidationInProgress = true;

    const online = await checkNetworkStatus();
    if (!online) {
      return;
    }

    stateUser.isAuthorized = true;
    globalAuthState.isOffline = false;
    if (globalAuthState.error && globalAuthState.error.startsWith('Working offline')) {
      globalAuthState.error = null;
    }
    notifyListeners();
  } finally {
    revalidationInProgress = false;
  }
}

async function checkNetworkStatus(): Promise<boolean> {
  try {
    // For web, trust navigator.onLine to avoid false negatives from NetInfo
    // during OAuth redirect return.
    if (Platform.OS === 'web') {
      const navigatorOnline = navigator.onLine;
      logger.debug('🌐 Navigator.onLine:', navigatorOnline);
      return navigatorOnline;
    }
    
    // Use NetInfo for more detailed check, but with timeout
    const timeoutPromise = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        logger.debug('🌐 NetInfo timeout - assuming online');
        resolve(true); // Default to online if NetInfo takes too long
      }, 2000);
    });
    
    const netInfoPromise = NetInfo.fetch().then(state => {
      const isOnline = (state.isConnected ?? false) && (state.isInternetReachable ?? false);
      logger.debug('🌐 NetInfo network status check:', { 
        isConnected: state.isConnected, 
        isInternetReachable: state.isInternetReachable,
        finalResult: isOnline
      });
      return isOnline;
    });
    
    const result = await Promise.race([netInfoPromise, timeoutPromise]);
    logger.debug('🌐 Final network status result:', result);
    return result;
  } catch (error) {
    logger.warn('⚠️ Failed to check network status:', error);
    // Fallback to navigator.onLine for web, or assume online for safety
    if (Platform.OS === 'web') {
      const fallback = navigator.onLine;
      logger.debug('🌐 Using navigator.onLine fallback:', fallback);
      return fallback;
    }
    logger.debug('🌐 Assuming online due to error');
    return true; // Assume online if network check fails to prevent false offline detection
  }
}

// Update only the users collection (for storing original Google profile data)
async function updateUsersCollectionOnly(email: string, profileData: {
  displayName?: string;
  photoURL?: string;
  customImageURL?: string | null;
  school?: string;
  bio?: string;
  phone?: string;
  dateOfBirth?: string;
  salutation?: 'Mr.' | 'Ms.';
  subjects?: string[];
}): Promise<void> {
  try {
    if (!auth.currentUser) {
      logger.debug('ℹ️ No authenticated user, skipping users collection update');
      return;
    }

    const normalizedEmail = email.toLowerCase();
    const userRef = doc(firestore, 'users', auth.currentUser.uid);
    
    // Create update data for users collection
    const updateData: any = {
      email: normalizedEmail,
      updatedAt: new Date(),
    };

    const safePhotoURL = sanitizeProfileImageUrl(profileData.photoURL, 'photoURL');
    const safeCustomImageURL = sanitizeProfileImageUrl(profileData.customImageURL, 'customImageURL');
    const safeDisplayName = sanitizeDisplayName(profileData.displayName);
    
    // Only include fields that are provided
    if (safeDisplayName) updateData.displayName = safeDisplayName;
    if (safePhotoURL) updateData.photoURL = safePhotoURL;
    if (profileData.customImageURL !== undefined) {
      if (profileData.customImageURL) {
        if (safeCustomImageURL) {
          updateData.customImageURL = safeCustomImageURL;
        }
      } else {
        // Use deleteField to explicitly remove the customImageURL field when null or empty
        updateData.customImageURL = deleteField();
      }
    }
    if (profileData.school !== undefined) updateData.school = profileData.school;
    if (profileData.bio !== undefined) updateData.bio = profileData.bio;
  if (profileData.phone !== undefined) updateData.phone = profileData.phone;
  if (profileData.dateOfBirth !== undefined) updateData.dateOfBirth = profileData.dateOfBirth;
  if (profileData.salutation !== undefined) updateData.salutation = profileData.salutation;
  if (profileData.subjects !== undefined) updateData.subjects = profileData.subjects;
    
    // Try to update the document, create if it doesn't exist
    await setDoc(userRef, updateData, { merge: true });
    
    logger.debug('✅ Users collection update successful');
  } catch (error) {
    logger.warn('⚠️ Users collection update failed:', error);
    // Don't throw error - this is a fallback/backup operation
  }
}

async function updateTenantProfilesForUser(email: string, profileData: {
  displayName?: string;
  photoURL?: string;
  customImageURL?: string | null;
  school?: string;
  bio?: string;
  phone?: string;
  dateOfBirth?: string;
  salutation?: 'Mr.' | 'Ms.';
  subjects?: string[];
}): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  const tenantIds = await getActiveTenantIdsForPresence(normalizedEmail);
  if (!tenantIds.length) {
    return;
  }

  const emailKey = sanitizeEmailKey(normalizedEmail);
  const safePhotoURL = sanitizeProfileImageUrl(profileData.photoURL, 'photoURL');
  const safeCustomImageURL = sanitizeProfileImageUrl(profileData.customImageURL, 'customImageURL');
  const safeDisplayName = sanitizeDisplayName(profileData.displayName);

  await Promise.all(
    tenantIds.map(async (tenantId) => {
      const payload: Record<string, any> = {
        tenantId,
        email: normalizedEmail,
        updatedAt: new Date(),
      };

      if (safeDisplayName) payload.displayName = safeDisplayName;
      if (safePhotoURL) payload.photoURL = safePhotoURL;
      if (profileData.customImageURL !== undefined) {
        if (profileData.customImageURL) {
          if (safeCustomImageURL) {
            payload.customImageURL = safeCustomImageURL;
          }
        } else {
          payload.customImageURL = deleteField();
        }
      }
      if (profileData.school !== undefined) payload.school = profileData.school;
      if (profileData.bio !== undefined) payload.bio = profileData.bio;
      if (profileData.phone !== undefined) payload.phone = profileData.phone;
      if (profileData.dateOfBirth !== undefined) payload.dateOfBirth = profileData.dateOfBirth;
      if (profileData.salutation !== undefined) payload.salutation = profileData.salutation;
      if (profileData.subjects !== undefined) payload.subjects = profileData.subjects;

      await setDoc(
        doc(firestore, 'tenantProfiles', `${tenantId}_${emailKey}`),
        payload,
        { merge: true }
      );
    })
  );
}

// Safe profile update with fallback
async function updateUserProfileSafe(email: string, profileData: {
  displayName?: string;
  photoURL?: string;
  customImageURL?: string | null;
  isOnline?: boolean;
  lastSeen?: string;
  typingTo?: string | null;
  school?: string;
  bio?: string;
  phone?: string;
  dateOfBirth?: string;
  salutation?: 'Mr.' | 'Ms.';
  subjects?: string[];
}): Promise<void> {
  try {
    const safeDisplayName = sanitizeDisplayName(profileData.displayName);
    // Only log 10% of presence updates to reduce noise, but always log profile updates
    const shouldLog = !profileData.isOnline || safeDisplayName || profileData.photoURL || profileData.customImageURL || Math.random() < 0.1;
    if (shouldLog) {
      logger.debug('🔄 Safely updating user profile:', { email, profileData });
    }
    
    const normalizedEmail = email.toLowerCase();
    const safePhotoURL = sanitizeProfileImageUrl(profileData.photoURL, 'photoURL');
    const safeCustomImageURL = sanitizeProfileImageUrl(profileData.customImageURL, 'customImageURL');

    // Primary write path: tenantProfiles + tenantPresence (tenant-native stores)
    try {
      await updateTenantProfilesForUser(normalizedEmail, {
        displayName: safeDisplayName,
        photoURL: safePhotoURL,
        customImageURL: profileData.customImageURL ? safeCustomImageURL : profileData.customImageURL,
        school: profileData.school,
        bio: profileData.bio,
        phone: profileData.phone,
        dateOfBirth: profileData.dateOfBirth,
        salutation: profileData.salutation,
        subjects: profileData.subjects,
      });

      if (
        profileData.isOnline !== undefined ||
        profileData.lastSeen !== undefined ||
        profileData.typingTo !== undefined
      ) {
        await updateTenantPresenceForUser(normalizedEmail, {
          isOnline: profileData.isOnline,
          lastSeen: profileData.lastSeen,
          typingTo: profileData.typingTo,
        });
      }
      if (safeDisplayName) {
        syncAuthUserDisplayName(normalizedEmail, safeDisplayName);
      }
      if (shouldLog) logger.debug('✅ User profile update successful in tenantProfiles/tenantPresence');
      return;
    } catch (authError) {
      const errorMessage = authError instanceof Error ? authError.message : String(authError);
      const errorCode = (authError as any)?.code || '';
      
      // Check for permission errors more robustly
      const isPermissionError = errorMessage.includes('Missing or insufficient permissions') || 
                               errorMessage.includes('insufficient permissions') ||
                               errorMessage.includes('permission-denied') ||
                               errorCode === 'permission-denied';
      
      if (isPermissionError) {
        flagReloginRequired('updateUserProfileSafe.tenantCollections', authError);
      }
      if (!isPermissionError && shouldLog) {
        logger.warn('⚠️ Tenant profile update failed, trying users collection:', authError);
      }
      
      // Fallback to users collection
      try {
        if (!auth.currentUser) {
          logger.debug('ℹ️ No authenticated user, skipping users collection update');
          return;
        }

        const userRef = doc(firestore, 'users', auth.currentUser.uid);
        
        // Create update data for users collection
        const updateData: any = {
          email: normalizedEmail,
          updatedAt: new Date(),
        };
        
        // Only include fields that are provided
        if (profileData.isOnline !== undefined) updateData.isOnline = profileData.isOnline;
        if (profileData.lastSeen) updateData.lastSeen = profileData.lastSeen;
        if (safeDisplayName) updateData.displayName = safeDisplayName;
        if (safePhotoURL) updateData.photoURL = safePhotoURL;
        if (profileData.customImageURL !== undefined) {
          if (profileData.customImageURL) {
            if (safeCustomImageURL) {
              updateData.customImageURL = safeCustomImageURL;
            }
          } else {
            // Use deleteField to explicitly remove the customImageURL field when null or empty
            updateData.customImageURL = deleteField();
          }
        }
        if (profileData.typingTo !== undefined) updateData.typingTo = profileData.typingTo;
        if (profileData.school !== undefined) updateData.school = profileData.school;
        if (profileData.bio !== undefined) updateData.bio = profileData.bio;
  if (profileData.phone !== undefined) updateData.phone = profileData.phone;
  if (profileData.dateOfBirth !== undefined) updateData.dateOfBirth = profileData.dateOfBirth;
  if (profileData.salutation !== undefined) updateData.salutation = profileData.salutation;
  if (profileData.subjects !== undefined) updateData.subjects = profileData.subjects;
        
  await setDoc(userRef, updateData, { merge: true });
  if (safeDisplayName) {
    syncAuthUserDisplayName(normalizedEmail, safeDisplayName);
  }
  if (shouldLog) logger.debug('✅ User profile update successful in users collection (fallback)');
        return;
      } catch (firestoreError) {
        const usersErrorMessage = firestoreError instanceof Error ? firestoreError.message : String(firestoreError);
        const usersErrorCode = (firestoreError as any)?.code || '';
        
        // Check for permission errors more robustly
        const isUsersPermissionError = usersErrorMessage.includes('Missing or insufficient permissions') || 
                                     usersErrorMessage.includes('insufficient permissions') ||
                                     usersErrorMessage.includes('permission-denied') ||
                                     usersErrorCode === 'permission-denied';
        
        // Only log non-permission errors and only when shouldLog is true
        if (isUsersPermissionError) {
          flagReloginRequired('updateUserProfileSafe.usersCollection', firestoreError);
        }
        if (!isUsersPermissionError && shouldLog) {
          logger.warn('⚠️ Users collection update also failed:', firestoreError);
        }
        // For permission errors, silently fall through to fallbacks
      }
    }
    
    // Fallback 1: For presence data, log that Firestore update failed (for debugging)
    if (profileData.isOnline !== undefined || profileData.lastSeen || profileData.typingTo !== undefined) {
      if (shouldLog) {
        logger.debug('ℹ️ Presence/typing data update deferred - Firestore update failed, will retry on next sync');
      }
    }
    
    // Fallback 2: For profile data (displayName, photoURL), continue silently
    // These are non-critical for app functionality
    if ((safeDisplayName || profileData.photoURL) && shouldLog) {
      logger.debug('ℹ️ Profile data (displayName/photoURL) update deferred - will sync when permissions allow');
    }
  } catch (error) {
    // Completely silent error handling - presence updates should never disrupt user experience
    // Only log in development or for non-permission errors
    if (process.env.NODE_ENV === 'development') {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isPermissionError = errorMessage.includes('Missing or insufficient permissions') || 
                               errorMessage.includes('insufficient permissions') ||
                               errorMessage.includes('permission-denied');
      
      if (isPermissionError) {
        flagReloginRequired('updateUserProfileSafe.outer', error);
      }
      if (!isPermissionError) {
        logger.warn('⚠️ Unexpected error in safe profile update:', error);
      }
    }
    // Don't throw - this should never block sign-in or other operations
  }
}

// Ensure newly authorized user doc gets a default Google photo if missing
async function ensureAuthorizedEmailHasPhoto(email: string, googlePhotoURL?: string | null): Promise<void> {
  try {
    const safeGooglePhotoURL = sanitizeProfileImageUrl(googlePhotoURL, 'photoURL');
    if (!safeGooglePhotoURL) return; // Nothing safe to set
    const normalized = email.toLowerCase();
    const emailKey = sanitizeEmailKey(normalized);
    const tenantIds = await getActiveTenantIdsForPresence(normalized);
    if (!tenantIds.length) return;

    await Promise.all(
      tenantIds.map(async (tenantId) => {
        const profileRef = doc(firestore, 'tenantProfiles', `${tenantId}_${emailKey}`);
        const profileSnap = await getDoc(profileRef);
        if (!profileSnap.exists()) return;
        const data = profileSnap.data() as any;
        if (!data.photoURL && !data.customImageURL) {
          await setDoc(profileRef, { photoURL: safeGooglePhotoURL, updatedAt: new Date() }, { merge: true });
        }
      })
    );
    logger.debug('🖼️ Set default Google photoURL in tenantProfiles for', normalized);
  } catch (e) {
    logger.warn('Failed to ensure tenantProfiles default photoURL:', e);
  }
}

// Set user online status with reduced logging and better error handling
async function setUserOnline(email: string, isOnline: boolean = true) {
  try {
    // Log 10% of presence changes to reduce noise
    const shouldLog = Math.random() < 0.1;
    if (shouldLog) {
      logger.debug('🟢 Setting user online status:', { email, isOnline });
    }
    
    await updateTenantPresenceForUser(email, {
      isOnline,
      lastSeen: new Date().toISOString(),
      typingTo: isOnline ? undefined : null,
    });
  } catch (error) {
    // Silently handle errors - presence is not critical for app functionality
    // Only log if it's not a permission error
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as any)?.code || '';
    
    // Check for permission errors more robustly
    const isPermissionError = errorMessage.includes('Missing or insufficient permissions') || 
                             errorMessage.includes('insufficient permissions') ||
                             errorCode === 'permission-denied';
    
    if (isPermissionError) {
      flagReloginRequired('setUserOnline', error);
    }
    if (!isPermissionError) {
      logger.warn('Non-permission error setting user online status:', error);
    }
  }
}

function sanitizeEmailKey(value: string): string {
  return value.replace(/[@.]/g, '_');
}

async function getActiveTenantIdsForPresence(email: string): Promise<string[]> {
  const normalizedEmail = email.toLowerCase();
  const cacheKey = `${auth.currentUser?.uid || 'nouid'}:${normalizedEmail}`;
  const cached = tenantPresenceTenantIdsCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < 60000) {
    return cached.tenantIds;
  }

  try {
    const membershipCollection = collection(firestore, 'tenantMemberships');
    const uid = auth.currentUser?.uid;
    const membershipQuery = uid
      ? query(
          membershipCollection,
          where('userId', '==', uid),
          where('status', '==', 'active')
        )
      : query(
          membershipCollection,
          where('email', '==', normalizedEmail),
          where('status', '==', 'active')
        );

    const snapshot = await getDocs(membershipQuery);
    const tenantIds = Array.from(
      new Set(
        snapshot.docs
          .map((docSnap) => String((docSnap.data() as any)?.tenantId || '').trim())
          .filter((tenantId) => tenantId.length > 0)
      )
    );

    tenantPresenceTenantIdsCache.set(cacheKey, { tenantIds, at: now });
    return tenantIds;
  } catch (error) {
    logger.warn('Failed to load active tenant ids for presence update', { error, email: normalizedEmail });
    return [];
  }
}

async function updateTenantPresenceForUser(
  email: string,
  patch: {
    isOnline?: boolean;
    lastSeen?: string;
    typingTo?: string | null;
  }
): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  const tenantIds = await getActiveTenantIdsForPresence(normalizedEmail);
  if (tenantIds.length === 0) {
    return;
  }

  const emailKey = sanitizeEmailKey(normalizedEmail);
  const payload: Record<string, any> = {
    email: normalizedEmail,
    updatedAt: new Date(),
  };

  if (patch.isOnline !== undefined) payload.isOnline = patch.isOnline;
  if (patch.lastSeen) payload.lastSeen = patch.lastSeen;
  if (patch.typingTo !== undefined) payload.typingTo = patch.typingTo;

  await Promise.all(
    tenantIds.map(async (tenantId) => {
      const presenceDocId = `${tenantId}_${emailKey}`;
      await setDoc(
        doc(firestore, 'tenantPresence', presenceDocId),
        {
          tenantId,
          ...payload,
        },
        { merge: true }
      );
    })
  );
}

// Presence system
// Global variables for event listener cleanup
let currentSetOffline: (() => void) | null = null;
let currentHandleVisibilityChange: (() => void) | null = null;
let currentAppStateSubscription: any = null;

function setupPresenceSystem(userEmail: string) {
  logger.debug('🟢 Setting up presence system for:', userEmail, 'Previous user:', currentPresenceUser);
  
  // IMPORTANT: Clean up any existing presence system first
  cleanupPresenceSystem();
  
  // Track current presence user
  currentPresenceUser = userEmail;
  
  // Set user online initially
  setUserOnline(userEmail, true);
  
  // Update presence on a heartbeat derived from the online threshold (see
  // getPresenceHeartbeatMs — defaults to 15s) to reduce stale online state across
  // devices while keeping write volume proportional to the configured threshold.
  const presenceHeartbeatMs = getPresenceHeartbeatMs();
  presenceInterval = setInterval(() => {
    // Don't update presence if app is in background
    if (isAppInBackground) {
      logger.debug('⏸️ Skipping presence update - app is in background');
      return;
    }
    
    if (globalAuthState.user?.email === userEmail && currentPresenceUser === userEmail) {
      logger.debug('⏰ Presence interval tick for:', userEmail);
      setUserOnline(userEmail, true);

      // Heartbeat role check ~every 60s to ensure we catch role changes if RT listener missed
      const now = Date.now();
      if (now - lastRoleHeartbeatCheckAt > 60000) {
        lastRoleHeartbeatCheckAt = now;
        (async () => {
          try {
            const online = await checkNetworkStatus();
            if (!online) return;
            const newRole = await getUserRole(userEmail.toLowerCase());
            await applyAuthoritativeRoleUpdate(newRole, { requireOnlineCheck: false });
          } catch (e) {
            // Silent: heartbeat is best-effort
          }
        })();
      }
    } else {
      logger.debug('❌ Presence interval mismatch - cleaning up for:', userEmail, 'Current auth user:', globalAuthState.user?.email, 'Current presence user:', currentPresenceUser);
      cleanupPresenceSystem();
    }
  }, presenceHeartbeatMs);
  
  // Define event handlers
  const setOffline = () => {
    logger.debug('🔴 Setting user offline:', userEmail);
    setUserOnline(userEmail, false);
  };

  // Store references for cleanup
  currentSetOffline = setOffline;

  // Handle different platforms
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // Web-specific event handlers
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        setOffline();
        // Record last active time in localStorage on background
        try {
          localStorage.setItem('last_active_at', Date.now().toString());
        } catch {}
      } else if (globalAuthState.user?.email === userEmail) {
        logger.debug('🟢 User returned, setting online:', userEmail);
        // On return, check idle timeout (30 days)
        try {
          const v = localStorage.getItem('last_active_at');
          const lastActive = v ? parseInt(v, 10) : Date.now();
          const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
          if (Date.now() - lastActive > THIRTY_DAYS_MS) {
            logger.debug('⏱️ Idle >30 days on web - signing out');
            // Best-effort sign out; ignore errors to avoid blocking UI
            signOut().catch(() => {});
            return;
          }
        } catch {}
        setUserOnline(userEmail, true);
      }
    };
    
    currentHandleVisibilityChange = handleVisibilityChange;
    
    window.addEventListener('beforeunload', setOffline);
    window.addEventListener('visibilitychange', handleVisibilityChange);
  } else {
    // React Native (Android/iOS) - Use AppState
    try {
      const { AppState } = require('react-native');
      
      const handleAppStateChange = (nextAppState: string) => {
        logger.debug('📱 AppState changed to:', nextAppState, 'for user:', userEmail);
        
        if (nextAppState === 'background' || nextAppState === 'inactive') {
          logger.debug('🔴 App backgrounded/inactive - setting user offline:', userEmail);
          isAppInBackground = true;
          setOffline();
          // Persist last active on background
          try {
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            AsyncStorage.setItem('last_active_at', Date.now().toString());
          } catch {}
        } else if (nextAppState === 'active' && globalAuthState.user?.email === userEmail) {
          logger.debug('🟢 App became active - setting user online:', userEmail);
          isAppInBackground = false;
          // On resume, check idle timeout (30 days)
          try {
            const AsyncStorage = require('@react-native-async-storage/async-storage').default;
            AsyncStorage.getItem('last_active_at').then((v: string | null) => {
              const lastActive = v ? parseInt(v, 10) : Date.now();
              const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
              if (Date.now() - lastActive > THIRTY_DAYS_MS) {
                logger.debug('⏱️ Idle >30 days on RN - signing out');
                signOut().catch(() => {});
                return;
              }
              setUserOnline(userEmail, true);
            }).catch(() => setUserOnline(userEmail, true));
            return;
          } catch {}
          setUserOnline(userEmail, true);
        }
      };
      
      // Subscribe to AppState changes
      currentAppStateSubscription = AppState.addEventListener('change', handleAppStateChange);
      logger.debug('📱 AppState listener registered for:', userEmail);
      
    } catch (error) {
      logger.warn('Failed to setup AppState listener:', error);
    }
  }
}

function cleanupPresenceSystem() {
  logger.debug('🧹 Cleaning up presence system for user:', currentPresenceUser);

  if (presenceInterval) {
    logger.debug('⏹️ Clearing presence interval');
    clearInterval(presenceInterval);
    presenceInterval = null;
  }

  // Clean up web event listeners
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    if (typeof currentSetOffline === 'function') {
      window.removeEventListener('beforeunload', currentSetOffline);
      currentSetOffline = null;
    } else if (currentSetOffline !== null) {
      logger.warn('currentSetOffline is not a function:', currentSetOffline);
      currentSetOffline = null;
    }
    if (typeof currentHandleVisibilityChange === 'function') {
      window.removeEventListener('visibilitychange', currentHandleVisibilityChange);
      currentHandleVisibilityChange = null;
    } else if (currentHandleVisibilityChange !== null) {
      logger.warn('currentHandleVisibilityChange is not a function:', currentHandleVisibilityChange);
      currentHandleVisibilityChange = null;
    }
  } else {
    // Clean up React Native AppState listener
    if (currentAppStateSubscription) {
      logger.debug('📱 Removing AppState listener');
      try {
        if (typeof currentAppStateSubscription.remove === 'function') {
          currentAppStateSubscription.remove();
        } else if (typeof currentAppStateSubscription === 'function') {
          // Older RN versions return unsubscribe function directly
          currentAppStateSubscription();
        }
      } catch (error) {
        logger.warn('Error removing AppState listener:', error);
      }
      currentAppStateSubscription = null;
    }
  }

  if (currentPresenceUser) {
    logger.debug('🔴 Setting user offline during cleanup:', currentPresenceUser);
    if (typeof setUserOnline === 'function') {
      setUserOnline(currentPresenceUser, false);
    } else {
      logger.warn('setUserOnline is not a function:', setUserOnline);
    }
    currentPresenceUser = null;
  }

  // Reset background flag
  isAppInBackground = false;
}

// Initialize authorized emails in Firestore (no-op: seeding must be handled server-side or via Admin UI)
async function initializeAuthorizedEmails(): Promise<void> {
  logger.debug('ℹ️ initializeAuthorizedEmails: skipping client-side seeding');
}

// Load authorized emails
async function loadAuthorizedEmails(): Promise<void> {
  try {
    logger.debug('🔄 Loading team roster emails - checking preconditions...');
    
    const isOnline = await checkNetworkStatus();
    
    if (!isOnline) {
      // Use cached emails when offline
      logger.debug('📱 Loading team roster emails from cache (offline)');
      authorizedEmails = await getCachedAuthorizedEmails();
      return;
    }

    // Check if user is authenticated before making Firestore calls
    if (!auth.currentUser) {
      logger.debug('🔐 No authenticated user, loading team roster emails from cache only');
      authorizedEmails = await getCachedAuthorizedEmails();
      return;
    }

    logger.debug('✅ User authenticated, proceeding with Firestore query for tenant memberships');

    const tenantId = await resolveTenantScopeForMembershipNotifications();
    if (!tenantId) {
      authorizedEmails = await getCachedAuthorizedEmails();
      return;
    }

    // Try to load from tenant memberships when online and authenticated
    const membershipQuery = query(
      collection(firestore, 'tenantMemberships'),
      where('tenantId', '==', tenantId),
      where('status', '==', 'active')
    );
    
    try {
      let querySnapshot;
      try {
        querySnapshot = await getDocsFromServer(membershipQuery);
      } catch (serverError: any) {
        logger.warn('⚠️ getDocsFromServer failed (likely offline/slow). Falling back to cache:', serverError);
        querySnapshot = await getDocs(membershipQuery);
        if (querySnapshot.metadata.fromCache) {
          logger.debug('📦 Team roster query served from local cache. Treating as non-authoritative.');
          // Use cached values instead of replacing with potentially empty snapshot.
          const cached = await getCachedAuthorizedEmails();
          if (cached.length > 0) {
            authorizedEmails = cached;
            return;
          }
        }
      }

      if (querySnapshot.metadata.fromCache && !querySnapshot.metadata.hasPendingWrites) {
        logger.debug('📦 Team roster snapshot from cache; will not treat as authoritative.');
      }

      const emails: string[] = [];
      // Include any active membership with a valid email.
      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && typeof data.email === 'string') {
          emails.push(data.email.toLowerCase());
        } else {
          logger.debug('⛔ Skipping membership doc missing email field:', docSnap.id);
        }
      });
      if (querySnapshot.metadata.fromCache && emails.length === 0) {
        logger.warn('⚠️ Team roster snapshot empty due to cache; preserving previous list.');
        const cached = await getCachedAuthorizedEmails();
        authorizedEmails = cached;
        return;
      }

      authorizedEmails = emails;
      await cacheAuthorizedEmails(emails);
      logger.debug('✅ Loaded team roster emails from Firestore:', emails.length);
    } catch (error) {
      logger.warn('⚠️ Failed to load team roster emails, using cache:', error);
      // Fallback to cached emails only
      authorizedEmails = await getCachedAuthorizedEmails();
    }
  } catch (error) {
    logger.warn('⚠️ Unexpected error loading team roster emails, using cache:', error);
    authorizedEmails = await getCachedAuthorizedEmails();
  }
}

// PERF (P14): short-lived cache of the resolved role to dedupe bursty lookups
// (sign-in flow + auth-state re-fires all resolve the role within a second or
// two). Kept intentionally short so the ~60s role heartbeat still performs a
// real read and can catch a change the realtime listener missed. The realtime
// membership listener refreshes this cache directly from its delivered snapshot,
// so steady-state role changes are still picked up in real time.
let cachedUserRole: { email: string; role: 'user' | 'admin'; at: number } | null = null;
const ROLE_CACHE_TTL_MS = 15000;

// Derive the effective role from a set of active tenantMembership docs (owner or
// admin in any tenant => admin). Pure so both the one-shot lookup and the
// realtime listener can share the exact same logic without an extra read.
function deriveRoleFromMembershipDocs(docs: Array<{ data: () => any }>): 'user' | 'admin' {
  const hasAdminRole = docs.some((docSnap) => {
    const role = String((docSnap.data() as any)?.role || '').toLowerCase();
    return role === 'owner' || role === 'admin';
  });
  return hasAdminRole ? 'admin' : 'user';
}

function setCachedUserRole(email: string, role: 'user' | 'admin'): void {
  cachedUserRole = { email: email.toLowerCase(), role, at: Date.now() };
}

function clearCachedUserRole(): void {
  cachedUserRole = null;
}

// Get user role
async function getUserRole(email: string, options?: { maxAgeMs?: number }): Promise<'user' | 'admin'> {
  const normalizedEmail = email.toLowerCase();
  const maxAgeMs = options?.maxAgeMs ?? ROLE_CACHE_TTL_MS;
  if (
    cachedUserRole &&
    cachedUserRole.email === normalizedEmail &&
    Date.now() - cachedUserRole.at <= maxAgeMs
  ) {
    return cachedUserRole.role;
  }
  try {
    const membershipQuery = query(
      collection(firestore, 'tenantMemberships'),
      where('email', '==', normalizedEmail),
      where('status', '==', 'active')
    );
    const membershipSnapshot = await getDocs(membershipQuery);
    const role = deriveRoleFromMembershipDocs(membershipSnapshot.docs);
    setCachedUserRole(normalizedEmail, role);
    return role;
  } catch (error) {
    // Don't cache failures — let the next caller retry.
    logger.error('Error getting user role:', error);
    return 'user';
  }
}

// Helper function to format device ban error messages with comprehensive information
function formatDeviceBanMessage(banInfo: any): string {
  // Extract ban reason with proper formatting
  const banReason = banInfo?.reason || 'Device violation';
  
  // Start with the Device banned prefix for identification (but will be cleaned for display)
  let displayMessage = `DEVICE_BAN_ERROR:Your device has been banned.`;
  
  // Add expiry information if available
  if (banInfo?.expiresAt) {
    try {
      let expirationDate: Date;
      
      // Handle different Firestore timestamp formats
      if (banInfo.expiresAt instanceof Timestamp) {
        expirationDate = banInfo.expiresAt.toDate();
      } else if (banInfo.expiresAt instanceof Date) {
        expirationDate = banInfo.expiresAt;
      } else if (banInfo.expiresAt && typeof banInfo.expiresAt === 'object' && banInfo.expiresAt.seconds) {
        // Handle Firestore timestamp with seconds and nanoseconds properties
        const milliseconds = banInfo.expiresAt.seconds * 1000 + Math.floor((banInfo.expiresAt.nanoseconds || 0) / 1000000);
        expirationDate = new Date(milliseconds);
      } else if (banInfo.expiresAt && banInfo.expiresAt.toDate && typeof banInfo.expiresAt.toDate === 'function') {
        // Handle objects with toDate method
        expirationDate = banInfo.expiresAt.toDate();
      } else {
        // Fallback to direct conversion
        expirationDate = new Date(banInfo.expiresAt);
      }
      
      const now = new Date();
      const timeDiff = expirationDate.getTime() - now.getTime();
      
      if (timeDiff > 0) {
        const daysRemaining = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
        const hoursRemaining = Math.ceil(timeDiff / (1000 * 60 * 60));
        const minutesRemaining = Math.ceil(timeDiff / (1000 * 60));
        
        // Update the first line to include the duration
        if (minutesRemaining < 60) {
          displayMessage = `DEVICE_BAN_ERROR:Your device has been banned for ${minutesRemaining} minutes.`;
        } else if (hoursRemaining < 24) {
          displayMessage = `DEVICE_BAN_ERROR:Your device has been banned for ${hoursRemaining} hours.`;
        } else if (daysRemaining === 1) {
          displayMessage = `DEVICE_BAN_ERROR:Your device has been banned for 1 day.`;
        } else if (daysRemaining < 30) {
          displayMessage = `DEVICE_BAN_ERROR:Your device has been banned for ${daysRemaining} days.`;
        } else {
          const monthsRemaining = Math.ceil(daysRemaining / 30);
          displayMessage = `DEVICE_BAN_ERROR:Your device has been banned for ${monthsRemaining === 1 ? '1 month' : `${monthsRemaining} months`}.`;
        }
        
        // Add reason on a new line
        displayMessage += `\nReason: ${banReason}`;
        
        // Add exact expiry date with better formatting
        displayMessage += `\nExpiry date: ${expirationDate.toLocaleDateString('en-US', { 
          weekday: 'long', 
          year: 'numeric', 
          month: 'long', 
          day: 'numeric' 
        })} at ${expirationDate.toLocaleTimeString('en-US', { 
          hour: '2-digit', 
          minute: '2-digit',
          timeZoneName: 'short'
        })}`;
      } else {
        displayMessage += `\n\nThis ban has expired. Please contact support if you're still unable to access the application.`;
      }
    } catch (error) {
      logger.warn('Error parsing ban expiry date:', error);
      displayMessage += `\n\nBan expiry information is available but could not be parsed.`;
    }
  } else {
    displayMessage += `\n\nThis is a permanent ban.`;
  }
  
  // Add contact information
  displayMessage += `\n\nIf you believe this is an error, please contact the administrator.`;
  
  return displayMessage;
}

// Helper function to clean device ban error message for display (removes internal marker)
function getCleanErrorMessage(error: string): string {
  if (error.startsWith('DEVICE_BAN_ERROR:')) {
    return error.replace('DEVICE_BAN_ERROR:', '');
  }
  return error;
}

// Helper function to check if error is a device ban error
function isDeviceBanError(error: string): boolean {
  return error.startsWith('DEVICE_BAN_ERROR:');
}

function shouldFallbackToRedirect(error: unknown): boolean {
  const code = String((error as any)?.code || '').toLowerCase();
  return (
    code === 'auth/popup-blocked' ||
    code === 'auth/operation-not-supported-in-this-environment'
  );
}

function isWebRedirectPreferred(): boolean {
  return (process.env.EXPO_PUBLIC_WEB_GOOGLE_AUTH_MODE || '').toLowerCase() === 'redirect';
}

function isLocalWebHost(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function setAuthRedirectPending(pending: boolean): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    if (pending) {
      window.sessionStorage.setItem('auth_redirect_in_flight', '1');
    } else {
      window.sessionStorage.removeItem('auth_redirect_in_flight');
    }
  } catch {
    // ignore storage failures
  }
}

// Sign in with Google
async function signInWithGoogle(): Promise<{ success: boolean; user?: AuthUser; error?: string }> {
  try {
    logger.debug('Starting Google sign in...');
    globalAuthState.loading = true;
    globalAuthState.error = null; // Clear any previous errors
    globalAuthState.authorizationErrorPending = false; // Clear authorization error flag
    notifyListeners();

    if (Platform.OS === 'web') {
      // Web platform - use Firebase built-in popup
      const provider = new GoogleAuthProvider();
      provider.addScope('email');
      provider.addScope('profile');

      if (isWebRedirectPreferred() && !isLocalWebHost()) {
        logger.debug('Web Google auth mode=redirect, starting redirect flow');
        setAuthRedirectPending(true);
        await signInWithRedirect(auth, provider);
        return {
          success: true,
        };
      } else if (isWebRedirectPreferred() && isLocalWebHost()) {
        logger.warn('Web Google auth mode=redirect requested on localhost; using popup flow for local stability');
      }

      let user: User;
      try {
        const result = await signInWithPopup(auth, provider);
        user = result.user;
      } catch (webSignInError) {
        if (shouldFallbackToRedirect(webSignInError)) {
          logger.warn('Popup sign-in unavailable on web; falling back to redirect', {
            code: (webSignInError as any)?.code,
          });
          setAuthRedirectPending(true);
          await signInWithRedirect(auth, provider);
          return {
            success: true,
          };
        }
        throw webSignInError;
      }

      if (!user || !user.email) {
        throw new Error('No user data received from Google');
      }

      logger.debug('🔐 Multi-tenant auth: granting access to any Google account', {
        email: user.email,
      });
      try {
        await loadAuthorizedEmails();
      } catch (loadError) {
        logger.warn('Failed to refresh authorized roster after web sign-in (non-blocking):', loadError);
      }

      let role: 'user' | 'admin' = 'user';
      try {
        role = await getUserRole(user.email);
      } catch (roleError) {
        logger.warn('Failed to resolve role during web sign-in, defaulting to user role:', roleError);
      }

      // Get user profile to fetch customImageURL
      const userProfile = await getUserProfile(user.email);
      const existingProfileDisplayName = sanitizeDisplayName(userProfile?.displayName);
      const resolvedDisplayName = resolvePreferredDisplayName({
        email: user.email,
        profileDisplayName: existingProfileDisplayName,
        authDisplayName: user.displayName,
      });
      const shouldBootstrapDisplayName =
        !existingProfileDisplayName ||
        (sanitizeDisplayName(user.displayName) &&
          isEmailPrefixFallbackDisplayName(existingProfileDisplayName, user.email));

      const authUser: AuthUser = {
        uid: user.uid,
        email: user.email,
        displayName: resolvedDisplayName,
        photoURL: user.photoURL || undefined,
        customImageURL: userProfile?.customImageURL || null,
        isAuthorized: true,
        role,
      };

      // Check if device is banned for this user (hardware fingerprint + user email check)
      logger.debug('🔍 Checking device ban status for user:', user.email);
  const deviceBanCheck = await getDeviceTrackingService().checkLoginDeviceBan(user.email);
      
      if (deviceBanCheck.banned) {
        logger.debug('🚫 Device is banned for user:', user.email, 'Ban reason:', deviceBanCheck.banInfo?.reason);
        
        // Sign out the user immediately
        await firebaseSignOut(auth);
        
        // Format the error message with comprehensive information
        const formattedBanMessage = formatDeviceBanMessage(deviceBanCheck.banInfo);
        
        // Set error state
        globalAuthState.error = formattedBanMessage;
        globalAuthState.loading = false;
        notifyListeners();
        
        return {
          success: false,
          user: authUser,
          error: formattedBanMessage,
        };
      }

      logger.debug('✅ Device ban check passed for user:', user.email);

      // Save/update user profile information safely with latest Google data
      logger.debug('📝 Updating user profile with latest Google data:', {
        email: user.email,
        displayName: resolvedDisplayName,
        photoURL: user.photoURL,
        fallbackDisplayName: fallbackDisplayNameFromEmail(user.email)
      });

  // Populate default photo in authorizedEmails if missing
  await ensureAuthorizedEmailHasPhoto(user.email, user.photoURL || null);
      
      await updateUsersCollectionOnly(user.email, {
        displayName: resolvedDisplayName,
        photoURL: user.photoURL || undefined,
      });
      
      await updateUserProfileSafe(user.email, {
        ...(shouldBootstrapDisplayName ? { displayName: resolvedDisplayName } : {}),
        isOnline: true,
        lastSeen: new Date().toISOString(),
      });

      await bootstrapGlobalAdminClaim(user);
      
      // Setup presence system for real-time online status
      setupPresenceSystem(user.email);

      return {
        success: true,
        user: authUser,
      };
    } else {
      // Mobile platform - use @react-native-google-signin/google-signin
      logger.debug('📱 Starting mobile Google Sign-In...');

      try {
        const webClientId = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '').trim();
        if (!webClientId) {
          throw new Error('Missing EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID for native Google Sign-In');
        }
        // Check if Google Play Services are available
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

        // Sign in to Google
        const userInfo = await GoogleSignin.signIn();
        let idToken = userInfo?.idToken;
        if (!idToken) {
          try {
            const tokens = await GoogleSignin.getTokens();
            idToken = tokens?.idToken;
          } catch (tokenError) {
            logger.warn('Google Sign-In tokens unavailable:', tokenError);
          }
        }

        if (!userInfo || !idToken) {
          throw new Error('No user data or ID token received from Google');
        }

        const userEmail = userInfo?.user?.email || null;
        logger.debug('📱 Google Sign-In successful:', userEmail || '(no email)');

        // Create Firebase credential and sign in
        const credential = GoogleAuthProvider.credential(idToken);
        const firebaseResult = await signInWithCredential(auth, credential);
        const user = firebaseResult.user;

        if (!user || !user.email) {
          throw new Error('No user data received from Firebase');
        }

        logger.debug('🔥 Firebase authentication successful:', user.email);

        logger.debug('🔐 Multi-tenant auth (mobile): granting access to any Google account', {
          email: user.email,
        });
        try {
          await loadAuthorizedEmails();
        } catch (loadError) {
          logger.warn('Failed to refresh authorized roster after mobile sign-in (non-blocking):', loadError);
        }

        let role: 'user' | 'admin' = 'user';
        try {
          role = await getUserRole(user.email);
        } catch (roleError) {
          logger.warn('Failed to resolve role during mobile sign-in, defaulting to user role:', roleError);
        }

        // Get user profile to fetch customImageURL
        const userProfile = await getUserProfile(user.email);
        const existingProfileDisplayName = sanitizeDisplayName(userProfile?.displayName);
        const resolvedDisplayName = resolvePreferredDisplayName({
          email: user.email,
          profileDisplayName: existingProfileDisplayName,
          authDisplayName: user.displayName,
        });
        const shouldBootstrapDisplayName =
          !existingProfileDisplayName ||
          (sanitizeDisplayName(user.displayName) &&
            isEmailPrefixFallbackDisplayName(existingProfileDisplayName, user.email));

        const authUser: AuthUser = {
          uid: user.uid,
          email: user.email,
          displayName: resolvedDisplayName,
          photoURL: user.photoURL || undefined,
          customImageURL: userProfile?.customImageURL || null,
          isAuthorized: true,
          role,
        };

        // Check if device is banned for this user (hardware fingerprint + user email check)
        logger.debug('🔍 Checking device ban status for user (mobile):', user.email);
  const deviceBanCheck = await getDeviceTrackingService().checkLoginDeviceBan(user.email);
        
        if (deviceBanCheck.banned) {
          logger.debug('🚫 Device is banned for user (mobile):', user.email, 'Ban reason:', deviceBanCheck.banInfo?.reason);
          
          // Sign out the user from both Google and Firebase immediately
          await GoogleSignin.signOut();
          await firebaseSignOut(auth);
          
          // Format the error message with comprehensive information
          const formattedBanMessage = formatDeviceBanMessage(deviceBanCheck.banInfo);
          
          // Set error state
          globalAuthState.error = formattedBanMessage;
          globalAuthState.loading = false;
          notifyListeners();
          
          return {
            success: false,
            user: authUser,
            error: formattedBanMessage,
          };
        }

        logger.debug('✅ Device ban check passed for user (mobile):', user.email);

        // Save/update user profile information safely with latest Google data
        logger.debug('📝 Updating user profile with latest Google data (mobile):', {
          email: user.email,
          displayName: resolvedDisplayName,
          photoURL: user.photoURL,
          fallbackDisplayName: fallbackDisplayNameFromEmail(user.email)
        });

  // Populate default photo in authorizedEmails if missing
  await ensureAuthorizedEmailHasPhoto(user.email, user.photoURL || null);
        
        await updateUsersCollectionOnly(user.email, {
          displayName: resolvedDisplayName,
          photoURL: user.photoURL || undefined,
        });
        
        await updateUserProfileSafe(user.email, {
          ...(shouldBootstrapDisplayName ? { displayName: resolvedDisplayName } : {}),
          isOnline: true,
          lastSeen: new Date().toISOString(),
        });

        await bootstrapGlobalAdminClaim(user);
        
        // Setup presence system for real-time online status
        setupPresenceSystem(user.email);

            // Update global auth state
            globalAuthState.user = authUser;
            clearReloginRequired();
            confirmRoleSyncTracking(authUser.role);
        globalAuthState.loading = false;
        globalAuthState.error = null;
        globalAuthState.isInitialized = true;
        globalAuthState.isOffline = false;
        notifyListeners();

        // Cache the user data for offline use (only for authorized users)
        await cacheUserData(authUser);

        logger.debug('✅ Mobile Google sign-in completed successfully:', user.email);

        return {
          success: true,
          user: authUser,
        };

      } catch (error: any) {
        logger.error('❌ Error during mobile Google Sign-In:', error);
        
        // Update global state with error
        globalAuthState.error = error.message || 'Mobile authentication failed';
        globalAuthState.loading = false;
        notifyListeners();
        
        // Handle specific error types
        if (error.code === 'statusCancelled') {
          return {
            success: false,
            error: 'Google sign-in was cancelled by user',
          };
        }
        
        throw error;
      }
    }
  } catch (error: any) {
    logger.error('Google sign in error:', error);
    
    globalAuthState.error = error.message || 'Google sign in failed';
    globalAuthState.loading = false;
    notifyListeners();
    return {
      success: false,
      error: error.message || 'Google sign in failed',
    };
  }
}

// Sign out
async function signOut(): Promise<void> {
  try {
    logger.debug('Starting sign out...');
    stopTokenRefreshTimer();
    
    // Log user logout before signing out
    if (globalAuthState.user?.email) {
      try {
  const deviceId = getDeviceTrackingService().getCurrentDeviceId();
        if (deviceId) {
          await getDeviceTrackingService().logUserLogout(globalAuthState.user.email, deviceId);
        }
      } catch (error) {
        logger.warn('Failed to log user logout:', error);
        // Continue with logout even if logging fails
      }
    }
    
    // Set user offline in presence before sign out
    if (globalAuthState.user?.email) {
      await setUserOnline(globalAuthState.user.email, false);
    }
    
    // Cleanup presence system (clear intervals and listeners)
    cleanupPresenceSystem();
    
    // Clear cached user data
    await cacheUserData(null);
    await clearAuthorizedEmailsCache();
    await clearUserScopedStorage();
    
    // Sign out from Google on mobile
    if (Platform.OS !== 'web') {
      try {
        await GoogleSignin.signOut();
        logger.debug('✅ Signed out from Google');
      } catch (error) {
        logger.warn('⚠️ Error signing out from Google:', error);
      }
    }
    
    // Clear current user
    globalAuthState.user = null;
    resetRoleSyncTracking();
    globalAuthState.loading = false;
    globalAuthState.error = null;
    notifyListeners();
    
    // Sign out from Firebase
    await firebaseSignOut(auth);
    
    // Clear any stored auth data
    await AsyncStorage.removeItem('userToken');

    // Clear relogin-required state after successful sign out
    clearReloginRequired();
    
    logger.debug('Sign out completed successfully');
  } catch (error: any) {
    logger.error('Sign out error:', error);
    globalAuthState.error = error.message || 'Sign out failed';
    notifyListeners();
    throw error;
  }
}

// Initialize auth state listener
function initializeAuth() {
  if (firebaseUnsubscribe) {
    return; // Already initialized
  }

  logger.debug('🚀 Initializing unified auth system...');

  if (Platform.OS === 'web') {
    void getRedirectResult(auth).catch((error) => {
      logger.error('Failed to process pending Google redirect result:', error);
      globalAuthState.error = error?.message || 'Google sign in failed';
      setAuthRedirectPending(false);
      notifyListeners();
    });

    // Fail-safe: clear pending redirect marker after a short delay if auth is still empty.
    try {
      const pending = window.sessionStorage.getItem('auth_redirect_in_flight') === '1';
      if (pending) {
        setTimeout(() => {
          if (!auth.currentUser) {
            setAuthRedirectPending(false);
          }
        }, 10_000);
      }
    } catch {
      // ignore
    }
  }

  // 1. Always load cached user immediately on startup
  (async () => {
    const cachedUser = await getCachedUserData();
    if (cachedUser) {
      logger.debug('✅ [Startup] Using cached user data:', cachedUser.email);
      globalAuthState.user = cachedUser;
      primeRoleSyncTracking(cachedUser.role);
      globalAuthState.loading = false;
      globalAuthState.isInitialized = true;
      globalAuthState.isOffline = false;
      globalAuthState.error = null;
      notifyListeners();
    } else {
      logger.debug('ℹ️ [Startup] No cached user data found.');
    }
  })();

  // IMMEDIATE offline check - this is crucial for page reloads
  const performImmediateOfflineCheck = async () => {
    try {
      // First, do a very quick check using navigator.onLine for web
      let quickOfflineCheck = false;
      if (Platform.OS === 'web') {
        quickOfflineCheck = !navigator.onLine;
        if (quickOfflineCheck) {
          logger.debug('🚨 IMMEDIATE: Navigator clearly indicates offline during page refresh');
          
          // Try to load cached user data immediately
          const cachedUser = await getCachedUserData();
          
          globalAuthState.user = cachedUser;
          if (cachedUser) {
            primeRoleSyncTracking(cachedUser.role);
          } else {
            resetRoleSyncTracking();
          }
          globalAuthState.loading = false;
          globalAuthState.isInitialized = true;
          globalAuthState.isOffline = true;
          globalAuthState.error = cachedUser ? null : 'Offline and no cached user data';
          notifyListeners();
          return; // Exit early - we know we're offline
        }
      }
      
      // If quick check didn't detect offline, do the full network check
      const isOnline = await checkNetworkStatus();
      logger.debug('🌐 Initial network status:', isOnline);
      
      globalAuthState.isOffline = !isOnline;

      if (!isOnline) {
        logger.debug('📱 Device is offline during initial check - checking for cached user data immediately');
        
        // Try to load cached user data
        const cachedUser = await getCachedUserData();
        
        if (cachedUser) {
          logger.debug('✅ Using cached user data for offline session:', cachedUser.email);
          globalAuthState.user = cachedUser;
          primeRoleSyncTracking(cachedUser.role);
          globalAuthState.error = null;
        } else {
          logger.debug('❌ No cached user data found and device is offline - will show offline page');
          globalAuthState.user = null;
          resetRoleSyncTracking();
          globalAuthState.error = 'Offline and no cached user data';
        }
        
        globalAuthState.loading = false;
        globalAuthState.isInitialized = true;
        globalAuthState.isOffline = true;
        notifyListeners();
        return; // Exit early for offline scenario
      } else {
        // If online, proceed with normal Firebase auth listener
        logger.debug('🌐 Device is online - will set up Firebase auth listener');
        globalAuthState.isOffline = false;
        notifyListeners();
      }
    } catch (error) {
      logger.error('Error in immediate offline check:', error);
      // If there's an error checking network status, assume offline for safety during page loads
      if (Platform.OS === 'web' && !navigator.onLine) {
        logger.debug('🚨 Error in network check + navigator offline = assuming offline');
        const cachedUser = await getCachedUserData();
        globalAuthState.user = cachedUser;
        if (cachedUser) {
          primeRoleSyncTracking(cachedUser.role);
        } else {
          resetRoleSyncTracking();
        }
        globalAuthState.loading = false;
        globalAuthState.isInitialized = true;
        globalAuthState.isOffline = true;
        globalAuthState.error = cachedUser ? null : 'Offline and no cached user data';
        notifyListeners();
        return;
      }
      
      // Otherwise assume offline and let the timeout handler deal with it
      globalAuthState.isOffline = true;
      globalAuthState.loading = false;
      globalAuthState.isInitialized = true;
      notifyListeners();
    }
  };

  // Run immediate check
  performImmediateOfflineCheck();

  // Set up Firebase auth listener (this will only work when online)
  firebaseUnsubscribe = onAuthStateChanged(auth, async (user) => {
    logger.debug('🔥 Firebase auth state changed:', user ? user.email : 'null');
    
    // Skip processing when offline only if there is no authenticated user.
    // During redirect return, transient offline detection can occur while user is valid.
    const isCurrentlyOnline = await checkNetworkStatus();
    if (!isCurrentlyOnline && !user) {
      logger.debug('🚫 Skipping auth state change processing - device is offline');
      return;
    }
    
    if (user) {
      setAuthRedirectPending(false);
      try {
        if (!user.email) {
          logger.warn('Auth state change missing email; forcing relogin');
          forceReloginRequired('auth.missing-email');
          return;
        }
        try {
          await user.getIdToken(true);
        } catch (tokenError) {
          logger.warn('Failed to force token refresh on auth state change', tokenError);
        }
        await bootstrapGlobalAdminClaim(user);
        startTokenRefreshTimer(user);
        logger.debug('🔐 Multi-tenant auth state change - granting access to authenticated user:', user.email);
        try {
          await loadAuthorizedEmails();
        } catch (loadError) {
          logger.warn('Failed to refresh authorized roster during auth state change (non-blocking):', loadError);
        }
        
        let role: 'user' | 'admin' = 'user';
        try {
          role = await getUserRole(user.email || '');
        } catch (roleError) {
          logger.warn('Failed to resolve role during auth state change, defaulting to user role:', roleError);
        }
        
        // Get user profile to fetch customImageURL
        const userProfile = await getUserProfile(user.email || '');
        const resolvedDisplayName = resolvePreferredDisplayName({
          email: user.email || '',
          profileDisplayName: userProfile?.displayName,
          authDisplayName: user.displayName,
        });
        
        const authUser: AuthUser = {
          uid: user.uid,
          email: user.email || '',
          displayName: resolvedDisplayName,
          photoURL: user.photoURL || undefined,
          customImageURL: userProfile?.customImageURL || null,
          isAuthorized: true,
          role,
        };

        // Check if device is banned for this user (after authorization check)
        logger.debug('🔍 Checking device ban status for user:', user.email);
        try {
          // Use comprehensive device ban check (same as device registration)
          const banCheck = await getDeviceTrackingService().checkLoginDeviceBan(user.email || '');
          
          if (banCheck.banned) {
            logger.debug('🚫 Device ban detected in auth state change, signing user out:', user.email);
            logger.debug('📋 Ban details:', banCheck.banInfo);
            
            // Clear any cached data for banned devices
            await cacheUserData(null);
            
            // Sign out banned user
            await firebaseSignOut(auth);
            
            // Format the error message with comprehensive information
            const formattedBanMessage = formatDeviceBanMessage(banCheck.banInfo);
            
            // Set error state for banned device with flag to preserve it
            globalAuthState.user = null;
            resetRoleSyncTracking();
            globalAuthState.loading = false;
            globalAuthState.error = formattedBanMessage;
            globalAuthState.isInitialized = true;
            globalAuthState.isOffline = false;
            globalAuthState.authorizationErrorPending = true; // Preserve error across auth state changes
            notifyListeners();
            
            logger.debug('🚫 Device ban error set in global state:', globalAuthState.error);
            
            // Clear the flag after a delay to ensure error persists
            setTimeout(() => {
              globalAuthState.authorizationErrorPending = false;
              notifyListeners();
            }, 1000);
            
            // Navigation is handled by the main layout
            return;
          }
          
          logger.debug('✅ Device ban check passed for user:', user.email);
        } catch (error) {
          logger.warn('⚠️ Failed to check device ban status, proceeding with caution:', error);
          // Don't block login on device ban check errors, but log for monitoring
        }

        
        // Cache the user data for offline use (only for authorized users)
        await cacheUserData(authUser);
        
        globalAuthState.user = authUser;
        clearReloginRequired();
        confirmRoleSyncTracking(authUser.role);
        globalAuthState.loading = false;
        globalAuthState.error = null;
        globalAuthState.isInitialized = true;
        globalAuthState.isOffline = false;
        
        // Setup presence system for authorized users and update profile with latest Google data
        if (authUser.email) {
          logger.debug('📝 Updating user profile with latest Google data:', {
            email: authUser.email,
            displayName: authUser.displayName,
            photoURL: authUser.photoURL,
            rawGoogleDisplayName: user.displayName
          });
          
          // Update users collection with Google profile data (for original photo backup)
          await updateUsersCollectionOnly(authUser.email, {
            displayName: authUser.displayName,
            photoURL: authUser.photoURL || undefined,
          });

          // Populate default photo in authorizedEmails if missing (auth state listener path)
          await ensureAuthorizedEmailHasPhoto(authUser.email, authUser.photoURL || null);
          
          // Update presence information (without photoURL to avoid overwriting toggle preference)
          await updateUserProfileSafe(authUser.email, {
            isOnline: true,
            lastSeen: new Date().toISOString(),
          });
          
          setupPresenceSystem(authUser.email);

          // Subscribe to role changes for this user and show notice when it changes (online only)
          try {
            if (roleListenerUnsubscribe) {
              roleListenerUnsubscribe();
              roleListenerUnsubscribe = null;
            }
            const roleMembershipQuery = query(
              collection(firestore, 'tenantMemberships'),
              where('email', '==', authUser.email.toLowerCase()),
              where('status', '==', 'active')
            );
            roleListenerUnsubscribe = onSnapshot(roleMembershipQuery, async (_snap) => {
              try {
                // PERF (P14): derive the role from the snapshot already delivered
                // here instead of issuing another getDocs for the identical query,
                // and refresh the shared cache so the presence heartbeat can reuse
                // this realtime-fresh value.
                const newRole = deriveRoleFromMembershipDocs(_snap.docs);
                setCachedUserRole(authUser.email, newRole);
                await applyAuthoritativeRoleUpdate(newRole);
              } catch (e) {
                logger.warn('Role change listener error:', e);
              }
            });
          } catch (e) {
            logger.warn('Failed to subscribe to role changes:', e);
          }
          
          // Update lastLogin timestamp for device tracking
          try {
            await getDeviceTrackingService().updateLastLogin(authUser.email);
            logger.debug('✅ Updated lastLogin timestamp for user:', authUser.email);
          } catch (error) {
            logger.warn('Failed to update lastLogin timestamp:', error);
            
            // Check if this is a device ban error
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('This device has been banned') || errorMessage.includes('banned')) {
              logger.debug('🚫 Device ban detected during lastLogin update, signing user out:', authUser.email);
              
              // Extract ban reason from error message
              const banReason = errorMessage.replace('This device has been banned. Reason: ', '').trim();
              
              // Clear any cached data for banned devices
              await cacheUserData(null);
              
              // Sign out banned user
              await firebaseSignOut(auth);
              
              // Set error state for banned device
              globalAuthState.user = null;
              resetRoleSyncTracking();
              globalAuthState.loading = false;
              globalAuthState.error = banReason;
              globalAuthState.isInitialized = true;
              globalAuthState.isOffline = false;
              globalAuthState.authorizationErrorPending = true; // Preserve error across auth state changes
              notifyListeners();
              
              // Clear the flag after a delay to ensure error persists
              setTimeout(() => {
                globalAuthState.authorizationErrorPending = false;
                notifyListeners();
              }, 1000);
              
              return; // Exit early to prevent further processing
            }
          }
        }
        
        notifyListeners();
        
        // Navigation is handled by the main layout, don't do it here
      } catch (error) {
        logger.error('Error processing auth state change:', error);
        globalAuthState.user = null;
        resetRoleSyncTracking();
        globalAuthState.loading = false;
        globalAuthState.error = 'Authentication error';
        globalAuthState.isInitialized = true;
        notifyListeners();
      }
    } else {
      // User signed out or auth state is null
      logger.debug('ℹ️ Firebase auth state is null');
      stopTokenRefreshTimer();
      // Cleanup role listener
      if (roleListenerUnsubscribe) {
        try { roleListenerUnsubscribe(); } catch {}
        roleListenerUnsubscribe = null;
      }
      
      // If we have an authorization error pending, don't interfere with it
      if (globalAuthState.authorizationErrorPending) {
        logger.debug('⚠️ Authorization error pending, preserving error state');
        return;
      }
      
      // For explicit sign-outs, we want to clear the user state
      // But for implicit state changes (like page refresh), we keep cached data
      logger.debug('ℹ️ Keeping cached user if present for offline support');
      return;
    }
  });

  idTokenUnsubscribe = onIdTokenChanged(auth, async (user) => {
    if (!user) return;
    logger.debug('🔄 Firebase ID token refreshed');
    reinitFirestoreListeners('id-token-changed');
    await revalidateAuthorizationOnReconnect(2, 300);
  });

  // Set initialization timeout - shorter for faster offline detection
  setTimeout(async () => {
    if (!globalAuthState.isInitialized) {
      logger.debug('⏰ Auth initialization timeout reached - checking offline status');
      
      try {
        const isOnline = await checkNetworkStatus();
        logger.debug('⏰ Timeout network check result:', isOnline);
        
        if (!isOnline) {
          logger.debug('⏰ Timeout: Device appears to be offline during initial load');
          const cachedUser = await getCachedUserData();
          
          globalAuthState.user = cachedUser;
          if (cachedUser) {
            primeRoleSyncTracking(cachedUser.role);
          } else {
            resetRoleSyncTracking();
          }
          globalAuthState.isOffline = true;
          globalAuthState.error = cachedUser ? null : 'Offline and no cached user data';
        } else {
          logger.debug('⏰ Timeout: Device is online but auth not initialized - connection might be slow');
          globalAuthState.isOffline = false;
          globalAuthState.error = 'Authentication timeout - slow connection';
        }
        
        globalAuthState.loading = false;
        globalAuthState.isInitialized = true;
        notifyListeners();
      } catch (error) {
        logger.error('Error in timeout handler:', error);
        // Assume offline for safety when there's an error during timeout
        const cachedUser = await getCachedUserData();
        globalAuthState.user = cachedUser;
        if (cachedUser) {
          primeRoleSyncTracking(cachedUser.role);
        } else {
          resetRoleSyncTracking();
        }
        globalAuthState.loading = false;
        globalAuthState.isInitialized = true;
        globalAuthState.isOffline = true;
        globalAuthState.error = cachedUser ? null : 'Offline and no cached user data';
        notifyListeners();
      }
    }
  }, 1000); // 1 second timeout for faster initial offline detection
}

// Team members functionality
function onTeamMembersChange(callback: (members: TeamMember[]) => void): () => void {
  teamMembersListeners.add(callback);
  
  // Set up Firestore listener if not already set up
  if (!teamMembersUnsubscribe) {
    const parseAnyTimestamp = (val: any): Date | null => {
      try {
        if (!val) return null;
        if (val && typeof val === 'object' && val._methodName === 'serverTimestamp') return new Date();
        if (val && typeof val === 'object' && typeof val.seconds === 'number') {
          return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
        }
        if (val && typeof val.toDate === 'function') return val.toDate();
        if (val instanceof Date) return val;
        if (typeof val === 'number' || typeof val === 'string') return new Date(val);
        return null;
      } catch {
        return null;
      }
    };

    const emitMembers = (
      memberships: any[],
      profilesByEmail: Map<string, any>,
      presenceByEmail: Map<string, any>
    ) => {
      const FIRESTORE_ONLINE_THRESHOLD_MIN = getPresenceThresholdMin();
      const members: TeamMember[] = memberships.map((membership) => {
        const email = String(membership.email || '').toLowerCase();
        const profile = profilesByEmail.get(email) || {};
        const presence = presenceByEmail.get(email) || {};

        const lastSeen = presence.lastSeen;
        let isOnline = false;
        if (PRESENCE_MODE === 'flag') {
          isOnline = presence.isOnline === true;
        } else {
          const parsedLastSeen = parseAnyTimestamp(lastSeen);
          if (parsedLastSeen) {
            const timeDiffMinutes = (Date.now() - parsedLastSeen.getTime()) / (1000 * 60);
            isOnline = timeDiffMinutes <= FIRESTORE_ONLINE_THRESHOLD_MIN;
          } else {
            isOnline = presence.isOnline ?? false;
          }
        }

        const fallbackName = fallbackDisplayNameFromEmail(email)
          .replace(/[._-]/g, ' ')
          .replace(/\b\w/g, (l: string) => l.toUpperCase());
        const nameSource =
          sanitizeDisplayName(profile.displayName) ||
          sanitizeDisplayName(membership.displayName) ||
          fallbackName;
        const tenantRole = String(membership.role || 'member').toLowerCase() as TenantMembershipRole;
        const role: 'user' | 'admin' = tenantRole === 'owner' || tenantRole === 'admin' ? 'admin' : 'user';

        return {
          id: email,
          name: String(nameSource),
          email,
          avatar: email.charAt(0).toUpperCase(),
          photoURL: profile.photoURL,
          customImageURL: profile.customImageURL,
          role,
          tenantRole,
          isOnline,
          lastSeen,
          typingTo: presence.typingTo?.toLowerCase() || presence.typingTo,
          school: profile.school,
          bio: profile.bio,
          phone: profile.phone,
          dateOfBirth: profile.dateOfBirth,
          salutation: profile.salutation,
          subjects: Array.isArray(profile.subjects) ? profile.subjects : undefined,
        };
      });

      members.sort((a, b) => {
        if (a.isOnline !== b.isOnline) {
          return a.isOnline ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      teamMembersListeners.forEach((listener) => listener(members));
    };

    const attach = async (context?: string) => {
      teamMembersUnsubscribe?.();

      const tenantId = await resolveTenantScopeForMembershipNotifications();
      if (!tenantId) {
        teamMembersListeners.forEach((listener) => listener([]));
        teamMembersUnsubscribe = null;
        return;
      }

      let memberships: any[] = [];
      let profilesByEmail = new Map<string, any>();
      let presenceByEmail = new Map<string, any>();

      const membershipsQuery = query(
        collection(firestore, 'tenantMemberships'),
        where('tenantId', '==', tenantId),
        where('status', '==', 'active')
      );
      const profilesQuery = query(
        collection(firestore, 'tenantProfiles'),
        where('tenantId', '==', tenantId)
      );
      const presenceQuery = query(
        collection(firestore, 'tenantPresence'),
        where('tenantId', '==', tenantId)
      );

      const membershipsUnsub = onSnapshot(membershipsQuery, (snapshot) => {
        memberships = snapshot.docs.map((docSnap) => ({ id: docSnap.id, ...(docSnap.data() as any) }));
        emitMembers(memberships, profilesByEmail, presenceByEmail);
      });

      const profilesUnsub = onSnapshot(profilesQuery, (snapshot) => {
        profilesByEmail = new Map(
          snapshot.docs
            .map((docSnap) => {
              const data = docSnap.data() as any;
              const email = String(data?.email || '').toLowerCase();
              return email ? [email, data] : null;
            })
            .filter(Boolean) as Array<[string, any]>
        );
        emitMembers(memberships, profilesByEmail, presenceByEmail);
      });

      const presenceUnsub = onSnapshot(presenceQuery, (snapshot) => {
        presenceByEmail = new Map(
          snapshot.docs
            .map((docSnap) => {
              const data = docSnap.data() as any;
              const email = String(data?.email || '').toLowerCase();
              return email ? [email, data] : null;
            })
            .filter(Boolean) as Array<[string, any]>
        );
        emitMembers(memberships, profilesByEmail, presenceByEmail);
      });

      teamMembersUnsubscribe = () => {
        membershipsUnsub();
        profilesUnsub();
        presenceUnsub();
      };

      if (context) {
        logger.debug('Team members listener reattached', { context });
      }
    };

    void attach('initial');

    if (!teamMembersReinitUnsub) {
      teamMembersReinitUnsub = registerFirestoreReinit?.(() => {
        void attach('reinit');
      }) || null;
    }
  }
  
  // Return unsubscribe function
  return () => {
    teamMembersListeners.delete(callback);
    
    if (teamMembersListeners.size === 0 && teamMembersUnsubscribe) {
      teamMembersUnsubscribe();
      teamMembersUnsubscribe = null;
      if (teamMembersReinitUnsub) {
        try {
          teamMembersReinitUnsub();
        } catch {}
        teamMembersReinitUnsub = null;
      }
    }
  };
}

// Force refresh team members
async function forceRefreshTeamMembers(): Promise<TeamMember[]> {
  try {
    const tenantId = await resolveTenantScopeForMembershipNotifications();
    if (!tenantId) return [];

    const [membershipSnap, profilesSnap, presenceSnap] = await Promise.all([
      getDocs(
        query(
          collection(firestore, 'tenantMemberships'),
          where('tenantId', '==', tenantId),
          where('status', '==', 'active')
        )
      ),
      getDocs(query(collection(firestore, 'tenantProfiles'), where('tenantId', '==', tenantId))),
      getDocs(query(collection(firestore, 'tenantPresence'), where('tenantId', '==', tenantId))),
    ]);

    const profilesByEmail = new Map<string, any>();
    profilesSnap.forEach((docSnap) => {
      const data = docSnap.data() as any;
      const email = String(data?.email || '').toLowerCase();
      if (email) profilesByEmail.set(email, data);
    });

    const presenceByEmail = new Map<string, any>();
    presenceSnap.forEach((docSnap) => {
      const data = docSnap.data() as any;
      const email = String(data?.email || '').toLowerCase();
      if (email) presenceByEmail.set(email, data);
    });

    const parseAnyTimestamp = (val: any): Date | null => {
      try {
        if (!val) return null;
        if (val && typeof val === 'object' && val._methodName === 'serverTimestamp') return new Date();
        if (val && typeof val === 'object' && typeof val.seconds === 'number') {
          return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
        }
        if (val && typeof val.toDate === 'function') return val.toDate();
        if (val instanceof Date) return val;
        if (typeof val === 'number' || typeof val === 'string') return new Date(val);
        return null;
      } catch {
        return null;
      }
    };

    const FIRESTORE_ONLINE_THRESHOLD_MIN = getPresenceThresholdMin();
    const members: TeamMember[] = membershipSnap.docs.map((docSnap) => {
      const membership = docSnap.data() as any;
      const email = String(membership?.email || '').toLowerCase();
      const profile = profilesByEmail.get(email) || {};
      const presence = presenceByEmail.get(email) || {};

      const lastSeen = presence.lastSeen;
      let isOnline = false;
      if (PRESENCE_MODE === 'flag') {
        isOnline = presence.isOnline === true;
      } else {
        const parsedLastSeen = parseAnyTimestamp(lastSeen);
        if (parsedLastSeen) {
          const diffMin = (Date.now() - parsedLastSeen.getTime()) / 60000;
          isOnline = diffMin <= FIRESTORE_ONLINE_THRESHOLD_MIN;
        } else {
          isOnline = presence.isOnline ?? false;
        }
      }

      const displayName =
        sanitizeDisplayName(profile.displayName) ||
        sanitizeDisplayName(membership.displayName) ||
        fallbackDisplayNameFromEmail(email)
          .replace(/[._-]/g, ' ')
          .replace(/\b\w/g, (l: string) => l.toUpperCase());

      const tenantRole = String(membership?.role || 'member').toLowerCase() as TenantMembershipRole;
      const role: 'user' | 'admin' = tenantRole === 'owner' || tenantRole === 'admin' ? 'admin' : 'user';

      return {
        id: email,
        name: displayName,
        email,
        avatar: email.charAt(0).toUpperCase(),
        photoURL: profile.photoURL,
        customImageURL: profile.customImageURL,
        role,
        tenantRole,
        isOnline,
        lastSeen,
        typingTo: presence.typingTo,
        school: profile.school,
        bio: profile.bio,
        phone: profile.phone,
        dateOfBirth: profile.dateOfBirth,
        salutation: profile.salutation,
        subjects: Array.isArray(profile.subjects) ? profile.subjects : undefined,
      };
    });
    
    // Sort by online status, then by name
    members.sort((a, b) => {
      if (a.isOnline !== b.isOnline) {
        return a.isOnline ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    
    // Notify all listeners
    teamMembersListeners.forEach(callback => callback(members));
    return members;
  } catch (error) {
    logger.error('❌ Error in forceRefreshTeamMembers:', error);
    return [];
  }
}

// Get current user (synchronous)
function getCurrentUser(): AuthUser | null {
  return globalAuthState.user;
}

// Get user profile data
async function getUserProfile(email: string): Promise<{
  email: string;
  displayName?: string;
  photoURL?: string;
  customImageURL?: string;
  role: 'user' | 'admin';
  isOnline?: boolean;
  lastSeen?: string;
  school?: string;
  bio?: string;
  phone?: string;
  dateOfBirth?: string;
  salutation?: 'Mr.' | 'Ms.';
  subjects?: string[];
} | null> {
  try {
    const normalizedEmail = email.toLowerCase();
    const fallbackDisplayName = fallbackDisplayNameFromEmail(normalizedEmail);
    const tenantId = (await tenantService.getCachedSelectedTenant()) || 'legacy-coaching';
    const profileDocId = `${tenantId}_${normalizedEmail.replace(/[@.]/g, '_')}`;

    let profileData: any = null;
    try {
      const profileSnap = await getDoc(doc(firestore, 'tenantProfiles', profileDocId));
      if (profileSnap.exists()) {
        profileData = profileSnap.data();
      }
    } catch (profileError) {
      logger.debug('No tenantProfiles document found for:', { email, tenantId, profileError });
    }

    let presenceData: any = null;
    try {
      const presenceSnap = await getDoc(doc(firestore, 'tenantPresence', profileDocId));
      if (presenceSnap.exists()) {
        presenceData = presenceSnap.data();
      }
    } catch {}

    if (profileData || presenceData) {
      const role = await getUserRole(normalizedEmail);
      return {
        email: normalizedEmail,
        displayName: sanitizeDisplayName(profileData?.displayName) || fallbackDisplayName,
        photoURL: profileData?.photoURL,
        customImageURL: profileData?.customImageURL,
        role,
        isOnline: presenceData?.isOnline || false,
        lastSeen: presenceData?.lastSeen,
        school: profileData?.school,
        bio: profileData?.bio,
        phone: profileData?.phone,
        dateOfBirth: profileData?.dateOfBirth,
        salutation: profileData?.salutation,
        subjects: Array.isArray(profileData?.subjects) ? profileData.subjects : undefined,
      };
    }

    // Fallback: Try to get user profile from the users collection by email.
    try {
      const usersByEmailQuery = query(
        collection(firestore, 'users'),
        where('email', '==', normalizedEmail),
        limit(1)
      );
      const usersByEmailSnap = await getDocs(usersByEmailQuery);
      const matchedDoc = usersByEmailSnap.docs[0];

      if (matchedDoc) {
        const data = matchedDoc.data();
        return {
          email: data.email || normalizedEmail,
          displayName: sanitizeDisplayName(data.displayName) || fallbackDisplayName,
          photoURL: data.photoURL,
          role: await getUserRole(normalizedEmail),
          isOnline: data.isOnline || false,
          lastSeen: data.lastSeen,
          school: data.school,
          bio: data.bio,
          phone: data.phone,
          dateOfBirth: data.dateOfBirth,
          salutation: data.salutation,
          subjects: Array.isArray(data.subjects) ? data.subjects : undefined,
        };
      }
    } catch (userError) {
      logger.debug('No user profile found in users collection');
    }
    
    // Final fallback: default role is user
    return {
      email: normalizedEmail,
      displayName: fallbackDisplayName,
      photoURL: undefined,
      role: 'user',
      isOnline: false,
      lastSeen: new Date().toISOString(),
      school: undefined,
      bio: undefined,
      phone: undefined,
    };
  } catch (error) {
    logger.error('Error getting user profile:', error);
    return null;
  }
}

// Get authorized emails
function getAuthorizedEmails(): string[] {
  return [...authorizedEmails];
}

// Clear authorized emails cache after revocation detection
async function clearAuthorizedEmailsCache(): Promise<void> {
  try {
    authorizedEmails = [];
    await AsyncStorage.removeItem(CACHED_AUTH_EMAILS_KEY);
    logger.debug('🧹 Cleared authorizedEmails cache');
  } catch (e) {
    logger.warn('Failed to clear authorizedEmails cache:', e);
  }
}

async function resolveTenantScopeForMembershipNotifications(): Promise<string | null> {
  try {
    const cachedTenantId = await tenantService.getCachedSelectedTenant();
    if (cachedTenantId?.trim()) {
      return cachedTenantId.trim();
    }
  } catch (error) {
    logger.warn('Failed to resolve cached tenant for membership notifications:', error);
  }
  logger.warn('No tenant scope available for membership notifications; skipping payload.');
  return null;
}

function triggerTeamMembershipNotification(payload: TeamMembershipChangePayload): void {
  const defaultInitiator: 'web' | 'mobile' = Platform.OS === 'web' ? 'web' : 'mobile';
  const actorNameFromState = globalAuthState.user?.displayName || globalAuthState.user?.email || undefined;
  const metadata = {
    ...payload.metadata,
    initiatedFrom: payload.metadata?.initiatedFrom ?? defaultInitiator,
    actorName: payload.metadata?.actorName ?? actorNameFromState,
  };

  void teamMembershipNotifier
  .notifyChange({ ...payload, metadata })
    .catch((error) => {
    logger.warn('Failed to notify team membership change:', error);
    });
}

// Server-mediated (security-rules-hardening C1): route the legacy "authorized
// email" admin membership mutations (role/status) through the backend, which now
// owns all `tenantMemberships` writes. The backend derives/verifies the caller's
// owner/admin authorization from the token, writes the audit trail, and emits the
// team-membership notifications. Clients can no longer write membership docs
// directly. This maps each matched membership doc (found by email) to its userId,
// which the backend endpoints key on, and only issues a call when the field
// actually changes to avoid redundant writes/notifications.
async function applyAuthorizedMembershipChangeViaBackend(
  tenantId: string,
  membershipDocs: Array<{ data: () => any }>,
  change: { role?: TenantMembershipRole; status?: 'active' | 'revoked' },
): Promise<void> {
  const initiatedFrom: 'web' | 'mobile' = Platform.OS === 'web' ? 'web' : 'mobile';
  const actorName = globalAuthState.user?.displayName || globalAuthState.user?.email || undefined;
  await Promise.all(
    membershipDocs.map(async (membershipDoc) => {
      const data = (membershipDoc.data() || {}) as any;
      const targetUserId = String(data?.userId || '').trim();
      if (!targetUserId) {
        return;
      }
      if (change.role && String(data?.role || '') !== change.role) {
        await tenantBackendClient.updateMembershipRole({
          tenantId,
          userId: targetUserId,
          role: change.role,
          metadata: { initiatedFrom, actorName, reason: 'authorized_email_admin' },
        });
      }
      if (change.status && String(data?.status || '') !== change.status) {
        await tenantBackendClient.updateMembershipStatus({
          tenantId,
          userId: targetUserId,
          status: change.status,
          metadata: { initiatedFrom, actorName, reason: 'authorized_email_admin' },
        });
      }
    }),
  );
}

// Add authorized email
async function addAuthorizedEmail(email: string, role: 'user' | 'admin' = 'user'): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  
  if (!authorizedEmails.includes(normalizedEmail)) {
    authorizedEmails.push(normalizedEmail);
  }

  try {
    const tenantId = await resolveTenantScopeForMembershipNotifications();
    if (!tenantId) {
      throw new Error('No tenant selected for adding member');
    }

    const displayName = normalizedEmail.split('@')[0]
      .replace(/[._-]/g, ' ')
      .replace(/\b\w/g, (l: string) => l.toUpperCase());
    const emailKey = sanitizeEmailKey(normalizedEmail);
    const now = new Date();
    const nextTenantRole: TenantMembershipRole = role === 'admin' ? 'admin' : 'member';

    await setDoc(
      doc(firestore, 'tenantProfiles', `${tenantId}_${emailKey}`),
      {
        tenantId,
        email: normalizedEmail,
        displayName,
        role: nextTenantRole,
        updatedAt: now,
      },
      { merge: true }
    );

    await setDoc(
      doc(firestore, 'tenantPresence', `${tenantId}_${emailKey}`),
      {
        tenantId,
        email: normalizedEmail,
        isOnline: false,
        lastSeen: now.toISOString(),
        typingTo: null,
        updatedAt: now,
      },
      { merge: true }
    );

    const membershipsQuery = query(
      collection(firestore, 'tenantMemberships'),
      where('tenantId', '==', tenantId),
      where('email', '==', normalizedEmail)
    );
    const membershipSnapshot = await getDocs(membershipsQuery);
    if (!membershipSnapshot.empty) {
      await applyAuthorizedMembershipChangeViaBackend(tenantId, membershipSnapshot.docs, {
        role: nextTenantRole,
        status: 'active',
      });
    }

    triggerTeamMembershipNotification({
      tenantId,
      action: 'added',
      targetEmail: normalizedEmail,
      targetRole: role,
      metadata: {
        displayName,
      },
    });
  } catch (error) {
    throw error;
  }
}

// Remove authorized email and force logout all user devices
async function removeAuthorizedEmail(email: string): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  const index = authorizedEmails.indexOf(normalizedEmail);
  const hadCachedEntry = index > -1;
  let removedRole: 'user' | 'admin' | undefined;
  let removedDisplayName: string | undefined;

  logger.debug(
    `🚫 Removing user ${normalizedEmail} from authorized list (cached=${hadCachedEntry}) and forcing logout`
  );

  // Resolve the tenant scope up front: the backend force-logout endpoint is
  // tenant-scoped, and the tenant-native store revocation below reuses the same
  // tenant id.
  let tenantId: string | null = null;
  try {
    tenantId = await resolveTenantScopeForMembershipNotifications();
  } catch (error) {
    logger.warn('Failed to resolve tenant scope during authorization removal:', error);
  }

  // Force logout all of the user's devices via the backend Device Admin API.
  // This requires a tenant; when none is available we skip it (with a warning)
  // rather than throw, so the removal itself still proceeds. Any backend failure
  // is logged and swallowed to preserve graceful degradation — the email removal
  // must still succeed even if the force-logout side effect no-ops.
  if (tenantId) {
    try {
      await getDeviceTrackingService().forceLogoutAllUserDevices(
        normalizedEmail,
        tenantId,
        'User removed from authorized list'
      );
    } catch (error) {
      logger.error('Failed to force logout user devices during authorization removal:', error);
      // Continue with removal even if logout fails
    }
  } else {
    logger.warn(
      'No tenant scope available; skipping backend force-logout during authorization removal.'
    );
  }

  if (hadCachedEntry) {
    authorizedEmails.splice(index, 1);
  }

  // Revoke from tenant-native stores
  try {
    if (!tenantId) {
      throw new Error('No tenant selected for member removal');
    }

    const emailKey = sanitizeEmailKey(normalizedEmail);

    const profileRef = doc(firestore, 'tenantProfiles', `${tenantId}_${emailKey}`);
    try {
      const profileSnap = await getDoc(profileRef);
      if (profileSnap.exists()) {
        const profileData = profileSnap.data() as any;
        removedDisplayName = typeof profileData?.displayName === 'string' ? profileData.displayName : undefined;
        const roleVal = String(profileData?.role || '').toLowerCase();
        removedRole = roleVal === 'owner' || roleVal === 'admin' ? 'admin' : 'user';
      }
    } catch {}

    const membershipsQuery = query(
      collection(firestore, 'tenantMemberships'),
      where('tenantId', '==', tenantId),
      where('email', '==', normalizedEmail)
    );
    const membershipSnapshot = await getDocs(membershipsQuery);
    await applyAuthorizedMembershipChangeViaBackend(tenantId, membershipSnapshot.docs, { status: 'revoked' });

    await Promise.allSettled([
      deleteDoc(doc(firestore, 'tenantPresence', `${tenantId}_${emailKey}`)),
      setDoc(profileRef, { isActive: false, updatedAt: new Date() }, { merge: true }),
    ]);

    if (hadCachedEntry) {
      try {
        await cacheAuthorizedEmails([...authorizedEmails]);
      } catch (cacheErr) {
        logger.warn('⚠️ Failed to update authorized emails cache after removal:', cacheErr);
      }
    }
    logger.debug(`✅ User ${normalizedEmail} successfully removed from tenant membership and logged out`);

    triggerTeamMembershipNotification({
      tenantId,
      action: 'removed',
      targetEmail: normalizedEmail,
      targetRole: removedRole,
      metadata: {
        displayName: removedDisplayName,
        reason: 'removed_from_tenant_membership',
      },
    });
  } catch (error) {
    throw error;
  }
}

// Update authorized emails
async function updateAuthorizedEmails(emails: string[]): Promise<void> {
  try {
    const normalizedTarget = Array.from(new Set(emails.map((email) => email.toLowerCase())));
    const existing = new Set(authorizedEmails.map((email) => email.toLowerCase()));
    const target = new Set(normalizedTarget);

    const toRemove = Array.from(existing).filter((email) => !target.has(email));
    const toAdd = normalizedTarget.filter((email) => !existing.has(email));

    for (const email of toRemove) {
      await removeAuthorizedEmail(email);
    }
    for (const email of toAdd) {
      await addAuthorizedEmail(email, 'user');
    }

    authorizedEmails = normalizedTarget;
    await cacheAuthorizedEmails(authorizedEmails);
    logger.debug(`Updated team roster email cache with ${authorizedEmails.length} emails`);
  } catch (error) {
    logger.error('Error updating authorized emails:', error);
    throw error;
  }
}

// Update typing status for a user
async function updateTypingStatus(email: string, typingTo: string | null): Promise<void> {
  try {
    const normalizedEmail = email.toLowerCase();
    const normalizedTypingTo = typingTo?.toLowerCase() || null;
    await updateTenantPresenceForUser(normalizedEmail, {
      isOnline: true,
      lastSeen: new Date().toISOString(),
      typingTo: normalizedTypingTo,
    });
  } catch (error) {
    logger.warn('❌ Failed to update typing status in tenantPresence:', error);
    
    // Fallback: keep in-memory profile sync path alive if tenantPresence update fails.
    try {
      await updateUserProfileSafe(email, {
        typingTo: typingTo?.toLowerCase() || null,
      });
    } catch (fallbackError) {
      logger.warn('❌ Failed to update typing status via fallback:', fallbackError);
    }
  }
}

// React hook for using the unified auth system
export function useAuth() {
  const [state, setState] = useState(globalAuthState);
  const isSubscribed = useRef(false);

  useEffect(() => {
    if (!isSubscribed.current) {
      // Initialize auth system on first use
      initializeAuth();
      
      // Subscribe to state changes with debugging
      const debugSetState = (newState: typeof globalAuthState) => {
        // (Removed verbose state change log)
        setState(newState);
      };
      
      authListeners.add(debugSetState);
      isSubscribed.current = true;
      
      // Set initial state
      setState({ ...globalAuthState });

      // IMMEDIATE offline check for faster detection - especially important for page reloads
      if (Platform.OS === 'web') {
        const immediateCheck = async () => {
          try {
            // Use navigator.onLine for instant detection on page refresh
            const navigatorOffline = !navigator.onLine;
            if (navigatorOffline) {
              logger.debug('🚀 useAuth immediate check - navigator clearly offline on page refresh');
              
              if (!globalAuthState.isInitialized) {
                logger.debug('🚀 useAuth: INSTANT offline detection triggered');
                const cachedUser = await getCachedUserData();
                
                globalAuthState.user = cachedUser;
                if (cachedUser) {
                  primeRoleSyncTracking(cachedUser.role);
                } else {
                  resetRoleSyncTracking();
                }
                globalAuthState.loading = false;
                globalAuthState.isOffline = true;
                globalAuthState.isInitialized = true;
                globalAuthState.error = cachedUser ? null : 'Offline and no cached user data';
                
                setState({ ...globalAuthState });
                notifyListeners();
                logger.debug('🚀 useAuth: INSTANT offline state set', {
                  user: cachedUser?.email,
                  isOffline: true,
                  isInitialized: true
                });
              }
            } else {
              logger.debug('🚀 useAuth immediate check - navigator says online, waiting for full check');
            }
          } catch (error) {
            logger.error('Error in useAuth immediate check:', error);
          }
        };
        
        // Run immediate check synchronously if possible
        if (!navigator.onLine) {
          logger.debug('🚨 INSTANT: Page refreshed while offline detected');
          immediateCheck();
        }

        // Set up network status listener to update auth state when connection is restored
        const setupNetworkListener = async () => {
          try {
            const NetInfo = require('@react-native-community/netinfo') as typeof import('@react-native-community/netinfo');
            const unsubscribe = NetInfo.default.addEventListener((state) => {
              const isOnline = (state.isConnected ?? false) && (state.isInternetReachable ?? false);
              logger.debug('🌐 useAuth: Network status changed to:', isOnline);
              
              if (isOnline && globalAuthState.isOffline) {
                logger.debug('🌐 useAuth: Connection restored, updating auth state to online');
                globalAuthState.isOffline = false;
                // Clear any offline-related errors
                if (globalAuthState.error === 'Offline and no cached user data') {
                  globalAuthState.error = null;
                }
                notifyListeners();
                
                // Kick off a prompt authorization revalidation with short backoff
                setTimeout(() => {
                  revalidateAuthorizationOnReconnect().catch(() => {});
                }, 300);

                // Re-initialize auth when connection is restored
                setTimeout(() => {
                  logger.debug('🔄 Re-initializing auth after connection restore');
                  // Reset initialization flag to allow auth to reinitialize
                  if (firebaseUnsubscribe) {
                    firebaseUnsubscribe();
                    firebaseUnsubscribe = null;
                  }
                  if (idTokenUnsubscribe) {
                    try {
                      idTokenUnsubscribe();
                    } catch {}
                    idTokenUnsubscribe = null;
                  }
                  stopTokenRefreshTimer();
                  globalAuthState.isInitialized = false;
                  initializeAuth();
                  
                  // After auth reinitializes, trigger navigation if we're on web
                  if (Platform.OS === 'web') {
                    setTimeout(() => {
                      // If we have an authorized user, trigger a state change to force navigation
                      if (globalAuthState.user && globalAuthState.user.isAuthorized) {
                        logger.debug('🔄 Triggering state update to force navigation after connection restore');
                        // Just notify listeners to trigger the navigation logic in _layout.tsx
                        notifyListeners();
                      }
                    }, 1500);
                  }
                }, 1000);
              }
            });
            
            // Clean up listener on unmount
            return () => {
              if (unsubscribe) {
                unsubscribe();
              }
            };
          } catch (error) {
            logger.error('Failed to set up network listener:', error);
            return () => {}; // Return empty cleanup function on error
          }
        };

        setupNetworkListener();
      }
    }

    return () => {
      if (isSubscribed.current) {
        authListeners.delete(setState);
        isSubscribed.current = false;
        if (idTokenUnsubscribe) {
          try {
            idTokenUnsubscribe();
          } catch {}
          idTokenUnsubscribe = null;
        }
      }
    };
  }, []);

  const clearError = useCallback(() => {
    globalAuthState.error = null;
    globalAuthState.authorizationErrorPending = false; // Also clear the flag when manually clearing error
    notifyListeners();
  }, []);

  return {
    user: state.user,
    loading: state.loading,
    error: state.error,
    isInitialized: state.isInitialized,
    isOffline: state.isOffline || false,
  roleChangeNotice: state.roleChangeNotice || null,
    reloginRequired: state.reloginRequired || false,
    signInWithGoogle,
    signOut,
    isAuthenticated: !!state.user,
    isAuthorized: state.user?.isAuthorized || false,
    clearError,
  };
}

// Export utility functions for other parts of the app
export const authService = {
  getCurrentUser,
  getUserProfile,
  getAuthorizedEmails,
  clearAuthorizedEmailsCache,
  addAuthorizedEmail,
  removeAuthorizedEmail,
  updateAuthorizedEmails,
  onTeamMembersChange,
  forceRefreshTeamMembers,
  signInWithGoogle,
  signOut,
  setUserOnline,
  updateUserProfileSafe,
  updateTypingStatus,
  getCleanErrorMessage,
  isDeviceBanError,
  flagReloginRequired,
  clearReloginRequired,
  registerFirestoreReinit,
};
