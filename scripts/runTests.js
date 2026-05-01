const path = require('path');
const tsNode = require('ts-node');

tsNode.register({
  transpileOnly: true,
  project: path.join(process.cwd(), 'tsconfig.json'),
});

const assert = require('assert');
const { logger } = require('../lib/logger');
const { getChatPaginationProfile } = require('../lib/chatPaginationConfig');
const {
  resolveChatLoadOlderStartPlan,
  resolveChatLoadOlderAttemptOptions,
  shouldRetryChatLoadOlder,
  shouldShowChatLoadOlderSyncingToast,
  shouldResetChatLoadOlderAutoLoadAnchor,
  resolveChatReachedConversationStartPlan,
  resolveChatLoadOlderFailurePlan,
  resolveChatLoadOlderFailureLogPayload,
  resolveChatLoadOlderConversationResetPlan,
  resolveChatLoadOlderRunStartPlan,
  resolveChatLoadOlderRunFinalizePlan,
  resolveChatLoadOlderRunCompletionPlan,
  resolveChatLoadOlderRetryAttemptPlan,
  resolveChatLoadOlderFinalAddedState,
  resolveChatLoadOlderReachedStartToastPayload,
  resolveChatLoadOlderReachedStartToastEmissionPlan,
  resolveChatLoadOlderSyncingToastPayload,
  resolveChatLoadOlderSyncingToastEmissionPlan,
} = require('../lib/chatLoadOlderState');
const {
  partitionMessagesByLimit,
  rangesOverlap,
  clampRange,
  deriveRangeFromMessages,
} = require('../lib/chatHistoryPolicy');
const {
  resolveNotificationChannelId,
  ANDROID_CHANNEL_IDS,
} = require('../backend-runtime/src/lib/notificationChannels');
const { resolveChatUploadFolder } = require('../lib/chatUploadUtils');
const {
  getPlanLimits,
  getUsageStatus,
  getUsagePercentage,
} = require('../backend-runtime/src/lib/planLimits');
const {
  reconcileConversationUnreadCount,
  shouldRefreshChatSummariesOnForegroundResume,
} = require('../lib/chatReceiptState');
const {
  resolveChatViewabilityNearbyMediaPrefetchPlan,
  resolveChatViewabilityPrefetchCandidateIndices,
} = require('../lib/chatViewabilityPrefetch');
const {
  applyChatViewabilityWarmTargetPrefetch,
  resolveChatViewabilityQueueDispatchResolverFallbackMetricPayload,
  resolveChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlan,
  resolveChatViewabilityWarmTargetPrefetchPlan,
  resolveChatViewabilityReceiptCollection,
  resolveChatViewabilityQueueDispatchEffectsPlan,
  resolveChatViewabilityReceiptQueueDispatchPlan,
} = require('../lib/chatViewabilityReceiptCollection');
const {
  resolveChatViewabilityWindowSummary,
  resolveChatUnreadSeparatorVisibilityPlan,
  resolveChatTopWindowActionPlan,
} = require('../lib/chatViewabilityWindow');
const {
  applyChatReceiptRequestedReadMutation,
  applyChatReceiptSyncFailureRecoveryPlan,
  applyChatReceiptSyncRunFinalizePlan,
  DEFAULT_CHAT_RECEIPT_DELIVERY_SYNC_COOLDOWN_MS,
  normalizeChatReceiptSyncEmail,
  resolveChatReceiptDeliverySyncRequest,
  resolveChatReceiptDeliverySyncMarkerReset,
  resolveChatReceiptDeliverySyncMarkerUpdate,
  resolveChatReceiptSyncQueueRequestPlan,
  resolveChatReceiptSyncQueueInvocationPlan,
  resolveChatReceiptQueueInvocationExecutionPlan,
  resolveChatReceiptForegroundQueuePlan,
  resolveChatReceiptForegroundQueueInvocationPlan,
  resolveChatReceiptForegroundQueueExecutionPlan,
  resolveChatReceiptViewabilityQueueInvocationPlan,
  resolveChatReceiptViewabilityQueueExecutionPlan,
  resolveChatReceiptViewabilityQueueDispatchPlan,
  resolveChatReceiptViewabilityQueueDispatchPlanForMarker,
  resolveChatReceiptViewabilitySyncPlan,
  resolveChatReceiptIncomingUnreadMessageId,
  resolveChatReceiptIncomingUnreadMessageIdForNormalizedParticipants,
  resolveChatReceiptRequestedReadMutationPlan,
  resolveChatReceiptSyncConversationResetPlan,
  clearChatReceiptSyncQueuedState,
  resolveChatReceiptSyncQueueApplyPlan,
  resolveChatReceiptSyncQueueDeferredFlushPlan,
  resolveChatReceiptSyncQueueScheduleDeferredFlushPlan,
  resolveChatReceiptSyncQueueSchedulePlan,
  applyChatReceiptSyncQueueScheduleExecutionPlan,
  resolveChatReceiptSyncQueueExecutionPlan,
  applyChatReceiptSyncQueueApplyPlan,
  resolveChatReceiptSyncRunAttemptPlan,
  resolveChatReceiptSyncFailureRecoveryPlan,
  resolveChatReceiptSyncFailurePlan,
  resolveChatReceiptSyncFlushExecutionPlan,
  shouldRunChatReceiptSyncDeferredFlushContinuation,
  shouldApplyChatReceiptSyncRunContinuation,
  shouldApplyChatReceiptSyncQueueExecutionContinuation,
  resolveChatReceiptSyncFollowupTriggerPlan,
  resolveChatReceiptSyncQueueUpdate,
  resolveChatReceiptSyncFlushPlan,
  resolveChatReceiptRequestedReadSeedMessageIds,
  resolveChatReceiptSyncFinalizePlan,
  shouldScheduleChatReceiptSyncFollowup,
} = require('../lib/chatReceiptSyncState');
const {
  normalizePendingMessageStatus,
  shouldHidePendingMessageDuringTransition,
} = require('../lib/pendingMessageState');
const {
  createChatTypingPair,
  areChatTypingPairsEqual,
} = require('../lib/chatTypingState');
const { resolveChatTypingTransition } = require('../lib/chatTypingTransition');
const {
  createChatTypingStatusWriteRollupState,
  recordChatTypingStatusWriteRollup,
} = require('../lib/chatTypingMetrics');
const { shouldSendOnComposerEnter } = require('../lib/chatInputKeypress');
const { canAttemptChatComposerSend, isChatComposerMessageOverLimit } = require('../lib/chatComposerSendState');
const {
  resolveChatComposerMessageWithinLimits,
  resolveChatComposerWordCount,
} = require('../lib/chatComposerInputState');
const {
  resolveChatDetectedRichContent,
  resolveChatRichTextInputResult,
} = require('../lib/chatRichContentState');
const { resolveChatInputKeyboardCommand } = require('../lib/chatInputKeyboardCommands');
const { getChatComposerDraftKey } = require('../lib/chatComposerDrafts');
const {
  resolveChatSpecialComposerState,
} = require('../lib/chatSpecialComposerState');
const {
  resolveChatNormalizedMessageId,
  resolveChatNormalizedMessageValue,
  resolveChatNormalizedParticipantEmail,
} = require('../lib/chatNormalizationState');
const {
  resolveChatTenorGifCandidateUrl,
  resolveChatTenorIdFromUrl,
  resolveChatTenorPostsLookupUrl,
  resolveChatTenorWebpToGifGuess,
} = require('../lib/chatTenorUrlState');
const {
  resolveChatPresenceTimestamp,
  resolveChatRealtimeOnline,
} = require('../lib/chatPresenceState');
const {
  resolveChatSafeDisplayInitial,
  resolveChatSanitizedAttachmentFileName,
  resolveChatSanitizedDateSeparatorLabel,
  resolveChatSanitizedMessageText,
} = require('../lib/chatSanitizeState');
const { resolveChatTimestampMs } = require('../lib/chatTimestampState');
const { resolveChatReplyPreviewText } = require('../lib/chatReplyPreview');
const {
  resolveChatReplyContextFromMessage,
  resolveChatReplySenderLabel,
} = require('../lib/chatReplyContextState');
const { resolveChatAttachmentAutoText } = require('../lib/chatAttachmentMessage');
const {
  resolveChatPendingServerMessageIdFromCandidates,
  resolveChatPendingMessageCandidatesByKey,
  buildChatPendingTextMatchKey,
  resolveTimestampMs,
} = require('../lib/chatPendingMessageServerIdMatcher');
const {
  resolveChatRosterMergedWithPresence,
  normalizeTeamMemberLookupKey,
  isChatTeamMemberPresenceHydrated,
  isChatTeamMemberProfileHydrated,
} = require('../lib/chatRosterMergeState');
const {
  resolveChatPendingRowAnimationTimings,
  resolveChatActivePendingAnimationKeys,
  resolveChatInactivePendingAnimationKeys,
  buildChatPendingRowAnimationKey,
  shouldStartPendingRowAnimation,
  markPendingRowAnimationStarted,
  PENDING_MESSAGE_BUBBLE_OPACITY_DEFAULT,
  PENDING_MESSAGE_BUBBLE_OPACITY_SENT,
  resolveChatPendingBubbleOpacityTarget,
  shouldAnimateChatPendingBubbleOpacity,
  resolveChatPendingBubbleOpacityDuration,
  resolveChatInactivePendingBubbleOpacityIds,
  resolveChatPendingBubbleOpacityEntry,
  resolveChatPendingRowAnimationEntry,
} = require('../lib/chatPendingAnimationState');
const {
  shouldFinalizeAttachmentCleanup,
  hasPendingAttachment,
  resolveChatAttachmentFinalizeDelayMs,
  isChatAttachmentTimerMapValid,
  resolveChatAttachmentCleanupPlan,
  ATTACHMENT_FINALIZE_CLEANUP_DELAY_MS,
} = require('../lib/chatAttachmentFinalizeState');
const {
  resolveChatComposerEffectiveHeight,
  resolveChatComposerExtraHeight,
  resolveChatComposerAdaptiveExtraHeight,
  resolveChatBottomVisibilityPadding,
  resolveChatAutoscrollToTopThreshold,
  isChatComposerHeightValid,
  COMPOSER_BASE_HEIGHT,
} = require('../lib/chatComposerLayoutState');
const {
  CHAT_PENDING_STORAGE_EMPTY_EMAIL,
  resolveChatPendingSenderEmail,
  shouldLoadChatPendingMessages,
  resolveChatNormalizedPendingMessages,
} = require('../lib/chatPendingStorageState');
const {
  CHAT_FLOATING_BUTTON_BASE_OFFSET,
  CHAT_FLOATING_BUTTON_BASE_COMPOSER_HEIGHT,
  resolveChatFloatingButtonBottomOffset,
  resolveChatScrollToBottomButtonStyleState,
} = require('../lib/chatFloatingButtonLayoutState');
const {
  shouldRunChatPendingDeliveredCleanup,
  hasChatPendingResolvedIds,
  resolveChatPendingMapAfterRemovingIds,
  resolveChatPendingActiveIdSet,
} = require('../lib/chatPendingCleanupState');
const {
  createChatUploadProgressEmitter,
  normalizeChatUploadProgressPercent,
  resolveChatUploadProgressPercentFromBytes,
} = require('../lib/chatUploadProgress');
const {
  clampUploadProgressPercent,
  normalizeUploadProgressDisplayPercent,
  resolveDownloadProgressLabel,
  resolveProgressPercentText,
  resolveUploadProgressDisplayStep,
} = require('../lib/uploadProgressDisplayEasing');
const { splitChatTextForHighlight } = require('../lib/chatSearchHighlight');
const { clearTimeoutRef, scheduleTimeoutRef } = require('../lib/timeoutRef');
const {
  normalizeChatConversationSearchQuery,
  normalizeChatConversationSearchScope,
  resolveChatConversationSearchScopeLabel,
  resolveChatConversationSearchSeedQuery,
  resolveChatConversationSearchMatchIds,
  resolveChatConversationSearchBestScopeSuggestion,
  resolveChatConversationSearchNoMatchesGuidance,
  resolveChatConversationSearchScopeMatchCounts,
  resolveChatConversationSearchScopeShortcutAction,
  resolveChatConversationSearchScopeSuggestionByOrdinal,
  resolveChatConversationSearchScopeSuggestionCycle,
  resolveChatConversationSearchScopeSuggestions,
  clampChatConversationSearchIndex,
  resolveChatConversationSearchCounterLabel,
  resolveChatConversationSearchNextIndex,
  resolveChatConversationSearchScopeStep,
  resolveChatConversationSearchSnippet,
  resolveChatConversationSearchSnippetTypeLabel,
  resolveChatConversationSearchNoMatchesLabel,
  shouldLoadOlderForConversationSearch,
} = require('../lib/chatConversationSearch');
const {
  normalizePersistedConversationSearchContextStore,
  readPersistedConversationSearchContext,
  upsertPersistedConversationSearchContext,
} = require('../lib/chatConversationSearchContext');
const {
  resolveChatConversationSearchContextKey,
} = require('../lib/chatConversationSearchContextKey');
const {
  createChatConversationSearchUxRollupState,
  recordChatConversationSearchUxRollup,
} = require('../lib/chatConversationSearchMetrics');
const {
  resolveChatConversationSearchMatchCollections,
} = require('../lib/chatConversationSearchMatchCollections');
const {
  resolveChatMessageDisplayKey,
  resolveChatMessageRenderSignature,
} = require('../lib/chatMessageIdentityState');
const {
  resolveChatMessageLayoutSize,
  resolveChatMessageListItemKey,
  resolveChatMessageListItemType,
} = require('../lib/chatMessageListItemState');
const {
  resolveChatDisplayedMessagesState,
  resolveChatDisplayedMessageIdSet,
  shouldCompactChatMessagePositions,
  resolveChatPrunedMessagePositions,
  CHAT_MESSAGE_POSITION_COMPACTION_DRIFT_THRESHOLD,
} = require('../lib/chatDisplayedMessagesState');
const {
  resolveChatCanDeleteMessage,
  resolveChatCanEditMessage,
  resolveChatCanReplyMessage,
  resolveChatFindLatestEditableOwnMessage,
  resolveChatIsOwnMessageEmail,
} = require('../lib/chatMessageActionState');
const {
  resolveChatOptimisticReactionMap,
  shouldKeepChatOptimisticReactionUntil,
  resolveChatOptimisticReactionExpiryIds,
  resolveChatPrunedLocalMessageReactions,
} = require('../lib/chatReactionState');
const {
  createChatMessageInfoCopyMetricRollupState,
  formatChatMessageInfoRowsForClipboard,
  recordChatMessageInfoCopyMetricRollup,
  resolveChatMessageInfoCopyFeedbackAccessibilityLabel,
  resolveChatMessageInfoCopyFeedbackLabel,
  resolveChatMessageInfoCopySuccessPlan,
  resolveChatMessageInfoCopySuccessSelection,
  resolveChatMessageInfoNormalizedRowKey,
  resolveChatMessageInfoCopyRowLabel,
  resolveChatMessageInfoCopiedResetPayload,
  resolveChatMessageInfoCopiedRowKeyAfterReset,
  resolveChatMessageInfoCopiedRowLabelAfterReset,
  resolveChatMessageInfoCopyFeedbackSourceAccessibilityLabel,
  resolveChatMessageInfoCopyFeedbackSourceBadgeText,
  resolveChatMessageInfoCopyFeedbackSourceLabel,
  resolveChatMessageInfoCopyFeedbackSourcePalette,
  resolveChatMessageInfoCopyToastCooldownMs,
  resolveChatMessageInfoCopyToastCooldownState,
  resolveChatMessageInfoCopyToastSuppressionPlan,
  resolveChatMessageInfoCopyToastNoticeClearDelayMs,
  resolveChatMessageInfoCopyToastPayload,
  resolveChatMessageInfoRowBadge,
  resolveChatMessageInfoRowValueParts,
  resolveChatMessageInfoShortcutAction,
  resolveChatMessageInfoToastCooldownAccessibilityLabel,
  resolveChatMessageInfoToastCooldownNotice,
  resolveChatMessageInfoLines,
  resolveChatMessageInfoRows,
} = require('../lib/chatMessageInfo');
const { executeChatReplyJump } = require('../lib/chatReplyJump');
const {
  normalizeReplyJumpTargetMessageId,
  resolveReplyJumpHighlightAfterTimeout,
  resolveReplyJumpStateForJumpSuccess,
  resolveReplyJumpStateForLatestReturn,
  resolveReplyJumpStateForNearBottom,
} = require('../lib/chatReplyJumpUiState');
const { resolveChatNearBottomState } = require('../lib/chatNearBottomState');
const {
  resolveChatStickyDateSourcePlan,
  resolveChatStickyDateVisibilityPlan,
} = require('../lib/chatStickyDateState');
const {
  pruneDelimitedMapByPrefixSet,
  pruneMapByKeySet,
  pruneMapByNumericRange,
  resolveMapCacheEntry,
  resolveChatAttachmentBaseKeySet,
} = require('../lib/chatHandlerCache');
const {
  resolveChatPendingReplyPreviewState,
  resolveChatPendingStatusDisplayState,
} = require('../lib/chatPendingRenderState');
const {
  resolveChatPendingAttachmentMessageReconciledIds,
  resolveChatPendingMediaMessageReconciledIds,
  resolveChatPendingTextMessageReconciledIds,
} = require('../lib/chatPendingReconciliationState');
const {
  resolveChatPendingServerMatchVisibility,
  resolveChatPendingTextVisibilityState,
} = require('../lib/chatPendingVisibilityState');
const {
  resolveChatPendingRetrySuccessCount,
  resolveChatPendingRetrySummaryToastPayload,
} = require('../lib/chatPendingRetrySummaryState');
const { resolveChatPendingRetryOutcomeSummary } = require('../lib/chatPendingRetryOutcomeState');
const { resolveChatPendingRetryAllGuard } = require('../lib/chatPendingRetryEligibilityState');
const { resolveChatPendingRetryBatchPlan } = require('../lib/chatPendingRetryBatchState');
const {
  resolveChatPendingRetryDispatchPromises,
} = require('../lib/chatPendingRetryDispatchState');
const { resolveChatPendingAutoRetryPlan } = require('../lib/chatPendingAutoRetryState');
const {
  resolveChatPendingConversationDerivedState,
} = require('../lib/chatPendingConversationDerived');
const {
  createChatReplyJumpMetricRollupState,
  flushChatReplyJumpMetricRollup,
  recordChatReplyJumpMetricRollup,
} = require('../lib/chatReplyJumpMetrics');
const {
  normalizeChatRealtimeReplyPayload,
  buildChatRealtimeMessageContentSignature,
} = require('../backend-runtime/src/lib/chatRealtimePayload');
const {
  createChatRenderTraceState,
  resolveChatRenderTraceStartPayload,
  resolveChatRenderTraceCompletePayload,
} = require('../lib/chatRenderTraceMetrics');
const {
  resolveChatUnreadRepairEligibility,
  resolveChatUnreadRepairRunPayload,
} = require('../lib/chatUnreadRepairMetrics');
const {
  resolveChatScrollInteractionPlan,
} = require('../lib/chatScrollInteractionState');
const {
  resolveChatStickyDateIdleHidePlan,
  resolveChatStickyDateScrollPlan,
} = require('../lib/chatStickyDateScrollState');
const {
  resolveChatBottomAnchorAttemptPlan,
  resolveChatEnsureAnchorActionPlan,
  resolveChatPrependAnchorRetryPlan,
  resolveChatPrependAnchorRetrySchedulePlan,
  resolveChatPrependAnchorFallbackPlan,
  resolveChatPrependAnchorFallbackScrollPlan,
  resolveChatPrependAnchorClearPlan,
  resolveChatPrependAnchorFailurePlanInput,
  resolveChatPrependAnchorFailureFallbackInputPlan,
  resolveChatPrependAnchorFailurePlan,
  resolveChatPrependAnchorFailureClearActionPlan,
  resolveChatPrependAnchorFailureRetrySchedulePlan,
  resolveChatPrependAnchorFailureActionPlans,
  resolveChatPrependAnchorFailureActionPlansFromInput,
  resolveChatPrependAnchorFailureActionPlansRawInputPlan,
  resolveChatPrependAnchorFailureAnchorContextPlan,
  resolveChatPrependAnchorFailureActionPlansFromContext,
  resolveChatPrependAnchorFailureFallbackResolutionPlan,
  resolveChatPrependAnchorFailureEffectIntentFromContext,
  resolveChatPrependAnchorFailureEffectExecutionFromContext,
  resolveChatPrependAnchorFailureExecutionContextPlan,
  resolveChatPrependAnchorFailureEffectExecutionForAnchor,
  resolveChatPrependAnchorFailureEffectExecutionPlansForAnchor,
  resolveChatPrependAnchorFailureRestorePlans,
  resolveChatPrependAnchorFailureExecutionPlanForRestore,
  resolveChatPrependAnchorFailureExecutionSelectionPlan,
  resolveChatPrependAnchorFailureEffectIntentPlan,
  resolveChatPrependAnchorFailureEffectExecutionPlan,
  resolveChatPrependAnchorRestoreOffsetPlan,
  resolveChatPrependAnchorCapturePlan,
  resolveChatPrependAnchorCaptureTriggerOffset,
} = require('../lib/chatAnchorStabilizationState');
const {
  applyChatPrependAnchorFailureExecutionPlan,
  createChatPrependAnchorFailureExecutor,
  createChatPrependAnchorFailureSelectedExecutor,
  applyChatPrependAnchorFailureBranchExecution,
  applyChatPrependAnchorRestoreWithFallback,
} = require('../lib/chatAnchorFailureExecutionRuntime');
const {
  resolveChatUnreadDividerDerivedState,
} = require('../lib/chatUnreadDividerState');
const {
  resolveChatUnreadSeparatorReconcilePlan,
} = require('../lib/chatUnreadSeparatorReconcileState');
const {
  resolveChatLiveConversationSummary,
} = require('../lib/chatConversationSummaryState');
const {
  resolveChatPendingRecipientEmail,
  resolveChatTeamMembersByRecipientKey,
} = require('../lib/chatRecipientLookupState');
const {
  resolveChatFilteredTeamMembers,
} = require('../lib/chatTeamMemberListState');
const {
  resolveChatRosterSnapshotForRoster,
} = require('../lib/chatRosterSnapshotState');
const {
  resolveChatMessageDateLabel,
  resolveChatMessageRowMetaState,
} = require('../lib/chatMessageRowMetaState');
const {
  resolveChatEstimatedItemSize,
  resolveChatEstimatedListSize,
  resolveChatListDrawDistance,
} = require('../lib/chatListVirtualizationState');
const {
  upsertChatConversationSummary,
} = require('../lib/chatConversationSummaryMapState');

logger.debug('Running unit tests (basic runner)');

function processDocsForPagination(docs, pageSize) {
  const hasMore = docs.length > pageSize;
  const docsToProcess = hasMore ? docs.slice(0, pageSize) : docs;
  const reminders = [];
  let newLastDocument = null;

  docsToProcess.forEach((doc) => {
    const data = doc.data();
    reminders.push({ id: doc.id, ...data });
    newLastDocument = doc;
  });

  return { reminders, lastDocument: newLastDocument, hasMore };
}

// Test 1
(function testHasMore() {
  const docs = [];
  for (let i = 0; i < 6; i++) {
    docs.push({ id: `doc-${i}`, data: () => ({ studentName: `Student ${i}`, status: i % 2 === 0 ? 'success' : 'failed' }) });
  }
  const result = processDocsForPagination(docs, 5);
  assert.strictEqual(result.hasMore, true, 'Expected hasMore true for docs > pageSize');
  assert.strictEqual(result.reminders.length, 5, 'Expected 5 reminders');
  assert.strictEqual(result.lastDocument.id, 'doc-4', 'Expected lastDocument to be doc-4');
  logger.debug('✓ testHasMore passed');
})();

// Test 2
(function testNoMore() {
  const docs = [];
  for (let i = 0; i < 3; i++) {
    docs.push({ id: `doc-${i}`, data: () => ({ studentName: `Student ${i}`, status: 'pending' }) });
  }
  const result = processDocsForPagination(docs, 5);
  assert.strictEqual(result.hasMore, false, 'Expected hasMore false for docs <= pageSize');
  assert.strictEqual(result.reminders.length, 3, 'Expected 3 reminders');
  assert.strictEqual(result.lastDocument.id, 'doc-2', 'Expected lastDocument to be doc-2');
  logger.debug('✓ testNoMore passed');
})();

function withEnv(overrides, callback) {
  const backup = {};
  Object.keys(overrides).forEach((key) => {
    backup[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  try {
    callback();
  } finally {
    Object.keys(overrides).forEach((key) => {
      if (backup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    });
  }
}

(function testNativePaginationOverrides() {
  withEnv(
    {
      EXPO_PUBLIC_CHAT_PAGE_SIZE_NATIVE: '18',
      EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES_NATIVE: '3',
      EXPO_PUBLIC_CHAT_CACHE_LIMIT_NATIVE: '600',
      EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD_NATIVE: '5',
    },
    () => {
      const profile = getChatPaginationProfile('native');
      assert.strictEqual(profile.pageSize, 18, 'Native page size override failed');
      assert.strictEqual(profile.bootstrapPages, 3, 'Native bootstrap pages override failed');
      assert.strictEqual(profile.bootstrapWindowSize, 54, 'Native bootstrap window mismatch');
      assert.strictEqual(profile.cacheLimit, 600, 'Native cache limit override failed');
      assert.strictEqual(profile.prefetchThreshold, 5, 'Native prefetch threshold override failed');
      logger.debug('✓ testNativePaginationOverrides passed');
    }
  );
})();

(function testWebPaginationSharedFallback() {
  withEnv(
    {
      EXPO_PUBLIC_CHAT_PAGE_SIZE: '40',
      EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES: '1',
      EXPO_PUBLIC_CHAT_CACHE_LIMIT: '200',
      EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD: '2',
      EXPO_PUBLIC_CHAT_PAGE_SIZE_WEB: undefined,
      EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES_WEB: undefined,
      EXPO_PUBLIC_CHAT_CACHE_LIMIT_WEB: undefined,
      EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD_WEB: undefined,
    },
    () => {
      const profile = getChatPaginationProfile('web');
      assert.strictEqual(profile.pageSize, 40, 'Web shared fallback page size failed');
      assert.strictEqual(profile.bootstrapPages, 1, 'Web shared fallback bootstrap pages failed');
      assert.strictEqual(profile.cacheLimit, 200, 'Web shared fallback cache limit failed');
      assert.strictEqual(profile.prefetchThreshold, 2, 'Web shared fallback prefetch threshold failed');
      logger.debug('✓ testWebPaginationSharedFallback passed');
    }
  );
})();

(function testPaginationDefaults() {
  const profile = getChatPaginationProfile('native');
  assert(profile.pageSize > 0 && profile.bootstrapPages > 0, 'Defaults should be positive');
  assert.strictEqual(profile.bootstrapWindowSize, profile.pageSize * profile.bootstrapPages, 'Bootstrap window mismatch');
  assert(profile.cacheLimit >= profile.bootstrapWindowSize, 'Cache limit should cover bootstrap window');
  logger.debug('✓ testPaginationDefaults passed');
})();

(function testChatLoadOlderStateHelpers() {
  assert.deepStrictEqual(
    resolveChatLoadOlderStartPlan({
      reason: 'manual',
      alreadyAtStart: false,
      isLoadOlderLocked: true,
      isLoadingMore: false,
      hasMore: true,
      hasAttemptedBefore: false,
      hasLoadMoreFunction: true,
    }),
    {
      shouldProceed: false,
      shouldShowReachedStartToast: false,
    },
    'Load-older start helper should block while lock is active'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderStartPlan({
      reason: 'manual',
      alreadyAtStart: true,
      isLoadOlderLocked: false,
      isLoadingMore: false,
      hasMore: true,
      hasAttemptedBefore: true,
      hasLoadMoreFunction: true,
    }),
    {
      shouldProceed: false,
      shouldShowReachedStartToast: true,
    },
    'Load-older start helper should surface reached-start toast for manual requests'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderStartPlan({
      reason: 'auto',
      alreadyAtStart: false,
      isLoadOlderLocked: false,
      isLoadingMore: false,
      hasMore: false,
      hasAttemptedBefore: true,
      hasLoadMoreFunction: true,
    }),
    {
      shouldProceed: false,
      shouldShowReachedStartToast: false,
    },
    'Load-older start helper should suppress repeated auto requests without more history'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderStartPlan({
      reason: 'auto',
      alreadyAtStart: false,
      isLoadOlderLocked: false,
      isLoadingMore: false,
      hasMore: true,
      hasAttemptedBefore: false,
      hasLoadMoreFunction: true,
    }),
    {
      shouldProceed: true,
      shouldShowReachedStartToast: false,
    },
    'Load-older start helper should allow eligible requests to proceed'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderStartPlan({
      reason: 'manual',
      alreadyAtStart: false,
      isLoadOlderLocked: false,
      isLoadingMore: false,
      hasMore: true,
      hasAttemptedBefore: false,
      hasLoadMoreFunction: false,
    }),
    {
      shouldProceed: false,
      shouldShowReachedStartToast: false,
    },
    'Load-older start helper should block when loadMore is unavailable'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderAttemptOptions('manual'),
    { aggressive: true, force: true },
    'Load-older attempt helper should force aggressive options for manual requests'
  );

  assert.strictEqual(
    resolveChatLoadOlderAttemptOptions('auto'),
    undefined,
    'Load-older attempt helper should skip aggressive options for auto requests'
  );

  assert.strictEqual(
    shouldRetryChatLoadOlder('manual', false, true),
    true,
    'Load-older retry helper should allow manual retry when load added nothing and more history remains'
  );

  assert.strictEqual(
    shouldRetryChatLoadOlder('manual', true, true),
    false,
    'Load-older retry helper should not retry when first attempt already added messages'
  );

  assert.strictEqual(
    shouldShowChatLoadOlderSyncingToast('manual', false, true),
    true,
    'Load-older toast helper should show syncing guidance when manual retry path still adds nothing'
  );

  assert.strictEqual(
    shouldShowChatLoadOlderSyncingToast('auto', false, true),
    false,
    'Load-older toast helper should suppress syncing guidance for auto requests'
  );

  assert.strictEqual(
    shouldResetChatLoadOlderAutoLoadAnchor('auto', false),
    true,
    'Load-older auto-anchor helper should reset anchor when auto request adds nothing'
  );

  assert.strictEqual(
    shouldResetChatLoadOlderAutoLoadAnchor('manual', false),
    false,
    'Load-older auto-anchor helper should keep anchor unchanged for manual requests'
  );

  assert.deepStrictEqual(
    resolveChatReachedConversationStartPlan({
      isLoadingMore: true,
      hasMore: false,
      loadOlderAttempts: 2,
    }),
    {
      shouldUpdate: false,
      nextReachedConversationStart: false,
    },
    'Reached-start helper should avoid updates while a pagination request is still loading'
  );

  assert.deepStrictEqual(
    resolveChatReachedConversationStartPlan({
      isLoadingMore: false,
      hasMore: true,
      loadOlderAttempts: 2,
    }),
    {
      shouldUpdate: true,
      nextReachedConversationStart: false,
    },
    'Reached-start helper should clear reached-start state when more history is still available'
  );

  assert.deepStrictEqual(
    resolveChatReachedConversationStartPlan({
      isLoadingMore: false,
      hasMore: false,
      loadOlderAttempts: 1,
    }),
    {
      shouldUpdate: true,
      nextReachedConversationStart: true,
    },
    'Reached-start helper should mark conversation start reached after at least one load-older attempt with no remaining history'
  );

  assert.deepStrictEqual(
    resolveChatReachedConversationStartPlan({
      isLoadingMore: false,
      hasMore: false,
      loadOlderAttempts: 0,
    }),
    {
      shouldUpdate: false,
      nextReachedConversationStart: false,
    },
    'Reached-start helper should remain unchanged when no history remains but load-older has never been attempted'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderFailurePlan(),
    {
      shouldClearPendingPrependAnchor: true,
    },
    'Load-older failure helper should clear pending prepend anchor after pagination errors'
  );

  const failureError = new Error('boom');
  assert.deepStrictEqual(
    resolveChatLoadOlderFailureLogPayload('manual', failureError),
    {
      reason: 'manual',
      error: failureError,
    },
    'Load-older failure log payload helper should preserve reason and original error for logger metadata'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderConversationResetPlan(),
    {
      nextLoadOlderAttempts: 0,
      nextReachedConversationStart: false,
      shouldResetAutoLoadAnchor: true,
    },
    'Load-older reset helper should reset attempts, reached-start state, and auto-load anchor on conversation changes'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRunStartPlan(0),
    {
      nextLoadOlderAttempts: 1,
      shouldLockLoadOlder: true,
    },
    'Load-older run-start helper should increment attempts and request lock acquisition'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRunStartPlan(-2),
    {
      nextLoadOlderAttempts: 1,
      shouldLockLoadOlder: true,
    },
    'Load-older run-start helper should clamp invalid negative attempt counts before incrementing'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRunStartPlan(Number.NaN),
    {
      nextLoadOlderAttempts: 1,
      shouldLockLoadOlder: true,
    },
    'Load-older run-start helper should normalize non-finite attempt counts before incrementing'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRunStartPlan(2.9),
    {
      nextLoadOlderAttempts: 3,
      shouldLockLoadOlder: true,
    },
    'Load-older run-start helper should truncate fractional attempt counts before incrementing'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRunFinalizePlan(),
    {
      shouldUnlockLoadOlder: true,
    },
    'Load-older run-finalize helper should request lock release after request flow settles'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRunCompletionPlan('auto', false),
    {
      shouldResetAutoLoadAnchor: true,
      shouldUnlockLoadOlder: true,
    },
    'Load-older run-completion helper should reset auto anchor and unlock when auto load adds nothing'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRunCompletionPlan('manual', false),
    {
      shouldResetAutoLoadAnchor: false,
      shouldUnlockLoadOlder: true,
    },
    'Load-older run-completion helper should avoid auto-anchor reset for manual loads while still unlocking'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRetryAttemptPlan({
      reason: 'manual',
      firstAttemptAdded: false,
      hasMore: true,
      hasManualLoadOptions: true,
    }),
    {
      shouldRunRetryAttempt: true,
    },
    'Load-older retry-attempt helper should request retry for manual requests when first attempt adds nothing and history remains'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRetryAttemptPlan({
      reason: 'auto',
      firstAttemptAdded: false,
      hasMore: true,
      hasManualLoadOptions: false,
    }),
    {
      shouldRunRetryAttempt: false,
    },
    'Load-older retry-attempt helper should suppress retry for auto requests'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderRetryAttemptPlan({
      reason: 'manual',
      firstAttemptAdded: false,
      hasMore: true,
      hasManualLoadOptions: false,
    }),
    {
      shouldRunRetryAttempt: false,
    },
    'Load-older retry-attempt helper should suppress retry when manual options are unavailable'
  );

  assert.strictEqual(
    resolveChatLoadOlderFinalAddedState(false, true),
    true,
    'Load-older final-added helper should use retry result when retry is executed'
  );

  assert.strictEqual(
    resolveChatLoadOlderFinalAddedState(true, undefined),
    true,
    'Load-older final-added helper should preserve first-attempt result when retry is skipped'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderReachedStartToastPayload(),
    {
      type: 'info',
      text1: 'No older messages',
      text2: 'You have reached the beginning of this chat history.',
      position: 'top',
    },
    'Load-older reached-start toast helper should provide consistent no-history toast copy'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderReachedStartToastEmissionPlan(true),
    {
      shouldShow: true,
      payload: {
        type: 'info',
        text1: 'No older messages',
        text2: 'You have reached the beginning of this chat history.',
        position: 'top',
      },
    },
    'Load-older reached-start toast emission helper should include payload when reached-start guidance should be shown'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderReachedStartToastEmissionPlan(false),
    {
      shouldShow: false,
      payload: null,
    },
    'Load-older reached-start toast emission helper should suppress payload when reached-start guidance is not needed'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderSyncingToastPayload(),
    {
      type: 'info',
      text1: 'Syncing older messages…',
      text2: 'Fetching a fuller history from the server.',
      position: 'top',
    },
    'Load-older syncing toast helper should provide consistent history-sync toast copy'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderSyncingToastEmissionPlan('manual', false, true),
    {
      shouldShow: true,
      payload: {
        type: 'info',
        text1: 'Syncing older messages…',
        text2: 'Fetching a fuller history from the server.',
        position: 'top',
      },
    },
    'Load-older syncing toast emission helper should provide a payload when manual retry flow still yields no added messages'
  );

  assert.deepStrictEqual(
    resolveChatLoadOlderSyncingToastEmissionPlan('auto', false, true),
    {
      shouldShow: false,
      payload: null,
    },
    'Load-older syncing toast emission helper should suppress payload for auto requests'
  );

  logger.debug('✓ testChatLoadOlderStateHelpers passed');
})();

(function testPartitionMessagesByLimit() {
  const sample = Array.from({ length: 6 }, (_, idx) => ({
    timestamp: new Date(2025, 0, idx + 1).toISOString(),
    id: idx,
  }));
  const { retained, spilled } = partitionMessagesByLimit(sample, 4);
  assert.strictEqual(retained.length, 4, 'Partition should retain the latest N messages');
  assert.strictEqual(spilled.length, 2, 'Partition should spill the oldest remainder');
  assert.strictEqual(retained[0].id, 2, 'Retained window should start at id=2');
  assert.strictEqual(spilled[0].id, 0, 'Spilled window should include oldest message');
  logger.debug('✓ testPartitionMessagesByLimit passed');
})();

(function testRangeOverlapHelpers() {
  const primary = { startTimestamp: '2025-01-01T00:00:00Z', endTimestamp: '2025-01-02T00:00:00Z' };
  const touching = { startTimestamp: '2025-01-02T00:00:00Z', endTimestamp: '2025-01-03T00:00:00Z' };
  const distant = { startTimestamp: '2025-02-01T00:00:00Z', endTimestamp: '2025-02-02T00:00:00Z' };
  assert(rangesOverlap(primary, touching), 'Ranges that touch at endpoints should be considered overlapping');
  assert(!rangesOverlap(primary, distant), 'Distinct ranges should not overlap');
  const reversed = clampRange({ startTimestamp: primary.endTimestamp, endTimestamp: primary.startTimestamp });
  assert.strictEqual(reversed?.startTimestamp, primary.startTimestamp, 'Clamp should normalize out-of-order ranges');
  logger.debug('✓ testRangeOverlapHelpers passed');
})();

(function testDeriveRangeFromMessages() {
  const payload = [
    { timestamp: '2025-03-03T10:00:00Z' },
    { timestamp: '2025-03-01T08:00:00Z' },
    { timestamp: '2025-03-05T12:30:00Z' },
  ];
  const range = deriveRangeFromMessages(payload);
  assert(range, 'Range should be derived from timestamped messages');
  assert.strictEqual(range?.startTimestamp, '2025-03-01T08:00:00Z', 'Derived range should pick oldest timestamp as start');
  assert.strictEqual(range?.endTimestamp, '2025-03-05T12:30:00Z', 'Derived range should pick newest timestamp as end');
  logger.debug('✓ testDeriveRangeFromMessages passed');
})();

(function testNotificationChannelResolverMappings() {
  const scenarios = [
    { input: { type: 'chat_message' }, expected: ANDROID_CHANNEL_IDS.CHAT, label: 'chat messages' },
    { input: { type: 'daily_quote' }, expected: ANDROID_CHANNEL_IDS.DAILY_QUOTES, label: 'daily quotes' },
    { input: { type: 'fee_overdue_alert' }, expected: ANDROID_CHANNEL_IDS.IMPORTANT, label: 'important alerts' },
    { input: { type: 'notice_created' }, expected: ANDROID_CHANNEL_IDS.NOTICES, label: 'notice board updates' },
    { input: { type: 'system_update' }, expected: ANDROID_CHANNEL_IDS.MISC, label: 'misc notifications' },
    { input: { type: 'birthday_greeting' }, expected: ANDROID_CHANNEL_IDS.MISC, label: 'birthday greetings' },
    { input: { type: 'unknown_type' }, expected: ANDROID_CHANNEL_IDS.GENERAL, label: 'fallback notifications' },
    { input: { priority: 'HIGH' }, expected: ANDROID_CHANNEL_IDS.IMPORTANT, label: 'priority override' },
  ];

  scenarios.forEach(({ input, expected, label }) => {
    const resolved = resolveNotificationChannelId(input);
    assert.strictEqual(
      resolved,
      expected,
      `Expected ${label} to route to channel ${expected}, received ${resolved}`
    );
  });

  logger.debug('✓ testNotificationChannelResolverMappings passed');
})();

(function testChatUploadFolderResolution() {
  const dual = resolveChatUploadFolder({
    senderEmail: 'Alice.Teacher@example.com',
    recipientEmail: 'parent.ONE@school.edu',
  });
  const dualReversed = resolveChatUploadFolder({
    senderEmail: 'parent.ONE@school.edu',
    recipientEmail: 'Alice.Teacher@example.com',
  });
  assert.strictEqual(dual, dualReversed, 'Conversation folder should be stable regardless of participant order');
  assert.match(dual, /^c_[a-f0-9]{20}$/i, 'Expected conversation folder to use the hashed conversation key format');

  const single = resolveChatUploadFolder({ senderEmail: 'solo.user@demo.org' });
  assert.match(single, /^c_[a-f0-9]{20}$/i, 'Single participant folder should use the hashed participant key format');
  assert.notStrictEqual(single, dual, 'Single participant folder should not collide with a conversation folder');

  const fallback = resolveChatUploadFolder({});
  assert.strictEqual(fallback, 'unassigned', 'Missing participants should fall back to unassigned folder');

  logger.debug('✓ testChatUploadFolderResolution passed');
})();

(function testPlanLimitsHelpers() {
  const free = getPlanLimits('free');
  assert.strictEqual(free.staffSeats, 3, 'Free plan seats mismatch');
  const fallback = getPlanLimits('unknown');
  assert.strictEqual(fallback.id, 'free', 'Unknown plan should fall back to free');

  assert.strictEqual(getUsageStatus(40, 100), 'ok', 'Usage under 80% should be ok');
  assert.strictEqual(getUsageStatus(85, 100), 'warning', 'Usage >=80% should warn');
  assert.strictEqual(getUsageStatus(101, 100), 'critical', 'Usage >=100% should be critical');

  const percent = getUsagePercentage(42, 75);
  assert(percent > 55 && percent < 57, 'Percentage should be ~56%');

  logger.debug('✓ testPlanLimitsHelpers passed');
})();

(function testReconcileConversationUnreadCount() {
  const previous = new Map([
    ['partner@example.com', { unreadCount: 4, updatedAt: '2025-03-11T10:00:00.000Z' }],
  ]);

  const unchangedWhileBackgrounded = reconcileConversationUnreadCount(previous, 'partner@example.com', 1, {
    isFocused: true,
    isAppActive: false,
    loading: false,
  });
  assert.strictEqual(unchangedWhileBackgrounded, previous, 'Backgrounded chat should not mutate unread summary state');

  const updated = reconcileConversationUnreadCount(previous, 'partner@example.com', 1, {
    isFocused: true,
    isAppActive: true,
    loading: false,
  });
  assert.notStrictEqual(updated, previous, 'Active chat should reconcile unread summary state');
  assert.strictEqual(updated.get('partner@example.com').unreadCount, 1, 'Unread count should be reconciled to the live message count');
  logger.debug('✓ testReconcileConversationUnreadCount passed');
})();

(function testForegroundResumeRefreshGate() {
  assert.strictEqual(
    shouldRefreshChatSummariesOnForegroundResume({
      isFocused: true,
      isAppActive: true,
      wasForegroundInteractive: false,
      hasUserEmail: true,
      hasTenantId: true,
      now: 5000,
      lastForegroundRefreshAt: 1000,
    }),
    true,
    'Foreground resume should trigger a summary refresh when outside the throttle window'
  );

  assert.strictEqual(
    shouldRefreshChatSummariesOnForegroundResume({
      isFocused: true,
      isAppActive: true,
      wasForegroundInteractive: false,
      hasUserEmail: true,
      hasTenantId: true,
      now: 2000,
      lastForegroundRefreshAt: 1000,
    }),
    false,
    'Foreground resume should stay throttled when it happens too soon after the previous refresh'
  );

  assert.strictEqual(
    shouldRefreshChatSummariesOnForegroundResume({
      isFocused: true,
      isAppActive: true,
      wasForegroundInteractive: true,
      hasUserEmail: true,
      hasTenantId: true,
      now: 5000,
      lastForegroundRefreshAt: 0,
    }),
    false,
    'A continuously active screen should not be treated as a resume event'
  );
  logger.debug('✓ testForegroundResumeRefreshGate passed');
})();

(function testChatReceiptSyncQueueUpdateHelper() {
  const queueUpdate = resolveChatReceiptSyncQueueUpdate(
    {
      readMessageIds: [' msg-1 ', null, 'msg-2', 'msg-1', 7, '   '],
      requestConversationDelivered: true,
    },
    new Set(['msg-2'])
  );

  assert.deepStrictEqual(
    queueUpdate,
    {
      readMessageIds: ['msg-1', '7'],
      requestConversationDelivered: true,
    },
    'Receipt queue-update helper should normalize ids, skip already-requested ids, and de-duplicate remaining ids'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueUpdate({ readMessageIds: undefined }, new Set()),
    {
      readMessageIds: [],
      requestConversationDelivered: false,
    },
    'Receipt queue-update helper should return empty updates for missing queue input'
  );

  logger.debug('✓ testChatReceiptSyncQueueUpdateHelper passed');
})();

(function testChatReceiptSyncQueueRequestPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueRequestPlan({
      readMessageIds: [' msg-1 ', 'msg-1', null],
      requestConversationDelivered: false,
    }),
    {
      readMessageIds: ['msg-1'],
      requestConversationDelivered: false,
      shouldQueueSync: true,
    },
    'Receipt queue-request plan helper should normalize read ids and schedule queue work when read receipts exist'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueRequestPlan({
      readMessageIds: [],
      requestConversationDelivered: true,
    }),
    {
      readMessageIds: [],
      requestConversationDelivered: true,
      shouldQueueSync: true,
    },
    'Receipt queue-request plan helper should schedule queue work for delivery-only requests'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueRequestPlan({
      readMessageIds: [],
      requestConversationDelivered: false,
    }),
    {
      readMessageIds: [],
      requestConversationDelivered: false,
      shouldQueueSync: false,
    },
    'Receipt queue-request plan helper should no-op when no read or delivery work exists'
  );

  logger.debug('✓ testChatReceiptSyncQueueRequestPlanHelper passed');
})();

(function testChatReceiptSyncQueueInvocationPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueInvocationPlan({
      readMessageIds: [' msg-1 ', 'msg-1', null],
      requestConversationDelivered: true,
      shouldQueueSync: true,
    }),
    {
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Queue invocation helper should normalize queue options and keep invocation enabled when plan has work'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueInvocationPlan({
      readMessageIds: ['msg-1'],
      requestConversationDelivered: false,
      shouldQueueSync: false,
    }),
    {
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: false,
      },
    },
    'Queue invocation helper should preserve disabled invocation when upstream queue plan says no'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueInvocationPlan({
      readMessageIds: [],
      requestConversationDelivered: false,
      shouldQueueSync: true,
    }),
    {
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Queue invocation helper should suppress invocation when normalized options contain no queue work'
  );

  logger.debug('✓ testChatReceiptSyncQueueInvocationPlanHelper passed');
})();

(function testChatReceiptForegroundQueuePlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueuePlan({
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      isFocused: false,
      isAppActive: true,
      readMessageIds: ['msg-1'],
      requestConversationDelivered: true,
    }),
    {
      queueRequestPlan: {
        readMessageIds: [],
        requestConversationDelivered: false,
        shouldQueueSync: false,
      },
      shouldQueueSync: false,
    },
    'Foreground queue-plan helper should no-op when screen is not focused'
  );

  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueuePlan({
      partnerEmail: '   ',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      readMessageIds: ['msg-1'],
      requestConversationDelivered: true,
    }),
    {
      queueRequestPlan: {
        readMessageIds: [],
        requestConversationDelivered: false,
        shouldQueueSync: false,
      },
      shouldQueueSync: false,
    },
    'Foreground queue-plan helper should no-op when participant identities are unavailable'
  );

  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueuePlan({
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      readMessageIds: [' msg-1 ', 'msg-1', null],
      requestConversationDelivered: true,
    }),
    {
      queueRequestPlan: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
        shouldQueueSync: true,
      },
      shouldQueueSync: true,
    },
    'Foreground queue-plan helper should forward normalized queue request planning when prerequisites are met'
  );

  logger.debug('✓ testChatReceiptForegroundQueuePlanHelper passed');
})();

(function testChatReceiptForegroundQueueInvocationPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueueInvocationPlan({
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      isFocused: false,
      isAppActive: true,
      readMessageIds: ['msg-1'],
      requestConversationDelivered: true,
    }),
    {
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Foreground queue-invocation helper should no-op when foreground eligibility checks fail'
  );

  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueueInvocationPlan({
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      readMessageIds: [' msg-1 ', 'msg-1', null],
      requestConversationDelivered: true,
    }),
    {
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Foreground queue-invocation helper should compose foreground eligibility with normalized queue invocation options'
  );

  logger.debug('✓ testChatReceiptForegroundQueueInvocationPlanHelper passed');
})();

(function testChatReceiptForegroundQueueExecutionPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueueExecutionPlan({
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      readMessageIds: [' msg-1 ', 'msg-1', null],
      requestConversationDelivered: true,
      queueGeneration: 9,
      activeGeneration: 9,
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: true,
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Foreground queue execution helper should compose foreground eligibility, invocation normalization, and generation guard when scheduled and active generations match'
  );

  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueueExecutionPlan({
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      requestConversationDelivered: true,
      queueGeneration: 9,
      activeGeneration: 10,
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: false,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Foreground queue execution helper should suppress queue dispatch when queued execution generation becomes stale'
  );

  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueueExecutionPlan({
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      isFocused: false,
      isAppActive: true,
      readMessageIds: ['msg-1'],
      requestConversationDelivered: true,
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: true,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Foreground queue execution helper should preserve no-op behavior when foreground eligibility requirements fail and generation guard inputs are omitted'
  );

  logger.debug('✓ testChatReceiptForegroundQueueExecutionPlanHelper passed');
})();

(function testChatReceiptForegroundDelayedDeliveryTimerGenerationGuardHelper() {
  const delayedDeliveryOnlyForegroundInput = {
    partnerEmail: ' Parent@One.com ',
    userEmail: 'teacher@school.com',
    isFocused: true,
    isAppActive: true,
    requestConversationDelivered: true,
  };

  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueueExecutionPlan({
      ...delayedDeliveryOnlyForegroundInput,
      queueGeneration: 21,
      activeGeneration: 21,
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: true,
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: true,
      },
    },
    'Delayed foreground delivery-only timer path should dispatch queue work when scheduled and active generations match'
  );

  assert.deepStrictEqual(
    resolveChatReceiptForegroundQueueExecutionPlan({
      ...delayedDeliveryOnlyForegroundInput,
      queueGeneration: 21,
      activeGeneration: 22,
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: false,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Delayed foreground delivery-only timer path should suppress queue dispatch when the scheduled generation becomes stale'
  );

  logger.debug('✓ testChatReceiptForegroundDelayedDeliveryTimerGenerationGuardHelper passed');
})();

(function testChatReceiptIncomingUnreadMessageIdHelper() {
  assert.strictEqual(
    resolveChatReceiptIncomingUnreadMessageId({
      message: {
        id: ' msg-1 ',
        sender: ' Parent@One.com ',
        recipientId: ' teacher@school.com ',
        read: false,
      },
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
    }),
    'msg-1',
    'Incoming unread message-id helper should return normalized ids for unread partner->user messages'
  );

  assert.strictEqual(
    resolveChatReceiptIncomingUnreadMessageId({
      message: {
        id: 'msg-1',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: true,
      },
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
    }),
    null,
    'Incoming unread message-id helper should skip already-read messages'
  );

  assert.strictEqual(
    resolveChatReceiptIncomingUnreadMessageId({
      message: {
        id: 'msg-1',
        sender: 'teacher@school.com',
        recipientId: 'parent@one.com',
        read: false,
      },
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
    }),
    null,
    'Incoming unread message-id helper should skip messages outside the partner->user direction'
  );

  assert.strictEqual(
    resolveChatReceiptIncomingUnreadMessageId({
      message: {
        id: 'msg-1',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: false,
        deleted: true,
      },
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
    }),
    null,
    'Incoming unread message-id helper should skip deleted messages'
  );

  logger.debug('✓ testChatReceiptIncomingUnreadMessageIdHelper passed');
})();

(function testChatReceiptIncomingUnreadMessageIdForNormalizedParticipantsHelper() {
  assert.strictEqual(
    resolveChatReceiptIncomingUnreadMessageIdForNormalizedParticipants({
      message: {
        id: ' msg-2 ',
        sender: ' Parent@One.com ',
        recipientId: ' teacher@school.com ',
        read: false,
      },
      normalizedPartnerEmail: 'parent@one.com',
      normalizedUserEmail: 'teacher@school.com',
    }),
    'msg-2',
    'Normalized-participant unread helper should return unread partner->user ids without re-normalizing participant inputs per message'
  );

  assert.strictEqual(
    resolveChatReceiptIncomingUnreadMessageIdForNormalizedParticipants({
      message: {
        id: 'msg-2',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: false,
      },
      normalizedPartnerEmail: null,
      normalizedUserEmail: 'teacher@school.com',
    }),
    null,
    'Normalized-participant unread helper should no-op when normalized partner identity is missing'
  );

  logger.debug('✓ testChatReceiptIncomingUnreadMessageIdForNormalizedParticipantsHelper passed');
})();

(function testNormalizeChatReceiptSyncEmailHelper() {
  assert.strictEqual(
    normalizeChatReceiptSyncEmail(' Parent@One.com '),
    'parent@one.com',
    'Receipt email normalizer should trim and lowercase participant identities'
  );

  assert.strictEqual(
    normalizeChatReceiptSyncEmail('   '),
    null,
    'Receipt email normalizer should collapse blank values to null'
  );

  assert.strictEqual(
    normalizeChatReceiptSyncEmail(undefined),
    null,
    'Receipt email normalizer should collapse non-string values to null'
  );

  logger.debug('✓ testNormalizeChatReceiptSyncEmailHelper passed');
})();

(function testChatReceiptSyncRunContinuationHelper() {
  assert.strictEqual(
    shouldApplyChatReceiptSyncRunContinuation({
      runGeneration: 12,
      activeGeneration: 12,
    }),
    true,
    'Receipt run-continuation helper should allow finalize continuation when run and active generations match'
  );

  assert.strictEqual(
    shouldApplyChatReceiptSyncRunContinuation({
      runGeneration: 12,
      activeGeneration: 13,
    }),
    false,
    'Receipt run-continuation helper should block finalize continuation for stale run generations'
  );

  assert.strictEqual(
    shouldApplyChatReceiptSyncRunContinuation({
      runGeneration: 'invalid',
      activeGeneration: 13,
    }),
    false,
    'Receipt run-continuation helper should block continuation when generation inputs are invalid'
  );

  logger.debug('✓ testChatReceiptSyncRunContinuationHelper passed');
})();

(function testChatReceiptSyncDeferredFlushContinuationHelper() {
  assert.strictEqual(
    shouldRunChatReceiptSyncDeferredFlushContinuation({
      scheduledGeneration: 3,
      activeGeneration: 3,
    }),
    true,
    'Deferred flush continuation helper should allow scheduled callbacks when generation still matches'
  );

  assert.strictEqual(
    shouldRunChatReceiptSyncDeferredFlushContinuation({
      scheduledGeneration: 3,
      activeGeneration: 4,
    }),
    false,
    'Deferred flush continuation helper should block scheduled callbacks that became stale after generation changes'
  );

  assert.strictEqual(
    shouldRunChatReceiptSyncDeferredFlushContinuation({
      scheduledGeneration: Number.NaN,
      activeGeneration: 4,
    }),
    false,
    'Deferred flush continuation helper should block continuation for invalid generation inputs'
  );

  logger.debug('✓ testChatReceiptSyncDeferredFlushContinuationHelper passed');
})();

(function testChatReceiptSyncQueueExecutionContinuationHelper() {
  assert.strictEqual(
    shouldApplyChatReceiptSyncQueueExecutionContinuation({
      queueGeneration: 5,
      activeGeneration: 5,
    }),
    true,
    'Queue execution continuation helper should allow queue plan application when queue and active generations match'
  );

  assert.strictEqual(
    shouldApplyChatReceiptSyncQueueExecutionContinuation({
      queueGeneration: 5,
      activeGeneration: 6,
    }),
    false,
    'Queue execution continuation helper should block queue plan application for stale queue generations'
  );

  assert.strictEqual(
    shouldApplyChatReceiptSyncQueueExecutionContinuation({
      queueGeneration: undefined,
      activeGeneration: 6,
    }),
    false,
    'Queue execution continuation helper should block queue plan application when generation inputs are invalid'
  );

  logger.debug('✓ testChatReceiptSyncQueueExecutionContinuationHelper passed');
})();

(function testChatReceiptQueueInvocationExecutionPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptQueueInvocationExecutionPlan({
      queueInvocationPlan: {
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: [' msg-1 ', 'msg-1', null],
          requestConversationDelivered: true,
        },
      },
      queueGeneration: 4,
      activeGeneration: 4,
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: true,
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Queue invocation execution helper should normalize queue options and allow dispatch when generation guard matches'
  );

  assert.deepStrictEqual(
    resolveChatReceiptQueueInvocationExecutionPlan({
      queueInvocationPlan: {
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: ['msg-1'],
          requestConversationDelivered: true,
        },
      },
      queueGeneration: 4,
      activeGeneration: 5,
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: false,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Queue invocation execution helper should suppress dispatch when generation guard indicates stale invocation'
  );

  assert.deepStrictEqual(
    resolveChatReceiptQueueInvocationExecutionPlan({
      queueInvocationPlan: {
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: [],
          requestConversationDelivered: false,
        },
      },
    }),
    {
      shouldApplyQueueInvocationExecutionPlan: true,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Queue invocation execution helper should preserve backward-compatible no-op behavior when no work exists and generation guard inputs are omitted'
  );

  logger.debug('✓ testChatReceiptQueueInvocationExecutionPlanHelper passed');
})();

(function testChatViewabilityPrefetchCandidateIndicesHelper() {
  assert.deepStrictEqual(
    resolveChatViewabilityPrefetchCandidateIndices({
      viewableItems: [{ index: 3 }, { index: 5 }, { index: 3 }],
      messageCount: 12,
      behindDistance: 2,
      aheadDistance: 4,
    }),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    'Viewability prefetch candidate helper should expand and de-duplicate nearby indices in insertion order'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityPrefetchCandidateIndices({
      viewableItems: [{ index: -1 }, { index: 50 }, { index: 1.8 }, { index: '2' }],
      messageCount: 5,
      behindDistance: 2,
      aheadDistance: 4,
    }),
    [0, 1, 2, 3, 4],
    'Viewability prefetch candidate helper should ignore out-of-range and non-numeric indices while truncating finite numeric indices'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityPrefetchCandidateIndices({
      viewableItems: [{ index: 2 }],
      messageCount: 0,
      behindDistance: 2,
      aheadDistance: 4,
    }),
    [],
    'Viewability prefetch candidate helper should no-op when message count is empty'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityPrefetchCandidateIndices({
      viewableItems: [{ index: 2 }],
      messageCount: 8,
      behindDistance: -3,
      aheadDistance: 'oops',
    }),
    [0, 1, 2, 3, 4, 5, 6],
    'Viewability prefetch candidate helper should normalize invalid distance inputs using production defaults'
  );

  logger.debug('✓ testChatViewabilityPrefetchCandidateIndicesHelper passed');
})();

(function testChatViewabilityNearbyMediaPrefetchPlanHelper() {
  assert.deepStrictEqual(
    resolveChatViewabilityNearbyMediaPrefetchPlan({
      displayedMessages: [
        {
          sticker: { url: 'https://cdn.test/sticker-a.webp' },
          attachments: [
            { url: 'https://cdn.test/image-a.jpg', fileType: 'image/jpeg' },
            { url: 'https://cdn.test/video-a.mp4', fileType: 'video/mp4' },
          ],
        },
        {
          gif: { url: 'https://cdn.test/gif-a.gif' },
          attachments: [
            { url: 'https://cdn.test/image-a.jpg', fileType: 'image/jpeg' },
          ],
        },
        {
          sticker: { url: 'https://cdn.test/sticker-a.webp' },
          gif: { url: 'https://cdn.test/gif-b.gif' },
          attachments: [
            { url: 'https://cdn.test/image-b.png', fileName: 'photo.png' },
          ],
        },
      ],
      candidateIndices: [0, 1, 1, 2, 99, -1, Number.NaN],
      stickerUrlMap: new Map([
        ['https://cdn.test/sticker-a.webp', 'https://cdn.test/sticker-a-local.webp'],
      ]),
      gifUrlMap: new Map([
        ['https://cdn.test/gif-a.gif', 'https://cdn.test/gif-a-local.gif'],
      ]),
      isWeb: false,
      shouldPrefetchAttachment: (attachment) =>
        String(attachment?.fileType || '').startsWith('image/'),
    }),
    {
      immediatePrefetchUrls: [
        'https://cdn.test/sticker-a-local.webp',
        'https://cdn.test/image-a.jpg',
        'https://cdn.test/gif-a-local.gif',
        'https://cdn.test/gif-b.gif',
      ],
      stickerResolveUrls: ['https://cdn.test/sticker-a.webp'],
      gifResolveUrls: ['https://cdn.test/gif-a.gif', 'https://cdn.test/gif-b.gif'],
    },
    'Nearby-media prefetch plan helper should dedupe immediate prefetch urls and resolver urls while honoring attachment predicate filtering'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityNearbyMediaPrefetchPlan({
      displayedMessages: [
        {
          sticker: { url: 'https://cdn.test/sticker-a.webp' },
          gif: { url: 'https://cdn.test/gif-a.gif' },
        },
      ],
      candidateIndices: [0],
      isWeb: true,
    }),
    {
      immediatePrefetchUrls: [
        'https://cdn.test/sticker-a.webp',
        'https://cdn.test/gif-a.gif',
      ],
      stickerResolveUrls: [],
      gifResolveUrls: [],
    },
    'Nearby-media prefetch plan helper should suppress resolver queues in web mode while still returning immediate prefetch urls'
  );

  logger.debug('✓ testChatViewabilityNearbyMediaPrefetchPlanHelper passed');
})();

(function testChatViewabilityWindowSummaryHelper() {
  assert.deepStrictEqual(
    resolveChatViewabilityWindowSummary({
      viewableItems: [
        null,
        { index: -1, item: { id: 'ignored' } },
        { index: 6, item: { id: 'msg-6' } },
        { index: 2, item: { id: 'msg-2' } },
      ],
      unreadMessageId: 'msg-2',
    }),
    {
      hasUnreadTarget: true,
      isUnreadVisible: true,
      topVisibleIndex: 2,
      topVisibleMessageId: 'msg-2',
      bottomVisibleIndex: 6,
    },
    'Viewability window summary helper should resolve top/bottom indices and unread visibility in one pass'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityWindowSummary({
      viewableItems: [
        { index: 1, item: {} },
        { index: 4, item: { id: 'msg-4' } },
      ],
      unreadMessageId: undefined,
    }),
    {
      hasUnreadTarget: false,
      isUnreadVisible: false,
      topVisibleIndex: 1,
      topVisibleMessageId: null,
      bottomVisibleIndex: 4,
    },
    'Viewability window summary helper should expose null top message ids when the top visible item has no id'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityWindowSummary({
      viewableItems: [
        { index: NaN, item: { id: 'msg-a' } },
        { index: '2', item: { id: 'msg-b' } },
      ],
      unreadMessageId: 'msg-a',
    }),
    {
      hasUnreadTarget: true,
      isUnreadVisible: false,
      topVisibleIndex: null,
      topVisibleMessageId: null,
      bottomVisibleIndex: null,
    },
    'Viewability window summary helper should ignore non-finite and non-numeric indices'
  );

  logger.debug('✓ testChatViewabilityWindowSummaryHelper passed');
})();

(function testChatUnreadSeparatorVisibilityPlanHelper() {
  assert.deepStrictEqual(
    resolveChatUnreadSeparatorVisibilityPlan({
      hasUnreadTarget: false,
      isUnreadVisible: false,
      hasAcknowledgedUnread: true,
      incomingUnreadCount: 0,
      unreadDividerSeedCount: 0,
    }),
    {
      nextUnreadSeparatorIsVisible: false,
      shouldAcknowledgeUnread: false,
      shouldClearDismissTimeout: false,
      shouldScheduleDismiss: false,
    },
    'Unread separator visibility plan helper should clear visibility without side effects when unread target is absent'
  );

  assert.deepStrictEqual(
    resolveChatUnreadSeparatorVisibilityPlan({
      hasUnreadTarget: true,
      isUnreadVisible: true,
      hasAcknowledgedUnread: false,
      incomingUnreadCount: 2,
      unreadDividerSeedCount: 1,
    }),
    {
      nextUnreadSeparatorIsVisible: true,
      shouldAcknowledgeUnread: true,
      shouldClearDismissTimeout: true,
      shouldScheduleDismiss: false,
    },
    'Unread separator visibility plan helper should acknowledge unread and clear pending dismiss timeout when unread target is visible'
  );

  assert.deepStrictEqual(
    resolveChatUnreadSeparatorVisibilityPlan({
      hasUnreadTarget: true,
      isUnreadVisible: false,
      hasAcknowledgedUnread: true,
      incomingUnreadCount: 0,
      unreadDividerSeedCount: 0,
    }),
    {
      nextUnreadSeparatorIsVisible: false,
      shouldAcknowledgeUnread: false,
      shouldClearDismissTimeout: false,
      shouldScheduleDismiss: true,
    },
    'Unread separator visibility plan helper should schedule dismiss only when unread has been acknowledged and both unread counters are exhausted'
  );

  logger.debug('✓ testChatUnreadSeparatorVisibilityPlanHelper passed');
})();

(function testChatTopWindowActionPlanHelper() {
  assert.deepStrictEqual(
    resolveChatTopWindowActionPlan({
      topVisibleIndex: null,
      topVisibleMessageId: null,
      shouldUseManualAnchorPreservation: true,
      hasPendingPrependAnchor: true,
      isInitialAnchorSettled: true,
      hasUserInteracted: true,
      allowTopAutoPagination: true,
      topAutoLoadThreshold: 4,
      currentAutoLoadAnchorId: 'msg-1',
      topPrefetchThreshold: 6,
    }),
    {
      shouldUpdateTopVisibleMessage: false,
      nextTopVisibleIndex: null,
      nextTopVisibleMessageId: null,
      shouldRequestOlder: false,
      shouldWarmNextPage: false,
      shouldResetAutoLoadAnchor: true,
      nextAutoLoadAnchorId: null,
    },
    'Top-window action plan helper should request auto-load anchor reset when top visible metadata is unavailable'
  );

  assert.deepStrictEqual(
    resolveChatTopWindowActionPlan({
      topVisibleIndex: 2,
      topVisibleMessageId: 'msg-2',
      shouldUseManualAnchorPreservation: false,
      hasPendingPrependAnchor: false,
      isInitialAnchorSettled: true,
      hasUserInteracted: true,
      allowTopAutoPagination: true,
      topAutoLoadThreshold: 4,
      currentAutoLoadAnchorId: 'msg-1',
      topPrefetchThreshold: 3,
    }),
    {
      shouldUpdateTopVisibleMessage: true,
      nextTopVisibleIndex: 2,
      nextTopVisibleMessageId: 'msg-2',
      shouldRequestOlder: true,
      shouldWarmNextPage: true,
      shouldResetAutoLoadAnchor: false,
      nextAutoLoadAnchorId: 'msg-2',
    },
    'Top-window action plan helper should request older history and update auto-load anchor when top index crosses pagination threshold'
  );

  assert.deepStrictEqual(
    resolveChatTopWindowActionPlan({
      topVisibleIndex: 8,
      topVisibleMessageId: 'msg-8',
      shouldUseManualAnchorPreservation: false,
      hasPendingPrependAnchor: false,
      isInitialAnchorSettled: true,
      hasUserInteracted: true,
      allowTopAutoPagination: true,
      topAutoLoadThreshold: 4,
      currentAutoLoadAnchorId: 'msg-2',
      topPrefetchThreshold: 3,
    }),
    {
      shouldUpdateTopVisibleMessage: true,
      nextTopVisibleIndex: 8,
      nextTopVisibleMessageId: 'msg-8',
      shouldRequestOlder: false,
      shouldWarmNextPage: false,
      shouldResetAutoLoadAnchor: true,
      nextAutoLoadAnchorId: null,
    },
    'Top-window action plan helper should reset auto-load anchor after moving away from top pagination region'
  );

  logger.debug('✓ testChatTopWindowActionPlanHelper passed');
})();

(function testChatViewabilityReceiptCollectionHelper() {
  assert.deepStrictEqual(
    resolveChatViewabilityReceiptCollection({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: ' parent@one.com ',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [
              { url: 'https://cdn.test/a.png', fileName: 'a.png' },
              { url: 'https://cdn.test/a.png', fileName: 'a.png' },
            ],
          },
        },
        {
          item: {
            id: 'msg-2',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [
              { url: 'file:///local/path.png', fileName: 'local.png' },
              { url: 'https://cdn.test/b.png', fileName: '' },
            ],
          },
        },
        {
          item: {
            id: 'msg-2',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/c.png', fileName: 'c.png' }],
          },
        },
      ],
      normalizedPartnerEmail: 'parent@one.com',
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 2,
    }),
    {
      warmTargets: [
        { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
        { remoteUrl: 'https://cdn.test/b.png' },
      ],
      visibleUnreadIncomingIds: ['msg-1', 'msg-2'],
    },
    'Viewability receipt collection helper should cap + dedupe warm targets and dedupe visible unread ids'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityReceiptCollection({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/a.png', fileName: 'a.png' }],
          },
        },
      ],
      normalizedPartnerEmail: null,
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 'invalid',
    }),
    {
      warmTargets: [{ remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' }],
      visibleUnreadIncomingIds: [],
    },
    'Viewability receipt collection helper should still collect warm targets when participant identities are missing while unread ids remain unavailable'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityReceiptCollection({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/a.png', fileName: 'a.png' }],
          },
        },
      ],
      normalizedPartnerEmail: 'parent@one.com',
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 0,
    }),
    {
      warmTargets: [],
      visibleUnreadIncomingIds: ['msg-1'],
    },
    'Viewability receipt collection helper should allow disabling warm target collection while still collecting unread ids'
  );

  logger.debug('✓ testChatViewabilityReceiptCollectionHelper passed');
})();

(function testChatViewabilityWarmTargetPrefetchHelpers() {
  assert.deepStrictEqual(
    resolveChatViewabilityWarmTargetPrefetchPlan({
      warmTargets: [
        { remoteUrl: 'https://cdn.test/a.png', fileName: ' a.png ' },
        { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
        { remoteUrl: 'https://cdn.test/b.png', fileName: '' },
        { remoteUrl: 'file:///tmp/c.png', fileName: 'c.png' },
        { remoteUrl: '  ' },
        null,
      ],
    }),
    {
      shouldPrefetchWarmTargets: true,
      warmTargets: [
        { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
        { remoteUrl: 'https://cdn.test/b.png' },
      ],
    },
    'Warm-target prefetch plan helper should normalize, filter, and dedupe warm targets'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityWarmTargetPrefetchPlan({ warmTargets: [] }),
    {
      shouldPrefetchWarmTargets: false,
      warmTargets: [],
    },
    'Warm-target prefetch plan helper should no-op when no normalized targets are available'
  );

  const prefetchedTargets = [];
  const appliedPlan = applyChatViewabilityWarmTargetPrefetch({
    warmTargets: [
      { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
      { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
      { remoteUrl: 'https://cdn.test/b.png' },
    ],
    prefetchWarmTarget: (warmTarget) => {
      prefetchedTargets.push(warmTarget);
      if (warmTarget.remoteUrl.endsWith('/b.png')) {
        return Promise.reject(new Error('expected rejection path'));
      }

      return Promise.resolve();
    },
  });

  assert.deepStrictEqual(
    appliedPlan,
    {
      shouldPrefetchWarmTargets: true,
      warmTargets: [
        { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
        { remoteUrl: 'https://cdn.test/b.png' },
      ],
    },
    'Warm-target prefetch apply helper should return the same normalized plan output used for scheduling'
  );
  assert.deepStrictEqual(
    prefetchedTargets,
    [
      { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
      { remoteUrl: 'https://cdn.test/b.png' },
    ],
    'Warm-target prefetch apply helper should call prefetch exactly once for each normalized target'
  );

  assert.deepStrictEqual(
    applyChatViewabilityWarmTargetPrefetch({
      warmTargets: [{ remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' }],
      prefetchWarmTarget: 'invalid-prefetcher',
    }),
    {
      shouldPrefetchWarmTargets: true,
      warmTargets: [{ remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' }],
    },
    'Warm-target prefetch apply helper should preserve plan output and skip scheduling when prefetch callback wiring is invalid'
  );

  logger.debug('✓ testChatViewabilityWarmTargetPrefetchHelpers passed');
})();

(function testChatViewabilityReceiptQueueDispatchPlanHelper() {
  let fallbackReason = null;
  assert.deepStrictEqual(
    resolveChatViewabilityReceiptQueueDispatchPlan({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: ' parent@one.com ',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/a.png', fileName: 'a.png' }],
          },
        },
        {
          item: {
            id: 'msg-2',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/b.png', fileName: '' }],
          },
        },
      ],
      normalizedPartnerEmail: 'parent@one.com',
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 3,
      lastDeliverySyncMarker: {
        partnerEmail: 'other@one.com',
        at: 950,
      },
      resolveQueueDispatchPlan: resolveChatReceiptViewabilityQueueDispatchPlanForMarker,
      nowMs: 1000,
      cooldownMs: 15000,
      queueGeneration: 12,
      activeGeneration: 12,
      onQueueDispatchResolverFallback: (reason) => {
        fallbackReason = reason;
      },
    }),
    {
      warmTargets: [
        { remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' },
        { remoteUrl: 'https://cdn.test/b.png' },
      ],
      visibleUnreadIncomingIds: ['msg-1', 'msg-2'],
      queueDispatchPlan: {
        shouldApplyViewabilityQueueDispatchPlan: true,
        nextDeliverySyncMarker: {
          partnerEmail: 'parent@one.com',
          at: 1000,
        },
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: ['msg-1', 'msg-2'],
          requestConversationDelivered: true,
        },
      },
    },
    'Composed viewability collection+dispatch helper should return warm targets, unread ids, and generation-gated queue dispatch output in one payload'
  );
  assert.strictEqual(
    fallbackReason,
    null,
    'Composed viewability collection+dispatch helper should not emit resolver fallback signals when resolver wiring is valid'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityReceiptQueueDispatchPlan({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/a.png', fileName: 'a.png' }],
          },
        },
      ],
      normalizedPartnerEmail: 'parent@one.com',
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 1,
      lastDeliverySyncMarker: {
        partnerEmail: 'other@one.com',
        at: 950,
      },
      resolveQueueDispatchPlan: resolveChatReceiptViewabilityQueueDispatchPlanForMarker,
      nowMs: 1000,
      cooldownMs: 15000,
      queueGeneration: 12,
      activeGeneration: 13,
    }),
    {
      warmTargets: [{ remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' }],
      visibleUnreadIncomingIds: ['msg-1'],
      queueDispatchPlan: {
        shouldApplyViewabilityQueueDispatchPlan: false,
        nextDeliverySyncMarker: null,
        shouldQueueSync: false,
        queueOptions: {
          readMessageIds: [],
          requestConversationDelivered: false,
        },
      },
    },
    'Composed viewability collection+dispatch helper should preserve stale-generation suppression while still returning collection outputs'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityReceiptQueueDispatchPlan({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/a.png', fileName: 'a.png' }],
          },
        },
      ],
      normalizedPartnerEmail: null,
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 1,
      lastDeliverySyncMarker: {
        partnerEmail: 'other@one.com',
        at: 950,
      },
      resolveQueueDispatchPlan: resolveChatReceiptViewabilityQueueDispatchPlanForMarker,
      nowMs: 1000,
      cooldownMs: 15000,
      queueGeneration: 12,
      activeGeneration: 12,
    }),
    {
      warmTargets: [{ remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' }],
      visibleUnreadIncomingIds: [],
      queueDispatchPlan: {
        shouldApplyViewabilityQueueDispatchPlan: true,
        nextDeliverySyncMarker: null,
        shouldQueueSync: false,
        queueOptions: {
          readMessageIds: [],
          requestConversationDelivered: false,
        },
      },
    },
    'Composed viewability collection+dispatch helper should keep warm-target collection active while shaping receipt queue dispatch as a no-op when participant identities are unavailable'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityReceiptQueueDispatchPlan({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/a.png', fileName: 'a.png' }],
          },
        },
      ],
      normalizedPartnerEmail: 'parent@one.com',
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 1,
      lastDeliverySyncMarker: {
        partnerEmail: 'other@one.com',
        at: 950,
      },
      onQueueDispatchResolverFallback: (reason) => {
        fallbackReason = reason;
      },
    }),
    {
      warmTargets: [{ remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' }],
      visibleUnreadIncomingIds: ['msg-1'],
      queueDispatchPlan: {
        shouldApplyViewabilityQueueDispatchPlan: false,
        nextDeliverySyncMarker: null,
        shouldQueueSync: false,
        queueOptions: {
          readMessageIds: [],
          requestConversationDelivered: false,
        },
      },
    },
    'Composed viewability collection+dispatch helper should fall back to a safe no-op queue dispatch plan when resolver wiring is missing at runtime'
  );
  assert.strictEqual(
    fallbackReason,
    'missing',
    'Composed viewability collection+dispatch helper should signal missing resolver fallback reason when resolver wiring is absent'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityReceiptQueueDispatchPlan({
      viewableEntries: [
        {
          item: {
            id: 'msg-1',
            sender: 'parent@one.com',
            recipientId: 'teacher@school.com',
            read: false,
            attachments: [{ url: 'https://cdn.test/a.png', fileName: 'a.png' }],
          },
        },
      ],
      normalizedPartnerEmail: 'parent@one.com',
      normalizedUserEmail: 'teacher@school.com',
      maxWarmTargets: 1,
      lastDeliverySyncMarker: {
        partnerEmail: 'other@one.com',
        at: 950,
      },
      resolveQueueDispatchPlan: 'invalid-resolver',
      onQueueDispatchResolverFallback: (reason) => {
        fallbackReason = reason;
      },
    }),
    {
      warmTargets: [{ remoteUrl: 'https://cdn.test/a.png', fileName: 'a.png' }],
      visibleUnreadIncomingIds: ['msg-1'],
      queueDispatchPlan: {
        shouldApplyViewabilityQueueDispatchPlan: false,
        nextDeliverySyncMarker: null,
        shouldQueueSync: false,
        queueOptions: {
          readMessageIds: [],
          requestConversationDelivered: false,
        },
      },
    },
    'Composed viewability collection+dispatch helper should return the same safe no-op dispatch payload when resolver wiring exists but is not a function'
  );
  assert.strictEqual(
    fallbackReason,
    'invalid',
    'Composed viewability collection+dispatch helper should signal invalid resolver fallback reason when resolver wiring is not callable'
  );

  logger.debug('✓ testChatViewabilityReceiptQueueDispatchPlanHelper passed');
})();

(function testChatViewabilityQueueDispatchEffectsPlanHelper() {
  assert.deepStrictEqual(
    resolveChatViewabilityQueueDispatchEffectsPlan({
      shouldApplyViewabilityQueueDispatchPlan: true,
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: [' msg-1 ', 'msg-1', null],
        requestConversationDelivered: true,
      },
    }),
    {
      shouldApplyQueueDispatchEffectsPlan: true,
      shouldUpdateDeliverySyncMarker: true,
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Viewability queue-dispatch effects helper should normalize queue options and preserve marker/queue effects when dispatch plan applies'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityQueueDispatchEffectsPlan({
      shouldApplyViewabilityQueueDispatchPlan: false,
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    }),
    {
      shouldApplyQueueDispatchEffectsPlan: false,
      shouldUpdateDeliverySyncMarker: false,
      nextDeliverySyncMarker: null,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Viewability queue-dispatch effects helper should suppress marker and queue side effects when dispatch plan does not apply'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityQueueDispatchEffectsPlan({
      shouldApplyViewabilityQueueDispatchPlan: true,
      nextDeliverySyncMarker: null,
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    }),
    {
      shouldApplyQueueDispatchEffectsPlan: true,
      shouldUpdateDeliverySyncMarker: false,
      nextDeliverySyncMarker: null,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Viewability queue-dispatch effects helper should block queue dispatch when queue options contain no normalized work'
  );

  logger.debug('✓ testChatViewabilityQueueDispatchEffectsPlanHelper passed');
})();

(function testChatViewabilityQueueDispatchResolverFallbackMetricHelpers() {
  assert.deepStrictEqual(
    resolveChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlan({
      reason: 'missing',
      lastMetricState: {
        reason: 'missing',
        at: 1000,
      },
      nowMs: 12000,
      cooldownMs: 15000,
    }),
    {
      shouldEmitMetric: false,
      nextMetricState: {
        reason: 'missing',
        at: 1000,
      },
    },
    'Resolver-fallback metric throttle helper should suppress repeated emissions for the same reason within cooldown'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityQueueDispatchResolverFallbackMetricThrottlePlan({
      reason: 'invalid',
      lastMetricState: {
        reason: 'missing',
        at: 1000,
      },
      nowMs: 2000,
      cooldownMs: 15000,
    }),
    {
      shouldEmitMetric: true,
      nextMetricState: {
        reason: 'invalid',
        at: 2000,
      },
    },
    'Resolver-fallback metric throttle helper should allow emissions when the fallback reason changes'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityQueueDispatchResolverFallbackMetricPayload({
      reason: 'missing',
      hasPartnerEmail: true,
      hasUserEmail: false,
      queueGeneration: '7.8',
      activeGeneration: 10,
    }),
    {
      reason: 'missing',
      hasPartnerEmail: true,
      hasUserEmail: false,
      queueGeneration: 7,
      activeGeneration: 10,
      generationDelta: 3,
    },
    'Resolver-fallback metric payload helper should normalize generation fields and include generation delta when both are finite'
  );

  assert.deepStrictEqual(
    resolveChatViewabilityQueueDispatchResolverFallbackMetricPayload({
      reason: 'invalid',
      hasPartnerEmail: 'true',
      hasUserEmail: 1,
      queueGeneration: 'oops',
      activeGeneration: Number.NaN,
    }),
    {
      reason: 'invalid',
      hasPartnerEmail: false,
      hasUserEmail: false,
      queueGeneration: null,
      activeGeneration: null,
      generationDelta: null,
    },
    'Resolver-fallback metric payload helper should coerce non-boolean flags and non-finite generations into safe null/false values'
  );

  logger.debug('✓ testChatViewabilityQueueDispatchResolverFallbackMetricHelpers passed');
})();

(function testChatReceiptSyncQueueSchedulePlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueSchedulePlan({
      options: {
        readMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
        requestConversationDelivered: true,
      },
      requestedReadMessageIds: new Set(['msg-2']),
      queuedReadMessageIds: new Set(['msg-0']),
      requestConversationDelivered: false,
      hasPendingTimeout: false,
    }),
    {
      queueApplyPlan: {
        addMessageIds: ['msg-1'],
        nextRequestConversationDelivered: true,
        nextQueuedReadMessageCount: 2,
      },
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: true,
        shouldFlushImmediately: false,
      },
    },
    'Queue-schedule plan helper should compose queue update/apply and deferred follow-up scheduling intent'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueSchedulePlan({
      options: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
      requestedReadMessageIds: new Set(),
      queuedReadMessageIds: new Set(),
      requestConversationDelivered: false,
      hasPendingTimeout: false,
    }),
    {
      queueApplyPlan: {
        addMessageIds: [],
        nextRequestConversationDelivered: false,
        nextQueuedReadMessageCount: 0,
      },
      followupTriggerPlan: {
        shouldScheduleFollowup: false,
        shouldScheduleDeferredFlush: false,
        shouldFlushImmediately: false,
      },
    },
    'Queue-schedule plan helper should no-op when no queue work exists'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueSchedulePlan({
      options: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
      requestedReadMessageIds: new Set(),
      queuedReadMessageIds: new Set(),
      requestConversationDelivered: false,
      hasPendingTimeout: true,
    }),
    {
      queueApplyPlan: {
        addMessageIds: ['msg-1'],
        nextRequestConversationDelivered: true,
        nextQueuedReadMessageCount: 1,
      },
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: false,
        shouldFlushImmediately: false,
      },
    },
    'Queue-schedule plan helper should suppress deferred timer scheduling when a timeout is already pending'
  );

  logger.debug('✓ testChatReceiptSyncQueueSchedulePlanHelper passed');
})();

(function testChatReceiptSyncQueueDeferredFlushPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueDeferredFlushPlan({
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: true,
        shouldFlushImmediately: false,
      },
      deferredFlushDelayMs: 140,
    }),
    {
      shouldScheduleDeferredFlush: true,
      deferredFlushDelayMs: 140,
    },
    'Queue deferred-flush helper should keep scheduling enabled and preserve normalized positive delay values'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueDeferredFlushPlan({
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: true,
        shouldFlushImmediately: false,
      },
      deferredFlushDelayMs: 0,
    }),
    {
      shouldScheduleDeferredFlush: true,
      deferredFlushDelayMs: 120,
    },
    'Queue deferred-flush helper should fall back to default delay when scheduling is enabled but delay is missing/invalid'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueDeferredFlushPlan({
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: false,
        shouldFlushImmediately: false,
      },
      deferredFlushDelayMs: 160,
    }),
    {
      shouldScheduleDeferredFlush: false,
      deferredFlushDelayMs: 0,
    },
    'Queue deferred-flush helper should suppress delay scheduling when follow-up trigger plan does not request deferred flush'
  );

  logger.debug('✓ testChatReceiptSyncQueueDeferredFlushPlanHelper passed');
})();

(function testChatReceiptSyncQueueScheduleDeferredFlushPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueScheduleDeferredFlushPlan({
      queueSchedulePlan: {
        queueApplyPlan: {
          addMessageIds: ['msg-1'],
          nextRequestConversationDelivered: true,
          nextQueuedReadMessageCount: 2,
        },
        followupTriggerPlan: {
          shouldScheduleFollowup: true,
          shouldScheduleDeferredFlush: true,
          shouldFlushImmediately: false,
        },
      },
      deferredFlushDelayMs: 140,
    }),
    {
      shouldScheduleDeferredFlush: true,
      deferredFlushDelayMs: 140,
    },
    'Queue schedule deferred-flush helper should compose follow-up trigger inputs from queue schedule plans'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueScheduleDeferredFlushPlan({
      queueSchedulePlan: {
        queueApplyPlan: {
          addMessageIds: [],
          nextRequestConversationDelivered: false,
          nextQueuedReadMessageCount: 0,
        },
        followupTriggerPlan: {
          shouldScheduleFollowup: false,
          shouldScheduleDeferredFlush: false,
          shouldFlushImmediately: false,
        },
      },
      deferredFlushDelayMs: 160,
    }),
    {
      shouldScheduleDeferredFlush: false,
      deferredFlushDelayMs: 0,
    },
    'Queue schedule deferred-flush helper should suppress scheduling when queue schedule follow-up trigger does not request deferred work'
  );

  logger.debug('✓ testChatReceiptSyncQueueScheduleDeferredFlushPlanHelper passed');
})();

(function testApplyChatReceiptSyncQueueScheduleExecutionPlanHelper() {
  const queuedReadIds = new Set(['msg-0']);
  const executionPlan = applyChatReceiptSyncQueueScheduleExecutionPlan({
    queuedReadMessageIds: queuedReadIds,
    requestConversationDelivered: false,
    queueSchedulePlan: {
      queueApplyPlan: {
        addMessageIds: [' msg-1 ', 'msg-1', null],
        nextRequestConversationDelivered: true,
        nextQueuedReadMessageCount: 2,
      },
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: true,
        shouldFlushImmediately: false,
      },
    },
    deferredFlushDelayMs: 140,
  });

  assert.deepStrictEqual(
    Array.from(executionPlan.nextQueuedState.queuedReadMessageIds.values()).sort(),
    ['msg-0', 'msg-1'],
    'Queue schedule execution helper should apply queue updates to queued state via normalized ids'
  );

  assert.strictEqual(
    executionPlan.nextQueuedState.requestConversationDelivered,
    true,
    'Queue schedule execution helper should propagate queue-derived delivery request state'
  );

  assert.deepStrictEqual(
    executionPlan.deferredFlushPlan,
    {
      shouldScheduleDeferredFlush: true,
      deferredFlushDelayMs: 140,
    },
    'Queue schedule execution helper should compose deferred flush scheduling output from queue schedule plans'
  );

  const queuedReadIdsNoFlush = new Set(['msg-7']);
  const noFlushExecutionPlan = applyChatReceiptSyncQueueScheduleExecutionPlan({
    queuedReadMessageIds: queuedReadIdsNoFlush,
    requestConversationDelivered: true,
    queueSchedulePlan: {
      queueApplyPlan: {
        addMessageIds: [],
        nextRequestConversationDelivered: false,
        nextQueuedReadMessageCount: 1,
      },
      followupTriggerPlan: {
        shouldScheduleFollowup: false,
        shouldScheduleDeferredFlush: false,
        shouldFlushImmediately: false,
      },
    },
    deferredFlushDelayMs: 180,
  });

  assert.deepStrictEqual(
    Array.from(noFlushExecutionPlan.nextQueuedState.queuedReadMessageIds.values()),
    ['msg-7'],
    'Queue schedule execution helper should preserve queued ids when queue apply plan has no additions'
  );

  assert.strictEqual(
    noFlushExecutionPlan.nextQueuedState.requestConversationDelivered,
    true,
    'Queue schedule execution helper should preserve existing delivery request state when queue apply plan does not set it'
  );

  assert.deepStrictEqual(
    noFlushExecutionPlan.deferredFlushPlan,
    {
      shouldScheduleDeferredFlush: false,
      deferredFlushDelayMs: 0,
    },
    'Queue schedule execution helper should suppress deferred scheduling when follow-up trigger plan does not request deferred flush'
  );

  logger.debug('✓ testApplyChatReceiptSyncQueueScheduleExecutionPlanHelper passed');
})();

(function testResolveChatReceiptSyncQueueExecutionPlanHelper() {
  const queuedReadIds = new Set(['msg-0']);
  const queueExecutionPlan = resolveChatReceiptSyncQueueExecutionPlan({
    options: {
      readMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
      requestConversationDelivered: true,
    },
    requestedReadMessageIds: new Set(['msg-2']),
    queuedReadMessageIds: queuedReadIds,
    requestConversationDelivered: false,
    hasPendingTimeout: false,
    deferredFlushDelayMs: 130,
    queueGeneration: 4,
    activeGeneration: 4,
  });

  assert.strictEqual(
    queueExecutionPlan.shouldApplyQueueExecutionPlan,
    true,
    'Queue execution resolver should allow queue apply/scheduling when queue generation matches active generation'
  );

  assert.deepStrictEqual(
    Array.from(queueExecutionPlan.nextQueuedState.queuedReadMessageIds.values()).sort(),
    ['msg-0', 'msg-1'],
    'Queue execution resolver should compose queue update/schedule planning with queue apply state mutation'
  );

  assert.strictEqual(
    queueExecutionPlan.nextQueuedState.requestConversationDelivered,
    true,
    'Queue execution resolver should project delivery request state from composed queue schedule output'
  );

  assert.deepStrictEqual(
    queueExecutionPlan.deferredFlushPlan,
    {
      shouldScheduleDeferredFlush: true,
      deferredFlushDelayMs: 130,
    },
    'Queue execution resolver should surface deferred flush scheduling output from composed queue schedule execution'
  );

  const noWorkExecutionPlan = resolveChatReceiptSyncQueueExecutionPlan({
    options: {
      readMessageIds: [],
      requestConversationDelivered: false,
    },
    requestedReadMessageIds: new Set(),
    queuedReadMessageIds: new Set(),
    requestConversationDelivered: false,
    hasPendingTimeout: false,
    deferredFlushDelayMs: 180,
  });

  assert.strictEqual(
    noWorkExecutionPlan.shouldApplyQueueExecutionPlan,
    true,
    'Queue execution resolver should default to applying queue plans when generation guard inputs are not provided'
  );

  assert.deepStrictEqual(
    Array.from(noWorkExecutionPlan.nextQueuedState.queuedReadMessageIds.values()),
    [],
    'Queue execution resolver should preserve empty queue state when no read or delivery work exists'
  );

  assert.strictEqual(
    noWorkExecutionPlan.nextQueuedState.requestConversationDelivered,
    false,
    'Queue execution resolver should preserve false delivery request state when composed queue schedule has no work'
  );

  assert.deepStrictEqual(
    noWorkExecutionPlan.deferredFlushPlan,
    {
      shouldScheduleDeferredFlush: false,
      deferredFlushDelayMs: 0,
    },
    'Queue execution resolver should suppress deferred flush scheduling when composed queue schedule has no work'
  );

  const staleQueuedReadIds = new Set(['msg-9']);
  const staleExecutionPlan = resolveChatReceiptSyncQueueExecutionPlan({
    options: {
      readMessageIds: ['msg-10'],
      requestConversationDelivered: true,
    },
    requestedReadMessageIds: new Set(),
    queuedReadMessageIds: staleQueuedReadIds,
    requestConversationDelivered: true,
    hasPendingTimeout: false,
    deferredFlushDelayMs: 170,
    queueGeneration: 8,
    activeGeneration: 9,
  });

  assert.strictEqual(
    staleExecutionPlan.shouldApplyQueueExecutionPlan,
    false,
    'Queue execution resolver should suppress stale queue plans when queue and active generations diverge'
  );

  assert.deepStrictEqual(
    Array.from(staleExecutionPlan.nextQueuedState.queuedReadMessageIds.values()),
    ['msg-9'],
    'Queue execution resolver should preserve queued ids without mutation when stale queue plans are rejected'
  );

  assert.strictEqual(
    staleExecutionPlan.nextQueuedState.requestConversationDelivered,
    true,
    'Queue execution resolver should preserve existing delivery-request state when stale queue plans are rejected'
  );

  assert.deepStrictEqual(
    staleExecutionPlan.deferredFlushPlan,
    {
      shouldScheduleDeferredFlush: false,
      deferredFlushDelayMs: 0,
    },
    'Queue execution resolver should suppress deferred flush scheduling when stale queue plans are rejected'
  );

  logger.debug('✓ testResolveChatReceiptSyncQueueExecutionPlanHelper passed');
})();

(function testChatReceiptSyncFlushPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushPlan({
      partnerEmail: 'Parent@One.com',
      userEmail: 'teacher@school.com',
      isFocused: false,
      isAppActive: true,
      queuedReadMessageIds: new Set(['msg-1']),
      requestConversationDelivered: true,
    }),
    {
      shouldResetQueue: true,
      shouldSync: false,
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
      readMessageIds: [],
      requestConversationDelivered: false,
    },
    'Receipt flush-plan helper should force queue reset when foreground prerequisites are not met'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushPlan({
      partnerEmail: 'Parent@One.com',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      queuedReadMessageIds: new Set([' msg-1 ', 'msg-1', '', 'msg-2']),
      requestConversationDelivered: false,
    }),
    {
      shouldResetQueue: false,
      shouldSync: true,
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
      readMessageIds: ['msg-1', 'msg-2'],
      requestConversationDelivered: false,
    },
    'Receipt flush-plan helper should normalize and de-duplicate queued ids before sync'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushPlan({
      partnerEmail: 'Parent@One.com',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      queuedReadMessageIds: [],
      requestConversationDelivered: true,
    }),
    {
      shouldResetQueue: false,
      shouldSync: true,
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
      readMessageIds: [],
      requestConversationDelivered: true,
    },
    'Receipt flush-plan helper should allow delivery-only sync when read queue is empty'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushPlan({
      partnerEmail: 'Parent@One.com',
      userEmail: 'teacher@school.com',
      isFocused: true,
      isAppActive: true,
      queuedReadMessageIds: [],
      requestConversationDelivered: false,
    }),
    {
      shouldResetQueue: false,
      shouldSync: false,
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
      readMessageIds: [],
      requestConversationDelivered: false,
    },
    'Receipt flush-plan helper should skip sync when there is no queued work'
  );

  logger.debug('✓ testChatReceiptSyncFlushPlanHelper passed');
})();

(function testChatReceiptSyncFlushExecutionPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushExecutionPlan({
      shouldResetQueue: true,
      shouldSync: true,
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      readMessageIds: ['msg-1'],
      requestConversationDelivered: true,
    }),
    {
      shouldClearQueue: true,
      shouldRunSync: false,
      partnerEmail: 'parent@one.com',
      readMessageIds: [],
      requestConversationDelivered: false,
    },
    'Receipt flush-execution helper should prioritize queue-reset plans and skip sync work'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushExecutionPlan({
      shouldResetQueue: false,
      shouldSync: false,
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      readMessageIds: [' msg-1 ', 'msg-1'],
      requestConversationDelivered: true,
    }),
    {
      shouldClearQueue: true,
      shouldRunSync: false,
      partnerEmail: 'parent@one.com',
      readMessageIds: ['msg-1'],
      requestConversationDelivered: true,
    },
    'Receipt flush-execution helper should preserve normalized payload details when sync is skipped'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushExecutionPlan({
      shouldResetQueue: false,
      shouldSync: true,
      partnerEmail: ' Parent@One.com ',
      userEmail: 'teacher@school.com',
      readMessageIds: [' msg-1 ', 'msg-2', 'msg-1'],
      requestConversationDelivered: false,
    }),
    {
      shouldClearQueue: true,
      shouldRunSync: true,
      partnerEmail: 'parent@one.com',
      readMessageIds: ['msg-1', 'msg-2'],
      requestConversationDelivered: false,
    },
    'Receipt flush-execution helper should allow sync when partner identity and queued work are valid'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFlushExecutionPlan({
      shouldResetQueue: false,
      shouldSync: true,
      partnerEmail: '   ',
      userEmail: 'teacher@school.com',
      readMessageIds: ['msg-1'],
      requestConversationDelivered: false,
    }),
    {
      shouldClearQueue: true,
      shouldRunSync: false,
      partnerEmail: null,
      readMessageIds: ['msg-1'],
      requestConversationDelivered: false,
    },
    'Receipt flush-execution helper should defensively skip sync when partner identity is unavailable'
  );

  logger.debug('✓ testChatReceiptSyncFlushExecutionPlanHelper passed');
})();

(function testChatReceiptSyncFailurePlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncFailurePlan({
      readMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
      requestConversationDelivered: true,
      partnerEmail: ' Parent@One.com ',
    }),
    {
      rollbackReadMessageIds: ['msg-1', 'msg-2'],
      shouldResetDeliverySyncMarker: true,
      partnerEmail: 'parent@one.com',
    },
    'Receipt failure-plan helper should normalize rollback ids and request delivery-marker reset when delivery sync was requested'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFailurePlan({
      readMessageIds: [],
      requestConversationDelivered: false,
      partnerEmail: 'Parent@One.com',
    }),
    {
      rollbackReadMessageIds: [],
      shouldResetDeliverySyncMarker: false,
      partnerEmail: 'parent@one.com',
    },
    'Receipt failure-plan helper should avoid delivery-marker reset when delivery sync was not requested'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFailurePlan({
      readMessageIds: ['msg-1'],
      requestConversationDelivered: true,
      partnerEmail: '   ',
    }),
    {
      rollbackReadMessageIds: ['msg-1'],
      shouldResetDeliverySyncMarker: false,
      partnerEmail: null,
    },
    'Receipt failure-plan helper should skip delivery-marker reset for invalid partner identifiers'
  );

  logger.debug('✓ testChatReceiptSyncFailurePlanHelper passed');
})();

(function testChatReceiptSyncFailureRecoveryPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncFailureRecoveryPlan({
      readMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
      requestConversationDelivered: true,
      partnerEmail: ' Parent@One.com ',
    }),
    {
      rollbackMutationPlan: {
        addMessageIds: [],
        removeMessageIds: ['msg-1', 'msg-2'],
      },
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 0,
      },
    },
    'Receipt failure-recovery helper should provide rollback mutation plan and marker reset when delivery sync was requested'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFailureRecoveryPlan({
      readMessageIds: [' msg-1 '],
      requestConversationDelivered: false,
      partnerEmail: ' Parent@One.com ',
    }),
    {
      rollbackMutationPlan: {
        addMessageIds: [],
        removeMessageIds: ['msg-1'],
      },
      nextDeliverySyncMarker: null,
    },
    'Receipt failure-recovery helper should skip delivery marker updates when delivery sync was not requested'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFailureRecoveryPlan({
      readMessageIds: [' msg-1 '],
      requestConversationDelivered: true,
      partnerEmail: '   ',
    }),
    {
      rollbackMutationPlan: {
        addMessageIds: [],
        removeMessageIds: ['msg-1'],
      },
      nextDeliverySyncMarker: null,
    },
    'Receipt failure-recovery helper should skip marker reset when partner identity is unavailable'
  );

  logger.debug('✓ testChatReceiptSyncFailureRecoveryPlanHelper passed');
})();

(function testApplyChatReceiptSyncFailureRecoveryPlanHelper() {
  const requestedReadMessageIds = new Set(['msg-1', 'msg-2']);
  const nextMarker = applyChatReceiptSyncFailureRecoveryPlan(
    requestedReadMessageIds,
    {
      rollbackMutationPlan: {
        addMessageIds: [],
        removeMessageIds: [' msg-1 ', 'msg-3'],
      },
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 0,
      },
    },
    {
      partnerEmail: 'previous@one.com',
      at: 1200,
    }
  );

  assert.deepStrictEqual(
    Array.from(requestedReadMessageIds.values()),
    ['msg-2'],
    'Failure-recovery apply helper should apply rollback mutation plan to requested-read state'
  );

  assert.deepStrictEqual(
    nextMarker,
    {
      partnerEmail: 'parent@one.com',
      at: 0,
    },
    'Failure-recovery apply helper should use helper-provided marker reset when available'
  );

  const requestedReadMessageIdsFallback = new Set(['msg-7']);
  const fallbackMarker = applyChatReceiptSyncFailureRecoveryPlan(
    requestedReadMessageIdsFallback,
    {
      rollbackMutationPlan: {
        addMessageIds: [],
        removeMessageIds: ['msg-7'],
      },
      nextDeliverySyncMarker: null,
    },
    {
      partnerEmail: 'existing@one.com',
      at: 2500,
    }
  );

  assert.deepStrictEqual(
    Array.from(requestedReadMessageIdsFallback.values()),
    [],
    'Failure-recovery apply helper should still mutate requested-read state when no marker update is provided'
  );

  assert.deepStrictEqual(
    fallbackMarker,
    {
      partnerEmail: 'existing@one.com',
      at: 2500,
    },
    'Failure-recovery apply helper should preserve existing marker when recovery plan has no marker update'
  );

  logger.debug('✓ testApplyChatReceiptSyncFailureRecoveryPlanHelper passed');
})();

(function testChatReceiptSyncRunAttemptPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncRunAttemptPlan({
      partnerEmail: ' Parent@One.com ',
      readMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
      requestConversationDelivered: true,
    }),
    {
      partnerEmail: 'parent@one.com',
      syncPayload: {
        readMessageIds: ['msg-1', 'msg-2'],
        markConversationDelivered: true,
      },
      requestMutationPlan: {
        addMessageIds: ['msg-1', 'msg-2'],
        removeMessageIds: [],
      },
      failureRecoveryPlan: {
        rollbackMutationPlan: {
          addMessageIds: [],
          removeMessageIds: ['msg-1', 'msg-2'],
        },
        nextDeliverySyncMarker: {
          partnerEmail: 'parent@one.com',
          at: 0,
        },
      },
    },
    'Flush run-attempt plan helper should compose sync payload, request-mutation apply plan, and failure recovery plan from normalized inputs'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncRunAttemptPlan({
      partnerEmail: '   ',
      readMessageIds: [' msg-1 ', 'msg-1'],
      requestConversationDelivered: false,
    }),
    {
      partnerEmail: null,
      syncPayload: {
        readMessageIds: ['msg-1'],
        markConversationDelivered: false,
      },
      requestMutationPlan: {
        addMessageIds: ['msg-1'],
        removeMessageIds: [],
      },
      failureRecoveryPlan: {
        rollbackMutationPlan: {
          addMessageIds: [],
          removeMessageIds: ['msg-1'],
        },
        nextDeliverySyncMarker: null,
      },
    },
    'Flush run-attempt plan helper should skip delivery-marker reset plan when partner identity is unavailable'
  );

  logger.debug('✓ testChatReceiptSyncRunAttemptPlanHelper passed');
})();

(function testChatReceiptSyncFollowupHelper() {
  assert.strictEqual(
    shouldScheduleChatReceiptSyncFollowup({
      queuedReadMessageCount: 2,
      requestConversationDelivered: false,
    }),
    true,
    'Receipt follow-up helper should schedule another flush when queued read receipts remain'
  );

  assert.strictEqual(
    shouldScheduleChatReceiptSyncFollowup({
      queuedReadMessageCount: 0,
      requestConversationDelivered: true,
    }),
    true,
    'Receipt follow-up helper should schedule another flush when delivery sync remains queued'
  );

  assert.strictEqual(
    shouldScheduleChatReceiptSyncFollowup({
      queuedReadMessageCount: 0,
      requestConversationDelivered: false,
    }),
    false,
    'Receipt follow-up helper should skip flush retries when there is no queued work'
  );

  assert.strictEqual(
    shouldScheduleChatReceiptSyncFollowup({
      queuedReadMessageCount: '2.8',
      requestConversationDelivered: false,
    }),
    true,
    'Receipt follow-up helper should coerce numeric queued-count inputs'
  );

  logger.debug('✓ testChatReceiptSyncFollowupHelper passed');
})();

(function testChatReceiptSyncFinalizePlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncFinalizePlan({
      queuedReadMessageCount: 2,
      requestConversationDelivered: false,
    }),
    {
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: false,
        shouldFlushImmediately: true,
      },
      shouldFlushImmediately: true,
    },
    'Flush-finalization helper should request immediate follow-up flushes when queued read work remains'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFinalizePlan({
      queuedReadMessageCount: 0,
      requestConversationDelivered: true,
    }),
    {
      followupTriggerPlan: {
        shouldScheduleFollowup: true,
        shouldScheduleDeferredFlush: false,
        shouldFlushImmediately: true,
      },
      shouldFlushImmediately: true,
    },
    'Flush-finalization helper should request immediate follow-up flushes when delivery sync remains queued'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFinalizePlan({
      queuedReadMessageCount: 0,
      requestConversationDelivered: false,
    }),
    {
      followupTriggerPlan: {
        shouldScheduleFollowup: false,
        shouldScheduleDeferredFlush: false,
        shouldFlushImmediately: false,
      },
      shouldFlushImmediately: false,
    },
    'Flush-finalization helper should no-op when no queued receipt work remains'
  );

  logger.debug('✓ testChatReceiptSyncFinalizePlanHelper passed');
})();

(function testApplyChatReceiptSyncRunFinalizePlanHelper() {
  const requestedReadIdsFailure = new Set(['msg-1', 'msg-2']);
  const failureFinalizePlan = applyChatReceiptSyncRunFinalizePlan({
    requestedReadMessageIds: requestedReadIdsFailure,
    failureRecoveryPlan: {
      rollbackMutationPlan: {
        addMessageIds: [],
        removeMessageIds: [' msg-1 ', 'msg-3'],
      },
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 0,
      },
    },
    currentDeliverySyncMarker: {
      partnerEmail: 'existing@one.com',
      at: 500,
    },
    queuedReadMessageCount: 1,
    requestConversationDelivered: false,
  });

  assert.deepStrictEqual(
    Array.from(requestedReadIdsFailure.values()),
    ['msg-2'],
    'Run-finalize helper should apply failure recovery rollback mutations when recovery data is provided'
  );

  assert.deepStrictEqual(
    failureFinalizePlan.nextDeliverySyncMarker,
    {
      partnerEmail: 'parent@one.com',
      at: 0,
    },
    'Run-finalize helper should propagate failure-recovery marker updates when provided'
  );

  assert.strictEqual(
    failureFinalizePlan.shouldFlushImmediately,
    true,
    'Run-finalize helper should request immediate follow-up flush when queued work remains'
  );

  assert.strictEqual(
    failureFinalizePlan.flushFinalizePlan,
    undefined,
    'Run-finalize helper output should not expose redundant nested finalize payloads'
  );

  const requestedReadIdsSuccess = new Set(['msg-9']);
  const successFinalizePlan = applyChatReceiptSyncRunFinalizePlan({
    requestedReadMessageIds: requestedReadIdsSuccess,
    failureRecoveryPlan: null,
    currentDeliverySyncMarker: {
      partnerEmail: 'existing@one.com',
      at: 2500,
    },
    queuedReadMessageCount: 0,
    requestConversationDelivered: false,
  });

  assert.deepStrictEqual(
    Array.from(requestedReadIdsSuccess.values()),
    ['msg-9'],
    'Run-finalize helper should not mutate requested-read state when no failure recovery data is provided'
  );

  assert.deepStrictEqual(
    successFinalizePlan.nextDeliverySyncMarker,
    {
      partnerEmail: 'existing@one.com',
      at: 2500,
    },
    'Run-finalize helper should preserve existing marker when no recovery marker update is provided'
  );

  assert.strictEqual(
    successFinalizePlan.shouldFlushImmediately,
    false,
    'Run-finalize helper should skip immediate follow-up flush when queued work is empty'
  );

  assert.strictEqual(
    successFinalizePlan.flushFinalizePlan,
    undefined,
    'Run-finalize helper output should stay minimal for success-path finalization as well'
  );

  logger.debug('✓ testApplyChatReceiptSyncRunFinalizePlanHelper passed');
})();

(function testChatReceiptRequestedReadSeedMessageIdsHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptRequestedReadSeedMessageIds([
      { id: ' msg-1 ', read: true },
      { id: 'msg-1', read: 1 },
      { id: 'msg-2', read: false },
      { id: '', read: true },
      { id: 0, read: true },
      { id: 'msg-3', read: 'yes' },
      null,
      { id: '   ', read: true },
    ]),
    ['msg-1', 'msg-3'],
    'Receipt requested-read seed helper should derive normalized unique read message ids from message snapshots'
  );

  assert.deepStrictEqual(
    resolveChatReceiptRequestedReadSeedMessageIds([]),
    [],
    'Receipt requested-read seed helper should return an empty list when messages are empty'
  );

  logger.debug('✓ testChatReceiptRequestedReadSeedMessageIdsHelper passed');
})();

(function testChatReceiptDeliverySyncRequestHelper() {
  assert.strictEqual(
    DEFAULT_CHAT_RECEIPT_DELIVERY_SYNC_COOLDOWN_MS,
    15000,
    'Receipt delivery-sync cooldown constant should remain stable for shared queue/viewability gating policy'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncRequest({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
    }),
    {
      requestConversationDelivered: true,
      partnerEmail: 'parent@one.com',
      nowMs: 1000,
    },
    'Receipt delivery-sync request helper should request delivery when partner changes'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncRequest({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 980,
      nowMs: 1000,
      cooldownMs: 50,
    }),
    {
      requestConversationDelivered: false,
      partnerEmail: 'parent@one.com',
      nowMs: 1000,
    },
    'Receipt delivery-sync request helper should throttle repeated requests within cooldown window'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncRequest({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 900,
      nowMs: 1000,
      cooldownMs: 'invalid',
    }),
    {
      requestConversationDelivered: false,
      partnerEmail: 'parent@one.com',
      nowMs: 1000,
    },
    'Receipt delivery-sync request helper should use shared default cooldown when provided cooldown is invalid'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncRequest({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 900,
      nowMs: 1000,
      cooldownMs: 50,
    }),
    {
      requestConversationDelivered: true,
      partnerEmail: 'parent@one.com',
      nowMs: 1000,
    },
    'Receipt delivery-sync request helper should allow requests once cooldown has elapsed'
  );

  const noPartnerDecision = resolveChatReceiptDeliverySyncRequest({
    partnerEmail: '   ',
    lastPartnerEmail: 'parent@one.com',
    lastAttemptAtMs: 900,
    nowMs: 1000,
    cooldownMs: 50,
  });
  assert.strictEqual(
    noPartnerDecision.requestConversationDelivered,
    false,
    'Receipt delivery-sync request helper should skip requests when partner email is unavailable'
  );
  assert.strictEqual(
    noPartnerDecision.partnerEmail,
    null,
    'Receipt delivery-sync request helper should normalize missing partner email to null'
  );

  logger.debug('✓ testChatReceiptDeliverySyncRequestHelper passed');
})();

(function testChatReceiptViewabilitySyncPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptViewabilitySyncPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 ', 'msg-1', null],
    }),
    {
      queueRequestPlan: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
        shouldQueueSync: true,
      },
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
    },
    'Receipt viewability-sync plan helper should combine delivery request and queued unread read ids into one queue plan'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilitySyncPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 990,
      nowMs: 1000,
      cooldownMs: 50,
      visibleUnreadIncomingIds: [],
    }),
    {
      queueRequestPlan: {
        readMessageIds: [],
        requestConversationDelivered: false,
        shouldQueueSync: false,
      },
      nextDeliverySyncMarker: null,
    },
    'Receipt viewability-sync plan helper should avoid queue work and marker updates when no unread ids and delivery cooldown blocks requests'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilitySyncPlan({
      partnerEmail: '   ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 900,
      nowMs: 1000,
      cooldownMs: 50,
      visibleUnreadIncomingIds: [' msg-1 '],
    }),
    {
      queueRequestPlan: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: false,
        shouldQueueSync: true,
      },
      nextDeliverySyncMarker: null,
    },
    'Receipt viewability-sync plan helper should still queue normalized unread ids when delivery sync request cannot be made'
  );

  logger.debug('✓ testChatReceiptViewabilitySyncPlanHelper passed');
})();

(function testChatReceiptViewabilityQueueInvocationPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueInvocationPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 ', 'msg-1', null],
    }),
    {
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      queueInvocationPlan: {
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: ['msg-1'],
          requestConversationDelivered: true,
        },
      },
    },
    'Viewability queue-invocation helper should compose marker updates and normalized queue invocation options when delivery/read work exists'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueInvocationPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 990,
      nowMs: 1000,
      cooldownMs: 50,
      visibleUnreadIncomingIds: [],
    }),
    {
      nextDeliverySyncMarker: null,
      queueInvocationPlan: {
        shouldQueueSync: false,
        queueOptions: {
          readMessageIds: [],
          requestConversationDelivered: false,
        },
      },
    },
    'Viewability queue-invocation helper should no-op when no delivery or unread queue work remains'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueInvocationPlan({
      partnerEmail: '   ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 900,
      nowMs: 1000,
      cooldownMs: 50,
      visibleUnreadIncomingIds: [' msg-1 '],
    }),
    {
      nextDeliverySyncMarker: null,
      queueInvocationPlan: {
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: ['msg-1'],
          requestConversationDelivered: false,
        },
      },
    },
    'Viewability queue-invocation helper should still queue normalized unread ids when delivery marker updates are unavailable'
  );

  logger.debug('✓ testChatReceiptViewabilityQueueInvocationPlanHelper passed');
})();

(function testChatReceiptViewabilityQueueExecutionPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueExecutionPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 ', 'msg-1', null],
      queueGeneration: 12,
      activeGeneration: 12,
    }),
    {
      shouldApplyViewabilityQueueExecutionPlan: true,
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      queueInvocationPlan: {
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: ['msg-1'],
          requestConversationDelivered: true,
        },
      },
    },
    'Viewability queue-execution helper should allow marker updates and queue invocation when viewability and active generations match'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueExecutionPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 '],
      queueGeneration: 12,
      activeGeneration: 13,
    }),
    {
      shouldApplyViewabilityQueueExecutionPlan: false,
      nextDeliverySyncMarker: null,
      queueInvocationPlan: {
        shouldQueueSync: false,
        queueOptions: {
          readMessageIds: [],
          requestConversationDelivered: false,
        },
      },
    },
    'Viewability queue-execution helper should suppress stale marker updates and queue invocation when generations diverge'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueExecutionPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 '],
    }),
    {
      shouldApplyViewabilityQueueExecutionPlan: true,
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      queueInvocationPlan: {
        shouldQueueSync: true,
        queueOptions: {
          readMessageIds: ['msg-1'],
          requestConversationDelivered: true,
        },
      },
    },
    'Viewability queue-execution helper should preserve existing behavior when generation guard inputs are not provided'
  );

  logger.debug('✓ testChatReceiptViewabilityQueueExecutionPlanHelper passed');
})();

(function testChatReceiptViewabilityQueueDispatchPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueDispatchPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 ', 'msg-1', null],
      queueGeneration: 12,
      activeGeneration: 12,
    }),
    {
      shouldApplyViewabilityQueueDispatchPlan: true,
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Viewability queue-dispatch helper should flatten marker and queue dispatch fields from the generation-gated execution plan'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueDispatchPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'other@one.com',
      lastAttemptAtMs: 950,
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 '],
      queueGeneration: 12,
      activeGeneration: 13,
    }),
    {
      shouldApplyViewabilityQueueDispatchPlan: false,
      nextDeliverySyncMarker: null,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Viewability queue-dispatch helper should preserve stale generation suppression from execution planning'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueDispatchPlan({
      partnerEmail: ' Parent@One.com ',
      lastPartnerEmail: 'parent@one.com',
      lastAttemptAtMs: 990,
      nowMs: 1000,
      cooldownMs: 50,
      visibleUnreadIncomingIds: [],
    }),
    {
      shouldApplyViewabilityQueueDispatchPlan: true,
      nextDeliverySyncMarker: null,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Viewability queue-dispatch helper should no-op with normalized empty queue options when cooldown blocks delivery and no unread ids are visible'
  );

  logger.debug('✓ testChatReceiptViewabilityQueueDispatchPlanHelper passed');
})();

(function testChatReceiptViewabilityQueueDispatchPlanForMarkerHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueDispatchPlanForMarker({
      partnerEmail: ' Parent@One.com ',
      lastDeliverySyncMarker: {
        partnerEmail: 'other@one.com',
        at: 950,
      },
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [' msg-1 ', 'msg-1', null],
      queueGeneration: 12,
      activeGeneration: 12,
    }),
    {
      shouldApplyViewabilityQueueDispatchPlan: true,
      nextDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 1000,
      },
      shouldQueueSync: true,
      queueOptions: {
        readMessageIds: ['msg-1'],
        requestConversationDelivered: true,
      },
    },
    'Marker-aware viewability queue-dispatch helper should normalize marker snapshots and compose queue dispatch output through generation-gated execution planning'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueDispatchPlanForMarker({
      partnerEmail: ' Parent@One.com ',
      lastDeliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 990,
      },
      nowMs: 1000,
      cooldownMs: 50,
      visibleUnreadIncomingIds: [],
    }),
    {
      shouldApplyViewabilityQueueDispatchPlan: true,
      nextDeliverySyncMarker: null,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Marker-aware viewability queue-dispatch helper should preserve no-op shaping when marker cooldown blocks delivery requests and no unread ids are visible'
  );

  assert.deepStrictEqual(
    resolveChatReceiptViewabilityQueueDispatchPlanForMarker({
      partnerEmail: ' Parent@One.com ',
      lastDeliverySyncMarker: {
        partnerEmail: 'other@one.com',
        at: 950,
      },
      nowMs: 1000,
      cooldownMs: 15000,
      visibleUnreadIncomingIds: [],
      queueGeneration: 41,
      activeGeneration: 42,
    }),
    {
      shouldApplyViewabilityQueueDispatchPlan: false,
      nextDeliverySyncMarker: null,
      shouldQueueSync: false,
      queueOptions: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    },
    'Marker-aware viewability queue-dispatch helper should suppress stale marker-only updates when viewability generation changes before callback execution'
  );

  logger.debug('✓ testChatReceiptViewabilityQueueDispatchPlanForMarkerHelper passed');
})();

(function testChatReceiptDeliverySyncMarkerHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncMarkerReset(' Parent@One.com '),
    {
      partnerEmail: 'parent@one.com',
      at: 0,
    },
    'Receipt delivery-sync marker reset helper should normalize partner identifiers and reset attempt timestamp'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncMarkerReset('   '),
    {
      partnerEmail: null,
      at: 0,
    },
    'Receipt delivery-sync marker reset helper should normalize missing partner identifiers to null'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncMarkerUpdate(' Parent@One.com ', 1000),
    {
      partnerEmail: 'parent@one.com',
      at: 1000,
    },
    'Receipt delivery-sync marker update helper should normalize partner identifiers and preserve provided timestamps'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncMarkerUpdate(' Parent@One.com ', '1200.7'),
    {
      partnerEmail: 'parent@one.com',
      at: 1200,
    },
    'Receipt delivery-sync marker update helper should coerce numeric timestamp inputs'
  );

  assert.deepStrictEqual(
    resolveChatReceiptDeliverySyncMarkerUpdate('   ', 1000),
    {
      partnerEmail: null,
      at: 0,
    },
    'Receipt delivery-sync marker update helper should reset marker state when partner identifiers are unavailable'
  );

  logger.debug('✓ testChatReceiptDeliverySyncMarkerHelper passed');
})();

(function testChatReceiptSyncConversationResetPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncConversationResetPlan(' Parent@One.com '),
    {
      requestConversationDelivered: false,
      deliverySyncMarker: {
        partnerEmail: 'parent@one.com',
        at: 0,
      },
    },
    'Receipt conversation-reset helper should reset delivery-sync request flag and marker from normalized partner identity'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncConversationResetPlan('   '),
    {
      requestConversationDelivered: false,
      deliverySyncMarker: {
        partnerEmail: null,
        at: 0,
      },
    },
    'Receipt conversation-reset helper should preserve reset semantics when partner identity is unavailable'
  );

  logger.debug('✓ testChatReceiptSyncConversationResetPlanHelper passed');
})();

(function testChatReceiptRequestedReadMutationPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptRequestedReadMutationPlan({
      addMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
      removeMessageIds: [' msg-2 ', 'msg-3', 'msg-3', '   '],
    }),
    {
      addMessageIds: ['msg-1'],
      removeMessageIds: ['msg-2', 'msg-3'],
    },
    'Receipt requested-read mutation helper should normalize/de-duplicate ids and drop add/remove conflicts'
  );

  assert.deepStrictEqual(
    resolveChatReceiptRequestedReadMutationPlan({
      addMessageIds: ['msg-1', ' msg-2 '],
    }),
    {
      addMessageIds: ['msg-1', 'msg-2'],
      removeMessageIds: [],
    },
    'Receipt requested-read mutation helper should support add-only updates'
  );

  assert.deepStrictEqual(
    resolveChatReceiptRequestedReadMutationPlan({
      removeMessageIds: [' msg-1 ', 'msg-1', undefined],
    }),
    {
      addMessageIds: [],
      removeMessageIds: ['msg-1'],
    },
    'Receipt requested-read mutation helper should support remove-only updates'
  );

  logger.debug('✓ testChatReceiptRequestedReadMutationPlanHelper passed');
})();

(function testApplyChatReceiptRequestedReadMutationHelper() {
  const requestedReadIds = new Set(['msg-0', 'msg-2']);

  applyChatReceiptRequestedReadMutation(requestedReadIds, {
    addMessageIds: ['msg-1', 'msg-2'],
    removeMessageIds: ['msg-0', 'msg-3'],
  });

  assert.deepStrictEqual(
    Array.from(requestedReadIds).sort(),
    ['msg-1', 'msg-2'],
    'Requested-read set mutation helper should apply remove/add operations deterministically'
  );

  logger.debug('✓ testApplyChatReceiptRequestedReadMutationHelper passed');
})();

(function testChatReceiptSyncQueueApplyPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueApplyPlan({
      queuedReadMessageIds: new Set(['msg-0', 'msg-2']),
      requestConversationDelivered: false,
      queueUpdate: {
        readMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
        requestConversationDelivered: true,
      },
    }),
    {
      addMessageIds: ['msg-1'],
      nextRequestConversationDelivered: true,
      nextQueuedReadMessageCount: 3,
    },
    'Queue-apply helper should derive net-new ids, next delivery flag, and next queued count'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncQueueApplyPlan({
      queuedReadMessageIds: new Set(),
      requestConversationDelivered: false,
      queueUpdate: {
        readMessageIds: [],
        requestConversationDelivered: false,
      },
    }),
    {
      addMessageIds: [],
      nextRequestConversationDelivered: false,
      nextQueuedReadMessageCount: 0,
    },
    'Queue-apply helper should preserve empty queue state when no read or delivery work exists'
  );

  logger.debug('✓ testChatReceiptSyncQueueApplyPlanHelper passed');
})();

(function testApplyChatReceiptSyncQueueApplyPlanHelper() {
  const queuedReadIds = new Set(['msg-0', 'msg-2']);

  const queuedState = applyChatReceiptSyncQueueApplyPlan(
    queuedReadIds,
    {
      addMessageIds: [' msg-1 ', 'msg-2', 'msg-1', null],
      nextRequestConversationDelivered: true,
      nextQueuedReadMessageCount: 3,
    },
    false
  );

  assert.deepStrictEqual(
    Array.from(queuedState.queuedReadMessageIds).sort(),
    ['msg-0', 'msg-1', 'msg-2'],
    'Queue apply helper should apply normalized net-new ids directly onto queued state'
  );
  assert.strictEqual(
    queuedState.requestConversationDelivered,
    true,
    'Queue apply helper should project next delivery request state from apply plan'
  );

  logger.debug('✓ testApplyChatReceiptSyncQueueApplyPlanHelper passed');
})();

(function testClearChatReceiptSyncQueuedStateHelper() {
  const queuedReadIds = new Set(['msg-1']);
  const clearedState = clearChatReceiptSyncQueuedState(queuedReadIds);

  assert.deepStrictEqual(
    Array.from(clearedState.queuedReadMessageIds),
    [],
    'Queue clear helper should clear queued read receipt ids in place'
  );
  assert.strictEqual(
    clearedState.requestConversationDelivered,
    false,
    'Queue clear helper should reset queued delivery sync request flag'
  );

  logger.debug('✓ testClearChatReceiptSyncQueuedStateHelper passed');
})();

(function testChatReceiptSyncFollowupTriggerPlanHelper() {
  assert.deepStrictEqual(
    resolveChatReceiptSyncFollowupTriggerPlan({
      queuedReadMessageCount: 2,
      requestConversationDelivered: false,
      hasPendingTimeout: false,
      triggerMode: 'deferred',
    }),
    {
      shouldScheduleFollowup: true,
      shouldScheduleDeferredFlush: true,
      shouldFlushImmediately: false,
    },
    'Follow-up trigger helper should schedule deferred flushes when queue work exists and no timer is pending'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFollowupTriggerPlan({
      queuedReadMessageCount: 2,
      requestConversationDelivered: false,
      hasPendingTimeout: true,
      triggerMode: 'deferred',
    }),
    {
      shouldScheduleFollowup: true,
      shouldScheduleDeferredFlush: false,
      shouldFlushImmediately: false,
    },
    'Follow-up trigger helper should avoid duplicate deferred scheduling when a timer is already pending'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFollowupTriggerPlan({
      queuedReadMessageCount: 0,
      requestConversationDelivered: true,
      triggerMode: 'immediate',
    }),
    {
      shouldScheduleFollowup: true,
      shouldScheduleDeferredFlush: false,
      shouldFlushImmediately: true,
    },
    'Follow-up trigger helper should request immediate follow-up flushes for post-flush delivery work'
  );

  assert.deepStrictEqual(
    resolveChatReceiptSyncFollowupTriggerPlan({
      queuedReadMessageCount: 0,
      requestConversationDelivered: false,
      triggerMode: 'immediate',
    }),
    {
      shouldScheduleFollowup: false,
      shouldScheduleDeferredFlush: false,
      shouldFlushImmediately: false,
    },
    'Follow-up trigger helper should no-op when no queued receipt work remains'
  );

  logger.debug('✓ testChatReceiptSyncFollowupTriggerPlanHelper passed');
})();

(function testPendingMessageStatusNormalization() {
  assert.strictEqual(normalizePendingMessageStatus('queued'), 'queued', 'Queued status should remain queued');
  assert.strictEqual(normalizePendingMessageStatus('sending'), 'sending', 'Sending status should remain sending');
  assert.strictEqual(normalizePendingMessageStatus('sent'), 'sent', 'Sent status should remain sent');
  assert.strictEqual(normalizePendingMessageStatus('failed'), 'failed', 'Failed status should remain failed');
  assert.strictEqual(normalizePendingMessageStatus('unknown'), 'queued', 'Unknown status should fall back to queued');
  assert.strictEqual(normalizePendingMessageStatus(undefined), 'queued', 'Missing status should fall back to queued');
  logger.debug('✓ testPendingMessageStatusNormalization passed');
})();

(function testPendingMessageTransitionDeDupe() {
  const deliveredMessageIds = new Set(['server-123']);
  const normalize = (value) => (value == null ? '' : String(value).trim());

  assert.strictEqual(
    shouldHidePendingMessageDuringTransition(
      { status: 'sent', serverMessageId: 'server-123' },
      deliveredMessageIds,
      normalize
    ),
    true,
    'Sent pending message should be hidden once matching server message exists'
  );

  assert.strictEqual(
    shouldHidePendingMessageDuringTransition(
      { status: 'sending', serverMessageId: 'server-123' },
      deliveredMessageIds,
      normalize
    ),
    false,
    'Sending pending message should stay visible'
  );

  assert.strictEqual(
    shouldHidePendingMessageDuringTransition(
      { status: 'sent', serverMessageId: 'server-999' },
      deliveredMessageIds,
      normalize
    ),
    false,
    'Sent pending message should stay visible when server message has not arrived yet'
  );

  logger.debug('✓ testPendingMessageTransitionDeDupe passed');
})();

(function testChatTypingPairHelpers() {
  assert.deepStrictEqual(
    createChatTypingPair(' Teacher@School.com ', ' Parent@One.com '),
    { userEmail: 'teacher@school.com', recipientEmail: 'parent@one.com' },
    'Typing pair helper should normalize and preserve user/recipient roles'
  );

  assert.strictEqual(
    createChatTypingPair('', 'parent@one.com'),
    null,
    'Typing pair helper should reject empty user email'
  );

  assert.strictEqual(
    createChatTypingPair('teacher@school.com', 'teacher@school.com'),
    null,
    'Typing pair helper should reject self-typing pairs'
  );

  assert.strictEqual(
    areChatTypingPairsEqual(
      { userEmail: 'teacher@school.com', recipientEmail: 'parent@one.com' },
      { userEmail: 'teacher@school.com', recipientEmail: 'parent@one.com' }
    ),
    true,
    'Typing pair equality should match identical pairs'
  );

  assert.strictEqual(
    areChatTypingPairsEqual(
      { userEmail: 'teacher@school.com', recipientEmail: 'parent@one.com' },
      { userEmail: 'teacher@school.com', recipientEmail: 'parent@two.com' }
    ),
    false,
    'Typing pair equality should detect different recipients'
  );

  logger.debug('✓ testChatTypingPairHelpers passed');
})();

(function testChatTypingTransitionHelper() {
  const pairOne = { userEmail: 'teacher@school.com', recipientEmail: 'parent@one.com' };
  const pairTwo = { userEmail: 'teacher@school.com', recipientEmail: 'parent@two.com' };

  const clearWhenNoContent = resolveChatTypingTransition({
    activePair: pairOne,
    isTypingActive: true,
    nextPair: pairOne,
    hasMessageContent: false,
  });
  assert.deepStrictEqual(
    clearWhenNoContent,
    {
      pairToClear: pairOne,
      pairToActivate: null,
      nextActivePair: null,
      nextIsTypingActive: false,
      shouldScheduleTimeout: false,
    },
    'Transition should clear typing when message becomes empty'
  );

  const keepActiveWhenSamePair = resolveChatTypingTransition({
    activePair: pairOne,
    isTypingActive: true,
    nextPair: pairOne,
    hasMessageContent: true,
  });
  assert.strictEqual(keepActiveWhenSamePair.pairToClear, null, 'Same active pair should not be cleared');
  assert.strictEqual(keepActiveWhenSamePair.pairToActivate, null, 'Same active pair should not be re-activated');
  assert.deepStrictEqual(keepActiveWhenSamePair.nextActivePair, pairOne, 'Same pair should remain active');
  assert.strictEqual(keepActiveWhenSamePair.nextIsTypingActive, true, 'Typing should remain active');
  assert.strictEqual(keepActiveWhenSamePair.shouldScheduleTimeout, true, 'Timeout should continue while typing');

  const activateWhenFlagWasInactive = resolveChatTypingTransition({
    activePair: pairOne,
    isTypingActive: false,
    nextPair: pairOne,
    hasMessageContent: true,
  });
  assert.deepStrictEqual(
    activateWhenFlagWasInactive.pairToActivate,
    pairOne,
    'Inactive typing flag should trigger activation for the current pair'
  );

  const switchPairs = resolveChatTypingTransition({
    activePair: pairOne,
    isTypingActive: true,
    nextPair: pairTwo,
    hasMessageContent: true,
  });
  assert.deepStrictEqual(switchPairs.pairToClear, pairOne, 'Switching conversations should clear previous pair');
  assert.deepStrictEqual(switchPairs.pairToActivate, pairTwo, 'Switching conversations should activate next pair');
  assert.deepStrictEqual(switchPairs.nextActivePair, pairTwo, 'Next pair should become active');

  const clearWhenNextPairMissing = resolveChatTypingTransition({
    activePair: pairOne,
    isTypingActive: true,
    nextPair: null,
    hasMessageContent: true,
  });
  assert.strictEqual(
    clearWhenNextPairMissing.shouldScheduleTimeout,
    false,
    'Missing recipient context should stop typing timeout scheduling'
  );
  assert.deepStrictEqual(clearWhenNextPairMissing.pairToClear, pairOne, 'Missing pair should clear existing typing state');

  logger.debug('✓ testChatTypingTransitionHelper passed');
})();

(function testChatTypingMetricsHelper() {
  const typingRollupState = createChatTypingStatusWriteRollupState();
  assert.deepStrictEqual(
    typingRollupState,
    {
      totalWrites: 0,
      setTrueWrites: 0,
      setFalseWrites: 0,
      byReason: {},
      lastMetricAt: 0,
    },
    'Typing metrics helper should expose zeroed initial rollup state'
  );

  const firstTypingPayload = recordChatTypingStatusWriteRollup(
    typingRollupState,
    true,
    'transition_activate',
    1000
  );
  assert.deepStrictEqual(
    firstTypingPayload,
    {
      totalWrites: 1,
      setTrueWrites: 1,
      setFalseWrites: 0,
      reason: 'transition_activate',
      reasonWrites: 1,
    },
    'Typing metrics helper should emit on first write event with reason counters'
  );
  assert.strictEqual(
    typingRollupState.lastMetricAt,
    1000,
    'Typing metrics helper should capture emission timestamps after cadence emit'
  );

  assert.strictEqual(
    recordChatTypingStatusWriteRollup(typingRollupState, false, 'clear_active', 1100),
    null,
    'Typing metrics helper should suppress non-cadence events before thresholds'
  );

  for (let index = 0; index < 7; index += 1) {
    recordChatTypingStatusWriteRollup(typingRollupState, false, 'timeout_clear', 1200 + index);
  }

  assert.deepStrictEqual(
    recordChatTypingStatusWriteRollup(typingRollupState, false, 'timeout_clear', 1300),
    {
      totalWrites: 10,
      setTrueWrites: 1,
      setFalseWrites: 9,
      reason: 'timeout_clear',
      reasonWrites: 8,
    },
    'Typing metrics helper should emit on every tenth write event with aggregated reason counts'
  );

  const typingIntervalState = createChatTypingStatusWriteRollupState();
  recordChatTypingStatusWriteRollup(typingIntervalState, false, 'unmount', 500);

  assert.strictEqual(
    recordChatTypingStatusWriteRollup(typingIntervalState, false, 'inactivity', 45000),
    null,
    'Typing metrics helper should not emit before interval threshold when cadence does not match'
  );

  assert.deepStrictEqual(
    recordChatTypingStatusWriteRollup(typingIntervalState, true, 'pair_change', 60550),
    {
      totalWrites: 3,
      setTrueWrites: 1,
      setFalseWrites: 2,
      reason: 'pair_change',
      reasonWrites: 1,
    },
    'Typing metrics helper should emit when interval threshold elapses without cadence match'
  );

  const typingReasonNormalizationState = createChatTypingStatusWriteRollupState();
  assert.strictEqual(
    recordChatTypingStatusWriteRollup(typingReasonNormalizationState, false, '   ', 900)?.reason,
    'unknown',
    'Typing metrics helper should normalize blank reasons to unknown labels'
  );

  logger.debug('✓ testChatTypingMetricsHelper passed');
})();

(function testComposerEnterKeypressHelper() {
  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'Enter',
    }),
    true,
    'Web Enter should trigger send when no modifier keys are active'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'Enter',
      shiftKey: true,
    }),
    false,
    'Shift+Enter should not trigger send'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'Enter',
      ctrlKey: true,
    }),
    false,
    'Ctrl+Enter should not trigger send'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'Enter',
      metaKey: true,
    }),
    false,
    'Meta+Enter should not trigger send'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'Enter',
      altKey: true,
    }),
    false,
    'Alt+Enter should not trigger send'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'Enter',
      isComposing: true,
    }),
    false,
    'Enter should not send while IME composition is active'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'Enter',
      repeat: true,
    }),
    false,
    'Repeated Enter keydown should not trigger send'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'ios',
      key: 'Enter',
    }),
    false,
    'Native platforms should not use web Enter-to-send behavior'
  );

  assert.strictEqual(
    shouldSendOnComposerEnter({
      platformOS: 'web',
      key: 'a',
    }),
    false,
    'Non-Enter keys should not trigger send'
  );

  logger.debug('✓ testComposerEnterKeypressHelper passed');
})();

(function testChatComposerSendStateHelpers() {
  assert.strictEqual(
    isChatComposerMessageOverLimit({
      messageCharacterCount: 501,
      messageWordCount: 100,
      maxChars: 500,
      maxWords: 100,
    }),
    true,
    'Over-limit helper should detect character overflow'
  );

  assert.strictEqual(
    isChatComposerMessageOverLimit({
      messageCharacterCount: 500,
      messageWordCount: 101,
      maxChars: 500,
      maxWords: 100,
    }),
    true,
    'Over-limit helper should detect word overflow'
  );

  assert.strictEqual(
    canAttemptChatComposerSend({
      trimmedMessage: 'Hello parent',
      hasSelectedRecipient: true,
      messageCharacterCount: 12,
      messageWordCount: 2,
      maxChars: 500,
      maxWords: 100,
      isEditingMessage: false,
      hasEditedMessageChanged: true,
    }),
    true,
    'Send helper should allow valid non-edit messages'
  );

  assert.strictEqual(
    canAttemptChatComposerSend({
      trimmedMessage: '   ',
      hasSelectedRecipient: true,
      messageCharacterCount: 3,
      messageWordCount: 0,
      maxChars: 500,
      maxWords: 100,
      isEditingMessage: false,
      hasEditedMessageChanged: true,
    }),
    false,
    'Send helper should block empty/whitespace messages'
  );

  assert.strictEqual(
    canAttemptChatComposerSend({
      trimmedMessage: 'Hello parent',
      hasSelectedRecipient: false,
      messageCharacterCount: 12,
      messageWordCount: 2,
      maxChars: 500,
      maxWords: 100,
      isEditingMessage: false,
      hasEditedMessageChanged: true,
    }),
    false,
    'Send helper should block sends without a selected recipient'
  );

  assert.strictEqual(
    canAttemptChatComposerSend({
      trimmedMessage: 'Hello parent',
      hasSelectedRecipient: true,
      messageCharacterCount: 600,
      messageWordCount: 2,
      maxChars: 500,
      maxWords: 100,
      isEditingMessage: false,
      hasEditedMessageChanged: true,
    }),
    false,
    'Send helper should block over-limit messages'
  );

  assert.strictEqual(
    canAttemptChatComposerSend({
      trimmedMessage: 'Updated text',
      hasSelectedRecipient: true,
      messageCharacterCount: 12,
      messageWordCount: 2,
      maxChars: 500,
      maxWords: 100,
      isEditingMessage: true,
      hasEditedMessageChanged: false,
    }),
    false,
    'Send helper should block edit submits when text has not changed'
  );

  assert.strictEqual(
    canAttemptChatComposerSend({
      trimmedMessage: 'Updated text',
      hasSelectedRecipient: true,
      messageCharacterCount: 12,
      messageWordCount: 2,
      maxChars: 500,
      maxWords: 100,
      isEditingMessage: true,
      hasEditedMessageChanged: true,
    }),
    true,
    'Send helper should allow edit submits when text changed'
  );

  logger.debug('✓ testChatComposerSendStateHelpers passed');
})();

(function testChatComposerInputStateHelpers() {
  assert.strictEqual(
    resolveChatComposerWordCount('  hello   world  '),
    2,
    'Composer input helper should compute word count from compacted whitespace'
  );

  assert.strictEqual(
    resolveChatComposerWordCount('   '),
    0,
    'Composer input helper should return zero words for blank input'
  );

  assert.strictEqual(
    resolveChatComposerMessageWithinLimits({
      value: 'x'.repeat(10),
      maxChars: 5,
      maxWords: 10,
    }),
    'xxxxx',
    'Composer input helper should enforce character limit trimming'
  );

  assert.strictEqual(
    resolveChatComposerMessageWithinLimits({
      value: 'one two three four',
      maxChars: 100,
      maxWords: 2,
    }),
    'one two',
    'Composer input helper should enforce word count limits'
  );

  assert.strictEqual(
    resolveChatComposerMessageWithinLimits({
      value: '   ',
      maxChars: 100,
      maxWords: 100,
    }),
    '   ',
    'Composer input helper should preserve whitespace-only input after char-limit processing'
  );

  logger.debug('✓ testChatComposerInputStateHelpers passed');
})();

(function testChatRichContentStateHelpers() {
  const detected = resolveChatDetectedRichContent('😀😀');
  assert.strictEqual(
    detected.hasRichEmojis,
    true,
    'Rich-content helper should detect emoji-rich input'
  );
  assert.strictEqual(
    detected.emojiCount,
    2,
    'Rich-content helper should count emoji occurrences'
  );

  const stickerResult = resolveChatRichTextInputResult('😀a');
  assert.strictEqual(
    stickerResult.type,
    'sticker',
    'Rich-content helper should convert emoji-mostly input into sticker payloads'
  );
  if (stickerResult.type === 'sticker') {
    assert.strictEqual(
      stickerResult.content.name,
      '😀',
      'Rich-content helper should keep emoji-only display name when trailing stray chars exist'
    );
  }

  const textResult = resolveChatRichTextInputResult('plain text message');
  assert.strictEqual(
    textResult.type,
    'text',
    'Rich-content helper should keep plain text input as text'
  );

  const tooManyEmojiResult = resolveChatRichTextInputResult('😀😀😀😀😀😀');
  assert.strictEqual(
    tooManyEmojiResult.type,
    'text',
    'Rich-content helper should avoid sticker conversion when emoji count exceeds threshold'
  );

  logger.debug('✓ testChatRichContentStateHelpers passed');
})();

(function testChatInputKeyboardCommandsHelper() {
  assert.strictEqual(
    resolveChatInputKeyboardCommand({
      platformOS: 'web',
      key: 'Enter',
      hasMessageContent: true,
      isEditingMessage: false,
    }),
    'send-message',
    'Enter on web should resolve to send command'
  );

  assert.strictEqual(
    resolveChatInputKeyboardCommand({
      platformOS: 'web',
      key: 'ArrowUp',
      hasMessageContent: false,
      isEditingMessage: false,
    }),
    'edit-last-message',
    'ArrowUp on empty composer should resolve to edit-last command'
  );

  assert.strictEqual(
    resolveChatInputKeyboardCommand({
      platformOS: 'web',
      key: 'ArrowUp',
      hasMessageContent: true,
      isEditingMessage: false,
    }),
    null,
    'ArrowUp should not edit when composer has content'
  );

  assert.strictEqual(
    resolveChatInputKeyboardCommand({
      platformOS: 'web',
      key: 'Escape',
      hasMessageContent: true,
      isEditingMessage: true,
    }),
    'cancel-edit-message',
    'Escape should cancel active edit mode'
  );

  assert.strictEqual(
    resolveChatInputKeyboardCommand({
      platformOS: 'web',
      key: 'Escape',
      hasMessageContent: true,
      isEditingMessage: false,
    }),
    null,
    'Escape should do nothing outside edit mode'
  );

  assert.strictEqual(
    resolveChatInputKeyboardCommand({
      platformOS: 'ios',
      key: 'ArrowUp',
      hasMessageContent: false,
      isEditingMessage: false,
    }),
    null,
    'Native platforms should not apply web keyboard command shortcuts'
  );

  assert.strictEqual(
    resolveChatInputKeyboardCommand({
      platformOS: 'web',
      key: 'ArrowUp',
      shiftKey: true,
      hasMessageContent: false,
      isEditingMessage: false,
    }),
    null,
    'ArrowUp with modifier should not trigger edit-last shortcut'
  );

  logger.debug('✓ testChatInputKeyboardCommandsHelper passed');
})();

(function testChatComposerDraftKeyHelper() {
  assert.strictEqual(
    getChatComposerDraftKey({ id: 123, email: 'Teacher@School.com ' }),
    '123|teacher@school.com',
    'Draft key helper should normalize id/email into a stable conversation key'
  );

  assert.strictEqual(
    getChatComposerDraftKey({ id: null, email: ' Parent@One.com ' }),
    '|parent@one.com',
    'Draft key helper should work with email-only identities'
  );

  assert.strictEqual(
    getChatComposerDraftKey({ id: 'abc', email: null }),
    'abc|',
    'Draft key helper should work with id-only identities'
  );

  assert.strictEqual(
    getChatComposerDraftKey({ id: null, email: '   ' }),
    null,
    'Draft key helper should return null for blank identities'
  );

  assert.strictEqual(
    getChatComposerDraftKey(null),
    null,
    'Draft key helper should return null when identity is missing'
  );

  logger.debug('✓ testChatComposerDraftKeyHelper passed');
})();

(function testChatSpecialComposerStateHelper() {
  assert.deepStrictEqual(
    resolveChatSpecialComposerState('/special'),
    {
      showSpecialCommand: true,
      isComposingSpecial: false,
    },
    'Special-composer helper should surface command affordance for exact /special trigger'
  );

  assert.deepStrictEqual(
    resolveChatSpecialComposerState('/special hello there'),
    {
      showSpecialCommand: false,
      isComposingSpecial: true,
    },
    'Special-composer helper should mark composing state when /special has trailing content'
  );

  assert.deepStrictEqual(
    resolveChatSpecialComposerState('/specialized'),
    {
      showSpecialCommand: false,
      isComposingSpecial: false,
    },
    'Special-composer helper should ignore near-miss prefixes'
  );

  assert.deepStrictEqual(
    resolveChatSpecialComposerState('regular message'),
    {
      showSpecialCommand: false,
      isComposingSpecial: false,
    },
    'Special-composer helper should keep default state for non-special messages'
  );

  logger.debug('✓ testChatSpecialComposerStateHelper passed');
})();

(function testChatConversationSearchContextKeyHelper() {
  assert.strictEqual(
    resolveChatConversationSearchContextKey({
      activeComposerDraftKey: 'chat-key-1',
      tenantId: ' Tenant-ABC ',
    }),
    'tenant-abc::chat-key-1',
    'Conversation-search context-key helper should normalize tenant ids and compose stable keys'
  );

  assert.strictEqual(
    resolveChatConversationSearchContextKey({
      activeComposerDraftKey: 'chat-key-1',
      tenantId: '   ',
    }),
    'default::chat-key-1',
    'Conversation-search context-key helper should use default tenant segment when tenant id is blank'
  );

  assert.strictEqual(
    resolveChatConversationSearchContextKey({
      activeComposerDraftKey: null,
      tenantId: 'tenant-1',
    }),
    null,
    'Conversation-search context-key helper should return null when conversation draft key is missing'
  );

  logger.debug('✓ testChatConversationSearchContextKeyHelper passed');
})();

(function testChatTimestampStateHelper() {
  assert.strictEqual(
    resolveChatTimestampMs(new Date('2026-04-24T10:00:00.000Z')),
    new Date('2026-04-24T10:00:00.000Z').getTime(),
    'Timestamp helper should resolve Date inputs to epoch milliseconds'
  );

  assert.strictEqual(
    resolveChatTimestampMs({
      toDate: () => new Date('2026-04-24T11:00:00.000Z'),
    }),
    new Date('2026-04-24T11:00:00.000Z').getTime(),
    'Timestamp helper should resolve toDate wrappers used by Firestore-like timestamp values'
  );

  assert.strictEqual(
    resolveChatTimestampMs('2026-04-24T12:00:00.000Z'),
    new Date('2026-04-24T12:00:00.000Z').getTime(),
    'Timestamp helper should resolve ISO string timestamps'
  );

  assert.strictEqual(
    resolveChatTimestampMs({ toDate: () => { throw new Error('bad timestamp'); } }),
    0,
    'Timestamp helper should fall back to zero when wrapper timestamp conversion throws'
  );

  assert.strictEqual(
    resolveChatTimestampMs('not-a-date'),
    0,
    'Timestamp helper should return zero for invalid string timestamps'
  );

  logger.debug('✓ testChatTimestampStateHelper passed');
})();

(function testChatPresenceStateHelper() {
  assert.strictEqual(
    resolveChatPresenceTimestamp('2026-04-24T12:00:00.000Z')?.toISOString(),
    '2026-04-24T12:00:00.000Z',
    'Presence helper should parse ISO timestamps'
  );

  assert.strictEqual(
    resolveChatPresenceTimestamp({
      seconds: 1713950400,
      nanoseconds: 0,
    })?.toISOString(),
    new Date(1713950400 * 1000).toISOString(),
    'Presence helper should parse Firestore-like seconds/nanoseconds timestamps'
  );

  assert.strictEqual(
    resolveChatPresenceTimestamp({ toDate: () => new Date('2026-04-24T13:00:00.000Z') })?.toISOString(),
    '2026-04-24T13:00:00.000Z',
    'Presence helper should parse toDate wrappers'
  );

  assert.strictEqual(
    resolveChatPresenceTimestamp('bad-value'),
    null,
    'Presence helper should return null for invalid inputs'
  );

  assert.strictEqual(
    resolveChatRealtimeOnline({
      isOnline: false,
      lastSeen: '2026-04-24T11:59:30.000Z',
      presenceMode: 'last_seen',
      presenceThresholdMin: 1,
      nowMs: new Date('2026-04-24T12:00:00.000Z').getTime(),
    }),
    true,
    'Realtime-online helper should mark users online when last-seen is within threshold'
  );

  assert.strictEqual(
    resolveChatRealtimeOnline({
      isOnline: true,
      lastSeen: '2026-04-24T10:00:00.000Z',
      presenceMode: 'last_seen',
      presenceThresholdMin: 1,
      nowMs: new Date('2026-04-24T12:00:00.000Z').getTime(),
    }),
    false,
    'Realtime-online helper should mark users offline when last-seen exceeds threshold'
  );

  assert.strictEqual(
    resolveChatRealtimeOnline({
      isOnline: true,
      lastSeen: null,
      presenceMode: 'flag',
      presenceThresholdMin: 1,
      nowMs: new Date('2026-04-24T12:00:00.000Z').getTime(),
    }),
    true,
    'Realtime-online helper should use explicit online flag in flag mode'
  );

  logger.debug('✓ testChatPresenceStateHelper passed');
})();

(function testChatTenorUrlStateHelper() {
  assert.strictEqual(
    resolveChatTenorIdFromUrl('https://media.tenor.com/abc123/some-file.webp'),
    'abc123',
    'Tenor URL helper should extract tenor id from media.tenor.com paths'
  );

  assert.strictEqual(
    resolveChatTenorIdFromUrl('https://example.com/not-tenor.webp'),
    null,
    'Tenor URL helper should ignore non-tenor hosts'
  );

  assert.strictEqual(
    resolveChatTenorWebpToGifGuess('https://media.tenor.com/abc123/file.webp?foo=1'),
    'https://media.tenor.com/abc123/file.gif?foo=1',
    'Tenor URL helper should convert tenor webp URLs to gif guesses'
  );

  assert.strictEqual(
    resolveChatTenorWebpToGifGuess('https://media.tenor.com/abc123/file.gif'),
    null,
    'Tenor URL helper should return null when no webp conversion is needed'
  );

  assert.strictEqual(
    resolveChatTenorPostsLookupUrl({
      tenorBaseUrl: 'https://tenor.googleapis.com/v2',
      tenorApiKey: 'key-123',
      tenorId: 'abc 123',
    }),
    'https://tenor.googleapis.com/v2/posts?ids=abc%20123&key=key-123&media_filter=basic',
    'Tenor URL helper should build encoded lookup URLs'
  );

  assert.strictEqual(
    resolveChatTenorPostsLookupUrl({
      tenorBaseUrl: 'https://tenor.googleapis.com/v2',
      tenorApiKey: '',
      tenorId: 'abc123',
    }),
    null,
    'Tenor URL helper should return null when api key is missing'
  );

  assert.strictEqual(
    resolveChatTenorGifCandidateUrl({
      mediaFormats: {
        mediumgif: { url: 'https://cdn.test/medium.gif' },
        tinygif: { url: 'https://cdn.test/tiny.gif' },
      },
    }),
    'https://cdn.test/tiny.gif',
    'Tenor URL helper should prioritize tinygif candidates'
  );

  assert.strictEqual(
    resolveChatTenorGifCandidateUrl({
      mediaFormats: null,
      fallbackUrl: 'https://cdn.test/fallback.gif',
    }),
    'https://cdn.test/fallback.gif',
    'Tenor URL helper should return fallback when media formats do not provide gif URLs'
  );

  logger.debug('✓ testChatTenorUrlStateHelper passed');
})();

(function testChatSanitizeStateHelper() {
  assert.strictEqual(
    resolveChatSanitizedMessageText('  hello  ', 'fallback'),
    '  hello  ',
    'Sanitize helper should preserve original non-empty message text'
  );
  assert.strictEqual(
    resolveChatSanitizedMessageText('   ', 'fallback'),
    'fallback',
    'Sanitize helper should fall back for blank message text'
  );
  assert.strictEqual(
    resolveChatSanitizedAttachmentFileName(' report.pdf '),
    'report.pdf',
    'Sanitize helper should trim attachment file names'
  );
  assert.strictEqual(
    resolveChatSanitizedAttachmentFileName('.'),
    'File',
    'Sanitize helper should guard invalid attachment file names'
  );
  assert.strictEqual(
    resolveChatSanitizedDateSeparatorLabel(' Yesterday '),
    'Yesterday',
    'Sanitize helper should trim date separator labels'
  );
  assert.strictEqual(
    resolveChatSanitizedDateSeparatorLabel(''),
    'Today',
    'Sanitize helper should fall back date labels when empty'
  );
  assert.strictEqual(
    resolveChatSafeDisplayInitial('Teacher'),
    'T',
    'Sanitize helper should return uppercase first initial for valid names'
  );
  assert.strictEqual(
    resolveChatSafeDisplayInitial('😄 Name'),
    'U',
    'Sanitize helper should guard non-alphanumeric initials'
  );

  logger.debug('✓ testChatSanitizeStateHelper passed');
})();

(function testChatNormalizationStateHelper() {
  assert.strictEqual(
    resolveChatNormalizedMessageId(123),
    '123',
    'Normalization helper should coerce message ids to stable strings'
  );
  assert.strictEqual(
    resolveChatNormalizedMessageId(null),
    '',
    'Normalization helper should return empty ids for nullish inputs'
  );

  assert.strictEqual(
    resolveChatNormalizedParticipantEmail(' Teacher@School.com '),
    'teacher@school.com',
    'Normalization helper should trim and lowercase participant emails'
  );
  assert.strictEqual(
    resolveChatNormalizedParticipantEmail(42),
    '',
    'Normalization helper should reject non-string participant emails'
  );

  assert.strictEqual(
    resolveChatNormalizedMessageValue('  hello   world  '),
    'hello world',
    'Normalization helper should compact message whitespace'
  );
  assert.strictEqual(
    resolveChatNormalizedMessageValue(undefined),
    '',
    'Normalization helper should return empty strings for missing message values'
  );

  logger.debug('✓ testChatNormalizationStateHelper passed');
})();

(function testChatReplyPreviewHelper() {
  assert.strictEqual(
    resolveChatReplyPreviewText({ text: '  Hello    there  ' }),
    'Hello there',
    'Reply preview helper should normalize whitespace for text replies'
  );

  assert.strictEqual(
    resolveChatReplyPreviewText({
      text: 'A'.repeat(200),
      maxLength: 20,
    }),
    `${'A'.repeat(19)}…`,
    'Reply preview helper should truncate long text with an ellipsis'
  );

  assert.strictEqual(
    resolveChatReplyPreviewText({ hasAttachments: true, attachmentCount: 3 }),
    '3 attachments',
    'Reply preview helper should describe multi-attachment replies'
  );

  assert.strictEqual(
    resolveChatReplyPreviewText({ hasGif: true }),
    'GIF',
    'Reply preview helper should provide a GIF fallback label'
  );

  assert.strictEqual(
    resolveChatReplyPreviewText({ isSpecial: true }),
    'Special message',
    'Reply preview helper should provide a special-message fallback label'
  );

  logger.debug('✓ testChatReplyPreviewHelper passed');
})();

(function testChatReplyContextStateHelper() {
  const replyContext = resolveChatReplyContextFromMessage({
    targetMessage: {
      id: 'reply-1',
      sender: 'teacher@school.com',
      senderName: 'Teacher',
      text: '  Hello   there  ',
      attachments: [{ url: 'https://cdn.test/a.png' }],
      isSpecial: false,
    },
    effectiveUserEmail: 'parent@school.com',
    selectedMemberEmail: 'teacher@school.com',
    selectedMemberName: 'Ms. Teacher',
    maxPreviewLength: 80,
  });

  assert.deepStrictEqual(
    replyContext,
    {
      messageId: 'reply-1',
      sender: 'teacher@school.com',
      senderName: 'Teacher',
      text: 'Hello there',
      isSpecial: undefined,
      hasAttachments: true,
      attachmentCount: 1,
      hasSticker: undefined,
      hasGif: undefined,
    },
    'Reply-context helper should normalize ids, sender, preview text, and attachment metadata'
  );

  assert.strictEqual(
    resolveChatReplySenderLabel({
      sender: 'parent@school.com',
      senderName: '',
      effectiveUserEmail: 'parent@school.com',
      selectedMemberEmail: 'teacher@school.com',
      selectedMemberName: 'Ms. Teacher',
    }),
    'You',
    'Reply-context sender-label helper should resolve the current user to You'
  );

  assert.strictEqual(
    resolveChatReplySenderLabel({
      sender: 'teacher@school.com',
      senderName: '',
      effectiveUserEmail: 'parent@school.com',
      selectedMemberEmail: 'teacher@school.com',
      selectedMemberName: 'Ms. Teacher',
    }),
    'Ms. Teacher',
    'Reply-context sender-label helper should prefer selected member name when the sender matches the active recipient'
  );

  assert.strictEqual(
    resolveChatReplySenderLabel({
      sender: 'unknown@school.com',
      senderName: '',
      effectiveUserEmail: 'parent@school.com',
      selectedMemberEmail: 'teacher@school.com',
      selectedMemberName: 'Ms. Teacher',
    }),
    'unknown@school.com',
    'Reply-context sender-label helper should fall back to normalized sender email when no display name exists'
  );

  logger.debug('✓ testChatReplyContextStateHelper passed');
})();

(function testChatAttachmentAutoTextHelper() {
  assert.strictEqual(
    resolveChatAttachmentAutoText({
      text: '  Custom message  ',
      files: [{ fileType: 'image/png', fileName: 'photo.png' }],
    }),
    '  Custom message  ',
    'Attachment auto-text helper should preserve provided non-empty message text'
  );

  assert.strictEqual(
    resolveChatAttachmentAutoText({
      text: '   ',
      files: [{ fileType: 'IMAGE/JPEG', fileName: 'IMG_1001.JPG' }],
    }),
    'Sent an image',
    'Attachment auto-text helper should classify single image attachments case-insensitively'
  );

  assert.strictEqual(
    resolveChatAttachmentAutoText({
      text: '',
      files: [{ fileType: 'application/octet-stream', fileName: 'clip.MP4' }],
    }),
    'Sent a video',
    'Attachment auto-text helper should classify video attachments by extension fallback'
  );

  assert.strictEqual(
    resolveChatAttachmentAutoText({
      text: '',
      files: [{ fileType: 'audio/mpeg', fileName: 'note.mp3' }],
    }),
    'Sent an audio file',
    'Attachment auto-text helper should classify single audio attachments'
  );

  assert.strictEqual(
    resolveChatAttachmentAutoText({
      text: '',
      files: [
        { fileType: 'image/png', fileName: '1.png' },
        { fileType: 'video/mp4', fileName: '2.mp4' },
        { fileType: 'audio/wav', fileName: '3.wav' },
        { fileType: 'application/pdf', fileName: '4.pdf' },
      ],
    }),
    'Sent 1 image, 1 video, 1 audio file, 1 file',
    'Attachment auto-text helper should build mixed multi-attachment summary text in stable order'
  );

  assert.strictEqual(
    resolveChatAttachmentAutoText({ text: '', files: [] }),
    '',
    'Attachment auto-text helper should return empty text when no attachments are provided'
  );

  logger.debug('✓ testChatAttachmentAutoTextHelper passed');
})();

(function testChatUploadProgressHelper() {
  assert.strictEqual(
    normalizeChatUploadProgressPercent(undefined),
    0,
    'Chat upload progress normalization should treat missing values as zero'
  );

  assert.strictEqual(
    normalizeChatUploadProgressPercent(-5),
    0,
    'Chat upload progress normalization should clamp negative values to zero'
  );

  assert.strictEqual(
    normalizeChatUploadProgressPercent(42.5),
    42.5,
    'Chat upload progress normalization should preserve in-range percentage values'
  );

  assert.strictEqual(
    normalizeChatUploadProgressPercent(250),
    100,
    'Chat upload progress normalization should clamp oversized values to 100'
  );

  assert.strictEqual(
    resolveChatUploadProgressPercentFromBytes(50, 200),
    25,
    'Chat upload byte progress helper should convert byte counters into percentage values'
  );

  assert.strictEqual(
    resolveChatUploadProgressPercentFromBytes(250, 200),
    100,
    'Chat upload byte progress helper should clamp oversized byte counters to 100 percent'
  );

  assert.strictEqual(
    resolveChatUploadProgressPercentFromBytes(10, 0),
    null,
    'Chat upload byte progress helper should return null for invalid totals'
  );

  let nowMs = 1000;
  const emissions = [];
  const progressEmitter = createChatUploadProgressEmitter({
    onProgress: (progress) => {
      emissions.push(progress);
    },
    minDeltaPercent: 5,
    minIntervalMs: 100,
    nowMs: () => nowMs,
  });

  progressEmitter.emit(0, { force: true });
  nowMs = 1010;
  progressEmitter.emit(1);
  nowMs = 1120;
  progressEmitter.emit(1);
  nowMs = 1130;
  progressEmitter.emit(1.5);
  nowMs = 1140;
  progressEmitter.emit(8);
  nowMs = 1150;
  progressEmitter.emit(7);
  nowMs = 1160;
  progressEmitter.emit(100, { force: true });

  assert.deepStrictEqual(
    emissions,
    [0, 1, 8, 100],
    'Chat upload progress emitter should throttle tiny updates while preserving monotonic progress and forced completion'
  );

  assert.strictEqual(
    progressEmitter.getLastProgress(),
    100,
    'Chat upload progress emitter should expose the last emitted progress value'
  );

  logger.debug('✓ testChatUploadProgressHelper passed');
})();

(function testUploadProgressDisplayEasingHelper() {
  assert.strictEqual(
    clampUploadProgressPercent(undefined),
    0,
    'Upload progress display clamp helper should treat missing values as zero'
  );

  assert.strictEqual(
    clampUploadProgressPercent(-12),
    0,
    'Upload progress display clamp helper should clamp negative values to zero'
  );

  assert.strictEqual(
    clampUploadProgressPercent(145),
    100,
    'Upload progress display clamp helper should clamp values above 100'
  );

  assert.strictEqual(
    normalizeUploadProgressDisplayPercent(12.49),
    12,
    'Upload progress display normalization helper should round down when decimal portion is below midpoint'
  );

  assert.strictEqual(
    normalizeUploadProgressDisplayPercent(12.5),
    13,
    'Upload progress display normalization helper should round to nearest integer percent'
  );

  assert.strictEqual(
    normalizeUploadProgressDisplayPercent(181),
    100,
    'Upload progress display normalization helper should clamp and normalize values above 100'
  );

  assert.strictEqual(
    resolveDownloadProgressLabel(false, 62),
    'Download',
    'Download progress label helper should return default idle label when no download is active'
  );

  assert.strictEqual(
    resolveDownloadProgressLabel(true, 12.5),
    'Downloading 13%',
    'Download progress label helper should render rounded active download progress labels'
  );

  assert.strictEqual(
    resolveDownloadProgressLabel(false, 62, 'Save'),
    'Save',
    'Download progress label helper should support custom idle labels'
  );

  assert.strictEqual(
    resolveDownloadProgressLabel(false, 62, '   '),
    'Download',
    'Download progress label helper should fall back to default idle label when custom label is blank'
  );

  assert.strictEqual(
    resolveProgressPercentText(12.5),
    '13%',
    'Progress percent text helper should return rounded percent text'
  );

  assert.strictEqual(
    resolveProgressPercentText(181),
    '100%',
    'Progress percent text helper should clamp percent text to 100%'
  );

  const easedForwardStep = resolveUploadProgressDisplayStep(10, 40, 100, {
    smoothingPerSecond: 8,
    minStepPercent: 0.15,
  });
  assert.ok(
    easedForwardStep > 10 && easedForwardStep < 40,
    'Upload progress display easing helper should move forward toward the target without overshooting it'
  );

  assert.strictEqual(
    resolveUploadProgressDisplayStep(58, 42, 120),
    58,
    'Upload progress display easing helper should preserve monotonic display progress for in-flight regressions'
  );

  assert.strictEqual(
    resolveUploadProgressDisplayStep(58, 0, 120),
    0,
    'Upload progress display easing helper should allow immediate reset when a new upload session starts'
  );

  assert.strictEqual(
    resolveUploadProgressDisplayStep(99.6, 100, 16, {
      completionSnapThresholdPercent: 99.5,
    }),
    100,
    'Upload progress display easing helper should snap to 100 when near-complete'
  );

  const baseNearCompleteStep = resolveUploadProgressDisplayStep(96, 100, 100, {
    smoothingPerSecond: 8,
    minStepPercent: 0,
    nearCompletionBoostStartPercent: 100,
    nearCompletionBoostMultiplier: 1,
  });

  const boostedNearCompleteStep = resolveUploadProgressDisplayStep(96, 100, 100, {
    smoothingPerSecond: 8,
    minStepPercent: 0,
    nearCompletionBoostStartPercent: 95,
    nearCompletionBoostMultiplier: 2,
  });

  assert.ok(
    boostedNearCompleteStep > baseNearCompleteStep,
    'Upload progress display easing helper should accelerate progress in the final phase when near-completion boost is enabled'
  );

  logger.debug('✓ testUploadProgressDisplayEasingHelper passed');
})();

(function testChatSearchHighlightHelper() {
  assert.deepStrictEqual(
    splitChatTextForHighlight('Fee due tomorrow', 'due'),
    [
      { text: 'Fee ', highlighted: false },
      { text: 'due', highlighted: true },
      { text: ' tomorrow', highlighted: false },
    ],
    'Chat text highlight helper should split and mark matching query sections'
  );

  assert.deepStrictEqual(
    splitChatTextForHighlight('Fee   due\nTomorrow', 'fee due'),
    [
      { text: 'Fee   due', highlighted: true },
      { text: '\nTomorrow', highlighted: false },
    ],
    'Chat text highlight helper should support whitespace-tolerant phrase matching'
  );

  assert.deepStrictEqual(
    splitChatTextForHighlight('C++ reference guide', 'c++'),
    [
      { text: 'C++', highlighted: true },
      { text: ' reference guide', highlighted: false },
    ],
    'Chat text highlight helper should escape regex characters in search queries'
  );

  assert.deepStrictEqual(
    splitChatTextForHighlight('Nothing highlighted here', '   '),
    [{ text: 'Nothing highlighted here', highlighted: false }],
    'Chat text highlight helper should return an unhighlighted segment for blank queries'
  );

  logger.debug('✓ testChatSearchHighlightHelper passed');
})();

(function testChatConversationSearchHelper() {
  assert.strictEqual(
    normalizeChatConversationSearchQuery('  Hello    TEAM  '),
    'hello team',
    'Conversation search query helper should normalize casing and whitespace'
  );

  assert.strictEqual(
    normalizeChatConversationSearchScope('reply'),
    'reply',
    'Conversation search scope helper should preserve supported scope values'
  );

  assert.strictEqual(
    normalizeChatConversationSearchScope('unknown'),
    'all',
    'Conversation search scope helper should fall back to all for unknown scope values'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeStep('all', 'next'),
    'text',
    'Conversation search scope-step helper should move from all to text when stepping next'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeStep('all', 'previous'),
    'media',
    'Conversation search scope-step helper should wrap from all to media when stepping previous'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeStep('unknown', 'next'),
    'text',
    'Conversation search scope-step helper should normalize unknown scopes before stepping'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeStep('media', 'next'),
    'all',
    'Conversation search scope-step helper should wrap from media to all when stepping next'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeStep('text', 'previous'),
    'all',
    'Conversation search scope-step helper should move from text to all when stepping previous'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeStep('unknown', 'previous'),
    'media',
    'Conversation search scope-step helper should normalize unknown scopes before stepping previous'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'ArrowDown',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    { type: 'step', direction: 'next' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+ArrowDown to next scope step'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'ArrowUp',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    { type: 'step', direction: 'previous' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+ArrowUp to previous scope step'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'ArrowRight',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
    }),
    { type: 'suggestion-step', direction: 'next' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+ArrowRight to next suggestion when no matches are available'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'ArrowLeft',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
    }),
    { type: 'suggestion-step', direction: 'previous' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+ArrowLeft to previous suggestion when no matches are available'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'ArrowRight',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    null,
    'Conversation search scope shortcut helper should ignore suggestion-step shortcuts when matches are present'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'Backspace',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    { type: 'reset-all' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+Backspace to reset scope'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'x',
      code: 'KeyX',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    { type: 'clear-query' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+X to clear the active query'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'l',
      code: 'KeyL',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
      hasQuery: true,
      hasMoreHistory: true,
      isLoadingHistory: false,
    }),
    { type: 'load-more-history' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+L to load older history when no matches are loaded yet'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'l',
      code: 'KeyL',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
      hasQuery: false,
      hasMoreHistory: true,
      isLoadingHistory: false,
    }),
    null,
    'Conversation search scope shortcut helper should ignore Alt+Shift+L when there is no active query'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'l',
      code: 'KeyL',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
      hasQuery: true,
      hasMoreHistory: true,
      isLoadingHistory: false,
    }),
    null,
    'Conversation search scope shortcut helper should ignore Alt+Shift+L when matches are already loaded'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: ')',
      code: 'Digit0',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    { type: 'reset-all' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+0 to reset scope'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: '0',
      code: 'Numpad0',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    { type: 'reset-all' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+Numpad0 to reset scope'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'A',
      code: 'KeyA',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    { type: 'select-scope', scope: 'all' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+A to select all scope'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'f',
      code: 'KeyF',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
    }),
    { type: 'select-scope', scope: 'attachment' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+F to select attachment scope'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'm',
      code: 'KeyM',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
    }),
    { type: 'select-scope', scope: 'media' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+M to select media scope'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'Enter',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
    }),
    { type: 'best-suggestion' },
    'Conversation search scope shortcut helper should resolve Alt+Shift+Enter to best-suggestion when no matches are loaded'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'Enter',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    null,
    'Conversation search scope shortcut helper should ignore Alt+Shift+Enter when matches are already available'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: '@',
      code: 'Digit2',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
    }),
    { type: 'suggestion-ordinal', ordinal: 2 },
    'Conversation search scope shortcut helper should resolve Alt+Shift+2 to the second scope suggestion'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: '2',
      code: 'Numpad2',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
    }),
    { type: 'suggestion-ordinal', ordinal: 2 },
    'Conversation search scope shortcut helper should resolve Alt+Shift+Numpad2 to the second scope suggestion'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: '2',
      code: 'Digit2',
      altKey: true,
      shiftKey: true,
      hasMatches: true,
    }),
    null,
    'Conversation search scope shortcut helper should ignore ordinal suggestion shortcuts when matches are present'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'ArrowDown',
      altKey: false,
      shiftKey: true,
      hasMatches: false,
    }),
    null,
    'Conversation search scope shortcut helper should require Alt+Shift modifiers'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'ArrowDown',
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      hasMatches: false,
    }),
    null,
    'Conversation search scope shortcut helper should ignore Alt+Shift chords when Ctrl is also pressed'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'A',
      code: 'KeyA',
      altKey: true,
      shiftKey: true,
      metaKey: true,
      hasMatches: false,
    }),
    null,
    'Conversation search scope shortcut helper should ignore Alt+Shift chords when Meta is also pressed'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'x',
      code: 'KeyX',
      altKey: false,
      shiftKey: true,
      hasMatches: false,
    }),
    null,
    'Conversation search scope shortcut helper should require Alt+Shift for clear-query chords'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'l',
      code: 'KeyL',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
      hasQuery: true,
      hasMoreHistory: false,
      isLoadingHistory: false,
    }),
    null,
    'Conversation search scope shortcut helper should ignore Alt+Shift+L when no older history is available'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeShortcutAction({
      key: 'l',
      code: 'KeyL',
      altKey: true,
      shiftKey: true,
      hasMatches: false,
      hasQuery: true,
      hasMoreHistory: true,
      isLoadingHistory: true,
    }),
    null,
    'Conversation search scope shortcut helper should ignore Alt+Shift+L while a history search load is already in progress'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesLabel('all'),
    'No matches yet. Try a different word.',
    'Conversation search no-match label helper should preserve the generic all-scope message'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesLabel('attachment'),
    'No attachment matches in this scope. Try filename-style queries.',
    'Conversation search no-match label helper should return scope-specific guidance'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesLabel('text'),
    'No text matches in this scope. Try All for broader results.',
    'Conversation search no-match label helper should return text-specific guidance'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesLabel('reply'),
    'No reply matches in this scope. Try All for broader results.',
    'Conversation search no-match label helper should return reply-specific guidance'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesLabel('media'),
    'No media matches in this scope. Try All for broader results.',
    'Conversation search no-match label helper should return media-specific guidance'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesLabel('unknown'),
    'No matches yet. Try a different word.',
    'Conversation search no-match label helper should fall back to the generic label for unknown scopes'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeLabel('attachment'),
    'Attachment',
    'Conversation search scope label helper should map scope keys to UI labels'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeLabel('unknown'),
    'All',
    'Conversation search scope label helper should normalize unknown values to All'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesGuidance(
      'reply',
      {
        all: 0,
        text: 0,
        attachment: 3,
        reply: 0,
        media: 2,
      }
    ),
    'Try Attachment (3) or Media (2).',
    'Conversation search no-match guidance helper should suggest strongest fallback scopes with counts'
  );

  assert.strictEqual(
    resolveChatConversationSearchNoMatchesGuidance(
      'attachment',
      {
        all: 0,
        text: 0,
        attachment: 0,
        reply: 0,
        media: 0,
      }
    ),
    'Tip: try filename-style queries like "invoice_april.pdf" or "fee_receipt".',
    'Conversation search no-match guidance helper should fall back to scope-specific tips when no alternatives exist'
  );

  assert.strictEqual(
    resolveChatConversationSearchSeedQuery('  Fee   reminder for April due tomorrow  ', 26, 5),
    'Fee reminder for April due',
    'Conversation search seed helper should normalize spacing and cap by max words/chars'
  );

  assert.strictEqual(
    resolveChatConversationSearchSeedQuery('One two three four five', 120, 3),
    'One two three',
    'Conversation search seed helper should enforce max word limits'
  );

  assert.strictEqual(
    resolveChatConversationSearchSeedQuery('   '),
    '',
    'Conversation search seed helper should return empty text for blank input'
  );

  const matches = resolveChatConversationSearchMatchIds(
    [
      { id: 'm1', text: 'Hello parent, fee reminder shared' },
      { id: 'm2', text: 'No match here' },
      { id: 'm3', text: 'HELLO again', deleted: true },
      { id: ' m1 ', text: 'Duplicate id should not repeat' },
      { id: 'm4', text: 'quick hello and update' },
    ],
    ' hello ',
    (value) => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  );

  assert.deepStrictEqual(
    matches,
    ['m1', 'm4'],
    'Conversation search match helper should ignore deleted rows and de-duplicate ids'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      [
        { id: 'a1', text: '', attachments: [{ fileName: 'April Fee Statement.pdf' }] },
        { id: 'a2', text: '', attachments: [{ fileName: 'Other note.txt' }] },
      ],
      'fee statement',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    ),
    ['a1'],
    'Conversation search should match attachment file names when message text is empty'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      [
        {
          id: 'r1',
          text: '',
          replyTo: { text: 'Need invoice copy from previous reminder' },
        },
      ],
      'invoice copy',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    ),
    ['r1'],
    'Conversation search should match reply preview text metadata'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      [
        { id: 's1', text: '', sticker: { name: 'Wave Hello', pack: 'friendly' } },
        { id: 'g1', text: '', gif: { title: 'Fee Celebration', source: 'giphy' } },
      ],
      'wave hello',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    ),
    ['s1'],
    'Conversation search should match sticker metadata when present'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      [
        { id: 's1', text: '', sticker: { name: 'Wave Hello', pack: 'friendly' } },
        { id: 'g1', text: '', gif: { title: 'Fee Celebration', source: 'giphy' } },
      ],
      'fee celebration',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    ),
    ['g1'],
    'Conversation search should match GIF metadata when present'
  );

  const scopedMessages = [
    { id: 't1', text: 'Fee text message only' },
    { id: 'a1', text: '', attachments: [{ fileName: 'Fee Statement.pdf' }] },
    { id: 'r1', text: '', replyTo: { text: 'Fee reminder in reply' } },
    { id: 's1', text: '', sticker: { name: 'Fee celebration sticker', pack: 'finance' } },
  ];

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      scopedMessages,
      'fee',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null),
      'text'
    ),
    ['t1'],
    'Conversation search scope=text should only return text-message matches'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      scopedMessages,
      'fee',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null),
      'attachment'
    ),
    ['a1'],
    'Conversation search scope=attachment should only return attachment/file matches'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      scopedMessages,
      'fee',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null),
      'reply'
    ),
    ['r1'],
    'Conversation search scope=reply should only return reply metadata matches'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchMatchIds(
      scopedMessages,
      'fee',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null),
      'media'
    ),
    ['a1', 's1'],
    'Conversation search scope=media should include attachment and sticker/gif/file matches'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeMatchCounts(
      [
        { id: 't1', text: 'Fee text message only' },
        { id: 'a1', text: '', attachments: [{ fileName: 'Fee Statement.pdf' }] },
        { id: 'r1', text: '', replyTo: { text: 'Fee reminder in reply' } },
        { id: 's1', text: '', sticker: { name: 'Fee celebration sticker', pack: 'finance' } },
        { id: 'u1', text: '', senderName: 'Fee Mentor' },
      ],
      'fee',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    ),
    {
      all: 5,
      text: 1,
      attachment: 1,
      reply: 1,
      media: 2,
    },
    'Conversation search scope match-count helper should return per-scope counts and include sender-only matches in all scope'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeMatchCounts(
      scopedMessages,
      '   ',
      (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
    ),
    {
      all: 0,
      text: 0,
      attachment: 0,
      reply: 0,
      media: 0,
    },
    'Conversation search scope match-count helper should return empty counts for blank queries'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeSuggestions(
      {
        all: 5,
        text: 1,
        attachment: 4,
        reply: 0,
        media: 4,
      },
      'reply',
      3
    ),
    [
      { scope: 'all', count: 5 },
      { scope: 'attachment', count: 4 },
      { scope: 'media', count: 4 },
    ],
    'Conversation search scope suggestion helper should prioritize highest counts and preserve stable scope order for ties'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeSuggestions(
      {
        all: 5,
        text: 1,
        attachment: 4,
        reply: 0,
        media: 4,
      },
      'unknown',
      2
    ),
    [
      { scope: 'attachment', count: 4 },
      { scope: 'media', count: 4 },
    ],
    'Conversation search scope suggestion helper should normalize unknown active scope to all and exclude it from suggestions'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeSuggestions(null, 'text', 3),
    [],
    'Conversation search scope suggestion helper should return empty suggestions for missing count maps'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeSuggestionByOrdinal(
      [
        { scope: 'all', count: 5 },
        { scope: 'attachment', count: 4 },
        { scope: 'media', count: 4 },
      ],
      2
    ),
    { scope: 'attachment', count: 4 },
    'Conversation search suggestion-by-ordinal helper should resolve one-based keyboard ordinals to suggestions'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeSuggestionByOrdinal(
      [
        { scope: 'all', count: 5 },
      ],
      0
    ),
    null,
    'Conversation search suggestion-by-ordinal helper should return null for non-positive ordinals'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeSuggestionByOrdinal(null, 1),
    null,
    'Conversation search suggestion-by-ordinal helper should return null for missing suggestion lists'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeSuggestionCycle(
      [
        { scope: 'all', count: 5 },
        { scope: 'attachment', count: 4 },
        { scope: 'media', count: 4 },
      ],
      null,
      'next'
    ),
    { scope: 'all', count: 5 },
    'Conversation search suggestion-cycle helper should start from the first suggestion when no chip is currently focused'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchScopeSuggestionCycle(
      [
        { scope: 'all', count: 5 },
        { scope: 'attachment', count: 4 },
        { scope: 'media', count: 4 },
      ],
      'attachment',
      'previous'
    ),
    { scope: 'all', count: 5 },
    'Conversation search suggestion-cycle helper should move backwards from the focused suggestion chip'
  );

  assert.strictEqual(
    resolveChatConversationSearchScopeSuggestionCycle(null, 'all', 'next'),
    null,
    'Conversation search suggestion-cycle helper should return null for missing suggestion lists'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchBestScopeSuggestion(
      {
        all: 5,
        text: 1,
        attachment: 4,
        reply: 0,
        media: 4,
      },
      'reply'
    ),
    { scope: 'all', count: 5 },
    'Conversation search best-scope helper should return the highest-ranked suggestion'
  );

  assert.deepStrictEqual(
    resolveChatConversationSearchBestScopeSuggestion(
      {
        all: 5,
        text: 1,
        attachment: 4,
        reply: 0,
        media: 4,
      },
      'all'
    ),
    { scope: 'attachment', count: 4 },
    'Conversation search best-scope helper should exclude the active scope before choosing a fallback'
  );

  assert.strictEqual(
    resolveChatConversationSearchBestScopeSuggestion(null, 'all'),
    null,
    'Conversation search best-scope helper should return null for missing count maps'
  );

  assert.strictEqual(
    clampChatConversationSearchIndex(99, 4),
    3,
    'Conversation search index clamp should cap high indices to the last match'
  );

  assert.strictEqual(
    clampChatConversationSearchIndex(-2, 4),
    0,
    'Conversation search index clamp should floor low indices to the first match'
  );

  assert.strictEqual(
    resolveChatConversationSearchCounterLabel({
      normalizedQuery: '   ',
      matchCount: 0,
      activeIndex: 0,
      isLoadingHistory: true,
    }),
    '',
    'Conversation search counter-label helper should hide labels for blank queries'
  );

  assert.strictEqual(
    resolveChatConversationSearchCounterLabel({
      normalizedQuery: 'fee',
      matchCount: 0,
      activeIndex: 0,
      isLoadingHistory: true,
    }),
    'Searching...',
    'Conversation search counter-label helper should show a loading label while searching history with no matches'
  );

  assert.strictEqual(
    resolveChatConversationSearchCounterLabel({
      normalizedQuery: 'fee',
      matchCount: 0,
      activeIndex: 0,
      isLoadingHistory: false,
    }),
    '0/0',
    'Conversation search counter-label helper should show 0/0 when no matches are loaded and history is idle'
  );

  assert.strictEqual(
    resolveChatConversationSearchCounterLabel({
      normalizedQuery: 'fee',
      matchCount: 4,
      activeIndex: 99,
      isLoadingHistory: false,
    }),
    '4/4',
    'Conversation search counter-label helper should clamp high active indices to the final loaded match'
  );

  assert.strictEqual(
    resolveChatConversationSearchCounterLabel({
      normalizedQuery: 'fee',
      matchCount: 4,
      activeIndex: -3,
      isLoadingHistory: false,
    }),
    '1/4',
    'Conversation search counter-label helper should clamp low active indices to the first loaded match'
  );

  assert.strictEqual(
    resolveChatConversationSearchNextIndex(0, 3, 'previous'),
    2,
    'Conversation search previous navigation should wrap to the final match'
  );

  assert.strictEqual(
    resolveChatConversationSearchNextIndex(2, 3, 'next'),
    0,
    'Conversation search next navigation should wrap to the first match'
  );

  assert.strictEqual(
    shouldLoadOlderForConversationSearch({
      normalizedQuery: 'fee pending',
      matchCount: 0,
      hasMoreHistory: true,
      isLoadingHistory: false,
    }),
    true,
    'Conversation search should load older history when query exists, no matches are loaded, and history remains'
  );

  assert.strictEqual(
    shouldLoadOlderForConversationSearch({
      normalizedQuery: 'fee pending',
      matchCount: 1,
      hasMoreHistory: true,
      isLoadingHistory: false,
    }),
    false,
    'Conversation search should not load older history when loaded matches already exist'
  );

  assert.strictEqual(
    shouldLoadOlderForConversationSearch({
      normalizedQuery: '   ',
      matchCount: 0,
      hasMoreHistory: true,
      isLoadingHistory: false,
    }),
    false,
    'Conversation search should not load older history for an empty query'
  );

  assert.strictEqual(
    shouldLoadOlderForConversationSearch({
      normalizedQuery: 'fee pending',
      matchCount: 0,
      hasMoreHistory: true,
      isLoadingHistory: true,
    }),
    false,
    'Conversation search should not start a second history load while one is already active'
  );

  const snippet = resolveChatConversationSearchSnippet(
    [
      { id: 'm1', text: 'Parent requested fee reminder for April tuition due tomorrow.' },
      { id: 'm2', text: 'No match line' },
    ],
    ['m1'],
    0,
    'fee reminder',
    (value) => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  );

  assert.deepStrictEqual(
    snippet,
    {
      messageId: 'm1',
      matchType: 'text',
      beforeText: 'Parent requested ',
      matchText: 'fee reminder',
      afterText: ' for April tuition due tomorrow.',
    },
    'Conversation search snippet helper should return context around the active match'
  );

  const clippedSnippet = resolveChatConversationSearchSnippet(
    [
      {
        id: 'm1',
        text: '12345678901234567890 target 12345678901234567890 end',
      },
    ],
    ['m1'],
    0,
    'target',
    (value) => (typeof value === 'string' && value ? value : null),
    12
  );

  assert.deepStrictEqual(
    clippedSnippet,
    {
      messageId: 'm1',
      matchType: 'text',
      beforeText: '...01234567890 ',
      matchText: 'target',
      afterText: ' 12345678901...',
    },
    'Conversation search snippet helper should add ellipsis when clipping context around a mid-text match'
  );

  const boundarySnippet = resolveChatConversationSearchSnippet(
    [{ id: 'm1', text: 'target appears right away in this line' }],
    ['m1'],
    0,
    'target',
    (value) => (typeof value === 'string' && value ? value : null),
    12
  );

  assert.deepStrictEqual(
    boundarySnippet,
    {
      messageId: 'm1',
      matchType: 'text',
      beforeText: '',
      matchText: 'target',
      afterText: ' appears rig...',
    },
    'Conversation search snippet helper should avoid a leading ellipsis when the match starts at the beginning of the message'
  );

  const attachmentSnippet = resolveChatConversationSearchSnippet(
    [
      {
        id: 'a1',
        text: '',
        attachments: [{ fileName: 'April Fee Statement.pdf' }],
      },
    ],
    ['a1'],
    0,
    'statement',
    (value) => (typeof value === 'string' && value ? value : null)
  );

  assert.deepStrictEqual(
    attachmentSnippet,
    {
      messageId: 'a1',
      matchType: 'attachment',
      beforeText: 'April Fee ',
      matchText: 'Statement',
      afterText: '.pdf',
    },
    'Conversation search snippet helper should derive preview snippets from attachment metadata when body text is empty'
  );

  const scopedTextSnippet = resolveChatConversationSearchSnippet(
    [
      {
        id: 'mScoped',
        text: 'Fee appears in body text',
        attachments: [{ fileName: 'Fee Statement.pdf' }],
      },
    ],
    ['mScoped'],
    0,
    'fee',
    (value) => (typeof value === 'string' && value ? value : null),
    38,
    'text'
  );

  assert.deepStrictEqual(
    scopedTextSnippet,
    {
      messageId: 'mScoped',
      matchType: 'text',
      beforeText: '',
      matchText: 'Fee',
      afterText: ' appears in body text',
    },
    'Conversation search snippet helper should honor scope=text when multiple source types contain the query'
  );

  const scopedAttachmentSnippet = resolveChatConversationSearchSnippet(
    [
      {
        id: 'mScoped',
        text: 'Fee appears in body text',
        attachments: [{ fileName: 'Fee Statement.pdf' }],
      },
    ],
    ['mScoped'],
    0,
    'fee',
    (value) => (typeof value === 'string' && value ? value : null),
    38,
    'attachment'
  );

  assert.deepStrictEqual(
    scopedAttachmentSnippet,
    {
      messageId: 'mScoped',
      matchType: 'attachment',
      beforeText: '',
      matchText: 'Fee',
      afterText: ' Statement.pdf',
    },
    'Conversation search snippet helper should honor scope=attachment when multiple source types contain the query'
  );

  assert.strictEqual(
    resolveChatConversationSearchSnippetTypeLabel('gif'),
    'GIF',
    'Conversation search snippet type label helper should map match types to concise badges'
  );

  assert.strictEqual(
    resolveChatConversationSearchSnippet(
      [{ id: 'm1', text: 'Only one line' }],
      ['m1'],
      0,
      'missing',
      (value) => (typeof value === 'string' && value ? value : null)
    ),
    null,
    'Conversation search snippet helper should return null when active message text does not contain the query'
  );

  logger.debug('✓ testChatConversationSearchHelper passed');
})();

(function testChatConversationSearchMatchCollectionsHelper() {
  const result = resolveChatConversationSearchMatchCollections([
    'm3',
    '',
    'm1',
    'm3',
    'm7',
  ]);

  assert.deepStrictEqual(
    Array.from(result.matchIdSet.values()),
    ['m3', 'm1', 'm7'],
    'Conversation-search match collections helper should normalize to unique non-empty ids in first-seen order'
  );

  assert.deepStrictEqual(
    Array.from(result.matchIndexById.entries()),
    [
      ['m3', 3],
      ['m1', 2],
      ['m7', 4],
    ],
    'Conversation-search match collections helper should retain latest index mapping for repeated ids'
  );

  const emptyResult = resolveChatConversationSearchMatchCollections([]);
  assert.strictEqual(
    emptyResult.matchIdSet.size,
    0,
    'Conversation-search match collections helper should return empty set for empty input'
  );
  assert.strictEqual(
    emptyResult.matchIndexById.size,
    0,
    'Conversation-search match collections helper should return empty index map for empty input'
  );

  logger.debug('✓ testChatConversationSearchMatchCollectionsHelper passed');
})();

(function testChatConversationSearchMetricsHelper() {
  const searchMetricsState = createChatConversationSearchUxRollupState();
  assert.deepStrictEqual(
    searchMetricsState,
    {
      totalEvents: 0,
      scopeSwitches: 0,
      noResultRecoveries: 0,
      shortcutScopeSwitches: 0,
      shortcutNoResultRecoveries: 0,
      bySource: {},
      lastMetricAt: 0,
    },
    'Conversation-search metrics helper should expose zeroed initial rollup state'
  );

  const firstSearchPayload = recordChatConversationSearchUxRollup(
    searchMetricsState,
    'scope-switch',
    'manual-select',
    1000
  );
  assert.deepStrictEqual(
    firstSearchPayload,
    {
      totalEvents: 1,
      scopeSwitches: 1,
      noResultRecoveries: 0,
      shortcutScopeSwitches: 0,
      shortcutNoResultRecoveries: 0,
      source: 'manual-select',
      sourceCount: 1,
      eventKind: 'scope-switch',
    },
    'Conversation-search metrics helper should emit on first event with source counters'
  );
  assert.strictEqual(
    searchMetricsState.lastMetricAt,
    1000,
    'Conversation-search metrics helper should store emission timestamp after cadence emission'
  );

  assert.strictEqual(
    recordChatConversationSearchUxRollup(
      searchMetricsState,
      'no-result-recovery',
      'shortcut-enter',
      1100
    ),
    null,
    'Conversation-search metrics helper should suppress non-cadence events before thresholds'
  );

  for (let index = 0; index < 7; index += 1) {
    recordChatConversationSearchUxRollup(
      searchMetricsState,
      'scope-switch',
      'shortcut-step',
      1200 + index
    );
  }

  assert.deepStrictEqual(
    recordChatConversationSearchUxRollup(
      searchMetricsState,
      'scope-switch',
      'shortcut-step',
      1300
    ),
    {
      totalEvents: 10,
      scopeSwitches: 9,
      noResultRecoveries: 1,
      shortcutScopeSwitches: 8,
      shortcutNoResultRecoveries: 1,
      source: 'shortcut-step',
      sourceCount: 8,
      eventKind: 'scope-switch',
    },
    'Conversation-search metrics helper should emit on every tenth event with shortcut counters'
  );

  const searchIntervalState = createChatConversationSearchUxRollupState();
  recordChatConversationSearchUxRollup(searchIntervalState, 'no-result-recovery', 'manual', 500);

  assert.strictEqual(
    recordChatConversationSearchUxRollup(
      searchIntervalState,
      'no-result-recovery',
      'manual',
      45000
    ),
    null,
    'Conversation-search metrics helper should not emit before interval threshold when cadence does not match'
  );

  assert.deepStrictEqual(
    recordChatConversationSearchUxRollup(
      searchIntervalState,
      'scope-switch',
      'manual',
      60550
    ),
    {
      totalEvents: 3,
      scopeSwitches: 1,
      noResultRecoveries: 2,
      shortcutScopeSwitches: 0,
      shortcutNoResultRecoveries: 0,
      source: 'manual',
      sourceCount: 3,
      eventKind: 'scope-switch',
    },
    'Conversation-search metrics helper should emit after interval threshold with aggregated source counts'
  );

  const searchSourceNormalizationState = createChatConversationSearchUxRollupState();
  assert.strictEqual(
    recordChatConversationSearchUxRollup(
      searchSourceNormalizationState,
      'scope-switch',
      '   ',
      900
    )?.source,
    'unknown',
    'Conversation-search metrics helper should normalize blank sources to unknown labels'
  );

  logger.debug('✓ testChatConversationSearchMetricsHelper passed');
})();

(function testChatUnreadRepairMetricsHelper() {
  assert.deepStrictEqual(
    resolveChatUnreadRepairRunPayload(' Parent@One.com ', 5, 1000, 1400),
    {
      partnerEmail: 'parent@one.com',
      fixedCount: 5,
      durationMs: 400,
    },
    'Unread-repair metric helper should normalize partner email and preserve positive fixed counts with elapsed duration'
  );

  assert.deepStrictEqual(
    resolveChatUnreadRepairRunPayload('   ', -3, 1000, 900),
    {
      partnerEmail: 'unknown',
      fixedCount: 0,
      durationMs: 0,
    },
    'Unread-repair metric helper should normalize blank emails, clamp invalid counts, and prevent negative duration values'
  );

  assert.deepStrictEqual(
    resolveChatUnreadRepairRunPayload(undefined, '7.8', 500, 2500),
    {
      partnerEmail: 'unknown',
      fixedCount: 7,
      durationMs: 2000,
    },
    'Unread-repair metric helper should normalize unknown inputs and coerce numeric fixed-count values'
  );

  logger.debug('✓ testChatUnreadRepairMetricsHelper passed');
})();

(function testChatUnreadRepairEligibilityHelper() {
  assert.deepStrictEqual(
    resolveChatUnreadRepairEligibility({
      userEmail: ' Teacher@School.com ',
      partnerEmail: ' Parent@One.com ',
      isFocused: true,
      isAppActive: true,
      inFlight: false,
      lastPartnerEmail: null,
      lastRunAtMs: 0,
      nowMs: 1000,
      throttleMs: 45000,
    }),
    {
      shouldRun: true,
      userEmail: 'teacher@school.com',
      partnerEmail: 'parent@one.com',
      nowMs: 1000,
    },
    'Unread-repair eligibility helper should normalize emails and allow repairs when all gating conditions are met'
  );

  assert.strictEqual(
    resolveChatUnreadRepairEligibility({
      userEmail: 'teacher@school.com',
      partnerEmail: 'parent@one.com',
      isFocused: true,
      isAppActive: true,
      inFlight: true,
      lastPartnerEmail: 'parent@one.com',
      lastRunAtMs: 990,
      nowMs: 1000,
      throttleMs: 45000,
    }).shouldRun,
    false,
    'Unread-repair eligibility helper should block repairs while another run is in flight'
  );

  assert.strictEqual(
    resolveChatUnreadRepairEligibility({
      userEmail: 'teacher@school.com',
      partnerEmail: 'parent@one.com',
      isFocused: true,
      isAppActive: true,
      inFlight: false,
      lastPartnerEmail: ' parent@one.com ',
      lastRunAtMs: 960,
      nowMs: 1000,
      throttleMs: 50,
    }).shouldRun,
    false,
    'Unread-repair eligibility helper should throttle repeated repairs for the same partner within the configured window'
  );

  assert.strictEqual(
    resolveChatUnreadRepairEligibility({
      userEmail: 'teacher@school.com',
      partnerEmail: 'parent@one.com',
      isFocused: true,
      isAppActive: true,
      inFlight: false,
      lastPartnerEmail: 'other@one.com',
      lastRunAtMs: 999,
      nowMs: 1000,
      throttleMs: 45000,
    }).shouldRun,
    true,
    'Unread-repair eligibility helper should allow repairs when partner changed even if previous run was recent'
  );

  assert.strictEqual(
    resolveChatUnreadRepairEligibility({
      userEmail: 'teacher@school.com',
      partnerEmail: 'parent@one.com',
      isFocused: true,
      isAppActive: true,
      inFlight: false,
      lastPartnerEmail: 'parent@one.com',
      lastRunAtMs: 999,
      nowMs: 1000,
      throttleMs: 0,
    }).shouldRun,
    true,
    'Unread-repair eligibility helper should disable throttling when throttle window is zero'
  );

  const missingIdentityResult = resolveChatUnreadRepairEligibility({
    userEmail: '   ',
    partnerEmail: 'parent@one.com',
    isFocused: true,
    isAppActive: true,
    inFlight: false,
    lastPartnerEmail: null,
    lastRunAtMs: 0,
    nowMs: 1000,
    throttleMs: 45000,
  });
  assert.strictEqual(
    missingIdentityResult.shouldRun,
    false,
    'Unread-repair eligibility helper should block repairs when participant identities are missing'
  );
  assert.strictEqual(
    missingIdentityResult.userEmail,
    null,
    'Unread-repair eligibility helper should surface normalized missing user email as null'
  );

  logger.debug('✓ testChatUnreadRepairEligibilityHelper passed');
})();

(function testChatUnreadDividerStateHelper() {
  const normalizeParticipantEmail = (value) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  const normalizeMessageId = (value) =>
    value === null || value === undefined ? '' : String(value);

  const derivedWithUnread = resolveChatUnreadDividerDerivedState({
    displayedMessages: [
      {
        id: 'm1',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: false,
      },
      {
        id: 'm2',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: true,
      },
      {
        id: 'm3',
        sender: 'teacher@school.com',
        recipientId: 'parent@one.com',
        read: false,
      },
    ],
    effectiveUserEmail: 'Teacher@School.com',
    selectedTeamMemberEmail: 'Parent@One.com',
    unreadDividerSeedCount: 5,
    normalizeParticipantEmail,
    normalizeMessageId,
  });

  assert.deepStrictEqual(
    derivedWithUnread.incomingUnreadMessageIds,
    ['m1'],
    'Unread-divider helper should collect unread incoming ids in order'
  );
  assert.strictEqual(
    derivedWithUnread.firstUnreadMessageId,
    'm1',
    'Unread-divider helper should expose first unread id when available'
  );
  assert.strictEqual(
    derivedWithUnread.unreadSeparatorAnchorMessageId,
    'm1',
    'Unread-divider helper should anchor separator to first unread id when present'
  );
  assert.strictEqual(
    derivedWithUnread.latestIncomingMessageId,
    'm2',
    'Unread-divider helper should track latest incoming id independently of unread state'
  );
  assert.strictEqual(
    derivedWithUnread.unreadDividerLabel,
    '1 unread message',
    'Unread-divider helper should derive singular unread label'
  );

  const derivedSeedOnly = resolveChatUnreadDividerDerivedState({
    displayedMessages: [
      {
        id: 'm10',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: true,
      },
      {
        id: 'm11',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: true,
      },
      {
        id: 'm12',
        sender: 'parent@one.com',
        recipientId: 'teacher@school.com',
        read: true,
      },
    ],
    effectiveUserEmail: 'teacher@school.com',
    selectedTeamMemberEmail: 'parent@one.com',
    unreadDividerSeedCount: 2,
    normalizeParticipantEmail,
    normalizeMessageId,
  });

  assert.strictEqual(
    derivedSeedOnly.incomingUnreadCount,
    0,
    'Unread-divider helper should report zero live unread count when all incoming are read'
  );
  assert.strictEqual(
    derivedSeedOnly.unreadDividerSeedAnchorMessageId,
    'm11',
    'Unread-divider helper should derive seed anchor from incoming boundary when no unread exists'
  );
  assert.strictEqual(
    derivedSeedOnly.unreadSeparatorAnchorMessageId,
    'm11',
    'Unread-divider helper should reuse seed anchor when first unread is absent'
  );
  assert.strictEqual(
    derivedSeedOnly.unreadDividerDisplayCount,
    2,
    'Unread-divider helper should prefer seed display count when live unread count is zero'
  );
  assert.strictEqual(
    derivedSeedOnly.unreadDividerLabel,
    '2 unread messages',
    'Unread-divider helper should derive plural unread label'
  );

  const derivedSeedFallback = resolveChatUnreadDividerDerivedState({
    displayedMessages: [
      {
        id: 'root-1',
        sender: 'teacher@school.com',
        recipientId: 'parent@one.com',
        read: true,
      },
    ],
    effectiveUserEmail: 'teacher@school.com',
    selectedTeamMemberEmail: 'parent@one.com',
    unreadDividerSeedCount: 3,
    normalizeParticipantEmail,
    normalizeMessageId,
  });

  assert.strictEqual(
    derivedSeedFallback.unreadDividerSeedAnchorMessageId,
    'root-1',
    'Unread-divider helper should fallback seed anchor to first displayed message when no incoming messages exist'
  );
  assert.strictEqual(
    derivedSeedFallback.unreadDividerLabel,
    '3 unread messages',
    'Unread-divider helper should still derive label from seed count in fallback mode'
  );

  logger.debug('✓ testChatUnreadDividerStateHelper passed');
})();

(function testChatUnreadSeparatorReconcileStateHelper() {
  assert.deepStrictEqual(
    resolveChatUnreadSeparatorReconcilePlan({
      showUnreadSeparator: false,
      unreadSeparatorMessageId: 'm1',
      unreadSeparatorAnchorMessageId: 'm2',
      anchorExists: false,
    }),
    {
      shouldUpdateAnchor: false,
      nextAnchorMessageId: null,
      shouldClearUnreadSeparator: false,
    },
    'Unread-separator reconcile helper should no-op when separator is hidden'
  );

  assert.strictEqual(
    resolveChatUnreadSeparatorReconcilePlan({
      showUnreadSeparator: true,
      unreadSeparatorMessageId: 'm1',
      unreadSeparatorAnchorMessageId: 'm2',
      anchorExists: true,
    }).shouldClearUnreadSeparator,
    false,
    'Unread-separator reconcile helper should no-op when anchor message still exists'
  );

  assert.deepStrictEqual(
    resolveChatUnreadSeparatorReconcilePlan({
      showUnreadSeparator: true,
      unreadSeparatorMessageId: 'm1',
      unreadSeparatorAnchorMessageId: 'm2',
      anchorExists: false,
    }),
    {
      shouldUpdateAnchor: true,
      nextAnchorMessageId: 'm2',
      shouldClearUnreadSeparator: false,
    },
    'Unread-separator reconcile helper should retarget anchor when old id is missing but new anchor exists'
  );

  assert.deepStrictEqual(
    resolveChatUnreadSeparatorReconcilePlan({
      showUnreadSeparator: true,
      unreadSeparatorMessageId: 'm1',
      unreadSeparatorAnchorMessageId: null,
      anchorExists: false,
    }),
    {
      shouldUpdateAnchor: false,
      nextAnchorMessageId: null,
      shouldClearUnreadSeparator: true,
    },
    'Unread-separator reconcile helper should clear separator when no viable anchor remains'
  );

  logger.debug('✓ testChatUnreadSeparatorReconcileStateHelper passed');
})();

(function testChatConversationSummaryStateHelper() {
  assert.strictEqual(
    resolveChatLiveConversationSummary({
      displayedMessages: [],
      partnerEmail: 'parent@one.com',
      userEmail: 'teacher@school.com',
      incomingUnreadCount: 4,
      isFocused: false,
      isAppActive: false,
    }),
    null,
    'Conversation-summary helper should return null when there are no displayed messages'
  );

  const summary = resolveChatLiveConversationSummary({
    displayedMessages: [
      { id: 'm1', sender: 'parent@one.com', timestamp: '2026-04-24T10:00:00.000Z', text: 'Hi' },
      { id: null, sender: 'parent@one.com', timestamp: '2026-04-24T10:01:00.000Z', text: 'Skip me' },
      {
        id: 'm2',
        sender: 'Teacher@School.com',
        timestamp: { toDate: () => new Date('2026-04-24T10:02:00.000Z') },
        text: '   ',
        attachments: [{ url: 'https://cdn.test/file.pdf' }],
        delivered: true,
        read: false,
        editCount: 2,
        isSpecial: false,
      },
    ],
    partnerEmail: 'Parent@One.com',
    partnerId: 'parent-id-1',
    partnerName: 'Parent One',
    tenantId: 'tenant-1',
    userEmail: 'teacher@school.com',
    incomingUnreadCount: 7,
    isFocused: false,
    isAppActive: false,
  });

  assert.deepStrictEqual(
    summary,
    {
      partnerEmail: 'parent@one.com',
      partnerId: 'parent-id-1',
      partnerName: 'Parent One',
      tenantId: 'tenant-1',
      unreadCount: 7,
      updatedAt: '2026-04-24T10:02:00.000Z',
      lastMessage: {
        messageId: 'm2',
        text: '📎 Attachment',
        timestamp: '2026-04-24T10:02:00.000Z',
        sender: 'Teacher@School.com',
        isOwnMessage: true,
        delivered: true,
        read: false,
        type: 'attachment',
        attachmentCount: 1,
        editedAt: undefined,
        editCount: 2,
        deleted: false,
        deletedAt: undefined,
        deletedBy: undefined,
        isSpecial: false,
      },
    },
    'Conversation-summary helper should normalize identity and derive last-message preview fields'
  );

  const focusedSummary = resolveChatLiveConversationSummary({
    displayedMessages: [
      {
        id: 'm-special',
        sender: 'parent@one.com',
        timestamp: 1713950000000,
        text: '   ',
        isSpecial: true,
      },
    ],
    partnerEmail: 'parent@one.com',
    userEmail: 'teacher@school.com',
    incomingUnreadCount: 5,
    isFocused: true,
    isAppActive: true,
  });

  assert.strictEqual(
    focusedSummary?.unreadCount,
    0,
    'Conversation-summary helper should zero unread count when chat is focused and app is active'
  );
  assert.strictEqual(
    focusedSummary?.lastMessage?.type,
    'special',
    'Conversation-summary helper should classify special messages in preview metadata'
  );
  assert.strictEqual(
    focusedSummary?.lastMessage?.text,
    'Special message',
    'Conversation-summary helper should fallback special preview text when message text is blank'
  );

  logger.debug('✓ testChatConversationSummaryStateHelper passed');
})();

(function testChatRecipientLookupStateHelper() {
  const normalizeParticipantEmail = (value) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';

  const teamMembersByRecipientKey = resolveChatTeamMembersByRecipientKey({
    teamMembersWithChatInfo: [
      {
        id: 'parent-a@school.com',
        email: 'parent-a@school.com',
        name: 'Parent A',
      },
    ],
    teamMembers: [
      {
        id: 'parent-b-id',
        email: 'Parent-B@School.com',
        name: 'Parent B',
      },
    ],
    normalizeParticipantEmail,
  });

  assert.strictEqual(
    teamMembersByRecipientKey.get('parent-a@school.com')?.name,
    'Parent A',
    'Recipient-lookup helper should index chat-info members by email and id'
  );
  assert.strictEqual(
    teamMembersByRecipientKey.get('parent-b@school.com')?.name,
    'Parent B',
    'Recipient-lookup helper should include roster members not present in chat-info list'
  );
  assert.strictEqual(
    teamMembersByRecipientKey.get('parent-b-id')?.name,
    'Parent B',
    'Recipient-lookup helper should map roster ids for recipient resolution'
  );

  assert.strictEqual(
    resolveChatPendingRecipientEmail({
      recipientId: 'Parent-B@School.com',
      teamMembersByRecipientKey,
      normalizeParticipantEmail,
    }),
    'Parent-B@School.com',
    'Recipient-lookup helper should return resolved team-member email when a lookup hit exists'
  );

  assert.strictEqual(
    resolveChatPendingRecipientEmail({
      recipientId: 'unknown@school.com',
      teamMembersByRecipientKey,
      normalizeParticipantEmail,
    }),
    'unknown@school.com',
    'Recipient-lookup helper should fall back to raw recipient id when no lookup hit exists'
  );

  assert.strictEqual(
    resolveChatPendingRecipientEmail({
      recipientId: '   ',
      teamMembersByRecipientKey,
      normalizeParticipantEmail,
    }),
    '',
    'Recipient-lookup helper should return empty string for blank recipient ids'
  );

  logger.debug('✓ testChatRecipientLookupStateHelper passed');
})();

(function testChatTeamMemberListStateHelper() {
  const sanitizeEmailKey = (value) =>
    typeof value === 'string' ? value.trim().toLowerCase() : '';

  const members = [
    {
      id: 'teacher@school.com',
      email: 'teacher@school.com',
      name: 'Teacher',
      unreadCount: 0,
      summaryUpdatedAt: '2026-04-23T08:00:00.000Z',
    },
    {
      id: 'parent-a@school.com',
      email: 'parent-a@school.com',
      name: 'Alpha Parent',
      unreadCount: 3,
      summaryUpdatedAt: '2026-04-24T10:00:00.000Z',
      lastMessage: { timestamp: '2026-04-24T10:03:00.000Z' },
    },
    {
      id: 'parent-b@school.com',
      email: 'parent-b@school.com',
      name: 'Beta Parent',
      unreadCount: 1,
      summaryUpdatedAt: '2026-04-24T10:01:00.000Z',
      lastMessage: { timestamp: '2026-04-24T10:02:00.000Z' },
    },
    {
      id: 'parent-c@school.com',
      email: 'parent-c@school.com',
      name: 'Charlie Parent',
      unreadCount: 5,
      summaryUpdatedAt: '2026-04-24T09:30:00.000Z',
      lastMessage: { timestamp: '2026-04-24T09:45:00.000Z' },
    },
  ];

  const filtered = resolveChatFilteredTeamMembers({
    members,
    pinnedChats: {
      'parent-b@school.com': 1,
    },
    currentUserEmail: 'TEACHER@school.com',
    searchQuery: 'parent',
    sanitizeEmailKey,
  });

  assert.deepStrictEqual(
    filtered.map((member) => member.email),
    ['parent-b@school.com', 'parent-a@school.com', 'parent-c@school.com'],
    'Team-member list helper should exclude current user, honor pin order, and then apply recency sorting'
  );

  const unreadTieBreak = resolveChatFilteredTeamMembers({
    members: [
      {
        id: 'a',
        email: 'a@school.com',
        name: 'A Parent',
        unreadCount: 1,
        summaryUpdatedAt: '2026-04-24T10:00:00.000Z',
      },
      {
        id: 'b',
        email: 'b@school.com',
        name: 'B Parent',
        unreadCount: 4,
        summaryUpdatedAt: '2026-04-24T10:00:00.000Z',
      },
      {
        id: 'c',
        email: 'c@school.com',
        name: 'C Parent',
        unreadCount: 4,
        summaryUpdatedAt: '2026-04-24T10:00:00.000Z',
      },
    ],
    pinnedChats: {},
    currentUserEmail: null,
    searchQuery: '',
    sanitizeEmailKey,
  });

  assert.deepStrictEqual(
    unreadTieBreak.map((member) => member.email),
    ['b@school.com', 'c@school.com', 'a@school.com'],
    'Team-member list helper should use unread count and then name as tie-breakers when recency matches'
  );

  logger.debug('✓ testChatTeamMemberListStateHelper passed');
})();

(function testChatRosterSnapshotStateHelper() {
  const roster = [
    { id: '1', email: 'Teacher@One.com' },
    { id: '2', email: 'helper@one.com ' },
    { id: '3', email: null },
  ];

  const rawSnapshot = new Map([
    ['teacher@one.com', { id: '1', email: 'teacher@one.com', isOnline: true }],
    ['helper@one.com', { id: '2', email: 'helper@one.com', isOnline: false }],
    ['outsider@one.com', { id: '9', email: 'outsider@one.com', isOnline: true }],
  ]);

  const filteredSnapshot = resolveChatRosterSnapshotForRoster(roster, rawSnapshot);
  assert.strictEqual(
    filteredSnapshot.size,
    2,
    'Roster-snapshot helper should keep only snapshot entries that map to roster emails'
  );
  assert.strictEqual(
    filteredSnapshot.has('teacher@one.com'),
    true,
    'Roster-snapshot helper should normalize roster email casing for matching'
  );
  assert.strictEqual(
    filteredSnapshot.has('helper@one.com'),
    true,
    'Roster-snapshot helper should trim and normalize roster email values'
  );
  assert.strictEqual(
    filteredSnapshot.has('outsider@one.com'),
    false,
    'Roster-snapshot helper should exclude non-roster snapshot entries'
  );

  const emptyRosterResult = resolveChatRosterSnapshotForRoster([], rawSnapshot);
  assert.strictEqual(
    emptyRosterResult.size,
    0,
    'Roster-snapshot helper should return empty maps when roster is empty'
  );

  logger.debug('✓ testChatRosterSnapshotStateHelper passed');
})();

(function testChatReactionStateHelper() {
  const baseState = new Map([
    [
      'message-1',
      {
        '❤️': new Set(['teacher@school.com']),
        '👍': new Set(['parent@one.com']),
      },
    ],
  ]);

  const regularToggleResult = resolveChatOptimisticReactionMap(
    baseState,
    'message-1',
    '❤️',
    'teacher@school.com',
    false
  );
  assert.deepStrictEqual(
    Array.from(regularToggleResult.get('message-1')?.['❤️'] ?? []),
    [],
    'Reaction helper should toggle off the current user reaction for regular messages'
  );
  assert.deepStrictEqual(
    Array.from(regularToggleResult.get('message-1')?.['👍'] ?? []),
    ['parent@one.com'],
    'Reaction helper should preserve unrelated reactions for regular messages'
  );

  const regularSwitchResult = resolveChatOptimisticReactionMap(
    baseState,
    'message-1',
    '🔥',
    'teacher@school.com',
    false
  );
  assert.deepStrictEqual(
    Array.from(regularSwitchResult.get('message-1')?.['🔥'] ?? []),
    ['teacher@school.com'],
    'Reaction helper should add the selected reaction for regular messages'
  );
  assert.strictEqual(
    regularSwitchResult.get('message-1')?.['❤️'],
    undefined,
    'Reaction helper should remove the previous user reaction when switching emojis'
  );

  const specialToggleResult = resolveChatOptimisticReactionMap(
    baseState,
    'message-1',
    '❤️',
    'teacher@school.com',
    true
  );
  assert.strictEqual(
    specialToggleResult.get('message-1')?.['❤️'],
    undefined,
    'Reaction helper should remove the user reaction from special messages when toggled off'
  );

  const emptyRemovalResult = resolveChatOptimisticReactionMap(
    new Map([['message-2', { '❤️': new Set(['teacher@school.com']) }]]),
    'message-2',
    '❤️',
    'teacher@school.com',
    true
  );
  assert.deepStrictEqual(
    emptyRemovalResult.get('message-2'),
    {},
    'Reaction helper should keep explicit empty entries during optimistic removal windows'
  );

  assert.strictEqual(
    shouldKeepChatOptimisticReactionUntil(1000, 900),
    true,
    'Reaction helper should keep optimistic reactions while ttl is in the future'
  );
  assert.strictEqual(
    shouldKeepChatOptimisticReactionUntil(1000, 1000),
    false,
    'Reaction helper should expire optimistic reactions at ttl boundary'
  );
  assert.strictEqual(
    shouldKeepChatOptimisticReactionUntil(undefined, 1000),
    false,
    'Reaction helper should not keep optimistic reactions when ttl is missing'
  );

  const optimisticUntilMap = new Map([
    ['message-1', 2000],
    ['message-2', 1000],
    ['message-3', 3000],
  ]);
  const expiryIds = resolveChatOptimisticReactionExpiryIds(
    optimisticUntilMap,
    new Set(['message-1', 'message-2']),
    1500
  );
  assert.strictEqual(expiryIds.has('message-2'), true, 'Reaction helper should expire ttl-reached entries');
  assert.strictEqual(expiryIds.has('message-3'), true, 'Reaction helper should expire optimistic ids missing from active messages');
  assert.strictEqual(expiryIds.has('message-1'), false, 'Reaction helper should preserve active non-expired entries');

  const localReactionMap = new Map([
    ['message-1', { '👍': new Set(['a']) }],
    ['message-2', { '❤️': new Set(['b']) }],
  ]);
  const prunedLocalReactionMap = resolveChatPrunedLocalMessageReactions(
    localReactionMap,
    new Set(['message-1'])
  );
  assert.strictEqual(
    prunedLocalReactionMap.size,
    1,
    'Reaction helper should prune local reactions outside the visible id set'
  );
  assert.strictEqual(
    prunedLocalReactionMap.has('message-1'),
    true,
    'Reaction helper should preserve visible local reaction entries'
  );

  const unchangedReactionMap = resolveChatPrunedLocalMessageReactions(
    localReactionMap,
    new Set(['message-1', 'message-2'])
  );
  assert.strictEqual(
    unchangedReactionMap,
    localReactionMap,
    'Reaction helper should return original map when no local reaction entries are pruned'
  );

  logger.debug('✓ testChatReactionStateHelper passed');
})();

(function testChatMessageActionStateHelper() {
  const editableOwnMessage = {
    id: 'm1',
    sender: 'Teacher@School.com',
    text: 'Hello there',
    deleted: false,
  };

  const replyableIncomingMessage = {
    id: 'm2',
    sender: 'Parent@School.com',
    text: 'Thanks',
    deleted: false,
  };

  assert.strictEqual(
    resolveChatIsOwnMessageEmail(editableOwnMessage, 'teacher@school.com'),
    true,
    'Message-action helper should normalize sender and user emails for ownership checks'
  );

  assert.strictEqual(
    resolveChatCanEditMessage(editableOwnMessage, 'teacher@school.com'),
    true,
    'Message-action helper should allow editing a plain own text message'
  );

  assert.strictEqual(
    resolveChatCanEditMessage({ ...editableOwnMessage, attachments: [{}] }, 'teacher@school.com'),
    false,
    'Message-action helper should block editing attached messages'
  );

  assert.strictEqual(
    resolveChatCanDeleteMessage(editableOwnMessage, 'teacher@school.com'),
    true,
    'Message-action helper should allow deleting an own non-deleted message'
  );

  assert.strictEqual(
    resolveChatCanDeleteMessage({ ...editableOwnMessage, deleted: true }, 'teacher@school.com'),
    false,
    'Message-action helper should block deleting already deleted messages'
  );

  assert.strictEqual(
    resolveChatCanReplyMessage(replyableIncomingMessage),
    true,
    'Message-action helper should allow replying to visible messages with sender metadata'
  );

  assert.strictEqual(
    resolveChatCanReplyMessage({ ...replyableIncomingMessage, deleted: true }),
    false,
    'Message-action helper should block replies to deleted messages'
  );

  assert.deepStrictEqual(
    resolveChatFindLatestEditableOwnMessage(
      [
        { id: 'm0', sender: 'teacher@school.com', text: '', deleted: false },
        { id: 'm1', sender: 'teacher@school.com', text: 'First', deleted: false },
        { id: 'm2', sender: 'teacher@school.com', text: 'Second', deleted: true },
      ],
      'teacher@school.com'
    ),
    { id: 'm1', sender: 'teacher@school.com', text: 'First', deleted: false },
    'Message-action helper should return the latest editable own message from the end of the array'
  );

  assert.strictEqual(
    resolveChatFindLatestEditableOwnMessage([], 'teacher@school.com'),
    null,
    'Message-action helper should return null when there are no messages'
  );

  logger.debug('✓ testChatMessageActionStateHelper passed');
})();

(function testChatMessageRowMetaStateHelper() {
  assert.strictEqual(
    resolveChatMessageDateLabel('2026-04-24T10:00:00.000Z', new Date('2026-04-24T12:00:00.000Z').getTime()),
    'Today',
    'Message-row meta helper should label same-day timestamps as Today'
  );

  assert.strictEqual(
    resolveChatMessageDateLabel('2026-04-23T10:00:00.000Z', new Date('2026-04-24T12:00:00.000Z').getTime()),
    'Yesterday',
    'Message-row meta helper should label previous day timestamps as Yesterday'
  );

  const rowMeta = resolveChatMessageRowMetaState({
    displayedMessages: [
      { id: 'm1', timestamp: '2026-04-24T08:00:00.000Z' },
      { id: 'm2', timestamp: '2026-04-24T09:00:00.000Z' },
      { id: null, timestamp: '2026-04-24T09:30:00.000Z' },
      { id: 'm3', timestamp: '2026-04-23T09:00:00.000Z' },
    ],
    normalizeMessageId: (value) => (value == null ? '' : String(value)),
    sanitizeDateSeparatorLabel: (value) => String(value || '').trim() || 'Today',
    resolveDateSeparator: (currentTimestamp, previousTimestamp) => {
      if (!previousTimestamp) {
        return '';
      }
      const currentDay = String(currentTimestamp).slice(0, 10);
      const previousDay = String(previousTimestamp).slice(0, 10);
      return currentDay !== previousDay ? '  Yesterday  ' : '';
    },
    nowMs: new Date('2026-04-24T12:00:00.000Z').getTime(),
  });

  assert.strictEqual(
    rowMeta.dateLabelById.get('m1'),
    'Today',
    'Message-row meta helper should map date labels by normalized message id'
  );
  assert.strictEqual(
    rowMeta.dateLabelById.get('m3'),
    'Yesterday',
    'Message-row meta helper should derive historical date labels with provided nowMs'
  );
  assert.strictEqual(
    rowMeta.separatorLabelById.get('m3'),
    'Yesterday',
    'Message-row meta helper should sanitize and store non-empty separator labels'
  );
  assert.strictEqual(
    rowMeta.separatorLabelById.has('m2'),
    false,
    'Message-row meta helper should skip separator entries when resolver returns empty values'
  );

  logger.debug('✓ testChatMessageRowMetaStateHelper passed');
})();

(function testChatMessageIdentityStateHelper() {
  assert.strictEqual(
    resolveChatMessageDisplayKey({
      id: 'message-1',
      sender: 'Teacher@School.com',
      recipientId: 'parent@school.com',
      timestamp: '2026-04-25T10:00:00.000Z',
      text: 'hello',
    }),
    'id:message-1',
    'Message-identity helper should prioritize explicit message ids for display keys'
  );

  const fallbackKey = resolveChatMessageDisplayKey({
    sender: 'Teacher@School.com',
    recipientId: 'Parent@School.com',
    timestamp: {
      toDate: () => new Date('2026-04-25T10:00:00.000Z'),
    },
    text: 'Hello',
    attachments: [
      {
        url: 'https://cdn.test/a.png',
        fileName: 'a.png',
      },
    ],
    gif: {
      url: 'https://cdn.test/g.gif',
    },
    sticker: {
      url: 'https://cdn.test/s.webp',
    },
  });

  assert.strictEqual(
    fallbackKey,
    'fallback:teacher@school.com|parent@school.com|2026-04-25T10:00:00.000Z|Hello|https://cdn.test/a.png:a.png|https://cdn.test/g.gif|https://cdn.test/s.webp',
    'Message-identity helper should build deterministic fallback display keys when message ids are absent'
  );

  const renderSignature = resolveChatMessageRenderSignature({
    sender: 'Teacher@School.com',
    recipientId: 'Parent@School.com',
    timestamp: 1760000000000,
    text: 'Body',
    editCount: 2,
    editedAt: '2026-04-25T10:10:00.000Z',
    deleted: true,
    delivered: true,
    read: false,
    isSpecial: true,
    attachments: [
      {
        url: 'https://cdn.test/f.pdf',
        resolvedUrl: 'file:///tmp/f.pdf',
        fileName: 'f.pdf',
        fileType: 'application/pdf',
        fileSize: 123,
      },
    ],
  });

  assert.strictEqual(
    renderSignature,
    'teacher@school.com|parent@school.com|2025-10-09T08:53:20.000Z|Body|2|2026-04-25T10:10:00.000Z|1|1|0|1|||https://cdn.test/f.pdf:file:///tmp/f.pdf:f.pdf:application/pdf:123',
    'Message-identity helper should include attachment and status fields in render signature output'
  );

  logger.debug('✓ testChatMessageIdentityStateHelper passed');
})();

(function testChatMessageListItemStateHelper() {
  assert.strictEqual(
    resolveChatMessageListItemType({ sticker: { url: 'https://cdn.test/s.webp' } }),
    'sticker',
    'Message-list item helper should classify sticker rows'
  );
  assert.strictEqual(
    resolveChatMessageListItemType({ gif: { url: 'https://cdn.test/g.gif' } }),
    'gif',
    'Message-list item helper should classify gif rows'
  );
  assert.strictEqual(
    resolveChatMessageListItemType({ attachments: [{ url: 'https://cdn.test/f.pdf' }] }),
    'attachment',
    'Message-list item helper should classify attachment rows'
  );
  assert.strictEqual(
    resolveChatMessageListItemType({ isSpecial: true }),
    'special',
    'Message-list item helper should classify special rows'
  );
  assert.strictEqual(
    resolveChatMessageListItemType({ text: 'hello' }),
    'text',
    'Message-list item helper should classify default text rows'
  );

  assert.strictEqual(
    resolveChatMessageListItemKey({
      item: { id: 123 },
      index: 0,
      resolveDisplayKey: () => '',
    }),
    'id:123',
    'Message-list item helper should prefer explicit ids for row keys'
  );
  assert.strictEqual(
    resolveChatMessageListItemKey({
      item: { localId: 'tmp-1' },
      index: 1,
      resolveDisplayKey: () => '',
    }),
    'local:tmp-1',
    'Message-list item helper should fallback to local ids when server ids are missing'
  );
  assert.strictEqual(
    resolveChatMessageListItemKey({
      item: { timestamp: '2026-04-26T10:00:00.000Z' },
      index: 2,
      resolveDisplayKey: () => 'display-key',
    }),
    'display:display-key',
    'Message-list item helper should use display fallback keys before timestamp keys'
  );
  assert.strictEqual(
    resolveChatMessageListItemKey({
      item: null,
      index: 3,
      resolveDisplayKey: () => '',
    }),
    'ghost:3',
    'Message-list item helper should generate ghost keys for empty rows'
  );

  assert.strictEqual(
    resolveChatMessageLayoutSize('sticker'),
    188,
    'Message-list item helper should provide sticker layout size override'
  );
  assert.strictEqual(
    resolveChatMessageLayoutSize('gif'),
    280,
    'Message-list item helper should provide gif layout size override'
  );
  assert.strictEqual(
    resolveChatMessageLayoutSize('attachment'),
    220,
    'Message-list item helper should provide attachment layout size override'
  );
  assert.strictEqual(
    resolveChatMessageLayoutSize('text'),
    undefined,
    'Message-list item helper should not override layout size for default text rows'
  );

  logger.debug('✓ testChatMessageListItemStateHelper passed');
})();

(function testChatDisplayedMessagesStateHelper() {
  const sharedTimestamp = '2026-04-26T10:00:00.000Z';
  const previousMessageRef = {
    id: 'm-1',
    sender: 'teacher@school.com',
    recipientId: 'parent@school.com',
    timestamp: sharedTimestamp,
    text: 'Stable body',
  };

  const previousStableCache = new Map([
    [
      'id:m-1',
      {
        signature: resolveChatMessageRenderSignature(previousMessageRef),
        message: previousMessageRef,
      },
    ],
  ]);

  const nextMessageWithSameSignature = {
    id: 'm-1',
    sender: 'teacher@school.com',
    recipientId: 'parent@school.com',
    timestamp: sharedTimestamp,
    text: 'Stable body',
  };

  const firstDuplicate = {
    sender: 'teacher@school.com',
    recipientId: 'parent@school.com',
    timestamp: '2026-04-26T09:05:00.000Z',
    text: 'Dup fallback',
  };

  const repeatedDuplicate = {
    sender: 'teacher@school.com',
    recipientId: 'parent@school.com',
    timestamp: '2026-04-26T09:05:00.000Z',
    text: 'Dup fallback',
  };

  const resolved = resolveChatDisplayedMessagesState({
    messages: [
      firstDuplicate,
      repeatedDuplicate,
      nextMessageWithSameSignature,
    ],
    previousStableCache,
    previousDisplayedMessages: [previousMessageRef],
    resolveDisplayKey: resolveChatMessageDisplayKey,
    resolveRenderSignature: resolveChatMessageRenderSignature,
  });

  assert.strictEqual(
    resolved.displayedMessages.length,
    2,
    'Displayed-messages helper should collapse fallback-equivalent duplicate entries'
  );

  assert.strictEqual(
    resolved.displayedMessages[1],
    previousMessageRef,
    'Displayed-messages helper should reuse stable cached message references when render signature is unchanged'
  );

  assert.strictEqual(
    resolved.displayedMessages[0],
    firstDuplicate,
    'Displayed-messages helper should preserve the first encountered duplicate entry when signatures match'
  );

  const emptyResolved = resolveChatDisplayedMessagesState({
    messages: [],
    previousStableCache,
    previousDisplayedMessages: [previousMessageRef],
    resolveDisplayKey: resolveChatMessageDisplayKey,
    resolveRenderSignature: resolveChatMessageRenderSignature,
  });

  assert.deepStrictEqual(
    emptyResolved.displayedMessages,
    [],
    'Displayed-messages helper should return an empty list when no messages are available'
  );
  assert.strictEqual(
    emptyResolved.nextStableCache.size,
    0,
    'Displayed-messages helper should reset stable cache when the incoming message list is empty'
  );

  const displayedMessageIdSet = resolveChatDisplayedMessageIdSet(
    [{ id: 'm1' }, { id: 'm2' }, { id: '' }, { id: 'm1' }],
    (message) => String(message?.id || '')
  );
  assert.strictEqual(
    displayedMessageIdSet.size,
    2,
    'Displayed-message ID helper should dedupe ids into a set'
  );
  assert.strictEqual(displayedMessageIdSet.has('m1'), true, 'Displayed-message ID helper should include m1');
  assert.strictEqual(displayedMessageIdSet.has('m2'), true, 'Displayed-message ID helper should include m2');

  assert.strictEqual(
    shouldCompactChatMessagePositions(10, 8),
    false,
    'Displayed-messages compaction helper should skip compaction when drift is below threshold'
  );
  assert.strictEqual(
    shouldCompactChatMessagePositions(60, 10),
    true,
    'Displayed-messages compaction helper should compact when drift exceeds threshold'
  );
  assert.strictEqual(
    shouldCompactChatMessagePositions(0, 10),
    false,
    'Displayed-messages compaction helper should skip when no positions exist'
  );
  assert.strictEqual(
    shouldCompactChatMessagePositions(
      CHAT_MESSAGE_POSITION_COMPACTION_DRIFT_THRESHOLD + 11,
      10
    ),
    true,
    'Displayed-messages compaction helper should honor configured drift threshold'
  );

  const existingPositions = {
    m1: { y: 1, height: 40, date: 'Today' },
    m2: { y: 50, height: 44, date: 'Today' },
    m3: { y: 98, height: 52, date: 'Yesterday' },
  };
  const prunedPositions = resolveChatPrunedMessagePositions(existingPositions, new Set(['m1', 'm3']));
  assert.deepStrictEqual(
    prunedPositions,
    {
      m1: { y: 1, height: 40, date: 'Today' },
      m3: { y: 98, height: 52, date: 'Yesterday' },
    },
    'Displayed-messages prune helper should drop position entries outside valid ids'
  );

  const unchangedPositions = resolveChatPrunedMessagePositions(existingPositions, new Set(['m1', 'm2', 'm3']));
  assert.strictEqual(
    unchangedPositions,
    existingPositions,
    'Displayed-messages prune helper should return original reference when no entries are pruned'
  );

  logger.debug('✓ testChatDisplayedMessagesStateHelper passed');
})();

(function testChatListVirtualizationStateHelper() {
  const measuredEstimate = resolveChatEstimatedItemSize({
    displayedMessages: [
      { id: 'm1' },
      { id: 'm2' },
      { id: 'm3' },
      { id: 'm4' },
      { id: 'm5' },
      { id: 'm6' },
      { id: 'm7' },
      { id: 'm8' },
    ],
    messagePositionsById: {
      m1: { height: 130 },
      m2: { height: 120 },
      m3: { height: 125 },
      m4: { height: 135 },
      m5: { height: 140 },
      m6: { height: 110 },
      m7: { height: 128 },
      m8: { height: 132 },
    },
    normalizeMessageId: (value) => (value == null ? '' : String(value)),
  });

  assert.strictEqual(
    measuredEstimate,
    129,
    'List-virtualization helper should use sampled median height when enough measurements are available'
  );

  const heuristicEstimate = resolveChatEstimatedItemSize({
    displayedMessages: [
      { id: 'a', text: 'short' },
      { id: 'b', attachments: [{ url: 'https://cdn.test/a.pdf' }] },
      { id: 'c', sticker: { url: 'https://cdn.test/s.webp' } },
      { id: 'd', text: 'x'.repeat(60) },
    ],
    messagePositionsById: {},
    normalizeMessageId: (value) => (value == null ? '' : String(value)),
  });

  assert.strictEqual(
    heuristicEstimate,
    153,
    'List-virtualization helper should fallback to weighted heuristic when sampled heights are sparse'
  );

  assert.deepStrictEqual(
    resolveChatEstimatedListSize({
      screenHeight: 540.4,
      screenWidth: 320.2,
      fallbackHeight: 800,
      fallbackWidth: 400,
    }),
    {
      height: 600,
      width: 360,
    },
    'List-virtualization helper should enforce minimum list viewport dimensions'
  );

  assert.strictEqual(
    resolveChatListDrawDistance(700, true),
    1260,
    'List-virtualization helper should use larger web draw-distance multiplier'
  );
  assert.strictEqual(
    resolveChatListDrawDistance(700, false),
    900,
    'List-virtualization helper should enforce native draw-distance floor'
  );

  logger.debug('✓ testChatListVirtualizationStateHelper passed');
})();

(function testChatConversationSummaryMapStateHelper() {
  const existingSummary = {
    partnerEmail: 'parent@one.com',
    tenantId: 'tenant-a',
    unreadCount: 2,
    updatedAt: '2026-04-24T10:00:00.000Z',
    lastMessage: {
      messageId: 'm1',
      delivered: true,
      read: false,
      text: 'Hello',
    },
  };

  const prev = new Map([['parent@one.com', existingSummary]]);
  const unchangedResult = upsertChatConversationSummary(prev, {
    ...existingSummary,
  }, 'tenant-fallback');

  assert.strictEqual(
    unchangedResult,
    prev,
    'Summary-map helper should return previous map reference when incoming summary is unchanged'
  );

  const updatedResult = upsertChatConversationSummary(prev, {
    ...existingSummary,
    unreadCount: 3,
    lastMessage: {
      ...existingSummary.lastMessage,
      read: true,
    },
  }, 'tenant-fallback');

  assert.notStrictEqual(
    updatedResult,
    prev,
    'Summary-map helper should create a new map when summary fields change'
  );
  assert.deepStrictEqual(
    updatedResult.get('parent@one.com'),
    {
      partnerEmail: 'parent@one.com',
      tenantId: 'tenant-a',
      unreadCount: 3,
      updatedAt: '2026-04-24T10:00:00.000Z',
      lastMessage: {
        messageId: 'm1',
        delivered: true,
        read: true,
        text: 'Hello',
      },
    },
    'Summary-map helper should preserve existing tenant id while applying changed summary fields'
  );

  const insertedResult = upsertChatConversationSummary(new Map(), {
    partnerEmail: 'PARENT@TWO.COM',
    unreadCount: 1,
    updatedAt: '2026-04-24T11:00:00.000Z',
    lastMessage: {
      messageId: 'm2',
      text: 'New',
    },
  }, 'tenant-b');

  assert.deepStrictEqual(
    insertedResult.get('parent@two.com'),
    {
      partnerEmail: 'parent@two.com',
      tenantId: 'tenant-b',
      unreadCount: 1,
      updatedAt: '2026-04-24T11:00:00.000Z',
      lastMessage: {
        messageId: 'm2',
        text: 'New',
      },
    },
    'Summary-map helper should normalize partner email key and apply fallback tenant id for new entries'
  );

  logger.debug('✓ testChatConversationSummaryMapStateHelper passed');
})();

(function testChatRenderTraceMetricsHelper() {
  const traceState = createChatRenderTraceState(
    ' Parent@One.com ',
    'refresh',
    1200,
    {
      hydration: 3.9,
      downloads: 2.1,
      deviceType: ' web ',
      totalMemory: 1024.8,
    }
  );

  assert.deepStrictEqual(
    traceState,
    {
      startedAt: 1200,
      conversationId: 'Parent@One.com',
      reason: 'refresh',
      profile: {
        hydration: 3,
        downloads: 2,
        deviceType: 'web',
        totalMemory: 1024,
      },
    },
    'Render-trace helper should normalize state fields for deterministic metric shaping'
  );

  assert.deepStrictEqual(
    resolveChatRenderTraceStartPayload('   ', 'unknown', '7.8'),
    {
      conversationId: 'unknown',
      reason: 'initial',
      messageCount: 7,
    },
    'Render-trace start payload helper should normalize unknown conversation ids, reasons, and message counts'
  );

  assert.deepStrictEqual(
    resolveChatRenderTraceCompletePayload(traceState, 14.9, null, 1700),
    {
      conversationId: 'Parent@One.com',
      reason: 'refresh',
      durationMs: 500,
      messageCount: 14,
      hydrationConcurrency: 3,
      downloadConcurrency: 2,
      deviceType: 'web',
      totalMemoryBytes: 1024,
    },
    'Render-trace complete payload helper should compute elapsed duration and project normalized profile values'
  );

  const fallbackProfileState = createChatRenderTraceState('thread-1', 'initial', 2400, null);
  assert.deepStrictEqual(
    resolveChatRenderTraceCompletePayload(
      fallbackProfileState,
      -2,
      {
        hydration: -1,
        downloads: 4.7,
        deviceType: ' ',
        totalMemory: 4096.3,
      },
      2300
    ),
    {
      conversationId: 'thread-1',
      reason: 'initial',
      durationMs: 0,
      messageCount: 0,
      hydrationConcurrency: null,
      downloadConcurrency: 4,
      deviceType: null,
      totalMemoryBytes: 4096,
    },
    'Render-trace complete payload helper should clamp negative duration/message counts and apply fallback profile normalization'
  );

  logger.debug('✓ testChatRenderTraceMetricsHelper passed');
})();

(function testChatConversationSearchContextStoreHelper() {
  const now = 1_700_000_000_000;

  const normalized = normalizePersistedConversationSearchContextStore(
    {
      'tenant-1::chat-a': {
        visible: true,
        query: '  fee   reminder  ',
        scope: 'attachment',
        updatedAt: now - 1_000,
      },
      'tenant-1::chat-old': {
        visible: true,
        query: 'legacy',
        scope: 'text',
        updatedAt: now - 1_000_000,
      },
      'tenant-1::chat-default': {
        visible: false,
        query: '   ',
        scope: 'all',
        updatedAt: now - 500,
      },
      'tenant-1::chat-bad': {
        visible: true,
        query: 'abc',
        scope: 'unknown',
        updatedAt: 'bad',
      },
    },
    now,
    {
      maxAgeMs: 60_000,
      maxEntries: 4,
      maxQueryLength: 40,
    }
  );

  assert.deepStrictEqual(
    normalized,
    {
      'tenant-1::chat-a': {
        visible: true,
        query: 'fee reminder',
        scope: 'attachment',
        updatedAt: now - 1_000,
      },
    },
    'Conversation-search context store normalization should trim query, drop stale/default entries, and reject invalid timestamps'
  );

  const readHit = readPersistedConversationSearchContext(
    {
      'tenant-1::chat-a': {
        visible: true,
        query: 'fee reminder',
        scope: 'attachment',
        updatedAt: now - 1_000,
      },
    },
    'tenant-1::chat-a',
    now,
    {
      maxAgeMs: 60_000,
      maxEntries: 4,
      maxQueryLength: 40,
    }
  );

  assert.deepStrictEqual(
    readHit,
    {
      visible: true,
      query: 'fee reminder',
      scope: 'attachment',
    },
    'Conversation-search context store read helper should return normalized snapshot for valid keys'
  );

  const readMiss = readPersistedConversationSearchContext(
    {
      'tenant-1::chat-a': {
        visible: true,
        query: 'fee reminder',
        scope: 'attachment',
        updatedAt: now - 1_000,
      },
    },
    'tenant-1::missing',
    now,
    {
      maxAgeMs: 60_000,
      maxEntries: 4,
      maxQueryLength: 40,
    }
  );

  assert.strictEqual(
    readMiss,
    null,
    'Conversation-search context store read helper should return null for missing keys'
  );

  const upsertedStore = upsertPersistedConversationSearchContext(
    {
      'tenant-1::chat-a': {
        visible: true,
        query: 'fee reminder',
        scope: 'attachment',
        updatedAt: now - 2_000,
      },
    },
    'tenant-1::chat-b',
    {
      visible: false,
      query: '  invoice_april.pdf  ',
      scope: 'all',
    },
    now,
    {
      maxAgeMs: 60_000,
      maxEntries: 1,
      maxQueryLength: 12,
    }
  );

  assert.deepStrictEqual(
    upsertedStore,
    {
      'tenant-1::chat-b': {
        visible: false,
        query: 'invoice_apri',
        scope: 'all',
        updatedAt: now,
      },
    },
    'Conversation-search context store upsert helper should normalize, truncate query, and prune to maxEntries by recency'
  );

  const removedDefaultStore = upsertPersistedConversationSearchContext(
    {
      'tenant-1::chat-a': {
        visible: true,
        query: 'fee reminder',
        scope: 'attachment',
        updatedAt: now - 1_000,
      },
    },
    'tenant-1::chat-a',
    {
      visible: false,
      query: '',
      scope: 'all',
    },
    now,
    {
      maxAgeMs: 60_000,
      maxEntries: 4,
      maxQueryLength: 40,
    }
  );

  assert.deepStrictEqual(
    removedDefaultStore,
    {},
    'Conversation-search context store upsert helper should delete entries reset to default snapshot state'
  );

  logger.debug('✓ testChatConversationSearchContextStoreHelper passed');
})();

(function testChatMessageInfoHelper() {
  const ownMessageLines = resolveChatMessageInfoLines({
    isOwnMessage: true,
    senderEmail: 'teacher@school.com',
    recipientEmail: 'parent@one.com',
    recipientName: 'Parent One',
    sentAt: '2026-04-16T10:00:00.000Z',
    delivered: true,
    deliveredAt: '2026-04-16T10:00:10.000Z',
    read: true,
    readAt: '2026-04-16T10:00:20.000Z',
    editedAt: '2026-04-16T10:01:00.000Z',
    deleted: false,
    formatTimestamp: (value) => `fmt:${value}`,
  });

  assert.deepStrictEqual(
    ownMessageLines,
    [
      'Sender: You',
      'Sent: fmt:2026-04-16T10:00:00.000Z',
      'Delivered: Delivered to Parent One at fmt:2026-04-16T10:00:10.000Z',
      'Read: Read by Parent One at fmt:2026-04-16T10:00:20.000Z',
      'Status: Active',
      'Edited: fmt:2026-04-16T10:01:00.000Z',
    ],
    'Message info helper should prefer explicit timestamps and include edited line when available'
  );

  const incomingLines = resolveChatMessageInfoLines({
    isOwnMessage: false,
    senderEmail: ' Parent@One.com ',
    senderName: '',
    sentAt: null,
    delivered: false,
    read: false,
    deleted: true,
  });

  assert.deepStrictEqual(
    incomingLines,
    [
      'Sender: parent@one.com',
      'Sent: Unknown',
      'Delivered: Not delivered',
      'Read: Not read',
      'Status: Deleted',
    ],
    'Message info helper should fall back to normalized sender email and status labels'
  );

  const multiRecipientRows = resolveChatMessageInfoRows({
    isOwnMessage: true,
    senderEmail: 'teacher@school.com',
    recipientStatusDetails: [
      {
        recipientName: 'Parent One',
        delivered: true,
        deliveredAt: '2026-04-16T10:00:10.000Z',
        read: true,
        readAt: '2026-04-16T10:00:20.000Z',
      },
      {
        recipientEmail: ' ParentTwo@One.com ',
        delivered: true,
        deliveredAt: '2026-04-16T10:00:30.000Z',
        read: false,
      },
      {
        recipientName: 'Parent Three',
        delivered: false,
        read: false,
      },
    ],
    sentAt: '2026-04-16T10:00:00.000Z',
    deleted: false,
    formatTimestamp: (value) => `fmt:${value}`,
  });

  assert.deepStrictEqual(
    multiRecipientRows,
    [
      { label: 'Sender', value: 'You' },
      { label: 'Sent', value: 'fmt:2026-04-16T10:00:00.000Z' },
      {
        label: 'Delivered',
        value:
          '2/3 delivered\nParent One: Delivered at fmt:2026-04-16T10:00:10.000Z\nparenttwo@one.com: Delivered at fmt:2026-04-16T10:00:30.000Z\nParent Three: Not delivered',
      },
      {
        label: 'Read',
        value:
          '1/3 read\nParent One: Read at fmt:2026-04-16T10:00:20.000Z\nparenttwo@one.com: Not read\nParent Three: Not read',
      },
      { label: 'Status', value: 'Active' },
    ],
    'Message info rows helper should provide scalable per-recipient delivery/read summaries for future multi-recipient threads'
  );

  const multiRecipientClipboardText = formatChatMessageInfoRowsForClipboard(multiRecipientRows);
  assert.strictEqual(
    multiRecipientClipboardText,
    [
      'Sender: You',
      'Sent: fmt:2026-04-16T10:00:00.000Z',
      'Delivered: 2/3 delivered',
      '  - Parent One: Delivered at fmt:2026-04-16T10:00:10.000Z',
      '  - parenttwo@one.com: Delivered at fmt:2026-04-16T10:00:30.000Z',
      '  - Parent Three: Not delivered',
      'Read: 1/3 read',
      '  - Parent One: Read at fmt:2026-04-16T10:00:20.000Z',
      '  - parenttwo@one.com: Not read',
      '  - Parent Three: Not read',
      'Status: Active',
    ].join('\n'),
    'Message info clipboard formatter should indent multiline recipient details for readable copy output'
  );

  const clipboardEdgeCaseText = formatChatMessageInfoRowsForClipboard([
    {
      label: ' Delivered ',
      value: ' 2/2 delivered\nParent One: Delivered\n Parent Two: Delivered ',
    },
    {
      label: 'Status',
      value: ' Active ',
    },
    {
      label: '   ',
      value: '   ',
    },
  ]);

  assert.strictEqual(
    clipboardEdgeCaseText,
    [
      'Delivered: 2/2 delivered',
      '  - Parent One: Delivered',
      '  - Parent Two: Delivered',
      'Status: Active',
      'Detail:',
    ].join('\n'),
    'Message info clipboard formatter should normalize labels and preserve empty rows as explicit placeholders'
  );

  assert.strictEqual(
    resolveChatMessageInfoShortcutAction({ key: 'Escape' }),
    'close',
    'Message info shortcut helper should always resolve Escape to close'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackSourceLabel('__all__'),
    'All',
    'Message info copy-feedback source helper should resolve __all__ to All'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackSourceLabel('Delivered:2'),
    'Row',
    'Message info copy-feedback source helper should resolve regular row keys to Row'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackSourceLabel(''),
    '',
    'Message info copy-feedback source helper should return empty label when no copied row key exists'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackLabel('__all__', ''),
    'Copied all message details',
    'Message info copy-feedback label helper should return all-details copy text for __all__ row key'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackLabel('Delivered:2', 'Delivered'),
    'Copied Delivered details',
    'Message info copy-feedback label helper should include copied row label when available'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackLabel('Delivered:2', ''),
    'Copied row details',
    'Message info copy-feedback label helper should fall back to generic row copy text without row labels'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackLabel('Delivered:2', 'Delivered details'),
    'Copied Delivered details',
    'Message info copy-feedback label helper should avoid duplicating details suffix in row labels'
  );

  assert.strictEqual(
    resolveChatMessageInfoNormalizedRowKey('  Delivered :  2  '),
    'Delivered:2',
    'Message info normalized row-key helper should trim and normalize delimiter spacing'
  );

  assert.strictEqual(
    resolveChatMessageInfoNormalizedRowKey(' : : '),
    '',
    'Message info normalized row-key helper should return empty string for malformed empty-segment row keys'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyRowLabel('Delivered:2', ' Delivered '),
    'Delivered',
    'Message info copy-row label helper should prefer explicit row labels when provided'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyRowLabel('  Delivered : 2 ', ''),
    'Delivered',
    'Message info copy-row label helper should use normalized row-key prefix fallback for malformed row-key spacing'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyRowLabel('Delivered:2', ''),
    'Delivered',
    'Message info copy-row label helper should fall back to row-key prefix when row label is missing'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyRowLabel('   ', ''),
    'Row',
    'Message info copy-row label helper should fall back to Row when both label and row key are unavailable'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopiedRowKeyAfterReset('Delivered:2', 'Delivered:2'),
    null,
    'Message info copied-row key reset helper should clear copied row key when reset target still matches'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopiedRowKeyAfterReset('Read:3', 'Delivered:2'),
    'Read:3',
    'Message info copied-row key reset helper should preserve newer copied row keys when reset target differs'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopiedRowKeyAfterReset(' Delivered : 2 ', 'Delivered:2'),
    null,
    'Message info copied-row key reset helper should compare normalized row keys for reset matching'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopiedRowLabelAfterReset('Delivered', 'Delivered'),
    '',
    'Message info copied-row label reset helper should clear copied row label when reset target still matches'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopiedRowLabelAfterReset('Read', ''),
    'Read',
    'Message info copied-row label reset helper should preserve labels when no target label is supplied'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopySuccessSelection('all'),
    {
      copiedRowKey: '__all__',
      copiedRowLabel: '',
    },
    'Message info copy-success selection helper should return all-details copied state values'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopySuccessSelection('row', ' Delivered : 2 ', ' Delivered '),
    {
      copiedRowKey: 'Delivered:2',
      copiedRowLabel: 'Delivered',
    },
    'Message info copy-success selection helper should normalize row keys and prefer explicit row labels'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopySuccessSelection('row', ' : : ', ''),
    {
      copiedRowKey: '__row__',
      copiedRowLabel: 'Row',
    },
    'Message info copy-success selection helper should provide fallback row key/label values for malformed row input'
  );

  const copiedRowSuccessPlan = resolveChatMessageInfoCopySuccessPlan(
    'row',
    ' Delivered : 2 ',
    ' Delivered '
  );
  assert.deepStrictEqual(
    copiedRowSuccessPlan.selection,
    {
      copiedRowKey: 'Delivered:2',
      copiedRowLabel: 'Delivered',
    },
    'Message info copy-success plan helper should expose normalized copied-state selection for row success paths'
  );
  assert.strictEqual(
    copiedRowSuccessPlan.resetPayload.nextRowKey('Delivered:2'),
    null,
    'Message info copy-success plan helper should include reset payload that clears matching row keys'
  );
  assert.strictEqual(
    copiedRowSuccessPlan.resetPayload.nextRowLabel('Delivered'),
    '',
    'Message info copy-success plan helper should include reset payload that clears matching row labels'
  );

  const copiedAllSuccessPlan = resolveChatMessageInfoCopySuccessPlan('all');
  assert.deepStrictEqual(
    copiedAllSuccessPlan.selection,
    {
      copiedRowKey: '__all__',
      copiedRowLabel: '',
    },
    'Message info copy-success plan helper should expose all-details selection for all-copy success paths'
  );
  assert.strictEqual(
    copiedAllSuccessPlan.resetPayload.nextRowKey('__all__'),
    null,
    'Message info copy-success plan helper should include all-details reset payload key clearing behavior'
  );

  const copyMetricRollupState = createChatMessageInfoCopyMetricRollupState();
  assert.deepStrictEqual(
    copyMetricRollupState,
    {
      totalEvents: 0,
      rowSuccess: 0,
      rowError: 0,
      allSuccess: 0,
      allError: 0,
      lastMetricAt: 0,
    },
    'Message info copy metric rollup helper should expose zeroed initial state'
  );

  const copyMetricFirstPayload = recordChatMessageInfoCopyMetricRollup(
    copyMetricRollupState,
    'row',
    'success',
    1000
  );
  assert.deepStrictEqual(
    copyMetricFirstPayload,
    {
      totalEvents: 1,
      rowSuccess: 1,
      rowError: 0,
      allSuccess: 0,
      allError: 0,
      source: 'row',
      outcome: 'success',
      sourceSuccess: 1,
      sourceError: 0,
    },
    'Message info copy metric rollup helper should emit on first event with source-specific rollup counts'
  );

  assert.strictEqual(
    copyMetricRollupState.lastMetricAt,
    1000,
    'Message info copy metric rollup helper should store emitted timestamp on cadence emission'
  );

  assert.strictEqual(
    recordChatMessageInfoCopyMetricRollup(copyMetricRollupState, 'all', 'error', 1500),
    null,
    'Message info copy metric rollup helper should suppress early non-cadence events'
  );

  for (let index = 0; index < 5; index += 1) {
    recordChatMessageInfoCopyMetricRollup(copyMetricRollupState, 'row', 'success', 1600 + index);
  }

  assert.deepStrictEqual(
    recordChatMessageInfoCopyMetricRollup(copyMetricRollupState, 'all', 'success', 1700),
    {
      totalEvents: 8,
      rowSuccess: 6,
      rowError: 0,
      allSuccess: 1,
      allError: 1,
      source: 'all',
      outcome: 'success',
      sourceSuccess: 1,
      sourceError: 1,
    },
    'Message info copy metric rollup helper should emit on every eighth event and include all-source counts'
  );

  const copyMetricTimeWindowState = createChatMessageInfoCopyMetricRollupState();
  recordChatMessageInfoCopyMetricRollup(copyMetricTimeWindowState, 'row', 'success', 500);
  assert.strictEqual(
    recordChatMessageInfoCopyMetricRollup(copyMetricTimeWindowState, 'row', 'error', 45000),
    null,
    'Message info copy metric rollup helper should not emit before time-window threshold when cadence does not match'
  );

  assert.deepStrictEqual(
    recordChatMessageInfoCopyMetricRollup(copyMetricTimeWindowState, 'row', 'error', 60550),
    {
      totalEvents: 3,
      rowSuccess: 1,
      rowError: 2,
      allSuccess: 0,
      allError: 0,
      source: 'row',
      outcome: 'error',
      sourceSuccess: 1,
      sourceError: 2,
    },
    'Message info copy metric rollup helper should emit after interval threshold even when cadence conditions are unmet'
  );

  const copiedRowResetPayload = resolveChatMessageInfoCopiedResetPayload('Delivered:2', 'Delivered');
  assert.strictEqual(
    copiedRowResetPayload.nextRowKey('Delivered:2'),
    null,
    'Message info copied-reset payload should expose key updater that clears matching row keys'
  );
  assert.strictEqual(
    copiedRowResetPayload.nextRowLabel('Delivered'),
    '',
    'Message info copied-reset payload should expose label updater that clears matching row labels'
  );

  const copiedNormalizedTargetPayload = resolveChatMessageInfoCopiedResetPayload(' Delivered : 2 ', 'Delivered');
  assert.strictEqual(
    copiedNormalizedTargetPayload.nextRowKey('Delivered:2'),
    null,
    'Message info copied-reset payload should normalize malformed target row keys before reset matching'
  );

  const copiedAllResetPayload = resolveChatMessageInfoCopiedResetPayload('__all__', '');
  assert.strictEqual(
    copiedAllResetPayload.nextRowKey('__all__'),
    null,
    'Message info copied-reset payload should expose key updater for all-details reset targets'
  );
  assert.strictEqual(
    copiedAllResetPayload.nextRowLabel('Read'),
    'Read',
    'Message info copied-reset payload should preserve labels when all-details reset target has no label'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyFeedbackSourcePalette('All', false),
    {
      borderColor: 'rgba(5, 150, 105, 0.34)',
      backgroundColor: 'rgba(16, 185, 129, 0.12)',
      textColor: '#047857',
    },
    'Message info source palette helper should provide light-mode all-source colors'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyFeedbackSourcePalette('Row', true),
    {
      borderColor: 'rgba(96, 165, 250, 0.56)',
      backgroundColor: 'rgba(59, 130, 246, 0.24)',
      textColor: '#93c5fd',
    },
    'Message info source palette helper should provide dark-mode row-source colors'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackSourceBadgeText('All'),
    'Source: All',
    'Message info source badge helper should format visible source badge text'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackSourceAccessibilityLabel('All'),
    'Copy source all message details',
    'Message info source accessibility helper should describe all-details copy source'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackSourceAccessibilityLabel('Row'),
    'Copy source single message detail row',
    'Message info source accessibility helper should describe row-level copy source'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackAccessibilityLabel(
      'Copied Delivered details',
      'Row'
    ),
    'Copied Delivered details. Copy source single message detail row.',
    'Message info copy-feedback accessibility helper should combine feedback and source context'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyFeedbackAccessibilityLabel(
      'Copied all message details',
      ''
    ),
    'Copied all message details',
    'Message info copy-feedback accessibility helper should return feedback text when source context is unavailable'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastPayload('success', 'all'),
    {
      title: 'Copied',
      detail: 'All message details copied',
    },
    'Message info copy-toast helper should provide all-details success payload'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastPayload('success', 'row', 'Delivered'),
    {
      title: 'Copied',
      detail: 'Delivered details copied',
    },
    'Message info copy-toast helper should append details suffix for row success payloads'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastPayload('success', 'row', 'Delivered details'),
    {
      title: 'Copied',
      detail: 'Delivered details copied',
    },
    'Message info copy-toast helper should avoid duplicate details suffix in row success payloads'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastPayload('error', 'row'),
    {
      title: 'Copy failed',
      detail: 'Unable to copy message details.',
    },
    'Message info copy-toast helper should provide row error payload'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastPayload('error', 'all'),
    {
      title: 'Copy failed',
      detail: 'Unable to copy all message details.',
    },
    'Message info copy-toast helper should provide all-details error payload'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyToastCooldownMs('success'),
    850,
    'Message info copy-toast cooldown helper should return success cooldown in milliseconds'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyToastCooldownMs('error'),
    1200,
    'Message info copy-toast cooldown helper should return error cooldown in milliseconds'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastCooldownState(1500, 1000, 'success'),
    {
      cooldownMs: 850,
      elapsedMs: 500,
      remainingMs: 350,
      shouldSuppress: true,
    },
    'Message info copy-toast cooldown-state helper should report suppression and remaining window for active cooldowns'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastCooldownState(2500, 1000, 'error'),
    {
      cooldownMs: 1200,
      elapsedMs: 1500,
      remainingMs: 0,
      shouldSuppress: false,
    },
    'Message info copy-toast cooldown-state helper should report no suppression once cooldown has elapsed'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastCooldownState(300, 0, 'success'),
    {
      cooldownMs: 850,
      elapsedMs: 300,
      remainingMs: 0,
      shouldSuppress: false,
    },
    'Message info copy-toast cooldown-state helper should not suppress first-time events without prior toast timestamps'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastSuppressionPlan(
      {
        cooldownMs: 850,
        elapsedMs: 500,
        remainingMs: 430,
        shouldSuppress: true,
      },
      2,
      true
    ),
    {
      shouldSuppress: true,
      nextSuppressedCount: 3,
      noticeText: 'Toast cooldown active (0.4s). 3 toasts suppressed.',
      noticeClearDelayMs: 550,
    },
    'Message info copy-toast suppression-plan helper should increment suppressed count and return web notice metadata while cooldown is active'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastSuppressionPlan(
      {
        cooldownMs: 1200,
        elapsedMs: 100,
        remainingMs: 1100,
        shouldSuppress: true,
      },
      5,
      false
    ),
    {
      shouldSuppress: true,
      nextSuppressedCount: 0,
      noticeText: '',
      noticeClearDelayMs: 0,
    },
    'Message info copy-toast suppression-plan helper should suppress non-web events without notice metadata'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoCopyToastSuppressionPlan(
      {
        cooldownMs: 850,
        elapsedMs: 900,
        remainingMs: 0,
        shouldSuppress: false,
      },
      7,
      true
    ),
    {
      shouldSuppress: false,
      nextSuppressedCount: 0,
      noticeText: '',
      noticeClearDelayMs: 0,
    },
    'Message info copy-toast suppression-plan helper should reset suppressed counters when cooldown is no longer active'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyToastNoticeClearDelayMs(430),
    550,
    'Message info copy-toast notice-clear helper should include post-cooldown buffer time'
  );

  assert.strictEqual(
    resolveChatMessageInfoCopyToastNoticeClearDelayMs(-5),
    120,
    'Message info copy-toast notice-clear helper should clamp negative cooldown windows'
  );

  assert.strictEqual(
    resolveChatMessageInfoToastCooldownNotice(430, 2),
    'Toast cooldown active (0.4s). 2 toasts suppressed.',
    'Message info cooldown helper should provide deterministic short cooldown notice copy'
  );

  assert.strictEqual(
    resolveChatMessageInfoToastCooldownNotice(-10, 1.9),
    'Toast cooldown active (0.1s). 1 toast suppressed.',
    'Message info cooldown helper should clamp invalid values for user-facing notice copy'
  );

  assert.strictEqual(
    resolveChatMessageInfoToastCooldownAccessibilityLabel('Toast cooldown active (0.4s). 2 toasts suppressed.'),
    'Copy feedback notice. Toast cooldown active (0.4s). 2 toasts suppressed.',
    'Message info cooldown accessibility helper should prepend context for screen-reader announcement clarity'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoRowBadge('Delivered', '2/3 delivered\nParent One: Delivered'),
    {
      text: '2/3',
      tone: 'warning',
    },
    'Message info row-badge helper should derive delivery ratio badge with warning tone when delivery is partial'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoRowBadge('Read', 'Read by Parent One at fmt:2026-04-16T10:00:20.000Z'),
    {
      text: 'Read',
      tone: 'success',
    },
    'Message info row-badge helper should map read labels to success badge tone'
  );

  assert.strictEqual(
    resolveChatMessageInfoRowBadge('Status', 'Active'),
    null,
    'Message info row-badge helper should return null for unsupported labels'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoRowValueParts('2/3 delivered\nParent One: Delivered\nParent Two: Not delivered'),
    {
      summary: '2/3 delivered',
      details: ['Parent One: Delivered', 'Parent Two: Not delivered'],
    },
    'Message info row-value parts helper should split multiline values into summary and details'
  );

  assert.deepStrictEqual(
    resolveChatMessageInfoRowValueParts('Read by Parent One'),
    {
      summary: 'Read by Parent One',
      details: [],
    },
    'Message info row-value parts helper should preserve single-line values as summary-only'
  );

  assert.strictEqual(
    resolveChatMessageInfoShortcutAction({
      key: 'c',
      code: 'KeyC',
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      isTargetEditable: false,
    }),
    'copy-all',
    'Message info shortcut helper should map Alt+Shift+C to copy-all'
  );

  assert.strictEqual(
    resolveChatMessageInfoShortcutAction({
      key: 'D',
      code: 'KeyD',
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      hasExpandableRows: true,
      isTargetEditable: false,
    }),
    'toggle-all-details',
    'Message info shortcut helper should map Alt+Shift+D to bulk toggle when expandable rows exist'
  );

  assert.strictEqual(
    resolveChatMessageInfoShortcutAction({
      key: 'd',
      code: 'KeyD',
      altKey: true,
      shiftKey: true,
      hasExpandableRows: false,
    }),
    null,
    'Message info shortcut helper should ignore Alt+Shift+D when no expandable rows exist'
  );

  assert.strictEqual(
    resolveChatMessageInfoShortcutAction({
      key: 'c',
      code: 'KeyC',
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      metaKey: false,
      isTargetEditable: false,
    }),
    null,
    'Message info shortcut helper should reject modified variants that include Ctrl/Cmd'
  );

  assert.strictEqual(
    resolveChatMessageInfoShortcutAction({
      key: 'c',
      code: 'KeyC',
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      isTargetEditable: true,
    }),
    null,
    'Message info shortcut helper should avoid triggering while typing into editable targets'
  );

  logger.debug('✓ testChatMessageInfoHelper passed');
})();

(function testTimeoutRefHelper() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timeoutCalls = [];
  const clearCalls = [];
  let nextId = 1;

  global.setTimeout = (callback, delay) => {
    const id = { __id: nextId++ };
    timeoutCalls.push({ id, callback, delay });
    return id;
  };
  global.clearTimeout = (id) => {
    clearCalls.push(id);
  };

  try {
    const timeoutRef = { current: null };

    clearTimeoutRef(timeoutRef);
    assert.strictEqual(
      clearCalls.length,
      0,
      'Timeout-ref helper should not clear when no timer is active'
    );

    const existingTimer = { __id: 'existing' };
    timeoutRef.current = existingTimer;
    clearTimeoutRef(timeoutRef);
    assert.strictEqual(
      clearCalls.length,
      1,
      'Timeout-ref helper should clear active timers'
    );
    assert.strictEqual(
      clearCalls[0],
      existingTimer,
      'Timeout-ref helper should clear the same timer currently tracked in the ref'
    );
    assert.strictEqual(
      timeoutRef.current,
      null,
      'Timeout-ref helper should null the timer ref after clearing'
    );

    let callbackCount = 0;
    scheduleTimeoutRef(timeoutRef, () => {
      callbackCount += 1;
    }, 12.9);

    assert.strictEqual(
      timeoutCalls.length,
      1,
      'Timeout-ref helper should schedule timers when requested'
    );
    assert.strictEqual(
      timeoutCalls[0].delay,
      12,
      'Timeout-ref helper should normalize fractional delay values to integer milliseconds'
    );
    assert.strictEqual(
      timeoutRef.current,
      timeoutCalls[0].id,
      'Timeout-ref helper should store scheduled timer id in the ref'
    );

    timeoutCalls[0].callback();
    assert.strictEqual(
      callbackCount,
      1,
      'Timeout-ref helper should invoke scheduled callbacks'
    );
    assert.strictEqual(
      timeoutRef.current,
      null,
      'Timeout-ref helper should clear the ref before executing scheduled callbacks'
    );

    const priorTimer = { __id: 'prior' };
    timeoutRef.current = priorTimer;
    scheduleTimeoutRef(timeoutRef, () => {}, -8);
    assert.strictEqual(
      clearCalls.length,
      2,
      'Timeout-ref helper should clear previous timer refs before scheduling replacements'
    );
    assert.strictEqual(
      clearCalls[1],
      priorTimer,
      'Timeout-ref helper should clear the prior timer when replacing scheduled work'
    );
    assert.strictEqual(
      timeoutCalls[1].delay,
      0,
      'Timeout-ref helper should clamp negative delay values to zero'
    );

    scheduleTimeoutRef(timeoutRef, () => {}, Number.NaN);
    assert.strictEqual(
      timeoutCalls[2].delay,
      0,
      'Timeout-ref helper should clamp invalid delay values to zero'
    );
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

  logger.debug('✓ testTimeoutRefHelper passed');
})();

(function testChatRealtimeReplyPayloadNormalization() {
  const normalized = normalizeChatRealtimeReplyPayload({
    messageId: '  msg-123  ',
    sender: ' Teacher@School.com ',
    senderName: '  Teacher Name  ',
    text: '  hello   there  ',
    hasAttachments: false,
    attachmentCount: '2',
    hasSticker: true,
    hasGif: false,
  });

  assert.deepStrictEqual(
    normalized,
    {
      messageId: 'msg-123',
      sender: 'teacher@school.com',
      senderName: 'Teacher Name',
      text: 'hello there',
      hasAttachments: true,
      attachmentCount: 2,
      hasSticker: true,
    },
    'Chat realtime reply normalization should trim and sanitize reply payload fields'
  );

  assert.strictEqual(
    normalizeChatRealtimeReplyPayload({ messageId: '', sender: 'teacher@school.com' }),
    undefined,
    'Chat realtime reply normalization should reject blank message ids'
  );

  assert.strictEqual(
    normalizeChatRealtimeReplyPayload({ messageId: 'msg-1', sender: '   ' }),
    undefined,
    'Chat realtime reply normalization should reject blank sender emails'
  );

  logger.debug('✓ testChatRealtimeReplyPayloadNormalization passed');
})();

(function testChatRealtimeMessageSignatureDeterminism() {
  const baseMessage = {
    id: 'm1',
    sender: 'teacher@school.com',
    timestamp: '2026-04-16T10:00:00.000Z',
    conversationKey: 'a__b',
    text: 'Hello',
  };

  const orderedPayload = {
    ...baseMessage,
    attachments: [
      {
        url: 'https://cdn.example.com/file.pdf',
        fileName: 'file.pdf',
        fileType: 'application/pdf',
      },
    ],
    replyTo: {
      messageId: 'm0',
      sender: 'parent@school.com',
      hasAttachments: true,
      attachmentCount: 1,
    },
    sticker: {
      url: 'https://cdn.example.com/sticker.webp',
      name: 'Wave',
      pack: 'hello',
    },
  };

  const reorderedPayload = {
    ...baseMessage,
    attachments: [
      {
        fileType: 'application/pdf',
        fileName: 'file.pdf',
        url: 'https://cdn.example.com/file.pdf',
      },
    ],
    replyTo: {
      attachmentCount: 1,
      hasAttachments: true,
      sender: 'parent@school.com',
      messageId: 'm0',
    },
    sticker: {
      pack: 'hello',
      name: 'Wave',
      url: 'https://cdn.example.com/sticker.webp',
    },
  };

  const orderedSignature = buildChatRealtimeMessageContentSignature(orderedPayload);
  const reorderedSignature = buildChatRealtimeMessageContentSignature(reorderedPayload);

  assert.strictEqual(
    orderedSignature,
    reorderedSignature,
    'Chat realtime message signature should be deterministic even when object key order differs'
  );

  const changedPayload = {
    ...reorderedPayload,
    replyTo: {
      ...reorderedPayload.replyTo,
      text: 'updated preview',
    },
  };

  assert.notStrictEqual(
    reorderedSignature,
    buildChatRealtimeMessageContentSignature(changedPayload),
    'Chat realtime message signature should change when reply content changes'
  );

  logger.debug('✓ testChatRealtimeMessageSignatureDeterminism passed');
})();

(function testChatReplyJumpUiInteractionFlow() {
  const targetMessageId = normalizeReplyJumpTargetMessageId(' msg-42 ');
  assert.strictEqual(
    targetMessageId,
    'msg-42',
    'Reply jump UI helper should normalize quoted target ids before applying highlight'
  );

  const jumpSuccessState = resolveReplyJumpStateForJumpSuccess();
  assert.deepStrictEqual(
    jumpSuccessState,
    {
      showScrollToBottom: true,
      showReplyJumpToLatest: true,
    },
    'Quote tap + successful jump should show the Latest return affordance and FAB'
  );

  const highlightAfterTimeout = resolveReplyJumpHighlightAfterTimeout('msg-42', ' msg-42 ');
  assert.strictEqual(
    highlightAfterTimeout,
    null,
    'Highlight timeout should clear the active jump target highlight'
  );

  const latestReturnState = resolveReplyJumpStateForLatestReturn();
  assert.deepStrictEqual(
    latestReturnState,
    {
      showScrollToBottom: false,
      showReplyJumpToLatest: false,
    },
    'Pressing Latest return should hide reply-jump mode and close the FAB'
  );

  const nearBottomState = resolveReplyJumpStateForNearBottom();
  assert.deepStrictEqual(
    nearBottomState,
    {
      showScrollToBottom: false,
      showReplyJumpToLatest: false,
    },
    'Manual scroll near bottom should also exit reply-jump mode'
  );

  logger.debug('✓ testChatReplyJumpUiInteractionFlow passed');
})();

(function testChatReplyJumpMetricRollupHelper() {
  const state = createChatReplyJumpMetricRollupState();

  const firstEmission = recordChatReplyJumpMetricRollup(
    state,
    {
      reason: 'found',
      success: true,
      usedHistoryLoads: 0,
      source: 'interactive',
      platformOS: 'web',
    },
    1000
  );
  assert(firstEmission, 'First reply-jump metric event should emit a rollup payload');
  assert.strictEqual(firstEmission?.totalEvents, 1, 'First emission should report totalEvents=1');
  assert.strictEqual(firstEmission?.reason, 'found', 'First emission should include the triggering reason');

  for (let i = 0; i < 8; i += 1) {
    const reason = i < 5 ? 'not-found' : 'cancelled';
    const emission = recordChatReplyJumpMetricRollup(
      state,
      {
        reason,
        success: false,
        usedHistoryLoads: 2,
        source: 'interactive',
        platformOS: 'web',
      },
      1200 + i
    );
    assert.strictEqual(emission, null, 'Intermediate reply-jump events should not emit on every attempt');
  }

  const tenthEmission = recordChatReplyJumpMetricRollup(
    state,
    {
      reason: 'cancelled',
      success: false,
      usedHistoryLoads: 1,
      source: 'silent',
      platformOS: 'ios',
    },
    2000
  );
  assert(tenthEmission, 'Every 10th reply-jump event should emit a rollup payload');
  assert.strictEqual(tenthEmission?.totalEvents, 10, 'Tenth emission should report totalEvents=10');
  assert.strictEqual(tenthEmission?.source, 'silent', 'Emission should carry source for triggering event');
  assert.strictEqual(tenthEmission?.sourceCount, 1, 'Silent source count should reflect triggering event');
  assert.strictEqual(
    tenthEmission?.anomalyLevel,
    'high',
    'Tenth emission should flag high anomaly when both not-found and cancelled rates cross thresholds'
  );
  assert.strictEqual(
    tenthEmission?.hasElevatedNotFoundRate,
    true,
    'Not-found anomaly flag should be enabled when rate threshold is crossed'
  );
  assert.strictEqual(
    tenthEmission?.hasElevatedCancelledRate,
    true,
    'Cancelled anomaly flag should be enabled when rate threshold is crossed'
  );

  const timeoutEmission = recordChatReplyJumpMetricRollup(
    state,
    {
      reason: 'invalid-target',
      success: false,
      usedHistoryLoads: 0,
      source: 'interactive',
      platformOS: 'android',
    },
    63000
  );
  assert(timeoutEmission, 'Rollup should emit again after 60s cadence window');
  assert.strictEqual(timeoutEmission?.reason, 'invalid-target', 'Timeout emission should include latest reason');
  assert.strictEqual(timeoutEmission?.platformOS, 'android', 'Timeout emission should include latest platform');

  const noFlushEmission = flushChatReplyJumpMetricRollup(state, 64000);
  assert.strictEqual(
    noFlushEmission,
    null,
    'Flush should not emit immediately after a cadence emission with no new events'
  );

  recordChatReplyJumpMetricRollup(
    state,
    {
      reason: 'found',
      success: true,
      usedHistoryLoads: 0,
      source: 'interactive',
      platformOS: 'web',
    },
    64100
  );

  const flushEmission = flushChatReplyJumpMetricRollup(state, 64200);
  assert(flushEmission, 'Flush should emit pending rollup when new events exist since last cadence emission');
  assert.strictEqual(flushEmission?.emittedBy, 'flush', 'Flush emission should be tagged as flush output');

  const duplicateFlushEmission = flushChatReplyJumpMetricRollup(state, 64300);
  assert.strictEqual(
    duplicateFlushEmission,
    null,
    'Flush should suppress duplicate emissions when no additional events have been recorded'
  );

  logger.debug('✓ testChatReplyJumpMetricRollupHelper passed');
})();

(function testChatNearBottomStateHelper() {
  const enterNearBottomWithUnread = resolveChatNearBottomState({
    offsetY: 640,
    contentHeight: 1000,
    layoutHeight: 320,
    bottomVisibilityPadding: 20,
    wasNearBottom: false,
    showUnreadSeparator: true,
    activeUnreadAnchorId: ' msg-42 ',
    lastDismissedUnreadAnchorId: null,
  });

  assert.strictEqual(
    enterNearBottomWithUnread.nearBottom,
    true,
    'Near-bottom helper should report nearBottom=true when distance is below threshold'
  );
  assert.strictEqual(
    enterNearBottomWithUnread.enteredNearBottom,
    true,
    'Near-bottom helper should flag enteredNearBottom on threshold transition'
  );
  assert.strictEqual(
    enterNearBottomWithUnread.shouldDismissUnreadDivider,
    true,
    'Near-bottom helper should request unread-divider dismissal when entering near-bottom with an unread anchor'
  );
  assert.strictEqual(
    enterNearBottomWithUnread.nextDismissedUnreadAnchorId,
    'msg-42',
    'Near-bottom helper should normalize and persist the active unread anchor id after dismissal'
  );

  const stayNearBottomSameAnchor = resolveChatNearBottomState({
    offsetY: 646,
    contentHeight: 1000,
    layoutHeight: 320,
    bottomVisibilityPadding: 20,
    wasNearBottom: true,
    showUnreadSeparator: true,
    activeUnreadAnchorId: 'msg-42',
    lastDismissedUnreadAnchorId: 'msg-42',
  });

  assert.strictEqual(
    stayNearBottomSameAnchor.enteredNearBottom,
    false,
    'Near-bottom helper should not report re-entry while already near-bottom'
  );
  assert.strictEqual(
    stayNearBottomSameAnchor.shouldDismissUnreadDivider,
    false,
    'Near-bottom helper should suppress repeated unread-divider dismissal for the same anchor while staying near-bottom'
  );
  assert.strictEqual(
    stayNearBottomSameAnchor.nextDismissedUnreadAnchorId,
    'msg-42',
    'Near-bottom helper should retain the anchor id while still near-bottom'
  );

  const leaveNearBottom = resolveChatNearBottomState({
    offsetY: 200,
    contentHeight: 1000,
    layoutHeight: 320,
    bottomVisibilityPadding: 20,
    wasNearBottom: true,
    showUnreadSeparator: true,
    activeUnreadAnchorId: 'msg-42',
    lastDismissedUnreadAnchorId: 'msg-42',
  });

  assert.strictEqual(
    leaveNearBottom.nearBottom,
    false,
    'Near-bottom helper should report nearBottom=false when user scrolls away from threshold'
  );
  assert.strictEqual(
    leaveNearBottom.leftNearBottom,
    true,
    'Near-bottom helper should flag leftNearBottom on transition away from near-bottom'
  );
  assert.strictEqual(
    leaveNearBottom.nextDismissedUnreadAnchorId,
    null,
    'Near-bottom helper should clear cached dismissed anchor when user leaves near-bottom'
  );

  const changedAnchorWhileNearBottom = resolveChatNearBottomState({
    offsetY: 650,
    contentHeight: 1000,
    layoutHeight: 320,
    bottomVisibilityPadding: 20,
    wasNearBottom: true,
    showUnreadSeparator: true,
    activeUnreadAnchorId: 'msg-99',
    lastDismissedUnreadAnchorId: 'msg-42',
  });

  assert.strictEqual(
    changedAnchorWhileNearBottom.shouldDismissUnreadDivider,
    true,
    'Near-bottom helper should re-trigger unread-divider dismissal when anchor changes while staying near-bottom'
  );
  assert.strictEqual(
    changedAnchorWhileNearBottom.nextDismissedUnreadAnchorId,
    'msg-99',
    'Near-bottom helper should update cached dismissed anchor id to the latest value'
  );

  logger.debug('✓ testChatNearBottomStateHelper passed');
})();

(function testChatAnchorStabilizationStateHelper() {
  assert.deepStrictEqual(
    resolveChatEnsureAnchorActionPlan({
      anchor: null,
      hasUserInteracted: false,
      startedAtMs: 0,
      nowMs: 1000,
      stabilizeMs: 1500,
    }),
    {
      shouldStopStabilization: false,
      shouldScrollBottom: false,
      shouldScrollMessage: false,
    },
    'Anchor-stabilization helper should no-op when there is no anchor target'
  );

  assert.strictEqual(
    resolveChatEnsureAnchorActionPlan({
      anchor: { type: 'bottom' },
      hasUserInteracted: true,
      startedAtMs: 100,
      nowMs: 200,
      stabilizeMs: 1500,
    }).shouldStopStabilization,
    true,
    'Anchor-stabilization helper should stop when user interaction takes control'
  );

  assert.strictEqual(
    resolveChatEnsureAnchorActionPlan({
      anchor: { type: 'message', id: 'm1' },
      hasUserInteracted: false,
      startedAtMs: 100,
      nowMs: 2000,
      stabilizeMs: 1500,
    }).shouldStopStabilization,
    true,
    'Anchor-stabilization helper should stop once stabilization window elapsed'
  );

  assert.deepStrictEqual(
    resolveChatEnsureAnchorActionPlan({
      anchor: { type: 'bottom' },
      hasUserInteracted: false,
      startedAtMs: 100,
      nowMs: 200,
      stabilizeMs: 1500,
    }),
    {
      shouldStopStabilization: false,
      shouldScrollBottom: true,
      shouldScrollMessage: false,
    },
    'Anchor-stabilization helper should request bottom scrolling while stabilization is active'
  );

  assert.deepStrictEqual(
    resolveChatEnsureAnchorActionPlan({
      anchor: { type: 'message', id: 'm7' },
      hasUserInteracted: false,
      startedAtMs: 100,
      nowMs: 200,
      stabilizeMs: 1500,
    }),
    {
      shouldStopStabilization: false,
      shouldScrollBottom: false,
      shouldScrollMessage: true,
      messageId: 'm7',
    },
    'Anchor-stabilization helper should request message scrolling with target id during stabilization'
  );

  assert.deepStrictEqual(
    resolveChatBottomAnchorAttemptPlan({
      hasAnchoredInitialScroll: true,
      force: false,
      contentHeight: 1200,
      layoutHeight: 700,
    }),
    {
      shouldAnchor: false,
      shouldSkipAsAlreadyAnchored: true,
      shouldDeferForLayout: false,
    },
    'Anchor-attempt helper should skip redundant bottom anchoring when initial anchor is already set'
  );

  assert.deepStrictEqual(
    resolveChatBottomAnchorAttemptPlan({
      hasAnchoredInitialScroll: false,
      force: false,
      contentHeight: 0,
      layoutHeight: 700,
    }),
    {
      shouldAnchor: false,
      shouldSkipAsAlreadyAnchored: false,
      shouldDeferForLayout: true,
    },
    'Anchor-attempt helper should defer anchoring when layout dimensions are not ready'
  );

  assert.deepStrictEqual(
    resolveChatBottomAnchorAttemptPlan({
      hasAnchoredInitialScroll: true,
      force: true,
      contentHeight: 1200,
      layoutHeight: 700,
    }),
    {
      shouldAnchor: true,
      shouldSkipAsAlreadyAnchored: false,
      shouldDeferForLayout: false,
    },
    'Anchor-attempt helper should allow forced anchoring even after initial anchor'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorRetryPlan({
      attempts: 2,
      maxAttempts: 12,
    }),
    {
      shouldClearAnchor: false,
      shouldRetry: true,
      nextAttempts: 3,
    },
    'Prepend-anchor retry helper should increment attempts while below max threshold'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorRetryPlan({
      attempts: 12,
      maxAttempts: 12,
    }),
    {
      shouldClearAnchor: true,
      shouldRetry: false,
      nextAttempts: 12,
    },
    'Prepend-anchor retry helper should clear anchor once attempts reach max threshold'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorRetrySchedulePlan({
      retryPlan: {
        shouldClearAnchor: false,
        shouldRetry: true,
        nextAttempts: 4,
      },
      anchorId: 'm-1',
      anchorOffset: 18,
    }),
    {
      shouldScheduleRetry: true,
      nextAnchor: {
        id: 'm-1',
        offset: 18,
        attempts: 4,
      },
      retryDelayMs: 50,
    },
    'Prepend-anchor retry schedule helper should shape next anchor and default retry delay for retryable plans'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorRetrySchedulePlan({
      retryPlan: {
        shouldClearAnchor: true,
        shouldRetry: false,
        nextAttempts: 12,
      },
      anchorId: 'm-1',
      anchorOffset: 18,
      retryDelayMs: -10,
    }),
    {
      shouldScheduleRetry: false,
      nextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor retry schedule helper should no-op scheduling when retry is not requested'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFallbackPlan({
      hasDisplayedMessages: true,
      fallbackIndex: 5,
    }),
    {
      shouldScrollToIndex: true,
      targetIndex: 5,
    },
    'Prepend-anchor fallback helper should allow index fallback when displayed messages exist and index is valid'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFallbackPlan({
      hasDisplayedMessages: false,
      fallbackIndex: 5,
    }),
    {
      shouldScrollToIndex: false,
      targetIndex: null,
    },
    'Prepend-anchor fallback helper should suppress index fallback when displayed messages are unavailable'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFallbackScrollPlan({
      fallbackPlan: {
        shouldScrollToIndex: true,
        targetIndex: 6,
      },
      anchorOffset: 18.9,
    }),
    {
      shouldInvokeScrollToIndex: true,
      payload: {
        index: 6,
        animated: false,
        viewPosition: 0,
        viewOffset: 18,
      },
    },
    'Prepend-anchor fallback scroll helper should shape scroll-to-index payload with normalized viewOffset'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFallbackScrollPlan({
      fallbackPlan: {
        shouldScrollToIndex: false,
        targetIndex: null,
      },
      anchorOffset: -20,
    }),
    {
      shouldInvokeScrollToIndex: false,
      payload: null,
    },
    'Prepend-anchor fallback scroll helper should no-op when fallback scroll is not requested'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorClearPlan({
      retryPlan: {
        shouldClearAnchor: false,
        shouldRetry: true,
        nextAttempts: 3,
      },
      shouldResolveFallback: true,
      hasDisplayedMessages: true,
      fallbackIndex: 5,
    }),
    {
      shouldClearAnchor: false,
      fallbackPlan: {
        shouldScrollToIndex: false,
        targetIndex: null,
      },
    },
    'Prepend-anchor clear helper should no-op when retry plan does not request clearing'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorClearPlan({
      retryPlan: {
        shouldClearAnchor: true,
        shouldRetry: false,
        nextAttempts: 12,
      },
      shouldResolveFallback: true,
      hasDisplayedMessages: true,
      fallbackIndex: 7.8,
    }),
    {
      shouldClearAnchor: true,
      fallbackPlan: {
        shouldScrollToIndex: true,
        targetIndex: 7,
      },
    },
    'Prepend-anchor clear helper should provide fallback index plan when clearing with fallback enabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorClearPlan({
      retryPlan: {
        shouldClearAnchor: true,
        shouldRetry: false,
        nextAttempts: 12,
      },
      shouldResolveFallback: false,
      hasDisplayedMessages: true,
      fallbackIndex: 7,
    }),
    {
      shouldClearAnchor: true,
      fallbackPlan: {
        shouldScrollToIndex: false,
        targetIndex: null,
      },
    },
    'Prepend-anchor clear helper should suppress fallback planning when fallback is disabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailurePlan({
      attempts: 3,
      maxAttempts: 12,
      shouldResolveFallback: false,
    }),
    {
      retryPlan: {
        shouldClearAnchor: false,
        shouldRetry: true,
        nextAttempts: 4,
      },
      clearPlan: {
        shouldClearAnchor: false,
        fallbackPlan: {
          shouldScrollToIndex: false,
          targetIndex: null,
        },
      },
      shouldRetry: true,
    },
    'Prepend-anchor failure helper should request retry when below max attempts and clear is not requested'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailurePlanInput({
      attempts: 3.7,
      maxAttempts: 12.2,
      shouldResolveFallback: true,
      hasDisplayedMessages: true,
      fallbackIndex: 9.8,
    }),
    {
      attempts: 3,
      maxAttempts: 12,
      shouldResolveFallback: true,
      hasDisplayedMessages: true,
      fallbackIndex: 9,
    },
    'Prepend-anchor failure-plan-input helper should normalize finite numeric inputs and preserve fallback signals when enabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailurePlanInput({
      attempts: Number.NaN,
      maxAttempts: -4,
      shouldResolveFallback: false,
      hasDisplayedMessages: true,
      fallbackIndex: Number.NaN,
    }),
    {
      attempts: 0,
      maxAttempts: 0,
      shouldResolveFallback: false,
      hasDisplayedMessages: false,
      fallbackIndex: -1,
    },
    'Prepend-anchor failure-plan-input helper should clamp invalid inputs and suppress fallback flags when fallback resolution is disabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureFallbackInputPlan({
      shouldResolveFallback: true,
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 5.8,
    }),
    {
      hasDisplayedMessages: true,
      fallbackIndex: 5,
    },
    'Prepend-anchor failure fallback-input helper should normalize fallback input from raw displayed messages and fallback index values'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureFallbackInputPlan({
      shouldResolveFallback: false,
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 5,
    }),
    {
      hasDisplayedMessages: false,
      fallbackIndex: -1,
    },
    'Prepend-anchor failure fallback-input helper should return no-op fallback signals when fallback resolution is disabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailurePlan({
      attempts: 12,
      maxAttempts: 12,
      shouldResolveFallback: true,
      hasDisplayedMessages: true,
      fallbackIndex: 9,
    }),
    {
      retryPlan: {
        shouldClearAnchor: true,
        shouldRetry: false,
        nextAttempts: 12,
      },
      clearPlan: {
        shouldClearAnchor: true,
        fallbackPlan: {
          shouldScrollToIndex: true,
          targetIndex: 9,
        },
      },
      shouldRetry: false,
    },
    'Prepend-anchor failure helper should suppress retry and return fallback clear plan when attempts reach max'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorRestoreOffsetPlan({
      targetY: 120,
      anchorOffset: 18,
    }),
    {
      payload: {
        offset: 138,
        animated: false,
      },
    },
    'Prepend-anchor restore-offset helper should shape scroll-to-offset payload from target y and anchor offset'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorRestoreOffsetPlan({
      targetY: Number.NaN,
      anchorOffset: -20,
    }),
    {
      payload: {
        offset: 0,
        animated: false,
      },
    },
    'Prepend-anchor restore-offset helper should normalize invalid numeric inputs and clamp negative offsets to 0'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureRetrySchedulePlan({
      failurePlan: {
        retryPlan: {
          shouldClearAnchor: false,
          shouldRetry: true,
          nextAttempts: 5,
        },
        clearPlan: {
          shouldClearAnchor: false,
          fallbackPlan: {
            shouldScrollToIndex: false,
            targetIndex: null,
          },
        },
        shouldRetry: true,
      },
      anchorId: 'm-1',
      anchorOffset: 22,
    }),
    {
      shouldScheduleRetry: true,
      nextAnchor: {
        id: 'm-1',
        offset: 22,
        attempts: 5,
      },
      retryDelayMs: 50,
    },
    'Prepend-anchor failure retry-schedule helper should forward retryable failure plans into normalized retry schedule payloads'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureRetrySchedulePlan({
      failurePlan: {
        retryPlan: {
          shouldClearAnchor: true,
          shouldRetry: false,
          nextAttempts: 12,
        },
        clearPlan: {
          shouldClearAnchor: true,
          fallbackPlan: {
            shouldScrollToIndex: true,
            targetIndex: 9,
          },
        },
        shouldRetry: false,
      },
      anchorId: 'm-1',
      anchorOffset: 22,
      retryDelayMs: -1,
    }),
    {
      shouldScheduleRetry: false,
      nextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor failure retry-schedule helper should return a no-op schedule when failure plan is non-retryable'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureClearActionPlan({
      failurePlan: {
        retryPlan: {
          shouldClearAnchor: false,
          shouldRetry: true,
          nextAttempts: 5,
        },
        clearPlan: {
          shouldClearAnchor: false,
          fallbackPlan: {
            shouldScrollToIndex: true,
            targetIndex: 9,
          },
        },
        shouldRetry: true,
      },
      anchorOffset: 22,
    }),
    {
      shouldClearAnchor: false,
      fallbackScrollPlan: {
        shouldInvokeScrollToIndex: false,
        payload: null,
      },
    },
    'Prepend-anchor failure clear-action helper should no-op when failure plan does not request clearing'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureClearActionPlan({
      failurePlan: {
        retryPlan: {
          shouldClearAnchor: true,
          shouldRetry: false,
          nextAttempts: 12,
        },
        clearPlan: {
          shouldClearAnchor: true,
          fallbackPlan: {
            shouldScrollToIndex: true,
            targetIndex: 9,
          },
        },
        shouldRetry: false,
      },
      anchorOffset: 22.7,
    }),
    {
      shouldClearAnchor: true,
      fallbackScrollPlan: {
        shouldInvokeScrollToIndex: true,
        payload: {
          index: 9,
          animated: false,
          viewPosition: 0,
          viewOffset: 22,
        },
      },
    },
    'Prepend-anchor failure clear-action helper should return clear action with normalized fallback scroll payload when clearing is requested'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlans({
      failurePlan: {
        retryPlan: {
          shouldClearAnchor: false,
          shouldRetry: true,
          nextAttempts: 4,
        },
        clearPlan: {
          shouldClearAnchor: false,
          fallbackPlan: {
            shouldScrollToIndex: false,
            targetIndex: null,
          },
        },
        shouldRetry: true,
      },
      anchorId: 'm-1',
      anchorOffset: 11,
    }),
    {
      clearActionPlan: {
        shouldClearAnchor: false,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: false,
          payload: null,
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    },
    'Prepend-anchor failure action-plans helper should bundle clear-action and retry-schedule plans for retryable failures'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlans({
      failurePlan: {
        retryPlan: {
          shouldClearAnchor: true,
          shouldRetry: false,
          nextAttempts: 12,
        },
        clearPlan: {
          shouldClearAnchor: true,
          fallbackPlan: {
            shouldScrollToIndex: true,
            targetIndex: 8,
          },
        },
        shouldRetry: false,
      },
      anchorId: 'm-1',
      anchorOffset: 11.8,
      retryDelayMs: -1,
    }),
    {
      clearActionPlan: {
        shouldClearAnchor: true,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: true,
          payload: {
            index: 8,
            animated: false,
            viewPosition: 0,
            viewOffset: 11,
          },
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: false,
        nextAnchor: null,
        retryDelayMs: 0,
      },
    },
    'Prepend-anchor failure action-plans helper should bundle clear-action fallback scroll with non-retry retry schedule for terminal failures'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlansFromInput({
      attempts: 3.7,
      maxAttempts: 12,
      shouldResolveFallback: true,
      hasDisplayedMessages: true,
      fallbackIndex: 8.9,
      anchorId: 'm-1',
      anchorOffset: 11.4,
    }),
    {
      clearActionPlan: {
        shouldClearAnchor: false,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: false,
          payload: null,
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11.4,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    },
    'Prepend-anchor failure action-plans-from-input helper should normalize raw failure inputs and return retryable action bundle'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlansFromInput({
      attempts: Number.NaN,
      maxAttempts: -3,
      shouldResolveFallback: false,
      hasDisplayedMessages: true,
      fallbackIndex: Number.NaN,
      anchorId: 'm-1',
      anchorOffset: 11.4,
      retryDelayMs: -1,
    }),
    {
      clearActionPlan: {
        shouldClearAnchor: true,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: false,
          payload: null,
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: false,
        nextAnchor: null,
        retryDelayMs: 0,
      },
    },
    'Prepend-anchor failure action-plans-from-input helper should clamp invalid raw inputs into terminal clear/no-retry action bundle'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlansRawInputPlan({
      attempts: 3,
      maxAttempts: 12,
      shouldResolveFallback: true,
      fallbackInputPlan: {
        hasDisplayedMessages: true,
        fallbackIndex: 8,
      },
      anchorId: 'm-1',
      anchorOffset: 11,
    }),
    {
      attempts: 3,
      maxAttempts: 12,
      shouldResolveFallback: true,
      hasDisplayedMessages: true,
      fallbackIndex: 8,
      anchorId: 'm-1',
      anchorOffset: 11,
      retryDelayMs: undefined,
    },
    'Prepend-anchor failure action raw-input helper should include fallback signals when fallback resolution is enabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlansRawInputPlan({
      attempts: 3,
      maxAttempts: 12,
      shouldResolveFallback: false,
      fallbackInputPlan: {
        hasDisplayedMessages: true,
        fallbackIndex: 8,
      },
      anchorId: 'm-1',
      anchorOffset: 11,
      retryDelayMs: -1,
    }),
    {
      attempts: 3,
      maxAttempts: 12,
      shouldResolveFallback: false,
      hasDisplayedMessages: false,
      fallbackIndex: -1,
      anchorId: 'm-1',
      anchorOffset: 11,
      retryDelayMs: -1,
    },
    'Prepend-anchor failure action raw-input helper should suppress fallback signals when fallback resolution is disabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureAnchorContextPlan({
      anchorAttempts: 3.7,
      maxAttempts: 12.2,
      anchorId: 'm-1',
      anchorOffset: 11.4,
      retryDelayMs: 49.9,
    }),
    {
      attempts: 3,
      maxAttempts: 12,
      anchorId: 'm-1',
      anchorOffset: 11.4,
      retryDelayMs: 49,
    },
    'Prepend-anchor failure anchor-context helper should normalize finite anchor context inputs and preserve anchor identity'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureAnchorContextPlan({
      anchorAttempts: Number.NaN,
      maxAttempts: -3,
      anchorId: null,
      anchorOffset: -4,
      retryDelayMs: -1,
    }),
    {
      attempts: 0,
      maxAttempts: 0,
      anchorId: '',
      anchorOffset: 0,
      retryDelayMs: undefined,
    },
    'Prepend-anchor failure anchor-context helper should clamp invalid context values and default missing anchor identity'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlansFromContext({
      anchorContextPlan: {
        attempts: 3,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11.4,
      },
      branchKind: 'missing-target',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8.9,
    }),
    {
      clearActionPlan: {
        shouldClearAnchor: false,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: false,
          payload: null,
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11.4,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    },
    'Prepend-anchor failure action-plans-from-context helper should derive retryable action plans from anchor context and fallback sources'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureActionPlansFromContext({
      anchorContextPlan: {
        attempts: 0,
        maxAttempts: 0,
        anchorId: 'm-1',
        anchorOffset: 11.4,
      },
      branchKind: 'scroll-failed',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8,
    }),
    {
      clearActionPlan: {
        shouldClearAnchor: true,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: false,
          payload: null,
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: false,
        nextAnchor: null,
        retryDelayMs: 0,
      },
    },
    'Prepend-anchor failure action-plans-from-context helper should ignore fallback sources when fallback resolution is disabled and derive terminal clear action'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureFallbackResolutionPlan('missing-target'),
    {
      shouldResolveFallback: true,
    },
    'Prepend-anchor failure fallback-resolution helper should enable fallback for missing-target failures'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureFallbackResolutionPlan('scroll-failed'),
    {
      shouldResolveFallback: false,
    },
    'Prepend-anchor failure fallback-resolution helper should disable fallback for scroll-failed failures'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectIntentFromContext({
      anchorContextPlan: {
        attempts: 3,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      branchKind: 'missing-target',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8,
    }),
    {
      kind: 'retry',
      clearFallbackScrollPayload: null,
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    },
    'Prepend-anchor failure effect-intent-from-context helper should derive retry intent for retryable missing-target failures'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectIntentFromContext({
      anchorContextPlan: {
        attempts: 0,
        maxAttempts: 0,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      branchKind: 'scroll-failed',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8,
    }),
    {
      kind: 'clear',
      clearFallbackScrollPayload: null,
      retrySchedulePlan: null,
    },
    'Prepend-anchor failure effect-intent-from-context helper should derive clear intent for terminal scroll-failed failures'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectExecutionPlan({
      kind: 'retry',
      clearFallbackScrollPayload: null,
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    }),
    {
      shouldClearAnchor: false,
      clearFallbackScrollPayload: null,
      retryNextAnchor: {
        id: 'm-1',
        offset: 11,
        attempts: 4,
      },
      retryDelayMs: 50,
    },
    'Prepend-anchor failure effect execution helper should produce retry execution payload when retry intent is provided'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectExecutionPlan({
      kind: 'none',
      clearFallbackScrollPayload: null,
      retrySchedulePlan: null,
    }),
    {
      shouldClearAnchor: false,
      clearFallbackScrollPayload: null,
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor failure effect execution helper should return no-op payload for none intent'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectExecutionFromContext({
      anchorContextPlan: {
        attempts: 11,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      branchKind: 'missing-target',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8,
    }),
    {
      shouldClearAnchor: false,
      clearFallbackScrollPayload: null,
      retryNextAnchor: {
        id: 'm-1',
        offset: 11,
        attempts: 12,
      },
      retryDelayMs: 50,
    },
    'Prepend-anchor failure effect execution-from-context helper should derive retry execution payload from retryable context'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectExecutionFromContext({
      anchorContextPlan: {
        attempts: 12,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      branchKind: 'missing-target',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8,
    }),
    {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor failure effect execution-from-context helper should derive clear execution payload with fallback scroll when retries are exhausted'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureExecutionContextPlan({
      branchKind: 'missing-target',
      anchorId: 'm-1',
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      branchKind: 'missing-target',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8,
    },
    'Prepend-anchor failure execution-context helper should derive fallback inputs for missing-target branch'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureExecutionContextPlan({
      branchKind: 'scroll-failed',
      anchorId: 'm-1',
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      branchKind: 'scroll-failed',
    },
    'Prepend-anchor failure execution-context helper should return minimal payload for scroll-failed branch'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectExecutionForAnchor({
      anchorContextPlan: {
        attempts: 12,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      branchKind: 'missing-target',
      anchorId: 'm-1',
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor failure execution-for-anchor helper should derive clear execution payload from anchor context and missing-target branch inputs'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectExecutionForAnchor({
      anchorContextPlan: {
        attempts: 0,
        maxAttempts: 0,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      branchKind: 'scroll-failed',
      anchorId: 'm-1',
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: null,
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor failure execution-for-anchor helper should ignore fallback context for scroll-failed branch and derive terminal clear payload'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectExecutionPlansForAnchor({
      anchorContextPlan: {
        attempts: 12,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      anchorId: 'm-1',
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      missingTargetExecutionPlan: {
        shouldClearAnchor: true,
        clearFallbackScrollPayload: {
          index: 8,
          animated: false,
          viewPosition: 0,
          viewOffset: 11,
        },
        retryNextAnchor: null,
        retryDelayMs: 0,
      },
      scrollFailedExecutionPlan: {
        shouldClearAnchor: true,
        clearFallbackScrollPayload: null,
        retryNextAnchor: null,
        retryDelayMs: 0,
      },
    },
    'Prepend-anchor failure execution-plans-for-anchor helper should precompute branch-specific execution payloads from shared anchor inputs'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureRestorePlans({
      anchorAttempts: 12,
      maxAttempts: 12,
      anchorId: 'm-1',
      anchorOffset: 11,
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      anchorContextPlan: {
        attempts: 12,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11,
        retryDelayMs: undefined,
      },
      failureExecutionPlans: {
        missingTargetExecutionPlan: {
          shouldClearAnchor: true,
          clearFallbackScrollPayload: {
            index: 8,
            animated: false,
            viewPosition: 0,
            viewOffset: 11,
          },
          retryNextAnchor: null,
          retryDelayMs: 0,
        },
        scrollFailedExecutionPlan: {
          shouldClearAnchor: true,
          clearFallbackScrollPayload: null,
          retryNextAnchor: null,
          retryDelayMs: 0,
        },
      },
    },
    'Prepend-anchor failure restore-plans helper should combine normalized anchor context with precomputed branch execution plans'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureExecutionSelectionPlan({
      targetExists: false,
      failureExecutionPlans: {
        missingTargetExecutionPlan: {
          shouldClearAnchor: true,
          clearFallbackScrollPayload: {
            index: 8,
            animated: false,
            viewPosition: 0,
            viewOffset: 11,
          },
          retryNextAnchor: null,
          retryDelayMs: 0,
        },
        scrollFailedExecutionPlan: {
          shouldClearAnchor: false,
          clearFallbackScrollPayload: null,
          retryNextAnchor: {
            id: 'm-1',
            offset: 11,
            attempts: 3,
          },
          retryDelayMs: 50,
        },
      },
    }),
    {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor failure execution-selection helper should choose missing-target execution payload when target is absent'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureExecutionSelectionPlan({
      targetExists: true,
      failureExecutionPlans: {
        missingTargetExecutionPlan: {
          shouldClearAnchor: true,
          clearFallbackScrollPayload: {
            index: 8,
            animated: false,
            viewPosition: 0,
            viewOffset: 11,
          },
          retryNextAnchor: null,
          retryDelayMs: 0,
        },
        scrollFailedExecutionPlan: {
          shouldClearAnchor: false,
          clearFallbackScrollPayload: null,
          retryNextAnchor: {
            id: 'm-1',
            offset: 11,
            attempts: 3,
          },
          retryDelayMs: 50,
        },
      },
    }),
    {
      shouldClearAnchor: false,
      clearFallbackScrollPayload: null,
      retryNextAnchor: {
        id: 'm-1',
        offset: 11,
        attempts: 3,
      },
      retryDelayMs: 50,
    },
    'Prepend-anchor failure execution-selection helper should choose scroll-failed execution payload when target exists'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureExecutionPlanForRestore({
      targetExists: false,
      anchorAttempts: 12,
      maxAttempts: 12,
      anchorId: 'm-1',
      anchorOffset: 11,
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor restore execution helper should resolve missing-target execution payload directly from restore inputs'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureExecutionPlanForRestore({
      targetExists: true,
      anchorAttempts: 12,
      maxAttempts: 12,
      anchorId: 'm-1',
      anchorOffset: 11,
      displayedMessages: [{ id: 'm-1' }],
      displayedMessageIndexById: new Map([['m-1', 8]]),
    }),
    {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: null,
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    'Prepend-anchor restore execution helper should resolve scroll-failed execution payload directly from restore inputs'
  );

  // Test selected-plan applier factory
  const pendingRef = { current: { id: 'm-1', offset: 11, attempts: 0 } };
  const applySelected = createChatPrependAnchorFailureSelectedExecutor(
    {
      pendingPrependAnchorRef: pendingRef,
      list: null,
      scheduleRetry: () => {},
    },
    {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: null,
      retryNextAnchor: null,
      retryDelayMs: 0,
    }
  );

  assert.strictEqual(applySelected(), true, 'Selected applier should return true when it clears anchor');
  assert.strictEqual(pendingRef.current, null, 'Selected applier should clear pending anchor');

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectIntentPlan({
      clearActionPlan: {
        shouldClearAnchor: true,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: true,
          payload: {
            index: 8,
            animated: false,
            viewPosition: 0,
            viewOffset: 11,
          },
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    }),
    {
      kind: 'clear',
      clearFallbackScrollPayload: {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
      retrySchedulePlan: null,
    },
    'Prepend-anchor failure effect intent helper should prioritize clear intent when clear action is requested'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectIntentPlan({
      clearActionPlan: {
        shouldClearAnchor: false,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: false,
          payload: null,
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    }),
    {
      kind: 'retry',
      clearFallbackScrollPayload: null,
      retrySchedulePlan: {
        shouldScheduleRetry: true,
        nextAnchor: {
          id: 'm-1',
          offset: 11,
          attempts: 4,
        },
        retryDelayMs: 50,
      },
    },
    'Prepend-anchor failure effect intent helper should return retry intent when clear is not requested and retry schedule is valid'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorFailureEffectIntentPlan({
      clearActionPlan: {
        shouldClearAnchor: false,
        fallbackScrollPlan: {
          shouldInvokeScrollToIndex: false,
          payload: null,
        },
      },
      retrySchedulePlan: {
        shouldScheduleRetry: false,
        nextAnchor: null,
        retryDelayMs: 0,
      },
    }),
    {
      kind: 'none',
      clearFallbackScrollPayload: null,
      retrySchedulePlan: null,
    },
    'Prepend-anchor failure effect intent helper should return none intent when neither clear nor retry actions are applicable'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorCapturePlan({
      shouldUseManualAnchorPreservation: false,
      hasPendingAnchor: false,
      topVisibleId: 'm-1',
      topVisibleY: 120,
      currentOffset: 220,
    }),
    {
      shouldCapture: false,
      anchorId: null,
      anchorOffset: 0,
    },
    'Prepend-anchor capture helper should no-op when manual anchor preservation is disabled'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorCapturePlan({
      shouldUseManualAnchorPreservation: true,
      hasPendingAnchor: true,
      topVisibleId: 'm-1',
      topVisibleY: 120,
      currentOffset: 220,
    }),
    {
      shouldCapture: false,
      anchorId: null,
      anchorOffset: 0,
    },
    'Prepend-anchor capture helper should no-op when a pending anchor already exists'
  );

  assert.deepStrictEqual(
    resolveChatPrependAnchorCapturePlan({
      shouldUseManualAnchorPreservation: true,
      hasPendingAnchor: false,
      topVisibleId: 'm-1',
      topVisibleY: 120,
      currentOffset: 220,
    }),
    {
      shouldCapture: true,
      anchorId: 'm-1',
      anchorOffset: 100,
    },
    'Prepend-anchor capture helper should derive anchor offset from current scroll offset and top-visible y position'
  );

  assert.strictEqual(
    resolveChatPrependAnchorCaptureTriggerOffset(undefined),
    0,
    'Prepend-anchor capture trigger helper should fall back to 0 for missing offsets'
  );

  assert.strictEqual(
    resolveChatPrependAnchorCaptureTriggerOffset(-25),
    0,
    'Prepend-anchor capture trigger helper should clamp negative offsets to 0'
  );

  assert.strictEqual(
    resolveChatPrependAnchorCaptureTriggerOffset(42),
    42,
    'Prepend-anchor capture trigger helper should preserve valid positive offsets'
  );

  logger.debug('✓ testChatAnchorStabilizationStateHelper passed');
})();

(function testChatAnchorFailureExecutionRuntimeHelper() {
  const clearFallbackPayload = {
    index: 8,
    animated: false,
    viewPosition: 0,
    viewOffset: 11,
  };
  const clearAnchorRef = {
    current: {
      id: 'm-1',
      offset: 11,
      attempts: 2,
    },
  };
  const clearScrollCalls = [];

  assert.strictEqual(
    applyChatPrependAnchorFailureExecutionPlan({
      executionPlan: {
        shouldClearAnchor: true,
        clearFallbackScrollPayload: clearFallbackPayload,
        retryNextAnchor: null,
        retryDelayMs: 0,
      },
      pendingPrependAnchorRef: clearAnchorRef,
      list: {
        scrollToIndex: (payload) => clearScrollCalls.push(payload),
      },
      scheduleRetry: () => {
        throw new Error('Clear plan should not schedule retry');
      },
    }),
    true,
    'Anchor failure runtime helper should report clear handling when clear execution payload is provided'
  );

  assert.strictEqual(
    clearAnchorRef.current,
    null,
    'Anchor failure runtime helper should clear pending anchor ref for clear execution payloads'
  );

  assert.deepStrictEqual(
    clearScrollCalls,
    [clearFallbackPayload],
    'Anchor failure runtime helper should invoke fallback scroll payload exactly once when clear payload includes fallback scroll'
  );

  const retryAnchorRef = { current: null };
  const scheduledRetryDelays = [];
  let retryCallbackInvocations = 0;

  assert.strictEqual(
    applyChatPrependAnchorFailureExecutionPlan({
      executionPlan: {
        shouldClearAnchor: false,
        clearFallbackScrollPayload: null,
        retryNextAnchor: {
          id: 'm-1',
          offset: 11,
          attempts: 3,
        },
        retryDelayMs: 50,
      },
      pendingPrependAnchorRef: retryAnchorRef,
      list: null,
      scheduleRetry: () => {
        retryCallbackInvocations += 1;
      },
      scheduleTimeout: (callback, delayMs) => {
        scheduledRetryDelays.push(delayMs);
        callback();
      },
    }),
    false,
    'Anchor failure runtime helper should return false when retry execution payload is provided'
  );

  assert.deepStrictEqual(
    retryAnchorRef.current,
    {
      id: 'm-1',
      offset: 11,
      attempts: 3,
    },
    'Anchor failure runtime helper should assign next retry anchor before scheduling retry callback'
  );

  assert.deepStrictEqual(
    scheduledRetryDelays,
    [50],
    'Anchor failure runtime helper should schedule retry callback with execution-plan retry delay'
  );

  assert.strictEqual(
    retryCallbackInvocations,
    1,
    'Anchor failure runtime helper should invoke supplied retry callback via injected scheduler'
  );

  const contextAnchorRef = {
    current: {
      id: 'm-1',
      offset: 11,
      attempts: 12,
    },
  };
  const contextScrollCalls = [];
  const contextExecutionPlan =
    resolveChatPrependAnchorFailureEffectExecutionFromContext({
      anchorContextPlan: {
        attempts: 12,
        maxAttempts: 12,
        anchorId: 'm-1',
        anchorOffset: 11,
      },
      branchKind: 'missing-target',
      displayedMessages: [{ id: 'm-1' }],
      fallbackIndex: 8,
    });

  assert.strictEqual(
    applyChatPrependAnchorFailureExecutionPlan({
      executionPlan: contextExecutionPlan,
      pendingPrependAnchorRef: contextAnchorRef,
      list: {
        scrollToIndex: (payload) => contextScrollCalls.push(payload),
      },
      scheduleRetry: () => {
        throw new Error('Context clear path should not schedule retry');
      },
    }),
    true,
    'Anchor failure runtime helper should apply clear execution payload derived from missing-target context after retry exhaustion'
  );

  assert.strictEqual(
    contextAnchorRef.current,
    null,
    'Anchor failure runtime helper should clear pending anchor ref when context resolves to clear execution path'
  );

  assert.deepStrictEqual(
    contextScrollCalls,
    [
      {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
    ],
    'Anchor failure runtime helper should forward context-derived fallback scroll payload when clear execution path is selected'
  );

  const factoryAnchorRef = {
    current: {
      id: 'm-1',
      offset: 11,
      attempts: 1,
    },
  };
  const factoryScrollCalls = [];
  let factoryRetryInvocations = 0;
  const factoryRetryDelays = [];
  const applyWithFactory = createChatPrependAnchorFailureExecutor({
    pendingPrependAnchorRef: factoryAnchorRef,
    list: {
      scrollToIndex: (payload) => factoryScrollCalls.push(payload),
    },
    scheduleRetry: () => {
      factoryRetryInvocations += 1;
    },
    scheduleTimeout: (callback, delayMs) => {
      factoryRetryDelays.push(delayMs);
      callback();
    },
  });

  assert.strictEqual(
    applyWithFactory({
      shouldClearAnchor: true,
      clearFallbackScrollPayload: {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
      retryNextAnchor: null,
      retryDelayMs: 0,
    }),
    true,
    'Anchor failure runtime executor factory should apply clear execution payloads'
  );

  assert.strictEqual(
    factoryAnchorRef.current,
    null,
    'Anchor failure runtime executor factory should clear pending anchor ref on clear execution payloads'
  );

  assert.deepStrictEqual(
    factoryScrollCalls,
    [
      {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
    ],
    'Anchor failure runtime executor factory should reuse injected list for clear fallback scroll invocation'
  );

  assert.strictEqual(
    applyWithFactory({
      shouldClearAnchor: false,
      clearFallbackScrollPayload: null,
      retryNextAnchor: {
        id: 'm-1',
        offset: 11,
        attempts: 2,
      },
      retryDelayMs: 50,
    }),
    false,
    'Anchor failure runtime executor factory should apply retry execution payloads'
  );

  assert.deepStrictEqual(
    factoryAnchorRef.current,
    {
      id: 'm-1',
      offset: 11,
      attempts: 2,
    },
    'Anchor failure runtime executor factory should reuse injected pending-anchor ref for retry execution payloads'
  );

  assert.deepStrictEqual(
    factoryRetryDelays,
    [50],
    'Anchor failure runtime executor factory should reuse injected timeout scheduler for retry execution payloads'
  );

  assert.strictEqual(
    factoryRetryInvocations,
    1,
    'Anchor failure runtime executor factory should invoke injected retry callback via timeout scheduler'
  );

  const branchAnchorRef = {
    current: {
      id: 'm-1',
      offset: 11,
      attempts: 1,
    },
  };
  const branchScrollCalls = [];
  let branchRetryInvocations = 0;
  const branchRetryDelays = [];

  assert.strictEqual(
    applyChatPrependAnchorFailureBranchExecution({
      branchKind: 'missing-target',
      failureExecutionPlans: {
        missingTargetExecutionPlan: {
          shouldClearAnchor: true,
          clearFallbackScrollPayload: {
            index: 8,
            animated: false,
            viewPosition: 0,
            viewOffset: 11,
          },
          retryNextAnchor: null,
          retryDelayMs: 0,
        },
        scrollFailedExecutionPlan: {
          shouldClearAnchor: false,
          clearFallbackScrollPayload: null,
          retryNextAnchor: {
            id: 'm-1',
            offset: 11,
            attempts: 2,
          },
          retryDelayMs: 50,
        },
      },
      pendingPrependAnchorRef: branchAnchorRef,
      list: {
        scrollToIndex: (payload) => branchScrollCalls.push(payload),
      },
      scheduleRetry: () => {
        branchRetryInvocations += 1;
      },
      scheduleTimeout: (callback, delayMs) => {
        branchRetryDelays.push(delayMs);
        callback();
      },
    }),
    true,
    'Anchor failure runtime branch helper should apply missing-target execution plan when missing-target branch is selected'
  );

  assert.strictEqual(
    branchAnchorRef.current,
    null,
    'Anchor failure runtime branch helper should clear pending anchor when missing-target execution plan is clear'
  );

  assert.deepStrictEqual(
    branchScrollCalls,
    [
      {
        index: 8,
        animated: false,
        viewPosition: 0,
        viewOffset: 11,
      },
    ],
    'Anchor failure runtime branch helper should invoke missing-target fallback scroll payload when selected'
  );

  assert.strictEqual(
    applyChatPrependAnchorFailureBranchExecution({
      branchKind: 'scroll-failed',
      failureExecutionPlans: {
        missingTargetExecutionPlan: {
          shouldClearAnchor: true,
          clearFallbackScrollPayload: null,
          retryNextAnchor: null,
          retryDelayMs: 0,
        },
        scrollFailedExecutionPlan: {
          shouldClearAnchor: false,
          clearFallbackScrollPayload: null,
          retryNextAnchor: {
            id: 'm-1',
            offset: 11,
            attempts: 2,
          },
          retryDelayMs: 50,
        },
      },
      pendingPrependAnchorRef: branchAnchorRef,
      list: null,
      scheduleRetry: () => {
        branchRetryInvocations += 1;
      },
      scheduleTimeout: (callback, delayMs) => {
        branchRetryDelays.push(delayMs);
        callback();
      },
    }),
    false,
    'Anchor failure runtime branch helper should apply scroll-failed execution plan when scroll-failed branch is selected'
  );

  assert.deepStrictEqual(
    branchAnchorRef.current,
    {
      id: 'm-1',
      offset: 11,
      attempts: 2,
    },
    'Anchor failure runtime branch helper should update pending anchor from selected scroll-failed retry execution plan'
  );

  assert.deepStrictEqual(
    branchRetryDelays,
    [50],
    'Anchor failure runtime branch helper should forward selected scroll-failed retry delay to injected scheduler'
  );

  assert.strictEqual(
    branchRetryInvocations,
    1,
    'Anchor failure runtime branch helper should invoke retry callback for selected scroll-failed retry execution plan'
  );

  // Test unified restore with fallback
  const restoreAnchorRef = { current: { id: 'm-1', offset: 11, attempts: 0 } };
  let restoreScrollCalls = 0;
  let restoreFallbackApplied = false;

  applyChatPrependAnchorRestoreWithFallback({
    scrollAction: () => {
      restoreScrollCalls += 1;
    },
    failureExecutionPlan: {
      shouldClearAnchor: true,
      clearFallbackScrollPayload: null,
      retryNextAnchor: null,
      retryDelayMs: 0,
    },
    pendingPrependAnchorRef: restoreAnchorRef,
    list: null,
    scheduleRetry: () => {
      restoreFallbackApplied = true;
    },
  });

  assert.strictEqual(restoreScrollCalls, 1, 'Unified restore helper should invoke scroll action on success path');
  assert.strictEqual(restoreAnchorRef.current, null, 'Unified restore helper should clear pending anchor on scroll success');
  assert.strictEqual(restoreFallbackApplied, false, 'Unified restore helper should not apply fallback when scroll succeeds');

  // Test unified restore with scroll failure
  const restoreFailAnchorRef = { current: { id: 'm-2', offset: 22, attempts: 0 } };
  let restoreFailScrollCalls = 0;
  let restoreFailFallbackCalls = 0;

  applyChatPrependAnchorRestoreWithFallback({
    scrollAction: () => {
      restoreFailScrollCalls += 1;
      throw new Error('Scroll failed');
    },
    failureExecutionPlan: {
      shouldClearAnchor: false,
      clearFallbackScrollPayload: null,
      retryNextAnchor: { id: 'm-2', offset: 22, attempts: 1 },
      retryDelayMs: 50,
    },
    pendingPrependAnchorRef: restoreFailAnchorRef,
    list: null,
    scheduleRetry: () => {
      restoreFailFallbackCalls += 1;
    },
    scheduleTimeout: (callback, delayMs) => {
      callback();
    },
  });

  assert.strictEqual(restoreFailScrollCalls, 1, 'Unified restore helper should attempt scroll action even when it fails');
  assert.deepStrictEqual(restoreFailAnchorRef.current, { id: 'm-2', offset: 22, attempts: 1 }, 'Unified restore helper should apply failure plan on catch, scheduling retry');
  assert.strictEqual(restoreFailFallbackCalls, 1, 'Unified restore helper should invoke scheduleRetry when failure plan has retry scheduled');

  logger.debug('✓ testChatAnchorFailureExecutionRuntimeHelper passed');
})();

(function testChatScrollInteractionStateHelper() {
  assert.deepStrictEqual(
    resolveChatScrollInteractionPlan({
      isInitialAnchorSettled: true,
      isAutoScrolling: false,
      isDragging: true,
      isCurrentlyScrolling: false,
      scrollY: 25,
      stickyDateVisible: true,
    }),
    {
      shouldMarkUserInteracted: true,
      shouldAllowTopAutoPagination: true,
      shouldStopAnchorStabilization: true,
      shouldSetScrollingTrue: true,
      shouldHideStickyDateImmediate: true,
      shouldHideStickyDateOnIdle: false,
      shouldExitEarly: true,
      idleHideDelayMs: 200,
    },
    'Scroll-interaction helper should mark user takeover and shallow-scroll early exit behaviors'
  );

  assert.deepStrictEqual(
    resolveChatScrollInteractionPlan({
      isInitialAnchorSettled: true,
      isAutoScrolling: true,
      isDragging: true,
      isCurrentlyScrolling: true,
      scrollY: 120,
      stickyDateVisible: true,
    }),
    {
      shouldMarkUserInteracted: false,
      shouldAllowTopAutoPagination: false,
      shouldStopAnchorStabilization: false,
      shouldSetScrollingTrue: false,
      shouldHideStickyDateImmediate: false,
      shouldHideStickyDateOnIdle: true,
      shouldExitEarly: false,
      idleHideDelayMs: 1500,
    },
    'Scroll-interaction helper should avoid user takeover while auto-scroll is active and keep normal idle hide behavior'
  );

  logger.debug('✓ testChatScrollInteractionStateHelper passed');
})();

(function testChatStickyDateScrollStateHelper() {
  const scrollPlan = resolveChatStickyDateScrollPlan({
    topVisibleMessageId: ' msg-2 ',
    previousSourceMessageId: 'msg-1',
    currentStickyDateText: 'Today',
    currentStickyDateVisible: false,
    dateLabelById: new Map([
      ['msg-1', 'Today'],
      ['msg-2', 'Yesterday'],
    ]),
  });

  assert.deepStrictEqual(
    scrollPlan,
    {
      shouldSetSourceMessageId: true,
      nextSourceMessageId: 'msg-2',
      shouldClearSourceMessageId: false,
      shouldSetStickyDateText: true,
      nextStickyDateText: 'Yesterday',
      shouldSetStickyDateVisible: true,
      nextStickyDateVisible: true,
    },
    'Sticky-date scroll helper should derive source + text + visibility updates from top visible message labels'
  );

  const reusePlan = resolveChatStickyDateScrollPlan({
    topVisibleMessageId: 'msg-2',
    previousSourceMessageId: 'msg-2',
    currentStickyDateText: 'Yesterday',
    currentStickyDateVisible: true,
    dateLabelById: new Map(),
  });

  assert.strictEqual(
    reusePlan.shouldSetStickyDateText,
    false,
    'Sticky-date scroll helper should avoid text updates when sticky date is reused'
  );
  assert.strictEqual(
    reusePlan.shouldSetStickyDateVisible,
    false,
    'Sticky-date scroll helper should avoid visibility updates when sticky date visibility is unchanged'
  );

  const clearPlan = resolveChatStickyDateScrollPlan({
    topVisibleMessageId: null,
    previousSourceMessageId: 'msg-2',
    currentStickyDateText: 'Yesterday',
    currentStickyDateVisible: true,
    dateLabelById: new Map(),
  });
  assert.strictEqual(
    clearPlan.shouldClearSourceMessageId,
    true,
    'Sticky-date scroll helper should clear source id when no top-visible message id is available'
  );

  assert.deepStrictEqual(
    resolveChatStickyDateIdleHidePlan({
      shouldHideStickyDateOnIdle: true,
      currentStickyDateVisible: true,
    }),
    {
      shouldHideStickyDate: true,
    },
    'Sticky-date idle hide helper should request hide when enabled and sticky date is visible'
  );

  assert.deepStrictEqual(
    resolveChatStickyDateIdleHidePlan({
      shouldHideStickyDateOnIdle: false,
      currentStickyDateVisible: true,
    }),
    {
      shouldHideStickyDate: false,
    },
    'Sticky-date idle hide helper should no-op when idle hide behavior is disabled'
  );

  logger.debug('✓ testChatStickyDateScrollStateHelper passed');
})();

(function testChatStickyDateStateHelper() {
  const reusePlan = resolveChatStickyDateSourcePlan({
    topVisibleMessageId: ' msg-1 ',
    previousSourceMessageId: 'msg-1',
    currentStickyDateText: 'Today',
  });
  assert.deepStrictEqual(
    reusePlan,
    {
      normalizedTopMessageId: 'msg-1',
      shouldReuseCurrentStickyDate: true,
      shouldResolveTopMessageDate: false,
      shouldClearSourceMessageId: false,
    },
    'Sticky-date source helper should reuse current sticky date when top message source is unchanged and text is already available'
  );

  const resolvePlan = resolveChatStickyDateSourcePlan({
    topVisibleMessageId: 'msg-2',
    previousSourceMessageId: 'msg-1',
    currentStickyDateText: 'Today',
  });
  assert.deepStrictEqual(
    resolvePlan,
    {
      normalizedTopMessageId: 'msg-2',
      shouldReuseCurrentStickyDate: false,
      shouldResolveTopMessageDate: true,
      shouldClearSourceMessageId: false,
    },
    'Sticky-date source helper should request date resolution when top message source changes'
  );

  const clearPlan = resolveChatStickyDateSourcePlan({
    topVisibleMessageId: '   ',
    previousSourceMessageId: 'msg-2',
    currentStickyDateText: 'Today',
  });
  assert.deepStrictEqual(
    clearPlan,
    {
      normalizedTopMessageId: null,
      shouldReuseCurrentStickyDate: false,
      shouldResolveTopMessageDate: false,
      shouldClearSourceMessageId: true,
    },
    'Sticky-date source helper should clear source id state when top-visible message id is unavailable'
  );

  const showPlan = resolveChatStickyDateVisibilityPlan({
    nextDateText: 'Yesterday',
    currentStickyDateText: 'Today',
    currentStickyDateVisible: false,
  });
  assert.deepStrictEqual(
    showPlan,
    {
      shouldSetStickyDateText: true,
      nextStickyDateText: 'Yesterday',
      shouldSetStickyDateVisible: true,
      nextStickyDateVisible: true,
    },
    'Sticky-date visibility helper should request text and visibility updates when a new date label becomes available'
  );

  const hidePlan = resolveChatStickyDateVisibilityPlan({
    nextDateText: '',
    currentStickyDateText: 'Yesterday',
    currentStickyDateVisible: true,
  });
  assert.deepStrictEqual(
    hidePlan,
    {
      shouldSetStickyDateText: false,
      nextStickyDateText: 'Yesterday',
      shouldSetStickyDateVisible: true,
      nextStickyDateVisible: false,
    },
    'Sticky-date visibility helper should hide the label without mutating cached text when no date is available'
  );

  logger.debug('✓ testChatStickyDateStateHelper passed');
})();

(function testChatHandlerCacheHelper() {
  const keyMap = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  const keyRemovedCount = pruneMapByKeySet(keyMap, new Set(['b', 'c', 'd']));
  assert.strictEqual(
    keyRemovedCount,
    1,
    'Handler-cache key-set prune helper should report number of removed keys'
  );
  assert.deepStrictEqual(
    Array.from(keyMap.keys()),
    ['b', 'c'],
    'Handler-cache key-set prune helper should keep only active keys'
  );

  const numericMap = new Map([
    [-1, 'x'],
    [0, 'a'],
    [1, 'b'],
    [3, 'c'],
  ]);
  const numericRemovedCount = pruneMapByNumericRange(numericMap, 3);
  assert.strictEqual(
    numericRemovedCount,
    2,
    'Handler-cache numeric-range prune helper should drop out-of-range numeric keys'
  );
  assert.deepStrictEqual(
    Array.from(numericMap.keys()),
    [0, 1],
    'Handler-cache numeric-range prune helper should keep only keys within [minInclusive, maxExclusive)'
  );

  const delimitedMap = new Map([
    ['msg-1::heart', true],
    ['msg-2::laugh', true],
    ['msg-3::download::file.pdf', true],
  ]);
  const delimitedRemovedCount = pruneDelimitedMapByPrefixSet(
    delimitedMap,
    new Set(['msg-1', 'msg-3']),
    '::'
  );
  assert.strictEqual(
    delimitedRemovedCount,
    1,
    'Handler-cache delimited-prefix prune helper should drop entries whose base key is inactive'
  );
  assert.deepStrictEqual(
    Array.from(delimitedMap.keys()),
    ['msg-1::heart', 'msg-3::download::file.pdf'],
    'Handler-cache delimited-prefix prune helper should preserve entries whose prefixes are active'
  );

  const cacheMap = new Map();
  let createCount = 0;
  const firstCached = resolveMapCacheEntry(cacheMap, 'k1', () => {
    createCount += 1;
    return { value: 1 };
  });
  const secondCached = resolveMapCacheEntry(cacheMap, 'k1', () => {
    createCount += 1;
    return { value: 2 };
  });
  assert.strictEqual(
    createCount,
    1,
    'Handler-cache map-entry helper should create value only once for existing keys'
  );
  assert.strictEqual(
    firstCached,
    secondCached,
    'Handler-cache map-entry helper should return the cached value on repeated access'
  );

  const undefinedMap = new Map([['u1', undefined]]);
  let undefinedCreateCount = 0;
  const undefinedCached = resolveMapCacheEntry(undefinedMap, 'u1', () => {
    undefinedCreateCount += 1;
    return 'new-value';
  });
  assert.strictEqual(
    undefinedCreateCount,
    0,
    'Handler-cache map-entry helper should treat existing undefined values as cached entries'
  );
  assert.strictEqual(
    undefinedCached,
    undefined,
    'Handler-cache map-entry helper should return existing undefined cached value'
  );

  const attachmentBaseKeys = resolveChatAttachmentBaseKeySet(
    [
      { url: 'a', resolvedUrl: '', fileName: '1' },
      { url: 'b', resolvedUrl: 'br', fileName: '2' },
      { url: '', resolvedUrl: '', fileName: '' },
    ],
    (attachment) => {
      if (!attachment.url) {
        return '';
      }
      return `${attachment.url || ''}::${attachment.resolvedUrl || ''}::${attachment.fileName || ''}`;
    }
  );
  assert.strictEqual(
    attachmentBaseKeys.size,
    2,
    'Handler-cache attachment base-key helper should dedupe non-empty keys'
  );
  assert.strictEqual(
    attachmentBaseKeys.has('a::::1'),
    true,
    'Handler-cache attachment base-key helper should include first attachment key'
  );
  assert.strictEqual(
    attachmentBaseKeys.has('b::br::2'),
    true,
    'Handler-cache attachment base-key helper should include second attachment key'
  );

  logger.debug('✓ testChatHandlerCacheHelper passed');
})();

(function testChatPendingRenderStateHelper() {
  const sendingState = resolveChatPendingStatusDisplayState({
    status: 'sending',
    isOffline: false,
  });
  assert.deepStrictEqual(
    sendingState,
    {
      effectiveStatus: 'sending',
      statusLabel: 'Sending...',
      canRetry: false,
    },
    'Pending render helper should resolve sending state without retry action'
  );

  const retryingState = resolveChatPendingStatusDisplayState({
    status: 'failed',
    isOffline: false,
    isRetrying: true,
  });
  assert.deepStrictEqual(
    retryingState,
    {
      effectiveStatus: 'sending',
      statusLabel: 'Retrying...',
      canRetry: false,
    },
    'Pending render helper should map retrying items to a sending state with retrying label'
  );

  const queuedOfflineState = resolveChatPendingStatusDisplayState({
    status: 'queued',
    isOffline: true,
  });
  assert.deepStrictEqual(
    queuedOfflineState,
    {
      effectiveStatus: 'queued',
      statusLabel: 'Queued',
      canRetry: false,
    },
    'Pending render helper should suppress queued retry action while offline'
  );

  const unknownState = resolveChatPendingStatusDisplayState({
    status: 'unexpected',
    isOffline: false,
  });
  assert.deepStrictEqual(
    unknownState,
    {
      effectiveStatus: 'queued',
      statusLabel: 'Queued',
      canRetry: true,
    },
    'Pending render helper should normalize unknown statuses to queued'
  );

  const noReplyPreviewState = resolveChatPendingReplyPreviewState({
    replyTo: null,
    maxLength: 120,
    resolvePreviewText: resolveChatReplyPreviewText,
  });
  assert.deepStrictEqual(
    noReplyPreviewState,
    {
      previewText: '',
      shouldShowPreview: false,
    },
    'Pending render helper should hide reply preview when reply context is absent'
  );

  const textReplyPreviewState = resolveChatPendingReplyPreviewState({
    replyTo: {
      messageId: 'msg-1',
      sender: 'teacher@example.com',
      text: 'See you at 4pm',
    },
    maxLength: 120,
    resolvePreviewText: resolveChatReplyPreviewText,
  });
  assert.strictEqual(
    textReplyPreviewState.previewText,
    'See you at 4pm',
    'Pending render helper should preserve plain reply preview text'
  );
  assert.strictEqual(
    textReplyPreviewState.shouldShowPreview,
    true,
    'Pending render helper should surface plain text replies as previewable'
  );

  const attachmentReplyPreviewState = resolveChatPendingReplyPreviewState({
    replyTo: {
      messageId: 'msg-2',
      sender: 'teacher@example.com',
      hasAttachments: true,
      attachmentCount: 2,
    },
    maxLength: 120,
    resolvePreviewText: resolveChatReplyPreviewText,
  });
  assert.strictEqual(
    attachmentReplyPreviewState.shouldShowPreview,
    true,
    'Pending render helper should surface attachment-only replies as previewable'
  );
  assert.ok(
    attachmentReplyPreviewState.previewText.length > 0,
    'Pending render helper should produce non-empty text for attachment-only replies'
  );

  logger.debug('✓ testChatPendingRenderStateHelper passed');
})();

(function testChatPendingConversationDerivedHelper() {
  const derived = resolveChatPendingConversationDerivedState({
    selectedRecipientId: 'recipient-1',
    pendingMessages: new Map([
      ['text-1', { recipientId: 'recipient-1', status: 'queued' }],
      ['text-2', { recipientId: 'recipient-1', status: 'sent' }],
      ['text-3', { recipientId: 'recipient-2', status: 'failed' }],
    ]),
    pendingMedia: new Map([
      ['media-1', { recipientId: 'recipient-1', status: 'failed' }],
      ['media-2', { recipientId: 'recipient-1', status: 'sent' }],
      ['media-3', { recipientId: 'recipient-2', status: 'queued' }],
    ]),
    pendingAttachments: new Map([
      ['attachment-1', { recipientId: 'recipient-1', status: 'failed' }],
      ['attachment-2', { recipientId: 'recipient-1', status: 'finalizing' }],
      ['attachment-3', { recipientId: 'recipient-2', status: 'failed' }],
    ]),
    resolvePendingMessageStatus: (pendingMessage) => pendingMessage.status,
  });

  assert.deepStrictEqual(
    derived.messageEntries.map(([id]) => id),
    ['text-1', 'text-2'],
    'Pending conversation helper should only include text entries for selected recipient'
  );
  assert.deepStrictEqual(
    derived.mediaEntries.map(([id]) => id),
    ['media-1', 'media-2'],
    'Pending conversation helper should only include media entries for selected recipient'
  );
  assert.deepStrictEqual(
    derived.attachmentEntries.map(([id]) => id),
    ['attachment-1', 'attachment-2'],
    'Pending conversation helper should only include attachment entries for selected recipient'
  );
  assert.deepStrictEqual(
    derived.retryableTextIds,
    ['text-1'],
    'Pending conversation helper should classify only queued/failed text entries as retryable'
  );
  assert.deepStrictEqual(
    derived.retryableMediaIds,
    ['media-1'],
    'Pending conversation helper should classify only queued/failed media entries as retryable'
  );
  assert.deepStrictEqual(
    derived.retryableAttachmentIds,
    ['attachment-1'],
    'Pending conversation helper should classify only failed attachment entries as retryable'
  );
  assert.strictEqual(
    derived.retryAllCount,
    3,
    'Pending conversation helper should expose combined retry target count'
  );

  const emptyDerived = resolveChatPendingConversationDerivedState({
    selectedRecipientId: '',
    pendingMessages: new Map([['text-1', { recipientId: 'recipient-1', status: 'queued' }]]),
    pendingMedia: new Map([['media-1', { recipientId: 'recipient-1', status: 'failed' }]]),
    pendingAttachments: new Map([
      ['attachment-1', { recipientId: 'recipient-1', status: 'failed' }],
    ]),
    resolvePendingMessageStatus: (pendingMessage) => pendingMessage.status,
  });

  assert.deepStrictEqual(
    emptyDerived,
    {
      mediaEntries: [],
      messageEntries: [],
      attachmentEntries: [],
      retryableTextIds: [],
      retryableMediaIds: [],
      retryableAttachmentIds: [],
      retryAllCount: 0,
    },
    'Pending conversation helper should return empty derived state when no selected recipient exists'
  );

  logger.debug('✓ testChatPendingConversationDerivedHelper passed');
})();

(function testChatPendingReconciliationStateHelper() {
  const deliveredMessageIds = new Set(['srv-1', 'srv-2', 'srv-4']);
  const normalizeMessageId = (value) => {
    if (typeof value !== 'string') {
      return '';
    }

    return value.trim();
  };

  const textResolvedIds = resolveChatPendingTextMessageReconciledIds({
    pendingMessages: new Map([
      ['text-1', { status: 'sending', serverMessageId: 'srv-1' }],
      ['text-2', { status: 'sent', serverMessageId: ' srv-2 ' }],
      ['text-3', { status: 'failed', serverMessageId: 'srv-1' }],
      ['text-4', { status: 'queued', serverMessageId: 'srv-4' }],
      ['text-5', { status: 'sent', serverMessageId: 'srv-missing' }],
    ]),
    deliveredMessageIds,
    normalizeMessageId,
    resolvePendingMessageStatus: (pendingMessage) => pendingMessage.status,
  });
  assert.deepStrictEqual(
    textResolvedIds,
    ['text-1', 'text-2'],
    'Pending reconciliation helper should resolve only sending/sent text entries with delivered server ids'
  );

  const mediaResolvedIds = resolveChatPendingMediaMessageReconciledIds({
    pendingMedia: new Map([
      ['media-1', { status: 'sent', serverMessageId: 'srv-2' }],
      ['media-2', { status: 'failed', serverMessageId: 'srv-1' }],
      ['media-3', { status: 'sent', serverMessageId: 'srv-missing' }],
    ]),
    deliveredMessageIds,
    normalizeMessageId,
  });
  assert.deepStrictEqual(
    mediaResolvedIds,
    ['media-1'],
    'Pending reconciliation helper should resolve only sent media entries with delivered server ids'
  );

  const attachmentResolvedIds = resolveChatPendingAttachmentMessageReconciledIds({
    pendingAttachments: new Map([
      ['attachment-1', { status: 'finalizing', serverMessageId: 'srv-1' }],
      ['attachment-2', { status: 'sent', serverMessageId: 'srv-4' }],
      ['attachment-3', { status: 'failed', serverMessageId: 'srv-2' }],
      ['attachment-4', { status: 'sent', serverMessageId: 'srv-missing' }],
    ]),
    deliveredMessageIds,
    normalizeMessageId,
  });
  assert.deepStrictEqual(
    attachmentResolvedIds,
    ['attachment-1', 'attachment-2'],
    'Pending reconciliation helper should resolve only finalizing/sent attachment entries with delivered server ids'
  );

  logger.debug('✓ testChatPendingReconciliationStateHelper passed');
})();

(function testChatPendingVisibilityStateHelper() {
  const normalizeMessageId = (value) => {
    if (typeof value !== 'string') {
      return '';
    }

    return value.trim();
  };

  const deliveredMessageIds = new Set(['srv-1', 'srv-2']);

  const mediaVisibleState = resolveChatPendingServerMatchVisibility({
    selectedRecipientId: 'recipient-1',
    itemRecipientId: 'recipient-1',
    serverMessageId: 'srv-pending',
    deliveredMessageIds,
    normalizeMessageId,
  });
  assert.deepStrictEqual(
    mediaVisibleState,
    {
      shouldRender: true,
      shouldHideAsDelivered: false,
      normalizedServerMessageId: 'srv-pending',
    },
    'Pending visibility helper should keep rendering when server id is not yet delivered'
  );

  const mediaHiddenState = resolveChatPendingServerMatchVisibility({
    selectedRecipientId: 'recipient-1',
    itemRecipientId: 'recipient-1',
    serverMessageId: ' srv-1 ',
    deliveredMessageIds,
    normalizeMessageId,
  });
  assert.deepStrictEqual(
    mediaHiddenState,
    {
      shouldRender: false,
      shouldHideAsDelivered: true,
      normalizedServerMessageId: 'srv-1',
    },
    'Pending visibility helper should hide delivered pending media/attachment rows'
  );

  const recipientMismatchState = resolveChatPendingServerMatchVisibility({
    selectedRecipientId: 'recipient-1',
    itemRecipientId: 'recipient-2',
    serverMessageId: 'srv-2',
    deliveredMessageIds,
    normalizeMessageId,
  });
  assert.deepStrictEqual(
    recipientMismatchState,
    {
      shouldRender: false,
      shouldHideAsDelivered: false,
      normalizedServerMessageId: '',
    },
    'Pending visibility helper should hide rows that do not belong to selected recipient'
  );

  let fallbackCalls = 0;
  const textVisibleWithFallback = resolveChatPendingTextVisibilityState({
    selectedRecipientId: 'recipient-1',
    itemRecipientId: 'recipient-1',
    status: 'sending',
    serverMessageId: '',
    deliveredMessageIds,
    normalizeMessageId,
    resolveFallbackServerMessageId: () => {
      fallbackCalls += 1;
      return 'srv-2';
    },
  });
  assert.strictEqual(
    fallbackCalls,
    1,
    'Pending text visibility helper should use fallback server id resolution when needed'
  );
  assert.deepStrictEqual(
    textVisibleWithFallback,
    {
      shouldRender: false,
      shouldHideAsDelivered: true,
      normalizedServerMessageId: 'srv-2',
      canUseDeliveredHideRule: true,
    },
    'Pending text visibility helper should hide sending/sent text rows once fallback server id is delivered'
  );

  const textQueuedState = resolveChatPendingTextVisibilityState({
    selectedRecipientId: 'recipient-1',
    itemRecipientId: 'recipient-1',
    status: 'queued',
    serverMessageId: 'srv-1',
    deliveredMessageIds,
    normalizeMessageId,
    resolveFallbackServerMessageId: () => 'srv-2',
  });
  assert.deepStrictEqual(
    textQueuedState,
    {
      shouldRender: true,
      shouldHideAsDelivered: false,
      normalizedServerMessageId: 'srv-1',
      canUseDeliveredHideRule: false,
    },
    'Pending text visibility helper should not hide queued/failed rows even if server ids appear delivered'
  );

  logger.debug('✓ testChatPendingVisibilityStateHelper passed');
})();

(function testChatPendingRetrySummaryStateHelper() {
  const successCount = resolveChatPendingRetrySuccessCount([
    { status: 'fulfilled', value: true },
    { status: 'fulfilled', value: false },
    { status: 'rejected', reason: new Error('failed') },
    { status: 'fulfilled', value: true },
  ]);
  assert.strictEqual(
    successCount,
    2,
    'Pending retry summary helper should count only fulfilled true retry results as success'
  );

  const allSuccessToast = resolveChatPendingRetrySummaryToastPayload({
    successCount: 3,
    totalCount: 3,
  });
  assert.deepStrictEqual(
    allSuccessToast,
    {
      type: 'success',
      text1: 'Retry Complete',
      text2: 'All pending items were sent.',
      position: 'top',
    },
    'Pending retry summary helper should return success toast payload when all retries succeed'
  );

  const partialSuccessToast = resolveChatPendingRetrySummaryToastPayload({
    successCount: 2,
    totalCount: 5,
  });
  assert.deepStrictEqual(
    partialSuccessToast,
    {
      type: 'info',
      text1: 'Partial Retry Success',
      text2: '2 of 5 pending items were sent.',
      position: 'top',
    },
    'Pending retry summary helper should return partial-success payload when only some retries succeed'
  );

  const noSuccessToast = resolveChatPendingRetrySummaryToastPayload({
    successCount: 0,
    totalCount: 4,
  });
  assert.deepStrictEqual(
    noSuccessToast,
    {
      type: 'error',
      text1: 'Retry Failed',
      text2: 'Could not resend pending items. Please try again.',
      position: 'top',
    },
    'Pending retry summary helper should return error payload when no retries succeed'
  );

  logger.debug('✓ testChatPendingRetrySummaryStateHelper passed');
})();

(function testChatPendingRetryOutcomeStateHelper() {
  const allSuccessSummary = resolveChatPendingRetryOutcomeSummary(
    [
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: true },
    ],
    3
  );
  assert.deepStrictEqual(
    allSuccessSummary,
    {
      attemptedCount: 3,
      successCount: 3,
      failedCount: 0,
      successRatio: 1,
      toastPayload: {
        type: 'success',
        text1: 'Retry Complete',
        text2: 'All pending items were sent.',
        position: 'top',
      },
    },
    'Pending retry outcome helper should compute full-success summary and payload'
  );

  const partialSummary = resolveChatPendingRetryOutcomeSummary(
    [
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: false },
      { status: 'rejected', reason: new Error('failed') },
      { status: 'fulfilled', value: true },
    ],
    5
  );
  assert.deepStrictEqual(
    partialSummary,
    {
      attemptedCount: 5,
      successCount: 2,
      failedCount: 3,
      successRatio: 0.4,
      toastPayload: {
        type: 'info',
        text1: 'Partial Retry Success',
        text2: '2 of 5 pending items were sent.',
        position: 'top',
      },
    },
    'Pending retry outcome helper should compute partial-success summary fields and payload'
  );

  const failedSummary = resolveChatPendingRetryOutcomeSummary(
    [
      { status: 'fulfilled', value: false },
      { status: 'rejected', reason: new Error('failed') },
    ],
    2
  );
  assert.deepStrictEqual(
    failedSummary,
    {
      attemptedCount: 2,
      successCount: 0,
      failedCount: 2,
      successRatio: 0,
      toastPayload: {
        type: 'error',
        text1: 'Retry Failed',
        text2: 'Could not resend pending items. Please try again.',
        position: 'top',
      },
    },
    'Pending retry outcome helper should compute failed summary fields and payload when no retries succeed'
  );

  logger.debug('✓ testChatPendingRetryOutcomeStateHelper passed');
})();

(function testChatPendingRetryEligibilityStateHelper() {
  const missingRecipientGuard = resolveChatPendingRetryAllGuard({
    selectedRecipientId: '',
    isOffline: false,
    totalCount: 3,
    isRetryingAllPending: false,
  });
  assert.deepStrictEqual(
    missingRecipientGuard,
    { shouldRun: false },
    'Pending retry eligibility helper should block retry-all when no recipient is selected'
  );

  const offlineGuard = resolveChatPendingRetryAllGuard({
    selectedRecipientId: 'recipient-1',
    isOffline: true,
    totalCount: 3,
    isRetryingAllPending: false,
  });
  assert.deepStrictEqual(
    offlineGuard,
    {
      shouldRun: false,
      toastPayload: {
        type: 'info',
        text1: 'Offline',
        text2: 'Reconnect to retry pending messages.',
        position: 'top',
      },
    },
    'Pending retry eligibility helper should return offline toast payload when retry-all is blocked offline'
  );

  const emptyTotalGuard = resolveChatPendingRetryAllGuard({
    selectedRecipientId: 'recipient-1',
    isOffline: false,
    totalCount: 0,
    isRetryingAllPending: false,
  });
  assert.deepStrictEqual(
    emptyTotalGuard,
    { shouldRun: false },
    'Pending retry eligibility helper should block retry-all when no retry targets exist'
  );

  const alreadyRetryingGuard = resolveChatPendingRetryAllGuard({
    selectedRecipientId: 'recipient-1',
    isOffline: false,
    totalCount: 4,
    isRetryingAllPending: true,
  });
  assert.deepStrictEqual(
    alreadyRetryingGuard,
    { shouldRun: false },
    'Pending retry eligibility helper should block duplicate retry-all runs while one is active'
  );

  const runnableGuard = resolveChatPendingRetryAllGuard({
    selectedRecipientId: 'recipient-1',
    isOffline: false,
    totalCount: 4,
    isRetryingAllPending: false,
  });
  assert.deepStrictEqual(
    runnableGuard,
    { shouldRun: true },
    'Pending retry eligibility helper should allow retry-all when all guard conditions pass'
  );

  logger.debug('✓ testChatPendingRetryEligibilityStateHelper passed');
})();

(function testChatPendingRetryBatchStateHelper() {
  const batchPlan = resolveChatPendingRetryBatchPlan({
    retryableTextIds: [' text-1 ', '', 'text-2'],
    retryableMediaIds: ['media-1'],
    retryableAttachmentIds: ['attachment-1', '  ', 'attachment-2'],
  });

  assert.strictEqual(
    batchPlan.totalCount,
    5,
    'Pending retry batch helper should report total count after filtering invalid ids'
  );
  assert.deepStrictEqual(
    batchPlan.orderedTargets,
    [
      { kind: 'text', tempId: 'text-1' },
      { kind: 'text', tempId: 'text-2' },
      { kind: 'media', tempId: 'media-1' },
      { kind: 'attachment', tempId: 'attachment-1' },
      { kind: 'attachment', tempId: 'attachment-2' },
    ],
    'Pending retry batch helper should preserve text->media->attachment order for retry orchestration'
  );

  const emptyBatchPlan = resolveChatPendingRetryBatchPlan({
    retryableTextIds: [],
    retryableMediaIds: [],
    retryableAttachmentIds: [],
  });
  assert.deepStrictEqual(
    emptyBatchPlan,
    {
      totalCount: 0,
      orderedTargets: [],
    },
    'Pending retry batch helper should return empty plan when there are no retryable ids'
  );

  logger.debug('✓ testChatPendingRetryBatchStateHelper passed');
})();

(async function testChatPendingRetryDispatchStateHelper() {
  const dispatchOrder = [];
  const retryPromises = resolveChatPendingRetryDispatchPromises({
    orderedTargets: [
      { kind: 'text', tempId: ' text-1 ' },
      { kind: 'media', tempId: 'media-1' },
      { kind: 'attachment', tempId: 'attachment-1' },
      { kind: 'text', tempId: '' },
    ],
    handlers: {
      text: async (tempId) => {
        dispatchOrder.push(`text:${tempId}`);
        return true;
      },
      media: async (tempId) => {
        dispatchOrder.push(`media:${tempId}`);
        return false;
      },
      attachment: async (tempId) => {
        dispatchOrder.push(`attachment:${tempId}`);
        return true;
      },
    },
  });

  assert.strictEqual(
    retryPromises.length,
    3,
    'Pending retry dispatch helper should skip invalid target ids and dispatch remaining targets'
  );

  const settledResults = await Promise.allSettled(retryPromises);
  assert.deepStrictEqual(
    dispatchOrder,
    ['text:text-1', 'media:media-1', 'attachment:attachment-1'],
    'Pending retry dispatch helper should preserve batch target order when invoking handlers'
  );
  assert.deepStrictEqual(
    settledResults.map((entry) => (entry.status === 'fulfilled' ? entry.value : false)),
    [true, false, true],
    'Pending retry dispatch helper should return handler promises without mutating fulfillment values'
  );

  const emptyPromises = resolveChatPendingRetryDispatchPromises({
    orderedTargets: [],
    handlers: {
      text: async () => true,
      media: async () => true,
      attachment: async () => true,
    },
  });
  assert.deepStrictEqual(
    emptyPromises,
    [],
    'Pending retry dispatch helper should return empty list when no ordered targets are provided'
  );

  logger.debug('✓ testChatPendingRetryDispatchStateHelper passed');
})();

(function testChatPendingAutoRetryStateHelper() {
  const offlinePlan = resolveChatPendingAutoRetryPlan({
    isOffline: true,
    pendingMessageCount: 3,
  });
  assert.deepStrictEqual(
    offlinePlan,
    {
      shouldSchedule: false,
      delayMs: 0,
    },
    'Pending auto-retry helper should not schedule while offline'
  );

  const emptyPlan = resolveChatPendingAutoRetryPlan({
    isOffline: false,
    pendingMessageCount: 0,
  });
  assert.deepStrictEqual(
    emptyPlan,
    {
      shouldSchedule: false,
      delayMs: 0,
    },
    'Pending auto-retry helper should not schedule when there are no pending messages'
  );

  const runnablePlan = resolveChatPendingAutoRetryPlan({
    isOffline: false,
    pendingMessageCount: 2,
    defaultDelayMs: 900,
  });
  assert.deepStrictEqual(
    runnablePlan,
    {
      shouldSchedule: true,
      delayMs: 900,
    },
    'Pending auto-retry helper should schedule with configured delay when reconnecting with pending messages'
  );

  const fallbackDelayPlan = resolveChatPendingAutoRetryPlan({
    isOffline: false,
    pendingMessageCount: 1,
    defaultDelayMs: -5,
  });
  assert.deepStrictEqual(
    fallbackDelayPlan,
    {
      shouldSchedule: true,
      delayMs: 1000,
    },
    'Pending auto-retry helper should normalize invalid delays to default fallback'
  );

  logger.debug('✓ testChatPendingAutoRetryStateHelper passed');
})();

(async function testChatReplyJumpHelper() {
  const immediateResult = await executeChatReplyJump({
    targetMessageId: 'msg-1',
    tryScrollToMessage: (_id, animated) => animated === true,
    canLoadMoreHistory: () => true,
    loadOlderMessages: () => {},
  });
  assert.deepStrictEqual(
    immediateResult,
    { success: true, usedHistoryLoads: 0, reason: 'found' },
    'Reply jump helper should succeed immediately when target is already loaded'
  );

  let historyLoadCount = 0;
  let missesBeforeHit = 2;
  const delayedResult = await executeChatReplyJump({
    targetMessageId: 'msg-2',
    tryScrollToMessage: () => {
      if (missesBeforeHit > 0) {
        missesBeforeHit -= 1;
        return false;
      }
      return true;
    },
    canLoadMoreHistory: () => true,
    loadOlderMessages: async () => {
      historyLoadCount += 1;
    },
    maxLoadAttempts: 4,
  });
  assert.deepStrictEqual(
    delayedResult,
    { success: true, usedHistoryLoads: 2, reason: 'found' },
    'Reply jump helper should load older pages until the target can be scrolled into view'
  );
  assert.strictEqual(historyLoadCount, 2, 'Reply jump helper should only load as many pages as needed');

  let exhaustedLoadCount = 0;
  const exhaustedResult = await executeChatReplyJump({
    targetMessageId: 'msg-3',
    tryScrollToMessage: () => false,
    canLoadMoreHistory: () => exhaustedLoadCount < 2,
    loadOlderMessages: async () => {
      exhaustedLoadCount += 1;
    },
    maxLoadAttempts: 5,
  });
  assert.deepStrictEqual(
    exhaustedResult,
    { success: false, usedHistoryLoads: 2, reason: 'not-found' },
    'Reply jump helper should stop once history is exhausted even before max attempts'
  );

  const invalidTargetResult = await executeChatReplyJump({
    targetMessageId: '   ',
    tryScrollToMessage: () => false,
    canLoadMoreHistory: () => true,
    loadOlderMessages: () => {},
  });
  assert.deepStrictEqual(
    invalidTargetResult,
    { success: false, usedHistoryLoads: 0, reason: 'invalid-target' },
    'Reply jump helper should reject invalid target ids'
  );

  let cancelledBeforeStartScrollCalled = false;
  const cancelledBeforeStartResult = await executeChatReplyJump({
    targetMessageId: 'msg-4',
    tryScrollToMessage: () => {
      cancelledBeforeStartScrollCalled = true;
      return false;
    },
    canLoadMoreHistory: () => true,
    loadOlderMessages: () => {},
    shouldContinue: () => false,
  });
  assert.deepStrictEqual(
    cancelledBeforeStartResult,
    { success: false, usedHistoryLoads: 0, reason: 'cancelled' },
    'Reply jump helper should stop immediately when continuation check fails before scrolling'
  );
  assert.strictEqual(
    cancelledBeforeStartScrollCalled,
    false,
    'Reply jump helper should not attempt scrolling when cancelled before start'
  );

  let cancelAfterLoadCount = 0;
  const cancelledAfterLoadResult = await executeChatReplyJump({
    targetMessageId: 'msg-5',
    tryScrollToMessage: () => false,
    canLoadMoreHistory: () => true,
    loadOlderMessages: async () => {
      cancelAfterLoadCount += 1;
    },
    shouldContinue: () => cancelAfterLoadCount === 0,
  });
  assert.deepStrictEqual(
    cancelledAfterLoadResult,
    { success: false, usedHistoryLoads: 1, reason: 'cancelled' },
    'Reply jump helper should cancel cleanly when conversation context changes during pagination'
  );

  logger.debug('✓ testChatReplyJumpHelper passed');
})()

.then(() => {
  // Pending message server-ID matching helper tests
  return (function testChatPendingMessageServerIdMatcher() {
    // Test 1: Match with exact timestamp
    const candidates1 = [
      { id: 'msg-1', timestampMs: 1000 },
      { id: 'msg-2', timestampMs: 2000 },
      { id: 'msg-3', timestampMs: 3000 },
    ];

    const match1 = resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus: 'sending',
      normalizedPendingText: 'hello',
      normalizedSender: 'user@test.com',
      normalizedRecipient: 'admin@test.com',
      pendingTimestampMs: 2000,
      candidates: candidates1,
      maxTimestampDeltaMs: 5000,
    });

    assert.strictEqual(
      match1,
      'msg-2',
      'Pending server-ID matcher should return exact timestamp match'
    );

    // Test 2: Match with closest timestamp within threshold
    const match2 = resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus: 'sending',
      normalizedPendingText: 'hello',
      normalizedSender: 'user@test.com',
      normalizedRecipient: 'admin@test.com',
      pendingTimestampMs: 1950,
      candidates: candidates1,
      maxTimestampDeltaMs: 100,
    });

    assert.strictEqual(
      match2,
      'msg-2',
      'Pending server-ID matcher should return closest timestamp match within threshold (delta: 50 < 100)'
    );

    // Test 3: Reject timestamp outside threshold
    const match3 = resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus: 'sending',
      normalizedPendingText: 'hello',
      normalizedSender: 'user@test.com',
      normalizedRecipient: 'admin@test.com',
      pendingTimestampMs: 100,
      candidates: candidates1,
      maxTimestampDeltaMs: 50,
    });

    assert.strictEqual(
      match3,
      '',
      'Pending server-ID matcher should reject all candidates outside timestamp threshold'
    );

    // Test 4: Reject invalid status
    const match4 = resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus: 'failed',
      normalizedPendingText: 'hello',
      normalizedSender: 'user@test.com',
      normalizedRecipient: 'admin@test.com',
      pendingTimestampMs: 2000,
      candidates: candidates1,
    });

    assert.strictEqual(
      match4,
      '',
      'Pending server-ID matcher should reject non-sending/sent status'
    );

    // Test 5: Fallback to first candidate when timestamps are non-finite
    const match5 = resolveChatPendingServerMessageIdFromCandidates({
      pendingStatus: 'sending',
      normalizedPendingText: 'hello',
      normalizedSender: 'user@test.com',
      normalizedRecipient: 'admin@test.com',
      pendingTimestampMs: NaN,
      candidates: candidates1,
    });

    assert.strictEqual(
      match5,
      'msg-1',
      'Pending server-ID matcher should use first candidate when pending timestamp is non-finite'
    );

    // Test 6: Build candidates-by-key map from displayed messages
    const messages = [
      {
        id: 'id-1',
        sender: 'user@test.com',
        recipientId: 'admin@test.com',
        text: 'hello world',
        timestamp: 1000,
      },
      {
        id: 'id-2',
        sender: 'user@test.com',
        recipientId: 'admin@test.com',
        text: 'hello world',
        timestamp: 2000,
      },
      {
        id: 'id-3',
        sender: 'user@test.com',
        recipientId: 'admin@test.com',
        text: 'different text',
        timestamp: 3000,
      },
      {
        id: 'id-4',
        sender: 'admin@test.com',
        recipientId: 'user@test.com',
        text: 'hello world',
        timestamp: 4000,
        deleted: true,
      },
    ];

    const candidatesMap = resolveChatPendingMessageCandidatesByKey({
      displayedMessages: messages,
      normalizeMessageId: (id) => (typeof id === 'string' ? id : ''),
      normalizeParticipantEmail: (email) => (typeof email === 'string' ? email.toLowerCase() : ''),
      normalizeMessageValue: (text) => (typeof text === 'string' ? text.trim() : ''),
    });

    const candidates = candidatesMap.get('user@test.com|admin@test.com|hello world');
    assert.strictEqual(
      candidates?.length,
      2,
      'Candidates-by-key map should group messages by sender|recipient|text and exclude deleted'
    );
    assert.deepStrictEqual(
      candidates?.map((c) => c.id),
      ['id-1', 'id-2'],
      'Candidates-by-key map should preserve order of matching messages'
    );

    // Test 7: Build match key deterministically
    const key1 = buildChatPendingTextMatchKey('user@test.com', 'admin@test.com', 'hello');
    const key2 = buildChatPendingTextMatchKey('user@test.com', 'admin@test.com', 'hello');
    const key3 = buildChatPendingTextMatchKey('admin@test.com', 'user@test.com', 'hello');

    assert.strictEqual(
      key1,
      key2,
      'Match key should be deterministic for same inputs'
    );
    assert.notStrictEqual(
      key1,
      key3,
      'Match key should differ when sender and recipient are swapped'
    );

    // Test 8: Resolve timestamp from various formats
    assert.strictEqual(
      resolveTimestampMs(1000),
      1000,
      'Timestamp resolver should pass through numeric timestamps'
    );

    const dateObj = new Date('2024-01-01T00:00:00.000Z');
    assert.strictEqual(
      resolveTimestampMs(dateObj),
      dateObj.getTime(),
      'Timestamp resolver should convert Date objects'
    );

    assert.strictEqual(
      Number.isNaN(resolveTimestampMs(null)),
      true,
      'Timestamp resolver should return NaN for null'
    );

    assert.strictEqual(
      Number.isNaN(resolveTimestampMs('invalid')),
      true,
      'Timestamp resolver should return NaN for invalid input'
    );

    logger.debug('✓ testChatPendingMessageServerIdMatcher passed');
  })();
})

.then(() => {
  // Roster merge state helper tests
  return (function testChatRosterMergeStateHelper() {
    // Test 1: Merge roster with presence and profile data
    const roster = [
      { id: '1', email: 'alice@school.com', name: 'Alice' },
      { id: '2', email: 'bob@school.com', name: 'Bob' },
    ];

    const presenceMap = new Map([
      ['alice@school.com', { isOnline: true, lastSeen: 1000, typingTo: 'conv-1' }],
    ]);

    const profileMap = new Map([
      ['bob@school.com', { bio: 'Biology teacher', phone: '555-1234' }],
    ]);

    const merged = resolveChatRosterMergedWithPresence({
      roster,
      presenceMap,
      profileMap,
    });

    assert.strictEqual(merged.length, 2, 'Roster merge should preserve member count');
    assert.strictEqual(
      merged[0].isOnline,
      true,
      'Roster merge should hydrate presence fields (isOnline)'
    );
    assert.strictEqual(
      merged[0].typingTo,
      'conv-1',
      'Roster merge should hydrate presence fields (typingTo)'
    );
    assert.strictEqual(
      merged[1].bio,
      'Biology teacher',
      'Roster merge should hydrate profile fields (bio)'
    );
    assert.strictEqual(
      merged[1].phone,
      '555-1234',
      'Roster merge should hydrate profile fields (phone)'
    );

    // Test 2: Empty roster returns empty array
    const emptyResult = resolveChatRosterMergedWithPresence({
      roster: [],
      presenceMap,
      profileMap,
    });

    assert.strictEqual(
      emptyResult.length,
      0,
      'Roster merge should return empty array for empty roster'
    );

    // Test 3: Null/undefined roster returns empty array
    const nullResult1 = resolveChatRosterMergedWithPresence({
      roster: null,
    });
    const nullResult2 = resolveChatRosterMergedWithPresence();

    assert.strictEqual(nullResult1.length, 0, 'Roster merge should handle null roster');
    assert.strictEqual(nullResult2.length, 0, 'Roster merge should handle undefined input');

    // Test 4: Member with no presence/profile data returned unchanged
    const noDataRoster = [
      { id: '3', email: 'charlie@school.com', name: 'Charlie' },
    ];

    const noDataMerged = resolveChatRosterMergedWithPresence({
      roster: noDataRoster,
      presenceMap: new Map(),
      profileMap: new Map(),
    });

    assert.deepStrictEqual(
      noDataMerged[0],
      noDataRoster[0],
      'Roster merge should return member unchanged when no presence/profile data exists'
    );

    // Test 5: Priority is profile > presence > original
    const priorityRoster = [
      {
        id: '4',
        email: 'diana@school.com',
        name: 'Original Diana',
        avatar: 'original.jpg',
      },
    ];

    const priorityPresenceMap = new Map([
      [
        'diana@school.com',
        {
          name: 'Presence Diana',
          avatar: 'presence.jpg',
          photoURL: 'presence-photo.jpg',
        },
      ],
    ]);

    const priorityProfileMap = new Map([
      ['diana@school.com', { name: 'Profile Diana', avatar: 'profile.jpg' }],
    ]);

    const priorityMerged = resolveChatRosterMergedWithPresence({
      roster: priorityRoster,
      presenceMap: priorityPresenceMap,
      profileMap: priorityProfileMap,
    });

    assert.strictEqual(
      priorityMerged[0].name,
      'Profile Diana',
      'Roster merge should prefer profile name over presence'
    );
    assert.strictEqual(
      priorityMerged[0].avatar,
      'profile.jpg',
      'Roster merge should prefer profile avatar over presence'
    );
    assert.strictEqual(
      priorityMerged[0].photoURL,
      'presence-photo.jpg',
      'Roster merge should fallback to presence for fields not in profile'
    );

    // Test 6: Email lookup is case-insensitive
    const caseRoster = [
      { id: '5', email: 'Eve@School.COM', name: 'Eve' },
    ];

    const caseLookupMap = new Map([
      ['eve@school.com', { isOnline: true }],
    ]);

    const caseMerged = resolveChatRosterMergedWithPresence({
      roster: caseRoster,
      presenceMap: caseLookupMap,
    });

    assert.strictEqual(
      caseMerged[0].isOnline,
      true,
      'Roster merge should normalize email to lowercase for lookups'
    );

    // Test 7: normalizeTeamMemberLookupKey function
    const lookupKey1 = normalizeTeamMemberLookupKey({
      email: 'Frank@School.COM',
      id: '6',
    });
    assert.strictEqual(
      lookupKey1,
      'frank@school.com',
      'Lookup key should prefer normalized email'
    );

    const lookupKey2 = normalizeTeamMemberLookupKey({ id: '7' });
    assert.strictEqual(
      lookupKey2,
      '7',
      'Lookup key should fall back to ID when email is missing'
    );

    const lookupKey3 = normalizeTeamMemberLookupKey({});
    assert.strictEqual(
      lookupKey3,
      '',
      'Lookup key should return empty string for members with no email/ID'
    );

    // Test 8: Presence/profile hydration type checks
    const presenceHydrated = isChatTeamMemberPresenceHydrated({
      isOnline: true,
    });
    assert.strictEqual(
      presenceHydrated,
      true,
      'Presence hydration check should return true when presence fields exist'
    );

    const profileHydrated = isChatTeamMemberProfileHydrated({
      phone: '555-5555',
    });
    assert.strictEqual(
      profileHydrated,
      true,
      'Profile hydration check should return true when profile fields exist'
    );

    const notHydrated = isChatTeamMemberPresenceHydrated({ name: 'John' });
    assert.strictEqual(
      notHydrated,
      false,
      'Presence hydration check should return false when only basic fields exist'
    );

    logger.debug('✓ testChatRosterMergeStateHelper passed');
  })();
})

.then(() => {
  // Pending animation state helper tests
  return (function testChatPendingAnimationStateHelper() {
    // Test 1: Animation timings for outgoing direction
    const outgoingTimings = resolveChatPendingRowAnimationTimings('outgoing');

    assert.strictEqual(
      outgoingTimings.enterOffset,
      8,
      'Outgoing animation should have positive enterOffset (slide from right)'
    );
    assert.strictEqual(
      outgoingTimings.enterScale,
      0.99,
      'Outgoing animation should have enterScale of 0.99'
    );
    assert.strictEqual(
      outgoingTimings.fadeDuration,
      180,
      'Outgoing animation should have fadeDuration of 180ms'
    );
    assert.strictEqual(
      outgoingTimings.slideDuration,
      210,
      'Outgoing animation should have slideDuration of 210ms'
    );
    assert.strictEqual(
      outgoingTimings.scaleDuration,
      170,
      'Outgoing animation should have scaleDuration of 170ms'
    );

    // Test 2: Animation timings for incoming direction
    const incomingTimings = resolveChatPendingRowAnimationTimings('incoming');

    assert.strictEqual(
      incomingTimings.enterOffset,
      -12,
      'Incoming animation should have negative enterOffset (slide from left)'
    );
    assert.strictEqual(
      incomingTimings.enterScale,
      0.985,
      'Incoming animation should have enterScale of 0.985'
    );
    assert.strictEqual(
      incomingTimings.fadeDuration,
      260,
      'Incoming animation should have fadeDuration of 260ms'
    );
    assert.strictEqual(
      incomingTimings.slideDuration,
      280,
      'Incoming animation should have slideDuration of 280ms'
    );
    assert.strictEqual(
      incomingTimings.scaleDuration,
      220,
      'Incoming animation should have scaleDuration of 220ms'
    );

    // Test 3: Default direction (outgoing)
    const defaultTimings = resolveChatPendingRowAnimationTimings();

    assert.deepStrictEqual(
      defaultTimings,
      outgoingTimings,
      'Default animation direction should be outgoing'
    );

    // Test 4: Build animation cache key
    const textKey = buildChatPendingRowAnimationKey('text', 'temp-1');
    const mediaKey = buildChatPendingRowAnimationKey('media', 'temp-2');
    const attachmentKey = buildChatPendingRowAnimationKey('attachment', 'temp-3');

    assert.strictEqual(textKey, 'text:temp-1', 'Text animation key should use text prefix');
    assert.strictEqual(mediaKey, 'media:temp-2', 'Media animation key should use media prefix');
    assert.strictEqual(
      attachmentKey,
      'attachment:temp-3',
      'Attachment animation key should use attachment prefix'
    );

    // Test 5: Resolve active animation keys from pending items
    const activeKeys = resolveChatActivePendingAnimationKeys({
      pendingTextIds: ['msg-1', 'msg-2'],
      pendingMediaIds: ['media-1'],
      pendingAttachmentIds: ['attach-1', 'attach-2', 'attach-3'],
    });

    assert.strictEqual(activeKeys.size, 6, 'Active keys should include all pending items');
    assert.strictEqual(
      activeKeys.has('text:msg-1'),
      true,
      'Active keys should contain text:msg-1'
    );
    assert.strictEqual(
      activeKeys.has('media:media-1'),
      true,
      'Active keys should contain media:media-1'
    );
    assert.strictEqual(
      activeKeys.has('attachment:attach-3'),
      true,
      'Active keys should contain attachment:attach-3'
    );

    // Test 6: Resolve inactive animation keys for pruning
    const cachedKeys = new Set([
      'text:msg-1',
      'text:msg-2',
      'text:msg-3',
      'media:media-1',
      'attachment:attach-1',
    ]);

    const activeKeysForPruning = new Set(['text:msg-1', 'text:msg-2', 'media:media-1']);

    const inactiveKeys = resolveChatInactivePendingAnimationKeys(
      cachedKeys,
      activeKeysForPruning
    );

    assert.strictEqual(
      inactiveKeys.size,
      2,
      'Inactive keys should identify entries no longer in active set'
    );
    assert.strictEqual(
      inactiveKeys.has('text:msg-3'),
      true,
      'Inactive keys should include text:msg-3'
    );
    assert.strictEqual(
      inactiveKeys.has('attachment:attach-1'),
      true,
      'Inactive keys should include attachment:attach-1'
    );

    // Test 7: Empty pending items returns empty active keys
    const emptyActiveKeys = resolveChatActivePendingAnimationKeys({});

    assert.strictEqual(emptyActiveKeys.size, 0, 'Empty pending items should return empty set');

    // Test 8: Animation entry started flag management
    const entry = { started: false };

    assert.strictEqual(
      shouldStartPendingRowAnimation(entry),
      true,
      'Should start animation when entry.started is false'
    );

    markPendingRowAnimationStarted(entry);

    assert.strictEqual(
      shouldStartPendingRowAnimation(entry),
      false,
      'Should not start animation after mark function is called'
    );

    // Test 9: Default opacity constants
    assert.strictEqual(
      PENDING_MESSAGE_BUBBLE_OPACITY_DEFAULT,
      0.7,
      'Default bubble opacity should be 0.7'
    );
    assert.strictEqual(
      PENDING_MESSAGE_BUBBLE_OPACITY_SENT,
      0.52,
      'Sent message bubble opacity should be 0.52 (more faded)'
    );

    // Test 10: No animation for null entry
    assert.strictEqual(
      shouldStartPendingRowAnimation(null),
      false,
      'Should not start animation for null entry'
    );

    assert.strictEqual(
      shouldStartPendingRowAnimation(undefined),
      false,
      'Should not start animation for undefined entry'
    );

    // Test 11: Pending bubble opacity target resolution
    assert.strictEqual(
      resolveChatPendingBubbleOpacityTarget('sent'),
      PENDING_MESSAGE_BUBBLE_OPACITY_SENT,
      'Sent status should resolve to sent bubble opacity'
    );
    assert.strictEqual(
      resolveChatPendingBubbleOpacityTarget('failed'),
      PENDING_MESSAGE_BUBBLE_OPACITY_DEFAULT,
      'Non-sent status should resolve to default bubble opacity'
    );

    // Test 12: Pending bubble opacity transition decision
    assert.strictEqual(
      shouldAnimateChatPendingBubbleOpacity(undefined, 'sending'),
      false,
      'Should not animate when previous status is missing'
    );
    assert.strictEqual(
      shouldAnimateChatPendingBubbleOpacity('sending', 'sending'),
      false,
      'Should not animate when status is unchanged'
    );
    assert.strictEqual(
      shouldAnimateChatPendingBubbleOpacity('sending', 'sent'),
      true,
      'Should animate when status changes'
    );

    // Test 13: Pending bubble opacity transition durations
    assert.strictEqual(
      resolveChatPendingBubbleOpacityDuration('sent'),
      170,
      'Sent status should use 170ms transition duration'
    );
    assert.strictEqual(
      resolveChatPendingBubbleOpacityDuration('failed'),
      120,
      'Non-sent status should use 120ms transition duration'
    );

    // Test 14: Resolve inactive pending bubble ids for cache pruning
    const inactiveBubbleIds = resolveChatInactivePendingBubbleOpacityIds(
      ['p1', 'p2', 'p3'],
      new Set(['p1'])
    );
    assert.strictEqual(inactiveBubbleIds.size, 2, 'Should resolve two inactive bubble ids');
    assert.strictEqual(inactiveBubbleIds.has('p2'), true, 'Should include p2 as inactive id');
    assert.strictEqual(inactiveBubbleIds.has('p3'), true, 'Should include p3 as inactive id');

    // Test 15: Bubble opacity cache get-or-create
    const bubbleCache = new Map();
    let createCount = 0;
    const firstEntry = resolveChatPendingBubbleOpacityEntry(
      bubbleCache,
      'temp-1',
      () => {
        createCount += 1;
        return { opacity: 0.7 };
      }
    );
    const secondEntry = resolveChatPendingBubbleOpacityEntry(
      bubbleCache,
      'temp-1',
      () => {
        createCount += 1;
        return { opacity: 0.5 };
      }
    );
    assert.strictEqual(createCount, 1, 'Should create cache entry only once');
    assert.strictEqual(firstEntry, secondEntry, 'Should return cached entry for subsequent reads');

    // Test 16: Row animation cache get-or-create
    const rowAnimationCache = new Map();
    let rowCreateCount = 0;
    const firstRowEntry = resolveChatPendingRowAnimationEntry(
      rowAnimationCache,
      'text:r1',
      () => {
        rowCreateCount += 1;
        return { opacity: 'o1', translateX: 'x1', scale: 's1' };
      }
    );
    const secondRowEntry = resolveChatPendingRowAnimationEntry(
      rowAnimationCache,
      'text:r1',
      () => {
        rowCreateCount += 1;
        return { opacity: 'o2', translateX: 'x2', scale: 's2' };
      }
    );
    assert.strictEqual(rowCreateCount, 1, 'Should create row animation entry only once');
    assert.strictEqual(firstRowEntry, secondRowEntry, 'Should return cached row animation entry');
    assert.strictEqual(firstRowEntry.started, false, 'New row animation entry should start with started=false');

    logger.debug('✓ testChatPendingAnimationStateHelper passed');
  })();
})
  .then(() => {
    // Attachment finalization state helper tests
    return (function testChatAttachmentFinalizeStateHelper() {
      // Test shouldFinalizeAttachmentCleanup with finalizing status
      assert.strictEqual(
        shouldFinalizeAttachmentCleanup({ tempId: 'a1', status: 'finalizing' }),
        true,
        'Should finalize attachment with finalizing status'
      );

      // Test shouldFinalizeAttachmentCleanup with non-finalizing status
      assert.strictEqual(
        shouldFinalizeAttachmentCleanup({ tempId: 'a1', status: 'uploading' }),
        false,
        'Should not finalize attachment with uploading status'
      );

      // Test shouldFinalizeAttachmentCleanup with null/undefined
      assert.strictEqual(
        shouldFinalizeAttachmentCleanup(null),
        false,
        'Should not finalize null attachment'
      );

      // Test hasPendingAttachment with existing attachment
      const attachmentMap = new Map([['a1', { status: 'finalizing' }]]);
      assert.strictEqual(
        hasPendingAttachment(attachmentMap, 'a1'),
        true,
        'Should find pending attachment in map'
      );

      // Test hasPendingAttachment with missing attachment
      assert.strictEqual(
        hasPendingAttachment(attachmentMap, 'a2'),
        false,
        'Should not find missing attachment in map'
      );

      // Test resolveChatAttachmentFinalizeDelayMs with custom delay
      assert.strictEqual(
        resolveChatAttachmentFinalizeDelayMs(500),
        500,
        'Should return custom delay when valid'
      );

      // Test resolveChatAttachmentFinalizeDelayMs with default
      assert.strictEqual(
        resolveChatAttachmentFinalizeDelayMs(),
        ATTACHMENT_FINALIZE_CLEANUP_DELAY_MS,
        'Should return default delay when undefined'
      );

      // Test isChatAttachmentTimerMapValid with valid map
      assert.strictEqual(
        isChatAttachmentTimerMapValid(new Map()),
        true,
        'Should validate Map instance as timer map'
      );

      // Test isChatAttachmentTimerMapValid with null
      assert.strictEqual(
        isChatAttachmentTimerMapValid(null),
        false,
        'Should reject null as timer map'
      );

      // Test resolveChatAttachmentCleanupPlan with finalizing attachment
      const plan = resolveChatAttachmentCleanupPlan({ status: 'finalizing' });
      assert.strictEqual(
        plan.shouldCleanup,
        true,
        'Should recommend cleanup for finalizing attachment'
      );
      assert.strictEqual(plan.reason, 'ready', 'Should have ready reason');

      logger.debug('✓ testChatAttachmentFinalizeStateHelper passed');
    })();
  })
  .then(() => {
    // Composer layout state helper tests
    return (function testChatComposerLayoutStateHelper() {
      // Test resolveChatComposerEffectiveHeight with defined height
      assert.strictEqual(
        resolveChatComposerEffectiveHeight(60),
        60,
        'Should return input height when greater than base'
      );

      // Test resolveChatComposerEffectiveHeight with undefined
      assert.strictEqual(
        resolveChatComposerEffectiveHeight(),
        COMPOSER_BASE_HEIGHT,
        'Should return base height when undefined'
      );

      // Test resolveChatComposerEffectiveHeight clamping
      assert.strictEqual(
        resolveChatComposerEffectiveHeight(30),
        COMPOSER_BASE_HEIGHT,
        'Should clamp to base height when input is less'
      );

      // Test resolveChatComposerExtraHeight with valid extra
      assert.strictEqual(
        resolveChatComposerExtraHeight(60),
        20,
        'Should calculate extra height (60 - 40)'
      );

      // Test resolveChatComposerExtraHeight with no extra
      assert.strictEqual(
        resolveChatComposerExtraHeight(40),
        0,
        'Should return 0 for base height'
      );

      // Test resolveChatComposerAdaptiveExtraHeight capping
      assert.strictEqual(
        resolveChatComposerAdaptiveExtraHeight(50),
        28,
        'Should cap adaptive extra at 28px'
      );

      // Test resolveChatComposerAdaptiveExtraHeight passthrough
      assert.strictEqual(
        resolveChatComposerAdaptiveExtraHeight(15),
        15,
        'Should pass through when less than cap'
      );

      // Test resolveChatBottomVisibilityPadding with default buffer
      const padding = resolveChatBottomVisibilityPadding(64, undefined);
      assert.strictEqual(
        padding,
        76,
        'Should be baseBuffer + 12 + adaptiveExtra (64 + 12 + 0)'
      );

      // Test resolveChatBottomVisibilityPadding with expanded composer
      const paddingExpanded = resolveChatBottomVisibilityPadding(64, 68);
      assert.strictEqual(
        paddingExpanded,
        104,
        'Should add adaptive extra for expanded composer (64 + 12 + 28)'
      );

      // Test resolveChatAutoscrollToTopThreshold
      assert.strictEqual(
        resolveChatAutoscrollToTopThreshold(100),
        148,
        'Should add 48px to visibility padding'
      );

      // Test isChatComposerHeightValid with valid height
      assert.strictEqual(
        isChatComposerHeightValid(50),
        true,
        'Should validate positive finite number'
      );

      // Test isChatComposerHeightValid with undefined
      assert.strictEqual(
        isChatComposerHeightValid(),
        true,
        'Should accept undefined'
      );

      // Test isChatComposerHeightValid with invalid height
      assert.strictEqual(
        isChatComposerHeightValid(-10),
        false,
        'Should reject negative height'
      );

      logger.debug('✓ testChatComposerLayoutStateHelper passed');
    })();
  })
  .then(() => {
    // Pending storage state helper tests
    return (function testChatPendingStorageStateHelper() {
      assert.strictEqual(
        resolveChatPendingSenderEmail('a@x.com', 'b@x.com'),
        'a@x.com',
        'Should prefer effective user email'
      );

      assert.strictEqual(
        resolveChatPendingSenderEmail('', 'b@x.com'),
        'b@x.com',
        'Should fall back to user email when effective email is empty'
      );

      assert.strictEqual(
        resolveChatPendingSenderEmail(undefined, undefined),
        CHAT_PENDING_STORAGE_EMPTY_EMAIL,
        'Should resolve empty email fallback when both are missing'
      );

      assert.strictEqual(
        shouldLoadChatPendingMessages('recipient-1', 'a@x.com'),
        true,
        'Should load when recipient and sender email are present'
      );

      assert.strictEqual(
        shouldLoadChatPendingMessages('', 'a@x.com'),
        false,
        'Should not load when recipient is missing'
      );

      assert.strictEqual(
        shouldLoadChatPendingMessages('recipient-1', ''),
        false,
        'Should not load when sender email is missing'
      );

      const raw = new Map([
        ['m1', { text: 'hello', status: 'sending' }],
        ['m2', { text: 'world', status: 'queued' }],
      ]);
      const normalized = resolveChatNormalizedPendingMessages(raw, () => 'sent');
      assert.strictEqual(normalized.get('m1')?.status, 'sent', 'Should normalize first message status');
      assert.strictEqual(normalized.get('m2')?.status, 'sent', 'Should normalize second message status');

      const emptyNormalized = resolveChatNormalizedPendingMessages(undefined, () => 'sent');
      assert.strictEqual(emptyNormalized.size, 0, 'Should return empty map for undefined input');

      logger.debug('✓ testChatPendingStorageStateHelper passed');
    })();
  })
  .then(() => {
    // Floating button layout state helper tests
    return (function testChatFloatingButtonLayoutStateHelper() {
      assert.strictEqual(
        resolveChatFloatingButtonBottomOffset(undefined),
        CHAT_FLOATING_BUTTON_BASE_OFFSET,
        'Should resolve base offset when input height is undefined'
      );

      assert.strictEqual(
        resolveChatFloatingButtonBottomOffset(CHAT_FLOATING_BUTTON_BASE_COMPOSER_HEIGHT),
        CHAT_FLOATING_BUTTON_BASE_OFFSET,
        'Should keep base offset at base composer height'
      );

      assert.strictEqual(
        resolveChatFloatingButtonBottomOffset(52),
        24,
        'Should increase offset by composer delta'
      );

      assert.strictEqual(
        resolveChatFloatingButtonBottomOffset(30),
        CHAT_FLOATING_BUTTON_BASE_OFFSET,
        'Should clamp negative deltas to zero'
      );

      const styleState = resolveChatScrollToBottomButtonStyleState({
        inputHeight: 52,
        surfaceColor: '#fff',
        borderColor: '#ddd',
        borderWidth: 1,
      });
      assert.strictEqual(styleState.bottom, 24, 'Style state should include computed bottom offset');
      assert.strictEqual(styleState.backgroundColor, '#fff', 'Style state should include surface color');
      assert.strictEqual(styleState.borderColor, '#ddd', 'Style state should include border color');
      assert.strictEqual(styleState.position, 'absolute', 'Style state should set absolute positioning');

      logger.debug('✓ testChatFloatingButtonLayoutStateHelper passed');
    })();
  })
  .then(() => {
    // Pending cleanup state helper tests
    return (function testChatPendingCleanupStateHelper() {
      assert.strictEqual(
        shouldRunChatPendingDeliveredCleanup(1, 1),
        true,
        'Should run cleanup when pending and delivered counts are both > 0'
      );
      assert.strictEqual(
        shouldRunChatPendingDeliveredCleanup(0, 1),
        false,
        'Should not run cleanup when pending count is zero'
      );
      assert.strictEqual(
        shouldRunChatPendingDeliveredCleanup(1, 0),
        false,
        'Should not run cleanup when delivered count is zero'
      );

      assert.strictEqual(
        hasChatPendingResolvedIds(['a']),
        true,
        'Should detect resolved ids when array has values'
      );
      assert.strictEqual(
        hasChatPendingResolvedIds([]),
        false,
        'Should return false for empty resolved-id array'
      );

      const baseMap = new Map([
        ['a', { status: 'sending' }],
        ['b', { status: 'failed' }],
        ['c', { status: 'sent' }],
      ]);
      const nextMap = resolveChatPendingMapAfterRemovingIds(baseMap, ['a', 'c']);
      assert.strictEqual(nextMap.size, 1, 'Should remove requested ids from map');
      assert.strictEqual(nextMap.has('b'), true, 'Should keep unresolved ids in map');
      assert.strictEqual(nextMap.has('a'), false, 'Should remove id a');
      assert.strictEqual(nextMap.has('c'), false, 'Should remove id c');

      const unchanged = resolveChatPendingMapAfterRemovingIds(baseMap, []);
      assert.strictEqual(unchanged, baseMap, 'Should return original map when no ids are resolved');

      const activeIdSet = resolveChatPendingActiveIdSet(['id-1', 'id-2', 'id-1']);
      assert.strictEqual(activeIdSet.size, 2, 'Should deduplicate active ids into a Set');
      assert.strictEqual(activeIdSet.has('id-1'), true, 'Should include id-1 in active set');
      assert.strictEqual(activeIdSet.has('id-2'), true, 'Should include id-2 in active set');

      logger.debug('✓ testChatPendingCleanupStateHelper passed');
    })();
  })
  .then(() => {
    logger.debug('All basic tests passed');

    // If emulator is available, run integration test
    if (process.env.FIRESTORE_EMULATOR_HOST) {
      logger.debug('Detected Firestore emulator environment; running integration test...');
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['scripts/runFirestoreIntegration.js'], { stdio: 'inherit' });
      child.on('close', (code) => {
        if (code !== 0) {
          logger.error('Integration test failed with code', code);
          process.exit(code);
        } else {
          logger.debug('Integration test completed successfully');
        }
      });
    }
  })
  .catch((error) => {
    logger.error('Async unit test failed', error);
    process.exit(1);
  });
