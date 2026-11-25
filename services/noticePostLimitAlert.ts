import { Alert } from 'react-native';
import { logger } from '@/lib/logger';
import { tryPresentModalAlert, type ModalAlertButton } from './modalAlertService';

export type NoticePostLimitInfo = {
  limit: number;
  used: number;
  /** ISO time the allowance resets (start of next month, UTC). */
  resetsAt?: string | null;
};

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "1 December" for the reset time, or null if it can't be read. */
export function formatNoticePostResetDate(resetsAt?: string | null): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  // The allowance is per UTC calendar month, so name the UTC date.
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

/** Start of next UTC month, for when the server didn't say. */
export function nextNoticePostResetIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export function buildNoticePostLimitMessage(info: NoticePostLimitInfo, canManagePlan: boolean): string {
  const resetDate = formatNoticePostResetDate(info.resetsAt ?? nextNoticePostResetIso());
  const lines = [
    `Your plan allows ${info.limit.toLocaleString('en-IN')} notice posts a month, and this month's have all been used.`,
    resetDate ? `You can post again from ${resetDate}.` : null,
    'Deleting a notice posted this month frees up a post.',
    canManagePlan
      ? 'Upgrade your plan to post more notices.'
      : 'Ask an owner or admin to upgrade the plan for more notice posts.',
  ];
  return lines.filter(Boolean).join('\n\n');
}

/** Reads `limit`/`used`/`resetsAt` from a NoticeBackendError's details. */
export function noticePostLimitInfoFromDetails(details: Record<string, unknown> | undefined): NoticePostLimitInfo | null {
  const limit = Number(details?.limit);
  const used = Number(details?.used);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return {
    limit,
    used: Number.isFinite(used) ? used : limit,
    resetsAt: typeof details?.resetsAt === 'string' ? details.resetsAt : null,
  };
}

export function showNoticePostLimitAlert(
  info: NoticePostLimitInfo,
  options: { canManagePlan: boolean; onViewPlans?: () => void },
): void {
  const title = 'Notice post limit reached';
  const message = buildNoticePostLimitMessage(info, options.canManagePlan);
  const buttons: ModalAlertButton[] =
    options.canManagePlan && options.onViewPlans
      ? [
          { text: 'Not now', style: 'cancel' },
          { text: 'View plans', style: 'primary', onPress: options.onViewPlans },
        ]
      : [{ text: 'OK', style: 'primary' }];

  try {
    const shown = tryPresentModalAlert({ title, message, buttons, variant: 'warning' });
    if (!shown) {
      Alert.alert(
        title,
        message,
        buttons.map((button) => ({
          text: button.text,
          style: button.style === 'cancel' ? 'cancel' : 'default',
          onPress: button.onPress,
        })),
      );
    }
  } catch (error) {
    logger.warn('[noticePostLimitAlert] Failed to present alert', { error });
  }
}
