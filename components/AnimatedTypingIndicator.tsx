import React, { useRef, useEffect } from 'react';
import { View, Animated, Platform, StyleSheet } from 'react-native';

interface AnimatedTypingIndicatorProps {
  color: string;
}

const AnimatedTypingIndicator: React.FC<AnimatedTypingIndicatorProps> = ({ color }) => {
  const dot1 = useRef(new Animated.Value(0.35)).current;
  const dot2 = useRef(new Animated.Value(0.35)).current;
  const dot3 = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const animateDot = (animatedValue: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animatedValue, {
            toValue: 1,
            duration: 260,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.timing(animatedValue, {
            toValue: 0.35,
            duration: 260,
            useNativeDriver: Platform.OS !== 'web',
          }),
          Animated.delay(120),
        ])
      );
    };

    const animation = Animated.parallel([
      animateDot(dot1, 0),
      animateDot(dot2, 200),
      animateDot(dot3, 400),
    ]);

    animation.start();

    return () => animation.stop();
  }, [dot1, dot2, dot3]);

  const dotStyle = (animatedValue: Animated.Value) => ({
    opacity: animatedValue,
    transform: [
      {
        translateY: animatedValue.interpolate({
          inputRange: [0.35, 1],
          outputRange: [0, -2],
        }),
      },
      {
        scale: animatedValue.interpolate({
          inputRange: [0.35, 1],
          outputRange: [0.9, 1.1],
        }),
      },
    ],
  });

  return (
    <View style={styles.typingIndicatorSmall}>
      <Animated.View style={[styles.typingDot, { backgroundColor: color }, dotStyle(dot1)]} />
      <Animated.View style={[styles.typingDot, { backgroundColor: color }, dotStyle(dot2)]} />
      <Animated.View style={[styles.typingDot, { backgroundColor: color }, dotStyle(dot3)]} />
    </View>
  );
};

const styles = StyleSheet.create({
  typingIndicatorSmall: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
});

export default AnimatedTypingIndicator;
