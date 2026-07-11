import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';
import { resolveStreamRetryDelay } from './chatRealtimeStream';

// Per-user inbound-message stream client (chat-production-hardening —
// messageIndex read lockdown). Mirrors `chatRealtimeStream` (SSE with a
// WebSocket fallback, full-jitter reconnect backoff, single-flight subscription
// per key) but subscribes to the PER-USER `/chat/inbox-stream` (`/chat/inbox-ws`)
// endpoint that streams the caller's own inbound messages. It exists so the
// client no longer has to read the RTDB `messageIndex` node directly to power
// in-app chat notifications.

export interface ChatInboxCallbacks<TPayload = unknown> {
  onInbound?: (payload: TPayload) => void;
  onStatus?: (payload: Record<string, unknown>) => void;
  onError?: (error: unknown) => void;
  onOpen?: () => void;
}

interface InboxSubscribeOptions<TPayload> extends ChatInboxCallbacks<TPayload> {
  baseUrl: string;
  tenantId: string;
  userEmail: string;
}

type CloseFn = () => void;

type StreamMode = 'sse' | 'websocket';

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

export class ChatInboxStream {
  private activeSubscriptions = new Map<string, CloseFn>();

  async subscribe<TPayload = unknown>(options: InboxSubscribeOptions<TPayload>): Promise<CloseFn | null> {
    const { baseUrl, tenantId, userEmail, onInbound, onStatus, onError, onOpen } = options;
    const key = `${tenantId}::${userEmail.toLowerCase()}`;
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
        logger.warn('chat.inbox.token.missing', { baseUrl });
        scheduleRetry();
        return;
      }

      const query = new URLSearchParams({
        token,
        tenantId,
        user: userEmail,
      });

      const sseUrl = `${buildStreamUrl(baseUrl, '/chat/inbox-stream')}?${query.toString()}`;
      const wsUrl = `${deriveWebSocketUrl(buildStreamUrl(baseUrl, '/chat/inbox-ws'))}?${query.toString()}`;
      const mode = this.pickMode();

      try {
        if (mode === 'sse') {
          currentClose = this.openEventSource<TPayload>(sseUrl, {
            onInbound,
            onStatus,
            onOpen: () => {
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
          currentClose = this.openWebSocket<TPayload>(wsUrl, {
            onInbound,
            onStatus,
            onOpen: () => {
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
        logger.debug('chat.inbox.start.failed', { error });
        scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      if (closed) {
        return;
      }
      clearRetryTimer();
      retryAttempt += 1;
      const delay = resolveStreamRetryDelay(retryAttempt);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (closed) {
          return;
        }
        void start();
      }, delay);
    };

    await start();

    const close: CloseFn = () => {
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

  private openEventSource<TPayload>(
    url: string,
    callbacks: Omit<ChatInboxCallbacks<TPayload>, 'onError'> & { onError: (error: unknown) => void }
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

  private openWebSocket<TPayload>(
    url: string,
    callbacks: ChatInboxCallbacks<TPayload> & { onError: (error: unknown) => void }
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
      callbacks.onError({ code: event.code, reason: event.reason });
    };

    return () => {
      try {
        ws?.close();
      } catch {}
    };
  }

  private dispatchPayload<TPayload>(
    raw: string | null | undefined,
    callbacks: Pick<ChatInboxCallbacks<TPayload>, 'onInbound' | 'onStatus'>
  ): void {
    if (!raw) {
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.debug('chat.inbox.parse.failed', { error });
      return;
    }
    const kind = parsed?.type;
    if (kind === 'inbound' && parsed?.payload) {
      callbacks.onInbound?.(parsed.payload as TPayload);
      return;
    }
    if (kind === 'status' && parsed?.payload) {
      callbacks.onStatus?.(parsed.payload as Record<string, unknown>);
      return;
    }
    if (kind === 'ready' && parsed?.payload) {
      callbacks.onStatus?.(parsed.payload as Record<string, unknown>);
      return;
    }
    if (kind === 'ping') {
      return;
    }
    logger.debug('chat.inbox.unknown', { payload: parsed });
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

export const chatInboxStream = new ChatInboxStream();
