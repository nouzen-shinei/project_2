import { logger } from '@/lib/logger';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
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
  Filter,
  RefreshCw,
  Search,
  X,
} from 'lucide-react-native';
import { FontAwesome } from '@expo/vector-icons';
import { useTheme } from '../hooks/useTheme';
import { useReminderHistory } from '../hooks/useReminderHistory';
import { useAuth } from '../hooks/useAuthUnified';
import { settingsService } from '../services/settingsService';
import { ReminderHistoryEntry, reminderHistoryService } from '../services/reminderHistoryService';

interface ReminderHistoryViewerProps {
  studentId?: string;
  reminderType?: string;
  limit?: number;
  onClose?: () => void;
}

export default function ReminderHistoryViewer({ 
  studentId, 
  reminderType, 
  limit = 20,
  onClose 
}: ReminderHistoryViewerProps) {
  const { theme } = useTheme();
  const { user } = useAuth();
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
    refresh 
  } = useReminderHistory();
  
  const [filter, setFilter] = useState<'all' | 'success' | 'failed' | 'pending'>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [allowAllForNonAdmins, setAllowAllForNonAdmins] = useState<boolean>(false);
  const [windowDays, setWindowDays] = useState<7 | 30 | 90 | 'all'>(30);

  useEffect(() => {
    // Keep server filters (type/status/scope) in sync and set currentSearchRef
  loadHistory(limit, studentId, typeFilter, filter, searchQuery, windowDays, scope === 'all');
    // Update stats for current filters (excluding search); debounced effect handles search
    loadStats(windowDays);
  }, [loadHistory, loadStats, limit, studentId, typeFilter, filter, scope, windowDays]);

  // Debounce search text and refresh stats for full-dataset counts
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    // Update stats to reflect current search across all matches
    loadStats(windowDays, { searchQuery: debouncedSearch });
  }, [debouncedSearch, windowDays, loadStats]);

  // Load app setting to decide if non-admins can see All scope
  useEffect(() => {
    (async () => {
      try {
        const appSettings = await settingsService.getSettings();
        setAllowAllForNonAdmins(!!appSettings.allowNonAdminAllReminderHistory);
      } catch (e) {
        setAllowAllForNonAdmins(false);
      }
    })();
  }, []);

  // Filter history based on current filters and search
  const filteredHistory = useMemo(() => {
    return history.filter(entry => {
      if (filter !== 'all' && entry.status !== filter) return false;
      if (typeFilter !== 'all' && entry.reminderType !== typeFilter) return false;
      
      // Search functionality
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchesStudentName = entry.studentName?.toLowerCase().includes(query);
        const matchesParentName = entry.parentName?.toLowerCase().includes(query);
        const matchesContact = entry.parentContact?.includes(query);
        const matchesEmail = entry.parentEmail?.toLowerCase().includes(query);
        const matchesMessage = entry.message?.toLowerCase().includes(query);
        const matchesAmount = entry.amount?.toString().includes(query);
        const matchesFeeCategories = entry.feeCategories?.some(category => 
          category.toLowerCase().includes(query)
        );
        const matchesReminderType = entry.reminderType?.toLowerCase().includes(query);
        const matchesStatus = entry.status?.toLowerCase().includes(query);
        const matchesErrorMessage = entry.errorMessage?.toLowerCase().includes(query);
        
        // Also search in formatted date
        let matchesDate = false;
        try {
          const formattedDate = formatDate(entry.createdAt).toLowerCase();
          matchesDate = formattedDate.includes(query);
        } catch (e) {
          // Ignore date formatting errors for search
        }
        
        if (!matchesStudentName && !matchesParentName && !matchesContact && 
            !matchesEmail && !matchesMessage && !matchesAmount && !matchesFeeCategories &&
            !matchesReminderType && !matchesStatus && !matchesErrorMessage && !matchesDate) {
          return false;
        }
      }
      
      return true;
    });
  }, [history, filter, typeFilter, searchQuery]);

  const trimmedSearchQuery = searchQuery.trim();
  const debouncedTrimmedSearch = debouncedSearch.trim();
  const isStatsSyncedWithSearch = trimmedSearchQuery === debouncedTrimmedSearch;
  const totalMatchingResults = trimmedSearchQuery
    ? (isStatsSyncedWithSearch && !statsLoading ? stats.totalReminders : null)
    : null;

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle size={16} color={theme.success} />;
      case 'failed':
        return <XCircle size={16} color={theme.error} />;
      default:
        return <Clock size={16} color={theme.warning} />;
    }
  };

  const getTypeIcon = (type: string) => {
    const iconSize = 16;
    const iconColor = theme.text;
    
    switch (type) {
      case 'email':
        return <Mail size={iconSize} color={iconColor} />;
      case 'sms':
        return <MessageSquare size={iconSize} color={iconColor} />;
      case 'whatsapp':
        return <FontAwesome name="whatsapp" size={iconSize} color={iconColor} />;
      case 'voice':
        return <PhoneCall size={iconSize} color={iconColor} />;
      default:
        return <Phone size={iconSize} color={iconColor} />;
    }
  };

  // Debug logging
  useEffect(() => {
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
  }, [history, filteredHistory, filter, typeFilter, searchQuery, stats, loading, error]);

  const formatDate = (timestamp: any) => {
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
  };

  const formatCurrency = (amount: number) => {
    return `₹${amount.toLocaleString()}`;
  };

  // Handle load more functionality
  const handleLoadMore = useCallback(() => {
    if (hasMore && !loadingMore && !loading) {
      loadMoreHistory();
    }
  }, [hasMore, loadingMore, loading, loadMoreHistory]);

  // Handle refresh with filters
  const handleRefreshWithFilters = useCallback(async () => {
    try {
    setFilter('all');
    setSearchQuery('');
  await loadHistory(limit, studentId, typeFilter, 'all', '', windowDays, scope === 'all');
    await loadStats(windowDays);
    } catch (err) {
      Alert.alert('Error', 'Failed to refresh reminder history');
    }
  }, [loadHistory, loadStats, limit, studentId, typeFilter, scope, windowDays]);

  // Render individual reminder item
  const renderReminderItem = useCallback(({ item }: { item: ReminderHistoryEntry }) => (
    <View style={styles.historyItem}>
      <View style={styles.historyHeader}>
        <View style={styles.studentInfo}>
          <User size={16} color={theme.textSecondary} />
          <Text style={styles.studentName}>{item.studentName}</Text>
        </View>
        <View style={styles.statusContainer}>
          {getTypeIcon(item.reminderType)}
          {getStatusIcon(item.status)}
        </View>
      </View>

      <View style={styles.historyDetails}>
        <View style={styles.detailRow}>
          <Calendar size={14} color={theme.textSecondary} />
          <Text style={styles.detailText}>
            {formatDate(item.createdAt)}
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
          <Text style={styles.detailText}>Amount: {formatCurrency(item.amount)}</Text>
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
  ), [theme, formatDate, formatCurrency, getTypeIcon, getStatusIcon]);

  // Render load more footer
  const renderFooter = useCallback(() => {
    if (!hasMore && filteredHistory.length > 0) {
      return (
        <View style={styles.loadMoreContainer}>
          <Text style={styles.endOfListText}>No more reminders to load</Text>
        </View>
      );
    }

    if (loadingMore) {
      return (
        <View style={styles.loadMoreContainer}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={styles.loadingMoreText}>Loading more reminders...</Text>
        </View>
      );
    }

    if (hasMore && filteredHistory.length > 0) {
      return (
        <View style={styles.loadMoreContainer}>
          <TouchableOpacity
            style={[styles.loadMoreButton, { borderColor: theme.primary }]}
            onPress={handleLoadMore}
            disabled={loadingMore || loading}
          >
            <Text style={[styles.loadMoreText, { color: theme.primary }]}>
              Load More Reminders
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    return null;
  }, [hasMore, loadingMore, loading, filteredHistory.length, theme, handleLoadMore]);

  // Key extractor for FlatList
  const keyExtractor = useCallback((item: ReminderHistoryEntry, index: number) => {
    return item.id || `reminder-${index}`;
  }, []);

  const handleRefresh = async () => {
    try {
      await refresh();
    } catch (err) {
      Alert.alert('Error', 'Failed to refresh reminder history');
    }
  };

  const styles = StyleSheet.create({
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
    closeButton: {
      padding: 6,
      borderRadius: 6,
      backgroundColor: theme.background,
      borderWidth: 1,
      borderColor: theme.border,
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
    filterButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.border,
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
  });

  if (error) {
    return (
      <View style={styles.emptyState}>
        <XCircle size={48} color={theme.error} />
        <Text style={[styles.emptyStateText, { color: theme.error }]}>
          {error}
        </Text>
        <TouchableOpacity
          style={[styles.refreshButton, { marginTop: 15 }]}
          onPress={handleRefresh}
        >
          <RefreshCw size={16} color="#ffffff" />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header with Stats */}
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text allowFontScaling={false} style={styles.headerTitle}>Reminder History</Text>
          {((user?.role === 'admin') || allowAllForNonAdmins) && (
            <TouchableOpacity
              onPress={() => {
                const newScope = scope === 'mine' ? 'all' : 'mine';
                setScope(newScope);
                loadHistory(limit, studentId, typeFilter, filter, searchQuery, windowDays, newScope === 'all');
                loadStats(windowDays);
              }}
              style={[styles.filterButton, { marginLeft: 10 }]}
            >
              <Text allowFontScaling={false} style={[styles.filterButtonText, { fontSize: 12 }]}>{scope === 'mine' ? 'My Reminders' : 'All Reminders'}</Text>
            </TouchableOpacity>
          )}
          {onClose && (
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeButton}
            >
              <X size={18} color={theme.text} />
            </TouchableOpacity>
          )}
        </View>
        
        {/* Search Input */}
        <View style={styles.searchContainer}>
          <Search size={20} color={theme.textSecondary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search by student, parent, contact, amount, date, status..."
            placeholderTextColor={theme.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              style={{ padding: 5 }}
            >
              <X size={18} color={theme.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
        
        <View style={styles.statsContainer}>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.primary }]}>
              {stats.totalReminders}
            </Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.success }]}>
              {stats.successfulReminders}
            </Text>
            <Text style={styles.statLabel}>Successful</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.error }]}>
              {stats.failedReminders}
            </Text>
            <Text style={styles.statLabel}>Failed</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.warning }]}>
              {stats.pendingReminders}
            </Text>
            <Text style={styles.statLabel}>Pending</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.textSecondary }]}>
              {stats.totalReminders > 0
                ? Math.round((stats.successfulReminders / stats.totalReminders) * 100)
                : 0}%
            </Text>
            <Text style={styles.statLabel}>Success Rate</Text>
          </View>
          {statsLoading && (
            <View style={styles.statItem}>
              <ActivityIndicator size="small" color={theme.textSecondary} />
            </View>
          )}
        </View>
      </View>

      {/* Filters */}
      <View style={styles.filterContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {/* Time Window Selector */}
            {(['7','30','90','all'] as const).map(v => (
              <TouchableOpacity
                key={`win-${v}`}
                style={[
                  styles.filterButton,
                  (String(windowDays) === v) && styles.filterButtonActive
                ]}
                onPress={() => setWindowDays((v === 'all' ? 'all' : Number(v)) as any)}
              >
                <Text style={[
                  styles.filterButtonText,
                  (String(windowDays) === v) && styles.filterButtonTextActive
                ]}>
                  {v === 'all' ? 'All Time' : `${v}d`}
                </Text>
              </TouchableOpacity>
            ))}

            {/* Search Results Count */}
            {trimmedSearchQuery && totalMatchingResults !== null && (
              <View
                style={[
                  styles.filterButton,
                  {
                    backgroundColor: theme.background,
                    borderColor: theme.primary,
                    paddingHorizontal: 14,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.filterButtonText,
                    { color: theme.primary, fontSize: 12 },
                  ]}
                >
                  {totalMatchingResults} result{totalMatchingResults !== 1 ? 's' : ''}
                </Text>
              </View>
            )}
            
            {/* Status Filters */}
            {['all', 'success', 'failed', 'pending'].map(status => (
              <TouchableOpacity
                key={status}
                style={[
                  styles.filterButton,
                  filter === status && styles.filterButtonActive
                ]}
                onPress={() => {
                  setFilter(status as any);
                  loadHistory(limit, studentId, typeFilter, status as any, searchQuery, windowDays, scope === 'all');
                  loadStats(windowDays);
                }}
              >
                <Text style={[
                  styles.filterButtonText,
                  filter === status && styles.filterButtonTextActive
                ]}>
                  {status === 'all' ? 'All Status' : status.charAt(0).toUpperCase() + status.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}

            {/* Type Filters */}
            {['all', 'email', 'sms', 'whatsapp', 'voice'].map(type => (
              <TouchableOpacity
                key={type}
                style={[
                  styles.filterButton,
                  typeFilter === type && styles.filterButtonActive
                ]}
                onPress={() => {
                  setTypeFilter(type);
                  loadHistory(limit, studentId, type, filter, searchQuery, windowDays, scope === 'all');
                  loadStats(windowDays);
                }}
              >
                <Text style={[
                  styles.filterButtonText,
                  typeFilter === type && styles.filterButtonTextActive
                ]}>
                  {type === 'all' ? 'All Types' : type.charAt(0).toUpperCase() + type.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        <TouchableOpacity
          style={styles.refreshButton}
          onPress={handleRefreshWithFilters}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator size={16} color="#ffffff" />
          ) : (
            <RefreshCw size={16} color="#ffffff" />
          )}
        </TouchableOpacity>
      </View>

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
        ListEmptyComponent={() => (
          <View style={styles.emptyState}>
            {loading ? (
              <ActivityIndicator size="large" color={theme.primary} />
            ) : (
              <>
                <Clock size={48} color={theme.textSecondary} />
                <Text style={styles.emptyStateText}>
                  {searchQuery.trim()
                    ? `No reminders found matching "${searchQuery}"`
                    : 'No reminder history found for the selected filters'}
                </Text>
              </>
            )}
            {searchQuery.trim() && (
              <TouchableOpacity
                style={[styles.filterButton, { marginTop: 15, borderColor: theme.primary }]}
                onPress={() => setSearchQuery('')}
              >
                <Text style={[styles.filterButtonText, { color: theme.primary }]}>
                  Clear Search
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        ListFooterComponent={renderFooter}
      />
    </View>
  );
}
