import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';

function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function normalizeDl(dl: string) {
  const trimmed = dl.trim();
  if (!trimmed) return '';
  return trimmed.replace(/^\//, '');
}

function safeResolveFallback(raw: string | undefined) {
  if (!raw) return '/';
  const v = raw.trim();
  if (!v) return '/';

  // Allow same-origin relative paths.
  if (v.startsWith('/')) return v;

  // Allow only same-origin absolute URLs by default to avoid open redirect abuse.
  // Optionally allow additional hosts via EXPO_PUBLIC_SMARTLINK_ALLOWED_HOSTS.
  if (typeof window !== 'undefined' && isHttpUrl(v)) {
    try {
      const u = new URL(v);
      const allowedHosts = (() => {
        try {
          const rawHosts = (process.env.EXPO_PUBLIC_SMARTLINK_ALLOWED_HOSTS || '').trim();
          const extra = rawHosts
            ? rawHosts.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
            : [];
          const currentHost = window.location.host.toLowerCase();
          return new Set([currentHost, ...extra]);
        } catch {
          return new Set([window.location.host.toLowerCase()]);
        }
      })();

      if (allowedHosts.has(u.host.toLowerCase())) return u.toString();
    } catch {
      // ignore
    }
  }

  return '/';
}

export default function SmartLinkRedirect() {
  const params = useLocalSearchParams();
  const rawFallback = typeof params.u === 'string' ? params.u : undefined;
  const rawDl = typeof params.dl === 'string' ? params.dl : undefined;

  const fallbackUrl = useMemo(() => safeResolveFallback(rawFallback), [rawFallback]);
  const dl = useMemo(() => (rawDl ? normalizeDl(rawDl) : ''), [rawDl]);

  const [status, setStatus] = useState<'opening' | 'fallback' | 'done'>('opening');

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    // Desktop browsers should just go straight to the web URL.
    const isProbablyMobile = (() => {
      try {
        const ua = (navigator.userAgent || '').toLowerCase();
        return /android|iphone|ipad|ipod/.test(ua);
      } catch {
        return false;
      }
    })();

    // Always redirect on desktop.
    if (!isProbablyMobile) {
      setStatus('done');
      window.location.replace(fallbackUrl);
      return;
    }

    // On mobile web: try opening the native app via custom scheme,
    // then fall back to the web URL after a short timeout.
    // Note: This is a pragmatic fallback; for the best experience,
    // configure Universal Links (iOS) / App Links (Android) for your domain.
    const scheme = 'com.sneha.tution';
    const deepLink = dl ? `${scheme}://${dl}` : `${scheme}://`;

    setStatus('opening');

    const timeoutMs = 900;
    const timer = window.setTimeout(() => {
      setStatus('fallback');
      window.location.replace(fallbackUrl);
    }, timeoutMs);

    const onVisibility = () => {
      // If the app opened successfully, the browser tab typically becomes hidden.
      if (document.hidden) {
        window.clearTimeout(timer);
        setStatus('done');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Try opening the app.
    try {
      window.location.href = deepLink;
    } catch {
      // ignore
    }

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fallbackUrl, dl]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 8 }}>Opening…</Text>
      <Text style={{ fontSize: 13, opacity: 0.7, textAlign: 'center' }}>
        {status === 'opening'
          ? 'Trying to open the app. If it isn’t installed, we’ll open the web page.'
          : 'Opening the web page…'}
      </Text>
    </View>
  );
}
