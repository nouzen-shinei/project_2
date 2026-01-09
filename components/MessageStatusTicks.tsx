import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Check, AlertCircle, Clock3 } from 'lucide-react-native';

export interface MessageStatusTicksProps {
  delivered?: boolean;
  deliveredAt?: string | null;
  read?: boolean;
  readAt?: string | null;
  pending?: boolean;
  failed?: boolean;
  color?: string;
  readColor?: string;
  pendingColor?: string;
  failedColor?: string;
  size?: number;
  theme?: 'light' | 'dark';
  showPlaceholder?: boolean;
}

export const MessageStatusTicks: React.FC<MessageStatusTicksProps> = ({
  delivered = false,
  deliveredAt,
  read = false,
  readAt,
  pending = false,
  failed = false,
  color,
  readColor,
  pendingColor,
  failedColor,
  size = 12,
  theme = 'dark',
  showPlaceholder = false,
}) => {
  const resolvedTheme = theme === 'light' ? 'light' : 'dark';
  const baseColor = color ?? (resolvedTheme === 'light' ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 255, 255, 0.7)');
  const resolvedReadColor = readColor ?? (resolvedTheme === 'light' ? '#0F62FE' : '#4FC3F7');
  const resolvedPendingColor = pendingColor ?? (resolvedTheme === 'light' ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.55)');
  const resolvedFailedColor = failedColor ?? (resolvedTheme === 'light' ? '#DA1E28' : '#FF6B6B');
  const overlapOffset = -Math.max(2, size * 0.35);

  const isRead = Boolean(read || readAt);
  const isDelivered = isRead || Boolean(delivered || deliveredAt);
  const shouldShowSingle = !pending && !failed && !isDelivered && !isRead;

  const renderDoubleTick = (tickColor: string) => (
    <View style={styles.doubleTickContainer}>
      <Check size={size} color={tickColor} strokeWidth={2.8} style={[styles.firstTick, { marginLeft: overlapOffset }]} />
      <Check size={size} color={tickColor} strokeWidth={2.8} style={[styles.secondTick, { marginLeft: overlapOffset }]} />
    </View>
  );

  if (failed) {
    return (
      <View style={styles.container}>
        <AlertCircle size={size} color={resolvedFailedColor} strokeWidth={2.4} />
      </View>
    );
  }

  if (pending) {
    return (
      <View style={styles.container}>
        <Clock3 size={size} color={resolvedPendingColor} strokeWidth={2.6} />
      </View>
    );
  }

  if (isRead) {
    return <View style={styles.container}>{renderDoubleTick(resolvedReadColor)}</View>;
  }

  if (isDelivered) {
    return <View style={styles.container}>{renderDoubleTick(baseColor)}</View>;
  }

  if (shouldShowSingle) {
    return (
      <View style={styles.container}>
        <Check size={size} color={baseColor} strokeWidth={2.8} />
      </View>
    );
  }

  if (showPlaceholder) {
    return (
      <View style={styles.container}>
        <View style={{ width: size, height: size }} />
      </View>
    );
  }

  return null;
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginLeft: 4,
    minWidth: 16, // Ensure consistent spacing
  },
  doubleTickContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  firstTick: {
    zIndex: 1,
  },
  secondTick: {
    zIndex: 2,
  },
});

export default MessageStatusTicks;
