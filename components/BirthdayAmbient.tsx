import React, { useEffect, useMemo } from 'react';
import { View, Text, Dimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { useBirthdays } from './BirthdayProvider';

const { width, height } = Dimensions.get('window');
const EMOJIS = ['🎉', '🎈', '🎊', '✨', '🎂', '💫', '🌟'];

type Particle = {
  x: number;
  delay: number;
  duration: number;
  size: number;
  drift: number;
  emoji: string;
};

function Floater({ p }: { p: Particle }) {
  const y = useSharedValue(-60);
  const t = useSharedValue(0);

  useEffect(() => {
    y.value = withDelay(
      p.delay,
      withRepeat(withTiming(height + 60, { duration: p.duration, easing: Easing.linear }), -1, false)
    );
    t.value = withDelay(
      p.delay,
      withRepeat(withTiming(1, { duration: p.duration * 0.6, easing: Easing.inOut(Easing.sin) }), -1, true)
    );
  }, [p.delay, p.duration, y, t]);

  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: p.x + Math.sin(t.value * Math.PI * 2) * p.drift,
    top: y.value,
    transform: [{ rotate: `${(t.value - 0.5) * 40}deg` }],
    opacity: 0.9,
  }));

  return (
    <Animated.View style={style}>
      <Text style={{ fontSize: p.size }}>{p.emoji}</Text>
    </Animated.View>
  );
}

export default function BirthdayAmbient() {
  const { hasCelebration, isMusicPlaying } = useBirthdays();
  const shouldShowAmbient = hasCelebration && isMusicPlaying;

  const particles: Particle[] = useMemo(() => {
    if (!shouldShowAmbient) return [];

    const arr: Particle[] = [];
    const count = 16; // light but lively
    for (let i = 0; i < count; i++) {
      const x = Math.random() * width;
      const delay = Math.floor(Math.random() * 3000);
      const duration = 9000 + Math.floor(Math.random() * 6000); // 9s–15s
      const size = 18 + Math.floor(Math.random() * 18); // 18–36
      const drift = 20 + Math.random() * 40; // side sway
      const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
      arr.push({ x, delay, duration, size, drift, emoji });
    }
    return arr;
  }, [shouldShowAmbient]);

  if (!shouldShowAmbient) return null;

  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 }}>
      {particles.map((p, idx) => (
        <View pointerEvents="none" key={`bday-fx-${idx}`}>
          <Floater p={p} />
        </View>
      ))}
    </View>
  );
}
