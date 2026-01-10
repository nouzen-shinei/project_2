import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

export default function SharedFilesIndexPage() {
  const router = useRouter();

  useEffect(() => {
    // Immediately redirect away; keep this route inert so no backend calls occur.
    try {
      router.replace('/(tabs)');
    } catch {
      // ignore
    }
  }, [router]);

  // Render nothing visible; page immediately redirects.
  return <View style={{ flex: 1 }} />;
}
