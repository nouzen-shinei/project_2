import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity, Platform } from 'react-native';
import { Wifi, WifiOff, X, AlertTriangle } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';

interface NetworkBannerProps {
  isOnline: boolean;
  wasOffline: boolean;
  onDismiss?: () => void;
  userName?: string;
  userEmail?: string;
  // When true, show a warning banner for slow/unstable internet while online
  isSlow?: boolean;
}

export default function NetworkBanner({ 
  isOnline, 
  wasOffline, 
  onDismiss,
  userName,
  userEmail,
  isSlow
}: NetworkBannerProps) {
  const { theme } = useTheme();
  const sharedTopPadding = useSharedTopPadding({ minPadding: 0, extraPadding: 12, webPadding: 20 });
  const [visible, setVisible] = useState(false);
  const [slideAnim] = useState(new Animated.Value(-100));
  const [autoHideTimer, setAutoHideTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  // Track latest online status to avoid stale timer dismissing while offline
  const isOnlineRef = useRef(isOnline);

  useEffect(() => {
    isOnlineRef.current = isOnline;
  }, [isOnline]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (autoHideTimer) {
        clearTimeout(autoHideTimer);
      }
    };
  }, []);

  useEffect(() => {
    // Clear any existing timer first
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      setAutoHideTimer(null);
    }
    
    // Show banner when going offline (immediate or runtime)
    if (!isOnline) {
      setVisible(true);
      
      // Animate in
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 8,
      }).start();
    }
    // Show "Back online" banner only if we were previously offline
    else if (isOnline && wasOffline) {
      setVisible(true);
      
      // Animate in
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 8,
      }).start();

      // Auto hide "Back online" after 10 seconds (only if still online)
      const timer = setTimeout(() => {
        if (isOnlineRef.current) {
          handleDismiss();
        }
      }, 10000);
      setAutoHideTimer(timer);
    }
    // Show slow connection banner if connection is slow and we're online
    else if (isOnline && isSlow) {
      setVisible(true);

      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 100,
        friction: 8,
      }).start();
      // No auto-hide; remains until condition clears or user dismisses
    }
    // Hide banner if online and was never offline (initial load case)
    else if (isOnline && !wasOffline && !isSlow && visible) {
      handleDismiss();
    }

    // Cleanup timer on unmount
    return () => {
      if (autoHideTimer) {
        clearTimeout(autoHideTimer);
      }
    };
  }, [isOnline, wasOffline, isSlow]);

  const handleDismiss = () => {
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      setAutoHideTimer(null);
    }

    Animated.timing(slideAnim, {
      toValue: -100,
      duration: 300,
      useNativeDriver: true,
    }).start(() => {
      setVisible(false);
      // Clear wasOffline flag when dismissing "Back online" message
      if (isOnline && wasOffline && onDismiss) {
        onDismiss();
      }
    });
  };

  // Don't render anything if not visible - this prevents any touch interference
  if (!visible) {
    return null;
  }

  // Only show banner if offline OR if online and was previously offline OR slow connection
  const shouldShow = !isOnline || (isOnline && wasOffline) || (isOnline && isSlow);
  
  if (!shouldShow) {
    return null;
  }

  let backgroundColor = '#10B981';
  if (!isOnline) {
    backgroundColor = '#EF4444'; // Red for offline
  } else if (isOnline && isSlow && !wasOffline) {
    backgroundColor = '#F59E0B'; // Amber for slow/unstable
  } else {
    backgroundColor = '#10B981'; // Green for back online
  }

  const icon = !isOnline
    ? <WifiOff size={20} color="#ffffff" />
    : (isSlow && !wasOffline)
      ? <AlertTriangle size={20} color="#ffffff" />
      : <Wifi size={20} color="#ffffff" />;

  let message = 'No internet connection';
  if (isOnline && wasOffline) {
    message = `Welcome back${userName ? `, ${userName}` : userEmail ? `, ${userEmail}` : ''}!`;
  } else if (isOnline && isSlow && !wasOffline) {
    message = 'Connection is slow. Some actions may take longer.';
  }

  return (
    <Animated.View
      style={[
        styles.banner,
        { 
          backgroundColor,
          transform: [{ translateY: slideAnim }],
          paddingTop: sharedTopPadding,
          pointerEvents: 'auto',
        },
      ]}
    >
      <View style={styles.content}>
        {icon}
        <Text style={styles.message}>{message}</Text>
      </View>
      
      {isOnline && (
        <TouchableOpacity
          style={styles.dismissButton}
          onPress={handleDismiss}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <X size={16} color="#ffffff" />
        </TouchableOpacity>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 10, // Reduced from 1000 to avoid blocking navigation
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)'
    } : {
      shadowColor: '#000',
      shadowOffset: {
        width: 0,
        height: 2,
      },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 5,
    }),
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  message: {
    color: '#ffffff',
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    marginLeft: 8,
    flex: 1,
  },
  dismissButton: {
    padding: 4,
    marginLeft: 8,
  },
});
