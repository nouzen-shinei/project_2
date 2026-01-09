import { Tabs } from 'expo-router';
import { View, Platform, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBirthdays } from '../../components/BirthdayProvider';
import { LayoutDashboard, Users, CreditCard, MessageCircle, Settings, Bell, Shield } from 'lucide-react-native';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuthUnified';
import { useTenant } from '../../hooks/useTenantContext';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import AutoNetworkBanner from '../../components/AutoNetworkBanner';
import BirthdayBanner from '../../components/BirthdayBanner';

export default function TabLayout() {
  const { theme } = useTheme();
  const { headerCompensation } = useBirthdays();
  const { user, isOffline: authOffline } = useAuth();
  const { activeMembership } = useTenant();
  const { isOnline, isOffline: networkOffline, wasOffline, clearWasOffline, type, isInitialLoad } = useNetworkStatus();
  const insets = useSafeAreaInsets();
  
  // Use auth offline status as primary, with network status as fallback
  const isOffline = authOffline || networkOffline;
  
  const tenantAdminRoles = new Set(['owner', 'admin']);
  const hasTenantAdminAccess = tenantAdminRoles.has(activeMembership?.role ?? 'member');
  const isLegacyAdmin = user?.role === 'admin';
  const canSeeAdminTab = isLegacyAdmin || hasTenantAdminAccess;

  // Responsive tab label visibility
  const screenWidth = Dimensions.get('window').width;
  const showLabels = screenWidth >= 400; // Hide labels if screen width < 400

  const baseTabBarPadding = Platform.OS === 'ios' ? 20 : 10;
  const baseTabBarHeight = Platform.OS === 'ios' ? 90 : 70;
  const extraBottomInset = Math.max(0, insets.bottom - baseTabBarPadding);

  // Reduce applied compensation so header shrinks less (avoid large blank gap).
  const effectiveComp = Math.max(0, Math.min(headerCompensation || 0, 60) * 0.5);

  return (
  <View style={{ flex: 1, paddingTop: effectiveComp, backgroundColor: theme.background }}>
      {/* Global Network Status Banner - show for all offline scenarios */}
      <AutoNetworkBanner />
  {/* Birthday Celebration Banner */}
  <BirthdayBanner />

  <Tabs
        detachInactiveScreens={false}
        screenOptions={() => ({
          headerShown: false,
          // Make tab switches instant by keeping all tabs mounted and attached
          lazy: false,
          freezeOnBlur: true,
          tabBarActiveTintColor: theme.tabBarActive,
          tabBarInactiveTintColor: theme.tabBarInactive,
          tabBarStyle: {
            backgroundColor: theme.tabBar,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            borderColor: theme.border, // Ensure consistent border color across platforms
            paddingBottom: Math.max(insets.bottom, baseTabBarPadding),
            paddingTop: 10,
            height: baseTabBarHeight + extraBottomInset,
            shadowColor: 'transparent', // Remove any shadow that might appear as white line
            elevation: 0, // Remove Android elevation shadow
          },
          tabBarLabelStyle: showLabels
            ? {
                fontFamily: 'Inter-Medium',
                fontSize: 12,
                marginTop: 4,
              }
            : { width: 0, height: 0, opacity: 0 },
        })}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Dashboard',
            tabBarIcon: ({ size, color }: { size: number; color: string }) => (
              <LayoutDashboard size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="students"
          options={{
            title: 'Students',
            tabBarIcon: ({ size, color }: { size: number; color: string }) => (
              <Users size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="fees"
          options={{
            title: 'Fees',
            tabBarIcon: ({ size, color }: { size: number; color: string }) => (
              <CreditCard size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="chat"
          options={{
            title: 'Messages',
            tabBarIcon: ({ size, color }: { size: number; color: string }) => (
              <MessageCircle size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="reminders"
          options={{
            title: 'Reminders',
            tabBarIcon: ({ size, color }: { size: number; color: string }) => (
              <Bell size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="admin"
          options={{
            title: 'Admin',
            tabBarIcon: ({ size, color }: { size: number; color: string }) => (
              <Shield size={size} color={color} />
            ),
            href: canSeeAdminTab ? '/admin' : null,
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarIcon: ({ size, color }: { size: number; color: string }) => (
              <Settings size={size} color={color} />
            ),
          }}
        />

        {/* Hidden route: accessible via Settings, not shown in tab bar */}
        <Tabs.Screen
          name="plan"
          options={{
            title: 'Plan & Billing',
            href: null,
          }}
        />

        <Tabs.Screen
          name="billing-history"
          options={{
            title: 'Billing History',
            href: null,
          }}
        />

        <Tabs.Screen
          name="usage"
          options={{
            title: 'Usage & quotas',
            href: null,
          }}
        />
      </Tabs>
    </View>
  );
}