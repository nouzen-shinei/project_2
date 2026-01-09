import React from 'react';
import NetworkBanner from './NetworkBanner';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useNetworkQuality } from '../hooks/useNetworkQuality';
import { useAuth } from '../hooks/useAuthUnified';

/**
 * AutoNetworkBanner centralizes network state + quality detection
 * and feeds props into the presentational NetworkBanner.
 */
export default function AutoNetworkBanner() {
  const { isOnline, wasOffline, clearWasOffline } = useNetworkStatus();
  const { isSlow } = useNetworkQuality();
  const { user } = useAuth();

  return (
    <NetworkBanner
      isOnline={isOnline}
      wasOffline={wasOffline}
      onDismiss={clearWasOffline}
      isSlow={isSlow}
      userName={user?.displayName}
      userEmail={user?.email}
    />
  );
}
