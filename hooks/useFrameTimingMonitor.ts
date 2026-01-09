import { useEffect } from 'react';
import { logger } from '@/lib/logger';

interface FrameMonitorOptions {
  tag?: string;
  thresholdMs?: number;
  sampleSize?: number;
}

const ENABLED = process.env.EXPO_PUBLIC_CHAT_PROFILE_FRAMES === '1' || process.env.EXPO_PUBLIC_CHAT_PROFILE_FRAMES === 'true';

export function useFrameTimingMonitor(options?: FrameMonitorOptions): void {
  const tag = options?.tag ?? 'chat';
  const threshold = options?.thresholdMs ?? 34; // ~30fps
  const sampleSize = options?.sampleSize ?? 180;

  useEffect(() => {
    if (!ENABLED || typeof requestAnimationFrame !== 'function') {
      return;
    }

    let rafId = 0;
    let last = Date.now();
    let total = 0;
    let slow = 0;

    const tick = () => {
      const now = Date.now();
      const delta = now - last;
      if (delta > threshold) {
        slow += 1;
        logger.metric('chat.frame.slow', { tag, delta, threshold });
      }
      total += 1;
      if (total >= sampleSize) {
        logger.metric('chat.frame.window', { tag, slow, total, threshold });
        total = 0;
        slow = 0;
      }
      last = now;
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (total > 0) {
        logger.metric('chat.frame.window', { tag, slow, total, threshold, final: true });
      }
    };
  }, [tag, threshold, sampleSize]);
}
