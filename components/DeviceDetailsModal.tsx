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
  Smartphone,
  Tablet,
  Wifi,
  WifiOff,
  MapPin,
  Clock,
  Shield,
  Info,
  Copy,
  Cpu,
  HardDrive,
  Battery,
  Signal,
  Activity,
  Settings,
  AlertTriangle,
  Edit3,
  Ban,
  RotateCcw,
  LockKeyhole,
  Bell,
  Camera,
  Mic,
  LogOut,
  UserX
} from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { useTheme } from '../hooks/useTheme';
import { UserDevice, deviceTrackingService } from '../services/deviceTrackingService';
import DeviceActionModal from './DeviceActionModal';

interface DeviceDetailsModalProps {
  visible: boolean;
  onClose: () => void;
  device: UserDevice;
  userEmail: string;
  adminEmail: string;
  adminName: string;
  onDeviceUpdate: () => void;
}

const DeviceDetailsModal: React.FC<DeviceDetailsModalProps> = ({
  visible,
  onClose,
  device,
  userEmail,
  adminEmail,
  adminName,
  onDeviceUpdate
}) => {
  const { theme } = useTheme();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showDeviceActionModal, setShowDeviceActionModal] = useState(false);
  const [selectedActionType, setSelectedActionType] = useState<'delete' | 'restore' | 'logout' | null>(null);

  // Debug logging to see what data we're receiving
  React.useEffect(() => {
    if (visible && device) {
      logger.debug('🔍 DeviceDetailsModal - Device data received:', {
        deviceId: device.deviceId,
        lastLogin: device.lastLogin,
        lastLoginType: typeof device.lastLogin,
        lastActivityType: device.lastActivityType,
        sessionId: device.sessionId,
        lastSeen: device.lastSeen,
        createdAt: device.createdAt,
        allKeys: Object.keys(device)
      });
    }
  }, [visible, device]);

  // Safe property access helpers
  const getDeviceProperty = useCallback((property: keyof UserDevice): string => {
    const value = device[property];
    
    // Debug logging for specific properties
    if (property === 'lastLogin' || property === 'lastActivityType' || property === 'sessionId') {
      logger.debug(`🔍 getDeviceProperty(${property}):`, value, typeof value);
    }
    
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string') return value || 'N/A';
    if (typeof value === 'number') return value.toString();
    if (value instanceof Date) return value.toLocaleString();
    if (Array.isArray(value)) return value.join(', ') || 'N/A';
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
  const getGenericNumberProperty = useCallback((property: string): number => {
    const value = (device as any)[property];
    return typeof value === 'number' ? value : 0;
  }, [device]);

  // Generic property getter for timestamp properties
  const getTimestampProperty = useCallback((property: string): any => {
    const value = (device as any)[property];
    return value;
  }, [device]);

  // Format timestamp using proper timestamp handling
  const formatTimestamp = useCallback((timestamp: any): string => {
    if (!timestamp) return 'Never';
    
    try {
      let resolvedDate: Date;
      
      // Handle serverTimestamp objects (not yet resolved)
      if (timestamp && typeof timestamp === 'object' && (timestamp as any)._methodName === 'serverTimestamp') {
        return 'Just now'; // Use current time for unresolved serverTimestamp
      }
      // Handle Firestore Timestamp objects
      else if (timestamp && typeof timestamp === 'object' && 'toDate' in timestamp && typeof timestamp.toDate === 'function') {
        resolvedDate = timestamp.toDate();
      }
      // Handle Date objects
      else if (timestamp instanceof Date) {
        resolvedDate = timestamp;
      }
      // Handle strings/numbers
      else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
        resolvedDate = new Date(timestamp);
      }
      // Handle objects with seconds and nanoseconds property (Firestore timestamp format)
      else if (timestamp && typeof timestamp === 'object' && typeof timestamp.seconds === 'number') {
        // Convert seconds to milliseconds and add nanoseconds converted to milliseconds
        const milliseconds = timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds || 0) / 1000000);
        resolvedDate = new Date(milliseconds);
      }
      else {
        return 'Invalid date';
      }
      
      if (isNaN(resolvedDate.getTime())) return 'Invalid date';
      
      const now = new Date();
      const diffMs = now.getTime() - resolvedDate.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let relative = '';
      if (diffMins < 1) relative = 'Just now';
      else if (diffMins < 60) relative = `${diffMins}m ago`;
      else if (diffHours < 24) relative = `${diffHours}h ago`;
      else if (diffDays === 1) relative = 'Yesterday';
      else if (diffDays < 7) relative = `${diffDays}d ago`;
      else relative = resolvedDate.toLocaleDateString();

      return `${relative} (${resolvedDate.toLocaleString()})`;
    } catch (error) {
      logger.error('Error formatting timestamp:', error);
      return 'Invalid date';
    }
  }, []);

  // Format future timestamp (like ban expiry)
  const formatFutureTimestamp = useCallback((timestamp: any): string => {
    if (!timestamp) return 'Never';
    
    try {
      let resolvedDate: Date;
      
      // Handle serverTimestamp objects (not yet resolved)
      if (timestamp && typeof timestamp === 'object' && (timestamp as any)._methodName === 'serverTimestamp') {
        return 'Just now'; // Use current time for unresolved serverTimestamp
      }
      // Handle Firestore Timestamp objects
      else if (timestamp && typeof timestamp === 'object' && 'toDate' in timestamp && typeof timestamp.toDate === 'function') {
        resolvedDate = timestamp.toDate();
      }
      // Handle Date objects
      else if (timestamp instanceof Date) {
        resolvedDate = timestamp;
      }
      // Handle strings/numbers
      else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
        resolvedDate = new Date(timestamp);
      }
      // Handle objects with seconds and nanoseconds property (Firestore timestamp format)
      else if (timestamp && typeof timestamp === 'object' && typeof timestamp.seconds === 'number') {
        // Convert seconds to milliseconds and add nanoseconds converted to milliseconds
        const milliseconds = timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds || 0) / 1000000);
        resolvedDate = new Date(milliseconds);
      }
      else {
        return 'Invalid date';
      }
      
      if (isNaN(resolvedDate.getTime())) return 'Invalid date';
      
      const now = new Date();
      const diffMs = resolvedDate.getTime() - now.getTime(); // Reversed for future dates
      
      if (diffMs <= 0) {
        return `Expired (${resolvedDate.toLocaleString()})`;
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
      else relative = resolvedDate.toLocaleDateString();

      return `${relative} (${resolvedDate.toLocaleString()})`;
    } catch (error) {
      logger.error('Error formatting future timestamp:', error);
      return 'Invalid date';
    }
  }, []);

  // Device info
  const deviceInfo = useMemo(() => {
    const isTablet = device.deviceType === 'tablet';
    const deviceName = getDeviceProperty('deviceName');
    const modelName = getDeviceProperty('modelName');
    const brand = getDeviceProperty('brand');
    const manufacturer = getDeviceProperty('manufacturer');
    
    return {
      isTablet,
      displayName: deviceName !== 'N/A' ? deviceName : (modelName !== 'N/A' ? modelName : 'Unknown Device'),
      fullName: [brand !== 'N/A' ? brand : null, modelName !== 'N/A' ? modelName : null]
        .filter(Boolean)
        .join(' ') || deviceName || 'Unknown Device',
      brand,
      manufacturer,
      model: modelName
    };
  }, [device, getDeviceProperty]);

  // System information
  const systemInfo = useMemo(() => {
    const osName = getDeviceProperty('osName');
    const osVersion = getDeviceProperty('osVersion');
    const platformOS = getDeviceProperty('platformOS');
    const appVersion = getDeviceProperty('appVersion');
    const buildVersion = getDeviceProperty('nativeBuildVersion');
    
    return {
      os: osName !== 'N/A' && osVersion !== 'N/A' ? `${osName} ${osVersion}` : platformOS,
      appVersion,
      buildVersion,
      osName,
      osVersion,
      platformOS
    };
  }, [getDeviceProperty]);

  // Hardware information
  const hardwareInfo = useMemo(() => {
    const screenWidth = getNumberProperty('screenWidth');
    const screenHeight = getNumberProperty('screenHeight');
    const totalMemory = getNumberProperty('totalMemory');
    const freeMemory = getGenericNumberProperty('freeMemory');
    const freeDiskStorage = getGenericNumberProperty('freeDiskStorage');
    const totalDiskCapacity = getGenericNumberProperty('totalDiskCapacity');
    
    return {
      screen: screenWidth && screenHeight ? `${screenWidth} × ${screenHeight}` : 'Unknown',
      memory: totalMemory > 0 ? `${Math.round(totalMemory / (1024 * 1024 * 1024))} GB` : 'Unknown',
      freeMemory: freeMemory > 0 ? `${Math.round(freeMemory / (1024 * 1024 * 1024))} GB` : 'Unknown',
      storage: totalDiskCapacity > 0 ? `${Math.round(totalDiskCapacity / (1024 * 1024 * 1024))} GB` : 'Unknown',
      freeStorage: freeDiskStorage > 0 ? `${Math.round(freeDiskStorage / (1024 * 1024 * 1024))} GB` : 'Unknown'
    };
  }, [getNumberProperty, getGenericNumberProperty]);

  // Network information
  const networkInfo = useMemo(() => {
    const ipAddress = getDeviceProperty('ipAddress');
    const networkType = getDeviceProperty('networkType');
    const carrierName = getDeviceProperty('carrierName');
    const connectionType = getDeviceProperty('connectionType');
    
    return {
      ipAddress,
      networkType,
      carrierName,
      connectionType
    };
  }, [getDeviceProperty]);

  // Storage information
  const storageInfo = useMemo(() => {
    const freeStorage = getGenericNumberProperty('freeStorage');
    const totalStorage = getGenericNumberProperty('totalStorage');
    const usedStorage = getGenericNumberProperty('usedStorage');
    
    return {
      total: totalStorage > 0 ? `${Math.round(totalStorage / (1024 * 1024 * 1024))} GB` : 'Unknown',
      used: usedStorage > 0 ? `${Math.round(usedStorage / (1024 * 1024 * 1024))} GB` : 'Unknown',
      free: freeStorage > 0 ? `${Math.round(freeStorage / (1024 * 1024 * 1024))} GB` : 'Unknown',
      usagePercent: totalStorage > 0 && usedStorage > 0 ? Math.round((usedStorage / totalStorage) * 100) : 0
    };
  }, [getGenericNumberProperty]);

  // Orientation and capabilities
  const deviceCapabilities = useMemo(() => {
    const orientation = getDeviceProperty('currentOrientation');
    const orientationLocked = getBooleanProperty('orientationLocked');
    const motionSupport = getBooleanProperty('motionSupport');
    
    // Permissions
    const locationPermission = getDeviceProperty('locationPermission');
    const notificationPermission = getDeviceProperty('notificationPermission');
    const cameraPermission = getDeviceProperty('cameraPermission');
    const micPermission = getDeviceProperty('microphonePermission');
    
    return {
      orientation: orientation !== 'N/A' ? orientation : 'Unknown',
      orientationLocked,
      motionSupport,
      locationPermission: locationPermission !== 'N/A' ? locationPermission : 'Unknown',
      notificationPermission: notificationPermission !== 'N/A' ? notificationPermission : 'Unknown',
      cameraPermission: cameraPermission !== 'N/A' ? cameraPermission : 'Unknown',
      micPermission: micPermission !== 'N/A' ? micPermission : 'Unknown'
    };
  }, [getDeviceProperty, getBooleanProperty]);

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
    setActionLoading(null);
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
        icon: <UserX size={16} color={theme.warning} />,
        bgColor: theme.warning + '15',
        borderColor: theme.warning
      };
    }
    
    if (logoutType === 'manual' || lastActivityType === 'logout') {
      return {
        text: 'Logged Out',
        color: theme.textSecondary,
        icon: <UserX size={16} color={theme.textSecondary} />,
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
        <View style={[styles.header, { borderBottomColor: theme.border, marginBottom: 16 }]}> 
          <View style={styles.headerContent}> 
            <View style={styles.headerIcon}> 
              {deviceInfo.isTablet ? ( 
                <Tablet size={24} color={theme.primary} /> 
              ) : ( 
                <Smartphone size={24} color={theme.primary} /> 
              )} 
            </View> 
            <View style={styles.headerText}> 
              <Text style={[styles.title, { color: theme.text }]}> 
                {deviceInfo.isTablet ? 'Tablet Details' : 'Mobile Device Details'} 
              </Text> 
              <Text style={[styles.subtitle, { color: theme.textSecondary }]}> 
                {userEmail} • {deviceInfo.displayName} 
              </Text> 
            </View> 
          </View> 
          <TouchableOpacity style={styles.closeButton} onPress={onClose}> 
            <X size={24} color={theme.textSecondary} /> 
          </TouchableOpacity> 
        </View>

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
              icon={deviceInfo.isTablet ? <Tablet size={16} color={theme.primary} /> : <Smartphone size={16} color={theme.primary} />}
              label="Device Name"
              value={deviceInfo.displayName}
              copyable
            />
            
            <DetailRow
              icon={<Shield size={16} color={theme.primary} />}
              label="Device ID"
              value={getDeviceProperty('deviceId')}
              copyable
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Device Type"
              value={deviceInfo.isTablet ? 'Tablet' : 'Mobile Phone'}
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
              icon={<Clock size={16} color={theme.success} />}
              label="Last Login"
              value={formatTimestamp(device.lastLogin)}
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
                  icon={<UserX size={16} color={theme.warning} />}
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
            
            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Last Activity Type"
              value={device.lastActivityType || 'Not recorded'}
            />
          </View>

          {/* Device Hardware */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Hardware Information</Text>
            
            <DetailRow
              icon={<Settings size={16} color={theme.warning} />}
              label="Brand"
              value={deviceInfo.brand}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.warning} />}
              label="Manufacturer"
              value={deviceInfo.manufacturer}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.warning} />}
              label="Model"
              value={deviceInfo.model}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.warning} />}
              label="Screen Resolution"
              value={hardwareInfo.screen}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.warning} />}
              label="Total Memory"
              value={hardwareInfo.memory}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.warning} />}
              label="Design Name"
              value={getDeviceProperty('designName')}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.warning} />}
              label="Product Name"
              value={getDeviceProperty('productName')}
            />
            
            <DetailRow
              icon={<Cpu size={16} color={theme.warning} />}
              label="CPU Architectures"
              value={device.supportedCpuArchitectures ? device.supportedCpuArchitectures.join(', ') : 'N/A'}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.warning} />}
              label="Free Memory"
              value={hardwareInfo.freeMemory}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.warning} />}
              label="Total Storage"
              value={hardwareInfo.storage}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.warning} />}
              label="Free Storage"
              value={hardwareInfo.freeStorage}
            />
          </View>

          {/* System Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>System Information</Text>
            
            <DetailRow
              icon={<Cpu size={16} color={theme.success} />}
              label="Operating System"
              value={systemInfo.os}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.success} />}
              label="Platform"
              value={systemInfo.platformOS}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.success} />}
              label="Platform Version"
              value={getNumberProperty('platformVersion').toString()}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.success} />}
              label="App Version"
              value={systemInfo.appVersion}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.success} />}
              label="Native App Version"
              value={getDeviceProperty('nativeAppVersion')}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.success} />}
              label="Build Version"
              value={systemInfo.buildVersion}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.success} />}
              label="Expo Version"
              value={getDeviceProperty('expoVersion')}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.success} />}
              label="OS Build ID"
              value={getDeviceProperty('osBuildId')}
            />
          </View>

          {/* Network Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Network Information</Text>
            
            <DetailRow
              icon={<Wifi size={16} color={theme.error} />}
              label="Network Type"
              value={networkInfo.networkType}
            />
            
            <DetailRow
              icon={<Signal size={16} color={theme.error} />}
              label="Carrier"
              value={networkInfo.carrierName}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.error} />}
              label="Connection Type"
              value={networkInfo.connectionType}
            />
            
            <DetailRow
              icon={<MapPin size={16} color={theme.error} />}
              label="Country Code"
              value={getDeviceProperty('countryCode')}
            />
            
            <DetailRow
              icon={<Clock size={16} color={theme.error} />}
              label="Timezone"
              value={getDeviceProperty('timezone')}
            />
            
            <DetailRow
              icon={<Settings size={16} color={theme.error} />}
              label="Locale"
              value={getDeviceProperty('locale')}
            />
          </View>

          {/* Activity Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Activity Information</Text>
            
            <DetailRow
              icon={<Clock size={16} color={theme.primary} />}
              label="First Seen"
              value={formatTimestamp(device.createdAt)}
            />
            
            <DetailRow
              icon={<Clock size={16} color={theme.success} />}
              label="Last Login"
              value={formatTimestamp(device.lastLogin)}
            />
            
            <DetailRow
              icon={<Clock size={16} color={theme.primary} />}
              label="Last Activity"
              value={formatTimestamp(device.lastSeen)}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Last Activity Type"
              value={getDeviceProperty('lastActivityType')}
            />
            
            <DetailRow
              icon={<Shield size={16} color={theme.primary} />}
              label="Session ID"
              value={getDeviceProperty('sessionId')}
              copyable
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Last Heartbeat ID"
              value={getDeviceProperty('lastHeartbeatId')}
              copyable
            />
            
            <DetailRow
              icon={<Shield size={16} color={theme.primary} />}
              label="Is Restored"
              value={getBooleanProperty('isRestored') ? 'Yes' : 'No'}
            />
            
            {getBooleanProperty('isRestored') && getTimestampProperty('restoredAt') && (
              <DetailRow
                icon={<Clock size={16} color={theme.success} />}
                label="Restored At"
                value={formatTimestamp(getTimestampProperty('restoredAt'))}
              />
            )}
          </View>

          {/* Push Notification Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Push Notification Tokens</Text>
            
            <DetailRow
              icon={<Shield size={16} color={theme.primary} />}
              label="Expo Push Token"
              value={getDeviceProperty('expoPushToken')}
              copyable
            />
            
            <DetailRow
              icon={<Shield size={16} color={theme.primary} />}
              label="FCM Token"
              value={getDeviceProperty('fcmToken')}
              copyable
            />
          </View>

          {/* Display Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Display Information</Text>
            
            <DetailRow
              icon={<Activity size={16} color={theme.warning} />}
              label="Screen Resolution"
              value={hardwareInfo.screen}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.warning} />}
              label="Screen Scale"
              value={getDeviceProperty('screenScale')}
            />
          </View>

          {/* Storage Information */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Storage Information</Text>
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.success} />}
              label="Total Storage"
              value={storageInfo.total}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.success} />}
              label="Used Storage"
              value={storageInfo.used}
            />
            
            <DetailRow
              icon={<HardDrive size={16} color={theme.success} />}
              label="Free Storage"
              value={storageInfo.free}
            />
            
            {storageInfo.usagePercent > 0 && (
              <DetailRow
                icon={<Activity size={16} color={storageInfo.usagePercent > 80 ? theme.error : theme.warning} />}
                label="Usage"
                value={`${storageInfo.usagePercent}%`}
              />
            )}
          </View>

          {/* Device Capabilities */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Device Capabilities</Text>
            
            <DetailRow
              icon={<RotateCcw size={16} color={theme.primary} />}
              label="Orientation"
              value={deviceCapabilities.orientation}
            />
            
            <DetailRow
              icon={<LockKeyhole size={16} color={theme.primary} />}
              label="Orientation Locked"
              value={deviceCapabilities.orientationLocked ? 'Yes' : 'No'}
            />
            
            <DetailRow
              icon={<Activity size={16} color={theme.primary} />}
              label="Motion Support"
              value={deviceCapabilities.motionSupport ? 'Yes' : 'No'}
            />
          </View>

          {/* Permissions */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Permissions</Text>
            
            <DetailRow
              icon={<MapPin size={16} color={theme.warning} />}
              label="Location"
              value={deviceCapabilities.locationPermission}
            />
            
            <DetailRow
              icon={<Bell size={16} color={theme.warning} />}
              label="Notifications"
              value={deviceCapabilities.notificationPermission}
            />
            
            <DetailRow
              icon={<Camera size={16} color={theme.warning} />}
              label="Camera"
              value={deviceCapabilities.cameraPermission}
            />
            
            <DetailRow
              icon={<Mic size={16} color={theme.warning} />}
              label="Microphone"
              value={deviceCapabilities.micPermission}
            />
          </View>

          {/* Debug Information - Remove this in production */}
          <View style={[styles.section, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Debug Information (Raw Data)</Text>
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw lastLogin"
              value={JSON.stringify(device.lastLogin)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw lastActivityType"
              value={JSON.stringify(device.lastActivityType)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw sessionId"
              value={JSON.stringify(device.sessionId)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw lastSeen"
              value={JSON.stringify(device.lastSeen)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw lastHeartbeatId"
              value={JSON.stringify((device as any).lastHeartbeatId)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw isRestored"
              value={JSON.stringify((device as any).isRestored)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw restoredAt"
              value={JSON.stringify(getTimestampProperty('restoredAt'))}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw updatedAt"
              value={JSON.stringify(getTimestampProperty('updatedAt'))}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw createdAt"
              value={JSON.stringify(device.createdAt)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw platformVersion"
              value={JSON.stringify((device as any).platformVersion)}
            />
            
            <DetailRow
              icon={<Info size={16} color={theme.primary} />}
              label="Raw nativeAppVersion"
              value={JSON.stringify((device as any).nativeAppVersion)}
            />
          </View>

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
            disabled={!!actionLoading || isHardBanned}
          >
            {isDeleted ? (
              <RotateCcw size={16} color="white" />
            ) : (
              <Ban size={16} color="white" />
            )}
            <Text style={styles.actionBtnTextWhite}>
              {actionLoading === (isDeleted ? 'restore' : 'delete') 
                ? 'Processing...' 
                : isDeleted ? 'Restore' : 'Delete'
              }
            </Text>
          </TouchableOpacity>

          {/* Logout Button - Only for online, non-deleted, non-banned devices */}
          {isOnline && !isDeleted && !isHardBanned && (
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: theme.warning }]}
              onPress={() => handleOpenDeviceAction('logout')}
              disabled={!!actionLoading}
            >
              <LogOut size={16} color="white" />
              <Text style={styles.actionBtnTextWhite}>
                {actionLoading === 'logout' ? 'Processing...' : 'Logout'}
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
};

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
});

export default DeviceDetailsModal;
