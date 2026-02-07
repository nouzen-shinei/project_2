import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

export default function ShortSharedIndexPage() {
  const router = useRouter();

  useEffect(() => {
    try {
      router.replace('/(tabs)');
    } catch {
      // ignore
    }
  }, [router]);

  return <View style={{ flex: 1 }} />;
}
