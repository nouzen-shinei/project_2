import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './useAuthUnified';
import { 
  adminNotificationHistoryService, 
  AdminNotificationHistoryEntry, 
  AdminNotificationStats 
} from '../services/adminNotificationHistoryService';
import { QueryDocumentSnapshot, DocumentData } from 'firebase/firestore';

export function useAdminNotificationHistory(tenantId?: string) {
  const { user } = useAuth();
  const [history, setHistory] = useState<AdminNotificationHistoryEntry[]>([]);
  const [stats, setStats] = useState<AdminNotificationStats>({
    totalNotifications: 0,
    successfulNotifications: 0,
    failedNotifications: 0,
    notificationsByType: {},
    notificationsByPriority: {},
    averageSuccessRate: 0,
    totalRecipientsReached: 0
  });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  
  // Use refs to avoid dependency issues
  const lastDocumentRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);

  // Load notification history
  const loadHistory = useCallback(async (
    pageSize: number = 20,
    reset: boolean = false,
    adminEmail?: string
  ) => {
    if (!user?.email) return;
    if (!tenantId) {
      if (reset) {
        setHistory([]);
        setHasMore(false);
      }
      setError('Select a coaching center to view notification history');
      return;
    }

    try {
      if (reset) {
        setLoading(true);
        lastDocumentRef.current = null;
      } else {
        setLoadingMore(true);
      }
      
      setError(null);

      const result = await adminNotificationHistoryService.getNotificationHistory({
        tenantId,
        adminEmail,
        pageSize,
        lastDocument: reset ? undefined : lastDocumentRef.current || undefined,
      });

      logger.debug('📊 Admin notification history loaded:', {
        resultCount: result.notifications.length,
        hasMore: result.hasMore,
        adminEmail: adminEmail || 'all admins',
        reset
      });

      if (reset) {
        setHistory(result.notifications);
      } else {
        setHistory(prev => [...prev, ...result.notifications]);
      }
      
      lastDocumentRef.current = result.lastDocument;
      setHasMore(result.hasMore);
    } catch (err) {
      logger.error('Error loading admin notification history:', err);
      setError(err instanceof Error ? err.message : 'Failed to load notification history');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [user?.email, tenantId]);

  // Load more notifications
  const loadMoreHistory = useCallback(async () => {
    if (!hasMore || loadingMore || loading) return;
    
    await loadHistory(20, false);
  }, [hasMore, loadingMore, loading, loadHistory]);

  // Reset and reload history
  const resetAndLoadHistory = useCallback(async (
    pageSize?: number,
    adminEmail?: string
  ) => {
    await loadHistory(pageSize, true, adminEmail);
  }, [loadHistory]);

  // Load notification statistics
  const loadStats = useCallback(async (days: number = 30, adminEmail?: string) => {
    if (!user?.email) return;
    if (!tenantId) {
      setStats({
        totalNotifications: 0,
        successfulNotifications: 0,
        failedNotifications: 0,
        notificationsByType: {},
        notificationsByPriority: {},
        averageSuccessRate: 0,
        totalRecipientsReached: 0,
      });
      setError('Select a coaching center to view notification stats');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      logger.debug('🔄 Loading notification stats...', { 
        days, 
        adminEmail: adminEmail || 'all notifications',
        userEmail: user.email 
      });

      const notificationStats = await adminNotificationHistoryService.getNotificationStats({
        tenantId,
        adminEmail,
        days,
      });
      
      logger.debug('📊 Stats loaded:', notificationStats);
      setStats(notificationStats);
    } catch (err) {
      logger.error('Error loading notification stats:', err);
      setError(err instanceof Error ? err.message : 'Failed to load notification stats');
    } finally {
      setLoading(false);
    }
  }, [user?.email, tenantId]);

  // Get notification by ID
  const getNotificationById = useCallback(async (notificationId: string) => {
    if (!tenantId) {
      return null;
    }
    try {
      return await adminNotificationHistoryService.getNotificationById(notificationId, { tenantId });
    } catch (err) {
      logger.error('Error loading notification by ID:', err);
      return null;
    }
  }, [tenantId]);

  // Get notifications for a specific user
  const getNotificationsForUser = useCallback(async (userEmail: string, pageSize?: number) => {
    if (!tenantId) {
      return [];
    }
    try {
      return await adminNotificationHistoryService.getNotificationsForUser(userEmail, {
        tenantId,
        pageSize,
      });
    } catch (err) {
      logger.error('Error loading notifications for user:', err);
      return [];
    }
  }, [tenantId]);

  // Search notifications (for real-time search - returns results without updating history)
  const searchNotificationsRealtime = useCallback(async (
    searchTerm: string,
    adminEmail?: string,
    pageSize?: number
  ) => {
    if (!tenantId) {
      return [];
    }
    try {
      const results = await adminNotificationHistoryService.searchNotifications(searchTerm, {
        tenantId,
        adminEmail,
        pageSize,
      });
      
      return results;
    } catch (err) {
      logger.error('Error searching notifications:', err);
      return [];
    }
  }, [tenantId]);

  // Search notifications (original - updates history state)
  const searchNotifications = useCallback(async (
    searchTerm: string,
    adminEmail?: string,
    pageSize?: number
  ) => {
    if (!tenantId) {
      setHistory([]);
      setHasMore(false);
      setError('Select a coaching center to search notification history');
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const results = await adminNotificationHistoryService.searchNotifications(searchTerm, {
        tenantId,
        adminEmail,
        pageSize,
      });
      
      setHistory(results);
      setHasMore(false); // Search results don't support pagination
      lastDocumentRef.current = null;
    } catch (err) {
      logger.error('Error searching notifications:', err);
      setError(err instanceof Error ? err.message : 'Failed to search notifications');
    } finally {
      setLoading(false);
    }
  }, [user?.email, tenantId]);

  // Clean up old notifications
  const cleanupOldNotifications = useCallback(async (daysToKeep: number = 90) => {
    if (!tenantId) {
      return 0;
    }
    try {
      const deletedCount = await adminNotificationHistoryService.cleanupOldNotifications({
        tenantId,
        daysToKeep,
      });
      
      // Refresh the history after cleanup
      await resetAndLoadHistory();
      
      return deletedCount;
    } catch (err) {
      logger.error('Error cleaning up old notifications:', err);
      throw err;
    }
  }, [resetAndLoadHistory, tenantId]);

  // Refresh all data
  const refresh = useCallback(async (adminEmail?: string) => {
    await Promise.all([
      resetAndLoadHistory(50, adminEmail), // Load last 50 notifications
      loadStats(30), // Load stats for last 30 days - all notifications, not filtered by admin
    ]);
  }, [resetAndLoadHistory, loadStats]);

  // Load initial data when user is available
  useEffect(() => {
    if (user?.email) {
      refresh();
    }
  }, [user?.email, refresh]);

  return {
    // Data
    history,
    stats,
    
    // State
    loading,
    loadingMore,
    error,
    hasMore,
    
    // Methods
    loadHistory: resetAndLoadHistory,
    loadMoreHistory,
    loadStats,
    getNotificationById,
    getNotificationsForUser,
    searchNotifications,
    searchNotificationsRealtime,
    cleanupOldNotifications,
    refresh,
    
    // Utilities
    isAuthenticated: !!user?.email,
    currentUserEmail: user?.email
  };
}

export default useAdminNotificationHistory;
