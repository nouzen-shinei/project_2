import { logger } from '@/lib/logger';
import { resolveExpoProjectId } from '@/lib/expoProjectId';
import {
  ANDROID_CHANNEL_IDS,
  getAndroidChannelDefinition,
  resolveNotificationChannelId,
} from '@/lib/notificationChannels';
import type { AndroidChannelId } from '@/lib/notificationChannels';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { twilioBackendClient, SMSMessage, VoiceCallMessage } from './twilioBackendClient';
import { whatsappBusinessService, WABATemplateComponentParam } from './wabaService';
import { getTemplateLanguage } from './wabaTemplateConstants';
import {
  confirmInboundChatDeliveryFromNotificationData,
  flushPendingInboundChatDeliveryReceipts,
} from './chatReceiptSync';
import { whatsappConversationService } from './whatsappConversationService';
import { emailService } from './emailService';
import { quotesService } from './quotesService';
import { Student } from '../types';
import { ChatMessage, chatService } from './chatService';
import { adminNotificationHistoryService } from './adminNotificationHistoryService';
import { router } from 'expo-router';
import type { DeviceNotificationFanoutResult, DeviceTenantFilterOptions } from './deviceTrackingService';
import { tenantService } from './tenantService';
import { runtimeEndpoints } from './runtimeEndpoints';

type DeviceTrackingServiceType = typeof import('./deviceTrackingService').deviceTrackingService;

export interface IDeviceTrackingService {
  initialize(userEmail: string): Promise<void>;
  registerDevice(userEmail: string, expoPushToken?: string): Promise<void>;
  sendNotificationToUser(
    userEmail: string,
    notification: { title: string; body: string; data?: any },
    onlineOnly?: boolean,
    options?: DeviceTenantFilterOptions
  ): Promise<DeviceNotificationFanoutResult>;
  sendNotificationToDevice(
    deviceId: string,
    userEmail: string,
    notification: { title: string; body: string; data?: any },
    deviceOverride?: any,
    options?: DeviceTenantFilterOptions
  ): Promise<boolean>;
  getUserDevices(userEmail: string, options?: DeviceTenantFilterOptions): Promise<any[]>;
  getAllUsersWithDevices(
    memberEmails: string[],
    currentUserEmail?: string,
    includeCurrentUser?: boolean,
    options?: DeviceTenantFilterOptions
  ): Promise<any[]>;
  checkUserOnlineStatus(userEmail: string): Promise<boolean>;
  unregisterDevice(): Promise<void>;
  updateCurrentDevicePreferences(preferences: {
    notificationsEnabled?: boolean;
    chatNotificationsEnabled?: boolean;
    dailyQuotesEnabled?: boolean;
    noticeNotificationsEnabled?: boolean;
    teamNotificationsEnabled?: boolean;
  }): Promise<void>;
  syncCurrentWebPushSubscription?(context?: string): Promise<void>;
  updateCurrentDeviceChatState(update: {
    partnerEmail?: string | null;
    partnerId?: string | null;
    partnerName?: string | null;
    isActive?: boolean;
    lastMessageId?: string | null;
    lastMessageTimestamp?: string | number | Date | null;
  }): Promise<void>;
}

type PendingChatNavigationTarget = {
  chatId?: string;
  senderEmail?: string;
  senderName?: string;
  messageId?: string;
  timestamp?: string | number | Date;
};

const PENDING_CHAT_STORAGE_KEY = 'tm.pendingChatNavigation';

let __deviceTrackingService: (DeviceTrackingServiceType & IDeviceTrackingService) | null = null;
function getDeviceTrackingService(): DeviceTrackingServiceType & IDeviceTrackingService {
  if (!__deviceTrackingService) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./deviceTrackingService');
    __deviceTrackingService = mod.deviceTrackingService as DeviceTrackingServiceType & IDeviceTrackingService;
  }
  return __deviceTrackingService;
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification?.request?.content?.data as Record<string, any> | undefined;
    const isReceiptProbe = data?._tmReceiptProbe === true || data?.receiptProbe === true;
    const title = notification?.request?.content?.title;
    const body = notification?.request?.content?.body;
    const hasVisibleContent = Boolean((title && String(title).trim()) || (body && String(body).trim()));

    // Silent receipt probes should never surface UI banners/toasts.
    if (isReceiptProbe || !hasVisibleContent) {
      return {
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      };
    }

    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});
// Notification response listeners are registered after service initialization

export interface NotificationData {
  title: string;
  body: string;
  data?: any;
}

export interface EmailData {
  to_email: string;
  to_name: string;
  student_name: string;
  amount: string;
  due_date: string;
  tenantId?: string;
  quotaBatchId?: string;
  historyId?: string;
  history?: any;
  teacher_name: string;
  teacher_email?: string;
  teacher_phone?: string;
  school_name?: string;
  coaching_name?: string;
  show_coaching_name?: boolean;
  show_teacher_name?: boolean;
  from_name?: string;
  from_email?: string;
  reply_to?: string;
  subject?: string;
  message?: string;
  custom_notes?: string;
  payment_methods?: string;
  late_fee_info?: string;
  office_hours?: string;
  website_url?: string;
  custom_message_english?: string;
  custom_message_hindi?: string;
  selectedLanguage?: 'english' | 'hindi' | 'both';
  languageOrder?: 'english-first' | 'hindi-first';
  english_first?: boolean;
}

export interface SMSData {
  to: string;
  message: string;
  tenantId: string;
  quotaBatchId?: string;
  historyId?: string;
  history?: any;
}

const LEGACY_EMAIL_TENANT_ID = '__legacy_email__';

class NotificationService {
  private expoPushToken: string | null = null;
  private currentUserEmail: string | null = null;
  private notificationCache: Set<string> = new Set();
  private cacheCleanupInterval: number | NodeJS.Timeout | null = null;
  private receiptFlushInterval: number | NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;
  private preferencesLoaded: boolean = false;
  private notificationsEnabled: boolean = true;
  private dailyQuotesEnabled: boolean = true;
  private chatNotificationsEnabled: boolean = true;
  private noticeNotificationsEnabled: boolean = true;
  private teamNotificationsEnabled: boolean = true;
  private pendingChatNavigation: PendingChatNavigationTarget | null = null;
  private activeChatPartnerEmail: string | null = null;
  private lastActiveChatDeliveryBackfillAtByPartner = new Map<string, number>();
  private lastHandledNotificationId: string | null = null;
  private hasCheckedInitialNotificationResponse: boolean = false;
  private chatNavigationRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  private tenantFilterCache: { tenantId: string; fetchedAt: number } | null = null;

  private async resolveTenantFilterOptions(includeUntagged: boolean = true): Promise<DeviceTenantFilterOptions | undefined> {
    const CACHE_TTL_MS = 30_000;
    const now = Date.now();
    if (this.tenantFilterCache && now - this.tenantFilterCache.fetchedAt < CACHE_TTL_MS) {
      return { tenantId: this.tenantFilterCache.tenantId, includeUntagged };
    }

    try {
      const tenantId = await tenantService.getCachedSelectedTenant();
      if (!tenantId) {
        this.tenantFilterCache = null;
        return undefined;
      }
      this.tenantFilterCache = { tenantId, fetchedAt: now };
      return { tenantId, includeUntagged };
    } catch (error) {
      logger.warn('NotificationService: failed to resolve tenant filter options', error);
      return undefined;
    }
  }

  async clearChatNotificationsForSender(senderEmail: string): Promise<void> {
    try {
      if (!senderEmail) {
        return;
      }

      const normalizedSender = senderEmail.toLowerCase();
      const presentedNotifications = await Notifications.getPresentedNotificationsAsync();

      const dismissalPromises = presentedNotifications
        .map((presented) => {
          const data = presented.request.content.data ?? {};
          const type = data?.type;
          const notificationSender = typeof data?.senderEmail === 'string'
            ? data.senderEmail.toLowerCase()
            : undefined;

          if (
            notificationSender === normalizedSender &&
            (type === 'chat_message' || type === 'team_chat_message')
          ) {
            return Notifications.dismissNotificationAsync(presented.request.identifier)
              .catch((dismissError) => {
                logger.warn('Failed to dismiss chat notification', {
                  senderEmail: normalizedSender,
                  error: dismissError,
                });
              });
          }

          return null;
        })
        .filter((promise): promise is Promise<void> => promise !== null);

      if (dismissalPromises.length > 0) {
        await Promise.all(dismissalPromises);
      }
    } catch (error) {
      logger.warn('Unable to clear chat notifications for sender', {
        senderEmail,
        error,
      });
    }
  }

  private isUserActivelyViewingChat(senderEmail: string | null | undefined): boolean {
    if (!senderEmail) {
      return false;
    }

    return this.activeChatPartnerEmail?.toLowerCase() === senderEmail.toLowerCase();
  }

  async setActiveChatPartner(
    partnerEmail: string | null,
    options: {
      partnerId?: string | null;
      partnerName?: string | null;
      isActive?: boolean;
      lastMessageId?: string | null;
      lastMessageTimestamp?: string | number | Date | null;
    } = {}
  ): Promise<void> {
    const normalizedEmail = partnerEmail ? partnerEmail.toLowerCase() : null;
    this.activeChatPartnerEmail = normalizedEmail;

    if (!this.currentUserEmail) {
      return;
    }

    try {
      await getDeviceTrackingService().updateCurrentDeviceChatState({
        partnerEmail: normalizedEmail,
        partnerId: options.partnerId ?? null,
        partnerName: options.partnerName ?? null,
        isActive: options.isActive ?? Boolean(normalizedEmail),
        lastMessageId: options.lastMessageId ?? null,
        lastMessageTimestamp: options.lastMessageTimestamp ?? null,
      });
    } catch (error) {
      logger.debug('Failed to sync active chat partner state with device tracking:', error);
    }

    if (normalizedEmail && (options.isActive ?? true)) {
      await this.backfillDeliveredReceiptsForActiveChat(normalizedEmail);
    }
  }

  private async backfillDeliveredReceiptsForActiveChat(partnerEmail: string): Promise<void> {
    const now = Date.now();
    const lastSyncedAt = this.lastActiveChatDeliveryBackfillAtByPartner.get(partnerEmail) ?? 0;
    if (now - lastSyncedAt < 10_000) {
      return;
    }

    this.lastActiveChatDeliveryBackfillAtByPartner.set(partnerEmail, now);

    try {
      const tenantId = await tenantService.getCachedSelectedTenant();
      await chatService.syncConversationReceipts(partnerEmail, {
        markConversationDelivered: true,
        tenantId,
      });
    } catch (error) {
      logger.debug('Active chat delivery backfill failed', {
        partnerEmail,
        error,
      });
    }
  }

  async initialize(userEmail?: string, options?: { force?: boolean }): Promise<void> {
    // Prevent multiple initializations
    if (!options?.force && this.isInitialized && this.currentUserEmail === userEmail) {
      logger.debug('Notification service already initialized for this user');
      return;
    }

    if (userEmail) {
      this.currentUserEmail = userEmail;
    }
    
    // Load saved notification preferences
    await this.loadNotificationPreferences();

    try {
      if (this.dailyQuotesEnabled) {
        await quotesService.initialize();
      }
      await quotesService.setSchedulingEnabled(this.notificationsEnabled && this.dailyQuotesEnabled);
    } catch (error) {
      logger.error('Failed to prepare quotes scheduling during initialization:', error);
    }

    if (!this.notificationsEnabled) {
      logger.debug('Notifications disabled by preference; skipping initialization');
      await emailService.initialize();
      this.isInitialized = true;

      if (userEmail) {
        try {
          this.activeChatPartnerEmail = null;
          await getDeviceTrackingService().updateCurrentDeviceChatState({
            partnerEmail: null,
            partnerId: null,
            partnerName: null,
            isActive: false,
            lastMessageId: null,
            lastMessageTimestamp: null,
          });
        } catch (error) {
          logger.debug('Unable to reset active chat state during initialization:', error);
        }
      }

      return;
    }

    // Start cache cleanup interval (every 5 minutes) when notifications are enabled
    this.startCacheCleanup();
    this.startReceiptFlushLoop();
  
    if (Platform.OS !== 'web') {
      await this.registerForPushNotificationsAsync();
      await this.setupNotificationCategories();
      
      // Android-specific initialization
      if (Platform.OS === 'android') {
        await this.setupAndroidSpecificFeatures();
      }
    } else {
      // Initialize web notifications
      await this.initializeWebNotifications();
    }

    // Initialize email service (now uses backend; no direct EmailJS on frontend)
    await emailService.initialize();
    
    // Initialize device tracking if user email provided
    if (userEmail) {
      try {
        await getDeviceTrackingService().initialize(userEmail);
        await getDeviceTrackingService().updateCurrentDevicePreferences({
          notificationsEnabled: this.notificationsEnabled,
          dailyQuotesEnabled: this.dailyQuotesEnabled,
          chatNotificationsEnabled: this.chatNotificationsEnabled,
          noticeNotificationsEnabled: this.noticeNotificationsEnabled,
        });
      } catch (error) {
        logger.error('Device tracking initialization failed:', error);
      }
    }

    this.isInitialized = true;

    if (userEmail) {
      try {
        this.activeChatPartnerEmail = null;
        await getDeviceTrackingService().updateCurrentDeviceChatState({
          partnerEmail: null,
          partnerId: null,
          partnerName: null,
          isActive: false,
          lastMessageId: null,
          lastMessageTimestamp: null,
        });
      } catch (error) {
        logger.debug('Unable to reset active chat state after initialization:', error);
      }
    }

    logger.debug('Notification service initialization complete');
  }

  /**
   * Load notification preferences from AsyncStorage
   */
  private async loadNotificationPreferences(): Promise<void> {
    try {
      const prefs = await AsyncStorage.getItem('notificationPreferences');
      if (prefs) {
        const parsed = JSON.parse(prefs);
        logger.debug('Loaded notification preferences:', parsed);
        this.notificationsEnabled = parsed.notifications !== false;
        this.dailyQuotesEnabled = parsed.dailyQuotes !== false;
        this.chatNotificationsEnabled = parsed.chatNotifications !== false;
        this.noticeNotificationsEnabled = parsed.noticeNotifications !== false;
        this.teamNotificationsEnabled = parsed.teamNotifications !== false;

        // Ensure newly introduced preferences are persisted for older payloads
        if (
          !('chatNotifications' in parsed) ||
          !('noticeNotifications' in parsed) ||
          !('teamNotifications' in parsed)
        ) {
          const normalized = {
            ...parsed,
            notifications: this.notificationsEnabled,
            dailyQuotes: this.dailyQuotesEnabled,
            chatNotifications: this.chatNotificationsEnabled,
            noticeNotifications: this.noticeNotificationsEnabled,
            teamNotifications: this.teamNotificationsEnabled,
          };
          await AsyncStorage.setItem('notificationPreferences', JSON.stringify(normalized));
        }
      } else {
        const legacySettings = await AsyncStorage.getItem('appSettings');
        if (legacySettings) {
          const parsed = JSON.parse(legacySettings);
          this.notificationsEnabled = parsed.notifications !== false;
          this.dailyQuotesEnabled = parsed.dailyQuotes !== false;
          this.chatNotificationsEnabled = parsed.chatNotifications !== false;
          this.noticeNotificationsEnabled = parsed.noticeNotifications !== false;
          this.teamNotificationsEnabled = parsed.teamNotifications !== false;
          await AsyncStorage.setItem(
            'notificationPreferences',
            JSON.stringify({
              notifications: this.notificationsEnabled,
              dailyQuotes: this.dailyQuotesEnabled,
              chatNotifications: this.chatNotificationsEnabled,
              noticeNotifications: this.noticeNotificationsEnabled,
              teamNotifications: this.teamNotificationsEnabled,
            })
          );
        } else {
          this.notificationsEnabled = true;
          this.dailyQuotesEnabled = true;
          this.chatNotificationsEnabled = true;
          this.noticeNotificationsEnabled = true;
          this.teamNotificationsEnabled = true;
          await AsyncStorage.setItem(
            'notificationPreferences',
            JSON.stringify({
              notifications: this.notificationsEnabled,
              dailyQuotes: this.dailyQuotesEnabled,
              chatNotifications: this.chatNotificationsEnabled,
              noticeNotifications: this.noticeNotificationsEnabled,
              teamNotifications: this.teamNotificationsEnabled,
            })
          );
        }
      }
      try {
        await getDeviceTrackingService().updateCurrentDevicePreferences({
          notificationsEnabled: this.notificationsEnabled,
          dailyQuotesEnabled: this.dailyQuotesEnabled,
          chatNotificationsEnabled: this.chatNotificationsEnabled,
          noticeNotificationsEnabled: this.noticeNotificationsEnabled,
          teamNotificationsEnabled: this.teamNotificationsEnabled,
        });
      } catch (syncError) {
        logger.debug('Device preference sync skipped during load:', syncError);
      }

      this.preferencesLoaded = true;
    } catch (error) {
      logger.error('Failed to load notification preferences:', error);
    }
  }

  /**
   * Save notification preference
   */
  private async saveNotificationPreference(key: string, value: boolean): Promise<void> {
    try {
      const prefs = await AsyncStorage.getItem('notificationPreferences');
      const parsed = prefs ? JSON.parse(prefs) : {};
      const updated = {
        ...parsed,
        notifications: key === 'notifications' ? value : parsed.notifications ?? this.notificationsEnabled,
        dailyQuotes: key === 'dailyQuotes' ? value : parsed.dailyQuotes ?? this.dailyQuotesEnabled,
        chatNotifications: key === 'chatNotifications' ? value : parsed.chatNotifications ?? this.chatNotificationsEnabled,
        noticeNotifications: key === 'noticeNotifications' ? value : parsed.noticeNotifications ?? this.noticeNotificationsEnabled,
        teamNotifications: key === 'teamNotifications' ? value : parsed.teamNotifications ?? this.teamNotificationsEnabled,
      };
      await AsyncStorage.setItem('notificationPreferences', JSON.stringify(updated));
      logger.debug('Saved notification preference:', { key, value });

      if (key === 'notifications') {
        this.notificationsEnabled = value;
      }
      if (key === 'dailyQuotes') {
        this.dailyQuotesEnabled = value;
      }
      if (key === 'chatNotifications') {
        this.chatNotificationsEnabled = value;
      }
      if (key === 'noticeNotifications') {
        this.noticeNotificationsEnabled = value;
      }
      if (key === 'teamNotifications') {
        this.teamNotificationsEnabled = value;
      }
      try {
        const preferenceUpdate: {
          notificationsEnabled?: boolean;
          chatNotificationsEnabled?: boolean;
          dailyQuotesEnabled?: boolean;
          noticeNotificationsEnabled?: boolean;
          teamNotificationsEnabled?: boolean;
        } = {};

        if (key === 'notifications') {
          preferenceUpdate.notificationsEnabled = value;
        }
        if (key === 'dailyQuotes') {
          preferenceUpdate.dailyQuotesEnabled = value;
        }
        if (key === 'chatNotifications') {
          preferenceUpdate.chatNotificationsEnabled = value;
        }
        if (key === 'noticeNotifications') {
          preferenceUpdate.noticeNotificationsEnabled = value;
        }
        if (key === 'teamNotifications') {
          preferenceUpdate.teamNotificationsEnabled = value;
        }

        if (Object.keys(preferenceUpdate).length > 0) {
          await getDeviceTrackingService().updateCurrentDevicePreferences(preferenceUpdate);
        }
      } catch (syncError) {
        logger.warn('Failed to sync device notification preferences:', syncError);
      }
      this.preferencesLoaded = true;
    } catch (error) {
      logger.error('Failed to save notification preference:', error);
    }
  }

  async areNotificationsEnabled(): Promise<boolean> {
    if (!this.preferencesLoaded) {
      await this.loadNotificationPreferences();
    }
    return this.notificationsEnabled;
  }

  getNotificationsEnabledStatus(): boolean {
    return this.notificationsEnabled;
  }

  getDailyQuotesEnabledStatus(): boolean {
    return this.dailyQuotesEnabled;
  }

  async getNotificationPreferences(): Promise<{
    notificationsEnabled: boolean;
    dailyQuotesEnabled: boolean;
    chatNotificationsEnabled: boolean;
    noticeNotificationsEnabled: boolean;
    teamNotificationsEnabled: boolean;
  }> {
    if (!this.preferencesLoaded) {
      await this.loadNotificationPreferences();
    }

    return {
      notificationsEnabled: this.notificationsEnabled,
      dailyQuotesEnabled: this.dailyQuotesEnabled,
      chatNotificationsEnabled: this.chatNotificationsEnabled,
      noticeNotificationsEnabled: this.noticeNotificationsEnabled,
      teamNotificationsEnabled: this.teamNotificationsEnabled,
    };
  }

  async areChatNotificationsEnabled(): Promise<boolean> {
    if (!this.preferencesLoaded) {
      await this.loadNotificationPreferences();
    }
    return this.chatNotificationsEnabled;
  }

  getChatNotificationsEnabledStatus(): boolean {
    return this.chatNotificationsEnabled;
  }

  getNoticeNotificationsEnabledStatus(): boolean {
    return this.noticeNotificationsEnabled;
  }

  getTeamNotificationsEnabledStatus(): boolean {
    return this.teamNotificationsEnabled;
  }

  async setChatNotificationsEnabled(enabled: boolean): Promise<void> {
    await this.saveNotificationPreference('chatNotifications', enabled);
    this.chatNotificationsEnabled = enabled;
  }

  async setNoticeNotificationsEnabled(enabled: boolean): Promise<void> {
    await this.saveNotificationPreference('noticeNotifications', enabled);
    this.noticeNotificationsEnabled = enabled;
  }

  async setTeamNotificationsEnabled(enabled: boolean): Promise<void> {
    await this.saveNotificationPreference('teamNotifications', enabled);
    this.teamNotificationsEnabled = enabled;
  }

  async setNotificationsEnabled(enabled: boolean, userEmail?: string): Promise<void> {
    await this.saveNotificationPreference('notifications', enabled);
    this.notificationsEnabled = enabled;

    if (!enabled) {
      await this.cleanup();
      return;
    }

    if (userEmail) {
      this.currentUserEmail = userEmail;
    }

    await this.initialize(this.currentUserEmail ?? userEmail ?? undefined, { force: true });
  }

  /**
   * Start notification cache cleanup interval
   */
  private startCacheCleanup(): void {
    // Clean cache every 5 minutes to prevent memory leaks
    if (this.cacheCleanupInterval) {
      clearInterval(this.cacheCleanupInterval as number);
    }
    this.cacheCleanupInterval = setInterval(() => {
      this.notificationCache.clear();
    }, 5 * 60 * 1000);
  }

  /**
   * Generate unique notification ID for deduplication
   */
  private generateNotificationId(
    messageId: string,
    senderEmail: string,
    recipientEmail: string,
    timestamp?: number
  ): string {
    const timeKey = timestamp ? Math.floor(timestamp / 60000) : Math.floor(Date.now() / 60000); // Group by minute
    return `${messageId}_${senderEmail}_${recipientEmail}_${timeKey}`;
  }

  /**
   * Check if notification was already sent (prevents duplicates)
   */
  private wasNotificationSent(notificationId: string): boolean {
    return this.notificationCache.has(notificationId);
  }

  /**
   * Mark notification as sent
   */
  private markNotificationSent(notificationId: string): void {
    this.notificationCache.add(notificationId);
  }

  async handleNotificationReceived(notification: Notifications.Notification): Promise<void> {
    try {
      const data = notification?.request?.content?.data as Record<string, any> | undefined;
      await confirmInboundChatDeliveryFromNotificationData(data, 'received', {
        currentUserEmail: this.currentUserEmail,
      });
      await flushPendingInboundChatDeliveryReceipts({
        currentUserEmail: this.currentUserEmail,
        maxBatchSize: 20,
      });
    } catch (error) {
      logger.debug('Failed handling notification receive hook', error);
    }
  }

  private startReceiptFlushLoop(): void {
    if (this.receiptFlushInterval) {
      clearInterval(this.receiptFlushInterval as number);
    }

    // Retry queued delivery receipts in case immediate sync failed (offline/background race).
    this.receiptFlushInterval = setInterval(() => {
      void flushPendingInboundChatDeliveryReceipts({
        currentUserEmail: this.currentUserEmail,
        maxBatchSize: 30,
      }).catch((error) => {
        logger.debug('Periodic pending chat delivery receipt flush failed', { error });
      });
    }, 20_000);

    void flushPendingInboundChatDeliveryReceipts({
      currentUserEmail: this.currentUserEmail,
      maxBatchSize: 50,
    }).catch((error) => {
      logger.debug('Initial pending chat delivery receipt flush failed', { error });
    });
  }

  /**
   * Setup Android-specific notification features
   */
  private async setupAndroidSpecificFeatures(): Promise<void> {
    try {
      if (Platform.OS === 'android') {
        // Placeholder for any additional Android setup (battery optimizations, etc.)
      }
    } catch (error) {
      logger.error('Error setting up Android-specific features:', error);
    }
  }

  /**
   * Initialize web notifications and request permission
   */
  private async initializeWebNotifications(): Promise<void> {
    try {
      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }
      }
    } catch (error) {
      logger.error('Failed to initialize web notifications:', error);
    }
  }

  private async setupNotificationCategories(): Promise<void> {
    try {
      // Set up notification categories for interactive notifications
      await Notifications.setNotificationCategoryAsync('chat_message', [
        {
          identifier: 'reply',
          buttonTitle: 'Reply',
          options: {
            opensAppToForeground: false,
          },
          textInput: {
            submitButtonTitle: 'Send',
            placeholder: 'Type your reply...',
          },
        },
        {
          identifier: 'view',
          buttonTitle: 'View',
          options: {
            opensAppToForeground: true,
          },
        },
      ]);
    } catch (error) {
      logger.error('Error setting up notification categories:', error);
    }
  }

  private async registerForPushNotificationsAsync(options?: { skipDeviceRegistration?: boolean }): Promise<string | null> {
    if (!this.notificationsEnabled) {
      logger.debug('Notifications disabled; skipping push token registration');
      return null;
    }

    if (Platform.OS === 'android') {
      const channelIds = Object.values(ANDROID_CHANNEL_IDS) as AndroidChannelId[];
      for (const channelId of channelIds) {
        const definition = getAndroidChannelDefinition(channelId);
        await Notifications.setNotificationChannelAsync(channelId, definition);
      }
    }

    if (Device.isDevice) {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      
      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      
      if (finalStatus !== 'granted') {
        logger.debug('Failed to get push token for push notification!');
        return null;
      }
      
      try {
        const projectId = resolveExpoProjectId();
        if (!projectId) {
          logger.warn('Expo project ID unavailable; skipping push token registration.');
          return null;
        }
        
        const token = await Notifications.getExpoPushTokenAsync({
          projectId,
        });
        this.expoPushToken = token.data;
        
        // Register device with push token if user is logged in and registration not skipped
        if (!options?.skipDeviceRegistration && this.currentUserEmail) {
          try {
            await getDeviceTrackingService().registerDevice(this.currentUserEmail, token.data);
          } catch (error) {
            logger.error('Failed to register device with push token:', error);
          }
        }

        return token.data;
      } catch (error) {
        logger.debug('Error getting push token:', error);
      }
    } else {
      logger.debug('Must use physical device for Push Notifications');
    }

    return this.expoPushToken;
  }

  async sendLocalNotification(notification: NotificationData): Promise<void> {
    try {
      if (!this.notificationsEnabled && notification.data?.allowWhenDisabled !== true) {
        logger.debug('Skipping local notification because notifications are disabled.');
        return;
      }
      logger.debug('🔔 sendLocalNotification called:', {
        title: notification.title,
        body: notification.body,
        platform: Platform.OS,
        data: notification.data
      });
      
      if (Platform.OS === 'web') {
        const notificationId = typeof notification.data?.notificationId === 'string'
          ? notification.data.notificationId.trim()
          : '';

        if (notificationId && this.wasNotificationSent(notificationId)) {
          logger.debug('Skipping duplicate web notification', {
            notificationId,
            type: notification.data?.type,
          });
          return;
        }

        this.sendWebNotification(notification);

        if (notificationId) {
          this.markNotificationSent(notificationId);
        }
      } else {
        // Determine appropriate channel for Android
        const channelId =
          Platform.OS === 'android'
            ? resolveNotificationChannelId({
                type: typeof notification.data?.type === 'string' ? notification.data.type : undefined,
                priority:
                  typeof notification.data?.priority === 'string' ? notification.data.priority : undefined,
              })
            : undefined;

        // Use Expo notifications for mobile
        await Notifications.scheduleNotificationAsync({
          content: {
            title: notification.title,
            body: notification.body,
            data: notification.data,
            ...(Platform.OS === 'android' && channelId
              ? {
                  channelId,
                  priority: Notifications.AndroidNotificationPriority.HIGH,
                  color: '#1A73E8',
                }
              : {}),
          },
          trigger: null, // Send immediately
        });
      }
    } catch (error) {
      logger.error('Error sending local notification:', error);
    }
  }

  async sendEmailReminder(emailData: EmailData): Promise<boolean> {
    try {
      // Create a proper student object for the email service
      const student: Student = {
        tenantId: LEGACY_EMAIL_TENANT_ID,
        name: emailData.student_name,
        id: '',
        email: '',
        phone: '',
        grade: '',
        enrolledCourses: [],
        feesPaid: 0,
        totalFees: 0,
        enrollmentDate: '',
        status: 'active',
        createdAt: '',
        updatedAt: ''
      };

      // Use a timeout wrapper to prevent any blocking behavior
      const success = await Promise.race([
        emailService.sendFeeReminder(
          student, 
          emailData.to_email, 
          emailData.amount, 
          emailData.due_date, 
          emailData.from_name, 
          emailData.custom_notes,
          emailData.message,
          emailData.coaching_name,
          emailData.show_coaching_name,
          emailData.show_teacher_name,
          emailData.teacher_name,
          emailData.teacher_email,
          {
            tenantId: emailData.tenantId,
            quotaBatchId: emailData.quotaBatchId,
            historyId: emailData.historyId,
            history: emailData.history,
          }
        ),
        new Promise<boolean>((_, reject) => 
          setTimeout(() => reject(new Error('Email timeout')), 30000)
        )
      ]);
      
      return success;
    } catch (error) {
      logger.error('Error sending email reminder:', error);
      // Don't let email errors break the entire flow
      return false;
    }
  }

  async sendPaymentConfirmation(emailData: EmailData): Promise<boolean> {
    try {
      const success = await emailService.sendPaymentConfirmation(emailData);
      return success;
    } catch (error) {
      logger.error('Error sending payment confirmation email:', error);
      return false;
    }
  }

  async sendCustomEmail(emailData: EmailData): Promise<boolean> {
    try {
      const success = await emailService.sendCustomMessage(emailData);
      return success;
    } catch (error) {
      logger.error('Error sending custom email:', error);
      return false;
    }
  }

  async sendSMSReminder(smsData: SMSData): Promise<boolean> {
    try {
      const tenantId = (smsData.tenantId || '').trim();
      if (!tenantId) {
        throw new Error('Tenant id missing for SMS send');
      }
      const { tenantId: _ignored, ...rest } = smsData;
      void _ignored;
      const success = await twilioBackendClient.sendSMS({ tenantId, ...rest });
      return success;
    } catch (error) {
      logger.error('Error sending SMS reminder:', error);
      return false;
    }
  }

  async sendWhatsAppMessage(phoneNumber: string, message: string): Promise<boolean> {
    try {
      // Direct WABA only (Twilio WhatsApp removed)
      const success = await whatsappBusinessService.sendTextMessage({ to: phoneNumber, text: message });
      if (!success) logger.warn('WABA session send failed; verify 24h window or use a template.');
      return success;
    } catch (error) {
      logger.error('Error sending WhatsApp message (WABA):', error);
      return false;
    }
  }

  // Removed legacy basic fee_due_reminder template usage (now only extended template is supported)

  /** Enhanced fee due template with extra variables (requires updating template to include them)
   * Updated unified style (matches SMS/Voice wording; placeholders unchanged):
   * "{{1}} {{2}}, this is a reminder that {{3}}'s tuition fee of {{4}} is due on {{5}}. {{6}} Please make the payment at your earliest convenience. Thank you! Regards, {{7}} {{8}}"
   * Variables:
  * 1 Greeting ("Dear" / custom)
   * 2 Parent name
   * 3 Student name
   * 4 Amount (₹...)
   * 5 Due date
   * 6 Optional custom notes / extra line (or '-' if none)
   * 7 Teacher name (or Coaching name if teacher hidden)
   * 8 Coaching name (or '-')
   */
  async sendWhatsAppFeeDueTemplateExtended(options: {
    to: string;
    parentName?: string;
    studentName: string;
    amount: number;
    dueDate: string;
    greeting?: string;
    customNotes?: string;
    teacherName?: string;
    coachingName?: string;
    selectedLanguage?: 'english' | 'hindi' | 'both';
    languageOrder?: 'english-first' | 'hindi-first';
  }): Promise<boolean> {
    try {
      const useWABA =
        !!process.env.EXPO_PUBLIC_WABA_PHONE_NUMBER_ID ||
        !!runtimeEndpoints.getSnapshot().wabaApiBaseUrl ||
        !!runtimeEndpoints.getPreferredBackendBaseUrl();

      if (!useWABA) {
        logger.warn('WABA not configured; cannot send WhatsApp template.');
        return false;
      }

      const greeting = (options.greeting || 'Dear').trim();
      const parent = 'Parent';
      const amountFmt = `₹${options.amount.toLocaleString()}`;
      const customBase =
        options.customNotes && options.customNotes.trim() ? options.customNotes.trim() : 'No additional note';
      const teacher = options.teacherName && options.teacherName.trim() ? options.teacherName.trim() : '-';
      const coaching = options.coachingName && options.coachingName.trim() ? options.coachingName.trim() : '-';

      if (options.selectedLanguage === 'both') {
        const englishFirst = options.languageOrder === 'english-first';
        const templateName = englishFirst
          ? 'fee_due_reminder_extended_bilingual_en_hi'
          : 'fee_due_reminder_extended_bilingual_hi_en';
        const hindiGreeting = greeting.toLowerCase().startsWith('dear') ? 'प्रिय' : greeting;
        const hindiParent = 'अभिभावक';

        const bodyParams: WABATemplateComponentParam[] = englishFirst
          ? [
              { type: 'text' as const, text: greeting },
              { type: 'text' as const, text: parent },
              { type: 'text' as const, text: options.studentName },
              { type: 'text' as const, text: amountFmt },
              { type: 'text' as const, text: options.dueDate },
              { type: 'text' as const, text: customBase },
              { type: 'text' as const, text: teacher },
              { type: 'text' as const, text: coaching },
              { type: 'text' as const, text: hindiGreeting },
              { type: 'text' as const, text: hindiParent },
              { type: 'text' as const, text: options.studentName },
              { type: 'text' as const, text: amountFmt },
              { type: 'text' as const, text: options.dueDate },
              { type: 'text' as const, text: 'कोई नोट नहीं' },
              { type: 'text' as const, text: teacher },
              { type: 'text' as const, text: coaching },
            ]
          : [
              { type: 'text' as const, text: hindiGreeting },
              { type: 'text' as const, text: hindiParent },
              { type: 'text' as const, text: options.studentName },
              { type: 'text' as const, text: amountFmt },
              { type: 'text' as const, text: options.dueDate },
              { type: 'text' as const, text: 'कोई नोट नहीं' },
              { type: 'text' as const, text: teacher },
              { type: 'text' as const, text: coaching },
              { type: 'text' as const, text: greeting },
              { type: 'text' as const, text: parent },
              { type: 'text' as const, text: options.studentName },
              { type: 'text' as const, text: amountFmt },
              { type: 'text' as const, text: options.dueDate },
              { type: 'text' as const, text: customBase },
              { type: 'text' as const, text: teacher },
              { type: 'text' as const, text: coaching },
            ];

        return await whatsappBusinessService.sendTemplateMessage({
          to: options.to,
          templateName,
          language: getTemplateLanguage(templateName),
          bodyParams,
        });
      }

      if (options.selectedLanguage === 'hindi') {
        const hindiGreeting = greeting.toLowerCase().startsWith('dear') ? 'प्रिय' : greeting;
        const hindiParent = 'अभिभावक';
        const customHi =
          options.customNotes && options.customNotes.trim() ? options.customNotes.trim() : 'कोई नोट नहीं';

        return await whatsappBusinessService.sendTemplateMessage({
          to: options.to,
          templateName: 'fee_due_reminder_extended_hi',
          language: getTemplateLanguage('fee_due_reminder_extended_hi'),
          bodyParams: [
            { type: 'text', text: hindiGreeting },
            { type: 'text', text: hindiParent },
            { type: 'text', text: options.studentName },
            { type: 'text', text: amountFmt },
            { type: 'text', text: options.dueDate },
            { type: 'text', text: customHi },
            { type: 'text', text: teacher },
            { type: 'text', text: coaching },
          ],
        });
      }

      return await whatsappBusinessService.sendTemplateMessage({
        to: options.to,
        templateName: 'fee_due_reminder_extended',
        language: getTemplateLanguage('fee_due_reminder_extended'),
        bodyParams: [
          { type: 'text', text: greeting },
          { type: 'text', text: parent },
          { type: 'text', text: options.studentName },
          { type: 'text', text: amountFmt },
          { type: 'text', text: options.dueDate },
          { type: 'text', text: customBase },
          { type: 'text', text: teacher },
          { type: 'text', text: coaching },
        ],
      });
    } catch (error) {
      logger.error('Error sending extended fee_due_reminder template', error);
      return false;
    }
  }

  /** WhatsApp payment received confirmation via template (EN/HI/bilingual)
   * Template bodies (see templates.txt):
   * EN: "Payment received – {{1}} {{2}}, we have received payment of {{4}} for {{3}} on {{5}}. Additional note: {{6}}. ... Regards, {{7}} {{8}}"
   * Variables:
   * 1 Greeting (e.g., Dear)
   * 2 Parent name (fallback "Parent")
   * 3 Student name
   * 4 Amount (₹...)
   * 5 Payment date (formatted)
   * 6 Optional additional note (fallback "No additional note")
   * 7 Teacher name (or coaching if desired)
   * 8 Coaching name
   */
  async sendWhatsAppPaymentReceivedTemplate(options: {
    to: string;
    parentName?: string;
    studentName: string;
    amount: number;
    paymentDate: string; // raw string or ISO; will be formatted
    greeting?: string; // default "Dear"; Hindi uses "प्रिय"
    additionalNote?: string;
    teacherName?: string;
    coachingName?: string;
    selectedLanguage?: 'english' | 'hindi' | 'both';
    languageOrder?: 'english-first' | 'hindi-first';
  }): Promise<boolean> {
    try {
      const useWABA =
        !!process.env.EXPO_PUBLIC_WABA_PHONE_NUMBER_ID ||
        !!runtimeEndpoints.getSnapshot().wabaApiBaseUrl ||
        !!runtimeEndpoints.getPreferredBackendBaseUrl();
      if (!useWABA) {
        logger.warn('WABA not configured; cannot send WhatsApp template.');
        return false;
      }
      const formattedDate = this.formatDueDate(options.paymentDate);
      const amountFmt = `₹${options.amount.toLocaleString()}`;
      const teacher = options.teacherName && options.teacherName.trim() ? options.teacherName.trim() : '-';
      const coaching = options.coachingName && options.coachingName.trim() ? options.coachingName.trim() : '-';

      // English/Hindi defaults
      const enGreeting = (options.greeting || 'Dear').trim();
      const enParent = (options.parentName && options.parentName.trim()) ? options.parentName.trim() : 'Parent';
      const enNote = options.additionalNote && options.additionalNote.trim() ? options.additionalNote.trim() : 'No additional note';
      const hiGreeting = enGreeting.toLowerCase().startsWith('dear') ? 'प्रिय' : (enGreeting || 'प्रिय');
      const hiParent = (options.parentName && options.parentName.trim()) ? options.parentName.trim() : 'अभिभावक';
      const hiNote = options.additionalNote && options.additionalNote.trim() ? options.additionalNote.trim() : 'कोई अतिरिक्त नोट नहीं';

      // Bilingual
      if (options.selectedLanguage === 'both') {
        const englishFirst = options.languageOrder === 'english-first';
        const templateName = englishFirst
          ? 'fee_payment_received_confirmation_bilingual_en_hi'
          : 'fee_payment_received_confirmation_bilingual_hi_en';
        // Single combined Additional note placed between the two language blocks
        const sharedNote = options.additionalNote && options.additionalNote.trim() ? options.additionalNote.trim() : 'No additional note';
        const bodyParams: WABATemplateComponentParam[] = englishFirst ? [
          // EN block (without note)
          { type: 'text', text: enGreeting },     // 1
          { type: 'text', text: enParent },       // 2
          { type: 'text', text: options.studentName }, // 3
          { type: 'text', text: amountFmt },      // 4
          { type: 'text', text: formattedDate },  // 5
          { type: 'text', text: teacher },        // 6
          { type: 'text', text: coaching },       // 7
          // Combined note between blocks
          { type: 'text', text: sharedNote },     // 8
          // HI block (without note)
          { type: 'text', text: hiGreeting },     // 9
          { type: 'text', text: hiParent },       // 10
          { type: 'text', text: options.studentName }, // 11
          { type: 'text', text: amountFmt },      // 12
          { type: 'text', text: formattedDate },  // 13
          { type: 'text', text: teacher },        // 14
          { type: 'text', text: coaching },       // 15
        ] : [
          // HI block (without note)
          { type: 'text', text: hiGreeting },     // 1
          { type: 'text', text: hiParent },       // 2
          { type: 'text', text: options.studentName }, // 3
          { type: 'text', text: amountFmt },      // 4
          { type: 'text', text: formattedDate },  // 5
          { type: 'text', text: teacher },        // 6
          { type: 'text', text: coaching },       // 7
          // Combined note between blocks
          { type: 'text', text: sharedNote },     // 8
          // EN block (without note)
          { type: 'text', text: enGreeting },     // 9
          { type: 'text', text: enParent },       // 10
          { type: 'text', text: options.studentName }, // 11
          { type: 'text', text: amountFmt },      // 12
          { type: 'text', text: formattedDate },  // 13
          { type: 'text', text: teacher },        // 14
          { type: 'text', text: coaching },       // 15
        ];
        return await whatsappBusinessService.sendTemplateMessage({
          to: options.to,
          templateName,
          language: getTemplateLanguage(templateName),
          bodyParams,
        });
      }

      // Hindi-only
      if (options.selectedLanguage === 'hindi') {
        const templateName = 'fee_payment_received_confirmation_hi';
        const bodyParams: WABATemplateComponentParam[] = [
          { type: 'text', text: hiGreeting },     // 1
          { type: 'text', text: hiParent },       // 2
          { type: 'text', text: options.studentName }, // 3
          { type: 'text', text: amountFmt },      // 4
          { type: 'text', text: formattedDate },  // 5
          { type: 'text', text: hiNote },         // 6
          { type: 'text', text: teacher },        // 7
          { type: 'text', text: coaching },       // 8
        ];
        return await whatsappBusinessService.sendTemplateMessage({
          to: options.to,
          templateName,
          language: getTemplateLanguage(templateName),
          bodyParams,
        });
      }

      // English-only (default)
      const templateName = 'fee_payment_received_confirmation';
      const bodyParams: WABATemplateComponentParam[] = [
        { type: 'text', text: enGreeting },     // 1
        { type: 'text', text: enParent },       // 2
        { type: 'text', text: options.studentName }, // 3
        { type: 'text', text: amountFmt },      // 4
        { type: 'text', text: formattedDate },  // 5
        { type: 'text', text: enNote },         // 6
        { type: 'text', text: teacher },        // 7
        { type: 'text', text: coaching },       // 8
      ];
      return await whatsappBusinessService.sendTemplateMessage({
        to: options.to,
        templateName,
        language: getTemplateLanguage(templateName),
        bodyParams,
      });
    } catch (e) {
      logger.error('Error sending payment_received template', e);
      return false;
    }
  }

  /** Smart payment received confirmation: uses template outside 24h window, session text inside. */
  async sendSmartWhatsAppPaymentReceived(options: {
    tenantId: string;
    to: string;
    parentName?: string;
    studentName: string;
    amount: number;
    paymentDate: string;
    greeting?: string; // default Dear / प्रिय
    additionalNote?: string;
    teacherName?: string;
    coachingName?: string;
    selectedLanguage?: 'english' | 'hindi' | 'both';
    languageOrder?: 'english-first' | 'hindi-first';
  }): Promise<boolean> {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    try {
      if (!options.tenantId) {
        logger.warn('sendSmartWhatsAppPaymentReceived called without tenantId');
        return false;
      }
      const state = await whatsappConversationService.getState(options.to);
      const now = Date.now();
      const lastInbound = state?.lastInboundAt;
      const formattedDate = this.formatDueDate(options.paymentDate);
      const amountFmt = `₹${options.amount.toLocaleString()}`;
      const outsideWindow = !lastInbound || (now - lastInbound) > TWENTY_FOUR_HOURS;
      if (outsideWindow) {
        // Prefer queue-based delivery similar to fee reminders; fallback to direct template
        try {
          const { whatsappQueueClient } = require('./whatsappQueueClient');
          const resp = await whatsappQueueClient.queuePaymentConfirmation({
            tenantId: options.tenantId,
            to: options.to,
            parentName: options.parentName,
            studentName: options.studentName,
            amount: options.amount,
            paymentDate: formattedDate,
            greeting: options.greeting,
            additionalNote: options.additionalNote,
            teacherName: options.teacherName,
            coachingName: options.coachingName,
            selectedLanguage: options.selectedLanguage,
            languageOrder: options.languageOrder,
          });
          if (resp?.jobId) return true;
        } catch (qe) {
          logger.warn('Queue payment confirmation failed; fallback to direct template', qe);
        }
        return await this.sendWhatsAppPaymentReceivedTemplate({ ...options, paymentDate: formattedDate });
      }
      // Inside 24h window: session text
      const enGreeting = (options.greeting || 'Dear').trim();
      const parent = options.parentName && options.parentName.trim() ? options.parentName.trim() : 'Parent';
      const note = options.additionalNote && options.additionalNote.trim() ? options.additionalNote.trim() : 'No additional note';
      const signOffParts: string[] = [];
      if (options.teacherName) signOffParts.push(options.teacherName.trim());
      if (options.coachingName) signOffParts.push(options.coachingName.trim());
      const signOff = signOffParts.length ? `\nRegards, ${signOffParts.join(' ')}` : '';
      const sessionMessage = `Payment received – ${enGreeting} ${parent}, we have received payment of ${amountFmt} for ${options.studentName} on ${formattedDate}. Additional note: ${note}. Thank you for your payment!${signOff}`;
      return await this.sendWhatsAppMessage(options.to, sessionMessage);
    } catch (e) {
      logger.error('Error in smart WhatsApp payment received', e);
      return false;
    }
  }

  /** Generic custom message template (with optional teacher & coaching signature)
   * Template name: custom_message_with_signature
   * Suggested template body:
   * "{{1}}\n\nRegards, {{2}} {{3}}"
   * Variables:
   * 1 Custom message body (can contain line breaks)
   * 2 Teacher name (or '-')
   * 3 Coaching / Institute name (or '-')
   */
  async sendWhatsAppCustomTemplate(options: {
    to: string;
    message: string;          // raw combined message (used for single-language)
    teacherName?: string;     // optional teacher
    coachingName?: string;    // optional coaching
    selectedLanguage?: 'english' | 'hindi' | 'both';
    languageOrder?: 'english-first' | 'hindi-first';
    englishMessage?: string;  // optional explicit English segment when bilingual
    hindiMessage?: string;    // optional explicit Hindi segment when bilingual
  }): Promise<boolean> {
    try {
  const useWABA =
    !!process.env.EXPO_PUBLIC_WABA_PHONE_NUMBER_ID ||
    !!runtimeEndpoints.getSnapshot().wabaApiBaseUrl ||
    !!runtimeEndpoints.getPreferredBackendBaseUrl();
      if (!useWABA) {
        logger.warn('WABA not configured; cannot send custom WhatsApp template.');
        return false;
      }
      const teacher = options.teacherName && options.teacherName.trim() ? options.teacherName.trim() : '-';
      const coaching = options.coachingName && options.coachingName.trim() ? options.coachingName.trim() : '-';

      if (options.selectedLanguage === 'both') {
        const englishFirst = options.languageOrder === 'english-first';
        const templateName = englishFirst ? 'custom_message_with_signature_bilingual_en_hi' : 'custom_message_with_signature_bilingual_hi_en';
        let enBody = (options.englishMessage || '').trim();
        let hiBody = (options.hindiMessage || '').trim();
        if ((!enBody || !hiBody) && options.message.includes('\n\n')) {
          const parts = options.message.split(/\n\n+/);
          if (parts.length >= 2) {
            if (englishFirst) {
              enBody = enBody || parts[0].trim();
              hiBody = hiBody || parts.slice(1).join('\n\n').trim();
            } else {
              hiBody = hiBody || parts[0].trim();
              enBody = enBody || parts.slice(1).join('\n\n').trim();
            }
          }
        }
        enBody = enBody || 'This is a notice regarding your ward.';
        hiBody = hiBody || 'यह आपके विद्यार्थी के संबंध में एक नोट है।';
        const bodyParams: WABATemplateComponentParam[] = englishFirst ? [
          { type: 'text', text: enBody },      // 1 EN body
          { type: 'text', text: teacher },     // 2 EN teacher
          { type: 'text', text: coaching },    // 3 EN coaching
          { type: 'text', text: hiBody },      // 4 HI body
          { type: 'text', text: teacher },     // 5 HI teacher (same value allowed)
          { type: 'text', text: coaching },    // 6 HI coaching
        ] : [
          { type: 'text', text: hiBody },      // 1 HI body
          { type: 'text', text: teacher },     // 2 HI teacher
          { type: 'text', text: coaching },    // 3 HI coaching
          { type: 'text', text: enBody },      // 4 EN body
          { type: 'text', text: teacher },     // 5 EN teacher
          { type: 'text', text: coaching },    // 6 EN coaching
        ];
        return await whatsappBusinessService.sendTemplateMessage({
          to: options.to,
          templateName,
          language: getTemplateLanguage(templateName),
          bodyParams,
        });
      }

      if (options.selectedLanguage === 'hindi') {
        const hiBody = (options.hindiMessage || options.message).trim() || 'यह आपके विद्यार्थी के संबंध में एक नोट है।';
        return await whatsappBusinessService.sendTemplateMessage({
          to: options.to,
          templateName: 'custom_message_with_signature_hi_new',
          language: getTemplateLanguage('custom_message_with_signature_hi_new'),
          bodyParams: [
            { type: 'text', text: hiBody },    // 1 Body
            { type: 'text', text: teacher },   // 2 Teacher
            { type: 'text', text: coaching },  // 3 Coaching
          ],
        });
      }

      // English (default)
    const body = options.message.trim() || 'This is a notice regarding your ward.';
      return await whatsappBusinessService.sendTemplateMessage({
        to: options.to,
        templateName: 'custom_message_with_signature',
        language: getTemplateLanguage('custom_message_with_signature'),
        bodyParams: [
      { type: 'text', text: body },       // 1 Body
      { type: 'text', text: teacher },    // 2 Teacher
      { type: 'text', text: coaching },   // 3 Coaching
        ],
      });
    } catch (e) {
      logger.error('Failed to send custom WhatsApp template', e);
      return false;
    }
  }

  /** Smart custom WhatsApp message: uses template outside 24h window, session text inside. */
  async sendSmartWhatsAppCustomMessage(options: {
    to: string;
    message: string;          // full desired message body (without explicit Regards line; signature auto-handled)
    teacherName?: string;
    coachingName?: string;
  }): Promise<boolean> {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    try {
      const state = await whatsappConversationService.getState(options.to);
      const now = Date.now();
      const lastInbound = state?.lastInboundAt;
      const outsideWindow = !lastInbound || (now - lastInbound) > TWENTY_FOUR_HOURS;
      if (outsideWindow) {
        return await this.sendWhatsAppCustomTemplate({
          to: options.to,
          message: options.message,
          teacherName: options.teacherName,
          coachingName: options.coachingName,
        });
      }
      // Inside window: append signature inline for session text
      const signOffParts: string[] = [];
      if (options.teacherName) signOffParts.push(options.teacherName.trim());
      if (options.coachingName) signOffParts.push(options.coachingName.trim());
      const signOff = signOffParts.length ? `\nRegards, ${signOffParts.join(' ')}` : '';
      return await this.sendWhatsAppMessage(options.to, `${options.message.trim()}${signOff}`);
    } catch (e) {
      logger.error('Error in smart custom WhatsApp message', e);
      return false;
    }
  }

  /** Unified smart fee reminder (auto template vs session) */
  async sendSmartWhatsAppFeeReminder(options: {
    tenantId: string;
    to: string;
    parentName?: string;
    studentName: string;
    amount: number;
    dueDate: string;           // raw date string
    greeting?: string;
    customNotes?: string;
    teacherName?: string;
    coachingName?: string;
  selectedLanguage?: 'english' | 'hindi' | 'both';
  languageOrder?: 'english-first' | 'hindi-first';
  }): Promise<boolean> {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    try {
      if (!options.tenantId) {
        logger.warn('sendSmartWhatsAppFeeReminder called without tenantId');
        return false;
      }
      // Fetch last inbound timestamp
      const state = await whatsappConversationService.getState(options.to);
      const now = Date.now();
      const lastInbound = state?.lastInboundAt;

      // Format due date nicely (e.g., 15 Sept 2025)
      const formattedDue = this.formatDueDate(options.dueDate);

      const outsideWindow = !lastInbound || (now - lastInbound) > TWENTY_FOUR_HOURS;
      if (outsideWindow) {
        // Queue instead of direct send to unify flow
        try {
          const { whatsappQueueClient } = require('./whatsappQueueClient');
          const resp = await whatsappQueueClient.queueFeeReminder({
            tenantId: options.tenantId,
            to: options.to,
            parentName: options.parentName,
            studentName: options.studentName,
            amount: options.amount,
            dueDate: formattedDue,
            greeting: options.greeting,
            customNotes: options.customNotes,
            teacherName: options.teacherName,
            coachingName: options.coachingName,
            selectedLanguage: options.selectedLanguage,
            languageOrder: options.languageOrder,
          });
          return !!resp.jobId;
        } catch (qe) {
          logger.warn('Queue fee reminder fallback to direct template send', qe);
          const sentExtended = await this.sendWhatsAppFeeDueTemplateExtended({
            to: options.to,
            parentName: options.parentName,
            studentName: options.studentName,
            amount: options.amount,
            dueDate: formattedDue,
            greeting: options.greeting,
            customNotes: options.customNotes,
            teacherName: options.teacherName,
            coachingName: options.coachingName,
            selectedLanguage: options.selectedLanguage,
            languageOrder: options.languageOrder,
          });
          return sentExtended;
        }
      }
      // Inside window → send session text
      const displayParent = options.parentName && options.parentName.trim() ? options.parentName.trim() : 'Parent';
      const amountFmt = `₹${options.amount.toLocaleString()}`;
  const base = `${options.greeting || 'Dear'} ${displayParent}, ${options.studentName}'s tuition fee of ${amountFmt} is due on ${formattedDue}.`;
      const notes = options.customNotes ? ` ${options.customNotes}` : '';
      const signOffParts: string[] = [];
      if (options.teacherName) signOffParts.push(options.teacherName);
      if (options.coachingName) signOffParts.push(options.coachingName);
      const signOff = signOffParts.length ? `\nRegards, ${signOffParts.join(' ')}` : '';
      const sessionMessage = base + notes + signOff;
      return await this.sendWhatsAppMessage(options.to, sessionMessage);
    } catch (e) {
      logger.error('Error in smart WhatsApp fee reminder', e);
      return false;
    }
  }

  private formatDueDate(raw: string): string {
    // Attempt to parse ISO or fallback; return already formatted if cannot parse.
    try {
      const d = new Date(raw);
      if (isNaN(d.getTime())) return raw;
      const day = d.getDate();
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
      const month = monthNames[d.getMonth()];
      const year = d.getFullYear();
      return `${day} ${month} ${year}`;
    } catch {
      return raw;
    }
  }

  async sendVoiceCall(
    phoneNumber: string,
    message: string,
    language?: 'english' | 'hindi' | 'both',
    voice?: string,
    hindiVoice?: string,
    englishVoice?: string,
    options?: { tenantId?: string; quotaBatchId?: string; historyId?: string; history?: any }
  ): Promise<boolean> {
    try {
      const tenantId = (options?.tenantId || (await tenantService.getCachedSelectedTenant()) || '').trim();
      if (!tenantId) {
        throw new Error('Tenant id missing for voice call');
      }
      const success = await twilioBackendClient.sendVoiceCall({
        tenantId,
        to: phoneNumber,
        message,
        language,
        voice,
        hindiVoice,
        englishVoice,
        quotaBatchId: options?.quotaBatchId,
        historyId: options?.historyId,
        history: options?.history,
      });
      return success;
    } catch (error) {
      logger.error('Error initiating voice call:', error);
      return false;
    }
  }

  // Helper methods for generating messages
  generateFeeReminderMessage(studentName: string, amount: number, dueDate: string, teacherName: string): string {
  return twilioBackendClient.formatFeeReminderMessage(studentName, amount, dueDate, teacherName);
  }

  generatePaymentConfirmationMessage(studentName: string, amount: number, teacherName: string): string {
  return twilioBackendClient.formatPaymentConfirmationMessage(studentName, amount, teacherName);
  }

  getExpoPushToken(): string | null {
    return this.expoPushToken;
  }

  async refreshExpoPushToken(): Promise<string | null> {
    if (Platform.OS === 'web') {
      logger.debug('Push token refresh skipped on web platform.');
      return null;
    }

    try {
      const token = await this.registerForPushNotificationsAsync({ skipDeviceRegistration: true });
      const resolvedToken = token || this.expoPushToken;

      if (resolvedToken && this.currentUserEmail) {
        try {
          await getDeviceTrackingService().registerDevice(this.currentUserEmail, resolvedToken);
        } catch (error) {
          logger.error('Failed to sync refreshed push token with device tracking service:', error);
        }
      }

      return resolvedToken ?? null;
    } catch (error) {
      logger.error('Failed to refresh Expo push token:', error);
      return this.expoPushToken;
    }
  }

  // Get template configuration guide
  getEmailTemplateGuide(): string {
    return emailService.getTemplateConfigurationGuide();
  }

  // ===== ENHANCED CHAT NOTIFICATION METHODS =====

  /**
   * Build notification content based on message type
   */
  private buildChatNotificationContent(message: ChatMessage): {
    title: string;
    body: string;
    type: string;
  } {
    const senderName = this.extractDisplayName(message.sender);
    
    // Handle special messages
    if (message.isSpecial) {
      return {
        title: `⭐ Important Message from ${senderName}`,
        body: message.text || 'Special announcement',
        type: 'special_message',
      };
    }

    // Handle sticker messages
    if (message.sticker) {
      return {
        title: `${senderName}`,
        body: `🎯 Sent a sticker`,
        type: 'sticker_message',
      };
    }

    // Handle GIF messages
    if (message.gif) {
      return {
        title: `${senderName}`,
        body: `📹 Sent a GIF`,
        type: 'gif_message',
      };
    }

    // Handle messages with multiple attachments
    if (message.attachments && message.attachments.length > 0) {
      const fileCount = message.attachments.length;
      const hasText = message.text && message.text.trim().length > 0;
      
      if (fileCount === 1) {
        const attachment = message.attachments[0];
        const fileTypeEmoji = this.getFileTypeEmoji(attachment.fileType, attachment.fileName);
        const messageBody = hasText 
          ? `${fileTypeEmoji} ${attachment.fileName}: ${message.text}`
          : `${fileTypeEmoji} Sent ${attachment.fileName}`;
        
        return {
          title: `${senderName}`,
          body: messageBody,
          type: 'file_message',
        };
      } else {
        const messageBody = hasText
          ? `📎 Sent ${fileCount} files: ${message.text}`
          : `📎 Sent ${fileCount} files`;
        
        return {
          title: `${senderName}`,
          body: messageBody,
          type: 'multiple_files_message',
        };
      }
    }

    // Handle legacy single file format
    if (message.fileUrl && message.fileName && message.fileType) {
      const fileTypeEmoji = this.getFileTypeEmoji(message.fileType, message.fileName);
      const hasText = message.text && message.text.trim().length > 0;
      const messageBody = hasText
        ? `${fileTypeEmoji} ${message.fileName}: ${message.text}`
        : `${fileTypeEmoji} Sent ${message.fileName}`;
      
      return {
        title: `${senderName}`,
        body: messageBody,
        type: 'file_message',
      };
    }

    // Handle text-only messages
    const messageText = message.text || 'New message';
    return {
      title: `${senderName}`,
      body: messageText.length > 100 ? `${messageText.substring(0, 100)}...` : messageText,
      type: 'text_message',
    };
  }

  /**
   * Get appropriate emoji for file types
   */
  private getFileTypeEmoji(fileType: string, fileName: string): string {
    const type = fileType.toLowerCase();
    const name = fileName.toLowerCase();
    
    // Images
    if (type.startsWith('image/') || /\.(jpg|jpeg|png|gif|bmp|webp)$/.test(name)) {
      return '🖼️';
    }
    
    // Videos
    if (type.startsWith('video/') || /\.(mp4|avi|mov|mkv|wmv|flv)$/.test(name)) {
      return '🎥';
    }
    
    // Audio
    if (type.startsWith('audio/') || /\.(mp3|wav|aac|flac|ogg|m4a)$/.test(name)) {
      return '🎵';
    }
    
    // Documents
    if (type === 'application/pdf' || name.endsWith('.pdf')) {
      return '📄';
    }
    
    if (/\.(doc|docx)$/.test(name) || type.includes('word')) {
      return '📝';
    }
    
    if (/\.(xls|xlsx)$/.test(name) || type.includes('spreadsheet')) {
      return '📊';
    }
    
    if (/\.(ppt|pptx)$/.test(name) || type.includes('presentation')) {
      return '📋';
    }
    
    // Code files
    if (/\.(js|ts|jsx|tsx|html|css|py|java|cpp|c|php|rb|go|rs|swift)$/.test(name)) {
      return '💻';
    }
    
    // Archives
    if (/\.(zip|rar|7z|tar|gz)$/.test(name)) {
      return '🗜️';
    }
    
    // Default file
    return '📎';
  }

  /**
   * Extract display name from email with improved formatting
   */
  private extractDisplayName(email: string): string {
    if (!email) return 'Unknown User';
    
    // Extract the part before @
    const username = email.split('@')[0].toLowerCase();
    
    // Try to intelligently parse the username
    let displayName = '';
    
    // Handle common patterns like: firstname.lastname, first_last, firstlast
    if (username.includes('.')) {
      // Handle firstname.lastname pattern
      const parts = username.split('.');
      displayName = parts
        .map(part => this.capitalizeWord(part))
        .join(' ');
    } else if (username.includes('_')) {
      // Handle first_last pattern
      const parts = username.split('_');
      displayName = parts
        .map(part => this.capitalizeWord(part))
        .join(' ');
    } else if (username.includes('-')) {
      // Handle first-last pattern
      const parts = username.split('-');
      displayName = parts
        .map(part => this.capitalizeWord(part))
        .join(' ');
    } else {
      // For single words like "krvikrantsingh51", try to extract meaningful parts
      displayName = this.parseComplexUsername(username);
    }
    
    return displayName || this.capitalizeWord(username);
  }

  /**
   * Parse complex usernames like "krvikrantsingh51" into "Vikrant Singh"
   */
  private parseComplexUsername(username: string): string {
    // Remove numbers from the end
    const cleanUsername = username.replace(/\d+$/, '');
    
    // Common name patterns to look for
    const namePatterns = [
      // Look for common prefixes and extract main name
      { pattern: /^(kr|mr|ms|dr)(.+)/, extract: 2 }, // kr-vikrantsingh -> vikrantsingh
      { pattern: /^(.+)(kumar|singh|sharma|gupta|verma|yadav|mishra|jain|agarwal)$/, extract: 'both' },
      // Add more patterns as needed
    ];
    
    for (const { pattern, extract } of namePatterns) {
      const match = cleanUsername.match(pattern);
      if (match) {
        if (extract === 'both') {
          // Extract both parts and capitalize
          const firstName = this.capitalizeWord(match[1]);
          const lastName = this.capitalizeWord(match[2]);
          return `${firstName} ${lastName}`;
        } else if (typeof extract === 'number') {
          // Extract specific group
          return this.parseNameFromString(match[extract]);
        }
      }
    }
    
    // If no pattern matches, try to split camelCase or find word boundaries
    return this.parseNameFromString(cleanUsername);
  }

  /**
   * Parse name from a string by detecting word boundaries
   */
  private parseNameFromString(str: string): string {
    if (!str) return '';
    
    // Try to detect camelCase or word boundaries
    const words = str
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
      .split(/[\s_-]+/) // Split on common separators
      .filter(word => word.length > 1) // Remove single characters
      .slice(0, 3) // Take first 3 words max
      .map(word => this.capitalizeWord(word));
    
    return words.join(' ') || this.capitalizeWord(str);
  }

  /**
   * Capitalize a word properly
   */
  private capitalizeWord(word: string): string {
    if (!word) return '';
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  // ===== DUE DATE NOTIFICATION METHODS =====

  /**
   * Schedule notifications for upcoming fee due dates
   */
  async scheduleDueDateNotifications(): Promise<void> {
    try {
      // Import fees service to get due dates
      // const feeService = await import('../services/feeService'); // Adjust import as needed
      
      // Cancel existing scheduled notifications for due dates
      await this.cancelScheduledDueDateNotifications();
      
      // This would typically get fee data from your fee service
      // For now, we'll create a placeholder implementation
      await this.scheduleUpcomingDueReminders();
    } catch (error) {
      logger.error('Error scheduling due date notifications:', error);
    }
  }

  /**
   * Cancel existing scheduled due date notifications
   */
  private async cancelScheduledDueDateNotifications(): Promise<void> {
    try {
      const scheduledNotifications = await Notifications.getAllScheduledNotificationsAsync();
      const dueNotificationIds = scheduledNotifications
        .filter(notif => notif.content.data?.type === 'fee_due')
        .map(notif => notif.identifier);
      
      for (const id of dueNotificationIds) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    } catch (error) {
      logger.error('Error canceling scheduled due date notifications:', error);
    }
  }

  /**
   * Schedule upcoming fee due reminders
   */
  private async scheduleUpcomingDueReminders(): Promise<void> {
    try {
      // This is a placeholder - you'd typically get this data from your fee service
      const upcomingDues = await this.getUpcomingDueDates();
      
      for (const due of upcomingDues) {
        // Schedule notification for the due date
        await this.scheduleFeeDueNotification(due);
        
        // Schedule reminder 1 day before
        await this.scheduleFeeDueNotification(due, -1);
        
        // Schedule reminder 3 days before
        await this.scheduleFeeDueNotification(due, -3);
      }
    } catch (error) {
      logger.error('Error scheduling fee due reminders:', error);
    }
  }

  /**
   * Get upcoming due dates from fee service
   */
  private async getUpcomingDueDates(): Promise<Array<{
    id: string;
    studentName: string;
    amount: number;
    dueDate: string;
    description: string;
  }>> {
    // This should integrate with your actual fee service
    // For now, returning empty array - implement based on your fee data structure
    return [];
  }

  /**
   * Schedule individual fee due notification
   */
  private async scheduleFeeDueNotification(
    due: { id: string; studentName: string; amount: number; dueDate: string; description: string },
    daysBefore: number = 0
  ): Promise<void> {
    try {
      const dueDate = new Date(due.dueDate);
      const notificationDate = new Date(dueDate);
      notificationDate.setDate(dueDate.getDate() - daysBefore);
      
      // Don't schedule notifications in the past
      if (notificationDate < new Date()) {
        return;
      }
      
      const isToday = daysBefore === 0;
      const title = isToday ? '💰 Fee Due Today!' : `💰 Fee Due ${daysBefore === 1 ? 'Tomorrow' : `in ${daysBefore} days`}`;
      const body = `${due.studentName}: ₹${due.amount} - ${due.description}`;
      
      const secondsUntilNotification = Math.max(1, Math.floor((notificationDate.getTime() - Date.now()) / 1000));
      
      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data: {
            type: 'fee_due',
            feeId: due.id,
            studentName: due.studentName,
            amount: due.amount,
            dueDate: due.dueDate,
            daysBefore,
          },
        },
        trigger: { seconds: secondsUntilNotification } as any, // Type workaround for Expo notifications
      });
    } catch (error) {
      logger.error('Error scheduling individual fee due notification:', error);
    }
  }

  // ===== GENERAL APP NOTIFICATIONS =====

  /**
   * Send notification for new student enrollment
   */
  async sendStudentEnrollmentNotification(studentName: string): Promise<void> {
    await this.sendLocalNotification({
      title: '👨‍🎓 New Student Enrolled!',
      body: `${studentName} has been successfully enrolled.`,
      data: { type: 'student_enrollment', studentName },
    });
  }

  /**
   * Send notification for payment received
   */
  async sendPaymentReceivedNotification(studentName: string, amount: number): Promise<void> {
    await this.sendLocalNotification({
      title: '💰 Payment Received!',
      body: `₹${amount} received from ${studentName}`,
      data: { type: 'payment_received', studentName, amount },
    });
  }

  /**
   * Send notification for attendance updates
   */
  async sendAttendanceNotification(message: string): Promise<void> {
    await this.sendLocalNotification({
      title: '📋 Attendance Update',
      body: message,
      data: { type: 'attendance_update' },
    });
  }

  /**
   * Send notification for low attendance
   */
  async sendLowAttendanceAlert(studentName: string, attendancePercentage: number): Promise<void> {
    await this.sendLocalNotification({
      title: '⚠️ Low Attendance Alert',
      body: `${studentName} has ${attendancePercentage}% attendance. Consider contacting parents.`,
      data: { type: 'low_attendance', studentName, attendancePercentage },
    });
  }

  /**
   * Send notification for system updates
   */
  async sendSystemUpdateNotification(updateMessage: string): Promise<void> {
    await this.sendLocalNotification({
      title: '🔄 System Update',
      body: updateMessage,
      data: { type: 'system_update' },
    });
  }

  /**
   * Send notification for backup completion
   */
  async sendBackupNotification(success: boolean, message?: string): Promise<void> {
    await this.sendLocalNotification({
      title: success ? '✅ Backup Completed' : '❌ Backup Failed',
      body: message || (success ? 'Data backup completed successfully.' : 'Data backup failed. Please try again.'),
      data: { type: 'backup_status', success },
    });
  }

  // ===== TEACHER/FACULTY TUITION MANAGEMENT NOTIFICATIONS =====

  /**
   * Send notification when a teacher sends a reminder to parents
   */
  async sendReminderSentConfirmation(reminderType: string, studentCount: number, successCount: number, failedCount: number): Promise<void> {
    const successRate = Math.round((successCount / studentCount) * 100);
    await this.sendLocalNotification({
      title: `📬 ${reminderType} Reminders Sent`,
      body: `${successCount}/${studentCount} reminders sent successfully (${successRate}%)${failedCount > 0 ? `, ${failedCount} failed` : ''}`,
      data: { 
        type: 'reminder_sent', 
        reminderType,
        studentCount,
        successCount,
        failedCount
      },
    });
  }

  /**
   * Send notification for overdue fees (for teacher awareness)
   */
  async sendOverdueFeeTeacherAlert(studentName: string, amount: number, daysPastDue: number): Promise<void> {
    await this.sendLocalNotification({
      title: '⚠️ Fee Overdue Alert',
      body: `${studentName}: ₹${amount} is ${daysPastDue} days overdue. Consider sending reminder to parent.`,
      data: { 
        type: 'fee_overdue_alert', 
        studentName, 
        amount, 
        daysPastDue,
        priority: 'high'
      },
    });
  }

  /**
   * Send notification for new fee payment received
   */
  async sendFeePaymentReceived(studentName: string, amount: number, paymentMethod: string): Promise<void> {
    await this.sendLocalNotification({
      title: '� Fee Payment Received!',
      body: `₹${amount} received from ${studentName} via ${paymentMethod}`,
      data: { 
        type: 'payment_received', 
        studentName, 
        amount,
        paymentMethod
      },
    });
  }

  /**
   * Send notification for new student enrollment
   */
  async sendNewStudentEnrolled(studentName: string, grade: string, subjects: string[]): Promise<void> {
    await this.sendLocalNotification({
      title: '👨‍� New Student Enrolled!',
      body: `${studentName} (Grade ${grade}) enrolled for ${subjects.join(', ')}`,
      data: { 
        type: 'new_enrollment', 
        studentName, 
        grade,
        subjects
      },
    });
  }

  /**
   * Send notification for team communication (chat messages between teachers)
   * @deprecated Use sendSmartChatNotification instead for better context awareness
   */
  async sendTeamChatNotification(
    message: ChatMessage, 
    recipientEmail: string, 
    currentUserEmail: string,
    isCurrentChatActive?: boolean,
    senderName?: string
  ): Promise<void> {
    // Redirect to the smart notification system for consistency
    return this.sendSmartChatNotification(message, recipientEmail, currentUserEmail, {
      isCurrentChatActive,
      skipNativeLocal: true
    }, senderName);
  }

  /**
   * Send smart notification with context awareness
   */
  async sendSmartChatNotification(
    message: ChatMessage,
    recipientEmail: string,
    currentUserEmail: string,
    context: {
      isCurrentChatActive?: boolean;
      currentChatPartner?: string;
      isAppFocused?: boolean;
  isTabVisible?: boolean;
  skipNativeLocal?: boolean;
  forceNativeLocal?: boolean;
    } = {},
    senderName?: string
  ): Promise<void> {
    try {
      // CRITICAL: Don't send notification to the sender themselves
      if (message.sender.toLowerCase() === recipientEmail.toLowerCase()) {
        logger.debug('🚫 Skipping: sender is same as recipient');
        return;
      }

      // CRITICAL: Don't send notification if current user sent this message
      if (message.sender.toLowerCase() === currentUserEmail.toLowerCase()) {
        logger.debug('🚫 Skipping: current user sent this message');
        return;
      }

      if (!this.notificationsEnabled || !this.chatNotificationsEnabled) {
        logger.debug('Chat notifications disabled by user preference; skipping smart chat notification.');
        return;
      }

      // Check for duplicate notification FIRST to prevent multiple processing
      const notificationId = this.generateNotificationId(
        message.id || '',
        message.sender,
        recipientEmail,
        typeof message.timestamp === 'string' ? new Date(message.timestamp).getTime() : message.timestamp
      );

      if (this.wasNotificationSent(notificationId)) {
        return;
      }

      // Check if this message is from the currently active chat
      const fromContextActiveChat = context.currentChatPartner && 
        message.sender.toLowerCase() === context.currentChatPartner.toLowerCase();
      const fromTrackedActiveChat = this.isUserActivelyViewingChat(message.sender);
      const isFromActiveChat = fromContextActiveChat || fromTrackedActiveChat;

      // Check if user is actively engaged with the app
      const isUserActivelyEngaged = context.isAppFocused && context.isTabVisible && context.isCurrentChatActive;

      // Skip notification if user is actively viewing this specific chat
      if (isFromActiveChat) {
        if (isUserActivelyEngaged || fromTrackedActiveChat) {
          logger.debug('Skipping chat notification because user is currently in the conversation', {
            sender: message.sender,
            recipientEmail,
          });
          return;
        }
      }

      // For web, do additional checks
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        const isPageVisible = document.visibilityState === 'visible';
        const isPageFocused = document.hasFocus();
        
        // If user is focused on the page and this is from the active chat, skip
        if (isPageVisible && isPageFocused && isFromActiveChat) {
          return;
        }
      }

      const skipPreference = context.skipNativeLocal ?? true;
      const shouldSkipNativeLocal = Platform.OS !== 'web' && skipPreference && context.forceNativeLocal !== true;
      if (shouldSkipNativeLocal) {
        logger.debug('Skipping native local chat notification; relying on remote push delivery', {
          messageId: message.id,
          recipientEmail
        });
        this.markNotificationSent(notificationId);
        return;
      }

      // Send the notification
      const notificationContent = this.buildTeamChatNotificationContent(message, senderName);
      await this.sendLocalNotification({
        title: notificationContent.title,
        body: notificationContent.body,
        data: {
          type: 'chat_message',
          messageId: message.id,
          senderEmail: message.sender,
          recipientEmail: recipientEmail,
          chatId: `${message.sender}_${recipientEmail}`,
          timestamp: message.timestamp,
          isSpecial: message.isSpecial || false
        }
      });

      // Mark notification as sent to prevent duplicates
      this.markNotificationSent(notificationId);
    } catch (error) {
      logger.error('Error sending smart chat notification:', error);
    }
  }

  async sendRemoteChatNotification(
    message: ChatMessage,
    recipientEmail: string,
    senderName?: string
  ): Promise<void> {
    try {
      if (!recipientEmail) {
        return;
      }

      const normalizedRecipient = recipientEmail.trim().toLowerCase();
      const sender = typeof message.sender === 'string' ? message.sender.trim().toLowerCase() : '';

      if (!normalizedRecipient || !sender) {
        return;
      }

      if (sender === normalizedRecipient) {
        return;
      }

      if (!this.notificationsEnabled || !this.chatNotificationsEnabled) {
        logger.debug('Chat notifications disabled by user preference; skipping remote chat notification.');
        return;
      }

      const notificationContent = this.buildTeamChatNotificationContent(message, senderName);
      const tenantFilterOptions = await this.resolveTenantFilterOptions(true);
      const deliveryResult = await getDeviceTrackingService().sendNotificationToUser(
        normalizedRecipient,
        {
          title: notificationContent.title,
          body: notificationContent.body,
          data: {
            type: 'chat_message',
            messageId: message.id,
            senderEmail: message.sender,
            recipientEmail: normalizedRecipient,
            chatId: `${message.sender}_${normalizedRecipient}`,
            timestamp: message.timestamp || new Date().toISOString(),
            isSpecial: message.isSpecial || false,
            tenantId: tenantFilterOptions?.tenantId,
            remote: true,
          },
        },
        false,
        tenantFilterOptions
      );
      if (deliveryResult.pushAcceptedCount > 0) {
        const messageId = typeof message.id === 'string' ? message.id.trim() : '';
        const currentUserEmail =
          typeof this.currentUserEmail === 'string' ? this.currentUserEmail.trim().toLowerCase() : '';
        const senderMatchesCurrentUser = Boolean(currentUserEmail) && currentUserEmail === sender;

        if (messageId && senderMatchesCurrentUser) {
          const deliveredAt = new Date().toISOString();
          void chatService.confirmOutboundDelivery(normalizedRecipient, [messageId], {
            tenantId: tenantFilterOptions?.tenantId,
            provenance: {
              sources: ['push'],
              lastSource: 'push',
              lastUpdatedAt: deliveredAt,
              push: {
                deliveredAt,
                acceptedDeviceCount: deliveryResult.pushAcceptedCount,
                mobileAcceptedCount: deliveryResult.mobilePushAcceptedCount,
                webAcceptedCount: deliveryResult.webPushAcceptedCount,
              },
            },
          })
            .then((result) => {
              logger.debug('Marked outbound chat message delivered via push acceptance fallback', {
                messageId,
                recipientEmail: normalizedRecipient,
                deliveredCount: result.deliveredCount,
                pushAcceptedCount: deliveryResult.pushAcceptedCount,
                mobileAcceptedCount: deliveryResult.mobilePushAcceptedCount,
                webAcceptedCount: deliveryResult.webPushAcceptedCount,
              });
            })
            .catch((confirmError) => {
              logger.warn('Push acceptance fallback delivery confirmation failed', {
                messageId,
                recipientEmail: normalizedRecipient,
                error: confirmError,
              });
            });
        } else {
          logger.debug('Push accepted for chat notification; skipped outbound-delivered fallback', {
            messageId,
            sender,
            currentUserEmail,
            recipientEmail: normalizedRecipient,
            pushAcceptedCount: deliveryResult.pushAcceptedCount,
          });
        }
      }
    } catch (error) {
      logger.error('Failed to send remote chat notification:', error);
    }
  }

  async handleNotificationResponse(response: Notifications.NotificationResponse): Promise<void> {
    try {
      const { notification, userText, actionIdentifier } = response;
      const responseData = notification?.request?.content?.data as Record<string, any> | undefined;
      await confirmInboundChatDeliveryFromNotificationData(responseData, 'response', {
        currentUserEmail: this.currentUserEmail,
      });
      await flushPendingInboundChatDeliveryReceipts({
        currentUserEmail: this.currentUserEmail,
        maxBatchSize: 30,
      });
      const notificationId = notification?.request?.identifier ?? null;

      if (notificationId && this.lastHandledNotificationId === notificationId) {
        logger.debug('Notification response already handled; skipping duplicate processing.', {
          notificationId,
        });
        return;
      }

      if (notificationId) {
        this.lastHandledNotificationId = notificationId;
      }

      if (actionIdentifier === 'reply' && userText) {
        await this.handleQuickReply(notification, userText);
        return;
      }

      if (
        actionIdentifier === 'view' ||
        actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER ||
        !actionIdentifier
      ) {
        this.handleViewMessage(notification);
        const senderEmail = typeof notification.request.content.data?.senderEmail === 'string'
          ? notification.request.content.data.senderEmail
          : undefined;
        if (senderEmail) {
          try {
            await this.clearChatNotificationsForSender(senderEmail);
          } catch (error) {
            logger.debug('Failed to clear chat notifications after response', error);
          }
        }
        return;
      }

      // Fallback: attempt default handling for any other actions
      this.handleViewMessage(notification);
    } catch (error) {
      logger.error('Failed to handle notification response:', error);
    }
  }

  private async handleQuickReply(notification: Notifications.Notification, replyText: string): Promise<void> {
    try {
      const data = notification.request.content.data;
      const chatId = data?.chatId as string | undefined;
      const senderEmail = data?.senderEmail as string | undefined;
      const recipientEmail = data?.recipientEmail as string | undefined;

      if (chatId && senderEmail && recipientEmail && replyText) {
        await chatService.sendMessage({
          text: replyText,
          sender: recipientEmail,
          recipientId: senderEmail,
          isSpecial: false,
        });

        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
            new Notification('Reply Sent', {
              body: `Your reply "${replyText}" has been sent successfully.`,
              icon: '/favicon.ico',
            });
          }
        } else {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Reply Sent',
              body: `Your reply "${replyText}" has been sent successfully.`,
            },
            trigger: null,
          });
        }
      }
    } catch (error) {
      logger.error('Error sending quick reply:', error);

      if (Platform.OS === 'web') {
        if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          new Notification('Reply Failed', {
            body: 'Failed to send your reply. Please try again in the app.',
            icon: '/favicon.ico',
          });
        }
      } else {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Reply Failed',
            body: 'Failed to send your reply. Please try again in the app.',
          },
          trigger: null,
        });
      }
    }
  }

  private handleViewMessage(notification: Notifications.Notification): void {
    const data = notification.request.content.data || {};

    logger.info('View message action triggered:', data);
    this.handleNotificationNavigation(data);
  }

  private handleNotificationNavigation(rawData: Record<string, any> | undefined): void {
    const data = this.normalizeNotificationPayload(rawData);
    const type = data?.type;

    if (type === 'chat_message' || type === 'team_chat_message') {
      this.handleChatNotificationTap(data);
      return;
    }

    this.navigateToNotificationRoute('/(tabs)');
  }

  private normalizeNotificationPayload(rawData: Record<string, any> | undefined): Record<string, any> {
    const data = rawData && typeof rawData === 'object' ? { ...rawData } : {};
    if (!data.type && typeof rawData?.type === 'string') {
      data.type = rawData.type;
    }
    return data;
  }

  private resolveNotificationDeepLink(data: Record<string, any> | undefined): string | undefined {
    if (!data || typeof data !== 'object') {
      return undefined;
    }

    if (data.type === 'chat_message' || data.type === 'team_chat_message') {
      return undefined;
    }

    return '/(tabs)';
  }

  private navigateToNotificationRoute(route: string, retryCount = 0): void {
    try {
      router.navigate(route as any);
    } catch (error) {
      logger.warn('Notification route navigation failed', {
        route,
        retryCount,
        error,
      });

      if (retryCount >= 5) {
        return;
      }

      setTimeout(() => {
        this.navigateToNotificationRoute(route, retryCount + 1);
      }, Math.min(250 * (retryCount + 1), 1500));
    }
  }

  private scheduleChatNavigationAttempt(retryCount = 0): void {
    if (this.chatNavigationRetryTimeout) {
      clearTimeout(this.chatNavigationRetryTimeout);
      this.chatNavigationRetryTimeout = null;
    }

    const delay = retryCount === 0 ? 0 : Math.min(500 * retryCount, 2000);

    this.chatNavigationRetryTimeout = setTimeout(() => {
      try {
        router.navigate('/(tabs)/chat');
        this.chatNavigationRetryTimeout = null;
      } catch (error) {
        logger.warn('Chat navigation attempt failed; will retry if possible.', {
          retryCount,
          error,
        });

        if (retryCount < 5) {
          this.scheduleChatNavigationAttempt(retryCount + 1);
        } else {
          this.chatNavigationRetryTimeout = null;
        }
      }
    }, delay);
  }

  async checkInitialNotificationResponse(force = false): Promise<void> {
    if (this.hasCheckedInitialNotificationResponse && !force) {
      return;
    }

    this.hasCheckedInitialNotificationResponse = true;

    try {
      if (Platform.OS === 'web' || typeof Notifications.getLastNotificationResponseAsync !== 'function') {
        logger.debug('Skipping initial notification inspection on unsupported platform.');
        return;
      }

      const response = await Notifications.getLastNotificationResponseAsync();
      if (!response) {
        return;
      }

      await this.handleNotificationResponse(response);
    } catch (error) {
      logger.warn('Unable to inspect initial notification response:', error);
    }
  }

  handleChatNotificationTap(data: Record<string, any> | undefined): void {
    const senderEmail = typeof data?.senderEmail === 'string' ? data.senderEmail : undefined;
    const chatId = typeof data?.chatId === 'string' ? data.chatId : undefined;
    const messageId = typeof data?.messageId === 'string' ? data.messageId : undefined;
    const senderName = typeof data?.senderName === 'string' ? data.senderName : undefined;
    const timestamp = data?.timestamp;

    if (senderEmail && this.isUserActivelyViewingChat(senderEmail)) {
      logger.debug('User is actively viewing chat; suppressing notification tap navigation.', {
        senderEmail,
      });
      return;
    }

    this.pendingChatNavigation = {
      chatId,
      senderEmail,
      senderName,
      messageId,
      timestamp,
    };

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(PENDING_CHAT_STORAGE_KEY, JSON.stringify(this.pendingChatNavigation));
      } catch {
      }
    }

    this.scheduleChatNavigationAttempt();
  }

  getPendingChatNavigationTarget(): PendingChatNavigationTarget | null {
    if (this.pendingChatNavigation) {
      return this.pendingChatNavigation;
    }

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage.getItem(PENDING_CHAT_STORAGE_KEY);
        if (!raw) {
          return null;
        }

        const parsed = JSON.parse(raw) as PendingChatNavigationTarget;
        if (parsed && typeof parsed === 'object') {
          this.pendingChatNavigation = parsed;
          return parsed;
        }
      } catch {
      }
    }

    return null;
  }

  consumePendingChatNavigationTarget(): PendingChatNavigationTarget | null {
    const target = this.pendingChatNavigation;
    this.pendingChatNavigation = null;

    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(PENDING_CHAT_STORAGE_KEY);
      } catch {
      }
    }

    return target;
  }
  private buildTeamChatNotificationContent(message: ChatMessage, senderName?: string): {
    title: string;
    body: string;
    type: string;
  } {
    // Use provided name or fall back to email parsing
    const displayName = senderName || this.extractDisplayName(message.sender);
    
    // Handle special messages (announcements from admin/head teacher)
    if (message.isSpecial) {
      return {
        title: `⭐ Important from ${displayName}`,
        body: message.text || 'Special announcement',
        type: 'special_announcement',
      };
    }

    // Handle sticker messages
    if (message.sticker) {
      return {
        title: `${displayName} sent a sticker`,
        body: `🎯 Sent a sticker`,
        type: 'sticker_message',
      };
    }

    // Handle GIF messages
    if (message.gif) {
      return {
        title: `${displayName} sent a GIF`,
        body: `📹 Sent a GIF`,
        type: 'gif_message',
      };
    }

    // Handle messages with attachments (lesson plans, documents, etc.)
    if (message.attachments && message.attachments.length > 0) {
      const fileCount = message.attachments.length;
      const hasText = message.text && message.text.trim().length > 0;
      
      if (fileCount === 1) {
        const attachment = message.attachments[0];
        const fileTypeEmoji = this.getFileTypeEmoji(attachment.fileType, attachment.fileName);
        const messageBody = hasText 
          ? `${fileTypeEmoji} ${attachment.fileName}: ${message.text}`
          : `${fileTypeEmoji} ${attachment.fileName}`;
        
        return {
          title: `${displayName} shared a file`,
          body: messageBody,
          type: 'file_share',
        };
      } else {
        const messageBody = hasText
          ? `📎 ${fileCount} files: ${message.text}`
          : `📎 ${fileCount} files`;
        
        return {
          title: `${displayName} shared files`,
          body: messageBody,
          type: 'multiple_files',
        };
      }
    }

    // Handle text-only messages
    const messageText = message.text || 'New message';
    return {
      title: `${displayName} sent you a message`,
      body: messageText.length > 100 ? `${messageText.substring(0, 100)}...` : messageText,
      type: 'text_message',
    };
  }

  /**
   * Send web notification using browser notification API
   */
  private sendWebNotification(notification: NotificationData): void {
    try {
      if (typeof window !== 'undefined' && 'Notification' in window) {
        const data = this.normalizeNotificationPayload(notification.data);
        const notificationId = typeof data.notificationId === 'string' && data.notificationId.trim()
          ? data.notificationId.trim()
          : `web:${data.type || 'general'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        data.notificationId = notificationId;

        const deepLink = this.resolveNotificationDeepLink(data);
        if (deepLink && typeof data.deepLink !== 'string') {
          data.deepLink = deepLink;
        }

        const tag = typeof data.noticeId === 'string' && data.noticeId.trim()
          ? `notice:${data.noticeId.trim()}`
          : typeof data.messageId === 'string' && data.messageId.trim()
            ? `message:${data.messageId.trim()}`
            : notificationId;
        const keepVisible = data.type === 'daily_quote';
        const requireInteraction =
          keepVisible ||
          data.type === 'chat_message' ||
          data.type === 'team_chat_message' ||
          data.type === 'notice_created' ||
          data.priority === 'high';
        const autoCloseMs = keepVisible ? null : requireInteraction ? 12_000 : 8_000;
        
        if (Notification.permission === 'granted') {
          logger.debug('✅ Permission granted, creating notification');
          const browserNotification = new Notification(notification.title, {
            body: notification.body,
            icon: '/favicon.ico',
            tag,
            badge: '/favicon.ico',
            requireInteraction,
            silent: false,
            data,
          });
          
          browserNotification.onclick = () => {
            window.focus();
            this.handleNotificationNavigation(data);
            browserNotification.close();
          };

          if (typeof autoCloseMs === 'number') {
            setTimeout(() => {
              if (browserNotification) {
                browserNotification.close();
              }
            }, autoCloseMs);
          }
          
        } else if (Notification.permission !== 'denied') {
          logger.debug('🤔 Permission not granted, requesting permission');
          Notification.requestPermission().then((permission) => {
            logger.debug('📋 Permission request result:', permission);
            if (permission === 'granted') {
              setTimeout(() => {
                this.sendWebNotification(notification);
              }, 100);
            }
          }).catch((error) => {
            logger.error('Error requesting notification permission:', error);
          });
        } else {
          logger.warn('🚫 Notification permission denied');
        }
      } else {
        logger.warn('🚫 Notifications not supported in this browser');
      }
    } catch (error) {
      logger.error('Error in sendWebNotification:', error);
    }
  }

  /**
   * Send notification for daily fee collection summary
   */
  async sendDailyCollectionSummary(
    totalCollected: number, 
    paymentsCount: number, 
    pendingCount: number
  ): Promise<void> {
    await this.sendLocalNotification({
      title: '� Daily Fee Collection',
      body: `Today: ₹${totalCollected.toLocaleString()} from ${paymentsCount} payments. ${pendingCount} students still pending.`,
      data: { 
        type: 'daily_collection_summary', 
        totalCollected, 
        paymentsCount,
        pendingCount
      },
    });
  }

  /**
   * Send notification for weekly fee collection report
   */
  async sendWeeklyCollectionReport(
    weeklyTotal: number, 
    totalStudents: number, 
    paidStudents: number, 
    pendingStudents: number
  ): Promise<void> {
    const collectionRate = Math.round((paidStudents / totalStudents) * 100);
    await this.sendLocalNotification({
      title: '� Weekly Collection Report',
      body: `This week: ₹${weeklyTotal.toLocaleString()} collected. ${paidStudents}/${totalStudents} students paid (${collectionRate}%)`,
      data: { 
        type: 'weekly_collection_report', 
        weeklyTotal, 
        totalStudents,
        paidStudents,
        pendingStudents,
        collectionRate
      },
    });
  }

  /**
   * Send notification when data backup is completed
   */
  async sendDataBackupComplete(success: boolean, studentCount: number, feeRecordsCount: number): Promise<void> {
    await this.sendLocalNotification({
      title: success ? '✅ Data Backup Complete' : '❌ Backup Failed',
      body: success 
        ? `Backed up ${studentCount} students and ${feeRecordsCount} fee records successfully.`
        : 'Data backup failed. Please try again or check your connection.',
      data: { 
        type: 'data_backup', 
        success, 
        studentCount,
        feeRecordsCount
      },
    });
  }

  /**
   * Send notification for reminder delivery failures
   */
  async sendReminderFailureAlert(failedCount: number, reminderType: string, errorDetails: string): Promise<void> {
    await this.sendLocalNotification({
      title: '❌ Reminder Delivery Failed',
      body: `${failedCount} ${reminderType} reminders failed to send. Check your settings and try again.`,
      data: { 
        type: 'reminder_failure', 
        failedCount, 
        reminderType,
        errorDetails,
        priority: 'high'
      },
    });
  }

  /**
   * Send notification for monthly fee collection target
   */
  async sendMonthlyTargetUpdate(
    currentCollection: number, 
    targetAmount: number, 
    daysRemaining: number
  ): Promise<void> {
    const achievedPercentage = Math.round((currentCollection / targetAmount) * 100);
    const isOnTrack = achievedPercentage >= (100 - (daysRemaining * 3.3)); // Rough calculation
    
    await this.sendLocalNotification({
      title: isOnTrack ? '🎯 Monthly Target On Track' : '⚠️ Monthly Target Behind',
      body: `₹${currentCollection.toLocaleString()}/${targetAmount.toLocaleString()} collected (${achievedPercentage}%). ${daysRemaining} days remaining.`,
      data: { 
        type: 'monthly_target_update', 
        currentCollection, 
        targetAmount,
        achievedPercentage,
        daysRemaining,
        isOnTrack
      },
    });
  }

  /**
   * Send notification when a teacher comes online/goes offline
   */
  async sendTeamMemberStatusNotification(memberName: string, isOnline: boolean): Promise<void> {
    if (isOnline) {
      await this.sendLocalNotification({
        title: '👋 Team Member Online',
        body: `${memberName} is now online and available for collaboration.`,
        data: { 
          type: 'team_member_online', 
          memberName,
          status: 'online'
        },
      });
    }
  }

  /**
   * Schedule daily fee collection review at end of day
   */
  async scheduleDailyFeeReview(): Promise<void> {
    try {
      await this.cancelScheduledNotifications('daily_fee_review');
      
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '� Daily Fee Review',
          body: 'Review today\'s fee collections and follow up on pending payments.',
          data: { type: 'daily_fee_review' },
        },
        trigger: {
          hour: 18,
          minute: 0,
          repeats: true,
        } as any,
      });
    } catch (error) {
      logger.error('Error scheduling daily fee review:', error);
    }
  }

  /**
   * Schedule weekly reminder review on Sundays
   */
  async scheduleWeeklyReminderReview(): Promise<void> {
    try {
      await this.cancelScheduledNotifications('weekly_reminder_review');
      
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '� Weekly Reminder Review',
          body: 'Review this week\'s reminder effectiveness and plan for next week.',
          data: { type: 'weekly_reminder_review' },
        },
        trigger: {
          weekday: 1, // Sunday
          hour: 19,
          minute: 0,
          repeats: true,
        } as any,
      });
    } catch (error) {
      logger.error('Error scheduling weekly reminder review:', error);
    }
  }

  // Remove student-focused notifications that don't apply to teacher app
  // Keeping only teacher/admin relevant notifications

  // ===== SMART NOTIFICATION SCHEDULING =====

  /**
   * Schedule weekly fee collection reminders
   */
  async scheduleWeeklyFeeReminders(): Promise<void> {
    try {
      // Cancel existing weekly reminders
      await this.cancelScheduledNotifications('weekly_fee_reminder');
      
      // Schedule for every Monday at 9 AM
      const nextMonday = this.getNextWeekday(1); // 1 = Monday
      nextMonday.setHours(9, 0, 0, 0);
      
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '💰 Weekly Fee Review',
          body: 'Time to review this week\'s fee collections and send reminders to pending students.',
          data: { type: 'weekly_fee_reminder' },
        },
        trigger: {
          weekday: 2, // Monday
          hour: 9,
          minute: 0,
          repeats: true,
        } as any,
      });
    } catch (error) {
      logger.error('Error scheduling weekly fee reminders:', error);
    }
  }

  /**
   * Schedule daily attendance review
   */
  async scheduleDailyAttendanceReview(): Promise<void> {
    try {
      // Cancel existing daily reminders
      await this.cancelScheduledNotifications('daily_attendance_review');
      
      // Schedule for every day at 6 PM
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '📊 Daily Attendance Review',
          body: 'Review today\'s attendance and follow up on absent students.',
          data: { type: 'daily_attendance_review' },
        },
        trigger: {
          hour: 18,
          minute: 0,
          repeats: true,
        } as any,
      });
    } catch (error) {
      logger.error('Error scheduling daily attendance review:', error);
    }
  }

  /**
   * Cancel scheduled notifications by type
   */
  private async cancelScheduledNotifications(type: string): Promise<void> {
    try {
      const scheduledNotifications = await Notifications.getAllScheduledNotificationsAsync();
      const typeNotificationIds = scheduledNotifications
        .filter(notif => notif.content.data?.type === type)
        .map(notif => notif.identifier);
      
      for (const id of typeNotificationIds) {
        await Notifications.cancelScheduledNotificationAsync(id);
      }
    } catch (error) {
      logger.error(`Error canceling scheduled notifications for type ${type}:`, error);
    }
  }

  /**
   * Get next occurrence of a specific weekday
   */
  private getNextWeekday(targetWeekday: number): Date {
    const today = new Date();
    const currentWeekday = today.getDay();
    const daysUntilTarget = (targetWeekday - currentWeekday + 7) % 7;
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + (daysUntilTarget === 0 ? 7 : daysUntilTarget));
    return targetDate;
  }

  // ===== ADMIN NOTIFICATION METHODS =====

  /**
   * Send notification to specific user devices from admin panel
   */
  async sendAdminNotificationToUser(
    targetEmail: string,
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    onlineOnly: boolean = true,
    tenantFilterOptions?: DeviceTenantFilterOptions
  ): Promise<{ success: number; failed: number }> {
    try {
      const scopedTenantOptions = tenantFilterOptions ?? (await this.resolveTenantFilterOptions(false));
      logger.debug('📤 Sending admin notification to user:', {
        targetEmail,
        title: notification.title,
        priority: notification.priority || 'normal',
        onlineOnly,
        tenantId: scopedTenantOptions?.tenantId,
      });

      const result = await getDeviceTrackingService().sendNotificationToUser(
        targetEmail,
        {
          title: notification.title,
          body: notification.body,
          data: {
            ...(notification.data ?? {}),
            type: 'admin_notification',
            priority: notification.priority || 'normal',
            timestamp: Date.now(),
            allowWhenDisabled: true,
          }
        },
        onlineOnly,
        scopedTenantOptions
      );

      logger.debug('📊 Admin notification results for user:', {
        targetEmail,
        success: result.success,
        failed: result.failed
      });

      return result;
    } catch (error) {
      logger.error('Failed to send admin notification to user:', error);
      return { success: 0, failed: 1 };
    }
  }

  /**
   * Send notification to specific device from admin panel
   */
  async sendAdminNotificationToDevice(
    targetEmail: string,
    deviceId: string,
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    tenantFilterOptions?: DeviceTenantFilterOptions
  ): Promise<boolean> {
    const result = await this.deliverAdminNotificationToDevice(targetEmail, deviceId, notification, tenantFilterOptions);
    return result.success;
  }

  private async deliverAdminNotificationToDevice(
    targetEmail: string,
    deviceId: string,
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    tenantFilterOptions?: DeviceTenantFilterOptions
  ): Promise<{ success: boolean; reason?: string }> {
    try {
      const scopedTenantOptions = tenantFilterOptions ?? (await this.resolveTenantFilterOptions(false));
      logger.debug('📤 Sending admin notification to device:', {
        targetEmail,
        deviceId,
        title: notification.title,
        priority: notification.priority || 'normal',
        tenantId: scopedTenantOptions?.tenantId,
      });

      if (scopedTenantOptions?.tenantId) {
        const scopedDevices = await getDeviceTrackingService().getUserDevices(targetEmail, scopedTenantOptions);
        const deviceAllowed = scopedDevices.some((device: any) => device.deviceId === deviceId);
        if (!deviceAllowed) {
          logger.warn('Blocked admin notification to device outside tenant scope', {
            targetEmail,
            deviceId,
            tenantId: scopedTenantOptions.tenantId,
          });
          return { success: false, reason: 'tenant_scope_blocked' };
        }
      }

      const success = await getDeviceTrackingService().sendNotificationToDevice(
        deviceId,
        targetEmail,
        {
          title: notification.title,
          body: notification.body,
          data: {
            ...(notification.data ?? {}),
            type: 'admin_notification',
            priority: notification.priority || 'normal',
            timestamp: Date.now(),
            allowWhenDisabled: true,
          }
        },
        undefined,
        scopedTenantOptions
      );

      if (success) {
        logger.debug('✅ Admin notification sent successfully to device:', deviceId);
        return { success: true };
      }

      logger.warn('❌ Device did not accept admin notification:', deviceId);
      return { success: false, reason: 'device_declined' };
    } catch (error) {
      logger.error('Failed to send admin notification to device:', error);
      return { success: false, reason: 'delivery_error' };
    }
  }

  /**
   * Send bulk notifications to multiple users
   */
  async sendBulkAdminNotifications(
    targetUsers: string[],
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    onlineOnly: boolean = true,
    options?: { tenantId?: string; tenantName?: string }
  ): Promise<{ totalSuccess: number; totalFailed: number; results: Array<{ email: string; success: number; failed: number }> }> {
    const results: Array<{ email: string; success: number; failed: number }> = [];
    let totalSuccess = 0;
    let totalFailed = 0;
    const tenantFilterOptions: DeviceTenantFilterOptions | undefined = options?.tenantId
      ? { tenantId: options.tenantId, includeUntagged: false }
      : await this.resolveTenantFilterOptions(false);

    // Start building history entry
    let historyId: string | null = null;
    
    try {
      
      // Type assertion to access additional properties passed from AdminNotificationCenter
      const extendedNotification = notification as any;
      
      const historyEntry = {
        adminEmail: extendedNotification.adminEmail || notification.data?.adminEmail || 'unknown',
        adminName: extendedNotification.adminName || notification.data?.adminName || 'Unknown Admin',
        title: notification.title,
        body: notification.body,
        type: (extendedNotification.type || notification.data?.type as 'info' | 'warning' | 'success' | 'error' | 'announcement') || 'info',
        priority: notification.priority || 'normal' as 'high' | 'normal' | 'low',
        targetUsers: targetUsers,
        targetDevices: [], // Will be populated for device-specific calls
        totalTargets: targetUsers.length,
        successfulDeliveries: 0, // Will be updated
        failedDeliveries: 0, // Will be updated
        userResults: [], // Will be populated
        deviceResults: [], // Will be populated
        deliveryMethod: 'mixed' as const,
        onlineOnly: onlineOnly,
        data: notification.data ? {
          type: notification.data.type || extendedNotification.type,
          adminEmail: notification.data.adminEmail || extendedNotification.adminEmail,
          adminName: notification.data.adminName || extendedNotification.adminName,
          timestamp: notification.data.timestamp || extendedNotification.timestamp || Date.now()
        } : {
          type: extendedNotification.type,
          adminEmail: extendedNotification.adminEmail,
          adminName: extendedNotification.adminName,
          timestamp: extendedNotification.timestamp || Date.now()
        },
        sentAt: new Date() as any // Will be converted to Timestamp in the service
      };
      
      historyId = await adminNotificationHistoryService.saveNotificationHistory(historyEntry, options);
      logger.debug('📝 Notification history entry created with admin info:', {
        adminEmail: historyEntry.adminEmail,
        adminName: historyEntry.adminName,
        historyId,
        tenantId: options?.tenantId
      });
    } catch (error) {
      logger.warn('Failed to create notification history entry:', error);
    }

    for (const userEmail of targetUsers) {
      try {
        const result = await this.sendAdminNotificationToUser(
          userEmail,
          notification,
          onlineOnly,
          tenantFilterOptions
        );
        results.push({ email: userEmail, success: result.success, failed: result.failed });
        totalSuccess += result.success;
        totalFailed += result.failed;
      } catch (error) {
        logger.error(`Failed to send notification to ${userEmail}:`, error);
        results.push({ email: userEmail, success: 0, failed: 1 });
        totalFailed += 1;
      }
    }

    // Update history with final results
    if (historyId) {
      try {
        await adminNotificationHistoryService.updateNotificationStatus(historyId, {
          successfulDeliveries: totalSuccess,
          failedDeliveries: totalFailed,
          userResults: results
        });
      } catch (error) {
        logger.warn('Failed to update notification history:', error);
      }
    }

    logger.debug('📊 Bulk admin notifications completed:', {
      totalTargets: targetUsers.length,
      totalSuccess,
      totalFailed,
      historyId
    });

    return { totalSuccess, totalFailed, results };
  }

  /**
   * Send notifications to specific devices
   */
  async sendBulkAdminNotificationsToDevices(
    targets: Array<{ email: string; deviceId: string }>,
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    options?: { tenantId?: string; tenantName?: string }
  ): Promise<{ totalSuccess: number; totalFailed: number; results: Array<{ email: string; deviceId: string; success: boolean; reason?: string }>; failureReasons: Record<string, number> }> {
    const results: Array<{ email: string; deviceId: string; success: boolean; reason?: string }> = [];
      const failureReasonCounts: Record<string, number> = {};
    let totalSuccess = 0;
    let totalFailed = 0;
    const tenantFilterOptions: DeviceTenantFilterOptions | undefined = options?.tenantId
      ? { tenantId: options.tenantId, includeUntagged: false }
      : await this.resolveTenantFilterOptions(false);

    // Get device names for better tracking
    let targetDevices: Array<{ email: string; deviceId: string; deviceName: string }> = [];
    
    // Start building history entry
    let historyId: string | null = null;
    
    try {
      
      // Resolve device names
      targetDevices = await Promise.all(
        targets.map(async (target) => {
          try {
            const devices = await getDeviceTrackingService().getUserDevices(target.email, tenantFilterOptions);
            const device = devices.find((d: any) => d.deviceId === target.deviceId);
            return {
              email: target.email,
              deviceId: target.deviceId,
              deviceName: device?.deviceName || 'Unknown Device'
            };
          } catch (error) {
            return {
              email: target.email,
              deviceId: target.deviceId,
              deviceName: 'Unknown Device'
            };
          }
        })
      );
      
      const historyEntry = {
        adminEmail: (notification as any).adminEmail || notification.data?.adminEmail || 'unknown',
        adminName: (notification as any).adminName || notification.data?.adminName || 'Unknown Admin',
        title: notification.title,
        body: notification.body,
        type: ((notification as any).type || notification.data?.type as 'info' | 'warning' | 'success' | 'error' | 'announcement') || 'info',
        priority: notification.priority || 'normal' as 'high' | 'normal' | 'low',
        targetUsers: [...new Set(targets.map(t => t.email))], // Unique emails
        targetDevices: targetDevices,
        totalTargets: targets.length,
        successfulDeliveries: 0, // Will be updated
        failedDeliveries: 0, // Will be updated
        userResults: [], // Will be populated
        deviceResults: [], // Will be populated
        deliveryMethod: 'mixed' as const,
        onlineOnly: false, // Device-specific targeting doesn't filter by online status
        data: notification.data ? {
          type: notification.data.type || (notification as any).type,
          adminEmail: notification.data.adminEmail || (notification as any).adminEmail,
          adminName: notification.data.adminName || (notification as any).adminName,
          timestamp: notification.data.timestamp || (notification as any).timestamp || Date.now()
        } : {
          type: (notification as any).type,
          adminEmail: (notification as any).adminEmail,
          adminName: (notification as any).adminName,
          timestamp: (notification as any).timestamp || Date.now()
        },
        sentAt: new Date() as any // Will be converted to Timestamp in the service
      };
      
      historyId = await adminNotificationHistoryService.saveNotificationHistory(historyEntry, options);
    } catch (error) {
      logger.warn('Failed to create notification history entry:', error);
    }

    for (const target of targets) {
      try {
        const delivery = await this.deliverAdminNotificationToDevice(
          target.email,
          target.deviceId,
          notification,
          tenantFilterOptions
        );
        results.push({ email: target.email, deviceId: target.deviceId, success: delivery.success, reason: delivery.reason });
        if (delivery.success) {
          totalSuccess++;
        } else {
          totalFailed++;
          const reasonKey = delivery.reason ?? 'unknown';
          failureReasonCounts[reasonKey] = (failureReasonCounts[reasonKey] ?? 0) + 1;
        }
      } catch (error) {
        logger.error(`Failed to send notification to ${target.email} device ${target.deviceId}:`, error);
        results.push({ email: target.email, deviceId: target.deviceId, success: false, reason: 'delivery_error' });
        totalFailed++;
        failureReasonCounts['delivery_error'] = (failureReasonCounts['delivery_error'] ?? 0) + 1;
      }
    }

    const failureReasonSummary = Object.keys(failureReasonCounts).length > 0 ? failureReasonCounts : undefined;

    if (failureReasonSummary) {
      logger.debug('📉 Admin device notification failure reasons', {
        failureReasonCounts: failureReasonSummary,
        tenantId: tenantFilterOptions?.tenantId || options?.tenantId,
        notificationTitle: notification.title,
        totalTargets: targets.length,
      });
    }

    // Update history with final results
    if (historyId) {
      try {
        
        // Build device results with names from the earlier lookup
        const deviceResults = results.map(result => {
          const targetDevice = targetDevices.find(t => t.email === result.email && t.deviceId === result.deviceId);
          return {
            email: result.email,
            deviceId: result.deviceId,
            success: result.success,
            deviceName: targetDevice?.deviceName || 'Unknown Device',
            reason: result.reason,
          };
        });

        await adminNotificationHistoryService.updateNotificationStatus(historyId, {
          successfulDeliveries: totalSuccess,
          failedDeliveries: totalFailed,
          deviceResults: deviceResults,
          failureReasonSummary,
        });
      } catch (error) {
        logger.warn('Failed to update notification history:', error);
      }
    }

    logger.debug('📊 Bulk device notifications completed:', {
      totalTargets: targets.length,
      totalSuccess,
      totalFailed,
      historyId
    });

    return { totalSuccess, totalFailed, results, failureReasons: failureReasonCounts };
  }

  /**
   * Get all users with their devices (for admin panel)
   */
  async getAllUsersWithDevices(
    memberEmails: string[],
    includeCurrentUser: boolean = true,
    options?: DeviceTenantFilterOptions
  ): Promise<any[]> {
    try {
      const scopedTenantOptions = options ?? (await this.resolveTenantFilterOptions(false));
      return await getDeviceTrackingService().getAllUsersWithDevices(
        memberEmails,
        this.currentUserEmail || undefined,
        includeCurrentUser,
        scopedTenantOptions
      );
    } catch (error) {
      logger.error('Failed to get users with devices:', error);
      return [];
    }
  }

  /**
   * Get user devices (for admin panel)
   */
  async getUserDevices(userEmail: string, options?: DeviceTenantFilterOptions): Promise<any[]> {
    try {
      const scopedTenantOptions = options ?? (await this.resolveTenantFilterOptions(false));
      return await getDeviceTrackingService().getUserDevices(userEmail, scopedTenantOptions);
    } catch (error) {
      logger.error('Failed to get user devices:', error);
      return [];
    }
  }

  /**
   * Check user online status
   */
  async checkUserOnlineStatus(userEmail: string): Promise<boolean> {
    try {
      const devices = await this.getUserDevices(userEmail);
      return devices.some((device: any) => device?.isOnline);
    } catch (error) {
      logger.error('Failed to check user online status:', error);
      return false;
    }
  }

  /**
   * Cleanup and logout
   */
  async cleanup(): Promise<void> {
    try {
      // Stop cache cleanup interval
      if (this.cacheCleanupInterval) {
        clearInterval(this.cacheCleanupInterval);
        this.cacheCleanupInterval = null;
      }

      if (this.receiptFlushInterval) {
        clearInterval(this.receiptFlushInterval);
        this.receiptFlushInterval = null;
      }
      
    // Clear notification cache
    this.notificationCache.clear();
    this.expoPushToken = null;
  this.activeChatPartnerEmail = null;
    this.lastActiveChatDeliveryBackfillAtByPartner.clear();
      
      // Cleanup quotes service
      try {
        await quotesService.cleanup();
      } catch (error) {
        logger.error('Failed to cleanup quotes service:', error);
      }
      
    // Cleanup device tracking
    await getDeviceTrackingService().unregisterDevice();
      this.currentUserEmail = null;
      this.isInitialized = false;
    } catch (error) {
      logger.error('Failed to cleanup notification service:', error);
    }
  }

  /**
   * Set current user email
   */
  setCurrentUser(email: string): void {
    this.currentUserEmail = email;
  }

  /**
   * Clear notification cache manually (useful for testing or reset)
   */
  clearNotificationCache(): void {
    this.notificationCache.clear();
  }

  // ===== DAILY QUOTES MANAGEMENT =====

  /**
   * Toggle daily quotes notifications
   */
  async toggleDailyQuotes(enabled: boolean): Promise<void> {
    try {
      // Save preference first
      await this.saveNotificationPreference('dailyQuotes', enabled);
      this.dailyQuotesEnabled = enabled;
      const shouldSchedule = enabled && this.notificationsEnabled;

      if (shouldSchedule) {
        await quotesService.initialize();
        await quotesService.setSchedulingEnabled(true);
      } else {
        await quotesService.setSchedulingEnabled(false);
      }

      const scheduleStatus = await quotesService.getQuoteScheduleStatus();
      logger.debug('Daily quote scheduling status updated', scheduleStatus);
    } catch (error) {
      logger.error('Failed to toggle daily quotes:', error);
    }
  }

  /**
   * Toggle API quotes (external fresh quotes vs local quotes)
   */
  async toggleApiQuotes(enabled: boolean): Promise<void> {
    try {
      quotesService.setUseApiQuotes(enabled);
      
      const message = enabled 
        ? 'Now using fresh quotes from external APIs! 🌐' 
        : 'Now using local quote collection. 📚';
        
      await this.sendLocalNotification({
        title: '🔄 Quote Source Updated',
        body: message,
        data: { type: 'quote_source_changed', apiEnabled: enabled },
      });
    } catch (error) {
      logger.error('Failed to toggle API quotes:', error);
    }
  }

  /**
   * Prefetch quotes for better performance
   */
  async prefetchQuotes(count: number = 10): Promise<void> {
    try {
      await quotesService.prefetchQuotes(count);
      
      const actualCount = Platform.OS === 'web' ? Math.min(count, 3) : count;
      
      await this.sendLocalNotification({
        title: '🔄 Quotes Updated',
        body: `Fetched ${actualCount} fresh quotes for better performance!`,
        data: { type: 'quotes_prefetched', count: actualCount },
      });
    } catch (error) {
      logger.error('Failed to prefetch quotes:', error);
    }
  }

  /**
   * Clear API quote cache
   */
  async clearQuoteCache(): Promise<void> {
    try {
      await quotesService.clearApiCache();
      
      await this.sendLocalNotification({
        title: '🗑️ Quote Cache Cleared',
        body: 'API quote cache has been cleared. Fresh quotes will be fetched next time.',
        data: { type: 'quote_cache_cleared' },
      });
    } catch (error) {
      logger.error('Failed to clear quote cache:', error);
    }
  }

  /**
   * Send an immediate quote notification
   */
  async sendImmediateQuote(category?: string): Promise<void> {
    try {
      await quotesService.sendImmediateQuote(category);
    } catch (error) {
      logger.error('Failed to send immediate quote:', error);
    }
  }

  /**
   * Get quotes service statistics (enhanced with API data)
   */
  getQuoteStats(): {
    totalQuotes: number;
    localQuotes: number;
    apiQuotes: number;
    categories: string[];
    quotesPerCategory: Record<string, number>;
    isEnabled: boolean;
    usingApiQuotes: boolean;
    lastApiCall: string;
    apiCacheSize: number;
  } {
    const stats = quotesService.getQuoteStats();
    return {
      ...stats,
      isEnabled: quotesService.isSchedulingEnabledStatus(),
      usingApiQuotes: quotesService.isUsingApiQuotes(),
    };
  }

  async getDailyQuoteScheduleStatus(): Promise<ReturnType<typeof quotesService.getQuoteScheduleStatus>> {
    return quotesService.getQuoteScheduleStatus();
  }

  /**
   * Reschedule quote notifications (useful after time zone changes)
   */
  async rescheduleQuoteNotifications(): Promise<void> {
    try {
      if (quotesService.isSchedulingEnabledStatus()) {
        await quotesService.scheduleQuoteNotifications();
      }
    } catch (error) {
      logger.error('Failed to reschedule quote notifications:', error);
    }
  }

  /**
   * Get notification cache size (for debugging)
   */
  getNotificationCacheSize(): number {
    return this.notificationCache.size;
  }

  /**
   * Test method to verify deduplication works
   */
  async testNotificationDeduplication(): Promise<void> {
    const testMessage = {
      id: 'test-message-123',
      sender: 'test@example.com',
      text: 'This is a test message',
      timestamp: new Date().toISOString(), // Use string format as expected by ChatMessage
      isSpecial: false
    } as any; // Type assertion to avoid other missing properties

    const recipientEmail = 'recipient@example.com';
    const currentUserEmail = 'current@example.com';

    // Send a single test notification
    await this.sendSmartChatNotification(testMessage, recipientEmail, currentUserEmail);
  }
}

export const notificationService = new NotificationService();

Notifications.addNotificationReceivedListener((notification) => {
  notificationService.handleNotificationReceived(notification).catch((error) => {
    logger.debug('Notification received handler failed:', error);
  });
});

Notifications.addNotificationResponseReceivedListener((response) => {
  notificationService.handleNotificationResponse(response).catch((error) => {
    logger.warn('Notification response handler failed:', error);
  });
});