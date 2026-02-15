import { logger } from '@/lib/logger';
import { 
  collection, 
  doc, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  orderBy,
  writeBatch,
  getDoc
} from 'firebase/firestore';
import { firestore as db } from '../config/firebase';
import type { AttendanceRecord, TenantAuditLogEntry } from '../types';
import { authService } from '@/hooks/useAuthUnified';
import { tenantService } from './tenantService';

class AttendanceService {
  private collectionName = 'attendance';

  private collectionRef = collection(db, this.collectionName);

  private async logAttendanceAudit(
    tenantId: string,
    action: Extract<TenantAuditLogEntry['action'],
      'attendance_record_saved' | 'attendance_records_batch_saved' | 'attendance_record_deleted'>,
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
        targetType: 'attendance',
        metadata: details.metadata,
      });
    } catch (error) {
      logger.debug('Attendance audit log failed', error);
    }
  }

  private ensureTenantId(tenantId: string): string {
    if (!tenantId) {
      throw new Error('tenantId is required for attendance operations');
    }
    return tenantId;
  }

  // Get all attendance records for a specific student
  async getStudentAttendance(tenantId: string, studentId: string): Promise<AttendanceRecord[]> {
    try {
      this.ensureTenantId(tenantId);
      const q = query( 
        this.collectionRef,
        where('tenantId', '==', tenantId),
        where('studentId', '==', studentId),
        orderBy('date', 'desc')
      );
      
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as AttendanceRecord[];
    } catch (error) {
      logger.error('Error fetching student attendance:', error);
      throw error;
    }
  }

  // Get attendance records for multiple students
  async getMultipleStudentsAttendance(tenantId: string, studentIds: string[]): Promise<AttendanceRecord[]> {
    try {
      if (studentIds.length === 0) return [];
      this.ensureTenantId(tenantId);
      
      const q = query(
        this.collectionRef,
        where('tenantId', '==', tenantId),
        where('studentId', 'in', studentIds),
        orderBy('date', 'desc')
      );
      
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as AttendanceRecord[];
    } catch (error) {
      logger.error('Error fetching multiple students attendance:', error);
      throw error;
    }
  }

  // Get attendance records for a specific date range
  async getAttendanceByDateRange(
    tenantId: string,
    studentIds: string[], 
    startDate: string, 
    endDate: string
  ): Promise<AttendanceRecord[]> {
    try {
      if (studentIds.length === 0) return [];
      this.ensureTenantId(tenantId);
      
      const q = query(
        this.collectionRef,
        where('tenantId', '==', tenantId),
        where('studentId', 'in', studentIds),
        where('date', '>=', startDate),
        where('date', '<=', endDate),
        orderBy('date', 'desc')
      );
      
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as AttendanceRecord[];
    } catch (error) {
      logger.error('Error fetching attendance by date range:', error);
      throw error;
    }
  }

  // Add or update attendance record
  async saveAttendanceRecord(
    tenantId: string,
    record: Omit<AttendanceRecord, 'id' | 'tenantId'>,
  ): Promise<string> {
    try {
      this.ensureTenantId(tenantId);
      // Check if record already exists for this student and date
      const existingQuery = query(
        this.collectionRef,
        where('tenantId', '==', tenantId),
        where('studentId', '==', record.studentId),
        where('date', '==', record.date)
      );
      
      const existingSnapshot = await getDocs(existingQuery);
      
      if (!existingSnapshot.empty) {
        // Update existing record
        const existingDoc = existingSnapshot.docs[0];
        if (existingDoc.data()?.tenantId !== tenantId) {
          throw new Error('Attendance record belongs to another coaching center');
        }
        await updateDoc(doc(db, this.collectionName, existingDoc.id), {
          tenantId,
          ...record,
          updatedAt: new Date().toISOString()
        });
        void this.logAttendanceAudit(tenantId, 'attendance_record_saved', {
          targetId: existingDoc.id,
          metadata: {
            operation: 'update',
            studentId: record.studentId,
            date: record.date,
            status: record.status,
          },
        });
        return existingDoc.id;
      } else {
        // Create new record
        const docRef = await addDoc(collection(db, this.collectionName), {
          tenantId,
          ...record,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
        void this.logAttendanceAudit(tenantId, 'attendance_record_saved', {
          targetId: docRef.id,
          metadata: {
            operation: 'create',
            studentId: record.studentId,
            date: record.date,
            status: record.status,
          },
        });
        return docRef.id;
      }
    } catch (error) {
      logger.error('Error saving attendance record:', error);
      throw error;
    }
  }

  // Batch save multiple attendance records
  async batchSaveAttendanceRecords(
    tenantId: string,
    records: Omit<AttendanceRecord, 'id' | 'tenantId'>[],
  ): Promise<void> {
    try {
      this.ensureTenantId(tenantId);
      const batch = writeBatch(db);
      const timestamp = new Date().toISOString();
      const summary = {
        created: 0,
        updated: 0,
        studentIds: new Set<string>(),
        dates: new Set<string>(),
      };
      
      for (const record of records) {
        // Check if record already exists
        const existingQuery = query(
          this.collectionRef,
          where('tenantId', '==', tenantId),
          where('studentId', '==', record.studentId),
          where('date', '==', record.date)
        );
        
        const existingSnapshot = await getDocs(existingQuery);
        
        if (!existingSnapshot.empty) {
          // Update existing record
          const existingDoc = existingSnapshot.docs[0];
          if (existingDoc.data()?.tenantId !== tenantId) {
            throw new Error('Attendance record belongs to another coaching center');
          }
          batch.update(doc(db, this.collectionName, existingDoc.id), {
            tenantId,
            ...record,
            updatedAt: timestamp
          });
          summary.updated += 1;
        } else {
          // Create new record
          const newDocRef = doc(collection(db, this.collectionName));
          batch.set(newDocRef, {
            tenantId,
            ...record,
            createdAt: timestamp,
            updatedAt: timestamp
          });
          summary.created += 1;
        }
        summary.studentIds.add(record.studentId);
        summary.dates.add(record.date);
      }
      
      await batch.commit();
      if (summary.created || summary.updated) {
        void this.logAttendanceAudit(tenantId, 'attendance_records_batch_saved', {
          metadata: {
            created: summary.created,
            updated: summary.updated,
            studentIds: Array.from(summary.studentIds),
            dates: Array.from(summary.dates),
          },
        });
      }
    } catch (error) {
      logger.error('Error batch saving attendance records:', error);
      throw error;
    }
  }

  // Delete attendance record
  async deleteAttendanceRecord(tenantId: string, recordId: string): Promise<void> {
    try {
      this.ensureTenantId(tenantId);
      const recordRef = doc(db, this.collectionName, recordId);
      const recordSnap = await getDoc(recordRef);
      if (!recordSnap.exists()) {
        throw new Error('Attendance record not found');
      }
      if (recordSnap.data()?.tenantId !== tenantId) {
        throw new Error('Attendance record belongs to another coaching center');
      }
      await deleteDoc(recordRef);
      const record = recordSnap.data() as AttendanceRecord;
      void this.logAttendanceAudit(tenantId, 'attendance_record_deleted', {
        targetId: recordId,
        metadata: {
          studentId: record.studentId,
          date: record.date,
          status: record.status,
        },
      });
    } catch (error) {
      logger.error('Error deleting attendance record:', error);
      throw error;
    }
  }

  // Calculate attendance percentage for a student
  async calculateAttendancePercentage(
    tenantId: string,
    studentId: string, 
    startDate?: string, 
    endDate?: string
  ): Promise<number> {
    try {
      this.ensureTenantId(tenantId);
      let q;
      
      if (startDate && endDate) {
        q = query(
          this.collectionRef,
          where('tenantId', '==', tenantId),
          where('studentId', '==', studentId),
          where('date', '>=', startDate),
          where('date', '<=', endDate)
        );
      } else {
        q = query(
          this.collectionRef,
          where('tenantId', '==', tenantId),
          where('studentId', '==', studentId)
        );
      }
      
      const querySnapshot = await getDocs(q);
      const records = querySnapshot.docs.map(doc => doc.data()) as AttendanceRecord[];
      
      if (records.length === 0) return 0;
      
      const presentCount = records.filter(
        record => record.status === 'present' || record.status === 'late'
      ).length;
      
      return Math.round((presentCount / records.length) * 100);
    } catch (error) {
      logger.error('Error calculating attendance percentage:', error);
      throw error;
    }
  }

  // Get attendance summary for all students
  async getAttendanceSummary(tenantId: string, studentIds: string[]): Promise<{
    studentId: string;
    totalDays: number;
    presentDays: number;
    absentDays: number;
    lateDays: number;
    excusedDays: number;
    percentage: number;
  }[]> {
    try {
      if (studentIds.length === 0) return [];
      this.ensureTenantId(tenantId);
      
      const records = await this.getMultipleStudentsAttendance(tenantId, studentIds);
      const summary: { [key: string]: any } = {};
      
      // Initialize summary for each student
      studentIds.forEach(studentId => {
        summary[studentId] = {
          studentId,
          totalDays: 0,
          presentDays: 0,
          absentDays: 0,
          lateDays: 0,
          excusedDays: 0,
          percentage: 0
        };
      });
      
      // Calculate statistics
      records.forEach(record => {
        if (summary[record.studentId]) {
          summary[record.studentId].totalDays++;
          
          switch (record.status) {
            case 'present':
              summary[record.studentId].presentDays++;
              break;
            case 'absent':
              summary[record.studentId].absentDays++;
              break;
            case 'late':
              summary[record.studentId].lateDays++;
              break;
            case 'excused':
              summary[record.studentId].excusedDays++;
              break;
          }
        }
      });
      
      // Calculate percentages
      Object.keys(summary).forEach(studentId => {
        const student = summary[studentId];
        if (student.totalDays > 0) {
          student.percentage = Math.round(
            ((student.presentDays + student.lateDays) / student.totalDays) * 100
          );
        }
      });
      
      return Object.values(summary);
    } catch (error) {
      logger.error('Error getting attendance summary:', error);
      throw error;
    }
  }
}

export const attendanceService = new AttendanceService();
