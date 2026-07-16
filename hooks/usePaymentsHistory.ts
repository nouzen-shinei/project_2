import { useCallback, useRef, useState } from 'react';
import {
  collectionGroup,
  getDocs,
  getFirestore,
  query,
  where,
  orderBy,
  limit as fsLimit,
  startAfter,
  QueryConstraint,
  DocumentSnapshot,
  QueryDocumentSnapshot,
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

function normalizeMethodToken(value?: unknown): string {
  if (value == null) return 'unknown';
  const token = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  return token.length > 0 ? token : 'unknown';
}

// Security-rules-hardening (Phase 3.5): payments are read ONLY within the caller's
// tenant. The dedicated `payments` collection-group docs are written with a
// `tenantId` field (see fees.tsx), so the query is constrained by
// `where('tenantId','==',tenantId)` and the Firestore rule authorises reads by an
// active member of that tenant. This replaces the previous cross-tenant scan that
// fetched other tenants' payment/fee docs to the client and filtered locally.
function buildPaymentConstraints(effective: PaymentsQuery): QueryConstraint[] {
  const constraints: QueryConstraint[] = [where('tenantId', '==', effective.tenantId)];
  if (effective.studentId && effective.studentId !== 'all') {
    constraints.push(where('studentId', '==', effective.studentId));
  }
  if (effective.fromISO) constraints.push(where('paymentDate', '>=', effective.fromISO));
  if (effective.toISO) constraints.push(where('paymentDate', '<=', effective.toISO));
  if (effective.methodNormalized && effective.methodNormalized !== 'all') {
    constraints.push(where('methodNormalized', '==', effective.methodNormalized));
  }
  constraints.push(orderBy('paymentDate', 'desc'));
  return constraints;
}

function toPaymentItem(docSnap: QueryDocumentSnapshot): PaymentItem {
  const data: any = docSnap.data() || {};
  const feeId = data?.feeId || docSnap.ref.parent.parent?.id;
  return { id: docSnap.id, ...data, feeId } as PaymentItem;
}

function computeMethodBreakdown(items: PaymentItem[]): Array<{ key: string; count: number; amount: number }> {
  const methodBuckets = new Map<string, { count: number; amount: number }>();
  items.forEach((p: any) => {
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
  return [...orderedBreakdown, ...extraBuckets];
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
      const paymentsRef = collectionGroup(db, 'payments');
      const pageSize = effective.pageSize!;
      // Fetch one extra doc to detect whether more pages exist.
      const snap = await getDocs(query(paymentsRef, ...buildPaymentConstraints(effective), fsLimit(pageSize + 1)));

      const moreAvailable = snap.docs.length > pageSize;
      const pageDocs = moreAvailable ? snap.docs.slice(0, pageSize) : snap.docs;
      const results = pageDocs.map(toPaymentItem);

      lastDocRef.current = pageDocs.length ? pageDocs[pageDocs.length - 1] : null;
      setPayments(results);
      setHasMore(moreAvailable);
      // Totals stay null (breakdown reflects the loaded page only) to avoid full-scan cost.
      setMethodBreakdown(computeMethodBreakdown(results));
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
      const pageSize = effective.pageSize || 30;
      const snap = await getDocs(
        query(paymentsRef, ...buildPaymentConstraints(effective), startAfter(lastDocRef.current), fsLimit(pageSize + 1)),
      );

      const moreAvailable = snap.docs.length > pageSize;
      const pageDocs = moreAvailable ? snap.docs.slice(0, pageSize) : snap.docs;
      const appended = pageDocs.map(toPaymentItem);

      if (pageDocs.length) {
        lastDocRef.current = pageDocs[pageDocs.length - 1];
      }
      setPayments((prev) => [...prev, ...appended]);
      setHasMore(moreAvailable);
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
