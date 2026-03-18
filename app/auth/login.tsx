import { logger } from '@/lib/logger';
import React, { useState, useEffect } from 'react';
import { Alert, View, Platform } from 'react-native';
import { useAuth } from '../../hooks/useAuthUnified';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { useNetworkQuality } from '../../hooks/useNetworkQuality';
import SignInCard from '../../components/ui/sign-in-card';
import AutoNetworkBanner from '../../components/AutoNetworkBanner';
import {
  clearReviewerQuickJoinPending,
  getReviewerQuickJoinCenterName,
  isReviewerQuickJoinEnabled,
  markReviewerQuickJoinPending,
} from '../../services/reviewerQuickJoin';

export default function LoginScreen() {
  const { signInWithGoogle, loading, error, user, clearError } = useAuth();
  const { isOnline, wasOffline, clearWasOffline, type } = useNetworkStatus();
  const { isSlow, label: qualityLabel } = useNetworkQuality();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [displayError, setDisplayError] = useState<string | null>(null);

  // Debug logging (only in development)
  const isDev = __DEV__;
  if (isDev) {
    logger.debug('LoginScreen - Error state:', error);
    logger.debug('LoginScreen - Loading state:', loading);
    logger.debug('LoginScreen - User state:', user);
  }
  
  // Clear the signing in state when user changes (success or failure)
  useEffect(() => {
    if (user !== null || (!loading && !user)) {
      setIsSigningIn(false);
    }
  }, [user, loading]);

  // Hold onto the latest auth error until the user retries sign-in
  useEffect(() => {
    if (!error) return;
    if (error === 'Authentication timeout - slow connection') return;
    setDisplayError(error);
  }, [error]);

  // Clear success message when an error comes in or on unmount
  useEffect(() => {
    if (error) {
      setSuccess(null);
    }
    return () => {
      setSuccess(null);
    };
  }, [error]);

  // Show device ban alert on mobile platforms for better visibility
  useEffect(() => {
    if (error && error.includes('DEVICE_BAN_ERROR:') && Platform.OS !== 'web') {
      // Clean the error message for display (remove internal marker)
      const cleanMessage = error.replace('DEVICE_BAN_ERROR:', '');
      Alert.alert(
        'Device Banned',
        cleanMessage,
        [
          {
            text: 'OK',
            style: 'default',
          },
        ],
        { 
          cancelable: false 
        }
      );
    }
  }, [error]);

  const handleGoogleSignIn = async (options?: { reviewerQuickJoin?: boolean }) => {
    const reviewerQuickJoinRequested = Boolean(options?.reviewerQuickJoin);
    setIsSigningIn(true);
    setDisplayError(null);
    setSuccess(null);
    clearError();

    if (reviewerQuickJoinRequested) {
      try {
        await markReviewerQuickJoinPending();
      } catch (storageError) {
        logger.warn('LoginScreen: failed to persist reviewer quick join intent', storageError);
      }
    }
    
    try {
      const result = await signInWithGoogle();
      
      if (!result.success) {
        if (reviewerQuickJoinRequested) {
          await clearReviewerQuickJoinPending().catch(() => undefined);
        }
        // For device ban errors on mobile, show alert for better visibility
        if (result.error && result.error.includes('DEVICE_BAN_ERROR:') && Platform.OS !== 'web') {
          // Clean the error message for display (remove internal marker)
          const cleanMessage = result.error.replace('DEVICE_BAN_ERROR:', '');
          Alert.alert(
            'Device Banned',
            cleanMessage,
            [
              {
                text: 'OK',
                style: 'default',
              },
            ],
            { 
              cancelable: false 
            }
          );
        }
        // For all error types, let the sign-in card display the error message
        // No need for additional alert dialogs as they're redundant
        setIsSigningIn(false);
      }
      if (result.success) {
        const name = result.user?.displayName || result.user?.email?.split('@')[0] || 'User';
        if (reviewerQuickJoinRequested) {
          const center = getReviewerQuickJoinCenterName();
          setSuccess(`Login successful. Welcome, ${name}! We will quickly request access to ${center}.`);
        } else {
          setSuccess(`Login successful. Welcome, ${name}! Redirecting...`);
        }
        // Auto-clear success after a short delay in case navigation lingers
        setTimeout(() => setSuccess(null), 4000);
      }
      // For successful sign-ins, navigation will be handled by the auth state change
    } catch (error) {
      logger.error('Sign in error:', error);
      setIsSigningIn(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Network Status Banner */}
      <AutoNetworkBanner />
      
      <SignInCard 
        onGoogleSignIn={() => handleGoogleSignIn()}
        onReviewerQuickSignIn={() => handleGoogleSignIn({ reviewerQuickJoin: true })}
        reviewerQuickJoinEnabled={isReviewerQuickJoinEnabled()}
        reviewerQuickJoinCenterName={getReviewerQuickJoinCenterName()}
        loading={loading || isSigningIn}
        error={displayError}
        success={success}
      />
    </View>
  );
}