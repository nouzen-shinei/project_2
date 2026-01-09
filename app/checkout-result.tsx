import React, { useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View, Linking } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';

type ResultStatus = 'success' | 'failed' | 'cancelled';

function coerceParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

export default function CheckoutResultScreen() {
  const { theme } = useTheme();
  const params = useLocalSearchParams();

  const status = useMemo(() => {
    const raw = coerceParam((params as any).status).trim().toLowerCase();
    if (raw === 'success') return 'success' as const;
    if (raw === 'cancelled') return 'cancelled' as const;
    return 'failed' as const;
  }, [params]);

  const returnUrl = useMemo(() => coerceParam((params as any).returnUrl).trim(), [params]);
  const tenantId = useMemo(() => coerceParam((params as any).tenantId).trim(), [params]);
  const planId = useMemo(() => coerceParam((params as any).planId).trim(), [params]);
  const email = useMemo(() => coerceParam((params as any).email).trim(), [params]);

  const errorCode = useMemo(() => coerceParam((params as any).errorCode).trim(), [params]);
  const errorDescription = useMemo(() => coerceParam((params as any).errorDescription).trim(), [params]);
  const errorReason = useMemo(() => coerceParam((params as any).errorReason).trim(), [params]);
  const errorSource = useMemo(() => coerceParam((params as any).errorSource).trim(), [params]);
  const errorStep = useMemo(() => coerceParam((params as any).errorStep).trim(), [params]);

  const [secondsLeft, setSecondsLeft] = useState(10);

  const title = status === 'success' ? 'Payment successful' : status === 'cancelled' ? 'Payment cancelled' : 'Payment failed';
  const subtitle =
    status === 'success'
      ? 'Your payment is complete. Redirecting you back to the app…'
      : 'Payment was not completed. Redirecting you back to the app…';

  useEffect(() => {
    setSecondsLeft(10);
  }, [status, returnUrl]);

  useEffect(() => {
    const interval = setInterval(() => {
      setSecondsLeft((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (secondsLeft > 0) return;

    if (Platform.OS === 'web') {
      try {
        // If opened in a popup, close it instead of redirecting
        if (window.opener) {
          window.close();
          return;
        }
        // Otherwise redirect to the return URL
        if (returnUrl) {
          window.location.href = returnUrl;
        }
      } catch {
        // ignore
      }
      return;
    }

    if (!returnUrl) return;
    void Linking.openURL(returnUrl).catch(() => undefined);
  }, [secondsLeft, returnUrl]);

  const statusColor = status === 'success' ? theme.success : theme.error;

  return (
    <View style={[styles.page, { backgroundColor: theme.background }]}>
      <View style={styles.shell}>
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.header}>
            <View style={[styles.badge, { backgroundColor: statusColor }]} />
            <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
            <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{subtitle}</Text>
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>CHECKOUT SUMMARY</Text>

            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Plan</Text>
              <Text style={[styles.rowValue, { color: theme.text }]}>{planId ? planId.toUpperCase() : '—'}</Text>
            </View>

            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Tenant</Text>
              <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>
                {tenantId || '—'}
              </Text>
            </View>

            <View style={styles.row}>
              <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Email</Text>
              <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>
                {email || '—'}
              </Text>
            </View>

            {status !== 'success' && (errorCode || errorDescription || errorReason || errorSource || errorStep) ? (
              <View style={{ marginTop: 12, gap: 8 }}>
                <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>ERROR DETAILS</Text>
                {errorCode ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Code</Text>
                    <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={2}>
                      {errorCode}
                    </Text>
                  </View>
                ) : null}
                {errorDescription ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Description</Text>
                    <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={4}>
                      {errorDescription}
                    </Text>
                  </View>
                ) : null}
                {errorReason ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Reason</Text>
                    <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={3}>
                      {errorReason}
                    </Text>
                  </View>
                ) : null}
                {errorSource ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Source</Text>
                    <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={2}>
                      {errorSource}
                    </Text>
                  </View>
                ) : null}
                {errorStep ? (
                  <View style={styles.row}>
                    <Text style={[styles.rowLabel, { color: theme.textSecondary }]}>Step</Text>
                    <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={2}>
                      {errorStep}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.footer}>
            <Text style={[styles.countdown, { color: theme.textSecondary }]}>Redirecting in {secondsLeft}s…</Text>
            <Text style={[styles.finePrint, { color: theme.textSecondary }]}>You can close this tab if it doesn’t redirect.</Text>
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
  card: {
    borderWidth: 1,
    borderRadius: 16,
    overflow: 'hidden',
  },
  header: {
    padding: 16,
    gap: 8,
  },
  badge: {
    width: 42,
    height: 6,
    borderRadius: 999,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
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
  footer: {
    padding: 16,
    gap: 6,
    alignItems: 'center',
  },
  countdown: {
    fontSize: 13,
  },
  finePrint: {
    fontSize: 12,
    textAlign: 'center',
  },
});
