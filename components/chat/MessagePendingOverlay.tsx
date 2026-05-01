import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';

export interface MessagePendingOverlayProps {
  isPending?: boolean;
  isOwnMessage: boolean;
}

/**
 * MessagePendingOverlay — translucent overlay shown on messages while an
 * action (e.g. delete) is pending server confirmation.
 *
 * Previously inline in renderMessage with identical JSX in every branch.
 */
const MessagePendingOverlay = React.memo(function MessagePendingOverlay({
  isPending,
  isOwnMessage,
}: MessagePendingOverlayProps) {
  if (!isPending) return null;

  return (
    <View
      style={[
        overlayStyles.container,
        {
          backgroundColor: isOwnMessage
            ? 'rgba(0, 0, 0, 0.35)'
            : 'rgba(0, 0, 0, 0.25)',
          pointerEvents: 'none',
        },
      ]}
    >
      <ActivityIndicator size="small" color="#ffffff" />
      <Text style={overlayStyles.text}>Removing…</Text>
    </View>
  );
});

MessagePendingOverlay.displayName = 'MessagePendingOverlay';

const overlayStyles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  text: {
    color: '#ffffff',
    fontSize: 13,
    fontFamily: 'Inter-Medium',
  },
});

export default MessagePendingOverlay;
