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
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const previousOnlineStatusRef = useRef<boolean | null>(null);
  const isInitializedRef = useRef(false);
  const isInitialLoadRef = useRef(true);

  const resolveConnectionFromState = (state: NetInfoState): {
    isConnected: boolean;
    isInternetReachable: boolean;
    isOnline: boolean;
  } => {
    const rawConnected = state.isConnected ?? false;
    const rawReachable = state.isInternetReachable;

    if (Platform.OS === 'web') {
      const browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      const isConnected = browserOnline || rawConnected;
      const isInternetReachable = browserOnline || (rawReachable ?? rawConnected);
      return {
        isConnected,
        isInternetReachable,
        isOnline: browserOnline,
      };
    }

    const isInternetReachable = rawReachable ?? false;
    const isConnected = rawConnected;
    return {
      isConnected,
      isInternetReachable,
      isOnline: isConnected && isInternetReachable,
    };
  };

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let initialLoadTimer: ReturnType<typeof setTimeout> | undefined;

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
          
          if (!immediateOnline) {
            logger.debug('🚨 IMMEDIATE: Page loaded while offline');
          }
        }
        
        // Get initial state from NetInfo (more detailed but slower)
        const state = await NetInfo.fetch();
        const { isConnected, isInternetReachable, isOnline } = resolveConnectionFromState(state);
        
        logger.debug('🌐 NetInfo initial state:', { isConnected, isInternetReachable, isOnline });
        
        setNetworkStatus({
          isConnected,
          isInternetReachable,
          type: state.type || 'unknown',
          isWifiEnabled: state.isWifiEnabled,
        });

        // Set initial previous status and mark as initialized
        previousOnlineStatusRef.current = isOnline;
        isInitializedRef.current = true;
        
        // After 2 seconds, mark as no longer initial load
        initialLoadTimer = setTimeout(() => {
          isInitialLoadRef.current = false;
          setIsInitialLoad(false);
        }, 2000);

        // Set up listener for network changes
        unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
          const {
            isConnected,
            isInternetReachable,
            isOnline: isNowOnline,
          } = resolveConnectionFromState(state);

          // Only track offline status changes after initialization AND after initial load period
          if (previousOnlineStatusRef.current !== null && !isInitialLoadRef.current) {
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
            if (isInitializedRef.current && wasOnline !== null && !isInitialLoadRef.current) {
              // Set wasOffline to true when going from online to offline
              if (wasOnline && !isOnline) {
                logger.debug('📱 Web: Going offline (after initial load period)');
                setWasOffline(true);
              }
            }

            previousOnlineStatusRef.current = isOnline;
            if (!isInitializedRef.current) {
              isInitializedRef.current = true;
              // Also set the initial load timer for web
              initialLoadTimer = setTimeout(() => {
                isInitialLoadRef.current = false;
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
      if (initialLoadTimer) {
        clearTimeout(initialLoadTimer);
      }
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

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
