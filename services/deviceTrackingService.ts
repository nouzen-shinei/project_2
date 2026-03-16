import { logger } from '@/lib/logger';
import { resolveExpoProjectId } from '@/lib/expoProjectId';
import { resolveNotificationChannelId } from '@/lib/notificationChannels';
import { tenantService } from './tenantService';
import type { TenantMembershipRole, TenantMembershipStatus } from '@/types';
import { authService } from '../hooks/useAuthUnified';
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { runtimeEndpoints } from './runtimeEndpoints';
// Lazy-load notificationService to avoid import cycle (typed)
type NotificationServiceType = typeof import('./notificationService').notificationService;
// Contract interface (subset) to decouple compile-time dependency
export interface INotificationService {
  sendLocalNotification(notification: { title: string; body: string; data?: any }): Promise<void>;
}
let __notificationService: (NotificationServiceType & INotificationService) | null = null;
function getNotificationService(): NotificationServiceType & INotificationService {
  if (!__notificationService) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./notificationService');
  __notificationService = mod.notificationService as NotificationServiceType & INotificationService;
  }
  return __notificationService;
}
import { getDatabase, ref, push, onValue, remove } from 'firebase/database';
import { 
  doc, 
  setDoc, 
  getDoc, 
  updateDoc, 
  deleteField,
  deleteDoc,
  serverTimestamp, 
  onSnapshot, 
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  Timestamp,
  addDoc
} from 'firebase/firestore';
import { firestore } from '../config/firebase';
import * as Device from 'expo-device';
import { Platform, Dimensions } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Network from 'expo-network';
import * as Application from 'expo-application';
import * as Constants from 'expo-constants';
import * as Localization from 'expo-localization';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { getRecordingPermissionsAsync as getAudioRecordingPermissionsAsync } from 'expo-audio';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DeviceInfo from 'react-native-device-info';
import SHA256 from 'crypto-js/sha256';

export interface DeviceAction {
  id: string;
  actionType: 'deleted' | 'restored' | 'logout' | 'login' | 'forced_logout';
  deviceId: string;
  userId: string;
  adminEmail?: string;
  adminName?: string;
  reason?: string;
  timestamp: Timestamp | Date;
  deviceData?: Partial<UserDevice>;
}

export interface DeviceBan {
  id: string;
  banType: 'soft' | 'hard';
  deviceFingerprint: string;
  bannedFields: {
    userAgent?: string;
    manufacturer?: string;
    modelName?: string;
    modelId?: string;
    hardwareConcurrency?: number;
    totalMemory?: number;
    screenWidth?: number;
    screenHeight?: number;
    supportedCpuArchitectures?: string[];
    jsHeapSizeLimit?: number;
    platform?: string;
    vendor?: string;
  };
  reason: string;
  adminEmail: string;
  adminName: string;
  targetDeviceId?: string;
  targetUserEmail?: string;
  isActive: boolean;
  createdAt: Timestamp | Date;
  expiresAt?: Timestamp | Date;
  lastChecked?: Timestamp | Date;
}

type TenantMembershipSummary = {
  tenantId: string;
  role: TenantMembershipRole;
  status: TenantMembershipStatus;
};

export type DeviceTenantFilterOptions = {
  tenantId?: string | null;
  includeUntagged?: boolean;
};

type DevicePingType = 'register' | 'heartbeat' | 'full';

export interface UserDevice {
  // Basic device identification
  deviceId: string;
  deviceIdSource?: 'stable_seed' | 'fingerprint_fallback' | 'unknown';
  deviceSeedHash?: string;
  fallbackFingerprintHash?: string;
  deviceType: 'mobile' | 'web' | 'tablet';
  deviceName: string;
  
  // Platform information
  platformOS: string;
  platformVersion: string | number;
  
  // App information
  appVersion: string;
  nativeAppVersion?: string;
  nativeBuildVersion?: string;
  expoVersion?: string;
  
  // Device hardware details
  brand?: string;
  manufacturer?: string;
  modelName?: string;
  modelId?: string;
  designName?: string;
  productName?: string;
  
  // Device specifications
  totalMemory?: number; // RAM in bytes
  supportedCpuArchitectures?: string[];
  
  // System information
  osName?: string;
  osVersion?: string;
  osBuildId?: string;
  
  // Network & Location
  ipAddress?: string;
  networkType?: string; // wifi, cellular, ethernet, etc.
  carrierName?: string;
  countryCode?: string;
  timezone?: string;
  locale?: string;
  
  // Screen information
  screenWidth?: number;
  screenHeight?: number;
  screenScale?: number;
  
  // Notification tokens
  expoPushToken?: string;
  pushTokenStatus?: 'synced' | 'missing' | 'requested' | 'unknown';
  needsExpoPushTokenRefresh?: boolean;
  lastPushTokenSyncAt?: Timestamp | Date;
  lastPushTokenErrorAt?: Timestamp | Date;
  fcmToken?: string;
  webPushSubscription?: {
    endpoint: string;
    expirationTime?: number | null;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
  webPushStatus?: 'subscribed' | 'unsubscribed' | 'unsupported' | 'permission_denied' | 'sync_required' | 'error';
  webPushVapidPublicKey?: string;
  webPushSubscribedAt?: Timestamp | Date;
  webPushLastSyncedAt?: Timestamp | Date;
  webPushLastErrorAt?: Timestamp | Date;
  webPushLastErrorCode?: string;
  webPushClientLastSubscriptionSyncAt?: Timestamp | Date;
  webPushClientLastSubscriptionContext?: string;
  webPushClientLastSubscriptionPermission?: string;
  webPushClientLastReceiptAt?: Timestamp | Date;
  webPushClientLastReceiptType?: string;
  webPushClientLastReceiptNotificationId?: string;
  webPushClientLastReceiptTag?: string;
  webPushClientLastReceiptTitle?: string;

  // Notification preferences synced from client toggles
  notificationsEnabled?: boolean;
  chatNotificationsEnabled?: boolean;
  dailyQuotesEnabled?: boolean;
  noticeNotificationsEnabled?: boolean;
  teamNotificationsEnabled?: boolean;
  
  // Browser information (web only)
  userAgent?: string;
  browserName?: string;
  browserVersion?: string;
  cookieEnabled?: boolean;
  javaEnabled?: boolean;
  language?: string;
  languages?: string;
  onLine?: boolean;
  doNotTrack?: string | null;
  viewportWidth?: number;
  viewportHeight?: number;
  colorDepth?: number;
  pixelDepth?: number;
  platform?: string;
  vendor?: string;
  connectionType?: string;
  downlink?: number;
  hardwareConcurrency?: number;
  jsHeapSizeLimit?: number;
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
  touchSupport?: boolean;
  maxTouchPoints?: number;
  
  // Web source tracking
  currentUrl?: string;
  referrer?: string;
  hostname?: string;
  pathname?: string;
  search?: string;
  hash?: string;
  protocol?: string;
  port?: string;
  origin?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  
  // Status and timestamps
  lastSeen: Timestamp | Date;
  isOnline: boolean;
  sessionActive?: boolean;
  createdAt: Timestamp | Date;
  updatedAt: Timestamp | Date;
  lastLogin?: Timestamp | Date; // When user last logged in through Google auth
  
  // Device management status
  isDeleted?: boolean;
  deletedAt?: Timestamp | Date;
  deletedBy?: string;
  deletedByName?: string;
  deletionReason?: string;
  isRestored?: boolean;
  restoredAt?: Timestamp | Date;
  
  // Force logout tracking
  forcedLogoutBy?: string;
  forcedLogoutByName?: string;
  forcedLogoutAt?: Timestamp | Date;
  forcedLogoutReason?: string;
  
  // Manual logout tracking
  manualLogoutAt?: Timestamp | Date;
  logoutType?: 'manual' | 'forced' | 'auto';
  
  // Ban information
  isHardBanned?: boolean;
  banInfo?: DeviceBan;
  
  // Session information
  sessionId?: string;
  lastActivityType?: string;
  lastTenantPingAt?: Timestamp | Date;
  lastHeartbeatId?: string; // Debug field to track heartbeat updates
  
  // Storage Information
  freeStorage?: number; // Available storage space in bytes
  totalStorage?: number; // Total storage capacity in bytes
  usedStorage?: number; // Used storage space in bytes
  storagePercentageUsed?: number; // 0-100
  
  // Device Orientation & Motion
  currentOrientation?: string; // Current device orientation
  orientationLocked?: boolean; // Whether orientation is locked
  orientationAngle?: number; // Screen orientation angle (web)
  orientationChangeSupported?: boolean; // Orientation change support (web)
  motionSupport?: boolean; // Device motion API support
  
  // Enhanced Web Capabilities
  webGLSupport?: boolean; // WebGL support status
  webGL2Support?: boolean; // WebGL2 support status
  webRTCSupport?: boolean; // WebRTC support status
  webAssemblySupport?: boolean; // WebAssembly support status
  serviceWorkerSupport?: boolean; // Service worker support
  localStorageSupport?: boolean; // Local storage support
  sessionStorageSupport?: boolean; // Session storage support
  indexedDBSupport?: boolean; // IndexedDB support
  webSocketsSupport?: boolean; // WebSocket support
  geolocationSupport?: boolean; // Geolocation API support
  deviceMotionSupport?: boolean; // DeviceMotionEvent support
  deviceOrientationSupport?: boolean; // DeviceOrientationEvent support
  pushNotificationsSupport?: boolean; // Push API support
  webShareSupport?: boolean; // Web Share API support
  mediaDevicesSupport?: boolean; // MediaDevices/getUserMedia support
  webBluetoothSupport?: boolean; // Web Bluetooth API support
  webUSBSupport?: boolean; // WebUSB API support
  webNFCSupport?: boolean; // Web NFC API support
  
  // Device Permissions
  locationPermission?: string; // Location permission status
  notificationPermission?: string; // Notification permission status
  cameraPermission?: string; // Camera permission status
  microphonePermission?: string; // Microphone permission status

  // Active chat session state
  activeChatPartner?: string;
  activeChatPartnerId?: string;
  activeChatPartnerName?: string;
  activeChatIsFocused?: boolean;
  activeChatLastSeenAt?: Timestamp | Date;
  activeChatLastMessageId?: string;
  activeChatLastMessageTimestamp?: Timestamp | Date;

  // Tenant tagging metadata
  tenantIds?: string[];
  tenantMemberships?: TenantMembershipSummary[];
  activeTenantId?: string | null;
}

export interface AuthorizedUser {
  email: string;
  role: 'user' | 'admin';
  displayName?: string;
  devices: UserDevice[];
  isOnline: boolean;
  totalDevices: number;
  tenantIds?: string[];
}

export interface DeviceNotificationAttemptResult {
  delivered: boolean;
  deliverySource: 'presence' | 'push' | 'unknown';
  pushChannel?: 'web_push' | 'mobile_push';
}

export interface DeviceNotificationFanoutResult {
  success: number;
  failed: number;
  deliverableDeviceCount: number;
  onlineDeliverableCount: number;
  presenceDeliveredCount: number;
  pushAcceptedCount: number;
  mobilePushAcceptedCount: number;
  webPushAcceptedCount: number;
  staleWebPushSubscriptionsCleaned: number;
  deduplicatedWebPushSubscriptionsCleaned: number;
}

class DeviceTrackingService {
  private currentDeviceId: string | null = null;
  private currentDeviceIdSource: 'stable_seed' | 'fingerprint_fallback' | 'unknown' = 'unknown';
  private currentDeviceSeedHash: string | null = null;
  private pushTokenRefreshReinitUnsub: (() => void) | null = null;
  private currentUserEmail: string | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeListeners: (() => void)[] = [];
  private readonly DEVICE_ID_KEY_PREFIX = 'device_id_'; // Will be suffixed with user hash
  private readonly DEVICE_SEED_KEY = 'device_seed_v1';
  private readonly DEVICE_ID_SOURCE_KEY_SUFFIX = '_source';
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly OFFLINE_THRESHOLD = 120000; // 2 minutes
  private lastKnownExpoPushToken: string | null = null;
  private pushTokenRefreshInFlight = false;
  private hasPushTokenRefreshMonitor = false;
  private webPushSyncInFlight: Promise<void> | null = null;
  private lastKnownNotificationsEnabled = true;
  private webPushDiagnosticsSyncInFlight: Promise<void> | null = null;
  private tenantMetadataCache: {
    userId: string;
    fetchedAt: number;
    tenantIds: string[];
    membershipSummaries: TenantMembershipSummary[];
    activeTenantId: string | null;
  } | null = null;
  private tenantAuthorizedEmailsCache: {
    tenantId: string;
    fetchedAt: number;
    emails: string[];
  } | null = null;
  private backendApiBaseUrl?: string;
  private devicePingWarnedMissingBackend = false;

  /**
   * Create a resolved timestamp (for immediate use)
   */
  private createResolvedTimestamp(): Timestamp {
    return Timestamp.fromDate(new Date());
  }

  private async getTenantMetadataForTagging(): Promise<{
    tenantIds: string[];
    membershipSummaries: TenantMembershipSummary[];
    activeTenantId: string | null;
  }> {
    const authUser = authService.getCurrentUser();
    if (!authUser?.uid) {
      return { tenantIds: [], membershipSummaries: [], activeTenantId: null };
    }

    const now = Date.now();
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    if (
      this.tenantMetadataCache &&
      this.tenantMetadataCache.userId === authUser.uid &&
      now - this.tenantMetadataCache.fetchedAt < CACHE_TTL_MS
    ) {
      const { tenantIds, membershipSummaries, activeTenantId } = this.tenantMetadataCache;
      return { tenantIds, membershipSummaries, activeTenantId };
    }

    try {
      let memberships = await tenantService.getCachedMemberships();
      if (!memberships.length) {
        memberships = await tenantService.getMembershipsForUser(authUser.uid);
        await tenantService.cacheMemberships(memberships);
      }

      const membershipSummaries: TenantMembershipSummary[] = memberships.map((membership) => ({
        tenantId: membership.tenantId,
        role: membership.role,
        status: membership.status,
      }));

      const tenantIds = memberships
        .filter((membership) => membership.status === 'active')
        .map((membership) => membership.tenantId);

      let activeTenantId = await tenantService.getCachedSelectedTenant();
      if (!activeTenantId) {
        activeTenantId = tenantIds[0] ?? null;
      }

      this.tenantMetadataCache = {
        userId: authUser.uid,
        fetchedAt: now,
        tenantIds,
        membershipSummaries,
        activeTenantId,
      };

      return { tenantIds, membershipSummaries, activeTenantId };
    } catch (error) {
      logger.warn('DeviceTrackingService: failed to resolve tenant metadata for device tagging', error);
      return { tenantIds: [], membershipSummaries: [], activeTenantId: null };
    }
  }

  private async getTenantAuthorizedEmails(tenantId: string): Promise<string[]> {
    const CACHE_TTL_MS = 60 * 1000;
    const now = Date.now();

    if (
      this.tenantAuthorizedEmailsCache &&
      this.tenantAuthorizedEmailsCache.tenantId === tenantId &&
      now - this.tenantAuthorizedEmailsCache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.tenantAuthorizedEmailsCache.emails;
    }

    try {
      const memberships = await tenantService.getActiveMembershipsForTenant(tenantId);
      const emails = memberships
        .map((membership) => membership.email?.toLowerCase?.())
        .filter((email): email is string => Boolean(email));

      this.tenantAuthorizedEmailsCache = {
        tenantId,
        fetchedAt: now,
        emails,
      };

      return emails;
    } catch (error) {
      logger.warn('DeviceTrackingService: failed to resolve tenant authorized emails', {
        tenantId,
        error,
      });
      this.tenantAuthorizedEmailsCache = null;
      return [];
    }
  }

  private async scopeAuthorizedEmailsToTenant(
    authorizedEmails: string[],
    tenantId?: string
  ): Promise<string[]> {
    if (!tenantId) {
      return authorizedEmails;
    }

    const tenantEmails = await this.getTenantAuthorizedEmails(tenantId);
    if (!tenantEmails.length) {
      return [];
    }

    const allowed = new Set(tenantEmails);
    return authorizedEmails.filter((email) => allowed.has(email));
  }

  private deviceMatchesTenant(
    device: UserDevice,
    tenantId?: string | null,
    includeUntagged: boolean = true
  ): boolean {
    if (!tenantId) {
      return true;
    }

    const tenantIds = Array.isArray(device.tenantIds) ? device.tenantIds : [];
    const activeTenantId = typeof device.activeTenantId === 'string' ? device.activeTenantId : null;
    const membershipMatches = Array.isArray(device.tenantMemberships)
      ? device.tenantMemberships.some((membership) => membership.tenantId === tenantId)
      : false;

    const matchesTenant = tenantIds.includes(tenantId) || activeTenantId === tenantId || membershipMatches;
    if (matchesTenant) {
      return true;
    }

    if (!includeUntagged) {
      return false;
    }

    const isUntagged = tenantIds.length === 0 && !activeTenantId && !(device.tenantMemberships?.length);
    return isUntagged;
  }

  private resolveTenantIdForNotification(
    device: UserDevice,
    notification?: { data?: any }
  ): string | null {
    const payloadTenant = typeof notification?.data?.tenantId === 'string' ? notification.data.tenantId.trim() : '';
    if (payloadTenant) {
      return payloadTenant;
    }

    const activeTenantId = typeof device.activeTenantId === 'string' ? device.activeTenantId.trim() : '';
    if (activeTenantId) {
      return activeTenantId;
    }

    if (Array.isArray(device.tenantIds)) {
      const match = device.tenantIds.find((entry) => typeof entry === 'string' && entry.trim());
      if (match) {
        return match.trim();
      }
    }

    if (Array.isArray(device.tenantMemberships)) {
      const membership = device.tenantMemberships.find((entry) => {
        if (!entry || typeof entry.tenantId !== 'string') {
          return false;
        }
        const trimmed = entry.tenantId.trim();
        if (!trimmed) {
          return false;
        }
        const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : 'active';
        return status === 'active';
      });
      if (membership) {
        return membership.tenantId.trim();
      }
    }

    return null;
  }

  private canAttemptRemoteNotificationDelivery(device: UserDevice): boolean {
    if (device.isDeleted) {
      return false;
    }

    if (this.isDeviceLoggedOut(device)) {
      return false;
    }

    if (device.isOnline) {
      return true;
    }

    if (device.deviceType === 'web') {
      return typeof device.webPushSubscription?.endpoint === 'string'
        && device.webPushSubscription.endpoint.trim().length > 0;
    }

    return typeof device.expoPushToken === 'string' && device.expoPushToken.trim().length > 0;
  }

  private isDeviceLoggedOut(device: UserDevice): boolean {
    if (device.sessionActive === false) {
      return true;
    }

    if (device.logoutType === 'manual' || device.logoutType === 'forced') {
      return true;
    }

    return device.lastActivityType === 'logout' || device.lastActivityType === 'forced_logout';
  }

  private getWebPushEndpointKey(device: UserDevice): string | null {
    const endpoint = typeof device.webPushSubscription?.endpoint === 'string'
      ? device.webPushSubscription.endpoint.trim()
      : '';
    return endpoint || null;
  }

  private getDeviceFreshnessMs(device: UserDevice): number {
    const candidates = [
      device.updatedAt,
      device.lastSeen,
      device.webPushLastSyncedAt,
      device.webPushSubscribedAt,
      device.lastTenantPingAt,
    ];
    return candidates.reduce((latest, value) => {
      if (!value) {
        return latest;
      }
      try {
        return Math.max(latest, DeviceTrackingService.resolveTimestamp(value).getTime());
      } catch {
        return latest;
      }
    }, 0);
  }

  private async cleanupStaleWebPushSubscriptions(
    userEmail: string,
    devices: UserDevice[]
  ): Promise<{
    devices: UserDevice[];
    staleCleanedCount: number;
    deduplicatedCount: number;
  }> {
    const webDevices = devices.filter((device) => device.deviceType === 'web' && !device.isDeleted);
    if (!webDevices.length) {
      return { devices, staleCleanedCount: 0, deduplicatedCount: 0 };
    }

    const now = Date.now();
    const updates: Array<Promise<void>> = [];
    const staleIds = new Set<string>();
    const dedupedIds = new Set<string>();
    const endpointWinners = new Map<string, UserDevice>();

    for (const device of webDevices) {
      const endpointKey = this.getWebPushEndpointKey(device);
      const expirationTime = typeof device.webPushSubscription?.expirationTime === 'number'
        ? device.webPushSubscription.expirationTime
        : null;
      const hasExpiredSubscription = typeof expirationTime === 'number' && Number.isFinite(expirationTime) && expirationTime > 0 && expirationTime <= now;
      const subscribedWithoutEndpoint = device.webPushStatus === 'subscribed' && !endpointKey;

      if (hasExpiredSubscription || subscribedWithoutEndpoint) {
        staleIds.add(device.deviceId);
        const deviceRef = doc(firestore, 'user_devices', userEmail, 'devices', device.deviceId);
        updates.push(updateDoc(deviceRef, {
          webPushSubscription: deleteField(),
          webPushStatus: subscribedWithoutEndpoint ? 'sync_required' : 'unsubscribed',
          webPushLastErrorCode: subscribedWithoutEndpoint ? 'subscription_missing' : 'subscription_expired',
          webPushLastErrorAt: this.createResolvedTimestamp(),
          updatedAt: this.createResolvedTimestamp(),
        }).catch((error) => {
          logger.warn('Failed to cleanup stale web push subscription', { userEmail, deviceId: device.deviceId, error });
        }));
        continue;
      }

      if (!endpointKey) {
        continue;
      }

      const existingWinner = endpointWinners.get(endpointKey);
      if (!existingWinner) {
        endpointWinners.set(endpointKey, device);
        continue;
      }

      const keepExisting = this.getDeviceFreshnessMs(existingWinner) >= this.getDeviceFreshnessMs(device);
      const winner = keepExisting ? existingWinner : device;
      const loser = keepExisting ? device : existingWinner;
      endpointWinners.set(endpointKey, winner);
      dedupedIds.add(loser.deviceId);

      const loserRef = doc(firestore, 'user_devices', userEmail, 'devices', loser.deviceId);
      updates.push(updateDoc(loserRef, {
        webPushSubscription: deleteField(),
        webPushStatus: 'unsubscribed',
        webPushLastErrorCode: 'duplicate_subscription_replaced',
        webPushLastErrorAt: this.createResolvedTimestamp(),
        updatedAt: this.createResolvedTimestamp(),
      }).catch((error) => {
        logger.warn('Failed to deduplicate web push subscription', { userEmail, deviceId: loser.deviceId, error });
      }));
    }

    if (updates.length) {
      await Promise.all(updates);
    }

    return {
      devices: devices.filter((device) => !staleIds.has(device.deviceId) && !dedupedIds.has(device.deviceId)),
      staleCleanedCount: staleIds.size,
      deduplicatedCount: dedupedIds.size,
    };
  }

  /**
   * Resolve serverTimestamp placeholder to actual timestamp
   */
  static resolveTimestamp(timestampValue: any): Date {
    // Handle serverTimestamp objects (not yet resolved)
    if (timestampValue && typeof timestampValue === 'object' && timestampValue._methodName === 'serverTimestamp') {
      return new Date(); // Use current time for unresolved serverTimestamp
    }
    
    // Handle Firestore Timestamp objects with seconds and nanoseconds properties
    if (timestampValue && typeof timestampValue === 'object' && timestampValue.seconds !== undefined) {
      return new Date(timestampValue.seconds * 1000 + Math.floor(timestampValue.nanoseconds / 1000000));
    }
    
    // Handle Firestore Timestamp objects
    if (timestampValue instanceof Timestamp) {
      return timestampValue.toDate();
    }
    
    // Handle objects with toDate method
    if (timestampValue && typeof timestampValue.toDate === 'function') {
      return timestampValue.toDate();
    }
    
    // Handle Date objects
    if (timestampValue instanceof Date) {
      return timestampValue;
    }
    
    // Handle strings/numbers
    if (typeof timestampValue === 'string' || typeof timestampValue === 'number') {
      return new Date(timestampValue);
    }
    
    return new Date();
  }

  /**
   * Remove undefined values from an object to prevent Firestore errors
   */
  private cleanUndefinedValues(obj: any): any {
    if (obj === null || obj === undefined) {
      return null;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanUndefinedValues(item));
    }
    
    if (typeof obj === 'object') {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) {
          cleaned[key] = this.cleanUndefinedValues(value);
        }
      }
      return cleaned;
    }
    
    return obj;
  }

  private getBackendApiBaseUrl(): string | undefined {
    const s = runtimeEndpoints.getSnapshot();
    const resolved = s.notificationsApiBaseUrl || runtimeEndpoints.getPreferredBackendBaseUrl();
    if (resolved && resolved !== this.backendApiBaseUrl) {
      this.backendApiBaseUrl = resolved;
    }
    return this.backendApiBaseUrl;
  }

  private getPushProxyBaseUrl(): string | undefined {
    return this.getBackendApiBaseUrl();
  }

  private readonly WEB_PUSH_DIAGNOSTICS_DB_NAME = 'tm-web-push-diagnostics';
  private readonly WEB_PUSH_DIAGNOSTICS_STORE_NAME = 'kv';

  private openWebPushDiagnosticsDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.WEB_PUSH_DIAGNOSTICS_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.WEB_PUSH_DIAGNOSTICS_STORE_NAME)) {
          db.createObjectStore(this.WEB_PUSH_DIAGNOSTICS_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
    });
  }

  private async readWebPushDiagnostic<T = any>(key: string): Promise<T | null> {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !('indexedDB' in window)) {
      return null;
    }

    try {
      const db = await this.openWebPushDiagnosticsDb();
      const result = await new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction(this.WEB_PUSH_DIAGNOSTICS_STORE_NAME, 'readonly');
        const request = tx.objectStore(this.WEB_PUSH_DIAGNOSTICS_STORE_NAME).get(key);
        request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
        request.onerror = () => reject(request.error || new Error('indexeddb_read_failed'));
      });
      db.close();
      return result;
    } catch {
      return null;
    }
  }

  private async writeWebPushDiagnostic(key: string, value: any): Promise<void> {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !('indexedDB' in window)) {
      return;
    }

    try {
      const db = await this.openWebPushDiagnosticsDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(this.WEB_PUSH_DIAGNOSTICS_STORE_NAME, 'readwrite');
        tx.objectStore(this.WEB_PUSH_DIAGNOSTICS_STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('indexeddb_write_failed'));
        tx.onabort = () => reject(tx.error || new Error('indexeddb_write_aborted'));
      });
      db.close();
    } catch {
    }
  }

  private async syncStoredWebPushDiagnostics(reason: string = 'manual'): Promise<void> {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return;
    }
    if (!this.currentUserEmail || !this.currentDeviceId) {
      return;
    }
    const currentUserEmail = this.currentUserEmail;
    const currentDeviceId = this.currentDeviceId;
    if (this.webPushDiagnosticsSyncInFlight) {
      return this.webPushDiagnosticsSyncInFlight;
    }

    this.webPushDiagnosticsSyncInFlight = (async () => {
      const [lastPushReceipt, lastSubscriptionSync] = await Promise.all([
        this.readWebPushDiagnostic<Record<string, any>>('lastPushReceipt'),
        this.readWebPushDiagnostic<Record<string, any>>('lastSubscriptionSync'),
      ]);

      const updates: Record<string, any> = {};

      if (lastPushReceipt?.receivedAt) {
        updates.webPushClientLastReceiptAt = Timestamp.fromDate(new Date(lastPushReceipt.receivedAt));
        updates.webPushClientLastReceiptType = typeof lastPushReceipt.type === 'string' ? lastPushReceipt.type : null;
        updates.webPushClientLastReceiptNotificationId = typeof lastPushReceipt.notificationId === 'string' ? lastPushReceipt.notificationId : null;
        updates.webPushClientLastReceiptTag = typeof lastPushReceipt.tag === 'string' ? lastPushReceipt.tag : null;
        updates.webPushClientLastReceiptTitle = typeof lastPushReceipt.title === 'string' ? lastPushReceipt.title : null;
      }

      if (lastSubscriptionSync?.syncedAt) {
        updates.webPushClientLastSubscriptionSyncAt = Timestamp.fromDate(new Date(lastSubscriptionSync.syncedAt));
        updates.webPushClientLastSubscriptionContext = typeof lastSubscriptionSync.context === 'string' ? lastSubscriptionSync.context : reason;
        updates.webPushClientLastSubscriptionPermission = typeof lastSubscriptionSync.permission === 'string'
          ? lastSubscriptionSync.permission
          : (typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : null);
      }

      const normalized = this.cleanUndefinedValues(updates);
      if (Object.keys(normalized).length === 0) {
        return;
      }

      const deviceRef = doc(firestore, 'user_devices', currentUserEmail, 'devices', currentDeviceId);
      await updateDoc(deviceRef, {
        ...normalized,
        updatedAt: this.createResolvedTimestamp(),
      });
    })().finally(() => {
      this.webPushDiagnosticsSyncInFlight = null;
    });

    return this.webPushDiagnosticsSyncInFlight;
  }

  private async sendWebPushViaBackend(payload: {
    tenantId: string;
    deviceId: string;
    title: string;
    body: string;
    data?: any;
    requireInteraction?: boolean;
    clickUrl?: string;
    ttl?: number;
    urgency?: 'very-low' | 'low' | 'normal' | 'high';
  }): Promise<{ ok: boolean; result?: any }> {
    const baseUrl = this.getPushProxyBaseUrl();
    if (!baseUrl) {
      return { ok: false, result: { error: 'backend_url_missing' } };
    }

    internalTokenManager.setBaseUrl(baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let token = await internalTokenManager.getToken(baseUrl);
    if (!token) {
      token = await internalTokenManager.forceRefresh(baseUrl);
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let response = await fetch(`${baseUrl}/notifications/web-push/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (response.status === 401) {
      internalTokenManager.invalidate(baseUrl);
      const refreshed = await internalTokenManager.forceRefresh(baseUrl);
      if (refreshed) {
        headers.Authorization = `Bearer ${refreshed}`;
      }
      response = await fetch(`${baseUrl}/notifications/web-push/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    }

    const raw = await response.text();
    maybeShowMaintenanceAlertFromRaw(response.status, raw);
    let result: any = {};
    if (raw) {
      try {
        result = JSON.parse(raw);
      } catch {
        result = { raw };
      }
    }

    return { ok: response.ok, result };
  }

  private async getWebPushTenantId(): Promise<string | null> {
    try {
      const tenantId = await tenantService.getCachedSelectedTenant();
      return tenantId || null;
    } catch {
      return null;
    }
  }

  private urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const normalized = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(normalized);
    const output = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) {
      output[i] = rawData.charCodeAt(i);
    }
    return output.buffer;
  }

  private async getWebPushConfig(tenantId: string): Promise<{ baseUrl: string; publicKey: string } | null> {
    const baseUrl = this.getBackendApiBaseUrl();
    if (!baseUrl) {
      return null;
    }

    internalTokenManager.setBaseUrl(baseUrl);
    const headers: Record<string, string> = { Accept: 'application/json' };
    let token = await internalTokenManager.getToken(baseUrl);
    if (!token) {
      token = await internalTokenManager.forceRefresh(baseUrl);
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const url = `${baseUrl}/notifications/web-push/config?tenantId=${encodeURIComponent(tenantId)}`;
    let response = await fetch(url, { headers });

    if (response.status === 401) {
      internalTokenManager.invalidate(baseUrl);
      const refreshed = await internalTokenManager.forceRefresh(baseUrl);
      if (refreshed) {
        headers.Authorization = `Bearer ${refreshed}`;
      }
      response = await fetch(url, { headers });
    }

    if (!response.ok) {
      return null;
    }

    const result = await response.json().catch(() => null);
    if (!result?.enabled || typeof result.publicKey !== 'string' || !result.publicKey.trim()) {
      return null;
    }

    return { baseUrl, publicKey: result.publicKey.trim() };
  }

  private async updateCurrentDeviceWebPushState(updates: Record<string, any>): Promise<void> {
    if (!this.currentUserEmail || !this.currentDeviceId) {
      return;
    }

    const deviceRef = doc(firestore, 'user_devices', this.currentUserEmail, 'devices', this.currentDeviceId);
    await updateDoc(deviceRef, this.cleanUndefinedValues({
      ...updates,
      updatedAt: this.createResolvedTimestamp(),
      webPushLastSyncedAt: this.createResolvedTimestamp(),
    }));
  }

  private async unregisterCurrentWebPushSubscription(reason: string): Promise<void> {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !this.currentDeviceId) {
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe().catch(() => undefined);
      }
    } catch {
    }

    const tenantId = await this.getWebPushTenantId();
    const baseUrl = this.getBackendApiBaseUrl();
    if (tenantId && baseUrl && this.currentDeviceId) {
      internalTokenManager.setBaseUrl(baseUrl);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      let token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        token = await internalTokenManager.forceRefresh(baseUrl);
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      await fetch(`${baseUrl}/notifications/web-push/unsubscribe`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tenantId, deviceId: this.currentDeviceId }),
      }).catch(() => undefined);
    }

    const isLogoutReason = reason === 'logged_out' || reason === 'forced_logout';
    await this.updateCurrentDeviceWebPushState({
      webPushSubscription: deleteField(),
      webPushStatus: reason === 'permission_denied' ? 'permission_denied' : 'unsubscribed',
      webPushLastErrorCode: reason,
      webPushVapidPublicKey: isLogoutReason ? deleteField() : undefined,
      webPushSubscribedAt: isLogoutReason ? deleteField() : undefined,
      webPushClientLastSubscriptionSyncAt: isLogoutReason ? deleteField() : undefined,
      webPushClientLastSubscriptionContext: isLogoutReason ? deleteField() : undefined,
      webPushClientLastSubscriptionPermission: isLogoutReason ? deleteField() : undefined,
      webPushClientLastReceiptAt: isLogoutReason ? deleteField() : undefined,
      webPushClientLastReceiptType: isLogoutReason ? deleteField() : undefined,
      webPushClientLastReceiptNotificationId: isLogoutReason ? deleteField() : undefined,
      webPushClientLastReceiptTag: isLogoutReason ? deleteField() : undefined,
      webPushClientLastReceiptTitle: isLogoutReason ? deleteField() : undefined,
    }).catch(() => undefined);
  }

  async syncCurrentWebPushSubscription(context: string = 'manual'): Promise<void> {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return;
    }
    if (!this.currentUserEmail || !this.currentDeviceId) {
      return;
    }
    if (this.webPushSyncInFlight) {
      return this.webPushSyncInFlight;
    }

    this.webPushSyncInFlight = (async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        await this.updateCurrentDeviceWebPushState({
          webPushStatus: 'unsupported',
          webPushSubscription: deleteField(),
          webPushLastErrorCode: 'unsupported',
        }).catch(() => undefined);
        return;
      }

      if (!this.lastKnownNotificationsEnabled) {
        await this.unregisterCurrentWebPushSubscription('notifications_disabled');
        return;
      }

      if (Notification.permission === 'denied') {
        await this.unregisterCurrentWebPushSubscription('permission_denied');
        return;
      }

      if (Notification.permission !== 'granted') {
        await this.writeWebPushDiagnostic('lastSubscriptionSync', {
          syncedAt: new Date().toISOString(),
          context,
          permission: Notification.permission,
          status: 'pending_permission',
        });
        await this.syncStoredWebPushDiagnostics('permission_pending');
        await this.updateCurrentDeviceWebPushState({
          webPushStatus: 'sync_required',
          webPushLastErrorCode: `permission_${Notification.permission}`,
        }).catch(() => undefined);
        return;
      }

      const tenantId = await this.getWebPushTenantId();
      if (!tenantId) {
        return;
      }

      const config = await this.getWebPushConfig(tenantId);
      if (!config?.publicKey) {
        await this.writeWebPushDiagnostic('lastSubscriptionSync', {
          syncedAt: new Date().toISOString(),
          context,
          permission: Notification.permission,
          status: 'config_unavailable',
        });
        await this.syncStoredWebPushDiagnostics('config_unavailable');
        await this.updateCurrentDeviceWebPushState({
          webPushStatus: 'error',
          webPushLastErrorCode: 'config_unavailable',
        }).catch(() => undefined);
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToArrayBuffer(config.publicKey),
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      internalTokenManager.setBaseUrl(config.baseUrl);
      let token = await internalTokenManager.getToken(config.baseUrl);
      if (!token) {
        token = await internalTokenManager.forceRefresh(config.baseUrl);
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${config.baseUrl}/notifications/web-push/subscribe`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tenantId,
          deviceId: this.currentDeviceId,
          subscription: subscription.toJSON(),
          notificationPermission: Notification.permission,
          userAgent: navigator.userAgent,
        }),
      });

      const raw = await response.text().catch(() => '');
      maybeShowMaintenanceAlertFromRaw(response.status, raw);
      if (!response.ok) {
        await this.writeWebPushDiagnostic('lastSubscriptionSync', {
          syncedAt: new Date().toISOString(),
          context,
          permission: Notification.permission,
          status: 'subscribe_failed',
          errorCode: `subscribe_failed:${response.status}`,
        });
        await this.syncStoredWebPushDiagnostics('subscribe_failed');
        await this.updateCurrentDeviceWebPushState({
          webPushStatus: 'error',
          webPushLastErrorCode: `subscribe_failed:${response.status}`,
        }).catch(() => undefined);
        return;
      }

      await this.writeWebPushDiagnostic('lastSubscriptionSync', {
        syncedAt: new Date().toISOString(),
        context,
        permission: Notification.permission,
        status: 'subscribed',
      });
      await this.syncStoredWebPushDiagnostics('subscribed');

      await this.updateCurrentDeviceWebPushState({
        webPushSubscription: subscription.toJSON(),
        webPushStatus: 'subscribed',
        webPushVapidPublicKey: config.publicKey,
        webPushSubscribedAt: this.createResolvedTimestamp(),
        webPushLastErrorAt: deleteField(),
        webPushLastErrorCode: deleteField(),
        notificationPermission: Notification.permission,
      }).catch(() => undefined);

      logger.debug('Web push subscription synced', { deviceId: this.currentDeviceId, context });
    })().finally(() => {
      this.webPushSyncInFlight = null;
    });

    return this.webPushSyncInFlight;
  }

  private async sendPushViaBackend(message: Record<string, any> & { tenantId: string }): Promise<{ ok: boolean; result?: any }> {
    const baseUrl = this.getPushProxyBaseUrl();
    if (!baseUrl) {
      logger.error(
        'Backend push proxy URL not configured. Set Firestore appSettings/runtimeEndpoints.notificationsApiBaseUrl (or apiBaseUrl).'
      );
      return { ok: false };
    }

    const tenantId = typeof message.tenantId === 'string' ? message.tenantId.trim() : '';
    if (!tenantId) {
      logger.error('sendPushViaBackend called without tenantId');
      return { ok: false, result: { error: 'tenant_required' } };
    }

    internalTokenManager.setBaseUrl(baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let token = await internalTokenManager.getToken(baseUrl);
    if (!token) {
      for (let i = 0; i < 5 && !token; i++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        token = await internalTokenManager.getToken(baseUrl);
      }
    }
    if (!token) {
      token = await internalTokenManager.forceRefresh(baseUrl);
    }
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      logger.warn('Proceeding with backend push proxy request without internal auth token');
    }

    let response = await fetch(`${baseUrl}/notifications/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
    });

    if (response.status === 401) {
      internalTokenManager.invalidate(baseUrl);
      const refreshed = await internalTokenManager.forceRefresh(baseUrl);
      if (refreshed) {
        headers['Authorization'] = `Bearer ${refreshed}`;
      } else {
        delete headers['Authorization'];
      }
      response = await fetch(`${baseUrl}/notifications/push`, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      });
    }

    const raw = await response.text();
    maybeShowMaintenanceAlertFromRaw(response.status, raw);
    let result: any = {};
    if (raw) {
      try {
        result = JSON.parse(raw);
      } catch {
        result = { raw };
      }
    }

    if (!response.ok) {
      logger.error('Backend push proxy request failed', { status: response.status, result });
      return { ok: false, result };
    }

    return { ok: true, result };
  }

  private async sendTenantDevicePing(
    pingType: DevicePingType,
    overrides: {
      tenantId?: string | null;
      deviceId?: string;
      userEmail?: string;
      isOnline?: boolean;
      requestId?: string;
    } = {}
  ): Promise<void> {
    const userEmail = overrides.userEmail ?? this.currentUserEmail;
    const deviceId = overrides.deviceId ?? this.currentDeviceId;
    if (!userEmail || !deviceId) {
      return;
    }

    let tenantId = overrides.tenantId ?? null;
    const metadata = await this.getTenantMetadataForTagging();
    if (!tenantId) {
      tenantId = metadata.activeTenantId ?? metadata.tenantIds[0] ?? null;
    }
    const membershipMetadata = metadata.membershipSummaries;

    const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
    if (!normalizedTenantId) {
      logger.debug('Device ping skipped: no tenant context available for enforcement');
      return;
    }

    const hasActiveMembership = membershipMetadata.some(
      (membership) => membership.tenantId === normalizedTenantId && membership.status === 'active',
    );
    if (!hasActiveMembership) {
      logger.debug('Device ping skipped: user lacks active membership for tenant', {
        tenantId: normalizedTenantId,
      });
      return;
    }

    const baseUrl = this.getBackendApiBaseUrl();
    if (!baseUrl) {
      if (!this.devicePingWarnedMissingBackend) {
        logger.warn(
          'Device ping skipped: backend API base URL missing. Configure Firestore appSettings/runtimeEndpoints.apiBaseUrl (or notificationsApiBaseUrl) to enable tenant enforcement.'
        );
        this.devicePingWarnedMissingBackend = true;
      }
      return;
    }

    internalTokenManager.setBaseUrl(baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let token = await internalTokenManager.getToken(baseUrl);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const payload: Record<string, any> = {
      tenantId: normalizedTenantId,
      userEmail,
      deviceId,
      pingType,
    };

    if (typeof overrides.isOnline === 'boolean') {
      payload.isOnline = overrides.isOnline;
    }
    if (overrides.requestId) {
      payload.requestId = overrides.requestId;
    }

    try {
      let response = await fetch(`${baseUrl}/devices/ping`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (response.status === 401) {
        const refreshed = await internalTokenManager.forceRefresh(baseUrl);
        if (refreshed) {
          headers.Authorization = `Bearer ${refreshed}`;
        } else {
          delete headers.Authorization;
        }
        response = await fetch(`${baseUrl}/devices/ping`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });
      }

      if (!response.ok) {
        let errorText = '';
        try {
          errorText = await response.text();
        } catch {
          errorText = response.statusText;
        }
        maybeShowMaintenanceAlertFromRaw(response.status, errorText);
        logger.warn('Device ping rejected by backend', {
          status: response.status,
          error: errorText,
        });
      }
    } catch (error) {
      logger.warn('Failed to send tenant device ping', error);
    }
  }

  private extractExpoPushStatus(result: any): string | undefined {
    if (!result) return undefined;

    if (Array.isArray(result)) {
      const first = result[0];
      if (first && typeof first.status === 'string') {
        return first.status;
      }
    }

    const data = result.data;
    if (data) {
      if (Array.isArray(data) && data.length > 0) {
        const first = data[0];
        if (first && typeof first.status === 'string') {
          return first.status;
        }
      } else if (typeof data === 'object' && typeof (data as any).status === 'string') {
        return (data as any).status;
      }
    }

    if (typeof result.status === 'string') {
      return result.status;
    }

    return undefined;
  }

  /**
   * Initialize device tracking for a user
   */
  async initialize(userEmail: string): Promise<void> {
    try {
      this.currentUserEmail = userEmail;
      
      // Register device first, then perform security checks with delay
      // This allows the auth service to properly load authorized emails
      await this.registerDevice(userEmail);
      
      // Add a delay to allow auth service to load authorized emails from Firestore
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Perform security checks after auth service has had time to initialize
      try {
        await this.performSecurityChecks(userEmail);
      } catch (error) {
        logger.warn('Security check failed during initialization, will retry later:', error);
        // Don't throw error immediately on initialization - this prevents false positives
        // Security checks will be performed again during heartbeat and network monitoring
      }
      
      this.startHeartbeat();

      if (Platform.OS !== 'web' && this.currentDeviceId) {
        await this.startPushTokenRefreshMonitor(userEmail, this.currentDeviceId);
      }
      
      // Set up URL change tracking for web
      if (Platform.OS === 'web') {
        this.setupWebNavigationTracking();
        // Initialize web notification listener for admin notifications
        await this.initializeWebNotificationListener();
          await this.syncCurrentWebPushSubscription('initialize');
      }
      
      // Set up network state monitoring for security checks
      this.setupNetworkStateMonitoring();
      
      logger.debug('Device tracking initialized for:', userEmail);
    } catch (error) {
      logger.error('Device tracking initialization failed:', error);
      throw error;
    }
  }

  /**
   * Set up network state monitoring to perform security checks when coming online
   */
  private setupNetworkStateMonitoring(): void {
    try {
      // For mobile platforms, use NetInfo
      if (Platform.OS !== 'web') {
        const NetInfo = require('@react-native-community/netinfo');
        NetInfo.addEventListener((state: any) => {
          if (state.isConnected && this.currentUserEmail && this.currentDeviceId) {
            // When device comes back online, perform security checks
            this.performOnlineSecurityCheck();
          }
        });
      } else {
        // For web, use online/offline events
        if (typeof window !== 'undefined') {
          window.addEventListener('online', () => {
            if (this.currentUserEmail && this.currentDeviceId) {
              this.performOnlineSecurityCheck();
            }
          });
        }
      }
    } catch (error) {
      logger.error('Failed to setup network state monitoring:', error);
    }
  }

  /**
   * Perform security checks when device comes back online
   */
  private async performOnlineSecurityCheck(): Promise<void> {
    try {
      if (!this.currentUserEmail || !this.currentDeviceId) return;
      
      logger.debug('🔒 Performing online security check...');
      
      // Multi-tenant rollout: legacy authorized email gates removed. Device checks now rely on tenant membership + bans only.
      logger.debug('🌐 Skipping legacy authorized-email verification during online security check');
      
      // Check for force logout signals
      const shouldLogout = await this.checkLogoutSignal(this.currentUserEmail, this.currentDeviceId);
      if (shouldLogout) {
        logger.debug('🚨 Force logout signal detected while online');
        await this.handleForceLogout();
        return;
      }
      
      // Get current device info and check for ban with user-specific targeting
      const currentDevice = await this.getDeviceById(this.currentUserEmail, this.currentDeviceId);
      if (currentDevice) {
        const banCheck = await this.isDeviceBannedForUser(currentDevice, this.currentUserEmail);
        if (banCheck) {
          logger.debug('🚫 Device ban detected while online - logging out');
          await this.handleForceLogout();
          return;
        }
      }
      
      logger.debug('✅ Online security check passed');
    } catch (error) {
      logger.error('❌ Online security check failed:', error);
    }
  }

  /**
   * Perform comprehensive security checks during initialization
   */
  private async performSecurityChecks(userEmail: string): Promise<void> {
    try {
      logger.debug('🔒 Performing security checks...');
      
      // Multi-tenant rollout: legacy authorized email gates removed. Device checks now rely on tenant membership, bans, and logout signals only.
      logger.debug('🌐 Skipping legacy authorized-email verification during initialization for user:', userEmail);
      
      // Get device ID for checks (new format: platform_userhash_devicefingerprint)
      const deviceId = await this.getOrCreateDeviceId(userEmail);
      this.currentDeviceId = deviceId;
      
      logger.debug('🆔 Device ID generated:', {
        deviceId,
        format: 'platform_userhash_devicefingerprint',
        userEmail: userEmail.substring(0, 10) + '...',
        platform: Platform.OS
      });
      
      // Check for force logout signals
      try {
        const shouldLogout = await this.checkLogoutSignal(userEmail, deviceId);
        if (shouldLogout) {
          logger.debug('🚨 Force logout signal detected during initialization');
          await this.handleForceLogout();
          throw new Error('You have been logged out by an administrator');
        }
      } catch (error) {
        logger.warn('Could not check logout signal:', error);
        // Don't fail on network errors during initial auth
      }
      
      // Get existing device info for ban check
      try {
        const existingDevice = await this.getDeviceById(userEmail, deviceId);
        if (existingDevice) {
          // Check for device ban with user-specific targeting
          const banCheck = await this.isDeviceBannedForUser(existingDevice, userEmail);
          if (banCheck) {
            logger.debug('🚫 Device is banned - blocking initialization');
            // Force logout and throw error
            await authService.signOut();
            throw new Error(`This device has been banned. Reason: ${banCheck.reason}`);
          }
        }
      } catch (error) {
        logger.warn('Could not check device ban status:', error);
        // Don't fail on network errors during initial auth
      }
      
      logger.debug('✅ Security checks passed');
    } catch (error) {
      logger.error('❌ Security check failed:', error);
      throw error;
    }
  }

  /**
   * Set up web navigation tracking to detect URL changes
   */
  private setupWebNavigationTracking(): void {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    let lastUrl = window.location.href;

    // Track URL changes via history API
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(data: any, title: string, url?: string | null) {
      originalPushState.apply(history, [data, title, url]);
      if (url && url !== lastUrl) {
        lastUrl = window.location.href;
        deviceTrackingService.trackPageNavigation();
      }
    };

    history.replaceState = function(data: any, title: string, url?: string | null) {
      originalReplaceState.apply(history, [data, title, url]);
      if (url && url !== lastUrl) {
        lastUrl = window.location.href;
        deviceTrackingService.trackPageNavigation();
      }
    };

    // Track back/forward button navigation
    window.addEventListener('popstate', () => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        this.trackPageNavigation();
      }
    });

    // Track hash changes
    window.addEventListener('hashchange', () => {
      this.trackPageNavigation();
    });
  }

  /**
   * Track page navigation changes (web only)
   */
  private async trackPageNavigation(): Promise<void> {
    if (!this.currentDeviceId || !this.currentUserEmail || Platform.OS !== 'web') return;

    try {
      const browserInfo = this.getBrowserInfo();
      const deviceDoc = doc(firestore, 'user_devices', this.currentUserEmail, 'devices', this.currentDeviceId);
      
      const updates: any = {
        currentUrl: browserInfo.currentUrl,
        pathname: browserInfo.pathname,
        search: browserInfo.search,
        hash: browserInfo.hash,
        lastSeen: this.createResolvedTimestamp(),
        lastActivityType: 'page_navigation',
        updatedAt: this.createResolvedTimestamp()
      };

      // Clean undefined values before updating
      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);
      
      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', this.currentUserEmail);
      await updateDoc(userDoc, { lastActivity: this.createResolvedTimestamp() });
      
      logger.debug('Page navigation tracked:', browserInfo.currentUrl);
    } catch (error) {
      logger.error('Failed to track page navigation:', error);
    }
  }

  /**
   * Register or update device information with comprehensive security checks
   */
  async registerDevice(userEmail: string, expoPushToken?: string): Promise<string> {
    try {
      // Get or generate device ID with user email for uniqueness
      const deviceId = await this.getOrCreateDeviceId(userEmail);
      const existingDeviceRecord = await this.getDeviceById(userEmail, deviceId);
      if (existingDeviceRecord?.expoPushToken && !expoPushToken) {
        expoPushToken = existingDeviceRecord.expoPushToken;
      }
      if (!expoPushToken && this.lastKnownExpoPushToken) {
        expoPushToken = this.lastKnownExpoPushToken;
      }
      
      // Get Expo push token if not provided
      if (!expoPushToken && Platform.OS !== 'web') {
        try {
          const projectId = resolveExpoProjectId();
          if (!projectId) {
            logger.warn('Expo project ID unavailable; skipping push token acquisition during device registration.');
          } else {
            const token = await Notifications.getExpoPushTokenAsync({ projectId });
            expoPushToken = token.data;
          }
        } catch (error) {
          logger.warn('Failed to get Expo push token:', error);
        }
      }

      if (expoPushToken) {
        this.lastKnownExpoPushToken = expoPushToken;
      }

      // Collect comprehensive device information with the resolved push token
      const deviceInfo = await this.collectDeviceInformation(deviceId, expoPushToken);
      const tenantMetadata = await this.getTenantMetadataForTagging();
      const resolvedTenantIdForPing = tenantMetadata.activeTenantId ?? tenantMetadata.tenantIds[0] ?? null;
      
      // Check if device is hard banned with user-specific targeting
      const banCheck = await this.isDeviceBannedForUser(deviceInfo as UserDevice, userEmail);
      if (banCheck) {
        logger.debug(`🚫 Device registration blocked - hard banned: ${banCheck.deviceFingerprint}`);
        // Force logout and throw error
        await authService.signOut();
        throw new Error(`This device has been banned. Reason: ${banCheck.reason}`);
      }
      
      // Check for force logout signals before proceeding
      const shouldLogout = await this.checkLogoutSignal(userEmail, deviceId);
      if (shouldLogout) {
        const existingDeviceRecord = await this.getDeviceById(userEmail, deviceId);

        await this.handleForceLogout();
        throw new Error('You have been logged out by an administrator');
      }
      
      // Check if this device was previously deleted and restore it automatically
      if (existingDeviceRecord && existingDeviceRecord.isDeleted) {
        logger.debug(`Automatically restoring previously deleted device: ${deviceId}`);
        await this.restoreDeletedDevice(userEmail, deviceId, 'Automatic restoration on login');
      }
      // Clean undefined values to prevent Firestore errors
      const cleanDeviceInfo = this.cleanUndefinedValues(deviceInfo);

      // Check if device already exists to preserve first registration date
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const existingDeviceSnap = await getDoc(deviceDoc);
      let existingData: any = undefined;
      if (existingDeviceSnap.exists()) {
        existingData = existingDeviceSnap.data();
      }
      
      // Clear logout flags on successful login - user is back online
      cleanDeviceInfo.lastActivityType = 'device_registration';
      cleanDeviceInfo.logoutType = deleteField();
      cleanDeviceInfo.manualLogoutAt = deleteField();
      cleanDeviceInfo.forcedLogoutBy = deleteField();
      cleanDeviceInfo.forcedLogoutByName = deleteField();
      cleanDeviceInfo.forcedLogoutAt = deleteField();
      cleanDeviceInfo.forcedLogoutReason = deleteField();
      cleanDeviceInfo.logoutSignal = deleteField();
      cleanDeviceInfo.isOnline = true;
      cleanDeviceInfo.sessionActive = true;

      if (expoPushToken) {
        cleanDeviceInfo.expoPushToken = expoPushToken;
        cleanDeviceInfo.pushTokenStatus = 'synced';
        cleanDeviceInfo.needsExpoPushTokenRefresh = false;
        cleanDeviceInfo.lastPushTokenSyncAt = this.createResolvedTimestamp();
        cleanDeviceInfo.lastPushTokenErrorAt = deleteField();
      } else {
        if (!existingData?.pushTokenStatus) {
          cleanDeviceInfo.pushTokenStatus = 'missing';
        }
        if (existingData?.needsExpoPushTokenRefresh !== undefined) {
          cleanDeviceInfo.needsExpoPushTokenRefresh = existingData.needsExpoPushTokenRefresh;
        }
        if (existingData?.lastPushTokenSyncAt) {
          cleanDeviceInfo.lastPushTokenSyncAt = existingData.lastPushTokenSyncAt;
        }
      }
      
      if (!existingDeviceSnap.exists()) {
        cleanDeviceInfo.notificationsEnabled = true;
        cleanDeviceInfo.chatNotificationsEnabled = true;
        cleanDeviceInfo.dailyQuotesEnabled = true;
        cleanDeviceInfo.noticeNotificationsEnabled = true;
        cleanDeviceInfo.teamNotificationsEnabled = true;
      } else if (existingData) {
        if (cleanDeviceInfo.notificationsEnabled === undefined) {
          cleanDeviceInfo.notificationsEnabled = existingData.notificationsEnabled;
        }
        if (cleanDeviceInfo.chatNotificationsEnabled === undefined) {
          cleanDeviceInfo.chatNotificationsEnabled = existingData.chatNotificationsEnabled;
        }
        if (cleanDeviceInfo.dailyQuotesEnabled === undefined) {
          cleanDeviceInfo.dailyQuotesEnabled = existingData.dailyQuotesEnabled;
        }
        if (cleanDeviceInfo.noticeNotificationsEnabled === undefined) {
          cleanDeviceInfo.noticeNotificationsEnabled = existingData.noticeNotificationsEnabled;
        }
        if (cleanDeviceInfo.teamNotificationsEnabled === undefined) {
          cleanDeviceInfo.teamNotificationsEnabled = existingData.teamNotificationsEnabled;
        }
      }

      // If device exists, preserve the original createdAt timestamp
      if (existingDeviceSnap.exists() && existingData) {
        if (existingData.createdAt) {
          cleanDeviceInfo.createdAt = existingData.createdAt; // Preserve original registration date
        } else {
          // Existing device but no createdAt? Set it now for backward compatibility
          cleanDeviceInfo.createdAt = this.createResolvedTimestamp();
        }
        // If lastLogin doesn't exist yet, set it to current time (for backward compatibility)
        if (!existingData.lastLogin) {
          cleanDeviceInfo.lastLogin = this.createResolvedTimestamp();
        }
      } else {
        // For new devices, set initial timestamps
        cleanDeviceInfo.createdAt = this.createResolvedTimestamp();
        cleanDeviceInfo.lastLogin = this.createResolvedTimestamp();
      }
      
      // Clean undefined values again after adding deleteField() operations
      const finalCleanDeviceInfo = this.cleanUndefinedValues(cleanDeviceInfo);
      finalCleanDeviceInfo.tenantIds = tenantMetadata.tenantIds;
      finalCleanDeviceInfo.tenantMemberships = tenantMetadata.membershipSummaries;
      finalCleanDeviceInfo.activeTenantId = tenantMetadata.activeTenantId ?? null;
      
      // Store device as a separate document in subcollection
      await setDoc(deviceDoc, finalCleanDeviceInfo, { merge: true });

      // Update user's device count and last activity
      const totalDevices = await this.getTotalDevicesCount(userEmail);
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await setDoc(userDoc, {
        userId: userEmail,
        totalDevices: totalDevices,
        lastActivity: this.createResolvedTimestamp(),
        tenantIds: tenantMetadata.tenantIds,
        tenantMemberships: tenantMetadata.membershipSummaries,
        activeTenantId: tenantMetadata.activeTenantId ?? null,
      }, { merge: true });

      this.currentDeviceId = deviceId;

      await this.sendTenantDevicePing('register', {
        tenantId: resolvedTenantIdForPing,
        deviceId,
        userEmail,
        isOnline: true,
      });
      
      // Log the login action to track device reactivation
      await this.logDeviceAction({
        actionType: 'login',
        deviceId,
        userId: userEmail,
        timestamp: this.createResolvedTimestamp()
      });
      
      logger.debug('📱 Device registered successfully:', {
        deviceId,
        format: 'platform_userhash_devicefingerprint',
        platform: Platform.OS,
        deviceName: deviceInfo.deviceName,
        modelName: deviceInfo.modelName,
        osVersion: deviceInfo.osVersion,
        userEmail: userEmail.substring(0, 10) + '...'
      });

      if (Platform.OS === 'web') {
        void this.syncCurrentWebPushSubscription('register');
      }
      
      return deviceId;
    } catch (error) {
      logger.error('Device registration failed:', error);
      throw error;
    }
  }

  /**
   * Collect comprehensive device information
   */
  private async collectDeviceInformation(deviceId: string, expoPushToken?: string): Promise<UserDevice> {
    try {
      const basicInfo = await this.getBasicDeviceInfo();
      const hardwareInfo = await this.getHardwareInfo();
      const networkInfo = await this.getNetworkInfo();
      const systemInfo = await this.getSystemInfo();
      const browserInfo = Platform.OS === 'web' ? this.getBrowserInfo() : {};
      const screenInfo = this.getScreenInfo();
      const locationInfo = await this.getLocationInfo();
      
      // New enhanced tracking information
      const storageInfo = await this.getStorageInfo();
      const orientationInfo = this.getOrientationInfo();
      const webCapabilities = this.getWebCapabilities();
      const permissionsInfo = await this.getPermissionsInfo();

      const deviceInfo: UserDevice = {
        // Basic identification
        deviceId,
        deviceIdSource: this.currentDeviceIdSource,
        deviceSeedHash: this.currentDeviceSeedHash ?? undefined,
        fallbackFingerprintHash: this.computeFallbackFingerprintHash({
          userAgent: browserInfo.userAgent,
          manufacturer: hardwareInfo.manufacturer,
          modelName: hardwareInfo.modelName,
          modelId: hardwareInfo.modelId,
          hardwareConcurrency: browserInfo.hardwareConcurrency || hardwareInfo.hardwareConcurrency,
          totalMemory: hardwareInfo.totalMemory,
          screenWidth: screenInfo.screenWidth,
          screenHeight: screenInfo.screenHeight,
          supportedCpuArchitectures: hardwareInfo.supportedCpuArchitectures,
          jsHeapSizeLimit: browserInfo.jsHeapSizeLimit,
          platform: browserInfo.platform || systemInfo.osName,
          vendor: browserInfo.vendor,
        }) || undefined,
        deviceType: basicInfo.deviceType,
        deviceName: basicInfo.deviceName,
        
        // Platform information
        platformOS: Platform.OS,
        platformVersion: Platform.OS === 'web' ? 'web' : Platform.Version,
        
        // App information
        appVersion: basicInfo.appVersion,
        nativeAppVersion: basicInfo.nativeAppVersion,
        nativeBuildVersion: basicInfo.nativeBuildVersion,
        expoVersion: basicInfo.expoVersion,
        
        // Hardware details
        ...hardwareInfo,
        
        // System information
        ...systemInfo,
        
        // Network & Location
        ...networkInfo,
        ...locationInfo,
        
        // Screen information
        ...screenInfo,
        
        // Browser information (web only)
        ...browserInfo,
        
        // Storage information
        ...storageInfo,
        
        // Orientation & Motion
        ...orientationInfo,
        
        // Web capabilities
        ...webCapabilities,
        
        // Permissions
        ...permissionsInfo,
        
        // Notification tokens
        expoPushToken,
        
        // Status and timestamps - Use resolved timestamps for immediate availability
        lastSeen: this.createResolvedTimestamp(),
        // Note: createdAt will be set in registerDevice() only for new devices
        updatedAt: this.createResolvedTimestamp(),
        
        // Session information
        sessionId: this.generateSessionId(),
        lastActivityType: 'device_registration'
      };

      return deviceInfo;
    } catch (error) {
      logger.error('Error collecting device information:', error);
      throw error;
    }
  }

  /**
   * Start heartbeat to maintain online status
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      if (this.currentDeviceId && this.currentUserEmail) {
        try {
          // Check for logout signal first
          const shouldLogout = await this.checkLogoutSignal(this.currentUserEmail, this.currentDeviceId);
          if (shouldLogout) {
            logger.debug('Logout signal received from admin - logging out...');
            await this.handleForceLogout();
            return; // Exit early since we're logging out
          }

          // Check for device ban (every 10th heartbeat - 5 minutes)
          const shouldCheckBan = Math.random() < 0.1; // 10% chance each heartbeat
          if (shouldCheckBan) {
            try {
              const currentDevice = await this.getDeviceById(this.currentUserEmail, this.currentDeviceId);
              if (currentDevice) {
                const banCheck = await this.isDeviceBannedForUser(currentDevice, this.currentUserEmail);
                if (banCheck) {
                  logger.debug('🚫 Device has been banned - logging out...');
                  await this.handleForceLogout();
                  return;
                }
              }
            } catch (error) {
              logger.error('Error checking device ban during heartbeat:', error);
            }
          }

          // Every 5th heartbeat (2.5 minutes), do a full device info update
          const shouldUpdateFullInfo = Math.random() < 0.2; // 20% chance each heartbeat
          
          if (shouldUpdateFullInfo) {
            await this.updateFullDeviceInfo(this.currentUserEmail, this.currentDeviceId);
          } else {
            await this.updateDeviceStatus(this.currentUserEmail, this.currentDeviceId, true);
          }
        } catch (error) {
          logger.error('Heartbeat update failed:', error);
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  private async startPushTokenRefreshMonitor(userEmail: string, deviceId: string): Promise<void> {
    if (this.hasPushTokenRefreshMonitor || Platform.OS === 'web') {
      return;
    }

    try {
      const deviceDocRef = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const unsubscribe = onSnapshot(deviceDocRef, async (snapshot) => {
        if (!snapshot.exists()) {
          return;
        }

        const data = snapshot.data() as UserDevice & {
          needsExpoPushTokenRefresh?: boolean;
          pushTokenStatus?: 'synced' | 'missing' | 'requested' | 'unknown';
        };

        const needsRefresh = data.needsExpoPushTokenRefresh === true || (!data.expoPushToken && data.pushTokenStatus === 'missing');
        if (!needsRefresh || this.pushTokenRefreshInFlight) {
          return;
        }

        this.pushTokenRefreshInFlight = true;

        try {
          const notificationService = getNotificationService();
          const refreshedToken = await notificationService.refreshExpoPushToken();
          const token = refreshedToken || notificationService.getExpoPushToken();

          if (token) {
            await this.registerDevice(userEmail, token);
            await updateDoc(deviceDocRef, {
              needsExpoPushTokenRefresh: false,
              pushTokenStatus: 'synced',
              lastPushTokenSyncAt: this.createResolvedTimestamp()
            });
            this.lastKnownExpoPushToken = token;
          } else {
            logger.warn('Push token refresh monitor requested but no token available after refresh attempt.');
            await updateDoc(deviceDocRef, {
              needsExpoPushTokenRefresh: false,
              pushTokenStatus: 'missing',
              lastPushTokenErrorAt: this.createResolvedTimestamp()
            });
          }
        } catch (error) {
          logger.error('Failed to refresh push token after refresh request:', error);
        } finally {
          this.pushTokenRefreshInFlight = false;
        }
      });

      this.unsubscribeListeners.push(unsubscribe);
      this.hasPushTokenRefreshMonitor = true;
      if (!this.pushTokenRefreshReinitUnsub) {
        this.pushTokenRefreshReinitUnsub = authService.registerFirestoreReinit?.(() => {
          if (this.currentUserEmail && this.currentDeviceId) {
            this.restartPushTokenRefreshMonitor('reinit');
          }
        }) || null;
      }
      logger.debug('Push token refresh monitor activated for device:', deviceId);
    } catch (error) {
      logger.error('Failed to start push token refresh monitor:', error);
    }
  }

  private async restartPushTokenRefreshMonitor(context?: string): Promise<void> {
    if (!this.currentUserEmail || !this.currentDeviceId || Platform.OS === 'web') {
      return;
    }
    this.unsubscribeListeners.forEach((unsubscribe) => unsubscribe());
    this.unsubscribeListeners = [];
    this.hasPushTokenRefreshMonitor = false;
    await this.startPushTokenRefreshMonitor(this.currentUserEmail, this.currentDeviceId);
    if (context) {
      logger.debug('Push token refresh monitor reattached', { context });
    }
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Update device online status and last seen
   */
  async updateDeviceStatus(userEmail: string, deviceId: string, isOnline: boolean): Promise<void> {
    try {
      const deviceDocRef = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const now = this.createResolvedTimestamp();

      // If the device document no longer exists (e.g., permanently deleted),
      // skip updating it and only bump user's lastActivity to avoid errors.
      const snap = await getDoc(deviceDocRef);
      if (!snap.exists()) {
        try {
          const userDoc = doc(firestore, 'user_devices', userEmail);
          await updateDoc(userDoc, { lastActivity: now });
        } catch (e) {
          // best-effort update of parent doc
        }
        logger.debug('Skipped device status update; device doc missing (likely permanently deleted):', deviceId);
        return;
      }

      const heartbeatId = `${deviceId}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
      const updates: any = {
        lastSeen: now,
        isOnline: isOnline,
        updatedAt: now,
        lastActivityType: 'heartbeat',
        // Add a heartbeat ID to help debug concurrent updates
        lastHeartbeatId: heartbeatId,
      };

      // Clean undefined values before updating
      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDocRef, cleanUpdates);
      
      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, { lastActivity: now });

      await this.sendTenantDevicePing('heartbeat', {
        userEmail,
        deviceId,
        isOnline,
        requestId: heartbeatId,
      });
    } catch (error) {
      logger.error('Failed to update device status:', error);
      throw error;
    }
  }

  /**
   * Update full device information (called periodically)
   */
  async updateFullDeviceInfo(userEmail: string, deviceId: string): Promise<void> {
    try {
      logger.debug('Updating full device info for:', deviceId);
      
      // Collect updated device information
      const networkInfo = await this.getNetworkInfo();
      const locationInfo = await this.getLocationInfo();
      const screenInfo = this.getScreenInfo();
      const browserInfo = Platform.OS === 'web' ? this.getBrowserInfo() : {};
      
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const sessionId = this.generateSessionId();
      const updates: any = {
        lastSeen: this.createResolvedTimestamp(),
        updatedAt: this.createResolvedTimestamp(),
        lastActivityType: 'full_update',
        sessionId,
        deviceIdSource: this.currentDeviceIdSource,
        deviceSeedHash: this.currentDeviceSeedHash ?? undefined,
        fallbackFingerprintHash: undefined,
      };

      // Update network info
      if (networkInfo.ipAddress) {
        updates.ipAddress = networkInfo.ipAddress;
      }
      if (networkInfo.networkType) {
        updates.networkType = networkInfo.networkType;
      }
      if (networkInfo.carrierName) {
        updates.carrierName = networkInfo.carrierName;
      }

      // Update location info
      if (locationInfo.countryCode) {
        updates.countryCode = locationInfo.countryCode;
      }
      if (locationInfo.timezone) {
        updates.timezone = locationInfo.timezone;
      }
      if (locationInfo.locale) {
        updates.locale = locationInfo.locale;
      }

      // Update screen info (mainly for web)
      if (screenInfo.screenWidth) {
        updates.screenWidth = screenInfo.screenWidth;
      }
      if (screenInfo.screenHeight) {
        updates.screenHeight = screenInfo.screenHeight;
      }
      if (screenInfo.screenScale) {
        updates.screenScale = screenInfo.screenScale;
      }

      // Update web-specific browser info
      if (Platform.OS === 'web' && browserInfo) {
        if (browserInfo.currentUrl) {
          updates.currentUrl = browserInfo.currentUrl;
        }
        if (browserInfo.pathname) {
          updates.pathname = browserInfo.pathname;
        }
        if (browserInfo.search) {
          updates.search = browserInfo.search;
        }
        if (browserInfo.hash) {
          updates.hash = browserInfo.hash;
        }
        if (browserInfo.viewportWidth) {
          updates.viewportWidth = browserInfo.viewportWidth;
        }
        if (browserInfo.viewportHeight) {
          updates.viewportHeight = browserInfo.viewportHeight;
        }
      }

      if (!updates.fallbackFingerprintHash) {
        const existingSnap = await getDoc(deviceDoc);
        if (existingSnap.exists()) {
          const existingData = existingSnap.data() as UserDevice;
          if (existingData.fallbackFingerprintHash) {
            updates.fallbackFingerprintHash = existingData.fallbackFingerprintHash;
          }
        }
      }

      if (!updates.fallbackFingerprintHash) {
        const fallbackBase = await this.getFingerprintBaseForCurrentDevice();
        updates.fallbackFingerprintHash = this.computeFallbackFingerprintHash(fallbackBase) || undefined;
      }

      // Clean undefined values before updating
      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);
      
      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, { lastActivity: this.createResolvedTimestamp() });

      await this.sendTenantDevicePing('full', {
        userEmail,
        deviceId,
        isOnline: true,
        requestId: sessionId,
      });
      
      logger.debug('Full device info updated successfully');
    } catch (error) {
      logger.error('Failed to update full device info:', error);
    }
  }

  /**
   * Mark device as offline and cleanup
   */
  async unregisterDevice(userEmail?: string): Promise<void> {
    try {
      const email = userEmail || this.currentUserEmail;
      if (this.currentDeviceId && email) {
        if (Platform.OS === 'web') {
          await this.unregisterCurrentWebPushSubscription('logged_out');
        }
        await this.updateDeviceStatus(email, this.currentDeviceId, false);

        try {
          const deviceDocRef = doc(firestore, 'user_devices', email, 'devices', this.currentDeviceId);
          await updateDoc(deviceDocRef, {
            expoPushToken: deleteField(),
            pushTokenStatus: 'missing',
            needsExpoPushTokenRefresh: true,
            lastPushTokenErrorAt: this.createResolvedTimestamp(),
            lastPushTokenErrorCode: 'logged_out',
            webPushSubscription: deleteField(),
            webPushStatus: 'unsubscribed',
            webPushVapidPublicKey: deleteField(),
            webPushSubscribedAt: deleteField(),
            webPushLastSyncedAt: deleteField(),
            webPushLastErrorAt: deleteField(),
            webPushLastErrorCode: deleteField(),
            webPushClientLastSubscriptionSyncAt: deleteField(),
            webPushClientLastSubscriptionContext: deleteField(),
            webPushClientLastSubscriptionPermission: deleteField(),
            webPushClientLastReceiptAt: deleteField(),
            webPushClientLastReceiptType: deleteField(),
            webPushClientLastReceiptNotificationId: deleteField(),
            webPushClientLastReceiptTag: deleteField(),
            webPushClientLastReceiptTitle: deleteField(),
          });
        } catch (error) {
          logger.warn('Failed to clear expo push token on logout:', error);
        }
        
        // Stop heartbeat
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }

        // Cleanup listeners
        this.unsubscribeListeners.forEach(unsubscribe => unsubscribe());
        this.unsubscribeListeners = [];
  this.hasPushTokenRefreshMonitor = false;
  this.pushTokenRefreshInFlight = false;
  this.lastKnownExpoPushToken = null;

        // Clean up cached device ID for this user
        await this.cleanupCachedDeviceId(email);

        logger.debug('Device unregistered:', this.currentDeviceId);
      }
    } catch (error) {
      logger.error('Device unregistration failed:', error);
    }
  }

  /**
   * Clean up cached device ID for a specific user
   */
  private async cleanupCachedDeviceId(userEmail: string): Promise<void> {
    try {
      const userDeviceIdKey = `${this.DEVICE_ID_KEY_PREFIX}${this.hashEmail(userEmail)}`;
      await AsyncStorage.removeItem(userDeviceIdKey);
      logger.debug('Cached device ID cleaned up for user:', userEmail);
    } catch (error) {
      logger.warn('Failed to cleanup cached device ID:', error);
    }
  }

  async updateCurrentDevicePreferences(preferences: {
    notificationsEnabled?: boolean;
    chatNotificationsEnabled?: boolean;
    dailyQuotesEnabled?: boolean;
    noticeNotificationsEnabled?: boolean;
    teamNotificationsEnabled?: boolean;
  }): Promise<void> {
    try {
      if (!this.currentUserEmail || !this.currentDeviceId) {
        logger.debug('Skipping device preference sync; no active device context.');
        return;
      }

      const sanitizedPreferences = this.cleanUndefinedValues({ ...preferences });
      if (Object.keys(sanitizedPreferences).length === 0) {
        return;
      }

      if (typeof preferences.notificationsEnabled === 'boolean') {
        this.lastKnownNotificationsEnabled = preferences.notificationsEnabled;
      }

      const deviceDoc = doc(
        firestore,
        'user_devices',
        this.currentUserEmail,
        'devices',
        this.currentDeviceId
      );

      await updateDoc(deviceDoc, {
        ...sanitizedPreferences,
        preferencesSyncedAt: this.createResolvedTimestamp(),
      });

      logger.debug('Device notification preferences synced', {
        deviceId: this.currentDeviceId,
        userEmail: this.currentUserEmail,
        preferences: sanitizedPreferences,
      });

      if (Platform.OS === 'web' && Object.prototype.hasOwnProperty.call(sanitizedPreferences, 'notificationsEnabled')) {
        await this.syncCurrentWebPushSubscription('preferences');
      }
    } catch (error) {
      logger.warn('Failed to update device notification preferences:', error);
    }
  }

  async updateCurrentDeviceChatState(update: {
    partnerEmail?: string | null;
    partnerId?: string | null;
    partnerName?: string | null;
    isActive?: boolean;
    lastMessageId?: string | null;
    lastMessageTimestamp?: string | number | Date | null;
  }): Promise<void> {
    try {
      if (!this.currentUserEmail || !this.currentDeviceId) {
        logger.debug('Skipping chat activity sync; no active device context.');
        return;
      }

      const normalizedPartner = update.partnerEmail
        ? update.partnerEmail.toLowerCase()
        : null;
      const isActive = update.isActive !== undefined ? Boolean(update.isActive) : Boolean(normalizedPartner);

      const deviceDoc = doc(
        firestore,
        'user_devices',
        this.currentUserEmail,
        'devices',
        this.currentDeviceId
      );

      const now = this.createResolvedTimestamp();
      const updates: Record<string, any> = {
        updatedAt: now,
        lastSeen: now,
        lastActivityType: 'chat_activity',
      };

      if (normalizedPartner && isActive) {
        updates.activeChatPartner = normalizedPartner;
        if (update.partnerId !== undefined) {
          updates.activeChatPartnerId = update.partnerId ?? deleteField();
        }
        if (update.partnerName !== undefined) {
          updates.activeChatPartnerName = update.partnerName ?? deleteField();
        }
        updates.activeChatIsFocused = true;
        updates.activeChatLastSeenAt = now;
        if (update.lastMessageId !== undefined) {
          updates.activeChatLastMessageId = update.lastMessageId ?? deleteField();
        }
        if (update.lastMessageTimestamp !== undefined) {
          updates.activeChatLastMessageTimestamp = update.lastMessageTimestamp ?? deleteField();
        }
      } else {
        updates.activeChatPartner = deleteField();
        updates.activeChatPartnerId = deleteField();
        updates.activeChatPartnerName = deleteField();
        updates.activeChatIsFocused = deleteField();
        updates.activeChatLastSeenAt = deleteField();
        updates.activeChatLastMessageId = deleteField();
        updates.activeChatLastMessageTimestamp = deleteField();
      }

      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);

      const userDoc = doc(firestore, 'user_devices', this.currentUserEmail);
      await updateDoc(userDoc, { lastActivity: now });

    } catch (error) {
      logger.warn('Failed to update device chat activity:', error);
    }
  }

  /**
   * Parse and format device ID for display
   * Format: platform_userhash_devicefingerprint
   */
  static parseDeviceId(deviceId: string): {
    platform: string;
    userHash: string;
    deviceFingerprint: string;
    isNewFormat: boolean;
  } {
    const parts = deviceId.split('_');
    
    if (parts.length >= 3) {
      return {
        platform: parts[0],
        userHash: parts[1],
        deviceFingerprint: parts.slice(2).join('_'),
        isNewFormat: true
      };
    } else {
      // Legacy format or unrecognized format
      return {
        platform: 'unknown',
        userHash: 'unknown',
        deviceFingerprint: deviceId,
        isNewFormat: false
      };
    }
  }

  /**
   * Get a human-readable description of device ID format
   */
  static describeDeviceId(deviceId: string): string {
    const parsed = DeviceTrackingService.parseDeviceId(deviceId);
    
    if (parsed.isNewFormat) {
      return `${parsed.platform.toUpperCase()} device (User: ${parsed.userHash}, Fingerprint: ${parsed.deviceFingerprint.substring(0, 8)}...)`;
    } else {
      return `Legacy device ID: ${deviceId.substring(0, 20)}...`;
    }
  }

  /**
   * Remove device completely from database
   */
  async removeDevice(userEmail: string, deviceId: string): Promise<void> {
    try {
      // Delete the device document from subcollection
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      await deleteDoc(deviceDoc);
      
      // Update user's device count
      const totalDevices = await this.getTotalDevicesCount(userEmail);
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, {
        totalDevices: totalDevices,
        lastActivity: this.createResolvedTimestamp()
      });
      
      logger.debug('Device removed:', deviceId);
    } catch (error) {
      logger.error('Failed to remove device:', error);
      throw error;
    }
  }

  /**
   * Get all devices for a user
   */
  async getUserDevices(userEmail: string, options?: DeviceTenantFilterOptions): Promise<UserDevice[]> {
    try {
      const tenantFilterId = options?.tenantId ?? null;
      const includeUntagged = options?.includeUntagged ?? true;
      // Query the devices subcollection
      const devicesCollection = collection(firestore, 'user_devices', userEmail, 'devices');
      const devicesSnap = await getDocs(devicesCollection);
      
      // Convert Firestore documents to UserDevice array and check online status
      const deviceArray: UserDevice[] = [];
      
      devicesSnap.forEach((deviceDoc) => {
        const deviceData = deviceDoc.data() as UserDevice;
        const deviceId = deviceDoc.id;
        
        // Helper function to handle different timestamp formats
        const parseTimestamp = (timestampValue: any): Date => {
          if (!timestampValue) return new Date();
          
          // Handle serverTimestamp objects (not yet resolved)
          if (timestampValue && typeof timestampValue === 'object' && timestampValue._methodName === 'serverTimestamp') {
            return new Date(); // Use current time for unresolved serverTimestamp
          }
          
          // Handle Firestore Timestamp objects with seconds and nanoseconds properties
          if (timestampValue && typeof timestampValue === 'object' && timestampValue.seconds !== undefined) {
            return new Date(timestampValue.seconds * 1000 + Math.floor(timestampValue.nanoseconds / 1000000));
          }
          
          // Handle Firestore Timestamp objects
          if (timestampValue instanceof Timestamp) {
            return timestampValue.toDate();
          }
          
          // Handle objects with toDate method
          if (timestampValue && typeof timestampValue.toDate === 'function') {
            return timestampValue.toDate();
          }
          
          // Handle Date objects
          if (timestampValue instanceof Date) {
            return timestampValue;
          }
          
          // Handle strings/numbers
          if (typeof timestampValue === 'string' || typeof timestampValue === 'number') {
            return new Date(timestampValue);
          }
          
          return new Date();
        };
        
        const lastSeenTime = parseTimestamp(deviceData.lastSeen);
        const createdAtTime = parseTimestamp(deviceData.createdAt);
        const updatedAtTime = parseTimestamp(deviceData.updatedAt);
        const lastTenantPingAt = deviceData.lastTenantPingAt
          ? parseTimestamp(deviceData.lastTenantPingAt)
          : undefined;
        const activeChatLastSeenAt = deviceData.activeChatLastSeenAt
          ? parseTimestamp(deviceData.activeChatLastSeenAt)
          : undefined;
        const activeChatLastMessageTimestamp = deviceData.activeChatLastMessageTimestamp
          ? parseTimestamp(deviceData.activeChatLastMessageTimestamp)
          : undefined;
        
        // Use database isOnline field if it exists (properly managed during logout operations)
        // but also verify with the recent-heartbeat rule so stale presence does not overstate delivery.
        const freshnessCandidates = [lastSeenTime, updatedAtTime, lastTenantPingAt]
          .filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
        const freshestPresenceAt = freshnessCandidates.length
          ? freshnessCandidates.reduce((latest, value) => (value.getTime() > latest.getTime() ? value : latest))
          : null;
        const hasRecentActivity = DeviceTrackingService.isDeviceOnline(freshestPresenceAt);
        const databaseOnlineStatus = deviceData.isOnline;
        
        // A device is considered online if:
        // 1. It has recent presence activity inside the heartbeat freshness window, AND
        // 2. Either the database doesn't have isOnline field (legacy) OR the database says it's online
        const isOnline = hasRecentActivity && (databaseOnlineStatus === undefined || databaseOnlineStatus === true);
        
        const processedDevice = {
          ...deviceData,
          deviceId, // Ensure deviceId is set from document ID
          lastSeen: lastSeenTime,
          createdAt: createdAtTime,
          updatedAt: updatedAtTime,
          lastTenantPingAt,
          isOnline: isOnline,
          activeChatLastSeenAt,
          activeChatLastMessageTimestamp,
        };
        
        if (this.deviceMatchesTenant(processedDevice, tenantFilterId, includeUntagged)) {
          deviceArray.push(processedDevice);
        }
      });
      
      // Add ban information to each device
      const devicesWithBanInfo = await Promise.all(
        deviceArray.map(async (device) => {
          try {
            const banInfo = await this.isDeviceBannedForUser(device, userEmail);
            return {
              ...device,
              isHardBanned: banInfo !== null,
              banInfo: banInfo || undefined
            };
          } catch (error) {
            logger.error('Error checking ban status for device:', device.deviceId, error);
            return {
              ...device,
              isHardBanned: false,
              banInfo: undefined
            };
          }
        })
      );
      
      return devicesWithBanInfo.sort((a, b) => {
        const aTime = a.lastSeen instanceof Date ? a.lastSeen : (a.lastSeen instanceof Timestamp ? a.lastSeen.toDate() : new Date(a.lastSeen));
        const bTime = b.lastSeen instanceof Date ? b.lastSeen : (b.lastSeen instanceof Timestamp ? b.lastSeen.toDate() : new Date(b.lastSeen));
        return bTime.getTime() - aTime.getTime();
      });
    } catch (error) {
      logger.error('Error fetching user devices:', error);
      return [];
    }
  }

  /**
   * Get all authorized users with their devices
   */
  async getAllUsersWithDevices(
    authorizedEmails: string[],
    currentUserEmail?: string,
    includeCurrentUser: boolean = false,
    options?: DeviceTenantFilterOptions
  ): Promise<AuthorizedUser[]> {
    try {
      const usersData: AuthorizedUser[] = [];
      const normalizedAuthorizedEmails = Array.from(
        new Set(
          authorizedEmails
            .map((email) => email?.toLowerCase?.())
            .filter((email): email is string => Boolean(email))
        )
      );

      let scopedTenantOptions = options;
      if (!scopedTenantOptions?.tenantId) {
        const selectedTenantId = await tenantService.getCachedSelectedTenant();
        if (selectedTenantId) {
          scopedTenantOptions = {
            tenantId: selectedTenantId,
            includeUntagged: scopedTenantOptions?.includeUntagged ?? false,
          };
        }
      }

      const emailsToProcess = scopedTenantOptions?.tenantId
        ? await this.scopeAuthorizedEmailsToTenant(normalizedAuthorizedEmails, scopedTenantOptions.tenantId)
        : normalizedAuthorizedEmails;

      if (emailsToProcess.length === 0) {
        logger.debug('DeviceTrackingService: no authorized emails available for tenant scope', {
          tenantId: scopedTenantOptions?.tenantId,
        });
        return [];
      }

      const normalizedCurrentUser = currentUserEmail?.toLowerCase();

      // Use statically imported authService

      for (const email of emailsToProcess) {
        // Skip current user if specified and not explicitly including them
        if (normalizedCurrentUser && email === normalizedCurrentUser && !includeCurrentUser) continue;

        try {
          const profile = await authService.getUserProfile(email);
          const devices = await this.getUserDevices(email, scopedTenantOptions);
          const derivedTenantIds = Array.from(
            new Set(
              devices.flatMap((device) => (Array.isArray(device.tenantIds) ? device.tenantIds : []))
            )
          );
          const isOnline = devices.some(device => device.isOnline && !device.isDeleted);
          
          usersData.push({
            email,
            role: profile?.role || 'user',
            displayName: profile?.displayName || this.extractDisplayName(email),
            devices,
            isOnline,
            totalDevices: devices.length,
            tenantIds: derivedTenantIds.length
              ? derivedTenantIds
              : scopedTenantOptions?.tenantId
              ? [scopedTenantOptions.tenantId]
              : undefined,
          });
        } catch (error) {
          logger.error(`Error loading data for user ${email}:`, error);
          // Add user with minimal data
          usersData.push({
            email,
            role: 'user',
            displayName: this.extractDisplayName(email),
            devices: [],
            isOnline: false, // No devices means offline
            totalDevices: 0,
            tenantIds: scopedTenantOptions?.tenantId ? [scopedTenantOptions.tenantId] : undefined,
          });
        }
      }

      return usersData.sort((a, b) => {
        // Sort by online status first, then by email
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        return a.email.localeCompare(b.email);
      });
    } catch (error) {
      logger.error('Error fetching all users with devices:', error);
      return [];
    }
  }

  /**
   * Check if user is online (has at least one online device)
   */
  async checkUserOnlineStatus(userEmail: string): Promise<boolean> {
    try {
      const devices = await this.getUserDevices(userEmail);
      return devices.some(device => device.isOnline);
    } catch (error) {
      logger.error('Error checking online status for', userEmail, error);
      return false;
    }
  }

  /**
   * Get user's push tokens for notifications
   */
  async getUserPushTokens(userEmail: string, onlineOnly: boolean = true): Promise<string[]> {
    try {
      const devices = await this.getUserDevices(userEmail);
      return devices
        .filter(device => onlineOnly ? (device.isOnline && !device.isDeleted) : true)
        .map(device => device.expoPushToken)
        .filter(token => token) as string[];
    } catch (error) {
      logger.error('Error getting push tokens for', userEmail, error);
      return [];
    }
  }

  /**
   * Send notification to specific device
   */
  async sendNotificationToDevice(
    deviceId: string,
    userEmail: string,
    notification: {
      title: string;
      body: string;
      data?: any;
    },
    deviceOverride?: UserDevice,
    options?: DeviceTenantFilterOptions
  ): Promise<boolean> {
    const result = await this.sendNotificationToDeviceDetailed(deviceId, userEmail, notification, deviceOverride, options);
    return result.delivered;
  }

  private async sendNotificationToDeviceDetailed(
    deviceId: string,
    userEmail: string,
    notification: {
      title: string;
      body: string;
      data?: any;
    },
    deviceOverride?: UserDevice,
    options?: DeviceTenantFilterOptions
  ): Promise<DeviceNotificationAttemptResult> {
    try {
      const device = deviceOverride ?? (await this.getUserDevices(userEmail, options)).find(d => d.deviceId === deviceId);
      
      if (!device) {
        logger.warn('Device not found:', deviceId);
        return { delivered: false, deliverySource: 'unknown' };
      }

      if (options?.tenantId && !this.deviceMatchesTenant(device, options.tenantId, options.includeUntagged ?? true)) {
        logger.warn('Blocked device notification outside tenant scope', {
          userEmail,
          deviceId,
          tenantId: options.tenantId,
        });
        return { delivered: false, deliverySource: 'unknown' };
      }

      if (!this.canAttemptRemoteNotificationDelivery(device)) {
        logger.debug('Skipping device notification: no active delivery channel available', {
          userEmail,
          deviceId,
          deviceType: device.deviceType,
        });
        return { delivered: false, deliverySource: 'unknown' };
      }

  const allowWhenDisabled = notification?.data?.allowWhenDisabled === true;
  const notificationType = notification?.data?.type;
  const isChatNotification = notificationType === 'chat_message';
  const isNoticeNotification = notificationType === 'notice_created';
  const isTeamNotification = notificationType === 'team_membership_change';
      const senderEmail = typeof notification?.data?.senderEmail === 'string'
        ? notification.data.senderEmail.toLowerCase()
        : null;
      const ACTIVE_CHAT_SUPPRESSION_WINDOW_MS = 45_000;

      if (!allowWhenDisabled) {
        if (device.notificationsEnabled === false) {
          logger.debug('Skipping device notification: device opted out of all notifications', {
            userEmail,
            deviceId,
          });
          return { delivered: false, deliverySource: 'unknown' };
        }

        if (isChatNotification && device.chatNotificationsEnabled === false) {
          logger.debug('Skipping device notification: device opted out of chat notifications', {
            userEmail,
            deviceId,
          });
          return { delivered: false, deliverySource: 'unknown' };
        }

        if (isNoticeNotification && device.noticeNotificationsEnabled === false) {
          logger.debug('Skipping device notification: device opted out of notice notifications', {
            userEmail,
            deviceId,
          });
          return { delivered: false, deliverySource: 'unknown' };
        }

        if (isTeamNotification && device.teamNotificationsEnabled === false) {
          logger.debug('Skipping device notification: device opted out of team notifications', {
            userEmail,
            deviceId,
          });
          return { delivered: false, deliverySource: 'unknown' };
        }

        if (notificationType === 'daily_quote' && device.dailyQuotesEnabled === false) {
          logger.debug('Skipping device notification: device opted out of daily quotes', {
            userEmail,
            deviceId,
          });
          return { delivered: false, deliverySource: 'unknown' };
        }
      }

      if (device.isOnline === true && isChatNotification && senderEmail) {
        const activePartner = typeof device.activeChatPartner === 'string'
          ? device.activeChatPartner.toLowerCase()
          : null;

        if (activePartner && activePartner === senderEmail && device.activeChatIsFocused === true) {
          let lastSeenAt: Date | null = null;
          try {
            if (device.activeChatLastSeenAt instanceof Date) {
              lastSeenAt = device.activeChatLastSeenAt;
            } else if (device.activeChatLastSeenAt) {
              lastSeenAt = DeviceTrackingService.resolveTimestamp(device.activeChatLastSeenAt);
            }
          } catch {}

          const now = Date.now();
          const lastSeenMs = lastSeenAt ? lastSeenAt.getTime() : 0;
          const isRecentlyActive = lastSeenMs > 0 && now - lastSeenMs <= ACTIVE_CHAT_SUPPRESSION_WINDOW_MS;

          if (isRecentlyActive) {
            logger.debug('Skipping device notification: user actively viewing chat on this device (direct send)', {
              userEmail,
              deviceId,
              senderEmail,
            });
            return { delivered: false, deliverySource: 'unknown' };
          }
        }
      }

      // Handle web browser devices and mobile devices differently using notification service
      if (device.deviceType === 'web') {
        return await this.sendWebBrowserNotification(deviceId, userEmail, notification, device);
      } else {
        // Handle mobile/Android devices with Expo push notifications
        return await this.sendMobileAppNotification(userEmail, device, notification);
      }
    } catch (error) {
      logger.error('Error sending notification to device:', error);
      return { delivered: false, deliverySource: 'unknown' };
    }
  }

  /**
   * Send notification to web browser device using notification service
   */
  private async sendWebBrowserNotification(deviceId: string, userEmail: string, notification: {
    title: string;
    body: string;
    data?: any;
  }, device?: UserDevice): Promise<DeviceNotificationAttemptResult> {
    try {
      // Check if this is the current device/user
      const isCurrentDevice = deviceId === this.currentDeviceId && userEmail === this.currentUserEmail;
      
      if (isCurrentDevice) {
        const notificationId = typeof notification.data?.notificationId === 'string' && notification.data.notificationId.trim()
          ? notification.data.notificationId.trim()
          : `web:${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        // Send local notification for current device
        await getNotificationService().sendLocalNotification({
          title: notification.title,
          body: notification.body,
          data: {
            ...(notification.data ?? {}),
            deviceId,
            userEmail,
            timestamp: Date.now(),
            allowWhenDisabled: true,
            notificationId,
          }
        });
        logger.debug('Local web notification sent to current device:', deviceId);
        return { delivered: true, deliverySource: 'presence' };
      } else {
        // For remote web devices, use Firebase Realtime Database for cross-device notification
        return await this.sendRemoteWebNotification(deviceId, userEmail, notification, device);
      }
    } catch (error) {
      logger.error('Error sending web browser notification:', error);
      return { delivered: false, deliverySource: 'unknown' };
    }
  }

  /**
   * Send notification to remote web browser device via Firebase Realtime Database
   */
  private async sendRemoteWebNotification(deviceId: string, userEmail: string, notification: {
    title: string;
    body: string;
    data?: any;
  }, device?: UserDevice): Promise<DeviceNotificationAttemptResult> {
    try {
      const tenantId = device ? this.resolveTenantIdForNotification(device, notification) : null;
      const hasWebPushSubscription = typeof device?.webPushSubscription?.endpoint === 'string' && device.webPushSubscription.endpoint.trim().length > 0;
      const isDeviceOnline = device?.isOnline === true;

      if (tenantId && hasWebPushSubscription) {
        const notificationId = typeof notification.data?.notificationId === 'string' && notification.data.notificationId.trim()
          ? notification.data.notificationId.trim()
          : `webpush:${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        const webPushResult = await this.sendWebPushViaBackend({
          tenantId,
          deviceId,
          title: notification.title,
          body: notification.body,
          data: {
            ...(notification.data ?? {}),
            allowWhenDisabled: true,
            notificationId,
          },
          requireInteraction: notification.data?.type === 'daily_quote' || notification.data?.priority === 'high',
          clickUrl: notification.data?.type === 'chat_message' || notification.data?.type === 'team_chat_message'
            ? undefined
            : '/(tabs)',
          ttl: notification.data?.type === 'daily_quote' ? 60 : 300,
          urgency: notification.data?.priority === 'high' ? 'high' : 'normal',
        });

        if (webPushResult.ok) {
          logger.debug('Remote web push sent successfully via backend', { deviceId, userEmail, tenantId });
          return { delivered: true, deliverySource: 'push', pushChannel: 'web_push' };
        }

        if (webPushResult.result?.error !== 'no_web_push_subscription') {
          logger.warn('Backend web push failed; falling back to RTDB queue', {
            deviceId,
            userEmail,
            tenantId,
            error: webPushResult.result,
          });
        }
      }

      if (!isDeviceOnline) {
        logger.debug('Skipping remote web notification fallback: device offline and no web push delivery path succeeded', {
          deviceId,
          userEmail,
          hasWebPushSubscription,
          tenantId,
        });
        return { delivered: false, deliverySource: 'unknown' };
      }

      // Use Firebase Realtime Database to send notifications to remote web browsers
      const database = getDatabase();
      
      const notificationData = {
        title: notification.title,
        body: notification.body,
        data: {
          ...(notification.data ?? {}),
          allowWhenDisabled: true,
          notificationId:
            typeof notification.data?.notificationId === 'string' && notification.data.notificationId.trim()
              ? notification.data.notificationId.trim()
              : `web:${deviceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        },
        deviceId,
        userEmail,
        timestamp: this.createResolvedTimestamp(),
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        type: typeof notification.data?.type === 'string' ? notification.data.type : 'admin_notification'
      };

      // Store notification in Firebase Realtime Database for the specific device
      const deviceNotificationsRef = ref(database, `device_notifications/${deviceId}`);
      await push(deviceNotificationsRef, notificationData);

      logger.debug('Remote web browser notification queued successfully for device:', deviceId);
      
      // Log to admin notification history if this is an admin notification
      if (notification.data?.type === 'admin_notification' && notification.data?.adminEmail) {
        try {
          
          // Find device name for better tracking
          const devices = await this.getUserDevices(userEmail);
          const targetDevice = devices.find(d => d.deviceId === deviceId);
          
          // This will be logged as part of a bulk operation, but we can track individual device delivery
          logger.debug('📝 Individual device notification logged for history tracking');
        } catch (error) {
          logger.warn('Failed to log individual device notification to history:', error);
        }
      }
      
      return { delivered: true, deliverySource: 'presence' };
    } catch (error) {
      logger.error('Error sending remote web browser notification:', error);
      return { delivered: false, deliverySource: 'unknown' };
    }
  }

  /**
   * Send push notification to mobile/Android app
   */
  private async sendMobileAppNotification(userEmail: string, device: UserDevice, notification: {
    title: string;
    body: string;
    data?: any;
  }): Promise<DeviceNotificationAttemptResult> {
    try {
      if (!device.expoPushToken) {
        logger.warn('No push token available for mobile device:', device.deviceId);
        await this.requestPushTokenRefresh(userEmail, device.deviceId);
        return { delivered: false, deliverySource: 'unknown' };
      }

      const channelId = resolveNotificationChannelId({
        type: typeof notification.data?.type === 'string' ? notification.data.type : undefined,
        priority:
          typeof notification.data?.priority === 'string' ? notification.data.priority : undefined,
      });

      // Use Expo push notification API for mobile devices
      const expoMessage = {
        to: device.expoPushToken,
        sound: 'default',
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
        priority: 'high',
        channelId,
      };

      if (Platform.OS === 'web') {
        const tenantId = this.resolveTenantIdForNotification(device, notification);
        if (!tenantId) {
          logger.error('Cannot send push via backend proxy without tenantId', {
            deviceId: device.deviceId,
            userEmail,
          });
          return { delivered: false, deliverySource: 'unknown' };
        }
        const backendResult = await this.sendPushViaBackend({ ...expoMessage, tenantId });
        if (!backendResult.ok) {
          return { delivered: false, deliverySource: 'unknown' };
        }
        const status = this.extractExpoPushStatus(backendResult.result);
        if (status === 'ok') {
          logger.debug('Mobile app notification sent successfully to device via backend proxy:', device.deviceId);
          return { delivered: true, deliverySource: 'push', pushChannel: 'mobile_push' };
        }
        logger.error('Failed to send mobile app notification through backend proxy:', backendResult.result);
        return { delivered: false, deliverySource: 'unknown' };
      }

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(expoMessage),
      });

      const raw = await response.text();
      let result: any = {};
      if (raw) {
        try {
          result = JSON.parse(raw);
        } catch {
          result = { raw };
        }
      }

      const status = this.extractExpoPushStatus(result);
      if (status === 'ok') {
        logger.debug('Mobile app notification sent successfully to device:', device.deviceId);
        return { delivered: true, deliverySource: 'push', pushChannel: 'mobile_push' };
      }

      logger.error('Failed to send mobile app notification:', result);
      return { delivered: false, deliverySource: 'unknown' };
    } catch (error) {
      logger.error('Error sending mobile app notification:', error);
      return { delivered: false, deliverySource: 'unknown' };
    }
  }

  private async requestPushTokenRefresh(userEmail: string, deviceId: string): Promise<void> {
    try {
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      await updateDoc(deviceDoc, {
        needsExpoPushTokenRefresh: true,
        pushTokenStatus: 'missing',
        lastPushTokenErrorAt: this.createResolvedTimestamp()
      });
      logger.debug('Requested push token refresh for device:', deviceId);
    } catch (error) {
      logger.warn('Failed to request push token refresh:', error);
    }
  }

  /**
   * Send notification to all user's devices
   */
  async sendNotificationToUser(userEmail: string, notification: {
    title: string;
    body: string;
    data?: any;
  }, onlineOnly: boolean = true, options?: DeviceTenantFilterOptions): Promise<DeviceNotificationFanoutResult> {
    try {
      const devices = await this.getUserDevices(userEmail, options);
      const cleanupResult = await this.cleanupStaleWebPushSubscriptions(userEmail, devices);
      const allowWhenDisabled = notification?.data?.allowWhenDisabled === true;
      const notificationType = notification?.data?.type;
      const isChatNotification = notificationType === 'chat_message';
      const isNoticeNotification = notificationType === 'notice_created';
      const isTeamNotification = notificationType === 'team_membership_change';
      const senderEmail = typeof notification?.data?.senderEmail === 'string'
        ? notification.data.senderEmail.toLowerCase()
        : null;
      const ACTIVE_CHAT_SUPPRESSION_WINDOW_MS = 45_000;

      const targetDevices = cleanupResult.devices.filter(device => {
        if (device.isDeleted) {
          return false;
        }

        if (onlineOnly && !device.isOnline) {
          return false;
        }

        if (!onlineOnly && !this.canAttemptRemoteNotificationDelivery(device)) {
          return false;
        }

        if (!allowWhenDisabled) {
          if (device.notificationsEnabled === false) {
            logger.debug('Skipping device due to notifications disabled', {
              userEmail,
              deviceId: device.deviceId,
            });
            return false;
          }

          if (isChatNotification && device.chatNotificationsEnabled === false) {
            logger.debug('Skipping device due to chat notifications disabled', {
              userEmail,
              deviceId: device.deviceId,
            });
            return false;
          }

          if (isNoticeNotification && device.noticeNotificationsEnabled === false) {
            logger.debug('Skipping device due to notice notifications disabled', {
              userEmail,
              deviceId: device.deviceId,
            });
            return false;
          }

          if (isTeamNotification && device.teamNotificationsEnabled === false) {
            logger.debug('Skipping device due to team notifications disabled', {
              userEmail,
              deviceId: device.deviceId,
            });
            return false;
          }
        }

        if (!allowWhenDisabled && notification?.data?.type === 'daily_quote' && device.dailyQuotesEnabled === false) {
          logger.debug('Skipping device due to daily quotes disabled', {
            userEmail,
            deviceId: device.deviceId,
          });
          return false;
        }

        if (device.isOnline === true && isChatNotification && senderEmail) {
          const activePartner = typeof device.activeChatPartner === 'string'
            ? device.activeChatPartner.toLowerCase()
            : null;

          if (activePartner && activePartner === senderEmail && device.activeChatIsFocused === true) {
            let lastSeenAt: Date | null = null;
            try {
              if (device.activeChatLastSeenAt instanceof Date) {
                lastSeenAt = device.activeChatLastSeenAt;
              } else if (device.activeChatLastSeenAt) {
                lastSeenAt = DeviceTrackingService.resolveTimestamp(device.activeChatLastSeenAt);
              }
            } catch {}

            const now = Date.now();
            const lastSeenMs = lastSeenAt ? lastSeenAt.getTime() : 0;
            const isRecentlyActive = lastSeenMs > 0 && now - lastSeenMs <= ACTIVE_CHAT_SUPPRESSION_WINDOW_MS;

            if (isRecentlyActive) {
              logger.debug('Skipping device notification: user actively viewing chat on this device', {
                userEmail,
                deviceId: device.deviceId,
                senderEmail,
              });
              return false;
            }
          }
        }

        return true;
      });

      let success = 0;
      let failed = 0;
      let presenceDeliveredCount = 0;
      let pushAcceptedCount = 0;
      let mobilePushAcceptedCount = 0;
      let webPushAcceptedCount = 0;
      const seenMobileTokens = new Set<string>();
      const onlineDeliverableCount = targetDevices.filter((device) => device.isOnline).length;

      // Send notifications to each device individually
      for (const device of targetDevices) {
        if (device.deviceType !== 'web') {
          const token = (device.expoPushToken || '').trim();
          if (token) {
            if (seenMobileTokens.has(token)) {
              logger.debug('Skipping duplicate mobile push token for notification delivery', {
                userEmail,
                deviceId: device.deviceId
              });
              continue;
            }
            seenMobileTokens.add(token);
          }
        }

        const attempt = await this.sendNotificationToDeviceDetailed(device.deviceId, userEmail, notification, device, options);
        if (attempt.delivered) {
          success++;
          if (attempt.deliverySource === 'presence') {
            presenceDeliveredCount += 1;
          }
          if (attempt.deliverySource === 'push') {
            pushAcceptedCount += 1;
            if (attempt.pushChannel === 'mobile_push') {
              mobilePushAcceptedCount += 1;
            }
            if (attempt.pushChannel === 'web_push') {
              webPushAcceptedCount += 1;
            }
          }
        } else {
          failed++;
        }
      }

      logger.debug(`Notification sent to user ${userEmail}: ${success} successful, ${failed} failed`);
      return {
        success,
        failed,
        deliverableDeviceCount: targetDevices.length,
        onlineDeliverableCount,
        presenceDeliveredCount,
        pushAcceptedCount,
        mobilePushAcceptedCount,
        webPushAcceptedCount,
        staleWebPushSubscriptionsCleaned: cleanupResult.staleCleanedCount,
        deduplicatedWebPushSubscriptionsCleaned: cleanupResult.deduplicatedCount,
      };
    } catch (error) {
      logger.error('Error sending notification to user:', error);
      return {
        success: 0,
        failed: 1,
        deliverableDeviceCount: 0,
        onlineDeliverableCount: 0,
        presenceDeliveredCount: 0,
        pushAcceptedCount: 0,
        mobilePushAcceptedCount: 0,
        webPushAcceptedCount: 0,
        staleWebPushSubscriptionsCleaned: 0,
        deduplicatedWebPushSubscriptionsCleaned: 0,
      };
    }
  }

  /**
   * Cleanup offline devices (remove devices offline for more than 14 days)
   */
  async cleanupOfflineDevices(): Promise<void> {
    try {
      const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      
      // Query all user documents to get all users
      const usersQuery = query(collection(firestore, 'user_devices'));
      const usersSnapshot = await getDocs(usersQuery);
      
      for (const userDoc of usersSnapshot.docs) {
        const userEmail = userDoc.id;
        
        // Get all devices for this user from subcollection
        const devicesCollection = collection(firestore, 'user_devices', userEmail, 'devices');
        const devicesSnapshot = await getDocs(devicesCollection);
        
        let cleanedCount = 0;
        
        for (const deviceDoc of devicesSnapshot.docs) {
          const device = deviceDoc.data() as UserDevice;
          const lastSeenDate = device.lastSeen instanceof Timestamp 
            ? device.lastSeen.toDate() 
            : new Date(device.lastSeen);
          
          if (!device.isOnline && lastSeenDate < fourteenDaysAgo) {
            // Delete the device document from subcollection
            await deleteDoc(deviceDoc.ref);
            cleanedCount++;
            logger.debug('Cleaned up old device:', deviceDoc.id);
          }
        }
        
        if (cleanedCount > 0) {
          // Update user's device count
          const remainingDevices = await this.getTotalDevicesCount(userEmail);
          const userDocRef = doc(firestore, 'user_devices', userEmail);
          await updateDoc(userDocRef, {
            totalDevices: remainingDevices,
            lastActivity: this.createResolvedTimestamp()
          });
        }
      }
    } catch (error) {
      logger.error('Error cleaning up offline devices:', error);
    }
  }

  /**
   * Cleanup expired device bans (remove bans that have expired)
   */
  async cleanupExpiredDeviceBans(): Promise<void> {
    try {
      logger.debug('🧹 Starting cleanup of expired device bans...');
      
      // Query for all active bans that have an expiration date
      const expiredBansQuery = query(
        collection(firestore, 'device_bans'),
        where('isActive', '==', true),
        where('expiresAt', '!=', null)
      );

      const expiredBansSnapshot = await getDocs(expiredBansQuery);
      let cleanedCount = 0;
      
      for (const banDoc of expiredBansSnapshot.docs) {
        const banData = banDoc.data();
        
        if (banData.expiresAt) {
          const expirationDate = banData.expiresAt instanceof Timestamp 
            ? banData.expiresAt.toDate() 
            : new Date(banData.expiresAt);
          
          // Check if ban has expired
          if (new Date() > expirationDate) {
            // Deactivate expired ban
            await updateDoc(banDoc.ref, { 
              isActive: false,
              expiredAt: this.createResolvedTimestamp(),
              expiredBy: 'system',
              expiredReason: 'Automatic cleanup - ban expired'
            });
            
            cleanedCount++;
            logger.debug(`🧹 Deactivated expired ban: ${banDoc.id} (expired: ${expirationDate.toISOString()})`);
          }
        }
      }
      
      logger.debug(`✅ Cleanup completed: ${cleanedCount} expired bans deactivated`);
    } catch (error) {
      logger.error('❌ Error cleaning up expired device bans:', error);
    }
  }

  /**
   * Comprehensive cleanup - runs all cleanup operations
   */
  async performComprehensiveCleanup(): Promise<void> {
    try {
      logger.debug('🧹 Starting comprehensive cleanup...');
      
      // Run all cleanup operations
      await this.cleanupOfflineDevices();
      await this.cleanupExpiredDeviceBans();
      
      logger.debug('✅ Comprehensive cleanup completed');
    } catch (error) {
      logger.error('❌ Error during comprehensive cleanup:', error);
    }
  }

  // Private helper methods

  /**
   * Get basic device information
   */
  private async getBasicDeviceInfo() {
    try {
      const deviceType = this.getDeviceType();
      const deviceName = await this.getDeviceName();
      
      // Get app version information
      let appVersion = '1.0.0';
      let nativeAppVersion: string | undefined;
      let nativeBuildVersion: string | undefined;
      let expoVersion: string | undefined;

      try {
        if (Platform.OS !== 'web') {
          nativeAppVersion = Application.nativeApplicationVersion || undefined;
          nativeBuildVersion = Application.nativeBuildVersion || undefined;
          appVersion = nativeAppVersion || '1.0.0';
        } else {
          // Web: use build-driven env metadata for consistency with Settings UI
          const envAppVersion = (process.env.EXPO_PUBLIC_APP_VERSION || '').trim();
          const envAppBuild = (process.env.EXPO_PUBLIC_APP_BUILD || '').trim();
          appVersion = envAppVersion || '1.0.0';
          // Reuse nativeBuildVersion field to store web build value for analytics consistency
          nativeBuildVersion = envAppBuild || undefined;
        }
        expoVersion = undefined; // Will be set if available
      } catch (error) {
        logger.warn('Failed to get app version info:', error);
        appVersion = '1.0.0';
      }

      return {
        deviceType,
        deviceName,
        appVersion,
        nativeAppVersion,
        nativeBuildVersion,
        expoVersion
      };
    } catch (error) {
      logger.error('Error getting basic device info:', error);
      return {
        deviceType: 'mobile' as const,
        deviceName: `${Platform.OS} Device`,
        appVersion: '1.0.0'
      };
    }
  }

  /**
   * Get hardware information
   */
  private async getHardwareInfo() {
    try {
      const hardwareInfo: any = {};

      if (Platform.OS !== 'web') {
        // Device hardware details
        hardwareInfo.brand = Device.brand || undefined;
        hardwareInfo.manufacturer = Device.manufacturer || undefined;
        hardwareInfo.modelName = Device.modelName || undefined;
        hardwareInfo.modelId = Device.modelId || undefined;
        hardwareInfo.designName = Device.designName || undefined;
        hardwareInfo.productName = Device.productName || undefined;
        
        // Memory information
        try {
          hardwareInfo.totalMemory = Device.totalMemory || undefined;
        } catch (error) {
          logger.warn('Failed to get memory info:', error);
        }

        // CPU architecture
        try {
          hardwareInfo.supportedCpuArchitectures = Device.supportedCpuArchitectures || undefined;
        } catch (error) {
          logger.warn('Failed to get CPU architecture info:', error);
        }
      } else {
        // Web-specific hardware information
        if (typeof navigator !== 'undefined') {
          hardwareInfo.platform = navigator.platform;
          hardwareInfo.hardwareConcurrency = navigator.hardwareConcurrency; // CPU cores
          
          // Extract system info from user agent
          const userAgent = navigator.userAgent;
          hardwareInfo.brand = this.getBrowserFromUserAgent(userAgent);
          hardwareInfo.modelName = `${hardwareInfo.brand} Browser`;
          
          // Memory information (if available)
          if ('memory' in performance) {
            const memory = (performance as any).memory;
            hardwareInfo.jsHeapSizeLimit = memory?.jsHeapSizeLimit;
            hardwareInfo.totalJSHeapSize = memory?.totalJSHeapSize;
          }
        }
      }

      return hardwareInfo;
    } catch (error) {
      logger.error('Error getting hardware info:', error);
      return {};
    }
  }

  /**
   * Get system information
   */
  private async getSystemInfo() {
    try {
      const systemInfo: any = {};

      if (Platform.OS !== 'web') {
        systemInfo.osName = Device.osName || undefined;
        systemInfo.osVersion = Device.osVersion || undefined;
        systemInfo.osBuildId = Device.osBuildId || undefined;
      } else {
        // For web, extract OS info from user agent
        const userAgent = navigator.userAgent;
        systemInfo.osName = this.getOSFromUserAgent(userAgent);
        systemInfo.osVersion = this.getOSVersionFromUserAgent(userAgent);
      }

      return systemInfo;
    } catch (error) {
      logger.error('Error getting system info:', error);
      return {};
    }
  }

  /**
   * Get network information
   */
  private async getNetworkInfo() {
    try {
      const networkInfo: any = {};

      try {
        // Get IP address
        const networkState = await Network.getNetworkStateAsync();
        networkInfo.networkType = networkState.type || undefined;
        
        // Get IP address (this might not work in all environments)
        try {
          const ipResponse = await fetch('https://api.ipify.org?format=json');
          const ipData = await ipResponse.json();
          networkInfo.ipAddress = ipData.ip || undefined;
        } catch (error) {
          logger.warn('Failed to get IP address:', error);
        }

        // Get carrier info for cellular
        if (Platform.OS !== 'web' && networkState.type === Network.NetworkStateType.CELLULAR) {
          try {
            networkInfo.carrierName = await Network.getNetworkStateAsync().then(state => 
              (state as any).carrierName || undefined
            );
          } catch (error) {
            logger.warn('Failed to get carrier info:', error);
          }
        }
      } catch (error) {
        logger.warn('Failed to get network info:', error);
      }

      return networkInfo;
    } catch (error) {
      logger.error('Error getting network info:', error);
      return {};
    }
  }

  /**
   * Get location and localization information
   */
  private async getLocationInfo() {
    try {
      const locationInfo: any = {};

      try {
        const locales = Localization.getLocales();
        const primaryLocale = locales[0];
        if (primaryLocale) {
          locationInfo.countryCode = primaryLocale.regionCode || undefined;
          locationInfo.locale = primaryLocale.languageTag || undefined;
        }
        locationInfo.timezone = Localization.getCalendars()[0]?.timeZone || undefined;
      } catch (error) {
        logger.warn('Failed to get localization info:', error);
      }

      return locationInfo;
    } catch (error) {
      logger.error('Error getting location info:', error);
      return {};
    }
  }

  /**
   * Get screen information
   */
  private getScreenInfo() {
    try {
      const screenInfo: any = {};

      if (Platform.OS === 'web') {
        screenInfo.screenWidth = window.screen.width;
        screenInfo.screenHeight = window.screen.height;
        screenInfo.screenScale = window.devicePixelRatio || 1;
      } else {
        // For mobile, screen info will be available via other means at runtime
        // We'll leave this for now as it's not critical
        screenInfo.screenWidth = undefined;
        screenInfo.screenHeight = undefined;
        screenInfo.screenScale = undefined;
      }

      return screenInfo;
    } catch (error) {
      logger.error('Error getting screen info:', error);
      return {};
    }
  }

  /**
   * Get browser information (web only)
   */
  private getBrowserInfo() {
    try {
      if (Platform.OS !== 'web') return {};

      const userAgent = navigator.userAgent;
      const browserInfo: any = {
        userAgent,
        browserName: this.getBrowserFromUserAgent(userAgent),
        browserVersion: this.getBrowserVersionFromUserAgent(userAgent)
      };

      // Additional web-specific information
      if (typeof window !== 'undefined') {
        // Browser capabilities
        browserInfo.cookieEnabled = navigator.cookieEnabled;
        browserInfo.javaEnabled = typeof navigator.javaEnabled === 'function' ? navigator.javaEnabled() : false;
        browserInfo.language = navigator.language;
        browserInfo.languages = navigator.languages?.join(', ');
        browserInfo.onLine = navigator.onLine;
        browserInfo.doNotTrack = navigator.doNotTrack;
        
        // Screen and viewport info
        browserInfo.viewportWidth = window.innerWidth;
        browserInfo.viewportHeight = window.innerHeight;
        browserInfo.colorDepth = screen.colorDepth;
        browserInfo.pixelDepth = screen.pixelDepth;
        
        // Platform info
        browserInfo.platform = navigator.platform;
        browserInfo.vendor = navigator.vendor;
        
        // Connection info (if available)
        if ('connection' in navigator) {
          const connection = (navigator as any).connection;
          browserInfo.connectionType = connection?.effectiveType;
          browserInfo.downlink = connection?.downlink;
        }
        
        // Hardware concurrency (CPU cores)
        browserInfo.hardwareConcurrency = navigator.hardwareConcurrency;
        
        // Memory info (if available)
        if ('memory' in performance) {
          const memory = (performance as any).memory;
          browserInfo.jsHeapSizeLimit = memory?.jsHeapSizeLimit;
          browserInfo.totalJSHeapSize = memory?.totalJSHeapSize;
          browserInfo.usedJSHeapSize = memory?.usedJSHeapSize;
        }
        
        // Touch support
        browserInfo.touchSupport = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        browserInfo.maxTouchPoints = navigator.maxTouchPoints;
        
        // URL and source tracking
        browserInfo.currentUrl = window.location.href;
        browserInfo.referrer = document.referrer || 'Direct Access';
        browserInfo.hostname = window.location.hostname;
        browserInfo.pathname = window.location.pathname;
        browserInfo.search = window.location.search;
        browserInfo.hash = window.location.hash;
        browserInfo.protocol = window.location.protocol;
        browserInfo.port = window.location.port || 'default';
        browserInfo.origin = window.location.origin;
        
        // Analyze source information
        const sourceInfo = this.getSourceInfo(browserInfo.referrer);
        browserInfo.source = sourceInfo.source;
        browserInfo.medium = sourceInfo.medium;
        if (sourceInfo.campaign) {
          browserInfo.campaign = sourceInfo.campaign;
        }
      }

      return browserInfo;
    } catch (error) {
      logger.error('Error getting browser info:', error);
      return { userAgent: 'Unknown' };
    }
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    return `session_${timestamp}_${random}`;
  }

  /**
   * Extract OS from user agent
   */
  private getOSFromUserAgent(userAgent: string): string {
    if (userAgent.includes('Windows')) return 'Windows';
    if (userAgent.includes('Mac OS')) return 'macOS';
    if (userAgent.includes('Linux')) return 'Linux';
    if (userAgent.includes('Android')) return 'Android';
    if (userAgent.includes('iPhone') || userAgent.includes('iPad')) return 'iOS';
    return 'Unknown';
  }

  /**
   * Extract OS version from user agent
   */
  private getOSVersionFromUserAgent(userAgent: string): string | undefined {
    const patterns = [
      /Windows NT (\d+\.\d+)/,
      /Mac OS X (\d+[._]\d+[._]\d+)/,
      /Android (\d+\.\d+)/,
      /OS (\d+[._]\d+)/ // iOS
    ];

    for (const pattern of patterns) {
      const match = userAgent.match(pattern);
      if (match) {
        return match[1].replace(/_/g, '.');
      }
    }

    return undefined;
  }

  /**
   * Extract browser from user agent
   */
  private getBrowserFromUserAgent(userAgent: string): string {
    if (userAgent.includes('Chrome')) return 'Chrome';
    if (userAgent.includes('Firefox')) return 'Firefox';
    if (userAgent.includes('Safari')) return 'Safari';
    if (userAgent.includes('Edge')) return 'Edge';
    if (userAgent.includes('Opera')) return 'Opera';
    return 'Unknown';
  }

  /**
   * Extract browser version from user agent
   */
  private getBrowserVersionFromUserAgent(userAgent: string): string | undefined {
    const patterns = [
      /Chrome\/(\d+\.\d+)/,
      /Firefox\/(\d+\.\d+)/,
      /Safari\/(\d+\.\d+)/,
      /Edge\/(\d+\.\d+)/,
      /Opera\/(\d+\.\d+)/
    ];

    for (const pattern of patterns) {
      const match = userAgent.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Get storage information
   */
  private async getStorageInfo() {
    try {
      const storageInfo: any = {};

      if (Platform.OS !== 'web') {
        // Mobile: Use react-native-device-info
        try {
          const freeStorage = await DeviceInfo.getFreeDiskStorage();
          const totalStorage = await DeviceInfo.getTotalDiskCapacity();
          
          storageInfo.freeStorage = freeStorage;
          storageInfo.totalStorage = totalStorage;
          storageInfo.usedStorage = totalStorage - freeStorage;
          if (totalStorage > 0) {
            storageInfo.storagePercentageUsed = (storageInfo.usedStorage / totalStorage) * 100;
          }
        } catch (error) {
          logger.warn('Failed to get storage info:', error);
        }
      } else {
        // Web: Use Navigator Storage API
        try {
          if ('storage' in navigator && 'estimate' in navigator.storage) {
            const estimate = await navigator.storage.estimate();
            if (estimate.quota && estimate.usage) {
              storageInfo.totalStorage = estimate.quota;
              storageInfo.usedStorage = estimate.usage;
              storageInfo.freeStorage = estimate.quota - estimate.usage;
              if (estimate.quota > 0) {
                storageInfo.storagePercentageUsed = (estimate.usage / estimate.quota) * 100;
              }
            }
          }
        } catch (error) {
          logger.warn('Failed to get web storage info:', error);
        }
      }

      return storageInfo;
    } catch (error) {
      logger.error('Error getting storage info:', error);
      return {};
    }
  }

  /**
   * Get device orientation and motion information
   */
  private getOrientationInfo() {
    try {
      const orientationInfo: any = {};

      if (Platform.OS !== 'web') {
        // Mobile: Use Dimensions and react-native APIs
        const { width, height } = Dimensions.get('window');
        orientationInfo.currentOrientation = width > height ? 'landscape' : 'portrait';
        orientationInfo.orientationLocked = false; // Would need additional packages to detect lock
        orientationInfo.orientationChangeSupported = true;
        orientationInfo.motionSupport = true; // Most mobile devices support motion
      } else {
        // Web: Use screen orientation API
        try {
          if (screen.orientation) {
            orientationInfo.currentOrientation = screen.orientation.type;
            orientationInfo.orientationLocked = screen.orientation.angle !== undefined;
            orientationInfo.orientationAngle = screen.orientation.angle;
            orientationInfo.orientationChangeSupported = true;
          } else {
            // Fallback for older browsers
            const { innerWidth, innerHeight } = window;
            orientationInfo.currentOrientation = innerWidth > innerHeight ? 'landscape' : 'portrait';
            orientationInfo.orientationChangeSupported = 'onorientationchange' in window;
          }
          
          // Check for DeviceMotionEvent support
          orientationInfo.motionSupport = typeof DeviceMotionEvent !== 'undefined';
        } catch (error) {
          logger.warn('Failed to get orientation info:', error);
        }
      }

      return orientationInfo;
    } catch (error) {
      logger.error('Error getting orientation info:', error);
      return {};
    }
  }

  /**
   * Get enhanced web capabilities
   */
  private getWebCapabilities() {
    try {
      if (Platform.OS !== 'web') return {};

      const capabilities: any = {};

      // WebGL support
      try {
        const canvas = document.createElement('canvas');
        capabilities.webGLSupport = !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
        capabilities.webGL2Support = !!canvas.getContext('webgl2');
      } catch (error) {
        capabilities.webGLSupport = false;
        capabilities.webGL2Support = false;
      }

      // WebRTC support
      capabilities.webRTCSupport = !!(
        navigator.mediaDevices && 
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        window.RTCPeerConnection
      );

      capabilities.webAssemblySupport = typeof WebAssembly === 'object';

      capabilities.sessionStorageSupport = typeof window.sessionStorage !== 'undefined';
      capabilities.indexedDBSupport = !!window.indexedDB;
      capabilities.webSocketsSupport = !!window.WebSocket;
      capabilities.geolocationSupport = 'geolocation' in navigator;
      capabilities.deviceMotionSupport = 'DeviceMotionEvent' in window;
      capabilities.deviceOrientationSupport = 'DeviceOrientationEvent' in window;
      capabilities.pushNotificationsSupport = 'PushManager' in window;
      capabilities.webShareSupport = 'share' in navigator;
      capabilities.mediaDevicesSupport = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
      capabilities.webBluetoothSupport = 'bluetooth' in navigator;
      capabilities.webUSBSupport = 'usb' in navigator;
      capabilities.webNFCSupport = 'nfc' in navigator;

      // Service Worker support
      capabilities.serviceWorkerSupport = 'serviceWorker' in navigator;

      // Local Storage support
      try {
        const testKey = 'test';
        localStorage.setItem(testKey, 'test');
        localStorage.removeItem(testKey);
        capabilities.localStorageSupport = true;
      } catch (error) {
        capabilities.localStorageSupport = false;
      }

      return capabilities;
    } catch (error) {
      logger.error('Error getting web capabilities:', error);
      return {};
    }
  }

  /**
   * Get device permissions status
   */
  private async getPermissionsInfo() {
    try {
      const permissions: any = {};

      if (Platform.OS !== 'web') {
        // Mobile: Check Expo permissions
        try {
          // Location permission
          const locationPermission = await Location.getForegroundPermissionsAsync();
          permissions.locationPermission = locationPermission.status;

          // Notification permission
          const notificationPermission = await Notifications.getPermissionsAsync();
          permissions.notificationPermission = notificationPermission.status;

          // Camera permission - using expo-image-picker which handles camera access
          try {
            const cameraPermission = await ImagePicker.getCameraPermissionsAsync();
            permissions.cameraPermission = cameraPermission.status;
          } catch (error) {
            logger.warn('Failed to get camera permission:', error);
            permissions.cameraPermission = 'unknown';
          }

          // Microphone permission - using expo-audio
          try {
            const micPermission = await getAudioRecordingPermissionsAsync();
            permissions.microphonePermission = micPermission.status as any;
          } catch (error) {
            logger.warn('Failed to get microphone permission:', error);
            permissions.microphonePermission = 'unknown';
          }
        } catch (error) {
          logger.warn('Failed to get mobile permissions:', error);
        }
      } else {
        // Web: Check browser permissions API
        try {
          if ('permissions' in navigator) {
            // Location permission
            try {
              const locationPerm = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
              permissions.locationPermission = locationPerm.state;
            } catch (error) {
              permissions.locationPermission = 'unknown';
            }

            // Notification permission
            if ('Notification' in window) {
              permissions.notificationPermission = Notification.permission;
            }

            // Camera permission
            try {
              const cameraPerm = await navigator.permissions.query({ name: 'camera' as PermissionName });
              permissions.cameraPermission = cameraPerm.state;
            } catch (error) {
              permissions.cameraPermission = 'unknown';
            }

            // Microphone permission
            try {
              const micPerm = await navigator.permissions.query({ name: 'microphone' as PermissionName });
              permissions.microphonePermission = micPerm.state;
            } catch (error) {
              permissions.microphonePermission = 'unknown';
            }
          }
        } catch (error) {
          logger.warn('Failed to get web permissions:', error);
        }
      }

      return permissions;
    } catch (error) {
      logger.error('Error getting permissions info:', error);
      return {};
    }
  }

  private async getOrCreateDeviceId(userEmail?: string): Promise<string> {
    try {
      if (!userEmail) {
        logger.warn('No user email provided for device ID generation, using fallback');
        // Fallback to timestamp-based ID if no user email
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        this.currentDeviceIdSource = 'unknown';
        return `${Platform.OS}_unknown_${timestamp}_${random}`;
      }

      // Create user-specific storage key
      const userDeviceIdKey = `${this.DEVICE_ID_KEY_PREFIX}${this.hashEmail(userEmail)}`;
      const userDeviceIdSourceKey = `${userDeviceIdKey}${this.DEVICE_ID_SOURCE_KEY_SUFFIX}`;
      
      // First check if we have a cached device ID in AsyncStorage
      let deviceId = await AsyncStorage.getItem(userDeviceIdKey);
      const deviceIdSource = await AsyncStorage.getItem(userDeviceIdSourceKey);
      if (deviceId) {
        // Verify that cached device ID matches the expected format for this user
        const expectedPrefix = `${Platform.OS}_${this.hashEmail(userEmail)}_`;
        if (deviceId.startsWith(expectedPrefix)) {
          if (deviceIdSource === 'stable_seed' || deviceIdSource === 'fingerprint_fallback') {
            this.currentDeviceIdSource = deviceIdSource;
            this.currentDeviceSeedHash = deviceIdSource === 'stable_seed'
              ? await this.getDeviceSeedHash()
              : null;
          } else {
            let detectedSource: 'stable_seed' | 'fingerprint_fallback' = 'fingerprint_fallback';
            const cachedHash = deviceId.split('_').slice(2).join('_');
            const existingSeed = await this.readDeviceSeed();
            if (existingSeed) {
              const stableHash = this.hashFingerprintData(existingSeed);
              if (cachedHash === stableHash) {
                detectedSource = 'stable_seed';
              }
            }
            this.currentDeviceIdSource = detectedSource;
            this.currentDeviceSeedHash = detectedSource === 'stable_seed'
              ? await this.getDeviceSeedHash()
              : null;
            await AsyncStorage.setItem(userDeviceIdSourceKey, detectedSource);
          }
          return deviceId;
        }
        // If cached ID doesn't match current user, generate new one
        logger.debug('Cached device ID format mismatch, generating new one');
      }

      const existingRecord = await this.findExistingDeviceRecordByFallback(userEmail);
      if (existingRecord) {
        this.currentDeviceIdSource = existingRecord.source;
        this.currentDeviceSeedHash = existingRecord.deviceSeedHash ?? null;
        deviceId = existingRecord.deviceId;
        await AsyncStorage.setItem(userDeviceIdKey, deviceId);
        await AsyncStorage.setItem(userDeviceIdSourceKey, this.currentDeviceIdSource);
        return deviceId;
      }

      // Generate new device ID based on user + device fingerprint
      const generated = await this.generateConsistentDeviceId(userEmail);
      deviceId = generated.deviceId;
      this.currentDeviceIdSource = generated.source;
      this.currentDeviceSeedHash = generated.source === 'stable_seed'
        ? await this.getDeviceSeedHash()
        : null;
      
      // Cache the generated ID for faster access
      await AsyncStorage.setItem(userDeviceIdKey, deviceId);
      await AsyncStorage.setItem(userDeviceIdSourceKey, this.currentDeviceIdSource);
      return deviceId;
    } catch (error) {
      logger.warn('AsyncStorage not available, generating consistent device ID without caching');
      if (!userEmail) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        this.currentDeviceIdSource = 'unknown';
        return `${Platform.OS}_unknown_${timestamp}_${random}`;
      }
      const generated = await this.generateConsistentDeviceId(userEmail);
      this.currentDeviceIdSource = generated.source;
      this.currentDeviceSeedHash = generated.source === 'stable_seed'
        ? await this.getDeviceSeedHash()
        : null;
      return generated.deviceId;
    }
  }

  /**
   * Generate a simple hash of email for device ID (shorter than full email)
   */
  private hashEmail(email: string): string {
    let hash = 0;
    for (let i = 0; i < email.length; i++) {
      const char = email.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36).substring(0, 6); // Take first 6 characters
  }

  /**
   * Generate a consistent device ID based on user email + device fingerprint
   * This ensures the same physical device gets the same ID for the same user
   * Format: platform_userhash_devicefingerprint
   */
  private async generateConsistentDeviceId(
    userEmail: string
  ): Promise<{ deviceId: string; source: 'stable_seed' | 'fingerprint_fallback' }> {
    try {
      const userHash = this.hashEmail(userEmail);
      const stableSeed = await this.getOrCreateDeviceSeed();
      if (stableSeed) {
        const stableHash = this.hashFingerprintData(stableSeed);
        logger.debug('Device ID source: stable seed', { platform: Platform.OS, userHash });
        return { deviceId: `${Platform.OS}_${userHash}_${stableHash}`, source: 'stable_seed' };
      }

      const deviceForId = await this.getFingerprintBaseForCurrentDevice();
      const fingerprintHash = this.computeFallbackFingerprintHash(deviceForId);
      logger.debug('Device ID source: fingerprint fallback', { platform: Platform.OS, userHash });
      
      // Create a readable device ID: platform_userhash_devicefingerprint
      return { deviceId: `${Platform.OS}_${userHash}_${fingerprintHash}`, source: 'fingerprint_fallback' };
    } catch (error) {
      logger.error('Error generating consistent device ID, falling back to timestamp-based ID:', error);
      // Fallback to timestamp-based ID if fingerprinting fails
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(2, 8);
      const userHash = this.hashEmail(userEmail);
      return { deviceId: `${Platform.OS}_${userHash}_${timestamp}_${random}`, source: 'fingerprint_fallback' };
    }
  }

  private getDeviceType(): 'mobile' | 'web' | 'tablet' {
    const platformOS = Platform.OS;
    logger.debug('🔍 DeviceTrackingService - getDeviceType():', {
      platformOS,
      isWeb: platformOS === 'web',
      deviceTypeResult: platformOS === 'web' ? 'web' : (Device?.deviceType === Device?.DeviceType?.TABLET ? 'tablet' : 'mobile')
    });
    
    if (platformOS === 'web') return 'web';
    if (Device.deviceType === Device.DeviceType.TABLET) return 'tablet';
    return 'mobile';
  }

  private async getDeviceName(): Promise<string> {
    try {
      if (Platform.OS === 'web') {
        return `${navigator.userAgent.includes('Chrome') ? 'Chrome' : 'Web'} Browser`;
      }
      return Device.deviceName || `${Platform.OS} Device`;
    } catch (error) {
      return `${Platform.OS} Device`;
    }
  }

  private getUserAgent(): string {
    try {
      return Platform.OS === 'web' ? navigator.userAgent : '';
    } catch (error) {
      return '';
    }
  }

  private async getTotalDevicesCount(userEmail: string): Promise<number> {
    try {
      const devicesCollection = collection(firestore, 'user_devices', userEmail, 'devices');
      const devicesSnap = await getDocs(devicesCollection);
      return devicesSnap.size;
    } catch (error) {
      return 0;
    }
  }

  private extractDisplayName(email: string): string {
    if (!email) return 'Unknown User';
    
    const username = email.split('@')[0];
    return username
      .split(/[._-]/)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private normalizeFingerprintValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value.toString() : '';
    }
    return String(value).trim().toLowerCase();
  }

  private hashFingerprintData(input: string): string {
    return SHA256(input).toString().slice(0, 20);
  }

  private computeFallbackFingerprintHash(device: Partial<UserDevice>): string {
    const fingerprintData = [
      device.userAgent,
      device.manufacturer,
      device.modelName,
      device.modelId,
      device.hardwareConcurrency,
      device.totalMemory,
      device.screenWidth,
      device.screenHeight,
      device.supportedCpuArchitectures?.join(',') || '',
      device.jsHeapSizeLimit,
      device.platform,
      device.vendor
    ]
      .map((value) => this.normalizeFingerprintValue(value))
      .filter(Boolean)
      .join('|');

    return this.hashFingerprintData(fingerprintData);
  }

  private async generateRandomSeed(): Promise<string> {
    try {
      const bytes = await Crypto.getRandomBytesAsync(16);
      return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    } catch (error) {
      logger.warn('Failed to generate cryptographic seed, using fallback', error);
      return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  private async readDeviceSeed(): Promise<string | null> {
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(this.DEVICE_SEED_KEY);
      }

      if (Platform.OS !== 'web' && typeof SecureStore?.getItemAsync === 'function') {
        return await SecureStore.getItemAsync(this.DEVICE_SEED_KEY);
      }

      return await AsyncStorage.getItem(this.DEVICE_SEED_KEY);
    } catch (error) {
      logger.warn('Failed to read device seed', error);
      return null;
    }
  }

  private async writeDeviceSeed(seed: string): Promise<void> {
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(this.DEVICE_SEED_KEY, seed);
        return;
      }

      if (Platform.OS !== 'web' && typeof SecureStore?.setItemAsync === 'function') {
        await SecureStore.setItemAsync(this.DEVICE_SEED_KEY, seed);
        return;
      }

      await AsyncStorage.setItem(this.DEVICE_SEED_KEY, seed);
    } catch (error) {
      logger.warn('Failed to persist device seed', error);
    }
  }

  private async getOrCreateDeviceSeed(): Promise<string | null> {
    let seed = await this.readDeviceSeed();
    if (seed) return seed;

    seed = await this.generateRandomSeed();
    await this.writeDeviceSeed(seed);
    return seed;
  }

  private async getDeviceSeedHash(): Promise<string | null> {
    const seed = await this.readDeviceSeed();
    if (!seed) return null;
    return this.hashFingerprintData(seed);
  }

  private async getFingerprintBaseForCurrentDevice(): Promise<Partial<UserDevice>> {
    const hardwareInfo = await this.getHardwareInfo();
    const systemInfo = await this.getSystemInfo();
    const screenInfo = this.getScreenInfo();
    const browserInfo = this.getBrowserInfo();

    return {
      userAgent: browserInfo.userAgent || '',
      manufacturer: hardwareInfo.manufacturer || '',
      modelName: hardwareInfo.modelName || '',
      modelId: hardwareInfo.modelId || '',
      hardwareConcurrency: browserInfo.hardwareConcurrency || hardwareInfo.hardwareConcurrency,
      totalMemory: hardwareInfo.totalMemory,
      screenWidth: screenInfo.screenWidth,
      screenHeight: screenInfo.screenHeight,
      supportedCpuArchitectures: hardwareInfo.supportedCpuArchitectures,
      jsHeapSizeLimit: browserInfo.jsHeapSizeLimit,
      platform: browserInfo.platform || systemInfo.osName,
      vendor: browserInfo.vendor || ''
    };
  }

  private async findExistingDeviceRecordByFallback(
    userEmail: string
  ): Promise<{ deviceId: string; deviceSeedHash?: string; source: 'stable_seed' | 'fingerprint_fallback' } | null> {
    try {
      const fingerprintBase = await this.getFingerprintBaseForCurrentDevice();
      const fallbackHash = this.computeFallbackFingerprintHash(fingerprintBase);
      if (!fallbackHash) {
        return null;
      }

      const devicesCollection = collection(firestore, 'user_devices', userEmail, 'devices');
      const fallbackQuery = query(
        devicesCollection,
        where('fallbackFingerprintHash', '==', fallbackHash),
        limit(1)
      );
      const devicesSnap = await getDocs(fallbackQuery);
      if (!devicesSnap.empty) {
        const deviceDoc = devicesSnap.docs[0];
        const device = deviceDoc.data() as UserDevice;
        const deviceSeedHash = device.deviceSeedHash;
        const source = device.deviceIdSource === 'stable_seed' || deviceSeedHash
          ? 'stable_seed'
          : 'fingerprint_fallback';
        return { deviceId: deviceDoc.id, deviceSeedHash, source };
      }

      return null;
    } catch (error) {
      logger.warn('Failed to resolve existing device record by fallback fingerprint', error);
      return null;
    }
  }



  /**
   * Get current device ID
   */
  getCurrentDeviceId(): string | null {
    return this.currentDeviceId;
  }

  /**
   * Get current user email
   */
  getCurrentUserEmail(): string | null {
    return this.currentUserEmail;
  }

  /**
   * Extract source information from referrer (web only)
   */
  private getSourceInfo(referrer: string): { source: string; medium: string; campaign?: string } {
    if (!referrer || referrer === 'Direct Access') {
      return { source: 'direct', medium: 'none' };
    }

    try {
      const url = new URL(referrer);
      const hostname = url.hostname.toLowerCase();

      // Social media sources
      if (hostname.includes('facebook.com') || hostname.includes('fb.com')) {
        return { source: 'facebook', medium: 'social' };
      }
      if (hostname.includes('twitter.com') || hostname.includes('t.co')) {
        return { source: 'twitter', medium: 'social' };
      }
      if (hostname.includes('linkedin.com')) {
        return { source: 'linkedin', medium: 'social' };
      }
      if (hostname.includes('instagram.com')) {
        return { source: 'instagram', medium: 'social' };
      }
      if (hostname.includes('youtube.com')) {
        return { source: 'youtube', medium: 'video' };
      }
      if (hostname.includes('tiktok.com')) {
        return { source: 'tiktok', medium: 'social' };
      }

      // Search engines
      if (hostname.includes('google.com')) {
        return { source: 'google', medium: 'search' };
      }
      if (hostname.includes('bing.com')) {
        return { source: 'bing', medium: 'search' };
      }
      if (hostname.includes('yahoo.com')) {
        return { source: 'yahoo', medium: 'search' };
      }
      if (hostname.includes('duckduckgo.com')) {
        return { source: 'duckduckgo', medium: 'search' };
      }

      // Email providers
      if (hostname.includes('mail.google.com') || hostname.includes('gmail.com')) {
        return { source: 'gmail', medium: 'email' };
      }
      if (hostname.includes('outlook.com') || hostname.includes('live.com')) {
        return { source: 'outlook', medium: 'email' };
      }

      // Other common sources
      if (hostname.includes('github.com')) {
        return { source: 'github', medium: 'referral' };
      }

      // Generic referral
      return { source: hostname, medium: 'referral' };
    } catch (error) {
      return { source: 'unknown', medium: 'referral' };
    }
  }

  // ===== DEVICE MANAGEMENT METHODS =====

  /**
   * Mark device as deleted by admin (soft delete) - also performs force logout
   */
  async markDeviceAsDeleted(
    userEmail: string, 
    deviceId: string, 
    adminEmail: string, 
    adminName: string, 
    reason: string
  ): Promise<void> {
    try {
      // Get device from subcollection
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const deviceSnap = await getDoc(deviceDoc);
      
      if (!deviceSnap.exists()) {
        throw new Error('Device not found');
      }

      const device = deviceSnap.data() as UserDevice;

      // First force logout the device if it's online
      if (device.isOnline) {
        logger.debug(`Force logging out device ${deviceId} before deletion`);
        await this.forceLogoutDevice(userEmail, deviceId, adminEmail, adminName, `Device deletion: ${reason}`);
      }

      // Update device status in subcollection
      const updates = {
        isDeleted: true,
        deletedAt: this.createResolvedTimestamp(),
        deletedBy: adminEmail,
        deletedByName: adminName,
        deletionReason: reason,
        updatedAt: this.createResolvedTimestamp(),
        isOnline: false,
        logoutSignal: true, // Ensure logout signal is set
      };

      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);

      // Create logout signal for real-time detection (in case device comes online later)
      await this.createLogoutSignal(userEmail, deviceId, adminEmail, adminName, `Device deletion: ${reason}`);

      // Log the action
      await this.logDeviceAction({
        actionType: 'deleted',
        deviceId,
        userId: userEmail,
        adminEmail,
        adminName,
        reason,
        timestamp: this.createResolvedTimestamp(),
        deviceData: device
      });

      logger.debug(`Device ${deviceId} marked as deleted and logged out by admin ${adminName}`);
    } catch (error) {
      logger.error('Failed to mark device as deleted:', error);
      throw error;
    }
  }

  /**
   * Permanently delete a device and clean up related records
   */
  async deleteDevicePermanently(
    userEmail: string,
    deviceId: string,
    adminEmail: string,
    adminName: string,
    reason: string
  ): Promise<void> {
    try {
      // Fetch device to decide if we should force logout first
      const deviceDocRef = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const deviceSnap = await getDoc(deviceDocRef);
      if (!deviceSnap.exists()) {
        throw new Error('Device not found');
      }

      const device = deviceSnap.data() as UserDevice;

      // If online, try to force logout before deletion
      if (device.isOnline) {
        try {
          await this.forceLogoutDevice(
            userEmail,
            deviceId,
            adminEmail,
            adminName,
            `Permanent deletion: ${reason || 'No reason provided'}`
          );
        } catch (e) {
          logger.warn('Force logout before permanent delete failed, continuing with delete:', e);
        }
      }

      // Ensure a persistent logout signal exists with a TTL so returning devices are forced to logout
      try {
        const signalRef = doc(firestore, 'logout_signals', `${userEmail}_${deviceId}`);
        const nowPlus30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        const expiresAt = Timestamp.fromDate(nowPlus30Days);
        // Create or update the logout signal with persistent metadata
        await setDoc(
          signalRef,
          {
            userEmail,
            deviceId,
            adminEmail,
            adminName,
            reason: `Permanent deletion: ${reason || 'No reason provided'}`,
            createdAt: this.createResolvedTimestamp(),
            consumed: false,
            type: 'permanent_delete',
            persistent: true,
            expiresAt
          },
          { merge: true }
        );
      } catch (e) {
        logger.warn('Failed to set persistent logout signal during permanent delete:', e);
      }

      // Delete the device document
      await deleteDoc(deviceDocRef);

      // Delete related device actions for this device+user (best-effort)
      try {
        const actionsQ = query(
          collection(firestore, 'device_actions'),
          where('userId', '==', userEmail),
          where('deviceId', '==', deviceId)
        );
        const actionsSnap = await getDocs(actionsQ);
        const deletions: Promise<any>[] = [];
        actionsSnap.forEach((docSnap) => {
          deletions.push(deleteDoc(doc(firestore, 'device_actions', docSnap.id)));
        });
        if (deletions.length) await Promise.allSettled(deletions);
      } catch (e) {
        logger.warn('Best-effort cleanup of device_actions failed:', e);
      }

      // Update user's device count and last activity
      const totalDevices = await this.getTotalDevicesCount(userEmail);
      const userDocRef = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDocRef, {
        totalDevices,
        lastActivity: this.createResolvedTimestamp()
      });

      logger.debug(`Device ${deviceId} permanently deleted by ${adminName}`);
    } catch (error) {
      logger.error('Failed to permanently delete device:', error);
      throw error;
    }
  }

  /**
   * Get a specific device by ID
   */
  async getDeviceById(userEmail: string, deviceId: string): Promise<UserDevice | null> {
    try {
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const deviceSnap = await getDoc(deviceDoc);
      
      if (deviceSnap.exists()) {
        const deviceData = deviceSnap.data() as UserDevice;
        return {
          ...deviceData,
          deviceId: deviceSnap.id // Ensure deviceId is set from document ID
        };
      }
      return null;
    } catch (error) {
      logger.error('Failed to get device by ID:', error);
      return null;
    }
  }

  /**
   * Restore a deleted device automatically (internal method)
   */
  private async restoreDeletedDevice(userEmail: string, deviceId: string, reason: string): Promise<void> {
    try {
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const updates = {
        isDeleted: false,
        deletedBy: deleteField(),
        deletedByName: deleteField(),
        deletedAt: deleteField(),
        deletionReason: deleteField(),
        restoredAt: this.createResolvedTimestamp(),
        restorationReason: reason,
        updatedAt: this.createResolvedTimestamp()
      };

      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);

      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, { lastActivity: this.createResolvedTimestamp() });

      // Log the automatic restoration action
      await this.logDeviceAction({
        actionType: 'restored',
        deviceId,
        userId: userEmail,
        reason,
        timestamp: this.createResolvedTimestamp()
      });

      logger.debug(`Device ${deviceId} automatically restored: ${reason}`);
    } catch (error) {
      logger.error('Failed to restore deleted device:', error);
      throw error;
    }
  }

  /**
   * Restore a deleted device (admin action)
   * This method now automatically detects hard banned devices and calls the appropriate restoration method
   */
  async restoreDevice(
    userEmail: string, 
    deviceId: string, 
    adminEmail: string, 
    adminName: string
  ): Promise<void> {
    try {
      // First check if this device is hard banned
      const deviceForCheck = await this.getDeviceById(userEmail, deviceId);
      if (!deviceForCheck) {
        throw new Error('Device not found');
      }

      // Check if device is hard banned
      const banCheck = await this.isDeviceBannedForUser(deviceForCheck, userEmail);
      if (banCheck) {
        // If device is hard banned, call the hard ban restoration method instead
        await this.restoreHardBannedDevice(userEmail, deviceId, adminEmail, adminName);
        return;
      }

      // If not hard banned, proceed with regular device restoration
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const updates = {
        isDeleted: false,
        isRestored: true,
        restoredAt: this.createResolvedTimestamp(),
        updatedAt: this.createResolvedTimestamp(),
        // Clear deletion fields
        deletedAt: deleteField(),
        deletedBy: deleteField(),
        deletedByName: deleteField(),
        deletionReason: deleteField()
      };

      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);

      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, { lastActivity: this.createResolvedTimestamp() });

      // Log the action
      await this.logDeviceAction({
        actionType: 'restored',
        deviceId,
        userId: userEmail,
        adminEmail,
        adminName,
        timestamp: this.createResolvedTimestamp()
      });

      logger.debug(`Device ${deviceId} restored by admin ${adminName}`);
    } catch (error) {
      logger.error('Failed to restore device:', error);
      throw error;
    }
  }

  /**
   * Restore a hard banned device by deactivating its ban
   */
  async restoreHardBannedDevice(
    userEmail: string, 
    deviceId: string, 
    adminEmail: string, 
    adminName: string
  ): Promise<void> {
    try {
      // Get the device to find its fingerprint
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const deviceSnapshot = await getDoc(deviceDoc);
      
      if (!deviceSnapshot.exists()) {
        throw new Error('Device not found');
      }

      const device = deviceSnapshot.data() as UserDevice;
      const deviceFingerprint = await this.generateDeviceFingerprint(device);

      // Find and delete active bans for this user+device combination
      const bansQuery = query(
        collection(firestore, 'device_bans'),
        where('deviceFingerprint', '==', deviceFingerprint),
        where('targetUserEmail', '==', userEmail),
        where('isActive', '==', true)
      );

      const bansSnapshot = await getDocs(bansQuery);
      
      if (bansSnapshot.empty) {
        throw new Error('No active ban found for this device');
      }

      // Delete all matching ban documents completely
      const deletionPromises = [];
      for (const banDoc of bansSnapshot.docs) {
        const banData = banDoc.data();
        
        // Log the restoration before deleting the document
        await this.logDeviceAction({
          actionType: 'restored',
          deviceId,
          userId: userEmail,
          adminEmail,
          adminName,
          reason: `Hard ban restored and removed - Original reason: ${banData.reason || 'Unknown'}`,
          timestamp: this.createResolvedTimestamp()
        });
        
        deletionPromises.push(deleteDoc(banDoc.ref));
      }

      await Promise.all(deletionPromises);

      // Also restore the device if it was deleted during the ban process
      const updates = {
        isDeleted: false,
        isRestored: true,
        restoredAt: this.createResolvedTimestamp(),
        updatedAt: this.createResolvedTimestamp(),
        // Clear deletion fields if they exist
        deletedAt: deleteField(),
        deletedBy: deleteField(),
        deletedByName: deleteField(),
        deletionReason: deleteField()
      };

      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);

      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, { lastActivity: this.createResolvedTimestamp() });

      // Log the action
      await this.logDeviceAction({
        actionType: 'restored',
        deviceId,
        userId: userEmail,
        adminEmail,
        adminName,
        reason: 'Hard ban restored and ban document deleted',
        timestamp: this.createResolvedTimestamp()
      });

      logger.debug(`Hard banned device ${deviceId} restored and ban document deleted by admin ${adminName}`);
    } catch (error) {
      logger.error('Failed to restore hard banned device:', error);
      throw error;
    }
  }

  /**
   * Debug method to check ban documents for a specific device (public method for troubleshooting)
   */
  async debugDeviceBans(userEmail: string, deviceId: string): Promise<void> {
    try {
      logger.debug(`🔍 DEBUG: Checking ban documents for device ${deviceId} (user: ${userEmail})`);
      
      // Get the device to find its fingerprint
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const deviceSnapshot = await getDoc(deviceDoc);
      
      if (!deviceSnapshot.exists()) {
        logger.debug('❌ Device not found');
        return;
      }

      const device = deviceSnapshot.data() as UserDevice;
      const deviceFingerprint = await this.generateDeviceFingerprint(device);
      
      logger.debug(`📱 Device fingerprint: ${deviceFingerprint}`);
      
      // Query ALL ban documents for this fingerprint (not just active ones)
      const allBansQuery = query(
        collection(firestore, 'device_bans'),
        where('deviceFingerprint', '==', deviceFingerprint)
      );

      const allBansSnapshot = await getDocs(allBansQuery);
      logger.debug(`📋 Total ban documents found: ${allBansSnapshot.size}`);
      
      allBansSnapshot.docs.forEach((banDoc, index) => {
        const banData = banDoc.data();
        logger.debug(`🚫 Ban ${index + 1}:`, {
          id: banDoc.id,
          deviceFingerprint: banData.deviceFingerprint,
          targetUserEmail: banData.targetUserEmail,
          isActive: banData.isActive,
          createdAt: banData.createdAt,
          reason: banData.reason
        });
      });
      
      // Query active bans specifically for this user+device
      const activeBansQuery = query(
        collection(firestore, 'device_bans'),
        where('deviceFingerprint', '==', deviceFingerprint),
        where('targetUserEmail', '==', userEmail),
        where('isActive', '==', true)
      );

      const activeBansSnapshot = await getDocs(activeBansQuery);
      logger.debug(`⚡ Active ban documents for this user: ${activeBansSnapshot.size}`);
      
    } catch (error) {
      logger.error('❌ Debug ban check failed:', error);
    }
  }

  /**
   * Force logout all devices for a specific user
   */
  async forceLogoutAllUserDevices(
    userEmail: string,
    reason?: string
  ): Promise<void> {
    try {
      logger.debug(`🚨 Force logging out all devices for user: ${userEmail}`);
      
      // Get all devices from subcollection
      const devices = await this.getUserDevices(userEmail);
      
      if (devices.length === 0) {
        logger.debug(`No devices found for user: ${userEmail}`);
        return;
      }
      
      let loggedOutCount = 0;
      
      // Force logout each device
      for (const device of devices) {
        if (!device.isDeleted && device.isOnline) {
          try {
            await this.forceLogoutDevice(userEmail, device.deviceId, 'system', 'System Administrator', reason || 'User authorization removed');
            loggedOutCount++;
          } catch (error) {
            logger.error(`Failed to logout device ${device.deviceId}:`, error);
          }
        } else if (!device.isDeleted) {
          // For offline devices, just set logout signal for when they come online
          try {
            await this.createLogoutSignal(userEmail, device.deviceId, 'system', 'System Administrator', reason || 'User authorization removed');
          } catch (error) {
            logger.error(`Failed to create logout signal for device ${device.deviceId}:`, error);
          }
        }
      }
      
      logger.debug(`✅ Force logout completed for ${userEmail}: ${loggedOutCount} devices logged out, logout signals set for offline devices`);
    } catch (error) {
      logger.error('Failed to force logout all user devices:', error);
      throw error;
    }
  }

  /**
   * Force logout a device
   */
  async forceLogoutDevice(
    userEmail: string, 
    deviceId: string, 
    adminEmail: string, 
    adminName: string,
    reason?: string
  ): Promise<void> {
    try {
      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const updates = {
        lastSeen: this.createResolvedTimestamp(),
        updatedAt: this.createResolvedTimestamp(),
        lastActivityType: 'forced_logout',
        forcedLogoutBy: adminEmail,
        forcedLogoutByName: adminName,
        forcedLogoutAt: this.createResolvedTimestamp(),
        forcedLogoutReason: reason || 'Administrative action',
        logoutType: 'forced',
        logoutSignal: true, // Signal for client to logout
        isOnline: false, // Mark device as offline
        sessionActive: false,
        expoPushToken: deleteField(),
        pushTokenStatus: 'missing',
        needsExpoPushTokenRefresh: true,
        lastPushTokenErrorAt: this.createResolvedTimestamp(),
        lastPushTokenErrorCode: 'forced_logout',
        webPushSubscription: deleteField(),
        webPushStatus: 'unsubscribed',
        webPushVapidPublicKey: deleteField(),
        webPushSubscribedAt: deleteField(),
        webPushLastSyncedAt: deleteField(),
        webPushLastErrorAt: deleteField(),
        webPushLastErrorCode: deleteField(),
        webPushClientLastSubscriptionSyncAt: deleteField(),
        webPushClientLastSubscriptionContext: deleteField(),
        webPushClientLastSubscriptionPermission: deleteField(),
        webPushClientLastReceiptAt: deleteField(),
        webPushClientLastReceiptType: deleteField(),
        webPushClientLastReceiptNotificationId: deleteField(),
        webPushClientLastReceiptTag: deleteField(),
        webPushClientLastReceiptTitle: deleteField(),
        activeChatPartner: deleteField(),
        activeChatPartnerId: deleteField(),
        activeChatPartnerName: deleteField(),
        activeChatIsFocused: deleteField(),
        activeChatLastSeenAt: deleteField(),
        activeChatLastMessageId: deleteField(),
        activeChatLastMessageTimestamp: deleteField(),
      };

      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);

      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, { lastActivity: this.createResolvedTimestamp() });

      // Create a logout signal document for real-time detection
      await this.createLogoutSignal(userEmail, deviceId, adminEmail, adminName, reason);

      // Log the action
      await this.logDeviceAction({
        actionType: 'forced_logout',
        deviceId,
        userId: userEmail,
        adminEmail,
        adminName,
        reason: reason || 'Administrative force logout',
        timestamp: this.createResolvedTimestamp()
      });

      logger.debug(`Device ${deviceId} force logged out by admin ${adminName}`);
    } catch (error) {
      logger.error('Failed to force logout device:', error);
      throw error;
    }
  }

  /**
   * Create a logout signal for real-time detection by the target device
   */
  private async createLogoutSignal(
    userEmail: string, 
    deviceId: string, 
    adminEmail: string, 
    adminName: string,
    reason?: string
  ): Promise<void> {
    try {
      const signalDoc = doc(firestore, 'logout_signals', `${userEmail}_${deviceId}`);
      await setDoc(signalDoc, {
        userEmail,
        deviceId,
        adminEmail,
        adminName,
        reason: reason || 'Administrative action',
        createdAt: this.createResolvedTimestamp(),
        consumed: false
      });
    } catch (error) {
      logger.error('Failed to create logout signal:', error);
    }
  }

  /**
   * Check for logout signal (to be called by client apps)
   */
  async checkLogoutSignal(userEmail: string, deviceId: string): Promise<boolean> {
    try {
      const signalDoc = doc(firestore, 'logout_signals', `${userEmail}_${deviceId}`);
      const signalSnap = await getDoc(signalDoc);
      
      if (signalSnap.exists()) {
        const data = signalSnap.data();
        if (!data.consumed) {
          // Mark as consumed
          await updateDoc(signalDoc, { consumed: true, consumedAt: this.createResolvedTimestamp() });
          return true;
        }
      }
      return false;
    } catch (error) {
      logger.error('Failed to check logout signal:', error);
      return false;
    }
  }

  /**
   * Handle force logout - called when logout signal is received
   */
  private async handleForceLogout(): Promise<void> {
    try {
      logger.debug('Handling force logout...');
      
      // Stop heartbeat immediately
      this.stopHeartbeat();
      
      // Set device as offline
      if (this.currentUserEmail && this.currentDeviceId) {
        await this.updateDeviceStatus(this.currentUserEmail, this.currentDeviceId, false);
      }
      
      // Show toast notification to user
      if (Platform.OS === 'web') {
        // For web, show a simple alert since Toast might not work in all browsers
        alert('You have been logged out by an administrator.');
      } else {
        // For mobile, we could use Toast but we need to avoid circular dependencies
        logger.debug('Force logout: You have been logged out by an administrator');
      }
      
      // Clear current session data
      this.currentUserEmail = null;
      this.currentDeviceId = null;
      
      // Sign out the user
      await authService.signOut();
      
      logger.debug('Force logout completed');
    } catch (error) {
      logger.error('Error during force logout:', error);
    }
  }

  /**
   * Log device action for history tracking
   */
  private async logDeviceAction(action: Omit<DeviceAction, 'id'>): Promise<void> {
    try {
      const actionsCollection = collection(firestore, 'device_actions');
      await addDoc(actionsCollection, {
        ...action,
        timestamp: this.createResolvedTimestamp()
      });
    } catch (error) {
      logger.error('Failed to log device action:', error);
    }
  }

  /**
   * Get device action history
   */
  async getDeviceActionHistory(userEmail?: string): Promise<DeviceAction[]> {
    try {
      const actionsCollection = collection(firestore, 'device_actions');
      let q = query(actionsCollection);
      
      if (userEmail) {
        q = query(actionsCollection, where('userId', '==', userEmail));
      }
      
      const snapshot = await getDocs(q);
      const actions: DeviceAction[] = [];
      
      snapshot.forEach((doc) => {
        const data = doc.data();
        actions.push({
          id: doc.id,
          ...data,
          timestamp: data.timestamp instanceof Timestamp ? data.timestamp : new Date(data.timestamp)
        } as DeviceAction);
      });
      
      // Sort by timestamp (most recent first)
      return actions.sort((a, b) => {
        const aTime = a.timestamp instanceof Timestamp ? a.timestamp.toDate() : a.timestamp;
        const bTime = b.timestamp instanceof Timestamp ? b.timestamp.toDate() : b.timestamp;
        return bTime.getTime() - aTime.getTime();
      });
    } catch (error) {
      logger.error('Failed to get device action history:', error);
      return [];
    }
  }

  /**
   * Get logout history for a specific device or user
   */
  async getLogoutHistory(userEmail?: string, deviceId?: string): Promise<DeviceAction[]> {
    try {
      const actionsCollection = collection(firestore, 'device_actions');
      let q = query(actionsCollection);
      
      // Filter by logout actions
      q = query(q, where('actionType', 'in', ['logout', 'forced_logout']));
      
      // Filter by user if specified
      if (userEmail) {
        q = query(q, where('userId', '==', userEmail));
      }
      
      // Filter by device if specified
      if (deviceId) {
        q = query(q, where('deviceId', '==', deviceId));
      }
      
      // Order by timestamp (newest first)
      q = query(q, orderBy('timestamp', 'desc'), limit(50));
      
      const querySnapshot = await getDocs(q);
      const logoutActions: DeviceAction[] = [];
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        logoutActions.push({
          id: doc.id,
          ...data,
          timestamp: data.timestamp
        } as DeviceAction);
      });

      // Sort by timestamp (newest first)
      return logoutActions.sort((a, b) => {
        const aTime = a.timestamp instanceof Timestamp ? a.timestamp.toDate() : a.timestamp;
        const bTime = b.timestamp instanceof Timestamp ? b.timestamp.toDate() : b.timestamp;
        return bTime.getTime() - aTime.getTime();
      });
    } catch (error) {
      logger.error('Failed to get logout history:', error);
      return [];
    }
  }

  /**
   * Log user logout from app settings
   */
  async logUserLogout(userEmail: string, deviceId: string): Promise<void> {
    try {
      // Update device status with logout information
      if (Platform.OS === 'web' && this.currentUserEmail === userEmail && this.currentDeviceId === deviceId) {
        await this.unregisterCurrentWebPushSubscription('logged_out');
      }

      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', deviceId);
      const updates = {
        lastSeen: this.createResolvedTimestamp(),
        updatedAt: this.createResolvedTimestamp(),
        lastActivityType: 'logout',
        manualLogoutAt: this.createResolvedTimestamp(),
        logoutType: 'manual',
        isOnline: false,
        sessionActive: false,
        expoPushToken: deleteField(),
        pushTokenStatus: 'missing',
        needsExpoPushTokenRefresh: true,
        lastPushTokenErrorAt: this.createResolvedTimestamp(),
        lastPushTokenErrorCode: 'logged_out',
        webPushSubscription: deleteField(),
        webPushStatus: 'unsubscribed',
        webPushVapidPublicKey: deleteField(),
        webPushSubscribedAt: deleteField(),
        webPushLastSyncedAt: deleteField(),
        webPushLastErrorAt: deleteField(),
        webPushLastErrorCode: deleteField(),
        webPushClientLastSubscriptionSyncAt: deleteField(),
        webPushClientLastSubscriptionContext: deleteField(),
        webPushClientLastSubscriptionPermission: deleteField(),
        webPushClientLastReceiptAt: deleteField(),
        webPushClientLastReceiptType: deleteField(),
        webPushClientLastReceiptNotificationId: deleteField(),
        webPushClientLastReceiptTag: deleteField(),
        webPushClientLastReceiptTitle: deleteField(),
        activeChatPartner: deleteField(),
        activeChatPartnerId: deleteField(),
        activeChatPartnerName: deleteField(),
        activeChatIsFocused: deleteField(),
        activeChatLastSeenAt: deleteField(),
        activeChatLastMessageId: deleteField(),
        activeChatLastMessageTimestamp: deleteField(),
      };

      const cleanUpdates = this.cleanUndefinedValues(updates);
      await updateDoc(deviceDoc, cleanUpdates);

      // Update user's last activity
      const userDoc = doc(firestore, 'user_devices', userEmail);
      await updateDoc(userDoc, { lastActivity: this.createResolvedTimestamp() });
      
      // Log the action
      await this.logDeviceAction({
        actionType: 'logout',
        deviceId,
        userId: userEmail,
        timestamp: this.createResolvedTimestamp()
      });
      
      if (this.currentUserEmail === userEmail && this.currentDeviceId === deviceId) {
        // Clear local state
        this.currentUserEmail = null;
        this.currentDeviceId = null;
        this.stopHeartbeat();
      }
      
      logger.debug('User logged out manually and device updated');
    } catch (error) {
      logger.error('Failed to log user logout:', error);
    }
  }

  /**
   * Get all users with their devices (admin only)
   */
  async getAllUsers(options?: DeviceTenantFilterOptions): Promise<AuthorizedUser[]> {
    try {
      const usersQuery = query(collection(firestore, 'user_devices'));
      const usersSnapshot = await getDocs(usersQuery);
      const users: AuthorizedUser[] = [];
      
      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        const userEmail = userData.userId || userDoc.id;
        // Get devices from subcollection
        const devices = await this.getUserDevices(userEmail, options);

        if (options?.tenantId && options.includeUntagged === false && devices.length === 0) {
          continue;
        }
        
        const derivedTenantIds = Array.from(
          new Set(
            devices.flatMap((device) => (Array.isArray(device.tenantIds) ? device.tenantIds : []))
          )
        );
        
        // Check if any device is currently online
        const isOnline = devices.some(device => device.isOnline && !device.isDeleted);
        
        users.push({
          email: userEmail,
          role: 'user', // Default role, can be enhanced later
          displayName: userEmail.split('@')[0],
          devices: devices,
          isOnline,
          totalDevices: devices.filter(device => !device.isDeleted).length,
          tenantIds: derivedTenantIds.length
            ? derivedTenantIds
            : options?.tenantId
            ? [options.tenantId]
            : undefined,
        });
      }
      
      return users.sort((a, b) => a.email.localeCompare(b.email));
    } catch (error) {
      logger.error('Failed to get all users:', error);
      return [];
    }
  }

  async getDeletedDevices(userEmail: string): Promise<UserDevice[]> {
    try {
      // Get all devices from subcollection
      const devicesCollection = collection(firestore, 'user_devices', userEmail, 'devices');
      const devicesSnapshot = await getDocs(devicesCollection);
      
      const deletedDevices: UserDevice[] = [];
      
      devicesSnapshot.forEach(deviceDoc => {
        const device = deviceDoc.data() as UserDevice;
        if (device.isDeleted) {
          deletedDevices.push({
            ...device,
            deviceId: deviceDoc.id, // Ensure deviceId is set
            lastSeen: device.lastSeen instanceof Timestamp ? device.lastSeen.toDate() : new Date(device.lastSeen),
            createdAt: device.createdAt instanceof Timestamp ? device.createdAt.toDate() : new Date(device.createdAt),
            updatedAt: device.updatedAt instanceof Timestamp ? device.updatedAt.toDate() : new Date(device.updatedAt),
            deletedAt: device.deletedAt ? (device.deletedAt instanceof Timestamp ? device.deletedAt.toDate() : new Date(device.deletedAt)) : undefined
          });
        }
      });
      
      return deletedDevices;
    } catch (error) {
      logger.error('Failed to get deleted devices:', error);
      return [];
    }
  }

  /**
   * Get all device actions history
   */
  async getAllDeviceActions(): Promise<DeviceAction[]> {
    try {
      const actionsQuery = query(
        collection(firestore, 'device_actions'),
        // Order by timestamp descending to get most recent first
      );
      
      const snapshot = await getDocs(actionsQuery);
      const actions: DeviceAction[] = [];
      
      snapshot.forEach(doc => {
        const data = doc.data();
        actions.push({
          id: doc.id,
          ...data
        } as DeviceAction);
      });
      
      return actions.sort((a, b) => {
        const timeA = a.timestamp instanceof Timestamp ? a.timestamp.toDate() : new Date(a.timestamp);
        const timeB = b.timestamp instanceof Timestamp ? b.timestamp.toDate() : new Date(b.timestamp);
        return timeB.getTime() - timeA.getTime();
      });
    } catch (error) {
      logger.error('Error getting all device actions:', error);
      return [];
    }
  }

  /**
   * Generate a unique device fingerprint based on unchanging characteristics
   * Note: This uses the same logic as generateConsistentDeviceId() to ensure consistency
   */
  private async generateDeviceFingerprint(device: UserDevice): Promise<string> {
    if (typeof device.deviceSeedHash === 'string' && device.deviceSeedHash.trim()) {
      logger.debug('Device fingerprint source: stored seed hash', { platform: Platform.OS });
      return device.deviceSeedHash.trim();
    }

    logger.debug('Device fingerprint source: fingerprint fallback', { platform: Platform.OS });
    return this.computeFallbackFingerprintHash(device);
  }

  /**
   * Create a hard ban for a device based on its unchanging characteristics
   */
  async createDeviceBan(
    device: UserDevice,
    userEmail: string,
    reason: string,
    adminEmail: string,
    adminName: string,
    expiresAt?: Date
  ): Promise<void> {
    try {
      const deviceFingerprint = await this.generateDeviceFingerprint(device);
      
      const banData = {
        banType: 'hard' as const,
        deviceFingerprint,
        bannedFields: {
          userAgent: device.userAgent,
          manufacturer: device.manufacturer,
          modelName: device.modelName,
          modelId: device.modelId,
          hardwareConcurrency: device.hardwareConcurrency,
          totalMemory: device.totalMemory,
          screenWidth: device.screenWidth,
          screenHeight: device.screenHeight,
          supportedCpuArchitectures: device.supportedCpuArchitectures,
          jsHeapSizeLimit: device.jsHeapSizeLimit,
          platform: device.platform,
          vendor: device.vendor
        },
        reason,
        adminEmail,
        adminName,
        targetDeviceId: device.deviceId,
        targetUserEmail: userEmail,
        isActive: true,
        createdAt: this.createResolvedTimestamp(),
        expiresAt: expiresAt ? Timestamp.fromDate(expiresAt) : undefined,
        lastChecked: this.createResolvedTimestamp()
      };

      // First force logout the device if it's online
      if (device.isOnline) {
        logger.debug(`Force logging out device ${device.deviceId} before hard ban`);
        await this.forceLogoutDevice(userEmail, device.deviceId, adminEmail, adminName, `Hard ban: ${reason}`);
      }

      // Clean undefined values before sending to Firestore
      const cleanBanData = this.cleanUndefinedValues(banData);

      // Add ban to Firestore
      const banRef = doc(collection(firestore, 'device_bans'));
      await setDoc(banRef, cleanBanData);

      // Also soft delete the current device instance
      await this.markDeviceAsDeleted(userEmail, device.deviceId, adminEmail, adminName, `Hard banned: ${reason}`);

      logger.debug(`🚫 Hard banned device: ${deviceFingerprint} for user: ${userEmail}`);
    } catch (error) {
      logger.error('❌ Failed to create device ban:', error);
      throw error;
    }
  }

  /**
   * Check if a device is banned based on its fingerprint
   */
  async isDeviceBanned(device: UserDevice): Promise<DeviceBan | null> {
    try {
      const deviceFingerprint = await this.generateDeviceFingerprint(device);
      
      // Query for active bans with matching fingerprint
      const bansQuery = query(
        collection(firestore, 'device_bans'),
        where('deviceFingerprint', '==', deviceFingerprint),
        where('isActive', '==', true)
      );

      const bansSnapshot = await getDocs(bansQuery);
      
      for (const banDoc of bansSnapshot.docs) {
        const banData = banDoc.data() as Omit<DeviceBan, 'id'>;
        const ban: DeviceBan = { id: banDoc.id, ...banData };

        // Check if ban has expired
        if (ban.expiresAt) {
          const expirationDate = ban.expiresAt instanceof Timestamp 
            ? ban.expiresAt.toDate() 
            : new Date(ban.expiresAt);
          
          if (new Date() > expirationDate) {
            // Ban has expired, deactivate it
            await updateDoc(banDoc.ref, { isActive: false });
            continue;
          }
        }

        // Update last checked timestamp
        await updateDoc(banDoc.ref, { lastChecked: this.createResolvedTimestamp() });
        
        return ban;
      }

      return null;
    } catch (error) {
      logger.error('❌ Failed to check device ban:', error);
      return null;
    }
  }

  /**
   * Check if a device is banned for a specific user (both device fingerprint and user email must match)
   * This prevents banning innocent users with identical hardware specifications
   */
  async isDeviceBannedForUser(device: UserDevice, userEmail: string): Promise<DeviceBan | null> {
    try {
      const deviceFingerprint = await this.generateDeviceFingerprint(device);
      
      // Query for active bans with matching fingerprint AND target user email
      const bansQuery = query(
        collection(firestore, 'device_bans'),
        where('deviceFingerprint', '==', deviceFingerprint),
        where('targetUserEmail', '==', userEmail),
        where('isActive', '==', true)
      );

      const bansSnapshot = await getDocs(bansQuery);
      
      for (const banDoc of bansSnapshot.docs) {
        const banData = banDoc.data() as Omit<DeviceBan, 'id'>;
        const ban: DeviceBan = { id: banDoc.id, ...banData };

        // Check if ban has expired
        if (ban.expiresAt) {
          const expirationDate = ban.expiresAt instanceof Timestamp 
            ? ban.expiresAt.toDate() 
            : new Date(ban.expiresAt);
          
          if (new Date() > expirationDate) {
            // Ban has expired, deactivate it
            await updateDoc(banDoc.ref, { 
              isActive: false,
              expiredAt: this.createResolvedTimestamp()
            });
            continue;
          }
        }

        // Update last checked timestamp
        await updateDoc(banDoc.ref, { lastChecked: this.createResolvedTimestamp() });
        
        return ban;
      }

      return null;
    } catch (error) {
      logger.error('❌ Failed to check device ban for user:', error);
      return null;
    }
  }

  /**
   * Check if the current device is banned for a specific user during login
   * This method uses the same comprehensive device collection as registration to ensure consistency
   */
  async checkLoginDeviceBan(userEmail: string): Promise<{ banned: boolean; banInfo?: DeviceBan; errorMessage?: string }> {
    try {
      // Use the same comprehensive device collection as registerDevice to ensure consistent fingerprinting
      const tempDeviceId = 'temp-login-check';
      const deviceInfo = await this.collectDeviceInformation(tempDeviceId);
      
      // Check if device is banned for this specific user
      const banInfo = await this.isDeviceBannedForUser(deviceInfo, userEmail);
      
      if (banInfo) {
        return {
          banned: true,
          banInfo,
          errorMessage: banInfo.reason || 'Your device has been banned from accessing this application.'
        };
      }

      return { banned: false };
      
    } catch (error) {
      logger.error('❌ Failed to check login device ban:', error);
      return {
        banned: false,
        errorMessage: 'Unable to verify device status. Please try again.'
      };
    }
  }

  /**
   * Get all active device bans
   */
  async getAllDeviceBans(): Promise<DeviceBan[]> {
    try {
      const bansQuery = query(
        collection(firestore, 'device_bans'),
        where('isActive', '==', true)
      );

      const bansSnapshot = await getDocs(bansQuery);
      const bans: DeviceBan[] = [];

      bansSnapshot.forEach(doc => {
        const banData = doc.data() as Omit<DeviceBan, 'id'>;
        bans.push({ id: doc.id, ...banData });
      });

      return bans.sort((a, b) => {
        const timeA = a.createdAt instanceof Timestamp ? a.createdAt.toDate() : new Date(a.createdAt);
        const timeB = b.createdAt instanceof Timestamp ? b.createdAt.toDate() : new Date(b.createdAt);
        return timeB.getTime() - timeA.getTime();
      });
    } catch (error) {
      logger.error('❌ Failed to get device bans:', error);
      return [];
    }
  }

  /**
   * Remove/deactivate a device ban
   */
  async removeDeviceBan(banId: string, adminEmail: string, adminName: string): Promise<void> {
    try {
      const banRef = doc(firestore, 'device_bans', banId);
      await updateDoc(banRef, {
        isActive: false,
        removedAt: this.createResolvedTimestamp(),
        removedBy: adminEmail,
        removedByName: adminName
      });

      logger.debug(`✅ Device ban removed: ${banId} by ${adminEmail}`);
    } catch (error) {
      logger.error('❌ Failed to remove device ban:', error);
      throw error;
    }
  }

  /**
   * Determine if a device should be considered online based on recent heartbeat freshness.
   */
  static isDeviceOnline(lastSeen: any, freshnessWindowMs: number = 2 * 60 * 1000): boolean {
    if (!lastSeen) return false;
    
    let lastSeenDate: Date;
    
    // Handle serverTimestamp objects (not yet resolved)
    if (lastSeen && typeof lastSeen === 'object' && lastSeen._methodName === 'serverTimestamp') {
      return true; // Use current time for unresolved serverTimestamp
    }
    
    // Handle Firestore Timestamp objects with seconds and nanoseconds properties
    if (lastSeen && typeof lastSeen === 'object' && lastSeen.seconds !== undefined) {
      lastSeenDate = new Date(lastSeen.seconds * 1000 + Math.floor(lastSeen.nanoseconds / 1000000));
    }
    // Handle Firestore Timestamp objects
    else if (lastSeen instanceof Timestamp) {
      lastSeenDate = lastSeen.toDate();
    }
    // Handle objects with toDate method
    else if (lastSeen && typeof lastSeen.toDate === 'function') {
      lastSeenDate = lastSeen.toDate();
    }
    // Handle Date objects
    else if (lastSeen instanceof Date) {
      lastSeenDate = lastSeen;
    }
    // Handle strings/numbers
    else if (typeof lastSeen === 'string' || typeof lastSeen === 'number') {
      lastSeenDate = new Date(lastSeen);
    }
    // Handle legacy format with just seconds
    else if (lastSeen && lastSeen.seconds) {
      lastSeenDate = new Date(lastSeen.seconds * 1000);
    } else {
      return false;
    }
    
    const lastSeenMs = lastSeenDate.getTime();
    if (!Number.isFinite(lastSeenMs)) {
      return false;
    }

    return Date.now() - lastSeenMs <= Math.max(5_000, freshnessWindowMs);
  }

  /**
   * Update device registration to check for bans
   */
  async registerDeviceWithBanCheck(
    userEmail: string,
    deviceData: Partial<UserDevice>
  ): Promise<{ success: boolean; banned?: DeviceBan; deviceId?: string }> {
    try {
      // First check if device is banned for this specific user
      const ban = await this.isDeviceBannedForUser(deviceData as UserDevice, userEmail);
      
      if (ban) {
        logger.debug(`🚫 Blocked device registration due to ban: ${ban.deviceFingerprint} for user: ${userEmail}`);
        return { success: false, banned: ban };
      }

      // If not banned, proceed with normal registration
      const deviceId = await this.registerDevice(userEmail);
      return { success: true, deviceId };
    } catch (error) {
      logger.error('❌ Failed to register device with ban check:', error);
      throw error;
    }
  }

  /**
   * Update device lastLogin timestamp when user logs in through Google auth
   */
  async updateLastLogin(userEmail: string, deviceId?: string): Promise<void> {
    try {
      let targetDeviceId = deviceId || this.currentDeviceId;
      
      // If no device ID is available, generate one and register the device
      if (!targetDeviceId) {
        logger.debug('No device ID available for lastLogin update, registering device first...');
        try {
          targetDeviceId = await this.registerDevice(userEmail);
          logger.debug(`Device registered for lastLogin update: ${targetDeviceId}`);
        } catch (error) {
          logger.error('Failed to register device for lastLogin update:', error);
          return;
        }
      }

      const deviceDoc = doc(firestore, 'user_devices', userEmail, 'devices', targetDeviceId);
      const updateData = {
        lastLogin: this.createResolvedTimestamp(),
        updatedAt: this.createResolvedTimestamp(),
        lastActivityType: 'user_login'
      };

      const cleanUpdates = this.cleanUndefinedValues(updateData);
      await updateDoc(deviceDoc, cleanUpdates);

      logger.debug(`Updated lastLogin for device ${targetDeviceId}`);
    } catch (error) {
      logger.error('Failed to update lastLogin:', error);
      // Don't throw error as this is not critical for app functionality
    }
  }

  /**
   * Initialize web notification listener for browser devices
   */
  async initializeWebNotificationListener(): Promise<void> {
    if (Platform.OS !== 'web' || !this.currentDeviceId) {
      return;
    }

    try {
      // Request notification permission for web
      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }

        this.lastKnownNotificationsEnabled = Notification.permission !== 'denied';
      }

      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type === 'tm:web-push-resubscribe-needed') {
            void this.syncCurrentWebPushSubscription('subscription_change');
            return;
          }

          if (event.data?.type === 'tm:web-push-received') {
            void this.syncStoredWebPushDiagnostics('push_message');
          }
        });
      }

      // Listen for notifications in Firebase Realtime Database
      const database = getDatabase();
      
      const deviceNotificationsRef = ref(database, `device_notifications/${this.currentDeviceId}`);
      
      onValue(deviceNotificationsRef, (snapshot) => {
        if (snapshot.exists()) {
          const notifications = snapshot.val();
          
          Object.entries(notifications).forEach(([key, notificationData]: [string, any]) => {
            if (notificationData && typeof notificationData === 'object') {
              this.displayWebNotification(notificationData);
              
              // Remove the notification after displaying it
              const notificationRef = ref(database, `device_notifications/${this.currentDeviceId}/${key}`);
              remove(notificationRef).catch(console.error);
            }
          });
        }
      });

      logger.debug('Web notification listener initialized for device:', this.currentDeviceId);
      await this.syncStoredWebPushDiagnostics('listener_init');
      await this.syncCurrentWebPushSubscription('listener_init');
    } catch (error) {
      logger.error('Error initializing web notification listener:', error);
    }
  }

  /**
   * Display web notification using notification service
   */
  private async displayWebNotification(notificationData: {
    title: string;
    body: string;
    data?: any;
    type?: string;
    id?: string;
  }): Promise<void> {
    try {
      await getNotificationService().sendLocalNotification({
        title: notificationData.title,
        body: notificationData.body,
        data: {
          ...(notificationData.data || {}),
          notificationId:
            typeof notificationData.data?.notificationId === 'string' && notificationData.data.notificationId.trim()
              ? notificationData.data.notificationId.trim()
              : typeof notificationData.id === 'string'
                ? notificationData.id
                : undefined,
          type:
            typeof notificationData.data?.type === 'string'
              ? notificationData.data.type
              : notificationData.type,
        }
      });

      logger.debug('Remote web notification displayed:', notificationData.title);
    } catch (error) {
      logger.error('Error displaying web notification:', error);
    }
  }
}

export const deviceTrackingService = new DeviceTrackingService();
