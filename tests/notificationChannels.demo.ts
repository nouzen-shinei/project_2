import { ANDROID_CHANNEL_IDS, resolveNotificationChannelId } from '../lib/notificationChannels';

/**
 * Lightweight demo data showing how notification "type" and "priority" fields
 * map to the Android notification channels defined in `lib/notificationChannels`.
 *
 * These scenarios are intentionally documented in plain TypeScript so they can
 * be imported into Storybook stories, unit tests, or even the admin panel to
 * preview channel behavior without needing to trigger real notifications.
 */
export const channelResolverDemo = [
  {
    label: 'Direct chat message',
    payload: { type: 'chat_message' as const },
    resolvedChannel: resolveNotificationChannelId({ type: 'chat_message' }),
  },
  {
    label: 'Team announcement',
    payload: { type: 'team_chat_message' as const },
    resolvedChannel: resolveNotificationChannelId({ type: 'team_chat_message' }),
  },
  {
    label: 'Daily inspiration quote',
    payload: { type: 'daily_quote' as const },
    resolvedChannel: resolveNotificationChannelId({ type: 'daily_quote' }),
  },
  {
    label: 'High-priority fee alert',
    payload: { type: 'fee_overdue_alert' as const, priority: 'high' as const },
    resolvedChannel: resolveNotificationChannelId({ type: 'fee_overdue_alert', priority: 'high' }),
  },
  {
    label: 'Notice published',
    payload: { type: 'notice_created' as const },
    resolvedChannel: resolveNotificationChannelId({ type: 'notice_created' }),
  },
  {
    label: 'System maintenance notice',
    payload: { type: 'system_update' as const },
    resolvedChannel: resolveNotificationChannelId({ type: 'system_update' }),
  },
  {
    label: 'Birthday greeting push',
    payload: { type: 'birthday_greeting' as const },
    resolvedChannel: resolveNotificationChannelId({ type: 'birthday_greeting' }),
  },
  {
    label: 'Unknown notification (fallback)',
    payload: { type: 'new_widget_rollout' },
    resolvedChannel: resolveNotificationChannelId({ type: 'new_widget_rollout' }),
  },
  {
    label: 'Priority override without type',
    payload: { priority: 'high' as const },
    resolvedChannel: resolveNotificationChannelId({ priority: 'high' }),
  },
];

export const channelLegend = {
  [ANDROID_CHANNEL_IDS.CHAT]: 'Medium-latency messaging channel with vibration & sound',
  [ANDROID_CHANNEL_IDS.DAILY_QUOTES]: 'Gentle channel used for inspirational quotes',
  [ANDROID_CHANNEL_IDS.IMPORTANT]: 'High-urgency alerts surfaced with maximum importance',
  [ANDROID_CHANNEL_IDS.NOTICES]: 'Dedicated notice board updates (moderate importance)',
  [ANDROID_CHANNEL_IDS.MISC]: 'Low-noise informational alerts such as birthdays or backups',
  [ANDROID_CHANNEL_IDS.GENERAL]: 'Default bucket for everything else',
};
