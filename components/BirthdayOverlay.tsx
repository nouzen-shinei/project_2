import React, { useEffect } from 'react';
import { Modal, View, Text, Pressable, Dimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useBirthdays } from './BirthdayProvider';
import { useAuth } from '../hooks/useAuthUnified';
import { Sparkles } from 'lucide-react-native';

const Screen = Dimensions.get('window');

export default function BirthdayOverlay() {
  const { hasCelebration, celebrants, overlaySeen, markOverlaySeen, startCelebrate, celebrateLoading } = useBirthdays();
  const { user } = useAuth();
  const isMyBirthday = !!(user?.email && celebrants.some(c => (c.email || '').toLowerCase() === user.email.toLowerCase()));
  const visible = hasCelebration && isMyBirthday && !overlaySeen;

  // gentle floating animation for hero image
  const offset = useSharedValue(0);
  useEffect(() => {
    if (!visible) return;
    offset.value = withRepeat(
      withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true
    );
  }, [visible]);

  const floatStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: (offset.value - 0.5) * 10 },
      { rotate: `${(offset.value - 0.5) * 2}deg` },
    ],
  }));

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={markOverlaySeen}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}>
        <LinearGradient
          colors={[ '#ff9adfff', '#ffb199', '#ffd1dc' ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ width: Screen.width * 0.9, borderRadius: 24, overflow: 'hidden' }}
        >
          <View style={{ padding: 20 }}>
            <View style={{ alignItems: 'center', marginTop: 8 }}>
              <Animated.View style={[{ width: 140, height: 140, alignItems: 'center', justifyContent: 'center' }, floatStyle]}>
                <Text style={{ fontSize: 96, textAlign: 'center' }}>🎂</Text>
              </Animated.View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <Sparkles color="#FDE68A" size={22} />
                <Text style={{ color: '#FDE68A', fontFamily: 'Poppins-Bold', fontSize: 18 }}>Happy Birthday</Text>
                <Sparkles color="#FDE68A" size={22} />
              </View>
              <Text style={{ color: 'white', textAlign: 'center', marginTop: 6, fontFamily: 'Inter-Regular' }}>
                Warm wishes and heartfelt thanks to our amazing teachers.
              </Text>
            </View>

            <View style={{ marginTop: 16, gap: 10 }}>
              {celebrants.map((c) => (
                <View key={`${c.name}-${c.date}`} style={{ backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 14, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' }}>
                  <Text style={{ color: 'white', fontFamily: 'Poppins-SemiBold', fontSize: 16 }}>{c.name}</Text>
                  {Array.isArray((c as any).subjects) && (c as any).subjects.length > 0 ? (
                    <Text style={{ color: '#D1FAE5', fontFamily: 'Inter-Regular', marginTop: 2 }}>
                      {(c as any).subjects.join(', ')}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>

            <Pressable
              onPress={() => {
                // Start the celebration flow but don't mark the overlay as seen
                // until the poster has been opened by the provider. This keeps
                // the overlay visible during the small loading buffer so the
                // transition to the poster is seamless.
                try { startCelebrate(); } catch {}
              }}
              style={({ pressed }) => ({
                marginTop: 18,
                backgroundColor: pressed ? '#FF4C6D' : '#ff87bdff',
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
              })}
            >
              {celebrateLoading ? (
                <Text style={{ color: '#4a1e2bff', fontFamily: 'Poppins-Bold', fontSize: 16 }}>Loading…</Text>
              ) : (
                <Text style={{ color: '#4a1e2bff', fontFamily: 'Poppins-Bold', fontSize: 16 }}>Celebrate</Text>
              )}
            </Pressable>
          </View>
        </LinearGradient>
      </View>
    </Modal>
  );
}
