import { logger } from '@/lib/logger';
// Enhanced Device Tracking - Additional Data Points We Could Track
// This file documents additional device information that could be tracked
// but is not currently implemented in the main service

export interface EnhancedDeviceData {
  // === CURRENT TRACKED DATA (already implemented) ===
  // All the existing UserDevice interface properties...

  // === ADDITIONAL BATTERY INFORMATION ===
  batteryLevel?: number; // 0-1 (percentage as decimal)
  batteryState?: 'unknown' | 'unplugged' | 'charging' | 'full';
  isCharging?: boolean;
  lowPowerMode?: boolean; // iOS low power mode or Android battery saver

  // === DEVICE PERMISSIONS ===
  permissions?: {
    location?: 'granted' | 'denied' | 'restricted' | 'undetermined';
    notifications?: 'granted' | 'denied' | 'restricted' | 'undetermined';
    camera?: 'granted' | 'denied' | 'restricted' | 'undetermined';
    microphone?: 'granted' | 'denied' | 'restricted' | 'undetermined';
    photoLibrary?: 'granted' | 'denied' | 'restricted' | 'undetermined';
    contacts?: 'granted' | 'denied' | 'restricted' | 'undetermined';
    calendar?: 'granted' | 'denied' | 'restricted' | 'undetermined';
    reminders?: 'granted' | 'denied' | 'restricted' | 'undetermined';
  };

  // === STORAGE INFORMATION ===
  storage?: {
    freeStorage?: number; // bytes
    totalStorage?: number; // bytes
    usedStorage?: number; // bytes
    storagePercentageUsed?: number; // 0-100
  };

  // === DEVICE ORIENTATION & MOTION ===
  orientation?: {
    current?: 'portrait' | 'landscape' | 'portraitUpsideDown' | 'landscapeLeft' | 'landscapeRight';
    isLocked?: boolean;
    supportsOrientationChange?: boolean;
  };

  // === WEB-SPECIFIC CAPABILITIES ===
  webCapabilities?: {
    webGL?: boolean;
    webGL2?: boolean;
    webRTC?: boolean;
    webAssembly?: boolean;
    serviceWorker?: boolean;
    localStorage?: boolean;
    sessionStorage?: boolean;
    indexedDB?: boolean;
    webSockets?: boolean;
    geolocation?: boolean;
    deviceMotion?: boolean;
    deviceOrientation?: boolean;
    pushNotifications?: boolean;
    webShare?: boolean;
    mediaDevices?: boolean;
    webBluetooth?: boolean;
    webUSB?: boolean;
    webNFC?: boolean;
  };

  // === PERFORMANCE METRICS ===
  performance?: {
    memoryUsage?: {
      used?: number;
      total?: number;
      heapUsed?: number;
      heapTotal?: number;
    };
    cpu?: {
      usage?: number; // percentage
      cores?: number;
      architecture?: string;
    };
    network?: {
      downlink?: number; // Mbps
      effectiveType?: '2g' | '3g' | '4g' | 'slow-2g';
      rtt?: number; // round trip time in ms
      saveData?: boolean; // data saver mode
    };
  };

  // === ACCESSIBILITY FEATURES ===
  accessibility?: {
    screenReader?: boolean;
    highContrast?: boolean;
    reduceMotion?: boolean;
    reducedTransparency?: boolean;
    voiceOver?: boolean; // iOS
    talkBack?: boolean; // Android
    fontSize?: 'small' | 'normal' | 'large' | 'extraLarge';
  };

  // === SECURITY FEATURES ===
  security?: {
    biometricType?: 'fingerprint' | 'face' | 'iris' | 'none';
    biometricAvailable?: boolean;
    passcodeSet?: boolean;
    jailbroken?: boolean; // iOS
    rooted?: boolean; // Android
    debugMode?: boolean;
    mockLocation?: boolean; // Android
  };

  // === LOCATION INFORMATION (if permitted) ===
  location?: {
    accuracy?: number;
    latitude?: number;
    longitude?: number;
    altitude?: number;
    city?: string;
    region?: string;
    country?: string;
    timestamp?: Date;
  };

  // === APP-SPECIFIC METRICS ===
  appMetrics?: {
    launchCount?: number;
    totalUsageTime?: number; // milliseconds
    lastLaunchTime?: Date;
    crashCount?: number;
    averageSessionDuration?: number; // milliseconds
    featuresUsed?: string[]; // array of feature names
  };

  // === DEVICE HEALTH ===
  deviceHealth?: {
    temperature?: number; // Celsius
    availableMemory?: number; // bytes
    cpuUsage?: number; // percentage
    diskIORate?: number; // bytes per second
    networkLatency?: number; // milliseconds
  };
}

// Example implementation functions that could be added to DeviceTrackingService:

/**
 * Get battery information (requires expo-battery or react-native-device-info)
 */
async function getBatteryInfo(): Promise<any> {
  try {
    // Would require: expo install expo-battery
    // const Battery = require('expo-battery');
    // return {
    //   batteryLevel: await Battery.getBatteryLevelAsync(),
    //   batteryState: await Battery.getBatteryStateAsync(),
    //   isCharging: await Battery.getBatteryStateAsync() === Battery.BatteryState.CHARGING,
    //   lowPowerMode: await Battery.isLowPowerModeEnabledAsync()
    // };
    return {};
  } catch (error) {
    logger.warn('Failed to get battery info:', error);
    return {};
  }
}

/**
 * Get device permissions status
 */
async function getPermissionsInfo(): Promise<any> {
  try {
    // Would use expo-permissions or @react-native-async-storage/permissions
    // const { Permissions } = require('expo-permissions');
    // const location = await Permissions.getAsync(Permissions.LOCATION);
    // const camera = await Permissions.getAsync(Permissions.CAMERA);
    // etc...
    return {};
  } catch (error) {
    logger.warn('Failed to get permissions info:', error);
    return {};
  }
}

/**
 * Get storage information
 */
async function getStorageInfo(): Promise<any> {
  try {
    // Would require react-native-device-info
    // const DeviceInfo = require('react-native-device-info');
    // return {
    //   freeStorage: await DeviceInfo.getFreeDiskStorage(),
    //   totalStorage: await DeviceInfo.getTotalDiskCapacity(),
    //   usedStorage: totalStorage - freeStorage
    // };
    return {};
  } catch (error) {
    logger.warn('Failed to get storage info:', error);
    return {};
  }
}

/**
 * Get web capabilities (web only)
 */
function getWebCapabilities(): any {
  if (typeof window === 'undefined') return {};
  
  try {
    return {
      webGL: !!window.WebGLRenderingContext,
      webGL2: !!window.WebGL2RenderingContext,
      webRTC: !!(window.RTCPeerConnection || (window as any).webkitRTCPeerConnection),
      webAssembly: typeof WebAssembly === 'object',
      serviceWorker: 'serviceWorker' in navigator,
      localStorage: typeof Storage !== 'undefined' && !!window.localStorage,
      sessionStorage: typeof Storage !== 'undefined' && !!window.sessionStorage,
      indexedDB: !!window.indexedDB,
      webSockets: !!window.WebSocket,
      geolocation: 'geolocation' in navigator,
      deviceMotion: 'DeviceMotionEvent' in window,
      deviceOrientation: 'DeviceOrientationEvent' in window,
      pushNotifications: 'PushManager' in window,
      webShare: 'share' in navigator,
      mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      webBluetooth: 'bluetooth' in navigator,
      webUSB: 'usb' in navigator,
      webNFC: 'nfc' in navigator
    };
  } catch (error) {
    logger.warn('Failed to get web capabilities:', error);
    return {};
  }
}

/**
 * Get device orientation information
 */
function getOrientationInfo(): any {
  try {
    if (typeof window === 'undefined') return {};
    
    // For web
    const orientation = screen.orientation || (screen as any).mozOrientation || (screen as any).msOrientation;
    return {
      current: orientation?.type || 'unknown',
      angle: orientation?.angle || 0,
      supportsOrientationChange: 'onorientationchange' in window
    };
  } catch (error) {
    logger.warn('Failed to get orientation info:', error);
    return {};
  }
}

export const EnhancedDeviceTracking = {
  getBatteryInfo,
  getPermissionsInfo,
  getStorageInfo,
  getWebCapabilities,
  getOrientationInfo
};
