import { logger } from '@/lib/logger';
import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Gift, Cake } from 'lucide-react-native';
import { useBirthdays } from './BirthdayProvider';
import { useAuth } from '../hooks/useAuthUnified';

export default function BirthdayFab() {
  const { hasCelebration, celebrants, startCelebrate, celebrateLoading, suppressFab } = useBirthdays();
  const { user } = useAuth();
  const isMyBirthday = !!(user?.email && celebrants.some(c => (c.email || '').toLowerCase() === user.email.toLowerCase()));
  if (!hasCelebration || !isMyBirthday || suppressFab) return null;

  return (
    <View
      style={{ position: 'absolute', right: 16, bottom: Platform.select({ ios: 80, android: 80, default: 80 }), zIndex: 2000, pointerEvents: 'box-none' }}
    >
      <Pressable
        onPress={() => {
          try {
            startCelebrate?.();
          } catch (e) {
            logger.error('FAB startCelebrate error', e);
          }
        }}
        style={({ pressed }) => ({
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: pressed ? 'rgba(253,224,71,0.9)' : 'rgba(253,224,71,1)',
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        })}
      >
        {celebrateLoading ? (
          <Cake color="#111827" size={20} />
        ) : (
          <Gift color="#111827" size={22} />
        )}
      </Pressable>
    </View>
  );
}
