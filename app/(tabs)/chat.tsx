import { logger } from '@/lib/logger';
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useIsFocused, useFocusEffect } from '@react-navigation/native';
import { useForegroundInterval, useLingeringFlag } from '@/hooks/useAppForeground';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  ActivityIndicator,
  TouchableOpacity,
  KeyboardAvoidingView,
  Keyboard,
  BackHandler,
  Platform,
  Image,
  FlatList as RNFlatList,
  Modal,
  Pressable,
  SafeAreaView,
  Animated,
  Dimensions,
  AppState,
  AppStateStatus,
  InteractionManager,
  Alert,
  Easing,
  LayoutAnimation,
  UIManager,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import Toast from 'react-native-toast-message';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../../hooks/useTheme';
import { useAuth, authService } from '../../hooks/useAuthUnified';
import { useBirthdays } from '../../components/BirthdayProvider';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import type { TeamMember } from '../../hooks/useAuthUnified';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { useChat } from '../../hooks/useChat';
import { useEasedUploadProgress } from '@/hooks/useEasedUploadProgress';
import { chatService, ChatRateLimitError, ChatMessageActionError, ChatUploadCanceledError } from '../../services/chatService';
import { MediaPickerUtil, inferFileType } from '../../lib/mediaPickerUtil';
import {
  normalizeKeyboardMediaCandidate,
  describeKeyboardMediaRejection,
  resolveKeyboardMediaSendMode,
  type KeyboardMediaCandidate,
  type KeyboardMediaFile,
} from '../../lib/chatKeyboardMediaSend';
import { resolveChatAttachmentAutoText } from '../../lib/chatAttachmentMessage';
import {
  stageOutboxMedia,
  removeOutboxMedia,
  sweepOutboxOrphans,
  localMediaExists,
  isMediaStagingSupported,
} from '../../lib/chatMediaStaging';
import {
  isBackgroundUploadEnabled,
  startChatBackgroundUpload,
  cancelChatBackgroundUpload,
} from '../../lib/chatBackgroundUpload';
import { getProfileImageUrl } from '../../lib/profileImage';
import { FileDownloadUtil } from '../../lib/fileDownloadUtil';
import {
  PendingMessage,
  PendingMediaMessage,
  PendingAttachmentMessage,
  PendingMessageStorage,
} from '../../lib/pendingMessageStorage';
import { normalizePendingMessageStatus } from '../../lib/pendingMessageState';
import {
  resolveChatPendingServerMessageIdFromCandidates,
  resolveChatPendingMessageCandidatesByKey,
  buildChatPendingTextMatchKey,
  resolveTimestampMs,
} from '../../lib/chatPendingMessageServerIdMatcher';
import { resolveChatRosterMergedWithPresence } from '../../lib/chatRosterMergeState';
import {
  resolveChatPendingRowAnimationTimings,
  resolveChatActivePendingAnimationKeys,
  resolveChatInactivePendingAnimationKeys,
  buildChatPendingRowAnimationKey,
  shouldStartPendingRowAnimation,
  markPendingRowAnimationStarted,
  PENDING_MESSAGE_BUBBLE_OPACITY_DEFAULT,
  resolveChatPendingBubbleOpacityTarget,
  shouldAnimateChatPendingBubbleOpacity,
  resolveChatPendingBubbleOpacityDuration,
  resolveChatInactivePendingBubbleOpacityIds,
  resolveChatPendingBubbleOpacityEntry,
  resolveChatPendingRowAnimationEntry,
} from '../../lib/chatPendingAnimationState';
import {
  hasPendingAttachment,
  resolveChatAttachmentFinalizeDelayMs,
  resolveChatAttachmentCleanupPlan,
} from '../../lib/chatAttachmentFinalizeState';
import {
  resolveChatBottomVisibilityPadding,
  resolveChatAutoscrollToTopThreshold,
} from '../../lib/chatComposerLayoutState';
import {
  resolveChatPendingSenderEmail,
  shouldLoadChatPendingMessages,
  resolveChatNormalizedPendingMessages,
} from '../../lib/chatPendingStorageState';
import { resolveChatScrollToBottomButtonStyleState } from '../../lib/chatFloatingButtonLayoutState';
import {
  shouldRunChatPendingDeliveredCleanup,
  hasChatPendingResolvedIds,
  resolveChatPendingMapAfterRemovingIds,
  resolveChatPendingActiveIdSet,
} from '../../lib/chatPendingCleanupState';
import {
  type MobileChatInputRef,
  MessageStatusTicks,
  ChatProfileModal,
  StyledText,
  EnhancedEmojiPicker,
  OptionModal,
  ConfirmationModal,
} from '../../components';
import { pauseAllChatVideos } from '../../components/VideoPlayer';
import { StickerGifPickerMobile } from '../../components/StickerGifPickerMobile';
import { Search, X, Info, Star, Clock, MessageCircle, Eye, AlertCircle, Trash2, ChevronDown, RotateCcw, CheckCircle2, Edit3, Reply, Copy } from 'lucide-react-native';
import { formatMessageTimestamp, getChatDateSeparator, formatOnlineStatus } from '../../lib/timeUtils';
import { isImageFile, isVideoFile } from '../../lib/fileUtils';
import { notificationService } from '../../services/notificationService';
import { chatPreferencesService } from '../../services/chatPreferencesService';
import type { ConversationSummary, ChatReplyContext } from '../../services/chatService';
import { chatCacheService } from '../../services/chatCacheService';
import type { HydratedAttachment } from '../../services/chatCacheService';
import { useOfflineDataGate } from '../../hooks/useOfflineDataGate';
import { useFrameTimingMonitor } from '../../hooks/useFrameTimingMonitor';
import { getChatPaginationProfile } from '@/lib/chatPaginationConfig';
import {
  resolveChatLoadOlderStartPlan,
  resolveChatLoadOlderAttemptOptions,
  resolveChatReachedConversationStartPlan,
  resolveChatLoadOlderFailurePlan,
  resolveChatLoadOlderFailureLogPayload,
  resolveChatLoadOlderConversationResetPlan,
  resolveChatLoadOlderRunStartPlan,
  resolveChatLoadOlderRunCompletionPlan,
  resolveChatLoadOlderRetryAttemptPlan,
  resolveChatLoadOlderFinalAddedState,
  resolveChatLoadOlderReachedStartToastEmissionPlan,
  resolveChatLoadOlderSyncingToastEmissionPlan,
  type ChatLoadOlderReason,
} from '@/lib/chatLoadOlderState';
import { clearDownloadState, setDownloadState } from '@/lib/downloadStateStore';
import { isSelfConversation, reconcileConversationUnreadCount, shouldRefreshChatSummariesOnForegroundResume } from '@/lib/chatReceiptState';
import {
  applyChatReceiptRequestedReadMutation,
  applyChatReceiptSyncRunFinalizePlan,
  normalizeChatReceiptSyncEmail,
  resolveChatReceiptSyncQueueExecutionPlan,
  resolveChatReceiptForegroundQueueExecutionPlan,
  shouldApplyChatReceiptSyncRunContinuation,
  shouldRunChatReceiptSyncDeferredFlushContinuation,
  resolveChatReceiptViewabilityQueueDispatchPlanForMarker,
  resolveChatReceiptRequestedReadMutationPlan,
  resolveChatReceiptSyncConversationResetPlan,
  clearChatReceiptSyncQueuedState,
  resolveChatReceiptSyncFlushExecutionPlan,
  resolveChatReceiptSyncRunAttemptPlan,
  resolveChatReceiptSyncFlushPlan,
  resolveChatReceiptRequestedReadSeedMessageIds,
} from '@/lib/chatReceiptSyncState';
import { clearTimeoutRef, scheduleTimeoutRef } from '@/lib/timeoutRef';
import { areChatTypingPairsEqual, createChatTypingPair, type ChatTypingPair } from '@/lib/chatTypingState';
import { resolveChatTypingTransition } from '@/lib/chatTypingTransition';
import {
  createChatTypingStatusWriteRollupState,
  recordChatTypingStatusWriteRollup,
} from '@/lib/chatTypingMetrics';
import { canAttemptChatComposerSend, isChatComposerMessageOverLimit } from '@/lib/chatComposerSendState';
import {
  resolveChatComposerMessageWithinLimits,
  resolveChatComposerWordCount,
} from '@/lib/chatComposerInputState';
import { resolveChatRichTextInputResult } from '@/lib/chatRichContentState';
import { getChatComposerDraftKey } from '@/lib/chatComposerDrafts';
import { ChatComposer } from '../../components/chat/ChatComposer';

import { resolveChatSpecialComposerState } from '@/lib/chatSpecialComposerState';
import {
  resolveChatSafeDisplayInitial,
  resolveChatSanitizedAttachmentFileName,
  resolveChatSanitizedDateSeparatorLabel,
  resolveChatSanitizedMessageText,
} from '@/lib/chatSanitizeState';
import {
  resolveChatNormalizedMessageId,
  resolveChatNormalizedMessageValue,
  resolveChatNormalizedParticipantEmail,
} from '@/lib/chatNormalizationState';
import { resolveChatTimestampMs } from '@/lib/chatTimestampState';
import { resolveChatRealtimeOnline } from '@/lib/chatPresenceState';
import { resolveChatReplyPreviewText } from '@/lib/chatReplyPreview';
import { getEmojiName, normalizeReactions, type ReactionPillDescriptor } from '@/lib/chatReactionUtils';
import {
  clampChatConversationSearchIndex,
  type ChatConversationSearchScope,
  type ChatConversationSearchScopeShortcutAction,
  normalizeChatConversationSearchQuery,
  resolveChatConversationSearchMatchIds,
  resolveChatConversationSearchBestScopeSuggestion,
  resolveChatConversationSearchNoMatchesGuidance,
  resolveChatConversationSearchNoMatchesLabel,
  resolveChatConversationSearchScopeMatchCounts,
  resolveChatConversationSearchScopeShortcutAction,
  resolveChatConversationSearchScopeSuggestionByOrdinal,
  resolveChatConversationSearchScopeSuggestionCycle,
  resolveChatConversationSearchScopeSuggestions,
  resolveChatConversationSearchSeedQuery,
  resolveChatConversationSearchSnippet,
  resolveChatConversationSearchCounterLabel,
  resolveChatConversationSearchSnippetTypeLabel,
  resolveChatConversationSearchNextIndex,
  resolveChatConversationSearchScopeStep,
  shouldLoadOlderForConversationSearch,
} from '@/lib/chatConversationSearch';
import {
  createChatConversationSearchUxRollupState,
  recordChatConversationSearchUxRollup,
} from '@/lib/chatConversationSearchMetrics';
import { resolveChatConversationSearchMatchCollections } from '@/lib/chatConversationSearchMatchCollections';
import {
  createChatRenderTraceState,
  resolveChatRenderTraceCompletePayload,
  resolveChatRenderTraceStartPayload,
  type ChatRenderTraceState,
} from '@/lib/chatRenderTraceMetrics';
import {
  resolveChatUnreadRepairEligibility,
  resolveChatUnreadRepairRunPayload,
} from '@/lib/chatUnreadRepairMetrics';
import { resolveChatLiveConversationSummary } from '@/lib/chatConversationSummaryState';
import { resolveChatUnreadDividerDerivedState } from '@/lib/chatUnreadDividerState';
import { resolveChatUnreadDividerSeed } from '@/lib/chatUnreadDividerSeed';
import { resolveChatUnreadSeparatorReconcilePlan } from '@/lib/chatUnreadSeparatorReconcileState';
import { resolveChatFilteredTeamMembers } from '@/lib/chatTeamMemberListState';
import {
  resolveChatMessageRowMetaState,
} from '@/lib/chatMessageRowMetaState';
import {
  resolveChatEstimatedItemSize,
  resolveChatEstimatedListSize,
  resolveChatListDrawDistance,
} from '@/lib/chatListVirtualizationState';
import { upsertChatConversationSummary } from '@/lib/chatConversationSummaryMapState';
import {
  resolveChatBottomAnchorAttemptPlan,
  resolveChatEnsureAnchorActionPlan,
  resolveChatPrependAnchorFailureExecutionPlanForRestore,
  resolveChatPrependAnchorRestoreOffsetPlan,
  resolveChatPrependAnchorCapturePlan,
  resolveChatPrependAnchorCaptureTriggerOffset,
} from '@/lib/chatAnchorStabilizationState';
import {
  applyChatPrependAnchorRestoreWithFallback,
  type ChatPendingPrependAnchorRefValue,
} from '@/lib/chatAnchorFailureExecutionRuntime';
import {
  applyChatViewabilityDeferredResolveDispatchPlan,
  resolveChatViewabilityNearbyMediaPrefetchPlan,
  resolveChatViewabilityPrefetchCandidateIndices,
} from '@/lib/chatViewabilityPrefetch';
import {
  applyChatViewabilityWarmTargetPrefetch,
  resolveChatViewabilityQueueDispatchResolverFallbackMetricEmissionPlan,
  resolveChatViewabilityQueueDispatchEffectsPlan,
  resolveChatViewabilityReceiptQueueDispatchPlan,
} from '@/lib/chatViewabilityReceiptCollection';
import {
  resolveChatViewabilityWindowSummary,
  resolveChatUnreadSeparatorVisibilityPlan,
  resolveChatTopWindowActionPlan,
} from '@/lib/chatViewabilityWindow';
import {
  createChatMessageInfoCopyMetricRollupState,
  recordChatMessageInfoCopyMetricRollup,
  resolveChatMessageInfoCopyToastCooldownState,
  resolveChatMessageInfoCopyToastSuppressionPlan,
  resolveChatMessageInfoCopySuccessPlan,
  resolveChatMessageInfoCopyFeedbackAccessibilityLabel,
  resolveChatMessageInfoCopyFeedbackLabel,
  resolveChatMessageInfoCopyFeedbackSourceAccessibilityLabel,
  resolveChatMessageInfoCopyFeedbackSourceBadgeText,
  resolveChatMessageInfoCopyToastPayload,
  resolveChatMessageInfoRowBadge,
  resolveChatMessageInfoRowValueParts,
  formatChatMessageInfoRowsForClipboard,
  resolveChatMessageInfoCopyFeedbackSourceLabel,
  resolveChatMessageInfoCopyFeedbackSourcePalette,
  resolveChatMessageInfoShortcutAction,
  resolveChatMessageInfoToastCooldownAccessibilityLabel,
  resolveChatMessageInfoRows,
} from '@/lib/chatMessageInfo';
import { executeChatReplyJump } from '@/lib/chatReplyJump';
import {
  createChatReplyJumpMetricRollupState,
  flushChatReplyJumpMetricRollup,
  recordChatReplyJumpMetricRollup,
  type ChatReplyJumpMetricReason,
  type ChatReplyJumpMetricSource,
} from '@/lib/chatReplyJumpMetrics';
import {
  normalizeReplyJumpTargetMessageId,
  resolveReplyJumpHighlightAfterTimeout,
  resolveReplyJumpStateForJumpSuccess,
  resolveReplyJumpStateForLatestReturn,
  resolveReplyJumpStateForNearBottom,
} from '@/lib/chatReplyJumpUiState';
import {
  pruneDelimitedMapByPrefixSet,
  pruneMapByKeySet,
  pruneMapByNumericRange,
  resolveMapCacheEntry,
  resolveChatAttachmentBaseKeySet,
} from '@/lib/chatHandlerCache';
import {
  resolveChatPendingReplyPreviewState,
  resolveChatPendingStatusDisplayState,
} from '@/lib/chatPendingRenderState';
import {
  resolveChatPendingAttachmentMessageReconciledIds,
  resolveChatPendingMediaMessageReconciledIds,
  resolveChatPendingTextMessageReconciledIds,
} from '@/lib/chatPendingReconciliationState';
import {
  resolveConfirmedDeliveredIds,
  resolveExhaustedOutboxAction,
} from '@/lib/chatSendConfirmationState';
import {
  OUTBOX_MAX_REDRIVE_ATTEMPTS,
  OUTBOX_MIN_STALE_MS,
  OUTBOX_BASE_BACKOFF_MS,
  OUTBOX_DRIVER_TICK_MS,
  resolveOutboxBackoffMs,
  claimOutboxConversation,
} from '@/lib/outboxSelfHeal';
import {
  resolveChatPendingTextVisibilityState,
} from '@/lib/chatPendingVisibilityState';
import { resolveChatPendingRetryOutcomeSummary } from '@/lib/chatPendingRetryOutcomeState';
import { resolveChatPendingRetryAllGuard } from '@/lib/chatPendingRetryEligibilityState';
import { resolveChatPendingCancelAllGuard } from '@/lib/chatPendingCancelEligibilityState';
import { resolveChatPendingRetryBatchPlan } from '@/lib/chatPendingRetryBatchState';
import { resolveChatPendingRetryDispatchPromises } from '@/lib/chatPendingRetryDispatchState';
import { resolveChatPendingAutoRetryPlan } from '@/lib/chatPendingAutoRetryState';
import { resolveChatPendingConversationDerivedState } from '@/lib/chatPendingConversationDerived';
import { generatePendingId } from '@/lib/pendingId';
import { resolveChatPendingFooterSignature } from '@/lib/chatPendingFooterSignature';
import { resolveChatNearBottomState } from '@/lib/chatNearBottomState';
import {
  resolveChatStickyDateIdleHidePlan,
  resolveChatStickyDateScrollPlan,
} from '@/lib/chatStickyDateScrollState';
import {
  resolveChatMessageDisplayKey,
  resolveChatMessageRenderSignature,
} from '@/lib/chatMessageIdentityState';
import {
  resolveChatMessageLayoutSize,
  resolveChatMessageListItemKey,
  resolveChatMessageListItemType,
} from '@/lib/chatMessageListItemState';
import {
  type ChatStableMessageCacheEntry,
  resolveChatDisplayedMessagesState,
  resolveChatDisplayedMessageIdSet,
  shouldCompactChatMessagePositions,
  resolveChatPrunedMessagePositions,
} from '@/lib/chatDisplayedMessagesState';
import {
  resolveChatOptimisticReactionMap,
  shouldKeepChatOptimisticReactionUntil,
  resolveChatOptimisticReactionExpiryIds,
  resolveChatPrunedLocalMessageReactions,
} from '@/lib/chatReactionState';
import {
  resolveChatCanDeleteMessage,
  resolveChatCanEditMessage,
  resolveChatCanReplyMessage,
  resolveChatFindLatestEditableOwnMessage,
  resolveChatIsOwnMessageEmail,
} from '@/lib/chatMessageActionState';
import { resolveChatRosterSnapshotForRoster } from '@/lib/chatRosterSnapshotState';
import { resolveChatReplyContextFromMessage, resolveChatReplySenderLabel } from '@/lib/chatReplyContextState';
import { resolveChatScrollInteractionPlan } from '@/lib/chatScrollInteractionState';
import { useTenant } from '@/hooks/useTenantContext';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { tenantService } from '@/services/tenantService';
import { firestore } from '../../config/firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import TenantRoleBadge from '@/components/TenantRoleBadge';
import { setEditingMessageId, setMessageReactionsForMessage } from '@/lib/messageUiStateStore';
import AnimatedChatDivider from '@/components/chat/AnimatedChatDivider';
import MessageRow from '@/components/chat/MessageRow';
import { ChatAttachmentModal } from '@/components/chat/ChatAttachmentModal';
import { ChatFilePreviewModal } from '@/components/chat/ChatFilePreviewModal';
import { ChatImageViewerModal } from '@/components/chat/ChatImageViewerModal';
import { ChatContextProvider } from '@/components/chat/ChatContext';
import { ChatHeader } from '@/components/chat/ChatHeader';
import {
  ChatPendingMedia,
  ChatPendingAttachments,
  type PendingMediaItem,
  type PendingAttachmentItem,
} from '@/components/chat/ChatPendingMedia';
import AnimatedTypingIndicator from '@/components/AnimatedTypingIndicator';
import type { ChatStableContextValue, ChatReactiveContextValue } from '@/components/chat/ChatContext';

const CHAT_PRESENCE_MODE = (process.env.EXPO_PUBLIC_PRESENCE_MODE || 'last_seen').toLowerCase();
const MESSAGE_TUNE_SOURCE = require('../../assets/sounds/message_tune.mp3');
const CHAT_OPEN_TONE_COOLDOWN_MS = 500;
const CHAT_MESSAGE_MAX_CHARS = 500;
const CHAT_MESSAGE_MAX_WORDS = 100;
const CHAT_REPLY_PREVIEW_MAX_CHARS = 120;
const MESSAGE_INFO_COPIED_RESET_DELAY_MS = 1400;
// Outbox self-heal driver policy (stuck-message-delivery-fix, tasks 10.5/10.6).
// A send that was accepted locally but is not yet confirmed as durably persisted
// for the intended recipient is automatically re-driven with bounded exponential
// backoff (reusing its clientMsgId so the server upsert is idempotent). After the
// attempt cap is exhausted without confirmation, the item is dead-lettered to an
// explicit, actionable `failed` state — never left as a misleading "Sent".
//
// The constants + backoff live in `lib/outboxSelfHeal.ts` so the chat screen
// driver (this file, for the OPEN conversation) and the app-level self-heal hook
// (`hooks/useOutboxSelfHeal.ts`, for ALL OTHER conversations) share a single
// source of truth and identical timing (chat-production-hardening, P1-1).
const CONVERSATION_SEARCH_SCOPE_LABELS: Record<ChatConversationSearchScope, string> = {
  all: 'All',
  text: 'Text',
  attachment: 'Attachment',
  reply: 'Reply',
  media: 'Media',
};
const CONVERSATION_SEARCH_SCOPE_SHORTCUT_LABELS: Record<ChatConversationSearchScope, string> = {
  all: 'A',
  text: 'T',
  attachment: 'F',
  reply: 'R',
  media: 'M',
};
const CONVERSATION_SEARCH_SCOPE_OPTIONS: readonly {
  key: ChatConversationSearchScope;
  label: string;
}[] = [
  { key: 'all', label: CONVERSATION_SEARCH_SCOPE_LABELS.all },
  { key: 'text', label: CONVERSATION_SEARCH_SCOPE_LABELS.text },
  { key: 'attachment', label: CONVERSATION_SEARCH_SCOPE_LABELS.attachment },
  { key: 'reply', label: CONVERSATION_SEARCH_SCOPE_LABELS.reply },
  { key: 'media', label: CONVERSATION_SEARCH_SCOPE_LABELS.media },
];

const CONVERSATION_SEARCH_QUERY_DEBOUNCE_MS = 140;

const UNREAD_DIVIDER_AUTO_DISMISS_MS = 2200;
const UNREAD_DIVIDER_ACTION_DISMISS_MS = 180;
const resolveChatPresenceThresholdMin = () => {
  const raw = process.env.EXPO_PUBLIC_FIRESTORE_ONLINE_THRESHOLD_MIN;
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.5;
};
const CHAT_PRESENCE_THRESHOLD_MIN = resolveChatPresenceThresholdMin();

interface PendingUploadProgressBarProps {
  progress: number;
  label: string;
  showPercent?: boolean;
  isActive?: boolean;
  textStyle?: any;
  trackStyle?: any;
  fillStyle?: any;
}

function normalizePendingUploadProgress(progress: unknown): number {
  const numeric = Number(progress);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  if (numeric >= 100) {
    return 100;
  }

  return numeric;
}

function PendingUploadProgressBar({
  progress,
  label,
  showPercent = true,
  isActive = true,
  textStyle,
  trackStyle,
  fillStyle,
}: PendingUploadProgressBarProps) {
  const easedProgress = useEasedUploadProgress(progress, {
    isActive,
    smoothingPerSecond: 11,
    minStepPercent: 0.18,
    completionSnapThresholdPercent: 99.2,
    nearCompletionBoostStartPercent: 96,
    nearCompletionBoostMultiplier: 1.35,
  });
  const displayProgress = normalizePendingUploadProgress(easedProgress);

  return (
    <>
      <Text style={textStyle}>
        {showPercent ? `${label} ${Math.round(displayProgress)}%` : label}
      </Text>
      <View style={trackStyle}>
        <View style={[fillStyle, { width: `${displayProgress}%` }]} />
      </View>
    </>
  );
}

interface ChatMessagesListPaneProps {
  stickyDateVisible: boolean;
  stickyDateText: string;
  sanitizeDateSeparatorLabel: (value: unknown) => string;
  theme: any;
  isInitialAnchorSettled: boolean;
  flatListRef: any;
  listKey: string;
  displayedMessages: any[];
  estimatedItemSize: number;
  getMessageKey: (item: any, index: number) => string;
  estimatedListSize: any;
  listDrawDistance: number;
  onViewableItemsChanged: any;
  viewabilityConfig: any;
  getMessageItemType: (item: any, index: number) => string;
  overrideMessageLayout: any;
  renderMessageItem: any;
  listExtraData: any;
  messagesContentContainerStyle: any;
  onMessageListScroll: (event: any) => void;
  onMessageListContentSizeChange: (width: number, height: number) => void;
  onMessageListLayout: (event: any) => void;
  maintainVisibleContentPositionConfig: any;
  renderChatListHeader: () => React.ReactNode;
  renderChatListFooter: () => React.ReactNode;
  renderChatListEmpty: () => React.ReactElement | null;
}

interface ChatMessagesListShellProps {
  listPaneProps: ChatMessagesListPaneProps;
  scrollButtonProps: ChatScrollToBottomButtonProps;
}

interface ChatScrollToBottomButtonProps {
  showScrollToBottom: boolean;
  handleScrollToBottomPress: () => void;
  scrollToBottomButtonStyle: any;
  showReplyJumpToLatest: boolean;
  unseenCount: number;
  unseenCountBadgeStyle: any;
  theme: any;
}

const ChatMessagesFlashListPane = React.memo(function ChatMessagesFlashListPane({
  stickyDateVisible,
  stickyDateText,
  sanitizeDateSeparatorLabel,
  theme,
  isInitialAnchorSettled,
  flatListRef,
  listKey,
  displayedMessages,
  estimatedItemSize,
  getMessageKey,
  estimatedListSize,
  listDrawDistance,
  onViewableItemsChanged,
  viewabilityConfig,
  getMessageItemType,
  overrideMessageLayout,
  renderMessageItem,
  listExtraData,
  messagesContentContainerStyle,
  onMessageListScroll,
  onMessageListContentSizeChange,
  onMessageListLayout,
  maintainVisibleContentPositionConfig,
  renderChatListHeader,
  renderChatListFooter,
  renderChatListEmpty,
}: ChatMessagesListPaneProps) {
  return (
    <>
      {stickyDateVisible && (
        <View style={[styles.stickyDateHeader, { backgroundColor: 'transparent', pointerEvents: 'none' }]}> 
          <View style={[styles.stickyDateContainer, {
            backgroundColor: theme.surface,
            borderColor: theme.border,
            ...(Platform.OS === 'web' ? {} : { shadowColor: theme.text }),
          }]}> 
            <Text style={[styles.stickyDateText, { color: theme.textSecondary }]}> 
              {sanitizeDateSeparatorLabel(stickyDateText)}
            </Text>
          </View>
        </View>
      )}

      <View
        style={[styles.messagesContainer, !isInitialAnchorSettled && styles.messagesContainerHidden]}
      >
        <FlashList
          ref={flatListRef}
          key={listKey}
          data={displayedMessages}
          estimatedItemSize={estimatedItemSize}
          keyExtractor={getMessageKey}
          estimatedListSize={estimatedListSize}
          drawDistance={listDrawDistance}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={viewabilityConfig}
          getItemType={getMessageItemType}
          overrideItemLayout={overrideMessageLayout}
          renderItem={renderMessageItem}
          extraData={listExtraData}
          removeClippedSubviews={Platform.OS !== 'web'}
          contentContainerStyle={messagesContentContainerStyle}
          showsVerticalScrollIndicator={false}
          onScroll={onMessageListScroll}
          scrollEventThrottle={32}
          onContentSizeChange={onMessageListContentSizeChange}
          onLayout={onMessageListLayout}
          maintainVisibleContentPosition={maintainVisibleContentPositionConfig}
          ListHeaderComponent={renderChatListHeader}
          ListFooterComponent={renderChatListFooter}
          ListEmptyComponent={renderChatListEmpty}
        />
      </View>
    </>
  );
});

const ChatScrollToBottomButton = React.memo(function ChatScrollToBottomButton({
  showScrollToBottom,
  handleScrollToBottomPress,
  scrollToBottomButtonStyle,
  showReplyJumpToLatest,
  unseenCount,
  unseenCountBadgeStyle,
  theme,
}: ChatScrollToBottomButtonProps) {
  if (!showScrollToBottom) {
    return null;
  }

  return (
    <TouchableOpacity
      onPress={handleScrollToBottomPress}
      activeOpacity={0.8}
      style={scrollToBottomButtonStyle}
    >
      <ChevronDown size={18} color={theme.text} />
      {showReplyJumpToLatest ? (
        <Text style={[styles.scrollToBottomLatestLabel, { color: theme.text }]}>Latest</Text>
      ) : unseenCount > 0 && (
        <View style={unseenCountBadgeStyle}>
          <Text style={styles.unreadBadgeText}>{unseenCount}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
});

const ChatMessagesListShell = React.memo(function ChatMessagesListShell({
  listPaneProps,
  scrollButtonProps,
}: ChatMessagesListShellProps) {
  return (
    <View style={styles.messagesWrapper}>
      <ChatMessagesFlashListPane {...listPaneProps} />
      <ChatScrollToBottomButton {...scrollButtonProps} />
    </View>
  );
});

// Rehydrates the durable media outbox + sweeps staged orphans once per app
// launch. Module scope (not a ref) so a chat-screen remount within the same
// launch never re-hydrates or re-sweeps (which could delete a staged file a
// still-in-flight upload is reading). Resets only on a fresh JS context.
let didHydrateChatOutboxThisLaunch = false;

export default function Chat() {
  const { theme, isDarkMode } = useTheme();

  // ── Phase 6: Memoized theme-dependent styles ──
  // Pre-compute the most frequently repeated inline style objects so that
  // the render-message hot path reuses stable references instead of
  // allocating new objects on every render.
  const themedStyles = useMemo(() => ({
    // Color styles (used 100+ times across message rows)
    colorTextSecondary: { color: theme.textSecondary } as const,
    colorText: { color: theme.text } as const,
    colorPrimary: { color: theme.primary } as const,
    colorWarning: { color: theme.warning } as const,
    colorError: { color: theme.error } as const,
    // Background styles (used 40+ times)
    bgBackground: { backgroundColor: theme.background } as const,
    bgPrimary: { backgroundColor: theme.primary } as const,
    bgSurface: { backgroundColor: theme.surface } as const,
    bgBorder: { backgroundColor: theme.border } as const,
    // Compound styles for common patterns
    borderPrimary: { borderColor: theme.primary } as const,
    borderBorder: { borderColor: theme.border } as const,
    borderWarning: { borderColor: theme.warning } as const,
    borderLeftPrimary: { borderLeftColor: theme.primary } as const,
    borderLeftWarning: { borderLeftColor: theme.warning } as const,
    // Reaction pill compound styles (used per-reaction per-message)
    reactionPillBase: { backgroundColor: theme.background, borderColor: theme.border } as const,
    reactionPillSelected: { backgroundColor: theme.primary + '20', borderColor: theme.primary } as const,
    // Deleted sticker placeholder
    deletedPlaceholder: { backgroundColor: theme.background, borderColor: theme.border } as const,
    // Special message bubble
    specialBubble: { backgroundColor: theme.surface, borderColor: theme.warning } as const,
    // Friend message bubble
    friendBubble: { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border } as const,
    // Retry button
    retryButton: {
      marginLeft: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 8,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
    },
    retryButtonDisabled: {
      marginLeft: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 8,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      opacity: 0.6,
    },
    retryText: { color: theme.primary, fontWeight: '600' as const } as const,
    // Link styles for StyledText (hot path – special + regular messages)
    linkStylePrimary: { color: theme.primary, fontWeight: '600' as const } as const,
    linkStyleOwn: { color: 'rgba(255, 255, 255, 0.9)' as const, fontWeight: '600' as const } as const,
    // Editing border styles
    editBorderOwn: { borderWidth: 2, borderColor: 'rgba(255, 255, 255, 0.7)' } as const,
    editBorderFriend: { borderWidth: 2, borderColor: theme.primary } as const,
    // ── Separator styles (renderMessageItem hot path) ──
    dateSepLine: { backgroundColor: theme.border } as const,
    dateSepText: { backgroundColor: theme.background, color: theme.textSecondary } as const,
    unreadSepLine: { backgroundColor: isDarkMode ? '#FF4444' : '#FF0000' } as const,
    unreadSepText: { backgroundColor: theme.background, color: isDarkMode ? '#FF4444' : '#FF0000', fontWeight: '600' as const } as const,
    newDividerLine: { backgroundColor: theme.primary } as const,
    newDividerText: { backgroundColor: theme.background, color: theme.primary, fontWeight: '600' as const } as const,
    // Search result marker
    searchMarkerActive: { borderColor: theme.primary, backgroundColor: isDarkMode ? 'rgba(59, 130, 246, 0.22)' : 'rgba(59, 130, 246, 0.15)' } as const,
    searchMarkerInactive: { borderColor: isDarkMode ? 'rgba(148, 163, 184, 0.45)' : 'rgba(100, 116, 139, 0.34)', backgroundColor: theme.background } as const,
    searchDotActive: { backgroundColor: theme.primary } as const,
    searchDotInactive: { backgroundColor: isDarkMode ? 'rgba(147, 197, 253, 0.9)' : 'rgba(59, 130, 246, 0.76)' } as const,
  }), [theme, isDarkMode]);

  // Debug toggle: set to true while diagnosing scroll/anchor behavior (web/native)
  const CHAT_SCROLL_DEBUG = false;
  const { headerCompensation, setSuppressFab } = useBirthdays();
  const effectiveHeaderComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);
  const sharedTopPadding = useSharedTopPadding();
  const isFocused = useIsFocused();
  const router = useRouter();
  const searchParams = useLocalSearchParams<{ senderEmail?: string; chatId?: string; messageId?: string; senderName?: string }>();
  const { user, loading: authLoading } = useAuth();
  const { activeTenant, loading: tenantLoading } = useTenant();
  const tenantUnavailable = !tenantLoading && !activeTenant?.id;
  const { isOffline } = useNetworkStatus();
  const [currentUser, setCurrentUser] = useState<any>(user);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [teamMembersWithChatInfo, setTeamMembersWithChatInfo] = useState<any[]>([]);
  const [teamMembersLoading, setTeamMembersLoading] = useState(false);
  const [isManualListRefresh, setIsManualListRefresh] = useState(false);
  const [teamMembersError, setTeamMembersError] = useState<string | null>(null);
  const [selectedTeamMember, setSelectedTeamMember] = useState<TeamMember | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [conversationSearchVisible, setConversationSearchVisible] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState('');
  const [conversationSearchDebouncedQuery, setConversationSearchDebouncedQuery] = useState('');
  const [conversationSearchScope, setConversationSearchScope] = useState<ChatConversationSearchScope>('all');
  const [conversationSearchActiveIndex, setConversationSearchActiveIndex] = useState(0);
  const [conversationSearchHighlightMessageId, setConversationSearchHighlightMessageId] = useState<string | null>(null);
  const [conversationSearchKeyboardSuggestionScope, setConversationSearchKeyboardSuggestionScope] =
    useState<ChatConversationSearchScope | null>(null);
  const [conversationSearchShortcutPulseScope, setConversationSearchShortcutPulseScope] =
    useState<ChatConversationSearchScope | null>(null);
  const [isConversationSearchHistoryLoading, setIsConversationSearchHistoryLoading] = useState(false);
  const [showSearchShortcutTipsModal, setShowSearchShortcutTipsModal] = useState(false);
  const conversationSearchInputRef = useRef<TextInput | null>(null);
  const conversationSearchQueryRef = useRef('');
  const previousConversationSearchQueryRef = useRef('');
  const previousConversationSearchScopeRef = useRef<ChatConversationSearchScope>('all');
  const conversationSearchLoadTokenRef = useRef(0);
  const conversationSearchHistoryLoadAttemptsRef = useRef(0);
  const conversationSearchLoadDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationSearchVisibleRef = useRef(false);
  const conversationSearchMatchIdsRef = useRef<string[]>([]);
  const normalizedConversationSearchQueryRef = useRef('');
  const isConversationSearchHistoryLoadingRef = useRef(false);
  const scheduleConversationSearchHistoryLoadRef = useRef<(query: string) => void>(() => {});
  const conversationSearchScopeRef = useRef<ChatConversationSearchScope>('all');
  const conversationSearchKeyboardSuggestionScopeRef = useRef<ChatConversationSearchScope | null>(null);
  const conversationSearchShortcutPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationSearchTelemetryRef = useRef(createChatConversationSearchUxRollupState());
  // ── Refs for renderMessageItem dependency stabilization (Phase 4) ──
  const conversationSearchHighlightMessageIdRef = useRef<string | null>(null);
  const conversationSearchMatchIdSetRef = useRef<Set<string>>(new Set());
  const conversationSearchMatchIndexByIdRef = useRef<Map<string, number>>(new Map());
  const messageRowMetaByIdRef = useRef<typeof messageRowMetaById>(null as any);
  const newDividerMessageIdRef = useRef<string | null>(null);
  const showNewDividerRef = useRef(false);
  const unreadDividerLabelRef = useRef('');
  const [isTyping, setIsTyping] = useState(false);
  const [message, setMessage] = useState('');
  const latestMessageRef = useRef(message);
  const draftByConversationKeyRef = useRef<Map<string, string>>(new Map());
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const sendInFlightRef = useRef(false);
  const [pendingMessages, setPendingMessages] = useState<Map<string, PendingMessage>>(new Map());
  const [pendingMedia, setPendingMedia] = useState<Map<string, PendingMediaItem>>(new Map());
  const [pendingAttachments, setPendingAttachments] = useState<Map<string, PendingAttachmentItem>>(new Map());
  const [isRetryingAllPending, setIsRetryingAllPending] = useState(false);
  const [isCancelingAllPending, setIsCancelingAllPending] = useState(false);
  const attachmentUploadCancelMap = useRef<Map<string, () => void | Promise<void>>>(new Map());
  const attachmentFinalizeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Web only: retain the pasted Blob per pending-media id so the sticker/gif
  // upload (initial send + retry) never depends on a possibly-revoked object
  // URL. Native keyboard media are content:///file:// uris and don't need this.
  const keyboardMediaBlobRef = useRef<Map<string, Blob>>(new Map());
  // Latest closure that sends keyboard/clipboard media as a sticker/gif. Held in
  // a ref so the (stable) handleKeyboardMedia callback can invoke it without an
  // ordering cycle (the sender is declared later, alongside the picker handlers).
  const sendKeyboardMediaAsStickerRef = useRef<((file: KeyboardMediaFile) => void) | null>(null);
  // Gates the debounced outbox-persist effect: never persist (and thus never
  // overwrite the prior session's saved outbox) until hydration has read it.
  const outboxHydratedRef = useRef(false);

  // Rehydrate the durable media outbox once per launch: restore persisted
  // sticker/gif/keyboard-media sends (offline-queued or interrupted mid-send) so
  // they resume instead of being lost, then reclaim staged files orphaned by a
  // previous session. Status normalization on load:
  //   • 'sent'             -> drop (the server already has it),
  //   • 'failed'           -> keep (user retries manually),
  //   • 'queued'/'sending' -> 'queued' so the existing auto-retry re-drives it.
  // Re-drives are idempotent (clientMsgId), so a send that actually completed
  // before the kill never produces a duplicate.
  useEffect(() => {
    if (didHydrateChatOutboxThisLaunch) {
      return;
    }
    didHydrateChatOutboxThisLaunch = true;
    let cancelled = false;
    (async () => {
      let persistedMedia: Map<string, PendingMediaMessage> = new Map();
      let persistedAttachments: Map<string, PendingAttachmentMessage> = new Map();
      try {
        [persistedMedia, persistedAttachments] = await Promise.all([
          PendingMessageStorage.loadPendingMediaMessages(),
          PendingMessageStorage.loadPendingAttachmentMessages(),
        ]);
      } catch (error) {
        logger.warn('Outbox hydration load failed', error);
      }
      if (cancelled) {
        return;
      }
      // Enable persistence now that the prior session's outbox has been read.
      outboxHydratedRef.current = true;

      // Media: sent -> drop, failed -> keep, queued/sending -> queued (auto-resume).
      const hydratedMedia = new Map<string, PendingMediaItem>();
      for (const [id, item] of persistedMedia) {
        if (item.status === 'sent') {
          continue;
        }
        const status: PendingMediaItem['status'] = item.status === 'failed' ? 'failed' : 'queued';
        hydratedMedia.set(id, {
          ...(item as unknown as PendingMediaItem),
          status,
          progress: status === 'queued' ? 0 : item.progress,
        });
      }

      // Attachments: same normalization ('finalizing' = interrupted -> queued).
      const hydratedAttachments = new Map<string, PendingAttachmentItem>();
      for (const [id, item] of persistedAttachments) {
        if (item.status === 'sent') {
          continue;
        }
        const status: PendingAttachmentItem['status'] = item.status === 'failed' ? 'failed' : 'queued';
        hydratedAttachments.set(id, {
          ...(item as unknown as PendingAttachmentItem),
          status,
          progress: status === 'queued' ? 0 : item.progress,
          cancelable: false,
          cancelRequested: false,
        });
      }

      if (hydratedMedia.size > 0) {
        setPendingMedia((prev) => {
          const next = new Map(prev);
          for (const [id, item] of hydratedMedia) {
            if (!next.has(id)) {
              next.set(id, item);
            }
          }
          return next;
        });
      }
      if (hydratedAttachments.size > 0) {
        setPendingAttachments((prev) => {
          const next = new Map(prev);
          for (const [id, item] of hydratedAttachments) {
            if (!next.has(id)) {
              next.set(id, item);
            }
          }
          return next;
        });
      }

      // Reclaim staged files not owned by any resumed item. On a fresh launch no
      // live send has started yet, so the resumed ids are the full active set.
      void sweepOutboxOrphans(
        new Set<string>([...hydratedMedia.keys(), ...hydratedAttachments.keys()])
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the media + attachment outboxes (debounced) so sends survive an app
  // kill/restart. Suppressed until hydration completes so we never clobber the
  // saved outbox with an empty map on first render.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!outboxHydratedRef.current) {
        return;
      }
      // Media has no Blobs on this path, so it serializes directly.
      void PendingMessageStorage.savePendingMediaMessages(
        pendingMedia as unknown as Map<string, PendingMediaMessage>
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [pendingMedia]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!outboxHydratedRef.current) {
        return;
      }
      // Strip the non-serializable Blob (web) before persisting attachment files.
      const serializable = new Map<string, PendingAttachmentMessage>();
      for (const [id, item] of pendingAttachments) {
        serializable.set(id, {
          ...item,
          files: item.files.map(({ webFile, ...rest }) => rest),
        } as unknown as PendingAttachmentMessage);
      }
      void PendingMessageStorage.savePendingAttachmentMessages(serializable);
    }, 800);
    return () => clearTimeout(timer);
  }, [pendingAttachments]);
  const tenantMembersRequestIdRef = useRef(0);
  const teamMembersVisibleLoadCountRef = useRef(0);
  const tenantRosterRef = useRef<TeamMember[]>([]);
  const profileSnapshotRef = useRef<Map<string, TeamMember>>(new Map());
  const presenceSnapshotRef = useRef<Map<string, TeamMember>>(new Map());
  const rawProfileSnapshotRef = useRef<Map<string, TeamMember>>(new Map());
  const rawPresenceSnapshotRef = useRef<Map<string, TeamMember>>(new Map());
  const [retryingPendingMessages, setRetryingPendingMessages] = useState<Set<string>>(new Set());
  const pendingMessageBubbleOpacityRef = useRef<Map<string, Animated.Value>>(new Map());
  const pendingMessageLastStatusRef = useRef<Map<string, NonNullable<PendingMessage['status']>>>(new Map());
  const pendingRowAnimationRef = useRef<Map<string, {
    opacity: Animated.Value;
    translateX: Animated.Value;
    scale: Animated.Value;
    started: boolean;
  }>>(new Map());
  const clearAttachmentFinalizeTimer = useCallback((tempId: string) => {
    const timer = attachmentFinalizeTimers.current.get(tempId);
    if (timer) {
      clearTimeout(timer);
      attachmentFinalizeTimers.current.delete(tempId);
    }
  }, []);

  const scheduleAttachmentFinalizeCleanup = useCallback(
    (tempId: string, delayMs?: number) => {
      clearAttachmentFinalizeTimer(tempId);
      const actualDelay = resolveChatAttachmentFinalizeDelayMs(delayMs);
      const timer = setTimeout(() => {
        setPendingAttachments((prev) => {
          if (!hasPendingAttachment(prev, tempId)) {
            return prev;
          }
          const current = prev.get(tempId);
          const cleanupPlan = resolveChatAttachmentCleanupPlan(current);
          if (!cleanupPlan.shouldCleanup) {
            return prev;
          }
          const next = new Map(prev);
          next.delete(tempId);
          return next;
        });
        attachmentFinalizeTimers.current.delete(tempId);
        attachmentUploadCancelMap.current.delete(tempId);
      }, actualDelay);
      attachmentFinalizeTimers.current.set(tempId, timer);
    },
    [clearAttachmentFinalizeTimer]
  );

    const mergeRosterWithPresence = useCallback(
      (
        roster: TeamMember[],
        presenceMap: Map<string, TeamMember>,
        profileMap: Map<string, TeamMember>
      ): TeamMember[] => {
        return resolveChatRosterMergedWithPresence({
          roster,
          presenceMap,
          profileMap,
        }) as TeamMember[];
      },
      []
    );

    const buildPresenceSnapshotForRoster = useCallback((
      roster: TeamMember[],
    ): Map<string, TeamMember> => {
      return resolveChatRosterSnapshotForRoster(roster, rawPresenceSnapshotRef.current);
    }, []);

    const buildProfileSnapshotForRoster = useCallback((
      roster: TeamMember[],
    ): Map<string, TeamMember> => {
      return resolveChatRosterSnapshotForRoster(roster, rawProfileSnapshotRef.current);
    }, []);

  useEffect(() => {
    return () => {
      attachmentFinalizeTimers.current.forEach((timer) => clearTimeout(timer));
      attachmentFinalizeTimers.current.clear();
      attachmentUploadCancelMap.current.clear();
    };
  }, []);
  const [deleteConfirmState, setDeleteConfirmState] = useState<{ visible: boolean; message: any | null }>({
    visible: false,
    message: null,
  });
  const [attachmentModalVisible, setAttachmentModalVisible] = useState(false);
  const appStateRef = useRef<AppStateStatus>(
    (Platform.OS === 'web' ? 'active' : (AppState.currentState ?? 'active')) as AppStateStatus
  );
  const lastForegroundRefreshAtRef = useRef(0);
  const lastBackgroundAtRef = useRef<number | null>(null);
  const wasForegroundInteractiveRef = useRef(false);
  const [isAppActive, setIsAppActive] = useState(appStateRef.current === 'active');
  const [presenceRenderTick, setPresenceRenderTick] = useState(0);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingStatusActiveRef = useRef(false);
  const typingStatusPairRef = useRef<ChatTypingPair | null>(null);
  const typingStatusMetricsRef = useRef(createChatTypingStatusWriteRollupState());
  const replyJumpMetricRollupRef = useRef(createChatReplyJumpMetricRollupState());

  // Presence / relative-time re-render tick. Only runs while the Messages tab is
  // focused AND the app is foregrounded, so it never ticks (or backlogs timer
  // callbacks) while backgrounded or while another tab is active. It is further
  // gated to the conversation-list view: the tick only refreshes the relative
  // "last message" timestamps in the list, so there is no need to re-render the
  // entire screen every 10s while the user is reading an open conversation.
  useForegroundInterval(
    () => setPresenceRenderTick((prev) => prev + 1),
    10000,
    { enabled: isFocused && !selectedTeamMember }
  );

  // Stop video playback as soon as the Messages tab loses focus or the app is
  // backgrounded. Freezing/detaching a screen does not stop an already-playing
  // video, so without this a played video keeps decoding and buffering in the
  // background, holding CPU and memory on web and native alike.
  useEffect(() => {
    if (!isFocused || !isAppActive) {
      pauseAllChatVideos();
    }
  }, [isFocused, isAppActive]);
  const [screenData, setScreenData] = useState(Dimensions.get('window'));
  const [isUserActiveInChat, setIsUserActiveInChat] = useState(false);
  const [lastUserActivityAt, setLastUserActivityAt] = useState<number>(Date.now());
  const [presenceIdleTick, setPresenceIdleTick] = useState(0);
  const lastUserActivityRef = useRef<number>(Date.now());
  const userActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userActiveRef = useRef(false);
  const mobileInputRef = useRef<MobileChatInputRef | null>(null);
  const [conversationSummaries, setConversationSummaries] = useState<Map<string, ConversationSummary>>(new Map());
  const isSmallScreen = screenData.width < 700;
  const showKeyboardShortcuts = Platform.OS === 'web' && !isSmallScreen;
  const [pinnedChats, setPinnedChats] = useState<Record<string, number>>({});
  const [userListOptionsVisible, setUserListOptionsVisible] = useState(false);
  const [longPressedMember, setLongPressedMember] = useState<TeamMember | null>(null);
  const openAttachmentModal = useCallback(() => setAttachmentModalVisible(true), []);
  const closeAttachmentModal = useCallback(() => setAttachmentModalVisible(false), []);

  type TypingStatusWriteReason =
    | 'unmount'
    | 'inactivity'
    | 'clear_active'
    | 'pair_change'
    | 'transition_clear'
    | 'transition_activate'
    | 'timeout_clear';

  const recordTypingStatusWrite = useCallback((isTyping: boolean, reason: TypingStatusWriteReason) => {
    const payload = recordChatTypingStatusWriteRollup(
      typingStatusMetricsRef.current,
      isTyping,
      reason
    );

    if (!payload) {
      return;
    }

    logger.metric('chat.typing.status_write.rollup', payload);
  }, []);

  const recordReplyJumpMetric = useCallback(
    (
      reason: ChatReplyJumpMetricReason,
      success: boolean,
      usedHistoryLoads: number,
      source: ChatReplyJumpMetricSource
    ) => {
      const rollupPayload = recordChatReplyJumpMetricRollup(replyJumpMetricRollupRef.current, {
        reason,
        success,
        usedHistoryLoads,
        source,
        platformOS: Platform.OS,
      });

      if (!rollupPayload) {
        return;
      }

      logger.metric('chat.reply_jump.result.rollup', rollupPayload as Record<string, unknown>);
    },
    []
  );

  const flushReplyJumpMetricRollup = useCallback((flushReason: 'app-background' | 'unmount') => {
    const rollupPayload = flushChatReplyJumpMetricRollup(replyJumpMetricRollupRef.current);
    if (!rollupPayload) {
      return;
    }

    logger.metric('chat.reply_jump.result.rollup', {
      ...rollupPayload,
      flushReason,
    });
  }, []);

  const setTypingStatusForPair = useCallback(
    (pair: ChatTypingPair | null, isTyping: boolean, reason: TypingStatusWriteReason) => {
      if (!pair) {
        return;
      }

      chatService.setTypingStatus(pair.userEmail, pair.recipientEmail, isTyping);
      recordTypingStatusWrite(isTyping, reason);
    },
    [recordTypingStatusWrite]
  );

  useFrameTimingMonitor({ tag: 'chat-screen', thresholdMs: 40, sampleSize: 240 });

  // Hide Birthday FAB on the chat message screen, show on chat list
  useEffect(() => {
    try {
      setSuppressFab(!!selectedTeamMember);
    } catch {}
    return () => {
      try { setSuppressFab(false); } catch {}
    };
  }, [selectedTeamMember, setSuppressFab]);

  useEffect(() => {
    latestMessageRef.current = message;
  }, [message]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }

      flushReplyJumpMetricRollup('unmount');

      const activeTypingPair = typingStatusPairRef.current;
      setTypingStatusForPair(activeTypingPair, false, 'unmount');

      typingStatusPairRef.current = null;
      typingStatusActiveRef.current = false;

      // Phase 7: Clean up animation and auto-scroll timers
      clearTimeoutRef(animatedMessageCleanupTimerRef);
      clearTimeoutRef(autoScrollFlagTimerRef);
      clearTimeoutRef(selectMemberFocusTimerRef);
      clearTimeoutRef(forceAnchorRetryTimerRef1);
      clearTimeoutRef(forceAnchorRetryTimerRef2);
    };
  }, [flushReplyJumpMetricRollup, setTypingStatusForPair]);

  useEffect(() => {
    const clearTypingForInactivity = () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }

      const activeTypingPair = typingStatusPairRef.current;
      setTypingStatusForPair(activeTypingPair, false, 'inactivity');

      typingStatusPairRef.current = null;
      typingStatusActiveRef.current = false;
    };

    const handleAppStateChange = (nextState: AppStateStatus) => {
      appStateRef.current = nextState;
      setIsAppActive(nextState === 'active');
      if (nextState !== 'active') {
        lastBackgroundAtRef.current = Date.now();
        flushReplyJumpMetricRollup('app-background');
        clearTypingForInactivity();
      }
    };

    if (Platform.OS === 'web' && typeof AppState.addEventListener !== 'function') {
      const handleVisibilityChange = () => {
        const visible = typeof document !== 'undefined' ? document.visibilityState === 'visible' : true;
        appStateRef.current = visible ? 'active' : 'background';
        setIsAppActive(visible);
        if (!visible) {
          lastBackgroundAtRef.current = Date.now();
          flushReplyJumpMetricRollup('app-background');
          clearTypingForInactivity();
        }
      };

      handleVisibilityChange();

      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityChange);
      }

      return () => {
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', handleVisibilityChange);
        }
      };
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      if (subscription && typeof subscription.remove === 'function') {
        subscription.remove();
      }
    };
  }, [flushReplyJumpMetricRollup, setTypingStatusForPair]);

  // (moved back handler lower to avoid use-before-define)

  // Local types used in this screen
  interface TeamMemberWithChatInfo extends TeamMember {
    unreadCount: number;
    lastMessage: {
      text: string;
      timestamp: string;
      isOwnMessage: boolean;
      delivered: boolean;
      read: boolean;
    } | null;
    lastMessageTime?: string;
    summaryUpdatedAt?: string;
    pinnedSerial?: number;
  }

  // PendingMediaItem / PendingAttachmentItem now live in
  // @/components/chat/ChatPendingMedia alongside the components that render
  // them, so the shape and the rendering logic can't drift apart.

  // Chat data for selected member.
  // Keep the realtime subscription alive briefly after the app/tab is
  // backgrounded or the screen blurs, so a quick switch-away-and-back does not
  // tear down and immediately rebuild the listener (which triggers an expensive
  // reconcile). Genuine long backgrounding still tears it down to save battery.
  const chatLiveActive = useLingeringFlag(isFocused && isAppActive, 20000);
  const {
    messages = [],
    loading = false,
    error = null,
    reconnect: reconnectChat,
    hasMore = false,
    loadingMore = false,
    loadMore,
    warmNextPage,
    trimToRecentWindow,
    sendMessage,
    sendMessageWithFiles,
    sendSticker,
    sendGif,
    editMessage: editChatMessage,
    deleteMessage: deleteChatMessage,
    markMessagesReadLocally,
  } = useChat(selectedTeamMember?.id, { live: chatLiveActive });

  const CHAT_RECONNECT_TIMEOUT_MS = 8000;
  const CHAT_OPEN_LOADING_HANG_MS = 9000;
  const [showReconnectFallback, setShowReconnectFallback] = useState(false);
  const [showChatOpenHangActions, setShowChatOpenHangActions] = useState(false);
  const [isChatBootstrapGateDone, setIsChatBootstrapGateDone] = useState(false);
  // Ref mirror so the (stable) viewability handler can read the gate without
  // being recreated. While the "Loading conversation…" overlay is up (gate not
  // done) the FlashList is still mounted behind it, so read receipts / optimistic
  // read must be held until the chat is genuinely shown and interactive.
  const isChatBootstrapGateDoneRef = useRef(false);
  useEffect(() => {
    isChatBootstrapGateDoneRef.current = isChatBootstrapGateDone;
  }, [isChatBootstrapGateDone]);
  const markMessagesReadLocallyRef = useRef(markMessagesReadLocally);
  useEffect(() => {
    markMessagesReadLocallyRef.current = markMessagesReadLocally;
  }, [markMessagesReadLocally]);
  const shouldTrackReconnectFallback =
    Boolean(selectedTeamMember) &&
    Boolean(error) &&
    !loading &&
    messages.length === 0;

  useEffect(() => {
    if (!shouldTrackReconnectFallback) {
      setShowReconnectFallback(false);
      return;
    }

    const timer = setTimeout(() => {
      setShowReconnectFallback(true);
    }, CHAT_RECONNECT_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [shouldTrackReconnectFallback]);

  const handleManualReconnect = useCallback(() => {
    setShowReconnectFallback(false);
    reconnectChat();
  }, [reconnectChat]);

  const [animatedMessages, setAnimatedMessages] = useState<Set<string>>(new Set());
  const previousMessageIdsRef = useRef<Set<string>>(new Set());
  const toneBootstrapChatKeyRef = useRef<string | null>(null);
  // ── Phase 7: Cancellable timer refs for leak-free timeouts ──
  const animatedMessageCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollFlagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectMemberFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceAnchorRetryTimerRef1 = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceAnchorRetryTimerRef2 = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Special message command state
  const [showSpecialCommand, setShowSpecialCommand] = useState(false);
  const [isComposingSpecial, setIsComposingSpecial] = useState(false);
  const activeComposerDraftKey = useMemo(
    () =>
      getChatComposerDraftKey({
        id: selectedTeamMember?.id,
        email: selectedTeamMember?.email,
      }),
    [selectedTeamMember?.id, selectedTeamMember?.email]
  );

  const updateSpecialComposerState = useCallback((value: string) => {
    const nextSpecialComposerState = resolveChatSpecialComposerState(value);
    setShowSpecialCommand(nextSpecialComposerState.showSpecialCommand);
    setIsComposingSpecial(nextSpecialComposerState.isComposingSpecial);
  }, []);

  // Sticker and GIF picker state
  const [stickerGifPickerVisible, setStickerGifPickerVisible] = useState(false);
  const openStickerGifPicker = useCallback(() => setStickerGifPickerVisible(true), []);
  const closeStickerGifPicker = useCallback(() => setStickerGifPickerVisible(false), []);
  
  // Chat profile modal state
  const [chatProfileModalVisible, setChatProfileModalVisible] = useState(false);
  const openChatProfileModal = useCallback(() => setChatProfileModalVisible(true), []);
  const closeChatProfileModal = useCallback(() => setChatProfileModalVisible(false), []);

  // Message reactions state with proper typing for any emoji
  const messageReactionsRef = useRef<Map<string, { [key: string]: Set<string> }>>(new Map());
  const reactionOptimisticUntilRef = useRef<Map<string, number>>(new Map());

  // Emoji picker state for all messages
  // Sticker/GIF URLs from the configured provider (Giphy/Klipy) are already
  // direct, playable CDN URLs, so no per-platform URL resolution/fallback is
  // needed anymore (previously required for Tenor's webp/gif variants).
  // These maps and resolvers are kept as stable no-ops since ChatContext,
  // ChatMessageItem, and the viewability prefetcher still reference them.
  const [stickerUrlMap] = useState<Map<string, string>>(new Map());
  const [gifUrlMap] = useState<Map<string, string>>(new Map());
  // Centralized offline-aware loading gate (prevents empty chat UI on cold offline start)
  const { showLoading: showOfflineLoadingChat, offlineHint: offlineHintChat } = useOfflineDataGate(
    [teamMembers],
    [authLoading]
  );
  // Defer early return until after all hooks are declared

  const resolveNativeSafeStickerUrl = useCallback(async (originalUrl: string): Promise<string | null> => {
    return originalUrl;
  }, []);

  const resolveOptimizedGifUrl = useCallback(async (originalUrl: string): Promise<string> => {
    return originalUrl;
  }, []);
  const [emojiPickerVisible, setEmojiPickerVisible] = useState(false);
  const [selectedMessageForReaction, setSelectedMessageForReaction] = useState<string | null>(null);
  const [reactionPickerPosition, setReactionPickerPosition] = useState({ x: 0, y: 0 });
  const [selectedMessageForAction, setSelectedMessageForAction] = useState<any | null>(null);
  const [messageInfoModalState, setMessageInfoModalState] = useState<{
    visible: boolean;
    rows: { label: string; value: string }[];
  }>({
    visible: false,
    rows: [],
  });
  const [messageInfoExpandedRows, setMessageInfoExpandedRows] = useState<Record<string, boolean>>({});
  const [messageInfoCopiedRowKey, setMessageInfoCopiedRowKey] = useState<string | null>(null);
  const [messageInfoLastCopiedRowLabel, setMessageInfoLastCopiedRowLabel] = useState<string>('');
  const [messageInfoCopyToastNotice, setMessageInfoCopyToastNotice] = useState<string>('');
  const [showMessageInfoHint, setShowMessageInfoHint] = useState(false);
  const messageInfoCopiedResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageInfoCopyToastNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageInfoSuppressedToastCountRef = useRef(0);
  const messageInfoSuccessToastAtRef = useRef(0);
  const messageInfoErrorToastAtRef = useRef(0);
  const messageInfoCopyMetricsRef = useRef(createChatMessageInfoCopyMetricRollupState());
  const hasShownMessageInfoHintRef = useRef(false);
  const [replyingToMessage, setReplyingToMessage] = useState<ChatReplyContext | null>(null);
  const [editingMessageInfo, setEditingMessageInfo] = useState<{ id: string; originalText: string } | null>(null);
  const [pendingMessageActions, setPendingMessageActions] = useState<Set<string>>(new Set());

  const normalizeMessageId = useCallback((id: any): string => {
    return resolveChatNormalizedMessageId(id);
  }, []);

  // Authoritative send-confirmation set (chat-production-hardening, P1-2).
  // Every send/retry/re-drive that RESOLVES with a serverMessageId adds the
  // normalized id here. Because self-addressed sends are rejected at the client
  // and server write boundary, a resolved serverMessageId is proof that a durable
  // record exists for the intended (non-self) recipient — independent of whether
  // that message is on the currently loaded page. Folding this into the delivered
  // signal means a successfully-sent message is treated as confirmed and is never
  // re-driven or dead-lettered, even during a listener/pagination gap. Kept in a
  // ref (so adds never re-render on their own) with a version counter that the
  // delivered-id memo depends on to re-evaluate when a new id is confirmed.
  const confirmedServerMessageIdsRef = useRef<Set<string>>(new Set());
  const [confirmedServerMessageIdsVersion, setConfirmedServerMessageIdsVersion] = useState(0);
  const markServerMessageConfirmed = useCallback((serverMessageId: unknown) => {
    const normalized = normalizeMessageId(serverMessageId);
    if (!normalized || confirmedServerMessageIdsRef.current.has(normalized)) {
      return;
    }
    confirmedServerMessageIdsRef.current.add(normalized);
    setConfirmedServerMessageIdsVersion((version) => version + 1);
  }, [normalizeMessageId]);

  const normalizeParticipantEmail = useCallback((value: unknown): string => {
    return resolveChatNormalizedParticipantEmail(value);
  }, []);

  const sanitizeMessageText = resolveChatSanitizedMessageText;
  const sanitizeAttachmentFileName = resolveChatSanitizedAttachmentFileName;
  const sanitizeDateSeparatorLabel = resolveChatSanitizedDateSeparatorLabel;
  const getSafeDisplayInitial = resolveChatSafeDisplayInitial;

  const shouldKeepOptimisticReactions = useCallback(
    (messageId: string) => {
      if (!messageId) return false;
      const until = reactionOptimisticUntilRef.current.get(messageId);
      const keep = shouldKeepChatOptimisticReactionUntil(until, Date.now());
      if (!keep && typeof until === 'number') {
        reactionOptimisticUntilRef.current.delete(messageId);
      }
      return keep;
    },
    []
  );

  const stableMessageCacheRef = useRef<Map<string, ChatStableMessageCacheEntry<any>>>(new Map());
  const stableDisplayedMessagesRef = useRef<any[]>([]);

  const displayedMessages = useMemo(() => {
    const resolvedState = resolveChatDisplayedMessagesState({
      messages,
      previousStableCache: stableMessageCacheRef.current,
      previousDisplayedMessages: stableDisplayedMessagesRef.current,
      resolveDisplayKey: resolveChatMessageDisplayKey,
      resolveRenderSignature: resolveChatMessageRenderSignature,
    });

    stableMessageCacheRef.current = resolvedState.nextStableCache;
    stableDisplayedMessagesRef.current = resolvedState.displayedMessages;
    return resolvedState.displayedMessages;
  }, [messages]);

  useEffect(() => {
    const positions = messagePositionsRef.current;
    const positionIds = Object.keys(positions);
    if (!positionIds.length) {
      return;
    }

    if (!Array.isArray(displayedMessages) || displayedMessages.length === 0) {
      messagePositionsRef.current = {};
      return;
    }

    // Avoid expensive pruning on every small update; only compact when map has meaningful drift.
    if (!shouldCompactChatMessagePositions(positionIds.length, displayedMessages.length)) {
      return;
    }

    const validIds = resolveChatDisplayedMessageIdSet(displayedMessages, (message: any) => {
      return normalizeMessageId(message?.id);
    });

    messagePositionsRef.current = resolveChatPrunedMessagePositions(positions, validIds);
  }, [displayedMessages, normalizeMessageId]);

  // Bound the per-message auxiliary maps to the live window. These refs are
  // otherwise only cleared when the conversation changes, so over a long-lived
  // conversation (with in-memory window trimming) they would accumulate entries
  // for messages that are no longer rendered. Pruning is gated with hysteresis
  // so it stays off the hot path and only runs once after the window shrinks.
  useEffect(() => {
    if (!Array.isArray(displayedMessages)) {
      return;
    }

    const displayedCount = displayedMessages.length;
    const animatedSize = globalAnimatedMessages.current.size;
    const reactionsSize = messageReactionsRef.current.size;
    const optimisticSize = reactionOptimisticUntilRef.current.size;

    if (Math.max(animatedSize, reactionsSize, optimisticSize) <= displayedCount + 96) {
      return;
    }

    const validIds = resolveChatDisplayedMessageIdSet(displayedMessages, (message: any) => {
      return normalizeMessageId(message?.id);
    });

    // Reaction state for a message the user just acted on is always for a
    // visible (retained) message, so it is never pruned here.
    pruneMapByKeySet(messageReactionsRef.current, validIds);
    pruneMapByKeySet(reactionOptimisticUntilRef.current, validIds);

    if (animatedSize > displayedCount + 96) {
      for (const id of Array.from(globalAnimatedMessages.current)) {
        if (!validIds.has(id)) {
          globalAnimatedMessages.current.delete(id);
        }
      }
    }
  }, [displayedMessages, normalizeMessageId]);

  const getMessageItemType = resolveChatMessageListItemType;

  const getMessageKey = useCallback(
    (item: any, index: number) => {
      return resolveChatMessageListItemKey({
        item,
        index,
        resolveDisplayKey: resolveChatMessageDisplayKey,
      });
    },
    []
  );

  const overrideMessageLayout = useCallback(
    (layout: { size?: number; span?: number }, item: any, _index: number) => {
      const type = getMessageItemType(item);
      const size = resolveChatMessageLayoutSize(type);
      if (typeof size === 'number') {
        layout.size = size;
      }
    },
    [getMessageItemType]
  );

  useEffect(() => {
    if (!selectedTeamMember?.id) {
      setLocalMessageReactions(() => new Map());
      return;
    }

    const visibleIds = resolveChatDisplayedMessageIdSet(displayedMessages, (msg: any) => {
      return normalizeMessageId(msg?.id);
    });

    setLocalMessageReactions(prev => {
      return resolveChatPrunedLocalMessageReactions(prev, visibleIds);
    });
  }, [displayedMessages, selectedTeamMember?.id]);

  // Formatting guide state
  const [showFormattingGuide, setShowFormattingGuide] = useState(false);
  const toggleFormattingGuide = useCallback(() => {
    setShowFormattingGuide(prev => !prev);
  }, []);
  const hideFormattingGuide = useCallback(() => {
    setShowFormattingGuide(false);
  }, []);

  // Sound throttling state
  const lastSoundPlayedRef = useRef<number>(0);
  const messageTonePlayerRef = useRef<ReturnType<typeof createAudioPlayer> | null>(null);
  const messageToneInitPromiseRef = useRef<Promise<void> | null>(null);
  const messageToneAudioModeReadyRef = useRef(false);
  const messageToneCooldownUntilRef = useRef<number>(0);
  const messageToneEligibleSinceRef = useRef<number>(Date.now());
  const SOUND_THROTTLE_MS = 450;
  const TONE_HISTORICAL_TIMESTAMP_GRACE_MS = 8000;

  // Global animation tracking to prevent multiple animations per message
  const globalAnimatedMessages = useRef<Set<string>>(new Set());
  // Tracks which divider keys (unread / new-messages separators) have already
  // played their entrance animation, so they don't replay on FlashList row
  // recycling.
  const animatedDividerKeysRef = useRef<Set<string>>(new Set());

  const ensureMessageTonePlayer = useCallback(async () => {
    if (messageTonePlayerRef.current) {
      return messageTonePlayerRef.current;
    }

    if (messageToneInitPromiseRef.current) {
      await messageToneInitPromiseRef.current;
      return messageTonePlayerRef.current;
    }

    const initializeMessageTonePlayer = async () => {
      if (!messageToneAudioModeReadyRef.current) {
        try {
          await setAudioModeAsync({
            // Respect the hardware silent / mute switch for the in-chat tune,
            // exactly like big chat apps: when the device is silenced, the
            // in-conversation message sound stays quiet (push notifications are
            // handled separately by the OS). Setting this to `false` is the
            // key difference from a generic media player.
            playsInSilentMode: false,
            allowsRecording: false,
            shouldPlayInBackground: false,
            // Briefly duck other audio (music/podcasts) for the short tone
            // instead of pausing it.
            interruptionMode: 'duckOthers',
            interruptionModeAndroid: 'duckOthers',
            shouldRouteThroughEarpiece: false,
          });
          messageToneAudioModeReadyRef.current = true;
        } catch (error) {
          logger.warn('Chat: failed to configure audio mode for message tone', error);
        }
      }

      try {
        const player = createAudioPlayer(MESSAGE_TUNE_SOURCE, 160);
        player.loop = false;
        player.muted = false;
        player.volume = Platform.OS === 'web' ? 0.7 : 0.62;
        messageTonePlayerRef.current = player;
      } catch (error) {
        logger.warn('Chat: failed to initialize message tone player', error);
      }
    };

    messageToneInitPromiseRef.current = initializeMessageTonePlayer().finally(() => {
      messageToneInitPromiseRef.current = null;
    });

    await messageToneInitPromiseRef.current;
    return messageTonePlayerRef.current;
  }, []);

  const playMessageSoundNow = useCallback(async () => {
    try {
      const player = await ensureMessageTonePlayer();
      if (!player) {
        return;
      }
      try {
        void player.seekTo(0);
      } catch {
        // Ignore seek failures; attempt play anyway.
      }
      player.play();
    } catch (error) {
      logger.warn('Chat: message tone playback failed', error);
    }
  }, [ensureMessageTonePlayer]);

  const playMessageSound = useCallback(() => {
    const now = Date.now();
    if (now - lastSoundPlayedRef.current < SOUND_THROTTLE_MS) {
      return;
    }
    lastSoundPlayedRef.current = now;

    void playMessageSoundNow();
  }, [playMessageSoundNow]);

  // sendMessageNotification is defined after effectiveUser to avoid TDZ
  const [selectedFiles, setSelectedFiles] = useState<any[]>([]);
  const selectedFilesRef = useRef<any[]>([]);
  const [isChatDropActive, setIsChatDropActive] = useState(false);
  const [skippedPreviewFiles, setSkippedPreviewFiles] = useState<string[]>([]);
  const MAX_SKIPPED_PREVIEW_ITEMS = 30;
  
  // Media prefetch cache
  const prefetchedUrisRef = useRef<Set<string>>(new Set());
  // Bound the dedupe set so it can't grow unbounded as more media scrolls into
  // view over a long-lived chat session.
  const MAX_PREFETCHED_URIS = 300;
  const prefetchUri = useCallback(async (uri?: string) => {
    if (!uri) return;
    if (prefetchedUrisRef.current.has(uri)) return;
    try {
      await Image.prefetch(uri);
      prefetchedUrisRef.current.add(uri);
      if (prefetchedUrisRef.current.size > MAX_PREFETCHED_URIS) {
        const oldestUri = prefetchedUrisRef.current.values().next().value;
        if (oldestUri !== undefined) {
          prefetchedUrisRef.current.delete(oldestUri);
        }
      }
    } catch {}
  }, []);
  const [filePreviewVisible, setFilePreviewVisible] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const easedUploadProgress = useEasedUploadProgress(uploadProgress, {
    isActive: isUploading,
    smoothingPerSecond: 10,
    minStepPercent: 0.15,
    completionSnapThresholdPercent: 99.2,
    nearCompletionBoostStartPercent: 96,
    nearCompletionBoostMultiplier: 1.35,
  });
  const [imageViewerVisible, setImageViewerVisible] = useState(false);
  const [selectedImageUri, setSelectedImageUri] = useState<string>('');
  const [lastViewedRemoteImage, setLastViewedRemoteImage] = useState<string | undefined>(undefined);
  const [brokenFileUrls, setBrokenFileUrls] = useState<Set<string>>(new Set());
  const brokenFileUrlsRef = useRef<Set<string>>(new Set());
  const [networkErrorUrls, setNetworkErrorUrls] = useState<Set<string>>(new Set());
  const downloadingUrlsRef = useRef<Set<string>>(new Set());
  const [fileValidationCache] = useState<Map<string, number>>(new Map()); // Cache file validation results
  const fileValidationInFlightRef = useRef(false);
  const fileValidationLastRunAtRef = useRef(0);
  const [showImageShareModal, setShowImageShareModal] = useState(false);
  const closeImageViewer = useCallback(() => setImageViewerVisible(false), []);
  const openImageShareModal = useCallback(() => setShowImageShareModal(true), []);
  const closeImageShareModal = useCallback(() => setShowImageShareModal(false), []);
  const clearMessageInfoCopiedResetTimer = useCallback(() => {
    clearTimeoutRef(messageInfoCopiedResetTimerRef);
  }, []);

  const scheduleMessageInfoCopiedReset = useCallback((callback: () => void) => {
    scheduleTimeoutRef(messageInfoCopiedResetTimerRef, callback, MESSAGE_INFO_COPIED_RESET_DELAY_MS);
  }, []);

  const clearMessageInfoCopyToastNoticeTimer = useCallback(() => {
    clearTimeoutRef(messageInfoCopyToastNoticeTimerRef);
  }, []);

  const resetMessageInfoCopyToastNoticeState = useCallback(() => {
    setMessageInfoCopyToastNotice('');
    messageInfoSuppressedToastCountRef.current = 0;
    clearMessageInfoCopyToastNoticeTimer();
  }, [clearMessageInfoCopyToastNoticeTimer]);

  const scheduleMessageInfoCopyToastNoticeReset = useCallback((delayMs: number) => {
    scheduleTimeoutRef(messageInfoCopyToastNoticeTimerRef, () => {
      setMessageInfoCopyToastNotice('');
      messageInfoSuppressedToastCountRef.current = 0;
    }, delayMs);
  }, []);

  const closeMessageInfoModal = useCallback(() => {
    clearMessageInfoCopiedResetTimer();

    setMessageInfoCopiedRowKey(null);
    setMessageInfoLastCopiedRowLabel('');
    resetMessageInfoCopyToastNoticeState();
    setMessageInfoExpandedRows({});
    setShowMessageInfoHint(false);
    setMessageInfoModalState({
      visible: false,
      rows: [],
    });
  }, [clearMessageInfoCopiedResetTimer, resetMessageInfoCopyToastNoticeState]);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    if (typeof UIManager.setLayoutAnimationEnabledExperimental !== 'function') {
      return;
    }

    try {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    } catch {}
  }, []);

  useEffect(() => {
    return () => {
      clearMessageInfoCopiedResetTimer();

      clearMessageInfoCopyToastNoticeTimer();
    };
  }, [clearMessageInfoCopiedResetTimer, clearMessageInfoCopyToastNoticeTimer]);

  const triggerMessageInfoHaptic = useCallback((type: 'copy' | 'toggle' | 'error') => {
    if (Platform.OS === 'web') {
      return;
    }

    try {
      if (type === 'copy') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      }

      if (type === 'error') {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }

      void Haptics.selectionAsync();
    } catch {}
  }, []);

  const showMessageInfoCopyToast = useCallback((
    type: 'success' | 'error',
    source: 'row' | 'all',
    rowLabel?: string
  ) => {
    const now = Date.now();
    const targetRef =
      type === 'success' ? messageInfoSuccessToastAtRef : messageInfoErrorToastAtRef;
    const cooldownState = resolveChatMessageInfoCopyToastCooldownState(now, targetRef.current, type);
    const isWebPlatform = Platform.OS === 'web';
    const suppressionPlan = resolveChatMessageInfoCopyToastSuppressionPlan(
      cooldownState,
      messageInfoSuppressedToastCountRef.current,
      isWebPlatform
    );

    if (suppressionPlan.shouldSuppress) {
      messageInfoSuppressedToastCountRef.current = suppressionPlan.nextSuppressedCount;
      if (isWebPlatform && suppressionPlan.noticeText) {
        setMessageInfoCopyToastNotice(suppressionPlan.noticeText);
        scheduleMessageInfoCopyToastNoticeReset(suppressionPlan.noticeClearDelayMs);
      }
      return;
    }

    targetRef.current = now;
    messageInfoSuppressedToastCountRef.current = suppressionPlan.nextSuppressedCount;
    resetMessageInfoCopyToastNoticeState();
    const toastPayload = resolveChatMessageInfoCopyToastPayload(type, source, rowLabel);
    Toast.show({
      type,
      text1: toastPayload.title,
      text2: toastPayload.detail,
      position: 'top',
    });
  }, [resetMessageInfoCopyToastNoticeState, scheduleMessageInfoCopyToastNoticeReset]);

  const recordMessageInfoCopyMetric = useCallback((
    source: 'row' | 'all',
    outcome: 'success' | 'error'
  ) => {
    const payload = recordChatMessageInfoCopyMetricRollup(
      messageInfoCopyMetricsRef.current,
      source,
      outcome
    );

    if (!payload) {
      return;
    }

    logger.metric('chat.message_info.copy.rollup', payload);
  }, []);

  const toggleMessageInfoRowExpanded = useCallback((rowKey: string) => {
    triggerMessageInfoHaptic('toggle');
    if (Platform.OS !== 'web') {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }
    setMessageInfoExpandedRows((currentState) => ({
      ...currentState,
      [rowKey]: !currentState[rowKey],
    }));
  }, [triggerMessageInfoHaptic]);

  const handleMessageInfoRowCopy = useCallback(async (rowKey: string, value: string, rowLabel?: string) => {
    const normalizedValue = typeof value === 'string' ? value.trim() : '';
    if (!normalizedValue) {
      return;
    }

    try {
      await Clipboard.setStringAsync(normalizedValue);

      const copySuccessPlan = resolveChatMessageInfoCopySuccessPlan('row', rowKey, rowLabel);
      setMessageInfoCopiedRowKey(copySuccessPlan.selection.copiedRowKey);
      setMessageInfoLastCopiedRowLabel(copySuccessPlan.selection.copiedRowLabel);

      scheduleMessageInfoCopiedReset(() => {
        setMessageInfoCopiedRowKey(copySuccessPlan.resetPayload.nextRowKey);
        setMessageInfoLastCopiedRowLabel(copySuccessPlan.resetPayload.nextRowLabel);
      });

      triggerMessageInfoHaptic('copy');
      recordMessageInfoCopyMetric('row', 'success');
      showMessageInfoCopyToast('success', 'row', copySuccessPlan.selection.copiedRowLabel);
    } catch {
      triggerMessageInfoHaptic('error');
      recordMessageInfoCopyMetric('row', 'error');

      showMessageInfoCopyToast('error', 'row');
    }
  }, [recordMessageInfoCopyMetric, scheduleMessageInfoCopiedReset, showMessageInfoCopyToast, triggerMessageInfoHaptic]);

  const resolveMessageInfoRowBadge = resolveChatMessageInfoRowBadge;
  const resolveMessageInfoRowValueParts = resolveChatMessageInfoRowValueParts;

  const messageInfoExpandableRowKeys = useMemo(() => {
    if (!Array.isArray(messageInfoModalState.rows) || messageInfoModalState.rows.length <= 0) {
      return [] as string[];
    }

    return messageInfoModalState.rows.reduce<string[]>((keys, row, index) => {
      const rowKey = `${row.label}:${index}`;
      const valueParts = resolveMessageInfoRowValueParts(row.value);
      if (valueParts.details.length > 0) {
        keys.push(rowKey);
      }
      return keys;
    }, []);
  }, [messageInfoModalState.rows, resolveMessageInfoRowValueParts]);

  const areAllMessageInfoDetailsExpanded = useMemo(() => {
    if (messageInfoExpandableRowKeys.length <= 0) {
      return false;
    }

    return messageInfoExpandableRowKeys.every((rowKey) => Boolean(messageInfoExpandedRows[rowKey]));
  }, [messageInfoExpandableRowKeys, messageInfoExpandedRows]);

  const messageInfoCopyFeedbackLabel = useMemo(() => {
    return resolveChatMessageInfoCopyFeedbackLabel(
      messageInfoCopiedRowKey,
      messageInfoLastCopiedRowLabel
    );
  }, [messageInfoCopiedRowKey, messageInfoLastCopiedRowLabel]);

  const messageInfoCopyFeedbackSourceLabel = useMemo(() => {
    return resolveChatMessageInfoCopyFeedbackSourceLabel(messageInfoCopiedRowKey);
  }, [messageInfoCopiedRowKey]);

  const messageInfoCopyFeedbackSourcePalette = useMemo(() => {
    return resolveChatMessageInfoCopyFeedbackSourcePalette(
      messageInfoCopyFeedbackSourceLabel,
      isDarkMode
    );
  }, [isDarkMode, messageInfoCopyFeedbackSourceLabel]);

  const messageInfoCopyFeedbackSourceBadgeText = useMemo(() => {
    return resolveChatMessageInfoCopyFeedbackSourceBadgeText(messageInfoCopyFeedbackSourceLabel);
  }, [messageInfoCopyFeedbackSourceLabel]);

  const messageInfoCopyFeedbackSourceAccessibilityLabel = useMemo(() => {
    return resolveChatMessageInfoCopyFeedbackSourceAccessibilityLabel(messageInfoCopyFeedbackSourceLabel);
  }, [messageInfoCopyFeedbackSourceLabel]);

  const messageInfoCopyFeedbackAccessibilityLabel = useMemo(() => {
    return resolveChatMessageInfoCopyFeedbackAccessibilityLabel(
      messageInfoCopyFeedbackLabel,
      messageInfoCopyFeedbackSourceLabel
    );
  }, [messageInfoCopyFeedbackLabel, messageInfoCopyFeedbackSourceLabel]);

  const messageInfoCopyToastNoticeAccessibilityLabel = useMemo(() => {
    return resolveChatMessageInfoToastCooldownAccessibilityLabel(messageInfoCopyToastNotice);
  }, [messageInfoCopyToastNotice]);

  const toggleAllMessageInfoDetailsExpanded = useCallback(() => {
    if (messageInfoExpandableRowKeys.length <= 0) {
      return;
    }

    triggerMessageInfoHaptic('toggle');
    if (Platform.OS !== 'web') {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    }

    setMessageInfoExpandedRows((currentState) => {
      const shouldExpand = !messageInfoExpandableRowKeys.every((rowKey) => Boolean(currentState[rowKey]));
      const nextState = { ...currentState };

      messageInfoExpandableRowKeys.forEach((rowKey) => {
        if (shouldExpand) {
          nextState[rowKey] = true;
          return;
        }

        delete nextState[rowKey];
      });

      return nextState;
    });
  }, [messageInfoExpandableRowKeys, triggerMessageInfoHaptic]);

  const handleMessageInfoCopyAll = useCallback(async () => {
    if (!Array.isArray(messageInfoModalState.rows) || messageInfoModalState.rows.length <= 0) {
      return;
    }

    const normalizedText = formatChatMessageInfoRowsForClipboard(messageInfoModalState.rows);
    if (!normalizedText) {
      return;
    }

    try {
      await Clipboard.setStringAsync(normalizedText);

      const copySuccessPlan = resolveChatMessageInfoCopySuccessPlan('all');
      setMessageInfoCopiedRowKey(copySuccessPlan.selection.copiedRowKey);
      setMessageInfoLastCopiedRowLabel(copySuccessPlan.selection.copiedRowLabel);

      scheduleMessageInfoCopiedReset(() => {
        setMessageInfoCopiedRowKey(copySuccessPlan.resetPayload.nextRowKey);
        setMessageInfoLastCopiedRowLabel(copySuccessPlan.resetPayload.nextRowLabel);
      });

      triggerMessageInfoHaptic('copy');
      recordMessageInfoCopyMetric('all', 'success');
      showMessageInfoCopyToast('success', 'all');
    } catch {
      triggerMessageInfoHaptic('error');
      recordMessageInfoCopyMetric('all', 'error');
      showMessageInfoCopyToast('error', 'all');
    }
  }, [messageInfoModalState.rows, recordMessageInfoCopyMetric, scheduleMessageInfoCopiedReset, showMessageInfoCopyToast, triggerMessageInfoHaptic]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return;
    }

    if (!messageInfoModalState.visible) {
      return;
    }

    const handleMessageInfoShortcut = (event: KeyboardEvent) => {
      const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
      const targetTagName = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : '';
      const isTargetEditable =
        targetTagName === 'input' ||
        targetTagName === 'textarea' ||
        targetTagName === 'select' ||
        target?.isContentEditable === true;

      const shortcutAction = resolveChatMessageInfoShortcutAction({
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isTargetEditable,
        hasExpandableRows: messageInfoExpandableRowKeys.length > 0,
      });

      if (!shortcutAction) {
        return;
      }

      event.preventDefault();

      if (shortcutAction === 'close') {
        closeMessageInfoModal();
        return;
      }

      if (shortcutAction === 'copy-all') {
        void handleMessageInfoCopyAll();
        return;
      }

      toggleAllMessageInfoDetailsExpanded();
    };

    window.addEventListener('keydown', handleMessageInfoShortcut);
    return () => {
      window.removeEventListener('keydown', handleMessageInfoShortcut);
    };
  }, [
    closeMessageInfoModal,
    handleMessageInfoCopyAll,
    messageInfoExpandableRowKeys.length,
    messageInfoModalState.visible,
    toggleAllMessageInfoDetailsExpanded,
  ]);

  useEffect(() => {
    if (!messageInfoModalState.visible) {
      return;
    }

    const validRowKeys = new Set(
      messageInfoModalState.rows.map((row, index) => `${row.label}:${index}`)
    );
    setMessageInfoExpandedRows((currentState) => {
      const nextState: Record<string, boolean> = {};
      Object.entries(currentState).forEach(([rowKey, isExpanded]) => {
        if (!isExpanded || !validRowKeys.has(rowKey)) {
          return;
        }

        nextState[rowKey] = true;
      });
      return nextState;
    });
  }, [messageInfoModalState.rows, messageInfoModalState.visible]);

  useEffect(() => {
    brokenFileUrlsRef.current = brokenFileUrls;
  }, [brokenFileUrls]);

  const syncMessageReactions = useCallback(
    (prev: Map<string, { [key: string]: Set<string> }>, next: Map<string, { [key: string]: Set<string> }>) => {
      const changedIds = new Set<string>();

      next.forEach((value, key) => {
        if (prev.get(key) !== value) {
          changedIds.add(key);
        }
      });

      prev.forEach((_value, key) => {
        if (!next.has(key)) {
          changedIds.add(key);
        }
      });

      changedIds.forEach((messageId) => {
        setMessageReactionsForMessage(messageId, next.get(messageId));
      });
    },
    []
  );

  const setLocalMessageReactions = useCallback(
    (updater: (prev: Map<string, { [key: string]: Set<string> }>) => Map<string, { [key: string]: Set<string> }>) => {
      const prev = messageReactionsRef.current;
      const next = updater(prev);
      if (next === prev) {
        return;
      }
      messageReactionsRef.current = next;
      syncMessageReactions(prev, next);
    },
    [syncMessageReactions]
  );

  useEffect(() => {
    setEditingMessageId(editingMessageInfo?.id ?? null);
  }, [editingMessageInfo?.id]);

  // Intentionally avoid tying list re-renders to reactions/editing to prevent media interruptions.
  
  // ——— Viewability/prefetch dependencies kept in refs so the handler identity stays stable ———
  const effectiveUser = user || currentUser;
  const effectiveUserEmail = useMemo(() => {
    const candidate = effectiveUser?.email || user?.email || currentUser?.email;
    return typeof candidate === 'string' ? candidate.toLowerCase() : '';
  }, [effectiveUser?.email, user?.email, currentUser?.email]);
  const selectedMemberEmail = useMemo(() => {
    const email = selectedTeamMember?.email;
    return typeof email === 'string' ? email.toLowerCase() : '';
  }, [selectedTeamMember?.email]);

  const teamMembersByEmail = useMemo(() => {
    const map = new Map<string, TeamMember>();
    teamMembers.forEach((member) => {
      const email = normalizeParticipantEmail(member?.email);
      if (email && !map.has(email)) {
        map.set(email, member);
      }
    });
    return map;
  }, [teamMembers, normalizeParticipantEmail]);

  const teamMembersWithChatInfoByEmail = useMemo(() => {
    const map = new Map<string, TeamMember>();
    teamMembersWithChatInfo.forEach((member: any) => {
      const email = normalizeParticipantEmail(member?.email);
      if (email && !map.has(email)) {
        map.set(email, member as TeamMember);
      }
    });
    return map;
  }, [teamMembersWithChatInfo, normalizeParticipantEmail]);

  const teamMembersWithChatInfoById = useMemo(() => {
    const map = new Map<string, TeamMember>();
    teamMembersWithChatInfo.forEach((member: any) => {
      const id = member?.id != null ? String(member.id) : '';
      if (id && !map.has(id)) {
        map.set(id, member as TeamMember);
      }
    });
    return map;
  }, [teamMembersWithChatInfo]);

  const displayedMessagesRef = useRef<any[]>([]);
  const displayedMessageIndexRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const displayed = displayedMessages;
    if (displayed.length) {
      const memberId = selectedTeamMember?.id;
      const userEmail = effectiveUser?.email;
      if (memberId && userEmail) {
        const mediaToWarm: { remoteUrl: string; fileName?: string }[] = [];
        const seenUrls = new Set<string>();
        const maxWarmTargets = Platform.OS === 'web' ? 6 : 10;
        const maxWarmScanMessages = Platform.OS === 'web' ? 40 : 70;
        const minIndex = Math.max(0, displayed.length - maxWarmScanMessages);

        for (let idx = displayed.length - 1; idx >= minIndex && mediaToWarm.length < maxWarmTargets; idx -= 1) {
          const msg = displayed[idx];
          if (!Array.isArray(msg?.attachments)) {
            continue;
          }

          for (const attachment of msg.attachments) {
            const url = typeof attachment?.url === 'string' ? attachment.url : '';
            if (!url || url.startsWith('file://') || seenUrls.has(url)) {
              continue;
            }
            seenUrls.add(url);
            mediaToWarm.push({ remoteUrl: url, fileName: attachment?.fileName });
            if (mediaToWarm.length >= maxWarmTargets) {
              break;
            }
          }
        }

        if (mediaToWarm.length) {
          Promise.allSettled(
            mediaToWarm.map(({ remoteUrl, fileName }) =>
              chatCacheService.getMediaForDownload(remoteUrl, fileName, undefined, 'low').catch(() => undefined)
            )
          ).catch(() => undefined);
        }
      }
    }

    const indexMap = new Map<string, number>();
    displayed.forEach((message: any, index: number) => {
      const id = normalizeMessageId(message?.id);
      if (id) {
        indexMap.set(id, index);
      }
    });
    displayedMessageIndexRef.current = indexMap;

    displayedMessagesRef.current = displayed;
  }, [displayedMessages, selectedTeamMember?.id, effectiveUser?.email, normalizeMessageId]);

  const normalizedConversationSearchQuery = useMemo(
    () => normalizeChatConversationSearchQuery(conversationSearchDebouncedQuery),
    [conversationSearchDebouncedQuery]
  );
  useEffect(() => {
    conversationSearchQueryRef.current = conversationSearchQuery;
  }, [conversationSearchQuery]);

  useEffect(() => {
    if (!conversationSearchVisible) {
      setConversationSearchDebouncedQuery(conversationSearchQuery);
      return;
    }

    const normalizedQuery = normalizeChatConversationSearchQuery(conversationSearchQuery);
    if (!normalizedQuery) {
      setConversationSearchDebouncedQuery('');
      return;
    }

    const debounceTimer = setTimeout(() => {
      setConversationSearchDebouncedQuery(conversationSearchQuery);
    }, CONVERSATION_SEARCH_QUERY_DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceTimer);
    };
  }, [conversationSearchQuery, conversationSearchVisible]);

  useEffect(() => {
    normalizedConversationSearchQueryRef.current = normalizedConversationSearchQuery;
  }, [normalizedConversationSearchQuery]);

  const conversationSearchMatchIds = useMemo(
    () =>
      resolveChatConversationSearchMatchIds(
        displayedMessages,
        normalizedConversationSearchQuery,
        normalizeMessageId,
        conversationSearchScope
      ),
    [
      conversationSearchScope,
      displayedMessages,
      normalizeMessageId,
      normalizedConversationSearchQuery,
    ]
  );
  useEffect(() => {
    conversationSearchMatchIdsRef.current = conversationSearchMatchIds;
  }, [conversationSearchMatchIds]);

  const conversationSearchMatchCollections = useMemo(() => {
    return resolveChatConversationSearchMatchCollections(conversationSearchMatchIds);
  }, [conversationSearchMatchIds]);

  const conversationSearchMatchIdSet = conversationSearchMatchCollections.matchIdSet;
  const conversationSearchMatchIndexById =
    conversationSearchMatchCollections.matchIndexById;

  // ── Phase 4: keep renderMessageItem refs in sync ──
  useEffect(() => {
    conversationSearchMatchIdSetRef.current = conversationSearchMatchIdSet;
    conversationSearchMatchIndexByIdRef.current = conversationSearchMatchIndexById;
  }, [conversationSearchMatchIdSet, conversationSearchMatchIndexById]);
  useEffect(() => {
    conversationSearchHighlightMessageIdRef.current = conversationSearchHighlightMessageId;
  }, [conversationSearchHighlightMessageId]);
  const conversationSearchScopeMatchCounts = useMemo(
    () =>
      resolveChatConversationSearchScopeMatchCounts(
        displayedMessages,
        normalizedConversationSearchQuery,
        normalizeMessageId
      ),
    [displayedMessages, normalizeMessageId, normalizedConversationSearchQuery]
  );

  const conversationSearchCounterLabel = useMemo(() => {
    return resolveChatConversationSearchCounterLabel({
      normalizedQuery: normalizedConversationSearchQuery,
      matchCount: conversationSearchMatchIds.length,
      activeIndex: conversationSearchActiveIndex,
      isLoadingHistory: isConversationSearchHistoryLoading,
    });
  }, [
    conversationSearchActiveIndex,
    conversationSearchMatchIds.length,
    isConversationSearchHistoryLoading,
    normalizedConversationSearchQuery,
  ]);

  const conversationSearchActiveSnippet = useMemo(
    () =>
      resolveChatConversationSearchSnippet(
        displayedMessages,
        conversationSearchMatchIds,
        conversationSearchActiveIndex,
        normalizedConversationSearchQuery,
        normalizeMessageId,
        38,
        conversationSearchScope
      ),
    [
      conversationSearchActiveIndex,
      conversationSearchMatchIds,
      conversationSearchScope,
      displayedMessages,
      normalizeMessageId,
      normalizedConversationSearchQuery,
    ]
  );

  const getDisplayedMessageById = useCallback((messageId?: unknown) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) {
      return null;
    }

    const index = displayedMessageIndexRef.current.get(normalizedMessageId);
    if (typeof index !== 'number' || index < 0) {
      return null;
    }

    const message = displayedMessagesRef.current[index];
    if (!message) {
      return null;
    }

    return normalizeMessageId(message?.id) === normalizedMessageId ? message : null;
  }, [normalizeMessageId]);

  const selectedPartnerEmailRef = useRef<string | null>(null);
  useEffect(() => {
    selectedPartnerEmailRef.current = selectedTeamMember?.email?.toLowerCase?.() ?? null;
  }, [selectedTeamMember?.email]);

  const effectiveUserEmailRef = useRef<string | null>(null);
  useEffect(() => {
    effectiveUserEmailRef.current = effectiveUser?.email?.toLowerCase?.() ?? null;
  }, [effectiveUser?.email]);

  const stickerUrlMapRef = useRef(stickerUrlMap);
  useEffect(() => { stickerUrlMapRef.current = stickerUrlMap; }, [stickerUrlMap]);

  const gifUrlMapRef = useRef(gifUrlMap);
  useEffect(() => { gifUrlMapRef.current = gifUrlMap; }, [gifUrlMap]);

  const prefetchUriRef = useRef(prefetchUri);
  useEffect(() => { prefetchUriRef.current = prefetchUri; }, [prefetchUri]);

  const warmNextPageRef = useRef(warmNextPage);
  useEffect(() => { warmNextPageRef.current = warmNextPage; }, [warmNextPage]);

  const resolveNativeSafeStickerUrlRef = useRef(resolveNativeSafeStickerUrl);
  useEffect(() => { resolveNativeSafeStickerUrlRef.current = resolveNativeSafeStickerUrl; }, [resolveNativeSafeStickerUrl]);

  const resolveOptimizedGifUrlRef = useRef(resolveOptimizedGifUrl);
  useEffect(() => { resolveOptimizedGifUrlRef.current = resolveOptimizedGifUrl; }, [resolveOptimizedGifUrl]);

  const paginationProfile = useMemo(
    () => getChatPaginationProfile(Platform.OS === 'web' ? 'web' : 'native'),
    []
  );
  const requestOlderMessagesRef = useRef<((reason: 'auto' | 'manual') => Promise<void>) | null>(null);
  const TOP_AUTO_LOAD_THRESHOLD = 2;
  const TOP_PREFETCH_THRESHOLD = paginationProfile.prefetchThreshold;
  const loadOlderLockRef = useRef(false);
  const loadOlderAttemptsRef = useRef(0);
  const reachedConversationStartRef = useRef(false);
  const [reachedConversationStart, setReachedConversationStart] = useState(false);
  const hasMoreRef = useRef(hasMore);
  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);
  const autoLoadAnchorRef = useRef<string | null>(null);
  const allowTopAutoPaginationRef = useRef(false);
  const shouldUseManualAnchorPreservation = Platform.OS === 'web';

  // Scroll + anchor state shared across pagination and sticky headers
  const scrollViewRef = useRef<ScrollView>(null);
  const flatListRef = useRef<FlashList<any>>(null);
  type TelemetryProfile = Awaited<ReturnType<typeof chatCacheService.getTelemetryContext>>;
  const concurrencyProfileRef = useRef<TelemetryProfile | null>(null);
  const renderTraceRef = useRef<ChatRenderTraceState | null>(null);
  const prevSettlementRef = useRef<boolean | null>(null);

  const [stickyDateVisible, setStickyDateVisible] = useState(false);
  const [stickyDateText, setStickyDateText] = useState('');
  const messagePositionsRef = useRef<{ [key: string]: { y: number; height: number; date: string } }>({});
  const isScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollToBottomRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showReplyJumpToLatest, setShowReplyJumpToLatest] = useState(false);
  const [replyJumpHighlightMessageId, setReplyJumpHighlightMessageId] = useState<string | null>(null);
  const replyJumpHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unseenCount, setUnseenCount] = useState(0);
  const lastTailIdRef = useRef<string | null>(null);
  const contentHeightRef = useRef(0);
  const layoutHeightRef = useRef(0);
  const lastScrollOffsetRef = useRef(0);
  const topVisibleMessageRef = useRef<{ id: string; index: number } | null>(null);
  const stickyDateSourceMessageIdRef = useRef<string | null>(null);
  const pendingPrependAnchorRef =
    useRef<ChatPendingPrependAnchorRefValue | null>(null);
  const lastAnchoredAtRef = useRef<number>(0);
  const anchoredTargetRef = useRef<{ type: 'bottom' | 'message'; id?: string } | null>(null);
  const userInteractedRef = useRef(false);
  const STABILIZE_MS = Platform.OS === 'android' ? 2500 : 1500;
  const DEFAULT_BOTTOM_VISIBILITY_BUFFER = Platform.select({
    ios: 28,
    android: 32,
    default: 24,
  }) ?? 24;
  const stabilizationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLoadingMoreRef = useRef(false);
  const [isInitialAnchorSettled, setIsInitialAnchorSettled] = useState(false);
  const isInitialAnchorSettledRef = useRef(false);
  const [inputHeight, setInputHeight] = useState(40);

  useEffect(() => {
    if (!activeComposerDraftKey || editingMessageInfo) {
      return;
    }

    const currentValue = typeof message === 'string' ? message : '';
    if (currentValue.length > 0) {
      draftByConversationKeyRef.current.set(activeComposerDraftKey, currentValue);
      return;
    }

    draftByConversationKeyRef.current.delete(activeComposerDraftKey);
  }, [activeComposerDraftKey, editingMessageInfo, message]);

  useEffect(() => {
    const nextDraft = activeComposerDraftKey ? draftByConversationKeyRef.current.get(activeComposerDraftKey) || '' : '';
    const currentValue = typeof latestMessageRef.current === 'string' ? latestMessageRef.current : '';

    setEditingMessageInfo(null);
    setReplyingToMessage(null);

    if (nextDraft !== currentValue) {
      setMessage(nextDraft);
      latestMessageRef.current = nextDraft;
      try {
        mobileInputRef.current?.syncValueFromParent?.(nextDraft);
      } catch (syncError) {
        logger.debug('Failed to sync draft value when switching chat', { syncError });
      }
    }

    updateSpecialComposerState(nextDraft);

    if (!nextDraft) {
      setInputHeight(40);
    }
  }, [activeComposerDraftKey, updateSpecialComposerState]);

  const previousIncomingUnreadRef = useRef<number>(0);
  const unreadRepairInFlightRef = useRef(false);
  const unreadRepairTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUnreadRepairAtRef = useRef<{ partnerEmail: string | null; at: number }>({
    partnerEmail: null,
    at: 0,
  });
  const requestedReadReceiptIdsRef = useRef<Set<string>>(new Set());
  const queuedReadReceiptIdsRef = useRef<Set<string>>(new Set());
  const queuedConversationDeliverySyncRef = useRef(false);
  const receiptSyncRunningRef = useRef(false);
  const receiptSyncGenerationRef = useRef(0);
  const receiptSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastConversationDeliverySyncRef = useRef<{ partnerEmail: string | null; at: number }>({
    partnerEmail: null,
    at: 0,
  });
  const flushConversationReceiptSyncRef = useRef<() => Promise<void>>(async () => {});
  const clearQueuedReceiptSyncState = useCallback(() => {
    const nextQueuedState = clearChatReceiptSyncQueuedState(queuedReadReceiptIdsRef.current);
    queuedConversationDeliverySyncRef.current =
      nextQueuedState.requestConversationDelivered;
  }, []);

  useEffect(() => {
    if (!selectedTeamMember) {
      setIsChatBootstrapGateDone(false);
      return;
    }

    if (loading || !isInitialAnchorSettled) {
      setIsChatBootstrapGateDone(false);
      return;
    }

    setIsChatBootstrapGateDone(false);
    const timer = setTimeout(() => {
      setIsChatBootstrapGateDone(true);
    }, 420);

    return () => clearTimeout(timer);
  }, [selectedTeamMember?.id, selectedTeamMember?.email, loading, isInitialAnchorSettled]);

  useEffect(() => {
    if (!selectedTeamMember || isChatBootstrapGateDone) {
      setShowChatOpenHangActions(false);
      return;
    }

    setShowChatOpenHangActions(false);
    const timer = setTimeout(() => {
      setShowChatOpenHangActions(true);
    }, CHAT_OPEN_LOADING_HANG_MS);

    return () => clearTimeout(timer);
  }, [selectedTeamMember?.id, selectedTeamMember?.email, isChatBootstrapGateDone]);

  useEffect(() => {
    const resetPlan = resolveChatReceiptSyncConversationResetPlan(selectedTeamMember?.email);
    receiptSyncGenerationRef.current += 1;
    receiptSyncRunningRef.current = false;

    clearTimeoutRef(receiptSyncTimeoutRef);
    requestedReadReceiptIdsRef.current.clear();
    clearQueuedReceiptSyncState();
    lastConversationDeliverySyncRef.current = resetPlan.deliverySyncMarker;
  }, [clearQueuedReceiptSyncState, selectedTeamMember?.id, selectedTeamMember?.email]);

  useEffect(() => {
    const seedReadMessageIds = resolveChatReceiptRequestedReadSeedMessageIds(messages);
    const seedMutationPlan = resolveChatReceiptRequestedReadMutationPlan({
      addMessageIds: seedReadMessageIds,
    });
    applyChatReceiptRequestedReadMutation(
      requestedReadReceiptIdsRef.current,
      seedMutationPlan
    );
  }, [messages]);

  const queueConversationReceiptSync = useCallback((options: {
    readMessageIds?: string[];
    requestConversationDelivered?: boolean;
  }, queueGeneration?: number) => {
    const activeGeneration = receiptSyncGenerationRef.current;
    const executionGeneration =
      typeof queueGeneration === 'number' ? queueGeneration : activeGeneration;
    const queueExecutionPlan = resolveChatReceiptSyncQueueExecutionPlan({
      options,
      requestedReadMessageIds: requestedReadReceiptIdsRef.current,
      queuedReadMessageIds: queuedReadReceiptIdsRef.current,
      requestConversationDelivered: queuedConversationDeliverySyncRef.current,
      hasPendingTimeout: Boolean(receiptSyncTimeoutRef.current),
      deferredFlushDelayMs: 120,
      queueGeneration: executionGeneration,
      activeGeneration,
    });
    if (!queueExecutionPlan.shouldApplyQueueExecutionPlan) {
      return;
    }

    const { deferredFlushPlan, nextQueuedState } = queueExecutionPlan;
    queuedConversationDeliverySyncRef.current =
      nextQueuedState.requestConversationDelivered;

    if (!deferredFlushPlan.shouldScheduleDeferredFlush) {
      return;
    }

    const scheduledGeneration = receiptSyncGenerationRef.current;
    scheduleTimeoutRef(receiptSyncTimeoutRef, () => {
      if (!shouldRunChatReceiptSyncDeferredFlushContinuation({
        scheduledGeneration,
        activeGeneration: receiptSyncGenerationRef.current,
      })) {
        return;
      }

      void flushConversationReceiptSyncRef.current();
    }, deferredFlushPlan.deferredFlushDelayMs);
  }, []);

  const flushConversationReceiptSync = useCallback(async () => {
    if (receiptSyncRunningRef.current) {
      return;
    }

    const flushPlan = resolveChatReceiptSyncFlushPlan({
      partnerEmail: selectedPartnerEmailRef.current,
      userEmail: effectiveUserEmailRef.current,
      isFocused,
      isAppActive,
      queuedReadMessageIds: queuedReadReceiptIdsRef.current,
      requestConversationDelivered: queuedConversationDeliverySyncRef.current,
    });
    const flushExecutionPlan = resolveChatReceiptSyncFlushExecutionPlan(flushPlan);

    if (flushExecutionPlan.shouldClearQueue) {
      clearQueuedReceiptSyncState();
    }

    if (!flushExecutionPlan.shouldRunSync) {
      return;
    }

    const flushRunAttemptPlan = resolveChatReceiptSyncRunAttemptPlan({
      partnerEmail: flushExecutionPlan.partnerEmail,
      readMessageIds: flushExecutionPlan.readMessageIds,
      requestConversationDelivered: flushExecutionPlan.requestConversationDelivered,
    });
    const runGeneration = receiptSyncGenerationRef.current;
    const { partnerEmail } = flushExecutionPlan;
    const { failureRecoveryPlan, requestMutationPlan, syncPayload } = flushRunAttemptPlan;
    let flushFailureRecoveryPlan: typeof failureRecoveryPlan | null = null;

    receiptSyncRunningRef.current = true;
    applyChatReceiptRequestedReadMutation(
      requestedReadReceiptIdsRef.current,
      requestMutationPlan
    );

    try {
      await chatService.syncConversationReceipts(partnerEmail, {
        readMessageIds: syncPayload.readMessageIds,
        markConversationDelivered: syncPayload.markConversationDelivered,
      });
    } catch (error) {
      flushFailureRecoveryPlan = failureRecoveryPlan;
      logger.debug('Failed to sync chat receipts', error);
    } finally {
      const shouldContinueRunFinalization = shouldApplyChatReceiptSyncRunContinuation({
        runGeneration,
        activeGeneration: receiptSyncGenerationRef.current,
      });
      if (!shouldContinueRunFinalization) {
        return;
      }

      receiptSyncRunningRef.current = false;

      const flushRunFinalizePlan = applyChatReceiptSyncRunFinalizePlan({
        requestedReadMessageIds: requestedReadReceiptIdsRef.current,
        failureRecoveryPlan: flushFailureRecoveryPlan,
        currentDeliverySyncMarker: lastConversationDeliverySyncRef.current,
        queuedReadMessageCount: queuedReadReceiptIdsRef.current.size,
        requestConversationDelivered: queuedConversationDeliverySyncRef.current,
      });
      lastConversationDeliverySyncRef.current =
        flushRunFinalizePlan.nextDeliverySyncMarker;
      if (flushRunFinalizePlan.shouldFlushImmediately) {
        void flushConversationReceiptSyncRef.current();
      }
    }
  }, [clearQueuedReceiptSyncState, isAppActive, isFocused]);

  useEffect(() => {
    flushConversationReceiptSyncRef.current = flushConversationReceiptSync;
  }, [flushConversationReceiptSync]);

  const lastExpensiveViewabilityWorkAtRef = useRef(0);
  const queueDispatchResolverFallbackMetricRef = useRef<{
    reason: 'missing' | 'invalid' | null;
    at: number;
  }>({
    reason: null,
    at: 0,
  });

  useEffect(() => {
    return () => {
      clearTimeoutRef(receiptSyncTimeoutRef);
    };
  }, []);

  // Stable handler for FlashList viewability changes
  const onViewableItemsChangedRef = useRef(({ viewableItems }: any) => {
    const displayedMessages = displayedMessagesRef.current;
    if (!displayedMessages || displayedMessages.length === 0) return;
    const viewableEntries = Array.isArray(viewableItems) ? viewableItems : [];
    const nowMs = Date.now();
    const runExpensiveViewabilityWork = nowMs - lastExpensiveViewabilityWorkAtRef.current >= 120;
    if (runExpensiveViewabilityWork) {
      lastExpensiveViewabilityWorkAtRef.current = nowMs;
    }
    if (runExpensiveViewabilityWork) {
      const asyncContinuationGeneration = receiptSyncGenerationRef.current;
      const prefetch = prefetchUriRef.current;
      const resolveSticker = resolveNativeSafeStickerUrlRef.current;
      const resolveGif = resolveOptimizedGifUrlRef.current;
      const stickerMap = stickerUrlMapRef.current;
      const gifMap = gifUrlMapRef.current;

      const normalizedPartnerEmail = normalizeChatReceiptSyncEmail(
        selectedPartnerEmailRef.current
      );
      const normalizedUserEmail = normalizeChatReceiptSyncEmail(
        effectiveUserEmailRef.current
      );
      if (viewableEntries.length > 0) {
        const {
          warmTargets,
          visibleUnreadIncomingIds,
          queueDispatchPlan: viewabilityQueueDispatchPlan,
        } = resolveChatViewabilityReceiptQueueDispatchPlan({
          viewableEntries,
          normalizedPartnerEmail,
          normalizedUserEmail,
          maxWarmTargets: 5,
          lastDeliverySyncMarker: lastConversationDeliverySyncRef.current,
          resolveQueueDispatchPlan:
            resolveChatReceiptViewabilityQueueDispatchPlanForMarker,
          onQueueDispatchResolverFallback: (reason) => {
            const fallbackMetricEmissionPlan =
              resolveChatViewabilityQueueDispatchResolverFallbackMetricEmissionPlan(
                {
                  reason,
                  lastMetricState:
                    queueDispatchResolverFallbackMetricRef.current,
                  nowMs,
                  cooldownMs: 15000,
                  hasPartnerEmail: Boolean(normalizedPartnerEmail),
                  hasUserEmail: Boolean(normalizedUserEmail),
                  queueGeneration: asyncContinuationGeneration,
                  activeGeneration: receiptSyncGenerationRef.current,
                }
              );
            queueDispatchResolverFallbackMetricRef.current =
              fallbackMetricEmissionPlan.nextMetricState;

            if (!fallbackMetricEmissionPlan.shouldEmitMetric) {
              return;
            }
            logger.metric('chat.viewability.queue_dispatch_resolver_fallback', {
              ...fallbackMetricEmissionPlan.metricPayload,
            });
          },
          queueGeneration: asyncContinuationGeneration,
          activeGeneration: receiptSyncGenerationRef.current,
        });
        applyChatViewabilityWarmTargetPrefetch({
          warmTargets,
          prefetchWarmTarget: ({ remoteUrl, fileName }) =>
            chatCacheService
              .getMediaForDownload(remoteUrl, fileName, undefined, 'low')
              .catch(() => undefined),
        });

        // Hold ALL read/delivery receipt work — and the optimistic local read —
        // until the conversation is genuinely shown and interactive. The
        // "Loading conversation…" overlay is drawn on top of an already-mounted
        // FlashList, so without this gate the viewport reports "viewable" rows
        // and we would mark messages read/delivered while the user is still
        // looking at the loading spinner.
        if (isChatBootstrapGateDoneRef.current) {
          const viewabilityQueueDispatchEffectsPlan =
            resolveChatViewabilityQueueDispatchEffectsPlan(
              viewabilityQueueDispatchPlan
            );

          if (
            viewabilityQueueDispatchEffectsPlan.shouldUpdateDeliverySyncMarker &&
            viewabilityQueueDispatchEffectsPlan.nextDeliverySyncMarker
          ) {
            lastConversationDeliverySyncRef.current =
              viewabilityQueueDispatchEffectsPlan.nextDeliverySyncMarker;
          }

          if (viewabilityQueueDispatchEffectsPlan.shouldQueueSync) {
            queueConversationReceiptSync(
              viewabilityQueueDispatchEffectsPlan.queueOptions,
              asyncContinuationGeneration
            );
          }

          // Optimistically reflect the read locally so the recipient's own
          // unread divider clears the instant a message is actually viewed,
          // decoupled from the backend echo round-trip. The receipt is still
          // queued above, so the sender's blue tick follows as it propagates.
          if (visibleUnreadIncomingIds.length > 0) {
            markMessagesReadLocallyRef.current(visibleUnreadIncomingIds);
          }
        }
      }

      // Prefetch nearby media (stickers/GIFs/images) for smoother scrolling
      if (viewableEntries.length > 0) {
        const candidates = resolveChatViewabilityPrefetchCandidateIndices({
          viewableItems: viewableEntries,
          messageCount: displayedMessages.length,
          behindDistance: 2,
          aheadDistance: 4,
        });

        const nearbyMediaPrefetchPlan =
          resolveChatViewabilityNearbyMediaPrefetchPlan({
            displayedMessages,
            candidateIndices: candidates,
            stickerUrlMap: stickerMap,
            gifUrlMap: gifMap,
            isWeb: Platform.OS === 'web',
            shouldPrefetchAttachment: (attachment) => {
              const rawAttachment = attachment as
                | { fileType?: string; fileName?: string }
                | null
                | undefined;
              return isImageFile(
                rawAttachment?.fileType || '',
                rawAttachment?.fileName || ''
              );
            },
          });

        const prefetchedMediaUrls = new Set<string>();
        const prefetchOnce = (url: string | null | undefined) => {
          if (!url || prefetchedMediaUrls.has(url)) {
            return;
          }

          prefetchedMediaUrls.add(url);
          prefetch(url);
        };

        for (const url of nearbyMediaPrefetchPlan.immediatePrefetchUrls) {
          prefetchOnce(url);
        }

        if (Platform.OS !== 'web') {
          applyChatViewabilityDeferredResolveDispatchPlan({
            stickerResolveUrls: nearbyMediaPrefetchPlan.stickerResolveUrls,
            gifResolveUrls: nearbyMediaPrefetchPlan.gifResolveUrls,
            dispatchStickerResolve: (originalStickerUrl) => {
              resolveSticker(originalStickerUrl).then((alt: string | null) => {
                if (!shouldApplyChatReceiptSyncRunContinuation({
                  runGeneration: asyncContinuationGeneration,
                  activeGeneration: receiptSyncGenerationRef.current,
                })) {
                  return;
                }

                prefetchOnce(alt);
              });
            },
            dispatchGifResolve: (originalGifUrl) => {
              resolveGif(originalGifUrl).then((alt: string) => {
                if (!shouldApplyChatReceiptSyncRunContinuation({
                  runGeneration: asyncContinuationGeneration,
                  activeGeneration: receiptSyncGenerationRef.current,
                })) {
                  return;
                }

                prefetchOnce(alt);
              });
            },
          });
        }
      }
    }

    if (viewableEntries.length) {
      const viewabilityWindowSummary = resolveChatViewabilityWindowSummary({
        viewableItems: viewableEntries,
        unreadMessageId: unreadSeparatorMessageIdRef.current,
      });

      const unreadVisibilityPlan = resolveChatUnreadSeparatorVisibilityPlan({
        hasUnreadTarget: viewabilityWindowSummary.hasUnreadTarget,
        isUnreadVisible: viewabilityWindowSummary.isUnreadVisible,
        hasAcknowledgedUnread: hasAcknowledgedUnreadRef.current,
        incomingUnreadCount: incomingUnreadCountRef.current,
        unreadDividerSeedCount: unreadDividerSeedCountRef.current,
      });
      unreadSeparatorIsVisibleRef.current = unreadVisibilityPlan.nextUnreadSeparatorIsVisible;
      if (unreadVisibilityPlan.shouldAcknowledgeUnread) {
        hasAcknowledgedUnreadRef.current = true;
      }
      if (
        unreadVisibilityPlan.shouldClearDismissTimeout &&
        unreadSeparatorDismissTimeoutRef.current
      ) {
        clearTimeout(unreadSeparatorDismissTimeoutRef.current);
        unreadSeparatorDismissTimeoutRef.current = null;
      }
      if (unreadVisibilityPlan.shouldScheduleDismiss) {
        scheduleUnreadSeparatorDismissRef.current?.(UNREAD_DIVIDER_AUTO_DISMISS_MS);
      }

      const topWindowActionPlan = resolveChatTopWindowActionPlan({
        topVisibleIndex: viewabilityWindowSummary.topVisibleIndex,
        topVisibleMessageId: viewabilityWindowSummary.topVisibleMessageId,
        shouldUseManualAnchorPreservation,
        hasPendingPrependAnchor: Boolean(pendingPrependAnchorRef.current),
        isInitialAnchorSettled: isInitialAnchorSettledRef.current,
        hasUserInteracted: userInteractedRef.current,
        allowTopAutoPagination: allowTopAutoPaginationRef.current,
        topAutoLoadThreshold: TOP_AUTO_LOAD_THRESHOLD,
        currentAutoLoadAnchorId: autoLoadAnchorRef.current,
        topPrefetchThreshold: TOP_PREFETCH_THRESHOLD,
      });

      if (topWindowActionPlan.shouldUpdateTopVisibleMessage) {
        topVisibleMessageRef.current = {
          id: topWindowActionPlan.nextTopVisibleMessageId as string,
          index: topWindowActionPlan.nextTopVisibleIndex as number,
        };
      }

      if (topWindowActionPlan.shouldResetAutoLoadAnchor) {
        autoLoadAnchorRef.current = null;
      } else if (topWindowActionPlan.nextAutoLoadAnchorId !== autoLoadAnchorRef.current) {
        autoLoadAnchorRef.current = topWindowActionPlan.nextAutoLoadAnchorId;
      }

      if (topWindowActionPlan.shouldRequestOlder) {
        requestOlderMessagesRef.current?.('auto');
      }

      if (topWindowActionPlan.shouldWarmNextPage) {
        warmNextPageRef.current?.();
      }

      const bottomIndex = viewabilityWindowSummary.bottomVisibleIndex;
      if (bottomIndex !== null && bottomIndex >= displayedMessages.length - 1) {
        isAtBottomRef.current = true;
      }
    }
  });

  // Subscribe to pinned chats for the current user
  useEffect(() => {
    const currentEmail = (user?.email || '').toLowerCase();
    if (!currentEmail) return;
    const unsubscribe = chatPreferencesService.onPinnedChatsChange(currentEmail, (map) => {
      setPinnedChats(map || {});
    });
    return () => {
      try { unsubscribe && (unsubscribe as any)(); } catch {}
    };
  }, [user?.email]);

  // Stable viewability config. `minimumViewTime` ensures a message must dwell
  // in the viewport before it is reported as viewable — so scrolling past a
  // message does NOT mark it read; only actually looking at it does. This is
  // what drives accurate, WhatsApp-style read receipts.
  const viewabilityConfigRef = useRef({
    itemVisiblePercentThreshold: 50,
    minimumViewTime: 350,
    waitForInteraction: false,
  });

  useEffect(() => {
    let cancelled = false;
    chatCacheService
      .getTelemetryContext()
      .then((profile) => {
        if (!cancelled) {
          concurrencyProfileRef.current = profile;
        }
      })
      .catch((error) => {
        logger.warn('chat.render.trace.profileBootstrapError', { error });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const bottomVisibilityPadding = useMemo(() => {
    return resolveChatBottomVisibilityPadding(DEFAULT_BOTTOM_VISIBILITY_BUFFER, inputHeight);
  }, [inputHeight, DEFAULT_BOTTOM_VISIBILITY_BUFFER]);
  const maintainVisibleContentPositionConfig = useMemo(() => {
    if (Platform.OS === 'web') {
      return undefined;
    }
    return {
      minIndexForVisible: 0,
      autoscrollToTopThreshold: resolveChatAutoscrollToTopThreshold(bottomVisibilityPadding),
    } as const;
  }, [bottomVisibilityPadding]);

  const stopAnchorStabilization = useCallback(() => {
    if (stabilizationTimeoutRef.current) {
      clearTimeout(stabilizationTimeoutRef.current);
      stabilizationTimeoutRef.current = null;
    }
    anchoredTargetRef.current = null;
    setIsInitialAnchorSettled(true);
  }, [setIsInitialAnchorSettled]);
  
  const MAX_PREPEND_ANCHOR_ATTEMPTS = 12;

  const restorePrependAnchorIfNeeded = useCallback(() => {
    if (!shouldUseManualAnchorPreservation) {
      return;
    }
    const anchor = pendingPrependAnchorRef.current;
    if (!anchor) {
      return;
    }
    const positions = messagePositionsRef.current || {};
    const target = positions[anchor.id];
    const selectedFailureExecutionPlan =
      resolveChatPrependAnchorFailureExecutionPlanForRestore({
        targetExists: Boolean(target),
        anchorAttempts: anchor.attempts,
        maxAttempts: MAX_PREPEND_ANCHOR_ATTEMPTS,
        anchorId: anchor.id,
        anchorOffset: anchor.offset,
        displayedMessages: displayedMessagesRef.current,
        displayedMessageIndexById: displayedMessageIndexRef.current,
      });

    const restoreOffsetPlan = resolveChatPrependAnchorRestoreOffsetPlan({
      targetY: target?.y,
      anchorOffset: anchor.offset,
    });

    applyChatPrependAnchorRestoreWithFallback({
      scrollAction: () => {
        if (target) {
          flatListRef.current?.scrollToOffset?.(restoreOffsetPlan.payload);
        } else {
          throw new Error('No target to restore');
        }
      },
      failureExecutionPlan: selectedFailureExecutionPlan,
      pendingPrependAnchorRef,
      list: flatListRef.current,
      scheduleRetry: () => restorePrependAnchorIfNeeded(),
    });
  }, [shouldUseManualAnchorPreservation]);

  const capturePrependAnchor = useCallback((currentOffset: number) => {
    const topVisible = topVisibleMessageRef.current;
    const topVisibleId = topVisible?.id ?? null;
    const topPos = topVisibleId ? messagePositionsRef.current[topVisibleId] : null;
    const capturePlan = resolveChatPrependAnchorCapturePlan({
      shouldUseManualAnchorPreservation,
      hasPendingAnchor: Boolean(pendingPrependAnchorRef.current),
      topVisibleId,
      topVisibleY: topPos?.y ?? null,
      currentOffset,
    });
    if (!capturePlan.shouldCapture || !capturePlan.anchorId) {
      return;
    }

    pendingPrependAnchorRef.current = {
      id: capturePlan.anchorId,
      offset: capturePlan.anchorOffset,
      attempts: 0,
    };
  }, [shouldUseManualAnchorPreservation]);
  const requestOlderMessages = useCallback(
    async (reason: ChatLoadOlderReason = 'manual') => {
      const alreadyAtStart = reachedConversationStartRef.current;
      const hasAttemptedBefore = loadOlderAttemptsRef.current > 0;
      const startPlan = resolveChatLoadOlderStartPlan({
        reason,
        alreadyAtStart,
        isLoadOlderLocked: loadOlderLockRef.current,
        isLoadingMore: loadingMore,
        hasMore,
        hasAttemptedBefore,
        hasLoadMoreFunction: typeof loadMore === 'function',
      });
      if (!startPlan.shouldProceed) {
        const reachedStartToastPlan =
          resolveChatLoadOlderReachedStartToastEmissionPlan(
            startPlan.shouldShowReachedStartToast
          );
        if (reachedStartToastPlan.shouldShow && reachedStartToastPlan.payload) {
          Toast.show(reachedStartToastPlan.payload);
        }
        return;
      }

      const runStartPlan = resolveChatLoadOlderRunStartPlan(
        loadOlderAttemptsRef.current
      );
      loadOlderAttemptsRef.current = runStartPlan.nextLoadOlderAttempts;
      if (runStartPlan.shouldLockLoadOlder) {
        loadOlderLockRef.current = true;
      }
      let added = false;
      try {
        const currentOffset = resolveChatPrependAnchorCaptureTriggerOffset(
          lastScrollOffsetRef.current
        );
        capturePrependAnchor(currentOffset);
      } catch {}

      try {
        const manualLoadOptions = resolveChatLoadOlderAttemptOptions(reason);
        const firstAttemptAdded = await loadMore(manualLoadOptions);
        const retryPlan = resolveChatLoadOlderRetryAttemptPlan({
          reason,
          firstAttemptAdded,
          hasMore: hasMoreRef.current,
          hasManualLoadOptions: Boolean(manualLoadOptions),
        });
        const retryAttemptAdded = retryPlan.shouldRunRetryAttempt
          ? await loadMore(manualLoadOptions)
          : undefined;

        added = resolveChatLoadOlderFinalAddedState(
          firstAttemptAdded,
          retryAttemptAdded
        );

        const syncingToastPlan = resolveChatLoadOlderSyncingToastEmissionPlan(
          reason,
          added,
          hasMoreRef.current
        );
        if (syncingToastPlan.shouldShow && syncingToastPlan.payload) {
          Toast.show(syncingToastPlan.payload);
        }
      } catch (error) {
        logger.warn(
          'chat.pagination.loadOlder.failed',
          resolveChatLoadOlderFailureLogPayload(reason, error)
        );
        const failurePlan = resolveChatLoadOlderFailurePlan();
        if (failurePlan.shouldClearPendingPrependAnchor) {
          pendingPrependAnchorRef.current = null;
        }
      } finally {
        const runCompletionPlan = resolveChatLoadOlderRunCompletionPlan(reason, added);
        if (runCompletionPlan.shouldResetAutoLoadAnchor) {
          autoLoadAnchorRef.current = null;
        }
        if (runCompletionPlan.shouldUnlockLoadOlder) {
          loadOlderLockRef.current = false;
        }
      }
    },
    [hasMore, loadingMore, loadMore, capturePrependAnchor]
  );

  useEffect(() => {
    requestOlderMessagesRef.current = requestOlderMessages;
  }, [requestOlderMessages]);

  useEffect(() => {
    const reachedStartPlan = resolveChatReachedConversationStartPlan({
      isLoadingMore: loadingMore,
      hasMore,
      loadOlderAttempts: loadOlderAttemptsRef.current,
    });

    if (!reachedStartPlan.shouldUpdate) {
      return;
    }

    reachedConversationStartRef.current = reachedStartPlan.nextReachedConversationStart;
    setReachedConversationStart(reachedStartPlan.nextReachedConversationStart);
  }, [hasMore, loadingMore]);

  useEffect(() => {
    const resetPlan = resolveChatLoadOlderConversationResetPlan();
    loadOlderAttemptsRef.current = resetPlan.nextLoadOlderAttempts;
    reachedConversationStartRef.current = resetPlan.nextReachedConversationStart;
    setReachedConversationStart(resetPlan.nextReachedConversationStart);
    if (resetPlan.shouldResetAutoLoadAnchor) {
      autoLoadAnchorRef.current = null;
    }
  }, [selectedTeamMember?.id]);

  const scheduleUnreadSeparatorDismiss = useCallback((delay: number = UNREAD_DIVIDER_AUTO_DISMISS_MS) => {
    if (!showUnreadSeparatorRef.current) {
      return;
    }

    // A seeded divider stays pinned for the whole session (WhatsApp behaviour):
    // it must not auto-dismiss while the user is still in the conversation. It
    // is cleared only when switching chats (the reset effect).
    if (unreadSeedAnchorMessageIdRef.current) {
      return;
    }

    if (unreadSeparatorDismissTimeoutRef.current) {
      clearTimeout(unreadSeparatorDismissTimeoutRef.current);
    }

    unreadSeparatorDismissTimeoutRef.current = setTimeout(() => {
      setShowUnreadSeparator(false);
      setUnreadSeparatorMessageId(null);
      unreadSeparatorIsVisibleRef.current = false;
      unreadDividerSeedCountRef.current = 0;
      setUnreadDividerSeedCount(0);
      unreadSeparatorDismissTimeoutRef.current = null;
    }, Math.max(0, delay));
  }, []);

  const scheduleUnreadSeparatorDismissRef = useRef(scheduleUnreadSeparatorDismiss);
  useEffect(() => {
    scheduleUnreadSeparatorDismissRef.current = scheduleUnreadSeparatorDismiss;
  }, [scheduleUnreadSeparatorDismiss]);

  // Helper function to get the appropriate profile picture URL for a team member
  // Centralized in lib/profileImage to keep behavior consistent across the app
  const getProfilePictureURL = getProfileImageUrl;

  const handleRichTextInput = async (inputText: string) => {
    return resolveChatRichTextInputResult(inputText);
  };

  // Handle emoji reactions with Firebase Realtime Database integration
  const handleReaction = async (messageId: string, reactionType: string) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!effectiveUser?.email || !normalizedMessageId) {
      logger.warn('Missing required data for reaction:', { 
        userEmail: !!effectiveUser?.email, 
        messageId: !!normalizedMessageId 
      });
      return;
    }
    
    const userEmail = effectiveUser.email;
    
    // Check if this is a special message
    const message = getDisplayedMessageById(normalizedMessageId);
    const isSpecialMessage = message?.isSpecial === true;
    
    logger.debug('🎯 Reaction Debug Info:', {
      messageId: normalizedMessageId,
      messageFound: !!message,
      isSpecial: message?.isSpecial,
      isSpecialMessage,
      reactionType,
      userEmail
    });
    
    try {
      // Update local state immediately for responsive UI
      reactionOptimisticUntilRef.current.set(normalizedMessageId, Date.now() + 1500);
      setLocalMessageReactions((prevReactions) =>
        resolveChatOptimisticReactionMap(
          prevReactions,
          normalizedMessageId,
          reactionType,
          userEmail,
          isSpecialMessage
        )
      );

      // Save to Firebase Realtime Database
      const updatedUsers = await chatService.toggleMessageReaction(normalizedMessageId, reactionType, userEmail);
      
  // Close emoji picker after selection
  setEmojiPickerVisible(false);
  setSelectedMessageForReaction(null);
  setSelectedMessageForAction(null);
      
      logger.debug('✅ Reaction updated successfully:', { 
        messageId: normalizedMessageId, 
        reactionType, 
        users: updatedUsers 
      });
      
      const hasReacted = updatedUsers.includes(userEmail);
      
      // Show different toast messages for special vs regular messages
      if (isSpecialMessage) {
        Toast.show({
          type: 'success',
          text1: hasReacted ? 'Reaction Added' : 'Reaction Removed',
          text2: hasReacted 
            ? `Added ${getEmojiName(reactionType)} to special message` 
            : `Removed ${getEmojiName(reactionType)} from special message`,
          position: 'top',
          visibilityTime: 1500,
        });
      } else {
        Toast.show({
          type: 'success',
          text1: hasReacted ? 'Reaction Set' : 'Reaction Removed',
          text2: hasReacted 
            ? `You reacted with ${getEmojiName(reactionType)}` 
            : `You removed your ${getEmojiName(reactionType)} reaction`,
          position: 'top',
          visibilityTime: 1500,
        });
      }
    } catch (error) {
      logger.error('❌ Error handling reaction:', error);
      
      // Revert local state on error - this is complex because we need to restore the previous state
      // For simplicity, we'll just refresh the reactions from the server
      // In a production app, you might want to implement more sophisticated rollback logic
      setLocalMessageReactions(prevReactions => prevReactions);
      
      Toast.show({
        type: 'error',
        text1: 'Reaction Failed',
        text2: 'Could not save your reaction. Please try again.',
        position: 'top',
      });
    }
  };



  // Handle long press on message to show emoji picker
  const handleMessageLongPress = (messageId: string, event: any) => {
    const { pageX, pageY } = event.nativeEvent;
    const normalizedMessageId = normalizeMessageId(messageId);
    const targetMessage = getDisplayedMessageById(normalizedMessageId);
    setSelectedMessageForReaction(normalizedMessageId);
    setSelectedMessageForAction(targetMessage);
    setReactionPickerPosition({ x: pageX, y: pageY });
    setEmojiPickerVisible(true);
  };

  const closeEmojiPicker = useCallback(() => {
    setEmojiPickerVisible(false);
    setSelectedMessageForReaction(null);
    setSelectedMessageForAction(null);
  }, []);

  // Quick reaction with double tap
  const handleQuickReaction = async (messageId: string) => {
    await handleReaction(normalizeMessageId(messageId), '❤️');
  };

  type ReactionStatusSnapshot = {
    count: number;
    hasUserReacted: boolean;
    users: string[];
  };



  const EMPTY_REACTION_STATUS: ReactionStatusSnapshot = {
    count: 0,
    hasUserReacted: false,
    users: [],
  };

  // Get reaction status for a message
  const getReactionStatus = (
    messageId: string,
    reactionType: string,
    reactionsOverride?: { [key: string]: Set<string> }
  ): ReactionStatusSnapshot => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId || !reactionType) return EMPTY_REACTION_STATUS;
    const reactions = reactionsOverride ?? messageReactionsRef.current.get(normalizedMessageId);
    if (!reactions || !reactions[reactionType]) return EMPTY_REACTION_STATUS;
    
    const reactionSet = reactions[reactionType];
    if (!reactionSet) return EMPTY_REACTION_STATUS;
    
    const users = Array.from(reactionSet);
    const hasUserReacted = effectiveUser?.email ? reactionSet.has(effectiveUser.email) : false;
    
    return {
      count: users.length,
      hasUserReacted,
      users
    };
  };

  const getMessageReactionSummary = useCallback((
    message: any,
    reactionsOverride?: { [key: string]: Set<string> }
  ) => {
    const normalizedMessageId = normalizeMessageId(message?.id);
    if (!normalizedMessageId) {
      return {
        pills: [] as ReactionPillDescriptor[],
        statusByType: new Map<string, ReactionStatusSnapshot>(),
        glowByType: new Set<string>(),
      };
    }

    const reactions = reactionsOverride ?? messageReactionsRef.current.get(normalizedMessageId);
    if (!reactions) {
      return {
        pills: [] as ReactionPillDescriptor[],
        statusByType: new Map<string, ReactionStatusSnapshot>(),
        glowByType: new Set<string>(),
      };
    }

    const senderEmail = normalizeParticipantEmail(message?.sender);
    const recipientEmail = normalizeParticipantEmail(selectedTeamMember?.email);
    const canGlow = Boolean(senderEmail && recipientEmail);

    const pills = normalizeReactions(reactions, effectiveUser?.email);
    const statusByType = new Map<string, ReactionStatusSnapshot>();
    const glowByType = new Set<string>();

    pills.forEach((pill) => {
      const status: ReactionStatusSnapshot = {
        count: pill.count,
        hasUserReacted: pill.hasUserReacted,
        users: pill.users,
      };

      statusByType.set(pill.emoji, status);

      if (canGlow && pill.users.includes(senderEmail) && pill.users.includes(recipientEmail)) {
        glowByType.add(pill.emoji);
      }
    });

    pills.sort((a, b) => b.count - a.count);

    return {
      pills,
      statusByType,
      glowByType,
    };
  }, [effectiveUser?.email, normalizeMessageId, normalizeParticipantEmail, selectedTeamMember?.email]);

  const isOwnMessageEmail = useCallback(
    (msg?: any) => resolveChatIsOwnMessageEmail(msg, effectiveUserEmail),
    [effectiveUserEmail]
  );

  const canEditMessage = useCallback(
    (msg: any) => resolveChatCanEditMessage(msg, effectiveUserEmail),
    [effectiveUserEmail]
  );

  const findLatestEditableOwnMessage = useCallback(() => {
    return resolveChatFindLatestEditableOwnMessage(messages as any, effectiveUserEmail);
  }, [messages, effectiveUserEmail]);

  const canDeleteMessage = useCallback(
    (msg: any) => resolveChatCanDeleteMessage(msg, effectiveUserEmail),
    [effectiveUserEmail]
  );

  const canReplyMessage = useCallback(
    (msg: any) => resolveChatCanReplyMessage(msg),
    []
  );

  const showMessageInfo = useCallback(
    (targetMessage: any) => {
      if (!targetMessage) {
        return;
      }

      const ownMessage = isOwnMessageEmail(targetMessage);
      const fallbackSenderName = !ownMessage && typeof selectedTeamMember?.name === 'string'
        ? selectedTeamMember.name
        : undefined;

      const recipientStatusDetails = Array.isArray(targetMessage?.recipientStatusDetails)
        ? targetMessage.recipientStatusDetails
        : Array.isArray(targetMessage?.recipientStatuses)
          ? targetMessage.recipientStatuses
          : undefined;

      const infoRows = resolveChatMessageInfoRows({
        isOwnMessage: ownMessage,
        senderEmail: normalizeParticipantEmail(targetMessage?.sender),
        senderName: typeof targetMessage?.senderName === 'string'
          ? targetMessage.senderName
          : fallbackSenderName,
        recipientEmail: ownMessage
          ? normalizeParticipantEmail(targetMessage?.recipientId) ||
            normalizeParticipantEmail(selectedTeamMember?.email)
          : normalizeParticipantEmail(effectiveUserEmail),
        recipientName: ownMessage
          ? typeof selectedTeamMember?.name === 'string'
            ? selectedTeamMember.name
            : undefined
          : undefined,
        recipientStatusDetails,
        sentAt:
          typeof targetMessage?.timestamp === 'string'
            ? targetMessage.timestamp
            : targetMessage?.timestamp != null
              ? String(targetMessage.timestamp)
              : undefined,
        delivered: targetMessage?.delivered === true,
        deliveredAt:
          typeof targetMessage?.deliveredAt === 'string'
            ? targetMessage.deliveredAt
            : undefined,
        read: targetMessage?.read === true,
        readAt:
          typeof targetMessage?.readAt === 'string'
            ? targetMessage.readAt
            : undefined,
        editedAt:
          typeof targetMessage?.editedAt === 'string'
            ? targetMessage.editedAt
            : undefined,
        deleted: targetMessage?.deleted === true,
        formatTimestamp: (value) => formatMessageTimestamp(value),
      });

      if (messageInfoCopiedResetTimerRef.current) {
        clearTimeout(messageInfoCopiedResetTimerRef.current);
        messageInfoCopiedResetTimerRef.current = null;
      }
      setMessageInfoCopiedRowKey(null);

      const shouldShowHint = !hasShownMessageInfoHintRef.current;
      if (shouldShowHint) {
        hasShownMessageInfoHintRef.current = true;
      }
      setShowMessageInfoHint(shouldShowHint);

      setMessageInfoModalState({
        visible: true,
        rows: infoRows,
      });
    },
    [
      effectiveUserEmail,
      isOwnMessageEmail,
      normalizeParticipantEmail,
      selectedTeamMember?.email,
      selectedTeamMember?.name,
    ]
  );

  const beginConversationSearchFromMessage = useCallback(
    (targetMessage: any) => {
      const seededQuery = resolveChatConversationSearchSeedQuery(targetMessage?.text);
      if (!seededQuery) {
        return;
      }

      clearTimeoutRef(conversationSearchLoadDebounceTimerRef);
      conversationSearchLoadTokenRef.current += 1;
      conversationSearchHistoryLoadAttemptsRef.current = 0;
      previousConversationSearchQueryRef.current = '';
      previousConversationSearchScopeRef.current = 'all';
      setIsConversationSearchHistoryLoading(false);
      setShowSearchShortcutTipsModal(false);
      conversationSearchVisibleRef.current = true;
      setConversationSearchVisible(true);
      setConversationSearchQuery(seededQuery);
      setConversationSearchScope('all');
      setConversationSearchActiveIndex(0);
      setConversationSearchHighlightMessageId(null);
      setConversationSearchKeyboardSuggestionScope(null);
      setConversationSearchShortcutPulseScope(null);
    },
    []
  );

  const buildReplyContextFromMessage = useCallback(
    (targetMessage: any): ChatReplyContext | null => {
      return resolveChatReplyContextFromMessage({
        targetMessage,
        effectiveUserEmail,
        selectedMemberEmail: selectedTeamMember?.email,
        selectedMemberName: selectedTeamMember?.name,
        maxPreviewLength: CHAT_REPLY_PREVIEW_MAX_CHARS,
      });
    },
    [effectiveUserEmail, selectedTeamMember?.email, selectedTeamMember?.name]
  );

  const isMessageActionPending = useCallback(
    (messageId?: string | null) => {
      if (!messageId) return false;
      return pendingMessageActions.has(messageId);
    },
    [pendingMessageActions]
  );

  const markMessageActionPending = useCallback((messageId: string) => {
    setPendingMessageActions((prev) => {
      const next = new Set(prev);
      next.add(messageId);
      return next;
    });
  }, []);

  const clearMessageActionPending = useCallback((messageId: string) => {
    setPendingMessageActions((prev) => {
      const next = new Set(prev);
      next.delete(messageId);
      return next;
    });
  }, []);
  
  // Unread messages separator state management
  const [showUnreadSeparator, setShowUnreadSeparator] = useState(false);
  const [unreadSeparatorMessageId, setUnreadSeparatorMessageId] = useState<string | null>(null);
  const [unreadDividerSeedCount, setUnreadDividerSeedCount] = useState(0);
  // Frozen "first unread on open" anchor. Captured once per chat so the divider
  // is pinned to where your unread messages began (WhatsApp/Telegram style):
  // it shows when you open a chat that has unread messages, stays at a stable
  // position, and does not vanish as those messages are marked read. It is
  // INDEPENDENT of the live read state (which drives blue ticks) — opening with
  // unread shows it; messages arriving later while you're present do not.
  const [unreadSeedAnchorMessageId, setUnreadSeedAnchorMessageId] = useState<string | null>(null);
  const unreadSeedAnchorMessageIdRef = useRef<string | null>(null);
  // Guard so the unread divider is seeded exactly once per chat (see the seed
  // effect below, which is the single owner of "what was unread on open").
  const unreadAnchorSeedInitializedChatKeyRef = useRef<string | null>(null);
  // True once the open-time seed decision has been made for the current chat.
  // After this, the divider is driven STRICTLY by the seed anchor, so a chat
  // opened with zero unread never shows a divider for messages that arrive
  // while the user is present and actively viewing them.
  const [unreadDividerSeeded, setUnreadDividerSeeded] = useState(false);
  const unreadSeparatorDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unreadSeparatorMessageIdRef = useRef<string | null>(null);
  const showUnreadSeparatorRef = useRef(false);
  const lastNearBottomUnreadDismissAnchorRef = useRef<string | null>(null);
  const unreadSeparatorIsVisibleRef = useRef(false);
  const hasAcknowledgedUnreadRef = useRef(false);
  const incomingUnreadCountRef = useRef(0);
  const unreadDividerSeedCountRef = useRef(0);
  const unreadDividerDismissedStateRef = useRef<{
    anchorMessageId: string;
    latestIncomingMessageId: string | null;
  } | null>(null);
  // New messages divider when user is away from bottom
  const [showNewDivider, setShowNewDivider] = useState(false);
  const [newDividerMessageId, setNewDividerMessageId] = useState<string | null>(null);
  const forceBottomAnchorChatKeyRef = useRef<string | null>(null);
  const hasAnchoredInitialScrollRef = useRef(false); // ensures we only snap to bottom once per chat load
  const pendingInitialAnchorRef = useRef(false); // tracks when we still need to align to the latest message
  const scrollToUnreadAttemptedRef = useRef(false); // tracks if we attempted to scroll to first unread
  const isAutoScrollingRef = useRef(false);
  const onScrollFailAttemptsRef = useRef(0); // track scrollToIndex failures (esp. on web)
  const jumpingToReplyRef = useRef(false);
  const replyJumpConversationKeyRef = useRef<string | null>(activeComposerDraftKey);

  const setShowScrollToBottomSafely = useCallback((nextValue: boolean) => {
    setShowScrollToBottom((current) => (current === nextValue ? current : nextValue));
  }, []);

  const setShowReplyJumpToLatestSafely = useCallback((nextValue: boolean) => {
    setShowReplyJumpToLatest((current) => (current === nextValue ? current : nextValue));
  }, []);

  const setStickyDateVisibleSafely = useCallback((nextValue: boolean) => {
    setStickyDateVisible((current) => (current === nextValue ? current : nextValue));
  }, []);

  const setStickyDateTextSafely = useCallback((nextValue: string) => {
    setStickyDateText((current) => (current === nextValue ? current : nextValue));
  }, []);

  const resetUnseenCount = useCallback(() => {
    setUnseenCount((current) => (current === 0 ? current : 0));
  }, []);

  const incrementUnseenCount = useCallback((amount: number = 1) => {
    const normalizedAmount = Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0;
    if (normalizedAmount <= 0) {
      return;
    }

    setUnseenCount((current) => current + normalizedAmount);
  }, []);

  const clearNewMessageDivider = useCallback(() => {
    setShowNewDivider((current) => (current ? false : current));
    setNewDividerMessageId((current) => (current === null ? current : null));
  }, []);

  // Retire the seeded unread divider for the rest of the session (cleared on
  // chat switch, when the next message arrives at the bottom, or when the user
  // sends). Clearing the seed anchor makes the strict helper yield no anchor;
  // the seed guard prevents it from re-appearing this session.
  const clearUnreadDivider = useCallback(() => {
    unreadSeedAnchorMessageIdRef.current = null;
    setUnreadSeedAnchorMessageId((current) => (current === null ? current : null));
    setShowUnreadSeparator((current) => (current ? false : current));
    setUnreadSeparatorMessageId((current) => (current === null ? current : null));
    unreadSeparatorIsVisibleRef.current = false;
  }, []);

  const showNewMessageDividerAt = useCallback((messageId: unknown) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) {
      return;
    }

    setNewDividerMessageId((current) => (current === normalizedMessageId ? current : normalizedMessageId));
    setShowNewDivider((current) => (current ? current : true));
  }, [normalizeMessageId]);

  const messageListScrollHandlerRef = useRef<(e: any) => void>(() => {});
  const messageListContentSizeHandlerRef = useRef<(_w: number, h: number) => void>(() => {});
  const messageListLayoutHandlerRef = useRef<(e: any) => void>(() => {});
  const messageListHeaderRendererRef = useRef<React.ReactNode>(null);
  const messageListFooterRendererRef = useRef<React.ReactNode>(null);
  const messageListEmptyRendererRef = useRef<() => React.ReactElement | null>(() => null);

  const handleMessageListScrollStable = useCallback((e: any) => {
    messageListScrollHandlerRef.current(e);
  }, []);

  const handleMessageListContentSizeChangeStable = useCallback((_w: number, h: number) => {
    messageListContentSizeHandlerRef.current(_w, h);
  }, []);

  const handleMessageListLayoutStable = useCallback((e: any) => {
    messageListLayoutHandlerRef.current(e);
  }, []);

  const renderMessageListHeaderStable = useCallback(() => {
    return messageListHeaderRendererRef.current;
  }, []);

  const renderMessageListFooterStable = useCallback(() => {
    return messageListFooterRendererRef.current;
  }, []);

  const renderMessageListEmptyStable = useCallback(() => {
    return messageListEmptyRendererRef.current();
  }, []);



  // Get user directly from authService as backup. Foreground-gated so it does
  // not poll (or pile up) while backgrounded; runs once immediately on resume.
  useForegroundInterval(() => {
    const authUser = authService.getCurrentUser();
    // Only update if user actually changed to prevent unnecessary re-renders
    setCurrentUser((prevUser: any) => {
      if (!prevUser && !authUser) return prevUser;
      if (!prevUser || !authUser) return authUser;
      if (prevUser.email !== authUser.email || prevUser.isAuthorized !== authUser.isAuthorized) {
        return authUser;
      }
      return prevUser;
    });
  }, 5000);

  // Listen for screen dimension changes
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) => {
      setScreenData(window);
    });
    
    return () => subscription?.remove();
  }, []);

  const unreadDividerDerivedState = useMemo(() => {
    return resolveChatUnreadDividerDerivedState({
      displayedMessages,
      effectiveUserEmail: effectiveUser?.email,
      selectedTeamMemberEmail: selectedTeamMember?.email,
      unreadDividerSeedCount,
      seedAnchorMessageId: unreadSeedAnchorMessageId,
      unreadDividerSeeded,
      normalizeParticipantEmail,
      normalizeMessageId,
    });
  }, [
    displayedMessages,
    effectiveUser?.email,
    normalizeMessageId,
    normalizeParticipantEmail,
    selectedTeamMember?.email,
    unreadDividerSeedCount,
    unreadSeedAnchorMessageId,
    unreadDividerSeeded,
  ]);

  const {
    incomingConversationMessages,
    incomingUnreadMessageIds,
    firstUnreadMessageId,
    incomingUnreadCount,
    unreadSeparatorAnchorMessageId,
    unreadDividerLabel,
  } = unreadDividerDerivedState;

  const dismissUnreadDividerForCurrentBatch = useCallback((_delay: number = UNREAD_DIVIDER_ACTION_DISMISS_MS) => {
    // No-op by design. The unread divider is owned entirely by the seed model:
    // it is shown when the chat is opened with unread messages and cleared only
    // on chat switch (the reset effect). The legacy "dismiss this batch on
    // scroll/send" behaviour is intentionally disabled — it used to record a
    // dismissed-batch marker that the Smart effect then matched against the
    // freshly-seeded anchor and hid the divider instantly ("not even for a
    // second"). Disabling it makes the divider reliably visible.
  }, []);

  // ── Seed the unread divider once per chat (WhatsApp / Telegram behaviour) ──
  //    This is the SINGLE owner of "what was unread when this chat opened". It
  //    runs once, on the first loaded snapshot for the conversation, and freezes
  //    both the divider's anchor and its count via `resolveChatUnreadDividerSeed`
  //    (live first-unread, else a summary/roster-count boundary). From then on
  //    the divider is pinned for the session: it shows when you open a chat that
  //    had unread messages, stays at a stable position, does not move as
  //    messages are read, and does not vanish on read — it is INDEPENDENT of the
  //    live read state (which drives blue ticks). Cleared only on chat switch.
  useEffect(() => {
    const chatKey = String(selectedTeamMember?.id || selectedTeamMember?.email || '');
    if (!chatKey || !selectedTeamMember?.email || !effectiveUser?.email) {
      return;
    }
    if (loading || !Array.isArray(displayedMessages) || displayedMessages.length === 0) {
      return;
    }
    if (unreadAnchorSeedInitializedChatKeyRef.current === chatKey) {
      return;
    }

    // Lock only once we have the participants AND the loaded messages, so the
    // anchor is captured from the true "unread on open" snapshot. (Locking
    // earlier could freeze an empty seed and suppress the divider entirely.)
    unreadAnchorSeedInitializedChatKeyRef.current = chatKey;

    const normalizedPartnerEmail = normalizeParticipantEmail(selectedTeamMember?.email);
    const seed = resolveChatUnreadDividerSeed({
      firstUnreadMessageId,
      incomingUnreadCount,
      incomingConversationMessages,
      summaryUnreadCount: normalizedPartnerEmail
        ? conversationSummaries.get(normalizedPartnerEmail)?.unreadCount
        : 0,
      rosterUnreadCount: (selectedTeamMember as any)?.unreadCount,
      normalizeMessageId,
    });

    if (seed.anchorMessageId) {
      unreadSeedAnchorMessageIdRef.current = seed.anchorMessageId;
      setUnreadSeedAnchorMessageId(seed.anchorMessageId);
    }
    unreadDividerSeedCountRef.current = seed.count;
    setUnreadDividerSeedCount(seed.count);
    setUnreadDividerSeeded(true);
  }, [
    selectedTeamMember,
    effectiveUser?.email,
    loading,
    displayedMessages,
    firstUnreadMessageId,
    incomingUnreadCount,
    incomingConversationMessages,
    conversationSummaries,
    normalizeParticipantEmail,
    normalizeMessageId,
  ]);

  const liveSelectedConversationSummary = useMemo<ConversationSummary | null>(() => {
    return resolveChatLiveConversationSummary({
      displayedMessages,
      partnerEmail: selectedTeamMember?.email,
      partnerId: selectedTeamMember?.id,
      partnerName: selectedTeamMember?.name,
      tenantId: activeTenant?.id,
      userEmail: effectiveUser?.email,
      incomingUnreadCount,
      isFocused,
      isAppActive,
    });
  }, [displayedMessages, incomingUnreadCount, selectedTeamMember?.email, selectedTeamMember?.id, selectedTeamMember?.name, effectiveUser?.email, activeTenant?.id, isFocused, isAppActive]);

  useEffect(() => {
    if (!liveSelectedConversationSummary) {
      return;
    }

    const partnerEmail = liveSelectedConversationSummary.partnerEmail?.toLowerCase?.();
    if (!partnerEmail) {
      return;
    }

    setConversationSummaries((prev) => {
      return upsertChatConversationSummary(
        prev,
        liveSelectedConversationSummary,
        activeTenant?.id ?? null
      );
    });
  }, [liveSelectedConversationSummary, activeTenant?.id]);

  useEffect(() => {
    const activeQueueGeneration = receiptSyncGenerationRef.current;
    const foregroundQueueExecutionPlan = resolveChatReceiptForegroundQueueExecutionPlan({
      partnerEmail: selectedTeamMember?.email,
      userEmail: effectiveUser?.email,
      isFocused,
      isAppActive,
      // Opening/focusing a conversation must NOT mark messages as read. Read
      // receipts are driven purely by per-message viewability (see the
      // onViewableItemsChanged handler), so the sender only sees "read" once
      // the recipient has actually scrolled the specific message into view and
      // dwelled on it. Here we only confirm delivery for the unread batch.
      readMessageIds: [],
      requestConversationDelivered: incomingUnreadMessageIds.length > 0,
      queueGeneration: activeQueueGeneration,
      activeGeneration: activeQueueGeneration,
    });
    if (
      !foregroundQueueExecutionPlan.shouldApplyQueueInvocationExecutionPlan ||
      !foregroundQueueExecutionPlan.shouldQueueSync
    ) {
      return;
    }

    queueConversationReceiptSync(
      foregroundQueueExecutionPlan.queueOptions,
      activeQueueGeneration
    );
  }, [incomingUnreadMessageIds, selectedTeamMember?.email, effectiveUser?.email, isFocused, isAppActive, queueConversationReceiptSync]);

  useEffect(() => {
    unreadSeparatorMessageIdRef.current = unreadSeparatorMessageId;
  }, [unreadSeparatorMessageId]);

  useEffect(() => {
    showUnreadSeparatorRef.current = showUnreadSeparator;
  }, [showUnreadSeparator]);

  useEffect(() => {
    incomingUnreadCountRef.current = incomingUnreadCount;
  }, [incomingUnreadCount]);

  useEffect(() => {
    unreadDividerSeedCountRef.current = unreadDividerSeedCount;
  }, [unreadDividerSeedCount]);

  useEffect(() => {
    if (!showUnreadSeparator || !unreadSeparatorMessageId) {
      return;
    }

    const normalizedAnchorId = normalizeMessageId(unreadSeparatorMessageId);
    const anchorExists = Boolean(
      normalizedAnchorId && displayedMessageIndexRef.current.has(normalizedAnchorId)
    );
    const unreadSeparatorReconcilePlan = resolveChatUnreadSeparatorReconcilePlan({
      showUnreadSeparator,
      unreadSeparatorMessageId,
      unreadSeparatorAnchorMessageId,
      anchorExists,
    });

    if (unreadSeparatorReconcilePlan.shouldUpdateAnchor) {
      setUnreadSeparatorMessageId(unreadSeparatorReconcilePlan.nextAnchorMessageId);
      return;
    }

    if (!unreadSeparatorReconcilePlan.shouldClearUnreadSeparator) {
      return;
    }

    setShowUnreadSeparator(false);
    setUnreadSeparatorMessageId(null);
    unreadSeparatorIsVisibleRef.current = false;
    unreadDividerDismissedStateRef.current = null;
    unreadDividerSeedCountRef.current = 0;
    setUnreadDividerSeedCount(0);
  }, [displayedMessages, normalizeMessageId, showUnreadSeparator, unreadSeparatorMessageId, unreadSeparatorAnchorMessageId]);

  useEffect(() => {
    const partnerEmail = selectedTeamMember?.email?.toLowerCase?.();
    if (!partnerEmail) {
      return;
    }

    const effectiveIncomingUnreadCount = isFocused && isAppActive ? 0 : incomingUnreadCount;

    setConversationSummaries((prev) => {
      return reconcileConversationUnreadCount(prev, partnerEmail, effectiveIncomingUnreadCount, {
        isFocused,
        isAppActive,
        loading,
      });
    });
  }, [incomingUnreadCount, selectedTeamMember?.email, setConversationSummaries, isFocused, isAppActive, loading]);

  const estimatedListSize = useMemo(() => {
    const windowSize = Dimensions.get('window');
    return resolveChatEstimatedListSize({
      screenHeight: screenData.height,
      screenWidth: screenData.width,
      fallbackHeight: windowSize.height,
      fallbackWidth: windowSize.width,
    });
  }, [screenData.height, screenData.width]);

  const estimatedItemSize = useMemo(() => {
    return resolveChatEstimatedItemSize({
      displayedMessages,
      messagePositionsById: messagePositionsRef.current,
      normalizeMessageId,
    });
  }, [displayedMessages, normalizeMessageId]);

  const listDrawDistance = useMemo(() => {
    if (!isFocused) {
      // When the conversation is not the active tab, shrink the render window
      // so FlashList releases far offscreen rows (and the images/video elements
      // they contain). This frees retained memory on every platform — including
      // web, where freezing the screen keeps the DOM intact and would otherwise
      // hold every rendered media row until the user returns.
      return Platform.OS === 'web' ? 240 : 320;
    }
    return resolveChatListDrawDistance(
      estimatedListSize.height,
      Platform.OS === 'web'
    );
  }, [estimatedListSize.height, isFocused]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }

    const pending = notificationService.getPendingChatNavigationTarget();
    if (!pending) {
      return;
    }

    const normalize = (value?: string | null) =>
      typeof value === 'string' ? value.trim().toLowerCase() : undefined;

    const ownEmail = normalize(effectiveUser?.email ?? null);
    let targetEmail = normalize(pending.senderEmail ?? null);

    if (!targetEmail && typeof pending.chatId === 'string') {
      const parts = pending.chatId.split('_').map(part => part.trim().toLowerCase());
      if (parts.length > 0) {
        targetEmail = parts.find(part => part && part !== ownEmail) || parts[0];
      }
    }

    if (!targetEmail) {
      notificationService.consumePendingChatNavigationTarget();
      return;
    }

    const matchInTeamMembers = teamMembersByEmail.get(targetEmail);

    const matchInChatInfo = matchInTeamMembers
      ? matchInTeamMembers
      : teamMembersWithChatInfoByEmail.get(targetEmail);

    if (matchInChatInfo) {
      forceBottomAnchorChatKeyRef.current = String((matchInChatInfo as TeamMember).id || (matchInChatInfo as TeamMember).email || '');
      setSelectedTeamMember(matchInChatInfo as TeamMember);
      notificationService.consumePendingChatNavigationTarget();
    }
  }, [isFocused, teamMembersByEmail, teamMembersWithChatInfoByEmail, effectiveUser?.email]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }

    const targetEmail = typeof searchParams.senderEmail === 'string'
      ? searchParams.senderEmail.trim().toLowerCase()
      : '';

    if (!targetEmail) {
      return;
    }

    const match = teamMembersByEmail.get(targetEmail)
      || teamMembersWithChatInfoByEmail.get(targetEmail);

    if (!match) {
      return;
    }

    forceBottomAnchorChatKeyRef.current = String((match as TeamMember).id || (match as TeamMember).email || '');
    setSelectedTeamMember(match as TeamMember);
    router.replace('/(tabs)/chat');
  }, [isFocused, router, searchParams.senderEmail, teamMembersByEmail, teamMembersWithChatInfoByEmail]);

  // Wrapper for notifications to keep previous calls working
  const sendMessageNotification = useCallback(
    async (
      text: string,
      isSpecial: boolean = false,
      sticker?: { url: string; name?: string },
      gif?: { url: string; thumbnailUrl?: string }
    ) => {
      try {
        const senderEmail = effectiveUser?.email;
        const recipientEmail = selectedTeamMember?.email;
        if (!senderEmail || !recipientEmail) return;
        const msg = {
          id: undefined,
          text,
          sender: senderEmail,
          recipientId: recipientEmail,
          timestamp: new Date().toISOString(),
          isSpecial,
          sticker: sticker ? { url: sticker.url, name: sticker.name || 'Sticker' } : undefined,
          gif: gif ? { url: gif.url, thumbnailUrl: gif.thumbnailUrl } : undefined,
          delivered: false,
          read: false,
        } as any;
        await notificationService.sendSmartChatNotification(
          msg,
          recipientEmail,
          senderEmail,
          { currentChatPartner: recipientEmail }
        );
      } catch (e) {
        // Non-fatal
        logger.warn('sendMessageNotification failed:', e);
      }
    },
    [selectedTeamMember?.email, effectiveUser?.email]
  );

  const activeChatSyncRef = useRef<number>(0);

  const syncActiveChatPartnerState = useCallback(
    (force: boolean = false) => {
      const partnerEmail = selectedTeamMember?.email ?? null;
      const partnerId = selectedTeamMember?.id ?? null;
      const partnerName = selectedTeamMember?.name ?? null;
      const isActive = Boolean(partnerEmail && isFocused && isAppActive);

      if (!isActive) {
        return;
      }

      const now = Date.now();
      const throttleWindow = Platform.OS === 'web' ? 10000 : userActiveRef.current ? 20000 : 60000;
      if (!force && now - activeChatSyncRef.current < throttleWindow) {
        return;
      }

      activeChatSyncRef.current = now;

      notificationService
        .setActiveChatPartner(partnerEmail, {
          partnerId,
          partnerName,
          isActive,
        })
        .catch(error => {
          logger.debug('Failed to sync active chat partner state', error);
        });
    },
    [isFocused, isAppActive, selectedTeamMember?.email, selectedTeamMember?.id, selectedTeamMember?.name]
  );

  useEffect(() => {
    const partnerEmail = selectedTeamMember?.email ?? null;
    const partnerId = selectedTeamMember?.id ?? null;
    const partnerName = selectedTeamMember?.name ?? null;

    if (!isFocused) {
      notificationService
        .setActiveChatPartner(null, {
          partnerId: null,
          partnerName: null,
          isActive: false,
        })
        .catch(error => {
          logger.debug('Failed to clear active chat partner state', error);
        });
      return;
    }

    if (!partnerEmail) {
      notificationService
        .setActiveChatPartner(null, {
          partnerId: null,
          partnerName: null,
          isActive: false,
        })
        .catch(error => {
          logger.debug('Failed to clear active chat partner state', error);
        });
      return;
    }

    notificationService
      .setActiveChatPartner(partnerEmail, {
        partnerId,
        partnerName,
        isActive: true,
      })
      .catch(error => {
        logger.debug('Failed to sync active chat partner state', error);
      });

    notificationService.clearChatNotificationsForSender(partnerEmail).catch(error => {
      logger.debug('Failed to clear chat notifications for active chat', error);
    });

    activeChatSyncRef.current = Date.now();
  }, [isFocused, selectedTeamMember?.email, selectedTeamMember?.id, selectedTeamMember?.name]);

  useEffect(() => {
    if (!isFocused || !selectedTeamMember?.email || !isAppActive) {
      return;
    }

    const presenceGraceMs = 120000;
    const idleDuration = Date.now() - lastUserActivityAt;
    const recentlyActive = isUserActiveInChat || idleDuration < presenceGraceMs;

    if (!recentlyActive) {
      return;
    }

    const intervalMs = Platform.OS === 'web' ? 15000 : (isUserActiveInChat ? 30000 : 60000);
    syncActiveChatPartnerState(true);
    const interval = setInterval(() => {
      syncActiveChatPartnerState(false);
    }, intervalMs);

    let watchdogTimeout: ReturnType<typeof setTimeout> | null = null;
    if (!isUserActiveInChat && idleDuration < presenceGraceMs) {
      const remaining = Math.max(presenceGraceMs - idleDuration, 0);
      watchdogTimeout = setTimeout(() => {
        setPresenceIdleTick((tick) => tick + 1);
      }, remaining + 50);
    }

    return () => {
      clearInterval(interval);
      if (watchdogTimeout) {
        clearTimeout(watchdogTimeout);
      }
    };
  }, [
    isFocused,
    selectedTeamMember?.email,
    syncActiveChatPartnerState,
    isAppActive,
    isUserActiveInChat,
    lastUserActivityAt,
    presenceIdleTick,
  ]);

  // Track user activity to keep active chat heartbeat fresh and prevent notifications during active chat usage
  useEffect(() => {
    if (!selectedTeamMember) {
      setIsUserActiveInChat(false);
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }
      userActiveRef.current = false;
      return;
    }

    const markUserActive = () => {
      const nowTs = Date.now();
      lastUserActivityRef.current = nowTs;
      setLastUserActivityAt(nowTs);
      setIsUserActiveInChat(true);
      userActiveRef.current = true;
      syncActiveChatPartnerState(false);

      // Clear existing timeout
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }

      // Set user as inactive after 30 seconds of no activity
      userActivityTimeoutRef.current = setTimeout(() => {
        userActiveRef.current = false;
        setIsUserActiveInChat(false);
        const inactiveAt = Date.now();
        lastUserActivityRef.current = inactiveAt;
        setLastUserActivityAt(inactiveAt);
        setPresenceIdleTick((tick) => tick + 1);
      }, 30000);
    };

    markUserActive();

    // Add event listeners for user activity (only on web)
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const activityEvents = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'];

      activityEvents.forEach(event => {
        document.addEventListener(event, markUserActive, true);
      });

      return () => {
        if (userActivityTimeoutRef.current) {
          clearTimeout(userActivityTimeoutRef.current);
        }

        activityEvents.forEach(event => {
          document.removeEventListener(event, markUserActive, true);
        });
      };
    }

    return () => {
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }
      userActiveRef.current = false;
      const resetTs = Date.now();
      lastUserActivityRef.current = resetTs;
      setLastUserActivityAt(resetTs);
      setPresenceIdleTick((tick) => tick + 1);
    };
  }, [selectedTeamMember, syncActiveChatPartnerState]);

  // Reset activity state when switching chats
  useEffect(() => {
    setIsUserActiveInChat(false);
    if (userActivityTimeoutRef.current) {
      clearTimeout(userActivityTimeoutRef.current);
    }
    userActiveRef.current = false;
    const resetTs = Date.now();
    lastUserActivityRef.current = resetTs;
    setLastUserActivityAt(resetTs);
    setPresenceIdleTick((tick) => tick + 1);
  }, [selectedTeamMember?.id]);

  useEffect(() => {
    return () => {
      notificationService.setActiveChatPartner(null, { isActive: false }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    return () => {
      stopAnchorStabilization();
    };
  }, [stopAnchorStabilization]);

  useEffect(() => {
    return () => {
      if (scrollToBottomRetryTimeoutRef.current) {
        clearTimeout(scrollToBottomRetryTimeoutRef.current);
        scrollToBottomRetryTimeoutRef.current = null;
      }
    };
  }, []);

  // Removed keyboard sticker tip behavior per request

  const formatLastMessageTime = useCallback((timestamp: string): string => {
    try {
      const messageDate = new Date(timestamp);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const messageDay = new Date(messageDate);
      messageDay.setHours(0, 0, 0, 0);

      const diffInDays = Math.floor((today.getTime() - messageDay.getTime()) / (1000 * 60 * 60 * 24));

      if (diffInDays === 0) {
        // Today - show time
        return messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (diffInDays === 1) {
        // Yesterday
        return 'Yesterday';
      } else if (diffInDays <= 6) {
        // This week - show day name
        return messageDate.toLocaleDateString([], { weekday: 'short' });
      } else {
        // Older - show date
        return messageDate.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
    } catch (error) {
      return '';
    }
  }, []);

  const buildSummaryMap = useCallback((records: Record<string, ConversationSummary>) => {
    const targetTenantId = activeTenant?.id?.trim();
    if (!targetTenantId) {
      return new Map();
    }

    const viewerEmail = effectiveUser?.email;

    return new Map(
      Object.entries(records || {})
        // Tenant scope + self-conversation exclusion: a self-conversation is not a
        // supported feature and must never appear in the conversation list.
        .filter(
          ([email, summary]) =>
            summary?.tenantId?.trim() === targetTenantId &&
            !isSelfConversation({
              partnerEmail: summary.partnerEmail ?? email,
              viewerEmail,
            })
        )
        .map(([email, summary]) => [email.toLowerCase(), summary])
    );
  }, [activeTenant?.id, effectiveUser?.email]);

  const refreshChatSummaries = useCallback(async (_options?: { silent?: boolean }) => {
    if (!effectiveUser?.email || !activeTenant?.id) {
      setConversationSummaries(new Map());
      return;
    }

    try {
      await chatService.rebuildConversationSummariesForUser(effectiveUser.email).catch((error) => {
        logger.warn('Failed to rebuild conversation summaries before refresh', error);
      });
      // Reconcile stored unread counts against the true-unread set and clean up any
      // stuck self-conversation summary/mirror so the badge converges and cannot
      // regenerate. Idempotent and bounded (O(unread)).
      await chatService.reconcileUnreadForUser(effectiveUser.email).catch((error) => {
        logger.debug('Failed to reconcile unread state before refresh', error);
      });
      const records = await chatService.getConversationSummaries(effectiveUser.email);
      setConversationSummaries(buildSummaryMap(records));
    } catch (error) {
      logger.warn('Failed to refresh conversation summaries', error);
    }
  }, [effectiveUser?.email, activeTenant?.id, buildSummaryMap]);

  const repairConversationUnreadState = useCallback(async () => {
    const eligibility = resolveChatUnreadRepairEligibility({
      userEmail: effectiveUser?.email,
      partnerEmail: selectedTeamMember?.email,
      isFocused,
      isAppActive,
      inFlight: unreadRepairInFlightRef.current,
      lastPartnerEmail: lastUnreadRepairAtRef.current.partnerEmail,
      lastRunAtMs: lastUnreadRepairAtRef.current.at,
    });

    if (!eligibility.shouldRun || !eligibility.userEmail || !eligibility.partnerEmail) {
      return;
    }

    const userEmail = eligibility.userEmail;
    const partnerEmail = eligibility.partnerEmail;

    unreadRepairInFlightRef.current = true;
    lastUnreadRepairAtRef.current = { partnerEmail, at: eligibility.nowMs };
    const repairStartedAt = Date.now();

    try {
      const fixedCount = await chatService.markConversationAsRead(userEmail, partnerEmail);

      logger.metric(
        'chat.unread.repair.run',
        resolveChatUnreadRepairRunPayload(partnerEmail, fixedCount, repairStartedAt)
      );

      await chatService.rebuildConversationSummariesForUser(userEmail);
      await refreshChatSummaries();
    } catch (error) {
      logger.warn('Failed to repair stale unread conversation state', {
        error,
        partnerEmail,
      });
    } finally {
      unreadRepairInFlightRef.current = false;
    }
  }, [effectiveUser?.email, selectedTeamMember?.email, isFocused, isAppActive, refreshChatSummaries]);

  useEffect(() => {
    if (!selectedTeamMember?.email || !effectiveUser?.email || !isFocused || !isAppActive) {
      clearTimeoutRef(unreadRepairTimeoutRef);
      return;
    }

    scheduleTimeoutRef(unreadRepairTimeoutRef, () => {
      void repairConversationUnreadState();
    }, 600);

    return () => {
      clearTimeoutRef(unreadRepairTimeoutRef);
    };
  }, [selectedTeamMember?.email, effectiveUser?.email, isFocused, isAppActive, repairConversationUnreadState]);

  useEffect(() => {
    const now = Date.now();
    const isForegroundInteractive = Boolean(isFocused && isAppActive);
    const shouldRefresh = shouldRefreshChatSummariesOnForegroundResume({
      isFocused,
      isAppActive,
      wasForegroundInteractive: wasForegroundInteractiveRef.current,
      hasUserEmail: Boolean(effectiveUser?.email),
      hasTenantId: Boolean(activeTenant?.id),
      now,
      lastForegroundRefreshAt: lastForegroundRefreshAtRef.current,
      throttleMs: 20000,
    });
    wasForegroundInteractiveRef.current = isForegroundInteractive;

    if (!shouldRefresh) {
      return;
    }

    const lastBackgroundAt = lastBackgroundAtRef.current;
    const foregroundIdleMs = lastBackgroundAt ? now - lastBackgroundAt : 0;
    const MIN_BACKGROUND_IDLE_BEFORE_REFRESH_MS = 60000;
    if (foregroundIdleMs < MIN_BACKGROUND_IDLE_BEFORE_REFRESH_MS) {
      return;
    }

    lastForegroundRefreshAtRef.current = now;

    void refreshChatSummaries();
  }, [
    isFocused,
    isAppActive,
    effectiveUser?.email,
    activeTenant?.id,
    refreshChatSummaries,
  ]);

  const loadTenantTeamMembers = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    const requestId = ++tenantMembersRequestIdRef.current;
    const hasVisibleLoader = !silent;

    if (!activeTenant?.id) {
      if (tenantMembersRequestIdRef.current === requestId) {
        tenantRosterRef.current = [];
        setTeamMembers([]);
        setTeamMembersError(null);
        setTeamMembersLoading(false);
        presenceSnapshotRef.current = new Map();
      }
      if (hasVisibleLoader) {
        teamMembersVisibleLoadCountRef.current = Math.max(0, teamMembersVisibleLoadCountRef.current - 1);
      }
      return;
    }

    if (hasVisibleLoader) {
      teamMembersVisibleLoadCountRef.current += 1;
      setTeamMembersLoading(true);
    }
    setTeamMembersError(null);

    try {
      const memberships = await tenantService.getActiveMembershipsForTenant(activeTenant.id);
      if (tenantMembersRequestIdRef.current !== requestId) {
        return;
      }

      const normalizedMembers: TeamMember[] = memberships
        .filter((membership) => typeof membership.email === 'string' && membership.email.trim().length > 0)
        .map((membership) => {
          const normalizedEmail = membership.email.trim().toLowerCase();
          const localPart = normalizedEmail.split('@')[0] || normalizedEmail;
          const derivedName = (membership.displayName?.trim() || localPart)
            .replace(/[._-]+/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
          const initials = derivedName.charAt(0).toUpperCase() || 'U';

          return {
            id: normalizedEmail,
            name: derivedName,
            email: normalizedEmail,
            avatar: initials,
            role: membership.role === 'owner' || membership.role === 'admin' ? 'admin' : 'user',
            tenantRole: membership.role,
            photoURL: undefined,
            customImageURL: undefined,
            isOnline: false,
            lastSeen: undefined,
            typingTo: undefined,
          } satisfies TeamMember;
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      tenantRosterRef.current = normalizedMembers;
      const filteredPresence = buildPresenceSnapshotForRoster(normalizedMembers);
      const filteredProfiles = buildProfileSnapshotForRoster(normalizedMembers);
      presenceSnapshotRef.current = filteredPresence;
      profileSnapshotRef.current = filteredProfiles;
      setTeamMembers(mergeRosterWithPresence(normalizedMembers, filteredPresence, filteredProfiles));
    } catch (error) {
      logger.warn('Chat: failed to load tenant members', { error, tenantId: activeTenant?.id });
      if (tenantMembersRequestIdRef.current !== requestId) {
        return;
      }
      tenantRosterRef.current = [];
      setTeamMembers([]);
      setTeamMembersError('Unable to load team members. Pull to refresh to try again.');
      presenceSnapshotRef.current = new Map();
      profileSnapshotRef.current = new Map();
    } finally {
      if (hasVisibleLoader) {
        teamMembersVisibleLoadCountRef.current = Math.max(0, teamMembersVisibleLoadCountRef.current - 1);
        setTeamMembersLoading(teamMembersVisibleLoadCountRef.current > 0);
      }
    }
  }, [activeTenant?.id, buildPresenceSnapshotForRoster, buildProfileSnapshotForRoster, mergeRosterWithPresence]);

  useEffect(() => {
    loadTenantTeamMembers();
  }, [loadTenantTeamMembers]);

  useFocusEffect(
    useCallback(() => {
      if (selectedTeamMember) {
        return;
      }

      void refreshChatSummaries({ silent: true });
      void loadTenantTeamMembers({ silent: true });
    }, [selectedTeamMember, refreshChatSummaries, loadTenantTeamMembers])
  );

  useEffect(() => {
    if (!activeTenant?.id) {
      rawProfileSnapshotRef.current = new Map();
      rawPresenceSnapshotRef.current = new Map();
      profileSnapshotRef.current = new Map();
      presenceSnapshotRef.current = new Map();
      setTeamMembers(mergeRosterWithPresence(tenantRosterRef.current, new Map(), new Map()));
      return;
    }

    const profileQuery = query(
      collection(firestore, 'tenantProfiles'),
      where('tenantId', '==', activeTenant.id)
    );

    const unsubscribeProfiles = onSnapshot(
      profileQuery,
      (snapshot) => {
        const profileMap = new Map<string, TeamMember>();
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const emailKey = String(data?.email || '').toLowerCase().trim();
          if (!emailKey) {
            return;
          }

          profileMap.set(emailKey, {
            id: emailKey,
            email: emailKey,
            name: typeof data?.displayName === 'string' ? data.displayName.trim() : '',
            avatar: '',
            role: 'user',
            photoURL: typeof data?.photoURL === 'string' ? data.photoURL : undefined,
            customImageURL: typeof data?.customImageURL === 'string' ? data.customImageURL : undefined,
            school: typeof data?.school === 'string' ? data.school : undefined,
            bio: typeof data?.bio === 'string' ? data.bio : undefined,
            phone: typeof data?.phone === 'string' ? data.phone : undefined,
            dateOfBirth: typeof data?.dateOfBirth === 'string' ? data.dateOfBirth : undefined,
            salutation: data?.salutation === 'Mr.' || data?.salutation === 'Ms.' ? data.salutation : undefined,
            subjects: Array.isArray(data?.subjects) ? data.subjects : undefined,
          });
        });

        rawProfileSnapshotRef.current = profileMap;
        const filteredProfiles = buildProfileSnapshotForRoster(tenantRosterRef.current);
        profileSnapshotRef.current = filteredProfiles;
        setTeamMembers(
          mergeRosterWithPresence(
            tenantRosterRef.current,
            presenceSnapshotRef.current,
            filteredProfiles
          )
        );
      },
      (error) => {
        logger.warn('Chat: tenantProfiles listener failed', { error, tenantId: activeTenant.id });
      }
    );

    const presenceQuery = query(
      collection(firestore, 'tenantPresence'),
      where('tenantId', '==', activeTenant.id)
    );

    const unsubscribe = onSnapshot(
      presenceQuery,
      (snapshot) => {
        const presenceMap = new Map<string, TeamMember>();
        snapshot.forEach((docSnap) => {
          const data = docSnap.data() as any;
          const emailKey = String(data?.email || '').toLowerCase().trim();
          if (!emailKey) {
            return;
          }

          const typingTo = data?.typingTo == null ? undefined : String(data.typingTo).toLowerCase().trim();

          presenceMap.set(emailKey, {
            id: emailKey,
            email: emailKey,
            name: '',
            avatar: '',
            role: 'user',
            isOnline: resolveChatRealtimeOnline({
              isOnline: data?.isOnline,
              lastSeen: data?.lastSeen,
              presenceMode: CHAT_PRESENCE_MODE,
              presenceThresholdMin: CHAT_PRESENCE_THRESHOLD_MIN,
            }),
            lastSeen: typeof data?.lastSeen === 'string' ? data.lastSeen : undefined,
            typingTo,
          });
        });

        rawPresenceSnapshotRef.current = presenceMap;
        const filtered = buildPresenceSnapshotForRoster(tenantRosterRef.current);
        presenceSnapshotRef.current = filtered;
        setTeamMembers(
          mergeRosterWithPresence(
            tenantRosterRef.current,
            filtered,
            profileSnapshotRef.current
          )
        );
      },
      (error) => {
        logger.warn('Chat: tenantPresence listener failed', { error, tenantId: activeTenant.id });
      }
    );

    return () => {
      try {
        unsubscribeProfiles?.();
      } catch {}
      try {
        unsubscribe?.();
      } catch {}
    };
  }, [activeTenant?.id, buildPresenceSnapshotForRoster, buildProfileSnapshotForRoster, mergeRosterWithPresence]);

  // Subscribe to conversation summaries for the current user
  useEffect(() => {
    if (!effectiveUser?.email || !activeTenant?.id) {
      setConversationSummaries(new Map());
      return;
    }

    let isActive = true;

    const bootstrap = async () => {
      try {
        await chatService.rebuildConversationSummariesForUser(effectiveUser.email);
      } catch (error) {
        if (isActive) {
          logger.warn('Failed to rebuild conversation summaries', error);
        }
      }

      try {
        const records = await chatService.getConversationSummaries(effectiveUser.email);
        if (isActive) {
          setConversationSummaries(buildSummaryMap(records));
        }
      } catch (error) {
        if (isActive) {
          logger.warn('Failed to fetch conversation summaries', error);
        }
      }
    };

    void bootstrap();

    const unsubscribe = chatService.onConversationSummariesChange(
      effectiveUser.email,
      (records) => {
        if (!isActive) return;
        setConversationSummaries(buildSummaryMap(records));
      }
    );

    return () => {
      isActive = false;
      unsubscribe?.();
    };
  }, [effectiveUser?.email, activeTenant?.id, buildSummaryMap]);

  // Merge team member list with latest conversation summaries
  useEffect(() => {
    if (teamMembers.length === 0) {
      setTeamMembersWithChatInfo([]);
      return;
    }

    const merged = teamMembers.map((member) => {
      const emailKey = (member.email || '').toLowerCase();
      const summary = conversationSummaries.get(emailKey);

      let lastMessage: TeamMemberWithChatInfo['lastMessage'] | null = null;
      let lastMessageTime = '';
      if (summary?.lastMessage) {
        lastMessage = {
          text: summary.lastMessage.text,
          timestamp: summary.lastMessage.timestamp,
          isOwnMessage: summary.lastMessage.isOwnMessage,
          delivered: summary.lastMessage.delivered,
          read: summary.lastMessage.read,
        };
        lastMessageTime = formatLastMessageTime(summary.lastMessage.timestamp);
      }

      return {
        ...member,
        isOnline: resolveChatRealtimeOnline({
          isOnline: member.isOnline,
          lastSeen: member.lastSeen,
          presenceMode: CHAT_PRESENCE_MODE,
          presenceThresholdMin: CHAT_PRESENCE_THRESHOLD_MIN,
        }),
        unreadCount: summary?.unreadCount ?? 0,
        lastMessage,
        lastMessageTime,
        summaryUpdatedAt: summary?.updatedAt,
        pinnedSerial: pinnedChats[chatPreferencesService.sanitizeEmailKey(member.email)] || undefined,
      };
    });

    setTeamMembersWithChatInfo(merged);
  }, [teamMembers, conversationSummaries, pinnedChats, formatLastMessageTime, presenceRenderTick]);

  // Reactions are stored on the message record and streamed via chat realtime updates.
  // Derive a local Map keyed by message id for existing UI rendering.
  useEffect(() => {
    if (!selectedTeamMember?.id) {
      setLocalMessageReactions(() => new Map());
      return;
    }

    const next = new Map<string, { [key: string]: Set<string> }>();
    if (!Array.isArray(messages) || messages.length === 0) {
      setLocalMessageReactions(() => next);
      return;
    }

    messages.forEach((msg: any) => {
      const messageId = msg?.id != null ? String(msg.id) : '';
      if (!messageId) {
        return;
      }

      if (shouldKeepOptimisticReactions(messageId)) {
        const optimistic = messageReactionsRef.current.get(messageId) ?? {};
        next.set(messageId, optimistic);
        return;
      }

      const raw = msg?.reactions;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return;
      }

      const sets: { [key: string]: Set<string> } = {};
      Object.entries(raw as Record<string, any>).forEach(([reactionType, users]) => {
        if (Array.isArray(users) && users.length > 0) {
          sets[reactionType] = new Set(users.filter((u: any) => typeof u === 'string'));
        }
      });

      if (Object.keys(sets).length > 0) {
        next.set(messageId, sets);
      }
    });

    setLocalMessageReactions(() => next);

    const expiryIds = resolveChatOptimisticReactionExpiryIds(
      reactionOptimisticUntilRef.current,
      new Set<string>(Array.from(next.keys())),
      Date.now()
    );
    expiryIds.forEach((messageId) => {
      reactionOptimisticUntilRef.current.delete(messageId);
    });
  }, [messages, selectedTeamMember?.id, shouldKeepOptimisticReactions]);

  // Typing indicator derived from presence system (Firestore typingTo).
  useEffect(() => {
    if (!effectiveUserEmail || !selectedTeamMember?.email) {
      setIsTyping(false);
      return;
    }

    if (!isAppActive || !isUserActiveInChat) {
      setIsTyping(false);
      return;
    }

    const typingTo = String(selectedTeamMember.typingTo || '').toLowerCase().trim();
    const isTypingNow = typingTo.length > 0 && typingTo === effectiveUserEmail.toLowerCase().trim();
    setIsTyping(isTypingNow);
  }, [effectiveUserEmail, selectedTeamMember?.email, selectedTeamMember?.typingTo, isAppActive, isUserActiveInChat]);

  // Detect new messages for animations
  useEffect(() => {
    const chatKey = String(selectedTeamMember?.id || selectedTeamMember?.email || '');
    const normalizedPartnerEmail = normalizeParticipantEmail(selectedTeamMember?.email);
    const normalizedUserEmail = normalizeParticipantEmail(effectiveUser?.email);

    if (!chatKey || !normalizedPartnerEmail || !normalizedUserEmail || !displayedMessages || displayedMessages.length === 0) {
      previousMessageIdsRef.current = new Set();
      setAnimatedMessages(new Set()); // Clear animations when no messages
      return;
    }

    const selectedConversationMessages: any[] = [];
    const currentMessageIds = new Set<string>();

    displayedMessages.forEach((msg: any) => {
      if (!msg?.id || msg?.deleted) {
        return;
      }

      const sender = normalizeParticipantEmail(msg?.sender);
      const recipient = normalizeParticipantEmail(msg?.recipientId);
      const belongsToSelectedConversation = (
        (sender === normalizedPartnerEmail && recipient === normalizedUserEmail) ||
        (sender === normalizedUserEmail && recipient === normalizedPartnerEmail)
      );
      if (!belongsToSelectedConversation) {
        return;
      }

      selectedConversationMessages.push(msg);
      currentMessageIds.add(String(msg.id));
    });

    // On first render for a chat, set baseline IDs and skip tone/animation for existing backlog.
    if (toneBootstrapChatKeyRef.current !== chatKey) {
      toneBootstrapChatKeyRef.current = chatKey;
      previousMessageIdsRef.current = currentMessageIds;
      setAnimatedMessages(new Set());
      return;
    }

    const previousMessageIds = previousMessageIdsRef.current;
    const newMessageIds = new Set<string>();

    // Find messages that are in current set but not in previous set
    for (const id of currentMessageIds) {
      if (!previousMessageIds.has(id)) {
        newMessageIds.add(id);
      }
    }

    // Add new messages to animated set (but only if we had previous messages to compare with)
    // This prevents animations during initial load
    if (previousMessageIds.size > 0 && newMessageIds.size > 0) {
      const canAttemptTone =
        isFocused &&
        isAppActive &&
        !loading &&
        isInitialAnchorSettled &&
        isChatBootstrapGateDone &&
        Date.now() >= messageToneCooldownUntilRef.current;

      if (canAttemptTone) {
        const hasFreshIncomingNewMessage = selectedConversationMessages.some((msg: any) => {
          const messageId = msg?.id != null ? String(msg.id) : '';
          if (!messageId || !newMessageIds.has(messageId)) {
            return false;
          }

          const sender = normalizeParticipantEmail(msg?.sender);
          const recipient = normalizeParticipantEmail(msg?.recipientId);
          if (sender !== normalizedPartnerEmail || recipient !== normalizedUserEmail) {
            return false;
          }

          const timestampMs = resolveChatTimestampMs(msg?.timestamp);
          if (timestampMs > 0 && timestampMs < messageToneEligibleSinceRef.current - TONE_HISTORICAL_TIMESTAMP_GRACE_MS) {
            return false;
          }

          return true;
        });

        if (hasFreshIncomingNewMessage) {
          playMessageSound();
        }
      }

      setAnimatedMessages(prev => {
        const updated = new Set(prev);
        newMessageIds.forEach(id => updated.add(id));
        return updated;
      });

      // Clear animated messages after animation completes (cancellable via ref)
      scheduleTimeoutRef(animatedMessageCleanupTimerRef, () => {
        setAnimatedMessages(prev => {
          const updated = new Set(prev);
          newMessageIds.forEach(id => updated.delete(id));
          return updated;
        });
      }, 1000);
    }

    previousMessageIdsRef.current = currentMessageIds;
  }, [
    displayedMessages,
    selectedTeamMember?.id,
    effectiveUser?.email,
    isAppActive,
    isFocused,
    loading,
    isInitialAnchorSettled,
    isChatBootstrapGateDone,
    normalizeParticipantEmail,
    playMessageSound,
    selectedTeamMember?.email,
  ]);

  // Use useMemo to properly handle filtering when user or teamMembers change
  const filteredTeamMembers = useMemo(() => {
    return resolveChatFilteredTeamMembers({
      members: teamMembersWithChatInfo,
      pinnedChats,
      currentUserEmail: effectiveUser?.email,
      searchQuery,
      sanitizeEmailKey: chatPreferencesService.sanitizeEmailKey,
    });
  }, [effectiveUser?.email, teamMembersWithChatInfo, pinnedChats, searchQuery]);

  const messageRowMetaById = useMemo(() => {
    return resolveChatMessageRowMetaState({
      displayedMessages,
      normalizeMessageId,
      sanitizeDateSeparatorLabel,
      resolveDateSeparator: (currentTimestamp, previousTimestamp) =>
        getChatDateSeparator(
          currentTimestamp as string,
          previousTimestamp as string | undefined
        ),
    });
  }, [displayedMessages, normalizeMessageId, sanitizeDateSeparatorLabel]);

  // ── Phase 4: sync remaining renderMessageItem refs ──
  useEffect(() => {
    messageRowMetaByIdRef.current = messageRowMetaById;
  }, [messageRowMetaById]);
  useEffect(() => {
    showNewDividerRef.current = showNewDivider;
    newDividerMessageIdRef.current = newDividerMessageId;
  }, [showNewDivider, newDividerMessageId]);
  useEffect(() => {
    unreadDividerLabelRef.current = unreadDividerLabel;
  }, [unreadDividerLabel]);

  const scrollToBottom = (animated: boolean = true, delay: number = 100, skipAutoFlag: boolean = false) => {
    if (scrollToBottomRetryTimeoutRef.current) {
      clearTimeout(scrollToBottomRetryTimeoutRef.current);
      scrollToBottomRetryTimeoutRef.current = null;
    }

    if (!skipAutoFlag) {
      isAutoScrollingRef.current = true;
    }

    const MAX_SCROLL_ATTEMPTS = 8;
    const BOTTOM_GAP_THRESHOLD = 12;
    const bottomBuffer = bottomVisibilityPadding;
    const effectiveBottomThreshold = bottomBuffer + BOTTOM_GAP_THRESHOLD;

    const runScroll = (attempt: number) => {
      const list = flatListRef.current as any;
      const useAnimated = attempt === 0 ? animated : false;

      const contentH = contentHeightRef.current || 0;
      const layoutH = layoutHeightRef.current || 0;
      const targetOffset = Math.max(0, contentH - layoutH);

      if (list?.scrollToOffset) {
        list.scrollToOffset({ offset: targetOffset, animated: useAnimated });
      } else if (list?.scrollToEnd) {
        list.scrollToEnd({ animated: useAnimated });
      } else if (scrollViewRef.current?.scrollTo) {
        scrollViewRef.current.scrollTo({ y: targetOffset, animated: useAnimated });
      } else if (scrollViewRef.current?.scrollToEnd) {
        scrollViewRef.current.scrollToEnd({ animated: useAnimated });
      }

      const settleDelay = useAnimated ? 200 : 80;

      scrollToBottomRetryTimeoutRef.current = setTimeout(() => {
        const contentH = contentHeightRef.current || 0;
        const layoutH = layoutHeightRef.current || 0;
        const currentOffset = lastScrollOffsetRef.current || 0;
        const distanceFromBottom = Math.max(0, contentH - layoutH - currentOffset);

        if (distanceFromBottom <= effectiveBottomThreshold || isAtBottomRef.current) {
          scrollToBottomRetryTimeoutRef.current = null;
          isAtBottomRef.current = true;
          if (anchoredTargetRef.current?.type === 'bottom') {
            stopAnchorStabilization();
          }
          if (!skipAutoFlag) {
            setTimeout(() => {
              isAutoScrollingRef.current = false;
            }, useAnimated ? 300 : 120);
          }
          return;
        }

        if (attempt + 1 >= MAX_SCROLL_ATTEMPTS) {
          scrollToBottomRetryTimeoutRef.current = null;
          if (!skipAutoFlag) {
            isAutoScrollingRef.current = false;
          }
          return;
        }

        runScroll(attempt + 1);
      }, settleDelay);
    };

    scrollToBottomRetryTimeoutRef.current = setTimeout(() => runScroll(0), Math.max(0, delay));
  };

  const scheduleScrollToBottom = (
    options?: {
      animated?: boolean;
      delay?: number;
      skipAutoFlag?: boolean;
      immediate?: boolean;
    }
  ) => {
    const { animated = true, delay = 100, skipAutoFlag = false, immediate = false } = options ?? {};
    const run = () => scrollToBottom(animated, immediate ? 0 : delay, skipAutoFlag);

    // ── Immediate path (user-initiated sends) ──────────────────────────────
    //    InteractionManager.runAfterInteractions waits for every in-flight
    //    interaction/animation to finish before running its callback. The
    //    optimistic bubble's own entrance animation (Animated.timing) registers
    //    an interaction handle, so routing the sender's snap-to-bottom through
    //    InteractionManager held the scroll until that animation (and any
    //    others) completed — which is exactly why a freshly sent message
    //    appeared seconds late on the sender's device even though it had
    //    already been delivered. For sends we bypass InteractionManager and
    //    scroll on the next frame. A double rAF guarantees the newly inserted
    //    footer bubble is committed and laid out before we compute the bottom
    //    offset; the scrollToBottom retry loop then settles any residual gap.
    if (immediate) {
      const raf = globalThis.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(() => {
          if (typeof raf === 'function') {
            raf(run);
          } else {
            run();
          }
        });
      } else {
        setTimeout(run, 0);
      }
      return;
    }

    if (InteractionManager?.runAfterInteractions) {
      InteractionManager.runAfterInteractions(run);
      return;
    }

    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(run);
      return;
    }

    setTimeout(run, 0);
  };

  const scrollToMessage = (messageId: string, animated: boolean = false) => {
    if (!flatListRef.current) return false;

    const normalizedTargetId = normalizeMessageId(messageId);
    if (!normalizedTargetId) {
      return false;
    }

    const index = displayedMessageIndexRef.current.get(normalizedTargetId) ?? -1;
    if (index === -1) return false;

    try {
      (flatListRef.current as any).scrollToIndex({
        index,
        animated,
        viewPosition: 0.3, // Show message at 30% from top
      });
      onScrollFailAttemptsRef.current = 0;
      return true;
    } catch (error) {
      logger.warn('Failed to scroll to message:', error);
      return false;
    }
  };

  const markAutoScroll = useCallback((duration: number = 260) => {
    isAutoScrollingRef.current = true;
    scheduleTimeoutRef(autoScrollFlagTimerRef, () => {
      isAutoScrollingRef.current = false;
    }, duration);
  }, []);

  const clearReplyJumpHighlightTimer = useCallback(() => {
    clearTimeoutRef(replyJumpHighlightTimerRef);
  }, []);

  const clearScheduledConversationSearchHistoryLoad = useCallback(() => {
    clearTimeoutRef(conversationSearchLoadDebounceTimerRef);
  }, []);

  const triggerReplyJumpHighlight = useCallback(
    (messageId: string) => {
      const normalizedMessageId = normalizeReplyJumpTargetMessageId(messageId);
      if (!normalizedMessageId) {
        return;
      }

      const nextFabState = resolveReplyJumpStateForJumpSuccess();
      setShowReplyJumpToLatestSafely(nextFabState.showReplyJumpToLatest);
      setShowScrollToBottomSafely(nextFabState.showScrollToBottom);
      setReplyJumpHighlightMessageId(normalizedMessageId);
      clearReplyJumpHighlightTimer();
      scheduleTimeoutRef(replyJumpHighlightTimerRef, () => {
        setReplyJumpHighlightMessageId((current) =>
          resolveReplyJumpHighlightAfterTimeout(current, normalizedMessageId)
        );
      }, 1800);
    },
    [clearReplyJumpHighlightTimer, setShowReplyJumpToLatestSafely, setShowScrollToBottomSafely]
  );

  useEffect(() => {
    return () => {
      clearReplyJumpHighlightTimer();
    };
  }, [clearReplyJumpHighlightTimer]);

  useEffect(() => {
    replyJumpConversationKeyRef.current = activeComposerDraftKey;
  }, [activeComposerDraftKey]);
  const resetConversationSearchState = useCallback(
    (nextVisible: boolean) => {
      clearScheduledConversationSearchHistoryLoad();
      clearTimeoutRef(conversationSearchShortcutPulseTimerRef);
      conversationSearchLoadTokenRef.current += 1;
      conversationSearchHistoryLoadAttemptsRef.current = 0;
      conversationSearchVisibleRef.current = nextVisible;
      setConversationSearchVisible(nextVisible);
      setConversationSearchQuery('');
      setConversationSearchScope('all');
      setConversationSearchActiveIndex(0);
      setConversationSearchHighlightMessageId(null);
      setConversationSearchKeyboardSuggestionScope(null);
      setConversationSearchShortcutPulseScope(null);
      setIsConversationSearchHistoryLoading(false);
      setShowSearchShortcutTipsModal(false);
      previousConversationSearchQueryRef.current = '';
      previousConversationSearchScopeRef.current = 'all';
    },
    [clearScheduledConversationSearchHistoryLoad]
  );

  const openSearchShortcutTipsModal = useCallback(() => {
    if (!showKeyboardShortcuts) {
      return;
    }
    setShowSearchShortcutTipsModal(true);
  }, [showKeyboardShortcuts]);

  const closeSearchShortcutTipsModal = useCallback(() => {
    setShowSearchShortcutTipsModal(false);
  }, []);

  useEffect(() => {
    if (!showKeyboardShortcuts && showSearchShortcutTipsModal) {
      setShowSearchShortcutTipsModal(false);
    }
  }, [showKeyboardShortcuts, showSearchShortcutTipsModal]);

  useEffect(() => {
    setShowReplyJumpToLatestSafely(false);
    setReplyJumpHighlightMessageId(null);
    clearReplyJumpHighlightTimer();
    resetConversationSearchState(false);
  }, [
    activeComposerDraftKey,
    activeTenant?.id,
    clearReplyJumpHighlightTimer,
    resetConversationSearchState,
    setShowReplyJumpToLatestSafely,
  ]);

  const jumpToReplyMessage = useCallback(
    async (replyContext?: ChatReplyContext | null, options?: { silent?: boolean }): Promise<boolean> => {
      const metricSource: ChatReplyJumpMetricSource = options?.silent ? 'silent' : 'interactive';
      const targetMessageId = normalizeMessageId(replyContext?.messageId);
      if (!targetMessageId) {
        recordReplyJumpMetric('invalid-target', false, 0, metricSource);
        return false;
      }

      if (jumpingToReplyRef.current) {
        return false;
      }

      const tryScrollToTarget = (messageId: string, animated: boolean) => {
        markAutoScroll();
        return scrollToMessage(messageId, animated);
      };

      const jumpConversationKey = replyJumpConversationKeyRef.current;
      let jumpWasCancelled = false;

      jumpingToReplyRef.current = true;
      try {
        const jumpResult = await executeChatReplyJump({
          targetMessageId,
          tryScrollToMessage: tryScrollToTarget,
          canLoadMoreHistory: () => hasMoreRef.current,
          loadOlderMessages: async () => {
            await requestOlderMessagesRef.current?.('auto');
          },
          maxLoadAttempts: 4,
          shouldContinue: () => replyJumpConversationKeyRef.current === jumpConversationKey,
        });

        recordReplyJumpMetric(
          jumpResult.reason,
          jumpResult.success,
          jumpResult.usedHistoryLoads,
          metricSource
        );

        jumpWasCancelled = jumpResult.reason === 'cancelled';

        if (jumpResult.success) {
          triggerReplyJumpHighlight(targetMessageId);
          return true;
        }
      } finally {
        jumpingToReplyRef.current = false;
      }

      if (jumpWasCancelled) {
        return false;
      }

      if (!options?.silent) {
        Toast.show({
          type: 'info',
          text1: 'Original message not available',
          text2: 'It may be outside the loaded chat history.',
          position: 'top',
        });
      }

      return false;
    },
    [markAutoScroll, normalizeMessageId, recordReplyJumpMetric, scrollToMessage, triggerReplyJumpHighlight]
  );

  const closeConversationSearch = useCallback(() => {
    resetConversationSearchState(false);
  }, [resetConversationSearchState]);

  const toggleConversationSearch = useCallback(() => {
    if (conversationSearchVisible) {
      closeConversationSearch();
      return;
    }

    resetConversationSearchState(true);
  }, [closeConversationSearch, conversationSearchVisible, resetConversationSearchState]);

  const clearConversationSearchShortcutPulseTimer = useCallback(() => {
    clearTimeoutRef(conversationSearchShortcutPulseTimerRef);
  }, []);

  const triggerConversationSearchShortcutPulse = useCallback(
    (scope: ChatConversationSearchScope) => {
      setConversationSearchShortcutPulseScope(scope);
      clearConversationSearchShortcutPulseTimer();
      scheduleTimeoutRef(conversationSearchShortcutPulseTimerRef, () => {
        setConversationSearchShortcutPulseScope((currentScope) =>
          currentScope === scope ? null : currentScope
        );
      }, 280);
    },
    [clearConversationSearchShortcutPulseTimer]
  );

  const recordConversationSearchTelemetry = useCallback(
    (
      kind: 'scope-switch' | 'no-result-recovery',
      source: string,
      extra?: Record<string, unknown>
    ) => {
      const payload = recordChatConversationSearchUxRollup(
        conversationSearchTelemetryRef.current,
        kind,
        source
      );

      if (!payload) {
        return;
      }

      logger.metric('chat.conversation_search.ux_rollup', {
        ...payload,
        ...extra,
      });
    },
    []
  );

  const recordConversationSearchNoResultRecovery = useCallback(
    (source: string, extra?: Record<string, unknown>) => {
      if (normalizedConversationSearchQueryRef.current.length <= 0) {
        return;
      }

      if (conversationSearchMatchIdsRef.current.length > 0) {
        return;
      }

      recordConversationSearchTelemetry('no-result-recovery', source, extra);
    },
    [recordConversationSearchTelemetry]
  );

  const recordConversationSearchScopeSwitch = useCallback(
    (source: string, nextScope: ChatConversationSearchScope) => {
      recordConversationSearchTelemetry('scope-switch', source, {
        nextScope,
      });

      recordConversationSearchNoResultRecovery(source, {
        recoveryType: 'scope-switch',
        nextScope,
      });
    },
    [recordConversationSearchNoResultRecovery, recordConversationSearchTelemetry]
  );

  const executeConversationSearchShortcutAction = useCallback(
    (
      shortcutAction: ChatConversationSearchScopeShortcutAction,
      context: {
        scope: ChatConversationSearchScope;
        keyboardSuggestionScope: ChatConversationSearchScope | null;
        normalizedQuery: string;
      }
    ) => {
      if (shortcutAction.type === 'reset-all') {
        if (context.scope !== 'all') {
          recordConversationSearchScopeSwitch('shortcut-reset', 'all');
          triggerConversationSearchShortcutPulse('all');
        }
        setConversationSearchScope('all');
        setConversationSearchActiveIndex(0);
        setConversationSearchKeyboardSuggestionScope(null);
        return;
      }

      if (shortcutAction.type === 'clear-query') {
        recordConversationSearchNoResultRecovery('shortcut-clear-query', {
          recoveryType: 'clear-query',
        });
        clearScheduledConversationSearchHistoryLoad();
        conversationSearchLoadTokenRef.current += 1;
        setIsConversationSearchHistoryLoading(false);
        setConversationSearchQuery('');
        setConversationSearchActiveIndex(0);
        setConversationSearchHighlightMessageId(null);
        setConversationSearchKeyboardSuggestionScope(null);
        return;
      }

      if (shortcutAction.type === 'load-more-history') {
        recordConversationSearchNoResultRecovery('shortcut-load-older', {
          recoveryType: 'load-older',
        });
        scheduleConversationSearchHistoryLoadRef.current(context.normalizedQuery);
        return;
      }

      if (shortcutAction.type === 'step') {
        const nextScope = resolveChatConversationSearchScopeStep(
          context.scope,
          shortcutAction.direction
        );
        if (context.scope !== nextScope) {
          recordConversationSearchScopeSwitch('shortcut-step', nextScope);
          triggerConversationSearchShortcutPulse(nextScope);
        }
        setConversationSearchScope(nextScope);
        setConversationSearchActiveIndex(0);
        setConversationSearchKeyboardSuggestionScope(null);
        return;
      }

      if (shortcutAction.type === 'select-scope') {
        if (context.scope !== shortcutAction.scope) {
          recordConversationSearchScopeSwitch('shortcut-select', shortcutAction.scope);
          triggerConversationSearchShortcutPulse(shortcutAction.scope);
        }
        setConversationSearchScope((currentScope) =>
          currentScope === shortcutAction.scope ? currentScope : shortcutAction.scope
        );
        setConversationSearchActiveIndex(0);
        setConversationSearchKeyboardSuggestionScope(null);
        return;
      }

      const shortcutSuggestions = resolveChatConversationSearchScopeSuggestions(
        conversationSearchScopeMatchCounts,
        context.scope,
        3
      );

      if (shortcutAction.type === 'suggestion-step') {
        const stepSuggestion = resolveChatConversationSearchScopeSuggestionCycle(
          shortcutSuggestions,
          context.keyboardSuggestionScope,
          shortcutAction.direction
        );

        if (stepSuggestion) {
          setConversationSearchKeyboardSuggestionScope(stepSuggestion.scope);
          triggerConversationSearchShortcutPulse(stepSuggestion.scope);
        }
        return;
      }

      if (shortcutAction.type === 'best-suggestion') {
        const bestScopeSuggestion =
          shortcutSuggestions.find(
            (suggestion) => suggestion.scope === context.keyboardSuggestionScope
          ) ||
          resolveChatConversationSearchBestScopeSuggestion(
            conversationSearchScopeMatchCounts,
            context.scope
          );

        if (!bestScopeSuggestion) {
          return;
        }

        if (context.scope !== bestScopeSuggestion.scope) {
          recordConversationSearchScopeSwitch('shortcut-best', bestScopeSuggestion.scope);
          triggerConversationSearchShortcutPulse(bestScopeSuggestion.scope);
        }

        setConversationSearchScope((currentScope) =>
          currentScope === bestScopeSuggestion.scope
            ? currentScope
            : bestScopeSuggestion.scope
        );
        setConversationSearchActiveIndex(0);
        setConversationSearchKeyboardSuggestionScope(bestScopeSuggestion.scope);
        return;
      }

      if (shortcutAction.type === 'suggestion-ordinal') {
        const ordinalSuggestion = resolveChatConversationSearchScopeSuggestionByOrdinal(
          shortcutSuggestions,
          shortcutAction.ordinal
        );

        if (!ordinalSuggestion) {
          return;
        }

        if (context.scope !== ordinalSuggestion.scope) {
          recordConversationSearchScopeSwitch('shortcut-ordinal', ordinalSuggestion.scope);
          triggerConversationSearchShortcutPulse(ordinalSuggestion.scope);
        }

        setConversationSearchScope((currentScope) =>
          currentScope === ordinalSuggestion.scope
            ? currentScope
            : ordinalSuggestion.scope
        );
        setConversationSearchActiveIndex(0);
        setConversationSearchKeyboardSuggestionScope(ordinalSuggestion.scope);
      }
    },
    [
      clearScheduledConversationSearchHistoryLoad,
      conversationSearchScopeMatchCounts,
      recordConversationSearchNoResultRecovery,
      recordConversationSearchScopeSwitch,
      triggerConversationSearchShortcutPulse,
    ]
  );

  useEffect(() => {
    return () => {
      clearConversationSearchShortcutPulseTimer();
    };
  }, [clearConversationSearchShortcutPulseTimer]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') {
      return;
    }

    if (!selectedTeamMember) {
      return;
    }

    const handleConversationSearchShortcut = (event: KeyboardEvent) => {
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
      if (messageInfoModalState.visible) {
        return;
      }

      const isFindShortcut = key === 'f' && (event.metaKey || event.ctrlKey);
      const hasScopeShortcutModifiers =
        conversationSearchVisible &&
        event.altKey &&
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey;

      if (isFindShortcut) {
        event.preventDefault();
        if (!conversationSearchVisible) {
          resetConversationSearchState(true);
          return;
        }

        try {
          conversationSearchInputRef.current?.focus();
        } catch {}
        return;
      }

      if (hasScopeShortcutModifiers) {
        const shortcutAction = resolveChatConversationSearchScopeShortcutAction({
          key: event.key,
          code: event.code,
          altKey: event.altKey === true,
          shiftKey: event.shiftKey === true,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          hasMatches: conversationSearchMatchIdsRef.current.length > 0,
          hasQuery: normalizedConversationSearchQueryRef.current.length > 0,
          hasMoreHistory: hasMoreRef.current,
          isLoadingHistory: isConversationSearchHistoryLoadingRef.current,
        });

        if (shortcutAction) {
          event.preventDefault();

          executeConversationSearchShortcutAction(shortcutAction, {
            scope: conversationSearchScopeRef.current,
            keyboardSuggestionScope: conversationSearchKeyboardSuggestionScopeRef.current,
            normalizedQuery: normalizedConversationSearchQueryRef.current,
          });

          try {
            conversationSearchInputRef.current?.focus();
          } catch {}
          return;
        }
      }

      if (key === 'escape' && conversationSearchVisible) {
        event.preventDefault();
        closeConversationSearch();
      }
    };

    window.addEventListener('keydown', handleConversationSearchShortcut);
    return () => {
      window.removeEventListener('keydown', handleConversationSearchShortcut);
    };
  }, [
    closeConversationSearch,
    conversationSearchVisible,
    executeConversationSearchShortcutAction,
    messageInfoModalState.visible,
    resetConversationSearchState,
    selectedTeamMember,
  ]);

  useEffect(() => {
    conversationSearchVisibleRef.current = conversationSearchVisible;
  }, [conversationSearchVisible]);

  useEffect(() => {
    conversationSearchScopeRef.current = conversationSearchScope;
  }, [conversationSearchScope]);

  useEffect(() => {
    conversationSearchKeyboardSuggestionScopeRef.current =
      conversationSearchKeyboardSuggestionScope;
  }, [conversationSearchKeyboardSuggestionScope]);

  useEffect(() => {
    isConversationSearchHistoryLoadingRef.current = isConversationSearchHistoryLoading;
  }, [isConversationSearchHistoryLoading]);

  useEffect(() => {
    if (!conversationSearchVisible) {
      setConversationSearchKeyboardSuggestionScope(null);
      return;
    }

    if (normalizedConversationSearchQuery.length <= 0 || conversationSearchMatchIds.length > 0) {
      setConversationSearchKeyboardSuggestionScope(null);
    }
  }, [
    conversationSearchMatchIds.length,
    conversationSearchVisible,
    normalizedConversationSearchQuery,
  ]);

  useEffect(() => {
    return () => {
      clearScheduledConversationSearchHistoryLoad();
    };
  }, [clearScheduledConversationSearchHistoryLoad]);

  const loadOlderForConversationSearch = useCallback(
    async (query: string) => {
      const normalizedQuery = normalizeChatConversationSearchQuery(query);
      if (!normalizedQuery) {
        setIsConversationSearchHistoryLoading(false);
        return;
      }

      const MAX_SEARCH_HISTORY_LOADS_PER_QUERY = 12;
      if (conversationSearchHistoryLoadAttemptsRef.current >= MAX_SEARCH_HISTORY_LOADS_PER_QUERY) {
        return;
      }

      const shouldStart = shouldLoadOlderForConversationSearch({
        normalizedQuery,
        matchCount: conversationSearchMatchIdsRef.current.length,
        hasMoreHistory: hasMoreRef.current,
        isLoadingHistory: isConversationSearchHistoryLoadingRef.current,
      });

      if (!shouldStart) {
        return;
      }

      conversationSearchLoadTokenRef.current += 1;
      const currentToken = conversationSearchLoadTokenRef.current;
      setIsConversationSearchHistoryLoading(true);

      let loadAttempts = 0;
      const MAX_SEARCH_HISTORY_LOAD_ATTEMPTS = 4;

      try {
        while (loadAttempts < MAX_SEARCH_HISTORY_LOAD_ATTEMPTS) {
          const isCancelled =
            conversationSearchLoadTokenRef.current !== currentToken ||
            !conversationSearchVisibleRef.current ||
            normalizedConversationSearchQueryRef.current !== normalizedQuery;
          if (isCancelled) {
            break;
          }

          const shouldContinueLoading = shouldLoadOlderForConversationSearch({
            normalizedQuery,
            matchCount: conversationSearchMatchIdsRef.current.length,
            hasMoreHistory: hasMoreRef.current,
            isLoadingHistory: false,
          });

          if (!shouldContinueLoading) {
            break;
          }

          if (conversationSearchHistoryLoadAttemptsRef.current >= MAX_SEARCH_HISTORY_LOADS_PER_QUERY) {
            break;
          }

          loadAttempts += 1;
          conversationSearchHistoryLoadAttemptsRef.current += 1;
          await requestOlderMessagesRef.current?.('auto');

          await new Promise<void>((resolve) => {
            setTimeout(resolve, 80);
          });
        }
      } finally {
        if (conversationSearchLoadTokenRef.current === currentToken) {
          setIsConversationSearchHistoryLoading(false);
        }
      }
    },
    []
  );

  const scheduleConversationSearchHistoryLoad = useCallback(
    (query: string) => {
      const normalizedQuery = normalizeChatConversationSearchQuery(query);
      clearScheduledConversationSearchHistoryLoad();

      if (!normalizedQuery) {
        setIsConversationSearchHistoryLoading(false);
        return;
      }

      scheduleTimeoutRef(conversationSearchLoadDebounceTimerRef, () => {
        void loadOlderForConversationSearch(normalizedQuery);
      }, 180);
    },
    [clearScheduledConversationSearchHistoryLoad, loadOlderForConversationSearch]
  );

  useEffect(() => {
    scheduleConversationSearchHistoryLoadRef.current = scheduleConversationSearchHistoryLoad;
  }, [scheduleConversationSearchHistoryLoad]);

  const focusConversationSearchMatch = useCallback(
    (targetIndex: number, options?: { animated?: boolean }): boolean => {
      if (conversationSearchMatchIds.length === 0) {
        setConversationSearchActiveIndex(0);
        setConversationSearchHighlightMessageId(null);
        return false;
      }

      const activeIndex = clampChatConversationSearchIndex(targetIndex, conversationSearchMatchIds.length);
      if (activeIndex < 0) {
        return false;
      }

      const targetMessageId = conversationSearchMatchIds[activeIndex];
      if (!targetMessageId) {
        return false;
      }

      setConversationSearchActiveIndex(activeIndex);
      setConversationSearchHighlightMessageId(targetMessageId);
      markAutoScroll();
      return scrollToMessage(targetMessageId, options?.animated ?? true);
    },
    [conversationSearchMatchIds, markAutoScroll, scrollToMessage]
  );

  const handleConversationSearchQueryChange = useCallback((value: string) => {
    setConversationSearchQuery(value);
    setConversationSearchActiveIndex(0);
    setConversationSearchKeyboardSuggestionScope(null);
  }, []);

  const handleConversationSearchClearQuery = useCallback((source: string = 'clear-query-button') => {
    recordConversationSearchNoResultRecovery(source, {
      recoveryType: 'clear-query',
    });
    clearScheduledConversationSearchHistoryLoad();
    conversationSearchLoadTokenRef.current += 1;
    setIsConversationSearchHistoryLoading(false);
    setConversationSearchQuery('');
    setConversationSearchActiveIndex(0);
    setConversationSearchHighlightMessageId(null);
    setConversationSearchKeyboardSuggestionScope(null);

    if (Platform.OS !== 'web') {
      return;
    }

    try {
      conversationSearchInputRef.current?.focus();
    } catch {}
  }, [clearScheduledConversationSearchHistoryLoad, recordConversationSearchNoResultRecovery]);

  const handleConversationSearchScopeChange = useCallback((
    nextScope: ChatConversationSearchScope,
    source: string = 'manual'
  ) => {
    const currentScope = conversationSearchScopeRef.current;
    if (currentScope !== nextScope) {
      recordConversationSearchScopeSwitch(source, nextScope);
      if (source.startsWith('shortcut')) {
        triggerConversationSearchShortcutPulse(nextScope);
      }
    }

    setConversationSearchScope((currentScope) =>
      currentScope === nextScope ? currentScope : nextScope
    );
    setConversationSearchActiveIndex(0);

    if (source === 'shortcut-best' || source === 'shortcut-ordinal') {
      setConversationSearchKeyboardSuggestionScope(nextScope);
      return;
    }

    setConversationSearchKeyboardSuggestionScope(null);
  }, [
    recordConversationSearchScopeSwitch,
    triggerConversationSearchShortcutPulse,
  ]);

  const handleConversationSearchResetScope = useCallback((source: string = 'reset-button') => {
    handleConversationSearchScopeChange('all', source);
    if (Platform.OS !== 'web') {
      return;
    }

    try {
      conversationSearchInputRef.current?.focus();
    } catch {}
  }, [handleConversationSearchScopeChange]);

  const handleConversationSearchLoadOlder = useCallback(
    (source: string = 'load-older-button') => {
      recordConversationSearchNoResultRecovery(source, {
        recoveryType: 'load-older',
      });
      scheduleConversationSearchHistoryLoad(normalizedConversationSearchQuery);
    },
    [
      normalizedConversationSearchQuery,
      recordConversationSearchNoResultRecovery,
      scheduleConversationSearchHistoryLoad,
    ]
  );

  const handleConversationSearchNext = useCallback(() => {
    const nextIndex = resolveChatConversationSearchNextIndex(
      conversationSearchActiveIndex,
      conversationSearchMatchIds.length,
      'next'
    );

    if (nextIndex < 0) {
      scheduleConversationSearchHistoryLoad(normalizedConversationSearchQuery);
      return;
    }

    focusConversationSearchMatch(nextIndex, { animated: true });
  }, [
    conversationSearchActiveIndex,
    conversationSearchMatchIds.length,
    focusConversationSearchMatch,
    scheduleConversationSearchHistoryLoad,
    normalizedConversationSearchQuery,
  ]);

  const handleConversationSearchPrevious = useCallback(() => {
    const nextIndex = resolveChatConversationSearchNextIndex(
      conversationSearchActiveIndex,
      conversationSearchMatchIds.length,
      'previous'
    );

    if (nextIndex < 0) {
      scheduleConversationSearchHistoryLoad(normalizedConversationSearchQuery);
      return;
    }

    focusConversationSearchMatch(nextIndex, { animated: true });
  }, [
    conversationSearchActiveIndex,
    conversationSearchMatchIds.length,
    focusConversationSearchMatch,
    scheduleConversationSearchHistoryLoad,
    normalizedConversationSearchQuery,
  ]);

  const handleConversationSearchInputKeyPress = useCallback(
    (event: any) => {
      if (Platform.OS !== 'web') {
        return;
      }

      const key = event?.nativeEvent?.key;
      const shortcutAction = resolveChatConversationSearchScopeShortcutAction({
        key,
        code: event?.nativeEvent?.code,
        altKey: event?.nativeEvent?.altKey === true,
        shiftKey: event?.nativeEvent?.shiftKey === true,
        ctrlKey: event?.nativeEvent?.ctrlKey === true,
        metaKey: event?.nativeEvent?.metaKey === true,
        hasMatches: conversationSearchMatchIds.length > 0,
        hasQuery: normalizedConversationSearchQuery.length > 0,
        hasMoreHistory: hasMore,
        isLoadingHistory: isConversationSearchHistoryLoading,
      });

      if (shortcutAction) {
        event?.preventDefault?.();
        executeConversationSearchShortcutAction(shortcutAction, {
          scope: conversationSearchScope,
          keyboardSuggestionScope: conversationSearchKeyboardSuggestionScope,
          normalizedQuery: normalizedConversationSearchQuery,
        });
        return;
      }

      if (key === 'Escape') {
        event?.preventDefault?.();
        closeConversationSearch();
        return;
      }

      if (key !== 'Enter') {
        return;
      }

      event?.preventDefault?.();
      if (event?.nativeEvent?.shiftKey) {
        handleConversationSearchPrevious();
        return;
      }

      handleConversationSearchNext();
    },
    [
      closeConversationSearch,
      conversationSearchMatchIds.length,
      conversationSearchKeyboardSuggestionScope,
      conversationSearchScope,
      executeConversationSearchShortcutAction,
      hasMore,
      isConversationSearchHistoryLoading,
      handleConversationSearchNext,
      handleConversationSearchPrevious,
      normalizedConversationSearchQuery,
    ]
  );

  const handleConversationSearchSnippetPress = useCallback(() => {
    if (!conversationSearchActiveSnippet) {
      return;
    }

    focusConversationSearchMatch(conversationSearchActiveIndex, { animated: true });
  }, [conversationSearchActiveIndex, conversationSearchActiveSnippet, focusConversationSearchMatch]);

  useEffect(() => {
    if (!conversationSearchVisible) {
      previousConversationSearchQueryRef.current = normalizedConversationSearchQuery;
      previousConversationSearchScopeRef.current = conversationSearchScope;
      setIsConversationSearchHistoryLoading(false);
      conversationSearchLoadTokenRef.current += 1;
      clearScheduledConversationSearchHistoryLoad();
      return;
    }

    const didQueryChange =
      normalizedConversationSearchQuery !== previousConversationSearchQueryRef.current;
    const didScopeChange =
      conversationSearchScope !== previousConversationSearchScopeRef.current;
    previousConversationSearchQueryRef.current = normalizedConversationSearchQuery;
    previousConversationSearchScopeRef.current = conversationSearchScope;

    if (!didQueryChange && !didScopeChange) {
      return;
    }

    clearScheduledConversationSearchHistoryLoad();

    conversationSearchHistoryLoadAttemptsRef.current = 0;

    if (!normalizedConversationSearchQuery || conversationSearchMatchIds.length === 0) {
      setConversationSearchActiveIndex(0);
      setConversationSearchHighlightMessageId(null);
      if (normalizedConversationSearchQuery) {
        scheduleConversationSearchHistoryLoad(normalizedConversationSearchQuery);
      }
      return;
    }

    conversationSearchLoadTokenRef.current += 1;
    setIsConversationSearchHistoryLoading(false);
    focusConversationSearchMatch(0, { animated: true });
  }, [
    conversationSearchMatchIds,
    conversationSearchScope,
    conversationSearchVisible,
    clearScheduledConversationSearchHistoryLoad,
    focusConversationSearchMatch,
    scheduleConversationSearchHistoryLoad,
    normalizedConversationSearchQuery,
  ]);

  useEffect(() => {
    if (!conversationSearchVisible) {
      return;
    }

    if (conversationSearchMatchIds.length === 0) {
      setConversationSearchActiveIndex(0);
      setConversationSearchHighlightMessageId(null);
      if (normalizedConversationSearchQuery) {
        scheduleConversationSearchHistoryLoad(normalizedConversationSearchQuery);
      } else {
        clearScheduledConversationSearchHistoryLoad();
        conversationSearchLoadTokenRef.current += 1;
        setIsConversationSearchHistoryLoading(false);
      }
      return;
    }

    clearScheduledConversationSearchHistoryLoad();
    conversationSearchLoadTokenRef.current += 1;
    setIsConversationSearchHistoryLoading(false);

    const clampedIndex = clampChatConversationSearchIndex(
      conversationSearchActiveIndex,
      conversationSearchMatchIds.length
    );

    if (clampedIndex !== conversationSearchActiveIndex) {
      setConversationSearchActiveIndex(clampedIndex);
    }

    const activeMessageId = conversationSearchMatchIds[clampedIndex];
    if (activeMessageId && activeMessageId !== conversationSearchHighlightMessageId) {
      setConversationSearchHighlightMessageId(activeMessageId);
    }
  }, [
    conversationSearchActiveIndex,
    conversationSearchHighlightMessageId,
    conversationSearchMatchIds,
    clearScheduledConversationSearchHistoryLoad,
    scheduleConversationSearchHistoryLoad,
    normalizedConversationSearchQuery,
    conversationSearchVisible,
  ]);

  useEffect(() => {
    if (!conversationSearchVisible) {
      return;
    }

    const timer = setTimeout(() => {
      try {
        conversationSearchInputRef.current?.focus();
      } catch {}
    }, 30);

    return () => {
      clearTimeout(timer);
    };
  }, [conversationSearchVisible]);

  const ensureAnchorPosition = useCallback(() => {
    const anchorPlan = resolveChatEnsureAnchorActionPlan({
      anchor: anchoredTargetRef.current,
      hasUserInteracted: userInteractedRef.current,
      startedAtMs: lastAnchoredAtRef.current || 0,
      nowMs: Date.now(),
      stabilizeMs: STABILIZE_MS,
    });

    if (anchorPlan.shouldStopStabilization) {
      stopAnchorStabilization();
      return;
    }

    if (anchorPlan.shouldScrollBottom) {
      scrollToBottom(false, 0);
      isAtBottomRef.current = true;
    } else if (anchorPlan.shouldScrollMessage && anchorPlan.messageId) {
      markAutoScroll();
      scrollToMessage(anchorPlan.messageId, false);
    }
  }, [STABILIZE_MS, markAutoScroll, scrollToBottom, scrollToMessage, stopAnchorStabilization]);

  const beginAnchorStabilization = useCallback(
    (target: { type: 'bottom' | 'message'; id?: string }, options?: { skipImmediate?: boolean }) => {
      stopAnchorStabilization();
      anchoredTargetRef.current = target;
      userInteractedRef.current = false;
      lastAnchoredAtRef.current = Date.now();
      setIsInitialAnchorSettled(false);

      if (!options?.skipImmediate) {
        ensureAnchorPosition();
      }

      stabilizationTimeoutRef.current = setTimeout(() => {
        stopAnchorStabilization();
      }, STABILIZE_MS);
    },
    [STABILIZE_MS, ensureAnchorPosition, stopAnchorStabilization]
  );

  const tryAnchorToBottom = (force: boolean = false) => {
    const anchorAttemptPlan = resolveChatBottomAnchorAttemptPlan({
      hasAnchoredInitialScroll: hasAnchoredInitialScrollRef.current,
      force,
      contentHeight: contentHeightRef.current || 0,
      layoutHeight: layoutHeightRef.current || 0,
    });

    if (anchorAttemptPlan.shouldSkipAsAlreadyAnchored) {
      pendingInitialAnchorRef.current = false;
      if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] skip bottom (already anchored)');
      return false;
    }

    if (anchorAttemptPlan.shouldDeferForLayout) {
      const contentH = contentHeightRef.current || 0;
      const layoutH = layoutHeightRef.current || 0;
      pendingInitialAnchorRef.current = true;
      if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] defer bottom (layout pending)', { contentH, layoutH });
      return false;
    }

    hasAnchoredInitialScrollRef.current = true;
    pendingInitialAnchorRef.current = false;
    onScrollFailAttemptsRef.current = 0;
    beginAnchorStabilization({ type: 'bottom' });
    if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] anchored to bottom');
    return true;
  };

  const scheduleScrollToUnread = (messageId: string | null | undefined) => {
    if (!messageId) return;
    if (scrollToUnreadAttemptedRef.current) return;

    pendingInitialAnchorRef.current = true;
    const contentH = contentHeightRef.current || 0;
    const layoutH = layoutHeightRef.current || 0;
    if (contentH <= 0 || layoutH <= 0) {
      pendingInitialAnchorRef.current = true;
      return;
    }

    requestAnimationFrame(() => {
      markAutoScroll();
      const success = scrollToMessage(String(messageId), false);
      if (success) {
        scrollToUnreadAttemptedRef.current = true;
        hasAnchoredInitialScrollRef.current = true;
        pendingInitialAnchorRef.current = false;
        onScrollFailAttemptsRef.current = 0;
        beginAnchorStabilization({ type: 'message', id: String(messageId) }, { skipImmediate: true });
        if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] anchored to first unread', { messageId });
      } else {
        pendingInitialAnchorRef.current = true;
        if (CHAT_SCROLL_DEBUG) logger.debug('[CHAT-ANCHOR] failed to anchor to unread (will retry)', { messageId });
      }
    });
  };

  useEffect(() => {
    const prev = prevSettlementRef.current;
    prevSettlementRef.current = isInitialAnchorSettled;
    isInitialAnchorSettledRef.current = isInitialAnchorSettled;

    const conversationId = selectedTeamMember?.id || selectedTeamMember?.email || 'unknown';
    if (prev === isInitialAnchorSettled && prev !== null) {
      return;
    }

    if (!isInitialAnchorSettled) {
      const reason: 'initial' | 'refresh' =
        renderTraceRef.current && renderTraceRef.current.conversationId === conversationId
          ? 'refresh'
          : 'initial';
      const startedAt = Date.now();
      const profile = concurrencyProfileRef.current;
      renderTraceRef.current = createChatRenderTraceState(conversationId, reason, startedAt, profile);
      logger.metric(
        'chat.render.trace.start',
        resolveChatRenderTraceStartPayload(
          conversationId,
          reason,
          displayedMessagesRef.current?.length ?? 0
        )
      );
      if (!profile) {
        chatCacheService
          .getTelemetryContext()
          .then((resolvedProfile) => {
            concurrencyProfileRef.current = resolvedProfile;
            const active = renderTraceRef.current;
            if (active && active.startedAt === startedAt) {
              active.profile = resolvedProfile;
            }
          })
          .catch((error) => {
            logger.warn('chat.render.trace.profileResolveError', { error });
          });
      }
      return;
    }

    const activeTrace = renderTraceRef.current;
    if (!activeTrace) {
      return;
    }
    logger.metric(
      'chat.render.trace.complete',
      resolveChatRenderTraceCompletePayload(
        activeTrace,
        displayedMessagesRef.current?.length ?? 0,
        concurrencyProfileRef.current
      )
    );
    renderTraceRef.current = null;
  }, [isInitialAnchorSettled, selectedTeamMember?.id, selectedTeamMember?.email]);

  // Handle scroll to update sticky date header (optimized to reduce re-renders)
  const handleScroll = (event: any) => {
    const scrollY = event.nativeEvent.contentOffset.y;
    lastScrollOffsetRef.current = scrollY;
    const isDragging = Boolean(event?.nativeEvent?.isDragging);
    const scrollInteractionPlan = resolveChatScrollInteractionPlan({
      isInitialAnchorSettled: isInitialAnchorSettledRef.current,
      isAutoScrolling: isAutoScrollingRef.current,
      isDragging,
      isCurrentlyScrolling: isScrollingRef.current,
      scrollY,
      stickyDateVisible,
    });

    if (scrollInteractionPlan.shouldMarkUserInteracted) {
      userInteractedRef.current = true;
      allowTopAutoPaginationRef.current =
        scrollInteractionPlan.shouldAllowTopAutoPagination;
    }

    if (scrollInteractionPlan.shouldStopAnchorStabilization) {
      stopAnchorStabilization();
    }
    
    // Clear existing timeout and set scrolling to true
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    
    // Only update scrolling state if it actually changed
    if (scrollInteractionPlan.shouldSetScrollingTrue) {
      isScrollingRef.current = true;
    }
    
    // Early exit for shallow scrolls to reduce state updates
    if (scrollInteractionPlan.shouldExitEarly) {
      if (scrollInteractionPlan.shouldHideStickyDateImmediate) {
        setStickyDateVisibleSafely(false);
      }
      // Set timer to turn off scrolling
      scrollTimeoutRef.current = setTimeout(() => {
        isScrollingRef.current = false;
      }, scrollInteractionPlan.idleHideDelayMs);
      return;
    }

    const stickyDateScrollPlan = resolveChatStickyDateScrollPlan({
      topVisibleMessageId: topVisibleMessageRef.current?.id,
      previousSourceMessageId: stickyDateSourceMessageIdRef.current,
      currentStickyDateText: stickyDateText,
      currentStickyDateVisible: stickyDateVisible,
      dateLabelById: messageDateLabelByIdRef.current,
    });

    if (stickyDateScrollPlan.shouldSetSourceMessageId) {
      stickyDateSourceMessageIdRef.current = stickyDateScrollPlan.nextSourceMessageId;
    } else if (stickyDateScrollPlan.shouldClearSourceMessageId) {
      stickyDateSourceMessageIdRef.current = null;
    }

    if (stickyDateScrollPlan.shouldSetStickyDateText) {
      setStickyDateTextSafely(stickyDateScrollPlan.nextStickyDateText);
    }

    if (stickyDateScrollPlan.shouldSetStickyDateVisible) {
      setStickyDateVisibleSafely(stickyDateScrollPlan.nextStickyDateVisible);
    }

    // Set timer to turn off scrolling and hide header
    scrollTimeoutRef.current = setTimeout(() => {
      isScrollingRef.current = false;
      const stickyDateIdleHidePlan = resolveChatStickyDateIdleHidePlan({
        shouldHideStickyDateOnIdle:
          scrollInteractionPlan.shouldHideStickyDateOnIdle,
        currentStickyDateVisible: stickyDateVisible,
      });
      if (stickyDateIdleHidePlan.shouldHideStickyDate) {
        setStickyDateVisibleSafely(false);
      }
    }, scrollInteractionPlan.idleHideDelayMs); // Hide after 1.5 seconds of no scrolling
  };

  useEffect(() => {
    if (!messages || messages.length === 0) return;
    if (hasAnchoredInitialScrollRef.current) return;

    // Wait until the unread divider seed is decided before choosing where to
    // land. Until then we don't know whether to scroll to the unread divider or
    // to the bottom, and anchoring early races the seed and wrongly snaps to the
    // bottom (hiding the divider). The list stays hidden until anchored, so this
    // wait is invisible to the user.
    if (!unreadDividerSeeded) {
      pendingInitialAnchorRef.current = true;
      return;
    }

    if (unreadSeparatorAnchorMessageId && !scrollToUnreadAttemptedRef.current) {
      scheduleScrollToUnread(unreadSeparatorAnchorMessageId);
      return;
    }

    pendingInitialAnchorRef.current = true;
    tryAnchorToBottom();
  }, [messages, unreadSeparatorAnchorMessageId, unreadDividerSeeded, selectedTeamMember?.id]);

  useEffect(() => {
    if (!messages || messages.length === 0) {
      lastTailIdRef.current = null;
      resetUnseenCount();
      setShowScrollToBottomSafely(false);
      clearNewMessageDivider();
      hasAnchoredInitialScrollRef.current = false;
      pendingInitialAnchorRef.current = false;
      scrollToUnreadAttemptedRef.current = false;
      pendingPrependAnchorRef.current = null;
      onScrollFailAttemptsRef.current = 0;
      setIsInitialAnchorSettled(true);
      return;
    }

    const lastId = messages[messages.length - 1]?.id ?? null;
    if (!lastId) return;

    if (lastTailIdRef.current === null) {
      lastTailIdRef.current = lastId;
      if (!hasAnchoredInitialScrollRef.current && !scrollToUnreadAttemptedRef.current) {
        pendingInitialAnchorRef.current = true;
        tryAnchorToBottom();
      }
      return;
    }

    if (lastId === lastTailIdRef.current) {
      return;
    }

    if (isAtBottomRef.current) {
      // Only treat an arrival as "watched live" when the user is genuinely
      // present. If the app is backgrounded or the browser tab is hidden,
      // fall through to the shared away-path so the "New messages" divider
      // is anchored at the first missed message — exactly what would happen
      // if they had scrolled up before leaving. When they return they will
      // see the divider and the scroll-to-bottom badge rather than a bare
      // auto-scrolled list with no indication that messages arrived while away.
      const isUserPresent = isFocused && isAppActive;
      if (isUserPresent) {
        const prevTailId = lastTailIdRef.current;
        lastTailIdRef.current = lastId;
        resetUnseenCount();
        setShowScrollToBottomSafely(false);
        // A message arrived while the user is at the bottom (caught up) — retire
        // BOTH dividers: the new-messages divider and the seeded unread divider.
        clearNewMessageDivider();
        clearUnreadDivider();
        // The user is parked at the bottom of an interactive conversation, so any
        // freshly-arrived incoming messages are being viewed as they land. Mark
        // them read immediately (locally + receipt) so no unread divider ever
        // flashes above them and the sender's blue tick follows promptly. Gated
        // on the bootstrap gate so nothing fires while the loading overlay is
        // still up.
        if (isChatBootstrapGateDoneRef.current) {
          const displayed = displayedMessagesRef.current;
          const prevIdx = prevTailId
            ? (displayedMessageIndexRef.current.get(String(prevTailId)) ?? -1)
            : -1;
          const arrived = prevIdx >= 0 ? displayed.slice(prevIdx + 1) : displayed.slice(-1);
          const normalizedPartner = normalizeParticipantEmail(selectedTeamMember?.email);
          const normalizedMe = normalizeParticipantEmail(effectiveUser?.email);
          const arrivedReadIds: string[] = [];
          if (normalizedPartner && normalizedMe) {
            for (const arrivedMessage of arrived) {
              if (!arrivedMessage || arrivedMessage.deleted || arrivedMessage.read) {
                continue;
              }
              if (
                normalizeParticipantEmail(arrivedMessage.sender) === normalizedPartner &&
                normalizeParticipantEmail(arrivedMessage.recipientId) === normalizedMe
              ) {
                const arrivedId = normalizeMessageId(arrivedMessage.id);
                if (arrivedId) {
                  arrivedReadIds.push(arrivedId);
                }
              }
            }
          }
          if (arrivedReadIds.length > 0) {
            markMessagesReadLocallyRef.current(arrivedReadIds);
            queueConversationReceiptSync({ readMessageIds: arrivedReadIds });
          }
        }
        scheduleScrollToBottom({ animated: true, delay: 140 });
        return;
      }
      // User was at the bottom but is not currently present (backgrounded /
      // other browser tab active). Fall through so the unseen-count badge and
      // "New messages" divider are set — on foreground return the user will
      // see the divider anchored at the first message that arrived while away.
    }

    const prevId = lastTailIdRef.current;
    const displayed = displayedMessagesRef.current;
    const idx = prevId ? (displayedMessageIndexRef.current.get(String(prevId)) ?? -1) : -1;
    const additional = idx >= 0 ? Math.max(0, displayed.length - (idx + 1)) : 1;
    incrementUnseenCount(additional);
    setShowScrollToBottomSafely(true);
    // Anchor the "New messages" divider to the FIRST new message, and only once.
    // If it's already showing from an earlier batch, keep it in place so that
    // multiple batches of new messages share a SINGLE divider positioned just
    // before the first of them — instead of the line hopping down to each new
    // batch as it arrives.
    if (!showNewDividerRef.current) {
      const firstNewId = idx >= 0 ? (displayed[idx + 1]?.id ?? lastId) : lastId;
      if (firstNewId) {
        showNewMessageDividerAt(firstNewId);
      }
    }
    lastTailIdRef.current = lastId;
  }, [messages, clearNewMessageDivider, clearUnreadDivider, incrementUnseenCount, resetUnseenCount, setShowScrollToBottomSafely, showNewMessageDividerAt, isFocused, isAppActive, selectedTeamMember?.email, effectiveUser?.email, normalizeParticipantEmail, normalizeMessageId, queueConversationReceiptSync]);

  // Auto scroll to bottom when typing indicator appears/disappears
  useEffect(() => {
    if (!isTyping) return;
    if (!selectedTeamMember) return;
    if (isAtBottomRef.current) {
      scheduleScrollToBottom();
    }
  }, [isTyping, selectedTeamMember?.id]);

  // Release older messages from memory once the in-memory backlog grows large
  // AND the user is parked at the bottom of the conversation. Trimming only
  // when at the bottom guarantees we never remove history the user is actively
  // scrolling through; the trimmed pages stay in the persistent cache and
  // reload automatically (via loadMore) when the user scrolls back up. This
  // keeps the live dataset bounded so a long-lived, busy conversation cannot
  // grow the JS heap and per-update work without limit.
  useEffect(() => {
    if (!selectedTeamMember || typeof trimToRecentWindow !== 'function') {
      return;
    }
    if (loading || loadingMore || !isInitialAnchorSettled) {
      return;
    }
    if (!isAtBottomRef.current) {
      return;
    }

    const handle = setTimeout(() => {
      if (isAtBottomRef.current && !loadingMore) {
        trimToRecentWindow();
      }
    }, 1500);

    return () => clearTimeout(handle);
  }, [
    messages.length,
    loading,
    loadingMore,
    isInitialAnchorSettled,
    selectedTeamMember?.id,
    trimToRecentWindow,
  ]);

  // Cleanup scroll timeout on unmount
  useEffect(() => {
    if (!isFocused || !isAppActive || !selectedTeamMember?.id) {
      return;
    }

    void ensureMessageTonePlayer();
  }, [isFocused, isAppActive, selectedTeamMember?.id, ensureMessageTonePlayer]);

  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (messageTonePlayerRef.current) {
        try {
          messageTonePlayerRef.current.remove();
        } catch {
          // Ignore cleanup errors.
        }
        messageTonePlayerRef.current = null;
      }
      if (userActivityTimeoutRef.current) {
        clearTimeout(userActivityTimeoutRef.current);
      }
    };
  }, []);

  // Ensure initial anchoring runs when the chat changes or on first focus for that chat.
  // Do NOT force re-anchoring on subsequent focuses of the same chat (prevents unexpected jumps).
  const lastAnchoredChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isFocused) return;
    if (!selectedTeamMember) return;
    const chatKey = String(selectedTeamMember.id || selectedTeamMember.email || '');
    const alreadyAnchoredSameChat =
      lastAnchoredChatIdRef.current === chatKey && hasAnchoredInitialScrollRef.current;
    if (alreadyAnchoredSameChat) return;

    // Mark this chat as the current anchored target and reset guards
    lastAnchoredChatIdRef.current = chatKey;
    hasAnchoredInitialScrollRef.current = false;
    pendingInitialAnchorRef.current = true;
    scrollToUnreadAttemptedRef.current = false;
    onScrollFailAttemptsRef.current = 0;

    // Attempt anchor on next tick once layout/content sizes are known
    setTimeout(() => {
      if (unreadSeparatorAnchorMessageId) {
        scheduleScrollToUnread(unreadSeparatorAnchorMessageId);
      } else {
        tryAnchorToBottom();
      }
    }, 0);
  }, [isFocused, selectedTeamMember?.id, selectedTeamMember?.email, unreadSeparatorAnchorMessageId]);

  useEffect(() => {
    if (!selectedTeamMember) {
      return;
    }

    const chatKey = String(selectedTeamMember.id || selectedTeamMember.email || '');
    if (!chatKey || forceBottomAnchorChatKeyRef.current !== chatKey) {
      return;
    }

    if (!Array.isArray(displayedMessages) || displayedMessages.length === 0) {
      return;
    }

    if (unreadSeparatorAnchorMessageId) {
      return;
    }

    const contentReady = contentHeightRef.current > 0 && layoutHeightRef.current > 0;
    if (!contentReady) {
      pendingInitialAnchorRef.current = true;
      return;
    }

    userInteractedRef.current = false;
    markAutoScroll(320);
    tryAnchorToBottom(true);
    scheduleScrollToBottom({ animated: false, delay: 0 });
    scheduleTimeoutRef(forceAnchorRetryTimerRef1, () => scheduleScrollToBottom({ animated: false, delay: 0 }), 80);
    scheduleTimeoutRef(forceAnchorRetryTimerRef2, () => scheduleScrollToBottom({ animated: false, delay: 0 }), 220);
    forceBottomAnchorChatKeyRef.current = null;
  }, [selectedTeamMember, displayedMessages, unreadSeparatorAnchorMessageId, markAutoScroll]);

  useEffect(() => {
    if (prevLoadingMoreRef.current && !loadingMore) {
      if (shouldUseManualAnchorPreservation && pendingPrependAnchorRef.current) {
        restorePrependAnchorIfNeeded();
      }
    }
    prevLoadingMoreRef.current = loadingMore;
  }, [loadingMore, restorePrependAnchorIfNeeded, shouldUseManualAnchorPreservation]);

  useEffect(() => {
    const foregroundQueueExecutionInput = {
      partnerEmail: selectedTeamMember?.email,
      userEmail: effectiveUser?.email,
      isFocused,
      isAppActive,
      requestConversationDelivered: true,
    };
    const scheduledQueueGeneration = receiptSyncGenerationRef.current;
    const timer = setTimeout(() => {
      const foregroundQueueExecutionPlan =
        resolveChatReceiptForegroundQueueExecutionPlan({
          ...foregroundQueueExecutionInput,
          queueGeneration: scheduledQueueGeneration,
          activeGeneration: receiptSyncGenerationRef.current,
        });
      if (
        !foregroundQueueExecutionPlan.shouldApplyQueueInvocationExecutionPlan ||
        !foregroundQueueExecutionPlan.shouldQueueSync
      ) {
        return;
      }

      queueConversationReceiptSync(
        foregroundQueueExecutionPlan.queueOptions,
        scheduledQueueGeneration
      );
    }, 250);

    return () => clearTimeout(timer);
  }, [selectedTeamMember?.email, effectiveUser?.email, isFocused, isAppActive, queueConversationReceiptSync]);

  // Smart unread separator management - mirror live unread state of conversation
  useEffect(() => {
    if (!selectedTeamMember?.email || !effectiveUser?.email) {
      hasAcknowledgedUnreadRef.current = false;
      unreadDividerDismissedStateRef.current = null;
      if (unreadSeparatorDismissTimeoutRef.current) {
        clearTimeout(unreadSeparatorDismissTimeoutRef.current);
        unreadSeparatorDismissTimeoutRef.current = null;
      }
      setShowUnreadSeparator(false);
      setUnreadSeparatorMessageId(null);
      unreadSeparatorIsVisibleRef.current = false;
      unreadDividerSeedCountRef.current = 0;
      setUnreadDividerSeedCount(0);
      return;
    }

    if (unreadSeparatorAnchorMessageId) {
      // Anchor present → show. The seeded anchor is produced by the seed effect
      // and retired by clearUnreadDivider (send / at-bottom arrival) or the
      // chat-switch reset, so there is nothing else to reconcile here.
      setUnreadSeparatorMessageId(unreadSeparatorAnchorMessageId);
      setShowUnreadSeparator(true);
      return;
    }

    // No anchor → ensure the divider is hidden.
    setShowUnreadSeparator(false);
    setUnreadSeparatorMessageId(null);
    unreadSeparatorIsVisibleRef.current = false;
  }, [
    unreadSeparatorAnchorMessageId,
    selectedTeamMember?.email,
    effectiveUser?.email,
  ]);

  useEffect(() => {
    if (!selectedTeamMember?.email || !effectiveUser?.email) {
      previousIncomingUnreadRef.current = incomingUnreadCount;
      return;
    }

    const previousCount = previousIncomingUnreadRef.current;
    previousIncomingUnreadRef.current = incomingUnreadCount;

    if (incomingUnreadCount === 0 && hasAcknowledgedUnreadRef.current && !unreadSeparatorIsVisibleRef.current) {
      scheduleUnreadSeparatorDismiss(UNREAD_DIVIDER_AUTO_DISMISS_MS);
    }

    if (incomingUnreadCount > previousCount && unreadSeparatorAnchorMessageId) {
      unreadDividerDismissedStateRef.current = null;
      hasAcknowledgedUnreadRef.current = false;
      if (unreadSeparatorDismissTimeoutRef.current) {
        clearTimeout(unreadSeparatorDismissTimeoutRef.current);
        unreadSeparatorDismissTimeoutRef.current = null;
      }
      setUnreadSeparatorMessageId(unreadSeparatorAnchorMessageId);
      setShowUnreadSeparator(true);
    }

  }, [incomingUnreadCount, selectedTeamMember?.email, effectiveUser?.email, scheduleUnreadSeparatorDismiss, unreadSeparatorAnchorMessageId]);

  // Reset separator when switching chats
  useEffect(() => {
    toneBootstrapChatKeyRef.current = null;
    stopAnchorStabilization();
    setShowUnreadSeparator(false);
    setUnreadSeparatorMessageId(null);
    unreadSeparatorIsVisibleRef.current = false;
    setUnreadDividerSeedCount(0);
    setShowNewDivider(false);
    setNewDividerMessageId(null);
    hasAcknowledgedUnreadRef.current = false;
    unreadDividerDismissedStateRef.current = null;
    incomingUnreadCountRef.current = 0;
    previousIncomingUnreadRef.current = 0;
    unreadDividerSeedCountRef.current = 0;
    lastNearBottomUnreadDismissAnchorRef.current = null;
    unreadAnchorSeedInitializedChatKeyRef.current = null;
    unreadSeedAnchorMessageIdRef.current = null;
    setUnreadSeedAnchorMessageId(null);
    setUnreadDividerSeeded(false);
    if (unreadSeparatorDismissTimeoutRef.current) {
      clearTimeout(unreadSeparatorDismissTimeoutRef.current);
      unreadSeparatorDismissTimeoutRef.current = null;
    }
    hasAnchoredInitialScrollRef.current = false; // ensure next chat anchors once
    pendingInitialAnchorRef.current = false;
    scrollToUnreadAttemptedRef.current = false;
    allowTopAutoPaginationRef.current = false;
    onScrollFailAttemptsRef.current = 0;
  pendingPrependAnchorRef.current = null;
    setIsInitialAnchorSettled(false);
    // Reset layout/measurement state so new chat anchors after fresh measurements
    contentHeightRef.current = 0;
    layoutHeightRef.current = 0;
    lastScrollOffsetRef.current = 0;
    isAtBottomRef.current = true;
    topVisibleMessageRef.current = null;
    stickyDateSourceMessageIdRef.current = null;
    messagePositionsRef.current = {};
    displayedMessagesRef.current = [];
    lastTailIdRef.current = null;
  // Clear animation states when switching chats
    setAnimatedMessages(new Set());
    previousMessageIdsRef.current = new Set();
    globalAnimatedMessages.current.clear(); // Clear global animation tracking
    
    // Reset input height when switching chats (but not when sending messages)
    setInputHeight(40);
    setReplyingToMessage(null);
    
    // Manually hide keyboard when switching chats
    Keyboard.dismiss();
    
    // Note: We DON'T clear reactions when switching chats anymore
    // Reactions are global and should persist across chat switches
  }, [selectedTeamMember?.id]);

  useEffect(() => {
    const now = Date.now();
    messageToneEligibleSinceRef.current = now;
    messageToneCooldownUntilRef.current = now + CHAT_OPEN_TONE_COOLDOWN_MS;
  }, [selectedTeamMember?.id, selectedTeamMember?.email, isFocused, isAppActive]);

  // Helper function to clear input field without affecting keyboard
  const clearActiveTypingStatus = useCallback((reason: TypingStatusWriteReason = 'clear_active') => {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    const activeTypingPair = typingStatusPairRef.current;
    setTypingStatusForPair(activeTypingPair, false, reason);

    typingStatusPairRef.current = null;
    typingStatusActiveRef.current = false;
  }, [setTypingStatusForPair]);

  const clearInputField = useCallback(() => {
    logger.debug('clearInputField called, Platform:', Platform.OS);

    setEditingMessageInfo(null);
    setReplyingToMessage(null);
    setMessage('');
    latestMessageRef.current = '';
    setShowSpecialCommand(false);
    setIsComposingSpecial(false);
    setInputHeight(40);

    clearActiveTypingStatus();

    mobileInputRef.current?.clearInput?.();

    logger.debug('Message state cleared');
  }, [clearActiveTypingStatus]);

  const beginReplyToMessage = useCallback(
    (targetMessage: any) => {
      const replyContext = buildReplyContextFromMessage(targetMessage);
      if (!replyContext) {
        return;
      }

      if (editingMessageInfo) {
        clearInputField();
      }

      setReplyingToMessage(replyContext);

      setTimeout(() => {
        try {
          mobileInputRef.current?.focusInput?.();
        } catch (focusError) {
          logger.debug('Failed to focus input after enabling reply mode', { focusError });
        }
      }, 0);
    },
    [buildReplyContextFromMessage, editingMessageInfo, clearInputField]
  );

  const cancelReplyingToMessage = useCallback(() => {
    setReplyingToMessage(null);
  }, []);

  const beginEditingMessage = useCallback(
    (message: any) => {
      if (!message || !message.id) {
        return;
      }
      if (!canEditMessage(message)) {
        Toast.show({
          type: 'info',
          text1: 'Cannot Edit',
          text2: 'Only plain text messages without attachments can be edited.',
          position: 'top',
        });
        return;
      }

      const textValue = typeof message.text === 'string' ? message.text : '';
      logger.info?.('Chat: begin editing message', {
        messageId: message.id,
        length: textValue.length,
        platform: Platform.OS,
      });
      setReplyingToMessage(null);
      setEditingMessageInfo({ id: normalizeMessageId(message.id), originalText: textValue });
      setMessage(textValue);
      latestMessageRef.current = textValue;

      try {
        mobileInputRef.current?.syncValueFromParent?.(textValue);
      } catch (syncError) {
        logger.debug('Failed to sync mobile input value during edit', { syncError });
      }

      setTimeout(() => {
        try {
          mobileInputRef.current?.focusInput?.();
        } catch (focusError) {
          logger.debug('Failed to focus input after starting edit', { focusError });
        }
      }, 0);
    },
    [canEditMessage]
  );

  const cancelEditingMessage = useCallback(() => {
    if (!editingMessageInfo) {
      return;
    }
    clearInputField();
  }, [editingMessageInfo, clearInputField]);

  const handleEditLastOwnMessageShortcut = useCallback(() => {
    if (editingMessageInfo) {
      return;
    }

    if (typeof message === 'string' && message.trim().length > 0) {
      return;
    }

    const latestEditable = findLatestEditableOwnMessage();
    if (!latestEditable) {
      return;
    }

    beginEditingMessage(latestEditable);
  }, [editingMessageInfo, message, findLatestEditableOwnMessage, beginEditingMessage]);

  const performDeleteMessage = useCallback(
    async (message: any) => {
      if (!message || !message.id) {
        return;
      }
      if (isMessageActionPending(message.id)) {
        return;
      }
      if (isOffline) {
        Toast.show({
          type: 'info',
          text1: 'Offline',
          text2: 'Reconnect to remove messages.',
          position: 'top',
        });
        return;
      }

      markMessageActionPending(message.id);
      try {
        await deleteChatMessage(message.id);
        if (editingMessageInfo?.id === normalizeMessageId(message.id)) {
          clearInputField();
        }
        Toast.show({
          type: 'success',
          text1: 'Message deleted',
          position: 'top',
        });
      } catch (error: any) {
        let text2 = 'Failed to delete message. Please try again.';
        if (error instanceof ChatMessageActionError) {
          switch (error.code) {
            case 'too_old':
              text2 = 'You can no longer delete this message.';
              break;
            case 'not_authorized':
            case 'not_allowed':
              text2 = 'You are not allowed to delete this message.';
              break;
            case 'already_deleted':
              text2 = 'This message is already removed.';
              break;
          }
        }
        Toast.show({
          type: 'error',
          text1: 'Delete failed',
          text2,
          position: 'top',
        });
      } finally {
        clearMessageActionPending(message.id);
        setDeleteConfirmState((prev) => {
          if (prev.message && prev.message.id === message.id) {
            return { visible: false, message: null };
          }
          return prev;
        });
      }
    },
    [
      isMessageActionPending,
      isOffline,
      deleteChatMessage,
      editingMessageInfo,
      clearInputField,
      markMessageActionPending,
      clearMessageActionPending,
      setDeleteConfirmState,
    ]
  );

  const confirmDeleteMessage = useCallback(
    (message: any) => {
      if (!message || !message.id) {
        return;
      }

      setDeleteConfirmState({ visible: true, message });
    },
    [setDeleteConfirmState]
  );

  const deleteConfirmationPreview = useMemo(() => {
    const target = deleteConfirmState.message;
    if (!target) {
      return null;
    }

    if (typeof target.text === 'string') {
      const trimmed = target.text.trim();
      if (trimmed.length > 0) {
        const snippet = trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
        return `Preview: "${snippet}"`;
      }
    }

    if (target.gif) {
      return 'GIF message will be removed.';
    }

    if (target.sticker) {
      return 'Sticker message will be removed.';
    }

    if (Array.isArray(target.attachments) && target.attachments.length > 0) {
      const count = target.attachments.length;
      return count === 1 ? 'Includes 1 attachment.' : `Includes ${count} attachments.`;
    }

    if (target.fileName) {
      return `Attachment: ${String(target.fileName).trim() || 'File'}.`;
    }

    return null;
  }, [deleteConfirmState.message]);

  const pendingDeleteId = deleteConfirmState.message?.id;
  const isDeletePending = pendingDeleteId ? isMessageActionPending(pendingDeleteId) : false;
  const handleDeleteConfirm = useCallback(() => {
    const target = deleteConfirmState.message;
    if (target) {
      void performDeleteMessage(target);
    } else {
      setDeleteConfirmState({ visible: false, message: null });
    }
  }, [deleteConfirmState.message, performDeleteMessage]);

  const countMessageWords = useCallback((value?: string | null) => {
    return resolveChatComposerWordCount(value);
  }, []);

  const enforceMessageLimits = useCallback((value?: string | null) => {
    return resolveChatComposerMessageWithinLimits({
      value,
      maxChars: CHAT_MESSAGE_MAX_CHARS,
      maxWords: CHAT_MESSAGE_MAX_WORDS,
    });
  }, []);

  const trimmedMessageValue = useMemo(() => {
    if (typeof message !== 'string') {
      return '';
    }
    return message.trim();
  }, [message]);

  const normalizeMessageValue = useCallback((value?: string | null) => {
    return resolveChatNormalizedMessageValue(value);
  }, []);

  const normalizedCurrentMessage = useMemo(() => normalizeMessageValue(message), [message, normalizeMessageValue]);

  const messageCharacterCount = useMemo(() => {
    if (typeof message !== 'string') {
      return 0;
    }
    return message.length;
  }, [message]);

  const messageWordCount = useMemo(() => countMessageWords(message), [message, countMessageWords]);

  const showInputLimitCounter = useMemo(() => {
    return (
      messageCharacterCount >= Math.floor(CHAT_MESSAGE_MAX_CHARS * 0.8) ||
      messageWordCount >= Math.floor(CHAT_MESSAGE_MAX_WORDS * 0.8)
    );
  }, [messageCharacterCount, messageWordCount]);

  const normalizedOriginalMessage = useMemo(
    () => normalizeMessageValue(editingMessageInfo?.originalText ?? ''),
    [editingMessageInfo?.originalText, normalizeMessageValue]
  );

  const hasEditedMessageChanged = useMemo(() => {
    if (!editingMessageInfo) {
      return true;
    }
    return normalizedCurrentMessage.length > 0 && normalizedCurrentMessage !== normalizedOriginalMessage;
  }, [editingMessageInfo, normalizedCurrentMessage, normalizedOriginalMessage]);

  const editingPreviewText = useMemo(() => {
    if (!editingMessageInfo?.originalText) {
      return '';
    }

    const normalized = editingMessageInfo.originalText.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }

    return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
  }, [editingMessageInfo]);

  const replyingPreviewText = useMemo(() => {
    if (!replyingToMessage) {
      return '';
    }

    return resolveChatReplyPreviewText({
      text: replyingToMessage.text,
      isSpecial: replyingToMessage.isSpecial,
      hasAttachments: replyingToMessage.hasAttachments,
      attachmentCount: replyingToMessage.attachmentCount,
      hasSticker: replyingToMessage.hasSticker,
      hasGif: replyingToMessage.hasGif,
      maxLength: CHAT_REPLY_PREVIEW_MAX_CHARS,
    });
  }, [replyingToMessage]);

  const replyingSenderLabel = useMemo(
    () => resolveChatReplySenderLabel({
      sender: replyingToMessage?.sender,
      senderName: replyingToMessage?.senderName,
      effectiveUserEmail,
      selectedMemberEmail: selectedTeamMember?.email,
      selectedMemberName: selectedTeamMember?.name,
    }),
    [effectiveUserEmail, replyingToMessage, selectedTeamMember?.email, selectedTeamMember?.name]
  );

  const canAttemptSend = useMemo(() => {
    return canAttemptChatComposerSend({
      trimmedMessage: trimmedMessageValue,
      hasSelectedRecipient: !!selectedTeamMember,
      messageCharacterCount,
      messageWordCount,
      maxChars: CHAT_MESSAGE_MAX_CHARS,
      maxWords: CHAT_MESSAGE_MAX_WORDS,
      isEditingMessage: !!editingMessageInfo,
      hasEditedMessageChanged,
    });
  }, [
    trimmedMessageValue,
    selectedTeamMember,
    messageCharacterCount,
    messageWordCount,
    editingMessageInfo,
    hasEditedMessageChanged,
  ]);

  const isMessageOverLimit = useMemo(() => {
    return isChatComposerMessageOverLimit({
      messageCharacterCount,
      messageWordCount,
      maxChars: CHAT_MESSAGE_MAX_CHARS,
      maxWords: CHAT_MESSAGE_MAX_WORDS,
    });
  }, [messageCharacterCount, messageWordCount]);

  const resolvePendingMessageStatus = useCallback((pendingMsg?: PendingMessage): NonNullable<PendingMessage['status']> => {
    return normalizePendingMessageStatus(pendingMsg?.status);
  }, []);

  const getPendingMessageBubbleOpacity = useCallback((tempId: string) => {
    return resolveChatPendingBubbleOpacityEntry(
      pendingMessageBubbleOpacityRef.current,
      tempId,
      () => new Animated.Value(PENDING_MESSAGE_BUBBLE_OPACITY_DEFAULT)
    );
  }, []);

  const getPendingRowAnimation = useCallback(
    (rowKey: string, direction: 'incoming' | 'outgoing' = 'outgoing') => {
      const timings = resolveChatPendingRowAnimationTimings(direction);
      const entry = resolveChatPendingRowAnimationEntry(
        pendingRowAnimationRef.current,
        rowKey,
        () => ({
          opacity: new Animated.Value(0),
          translateX: new Animated.Value(timings.enterOffset),
          scale: new Animated.Value(timings.enterScale),
        })
      );

      if (shouldStartPendingRowAnimation(entry)) {
        markPendingRowAnimationStarted(entry);
        Animated.parallel([
          Animated.timing(entry.opacity, {
            toValue: 1,
            duration: timings.fadeDuration,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(entry.translateX, {
            toValue: 0,
            duration: timings.slideDuration,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(entry.scale, {
            toValue: 1,
            duration: timings.scaleDuration,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: Platform.OS !== 'web',
          }),
        ]).start();
      }

      return entry;
    },
    []
  );

  useEffect(() => {
    const activeKeys = resolveChatActivePendingAnimationKeys({
      pendingTextIds: pendingMessages.keys(),
      pendingMediaIds: pendingMedia.keys(),
      pendingAttachmentIds: pendingAttachments.keys(),
    });

    const inactiveKeys = resolveChatInactivePendingAnimationKeys(
      pendingRowAnimationRef.current.keys() as any as Set<string>,
      activeKeys
    );

    for (const key of inactiveKeys) {
      pendingRowAnimationRef.current.delete(key);
    }
  }, [pendingMessages, pendingMedia, pendingAttachments]);

  const handleSendMessage = useCallback(async () => {
    if (sendInFlightRef.current) {
      return;
    }

    const trimmedMessage = trimmedMessageValue;

    if (editingMessageInfo) {
      if (!trimmedMessage) {
        Toast.show({
          type: 'info',
          text1: 'Empty Message',
          text2: 'Edited message cannot be empty.',
          position: 'top',
        });
        return;
      }

      if (!hasEditedMessageChanged) {
        cancelEditingMessage();
        return;
      }

      if (isOffline) {
        Toast.show({
          type: 'info',
          text1: 'Offline',
          text2: 'Reconnect to update messages.',
          position: 'top',
        });
        return;
      }

      sendInFlightRef.current = true;
      setIsSendingMessage(true);

      try {
        await editChatMessage(editingMessageInfo.id, trimmedMessage);
        Toast.show({
          type: 'success',
          text1: 'Message updated',
          position: 'top',
        });
        clearInputField();
      } catch (error: any) {
        let text2 = 'Failed to edit message. Please try again.';
        if (error instanceof ChatMessageActionError) {
          switch (error.code) {
            case 'too_old':
              text2 = 'You can no longer edit this message.';
              break;
            case 'not_authorized':
            case 'not_allowed':
              text2 = 'You are not allowed to edit this message.';
              break;
            case 'already_deleted':
              text2 = 'This message has already been removed.';
              break;
          }
        }
        Toast.show({
          type: 'error',
          text1: 'Edit failed',
          text2,
          position: 'top',
        });
        setMessage(trimmedMessage);
        latestMessageRef.current = trimmedMessage;
      } finally {
        sendInFlightRef.current = false;
        setIsSendingMessage(false);
      }

      return;
    }

    if (isMessageOverLimit) {
      const limited = enforceMessageLimits(message);
      if (limited !== message) {
        setMessage(limited);
        latestMessageRef.current = limited;
      }
      Toast.show({
        type: 'info',
        text1: 'Message Too Long',
        text2: `Use up to ${CHAT_MESSAGE_MAX_CHARS} characters and ${CHAT_MESSAGE_MAX_WORDS} words.`,
        position: 'top',
      });
      return;
    }

    if (!canAttemptSend) {
      return;
    }

    const recipient = selectedTeamMember;
    if (!recipient) {
      return;
    }

    const senderEmail = effectiveUser?.email || user?.email || '';

    // Self-address prevention (stuck-message-delivery-fix, Defect A / Property 3):
    // recipient resolution must never fall back to the sender. Block a self-
    // addressed send at the UI entry point so no self-conversation is created.
    const normalizeSelfCheckEmail = (value?: string | null): string =>
      typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (
      normalizeSelfCheckEmail(recipient.id) &&
      normalizeSelfCheckEmail(recipient.id) === normalizeSelfCheckEmail(senderEmail)
    ) {
      Toast.show({
        type: 'info',
        text1: 'Cannot message yourself',
        text2: 'Messaging yourself is not supported.',
        position: 'top',
      });
      return;
    }

    const activeReplyContext = replyingToMessage ? { ...replyingToMessage } : undefined;
    const buildPendingTextMessage = (
      tempId: string,
      text: string,
      status: NonNullable<PendingMessage['status']>,
      replyTo?: ChatReplyContext
    ): PendingMessage => ({
      id: tempId,
      text,
      timestamp: new Date().toISOString(),
      recipientId: recipient.id,
      sender: senderEmail,
      replyTo,
      status,
      // Stable client identity minted once per send; reused on every re-drive so
      // the server upsert stays idempotent (stuck-message-delivery-fix, task 10.2).
      clientMsgId: tempId,
    });

    if (isOffline) {
      // Path-safe id: this tempId becomes the clientMsgId and thus an RTDB path
      // segment on the backend idempotency index. Raw Math.random() produced a
      // dot (e.g. "0.2959…") which RTDB rejects, so a queued message could never
      // send on reconnect (stuck-message-delivery-fix hotfix, Fix A).
      const tempId = generatePendingId('pending');
      const pendingMessage = buildPendingTextMessage(tempId, trimmedMessage, 'queued', activeReplyContext);

      setPendingMessages((prev) => {
        const next = new Map(prev);
        next.set(tempId, pendingMessage);
        return next;
      });

      try {
        await PendingMessageStorage.addPendingMessage(tempId, pendingMessage);
      } catch (error) {
        logger.error('Failed to save pending message to storage:', error);
      }

      clearInputField();

      Toast.show({
        type: 'info',
        text1: 'Message Queued',
        text2: 'You are offline. Your message will be sent when you reconnect.',
        position: 'top',
      });

      clearNewMessageDivider();
      clearUnreadDivider();

      return;
    }

    sendInFlightRef.current = true;
    setIsSendingMessage(true);
    const originalMessage = message;
    const wasShowingSpecialCommand = showSpecialCommand;
    const wasComposingSpecial = isComposingSpecial;
    let optimisticTempId: string | null = null;
    let optimisticPendingMessage: PendingMessage | null = null;

    clearInputField();
    // Immediately clear the spinner for snappy UI while the send continues in background
    setIsSendingMessage(false);

    try {
      let messageText = trimmedMessage;
      let isSpecialMessage = false;

      if (messageText.startsWith('/special ')) {
        messageText = messageText.replace('/special ', '').trim();
        isSpecialMessage = true;
      }

      // Resolve rich content synchronously so the sticker-vs-text decision is
      // made without crossing an async boundary. This lets the optimistic text
      // bubble render on the same frame the user taps send (no flicker, and no
      // risk of briefly showing a text bubble for an emoji that becomes a
      // sticker).
      if (!isSpecialMessage) {
        const rich = resolveChatRichTextInputResult(messageText);
        if (rich.type === 'sticker' && typeof rich.content === 'object') {
          await handleStickerSelect(rich.content, { replyTo: activeReplyContext });
          clearNewMessageDivider();
          clearUnreadDivider();
          if (isAtBottomRef.current) {
              scheduleScrollToBottom({ immediate: true });
          } else {
            setShowScrollToBottomSafely(true);
            incrementUnseenCount();
          }
          return;
        }
      }

      if (!messageText) {
        Toast.show({
          type: 'info',
          text1: 'Empty Message',
          text2: 'Please enter a message after /special command.',
          position: 'top',
        });
        setMessage(originalMessage);
        latestMessageRef.current = originalMessage;
        setShowSpecialCommand(wasShowingSpecialCommand);
        setIsComposingSpecial(wasComposingSpecial);
        setReplyingToMessage(activeReplyContext || null);
        return;
      }

      // 1) Optimistic insert — fully synchronous so the message appears
      //    instantly with a clock ("Sending...") icon, exactly like
      //    WhatsApp/Telegram. No await precedes this state update.
      const tempId = generatePendingId('pending');
      optimisticTempId = tempId;
      optimisticPendingMessage = buildPendingTextMessage(tempId, messageText, 'sending', activeReplyContext);

      setPendingMessages((prev) => {
        const next = new Map(prev);
        next.set(tempId, optimisticPendingMessage as PendingMessage);
        return next;
      });

      // Snap the sender to the bottom right away so they always see their own
      // message land, and retire both dividers — sending is an explicit
      // "caught up" action. `immediate` bypasses InteractionManager so the
      // reveal is not held behind the bubble's entrance animation.
      clearNewMessageDivider();
      clearUnreadDivider();
      scheduleScrollToBottom({ animated: true, immediate: true });

      // Persist for crash/offline recovery, but do NOT block the network send
      // on disk I/O — durability here is best-effort and runs in parallel.
      void PendingMessageStorage.addPendingMessage(tempId, optimisticPendingMessage).catch((storageError) => {
        logger.warn('Failed to persist sending pending message:', storageError);
      });

      // 2) Fire the actual send. Once the backend acknowledges with a server
      //    message id, advance the bubble from clock -> single check ("Sent").
      //    The realtime listener then swaps in the server bubble, which carries
      //    the delivered (double check) and read (blue) receipts.
      const serverMessageId = await sendMessage(messageText, isSpecialMessage, recipient.id, {
        replyTo: activeReplyContext,
        clientMsgId: tempId,
      });

      // A resolved serverMessageId is authoritative proof of a durable record for
      // the intended (non-self) recipient (self-addressed sends are rejected at
      // the write boundary). Record it so the delivered signal confirms this send
      // even if its server bubble is not on the loaded page — it is never re-driven
      // or dead-lettered (chat-production-hardening, P1-2).
      markServerMessageConfirmed(serverMessageId);

      if (optimisticTempId) {
        const idToUpdate = optimisticTempId;
        // Do NOT promote to terminal "Sent" just because the send promise
        // resolved (stuck-message-delivery-fix, task 10.4). A resolved promise
        // only means the write was accepted — not that a durable record exists
        // for the intended recipient. Keep the item in the retriable
        // confirmed-pending state ("Sending…") carrying its serverMessageId, and
        // let the delivered-reconciliation effect promote/clear it only once the
        // record for the intended recipient is independently confirmed (its
        // serverMessageId surfaces in the live conversation). Un-confirmed items
        // are auto-re-driven by the outbox self-heal driver.
        const acknowledgedPendingMessage: PendingMessage = {
          ...(optimisticPendingMessage as PendingMessage),
          status: 'sending',
          serverMessageId,
        };

        setPendingMessages((prev) => {
          const next = new Map(prev);
          const existing = next.get(idToUpdate);
          if (existing) {
            next.set(idToUpdate, {
              ...existing,
              status: 'sending',
              serverMessageId,
            });
          }
          return next;
        });

        // Best-effort persistence of the acknowledged (not-yet-confirmed) state.
        void PendingMessageStorage.addPendingMessage(idToUpdate, acknowledgedPendingMessage).catch((storageError) => {
          logger.warn('Failed to persist acknowledged pending message before reconciliation:', storageError);
        });
      }

      void sendMessageNotification(messageText, isSpecialMessage);

      if (isSpecialMessage) {
        Toast.show({
          type: 'success',
          text1: '⭐ Special Message Sent',
          text2: 'Your special message has been delivered!',
          position: 'top',
        });
      }

      // Both dividers were already retired on the optimistic insert above; the
      // sender's own message is "caught up", so there is nothing to reposition
      // here.
    } catch (error) {
      if (optimisticTempId && optimisticPendingMessage) {
        const failedPending: PendingMessage = {
          ...optimisticPendingMessage,
          status: 'failed',
        };

        const idToUpdate = optimisticTempId;
        setPendingMessages((prev) => {
          const next = new Map(prev);
          const existing = next.get(idToUpdate);
          next.set(idToUpdate, {
            ...(existing || optimisticPendingMessage as PendingMessage),
            status: 'failed',
          });
          return next;
        });

        try {
          await PendingMessageStorage.addPendingMessage(idToUpdate, failedPending);
        } catch (storageError) {
          logger.warn('Failed to persist failed pending message:', storageError);
        }
      }

      if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending message', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending another message.`,
          position: 'top',
        });
        if (!optimisticTempId) {
          setMessage(originalMessage);
          latestMessageRef.current = originalMessage;
          setShowSpecialCommand(wasShowingSpecialCommand);
          setIsComposingSpecial(wasComposingSpecial);
          setReplyingToMessage(activeReplyContext || null);
        }
        return;
      }

      logger.error('Error sending message:', error);
      Toast.show({
        type: 'error',
        text1: 'Send Failed',
        text2: 'Failed to send message. Please try again.',
        position: 'top',
      });
      if (!optimisticTempId) {
        setMessage(originalMessage);
        latestMessageRef.current = originalMessage;
        setShowSpecialCommand(wasShowingSpecialCommand);
        setIsComposingSpecial(wasComposingSpecial);
        setReplyingToMessage(activeReplyContext || null);
      }
    } finally {
      sendInFlightRef.current = false;
      // No need to restore spinner here; user can continue typing next message
    }
  }, [
    sendInFlightRef,
    trimmedMessageValue,
    editingMessageInfo,
    cancelEditingMessage,
    isOffline,
    canAttemptSend,
    selectedTeamMember,
    effectiveUser?.email,
    user?.email,
    clearInputField,
    editChatMessage,
    setMessage,
    message,
    messageCharacterCount,
    messageWordCount,
    isMessageOverLimit,
    enforceMessageLimits,
    showSpecialCommand,
    isComposingSpecial,
    replyingToMessage,
    effectiveUserEmail,
    selectedMemberEmail,
    handleRichTextInput,
    handleStickerSelect,
    dismissUnreadDividerForCurrentBatch,
    isAtBottomRef,
    incrementUnseenCount,
    scrollToBottom,
    sendMessage,
    sendMessageNotification,
    setShowScrollToBottomSafely,
    hasEditedMessageChanged,
    markServerMessageConfirmed,
  ]);

  const handleComposerBlur = useCallback(() => {
    clearActiveTypingStatus('clear_active');
  }, [clearActiveTypingStatus]);

  useEffect(() => {
    clearActiveTypingStatus('pair_change');
  }, [effectiveUserEmail, selectedMemberEmail, clearActiveTypingStatus]);

  const handleTyping = useCallback((text: string) => {
    const limitedText = enforceMessageLimits(text);

    if (limitedText === latestMessageRef.current) {
      return;
    }

    // Only update input; conversion to sticker happens on send
    setMessage(limitedText);
    latestMessageRef.current = limitedText;

    updateSpecialComposerState(limitedText);

    const nextTypingPair = createChatTypingPair(effectiveUserEmail, selectedMemberEmail);
    const transition = resolveChatTypingTransition({
      activePair: typingStatusPairRef.current,
      isTypingActive: typingStatusActiveRef.current,
      nextPair: nextTypingPair,
      hasMessageContent: limitedText.trim().length > 0,
    });

    setTypingStatusForPair(transition.pairToClear, false, 'transition_clear');
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    setTypingStatusForPair(transition.pairToActivate, true, 'transition_activate');

    typingStatusPairRef.current = transition.nextActivePair;
    typingStatusActiveRef.current = transition.nextIsTypingActive;

    if (!transition.shouldScheduleTimeout || !transition.nextActivePair) {
      return;
    }

    const timeoutTypingPair = transition.nextActivePair;
    typingTimeoutRef.current = setTimeout(() => {
      const trackedTypingPair = typingStatusPairRef.current;
      const isMatchingPair = areChatTypingPairsEqual(trackedTypingPair, timeoutTypingPair);

      if (isMatchingPair) {
        setTypingStatusForPair(timeoutTypingPair, false, 'timeout_clear');
        typingStatusPairRef.current = null;
        typingStatusActiveRef.current = false;
      }

      typingTimeoutRef.current = null;
    }, 1000);
    }, [effectiveUserEmail, selectedMemberEmail, enforceMessageLimits, setTypingStatusForPair, updateSpecialComposerState]);

  // Handle special command selection
  const handleSpecialCommandSelect = useCallback(() => {
    handleTyping('/special ');
  }, [handleTyping]);

  const revokeWebObjectUrls = useCallback((filesToRevoke: any[]) => {
    if (Platform.OS !== 'web') {
      return;
    }
    if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
      return;
    }

    const seen = new Set<string>();
    for (const file of filesToRevoke || []) {
      const candidates = [file?.uri, file?.previewUri];
      for (const candidate of candidates) {
        const value = typeof candidate === 'string' ? candidate.trim() : '';
        if (!value || !value.startsWith('blob:') || seen.has(value)) {
          continue;
        }
        seen.add(value);
        try {
          URL.revokeObjectURL(value);
        } catch {}
      }
    }
  }, []);

  const resetFilePreviewModal = useCallback(() => {
    revokeWebObjectUrls(selectedFilesRef.current);
    setFilePreviewVisible(false);
    setSelectedFiles([]);
    selectedFilesRef.current = [];
    setSkippedPreviewFiles([]);
  }, [revokeWebObjectUrls]);

  useEffect(() => {
    return () => {
      revokeWebObjectUrls(selectedFilesRef.current);
    };
  }, [revokeWebObjectUrls]);

  const handleBackToChatList = useCallback(() => {
    Keyboard.dismiss();
    closeMessageInfoModal();
    closeConversationSearch();
    setSelectedTeamMember(null);
  }, [closeConversationSearch, closeMessageInfoModal]);

  // Android hardware back handling: close overlays first, otherwise go from chat detail back to chat list
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        if (emojiPickerVisible) { closeEmojiPicker(); return true; }
        if (stickerGifPickerVisible) { closeStickerGifPicker(); return true; }
        if (attachmentModalVisible) { closeAttachmentModal(); return true; }
        if (imageViewerVisible) { closeImageViewer(); return true; }
        if (filePreviewVisible) { resetFilePreviewModal(); return true; }
        if (messageInfoModalState.visible) { closeMessageInfoModal(); return true; }
        if (chatProfileModalVisible) { closeChatProfileModal(); return true; }
        if (conversationSearchVisible) { closeConversationSearch(); return true; }
        if (selectedTeamMember) { handleBackToChatList(); return true; }
        return false;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => sub.remove();
    }, [
      emojiPickerVisible,
      stickerGifPickerVisible,
      attachmentModalVisible,
      imageViewerVisible,
      filePreviewVisible,
      messageInfoModalState.visible,
      chatProfileModalVisible,
      conversationSearchVisible,
      selectedTeamMember,
      closeStickerGifPicker,
      closeAttachmentModal,
      closeImageViewer,
      closeMessageInfoModal,
      closeChatProfileModal,
      closeConversationSearch,
      closeEmojiPicker,
      handleBackToChatList,
      resetFilePreviewModal,
    ])
  );

  // Web: push a history entry when entering a conversation so the browser back
  // button returns to the chat list instead of navigating away from the chat tab
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (selectedTeamMember) {
      window.history.pushState({ chatConversationOpen: true }, '');
    }
  }, [selectedTeamMember]);

  // Web: intercept the browser popstate (back / forward navigation) to go back
  // to the chat list when a conversation is open, instead of leaving the tab
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const handlePopState = () => {
      if (selectedTeamMember) {
        handleBackToChatList();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [selectedTeamMember, handleBackToChatList]);

  const buildWebDroppedFiles = useCallback(async (droppedFiles: any): Promise<any[]> => {
    const items = Array.from(droppedFiles || []);
    const mapped = await Promise.all(
      items.map(async (file: any) => {
        if (!file) {
          return null;
        }

        const fileName = String(file?.name || 'file');
        const mimeType = String(file?.type || '');
        const isLikelyImage =
          mimeType.toLowerCase().startsWith('image/') ||
          /\.(jpg|jpeg|png|gif|webp|bmp|svg|heic|heif|tif|tiff|ico)$/i.test(fileName);

        const objectUrl =
          typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
            ? URL.createObjectURL(file)
            : null;

        const previewUri: string | null = isLikelyImage ? objectUrl : null;

        const uri = objectUrl || previewUri;
        if (typeof uri !== 'string' || uri.length === 0) {
          return null;
        }

        return {
          uri,
          previewUri: previewUri || undefined,
          name: fileName,
          fileName,
          type: mimeType,
          mimeType,
          fileSize: file?.size,
          size: file?.size,
          lastModified: Number(file?.lastModified || 0) || undefined,
          file,
          webFile: file,
        };
      })
    );

    return mapped.filter((entry): entry is any => Boolean(entry));
  }, []);

  const getPreviewFileIdentity = useCallback((file: any) => {
    const fileName = String(file?.fileName || file?.name || '').trim().toLowerCase();
    const fileSize = Number(file?.fileSize || file?.size || 0);
    const lastModified = Number(file?.lastModified || 0);
    return `${fileName}|${fileSize}|${lastModified}`;
  }, []);

  const previewSelectedFiles = useCallback((files: any[], initialSkipped: string[] = []) => {
    if (!Array.isArray(files) || files.length === 0) {
      const normalizedInitial = Array.from(new Set((initialSkipped || []).filter(Boolean))).slice(0, MAX_SKIPPED_PREVIEW_ITEMS);
      setSkippedPreviewFiles(normalizedInitial);
      if (normalizedInitial.length > 0) {
        setFilePreviewVisible(true);
      }
      return;
    }

    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const oversizedFiles = files.filter((file) => {
      const fileSize = file?.fileSize || file?.size || 0;
      return fileSize > MAX_FILE_SIZE;
    });

    const allowedFiles = files.filter((file) => {
      const fileSize = file?.fileSize || file?.size || 0;
      return fileSize <= MAX_FILE_SIZE;
    });

    const skippedEntries: string[] = [...(initialSkipped || [])];

    if (oversizedFiles.length > 0) {
      const fileNames = oversizedFiles
        .map((file) => file?.fileName || file?.name || 'Unknown file')
        .join(', ');
      skippedEntries.push(
        ...oversizedFiles.map((file) => {
          const name = file?.fileName || file?.name || 'Unknown file';
          const size = file?.fileSize || file?.size || 0;
          return `[Too large] ${name}||${size}`;
        })
      );
      Toast.show({
        type: 'error',
        text1: 'File Too Large',
        text2: `The following file(s) exceed the 50 MB limit: ${fileNames}`,
        position: 'top',
      });
    }

    const currentSelected = selectedFilesRef.current || [];
    const existing = new Set(currentSelected.map((file: any) => getPreviewFileIdentity(file)));
    const skippedNames: string[] = [];
    const toAdd: any[] = [];

    for (const file of allowedFiles) {
      const fileName = String(file?.fileName || file?.name || 'Unknown file');
      const dedupeKey = getPreviewFileIdentity(file);
      if (existing.has(dedupeKey)) {
        skippedNames.push(fileName);
        continue;
      }
      existing.add(dedupeKey);
      toAdd.push(file);
    }

    const addedCount = toAdd.length;
    const nextSelected = addedCount > 0 ? [...currentSelected, ...toAdd] : currentSelected;
    setSelectedFiles(nextSelected);
    selectedFilesRef.current = nextSelected;

    skippedEntries.push(...skippedNames.map((name) => `[Duplicate] ${name}`));
    const normalizedSkipped = Array.from(new Set(skippedEntries.filter(Boolean))).slice(0, MAX_SKIPPED_PREVIEW_ITEMS);
    setSkippedPreviewFiles(normalizedSkipped);

    if (addedCount > 0 || normalizedSkipped.length > 0) {
      setFilePreviewVisible(true);
    }
  }, [MAX_SKIPPED_PREVIEW_ITEMS, getPreviewFileIdentity]);

  // Media pasted/inserted from the keyboard or OS clipboard (the native
  // commitContent bridge on Android — the Gboard GIF button / sticker keyboards —
  // and web `paste`). We validate + normalize, then route:
  //   • Keyboard commitContent (source === 'keyboard') → send IMMEDIATELY as a
  //     sticker/gif message, the same one-shot flow as the StickerGifPicker.
  //   • Clipboard paste (source === 'clipboard') → normal media PREVIEW, so the
  //     user confirms before it's sent as a regular file.
  //   • Unknown source (web paste, iOS, or a pasted web-image URL) → fall back to
  //     FORMAT: GIF/WebP are effectively only ever stickers/GIFs → immediate;
  //     everything else → preview (so a pasted screenshot never auto-sends).
  // The source signal comes from the patched native module (patches/), which tags
  // commitContent vs clipboard; format is only the fallback when it's absent.
  // Video is never a sticker/gif, so it always uses the preview regardless.
  const handleKeyboardMedia = useCallback((candidate: KeyboardMediaCandidate) => {
    if (!selectedTeamMember) {
      return;
    }
    const result = normalizeKeyboardMediaCandidate(candidate, { inferType: inferFileType });
    if (!result.ok) {
      const { title, message } = describeKeyboardMediaRejection(result.reason);
      Toast.show({ type: 'error', text1: title, text2: message, position: 'top' });
      return;
    }
    if (resolveKeyboardMediaSendMode(result.file) === 'sticker') {
      sendKeyboardMediaAsStickerRef.current?.(result.file);
    } else {
      previewSelectedFiles([result.file]);
    }
  }, [selectedTeamMember, previewSelectedFiles]);

  const groupedSkippedPreviewFiles = useMemo(() => {
    const groups: {
      folder: string[];
      duplicate: string[];
      tooLarge: { name: string; fileSize: number }[];
      other: string[];
    } = {
      folder: [],
      duplicate: [],
      tooLarge: [],
      other: [],
    };

    for (const rawEntry of skippedPreviewFiles) {
      const entry = String(rawEntry || '').trim();
      if (!entry) {
        continue;
      }
      const match = entry.match(/^\[(.*?)\]\s*(.*)$/);
      const label = (match?.[1] || '').toLowerCase();
      const value = (match?.[2] || entry).trim();

      if (label === 'folder') {
        groups.folder.push(value);
      } else if (label === 'duplicate') {
        groups.duplicate.push(value);
      } else if (label === 'too large') {
        const pipeIdx = value.lastIndexOf('||');
        if (pipeIdx !== -1) {
          groups.tooLarge.push({
            name: value.slice(0, pipeIdx),
            fileSize: parseInt(value.slice(pipeIdx + 2), 10) || 0,
          });
        } else {
          groups.tooLarge.push({ name: value, fileSize: 0 });
        }
      } else {
        groups.other.push(entry);
      }
    }

    return groups;
  }, [skippedPreviewFiles]);

  const handleChatPageDragOver = useCallback((event: any) => {
    if (Platform.OS !== 'web' || !selectedTeamMember) {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!isChatDropActive) {
      setIsChatDropActive(true);
    }
  }, [isChatDropActive, selectedTeamMember]);

  const handleChatPageDragLeave = useCallback((event: any) => {
    if (Platform.OS !== 'web') {
      return;
    }
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setIsChatDropActive(false);
  }, []);

  const handleChatPageDrop = useCallback(async (event: any) => {
    if (Platform.OS !== 'web') {
      return;
    }

    event?.preventDefault?.();
    event?.stopPropagation?.();
    setIsChatDropActive(false);

    if (!selectedTeamMember) {
      Toast.show({
        type: 'info',
        text1: 'Select a Chat',
        text2: 'Choose a team member before dropping files.',
        position: 'top',
      });
      return;
    }

    if (isOffline) {
      Toast.show({
        type: 'info',
        text1: 'Offline',
        text2: 'You cannot send files while offline. Please reconnect to the internet and try again.',
        position: 'top',
      });
      return;
    }

    const folderNames = Array.from(event?.nativeEvent?.dataTransfer?.items || event?.dataTransfer?.items || [])
      .map((item: any) => item?.webkitGetAsEntry?.())
      .filter((entry: any) => Boolean(entry?.isDirectory))
      .map((entry: any) => String(entry?.name || 'Folder'));

    if (folderNames.length > 0) {
      const message = 'Folder upload is not supported in chat. Please drop files directly.';
      if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(message);
      } else {
        Alert.alert('Folder Not Supported', message);
      }
      Toast.show({
        type: 'error',
        text1: 'Folder Not Supported',
        text2: message,
        position: 'top',
      });
      const skippedFolders = folderNames.map((name) => `[Folder] ${name}`);
      previewSelectedFiles([], skippedFolders);
      return;
    }

    const droppedFiles = event?.nativeEvent?.dataTransfer?.files || event?.dataTransfer?.files;
    if (!droppedFiles || droppedFiles.length === 0) {
      return;
    }

    const files = await buildWebDroppedFiles(droppedFiles);

    previewSelectedFiles(files);
  }, [buildWebDroppedFiles, isOffline, previewSelectedFiles, selectedTeamMember]);

  useEffect(() => {
    if (!selectedTeamMember) {
      setIsChatDropActive(false);
    }
  }, [selectedTeamMember]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !isFocused) {
      return;
    }

    const markDragging = (event: any) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (!selectedTeamMember) {
        return;
      }
      setIsChatDropActive(true);
      if (event?.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    };

    const clearDragging = (event: any) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (!selectedTeamMember) {
        return;
      }
      setIsChatDropActive(false);
    };

    const handleWindowDrop = async (event: any) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (!selectedTeamMember) {
        Toast.show({
          type: 'info',
          text1: 'Select a Chat',
          text2: 'Choose a team member before dropping files.',
          position: 'top',
        });
        return;
      }
      setIsChatDropActive(false);

      const folderNames = Array.from(event?.dataTransfer?.items || [])
        .map((item: any) => item?.webkitGetAsEntry?.())
        .filter((entry: any) => Boolean(entry?.isDirectory))
        .map((entry: any) => String(entry?.name || 'Folder'));

      if (folderNames.length > 0) {
        const message = 'Folder upload is not supported in chat. Please drop files directly.';
        if (typeof window !== 'undefined' && typeof window.alert === 'function') {
          window.alert(message);
        } else {
          Alert.alert('Folder Not Supported', message);
        }
        Toast.show({
          type: 'error',
          text1: 'Folder Not Supported',
          text2: message,
          position: 'top',
        });
        const skippedFolders = folderNames.map((name) => `[Folder] ${name}`);
        previewSelectedFiles([], skippedFolders);
        return;
      }

      if (isOffline) {
        Toast.show({
          type: 'info',
          text1: 'Offline',
          text2: 'You cannot send files while offline. Please reconnect to the internet and try again.',
          position: 'top',
        });
        return;
      }

      const droppedFiles = event?.dataTransfer?.files;
      if (!droppedFiles || droppedFiles.length === 0) {
        return;
      }

      const files = await buildWebDroppedFiles(droppedFiles);

      previewSelectedFiles(files);
    };

    window.addEventListener('dragenter', markDragging);
    window.addEventListener('dragover', markDragging);
    window.addEventListener('dragleave', clearDragging);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragenter', markDragging);
      window.removeEventListener('dragover', markDragging);
      window.removeEventListener('dragleave', clearDragging);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, [buildWebDroppedFiles, isFocused, isOffline, previewSelectedFiles, selectedTeamMember]);

  const handleFileSelection = useCallback(async (type: 'image' | 'camera' | 'document' | 'video' | 'videoCamera') => {
    closeAttachmentModal();

    if (isOffline) {
      Toast.show({
        type: 'info',
        text1: 'Offline',
        text2: 'You cannot send files while offline. Please reconnect to the internet and try again.',
        position: 'top',
      });
      return;
    }

    try {
      let result = null;

      if (type === 'image') {
        result = await MediaPickerUtil.selectImage(true);
      } else if (type === 'camera') {
        result = await MediaPickerUtil.captureImageNoEdit();
      } else if (type === 'video') {
        result = await MediaPickerUtil.selectVideo(true);
      } else if (type === 'videoCamera') {
        result = await MediaPickerUtil.captureVideo();
      } else if (type === 'document') {
        result = await MediaPickerUtil.selectDocument('*/*', true);
      }

      if (result && selectedTeamMember) {
        const resultObj = result as any;
        let files: any[] = [];

        if (resultObj.canceled === false && resultObj.assets && resultObj.assets.length > 0) {
          files = resultObj.assets;
        } else if (resultObj.type === 'success') {
          if (resultObj.files) {
            files = resultObj.files;
          } else {
            files = [{
              uri: resultObj.uri,
              name: resultObj.name,
              fileName: resultObj.name,
              mimeType: resultObj.mimeType,
              fileSize: resultObj.size
            }];
          }
        } else if (resultObj.uri) {
          files = [resultObj];
        }

        if (files.length > 0) {
          previewSelectedFiles(files);
        }
      }
    } catch (error: any) {
      if (error.message?.includes('Permission')) {
        Toast.show({
          type: 'error',
          text1: 'Permission Required',
          text2: `Permission to access ${type === 'camera' ? 'camera' : type === 'image' ? 'photo library' : 'files'} is required.`,
          position: 'top',
        });
        return;
      }

      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: error?.message || 'An error occurred while selecting file.',
        position: 'top',
      });
    }
  }, [closeAttachmentModal, isOffline, previewSelectedFiles, selectedTeamMember]);

  const handleSelectImageAttachment = useCallback(() => {
    void handleFileSelection('image');
  }, [handleFileSelection]);

  const handleSelectCameraAttachment = useCallback(() => {
    void handleFileSelection('camera');
  }, [handleFileSelection]);

  const handleSelectVideoAttachment = useCallback(() => {
    void handleFileSelection('video');
  }, [handleFileSelection]);

  const handleSelectVideoCameraAttachment = useCallback(() => {
    void handleFileSelection('videoCamera');
  }, [handleFileSelection]);

  const handleSelectDocumentAttachment = useCallback(() => {
    void handleFileSelection('document');
  }, [handleFileSelection]);

  const handleSendWithFiles = async () => {
    if (!selectedTeamMember || selectedFiles.length === 0) return;
    const activeReplyContext = replyingToMessage ? { ...replyingToMessage } : undefined;

    const tempId = generatePendingId('pa');
    // When the send is handed to the native background uploader it outlives this
    // function, so the finally block must NOT tear down its cancel registration.
    let backgroundUploadStarted = false;
    const buildPendingAttachmentFiles = () => selectedFiles.map(f => ({
      ...(() => {
        const candidate = (f as any)?.webFile ?? (f as any)?.file;
        const webFile =
          Platform.OS === 'web' && typeof Blob !== 'undefined' && candidate instanceof Blob
            ? candidate
            : undefined;
        return webFile ? { webFile } : {};
      })(),
      uri: f.uri,
      fileName: f.fileName || f.name || 'file',
      fileType: f.mimeType || 'application/octet-stream',
      fileSize: f.fileSize || f.size,
    }));

    // Capture the file list once (selectedFiles is cleared on modal reset) and,
    // on native, copy each file into durable app storage so a queued or
    // interrupted attachment survives an app kill and can be re-uploaded on
    // relaunch. Best-effort: a failed/unsupported stage keeps the original uri.
    const preparedFiles = buildPendingAttachmentFiles();
    const stageAttachmentFilesForUpload = async () =>
      Promise.all(
        preparedFiles.map(async (f, index) => {
          const name = f.fileName || 'file';
          const ext = (name.includes('.') ? name.split('.').pop() : f.fileType.split('/')[1]) || 'bin';
          const stagedUri = await stageOutboxMedia(`${tempId}__${index}`, f.uri, ext);
          return stagedUri ? { ...f, uri: stagedUri } : f;
        })
      );

    // Mirror the text-message offline flow: don't attempt the upload at all
    // while offline. Mark it 'queued' (not 'failed') so it's visually
    // distinct from a real send failure and gets picked up by auto-retry once
    // connectivity returns.
    if (isOffline) {
      setPendingAttachments(prev => {
        const next = new Map(prev);
        next.set(tempId, {
          id: tempId,
          files: preparedFiles,
          messageText: message.trim(),
          timestamp: new Date().toISOString(),
          recipientId: selectedTeamMember.id,
          sender: effectiveUser?.email || '',
          replyTo: activeReplyContext,
          status: 'queued',
          progress: 0,
          cancelable: false,
          cancelRequested: false,
          failureReason: undefined,
        });
        return next;
      });

      clearInputField();
      resetFilePreviewModal();
      clearNewMessageDivider();
      clearUnreadDivider();
      scheduleScrollToBottom({ animated: true, immediate: true });

      Toast.show({
        type: 'info',
        text1: 'Files Queued',
        text2: 'You are offline. They will be sent when you reconnect.',
        position: 'top',
      });

      // Stage the queued files so they survive an app kill; point the persisted
      // bubble at the durable copies once ready (auto-retry uploads from them).
      void stageAttachmentFilesForUpload()
        .then((staged) => {
          setPendingAttachments(prev => {
            const next = new Map(prev);
            const cur = next.get(tempId);
            if (cur) {
              next.set(tempId, { ...cur, files: staged });
            }
            return next;
          });
        })
        .catch(() => undefined);
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    try {
      // Create optimistic pending attachment bubble
      setPendingAttachments(prev => {
        const next = new Map(prev);
        next.set(tempId, {
          id: tempId,
          files: preparedFiles,
          messageText: message.trim(),
          timestamp: new Date().toISOString(),
          recipientId: selectedTeamMember.id,
          sender: effectiveUser?.email || '',
          replyTo: activeReplyContext,
          status: 'sending',
          progress: 0,
          cancelable: false,
          cancelRequested: false,
          failureReason: undefined,
        });
        return next;
      });

      // Snap to the bottom immediately so the sender sees the attachment
      // bubble land, mirroring the instant text-message behaviour. `immediate`
      // bypasses InteractionManager so the reveal is not held behind animations.
      clearNewMessageDivider();
      clearUnreadDivider();
      scheduleScrollToBottom({ animated: true, immediate: true });

      // Stage onto durable storage and point the optimistic bubble at the staged
      // copies (so a mid-upload kill can resume from them), then upload.
      const filesToUpload = await stageAttachmentFilesForUpload();
      setPendingAttachments(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) {
          next.set(tempId, { ...cur, files: filesToUpload });
        }
        return next;
      });

      // Phase 2 — single-file attachments upload in the background (kill-safe),
      // reusing the proven sticker/gif transport (one file -> one message created
      // server-side, idempotent by clientMsgId). A multi-file send is ONE message
      // with N files, which the single-file background endpoint can't reproduce,
      // so only single-file sends take this path; multi-file falls through to the
      // durable foreground path below. Gated on the app being foreground/active
      // (Android 12 foreground-service start restriction) with transparent fallback.
      // Reply context isn't carried by the background-upload message-create path,
      // so a reply falls through to the foreground path (which preserves replyTo).
      const singleBgFile = filesToUpload.length === 1 ? filesToUpload[0] : null;
      if (
        singleBgFile &&
        !singleBgFile.webFile &&
        !activeReplyContext &&
        effectiveUser?.email &&
        isMediaStagingSupported() &&
        isBackgroundUploadEnabled() &&
        AppState.currentState === 'active'
      ) {
        try {
          const senderEmail = effectiveUser.email;
          const attachmentText = resolveChatAttachmentAutoText({
            text: message.trim(),
            files: filesToUpload,
          });
          const request = await chatService.buildChatBackgroundUploadRequest({
            fileName: singleBgFile.fileName,
            fileType: singleBgFile.fileType,
            senderEmail,
            recipientEmail: selectedTeamMember.id,
            mediaKind: 'attachment',
            clientMsgId: tempId,
            text: attachmentText || undefined,
          });

          // Durably record BEFORE starting so a crash/kill mid-upload can't lose it
          // (the debounced whole-map save is starved by progress-tick re-renders).
          // Hydration re-drives it on relaunch, idempotent by clientMsgId (= tempId).
          void PendingMessageStorage.upsertPendingAttachmentMessage(tempId, {
            id: tempId,
            files: filesToUpload,
            messageText: message.trim(),
            timestamp: new Date().toISOString(),
            recipientId: selectedTeamMember.id,
            sender: senderEmail,
            status: 'sending',
            progress: 0,
          } as unknown as PendingAttachmentMessage);

          // Wire the bubble's cancel button to the native background upload BEFORE
          // starting, so a fast completion can't race an un-registered cancel.
          attachmentUploadCancelMap.current.set(tempId, async () => {
            await cancelChatBackgroundUpload(tempId);
          });
          setPendingAttachments(prev => {
            const next = new Map(prev);
            const cur = next.get(tempId);
            if (cur) {
              next.set(tempId, { ...cur, cancelable: true, cancelRequested: false });
            }
            return next;
          });

          let unsubscribe: () => void = () => {};
          const finalizeBgAttachment = (status: 'finalizing' | 'failed', serverMessageId?: string) => {
            setPendingAttachments(prev => {
              const next = new Map(prev);
              const cur = next.get(tempId);
              if (cur) {
                next.set(
                  tempId,
                  status === 'finalizing'
                    ? { ...cur, status: 'finalizing', progress: 100, cancelable: false, cancelRequested: false, serverMessageId }
                    : { ...cur, status: 'failed', progress: 0, cancelable: false, cancelRequested: false, failureReason: 'error' }
                );
              }
              return next;
            });
            attachmentUploadCancelMap.current.delete(tempId);
            if (status === 'finalizing') {
              void PendingMessageStorage.removePendingAttachmentMessage(tempId);
              filesToUpload.forEach((f) => {
                if (f?.uri) {
                  void removeOutboxMedia(f.uri);
                }
              });
              scheduleAttachmentFinalizeCleanup(tempId);
            }
            unsubscribe();
          };

          const started = await startChatBackgroundUpload({
            uploadId: tempId,
            filePath: singleBgFile.uri,
            url: request.url,
            headers: request.headers,
            handlers: {
              onProgress: (progress) => {
                setPendingAttachments(prev => {
                  const next = new Map(prev);
                  const cur = next.get(tempId);
                  if (cur && cur.status === 'sending') {
                    next.set(tempId, { ...cur, progress });
                  }
                  return next;
                });
              },
              onCompleted: (event) => {
                if (event.responseCode >= 200 && event.responseCode < 300) {
                  let serverMessageId: string | undefined;
                  try {
                    serverMessageId = JSON.parse(event.responseBody)?.messageId;
                  } catch {
                    // no id in body — the message still exists server-side (createMessage)
                  }
                  finalizeBgAttachment('finalizing', serverMessageId);
                } else {
                  logger.warn('[chat] background attachment upload non-2xx', { code: event.responseCode });
                  finalizeBgAttachment('failed');
                }
              },
              onError: (event) => {
                logger.warn('[chat] background attachment upload error', event.error);
                finalizeBgAttachment('failed');
              },
              onCancelled: () => {
                finalizeBgAttachment('failed');
              },
            },
          });
          unsubscribe = started.unsubscribe;

          clearInputField();
          resetFilePreviewModal();
          Toast.show({
            type: 'success',
            text1: 'Sending File',
            text2: 'Uploading in the background.',
            position: 'top',
          });
          backgroundUploadStarted = true;
          return; // upload events reconcile the bubble; foreground path skipped
        } catch (bgError) {
          logger.warn('[chat] background attachment start failed; using foreground path', bgError);
          // fall through to the foreground upload path
        }
      }

      // Upload all files in a single message with progress tracking
      const serverMessageId = await sendMessageWithFiles(
        message.trim(), // Send the message text with all files
        filesToUpload,
        selectedTeamMember.id,
        (progress) => {
          setUploadProgress(progress);
          // Update optimistic per-bubble overlay progress
          setPendingAttachments(prev => {
            const next = new Map(prev);
            const cur = next.get(tempId);
            if (cur && cur.status === 'sending') {
              next.set(tempId, { ...cur, progress });
            }
            return next;
          });
        },
        {
          registerCancel: (cancelFn) => {
            attachmentUploadCancelMap.current.set(tempId, cancelFn);
            setPendingAttachments(prev => {
              const next = new Map(prev);
              const cur = next.get(tempId);
              if (cur) {
                next.set(tempId, { ...cur, cancelable: true, cancelRequested: false });
              }
              return next;
            });
          },
          replyTo: activeReplyContext,
          clientMsgId: tempId,
        }
      );
      
      // Clear message and files after sending
      clearInputField(); // Use helper function to clear input
      resetFilePreviewModal();
      attachmentUploadCancelMap.current.delete(tempId);
      setPendingAttachments(prev => {
        const next = new Map(prev);
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            status: 'finalizing',
            progress: 100,
            cancelable: false,
            cancelRequested: false,
            serverMessageId,
          });
        } else {
          next.delete(tempId);
        }
        return next;
      });

      scheduleAttachmentFinalizeCleanup(tempId);
      attachmentUploadCancelMap.current.delete(tempId);
      // The server has the files now — drop the staged copies (no-op for
      // non-staged/original uris, e.g. web).
      filesToUpload.forEach((f) => {
        if (f?.uri) {
          void removeOutboxMedia(f.uri);
        }
      });
      
      Toast.show({
        type: 'success',
        text1: 'Files Sent',
        text2: `Successfully sent ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}`,
        position: 'top',
      });
      
    } catch (error) {
  clearAttachmentFinalizeTimer(tempId);
  attachmentUploadCancelMap.current.delete(tempId);
      resetFilePreviewModal();
      // Mark pending optimistic bubble as failed
      setPendingAttachments(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) {
          next.set(tempId, {
            ...cur,
            status: 'failed',
            progress: 0,
            cancelable: false,
            cancelRequested: false,
            failureReason: error instanceof ChatUploadCanceledError ? 'canceled' : 'error',
          });
        }
        return next;
      });

      if (error instanceof ChatUploadCanceledError) {
        logger.info('Attachment upload canceled by user', { tempId });
        Toast.show({
          type: 'info',
          text1: 'Upload Canceled',
          text2: 'Attachment upload was canceled.',
          position: 'top',
        });
      } else if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending files', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending more files.`,
          position: 'top',
        });
      } else {
        logger.error('Error sending files:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'Failed to send files. Please try again.',
          position: 'top',
        });
      }
    } finally {
      // Keep the cancel registration alive for an in-flight background upload; it
      // reconciles via events after this function returns and owns its own cleanup.
      if (!backgroundUploadStarted) {
        attachmentUploadCancelMap.current.delete(tempId);
      }
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const markNetworkError = useCallback((url: string) => {
    if (!url || !/^https?:\/\//i.test(url)) {
      return;
    }
    setNetworkErrorUrls(prev => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const clearNetworkError = useCallback((url: string) => {
    if (!url) return;
    setNetworkErrorUrls(prev => {
      if (!prev.has(url)) return prev;
      const next = new Set(prev);
      next.delete(url);
      return next;
    });
  }, []);

  const getDownloadKey = useCallback((url?: string) => (url || '').trim(), []);

  const handleDownloadFile = async (fileUrl: string, fileName: string, localHint?: string) => {
    const downloadKey = getDownloadKey(fileUrl);
    if (!downloadKey) return;

    if (downloadingUrlsRef.current.has(downloadKey)) {
      Toast.show({
        type: 'info',
        text1: 'Download in progress',
        text2: 'Please wait for the current download to finish.',
        position: 'top',
      });
      return;
    }

    downloadingUrlsRef.current.add(downloadKey);
    setDownloadState(downloadKey, { isDownloading: true, progress: 0 });

    // Show starting download toast notification immediately
    Toast.show({
      type: 'info',
      text1: 'Starting download, please wait...',
      text2: `Preparing ${fileName} for download`,
      position: 'top',
    });

    try {
      let effectiveUrl = fileUrl;
      const trimmedHint = localHint?.trim();
      const safeLocalHint =
        trimmedHint && trimmedHint.startsWith('file://') && !trimmedHint.toLowerCase().includes('/chat-media-previews/')
          ? trimmedHint
          : undefined;
      effectiveUrl = await chatCacheService.getMediaForDownload(fileUrl, fileName, safeLocalHint, 'high');

      if (Platform.OS === 'web') {
        // For web, check if URL is accessible first
        const isLocalWebUrl = effectiveUrl.startsWith('blob:') || effectiveUrl.startsWith('data:');
        if (!isLocalWebUrl) {
          const availability = await FileDownloadUtil.checkFileAvailability(effectiveUrl, { timeoutMs: 5000 });
          if (availability === 'missing') {
            setBrokenFileUrls(prev => new Set([...prev, fileUrl]));
            clearNetworkError(fileUrl);
            Toast.show({
              type: 'error',
              text1: 'File Not Available',
              text2: 'This file has been deleted or is no longer accessible.',
              position: 'top',
            });
            return;
          }
        }
        
        // Use the new download utility that handles CORS properly
        await FileDownloadUtil.downloadFileWithProgress(effectiveUrl, fileName, (percent) => {
          setDownloadState(downloadKey, { isDownloading: true, progress: percent });
        });

        clearNetworkError(fileUrl);
        
        Toast.show({
          type: 'success',
          text1: 'Download Started',
          text2: `Downloading ${fileName}...`,
          position: 'top',
        });
      } else {
        // For mobile, load Expo modules lazily to avoid bundling on web
        const FileSystem = require('expo-file-system') as typeof import('expo-file-system');
        const Sharing = require('expo-sharing') as typeof import('expo-sharing');

        const isLocalFile = effectiveUrl.startsWith('file://');
        const downloadPath = isLocalFile
          ? effectiveUrl
          : `${FileSystem.documentDirectory}${fileName}`;
        const downloadResult = isLocalFile
          ? { status: 200, uri: effectiveUrl }
          : await FileSystem.createDownloadResumable(
              effectiveUrl,
              downloadPath,
              {},
              (progress) => {
                const total = progress.totalBytesExpectedToWrite;
                if (!total || total <= 0) {
                  return;
                }
                const pct = Math.floor((progress.totalBytesWritten / total) * 100);
                const bounded = Math.max(0, Math.min(99, pct));
                setDownloadState(downloadKey, { isDownloading: true, progress: bounded });
              }
            ).downloadAsync();

        if (!downloadResult) {
          throw new Error('Download failed');
        }

        if (downloadResult.status !== 200) {
          throw new Error('Download failed');
        }

        setDownloadState(downloadKey, { isDownloading: true, progress: 100 });

        const canShare = await Sharing.isAvailableAsync();
        if (!canShare) {
          clearNetworkError(fileUrl);
          Toast.show({
            type: 'success',
            text1: 'Saved to device',
            text2: `File stored at ${downloadResult.uri}`,
            position: 'top',
          });
          return;
        }

        await Sharing.shareAsync(downloadResult.uri);
        clearNetworkError(fileUrl);
        Toast.show({
          type: 'success',
          text1: 'Download Complete',
          text2: `Downloaded ${fileName}`,
          position: 'top',
        });
      }
    } catch (error) {
      logger.error('Download error:', error);
      let availability: 'ok' | 'missing' | 'unknown' = 'unknown';
      if (Platform.OS === 'web') {
        availability = await FileDownloadUtil.checkFileAvailability(fileUrl, { timeoutMs: 5000 });
      }

      if (availability === 'missing') {
        setBrokenFileUrls(prev => new Set([...prev, fileUrl]));
        clearNetworkError(fileUrl);
        Toast.show({
          type: 'error',
          text1: 'File Not Available',
          text2: 'This file has been deleted or is no longer accessible.',
          position: 'top',
        });
        return;
      }

      markNetworkError(fileUrl);
      Alert.alert(
        'Network Error',
        'Unable to reach the file. Check your connection and try again.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Retry', onPress: () => handleDownloadFile(fileUrl, fileName, localHint) },
        ]
      );
    } finally {
      downloadingUrlsRef.current.delete(downloadKey);
      clearDownloadState(downloadKey);
    }
  };

  const handleImageView = async (imageUri: string, remoteUrl?: string, fileName?: string) => {
    const key = remoteUrl || imageUri;
    if (key && brokenFileUrls.has(key)) {
      Toast.show({
        type: 'error',
        text1: 'Image Not Available',
        text2: 'This image has been deleted or is no longer accessible.',
        position: 'top',
      });
      return;
    }

  const trimmedUri = typeof imageUri === 'string' ? imageUri.trim() : '';
  const initialUri = trimmedUri || remoteUrl;
    if (!initialUri) {
      return;
    }

    if (remoteUrl && !remoteUrl.startsWith('file://')) {
      setLastViewedRemoteImage(remoteUrl);
    } else {
      setLastViewedRemoteImage(undefined);
    }

    setSelectedImageUri(initialUri);
    setImageViewerVisible(true);

    if (!remoteUrl) {
      return;
    }

    const safeLocalHint =
      trimmedUri && trimmedUri.startsWith('file://') && !trimmedUri.toLowerCase().includes('/chat-media-previews/')
        ? trimmedUri
        : undefined;

    try {
      const localUri = await chatCacheService.getMediaForDownload(remoteUrl, fileName, safeLocalHint, 'high');
      if (localUri && localUri !== initialUri) {
        setSelectedImageUri(localUri);
      }
    } catch (error) {
      logger.warn('Failed to prepare image for viewer', error);
    }
  };

  const handleImageError = async (fileUrl: string) => {
    if (!fileUrl || fileUrl.startsWith('file://') || fileUrl.startsWith('blob:') || fileUrl.startsWith('data:')) {
      return;
    }

    const availability = await FileDownloadUtil.checkFileAvailability(fileUrl, { timeoutMs: 5000 });
    if (availability === 'missing') {
      setBrokenFileUrls(prev => new Set([...prev, fileUrl]));
      clearNetworkError(fileUrl);
      return;
    }

    if (availability === 'unknown') {
      markNetworkError(fileUrl);
    }
  };

  // Handle sticker selection and sending
  async function handleStickerSelect(sticker: {
    url: string;
    name: string;
    pack?: string;
    width?: number;
    height?: number;
  }, options?: { replyTo?: ChatReplyContext }) {
    if (!selectedTeamMember || !effectiveUser?.email) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Please select a team member to send sticker to.',
        position: 'top',
      });
      return;
    }

    const activeReplyContext = options?.replyTo ?? (replyingToMessage ? { ...replyingToMessage } : undefined);

    // Optimistic pending sticker
    const tempId = generatePendingId('pm');

    // Mirror the text-message offline flow: don't attempt the network call at
    // all while offline. Mark it 'queued' (not 'failed') so it's visually
    // distinct from a real send failure and gets picked up by auto-retry once
    // connectivity returns.
    if (isOffline) {
      setPendingMedia(prev => new Map(prev).set(tempId, {
        id: tempId,
        kind: 'sticker',
        previewUri: sticker.url,
        width: sticker.width,
        height: sticker.height,
        nameOrTitle: sticker.name,
        timestamp: new Date().toISOString(),
        recipientId: selectedTeamMember.id,
        sender: effectiveUser.email,
        replyTo: activeReplyContext,
        status: 'queued',
        source: 'picker',
      }));

      clearNewMessageDivider();
      clearUnreadDivider();
      scheduleScrollToBottom({ animated: true, immediate: true });

      Toast.show({
        type: 'info',
        text1: 'Sticker Queued',
        text2: 'You are offline. It will be sent when you reconnect.',
        position: 'top',
      });
      return;
    }

    try {
      setPendingMedia(prev => new Map(prev).set(tempId, {
        id: tempId,
        kind: 'sticker',
        previewUri: sticker.url,
        width: sticker.width,
        height: sticker.height,
        nameOrTitle: sticker.name,
        timestamp: new Date().toISOString(),
        recipientId: selectedTeamMember.id,
        sender: effectiveUser.email,
        replyTo: activeReplyContext,
        status: 'sending',
        source: 'picker',
      }));

      // Snap to the bottom immediately so the sender sees the sticker land,
      // mirroring the instant text-message behaviour. `immediate` bypasses
      // InteractionManager so the reveal is not held behind animations.
      clearNewMessageDivider();
      clearUnreadDivider();
      scheduleScrollToBottom({ animated: true, immediate: true });

      const serverMessageId = await sendSticker(sticker, selectedTeamMember.id, {
        replyTo: activeReplyContext,
        clientMsgId: tempId,
      });
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) {
          next.set(tempId, { ...cur, status: 'sent', serverMessageId, progress: 100 });
        }
        return next;
      });

      if (activeReplyContext) {
        setReplyingToMessage((current) =>
          current && current.messageId === activeReplyContext.messageId ? null : current
        );
      }
      
      // Send notification to recipient for sticker
      await sendMessageNotification('Sent a sticker', false, sticker);
      
      Toast.show({
        type: 'success',
        text1: '🎯 Sticker Sent',
        text2: `Sent "${sticker.name}" sticker to ${selectedTeamMember.name}`,
        position: 'top',
      });

      // Only scroll if user is at bottom
      if (isAtBottomRef.current) {
        scheduleScrollToBottom();
      } else {
        setShowScrollToBottomSafely(true);
        incrementUnseenCount();
      }
    } catch (error) {
      // Mark pending as failed
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, status: 'failed' });
        return next;
      });

      if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending sticker', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending another sticker.`,
          position: 'top',
        });
      } else {
        logger.error('Error sending sticker:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'Failed to send sticker. Please try again.',
          position: 'top',
        });
      }
    }
  }

  // Handle GIF selection and sending
  const handleGifSelect = async (gif: {
    url: string;
    thumbnailUrl?: string;
    width?: number;
    height?: number;
    title?: string;
    source?: string;
  }, options?: { replyTo?: ChatReplyContext }) => {
    if (!selectedTeamMember || !effectiveUser?.email) {
      Toast.show({
        type: 'error',
        text1: 'Error',
        text2: 'Please select a team member to send GIF to.',
        position: 'top',
      });
      return;
    }

    const activeReplyContext = options?.replyTo ?? (replyingToMessage ? { ...replyingToMessage } : undefined);

    // Optimistic pending GIF
    const tempId = generatePendingId('pm');

    // Mirror the text-message offline flow: don't attempt the network call at
    // all while offline. Mark it 'queued' (not 'failed') so it's visually
    // distinct from a real send failure and gets picked up by auto-retry once
    // connectivity returns.
    if (isOffline) {
      setPendingMedia(prev => new Map(prev).set(tempId, {
        id: tempId,
        kind: 'gif',
        previewUri: gif.url,
        width: gif.width,
        height: gif.height,
        nameOrTitle: gif.title || 'GIF',
        timestamp: new Date().toISOString(),
        recipientId: selectedTeamMember.id,
        sender: effectiveUser.email,
        replyTo: activeReplyContext,
        status: 'queued',
        source: 'picker',
      }));

      clearNewMessageDivider();
      clearUnreadDivider();
      scheduleScrollToBottom({ animated: true, immediate: true });

      Toast.show({
        type: 'info',
        text1: 'GIF Queued',
        text2: 'You are offline. It will be sent when you reconnect.',
        position: 'top',
      });
      return;
    }

    try {
      setPendingMedia(prev => new Map(prev).set(tempId, {
        id: tempId,
        kind: 'gif',
        previewUri: gif.url,
        width: gif.width,
        height: gif.height,
        nameOrTitle: gif.title || 'GIF',
        timestamp: new Date().toISOString(),
        recipientId: selectedTeamMember.id,
        sender: effectiveUser.email,
        replyTo: activeReplyContext,
        status: 'sending',
        source: 'picker',
      }));

      // Snap to the bottom immediately so the sender sees the GIF land,
      // mirroring the instant text-message behaviour. `immediate` bypasses
      // InteractionManager so the reveal is not held behind animations.
      clearNewMessageDivider();
      clearUnreadDivider();
      scheduleScrollToBottom({ animated: true, immediate: true });

      const serverMessageId = await sendGif(gif, selectedTeamMember.id, {
        replyTo: activeReplyContext,
        clientMsgId: tempId,
      });
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) {
          next.set(tempId, { ...cur, status: 'sent', serverMessageId, progress: 100 });
        }
        return next;
      });

      if (activeReplyContext) {
        setReplyingToMessage((current) =>
          current && current.messageId === activeReplyContext.messageId ? null : current
        );
      }
      
      // Send notification to recipient for GIF
      await sendMessageNotification('Sent a GIF', false, undefined, gif);
      
      Toast.show({
        type: 'success',
        text1: '📹 GIF Sent',
        text2: `Sent "${gif.title || 'GIF'}" to ${selectedTeamMember.name}`,
        position: 'top',
      });

      // Only scroll if user is at bottom
      if (isAtBottomRef.current) {
        scheduleScrollToBottom();
      } else {
        setShowScrollToBottomSafely(true);
        incrementUnseenCount();
      }
    } catch (error) {
      // Mark pending as failed
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, status: 'failed' });
        return next;
      });

      if (error instanceof ChatRateLimitError) {
        const waitMs = Math.max(0, error.retryAfterMs || 0);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        logger.warn('Rate limited while sending GIF', { waitMs, blockedUntil: error.blockedUntil });
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending another GIF.`,
          position: 'top',
        });
      } else {
        logger.error('Error sending GIF:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'Failed to send GIF. Please try again.',
          position: 'top',
        });
      }
    }
  };

  // Send keyboard/clipboard media (a sticker/GIF from the keyboard, or an image
  // pasted from the OS clipboard) immediately as a sticker/gif message — the same
  // one-shot, no-preview flow as the StickerGifPicker. Unlike picker items (which
  // are permanent remote URLs sent as-is), keyboard media are LOCAL uris, so we
  // upload first, then post it as a sticker/gif. The optimistic bubble, rendering,
  // offline queue, and auto-retry-on-reconnect (via retryPendingMedia) are all
  // shared with the picker path — no duplicate rendering/queue logic.
  const sendKeyboardMediaAsSticker = async (file: KeyboardMediaFile) => {
    if (!selectedTeamMember || !effectiveUser?.email) {
      return;
    }
    const kind: 'gif' | 'sticker' = file.mimeType === 'image/gif' ? 'gif' : 'sticker';
    const tempId = generatePendingId('pm');
    const activeReplyContext = replyingToMessage ? { ...replyingToMessage } : undefined;
    const nameOrTitle = file.fileName || (kind === 'gif' ? 'GIF' : 'Sticker');

    // Web: stash the raw Blob so the upload doesn't rely on a revocable object URL.
    if (file.webFile) {
      keyboardMediaBlobRef.current.set(tempId, file.webFile);
    }

    setPendingMedia(prev => new Map(prev).set(tempId, {
      id: tempId,
      kind,
      previewUri: file.uri,
      nameOrTitle,
      timestamp: new Date().toISOString(),
      recipientId: selectedTeamMember.id,
      sender: effectiveUser.email,
      replyTo: activeReplyContext,
      status: isOffline ? 'queued' : 'sending',
      source: 'keyboard',
      mime: file.mimeType,
      progress: 0,
    }));

    // Snap to the bottom immediately so the sender sees the bubble land, matching
    // the instant text/sticker behaviour.
    clearNewMessageDivider();
    clearUnreadDivider();
    scheduleScrollToBottom({ animated: true, immediate: true });

    // Copy the media into app-private storage so the upload (and any retry) reads
    // from a stable source rather than a volatile content:// / cache uri (which
    // can be evicted or lose its read grant). Best-effort + native-only: on web
    // or on failure we keep the original uri and fall back to the stashed Blob.
    const stagedExt =
      (file.fileName.includes('.') ? file.fileName.split('.').pop() : file.mimeType.split('/')[1]) || 'bin';
    const stagedUri = await stageOutboxMedia(tempId, file.uri, stagedExt);
    if (stagedUri) {
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, previewUri: stagedUri });
        return next;
      });
    }
    const uploadUri = stagedUri || file.uri;

    // Durably persist this send RIGHT NOW — before any upload starts — so a crash
    // or kill mid-upload can never lose it. The debounced whole-map outbox save is
    // easily starved by the frequent progress-tick re-renders (each resets its
    // 800ms timer), which is exactly how an in-flight sticker was lost when the
    // foreground-service crash hit. This targeted write guarantees the item is on
    // disk; hydration re-drives it on next launch, idempotent by clientMsgId so a
    // send that actually completed never duplicates. Native only (no Blob here).
    if (isMediaStagingSupported()) {
      void PendingMessageStorage.upsertPendingMediaMessage(tempId, {
        id: tempId,
        kind,
        previewUri: uploadUri,
        nameOrTitle,
        timestamp: new Date().toISOString(),
        recipientId: selectedTeamMember.id,
        sender: effectiveUser.email,
        status: isOffline ? 'queued' : 'sending',
        source: 'keyboard',
        mime: file.mimeType,
        progress: 0,
        clientMsgId: tempId,
        replyTo: activeReplyContext as unknown as PendingMediaMessage['replyTo'],
      });
    }

    // Offline: leave it 'queued' (not 'failed') — the auto-retry-on-reconnect
    // effect resends it through retryPendingMedia, which uploads the local uri
    // (reusing the stashed Blob on web) then posts the sticker/gif.
    if (isOffline) {
      Toast.show({
        type: 'info',
        text1: kind === 'gif' ? 'GIF Queued' : 'Sticker Queued',
        text2: 'You are offline. It will be sent when you reconnect.',
        position: 'top',
      });
      return;
    }

    // Phase 2 — true background transfer (opt-in via EXPO_PUBLIC_ENABLE_BG_UPLOAD).
    // Hand the staged file to the native background uploader, which POSTs it to
    // /storage/upload?createMessage=1 so the transfer finishes AND the message is
    // created server-side even if the app is killed mid-upload (idempotent by the
    // clientMsgId = tempId). The optimistic bubble is reconciled from the upload
    // events while the app is alive; if it dies, the server-created message loads
    // normally on next launch and the durable outbox is the backstop. Any failure
    // to START the background upload falls through to the foreground path below.
    //
    // Only START the native background upload while the app is foreground/active.
    // gotev's UploadService is a foreground service; on Android 12+ starting one
    // while the app is in the background throws ForegroundServiceStartNotAllowedException
    // (an uncatchable native crash). Starting it while active gives the OS a grace
    // window so the transfer safely continues after the app is later backgrounded.
    // If not active, fall through to the foreground upload; either way the durable
    // record persisted above guarantees resume-on-relaunch.
    //
    // Reply context isn't carried by the background-upload message-create path, so
    // a reply falls through to the foreground path (which preserves replyTo).
    const canStartForegroundService = AppState.currentState === 'active';
    if (isBackgroundUploadEnabled() && canStartForegroundService && !activeReplyContext) {
      try {
        const request = await chatService.buildChatBackgroundUploadRequest({
          fileName: file.fileName,
          fileType: file.mimeType,
          senderEmail: effectiveUser.email,
          recipientEmail: selectedTeamMember.id,
          mediaKind: kind,
          clientMsgId: tempId,
        });

        let unsubscribe: () => void = () => {};
        const finalize = (status: 'sent' | 'failed', serverMessageId?: string) => {
          if (status === 'sent') {
            keyboardMediaBlobRef.current.delete(tempId);
            if (stagedUri) {
              void removeOutboxMedia(stagedUri);
            }
            // Sent successfully — drop the durable record so relaunch won't re-drive it.
            void PendingMessageStorage.removePendingMediaMessage(tempId);
          }
          setPendingMedia(prev => {
            const next = new Map(prev);
            const cur = next.get(tempId);
            if (cur) {
              next.set(
                tempId,
                status === 'sent'
                  ? { ...cur, status: 'sent', serverMessageId, progress: 100 }
                  : { ...cur, status: 'failed', progress: 0 }
              );
            }
            return next;
          });
          unsubscribe();
        };

        const started = await startChatBackgroundUpload({
          uploadId: tempId,
          filePath: uploadUri,
          url: request.url,
          headers: request.headers,
          handlers: {
            onProgress: (progress) => {
              setPendingMedia(prev => {
                const next = new Map(prev);
                const cur = next.get(tempId);
                if (cur && cur.status === 'sending') {
                  next.set(tempId, { ...cur, progress });
                }
                return next;
              });
            },
            onCompleted: (event) => {
              if (event.responseCode >= 200 && event.responseCode < 300) {
                let serverMessageId: string | undefined;
                try {
                  serverMessageId = JSON.parse(event.responseBody)?.messageId;
                } catch {
                  // response body not JSON / no id — the message still exists
                  // server-side (createMessage) and reconciles on next load.
                }
                finalize('sent', serverMessageId);
              } else {
                logger.warn('[chat] background upload completed non-2xx', { code: event.responseCode });
                finalize('failed');
              }
            },
            onError: (event) => {
              logger.warn('[chat] background upload error', event.error);
              finalize('failed');
            },
            onCancelled: () => {
              finalize('failed');
            },
          },
        });
        unsubscribe = started.unsubscribe;

        // No reply-context reset needed here: this branch only runs when there is
        // no active reply (replies use the foreground path, which carries replyTo).
        if (isAtBottomRef.current) {
          scheduleScrollToBottom();
        } else {
          setShowScrollToBottomSafely(true);
          incrementUnseenCount();
        }
        return;
      } catch (bgError) {
        logger.warn('[chat] background upload start failed; using foreground path', bgError);
        // fall through to the foreground upload path
      }
    }

    try {
      const { url } = await chatService.uploadFile(
        uploadUri,
        file.fileName,
        file.mimeType,
        {
          senderEmail: effectiveUser.email,
          recipientEmail: selectedTeamMember.email || selectedTeamMember.id,
        },
        (progress) => {
          setPendingMedia(prev => {
            const next = new Map(prev);
            const cur = next.get(tempId);
            if (cur && cur.status === 'sending') {
              next.set(tempId, { ...cur, progress });
            }
            return next;
          });
        },
        undefined,
        keyboardMediaBlobRef.current.get(tempId),
      );

      // Warm the local cache so message reconciliation doesn't re-download it.
      void chatCacheService.getMediaForDownload(url, nameOrTitle, undefined, 'low').catch(() => undefined);

      const serverMessageId = kind === 'gif'
        ? await sendGif({ url, source: 'keyboard' } as any, selectedTeamMember.id, { replyTo: activeReplyContext, clientMsgId: tempId })
        : await sendSticker({ url, name: nameOrTitle, pack: 'keyboard' } as any, selectedTeamMember.id, { replyTo: activeReplyContext, clientMsgId: tempId });

      keyboardMediaBlobRef.current.delete(tempId);
      if (stagedUri) {
        void removeOutboxMedia(stagedUri);
      }
      void PendingMessageStorage.removePendingMediaMessage(tempId);
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) {
          next.set(tempId, { ...cur, status: 'sent', serverMessageId, progress: 100 });
        }
        return next;
      });

      if (activeReplyContext) {
        setReplyingToMessage((current) =>
          current && current.messageId === activeReplyContext.messageId ? null : current
        );
      }

      if (isAtBottomRef.current) {
        scheduleScrollToBottom();
      } else {
        setShowScrollToBottomSafely(true);
        incrementUnseenCount();
      }
    } catch (error) {
      // Keep the stashed Blob so a manual/auto retry can re-upload it. Mark the
      // bubble 'failed' so the user can tap to retry (same affordance as picker
      // media / attachments).
      setPendingMedia(prev => {
        const cur = prev.get(tempId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(tempId, { ...cur, status: 'failed', progress: 0 });
        return next;
      });

      if (error instanceof ChatRateLimitError) {
        const waitSeconds = Math.max(1, Math.ceil(Math.max(0, error.retryAfterMs || 0) / 1000));
        Toast.show({
          type: 'error',
          text1: 'Too Many Messages',
          text2: `Please wait ${waitSeconds}s before sending another ${kind}.`,
          position: 'top',
        });
      } else {
        logger.error('Error sending keyboard media:', error);
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: `Couldn't send that ${kind}. Tap it below to retry.`,
          position: 'top',
        });
      }
    }
  };
  // Keep the ref pointing at the latest closure so the stable handleKeyboardMedia
  // callback (declared earlier) always invokes the current send logic.
  useEffect(() => {
    sendKeyboardMediaAsStickerRef.current = sendKeyboardMediaAsSticker;
  });

  // Check if a file URL is accessible (for web platform)
  const checkFileAvailability = async (fileUrl: string) => {
    if (Platform.OS !== 'web') return 'ok';
    return FileDownloadUtil.checkFileAvailability(fileUrl, { timeoutMs: 5000 });
  };

  // Validate file URLs when messages change (optimized to reduce console spam)
  useEffect(() => {
    if (!(Platform.OS === 'web' && messages.length > 0 && selectedTeamMember && effectiveUser?.email)) {
      return;
    }

    let cancelled = false;

    const validateFiles = async () => {
      const now = Date.now();
      const MIN_VALIDATION_INTERVAL_MS = 12_000;
      if (fileValidationInFlightRef.current) {
        return;
      }
      if (now - fileValidationLastRunAtRef.current < MIN_VALIDATION_INTERVAL_MS) {
        return;
      }

      fileValidationInFlightRef.current = true;
      try {
        // Validate only the most recent slice to avoid scanning entire histories repeatedly.
        const recentConversationMessages = displayedMessagesRef.current.slice(-120);

        const fileUrls = recentConversationMessages
          .flatMap((msg) => {
            if (!Array.isArray(msg.attachments)) {
              return [];
            }
            return msg.attachments
              .map((att: any) => {
                if (!att || typeof att.url !== 'string' || att.url.length === 0) {
                  return undefined;
                }
                // For video attachments that have a transcoded H.264 copy (or whose
                // url was already replaced by the backend), the original H.265 file
                // has been deleted from Firebase Storage. Validating att.url would
                // issue a HEAD request that returns 403. Skip these — the video
                // plays via its transcoded copy and the VideoPlayer surfaces its own
                // errors. Videos without a transcoded copy are still validated.
                if (isVideoFile(att.fileType, att.fileName)) {
                  const hasTranscoded =
                    typeof att.transcodedUrl === 'string' && att.transcodedUrl.trim().length > 0;
                  if (hasTranscoded || att.originalReplaced === true) {
                    return undefined;
                  }
                }
                return att.url as string;
              })
              .filter(
                (url: any): url is string =>
                  typeof url === 'string' &&
                  url.length > 0 &&
                  !brokenFileUrlsRef.current.has(url)
              );
          })
          .filter((url) => {
            // Skip validation if checked within last 5 minutes
            const lastChecked = fileValidationCache.get(url);
            if (lastChecked && now - lastChecked < 300000) return false;
            return true;
          })
          .filter((url, index, self) => self.indexOf(url) === index) // Remove duplicates
          .slice(0, 18);

        if (fileUrls.length === 0 || cancelled) {
          return;
        }

        // Process in smaller batches to avoid overwhelming the network
        const batchSize = 3;
        const brokenUrls: string[] = [];

        for (let i = 0; i < fileUrls.length; i += batchSize) {
          if (cancelled) {
            return;
          }

          const batch = fileUrls.slice(i, i + batchSize);

          const results = await Promise.allSettled(
            batch.map(async (url) => {
              const availability = await checkFileAvailability(url);
              if (availability !== 'unknown') {
                fileValidationCache.set(url, now); // Cache ok/missing checks
              }
              return { url, availability };
            })
          );

          if (cancelled) {
            return;
          }

          results.forEach((result) => {
            if (result.status !== 'fulfilled') return;
            if (result.value.availability === 'missing') {
              brokenUrls.push(result.value.url);
              return;
            }
            if (result.value.availability === 'ok') {
              clearNetworkError(result.value.url);
            }
          });

          // Small delay between batches to be nice to the server
          if (i + batchSize < fileUrls.length) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }

        if (!cancelled && brokenUrls.length > 0) {
          setBrokenFileUrls((prev) => new Set([...prev, ...brokenUrls]));
        }

        fileValidationLastRunAtRef.current = Date.now();
      } finally {
        fileValidationInFlightRef.current = false;
      }
    };

    // Debounce the validation to avoid too many requests
    const timeout = setTimeout(() => {
      void validateFiles();
    }, 2000);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [messages, selectedTeamMember?.email, effectiveUser?.email, clearNetworkError, fileValidationCache]);

  const removeSelectedFile = useCallback((index: number) => {
    const removedFile = selectedFiles[index];
    if (removedFile) {
      revokeWebObjectUrls([removedFile]);
    }
    const newFiles = selectedFiles.filter((_, i) => i !== index);
    setSelectedFiles(newFiles);
    selectedFilesRef.current = newFiles;
    if (newFiles.length === 0) {
      resetFilePreviewModal();
    }
  }, [selectedFiles, revokeWebObjectUrls, resetFilePreviewModal]);

  const removeSelectedFileRef = useRef(removeSelectedFile);
  useEffect(() => {
    removeSelectedFileRef.current = removeSelectedFile;
  }, [removeSelectedFile]);

  const removeSelectedFilePressHandlersRef = useRef<Map<number, () => void>>(new Map());
  const getRemoveSelectedFilePressHandler = useCallback((index: number) => {
    return resolveMapCacheEntry(removeSelectedFilePressHandlersRef.current, index, () => {
      return () => {
        removeSelectedFileRef.current(index);
      };
    });
  }, []);

  useEffect(() => {
    pruneMapByNumericRange(removeSelectedFilePressHandlersRef.current, selectedFiles.length);
  }, [selectedFiles.length]);

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  // AnimatedMessageWrapper – now imported from @/components/chat/AnimatedMessageWrapper
  // MessageRow – now imported from @/components/chat/MessageRow

  // ── Stable wrappers for functions that are not useCallback (needed for ChatContext) ──
  const handleMessageLongPressRef = useRef(handleMessageLongPress);
  useEffect(() => { handleMessageLongPressRef.current = handleMessageLongPress; });
  const stableHandleMessageLongPress = useCallback(
    (messageId: string, event: any) => handleMessageLongPressRef.current(messageId, event),
    []
  );

  const handleImageErrorRef = useRef(handleImageError);
  useEffect(() => { handleImageErrorRef.current = handleImageError; });
  const stableHandleImageError = useCallback(
    (url: string) => handleImageErrorRef.current(url),
    []
  );

  const noopPressHandler = useCallback(() => {}, []);
  const focusConversationSearchMatchRef = useRef(focusConversationSearchMatch);
  useEffect(() => {
    focusConversationSearchMatchRef.current = focusConversationSearchMatch;
  }, [focusConversationSearchMatch]);

  const conversationSearchJumpHandlersRef = useRef<Map<number, () => void>>(new Map());
  const getConversationSearchJumpHandler = useCallback((matchIndex: number) => {
    if (!Number.isInteger(matchIndex) || matchIndex < 0) {
      return noopPressHandler;
    }

    return resolveMapCacheEntry(conversationSearchJumpHandlersRef.current, matchIndex, () => {
      return () => {
        void focusConversationSearchMatchRef.current(matchIndex, { animated: true });
      };
    });
  }, [noopPressHandler]);

  useEffect(() => {
    pruneMapByNumericRange(
      conversationSearchJumpHandlersRef.current,
      conversationSearchMatchIds.length
    );
  }, [conversationSearchMatchIds.length]);

  const messageDateLabelByIdRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    messageDateLabelByIdRef.current = messageRowMetaById.dateLabelById;
  }, [messageRowMetaById]);

  const messageLayoutHandlersRef = useRef<Map<string, (event: any) => void>>(new Map());
  const getMessageLayoutHandler = useCallback((messageId: string) => {
    return resolveMapCacheEntry(messageLayoutHandlersRef.current, messageId, () => {
      return (event: any) => {
        const y = event?.nativeEvent?.layout?.y;
        const height = event?.nativeEvent?.layout?.height;
        if (typeof y !== 'number' || typeof height !== 'number') {
          return;
        }

        const currentDate = messageDateLabelByIdRef.current.get(messageId) || '';
        const newPosition = { y, height, date: currentDate };
        const existing = messagePositionsRef.current[messageId];

        if (
          existing &&
          existing.y === newPosition.y &&
          existing.height === newPosition.height &&
          existing.date === newPosition.date
        ) {
          return;
        }

        messagePositionsRef.current[messageId] = newPosition;
      };
    });
  }, []);

  const displayedMessageIdSet = useMemo(() => {
    return resolveChatDisplayedMessageIdSet(displayedMessages, (message: any) => {
      return normalizeMessageId(message?.id);
    });
  }, [displayedMessages, normalizeMessageId]);

  useEffect(() => {
    pruneMapByKeySet(messageLayoutHandlersRef.current, displayedMessageIdSet);
  }, [displayedMessageIdSet]);

  const handleReactionRef = useRef(handleReaction);
  useEffect(() => {
    handleReactionRef.current = handleReaction;
  }, [handleReaction]);
  const handleQuickReactionRef = useRef(handleQuickReaction);
  useEffect(() => {
    handleQuickReactionRef.current = handleQuickReaction;
  }, [handleQuickReaction]);

  const reactionPressHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getReactionPressHandler = useCallback((messageId: unknown, reactionType: string) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId || !reactionType) {
      return noopPressHandler;
    }

    const cacheKey = `${normalizedMessageId}::${reactionType}`;
    return resolveMapCacheEntry(reactionPressHandlersRef.current, cacheKey, () => {
      return () => {
        void handleReactionRef.current(normalizedMessageId, reactionType);
      };
    });
  }, [normalizeMessageId, noopPressHandler]);

  useEffect(() => {
    pruneDelimitedMapByPrefixSet(reactionPressHandlersRef.current, displayedMessageIdSet, '::');
  }, [displayedMessageIdSet]);

  const lastTapByMessageIdRef = useRef<Map<string, number>>(new Map());
  const quickTapReactionHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getQuickTapReactionHandler = useCallback((messageId: unknown) => {
    const normalizedMessageId = normalizeMessageId(messageId);
    if (!normalizedMessageId) {
      return noopPressHandler;
    }

    return resolveMapCacheEntry(quickTapReactionHandlersRef.current, normalizedMessageId, () => {
      return () => {
        const now = Date.now();
        const lastTap = lastTapByMessageIdRef.current.get(normalizedMessageId) || 0;
        const isDoubleTap = now - lastTap < 300;
        lastTapByMessageIdRef.current.set(normalizedMessageId, isDoubleTap ? 0 : now);
        if (isDoubleTap) {
          void handleQuickReactionRef.current(normalizedMessageId);
        }
      };
    });
  }, [normalizeMessageId, noopPressHandler]);

  useEffect(() => {
    pruneMapByKeySet(quickTapReactionHandlersRef.current, displayedMessageIdSet);
    pruneMapByKeySet(lastTapByMessageIdRef.current, displayedMessageIdSet);
  }, [displayedMessageIdSet]);

  const handleImageViewRef = useRef(handleImageView);
  useEffect(() => {
    handleImageViewRef.current = handleImageView;
  }, [handleImageView]);

  const handleDownloadFileRef = useRef(handleDownloadFile);
  useEffect(() => {
    handleDownloadFileRef.current = handleDownloadFile;
  }, [handleDownloadFile]);

  const attachmentImagePressHandlersRef = useRef<Map<string, () => void>>(new Map());
  const attachmentDownloadPressHandlersRef = useRef<Map<string, () => void>>(new Map());

  const getAttachmentPressKey = useCallback((attachment: HydratedAttachment) => {
    const url = String(attachment?.url || '');
    const resolvedUrl = String(attachment?.resolvedUrl || '');
    const fileName = String(attachment?.fileName || '');
    return `${url}::${resolvedUrl}::${fileName}`;
  }, []);

  const getAttachmentImageViewPressHandler = useCallback((attachment: HydratedAttachment) => {
    const cacheKey = getAttachmentPressKey(attachment);
    return resolveMapCacheEntry(attachmentImagePressHandlersRef.current, cacheKey, () => {
      return () => {
        void handleImageViewRef.current(
          attachment.resolvedUrl || attachment.url,
          attachment.url,
          attachment.fileName
        );
      };
    });
  }, [getAttachmentPressKey]);

  const getAttachmentDownloadPressHandler = useCallback((
    attachment: HydratedAttachment,
    fallbackFileName?: string
  ) => {
    const downloadName = fallbackFileName || attachment.fileName || 'File';
    const baseKey = getAttachmentPressKey(attachment);
    const cacheKey = `${baseKey}::download::${downloadName}`;
    return resolveMapCacheEntry(attachmentDownloadPressHandlersRef.current, cacheKey, () => {
      return () => {
        // Prefer the transcoded H.264 URL for download; the original H.265 may have
        // been deleted from Storage after transcoding (originalDeleted: true).
        const downloadUrl = (attachment as any).transcodedUrl || attachment.url;
        void handleDownloadFileRef.current(
          downloadUrl,
          downloadName,
          attachment.resolvedUrl
        );
      };
    });
  }, [getAttachmentPressKey]);

  useEffect(() => {
    const activeAttachmentBaseKeys = resolveChatAttachmentBaseKeySet(
      displayedMessages.flatMap((message: any) => (Array.isArray(message?.attachments) ? message.attachments : [])),
      (attachment: HydratedAttachment) => {
        if (!attachment?.url) {
          return '';
        }
        return getAttachmentPressKey(attachment);
      }
    );

    pruneMapByKeySet(attachmentImagePressHandlersRef.current, activeAttachmentBaseKeys);
    pruneDelimitedMapByPrefixSet(
      attachmentDownloadPressHandlersRef.current,
      activeAttachmentBaseKeys,
      '::download::'
    );
  }, [displayedMessages, getAttachmentPressKey]);

  // ── ChatContext wiring ────────────────────────────────────────────────────────
  // The stable value includes all callbacks and utilities. Memoized so it only
  // changes when a callback identity changes (very infrequent).
  // The reactive value includes per-render state (theme, flags, user, assets).
  // ─────────────────────────────────────────────────────────────────────────────

  const chatStableContextValue: ChatStableContextValue = useMemo(() => ({
    normalizeMessageId,
    getReactionPressHandler,
    getQuickTapReactionHandler,
    getAttachmentImageViewPressHandler,
    getAttachmentDownloadPressHandler,
    getDownloadKey,
    handleMessageLongPress: stableHandleMessageLongPress,
    handleImageError: stableHandleImageError,
    jumpToReplyMessage,
    isMessageActionPending,
    getMessageReactionSummary,
    formatMessageTimestamp,
    sanitizeMessageText,
    sanitizeAttachmentFileName,
    resolveChatReplyPreviewText,
    resolveChatReplySenderLabel,
    resolveNativeSafeStickerUrl,
    resolveOptimizedGifUrl,
    isImageFile,
    isVideoFile,
    normalizeParticipantEmail,
    getProfilePictureURL,
    getSafeDisplayInitial,
    logger,
    styles,
    CHAT_REPLY_PREVIEW_MAX_CHARS,
  }), [
    normalizeMessageId,
    getReactionPressHandler,
    getQuickTapReactionHandler,
    getAttachmentImageViewPressHandler,
    getAttachmentDownloadPressHandler,
    getDownloadKey,
    stableHandleMessageLongPress,
    stableHandleImageError,
    jumpToReplyMessage,
    isMessageActionPending,
    getMessageReactionSummary,
    resolveNativeSafeStickerUrl,
    resolveOptimizedGifUrl,
    // Module-level imports never change identity — omitted from deps intentionally
  ]);

  const renderMessageItem = useCallback(
    ({ item }: { item: any; index: number }) => {
      const itemId = normalizeMessageId(item?.id);

      // ── Read volatile state from refs (Phase 4 stabilization) ──
      const metaById = messageRowMetaByIdRef.current;
      const dateSeparatorLabel = itemId
        ? (metaById?.separatorLabelById?.get(itemId) ?? '')
        : '';

      const searchVisible = conversationSearchVisibleRef.current;
      const hasSearchQuery = normalizedConversationSearchQueryRef.current.length > 0;
      const showConversationSearchResultTimeline = searchVisible && hasSearchQuery;

      const matchIdSet = conversationSearchMatchIdSetRef.current;
      const matchIndexById = conversationSearchMatchIndexByIdRef.current;
      const highlightId = conversationSearchHighlightMessageIdRef.current;

      const isConversationSearchResultMatch = Boolean(
        showConversationSearchResultTimeline &&
        itemId &&
        matchIdSet.has(itemId)
      );
      const conversationSearchMatchIndex = itemId
        ? (matchIndexById.get(itemId) ?? -1)
        : -1;
      const isConversationSearchResultActive =
        isConversationSearchResultMatch &&
        Boolean(itemId && highlightId === itemId);

      const unreadSepId = unreadSeparatorMessageIdRef.current;
      const shouldShowUnreadSeparator = Boolean(
        showUnreadSeparatorRef.current && unreadSepId && itemId && unreadSepId === itemId
      );
      const shouldShowNewDivider = Boolean(
        showNewDividerRef.current && newDividerMessageIdRef.current && itemId && newDividerMessageIdRef.current === itemId && !shouldShowUnreadSeparator
      );
      const currentUnreadDividerLabel = unreadDividerLabelRef.current;
      const searchMatchCount = conversationSearchMatchIdsRef.current.length;

      return (
        <View style={styles.messageListItemWithGutter}>
          {showConversationSearchResultTimeline ? (
            <View style={styles.conversationSearchResultGutter}>
              <View
                style={[
                  styles.conversationSearchResultGutterRail,
                  {
                    backgroundColor: isDarkMode
                      ? 'rgba(148, 163, 184, 0.34)'
                      : 'rgba(148, 163, 184, 0.4)',
                  },
                ]}
              />
              {isConversationSearchResultMatch ? (
                <TouchableOpacity
                  style={[
                    styles.conversationSearchResultMarkerButton,
                    isConversationSearchResultActive
                      ? themedStyles.searchMarkerActive
                      : themedStyles.searchMarkerInactive,
                  ]}
                  onPress={getConversationSearchJumpHandler(conversationSearchMatchIndex)}
                  accessibilityRole="button"
                  accessibilityLabel={`Jump to search result ${conversationSearchMatchIndex + 1} of ${searchMatchCount}`}
                >
                  <View
                    style={[
                      styles.conversationSearchResultMarkerDot,
                      isConversationSearchResultActive
                        ? themedStyles.searchDotActive
                        : themedStyles.searchDotInactive,
                    ]}
                  />
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}

          <View
            style={styles.messageListItemContent}
            onLayout={
              shouldUseManualAnchorPreservation && itemId
                ? getMessageLayoutHandler(itemId)
                : undefined
            }
          >
            {dateSeparatorLabel.length > 0 && (
              <View style={styles.dateSeparatorContainer}>
                <View style={[styles.dateSeparatorLine, themedStyles.dateSepLine]} />
                <Text style={[styles.dateSeparatorText, themedStyles.dateSepText]}> 
                  {dateSeparatorLabel}
                </Text>
                <View style={[styles.dateSeparatorLine, themedStyles.dateSepLine]} />
              </View>
            )}

            {shouldShowUnreadSeparator && unreadSepId && (
              <AnimatedChatDivider
                animationKey={`unread-${unreadSepId}`}
                animatedKeys={animatedDividerKeysRef}
              >
                <View style={styles.dateSeparatorContainer}>
                  <View style={[styles.dateSeparatorLine, themedStyles.unreadSepLine]} />
                  <Text style={[styles.dateSeparatorText, themedStyles.unreadSepText]}> 
                    {currentUnreadDividerLabel}
                  </Text>
                  <View style={[styles.dateSeparatorLine, themedStyles.unreadSepLine]} />
                </View>
              </AnimatedChatDivider>
            )}

            {shouldShowNewDivider && (
              <AnimatedChatDivider
                animationKey={`new-${itemId}`}
                animatedKeys={animatedDividerKeysRef}
              >
                <View style={styles.dateSeparatorContainer}>
                  <View style={[styles.dateSeparatorLine, themedStyles.newDividerLine]} />
                  <Text style={[styles.dateSeparatorText, themedStyles.newDividerText]}> 
                    New messages
                  </Text>
                  <View style={[styles.dateSeparatorLine, themedStyles.newDividerLine]} />
                </View>
              </AnimatedChatDivider>
            )}

            <MessageRow item={item} />
          </View>
        </View>
      );
    },
    [
      // ── Only stable / infrequently-changing deps remain ──
      getConversationSearchJumpHandler,
      getMessageLayoutHandler,
      isDarkMode,
      shouldUseManualAnchorPreservation,
      normalizeMessageId,
      themedStyles,
    ]
  );

  // ── Pending-footer re-render signal ───────────────────────────────────────
  //    The optimistic pending bubbles live in the FlashList footer, which is
  //    served through a stable ref callback. FlashList only re-renders that
  //    footer when `data` or `extraData` change. Pending state is NOT part of
  //    `data`, so we derive a compact signature of all pending text/media/
  //    attachment entries (plus the typing indicator) and feed it into
  //    `extraData` below. Without this, a sender's own message would not paint
  //    until the server echo later mutated `data` — the exact sender-side
  //    delay we are fixing. The signature only changes on meaningful pending
  //    transitions, so it does not cause needless re-renders. ──
  const pendingFooterSignature = useMemo(
    () =>
      resolveChatPendingFooterSignature({
        selectedRecipientId: selectedTeamMember?.id,
        pendingMessages,
        pendingMedia,
        pendingAttachments,
        isTyping,
        resolvePendingMessageStatus,
      }),
    [
      selectedTeamMember?.id,
      pendingMessages,
      pendingMedia,
      pendingAttachments,
      isTyping,
      resolvePendingMessageStatus,
    ]
  );

  // ── FlashList extraData: tells FlashList to re-call renderItem for visible
  //    rows when volatile decorator state changes (search, dividers, unread).
  //    renderMessageItem reads from refs, so its identity stays stable, but
  //    FlashList needs this signal to know *which renders* to trigger. ──
  const listExtraData = useMemo(
    () => ({
      searchHighlight: conversationSearchHighlightMessageId,
      searchVisible: conversationSearchVisible,
      searchQuery: normalizedConversationSearchQuery.length,
      matchCount: conversationSearchMatchIds.length,
      showUnread: showUnreadSeparator,
      unreadId: unreadSeparatorMessageId,
      unreadLabel: unreadDividerLabel,
      showNew: showNewDivider,
      newDividerId: newDividerMessageId,
      metaVersion: messageRowMetaById,
      pendingFooter: pendingFooterSignature,
    }),
    [
      conversationSearchHighlightMessageId,
      conversationSearchVisible,
      normalizedConversationSearchQuery.length,
      conversationSearchMatchIds.length,
      showUnreadSeparator,
      unreadSeparatorMessageId,
      unreadDividerLabel,
      showNewDivider,
      newDividerMessageId,
      messageRowMetaById,
      pendingFooterSignature,
    ]
  );

  // Retry a failed pending media item (re-uploads if needed and re-sends)
  const retryPendingMedia = useCallback(async (tempId: string, options?: { silent?: boolean }): Promise<boolean> => {
    if (isOffline) {
      if (!options?.silent) {
        Toast.show({ type: 'info', text1: 'Offline', text2: 'Reconnect to retry media.', position: 'top' });
      }
      return false;
    }

    const item = pendingMedia.get(tempId);
    // Recipient-agnostic: drive by the item's own recipient so the app-wide
    // resume pass can heal queued media in ANY conversation, not just the open
    // one. For the selected conversation item.recipientId === selectedTeamMember.id,
    // so behavior there is unchanged.
    if (!item || !item.recipientId) return false;
    // Guard against double-dispatch: manual "Retry all" and the
    // auto-retry-on-reconnect effect share this function, so a concurrent
    // call for the same item must be a no-op rather than firing a second
    // network request.
    if (item.status === 'sending' || item.status === 'sent') return false;
    try {
      // Mark as sending
      setPendingMedia(prev => {
        const next = new Map(prev);
        const cur = next.get(tempId);
        if (cur) next.set(tempId, { ...cur, status: 'sending' });
        return next;
      });

      const uri = item.previewUri;
      const isHttp = /^https?:\/\//i.test(uri);
      const guessedExt = (item.mime && item.mime.split('/')[1]) || (uri.split('?')[0].split('#')[0].split('.').pop() || 'bin');
      let finalUrl = uri;
      if (!isHttp) {
        // Guard against a vanished local source. A staged outbox file can be gone
        // by retry time (cache/dir wiped, or a copy that never actually landed);
        // uploading it throws the "Directory doesn't exist" IOException, and because
        // this same function powers the auto-retry-on-reconnect pass it would loop
        // forever. Bail to 'failed' (a failed item is NOT auto-retried) so the loop
        // stops and the user can resend. Skipped when a web Blob is stashed (that's
        // the real source on web) or for non-file:// uris the uploader can resolve.
        if (!keyboardMediaBlobRef.current.get(tempId)) {
          const sourceExists = await localMediaExists(uri);
          if (!sourceExists) {
            logger.warn('[chat] retryPendingMedia: local source missing, marking failed', { tempId, uri });
            setPendingMedia(prev => {
              const cur = prev.get(tempId);
              if (!cur) return prev;
              const next = new Map(prev);
              next.set(tempId, { ...cur, status: 'failed', progress: 0 });
              return next;
            });
            if (!options?.silent) {
              Toast.show({
                type: 'error',
                text1: 'Media Unavailable',
                text2: 'This file is no longer available. Please resend it.',
                position: 'top',
              });
            }
            return false;
          }
        }
        const name = `${item.source === 'keyboard' ? 'kb' : 'pick'}_${Date.now()}.${guessedExt}`;
        const uploadMime = item.mime || (item.kind === 'gif' ? 'image/gif' : 'image/png');
        const { url } = await chatService.uploadFile(
          uri,
          name,
          uploadMime,
          {
            senderEmail: item.sender || effectiveUser?.email,
            recipientEmail: item.recipientId,
          },
          (progress) => {
            setPendingMedia(prev => {
              const next = new Map(prev);
              const cur = next.get(tempId);
              if (cur && cur.status === 'sending') {
                next.set(tempId, { ...cur, progress });
              }
              return next;
            });
          },
          undefined,
          keyboardMediaBlobRef.current.get(tempId),
        );
        finalUrl = url;
      }

      // Warm local cache immediately for newly uploaded media to avoid a re-download during reconciliation.
      void chatCacheService.getMediaForDownload(finalUrl, item.nameOrTitle || undefined, undefined, 'low').catch(() => undefined);

      if (item.kind === 'gif') {
        const serverMessageId = await sendGif(
          { url: finalUrl, source: item.source || 'keyboard' } as any,
          item.recipientId,
          { replyTo: item.replyTo, clientMsgId: tempId }
        );
        setPendingMedia(prev => {
          const next = new Map(prev);
          const cur = next.get(tempId);
          if (cur) {
            next.set(tempId, {
              ...cur,
              status: 'sent',
              serverMessageId,
              progress: 100,
            });
          }
          return next;
        });
      } else {
        const serverMessageId = await sendSticker(
          { url: finalUrl, name: item.nameOrTitle || 'Sticker', pack: 'keyboard' } as any,
          item.recipientId,
          { replyTo: item.replyTo, clientMsgId: tempId }
        );
        setPendingMedia(prev => {
          const next = new Map(prev);
          const cur = next.get(tempId);
          if (cur) {
            next.set(tempId, {
              ...cur,
              status: 'sent',
              serverMessageId,
              progress: 100,
            });
          }
          return next;
        });
      }
      keyboardMediaBlobRef.current.delete(tempId);
      void removeOutboxMedia(item.previewUri);
      void PendingMessageStorage.removePendingMediaMessage(tempId);
      return true;
    } catch (err) {
      logger.error('Retry send failed:', err);
      // Guard against resurrecting an item that was removed in the meantime
      // (e.g. via "Cancel all") while this retry was in flight.
      setPendingMedia(prev => {
        const cur = prev.get(tempId);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(tempId, { ...cur, status: 'failed' });
        return next;
      });
      if (!options?.silent) {
        Toast.show({ type: 'error', text1: 'Retry Failed', text2: 'Could not resend media', position: 'top' });
      }
      return false;
    }
  }, [isOffline, pendingMedia, selectedTeamMember, sendGif, sendSticker]);

  const retryPendingAttachment = useCallback(
    async (tempId: string, options?: { silent?: boolean }): Promise<boolean> => {
      if (isOffline) {
        if (!options?.silent) {
          Toast.show({ type: 'info', text1: 'Offline', text2: 'Reconnect to retry attachments.', position: 'top' });
        }
        return false;
      }

      const entry = pendingAttachments.get(tempId);
      // Recipient-agnostic (drive any conversation's queued attachment, not just
      // the selected one). The upload + send already use entry.recipientId.
      if (!entry || !entry.recipientId) {
        return false;
      }

      // Guard against double-dispatch: manual "Retry all" and the
      // auto-retry-on-reconnect effect share this function, so a concurrent
      // call for the same item must be a no-op rather than firing a second
      // upload.
      if (entry.status === 'sending' || entry.status === 'finalizing' || entry.status === 'sent') {
        return false;
      }

      clearAttachmentFinalizeTimer(tempId);

      attachmentUploadCancelMap.current.delete(tempId);

      setPendingAttachments((prev) => {
        const next = new Map(prev);
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            status: 'sending',
            progress: 0,
            cancelable: false,
            cancelRequested: false,
            failureReason: undefined,
          });
        }
        return next;
      });

      try {
        const serverMessageId = await sendMessageWithFiles(
          entry.messageText,
          entry.files,
          entry.recipientId,
          (progress) => {
            setPendingAttachments((prev) => {
              const next = new Map(prev);
              const current = next.get(tempId);
              if (current && current.status === 'sending') {
                next.set(tempId, { ...current, progress });
              }
              return next;
            });
          },
          {
            registerCancel: (cancelFn) => {
              attachmentUploadCancelMap.current.set(tempId, cancelFn);
              setPendingAttachments((prev) => {
                const next = new Map(prev);
                const current = next.get(tempId);
                if (current) {
                  next.set(tempId, { ...current, cancelable: true, cancelRequested: false });
                }
                return next;
              });
            },
            replyTo: entry.replyTo,
            clientMsgId: tempId,
          }
        );

        setPendingAttachments((prev) => {
          const next = new Map(prev);
          const current = next.get(tempId);
          if (current) {
            next.set(tempId, {
              ...current,
              status: 'finalizing',
              progress: 100,
              cancelable: false,
              cancelRequested: false,
              serverMessageId,
            });
          }
          return next;
        });

        scheduleAttachmentFinalizeCleanup(tempId);
        attachmentUploadCancelMap.current.delete(tempId);
        // Server has the files now — drop the staged copies (no-op for non-staged).
        entry.files.forEach((f) => {
          if (f?.uri) {
            void removeOutboxMedia(f.uri);
          }
        });

        if (!options?.silent) {
          Toast.show({ type: 'success', text1: 'Files Sent', text2: 'Attachment message delivered.', position: 'top' });
        }
        return true;
      } catch (error) {
        clearAttachmentFinalizeTimer(tempId);
        attachmentUploadCancelMap.current.delete(tempId);
        const localSourceUnavailable =
          error instanceof Error && error.message === 'local_file_reference_unavailable';
        if (error instanceof ChatUploadCanceledError) {
          logger.info('Attachment upload retry canceled by user', { tempId });
        } else {
          logger.error('Retry attachment send failed:', error);
        }
        // Guard against resurrecting an item that was removed in the meantime
        // (e.g. via "Cancel all") while this retry was in flight.
        setPendingAttachments((prev) => {
          const current = prev.get(tempId);
          if (!current) return prev;
          const next = new Map(prev);
          next.set(tempId, {
            ...current,
            status: 'failed',
            cancelable: false,
            cancelRequested: false,
            failureReason: error instanceof ChatUploadCanceledError ? 'canceled' : 'error',
          });
          return next;
        });
        if (error instanceof ChatUploadCanceledError) {
          if (!options?.silent) {
            Toast.show({ type: 'info', text1: 'Upload Canceled', text2: 'Attachment upload was canceled.', position: 'top' });
          }
        } else {
          if (!options?.silent) {
            Toast.show({
              type: 'error',
              text1: 'Retry Failed',
              text2: localSourceUnavailable
                ? 'Original file is no longer available. Please attach it again.'
                : 'Could not resend attachments.',
              position: 'top'
            });
          }
        }
        return false;
      } finally {
        clearAttachmentFinalizeTimer(tempId);
        attachmentUploadCancelMap.current.delete(tempId);
      }
    },
    [clearAttachmentFinalizeTimer, isOffline, pendingAttachments, scheduleAttachmentFinalizeCleanup, selectedTeamMember, sendMessageWithFiles]
  );

  const cancelPendingAttachment = useCallback(async (tempId: string) => {
    const cancelFn = attachmentUploadCancelMap.current.get(tempId);
    if (!cancelFn) {
      return;
    }

    attachmentUploadCancelMap.current.delete(tempId);
    setPendingAttachments((prev) => {
      const next = new Map(prev);
      const current = next.get(tempId);
      if (current && current.status === 'sending') {
        next.set(tempId, {
          ...current,
          cancelRequested: true,
          cancelable: false,
        });
      }
      return next;
    });

    try {
      await cancelFn();
    } catch (error) {
      logger.warn('Cancel pending attachment failed', error);
    }
  }, []);

  const retryPendingMediaRef = useRef(retryPendingMedia);
  useEffect(() => {
    retryPendingMediaRef.current = retryPendingMedia;
  }, [retryPendingMedia]);

  const retryPendingMediaPressHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getRetryPendingMediaPressHandler = useCallback((tempId: string) => {
    return resolveMapCacheEntry(retryPendingMediaPressHandlersRef.current, tempId, () => {
      return () => {
        void retryPendingMediaRef.current(tempId);
      };
    });
  }, []);

  useEffect(() => {
    const activeIds = resolveChatPendingActiveIdSet(pendingMedia.keys());
    pruneMapByKeySet(retryPendingMediaPressHandlersRef.current, activeIds);
  }, [pendingMedia]);

  const retryPendingAttachmentRef = useRef(retryPendingAttachment);
  useEffect(() => {
    retryPendingAttachmentRef.current = retryPendingAttachment;
  }, [retryPendingAttachment]);

  // Device-wide resume for media/attachments: the per-conversation auto-retry
  // (retryAllQueuedPendingSends) only heals the OPEN conversation, so a sticker/
  // GIF/attachment queued in a DIFFERENT conversation (e.g. restored from the
  // durable outbox after an app kill) would otherwise wait until that
  // conversation is reopened. This pass drives every OTHER conversation's queued
  // items whenever the app is online (and re-runs on reconnect / after
  // hydration). The open conversation stays owned by the per-conversation retry,
  // so the two never drive the same item; re-drives are idempotent (clientMsgId)
  // regardless. Debounced so it settles after hydration and doesn't fire on every
  // upload-progress tick.
  useEffect(() => {
    if (isOffline) {
      return;
    }
    const selectedId = selectedTeamMember?.id;
    const timer = setTimeout(() => {
      pendingMedia.forEach((item) => {
        if (item.status === 'queued' && item.recipientId && item.recipientId !== selectedId) {
          void retryPendingMediaRef.current(item.id, { silent: true });
        }
      });
      pendingAttachments.forEach((item) => {
        if (item.status === 'queued' && item.recipientId && item.recipientId !== selectedId) {
          void retryPendingAttachmentRef.current(item.id, { silent: true });
        }
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [isOffline, pendingMedia, pendingAttachments, selectedTeamMember?.id]);

  const cancelPendingAttachmentRef = useRef(cancelPendingAttachment);
  useEffect(() => {
    cancelPendingAttachmentRef.current = cancelPendingAttachment;
  }, [cancelPendingAttachment]);

  const retryPendingAttachmentPressHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getRetryPendingAttachmentPressHandler = useCallback((tempId: string) => {
    return resolveMapCacheEntry(retryPendingAttachmentPressHandlersRef.current, tempId, () => {
      return () => {
        void retryPendingAttachmentRef.current(tempId);
      };
    });
  }, []);

  const cancelPendingAttachmentPressHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getCancelPendingAttachmentPressHandler = useCallback((tempId: string) => {
    return resolveMapCacheEntry(cancelPendingAttachmentPressHandlersRef.current, tempId, () => {
      return () => {
        void cancelPendingAttachmentRef.current(tempId);
      };
    });
  }, []);

  useEffect(() => {
    const activeIds = resolveChatPendingActiveIdSet(pendingAttachments.keys());

    pruneMapByKeySet(retryPendingAttachmentPressHandlersRef.current, activeIds);
    pruneMapByKeySet(cancelPendingAttachmentPressHandlersRef.current, activeIds);
  }, [pendingAttachments]);

  const renderMessageInfoModal = () => {
    return (
      <Modal
        visible={messageInfoModalState.visible}
        transparent
        animationType="fade"
        onRequestClose={closeMessageInfoModal}
      >
        <Pressable style={styles.messageInfoModalOverlay} onPress={closeMessageInfoModal}>
          <Pressable
            style={[
              styles.messageInfoModalCard,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
            onPress={() => {}}
          >
            <View
              style={[
                styles.messageInfoModalHeader,
                { borderBottomColor: theme.border },
              ]}
            >
              <Text style={[styles.messageInfoModalTitle, { color: theme.text }]}>Message info</Text>
              <View style={styles.messageInfoModalHeaderActions}>
                <TouchableOpacity
                  style={[
                    styles.messageInfoCopyAllButton,
                    {
                      borderColor: messageInfoCopiedRowKey === '__all__' ? theme.primary : theme.border,
                      backgroundColor: messageInfoCopiedRowKey === '__all__'
                        ? isDarkMode
                          ? 'rgba(59, 130, 246, 0.22)'
                          : 'rgba(59, 130, 246, 0.12)'
                        : theme.background,
                    },
                  ]}
                  onPress={() => {
                    void handleMessageInfoCopyAll();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Copy all message details"
                >
                  {messageInfoCopiedRowKey === '__all__' ? (
                    <CheckCircle2 size={12} color={theme.primary} />
                  ) : (
                    <Copy size={12} color={theme.textSecondary} />
                  )}
                  <Text
                    style={[
                      styles.messageInfoCopyAllButtonText,
                      { color: messageInfoCopiedRowKey === '__all__' ? theme.primary : theme.textSecondary },
                    ]}
                  >
                    {messageInfoCopiedRowKey === '__all__' ? 'Copied' : 'Copy all'}
                  </Text>
                  {showKeyboardShortcuts ? (
                    <View
                      style={[
                        styles.messageInfoShortcutBadge,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.surface,
                        },
                      ]}
                    >
                      <Text style={[styles.messageInfoShortcutBadgeText, { color: theme.textSecondary }]}>
                        Alt+Shift+C
                      </Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
                <View style={styles.messageInfoCloseActionWrap}>
                  <TouchableOpacity
                    style={styles.messageInfoModalCloseButton}
                    onPress={closeMessageInfoModal}
                    accessibilityRole="button"
                    accessibilityLabel="Close message info"
                  >
                    <X size={18} color={theme.textSecondary} />
                  </TouchableOpacity>
                  {showKeyboardShortcuts ? (
                    <View
                      style={[
                        styles.messageInfoShortcutBadge,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.surface,
                        },
                      ]}
                    >
                      <Text style={[styles.messageInfoShortcutBadgeText, { color: theme.textSecondary }]}>
                        Esc
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </View>

            {showMessageInfoHint ? (
              <View
                style={[
                  styles.messageInfoHintRow,
                  {
                    backgroundColor: isDarkMode ? 'rgba(59, 130, 246, 0.14)' : 'rgba(59, 130, 246, 0.08)',
                    borderBottomColor: theme.border,
                  },
                ]}
              >
                <Text style={[styles.messageInfoHintText, { color: theme.textSecondary }]}>
                  Tip: Tap Copy to copy one row, or long-press a value.
                </Text>
              </View>
            ) : null}

            {messageInfoCopyFeedbackLabel ? (
              <View
                style={[
                  styles.messageInfoCopyFeedbackRow,
                  {
                    borderBottomColor: theme.border,
                    backgroundColor: isDarkMode ? 'rgba(16, 185, 129, 0.14)' : 'rgba(16, 185, 129, 0.08)',
                  },
                ]}
                accessible
                accessibilityLabel={messageInfoCopyFeedbackAccessibilityLabel}
              >
                <CheckCircle2 size={12} color={theme.primary} />
                <Text style={[styles.messageInfoCopyFeedbackText, { color: theme.primary }]}>
                  {messageInfoCopyFeedbackLabel}
                </Text>
                {messageInfoCopyFeedbackSourceLabel ? (
                  <View
                    style={[
                      styles.messageInfoCopyFeedbackSourceBadge,
                      {
                        borderColor: messageInfoCopyFeedbackSourcePalette?.borderColor || theme.border,
                        backgroundColor: messageInfoCopyFeedbackSourcePalette?.backgroundColor || theme.surface,
                      },
                    ]}
                    accessible
                    accessibilityLabel={messageInfoCopyFeedbackSourceAccessibilityLabel}
                  >
                    <Text
                      style={[
                        styles.messageInfoCopyFeedbackSourceText,
                        { color: messageInfoCopyFeedbackSourcePalette?.textColor || theme.textSecondary },
                      ]}
                    >
                      {messageInfoCopyFeedbackSourceBadgeText}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {Platform.OS === 'web' && messageInfoCopyToastNotice ? (
              <View
                style={[
                  styles.messageInfoToastNoticeRow,
                  {
                    borderBottomColor: theme.border,
                    backgroundColor: isDarkMode ? 'rgba(245, 158, 11, 0.16)' : 'rgba(245, 158, 11, 0.10)',
                  },
                ]}
                accessible
                accessibilityRole="alert"
                accessibilityLabel={messageInfoCopyToastNoticeAccessibilityLabel}
              >
                <AlertCircle size={11} color={theme.textSecondary} />
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.messageInfoToastNoticeText, { color: theme.textSecondary }]}
                >
                  {messageInfoCopyToastNotice}
                </Text>
              </View>
            ) : null}

            {messageInfoExpandableRowKeys.length > 0 ? (
              <View
                style={[
                  styles.messageInfoBulkActionsRow,
                  { borderBottomColor: theme.border },
                ]}
              >
                <TouchableOpacity
                  style={[
                    styles.messageInfoBulkToggleButton,
                    {
                      borderColor: theme.border,
                      backgroundColor: theme.background,
                    },
                  ]}
                  onPress={toggleAllMessageInfoDetailsExpanded}
                  accessibilityRole="button"
                  accessibilityLabel={
                    areAllMessageInfoDetailsExpanded
                      ? 'Hide all recipient details'
                      : 'Show all recipient details'
                  }
                  accessibilityState={{ expanded: areAllMessageInfoDetailsExpanded }}
                >
                  <ChevronDown
                    size={14}
                    color={theme.textSecondary}
                    style={areAllMessageInfoDetailsExpanded ? styles.rotate180 : null}
                  />
                  <Text style={[styles.messageInfoBulkToggleButtonText, { color: theme.textSecondary }]}>
                    {areAllMessageInfoDetailsExpanded
                      ? 'Hide all recipient details'
                      : 'Show all recipient details'}
                  </Text>
                  {showKeyboardShortcuts ? (
                    <View
                      style={[
                        styles.messageInfoShortcutBadge,
                        {
                          borderColor: theme.border,
                          backgroundColor: theme.surface,
                        },
                      ]}
                    >
                      <Text style={[styles.messageInfoShortcutBadgeText, { color: theme.textSecondary }]}>
                        Alt+Shift+D
                      </Text>
                    </View>
                  ) : null}
                </TouchableOpacity>
              </View>
            ) : null}

            {showKeyboardShortcuts ? (
              <View
                style={[
                  styles.messageInfoShortcutHintRow,
                  { borderBottomColor: theme.border },
                ]}
              >
                <Text style={[styles.messageInfoShortcutHintText, { color: theme.textSecondary }]}>
                  Shortcuts: Alt+Shift+C copy all, Alt+Shift+D toggle details, Esc close.
                </Text>
              </View>
            ) : null}

            <ScrollView
              style={styles.messageInfoModalBody}
              contentContainerStyle={styles.messageInfoModalBodyContent}
            >
              {messageInfoModalState.rows.length <= 0 ? (
                <Text style={[styles.messageInfoEmptyText, { color: theme.textSecondary }]}>
                  No message details available.
                </Text>
              ) : (
                messageInfoModalState.rows.map((row, index) => {
                  const rowKey = `${row.label}:${index}`;
                  const isCopied = messageInfoCopiedRowKey === rowKey;
                  const rowBadge = resolveMessageInfoRowBadge(row.label, row.value);
                  const valueParts = resolveMessageInfoRowValueParts(row.value);
                  const isExpandable = valueParts.details.length > 0;
                  const isExpanded = Boolean(messageInfoExpandedRows[rowKey]);
                  const displayedValue = isExpandable && !isExpanded ? valueParts.summary : row.value;

                  const badgeBackgroundColor =
                    rowBadge?.tone === 'success'
                      ? isDarkMode
                        ? 'rgba(52, 211, 153, 0.2)'
                        : 'rgba(16, 185, 129, 0.14)'
                      : rowBadge?.tone === 'warning'
                        ? isDarkMode
                          ? 'rgba(251, 191, 36, 0.2)'
                          : 'rgba(245, 158, 11, 0.14)'
                        : isDarkMode
                          ? 'rgba(148, 163, 184, 0.2)'
                          : 'rgba(148, 163, 184, 0.14)';
                  const badgeTextColor =
                    rowBadge?.tone === 'success'
                      ? isDarkMode
                        ? '#6ee7b7'
                        : '#047857'
                      : rowBadge?.tone === 'warning'
                        ? isDarkMode
                          ? '#fcd34d'
                          : '#b45309'
                        : theme.textSecondary;

                  return (
                    <View
                      key={rowKey}
                      style={[
                        styles.messageInfoRow,
                        {
                          borderBottomWidth:
                            index === messageInfoModalState.rows.length - 1 ? 0 : StyleSheet.hairlineWidth,
                          borderBottomColor: theme.border,
                        },
                      ]}
                    >
                      <View style={styles.messageInfoRowHeader}>
                        <Text style={[styles.messageInfoRowLabel, { color: theme.textSecondary }]}>
                          {row.label}
                        </Text>
                        <View style={styles.messageInfoRowHeaderRight}>
                          {rowBadge ? (
                            <View
                              style={[
                                styles.messageInfoRowBadge,
                                { backgroundColor: badgeBackgroundColor },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.messageInfoRowBadgeText,
                                  { color: badgeTextColor },
                                ]}
                              >
                                {rowBadge.text}
                              </Text>
                            </View>
                          ) : null}
                          <TouchableOpacity
                            style={[
                              styles.messageInfoRowCopyButton,
                              {
                                borderColor: isCopied ? theme.primary : theme.border,
                                backgroundColor: isCopied
                                  ? isDarkMode
                                    ? 'rgba(59, 130, 246, 0.22)'
                                    : 'rgba(59, 130, 246, 0.12)'
                                  : theme.background,
                              },
                            ]}
                            onPress={() => {
                              void handleMessageInfoRowCopy(rowKey, row.value, row.label);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`Copy ${row.label} details`}
                          >
                            {isCopied ? (
                              <CheckCircle2 size={12} color={theme.primary} />
                            ) : (
                              <Copy size={12} color={theme.textSecondary} />
                            )}
                            <Text
                              style={[
                                styles.messageInfoRowCopyButtonText,
                                { color: isCopied ? theme.primary : theme.textSecondary },
                              ]}
                            >
                              {isCopied ? 'Copied' : 'Copy'}
                            </Text>
                          </TouchableOpacity>
                        </View>
                      </View>

                      <TouchableOpacity
                        onLongPress={() => {
                          void handleMessageInfoRowCopy(rowKey, row.value, row.label);
                        }}
                        delayLongPress={220}
                        activeOpacity={0.86}
                        style={styles.messageInfoRowValuePressArea}
                        accessibilityRole="button"
                        accessibilityLabel={`Copy ${row.label} details`}
                      >
                        <Text style={[styles.messageInfoRowValue, { color: theme.text }]}>
                          {displayedValue}
                        </Text>
                      </TouchableOpacity>

                      {isExpandable ? (
                        <TouchableOpacity
                          style={styles.messageInfoRowToggleButton}
                          onPress={() => toggleMessageInfoRowExpanded(rowKey)}
                          accessibilityRole="button"
                          accessibilityLabel={
                            isExpanded
                              ? `Hide ${row.label} recipient details`
                              : `Show ${row.label} recipient details`
                          }
                          accessibilityState={{ expanded: isExpanded }}
                        >
                          <Text style={[styles.messageInfoRowToggleText, { color: theme.primary }]}>
                            {isExpanded ? 'Hide recipient details' : 'Show recipient details'}
                          </Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  );
                })
              )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    );
  };

  // Emoji picker modal for message reactions
  const renderEmojiPickerModal = () => {
    const fallbackMessage = selectedMessageForReaction
      ? getDisplayedMessageById(selectedMessageForReaction)
      : null;
    const targetMessage = selectedMessageForAction ?? fallbackMessage;

    const extraActions: { label: string; onPress: () => void; icon?: React.ReactNode; variant?: 'default' | 'primary' | 'danger'; disabled?: boolean }[] = [];
    if (targetMessage) {
      if (canReplyMessage(targetMessage)) {
        extraActions.push({
          label: 'Reply',
          onPress: () => {
            closeEmojiPicker();
            beginReplyToMessage(targetMessage);
          },
          icon: <Reply size={16} color="#ffffff" />,
          variant: 'primary',
        });
      }

      if (resolveChatConversationSearchSeedQuery(targetMessage?.text)) {
        extraActions.push({
          label: 'Find in chat',
          onPress: () => {
            closeEmojiPicker();
            beginConversationSearchFromMessage(targetMessage);
          },
          icon: <Search size={16} color={theme.text} />,
        });
      }

      extraActions.push({
        label: 'Info',
        onPress: () => {
          closeEmojiPicker();
          showMessageInfo(targetMessage);
        },
        icon: <Eye size={16} color={theme.text} />,
      });

      if (canEditMessage(targetMessage)) {
        extraActions.push({
          label: 'Edit',
          onPress: () => {
            closeEmojiPicker();
            beginEditingMessage(targetMessage);
          },
          icon: <Edit3 size={16} color="#ffffff" />,
          variant: 'primary',
        });
      }

      if (canDeleteMessage(targetMessage)) {
        const pending = isMessageActionPending(targetMessage.id);
        extraActions.push({
          label: pending ? 'Deleting…' : 'Delete',
          onPress: () => {
            closeEmojiPicker();
            confirmDeleteMessage(targetMessage);
          },
          icon: <Trash2 size={16} color="#ffffff" />,
          variant: 'danger',
          disabled: pending,
        });
      }
    }

    let pickerCopyText: string | undefined;
    if (selectedMessageForReaction) {
      const reactionMessage = getDisplayedMessageById(selectedMessageForReaction);
      const reactionMessageText = reactionMessage && typeof reactionMessage.text === 'string'
        ? reactionMessage.text.trim()
        : '';
      if (reactionMessageText.length > 0) {
        pickerCopyText = reactionMessageText;
      }
    }

    return (
      <EnhancedEmojiPicker
        visible={emojiPickerVisible}
        onClose={closeEmojiPicker}
        onEmojiSelect={(emoji) => {
          if (selectedMessageForReaction) {
            handleReaction(selectedMessageForReaction, emoji);
          }
          closeEmojiPicker();
        }}
        position={reactionPickerPosition}
        selectedMessageId={selectedMessageForReaction}
        getReactionStatus={getReactionStatus}
        theme={theme}
        copyText={pickerCopyText}
        extraActions={extraActions}
      />
    );
  };



  // Update selected team member when team members list changes (for real-time status updates)
  useEffect(() => {
    if (selectedTeamMember && teamMembersWithChatInfoById.size > 0) {
      const selectedId = selectedTeamMember.id != null ? String(selectedTeamMember.id) : '';
      const updatedMember = selectedId
        ? teamMembersWithChatInfoById.get(selectedId)
        : undefined;
      if (updatedMember) {
        // Check if any relevant properties have changed
        const hasStatusChanged = (
          updatedMember.isOnline !== selectedTeamMember.isOnline ||
          updatedMember.typingTo !== selectedTeamMember.typingTo ||
          updatedMember.lastSeen !== selectedTeamMember.lastSeen ||
          updatedMember.photoURL !== selectedTeamMember.photoURL ||
          updatedMember.customImageURL !== selectedTeamMember.customImageURL
        );
        
        if (hasStatusChanged) {
          setSelectedTeamMember(updatedMember);
        }
      }
    }
  }, [teamMembersWithChatInfoById, selectedTeamMember]);

  const deliveredMessageIds = useMemo(() => {
    // The authoritative delivered/confirmed signal is the UNION of ids on the
    // currently loaded page and ids independently confirmed by a resolved send
    // (chat-production-hardening, P1-2). Both the delivered-reconciliation effect
    // and the outbox self-heal driver consume this set, so a successfully-sent
    // message that is not (yet) on the loaded page is still treated as confirmed
    // and is never re-driven or dead-lettered.
    const displayedIds = displayedMessages
      .map((msg: any) => normalizeMessageId(msg?.id))
      .filter((id: string) => Boolean(id));
    return resolveConfirmedDeliveredIds(displayedIds, confirmedServerMessageIdsRef.current);
    // confirmedServerMessageIdsVersion is intentionally in the dep list so the
    // union re-evaluates whenever a newly confirmed id is added to the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedMessages, normalizeMessageId, confirmedServerMessageIdsVersion]);

  const pendingTextMessageCandidatesByKey = useMemo(() => {
    return resolveChatPendingMessageCandidatesByKey({
      displayedMessages,
      normalizeMessageId,
      normalizeParticipantEmail,
      normalizeMessageValue: normalizeMessageValue as (text: string | null | undefined) => string,
    });
  }, [
    displayedMessages,
    normalizeMessageId,
    normalizeParticipantEmail,
    normalizeMessageValue,
  ]);

  const findLikelyServerMessageIdForPendingText = useCallback((pendingMsg?: PendingMessage): string => {
    if (!pendingMsg) {
      return '';
    }

    const pendingStatus = resolvePendingMessageStatus(pendingMsg);
    const normalizedPendingText = normalizeMessageValue(String(pendingMsg.text || ''));
    const normalizedSender = normalizeParticipantEmail(
      pendingMsg.sender || effectiveUser?.email || user?.email || ''
    );
    const normalizedRecipient = normalizeParticipantEmail(pendingMsg.recipientId);
    const pendingTimestamp = resolveTimestampMs(pendingMsg.timestamp);
    const matchKey = buildChatPendingTextMatchKey(
      normalizedSender,
      normalizedRecipient,
      normalizedPendingText
    );
    const candidates = pendingTextMessageCandidatesByKey.get(matchKey);

    return resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus,
      normalizedPendingText,
      normalizedSender,
      normalizedRecipient,
      pendingTimestampMs: pendingTimestamp,
      candidates: candidates || [],
      maxTimestampDeltaMs: 12000,
    });
  }, [
    resolvePendingMessageStatus,
    normalizeMessageValue,
    normalizeParticipantEmail,
    effectiveUser?.email,
    user?.email,
    pendingTextMessageCandidatesByKey,
  ]);

  const normalizePendingMediaUrl = useCallback((value?: string | null) => {
    return typeof value === 'string' ? value.trim() : '';
  }, []);

  const buildPendingMediaMatchKey = useCallback((
    sender: string,
    recipient: string,
    kind: PendingMediaItem['kind'],
    url: string
  ) => `${sender}|${recipient}|${kind}|${url}`, []);

  const pendingMediaMessageCandidatesByKey = useMemo(() => {
    const candidatesByKey = new Map<string, { id: string; timestampMs: number }[]>();
    if (!Array.isArray(displayedMessages) || displayedMessages.length === 0) {
      return candidatesByKey;
    }

    for (const msg of displayedMessages) {
      if (!msg || msg.deleted) {
        continue;
      }

      const candidateId = normalizeMessageId(msg?.id);
      if (!candidateId) {
        continue;
      }

      const kind = msg.sticker ? 'sticker' : msg.gif ? 'gif' : '';
      if (!kind) {
        continue;
      }

      const mediaUrl = kind === 'sticker' ? msg.sticker?.url : msg.gif?.url;
      const normalizedUrl = normalizePendingMediaUrl(mediaUrl);
      if (!normalizedUrl) {
        continue;
      }

      const candidateSender = normalizeParticipantEmail(msg?.sender);
      const candidateRecipient = normalizeParticipantEmail(msg?.recipientId);
      if (!candidateSender || !candidateRecipient) {
        continue;
      }

      const matchKey = buildPendingMediaMatchKey(candidateSender, candidateRecipient, kind, normalizedUrl);
      const entry = {
        id: candidateId,
        timestampMs: resolveTimestampMs(msg?.timestamp),
      };

      const bucket = candidatesByKey.get(matchKey);
      if (bucket) {
        bucket.push(entry);
      } else {
        candidatesByKey.set(matchKey, [entry]);
      }
    }

    return candidatesByKey;
  }, [
    displayedMessages,
    normalizeMessageId,
    normalizeParticipantEmail,
    normalizePendingMediaUrl,
    buildPendingMediaMatchKey,
  ]);

  const findLikelyServerMessageIdForPendingMedia = useCallback((pendingItem?: PendingMediaItem): string => {
    if (!pendingItem) {
      return '';
    }

    const pendingStatus = pendingItem.status;
    const normalizedPendingUrl = normalizePendingMediaUrl(pendingItem.previewUri);
    const normalizedSender = normalizeParticipantEmail(
      pendingItem.sender || effectiveUser?.email || user?.email || ''
    );
    const normalizedRecipient = normalizeParticipantEmail(pendingItem.recipientId);
    const pendingTimestamp = resolveTimestampMs(pendingItem.timestamp);
    if (!normalizedPendingUrl || !normalizedSender || !normalizedRecipient) {
      return '';
    }

    const matchKey = buildPendingMediaMatchKey(
      normalizedSender,
      normalizedRecipient,
      pendingItem.kind,
      normalizedPendingUrl
    );
    const candidates = pendingMediaMessageCandidatesByKey.get(matchKey);

    return resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus,
      normalizedPendingText: normalizedPendingUrl,
      normalizedSender,
      normalizedRecipient,
      pendingTimestampMs: pendingTimestamp,
      candidates: candidates || [],
      maxTimestampDeltaMs: 12000,
    });
  }, [
    normalizePendingMediaUrl,
    normalizeParticipantEmail,
    effectiveUser?.email,
    user?.email,
    buildPendingMediaMatchKey,
    pendingMediaMessageCandidatesByKey,
  ]);

  // Attachment messages are matched the same way sticker/GIF messages are:
  // sender + recipient + a signature of the actual files being sent (name +
  // size for each file, order-independent). File identity is used instead of
  // the message text/caption because the caption is often a generic
  // auto-generated string ("Sent an image", "Sent a file", ...) that many
  // unrelated messages between the same two people can share — matching on
  // that alone caused a brand-new upload to falsely "match" an older,
  // already-delivered message with the same caption and get hidden
  // instantly, which is what made the upload progress bar disappear.
  //
  // Matching is also only ever attempted once the upload has actually
  // finished (status 'finalizing' or 'sent') — while status is 'sending' the
  // files are still uploading and the server message cannot exist yet, so
  // there is nothing valid to match against and the progress UI must stay
  // untouched.
  const buildPendingAttachmentMatchKey = useCallback((
    sender: string,
    recipient: string,
    fileSignature: string
  ) => `${sender}|${recipient}|${fileSignature}`, []);

  const buildAttachmentFileSignature = useCallback((files?: readonly { fileName?: string; fileSize?: number }[] | null): string => {
    if (!Array.isArray(files) || files.length === 0) {
      return '';
    }

    const parts = files
      .map((file) => `${(file?.fileName || '').trim().toLowerCase()}:${Number.isFinite(file?.fileSize) ? file?.fileSize : ''}`)
      .filter(Boolean)
      .sort();

    if (parts.length === 0) {
      return '';
    }

    return parts.join(',');
  }, []);

  const pendingAttachmentMessageCandidatesByKey = useMemo(() => {
    const candidatesByKey = new Map<string, { id: string; timestampMs: number }[]>();
    if (!Array.isArray(displayedMessages) || displayedMessages.length === 0) {
      return candidatesByKey;
    }

    for (const msg of displayedMessages) {
      if (!msg || msg.deleted) {
        continue;
      }

      // Only server messages that actually carry file attachments are valid
      // candidates for reconciling a pending attachment bubble.
      const candidateFiles = Array.isArray(msg.attachments) && msg.attachments.length > 0
        ? msg.attachments
        : msg.fileUrl
          ? [{ fileName: msg.fileName, fileSize: msg.fileSize }]
          : null;
      if (!candidateFiles) {
        continue;
      }

      const candidateId = normalizeMessageId(msg?.id);
      if (!candidateId) {
        continue;
      }

      const candidateSender = normalizeParticipantEmail(msg?.sender);
      const candidateRecipient = normalizeParticipantEmail(msg?.recipientId);
      const candidateFileSignature = buildAttachmentFileSignature(candidateFiles);
      if (!candidateSender || !candidateRecipient || !candidateFileSignature) {
        continue;
      }

      const matchKey = buildPendingAttachmentMatchKey(candidateSender, candidateRecipient, candidateFileSignature);
      const entry = {
        id: candidateId,
        timestampMs: resolveTimestampMs(msg?.timestamp),
      };

      const bucket = candidatesByKey.get(matchKey);
      if (bucket) {
        bucket.push(entry);
      } else {
        candidatesByKey.set(matchKey, [entry]);
      }
    }

    return candidatesByKey;
  }, [
    displayedMessages,
    normalizeMessageId,
    normalizeParticipantEmail,
    buildAttachmentFileSignature,
    buildPendingAttachmentMatchKey,
  ]);

  const findLikelyServerMessageIdForPendingAttachment = useCallback((pendingItem?: PendingAttachmentItem): string => {
    if (!pendingItem) {
      return '';
    }

    // Note: matching is intentionally allowed while status is still
    // 'sending'. The real server message only ever shows up in
    // `displayedMessages` (and therefore in the candidates map below) once
    // the upload has actually finished server-side, so there is nothing to
    // match against mid-upload regardless of this bubble's local status —
    // the realtime sync of the real message can still outrace the local
    // `sendMessageWithFiles` promise (which also awaits push-notification
    // dispatch), leaving this bubble stuck in 'sending' with no way to
    // reconcile if matching were restricted to 'finalizing'/'sent' only.
    // Correctness instead comes from the match key below being a specific
    // per-file signature (name + size) rather than the generic auto-caption
    // text, so it can't cross-match an unrelated older message.
    const fileSignature = buildAttachmentFileSignature(pendingItem.files);
    const normalizedSender = normalizeParticipantEmail(
      pendingItem.sender || effectiveUser?.email || user?.email || ''
    );
    const normalizedRecipient = normalizeParticipantEmail(pendingItem.recipientId);
    const pendingTimestamp = resolveTimestampMs(pendingItem.timestamp);
    if (!fileSignature || !normalizedSender || !normalizedRecipient) {
      return '';
    }

    const matchKey = buildPendingAttachmentMatchKey(
      normalizedSender,
      normalizedRecipient,
      fileSignature
    );
    const candidates = pendingAttachmentMessageCandidatesByKey.get(matchKey);

    return resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus: 'sent',
      normalizedPendingText: fileSignature,
      normalizedSender,
      normalizedRecipient,
      pendingTimestampMs: pendingTimestamp,
      candidates: candidates || [],
      maxTimestampDeltaMs: 20000,
    });
  }, [
    buildAttachmentFileSignature,
    normalizeParticipantEmail,
    effectiveUser?.email,
    user?.email,
    buildPendingAttachmentMatchKey,
    pendingAttachmentMessageCandidatesByKey,
  ]);

  useEffect(() => {
    if (pendingMessages.size === 0) {
      return;
    }

    const updates: { tempId: string; serverMessageId: string; pendingMsg: PendingMessage }[] = [];
    for (const [tempId, pendingMsg] of pendingMessages.entries()) {
      const status = resolvePendingMessageStatus(pendingMsg);
      if (status !== 'sending') {
        continue;
      }

      const existingServerMessageId = normalizeMessageId(pendingMsg.serverMessageId);
      if (existingServerMessageId) {
        continue;
      }

      const guessedServerMessageId = findLikelyServerMessageIdForPendingText(pendingMsg);
      if (!guessedServerMessageId) {
        continue;
      }

      updates.push({ tempId, serverMessageId: guessedServerMessageId, pendingMsg });
    }

    if (updates.length === 0) {
      return;
    }

    setPendingMessages((prev) => {
      const next = new Map(prev);
      updates.forEach(({ tempId, serverMessageId }) => {
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            status: 'sending',
            serverMessageId,
          });
        }
      });
      return next;
    });

    void Promise.all(
      updates.map(({ tempId, serverMessageId, pendingMsg }) =>
        PendingMessageStorage.addPendingMessage(tempId, {
          ...pendingMsg,
          status: 'sending',
          serverMessageId,
        })
      )
    ).catch((error) => {
      logger.warn('Failed to persist inferred server ids for pending messages:', error);
    });
  }, [
    pendingMessages,
    resolvePendingMessageStatus,
    normalizeMessageId,
    findLikelyServerMessageIdForPendingText,
  ]);

  useEffect(() => {
    if (pendingMedia.size === 0) {
      return;
    }

    const updates: { tempId: string; serverMessageId: string }[] = [];
    for (const [tempId, pendingItem] of pendingMedia.entries()) {
      if (!pendingItem) {
        continue;
      }

      if (pendingItem.status !== 'sending' && pendingItem.status !== 'sent') {
        continue;
      }

      const existingServerMessageId = normalizeMessageId(pendingItem.serverMessageId);
      if (existingServerMessageId) {
        continue;
      }

      const guessedServerMessageId = findLikelyServerMessageIdForPendingMedia(pendingItem);
      if (!guessedServerMessageId) {
        continue;
      }

      updates.push({ tempId, serverMessageId: guessedServerMessageId });
    }

    if (updates.length === 0) {
      return;
    }

    setPendingMedia((prev) => {
      const next = new Map(prev);
      updates.forEach(({ tempId, serverMessageId }) => {
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            serverMessageId,
          });
        }
      });
      return next;
    });
  }, [pendingMedia, normalizeMessageId, findLikelyServerMessageIdForPendingMedia]);

  // Background inference for pending file/media attachment bubbles, mirroring
  // the sticker/GIF logic above. Without this, an attachment upload has no
  // way to learn its server message id until the local send promise resolves
  // (which also awaits push-notification dispatch), so the optimistic
  // "Uploading.../Sent" bubble can remain visible at the same time as the
  // real message that already landed via the realtime listener — this was
  // the root cause of the duplicate status indicator shown for file sends.
  useEffect(() => {
    if (pendingAttachments.size === 0) {
      return;
    }

    const updates: { tempId: string; serverMessageId: string }[] = [];
    for (const [tempId, pendingItem] of pendingAttachments.entries()) {
      if (!pendingItem) {
        continue;
      }

      // 'sending' is intentionally included: the realtime sync of the real
      // message can outrace the local upload promise (which also awaits
      // push-notification dispatch), so a bubble can still be 'sending'
      // locally even though the server message already exists. Matching is
      // safe here because the match key is a specific per-file signature
      // (name + size), not the generic auto-caption text, so it can't
      // cross-match an unrelated message.
      if (
        pendingItem.status !== 'sending' &&
        pendingItem.status !== 'finalizing' &&
        pendingItem.status !== 'sent'
      ) {
        continue;
      }

      const existingServerMessageId = normalizeMessageId(pendingItem.serverMessageId);
      if (existingServerMessageId) {
        continue;
      }

      const guessedServerMessageId = findLikelyServerMessageIdForPendingAttachment(pendingItem);
      if (!guessedServerMessageId) {
        continue;
      }

      updates.push({ tempId, serverMessageId: guessedServerMessageId });
    }

    if (updates.length === 0) {
      return;
    }

    setPendingAttachments((prev) => {
      const next = new Map(prev);
      updates.forEach(({ tempId, serverMessageId }) => {
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            serverMessageId,
          });
        }
      });
      return next;
    });
  }, [pendingAttachments, normalizeMessageId, findLikelyServerMessageIdForPendingAttachment]);

  useEffect(() => {
    const activePendingIds = new Set<string>();

    for (const [tempId, pendingMsg] of pendingMessages.entries()) {
      activePendingIds.add(tempId);
      const status = resolvePendingMessageStatus(pendingMsg);
      const opacity = getPendingMessageBubbleOpacity(tempId);
      const previousStatus = pendingMessageLastStatusRef.current.get(tempId);
      const targetOpacity = resolveChatPendingBubbleOpacityTarget(status);

      if (!previousStatus) {
        opacity.setValue(targetOpacity);
      } else if (shouldAnimateChatPendingBubbleOpacity(previousStatus, status)) {
        Animated.timing(opacity, {
          toValue: targetOpacity,
          duration: resolveChatPendingBubbleOpacityDuration(status),
          useNativeDriver: true,
        }).start();
      }

      pendingMessageLastStatusRef.current.set(tempId, status);
    }

    const staleOpacityIds = resolveChatInactivePendingBubbleOpacityIds(
      pendingMessageBubbleOpacityRef.current.keys(),
      activePendingIds
    );
    for (const tempId of staleOpacityIds) {
      pendingMessageBubbleOpacityRef.current.delete(tempId);
      pendingMessageLastStatusRef.current.delete(tempId);
    }
  }, [pendingMessages, resolvePendingMessageStatus, getPendingMessageBubbleOpacity]);

  const retryPendingMessage = useCallback(
    async (tempId: string, options?: { silent?: boolean }): Promise<boolean> => {
      if (isOffline) {
        if (!options?.silent) {
          Toast.show({ type: 'info', text1: 'Offline', text2: 'Reconnect to retry this message.', position: 'top' });
        }
        return false;
      }

      const pendingMsg = pendingMessages.get(tempId) as PendingMessage | undefined;
      if (!pendingMsg || !selectedTeamMember || pendingMsg.recipientId !== selectedTeamMember.id) {
        return false;
      }

      const currentStatus = resolvePendingMessageStatus(pendingMsg);
      if (currentStatus === 'sending' || currentStatus === 'sent') {
        return false;
      }

      setRetryingPendingMessages((prev) => {
        if (prev.has(tempId)) return prev;
        const next = new Set(prev);
        next.add(tempId);
        return next;
      });

      setPendingMessages((prev) => {
        const next = new Map(prev);
        const current = next.get(tempId);
        if (current) {
          next.set(tempId, {
            ...current,
            status: 'sending',
          });
        }
        return next;
      });

      try {
        const serverMessageId = await sendMessage(
          pendingMsg.text,
          false,
          pendingMsg.recipientId,
          { replyTo: pendingMsg.replyTo, clientMsgId: pendingMsg.clientMsgId || tempId }
        );

        // Authoritative confirmation: a resolved serverMessageId proves a durable
        // record for the intended recipient exists (chat-production-hardening, P1-2).
        markServerMessageConfirmed(serverMessageId);

        // Keep the item in the confirmed-pending state ("Sending…") rather than
        // promoting straight to terminal "Sent" — a resolved promise is not proof
        // of a durable record for the intended recipient (stuck-message-delivery-fix,
        // task 10.4). The delivered-reconciliation effect clears it only once the
        // record surfaces in the live conversation.
        const acknowledgedPendingMessage: PendingMessage = {
          ...pendingMsg,
          status: 'sending',
          serverMessageId,
        };

        setPendingMessages((prev) => {
          const next = new Map(prev);
          const current = next.get(tempId);
          if (current) {
            next.set(tempId, {
              ...current,
              status: 'sending',
              serverMessageId,
            });
          }
          return next;
        });

        try {
          await PendingMessageStorage.addPendingMessage(tempId, acknowledgedPendingMessage);
        } catch (error) {
          logger.warn('Failed to persist acknowledged pending message after retry:', error);
        }

        if (!options?.silent) {
          Toast.show({ type: 'success', text1: 'Message Sent', text2: 'Pending message delivered.', position: 'top' });
        }
        return true;
      } catch (error) {
        logger.error('Retry pending message failed:', error);

        const failedPending: PendingMessage = {
          ...pendingMsg,
          status: 'failed',
        };

        // Guard against resurrecting an item that was removed in the meantime
        // (e.g. via "Cancel all" or delivery reconciliation) while this retry
        // was in flight.
        let stillPending = false;
        setPendingMessages((prev) => {
          const current = prev.get(tempId);
          if (!current) {
            return prev;
          }
          stillPending = true;
          const next = new Map(prev);
          next.set(tempId, {
            ...current,
            status: 'failed',
          });
          return next;
        });

        if (stillPending) {
          try {
            await PendingMessageStorage.addPendingMessage(tempId, failedPending);
          } catch (storageError) {
            logger.warn('Failed to persist pending message retry failure:', storageError);
          }
        }

        if (!options?.silent) {
          Toast.show({ type: 'error', text1: 'Retry Failed', text2: 'Could not resend this message.', position: 'top' });
        }
        return false;
      } finally {
        setRetryingPendingMessages((prev) => {
          if (!prev.has(tempId)) return prev;
          const next = new Set(prev);
          next.delete(tempId);
          return next;
        });
      }
    },
    [isOffline, pendingMessages, selectedTeamMember, sendMessage, resolvePendingMessageStatus, markServerMessageConfirmed]
  );

  // ---- Outbox self-heal driver (stuck-message-delivery-fix, tasks 10.5/10.6) ----
  // Tracks per-item re-drive bookkeeping (attempt count + next eligible time) so
  // un-confirmed sends are automatically re-driven with bounded exponential
  // backoff and dead-lettered once the cap is exhausted. Kept in a ref so driver
  // ticks never trigger re-renders on their own.
  const outboxRedriveStateRef = useRef<Map<string, { attempts: number; nextAt: number }>>(new Map());

  const deadLetterPendingMessage = useCallback((tempId: string) => {
    let failedPending: PendingMessage | null = null;
    setPendingMessages((prev) => {
      const current = prev.get(tempId);
      if (!current) {
        return prev;
      }
      const next = new Map(prev);
      failedPending = { ...current, status: 'failed' };
      next.set(tempId, failedPending);
      return next;
    });
    if (failedPending) {
      void PendingMessageStorage.addPendingMessage(tempId, failedPending).catch((error) => {
        logger.warn('Failed to persist dead-lettered pending message:', error);
      });
    }
  }, []);

  // Re-drive a single not-yet-confirmed send to the intended recipient, reusing
  // its clientMsgId so the server upsert is idempotent (no duplicate delivery).
  const reDriveUnconfirmedPendingMessage = useCallback(
    async (tempId: string): Promise<void> => {
      if (isOffline) {
        return;
      }
      const pendingMsg = pendingMessages.get(tempId) as PendingMessage | undefined;
      if (!pendingMsg || !selectedTeamMember || pendingMsg.recipientId !== selectedTeamMember.id) {
        return;
      }
      if (resolvePendingMessageStatus(pendingMsg) !== 'sending') {
        return;
      }
      // Already durably confirmed for the intended recipient (its server record
      // surfaced in the live conversation)? The reconciliation effect clears it —
      // never re-drive a confirmed message.
      const serverId = normalizeMessageId(pendingMsg.serverMessageId);
      if (serverId && deliveredMessageIds.has(serverId)) {
        return;
      }

      const state = outboxRedriveStateRef.current.get(tempId) ?? {
        attempts: pendingMsg.retryCount ?? 0,
        nextAt: 0,
      };
      const attempts = state.attempts + 1;

      // Dead-letter once the bounded retry policy is exhausted (task 10.6):
      // surface an explicit, actionable `failed` state rather than a phantom Sent.
      if (attempts > OUTBOX_MAX_REDRIVE_ATTEMPTS) {
        outboxRedriveStateRef.current.delete(tempId);
        // Authoritative safety net BEFORE dead-lettering (chat-production-hardening,
        // P1-2): the message may be durably persisted for the intended recipient
        // yet absent from the loaded page (listener gap, pagination trim, race).
        // Confirm delivery from a cheap keyed existence check — not loaded-page
        // presence alone — and mark it confirmed instead of flipping to a
        // misleading `failed`. Genuine failures (no server id, no durable record)
        // still dead-letter.
        let recordExists = false;
        if (serverId) {
          const senderEmail =
            pendingMsg.sender || effectiveUser?.email || user?.email || '';
          try {
            recordExists = await chatService.messageExistsById(
              senderEmail,
              pendingMsg.recipientId,
              serverId
            );
          } catch (error) {
            logger.debug('Outbox dead-letter existence check failed; falling back', {
              tempId,
              error,
            });
            recordExists = false;
          }
        }
        const action = resolveExhaustedOutboxAction({
          serverMessageId: serverId,
          confirmedDeliveredIds: deliveredMessageIds,
          recordExists,
        });
        if (action === 'confirm') {
          markServerMessageConfirmed(serverId);
          return;
        }
        deadLetterPendingMessage(tempId);
        return;
      }

      // Reserve the next backoff window before awaiting so overlapping driver
      // ticks never double-drive the same item.
      outboxRedriveStateRef.current.set(tempId, {
        attempts,
        nextAt: Date.now() + resolveOutboxBackoffMs(attempts),
      });

      try {
        const serverMessageId = await sendMessage(
          pendingMsg.text,
          false,
          pendingMsg.recipientId,
          { replyTo: pendingMsg.replyTo, clientMsgId: pendingMsg.clientMsgId || tempId }
        );
        // Authoritative confirmation of the re-driven send (chat-production-hardening,
        // P1-2): the returned id proves a durable record for the intended recipient.
        markServerMessageConfirmed(serverMessageId);
        const redrivenPending: PendingMessage = {
          ...pendingMsg,
          status: 'sending',
          serverMessageId,
          retryCount: attempts,
        };
        setPendingMessages((prev) => {
          const current = prev.get(tempId);
          if (!current) {
            return prev;
          }
          const next = new Map(prev);
          next.set(tempId, { ...current, status: 'sending', serverMessageId, retryCount: attempts });
          return next;
        });
        void PendingMessageStorage.addPendingMessage(tempId, redrivenPending).catch(() => undefined);
      } catch (error) {
        logger.debug('Outbox re-drive attempt failed; will retry after backoff', { tempId, error });
        // Leave the item in 'sending' so the next tick retries after backoff.
      }
    },
    [
      isOffline,
      pendingMessages,
      selectedTeamMember,
      resolvePendingMessageStatus,
      normalizeMessageId,
      deliveredMessageIds,
      sendMessage,
      deadLetterPendingMessage,
      markServerMessageConfirmed,
      effectiveUser?.email,
      user?.email,
    ]
  );

  const driveUnconfirmedOutbox = useCallback(() => {
    if (isOffline || !selectedTeamMember) {
      return;
    }
    const now = Date.now();
    const recipientId = selectedTeamMember.id;
    const eligible: string[] = [];
    pendingMessages.forEach((pendingMsg, tempId) => {
      if (!pendingMsg || pendingMsg.recipientId !== recipientId) {
        return;
      }
      if (resolvePendingMessageStatus(pendingMsg) !== 'sending') {
        return;
      }
      const serverId = normalizeMessageId(pendingMsg.serverMessageId);
      if (serverId && deliveredMessageIds.has(serverId)) {
        return; // confirmed for the intended recipient — reconciliation will clear it
      }
      // Don't race the initial in-flight send: only consider items that have been
      // pending for longer than the grace window.
      const ageMs = now - resolveTimestampMs(pendingMsg.timestamp);
      if (ageMs < OUTBOX_MIN_STALE_MS) {
        return;
      }
      const existingState = outboxRedriveStateRef.current.get(tempId);
      if (!existingState) {
        // First time we notice this stranded item: arm the initial backoff window
        // rather than re-driving immediately.
        outboxRedriveStateRef.current.set(tempId, {
          attempts: pendingMsg.retryCount ?? 0,
          nextAt: now + OUTBOX_BASE_BACKOFF_MS,
        });
        return;
      }
      if (now < existingState.nextAt) {
        return;
      }
      eligible.push(tempId);
    });
    eligible.forEach((tempId) => {
      void reDriveUnconfirmedPendingMessage(tempId);
    });
  }, [
    isOffline,
    selectedTeamMember,
    pendingMessages,
    deliveredMessageIds,
    resolvePendingMessageStatus,
    normalizeMessageId,
    reDriveUnconfirmedPendingMessage,
  ]);

  // Periodically (and promptly on reconnect / foreground / relaunch via the
  // isOffline flip and mount) drive the outbox so a not-yet-confirmed send
  // self-heals to the intended recipient without any user action.
  useEffect(() => {
    if (isOffline) {
      return;
    }
    driveUnconfirmedOutbox();
    const interval = setInterval(() => {
      driveUnconfirmedOutbox();
    }, OUTBOX_DRIVER_TICK_MS);
    return () => clearInterval(interval);
  }, [isOffline, driveUnconfirmedOutbox]);

  // Claim the open conversation for THIS screen's driver so the app-level
  // outbox self-heal hook (`hooks/useOutboxSelfHeal.ts`) never re-drives the same
  // pending items in parallel (chat-production-hardening, P1-1). The chat screen
  // only ever loads/drives the selected conversation's pending items, so it owns
  // exactly this recipient while mounted; the app-level driver owns every other
  // conversation. The claim is released on unmount / selection change.
  useEffect(() => {
    const recipientId = selectedTeamMember?.id;
    if (!recipientId) {
      return;
    }
    const release = claimOutboxConversation(recipientId);
    return release;
  }, [selectedTeamMember?.id]);

  // Prune driver bookkeeping for items that are no longer pending (delivered,
  // reconciled, canceled, or dead-lettered) so the map does not grow unbounded.
  useEffect(() => {
    const state = outboxRedriveStateRef.current;
    if (state.size === 0) {
      return;
    }
    for (const tempId of Array.from(state.keys())) {
      if (!pendingMessages.has(tempId)) {
        state.delete(tempId);
      }
    }
  }, [pendingMessages]);

  const pendingConversationDerived = useMemo(() => {
    return resolveChatPendingConversationDerivedState({
      selectedRecipientId: selectedTeamMember?.id,
      pendingMessages,
      pendingMedia,
      pendingAttachments,
      resolvePendingMessageStatus,
    });
  }, [pendingMessages, pendingMedia, pendingAttachments, selectedTeamMember?.id, resolvePendingMessageStatus]);

  const retryAllPendingCount = pendingConversationDerived.retryAllCount;

  const retryAllPendingSends = useCallback(async () => {
    const {
      retryableTextIds,
      retryableMediaIds,
      retryableAttachmentIds,
    } = pendingConversationDerived;
    const retryBatchPlan = resolveChatPendingRetryBatchPlan({
      retryableTextIds,
      retryableMediaIds,
      retryableAttachmentIds,
    });
    const total = retryBatchPlan.totalCount;

    const retryAllGuard = resolveChatPendingRetryAllGuard({
      selectedRecipientId: selectedTeamMember?.id,
      isOffline,
      totalCount: total,
      isRetryingAllPending,
    });
    if (!retryAllGuard.shouldRun) {
      if (retryAllGuard.toastPayload) {
        Toast.show(retryAllGuard.toastPayload);
      }
      return;
    }

    setIsRetryingAllPending(true);

    try {
      const retryPromises = resolveChatPendingRetryDispatchPromises({
        orderedTargets: retryBatchPlan.orderedTargets,
        handlers: {
          text: (tempId) => retryPendingMessage(tempId, { silent: true }),
          media: (tempId) => retryPendingMedia(tempId, { silent: true }),
          attachment: (tempId) => retryPendingAttachment(tempId, { silent: true }),
        },
      });

      const settled = await Promise.allSettled(retryPromises);
      const retryOutcomeSummary = resolveChatPendingRetryOutcomeSummary(settled, total);
      Toast.show(retryOutcomeSummary.toastPayload);
    } finally {
      setIsRetryingAllPending(false);
    }
  }, [selectedTeamMember?.id, isOffline, pendingConversationDerived, isRetryingAllPending, retryPendingMessage, retryPendingMedia, retryPendingAttachment]);

  // Cancel every currently failed/queued pending item (text, media, attachments)
  // for the active conversation. This mirrors retryAllPendingSends' target set
  // (the same items shown in the "N pending items not sent" banner) but removes
  // them instead of resending them, from in-memory state, persistent storage,
  // and any in-flight upload cancel handles.
  const cancelAllPendingSends = useCallback(() => {
    const {
      retryableTextIds,
      retryableMediaIds,
      retryableAttachmentIds,
    } = pendingConversationDerived;
    const cancelBatchPlan = resolveChatPendingRetryBatchPlan({
      retryableTextIds,
      retryableMediaIds,
      retryableAttachmentIds,
    });
    const total = cancelBatchPlan.totalCount;

    const cancelAllGuard = resolveChatPendingCancelAllGuard({
      selectedRecipientId: selectedTeamMember?.id,
      totalCount: total,
      isCancelingAllPending,
    });
    if (!cancelAllGuard.shouldRun) {
      return;
    }

    setIsCancelingAllPending(true);

    try {
      const textIdsToRemove: string[] = [];
      const mediaIdsToRemove: string[] = [];
      const attachmentIdsToRemove: string[] = [];

      cancelBatchPlan.orderedTargets.forEach((target) => {
        if (target.kind === 'text') {
          textIdsToRemove.push(target.tempId);
        } else if (target.kind === 'media') {
          mediaIdsToRemove.push(target.tempId);
        } else {
          attachmentIdsToRemove.push(target.tempId);
        }
      });

      if (textIdsToRemove.length > 0) {
        setPendingMessages((prev) => resolveChatPendingMapAfterRemovingIds(prev, textIdsToRemove));
        void PendingMessageStorage.removePendingMessages(textIdsToRemove).catch((error) => {
          logger.warn('Failed to remove canceled pending messages from storage:', error);
        });
      }

      if (mediaIdsToRemove.length > 0) {
        // Release any retained keyboard-paste Blobs (web) so canceling a queued
        // sticker/gif doesn't leak the object reference.
        mediaIdsToRemove.forEach((id) => keyboardMediaBlobRef.current.delete(id));
        setPendingMedia((prev) => {
          // Delete staged outbox files for the removed items (idempotent; a
          // non-staged/remote previewUri is ignored by removeOutboxMedia).
          mediaIdsToRemove.forEach((id) => {
            const stagedPreview = prev.get(id)?.previewUri;
            if (stagedPreview) {
              void removeOutboxMedia(stagedPreview);
            }
          });
          return resolveChatPendingMapAfterRemovingIds(prev, mediaIdsToRemove);
        });
      }

      if (attachmentIdsToRemove.length > 0) {
        attachmentIdsToRemove.forEach((tempId) => {
          clearAttachmentFinalizeTimer(tempId);
          attachmentUploadCancelMap.current.delete(tempId);
        });
        setPendingAttachments((prev) => {
          // Delete staged files for the canceled attachments (idempotent).
          attachmentIdsToRemove.forEach((id) => {
            prev.get(id)?.files?.forEach((f) => {
              if (f?.uri) {
                void removeOutboxMedia(f.uri);
              }
            });
          });
          return resolveChatPendingMapAfterRemovingIds(prev, attachmentIdsToRemove);
        });
      }

      Toast.show({
        type: 'success',
        text1: 'Canceled',
        text2: total === 1 ? 'Removed 1 pending item.' : `Removed ${total} pending items.`,
        position: 'top',
      });
    } finally {
      setIsCancelingAllPending(false);
    }
  }, [pendingConversationDerived, selectedTeamMember?.id, isCancelingAllPending, clearAttachmentFinalizeTimer]);

  // Auto-retry-on-reconnect shares the exact same per-item retry functions
  // (retryPendingMessage / retryPendingMedia / retryPendingAttachment) as
  // "Retry all", so a fix to how an item is resent never needs to be applied
  // in two places. It only targets items that are 'queued' (queued purely
  // because the device was offline), not items that are 'failed' for another
  // reason — those still require an explicit user retry.
  const retryAllQueuedPendingSends = useCallback(async () => {
    const { queuedTextIds, queuedMediaIds, queuedAttachmentIds } = pendingConversationDerived;
    const queuedBatchPlan = resolveChatPendingRetryBatchPlan({
      retryableTextIds: queuedTextIds,
      retryableMediaIds: queuedMediaIds,
      retryableAttachmentIds: queuedAttachmentIds,
    });
    const total = queuedBatchPlan.totalCount;
    if (total === 0 || isOffline) {
      return;
    }

    const retryPromises = resolveChatPendingRetryDispatchPromises({
      orderedTargets: queuedBatchPlan.orderedTargets,
      handlers: {
        text: (tempId) => retryPendingMessage(tempId, { silent: true }),
        media: (tempId) => retryPendingMedia(tempId, { silent: true }),
        attachment: (tempId) => retryPendingAttachment(tempId, { silent: true }),
      },
    });

    const settled = await Promise.allSettled(retryPromises);
    const successCount = settled.filter((r) => r.status === 'fulfilled' && r.value === true).length;

    if (successCount === 0) {
      return;
    }

    if (successCount === total) {
      Toast.show({
        type: 'success',
        text1: 'Messages Sent',
        text2: 'All queued items have been sent successfully.',
        position: 'top',
      });
    } else {
      Toast.show({
        type: 'info',
        text1: 'Partial Success',
        text2: `${successCount} of ${total} queued items were sent. Retry the rest manually.`,
        position: 'top',
      });
    }
  }, [pendingConversationDerived, isOffline, retryPendingMessage, retryPendingMedia, retryPendingAttachment]);

  // Effect to retry queued pending items (text, media, attachments) when
  // connection is restored.
  useEffect(() => {
    const pendingAutoRetryPlan = resolveChatPendingAutoRetryPlan({
      isOffline,
      pendingMessageCount: pendingConversationDerived.queuedAllCount,
      defaultDelayMs: 1000,
    });

    if (pendingAutoRetryPlan.shouldSchedule) {
      // Wait a moment for connection to stabilize
      const timer = setTimeout(() => {
        void retryAllQueuedPendingSends();
      }, pendingAutoRetryPlan.delayMs);
      return () => clearTimeout(timer);
    }
  }, [isOffline, pendingConversationDerived.queuedAllCount, retryAllQueuedPendingSends]);

  // Clear optimistic text rows once their server message shows up in conversation data.
  useEffect(() => {
    if (!shouldRunChatPendingDeliveredCleanup(pendingMessages.size, deliveredMessageIds.size)) {
      return;
    }

    const resolvedPendingIds = resolveChatPendingTextMessageReconciledIds({
      pendingMessages,
      deliveredMessageIds,
      normalizeMessageId,
      resolvePendingMessageStatus,
    });

    if (!hasChatPendingResolvedIds(resolvedPendingIds)) {
      return;
    }

    setPendingMessages((prev) => resolveChatPendingMapAfterRemovingIds(prev, resolvedPendingIds));

    void PendingMessageStorage.removePendingMessages(resolvedPendingIds).catch((error) => {
      logger.warn('Failed to remove reconciled pending messages from storage:', error);
    });
  }, [deliveredMessageIds, pendingMessages, normalizeMessageId, resolvePendingMessageStatus]);

  // Clear optimistic media rows once matching server message is present.
  useEffect(() => {
    if (!shouldRunChatPendingDeliveredCleanup(pendingMedia.size, deliveredMessageIds.size)) {
      return;
    }

    const resolvedIds = resolveChatPendingMediaMessageReconciledIds({
      pendingMedia,
      deliveredMessageIds,
      normalizeMessageId,
    });

    if (!hasChatPendingResolvedIds(resolvedIds)) {
      return;
    }

    setPendingMedia((prev) => resolveChatPendingMapAfterRemovingIds(prev, resolvedIds));
  }, [pendingMedia, deliveredMessageIds, normalizeMessageId]);

  // Clear optimistic attachment rows once matching server message is present.
  useEffect(() => {
    if (!shouldRunChatPendingDeliveredCleanup(pendingAttachments.size, deliveredMessageIds.size)) {
      return;
    }

    const resolvedIds = resolveChatPendingAttachmentMessageReconciledIds({
      pendingAttachments,
      deliveredMessageIds,
      normalizeMessageId,
    });

    if (!hasChatPendingResolvedIds(resolvedIds)) {
      return;
    }

    setPendingAttachments((prev) => {
      resolvedIds.forEach((tempId) => {
        clearAttachmentFinalizeTimer(tempId);
      });
      return resolveChatPendingMapAfterRemovingIds(prev, resolvedIds);
    });
  }, [pendingAttachments, deliveredMessageIds, normalizeMessageId, clearAttachmentFinalizeTimer]);

  const retryPendingMessageRef = useRef(retryPendingMessage);
  useEffect(() => {
    retryPendingMessageRef.current = retryPendingMessage;
  }, [retryPendingMessage]);

  const retryPendingMessagePressHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getRetryPendingMessagePressHandler = useCallback((tempId: string) => {
    return resolveMapCacheEntry(retryPendingMessagePressHandlersRef.current, tempId, () => {
      return () => {
        void retryPendingMessageRef.current(tempId);
      };
    });
  }, []);

  useEffect(() => {
    const activeIds = resolveChatPendingActiveIdSet(pendingMessages.keys());
    pruneMapByKeySet(retryPendingMessagePressHandlersRef.current, activeIds);
  }, [pendingMessages]);

  const inlineConversationSearchHighlightQuery = conversationSearchVisible
    ? normalizedConversationSearchQuery
    : '';

  // Render pending messages with visual indicators
  const renderPendingMessage = (tempId: string, pendingMsg: PendingMessage) => {
    // Only show pending messages for the currently selected team member
    if (!selectedTeamMember) return null;
    const baseStatus = resolvePendingMessageStatus(pendingMsg);
    const pendingTextVisibilityState = resolveChatPendingTextVisibilityState({
      selectedRecipientId: selectedTeamMember.id,
      itemRecipientId: pendingMsg.recipientId,
      status: baseStatus,
      serverMessageId: pendingMsg.serverMessageId,
      deliveredMessageIds,
      normalizeMessageId,
      resolveFallbackServerMessageId: () => findLikelyServerMessageIdForPendingText(pendingMsg),
    });
    if (!pendingTextVisibilityState.shouldRender) {
      return null;
    }

    const rowAnim = getPendingRowAnimation(buildChatPendingRowAnimationKey('text', tempId), 'outgoing');
    const isRetrying = retryingPendingMessages.has(tempId);
    const pendingTextStatusState = resolveChatPendingStatusDisplayState({
      status: baseStatus,
      isOffline,
      isRetrying,
    });
    const effectiveStatus = pendingTextStatusState.effectiveStatus;
    const bubbleOpacity = getPendingMessageBubbleOpacity(tempId);
    const pendingTextReplyPreviewState = resolveChatPendingReplyPreviewState({
      replyTo: pendingMsg.replyTo,
      maxLength: CHAT_REPLY_PREVIEW_MAX_CHARS,
      resolvePreviewText: resolveChatReplyPreviewText,
    });
    const pendingReplyPreview = pendingTextReplyPreviewState.previewText;
    const pendingReplySenderLabel = pendingTextReplyPreviewState.shouldShowPreview
      ? resolveChatReplySenderLabel(pendingMsg.replyTo)
      : '';
    
    return (
      <Animated.View
        key={tempId}
        style={{
          opacity: rowAnim.opacity,
          transform: [{ translateX: rowAnim.translateX }, { scale: rowAnim.scale }],
        }}
      >
      <View style={[
        styles.messageContainer,
        styles.ownMessage
      ]}>
        <Animated.View style={[
          styles.messageBubble,
          styles.ownBubble,
          { backgroundColor: theme.primary, opacity: bubbleOpacity }
        ]}>
          {pendingReplyPreview && (
            <TouchableOpacity
              style={[styles.replySnippet, styles.replySnippetOwn, { borderLeftColor: 'rgba(255, 255, 255, 0.7)' }]}
              activeOpacity={0.85}
              onPress={() => {
                void jumpToReplyMessage(pendingMsg.replyTo);
              }}
            >
              <Text style={[styles.replySnippetSender, styles.replySnippetSenderOwn]} numberOfLines={1}>
                {pendingReplySenderLabel}
              </Text>
              <Text style={[styles.replySnippetText, styles.replySnippetTextOwn]} numberOfLines={1}>
                {pendingReplyPreview}
              </Text>
            </TouchableOpacity>
          )}
          <StyledText
            text={sanitizeMessageText(pendingMsg.text, 'Sending message...')}
            style={[
              styles.messageText,
              styles.ownMessageText
            ]}
            linkStyle={{
              color: 'rgba(255, 255, 255, 0.9)',
              fontWeight: '600'
            }}
            highlightQuery={inlineConversationSearchHighlightQuery}
            highlightStyle={styles.searchInlineHighlightOwn}
          />
          
          <View style={[styles.messageFooter, styles.ownMessageFooter]}>
            <Text style={[
              styles.messageTime,
              styles.ownMessageTime,
              styles.pendingTextMessageTime
            ]}>
              {pendingTextStatusState.statusLabel}
            </Text>
            <View style={{ marginLeft: 6 }}>
              {effectiveStatus === 'sending' ? (
                <Clock size={12} color="rgba(255, 255, 255, 0.9)" />
              ) : effectiveStatus === 'sent' ? (
                <CheckCircle2 size={12} color="rgba(255, 255, 255, 0.9)" />
              ) : effectiveStatus === 'failed' ? (
                <AlertCircle size={12} color="rgba(255, 255, 255, 0.95)" />
              ) : (
                <Clock size={12} color="rgba(255, 255, 255, 0.85)" />
              )}
            </View>
            {pendingTextStatusState.canRetry && (
              <TouchableOpacity
                onPress={getRetryPendingMessagePressHandler(tempId)}
                disabled={isRetrying}
                style={[
                  styles.pendingTextRetryButton,
                  isRetrying ? { opacity: 0.6 } : null
                ]}
              >
                <RotateCcw size={12} color="#ffffff" />
                <Text style={styles.pendingTextRetryButtonText}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        </Animated.View>
      </View>
      </Animated.View>
    );
  };

  // Load pending messages when component mounts or team member changes
  useEffect(() => {
    const loadPendingMessages = async () => {
      const senderEmail = resolveChatPendingSenderEmail(effectiveUser?.email, user?.email);
      if (shouldLoadChatPendingMessages(selectedTeamMember?.id, senderEmail)) {
        const storedPendingMessages = await PendingMessageStorage.getPendingMessagesForRecipient(
          selectedTeamMember?.id || '',
          senderEmail
        );

        const normalizedPendingMessages = resolveChatNormalizedPendingMessages(
          storedPendingMessages,
          resolvePendingMessageStatus
        ) as Map<string, PendingMessage>;

        setPendingMessages(normalizedPendingMessages);
      } else {
        setPendingMessages(new Map<string, PendingMessage>());
      }
    };

    loadPendingMessages();
  }, [selectedTeamMember, effectiveUser?.email, user?.email, resolvePendingMessageStatus]);

  const messagesContentContainerStyle = useMemo(
    () => StyleSheet.flatten([styles.messagesContent, { paddingBottom: bottomVisibilityPadding }]),
    [bottomVisibilityPadding]
  );

  const scrollToBottomButtonStyle = useMemo(
    () =>
      resolveChatScrollToBottomButtonStyleState({
        inputHeight,
        surfaceColor: theme.surface,
        borderColor: theme.border,
        borderWidth: StyleSheet.hairlineWidth,
      }),
    [inputHeight, theme.border, theme.surface]
  );

  const unseenCountBadgeStyle = useMemo(
    () => ({
      marginLeft: 8,
      minWidth: 22,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: theme.primary,
    }),
    [theme.primary]
  );

  const handleScrollToBottomPress = useCallback(() => {
    const nextFabState = resolveReplyJumpStateForLatestReturn();
    resetUnseenCount();
    setShowScrollToBottomSafely(nextFabState.showScrollToBottom);
    setShowReplyJumpToLatestSafely(nextFabState.showReplyJumpToLatest);
    // Intentionally do NOT clear the new-messages / unread dividers here. The
    // button just navigates to the bottom; the dividers stay so the user can see
    // where the new/unread messages begin (matching a manual scroll-to-bottom),
    // and they retire on their own (unread → caught-up auto-dismiss; new → when
    // the next message arrives while at the bottom, or on chat switch).
    scrollToBottom();
  }, [
    resetUnseenCount,
    scrollToBottom,
    setShowReplyJumpToLatestSafely,
    setShowScrollToBottomSafely,
  ]);

  const handleSpecialIndicatorClose = useCallback(() => {
    clearInputField();
  }, [clearInputField]);

  const handleRetryAllPendingPress = useCallback(() => {
    void retryAllPendingSends();
  }, [retryAllPendingSends]);

  const handleCancelAllPendingPress = useCallback(() => {
    cancelAllPendingSends();
  }, [cancelAllPendingSends]);

  const appendFormattingText = useCallback((suffix: string) => {
    const baseText = typeof latestMessageRef.current === 'string' ? latestMessageRef.current : '';
    handleTyping(`${baseText}${suffix}`);
  }, [handleTyping]);


  const handleSelectTeamMemberFromList = useCallback((member: TeamMember) => {
    forceBottomAnchorChatKeyRef.current = String(member.id || member.email || '');
    setSelectedTeamMember(member);
    scheduleTimeoutRef(selectMemberFocusTimerRef, () => {
      try {
        mobileInputRef.current?.focusInput?.();
      } catch (e) {
        logger.debug('Mobile input focus not available');
      }
    }, 500);
  }, []);

  const handleSelectTeamMemberFromListRef = useRef(handleSelectTeamMemberFromList);
  useEffect(() => {
    handleSelectTeamMemberFromListRef.current = handleSelectTeamMemberFromList;
  }, [handleSelectTeamMemberFromList]);

  const teamMemberSelectPressHandlersRef = useRef<Map<string, () => void>>(new Map());
  const teamMemberByPressKeyRef = useRef<Map<string, TeamMember>>(new Map());
  const getTeamMemberPressKey = useCallback((member: TeamMember) => {
    return String(member?.id || member?.email || '');
  }, []);

  const getTeamMemberSelectPressHandler = useCallback((member: TeamMember) => {
    const key = getTeamMemberPressKey(member);
    if (!key) {
      return noopPressHandler;
    }

    teamMemberByPressKeyRef.current.set(key, member);
    return resolveMapCacheEntry(teamMemberSelectPressHandlersRef.current, key, () => {
      return () => {
        const latestMember = teamMemberByPressKeyRef.current.get(key) || member;
        handleSelectTeamMemberFromListRef.current(latestMember);
      };
    });
  }, [getTeamMemberPressKey, noopPressHandler]);

  useEffect(() => {
    const nextMembers = new Map<string, TeamMember>();
    filteredTeamMembers.forEach((member) => {
      const key = getTeamMemberPressKey(member as TeamMember);
      if (key) {
        nextMembers.set(key, member as TeamMember);
      }
    });

    teamMemberByPressKeyRef.current = nextMembers;

    const handlers = teamMemberSelectPressHandlersRef.current;
    for (const key of Array.from(handlers.keys())) {
      if (!nextMembers.has(key)) {
        handlers.delete(key);
      }
    }
  }, [filteredTeamMembers, getTeamMemberPressKey]);

  // Safe early return after all hooks/effects are registered
  if (tenantLoading && !activeTenant?.id) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}> 
        <View style={[styles.container, styles.centered]}> 
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading chat…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (tenantUnavailable) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}> 
        <TenantSelectionEmptyState
          title="No coaching center selected"
          description="Use Settings → Coaching centers to choose, create, or join a workspace before messaging."
          primaryActionLabel="Open Settings"
          onPrimaryAction={() => router.push('/(tabs)/settings')}
        />
      </SafeAreaView>
    );
  }

  if (!selectedTeamMember && showOfflineLoadingChat) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}> 
        {/* Header */}
        <View style={[styles.header, { backgroundColor: theme.background, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}> 
          <Text allowFontScaling={false} style={[styles.headerTitle, { color: theme.text }]}>Messages</Text>
        </View>
        <View style={[styles.container, styles.centered]}> 
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading chat…</Text>
          {!!offlineHintChat && (
            <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 8 }]}>{offlineHintChat}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // Main render function - show user list or chat view
  if (!selectedTeamMember) {
    // Show loading screen when auth is loading or when we have user but no team members loaded yet
    if (authLoading || teamMembersLoading) {
      return (
        <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
          {/* Header */}
          <View style={[styles.header, { backgroundColor: theme.background, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
            <Text allowFontScaling={false} style={[styles.headerTitle, { color: theme.text }]}>Messages</Text>
          </View>
          
          {/* Loading Content */}
          <View style={[styles.container, styles.centered]}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>
              {authLoading ? 'Authenticating...' : 'Loading team members...'}
            </Text>
          </View>
        </SafeAreaView>
      );
    }

    const userListOptionActions = (!longPressedMember || !user?.email)
      ? []
      : [
          {
            text: pinnedChats[chatPreferencesService.sanitizeEmailKey(longPressedMember.email)] ? 'Unpin chat' : 'Pin chat',
            onPress: async () => {
              const key = chatPreferencesService.sanitizeEmailKey(longPressedMember.email);
              const isPinned = !!pinnedChats[key];
              try {
                if (isPinned) {
                  await chatPreferencesService.unpinChat(user.email, longPressedMember.email);
                } else {
                  await chatPreferencesService.pinChat(user.email, longPressedMember.email);
                }
              } catch (e) {
                Toast.show({ type: 'error', text1: 'Failed to update pin' });
              }
            },
            style: 'primary',
            icon: <Star size={16} color={'#ffffff'} />,
          },
        ] as any;
    
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        {/* Header */}
  <View style={[styles.header, { backgroundColor: theme.background, paddingTop: Math.max(0, sharedTopPadding - effectiveHeaderComp) }]}>
          <Text allowFontScaling={false} style={[styles.headerTitle, { color: theme.text }]}>Messages</Text>
        </View>

        {/* Team Members List */}
        <View style={[styles.searchContainer, { backgroundColor: theme.surface }]}
          accessibilityRole="search"
        >
          <Search size={20} color={theme.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: theme.text }]}
            placeholder="Search team members..."
            placeholderTextColor={theme.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
            autoCapitalize="none"
          />
        </View>

        <RNFlatList
          data={filteredTeamMembers}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const userAvatarInitial = getSafeDisplayInitial(item.name || 'U');
            const lastMessagePreviewText = item.lastMessage
              ? sanitizeMessageText(item.lastMessage.text, '📎 Attachment').trim()
              : '';
            const presenceLabel = formatOnlineStatus(item.isOnline, item.lastSeen);

            return (
            <TouchableOpacity
              style={[styles.userListItem, { backgroundColor: theme.background }]}
              onPress={getTeamMemberSelectPressHandler(item)}
              activeOpacity={0.7}
              onLongPress={() => {
                setLongPressedMember(item);
                setUserListOptionsVisible(true);
              }}
              delayLongPress={500}
            >
              <View style={[styles.userAvatar, { backgroundColor: theme.primary }]}>
                {getProfilePictureURL(item) ? (
                  <Image 
                    source={{ uri: getProfilePictureURL(item) }} 
                    style={styles.userAvatarImage}
                  />
                ) : (
                  <Text style={styles.userAvatarText}>
                    {userAvatarInitial}
                  </Text>
                )}
                {/* Online status indicator */}
                {item.isOnline !== undefined && (
                  <View style={[styles.onlineIndicator, { backgroundColor: item.isOnline ? theme.success : theme.error }]} />
                )}
              </View>

              {/* User Info */}
              <View style={styles.userInfo}>
                <View style={styles.userHeaderRow}>
                  <Text style={[styles.userName, { color: theme.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={styles.chatMetaContainer}>
                    {item.pinnedSerial ? (
                      <View style={[styles.pinnedBadge, { backgroundColor: theme.primary + '20' }]}>
                        <Star size={12} color={theme.primary} />
                        <Text style={[styles.pinnedText, { color: theme.primary }]}>{item.pinnedSerial}</Text>
                      </View>
                    ) : null}
                    {/* Last message time */}
                    {item.lastMessageTime && typeof item.lastMessageTime === 'string' && item.lastMessageTime.trim().length > 0 && (
                      <Text style={[
                        styles.lastMessageTime, 
                        { color: (item.unreadCount && item.unreadCount > 0) ? theme.primary : theme.textSecondary }
                      ]}>
                        {item.lastMessageTime}
                      </Text>
                    )}
                    <TenantRoleBadge role={(item as any)?.tenantRole ?? null} style={styles.marginLeft6} />
                  </View>
                </View>
                
                <View style={styles.userStatusRow}>
                  {String(item.typingTo || '').toLowerCase().trim() === String(effectiveUserEmail || '').toLowerCase().trim() ? (
                    <View style={styles.typingIndicatorSmall}>
                      <AnimatedTypingIndicator color={theme.primary} />
                      <Text style={[styles.userStatus, { color: theme.primary, fontStyle: 'italic', marginLeft: 8 }]}>
                        typing...
                      </Text>
                    </View>
                  ) : item.lastMessage ? (
                    <View style={styles.lastMessageContainer}>
                      {/* Show status ticks for own messages */}
                      {item.lastMessage.isOwnMessage && (
                        <MessageStatusTicks 
                          delivered={item.lastMessage.delivered}
                          deliveredAt={null}
                          read={item.lastMessage.read}
                          readAt={null}
                          color={theme.textSecondary}
                          size={12}
                          theme={isDarkMode ? 'dark' : 'light'}
                        />
                      )}
                      <Text 
                        style={[
                          styles.lastMessageText,
                          // Make unread messages bold for recipient (when it's NOT own message and has unread count)
                          (!item.lastMessage.isOwnMessage && item.unreadCount && item.unreadCount > 0) ? {
                            fontWeight: 'bold',
                            color: theme.text, // Use primary text color for unread messages
                            fontFamily: 'Inter-Bold', // Use bold font family if available
                          } : {
                            color: theme.textSecondary,
                            fontFamily: 'Inter-Regular',
                          }
                        ]} 
                        numberOfLines={1}
                      >
                        {lastMessagePreviewText}
                      </Text>
                    </View>
                  ) : presenceLabel ? (
                    <Text style={[styles.userStatus, { color: theme.textSecondary }]} numberOfLines={1}>
                      {presenceLabel}
                    </Text>
                  ) : null}
                </View>
              </View>

              {/* Right side - Unread count */}
              <View style={styles.userListRight}>
                {item.unreadCount && item.unreadCount > 0 ? (
                  <View style={[styles.unreadBadge, { backgroundColor: theme.primary }]}>
                    <Text style={styles.unreadCount}>
                      {item.unreadCount > 99 ? '99+' : item.unreadCount}
                    </Text>
                  </View>
                ) : (
                  <MessageCircle size={20} color={theme.textSecondary} />
                )}
              </View>
            </TouchableOpacity>
          );
          }}
          style={styles.usersList}
          showsVerticalScrollIndicator={false}
          refreshing={isManualListRefresh}
          onRefresh={() => {
            setIsManualListRefresh(true);
            void Promise.all([refreshChatSummaries(), loadTenantTeamMembers()]).finally(() => {
              setIsManualListRefresh(false);
            });
          }}
          ListEmptyComponent={() => (
            <View style={styles.emptyUsersList}>
              <MessageCircle size={48} color={teamMembersError ? theme.error : theme.textSecondary} />
              <Text
                style={[styles.emptyUsersText, { color: teamMembersError ? theme.error : theme.text }]}
              >
                {teamMembersError ?? 'No team members found'}
              </Text>
              <Text style={[styles.emptyUsersSubtext, { color: theme.textSecondary }]}> 
                {teamMembersError
                  ? 'Pull to refresh or check your connection.'
                  : searchQuery.trim().length > 0
                    ? 'Try a different search or clear your query'
                    : 'Team members will appear here when they sign in'}
              </Text>
            </View>
          )}
        />
        <OptionModal
          visible={userListOptionsVisible && !!longPressedMember}
          onClose={() => { setUserListOptionsVisible(false); setLongPressedMember(null); }}
          title={longPressedMember?.name || 'Chat options'}
          actions={userListOptionActions}
        />
      </SafeAreaView>
    );
  }

  // Chat View - When user is selected
  if (loading || showOfflineLoadingChat) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={[styles.container, styles.centered]}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading messages...</Text>
          {!!offlineHintChat && (
            <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 8 }]}>{offlineHintChat}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={[styles.container, styles.centered]}>
          <Text style={[styles.errorText, { color: theme.error }]}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const getComposerPlaceholder = (): string => {
    if (isOffline) {
      return 'Offline - messages will be queued';
    }
    if (isComposingSpecial) {
      return 'Type your special message here...';
    }
    if (isSmallScreen) {
      return 'Message';
    }

    const rawName = selectedTeamMember?.name;
    const safeName = typeof rawName === 'string' ? rawName.trim() : '';
    if (!safeName || safeName === '.') {
      return 'Message team member...';
    }
    return `Message ${safeName}...`;
  };

  const alignMessageListAnchors = (hasLayout: boolean, hasContent: boolean) => {
    const forceChatKey = forceBottomAnchorChatKeyRef.current;
    const selectedChatKey = String(selectedTeamMember?.id || selectedTeamMember?.email || '');
    const canForceBottomAnchor =
      forceChatKey &&
      selectedChatKey &&
      forceChatKey === selectedChatKey &&
      unreadDividerSeeded &&
      !unreadSeparatorAnchorMessageId &&
      hasLayout &&
      hasContent;

    if (canForceBottomAnchor) {
      userInteractedRef.current = false;
      markAutoScroll(320);
      tryAnchorToBottom(true);
      scheduleScrollToBottom({ animated: false, delay: 0 });
      setTimeout(() => scheduleScrollToBottom({ animated: false, delay: 0 }), 80);
      forceBottomAnchorChatKeyRef.current = null;
    }

    if (shouldUseManualAnchorPreservation && pendingPrependAnchorRef.current) {
      restorePrependAnchorIfNeeded();
      if (pendingPrependAnchorRef.current) {
        return;
      }
    }

    if (anchoredTargetRef.current) {
      ensureAnchorPosition();
      if (anchoredTargetRef.current) {
        return;
      }
    }

    if (hasAnchoredInitialScrollRef.current) {
      return;
    }

    // Don't make the initial anchor decision until the unread divider seed is
    // resolved (see the seed effect). This prevents racing the seed and snapping
    // to the bottom while an unread anchor is still pending.
    if (!unreadDividerSeeded) {
      pendingInitialAnchorRef.current = true;
      return;
    }

    if (unreadSeparatorAnchorMessageId && !scrollToUnreadAttemptedRef.current) {
      scheduleScrollToUnread(unreadSeparatorAnchorMessageId);
    } else if (pendingInitialAnchorRef.current) {
      tryAnchorToBottom();
    }
  };

  const handleMessageListContentSizeChange = (_w: number, h: number) => {
    contentHeightRef.current = h;
    alignMessageListAnchors(layoutHeightRef.current > 0, h > 0);
  };

  const handleMessageListLayout = (e: any) => {
    const height = e?.nativeEvent?.layout?.height ?? 0;
    layoutHeightRef.current = height;
    alignMessageListAnchors(height > 0, contentHeightRef.current > 0);
  };

  const handleMessageListScroll = (e: any) => {
    handleScroll(e);
    try {
      const y = e.nativeEvent.contentOffset?.y ?? 0;
      const contentH = e.nativeEvent.contentSize?.height ?? 0;
      const layoutH = e.nativeEvent.layoutMeasurement?.height ?? 0;
      const wasNearBottom = isAtBottomRef.current;
      const nearBottomState = resolveChatNearBottomState({
        offsetY: y,
        contentHeight: contentH,
        layoutHeight: layoutH,
        bottomVisibilityPadding,
        wasNearBottom,
        showUnreadSeparator: showUnreadSeparatorRef.current,
        activeUnreadAnchorId: unreadSeparatorAnchorMessageId || unreadSeparatorMessageIdRef.current,
        lastDismissedUnreadAnchorId: lastNearBottomUnreadDismissAnchorRef.current,
      });
      const nearBottom = nearBottomState.nearBottom;
      isAtBottomRef.current = nearBottom;
      if (nearBottom) {
        if (nearBottomState.enteredNearBottom) {
          const nextFabState = resolveReplyJumpStateForNearBottom();
          setShowScrollToBottomSafely(nextFabState.showScrollToBottom);
          setShowReplyJumpToLatestSafely(nextFabState.showReplyJumpToLatest);
          resetUnseenCount();
          // Intentionally do NOT clear the new-messages divider here. Scrolling
          // down to read the new messages should keep the divider visible so the
          // user can see where they begin; it is cleared only when the next
          // message arrives while at the bottom (the new-tail at-bottom branch)
          // or on chat switch.
        }

        lastNearBottomUnreadDismissAnchorRef.current = nearBottomState.nextDismissedUnreadAnchorId;

        if (
          nearBottomState.shouldDismissUnreadDivider &&
          nearBottomState.activeUnreadAnchorId
        ) {
          dismissUnreadDividerForCurrentBatch(UNREAD_DIVIDER_ACTION_DISMISS_MS);
        }
      } else {
        lastNearBottomUnreadDismissAnchorRef.current = nearBottomState.nextDismissedUnreadAnchorId;

        // Always show the FAB when user is not at the bottom
        if (nearBottomState.leftNearBottom) {
          setShowScrollToBottomSafely(true);
        }
      }
    } catch {}
  };

  const chatListHeaderComponent = (
    <View style={styles.alignItemsCenterMarginVertical8}>
      {loadingMore ? (
        <ActivityIndicator color={theme.primary} size="small" />
      ) : reachedConversationStart ? (
        <Text style={themedStyles.colorTextSecondary}>
          {"You're at the beginning of this conversation"}
        </Text>
      ) : null}
    </View>
  );

  const chatListFooterComponent = (
    <View>
      {/* Optimistic pending media (stickers/GIFs) */}
      {selectedTeamMember && pendingConversationDerived.mediaEntries.map(([tempId, item]) => {
        if (!tempId || !item) return null;
        // Fall back to a heuristically-matched server message id when the
        // item hasn't been explicitly reconciled yet, so a media bubble that
        // has already landed on the server doesn't linger as "pending".
        const effectiveItem = item.serverMessageId
          ? item
          : (() => {
              const inferred = findLikelyServerMessageIdForPendingMedia(item);
              return inferred ? { ...item, serverMessageId: inferred } : item;
            })();
        return (
          <ChatPendingMedia
            key={tempId}
            tempId={tempId}
            item={effectiveItem}
            selectedTeamMemberId={selectedTeamMember.id}
            deliveredMessageIds={deliveredMessageIds}
            normalizeMessageId={normalizeMessageId}
            getPendingRowAnimation={getPendingRowAnimation}
            buildChatPendingRowAnimationKey={buildChatPendingRowAnimationKey}
            isOffline={isOffline}
            CHAT_REPLY_PREVIEW_MAX_CHARS={CHAT_REPLY_PREVIEW_MAX_CHARS}
            resolveChatReplyPreviewText={resolveChatReplyPreviewText}
            resolveChatReplySenderLabel={resolveChatReplySenderLabel}
            jumpToReplyMessage={jumpToReplyMessage}
            getRetryPendingMediaPressHandler={getRetryPendingMediaPressHandler}
            PendingUploadProgressBar={PendingUploadProgressBar}
            theme={theme}
            themedStyles={themedStyles}
            styles={styles}
          />
        );
      })}

      {/* Pending text messages (queued/sending/sent/failed) */}
      {pendingConversationDerived.messageEntries.map(([tempId, pendingMsg]) => {
        if (!tempId || !pendingMsg) return null;
        const renderedPending = renderPendingMessage(tempId, pendingMsg);
        if (typeof renderedPending === 'string') {
          logger.warn('⚠️ renderPendingMessage returned string:', JSON.stringify(renderedPending));
          return null;
        }
        return renderedPending;
      })}

      {/* Optimistic pending file attachments */}
      {selectedTeamMember && pendingConversationDerived.attachmentEntries.map(([tempId, item]) => {
        if (!tempId || !item) return null;
        // Fall back to a heuristically-matched server message id when the
        // item hasn't been explicitly reconciled yet, so an attachment bubble
        // that has already landed on the server doesn't linger alongside the
        // real message (see findLikelyServerMessageIdForPendingAttachment).
        const effectiveItem = item.serverMessageId
          ? item
          : (() => {
              const inferred = findLikelyServerMessageIdForPendingAttachment(item);
              return inferred ? { ...item, serverMessageId: inferred } : item;
            })();
        return (
          <ChatPendingAttachments
            key={tempId}
            tempId={tempId}
            item={effectiveItem}
            selectedTeamMemberId={selectedTeamMember.id}
            deliveredMessageIds={deliveredMessageIds}
            normalizeMessageId={normalizeMessageId}
            getPendingRowAnimation={getPendingRowAnimation}
            buildChatPendingRowAnimationKey={buildChatPendingRowAnimationKey}
            isOffline={isOffline}
            CHAT_REPLY_PREVIEW_MAX_CHARS={CHAT_REPLY_PREVIEW_MAX_CHARS}
            resolveChatReplyPreviewText={resolveChatReplyPreviewText}
            resolveChatReplySenderLabel={resolveChatReplySenderLabel}
            jumpToReplyMessage={jumpToReplyMessage}
            getRetryPendingAttachmentPressHandler={getRetryPendingAttachmentPressHandler}
            getCancelPendingAttachmentPressHandler={getCancelPendingAttachmentPressHandler}
            formatFileSize={formatFileSize}
            PendingUploadProgressBar={PendingUploadProgressBar}
            inlineConversationSearchHighlightQuery={inlineConversationSearchHighlightQuery}
            theme={theme}
            themedStyles={themedStyles}
            styles={styles}
          />
        );
      })}

      {/* Typing indicator */}
      {isTyping && selectedTeamMember && (
        <View style={[styles.messageContainer, styles.friendMessage, styles.typingIndicator]}>
          <View
            style={[
              styles.messageBubble,
              styles.friendBubble,
              styles.typingBubble,
              { backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border },
            ]}
          >
            <AnimatedTypingIndicator color={theme.textSecondary} />
          </View>
        </View>
      )}

      {/* Add extra padding at bottom to ensure typing indicator is visible */}
      <View style={styles.height20} />
    </View>
  );

  const renderChatListEmptyComponent = () => {
    const hasPending =
      pendingConversationDerived.mediaEntries.length > 0 ||
      pendingConversationDerived.messageEntries.length > 0 ||
      pendingConversationDerived.attachmentEntries.length > 0;
    const hasLoadError = Boolean(error);
    const shouldDeferEmptyState =
      loading ||
      loadingMore ||
      !selectedTeamMember ||
      hasMore ||
      hasLoadError;

    if (hasPending || shouldDeferEmptyState) {
      if (selectedTeamMember && hasLoadError) {
        if (showReconnectFallback) {
          return (
            <View style={styles.emptyState}>
              <View style={[styles.reconnectCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                <Text style={[styles.reconnectTitle, { color: theme.text }]}>Could not load messages</Text>
                <Text style={[styles.reconnectSubtext, { color: theme.textSecondary }]}> 
                  {isOffline
                    ? "You're offline right now. Reconnect to the internet, then try again."
                    : 'Please check your connection and try reconnecting.'}
                </Text>
                <TouchableOpacity
                  onPress={handleManualReconnect}
                  activeOpacity={0.85}
                  style={[styles.reconnectButton, { backgroundColor: theme.primary }]}
                >
                  <Text style={styles.reconnectButtonText}>Reconnect</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }
        return (
          <View style={styles.emptyState}>
            <ActivityIndicator color={theme.primary} size="small" />
            <Text style={[styles.reconnectHintText, { color: theme.textSecondary }]}>Trying to reconnect…</Text>
          </View>
        );
      }
      return null;
    }

    const emptyStateTitle = selectedTeamMember ? 'No messages yet' : 'Select a team member';
    const safeConversationName = selectedTeamMember
      ? sanitizeMessageText(
          typeof selectedTeamMember.name === 'string' ? selectedTeamMember.name : '',
          'someone'
        ).trim()
      : '';
    const emptyStateSubtext = selectedTeamMember
      ? `Start a conversation with ${safeConversationName || 'someone'}!`
      : 'Choose a team member from the list to start chatting';

    return (
      <View style={styles.emptyState}>
        <Text style={[styles.emptyStateText, { color: theme.text }]}> 
          {emptyStateTitle}
        </Text>
        <Text style={[styles.emptyStateSubtext, { color: theme.textSecondary }]}> 
          {emptyStateSubtext}
        </Text>
      </View>
    );
  };

  messageListScrollHandlerRef.current = handleMessageListScroll;
  messageListContentSizeHandlerRef.current = handleMessageListContentSizeChange;
  messageListLayoutHandlerRef.current = handleMessageListLayout;
  messageListHeaderRendererRef.current = chatListHeaderComponent;
  messageListFooterRendererRef.current = chatListFooterComponent;
  messageListEmptyRendererRef.current = renderChatListEmptyComponent;

  const listOnViewableItemsChanged = onViewableItemsChangedRef.current;
  const listViewabilityConfig = viewabilityConfigRef.current;

  const chatMessagesListPaneProps: ChatMessagesListPaneProps = {
    stickyDateVisible,
    stickyDateText,
    sanitizeDateSeparatorLabel,
    theme,
    isInitialAnchorSettled,
    flatListRef,
    listKey: String(selectedTeamMember?.id || selectedTeamMember?.email || 'chat'),
    displayedMessages,
    estimatedItemSize,
    getMessageKey,
    estimatedListSize,
    listDrawDistance,
    onViewableItemsChanged: listOnViewableItemsChanged,
    viewabilityConfig: listViewabilityConfig,
    getMessageItemType,
    overrideMessageLayout,
    renderMessageItem,
    listExtraData,
    messagesContentContainerStyle,
    onMessageListScroll: handleMessageListScrollStable,
    onMessageListContentSizeChange: handleMessageListContentSizeChangeStable,
    onMessageListLayout: handleMessageListLayoutStable,
    maintainVisibleContentPositionConfig,
    renderChatListHeader: renderMessageListHeaderStable,
    renderChatListFooter: renderMessageListFooterStable,
    renderChatListEmpty: renderMessageListEmptyStable,
  };

  const chatScrollToBottomButtonProps: ChatScrollToBottomButtonProps = {
    showScrollToBottom,
    handleScrollToBottomPress,
    scrollToBottomButtonStyle,
    showReplyJumpToLatest,
    unseenCount,
    unseenCountBadgeStyle,
    theme,
  };

  const hasConversationSearchMatches = conversationSearchMatchIds.length > 0;

  // Keep this as a plain object because this section is after conditional returns.
  const chatReactiveContextValue: ChatReactiveContextValue = {
    effectiveUser,
    selectedTeamMember,
    teamMembersByEmail,
    theme,
    themedStyles,
    isDarkMode,
    isFocused,
    isOffline,
    animatedMessages,
    globalAnimatedMessages,
    editingMessageInfo,
    replyJumpHighlightMessageId,
    conversationSearchHighlightMessageId,
    inlineConversationSearchHighlightQuery,
    brokenFileUrls,
    networkErrorUrls,
    stickerUrlMap,
    gifUrlMap,
  };

  const showConversationSearchLoading =
    isConversationSearchHistoryLoading &&
    normalizedConversationSearchQuery.length > 0 &&
    !hasConversationSearchMatches;
  const showConversationSearchNavControls =
    normalizedConversationSearchQuery.length > 0 || showConversationSearchLoading;
  const showConversationSearchTipsButton =
    showKeyboardShortcuts && !showConversationSearchNavControls;
  const conversationSearchScopeSuggestions = resolveChatConversationSearchScopeSuggestions(
    conversationSearchScopeMatchCounts,
    conversationSearchScope,
    3
  );
  const conversationSearchBestScopeSuggestion = resolveChatConversationSearchBestScopeSuggestion(
    conversationSearchScopeMatchCounts,
    conversationSearchScope
  );
  const conversationSearchBestScopeHintLabel = (() => {
    if (!conversationSearchBestScopeSuggestion) {
      return '';
    }

    const scopeLabel = CONVERSATION_SEARCH_SCOPE_LABELS[conversationSearchBestScopeSuggestion.scope];
    if (!scopeLabel) {
      return '';
    }

    return `Most matches: ${scopeLabel} (${conversationSearchBestScopeSuggestion.count})`;
  })();
  const conversationSearchKeyboardSuggestionHintLabel = (() => {
    if (!showKeyboardShortcuts) {
      return '';
    }
    if (conversationSearchKeyboardSuggestionScope == null) {
      return '';
    }

    const keyboardSuggestion = conversationSearchScopeSuggestions.find(
      (suggestion) => suggestion.scope === conversationSearchKeyboardSuggestionScope
    );
    if (!keyboardSuggestion) {
      return '';
    }

    const scopeLabel = CONVERSATION_SEARCH_SCOPE_LABELS[keyboardSuggestion.scope];
    if (!scopeLabel) {
      return '';
    }

    return `Keyboard target: ${scopeLabel} (${keyboardSuggestion.count}). Press Alt+Shift+Enter to apply.`;
  })();
  const showConversationSearchScopeSuggestionActions =
    normalizedConversationSearchQuery.length > 0 &&
    !showConversationSearchLoading &&
    !hasConversationSearchMatches &&
    conversationSearchScopeSuggestions.length > 0;
  const conversationSearchNoMatchesGuidanceLabel = resolveChatConversationSearchNoMatchesGuidance(
    conversationSearchScope,
    conversationSearchScopeMatchCounts
  );
  const showConversationSearchNoMatchesGuidance =
    normalizedConversationSearchQuery.length > 0 &&
    !showConversationSearchLoading &&
    !hasConversationSearchMatches &&
    conversationSearchNoMatchesGuidanceLabel.length > 0;
  const showConversationSearchScopeResetAction =
    normalizedConversationSearchQuery.length > 0 &&
    !showConversationSearchLoading &&
    !hasConversationSearchMatches &&
    conversationSearchScope !== 'all';
  const showConversationSearchClearQueryAction =
    normalizedConversationSearchQuery.length > 0 &&
    !showConversationSearchLoading &&
    !hasConversationSearchMatches;
  const showConversationSearchLoadOlderAction =
    normalizedConversationSearchQuery.length > 0 &&
    !showConversationSearchLoading &&
    !hasConversationSearchMatches &&
    hasMore;
  const conversationSearchNoMatchesLabel = resolveChatConversationSearchNoMatchesLabel(
    conversationSearchScope
  );
  const conversationSearchActiveSnippetMetaLabel = (() => {
    if (!conversationSearchActiveSnippet) {
      return '';
    }

    const activeMessage = getDisplayedMessageById(conversationSearchActiveSnippet.messageId);
    if (!activeMessage) {
      return '';
    }

    const senderEmail = normalizeParticipantEmail(activeMessage?.sender);
    const isOwnMessage =
      Boolean(senderEmail) &&
      Boolean(effectiveUserEmail) &&
      senderEmail === normalizeParticipantEmail(effectiveUserEmail);

    const senderName =
      typeof activeMessage?.senderName === 'string' ? activeMessage.senderName.trim() : '';
    const fallbackPeerName =
      typeof selectedTeamMember?.name === 'string' ? selectedTeamMember.name.trim() : '';
    const senderLabel =
      isOwnMessage
        ? 'You'
        : senderName || fallbackPeerName || senderEmail || 'Participant';

    const formattedTimestamp = formatMessageTimestamp(activeMessage?.timestamp);
    const timestampLabel = typeof formattedTimestamp === 'string' ? formattedTimestamp.trim() : '';
    if (!timestampLabel || timestampLabel.toLowerCase() === 'invalid date') {
      return senderLabel;
    }

    return `${senderLabel} • ${timestampLabel}`;
  })();
  const conversationSearchActiveSnippetTypeLabel = (() => {
    if (!conversationSearchActiveSnippet) {
      return '';
    }

    return resolveChatConversationSearchSnippetTypeLabel(conversationSearchActiveSnippet.matchType);
  })();
  const conversationSearchPreviewStatusLabel = (() => {
    if (!normalizedConversationSearchQuery) {
      return '';
    }

    if (showConversationSearchLoading) {
      return 'Searching older messages...';
    }

    if (!hasConversationSearchMatches) {
      if (hasMore) {
        return `${conversationSearchNoMatchesLabel} Load older messages to continue.`;
      }

      return conversationSearchNoMatchesLabel;
    }

    if (!conversationSearchActiveSnippet) {
      return 'Match found. Preview unavailable for this message.';
    }

    return '';
  })();

  return (
    <ChatContextProvider stable={chatStableContextValue} reactive={chatReactiveContextValue}>
      <KeyboardAvoidingView 
        style={[styles.container, { backgroundColor: theme.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
        {...(Platform.OS === 'web'
          ? ({
              onDragOver: handleChatPageDragOver,
              onDragLeave: handleChatPageDragLeave,
              onDrop: handleChatPageDrop,
            } as any)
          : {})}
      >
      <ChatHeader
        sharedTopPadding={sharedTopPadding}
        effectiveHeaderComp={effectiveHeaderComp}
        handleBackToChatList={handleBackToChatList}
        openChatProfileModal={openChatProfileModal}
        isTyping={isTyping}
        toggleConversationSearch={toggleConversationSearch}
        conversationSearchVisible={conversationSearchVisible}
      />

      {conversationSearchVisible && (
        <View
          style={[
            styles.conversationSearchBar,
            { backgroundColor: theme.surface, borderBottomColor: theme.border },
          ]}
          accessibilityRole="search"
        >
          <View style={styles.conversationSearchTopRow}>
            <View
              style={[
                styles.conversationSearchInputWrap,
                { backgroundColor: theme.background, borderColor: theme.border },
              ]}
            >
              <Search size={16} color={theme.textSecondary} />
              <TextInput
                ref={conversationSearchInputRef}
                style={[styles.conversationSearchInput, { color: theme.text }]}
                placeholder="Search in conversation..."
                placeholderTextColor={theme.textSecondary}
                value={conversationSearchQuery}
                onChangeText={handleConversationSearchQueryChange}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
                onKeyPress={handleConversationSearchInputKeyPress}
                onSubmitEditing={Platform.OS === 'web' ? undefined : handleConversationSearchNext}
              />
              {conversationSearchQuery.trim().length > 0 && (
                <TouchableOpacity
                  style={styles.conversationSearchClearButton}
                  onPress={() => handleConversationSearchQueryChange('')}
                  accessibilityRole="button"
                  accessibilityLabel="Clear conversation search query"
                >
                  <X size={14} color={theme.textSecondary} />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.conversationSearchActions}>
              {showConversationSearchTipsButton ? (
                <TouchableOpacity
                  onPress={openSearchShortcutTipsModal}
                  style={[
                    styles.conversationSearchTipsButton,
                    { backgroundColor: theme.background, borderColor: theme.border },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Show search shortcut tips"
                >
                  <Info size={14} color={theme.textSecondary} />
                  <Text style={[styles.conversationSearchTipsButtonText, { color: theme.textSecondary }]}>
                    Shortcuts
                  </Text>
                </TouchableOpacity>
              ) : (
                <>
                  {showConversationSearchLoading && (
                    <ActivityIndicator size="small" color={theme.primary} style={styles.conversationSearchLoadingIndicator} />
                  )}
                  <Text
                    style={[
                      styles.conversationSearchCounter,
                      { color: hasConversationSearchMatches ? theme.text : theme.textSecondary },
                    ]}
                  >
                    {conversationSearchCounterLabel}
                  </Text>
                  <TouchableOpacity
                    onPress={handleConversationSearchPrevious}
                    disabled={!hasConversationSearchMatches}
                    style={[
                      styles.conversationSearchNavButton,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                        opacity: hasConversationSearchMatches ? 1 : 0.5,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Previous search result"
                  >
                    <View style={styles.rotate180}>
                      <ChevronDown size={14} color={theme.text} />
                    </View>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={handleConversationSearchNext}
                    disabled={!hasConversationSearchMatches}
                    style={[
                      styles.conversationSearchNavButton,
                      {
                        backgroundColor: theme.background,
                        borderColor: theme.border,
                        opacity: hasConversationSearchMatches ? 1 : 0.5,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Next search result"
                  >
                    <ChevronDown size={14} color={theme.text} />
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>

          <View style={styles.conversationSearchScopeRow}>
            {CONVERSATION_SEARCH_SCOPE_OPTIONS.map((scopeOption) => {
              const isSelected = conversationSearchScope === scopeOption.key;
              const isShortcutPulseActive =
                conversationSearchShortcutPulseScope === scopeOption.key;
              const scopeShortcutKey = CONVERSATION_SEARCH_SCOPE_SHORTCUT_LABELS[scopeOption.key];
              const scopeMatchCount = conversationSearchScopeMatchCounts[scopeOption.key] || 0;
              const shouldDimScopeChip =
                normalizedConversationSearchQuery.length > 0 &&
                scopeMatchCount <= 0 &&
                !isSelected;
              const scopeChipLabel = normalizedConversationSearchQuery
                ? `${scopeOption.label} (${scopeMatchCount})`
                : scopeOption.label;

              return (
                <TouchableOpacity
                  key={scopeOption.key}
                  onPress={() => handleConversationSearchScopeChange(scopeOption.key, 'scope-chip')}
                  style={[
                    styles.conversationSearchScopeChip,
                    {
                      backgroundColor: isShortcutPulseActive
                        ? isDarkMode
                          ? 'rgba(59, 130, 246, 0.3)'
                          : 'rgba(59, 130, 246, 0.18)'
                        : isSelected
                        ? isDarkMode
                          ? 'rgba(59, 130, 246, 0.22)'
                          : 'rgba(59, 130, 246, 0.12)'
                        : theme.background,
                      borderColor:
                        isSelected || isShortcutPulseActive ? theme.primary : theme.border,
                      opacity: shouldDimScopeChip ? 0.56 : 1,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    showKeyboardShortcuts
                      ? normalizedConversationSearchQuery
                        ? `Filter search by ${scopeOption.label}, ${scopeMatchCount} matches, shortcut Alt+Shift+${scopeShortcutKey}`
                        : `Filter search by ${scopeOption.label}, shortcut Alt+Shift+${scopeShortcutKey}`
                      : normalizedConversationSearchQuery
                        ? `Filter search by ${scopeOption.label}, ${scopeMatchCount} matches`
                        : `Filter search by ${scopeOption.label}`
                  }
                  accessibilityState={{ selected: isSelected }}
                >
                  <View style={styles.conversationSearchScopeChipContent}>
                    <Text
                      allowFontScaling={false}
                      style={[
                        styles.conversationSearchScopeChipText,
                        { color: isSelected ? theme.primary : theme.textSecondary },
                      ]}
                    >
                      {scopeChipLabel}
                    </Text>
                    {showKeyboardShortcuts ? (
                      <View
                        style={[
                          styles.conversationSearchScopeChipShortcutBadge,
                          {
                            borderColor: isSelected
                              ? theme.primary
                              : isDarkMode
                                ? 'rgba(148, 163, 184, 0.45)'
                                : 'rgba(100, 116, 139, 0.35)',
                            backgroundColor: isSelected
                              ? isDarkMode
                                ? 'rgba(59, 130, 246, 0.25)'
                                : 'rgba(59, 130, 246, 0.14)'
                              : theme.background,
                          },
                        ]}
                      >
                        <Text
                          allowFontScaling={false}
                          style={[
                            styles.conversationSearchScopeChipShortcutBadgeText,
                            { color: isSelected ? theme.primary : theme.textSecondary },
                          ]}
                        >
                          {scopeShortcutKey}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          {normalizedConversationSearchQuery.length > 0 && (
            <View style={styles.conversationSearchSnippetRow}>
              {conversationSearchActiveSnippet ? (
                <TouchableOpacity
                  style={styles.conversationSearchSnippetPressArea}
                  onPress={handleConversationSearchSnippetPress}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel="Jump to current search result"
                >
                  {(conversationSearchActiveSnippetTypeLabel || conversationSearchActiveSnippetMetaLabel) ? (
                    <View style={styles.conversationSearchSnippetMetaRow}>
                      {conversationSearchActiveSnippetTypeLabel ? (
                        <View
                          style={[
                            styles.conversationSearchSnippetTypeBadge,
                            {
                              backgroundColor: isDarkMode
                                ? 'rgba(59, 130, 246, 0.25)'
                                : 'rgba(59, 130, 246, 0.14)',
                              borderColor: isDarkMode
                                ? 'rgba(147, 197, 253, 0.35)'
                                : 'rgba(59, 130, 246, 0.24)',
                            },
                          ]}
                        >
                          <Text
                            allowFontScaling={false}
                            numberOfLines={1}
                            style={[styles.conversationSearchSnippetTypeBadgeText, { color: theme.primary }]}
                          >
                            {conversationSearchActiveSnippetTypeLabel}
                          </Text>
                        </View>
                      ) : null}
                      {conversationSearchActiveSnippetMetaLabel ? (
                        <Text
                          allowFontScaling={false}
                          numberOfLines={1}
                          style={[styles.conversationSearchSnippetMeta, { color: theme.textSecondary }]}
                        >
                          {conversationSearchActiveSnippetMetaLabel}
                        </Text>
                      ) : null}
                    </View>
                  ) : null}
                  <Text
                    allowFontScaling={false}
                    numberOfLines={1}
                    style={[styles.conversationSearchSnippetText, { color: theme.textSecondary }]}
                  >
                    {conversationSearchActiveSnippet.beforeText}
                    <Text
                      style={[
                        styles.conversationSearchSnippetMatch,
                        {
                          color: theme.text,
                          backgroundColor: isDarkMode
                            ? 'rgba(96, 165, 250, 0.3)'
                            : 'rgba(59, 130, 246, 0.2)',
                        },
                      ]}
                    >
                      {conversationSearchActiveSnippet.matchText}
                    </Text>
                    {conversationSearchActiveSnippet.afterText}
                  </Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.conversationSearchSnippetStatusContainer}>
                  <View style={styles.conversationSearchSnippetStatusRow}>
                    <Text
                      allowFontScaling={false}
                      numberOfLines={1}
                      style={[styles.conversationSearchSnippetStatus, { color: theme.textSecondary }]}
                    >
                      {conversationSearchPreviewStatusLabel}
                    </Text>
                    {showConversationSearchScopeResetAction ? (
                      <TouchableOpacity
                        onPress={() => handleConversationSearchResetScope('reset-button')}
                        style={[
                          styles.conversationSearchSnippetResetScopeButton,
                          {
                            borderColor: isDarkMode
                              ? 'rgba(96, 165, 250, 0.45)'
                              : 'rgba(59, 130, 246, 0.35)',
                            backgroundColor: isDarkMode
                              ? 'rgba(59, 130, 246, 0.18)'
                              : 'rgba(59, 130, 246, 0.1)',
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Switch search filter to All"
                      >
                        <Text
                          allowFontScaling={false}
                          style={[
                            styles.conversationSearchSnippetResetScopeButtonText,
                            { color: theme.primary },
                          ]}
                        >
                          Switch to All
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {showConversationSearchLoadOlderAction ? (
                      <TouchableOpacity
                        onPress={() => handleConversationSearchLoadOlder('load-older-button')}
                        style={[
                          styles.conversationSearchSnippetLoadOlderButton,
                          {
                            borderColor: isDarkMode
                              ? 'rgba(147, 197, 253, 0.38)'
                              : 'rgba(59, 130, 246, 0.28)',
                            backgroundColor: isDarkMode
                              ? 'rgba(59, 130, 246, 0.14)'
                              : 'rgba(59, 130, 246, 0.07)',
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Search older messages"
                      >
                        <Text
                          allowFontScaling={false}
                          style={[
                            styles.conversationSearchSnippetLoadOlderButtonText,
                            { color: theme.primary },
                          ]}
                        >
                          Load older
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {showConversationSearchClearQueryAction ? (
                      <TouchableOpacity
                        onPress={() => handleConversationSearchClearQuery('clear-query-button')}
                        style={[
                          styles.conversationSearchSnippetClearQueryButton,
                          {
                            borderColor: isDarkMode
                              ? 'rgba(148, 163, 184, 0.45)'
                              : 'rgba(100, 116, 139, 0.35)',
                            backgroundColor: isDarkMode
                              ? 'rgba(71, 85, 105, 0.22)'
                              : 'rgba(148, 163, 184, 0.16)',
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Clear conversation search query"
                      >
                        <Text
                          allowFontScaling={false}
                          style={[
                            styles.conversationSearchSnippetClearQueryButtonText,
                            { color: theme.textSecondary },
                          ]}
                        >
                          Clear query
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  {showConversationSearchNoMatchesGuidance ? (
                    <Text
                      allowFontScaling={false}
                      style={[
                        styles.conversationSearchNoMatchesGuidance,
                        { color: theme.textSecondary },
                      ]}
                    >
                      {conversationSearchNoMatchesGuidanceLabel}
                    </Text>
                  ) : null}
                  {showConversationSearchScopeSuggestionActions ? (
                    <View style={styles.conversationSearchScopeSuggestionsRow}>
                      {conversationSearchBestScopeHintLabel ? (
                        <Text
                          allowFontScaling={false}
                          style={[
                            styles.conversationSearchScopeSuggestionHint,
                            { color: theme.textSecondary },
                          ]}
                        >
                          {conversationSearchBestScopeHintLabel}
                        </Text>
                      ) : null}
                      {conversationSearchKeyboardSuggestionHintLabel ? (
                        <Text
                          allowFontScaling={false}
                          style={[
                            styles.conversationSearchScopeSuggestionKeyboardHint,
                            { color: theme.textSecondary },
                          ]}
                        >
                          {conversationSearchKeyboardSuggestionHintLabel}
                        </Text>
                      ) : null}
                      {conversationSearchScopeSuggestions.map((suggestion, suggestionIndex) => {
                        const suggestionScopeLabel = CONVERSATION_SEARCH_SCOPE_LABELS[suggestion.scope];
                        const isKeyboardSuggestionActive =
                          conversationSearchKeyboardSuggestionScope === suggestion.scope;
                        const suggestionShortcutOrdinal = suggestionIndex + 1;
                        const suggestionChipLabel = showKeyboardShortcuts
                          ? `${suggestionShortcutOrdinal}. ${suggestionScopeLabel} (${suggestion.count})`
                          : `${suggestionScopeLabel} (${suggestion.count})`;

                        return (
                          <TouchableOpacity
                            key={`search-scope-suggestion-${suggestion.scope}`}
                            onPress={() => handleConversationSearchScopeChange(suggestion.scope, 'suggestion-chip')}
                            style={[
                              styles.conversationSearchScopeSuggestionChip,
                              {
                                borderColor: isKeyboardSuggestionActive
                                  ? theme.primary
                                  : isDarkMode
                                    ? 'rgba(147, 197, 253, 0.38)'
                                    : 'rgba(59, 130, 246, 0.28)',
                                backgroundColor: isKeyboardSuggestionActive
                                  ? isDarkMode
                                    ? 'rgba(59, 130, 246, 0.26)'
                                    : 'rgba(59, 130, 246, 0.16)'
                                  : isDarkMode
                                    ? 'rgba(59, 130, 246, 0.14)'
                                    : 'rgba(59, 130, 246, 0.07)',
                              },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel={
                              showKeyboardShortcuts
                                ? `Try ${suggestionScopeLabel} filter, ${suggestion.count} matches, shortcut Alt+Shift+${suggestionShortcutOrdinal}`
                                : `Try ${suggestionScopeLabel} filter, ${suggestion.count} matches`
                            }
                          >
                            <Text
                              allowFontScaling={false}
                              style={[
                                styles.conversationSearchScopeSuggestionChipText,
                                {
                                  color: isKeyboardSuggestionActive ? theme.text : theme.primary,
                                },
                              ]}
                            >
                              {suggestionChipLabel}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              )}
            </View>
          )}
        </View>
      )}

      {/* Messages */}
      <ChatMessagesListShell
        listPaneProps={chatMessagesListPaneProps}
        scrollButtonProps={chatScrollToBottomButtonProps}
      />

      {/* Special Command Suggestion */}
      {Platform.OS === 'web' && showSpecialCommand && (
        <View style={[styles.commandSuggestion, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <TouchableOpacity 
            style={[styles.commandOption, { backgroundColor: theme.background }]}
            onPress={handleSpecialCommandSelect}
          >
            <Star size={20} color={theme.warning} />
            <View style={styles.commandOptionText}>
              <Text style={[styles.commandOptionTitle, { color: theme.text }]}>Send Special Message</Text>
              <Text style={[styles.commandOptionDescription, { color: theme.textSecondary }]}>
                Send a highlighted message with special styling
              </Text>
            </View>
            <View style={[styles.commandBadge, { backgroundColor: theme.warning }]}>
              <Text style={styles.commandBadgeText}>⭐</Text>
            </View>
          </TouchableOpacity>
        </View>
      )}

      {/* Special Message Indicator */}
      {isComposingSpecial && (
        <View style={[styles.specialIndicator, { backgroundColor: theme.warning }]}>
          <Star size={16} color="#ffffff" />
          <Text style={styles.specialIndicatorText}>Composing Special Message</Text>
          <TouchableOpacity 
            onPress={handleSpecialIndicatorClose}
            style={styles.specialIndicatorClose}
          >
            <X size={16} color="#ffffff" />
          </TouchableOpacity>
        </View>
      )}

      <ChatComposer
        theme={theme}
        isDarkMode={isDarkMode}
        selectedTeamMember={selectedTeamMember}
        isOffline={isOffline}
        message={message}
        handleTyping={handleTyping}
        handleSendMessage={handleSendMessage}
        isSendingMessage={isSendingMessage}
        canAttemptSend={canAttemptSend}
        appendFormattingText={appendFormattingText}
        showFormattingGuide={showFormattingGuide}
        toggleFormattingGuide={toggleFormattingGuide}
        hideFormattingGuide={hideFormattingGuide}
        retryAllPendingCount={retryAllPendingCount}
        isRetryingAllPending={isRetryingAllPending}
        handleRetryAllPendingPress={handleRetryAllPendingPress}
        isCancelingAllPending={isCancelingAllPending}
        handleCancelAllPendingPress={handleCancelAllPendingPress}
        replyingToMessage={replyingToMessage}
        replyingSenderLabel={replyingSenderLabel}
        replyingPreviewText={replyingPreviewText}
        cancelReplyingToMessage={cancelReplyingToMessage}
        editingMessageInfo={editingMessageInfo}
        editingPreviewText={editingPreviewText}
        cancelEditingMessage={cancelEditingMessage}
        handleEditLastOwnMessageShortcut={handleEditLastOwnMessageShortcut}
        mobileInputRef={mobileInputRef}
        onKeyboardMedia={handleKeyboardMedia}
        openAttachmentModal={openAttachmentModal}
        openStickerGifPicker={openStickerGifPicker}
        isComposingSpecial={isComposingSpecial}
        setInputHeight={setInputHeight}
        handleComposerBlur={handleComposerBlur}
        getComposerPlaceholder={getComposerPlaceholder}
        showInputLimitCounter={showInputLimitCounter}
        messageCharacterCount={messageCharacterCount}
        messageWordCount={messageWordCount}
        isChatDropActive={isChatDropActive}
      />

      {/* Modals */}
      <ChatAttachmentModal
        visible={attachmentModalVisible}
        onClose={closeAttachmentModal}
        onSelectImage={handleSelectImageAttachment}
        onSelectCamera={handleSelectCameraAttachment}
        onSelectVideo={handleSelectVideoAttachment}
        onSelectVideoCamera={handleSelectVideoCameraAttachment}
        onSelectDocument={handleSelectDocumentAttachment}
        theme={theme}
      />
      <ChatFilePreviewModal
        visible={filePreviewVisible}
        onClose={resetFilePreviewModal}
        selectedFiles={selectedFiles}
        skippedPreviewFiles={skippedPreviewFiles}
        groupedSkippedPreviewFiles={groupedSkippedPreviewFiles}
        message={message}
        onTyping={handleTyping}
        isUploading={isUploading}
        easedUploadProgress={easedUploadProgress}
        onSendWithFiles={handleSendWithFiles}
        onRemoveFile={getRemoveSelectedFilePressHandler}
        theme={theme}
      />
      <ChatImageViewerModal
        visible={imageViewerVisible}
        onClose={closeImageViewer}
        selectedImageUri={selectedImageUri}
        lastViewedRemoteImage={lastViewedRemoteImage}
        brokenFileUrls={brokenFileUrls}
        networkErrorUrls={networkErrorUrls}
        onImageError={handleImageError}
        onClearNetworkError={clearNetworkError}
        onSetSelectedImageUri={setSelectedImageUri}
        onDownloadFile={handleDownloadFile}
        getDownloadKey={getDownloadKey}
        showImageShareModal={showImageShareModal}
        onOpenImageShareModal={openImageShareModal}
        onCloseImageShareModal={closeImageShareModal}
      />
        {renderMessageInfoModal()}
  {renderEmojiPickerModal()}

      <ConfirmationModal
        visible={deleteConfirmState.visible}
        onClose={() => setDeleteConfirmState({ visible: false, message: null })}
        title="Delete message?"
        message="This will remove the message for everyone in the conversation."
        confirmText={isDeletePending ? 'Deleting…' : 'Delete'}
        cancelText="Cancel"
        confirmStyle="destructive"
        confirmDisabled={isDeletePending}
        confirmLoading={isDeletePending}
        cancelDisabled={isDeletePending}
        autoCloseOnConfirm={false}
        statusMessage={deleteConfirmationPreview || undefined}
        statusType="error"
        icon={<Trash2 size={28} color={theme.error} />}
        onConfirm={handleDeleteConfirm}
      />

  {/* Sticker and GIF Picker (Mobile) */}
  <StickerGifPickerMobile
    visible={stickerGifPickerVisible}
    onClose={closeStickerGifPicker}
    onSelectSticker={handleStickerSelect}
    onSelectGif={handleGifSelect}
  />
      
      {/* Chat Profile Modal */}
      <ChatProfileModal
        visible={chatProfileModalVisible}
        onClose={closeChatProfileModal}
        teamMember={selectedTeamMember}
        theme={theme}
      />

      {showKeyboardShortcuts ? (
        <Modal
          visible={showSearchShortcutTipsModal}
          transparent
          animationType="fade"
          onRequestClose={closeSearchShortcutTipsModal}
        >
          <Pressable
            style={styles.searchShortcutTipsOverlay}
            onPress={closeSearchShortcutTipsModal}
          >
            <Pressable
              onPress={() => undefined}
              style={[
                styles.searchShortcutTipsCard,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <View style={styles.searchShortcutTipsHeader}>
                <View>
                  <Text style={[styles.searchShortcutTipsTitle, { color: theme.text }]}>Search shortcuts</Text>
                  <Text style={[styles.searchShortcutTipsSubtitle, { color: theme.textSecondary }]}>Web only</Text>
                </View>
                <TouchableOpacity
                  onPress={closeSearchShortcutTipsModal}
                  style={[styles.searchShortcutTipsCloseButton, { backgroundColor: theme.background }]}
                  accessibilityRole="button"
                  accessibilityLabel="Close shortcut tips"
                >
                  <X size={18} color={theme.text} />
                </TouchableOpacity>
              </View>

              <View style={styles.searchShortcutTipsSection}>
                <Text style={[styles.searchShortcutTipsSectionTitle, { color: theme.text }]}>Find & Navigate</Text>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Cmd/Ctrl + F</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Open search</Text>
                </View>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Enter</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Next match</Text>
                </View>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Shift + Enter</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Previous match</Text>
                </View>
              </View>

              <View style={styles.searchShortcutTipsSection}>
                <Text style={[styles.searchShortcutTipsSectionTitle, { color: theme.text }]}>Scopes</Text>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + A/T/F/R/M</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Pick scope</Text>
                </View>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + Up/Down</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Cycle scopes</Text>
                </View>
              </View>

              <View style={styles.searchShortcutTipsSection}>
                <Text style={[styles.searchShortcutTipsSectionTitle, { color: theme.text }]}>Suggestions</Text>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + Left/Right</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Cycle suggestions</Text>
                </View>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + 1/2/3</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Pick suggestion</Text>
                </View>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + Enter</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Apply suggestion</Text>
                </View>
              </View>

              <View style={styles.searchShortcutTipsSection}>
                <Text style={[styles.searchShortcutTipsSectionTitle, { color: theme.text }]}>Other</Text>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + L</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Load older</Text>
                </View>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + X</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Clear query</Text>
                </View>
                <View style={styles.searchShortcutTipsRow}>
                  <Text style={[styles.searchShortcutTipsKey, { color: theme.text }]}>Alt + Shift + 0 / Backspace</Text>
                  <Text style={[styles.searchShortcutTipsValue, { color: theme.textSecondary }]}>Reset all</Text>
                </View>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}

      {selectedTeamMember && !isChatBootstrapGateDone && (
        <View style={[styles.loadingOverlay, { backgroundColor: theme.background, pointerEvents: 'auto', zIndex: 40 }]}> 
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary, marginTop: 16 }]}>Loading conversation…</Text>
          {showChatOpenHangActions && (
            <Text style={[styles.reconnectSubtext, { color: theme.textSecondary, marginTop: 10, textAlign: 'center', maxWidth: 360 }]}>Hang on, connection is slow</Text>
          )}
        </View>
      )}

      </KeyboardAvoidingView>
    </ChatContextProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  // ── Layout utilities (eliminates recurring inline object allocations) ──
  alignItemsCenter: { alignItems: 'center' as const },
  alignSelfEnd: { alignSelf: 'flex-end' as const },
  alignSelfStart: { alignSelf: 'flex-start' as const },
  flexRow: { flexDirection: 'row' as const },
  flexRowCenter: { flexDirection: 'row' as const, alignItems: 'center' as const },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  errorText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  
  // User List View Styles
  headerTitle: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
  },
  headerButton: {
    padding: 8,
  },
  userListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  userHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  userStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  userListArrow: {
    marginLeft: 'auto',
    paddingLeft: 16,
  },
  adminBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
    marginLeft: 8,
  },
  adminBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter-Bold',
  },
  
  // Chat View Styles
  backButton: {
    padding: 8,
    marginRight: 12,
  },
  
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  friendInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: 24,
  },
  avatarText: {
    fontSize: 16,
    fontFamily: 'Poppins-Bold',
    color: '#ffffff',
  },
  friendNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  friendName: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  friendStatus: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  moreButton: {
    padding: 8,
  },
  messagesContainer: {
    flex: 1,
    minHeight: 8,
    width: '100%',
    alignSelf: 'stretch',
  },
  messagesContainerHidden: {
    opacity: 0,
  },
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: Platform.OS === 'web' ? 8 : 6,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 12,
  },
  searchInput: {
    flex: 1,
    marginLeft: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    paddingVertical: Platform.OS === 'ios' ? 0 : 2,
    height: Platform.OS === 'ios' ? 28 : 34,
  },
  conversationSearchBar: {
    alignItems: 'stretch',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  conversationSearchTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
  },
  conversationSearchInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    minHeight: 38,
  },
  conversationSearchInput: {
    flex: 1,
    marginLeft: 8,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    paddingVertical: Platform.OS === 'ios' ? 0 : 2,
    height: Platform.OS === 'ios' ? 28 : 32,
  },
  conversationSearchClearButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    marginLeft: 6,
  },
  conversationSearchActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 10,
  },
  conversationSearchTipsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  conversationSearchTipsButtonText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 6,
  },
  conversationSearchLoadingIndicator: {
    marginRight: 6,
  },
  conversationSearchCounter: {
    minWidth: 38,
    textAlign: 'center',
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginRight: 4,
  },
  conversationSearchNavButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  conversationSearchScopeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
    marginHorizontal: -2,
  },
  conversationSearchScopeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    marginHorizontal: 2,
    marginBottom: 4,
  },
  conversationSearchScopeChipContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  conversationSearchScopeChipText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  conversationSearchScopeChipShortcutBadge: {
    marginLeft: 6,
    borderWidth: 1,
    borderRadius: 999,
    minWidth: 17,
    paddingHorizontal: 4,
    paddingVertical: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conversationSearchScopeChipShortcutBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter-Bold',
    lineHeight: 12,
  },
  conversationSearchSnippetRow: {
    marginTop: 5,
    paddingHorizontal: 2,
  },
  searchShortcutTipsOverlay: {
    flex: 1,
    backgroundColor: 'rgba(8, 12, 22, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  searchShortcutTipsCard: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    ...(Platform.OS === 'web'
      ? ({ boxShadow: '0 18px 30px rgba(10, 10, 15, 0.28)' } as any)
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 10 },
          shadowOpacity: 0.25,
          shadowRadius: 18,
          elevation: 12,
        }),
  },
  searchShortcutTipsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  searchShortcutTipsTitle: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
  },
  searchShortcutTipsSubtitle: {
    marginTop: 2,
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },
  searchShortcutTipsCloseButton: {
    borderRadius: 16,
    padding: 8,
  },
  searchShortcutTipsSection: {
    marginTop: 10,
  },
  searchShortcutTipsSectionTitle: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 6,
  },
  searchShortcutTipsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  searchShortcutTipsKey: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  searchShortcutTipsValue: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 12,
    textAlign: 'right',
    flex: 1,
  },
  conversationSearchSnippetPressArea: {
    paddingVertical: 1,
  },
  conversationSearchSnippetStatusContainer: {
    width: '100%',
  },
  conversationSearchSnippetStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  conversationSearchNoMatchesGuidance: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
    marginTop: 6,
  },
  conversationSearchScopeSuggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 6,
  },
  conversationSearchScopeSuggestionHint: {
    width: '100%',
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  conversationSearchScopeSuggestionKeyboardHint: {
    width: '100%',
    fontSize: 10,
    fontFamily: 'Inter-Medium',
    marginBottom: 4,
  },
  conversationSearchScopeSuggestionChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 6,
    marginBottom: 4,
  },
  conversationSearchScopeSuggestionChipText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  conversationSearchSnippetMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  conversationSearchSnippetTypeBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
    marginRight: 6,
  },
  conversationSearchSnippetTypeBadgeText: {
    fontSize: 10,
    fontFamily: 'Inter-SemiBold',
  },
  conversationSearchSnippetMeta: {
    flexShrink: 1,
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  conversationSearchSnippetText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  conversationSearchSnippetStatus: {
    flex: 1,
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  conversationSearchSnippetResetScopeButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  conversationSearchSnippetResetScopeButtonText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  conversationSearchSnippetLoadOlderButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 6,
  },
  conversationSearchSnippetLoadOlderButtonText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  conversationSearchSnippetClearQueryButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 6,
  },
  conversationSearchSnippetClearQueryButtonText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  conversationSearchSnippetMatch: {
    fontFamily: 'Inter-SemiBold',
  },
  messagesContent: {
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  messageListItemWithGutter: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  messageListItemContent: {
    flex: 1,
  },
  conversationSearchResultGutter: {
    width: 16,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  conversationSearchResultGutterRail: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: 2,
    borderRadius: 999,
  },
  conversationSearchResultMarkerButton: {
    width: 14,
    height: 14,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  conversationSearchResultMarkerDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
  },
  messageContainer: {
    marginBottom: 16,
  },
  ownMessage: {
    alignItems: 'flex-end',
  },
  friendMessage: {
    alignItems: 'flex-start',
  },
  messageBubble: {
    maxWidth: '80%',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
  },
  messageActionAnchor: {
    position: 'relative',
  },
  editingMessageGlow: {
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 0 3px rgba(59, 130, 246, 0.2)' }
      : {
          shadowColor: 'rgba(59, 130, 246, 0.7)',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.3,
          shadowRadius: 6,
          elevation: 5,
        }),
  },
  replyJumpHighlightGlow: {
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 0 3px rgba(245, 158, 11, 0.3), 0 10px 22px rgba(245, 158, 11, 0.2)' }
      : {
          shadowColor: 'rgba(245, 158, 11, 0.9)',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.38,
          shadowRadius: 8,
          elevation: 8,
        }),
  },
  messageSearchHighlightGlow: {
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 0 0 2px rgba(59, 130, 246, 0.24), 0 8px 18px rgba(59, 130, 246, 0.16)' }
      : {
          shadowColor: 'rgba(59, 130, 246, 0.85)',
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.26,
          shadowRadius: 7,
          elevation: 7,
        }),
  },
  editingTag: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.5)',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    marginBottom: 8,
  },
  editingTagText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  messagePendingOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 3,
  },
  messagePendingText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 6,
  },
  ownBubble: {
    borderBottomRightRadius: 4,
  },
  friendBubble: {
    borderBottomLeftRadius: 4,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 1,
      },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    }),
  },
  messageText: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    lineHeight: 22,
  },
  ownMessageText: {
    color: '#ffffff',
  },
  searchInlineHighlightOwn: {
    backgroundColor: 'rgba(255, 255, 255, 0.24)',
  },
  friendMessageText: {
    // Color will be set dynamically
  },
  replySnippet: {
    borderLeftWidth: 3,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginBottom: 8,
  },
  replySnippetOwn: {
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
  },
  replySnippetFriend: {
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.2)',
  },
  replySnippetSender: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  replySnippetSenderOwn: {
    color: 'rgba(255, 255, 255, 0.95)',
  },
  replySnippetText: {
    marginTop: 2,
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  replySnippetTextOwn: {
    color: 'rgba(255, 255, 255, 0.85)',
  },
  messageMeta: {
    fontSize: 11,
    fontFamily: 'Inter-Medium',
    marginRight: 6,
  },
  messageMetaOwn: {
    color: 'rgba(255, 255, 255, 0.8)',
  },
  messageMetaFriend: {
    color: 'rgba(110, 118, 129, 1)',
  },
  messageTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  ownMessageTime: {
    color: 'rgba(255, 255, 255, 0.7)',
    textAlign: 'right',
  },
  friendMessageTime: {
    // Color will be set dynamically
  },

  deletedMessageContainer: {
    width: '100%',
  },
  deletedMessageBubble: {
    maxWidth: '75%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderStyle: 'dashed',
    opacity: 0.9,
  },
  deletedMessageBubbleOwn: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.4)',
  },
  deletedMessageBubbleFriend: {
    backgroundColor: 'rgba(229, 231, 235, 0.35)',
    borderColor: 'rgba(148, 163, 184, 0.6)',
  },
  deletedMessageContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  deletedMessageText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  deletedMessageTextOwn: {
    color: 'rgba(255, 255, 255, 0.85)',
  },
  deletedMessageTime: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
    marginTop: 6,
  },
  
  // File attachment styles
  fileContainer: {
    marginBottom: 8,
  },
  attachmentSkeleton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  attachmentSkeletonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  attachmentSkeletonSubtext: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  imageAttachment: {
    width: 200,
    height: 150,
    borderRadius: 12,
  },
  fileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 4,
  },
  deletedFileAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    marginBottom: 4,
    borderWidth: 1,
    borderStyle: 'dashed',
    opacity: 0.6,
  },
  networkErrorAttachment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginTop: 6,
    borderWidth: 1,
    alignSelf: 'stretch',
  },
  networkErrorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  networkErrorText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginLeft: 8,
  },
  networkErrorRetryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    marginLeft: 10,
  },
  networkErrorRetryText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  fileInfo: {
    flex: 1,
    marginLeft: 12,
  },
  fileName: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  fileSize: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  downloadButton: {
    padding: 8,
  },
  usersList: {
    flex: 1,
    paddingTop: 8,
  },
  userItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  userAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  userAvatarImage: {
    width: '100%',
    height: '100%',
    borderRadius: 22,
  },
  userAvatarText: {
    fontSize: 16,
    fontFamily: 'Poppins-Bold',
    color: '#ffffff',
  },
  userInfo: {
    flex: 1,
  },
  userName: {
    fontSize: 16,
    fontFamily: 'Poppins-Medium',
  },
  userEmail: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  roleIndicator: {
    fontSize: 12,
    fontFamily: 'Inter-Bold',
    marginTop: 2,
  },
  userStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  selectedIndicator: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectedText: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Poppins-Bold',
  },
  
  // WhatsApp-style chat list styles
  chatMetaContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lastMessageTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  pinnedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    marginRight: 6,
  },
  pinnedText: {
    fontSize: 11,
    marginLeft: 4,
    fontFamily: 'Inter-Bold',
  },
  lastMessageContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  lastMessageStatus: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginRight: 4,
  },
  lastMessageText: {
    fontSize: 14,
    flex: 1,
  },
  userListRight: {
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadCount: {
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-Bold',
  },

  messageInfoModalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.48)',
  },
  messageInfoModalCard: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: '72%',
  },
  messageInfoModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  messageInfoModalTitle: {
    fontSize: 17,
    fontFamily: 'Poppins-SemiBold',
  },
  messageInfoModalHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageInfoCopyAllButton: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 8,
  },
  messageInfoCopyAllButtonText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 5,
  },
  messageInfoShortcutBadge: {
    marginLeft: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  messageInfoShortcutBadgeText: {
    fontSize: 9,
    fontFamily: 'Inter-Medium',
  },
  messageInfoCloseActionWrap: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageInfoModalCloseButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageInfoHintRow: {
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  messageInfoHintText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  messageInfoCopyFeedbackRow: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageInfoCopyFeedbackText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 8,
  },
  messageInfoCopyFeedbackSourceBadge: {
    marginLeft: 'auto',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  messageInfoCopyFeedbackSourceText: {
    fontSize: 10,
    fontFamily: 'Inter-Medium',
  },
  messageInfoToastNoticeRow: {
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageInfoToastNoticeText: {
    fontSize: 10,
    fontFamily: 'Inter-Regular',
    marginLeft: 7,
  },
  messageInfoBulkActionsRow: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  messageInfoBulkToggleButton: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageInfoBulkToggleButtonText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 6,
  },
  messageInfoShortcutHintRow: {
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  messageInfoShortcutHintText: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },
  messageInfoModalBody: {
    flexGrow: 0,
  },
  messageInfoModalBodyContent: {
    paddingBottom: 14,
  },
  messageInfoRow: {
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  messageInfoRowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  messageInfoRowHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageInfoRowLabel: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    textTransform: 'uppercase',
    letterSpacing: 0.35,
  },
  messageInfoRowBadge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  messageInfoRowBadgeText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  messageInfoRowCopyButton: {
    marginLeft: 8,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageInfoRowCopyButtonText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
    marginLeft: 5,
  },
  messageInfoRowValuePressArea: {
    borderRadius: 8,
    paddingVertical: 2,
  },
  messageInfoRowValue: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 21,
  },
  messageInfoRowToggleButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  messageInfoRowToggleText: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },
  messageInfoEmptyText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  
  
  // Special message styles
  specialMessageContainer: {
    marginBottom: 24,
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  specialMessageBubble: {
    borderRadius: 24,
    padding: 20,
    marginHorizontal: 8,
    borderWidth: 2,
    minWidth: '90%',
    position: 'relative',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 8px 24px rgba(251, 191, 36, 0.3), 0 4px 12px rgba(251, 191, 36, 0.2)'
    } : {
      shadowColor: '#fbbf24',
      shadowOffset: {
        width: 0,
        height: 8,
      },
      shadowOpacity: 0.3,
      shadowRadius: 24,
      elevation: 12,
    }),
  },
  specialMessageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  specialMessageTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-Bold',
    marginHorizontal: 8,
  },
  specialMessageText: {
    fontSize: 20,
    fontFamily: 'Poppins-Medium',
    lineHeight: 30,
    textAlign: 'center',
    marginBottom: 16,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  specialMessageTime: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    marginBottom: 16,
  },
  specialReactions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
  },
  reactionButton: {
    padding: 8,
    borderRadius: 12,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 64,
  },
  reconnectHintText: {
    marginTop: 10,
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  reconnectCard: {
    width: '100%',
    maxWidth: 360,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  reconnectTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 6,
    textAlign: 'center',
  },
  reconnectSubtext: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 12,
  },
  reconnectButton: {
    minHeight: 38,
    borderRadius: 10,
    paddingHorizontal: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reconnectButtonText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
  },
  emptyStateText: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 8,
  },
  emptyStateSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
  },
  emptyUsersList: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
  },
  emptyUsersText: {
    fontSize: 18,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 16,
    marginBottom: 8,
  },
  emptyUsersSubtext: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  inputLimitCounter: {
    paddingHorizontal: 22,
    paddingTop: 2,
    paddingBottom: 6,
    alignItems: 'flex-end',
  },
  inputLimitCounterText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  scrollToBottomLatestLabel: {
    marginLeft: 8,
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  refreshButton: {
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  refreshButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
  },
  typingIndicator: {
    marginTop: 0,
    marginBottom: 0,
  },
  typingBubble: {
    minWidth: 56,
    minHeight: 44,
    justifyContent: 'center',
  },
  typingIndicatorSmall: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  friendStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  friendTypingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  friendTypingText: {
    fontFamily: 'Inter-Medium',
    fontStyle: 'italic',
  },
  pendingMessagesContainer: {
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  retryAllBanner: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  retryAllBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  retryAllBannerText: {
    marginLeft: 8,
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
  retryAllBannerButton: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
  },
  retryAllBannerButtonText: {
    marginLeft: 6,
    color: '#ffffff',
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  replyBannerIcon: {
    marginRight: 10,
  },
  replyBannerCopy: {
    flex: 1,
  },
  replyBannerTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  replyBannerDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  replyBannerClose: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    marginLeft: 12,
  },
  replyBannerCloseText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  editingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  editingBannerIcon: {
    marginRight: 10,
  },
  editingBannerCopy: {
    flex: 1,
  },
  editingBannerTitle: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  editingBannerDescription: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  editingBannerClose: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    marginLeft: 12,
  },
  editingBannerCloseText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    marginLeft: 6,
  },
  
  // New styles for image overlay
  imageOverlay: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    borderRadius: 16,
    padding: 4,
  },
  
  // Date separator styles
  dateSeparatorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    paddingHorizontal: 16,
  },
  dateSeparatorLine: {
    flex: 1,
    height: 1,
    opacity: 0.3,
  },
  dateSeparatorText: {
    fontSize: 13,
    fontFamily: 'Inter-Medium',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
    textAlign: 'center',
    marginHorizontal: 8,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  
  // Messages wrapper
  messagesWrapper: {
    flex: 1,
    position: 'relative',
  },
  chatDropOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000,
    backgroundColor: 'rgba(0, 0, 0, 0.12)',
  },
  chatDropCard: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 14,
    paddingHorizontal: 22,
    paddingVertical: 16,
    minWidth: 260,
    alignItems: 'center',
  },
  chatDropTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginTop: 8,
  },
  chatDropSubtitle: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
  },
  
  // Sticky date header styles
  stickyDateHeader: {
    position: 'absolute',
    top: 8,
    left: 0,
    right: 0,
    zIndex: 1000,
    alignItems: 'center',
  },
  stickyDateContainer: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.15)'
    } : {
      shadowOffset: {
        width: 0,
        height: 2,
      },
      shadowOpacity: 0.15,
      shadowRadius: 4,
    }),
    elevation: 4,
    opacity: 0.92,
    maxWidth: 200,
  },
  stickyDateText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    textAlign: 'center',
  },
  
  // Message footer styles for timestamp and ticks
  messageFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  ownMessageFooter: {
    justifyContent: 'flex-end',
  },
  friendMessageFooter: {
    justifyContent: 'flex-start',
  },
  
  // Special command suggestion styles
  commandSuggestion: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
    borderWidth: 1,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 2,
      },
      shadowOpacity: 0.1,
      shadowRadius: 8,
      elevation: 4,
    }),
  },
  commandOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
  },
  commandOptionText: {
    flex: 1,
    marginLeft: 12,
  },
  commandOptionTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
    marginBottom: 2,
  },
  commandOptionDescription: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    lineHeight: 18,
  },
  commandBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginLeft: 8,
  },
  commandBadgeText: {
    fontSize: 12,
    fontFamily: 'Inter-Bold',
    color: '#ffffff',
  },
  
  // Special message indicator styles
  specialIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 8,
  },
  specialIndicatorText: {
    fontSize: 14,
    fontFamily: 'Poppins-SemiBold',
    color: '#ffffff',
    flex: 1,
    textAlign: 'center',
  },
  specialIndicatorClose: {
    padding: 4,
  },
  
  // Sticker and GIF message styles
  stickerContainer: {
    padding: 8,
    borderRadius: 16,
    backgroundColor: 'transparent',
  // Constrain width like text bubbles so content doesn't span full width
  maxWidth: '80%',
  // Center media/text within the sticker container by default
  alignItems: 'center',
  },
  ownSticker: {
  // Ensure the entire sticker block sits on the right and its inner content aligns right
  alignSelf: 'flex-end',
  alignItems: 'flex-end',
  },
  friendSticker: {
    alignSelf: 'flex-start',
  },
  stickerImage: {
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  stickerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    paddingHorizontal: 4,
  },
  ownStickerFooter: {
    alignSelf: 'flex-end',
  },
  friendStickerFooter: {
    alignSelf: 'flex-start',
  },
  stickerTime: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },
  deletedStickerPlaceholder: {
    width: 120,
    height: 120,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.6,
  },
  deletedStickerText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
    textAlign: 'center',
  },
  emojiStickerContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
    minHeight: 80,
    borderRadius: 12,
    backgroundColor: 'transparent',
  },
  emojiStickerText: {
    fontFamily: Platform.OS === 'ios' ? 'AppleColorEmoji' : 'NotoColorEmoji',
    textAlign: 'center',
    lineHeight: undefined, // Let the system handle emoji line height
  },
  
  // Formatting guide styles
  formattingGuide: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  formattingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  formattingTitle: {
    fontSize: 16,
    fontFamily: 'Poppins-SemiBold',
  },
  formattingOptions: {
    gap: 8,
  },
  quickFormatButtons: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    justifyContent: 'center',
  },
  quickFormatButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.1)',
  },
  quickFormatButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  formattingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  formattingExample: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  formattingResult: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  // Reaction system styles
  glowingReaction: {
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 20px rgba(59, 130, 246, 0.8), 0 0 40px rgba(59, 130, 246, 0.4)'
    } : {
      shadowColor: '#3b82f6',
      shadowOffset: {
        width: 0,
        height: 0,
      },
      shadowOpacity: 0.8,
      shadowRadius: 10,
      elevation: 20,
    }),
    borderWidth: 2,
    borderColor: '#3b82f6',
  },
  reactionCount: {
    fontSize: 10,
    fontFamily: 'Inter-Medium',
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#ef4444',
    color: '#ffffff',
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 1,
    minWidth: 16,
    textAlign: 'center',
  },
  reactionProfilePics: {
    marginTop: 12,
    alignItems: 'center',
  },
  reactionTypeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 12,
  },
  reactionIcon: {
    marginRight: 6,
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profilePicsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniProfilePic: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ffffff',
    overflow: 'hidden',
  },
  miniProfilePicImage: {
    width: '100%',
    height: '100%',
  },
  miniProfilePicPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  miniProfilePicText: {
    fontSize: 8,
    fontFamily: 'Inter-Bold',
    color: '#ffffff',
  },
  miniProfilePicMore: {
    backgroundColor: '#6b7280',
  },

  // Message reaction display styles
  messageReactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
    paddingHorizontal: 8,
  },
  messageReactionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginRight: 4,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  selectedMessageReaction: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderColor: '#3b82f6',
  },
  messageReactionEmoji: {
    fontSize: 14,
    marginRight: 4,
  },
  messageReactionCount: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  pendingAttachmentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  flex1: {
    flex: 1,
  },
  pendingAttachmentCancelButton: {
    marginLeft: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  pendingAttachmentCancelButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 12,
  },
  pendingSentText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    fontWeight: '600',
  },
  pendingProgressBarOuter: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 4,
    marginTop: 4,
  },
  pendingProgressBarInner: {
    height: 4,
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 4,
  },
  pendingFailedContainer: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pendingFailedText: {
    marginLeft: 6,
    color: 'rgba(255,255,255,0.9)',
  },
  pendingRetryButton: {
    marginLeft: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  pendingRetryButtonText: {
    marginLeft: 4,
    color: '#fff',
    fontWeight: '600',
  },
  unreadBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
  },
  deletedIcon: {
    marginRight: 6,
  },
  attachmentSkeletonTextContainer: {
    marginLeft: 12,
  },
  attachmentWrapper: {
    width: '100%',
    alignItems: 'stretch',
  },
  marginTop8: {
    marginTop: 8,
  },
  marginBottom8: {
    marginBottom: 8,
  },
  marginLeft6: {
    marginLeft: 6,
  },
  marginLeft8: {
    marginLeft: 8,
  },
  height20: {
    height: 20,
  },
  rotate180: {
    transform: [{ rotate: '180deg' }],
  },
  alignItemsCenterMarginVertical8: {
    alignItems: 'center',
    marginVertical: 8,
  },
  pendingTextMessageTime: {
    color: 'rgba(255, 255, 255, 0.85)',
  },
  pendingTextRetryButton: {
    marginLeft: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  pendingTextRetryButtonText: {
    marginLeft: 4,
    color: '#ffffff',
    fontWeight: '600',
  },
  pendingMediaOverlay: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
});
