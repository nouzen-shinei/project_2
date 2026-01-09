import React, { useEffect } from 'react';
import { ActivityIndicator, Image, Platform, Text, TouchableOpacity, View, useColorScheme } from 'react-native';
import * as Updates from 'expo-updates';
import { useMaintenanceMode } from '../hooks/useMaintenanceMode';
import { setMaintenanceScreenVisible } from '../services/maintenanceAlert';

export default function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const colorScheme = useColorScheme();
  const { loading, enabled, message } = useMaintenanceMode();

  useEffect(() => {
    setMaintenanceScreenVisible(Boolean(enabled) && !loading);
    return () => {
      setMaintenanceScreenVisible(false);
    };
  }, [enabled, loading]);

  if (loading) {
    return <>{children}</>;
  }

  if (!enabled) {
    return <>{children}</>;
  }

  const backgroundColor = colorScheme === 'dark' ? '#0f172a' : '#fff';
  const textColor = colorScheme === 'dark' ? '#E5E7EB' : '#111827';
  const mutedColor = colorScheme === 'dark' ? '#9CA3AF' : '#6B7280';

  const handleRetry = async () => {
    try {
      if (Platform.OS === 'web') {
        window.location.reload();
        return;
      }

      // Best-effort hard reload for native.
      await Updates.reloadAsync();
    } catch {
      // ignore
    }
  };

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor, paddingHorizontal: 24 }}>
      <Image
        source={require('../assets/images/icon.png')}
        style={{ width: 104, height: 104, marginBottom: 20, borderRadius: 22 }}
        resizeMode="contain"
      />
      <Text style={{ fontSize: 20, fontWeight: '700', color: textColor, textAlign: 'center' }}>Maintenance Mode</Text>
      <Text style={{ marginTop: 10, fontSize: 15, lineHeight: 20, color: mutedColor, textAlign: 'center' }}>{message}</Text>

      <TouchableOpacity
        onPress={handleRetry}
        style={{ marginTop: 18, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, backgroundColor: colorScheme === 'dark' ? '#1f2937' : '#e5e7eb' }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {/* <ActivityIndicator size="small" color={mutedColor} /> */}
          <Text style={{ color: textColor, fontWeight: '600' }}>Try again</Text>
        </View>
      </TouchableOpacity>

      <Text style={{ position: 'absolute', bottom: 24, textAlign: 'center', color: mutedColor, fontSize: 16 }}>© vipika.in</Text>
    </View>
  );
}
