import React, { useRef, useEffect } from 'react';
import { Animated, Easing, Platform } from 'react-native';

export interface AnimatedChatDividerProps {
  children: React.ReactNode;
  /**
   * Stable identity for the divider (e.g. the anchor message id). When it
   * changes, the entrance animation replays. A shared set guards against
   * replaying for the same id while a row recycles in FlashList.
   */
  animationKey: string;
  /** Shared ref tracking which divider keys have already animated in. */
  animatedKeys: React.MutableRefObject<Set<string>>;
}

/**
 * AnimatedChatDivider — gentle fade + rise entrance for the unread / "new
 * messages" separators, matching the smooth feel of big chat apps. Kept as a
 * top-level memoized component so its identity is stable across FlashList row
 * recycling. The first time a given `animationKey` is seen it animates in; on
 * subsequent mounts (row recycling, scroll-back) it renders settled with no
 * flicker.
 */
const AnimatedChatDivider = React.memo(function AnimatedChatDivider({
  children,
  animationKey,
  animatedKeys,
}: AnimatedChatDividerProps) {
  const alreadyAnimated =
    Boolean(animationKey) && animatedKeys.current.has(animationKey);

  const opacity = useRef(new Animated.Value(alreadyAnimated ? 1 : 0)).current;
  const translateY = useRef(new Animated.Value(alreadyAnimated ? 0 : -8)).current;
  const scale = useRef(new Animated.Value(alreadyAnimated ? 1 : 0.96)).current;

  useEffect(() => {
    if (!animationKey || animatedKeys.current.has(animationKey)) {
      opacity.setValue(1);
      translateY.setValue(0);
      scale.setValue(1);
      return;
    }

    animatedKeys.current.add(animationKey);

    opacity.setValue(0);
    translateY.setValue(-8);
    scale.setValue(0.96);

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(scale, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start();
  }, [animationKey, animatedKeys, opacity, translateY, scale]);

  return (
    <Animated.View
      style={{
        opacity,
        transform: [{ translateY }, { scale }],
      }}
    >
      {children}
    </Animated.View>
  );
});

AnimatedChatDivider.displayName = 'AnimatedChatDivider';

export default AnimatedChatDivider;
