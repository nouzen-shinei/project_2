// CSP injection utility for web builds.
// Generates a tighter policy in production.

import { BUILD_ENV, isProd } from '../runtimeEnv';
// Attempt to load pre-generated CSP hashes manifest (optional)
let STYLE_HASHES: string[] = [];
let SCRIPT_HASHES: string[] = [];
try {
  // @ts-ignore - will exist after build if generated
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const manifest = require('../../csp-hashes.json');
  if (manifest?.style) STYLE_HASHES = manifest.style;
  if (manifest?.script) SCRIPT_HASHES = manifest.script;
} catch {}

interface InjectOptions {
  extraConnect?: string[]; // allow callers to append connect-src endpoints
  extraScript?: string[]; // allow callers to append script-src origins (e.g., Firebase RTDB JSONP, Google APIs)
  extraFrame?: string[];   // allow callers to append frame-src origins
}

export function injectCSP(opts: InjectOptions = {}) {
  if (typeof document === 'undefined') return; // native platforms
  const existing = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  if (existing) return; // already present (avoid duplicates / hydration mismatch)

  const connectExtra = (opts.extraConnect || []).join(' ');
  const scriptExtra = (opts.extraScript || []).join(' ');
  const frameExtra = (opts.extraFrame || []).join(' ');

  // Development often needs eval for React Refresh / source maps.
  const styleHashesEnabled = isProd && STYLE_HASHES.length > 0;
  const scriptHashes = SCRIPT_HASHES.length ? SCRIPT_HASHES.join(' ') : '';
  const styleHashes = styleHashesEnabled ? STYLE_HASHES.join(' ') : '';

  const scriptSrc = isProd
    ? ["'self'", scriptHashes, scriptExtra].filter(Boolean).join(' ')
    : ["'self'", "'unsafe-eval'", scriptHashes, scriptExtra].filter(Boolean).join(' ');

  // React Native Web emits runtime style attributes; permit style attrs explicitly.
  // Cannot use hashes since RN Web generates unpredictable dynamic inline styles.
  const styleSrc = ["'self'", "'unsafe-inline'", 'https:'].join(' ');

  // NOTE: Some directives (frame-ancestors, report-uri, report-to) are ignored by browsers when delivered via <meta>.
  // We exclude those that are guaranteed to be ignored to avoid console noise. Use real HTTP headers at CDN/server for enforcement.
  // frame-ancestors should be sent as an HTTP header for clickjacking protection.
  // Reporting should rely on Report-To / Content-Security-Policy-Report-Only headers server-side.
  const directives: string[] = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    // frame-ancestors intentionally omitted (ignored in meta)
    `form-action 'self'`,
    // Fonts & images allow data: URIs for embedded assets
    `img-src 'self' data: https:`,
    `font-src 'self' data: https:`,
  `media-src 'self' data: blob: https:`,
    `style-src ${styleSrc}`,
    `style-src-attr 'unsafe-inline'`,
    `script-src ${scriptSrc}`,
  // Allow websocket (dev) & https API calls, and data/blob URIs for local file reads on web
  `connect-src 'self' https: wss: data: blob: ${connectExtra}`.trim(),
  // Allow frames if needed (some Firebase transports create hidden iframes)
  `frame-src 'self' ${frameExtra}`.trim(),
    'upgrade-insecure-requests'
  ];

  const meta = document.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = directives.join('; ');
  document.head.appendChild(meta);

  // We still append a pseudo Report-To definition for future-proofing; many browsers will ignore when not a header.
  const reportMeta = document.createElement('meta');
  reportMeta.httpEquiv = 'Report-To';
  reportMeta.content = JSON.stringify({
    group: 'csp-endpoint',
    max_age: 10886400,
    endpoints: [{ url: '/csp-report' }],
    include_subdomains: true
  });
  document.head.appendChild(reportMeta);

  // Additional non-CSP security meta (best-effort; real headers should come from server/CDN)
  ensureMeta('Referrer-Policy', 'strict-origin-when-cross-origin');
  ensureMeta('X-Content-Type-Options', 'nosniff'); // Some browsers ignore via meta; set server-side ideally
  ensureMeta('X-DNS-Prefetch-Control', 'off');
}

function ensureMeta(name: string, content: string) {
  if (document.querySelector(`meta[name="${name}"]`)) return;
  const m = document.createElement('meta');
  m.setAttribute('name', name);
  m.setAttribute('content', content);
  document.head.appendChild(m);
}

// Optional helper to report current policy (debug only)
export function reportCurrentCSP() {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  // eslint-disable-next-line no-console
  console.info('[CSP]', BUILD_ENV, meta?.getAttribute('content'));
}
