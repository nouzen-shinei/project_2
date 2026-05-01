import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { MessageStatusTicks } from '../../components';

export interface MessageFooterProps {
  timestamp: string;
  isOwnMessage: boolean;
  wasEdited: boolean;
  delivered?: boolean;
  deliveredAt?: string;
  read?: boolean;
  readAt?: string;
  theme: any;
  isDarkMode: boolean;
}

/**
 * MessageFooter — shared timestamp + "Edited" label + status ticks component.
 *
 * Previously duplicated across sticker/GIF/text message branches with slight
 * style variations.  This unified component handles all three cases via the
 * `isOwnMessage` flag.
 */
const MessageFooter = React.memo(function MessageFooter({
  timestamp,
  isOwnMessage,
  wasEdited,
  delivered,
  deliveredAt,
  read,
  readAt,
  theme,
  isDarkMode,
}: MessageFooterProps) {
  return (
    <View
      style={[
        footerStyles.container,
        isOwnMessage ? footerStyles.own : footerStyles.friend,
      ]}
    >
      {wasEdited && (
        <Text
          style={[
            footerStyles.meta,
            isOwnMessage ? footerStyles.metaOwn : footerStyles.metaFriend,
          ]}
        >
          Edited
        </Text>
      )}
      <Text
        style={[
          footerStyles.time,
          isOwnMessage
            ? footerStyles.ownTime
            : [footerStyles.friendTime, { color: theme.textSecondary }],
        ]}
      >
        {timestamp}
      </Text>
      {isOwnMessage && (
        <MessageStatusTicks
          delivered={delivered}
          deliveredAt={deliveredAt}
          read={read}
          readAt={readAt}
          color={isOwnMessage ? 'rgba(255, 255, 255, 0.7)' : theme.textSecondary}
          size={12}
          theme={isDarkMode ? 'dark' : 'light'}
        />
      )}
    </View>
  );
});

MessageFooter.displayName = 'MessageFooter';

const footerStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  own: {
    justifyContent: 'flex-end',
  },
  friend: {
    justifyContent: 'flex-start',
  },
  meta: {
    fontSize: 10,
    fontFamily: 'Inter-Regular',
    fontStyle: 'italic',
    marginRight: 4,
  },
  metaOwn: {
    color: 'rgba(255, 255, 255, 0.6)',
  },
  metaFriend: {
    color: '#94a3b8',
  },
  time: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },
  ownTime: {
    color: 'rgba(255, 255, 255, 0.7)',
  },
  friendTime: {
    // color set dynamically via theme
  },
});

export default MessageFooter;
