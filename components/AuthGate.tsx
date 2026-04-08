import React from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { useAuth } from '../hooks/useAuthUnified';
import { ThemeProvider } from './ThemeProvider';

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading, isInitialized, isOffline } = useAuth();

  if (loading || !isInitialized) {
    return (
      <ThemeProvider>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
          <Image
            source={require('../assets/images/icon.png')}
            style={{ width: 140, height: 140, marginBottom: 28, borderRadius: 30 }}
            resizeMode="contain"
          />
          <ActivityIndicator size="large" color="#888" />
        </View>
      </ThemeProvider>
    );
  }

  if (!user && !isOffline) {
    // Render the login stack (not just the login screen)
    const AuthLayout = require('../app/auth/_layout').default;
    return (
      <AuthLayout />
    );
  }

  // Otherwise, render the main app with Toast
  return <>{children}</>;
} 