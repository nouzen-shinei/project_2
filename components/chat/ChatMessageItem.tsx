/**
 * ChatMessageItem – Renders a single chat message.
 *
 * Extracted from the monolithic renderMessage function in chat.tsx.
 * Reads shared state/callbacks from ChatContext instead of closure scope.
 */
import React from 'react';
import { View, Text, Image, TouchableOpacity, ActivityIndicator, Platform } from 'react-native';
import { Star, Heart, Smile, Trash2, AlertCircle, Eye, Edit3, RotateCcw } from 'lucide-react-native';
import { useChatStable, useChatReactive } from './ChatContext';
import type { HydratedAttachment, ChatReplyContext } from './ChatContext';
import { resolveVideoSource } from '../../lib/videoSource';
import AnimatedMessageWrapper from './AnimatedMessageWrapper';
import MessageReplySnippet from './MessageReplySnippet';
import MessageReactionPills from './MessageReactionPills';
import MessagePendingOverlay from './MessagePendingOverlay';
import {
  MessageStatusTicks,
  StyledText,
  FileViewer,
} from '../../components';
import ProgressiveImage from '../../components/ui/ProgressiveImage';

/** Reaction status shape returned by getMessageReactionSummary */
interface ReactionStatusSnapshot {
  count: number;
  hasUserReacted: boolean;
  users: string[];
}

const EMPTY_REACTION_STATUS: ReactionStatusSnapshot = {
  count: 0,
  hasUserReacted: false,
  users: [],
};

export interface ChatMessageItemProps {
  msg: any;
  reactionsOverride?: { [key: string]: Set<string> };
  isEditingOverride?: boolean;
}

const ChatMessageItem = React.memo(function ChatMessageItem({
  msg,
  reactionsOverride,
  isEditingOverride,
}: ChatMessageItemProps) {
  const stable = useChatStable();
  const reactive = useChatReactive();

  const {
    normalizeMessageId,
    getReactionPressHandler,
    getQuickTapReactionHandler,
    getAttachmentImageViewPressHandler,
    getAttachmentDownloadPressHandler,
    getDownloadKey,
    handleMessageLongPress,
    handleImageError,
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
  } = stable;

  const {
    effectiveUser,
    selectedTeamMember,
    teamMembersByEmail,
    theme,
    themedStyles,
    isDarkMode,
    isFocused,
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
  } = reactive;

    // Defensive check for message validity
    if (!msg || !msg.id) {
      logger.warn('Invalid message object:', msg);
      return null;
    }
    
    // Use effectiveUser for proper message alignment
    const msgSenderLower = (msg.sender || '').toLowerCase().trim();
    const userEmailLower = (effectiveUser?.email || '').toLowerCase().trim();
    const isOwnMessage = msgSenderLower === userEmailLower;
    const normalizedMessageId = normalizeMessageId(msg.id);
    const isReplyJumpHighlighted = Boolean(
      replyJumpHighlightMessageId &&
      normalizedMessageId &&
      replyJumpHighlightMessageId === normalizedMessageId
    );
    const isConversationSearchHighlighted = Boolean(
      conversationSearchHighlightMessageId &&
      normalizedMessageId &&
      conversationSearchHighlightMessageId === normalizedMessageId
    );

    // Simple animation state check (no useMemo in render functions)
    const isNewMessage = animatedMessages.has(msg.id);
    const actionPending = isMessageActionPending(msg.id);
    const wasEdited = Boolean((msg.editCount && msg.editCount > 0) || msg.editedAt);
    const isEditingTarget = typeof isEditingOverride === 'boolean'
      ? isEditingOverride
      : editingMessageInfo?.id === normalizeMessageId(msg.id);
    const pendingOverlay = actionPending ? (
      <MessagePendingOverlay isOwnMessage={isOwnMessage} />
    ) : null;

    const hasAttachmentContent = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    const attachmentsHydrating = !hasAttachmentContent && (
      Boolean(msg.hasAttachments) ||
      (typeof msg.attachmentCount === 'number' && msg.attachmentCount > 0)
    );
    const shouldRenderAttachmentSection = hasAttachmentContent || attachmentsHydrating;
    let attachmentHydrationLabel = '';
    if (attachmentsHydrating) {
      const attachmentCount = typeof msg.attachmentCount === 'number' ? msg.attachmentCount : null;
      if (attachmentCount && attachmentCount > 0) {
        attachmentHydrationLabel = `Loading ${attachmentCount} attachment${attachmentCount > 1 ? 's' : ''}...`;
      } else {
        attachmentHydrationLabel = 'Loading attachments...';
      }
    }
    const skeletonBackgroundColor = isOwnMessage ? 'rgba(255, 255, 255, 0.12)' : theme.surface;
    const skeletonBorderColor = isOwnMessage ? 'rgba(255, 255, 255, 0.25)' : theme.border;
    const skeletonTextColor = isOwnMessage ? 'rgba(255, 255, 255, 0.95)' : theme.text;
    const skeletonSubtextColor = isOwnMessage ? 'rgba(255, 255, 255, 0.7)' : theme.textSecondary;

    if (msg.deleted) {
      const deletedTimestamp = msg.deletedAt || msg.timestamp;
      const deletedBubbleThemeStyle = isDarkMode
        ? styles.deletedMessageBubbleOwn
        : styles.deletedMessageBubbleFriend;
      const deletedMessageTextThemeStyle = isDarkMode
        ? styles.deletedMessageTextOwn
        : themedStyles.colorTextSecondary;
      const deletedTimestampThemeStyle = isDarkMode
        ? styles.ownMessageTime
        : [styles.friendMessageTime, themedStyles.colorTextSecondary];
      const deletedIconColor = isDarkMode ? 'rgba(255, 255, 255, 0.75)' : theme.textSecondary;

      return (
        <AnimatedMessageWrapper
          key={`deleted-${msg.id}`}
          isNewMessage={isNewMessage}
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
          isFocused={isFocused}
          globalAnimatedMessages={globalAnimatedMessages}
        >
          <View
            key={`deleted-view-${msg.id}`}
            style={[
              styles.messageContainer,
              isOwnMessage ? styles.ownMessage : styles.friendMessage,
              styles.deletedMessageContainer,
            ]}
          >
            <View
              style={[
                styles.deletedMessageBubble,
                deletedBubbleThemeStyle,
              ]}
            >
              <View style={styles.deletedMessageContent}>
                <Trash2
                  size={16}
                  color={deletedIconColor}
                  style={styles.deletedIcon}
                />
                <Text
                  style={[
                    styles.deletedMessageText,
                    deletedMessageTextThemeStyle,
                  ]}
                >
                  Message removed
                </Text>
              </View>
              <Text
                style={[
                  styles.deletedMessageTime,
                  deletedTimestampThemeStyle,
                ]}
              >
                {formatMessageTimestamp(deletedTimestamp)}
              </Text>
            </View>
          </View>
        </AnimatedMessageWrapper>
      );
    }

    const messageTimestampLabel = formatMessageTimestamp(msg.timestamp);
    const reactionSummary = getMessageReactionSummary(msg, reactionsOverride);
    const messageReactionPills = reactionSummary.pills;
    const hasMessageReactionPills = messageReactionPills.length > 0;
    const rawMessageText = typeof msg.text === 'string' ? msg.text : '';
    const trimmedMessageText = rawMessageText.trim();
    const shouldRenderRegularText = trimmedMessageText.length > 0 && trimmedMessageText !== '.';
    const regularMessageText = shouldRenderRegularText
      ? sanitizeMessageText(rawMessageText, 'Message')
      : 'Message';
    const messageReplyContext = msg?.replyTo as ChatReplyContext | undefined;
    const messageReplyPreview = messageReplyContext
      ? resolveChatReplyPreviewText({
          text: messageReplyContext.text,
          isSpecial: messageReplyContext.isSpecial,
          hasAttachments: messageReplyContext.hasAttachments,
          attachmentCount: messageReplyContext.attachmentCount,
          hasSticker: messageReplyContext.hasSticker,
          hasGif: messageReplyContext.hasGif,
          maxLength: CHAT_REPLY_PREVIEW_MAX_CHARS,
        })
      : '';
    const messageReplySenderLabel = messageReplyContext
      ? resolveChatReplySenderLabel(messageReplyContext)
      : '';
    const shouldRenderMessageReply = Boolean(messageReplyContext && messageReplyPreview);

    if (msg.isSpecial) {
      const senderName = isOwnMessage ? 'You' : selectedTeamMember?.name || 'Someone';
      const specialMessageText = sanitizeMessageText(msg.text, 'Special message');
      const heartReactionStatus = reactionSummary.statusByType.get('heart') ?? EMPTY_REACTION_STATUS;
      const starReactionStatus = reactionSummary.statusByType.get('star') ?? EMPTY_REACTION_STATUS;
      const smileReactionStatus = reactionSummary.statusByType.get('smile') ?? EMPTY_REACTION_STATUS;
      const heartShouldGlow = reactionSummary.glowByType.has('heart');
      const starShouldGlow = reactionSummary.glowByType.has('star');
      const smileShouldGlow = reactionSummary.glowByType.has('smile');
      const specialReactionStatuses = [
        { type: 'heart', status: heartReactionStatus },
        { type: 'star', status: starReactionStatus },
        { type: 'smile', status: smileReactionStatus },
      ].filter((entry) => entry.status.count > 0);
      
      return (
        <AnimatedMessageWrapper 
          key={`special-${msg.id}`}
          isNewMessage={isNewMessage} 
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
          isFocused={isFocused}
          globalAnimatedMessages={globalAnimatedMessages}
        >
          <View key={msg.id} style={styles.specialMessageContainer}>
            <View
              style={[
                styles.specialMessageBubble,
                styles.messageActionAnchor,
                isReplyJumpHighlighted && styles.replyJumpHighlightGlow,
                isConversationSearchHighlighted && styles.messageSearchHighlightGlow,
                themedStyles.specialBubble,
              ]}
            >
              {shouldRenderMessageReply && (
                <MessageReplySnippet
                  senderLabel={messageReplySenderLabel}
                  previewText={messageReplyPreview}
                  isOwnMessage={false}
                  theme={theme}
                  isDarkMode={isDarkMode}
                  variant="special"
                  onJump={() => void jumpToReplyMessage(messageReplyContext)}
                />
              )}
              <View style={styles.specialMessageHeader}>
                <Star size={20} color={theme.warning} />
                <Text style={[styles.specialMessageTitle, themedStyles.colorWarning]}>
                  Special Message from {senderName || 'Unknown User'}
                </Text>
                <Star size={20} color={theme.warning} />
              </View>
              <StyledText
                text={specialMessageText}
                style={[styles.specialMessageText, themedStyles.colorText]}
                linkStyle={themedStyles.linkStylePrimary}
                highlightQuery={inlineConversationSearchHighlightQuery}
              />
              <Text style={[styles.specialMessageTime, themedStyles.colorTextSecondary]}>
                {messageTimestampLabel}
              </Text>
              <View style={styles.specialReactions}>
                <TouchableOpacity 
                  style={[
                    styles.reactionButton, 
                    themedStyles.bgBackground,
                    heartShouldGlow && styles.glowingReaction
                  ]}
                  onPress={getReactionPressHandler(msg.id, 'heart')}
                >
                  <Heart 
                    size={20} 
                    color={heartReactionStatus.hasUserReacted ? '#ef4444' : theme.textSecondary}
                  />
                  {heartReactionStatus.count > 0 && (
                    <Text style={[styles.reactionCount, themedStyles.colorText]}>
                      {heartReactionStatus.count}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[
                    styles.reactionButton, 
                    themedStyles.bgBackground,
                    starShouldGlow && styles.glowingReaction
                  ]}
                  onPress={getReactionPressHandler(msg.id, 'star')}
                >
                  <Star 
                    size={20} 
                    color={starReactionStatus.hasUserReacted ? '#fbbf24' : theme.textSecondary}
                  />
                  {starReactionStatus.count > 0 && (
                    <Text style={[styles.reactionCount, themedStyles.colorText]}>
                      {starReactionStatus.count}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity 
                  style={[
                    styles.reactionButton, 
                    themedStyles.bgBackground,
                    smileShouldGlow && styles.glowingReaction
                  ]}
                  onPress={getReactionPressHandler(msg.id, 'smile')}
                >
                  <Smile 
                    size={20} 
                    color={smileReactionStatus.hasUserReacted ? '#1e1c1cff' : theme.textSecondary}
                  />
                  {smileReactionStatus.count > 0 && (
                    <Text style={[styles.reactionCount, themedStyles.colorText]}>
                      {smileReactionStatus.count}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
              
              {/* Profile pictures of users who reacted */}
              <View style={styles.reactionProfilePics}>
                {specialReactionStatuses.map(({ type: reactionType, status: reactionStatus }) => {
                  
                  return (
                    <View key={reactionType} style={styles.reactionTypeContainer}>
                      <View style={styles.reactionIcon}>
                        {reactionType === 'heart' ? <Heart size={12} color="#ef4444" /> : reactionType === 'star' ? <Star size={12} color="#fbbf24" /> : reactionType === 'smile' ? <Smile size={12} color="#8b5cf6" /> : null}
                      </View>
                      <View style={styles.profilePicsRow}>
                        {Array.isArray(reactionStatus.users) && reactionStatus.users
                          .slice(0, 3)
                          .filter((userEmail: string) => userEmail && typeof userEmail === 'string')
                          .map((userEmail: string, index: number) => {
                          // Find the team member for this email
                          const teamMember = teamMembersByEmail.get(
                            normalizeParticipantEmail(userEmail)
                          );
                          const profileUrl = getProfilePictureURL(teamMember);
                          
                          return (
                            <View 
                              key={`${userEmail}-${index}`} 
                              style={[
                                styles.miniProfilePic,
                                { marginLeft: index > 0 ? -6 : 0 }
                              ]}
                            >
                              {profileUrl ? (
                                <Image 
                                  source={{ uri: profileUrl }} 
                                  style={styles.miniProfilePicImage}
                                />
                              ) : (
                                <View style={[styles.miniProfilePicPlaceholder, { backgroundColor: theme.primary }]}>
                                  <Text style={styles.miniProfilePicText}>
                                    {getSafeDisplayInitial(teamMember?.name || userEmail || 'U')}
                                  </Text>
                                </View>
                              )}
                            </View>
                          );
                        })}
                        {reactionStatus.count > 3 && (
                          <View style={[styles.miniProfilePic, styles.miniProfilePicMore]}>
                            <Text style={[styles.miniProfilePicText, themedStyles.colorText]}>
                              +{reactionStatus.count - 3}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          </View>
        </AnimatedMessageWrapper>
      );
    }

    // Handle sticker messages
    if (msg.sticker) {
      const originalStickerUrl = msg.sticker.url;
      const stickerDisplayUrl =
        Platform.OS === 'web'
          ? originalStickerUrl
          : (stickerUrlMap.get(originalStickerUrl) || originalStickerUrl);
      const stickerIsUnavailable =
        brokenFileUrls.has(stickerDisplayUrl) ||
        (msg.sticker.pack === 'system' && !originalStickerUrl);

      return (
        <AnimatedMessageWrapper 
          key={`sticker-${msg.id}`}
          isNewMessage={isNewMessage} 
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
          isFocused={isFocused}
          globalAnimatedMessages={globalAnimatedMessages}
        >
          <View
            key={msg.id}
            style={[
              styles.messageContainer,
              isOwnMessage ? styles.ownMessage : styles.friendMessage,
            ]}
          >
            {shouldRenderMessageReply && (
              <MessageReplySnippet
                senderLabel={messageReplySenderLabel}
                previewText={messageReplyPreview}
                isOwnMessage={isOwnMessage}
                theme={theme}
                isDarkMode={isDarkMode}
                onJump={() => void jumpToReplyMessage(messageReplyContext)}
              />
            )}
            <TouchableOpacity
              style={[
                styles.stickerContainer,
                styles.messageActionAnchor,
                isReplyJumpHighlighted && styles.replyJumpHighlightGlow,
                isConversationSearchHighlighted && styles.messageSearchHighlightGlow,
                isOwnMessage ? styles.ownSticker : styles.friendSticker
              ]}
              onLongPress={(event) => handleMessageLongPress(msg.id, event)}
              onPress={getQuickTapReactionHandler(msg.id)}
              delayLongPress={500}
              disabled={actionPending}
            >
              {stickerIsUnavailable ? (
                // Show emoji text for system emoji stickers or placeholder for broken stickers
                msg.sticker.pack === 'system' ? (
                  <View style={styles.emojiStickerContainer}>
                    <Text style={[
                      styles.emojiStickerText,
                      {
                        fontSize: Math.min(msg.sticker.width || 100, 100) * 0.8, // Scale emoji based on size
                      }
                    ]}>
                      {msg.sticker.name}
                    </Text>
                  </View>
                ) : (
                  <View style={[styles.deletedStickerPlaceholder, themedStyles.deletedPlaceholder]}>
                    <AlertCircle size={32} color={theme.textSecondary} />
                    <Text style={[styles.deletedStickerText, themedStyles.colorTextSecondary]}>
                      Sticker unavailable
                    </Text>
                  </View>
                )
              ) : (
                <ProgressiveImage
                  uri={stickerDisplayUrl}
                  style={[
                    styles.stickerImage,
                    {
                      width: Math.min(msg.sticker.width || 200, 200),
                      height: Math.min(msg.sticker.height || 200, 200),
                    },
                  ]}
                  resizeMode="contain"
                  onError={async () => {
                    if (Platform.OS !== 'web') {
                      const alt = await resolveNativeSafeStickerUrl(originalStickerUrl);
                      if (alt && alt !== stickerDisplayUrl) return;
                    }
                    handleImageError(stickerDisplayUrl);
                  }}
                />
              )}
              
              {/* Sticker timestamp and status */}
              <View style={[
                styles.stickerFooter,
                isOwnMessage ? styles.ownStickerFooter : styles.friendStickerFooter
              ]}>
                <Text style={[
                  styles.stickerTime,
                  themedStyles.colorTextSecondary
                ]}>
                  {messageTimestampLabel}
                </Text>
                {/* Show status ticks only for own stickers */}
                {isOwnMessage && (
                  <MessageStatusTicks 
                    delivered={msg.delivered}
                    deliveredAt={msg.deliveredAt}
                    read={msg.read}
                    readAt={msg.readAt}
                    color={theme.textSecondary}
                    size={12}
                    theme={isDarkMode ? 'dark' : 'light'}
                  />
                )}
              </View>
              {pendingOverlay}
            </TouchableOpacity>
            
            {/* Sticker reactions display */}
            {hasMessageReactionPills && (
              <MessageReactionPills
                pills={messageReactionPills}
                isOwnMessage={isOwnMessage}
                theme={theme}
                messageId={msg.id}
                getReactionPressHandler={getReactionPressHandler}
                themedStyles={themedStyles as any}
              />
            )}
          </View>
        </AnimatedMessageWrapper>
      );
    }

    // Handle GIF messages (similar to stickers)
    if (msg.gif) {
      const originalGifUrl = msg.gif.url;
      const gifDisplayUrl =
        Platform.OS === 'web'
          ? originalGifUrl
          : (gifUrlMap.get(originalGifUrl) || originalGifUrl);
      const gifIsUnavailable = brokenFileUrls.has(originalGifUrl);

      return (
        <AnimatedMessageWrapper 
          key={`gif-${msg.id}`}
          isNewMessage={isNewMessage} 
          messageId={msg.id}
          isIncomingMessage={!isOwnMessage}
          isFocused={isFocused}
          globalAnimatedMessages={globalAnimatedMessages}
        >
          <View
            key={msg.id}
            style={[
              styles.messageContainer,
              isOwnMessage ? styles.ownMessage : styles.friendMessage,
            ]}
          >
            {shouldRenderMessageReply && (
              <MessageReplySnippet
                senderLabel={messageReplySenderLabel}
                previewText={messageReplyPreview}
                isOwnMessage={isOwnMessage}
                theme={theme}
                isDarkMode={isDarkMode}
                onJump={() => void jumpToReplyMessage(messageReplyContext)}
              />
            )}
            <TouchableOpacity
              style={[
                styles.stickerContainer,
                styles.messageActionAnchor,
                isReplyJumpHighlighted && styles.replyJumpHighlightGlow,
                isConversationSearchHighlighted && styles.messageSearchHighlightGlow,
                isOwnMessage ? styles.ownSticker : styles.friendSticker
              ]}
              onLongPress={(event) => handleMessageLongPress(msg.id, event)}
              onPress={getQuickTapReactionHandler(msg.id)}
              delayLongPress={500}
              disabled={actionPending}
            >
              {gifIsUnavailable ? (
                // Show placeholder for broken/missing GIFs
                <View style={[styles.deletedStickerPlaceholder, themedStyles.deletedPlaceholder]}>
                  <AlertCircle size={32} color={theme.textSecondary} />
                  <Text style={[styles.deletedStickerText, themedStyles.colorTextSecondary]}>
                    GIF unavailable
                  </Text>
                </View>
              ) : (
                <ProgressiveImage
                  uri={gifDisplayUrl}
                  style={[
                    styles.stickerImage,
                    {
                      width: Math.min(msg.gif.width || 200, 200),
                      height: Math.min(msg.gif.height || 200, 200),
                    },
                  ]}
                  resizeMode="contain"
                  onError={async () => {
                    if (Platform.OS !== 'web') {
                      const alt = await resolveOptimizedGifUrl(originalGifUrl);
                      if (alt && alt !== gifDisplayUrl) return;
                    }
                    handleImageError(originalGifUrl);
                  }}
                />
              )}
              
              {/* GIF timestamp and status */}
              <View style={[
                styles.stickerFooter,
                isOwnMessage ? styles.ownStickerFooter : styles.friendStickerFooter
              ]}>
                <Text style={[
                  styles.stickerTime,
                  themedStyles.colorTextSecondary
                ]}>
                  {messageTimestampLabel}
                </Text>
                {/* Show status ticks only for own GIFs */}
                {isOwnMessage && (
                  <MessageStatusTicks 
                    delivered={msg.delivered}
                    deliveredAt={msg.deliveredAt}
                    read={msg.read}
                    readAt={msg.readAt}
                    color={theme.textSecondary}
                    size={12}
                    theme={isDarkMode ? 'dark' : 'light'}
                  />
                )}
              </View>
              {pendingOverlay}
            </TouchableOpacity>
            
            {/* GIF reactions display */}
            {hasMessageReactionPills && (
              <MessageReactionPills
                pills={messageReactionPills}
                isOwnMessage={isOwnMessage}
                theme={theme}
                messageId={msg.id}
                getReactionPressHandler={getReactionPressHandler}
                themedStyles={themedStyles as any}
              />
            )}
          </View>
        </AnimatedMessageWrapper>
      );
    }

    // Regular text messages
    return (
      <AnimatedMessageWrapper 
        key={`message-${msg.id}`}
        isNewMessage={isNewMessage} 
        messageId={msg.id}
        isIncomingMessage={!isOwnMessage}
        isFocused={isFocused}
        globalAnimatedMessages={globalAnimatedMessages}
      >
        <View
          key={msg.id}
          style={[
            styles.messageContainer,
            isOwnMessage ? styles.ownMessage : styles.friendMessage,
          ]}
        >
          <TouchableOpacity
            style={[
              styles.messageBubble,
              styles.messageActionAnchor,
              isOwnMessage
                ? [styles.ownBubble, themedStyles.bgPrimary]
                : [
                    styles.friendBubble,
                    themedStyles.friendBubble,
                  ],
              isEditingTarget && (isOwnMessage ? themedStyles.editBorderOwn : themedStyles.editBorderFriend),
              isEditingTarget && styles.editingMessageGlow,
              isReplyJumpHighlighted && styles.replyJumpHighlightGlow,
              isConversationSearchHighlighted && styles.messageSearchHighlightGlow,
            ]}
            onLongPress={(event) => handleMessageLongPress(msg.id, event)}
            onPress={getQuickTapReactionHandler(msg.id)}
            delayLongPress={500}
            disabled={actionPending}
          >
            {isEditingTarget && (
              <View style={styles.editingTag}>
                <Edit3 size={14} color="#ffffff" />
                <Text style={styles.editingTagText}>Editing</Text>
              </View>
            )}
            {shouldRenderMessageReply && (
              <MessageReplySnippet
                senderLabel={messageReplySenderLabel}
                previewText={messageReplyPreview}
                isOwnMessage={isOwnMessage}
                theme={theme}
                isDarkMode={isDarkMode}
                onJump={() => void jumpToReplyMessage(messageReplyContext)}
              />
            )}
            {/* File attachments */}
            {shouldRenderAttachmentSection && (
              <View style={styles.fileContainer}>
                {attachmentsHydrating && (
                  <View style={[styles.attachmentSkeleton, { backgroundColor: skeletonBackgroundColor, borderColor: skeletonBorderColor }]}>
                    <ActivityIndicator size="small" color={theme.primary} />
                    <View style={styles.attachmentSkeletonTextContainer}>
                      <Text style={[styles.attachmentSkeletonText, { color: skeletonTextColor }]}>{attachmentHydrationLabel}</Text>
                      <Text style={[styles.attachmentSkeletonSubtext, { color: skeletonSubtextColor }]}>Large files may take a moment to appear.</Text>
                    </View>
                  </View>
                )}

                {hasAttachmentContent && (
                  <>
                    {/* Handle new multiple attachments format */}
                    {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (msg.attachments as HydratedAttachment[]).map((attachment, index: number) => (
                      <View
                        key={index}
                        style={[
                          styles.attachmentWrapper,
                          index < msg.attachments.length - 1 ? styles.marginBottom8 : null
                        ]}
                      >
                        {brokenFileUrls.has(attachment.url) ? (
                          // Show placeholder for deleted/missing files
                          <View style={[styles.deletedFileAttachment, themedStyles.deletedPlaceholder]}>
                            <AlertCircle size={24} color={theme.textSecondary} />
                            <View style={styles.fileInfo}>
                              <Text style={[styles.fileName, themedStyles.colorTextSecondary]} numberOfLines={1}>
                                {sanitizeAttachmentFileName(attachment.fileName)}
                              </Text>
                              <Text style={[styles.fileSize, themedStyles.colorTextSecondary]}> 
                                File no longer available
                              </Text>
                            </View>
                          </View>
                        ) : isVideoFile(attachment.fileType, attachment.fileName) ? (() => {
                          // Requirement 7.2: always use the safe source (transcodedUrl when present).
                          // The original attachment.url is kept ONLY as a stable identity key
                          // (downloadKey) — it is never used as a playback or network source.
                          const { source: videoSource } = resolveVideoSource(attachment);
                          return (
                            <FileViewer
                              fileUrl={videoSource}
                              fileName={attachment.fileName || 'Video File'}
                              fileType={attachment.fileType || ''}
                              fileSize={attachment.fileSize}
                              onDownload={getAttachmentDownloadPressHandler(attachment, attachment.fileName || 'Video File')}
                              downloadKey={getDownloadKey(attachment.url)}
                              remoteFileUrl={videoSource}
                              transcodedUri={attachment.transcodedUrl}
                              // Use FileViewer's built-in ShareModal
                            />
                          );
                        })()
                        : isImageFile(attachment.fileType, attachment.fileName) ? (
                          <TouchableOpacity onPress={getAttachmentImageViewPressHandler(attachment)}>
                            <ProgressiveImage
                              uri={attachment.resolvedUrl || attachment.url}
                              style={styles.imageAttachment}
                              onError={() => handleImageError(attachment.url)}
                            />
                            <View style={styles.imageOverlay}>
                              <Eye size={20} color="#ffffff" />
                            </View>
                          </TouchableOpacity>
                        ) : (
                          <FileViewer
                            fileUrl={attachment.resolvedUrl || attachment.url}
                            fileName={attachment.fileName || 'File'}
                            fileType={attachment.fileType || ''}
                            fileSize={attachment.fileSize}
                            onDownload={getAttachmentDownloadPressHandler(attachment, attachment.fileName || 'File')}
                            downloadKey={getDownloadKey(attachment.url)}
                            remoteFileUrl={attachment.url}
                            // Use FileViewer's built-in ShareModal
                          />
                        )}
                        {networkErrorUrls.has(attachment.url) && !brokenFileUrls.has(attachment.url) && (
                          <View style={[styles.networkErrorAttachment, themedStyles.deletedPlaceholder]}>
                            <View style={styles.networkErrorInfo}>
                              <AlertCircle size={16} color={theme.textSecondary} />
                              <Text style={[styles.networkErrorText, themedStyles.colorTextSecondary]}>Network error. Tap retry.</Text>
                            </View>
                            <TouchableOpacity
                              style={[styles.networkErrorRetryButton, themedStyles.borderPrimary]}
                              onPress={getAttachmentDownloadPressHandler(attachment, attachment.fileName || 'File')}
                            >
                              <RotateCcw size={14} color={theme.primary} />
                              <Text style={[styles.networkErrorRetryText, themedStyles.colorPrimary]}>Retry</Text>
                            </TouchableOpacity>
                          </View>
                        )}
                      </View>
                    ))}
                  </>
                )}
              </View>
            )}
            
            {/* Message text */}
            {shouldRenderRegularText && (
              <StyledText
                text={regularMessageText}
                style={[
                  styles.messageText,
                  isOwnMessage ? styles.ownMessageText : [styles.friendMessageText, themedStyles.colorText]
                ]}
                linkStyle={isOwnMessage ? themedStyles.linkStyleOwn : themedStyles.linkStylePrimary}
                highlightQuery={inlineConversationSearchHighlightQuery}
                highlightStyle={isOwnMessage ? styles.searchInlineHighlightOwn : undefined}
              />
            )}
            
            {/* Message timestamp and status */}
            <View style={[
              styles.messageFooter,
              isOwnMessage ? styles.ownMessageFooter : styles.friendMessageFooter
            ]}>
              {wasEdited && (
                <Text
                  style={[
                    styles.messageMeta,
                    isOwnMessage ? styles.messageMetaOwn : styles.messageMetaFriend,
                  ]}
                >
                  Edited
                </Text>
              )}
              <Text style={[
                styles.messageTime,
                isOwnMessage ? styles.ownMessageTime : [styles.friendMessageTime, themedStyles.colorTextSecondary]
              ]}>
                {messageTimestampLabel}
              </Text>
              {/* Show status ticks only for own messages */}
              {isOwnMessage && (
                <MessageStatusTicks 
                  delivered={msg.delivered}
                  deliveredAt={msg.deliveredAt}
                  read={msg.read}
                  readAt={msg.readAt}
                  color={isOwnMessage ? 'rgba(255, 255, 255, 0.7)' : theme.textSecondary}
                  size={12}
                  theme={isDarkMode ? 'dark' : 'light'}
                />
              )}
            </View>
            {pendingOverlay}
          </TouchableOpacity>
          
          {/* Message reactions display */}
          {hasMessageReactionPills && (
            <MessageReactionPills
              pills={messageReactionPills}
              isOwnMessage={isOwnMessage}
              theme={theme}
              messageId={msg.id}
              getReactionPressHandler={getReactionPressHandler}
              themedStyles={themedStyles as any}
            />
          )}
        </View>
      </AnimatedMessageWrapper>
    );

});

ChatMessageItem.displayName = 'ChatMessageItem';

export default ChatMessageItem;
