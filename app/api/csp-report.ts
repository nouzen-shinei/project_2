// Expo Router route (web only effectively) to collect CSP violation reports.
// Browsers POST a JSON payload (application/csp-report or application/reports+json).
// We log minimal info; DO NOT include PII. In production you could forward to a backend endpoint.

import { Platform } from 'react-native';

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let body: any = null;
    if (contentType.includes('application/json') || contentType.includes('application/csp-report') || contentType.includes('application/reports+json')) {
      body = await request.json().catch(() => null);
    } else {
      body = { unsupportedContentType: contentType };
    }
    // Best-effort: log to console (can be replaced with remote logging call)
     
    console.warn('[CSP-REPORT]', JSON.stringify(body).slice(0, 4000));
  } catch (e) {
     
    console.warn('[CSP-REPORT] parse error', (e as Error).message);
  }
  return new Response('', { status: 204 });
}

export const runtime = 'edge'; // hint (if supported) for lightweight handling

// Expo Router expects a default export React component for route files; this is never rendered.
export default function CSPReportRoutePlaceholder() {
  return null;
}
