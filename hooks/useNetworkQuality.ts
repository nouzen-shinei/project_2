import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { logger } from '@/lib/logger';
import { runtimeEndpoints } from '@/services/runtimeEndpoints';
import { isAppForeground, subscribeAppForeground } from '@/hooks/useAppForeground';

export interface NetworkQuality {
  isSlow: boolean;
  label?: string; // e.g., 'slow-2g', '2g', '3g', '4g', 'wifi', '1.2 Mbps'
  downlink?: number; // Mbps if available
  effectiveType?: string; // browser effectiveType
}

function computeNativeQuality(state: NetInfoState): NetworkQuality {
  const type = state.type;
  const details: any = state.details || {};
  const gen: string | undefined = details.cellularGeneration;
  const expensive: boolean | undefined = details.isConnectionExpensive;

  let label: string | undefined = type;
  if (type === 'cellular' && gen) label = gen;
  if (type === 'wifi') label = 'wifi';

  // Heuristics for slow (native):
  // - 2g or 3g cellular considered slow
  // - DO NOT treat "expensive/metered" as slow on Android because most
  //   mobile data connections report as metered even when fast (4G/5G).
  //   This caused the slow banner to always show on Android builds.
  // - Optionally, on iOS Wi‑Fi Low Data Mode we could consider it slow,
  //   but keep behavior conservative to avoid false positives.
  let isSlow = type === 'cellular' && (gen === '2g' || gen === '3g');
  // If we ever want to account for Low Data Mode on iOS Wi‑Fi specifically:
  // if (Platform.OS === 'ios' && type === 'wifi' && expensive) {
  //   isSlow = true;
  // }

  return { isSlow, label };
}

function getBrowserConnection(): any | undefined {
  if (typeof navigator === 'undefined') return undefined;
  // @ts-ignore
  return navigator.connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
}

function computeWebQuality(conn: any | undefined): NetworkQuality {
  if (!conn) {
    return { isSlow: false, label: undefined };
  }
  const effectiveType: string | undefined = conn.effectiveType; // 'slow-2g' | '2g' | '3g' | '4g'
  const downlink: number | undefined = typeof conn.downlink === 'number' ? conn.downlink : undefined; // Mbps

  // Thresholds: treat slow-2g/2g as slow, 3g often slow; or downlink < 1.5 Mbps considered slow
  const isSlow = (
    effectiveType === 'slow-2g' ||
    effectiveType === '2g' ||
    effectiveType === '3g' ||
    (typeof downlink === 'number' && downlink < 1.5)
  );

  let label: string | undefined = effectiveType;
  if (!label && typeof downlink === 'number') {
    label = `${downlink.toFixed(1)} Mbps`;
  }

  return { isSlow, label, downlink, effectiveType };
}

export function useNetworkQuality(): NetworkQuality {
  const [quality, setQuality] = useState<NetworkQuality>({ isSlow: false });
  const intervalRef = useRef<any>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Keep a tiny rolling window of latency samples to smooth noise
  const samplesRef = useRef<number[]>([]);
  // Cache the last working probe URL to avoid switching unnecessarily
  const lastGoodUrlRef = useRef<string | null>(null);

  // Support a debug override on web (?slow in URL)
  const debugSlow = useMemo(() => {
    try {
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        return new URLSearchParams(window.location.search).has('slow');
      }
    } catch {}
    return false;
  }, []);

  useEffect(() => {
    // Web: use Network Information API as a hint (no early return; we also probe RTT like Android)
    let webConn: any | undefined;
    let webUpdate: (() => void) | null = null;
    let webPollTimer: any | null = null;
    if (Platform.OS === 'web') {
      webConn = getBrowserConnection();
      // On web, only use navigator.connection to update metadata (label/downlink/effectiveType)
      // and do NOT flip isSlow from it. isSlow is driven solely by the active RTT probe.
      webUpdate = () => {
        const info = computeWebQuality(getBrowserConnection());
        setQuality(prev => ({
          ...prev,
          label: info.label,
          downlink: info.downlink,
          effectiveType: info.effectiveType,
        }));
      };
      webUpdate();
      if (webConn && typeof webConn.addEventListener === 'function') {
        webConn.addEventListener('change', webUpdate);
      }
      // When the connection `change` event is unavailable we fall back to a
      // poll, which is started/stopped by the foreground manager below so it
      // does not run while the tab is hidden.
    }

    // Native platforms: use NetInfo details (skip on web)
    let unsub: (() => void) | undefined;
    if (Platform.OS !== 'web') {
      unsub = NetInfo.addEventListener((state) => {
        setQuality(prev => ({ ...prev, ...computeNativeQuality(state) }));
      });
      // Also fetch initial
      NetInfo.fetch()
        .then((s) => setQuality(prev => ({ ...prev, ...computeNativeQuality(s) })))
        .catch(() => {});
    }

    // In addition to connection type heuristics, actively probe latency on all platforms.
    // This mirrors the Android approach and brings it to web as well.
    const PROBE_INTERVAL_MS = 8000; // balanced for battery vs responsiveness
    const SOFT_SLOW_THRESHOLD_MS = 1200; // if RTT consistently above this, consider slow
    const HARD_TIMEOUT_MS = 5000; // a single timeout counts as a very slow sample
    const REQUIRED_SAMPLES = 3; // rolling window size
    const REQUIRED_SLOW_COUNT = 2; // mark slow if >=2 of last 3 are slow

  const envProbe = (process.env.EXPO_PUBLIC_CONNECTIVITY_TEST_URL || '').trim();
  // Prefer public connectivity endpoints on web to avoid auth/CORS noise.
  // Only include the app API base for native, or when an explicit env probe is provided.
  const baseApi = (runtimeEndpoints.getPreferredBackendBaseUrl() || '').trim();
  const candidates: string[] = [];
  if (envProbe) candidates.push(envProbe);
  // Public tiny endpoints (first so lastGoodUrl sticks to these)
  candidates.push('https://www.gstatic.com/generate_204');
  candidates.push('https://clients3.google.com/generate_204');
  candidates.push('https://1.1.1.1/cdn-cgi/trace');
  // Only probe the app base on native to avoid 401 logs on web devtools
  if (Platform.OS !== 'web' && baseApi) candidates.push(baseApi.replace(/\/$/, ''));

    async function probeOnce(urls: string[]): Promise<number> {
      // Try last good URL first for speed
      const ordered = lastGoodUrlRef.current
        ? [lastGoodUrlRef.current, ...urls.filter(u => u !== lastGoodUrlRef.current)]
        : urls;
      const start = Date.now();
      const controller = new AbortController();
      abortRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), HARD_TIMEOUT_MS);
      try {
        let lastError: any = null;
        for (const raw of ordered) {
          // Use HEAD when probing a base URL; otherwise GET is fine.
          const is204 = /generate_204|cdn-cgi\/trace/.test(raw);
          const target = is204 ? `${raw}?t=${Date.now()}` : `${raw}${raw.endsWith('/') ? '' : '/'}?t=${Date.now()}`;
          try {
            let res: Response | null = null;
            // On web, for public probe endpoints, prefer a no-cors GET first to avoid CORS errors in console.
            if (Platform.OS === 'web' && is204) {
              res = await fetch(target, { method: 'GET', signal: controller.signal, cache: 'no-store' as any, mode: 'no-cors' as any } as any);
            } else {
              // First attempt: standard CORS fetch
              const init: any = { method: is204 ? 'GET' : 'HEAD', signal: controller.signal, cache: 'no-store' as any };
              try {
                res = await fetch(target, init);
              } catch (err) {
                // On web, CORS might block; attempt a no-cors GET fallback which still
                // completes the request and lets us measure RTT even if status is opaque.
                if (Platform.OS === 'web') {
                  try {
                    res = await fetch(target, { method: 'GET', signal: controller.signal, cache: 'no-store' as any, mode: 'no-cors' as any } as any);
                  } catch (e2) {
                    throw e2;
                  }
                } else {
                  throw err;
                }
              }
            }
            if (!res) continue;
            // Treat any successfully resolved response as reachable; on opaque responses
            // res.ok is false and status is 0, so also accept those on web.
            const okish = (res.ok || (res.status >= 200 && res.status < 500) || (Platform.OS === 'web' && (res.type === 'opaque' || res.status === 0)));
            if (okish) {
              lastGoodUrlRef.current = raw;
              const rtt = Date.now() - start;
              return rtt;
            }
          } catch (e) {
            lastError = e;
            // try next candidate
          }
        }
        // If all failed, treat as timeout
        throw lastError || new Error('All probe candidates failed');
      } finally {
        clearTimeout(timeout);
      }
    }

    function recordSample(ms: number | 'timeout') {
      const value = typeof ms === 'number' ? ms : HARD_TIMEOUT_MS + 1;
      samplesRef.current.push(value);
      if (samplesRef.current.length > REQUIRED_SAMPLES) samplesRef.current.shift();

      const slowCount = samplesRef.current.filter(v => v >= SOFT_SLOW_THRESHOLD_MS).length;
      const isSlowNow = slowCount >= REQUIRED_SLOW_COUNT;
      const avg = Math.round(samplesRef.current.reduce((a, b) => a + b, 0) / samplesRef.current.length);
      const label = `${avg}ms RTT`;
      setQuality(prev => ({ ...prev, isSlow: isSlowNow, label }));
      logger.debug('[net-quality] samples:', samplesRef.current, 'isSlow:', isSlowNow, label, 'probe:', lastGoodUrlRef.current);
    }

    // Kick off periodic probe
    const tick = async () => {
      try {
        const rtt = await probeOnce(candidates);
        recordSample(rtt);
      } catch (e) {
        recordSample('timeout');
      }
    };

    // The RTT probe issues a network request on every tick and the web poll
    // reads connection metadata. Both are paused while the app/tab is
    // backgrounded so they don't drain battery or fire a backlog burst on
    // resume; they restart (with one slightly-delayed sample) when foregrounded.
    let initial: ReturnType<typeof setTimeout> | null = null;

    const startProbe = () => {
      if (intervalRef.current) return;
      // Slight delay to avoid competing with the work triggered by resume/boot.
      initial = setTimeout(tick, 1200);
      intervalRef.current = setInterval(tick, PROBE_INTERVAL_MS);
    };

    const stopProbe = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (initial) {
        clearTimeout(initial);
        initial = null;
      }
      if (abortRef.current) {
        try { abortRef.current.abort(); } catch {}
      }
    };

    const startWebPoll = () => {
      if (Platform.OS !== 'web') return;
      if (webPollTimer) return;
      // If the connection `change` event is supported we rely on it instead.
      if (webConn && typeof webConn.addEventListener === 'function') return;
      if (webUpdate) {
        webUpdate();
        webPollTimer = setInterval(webUpdate, 5000);
      }
    };

    const stopWebPoll = () => {
      if (webPollTimer) {
        clearInterval(webPollTimer);
        webPollTimer = null;
      }
    };

    if (isAppForeground()) {
      startProbe();
      startWebPoll();
    }

    const unsubscribeForeground = subscribeAppForeground((active) => {
      if (active) {
        startProbe();
        startWebPoll();
      } else {
        stopProbe();
        stopWebPoll();
      }
    });

    return () => {
      unsubscribeForeground();
      try { unsub && unsub(); } catch {}
      if (Platform.OS === 'web') {
        try { if (webConn && webUpdate && typeof webConn.removeEventListener === 'function') webConn.removeEventListener('change', webUpdate); } catch {}
      }
      stopWebPoll();
      stopProbe();
    };
  }, []);

  const debugEnvSlow = process.env.EXPO_PUBLIC_DEBUG_SLOW === '1' || process.env.EXPO_PUBLIC_DEBUG_SLOW === 'true';
  return (debugSlow || debugEnvSlow) ? { ...quality, isSlow: true, label: quality.label || 'debug' } : quality;
}
