import { logger } from '@/lib/logger';
import React, { useEffect } from 'react';
import { useRouter, usePathname } from 'expo-router';
import { View, Platform } from 'react-native';
import { useAuth } from '../hooks/useAuthUnified';

interface ProtectedTabWrapperProps {
  children: React.ReactNode;
  tabName: string;
}

/**
 * Wrapper component that handles page reload redirection for protected tabs
 * When a user reloads the page on a protected tab, they are redirected to the main dashboard
 */
export function ProtectedTabWrapper({ children, tabName }: ProtectedTabWrapperProps) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Only handle redirects on web platform
    if (Platform.OS !== 'web' || loading) {
      return;
    }

    logger.debug(`ProtectedTabWrapper (${tabName}): Checking redirect conditions`, {
      user: user?.email,
      isAuthorized: user?.isAuthorized,
      pathname,
      loading
    });

    // If user is not authorized, let the auth system handle the redirect
    if (!user || !user.isAuthorized) {
      return;
    }

    // Check if this is a page reload or direct URL access
    // Use performance API to detect page reload
    if (typeof window !== 'undefined' && window.performance) {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      
      if (navigation && (navigation.type === 'reload' || navigation.type === 'navigate')) {
        // Check if this is the first load after navigation
        const hasNavigated = sessionStorage.getItem('has_navigated');
        
        if (!hasNavigated) {
          logger.debug(`ProtectedTabWrapper (${tabName}): Redirecting to dashboard due to page reload/direct access`);
          sessionStorage.setItem('has_navigated', 'true');
          router.replace('/(tabs)');
          return;
        }
      }
    }

    // Set navigation flag for subsequent tab switches
    sessionStorage.setItem('has_navigated', 'true');
  }, [user, loading, router, tabName, pathname]);

  // Render children normally - the redirect will happen automatically if needed
  return <View>{children}</View>;
}
