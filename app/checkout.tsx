import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { runtimeEndpoints } from '@/services/runtimeEndpoints';
import { maybeShowMaintenanceAlertFromRaw } from '@/services/maintenanceAlert';

type SessionResponse = {
  provider: 'razorpay';
  sessionId: string;
  tenantId: string;
  planId: 'free' | 'pro' | 'enterprise';
  planVariantId?: string;
  successUrl?: string;
  cancelUrl?: string;
  createdByEmail?: string;
  razorpay: {
    keyId: string;
    subscriptionId: string;
  };
};

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('not_in_browser'));
      return;
    }

    const existing = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (existing) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('script_load_failed'));
    document.body.appendChild(script);
  });
}

export default function CheckoutScreen() {
  const { theme } = useTheme();
  const params = useLocalSearchParams();
  const sessionId = useMemo(() => {
    const raw = typeof params.sessionId === 'string' ? params.sessionId : Array.isArray(params.sessionId) ? params.sessionId[0] : '';
    return (raw || '').trim();
  }, [params.sessionId]);
  const tenantId = useMemo(() => {
    const raw = typeof params.tenantId === 'string' ? params.tenantId : Array.isArray(params.tenantId) ? params.tenantId[0] : '';
    return (raw || '').trim();
  }, [params.tenantId]);

  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [message, setMessage] = useState<string>('');
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [checkoutConfig, setCheckoutConfig] = useState<{
    keyId: string;
    subscriptionId: string;
    prefillEmail?: string;
    successUrl: string;
    cancelUrl: string;
  } | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      setStatus('error');
      setMessage('Checkout is only supported in a browser.');
      return;
    }

    if (!sessionId) {
      setStatus('error');
      setMessage('Missing checkout session.');
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        await runtimeEndpoints.init().catch(() => {});
        const apiBase = (runtimeEndpoints.getPreferredBackendBaseUrl() || '').trim();
        if (!apiBase) {
          setStatus('error');
          setMessage('API base URL is not configured.');
          return;
        }

        setStatus('loading');
        setMessage('Preparing secure checkout…');
        setSession(null);
        setCheckoutConfig(null);

        const url = new URL(`${apiBase}/billing/checkout/session-public`);
        url.searchParams.set('sessionId', sessionId);
        if (tenantId) url.searchParams.set('tenantId', tenantId);

        const resp = await fetch(url.toString(), { method: 'GET' });
        const text = await resp.text();
        if (!resp.ok) {
          maybeShowMaintenanceAlertFromRaw(resp.status, text);
          throw new Error(text || `checkout_session_failed_${resp.status}`);
        }

        const session = JSON.parse(text) as SessionResponse;
        if (session.provider !== 'razorpay') {
          throw new Error('provider_not_supported');
        }

        setSession(session);

        const successUrl = (session.successUrl || '').trim();
        const cancelUrl = (session.cancelUrl || '').trim() || successUrl;
        if (!successUrl) {
          throw new Error('missing_success_url');
        }

        await loadScript('https://checkout.razorpay.com/v1/checkout.js');
        if (cancelled) return;

        const RazorpayCtor = (window as any).Razorpay;
        if (!RazorpayCtor) {
          throw new Error('razorpay_js_unavailable');
        }

        setCheckoutConfig({
          keyId: session.razorpay.keyId,
          subscriptionId: session.razorpay.subscriptionId,
          prefillEmail: (session.createdByEmail || '').trim() || undefined,
          successUrl,
          cancelUrl: cancelUrl || successUrl,
        });

        setStatus('ready');
        setMessage('Review your details and click Pay now to continue.');
      } catch (err: any) {
        if (cancelled) return;
        setStatus('error');
        setMessage(typeof err?.message === 'string' ? err.message : 'Unable to start checkout');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, tenantId, attempt]);

  const canPay = status === 'ready' && Boolean(checkoutConfig);

  const buildResultUrl = (resultStatus: 'success' | 'failed' | 'cancelled', extras?: Record<string, string | null | undefined>) => {
    if (Platform.OS !== 'web') return null;
    if (!checkoutConfig) return null;
    try {
      const url = new URL('/checkout-result', window.location.origin);
      url.searchParams.set('status', resultStatus);
      url.searchParams.set('returnUrl', checkoutConfig.successUrl);
      url.searchParams.set('tenantId', session?.tenantId || tenantId || '');
      url.searchParams.set('planId', session?.planId || '');
      url.searchParams.set('email', session?.createdByEmail || '');
      if (resultStatus !== 'success') {
        url.searchParams.set('returnUrl', checkoutConfig.cancelUrl || checkoutConfig.successUrl);
      }

      if (extras) {
        for (const [key, value] of Object.entries(extras)) {
          const normalizedKey = (key || '').trim();
          const normalizedValue = typeof value === 'string' ? value.trim() : '';
          if (!normalizedKey || !normalizedValue) continue;
          url.searchParams.set(normalizedKey, normalizedValue);
        }
      }

      return url.toString();
    } catch {
      return null;
    }
  };

  function extractRazorpayErrorDetails(payload: any): { code?: string; description?: string; reason?: string; source?: string; step?: string } {
    const error = payload?.error && typeof payload.error === 'object' ? payload.error : null;
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const description = typeof error?.description === 'string' ? error.description : undefined;
    const reason = typeof error?.reason === 'string' ? error.reason : undefined;
    const source = typeof error?.source === 'string' ? error.source : undefined;
    const step = typeof error?.step === 'string' ? error.step : undefined;
    return { code, description, reason, source, step };
  }

  const openRazorpay = () => {
    if (Platform.OS !== 'web') return;
    if (!checkoutConfig) return;

    try {
      const RazorpayCtor = (window as any).Razorpay;
      if (!RazorpayCtor) {
        throw new Error('razorpay_js_unavailable');
      }

      setMessage('Opening payment window…');

      const options: Record<string, any> = {
        key: checkoutConfig.keyId,
        subscription_id: checkoutConfig.subscriptionId,
        name: 'Tuition Manager',
        description: 'Subscription checkout',
        prefill: checkoutConfig.prefillEmail ? { email: checkoutConfig.prefillEmail } : undefined,
        handler: () => {
          try {
            const next = buildResultUrl('success') || checkoutConfig.successUrl;
            window.location.href = next;
          } catch {
            // ignore
          }
        },
        modal: {
          ondismiss: () => {
            try {
              const next = buildResultUrl('cancelled') || checkoutConfig.cancelUrl || checkoutConfig.successUrl;
              window.location.href = next;
            } catch {
              // ignore
            }
          },
        },
      };

      const rzp = new RazorpayCtor(options);

      // Best-effort: detect payment failures (not all flows emit this reliably for subscriptions).
      if (typeof (rzp as any)?.on === 'function') {
        (rzp as any).on('payment.failed', (response: any) => {
          try {
            const details = extractRazorpayErrorDetails(response);
            const next =
              buildResultUrl('failed', {
                errorCode: details.code || null,
                errorDescription: details.description || null,
                errorReason: details.reason || null,
                errorSource: details.source || null,
                errorStep: details.step || null,
              }) ||
              checkoutConfig.cancelUrl ||
              checkoutConfig.successUrl;
            window.location.href = next;
          } catch {
            // ignore
          }
        });
      }

      rzp.open();
    } catch (err: any) {
      setStatus('error');
      setMessage(typeof err?.message === 'string' ? err.message : 'Unable to open payment window');
    }
  };

  const planLabel = session?.planId === 'pro' ? 'Pro' : session?.planId === 'enterprise' ? 'Enterprise' : session?.planId === 'free' ? 'Free' : '';
  const showSpinner = status === 'loading';
  const statusTitle = status === 'error' ? 'Checkout failed' : 'Secure checkout';
  const statusSubtitle = status === 'error'
    ? 'Please try again. If the issue persists, close this tab and restart checkout from the app.'
    : 'You will be redirected to Razorpay to complete payment.';

  return (
    <View style={[styles.page, { backgroundColor: theme.background }]}>
      <View style={[styles.shell, { paddingTop: 28, paddingBottom: 28 }]}>
        <View style={styles.header}>
          <Text style={[styles.brand, { color: theme.text }]}>Tuition Manager</Text>
          <Text style={[styles.caption, { color: theme.textSecondary }]}>Subscription checkout</Text>
        </View>

        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.cardHeader}>
            <View style={styles.cardHeaderRow}>
              <Text style={[styles.cardTitle, { color: theme.text }]}>{statusTitle}</Text>
              {showSpinner ? <ActivityIndicator size="small" color={theme.primary} /> : null}
            </View>
            <Text style={[styles.cardSubtitle, { color: theme.textSecondary }]}>{statusSubtitle}</Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>ORDER SUMMARY</Text>
            <View style={styles.rows}>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Plan</Text>
                <Text style={[styles.rowValue, { color: theme.text }]}>{planLabel || (session ? session.planId.toUpperCase() : '—')}</Text>
              </View>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Tenant</Text>
                <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>{(session?.tenantId || tenantId || '—').trim() || '—'}</Text>
              </View>
              <View style={styles.row}>
                <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Email</Text>
                <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>{(session?.createdByEmail || '—').trim() || '—'}</Text>
              </View>
            </View>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>STATUS</Text>
            <Text style={[styles.statusMessage, { color: status === 'error' ? theme.text : theme.textSecondary }]}> 
              {message || (status === 'loading' ? 'Loading…' : 'Preparing…')}
            </Text>

            {canPay ? (
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={openRazorpay}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    { backgroundColor: theme.primary, opacity: pressed ? 0.9 : 1 },
                  ]}
                >
                  <Text style={[styles.primaryButtonText, { color: '#fff' }]}>Pay now</Text>
                </Pressable>
              </View>
            ) : null}

            {status === 'error' ? (
              <View style={styles.actions}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAttempt((v) => v + 1)}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    { backgroundColor: theme.primary, opacity: pressed ? 0.9 : 1 },
                  ]}
                >
                  <Text style={[styles.primaryButtonText, { color: '#fff' }]}>Try again</Text>
                </Pressable>
                <Text style={[styles.finePrint, { color: theme.textSecondary }]}>Powered by Razorpay</Text>
              </View>
            ) : (
              <Text style={[styles.finePrint, { color: theme.textSecondary }]}>Powered by Razorpay</Text>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  shell: {
    width: '100%',
    maxWidth: 560,
  },
  header: {
    gap: 4,
    marginBottom: 14,
    alignItems: 'center',
  },
  brand: {
    fontSize: 20,
    fontWeight: '700',
  },
  caption: {
    fontSize: 13,
  },
  card: {
    borderWidth: 1,
    borderRadius: 16,
    overflow: 'hidden',
  },
  cardHeader: {
    padding: 16,
    gap: 8,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  cardSubtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  divider: {
    height: 1,
    width: '100%',
  },
  section: {
    padding: 16,
    gap: 10,
  },
  sectionTitle: {
    fontSize: 12,
    letterSpacing: 0.8,
    fontWeight: '700',
  },
  rows: {
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  rowLabel: {
    fontSize: 13,
  },
  rowValue: {
    fontSize: 13,
    fontWeight: '600',
    maxWidth: 320,
    textAlign: 'right',
  },
  statusMessage: {
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    marginTop: 6,
    gap: 10,
  },
  primaryButton: {
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
  },
  finePrint: {
    fontSize: 12,
    textAlign: 'center',
  },
});
