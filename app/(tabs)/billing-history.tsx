import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Linking,
  RefreshControl,
  TextInput,
  Animated,
  Easing,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { RefreshCw, X } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';

import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import { billingService, type BillingHistoryResponse, type BillingHistoryInvoice, type BillingHistoryChange } from '@/services/billingService';
import { describeBillingChange } from '@/lib/billingChangeDescriptions';

function formatBillingDate(value?: string, timeZone?: string) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone });
  } catch {
    // Fallback for runtimes without ICU timezone support (common on some RN builds).
    if ((timeZone || '').trim() === 'Asia/Kolkata') {
      const istMs = d.getTime() + 330 * 60 * 1000;
      const ist = new Date(istMs);
      try {
        return ist.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      } catch {
        return value;
      }
    }
    return value;
  }
}

function formatBillingDateTime(value?: string, timeZone?: string) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
  } catch {
    if ((timeZone || '').trim() === 'Asia/Kolkata') {
      const istMs = d.getTime() + 330 * 60 * 1000;
      const ist = new Date(istMs);
      try {
        return ist.toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return value;
      }
    }

    try {
      return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return value;
    }
  }
}

function formatAmountInr(amountInr: number): string {
  if (!Number.isFinite(amountInr)) return '₹0';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amountInr);
  } catch {
    return `₹${Math.round(amountInr)}`;
  }
}

function describeChange(entry: BillingHistoryChange): { title: string; subtitle?: string } {
  return describeBillingChange(entry, { context: 'history', formatAmountInr, formatBillingDate });
}

function describeInvoice(invoice: BillingHistoryInvoice, options?: { timeZone?: string }): { title: string; subtitle?: string } {
  const timeZone = options?.timeZone;
  const date = formatBillingDate(invoice.issuedAt, timeZone) || formatBillingDate(invoice.dueAt, timeZone);
  const rawStatus = (invoice.status || 'open').toLowerCase();
  const status = rawStatus === 'void' ? 'FAILED' : rawStatus.toUpperCase();
  const amount = formatAmountInr(invoice.amountInr);
  const title = `${amount} • ${status}`;

  const details: string[] = [];
  if (date) details.push(date);

  const paidAt = formatBillingDateTime(invoice.capturedAt, timeZone);
  const failedAt = formatBillingDateTime(invoice.failedAt, timeZone);
  const authorizedAt = formatBillingDateTime(invoice.authorizedAt, timeZone);
  if (paidAt) details.push(`Paid at: ${paidAt}`);
  else if (failedAt) details.push(`Failed at: ${failedAt}`);
  else if (authorizedAt) details.push(`Authorized at: ${authorizedAt}`);

  const updatedAt = formatBillingDateTime(invoice.updatedAt, timeZone);
  if (updatedAt) details.push(`Last updated: ${updatedAt}`);
  if (invoice.planVariantId || invoice.planId) {
    const planLabel = invoice.planId ? String(invoice.planId).toUpperCase() : 'PLAN';
    const variantLabel = invoice.planVariantId ? ` (${invoice.planVariantId})` : '';
    details.push(`Plan: ${planLabel}${variantLabel}`);
  }
  if (invoice.couponCode) details.push(`Coupon: ${String(invoice.couponCode).toUpperCase()}`);
  if (invoice.method) {
    const methodLabel = String(invoice.method).toUpperCase();
    const cardSuffix = invoice.cardNetwork || invoice.cardLast4 ? ` • ${(invoice.cardNetwork || '').toUpperCase()}${invoice.cardLast4 ? ` • **** ${invoice.cardLast4}` : ''}` : '';
    const upiSuffix = invoice.upiVpaMasked ? ` • ${invoice.upiVpaMasked}` : '';
    details.push(`Method: ${methodLabel}${cardSuffix}${upiSuffix}`);
  }
  if (invoice.billingPeriodStart || invoice.billingPeriodEnd) {
    const start = formatBillingDate(invoice.billingPeriodStart, timeZone) || invoice.billingPeriodStart;
    const end = formatBillingDate(invoice.billingPeriodEnd, timeZone) || invoice.billingPeriodEnd;
    if (start && end) details.push(`Period: ${start} → ${end}`);
    else if (end) details.push(`Period end: ${end}`);
  }
  if (invoice.isSynthetic) details.push('Recorded from subscription update');
  if (invoice.payerEmail) details.push(`Paid by: ${invoice.payerEmail}`);
  if (invoice.createdByEmail) {
    const label = invoice.createdByRole === 'admin' ? 'Initiated by admin' : 'Initiated by';
    details.push(`${label}: ${invoice.createdByEmail}`);
  }
  if (invoice.errorDescription && (rawStatus === 'failed' || rawStatus === 'void')) details.push(invoice.errorDescription);

  return { title, subtitle: details.length ? details.join('\n') : undefined };
}

function normalizeSearch(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

export default function BillingHistoryScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { activeTenant, activeMembership, loading: tenantLoading } = useTenant();
  const isNativeMobile = Platform.OS === 'ios' || Platform.OS === 'android';

  const focusCountRef = useRef(0);
  const refreshSpin = useRef(new Animated.Value(0)).current;
  const refreshLoopRef = useRef<Animated.CompositeAnimation | null>(null);

  const [history, setHistory] = useState<BillingHistoryResponse | null>(null);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [latestChange, setLatestChange] = useState<BillingHistoryChange | null>(null);
  const [loadingLatestChange, setLoadingLatestChange] = useState(false);
  const [errorInvoices, setErrorInvoices] = useState<string | null>(null);
  const [errorChanges, setErrorChanges] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [generatingInvoiceId, setGeneratingInvoiceId] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeSection, setActiveSection] = useState<'all' | 'payments' | 'changes'>('all');
  const [paymentStatus, setPaymentStatus] = useState<'all' | 'paid' | 'failed' | 'open'>('all');
  const [pageSizeInvoices, setPageSizeInvoices] = useState<10 | 25 | 50>(10);
  const [pageSizeChanges, setPageSizeChanges] = useState<10 | 25 | 50>(10);
  const [cursorInvoice, setCursorInvoice] = useState<{ at: string; id: string } | null>(null);
  const [cursorChange, setCursorChange] = useState<{ at: string; id: string } | null>(null);
  const [invoiceCursorStack, setInvoiceCursorStack] = useState<({ at: string; id: string } | null)[]>([]);
  const [changeCursorStack, setChangeCursorStack] = useState<({ at: string; id: string } | null)[]>([]);
  const [invoicesTotalPagesKnown, setInvoicesTotalPagesKnown] = useState(1);
  const [changesTotalPagesKnown, setChangesTotalPagesKnown] = useState(1);

  const canManageBilling = useMemo(() => {
    const role = activeMembership?.role ?? 'member';
    return role === 'owner' || role === 'admin';
  }, [activeMembership?.role]);

  const canLoad = Boolean(activeTenant?.id && canManageBilling);
  const shouldShowInvoices = activeSection !== 'changes';
  const shouldShowChanges = activeSection !== 'payments';

  const loadLatestChange = useCallback(async () => {
    if (!activeTenant?.id) return;
    setLoadingLatestChange(true);
    try {
      billingService.invalidateLatestBillingChangeCache({ tenantId: activeTenant.id });
      const entry = await billingService.getLatestBillingChange(activeTenant.id);
      setLatestChange(entry);
    } catch {
      setLatestChange(null);
    } finally {
      setLoadingLatestChange(false);
    }
  }, [activeTenant?.id]);

  const loadInvoices = useCallback(async () => {
    if (!activeTenant?.id) return;
    setLoadingInvoices(true);
    setErrorInvoices(null);
    try {
      const data = await billingService.getBillingHistory(activeTenant.id, {
        pageSize: pageSizeInvoices,
        limitInvoices: pageSizeInvoices,
        limitChanges: 0,
        cursorInvoice: cursorInvoice ?? undefined,
        includeTotals: cursorInvoice === null,
        invoiceStatus: paymentStatus === 'all' ? undefined : paymentStatus,
      });

      setHistory((prev) => {
        const base: BillingHistoryResponse = prev || {
          tenantId: data.tenantId,
          invoices: [],
          changes: [],
          pageInfo: { invoices: {}, changes: {} },
        };
        return {
          ...base,
          tenantId: data.tenantId,
          invoices: data.invoices || [],
          totals: {
            invoices: typeof data.totals?.invoices === 'number' ? data.totals.invoices : base.totals?.invoices,
            changes: base.totals?.changes,
          },
          matchingTotals: {
            invoices:
              typeof data.matchingTotals?.invoices === 'number'
                ? data.matchingTotals.invoices
                : base.matchingTotals?.invoices,
            changes: base.matchingTotals?.changes,
          },
          pageInfo: {
            invoices: data.pageInfo?.invoices || {},
            changes: base.pageInfo?.changes || {},
          },
        };
      });
    } catch (e: any) {
      setErrorInvoices(typeof e?.message === 'string' ? e.message : 'Failed to load payments');
    } finally {
      setLoadingInvoices(false);
    }
  }, [activeTenant?.id, cursorInvoice, pageSizeInvoices, paymentStatus]);

  useEffect(() => {
    setCursorInvoice(null);
    setInvoiceCursorStack([]);
    setInvoicesTotalPagesKnown(1);
  }, [activeTenant?.id, pageSizeInvoices, paymentStatus]);

  const loadChanges = useCallback(async () => {
    if (!activeTenant?.id) return;
    setLoadingChanges(true);
    setErrorChanges(null);
    try {
      const data = await billingService.getBillingHistory(activeTenant.id, {
        pageSize: pageSizeChanges,
        limitInvoices: 0,
        limitChanges: pageSizeChanges,
        cursorChange: cursorChange ?? undefined,
        includeTotals: cursorChange === null,
      });

      setHistory((prev) => {
        const base: BillingHistoryResponse = prev || {
          tenantId: data.tenantId,
          invoices: [],
          changes: [],
          pageInfo: { invoices: {}, changes: {} },
        };
        return {
          ...base,
          tenantId: data.tenantId,
          changes: data.changes || [],
          totals: {
            invoices: base.totals?.invoices,
            changes: typeof data.totals?.changes === 'number' ? data.totals.changes : base.totals?.changes,
          },
          matchingTotals: {
            invoices: base.matchingTotals?.invoices,
            changes:
              typeof data.matchingTotals?.changes === 'number'
                ? data.matchingTotals.changes
                : base.matchingTotals?.changes,
          },
          pageInfo: {
            invoices: base.pageInfo?.invoices || {},
            changes: data.pageInfo?.changes || {},
          },
        };
      });
    } catch (e: any) {
      setErrorChanges(typeof e?.message === 'string' ? e.message : 'Failed to load plan changes');
    } finally {
      setLoadingChanges(false);
    }
  }, [activeTenant?.id, cursorChange, pageSizeChanges]);

  const refreshRotation = useMemo(
    () =>
      refreshSpin.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
      }),
    [refreshSpin]
  );

  useEffect(() => {
    if (!refreshing) {
      refreshLoopRef.current?.stop();
      refreshLoopRef.current = null;
      refreshSpin.stopAnimation();
      return;
    }

    refreshSpin.setValue(0);
    const loop = Animated.loop(
      Animated.timing(refreshSpin, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    refreshLoopRef.current = loop;
    loop.start();

    return () => {
      loop.stop();
    };
  }, [refreshSpin, refreshing]);

  const refreshAll = useCallback(async () => {
    if (!activeTenant?.id) return;
    setRefreshing(true);
    setErrorInvoices(null);
    setErrorChanges(null);
    setCursorInvoice(null);
    setCursorChange(null);
    setInvoiceCursorStack([]);
    setChangeCursorStack([]);
    setInvoicesTotalPagesKnown(1);
    setChangesTotalPagesKnown(1);
    try {
      const data = await billingService.getBillingHistory(activeTenant.id, {
        pageSize: Math.max(pageSizeInvoices, pageSizeChanges),
        limitInvoices: pageSizeInvoices,
        limitChanges: pageSizeChanges,
        includeTotals: true,
        invoiceStatus: paymentStatus === 'all' ? undefined : paymentStatus,
      });
      setHistory(data);
    } catch (e: any) {
      const message = typeof e?.message === 'string' ? e.message : 'Failed to refresh billing history';
      setErrorInvoices(message);
      setErrorChanges(message);
    } finally {
      setRefreshing(false);
    }
  }, [activeTenant?.id, pageSizeChanges, pageSizeInvoices, paymentStatus]);

  useFocusEffect(
    useCallback(() => {
      if (!canLoad) return;

      // Skip initial mount focus (useEffect below will load first page).
      focusCountRef.current += 1;
      if (focusCountRef.current === 1) return;

      if (shouldShowInvoices) void loadInvoices();
      if (shouldShowChanges) void loadChanges();
    }, [canLoad, loadChanges, loadInvoices, shouldShowChanges, shouldShowInvoices])
  );

  const nextInvoiceCursor = history?.pageInfo?.invoices?.nextCursor;
  const nextChangeCursor = history?.pageInfo?.changes?.nextCursor;

  useEffect(() => {
    if (!canLoad || !shouldShowInvoices) return;
    void loadInvoices();
  }, [canLoad, loadInvoices, cursorInvoice, pageSizeInvoices, shouldShowInvoices]);

  useEffect(() => {
    if (!canLoad || !shouldShowChanges) return;
    void loadChanges();
  }, [canLoad, loadChanges, cursorChange, pageSizeChanges, shouldShowChanges]);

  const changes = useMemo(() => history?.changes || [], [history]);
  const invoices = useMemo(() => history?.invoices || [], [history]);

  const latestChangeFromHistory = useMemo(() => (changes.length ? changes[0] : null), [changes]);
  const latestChangeForSummary = latestChangeFromHistory || latestChange;

  const latestChangeSummary = useMemo(() => {
    if (!latestChangeForSummary) return null;
    const desc = describeChange(latestChangeForSummary);
    const subtitle = [desc.title, desc.subtitle].filter(Boolean).join(' • ');
    return { title: 'Latest plan change', subtitle };
  }, [latestChangeForSummary]);

  useEffect(() => {
    if (!canLoad) return;
    if (activeSection !== 'payments') return;
    if (latestChangeFromHistory) return;
    void loadLatestChange();
  }, [activeSection, canLoad, latestChangeFromHistory, loadLatestChange]);

  const normalizedQuery = useMemo(() => normalizeSearch(searchQuery), [searchQuery]);

  const tenantTimeZone = history?.timeZone || 'Asia/Kolkata';

  const filteredInvoices = useMemo(() => {
    const source = invoices || [];
    const statusFiltered =
      paymentStatus === 'all'
        ? source
        : source.filter((inv) => (inv.status === 'void' ? 'failed' : inv.status) === paymentStatus);
    const searched = !normalizedQuery
      ? statusFiltered
      : statusFiltered.filter((inv) => {
          const statusLabel = inv.status === 'void' ? 'failed' : inv.status;
          const haystack = [
            inv.id,
            statusLabel,
            inv.status,
            inv.provider,
            inv.payerEmail,
            inv.createdByEmail,
            inv.createdByRole,
            inv.providerPaymentId,
            inv.providerSubscriptionId,
            inv.subscriptionId,
            inv.rawEvent,
            inv.errorCode,
            inv.errorDescription,
            inv.updatedAt,
            String(inv.amountInr ?? ''),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        });

    const sorted = [...searched].sort((a, b) => {
      const aTime = new Date(a.issuedAt || a.dueAt || 0).getTime();
      const bTime = new Date(b.issuedAt || b.dueAt || 0).getTime();
      if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
      return bTime - aTime;
    });

    return sorted;
  }, [invoices, normalizedQuery, paymentStatus]);

  const filteredChanges = useMemo(() => {
    const source = changes || [];
    const searched = !normalizedQuery
      ? source
      : source.filter((entry) => {
          const haystack = [entry.action, entry.actorEmail, JSON.stringify(entry.metadata || {})]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(normalizedQuery);
        });

    const sorted = [...searched].sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
      return bTime - aTime;
    });

    return sorted;
  }, [changes, normalizedQuery]);

  const totalsLabel = useMemo(() => {
    const rawTotalInvoices = history?.totals?.invoices;
    const rawTotalChanges = history?.totals?.changes;
    const rawMatchingInvoices = history?.matchingTotals?.invoices;

    const totalInvoices =
      typeof rawTotalInvoices === 'number' && Number.isFinite(rawTotalInvoices)
        ? Math.max(0, Math.trunc(rawTotalInvoices))
        : invoices.length;
    const totalChanges =
      typeof rawTotalChanges === 'number' && Number.isFinite(rawTotalChanges)
        ? Math.max(0, Math.trunc(rawTotalChanges))
        : changes.length;

    const matchingInvoices =
      paymentStatus === 'all'
        ? totalInvoices
        : typeof rawMatchingInvoices === 'number' && Number.isFinite(rawMatchingInvoices)
          ? Math.max(0, Math.trunc(rawMatchingInvoices))
          : filteredInvoices.length;

    const matchingChanges = totalChanges;

    if (activeSection === 'payments') {
      return `Payments: ${matchingInvoices}/${totalInvoices}`;
    }
    if (activeSection === 'changes') {
      return `Plan changes: ${matchingChanges}/${totalChanges}`;
    }
    return `Payments: ${matchingInvoices}/${totalInvoices} • Plan changes: ${matchingChanges}/${totalChanges}`;
  }, [activeSection, changes.length, filteredInvoices.length, history?.matchingTotals?.invoices, history?.totals?.changes, history?.totals?.invoices, invoices.length, paymentStatus]);

  const invoicesPageNumber = useMemo(() => invoiceCursorStack.length + 1, [invoiceCursorStack.length]);
  const changesPageNumber = useMemo(() => changeCursorStack.length + 1, [changeCursorStack.length]);
  const canPrevInvoices = useMemo(() => invoiceCursorStack.length > 0, [invoiceCursorStack.length]);
  const canPrevChanges = useMemo(() => changeCursorStack.length > 0, [changeCursorStack.length]);
  const canNextInvoices = useMemo(() => Boolean(nextInvoiceCursor), [nextInvoiceCursor]);
  const canNextChanges = useMemo(() => Boolean(nextChangeCursor), [nextChangeCursor]);

  const invoicesTotalCount = useMemo(() => {
    const raw = history?.totals?.invoices;
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : null;
  }, [history?.totals?.invoices]);

  const changesTotalCount = useMemo(() => {
    const raw = history?.totals?.changes;
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : null;
  }, [history?.totals?.changes]);

  const invoicesTotalPages = useMemo(() => {
    if (typeof invoicesTotalCount === 'number') {
      return Math.max(1, Math.ceil(invoicesTotalCount / pageSizeInvoices));
    }
    return invoicesTotalPagesKnown;
  }, [invoicesTotalCount, invoicesTotalPagesKnown, pageSizeInvoices]);

  const changesTotalPages = useMemo(() => {
    if (typeof changesTotalCount === 'number') {
      return Math.max(1, Math.ceil(changesTotalCount / pageSizeChanges));
    }
    return changesTotalPagesKnown;
  }, [changesTotalCount, changesTotalPagesKnown, pageSizeChanges]);

  useEffect(() => {
    const inferred = invoicesPageNumber + (canNextInvoices ? 1 : 0);
    setInvoicesTotalPagesKnown((prev) => Math.max(1, Math.max(prev, inferred)));
  }, [canNextInvoices, invoicesPageNumber]);

  useEffect(() => {
    const inferred = changesPageNumber + (canNextChanges ? 1 : 0);
    setChangesTotalPagesKnown((prev) => Math.max(1, Math.max(prev, inferred)));
  }, [canNextChanges, changesPageNumber]);

  const handleClose = () => {
    router.replace('/(tabs)/plan');
  };

  const openInvoice = async (url?: string) => {
    if (!url) return;
    try {
      if (!isNativeMobile) {
        const canOpen = await Linking.canOpenURL(url);
        if (canOpen) await Linking.openURL(url);
        return;
      }

      // Native: keep the user inside the app surface.
      await WebBrowser.openBrowserAsync(url, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        enableBarCollapsing: true,
        showTitle: true,
      });
    } catch {
      // ignore
    }
  };

  const makeSafePdfFilename = (value: string): string => {
    const raw = (value || '').trim() || 'invoice';
    const safe = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    const withExt = safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`;
    return withExt || 'invoice.pdf';
  };

  const handleInvoiceDownload = useCallback(
    async (invoice: BillingHistoryInvoice) => {
      if (!activeTenant?.id) return;

      if (!isNativeMobile) {
        setGeneratingInvoiceId(invoice.id);
        try {
          const blob = await billingService.downloadInvoicePdf(activeTenant.id, invoice.id);
          if (!(blob instanceof Blob) || blob.size === 0) {
            setErrorInvoices('Invoice download failed (empty response).');
            return;
          }
          const filenameBase = invoice.invoiceNumber || invoice.id;
          const filename = `${String(filenameBase).trim() || invoice.id}.pdf`;
          const href = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = href;
          a.download = filename;
          a.rel = 'noopener noreferrer';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(href);
        } catch (e: any) {
          setErrorInvoices(typeof e?.message === 'string' ? e.message : 'Failed to download invoice');
        } finally {
          setGeneratingInvoiceId((current) => (current === invoice.id ? null : current));
        }
        return;
      }

      const existing = typeof invoice.downloadUrl === 'string' ? invoice.downloadUrl.trim() : '';
      setGeneratingInvoiceId(invoice.id);
      try {
        const resp = await billingService.getInvoiceDownloadUrl(activeTenant.id, invoice.id);
        const url = typeof resp?.downloadUrl === 'string' ? resp.downloadUrl : '';
        if (url) {
          setHistory((prev) => {
            if (!prev) return prev;
            const nextInvoices = (prev.invoices || []).map((inv) => (inv.id === invoice.id ? { ...inv, downloadUrl: url } : inv));
            return { ...prev, invoices: nextInvoices };
          });
          // Native: download to a local file and share/open it.
          if (isNativeMobile) {
            const baseName = String(invoice.invoiceNumber || invoice.id || 'invoice');
            const filename = makeSafePdfFilename(baseName);
            const dir = `${FileSystem.cacheDirectory || FileSystem.documentDirectory || ''}invoices/`;
            if (dir) {
              try {
                await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
              } catch {
                // ignore
              }
              const localUri = `${dir}${filename}`;
              const downloaded = await FileSystem.downloadAsync(url, localUri);
              const finalUri = downloaded?.uri || localUri;

              const sharingAvailable = await Sharing.isAvailableAsync().catch(() => false);
              if (sharingAvailable) {
                await Sharing.shareAsync(finalUri, {
                  mimeType: 'application/pdf',
                  dialogTitle: 'Invoice',
                  UTI: 'com.adobe.pdf',
                });
                return;
              }
            }
            // Fallback: open inside an in-app browser if we can't share.
            await openInvoice(url);
            return;
          }

          // Web fallback (keeps existing behavior)
          await openInvoice(url);
        } else if (existing) {
          await openInvoice(existing);
        }
      } catch (e: any) {
        if (existing) {
          await openInvoice(existing);
        } else {
          // Surface a non-blocking error in the invoices section.
          setErrorInvoices(typeof e?.message === 'string' ? e.message : 'Failed to generate invoice');
        }
      } finally {
        setGeneratingInvoiceId((current) => (current === invoice.id ? null : current));
      }
    },
    [activeTenant?.id]
  );

  const loadPrevInvoices = useCallback(() => {
    if (!canPrevInvoices) return;
    setInvoiceCursorStack((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      const previousCursor = next.pop() ?? null;
      setCursorInvoice(previousCursor);
      return next;
    });
  }, [canPrevInvoices]);

  const loadNextInvoices = useCallback(() => {
    if (!canNextInvoices || !nextInvoiceCursor) return;
    setInvoiceCursorStack((prev) => [...prev, cursorInvoice]);
    setCursorInvoice(nextInvoiceCursor);
  }, [canNextInvoices, cursorInvoice, nextInvoiceCursor]);

  const loadPrevChanges = useCallback(() => {
    if (!canPrevChanges) return;
    setChangeCursorStack((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      const previousCursor = next.pop() ?? null;
      setCursorChange(previousCursor);
      return next;
    });
  }, [canPrevChanges]);

  const loadNextChanges = useCallback(() => {
    if (!canNextChanges || !nextChangeCursor) return;
    setChangeCursorStack((prev) => [...prev, cursorChange]);
    setCursorChange(nextChangeCursor);
  }, [canNextChanges, cursorChange, nextChangeCursor]);

  if (tenantLoading) {
    return (
      <SafeAreaView edges={['top']} style={[styles.container, { backgroundColor: theme.background }]}> 
        <View style={[styles.center, { flex: 1 }]}> 
          <ActivityIndicator />
          <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!activeTenant) {
    return (
      <SafeAreaView edges={['top']} style={[styles.container, { backgroundColor: theme.background }]}> 
        <TenantSelectionEmptyState
          title="No coaching center selected"
          description="Select a coaching center to view billing history."
        />
      </SafeAreaView>
    );
  }

  if (!canManageBilling) {
    return (
      <SafeAreaView edges={['top']} style={[styles.container, { backgroundColor: theme.surface }]}> 
        <View style={[styles.container, { backgroundColor: theme.background }]}> 
          <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}> 
            <TouchableOpacity onPress={handleClose} style={styles.headerButton}>
              <X size={22} color={theme.text} />
            </TouchableOpacity>
            <Text style={[styles.title, { color: theme.text }]}>Billing History</Text>
            <View style={styles.headerButton} />
          </View>

          <View style={styles.content}>
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
              <Text style={[styles.cardTitle, { color: theme.text }]}>Admin access required</Text>
              <Text style={[styles.cardText, { color: theme.textSecondary }]}>Only tenant admins can view billing history.</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Note: All memo/hooks must stay above conditional returns.

  return (
    <SafeAreaView edges={['top']} style={[styles.container, { backgroundColor: theme.surface }]}> 
      <View style={[styles.container, { backgroundColor: theme.background }]}> 
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}> 
          <TouchableOpacity onPress={handleClose} style={styles.headerButton}>
            <X size={22} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: theme.text }]}>Billing History</Text>
          <View style={styles.headerButton} />
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refreshAll} />}
        >
          <>
            <View style={[styles.controlsCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <View style={styles.searchRow}>
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search payments or plan changes"
                placeholderTextColor={theme.textSecondary}
                style={[styles.searchInput, { color: theme.text, borderColor: theme.border }]}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                onPress={() => void refreshAll()}
                disabled={refreshing}
                style={[styles.iconButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
              >
                <Animated.View style={{ transform: [{ rotate: refreshRotation }] }}>
                  <RefreshCw size={18} color={theme.text} />
                </Animated.View>
              </TouchableOpacity>
            </View>

            <View style={styles.controlsRow}>
              <TouchableOpacity
                onPress={() => setActiveSection('all')}
                style={[
                  styles.chip,
                  { borderColor: theme.border },
                  activeSection === 'all' ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                ]}
              >
                <Text style={[styles.chipText, { color: activeSection === 'all' ? '#fff' : theme.text }]}>All</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setActiveSection('payments')}
                style={[
                  styles.chip,
                  { borderColor: theme.border },
                  activeSection === 'payments' ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                ]}
              >
                <Text style={[styles.chipText, { color: activeSection === 'payments' ? '#fff' : theme.text }]}>Payments</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setActiveSection('changes')}
                style={[
                  styles.chip,
                  { borderColor: theme.border },
                  activeSection === 'changes' ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                ]}
              >
                <Text style={[styles.chipText, { color: activeSection === 'changes' ? '#fff' : theme.text }]}>Plan changes</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.controlsRow}>
              <TouchableOpacity
                onPress={() => setPaymentStatus('all')}
                style={[
                  styles.chip,
                  { borderColor: theme.border },
                  paymentStatus === 'all' ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                ]}
              >
                <Text style={[styles.chipText, { color: paymentStatus === 'all' ? '#fff' : theme.text }]}>All payments</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setPaymentStatus('paid')}
                style={[
                  styles.chip,
                  { borderColor: theme.border },
                  paymentStatus === 'paid' ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                ]}
              >
                <Text style={[styles.chipText, { color: paymentStatus === 'paid' ? '#fff' : theme.text }]}>Paid</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setPaymentStatus('open')}
                style={[
                  styles.chip,
                  { borderColor: theme.border },
                  paymentStatus === 'open' ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                ]}
              >
                <Text style={[styles.chipText, { color: paymentStatus === 'open' ? '#fff' : theme.text }]}>Open</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setPaymentStatus('failed')}
                style={[
                  styles.chip,
                  { borderColor: theme.border },
                  paymentStatus === 'failed' ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                ]}
              >
                <Text style={[styles.chipText, { color: paymentStatus === 'failed' ? '#fff' : theme.text }]}>Failed</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.countText, { color: theme.textSecondary }]}>{totalsLabel}</Text>
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>PAYMENTS</Text>

            {activeSection === 'payments' ? (
              loadingLatestChange && !latestChangeSummary ? (
                <View style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>Loading latest plan change…</Text>
                </View>
              ) : latestChangeSummary ? (
                <View style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
                  <Text style={[styles.rowTitle, { color: theme.text }]}>{latestChangeSummary.title}</Text>
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]} numberOfLines={2} ellipsizeMode="tail">
                    {latestChangeSummary.subtitle}
                  </Text>
                </View>
              ) : null
            ) : null}

            {activeSection !== 'changes' ? (
              loadingInvoices && !invoices.length ? (
                <View style={styles.center}>
                  <ActivityIndicator />
                  <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading payments…</Text>
                </View>
              ) : errorInvoices && !invoices.length ? (
                <View style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>{errorInvoices}</Text>
                  <TouchableOpacity onPress={() => void loadInvoices()} style={styles.linkButton}>
                    <Text style={[styles.linkText, { color: theme.primary }]}>Try again</Text>
                  </TouchableOpacity>
                </View>
              ) : filteredInvoices.length ? (
                filteredInvoices.map((inv) => {
                  const desc = describeInvoice(inv, { timeZone: tenantTimeZone });
                  const downloading = generatingInvoiceId === inv.id;
                  return (
                    <View key={inv.id} style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                      <Text style={[styles.rowTitle, { color: theme.text }]}>{desc.title}</Text>
                      {desc.subtitle ? <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>{desc.subtitle}</Text> : null}
                      <TouchableOpacity
                        onPress={() => void handleInvoiceDownload(inv)}
                        disabled={downloading}
                        style={[styles.linkButton, downloading ? { opacity: 0.6 } : null]}
                      >
                        <Text style={[styles.linkText, { color: theme.primary }]}>
                          {downloading ? 'Downloading…' : 'Download invoice'}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  );
                })
              ) : (
                <View style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>No payments recorded yet.</Text>
                </View>
              )
            ) : null}

            {activeSection !== 'changes' ? (
              <View style={styles.paginationRow}>
                <Text style={[styles.paginationMetaText, { color: theme.textSecondary }]}>
                  Page: {invoicesPageNumber} of {invoicesTotalPages}
                </Text>
                {loadingInvoices ? <ActivityIndicator size="small" /> : null}

                <Text style={[styles.paginationMetaText, { color: theme.textSecondary }]}>Page Size:</Text>
                {[10, 25, 50].map((size) => (
                  <TouchableOpacity
                    key={`inv-${size}`}
                    onPress={() => {
                      setCursorInvoice(null);
                      setInvoiceCursorStack([]);
                      setInvoicesTotalPagesKnown(1);
                      setPageSizeInvoices(size as 10 | 25 | 50);
                    }}
                    style={[
                      styles.paginationChip,
                      { borderColor: theme.border },
                      pageSizeInvoices === size ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                    ]}
                  >
                    <Text style={[styles.paginationChipText, { color: pageSizeInvoices === size ? '#fff' : theme.text }]}>{size}</Text>
                  </TouchableOpacity>
                ))}

                <TouchableOpacity
                  onPress={loadPrevInvoices}
                  disabled={!canPrevInvoices || loadingInvoices}
                  style={[
                    styles.paginationChip,
                    { borderColor: theme.border },
                    canPrevInvoices && !loadingInvoices ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent', opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.paginationChipText, { color: canPrevInvoices && !loadingInvoices ? '#fff' : theme.text }]}>Prev</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={loadNextInvoices}
                  disabled={!canNextInvoices || loadingInvoices}
                  style={[
                    styles.paginationChip,
                    { borderColor: theme.border },
                    canNextInvoices && !loadingInvoices ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent', opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.paginationChipText, { color: canNextInvoices && !loadingInvoices ? '#fff' : theme.text }]}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>PLAN CHANGES</Text>

            {activeSection !== 'payments' ? (
              loadingChanges && !changes.length ? (
                <View style={styles.center}>
                  <ActivityIndicator />
                  <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading plan changes…</Text>
                </View>
              ) : errorChanges && !changes.length ? (
                <View style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>{errorChanges}</Text>
                  <TouchableOpacity onPress={() => void loadChanges()} style={styles.linkButton}>
                    <Text style={[styles.linkText, { color: theme.primary }]}>Try again</Text>
                  </TouchableOpacity>
                </View>
              ) : filteredChanges.length ? (
                filteredChanges.map((entry) => {
                  const desc = describeChange(entry);
                  const date = formatBillingDate(entry.createdAt) || entry.createdAt;
                  const actor = entry.actorEmail ? `By: ${entry.actorEmail}` : undefined;
                  const subtitleParts = [desc.subtitle, actor, date].filter(Boolean);
                  return (
                    <View key={entry.id} style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                      <Text style={[styles.rowTitle, { color: theme.text }]}>{desc.title}</Text>
                      {subtitleParts.length ? (
                        <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>{subtitleParts.join('\n')}</Text>
                      ) : null}
                    </View>
                  );
                })
              ) : (
                <View style={[styles.rowCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <Text style={[styles.rowSubtitle, { color: theme.textSecondary }]}>No plan changes recorded yet.</Text>
                </View>
              )
            ) : null}

            {activeSection !== 'payments' ? (
              <View style={styles.paginationRow}>
                <Text style={[styles.paginationMetaText, { color: theme.textSecondary }]}>
                  Page: {changesPageNumber} of {changesTotalPages}
                </Text>
                {loadingChanges ? <ActivityIndicator size="small" /> : null}

                <Text style={[styles.paginationMetaText, { color: theme.textSecondary }]}>Page Size:</Text>
                {[10, 25, 50].map((size) => (
                  <TouchableOpacity
                    key={`chg-${size}`}
                    onPress={() => {
                      setCursorChange(null);
                      setChangeCursorStack([]);
                      setChangesTotalPagesKnown(1);
                      setPageSizeChanges(size as 10 | 25 | 50);
                    }}
                    style={[
                      styles.paginationChip,
                      { borderColor: theme.border },
                      pageSizeChanges === size ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent' },
                    ]}
                  >
                    <Text style={[styles.paginationChipText, { color: pageSizeChanges === size ? '#fff' : theme.text }]}>{size}</Text>
                  </TouchableOpacity>
                ))}

                <TouchableOpacity
                  onPress={loadPrevChanges}
                  disabled={!canPrevChanges || loadingChanges}
                  style={[
                    styles.paginationChip,
                    { borderColor: theme.border },
                    canPrevChanges && !loadingChanges ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent', opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.paginationChipText, { color: canPrevChanges && !loadingChanges ? '#fff' : theme.text }]}>Prev</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={loadNextChanges}
                  disabled={!canNextChanges || loadingChanges}
                  style={[
                    styles.paginationChip,
                    { borderColor: theme.border },
                    canNextChanges && !loadingChanges ? { backgroundColor: theme.primary } : { backgroundColor: 'transparent', opacity: 0.6 },
                  ]}
                >
                  <Text style={[styles.paginationChipText, { color: canNextChanges && !loadingChanges ? '#fff' : theme.text }]}>Next</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 18,
    fontFamily: 'Inter-SemiBold',
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  section: {
    marginBottom: 18,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 10,
    letterSpacing: 0.4,
  },
  controlsCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  searchInput: {
    flex: 1,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter-Regular',
  },
  iconButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  paginationRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  paginationChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  chipText: {
    fontSize: 12,
    fontFamily: 'Inter-SemiBold',
  },
  paginationChipText: {
    fontSize: 11,
    fontFamily: 'Inter-SemiBold',
  },
  countText: {
    fontSize: 12,
    fontFamily: 'Inter-Medium',
    marginTop: 2,
  },
  paginationMetaText: {
    fontSize: 11,
    fontFamily: 'Inter-Medium',
    marginTop: 2,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 10,
  },
  loadingText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  cardTitle: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 6,
  },
  cardText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    marginBottom: 12,
  },
  primaryButton: {
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
  },
  rowCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  rowTitle: {
    fontSize: 15,
    fontFamily: 'Inter-SemiBold',
    marginBottom: 4,
  },
  rowSubtitle: {
    fontSize: 13,
    fontFamily: 'Inter-Regular',
    lineHeight: 18,
  },
  linkButton: {
    paddingTop: 10,
  },
  linkText: {
    fontSize: 13,
    fontFamily: 'Inter-SemiBold',
  },
});
