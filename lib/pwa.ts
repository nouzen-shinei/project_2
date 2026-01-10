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

/**
 * Ensure required PWA head tags exist.
 * This is important in Expo web dev, where the served HTML may not come from `web/index.html`.
 */
export function ensurePwaHeadTags() {
  if (typeof document === 'undefined') return;
  try {
    upsertMeta('application-name', 'Tuition Manager');
    upsertMeta('description', 'Complete tuition and coaching class management solution');
    upsertMeta('theme-color', '#4f46e5');
    upsertMeta('mobile-web-app-capable', 'yes');
    upsertMeta('apple-mobile-web-app-capable', 'yes');
    upsertMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
    upsertMeta('apple-mobile-web-app-title', 'Tuition Manager');

    upsertLink('manifest', '/manifest.json');
    upsertLink('icon', '/favicon.ico');
    upsertLink('apple-touch-icon', '/pwa/apple-touch-icon-180.png', { sizes: '180x180' });
  } catch {
    // ignore
  }
}

export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const doRegister = () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((registration) => {
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
