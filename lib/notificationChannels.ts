import { AndroidImportance } from 'expo-notifications';
import type { NotificationChannelInput } from 'expo-notifications';

export const ANDROID_CHANNEL_IDS = {
  /**
   * Use a custom id instead of "default" because Expo reserves that identifier internally
   * which caused `setNotificationChannelAsync` to throw on Android.
   */
  GENERAL: 'general_notifications',
  CHAT: 'chat_messages',
  IMPORTANT: 'important_messages',
  DAILY_QUOTES: 'daily_quotes',
  NOTICES: 'notice_center',
  /**
   * Android reserves the plain "miscellaneous" channel internally, so keep our
   * fallback bucket on a custom id to avoid collisions.
   */
  MISC: 'misc_notifications',
} as const;

export type AndroidChannelId = (typeof ANDROID_CHANNEL_IDS)[keyof typeof ANDROID_CHANNEL_IDS];

type NotificationLike = {
  type?: string | null;
  priority?: string | null;
};

const CHAT_TYPES = new Set(['chat_message', 'team_chat_message']);
const DAILY_QUOTE_TYPES = new Set(['daily_quote', 'quote_cache_cleared', 'quote_source_changed', 'quotes_prefetched']);
const NOTICE_TYPES = new Set(['notice_created']);
const IMPORTANT_TYPES = new Set([
  'fee_overdue_alert',
  'monthly_target_update',
  'reminder_failure',
  'special_announcement',
  'team_membership_change',
  'admin_notification',
]);
const MISC_TYPES = new Set(['test', 'system_update', 'data_backup', 'backup_status', 'birthday_greeting']);

const BIRTHDAY_TYPE_PREFIXES = ['birthday_'];

function isBirthdayType(type?: string | null): boolean {
  if (!type) return false;
  return BIRTHDAY_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export function resolveNotificationChannelId(notification?: NotificationLike): AndroidChannelId {
  const type = notification?.type?.toLowerCase();
  const priority = notification?.priority?.toLowerCase();

  if (type && CHAT_TYPES.has(type)) {
    return ANDROID_CHANNEL_IDS.CHAT;
  }

  if (type && DAILY_QUOTE_TYPES.has(type)) {
    return ANDROID_CHANNEL_IDS.DAILY_QUOTES;
  }

  if (priority === 'high' || (type && IMPORTANT_TYPES.has(type))) {
    return ANDROID_CHANNEL_IDS.IMPORTANT;
  }

  if (type && NOTICE_TYPES.has(type)) {
    return ANDROID_CHANNEL_IDS.NOTICES;
  }

  if (isBirthdayType(type)) {
    return ANDROID_CHANNEL_IDS.MISC;
  }

  if (type && MISC_TYPES.has(type)) {
    return ANDROID_CHANNEL_IDS.MISC;
  }

  return ANDROID_CHANNEL_IDS.GENERAL;
}

export function getAndroidChannelDefinition(
  channelId: AndroidChannelId
): NotificationChannelInput {
  switch (channelId) {
    case ANDROID_CHANNEL_IDS.CHAT:
      return {
        name: 'Chat Messages',
        importance: AndroidImportance.MAX,
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
        lightColor: '#4CAF50',
        vibrationPattern: [0, 250, 250, 250],
      };
    case ANDROID_CHANNEL_IDS.DAILY_QUOTES:
      return {
        name: 'Daily Quotes',
        importance: AndroidImportance.DEFAULT,
        enableLights: false,
        enableVibrate: true,
        showBadge: false,
        lightColor: '#1A73E8',
        vibrationPattern: [0, 200, 100, 200],
      };
    case ANDROID_CHANNEL_IDS.IMPORTANT:
      return {
        name: 'Important Messages',
        importance: AndroidImportance.MAX,
        enableLights: true,
        enableVibrate: true,
        lightColor: '#FF9800',
        showBadge: true,
        vibrationPattern: [0, 500, 250, 500],
      };
    case ANDROID_CHANNEL_IDS.NOTICES:
      return {
        name: 'Notice Board',
        importance: AndroidImportance.DEFAULT,
        enableLights: true,
        enableVibrate: true,
        showBadge: true,
        lightColor: '#1E88E5',
        vibrationPattern: [0, 200, 200, 200],
      };
    case ANDROID_CHANNEL_IDS.MISC:
      return {
        name: 'Miscellaneous',
        importance: AndroidImportance.DEFAULT,
        enableLights: false,
        enableVibrate: false,
        showBadge: false,
        vibrationPattern: [0, 100],
      };
    case ANDROID_CHANNEL_IDS.GENERAL:
    default:
      return {
        name: 'General Notifications',
        importance: AndroidImportance.HIGH,
        enableVibrate: true,
        showBadge: true,
        lightColor: '#FF231F7C',
        vibrationPattern: [0, 250, 250, 250],
      };
  }
}
