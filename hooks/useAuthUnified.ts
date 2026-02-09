import { logger } from '@/lib/logger';
import { STORAGE_KEYS } from '@/lib/storageKeys';
import { useState, useEffect, useCallback, useRef } from 'react';
import { auth, firestore } from '../config/firebase';
// For deleting custom profile pictures when removing a user
import { storage } from '../config/firebase';
import { ref as storageRef, deleteObject } from 'firebase/storage';
import { 
  signOut as firebaseSignOut,
  onAuthStateChanged,
  onIdTokenChanged,
  User,
  GoogleAuthProvider,
  signInWithPopup,
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
  where
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
import type { TenantMembershipRole } from '@/types';
// Lazy-load deviceTrackingService to avoid import cycles (typed)
type DeviceTrackingServiceType = typeof import('../services/deviceTrackingService').deviceTrackingService;
// Minimal contract for methods this file uses; narrows surface and allows future refactors
interface IDeviceTrackingServiceContract {
  checkLoginDeviceBan(userEmail: string): Promise<{ banned: boolean; banInfo?: any; errorMessage?: string }>;
  getCurrentDeviceId(): string | null;
  logUserLogout(userEmail: string, deviceId: string): Promise<void>;
  updateLastLogin(userEmail: string): Promise<void>;
  forceLogoutAllUserDevices(userEmail: string, reason: string): Promise<void>;
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
    // For web, check navigator.onLine first for immediate response
    if (Platform.OS === 'web') {
      const navigatorOnline = navigator.onLine;
      logger.debug('🌐 Navigator.onLine:', navigatorOnline);
      
      // If navigator says offline, double-check with a small test
      if (!navigatorOnline) {
        logger.debug('🌐 Navigator says offline, double-checking...');
        return false;
      }
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
    
    // Only include fields that are provided
    if (profileData.displayName) updateData.displayName = profileData.displayName;
    if (profileData.photoURL) updateData.photoURL = profileData.photoURL;
    if (profileData.customImageURL !== undefined) {
      if (profileData.customImageURL) {
        updateData.customImageURL = profileData.customImageURL;
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
    // Only log 10% of presence updates to reduce noise, but always log profile updates
    const shouldLog = !profileData.isOnline || profileData.displayName || profileData.photoURL || profileData.customImageURL || Math.random() < 0.1;
    if (shouldLog) {
      logger.debug('🔄 Safely updating user profile:', { email, profileData });
    }
    
    const normalizedEmail = email.toLowerCase();
    
    // Try to update user profile in the authorizedEmails collection first (primary source)
    try {
      const docId = normalizedEmail.replace(/[@.]/g, '_');
      const authDocRef = doc(firestore, 'authorizedEmails', docId);
      const existingAuth = await getDoc(authDocRef);
      if (!existingAuth.exists()) {
        if (shouldLog) logger.debug('⛔ Skipping authorizedEmails update; doc missing (revoked user):', normalizedEmail);
        throw new Error('AUTH_DOC_MISSING');
      }
      const authUpdateData: any = { email: normalizedEmail, updatedAt: new Date() };
      if (profileData.isOnline !== undefined) authUpdateData.isOnline = profileData.isOnline;
      if (profileData.lastSeen) authUpdateData.lastSeen = profileData.lastSeen;
      if (profileData.displayName) authUpdateData.displayName = profileData.displayName;
      if (profileData.photoURL) authUpdateData.photoURL = profileData.photoURL;
      if (profileData.customImageURL !== undefined) authUpdateData.customImageURL = profileData.customImageURL ? profileData.customImageURL : deleteField();
      if (profileData.typingTo !== undefined) authUpdateData.typingTo = profileData.typingTo;
      if (profileData.school !== undefined) authUpdateData.school = profileData.school;
      if (profileData.bio !== undefined) authUpdateData.bio = profileData.bio;
      if (profileData.phone !== undefined) authUpdateData.phone = profileData.phone;
      if (profileData.dateOfBirth !== undefined) authUpdateData.dateOfBirth = profileData.dateOfBirth;
      if (profileData.salutation !== undefined) authUpdateData.salutation = profileData.salutation;
      if (profileData.subjects !== undefined) authUpdateData.subjects = profileData.subjects;
      await setDoc(authDocRef, authUpdateData, { merge: true });
      if (shouldLog) logger.debug('✅ User profile update (existing doc) in authorizedEmails');
    } catch (authError) {
      const errorMessage = authError instanceof Error ? authError.message : String(authError);
      const errorCode = (authError as any)?.code || '';
      
      // Check for permission errors more robustly
      const isPermissionError = errorMessage.includes('Missing or insufficient permissions') || 
                               errorMessage.includes('insufficient permissions') ||
                               errorMessage.includes('permission-denied') ||
                               errorCode === 'permission-denied';
      const isMissingAuthDoc = errorMessage === 'AUTH_DOC_MISSING';
      
      if (isPermissionError) {
        flagReloginRequired('updateUserProfileSafe.authorizedEmails', authError);
      }
      if (!isPermissionError && !isMissingAuthDoc && shouldLog) {
        logger.warn('⚠️ AuthorizedEmails update failed, trying users collection:', authError);
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
        if (profileData.displayName) updateData.displayName = profileData.displayName;
        if (profileData.photoURL) updateData.photoURL = profileData.photoURL;
        if (profileData.customImageURL !== undefined) {
          if (profileData.customImageURL) {
            updateData.customImageURL = profileData.customImageURL;
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
  if (shouldLog && !isMissingAuthDoc) logger.debug('✅ User profile update successful in users collection (fallback)');
  if (shouldLog && isMissingAuthDoc) logger.debug('ℹ️ User profile updated only in users collection (revoked user)');
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
    if ((profileData.displayName || profileData.photoURL) && shouldLog) {
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

// Mirror role under UID in a dedicated collection for security rules (isAdmin by UID)
async function ensureUidRoleMirror(email: string, role: 'user' | 'admin'): Promise<void> {
  try {
    const current = auth.currentUser;
    if (!current || !current.uid) return;
  const uidRef = doc(firestore, 'authorizedUsersByUid', current.uid);
    await setDoc(uidRef, {
      email: email.toLowerCase(),
      role,
      updatedAt: new Date(),
    }, { merge: true });
  } catch (e) {
    logger.warn('ensureUidRoleMirror failed:', e);
  }
}

// Ensure newly authorized user doc gets a default Google photo if missing
async function ensureAuthorizedEmailHasPhoto(email: string, googlePhotoURL?: string | null): Promise<void> {
  try {
    if (!googlePhotoURL) return; // Nothing to set
    const normalized = email.toLowerCase();
    const docId = normalized.replace(/[@.]/g, '_');
    const ref = doc(firestore, 'authorizedEmails', docId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return; // Doc must already exist (admin pre-created)
    const data = snap.data();
    // Only set if neither photoURL nor customImageURL is present (first-time population)
    if (!data.photoURL && !data.customImageURL) {
      await setDoc(ref, { photoURL: googlePhotoURL, updatedAt: new Date() }, { merge: true });
      logger.debug('🖼️ Set default Google photoURL in authorizedEmails for', normalized);
    }
  } catch (e) {
    logger.warn('Failed to ensure authorizedEmails default photoURL:', e);
  }
}

// Remove any UID-role mirror docs for a given email (cleanup when revoking access)
async function deleteUidRoleMirrorsByEmail(email: string): Promise<void> {
  try {
    const normalized = email.toLowerCase();
    const colRef = collection(firestore, 'authorizedUsersByUid');
    const q = query(colRef, where('email', '==', normalized));
    const snap = await getDocs(q);
    const deletions: Promise<void>[] = [];
    snap.forEach((docSnap) => {
      deletions.push(deleteDoc(doc(firestore, 'authorizedUsersByUid', docSnap.id)));
    });
    if (deletions.length) {
      await Promise.allSettled(deletions);
      logger.debug(`🧹 Removed ${deletions.length} mirror doc(s) from authorizedUsersByUid for`, normalized);
    }
  } catch (e) {
    logger.warn('Failed to delete UID role mirrors for', email, e);
  }
}

// Update any UID-role mirror docs for a given email to a new role (when role changes)
async function updateUidRoleMirrorsByEmail(email: string, role: 'user' | 'admin'): Promise<void> {
  try {
    const normalized = email.toLowerCase();
    const colRef = collection(firestore, 'authorizedUsersByUid');
    const q = query(colRef, where('email', '==', normalized));
    const snap = await getDocs(q);
    const updates: Promise<void>[] = [];
    snap.forEach((docSnap) => {
      updates.push(updateDoc(doc(firestore, 'authorizedUsersByUid', docSnap.id), {
        role,
        updatedAt: new Date(),
      }));
    });
    if (updates.length) {
      await Promise.allSettled(updates);
      logger.debug(`🔄 Updated ${updates.length} mirror doc(s) in authorizedUsersByUid for`, normalized, 'to role', role);
    }
  } catch (e) {
    logger.warn('Failed to update UID role mirrors for', email, e);
  }
}

// Change role in authorizedEmails and sync UID mirror; does not force logout
async function changeAuthorizedEmailRole(email: string, newRole: 'user' | 'admin'): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  const authorizedRef = collection(firestore, 'authorizedEmails');
  const docId = normalizedEmail.replace(/[@.]/g, '_');
  const docRef = doc(authorizedRef, docId);
  const existingSnap = await getDoc(docRef);
  const previousData = existingSnap.exists() ? existingSnap.data() : null;
  const previousRole = (previousData?.role ?? null) as 'user' | 'admin' | null;

  // Update role in primary collection
  await setDoc(docRef, { role: newRole, updatedAt: new Date() }, { merge: true });
  // Update any existing UID mirrors for currently signed-in sessions
  await updateUidRoleMirrorsByEmail(normalizedEmail, newRole);

  if (previousRole && previousRole !== newRole) {
    const tenantId = await resolveTenantScopeForMembershipNotifications();
    if (!tenantId) {
      logger.warn('Skipped team membership notification for role change: tenantId unavailable');
    } else {
      triggerTeamMembershipNotification({
        tenantId,
        action: 'role_changed',
        targetEmail: normalizedEmail,
        targetRole: newRole,
        previousRole,
        metadata: {
          reason: 'role_updated',
        },
      });
    }
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
    
    await updateUserProfileSafe(email, {
      isOnline,
  lastSeen: undefined,
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
  
  // Update presence every 30 seconds for better real-time experience
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
            const docId = userEmail.toLowerCase().replace(/[@.]/g, '_');
            const ref = doc(firestore, 'authorizedEmails', docId);
            const snap = await getDoc(ref);
            if (snap.exists()) {
              const newRole = (snap.data()?.role || 'user') as 'user' | 'admin';
              await applyAuthoritativeRoleUpdate(newRole, { requireOnlineCheck: false });
            }
          } catch (e) {
            // Silent: heartbeat is best-effort
          }
        })();
      }
    } else {
      logger.debug('❌ Presence interval mismatch - cleaning up for:', userEmail, 'Current auth user:', globalAuthState.user?.email, 'Current presence user:', currentPresenceUser);
      cleanupPresenceSystem();
    }
  }, 30000); // 30 seconds for better real-time presence
  
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
    logger.debug('🔄 Loading authorized emails - checking preconditions...');
    
    const isOnline = await checkNetworkStatus();
    
    if (!isOnline) {
      // Use cached emails when offline
      logger.debug('📱 Loading authorized emails from cache (offline)');
      authorizedEmails = await getCachedAuthorizedEmails();
      return;
    }

    // Check if user is authenticated before making Firestore calls
    if (!auth.currentUser) {
      logger.debug('🔐 No authenticated user, loading authorized emails from cache only');
      authorizedEmails = await getCachedAuthorizedEmails();
      return;
    }

    logger.debug('✅ User authenticated, proceeding with Firestore query for authorized emails');

    // Try to load from Firestore collection when online and authenticated
    const authCollection = collection(firestore, 'authorizedEmails');
    
    try {
      let querySnapshot;
      try {
        querySnapshot = await getDocsFromServer(authCollection);
      } catch (serverError: any) {
        logger.warn('⚠️ getDocsFromServer failed (likely offline/slow). Falling back to cache:', serverError);
        querySnapshot = await getDocs(authCollection);
        if (querySnapshot.metadata.fromCache) {
          logger.debug('📦 Authorized emails query served from local cache. Treating as non-authoritative.');
          // Use cached values instead of replacing with potentially empty snapshot.
          const cached = await getCachedAuthorizedEmails();
          if (cached.length > 0) {
            authorizedEmails = cached;
            return;
          }
        }
      }

      if (querySnapshot.metadata.fromCache && !querySnapshot.metadata.hasPendingWrites) {
        logger.debug('📦 Authorized emails snapshot from cache; will not treat as authoritative.');
      }

      const emails: string[] = [];
      // Strict: only include docs that have both a valid email and a valid role
      querySnapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && typeof data.email === 'string') {
          const roleVal = data.role;
          if (roleVal === 'user' || roleVal === 'admin') {
            emails.push(data.email.toLowerCase());
          } else {
            logger.debug('⛔ Skipping authorizedEmails doc missing valid role:', docSnap.id, 'email:', data.email);
          }
        } else {
          logger.debug('⛔ Skipping authorizedEmails doc missing email field:', docSnap.id);
        }
      });
      if (querySnapshot.metadata.fromCache && emails.length === 0) {
        logger.warn('⚠️ Authorized emails snapshot empty due to cache; preserving previous authorized list.');
        const cached = await getCachedAuthorizedEmails();
        authorizedEmails = cached;
        return;
      }

      authorizedEmails = emails;
      await cacheAuthorizedEmails(emails);
      logger.debug('✅ Loaded authorized emails from Firestore (valid w/ role):', emails.length);
    } catch (error) {
      logger.warn('⚠️ Failed to load authorized emails, using cache:', error);
      // Fallback to cached emails only
      authorizedEmails = await getCachedAuthorizedEmails();
    }
  } catch (error) {
    logger.warn('⚠️ Unexpected error loading authorized emails, using cache:', error);
    authorizedEmails = await getCachedAuthorizedEmails();
  }
}

// Get user role
async function getUserRole(email: string): Promise<'user' | 'admin'> {
  try {
    const normalizedEmail = email.toLowerCase();
    
    // If not authenticated, use fallback logic
    if (!auth.currentUser) {
      logger.debug('🔐 No authenticated user, using fallback role logic');
      return 'user'; // Default to user role when not authenticated
    }
    
    // Try to get the role from the authorizedEmails collection
    const docId = normalizedEmail.replace(/[@.]/g, '_');
    const authDocRef = doc(firestore, 'authorizedEmails', docId);
    
    try {
      const authDocSnap = await getDoc(authDocRef);
      if (authDocSnap.exists()) {
        const authData = authDocSnap.data();
        if (authData.role) {
          logger.debug(`📋 Found role for ${email}: ${authData.role}`);
          return authData.role;
        }
      }
    } catch (firestoreError) {
      logger.warn('⚠️ Firestore permission error getting user role:', firestoreError);
      // Fall back to default logic
    }
    
    // Default to 'user' role for authorized users
    return 'user';
  } catch (error) {
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

      const result = await signInWithPopup(auth, provider);
      const user = result.user;

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
        await ensureUidRoleMirror(user.email, role);
      } catch (roleError) {
        logger.warn('Failed to resolve role during web sign-in, defaulting to user role:', roleError);
      }

      // Get user profile to fetch customImageURL
      const userProfile = await getUserProfile(user.email);

      const authUser: AuthUser = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || user.email.split('@')[0], // Use Google display name or fallback to email prefix
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
        displayName: user.displayName,
        photoURL: user.photoURL,
        fallbackDisplayName: user.displayName || user.email.split('@')[0]
      });

  // Populate default photo in authorizedEmails if missing
  await ensureAuthorizedEmailHasPhoto(user.email, user.photoURL || null);
      
      await updateUsersCollectionOnly(user.email, {
        displayName: user.displayName || user.email.split('@')[0],
        photoURL: user.photoURL || undefined,
      });
      
      await updateUserProfileSafe(user.email, {
        displayName: user.displayName || user.email.split('@')[0], // Always provide a meaningful display name
        isOnline: true,
        lastSeen: new Date().toISOString(),
      });
      
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
        // Check if Google Play Services are available
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

        // Sign in to Google
        const userInfo = await GoogleSignin.signIn();

        if (!userInfo || !userInfo.idToken) {
          throw new Error('No user data or ID token received from Google');
        }

        logger.debug('📱 Google Sign-In successful:', userInfo.user.email);

        // Create Firebase credential and sign in
        const credential = GoogleAuthProvider.credential(userInfo.idToken);
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
          await ensureUidRoleMirror(user.email, role);
        } catch (roleError) {
          logger.warn('Failed to resolve role during mobile sign-in, defaulting to user role:', roleError);
        }

        // Get user profile to fetch customImageURL
        const userProfile = await getUserProfile(user.email);

        const authUser: AuthUser = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || user.email.split('@')[0], // Use Google display name or fallback to email prefix
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
          displayName: user.displayName,
          photoURL: user.photoURL,
          fallbackDisplayName: user.displayName || user.email.split('@')[0]
        });

  // Populate default photo in authorizedEmails if missing
  await ensureAuthorizedEmailHasPhoto(user.email, user.photoURL || null);
        
        await updateUsersCollectionOnly(user.email, {
          displayName: user.displayName || user.email.split('@')[0],
          photoURL: user.photoURL || undefined,
        });
        
        await updateUserProfileSafe(user.email, {
          displayName: user.displayName || user.email.split('@')[0], // Always provide a meaningful display name
          isOnline: true,
          lastSeen: new Date().toISOString(),
        });
        
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
    
    // Skip processing if we're offline
    const isCurrentlyOnline = await checkNetworkStatus();
    if (!isCurrentlyOnline) {
      logger.debug('🚫 Skipping auth state change processing - device is offline');
      return;
    }
    
    if (user) {
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
          await ensureUidRoleMirror(user.email || '', role);
        } catch (roleError) {
          logger.warn('Failed to resolve role during auth state change, defaulting to user role:', roleError);
        }
        
        // Get user profile to fetch customImageURL
        const userProfile = await getUserProfile(user.email || '');
        
        const authUser: AuthUser = {
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || (user.email ? user.email.split('@')[0] : ''), // Use Google display name or fallback
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
            const roleDocId = authUser.email.toLowerCase().replace(/[@.]/g, '_');
            const roleDocRef = doc(firestore, 'authorizedEmails', roleDocId);
            roleListenerUnsubscribe = onSnapshot(roleDocRef, async (snap) => {
              try {
                if (!snap.exists()) return;
                const data = snap.data();
                const newRole = (data?.role || 'user') as 'user' | 'admin';
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
    const authorizedRef = collection(firestore, 'authorizedEmails');
    const attach = (context?: string) => {
      teamMembersUnsubscribe?.();
      teamMembersUnsubscribe = onSnapshot(authorizedRef, async (snapshot) => {
        try {
          const members: TeamMember[] = [];
          snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            if (data && data.email) {
              const name = data.displayName || data.email.split('@')[0]
                .replace(/[._-]/g, ' ')
                .replace(/\b\w/g, (l: string) => l.toUpperCase());
              
              // Presence derivation: by env mode (last_seen vs flag)
              const lastSeen = data.lastSeen;
              const FIRESTORE_ONLINE_THRESHOLD_MIN = getPresenceThresholdMin();

              // Robust timestamp parsing (supports ISO string, number, Date, Firestore Timestamp-like objects)
              const parseAnyTimestamp = (val: any): Date | null => {
                try {
                  if (!val) return null;
                  // Firestore server timestamp sentinel (unresolved) – treat as now
                  if (val && typeof val === 'object' && val._methodName === 'serverTimestamp')
                    return new Date();
                  // Firestore Timestamp shape { seconds, nanoseconds }
                  if (val && typeof val === 'object' && typeof val.seconds === 'number')
                    return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
                  // Actual Timestamp with toDate()
                  if (val && typeof val.toDate === 'function') return val.toDate();
                  if (val instanceof Date) return val;
                  if (typeof val === 'number' || typeof val === 'string') return new Date(val);
                  return null;
                } catch {
                  return null;
                }
              };

              // Compute online status based on configured mode
              let isOnline = false;
              if (PRESENCE_MODE === 'flag') {
                isOnline = data.isOnline === true;
              } else {
                const parsedLastSeen = parseAnyTimestamp(lastSeen);
                if (parsedLastSeen) {
                  const now = new Date();
                  const timeDiffMinutes = (now.getTime() - parsedLastSeen.getTime()) / (1000 * 60);
                  isOnline = timeDiffMinutes <= FIRESTORE_ONLINE_THRESHOLD_MIN;
                  if (!isOnline && (data.isOnline === true)) {
                    // (Removed verbose derived offline discrepancy debug log)
                  }
                } else {
                  // No usable lastSeen; trust stored flag as a fallback
                  isOnline = data.isOnline ?? false;
                }
              }
              
              // (Removed admin user presence debug log)
              
              members.push({
                id: data.email.toLowerCase(),
                name,
                email: data.email.toLowerCase(),
                avatar: data.email.charAt(0).toUpperCase(),
                photoURL: data.photoURL,
                customImageURL: data.customImageURL,
                role: data.role || 'user',
                isOnline: isOnline,
                lastSeen: lastSeen,
                typingTo: data.typingTo?.toLowerCase() || data.typingTo,
                school: data.school,
                bio: data.bio,
                phone: data.phone,
                dateOfBirth: data.dateOfBirth,
                salutation: data.salutation,
                subjects: Array.isArray(data.subjects) ? data.subjects : undefined,
              });
            }
          });
          
          members.sort((a, b) => {
            if (a.isOnline !== b.isOnline) {
              return a.isOnline ? -1 : 1;
            }
            return a.name.localeCompare(b.name);
          });
          
          teamMembersListeners.forEach((listener) => {
            listener(members);
          });
        } catch (error) {
          logger.error('Error in team members listener:', error);
        }
      });

      if (context) {
        logger.debug('Team members listener reattached', { context });
      }
    };

    attach('initial');

    if (!teamMembersReinitUnsub) {
      teamMembersReinitUnsub = registerFirestoreReinit?.(() => attach('reinit')) || null;
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
    const authorizedRef = collection(firestore, 'authorizedEmails');
    const snapshot = await getDocs(authorizedRef);
    
    const members: TeamMember[] = [];
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.email) {
        const name = data.displayName || data.email.split('@')[0]
          .replace(/[._-]/g, ' ')
          .replace(/\b\w/g, (l: string) => l.toUpperCase());
        
  // Presence derivation consistent with listener, controlled by env
  const lastSeen = data.lastSeen;
  const FIRESTORE_ONLINE_THRESHOLD_MIN = getPresenceThresholdMin();
        const parseAnyTimestamp = (val: any): Date | null => {
          try {
            if (!val) return null;
            if (val && typeof val === 'object' && val._methodName === 'serverTimestamp') return new Date();
            if (val && typeof val === 'object' && typeof val.seconds === 'number') return new Date(val.seconds * 1000 + Math.floor((val.nanoseconds || 0) / 1e6));
            if (val && typeof val.toDate === 'function') return val.toDate();
            if (val instanceof Date) return val;
            if (typeof val === 'number' || typeof val === 'string') return new Date(val);
            return null;
          } catch { return null; }
        };
        let isOnline = false;
        if (PRESENCE_MODE === 'flag') {
          isOnline = data.isOnline === true;
        } else {
          const parsedLastSeen = parseAnyTimestamp(lastSeen);
          if (parsedLastSeen) {
            const diffMin = (Date.now() - parsedLastSeen.getTime()) / 60000;
            isOnline = diffMin <= FIRESTORE_ONLINE_THRESHOLD_MIN;
          } else {
            isOnline = data.isOnline ?? false;
          }
        }
        
        members.push({
          id: data.email,
          name,
          email: data.email,
          avatar: data.email.charAt(0).toUpperCase(),
          photoURL: data.photoURL,
          customImageURL: data.customImageURL,
          role: data.role || 'user',
          isOnline: isOnline,
          lastSeen: lastSeen,
          typingTo: data.typingTo,
          school: data.school,
          bio: data.bio,
          phone: data.phone,
          dateOfBirth: data.dateOfBirth,
          salutation: data.salutation,
          subjects: Array.isArray(data.subjects) ? data.subjects : undefined,
        });
      }
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
    const docId = normalizedEmail.replace(/[@.]/g, '_');
    
    // Get user profile from the authorizedEmails collection first (this has the most up-to-date role info)
    const authDocRef = doc(firestore, 'authorizedEmails', docId);
    
    try {
      const authDocSnap = await getDoc(authDocRef);
      if (authDocSnap.exists()) {
        const authData = authDocSnap.data();
        return {
          email: authData.email || normalizedEmail,
          displayName: authData.displayName || email.split('@')[0],
          photoURL: authData.photoURL,
          customImageURL: authData.customImageURL,
          role: authData.role || 'user',
          isOnline: authData.isOnline || false,
          lastSeen: authData.lastSeen,
          school: authData.school,
          bio: authData.bio,
          phone: authData.phone,
          dateOfBirth: authData.dateOfBirth,
          salutation: authData.salutation,
          subjects: Array.isArray(authData.subjects) ? authData.subjects : undefined,
        };
      }
    } catch (authError) {
      logger.debug('No authorizedEmails document found for:', email);
    }
    
  // Fallback: Try to get user profile from the users collection (if it exists)
    const userRef = doc(firestore, 'users', auth.currentUser?.uid || 'unknown');
    
    try {
      const docSnap = await getDoc(userRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        return {
          email: data.email || normalizedEmail,
          displayName: data.displayName || email.split('@')[0],
          photoURL: data.photoURL,
          role: 'user',
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
      displayName: email.split('@')[0],
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

// Add authorized email
async function addAuthorizedEmail(email: string, role: 'user' | 'admin' = 'user'): Promise<void> {
  const normalizedEmail = email.toLowerCase();
  
  if (!authorizedEmails.includes(normalizedEmail)) {
    authorizedEmails.push(normalizedEmail);
  }
  
  // Save the email with role and complete profile fields directly in authorizedEmails collection
  try {
    const authorizedRef = collection(firestore, 'authorizedEmails');
    const docId = normalizedEmail.replace(/[@.]/g, '_');
    const docRef = doc(authorizedRef, docId);
    
    // Generate a display name from email
    const displayName = normalizedEmail.split('@')[0]
      .replace(/[._-]/g, ' ')
      .replace(/\b\w/g, (l: string) => l.toUpperCase());
    
    const currentTime = new Date();
    
    // Use the provided role only; no email-based overrides
    const finalRole = role;
    const addedByEmail = globalAuthState.user?.email || auth.currentUser?.email || null;
    
    await setDoc(docRef, {
      email: normalizedEmail,
      isActive: true,
      addedAt: currentTime,
      role: finalRole,
      displayName: displayName,
      isOnline: false, // Default to offline when first added
      photoURL: '', // Empty initially, will be filled when user signs in
      updatedAt: currentTime,
      ...(addedByEmail ? { addedBy: addedByEmail } : {}),
    });
    
    logger.debug(`Added authorized email ${normalizedEmail} with role: ${finalRole}`);

    const tenantId = await resolveTenantScopeForMembershipNotifications();
    if (!tenantId) {
      logger.warn('Skipped team membership notification for authorized email add: tenantId unavailable');
    } else {
      triggerTeamMembershipNotification({
        tenantId,
        action: 'added',
        targetEmail: normalizedEmail,
        targetRole: finalRole,
        metadata: {
          displayName,
        },
      });
    }
    
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

  // Always attempt to force logout devices, even if the cache entry is missing
  try {
    await getDeviceTrackingService().forceLogoutAllUserDevices(
      normalizedEmail,
      'User removed from authorized list'
    );
  } catch (error) {
    logger.error('Failed to force logout user devices during authorization removal:', error);
    // Continue with removal even if logout fails
  }

  if (hadCachedEntry) {
    authorizedEmails.splice(index, 1);
  }

  // Remove from Firestore (but first attempt to delete any stored custom profile image)
  try {
    const authorizedRef = collection(firestore, 'authorizedEmails');
    const docId = normalizedEmail.replace(/[@.]/g, '_');
    const docRef = doc(authorizedRef, docId);
    let customImageURL: string | undefined;

    // Fetch existing doc to inspect customImageURL before deleting
    try {
      const existing = await getDoc(docRef);
      if (existing.exists()) {
        const data = existing.data() as any;
        customImageURL = data?.customImageURL as string | undefined;
        if (typeof data?.role === 'string') {
          removedRole = data.role;
        }
        if (typeof data?.displayName === 'string') {
          removedDisplayName = data.displayName;
        }
      } else if (!hadCachedEntry) {
        logger.warn('⚠️ No authorizedEmails doc found during removal, but continuing:', normalizedEmail);
      }
    } catch (e) {
      logger.warn('⚠️ Could not fetch user doc before deletion (continuing):', e);
    }

    // Attempt to delete stored profile picture if present and not embedded base64
    try {
      const sanitizedForPath = normalizedEmail.replace(/[^a-zA-Z0-9]/g, '_');
      const deterministicPath = `profile-pictures/${sanitizedForPath}.jpg`;

      const attempted: string[] = [];
      const maybeTargets: string[] = [];

      if (customImageURL && typeof customImageURL === 'string') {
        if (!customImageURL.startsWith('data:')) {
          // If it's already a storage URL/path, try deleting via that first
          maybeTargets.push(customImageURL);
        } else {
          // It's an embedded data URL; no storage object referenced explicitly.
          // We'll still attempt deterministic path deletion in case an older upload exists.
          logger.debug(
            'ℹ️ customImageURL is an inline data URL; will try deterministic storage path cleanup.'
          );
        }
      }
      // Always attempt deterministic path as fallback (idempotent if object not found)
      if (!maybeTargets.includes(deterministicPath)) maybeTargets.push(deterministicPath);

      for (const target of maybeTargets) {
        try {
          const fileRef = storageRef(storage, target);
          await deleteObject(fileRef);
          attempted.push(target);
          logger.debug('🧹 Deleted profile picture from storage:', target);
          // Don't break; continue to try other possible paths to ensure full cleanup
        } catch (delErr: any) {
          // Ignore not-found errors; log others
          const msg = (delErr && delErr.message) || '';
          if (msg.includes('object-not-found')) {
            continue;
          }
          logger.warn('⚠️ Failed deleting potential profile picture path:', target, delErr);
        }
      }
      if (attempted.length === 0) {
        logger.debug('ℹ️ No stored profile picture objects were deleted (none found or only inline data URL).');
      }
    } catch (storageCleanupErr) {
      logger.warn('⚠️ Error during profile picture storage cleanup (continuing):', storageCleanupErr);
    }
    
    await deleteDoc(docRef);
    // Also remove any UID mirror entries for this email (admin revocation cleanup)
    await deleteUidRoleMirrorsByEmail(normalizedEmail);
    if (hadCachedEntry) {
      try {
        await cacheAuthorizedEmails([...authorizedEmails]);
      } catch (cacheErr) {
        logger.warn('⚠️ Failed to update authorized emails cache after removal:', cacheErr);
      }
    }
    logger.debug(`✅ User ${normalizedEmail} successfully removed from authorization and logged out`);

    const tenantId = await resolveTenantScopeForMembershipNotifications();
    if (!tenantId) {
      logger.warn('Skipped team membership notification for authorized email removal: tenantId unavailable');
    } else {
      triggerTeamMembershipNotification({
        tenantId,
        action: 'removed',
        targetEmail: normalizedEmail,
        targetRole: removedRole,
        metadata: {
          displayName: removedDisplayName,
          reason: 'removed_from_authorized_list',
        },
      });
    }
  } catch (error) {
    throw error;
  }
}

// Update authorized emails
async function updateAuthorizedEmails(emails: string[]): Promise<void> {
  try {
    // Clear existing emails and add new ones
    authorizedEmails = emails.map(email => email.toLowerCase());
    
    // Save each email to Firestore with complete profile fields
    const authorizedRef = collection(firestore, 'authorizedEmails');
    
    for (const email of authorizedEmails) {
      const docId = email.replace(/[@.]/g, '_');
      const docRef = doc(authorizedRef, docId);
      
      // Check if document already exists to preserve existing data
      const existingDoc = await getDoc(docRef);
      const existingData = existingDoc.exists() ? existingDoc.data() : {};
      
      // Determine role: preserve existing role if present; otherwise default to 'user'
      let role = existingData.role;
      if (!role) {
        role = 'user';
      }
      
      // Generate display name if not already present
      const displayName = existingData.displayName || email.split('@')[0]
        .replace(/[._-]/g, ' ')
        .replace(/\b\w/g, (l: string) => l.toUpperCase());
      
      const currentTime = new Date();
      const timeString = currentTime.toISOString();
      
      await setDoc(docRef, { 
        email: email,
        isActive: true,
        addedAt: existingData.addedAt || currentTime,
        role: role,
        displayName: displayName,
        isOnline: existingData.isOnline || false,
        lastSeen: existingData.lastSeen || timeString,
        photoURL: existingData.photoURL || '',
        updatedAt: currentTime
      });
    }
    
    logger.debug(`Updated authorized emails list with ${emails.length} emails`);
  } catch (error) {
    logger.error('Error updating authorized emails:', error);
    throw error;
  }
}

// Update user profile (deprecated - use updateUserProfileSafe instead)
async function updateUserProfile(email: string, profileData: {
  displayName?: string;
  photoURL?: string;
  customImageURL?: string;
  isOnline?: boolean;
  lastSeen?: string;
  typingTo?: string | null;
}): Promise<void> {
  try {
    const normalizedEmail = email.toLowerCase();
    const docId = normalizedEmail.replace(/[@.]/g, '_');
    const authorizedRef = collection(firestore, 'authorizedEmails');
    const docRef = doc(authorizedRef, docId);
    
    // Get existing data
    const existingDoc = await getDoc(docRef);
    const existingData = existingDoc.exists() ? existingDoc.data() : {};
    
    // Update with new profile data
    await setDoc(docRef, {
      ...existingData,
      ...profileData,
      email: normalizedEmail,
      isActive: true,
      updatedAt: new Date(),
    }, { merge: true });
    
    // Only log 10% of the time to reduce noise
    if (Math.random() < 0.1) {
      logger.debug(`Updated profile for ${email}`);
    }
  } catch (error) {
    // Handle permission errors silently
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorCode = (error as any)?.code || '';
    
    // Check for permission errors more robustly
    const isPermissionError = errorMessage.includes('Missing or insufficient permissions') || 
                             errorMessage.includes('insufficient permissions') ||
                             errorCode === 'permission-denied';
    
    if (isPermissionError) {
      flagReloginRequired('updateUserProfile', error);
    }
    if (!isPermissionError) {
      // Only log 10% of non-permission errors to reduce noise
      if (Math.random() < 0.1) {
        logger.error('Error updating user profile:', error);
      }
    }
    // Don't throw - this is used by other parts of the app that shouldn't fail
  }
}

// Get all authorized users with their profile information
async function getAuthorizedUsersWithProfiles(): Promise<Array<{
  email: string;
  displayName: string;
  photoURL?: string;
  role: 'user' | 'admin';
  isOnline?: boolean;
  lastSeen?: string;
}>> {
  try {
    const authorizedRef = collection(firestore, 'authorizedEmails');
    const snapshot = await getDocs(authorizedRef);
    
    const users: Array<{
      email: string;
      displayName: string;
      photoURL?: string;
      role: 'user' | 'admin';
      isOnline?: boolean;
      lastSeen?: string;
    }> = [];
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data && data.email) {
        users.push({
          email: data.email,
          displayName: data.displayName || data.email.split('@')[0],
          photoURL: data.photoURL,
          role: data.role || 'user',
          isOnline: data.isOnline,
          lastSeen: data.lastSeen,
        });
      }
    });
    
    return users;
  } catch (error) {
    logger.warn('Failed to fetch user profiles:', error);
    // Fallback to basic email list
    return authorizedEmails.map(email => ({
      email,
      displayName: email.split('@')[0],
  role: 'user' as const,
    }));
  }
}

// Update typing status for a user in authorizedEmails collection
async function updateTypingStatus(email: string, typingTo: string | null): Promise<void> {
  try {
    const normalizedEmail = email.toLowerCase();
    const normalizedTypingTo = typingTo?.toLowerCase() || null;
    const docId = normalizedEmail.replace(/[@.]/g, '_');
    const authDocRef = doc(firestore, 'authorizedEmails', docId);
    
    // Update the typing status directly in authorizedEmails collection
    await updateDoc(authDocRef, {
      typingTo: normalizedTypingTo,
      updatedAt: new Date(),
    });
  } catch (error) {
    logger.warn('❌ Failed to update typing status in authorizedEmails:', error);
    
    // Fallback to the old method if direct update fails
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
  updateUserProfile,
  onTeamMembersChange,
  forceRefreshTeamMembers,
  changeAuthorizedEmailRole,
  signInWithGoogle,
  signOut,
  setUserOnline,
  updateUserProfileSafe,
  getAuthorizedUsersWithProfiles,
  updateTypingStatus,
  getCleanErrorMessage,
  isDeviceBanError,
  flagReloginRequired,
  clearReloginRequired,
  registerFirestoreReinit,
};
