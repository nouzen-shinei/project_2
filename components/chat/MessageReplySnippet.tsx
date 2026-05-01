import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

export interface MessageReplySnippetProps {
  senderLabel: string;
  previewText: string;
  isOwnMessage: boolean;
  theme: any;
  isDarkMode: boolean;
  onJump: () => void;
  /** 'standard' (default) uses theme.primary; 'special' uses theme.warning */
  variant?: 'standard' | 'special';
}

/**
 * MessageReplySnippet — shared reply-to context preview used across all message types.
 *
 * Previously duplicated in 4 branches of renderMessage (~80 lines × 4 = 320 lines).
 */
const MessageReplySnippet = React.memo(function MessageReplySnippet({
  senderLabel,
  previewText,
  isOwnMessage,
  theme,
  isDarkMode,
  onJump,
  variant = 'standard',
}: MessageReplySnippetProps) {
  const isSpecial = variant === 'special';
  const accentColor = isSpecial ? theme.warning : theme.primary;
  const friendBg = isSpecial
    ? (isDarkMode ? 'rgba(255, 255, 255, 0.06)' : '#fff9ef')
    : (isDarkMode ? 'rgba(255, 255, 255, 0.06)' : '#f7f9ff');

  return (
    <TouchableOpacity
      style={[
        replyStyles.snippet,
        isOwnMessage
          ? [replyStyles.snippetOwn, { borderLeftColor: 'rgba(255, 255, 255, 0.7)' }]
          : [
              replyStyles.snippetFriend,
              {
                borderLeftColor: accentColor,
                backgroundColor: friendBg,
              },
            ],
      ]}
      activeOpacity={0.85}
      onPress={onJump}
    >
      <Text
        style={[
          replyStyles.sender,
          isOwnMessage ? replyStyles.senderOwn : { color: accentColor },
        ]}
        numberOfLines={1}
      >
        {senderLabel}
      </Text>
      <Text
        style={[
          replyStyles.text,
          isOwnMessage ? replyStyles.textOwn : { color: theme.textSecondary },
        ]}
        numberOfLines={1}
      >
        {previewText}
      </Text>
    </TouchableOpacity>
  );
});

MessageReplySnippet.displayName = 'MessageReplySnippet';

const replyStyles = StyleSheet.create({
  snippet: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderLeftWidth: 3,
    borderRadius: 6,
    marginBottom: 6,
  },
  snippetOwn: {
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
  snippetFriend: {
    // backgroundColor set dynamically
  },
  sender: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 2,
  },
  senderOwn: {
    color: 'rgba(255, 255, 255, 0.9)',
  },
  text: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
  },
  textOwn: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
});

export default MessageReplySnippet;
