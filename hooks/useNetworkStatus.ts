import { logger } from '@/lib/logger';
import { useState, useEffect, useRef } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { Platform } from 'react-native';

export interface NetworkStatus {
  isConnected: boolean;
  isInternetReachable: boolean;
  type: string;
  isWifiEnabled?: boolean;
}

export function useNetworkStatus() {
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>({
    isConnected: true,
    isInternetReachable: true,
    type: 'unknown',
    isWifiEnabled: false,
  });
  const [wasOffline, setWasOffline] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const previousOnlineStatusRef = useRef<boolean | null>(null);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const setupNetworkListener = async () => {
      try {
        // IMMEDIATE check for web using navigator.onLine
        if (Platform.OS === 'web') {
          const immediateOnline = navigator.onLine;
          logger.debug('🌐 IMMEDIATE network check (navigator.onLine):', immediateOnline);
          
          setNetworkStatus({
            isConnected: immediateOnline,
            isInternetReachable: immediateOnline,
            type: 'unknown',
            isWifiEnabled: false,
          });
          // If the app opens while offline, mark that we were offline so we can show
          // the "Back online" banner once connectivity returns.
          if (!immediateOnline) {
            setWasOffline(true);
          }
          
          if (!immediateOnline) {
            logger.debug('🚨 IMMEDIATE: Page loaded while offline');
          }
        }
        
        // Get initial state from NetInfo (more detailed but slower)
        const state = await NetInfo.fetch();
        const isConnected = state.isConnected ?? false;
        const isInternetReachable = state.isInternetReachable ?? false;
        const isOnline = isConnected && isInternetReachable;
        
        logger.debug('🌐 NetInfo initial state:', { isConnected, isInternetReachable, isOnline });
        
        setNetworkStatus({
          isConnected,
          isInternetReachable,
          type: state.type || 'unknown',
          isWifiEnabled: state.isWifiEnabled,
        });

        // If the app starts offline, mark wasOffline so the UI can later show
        // the "Back online" banner when connectivity is restored.
        if (!isOnline) {
          setWasOffline(true);
        }

        // Set initial previous status and mark as initialized
        previousOnlineStatusRef.current = isOnline;
        setIsInitialized(true);
        
        // After 2 seconds, mark as no longer initial load
        setTimeout(() => {
          setIsInitialLoad(false);
        }, 2000);

        // Set up listener for network changes
        unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
          const isConnected = state.isConnected ?? false;
          const isInternetReachable = state.isInternetReachable ?? false;
          const isNowOnline = isConnected && isInternetReachable;

          // Only track offline status changes after initialization AND after initial load period
          if (previousOnlineStatusRef.current !== null && !isInitialLoad) {
            const wasOnline = previousOnlineStatusRef.current;
            
            // Set wasOffline to true when going from online to offline
            if (wasOnline && !isNowOnline) {
              logger.debug('📱 Going offline (after initial load period)');
              setWasOffline(true);
            }
          }

          // Update previous status
          previousOnlineStatusRef.current = isNowOnline;

          setNetworkStatus({
            isConnected,
            isInternetReachable,
            type: state.type || 'unknown',
            isWifiEnabled: state.isWifiEnabled,
          });
        });
      } catch (error) {
        logger.error('Error setting up network listener:', error);
        
        // Fallback for web or if NetInfo fails
        if (Platform.OS === 'web') {
          const updateOnlineStatus = () => {
            const isOnline = navigator.onLine;
            const wasOnline = previousOnlineStatusRef.current;
            
            // Only track offline status changes after initialization AND after initial load
            if (isInitialized && wasOnline !== null && !isInitialLoad) {
              // Set wasOffline to true when going from online to offline
              if (wasOnline && !isOnline) {
                logger.debug('📱 Web: Going offline (after initial load period)');
                setWasOffline(true);
              }
            }

            // Also handle the case where the page loads offline initially.
            if (!isOnline && wasOnline === null) {
              setWasOffline(true);
            }

            previousOnlineStatusRef.current = isOnline;
            if (!isInitialized) {
              setIsInitialized(true);
              // Also set the initial load timer for web
              setTimeout(() => {
                setIsInitialLoad(false);
              }, 2000);
            }
            
            setNetworkStatus({
              isConnected: isOnline,
              isInternetReachable: isOnline,
              type: 'unknown',
            });
          };

          updateOnlineStatus();
          window.addEventListener('online', updateOnlineStatus);
          window.addEventListener('offline', updateOnlineStatus);

          unsubscribe = () => {
            window.removeEventListener('online', updateOnlineStatus);
            window.removeEventListener('offline', updateOnlineStatus);
          };
        }
      }
    };

    setupNetworkListener();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [isInitialLoad]); // Include isInitialLoad in dependencies

  const isOnline = networkStatus.isConnected && networkStatus.isInternetReachable;
  const isOffline = !isOnline;

  return {
    ...networkStatus,
    isOnline,
    isOffline,
    wasOffline,
    isInitialLoad,
    clearWasOffline: () => setWasOffline(false),
  };
}
