import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
  Animated,
  Easing,
  Platform,
  ActivityIndicator,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as ExpoLinking from 'expo-linking';
import * as Application from 'expo-application';
import { useRouter } from 'expo-router';
import { History, X } from 'lucide-react-native';
import { useFocusEffect } from '@react-navigation/native';

import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { useTenantUsageSummary } from '@/hooks/useTenantUsageSummary';
import TenantSelectionEmptyState from '@/components/TenantSelectionEmptyState';
import PlanTierCard from '@/components/PlanTierCard';
import ConfirmationModal from '@/components/ConfirmationModal';
import { billingService, type BillingCatalogPlanVariant, type BillingCurrentResponse, type BillingHistoryChange } from '@/services/billingService';
import { finishGooglePlayTransactionSafe, purchaseGooglePlaySubscription } from '@/services/googlePlayBilling';
import { getLastInAppRoute } from '@/lib/lastInAppRoute';
import { describeBillingChange } from '@/lib/billingChangeDescriptions';

function formatBillingDate(value?: string) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return value;
  }
}

function describeLatestBillingChange(entry: BillingHistoryChange): { title: string; subtitle?: string } {
  return describeBillingChange(entry, { context: 'plan', formatBillingDate });
}

function parseJsonMessage(rawMessage: string): any | null {
  const trimmed = (rawMessage || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toFriendlyBillingErrorMessage(rawMessage: string): string {
  const trimmed = (rawMessage || '').trim();
  const parsed = parseJsonMessage(trimmed);
  const code = typeof parsed?.error === 'string' ? String(parsed.error).trim() : '';
  const backendMessage = typeof parsed?.message === 'string' ? String(parsed.message).trim() : '';

  if (backendMessage) return backendMessage;

  // Non-JSON / client-side errors
  if (!code) {
    if (trimmed.includes('Billing backend URL not configured')) {
      return 'Billing backend is not configured for this app. Please contact support.';
    }
    if (trimmed === 'missing_url' || trimmed === 'missing_checkout_url') {
      return 'Link unavailable. Please try again later.';
    }
    // If it looks like raw JSON or a technical token, avoid showing it.
    if (trimmed.startsWith('{') || trimmed.startsWith('billing_') || trimmed.startsWith('razorpay_')) {
      return 'Something went wrong. Please try again later.';
    }
    return trimmed || 'Something went wrong. Please try again later.';
  }

  // Common backend error codes
  switch (code) {
    case 'billing_provider_missing':
      return 'Billing is not set up for Razorpay on this coaching center.';
    case 'subscription_missing':
      return 'No active subscription found to update. Please start checkout again.';
    case 'manage_link_unavailable':
      return 'Razorpay link is temporarily unavailable. Please try again later.';
    case 'billing_manage_link_failed':
      return 'Unable to fetch Razorpay link right now. Please try again later.';
    case 'tenant_mismatch':
      return 'Please retry after selecting the correct coaching center.';
    case 'validation_failed':
      return 'Please try again. If this keeps happening, contact support.';
    default:
      break;
  }

  // Generic HTTP wrapper errors from billingService
  if (code === 'billing_request_failed_401') return 'Your session expired. Please sign in again.';
  if (code === 'billing_request_failed_403') {
    return 'You do not have permission to manage billing for this coaching center.';
  }
  if (code === 'billing_request_failed_404') return 'Link unavailable. Please try again later.';
  if (code === 'billing_request_failed_409') return 'Billing action unavailable right now. Please try again later.';
  if (code.startsWith('billing_request_failed_')) return 'Something went wrong. Please try again later.';

  // Avoid surfacing unknown internal codes.
  if (code.startsWith('billing_') || code.startsWith('razorpay_')) {
    return 'Something went wrong. Please try again later.';
  }
  return code;
}

function mbToBytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

type PlanTierDisplay = React.ComponentProps<typeof PlanTierCard>['plan'];

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function variantToPlanTierDisplay(variant: BillingCatalogPlanVariant): PlanTierDisplay {
  const limits = variant.limits;
  const staffSeats = toFiniteNumber(limits?.staffSeats) ?? 0;
  const students = toFiniteNumber(limits?.students) ?? 0;
  const storageMb = toFiniteNumber(limits?.storageMb) ?? 0;

  const remindersTotal = toFiniteNumber(limits?.reminders?.total) ?? 0;
  const remindersWhatsapp = toFiniteNumber(limits?.reminders?.whatsapp) ?? 0;
  const remindersSms = toFiniteNumber(limits?.reminders?.sms) ?? 0;
  const remindersVoice = toFiniteNumber(limits?.reminders?.voice) ?? 0;
  const remindersEmail = toFiniteNumber(limits?.reminders?.email) ?? 0;

  return {
    id: variant.planId,
    label: variant.displayName,
    monthlyPriceInr: toFiniteNumber(variant.priceInr),
    staffSeats,
    students,
    reminders: {
      total: remindersTotal,
      whatsapp: remindersWhatsapp,
      sms: remindersSms,
      voice: remindersVoice,
      email: remindersEmail,
    },
    storageBytes: mbToBytes(storageMb),
  };
}

function limitsToPlanTierDisplay(options: {
  limits: any;
  label: string;
  monthlyPriceInr: number | null;
}): PlanTierDisplay {
  const limits = options.limits;
  const id = (limits?.id === 'free' || limits?.id === 'pro' || limits?.id === 'enterprise' ? limits.id : 'free') as PlanTierDisplay['id'];
  return {
    id,
    label: options.label,
    monthlyPriceInr: options.monthlyPriceInr,
    staffSeats: typeof limits?.staffSeats === 'number' ? limits.staffSeats : 0,
    students: typeof limits?.students === 'number' ? limits.students : 0,
    reminders: {
      total: typeof limits?.reminders?.total === 'number' ? limits.reminders.total : 0,
      whatsapp: typeof limits?.reminders?.whatsapp === 'number' ? limits.reminders.whatsapp : 0,
      sms: typeof limits?.reminders?.sms === 'number' ? limits.reminders.sms : 0,
      voice: typeof limits?.reminders?.voice === 'number' ? limits.reminders.voice : 0,
      email: typeof limits?.reminders?.email === 'number' ? limits.reminders.email : 0,
    },
    storageBytes: typeof limits?.storageBytes === 'number' ? limits.storageBytes : 0,
  };
}

export default function PlanAndBillingScreen() {
  const router = useRouter();
  const { theme } = useTheme();
  const { activeTenant, activeMembership, loading: tenantLoading } = useTenant();
  const {
    usageSummary,
    loading: usageSummaryLoading,
    error: usageSummaryError,
    refresh: refreshUsageSummary,
  } = useTenantUsageSummary(activeTenant?.id ?? null);

  const [switchToFreeModalVisible, setSwitchToFreeModalVisible] = useState(false);
  const [switchToFreeModalTitle, setSwitchToFreeModalTitle] = useState('');
  const [switchToFreeModalMessage, setSwitchToFreeModalMessage] = useState('');
  const [switchToFreeModalShowCancel, setSwitchToFreeModalShowCancel] = useState(false);
  const [switchToFreeModalConfirmText, setSwitchToFreeModalConfirmText] = useState('OK');
  const [switchToFreeModalConfirmStyle, setSwitchToFreeModalConfirmStyle] = useState<'default' | 'destructive' | 'primary'>(
    'primary'
  );
  const [switchToFreeModalStatusMessage, setSwitchToFreeModalStatusMessage] = useState<string | null>(null);
  const [switchToFreeModalStatusType, setSwitchToFreeModalStatusType] = useState<'neutral' | 'error' | 'success'>('neutral');
  const [switchToFreeModalConfirmLoading, setSwitchToFreeModalConfirmLoading] = useState(false);
  const [switchToFreeModalOnConfirm, setSwitchToFreeModalOnConfirm] = useState<(() => void) | undefined>(undefined);

  const [checkoutConflictModalVisible, setCheckoutConflictModalVisible] = useState(false);
  const [checkoutConflictModalMessage, setCheckoutConflictModalMessage] = useState('');
  const [checkoutConflictModalCheckoutUrl, setCheckoutConflictModalCheckoutUrl] = useState<string | null>(null);
  const [checkoutConflictModalLoading, setCheckoutConflictModalLoading] = useState(false);
  const [checkoutConflictModalStatusMessage, setCheckoutConflictModalStatusMessage] = useState<string | null>(null);
  const [checkoutConflictModalStatusType, setCheckoutConflictModalStatusType] = useState<'neutral' | 'error' | 'success'>(
    'neutral'
  );

  const [billingAlertModalVisible, setBillingAlertModalVisible] = useState(false);
  const [billingAlertModalTitle, setBillingAlertModalTitle] = useState('');
  const [billingAlertModalMessage, setBillingAlertModalMessage] = useState('');
  const [billingAlertModalStyle, setBillingAlertModalStyle] = useState<'default' | 'destructive' | 'primary'>('primary');

  const openBillingAlertModal = useCallback(
    (title: string, message: string, style: 'default' | 'destructive' | 'primary' = 'primary') => {
      setBillingAlertModalTitle(title);
      setBillingAlertModalMessage(message);
      setBillingAlertModalStyle(style);
      setBillingAlertModalVisible(true);
    },
    []
  );

  // Only animate on web. On native, keep it fully visible to avoid distracting transitions.
  const openAnim = useRef(new Animated.Value(Platform.OS === 'web' ? 0 : 1));

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'web') {
        return;
      }
      openAnim.current.stopAnimation();
      openAnim.current.setValue(0);

      const animation = Animated.timing(openAnim.current, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      });

      animation.start();
      return () => {
        openAnim.current.stopAnimation();
      };
    }, [])
  );

  const openStyle = useMemo(
    () => ({
      opacity: openAnim.current,
      transform: [
        {
          translateY: openAnim.current.interpolate({
            inputRange: [0, 1],
            outputRange: [18, 0],
          }),
        },
      ],
    }),
    []
  );

  const billingReturnUrl = useMemo(() => {
    try {
      return ExpoLinking.createURL('billing/return');
    } catch {
      return null;
    }
  }, []);

  const [catalogPlans, setCatalogPlans] = useState<BillingCatalogPlanVariant[] | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [currentBillingVariantId, setCurrentBillingVariantId] = useState<string | null>(null);
  const [currentBilling, setCurrentBilling] = useState<BillingCurrentResponse | null>(null);
  const [latestBillingChange, setLatestBillingChange] = useState<BillingHistoryChange | null>(null);
  const [loadingLatestBillingChange, setLoadingLatestBillingChange] = useState(false);
  const [checkoutVariantBusy, setCheckoutVariantBusy] = useState<string | null>(null);

  const tenantUnavailable = !tenantLoading && !activeTenant?.id;

  // usageSummary.planLimits is the authoritative effective limits (incl. admin console overrides).
  // Avoid briefly showing fallback catalog values before this finishes loading.
  const shouldShowPlanLimitsLoading = useMemo(() => {
    if (!activeTenant?.id) return false;
    if (usageSummary?.planLimits) return false;
    if (usageSummaryError) return false;
    return usageSummaryLoading || usageSummary === null;
  }, [activeTenant?.id, usageSummaryError, usageSummaryLoading, usageSummary]);

  const effectivePlanLimits = useMemo(() => {
    return usageSummary?.planLimits ?? null;
  }, [usageSummary?.planLimits]);

  const effectivePlanId =
    effectivePlanLimits?.id ??
    currentBilling?.planId ??
    (activeTenant?.billingTier ?? 'free');

  const currentPlanDisplay = useMemo(() => {
    const variantId = (currentBillingVariantId || '').trim();
    const catalog = catalogPlans || [];
    if (variantId) {
      const match = catalog.find((entry) => entry.id === variantId);
      if (match) {
        const priceInr = typeof match.priceInr === 'number' && Number.isFinite(match.priceInr) ? match.priceInr : null;
        if (usageSummary?.planLimits) {
          return limitsToPlanTierDisplay({
            limits: usageSummary.planLimits,
            label: match.displayName,
            monthlyPriceInr: priceInr,
          });
        }
        const base = variantToPlanTierDisplay(match);
        return { ...base, monthlyPriceInr: priceInr };
      }
    }

    if (effectivePlanLimits) {
      // Hide price unless we know the exact variant.
      const hidePrice = effectivePlanId === 'pro' || effectivePlanId === 'enterprise';
      return limitsToPlanTierDisplay({
        limits: effectivePlanLimits,
        label: effectivePlanLimits.label || (effectivePlanId === 'free' ? 'Free' : effectivePlanId === 'pro' ? 'Pro' : 'Enterprise'),
        monthlyPriceInr: hidePrice ? null : (typeof effectivePlanLimits.monthlyPriceInr === 'number' ? effectivePlanLimits.monthlyPriceInr : null),
      });
    }

    // Last resort: show something stable while still avoiding local plan constants.
    return {
      id: (currentBilling?.planId === 'pro' || currentBilling?.planId === 'enterprise' ? currentBilling.planId : 'free') as PlanTierDisplay['id'],
      label: currentBilling?.planId === 'pro' ? 'Pro' : currentBilling?.planId === 'enterprise' ? 'Enterprise' : 'Free',
      monthlyPriceInr: null,
      staffSeats: 0,
      students: 0,
      reminders: { total: 0, whatsapp: 0, sms: 0, voice: 0, email: 0 },
      storageBytes: 0,
    };
  }, [catalogPlans, currentBilling?.planId, currentBillingVariantId, effectivePlanLimits, usageSummary?.planLimits]);

  const canManageBilling = useMemo(() => {
    const role = activeMembership?.role ?? 'member';
    return role === 'owner' || role === 'admin';
  }, [activeMembership?.role]);

  useEffect(() => {
    if (!activeTenant?.id) {
      return;
    }
    let cancelled = false;
    setCatalogLoading(true);

    Promise.all([
      billingService.getCatalog().catch(() => null),
      billingService.getCurrentBilling(activeTenant.id).catch(() => null),
    ])
      .then(([catalog, currentBilling]) => {
        if (cancelled) return;
        setCatalogPlans(Array.isArray(catalog?.plans) ? catalog!.plans : null);
        setCurrentBilling(currentBilling || null);
        setCurrentBillingVariantId(
          typeof currentBilling?.planVariantId === 'string' && currentBilling.planVariantId.trim()
            ? currentBilling.planVariantId.trim()
            : null
        );
      })
      .finally(() => {
        if (cancelled) return;
        setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTenant?.id]);

  const proVariants = useMemo(() => {
    const source = catalogPlans || [];
    return source
      .filter((entry) => entry && entry.active && entry.planId === 'pro')
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  }, [catalogPlans]);

  const freeVariant = useMemo(() => {
    const source = catalogPlans || [];
    return source.find((entry) => entry && entry.active && (entry.id === 'free' || entry.planId === 'free')) || null;
  }, [catalogPlans]);

  const freePlanDisplay = useMemo<PlanTierDisplay>(() => {
    if (freeVariant) {
      const base = variantToPlanTierDisplay(freeVariant);
      return {
        ...base,
        monthlyPriceInr: typeof freeVariant.priceInr === 'number' && Number.isFinite(freeVariant.priceInr) ? freeVariant.priceInr : 0,
      };
    }

    // Catalog missing free plan: render a stable placeholder.
    return {
      id: 'free',
      label: 'Free',
      monthlyPriceInr: 0,
      staffSeats: 0,
      students: 0,
      reminders: { total: 0, whatsapp: 0, sms: 0, voice: 0, email: 0 },
      storageBytes: 0,
    };
  }, [freeVariant]);

  const billingStatusLabel = useMemo(() => {
    const status = currentBilling?.status;
    if (currentBilling?.checkoutRequired) return 'Pending';
    if (status === 'active') return 'Active';
    if (status === 'trial') return currentBilling?.planId === 'free' ? 'Free' : 'Pending';
    if (status === 'delinquent') return 'Payment overdue';
    if (status === 'canceled') return 'Canceled';
    return null;
  }, [currentBilling?.status, currentBilling?.planId, currentBilling?.checkoutRequired]);

  const renewalDisplay = useMemo(() => {
    return formatBillingDate(currentBilling?.renewalDate);
  }, [currentBilling?.renewalDate]);

  const pendingSinceDisplay = useMemo(() => {
    return formatBillingDate(currentBilling?.checkoutRequiredSince);
  }, [currentBilling?.checkoutRequiredSince]);

  const isDelinquent = currentBilling?.status === 'delinquent';
  const isPendingPaid = currentBilling?.checkoutRequired === true || (currentBilling?.status === 'trial' && currentBilling?.planId !== 'free');
  const isAwaitingAutopayConfirmation =
    (currentBilling?.checkoutRequired === true && (currentBilling?.checkoutRequiredProvider || '').toLowerCase() === 'razorpay_autopay') ||
    (currentBilling?.status === 'trial' && currentBilling?.planId !== 'free' && currentBilling?.checkoutRequired !== true);
  const isRazorpayCheckoutRequired =
    currentBilling?.checkoutRequired === true && (currentBilling?.checkoutRequiredProvider || '').toLowerCase() === 'razorpay';

  const subscriptionProvider = (currentBilling?.subscriptionProvider || '').toLowerCase();
  const isGooglePlaySubscriptionProvider = subscriptionProvider === 'google_play';
  const isRazorpaySubscriptionProvider = subscriptionProvider === 'razorpay';

  const currentVariantPlayProductId = useMemo(() => {
    const variantId = (currentBillingVariantId || '').trim();
    if (!variantId) return '';
    const variant = (catalogPlans || []).find((v) => v && v.id === variantId) || null;
    return (variant?.playProductId || '').trim();
  }, [catalogPlans, currentBillingVariantId]);

  // Backward-compatible inference:
  // - If backend sends subscriptionProvider, trust it.
  // - Otherwise, on Android treat a configured Play product id as Play-managed.
  const inferredGooglePlay = Platform.OS === 'android' && Boolean(currentVariantPlayProductId);
  const isGooglePlayManaged = subscriptionProvider ? isGooglePlaySubscriptionProvider : inferredGooglePlay;
  const isAndroidGooglePlayBilling = Platform.OS === 'android' && isGooglePlayManaged;

  // Cross-surface management rules:
  // - Razorpay subscription started on website -> must be managed on website (when in Android app).
  // - Google Play subscription -> must be managed from mobile app/Play (when on website).
  const requiresWebsiteForSubscriptionManagement =
    Platform.OS === 'android' && isRazorpaySubscriptionProvider && currentBilling?.planId !== 'free';
  const requiresAppForSubscriptionManagement =
    Platform.OS === 'web' && isGooglePlayManaged && currentBilling?.planId !== 'free';
  const isSubscriptionManagementBlocked = requiresWebsiteForSubscriptionManagement || requiresAppForSubscriptionManagement;

  const canUpdatePaymentMethod =
    !isSubscriptionManagementBlocked &&
    !isAndroidGooglePlayBilling &&
    !isAwaitingAutopayConfirmation &&
    (isDelinquent || isRazorpayCheckoutRequired);
  const isCheckoutBusy = !!checkoutVariantBusy;
  const downgradeToFreeScheduled =
    currentBilling?.planId !== 'free' && currentBilling?.cancelAtCycleEnd === true && currentBilling?.scheduledDowngradePlanId === 'free';

  const scheduledDowngradeDisplay = useMemo(() => {
    if (!downgradeToFreeScheduled) return null;
    return formatBillingDate(currentBilling?.scheduledDowngradeAt || currentBilling?.renewalDate || undefined);
  }, [downgradeToFreeScheduled, currentBilling?.scheduledDowngradeAt, currentBilling?.renewalDate]);

  const endOfCycleDisplay = useMemo(() => {
    return formatBillingDate(currentBilling?.renewalDate);
  }, [currentBilling?.renewalDate]);

  const refreshBilling = useCallback(async () => {
    if (!activeTenant?.id) return;
    try {
      const current = await billingService.getCurrentBilling(activeTenant.id);
      setCurrentBilling(current || null);
      setCurrentBillingVariantId(
        typeof current?.planVariantId === 'string' && current.planVariantId.trim() ? current.planVariantId.trim() : null
      );
    } catch {
      // ignore
    }
  }, [activeTenant?.id]);

  const refreshLatestBillingChange = useCallback(async () => {
    if (!activeTenant?.id) return;
    if (!canManageBilling) return;
    setLoadingLatestBillingChange(true);
    try {
      billingService.invalidateLatestBillingChangeCache({ tenantId: activeTenant.id });
      const entry = await billingService.getLatestBillingChange(activeTenant.id);
      setLatestBillingChange(entry);
    } catch {
      setLatestBillingChange(null);
    } finally {
      setLoadingLatestBillingChange(false);
    }
  }, [activeTenant?.id, canManageBilling]);

  const handleRefreshBillingStatus = useCallback(() => {
    if (!activeTenant?.id) {
      openBillingAlertModal('Missing tenant', 'Please select a coaching center first.');
      return;
    }
    void (async () => {
      try {
        await Promise.all([refreshBilling(), refreshUsageSummary(), refreshLatestBillingChange()]);
      } catch {
        // Ignore: individual refresh functions already fail softly.
      }
    })();
  }, [activeTenant?.id, openBillingAlertModal, refreshBilling, refreshLatestBillingChange, refreshUsageSummary]);

  const handleManageGooglePlaySubscription = useCallback(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const pkg = (Application.applicationId || '').trim();
    const sku = (currentVariantPlayProductId || '').trim();
    if (!pkg) {
      openBillingAlertModal('Google Play unavailable', 'Unable to open Google Play subscription settings on this device.');
      return;
    }

    // Prefer the Play web URL (works broadly); include sku when known.
    const url = `https://play.google.com/store/account/subscriptions?package=${encodeURIComponent(pkg)}${
      sku ? `&sku=${encodeURIComponent(sku)}` : ''
    }`;

    void (async () => {
      try {
        const canOpen = await Linking.canOpenURL(url);
        if (!canOpen) {
          openBillingAlertModal('Cannot open Google Play', url, 'default');
          return;
        }
        await Linking.openURL(url);
      } catch (error: any) {
        const rawMessage = typeof error?.message === 'string' ? error.message : '';
        openBillingAlertModal('Cannot open Google Play', rawMessage || url, 'default');
      }
    })();
  }, [currentVariantPlayProductId, openBillingAlertModal]);

  // After returning from an external checkout (Razorpay), refresh billing + usage so the UI upgrades immediately.
  useFocusEffect(
    useCallback(() => {
      if (!activeTenant?.id) {
        return;
      }
      refreshBilling();
      refreshUsageSummary();
      refreshLatestBillingChange();
    }, [activeTenant?.id, refreshBilling, refreshLatestBillingChange, refreshUsageSummary])
  );

  useEffect(() => {
    if (!activeTenant?.id) return;
    if (!canManageBilling) {
      setLatestBillingChange(null);
      return;
    }
    // Focus effect already refreshes; only fetch here if we don't have it yet.
    if (!latestBillingChange) {
      refreshLatestBillingChange();
    }
  }, [activeTenant?.id, canManageBilling, latestBillingChange, refreshLatestBillingChange]);

  const latestBillingChangeText = useMemo(() => {
    if (!latestBillingChange) return null;
    const desc = describeLatestBillingChange(latestBillingChange);
    return [desc.title, desc.subtitle].filter(Boolean).join(' • ');
  }, [latestBillingChange]);

  const handleUpgradePress = useCallback(async (planVariantId: string) => {
    if (effectivePlanId === 'enterprise') {
      openBillingAlertModal('Managed plan', 'Enterprise plans are managed by your administrator.');
      return;
    }
    if (!canManageBilling) {
      openBillingAlertModal('Not allowed', 'Only Owner/Admin can manage billing for this coaching center.');
      return;
    }
    if (!activeTenant?.id) {
      openBillingAlertModal('Missing tenant', 'Please select a coaching center first.');
      return;
    }

    if (requiresWebsiteForSubscriptionManagement) {
      openBillingAlertModal(
        'Manage on website',
        'This subscription was purchased on the website using Razorpay. Please manage plan changes (cancel, update payment method, change plan) from the website.'
      );
      return;
    }

    if (requiresAppForSubscriptionManagement) {
      openBillingAlertModal(
        'Manage in mobile app',
        'This subscription is managed by Google Play. Please use the mobile app / Google Play to change or cancel the plan, or update the payment method.'
      );
      return;
    }

    if (isCheckoutBusy) {
      return;
    }

    try {
      setCheckoutVariantBusy(planVariantId);

      // Android: use Google Play Billing when configured.
      if (Platform.OS === 'android') {
        const variant = (catalogPlans || []).find((v) => v.id === planVariantId) || null;
        const productId = (variant?.playProductId || '').trim();
        if (!productId) {
          openBillingAlertModal(
            'Google Play not configured',
            'This plan does not have a Google Play product id configured yet. Please contact support to enable Google Play Billing.'
          );
          return;
        }

        const purchase = await purchaseGooglePlaySubscription(productId);
        try {
          await billingService.verifyGooglePlayPurchase({
            tenantId: activeTenant.id,
            planVariantId,
            productId: purchase.productId,
            purchaseToken: purchase.purchaseToken,
            ...(purchase.orderId ? { orderId: purchase.orderId } : {}),
          });
        } catch (error: any) {
          const rawMessage = typeof error?.message === 'string' ? error.message : '';
          const parsed = parseJsonMessage(rawMessage);
          const code = typeof parsed?.error === 'string' ? parsed.error : '';
          if (code === 'purchase_pending') {
            openBillingAlertModal(
              'Payment pending',
              'Google Play has not confirmed the payment yet. This can happen if the bank/payment method delays or rejects the recurring charge.\n\nPlease wait and check your Google Play subscription/payment method, then refresh billing.'
            );
            await refreshBilling();
            await refreshUsageSummary();
            return;
          }
          throw error;
        }

        // Best-effort local cleanup.
        void finishGooglePlayTransactionSafe({ productId: purchase.productId, purchaseToken: purchase.purchaseToken });

        await new Promise((resolve) => setTimeout(resolve, 800));
        await refreshBilling();
        await refreshUsageSummary();
        return;
      }

      const response = await billingService.startRazorpayCheckout({
        tenantId: activeTenant.id,
        planVariantId,
        ...(billingReturnUrl ? { successUrl: billingReturnUrl, cancelUrl: billingReturnUrl } : {}),
      });
      if (!response?.checkoutUrl) {
        throw new Error('missing_checkout_url');
      }

      // Web: navigate in the same tab (best for local-web testing).
      if (Platform.OS === 'web') {
        try {
          if (typeof window !== 'undefined' && window?.location) {
            window.location.href = response.checkoutUrl;
            return;
          }
        } catch {
          // ignore and fall through
        }
      }

      // Prefer an in-app browser so the user can reliably return to the app.
      // (Razorpay hosted checkout does not always deep-link back automatically.)
      try {
        if (billingReturnUrl) {
          await WebBrowser.openAuthSessionAsync(response.checkoutUrl, billingReturnUrl);
        } else {
          await WebBrowser.openBrowserAsync(response.checkoutUrl);
        }
      } catch {
        const canOpen = await Linking.canOpenURL(response.checkoutUrl);
        if (!canOpen) {
          openBillingAlertModal('Cannot open checkout', response.checkoutUrl, 'default');
          return;
        }
        await Linking.openURL(response.checkoutUrl);
      }

      // Once the browser is dismissed, refresh state so the UI upgrades quickly after webhook processing.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await refreshBilling();
      await refreshUsageSummary();
    } catch (error: any) {
      const rawMessage = typeof error?.message === 'string' ? error.message : '';
      const parsed = parseJsonMessage(rawMessage);
      const code = typeof parsed?.error === 'string' ? parsed.error : '';

      if (code === 'billing_checkout_in_progress') {
        const checkoutUrl = typeof parsed.checkoutUrl === 'string' ? parsed.checkoutUrl : '';
        const startedByEmail = typeof parsed.startedByEmail === 'string' ? parsed.startedByEmail : '';
        const baseText = 'Another payment process is already going on for this coaching center. Please wait for it to complete.';
        const detail = startedByEmail ? `\n\nStarted by: ${startedByEmail}` : '';

        setCheckoutConflictModalMessage(`${baseText}${detail}`);
        setCheckoutConflictModalCheckoutUrl(checkoutUrl || null);
        setCheckoutConflictModalLoading(false);
        setCheckoutConflictModalStatusMessage(null);
        setCheckoutConflictModalStatusType('neutral');
        setCheckoutConflictModalVisible(true);
        return;
      }

      if (code === 'billing_catalog_unconfigured') {
        openBillingAlertModal(
          'Plans not configured',
          'Paid plans are not configured yet. Please contact support to enable billing plans for your account.'
        );
        return;
      }

      if (code === 'razorpay_unconfigured') {
        openBillingAlertModal(
          'Payment not available',
          'Razorpay is not configured for this project yet. Please try again later.'
        );
        return;
      }

      if (code === 'plan_variant_required') {
        openBillingAlertModal('Select a plan', 'Please select a Pro plan variant to continue.');
        return;
      }

      if (code === 'invalid_plan_variant') {
        openBillingAlertModal('Plan unavailable', 'That plan variant is not available right now. Please choose another plan.');
        return;
      }

      openBillingAlertModal('Checkout failed', toFriendlyBillingErrorMessage(rawMessage), 'default');
    } finally {
      setCheckoutVariantBusy(null);
    }
  }, [activeTenant?.id, billingReturnUrl, canManageBilling, catalogPlans, effectivePlanId, isCheckoutBusy, openBillingAlertModal, refreshBilling, refreshUsageSummary]);

  const handleSwitchToFree = useCallback(() => {
    const openInfoModal = (title: string, message: string) => {
      setSwitchToFreeModalTitle(title);
      setSwitchToFreeModalMessage(message);
      setSwitchToFreeModalShowCancel(false);
      setSwitchToFreeModalConfirmText('OK');
      setSwitchToFreeModalConfirmStyle('primary');
      setSwitchToFreeModalStatusMessage(null);
      setSwitchToFreeModalStatusType('neutral');
      setSwitchToFreeModalConfirmLoading(false);
      setSwitchToFreeModalOnConfirm(undefined);
      setSwitchToFreeModalVisible(true);
    };

    if (!canManageBilling) {
      openInfoModal('Not allowed', 'Only Owner/Admin can manage billing for this coaching center.');
      return;
    }
    if (!activeTenant?.id) {
      openInfoModal('Missing tenant', 'Please select a coaching center first.');
      return;
    }
    if (isCheckoutBusy) {
      return;
    }

    if (requiresWebsiteForSubscriptionManagement) {
      openInfoModal(
        'Manage on website',
        'This subscription was purchased on the website using Razorpay. Please cancel or change the subscription from the website.'
      );
      return;
    }

    if (requiresAppForSubscriptionManagement) {
      openInfoModal(
        'Manage in mobile app',
        'This subscription is managed by Google Play. Please use the mobile app / Google Play to cancel or change the subscription.'
      );
      return;
    }

    if (downgradeToFreeScheduled) {
      const when = scheduledDowngradeDisplay ? ` on ${scheduledDowngradeDisplay}` : '';
      openInfoModal('Downgrade already scheduled', `This coaching center will switch to Free${when}.`);
      return;
    }

    if (isAndroidGooglePlayBilling) {
      setSwitchToFreeModalTitle('Cancel in Google Play');
      setSwitchToFreeModalMessage(
        'This subscription is managed by Google Play.\n\nTo cancel at the end of the current period (no more renewals), open Google Play and cancel the subscription there. Then return to the app and refresh billing.'
      );
      setSwitchToFreeModalShowCancel(true);
      setSwitchToFreeModalConfirmText('Open Google Play');
      setSwitchToFreeModalConfirmStyle('primary');
      setSwitchToFreeModalStatusMessage(null);
      setSwitchToFreeModalStatusType('neutral');
      setSwitchToFreeModalConfirmLoading(false);
      const onConfirm = () => {
        setSwitchToFreeModalVisible(false);
        handleManageGooglePlaySubscription();
      };
      setSwitchToFreeModalOnConfirm(() => onConfirm);
      setSwitchToFreeModalVisible(true);
      return;
    }

    const whenText = endOfCycleDisplay
      ? `You will stay on your current plan until ${endOfCycleDisplay}, and then switch to Free.`
      : 'You will stay on your current plan until the end of the current billing cycle, and then switch to Free.';

    setSwitchToFreeModalTitle('Switch to Free?');
    setSwitchToFreeModalMessage(`${whenText}\n\nYou will not be charged again.`);
    setSwitchToFreeModalShowCancel(true);
    setSwitchToFreeModalConfirmText('Switch to Free');
    setSwitchToFreeModalConfirmStyle('destructive');
    setSwitchToFreeModalStatusMessage(null);
    setSwitchToFreeModalStatusType('neutral');
    setSwitchToFreeModalConfirmLoading(false);
    const onConfirm = () => {
      void (async () => {
        try {
          setSwitchToFreeModalConfirmLoading(true);
          setSwitchToFreeModalStatusMessage(null);
          setSwitchToFreeModalStatusType('neutral');
          setCheckoutVariantBusy('free');
          await billingService.switchToFree({ tenantId: activeTenant.id });
          await Promise.all([refreshBilling(), refreshUsageSummary(), refreshLatestBillingChange()]);
          setSwitchToFreeModalVisible(false);
        } catch (error: any) {
          const rawMessage = typeof error?.message === 'string' ? error.message : '';
          const parsed = parseJsonMessage(rawMessage);
          const code = typeof parsed?.error === 'string' ? parsed.error : '';
          setSwitchToFreeModalStatusType('error');
          if (code === 'razorpay_cancel_failed') {
            setSwitchToFreeModalStatusMessage('We could not cancel your subscription right now. Please try again later.');
            return;
          }
          setSwitchToFreeModalStatusMessage(toFriendlyBillingErrorMessage(rawMessage) || 'Unable to switch to Free');
        } finally {
          setCheckoutVariantBusy(null);
          setSwitchToFreeModalConfirmLoading(false);
        }
      })();
    };
    setSwitchToFreeModalOnConfirm(() => onConfirm);
    setSwitchToFreeModalVisible(true);
  }, [activeTenant?.id, canManageBilling, handleManageGooglePlaySubscription, isAndroidGooglePlayBilling, isCheckoutBusy, downgradeToFreeScheduled, endOfCycleDisplay, refreshBilling, refreshLatestBillingChange, refreshUsageSummary, scheduledDowngradeDisplay]);

  const openExternalBillingUrl = useCallback(
    async (url: string) => {
      const cleaned = (url || '').trim();
      if (!cleaned) {
        throw new Error('missing_url');
      }

      try {
        if (billingReturnUrl) {
          await WebBrowser.openAuthSessionAsync(cleaned, billingReturnUrl);
        } else {
          await WebBrowser.openBrowserAsync(cleaned);
        }
      } catch {
        const canOpen = await Linking.canOpenURL(cleaned);
        if (!canOpen) {
          throw new Error(cleaned);
        }
        await Linking.openURL(cleaned);
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
      await Promise.all([refreshBilling(), refreshUsageSummary(), refreshLatestBillingChange()]);
    },
    [billingReturnUrl, refreshBilling, refreshLatestBillingChange, refreshUsageSummary]
  );

  const handleUpdatePaymentMethod = useCallback(() => {
    if (effectivePlanId === 'enterprise') {
      openBillingAlertModal('Managed plan', 'Enterprise plans are managed by your administrator.');
      return;
    }
    if (!canManageBilling) {
      openBillingAlertModal('Not allowed', 'Only Owner/Admin can manage billing for this coaching center.');
      return;
    }
    if (!activeTenant?.id) {
      openBillingAlertModal('Missing tenant', 'Please select a coaching center first.');
      return;
    }

    if (requiresWebsiteForSubscriptionManagement) {
      openBillingAlertModal(
        'Manage on website',
        'This subscription was purchased on the website using Razorpay. Please update the payment method from the website.'
      );
      return;
    }

    if (requiresAppForSubscriptionManagement) {
      openBillingAlertModal(
        'Manage in mobile app',
        'This subscription is managed by Google Play. Please update the payment method in Google Play (via the mobile app), then refresh billing.'
      );
      return;
    }

    void (async () => {
      try {
        const response = await billingService.getManageLink(activeTenant.id);
        const url = (response?.url || '').trim();
        if (!url) {
          openBillingAlertModal('Link unavailable', 'Unable to open Razorpay right now. Please try again later.');
          return;
        }

        await openExternalBillingUrl(url);
      } catch (error: any) {
        const rawMessage = typeof error?.message === 'string' ? error.message : '';
        openBillingAlertModal('Update payment method failed', toFriendlyBillingErrorMessage(rawMessage), 'default');
      }
    })();
  }, [activeTenant?.id, canManageBilling, effectivePlanId, openBillingAlertModal, openExternalBillingUrl]);


  if (tenantUnavailable) {
    const handleClose = () => {
      const last = getLastInAppRoute();
      if (last) {
        router.replace(last as any);
        return;
      }
      // Fallback
      const anyRouter: any = router as any;
      if (typeof anyRouter?.canGoBack === 'function' && anyRouter.canGoBack()) {
        router.back();
        return;
      }
      router.replace('/(tabs)');
    };
    return (
      <Animated.View style={[styles.container, { backgroundColor: theme.background }, openStyle]}>
        <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
          <TouchableOpacity onPress={handleClose} style={styles.backButton}>
            <X size={22} color={theme.text} />
          </TouchableOpacity>
          <Text style={[styles.title, { color: theme.text }]}>Plan & Billing</Text>
          <View style={styles.backButton} />
        </View>
        <TenantSelectionEmptyState />
      </Animated.View>
    );
  }

  const handleClose = () => {
    const last = getLastInAppRoute();
    if (last) {
      router.replace(last as any);
      return;
    }
    const anyRouter: any = router as any;
    if (typeof anyRouter?.canGoBack === 'function' && anyRouter.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/(tabs)');
  };

  const shouldShowCancelSubscriptionActions =
    canManageBilling &&
    !isSubscriptionManagementBlocked &&
    !isAwaitingAutopayConfirmation &&
    !isPendingPaid &&
    !isDelinquent &&
    currentBilling?.status === 'active' &&
    !downgradeToFreeScheduled &&
    currentPlanDisplay.id !== 'free' &&
    currentPlanDisplay.id !== 'enterprise';

  return (
    <Animated.View style={[styles.container, { backgroundColor: theme.background }, openStyle]}>
      <View style={[styles.header, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={handleClose} style={styles.backButton}>
          <X size={22} color={theme.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: theme.text }]}>Plan & Billing</Text>
        {canManageBilling ? (
          <TouchableOpacity
            onPress={() => router.push('/(tabs)/billing-history')}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Billing history"
          >
            <History size={20} color={theme.text} />
          </TouchableOpacity>
        ) : (
          <View style={styles.backButton} />
        )}
      </View>

      {isDelinquent ? (
        <View style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
          <Text style={[styles.bannerTitle, { color: theme.text }]}>Payment overdue</Text>
          <Text style={[styles.bannerText, { color: theme.textSecondary }]}>
            {isAndroidGooglePlayBilling
              ? 'Open Google Play to update your subscription/payment method and clear dues.'
              : 'Update your payment method to clear dues and continue using paid features.'}
          </Text>
        </View>
      ) : null}

      {isPendingPaid ? (
        <View style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}> 
          <Text style={[styles.bannerTitle, { color: theme.text }]}>Payment pending</Text>
          <Text style={[styles.bannerText, { color: theme.textSecondary }]}>
            {isAndroidGooglePlayBilling
              ? 'Your Google Play payment is still pending. Please check your subscription/payment method in Google Play, then refresh billing.'
              : isAwaitingAutopayConfirmation
                ? 'Your UPI Autopay mandate is authenticated. The charge can take some time to confirm. Please wait and refresh billing to activate the plan once it’s confirmed.'
                : isRazorpayCheckoutRequired
                  ? 'Your payment is still open. You can update your payment method to retry.'
                  : 'Your payment is still open. Please refresh billing status.'}
          </Text>
          {pendingSinceDisplay ? (
            <Text style={[styles.bannerText, { color: theme.textSecondary }]}>Pending since {pendingSinceDisplay}.</Text>
          ) : null}
        </View>
      ) : null}

      {requiresWebsiteForSubscriptionManagement ? (
        <View style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border, marginBottom: 12 }]}>
          <Text style={[styles.bannerTitle, { color: theme.text }]}>Manage on website</Text>
          <Text style={[styles.bannerText, { color: theme.textSecondary }]}>This subscription was purchased via Razorpay on the website. Please manage plan changes from the website.</Text>
        </View>
      ) : null}

      {requiresAppForSubscriptionManagement ? (
        <View style={[styles.banner, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.bannerTitle, { color: theme.text }]}>Manage in mobile app</Text>
          <Text style={[styles.bannerText, { color: theme.textSecondary }]}>This subscription is managed by Google Play. Please manage plan changes from the mobile app / Google Play.</Text>
        </View>
      ) : null}

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>CURRENT</Text>
          {shouldShowPlanLimitsLoading ? (
            <View
              style={[
                styles.cardPlaceholder,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                },
              ]}
            >
              <View style={styles.loadingRow}>
                <ActivityIndicator />
                <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading plan limits…</Text>
              </View>
            </View>
          ) : (
            <PlanTierCard plan={currentPlanDisplay} isCurrent />
          )}

          {!shouldShowPlanLimitsLoading ? (
            <View
              style={[
                styles.billingCard,
                {
                  backgroundColor: theme.surface,
                  borderColor: theme.border,
                },
              ]}
            >
              <View style={styles.billingHeaderRow}>
                <Text style={[styles.billingHeaderTitle, { color: theme.text }]}>Billing status</Text>
                {(() => {
                  const status = currentBilling?.status;
                  const label =
                    billingStatusLabel ||
                    (effectivePlanId === 'free' ? 'Free' : effectivePlanId === 'enterprise' ? 'Managed' : 'Unknown');
                  const color =
                    status === 'active'
                      ? theme.success
                      : status === 'trial'
                        ? theme.warning
                        : status === 'delinquent'
                          ? theme.error
                          : status === 'canceled'
                            ? theme.textSecondary
                            : theme.textSecondary;
                  return (
                    <View style={styles.billingStatusPill}>
                      <View style={[styles.billingDot, { backgroundColor: color }]} />
                      <Text style={[styles.billingStatusText, { color: theme.textSecondary }]}>{label}</Text>
                    </View>
                  );
                })()}
              </View>

              {renewalDisplay && !(downgradeToFreeScheduled && currentBilling?.status !== 'delinquent') ? (
                <Text style={[styles.metaText, { color: theme.textSecondary }]}
                >
                  {currentBilling?.status === 'delinquent' ? 'Due since:' : 'Renews on:'} {renewalDisplay}
                </Text>
              ) : null}

              {downgradeToFreeScheduled ? (
                <Text style={[styles.metaText, { color: theme.textSecondary }]}
                >
                  Downgrades to Free on: {scheduledDowngradeDisplay || 'End of cycle'}
                </Text>
              ) : null}

              {canManageBilling ? (
                loadingLatestBillingChange ? (
                  <Text style={[styles.metaText, { color: theme.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">
                    Loading latest plan change…
                  </Text>
                ) : latestBillingChangeText ? (
                  <Text style={[styles.metaText, { color: theme.textSecondary }]} numberOfLines={2} ellipsizeMode="tail">
                    Latest plan change: {latestBillingChangeText}
                  </Text>
                ) : null
              ) : null}

              {shouldShowCancelSubscriptionActions ? (
                <>
                  {isAndroidGooglePlayBilling ? (
                    <TouchableOpacity
                      onPress={handleManageGooglePlaySubscription}
                      accessibilityRole="button"
                      accessibilityLabel="Manage subscription in Google Play"
                      disabled={catalogLoading || isCheckoutBusy}
                      style={styles.billingLinkButton}
                    >
                      <Text style={[styles.billingLinkText, { color: theme.primary }]}>Manage in Google Play</Text>
                    </TouchableOpacity>
                  ) : null}

                  <View style={styles.billingLinkRow}>
                    <TouchableOpacity
                      onPress={handleSwitchToFree}
                      accessibilityRole="button"
                      accessibilityLabel={isAndroidGooglePlayBilling ? 'Cancel subscription in Google Play' : 'Cancel subscription'}
                      disabled={catalogLoading || isCheckoutBusy}
                      style={[styles.billingLinkButton, styles.billingLinkButtonRow]}
                    >
                      <Text style={[styles.billingLinkText, { color: theme.primary }]}>
                        {isAndroidGooglePlayBilling ? 'Cancel in Google Play' : 'Cancel subscription'}
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => router.push('/(tabs)/billing-history')}
                      accessibilityRole="button"
                      accessibilityLabel="Billing history"
                      disabled={catalogLoading || isCheckoutBusy}
                      style={[styles.billingLinkButton, styles.billingLinkButtonRow]}
                    >
                      <Text style={[styles.billingLinkText, { color: theme.primary }]}>Billing history</Text>
                    </TouchableOpacity>
                  </View>

                  {canManageBilling && !isAndroidGooglePlayBilling && (isDelinquent || (isPendingPaid && canUpdatePaymentMethod)) ? (
                    <View style={styles.billingLinkRow}>
                      <TouchableOpacity
                        onPress={handleUpdatePaymentMethod}
                        accessibilityRole="button"
                        accessibilityLabel="Update payment method"
                        disabled={catalogLoading || isCheckoutBusy}
                        style={[styles.billingLinkButton, styles.billingLinkButtonRow]}
                      >
                        <Text style={[styles.billingLinkText, { color: theme.primary }]}>Update payment method</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}

                </>
              ) : null}

              {currentPlanDisplay.id === 'enterprise' ? (
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>Enterprise billing is managed by your administrator.</Text>
              ) : null}

              {currentBilling?.status === 'canceled' && currentPlanDisplay.id !== 'free' ? (
                <Text style={[styles.metaText, { color: theme.textSecondary }]}>Choose a plan below to subscribe again.</Text>
              ) : null}

              <View style={styles.billingActionsRow}>
                {canManageBilling ? (
                  <>
                    {isDelinquent ? (
                      isAndroidGooglePlayBilling ? (
                        <TouchableOpacity
                          style={[styles.billingActionButton, { backgroundColor: theme.primary }]}
                          accessibilityRole="button"
                          accessibilityLabel="Open Google Play"
                          onPress={handleManageGooglePlaySubscription}
                          disabled={catalogLoading || isCheckoutBusy}
                        >
                          <Text style={[styles.billingActionButtonText, { color: theme.surface }]}>Open Google Play</Text>
                        </TouchableOpacity>
                      ) : shouldShowCancelSubscriptionActions ? null : (
                        <TouchableOpacity
                          style={[styles.billingActionButton, { backgroundColor: theme.primary }]}
                          accessibilityRole="button"
                          accessibilityLabel="Update payment method"
                          onPress={handleUpdatePaymentMethod}
                          disabled={catalogLoading || isCheckoutBusy}
                        >
                          <Text style={[styles.billingActionButtonText, { color: theme.surface }]}>Update payment method</Text>
                        </TouchableOpacity>
                      )
                    ) : isPendingPaid ? (
                      shouldShowCancelSubscriptionActions && !isAndroidGooglePlayBilling && canUpdatePaymentMethod ? null :
                      <TouchableOpacity
                        style={[styles.billingActionButton, { backgroundColor: theme.primary }]}
                        accessibilityRole="button"
                        accessibilityLabel={
                          isAndroidGooglePlayBilling
                            ? 'Open Google Play'
                            : canUpdatePaymentMethod
                              ? 'Update payment method'
                              : 'Refresh billing status'
                        }
                        onPress={
                          isAndroidGooglePlayBilling
                            ? handleManageGooglePlaySubscription
                            : canUpdatePaymentMethod
                              ? handleUpdatePaymentMethod
                              : handleRefreshBillingStatus
                        }
                        disabled={catalogLoading || isCheckoutBusy}
                      >
                        <Text style={[styles.billingActionButtonText, { color: theme.surface }]}>
                          {isAndroidGooglePlayBilling
                            ? 'Open Google Play'
                            : canUpdatePaymentMethod
                              ? 'Update payment method'
                              : 'Refresh billing status'}
                        </Text>
                      </TouchableOpacity>
                      ) : !shouldShowCancelSubscriptionActions ? (
                      <TouchableOpacity
                        style={[styles.billingActionButton, { backgroundColor: theme.primary }]}
                        accessibilityRole="button"
                        accessibilityLabel="Billing history"
                        onPress={() => router.push('/(tabs)/billing-history')}
                        disabled={catalogLoading || isCheckoutBusy}
                      >
                        <Text style={[styles.billingActionButtonText, { color: theme.surface }]}>Billing history</Text>
                      </TouchableOpacity>
                      ) : null}

                    {(isDelinquent || isRazorpayCheckoutRequired) && !shouldShowCancelSubscriptionActions ? (
                      <TouchableOpacity
                        style={[styles.billingSecondaryButton, { borderColor: theme.border }]}
                        accessibilityRole="button"
                        accessibilityLabel="Billing history"
                        onPress={() => router.push('/(tabs)/billing-history')}
                        disabled={catalogLoading || isCheckoutBusy}
                      >
                        <Text style={[styles.billingSecondaryButtonText, { color: theme.text }]}>Billing history</Text>
                      </TouchableOpacity>
                    ) : null}
                  </>
                ) : null}

                {!canManageBilling ? (
                  <Text style={[styles.billingMutedText, { color: theme.textSecondary }]}>Only Owner/Admin can manage billing.</Text>
                ) : null}
              </View>

              {/** Update payment method is shown as the primary action above when relevant. */}
            </View>
          ) : null}

          {!shouldShowPlanLimitsLoading && currentPlanDisplay.id === 'enterprise' ? (
            <Text style={[styles.hintText, { color: theme.textSecondary, marginTop: 8 }]}
            >
              Enterprise plans and limits are managed by your administrator.
            </Text>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>AVAILABLE PLANS</Text>

          {catalogLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator />
              <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Loading plans…</Text>
            </View>
          ) : null}

          <View style={styles.cardList}>
              <PlanTierCard
              plan={freePlanDisplay}
                isCurrent={effectivePlanId === 'free'}
              actionLabel={
                  effectivePlanId === 'free'
                  ? undefined
                  : downgradeToFreeScheduled
                    ? 'Downgrade scheduled'
                  : checkoutVariantBusy === 'free'
                    ? 'Switching…'
                    : 'Switch to Free'
              }
              onPressAction={handleSwitchToFree}
              actionDisabled={!canManageBilling || catalogLoading || isCheckoutBusy || downgradeToFreeScheduled}
            />

            {effectivePlanId !== 'enterprise' ? (
              proVariants.length ? (
                proVariants.map((variant) => {
                  const plan = variantToPlanTierDisplay(variant);
                  const isCurrentVariant = (currentBillingVariantId || '').trim() === variant.id;
                  return (
                    <PlanTierCard
                      key={variant.id}
                      plan={plan}
                      isCurrent={isCurrentVariant}
                      actionLabel={
                        currentPlanDisplay.id === 'enterprise' || isCurrentVariant || effectivePlanId === 'pro'
                          ? undefined
                          : checkoutVariantBusy === variant.id
                            ? Platform.OS === 'android'
                              ? 'Opening Google Play…'
                              : 'Opening Razorpay…'
                            : `Upgrade to ${variant.displayName}`
                      }
                      onPressAction={() => handleUpgradePress(variant.id)}
                      actionDisabled={currentPlanDisplay.id === 'enterprise' || !canManageBilling || catalogLoading || isCheckoutBusy}
                    />
                  );
                })
              ) : (
                <PlanTierCard
                  plan={{
                    id: 'pro',
                    label: 'Pro',
                    monthlyPriceInr: null,
                    staffSeats: 0,
                    students: 0,
                    reminders: { total: 0, whatsapp: 0, sms: 0, voice: 0, email: 0 },
                    storageBytes: 0,
                  }}
                  isCurrent={effectivePlanId === 'pro'}
                  actionLabel={currentPlanDisplay.id === 'enterprise' || effectivePlanId === 'pro' ? undefined : 'Upgrade to Pro'}
                  onPressAction={() =>
                    openBillingAlertModal(
                      'Plans not configured',
                      'Paid plans are not configured yet. Please contact support to enable billing plans for your account.'
                    )
                  }
                  actionDisabled={currentPlanDisplay.id === 'enterprise' || !canManageBilling || catalogLoading || isCheckoutBusy}
                />
              )
            ) : null}
          </View>

          {!canManageBilling ? (
            <Text style={[styles.hintText, { color: theme.textSecondary }]}>
              Only Owner/Admin can manage billing for this coaching center.
            </Text>
          ) : null}

          {currentPlanDisplay.id !== 'enterprise' ? (
            <Text style={[styles.hintText, { color: theme.textSecondary }]}
            >
              {Platform.OS === 'android' ? 'Payments are processed via Google Play.' : 'Payments are processed via Razorpay.'}
            </Text>
          ) : null}
        </View>
      </ScrollView>

      <ConfirmationModal
        visible={switchToFreeModalVisible}
        onClose={() => {
          if (switchToFreeModalConfirmLoading) {
            return;
          }
          setSwitchToFreeModalVisible(false);
        }}
        title={switchToFreeModalTitle}
        message={switchToFreeModalMessage}
        confirmText={switchToFreeModalConfirmText}
        cancelText="Cancel"
        confirmStyle={switchToFreeModalConfirmStyle}
        showCancelButton={switchToFreeModalShowCancel}
        confirmLoading={switchToFreeModalConfirmLoading}
        cancelDisabled={switchToFreeModalConfirmLoading}
        autoCloseOnConfirm={false}
        onConfirm={switchToFreeModalOnConfirm}
        statusMessage={switchToFreeModalStatusMessage}
        statusType={switchToFreeModalStatusType}
      />

      <ConfirmationModal
        visible={checkoutConflictModalVisible}
        onClose={() => {
          if (checkoutConflictModalLoading) {
            return;
          }
          setCheckoutConflictModalVisible(false);
        }}
        title="Checkout already in progress"
        message={checkoutConflictModalMessage}
        confirmText={checkoutConflictModalCheckoutUrl ? 'Open existing checkout' : 'OK'}
        cancelText="OK"
        showCancelButton={Boolean(checkoutConflictModalCheckoutUrl)}
        confirmStyle="primary"
        confirmLoading={checkoutConflictModalLoading}
        cancelDisabled={checkoutConflictModalLoading}
        autoCloseOnConfirm={false}
        statusMessage={checkoutConflictModalStatusMessage}
        statusType={checkoutConflictModalStatusType}
        onConfirm={() => {
          const url = (checkoutConflictModalCheckoutUrl || '').trim();
          if (!url) {
            setCheckoutConflictModalVisible(false);
            return;
          }
          void (async () => {
            try {
              setCheckoutConflictModalLoading(true);
              setCheckoutConflictModalStatusMessage(null);
              setCheckoutConflictModalStatusType('neutral');
              try {
                if (billingReturnUrl) {
                  await WebBrowser.openAuthSessionAsync(url, billingReturnUrl);
                } else {
                  await WebBrowser.openBrowserAsync(url);
                }
              } catch {
                const canOpen = await Linking.canOpenURL(url);
                if (!canOpen) {
                  setCheckoutConflictModalStatusType('error');
                  setCheckoutConflictModalStatusMessage('Unable to open the existing checkout link on this device.');
                  return;
                }
                await Linking.openURL(url);
              }
              setCheckoutConflictModalVisible(false);
            } catch {
              setCheckoutConflictModalStatusType('error');
              setCheckoutConflictModalStatusMessage('Unable to open the existing checkout link. Please try again.');
            } finally {
              setCheckoutConflictModalLoading(false);
            }
          })();
        }}
      />

      <ConfirmationModal
        visible={billingAlertModalVisible}
        onClose={() => setBillingAlertModalVisible(false)}
        title={billingAlertModalTitle}
        message={billingAlertModalMessage}
        confirmText="OK"
        showCancelButton={false}
        confirmStyle={billingAlertModalStyle}
        onConfirm={() => setBillingAlertModalVisible(false)}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: 60,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  content: {
    padding: 16,
    gap: 18,
  },
  banner: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderRadius: 12,
    gap: 4,
  },
  bannerTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  bannerText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  cardList: {
    gap: 12,
  },
  metaText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  billingCard: {
    marginTop: 10,
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  billingHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  billingHeaderTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  billingStatusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  billingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  billingStatusText: {
    fontSize: 13,
    fontWeight: '700',
  },
  billingActionsRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  billingActionButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignSelf: 'flex-start',
  },
  billingActionButtonText: {
    fontSize: 13,
    fontWeight: '800',
  },
  billingSecondaryButton: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  billingSecondaryButtonText: {
    fontSize: 13,
    fontWeight: '800',
  },
  billingMutedText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  billingLinkButton: {
    marginTop: 6,
    alignSelf: 'flex-start',
  },
  billingLinkRow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  billingLinkButtonRow: {
    marginTop: 0,
  },
  billingLinkText: {
    fontSize: 13,
    fontWeight: '800',
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
    marginBottom: 6,
  },
  loadingText: {
    fontSize: 13,
    fontWeight: '600',
  },
  cardPlaceholder: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  hintText: {
    fontSize: 13,
    fontWeight: '500',
    marginTop: 10,
    lineHeight: 18,
  },
});
