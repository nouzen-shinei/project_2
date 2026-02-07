import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

export default function ShortSharedLinkRedirect() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const token = typeof params.token === 'string' ? params.token : '';

  useEffect(() => {
    if (!token.trim()) {
      router.replace('/(tabs)');
      return;
    }
    router.replace(`/shared/${encodeURIComponent(token.trim())}`);
  }, [router, token]);

  return <View style={{ flex: 1 }} />;
}
