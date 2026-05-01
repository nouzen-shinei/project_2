import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, TextInput, ActivityIndicator, StyleSheet, Modal, Pressable, type FlatListProps } from 'react-native';
import { ScrollView as GHScrollView, FlatList as GHFlatList } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Filter as FilterIcon, SortAsc, SortDesc, Search as SearchIcon, User, CreditCard, Calendar, X, RefreshCcw } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import useStudentsHook from '../hooks/useStudents';
import { usePaymentsHistory } from '../hooks/usePaymentsHistory';
import { useTenant } from '@/hooks/useTenantContext';
import { useTenantUsageSummary } from '@/hooks/useTenantUsageSummary';
import { usageAnalyticsService } from '@/services/usageAnalyticsService';
import DatePicker from './DatePicker';

type SortKey = 'date' | 'amount' | 'student';
type SortDir = 'asc' | 'desc';

type PaymentItem = {
  id: string; // paymentId (e.g., payment_... or legacy)
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

type FeeHistoryListItem =
  | { kind: 'stats' }
  | { kind: 'controls' }
  | { kind: 'empty' }
  | { kind: 'payment'; payment: PaymentItem };

type TimePresetOption = {
  id: 'all' | '7d' | '30d' | '90d' | 'month' | 'custom';
  label: string;
};

type StudentFilterOption = {
  id: string;
  name: string;
};

const TypedGHFlatList = GHFlatList as unknown as <ItemT>(props: FlatListProps<ItemT>) => React.ReactElement;

// Humanize payment method identifiers for display
function humanizeMethod(method?: string): string {
  if (!method) return '—';
  const norm = String(method).toLowerCase().replace(/[^a-z0-9]/g, '');
  const map: Record<string, string> = {
    upi: 'UPI',
    gpay: 'Google Pay',
    googlepay: 'Google Pay',
    phonepe: 'PhonePe',
    paytm: 'Paytm',
    paypal: 'PayPal',
    neft: 'NEFT',
    rtgs: 'RTGS',
    imps: 'IMPS',
    netbanking: 'Net Banking',
    creditcard: 'Credit Card',
    debitcard: 'Debit Card',
    banktransfer: 'Bank Transfer',
    cheque: 'Cheque',
    cash: 'Cash',
    wallet: 'Wallet',
  };
  if (map[norm]) return map[norm];
  // Fallback: replace separators with spaces and Title Case
  const words = String(method).replace(/[_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function getPaymentStableKey(item: PaymentItem): string {
  return [
    item.feeId,
    item.id,
    item.studentId,
    item.paymentDate,
    String(item.amount ?? 0),
    item.method,
    item.transactionId,
  ]
    .map((part) => String(part || ''))
    .join('|');
}

export default function FeeHistory({ onClose }: { onClose?: () => void }) {
  const router = useRouter();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const { activeTenant, activeMembership } = useTenant();
  const { students: studentList } = useStudentsHook();
  const { payments, loading, loadingMore: backendLoadingMore, hasMore, loadHistory, loadMore, refresh, totalAmount: aggTotalAmount, totalCount: aggTotalCount, methodBreakdown } = usePaymentsHistory();
  const [refreshing, setRefreshing] = useState(false);
  const refreshRequestInFlightRef = useRef(false);
  const loadMoreInFlightRef = useRef(false);

  const onRefresh = useCallback(async () => {
    if (refreshRequestInFlightRef.current) {
      return;
    }

    refreshRequestInFlightRef.current = true;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
      refreshRequestInFlightRef.current = false;
    }
  }, [refresh]);

  const [query, setQuery] = useState('');
  const handleQueryChange = useCallback((value: string) => {
    setQuery((current) => (current === value ? current : value));
  }, []);
  const clearQuery = useCallback(() => {
    setQuery((current) => (current.length > 0 ? '' : current));
  }, []);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterMethod, setFilterMethod] = useState<string>('all');
  const [filterStudentId, setFilterStudentId] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const currentMonthId = useMemo(() => new Date().toISOString().slice(0, 7), []);
  const [selectedMonthId, setSelectedMonthId] = useState<string>(currentMonthId);
  const [timePreset, setTimePreset] = useState<'all' | '7d' | '30d' | '90d' | 'month' | 'custom'>('month');
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showMethodPicker, setShowMethodPicker] = useState(false);
  const [showStudentPicker, setShowStudentPicker] = useState(false);

  // Month list for the "By Month" picker: generated locally (no Firestore reads).
  // We page it to feel effectively infinite without rendering a huge list at once.
  const [monthListCount, setMonthListCount] = useState<number>(60);

  const monthIdFromOffset = useCallback((offset: number) => {
    const now = new Date();
    const baseYear = now.getFullYear();
    const baseMonth = now.getMonth() + 1; // 1..12
    const total = baseYear * 12 + (baseMonth - 1) - offset;
    const yyyy = Math.floor(total / 12);
    const mm = (total % 12) + 1;
    return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}`;
  }, []);

  const maxMonthOptions = useMemo(() => {
    const now = new Date();
    const baseTotal = now.getFullYear() * 12 + now.getMonth();
    const minTotal = 1970 * 12 + 0; // 1970-01
    return Math.max(1, baseTotal - minTotal + 1);
  }, []);

  const monthOptions = useMemo(() => {
    const count = Math.max(1, Math.min(monthListCount, maxMonthOptions));
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) out.push(monthIdFromOffset(i));
    return out;
  }, [monthListCount, monthIdFromOffset, maxMonthOptions]);

  const timePresetOptions = useMemo<TimePresetOption[]>(() => ([
    { id: 'month', label: 'By Month' },
    { id: 'all', label: 'All time' },
    { id: '7d', label: 'Last 7 days' },
    { id: '30d', label: 'Last 30 days' },
    { id: '90d', label: 'Last 90 days' },
    { id: 'custom', label: 'Custom' },
  ]), []);

  const deriveMonthId = useCallback((dateString: string) => {
    const t = Date.parse(dateString);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 7);
  }, []);

  const monthLabel = useCallback((monthId: string) => {
    const m = /^\d{4}-\d{2}$/.test(monthId) ? monthId : currentMonthId;
    const [yyyy, mm] = m.split('-').map((v) => Number(v));
    if (!yyyy || !mm) return m;
    const d = new Date(yyyy, mm - 1, 1);
    return d.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
  }, [currentMonthId]);

  const isDefaultTimeSelection =
    timePreset === 'month' &&
    selectedMonthId === currentMonthId &&
    !dateFrom &&
    !dateTo;

  const isFullSingleMonthRange = useMemo(() => {
    if (timePreset === 'month') {
      const monthId = /^\d{4}-\d{2}$/.test(selectedMonthId) ? selectedMonthId : currentMonthId;
      return { ok: true as const, monthId };
    }
    if (timePreset !== 'custom') return { ok: false as const, monthId: null as string | null };
    if (!dateFrom || !dateTo) return { ok: false as const, monthId: null as string | null };
    const fromIso = new Date(`${dateFrom}T00:00:00.000`).toISOString();
    const toIso = new Date(`${dateTo}T23:59:59.999`).toISOString();

    const fromMonthId = deriveMonthId(fromIso);
    const toMonthId = deriveMonthId(toIso);
    if (!fromMonthId || !toMonthId || fromMonthId !== toMonthId) {
      return { ok: false as const, monthId: null as string | null };
    }

    const [yyyy, mm] = fromMonthId.split('-').map((v) => Number(v));
    if (!yyyy || !mm) return { ok: false as const, monthId: null as string | null };
    const lastDay = new Date(yyyy, mm, 0).getDate();
    const isFirstDay = dateFrom.endsWith('-01');
    const isLastDay = dateTo.endsWith(`-${String(lastDay).padStart(2, '0')}`);
    if (!isFirstDay || !isLastDay) {
      return { ok: false as const, monthId: null as string | null };
    }

    return { ok: true as const, monthId: fromMonthId };
  }, [timePreset, selectedMonthId, dateFrom, dateTo, deriveMonthId, currentMonthId]);

  const usageMonthId = isFullSingleMonthRange.ok ? isFullSingleMonthRange.monthId : null;
  const { usageSummary, refresh: refreshUsageSummary } = useTenantUsageSummary(activeTenant?.id ?? null, usageMonthId);

  const canRequestUsageRefresh =
    activeMembership?.role === 'owner' || activeMembership?.role === 'admin';

  const onRefreshWithUsage = useCallback(async () => {
    if (refreshRequestInFlightRef.current) {
      return;
    }

    refreshRequestInFlightRef.current = true;
    setRefreshing(true);
    try {
      const tasks: Promise<unknown>[] = [refresh()];
      // If the selected time range is a full single month, ask backend to regenerate the usage snapshot
      // so monthly rollups (like paymentsReceived) stay accurate.
      if (activeTenant?.id && usageMonthId && canRequestUsageRefresh) {
        tasks.push(usageAnalyticsService.requestUsageRefresh(activeTenant.id, { month: usageMonthId }).catch(() => undefined));
      }
      tasks.push(refreshUsageSummary().catch(() => undefined));
      await Promise.all(tasks);
    } finally {
      setRefreshing(false);
      refreshRequestInFlightRef.current = false;
    }
  }, [refresh, refreshUsageSummary, activeTenant?.id, usageMonthId, canRequestUsageRefresh]);
  // Client-side pagination for performance
  const PAGE_SIZE = 30;
  const [visibleCount, setVisibleCount] = useState<number>(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // Backend-paginated payments
  const allPayments: PaymentItem[] = payments as any;

  const paymentDerivedList = useMemo(() => {
    return allPayments.map((payment) => {
      const amount = payment.amount ?? 0;
      const amountStr = String(amount);
      const amountLocale = amount.toLocaleString('en-IN');
      const methodPretty = humanizeMethod(payment.method);

      return {
        payment,
        searchText: `${payment.studentName} ${payment.method ?? ''} ${methodPretty} ${payment.accountDetails ?? ''} ${payment.transactionId ?? ''} ${payment.notes ?? ''} ${payment.paidBy ?? ''} ${amountStr} ${amountLocale}`.toLowerCase(),
        amountDigits: amountStr.replace(/[^0-9.]/g, ''),
        amountLocaleDigits: amountLocale.replace(/[^0-9.]/g, ''),
        paymentTime: new Date(payment.paymentDate || 0).getTime(),
        normalizedMethod: (payment.method || '').toLowerCase(),
        sortStudentName: payment.studentName || '',
      };
    });
  }, [allPayments]);

  // Compute backend query bounds from timePreset/custom (always applied to paymentDate in backend)
  const computedBounds = useMemo(() => {
    let fromISO: string | undefined;
    let toISO: string | undefined;
    if (timePreset === 'month') {
      const monthId = /^\d{4}-\d{2}$/.test(selectedMonthId) ? selectedMonthId : currentMonthId;
      const [yyyy, mm] = monthId.split('-').map((v) => Number(v));
      const lastDay = new Date(yyyy, mm, 0).getDate();
      // Use UTC boundaries so Firestore range filters align with ISO timestamps.
      const startDate = new Date(Date.UTC(yyyy, mm - 1, 1, 0, 0, 0, 0));
      const endDate = new Date(Date.UTC(yyyy, mm - 1, lastDay, 23, 59, 59, 999));
      fromISO = startDate.toISOString();
      toISO = endDate.toISOString();
    } else if (timePreset !== 'all' && timePreset !== 'custom') {
      const days = timePreset === '7d' ? 7 : timePreset === '30d' ? 30 : 90;
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
      fromISO = startDate.toISOString();
      toISO = end.toISOString();
    } else if (timePreset === 'custom') {
      fromISO = dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : undefined;
      toISO = dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : undefined;
    }
    return { fromISO, toISO };
  }, [timePreset, selectedMonthId, dateFrom, dateTo, currentMonthId]);

  // Load backend history when filters change (student/time)
  useEffect(() => {
    const methodNormalized = filterMethod !== 'all' ? String(filterMethod).toLowerCase().replace(/[^a-z0-9]/g, '') : undefined;
    if (!activeTenant?.id) return;
    loadHistory({
      pageSize: 50,
      tenantId: activeTenant.id,
      studentId: filterStudentId !== 'all' ? filterStudentId : undefined,
      fromISO: computedBounds.fromISO,
      toISO: computedBounds.toISO,
      methodNormalized,
    });
  }, [filterStudentId, computedBounds.fromISO, computedBounds.toISO, filterMethod, activeTenant?.id]);

  // Build filters
  const availableMethods = useMemo<string[]>(() => {
    const set = new Set<string>();
    allPayments.forEach(p => { if (p.method) set.add(String(p.method)); });
    return ['all', ...Array.from(set.values()).sort()];
  }, [allPayments]);

  const availableStudents = useMemo<StudentFilterOption[]>(() => {
    const base = (studentList || []).map((s: any) => ({ id: s.id || s.studentId, name: s.name || s.studentName || s.id }));
    const unique = new Map<string, string>();
    base.forEach(s => { if (s.id) unique.set(s.id, s.name || s.id); });
    return [{ id: 'all', name: 'All students' }, ...Array.from(unique, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))];
  }, [studentList]);

  const filteredAndSorted = useMemo(() => {
    let list = paymentDerivedList;

    // Text search
    if (debouncedQuery) {
      const q = debouncedQuery;
      const numQ = q.replace(/[^0-9.]/g, '');
      list = list.filter((entry) => {
        if (entry.searchText.includes(q)) return true;
        if (numQ) {
          if (entry.amountDigits.includes(numQ) || entry.amountLocaleDigits.includes(numQ)) return true;
        }
        return false;
      });
    }

    // Method filter
    if (filterMethod !== 'all') {
      const normalizedFilterMethod = filterMethod.toLowerCase();
      list = list.filter((entry) => entry.normalizedMethod === normalizedFilterMethod);
    }

    // Student filter
    if (filterStudentId !== 'all') {
      list = list.filter((entry) => entry.payment.studentId === filterStudentId);
    }

    // Date range filter (inclusive) from preset or custom
    let fromTs: number | undefined;
    let toTs: number | undefined;
    if (timePreset === 'month') {
      const monthId = /^\d{4}-\d{2}$/.test(selectedMonthId) ? selectedMonthId : currentMonthId;
      const [yyyy, mm] = monthId.split('-').map((v) => Number(v));
      const lastDay = new Date(yyyy, mm, 0).getDate();
      const startDate = new Date(yyyy, mm - 1, 1, 0, 0, 0, 0);
      const end = new Date(yyyy, mm - 1, lastDay, 23, 59, 59, 999);
      fromTs = startDate.getTime();
      toTs = end.getTime();
    } else if (timePreset !== 'all' && timePreset !== 'custom') {
      const days = timePreset === '7d' ? 7 : timePreset === '30d' ? 30 : 90;
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
      const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1), 0, 0, 0, 0);
      fromTs = startDate.getTime();
      toTs = end;
    } else if (timePreset === 'custom') {
      // Normalize to start/end of day to ensure inclusive filtering across timezones
      fromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : undefined;
      toTs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : undefined;
    }

    if (fromTs !== undefined || toTs !== undefined) {
      list = list.filter((entry) => {
        const t = entry.paymentTime;
        if (Number.isNaN(t)) return false;
        if (fromTs !== undefined && t < fromTs) return false;
        if (toTs !== undefined && t > toTs) return false;
        return true;
      });
    }

    // Sort
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'date') {
        cmp = a.paymentTime - b.paymentTime;
      } else if (sortKey === 'amount') {
        cmp = (a.payment.amount || 0) - (b.payment.amount || 0);
      } else {
        cmp = a.sortStudentName.localeCompare(b.sortStudentName);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return sorted.map((entry) => entry.payment);
  }, [paymentDerivedList, debouncedQuery, filterMethod, filterStudentId, dateFrom, dateTo, timePreset, sortKey, sortDir, selectedMonthId, currentMonthId]);

  const pageTotalAmount = useMemo(() => filteredAndSorted.reduce((s, p) => s + (p.amount || 0), 0), [filteredAndSorted]);

  const rollupPaymentsReceived = usageSummary?.paymentsReceived;
  const canUsePaymentsRollup =
    Boolean(rollupPaymentsReceived) &&
    isFullSingleMonthRange.ok &&
    filterMethod === 'all' &&
    filterStudentId === 'all';

  const displayedTotalCount = canUsePaymentsRollup
    ? rollupPaymentsReceived?.count ?? null
    : (aggTotalCount ?? null);
  const displayedTotalAmount = canUsePaymentsRollup
    ? rollupPaymentsReceived?.amount ?? null
    : (aggTotalAmount ?? null);

  // In some environments the rollup/aggregate can lag behind the actual fetched list.
  // If the aggregate reports 0 while we clearly have payments on screen, fall back
  // to the current filtered list totals to avoid confusing UI.
  const isAggregateCountReliable =
    displayedTotalCount != null && !(displayedTotalCount === 0 && filteredAndSorted.length > 0);
  const isAggregateAmountReliable =
    displayedTotalAmount != null && !(displayedTotalAmount === 0 && pageTotalAmount > 0);

  const statsCount = isAggregateCountReliable ? (displayedTotalCount as number) : filteredAndSorted.length;
  const statsAmount = isAggregateAmountReliable ? (displayedTotalAmount as number) : pageTotalAmount;

  const statsLabel =
    isAggregateCountReliable && isAggregateAmountReliable
      ? (canUsePaymentsRollup ? ' (month)' : '')
      : ' (page)';

  // Reset pagination whenever the filtered list changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filteredAndSorted.length]);

  const displayedList = useMemo(() => filteredAndSorted.slice(0, visibleCount), [filteredAndSorted, visibleCount]);

  const handleLoadMore = useCallback(() => {
    if (loadMoreInFlightRef.current) return;

    // First, try backend pagination if there is more to fetch
    if (hasMore && !backendLoadingMore) {
      loadMoreInFlightRef.current = true;
      Promise.resolve(loadMore()).finally(() => {
        loadMoreInFlightRef.current = false;
      });
      return;
    }

    // Otherwise, extend client window if needed
    if (loadingMore) return;
    if (visibleCount >= filteredAndSorted.length) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setTimeout(() => {
      setVisibleCount(v => Math.min(v + PAGE_SIZE, filteredAndSorted.length));
      setLoadingMore(false);
      loadMoreInFlightRef.current = false;
    }, 120);
  }, [hasMore, backendLoadingMore, loadMore, loadingMore, visibleCount, filteredAndSorted.length]);


  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const formatDate = useCallback((value?: string) => {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-IN', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
  }, []);

  const renderItem = useCallback(({ item }: { item: PaymentItem }) => (
    <View style={[styles.row, { borderColor: theme.border, backgroundColor: theme.card }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: theme.text }]}>
          ₹{(item.amount || 0).toLocaleString('en-IN')} • <Text style={{ color: theme.textSecondary }}>{humanizeMethod(item.method)}</Text>
        </Text>
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
          {item.studentName} {item.type === 'individual' && item.monthsPaid?.length ? `• ${item.monthsPaid.join(', ')}` : ''}
        </Text>
        <Text style={[styles.meta, { color: theme.textSecondary }]}> 
          {formatDate(item.paymentDate)}
          {item.accountDetails ? ` • Account: ${item.accountDetails}` : ''}
          {item.transactionId ? ` • Txn: ${item.transactionId}` : ''}
          {item.paidBy ? ` • By: ${item.paidBy}` : ''}
        </Text>
        {!!item.notes && (
          <Text style={[styles.notes, { color: theme.textSecondary }]} numberOfLines={2}>
            {item.notes}
          </Text>
        )}
      </View>
    </View>
  ), [theme, formatDate]);

  const keyExtractor = useCallback((item: PaymentItem) => getPaymentStableKey(item),[]);

  const renderFooter = useCallback(() => {
    if (backendLoadingMore || loadingMore) {
      return (
        <View style={styles.loadMoreContainer}>
          <ActivityIndicator size="small" color={theme.primary} />
          <Text style={[styles.loadingMoreText, { color: theme.textSecondary }]}>Loading more payments…</Text>
        </View>
      );
    }
    if (hasMore || visibleCount < filteredAndSorted.length) {
      return (
        <View style={styles.loadMoreContainer}>
          <TouchableOpacity
            style={[styles.loadMoreButton, { borderColor: theme.primary, backgroundColor: theme.background }]}
            onPress={handleLoadMore}
          >
            <Text style={[styles.loadMoreText, { color: theme.primary }]}>Load More Payments</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (filteredAndSorted.length > 0) {
      return (
        <View style={styles.loadMoreContainer}>
          <Text style={[styles.endOfListText, { color: theme.textSecondary }]}>No more payments</Text>
        </View>
      );
    }
    return null;
  }, [backendLoadingMore, loadingMore, hasMore, visibleCount, filteredAndSorted.length, theme, handleLoadMore]);

  const listData = useMemo<FeeHistoryListItem[]>(() => {
    const header: FeeHistoryListItem[] = [{ kind: 'stats' }, { kind: 'controls' }];
    if (!displayedList.length) return [...header, { kind: 'empty' }];
    return [...header, ...displayedList.map((p) => ({ kind: 'payment' as const, payment: p }))];
  }, [displayedList]);

  const listKeyExtractor = useCallback((item: FeeHistoryListItem) => {
    if (item.kind === 'stats') return 'stats';
    if (item.kind === 'controls') return 'controls';
    if (item.kind === 'empty') return 'empty';
    return keyExtractor(item.payment);
  }, [keyExtractor]);

  const renderListItem = useCallback(
    ({ item }: { item: FeeHistoryListItem }) => {
      if (item.kind === 'stats') {
        return (
          <View style={{ paddingHorizontal: 16, paddingTop: 0, paddingBottom: 2 }}>
            <View style={styles.statsRow}>
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                {statsCount} payments{statsLabel}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                Total ₹{statsAmount.toLocaleString('en-IN')}{statsLabel}
              </Text>
            </View>
            {methodBreakdown && methodBreakdown.length > 0 && (
              <View style={{ marginTop: 7, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {methodBreakdown.slice(0, 8).map((m) => (
                  <View key={m.key} style={[styles.pill, { borderColor: theme.border, backgroundColor: theme.background }]}>
                    <Text style={{ color: theme.textSecondary, fontSize: 11 }}>
                      {humanizeMethod(m.key)}: ₹{m.amount.toLocaleString('en-IN')} ({m.count})
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        );
      }

      if (item.kind === 'controls') {
        return (
          <View
            style={{
              backgroundColor: theme.background,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.border,
              paddingTop: 0,
              paddingBottom: 6,
              zIndex: 10,
              elevation: 4,
            }}
          >
            {/* Filters (scrollable) */}
            <View style={[styles.filterBar, { backgroundColor: theme.background, paddingHorizontal: 0 }]}> 
              <GHScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                directionalLockEnabled
                scrollEventThrottle={16}
                contentContainerStyle={{
                  paddingHorizontal: 16,
                  paddingVertical: 2,
                  flexGrow: 1,
                  alignItems: 'center',
                }}
              >
                {/* Results chip + Clear search */}
                {debouncedQuery.trim() && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 8 }}>
                    <View style={[styles.pill, { borderColor: theme.primary, backgroundColor: theme.background }]}>
                      <Text style={{ color: theme.primary, fontSize: 12 }}>
                        {filteredAndSorted.length} result{filteredAndSorted.length !== 1 ? 's' : ''}
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={clearQuery}
                      delayPressIn={50}
                      style={[styles.pillClear, { borderColor: theme.border, backgroundColor: theme.card, marginLeft: 6, marginRight: 8 }]}
                    >
                      <X size={12} color={theme.textSecondary} />
                    </TouchableOpacity>
                  </View>
                )}
                <View style={{ marginRight: 8 }}>
                  <FilterPill
                    label={`Method: ${filterMethod === 'all' ? 'All' : humanizeMethod(filterMethod)}`}
                    active={filterMethod !== 'all'}
                    onPress={() => setShowMethodPicker(true)}
                    onClear={() => setFilterMethod('all')}
                    theme={theme}
                  />
                </View>
                <View style={{ marginRight: 8 }}>
                  <FilterPill
                    label={`Student: ${availableStudents.find(s => s.id === filterStudentId)?.name || 'All'}`}
                    active={filterStudentId !== 'all'}
                    onPress={() => setShowStudentPicker(true)}
                    onClear={() => setFilterStudentId('all')}
                    theme={theme}
                  />
                </View>
                <View style={{ marginRight: 8 }}>
                  <FilterPill
                    label={`Time: ${timePreset === 'all' ? 'All' : timePreset === '7d' ? 'Last 7 days' : timePreset === '30d' ? 'Last 30 days' : timePreset === '90d' ? 'Last 90 days' : timePreset === 'month' ? monthLabel(selectedMonthId) : 'Custom'}`}
                    active={!isDefaultTimeSelection}
                    onPress={() => setShowTimePicker(true)}
                    onClear={
                      isDefaultTimeSelection
                        ? undefined
                        : () => {
                            setTimePreset('month');
                            setSelectedMonthId(currentMonthId);
                            setDateFrom('');
                            setDateTo('');
                          }
                    }
                    theme={theme}
                  />
                </View>
              </GHScrollView>
            </View>

            {/* Custom range row */}
            {timePreset === 'custom' && (
              <View style={{ height: 40, marginBottom: 10 }}>
                <GHScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ flexGrow: 0, flexShrink: 0 }}
                  contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 6, gap: 8, alignItems: 'center' }}
                >
                  <DatePicker
                    selectedDate={dateFrom}
                    onSelect={setDateFrom}
                    theme={theme}
                    placeholder="From"
                    allowFutureDates={false}
                    onClear={() => setDateFrom('')}
                  />
                  <DatePicker
                    selectedDate={dateTo}
                    onSelect={setDateTo}
                    theme={theme}
                    placeholder="To"
                    allowFutureDates={false}
                    onClear={() => setDateTo('')}
                  />
                </GHScrollView>
              </View>
            )}

            {/* Sort Row (scrollable) */}
            <View style={{ height: 40 }}>
              <GHScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ flexGrow: 0, flexShrink: 0 }}
                contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8, alignItems: 'center' }}
              >
                <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Sort:</Text>
                <TouchableOpacity onPress={() => toggleSort('date')} style={[styles.sortBtn, { borderColor: theme.border, backgroundColor: theme.card }]}>
                  <Calendar size={14} color={theme.textSecondary} />
                  <Text style={[styles.sortLabel, { color: theme.textSecondary }]}>Date</Text>
                  {sortKey === 'date' ? (sortDir === 'asc' ? <SortAsc size={14} color={theme.textSecondary} /> : <SortDesc size={14} color={theme.textSecondary} />) : null}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => toggleSort('amount')} style={[styles.sortBtn, { borderColor: theme.border, backgroundColor: theme.card }]}>
                  <CreditCard size={14} color={theme.textSecondary} />
                  <Text style={[styles.sortLabel, { color: theme.textSecondary }]}>Amount</Text>
                  {sortKey === 'amount' ? (sortDir === 'asc' ? <SortAsc size={14} color={theme.textSecondary} /> : <SortDesc size={14} color={theme.textSecondary} />) : null}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => toggleSort('student')} style={[styles.sortBtn, { borderColor: theme.border, backgroundColor: theme.card }]}>
                  <User size={14} color={theme.textSecondary} />
                  <Text style={[styles.sortLabel, { color: theme.textSecondary }]}>Student</Text>
                  {sortKey === 'student' ? (sortDir === 'asc' ? <SortAsc size={14} color={theme.textSecondary} /> : <SortDesc size={14} color={theme.textSecondary} />) : null}
                </TouchableOpacity>
              </GHScrollView>
            </View>
          </View>
        );
      }

      if (item.kind === 'empty') {
        return (
          <View style={{ padding: 24, alignItems: 'center' }}>
            <Text style={{ color: theme.textSecondary }}>No payments found.</Text>
          </View>
        );
      }

      return (
        <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
          {renderItem({ item: item.payment })}
        </View>
      );
    },
    [
      theme,
      statsCount,
      statsAmount,
      statsLabel,
      methodBreakdown,
      debouncedQuery,
      filteredAndSorted.length,
      filterMethod,
      filterStudentId,
      availableStudents,
      timePreset,
      selectedMonthId,
      monthLabel,
      isDefaultTimeSelection,
      currentMonthId,
      dateFrom,
      dateTo,
      sortKey,
      sortDir,
      toggleSort,
      renderItem,
      clearQuery,
    ]
  );

  // Let nested scrolling behave naturally (no manual scroll toggling)

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      {/* Header (align with ReminderHistoryViewer: padded container with title row, then search+stats) */}
  <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border, paddingTop: 20 + (insets?.top || 0) }]}> 
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[styles.headerTitle, { color: theme.text }]}>Payment History</Text>
          <TouchableOpacity
            onPress={onClose ? onClose : () => router.back()}
            style={[styles.iconBtn, { backgroundColor: theme.background, borderWidth: 1, borderColor: theme.border }]}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <X size={21} color={theme.text} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Search, refresh and quick stats separated from header (with divider, stays fixed while list scrolls) */}
  <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, backgroundColor: theme.background }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={[styles.searchBox, { borderColor: theme.border, backgroundColor: theme.card, flex: 1 }]}> 
            <SearchIcon size={18} color={theme.textSecondary} />
            <TextInput
              value={query}
              onChangeText={handleQueryChange}
              placeholder="Search by student, method, amount, account details, paid by, notes"
              placeholderTextColor={theme.textSecondary}
              style={[styles.input, { color: theme.text }]} autoCapitalize="none"
            />
          </View>
          <TouchableOpacity
            onPress={onRefreshWithUsage}
            style={[styles.refreshIconBtn, { borderColor: theme.border, backgroundColor: theme.surface, marginLeft: 8 }]}
            accessibilityRole="button"
            accessibilityLabel="Refresh payments"
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={theme.primary} />
            ) : (
              <RefreshCcw size={18} color={theme.textSecondary} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* Time Preset Picker Modal */}
      <Modal visible={showTimePicker} transparent animationType="fade" onRequestClose={() => setShowTimePicker(false)}>
        <Pressable style={styles.filterModalOverlay} onPress={() => setShowTimePicker(false)}>
          <Pressable style={[styles.filterOptionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => {}}>
            <Text style={[styles.filterModalHeader, { color: theme.text }]}>Select Time Range</Text>
            <TypedGHFlatList<TimePresetOption>
              data={timePresetOptions}
              keyExtractor={(item) => item.id}
              style={{ maxHeight: 260 }}
              renderItem={({ item }) => {
                const isSelected = item.id === timePreset;
                return (
                  <TouchableOpacity
                    style={[styles.filterOptionItem, { backgroundColor: isSelected ? theme.primary + '20' : theme.card, borderColor: theme.border }]}
                    onPress={() => {
                      setTimePreset(item.id);

                      if (item.id !== 'custom') {
                        setDateFrom('');
                        setDateTo('');
                      }

                      if (item.id === 'month') {
                        if (!selectedMonthId) setSelectedMonthId(currentMonthId);
                        return;
                      }

                      setShowTimePicker(false);
                    }}
                  >
                    <Text style={[styles.filterOptionText, { color: isSelected ? theme.primary : theme.text }]}>{item.label}</Text>
                  </TouchableOpacity>
                );
              }}
            />

            {timePreset === 'month' && (
              <View style={{ marginTop: 10 }}>
                <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 6 }}>Select Month</Text>
                <TypedGHFlatList<string>
                  data={monthOptions}
                  keyExtractor={(id) => id}
                  style={{ maxHeight: 320 }}
                  onEndReached={() => setMonthListCount((c) => Math.min(c + 60, maxMonthOptions))}
                  onEndReachedThreshold={0.2}
                  renderItem={({ item: monthId }) => {
                    const isSelected = monthId === selectedMonthId;
                    return (
                      <TouchableOpacity
                        style={[styles.filterOptionItem, { backgroundColor: isSelected ? theme.primary + '20' : theme.card, borderColor: theme.border }]}
                        onPress={() => {
                          setSelectedMonthId(monthId);
                          setDateFrom('');
                          setDateTo('');
                          setShowTimePicker(false);
                        }}
                      >
                        <Text style={[styles.filterOptionText, { color: isSelected ? theme.primary : theme.text }]}>{monthLabel(monthId)}</Text>
                      </TouchableOpacity>
                    );
                  }}
                />
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Method Picker Modal */}
      <Modal visible={showMethodPicker} transparent animationType="fade" onRequestClose={() => setShowMethodPicker(false)}>
        <Pressable style={styles.filterModalOverlay} onPress={() => setShowMethodPicker(false)}>
          <Pressable style={[styles.filterOptionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => {}}>
            <Text style={[styles.filterModalHeader, { color: theme.text }]}>Select Method</Text>
            <TypedGHFlatList<string>
              data={availableMethods}
              keyExtractor={(item) => item}
              style={{ maxHeight: 260 }}
              renderItem={({ item }) => {
                const isSelected = item === filterMethod;
                const label = item === 'all' ? 'All methods' : humanizeMethod(item);
                return (
                  <TouchableOpacity
                    style={[styles.filterOptionItem, { backgroundColor: isSelected ? theme.primary + '20' : theme.card, borderColor: theme.border }]}
                    onPress={() => {
                      setFilterMethod(item);
                      setShowMethodPicker(false);
                    }}
                  >
                    <Text style={[styles.filterOptionText, { color: isSelected ? theme.primary : theme.text }]}>{label}</Text>
                  </TouchableOpacity>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Student Picker Modal */}
      <Modal visible={showStudentPicker} transparent animationType="fade" onRequestClose={() => setShowStudentPicker(false)}>
        <Pressable style={styles.filterModalOverlay} onPress={() => setShowStudentPicker(false)}>
          <Pressable style={[styles.filterOptionsModal, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={() => {}}>
            <Text style={[styles.filterModalHeader, { color: theme.text }]}>Select Student</Text>
            <TypedGHFlatList<StudentFilterOption>
              data={availableStudents}
              keyExtractor={(item) => item.id}
              style={{ maxHeight: 420 }}
              renderItem={({ item }) => {
                const isSelected = item.id === filterStudentId;
                return (
                  <TouchableOpacity
                    style={[styles.filterOptionItem, { backgroundColor: isSelected ? theme.primary + '20' : theme.card, borderColor: theme.border }]}
                    onPress={() => {
                      setFilterStudentId(item.id);
                      setShowStudentPicker(false);
                    }}
                  >
                    <Text style={[styles.filterOptionText, { color: isSelected ? theme.primary : theme.text }]}>{item.name || 'All students'}</Text>
                  </TouchableOpacity>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* List */}
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator />
        </View>
      ) : (
        <TypedGHFlatList<FeeHistoryListItem>
          data={listData}
          keyExtractor={listKeyExtractor}
          renderItem={renderListItem}
          stickyHeaderIndices={[1]}
          contentContainerStyle={{ paddingBottom: 32 }}
          nestedScrollEnabled
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.1}
          ListFooterComponent={renderFooter}
          removeClippedSubviews
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={10}
          updateCellsBatchingPeriod={50}
        />
      )}
    </View>
  );
}

function FilterPill({ label, active, onPress, onClear, theme }: { label: string; active?: boolean; onPress: () => void; onClear?: () => void; theme: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <TouchableOpacity
        onPress={onPress}
        delayPressIn={0}
        style={[styles.pill, { borderColor: theme.border, backgroundColor: theme.card }]}
      >
        <FilterIcon size={14} color={active ? theme.tabBarActive : theme.textSecondary} />
        <Text
          style={{ marginLeft: 6, fontSize: 12, lineHeight: 16, color: active ? theme.text : theme.textSecondary }}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {label}
        </Text>
      </TouchableOpacity>
      {active && onClear ? (
        <TouchableOpacity
          onPress={onClear}
          delayPressIn={0}
          style={[styles.pillClear, { borderColor: theme.border, backgroundColor: theme.card }]}
        >
          <X size={12} color={theme.textSecondary} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    padding: 20,
    borderBottomWidth: 1,
  },
  iconBtn: {
    padding: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
  },
  input: {
    flex: 1,
    paddingVertical: 0,
    height: '100%',
  },
  statsRow: {
    marginTop: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    height: 32,
  },
  pillClear: {
    marginLeft: 6,
    borderWidth: 1,
    borderRadius: 999,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dateInput: {
    width: 140,
    height: 32,
    marginLeft: 4,
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    height: 32,
  },
  sortBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    height: 32,
  },
  sortLabel: {
    fontSize: 12,
    lineHeight: 16,
  },
  row: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 14,
    marginTop: 2,
  },
  meta: {
    fontSize: 12,
    marginTop: 2,
  },
  notes: {
    fontSize: 12,
    marginTop: 6,
  },
  // Filter pickers
  filterModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  filterOptionsModal: {
    width: 320,
    maxWidth: '90%',
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
  },
  filterModalHeader: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  filterOptionItem: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginVertical: 6,
  },
  filterOptionText: {
    fontSize: 14,
    textAlign: 'center',
  },
  // Load more / pagination styles
  loadMoreContainer: {
    padding: 20,
    alignItems: 'center',
  },
  loadMoreButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
  },
  loadMoreText: {
    fontSize: 14,
    fontWeight: '600',
  },
  loadingMoreText: {
    fontSize: 14,
    marginTop: 8,
  },
  endOfListText: {
    fontSize: 14,
    fontStyle: 'italic',
  },
  refreshButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  refreshIconBtn: {
    marginLeft: 8,
    borderWidth: 1,
    borderRadius: 10,
    height: 44,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
