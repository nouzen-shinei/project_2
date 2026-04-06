self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

const FONT_CACHE = 'tm-font-cache-v1';

function isFontRequest(request) {
  if (!request || request.method !== 'GET') {
    return false;
  }

  const destination = request.destination || '';
  if (destination === 'font') {
    return true;
  }

  try {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) {
      return false;
    }
    return /\.(woff2?|ttf|otf)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isFontRequest(request)) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(FONT_CACHE);
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }

    try {
      const networkResponse = await fetch(request);
      if (networkResponse && networkResponse.ok) {
        cache.put(request, networkResponse.clone()).catch(() => {});
      }
      return networkResponse;
    } catch {
      if (cached) {
        return cached;
      }
      throw new Error('font_fetch_failed');
    }
  })());
});

const DIAGNOSTICS_DB_NAME = 'tm-web-push-diagnostics';
const DIAGNOSTICS_STORE_NAME = 'kv';

function openDiagnosticsDb() {
  return new Promise((resolve, reject) => {
    const request = self.indexedDB.open(DIAGNOSTICS_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DIAGNOSTICS_STORE_NAME)) {
        db.createObjectStore(DIAGNOSTICS_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb_open_failed'));
  });
}

async function writeDiagnostic(key, value) {
  try {
    const db = await openDiagnosticsDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DIAGNOSTICS_STORE_NAME, 'readwrite');
      tx.objectStore(DIAGNOSTICS_STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('indexeddb_write_failed'));
      tx.onabort = () => reject(tx.error || new Error('indexeddb_write_aborted'));
    });
    db.close();
  } catch {
  }
}

async function notifyClients(message) {
  const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    client.postMessage(message);
  }
}

function resolveClickUrl(payload) {
  const explicit = typeof payload?.clickUrl === 'string' ? payload.clickUrl.trim() : '';
  if (explicit) {
    return explicit;
  }

  const data = payload?.data || {};
  const type = typeof data.type === 'string' ? data.type : '';
  if ((type === 'chat_message' || type === 'team_chat_message') && typeof data.senderEmail === 'string') {
    const params = new URLSearchParams();
    params.set('senderEmail', data.senderEmail);
    if (typeof data.chatId === 'string' && data.chatId) {
      params.set('chatId', data.chatId);
    }
    if (typeof data.messageId === 'string' && data.messageId) {
      params.set('messageId', data.messageId);
    }
    if (typeof data.senderName === 'string' && data.senderName) {
      params.set('senderName', data.senderName);
    }
    return `/(tabs)/chat?${params.toString()}`;
  }

  return '/(tabs)';
}

function parsePushPayload(event) {
  if (!event.data) {
    return { title: 'Tuition Manager', body: '', data: {}, clickUrl: '/(tabs)' };
  }

  try {
    const json = event.data.json();
    return {
      title: json.title || 'Tuition Manager',
      body: json.body || '',
      icon: json.icon || '/favicon.ico',
      badge: json.badge || '/favicon.ico',
      tag: json.tag,
      requireInteraction: Boolean(json.requireInteraction),
      silent: Boolean(json.silent),
      data: json.data || {},
      clickUrl: resolveClickUrl(json),
    };
  } catch {
    return {
      title: 'Tuition Manager',
      body: event.data.text(),
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      data: {},
      clickUrl: '/(tabs)',
    };
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);
  event.waitUntil(
    (async () => {
      const diagnostic = {
        receivedAt: new Date().toISOString(),
        title: payload.title,
        tag: payload.tag || null,
        clickUrl: payload.clickUrl || null,
        type: typeof payload.data?.type === 'string' ? payload.data.type : null,
        notificationId: typeof payload.data?.notificationId === 'string' ? payload.data.notificationId : null,
      };

      await writeDiagnostic('lastPushReceipt', diagnostic);
      await notifyClients({ type: 'tm:web-push-received', payload: diagnostic });

      await self.registration.showNotification(payload.title, {
        body: payload.body,
        icon: payload.icon,
        badge: payload.badge,
        tag: payload.tag,
        requireInteraction: payload.requireInteraction,
        silent: payload.silent,
        data: {
          ...(payload.data || {}),
          clickUrl: payload.clickUrl,
        },
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetPath =
    (event.notification && event.notification.data && event.notification.data.clickUrl) || '/(tabs)';
  const targetUrl = new URL(targetPath, self.location.origin).toString();

  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin !== self.location.origin) {
          continue;
        }
        if (typeof client.navigate === 'function') {
          await client.navigate(targetUrl);
        }
        await client.focus();
        return;
      } catch {
      }
    }

    await self.clients.openWindow(targetUrl);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const diagnostic = {
      changedAt: new Date().toISOString(),
      reason: 'pushsubscriptionchange',
    };
    await writeDiagnostic('lastSubscriptionChange', diagnostic);
    await notifyClients({ type: 'tm:web-push-resubscribe-needed', payload: diagnostic });
  })());
});