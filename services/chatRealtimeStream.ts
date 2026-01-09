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
    let retryDelay = STREAM_RETRY_BASE_MS;
    let currentClose: CloseFn | null = null;

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
              retryDelay = STREAM_RETRY_BASE_MS;
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
              retryDelay = STREAM_RETRY_BASE_MS;
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
      retryDelay = Math.min(STREAM_RETRY_MAX_MS, Math.round(retryDelay * 1.6));
      setTimeout(() => {
        void start();
      }, retryDelay);
    };

    await start();

    const close: CloseFn = () => {
      closed = true;
      currentClose?.();
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
