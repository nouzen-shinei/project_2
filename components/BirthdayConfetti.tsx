import React, { useContext, useEffect, useState } from 'react';
import { View, Dimensions, Text } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { BirthdayContext } from './BirthdayProvider';

const { width, height } = Dimensions.get('window');

type Particle = { x: number; y: number; vx: number; vy: number; rot: number; size: number; emoji: string };

function ConfettiPiece({ p, progress }: { p: Particle; progress: Animated.SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    position: 'absolute',
    left: p.x + p.vx * 60 * progress.value,
    top: p.y + (p.vy * 60 + 200 * progress.value * progress.value),
    transform: [{ rotate: `${p.rot * progress.value * 180}deg` }],
    opacity: 1 - progress.value,
  }));
  return (
    <Animated.View style={style}>
      <Text style={{ fontSize: p.size }}>{p.emoji}</Text>
    </Animated.View>
  );
}

export default function BirthdayConfetti() {
  const ctx = useContext(BirthdayContext);
  const hasContext = Boolean(ctx);
  const confettiBurstKey = ctx?.confettiBurstKey ?? 0;
  const [particles, setParticles] = useState<Particle[]>([]);
  const [visible, setVisible] = useState(false);
  const progress = useSharedValue(0);

  // (Removed verbose BirthdayConfetti render debug log)

  useEffect(() => {
    if (!hasContext || confettiBurstKey === 0) return;
  // (Removed confetti burst trigger log)
    // generate burst from top-center area
    const n = 40;
    const emojis = ['🎉', '🎈', '🎊', '✨', '🎂', '🎁'];
    const arr: Particle[] = [];
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 4;
      arr.push({
        x: width * 0.5,
        y: height * 0.25,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1, // slight upward bias
        rot: (Math.random() - 0.5) * 2,
        size: 18 + Math.random() * 14,
        emoji: emojis[Math.floor(Math.random() * emojis.length)],
      });
    }
    setParticles(arr);
    setVisible(true);
  // (Removed visibility + particles count log)
    progress.value = 0;
    progress.value = withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) });
    const t = setTimeout(() => {
  // (Removed auto-hide log)
      setVisible(false);
    }, 1500);
    return () => clearTimeout(t);
  }, [confettiBurstKey, hasContext, progress]);

  // (Removed pre-render particles debug log)

  if (!hasContext) return null;
  if (particles.length === 0) return null;

  return (
    <View style={{ display: visible ? 'flex' : 'none', position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 10001, pointerEvents: 'none' }}>
      {particles.map((p, i) => (
        <ConfettiPiece key={`burst-${i}`} p={p} progress={progress} />
      ))}
    </View>
  );
}
