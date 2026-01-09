import { useEffect } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { inviteOverlayStore } from '@/lib/inviteOverlayStore';

const InviteEntryScreen = () => {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const router = useRouter();
  const { theme } = useTheme();

  useEffect(() => {
    const trimmedToken = typeof token === 'string' ? token.trim() : '';
    if (!trimmedToken) {
      router.replace('/(tabs)');
      return;
    }

    // If opened on mobile web, try to open the native app directly.
    // If the app isn't installed, we fall back to the web flow.
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const isProbablyMobile = (() => {
        try {
          const ua = (navigator.userAgent || '').toLowerCase();
          return /android|iphone|ipad|ipod/.test(ua);
        } catch {
          return false;
        }
      })();

      if (isProbablyMobile) {
        const schemeUrl = `com.sneha.tution://invite/${trimmedToken}`;
        const timeoutMs = 900;
        const proceedWeb = () => {
          inviteOverlayStore.setToken(trimmedToken);
          router.replace('/(tabs)');
        };

        const timer = window.setTimeout(proceedWeb, timeoutMs);

        const onVisibility = () => {
          if (document.hidden) {
            window.clearTimeout(timer);
          }
        };
        document.addEventListener('visibilitychange', onVisibility);

        try {
          window.location.href = schemeUrl;
        } catch {
          // ignore
        }

        return () => {
          window.clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }
    }

    // Default behavior (native + desktop web): handle within the web/app UI.
    inviteOverlayStore.setToken(trimmedToken);
    router.replace('/(tabs)');
  }, [token, router]);

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}> 
      <ActivityIndicator size="small" color={theme.primary} />
      <Text style={[styles.label, { color: theme.textSecondary }]}>Opening invite…</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  label: {
    fontSize: 14,
  },
});

export default InviteEntryScreen;
