import webpush from 'web-push';

export type WebPushSubscriptionShape = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type WebPushNotificationPayload = {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  requireInteraction?: boolean;
  silent?: boolean;
  clickUrl?: string;
  data?: Record<string, unknown>;
};

type WebPushDeliveryResult = {
  ok: boolean;
  statusCode?: number;
  shouldDeleteSubscription?: boolean;
  errorCode?: string;
};

let vapidConfigured = false;
let vapidConfigAttempted = false;

export function getWebPushPublicKey(): string | null {
  const value = (process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim();
  return value || null;
}

function getWebPushPrivateKey(): string | null {
  const value = (process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
  return value || null;
}

function getWebPushSubject(): string | null {
  const value = (process.env.WEB_PUSH_VAPID_SUBJECT || '').trim();
  return value || null;
}

function configureVapid(): boolean {
  if (vapidConfigured) {
    return true;
  }
  if (vapidConfigAttempted) {
    return false;
  }

  vapidConfigAttempted = true;
  const publicKey = getWebPushPublicKey();
  const privateKey = getWebPushPrivateKey();
  const subject = getWebPushSubject();

  if (!publicKey || !privateKey || !subject) {
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

export function isWebPushConfigured(): boolean {
  return configureVapid();
}

export function sanitizeWebPushSubscription(input: unknown): WebPushSubscriptionShape | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const raw = input as Record<string, any>;
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
  const p256dh = typeof raw.keys?.p256dh === 'string' ? raw.keys.p256dh.trim() : '';
  const auth = typeof raw.keys?.auth === 'string' ? raw.keys.auth.trim() : '';

  if (!endpoint || !p256dh || !auth) {
    return null;
  }

  let expirationTime: number | null | undefined;
  if (raw.expirationTime === null) {
    expirationTime = null;
  } else if (typeof raw.expirationTime === 'number' && Number.isFinite(raw.expirationTime)) {
    expirationTime = raw.expirationTime;
  }

  return {
    endpoint,
    expirationTime,
    keys: { p256dh, auth },
  };
}

function normalizeClickUrl(payload: WebPushNotificationPayload): string {
  const explicit = typeof payload.clickUrl === 'string' ? payload.clickUrl.trim() : '';
  if (explicit) {
    return explicit;
  }

  const type = typeof payload.data?.type === 'string' ? payload.data.type : '';
  if ((type === 'chat_message' || type === 'team_chat_message') && typeof payload.data?.senderEmail === 'string') {
    const params = new URLSearchParams();
    params.set('senderEmail', String(payload.data.senderEmail));
    if (typeof payload.data?.chatId === 'string' && payload.data.chatId.trim()) {
      params.set('chatId', payload.data.chatId.trim());
    }
    if (typeof payload.data?.messageId === 'string' && payload.data.messageId.trim()) {
      params.set('messageId', payload.data.messageId.trim());
    }
    if (typeof payload.data?.senderName === 'string' && payload.data.senderName.trim()) {
      params.set('senderName', payload.data.senderName.trim());
    }
    return `/(tabs)/chat?${params.toString()}`;
  }

  return '/(tabs)';
}

export function buildWebPushPayload(payload: WebPushNotificationPayload): string {
  return JSON.stringify({
    title: payload.title,
    body: payload.body,
    icon: payload.icon || '/favicon.ico',
    badge: payload.badge || '/favicon.ico',
    tag: payload.tag,
    requireInteraction: Boolean(payload.requireInteraction),
    silent: Boolean(payload.silent),
    clickUrl: normalizeClickUrl(payload),
    data: payload.data || {},
  });
}

export async function sendWebPushNotification(options: {
  subscription: WebPushSubscriptionShape;
  payload: WebPushNotificationPayload;
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}): Promise<WebPushDeliveryResult> {
  if (!configureVapid()) {
    return { ok: false, errorCode: 'web_push_not_configured' };
  }

  try {
    await webpush.sendNotification(options.subscription, buildWebPushPayload(options.payload), {
      TTL: options.ttl ?? 60,
      urgency: options.urgency ?? 'normal',
    });
    return { ok: true };
  } catch (error: any) {
    const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : undefined;
    const shouldDeleteSubscription = statusCode === 404 || statusCode === 410;
    const errorCode = typeof error?.body === 'string' && error.body ? error.body : error?.message || 'web_push_failed';
    return {
      ok: false,
      statusCode,
      shouldDeleteSubscription,
      errorCode,
    };
  }
}