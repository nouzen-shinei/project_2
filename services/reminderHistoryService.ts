import { logger } from '@/lib/logger';
import { isPermissionDeniedError } from '@/lib/firestoreErrors';
import { collection, addDoc, query, where, orderBy, getDocs, doc, updateDoc, Timestamp, limit, startAfter, QueryDocumentSnapshot, DocumentData, getCountFromServer, getDoc } from 'firebase/firestore';
import { firestore } from '../config/firebase';

// Classify a permission-denied on a reminder read by SCOPE:
//  - A tenant-wide ('all users', userId === null) read that gets denied is an
//    EXPECTED, feature-gated outcome (the caller isn't authorized to read all
//    reminders). Log it at `debug` so it degrades quietly and does NOT trip the
//    global auth-recovery interceptor (which reacts to warn/error permission-denied).
//  - A SELF-scoped read (the caller's own userId) should NEVER be denied — the rules
//    always allow a user to read their own reminders. A denial here indicates a real
//    Firestore rules/config regression, so log it at `error` so it stays loud and
//    visible instead of being silently swallowed as "no data".
// Returns true if the denial was the expected/benign all-scope case.
function logReminderPermissionDenied(op: string, userId: string | null, error: unknown): boolean {
  if (userId === null) {
    logger.debug(`${op}: tenant-wide reminder read denied (expected — caller not authorized for 'all' scope)`);
    return true;
  }
  logger.error(`${op}: self-scoped reminder read denied (UNEXPECTED — possible Firestore rules regression)`, error);
  return false;
}

// Firestore doesn't allow undefined values anywhere in the payload (including nested fields or arrays).
// This helper removes all undefined values recursively so we can safely write documents
// even when optional settings (e.g., coachingName/teacherName) are disabled.
function sanitizeForFirestore<T = any>(value: T): T {
  // Preserve Firestore Timestamp as-is
  if (value instanceof Timestamp) return value;

  if (value === undefined) return undefined as any; // callers will omit undefined on objects/arrays
  if (value === null) return null as any;

  if (Array.isArray(value)) {
    const cleaned = (value as any[])
      .map((v) => sanitizeForFirestore(v))
      .filter((v) => v !== undefined);
    return cleaned as any;
  }

  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as any)) {
      const cleaned = sanitizeForFirestore(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out as any;
  }

  return value as any;
}

export interface ReminderHistoryEntry {
  tenantId: string;
  id?: string;
  userId: string;
  studentId: string;
  studentName: string;
  parentName: string;
  parentContact: string;
  parentEmail?: string;
  reminderType: 'email' | 'sms' | 'whatsapp' | 'voice';
  status: 'success' | 'failed' | 'pending';
  message: string;
  amount: number;
  dueDate: string;
  feeCategories: string[];
  settings: {
    useCustomMessage: boolean;
    useCustomNotes: boolean;
    language: 'english' | 'hindi' | 'both';
    coachingName?: string;
    teacherName?: string;
  };
  // Convenience field for quick display/querying (copied from settings.teacherName)
  senderName?: string;
  errorMessage?: string;
  metadata?: {
    messageId?: string;
    twilioSid?: string;
    emailId?: string;
    deliveryStatus?: string;
  };
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ReminderBatch {
  tenantId: string;
  id?: string;
  userId: string;
  batchId: string;
  totalStudents: number;
  totalReminders: number;
  successfulReminders: number;
  failedReminders: number;
  reminderTypes: string[];
  settings: {
    useCustomMessage: boolean;
    useCustomNotes: boolean;
    language: 'english' | 'hindi' | 'both';
    coachingName?: string;
    teacherName?: string;
  };
  // Convenience field copied from settings.teacherName for easier auditing
  senderName?: string;
  createdAt: Timestamp;
  completedAt?: Timestamp;
}

export interface ReminderUsageSummary {
  windowStart: string;
  windowEnd: string;
  totalReminders: number;
  successfulReminders: number;
  failedReminders: number;
  pendingReminders: number;
}

class ReminderHistoryService {
  private collectionName = 'reminderHistory';
  private batchCollectionName = 'reminderBatches';

  private ensureTenantId(tenantId?: string | null): string {
    if (!tenantId) {
      throw new Error('tenantId is required for reminder history operations');
    }
    return tenantId;
  }

  private async assertReminderTenant(reminderId: string, tenantId: string) {
    const reminderRef = doc(firestore, this.collectionName, reminderId);
    const snapshot = await getDoc(reminderRef);
    if (!snapshot.exists()) {
      throw new Error('Reminder not found');
    }
    if (snapshot.data()?.tenantId !== tenantId) {
      throw new Error('Reminder does not belong to the active coaching center');
    }
    return reminderRef;
  }

  private async assertBatchTenant(batchId: string, tenantId: string) {
    const batchRef = doc(firestore, this.batchCollectionName, batchId);
    const snapshot = await getDoc(batchRef);
    if (!snapshot.exists()) {
      throw new Error('Reminder batch not found');
    }
    if (snapshot.data()?.tenantId !== tenantId) {
      throw new Error('Reminder batch does not belong to the active coaching center');
    }
    return batchRef;
  }

  // Save a single reminder to history
  async saveReminder(reminderData: Omit<ReminderHistoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<string | null> {
    try {
      this.ensureTenantId(reminderData.tenantId);
      const now = Timestamp.now();
      const payload = sanitizeForFirestore({
        ...reminderData,
        // copy teacherName to a top-level senderName for easier display/queries
        senderName: reminderData.settings?.teacherName,
        createdAt: now,
        updatedAt: now,
      });
      const docRef = await addDoc(collection(firestore, this.collectionName), payload);
      
      logger.debug('Reminder saved to history:', docRef.id);
      return docRef.id;
    } catch (error) {
      logger.error('Error saving reminder to history:', error);
      return null;
    }
  }

  // Save multiple reminders in batch
  async saveReminderBatch(
    batchData: Omit<ReminderBatch, 'id' | 'createdAt'>,
    reminders: Omit<ReminderHistoryEntry, 'id' | 'createdAt' | 'updatedAt'>[]
  ): Promise<{ batchId: string | null; reminderIds: string[] }> {
    try {
      const tenantId = this.ensureTenantId(batchData.tenantId);
      const now = Timestamp.now();
      
      // Save batch metadata
      const batchPayload = sanitizeForFirestore({
        ...batchData,
        tenantId,
        // copy teacherName to a top-level senderName for auditing
        senderName: batchData.settings?.teacherName,
        createdAt: now,
      });
      const batchRef = await addDoc(collection(firestore, this.batchCollectionName), batchPayload);

      // Save individual reminders
      const reminderIds: string[] = [];
      const reminderPromises = reminders.map(async (reminder) => {
        const reminderTenant = this.ensureTenantId(reminder.tenantId);
        if (reminderTenant !== tenantId) {
          throw new Error('Reminder tenant mismatch in batch save');
        }
        const reminderPayload = sanitizeForFirestore({
          ...reminder,
          tenantId,
          batchId: batchRef.id,
          // copy teacherName into a top-level senderName for easier querying/display
          senderName: reminder.settings?.teacherName,
          createdAt: now,
          updatedAt: now,
        });
        const reminderRef = await addDoc(collection(firestore, this.collectionName), reminderPayload);
        reminderIds.push(reminderRef.id);
        return reminderRef.id;
      });

      await Promise.all(reminderPromises);

      logger.debug(`Reminder batch saved: ${batchRef.id} with ${reminderIds.length} reminders`);
      return { batchId: batchRef.id, reminderIds };
    } catch (error) {
      logger.error('Error saving reminder batch:', error);
      return { batchId: null, reminderIds: [] };
    }
  }

  // Update reminder status
  async updateReminderStatus(
    tenantId: string,
    reminderId: string, 
    status: 'success' | 'failed', 
    errorMessage?: string,
    metadata?: ReminderHistoryEntry['metadata']
  ): Promise<boolean> {
    try {
      const scopedTenantId = this.ensureTenantId(tenantId);
      const reminderRef = await this.assertReminderTenant(reminderId, scopedTenantId);
      const updateData: any = {
        status,
        updatedAt: Timestamp.now(),
      };

      if (errorMessage) {
        updateData.errorMessage = errorMessage;
      }

      if (metadata) {
        updateData.metadata = metadata;
      }

      await updateDoc(reminderRef, updateData);
      logger.debug(`Reminder ${reminderId} status updated to ${status}`);
      return true;
    } catch (error) {
      logger.error('Error updating reminder status:', error);
      return false;
    }
  }

  // Complete a batch
  async completeBatch(tenantId: string, batchId: string, successCount: number, failedCount: number): Promise<boolean> {
    try {
      const scopedTenantId = this.ensureTenantId(tenantId);
      const batchRef = await this.assertBatchTenant(batchId, scopedTenantId);
      await updateDoc(batchRef, {
        successfulReminders: successCount,
        failedReminders: failedCount,
        completedAt: Timestamp.now(),
      });
      
      logger.debug(`Batch ${batchId} completed: ${successCount} successful, ${failedCount} failed`);
      return true;
    } catch (error) {
      logger.error('Error completing batch:', error);
      return false;
    }
  }

  // Get reminder history with optional user filter (when userId is null, return across all users)
  async getReminderHistory(
    tenantId: string,
    userId: string | null,
    pageSize: number = 20,
    studentId?: string,
    reminderType?: string
  ): Promise<ReminderHistoryEntry[]> {
    try {
      // Build constraints based on provided filters
      const scopedTenantId = this.ensureTenantId(tenantId);
      const constraints: any[] = [where('tenantId', '==', scopedTenantId), orderBy('createdAt', 'desc'), limit(pageSize)];
      if (userId) constraints.unshift(where('userId', '==', userId));

      if (studentId) constraints.unshift(where('studentId', '==', studentId));

      if (reminderType) constraints.unshift(where('reminderType', '==', reminderType));

      const q = query(collection(firestore, this.collectionName), ...constraints);

      const querySnapshot = await getDocs(q);
      const reminders: ReminderHistoryEntry[] = [];

  // (Removed verbose ReminderHistoryService query results debug log)

      querySnapshot.forEach((doc) => {
        const data = doc.data();
  // (Removed verbose ReminderHistoryService per-document debug log)
        
        reminders.push({
          id: doc.id,
          ...data
        } as ReminderHistoryEntry);
      });

      return reminders;
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        // Scope-aware: quiet for an expected all-scope denial, loud for a self-scoped
        // one. Re-throw either way so the caller can degrade / self-heal / surface it.
        logReminderPermissionDenied('getReminderHistory', userId, error);
        throw error;
      }
      logger.error('Error fetching reminder history:', error);
      return [];
    }
  }

  // Get paginated reminder history with cursor support
  async getPaginatedReminderHistory(
    tenantId: string,
    userId: string | null,
    pageSize: number = 20,
    lastDocument?: QueryDocumentSnapshot<DocumentData>,
    filters?: {
      studentId?: string;
      reminderType?: string;
      status?: string;
      // When provided and not 'all', only return reminders created within the last `days` days
      days?: number | 'all';
      // Optional free-text search; applied across key fields post-query, but integrated with pagination scanning
      searchQuery?: string;
    }
  ): Promise<{
    reminders: ReminderHistoryEntry[];
    lastDocument: QueryDocumentSnapshot<DocumentData> | null;
    hasMore: boolean;
  }> {
    try {
      // Build a single query combining all applicable filters to keep pagination consistent
      const scopedTenantId = this.ensureTenantId(tenantId);
      const whereClauses: any[] = [where('tenantId', '==', scopedTenantId)];
      if (userId) whereClauses.push(where('userId', '==', userId));
      if (filters?.studentId) whereClauses.push(where('studentId', '==', filters.studentId));
      if (filters?.reminderType) whereClauses.push(where('reminderType', '==', filters.reminderType));
      if (filters?.status && filters.status !== 'all') whereClauses.push(where('status', '==', filters.status));

      // Apply day window filter when specified (inequality must align with orderBy field)
      if (filters?.days && filters.days !== 'all') {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - (typeof filters.days === 'number' ? filters.days : 30));
        whereClauses.push(where('createdAt', '>=', Timestamp.fromDate(startDate)));
      }

      // We'll scan in chunks to support search-aware pagination without loading the entire dataset.
      const chunkSize = Math.max(pageSize * 2, 40);
      const collected: ReminderHistoryEntry[] = [];
      let cursor = lastDocument || undefined;
      let hasMore = false;
      let lastFetchedDoc: QueryDocumentSnapshot<DocumentData> | null = null;
      const searchQ = (filters?.searchQuery || '').trim().toLowerCase();

      // Helper that matches the same surface area as stats' search
      const matchSearch = (rec: ReminderHistoryEntry) => {
        if (!searchQ) return true;
        const safe = (v: any) => (v ?? '').toString().toLowerCase();
        const inArr = (arr?: string[]) => Array.isArray(arr) && arr.some(c => safe(c).includes(searchQ));
        const dateStr = (() => {
          try {
            const d = (rec.createdAt && (rec.createdAt as any).toDate)
              ? (rec.createdAt as any).toDate()
              : (rec.createdAt && (rec.createdAt as any).seconds)
                ? new Date((rec.createdAt as any).seconds * 1000)
                : null;
            return d ? (d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).toLowerCase() : '';
          } catch { return ''; }
        })();
        return (
          safe(rec.studentName).includes(searchQ) ||
          safe(rec.parentName).includes(searchQ) ||
          safe(rec.parentContact).includes(searchQ) ||
          safe(rec.parentEmail).includes(searchQ) ||
          safe(rec.message).includes(searchQ) ||
          safe(rec.amount).includes(searchQ) ||
          inArr(rec.feeCategories) ||
          safe(rec.reminderType).includes(searchQ) ||
          safe(rec.status).includes(searchQ) ||
          safe(rec.errorMessage).includes(searchQ) ||
          (dateStr && dateStr.includes(searchQ))
        );
      };

      // Limit scanning to avoid excessive reads if there are few matches
      const maxScans = 5; // at most 5 chunks per page
      let scans = 0;

      while (collected.length < pageSize && scans < maxScans) {
        scans++;
        let q = query(
          collection(firestore, this.collectionName),
          ...whereClauses,
          orderBy('createdAt', 'desc'),
          limit(chunkSize)
        );

        if (cursor) {
          q = query(q, startAfter(cursor));
        }

        const snapshot = await getDocs(q);
        const docs = snapshot.docs;

        if (docs.length === 0) {
          hasMore = false;
          break;
        }

        // Process docs in order, track last fetched doc for next cursor
        for (const d of docs) {
          const data = d.data() as ReminderHistoryEntry;
          lastFetchedDoc = d; // advance cursor regardless of match so we don't re-scan
          if (matchSearch(data)) {
            collected.push({ id: d.id, ...data });
            if (collected.length >= pageSize) {
              break; // we'll return this page; there may be more
            }
          }
        }

        // Prepare for next scan if needed
        cursor = lastFetchedDoc || undefined;
        // If we filled the page or there's potentially more to scan (got a full chunk), decide hasMore
        if (collected.length >= pageSize) {
          // There may be more; conservatively mark true. Next call continues from lastFetchedDoc.
          hasMore = true;
          break;
        }
        if (docs.length < chunkSize) {
          // Fetched less than a full chunk -> no more documents to scan
          hasMore = false;
          break;
        }
        // else continue loop to fetch next chunk
      }

      return {
        reminders: collected,
        lastDocument: lastFetchedDoc,
        hasMore
      };
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        logReminderPermissionDenied('getPaginatedReminderHistory', userId, error);
        throw error;
      }
      logger.error('Error fetching paginated reminder history:', error);
      throw error instanceof Error ? error : new Error('Failed to load reminder history');
    }
  }

  // Pure helper to process a list of QueryDocumentSnapshots into ReminderHistoryEntry array
  // This is useful to unit-test pagination slicing and lastDocument selection without mocking Firestore.
  processDocsForPagination(docs: Array<{ id: string; data: () => any }>, pageSize: number) {
    const hasMore = docs.length > pageSize;
    const docsToProcess = hasMore ? docs.slice(0, pageSize) : docs;
    const reminders: ReminderHistoryEntry[] = [];
    let newLastDocument: { id: string } | null = null;

    docsToProcess.forEach((doc) => {
      const data = doc.data();
      reminders.push({ id: doc.id, ...data } as ReminderHistoryEntry);
      newLastDocument = doc as any;
    });

    return {
      reminders,
      lastDocument: newLastDocument,
      hasMore
    };
  }

  // Get reminder batches for a user
  async getReminderBatches(tenantId: string, userId: string, limit?: number): Promise<ReminderBatch[]> {
    try {
      const scopedTenantId = this.ensureTenantId(tenantId);
      let q = query(
        collection(firestore, this.batchCollectionName),
        where('tenantId', '==', scopedTenantId),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc')
      );

      const querySnapshot = await getDocs(q);
      const batches: ReminderBatch[] = [];

      querySnapshot.forEach((doc) => {
        batches.push({
          id: doc.id,
          ...doc.data()
        } as ReminderBatch);
      });

      if (limit && batches.length > limit) {
        return batches.slice(0, limit);
      }

      return batches;
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        // Batches are always read self-scoped, so a denial is never expected.
        logReminderPermissionDenied('getReminderBatches', userId, error);
        return [];
      }
      logger.error('Error fetching reminder batches:', error);
      return [];
    }
  }

  // Get reminder statistics for a user or across all users (when userId is null)
  async getReminderStats(
    tenantId: string,
    userId: string | null,
    days: number | 'all' = 30,
    filters?: { studentId?: string; reminderType?: string; status?: string; searchQuery?: string }
  ): Promise<{
    totalReminders: number;
    successfulReminders: number;
    failedReminders: number;
    pendingReminders: number;
    remindersByType: Record<string, number>;
    remindersByStatus: Record<string, number>;
  }> {
    try {
      const scopedTenantId = this.ensureTenantId(tenantId);
      const constraints: any[] = [
        where('tenantId', '==', scopedTenantId),
        orderBy('createdAt', 'desc'),
      ];

      if (days !== 'all') {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - (typeof days === 'number' ? days : 30));
        constraints.unshift(where('createdAt', '>=', Timestamp.fromDate(startDate)));
      }

      if (userId) {
        constraints.unshift(where('userId', '==', userId));
      }

      if (filters?.studentId) {
        constraints.unshift(where('studentId', '==', filters.studentId));
      }

      const effectiveType = filters?.reminderType && filters.reminderType !== 'all' ? filters.reminderType : undefined;
      if (effectiveType) {
        constraints.unshift(where('reminderType', '==', effectiveType));
      }

      const q = query(
        collection(firestore, this.collectionName),
        ...constraints
      );

      const querySnapshot = await getDocs(q);
      const stats = {
        totalReminders: 0,
        successfulReminders: 0,
        failedReminders: 0,
        pendingReminders: 0,
        remindersByType: {} as Record<string, number>,
        remindersByStatus: {} as Record<string, number>,
      };

      const searchQ = (filters?.searchQuery || '').trim().toLowerCase();
      const statusFilter = filters?.status && filters.status !== 'all' ? filters.status : undefined;

      const matchSearch = (rec: ReminderHistoryEntry) => {
        if (!searchQ) return true;
        const safe = (v: any) => (v ?? '').toString().toLowerCase();
        const inArr = (arr?: string[]) => Array.isArray(arr) && arr.some(c => safe(c).includes(searchQ));
        const dateStr = (() => {
          try {
            const d = (rec.createdAt && (rec.createdAt as any).toDate)
              ? (rec.createdAt as any).toDate()
              : (rec.createdAt && (rec.createdAt as any).seconds)
                ? new Date((rec.createdAt as any).seconds * 1000)
                : null;
            return d ? (d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).toLowerCase() : '';
          } catch { return ''; }
        })();
        return (
          safe(rec.studentName).includes(searchQ) ||
          safe(rec.parentName).includes(searchQ) ||
          safe(rec.parentContact).includes(searchQ) ||
          safe(rec.parentEmail).includes(searchQ) ||
          safe(rec.message).includes(searchQ) ||
          safe(rec.amount).includes(searchQ) ||
          inArr(rec.feeCategories) ||
          safe(rec.reminderType).includes(searchQ) ||
          safe(rec.status).includes(searchQ) ||
          safe(rec.errorMessage).includes(searchQ) ||
          (dateStr && dateStr.includes(searchQ))
        );
      };

      querySnapshot.forEach((doc) => {
        const data = doc.data() as ReminderHistoryEntry;
        if (statusFilter && data.status !== statusFilter) return;
        if (!matchSearch(data)) return;
        stats.totalReminders++;

        // Count by status
        if (data.status === 'success') {
          stats.successfulReminders++;
        } else if (data.status === 'failed') {
          stats.failedReminders++;
        } else if (data.status === 'pending') {
          stats.pendingReminders++;
        }

        // Count by type
        stats.remindersByType[data.reminderType] = (stats.remindersByType[data.reminderType] || 0) + 1;
        
        // Count by status
        stats.remindersByStatus[data.status] = (stats.remindersByStatus[data.status] || 0) + 1;
      });

  return stats;
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        logReminderPermissionDenied('getReminderStats', userId, error);
        throw error;
      }
      logger.error('Error fetching reminder stats:', error);
      return {
        totalReminders: 0,
        successfulReminders: 0,
        failedReminders: 0,
        pendingReminders: 0,
        remindersByType: {},
        remindersByStatus: {},
      };
    }
  }

  // Get total reminder count for optional user and filters (uses Firestore aggregation)
  async getReminderCount(
    tenantId: string,
    userId: string | null,
    filters?: { studentId?: string; reminderType?: string; status?: string }
  ): Promise<number> {
    try {
      const scopedTenantId = this.ensureTenantId(tenantId);
      const whereClauses: any[] = [where('tenantId', '==', scopedTenantId)];
      if (userId) whereClauses.push(where('userId', '==', userId));
      if (filters?.studentId) whereClauses.push(where('studentId', '==', filters.studentId));
      if (filters?.reminderType && filters.reminderType !== 'all') {
        whereClauses.push(where('reminderType', '==', filters.reminderType));
      }
      if (filters?.status && filters.status !== 'all') {
        whereClauses.push(where('status', '==', filters.status));
      }

      const q = query(collection(firestore, this.collectionName), ...whereClauses);
      const snapshot = await getCountFromServer(q);
      return snapshot.data().count;
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        logReminderPermissionDenied('getReminderCount', userId, error);
        throw error;
      }
      logger.error('Error fetching reminder count:', error);
      return 0;
    }
  }

  // Get reminder statistics for a specific date range (start inclusive, end exclusive)
  async getReminderStatsForDateRange(
    tenantId: string,
    userId: string | null,
    startDate: Date,
    endDate: Date,
    filters?: { studentId?: string; reminderType?: string; status?: string; searchQuery?: string }
  ): Promise<{
    totalReminders: number;
    successfulReminders: number;
    failedReminders: number;
    pendingReminders: number;
    remindersByType: Record<string, number>;
    remindersByStatus: Record<string, number>;
  }> {
    try {
      const scopedTenantId = this.ensureTenantId(tenantId);
      const whereClauses: any[] = [
        where('tenantId', '==', scopedTenantId),
        where('createdAt', '>=', Timestamp.fromDate(startDate)),
        where('createdAt', '<', Timestamp.fromDate(endDate)),
      ];

      if (userId) whereClauses.push(where('userId', '==', userId));
      if (filters?.studentId) whereClauses.push(where('studentId', '==', filters.studentId));
      const effectiveType = filters?.reminderType && filters.reminderType !== 'all' ? filters.reminderType : undefined;
      if (effectiveType) whereClauses.push(where('reminderType', '==', effectiveType));
      const effectiveStatus = filters?.status && filters.status !== 'all' ? filters.status : undefined;
      if (effectiveStatus) whereClauses.push(where('status', '==', effectiveStatus));

      const q = query(collection(firestore, this.collectionName), ...whereClauses, orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);

      const stats = {
        totalReminders: 0,
        successfulReminders: 0,
        failedReminders: 0,
        pendingReminders: 0,
        remindersByType: {} as Record<string, number>,
        remindersByStatus: {} as Record<string, number>,
      };

      const searchQ = (filters?.searchQuery || '').trim().toLowerCase();
      const matchSearch = (rec: ReminderHistoryEntry) => {
        if (!searchQ) return true;
        const safe = (v: any) => (v ?? '').toString().toLowerCase();
        const inArr = (arr?: string[]) => Array.isArray(arr) && arr.some(c => safe(c).includes(searchQ));
        return (
          safe(rec.studentName).includes(searchQ) ||
          safe(rec.parentName).includes(searchQ) ||
          safe(rec.parentContact).includes(searchQ) ||
          safe(rec.parentEmail).includes(searchQ) ||
          safe(rec.message).includes(searchQ) ||
          safe(rec.amount).includes(searchQ) ||
          inArr(rec.feeCategories) ||
          safe(rec.reminderType).includes(searchQ) ||
          safe(rec.status).includes(searchQ) ||
          safe(rec.errorMessage).includes(searchQ)
        );
      };

      snapshot.forEach((doc) => {
        const data = doc.data() as ReminderHistoryEntry;
        if (!matchSearch(data)) return;
        stats.totalReminders++;
        if (data.status === 'success') stats.successfulReminders++;
        else if (data.status === 'failed') stats.failedReminders++;
        else if (data.status === 'pending') stats.pendingReminders++;

        stats.remindersByType[data.reminderType] = (stats.remindersByType[data.reminderType] || 0) + 1;
        stats.remindersByStatus[data.status] = (stats.remindersByStatus[data.status] || 0) + 1;
      });

      return stats;
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        logReminderPermissionDenied('getReminderStatsForDateRange', userId, error);
        throw error;
      }
      logger.error('Error fetching reminder stats for date range:', error);
      return {
        totalReminders: 0,
        successfulReminders: 0,
        failedReminders: 0,
        pendingReminders: 0,
        remindersByType: {},
        remindersByStatus: {},
      };
    }
  }

  async getMonthlyUsageSummary(tenantId: string, referenceDate: Date = new Date()): Promise<ReminderUsageSummary> {
    const windowStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
    const windowEnd = new Date(windowStart);
    windowEnd.setMonth(windowEnd.getMonth() + 1);
    try {
      const scopedTenantId = this.ensureTenantId(tenantId);
      const stats = await this.getReminderStatsForDateRange(scopedTenantId, null, windowStart, windowEnd);

      return {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        totalReminders: stats.totalReminders,
        successfulReminders: stats.successfulReminders,
        failedReminders: stats.failedReminders,
        pendingReminders: stats.pendingReminders,
      };
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        logger.debug('Monthly reminder usage summary denied for current scope; returning zeroes');
      } else {
        logger.error('Error loading monthly reminder usage summary', error);
      }
      return {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        totalReminders: 0,
        successfulReminders: 0,
        failedReminders: 0,
        pendingReminders: 0,
      };
    }
  }
}

export const reminderHistoryService = new ReminderHistoryService();
