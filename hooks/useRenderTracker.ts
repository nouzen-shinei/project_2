import { useEffect, useRef } from 'react';
import { logger } from '@/lib/logger';

interface RenderTrackerOptions {
  tag: string;
  key?: string | number | null;
  throttle?: number;
}

const ENABLED = process.env.EXPO_PUBLIC_CHAT_PROFILE_MESSAGES === '1' || process.env.EXPO_PUBLIC_CHAT_PROFILE_MESSAGES === 'true';

export function useRenderTracker(options: RenderTrackerOptions): void {
  if (!ENABLED) {
    return;
  }

  const { tag, key, throttle = 5 } = options;
  const rendersRef = useRef(0);
  const lastLoggedRef = useRef(0);

  rendersRef.current += 1;

  useEffect(() => {
    if (!ENABLED) {
      return;
    }

    if (rendersRef.current - lastLoggedRef.current >= throttle) {
      lastLoggedRef.current = rendersRef.current;
      logger.metric('chat.render.bubble', {
        tag,
        key: key ?? 'unknown',
        renders: rendersRef.current,
      });
    }
  });
}
