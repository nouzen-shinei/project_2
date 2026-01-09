import { logger } from '@/lib/logger';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  limit, 
  getDocs, 
  doc, 
  getDoc, 
  updateDoc, 
  Timestamp, 
  serverTimestamp,
  QueryDocumentSnapshot,
  DocumentData,
  startAfter,
  writeBatch
} from 'firebase/firestore';
import { firestore } from '../config/firebase';

export interface AdminNotificationHistoryEntry {
  tenantId?: string;
  tenantName?: string;
  id?: string;
  // Admin information
  adminEmail: string;
  adminName: string;
  
  // Notification details
  title: string;
  body: string;
  type: 'info' | 'warning' | 'success' | 'error' | 'announcement';
  priority: 'high' | 'normal' | 'low';
  
  // Recipients
  targetUsers: string[];
  targetDevices: Array<{ email: string; deviceId: string; deviceName?: string }>;
  
  // Delivery results
  totalTargets: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  
  // Delivery details
  userResults: Array<{ email: string; success: number; failed: number }>;
  deviceResults: Array<{ email: string; deviceId: string; success: boolean; deviceName?: string; reason?: string }>;
  failureReasonSummary?: Record<string, number>;
  
  // Metadata
  deliveryMethod: 'realtime_database' | 'expo_push' | 'web_browser' | 'mixed';
  onlineOnly: boolean;
  
  // Additional data
  data?: any;
  
  // Timestamps
  sentAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AdminNotificationStats {
  totalNotifications: number;
  successfulNotifications: number;
  failedNotifications: number;
  notificationsByType: Record<string, number>;
  notificationsByPriority: Record<string, number>;
  averageSuccessRate: number;
  totalRecipientsReached: number;
}

class AdminNotificationHistoryService {
  private collectionName = 'admin_notification_history';

  private static readonly GLOBAL_TENANT_ID = '__global__';

  private resolveTenantId(tenantId?: string): string {
    return tenantId?.trim() || AdminNotificationHistoryService.GLOBAL_TENANT_ID;
  }

  private buildTenantFilters(tenantId?: string) {
    return tenantId ? [where('tenantId', '==', tenantId)] : [];
  }

  /**
   * Clean undefined values from an object recursively
   */
  private cleanUndefinedValues(obj: any): any {
    if (obj === null || obj === undefined) {
      return null;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanUndefinedValues(item)).filter(item => item !== undefined);
    }
    
    if (typeof obj === 'object') {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) {
          const cleanedValue = this.cleanUndefinedValues(value);
          if (cleanedValue !== undefined) {
            cleaned[key] = cleanedValue;
          }
        }
      }
      return cleaned;
    }
    
    return obj;
  }

  /**
   * Validate and create a proper Firestore Timestamp
   */
  private validateAndCreateTimestamp(input: any): Timestamp | null {
    try {
      // If it's already a valid Timestamp
      if (input && typeof input.toDate === 'function') {
        try {
          const testDate = input.toDate();
          if (!isNaN(testDate.getTime())) {
            return input;
          }
        } catch (error) {
          logger.warn('Invalid Timestamp with toDate method:', error);
        }
      }
      
      // If it's a Date object
      if (input instanceof Date) {
        if (!isNaN(input.getTime())) {
          return Timestamp.fromDate(input);
        }
      }
      
      // If it's a string
      if (typeof input === 'string') {
        const date = new Date(input);
        if (!isNaN(date.getTime())) {
          return Timestamp.fromDate(date);
        }
      }
      
      // If it's a number (milliseconds)
      if (typeof input === 'number' && !isNaN(input) && isFinite(input)) {
        const date = new Date(input);
        if (!isNaN(date.getTime())) {
          return Timestamp.fromDate(date);
        }
      }
      
      // If it's an object with seconds/nanoseconds
      if (input && typeof input.seconds === 'number' && !isNaN(input.seconds)) {
        const nanoseconds = input.nanoseconds || 0;
        if (!isNaN(nanoseconds)) {
          return new Timestamp(input.seconds, nanoseconds);
        }
      }
      
      logger.warn('Could not create valid timestamp from:', input);
      return null;
    } catch (error) {
      logger.error('Error validating timestamp:', error, input);
      return null;
    }
  }

  /**
   * Save admin notification to history
   */
  async saveNotificationHistory(
    notificationData: Omit<AdminNotificationHistoryEntry, 'id' | 'createdAt' | 'updatedAt' | 'tenantId' | 'tenantName'>,
    options?: { tenantId?: string; tenantName?: string }
  ): Promise<string | null> {
    try {
      const scopedTenantId = this.resolveTenantId(options?.tenantId);
      const now = Timestamp.now();
      
      // Clean the data to remove undefined values
      const cleanedData = this.cleanUndefinedValues({
        ...notificationData,
        tenantId: scopedTenantId,
        tenantName: options?.tenantName,
        // Ensure required fields have default values
        adminEmail: notificationData.adminEmail || 'unknown',
        adminName: notificationData.adminName || 'Unknown Admin',
        title: notificationData.title || 'Untitled',
        body: notificationData.body || '',
        type: notificationData.type || 'info',
        priority: notificationData.priority || 'normal',
        targetUsers: notificationData.targetUsers || [],
        targetDevices: notificationData.targetDevices || [],
        totalTargets: notificationData.totalTargets || 0,
        successfulDeliveries: notificationData.successfulDeliveries || 0,
        failedDeliveries: notificationData.failedDeliveries || 0,
        userResults: notificationData.userResults || [],
        deviceResults: notificationData.deviceResults || [],
        failureReasonSummary: notificationData.failureReasonSummary,
        deliveryMethod: notificationData.deliveryMethod || 'mixed',
        onlineOnly: notificationData.onlineOnly !== undefined ? notificationData.onlineOnly : true,
        data: notificationData.data || {},
        sentAt: this.validateAndCreateTimestamp(notificationData.sentAt) || now,
        createdAt: now,
        updatedAt: now,
      });
      
      logger.debug('💾 Saving notification history:', {
        tenantId: scopedTenantId,
        title: cleanedData.title,
        adminEmail: cleanedData.adminEmail,
        totalTargets: cleanedData.totalTargets,
        successfulDeliveries: cleanedData.successfulDeliveries
      });
      
      const docRef = await addDoc(collection(firestore, this.collectionName), cleanedData);
      
      logger.debug('✅ Admin notification saved to history:', docRef.id);
      return docRef.id;
    } catch (error) {
      logger.error('❌ Error saving admin notification to history:', error);
      logger.error('❌ Error details:', {
        message: error instanceof Error ? error.message : 'Unknown error',
        code: error instanceof Error && 'code' in error ? (error as any).code : 'unknown'
      });
      return null;
    }
  }

  /**
   * Update notification delivery status
   */
  async updateNotificationStatus(
    notificationId: string,
    updateData: {
      successfulDeliveries?: number;
      failedDeliveries?: number;
      userResults?: Array<{ email: string; success: number; failed: number }>;
      deviceResults?: Array<{ email: string; deviceId: string; success: boolean; deviceName?: string; reason?: string }>;
      failureReasonSummary?: Record<string, number>;
    }
  ): Promise<boolean> {
    try {
      const docRef = doc(firestore, this.collectionName, notificationId);
      await updateDoc(docRef, {
        ...updateData,
        updatedAt: Timestamp.now()
      });
      
      logger.debug('✅ Notification status updated:', notificationId);
      return true;
    } catch (error) {
      logger.error('❌ Error updating notification status:', error);
      return false;
    }
  }

  /**
   * Get notification history with pagination
   */
  async getNotificationHistory(options?: {
    tenantId?: string;
    adminEmail?: string;
    pageSize?: number;
    lastDocument?: QueryDocumentSnapshot<DocumentData>;
  }): Promise<{
    notifications: AdminNotificationHistoryEntry[];
    lastDocument: QueryDocumentSnapshot<DocumentData> | null;
    hasMore: boolean;
  }> {
    try {
      const tenantId = options?.tenantId;
      const adminEmail = options?.adminEmail;
      const pageSize = options?.pageSize ?? 20;
      const lastDocument = options?.lastDocument;

      const tenantConstraints = this.buildTenantFilters(tenantId);
      let q = query(
        collection(firestore, this.collectionName),
        ...tenantConstraints,
        orderBy('sentAt', 'desc'),
        limit(pageSize + 1),
      );

      // Filter by admin if specified
      if (adminEmail) {
        q = query(
          collection(firestore, this.collectionName),
          ...tenantConstraints,
          where('adminEmail', '==', adminEmail),
          orderBy('sentAt', 'desc'),
          limit(pageSize + 1)
        );
      }

      // Add cursor if provided
      if (lastDocument) {
        q = query(q, startAfter(lastDocument));
      }

      const querySnapshot = await getDocs(q);
      const docs = querySnapshot.docs;
      
      // Check if there are more documents
      const hasMore = docs.length > pageSize;
      const notifications: AdminNotificationHistoryEntry[] = [];
      let newLastDocument: QueryDocumentSnapshot<DocumentData> | null = null;

      // Process documents (excluding the extra one if it exists)
      const docsToProcess = hasMore ? docs.slice(0, pageSize) : docs;
      
      docsToProcess.forEach((doc) => {
        const data = doc.data();
        notifications.push({
          id: doc.id,
          ...data,
          sentAt: this.validateAndCreateTimestamp(data.sentAt) || Timestamp.now(),
          createdAt: this.validateAndCreateTimestamp(data.createdAt) || Timestamp.now(),
          updatedAt: this.validateAndCreateTimestamp(data.updatedAt) || Timestamp.now()
        } as AdminNotificationHistoryEntry);
      });

      // Set the last document for pagination
      if (docsToProcess.length > 0) {
        newLastDocument = docsToProcess[docsToProcess.length - 1];
      }

      logger.debug('📊 Notification history loaded:', {
        adminEmail,
        resultCount: notifications.length,
        hasMore
      });

      return {
        notifications,
        lastDocument: newLastDocument,
        hasMore
      };
    } catch (error) {
      logger.error('❌ Error fetching notification history:', error);
      return {
        notifications: [],
        lastDocument: null,
        hasMore: false
      };
    }
  }

  /**
   * Get notification statistics
   */
  async getNotificationStats(options?: {
    tenantId?: string;
    adminEmail?: string;
    days?: number;
  }): Promise<AdminNotificationStats> {
    try {
      const tenantId = options?.tenantId;
      const adminEmail = options?.adminEmail;
      const days = options?.days ?? 30;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const isMissingIndexError = (error: unknown): boolean => {
        const message = (error as any)?.message;
        return typeof message === 'string' && message.toLowerCase().includes('the query requires an index');
      };

      const buildEmptyStats = (): AdminNotificationStats => ({
        totalNotifications: 0,
        successfulNotifications: 0,
        failedNotifications: 0,
        notificationsByType: {},
        notificationsByPriority: {},
        averageSuccessRate: 0,
        totalRecipientsReached: 0,
      });

      const computeStats = (
        docs: Array<AdminNotificationHistoryEntry>,
      ): AdminNotificationStats => {
        const stats: AdminNotificationStats = buildEmptyStats();

        let totalSuccessRate = 0;
        let totalRecipients = 0;

        docs.forEach((data) => {
          stats.totalNotifications += 1;

          const successRate = data.totalTargets > 0 ? data.successfulDeliveries / data.totalTargets : 0;
          if (successRate > 0.8) {
            stats.successfulNotifications += 1;
          } else {
            stats.failedNotifications += 1;
          }

          stats.notificationsByType[data.type] = (stats.notificationsByType[data.type] || 0) + 1;
          stats.notificationsByPriority[data.priority] = (stats.notificationsByPriority[data.priority] || 0) + 1;

          totalSuccessRate += successRate;
          totalRecipients += data.successfulDeliveries;
        });

        if (stats.totalNotifications > 0) {
          stats.averageSuccessRate = totalSuccessRate / stats.totalNotifications;
        }
        stats.totalRecipientsReached = totalRecipients;
        return stats;
      };
      
      const tenantConstraints = this.buildTenantFilters(tenantId);
      let q = query(
        collection(firestore, this.collectionName),
        ...tenantConstraints,
        where('sentAt', '>=', Timestamp.fromDate(startDate)),
        orderBy('sentAt', 'desc')
      );

      // Filter by admin if specified - otherwise get all notifications
      if (adminEmail) {
        q = query(
          collection(firestore, this.collectionName),
          ...tenantConstraints,
          where('adminEmail', '==', adminEmail),
          where('sentAt', '>=', Timestamp.fromDate(startDate)),
          orderBy('sentAt', 'desc')
        );
      }

      let querySnapshot;
      try {
        querySnapshot = await getDocs(q);
      } catch (error) {
        if (!isMissingIndexError(error)) {
          throw error;
        }

        logger.warn('⚠️ Missing Firestore composite index for notification stats; using fallback query', {
          tenantId,
          adminEmail,
          days,
        });

        // Fallback avoids composite indexes by using at most ONE equality filter server-side.
        // We then filter by date/tenant/admin client-side.
        const fallbackConstraints = [] as any[];
        if (adminEmail) {
          fallbackConstraints.push(where('adminEmail', '==', adminEmail));
        } else if (tenantId) {
          fallbackConstraints.push(where('tenantId', '==', tenantId));
        }

        const fallbackQuery = query(collection(firestore, this.collectionName), ...fallbackConstraints);
        const fallbackSnapshot = await getDocs(fallbackQuery);
        const startMillis = startDate.getTime();

        const filtered: AdminNotificationHistoryEntry[] = [];
        fallbackSnapshot.forEach((docSnap) => {
          const raw = docSnap.data();
          const sentAt = this.validateAndCreateTimestamp(raw.sentAt) || Timestamp.now();

          const entry = {
            id: docSnap.id,
            ...raw,
            sentAt,
            createdAt: this.validateAndCreateTimestamp(raw.createdAt) || Timestamp.now(),
            updatedAt: this.validateAndCreateTimestamp(raw.updatedAt) || Timestamp.now(),
          } as AdminNotificationHistoryEntry;

          if (tenantId && entry.tenantId && entry.tenantId !== tenantId) return;
          if (adminEmail && entry.adminEmail !== adminEmail) return;
          if (sentAt.toDate().getTime() < startMillis) return;

          filtered.push(entry);
        });

        return computeStats(filtered);
      }
      
      logger.debug(`🔍 Querying notification stats for last ${days} days`, {
        adminEmail: adminEmail || 'all admins',
        documentsFound: querySnapshot.size
      });

      const docs: AdminNotificationHistoryEntry[] = [];
      querySnapshot.forEach((docSnap) => {
        docs.push(docSnap.data() as AdminNotificationHistoryEntry);
      });

      const stats = computeStats(docs);

      logger.debug('📊 Notification stats calculated:', {
        adminEmail,
        days,
        totalNotifications: stats.totalNotifications,
        averageSuccessRate: stats.averageSuccessRate
      });

      return stats;
    } catch (error) {
      logger.error('❌ Error calculating notification stats:', error);
      return {
        totalNotifications: 0,
        successfulNotifications: 0,
        failedNotifications: 0,
        notificationsByType: {},
        notificationsByPriority: {},
        averageSuccessRate: 0,
        totalRecipientsReached: 0,
      };
    }
  }

  /**
   * Get a specific notification by ID
   */
  async getNotificationById(
    notificationId: string,
    options?: { tenantId?: string }
  ): Promise<AdminNotificationHistoryEntry | null> {
    try {
      const docRef = doc(firestore, this.collectionName, notificationId);
      const docSnap = await getDoc(docRef);
      
      if (!docSnap.exists()) {
        return null;
      }

      const data = docSnap.data();
      const requestedTenantId = options?.tenantId;
      if (requestedTenantId && data.tenantId && data.tenantId !== requestedTenantId) {
        logger.warn('Notification access denied due to tenant mismatch', {
          notificationId,
          tenantId: data.tenantId,
          requestedTenantId,
        });
        return null;
      }
      return {
        id: docSnap.id,
        ...data,
        sentAt: data.sentAt instanceof Timestamp ? data.sentAt : Timestamp.fromDate(new Date(data.sentAt)),
        createdAt: data.createdAt instanceof Timestamp ? data.createdAt : Timestamp.fromDate(new Date(data.createdAt)),
        updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : Timestamp.fromDate(new Date(data.updatedAt))
      } as AdminNotificationHistoryEntry;
    } catch (error) {
      logger.error('❌ Error fetching notification by ID:', error);
      return null;
    }
  }

  /**
   * Get notifications sent to a specific user
   */
  async getNotificationsForUser(
    userEmail: string,
    options?: { tenantId?: string; pageSize?: number }
  ): Promise<AdminNotificationHistoryEntry[]> {
    try {
      const tenantId = options?.tenantId;
      const pageSize = options?.pageSize ?? 20;
      const tenantConstraints = this.buildTenantFilters(tenantId);
      const q = query(
        collection(firestore, this.collectionName),
        ...tenantConstraints,
        where('targetUsers', 'array-contains', userEmail),
        orderBy('sentAt', 'desc'),
        limit(pageSize)
      );

      const querySnapshot = await getDocs(q);
      const notifications: AdminNotificationHistoryEntry[] = [];

      querySnapshot.forEach((doc) => {
        const data = doc.data();
        notifications.push({
          id: doc.id,
          ...data,
          sentAt: data.sentAt instanceof Timestamp ? data.sentAt : Timestamp.fromDate(new Date(data.sentAt)),
          createdAt: data.createdAt instanceof Timestamp ? data.createdAt : Timestamp.fromDate(new Date(data.createdAt)),
          updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : Timestamp.fromDate(new Date(data.updatedAt))
        } as AdminNotificationHistoryEntry);
      });

      return notifications;
    } catch (error) {
      logger.error('❌ Error fetching notifications for user:', error);
      return [];
    }
  }

  /**
   * Search notifications by title or content
   */
  async searchNotifications(
    searchTerm: string,
    options?: { tenantId?: string; adminEmail?: string; pageSize?: number }
  ): Promise<AdminNotificationHistoryEntry[]> {
    try {
      const tenantId = options?.tenantId;
      const adminEmail = options?.adminEmail;
      const pageSize = options?.pageSize ?? 20;
      const tenantConstraints = this.buildTenantFilters(tenantId);
      // Note: Firestore doesn't support full-text search natively
      // This is a basic implementation that would need enhancement for production
      let q = query(
        collection(firestore, this.collectionName),
        ...tenantConstraints,
        orderBy('sentAt', 'desc'),
        limit(pageSize * 3) // Get more records to filter client-side
      );

      if (adminEmail) {
        q = query(
          collection(firestore, this.collectionName),
          ...tenantConstraints,
          where('adminEmail', '==', adminEmail),
          orderBy('sentAt', 'desc'),
          limit(pageSize * 3)
        );
      }

      const querySnapshot = await getDocs(q);
      const allNotifications: AdminNotificationHistoryEntry[] = [];

      querySnapshot.forEach((doc) => {
        const data = doc.data();
        
        // Helper function to safely convert timestamps
        const safeTimestamp = (timestamp: any): Timestamp => {
          if (timestamp instanceof Timestamp) {
            return timestamp;
          }
          
          // Try to create a valid date
          let date: Date;
          if (timestamp?.seconds !== undefined && typeof timestamp.seconds === 'number') {
            // Handle serialized Firestore timestamp
            if (isNaN(timestamp.seconds)) {
              logger.warn('Invalid timestamp seconds:', timestamp);
              return Timestamp.now(); // Fallback to current time
            }
            const milliseconds = timestamp.seconds * 1000 + (timestamp.nanoseconds || 0) / 1000000;
            date = new Date(milliseconds);
          } else if (typeof timestamp === 'string') {
            date = new Date(timestamp);
          } else if (typeof timestamp === 'number') {
            date = new Date(timestamp);
          } else {
            logger.warn('Unknown timestamp format:', timestamp);
            return Timestamp.now(); // Fallback to current time
          }
          
          // Validate the date
          if (isNaN(date.getTime())) {
            logger.warn('Invalid date created from timestamp:', timestamp);
            return Timestamp.now(); // Fallback to current time
          }
          
          return Timestamp.fromDate(date);
        };
        
        allNotifications.push({
          id: doc.id,
          ...data,
          sentAt: safeTimestamp(data.sentAt),
          createdAt: safeTimestamp(data.createdAt),
          updatedAt: safeTimestamp(data.updatedAt)
        } as AdminNotificationHistoryEntry);
      });

      // Filter client-side (in production, use a proper search solution like Algolia)
      const searchTermLower = searchTerm.toLowerCase();
      const filteredNotifications = allNotifications.filter(notification => {
        // Search in basic notification fields
        const basicMatch = 
          notification.title.toLowerCase().includes(searchTermLower) ||
          notification.body.toLowerCase().includes(searchTermLower) ||
          notification.type.toLowerCase().includes(searchTermLower) ||
          notification.priority.toLowerCase().includes(searchTermLower) ||
          notification.deliveryMethod.toLowerCase().includes(searchTermLower);

        // Search in admin information
        const adminMatch = 
          notification.adminName.toLowerCase().includes(searchTermLower) ||
          notification.adminEmail.toLowerCase().includes(searchTermLower);

        // Search in target users
        const userMatch = notification.targetUsers.some(email => 
          email.toLowerCase().includes(searchTermLower)
        );

        // Search in target devices (email and device name)
        const deviceMatch = notification.targetDevices.some(device => 
          device.email.toLowerCase().includes(searchTermLower) ||
          (device.deviceName && device.deviceName.toLowerCase().includes(searchTermLower)) ||
          device.deviceId.toLowerCase().includes(searchTermLower)
        );

        // Search in device results if available
        const resultMatch = notification.deviceResults ? 
          notification.deviceResults.some(result => 
            result.email.toLowerCase().includes(searchTermLower) ||
            (result.deviceName && result.deviceName.toLowerCase().includes(searchTermLower))
          ) : false;

        return basicMatch || adminMatch || userMatch || deviceMatch || resultMatch;
      });

      return filteredNotifications.slice(0, pageSize);
    } catch (error) {
      logger.error('❌ Error searching notifications:', error);
      return [];
    }
  }

  /**
   * Delete old notification history (cleanup)
   */
  async cleanupOldNotifications(options?: { tenantId?: string; daysToKeep?: number }): Promise<number> {
    try {
      const tenantId = options?.tenantId;
      const daysToKeep = options?.daysToKeep ?? 90;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
      
      const tenantConstraints = this.buildTenantFilters(tenantId);
      const q = query(
        collection(firestore, this.collectionName),
        ...tenantConstraints,
        where('sentAt', '<', Timestamp.fromDate(cutoffDate))
      );

      const querySnapshot = await getDocs(q);
      
      // Delete in batches
      const batch = writeBatch(firestore);
      let deletedCount = 0;

      querySnapshot.forEach((doc) => {
        batch.delete(doc.ref);
        deletedCount++;
      });

      if (deletedCount > 0) {
        await batch.commit();
        logger.debug(`🧹 Cleaned up ${deletedCount} old notification records`);
      }

      return deletedCount;
    } catch (error) {
      logger.error('❌ Error cleaning up old notifications:', error);
      return 0;
    }
  }
}

// Create and export singleton instance
export const adminNotificationHistoryService = new AdminNotificationHistoryService();
export default adminNotificationHistoryService;
