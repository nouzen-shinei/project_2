import { logger } from '@/lib/logger';
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, ScrollView, FlatList, TouchableOpacity, StyleSheet, Modal, TextInput, ActivityIndicator, Platform } from 'react-native';
import { 
  Clock, 
  Users, 
  Smartphone, 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  Info, 
  Bell,
  Search,
  RefreshCw,
  Calendar,
  Filter,
  Download,
  Eye,
  X
} from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import { useAdminNotificationHistory } from '../hooks/useAdminNotificationHistory';
import { useTenant } from '@/hooks/useTenantContext';
import { AdminNotificationHistoryEntry } from '../services/adminNotificationHistoryService';
import { describeDeviceFailureReason } from '@/lib/notificationFailureReasons';
import Toast from 'react-native-toast-message';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

interface AdminNotificationHistoryViewerProps {
  adminEmail?: string;
  onClose: () => void;
}

type SortOption = 'date_desc' | 'date_asc' | 'success_desc' | 'success_asc' | 'priority_desc';
type SuccessFilterOption = 'all' | 'successful' | 'failed';
type DateRangeOption = 'all' | '24h' | '7d' | '30d';

const SORT_OPTIONS: readonly { value: SortOption; label: string }[] = [
  { value: 'date_desc', label: 'Newest first' },
  { value: 'date_asc', label: 'Oldest first' },
  { value: 'success_desc', label: 'Highest success rate' },
  { value: 'success_asc', label: 'Lowest success rate' },
  { value: 'priority_desc', label: 'Priority (High → Low)' }
];

const SUCCESS_FILTER_OPTIONS: readonly { value: SuccessFilterOption; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'successful', label: 'Successful (≥80%)' },
  { value: 'failed', label: 'Needs attention (<80%)' }
];

const DATE_RANGE_OPTIONS: readonly { value: DateRangeOption; label: string }[] = [
  { value: 'all', label: 'Any time' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' }
];

const NOTIFICATION_TYPE_OPTIONS: readonly { value: AdminNotificationHistoryEntry['type']; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'success', label: 'Success' },
  { value: 'error', label: 'Error' },
  { value: 'announcement', label: 'Announcement' }
];

const PRIORITY_OPTIONS: readonly { value: AdminNotificationHistoryEntry['priority']; label: string }[] = [
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' }
];

const DELIVERY_METHOD_OPTIONS: readonly { value: AdminNotificationHistoryEntry['deliveryMethod']; label: string }[] = [
  { value: 'mixed', label: 'Web + Mobile' },
  { value: 'web_browser', label: 'Web Browser' },
  { value: 'expo_push', label: 'Mobile Push' },
  { value: 'realtime_database', label: 'Realtime DB' }
];

const DELIVERY_METHOD_LABELS: Record<AdminNotificationHistoryEntry['deliveryMethod'], string> = {
  mixed: 'Web + Mobile',
  web_browser: 'Web Browser',
  expo_push: 'Mobile Push',
  realtime_database: 'Realtime DB'
};

const PRIORITY_WEIGHT: Record<AdminNotificationHistoryEntry['priority'], number> = {
  high: 3,
  normal: 2,
  low: 1
};

const sanitizeFileSegment = (value?: string | null) => {
  if (!value) return null;
  const normalized = value.toString().trim().toLowerCase();
  if (!normalized) return null;
  return normalized.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
};

const buildNotificationExportFileName = (tenantHint?: string | null) => {
  const segment = sanitizeFileSegment(tenantHint) ?? 'tenant';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${segment}-notification-history-${timestamp}.csv`;
};

export default function AdminNotificationHistoryViewer({ 
  adminEmail, 
  onClose 
}: AdminNotificationHistoryViewerProps) {
  const { theme } = useTheme();
  const { activeTenant } = useTenant();
  const tenantId = activeTenant?.id;
  const {
    history,
    loading,
    loadingMore,
    error,
    hasMore,
    loadHistory,
    loadMoreHistory,
    searchNotificationsRealtime,
    refresh
  } = useAdminNotificationHistory(tenantId);

  // Local state
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [selectedNotification, setSelectedNotification] = useState<AdminNotificationHistoryEntry | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [showSearchBox, setShowSearchBox] = useState(false);
  const [searchResults, setSearchResults] = useState<AdminNotificationHistoryEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<AdminNotificationHistoryEntry['type'][]>([]);
  const [selectedPriorities, setSelectedPriorities] = useState<AdminNotificationHistoryEntry['priority'][]>([]);
  const [selectedDeliveryMethods, setSelectedDeliveryMethods] = useState<AdminNotificationHistoryEntry['deliveryMethod'][]>([]);
  const [successFilter, setSuccessFilter] = useState<SuccessFilterOption>('all');
  const [dateRangeFilter, setDateRangeFilter] = useState<DateRangeOption>('all');
  const [sortOption, setSortOption] = useState<SortOption>('date_desc');
  const [autoFetchingMore, setAutoFetchingMore] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const toggleTypeFilter = useCallback((type: AdminNotificationHistoryEntry['type']) => {
    setSelectedTypes(prev => prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]);
  }, []);

  const togglePriorityFilter = useCallback((priority: AdminNotificationHistoryEntry['priority']) => {
    setSelectedPriorities(prev => prev.includes(priority) ? prev.filter(p => p !== priority) : [...prev, priority]);
  }, []);

  const toggleDeliveryMethodFilter = useCallback((method: AdminNotificationHistoryEntry['deliveryMethod']) => {
    setSelectedDeliveryMethods(prev => prev.includes(method) ? prev.filter(m => m !== method) : [...prev, method]);
  }, []);

  const handleClearFilters = useCallback(() => {
    setSelectedTypes([]);
    setSelectedPriorities([]);
    setSelectedDeliveryMethods([]);
    setSuccessFilter('all');
    setDateRangeFilter('all');
  }, []);

  const filtersApplied = useMemo(() => (
    selectedTypes.length > 0 ||
    selectedPriorities.length > 0 ||
    selectedDeliveryMethods.length > 0 ||
    successFilter !== 'all' ||
    dateRangeFilter !== 'all'
  ), [selectedTypes, selectedPriorities, selectedDeliveryMethods, successFilter, dateRangeFilter]);

  // Normalize timestamp for reuse across filters and formatting
  const parseTimestamp = useCallback((timestamp: any): { date: Date | null; error?: string } => {
    try {
      let date: Date | null = null;

      if (!timestamp) {
        return { date: null, error: 'No Date' };
      }

      if (timestamp?.toDate && typeof timestamp.toDate === 'function') {
        try {
          const convertedDate = timestamp.toDate();
          if (isNaN(convertedDate.getTime())) {
            logger.warn('Invalid date from toDate():', timestamp);
            return { date: null, error: 'Invalid Timestamp' };
          }
          date = convertedDate;
        } catch (error) {
          logger.warn('Error calling toDate():', error, timestamp);
          return { date: null, error: 'Invalid Timestamp' };
        }
      } else if (timestamp?.seconds !== undefined && typeof timestamp.seconds === 'number') {
        const seconds = timestamp.seconds;
        const nanoseconds = timestamp.nanoseconds || 0;

        if (isNaN(seconds) || isNaN(nanoseconds)) {
          logger.warn('NaN values in timestamp:', { seconds, nanoseconds }, timestamp);
          return { date: null, error: 'Invalid Timestamp' };
        }

        const milliseconds = seconds * 1000 + nanoseconds / 1000000;

        if (isNaN(milliseconds) || !isFinite(milliseconds)) {
          logger.warn('Invalid milliseconds calculated:', milliseconds, 'from', { seconds, nanoseconds });
          return { date: null, error: 'Invalid Timestamp' };
        }

        date = new Date(milliseconds);
      } else if (typeof timestamp === 'string') {
        date = new Date(timestamp);
      } else if (timestamp instanceof Date) {
        date = timestamp;
      } else if (typeof timestamp === 'number') {
        if (isNaN(timestamp) || !isFinite(timestamp)) {
          logger.warn('Invalid timestamp number:', timestamp);
          return { date: null, error: 'Invalid Timestamp' };
        }
        date = new Date(timestamp);
      } else {
        logger.warn('Unknown timestamp format:', timestamp);
        return { date: null, error: 'Unknown Format' };
      }

      if (!date || isNaN(date.getTime())) {
        logger.warn('Invalid date result:', date, 'from timestamp:', timestamp);
        return { date: null, error: 'Invalid Date' };
      }

      return { date };
    } catch (error) {
      logger.error('Date parsing error:', error, 'Timestamp:', timestamp);
      return { date: null, error: 'Date Error' };
    }
  }, []);

  // Format date for display
  const formatDate = useCallback((timestamp: any) => {
    const { date, error } = parseTimestamp(timestamp);
    if (!date) {
      return error || 'Date Error';
    }

    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }, [parseTimestamp]);

  const getDeliveryMethodLabel = useCallback((method: AdminNotificationHistoryEntry['deliveryMethod']) => {
    return DELIVERY_METHOD_LABELS[method] || method;
  }, []);

  // Get notification type icon
  const getNotificationTypeIcon = useCallback((type: string) => {
    switch (type) {
      case 'warning':
        return <AlertTriangle size={18} color={theme.warning} />;
      case 'success':
        return <CheckCircle size={18} color={theme.success} />;
      case 'error':
        return <XCircle size={18} color={theme.error} />;
      case 'announcement':
        return <Bell size={18} color={theme.primary} />;
      default:
        return <Info size={18} color={theme.primary} />;
    }
  }, [theme]);

  // Get priority color
  const getPriorityColor = useCallback((priority: string) => {
    switch (priority) {
      case 'high':
        return theme.error;
      case 'normal':
        return theme.warning;
      case 'low':
        return theme.textSecondary;
      default:
        return theme.textSecondary;
    }
  }, [theme]);

  // Calculate success rate
  const getSuccessRate = useCallback((notification: AdminNotificationHistoryEntry) => {
    if (notification.totalTargets === 0) return 0;
    return Math.round((notification.successfulDeliveries / notification.totalTargets) * 100);
  }, []);

  // Handle real-time search
  const handleSearchTermChange = useCallback(async (term: string) => {
    setSearchTerm(term);
    
    if (!term.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    try {
      setIsSearching(true);
      const results = await searchNotificationsRealtime(term); // Remove adminEmail to search all notifications
      setSearchResults(results);
    } catch (error) {
      logger.error('Search error:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [searchNotificationsRealtime]);

  // Clear search
  const handleClearSearch = useCallback(() => {
    setSearchTerm('');
    setSearchResults([]);
    setIsSearching(false);
    setShowSearchBox(false);
  }, []);

  // Handle refresh all data
  const handleRefresh = useCallback(async () => {
    try {
      setIsRefreshing(true);
      await refresh(); // Remove adminEmail to load all notifications
      Toast.show({
        type: 'success',
        text1: 'Data Refreshed',
        text2: 'Notification history updated'
      });
    } catch (error) {
      logger.error('Refresh error:', error);
      Toast.show({
        type: 'error',
        text1: 'Refresh Failed',
        text2: 'Failed to refresh data'
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [refresh]);

  const handleLoadMore = useCallback(() => {
    if (searchTerm.length > 0) {
      return;
    }

    if (hasMore && !loadingMore && !loading) {
      loadMoreHistory();
    }
  }, [hasMore, loadingMore, loading, loadMoreHistory, searchTerm.length]);

  const filteredNotifications = useMemo(() => {
    const baseList = searchTerm.length > 0 ? searchResults : history;
    const now = new Date();
    const cutoff = (() => {
      switch (dateRangeFilter) {
        case '24h':
          return now.getTime() - 24 * 60 * 60 * 1000;
        case '7d':
          return now.getTime() - 7 * 24 * 60 * 60 * 1000;
        case '30d':
          return now.getTime() - 30 * 24 * 60 * 60 * 1000;
        default:
          return null;
      }
    })();

    const filtered = baseList.filter(notification => {
      if (selectedTypes.length > 0 && !selectedTypes.includes(notification.type)) {
        return false;
      }

      if (selectedPriorities.length > 0 && !selectedPriorities.includes(notification.priority)) {
        return false;
      }

      if (selectedDeliveryMethods.length > 0 && !selectedDeliveryMethods.includes(notification.deliveryMethod)) {
        return false;
      }

      const successRate = getSuccessRate(notification);
      if (successFilter === 'successful' && successRate < 80) {
        return false;
      }

      if (successFilter === 'failed' && successRate >= 80) {
        return false;
      }

      if (cutoff !== null) {
        const { date } = parseTimestamp(notification.sentAt);
        if (!date) {
          return false;
        }

        if (date.getTime() < cutoff) {
          return false;
        }
      }

      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      const dateA = parseTimestamp(a.sentAt).date?.getTime() ?? 0;
      const dateB = parseTimestamp(b.sentAt).date?.getTime() ?? 0;

      switch (sortOption) {
        case 'date_asc':
          return dateA - dateB;
        case 'success_desc':
          return getSuccessRate(b) - getSuccessRate(a) || dateB - dateA;
        case 'success_asc':
          return getSuccessRate(a) - getSuccessRate(b) || dateA - dateB;
        case 'priority_desc': {
          const priorityComparison = (PRIORITY_WEIGHT[b.priority] || 0) - (PRIORITY_WEIGHT[a.priority] || 0);
          if (priorityComparison !== 0) {
            return priorityComparison;
          }
          return dateB - dateA;
        }
        default:
          return dateB - dateA;
      }
    });

    return sorted;
  }, [
    history,
    searchResults,
    searchTerm,
    selectedTypes,
    selectedPriorities,
    selectedDeliveryMethods,
    successFilter,
    dateRangeFilter,
    sortOption,
    getSuccessRate,
    parseTimestamp
  ]);

  const sortOptionLabel = useMemo(() => {
    const entry = SORT_OPTIONS.find(option => option.value === sortOption);
    return entry ? entry.label : SORT_OPTIONS[0].label;
  }, [sortOption]);

  const activeFilterLabels = useMemo(() => {
    const labels: string[] = [];

    selectedTypes.forEach(type => {
      const label = NOTIFICATION_TYPE_OPTIONS.find(option => option.value === type)?.label || type;
      labels.push(`Type: ${label}`);
    });

    selectedPriorities.forEach(priority => {
      const label = PRIORITY_OPTIONS.find(option => option.value === priority)?.label || priority;
      labels.push(`Priority: ${label}`);
    });

    selectedDeliveryMethods.forEach(method => {
      const label = DELIVERY_METHOD_LABELS[method] || method;
      labels.push(`Method: ${label}`);
    });

    if (successFilter !== 'all') {
      const label = SUCCESS_FILTER_OPTIONS.find(option => option.value === successFilter)?.label || successFilter;
      labels.push(label);
    }

    if (dateRangeFilter !== 'all') {
      const label = DATE_RANGE_OPTIONS.find(option => option.value === dateRangeFilter)?.label || dateRangeFilter;
      labels.push(label);
    }

    return labels;
  }, [
    selectedTypes,
    selectedPriorities,
    selectedDeliveryMethods,
    successFilter,
    dateRangeFilter
  ]);

  useEffect(() => {
    if (!filtersApplied || searchTerm.length > 0) {
      setAutoFetchingMore(false);
      return;
    }

    if (
      filteredNotifications.length > 0 ||
      !hasMore ||
      loading ||
      loadingMore ||
      autoFetchingMore
    ) {
      setAutoFetchingMore(false);
      return;
    }

    setAutoFetchingMore(true);
    loadMoreHistory().finally(() => setAutoFetchingMore(false));
  }, [
    filtersApplied,
    filteredNotifications.length,
    hasMore,
    loading,
    loadingMore,
    loadMoreHistory,
    searchTerm,
    autoFetchingMore
  ]);

  const handleExportCsv = useCallback(async () => {
    if (!filteredNotifications.length) {
      Toast.show({
        type: 'info',
        text1: 'No notifications to export',
        text2: 'Adjust your filters or load more history first.',
      });
      return;
    }

    try {
      setIsExporting(true);
      const tenantHint = activeTenant?.slug ?? activeTenant?.code ?? activeTenant?.name ?? tenantId ?? undefined;
      const fileName = buildNotificationExportFileName(tenantHint);
      const rows: string[][] = [
        ['Tenant Name', activeTenant?.name ?? 'Unknown coaching center'],
        ['Tenant ID', tenantId ?? '—'],
        ['Exported At', new Date().toISOString()],
        ['Record Count', String(filteredNotifications.length)],
        ['Search Term', searchTerm || '—'],
        ['Filters Applied', filtersApplied ? (activeFilterLabels.join(' | ') || 'Custom filters applied') : 'None'],
        []
      ];
      rows.push([
        'Sent At',
        'Title',
        'Body',
        'Type',
        'Priority',
        'Delivery Method',
        'Target Users',
        'Target Devices',
        'Total Targets',
        'Successful',
        'Failed',
        'Success %',
        'Failure Reasons'
      ]);

      const formatFailureSummary = (notification: AdminNotificationHistoryEntry) => {
        if (!notification.failureReasonSummary) return '';
        return Object.entries(notification.failureReasonSummary)
          .filter(([, count]) => count > 0)
          .map(([reasonKey, count]) => `${count}× ${describeDeviceFailureReason(reasonKey) ?? reasonKey}`)
          .join(' | ');
      };

      const csvEscape = (value: string | number | null | undefined) => {
        if (value == null) {
          return '""';
        }
        const text = String(value).replace(/"/g, '""');
        return `"${text}"`;
      };

      filteredNotifications.forEach((notification) => {
        rows.push([
          formatDate(notification.sentAt),
          notification.title ?? '',
          (notification.body ?? '').replace(/\s+/g, ' ').trim(),
          notification.type,
          notification.priority,
          getDeliveryMethodLabel(notification.deliveryMethod),
          notification.targetUsers.join(', '),
          notification.targetDevices.join(', '),
          String(notification.totalTargets),
          String(notification.successfulDeliveries),
          String(notification.failedDeliveries),
          `${getSuccessRate(notification)}%`,
          formatFailureSummary(notification)
        ]);
      });

      const csvContent = rows.map((row) => row.map(csvEscape).join(',')).join('\n');

      if (Platform.OS === 'web') {
        const browserGlobal = globalThis as typeof globalThis & { URL?: typeof URL; document?: any };
        const browserDocument = browserGlobal.document as any;
        const browserUrlApi = browserGlobal.URL;
        if (!browserDocument || !browserUrlApi || !browserDocument.body) {
          throw new Error('Browser download APIs unavailable');
        }
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = browserUrlApi.createObjectURL(blob);
        const link = browserDocument.createElement('a');
        link.href = url;
        link.download = fileName;
        browserDocument.body.appendChild(link);
        link.click();
        browserDocument.body.removeChild(link);
        browserUrlApi.revokeObjectURL(url);
        Toast.show({
          type: 'success',
          text1: 'Export ready',
          text2: `Saved as ${fileName}`,
        });
      } else {
        const fileUri = `${FileSystem.documentDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(fileUri, csvContent, { encoding: FileSystem.EncodingType.UTF8 });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(fileUri, {
            mimeType: 'text/csv',
            dialogTitle: 'Share notification history CSV',
          });
        }
        Toast.show({
          type: 'success',
          text1: 'Export ready',
          text2: 'Notification history CSV generated',
        });
      }
    } catch (exportError) {
      console.error('CSV export failed', exportError);
      Toast.show({
        type: 'error',
        text1: 'Export failed',
        text2: 'Unable to generate CSV. Please try again.',
      });
    } finally {
      setIsExporting(false);
    }
  }, [
    filteredNotifications,
    activeTenant,
    tenantId,
    searchTerm,
    filtersApplied,
    activeFilterLabels,
    formatDate,
    getDeliveryMethodLabel,
    getSuccessRate
  ]);

  // Render notification item
  const renderNotificationItem = useCallback((notification: AdminNotificationHistoryEntry) => {
    const successRate = getSuccessRate(notification);
    const isSuccessful = successRate >= 80;

    return (
      <TouchableOpacity 
        style={[styles.notificationItem, { 
          backgroundColor: theme.surface, 
          borderColor: theme.border,
          borderLeftColor: isSuccessful ? theme.success : theme.error,
          borderLeftWidth: 4
        }]}
        onPress={() => {
          setSelectedNotification(notification);
          setShowDetailModal(true);
        }}
      >
        <View style={styles.notificationHeader}>
          <View style={styles.notificationTypeContainer}>
            {getNotificationTypeIcon(notification.type)}
            <Text style={[styles.notificationTitle, { color: theme.text }]} numberOfLines={1}>
              {notification.title}
            </Text>
          </View>
          
          <View style={styles.priorityContainer}>
            <View style={[styles.priorityDot, { backgroundColor: getPriorityColor(notification.priority) }]} />
            <Text style={[styles.priorityText, { color: theme.textSecondary }]}>
              {notification.priority.toUpperCase()}
            </Text>
          </View>
        </View>

        <Text style={[styles.notificationBody, { color: theme.textSecondary }]} numberOfLines={2}>
          {notification.body}
        </Text>

        <View style={styles.notificationMeta}>
          <View style={styles.metaItem}>
            <Users size={14} color={theme.textSecondary} />
            <Text style={[styles.metaText, { color: theme.textSecondary }]}>
              {notification.targetUsers.length} user{notification.targetUsers.length !== 1 ? 's' : ''}
            </Text>
          </View>

          <View style={styles.metaItem}>
            <Smartphone size={14} color={theme.textSecondary} />
            <Text style={[styles.metaText, { color: theme.textSecondary }]}>
              {notification.targetDevices.length} device{notification.targetDevices.length !== 1 ? 's' : ''}
            </Text>
          </View>

          <View style={styles.metaItem}>
            {isSuccessful ? (
              <CheckCircle size={14} color={theme.success} />
            ) : (
              <XCircle size={14} color={theme.error} />
            )}
            <Text style={[styles.metaText, { color: isSuccessful ? theme.success : theme.error }]}>
              {successRate}% delivered
            </Text>
          </View>

          <View style={styles.metaItem}>
            <Clock size={14} color={theme.textSecondary} />
            <Text style={[styles.metaText, { color: theme.textSecondary }]}>
              {formatDate(notification.sentAt)}
            </Text>
          </View>
        </View>

        {notification.failureReasonSummary && (
          <View style={styles.failureSummaryRow}>
            {Object.entries(notification.failureReasonSummary)
              .filter(([, count]) => count > 0)
              .slice(0, 3)
              .map(([reasonKey, count]) => (
                <View key={reasonKey} style={[styles.failureBadge, { backgroundColor: `${theme.warning}20`, borderColor: theme.warning }] }>
                  <Text style={[styles.failureBadgeText, { color: theme.warning }]}>
                    {count}× {describeDeviceFailureReason(reasonKey) ?? 'Delivery failed.'}
                  </Text>
                </View>
              ))}
          </View>
        )}

        {/* Additional notification details */}
        <View style={styles.notificationDetails}>
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>Method:</Text>
            <Text style={[styles.detailValue, { color: theme.text }]}>
              {getDeliveryMethodLabel(notification.deliveryMethod)}
            </Text>
          </View>
          
          {notification.onlineOnly && (
            <View style={styles.detailRow}>
              <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>Mode:</Text>
              <Text style={[styles.detailValue, { color: theme.warning }]}>Online Only</Text>
            </View>
          )}
          
          <View style={styles.detailRow}>
            <Text style={[styles.detailLabel, { color: theme.textSecondary }]}>Targets:</Text>
            <Text style={[styles.detailValue, { color: theme.text }]} numberOfLines={1}>
              {notification.targetUsers.slice(0, 2).join(', ')}
              {notification.targetUsers.length > 2 ? ` +${notification.targetUsers.length - 2} more` : ''}
            </Text>
          </View>
        </View>

        <View style={styles.notificationFooter}>
          <Text style={[styles.adminInfo, { color: theme.textSecondary }]}>
            Sent by {notification.adminName}
          </Text>
          
          <View style={styles.deliveryStats}>
            <Text style={[styles.deliveryText, { color: theme.success }]}>
              ✓ {notification.successfulDeliveries}
            </Text>
            {notification.failedDeliveries > 0 && (
              <Text style={[styles.deliveryText, { color: theme.error }]}>
                ✗ {notification.failedDeliveries}
              </Text>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [theme, formatDate, getNotificationTypeIcon, getPriorityColor, getSuccessRate, getDeliveryMethodLabel]);

  if (!tenantId) {
    return (
      <View style={[styles.emptyTenantState, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.emptyTenantTitle, { color: theme.text }]}>Select a coaching center</Text>
        <Text style={[styles.emptyTenantSubtitle, { color: theme.textSecondary }]}>Choose a workspace to view its notification history.</Text>
        <TouchableOpacity onPress={onClose} style={[styles.emptyTenantButton, { borderColor: theme.border }]}>
          <Text style={{ color: theme.text }}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <Modal
      visible={true}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.border }]}>
          <View style={styles.headerLeft}>
            <Clock size={24} color={theme.primary} />
            <Text style={[styles.headerTitle, { color: theme.text }]}>
              Notification History
            </Text>
          </View>
          
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={[styles.headerButton, { backgroundColor: theme.surface }]}
              onPress={() => setShowSearchBox(!showSearchBox)}
              disabled={isSearching}
            >
              <Search size={20} color={isSearching ? theme.textSecondary : theme.primary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.headerButton,
                {
                  backgroundColor: filtersApplied ? theme.primary : theme.surface
                }
              ]}
              onPress={() => setShowFilterModal(true)}
            >
              <Filter size={20} color={filtersApplied ? theme.background : theme.primary} />
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.headerButton,
                {
                  backgroundColor: theme.surface,
                  opacity: isExporting || filteredNotifications.length === 0 ? 0.5 : 1
                }
              ]}
              onPress={handleExportCsv}
              disabled={isExporting || filteredNotifications.length === 0}
            >
              {isExporting ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Download size={20} color={theme.primary} />
              )}
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.headerButton, { backgroundColor: theme.surface }]}
              onPress={handleRefresh}
              disabled={isRefreshing || loading}
            >
              <RefreshCw 
                size={20} 
                color={isRefreshing ? theme.textSecondary : theme.primary} 
                style={isRefreshing ? { transform: [{ rotate: '180deg' }] } : undefined}
              />
            </TouchableOpacity>
            
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
            >
              <X size={24} color={theme.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Search Box */}
        {showSearchBox && (
          <View style={[styles.searchContainer, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
            <View style={styles.searchInputContainer}>
              <Search size={16} color={theme.textSecondary} style={styles.searchIcon} />
              <TextInput
                style={[styles.inlineSearchInput, { 
                  backgroundColor: theme.background, 
                  borderColor: theme.border,
                  color: theme.text
                }]}
                placeholder="Search by title, email, device name, admin, type..."
                placeholderTextColor={theme.textSecondary}
                value={searchTerm}
                onChangeText={handleSearchTermChange}
                autoFocus={true}
              />
              {searchTerm.length > 0 && (
                <TouchableOpacity
                  style={styles.clearSearchButton}
                  onPress={handleClearSearch}
                >
                  <X size={16} color={theme.textSecondary} />
                </TouchableOpacity>
              )}
            </View>
            
            {/* Search Results Info */}
            {searchTerm.length > 0 && (
              <View style={styles.searchResultsInfo}>
                <Text style={[styles.searchResultsText, { color: theme.textSecondary }]}>
                  {isSearching ? 'Searching...' : `${filteredNotifications.length} result${filteredNotifications.length !== 1 ? 's' : ''} shown`}
                </Text>
              </View>
            )}
          </View>
        )}

        <View style={[styles.sortPanel, { borderBottomColor: theme.border }]}>
          <Text style={[styles.sortInfoText, { color: theme.textSecondary }]}>
            Sorted by {sortOptionLabel}
          </Text>

          {filtersApplied && activeFilterLabels.length > 0 && (
            <View style={styles.activeFiltersWrapper}>
              <View style={styles.activeFiltersChips}>
                {activeFilterLabels.map(label => (
                  <View
                    key={label}
                    style={[styles.activeFilterChip, { backgroundColor: theme.surface, borderColor: theme.border }]}
                  >
                    <Text style={[styles.activeFilterChipText, { color: theme.textSecondary }]}>{label}</Text>
                  </View>
                ))}
              </View>

              <TouchableOpacity
                style={[styles.clearFiltersButton, { borderColor: theme.border }]}
                onPress={handleClearFilters}
              >
                <Text style={[styles.clearFiltersButtonText, { color: theme.primary }]}>Clear filters</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Content */}
        {(loading && history.length === 0 && searchResults.length === 0) || isRefreshing ? (
          <View style={styles.centerContainer}>
            <RefreshCw size={48} color={theme.primary} style={{ marginBottom: 16 }} />
            <Text style={[styles.loadingText, { color: theme.textSecondary }]}> 
              {isRefreshing ? 'Refreshing notification history...' : 'Loading notification history...'}
            </Text>
          </View>
        ) : error ? (
          <View style={styles.centerContainer}>
            <XCircle size={48} color={theme.error} />
            <Text style={[styles.errorText, { color: theme.error }]}> 
              {error}
            </Text>
            <TouchableOpacity
              style={[styles.retryButton, { backgroundColor: theme.primary }]}
              onPress={handleRefresh}
            >
              <Text style={styles.retryButtonText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : filteredNotifications.length === 0 ? (
          <View style={styles.centerContainer}>
            <Bell size={48} color={theme.textSecondary} />
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}> 
              {searchTerm.length > 0
                ? 'No search results found'
                : filtersApplied
                  ? 'No notifications match the current filters'
                  : 'No notification history found'}
            </Text>
          </View>
        ) : (
          <FlatList
            style={styles.content}
            contentContainerStyle={styles.listContentContainer}
            data={filteredNotifications}
            renderItem={({ item }) => renderNotificationItem(item)}
            keyExtractor={(item, index) => item.id ?? `notification-${index}`}
            showsVerticalScrollIndicator={false}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.5}
            initialNumToRender={10}
            maxToRenderPerBatch={10}
            windowSize={7}
            ListFooterComponent={
              <View style={styles.listFooter}>
                {loadingMore ? (
                  <ActivityIndicator color={theme.primary} />
                ) : hasMore && searchTerm.length === 0 ? (
                  <TouchableOpacity
                    style={[styles.listFooterButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
                    onPress={handleLoadMore}
                  >
                    <Text style={[styles.listFooterButtonText, { color: theme.primary }]}>Load more</Text>
                  </TouchableOpacity>
                ) : filteredNotifications.length > 0 ? (
                  <Text style={[styles.listFooterText, { color: theme.textSecondary }]}>No more notifications</Text>
                ) : null}
              </View>
            }
          />
        )}

        {showFilterModal && (
          <Modal
            visible={showFilterModal}
            animationType="slide"
            transparent={true}
            onRequestClose={() => setShowFilterModal(false)}
          >
            <View style={styles.filterModalOverlay}>
              <View style={[styles.filterModalContent, { backgroundColor: theme.surface }]}>
                <View style={[styles.filterModalHeader, { borderBottomColor: theme.border }]}> 
                  <Text style={[styles.filterModalTitle, { color: theme.text }]}>
                    Sort & Filter
                  </Text>
                  <TouchableOpacity
                    style={styles.filterModalCloseButton}
                    onPress={() => setShowFilterModal(false)}
                  >
                    <X size={20} color={theme.textSecondary} />
                  </TouchableOpacity>
                </View>

                <ScrollView
                  style={styles.filterModalBody}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{
                    paddingBottom: Platform.select({ web: 0, default: 10 }),
                  }}
                >
                  <View style={styles.filterSection}>
                    <Text style={[styles.filterSectionTitle, { color: theme.text }]}>Sort By</Text>
                    <View style={styles.filterChipGroup}>
                      {SORT_OPTIONS.map(option => {
                        const isActive = sortOption === option.value;
                        return (
                          <TouchableOpacity
                            key={option.value}
                            style={[
                              styles.filterChip,
                              {
                                backgroundColor: isActive ? theme.primary : theme.surface,
                                borderColor: isActive ? theme.primary : theme.border
                              }
                            ]}
                            onPress={() => setSortOption(option.value)}
                          >
                            <Text
                              style={[
                                styles.filterChipText,
                                { color: isActive ? theme.background : theme.text }
                              ]}
                            >
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.filterSection}>
                    <Text style={[styles.filterSectionTitle, { color: theme.text }]}>Notification Type</Text>
                    <View style={styles.filterChipGroup}>
                      {NOTIFICATION_TYPE_OPTIONS.map(option => {
                        const isActive = selectedTypes.includes(option.value);
                        return (
                          <TouchableOpacity
                            key={option.value}
                            style={[
                              styles.filterChip,
                              {
                                backgroundColor: isActive ? theme.primary : theme.surface,
                                borderColor: isActive ? theme.primary : theme.border
                              }
                            ]}
                            onPress={() => toggleTypeFilter(option.value)}
                          >
                            <Text
                              style={[
                                styles.filterChipText,
                                { color: isActive ? theme.background : theme.text }
                              ]}
                            >
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.filterSection}>
                    <Text style={[styles.filterSectionTitle, { color: theme.text }]}>Priority</Text>
                    <View style={styles.filterChipGroup}>
                      {PRIORITY_OPTIONS.map(option => {
                        const isActive = selectedPriorities.includes(option.value);
                        return (
                          <TouchableOpacity
                            key={option.value}
                            style={[
                              styles.filterChip,
                              {
                                backgroundColor: isActive ? theme.primary : theme.surface,
                                borderColor: isActive ? theme.primary : theme.border
                              }
                            ]}
                            onPress={() => togglePriorityFilter(option.value)}
                          >
                            <Text
                              style={[
                                styles.filterChipText,
                                { color: isActive ? theme.background : theme.text }
                              ]}
                            >
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.filterSection}>
                    <Text style={[styles.filterSectionTitle, { color: theme.text }]}>Delivery Method</Text>
                    <View style={styles.filterChipGroup}>
                      {DELIVERY_METHOD_OPTIONS.map(option => {
                        const isActive = selectedDeliveryMethods.includes(option.value);
                        return (
                          <TouchableOpacity
                            key={option.value}
                            style={[
                              styles.filterChip,
                              {
                                backgroundColor: isActive ? theme.primary : theme.surface,
                                borderColor: isActive ? theme.primary : theme.border
                              }
                            ]}
                            onPress={() => toggleDeliveryMethodFilter(option.value)}
                          >
                            <Text
                              style={[
                                styles.filterChipText,
                                { color: isActive ? theme.background : theme.text }
                              ]}
                            >
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.filterSection}>
                    <Text style={[styles.filterSectionTitle, { color: theme.text }]}>Delivery Success</Text>
                    <View style={styles.filterChipGroup}>
                      {SUCCESS_FILTER_OPTIONS.map(option => {
                        const isActive = successFilter === option.value;
                        return (
                          <TouchableOpacity
                            key={option.value}
                            style={[
                              styles.filterChip,
                              {
                                backgroundColor: isActive ? theme.primary : theme.surface,
                                borderColor: isActive ? theme.primary : theme.border
                              }
                            ]}
                            onPress={() => setSuccessFilter(option.value)}
                          >
                            <Text
                              style={[
                                styles.filterChipText,
                                { color: isActive ? theme.background : theme.text }
                              ]}
                            >
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>

                  <View style={styles.filterSection}>
                    <Text style={[styles.filterSectionTitle, { color: theme.text }]}>Sent Date</Text>
                    <View style={styles.filterChipGroup}>
                      {DATE_RANGE_OPTIONS.map(option => {
                        const isActive = dateRangeFilter === option.value;
                        return (
                          <TouchableOpacity
                            key={option.value}
                            style={[
                              styles.filterChip,
                              {
                                backgroundColor: isActive ? theme.primary : theme.surface,
                                borderColor: isActive ? theme.primary : theme.border
                              }
                            ]}
                            onPress={() => setDateRangeFilter(option.value)}
                          >
                            <Text
                              style={[
                                styles.filterChipText,
                                { color: isActive ? theme.background : theme.text }
                              ]}
                            >
                              {option.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                </ScrollView>

                <View style={[styles.filterModalFooter, { borderTopColor: theme.border }]}> 
                  <TouchableOpacity
                    style={[
                      styles.filterFooterButton,
                      { borderColor: theme.border, opacity: filtersApplied ? 1 : 0.5 }
                    ]}
                    onPress={handleClearFilters}
                    disabled={!filtersApplied}
                  >
                    <Text
                      style={[
                        styles.filterFooterButtonText,
                        { color: filtersApplied ? theme.error : theme.textSecondary }
                      ]}
                    >
                      Clear
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.filterFooterButton, { borderColor: theme.primary, backgroundColor: theme.primary }]}
                    onPress={() => setShowFilterModal(false)}
                  >
                    <Text style={[styles.filterFooterButtonText, { color: theme.background }]}>Done</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </Modal>
        )}

        {/* Detail Modal */}
        {selectedNotification && (
          <Modal
            visible={showDetailModal}
            animationType="slide"
            transparent={true}
            onRequestClose={() => setShowDetailModal(false)}
          >
            <View style={styles.modalOverlay}>
              <View style={[styles.modalContent, { backgroundColor: theme.surface, maxHeight: '80%' }]}>
                <View style={[styles.modalHeader, { borderBottomColor: theme.border }]}>
                  <Text style={[styles.modalTitle, { color: theme.text }]}>
                    Notification Details
                  </Text>
                  <TouchableOpacity
                    style={styles.modalCloseButton}
                    onPress={() => setShowDetailModal(false)}
                  >
                    <X size={20} color={theme.textSecondary} />
                  </TouchableOpacity>
                </View>
                
                <ScrollView
                  style={styles.modalBody}
                  contentContainerStyle={{
                    paddingBottom: Platform.select({ web: 0, default: 20 }),
                  }}
                >
                  {/* Notification Header */}
                  <View style={styles.modalSection}>
                    <Text style={[styles.detailTitle, { color: theme.text }]}>
                      {selectedNotification.title}
                    </Text>
                    <Text style={[styles.detailBody, { color: theme.textSecondary }]}>
                      {selectedNotification.body}
                    </Text>
                  </View>

                  {/* Admin Information */}
                  <View style={[styles.modalSection, { borderTopWidth: 1, borderTopColor: theme.border }]}>
                    <Text style={[styles.sectionTitle, { color: theme.text }]}>Admin Information</Text>
                    <View style={styles.infoGrid}>
                      <View style={styles.infoItem}>
                        <Text style={[styles.infoLabel, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">Name:</Text>
                        <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1} ellipsizeMode="tail">{selectedNotification.adminName}</Text>
                      </View>
                      <View style={styles.infoItem}>
                        <Text style={[styles.infoLabel, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">Email:</Text>
                        <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1} ellipsizeMode="tail">{selectedNotification.adminEmail}</Text>
                      </View>
                    </View>
                  </View>

                  {/* Notification Details */}
                  <View style={[styles.modalSection, { borderTopWidth: 1, borderTopColor: theme.border }]}>
                    <Text style={[styles.sectionTitle, { color: theme.text }]}>Notification Details</Text>
                    <View style={styles.infoGrid}>
                      <View style={styles.infoItem}>
                        <Text style={[styles.infoLabel, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">Type:</Text>
                        <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1} ellipsizeMode="tail">{selectedNotification.type.toUpperCase()}</Text>
                      </View>
                      <View style={styles.infoItem}>
                        <Text style={[styles.infoLabel, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">Priority:</Text>
                        <Text style={[styles.infoValue, { color: getPriorityColor(selectedNotification.priority) }]} numberOfLines={1} ellipsizeMode="tail"> 
                          {selectedNotification.priority.toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.infoItem}>
                        <Text style={[styles.infoLabel, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">Delivery Method:</Text>
                        <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1} ellipsizeMode="tail"> 
                          {getDeliveryMethodLabel(selectedNotification.deliveryMethod)}
                        </Text>
                      </View>
                      <View style={styles.infoItem}>
                        <Text style={[styles.infoLabel, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">Mode:</Text>
                        <Text style={[styles.infoValue, { color: selectedNotification.onlineOnly ? theme.warning : theme.text }]} numberOfLines={1} ellipsizeMode="tail"> 
                          {selectedNotification.onlineOnly ? 'Online Only' : 'All Devices'}
                        </Text>
                      </View>
                      <View style={styles.infoItem}>
                        <Text style={[styles.infoLabel, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">Sent At:</Text>
                        <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1} ellipsizeMode="tail">{formatDate(selectedNotification.sentAt)}</Text>
                      </View>
                    </View>
                  </View>

                  {/* Delivery Statistics */}
                  <View style={[styles.modalSection, { borderTopWidth: 1, borderTopColor: theme.border }]}>
                    <Text style={[styles.sectionTitle, { color: theme.text }]}>Delivery Statistics</Text>
                    <View style={styles.statsGrid}>
                      <View style={styles.modalStatItem}>
                        <Text style={[styles.statNumber, { color: theme.text }]}>{selectedNotification.totalTargets}</Text>
                        <Text style={[styles.modalStatLabel, { color: theme.textSecondary }]}>Total Targets</Text>
                      </View>
                      <View style={styles.modalStatItem}>
                        <Text style={[styles.statNumber, { color: theme.success }]}>{selectedNotification.successfulDeliveries}</Text>
                        <Text style={[styles.modalStatLabel, { color: theme.textSecondary }]}>Successful</Text>
                      </View>
                      <View style={styles.modalStatItem}>
                        <Text style={[styles.statNumber, { color: theme.error }]}>{selectedNotification.failedDeliveries}</Text>
                        <Text style={[styles.modalStatLabel, { color: theme.textSecondary }]}>Failed</Text>
                      </View>
                      <View style={styles.modalStatItem}>
                        <Text style={[styles.statNumber, { color: theme.primary }]}>{getSuccessRate(selectedNotification)}%</Text>
                        <Text style={[styles.modalStatLabel, { color: theme.textSecondary }]}>Success Rate</Text>
                      </View>
                    </View>
                  </View>

                  {/* Target Users */}
                  <View style={[styles.modalSection, { borderTopWidth: 1, borderTopColor: theme.border }]}>
                    <Text style={[styles.sectionTitle, { color: theme.text }]}>Target Users ({selectedNotification.targetUsers.length})</Text>
                    <View style={styles.targetList}>
                      {selectedNotification.targetUsers.map((email, index) => (
                        <Text key={index} style={[styles.targetItem, { color: theme.textSecondary }]}>
                          • {email}
                        </Text>
                      ))}
                    </View>
                  </View>

                  {/* Target Devices */}
                  <View style={[styles.modalSection, { borderTopWidth: 1, borderTopColor: theme.border }]}>
                    <Text style={[styles.sectionTitle, { color: theme.text }]}>Target Devices ({selectedNotification.targetDevices.length})</Text>
                    <View style={styles.targetList}>
                      {selectedNotification.targetDevices.map((device, index) => (
                        <View key={index} style={styles.deviceItem}>
                          <Text style={[styles.deviceName, { color: theme.text }]}>
                            {device.deviceName || 'Unknown Device'}
                          </Text>
                          <Text style={[styles.deviceEmail, { color: theme.textSecondary }]}>
                            {device.email}
                          </Text>
                          <Text style={[styles.deviceId, { color: theme.textSecondary }]}>
                            ID: {device.deviceId}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </View>

                  {/* Device Results */}
                  {selectedNotification.deviceResults && selectedNotification.deviceResults.length > 0 && (
                    <View style={[styles.modalSection, { borderTopWidth: 1, borderTopColor: theme.border }]}>
                      <Text style={[styles.sectionTitle, { color: theme.text }]}>Delivery Results</Text>
                      {selectedNotification.failureReasonSummary && (
                        <View style={styles.failureSummarySection}>
                          {Object.entries(selectedNotification.failureReasonSummary)
                            .filter(([, count]) => (count ?? 0) > 0)
                            .map(([reasonKey, count]) => (
                              <Text key={reasonKey} style={[styles.failureSummaryText, { color: theme.warning }]}>
                                {count} device{count !== 1 ? 's' : ''}: {describeDeviceFailureReason(reasonKey) ?? 'Delivery failed.'}
                              </Text>
                            ))}
                        </View>
                      )}
                      <View style={styles.targetList}>
                        {selectedNotification.deviceResults.map((result, index) => (
                          <View key={index} style={styles.resultItem}>
                            <View style={styles.resultHeader}>
                              <Text style={[styles.resultDevice, { color: theme.text }]}>
                                {result.deviceName || 'Unknown Device'}
                              </Text>
                              <View style={[styles.resultStatus, { 
                                backgroundColor: result.success ? theme.success : theme.error 
                              }]}>
                                <Text style={styles.resultStatusText}>
                                  {result.success ? 'SUCCESS' : 'FAILED'}
                                </Text>
                              </View>
                            </View>
                            <Text style={[styles.resultEmail, { color: theme.textSecondary }]}>
                              {result.email}
                            </Text>
                            {!result.success && (
                              <Text style={[styles.resultReason, { color: theme.warning }]}> 
                                {describeDeviceFailureReason(result.reason) ?? 'Delivery failed.'}
                              </Text>
                            )}
                          </View>
                        ))}
                      </View>
                    </View>
                  )}
                </ScrollView>
              </View>
            </View>
          </Modal>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  emptyTenantState: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 8,
  },
  emptyTenantTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  emptyTenantSubtitle: {
    fontSize: 13,
  },
  emptyTenantButton: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
    marginLeft: 12,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerButton: {
    padding: 8,
    borderRadius: 8,
    marginLeft: 8,
  },
  closeButton: {
    padding: 8,
    marginLeft: 8,
  },
  content: {
    flex: 1,
  },
  listContentContainer: {
    padding: 16,
    paddingBottom: 32,
  },
  listFooter: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  listFooterButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  listFooterButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  listFooterText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  sortPanel: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  sortInfoText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  activeFiltersWrapper: {
    marginTop: 12,
  },
  activeFiltersChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  activeFilterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    marginRight: 8,
    marginBottom: 8,
  },
  activeFilterChipText: {
    fontSize: 12,
  },
  clearFiltersButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
  },
  clearFiltersButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  loadingText: {
    fontSize: 16,
    marginTop: 16,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 24,
  },
  emptyText: {
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  notificationItem: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  notificationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  notificationTypeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  notificationTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
    flex: 1,
  },
  priorityContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  priorityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  priorityText: {
    fontSize: 12,
    fontWeight: '500',
  },
  notificationBody: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  notificationMeta: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  failureSummaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  failureBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  failureBadgeText: {
    fontSize: 12,
    fontWeight: '500',
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
    marginBottom: 4,
  },
  metaText: {
    fontSize: 12,
    marginLeft: 4,
  },
  notificationFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  adminInfo: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  deliveryStats: {
    flexDirection: 'row',
  },
  deliveryText: {
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 8,
  },
  loadMoreButton: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  loadMoreText: {
    fontSize: 16,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  filterModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    width: '90%',
    maxHeight: '70%',
    borderRadius: 16,
    overflow: 'hidden',
  },
  filterModalContent: {
    width: '100%',
    maxHeight: '85%',
    borderRadius: 16,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
  },
  filterModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    flex: 1,
  },
  filterModalTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  modalCloseButton: {
    padding: 4,
  },
  filterModalCloseButton: {
    padding: 8,
  },
  modalBody: {
    padding: 20,
    paddingBottom: 50,
  },
  filterModalBody: {
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  filterSection: {
    marginBottom: 20,
  },
  filterSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12,
  },
  filterChipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    marginRight: 8,
    marginBottom: 8,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterModalFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
  },
  filterFooterButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginHorizontal: 4,
  },
  filterFooterButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  searchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 8,
  },
  searchButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  searchHelp: {
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
  searchContainer: {
    padding: 16,
    borderBottomWidth: 1,
  },
  searchInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  searchIcon: {
    position: 'absolute',
    left: 12,
    zIndex: 1,
  },
  inlineSearchInput: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 8,
    paddingLeft: 40,
    paddingRight: 40,
    paddingVertical: 12,
    fontSize: 14,
  },
  clearSearchButton: {
    position: 'absolute',
    right: 12,
    zIndex: 1,
    padding: 4,
  },
  searchResultsInfo: {
    marginTop: 8,
    alignItems: 'center',
  },
  searchResultsText: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  detailTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  detailBody: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  detailMeta: {
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  detailMetaText: {
    fontSize: 12,
    marginBottom: 4,
  },
  notificationDetails: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginRight: 6,
    minWidth: 60,
  },
  detailValue: {
    fontSize: 12,
    flex: 1,
  },
  modalSection: {
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  infoGrid: {
    gap: 8,
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    flexWrap: 'nowrap',
    width: '100%',
  },
  infoLabel: {
    fontSize: 13,
    fontWeight: '500',
    marginRight: 8,
    // minWidth removed to prevent wrapping on small screens
    maxWidth: 90,
  },
  infoValue: {
    fontSize: 13,
    flex: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  modalStatItem: {
    alignItems: 'center',
    minWidth: '22%',
    marginBottom: 12,
  },
  statNumber: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  modalStatLabel: {
    fontSize: 11,
    textAlign: 'center',
  },
  targetList: {
    gap: 8,
  },
  targetItem: {
    fontSize: 13,
    paddingVertical: 4,
  },
  deviceItem: {
    backgroundColor: 'rgba(0,0,0,0.05)',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 4,
  },
  deviceEmail: {
    fontSize: 12,
    marginBottom: 2,
  },
  deviceId: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
  resultItem: {
    backgroundColor: 'rgba(0,0,0,0.05)',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  resultDevice: {
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  resultStatus: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  resultStatusText: {
    color: 'white',
    fontSize: 10,
    fontWeight: 'bold',
  },
  resultEmail: {
    fontSize: 12,
  },
  resultReason: {
    fontSize: 12,
    marginTop: 4,
  },
  failureSummarySection: {
    marginBottom: 12,
    gap: 4,
  },
  failureSummaryText: {
    fontSize: 12,
  },
});
