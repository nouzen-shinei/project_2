/**
 * ChatPendingMedia – Renders optimistic pending sticker/GIF and file attachment bubbles.
 *
 * Extracted from `renderPendingMedia` and `renderPendingAttachments` in chat.tsx.
 * These components receive all dependencies via props (not via ChatContext),
 * because they are rendered in the list footer rather than in the FlashList
 * recycler, and their dependency surface differs from regular messages.
 */
import React from 'react';
import { View, Text, Image, TouchableOpacity, Animated } from 'react-native';
import { Clock, CheckCircle2, AlertCircle, RotateCcw } from 'lucide-react-native';
import { StyledText } from '../../components';
import {
  resolveChatPendingServerMatchVisibility,
} from '../../lib/chatPendingVisibilityState';
import {
  resolveChatPendingReplyPreviewState,
  resolveChatPendingStatusDisplayState,
} from '../../lib/chatPendingRenderState';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

import type { ChatReplyContext } from '../../services/chatService';


export interface PendingMediaItem {
  id: string;
  kind: 'gif' | 'sticker';
  previewUri: string;
  width?: number;
  height?: number;
  nameOrTitle?: string;
  timestamp: string;
  recipientId: string;
  sender: string;
  status: 'sending' | 'failed' | 'queued' | 'sent';
  serverMessageId?: string;
  replyTo?: ChatReplyContext;
  mime?: string;
  source?: 'keyboard' | 'picker';
  progress?: number;
}

export interface PendingAttachmentItem {
  id: string;
  files: {
    uri: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
    webFile?: Blob;
  }[];
  messageText: string;
  timestamp?: string;
  recipientId: string;
  sender: string;
  status: 'sending' | 'failed' | 'finalizing' | 'sent' | 'queued';
  serverMessageId?: string;
  replyTo?: ChatReplyContext;
  progress: number;
  cancelable?: boolean;
  cancelRequested?: boolean;
  failureReason?: 'error' | 'canceled';
}

interface PendingUploadProgressBarProps {
  progress: number;
  label: string;
  showPercent?: boolean;
  isActive?: boolean;
  textStyle?: any;
  trackStyle?: any;
  fillStyle?: any;
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared props types
// ──────────────────────────────────────────────────────────────────────────────

type ChatPendingRowAnimationKind = 'text' | 'media' | 'attachment';
type ChatPendingRowAnimationDirection = 'incoming' | 'outgoing';

interface ChatPendingRowAnimationValues {
  opacity: Animated.Value;
  translateX: Animated.Value;
  scale: Animated.Value;
}

export interface ChatPendingMediaProps {
  tempId: string;
  item: PendingMediaItem;
  selectedTeamMemberId: string | undefined;
  deliveredMessageIds: Set<string>;
  normalizeMessageId: (id: unknown) => string;
  getPendingRowAnimation: (
    key: string,
    direction?: ChatPendingRowAnimationDirection
  ) => ChatPendingRowAnimationValues;
  buildChatPendingRowAnimationKey: (kind: ChatPendingRowAnimationKind, tempId: string) => string;
  isOffline: boolean;
  CHAT_REPLY_PREVIEW_MAX_CHARS: number;
  resolveChatReplyPreviewText: (args: any) => string;
  resolveChatReplySenderLabel: (replyTo: any) => string;
  jumpToReplyMessage: (replyTo: any) => void;
  getRetryPendingMediaPressHandler: (tempId: string) => () => void;
  PendingUploadProgressBar: React.ComponentType<PendingUploadProgressBarProps>;
  theme: any;
  themedStyles: any;
  styles: any;
}

export interface ChatPendingAttachmentsProps {
  tempId: string;
  item: PendingAttachmentItem;
  selectedTeamMemberId: string | undefined;
  deliveredMessageIds: Set<string>;
  normalizeMessageId: (id: unknown) => string;
  getPendingRowAnimation: (
    key: string,
    direction?: ChatPendingRowAnimationDirection
  ) => ChatPendingRowAnimationValues;
  buildChatPendingRowAnimationKey: (kind: ChatPendingRowAnimationKind, tempId: string) => string;
  isOffline: boolean;
  CHAT_REPLY_PREVIEW_MAX_CHARS: number;
  resolveChatReplyPreviewText: (args: any) => string;
  resolveChatReplySenderLabel: (replyTo: any) => string;
  jumpToReplyMessage: (replyTo: any) => void;
  getRetryPendingAttachmentPressHandler: (tempId: string) => () => void;
  getCancelPendingAttachmentPressHandler: (tempId: string) => () => void;
  formatFileSize: (bytes: number) => string;
  PendingUploadProgressBar: React.ComponentType<PendingUploadProgressBarProps>;
  inlineConversationSearchHighlightQuery: string;
  theme: any;
  themedStyles: any;
  styles: any;
}

// ──────────────────────────────────────────────────────────────────────────────
// ChatPendingMedia
// ──────────────────────────────────────────────────────────────────────────────

export const ChatPendingMedia = React.memo(function ChatPendingMedia({
  tempId,
  item,
  selectedTeamMemberId,
  deliveredMessageIds,
  normalizeMessageId,
  getPendingRowAnimation,
  buildChatPendingRowAnimationKey,
  isOffline,
  CHAT_REPLY_PREVIEW_MAX_CHARS,
  resolveChatReplyPreviewText,
  resolveChatReplySenderLabel,
  jumpToReplyMessage,
  getRetryPendingMediaPressHandler,
  PendingUploadProgressBar,
  theme,
  themedStyles,
  styles,
}: ChatPendingMediaProps) {
  if (!selectedTeamMemberId) return null;

  const pendingMediaVisibilityState = resolveChatPendingServerMatchVisibility({
    selectedRecipientId: selectedTeamMemberId,
    itemRecipientId: item.recipientId,
    serverMessageId: item.serverMessageId,
    deliveredMessageIds,
    normalizeMessageId,
  });
  if (!pendingMediaVisibilityState.shouldRender) return null;

  const rowAnim = getPendingRowAnimation(
    buildChatPendingRowAnimationKey('media', tempId),
    'outgoing',
  );
  const pendingMediaStatusState = resolveChatPendingStatusDisplayState({
    status: item.status,
    isOffline,
  });
  const pendingMediaReplyPreviewState = resolveChatPendingReplyPreviewState({
    replyTo: item.replyTo,
    maxLength: CHAT_REPLY_PREVIEW_MAX_CHARS,
    resolvePreviewText: resolveChatReplyPreviewText,
  });
  const pendingReplyPreview = pendingMediaReplyPreviewState.previewText;
  const pendingReplySenderLabel = pendingMediaReplyPreviewState.shouldShowPreview
    ? resolveChatReplySenderLabel(item.replyTo)
    : '';
  const isSticker = item.kind === 'sticker';
  const size = {
    width: Math.min(item.width || 200, 200),
    height: Math.min(item.height || 200, 200),
  };

  return (
    <Animated.View
      key={tempId}
      style={{
        opacity: rowAnim.opacity,
        transform: [{ translateX: rowAnim.translateX }, { scale: rowAnim.scale }],
      }}
    >
      <View style={[styles.messageContainer, styles.ownMessage]}>
        {pendingReplyPreview && (
          <TouchableOpacity
            style={[styles.replySnippet, styles.replySnippetOwn, { borderLeftColor: 'rgba(255, 255, 255, 0.7)' }]}
            activeOpacity={0.85}
            onPress={() => { void jumpToReplyMessage(item.replyTo); }}
          >
            <Text style={[styles.replySnippetSender, styles.replySnippetSenderOwn]} numberOfLines={1}>
              {pendingReplySenderLabel}
            </Text>
            <Text style={[styles.replySnippetText, styles.replySnippetTextOwn]} numberOfLines={1}>
              {pendingReplyPreview}
            </Text>
          </TouchableOpacity>
        )}
        <View style={[styles.stickerContainer, styles.ownSticker]}>
          {isSticker && (!item.previewUri || item.previewUri.trim().length === 0) ? (
            <View style={styles.emojiStickerContainer}>
              <Text style={[
                styles.emojiStickerText,
                { fontSize: Math.min(item.width || 100, 100) * 0.8 },
              ]}>
                {item.nameOrTitle || '🙂'}
              </Text>
            </View>
          ) : (
            <Image
              source={{ uri: item.previewUri }}
              style={[styles.stickerImage, size]}
              resizeMode="contain"
            />
          )}
          {item.status === 'sending' && typeof item.progress === 'number' && (
            <View style={styles.pendingMediaOverlay}>
              <PendingUploadProgressBar
                progress={item.progress}
                label="Uploading..."
                textStyle={{ color: '#fff', fontSize: 12, fontWeight: '600' }}
                trackStyle={{
                  height: 4,
                  backgroundColor: 'rgba(255,255,255,0.3)',
                  borderRadius: 4,
                  marginTop: 4,
                }}
                fillStyle={{
                  height: 4,
                  backgroundColor: '#fff',
                  borderRadius: 4,
                }}
              />
            </View>
          )}
          <View style={[styles.stickerFooter, styles.ownStickerFooter, styles.alignItemsCenter]}>
            <Text style={[styles.stickerTime, themedStyles.colorTextSecondary]}>
              {pendingMediaStatusState.statusLabel}
            </Text>
            {pendingMediaStatusState.effectiveStatus === 'sending' ? (
              <Clock size={12} color={theme.textSecondary} />
            ) : pendingMediaStatusState.effectiveStatus === 'sent' ? (
              <CheckCircle2 size={12} color={theme.textSecondary} />
            ) : pendingMediaStatusState.effectiveStatus === 'queued' ? (
              <Clock size={12} color={theme.textSecondary} />
            ) : (
              <AlertCircle size={12} color={theme.error} />
            )}
            {pendingMediaStatusState.canRetry && (
              <TouchableOpacity
                onPress={getRetryPendingMediaPressHandler(tempId)}
                disabled={isOffline}
                style={isOffline ? themedStyles.retryButtonDisabled : themedStyles.retryButton}
              >
                <Text style={themedStyles.retryText}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Animated.View>
  );
});

ChatPendingMedia.displayName = 'ChatPendingMedia';

// ──────────────────────────────────────────────────────────────────────────────
// ChatPendingAttachments
// ──────────────────────────────────────────────────────────────────────────────

export const ChatPendingAttachments = React.memo(function ChatPendingAttachments({
  tempId,
  item,
  selectedTeamMemberId,
  deliveredMessageIds,
  normalizeMessageId,
  getPendingRowAnimation,
  buildChatPendingRowAnimationKey,
  isOffline,
  CHAT_REPLY_PREVIEW_MAX_CHARS,
  resolveChatReplyPreviewText,
  resolveChatReplySenderLabel,
  jumpToReplyMessage,
  getRetryPendingAttachmentPressHandler,
  getCancelPendingAttachmentPressHandler,
  formatFileSize,
  PendingUploadProgressBar,
  inlineConversationSearchHighlightQuery,
  theme,
  themedStyles,
  styles,
}: ChatPendingAttachmentsProps) {
  if (!selectedTeamMemberId) return null;

  const pendingAttachmentVisibilityState = resolveChatPendingServerMatchVisibility({
    selectedRecipientId: selectedTeamMemberId,
    itemRecipientId: item.recipientId,
    serverMessageId: item.serverMessageId,
    deliveredMessageIds,
    normalizeMessageId,
  });
  if (!pendingAttachmentVisibilityState.shouldRender) return null;

  const rowAnim = getPendingRowAnimation(
    buildChatPendingRowAnimationKey('attachment', tempId),
    'outgoing',
  );
  const showRetry = item.status === 'failed' || (item.status === 'queued' && !isOffline);
  const pendingAttachmentReplyPreviewState = resolveChatPendingReplyPreviewState({
    replyTo: item.replyTo,
    maxLength: CHAT_REPLY_PREVIEW_MAX_CHARS,
    resolvePreviewText: resolveChatReplyPreviewText,
  });
  const pendingReplyPreview = pendingAttachmentReplyPreviewState.previewText;
  const pendingReplySenderLabel = pendingAttachmentReplyPreviewState.shouldShowPreview
    ? resolveChatReplySenderLabel(item.replyTo)
    : '';

  return (
    <Animated.View
      key={tempId}
      style={{
        opacity: rowAnim.opacity,
        transform: [{ translateX: rowAnim.translateX }, { scale: rowAnim.scale }],
      }}
    >
      <View style={[styles.messageContainer, styles.ownMessage]}>
        <View style={[styles.messageBubble, styles.ownBubble, { backgroundColor: theme.primary }]}>
          {pendingReplyPreview && (
            <TouchableOpacity
              style={[styles.replySnippet, styles.replySnippetOwn, { borderLeftColor: 'rgba(255, 255, 255, 0.7)' }]}
              activeOpacity={0.85}
              onPress={() => { void jumpToReplyMessage(item.replyTo); }}
            >
              <Text style={[styles.replySnippetSender, styles.replySnippetSenderOwn]} numberOfLines={1}>
                {pendingReplySenderLabel}
              </Text>
              <Text style={[styles.replySnippetText, styles.replySnippetTextOwn]} numberOfLines={1}>
                {pendingReplyPreview}
              </Text>
            </TouchableOpacity>
          )}
          {item.messageText ? (
            <StyledText
              text={item.messageText}
              style={[styles.messageText, styles.ownMessageText]}
              linkStyle={{ color: 'rgba(255,255,255,0.9)', fontWeight: '600' }}
              highlightQuery={inlineConversationSearchHighlightQuery}
              highlightStyle={styles.searchInlineHighlightOwn}
            />
          ) : null}
          <View style={item.messageText ? styles.marginTop8 : null}>
            {item.files.map((f, idx) => (
              <View key={idx} style={idx < item.files.length - 1 ? styles.marginBottom8 : null}>
                <View style={[styles.deletedFileAttachment, { backgroundColor: theme.background, borderColor: theme.border }]}>
                  <View style={styles.fileInfo}>
                    <Text style={[styles.fileName, { color: theme.text }]} numberOfLines={1}>{f.fileName}</Text>
                    <Text style={[styles.fileSize, { color: theme.textSecondary }]}>
                      {f.fileType.replace('/', ' · ')}{f.fileSize ? ` · ${formatFileSize(f.fileSize)}` : ''}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
          {item.status === 'sending' && (
            <View style={styles.marginTop8}>
              <View style={styles.pendingAttachmentHeader}>
                <View style={styles.flex1}>
                  <PendingUploadProgressBar
                    progress={item.progress}
                    label={item.cancelRequested ? 'Canceling...' : 'Uploading...'}
                    showPercent={!item.cancelRequested}
                    textStyle={styles.pendingSentText}
                    trackStyle={styles.pendingProgressBarOuter}
                    fillStyle={styles.pendingProgressBarInner}
                  />
                </View>
                {item.cancelable && !item.cancelRequested && (
                  <TouchableOpacity
                    onPress={getCancelPendingAttachmentPressHandler(tempId)}
                    style={styles.pendingAttachmentCancelButton}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel upload"
                  >
                    <Text style={styles.pendingAttachmentCancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          )}
          {item.status === 'finalizing' && (
            <View style={styles.marginTop8}>
              <View style={styles.pendingAttachmentHeader}>
                <Text style={styles.pendingSentText}>Sent</Text>
                <CheckCircle2 size={14} color={'#fff'} />
              </View>
              <View style={styles.pendingProgressBarOuter}>
                <View style={styles.pendingProgressBarInner} />
              </View>
            </View>
          )}
          {item.status === 'failed' && (
            <View style={styles.pendingFailedContainer}>
              <AlertCircle size={14} color={'#fff'} />
              <Text style={styles.pendingFailedText}>
                {item.failureReason === 'canceled' ? 'Canceled' : 'Failed'}
              </Text>
            </View>
          )}
          {item.status === 'queued' && (
            <View style={styles.pendingFailedContainer}>
              <Clock size={14} color={'#fff'} />
              <Text style={styles.pendingFailedText}>Queued</Text>
            </View>
          )}
          {showRetry && (
            <View style={styles.pendingFailedContainer}>
              <TouchableOpacity
                onPress={getRetryPendingAttachmentPressHandler(tempId)}
                disabled={isOffline}
                style={[
                  styles.pendingRetryButton,
                  { opacity: isOffline ? 0.6 : 1 },
                ]}
              >
                <RotateCcw size={12} color={'#fff'} />
                <Text style={styles.pendingRetryButtonText}>Retry</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Animated.View>
  );
});

ChatPendingAttachments.displayName = 'ChatPendingAttachments';
