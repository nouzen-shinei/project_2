import React, { useEffect, useRef, useState } from 'react';
import { Stack , useRouter, useSegments } from 'expo-router';
import { enforceClientSafety } from '../lib/runtimeEnv';
import { injectCSP } from '../lib/security/csp';
import { logger } from '../lib/logger';
// Import log control (must be before other modules that log heavily)
import '../lib/logControl';
import BirthdayConfetti from '../components/BirthdayConfetti';
import BirthdayPoster from '../components/BirthdayPoster';
import { StatusBar } from 'expo-status-bar';
import '../global.css'; // NativeWind CSS import
import { useFrameworkReady } from '../hooks/useFrameworkReady';
import { useFonts } from 'expo-font';
import { useAuth, authService } from '../hooks/useAuthUnified';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useNotifications } from '../hooks/useNotifications';
import { deviceManagementService } from '../services/deviceManagementService';
import Toast from 'react-native-toast-message';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold
} from '@expo-google-fonts/inter';
import {
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold
} from '@expo-google-fonts/poppins';
import * as SplashScreen from 'expo-splash-screen';
import { ThemeProvider } from '../components/ThemeProvider';
import { BirthdayProvider } from '../components/BirthdayProvider';
import BirthdayOverlay from '../components/BirthdayOverlay';
import BirthdayAmbient from '../components/BirthdayAmbient';
import BirthdayMusic from '../components/BirthdayMusic';
import BirthdayFab from '../components/BirthdayFab';
import { Platform, Image, ActivityIndicator, View, Text, useColorScheme, Modal, TouchableOpacity, Alert } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AuthGate from '../components/AuthGate';
import MaintenanceGate from '../components/MaintenanceGate';
import { NoticeProvider } from '../components/NoticeProvider';
import ModalAlertProvider from '../components/ModalAlertProvider';
import * as Updates from 'expo-updates';
import { installErrorFilter } from '../globalErrorFilter';
import { TenantProvider, useTenant } from '../hooks/useTenantContext';
import TenantAccessScreen from '../components/TenantAccessScreen';
import { useTheme } from '../hooks/useTheme';
import InviteOverlay from '../components/InviteOverlay';
import { inviteOverlayStore } from '../lib/inviteOverlayStore';
import { onBillingPastDue } from '../lib/billingPastDue';
import { setLastInAppRoute } from '../lib/lastInAppRoute';
import { tryPresentModalAlert } from '../services/modalAlertService';
import { wasStorageLimitReachedAlertShownRecently } from '../services/storageLimitAlert';
import { runtimeEndpoints } from '../services/runtimeEndpoints';

SplashScreen.preventAutoHideAsync();
// Install console/error & event filters (web-only)
installErrorFilter();

// One-time client safety & CSP for web
if (typeof document !== 'undefined') {
  try { enforceClientSafety(); } catch {}
  try {
    injectCSP({
      extraConnect: [],
      extraScript: [
        'https://tution-app-6c0c3-default-rtdb.asia-southeast1.firebasedatabase.app',
        'https://*.firebasedatabase.app',
        'https://apis.google.com',
        'https://checkout.razorpay.com',
        'https://api.razorpay.com'
      ],
      extraFrame: [
        'https://*.firebasedatabase.app',
        'https://tution-app-6c0c3.firebaseapp.com',
        'https://checkout.razorpay.com',
        'https://api.razorpay.com'
      ]
    });
  } catch {}
}

// Install the Alert.alert → in-app modal shim as early as possible.
// This applies to web + native so alerts are consistent everywhere.
// If the modal presenter isn't mounted yet, we fall back to the original Alert.alert.
try {
  const alertAny = Alert as any;
  if (!alertAny.__modalShimInstalled) {
    const original = alertAny?.alert;
    alertAny.alert = (title: string, message?: string, buttons?: any[], options?: any) => {
      // If we've just shown the dedicated storage-limit modal, suppress common
      // follow-up generic upload failure alerts to avoid double-modals.
      try {
        if (wasStorageLimitReachedAlertShownRecently(3500)) {
          const t = (title || '').toString().toLowerCase();
          const m = (message || '').toString().toLowerCase();

          const looksUploadRelated =
            t.includes('upload') ||
            t.includes('receipt') ||
            t.includes('profile') ||
            m.includes('upload') ||
            m.includes('receipt') ||
            m.includes('profile') ||
            m.includes('failed to load resource') ||
            m.includes('upload_failed') ||
            m.includes('failed');

          // Only suppress if it looks like an upload-related error alert.
          if (looksUploadRelated) {
            return undefined;
          }
        }
      } catch {
        // ignore
      }

      const normalizedButtons = Array.isArray(buttons) ? buttons : undefined;
      const shown = tryPresentModalAlert({
        title: (title || '').toString(),
        message: message ? message.toString() : undefined,
        buttons: normalizedButtons?.map((b) => ({
          text: (b?.text || 'OK').toString(),
          onPress: typeof b?.onPress === 'function' ? b.onPress : undefined,
          style: b?.style,
        })),
      });

      if (!shown && typeof original === 'function') {
        return original(title, message, buttons, options);
      }
      return undefined;
    };
    alertAny.__modalShimInstalled = true;
    alertAny.__modalShimOriginal = original;
  }
} catch {
  // ignore
}

export default function RootLayout() {
  useFrameworkReady();
  const colorScheme = useColorScheme();
  
  const { user, loading, isInitialized, isOffline, roleChangeNotice } = useAuth();
  const { isOnline, isOffline: networkOffline, isInitialLoad } = useNetworkStatus();
  
  // Initialize notifications system
  useNotifications();
  const router = useRouter();
  const segments = useSegments();
  const segmentsRef = useRef(segments);
  const [hasRedirected, setHasRedirected] = useState(false);

  // Load runtime backend endpoints (Firestore + cache) early.
  useEffect(() => {
    runtimeEndpoints.init().catch((e) => logger.warn('[RootLayout] runtimeEndpoints init failed', e));
  }, []);

  useEffect(() => {
    segmentsRef.current = segments;

    // Remember the last in-app route so the Plan screen can close back to it.
    const segs = segments as unknown as string[];
    if (segs?.[0] === '(tabs)' && segs?.[1] && segs?.[1] !== 'plan') {
      setLastInAppRoute(`/${segs.join('/')}`);
    }
  }, [segments]);

  // Use auth offline status as primary, with network status as fallback
  const isOfflineStatus = isOffline || networkOffline;

  // No offline page - disabled completely

  const [fontsLoaded, fontError] = useFonts({
    'Inter-Regular': Inter_400Regular,
    'Inter-Medium': Inter_500Medium,
    'Inter-SemiBold': Inter_600SemiBold,
    'Inter-Bold': Inter_700Bold,
    'Poppins-Regular': Poppins_400Regular,
    'Poppins-Medium': Poppins_500Medium,
    'Poppins-SemiBold': Poppins_600SemiBold,
    'Poppins-Bold': Poppins_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  // Global handler for billing delinquency enforcement (HTTP 402 billing_past_due)
  useEffect(() => {
    const unsubscribe = onBillingPastDue(() => {
      const currentSegments = segmentsRef.current as unknown as string[];
      const alreadyOnPlan = currentSegments?.[0] === '(tabs)' && currentSegments?.[1] === 'plan';
      if (alreadyOnPlan) {
        return;
      }

      if (Platform.OS === 'web') {
        router.push('/(tabs)/plan');
        return;
      }

      router.push('/(tabs)/plan');
      Alert.alert(
        'Payment overdue',
        'Your plan payment is overdue. Please renew/upgrade to continue using the app.',
        [{ text: 'OK' }]
      );
    });

    return unsubscribe;
  }, [router]);

  // Initialize device management service only when user is authorized
  useEffect(() => {
    if (user?.isAuthorized) {
      deviceManagementService.start();
      return () => {
        deviceManagementService.stop();
      };
    }
    // If not authorized, ensure service is stopped
    deviceManagementService.stop();
    return undefined;
  }, [user?.isAuthorized]);

  // Remove auto-initialization since admin is already set up in Firestore

  // Add beforeunload listener to manage navigation state
  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    const handleBeforeUnload = () => {
      // Clear navigation state on page unload
      sessionStorage.removeItem('navigation_active');
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
  logger.debug('RootLayout: useEffect triggered', { 
      userEmail: user?.email, 
      isAuthorized: user?.isAuthorized, 
      loading, 
      isOffline,
      segments: segments.join('/'),
      hasRedirected 
    });

    // Only run on web platform
    if (Platform.OS !== 'web') {
      return;
    }

    // Don't do anything while still loading authentication
    if (loading) {
  logger.debug('RootLayout: Still loading authentication, waiting...');
      return;
    }

    const currentPath = segments.join('/');
    const inTabsRoute = segments[0] === '(tabs)';
    const segmentsArray = segments as string[];
    const specificTab = segmentsArray[1];
    
  logger.debug('RootLayout: Processing navigation for:', { currentPath, inTabsRoute, specificTab, user: user?.email, isOffline });
    
    // Handle connection restoration: if we have a user but we're on the root path and not offline anymore
    if (user && user.isAuthorized && !isOffline && (currentPath === '' || currentPath === 'auth/login')) {
  logger.info('RootLayout: Connection restored and user available, redirecting to main app...');
      setHasRedirected(true);
      router.replace('/(tabs)');
      return;
    }
    
    // Handle unauthorized users first - but only if we're not offline with cached data
    if (!user || !user.isAuthorized) {
      // If we're offline, don't redirect to login - let the offline screen handle this
      if (isOffline) {
  logger.info('RootLayout: Offline and no/unauthorized user - will show offline screen');
        return;
      }
      
      if (inTabsRoute) {
  logger.info('RootLayout: Unauthorized user trying to access protected route, redirecting to login...');
        setHasRedirected(true);
        router.replace('/auth/login');
      }
      return;
    }

    // Don't redirect if already redirected in this session (but allow connection restoration above)
    if (hasRedirected && !(!isOffline && user && user.isAuthorized)) {
      return;
    }

    // For authorized users, handle navigation based on offline status
    if (inTabsRoute && specificTab && ['admin', 'settings', 'students', 'fees', 'chat'].includes(specificTab)) {
      // If offline, don't redirect - let the user stay on the current tab which will show offline screen
      if (isOffline) {
  logger.debug('RootLayout: Offline with cached user - staying on current tab');
        return;
      }
      
      // DISABLED: This was causing navigation issues - the main layout was overriding tab navigation
      // Check if this is likely a page reload by looking at browser navigation timing
      // if (typeof window !== 'undefined' && window.performance) {
      //   const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      //   
      //   if (navigation && navigation.type === 'reload') {
      //     logger.debug('RootLayout: Page reload detected on protected tab, redirecting to dashboard...');
      //     setHasRedirected(true);
      //     router.replace('/(tabs)');
      //     return;
      //   }
      // }
      
      // DISABLED: This was causing navigation issues
      // Also check if there's no session navigation state (direct URL access)
      // const hasSessionNavigation = sessionStorage.getItem('navigation_active');
      // if (!hasSessionNavigation) {
      //   logger.debug('RootLayout: Direct URL access to protected tab detected, redirecting to dashboard...');
      //   sessionStorage.setItem('navigation_active', 'true');
      //   setHasRedirected(true);
      //   router.replace('/(tabs)');
      //   return;
      // }
    }

    // Mark navigation as active for subsequent navigations
    if (inTabsRoute && !isOffline) {
      sessionStorage.setItem('navigation_active', 'true');
    }
  }, [user, loading, isOffline, segments, hasRedirected, router]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  // Show splash/loading while auth is initializing
  if (loading || !isInitialized) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <MaintenanceGate>
          <ThemeProvider>
            <ModalAlertProvider>
              <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colorScheme === 'dark' ? '#0f172a' : '#fff' }}>
                <Image
                  source={require('../assets/images/icon.png')}
                  style={{ width: 120, height: 120, marginBottom: 32, borderRadius: 24 }}
                  resizeMode="contain"
                />
                <ActivityIndicator size="large" color={colorScheme === 'dark' ? '#aaa' : '#888'} />
                <Text
                  style={{
                    position: 'absolute',
                    bottom: 24,
                    textAlign: 'center',
                    color: colorScheme === 'dark' ? '#9CA3AF' : '#6B7280',
                    fontSize: 16,
                  }}
                >
                  © vipika.in
                </Text>
              </View>
              <StatusBar style="auto" />
              <Toast position="top" topOffset={60} visibilityTime={4000} autoHide />
            </ModalAlertProvider>
          </ThemeProvider>
        </MaintenanceGate>
      </GestureHandlerRootView>
    );
  }

  // Show login screen only if user is null and not offline
  if (!user && !isOffline) {
    const LoginScreen = require('./auth/login').default;
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <MaintenanceGate>
          <ThemeProvider>
            <ModalAlertProvider>
              <LoginScreen />
              <StatusBar style="auto" />
              <Toast position="top" topOffset={60} visibilityTime={4000} autoHide />
            </ModalAlertProvider>
          </ThemeProvider>
        </MaintenanceGate>
      </GestureHandlerRootView>
    );
  }

  // Otherwise, show main app shell (user exists, or offline with cached user)
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <MaintenanceGate>
        <AuthGate>
          <TenantProvider>
            <ThemeProvider>
              <ModalAlertProvider>
                <TenantAwareShell
                  colorScheme={colorScheme}
                  isOffline={isOffline}
                  roleChangeNotice={roleChangeNotice}
                  router={router}
                />
                <Toast position="top" topOffset={60} visibilityTime={4000} autoHide />
              </ModalAlertProvider>
            </ThemeProvider>
          </TenantProvider>
        </AuthGate>
      </MaintenanceGate>
    </GestureHandlerRootView>
  );
}

interface TenantAwareShellProps {
  colorScheme: ReturnType<typeof useColorScheme>;
  isOffline: boolean;
  roleChangeNotice: { oldRole: 'user' | 'admin'; newRole: 'user' | 'admin'; at: number } | null | undefined;
  router: ReturnType<typeof useRouter>;
}

const TenantAwareShell = ({ colorScheme, isOffline, roleChangeNotice, router }: TenantAwareShellProps) => {
  const { theme } = useTheme();
  const segments = useSegments();
  const isDashboardRoute =
    Array.isArray(segments) &&
    segments[0] === '(tabs)' &&
    !segments[1];
  const isBillingFlowRoute =
    Array.isArray(segments) &&
    (segments[0] === 'checkout' ||
      segments[0] === 'checkout-result' ||
      segments[0] === 'billing' ||
      (segments[0] === '(tabs)' && (segments[1] === 'plan' || segments[1] === 'billing-history')));
  const isInviteFlow = segments[0] === 'invite';
  const { activeMembership, memberships, loading, pendingMemberships } = useTenant();
  const [tenantModalVisible, setTenantModalVisible] = useState(true);
  const [tenantModalBlocked, setTenantModalBlocked] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(() => inviteOverlayStore.getToken());

  useEffect(() => {
    const unsubscribe = inviteOverlayStore.subscribe(setInviteToken);
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (inviteToken) {
      setTenantModalBlocked(true);
      return;
    }
    if (!inviteToken && tenantModalBlocked) {
      const timeout = setTimeout(() => setTenantModalBlocked(false), 500);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [inviteToken, tenantModalBlocked]);

  const hasActiveMembership = Boolean(activeMembership) || memberships.some((membership) => membership.status === 'active');
  const needsTenantSelection = !hasActiveMembership;
  const pendingCount = pendingMemberships.length;

  logger.info('TenantAwareShell render', {
    loading,
    membershipCount: memberships.length,
    activeMembershipId: activeMembership?.tenantId || null,
    needsTenantSelection,
    pendingCount
  });

  const initialMembershipBootstrap = loading && memberships.length === 0;

  if (initialMembershipBootstrap) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colorScheme === 'dark' ? '#0f172a' : '#fff' }}>
        <Image
          source={require('../assets/images/icon.png')}
          style={{ width: 120, height: 120, marginBottom: 32, borderRadius: 24 }}
          resizeMode="contain"
        />
        <ActivityIndicator size="large" color={colorScheme === 'dark' ? '#aaa' : '#888'} />
        <Text
          style={{
            position: 'absolute',
            bottom: 24,
            textAlign: 'center',
            color: colorScheme === 'dark' ? '#9CA3AF' : '#6B7280',
            fontSize: 16,
          }}
        >
          © vipika.in
        </Text>
        <StatusBar style="auto" />
      </View>
    );
  }

  const shouldShowTenantAccess = needsTenantSelection && !isInviteFlow && !inviteToken && !tenantModalBlocked;

  return (
    <BirthdayProvider>
      <NoticeProvider enabled={isDashboardRoute}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="invite/[token]"
            options={{
              headerShown: false,
              presentation: 'transparentModal',
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
          <Stack.Screen name="+not-found" />
        </Stack>

        {!isBillingFlowRoute && (
          <>
            <BirthdayAmbient />
            <BirthdayMusic />
            <BirthdayConfetti />
            <BirthdayPoster />
            <BirthdayOverlay />
            <BirthdayFab />

            {inviteToken && <InviteOverlay token={inviteToken} />}

            {shouldShowTenantAccess && (
              <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
                <TenantAccessScreen visible={tenantModalVisible} onClose={() => setTenantModalVisible(false)} />
                {!tenantModalVisible && !hintDismissed && (
                  <View
                    pointerEvents="box-none"
                    style={{ position: 'absolute', bottom: 120, left: 0, right: 0, alignItems: 'center' }}
                  >
                    <View
                      style={{
                        paddingHorizontal: 16,
                        paddingVertical: 14,
                        borderRadius: 16,
                        backgroundColor: theme.surface,
                        borderWidth: 1,
                        borderColor: theme.border,
                        minWidth: 260,
                        shadowColor: '#000',
                        shadowOpacity: 0.1,
                        shadowOffset: { width: 0, height: 4 },
                        shadowRadius: 12,
                        elevation: 8,
                        alignItems: 'center',
                        position: 'relative',
                      }}
                    >
                      <TouchableOpacity
                        onPress={() => setHintDismissed(true)}
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: 8,
                          width: 28,
                          height: 28,
                          borderRadius: 14,
                          borderWidth: 1,
                          borderColor: theme.border,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text style={{ color: theme.textSecondary, fontSize: 14, fontWeight: '600' }}>×</Text>
                      </TouchableOpacity>
                      <Text style={{ color: theme.text, fontWeight: '600', marginBottom: 8 }}>
                        Join a coaching center to continue
                      </Text>
                      <Text style={{ color: theme.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: 12 }}>
                        {pendingCount
                          ? `You have ${pendingCount} pending ${pendingCount === 1 ? 'request' : 'requests'} awaiting approval.`
                          : 'Create a workspace or enter a join code to unlock the dashboard.'}
                      </Text>
                      <TouchableOpacity
                        onPress={() => setTenantModalVisible(true)}
                        style={{
                          paddingHorizontal: 20,
                          paddingVertical: 10,
                          borderRadius: 999,
                          backgroundColor: theme.primary,
                        }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '600' }}>Open create/join options</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            )}

            {/* Role Change Modal (online only) */}
            {roleChangeNotice && !isOffline && !inviteToken && (
              <Modal transparent animationType="fade" visible>
                <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                  <View style={{ width: '90%', maxWidth: 420, borderRadius: 16, padding: 20, backgroundColor: colorScheme === 'dark' ? '#0f172a' : '#ffffff' }}>
                    <Text style={{ fontSize: 18, fontWeight: '600', marginBottom: 8, color: colorScheme === 'dark' ? '#e5e7eb' : '#111827' }}>
                      Permissions Updated
                    </Text>
                    <Text style={{ fontSize: 14, marginBottom: 16, color: colorScheme === 'dark' ? '#9ca3af' : '#374151' }}>
                      Your role changed from {roleChangeNotice.oldRole} to {roleChangeNotice.newRole}. Please {Platform.OS === 'web' ? 'refresh the page' : 'restart the app'} to apply the changes everywhere.
                    </Text>
                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 12 }}>
                      {Platform.OS === 'web' ? (
                        <TouchableOpacity
                          onPress={() => {
                            try { router.replace('/(tabs)'); } catch {}
                            try {
                              if (typeof window !== 'undefined') {
                                setTimeout(() => window.location.reload(), 150);
                              }
                            } catch {}
                          }}
                          style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#2563eb' }}
                        >
                          <Text style={{ color: '#fff', fontWeight: '600' }}>Refresh</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          onPress={async () => {
                            try {
                              if (Updates && typeof Updates.reloadAsync === 'function') {
                                await Updates.reloadAsync();
                                return;
                              }
                            } catch (e) {
                              // fall through to toast
                            }
                            try { Toast.show({ type: 'info', text1: 'Please restart the app to apply changes' }); } catch {}
                          }}
                          style={{ paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: '#2563eb' }}
                        >
                          <Text style={{ color: '#fff', fontWeight: '600' }}>Restart App</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                </View>
              </Modal>
            )}
          </>
        )}

        <StatusBar style="auto" />
      </NoticeProvider>
    </BirthdayProvider>
  );
};