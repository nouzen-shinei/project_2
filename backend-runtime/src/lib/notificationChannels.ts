export const ANDROID_CHANNEL_IDS = {
  // Keep in sync with mobile app: avoid reserved "default" id that Expo blocks.
  GENERAL: 'general_notifications',
  CHAT: 'chat_messages',
  IMPORTANT: 'important_messages',
  DAILY_QUOTES: 'daily_quotes',
  NOTICES: 'notice_center',
  // Android has its own "miscellaneous" fallback channel, so use a custom id.
  MISC: 'misc_notifications',
} as const;

type NotificationLike = {
  type?: string | null;
  priority?: string | null;
};

export type AndroidChannelId = (typeof ANDROID_CHANNEL_IDS)[keyof typeof ANDROID_CHANNEL_IDS];

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
