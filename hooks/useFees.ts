import { logger } from '@/lib/logger';
import { useState, useEffect } from 'react';
import { useAuth, authService } from './useAuthUnified';
import { useTenant } from './useTenantContext';
import type { FeeRecord, TenantAuditLogEntry } from '../types';
import {
  getFirestore,
  getFirestore as getFirestoreClient,
  collection,
  onSnapshot,
  addDoc,
  doc,
  doc as docClient,
  updateDoc,
  deleteField,
  deleteDoc,
  deleteDoc as deleteDocClient,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
} from 'firebase/firestore';
import { ref as storageRef, deleteObject } from 'firebase/storage';
import { storage } from '../config/firebase';
import { studentService } from '../services/studentService';
import { tenantService } from '../services/tenantService';

// Re-export the FeeRecord interface for backward compatibility
export type { FeeRecord } from '../types';

const extractStoragePath = (downloadUrl: string): string | null => {
  try {
    const url = new URL(downloadUrl);
    const [, path] = url.pathname.split('/o/');
    if (!path) {
      return null;
    }
    return decodeURIComponent(path);
  } catch (error) {
    logger.warn('Failed to parse storage path from receipt URL', { downloadUrl, error });
    return null;
  }
};

const deleteReceiptAsset = async (pathOrUrl: string) => {
  if (!pathOrUrl) {
    return;
  }

  try {
    let targetRef;
    if (pathOrUrl.startsWith('http')) {
      const storagePath = extractStoragePath(pathOrUrl);
      targetRef = storageRef(storage, storagePath ?? pathOrUrl);
    } else {
      targetRef = storageRef(storage, pathOrUrl);
    }

    await deleteObject(targetRef);
  } catch (error) {
    logger.warn('Failed to delete receipt asset from storage', { pathOrUrl, error });
    throw error;
  }
};

function useFees() {
  const [fees, setFees] = useState<FeeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Get authentication status
  const { user, isAuthenticated, isInitialized } = useAuth();
  const { activeTenant, loading: tenantLoading } = useTenant();
  const [reinitKey, setReinitKey] = useState(0);

  useEffect(() => {
    const unsubscribe = authService.registerFirestoreReinit?.(() => {
      setReinitKey((prev) => prev + 1);
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {}
    };
  }, []);

  const requireTenantId = () => {
    if (!activeTenant?.id) {
      throw new Error('Select a coaching center to manage fees');
    }
    return activeTenant.id;
  };

  const logFeeAudit = async (
    tenantId: string,
    action: Extract<
      TenantAuditLogEntry['action'],
      'fee_record_created' | 'fee_record_updated' | 'fee_record_deleted' | 'fee_payment_updated'
    >,
    details?: { targetId?: string; metadata?: Record<string, unknown> }
  ) => {
    if (!user?.uid) {
      return;
    }
    try {
      await tenantService.logAuditEvent({
        tenantId,
        actorId: user.uid,
        actorEmail: user.email ?? undefined,
        action,
        targetType: 'fee',
        targetId: details?.targetId,
        metadata: details?.metadata,
      });
    } catch (auditError) {
      logger.debug('fee audit log failed', auditError);
    }
  };

  useEffect(() => {
    // Don't proceed if auth isn't initialized or user isn't authenticated
    if (!isInitialized) {
      return;
    }
    
    if (!isAuthenticated || !user) {
      setLoading(false);
      setError('Authentication required');
      return;
    }

    // Tenant selection is still being resolved; keep showing loading.
    if (tenantLoading) {
      setLoading(true);
      setError(null);
      return;
    }

    if (!activeTenant?.id) {
      setFees([]);
      setLoading(false);
      setError('No coaching center selected');
      return;
    }

    let unsubscribe: (() => void) | undefined;

    const initializeFirestore = async () => {
      try {
        // Wait a bit for Firebase to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));
    
        const db = getFirestore();
        const feesRef = collection(db, 'fees');
        const q = query(feesRef, where('tenantId', '==', activeTenant.id));

        unsubscribe = onSnapshot(q, (snapshot) => {
          const feesData = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          })) as FeeRecord[];
          
          setFees(feesData);
          setLoading(false);
          setError(null);
        }, (err) => {
          logger.error('💰 useFees: Error:', err);
          setError(err.message);
          setLoading(false);
        });

      } catch (err) {
        logger.error('💰 useFees: Initialization failed:', err);
        setError(err instanceof Error ? err.message : 'Failed to initialize');
        setLoading(false);
      }
    };

    initializeFirestore();

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [isAuthenticated, isInitialized, user, activeTenant?.id, tenantLoading, reinitKey]);

  const addFeeRecord = async (
    feeData: Omit<FeeRecord, 'id' | 'tenantId'>,
    createdBy?: string,
    approvedBy?: string
  ) => {
    try {
      const tenantId = requireTenantId();

      const db = getFirestore();
      
      // Use provided createdBy, or user's display name, or 'automatic' for system-generated
      const actualCreatedBy = createdBy || user?.displayName || user?.email?.split('@')[0] || 'Unknown';
      
      const docData: any = {
        tenantId,
        ...feeData,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: actualCreatedBy,
      };

      // If approvedBy is provided, add it to the document (for automatic fee approvals)
      if (approvedBy) {
        docData.approvedBy = approvedBy;
      }
      
      const docRef = await addDoc(collection(db, 'fees'), docData);
      void logFeeAudit(tenantId, 'fee_record_created', {
        targetId: docRef.id,
        metadata: {
          studentId: feeData.studentId,
          amount: feeData.amount,
          dueDate: feeData.dueDate,
          type: feeData.type,
          source: 'useFees.addFeeRecord',
        },
      });
      return docRef.id;
    } catch (err) {
      logger.error('Failed to add fee record:', err);
      throw err;
    }
  };

  const updateFeeRecord = async (id: string, updates: Partial<FeeRecord>) => {
    try {
      const tenantId = requireTenantId();
      const db = getFirestore();
      const feeRef = doc(db, 'fees', id);
      const existing = await getDoc(feeRef);
      if (!existing.exists() || existing.data()?.tenantId !== tenantId) {
        throw new Error('Fee record not found');
      }
      // Filter out undefined values to prevent Firestore errors
      const filteredUpdates = Object.entries(updates).reduce((acc, [key, value]) => {
        if (value !== undefined) {
          acc[key] = value;
        }
        return acc;
      }, {} as any);
      if ('tenantId' in filteredUpdates) {
        delete filteredUpdates.tenantId;
      }
      const changedFields = Object.keys(filteredUpdates);
      await updateDoc(feeRef, {
        ...filteredUpdates,
        updatedAt: new Date().toISOString(),
      });
      if (changedFields.length) {
        void logFeeAudit(tenantId, 'fee_record_updated', {
          targetId: id,
          metadata: {
            changedFields,
            status: filteredUpdates.status,
            dueDate: filteredUpdates.dueDate,
            amount: filteredUpdates.amount,
          },
        });
      }
    } catch (err) {
      logger.error('Failed to update fee record:', err);
      throw err;
    }
  };

  const markAsPaid = async (id: string, paymentMethod?: string) => {
    try {
      const tenantId = requireTenantId();
      const db = getFirestore();
      const feeRef = doc(db, 'fees', id);
      const existing = await getDoc(feeRef);
      if (!existing.exists() || existing.data()?.tenantId !== tenantId) {
        throw new Error('Fee record not found');
      }
      await updateDoc(feeRef, {
        status: 'paid' as const,
        paidDate: new Date().toISOString(),
        paymentMethod: paymentMethod || 'cash',
        updatedAt: new Date().toISOString(),
      });
      void logFeeAudit(tenantId, 'fee_payment_updated', {
        targetId: id,
        metadata: {
          status: 'paid',
          paymentMethod: paymentMethod || 'cash',
          source: 'useFees.markAsPaid',
        },
      });
    } catch (err) {
      logger.error('Failed to mark fee as paid:', err);
      throw err;
    }
  };

  const deleteFeeRecord = async (id: string, deletedBy?: string, reason?: string) => {
    try {
      const db = getFirestore();
      const tenantId = requireTenantId();
      let paymentsRemoved = 0;
      let receiptsRemoved = 0;
      let deletedFeeMetadata: Record<string, unknown> | null = null;
      
      // Get fee details before deletion for history tracking
      const feeRef = doc(db, 'fees', id);
      const feeDoc = await getDoc(feeRef);
      if (feeDoc.exists()) {
        const feeData = feeDoc.data();
        if (feeData.tenantId !== tenantId) {
          throw new Error('Fee record not found');
        }
        
        // Use provided deletedBy, or user's display name/email
        const actualDeletedBy = deletedBy || user?.displayName || user?.email?.split('@')[0] || 'Unknown User';
        
        // Add to student's fee history if we can import the student service
        try {
          await studentService.addFeeHistoryEntry(
            tenantId,
            feeData.studentId,
            {
              action: 'deleted',
              feeId: id,
              amount: feeData.amount,
              dueDate: feeData.dueDate,
              description: feeData.description || `${feeData.type} fee`,
              reason: reason || 'Fee deleted'
            },
            actualDeletedBy
          );
        } catch (serviceError) {
          logger.warn('Could not update student fee history:', serviceError);
        }

        const receipts = Array.isArray(feeData?.receipts) ? feeData.receipts : [];
        receiptsRemoved = receipts.length;
        if (receipts.length > 0) {
          const deletionTasks = receipts
            .map((receipt: any) => receipt?.storagePath || receipt?.url)
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .map(async (pathOrUrl) => {
              try {
                await deleteReceiptAsset(pathOrUrl);
              } catch (receiptError) {
                logger.warn('Failed to delete receipt while removing fee', {
                  feeId: id,
                  pathOrUrl,
                  error: receiptError,
                });
              }
            });

          if (deletionTasks.length > 0) {
            await Promise.all(deletionTasks);
          }
        }

        deletedFeeMetadata = {
          studentId: feeData.studentId,
          amount: feeData.amount,
          dueDate: feeData.dueDate,
          reason: reason || 'fee_deleted',
          receiptsRemoved,
        };
      }
      
      try {
        const paymentsRef = collection(db, 'fees', id, 'payments');
        const paymentsSnapshot = await getDocs(paymentsRef);
        if (!paymentsSnapshot.empty) {
          paymentsRemoved = paymentsSnapshot.size;
          const batch = writeBatch(db);
          paymentsSnapshot.forEach(paymentDoc => batch.delete(paymentDoc.ref));
          await batch.commit();
        }
      } catch (paymentsError) {
        logger.warn('Failed to delete payments subcollection for fee:', paymentsError);
      }

      await deleteDoc(doc(db, 'fees', id));
      if (deletedFeeMetadata) {
        void logFeeAudit(tenantId, 'fee_record_deleted', {
          targetId: id,
          metadata: {
            ...deletedFeeMetadata,
            paymentsRemoved,
          },
        });
      }
    } catch (err) {
      logger.error('Failed to delete fee record:', err);
      throw err;
    }
  };

  const deletePaymentRecord = async (feeId: string, paymentId: string) => {
    try {
      const db = getFirestore();
      const tenantId = requireTenantId();
      const feeRef = doc(db, 'fees', feeId);
      const feeDoc = await getDoc(feeRef);
      
      if (!feeDoc.exists()) {
        throw new Error('Fee record not found');
      }
      
      const feeData = feeDoc.data();
      if (feeData.tenantId !== tenantId) {
        throw new Error('Fee record not found');
      }
      const paymentDetails = { ...(feeData.paymentDetails || {}) };
      
      if (!paymentDetails[paymentId]) {
        throw new Error('Payment record not found');
      }
      
      const paymentToDelete = paymentDetails[paymentId];
      const deletedAmount = paymentToDelete.amount || 0;
      
      // Remove the payment record
      delete paymentDetails[paymentId];
      
      // Recalculate totals
      let newPaidAmount = 0;
      let newPaidMonths: string[] = [];

      // Track latest remaining payment date for fee-level paidDate
      let latestPaymentTimestamp = Number.NEGATIVE_INFINITY;
      let latestPaymentDateValue: unknown = undefined;
      let latestPaymentMethodValue: unknown = undefined;
      
      // Sum up remaining payments
      Object.values(paymentDetails).forEach((payment: any) => {
        if (payment && payment.amount) {
          const amt = typeof payment.amount === 'string' ? Number(payment.amount) : payment.amount;
          if (Number.isFinite(amt)) {
            newPaidAmount += amt;
          }
        }
        if (payment && payment.monthsPaid && Array.isArray(payment.monthsPaid)) {
          newPaidMonths = [...newPaidMonths, ...payment.monthsPaid];
        }

        const rawPaymentDate = payment?.paymentDate;
        if (rawPaymentDate) {
          let dateObj: Date | null = null;
          if (typeof rawPaymentDate === 'object' && typeof rawPaymentDate?.toDate === 'function') {
            dateObj = rawPaymentDate.toDate();
          } else {
            const parsed = new Date(rawPaymentDate);
            dateObj = Number.isNaN(parsed.getTime()) ? null : parsed;
          }

          const ts = dateObj?.getTime();
          if (typeof ts === 'number' && Number.isFinite(ts) && ts > latestPaymentTimestamp) {
            latestPaymentTimestamp = ts;
            latestPaymentDateValue = rawPaymentDate;
            latestPaymentMethodValue = payment?.method;
          }
        }
      });
      
      // Remove duplicates from paidMonths
      newPaidMonths = [...new Set(newPaidMonths)];
      
      // Determine payment status
      const newStatus = newPaidAmount >= feeData.amount ? 'paid' : 
                       newPaidAmount > 0 ? 'partial' : 'pending';
      
      // Update the fee record
      const updates: any = {
        paymentDetails,
        paidAmount: newPaidAmount,
        paidMonths: newPaidMonths,
        status: newStatus,
        updatedAt: new Date().toISOString(),
      };

      // Keep fee-level paidDate/method in sync with remaining payments
      if (newPaidAmount === 0) {
        updates.paidDate = deleteField();
        updates.method = deleteField();
        updates.paymentMethod = deleteField();
      } else {
        // Always keep last-known payment method for context (even if partially paid)
        if (latestPaymentMethodValue !== undefined) {
          updates.method = latestPaymentMethodValue;
          updates.paymentMethod = latestPaymentMethodValue;
        }

        // paidDate is treated as "fully paid" date; only keep it when status is paid
        if (newStatus === 'paid') {
          if (latestPaymentDateValue !== undefined) {
            updates.paidDate = latestPaymentDateValue;
          }
        } else {
          updates.paidDate = deleteField();
        }
      }
      
      await updateDoc(feeRef, updates);
      void logFeeAudit(tenantId, 'fee_payment_updated', {
        targetId: feeId,
        metadata: {
          deletedPaymentId: paymentId,
          deletedAmount,
          newPaidAmount,
          newStatus,
        },
      });

      // Also attempt to remove matching payments subdocument
      try {
        const dbClient = getFirestoreClient();
        await deleteDocClient(docClient(dbClient, 'fees', feeId, 'payments', paymentId));
      } catch (e) {
        logger.warn('deletePaymentRecord: failed to delete payments subdoc', e);
      }
      
      return { deletedAmount, newPaidAmount, newStatus };
    } catch (err) {
      logger.error('Failed to delete payment record:', err);
      throw err;
    }
  };

  const generateMonthlyFees = async () => {
    try {
      const tenantId = requireTenantId();
      // Use statically imported Firestore functions
      const db = getFirestore();
      // Get all active students
      const studentsSnapshot = await getDocs(
        query(collection(db, 'students'), where('tenantId', '==', tenantId))
      );
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM format
      const promises = studentsSnapshot.docs.map(async (studentDoc: any) => {
        const student = studentDoc.data();
        const studentId = studentDoc.id;
        // Skip inactive students
        if (student.status !== 'active') {
          return null;
        }
        // Check if fee already exists for this student and month
        const existingFeesQuery = query(
          collection(db, 'fees'),
          where('tenantId', '==', tenantId),
          where('studentId', '==', studentId),
          where('dueDate', '>=', `${currentMonth}-01`),
          where('dueDate', '<=', `${currentMonth}-31`)
        );
        const existingFeesSnapshot = await getDocs(existingFeesQuery);
        if (!existingFeesSnapshot.empty) {
          return null;
        }
        // Calculate due date using student's preferred due date
        const dueDay = student.feeDueDate || 1; // Default to 1st if not set
        const year = parseInt(currentMonth.split('-')[0]);
        const month = parseInt(currentMonth.split('-')[1]);
        // Ensure due day is valid for the month
        const maxDaysInMonth = new Date(year, month, 0).getDate();
        const validDueDay = Math.min(dueDay, maxDaysInMonth);
        const dueDate = `${year}-${month.toString().padStart(2, '0')}-${validDueDay.toString().padStart(2, '0')}`;
        const docRef = await addDoc(collection(db, 'fees'), {
          tenantId,
          studentId: studentId,
          studentName: student.name || 'Unknown',
          amount: student.monthlyFee || student.totalFees || 1000,
          dueDate: dueDate,
          status: 'pending',
          type: 'tuition',
          description: `Monthly tuition fee for ${currentMonth}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: 'automatic', // System-generated fee
        });
        void logFeeAudit(tenantId, 'fee_record_created', {
          targetId: docRef.id,
          metadata: {
            studentId,
            amount: student.monthlyFee || student.totalFees || 1000,
            dueDate,
            reason: 'automatic_monthly_generation',
          },
        });
        return docRef;
      });
      const validPromises = promises.filter((p: any) => p !== null);
      await Promise.all(validPromises);
    } catch (err) {
      logger.error('Failed to generate monthly fees:', err);
      throw err;
    }
  };

  return {
    fees,
    loading,
    error,
    addFeeRecord,
    updateFeeRecord,
    markAsPaid,
    deleteFeeRecord,
    deletePaymentRecord,
    generateMonthlyFees,
  };
}

export default useFees;
