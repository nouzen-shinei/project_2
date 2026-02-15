import { logger } from '@/lib/logger';
import React, { useMemo, useCallback, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform
} from 'react-native';
import {
  X,
  Monitor,
  Globe,
  Wifi,
  WifiOff,
  MapPin,
  Clock,
  Shield,
  Info,
  Copy,
  Eye,
  Languages,
  Navigation,
  Activity,
  Settings,
  AlertTriangle,
  Cpu,
  HardDrive,
  Signal,
  Zap,
  Ban,
  RotateCcw,
  LogOut,
  Link,
  Hash,
  Video,
  Bell,
  Camera,
  Mic,
  Share2,
  Bluetooth,
  Usb,
  Nfc
} from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { useTheme } from '../hooks/useTheme';
import { UserDevice } from '../services/deviceTrackingService';
import DeviceActionModal from './DeviceActionModal';

interface BrowserDeviceModalProps {
  visible: boolean;
  onClose: () => void;
  device: UserDevice;
  userEmail: string;
  adminEmail: string;
  adminName: string;
  onDeviceUpdate: () => void;
}

function BrowserDeviceModal({
  visible,
  onClose,
  device,
  userEmail,
  adminEmail,
  adminName,
  onDeviceUpdate
}: BrowserDeviceModalProps) {
  const { theme } = useTheme();
  const [showDeviceActionModal, setShowDeviceActionModal] = useState(false);
  const [selectedActionType, setSelectedActionType] = useState<'delete' | 'restore' | 'logout' | null>(null);

  // Enhanced debug logging
  React.useEffect(() => {
    logger.debug('🔍 BrowserDeviceModal - useEffect triggered:', { visible, hasDevice: !!device });
    if (visible && device) {
      logger.debug('🔍 BrowserDeviceModal - Device data received:', {
        deviceId: device.deviceId,
        lastLogin: device.lastLogin,
        lastLoginType: typeof device.lastLogin,
        lastLoginFormatted: formatTimestamp(device.lastLogin),
        lastActivityType: device.lastActivityType,
        lastActivityTypeType: typeof device.lastActivityType,
        sessionId: device.sessionId,
        lastSeen: device.lastSeen,
        createdAt: device.createdAt,
        updatedAt: device.updatedAt,
        userAgent: device.userAgent,
        allKeys: Object.keys(device),
        fullDeviceObject: device
      });
      
      // Test individual field access
      logger.debug('🔍 BrowserDeviceModal - Direct field access tests:');
      logger.debug('- device.lastLogin:', device.lastLogin);
      logger.debug('- device.lastActivityType:', device.lastActivityType);
      logger.debug('- device.sessionId:', device.sessionId);
      logger.debug('- device.userAgent:', device.userAgent);
    }
  }, [visible, device]);

  // Log every render
  logger.debug('🔍 BrowserDeviceModal - Rendering with device data:', {
    visible,
    deviceId: device?.deviceId,
    lastLogin: device?.lastLogin,
    lastActivityType: device?.lastActivityType,
    sessionId: device?.sessionId
  });

  // Safe property access helpers
  const getDeviceProperty = useCallback((property: keyof UserDevice): string => {
    const value = device[property];
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string') return value || 'N/A';
    if (typeof value === 'number') return value.toString();
    if (value instanceof Date) return value.toLocaleString();
    if (typeof value === 'object' && value && 'toDate' in value && typeof value.toDate === 'function') {
      try {
        return value.toDate().toLocaleString();
      } catch {
        return 'N/A';
      }
    }
    return String(value) || 'N/A';
  }, [device]);

  const getBooleanProperty = useCallback((property: keyof UserDevice): boolean => {
    return Boolean(device[property]);
  }, [device]);

  const getNumberProperty = useCallback((property: keyof UserDevice): number => {
    const value = device[property];
    return typeof value === 'number' ? value : 0;
  }, [device]);

  // Generic property getter for properties that might not be in UserDevice interface
  const getGenericProperty = useCallback((property: string): string => {
    const value = (device as any)[property];
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string') return value || 'N/A';
    if (typeof value === 'number') return value.toString();
    return String(value) || 'N/A';
  }, [device]);

  const getGenericNumberProperty = useCallback((property: string): number => {
    const value = (device as any)[property];
    return typeof value === 'number' ? value : 0;
  }, [device]);

  // Enhanced timestamp formatting
  const formatTimestamp = useCallback((timestamp: any): string => {
    if (!timestamp) return 'Never';
    
    try {
      let date: Date;
      
      // Handle serverTimestamp objects (not yet resolved)
      if (timestamp && typeof timestamp === 'object' && (timestamp as any)._methodName === 'serverTimestamp') {
        logger.warn('Detected unresolved serverTimestamp:', timestamp);
        return 'Just now'; // Use current time for unresolved serverTimestamp
      }
      // Handle Firestore Timestamp objects
      else if (timestamp && typeof timestamp === 'object' && 'toDate' in timestamp && typeof timestamp.toDate === 'function') {
        date = timestamp.toDate();
      }
      // Handle Date objects
      else if (timestamp instanceof Date) {
        date = timestamp;
      }
      // Handle strings/numbers
      else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
        date = new Date(timestamp);
      }
      // Handle objects with seconds property (Firestore timestamp format)
      else if (timestamp && typeof timestamp === 'object' && timestamp.seconds) {
        date = new Date(timestamp.seconds * 1000);
      }
      else {
        logger.warn('Unknown timestamp format:', timestamp);
        return 'Invalid date';
      }
      
      if (isNaN(date.getTime())) {
        logger.warn('Invalid date created from timestamp:', timestamp);
        return 'Invalid date';
      }
      
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let relative = '';
      if (diffMins < 1) relative = 'Just now';
      else if (diffMins < 60) relative = `${diffMins}m ago`;
      else if (diffHours < 24) relative = `${diffHours}h ago`;
      else if (diffDays === 1) relative = 'Yesterday';
      else if (diffDays < 7) relative = `${diffDays}d ago`;
      else relative = date.toLocaleDateString();

      return `${relative} (${date.toLocaleString()})`;
    } catch (error) {
      logger.error('Error formatting timestamp:', error, 'Original value:', timestamp);
      return 'Invalid date';
    }
  }, []);

  // Format future timestamp (like ban expiry)
  const formatFutureTimestamp = useCallback((timestamp: any): string => {
    if (!timestamp) return 'Never';
    
    try {
      let date: Date;
      
      // Handle serverTimestamp objects (not yet resolved)
      if (timestamp && typeof timestamp === 'object' && (timestamp as any)._methodName === 'serverTimestamp') {
        logger.warn('Detected unresolved serverTimestamp:', timestamp);
        return 'Just now'; // Use current time for unresolved serverTimestamp
      }
      // Handle Firestore Timestamp objects
      else if (timestamp && typeof timestamp === 'object' && 'toDate' in timestamp && typeof timestamp.toDate === 'function') {
        date = timestamp.toDate();
      }
      // Handle Date objects
      else if (timestamp instanceof Date) {
        date = timestamp;
      }
      // Handle strings/numbers
      else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
        date = new Date(timestamp);
      }
      // Handle objects with seconds property (Firestore timestamp format)
      else if (timestamp && typeof timestamp === 'object' && timestamp.seconds) {
        date = new Date(timestamp.seconds * 1000);
      }
      else {
        logger.warn('Unknown timestamp format:', timestamp);
        return 'Invalid date';
      }
      
      if (isNaN(date.getTime())) {
        logger.warn('Invalid date created from timestamp:', timestamp);
        return 'Invalid date';
      }
      
      const now = new Date();
      const diffMs = date.getTime() - now.getTime(); // Reversed for future dates
      
      if (diffMs <= 0) {
        return `Expired (${date.toLocaleString()})`;
      }
      
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let relative = '';
      if (diffMins < 1) relative = 'Less than 1 minute';
      else if (diffMins < 60) relative = `${diffMins} minute${diffMins > 1 ? 's' : ''}`;
      else if (diffHours < 24) relative = `${diffHours} hour${diffHours > 1 ? 's' : ''}`;
      else if (diffDays === 1) relative = 'Tomorrow';
      else if (diffDays < 7) relative = `${diffDays} day${diffDays > 1 ? 's' : ''}`;
      else relative = date.toLocaleDateString();

      return `${relative} (${date.toLocaleString()})`;
    } catch (error) {
      logger.error('Error formatting future timestamp:', error, 'Original value:', timestamp);
      return 'Invalid date';
    }
  }, []);

  // Browser information
  const browserInfo = useMemo(() => {
    const browserName = getDeviceProperty('browserName');
    const browserVersion = getDeviceProperty('browserVersion');
    const userAgent = getDeviceProperty('userAgent');
    const osName = getDeviceProperty('osName');
    const osVersion = getDeviceProperty('osVersion');
    
    return {
      name: browserName !== 'N/A' ? browserName : 'Unknown Browser',
      version: browserVersion !== 'N/A' ? browserVersion : 'Unknown Version',
      fullName: browserName !== 'N/A' && browserVersion !== 'N/A' 
        ? `${browserName} ${browserVersion}` 
        : 'Unknown Browser',
      userAgent: userAgent !== 'N/A' ? userAgent : null,
      os: osName !== 'N/A' && osVersion !== 'N/A' ? `${osName} ${osVersion}` : 'Unknown OS'
    };
  }, [getDeviceProperty]);

  // Display information
  const displayInfo = useMemo(() => {
    const screenWidth = getNumberProperty('screenWidth');
    const screenHeight = getNumberProperty('screenHeight');
    const viewportWidth = getNumberProperty('viewportWidth');
    const viewportHeight = getNumberProperty('viewportHeight');
    const colorDepth = getGenericNumberProperty('colorDepth');
    const pixelDepth = getGenericNumberProperty('pixelDepth');
    
    return {
      screenResolution: screenWidth && screenHeight ? `${screenWidth} × ${screenHeight}` : 'Unknown',
      viewportSize: viewportWidth && viewportHeight ? `${viewportWidth} × ${viewportHeight}` : 'Unknown',
      colorDepth: colorDepth > 0 ? `${colorDepth}-bit` : 'Unknown',
      pixelDepth: pixelDepth > 0 ? `${pixelDepth}-bit` : 'Unknown'
    };
  }, [getNumberProperty, getGenericNumberProperty]);

  // Performance information
  const performanceInfo = useMemo(() => {
    const hardwareConcurrency = getGenericNumberProperty('hardwareConcurrency');
    const jsHeapSizeLimit = getGenericNumberProperty('jsHeapSizeLimit');
    const totalJSHeapSize = getGenericNumberProperty('totalJSHeapSize');
    const usedJSHeapSize = getGenericNumberProperty('usedJSHeapSize');
    
    return {
      cpuCores: hardwareConcurrency > 0 ? hardwareConcurrency.toString() : 'Unknown',
      heapLimit: jsHeapSizeLimit > 0 ? `${Math.round(jsHeapSizeLimit / (1024 * 1024))} MB` : 'Unknown',
      totalHeap: totalJSHeapSize > 0 ? `${Math.round(totalJSHeapSize / (1024 * 1024))} MB` : 'Unknown',
      usedHeap: usedJSHeapSize > 0 ? `${Math.round(usedJSHeapSize / (1024 * 1024))} MB` : 'Unknown'
    };
  }, [getGenericNumberProperty]);

  // Network information
  const networkInfo = useMemo(() => {
    const ipAddress = getDeviceProperty('ipAddress');
    const connectionType = getGenericProperty('connectionType');
    const downlink = getGenericNumberProperty('downlink');
    const onLine = getBooleanProperty('onLine');
    
    return {
      ipAddress,
      connectionType,
      downlink: downlink > 0 ? `${downlink} Mbps` : 'Unknown',
      onlineStatus: onLine ? 'Online' : 'Offline'
    };
  }, [getDeviceProperty, getGenericProperty, getGenericNumberProperty, getBooleanProperty]);

  // URL and navigation information
  const urlInfo = useMemo(() => {
    const currentUrl = getGenericProperty('currentUrl');
    const hostname = getGenericProperty('hostname');
    const pathname = getGenericProperty('pathname');
    const search = getGenericProperty('search');
    const hash = getGenericProperty('hash');
    const protocol = getGenericProperty('protocol');
    const port = getGenericProperty('port');
    const origin = getGenericProperty('origin');
    const referrer = getGenericProperty('referrer');
    
    return {
      currentUrl,
      hostname,
      pathname,
      search,
      hash,
      protocol,
      port,
      origin,
      referrer
    };
  }, [getGenericProperty]);

  // Web capabilities and storage
  const webCapabilities = useMemo(() => {
    const webGLSupport = getBooleanProperty('webGLSupport');
    const webGL2Support = getBooleanProperty('webGL2Support');
    const webRTCSupport = getBooleanProperty('webRTCSupport');
    const webAssemblySupport = getBooleanProperty('webAssemblySupport');
    const serviceWorkerSupport = getBooleanProperty('serviceWorkerSupport');
    const localStorageSupport = getBooleanProperty('localStorageSupport');
    const sessionStorageSupport = getBooleanProperty('sessionStorageSupport');
    const indexedDBSupport = getBooleanProperty('indexedDBSupport');
    const webSocketsSupport = getBooleanProperty('webSocketsSupport');
    const geolocationSupport = getBooleanProperty('geolocationSupport');
    const deviceMotionSupport = getBooleanProperty('deviceMotionSupport');
    const deviceOrientationSupport = getBooleanProperty('deviceOrientationSupport');
    const pushNotificationsSupport = getBooleanProperty('pushNotificationsSupport');
    const webShareSupport = getBooleanProperty('webShareSupport');
    const mediaDevicesSupport = getBooleanProperty('mediaDevicesSupport');
    const webBluetoothSupport = getBooleanProperty('webBluetoothSupport');
    const webUSBSupport = getBooleanProperty('webUSBSupport');
    const webNFCSupport = getBooleanProperty('webNFCSupport');
    const freeStorage = getGenericNumberProperty('freeStorage');
    const totalStorage = getGenericNumberProperty('totalStorage');
    const usedStorage = getGenericNumberProperty('usedStorage');
    const storagePercentageUsed = getGenericNumberProperty('storagePercentageUsed');
    
    return {
      webGLSupport,
      webGL2Support,
      webRTCSupport,
      webAssemblySupport,
      serviceWorkerSupport,
      localStorageSupport,
      sessionStorageSupport,
      indexedDBSupport,
      webSocketsSupport,
      geolocationSupport,
      deviceMotionSupport,
      deviceOrientationSupport,
      pushNotificationsSupport,
      webShareSupport,
      mediaDevicesSupport,
      webBluetoothSupport,
      webUSBSupport,
      webNFCSupport,
      totalStorage: totalStorage > 0 ? `${Math.round(totalStorage / (1024 * 1024 * 1024))} GB` : 'Unknown',
      usedStorage: usedStorage > 0 ? `${Math.round(usedStorage / (1024 * 1024 * 1024))} GB` : 'Unknown',
      freeStorage: freeStorage > 0 ? `${Math.round(freeStorage / (1024 * 1024 * 1024))} GB` : 'Unknown',
      storagePercentageUsed: storagePercentageUsed > 0 ? Math.round(storagePercentageUsed) : 0
    };
  }, [getBooleanProperty, getGenericNumberProperty]);

  const idSourceInfo = useMemo(() => {
    const raw = getGenericProperty('deviceIdSource');
    if (raw === 'stable_seed') {
      return { label: 'Stable seed', tone: 'stable' as const };
    }
    if (raw === 'fingerprint_fallback') {
      return { label: 'Fallback', tone: 'fallback' as const };
    }
    return { label: 'Unknown', tone: 'unknown' as const };
  }, [getGenericProperty]);

  // Device permissions for web
  const webPermissions = useMemo(() => {
    const locationPermission = getGenericProperty('locationPermission');
    const notificationPermission = getGenericProperty('notificationPermission');
    const cameraPermission = getGenericProperty('cameraPermission');
    const microphonePermission = getGenericProperty('microphonePermission');
    
    return {
      locationPermission: locationPermission !== 'N/A' ? locationPermission : 'Unknown',
      notificationPermission: notificationPermission !== 'N/A' ? notificationPermission : 'Unknown',
      cameraPermission: cameraPermission !== 'N/A' ? cameraPermission : 'Unknown',
      microphonePermission: microphonePermission !== 'N/A' ? microphonePermission : 'Unknown'
    };
  }, [getGenericProperty]);

  // Copy to clipboard
  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await Clipboard.setStringAsync(text);
      Toast.show({
        type: 'success',
        text1: 'Copied',
        text2: `${label} copied to clipboard`
      });
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Copy Failed',
        text2: 'Could not copy to clipboard'
      });
    }
  }, []);

  // Device actions
  const handleOpenDeviceAction = useCallback((action: 'delete' | 'restore' | 'logout') => {
    setSelectedActionType(action);
    setShowDeviceActionModal(true);
  }, []);

  const handleDeviceActionComplete = useCallback(() => {
    setShowDeviceActionModal(false);
    setSelectedActionType(null);
    onDeviceUpdate();
  }, [onDeviceUpdate]);

  // Detail row component
  const DetailRow = useCallback(({ 
    icon, 
    label, 
    value, 
    copyable = false
  }: {
    icon: React.ReactNode;
    label: string;
    value: string;
    copyable?: boolean;
  }) => (
    <View style={styles.detailRow}>
      <View style={styles.detailLabel}>
        {icon}
        <Text style={[styles.labelText, { color: theme.textSecondary }]}>{label}</Text>
      </View>
      <View style={styles.detailValue}>
        <Text style={[styles.valueText, { color: theme.text }]} selectable numberOfLines={2}>
          {value}
        </Text>
        {copyable && value !== 'N/A' && value !== 'Unknown' && (
          <TouchableOpacity
            onPress={() => copyToClipboard(value, label)}
            style={[styles.actionButton, { backgroundColor: theme.primary + '20' }]}
          >
            <Copy size={12} color={theme.primary} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  ), [theme, copyToClipboard]);

  const isDeleted = getBooleanProperty('isDeleted');
  const isOnline = getBooleanProperty('isOnline');
  const isHardBanned = getBooleanProperty('isHardBanned');
  const logoutType = getDeviceProperty('logoutType');
  const lastActivityType = getDeviceProperty('lastActivityType');

  // Determine device status with priority: Hard Banned > Deleted > Forced Logout > Manual Logout > Online/Offline
  const getDeviceStatus = useCallback(() => {
    if (isHardBanned) {
      return {
        text: 'Hard Banned',
        color: theme.error,
        icon: <Ban size={16} color={theme.error} />,
        bgColor: theme.error + '15',
        borderColor: theme.error
      };
    }
    
    if (isDeleted) {
      return {
        text: 'Device Deleted',
        color: theme.error,
        icon: <AlertTriangle size={16} color={theme.error} />,
        bgColor: theme.error + '15',
        borderColor: theme.error
      };
    }
    
    if (logoutType === 'forced' || lastActivityType === 'forced_logout') {
      return {
        text: 'Forced Logout',
        color: theme.warning,
        icon: <LogOut size={16} color={theme.warning} />,
        bgColor: theme.warning + '15',
        borderColor: theme.warning
      };
    }
    
    if (logoutType === 'manual' || lastActivityType === 'logout') {
      return {
        text: 'Logged Out',
        color: theme.textSecondary,
        icon: <LogOut size={16} color={theme.textSecondary} />,
        bgColor: theme.textSecondary + '15',
        borderColor: theme.textSecondary
      };
    }
    
    if (isOnline) {
      return {
        text: 'Currently Online',
        color: theme.success,
        icon: <Wifi size={16} color={theme.success} />,
        bgColor: theme.success + '15',
        borderColor: theme.success
      };
    }
    
    return {
      text: 'Currently Offline',
      color: theme.textSecondary,
      icon: <WifiOff size={16} color={theme.textSecondary} />,
      bgColor: theme.textSecondary + '15',
      borderColor: theme.textSecondary
    };
  }, [isHardBanned, isDeleted, logoutType, lastActivityType, isOnline, theme]);

  const deviceStatus = getDeviceStatus();

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: theme.background }]}> 
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.border }]}> 
          <View style={styles.headerContent}> 
            <View style={styles.headerIcon}> 
              <Monitor size={24} color={theme.primary} /> 
            </View>
            <View style={styles.headerText}> 
              <Text style={[styles.title, { color: theme.text }]}>Web Browser Details</Text>
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}> 
                {userEmail} • {browserInfo.fullName}
              </Text>
            </View>
          </View>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}> 
            <X size={24} color={theme.textSecondary} /> 
          </TouchableOpacity>
        </View>

        {/* Add margin between header and status banner */}
        <View style={{ height: 16 }} />

        {/* Status Banner */}
        <View style={[
          styles.statusBanner,
          {
            backgroundColor: deviceStatus.bgColor,
            borderColor: deviceStatus.borderColor
          }
        ]}>
          <View style={styles.statusContent}>
            {deviceStatus.icon}
            <Text style={[styles.statusText, { color: deviceStatus.color }]}>
              {deviceStatus.text}
            </Text>
          </View>
          <Text style={[styles.statusTimestamp, { color: theme.textSecondary }]}>
            Last seen: {formatTimestamp(device.lastSeen)}
          </Text>
        </View>

        <ScrollView
          style={styles.content}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingBottom: Platform.select({ web: 0, default: 10 }),
          }}
        >
          {/* Basic Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Basic Information</Text>
            
            <DetailRow
              icon={<Monitor size={16} color={theme.primary} />}
              label="Device Name"
              value={getDeviceProperty('deviceName')}
              copyable
            />
            
            <DetailRow
              icon={<Shield size={16} color={theme.primary} />}
              label="Device ID"
              value={getDeviceProperty('deviceId')}
              copyable
            />

            <View style={styles.detailRow}>
              <View style={styles.detailLabel}>
                <Shield size={16} color={theme.primary} />
                <Text style={[styles.labelText, { color: theme.textSecondary }]}>ID Source</Text>
              </View>
              <View
                style={[
                  styles.idSourceBadge,
                  {
                    backgroundColor:
                      idSourceInfo.tone === 'stable'
                        ? theme.success + '20'
                        : idSourceInfo.tone === 'fallback'
                          ? theme.warning + '20'
                          : theme.textSecondary + '20',
                    borderColor:
                      idSourceInfo.tone === 'stable'
                        ? theme.success
                        : idSourceInfo.tone === 'fallback'
                          ? theme.warning
                          : theme.textSecondary
                  }
                ]}
              >
                <Text
                  style={[
                    styles.idSourceText,
                    {
                      color:
                        idSourceInfo.tone === 'stable'
                          ? theme.success
                          : idSourceInfo.tone === 'fallback'
                            ? theme.warning
                            : theme.textSecondary
                    }
                  ]}
                >
                  {idSourceInfo.label}
                </Text>
              </View>
            </View>
            
            <DetailRow
              icon={<Globe size={16} color={theme.primary} />}
              label="Browser"
              value={browserInfo.fullName}
            />
            
            <DetailRow
              icon={<MapPin size={16} color={theme.primary} />}
              label="IP Address"
              value={networkInfo.ipAddress}
              copyable
            />
            
            <DetailRow
              icon={<Clock size={16} color={theme.primary} />}
              label="First Registered"
              value={formatTimestamp(device.createdAt)}
            />
            
            <DetailRow
              icon={<Clock size={16} color={theme.warning} />}
              label="Last Login"
              value={formatTimestamp(device.lastLogin)}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.warning} />}
              label="Last Activity Type"
              value={device.lastActivityType || 'Not recorded'}
            />
          </View>

          {/* Detailed Status Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Device Status Details</Text>
            
            <DetailRow
              icon={<Activity size={16} color={deviceStatus.color} />}
              label="Current Status"
              value={deviceStatus.text}
            />
            
            {isHardBanned && device.banInfo && (
              <>
                <DetailRow
                  icon={<Ban size={16} color={theme.error} />}
                  label="Ban Status"
                  value={(() => {
                    if (!device.banInfo.expiresAt) return 'Permanent';
                    try {
                      let expiryDate: Date;
                      if (device.banInfo.expiresAt && typeof device.banInfo.expiresAt === 'object' && 'toDate' in device.banInfo.expiresAt) {
                        expiryDate = device.banInfo.expiresAt.toDate();
                      } else {
                        expiryDate = new Date(device.banInfo.expiresAt as any);
                      }
                      return expiryDate < new Date() ? 'Expired' : 'Active';
                    } catch {
                      return 'Active';
                    }
                  })()}
                />
                
                <DetailRow
                  icon={<Ban size={16} color={theme.error} />}
                  label="Ban Reason"
                  value={device.banInfo.reason || 'No reason provided'}
                />
                
                <DetailRow
                  icon={<Shield size={16} color={theme.error} />}
                  label="Banned By"
                  value={device.banInfo.adminName || device.banInfo.adminEmail || 'Unknown'}
                />
                
                <DetailRow
                  icon={<Clock size={16} color={theme.error} />}
                  label="Banned At"
                  value={formatTimestamp(device.banInfo.createdAt)}
                />
                
                {device.banInfo.expiresAt && (
                  <DetailRow
                    icon={<Clock size={16} color={theme.warning} />}
                    label="Ban Expires"
                    value={formatFutureTimestamp(device.banInfo.expiresAt)}
                  />
                )}
              </>
            )}
            
            {(logoutType === 'forced' || lastActivityType === 'forced_logout') && (
              <>
                <DetailRow
                  icon={<LogOut size={16} color={theme.warning} />}
                  label="Logout Type"
                  value="Forced by Administrator"
                />
                
                {device.forcedLogoutByName && (
                  <DetailRow
                    icon={<Shield size={16} color={theme.warning} />}
                    label="Forced Logout By"
                    value={device.forcedLogoutByName}
                  />
                )}
                
                {device.forcedLogoutAt && (
                  <DetailRow
                    icon={<Clock size={16} color={theme.warning} />}
                    label="Forced Logout At"
                    value={formatTimestamp(device.forcedLogoutAt)}
                  />
                )}
                
                {device.forcedLogoutReason && (
                  <DetailRow
                    icon={<Info size={16} color={theme.warning} />}
                    label="Logout Reason"
                    value={device.forcedLogoutReason}
                  />
                )}
              </>
            )}
            
            {logoutType === 'manual' && device.manualLogoutAt && (
              <DetailRow
                icon={<Clock size={16} color={theme.textSecondary} />}
                label="Manual Logout At"
                value={formatTimestamp(device.manualLogoutAt)}
              />
            )}
            
            {isDeleted && (
              <>
                <DetailRow
                  icon={<AlertTriangle size={16} color={theme.error} />}
                  label="Deleted By"
                  value={device.deletedByName || device.deletedBy || 'Unknown'}
                />
                
                <DetailRow
                  icon={<Clock size={16} color={theme.error} />}
                  label="Deleted At"
                  value={formatTimestamp(device.deletedAt)}
                />
                
                {device.deletionReason && (
                  <DetailRow
                    icon={<Info size={16} color={theme.error} />}
                    label="Deletion Reason"
                    value={device.deletionReason}
                  />
                )}
              </>
            )}
            
            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Session ID"
              value={device.sessionId || 'Not available'}
              copyable
            />
          </View>

          {/* Browser Details */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Browser Details</Text>
            
            <DetailRow
              icon={<Globe size={16} color={theme.success} />}
              label="Browser Name"
              value={browserInfo.name}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.success} />}
              label="Browser Version"
              value={browserInfo.version}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.success} />}
              label="Operating System"
              value={browserInfo.os}
            />
            
            <DetailRow
              icon={<Languages size={16} color={theme.success} />}
              label="Language"
              value={getDeviceProperty('language')}
            />
            
            <DetailRow
              icon={<Languages size={16} color={theme.success} />}
              label="Languages"
              value={getGenericProperty('languages')}
            />
            
            <DetailRow
              icon={<Clock size={16} color={theme.success} />}
              label="Timezone"
              value={getDeviceProperty('timezone')}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.success} />}
              label="Platform"
              value={getGenericProperty('platform')}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.success} />}
              label="Vendor"
              value={getGenericProperty('vendor')}
            />
          </View>

          {/* Display Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Display Information</Text>
            
            <DetailRow
              icon={<Eye size={16} color={theme.warning} />}
              label="Screen Resolution"
              value={displayInfo.screenResolution}
            />
            
            <DetailRow
              icon={<Eye size={16} color={theme.warning} />}
              label="Viewport Size"
              value={displayInfo.viewportSize}
            />
            
            <DetailRow
              icon={<Monitor size={16} color={theme.warning} />}
              label="Color Depth"
              value={displayInfo.colorDepth}
            />
            
            <DetailRow
              icon={<Monitor size={16} color={theme.warning} />}
              label="Pixel Depth"
              value={displayInfo.pixelDepth}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.warning} />}
              label="Touch Support"
              value={getGenericProperty('touchSupport')}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.warning} />}
              label="Max Touch Points"
              value={getGenericProperty('maxTouchPoints')}
            />
          </View>

          {/* Performance Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Performance Information</Text>
            
            <DetailRow
              icon={<Cpu size={16} color={theme.error} />}
              label="CPU Cores"
              value={performanceInfo.cpuCores}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.error} />}
              label="JS Heap Limit"
              value={performanceInfo.heapLimit}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.error} />}
              label="Total JS Heap"
              value={performanceInfo.totalHeap}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.error} />}
              label="Used JS Heap"
              value={performanceInfo.usedHeap}
            />
          </View>

          {/* Network Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Network Information</Text>
            
            <DetailRow
              icon={<Wifi size={16} color={theme.primary} />}
              label="Connection Type"
              value={networkInfo.connectionType}
            />
            
            <DetailRow
              icon={<Signal size={16} color={theme.primary} />}
              label="Download Speed"
              value={networkInfo.downlink}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Online Status"
              value={networkInfo.onlineStatus}
            />
            
            <DetailRow
              icon={<Shield size={16} color={theme.primary} />}
              label="Do Not Track"
              value={getGenericProperty('doNotTrack') || 'Not Set'}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.primary} />}
              label="Cookies Enabled"
              value={getGenericProperty('cookieEnabled')}
            />
          </View>

          {/* URL & Navigation Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>URL & Navigation Information</Text>
            
            <DetailRow
              icon={<Navigation size={16} color={theme.warning} />}
              label="Current URL"
              value={urlInfo.currentUrl}
              copyable
            />
            
            <DetailRow
              icon={<Globe size={16} color={theme.warning} />}
              label="Hostname"
              value={urlInfo.hostname}
              copyable
            />
            
            <DetailRow
              icon={<Link size={16} color={theme.warning} />}
              label="Pathname"
              value={urlInfo.pathname}
              copyable
            />
            
            <DetailRow
              icon={<Shield size={16} color={theme.warning} />}
              label="Protocol"
              value={urlInfo.protocol}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.warning} />}
              label="Port"
              value={urlInfo.port}
            />
            
            <DetailRow
              icon={<Globe size={16} color={theme.warning} />}
              label="Origin"
              value={urlInfo.origin}
              copyable
            />
            
            <DetailRow
              icon={<Navigation size={16} color={theme.warning} />}
              label="Referrer"
              value={urlInfo.referrer}
              copyable
            />
            
            {urlInfo.search !== 'N/A' && (
              <DetailRow
                icon={<Hash size={16} color={theme.warning} />}
                label="Query String"
                value={urlInfo.search}
                copyable
              />
            )}
            
            {urlInfo.hash !== 'N/A' && (
              <DetailRow
                icon={<Hash size={16} color={theme.warning} />}
                label="Hash"
                value={urlInfo.hash}
                copyable
              />
            )}
          </View>

          {/* Source & Campaign Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Traffic Source Information</Text>
            
            <DetailRow
              icon={<Zap size={16} color={theme.success} />}
              label="Source"
              value={getGenericProperty('source')}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.success} />}
              label="Medium"
              value={getGenericProperty('medium')}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.success} />}
              label="Campaign"
              value={getGenericProperty('campaign')}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.success} />}
              label="Session ID"
              value={getGenericProperty('sessionId')}
              copyable
            />
          </View>

          {/* Web Capabilities */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Web Capabilities</Text>
            
            <DetailRow
              icon={<Monitor size={16} color={theme.primary} />}
              label="WebGL Support"
              value={webCapabilities.webGLSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Monitor size={16} color={theme.primary} />}
              label="WebGL2 Support"
              value={webCapabilities.webGL2Support ? 'Yes' : 'No'}
            />
            
            <DetailRow
              icon={<Video size={16} color={theme.primary} />}
              label="WebRTC Support"
              value={webCapabilities.webRTCSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Settings size={16} color={theme.primary} />}
              label="WebAssembly"
              value={webCapabilities.webAssemblySupport ? 'Yes' : 'No'}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.primary} />}
              label="Service Worker"
              value={webCapabilities.serviceWorkerSupport ? 'Yes' : 'No'}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.primary} />}
              label="Local Storage"
              value={webCapabilities.localStorageSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<HardDrive size={16} color={theme.primary} />}
              label="Session Storage"
              value={webCapabilities.sessionStorageSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<HardDrive size={16} color={theme.primary} />}
              label="IndexedDB"
              value={webCapabilities.indexedDBSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="WebSockets"
              value={webCapabilities.webSocketsSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<MapPin size={16} color={theme.primary} />}
              label="Geolocation API"
              value={webCapabilities.geolocationSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Device Motion"
              value={webCapabilities.deviceMotionSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Device Orientation"
              value={webCapabilities.deviceOrientationSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Bell size={16} color={theme.primary} />}
              label="Push Notifications"
              value={webCapabilities.pushNotificationsSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Share2 size={16} color={theme.primary} />}
              label="Web Share"
              value={webCapabilities.webShareSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Video size={16} color={theme.primary} />}
              label="Media Devices"
              value={webCapabilities.mediaDevicesSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Bluetooth size={16} color={theme.primary} />}
              label="Web Bluetooth"
              value={webCapabilities.webBluetoothSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Usb size={16} color={theme.primary} />}
              label="WebUSB"
              value={webCapabilities.webUSBSupport ? 'Yes' : 'No'}
            />

            <DetailRow
              icon={<Nfc size={16} color={theme.primary} />}
              label="Web NFC"
              value={webCapabilities.webNFCSupport ? 'Yes' : 'No'}
            />
          </View>

          {/* Storage Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Storage Information</Text>
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.warning} />}
              label="Total Storage"
              value={webCapabilities.totalStorage}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.warning} />}
              label="Used Storage"
              value={webCapabilities.usedStorage}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.warning} />}
              label="Free Storage"
              value={webCapabilities.freeStorage}
            />

            {webCapabilities.storagePercentageUsed > 0 && (
              <DetailRow
                icon={<Activity size={16} color={webCapabilities.storagePercentageUsed > 80 ? theme.error : theme.warning} />}
                label="Usage"
                value={`${webCapabilities.storagePercentageUsed}%`}
              />
            )}
          </View>

          {/* Web Permissions */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Permissions</Text>
            
            <DetailRow
              icon={<MapPin size={16} color={theme.warning} />}
              label="Location"
              value={webPermissions.locationPermission}
            />
            
            <DetailRow
              icon={<Bell size={16} color={theme.warning} />}
              label="Notifications"
              value={webPermissions.notificationPermission}
            />
            
            <DetailRow
              icon={<Camera size={16} color={theme.warning} />}
              label="Camera"
              value={webPermissions.cameraPermission}
            />
            
            <DetailRow
              icon={<Mic size={16} color={theme.warning} />}
              label="Microphone"
              value={webPermissions.microphonePermission}
            />
          </View>

          {/* Technical Details */}
          {browserInfo.userAgent && (
            <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Technical Details</Text>
              
              <View style={styles.userAgentContainer}>
                <View style={styles.userAgentHeader}>
                  <Info size={16} color={theme.textSecondary} />
                  <Text style={[styles.userAgentLabel, { color: theme.textSecondary }]}>User Agent</Text>
                  <TouchableOpacity
                    onPress={() => copyToClipboard(browserInfo.userAgent!, 'User Agent')}
                    style={[styles.actionButton, { backgroundColor: theme.primary + '20' }]}
                  >
                    <Copy size={12} color={theme.primary} />
                  </TouchableOpacity>
                </View>
                <Text style={[styles.userAgentText, { color: theme.text }]} selectable>
                  {browserInfo.userAgent}
                </Text>
              </View>
            </View>
          )}

          {/* Deletion Information */}
          {isDeleted && (
            <View style={[styles.section, { 
              backgroundColor: theme.error + '10', 
              borderColor: theme.error,
              borderWidth: 1
            }]}>
              <Text style={[styles.sectionTitle, { color: theme.error }]}>Deletion Information</Text>
              
              <DetailRow
                icon={<AlertTriangle size={16} color={theme.error} />}
                label="Deleted By"
                value={getDeviceProperty('deletedByName') || getDeviceProperty('deletedBy')}
              />
              
              <DetailRow
                icon={<Clock size={16} color={theme.error} />}
                label="Deletion Time"
                value={formatTimestamp(device.deletedAt)}
              />
              
              {device.deletionReason && (
                <DetailRow
                  icon={<Info size={16} color={theme.error} />}
                  label="Deletion Reason"
                  value={getDeviceProperty('deletionReason')}
                />
              )}
            </View>
          )}

          {/* Debug Information - Remove this in production */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Debug Information (Raw Data)</Text>
            
            <DetailRow
              icon={<Info size={16} color={theme.textSecondary} />}
              label="Raw lastLogin"
              value={JSON.stringify(device.lastLogin)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.textSecondary} />}
              label="Raw lastActivityType"
              value={JSON.stringify(device.lastActivityType)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.textSecondary} />}
              label="Raw sessionId"
              value={JSON.stringify(device.sessionId)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.textSecondary} />}
              label="Raw lastSeen"
              value={JSON.stringify(device.lastSeen)}
            />

            <DetailRow
              icon={<Info size={16} color={theme.textSecondary} />}
              label="Object Keys Count"
              value={`${Object.keys(device).length} properties`}
            />
          </View>
        </ScrollView>

        {/* Action Buttons */}
        <View style={[styles.actions, { borderTopColor: theme.border, backgroundColor: theme.surface }]}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: theme.background, borderColor: theme.border }]}
            onPress={onClose}
          >
            <X size={16} color={theme.text} />
            <Text style={[styles.actionBtnText, { color: theme.text }]}>Close</Text>
          </TouchableOpacity>

          {/* Restore/Delete Button */}
          <TouchableOpacity
            style={[
              styles.actionBtn,
              { backgroundColor: isDeleted ? theme.success : theme.error }
            ]}
            onPress={() => handleOpenDeviceAction(isDeleted ? 'restore' : 'delete')}
            disabled={isHardBanned}
          >
            {isDeleted ? (
              <RotateCcw size={16} color="white" />
            ) : (
              <Ban size={16} color="white" />
            )}
            <Text style={styles.actionBtnTextWhite}>
              {isDeleted ? 'Restore' : 'Delete'}
            </Text>
          </TouchableOpacity>

          {/* Logout Button - Only for online, non-deleted, non-banned devices */}
          {isOnline && !isDeleted && !isHardBanned && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: theme.warning }]}
              onPress={() => handleOpenDeviceAction('logout')}
            >
              <LogOut size={16} color="white" />
              <Text style={styles.actionBtnTextWhite}>
                Logout
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Device Action Modal */}
      <DeviceActionModal
        visible={showDeviceActionModal}
        onClose={() => setShowDeviceActionModal(false)}
        device={device}
        userEmail={userEmail}
        adminEmail={adminEmail}
        adminName={adminName}
        initialActionType={selectedActionType}
        onActionComplete={handleDeviceActionComplete}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 60 : 40,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
  },
  subtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 2,
  },
  closeButton: {
    padding: 4,
  },
  statusBanner: {
    marginHorizontal: 20,
    marginBottom: 20,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  statusContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  statusText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  statusTimestamp: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  section: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    minHeight: 32,
  },
  detailLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    width: 120,
    gap: 8,
  },
  labelText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    flex: 1,
  },
  detailValue: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  valueText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    flex: 1,
  },
  actionButton: {
    width: 24,
    height: 24,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  userAgentContainer: {
    gap: 8,
  },
  userAgentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  userAgentLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    flex: 1,
  },
  userAgentText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    lineHeight: 18,
    padding: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 8,
  },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    gap: 12,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
  },
  actionBtnText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  actionBtnTextWhite: {
    color: 'white',
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  idSourceBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  idSourceText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
});

export default BrowserDeviceModal;
