import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';

export interface ChatRealtimeCallbacks<TMessage = unknown> {
  onMessage?: (message: TMessage) => void;
  onMessageUpdate?: (message: TMessage) => void;
  onMessageDelete?: (message: TMessage) => void;
  onStatus?: (payload: Record<string, unknown>) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
}

interface SubscribeOptions<TMessage> extends ChatRealtimeCallbacks<TMessage> {
  baseUrl: string;
  tenantId: string;
  userEmail: string;
  partnerEmail: string;
}

type CloseFn = () => void;

type StreamMode = 'sse' | 'websocket';

const STREAM_RETRY_BASE_MS = 500;
const STREAM_RETRY_MAX_MS = 6000;
const STREAM_RETRY_GROWTH_FACTOR = 1.6;

/**
 * Resolve the reconnect backoff delay (ms) for a given retry attempt.
 *
 * The delay is built from an exponential ceiling (growth factor 1.6) that keeps
 * doubling-ish until it saturates at `max`, then FULL JITTER is applied across
 * `[0, ceiling]`. Full jitter de-synchronizes many clients that reconnect after
 * the same backend blip so they don't stampede the server (thundering herd),
 * while the exponential ceiling + hard `max` cap keep the delay from growing
 * unbounded. The returned value is always clamped to `[0, max]`.
 *
 * `rng` defaults to `Math.random` and is injectable so callers/tests can make
 * the jitter deterministic.
 *
 * Attempt indexing matches the previous behavior: attempt 1 -> base * 1.6,
 * attempt 2 -> base * 1.6^2, ... (the original loop grew the delay before its
 * first sleep, so the first reconnect ceiling is `base * 1.6`).
 */
export function resolveStreamRetryDelay(
  attempt: number,
  base: number = STREAM_RETRY_BASE_MS,
  max: number = STREAM_RETRY_MAX_MS,
  rng: () => number = Math.random,
): number {
  const safeBase = Number.isFinite(base) && base > 0 ? base : STREAM_RETRY_BASE_MS;
  const safeMax = Number.isFinite(max) && max >= safeBase ? max : safeBase;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  // Deterministic exponential ceiling, capped at the max delay.
  const ceiling = Math.min(safeMax, Math.round(safeBase * Math.pow(STREAM_RETRY_GROWTH_FACTOR, safeAttempt)));
  // Full jitter: pick a delay in [0, ceiling] so reconnects fan out over time.
  const sample = typeof rng === 'function' ? rng() : Math.random();
  const bounded = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : Math.random();
  const jittered = Math.round(bounded * ceiling);
  return Math.min(safeMax, Math.max(0, jittered));
}

function buildStreamUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  return `${trimmed}${path.startsWith('/') ? '' : '/'}${path}`;
}

function deriveWebSocketUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) {
    return `wss://${httpUrl.slice('https://'.length)}`;
  }
  if (httpUrl.startsWith('http://')) {
    return `ws://${httpUrl.slice('http://'.length)}`;
  }
  return httpUrl;
}

export class ChatRealtimeStream {
  private activeSubscriptions = new Map<string, CloseFn>();

  async subscribe<TMessage = unknown>(options: SubscribeOptions<TMessage>): Promise<CloseFn | null> {
    const {
      baseUrl,
      tenantId,
      userEmail,
      partnerEmail,
      onMessage,
      onMessageUpdate,
      onMessageDelete,
      onStatus,
      onError,
      onOpen,
    } = options;
    const key = `${tenantId}::${userEmail.toLowerCase()}::${partnerEmail.toLowerCase()}`;
    await this.teardown(key);

    let closed = false;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let currentClose: CloseFn | null = null;

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const start = async (): Promise<void> => {
      if (closed) {
        return;
      }

      const token = await internalTokenManager.getToken(baseUrl);
      if (!token) {
        logger.warn('chat.realtime.token.missing', { baseUrl });
        scheduleRetry();
        return;
      }

      const query = new URLSearchParams({
        token,
        tenantId,
        user: userEmail,
        partner: partnerEmail,
      });

      const sseUrl = `${buildStreamUrl(baseUrl, '/chat/stream')}?${query.toString()}`;
      const wsUrl = `${deriveWebSocketUrl(buildStreamUrl(baseUrl, '/chat/ws'))}?${query.toString()}`;
      const mode = this.pickMode();

      try {
        if (mode === 'sse') {
          currentClose = this.openEventSource<TMessage>(sseUrl, {
            onMessage,
            onMessageUpdate,
            onMessageDelete,
            onStatus,
            onOpen: () => {
              // A healthy connection resets the backoff to its base.
              retryAttempt = 0;
              onOpen?.();
            },
            onError: (error) => {
              if ((error as any)?.status === 401) {
                internalTokenManager.invalidate(baseUrl);
              }
              onError?.(error);
              scheduleRetry();
            },
          });
        } else {
          currentClose = await this.openWebSocket<TMessage>(wsUrl, {
            onMessage,
            onMessageUpdate,
            onMessageDelete,
            onStatus,
            onOpen: () => {
              // A healthy connection resets the backoff to its base.
              retryAttempt = 0;
              onOpen?.();
            },
            onError: (error) => {
              if ((error as any)?.code === 4401) {
                internalTokenManager.invalidate(baseUrl);
              }
              onError?.(error);
              scheduleRetry();
            },
          });
        }
      } catch (error) {
        logger.debug('chat.realtime.start.failed', { error });
        scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      if (closed) {
        return;
      }
      // Only ever keep ONE pending reconnect timer; drop any prior one so the
      // handle we store is always the live timer we can cancel on close().
      clearRetryTimer();
      retryAttempt += 1;
      const delay = resolveStreamRetryDelay(retryAttempt, STREAM_RETRY_BASE_MS, STREAM_RETRY_MAX_MS);
      retryTimer = setTimeout(() => {
        // The timer has fired; drop the stale handle before (maybe) reconnecting.
        retryTimer = null;
        if (closed) {
          return;
        }
        void start();
      }, delay);
    };

    await start();

    const close: CloseFn = () => {
      // Idempotent: safe to call multiple times. Always ensure no reconnect timer
      // lingers so start() can never be invoked again after close().
      if (closed) {
        clearRetryTimer();
        return;
      }
      closed = true;
      clearRetryTimer();
      try {
        currentClose?.();
      } catch {}
      this.activeSubscriptions.delete(key);
    };

    this.activeSubscriptions.set(key, close);
    return close;
  }

  private pickMode(): StreamMode {
    if (typeof EventSource !== 'undefined') {
      return 'sse';
    }
    return 'websocket';
  }

  private openEventSource<TMessage>(
    url: string,
    callbacks: Omit<ChatRealtimeCallbacks<TMessage>, 'onError'> & { onError: (error: unknown) => void }
  ): CloseFn {
    if (typeof EventSource === 'undefined') {
      throw new Error('EventSource not available');
    }

    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      callbacks.onOpen?.();
    };

    eventSource.onmessage = (event) => {
      this.dispatchPayload(event.data, callbacks);
    };

    eventSource.onerror = (error) => {
      try {
        eventSource.close();
      } catch {}
      callbacks.onError(error);
    };

    return () => {
      try {
        eventSource.close();
      } catch {}
    };
  }

  private openWebSocket<TMessage>(
    url: string,
    callbacks: ChatRealtimeCallbacks<TMessage> & { onError: (error: unknown) => void }
  ): CloseFn {
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      callbacks.onError(error);
      return () => undefined;
    }

    ws.onopen = () => {
      callbacks.onOpen?.();
    };

    ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : undefined;
      this.dispatchPayload(data, callbacks);
    };

    ws.onerror = (event) => {
      callbacks.onError(event);
    };

    ws.onclose = (event) => {
      if (event.code === 4401) {
        callbacks.onError({ code: 4401, reason: event.reason });
        return;
      }
      callbacks.onError({ code: event.code, reason: event.reason });
    };

    return () => {
      try {
        ws?.close();
      } catch {}
    };
  }

  private dispatchPayload<TMessage>(
    raw: string | null | undefined,
    callbacks: Pick<ChatRealtimeCallbacks<TMessage>, 'onMessage' | 'onMessageUpdate' | 'onMessageDelete' | 'onStatus'>
  ): void {
    if (!raw) {
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.debug('chat.realtime.parse.failed', { error });
      return;
    }
    const kind = parsed?.type;
    if (kind === 'message' && parsed?.payload) {
      callbacks.onMessage?.(parsed.payload as TMessage);
      return;
    }
    if (kind === 'message_update' && parsed?.payload) {
      callbacks.onMessageUpdate?.(parsed.payload as TMessage);
      return;
    }
    if (kind === 'message_delete' && parsed?.payload) {
      callbacks.onMessageDelete?.(parsed.payload as TMessage);
      return;
    }
    if (kind === 'status' && parsed?.payload) {
      callbacks.onStatus?.(parsed.payload as Record<string, unknown>);
      return;
    }
    if (kind === 'ping') {
      return;
    }
    logger.debug('chat.realtime.unknown', { payload: parsed });
  }

  private async teardown(key: string): Promise<void> {
    const existing = this.activeSubscriptions.get(key);
    if (existing) {
      try {
        existing();
      } catch {}
      this.activeSubscriptions.delete(key);
    }
  }
}

export const chatRealtimeStream = new ChatRealtimeStream();
