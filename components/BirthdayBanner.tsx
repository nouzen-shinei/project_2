import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Sparkles, PartyPopper } from 'lucide-react-native';
import { useBirthdays } from './BirthdayProvider';

export default function BirthdayBanner() {
  const { hasCelebration, celebrants, bannerDismissed, dismissBanner, setHeaderCompensation, headerCompensation } = useBirthdays();
  const [localHeight, setLocalHeight] = useState(0);
  const measured = useRef(false);
  useEffect(() => {
    // Always set header compensation when banner present so tests on web can observe behavior.
    if (hasCelebration && !bannerDismissed && localHeight > 0) {
      setHeaderCompensation(localHeight);
    }
    return () => setHeaderCompensation(0);
  }, [hasCelebration, bannerDismissed, localHeight]);
  if (!hasCelebration || bannerDismissed) return null;

  const names = celebrants.map((c) => c.name.split(' ')[1] ? c.name : c.name).join(', ');

  // Cap applied compensation to default header height (60) and use it to pull the banner up
  // Scale the applied compensation so banner doesn't pull up the full measured height
  const appliedComp = Math.min(headerCompensation || 0, 60) * 0.5;

  return (
    <LinearGradient
      colors={['#FDE68A', '#FCA5A5', '#A78BFA']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
  // extra space above (paddingTop) while keeping children anchored to bottom (justifyContent: 'flex-end')
  style={{ paddingTop: 36, paddingBottom: 12, paddingHorizontal: 16, minHeight: 88, borderBottomWidth: 1, borderColor: 'rgba(0,0,0,0.08)', zIndex: 1000, position: 'relative', marginTop: -appliedComp, justifyContent: 'flex-end' }}
      onLayout={(e) => {
        const h = e.nativeEvent.layout.height;
        if (!measured.current && h > 0) {
          measured.current = true;
          setLocalHeight(h);
        }
      }}
    >
      {/* Bottom-aligned content so top area remains free for status/notch */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
          <PartyPopper color="#1F2937" size={18} />
          <Text numberOfLines={1} style={{ color: '#111827', fontFamily: 'Poppins-SemiBold', flex: 1 }}>
            Wishing a happy birthday to {names}!
          </Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Pressable onPress={dismissBanner} style={{ paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 9999 }}>
            <Text style={{ color: '#111827', fontFamily: 'Inter-Medium' }}>Dismiss</Text>
          </Pressable>
        </View>
      </View>
    </LinearGradient>
  );
}
