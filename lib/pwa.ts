// PWA Service Worker Registration
// This file registers the service worker for offline capabilities

function upsertMeta(name: string, content: string) {
  if (typeof document === 'undefined') return;
  const selector = `meta[name="${name}"]`;
  const existing = document.head?.querySelector(selector) as HTMLMetaElement | null;
  const el = existing || document.createElement('meta');
  el.setAttribute('name', name);
  el.setAttribute('content', content);
  if (!existing) document.head?.appendChild(el);
}

function upsertLink(rel: string, href: string, extra?: Record<string, string>) {
  if (typeof document === 'undefined') return;
  const selector = `link[rel="${rel}"]`;
  const existing = document.head?.querySelector(selector) as HTMLLinkElement | null;
  const el = existing || document.createElement('link');
  el.setAttribute('rel', rel);
  el.setAttribute('href', href);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
  }
  if (!existing) document.head?.appendChild(el);
}

function upsertThemeColorMeta(content: string, media?: string) {
  if (typeof document === 'undefined') return;
  const selector = media
    ? `meta[name="theme-color"][media="${media}"]`
    : 'meta[name="theme-color"]:not([media])';
  const existing = document.head?.querySelector(selector) as HTMLMetaElement | null;
  const el = existing || document.createElement('meta');
  el.setAttribute('name', 'theme-color');
  if (media) {
    el.setAttribute('media', media);
  } else {
    el.removeAttribute('media');
  }
  el.setAttribute('content', content);
  if (!existing) document.head?.appendChild(el);
}

function upsertPreloadFontLink(href: string) {
  if (typeof document === 'undefined') return;
  const selector = `link[rel="preload"][href="${href}"]`;
  const existing = document.head?.querySelector(selector) as HTMLLinkElement | null;
  const el = existing || document.createElement('link');
  el.setAttribute('rel', 'preload');
  el.setAttribute('as', 'font');
  el.setAttribute('type', 'font/ttf');
  el.setAttribute('href', href);
  el.setAttribute('crossorigin', 'anonymous');
  if (!existing) document.head?.appendChild(el);
}

/**
 * Ensure required PWA head tags exist.
 * This is important in Expo web dev, where the served HTML may not come from `web/index.html`.
 */
export function ensurePwaHeadTags() {
  if (typeof document === 'undefined') return;
  try {
    upsertMeta('application-name', 'Tuition Manager');
    upsertMeta('description', 'Complete tuition and coaching class management solution');
    upsertThemeColorMeta('#ffffff', '(prefers-color-scheme: light)');
    upsertThemeColorMeta('#1e293b', '(prefers-color-scheme: dark)');
    upsertThemeColorMeta('#1e293b');
    upsertMeta('mobile-web-app-capable', 'yes');
    upsertMeta('apple-mobile-web-app-capable', 'yes');
    upsertMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    upsertMeta('apple-mobile-web-app-title', 'Tuition Manager');

    upsertLink('manifest', '/manifest-r12.json');
    upsertLink('icon', '/favicon.ico');
    upsertLink('apple-touch-icon', '/pwa/apple-icon-180.png?v=20260407r12', { sizes: '180x180' });
  } catch {
    // ignore
  }
}

export function ensureWebFontPreloads() {
  if (typeof document === 'undefined') return;
  try {
    const fontUrls = [
      '/fonts/Inter_400Regular.ttf',
      '/fonts/Inter_500Medium.ttf',
      '/fonts/Inter_600SemiBold.ttf',
      '/fonts/Inter_700Bold.ttf',
      '/fonts/Poppins_400Regular.ttf',
      '/fonts/Poppins_500Medium.ttf',
      '/fonts/Poppins_600SemiBold.ttf',
      '/fonts/Poppins_700Bold.ttf',
    ];

    for (const fontUrl of fontUrls) {
      upsertPreloadFontLink(fontUrl);
    }
  } catch {
    // ignore
  }
}

export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const SERVICE_WORKER_URL = '/service-worker.js?v=20260407r12';

  // In development, a registered service worker commonly causes stale bundles to
  // be served on normal refresh (hard refresh bypasses the SW cache). Avoid
  // registering in dev, and proactively unregister any existing SW + caches.
  const isDev =
    // Expo sets __DEV__ globally.
    (typeof (globalThis as any).__DEV__ !== 'undefined' && Boolean((globalThis as any).__DEV__)) ||
    // Fallback for environments without __DEV__.
    (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production');

  const allowServiceWorkerInDev =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_ENABLE_DEV_SERVICE_WORKER === 'true'));

  if (isDev && !allowServiceWorkerInDev) {
    try {
      void navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
          try {
            void registration.unregister();
          } catch {
            // ignore
          }
        }
      });
    } catch {
      // ignore
    }

    try {
      if ('caches' in window) {
        void (window as any).caches.keys().then((keys: string[]) => {
          void Promise.all(
            keys.map((key) => {
              try {
                return (window as any).caches.delete(key);
              } catch {
                return Promise.resolve(false);
              }
            })
          );
        });
      }
    } catch {
      // ignore
    }

    return;
  }

  const doRegister = () => {
    fetch(SERVICE_WORKER_URL, { method: 'HEAD', cache: 'no-store' })
      .then((res) => {
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('javascript')) return null;
        return navigator.serviceWorker.register(SERVICE_WORKER_URL);
      })
      .then((registration) => {
        if (!registration) return;
        // Check for updates periodically
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              // Auto-update after 3 seconds
              setTimeout(() => {
                try {
                  newWorker.postMessage({ type: 'SKIP_WAITING' });
                } catch {
                  // ignore
                }
                try {
                  window.location.reload();
                } catch {
                  // ignore
                }
              }, 3000);
            }
          });
        });
      })
      .catch(() => {
        // ignore
      });
  };

  // If the page is already loaded, registering on 'load' would never run.
  if (document.readyState === 'complete') {
    doRegister();
    return;
  }

  window.addEventListener('load', doRegister, { once: true });
}

// Check if app is installed
export function isAppInstalled() {
  // Check if running in standalone mode
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
         (window.navigator as any).standalone === true;
  
  if (isStandalone) {
    // If running standalone, mark as installed in localStorage
    try {
      localStorage.setItem('tm:pwa-installed', 'true');
    } catch {}
    return true;
  }
  
  // Check if previously installed (stored in localStorage)
  try {
    return localStorage.getItem('tm:pwa-installed') === 'true';
  } catch {
    return false;
  }
}

// Handle PWA install prompt
let deferredPrompt: any = null;
let installPromptInitialized = false;

export function initPWAInstallPrompt() {
  if (typeof window === 'undefined') return;
  if (installPromptInitialized) return;
  installPromptInitialized = true;

  window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    // Stash the event so it can be triggered later
    deferredPrompt = e;

    try {
      window.dispatchEvent(new Event('tm:pwa-install-available'));
    } catch {
      // ignore
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;

    // Mark as installed in localStorage
    try {
      localStorage.setItem('tm:pwa-installed', 'true');
    } catch {}

    try {
      window.dispatchEvent(new Event('tm:pwa-installed'));
    } catch {
      // ignore
    }
  });
}

export async function showInstallPrompt() {
  if (!deferredPrompt) {
    return false;
  }

  // Show the install prompt
  deferredPrompt.prompt();

  // Wait for the user to respond
  const { outcome } = await deferredPrompt.userChoice;

  // If accepted, mark as installed
  if (outcome === 'accepted') {
    try {
      localStorage.setItem('tm:pwa-installed', 'true');
      window.dispatchEvent(new Event('tm:pwa-installed'));
    } catch {}
  }

  // Clear the deferred prompt
  deferredPrompt = null;

  return outcome === 'accepted';
}

export function canShowInstallPrompt() {
  return deferredPrompt !== null;
}
