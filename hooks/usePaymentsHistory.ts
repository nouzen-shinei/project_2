import { useCallback, useRef, useState } from 'react';
import {
  collection,
  collectionGroup,
  documentId,
  getDocs,
  getFirestore,
  query,
  where,
  orderBy,
  limit as fsLimit,
  startAfter,
  QueryConstraint,
  DocumentSnapshot,
  updateDoc,
} from 'firebase/firestore';
import { logger } from '@/lib/logger';
import { useAuth } from './useAuthUnified';

export type PaymentItem = {
  id: string;
  feeId: string;
  studentId: string;
  studentName: string;
  amount: number;
  method?: string;
  paymentDate?: string;
  monthsPaid?: string[];
  type: 'general' | 'individual';
  transactionId?: string;
  notes?: string;
  paidBy?: string;
  accountDetails?: string;
};

export type PaymentsQuery = {
  tenantId: string; // required tenant context
  pageSize?: number;
  studentId?: string; // filter by student if provided
  fromISO?: string; // ISO string inclusive lower bound
  toISO?: string;   // ISO string inclusive upper bound
  methodNormalized?: string; // normalized method (e.g., 'debitcard')
};

// Note: Legacy fees-to-payments fallback removed; dedicated payments collection group is the sole source.

const KNOWN_METHOD_TOKENS = [
  'cash',
  'upi',
  'gpay',
  'googlepay',
  'phonepe',
  'paytm',
  'netbanking',
  'banktransfer',
  'neft',
  'rtgs',
  'imps',
  'creditcard',
  'debitcard',
  'cheque',
  'wallet',
  'paypal',
];

const FALLBACK_BATCH_SIZE = 500;
const FALLBACK_FEE_LOOKUP_BATCH = 10;

function normalizeMethodToken(value?: unknown): string {
  if (value == null) return 'unknown';
  const token = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  return token.length > 0 ? token : 'unknown';
}

export function usePaymentsHistory() {
  const { user, isAuthenticated, isInitialized } = useAuth();

  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [totalAmount, setTotalAmount] = useState<number | null>(null);
  const [methodBreakdown, setMethodBreakdown] = useState<Array<{ key: string; count: number; amount: number }>>([]);

  const lastDocRef = useRef<DocumentSnapshot | null>(null);
  const currentQueryRef = useRef<PaymentsQuery | null>(null);

  const fetchFeeTenantMap = useCallback(async (db: ReturnType<typeof getFirestore>, feeIds: string[]) => {
    const uniqueFeeIds = Array.from(new Set(feeIds.filter((id) => typeof id === 'string' && id.length > 0)));
    const result = new Map<string, string>();

    for (let index = 0; index < uniqueFeeIds.length; index += FALLBACK_FEE_LOOKUP_BATCH) {
      const chunk = uniqueFeeIds.slice(index, index + FALLBACK_FEE_LOOKUP_BATCH);
      try {
        const feesSnap = await getDocs(query(collection(db, 'fees'), where(documentId(), 'in', chunk)));
        feesSnap.forEach((docSnap) => {
          const data: any = docSnap.data();
          if (data?.tenantId && typeof data.tenantId === 'string') {
            result.set(docSnap.id, data.tenantId);
          }
        });
      } catch (err) {
        logger.warn('usePaymentsHistory fee lookup failed', { err });
      }
    }

    return result;
  }, []);

  const normalizePaymentDoc = useCallback((docSnap: any) => {
    const data = docSnap.data();
    const inferredFeeId = docSnap?.ref?.parent?.parent?.id;
    const feeId = data?.feeId || inferredFeeId;
    return {
      id: docSnap.id,
      data,
      feeId,
      snap: docSnap as DocumentSnapshot,
    } as { id: string; data: any; feeId?: string; snap: DocumentSnapshot };
  }, []);

  const loadHistory = useCallback(async (opts?: PaymentsQuery) => {
    if (!isInitialized || !isAuthenticated || !user) {
      return;
    }

    const tenantId = opts?.tenantId;
    if (!tenantId) {
      setPayments([]);
      setHasMore(false);
      setTotalCount(null);
      setTotalAmount(null);
      setMethodBreakdown([]);
      setError('Select a coaching center to view payments');
      return;
    }

    setLoading(true);
    setError(null);
  setPayments([]);
  setHasMore(true);
  setTotalCount(null);
  setTotalAmount(null);
  setMethodBreakdown([]);
  lastDocRef.current = null;

    // Save effective query
    const effective: PaymentsQuery = {
      tenantId,
      pageSize: opts?.pageSize ?? 30,
      studentId: opts?.studentId,
      fromISO: opts?.fromISO,
      toISO: opts?.toISO,
      methodNormalized: opts?.methodNormalized,
    };
    currentQueryRef.current = effective;

    try {
      const db = getFirestore();
      // Always query dedicated payments collection group for precise paymentDate bounds
      const paymentsRef = collectionGroup(db, 'payments');
      // Build shared filter constraints (for both list and aggregate)
      const whereConstraints: QueryConstraint[] = [];
      if (effective.studentId && effective.studentId !== 'all') {
        whereConstraints.push(where('studentId', '==', effective.studentId));
      }
      if (effective.fromISO) whereConstraints.push(where('paymentDate', '>=', effective.fromISO));
      if (effective.toISO) whereConstraints.push(where('paymentDate', '<=', effective.toISO));
      if (effective.methodNormalized && effective.methodNormalized !== 'all') whereConstraints.push(where('methodNormalized', '==', effective.methodNormalized));

      // Tenant-scoped listing: Firestore can't reliably filter by tenantId until all payment docs are tagged.
      // We scan recent payments and filter client-side using tenantId (or infer from parent fee).
      const requestedPageSize = effective.pageSize!;
      const scanBatchSize = Math.max(requestedPageSize * 4, 80);

      const results: PaymentItem[] = [];
      let cursor: DocumentSnapshot | null = null;
      let reachedEnd = false;

      while (results.length < requestedPageSize && !reachedEnd) {
        const constraints: QueryConstraint[] = [orderBy('paymentDate', 'desc')];
        constraints.push(...whereConstraints);
        if (cursor) constraints.push(startAfter(cursor));
        constraints.push(fsLimit(scanBatchSize));

        const snap = await getDocs(query(paymentsRef, ...constraints));
        if (snap.empty) {
          reachedEnd = true;
          break;
        }

        const normalizedDocs = snap.docs.map(normalizePaymentDoc);
        const feeIdsToLookup = normalizedDocs
          .filter((d) => !d.data?.tenantId)
          .map((d) => d.feeId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0);

        const feeTenantMap = feeIdsToLookup.length ? await fetchFeeTenantMap(db, feeIdsToLookup) : new Map<string, string>();

        let lastProcessed: DocumentSnapshot | null = null;
        for (const doc of normalizedDocs) {
          lastProcessed = doc.snap;

          const data = doc.data;
          const paymentTenantIdRaw = data?.tenantId;
          const inferredTenantId = !paymentTenantIdRaw && doc.feeId ? feeTenantMap.get(doc.feeId) : undefined;
          const paymentTenantId = typeof paymentTenantIdRaw === 'string' ? paymentTenantIdRaw : inferredTenantId;

          if (paymentTenantId && paymentTenantId !== effective.tenantId) {
            continue;
          }
          if (!paymentTenantId) {
            // If we cannot resolve tenantId, skip to avoid leaking cross-tenant data.
            continue;
          }

          if (!paymentTenantIdRaw && inferredTenantId) {
            // Best-effort backfill so future queries can use tenantId.
            try {
              await updateDoc(doc.snap.ref, { tenantId: inferredTenantId });
            } catch (err) {
              // ignore (rules may block or offline)
            }
          }

          results.push({ id: doc.id, ...data, feeId: data?.feeId || doc.feeId } as any);
          if (results.length >= requestedPageSize) {
            break;
          }
        }

        cursor = lastProcessed ?? snap.docs[snap.docs.length - 1] ?? null;
        lastDocRef.current = cursor;

        if (snap.size < scanBatchSize) {
          reachedEnd = true;
        }
      }

      setPayments(results);
      setHasMore(!reachedEnd);

      // Totals are intentionally left null until payment docs are fully tagged with tenantId
      // to avoid expensive full scans and cross-tenant leakage.
      const methodBuckets = new Map<string, { count: number; amount: number }>();
      results.forEach((p: any) => {
        const amountNum = typeof p.amount === 'number' ? p.amount : Number(p.amount) || 0;
        const methodToken = normalizeMethodToken(p.methodNormalized ?? p.method);
        const bucket = methodBuckets.get(methodToken) ?? { count: 0, amount: 0 };
        bucket.count += 1;
        bucket.amount += amountNum;
        methodBuckets.set(methodToken, bucket);
      });
      const orderedBreakdown: Array<{ key: string; count: number; amount: number }> = [];
      for (const token of KNOWN_METHOD_TOKENS) {
        const bucket = methodBuckets.get(token);
        if (bucket) {
          orderedBreakdown.push({ key: token, count: bucket.count, amount: bucket.amount });
          methodBuckets.delete(token);
        }
      }
      const extraBuckets = Array.from(methodBuckets.entries())
        .map(([key, bucket]) => ({ key, count: bucket.count, amount: bucket.amount }))
        .sort((a, b) => b.amount - a.amount);
      setMethodBreakdown([...orderedBreakdown, ...extraBuckets]);
    } catch (err: any) {
      logger.error('usePaymentsHistory loadHistory error', err);
      setError(err?.message || 'Failed to load payments history');
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  }, [isInitialized, isAuthenticated, user]);

  const loadMore = useCallback(async () => {
    if (!isInitialized || !isAuthenticated || !user) return;
    if (!hasMore) return;
    if (!lastDocRef.current) return;

    const effective = currentQueryRef.current;
    if (!effective?.tenantId) return;

    setLoadingMore(true);
    try {
      const db = getFirestore();
      const paymentsRef = collectionGroup(db, 'payments');
      const whereConstraints: QueryConstraint[] = [];
      if (effective.studentId && effective.studentId !== 'all') whereConstraints.push(where('studentId', '==', effective.studentId));
      if (effective.fromISO) whereConstraints.push(where('paymentDate', '>=', effective.fromISO));
      if (effective.toISO) whereConstraints.push(where('paymentDate', '<=', effective.toISO));
      if (effective.methodNormalized && effective.methodNormalized !== 'all') whereConstraints.push(where('methodNormalized', '==', effective.methodNormalized));

      const requestedPageSize = effective.pageSize || 30;
      const scanBatchSize = Math.max(requestedPageSize * 4, 80);
      const appended: PaymentItem[] = [];

      let cursor: DocumentSnapshot | null = lastDocRef.current;
      let reachedEnd = false;

      while (appended.length < requestedPageSize && !reachedEnd) {
        const constraints: QueryConstraint[] = [orderBy('paymentDate', 'desc')];
        constraints.push(...whereConstraints);
        if (cursor) constraints.push(startAfter(cursor));
        constraints.push(fsLimit(scanBatchSize));

        const snap = await getDocs(query(paymentsRef, ...constraints));
        if (snap.empty) {
          reachedEnd = true;
          break;
        }

        const normalizedDocs = snap.docs.map(normalizePaymentDoc);
        const feeIdsToLookup = normalizedDocs
          .filter((d) => !d.data?.tenantId)
          .map((d) => d.feeId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0);

        const feeTenantMap = feeIdsToLookup.length ? await fetchFeeTenantMap(db, feeIdsToLookup) : new Map<string, string>();

        let lastProcessed: DocumentSnapshot | null = null;
        for (const doc of normalizedDocs) {
          lastProcessed = doc.snap;

          const data = doc.data;
          const paymentTenantIdRaw = data?.tenantId;
          const inferredTenantId = !paymentTenantIdRaw && doc.feeId ? feeTenantMap.get(doc.feeId) : undefined;
          const paymentTenantId = typeof paymentTenantIdRaw === 'string' ? paymentTenantIdRaw : inferredTenantId;

          if (paymentTenantId && paymentTenantId !== effective.tenantId) {
            continue;
          }
          if (!paymentTenantId) {
            continue;
          }

          if (!paymentTenantIdRaw && inferredTenantId) {
            try {
              await updateDoc(doc.snap.ref, { tenantId: inferredTenantId });
            } catch {
              // ignore
            }
          }

          appended.push({ id: doc.id, ...data, feeId: data?.feeId || doc.feeId } as any);
          if (appended.length >= requestedPageSize) {
            break;
          }
        }

        cursor = lastProcessed ?? snap.docs[snap.docs.length - 1] ?? null;
        lastDocRef.current = cursor;

        if (snap.size < scanBatchSize) {
          reachedEnd = true;
        }
      }

      setPayments((prev) => [...prev, ...appended]);
      setHasMore(!reachedEnd);
    } catch (err: any) {
      logger.error('usePaymentsHistory loadMore error', err);
      setError(err?.message || 'Failed to load more payments');
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [isInitialized, isAuthenticated, user, hasMore]);

  const refresh = useCallback(async () => {
    // re-run with current query
    if (!currentQueryRef.current) return;
    await loadHistory(currentQueryRef.current);
  }, [loadHistory]);

  return {
    payments,
    loading,
    loadingMore,
    hasMore,
    error,
    totalCount,
    totalAmount,
    methodBreakdown,
    loadHistory,
    loadMore,
    refresh,
  };
}

export default usePaymentsHistory;
