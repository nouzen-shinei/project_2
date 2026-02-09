import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View, StyleSheet, ViewStyle, StyleProp, AccessibilityInfo, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

interface SkeletonBarProps {
  style?: StyleProp<ViewStyle>;
  baseColor?: string;
  highlightColor?: string;
  duration?: number;
  paused?: boolean;
  respectReduceMotion?: boolean;
}

/**
 * SkeletonBar: A lightweight shimmer placeholder.
 * - Provide size via `style` (width/height/borderRadius).
 * - Colors can be themed via baseColor/highlightColor.
 */
export function SkeletonBar({
  style,
  baseColor = '#E1E6EB',
  highlightColor = '#F2F6FA',
  duration = 1200,
  paused = false,
  respectReduceMotion = true,
}: SkeletonBarProps) {
  const translate = useRef(new Animated.Value(0)).current;
  const loopRef = useRef<Animated.CompositeAnimation | null>(null);
  const [width, setWidth] = useState(160);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let cleanup: undefined | (() => void);

    const setupReduceMotion = async () => {
      try {
        if (Platform.OS === 'web' && typeof window !== 'undefined' && 'matchMedia' in window) {
          const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
          setReduceMotion(mql.matches);
          const handler = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
          // @ts-ignore addEventListener for modern browsers, addListener for older
          mql.addEventListener?.('change', handler) ?? mql.addListener?.(handler);
          cleanup = () => {
            // @ts-ignore removeEventListener fallback
            mql.removeEventListener?.('change', handler) ?? mql.removeListener?.(handler);
          };
        } else {
          const current = await AccessibilityInfo.isReduceMotionEnabled?.();
          if (typeof current === 'boolean') setReduceMotion(current);
          const onChange = (enabled: boolean) => setReduceMotion(enabled);
          // @ts-ignore RN API compatibility
          const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', onChange);
          cleanup = () => {
            // @ts-ignore RN API compatibility
            sub?.remove?.();
          };
        }
      } catch {
        // ignore
      }
    };

    setupReduceMotion();

    return () => {
      // Ensure any running loop is stopped
      loopRef.current?.stop?.();
      translate.stopAnimation?.();
      cleanup?.();
    };
  }, [translate]);

  // Start/stop animation based on pause, duration or reduce-motion
  useEffect(() => {
    const shouldPause = paused || (respectReduceMotion && reduceMotion);

    // stop any existing loop when conditions change
    loopRef.current?.stop?.();

    if (!shouldPause) {
      // reset value before (re)starting
      translate.setValue(0);
      const useNative = Platform.OS !== 'web';
      loopRef.current = Animated.loop(
        Animated.timing(translate, {
          toValue: 1,
          duration,
          easing: Easing.linear,
          useNativeDriver: useNative,
          isInteraction: false,
        }),
        { resetBeforeIteration: true }
      );
      loopRef.current.start();
    }

    return () => {
      loopRef.current?.stop?.();
    };
  }, [paused, duration, reduceMotion, respectReduceMotion, translate]);

  const gradientWidth = Math.max(80, Math.floor(width * 0.6));
  const translateX = translate.interpolate({
    inputRange: [0, 1],
    outputRange: [-gradientWidth, width + gradientWidth],
  });

  const shouldPause = paused || (respectReduceMotion && reduceMotion);

  return (
    <View
      style={[styles.container, { backgroundColor: baseColor }, style]}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width || width)}
    >
      {shouldPause ? (
        <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
          <LinearGradient
            colors={['transparent', highlightColor, 'transparent']}
            start={{ x: 0.3, y: 0.5 }}
            end={{ x: 0.7, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : (
        <Animated.View
          style={[StyleSheet.absoluteFillObject, { transform: [{ translateX }], pointerEvents: 'none' }]}
        >
          <LinearGradient
            colors={['transparent', highlightColor, 'transparent']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            // Avoid conflicting width + absolute fill on web: explicitly set absolute with left/top/bottom
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: gradientWidth }}
          />
        </Animated.View>
      )}
    </View>
  );
}

interface SkeletonCircleProps extends Omit<SkeletonBarProps, 'style'> {
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function SkeletonCircle({ size = 24, style, baseColor = '#E1E6EB', highlightColor = '#F2F6FA', duration = 1200, paused, respectReduceMotion }: SkeletonCircleProps) {
  return (
    <SkeletonBar
      style={[{ width: size, height: size, borderRadius: size / 2 }, style]}
      baseColor={baseColor}
      highlightColor={highlightColor}
      duration={duration}
      paused={paused}
      respectReduceMotion={respectReduceMotion}
    />
  );
}

interface SkeletonRowProps {
  style?: StyleProp<ViewStyle>;
  leftIcon?: boolean;
  leftIconSize?: number;
  lines?: { width: number | string; height?: number }[];
  rightWidth?: number | string;
  gap?: number;
  baseColor?: string;
  highlightColor?: string;
  centerAlign?: boolean;
  isCard?: boolean;
  paused?: boolean;
  respectReduceMotion?: boolean;
}

export function SkeletonRow({
  style,
  leftIcon = false,
  leftIconSize = 32,
  lines = [{ width: '70%' }, { width: '40%' }],
  rightWidth,
  gap = 12,
  baseColor = '#E1E6EB',
  highlightColor = '#F2F6FA',
  centerAlign = false,
  isCard = false,
  paused,
  respectReduceMotion,
}: SkeletonRowProps) {
  const widthStyle = (w: number | string): StyleProp<ViewStyle> => ({ width: w as any });
  return (
    <View style={[rowStyles.container, isCard && rowStyles.card, style]}> 
      {leftIcon && (
        <SkeletonCircle size={leftIconSize} baseColor={baseColor} highlightColor={highlightColor} style={rowStyles.leftIcon} paused={paused} respectReduceMotion={respectReduceMotion} />
      )}
      <View style={[rowStyles.center, { marginRight: rightWidth ? gap : 0 }, centerAlign && { alignItems: 'center' }]}> 
        {lines.map((ln, idx) => (
          <SkeletonBar
            key={idx}
            style={[widthStyle(ln.width), { height: ln.height ?? 12, marginTop: idx === 0 ? 0 : 6, borderRadius: 6 }]}
            baseColor={baseColor}
            highlightColor={highlightColor}
            paused={paused}
            respectReduceMotion={respectReduceMotion}
          />
        ))}
      </View>
      {rightWidth ? (
        <SkeletonBar style={[widthStyle(rightWidth), { height: 16, borderRadius: 6 }]} baseColor={baseColor} highlightColor={highlightColor} paused={paused} respectReduceMotion={respectReduceMotion} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderRadius: 6,
  },
});

interface SkeletonCardProps {
  style?: StyleProp<ViewStyle>;
  padding?: number;
  radius?: number;
  center?: boolean;
  children?: React.ReactNode;
}

export function SkeletonCard({ style, padding = 16, radius = 12, center = false, children }: SkeletonCardProps) {
  return (
    <View style={[{ padding, borderRadius: radius }, center && { alignItems: 'center' }, style]}>
      {children}
    </View>
  );
}

const rowStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 0,
  },
  card: {
    width: '100%',
  },
  leftIcon: {
    marginRight: 12,
  },
  center: {
    flex: 1,
  },
});

interface SkeletonGridProps {
  columns?: 2 | 3;
  count?: number;
  itemStyle?: StyleProp<ViewStyle>;
  circleSize?: number;
  lines?: { width: number | string; height?: number }[];
  baseColor?: string;
  highlightColor?: string;
  paused?: boolean;
  respectReduceMotion?: boolean;
}

export function SkeletonGrid({
  columns = 2,
  count = 4,
  itemStyle,
  circleSize = 48,
  lines = [{ width: '60%', height: 24 }, { width: '40%', height: 12 }],
  baseColor = '#E1E6EB',
  highlightColor = '#F2F6FA',
  paused,
  respectReduceMotion,
}: SkeletonGridProps) {
  const colBasis = `${100 / columns}%` as any;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -6 }}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={`skel-grid-${i}`} style={{ width: colBasis, paddingHorizontal: 6, marginBottom: 12 }}>
          <SkeletonCard style={[{ backgroundColor: 'transparent' }, itemStyle]}>
            <View style={{ alignItems: 'center' }}>
              <SkeletonCircle size={circleSize} baseColor={baseColor} highlightColor={highlightColor} paused={paused} respectReduceMotion={respectReduceMotion} />
            </View>
            <View style={{ marginTop: 12 }}>
              <SkeletonRow
                isCard
                centerAlign
                lines={lines}
                baseColor={baseColor}
                highlightColor={highlightColor}
                paused={paused}
                respectReduceMotion={respectReduceMotion}
              />
            </View>
          </SkeletonCard>
        </View>
      ))}
    </View>
  );
}

export default SkeletonBar;
