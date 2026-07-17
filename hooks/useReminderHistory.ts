import { logger } from '@/lib/logger';
import { isPermissionDeniedError } from '@/lib/firestoreErrors';
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

export function useReminderHistory(options?: { autoload?: boolean }) {
  // PERF (P7): callers that only need getStudentHistory/getRecentReminders/
  // canViewAllReminders (dashboard, fees) can pass { autoload: false } to skip the
  // mount-time history + batches + stats fetches they never render.
  const autoload = options?.autoload ?? true;
  const { user } = useAuth();
  const { activeTenant, activeMembership, refreshTenants } = useTenant();

  // Mirror the Firestore `reminderHistory` read rule exactly: only a global admin,
  // a tenant owner/admin, or (when the tenant flag is enabled) an active member may
  // read across all users. Everyone else is clamped to their OWN reminders so that
  // dashboard/fees "all users" reads don't trigger permission-denied errors.
  const canViewAllReminders =
    user?.role === 'admin' ||
    activeMembership?.role === 'owner' ||
    activeMembership?.role === 'admin' ||
    !!activeTenant?.settings?.allowNonAdminAllReminderHistory;

  // The tenant doc is fetched once and cached (see useTenantContext.loadTenantsFor),
  // so a settings change made elsewhere — e.g. an admin turning OFF the non-admin
  // "all reminders" flag — does NOT propagate to this client until the tenant is
  // re-fetched. If the server actually denies an 'all'-scope read, our cached
  // `canViewAllReminders` is stale; force-refresh the tenant so it recomputes to
  // false and every reminder read (here, on the dashboard, and on fees) clamps to
  // the caller's own data. Guarded so we only refresh once per stale window.
  const allScopeDeniedRefreshRef = useRef(false);
  useEffect(() => {
    allScopeDeniedRefreshRef.current = false;
  }, [activeTenant?.id, activeTenant?.settings?.allowNonAdminAllReminderHistory, activeMembership?.role, user?.role]);
  const handleAllScopeDenied = useCallback(() => {
    if (allScopeDeniedRefreshRef.current) return;
    allScopeDeniedRefreshRef.current = true;
    void Promise.resolve(refreshTenants?.()).catch(() => {});
  }, [refreshTenants]);
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
  // Clamp an 'all users' request down to the current user unless they are actually
  // authorized to read all reminders (mirrors the Firestore rule). This keeps the
  // request rule-compatible instead of failing with permission-denied.
  const effectiveAllUsers = allUsers && canViewAllReminders;
  if (!user?.uid && !effectiveAllUsers) return;

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
  currentAllUsersRef.current = effectiveAllUsers;
      currentStudentIdRef.current = studentId;
      currentReminderTypeRef.current = reminderType === 'all' ? undefined : reminderType;
      currentStatusRef.current = status === 'all' ? undefined : status;
      currentSearchRef.current = (searchQuery || '').trim() || undefined;
      currentDaysRef.current = filters.days ?? 30;

    const result = await reminderHistoryService.getPaginatedReminderHistory(
      tenantId,
      effectiveAllUsers ? null : user?.uid || null,
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
      if (isPermissionDeniedError(err) && effectiveAllUsers) {
        // Expected/benign: an 'all users' read the caller isn't authorized for.
        // Degrade to an empty result and self-heal the (likely stale) tenant flag.
        // The service already logged this at debug, so we don't re-log or surface it.
        handleAllScopeDenied();
        if (reset) {
          setHistory([]);
        }
        setHasMore(false);
        setError(null);
      } else {
        // A self-scoped permission-denied (unexpected) OR any non-permission failure.
        // The service logged it loudly; surface it on screen so a real problem isn't
        // hidden as "no reminders".
        setError(err instanceof Error ? err.message : 'Failed to load reminder history');
      }
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [user?.uid, activeTenant?.id, canViewAllReminders, handleAllScopeDenied]);

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
    const statsAllUsers = currentAllUsersRef.current && canViewAllReminders;
    if (!user?.uid && !statsAllUsers) return;
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
        statsAllUsers ? null : (user?.uid || null),
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
      if (isPermissionDeniedError(err) && statsAllUsers) {
        // Expected/benign all-scope stats denial. Reset to zero and self-heal the
        // (likely stale) tenant flag. The service already logged this at debug.
        handleAllScopeDenied();
        setStats({
          totalReminders: 0,
          successfulReminders: 0,
          failedReminders: 0,
          pendingReminders: 0,
          remindersByType: {},
          remindersByStatus: {},
        });
        setError(null);
      } else {
        // A self-scoped permission-denied (unexpected) — the service logged it loudly;
        // surface it so a real regression isn't hidden as "zero reminders".
        setError(err instanceof Error ? err.message : 'Failed to load reminder stats');
      }
    } finally {
  setStatsLoading(false);
    }
  }, [user?.uid, activeTenant?.id, canViewAllReminders, handleAllScopeDenied]);

  // Get history for a specific student
  const getStudentHistory = useCallback(async (studentId: string, limit?: number, scope: 'mine' | 'all' = 'all') => {
    // For dashboard/fees views we want to see all users by default, but only if the
    // current user is authorized to (mirrors the Firestore rule). Otherwise clamp to
    // their own reminders so the read doesn't get rejected.
    const readsAllUsers = scope === 'all' && canViewAllReminders;
    const userFilter = readsAllUsers ? null : (user?.uid || null);
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
      // Only an all-scope denial is benign — self-heal the likely-stale tenant flag.
      // A self-scoped denial was already logged loudly by the service. Either way this
      // is a secondary widget, so return empty (the primary list surfaces real errors).
      if (isPermissionDeniedError(err) && readsAllUsers) {
        handleAllScopeDenied();
      }
      return [];
    }
  }, [user?.uid, activeTenant?.id, canViewAllReminders, handleAllScopeDenied]);

  // Get recent reminders
  const getRecentReminders = useCallback(async (limit: number = 10, scope: 'mine' | 'all' = 'all') => {
    // Default to all users for dashboard display, but only when the current user is
    // authorized to read all reminders (mirrors the Firestore rule). Otherwise clamp
    // to their own reminders to avoid a permission-denied read.
    const readsAllUsers = scope === 'all' && canViewAllReminders;
    const userFilter = readsAllUsers ? null : (user?.uid || null);
    const tenantId = activeTenant?.id;
    if (!tenantId) {
      return [];
    }

    try {
      const recentReminders = await reminderHistoryService.getReminderHistory(tenantId, userFilter, limit);
      return recentReminders;
    } catch (err) {
      // Only an all-scope denial is benign — self-heal the likely-stale tenant flag.
      // A self-scoped denial was already logged loudly by the service. Either way this
      // is a secondary widget, so return empty (the primary list surfaces real errors).
      if (isPermissionDeniedError(err) && readsAllUsers) {
        handleAllScopeDenied();
      }
      return [];
    }
  }, [user?.uid, activeTenant?.id, canViewAllReminders, handleAllScopeDenied]);

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

  // Load initial data when user is available (unless the caller opted out).
  useEffect(() => {
    if (!autoload) return;
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
  }, [user?.uid, activeTenant?.id, refresh, autoload]);

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
    canViewAllReminders,
  };
}
