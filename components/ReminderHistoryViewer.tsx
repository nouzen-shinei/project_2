import { logger } from '@/lib/logger';
import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
} from 'react-native';
import {
  Clock,
  CheckCircle,
  XCircle,
  Mail,
  MessageSquare,
  Phone,
  PhoneCall,
  User,
  Calendar,
  RefreshCw,
  Search,
  X,
} from 'lucide-react-native';
import { FontAwesome } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import { useReminderHistory } from '../hooks/useReminderHistory';
import { useAuth } from '../hooks/useAuthUnified';
import { useTenant } from '../hooks/useTenantContext';
import { ReminderHistoryEntry } from '../services/reminderHistoryService';

interface ReminderHistoryViewerProps {
  studentId?: string;
  reminderType?: string;
  limit?: number;
  onClose?: () => void;
}

const WINDOW_DAY_OPTIONS = ['7', '30', '90', 'all'] as const;
const STATUS_FILTER_OPTIONS = ['all', 'success', 'failed', 'pending'] as const;
const TYPE_FILTER_OPTIONS = ['all', 'email', 'sms', 'whatsapp', 'voice'] as const;
const STATUS_FILTER_LABELS: Record<(typeof STATUS_FILTER_OPTIONS)[number], string> = {
  all: 'All Status',
  success: 'Success',
  failed: 'Failed',
  pending: 'Pending',
};
const TYPE_FILTER_LABELS: Record<(typeof TYPE_FILTER_OPTIONS)[number], string> = {
  all: 'All Types',
  email: 'Email',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
  voice: 'Voice',
};
type ReminderWindowDays = 7 | 30 | 90 | 'all';
type ReminderStatusFilter = (typeof STATUS_FILTER_OPTIONS)[number];
type ReminderTypeFilter = (typeof TYPE_FILTER_OPTIONS)[number];
type ReminderStatTone = 'primary' | 'success' | 'error' | 'warning' | 'secondary';

function toReminderWindowDays(value: (typeof WINDOW_DAY_OPTIONS)[number]): ReminderWindowDays {
  switch (value) {
    case '7':
      return 7;
    case '30':
      return 30;
    case '90':
      return 90;
    default:
      return 'all';
  }
}

function normalizeTypeFilter(value: string | null | undefined): ReminderTypeFilter {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (normalized) {
    case 'email':
    case 'sms':
    case 'whatsapp':
    case 'voice':
    case 'all':
      return normalized;
    default:
      return 'all';
  }
}

function formatReminderAmount(amount: number | null | undefined): string {
  const normalizedAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  return `₹${normalizedAmount.toLocaleString()}`;
}

function getReminderTimestampKey(timestamp: unknown): string {
  if (!timestamp) {
    return 'unknown-time';
  }

  if (timestamp instanceof Date) {
    return String(timestamp.getTime());
  }

  if (typeof timestamp === 'string' || typeof timestamp === 'number') {
    return String(timestamp);
  }

  if (typeof timestamp === 'object') {
    const ts = timestamp as {
      toMillis?: () => number;
      toDate?: () => Date;
      seconds?: number;
      nanoseconds?: number;
    };

    if (typeof ts.toMillis === 'function') {
      const millis = ts.toMillis();
      if (Number.isFinite(millis)) {
        return String(millis);
      }
    }

    if (typeof ts.toDate === 'function') {
      const date = ts.toDate();
      if (date instanceof Date && Number.isFinite(date.getTime())) {
        return String(date.getTime());
      }
    }

    if (typeof ts.seconds === 'number') {
      return `${ts.seconds}:${typeof ts.nanoseconds === 'number' ? ts.nanoseconds : 0}`;
    }
  }

  return String(timestamp);
}

function buildReminderStableFallbackKey(item: ReminderHistoryEntry): string {
  return [
    item.tenantId,
    item.studentId,
    item.reminderType,
    getReminderTimestampKey(item.createdAt),
    getReminderTimestampKey(item.updatedAt),
    item.status,
    item.parentContact,
    item.parentEmail,
    String(item.amount),
    item.dueDate,
  ]
    .map((part) => String(part || ''))
    .join('|');
}

interface ReminderHistoryListItemProps {
  item: ReminderHistoryEntry;
  styles: Record<string, any>;
  formattedDate: string;
  amountLabel: string;
  textColor: string;
  textSecondaryColor: string;
  successColor: string;
  errorColor: string;
  warningColor: string;
}

interface ReminderHistoryDisplayInfo {
  formattedDate: string;
  amountLabel: string;
}

const ReminderHistoryListItem = React.memo(function ReminderHistoryListItem({
  item,
  styles,
  formattedDate,
  amountLabel,
  textColor,
  textSecondaryColor,
  successColor,
  errorColor,
  warningColor,
}: ReminderHistoryListItemProps) {
  const iconSize = 16;
  let typeIcon: React.ReactNode;
  switch (item.reminderType) {
    case 'email':
      typeIcon = <Mail size={iconSize} color={textColor} />;
      break;
    case 'sms':
      typeIcon = <MessageSquare size={iconSize} color={textColor} />;
      break;
    case 'whatsapp':
      typeIcon = <FontAwesome name="whatsapp" size={iconSize} color={textColor} />;
      break;
    case 'voice':
      typeIcon = <PhoneCall size={iconSize} color={textColor} />;
      break;
    default:
      typeIcon = <Phone size={iconSize} color={textColor} />;
      break;
  }

  let statusIcon: React.ReactNode;
  switch (item.status) {
    case 'success':
      statusIcon = <CheckCircle size={iconSize} color={successColor} />;
      break;
    case 'failed':
      statusIcon = <XCircle size={iconSize} color={errorColor} />;
      break;
    default:
      statusIcon = <Clock size={iconSize} color={warningColor} />;
      break;
  }

  return (
    <View style={styles.historyItem}>
      <View style={styles.historyHeader}>
        <View style={styles.studentInfo}>
          <User size={iconSize} color={textSecondaryColor} />
          <Text style={styles.studentName}>{item.studentName}</Text>
        </View>
        <View style={styles.statusContainer}>
          {typeIcon}
          {statusIcon}
        </View>
      </View>

      <View style={styles.historyDetails}>
        <View style={styles.detailRow}>
          <Calendar size={14} color={textSecondaryColor} />
          <Text style={styles.detailText}>
            {formattedDate}
          </Text>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.detailText}>Parent: {item.parentName}</Text>
        </View>
        {item.senderName && (
          <View style={styles.detailRow}>
            <Text style={styles.detailText}>Sent by: {item.senderName}</Text>
          </View>
        )}

        <View style={styles.detailRow}>
          <Text style={styles.detailText}>Contact: {item.parentContact}</Text>
        </View>

        {item.parentEmail && (
          <View style={styles.detailRow}>
            <Text style={styles.detailText}>Email: {item.parentEmail}</Text>
          </View>
        )}

        <View style={styles.detailRow}>
          <Text style={styles.detailText}>Amount: {amountLabel}</Text>
        </View>

        {item.feeCategories && item.feeCategories.length > 0 && (
          <View style={styles.detailRow}>
            <Text style={styles.detailText}>Categories: {item.feeCategories.join(', ')}</Text>
          </View>
        )}

        {item.message && (
          <View style={styles.detailRow}>
            <Text style={styles.detailText}>Message: {item.message}</Text>
          </View>
        )}

        {item.errorMessage && (
          <Text style={styles.errorText}>Error: {item.errorMessage}</Text>
        )}
      </View>
    </View>
  );
}, (prev, next) => {
  return (
    prev.item === next.item &&
    prev.styles === next.styles &&
    prev.formattedDate === next.formattedDate &&
    prev.amountLabel === next.amountLabel &&
    prev.textColor === next.textColor &&
    prev.textSecondaryColor === next.textSecondaryColor &&
    prev.successColor === next.successColor &&
    prev.errorColor === next.errorColor &&
    prev.warningColor === next.warningColor
  );
});

interface ReminderHistoryHeaderSectionProps {
  styles: Record<string, any>;
  themeText: string;
  themeTextSecondary: string;
  scopeToggleButton: React.ReactNode;
  onClose?: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onClearSearch: () => void;
  statsSection: React.ReactNode;
}

const ReminderHistoryHeaderSection = React.memo(function ReminderHistoryHeaderSection({
  styles,
  themeText,
  themeTextSecondary,
  scopeToggleButton,
  onClose,
  searchQuery,
  onSearchQueryChange,
  onClearSearch,
  statsSection,
}: ReminderHistoryHeaderSectionProps) {
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <Text allowFontScaling={false} style={styles.headerTitle}>Reminder History</Text>
        {scopeToggleButton}
        {onClose && (
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeButton}
          >
            <X size={18} color={themeText} />
          </TouchableOpacity>
        )}
      </View>

      {/* Search Input */}
      <View style={styles.searchContainer}>
        <Search size={20} color={themeTextSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by student, parent, contact, amount, date, status..."
          placeholderTextColor={themeTextSecondary}
          value={searchQuery}
          onChangeText={onSearchQueryChange}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity
            onPress={onClearSearch}
            style={styles.searchClearButton}
          >
            <X size={18} color={themeTextSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {statsSection}
    </View>
  );
}, (prev, next) => {
  return (
    prev.styles === next.styles &&
    prev.themeText === next.themeText &&
    prev.themeTextSecondary === next.themeTextSecondary &&
    prev.scopeToggleButton === next.scopeToggleButton &&
    prev.onClose === next.onClose &&
    prev.searchQuery === next.searchQuery &&
    prev.onSearchQueryChange === next.onSearchQueryChange &&
    prev.onClearSearch === next.onClearSearch &&
    prev.statsSection === next.statsSection
  );
});

interface ReminderHistoryFiltersSectionProps {
  styles: Record<string, any>;
  windowDayFilterButtons: React.ReactNode;
  searchResultCountChip: React.ReactNode;
  statusFilterButtons: React.ReactNode;
  typeFilterButtons: React.ReactNode;
  onRefreshWithFilters: () => void;
  loading: boolean;
}

const ReminderHistoryFiltersSection = React.memo(function ReminderHistoryFiltersSection({
  styles,
  windowDayFilterButtons,
  searchResultCountChip,
  statusFilterButtons,
  typeFilterButtons,
  onRefreshWithFilters,
  loading,
}: ReminderHistoryFiltersSectionProps) {
  return (
    <View style={styles.filterContainer}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.filterRow}>
          {windowDayFilterButtons}
          {searchResultCountChip}
          {statusFilterButtons}
          {typeFilterButtons}
        </View>
      </ScrollView>

      <TouchableOpacity
        style={styles.refreshButton}
        onPress={onRefreshWithFilters}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator size={16} color="#ffffff" />
        ) : (
          <RefreshCw size={16} color="#ffffff" />
        )}
      </TouchableOpacity>
    </View>
  );
}, (prev, next) => {
  return (
    prev.styles === next.styles &&
    prev.windowDayFilterButtons === next.windowDayFilterButtons &&
    prev.searchResultCountChip === next.searchResultCountChip &&
    prev.statusFilterButtons === next.statusFilterButtons &&
    prev.typeFilterButtons === next.typeFilterButtons &&
    prev.onRefreshWithFilters === next.onRefreshWithFilters &&
    prev.loading === next.loading
  );
});

interface ReminderHistoryFooterSectionProps {
  styles: Record<string, any>;
  hasMore: boolean;
  loadingMore: boolean;
  loading: boolean;
  hasFilteredItems: boolean;
  onLoadMore: () => void;
  primaryColor: string;
}

const ReminderHistoryFooterSection = React.memo(function ReminderHistoryFooterSection({
  styles,
  hasMore,
  loadingMore,
  loading,
  hasFilteredItems,
  onLoadMore,
  primaryColor,
}: ReminderHistoryFooterSectionProps) {
  if (!hasMore && hasFilteredItems) {
    return (
      <View style={styles.loadMoreContainer}>
        <Text style={styles.endOfListText}>No more reminders to load</Text>
      </View>
    );
  }

  if (loadingMore) {
    return (
      <View style={styles.loadMoreContainer}>
        <ActivityIndicator size="small" color={primaryColor} />
        <Text style={styles.loadingMoreText}>Loading more reminders...</Text>
      </View>
    );
  }

  if (hasMore && hasFilteredItems) {
    return (
      <View style={styles.loadMoreContainer}>
        <TouchableOpacity
          style={[styles.loadMoreButton, styles.primaryBorder]}
          onPress={onLoadMore}
          disabled={loadingMore || loading}
        >
          <Text style={[styles.loadMoreText, styles.primaryText]}>
            Load More Reminders
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return null;
}, (prev, next) => {
  return (
    prev.styles === next.styles &&
    prev.hasMore === next.hasMore &&
    prev.loadingMore === next.loadingMore &&
    prev.loading === next.loading &&
    prev.hasFilteredItems === next.hasFilteredItems &&
    prev.onLoadMore === next.onLoadMore &&
    prev.primaryColor === next.primaryColor
  );
});

interface ReminderHistoryEmptyStateSectionProps {
  styles: Record<string, any>;
  loading: boolean;
  primaryColor: string;
  textSecondaryColor: string;
  trimmedSearchQuery: string;
  onClearSearch: () => void;
}

const ReminderHistoryEmptyStateSection = React.memo(function ReminderHistoryEmptyStateSection({
  styles,
  loading,
  primaryColor,
  textSecondaryColor,
  trimmedSearchQuery,
  onClearSearch,
}: ReminderHistoryEmptyStateSectionProps) {
  if (loading) {
    return (
      <View style={styles.emptyState}>
        <ActivityIndicator size="large" color={primaryColor} />
      </View>
    );
  }

  return (
    <View style={styles.emptyState}>
      <Clock size={48} color={textSecondaryColor} />
      <Text style={styles.emptyStateText}>
        {trimmedSearchQuery
          ? `No reminders found matching "${trimmedSearchQuery}"`
          : 'No reminder history found for the selected filters'}
      </Text>
      {trimmedSearchQuery ? (
        <TouchableOpacity
          style={[styles.filterButton, styles.clearSearchChip, styles.primaryBorder]}
          onPress={onClearSearch}
        >
          <Text style={[styles.filterButtonText, styles.primaryText]}>Clear Search</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}, (prev, next) => {
  return (
    prev.styles === next.styles &&
    prev.loading === next.loading &&
    prev.primaryColor === next.primaryColor &&
    prev.textSecondaryColor === next.textSecondaryColor &&
    prev.trimmedSearchQuery === next.trimmedSearchQuery &&
    prev.onClearSearch === next.onClearSearch
  );
});

export default function ReminderHistoryViewer({ 
  studentId, 
  reminderType, 
  limit = 20,
  onClose 
}: ReminderHistoryViewerProps) {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { activeTenant } = useTenant();
  const { 
    history, 
    stats, 
    loading, 
    loadingMore,
  statsLoading,
    error, 
    hasMore,
    loadHistory, 
    loadMoreHistory,
    loadStats, 
    refresh,
    canViewAllReminders,
  } = useReminderHistory();
  
  const [filter, setFilter] = useState<ReminderStatusFilter>('all');
  const [typeFilter, setTypeFilter] = useState<ReminderTypeFilter>(() => normalizeTypeFilter(reminderType));
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [allowAllForNonAdmins, setAllowAllForNonAdmins] = useState<boolean>(false);
  const [windowDays, setWindowDays] = useState<ReminderWindowDays>(30);
  const windowDaysRef = useRef<ReminderWindowDays>(windowDays);
  const filterRef = useRef<ReminderStatusFilter>(filter);
  const typeFilterRef = useRef<ReminderTypeFilter>(typeFilter);
  const loadMoreRequestInFlightRef = useRef(false);
  const refreshWithFiltersInFlightRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const windowDaysValue = String(windowDays);
  const trimmedSearchQuery = searchQuery.trim();
  const normalizedSearchQuery = trimmedSearchQuery.toLowerCase();
  const hasSearchQuery = normalizedSearchQuery.length > 0;
  const trimmedSearchQueryRef = useRef(trimmedSearchQuery);
  windowDaysRef.current = windowDays;
  filterRef.current = filter;
  typeFilterRef.current = typeFilter;
  trimmedSearchQueryRef.current = trimmedSearchQuery;

  const syncDebouncedSearch = useCallback(() => {
    const nextSearch = trimmedSearchQueryRef.current;
    setDebouncedSearch((current) => (current === nextSearch ? current : nextSearch));
  }, []);

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery((current) => (current === value ? current : value));
  }, []);

  const clearSearchQuery = useCallback(() => {
    setSearchQuery((current) => (current.length > 0 ? '' : current));
    setDebouncedSearch((current) => (current.length > 0 ? '' : current));
  }, []);

  const handleScopeToggle = useCallback(() => {
    setScope((current) => (current === 'mine' ? 'all' : 'mine'));
    syncDebouncedSearch();
  }, [syncDebouncedSearch]);

  const handleWindowDaysFilter = useCallback((value: (typeof WINDOW_DAY_OPTIONS)[number]) => {
    const nextWindowDays = toReminderWindowDays(value);
    if (windowDaysRef.current === nextWindowDays) {
      return;
    }

    setWindowDays(nextWindowDays);
    syncDebouncedSearch();
  }, [syncDebouncedSearch]);

  const handleStatusFilter = useCallback((status: ReminderStatusFilter) => {
    if (filterRef.current === status) {
      return;
    }

    setFilter(status);
    syncDebouncedSearch();
  }, [syncDebouncedSearch]);

  const handleTypeFilter = useCallback((type: ReminderTypeFilter) => {
    if (typeFilterRef.current === type) {
      return;
    }

    setTypeFilter(type);
    syncDebouncedSearch();
  }, [syncDebouncedSearch]);

  const windowDaysPressHandlers = useMemo(() => {
    return WINDOW_DAY_OPTIONS.reduce((handlers, option) => {
      handlers[option] = () => handleWindowDaysFilter(option);
      return handlers;
    }, {} as Record<(typeof WINDOW_DAY_OPTIONS)[number], () => void>);
  }, [handleWindowDaysFilter]);

  const statusPressHandlers = useMemo(() => {
    return STATUS_FILTER_OPTIONS.reduce((handlers, option) => {
      handlers[option] = () => handleStatusFilter(option);
      return handlers;
    }, {} as Record<ReminderStatusFilter, () => void>);
  }, [handleStatusFilter]);

  const typePressHandlers = useMemo(() => {
    return TYPE_FILTER_OPTIONS.reduce((handlers, option) => {
      handlers[option] = () => handleTypeFilter(option);
      return handlers;
    }, {} as Record<ReminderTypeFilter, () => void>);
  }, [handleTypeFilter]);

  useEffect(() => {
    const normalizedTypeFilter = normalizeTypeFilter(reminderType);
    setTypeFilter((current) => (current === normalizedTypeFilter ? current : normalizedTypeFilter));
  }, [reminderType]);

  useEffect(() => {
    // Keep server filters and stats in sync with the same debounced search input.
    loadHistory(limit, studentId, typeFilter, filter, debouncedSearch, windowDays, scope === 'all');
    loadStats(windowDays, { searchQuery: debouncedSearch });
  }, [loadHistory, loadStats, limit, studentId, typeFilter, filter, debouncedSearch, scope, windowDays]);

  // Debounce search text before issuing list/stats fetches.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // H2: whether non-admins may switch to the "All reminders" scope is now a
  // TENANT-scoped setting (tenants/{id}.settings.allowNonAdminAllReminderHistory),
  // not a global appSettings flag. Read it off the active tenant.
  useEffect(() => {
    setAllowAllForNonAdmins(!!activeTenant?.settings?.allowNonAdminAllReminderHistory);
  }, [activeTenant?.settings?.allowNonAdminAllReminderHistory]);

  // If the caller loses permission to view all reminders while the "All Reminders"
  // scope is active (e.g. an admin turns the tenant flag off mid-session), snap the
  // scope back to the caller's own reminders. Without this the viewer would keep
  // requesting the tenant-wide feed that the rules now deny — and each denied read
  // would otherwise churn the auth-recovery machinery. Whenever the scope toggle is
  // visible, canViewAllReminders is already true, so this never fights the user.
  useEffect(() => {
    if (!canViewAllReminders && scope === 'all') {
      setScope('mine');
    }
  }, [canViewAllReminders, scope]);

  const formatDate = useCallback((timestamp: any) => {
    try {
      let date: Date;

      // Handle serverTimestamp objects (not yet resolved)
      if (timestamp && typeof timestamp === 'object' && (timestamp as any)._methodName === 'serverTimestamp') {
        date = new Date(); // Use current time for unresolved serverTimestamp
      }
      // Handle Firestore Timestamp
      else if (timestamp && typeof timestamp.toDate === 'function') {
        date = timestamp.toDate();
      }
      // Handle ISO string
      else if (typeof timestamp === 'string') {
        date = new Date(timestamp);
      }
      // Handle Date object
      else if (timestamp instanceof Date) {
        date = timestamp;
      }
      // Handle timestamp in seconds (Firestore format)
      else if (timestamp && timestamp.seconds) {
        date = new Date(timestamp.seconds * 1000);
      }
      // Fallback to current date
      else {
        date = new Date();
      }

      return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (error) {
      logger.error('Error formatting date:', error);
      return 'Invalid Date';
    }
  }, []);

  const historyDerivedData = useMemo(() => {
    const displayInfo = new Map<ReminderHistoryEntry, ReminderHistoryDisplayInfo>();
    const stableKeys = new Map<ReminderHistoryEntry, string>();
    const searchIndex: { entry: ReminderHistoryEntry; searchText: string }[] = [];

    for (const entry of history) {
      const formattedDate = formatDate(entry.createdAt);
      const amountLabel = formatReminderAmount(entry.amount);

      displayInfo.set(entry, {
        formattedDate,
        amountLabel,
      });
      stableKeys.set(entry, buildReminderStableFallbackKey(entry));

      if (hasSearchQuery) {
        const searchText = [
          entry.studentName ?? '',
          entry.parentName ?? '',
          entry.parentContact ?? '',
          entry.parentEmail ?? '',
          entry.message ?? '',
          entry.amount != null ? String(entry.amount) : '',
          entry.feeCategories?.join(' ') ?? '',
          entry.reminderType ?? '',
          entry.status ?? '',
          entry.errorMessage ?? '',
          formattedDate,
        ]
          .join(' ')
          .toLowerCase();

        searchIndex.push({
          entry,
          searchText,
        });
      }
    }

    return {
      displayInfo,
      stableKeys,
      searchIndex,
    };
  }, [formatDate, hasSearchQuery, history]);

  const historyDisplayInfo = historyDerivedData.displayInfo;
  const historyStableKeys = historyDerivedData.stableKeys;
  const historySearchIndex = historyDerivedData.searchIndex;

  // Filter history based on current filters and search
  const filteredHistory = useMemo(() => {
    if (!hasSearchQuery && filter === 'all' && typeFilter === 'all') {
      return history;
    }

    const next: ReminderHistoryEntry[] = [];

    if (!hasSearchQuery) {
      for (const entry of history) {
        if (filter !== 'all' && entry.status !== filter) {
          continue;
        }
        if (typeFilter !== 'all' && entry.reminderType !== typeFilter) {
          continue;
        }

        next.push(entry);
      }

      return next;
    }

    for (const indexedEntry of historySearchIndex) {
      const { entry, searchText } = indexedEntry;

      if (filter !== 'all' && entry.status !== filter) {
        continue;
      }
      if (typeFilter !== 'all' && entry.reminderType !== typeFilter) {
        continue;
      }

      if (!searchText.includes(normalizedSearchQuery)) {
        continue;
      }

      next.push(entry);
    }

    return next;
  }, [filter, hasSearchQuery, history, historySearchIndex, normalizedSearchQuery, typeFilter]);

  const debouncedTrimmedSearch = debouncedSearch.trim();
  const isStatsSyncedWithSearch = trimmedSearchQuery === debouncedTrimmedSearch;
  const totalMatchingResults = trimmedSearchQuery
    ? (isStatsSyncedWithSearch && !statsLoading ? stats.totalReminders : null)
    : null;
  const successRatePercent = useMemo(() => {
    if (stats.totalReminders <= 0) {
      return 0;
    }
    return Math.round((stats.successfulReminders / stats.totalReminders) * 100);
  }, [stats.successfulReminders, stats.totalReminders]);
  const statsCards = useMemo(() => {
    return [
      {
        key: 'total',
        label: 'Total',
        value: stats.totalReminders,
        tone: 'primary' as ReminderStatTone,
      },
      {
        key: 'successful',
        label: 'Successful',
        value: stats.successfulReminders,
        tone: 'success' as ReminderStatTone,
      },
      {
        key: 'failed',
        label: 'Failed',
        value: stats.failedReminders,
        tone: 'error' as ReminderStatTone,
      },
      {
        key: 'pending',
        label: 'Pending',
        value: stats.pendingReminders,
        tone: 'warning' as ReminderStatTone,
      },
      {
        key: 'rate',
        label: 'Success Rate',
        value: `${successRatePercent}%`,
        tone: 'secondary' as ReminderStatTone,
      },
    ];
  }, [
    stats.failedReminders,
    stats.pendingReminders,
    stats.successfulReminders,
    stats.totalReminders,
    successRatePercent,
  ]);

  // Debug logging
  useEffect(() => {
    if (!__DEV__) {
      return;
    }

    logger.debug('ReminderHistoryViewer - Debug Info:', {
      historyLength: history.length,
      filteredLength: filteredHistory.length,
      filter,
      typeFilter,
      searchQuery,
      statsTotal: stats.totalReminders,
      loading,
      error
    });
  }, [
    error,
    filter,
    filteredHistory.length,
    history.length,
    loading,
    searchQuery,
    stats.totalReminders,
    typeFilter,
  ]);

  // Handle load more functionality
  const handleLoadMore = useCallback(() => {
    if (!hasMore || loadingMore || loading || loadMoreRequestInFlightRef.current) {
      return;
    }

    loadMoreRequestInFlightRef.current = true;

    Promise.resolve(loadMoreHistory())
      .catch((err: unknown) => {
        logger.error('Error loading more reminder history from viewer:', err);
      })
      .finally(() => {
        loadMoreRequestInFlightRef.current = false;
      });
  }, [hasMore, loadingMore, loading, loadMoreHistory]);

  // Handle refresh with filters
  const handleRefreshWithFilters = useCallback(async () => {
    if (refreshWithFiltersInFlightRef.current) {
      return;
    }

    refreshWithFiltersInFlightRef.current = true;

    try {
      const shouldReloadViaEffect = filter !== 'all' || trimmedSearchQuery.length > 0 || debouncedSearch.length > 0;
      if (shouldReloadViaEffect) {
        setFilter((current) => (current === 'all' ? current : 'all'));
        clearSearchQuery();
        return;
      }

      await loadHistory(limit, studentId, typeFilter, 'all', '', windowDays, scope === 'all');
      await loadStats(windowDays);
    } catch {
      Alert.alert('Error', 'Failed to refresh reminder history');
    } finally {
      refreshWithFiltersInFlightRef.current = false;
    }
  }, [clearSearchQuery, debouncedSearch, filter, loadHistory, loadStats, limit, scope, studentId, trimmedSearchQuery, typeFilter, windowDays]);

  // Key extractor for FlatList
  const keyExtractor = useCallback((item: ReminderHistoryEntry, index: number) => {
    if (item.id) {
      return item.id;
    }

    const stableFallbackKey = historyStableKeys.get(item) ?? buildReminderStableFallbackKey(item);

    return stableFallbackKey || `reminder-${index}`;
  }, [historyStableKeys]);

  const handleRefresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;

    try {
      await refresh();
    } catch {
      Alert.alert('Error', 'Failed to refresh reminder history');
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [refresh]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.background,
    },
    header: {
      padding: 20,
      backgroundColor: theme.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: 'bold',
      color: theme.text,
      marginBottom: 8,
    },
    headerRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    closeButton: {
      padding: 6,
      borderRadius: 6,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
    },
    scopeToggleButton: {
      marginLeft: 10,
    },
    scopeToggleText: {
      fontSize: 12,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.background,
      borderRadius: 12,
      marginTop: 15,
      paddingHorizontal: 15,
      borderWidth: 1,
      borderColor: theme.border,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 12,
      color: theme.text,
      fontSize: 16,
      marginLeft: 10,
    },
    searchClearButton: {
      padding: 5,
    },
    statsContainer: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      marginTop: 15,
    },
    statItem: {
      alignItems: 'center',
    },
    statNumber: {
      fontSize: 20,
      fontWeight: 'bold',
      color: theme.text,
    },
    statNumberPrimary: {
      color: theme.primary,
    },
    statNumberSuccess: {
      color: theme.success,
    },
    statNumberError: {
      color: theme.error,
    },
    statNumberWarning: {
      color: theme.warning,
    },
    statNumberSecondary: {
      color: theme.textSecondary,
    },
    statLabel: {
      fontSize: 12,
      color: theme.textSecondary,
      marginTop: 4,
    },
    filterContainer: {
      flexDirection: 'row',
      padding: 15,
      backgroundColor: theme.surface,
      gap: 10,
    },
    filterRow: {
      flexDirection: 'row',
      gap: 10,
    },
    filterButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
    },
    resultCountChip: {
      paddingHorizontal: 14,
    },
    resultCountChipTone: {
      backgroundColor: theme.background,
      borderColor: theme.primary,
    },
    resultCountText: {
      fontSize: 12,
    },
    resultCountTextTone: {
      color: theme.primary,
    },
    filterButtonActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    filterButtonText: {
      fontSize: 14,
      color: theme.text,
    },
    filterButtonTextActive: {
      color: '#ffffff',
    },
    refreshButton: {
      padding: 8,
      borderRadius: 8,
      backgroundColor: theme.primary,
      marginLeft: 'auto',
    },
    primaryBorder: {
      borderColor: theme.primary,
    },
    primaryText: {
      color: theme.primary,
    },
    listContainer: {
      flex: 1,
    },
    historyItem: {
      padding: 15,
      marginHorizontal: 15,
      marginVertical: 5,
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
    },
    historyHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    studentInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    studentName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.text,
      marginLeft: 8,
    },
    statusContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    historyDetails: {
      marginTop: 8,
    },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
      gap: 8,
    },
    detailText: {
      fontSize: 14,
      color: theme.textSecondary,
    },
    amountText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.primary,
    },
    messagePreview: {
      fontSize: 12,
      color: theme.textSecondary,
      fontStyle: 'italic',
      marginTop: 8,
      lineHeight: 16,
    },
    errorText: {
      fontSize: 12,
      color: theme.error,
      marginTop: 4,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 40,
      backgroundColor: theme.background,
    },
    emptyStateText: {
      fontSize: 16,
      color: theme.textSecondary,
      textAlign: 'center',
      marginTop: 15,
    },
    loadMoreContainer: {
      padding: 20,
      alignItems: 'center',
      backgroundColor: theme.surface,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    loadMoreButton: {
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 8,
      borderWidth: 1,
      backgroundColor: theme.background,
      alignItems: 'center',
    },
    loadMoreText: {
      fontSize: 14,
      fontWeight: '600',
    },
    loadingMoreText: {
      fontSize: 14,
      color: theme.textSecondary,
      marginTop: 8,
    },
    endOfListText: {
      fontSize: 14,
      color: theme.textSecondary,
      fontStyle: 'italic',
    },
    errorRefreshButton: {
      marginTop: 15,
    },
    clearSearchChip: {
      marginTop: 15,
    },
    emptyStateErrorText: {
      color: theme.error,
    },
  }), [theme]);

  // Render individual reminder item
  const renderReminderItem = useCallback(({ item }: { item: ReminderHistoryEntry }) => {
    const displayInfo = historyDisplayInfo.get(item);

    return (
      <ReminderHistoryListItem
        item={item}
        styles={styles}
        formattedDate={displayInfo?.formattedDate ?? ''}
        amountLabel={displayInfo?.amountLabel ?? ''}
        textColor={theme.text}
        textSecondaryColor={theme.textSecondary}
        successColor={theme.success}
        errorColor={theme.error}
        warningColor={theme.warning}
      />
    );
  }, [
    styles,
    historyDisplayInfo,
    theme.text,
    theme.textSecondary,
    theme.success,
    theme.error,
    theme.warning,
  ]);

  const hasFilteredItems = filteredHistory.length > 0;

  const listFooterComponent = useMemo(() => {
    return (
      <ReminderHistoryFooterSection
        styles={styles}
        hasMore={hasMore}
        loadingMore={loadingMore}
        loading={loading}
        hasFilteredItems={hasFilteredItems}
        onLoadMore={handleLoadMore}
        primaryColor={theme.primary}
      />
    );
  }, [handleLoadMore, hasFilteredItems, hasMore, loading, loadingMore, styles, theme.primary]);

  const statToneStyles = useMemo(() => {
    return {
      primary: styles.statNumberPrimary,
      success: styles.statNumberSuccess,
      error: styles.statNumberError,
      warning: styles.statNumberWarning,
      secondary: styles.statNumberSecondary,
    } as Record<ReminderStatTone, object>;
  }, [styles]);

  const statsSection = useMemo(() => {
    return (
      <View style={styles.statsContainer}>
        {statsCards.map(card => (
          <View key={card.key} style={styles.statItem}>
            <Text style={[styles.statNumber, statToneStyles[card.tone]]}>
              {card.value}
            </Text>
            <Text style={styles.statLabel}>{card.label}</Text>
          </View>
        ))}
        {statsLoading && (
          <View style={styles.statItem}>
            <ActivityIndicator size="small" color={theme.textSecondary} />
          </View>
        )}
      </View>
    );
  }, [statsCards, statsLoading, statToneStyles, styles, theme.textSecondary]);

  const scopeToggleButton = useMemo(() => {
    if (!((user?.role === 'admin') || allowAllForNonAdmins)) {
      return null;
    }

    return (
      <TouchableOpacity
        onPress={handleScopeToggle}
        style={[styles.filterButton, styles.scopeToggleButton]}
      >
        <Text allowFontScaling={false} style={[styles.filterButtonText, styles.scopeToggleText]}>
          {scope === 'mine' ? 'My Reminders' : 'All Reminders'}
        </Text>
      </TouchableOpacity>
    );
  }, [allowAllForNonAdmins, handleScopeToggle, scope, styles, user?.role]);

  const windowDayFilterButtons = useMemo(() => {
    return WINDOW_DAY_OPTIONS.map(v => (
      <TouchableOpacity
        key={`win-${v}`}
        style={[
          styles.filterButton,
          (windowDaysValue === v) && styles.filterButtonActive
        ]}
        onPress={windowDaysPressHandlers[v]}
      >
        <Text style={[
          styles.filterButtonText,
          (windowDaysValue === v) && styles.filterButtonTextActive
        ]}>
          {v === 'all' ? 'All Time' : `${v}d`}
        </Text>
      </TouchableOpacity>
    ));
  }, [styles, windowDaysPressHandlers, windowDaysValue]);

  const statusFilterButtons = useMemo(() => {
    return STATUS_FILTER_OPTIONS.map(status => (
      <TouchableOpacity
        key={status}
        style={[
          styles.filterButton,
          filter === status && styles.filterButtonActive
        ]}
        onPress={statusPressHandlers[status]}
      >
        <Text style={[
          styles.filterButtonText,
          filter === status && styles.filterButtonTextActive
        ]}>
          {STATUS_FILTER_LABELS[status]}
        </Text>
      </TouchableOpacity>
    ));
  }, [filter, statusPressHandlers, styles]);

  const typeFilterButtons = useMemo(() => {
    return TYPE_FILTER_OPTIONS.map(type => (
      <TouchableOpacity
        key={type}
        style={[
          styles.filterButton,
          typeFilter === type && styles.filterButtonActive
        ]}
        onPress={typePressHandlers[type]}
      >
        <Text style={[
          styles.filterButtonText,
          typeFilter === type && styles.filterButtonTextActive
        ]}>
          {TYPE_FILTER_LABELS[type]}
        </Text>
      </TouchableOpacity>
    ));
  }, [styles, typeFilter, typePressHandlers]);

  const searchResultCountChip = useMemo(() => {
    if (!trimmedSearchQuery || totalMatchingResults === null) {
      return null;
    }

    return (
      <View
        style={[
          styles.filterButton,
          styles.resultCountChipTone,
          styles.resultCountChip,
        ]}
      >
        <Text
          style={[
            styles.filterButtonText,
            styles.resultCountTextTone,
            styles.resultCountText,
          ]}
        >
          {totalMatchingResults} result{totalMatchingResults !== 1 ? 's' : ''}
        </Text>
      </View>
    );
  }, [styles, totalMatchingResults, trimmedSearchQuery]);

  const listEmptyComponent = useMemo(() => {
    return (
      <ReminderHistoryEmptyStateSection
        styles={styles}
        loading={loading}
        primaryColor={theme.primary}
        textSecondaryColor={theme.textSecondary}
        trimmedSearchQuery={trimmedSearchQuery}
        onClearSearch={clearSearchQuery}
      />
    );
  }, [clearSearchQuery, loading, styles, theme.primary, theme.textSecondary, trimmedSearchQuery]);

  if (error) {
    return (
      <View style={styles.emptyState}>
        <XCircle size={48} color={theme.error} />
        <Text style={[styles.emptyStateText, styles.emptyStateErrorText]}> 
          {error}
        </Text>
        <TouchableOpacity
          style={[styles.refreshButton, styles.errorRefreshButton]}
          onPress={handleRefresh}
        >
          <RefreshCw size={16} color="#ffffff" />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ReminderHistoryHeaderSection
        styles={styles}
        themeText={theme.text}
        themeTextSecondary={theme.textSecondary}
        scopeToggleButton={scopeToggleButton}
        onClose={onClose}
        searchQuery={searchQuery}
        onSearchQueryChange={handleSearchQueryChange}
        onClearSearch={clearSearchQuery}
        statsSection={statsSection}
      />

      <ReminderHistoryFiltersSection
        styles={styles}
        windowDayFilterButtons={windowDayFilterButtons}
        searchResultCountChip={searchResultCountChip}
        statusFilterButtons={statusFilterButtons}
        typeFilterButtons={typeFilterButtons}
        onRefreshWithFilters={handleRefreshWithFilters}
        loading={loading}
      />

      {/* History List */}
      <FlatList
        style={styles.listContainer}
        data={filteredHistory}
        renderItem={renderReminderItem}
        keyExtractor={keyExtractor}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews={true}
        maxToRenderPerBatch={20}
        windowSize={10}
        initialNumToRender={20}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.1}
        ListEmptyComponent={listEmptyComponent}
        ListFooterComponent={listFooterComponent}
      />
    </View>
  );
}
