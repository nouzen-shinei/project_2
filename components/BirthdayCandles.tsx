import React, { useMemo } from 'react';
import { View, Dimensions, Platform } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useBirthdays } from './BirthdayProvider';

const { width } = Dimensions.get('window');

function Candle({ x, height = 34, color = '#FFEFD5', delay = 0 }: { x: number; height?: number; color?: string; delay?: number }) {
  // Flicker shared values per candle
  const flicker = useSharedValue(0);
  const glow = useSharedValue(0);

  // Start subtle randomized flicker
  React.useEffect(() => {
    const duration = 800 + Math.floor(Math.random() * 700); // 0.8–1.5s
    flicker.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.sin) }), -1, true)
    );
    glow.value = withDelay(
      delay / 2,
      withRepeat(withTiming(1, { duration: duration * 0.9, easing: Easing.inOut(Easing.sin) }), -1, true)
    );
  }, [delay, flicker, glow]);

  const flameStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -6 + (flicker.value - 0.5) * 2 },
      { translateX: (flicker.value - 0.5) * 2 },
      { scale: 0.95 + flicker.value * 0.1 },
    ],
    opacity: 0.9 + (flicker.value - 0.5) * 0.1,
  }));

  const glowStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.9 + glow.value * 0.25 }],
    opacity: 0.35 + glow.value * 0.25,
  }));

  // Candle body and wick
  return (
    <View style={{ position: 'absolute', bottom: 0, left: x - 8 }}>
      {/* Glow behind flame */}
      <Animated.View style={[{ position: 'absolute', bottom: height + 24, left: -12, width: 48, height: 48, borderRadius: 24 }, glowStyle]}>
        <LinearGradient
          colors={[ 'rgba(255, 200, 80, 0.85)', 'rgba(255, 180, 50, 0.35)', 'transparent' ]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={{ flex: 1, borderRadius: 24 }}
        />
      </Animated.View>

      {/* Flame */}
      <Animated.View style={[{ position: 'absolute', bottom: height + 20, left: 0, width: 16, height: 24, alignItems: 'center', justifyContent: 'flex-end' }, flameStyle]}>
        <LinearGradient
          colors={[ '#FFD27D', '#FFA500', '#FF6B00' ]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={{ width: 12, height: 18, borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomLeftRadius: 6, borderBottomRightRadius: 6, transform: [{ rotate: '-8deg' }] }}
        />
      </Animated.View>

      {/* Wick */}
      <View style={{ position: 'absolute', bottom: height + 18, left: 7, width: 2, height: 8, backgroundColor: '#333', borderRadius: 1 }} />

      {/* Candle body */}
      <View style={{ width: 16, height, borderRadius: 4, overflow: 'hidden', backgroundColor: color, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' }}>
        <LinearGradient
          colors={[ '#FFF8EE', color ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={{ flex: 1 }}
        />
        {/* Melt */}
        <View style={{ position: 'absolute', top: 6, left: 3, width: 4, height: 8, backgroundColor: '#FFF8EE', borderBottomLeftRadius: 6, borderBottomRightRadius: 6, opacity: 0.8 }} />
        <View style={{ position: 'absolute', top: 4, right: 3, width: 3, height: 6, backgroundColor: '#FFF8EE', borderBottomLeftRadius: 6, borderBottomRightRadius: 6, opacity: 0.7 }} />
      </View>
    </View>
  );
}

export default function BirthdayCandles() {
  const { hasCelebration } = useBirthdays();
  const tabBarHeight = Platform.OS === 'ios' ? 90 : 70;
  const count = 5;
  const spacing = width / (count + 1);
  const positions = useMemo(() => new Array(count).fill(0).map((_, i) => (i + 1) * spacing), [spacing]);

  if (!hasCelebration) return null;

  // Use pointerEvents=none so it never blocks touches on the tab bar
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: tabBarHeight + 6, height: 60, zIndex: 1000 }}>
      {positions.map((x, i) => (
        <Candle key={`candle-${i}`} x={x} height={30 + (i % 2) * 6} color={i % 2 === 0 ? '#FFEFD5' : '#FFF0D9'} delay={i * 120} />
      ))}
    </View>
  );
}
