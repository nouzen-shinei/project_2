import { logger } from '@/lib/logger';
import {
  collection,
  doc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  writeBatch,
} from 'firebase/firestore';
import { firestore } from '../config/firebase';
import { internalTokenManager } from './internalTokenManager';
import type { FeeHistoryEntry, TenantAuditLogEntry } from '../types';
import { tenantService } from './tenantService';
import { runtimeEndpoints } from './runtimeEndpoints';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { authService } from '@/hooks/useAuthUnified';

export interface Student {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  phone: string;
  grade: string;
  enrolledCourses: string[];
  feesPaid: number;
  totalFees: number;
  lastPaymentDate?: string;
  parentName?: string;
  parentPhone?: string;
  parentEmail?: string;
  parentContact?: string;
  parentWhatsApp?: string;
  parentRelation?: string;
  address?: string;
  dateOfBirth?: string;
  emergencyContact?: string;
  profileImageUrl?: string;
  enrollmentDate: string;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  updatedAt: string;
  createdBy?: string; // User who created this student
  subjects?: string[];
  attendance?: number;
  performance?: string;
  monthlyFee?: number;
  joinDate?: string;
  order?: number;
  feeHistory?: FeeHistoryEntry[]; // Track fee deletions and modifications
}

export type CreateStudentData = Omit<Student, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>;
export type UpdateStudentData = Partial<Omit<Student, 'id' | 'tenantId' | 'createdAt'>>;

class StudentService {
  private studentsRef = collection(firestore, 'students');
  private feesRef = collection(firestore, 'fees');
  private getBackendBaseUrl(): string {
    const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (!baseUrl) {
      throw new Error(
        'Backend base URL not configured. Set Firestore appSettings/runtimeEndpoints.apiBaseUrl to enable backend enforcement.',
      );
    }
    return baseUrl;
  }

  private async logFeeAudit(
    tenantId: string,
    action: Extract<TenantAuditLogEntry['action'], 'fee_payment_updated' | 'fee_due_dates_updated'>,
    details: { targetId?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    const actor = authService.getCurrentUser();
    if (!actor) {
      return;
    }
    try {
      await tenantService.logAuditEvent({
        tenantId,
        actorId: actor.uid,
        actorEmail: actor.email,
        action,
        targetId: details.targetId,
        targetType: 'fee',
        metadata: details.metadata,
      });
    } catch (error) {
      logger.warn('📚 StudentService: Failed to log fee audit event', error);
    }
  }

  /**
   * Subscribe to students list for a tenant
   */
  subscribeToStudents(
    tenantId: string,
    onSuccess: (students: Student[]) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const q = query(this.studentsRef, where('tenantId', '==', tenantId), orderBy('createdAt', 'desc'));
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const attach = (context?: string) => {
      if (disposed) return;
      unsubscribe?.();
      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const students = snapshot.docs.map((docSnap) => ({
            id: docSnap.id,
            ...docSnap.data(),
          })) as Student[];

          students.sort((a, b) => {
            const orderA = a.order ?? 999999;
            const orderB = b.order ?? 999999;
            return orderA - orderB;
          });

          onSuccess(students);
        },
        (error) => {
          logger.error('📚 StudentService: subscribeToStudents failed', error);
          onError?.(error as Error);
        },
      );

      if (context) {
        logger.debug('StudentService: subscribeToStudents reattached', { context, tenantId });
      }
    };

    attach('initial');
    const unregister = authService.registerFirestoreReinit?.(() => attach('reinit'));

    return () => {
      disposed = true;
      unsubscribe?.();
      try {
        unregister?.();
      } catch {}
    };
  }

  /**
   * Get all students for a tenant
   */
  async getAllStudents(tenantId: string): Promise<Student[]> {
    try {
      logger.debug('📚 StudentService: Fetching all students');
      const q = query(this.studentsRef, where('tenantId', '==', tenantId), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);

      const students = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      })) as Student[];

      students.sort((a, b) => {
        const orderA = a.order ?? 999999;
        const orderB = b.order ?? 999999;
        return orderA - orderB;
      });

      logger.debug('📚 StudentService: Fetched', students.length, 'students');
      return students;
    } catch (error) {
      logger.error('📚 StudentService: Error fetching students:', error);
      throw new Error(`Failed to fetch students: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get a single student by ID
   */
  async getStudentById(tenantId: string, id: string): Promise<Student | null> {
    try {
      logger.debug('📚 StudentService: Fetching student:', id);
      const docRef = doc(this.studentsRef, id);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.tenantId !== tenantId) {
          logger.warn('📚 StudentService: Tenant mismatch when fetching student', { id, tenantId });
          return null;
        }
        const student = { id: docSnap.id, ...data } as Student;
        logger.debug('📚 StudentService: Found student:', student.name);
        return student;
      } else {
        logger.debug('📚 StudentService: Student not found:', id);
        return null;
      }
    } catch (error) {
      logger.error('📚 StudentService: Error fetching student:', error);
      throw new Error(`Failed to fetch student: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Search students by various criteria
   */
  async searchStudents(tenantId: string, searchTerm: string): Promise<Student[]> {
    try {
      logger.debug('📚 StudentService: Searching students with term:', searchTerm);
      
      // For now, we'll fetch all and filter client-side
      // In production, consider implementing server-side search with Algolia or similar
      const allStudents = await this.getAllStudents(tenantId);
      
      const searchLower = searchTerm.toLowerCase();
      const filtered = allStudents.filter(student => 
        student.name.toLowerCase().includes(searchLower) ||
        student.email.toLowerCase().includes(searchLower) ||
        student.phone.includes(searchTerm) ||
        student.grade.toLowerCase().includes(searchLower) ||
        (student.parentName && student.parentName.toLowerCase().includes(searchLower))
      );
      
      logger.debug('📚 StudentService: Found', filtered.length, 'matching students');
      return filtered;
    } catch (error) {
      logger.error('📚 StudentService: Error searching students:', error);
      throw new Error(`Failed to search students: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get students by status
   */
  async getStudentsByStatus(tenantId: string, status: Student['status']): Promise<Student[]> {
    try {
      logger.debug('📚 StudentService: Fetching students with status:', status);
      const q = query(
        this.studentsRef, 
        where('tenantId', '==', tenantId),
        where('status', '==', status),
        orderBy('createdAt', 'desc')
      );
      const snapshot = await getDocs(q);
      
      const students = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Student[];
      
      logger.debug('📚 StudentService: Found', students.length, status, 'students');
      return students;
    } catch (error) {
      logger.error('📚 StudentService: Error fetching students by status:', error);
      throw new Error(`Failed to fetch ${status} students: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Add a new student
   */
  async addStudent(tenantId: string, studentData: CreateStudentData, createdBy?: string): Promise<string> {
    try {
      this.validateStudentData(studentData);

      const actualCreatedBy = createdBy || 'Unknown User';

      // Get the next order number
      const allStudents = await this.getAllStudents(tenantId);
      const maxOrder = allStudents.length > 0 ? Math.max(...allStudents.map((s) => s.order || 0)) : 0;
      const studentDataWithOrder: CreateStudentData = {
        ...studentData,
        order: maxOrder + 1,
      };

      const baseUrl = this.getBackendBaseUrl();
      internalTokenManager.setBaseUrl(baseUrl);
      const doRequest = async (token?: string) =>
        await fetch(`${baseUrl}/students/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ tenantId, studentData: studentDataWithOrder, createdBy: actualCreatedBy }),
        });

      const token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        throw new Error('Authentication token missing. Please sign in again.');
      }

      let res = await doRequest(token);
      if (res.status === 401) {
        const retryToken = await internalTokenManager.forceRefresh(baseUrl);
        if (!retryToken) {
          throw new Error('Authentication token missing. Please sign in again.');
        }
        res = await doRequest(retryToken);
      }

      if (res.status === 409) {
        const data = await res.json().catch(() => undefined);
        if (data?.error === 'student_limit_reached') {
          const limit = typeof data.limit === 'number' ? data.limit : undefined;
          throw new Error(
            `Student limit reached${limit ? ` for this plan (${limit})` : ''}. Remove inactive records or upgrade to add more students.`,
          );
        }
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        maybeShowMaintenanceAlertFromRaw(res.status, txt);
        throw new Error(txt || `Failed to add student (HTTP ${res.status})`);
      }

      const json = await res.json().catch(() => undefined);
      if (!json?.id) {
        throw new Error('Backend did not return a student id');
      }

      logger.debug('📚 StudentService: Student added via backend with ID:', json.id);
      return String(json.id);
    } catch (error) {
      logger.error('📚 StudentService: Error adding student:', error);
      throw new Error(`Failed to add student: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update a student
   */
  async updateStudent(tenantId: string, id: string, updates: UpdateStudentData): Promise<void> {
    try {
      logger.debug('📚 StudentService: Updating student:', id);

      const docRef = doc(this.studentsRef, id);
      const existingSnapshot = await getDoc(docRef);
      if (!existingSnapshot.exists()) {
        throw new Error('Student not found');
      }
      const existingData = existingSnapshot.data() as Student;
      if (existingData.tenantId !== tenantId) {
        throw new Error('Student not found');
      }

      const sanitizedUpdates: UpdateStudentData = { ...updates };
      let newNameToPropagate: string | null = null;

      if (typeof sanitizedUpdates.name === 'string') {
        const trimmed = sanitizedUpdates.name.trim();
        if (!trimmed) {
          delete sanitizedUpdates.name;
        } else {
          sanitizedUpdates.name = trimmed;
          const currentName = (existingData.name || '').trim();
          if (currentName !== trimmed) {
            newNameToPropagate = trimmed;
          }
        }
      }

      await updateDoc(docRef, {
        ...sanitizedUpdates,
        updatedAt: new Date().toISOString(),
      });

      if (newNameToPropagate) {
        await this.updateRelatedFeesStudentName(tenantId, id, newNameToPropagate);
      }

      logger.debug('📚 StudentService: Student updated successfully');
    } catch (error) {
      logger.error('📚 StudentService: Error updating student:', error);
      throw new Error(`Failed to update student: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async updateRelatedFeesStudentName(tenantId: string, studentId: string, newName: string): Promise<void> {
    try {
      const feesQuery = query(
        this.feesRef,
        where('tenantId', '==', tenantId),
        where('studentId', '==', studentId)
      );
      const snapshot = await getDocs(feesQuery);

      if (snapshot.empty) {
        logger.debug('📚 StudentService: No fee records to update for student:', studentId);
        return;
      }

      const batch = writeBatch(firestore);
      const now = new Date().toISOString();

      snapshot.forEach((feeDoc) => {
        batch.update(feeDoc.ref, {
          studentName: newName,
          updatedAt: now,
        });
      });

  await batch.commit();
  logger.debug(`📚 StudentService: Updated ${snapshot.size} fee record(s) with new student name`);
    } catch (error) {
      logger.error('📚 StudentService: Failed to update related fees for student:', studentId, error);
      throw new Error(`Failed to update related fees: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete a student
   */
  async deleteStudent(tenantId: string, id: string): Promise<void> {
    try {
      logger.debug('📚 StudentService: Deleting student:', id);
      
      const docRef = doc(this.studentsRef, id);
      const existingSnapshot = await getDoc(docRef);
      if (!existingSnapshot.exists()) {
        throw new Error('Student not found');
      }
      if ((existingSnapshot.data() as Student).tenantId !== tenantId) {
        throw new Error('Student not found');
      }
      await deleteDoc(docRef);
      
      logger.debug('📚 StudentService: Student deleted successfully');
    } catch (error) {
      logger.error('📚 StudentService: Error deleting student:', error);
      throw new Error(`Failed to delete student: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Add fee history entry to student record
   */
  async addFeeHistoryEntry(
    tenantId: string,
    studentId: string, 
    feeHistoryEntry: Omit<FeeHistoryEntry, 'id' | 'performedBy' | 'performedAt'>,
    performedBy: string
  ): Promise<void> {
    try {
      const student = await this.getStudentById(tenantId, studentId);
      if (!student) {
        throw new Error('Student not found');
      }

      const historyEntry: FeeHistoryEntry = {
        id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        ...feeHistoryEntry,
        performedBy,
        performedAt: new Date().toISOString(),
      };

      const currentHistory = student.feeHistory || [];
      const updatedHistory = [...currentHistory, historyEntry];

      await this.updateStudent(tenantId, studentId, { feeHistory: updatedHistory });
      
      logger.debug('📚 StudentService: Fee history entry added for student:', studentId);
    } catch (error) {
      logger.error('📚 StudentService: Error adding fee history entry:', error);
      throw new Error(`Failed to add fee history entry: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update student fees
   */
  async updateStudentFees(tenantId: string, id: string, feesPaid: number, lastPaymentDate?: string): Promise<void> {
    try {
      logger.debug('📚 StudentService: Updating fees for student:', id);
      
      const updates: UpdateStudentData = {
        feesPaid,
        updatedAt: new Date().toISOString(),
      };
      
      if (lastPaymentDate) {
        updates.lastPaymentDate = lastPaymentDate;
      }
      
      await this.updateStudent(tenantId, id, updates);
      void this.logFeeAudit(tenantId, 'fee_payment_updated', {
        targetId: id,
        metadata: {
          feesPaid,
          lastPaymentDate: lastPaymentDate ?? null,
        },
      });
      logger.debug('📚 StudentService: Fees updated successfully');
    } catch (error) {
      logger.error('📚 StudentService: Error updating fees:', error);
      throw new Error(`Failed to update fees: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get students with outstanding fees
   */
  async getStudentsWithOutstandingFees(tenantId: string): Promise<Student[]> {
    try {
      logger.debug('📚 StudentService: Fetching students with outstanding fees');
      const allStudents = await this.getAllStudents(tenantId);
      
      const studentsWithFees = allStudents.filter(student => 
        student.feesPaid < student.totalFees && student.status === 'active'
      );
      
      logger.debug('📚 StudentService: Found', studentsWithFees.length, 'students with outstanding fees');
      return studentsWithFees;
    } catch (error) {
      logger.error('📚 StudentService: Error fetching students with outstanding fees:', error);
      throw new Error(`Failed to fetch students with outstanding fees: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update fee due dates for a student when their fee due date preference changes
   * This method ONLY updates existing pending/overdue fees and never creates new fees
   */
  async updateStudentFeeDueDates(tenantId: string, studentId: string, newFeeDueDate: number): Promise<number> {
    try {
      logger.debug('💰 StudentService: Updating fee due dates for student:', studentId, 'to day:', newFeeDueDate);
      // Use statically imported Firestore methods and the existing firestore instance
      const db = firestore;
      // Get all pending and overdue fees for this student (ONLY existing fees, never creates new ones)
      const feesQuery = query(
        collection(db, 'fees'),
        where('tenantId', '==', tenantId),
        where('studentId', '==', studentId),
        where('status', 'in', ['pending', 'overdue'])
      );
      const feesSnapshot = await getDocs(feesQuery);
      logger.debug(`💰 StudentService: Found ${feesSnapshot.docs.length} existing pending/overdue fees to update`);
      if (feesSnapshot.empty) {
        logger.debug('💰 StudentService: No pending fees found to update');
        return 0;
      }
      // Update due dates for each existing pending fee (preserving month/year, only changing day)
      const updatePromises = feesSnapshot.docs.map(async (feeDoc) => {
        const feeData = feeDoc.data();
        const currentDueDate = feeData.dueDate;
        if (currentDueDate) {
          // Extract year and month from current due date
          const dateParts = currentDueDate.split('-');
          if (dateParts.length >= 2) {
            const year = dateParts[0];
            const month = dateParts[1];
            // Calculate new due date with updated day (respecting month boundaries)
            const maxDaysInMonth = new Date(parseInt(year), parseInt(month), 0).getDate();
            const validDueDay = Math.min(newFeeDueDate, maxDaysInMonth);
            const newDueDate = `${year}-${month}-${validDueDay.toString().padStart(2, '0')}`;
            // Only update if the date actually changed
            if (currentDueDate !== newDueDate) {
              logger.debug(`💰 Updating existing fee ${feeDoc.id}: ${currentDueDate} -> ${newDueDate} (month ${year}-${month})`);
              return updateDoc(doc(db, 'fees', feeDoc.id), {
                dueDate: newDueDate,
                updatedAt: new Date().toISOString(),
              });
            } else {
              logger.debug(`💰 Fee ${feeDoc.id} already has correct due date: ${currentDueDate}`);
              return null;
            }
          }
        }
        return null;
      });
      const validPromises = updatePromises.filter(Boolean);
      await Promise.all(validPromises);
      logger.debug(`💰 StudentService: Successfully updated ${validPromises.length} existing fee records with new due date`);
      logger.debug(`💰 StudentService: No new fees were created - only existing fees were updated`);
      if (validPromises.length > 0) {
        void this.logFeeAudit(tenantId, 'fee_due_dates_updated', {
          targetId: studentId,
          metadata: {
            studentId,
            newFeeDueDate,
            updatedCount: validPromises.length,
          },
        });
      }
      return validPromises.length;
    } catch (error) {
      logger.error('💰 StudentService: Error updating fee due dates:', error);
      throw new Error(`Failed to update fee due dates: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Migrate students without order field to have proper ordering
   */
  private async migrateStudentsOrder(tenantId: string, students: Student[]): Promise<void> {
    try {
      logger.debug('📚 StudentService: Starting order migration');
      
      // Sort by createdAt to maintain some consistency
      const sortedStudents = [...students].sort((a, b) => 
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      
      const updates = sortedStudents.map((student, index) => {
        if (student.order === undefined || student.order === null) {
          return this.updateStudent(tenantId, student.id, { order: index + 1 });
        }
        return Promise.resolve();
      });
      
      await Promise.all(updates);
      logger.debug('📚 StudentService: Order migration completed');
    } catch (error) {
      logger.error('📚 StudentService: Error during order migration:', error);
    }
  }

  /**
   * Move student up in the order
   */
  async moveStudentUp(tenantId: string, studentId: string): Promise<void> {
    try {
      logger.debug('📚 StudentService: Moving student up:', studentId);
      
      const allStudents = await this.getAllStudents(tenantId);
      const currentIndex = allStudents.findIndex(s => s.id === studentId);
      
      if (currentIndex === -1) {
        throw new Error('Student not found');
      }
      
      if (currentIndex === 0) {
        logger.debug('📚 StudentService: Student is already at the top');
        return; // Already at the top
      }
      
      // Swap order with the previous student
      const currentStudent = allStudents[currentIndex];
      const previousStudent = allStudents[currentIndex - 1];
      
      const currentOrder = currentStudent.order || currentIndex + 1;
      const previousOrder = previousStudent.order || currentIndex;
      
      // Update both students
      await Promise.all([
        this.updateStudent(tenantId, currentStudent.id, { order: previousOrder }),
        this.updateStudent(tenantId, previousStudent.id, { order: currentOrder })
      ]);
      
      logger.debug('📚 StudentService: Student moved up successfully');
    } catch (error) {
      logger.error('📚 StudentService: Error moving student up:', error);
      throw new Error(`Failed to move student up: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Move student down in the order
   */
  async moveStudentDown(tenantId: string, studentId: string): Promise<void> {
    try {
      logger.debug('📚 StudentService: Moving student down:', studentId);
      
      const allStudents = await this.getAllStudents(tenantId);
      const currentIndex = allStudents.findIndex(s => s.id === studentId);
      
      if (currentIndex === -1) {
        throw new Error('Student not found');
      }
      
      if (currentIndex === allStudents.length - 1) {
        logger.debug('📚 StudentService: Student is already at the bottom');
        return; // Already at the bottom
      }
      
      // Swap order with the next student
      const currentStudent = allStudents[currentIndex];
      const nextStudent = allStudents[currentIndex + 1];
      
      const currentOrder = currentStudent.order || currentIndex + 1;
      const nextOrder = nextStudent.order || currentIndex + 2;
      
      // Update both students
      await Promise.all([
        this.updateStudent(tenantId, currentStudent.id, { order: nextOrder }),
        this.updateStudent(tenantId, nextStudent.id, { order: currentOrder })
      ]);
      
      logger.debug('📚 StudentService: Student moved down successfully');
    } catch (error) {
      logger.error('📚 StudentService: Error moving student down:', error);
      throw new Error(`Failed to move student down: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate student data before saving
   */
  private validateStudentData(data: CreateStudentData | UpdateStudentData): void {
    if ('name' in data && (!data.name || data.name.trim().length === 0)) {
      throw new Error('Student name is required');
    }
    
    if ('email' in data && data.email && !this.isValidEmail(data.email)) {
      throw new Error('Invalid email format');
    }
    
    if ('phone' in data && data.phone && !this.isValidPhone(data.phone)) {
      throw new Error('Invalid phone format');
    }
    
    if ('feesPaid' in data && data.feesPaid !== undefined && data.feesPaid < 0) {
      throw new Error('Fees paid cannot be negative');
    }
    
    if ('totalFees' in data && data.totalFees !== undefined && data.totalFees < 0) {
      throw new Error('Total fees cannot be negative');
    }
  }

  /**
   * Validate email format
   */
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validate phone format (basic validation)
   */
  private isValidPhone(phone: string): boolean {
    const phoneRegex = /^[\+]?[\d\s\-\(\)]{10,}$/;
    return phoneRegex.test(phone);
  }
}

// Export singleton instance
export const studentService = new StudentService();
export default studentService;