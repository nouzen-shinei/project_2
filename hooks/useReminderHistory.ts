import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useAuthUnified';
import { reminderHistoryService, ReminderHistoryEntry, ReminderBatch } from '../services/reminderHistoryService';
import { QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';
import { useTenant } from './useTenantContext';

export interface ReminderHistoryStats {
  totalReminders: number;
  successfulReminders: number;
  failedReminders: number;
  pendingReminders: number;
  remindersByType: Record<string, number>;
  remindersByStatus: Record<string, number>;
}

export function useReminderHistory() {
  const { user } = useAuth();
  const { activeTenant } = useTenant();
  const [history, setHistory] = useState<ReminderHistoryEntry[]>([]);
  const [batches, setBatches] = useState<ReminderBatch[]>([]);
  const [stats, setStats] = useState<ReminderHistoryStats>({
    totalReminders: 0,
    successfulReminders: 0,
    failedReminders: 0,
    pendingReminders: 0,
    remindersByType: {},
    remindersByStatus: {},
  });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [statsLoading, setStatsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [currentFilters, setCurrentFilters] = useState<{
    studentId?: string;
    reminderType?: string;
    status?: string;
    searchQuery?: string;
  }>({});

  // Use refs to avoid dependency issues
  const lastDocumentRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);
  const currentFiltersRef = useRef(currentFilters);
  const currentAllUsersRef = useRef<boolean>(false);
  const currentStudentIdRef = useRef<string | undefined>(undefined);
  const currentReminderTypeRef = useRef<string | undefined>(undefined);
  const currentStatusRef = useRef<string | undefined>(undefined);
  const currentSearchRef = useRef<string | undefined>(undefined);
  const currentDaysRef = useRef<number | 'all' | undefined>(30);

  // Update refs when state changes
  useEffect(() => {
    currentFiltersRef.current = currentFilters;
  }, [currentFilters]);

  // Load reminder history with pagination
  const loadHistory = useCallback(async (
    pageSize?: number,
    studentId?: string,
    reminderType?: string,
  status?: string,
  searchQuery?: string,
    days?: number | 'all',
    allUsers: boolean = false,
    reset: boolean = false
  ) => {
  const tenantId = activeTenant?.id;
  if (!tenantId) {
    if (reset) {
      setHistory([]);
    }
    setHasMore(false);
    setError('Select a coaching center to view reminders');
    setLoading(false);
    setLoadingMore(false);
    return;
  }
  // If requesting allUsers, pass null as userId to the service
  if (!user?.uid && !allUsers) return;

    try {
      if (reset) {
        setLoading(true);
        setHistory([]);
        lastDocumentRef.current = null;
        setHasMore(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      const filters = {
        studentId,
        reminderType: reminderType === 'all' ? undefined : reminderType,
        status: status === 'all' ? undefined : status,
        searchQuery: (searchQuery || '').trim() || undefined,
        days: days ?? currentDaysRef.current,
      };
  setCurrentFilters(filters);
  currentAllUsersRef.current = allUsers;
      currentStudentIdRef.current = studentId;
      currentReminderTypeRef.current = reminderType === 'all' ? undefined : reminderType;
      currentStatusRef.current = status === 'all' ? undefined : status;
      currentSearchRef.current = (searchQuery || '').trim() || undefined;
      currentDaysRef.current = filters.days ?? 30;

    const result = await reminderHistoryService.getPaginatedReminderHistory(
      tenantId,
      allUsers ? null : user?.uid || null,
        pageSize || 20,
    reset ? undefined : lastDocumentRef.current || undefined,
  filters
      );

      logger.debug('useReminderHistory - Loaded data:', {
        resultCount: result.reminders.length,
        hasMore: result.hasMore,
        userUid: user?.uid || null,
        pageSize: pageSize || 20,
        filters,
        reset
      });

      if (reset) {
        setHistory(result.reminders);
      } else {
        setHistory(prev => [...prev, ...result.reminders]);
      }
      
      lastDocumentRef.current = result.lastDocument;
      setHasMore(result.hasMore);
    } catch (err) {
      logger.error('Error loading reminder history:', err);
      setError(err instanceof Error ? err.message : 'Failed to load reminder history');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [user?.uid, activeTenant?.id]);

  // Load more reminders
  const loadMoreHistory = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;

    await loadHistory(
      20,
      currentFiltersRef.current.studentId,
      currentFiltersRef.current.reminderType,
      currentFiltersRef.current.status,
      currentFiltersRef.current.searchQuery,
      currentDaysRef.current,
      currentAllUsersRef.current,
      false
    );
  }, [loadHistory, hasMore, loadingMore, loading]);

  // Reset and reload history
  const resetAndLoadHistory = useCallback(async (
    pageSize?: number,
    studentId?: string,
    reminderType?: string,
  status?: string,
  searchQuery?: string,
    days?: number | 'all',
    allUsers: boolean = false
  ) => {
  await loadHistory(pageSize, studentId, reminderType, status, searchQuery, days, allUsers, true);
  }, [loadHistory]);

  // Load reminder batches
  const loadBatches = useCallback(async (limit?: number) => {
    if (!user?.uid) return;
    const tenantId = activeTenant?.id;
    if (!tenantId) {
      setBatches([]);
      setLoading(false);
      setError('Select a coaching center to view reminder batches');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const reminderBatches = await reminderHistoryService.getReminderBatches(tenantId, user.uid, limit);
      setBatches(reminderBatches);
    } catch (err) {
      logger.error('Error loading reminder batches:', err);
      setError(err instanceof Error ? err.message : 'Failed to load reminder batches');
    } finally {
      setLoading(false);
    }
  }, [user?.uid, activeTenant?.id]);

  // Load reminder statistics
  const loadStats = useCallback(async (days: number | 'all' = 30, override?: { searchQuery?: string }) => {
    if (!user?.uid && !currentAllUsersRef.current) return;
    const tenantId = activeTenant?.id;
    if (!tenantId) {
      setStatsLoading(false);
      setStats({
        totalReminders: 0,
        successfulReminders: 0,
        failedReminders: 0,
        pendingReminders: 0,
        remindersByType: {},
        remindersByStatus: {},
      });
      setError('Select a coaching center to view reminder statistics');
      return;
    }

    try {
      setStatsLoading(true);
      setError(null);

    const reminderStats = await reminderHistoryService.getReminderStats(
        tenantId,
        currentAllUsersRef.current ? null : (user?.uid || null),
        days,
        {
          studentId: currentStudentIdRef.current,
          reminderType: currentReminderTypeRef.current,
    status: currentFiltersRef.current.status as any,
    searchQuery: (override?.searchQuery ?? currentSearchRef.current),
        }
      );
      setStats(reminderStats);
    } catch (err) {
      logger.error('Error loading reminder stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to load reminder stats');
    } finally {
  setStatsLoading(false);
    }
  }, [user?.uid, activeTenant?.id]);

  // Get history for a specific student
  const getStudentHistory = useCallback(async (studentId: string, limit?: number, scope: 'mine' | 'all' = 'all') => {
    // For dashboard/fees views we want to see all users by default
    // scope='mine' preserves legacy behavior
    const userFilter = scope === 'mine' ? (user?.uid || null) : null;
    const tenantId = activeTenant?.id;
    if (!tenantId) {
      return [];
    }

    try {
      const studentHistory = await reminderHistoryService.getReminderHistory(
        tenantId,
        userFilter,
        limit,
        studentId
      );
      return studentHistory;
    } catch (err) {
      logger.error('Error loading student reminder history:', err);
      return [];
    }
  }, [user?.uid, activeTenant?.id]);

  // Get recent reminders
  const getRecentReminders = useCallback(async (limit: number = 10, scope: 'mine' | 'all' = 'all') => {
    // Default to all users for dashboard display
    const userFilter = scope === 'mine' ? (user?.uid || null) : null;
    const tenantId = activeTenant?.id;
    if (!tenantId) {
      return [];
    }

    try {
      const recentReminders = await reminderHistoryService.getReminderHistory(tenantId, userFilter, limit);
      return recentReminders;
    } catch (err) {
      logger.error('Error loading recent reminders:', err);
      return [];
    }
  }, [user?.uid, activeTenant?.id]);

  // Refresh all data
  const refresh = useCallback(async () => {
    await Promise.all([
      resetAndLoadHistory(
        50,
        currentStudentIdRef.current,
        currentReminderTypeRef.current,
        currentStatusRef.current,
  currentSearchRef.current,
  currentDaysRef.current,
  currentAllUsersRef.current
      ),
      loadBatches(20),
      loadStats((currentDaysRef.current ?? 30) as any),
    ]);
  }, [resetAndLoadHistory, loadBatches, loadStats]);

  // Load initial data when user is available
  useEffect(() => {
    if (user?.uid && activeTenant?.id) {
      refresh();
    } else if (!activeTenant?.id) {
      setHistory([]);
      setBatches([]);
      setStats({
        totalReminders: 0,
        successfulReminders: 0,
        failedReminders: 0,
        pendingReminders: 0,
        remindersByType: {},
        remindersByStatus: {},
      });
      setHasMore(false);
    }
  }, [user?.uid, activeTenant?.id, refresh]);

  return {
    // Data
    history,
    batches,
    stats,
    
    // State
    loading,
    loadingMore,
  statsLoading,
    error,
    hasMore,
    
    // Methods
    loadHistory: resetAndLoadHistory,
    loadMoreHistory,
    loadBatches,
    loadStats,
    getStudentHistory,
    getRecentReminders,
    refresh,
    
    // Utilities
    isAuthenticated: !!user?.uid,
  };
}
