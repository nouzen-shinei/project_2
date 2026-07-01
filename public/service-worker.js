// ─── Cache names ─────────────────────────────────────────────────────────────
const FONT_CACHE = 'tm-font-cache-v1';
const SHELL_CACHE = 'tm-shell-cache-v12';
const OFFLINE_URL = '/offline.html';
const SHELL_CACHE_ASSETS = [OFFLINE_URL];

// ─── IndexedDB — diagnostics (existing, version unchanged) ───────────────────
const DIAG_DB_NAME = 'tm-web-push-diagnostics';
const DIAG_DB_VERSION = 1;
const DIAG_STORE = 'kv';

// ─── IndexedDB — SW state (new, separate DB to avoid version conflicts) ───────
// Stores auth credentials the page pushes to the SW so the SW can confirm
// chat-message delivery directly from within event.waitUntil without depending
// on a live page tab.
const STATE_DB_NAME = 'tm-sw-state';
const STATE_DB_VERSION = 1;
const CREDS_STORE = 'sw-creds';

// Cached connections — reuse across push events to avoid open/close overhead.
let _diagDb = null;
let _stateDb = null;

function _openDb(name, version, upgradeHandler) {
  return new Promise((resolve, reject) => {
    const req = self.indexedDB.open(name, version);
    req.onupgradeneeded = upgradeHandler;
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        if (name === DIAG_DB_NAME) _diagDb = null;
        else if (name === STATE_DB_NAME) _stateDb = null;
      };
      db.onerror = () => {
        if (name === DIAG_DB_NAME) _diagDb = null;
        else if (name === STATE_DB_NAME) _stateDb = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('idb_open_failed:' + name));
  });
}

function openDiagDb() {
  if (_diagDb) return Promise.resolve(_diagDb);
  return _openDb(DIAG_DB_NAME, DIAG_DB_VERSION, (event) => {
    const db = event.target.result;
    if (!db.objectStoreNames.contains(DIAG_STORE)) {
      db.createObjectStore(DIAG_STORE);
    }
  }).then((db) => {
    _diagDb = db;
    return db;
  });
}

function openStateDb() {
  if (_stateDb) return Promise.resolve(_stateDb);
  return _openDb(STATE_DB_NAME, STATE_DB_VERSION, (event) => {
    const db = event.target.result;
    if (!db.objectStoreNames.contains(CREDS_STORE)) {
      db.createObjectStore(CREDS_STORE);
    }
  }).then((db) => {
    _stateDb = db;
    return db;
  });
}

function idbPut(openFn, store, key, value) {
  return openFn().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('idb_put_failed'));
        tx.onabort = () => reject(tx.error || new Error('idb_put_aborted'));
      })
  );
}

function idbDelete(openFn, store, key) {
  return openFn().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('idb_delete_failed'));
        tx.onabort = () => reject(tx.error || new Error('idb_delete_aborted'));
      })
  );
}

function idbGet(openFn, store, key) {
  return openFn().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readonly');
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error || new Error('idb_get_failed'));
      })
  );
}

// Diagnostics helpers — fire-and-forget, never throw to caller.
async function writeDiagnostic(key, value) {
  try {
    await idbPut(openDiagDb, DIAG_STORE, key, value);
  } catch {
    // diagnostics are non-critical
  }
}

// SW credential helpers — read/write from the dedicated state DB.
async function readSwCreds() {
  try {
    return await idbGet(openStateDb, CREDS_STORE, 'deliveryCreds');
  } catch {
    return null;
  }
}

async function writeSwCreds(creds) {
  try {
    if (creds) {
      await idbPut(openStateDb, CREDS_STORE, 'deliveryCreds', creds);
    } else {
      await idbDelete(openStateDb, CREDS_STORE, 'deliveryCreds');
    }
  } catch {
    // ignore
  }
}

// ─── Client helpers ───────────────────────────────────────────────────────────

async function getAllWindowClients() {
  try {
    return await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    return [];
  }
}

/**
 * Notify ALL open window clients (e.g. for UI updates like badge counts).
 * Errors from individual client.postMessage calls are swallowed so a bad
 * client cannot prevent the remaining clients from being notified.
 */
async function broadcastToClients(message) {
  const clientList = await getAllWindowClients();
  for (const client of clientList) {
    try {
      client.postMessage(message);
    } catch {
      // ignore disconnected / unresponsive clients
    }
  }
}

/**
 * Send a message to exactly ONE client, preferring a visible (foreground) one.
 * Returns true if a client was found.
 * Used for delivery-confirmation relay so multiple tabs don't race to call
 * the same API endpoint.
 */
async function sendToOneClient(message) {
  const clientList = await getAllWindowClients();
  if (!clientList.length) return false;
  const target =
    clientList.find((c) => c.visibilityState === 'visible') || clientList[0];
  try {
    target.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

// ─── install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(SHELL_CACHE_ASSETS);
      } catch {
        // ignore
      }
      await self.skipWaiting();
    })()
  );
});

// ─── activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter((name) => name !== FONT_CACHE && name !== SHELL_CACHE)
            .map((name) => caches.delete(name))
        );
      } catch {
        // ignore
      }
      await self.clients.claim();
    })()
  );
});

// ─── message ──────────────────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  if (!event.data) return;
  const type = event.data.type;

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Page pushes auth credentials so the SW can confirm chat delivery directly,
  // without depending on page JavaScript being live in a background tab.
  if (type === 'SW_SET_DELIVERY_CREDENTIALS') {
    const { baseUrl, token, expiresAt, tenantId, userEmail } = event.data;
    if (baseUrl && token && typeof expiresAt === 'number') {
      event.waitUntil(
        writeSwCreds({
          baseUrl: String(baseUrl),
          token: String(token),
          expiresAt: Number(expiresAt),
          tenantId: typeof tenantId === 'string' ? tenantId : null,
          userEmail: typeof userEmail === 'string' ? userEmail.toLowerCase() : null,
          savedAt: Date.now(),
        })
      );
    }
    return;
  }

  if (type === 'SW_CLEAR_DELIVERY_CREDENTIALS') {
    event.waitUntil(writeSwCreds(null));
    return;
  }
});

// ─── fetch ────────────────────────────────────────────────────────────────────

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

function isNavigationRequest(request) {
  if (!request || request.method !== 'GET') {
    return false;
  }
  return request.mode === 'navigate' || request.destination === 'document';
}

async function handleNavigationRequest(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const offlineResponse = await cache.match(OFFLINE_URL);
    if (offlineResponse) {
      return offlineResponse;
    }

    return new Response(
      '<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>Offline</title></head><body style="margin:0;background:#111;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">You\'re offline</body></html>',
      {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;

  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  if (!isFontRequest(request)) {
    return;
  }

  event.respondWith(
    (async () => {
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
    })()
  );
});

// ─── Push payload parsing ─────────────────────────────────────────────────────

function resolveClickUrl(payload) {
  const explicit = typeof payload?.clickUrl === 'string' ? payload.clickUrl.trim() : '';
  if (explicit) {
    return explicit;
  }

  const data = payload?.data || {};
  const type = typeof data.type === 'string' ? data.type : '';
  if (
    (type === 'chat_message' || type === 'team_chat_message') &&
    typeof data.senderEmail === 'string'
  ) {
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

// ─── Direct SW delivery confirmation ─────────────────────────────────────────
//
// When the page has previously stored credentials via SW_SET_DELIVERY_CREDENTIALS
// the SW can call the backend directly inside event.waitUntil.  This guarantees
// the delivered receipt is confirmed even when all tabs are backgrounded or
// throttled by the browser — without relying on live page JavaScript at all.

async function trySWDeliveryConfirmation(creds, receiptData) {
  if (!creds || !creds.token || !creds.baseUrl) return false;
  // Reject expired credentials (with 30 s margin).
  if (typeof creds.expiresAt === 'number' && creds.expiresAt - 30_000 < Date.now()) return false;

  const messageId = receiptData.messageId;
  const senderEmail = receiptData.senderEmail;
  // Prefer tenantId from push payload, fall back to stored credential tenantId.
  const tenantId = receiptData.tenantId || creds.tenantId;

  if (!messageId || !senderEmail || !tenantId) return false;

  // Never confirm delivery for our own messages.
  if (
    creds.userEmail &&
    senderEmail.toLowerCase() === creds.userEmail.toLowerCase()
  ) {
    return false;
  }

  try {
    const response = await fetch(
      `${creds.baseUrl}/chat/receipts/outbound-delivered`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${creds.token}`,
        },
        body: JSON.stringify({
          tenantId,
          partnerEmail: senderEmail,
          deliveredMessageIds: [messageId],
          provenance: 'sw_push',
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ─── push ─────────────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);

  event.waitUntil(
    (async () => {
      // --- 1. Extract typed receipt data from the push payload ---------------
      const rawData =
        payload && payload.data && typeof payload.data === 'object'
          ? payload.data
          : {};

      const receiptData = {
        type:
          typeof rawData.type === 'string' ? rawData.type : null,
        messageId:
          typeof rawData.messageId === 'string' ? rawData.messageId : null,
        senderEmail:
          typeof rawData.senderEmail === 'string' ? rawData.senderEmail : null,
        recipientEmail:
          typeof rawData.recipientEmail === 'string'
            ? rawData.recipientEmail
            : null,
        tenantId:
          typeof rawData.tenantId === 'string' ? rawData.tenantId : null,
        chatId:
          typeof rawData.chatId === 'string' ? rawData.chatId : null,
        timestamp:
          typeof rawData.timestamp === 'string' ? rawData.timestamp : null,
      };

      const isChatPush =
        receiptData.type === 'chat_message' ||
        receiptData.type === 'team_chat_message';

      // --- 2. Write diagnostic (non-critical, never throws) ------------------
      const diagnostic = {
        receivedAt: new Date().toISOString(),
        title: payload.title,
        // body is forwarded to the page so it can reconstruct the notification
        // via registration.showNotification() when the app is in the foreground.
        body: payload.body || '',
        tag: payload.tag || null,
        clickUrl: payload.clickUrl || null,
        type: receiptData.type,
        notificationId:
          typeof rawData.notificationId === 'string'
            ? rawData.notificationId
            : null,
        notificationData: receiptData,
      };
      await writeDiagnostic('lastPushReceipt', diagnostic);

      // --- 3. Try to confirm delivery directly from the SW -------------------
      //
      // This is the primary delivery path when tabs are backgrounded/throttled.
      // The result is forwarded to clients so they skip their own API call and
      // avoid duplicate requests.
      let swDeliveryConfirmed = false;
      if (isChatPush && receiptData.messageId && receiptData.senderEmail) {
        const creds = await readSwCreds();
        if (creds) {
          swDeliveryConfirmed = await trySWDeliveryConfirmation(
            creds,
            receiptData
          );
          if (swDeliveryConfirmed) {
            await writeDiagnostic('lastSwDirectDelivery', {
              confirmedAt: new Date().toISOString(),
              messageId: receiptData.messageId,
              senderEmail: receiptData.senderEmail,
            });
          }
        }
      }

      // --- 4. Determine window visibility for smart notification display -----
      const allClients = await getAllWindowClients();
      const hasVisibleClient = allClients.some(
        (c) => c.visibilityState === 'visible'
      );

      // --- 5. Notify clients ------------------------------------------------
      //
      // Broadcast the push event to ALL clients for UI updates (badge counts,
      // in-app notification banners, etc.).
      //
      // The `swDeliveryConfirmed` flag tells the page handler whether it needs
      // to call the delivery API itself (fallback) or can skip it.
      //
      // We also include a `notifyDelivery` flag only for ONE client — the
      // visible one if any, otherwise the first.  This prevents multiple tabs
      // from all racing to confirm delivery when the SW didn't have credentials.
      const deliveryFallbackClientId =
        !swDeliveryConfirmed && allClients.length > 0
          ? (
              allClients.find((c) => c.visibilityState === 'visible') ||
              allClients[0]
            ).id
          : null;

      for (const client of allClients) {
        try {
          client.postMessage({
            type: 'tm:web-push-received',
            payload: diagnostic,
            notificationData: receiptData,
            // If the SW already confirmed delivery, tell the page to skip the
            // API call.  If not, only the designated fallback client should do it.
            swDeliveryConfirmed,
            shouldConfirmDelivery:
              !swDeliveryConfirmed && client.id === deliveryFallbackClientId,
          });
        } catch {
          // individual client errors must not block the rest
        }
      }

      // --- 6. Show system notification ----------------------------------------
      //
      // For CHAT pushes: only show the system notification when no window is
      // visible.  When the page is visible it handles the notification itself
      // via registration.showNotification() (sendWebNotification), so we skip
      // here to avoid a duplicate on top of the in-app one.
      //
      // For ALL OTHER push types (daily quote, fee reminder, notice, etc.):
      // always show the system notification regardless of window visibility.
      // These types have no RTDB listener that could cause a duplicate, and the
      // user must see them even while actively using the app on a different page.
      const suppressForVisibleChat = hasVisibleClient && isChatPush;
      if (!suppressForVisibleChat) {
        try {
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
        } catch {
          // Permission revoked between subscription and push arriving — ignore.
        }
      }
    })()
  );
});

// ─── notificationclick ────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetPath =
    (event.notification &&
      event.notification.data &&
      event.notification.data.clickUrl) ||
    '/(tabs)';

  let targetUrl;
  try {
    targetUrl = new URL(targetPath, self.location.origin).toString();
  } catch {
    targetUrl = new URL('/(tabs)', self.location.origin).toString();
  }

  event.waitUntil(
    (async () => {
      try {
        const clientList = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });

        // Prefer a same-origin client that can be navigated to the target URL.
        for (const client of clientList) {
          try {
            const clientUrl = new URL(client.url);
            if (clientUrl.origin !== self.location.origin) {
              continue;
            }
            if (typeof client.navigate === 'function') {
              await client.navigate(targetUrl);
            }
            if (typeof client.focus === 'function') {
              await client.focus();
            }
            return;
          } catch {
            // try next client
          }
        }

        // No reusable client found — open a new window.
        await self.clients.openWindow(targetUrl);
      } catch {
        // If all else fails, silently ignore so the notification click
        // doesn't show an error banner.
      }
    })()
  );
});

// ─── pushsubscriptionchange ───────────────────────────────────────────────────

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const diagnostic = {
          changedAt: new Date().toISOString(),
          reason: 'pushsubscriptionchange',
        };
        await writeDiagnostic('lastSubscriptionChange', diagnostic);
        // Clear stored credentials so the page is forced to re-subscribe and
        // push fresh credentials to the SW.
        await writeSwCreds(null);
        await broadcastToClients({
          type: 'tm:web-push-resubscribe-needed',
          payload: diagnostic,
        });
      } catch {
        // ignore
      }
    })()
  );
});
