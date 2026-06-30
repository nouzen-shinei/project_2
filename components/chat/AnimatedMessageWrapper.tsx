import React, { useRef, useEffect } from 'react';
import { Animated, Easing, Platform } from 'react-native';

export interface AnimatedMessageWrapperProps {
  children: React.ReactNode;
  isNewMessage: boolean;
  messageId: string;
  isIncomingMessage?: boolean;
  isFocused: boolean;
  /** Shared ref tracking which message IDs have already been animated */
  globalAnimatedMessages: React.MutableRefObject<Set<string>>;
}

/**
 * AnimatedMessageWrapper – provides entrance animations for new chat messages.
 *
 * Extracted to a top-level module so that its component identity is stable across
 * parent re-renders.  This is critical for FlashList row recycling – when the
 * component was defined *inside* the Chat function body, React.memo still
 * produced a **new component type** on every render, defeating memoization and
 * forcing FlashList to unmount/remount rows.
 */
const AnimatedMessageWrapper = React.memo(function AnimatedMessageWrapper({
  children,
  isNewMessage,
  messageId,
  isIncomingMessage = false,
  isFocused,
  globalAnimatedMessages,
}: AnimatedMessageWrapperProps) {
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const slideYAnim = useRef(new Animated.Value(0)).current;
  const slideXAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  // FlashList recycles rows; reset transforms for rows that should not animate.
  useEffect(() => {
    if (!isNewMessage || !isFocused) {
      fadeAnim.setValue(1);
      slideYAnim.setValue(0);
      slideXAnim.setValue(0);
      scaleAnim.setValue(1);
    }
  }, [isNewMessage, isFocused, fadeAnim, slideYAnim, slideXAnim, scaleAnim]);

  // Run entrance animation exactly once per messageId.
  useEffect(() => {
    if (isNewMessage && !globalAnimatedMessages.current.has(messageId)) {
      globalAnimatedMessages.current.add(messageId);

      // Smooth, WhatsApp-style entrance: messages rise into place with a fade
      // and gentle scale. We avoid horizontal motion (it reads as a jerk on
      // recycled rows); the side alignment already comes from the row styles.
      const enterOffsetX = 0;
      const enterOffsetY = isIncomingMessage ? 16 : 12;
      const enterScale = isIncomingMessage ? 0.96 : 0.975;
      const fadeDuration = isIncomingMessage ? 300 : 240;
      const slideXDuration = isIncomingMessage ? 300 : 240;
      const slideYDuration = isIncomingMessage ? 340 : 280;
      const scaleDuration = isIncomingMessage ? 320 : 260;

      // Reset animation values for entrance animation
      fadeAnim.setValue(0);
      slideYAnim.setValue(enterOffsetY);
      slideXAnim.setValue(enterOffsetX);
      scaleAnim.setValue(enterScale);

      // Animate the message entrance
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: fadeDuration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(slideXAnim, {
          toValue: 0,
          duration: slideXDuration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(slideYAnim, {
          toValue: 0,
          duration: slideYDuration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: scaleDuration,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ]).start();
    }
  }, [
    isNewMessage,
    messageId,
    fadeAnim,
    slideXAnim,
    slideYAnim,
    scaleAnim,
    isIncomingMessage,
    isFocused,
    globalAnimatedMessages,
  ]);

  return (
    <Animated.View
      style={{
        opacity: fadeAnim,
        transform: [
          { translateX: slideXAnim },
          { translateY: slideYAnim },
          { scale: scaleAnim },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
});

AnimatedMessageWrapper.displayName = 'AnimatedMessageWrapper';

export default AnimatedMessageWrapper;
