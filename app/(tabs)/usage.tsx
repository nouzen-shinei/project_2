import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Platform, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { RefreshCw, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { useTenantUsageSummary } from '@/hooks/useTenantUsageSummary';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import TenantUsageSummary from '@/components/TenantUsageSummary';

const HEADER_VERTICAL_PADDING = 14;

export default function UsageScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ from?: string }>();
  const { theme } = useTheme();
  const { activeTenant, loading: tenantLoading } = useTenant();
  const { activeMembership } = useTenant();
  const insets = useSafeAreaInsets();
  const tenantId = activeTenant?.id ?? null;

  const canViewUsage = activeMembership?.role !== 'member';
  const usageData = useTenantUsageSummary(tenantId, undefined, { enabled: canViewUsage });
  const [refreshing, setRefreshing] = useState(false);
  const refreshSpin = useRef(new Animated.Value(0));
  const refreshLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  // Match Plan screen behavior: keep screen fully visible on native, animate on web.
  const openAnim = useRef(new Animated.Value(Platform.OS === 'web' ? 0 : 1));

  const tenantUnavailable = !tenantLoading && !activeTenant?.id;

  const isViewOnlyMember = !tenantLoading && activeMembership?.role === 'member';

  const initialLoading = !tenantUnavailable && usageData.loading && !usageData.usageSummary;

  const stopRefreshSpin = useCallback(() => {
    try {
      refreshLoopRef.current?.stop?.();
    } catch {
      // no-op
    }
    refreshLoopRef.current = null;
    refreshSpin.current.stopAnimation();
    refreshSpin.current.setValue(0);
  }, []);

  const startRefreshSpin = useCallback(() => {
    stopRefreshSpin();
    refreshLoopRef.current = Animated.loop(
      Animated.timing(refreshSpin.current, {
        toValue: 1,
        duration: 900,
        useNativeDriver: false,
      })
    );
    refreshLoopRef.current.start();
  }, [stopRefreshSpin]);

  useEffect(() => {
    if (refreshing) {
      startRefreshSpin();
      return;
    }
    stopRefreshSpin();
  }, [refreshing, startRefreshSpin, stopRefreshSpin]);

  const handleRefresh = useCallback(async () => {
    if (!tenantId) {
      return;
    }
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    try {
      await usageData.refresh();
    } finally {
      setRefreshing(false);
    }
  }, [tenantId, refreshing, usageData]);

  const refreshRotation = useMemo(
    () =>
      refreshSpin.current.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
      }),
    []
  );

  const openStyle = useMemo(
    () => ({
      opacity: openAnim.current,
      transform: [
        {
          translateY: openAnim.current.interpolate({
            inputRange: [0, 1],
            outputRange: [18, 0],
          }),
        },
      ],
    }),
    []
  );

  const handleClose = useCallback(() => {
    if (params?.from === 'settings') {
      router.replace('/(tabs)/settings');
      return;
    }
    const anyRouter: any = router as any;
    if (typeof anyRouter?.canGoBack === 'function' && anyRouter.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)/settings');
  }, [params?.from, router]);

  // Start animation only on web (same intent as Plan).
  React.useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }
    openAnim.current.stopAnimation();
    openAnim.current.setValue(0);

    const animation = Animated.timing(openAnim.current, {
      toValue: 1,
      duration: 280,
      useNativeDriver: false,
    });

    animation.start();
    return () => {
      openAnim.current.stopAnimation();
    };
  }, []);

  return (
    <Animated.View style={[styles.container, { backgroundColor: theme.background }, openStyle]}>
      <View
        style={[
          styles.header,
          {
            backgroundColor: theme.surface,
            borderBottomColor: theme.border,
            paddingTop: insets.top + HEADER_VERTICAL_PADDING,
            paddingBottom: HEADER_VERTICAL_PADDING,
          },
        ]}
      >
        <TouchableOpacity onPress={handleClose} style={styles.backButton}>
          <X size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Usage & quotas</Text>
        <TouchableOpacity
          onPress={() => {
            void handleRefresh();
          }}
          style={[styles.backButton, { opacity: tenantUnavailable ? 0.5 : 1 }]}
          disabled={tenantUnavailable}
          accessibilityRole="button"
          accessibilityLabel="Refresh usage and quotas"
        >
          <Animated.View style={{ transform: [{ rotate: refreshing ? refreshRotation : '0deg' }] }}>
            <RefreshCw size={20} color={theme.text} />
          </Animated.View>
        </TouchableOpacity>
      </View>

      {tenantUnavailable ? (
        <View style={styles.emptyWrap}>
          <TenantSelectionEmptyState />
        </View>
      ) : isViewOnlyMember ? (
        <View style={styles.loadingWrap}>
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>
            Usage & quotas are available to staff and admins.
          </Text>
        </View>
      ) : initialLoading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading usage…</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                void handleRefresh();
              }}
              tintColor={theme.primary}
              titleColor={theme.textSecondary}
              colors={[theme.primary]}
            />
          }
        >
          <TenantUsageSummary allowNonAdminMembers={canViewUsage} usageData={usageData} />
        </ScrollView>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    padding: 16,
    paddingBottom: 28,
  },
  emptyWrap: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
