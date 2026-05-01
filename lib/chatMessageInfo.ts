export interface ChatMessageInfoInput {
  isOwnMessage: boolean;
  senderEmail?: string | null;
  senderName?: string | null;
  recipientEmail?: string | null;
  recipientName?: string | null;
  recipientStatusDetails?: ChatMessageRecipientStatusDetail[] | null;
  sentAt?: string | null;
  delivered?: boolean;
  deliveredAt?: string | null;
  read?: boolean;
  readAt?: string | null;
  editedAt?: string | null;
  deleted?: boolean;
  formatTimestamp?: (value: string) => string;
}

export interface ChatMessageRecipientStatusDetail {
  recipientEmail?: string | null;
  recipientName?: string | null;
  delivered?: boolean;
  deliveredAt?: string | null;
  read?: boolean;
  readAt?: string | null;
}

export interface ChatMessageInfoRow {
  label: string;
  value: string;
}

export interface ChatMessageInfoShortcutInput {
  key?: string | null;
  code?: string | null;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isTargetEditable?: boolean;
  hasExpandableRows?: boolean;
}

export type ChatMessageInfoShortcutAction = 'close' | 'copy-all' | 'toggle-all-details' | null;
export type ChatMessageInfoCopyFeedbackSourceLabel = 'Row' | 'All';

export interface ChatMessageInfoCopyFeedbackSourcePalette {
  borderColor: string;
  backgroundColor: string;
  textColor: string;
}

export type ChatMessageInfoCopyToastOutcome = 'success' | 'error';
export type ChatMessageInfoCopyToastSource = 'row' | 'all';

export interface ChatMessageInfoCopyToastPayload {
  title: string;
  detail: string;
}

export interface ChatMessageInfoRowBadge {
  text: string;
  tone: 'success' | 'warning';
}

export interface ChatMessageInfoRowValueParts {
  summary: string;
  details: string[];
}

export interface ChatMessageInfoCopyToastCooldownState {
  cooldownMs: number;
  elapsedMs: number;
  remainingMs: number;
  shouldSuppress: boolean;
}

export interface ChatMessageInfoCopyToastSuppressionPlan {
  shouldSuppress: boolean;
  nextSuppressedCount: number;
  noticeText: string;
  noticeClearDelayMs: number;
}

export interface ChatMessageInfoCopiedResetPayload {
  nextRowKey: (currentRowKey: string | null | undefined) => string | null;
  nextRowLabel: (currentRowLabel: string | null | undefined) => string;
}

export interface ChatMessageInfoCopySuccessSelection {
  copiedRowKey: string;
  copiedRowLabel: string;
}

export interface ChatMessageInfoCopySuccessPlan {
  selection: ChatMessageInfoCopySuccessSelection;
  resetPayload: ChatMessageInfoCopiedResetPayload;
}

export interface ChatMessageInfoCopyMetricRollupState {
  totalEvents: number;
  rowSuccess: number;
  rowError: number;
  allSuccess: number;
  allError: number;
  lastMetricAt: number;
}

export interface ChatMessageInfoCopyMetricRollupPayload extends Record<string, unknown> {
  totalEvents: number;
  rowSuccess: number;
  rowError: number;
  allSuccess: number;
  allError: number;
  source: ChatMessageInfoCopyToastSource;
  outcome: ChatMessageInfoCopyToastOutcome;
  sourceSuccess: number;
  sourceError: number;
}

const CHAT_MESSAGE_INFO_COPY_TOAST_COOLDOWN_MS: Record<ChatMessageInfoCopyToastOutcome, number> = {
  success: 850,
  error: 1200,
};
const CHAT_MESSAGE_INFO_COPY_TOAST_NOTICE_CLEAR_BUFFER_MS = 120;
const CHAT_MESSAGE_INFO_COPY_ROW_FALLBACK_KEY = '__row__';
const CHAT_MESSAGE_INFO_COPY_METRIC_EMIT_EVERY_EVENTS = 8;
const CHAT_MESSAGE_INFO_COPY_METRIC_EMIT_INTERVAL_MS = 60000;

interface NormalizedRecipientStatusDetail {
  recipientLabel: string;
  delivered: boolean;
  deliveredAt: string | null;
  read: boolean;
  readAt: string | null;
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

function normalizeString(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeMessageInfoRowKey(value: string | null | undefined): string {
  const normalizedRowKey = normalizeString(value);
  if (!normalizedRowKey) {
    return '';
  }

  const normalizedSegments = normalizedRowKey
    .split(':')
    .map((segment) => normalizeString(segment))
    .filter((segment) => segment.length > 0);

  if (normalizedSegments.length <= 0) {
    return '';
  }

  return normalizedSegments.join(':');
}

function resolveMessageInfoRowKeyPrefix(value: string | null | undefined): string {
  const normalizedRowKey = normalizeMessageInfoRowKey(value);
  if (!normalizedRowKey) {
    return '';
  }

  const rowKeyPrefix = normalizeString(normalizedRowKey.split(':')[0]);
  return rowKeyPrefix || '';
}

function resolveRowCopyDetailLabel(value: string | null | undefined): string {
  const normalizedRowLabel = normalizeString(value);
  if (!normalizedRowLabel) {
    return '';
  }

  if (normalizedRowLabel.toLowerCase().endsWith('details')) {
    return normalizedRowLabel;
  }

  return `${normalizedRowLabel} details`;
}

function resolveTimestampLabel(
  value: string | null | undefined,
  formatter?: (value: string) => string
): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  if (typeof formatter !== 'function') {
    return normalized;
  }

  try {
    const formatted = formatter(normalized);
    return normalizeString(formatted) || normalized;
  } catch {
    return normalized;
  }
}

function resolveSenderLabel(input: ChatMessageInfoInput): string {
  if (input.isOwnMessage) {
    return 'You';
  }

  const senderName = normalizeString(input.senderName);
  if (senderName) {
    return senderName;
  }

  const senderEmail = normalizeEmail(input.senderEmail);
  if (senderEmail) {
    return senderEmail;
  }

  return 'Unknown';
}

function resolveRecipientLabel(input: ChatMessageInfoInput): string {
  if (!input.isOwnMessage) {
    return 'You';
  }

  const recipientName = normalizeString(input.recipientName);
  if (recipientName) {
    return recipientName;
  }

  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (recipientEmail) {
    return recipientEmail;
  }

  return 'Recipient';
}

function resolveRecipientStatusDetailLabel(
  detail: ChatMessageRecipientStatusDetail,
  fallbackRecipientLabel: string
): string {
  const recipientName = normalizeString(detail.recipientName);
  if (recipientName) {
    return recipientName;
  }

  const recipientEmail = normalizeEmail(detail.recipientEmail);
  if (recipientEmail) {
    return recipientEmail;
  }

  return fallbackRecipientLabel;
}

function resolveRecipientStatusDetails(
  input: ChatMessageInfoInput,
  fallbackRecipientLabel: string
): NormalizedRecipientStatusDetail[] {
  const details = Array.isArray(input.recipientStatusDetails)
    ? input.recipientStatusDetails
    : [];
  const normalizedDetails = details
    .map((detail) => {
      const deliveredAt = resolveTimestampLabel(detail?.deliveredAt, input.formatTimestamp);
      const readAt = resolveTimestampLabel(detail?.readAt, input.formatTimestamp);

      return {
        recipientLabel: resolveRecipientStatusDetailLabel(detail || {}, fallbackRecipientLabel),
        delivered: detail?.delivered === true || Boolean(deliveredAt),
        deliveredAt,
        read: detail?.read === true || Boolean(readAt),
        readAt,
      };
    })
    .filter((detail) => detail.recipientLabel.length > 0);

  if (normalizedDetails.length > 0) {
    return normalizedDetails;
  }

  const fallbackDeliveredAt = resolveTimestampLabel(input.deliveredAt, input.formatTimestamp);
  const fallbackReadAt = resolveTimestampLabel(input.readAt, input.formatTimestamp);

  return [
    {
      recipientLabel: fallbackRecipientLabel,
      delivered: input.delivered === true || Boolean(fallbackDeliveredAt),
      deliveredAt: fallbackDeliveredAt,
      read: input.read === true || Boolean(fallbackReadAt),
      readAt: fallbackReadAt,
    },
  ];
}

function resolveDeliveredLabel(details: NormalizedRecipientStatusDetail[]): string {
  if (details.length <= 0) {
    return 'Not delivered';
  }

  if (details.length === 1) {
    const detail = details[0];
    if (detail.deliveredAt) {
      return `Delivered to ${detail.recipientLabel} at ${detail.deliveredAt}`;
    }

    if (detail.delivered) {
      return `Delivered to ${detail.recipientLabel}`;
    }

    return 'Not delivered';
  }

  const deliveredCount = details.filter((detail) => detail.delivered).length;
  const detailLines = details.map((detail) => {
    if (detail.deliveredAt) {
      return `${detail.recipientLabel}: Delivered at ${detail.deliveredAt}`;
    }

    return `${detail.recipientLabel}: ${detail.delivered ? 'Delivered' : 'Not delivered'}`;
  });

  return `${deliveredCount}/${details.length} delivered\n${detailLines.join('\n')}`;
}

function resolveReadLabel(details: NormalizedRecipientStatusDetail[]): string {
  if (details.length <= 0) {
    return 'Not read';
  }

  if (details.length === 1) {
    const detail = details[0];
    if (detail.readAt) {
      return `Read by ${detail.recipientLabel} at ${detail.readAt}`;
    }

    if (detail.read) {
      return `Read by ${detail.recipientLabel}`;
    }

    return 'Not read';
  }

  const readCount = details.filter((detail) => detail.read).length;
  const detailLines = details.map((detail) => {
    if (detail.readAt) {
      return `${detail.recipientLabel}: Read at ${detail.readAt}`;
    }

    return `${detail.recipientLabel}: ${detail.read ? 'Read' : 'Not read'}`;
  });

  return `${readCount}/${details.length} read\n${detailLines.join('\n')}`;
}

export function resolveChatMessageInfoRows(input: ChatMessageInfoInput): ChatMessageInfoRow[] {
  const sender = resolveSenderLabel(input);
  const recipient = resolveRecipientLabel(input);
  const sentAt = resolveTimestampLabel(input.sentAt, input.formatTimestamp) || 'Unknown';
  const editedAt = resolveTimestampLabel(input.editedAt, input.formatTimestamp);
  const recipientDetails = resolveRecipientStatusDetails(input, recipient);
  const delivered = resolveDeliveredLabel(recipientDetails);
  const read = resolveReadLabel(recipientDetails);
  const status = input.deleted ? 'Deleted' : 'Active';

  const rows: ChatMessageInfoRow[] = [
    { label: 'Sender', value: sender },
    { label: 'Sent', value: sentAt },
    { label: 'Delivered', value: delivered },
    { label: 'Read', value: read },
    { label: 'Status', value: status },
  ];

  if (editedAt) {
    rows.push({ label: 'Edited', value: editedAt });
  }

  return rows;
}

export function resolveChatMessageInfoLines(input: ChatMessageInfoInput): string[] {
  return resolveChatMessageInfoRows(input).map((row) => `${row.label}: ${row.value}`);
}

export function formatChatMessageInfoRowsForClipboard(rows: ChatMessageInfoRow[]): string {
  if (!Array.isArray(rows) || rows.length <= 0) {
    return '';
  }

  const formattedLines: string[] = [];

  rows.forEach((row) => {
    const label = normalizeString(row?.label) || 'Detail';
    const rawValue = typeof row?.value === 'string' ? row.value : String(row?.value ?? '');
    const valueLines = rawValue
      .split('\n')
      .map((line) => normalizeString(line))
      .filter((line) => line.length > 0);

    if (valueLines.length <= 0) {
      formattedLines.push(`${label}:`);
      return;
    }

    formattedLines.push(`${label}: ${valueLines[0]}`);
    valueLines.slice(1).forEach((line) => {
      formattedLines.push(`  - ${line}`);
    });
  });

  return formattedLines.join('\n').trim();
}

export function resolveChatMessageInfoShortcutAction(
  input: ChatMessageInfoShortcutInput
): ChatMessageInfoShortcutAction {
  const key = normalizeString(input?.key).toLowerCase();
  const code = normalizeString(input?.code).toLowerCase();
  const altKey = input?.altKey === true;
  const shiftKey = input?.shiftKey === true;
  const ctrlKey = input?.ctrlKey === true;
  const metaKey = input?.metaKey === true;
  const isTargetEditable = input?.isTargetEditable === true;

  if (key === 'escape') {
    return 'close';
  }

  if (isTargetEditable) {
    return null;
  }

  const hasShortcutModifiers = altKey && shiftKey && !ctrlKey && !metaKey;
  if (!hasShortcutModifiers) {
    return null;
  }

  if (key === 'c' || code === 'keyc') {
    return 'copy-all';
  }

  if (input?.hasExpandableRows === true && (key === 'd' || code === 'keyd')) {
    return 'toggle-all-details';
  }

  return null;
}

export function resolveChatMessageInfoCopyFeedbackSourceLabel(
  copiedRowKey: string | null | undefined
): ChatMessageInfoCopyFeedbackSourceLabel | '' {
  if (!copiedRowKey) {
    return '';
  }

  if (copiedRowKey === '__all__') {
    return 'All';
  }

  return 'Row';
}

export function resolveChatMessageInfoCopyFeedbackLabel(
  copiedRowKey: string | null | undefined,
  copiedRowLabel: string | null | undefined
): string {
  if (copiedRowKey === '__all__') {
    return 'Copied all message details';
  }

  if (normalizeString(copiedRowKey)) {
    const rowDetailLabel = resolveRowCopyDetailLabel(copiedRowLabel);
    if (rowDetailLabel) {
      return `Copied ${rowDetailLabel}`;
    }

    return 'Copied row details';
  }

  return '';
}

export function resolveChatMessageInfoNormalizedRowKey(
  rowKey: string | null | undefined
): string {
  return normalizeMessageInfoRowKey(rowKey);
}

export function resolveChatMessageInfoCopyRowLabel(
  rowKey: string | null | undefined,
  rowLabel: string | null | undefined
): string {
  const normalizedRowLabel = normalizeString(rowLabel);
  if (normalizedRowLabel) {
    return normalizedRowLabel;
  }

  const rowKeyPrefix = resolveMessageInfoRowKeyPrefix(rowKey);
  if (rowKeyPrefix) {
    return rowKeyPrefix;
  }

  return 'Row';
}

export function resolveChatMessageInfoCopiedRowKeyAfterReset(
  currentRowKey: string | null | undefined,
  targetRowKey: string | null | undefined
): string | null {
  const normalizedCurrentRowKey = normalizeMessageInfoRowKey(currentRowKey);
  const normalizedTargetRowKey = normalizeMessageInfoRowKey(targetRowKey);
  const safeCurrentRowKey = normalizedCurrentRowKey || null;

  if (!normalizedTargetRowKey) {
    return safeCurrentRowKey;
  }

  if (safeCurrentRowKey === normalizedTargetRowKey) {
    return null;
  }

  return safeCurrentRowKey;
}

export function resolveChatMessageInfoCopiedRowLabelAfterReset(
  currentRowLabel: string | null | undefined,
  targetRowLabel: string | null | undefined
): string {
  const normalizedCurrentRowLabel = normalizeString(currentRowLabel);
  if (!normalizedCurrentRowLabel) {
    return '';
  }

  const normalizedTargetRowLabel = normalizeString(targetRowLabel);
  if (!normalizedTargetRowLabel) {
    return normalizedCurrentRowLabel;
  }

  if (normalizedCurrentRowLabel === normalizedTargetRowLabel) {
    return '';
  }

  return normalizedCurrentRowLabel;
}

export function resolveChatMessageInfoCopiedResetPayload(
  targetRowKey: string | null | undefined,
  targetRowLabel: string | null | undefined
): ChatMessageInfoCopiedResetPayload {
  return {
    nextRowKey: (currentRowKey) =>
      resolveChatMessageInfoCopiedRowKeyAfterReset(currentRowKey, targetRowKey),
    nextRowLabel: (currentRowLabel) =>
      resolveChatMessageInfoCopiedRowLabelAfterReset(currentRowLabel, targetRowLabel),
  };
}

export function resolveChatMessageInfoCopySuccessSelection(
  source: ChatMessageInfoCopyToastSource,
  rowKey?: string | null,
  rowLabel?: string | null
): ChatMessageInfoCopySuccessSelection {
  if (source === 'all') {
    return {
      copiedRowKey: '__all__',
      copiedRowLabel: '',
    };
  }

  const normalizedRowKey = normalizeMessageInfoRowKey(rowKey);
  const resolvedRowLabel = resolveChatMessageInfoCopyRowLabel(rowKey, rowLabel);

  return {
    copiedRowKey: normalizedRowKey || CHAT_MESSAGE_INFO_COPY_ROW_FALLBACK_KEY,
    copiedRowLabel: resolvedRowLabel,
  };
}

export function resolveChatMessageInfoCopySuccessPlan(
  source: ChatMessageInfoCopyToastSource,
  rowKey?: string | null,
  rowLabel?: string | null
): ChatMessageInfoCopySuccessPlan {
  const selection = resolveChatMessageInfoCopySuccessSelection(source, rowKey, rowLabel);

  return {
    selection,
    resetPayload: resolveChatMessageInfoCopiedResetPayload(
      selection.copiedRowKey,
      selection.copiedRowLabel
    ),
  };
}

export function createChatMessageInfoCopyMetricRollupState(): ChatMessageInfoCopyMetricRollupState {
  return {
    totalEvents: 0,
    rowSuccess: 0,
    rowError: 0,
    allSuccess: 0,
    allError: 0,
    lastMetricAt: 0,
  };
}

export function recordChatMessageInfoCopyMetricRollup(
  state: ChatMessageInfoCopyMetricRollupState,
  source: ChatMessageInfoCopyToastSource,
  outcome: ChatMessageInfoCopyToastOutcome,
  nowMs: number = Date.now()
): ChatMessageInfoCopyMetricRollupPayload | null {
  state.totalEvents += 1;

  if (source === 'row') {
    if (outcome === 'success') {
      state.rowSuccess += 1;
    } else {
      state.rowError += 1;
    }
  } else if (outcome === 'success') {
    state.allSuccess += 1;
  } else {
    state.allError += 1;
  }

  const safeNowMs = Number.isFinite(nowMs)
    ? Math.max(0, Math.floor(nowMs))
    : 0;
  const shouldEmit =
    state.totalEvents === 1 ||
    state.totalEvents % CHAT_MESSAGE_INFO_COPY_METRIC_EMIT_EVERY_EVENTS === 0 ||
    safeNowMs - state.lastMetricAt >= CHAT_MESSAGE_INFO_COPY_METRIC_EMIT_INTERVAL_MS;

  if (!shouldEmit) {
    return null;
  }

  state.lastMetricAt = safeNowMs;

  return {
    totalEvents: state.totalEvents,
    rowSuccess: state.rowSuccess,
    rowError: state.rowError,
    allSuccess: state.allSuccess,
    allError: state.allError,
    source,
    outcome,
    sourceSuccess: source === 'row' ? state.rowSuccess : state.allSuccess,
    sourceError: source === 'row' ? state.rowError : state.allError,
  };
}

export function resolveChatMessageInfoCopyToastPayload(
  outcome: ChatMessageInfoCopyToastOutcome,
  source: ChatMessageInfoCopyToastSource,
  rowLabel?: string | null
): ChatMessageInfoCopyToastPayload {
  const rowDetailLabel = resolveRowCopyDetailLabel(rowLabel);

  if (outcome === 'success') {
    if (source === 'all') {
      return {
        title: 'Copied',
        detail: 'All message details copied',
      };
    }

    if (rowDetailLabel) {
      return {
        title: 'Copied',
        detail: `${rowDetailLabel} copied`,
      };
    }

    return {
      title: 'Copied',
      detail: 'Message row details copied',
    };
  }

  if (source === 'all') {
    return {
      title: 'Copy failed',
      detail: 'Unable to copy all message details.',
    };
  }

  return {
    title: 'Copy failed',
    detail: 'Unable to copy message details.',
  };
}

export function resolveChatMessageInfoCopyToastCooldownMs(
  outcome: ChatMessageInfoCopyToastOutcome
): number {
  return CHAT_MESSAGE_INFO_COPY_TOAST_COOLDOWN_MS[outcome] || CHAT_MESSAGE_INFO_COPY_TOAST_COOLDOWN_MS.success;
}

export function resolveChatMessageInfoCopyToastCooldownState(
  nowMs: number,
  lastShownAtMs: number,
  outcome: ChatMessageInfoCopyToastOutcome
): ChatMessageInfoCopyToastCooldownState {
  const safeNowMs = Number.isFinite(nowMs) ? Math.max(0, nowMs) : 0;
  const safeLastShownAtMs = Number.isFinite(lastShownAtMs) ? Math.max(0, lastShownAtMs) : 0;
  const cooldownMs = resolveChatMessageInfoCopyToastCooldownMs(outcome);
  const elapsedMs = Math.max(0, safeNowMs - safeLastShownAtMs);
  const shouldSuppress = safeLastShownAtMs > 0 && elapsedMs < cooldownMs;

  return {
    cooldownMs,
    elapsedMs,
    remainingMs: shouldSuppress ? cooldownMs - elapsedMs : 0,
    shouldSuppress,
  };
}

export function resolveChatMessageInfoCopyToastSuppressionPlan(
  cooldownState: ChatMessageInfoCopyToastCooldownState,
  suppressedCount: number,
  isWebPlatform: boolean
): ChatMessageInfoCopyToastSuppressionPlan {
  const safeSuppressedCount = Number.isFinite(suppressedCount)
    ? Math.max(0, Math.floor(suppressedCount))
    : 0;

  if (!cooldownState.shouldSuppress) {
    return {
      shouldSuppress: false,
      nextSuppressedCount: 0,
      noticeText: '',
      noticeClearDelayMs: 0,
    };
  }

  if (!isWebPlatform) {
    return {
      shouldSuppress: true,
      nextSuppressedCount: 0,
      noticeText: '',
      noticeClearDelayMs: 0,
    };
  }

  const nextSuppressedCount = safeSuppressedCount + 1;
  return {
    shouldSuppress: true,
    nextSuppressedCount,
    noticeText: resolveChatMessageInfoToastCooldownNotice(
      cooldownState.remainingMs,
      nextSuppressedCount
    ),
    noticeClearDelayMs: resolveChatMessageInfoCopyToastNoticeClearDelayMs(
      cooldownState.remainingMs
    ),
  };
}

export function resolveChatMessageInfoCopyToastNoticeClearDelayMs(
  remainingMs: number
): number {
  const safeRemainingMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  return safeRemainingMs + CHAT_MESSAGE_INFO_COPY_TOAST_NOTICE_CLEAR_BUFFER_MS;
}

export function resolveChatMessageInfoCopyFeedbackSourcePalette(
  sourceLabel: ChatMessageInfoCopyFeedbackSourceLabel | '' | null | undefined,
  isDarkMode: boolean
): ChatMessageInfoCopyFeedbackSourcePalette | null {
  if (!sourceLabel) {
    return null;
  }

  if (sourceLabel === 'All') {
    return {
      borderColor: isDarkMode ? 'rgba(16, 185, 129, 0.52)' : 'rgba(5, 150, 105, 0.34)',
      backgroundColor: isDarkMode ? 'rgba(16, 185, 129, 0.24)' : 'rgba(16, 185, 129, 0.12)',
      textColor: isDarkMode ? '#6ee7b7' : '#047857',
    };
  }

  return {
    borderColor: isDarkMode ? 'rgba(96, 165, 250, 0.56)' : 'rgba(37, 99, 235, 0.34)',
    backgroundColor: isDarkMode ? 'rgba(59, 130, 246, 0.24)' : 'rgba(59, 130, 246, 0.12)',
    textColor: isDarkMode ? '#93c5fd' : '#1d4ed8',
  };
}

export function resolveChatMessageInfoCopyFeedbackSourceBadgeText(
  sourceLabel: ChatMessageInfoCopyFeedbackSourceLabel | '' | null | undefined
): string {
  if (!sourceLabel) {
    return '';
  }

  return `Source: ${sourceLabel}`;
}

export function resolveChatMessageInfoCopyFeedbackSourceAccessibilityLabel(
  sourceLabel: ChatMessageInfoCopyFeedbackSourceLabel | '' | null | undefined
): string {
  if (!sourceLabel) {
    return '';
  }

  if (sourceLabel === 'All') {
    return 'Copy source all message details';
  }

  return 'Copy source single message detail row';
}

export function resolveChatMessageInfoCopyFeedbackAccessibilityLabel(
  feedbackLabel: string | null | undefined,
  sourceLabel: ChatMessageInfoCopyFeedbackSourceLabel | '' | null | undefined
): string {
  const normalizedFeedbackLabel = normalizeString(feedbackLabel);
  if (!normalizedFeedbackLabel) {
    return '';
  }

  const sourceAccessibilityLabel = resolveChatMessageInfoCopyFeedbackSourceAccessibilityLabel(sourceLabel);
  if (!sourceAccessibilityLabel) {
    return normalizedFeedbackLabel;
  }

  return `${normalizedFeedbackLabel}. ${sourceAccessibilityLabel}.`;
}

export function resolveChatMessageInfoToastCooldownNotice(
  remainingMs: number,
  suppressedCount: number
): string {
  const safeRemainingMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  const safeSuppressedCount = Number.isFinite(suppressedCount)
    ? Math.max(0, Math.floor(suppressedCount))
    : 0;
  const seconds = Math.max(0.1, safeRemainingMs / 1000);
  const toastLabel = safeSuppressedCount === 1 ? 'toast' : 'toasts';

  return `Toast cooldown active (${seconds.toFixed(1)}s). ${safeSuppressedCount} ${toastLabel} suppressed.`;
}

export function resolveChatMessageInfoToastCooldownAccessibilityLabel(
  noticeText: string | null | undefined
): string {
  const normalizedNotice = normalizeString(noticeText);
  if (!normalizedNotice) {
    return '';
  }

  return `Copy feedback notice. ${normalizedNotice}`;
}

export function resolveChatMessageInfoRowBadge(
  label: string,
  value: string
): ChatMessageInfoRowBadge | null {
  const normalizedLabel = normalizeString(label).toLowerCase();
  const normalizedValue = normalizeString(value).toLowerCase();
  if (!normalizedLabel || !normalizedValue) {
    return null;
  }

  if (normalizedLabel === 'delivered') {
    const ratioMatch = normalizedValue.match(/^(\d+)\s*\/\s*(\d+)\s+delivered/);
    if (ratioMatch) {
      const deliveredCount = Number(ratioMatch[1]);
      const totalCount = Number(ratioMatch[2]);
      const isComplete = totalCount > 0 && deliveredCount >= totalCount;
      return {
        text: `${deliveredCount}/${totalCount}`,
        tone: isComplete ? 'success' : 'warning',
      };
    }

    if (normalizedValue.startsWith('not delivered')) {
      return {
        text: 'Pending',
        tone: 'warning',
      };
    }

    return {
      text: 'Delivered',
      tone: 'success',
    };
  }

  if (normalizedLabel === 'read') {
    const ratioMatch = normalizedValue.match(/^(\d+)\s*\/\s*(\d+)\s+read/);
    if (ratioMatch) {
      const readCount = Number(ratioMatch[1]);
      const totalCount = Number(ratioMatch[2]);
      const isComplete = totalCount > 0 && readCount >= totalCount;
      return {
        text: `${readCount}/${totalCount}`,
        tone: isComplete ? 'success' : 'warning',
      };
    }

    if (normalizedValue.startsWith('not read')) {
      return {
        text: 'Unread',
        tone: 'warning',
      };
    }

    if (normalizedValue.startsWith('read by')) {
      return {
        text: 'Read',
        tone: 'success',
      };
    }
  }

  return null;
}

export function resolveChatMessageInfoRowValueParts(
  value: string
): ChatMessageInfoRowValueParts {
  const normalizedValue = typeof value === 'string' ? value : '';
  const lines = normalizedValue
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length <= 1) {
    return {
      summary: normalizedValue,
      details: [],
    };
  }

  return {
    summary: lines[0],
    details: lines.slice(1),
  };
}
