import { logger } from '@/lib/logger';
import { describeDeviceFailureReason } from '@/lib/notificationFailureReasons';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { 
  View, 
  Text, 
  ScrollView, 
  TouchableOpacity, 
  StyleSheet, 
  RefreshControl, 
  Modal, 
  TextInput,
  Platform,
  ActivityIndicator,
  useWindowDimensions,
  Animated
} from 'react-native';
import Toast from 'react-native-toast-message';
import { 
  Bell, 
  Smartphone, 
  Monitor, 
  Tablet, 
  Send, 
  X,
  AlertTriangle,
  Info,
  CheckCircle,
  Eye,
  EyeOff,
  Ban,
  RotateCcw,
  LogOut,
  Filter,
  Search,
  Wifi,
  WifiOff,
  Clock,
  Trash2
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { tenantService } from '@/services/tenantService';
import { UserDevice, AuthorizedUser, deviceTrackingService } from '../services/deviceTrackingService';
import type { DeviceTenantFilterOptions } from '../services/deviceTrackingService';
import { notificationService } from '../services/notificationService';
import DeviceActionModal from './DeviceActionModal';
import DeviceDetailsModal from './DeviceDetailsModal';
import BrowserDeviceModal from './BrowserDeviceModal';
import AdminNotificationHistoryViewer from './AdminNotificationHistoryViewer';


interface NotificationMessage {
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'announcement';
  targetUsers: string[];
  targetDevices: string[];
}

interface UserGroupSelectionMeta {
  selectableIds: string[];
  selectableIdSet: Set<string>;
  allSelected: boolean;
  onlineCount: number;
}

type FilterType = 'all' | 'online' | 'offline' | 'web' | 'mobile' | 'tablet' | 'deleted' | 'logged_out' | 'force_logged_out' | 'hard_banned';
type SortType = 'name' | 'lastSeen' | 'deviceType' | 'status';

interface AdminNotificationCenterProps {
  adminEmail: string;
  adminName: string;
  tenantMemberEmails?: string[];
}

export default function AdminNotificationCenter({ adminEmail, adminName, tenantMemberEmails = [] }: AdminNotificationCenterProps) {
  const { theme } = useTheme();
  const modalTopPadding = 16;
  const { width } = useWindowDimensions();
  const { activeTenant } = useTenant();
  const tenantId = activeTenant?.id;
  const tenantName = activeTenant?.name;
  const tenantFilterOptions: DeviceTenantFilterOptions | undefined = useMemo(() => {
    return tenantId ? { tenantId, includeUntagged: false } : undefined;
  }, [tenantId]);

  // Use notification service methods directly to avoid duplicate listeners
  const getAllUsersWithDevices = useCallback(async (
    memberEmails: string[],
    includeCurrentUser: boolean = true
  ) => {
    try {
      return await notificationService.getAllUsersWithDevices(
        memberEmails,
        includeCurrentUser,
        tenantFilterOptions
      );
    } catch (error) {
      logger.error('Failed to get all users with devices:', error);
      return [];
    }
  }, [tenantFilterOptions]);

  const sendBulkAdminNotifications = async (
    targetUsers: string[],
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    onlineOnly: boolean = true,
    tenantOptions?: { tenantId?: string; tenantName?: string }
  ) => {
    try {
      return await notificationService.sendBulkAdminNotifications(targetUsers, notification, onlineOnly, tenantOptions);
    } catch (error) {
      logger.error('Failed to send bulk admin notifications:', error);
      return { totalSuccess: 0, totalFailed: targetUsers.length, results: [] };
    }
  };

  const sendBulkAdminNotificationsToDevices = async (
    targets: { email: string; deviceId: string }[],
    notification: {
      title: string;
      body: string;
      data?: any;
      priority?: 'high' | 'normal' | 'low';
    },
    tenantOptions?: { tenantId?: string; tenantName?: string }
  ) => {
    try {
      return await notificationService.sendBulkAdminNotificationsToDevices(targets, notification, tenantOptions);
    } catch (error) {
      logger.error('Failed to send bulk admin notifications to devices:', error);
      return { totalSuccess: 0, totalFailed: targets.length, results: [] };
    }
  };

  // State management
  const [authorizedUsers, setAuthorizedUsers] = useState<AuthorizedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isRefreshAnimating, setIsRefreshAnimating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const trimmedSearchQuery = searchQuery.trim();
  const normalizedSearchQuery = trimmedSearchQuery.toLowerCase();
  const hasSearchQuery = normalizedSearchQuery.length > 0;
  const [filterType, setFilterType] = useState<FilterType>('all');
  const [sortType, setSortType] = useState<SortType>('lastSeen');
  const [hideInactiveDevices, setHideInactiveDevices] = useState(false);
  const [scopedTenantMemberEmails, setScopedTenantMemberEmails] = useState<string[]>(tenantMemberEmails);
  useEffect(() => {
    let cancelled = false;

    const resolveTenantEmails = async () => {
      if (!activeTenant?.id) {
        setScopedTenantMemberEmails(tenantMemberEmails);
        return;
      }

      try {
        const memberships = await tenantService.getActiveMembershipsForTenant(activeTenant.id);
        const scopedEmails = Array.from(
          new Set(
            memberships
              .map((membership) => membership.email?.toLowerCase())
              .filter((email): email is string => Boolean(email))
          )
        );
        if (!cancelled) {
          setScopedTenantMemberEmails(scopedEmails.length ? scopedEmails : tenantMemberEmails);
        }
      } catch (error) {
        logger.warn('AdminNotificationCenter: failed to load tenant memberships', error);
        if (!cancelled) {
          setScopedTenantMemberEmails(tenantMemberEmails);
        }
      }
    };

    resolveTenantEmails();

    return () => {
      cancelled = true;
    };
  }, [activeTenant?.id, tenantMemberEmails]);


  // Animation for refresh button
  const refreshRotation = useState(new Animated.Value(0))[0];
  const refreshAnimationRef = useRef<any>(null);
  const initialLoadRef = useRef(false);
  const refreshRequestInFlightRef = useRef(false);
  const loadUsersRequestIdRef = useRef(0);
  const hardBanRequestInFlightRef = useRef(false);
  const sendNotificationRequestInFlightRef = useRef(false);

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery((current) => (current === value ? current : value));
  }, []);

  const clearSearchQuery = useCallback(() => {
    setSearchQuery((current) => (current.length > 0 ? '' : current));
  }, []);

  const startRefreshAnimation = useCallback(() => {
    // Stop any existing animation first
    if (refreshAnimationRef.current) {
      refreshAnimationRef.current.stop();
    }
    
    setIsRefreshAnimating(true);
    refreshRotation.setValue(0);
    
    const spin = () => {
      refreshRotation.setValue(0);
      refreshAnimationRef.current = Animated.timing(refreshRotation, {
        toValue: 1,
        duration: 1000,
        useNativeDriver: true,
      });
      
      refreshAnimationRef.current.start((result: any) => {
        if (result.finished && refreshAnimationRef.current) {
          // If animation finished successfully and we still have a reference, repeat
          spin();
        }
      });
    };
    
    spin();
  }, [refreshRotation]);

  const stopRefreshAnimation = useCallback(() => {
    setIsRefreshAnimating(false);
    
    if (refreshAnimationRef.current) {
      refreshAnimationRef.current.stop();
      refreshAnimationRef.current = null;
    }
    
    // Reset rotation to 0
    Animated.timing(refreshRotation, {
      toValue: 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [refreshRotation]);

  const refreshRotationStyle = {
    transform: [{
      rotate: refreshRotation.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
      }),
    }],
  };

  // Helper function to format filter type display text
  const getFilterDisplayText = useCallback((filterType: FilterType) => {
    switch (filterType) {
      case 'all': return 'All';
      case 'online': return 'Online';
      case 'offline': return 'Offline';
      case 'logged_out': return 'Logged Out';
      case 'force_logged_out': return 'Force Logged Out';
      case 'web': return 'Web';
      case 'mobile': return 'Mobile';
      case 'tablet': return 'Tablet';
      case 'deleted': return 'Deleted';
      case 'hard_banned': return 'Hard Banned';
    }
  }, []);
  const isDeviceOnline = useCallback((device: UserDevice | any) => {
    // Access the static method through the service constructor
    const DeviceTrackingServiceClass = deviceTrackingService.constructor as any;
    if (typeof device.lastSeen !== 'undefined') {
      return DeviceTrackingServiceClass.isDeviceOnline(device.lastSeen);
    } else {
      // For user objects, check if any device is online
      return device.devices?.some((d: UserDevice) => DeviceTrackingServiceClass.isDeviceOnline(d.lastSeen)) || false;
    }
  }, []);

  // Helper function to check if a device has been logged out
  const isDeviceLoggedOut = useCallback((device: UserDevice) => {
    return !!(device.lastActivityType === 'logout' || device.lastActivityType === 'forced_logout' || 
             device.logoutType === 'manual' || device.logoutType === 'forced');
  }, []);

  // Helper function to check if a device is truly online (not logged out)
  const isDeviceTrulyOnline = useCallback((device: UserDevice) => {
    return isDeviceOnline(device) && !device.isDeleted && !isDeviceLoggedOut(device);
  }, [isDeviceOnline, isDeviceLoggedOut]);

  const getLastSeenTimestamp = useCallback((lastSeen: any): number => {
    if (lastSeen && typeof lastSeen === 'object' && (lastSeen as any)._methodName === 'serverTimestamp') {
      return Date.now();
    }

    if (lastSeen && typeof lastSeen === 'object' && (lastSeen as any).seconds !== undefined) {
      const timestamp = lastSeen as any;
      return timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds || 0) / 1000000);
    }

    if (lastSeen instanceof Date) {
      return lastSeen.getTime();
    }

    if (typeof lastSeen === 'string') {
      return new Date(lastSeen).getTime();
    }

    if (lastSeen && typeof lastSeen.toDate === 'function') {
      return lastSeen.toDate().getTime();
    }

    if (lastSeen && (lastSeen as any).seconds) {
      return (lastSeen as any).seconds * 1000;
    }

    return 0;
  }, []);

  // Helper function to get hard ban expiration info directly from device_bans collection
  const getHardBanExpirationInfo = useCallback(async (device: UserDevice, userEmail: string): Promise<{ expiresAt?: Date; daysRemaining?: number; reason?: string } | null> => {
    try {
      // Get the ban information from the service using device fingerprint AND user email
      const banInfo = await deviceTrackingService.isDeviceBannedForUser(device, userEmail);
      
      if (!banInfo) {
        return null;
      }

      let expirationDate: Date | null = null;
      let daysRemaining: number | undefined = undefined;

      if (banInfo.expiresAt) {
        // Handle different timestamp formats
        if (banInfo.expiresAt instanceof Date) {
          expirationDate = banInfo.expiresAt;
        } else if (typeof banInfo.expiresAt.toDate === 'function') {
          // Firestore Timestamp with toDate method
          expirationDate = banInfo.expiresAt.toDate();
        } else if (banInfo.expiresAt && typeof banInfo.expiresAt === 'object' && banInfo.expiresAt.seconds !== undefined) {
          // Firestore Timestamp object with seconds and nanoseconds
          expirationDate = new Date(banInfo.expiresAt.seconds * 1000 + Math.floor(banInfo.expiresAt.nanoseconds / 1000000));
        } else if (typeof banInfo.expiresAt === 'string') {
          expirationDate = new Date(banInfo.expiresAt);
        }
        
        if (expirationDate) {
          const now = new Date();
          const timeDiff = expirationDate.getTime() - now.getTime();
          daysRemaining = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));
          daysRemaining = daysRemaining > 0 ? daysRemaining : 0;
        }
      }

      return {
        expiresAt: expirationDate || undefined,
        daysRemaining,
        reason: banInfo.reason
      };
    } catch (error) {
      logger.error(`Failed to get ban expiration info for device ${device.deviceId}:`, error);
      return null;
    }
  }, []);

  // Selection state
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);

  // Ban expiration info cache
  const [banExpirationInfo, setBanExpirationInfo] = useState<Record<string, { expiresAt?: Date; daysRemaining?: number; reason?: string }>>({});

  // Synchronous version for immediate UI checks (uses cached data)
  const isDeviceHardBanned = useCallback((device: UserDevice): boolean => {
    // Check deletion reason (legacy check)
    const isDeletedWithHardBan = !!(device.isDeleted && device.deletionReason && device.deletionReason.toLowerCase().includes('hard banned'));
    
    // Check if we have ban info in cache
    const hasBanInfo = !!banExpirationInfo[device.deviceId];
    
    return isDeletedWithHardBan || hasBanInfo;
  }, [banExpirationInfo]);

  // Helper function to check if a device is selectable for notifications
  const isDeviceSelectable = useCallback((device: UserDevice) => {
    // Device is not selectable if it's deleted, hard banned, or logged out
    return !device.isDeleted && 
           !isDeviceHardBanned(device) && 
           !isDeviceLoggedOut(device);
  }, [isDeviceHardBanned, isDeviceLoggedOut]);

  // Helper function to check if a device is inactive (logged out, force logged out, deleted, or hard banned)
  const isDeviceInactive = useCallback((device: UserDevice) => {
    return device.isDeleted || 
           isDeviceHardBanned(device) || 
           isDeviceLoggedOut(device);
  }, [isDeviceHardBanned, isDeviceLoggedOut]);

  const showHideInactiveToggle = filterType === 'all' || filterType === 'web' || filterType === 'mobile' || filterType === 'tablet';

  // Modal state
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [notificationErrors, setNotificationErrors] = useState<string[]>([]);
  const [isSendingNotification, setIsSendingNotification] = useState(false);
  const [notificationData, setNotificationData] = useState<NotificationMessage>({
    title: '',
    message: '',
    type: 'info',
    targetUsers: [],
    targetDevices: []
  });

  // Device action state
  const [selectedDevice, setSelectedDevice] = useState<UserDevice | null>(null);
  const [selectedUserEmail, setSelectedUserEmail] = useState<string>('');
  const [selectedActionType, setSelectedActionType] = useState<'delete' | 'restore' | 'logout' | 'hardban' | null>(null);
  const [showActionModal, setShowActionModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showHardBanModal, setShowHardBanModal] = useState(false);

  // Hard ban state
  const [hardBanReason, setHardBanReason] = useState('');
  const [hardBanExpiration, setHardBanExpiration] = useState<Date | null>(null);
  const [hardBanExpirationEnabled, setHardBanExpirationEnabled] = useState(false);

  // Load all users and their devices
  const loadAuthorizedUsersWithDevices = useCallback(async () => {
    const requestId = loadUsersRequestIdRef.current + 1;
    loadUsersRequestIdRef.current = requestId;

    try {
      setLoading(true);
      
      const allUsersData = await getAllUsersWithDevices(scopedTenantMemberEmails, true);
      if (loadUsersRequestIdRef.current !== requestId) {
        return;
      }
      
      // Filter users based on tenant member email scope
      const normalizedMemberEmails = new Set(
        scopedTenantMemberEmails.map((email) => email.toLowerCase())
      );
      const filteredUsersData = scopedTenantMemberEmails.length > 0 
        ? allUsersData.filter((userData) => normalizedMemberEmails.has(userData.email.toLowerCase()))
        : allUsersData;

      if (loadUsersRequestIdRef.current !== requestId) {
        return;
      }
      
      setAuthorizedUsers(filteredUsersData);

      // Load ban expiration info for filtered users' devices only
      const banEntries = await Promise.all(
        filteredUsersData.flatMap((userData) =>
          userData.devices.map(async (device: UserDevice) => {
            const expirationInfo = await getHardBanExpirationInfo(device, userData.email);
            if (!expirationInfo) {
              return null;
            }
            return [device.deviceId, expirationInfo] as const;
          })
        )
      );

      if (loadUsersRequestIdRef.current !== requestId) {
        return;
      }

      const banInfo = Object.fromEntries(
        banEntries.filter(
          (entry): entry is readonly [string, { expiresAt?: Date; daysRemaining?: number; reason?: string }] =>
            entry !== null
        )
      );
      
      setBanExpirationInfo(banInfo);
    } catch (error) {
      if (loadUsersRequestIdRef.current !== requestId) {
        return;
      }
      logger.error('Error loading users:', error);
      Toast.show({
        type: 'error',
        text1: 'Error Loading Data',
        text2: 'Failed to load users and devices'
      });
    } finally {
      if (loadUsersRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [getAllUsersWithDevices, getHardBanExpirationInfo, scopedTenantMemberEmails]);

  // Initial load
  useEffect(() => {
    if (initialLoadRef.current) {
      return;
    }
    initialLoadRef.current = true;
    loadAuthorizedUsersWithDevices();
  }, [loadAuthorizedUsersWithDevices]);

  useEffect(() => {
    if (!initialLoadRef.current) {
      return;
    }
    loadAuthorizedUsersWithDevices();
  }, [scopedTenantMemberEmails, loadAuthorizedUsersWithDevices]);

  useEffect(() => {
    if (!showNotificationModal) {
      setNotificationErrors([]);
      setIsSendingNotification(false);
    }
  }, [showNotificationModal]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    if (refreshRequestInFlightRef.current) {
      return;
    }

    refreshRequestInFlightRef.current = true;
    setRefreshing(true);
    try {
      await loadAuthorizedUsersWithDevices();
    } finally {
      setRefreshing(false);
      refreshRequestInFlightRef.current = false;
    }
  }, [loadAuthorizedUsersWithDevices]);

  // Handle manual refresh with toast feedback
  const handleManualRefresh = useCallback(async () => {
    if (refreshRequestInFlightRef.current) {
      return;
    }

    refreshRequestInFlightRef.current = true;
    try {
      setLoading(true);
      startRefreshAnimation();
      Toast.show({
        type: 'info',
        text1: 'Refreshing Devices',
        text2: 'Loading latest device information...'
      });
      await loadAuthorizedUsersWithDevices();
      Toast.show({
        type: 'success',
        text1: 'Devices Refreshed',
        text2: 'Device information has been updated'
      });
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Refresh Failed',
        text2: 'Could not refresh device information'
      });
    } finally {
      setLoading(false);
      stopRefreshAnimation();
      refreshRequestInFlightRef.current = false;
    }
  }, [loadAuthorizedUsersWithDevices, startRefreshAnimation, stopRefreshAnimation]);

  const groupedDevices = useMemo(() => {
    const next = new Map<string, { device: UserDevice; userEmail: string; userName: string }[]>();
    const shouldHideInactive =
      hideInactiveDevices &&
      showHideInactiveToggle;

    // Collect all devices from all users and apply filters once.
    for (const userData of authorizedUsers) {
      for (const device of userData.devices) {
        const deviceInfo = {
          device,
          userEmail: userData.email,
          userName: userData.displayName || userData.email.split('@')[0],
        };

        let includeDevice = true;

        if (hasSearchQuery) {
          includeDevice = !!(
            device.deviceName?.toLowerCase().includes(normalizedSearchQuery) ||
            device.deviceType?.toLowerCase().includes(normalizedSearchQuery) ||
            device.browserName?.toLowerCase().includes(normalizedSearchQuery) ||
            device.osName?.toLowerCase().includes(normalizedSearchQuery) ||
            device.modelName?.toLowerCase().includes(normalizedSearchQuery) ||
            device.ipAddress?.toLowerCase().includes(normalizedSearchQuery) ||
            userData.email.toLowerCase().includes(normalizedSearchQuery) ||
            userData.displayName?.toLowerCase().includes(normalizedSearchQuery)
          );
        }

        if (includeDevice && filterType !== 'all') {
          switch (filterType) {
            case 'online':
              includeDevice = isDeviceTrulyOnline(device);
              break;
            case 'offline':
              includeDevice = !!(!device.isDeleted && !isDeviceOnline(device) && !isDeviceLoggedOut(device));
              break;
            case 'deleted':
              includeDevice = !!device.isDeleted;
              break;
            case 'hard_banned':
              includeDevice = isDeviceHardBanned(device);
              break;
            case 'logged_out':
              includeDevice = !!(device.lastActivityType === 'logout' || device.logoutType === 'manual');
              break;
            case 'force_logged_out':
              includeDevice = !!(device.lastActivityType === 'forced_logout' || device.logoutType === 'forced');
              break;
            case 'web':
              includeDevice = !!(device.deviceType === 'web' || device.platformOS === 'web');
              break;
            case 'mobile':
              includeDevice = !!(device.deviceType === 'mobile');
              break;
            case 'tablet':
              includeDevice = !!(device.deviceType === 'tablet');
              break;
          }
        }

        if (includeDevice && shouldHideInactive) {
          includeDevice = !isDeviceInactive(device);
        }

        if (includeDevice) {
          const userDevices = next.get(userData.email) || [];
          userDevices.push(deviceInfo);
          next.set(userData.email, userDevices);
        }
      }
    }

    // Sort devices within each user group.
    for (const devices of next.values()) {
      devices.sort((a, b) => {
        switch (sortType) {
          case 'name':
            return (a.device.deviceName || '').localeCompare(b.device.deviceName || '');
          case 'deviceType':
            return (a.device.deviceType || '').localeCompare(b.device.deviceType || '');
          case 'status':
            if (a.device.isDeleted !== b.device.isDeleted) {
              return a.device.isDeleted ? 1 : -1;
            }
            {
              const aOnline = isDeviceTrulyOnline(a.device);
              const bOnline = isDeviceTrulyOnline(b.device);
              return aOnline === bOnline ? 0 : (aOnline ? -1 : 1);
            }
          case 'lastSeen':
          default: {
            return getLastSeenTimestamp(b.device.lastSeen) - getLastSeenTimestamp(a.device.lastSeen);
          }
        }
      });
    }

    return next;
  }, [
    authorizedUsers,
    hasSearchQuery,
    normalizedSearchQuery,
    filterType,
    sortType,
    isDeviceHardBanned,
    hideInactiveDevices,
    showHideInactiveToggle,
    isDeviceInactive,
    isDeviceTrulyOnline,
    getLastSeenTimestamp,
    isDeviceOnline,
    isDeviceLoggedOut,
  ]);

  const groupedDeviceEntries = useMemo(() => {
    return Array.from(groupedDevices.entries());
  }, [groupedDevices]);

  const filteredDevices = useMemo(() => {
    const flatDevices: { device: UserDevice; userEmail: string; userName: string }[] = [];
    groupedDevices.forEach((devices) => {
      flatDevices.push(...devices);
    });
    return flatDevices;
  }, [groupedDevices]);

  const filteredDeviceOwnerById = useMemo(() => {
    const deviceOwnerMap = new Map<string, string>();
    for (const { device, userEmail } of filteredDevices) {
      deviceOwnerMap.set(device.deviceId, userEmail);
    }
    return deviceOwnerMap;
  }, [filteredDevices]);

  const selectableFilteredDeviceIds = useMemo(() => {
    const selectableIds: string[] = [];
    for (const { device } of filteredDevices) {
      if (!isDeviceSelectable(device)) {
        continue;
      }

      selectableIds.push(device.deviceId);
    }

    return selectableIds;
  }, [filteredDevices, isDeviceSelectable]);

  const selectedDeviceIdSet = useMemo(() => {
    return new Set(selectedDevices);
  }, [selectedDevices]);

  const selectableFilteredDeviceIdSet = useMemo(() => {
    return new Set(selectableFilteredDeviceIds);
  }, [selectableFilteredDeviceIds]);

  const areAllSelectableDevicesSelected = useMemo(() => {
    return selectableFilteredDeviceIds.length > 0 && selectableFilteredDeviceIds.every((id) => selectedDeviceIdSet.has(id));
  }, [selectableFilteredDeviceIds, selectedDeviceIdSet]);

  const userGroupSelectionMeta = useMemo(() => {
    const next = new Map<string, UserGroupSelectionMeta>();

    for (const [userEmail, devices] of groupedDeviceEntries) {
      const selectableIds: string[] = [];
      const selectableIdSet = new Set<string>();
      let selectedCount = 0;
      let onlineCount = 0;

      for (const { device } of devices) {
        if (isDeviceTrulyOnline(device)) {
          onlineCount += 1;
        }

        if (!isDeviceSelectable(device)) {
          continue;
        }

        selectableIds.push(device.deviceId);
        selectableIdSet.add(device.deviceId);
        if (selectedDeviceIdSet.has(device.deviceId)) {
          selectedCount += 1;
        }
      }

      next.set(userEmail, {
        selectableIds,
        selectableIdSet,
        allSelected: selectableIds.length > 0 && selectedCount === selectableIds.length,
        onlineCount,
      });
    }

    return next;
  }, [groupedDeviceEntries, isDeviceSelectable, isDeviceTrulyOnline, selectedDeviceIdSet]);

  // Clean up selection when devices become unselectable
  useEffect(() => {
    if (selectedDevices.length === 0) {
      return;
    }

    const validSelectedDevices = selectedDevices.filter((deviceId) => selectableFilteredDeviceIdSet.has(deviceId));

    if (validSelectedDevices.length !== selectedDevices.length) {
      setSelectedDevices(validSelectedDevices);
    }
  }, [selectedDevices, selectableFilteredDeviceIdSet]);

  // Reset hide inactive toggle when switching to filter types that don't support it
  useEffect(() => {
    if (!showHideInactiveToggle && hideInactiveDevices) {
      setHideInactiveDevices(false);
    }
  }, [showHideInactiveToggle, hideInactiveDevices]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      if (refreshAnimationRef.current) {
        refreshAnimationRef.current.stop();
      }
    };
  }, []);

  // Device icon helper
  const getDeviceIcon = useCallback((device: UserDevice) => {
    const isWeb = device.deviceType === 'web' || device.platformOS === 'web' || 
                  !!(device.viewportWidth || device.currentUrl || device.screenScale);
    
    if (isWeb) {
      return <Monitor size={20} color={theme.primary} />;
    } else if (device.deviceType === 'tablet') {
      return <Tablet size={20} color={theme.success} />;
    } else {
      return <Smartphone size={20} color={theme.warning} />;
    }
  }, [theme]);

  // Format last seen
  const formatLastSeen = useCallback((lastSeen: any) => {
    let date: Date;
    
    // Handle serverTimestamp objects (not yet resolved)
    if (lastSeen && typeof lastSeen === 'object' && (lastSeen as any)._methodName === 'serverTimestamp') {
      return 'Just now'; // Use current time for unresolved serverTimestamp
    }
    // Handle Firestore Timestamp objects with seconds and nanoseconds properties
    else if (lastSeen && typeof lastSeen === 'object' && lastSeen.seconds !== undefined) {
      date = new Date(lastSeen.seconds * 1000 + Math.floor(lastSeen.nanoseconds / 1000000));
    }
    else if (lastSeen instanceof Date) {
      date = lastSeen;
    } else if (typeof lastSeen === 'string') {
      date = new Date(lastSeen);
    } else if (lastSeen && typeof lastSeen.toDate === 'function') {
      // Firestore Timestamp
      date = lastSeen.toDate();
    } else if (lastSeen && lastSeen.seconds) {
      // Firestore Timestamp object (legacy format)
      date = new Date(lastSeen.seconds * 1000);
    } else {
      date = new Date();
    }

    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return date.toLocaleDateString();
  }, []);

  // Selection handlers
  const toggleDeviceSelection = useCallback((deviceId: string) => {
    setSelectedDevices(prev => {
      const updated = prev.includes(deviceId)
        ? prev.filter(id => id !== deviceId)
        : [...prev, deviceId];
      return updated;
    });
  }, []);

  const selectAllDevices = useCallback(() => {
    if (areAllSelectableDevicesSelected) {
      // Deselect all devices
      setSelectedDevices([]);
    } else {
      // Select all devices
      setSelectedDevices(selectableFilteredDeviceIds);
    }
  }, [areAllSelectableDevicesSelected, selectableFilteredDeviceIds]);

  const clearSelection = useCallback(() => {
    setSelectedDevices([]);
    setSelectedUsers([]);
  }, []);

  const toggleUserSelectableDevices = useCallback((groupMeta?: UserGroupSelectionMeta) => {
    if (!groupMeta || groupMeta.selectableIds.length === 0) {
      return;
    }

    setSelectedDevices((previous) => {
      if (groupMeta.allSelected) {
        const next = previous.filter((id) => !groupMeta.selectableIdSet.has(id));
        return next.length === previous.length ? previous : next;
      }

      const nextIds = new Set(previous);
      let changed = false;
      for (const id of groupMeta.selectableIds) {
        if (nextIds.has(id)) {
          continue;
        }

        nextIds.add(id);
        changed = true;
      }

      return changed ? Array.from(nextIds) : previous;
    });
  }, []);

  // Device action handlers
  const handleDeviceAction = useCallback((device: UserDevice, userEmail: string, actionType: 'delete' | 'restore' | 'logout' | 'hardban') => {
    setSelectedDevice(device);
    setSelectedUserEmail(userEmail);
    setSelectedActionType(actionType);
    
    if (actionType === 'hardban') {
      setShowHardBanModal(true);
    } else {
      setShowActionModal(true);
    }
  }, []);

  const handleDeviceDetails = useCallback((device: UserDevice, userEmail: string) => {
    setSelectedDevice(device);
    setSelectedUserEmail(userEmail);
    setShowDetailsModal(true);
  }, []);

  const handleDeviceActionComplete = useCallback(() => {
    loadAuthorizedUsersWithDevices();
    setShowActionModal(false);
    setShowDetailsModal(false);
    setShowHardBanModal(false);
    setSelectedDevice(null);
    setSelectedUserEmail('');
    setSelectedActionType(null);
    // Reset hard ban state
    setHardBanReason('');
    setHardBanExpiration(null);
    setHardBanExpirationEnabled(false);
    // Clear ban expiration info cache to force reload
    setBanExpirationInfo({});
  }, [loadAuthorizedUsersWithDevices]);

  // Hard ban handler
  const handleHardBan = useCallback(async () => {
    if (hardBanRequestInFlightRef.current) {
      return;
    }

    if (!selectedDevice || !selectedUserEmail || !hardBanReason.trim()) {
      Toast.show({
        type: 'error',
        text1: 'Missing Information',
        text2: 'Please provide a reason for the ban'
      });
      return;
    }

    try {
      hardBanRequestInFlightRef.current = true;
      setLoading(true);
      
      const expirationDate = hardBanExpirationEnabled && hardBanExpiration ? hardBanExpiration : undefined;
      
      await deviceTrackingService.createDeviceBan(
        selectedDevice,
        selectedUserEmail,
        hardBanReason,
        adminEmail,
        adminName,
        expirationDate
      );

      Toast.show({
        type: 'success',
        text1: 'Device Hard Banned',
        text2: `Device has been permanently banned${expirationDate ? ' until ' + expirationDate.toLocaleDateString() : ''}`
      });

      handleDeviceActionComplete();
    } catch (error) {
      logger.error('❌ Error creating hard ban:', error);
      Toast.show({
        type: 'error',
        text1: 'Ban Failed',
        text2: 'Failed to ban device'
      });
    } finally {
      setLoading(false);
      hardBanRequestInFlightRef.current = false;
    }
  }, [selectedDevice, selectedUserEmail, hardBanReason, hardBanExpirationEnabled, hardBanExpiration, adminEmail, adminName, handleDeviceActionComplete]);

  // Notification handlers
  const sendNotification = useCallback(async () => {
    if (sendNotificationRequestInFlightRef.current) {
      return;
    }

    if (!notificationData.title.trim() || !notificationData.message.trim()) {
      Toast.show({
        type: 'error',
        text1: 'Missing Information',
        text2: 'Please enter both title and message'
      });
      return;
    }

    if (selectedUsers.length === 0 && selectedDevices.length === 0) {
      Toast.show({
        type: 'error',
        text1: 'No Recipients',
        text2: 'Please select at least one user or device'
      });
      return;
    }

    if (!tenantId) {
      Toast.show({
        type: 'error',
        text1: 'Select a Coaching Center',
        text2: 'Choose an active coaching center before sending notifications'
      });
      return;
    }

    try {
      sendNotificationRequestInFlightRef.current = true;
      setIsSendingNotification(true);
      setLoading(true);
      setNotificationErrors([]);

      const tenantOptions = { tenantId, tenantName };

      const notification = {
        title: notificationData.title,
        body: notificationData.message,
        type: notificationData.type,
        adminEmail,
        adminName,
        timestamp: new Date().toISOString(),
        tenantId,
        tenantName,
      };

      let userResultsSuccess = 0;
      let userResultsFailed = 0;
      let deviceResultsSuccess = 0;
      let deviceResultsFailed = 0;
      const errorMessages: string[] = [];

      // Send to selected users
      if (selectedUsers.length > 0) {
        const userResults = await sendBulkAdminNotifications(selectedUsers, notification, true, tenantOptions);
        userResultsSuccess = userResults.totalSuccess || 0;
        userResultsFailed = userResults.totalFailed || 0;

        if (userResults.results?.length) {
          userResults.results.forEach((result) => {
            if (result.failed > 0) {
              errorMessages.push(`Failed for ${result.email}: ${result.failed} device${result.failed !== 1 ? 's' : ''}`);
            }
          });
        }
      }

      // Send to selected devices
      if (selectedDevices.length > 0) {
        const deviceTargets = selectedDevices.map((deviceId) => {
          return {
            email: filteredDeviceOwnerById.get(deviceId) || '',
            deviceId,
          };
        });

        const deviceResults = await sendBulkAdminNotificationsToDevices(deviceTargets, notification, tenantOptions);
        deviceResultsSuccess = deviceResults.totalSuccess || 0;
        deviceResultsFailed = deviceResults.totalFailed || 0;

        if (deviceResults.results?.length) {
          deviceResults.results.forEach((result) => {
            if (!result.success) {
              const label = result.email ? `${result.email} (${result.deviceId})` : result.deviceId;
              const reasonText = describeDeviceFailureReason(result.reason);
              errorMessages.push(`Failed for device ${label}${reasonText ? `: ${reasonText}` : ''}`);
            }
          });
        }

        if ('failureReasons' in deviceResults && deviceResults.failureReasons) {
          Object.entries(deviceResults.failureReasons as Record<string, number>)
            .filter(([, count]) => count > 0)
            .forEach(([reasonKey, count]) => {
              const reasonText = describeDeviceFailureReason(reasonKey);
              const reasonLabel = reasonText ?? 'Delivery failed.';
              errorMessages.push(`${count} device${count !== 1 ? 's' : ''} failed: ${reasonLabel}`);
            });
        }
      }

      const totalSuccess = userResultsSuccess + deviceResultsSuccess;
      const totalFailed = userResultsFailed + deviceResultsFailed;

      if (totalSuccess > 0) {
        Toast.show({
          type: 'success',
          text1: 'Notifications Sent',
          text2: `Successfully sent ${totalSuccess} notification${totalSuccess !== 1 ? 's' : ''}${
            totalFailed > 0 ? `, ${totalFailed} failed` : ''
          }`
        });

        if (errorMessages.length > 0) {
          setNotificationErrors(errorMessages);
        } else {
          setNotificationErrors([]);

          // Reset form and close modal only when no errors remain
          setNotificationData({
            title: '',
            message: '',
            type: 'info',
            targetUsers: [],
            targetDevices: []
          });
          clearSelection();
          setShowNotificationModal(false);
        }
      } else {
        if (errorMessages.length > 0) {
          setNotificationErrors(errorMessages);
        } else {
          setNotificationErrors(['No notifications were delivered.']);
        }
        Toast.show({
          type: 'error',
          text1: 'Send Failed',
          text2: 'No notifications were sent successfully'
        });
      }
    } catch (error) {
      logger.error('❌ Error sending notification:', error);
      setNotificationErrors([error instanceof Error ? error.message : 'Failed to send notifications']);
      Toast.show({
        type: 'error',
        text1: 'Send Failed',
        text2: 'Failed to send notifications'
      });
    } finally {
      setIsSendingNotification(false);
      setLoading(false);
      sendNotificationRequestInFlightRef.current = false;
    }
  }, [notificationData, selectedUsers, selectedDevices, adminEmail, adminName, tenantId, tenantName, sendBulkAdminNotifications, sendBulkAdminNotificationsToDevices, filteredDeviceOwnerById, clearSelection]);

  // Notification type icon helper
  const getNotificationTypeIcon = useCallback((type: string) => {
    switch (type) {
      case 'warning':
        return <AlertTriangle size={18} color={theme.warning} />;
      case 'success':
        return <CheckCircle size={18} color={theme.success} />;
      case 'announcement':
        return <Bell size={18} color={theme.primary} />;
      case 'info':
      default:
        return <Info size={18} color={theme.primary} />;
    }
  }, [theme]);

  const renderDeviceCard = useCallback(({ device, userEmail, userName }: { device: UserDevice; userEmail: string; userName: string }) => {
    const isSelected = selectedDeviceIdSet.has(device.deviceId);
    const isSelectable = isDeviceSelectable(device);
    const isWeb = device.deviceType === 'web' || device.platformOS === 'web' || 
                  !!(device.viewportWidth || device.currentUrl || device.screenScale);

    return (
      <TouchableOpacity
        key={device.deviceId}
        style={[
          styles.deviceCard,
          { 
            backgroundColor: theme.surface, 
            borderColor: isSelected ? theme.primary : theme.border
          },
          isSelected && { backgroundColor: `${theme.primary}10` },
          !isSelectable && { backgroundColor: theme.surface + '80' } // Slightly different background for non-selectable
        ]}
        onPress={() => isSelectable && toggleDeviceSelection(device.deviceId)} // Only allow selection if selectable
        onLongPress={() => handleDeviceDetails(device, userEmail)}
        disabled={!isSelectable} // Disable touch for non-selectable devices
        activeOpacity={isSelectable ? 0.7 : 1} // Different press feedback for non-selectable devices
      >
        {/* Device Header */}
        <View style={styles.deviceHeader}>
          <View style={styles.deviceMainInfo}>
            {getDeviceIcon(device)}
            <View style={styles.deviceInfo}>
              <Text style={[styles.deviceName, { color: theme.text }]}>
                {device.deviceName || 'Unknown Device'}
              </Text>
              <Text style={[styles.deviceUser, { color: theme.textSecondary }]}>
                {userName} ({userEmail})
              </Text>
            </View>
          </View>

          {/* Status Indicators */}
          <View style={styles.deviceStatus}>
            {isDeviceHardBanned(device) ? (
              <View style={[styles.statusBadge, { backgroundColor: '#8B0000' }]}>
                <Ban size={12} color="white" />
                <Text style={styles.statusText}>Hard Banned</Text>
              </View>
            ) : device.isDeleted ? (
              <View style={[styles.statusBadge, { backgroundColor: theme.error }]}>
                <Text style={styles.statusText}>Deleted</Text>
              </View>
            ) : (device.lastActivityType === 'forced_logout' || device.logoutType === 'forced') ? (
              <View style={[styles.statusBadge, { backgroundColor: theme.warning }]}>
                <LogOut size={12} color="white" />
                <Text style={styles.statusText}>Force Logged Out</Text>
              </View>
            ) : (device.lastActivityType === 'logout' || device.logoutType === 'manual') ? (
              <View style={[styles.statusBadge, { backgroundColor: '#2196F3' }]}>
                <LogOut size={12} color="white" />
                <Text style={styles.statusText}>Logged Out</Text>
              </View>
            ) : isDeviceTrulyOnline(device) ? (
              <View style={[styles.statusBadge, { backgroundColor: theme.success }]}>
                <Wifi size={12} color="white" />
                <Text style={styles.statusText}>Online</Text>
              </View>
            ) : (
              <View style={[styles.statusBadge, { backgroundColor: theme.textSecondary }]}>
                <WifiOff size={12} color="white" />
                <Text style={styles.statusText}>Offline</Text>
              </View>
            )}
          </View>
        </View>

        {/* Device Details */}
        <View style={[styles.deviceDetails, { opacity: isSelectable ? 1 : 0.6 }]}>
          <View style={styles.deviceMetadata}>
            <View style={styles.metadataRow}>
              <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>Type:</Text>
              <Text style={[styles.metadataValue, { color: theme.text }]}> 
                {isWeb ? 'Web Browser' : device.deviceType || 'Mobile'}
              </Text>
            </View>
            {device.osName && (
              <View style={styles.metadataRow}>
                <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>OS:</Text>
                <Text style={[styles.metadataValue, { color: theme.text }]}> 
                  {device.osName} {device.osVersion}
                </Text>
              </View>
            )}
            {device.browserName && (
              <View style={styles.metadataRow}>
                <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>Browser:</Text>
                <Text style={[styles.metadataValue, { color: theme.text }]}> 
                  {device.browserName} {device.browserVersion}
                </Text>
              </View>
            )}
            {device.ipAddress && (
              <View style={styles.metadataRow}>
                <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>IP:</Text>
                <Text style={[styles.metadataValue, { color: theme.text }]}> 
                  {device.ipAddress}
                </Text>
              </View>
            )}
            <View style={styles.metadataRow}>
              <Text style={[styles.metadataLabel, { color: theme.textSecondary }]}>Last Seen:</Text>
              <Text style={[styles.metadataValue, { color: theme.text }]}> 
                {formatLastSeen(device.lastSeen)}
              </Text>
            </View>
          </View>
        </View>
        {/* Device Actions - now in a new line below details */}
        <View style={[styles.deviceActions, { flexDirection: 'row', flexWrap: 'nowrap', marginTop: 8, justifyContent: 'flex-end', alignItems: 'center' }]}> 
          {isSelected && isSelectable && (
            <View style={[styles.selectionIndicator, { backgroundColor: theme.primary, marginRight: 8 }]}> 
              <CheckCircle size={16} color="white" />
            </View>
          )}
          {!isSelectable && (
            <View style={[styles.selectionIndicator, { backgroundColor: theme.textSecondary, marginRight: 8, opacity: 0.5 }]}> 
              <X size={16} color="white" />
            </View>
          )}
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: theme.primary + '20', marginRight: 8 }]}
            onPress={() => handleDeviceDetails(device, userEmail)}
          >
            <Eye size={16} color={theme.primary} />
          </TouchableOpacity>
          {isDeviceTrulyOnline(device) && (
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: theme.warning + '20', marginRight: 8 }]}
              onPress={() => handleDeviceAction(device, userEmail, 'logout')}
            >
              <LogOut size={16} color={theme.warning} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: device.isDeleted ? theme.success + '20' : theme.error + '20', marginRight: 8 }]}
            onPress={() => handleDeviceAction(device, userEmail, device.isDeleted ? 'restore' : 'delete')}
          >
            {device.isDeleted ? (
              <RotateCcw size={16} color={theme.success} />
            ) : (
              <Ban size={16} color={theme.error} />
            )}
          </TouchableOpacity>
          {!device.isDeleted && (
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: theme.error + '40', marginRight: 0 }]}
              onPress={() => handleDeviceAction(device, userEmail, 'hardban')}
            >
              <Ban size={16} color={theme.error + 'CC'} />
            </TouchableOpacity>
          )}
        </View>

        {device.isDeleted && (
          <View style={styles.deletionInfo}>
            <Text style={[styles.deletionText, { color: isDeviceHardBanned(device) ? '#8B0000' : theme.error }]}>
              {isDeviceHardBanned(device) ? 'Hard Banned' : 'Deleted'} by {device.deletedByName || device.deletedBy}
            </Text>
            {device.deletedAt && (
              <Text style={[styles.deletionReason, { color: theme.textSecondary }]}>
                Deleted: {formatLastSeen(device.deletedAt)}
              </Text>
            )}
            {/* Only show deletion reason for non-hard-banned devices */}
            {device.deletionReason && !isDeviceHardBanned(device) && (
              <Text style={[styles.deletionReason, { color: theme.textSecondary }]}>
                Reason: {device.deletionReason}
              </Text>
            )}
            {isDeviceHardBanned(device) && (
              <Text style={[styles.deletionReason, { color: '#8B0000', fontWeight: '600' }]}>
                {(() => {
                  const banInfo = banExpirationInfo[device.deviceId];
                  if (banInfo && banInfo.daysRemaining && banInfo.daysRemaining > 0) {
                    return `⚠️ Device banned for ${banInfo.daysRemaining} more day${banInfo.daysRemaining !== 1 ? 's' : ''}`;
                  } else if (banInfo && banInfo.expiresAt) {
                    return `⚠️ Device ban has expired`;
                  } else {
                    return `⚠️ Device is permanently blocked based on hardware fingerprint`;
                  }
                })()}
              </Text>
            )}
            {/* Only show ban reason from device_bans collection */}
            {banExpirationInfo[device.deviceId]?.reason && (
              <Text style={[styles.deletionReason, { color: theme.textSecondary, fontStyle: 'italic' }]}>
                Ban Reason: {banExpirationInfo[device.deviceId].reason}
              </Text>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  }, [selectedDeviceIdSet, theme, getDeviceIcon, toggleDeviceSelection, handleDeviceDetails, handleDeviceAction, formatLastSeen, isDeviceOnline, isDeviceHardBanned, banExpirationInfo, isDeviceTrulyOnline, isDeviceSelectable]);

  // Get filtered device stats for rendering
  const filteredDeviceMetrics = useMemo(() => {
    let onlineCount = 0;
    let offlineCount = 0;
    let deletedCount = 0;
    let hardBannedCount = 0;

    for (const { device } of filteredDevices) {
      if (isDeviceHardBanned(device)) {
        hardBannedCount += 1;
      }

      if (device.isDeleted) {
        deletedCount += 1;
        continue;
      }

      if (isDeviceTrulyOnline(device)) {
        onlineCount += 1;
      } else if (!isDeviceOnline(device) || isDeviceLoggedOut(device)) {
        offlineCount += 1;
      }
    }

    const deviceSummaryParts: { text: string; color?: string }[] = [];
    if (filteredDevices.length > 0) {
      deviceSummaryParts.push({ text: `${onlineCount} online` });
      deviceSummaryParts.push({ text: `${offlineCount} offline` });
    }
    if (deletedCount > 0) {
      deviceSummaryParts.push({ text: `${deletedCount} deleted` });
    }
    if (hardBannedCount > 0) {
      deviceSummaryParts.push({ text: `${hardBannedCount} hard banned`, color: '#8B0000' });
    }

    return {
      onlineCount,
      offlineCount,
      deletedCount,
      hardBannedCount,
      deviceSummaryParts,
    };
  }, [filteredDevices, isDeviceHardBanned, isDeviceLoggedOut, isDeviceOnline, isDeviceTrulyOnline]);

  const quickSelectableDeviceIds = useMemo(() => {
    const online: string[] = [];
    const web: string[] = [];
    const mobile: string[] = [];

    for (const { device } of filteredDevices) {
      if (device.isDeleted) {
        continue;
      }

      if (isDeviceTrulyOnline(device)) {
        online.push(device.deviceId);
      }

      if (device.deviceType === 'web' || device.platformOS === 'web') {
        web.push(device.deviceId);
      }

      if (device.deviceType === 'mobile') {
        mobile.push(device.deviceId);
      }
    }

    return {
      online,
      web,
      mobile,
    };
  }, [filteredDevices, isDeviceTrulyOnline]);

  const selectOnlineDevices = useCallback(() => {
    setSelectedDevices(quickSelectableDeviceIds.online);
  }, [quickSelectableDeviceIds.online]);

  const selectWebDevices = useCallback(() => {
    setSelectedDevices(quickSelectableDeviceIds.web);
  }, [quickSelectableDeviceIds.web]);

  const selectMobileDevices = useCallback(() => {
    setSelectedDevices(quickSelectableDeviceIds.mobile);
  }, [quickSelectableDeviceIds.mobile]);

  const { onlineCount, deviceSummaryParts } = filteredDeviceMetrics;
  const hasRecipientsSelected = selectedUsers.length > 0 || selectedDevices.length > 0;
  const hasNotificationTitle = notificationData.title.trim().length > 0;
  const hasNotificationMessage = notificationData.message.trim().length > 0;
  const isSendReady = hasRecipientsSelected && hasNotificationTitle && hasNotificationMessage;
  const isRefreshInProgress = loading && !isSendingNotification;
  const isSendDisabled = !isSendReady || isSendingNotification || isRefreshInProgress;

  if (loading && authorizedUsers.length === 0) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.text }]}>
          Loading devices...
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Header */}
      <View style={[
        styles.header, 
        { 
          backgroundColor: theme.surface, 
          borderBottomColor: theme.border,
          paddingHorizontal: width <= 480 ? 12 : width <= 768 ? 16 : 20,
          paddingVertical: width <= 480 ? 12 : 16
        }
      ]}>
  <View style={[styles.headerTopRow, width <= 630 ? { alignItems: 'flex-start' } : null]}>
          <Text style={[styles.title, { color: theme.text }]}> 
            {width <= 545 ? 'Devices' : 'Device Management'}
          </Text>
          <View
            style={[
              styles.headerActions,
              width <= 630 ? { justifyContent: 'flex-start', marginTop: 4 } : null,
            ]}
          >
            <TouchableOpacity
              style={[styles.headerButton, { backgroundColor: theme.background, borderColor: theme.border }]}
              onPress={handleManualRefresh}
              disabled={loading}
            >
              <Animated.View style={isRefreshAnimating ? refreshRotationStyle : {}}>
                <RotateCcw size={20} color={loading ? theme.textSecondary : theme.primary} />
              </Animated.View>
              {width > 700 && (
                <Text style={[styles.headerButtonText, { color: loading ? theme.textSecondary : theme.primary }]}> 
                  {loading ? 'Refreshing...' : 'Refresh'}
                </Text>
              )}
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.headerButton, { backgroundColor: theme.background, borderColor: theme.border }]}
              onPress={() => setShowHistoryModal(true)}
            >
              <Clock size={20} color={theme.primary} />
              {width > 700 && (
                <Text style={[styles.headerButtonText, { color: theme.primary }]}>History</Text>
              )}
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.notifyButton, {
                backgroundColor: selectedUsers.length === 0 && selectedDevices.length === 0
                  ? theme.textSecondary
                  : theme.primary,
                paddingVertical: 6,
                paddingHorizontal: width <= 480 ? 8 : 12,
                minHeight: 32,
                borderRadius: 18,
              }]}
              onPress={() => setShowNotificationModal(true)}
            >
              <Bell size={16} color="white" />
              <Text style={[styles.notifyButtonText, { fontSize: width <= 480 ? 12 : 13, marginLeft: 4 }]}> 
                {width <= 480 ? 'Notify' : 'Notify'} {selectedDevices.length + selectedUsers.length > 0 ? `(${selectedDevices.length + selectedUsers.length})` : ''}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <Text
          style={[styles.subtitle, {
            color: theme.textSecondary,
            fontSize: width <= 480 ? 12 : width <= 768 ? 13 : 14,
          }]}
        >
          {`${filteredDevices.length} device${filteredDevices.length !== 1 ? 's' : ''}`}
          {hideInactiveDevices && showHideInactiveToggle && (
            <Text style={{ color: theme.primary }}> (active only)</Text>
          )}
          {deviceSummaryParts.map((part) => (
            <Text key={part.text} style={{ color: part.color ?? theme.textSecondary }}>
              {` • ${part.text}`}
            </Text>
          ))}
        </Text>
      </View>

      {/* Search and Filters */}
      <View style={[styles.searchContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <View style={[styles.searchBox, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <Search size={20} color={theme.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: theme.text }]}
            placeholder="Search devices, users, or IPs..."
            placeholderTextColor={theme.textSecondary}
            value={searchQuery}
            onChangeText={handleSearchQueryChange}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              style={styles.clearSearchButton}
              onPress={clearSearchQuery}
            >
              <X size={18} color={theme.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        <TouchableOpacity
          style={[styles.filterButton, { backgroundColor: theme.background, borderColor: theme.border }]}
          onPress={() => setShowFilterModal(true)}
        >
          <Filter size={20} color={theme.primary} />
          <Text style={[styles.filterButtonText, { color: theme.primary }]}>
            {getFilterDisplayText(filterType)}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Hide Inactive Devices Toggle */}
      {showHideInactiveToggle && (
        <View style={[styles.toggleContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity
            style={[styles.toggleButton, { backgroundColor: hideInactiveDevices ? theme.primary + '15' : theme.background }]}
            onPress={() => setHideInactiveDevices(!hideInactiveDevices)}
          >
            {hideInactiveDevices ? (
              <EyeOff size={18} color={theme.primary} />
            ) : (
              <Eye size={18} color={theme.textSecondary} />
            )}
            <Text style={[styles.toggleText, { color: hideInactiveDevices ? theme.primary : theme.textSecondary }]}>
              Hide inactive devices
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Selection Actions */}
      {selectedDevices.length > 0 && (
        <View style={[styles.selectionActions, { backgroundColor: theme.primary + '10', borderColor: theme.primary }]}>
          <Text style={[styles.selectionCount, { color: theme.primary }]}>
            {selectedDevices.length} device{selectedDevices.length !== 1 ? 's' : ''} selected
          </Text>
          
          <View style={styles.selectionButtons}>
            <TouchableOpacity
              style={[styles.selectionButton, { backgroundColor: theme.primary }]}
              onPress={() => setShowNotificationModal(true)}
            >
              <Bell size={16} color="white" />
              <Text style={styles.selectionButtonText}>Notify</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.selectionButton, { backgroundColor: theme.textSecondary }]}
              onPress={clearSelection}
            >
              <X size={16} color="white" />
              <Text style={styles.selectionButtonText}>Clear</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Device List */}
      <ScrollView
        style={styles.deviceList}
        contentContainerStyle={styles.deviceListContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            colors={[theme.primary]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {filteredDevices.length > 0 ? (
          <View>
            {/* Quick Actions */}
            <View style={[styles.quickActions, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <TouchableOpacity
                style={[
                  styles.quickActionButton, 
                  { 
                    backgroundColor: areAllSelectableDevicesSelected ? theme.primary : theme.primary + '15',
                    opacity: selectableFilteredDeviceIds.length > 0 ? 1 : 0.45,
                  }
                ]}
                onPress={selectAllDevices}
                disabled={selectableFilteredDeviceIds.length === 0}
              >
                <CheckCircle size={16} color={areAllSelectableDevicesSelected ? 'white' : theme.primary} />
                <Text style={[
                  styles.quickActionText, 
                  { color: areAllSelectableDevicesSelected ? 'white' : theme.primary }
                ]}>
                  {areAllSelectableDevicesSelected
                    ? `Selected (${selectableFilteredDeviceIds.length})`
                    : `Select All (${selectableFilteredDeviceIds.length})`
                  }
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.quickActionButton, { backgroundColor: theme.textSecondary + '15', opacity: selectedDevices.length > 0 || selectedUsers.length > 0 ? 1 : 0.45 }]}
                onPress={clearSelection}
                disabled={selectedDevices.length === 0 && selectedUsers.length === 0}
              >
                <X size={16} color={theme.textSecondary} />
                <Text style={[styles.quickActionText, { color: theme.textSecondary }]}>
                  Clear Selection
                </Text>
              </TouchableOpacity>
            </View>

            {/* Device Cards Grouped by User */}
            {groupedDeviceEntries.map(([userEmail, devices]) => {
              const groupMeta = userGroupSelectionMeta.get(userEmail);
              const selectableUserDeviceIds = groupMeta?.selectableIds || [];
              const areAllUserSelectableDevicesSelected = groupMeta?.allSelected || false;
              const onlineUserDeviceCount = groupMeta?.onlineCount || 0;

              return (
                <View key={userEmail} style={styles.userGroup}>
                  {/* User Header */}
                  <View style={[styles.userHeader, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                    <View style={styles.userInfo}>
                      <Text style={[styles.userEmail, { color: theme.text }]}>{userEmail}</Text>
                      <Text style={[styles.userStats, { color: theme.textSecondary }]}> 
                        {devices.length} device{devices.length !== 1 ? 's' : ''} • {onlineUserDeviceCount} online
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={[styles.selectUserButton, { backgroundColor: theme.primary + '15', opacity: selectableUserDeviceIds.length > 0 ? 1 : 0.45 }]}
                      onPress={() => toggleUserSelectableDevices(groupMeta)}
                      disabled={selectableUserDeviceIds.length === 0}
                    >
                      <Text style={[styles.selectUserText, { color: theme.primary }]}> 
                        {areAllUserSelectableDevicesSelected ? 'Deselect All' : 'Select All'} ({selectableUserDeviceIds.length})
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* User's Devices */}
                  {devices.map(({ device, userEmail, userName }) =>
                    renderDeviceCard({ device, userEmail, userName })
                  )}
                </View>
              );
            })}
          </View>
        ) : (
          <View style={styles.emptyState}>
            <Monitor size={48} color={theme.textSecondary} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>
              No devices found
            </Text>
            <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>
              {hasSearchQuery ? 'Try adjusting your search terms' : 'No devices are currently registered'}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Send Notification Modal */}
      <Modal
        visible={showNotificationModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowNotificationModal(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <Text style={[styles.modalTitle, { color: theme.text }]}>Send Notification</Text>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowNotificationModal(false)}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 20 }),
            }}
          >
            {notificationErrors.length > 0 && (
              <View style={[styles.errorContainer, { borderColor: theme.error, backgroundColor: theme.error + '15' }]}> 
                <Text style={[styles.errorTitle, { color: theme.error }]}>Delivery issues</Text>
                {notificationErrors.map((message, index) => (
                  <Text key={`${message}-${index}`} style={[styles.errorMessage, { color: theme.textSecondary }]}>- {message}</Text>
                ))}
              </View>
            )}

            {/* Recipients Summary */}
            <View style={[styles.recipientsSummary, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <Text style={[styles.recipientsTitle, { color: theme.text }]}>Recipients</Text>
              <Text style={[styles.recipientsCount, { color: theme.textSecondary }]}>
                {selectedUsers.length > 0 ? `${selectedUsers.length} user${selectedUsers.length !== 1 ? 's' : ''}` : ''}
                {selectedUsers.length > 0 && selectedDevices.length > 0 ? ', ' : ''}
                {selectedDevices.length > 0 ? `${selectedDevices.length} device${selectedDevices.length !== 1 ? 's' : ''}` : ''}
                {selectedUsers.length === 0 && selectedDevices.length === 0 ? 'No recipients selected - tap devices below to add' : ''}
              </Text>
            </View>

            {/* Quick Device Selection */}
            {selectedUsers.length === 0 && selectedDevices.length === 0 && (
              <View style={[styles.quickSelectionContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.quickSelectionTitle, { color: theme.text }]}>Quick Selection</Text>
                <View style={styles.quickSelectionButtons}>
                  <TouchableOpacity
                    style={[styles.quickSelectButton, { backgroundColor: theme.success + '20', opacity: quickSelectableDeviceIds.online.length > 0 ? 1 : 0.45 }]}
                    onPress={selectOnlineDevices}
                    disabled={quickSelectableDeviceIds.online.length === 0}
                  >
                    <Wifi size={16} color={theme.success} />
                    <Text style={[styles.quickSelectText, { color: theme.success }]}>
                      All Online ({quickSelectableDeviceIds.online.length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.quickSelectButton, { backgroundColor: theme.primary + '20', opacity: quickSelectableDeviceIds.web.length > 0 ? 1 : 0.45 }]}
                    onPress={selectWebDevices}
                    disabled={quickSelectableDeviceIds.web.length === 0}
                  >
                    <Monitor size={16} color={theme.primary} />
                    <Text style={[styles.quickSelectText, { color: theme.primary }]}>
                      Web Browsers ({quickSelectableDeviceIds.web.length})
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.quickSelectButton, { backgroundColor: theme.warning + '20', opacity: quickSelectableDeviceIds.mobile.length > 0 ? 1 : 0.45 }]}
                    onPress={selectMobileDevices}
                    disabled={quickSelectableDeviceIds.mobile.length === 0}
                  >
                    <Smartphone size={16} color={theme.warning} />
                    <Text style={[styles.quickSelectText, { color: theme.warning }]}>
                      Mobile Devices ({quickSelectableDeviceIds.mobile.length})
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Notification Type */}
            <Text style={[styles.formLabel, { color: theme.text }]}>Notification Type</Text>
            <View style={styles.typeContainer}>
              {[
                { key: 'info', label: 'Information', color: theme.primary },
                { key: 'warning', label: 'Warning', color: theme.warning },
                { key: 'success', label: 'Success', color: theme.success },
                { key: 'announcement', label: 'Announcement', color: theme.primary }
              ].map((type) => (
                <TouchableOpacity
                  key={type.key}
                  style={[
                    styles.typeButton,
                    { borderColor: theme.border },
                    notificationData.type === type.key && { 
                      backgroundColor: type.color, 
                      borderColor: type.color 
                    }
                  ]}
                  onPress={() => setNotificationData(prev => ({ ...prev, type: type.key as any }))}
                >
                  {getNotificationTypeIcon(type.key)}
                  <Text style={[
                    styles.typeButtonText,
                    { color: notificationData.type === type.key ? 'white' : theme.text }
                  ]}>
                    {type.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Title */}
            <Text style={[styles.formLabel, { color: theme.text }]}>Title</Text>
            <TextInput
              style={[styles.textInput, { 
                backgroundColor: theme.surface, 
                color: theme.text, 
                borderColor: theme.border 
              }]}
              placeholder="Enter notification title..."
              placeholderTextColor={theme.textSecondary}
              value={notificationData.title}
              onChangeText={(text) => setNotificationData(prev => ({ ...prev, title: text }))}
            />

            {/* Message */}
            <Text style={[styles.formLabel, { color: theme.text }]}>Message</Text>
            <TextInput
              style={[styles.textAreaInput, { 
                backgroundColor: theme.surface, 
                color: theme.text, 
                borderColor: theme.border 
              }]}
              placeholder="Enter notification message..."
              placeholderTextColor={theme.textSecondary}
              value={notificationData.message}
              onChangeText={(text) => setNotificationData(prev => ({ ...prev, message: text }))}
              multiline
              numberOfLines={4}
            />

            {/* Send Button */}
            <TouchableOpacity
              style={[
                styles.sendButton,
                { 
                  backgroundColor: isSendDisabled && !isSendingNotification ? theme.textSecondary : theme.primary,
                  opacity: isSendingNotification || isRefreshInProgress || !isSendReady ? 0.7 : 1,
                }
              ]}
              onPress={sendNotification}
              disabled={isSendDisabled}
            >
              {isSendingNotification ? (
                <ActivityIndicator size="small" color="white" />
              ) : isRefreshInProgress ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Send size={20} color="white" />
              )}
              <Text style={styles.sendButtonText}>
                {isSendingNotification ? 'Sending...' : isRefreshInProgress ? 'Please wait...' : 'Send Notification'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Filter Modal */}
      <Modal
        visible={showFilterModal}
        animationType="fade"
        transparent
        onRequestClose={() => setShowFilterModal(false)}
      >
        <View style={styles.filterModalOverlay}>
          <View style={[styles.filterModalContent, { backgroundColor: theme.surface }]}>
            <Text style={[styles.filterModalTitle, { color: theme.text }]}>Filter Devices</Text>
            
            {[
              { key: 'all', label: 'All Devices', icon: null },
              { key: 'online', label: 'Online', icon: <Wifi size={16} color={theme.success} /> },
              { key: 'offline', label: 'Offline', icon: <WifiOff size={16} color={theme.textSecondary} /> },
              { key: 'logged_out', label: 'Logged Out', icon: <LogOut size={16} color="#2196F3" /> },
              { key: 'force_logged_out', label: 'Force Logged Out', icon: <LogOut size={16} color={theme.warning} /> },
              { key: 'web', label: 'Web Browsers', icon: <Monitor size={16} color={theme.primary} /> },
              { key: 'mobile', label: 'Mobile', icon: <Smartphone size={16} color={theme.warning} /> },
              { key: 'tablet', label: 'Tablet', icon: <Tablet size={16} color={theme.success} /> },
              { key: 'deleted', label: 'Deleted', icon: <Trash2 size={16} color={theme.error} /> },
              { key: 'hard_banned', label: 'Hard Banned', icon: <Ban size={16} color="#8B0000" /> }
            ].map((filter) => (
              <TouchableOpacity
                key={filter.key}
                style={[
                  styles.filterOption,
                  { borderColor: theme.border },
                  filterType === filter.key && { backgroundColor: theme.primary + '15', borderColor: theme.primary }
                ]}
                onPress={() => {
                  setFilterType(filter.key as FilterType);
                  setShowFilterModal(false);
                }}
              >
                {filter.icon}
                <Text style={[
                  styles.filterOptionText, 
                  { color: filterType === filter.key ? theme.primary : theme.text }
                ]}>
                  {filter.label}
                </Text>
                {filterType === filter.key && (
                  <CheckCircle size={16} color={theme.primary} />
                )}
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={[styles.filterCloseButton, { backgroundColor: theme.textSecondary }]}
              onPress={() => setShowFilterModal(false)}
            >
              <Text style={styles.filterCloseButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Device Action Modal */}
      {selectedDevice && selectedActionType && selectedActionType !== 'hardban' && (
        <DeviceActionModal
          visible={showActionModal}
          onClose={() => setShowActionModal(false)}
          device={selectedDevice}
          userEmail={selectedUserEmail}
          adminEmail={adminEmail}
          adminName={adminName}
          initialActionType={selectedActionType}
          onActionComplete={handleDeviceActionComplete}
        />
      )}

      {/* Hard Ban Modal */}
      <Modal
        visible={showHardBanModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowHardBanModal(false)}
      >
        <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
          {/* Modal Header */}
          <View style={[styles.modalHeader, { borderBottomColor: theme.border, paddingTop: modalTopPadding }]}>
            <View style={styles.headerContent}>
              <Ban size={24} color={theme.error} />
              <Text style={[styles.modalTitle, { color: theme.text }]}>Hard Ban Device</Text>
            </View>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setShowHardBanModal(false)}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.modalContent}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingBottom: Platform.select({ web: 0, default: 20 }),
            }}
          >
            {/* Warning */}
            <View style={[styles.warningContainer, { backgroundColor: theme.error + '15', borderColor: theme.error }]}>
              <AlertTriangle size={20} color={theme.error} />
              <Text style={[styles.warningText, { color: theme.error }]}>
                Hard Ban Warning: This will permanently block this device from accessing the system based on its hardware fingerprint. The device will be blocked even if it tries to register again.
              </Text>
            </View>

            {/* Device Info */}
            {selectedDevice && (
              <View style={[styles.deviceInfoContainer, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <Text style={[styles.deviceInfoTitle, { color: theme.text }]}>Target Device</Text>
                <Text style={[styles.deviceInfoText, { color: theme.textSecondary }]}>
                  Device: {selectedDevice.deviceName || 'Unknown Device'}
                </Text>
                <Text style={[styles.deviceInfoText, { color: theme.textSecondary }]}>
                  User: {selectedUserEmail}
                </Text>
                <Text style={[styles.deviceInfoText, { color: theme.textSecondary }]}>
                  Type: {selectedDevice.deviceType || 'Unknown'}
                </Text>
                {selectedDevice.browserName && (
                  <Text style={[styles.deviceInfoText, { color: theme.textSecondary }]}>
                    Browser: {selectedDevice.browserName} {selectedDevice.browserVersion}
                  </Text>
                )}
                {selectedDevice.osName && (
                  <Text style={[styles.deviceInfoText, { color: theme.textSecondary }]}>
                    OS: {selectedDevice.osName} {selectedDevice.osVersion}
                  </Text>
                )}
              </View>
            )}

            {/* Ban Reason */}
            <Text style={[styles.formLabel, { color: theme.text }]}>Ban Reason *</Text>
            <TextInput
              style={[styles.textAreaInput, { 
                backgroundColor: theme.surface, 
                color: theme.text, 
                borderColor: theme.border 
              }]}
              placeholder="Enter detailed reason for hard ban..."
              placeholderTextColor={theme.textSecondary}
              value={hardBanReason}
              onChangeText={setHardBanReason}
              multiline
              numberOfLines={3}
            />

            {/* Expiration Options */}
            <View style={styles.expirationSection}>
              <TouchableOpacity
                style={styles.checkboxContainer}
                onPress={() => setHardBanExpirationEnabled(!hardBanExpirationEnabled)}
              >
                <View style={[
                  styles.checkbox,
                  { borderColor: theme.border },
                  hardBanExpirationEnabled && { backgroundColor: theme.primary, borderColor: theme.primary }
                ]}>
                  {hardBanExpirationEnabled && (
                    <CheckCircle size={16} color="white" />
                  )}
                </View>
                <Text style={[styles.checkboxLabel, { color: theme.text }]}>
                  Set expiration date (leave unchecked for permanent ban)
                </Text>
              </TouchableOpacity>

              {hardBanExpirationEnabled && (
                <View style={styles.dateOptionsContainer}>
                  <Text style={[styles.dateOptionsTitle, { color: theme.text }]}>Ban Duration:</Text>
                  <View style={styles.dateOptionsButtons}>
                    {[
                      { label: '1 Day', days: 1 },
                      { label: '1 Week', days: 7 },
                      { label: '1 Month', days: 30 },
                      { label: '6 Months', days: 180 },
                      { label: '1 Year', days: 365 }
                    ].map((option) => (
                      <TouchableOpacity
                        key={option.days}
                        style={[
                          styles.dateOptionButton,
                          { backgroundColor: theme.surface, borderColor: theme.border }
                        ]}
                        onPress={() => {
                          const expirationDate = new Date();
                          expirationDate.setDate(expirationDate.getDate() + option.days);
                          setHardBanExpiration(expirationDate);
                        }}
                      >
                        <Text style={[styles.dateOptionText, { color: theme.text }]}>
                          {option.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  
                  {hardBanExpiration && (
                    <View style={[styles.selectedDateContainer, { backgroundColor: theme.primary + '15', borderColor: theme.primary }]}>
                      <Clock size={16} color={theme.primary} />
                      <Text style={[styles.selectedDateText, { color: theme.primary }]}>
                        Ban expires: {hardBanExpiration.toLocaleDateString()} at {hardBanExpiration.toLocaleTimeString()}
                      </Text>
                    </View>
                  )}
                </View>
              )}
            </View>

            {/* Ban Button */}
            <TouchableOpacity
              style={[
                styles.hardBanButton,
                { 
                  backgroundColor: hardBanReason.trim() ? theme.error : theme.textSecondary,
                  opacity: loading ? 0.7 : 1
                }
              ]}
              onPress={handleHardBan}
              disabled={loading || !hardBanReason.trim()}
            >
              {loading ? (
                <ActivityIndicator size="small" color="white" />
              ) : (
                <Ban size={20} color="white" />
              )}
              <Text style={styles.hardBanButtonText}>
                {loading ? 'Banning Device...' : 'Hard Ban Device'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Device Details Modal - Web */}
      {selectedDevice && showDetailsModal && (
        (selectedDevice.deviceType === 'web' || selectedDevice.platformOS === 'web')
          ? (
            <BrowserDeviceModal
              visible={showDetailsModal}
              onClose={() => {
                setShowDetailsModal(false);
                setSelectedDevice(null);
                setSelectedUserEmail('');
              }}
              device={selectedDevice}
              userEmail={selectedUserEmail}
              adminEmail={adminEmail}
              adminName={adminName}
              onDeviceUpdate={handleDeviceActionComplete}
            />
          )
          : (
            <DeviceDetailsModal
              visible={showDetailsModal}
              onClose={() => {
                setShowDetailsModal(false);
                setSelectedDevice(null);
                setSelectedUserEmail('');
              }}
              device={selectedDevice}
              userEmail={selectedUserEmail}
              adminEmail={adminEmail}
              adminName={adminName}
              onDeviceUpdate={handleDeviceActionComplete}
            />
          )
      )}

      {/* Notification History Modal */}
      {showHistoryModal && (
        <AdminNotificationHistoryViewer
          adminEmail={adminEmail}
          onClose={() => setShowHistoryModal(false)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginTop: 16,
  },
  
  // Header
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  headerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  title: {
    fontSize: 24,
    fontFamily: 'Poppins-Bold',
    flexShrink: 1,
    minWidth: 0,
  },
  subtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginTop: 4,
    flexShrink: 1,
  },
  notifyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  notifyButtonText: {
    color: 'white',
    fontFamily: 'Inter-Medium',
    fontSize: 14,
  },

  // Search and Filters
  searchContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 12,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    // Reduce vertical padding on native to shrink height while keeping web unchanged
    paddingVertical: Platform.select({ web: 10, default: 6 }),
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    // Prevent overly tall boxes on native (leave web default)
    minHeight: Platform.select({ web: undefined as any, default: 34 }),
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    // Remove extra vertical padding on native TextInput which increases height
    paddingVertical: Platform.select({ web: undefined as any, default: 0 }),
    // Keep input from expanding height on native while preserving web
    minHeight: Platform.select({ web: undefined as any, default: 20 }),
    // Center text vertically on Android with reduced height
    textAlignVertical: Platform.select({ android: 'center', default: undefined as any }),
  },
  clearSearchButton: {
    padding: 4,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
  },
  filterButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },

  // Hide Inactive Toggle
  toggleContainer: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  toggleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 8,
  },
  toggleText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },

  // Selection Actions
  selectionActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderWidth: 1,
    marginHorizontal: 20,
    marginVertical: 8,
    borderRadius: 8,
  },
  selectionCount: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  selectionButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  selectionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    gap: 6,
  },
  selectionButtonText: {
    color: 'white',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },

  // Device List
  deviceList: {
    flex: 1,
  },
  deviceListContent: {
    padding: 20,
  },
  quickActions: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 16,
    gap: 12,
  },
  quickActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 6,
  },
  quickActionText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },

  // Device Cards
  deviceCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
  },
  deviceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  deviceMainInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 12,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  deviceUser: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  deviceStatus: {
    alignItems: 'flex-end',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  statusText: {
    color: 'white',
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  deviceDetails: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  deviceMetadata: {
    flex: 1,
  },
  metadataRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  metadataLabel: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    flex: 1,
  },
  metadataValue: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    flex: 2,
    textAlign: 'right',
  },
  deviceActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  selectionIndicator: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deletionInfo: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(239, 68, 68, 0.2)',
  },
  deletionText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginBottom: 2,
  },
  deletionReason: {
    fontSize: 11,
    fontFamily: 'Inter-Regular',
  },

  // Empty State
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    textAlign: 'center',
  },

  // Modal Styles
  modalContainer: {
    flex: 1,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 20,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'Poppins-SemiBold',
  },
  closeButton: {
    padding: 4,
  },
  modalContent: {
    flex: 1,
    padding: 20,
  },
  errorContainer: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorTitle: {
    fontFamily: 'Inter-SemiBold',
    fontSize: 14,
    marginBottom: 6,
  },
  errorMessage: {
    fontFamily: 'Inter-Regular',
    fontSize: 12,
    marginBottom: 2,
  },
  recipientsSummary: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 20,
  },
  recipientsTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  recipientsCount: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  formLabel: {
    fontSize: 16,
    fontFamily: 'Inter-Medium',
    marginBottom: 8,
    marginTop: 16,
  },
  typeContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  typeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    gap: 6,
  },
  typeButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
  },
  textAreaInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    minHeight: 100,
    textAlignVertical: 'top',
  },
  sendButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 8,
    marginTop: 24,
    gap: 8,
  },
  sendButtonText: {
    color: 'white',
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },

  // Filter Modal
  filterModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterModalContent: {
    width: '80%',
    maxWidth: 300,
    borderRadius: 12,
    padding: 20,
  },
  filterModalTitle: {
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 16,
    textAlign: 'center',
  },
  filterOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
    gap: 12,
  },
  filterOptionText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  filterCloseButton: {
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  filterCloseButtonText: {
    color: 'white',
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },

  // Quick Selection Styles
  quickSelectionContainer: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 20,
  },
  quickSelectionTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 12,
  },
  quickSelectionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  quickSelectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  quickSelectText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },

  // User Grouping Styles
  userGroup: {
    marginBottom: 16,
  },
  userHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  userInfo: {
    flex: 1,
  },
  userEmail: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 2,
  },
  userStats: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
  },
  selectUserButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  selectUserText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },

  // Header Actions
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: 6,
  },

  // Hard Ban Modal Styles
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  warningContainer: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 20,
    gap: 12,
  },
  warningText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    lineHeight: 20,
  },
  deviceInfoContainer: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 20,
  },
  deviceInfoTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 8,
  },
  deviceInfoText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginBottom: 4,
  },
  expirationSection: {
    marginTop: 20,
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  datePickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    marginTop: 8,
  },
  datePickerText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  hardBanButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 8,
    marginTop: 24,
    gap: 8,
  },
  hardBanButtonText: {
    color: 'white',
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
  },
  dateOptionsContainer: {
    marginTop: 12,
  },
  dateOptionsTitle: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    marginBottom: 8,
  },
  dateOptionsButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  dateOptionButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  dateOptionText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
  },
  selectedDateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    gap: 8,
    marginTop: 8,
  },
  selectedDateText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  headerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginRight: 0,
  },
  headerButtonText: {
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 6,
  },
});
