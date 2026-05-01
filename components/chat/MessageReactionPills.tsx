import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { type ReactionPillDescriptor } from '@/lib/chatReactionUtils';

export interface MessageReactionPillsProps {
  pills: ReactionPillDescriptor[];
  isOwnMessage: boolean;
  theme: any;
  messageId: string;
  getReactionPressHandler: (messageId: unknown, reactionType: string) => () => void;
  /** Pre-computed themed style objects to avoid per-render allocations */
  themedStyles?: {
    reactionPillBase?: Record<string, unknown>;
    reactionPillSelected?: Record<string, unknown>;
  };
}

/**
 * MessageReactionPills — shared reaction pills row used across sticker, GIF,
 * and text message types.
 *
 * Previously duplicated in 3 branches of renderMessage (~25 lines × 3 = 75 lines).
 */
const MessageReactionPills = React.memo(function MessageReactionPills({
  pills,
  isOwnMessage,
  theme,
  messageId,
  getReactionPressHandler,
  themedStyles,
}: MessageReactionPillsProps) {
  if (pills.length === 0) return null;

  const pillBaseStyle = themedStyles?.reactionPillBase ?? {
    backgroundColor: theme.background,
    borderColor: theme.border,
  };
  const pillSelectedStyle = themedStyles?.reactionPillSelected ?? {
    backgroundColor: theme.primary + '20',
    borderColor: theme.primary,
  };

  return (
    <View
      style={[
        pillStyles.container,
        isOwnMessage ? pillStyles.alignEnd : pillStyles.alignStart,
      ]}
    >
      {pills.map((reaction, index) => (
        <TouchableOpacity
          key={index}
          style={[
            pillStyles.button,
            pillBaseStyle,
            reaction.hasUserReacted && [
              pillStyles.selected,
              pillSelectedStyle,
            ],
          ]}
          onPress={getReactionPressHandler(messageId, reaction.emoji)}
        >
          <Text style={pillStyles.emoji}>
            {reaction.emoji ? String(reaction.emoji) : '❤️'}
          </Text>
          <Text
            style={[
              pillStyles.count,
              { color: reaction.hasUserReacted ? theme.primary : theme.textSecondary },
            ]}
          >
            {Number(reaction.count || 0)}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
});

MessageReactionPills.displayName = 'MessageReactionPills';

const pillStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  alignEnd: {
    alignSelf: 'flex-end',
  },
  alignStart: {
    alignSelf: 'flex-start',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  selected: {
    // Overrides set dynamically
  },
  emoji: {
    fontSize: 14,
  },
  count: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
});

export default MessageReactionPills;
