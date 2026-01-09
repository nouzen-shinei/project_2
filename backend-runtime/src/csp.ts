// Server-side CSP header builder.
// Generates both enforcement (Content-Security-Policy) and optional report-only header.
// Consumes optional hash manifest JSON with shape { style: string[], script: string[] }.

import fs from 'node:fs';

interface HashManifest { style?: string[]; script?: string[] }

export interface CspBuildOptions {
  extraConnect?: string[];
  extraScript?: string[]; // additional allowed script origins (e.g., Firebase RTDB JSONP)
  extraFrame?: string[]; // additional allowed frame origins (e.g., Firebase RTDB hidden iframes)
  hashManifestPath?: string; // override path to hash file
  reportOnly?: boolean; // build report-only policy (used when tuning)
}

export interface CspResult {
  headerName: 'Content-Security-Policy' | 'Content-Security-Policy-Report-Only';
  policy: string;
  reportTo?: string; // JSON for Report-To header
}

export function loadHashes(p?: string): HashManifest {
  const target = p && fs.existsSync(p)
    ? p
    : (process.env.CSP_HASHES_PATH && fs.existsSync(process.env.CSP_HASHES_PATH))
      ? process.env.CSP_HASHES_PATH
      : null;
  if (!target) return {};
  try {
    const data = JSON.parse(fs.readFileSync(target, 'utf8')) as HashManifest;
    return data;
  } catch {
    return {};
  }
}

export function buildCsp(opts: CspBuildOptions = {}): CspResult {
  const { extraConnect = [], extraScript = [], extraFrame = [], hashManifestPath, reportOnly = false } = opts;
  const hashes = loadHashes(hashManifestPath);
  const styleHashes = hashes.style?.length ? hashes.style.join(' ') : '';
  const scriptHashes = hashes.script?.length ? hashes.script.join(' ') : '';

  const scriptSrc = ["'self'", scriptHashes, ...extraScript].filter(Boolean).join(' ');
  const styleSrc = hashes.style?.length
    ? ["'self'", styleHashes].join(' ')
    : ["'self'", "'unsafe-inline'"].join(' ');

  const connectSrc = ["'self'", 'https:', 'wss:', 'data:', 'blob:', ...extraConnect].join(' ');
  const frameSrc = ["'self'", ...extraFrame].join(' ');

  const directives: string[] = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
  "media-src 'self' data: https:",
    `style-src ${styleSrc} https:`,
    `script-src ${scriptSrc}`,
  `connect-src ${connectSrc}`,
  `frame-src ${frameSrc}`,
    'upgrade-insecure-requests',
    'report-to csp-endpoint'
  ];

  // Provide a fallback report-uri for older UAs
  directives.push('report-uri /csp-report');

  return {
    headerName: reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
    policy: directives.join('; '),
    reportTo: JSON.stringify({
      group: 'csp-endpoint',
      max_age: 10886400,
      endpoints: [{ url: '/csp-report' }],
      include_subdomains: true
    })
  };
}

// Simple Express-style middleware factory
export function cspMiddleware(opts: Omit<CspBuildOptions, 'reportOnly'> & { enableReportOnlyHeader?: boolean }) {
  return (req: any, res: any, next: any) => {
    // Only attach to HTML navigation/document requests (heuristic)
    const accept = req.headers['accept'] || '';
    if (typeof accept === 'string' && accept.includes('text/html')) {
      const reportOnly = process.env.CSP_REPORT_ONLY_MODE === '1';
      const result = buildCsp({ ...opts, reportOnly: false });
      res.setHeader(result.headerName, result.policy);
      if (result.reportTo) res.setHeader('Report-To', result.reportTo);
      if (opts.enableReportOnlyHeader || reportOnly) {
        const ro = buildCsp({ ...opts, reportOnly: true });
        res.setHeader(ro.headerName, ro.policy);
      }
    }
    next();
  };
}
