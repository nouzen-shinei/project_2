import React, { useEffect, useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { Play, RotateCcw } from 'lucide-react-native';

export type VideoBufferingOverlayPhase = 'loading' | 'buffering' | 'stalled' | 'ended' | 'error';

type VideoBufferingOverlayProps = {
  visible: boolean;
  phase: VideoBufferingOverlayPhase;
  title: string | null;
  subtitle?: string | null;
  bufferedPercent?: number | null;
  accentColor?: string;
  variant?: 'inline' | 'fullscreen';
  showSpinner?: boolean;
  showPercent?: boolean;
  onRetry?: () => void;
  onReplay?: () => void;
};

export function VideoBufferingOverlay({
  visible,
  phase,
  title,
  subtitle,
  bufferedPercent,
  accentColor = '#7c9dff',
  variant = 'inline',
  showSpinner = true,
  showPercent = true,
  onRetry,
  onReplay,
}: VideoBufferingOverlayProps) {
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.98);

  useEffect(() => {
    if (visible) {
      opacity.value = withTiming(1, { duration: 200 });
      scale.value = withSpring(1, { damping: 18, stiffness: 140 });
    } else {
      opacity.value = withTiming(0, { duration: 160 });
      scale.value = withTiming(0.98, { duration: 160 });
    }
  }, [opacity, scale, visible]);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));

  const backgroundColor = useMemo(() => {
    switch (phase) {
      case 'buffering':
        return 'rgba(8,12,24,0.4)';
      case 'stalled':
        return 'rgba(8,12,24,0.55)';
      case 'ended':
        return 'rgba(8,12,24,0.5)';
      case 'error':
        return 'rgba(6,10,24,0.7)';
      default:
        return 'rgba(8,12,24,0.65)';
    }
  }, [phase]);

  const isFullscreen = variant === 'fullscreen';
  const showPercentText =
    showPercent && typeof bufferedPercent === 'number' && Number.isFinite(bufferedPercent);
  const actionHandler = onRetry ?? onReplay;
  const actionLabel = onRetry ? 'Retry' : onReplay ? 'Replay' : null;
  const ActionIcon = onRetry ? RotateCcw : onReplay ? Play : null;
  const shouldHandleTouches = visible && !!actionHandler;

  return (
    <Reanimated.View
      style={[
        styles.overlay,
        isFullscreen ? styles.overlayFullscreen : null,
        { backgroundColor },
        overlayStyle,
      ]}
      pointerEvents={shouldHandleTouches ? 'auto' : 'none'}
    >
      <View style={[styles.badge, isFullscreen ? styles.badgeFullscreen : null]}>
        <View style={styles.badgeRow}>
          {showSpinner ? (
            <ActivityIndicator size={isFullscreen ? 'large' : 'small'} color={accentColor} />
          ) : null}
          <View style={styles.textGroup}>
            {title ? (
              <Text style={[styles.title, isFullscreen ? styles.titleFullscreen : null]}>{title}</Text>
            ) : null}
            {subtitle ? (
              <Text style={[styles.subtitle, isFullscreen ? styles.subtitleFullscreen : null]}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {showPercentText ? (
            <Text style={[styles.percent, isFullscreen ? styles.percentFullscreen : null]}>
              {Math.round(bufferedPercent)}%
            </Text>
          ) : null}
        </View>
        {actionHandler && actionLabel ? (
          <Pressable
            onPress={actionHandler}
            style={({ pressed }) => [
              styles.actionButton,
              isFullscreen ? styles.actionButtonFullscreen : null,
              pressed ? styles.actionButtonPressed : null,
            ]}
          >
            {ActionIcon ? <ActionIcon size={18} color="white" /> : null}
            <Text style={styles.actionText}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlayFullscreen: {
    paddingHorizontal: 24,
  },
  badge: {
    minWidth: 180,
    maxWidth: 260,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(15,20,32,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    gap: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  badgeFullscreen: {
    minWidth: 220,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 18,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  textGroup: {
    flex: 1,
  },
  title: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  titleFullscreen: {
    fontSize: 16,
  },
  subtitle: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
  },
  subtitleFullscreen: {
    fontSize: 13,
  },
  percent: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 12,
    fontWeight: '600',
  },
  percentFullscreen: {
    fontSize: 13,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  actionButtonFullscreen: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  actionButtonPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  actionText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '600',
  },
});
