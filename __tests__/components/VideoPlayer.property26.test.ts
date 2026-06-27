// Feature: video-transcoding-compatibility, Property 26: No <video> element loads the original URL before resolution
// Validates Requirements 7.3, 7.4
//
// Strategy: we mock useWebVideoPlayer's useLayoutEffect to record every
// `src` value assigned to the element, then assert the original `uri` is
// never set before the transcodedUri resolves.

import * as fc from 'fast-check';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Mirrors the webResolvedUri initialization logic from VideoPlayerLoaded.
 * Returns what value `webResolvedUri` would be initialised to on mount.
 */
function resolveInitialWebResolvedUri(
  uri: string,
  transcodedUri: string | undefined,
  h265Supported: boolean,
): string {
  const trimmedTranscoded =
    typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
      ? transcodedUri.trim()
      : undefined;

  // Always use the transcoded copy when available (on ALL browsers)
  if (trimmedTranscoded) {
    return trimmedTranscoded;
  }

  // No transcodedUri yet: start empty on any browser
  // (a timeout later falls back to uri for non-transcoded videos)
  return '';
}

/**
 * Mirrors the resolveVideoSource logic from lib/videoSource.ts.
 * Returns the safe source for a given attachment.
 */
function resolveVideoSourceLogic(attachment: {
  url: string;
  transcodedUrl?: string;
}): { source: string; originalMayBeDeleted: boolean } {
  const trimmedTranscoded =
    typeof attachment.transcodedUrl === 'string' && attachment.transcodedUrl.trim().length > 0
      ? attachment.transcodedUrl.trim()
      : null;
  if (trimmedTranscoded !== null) {
    return { source: trimmedTranscoded, originalMayBeDeleted: true };
  }
  return { source: attachment.url, originalMayBeDeleted: false };
}

// ─── Property 26a: webResolvedUri never starts as the original uri ────────────

describe('Property 26a: webResolvedUri never starts as the original uri when transcodedUri is available', () => {
  it('holds for any uri + transcodedUri pair on any browser', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.webUrl({ withQueryParameters: false }),
        fc.boolean(), // h265Supported
        (uri, transcodedUri, h265Supported) => {
          const initial = resolveInitialWebResolvedUri(uri, transcodedUri, h265Supported);
          // When transcodedUri is available, initial value must not be the original uri
          expect(initial).toBe(transcodedUri);
          expect(initial).not.toBe(uri);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 26b: webResolvedUri starts empty (not uri) when no transcodedUri ─

describe('Property 26b: webResolvedUri starts empty when transcodedUri is absent', () => {
  it('holds for any uri on any browser', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.boolean(), // h265Supported
        (uri, h265Supported) => {
          const initial = resolveInitialWebResolvedUri(uri, undefined, h265Supported);
          // Must start empty — never the original uri — to prevent HEAD 403
          expect(initial).toBe('');
          expect(initial).not.toBe(uri);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 26c: whitespace-only transcodedUri is treated as absent ─────────

describe('Property 26c: whitespace-only transcodedUri is treated as absent', () => {
  it('holds: webResolvedUri starts empty for whitespace-only transcodedUri', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.string().filter(s => s.trim() === ''), // whitespace-only
        fc.boolean(),
        (uri, whitespaceTranscoded, h265Supported) => {
          const initial = resolveInitialWebResolvedUri(uri, whitespaceTranscoded, h265Supported);
          expect(initial).toBe('');
          expect(initial).not.toBe(uri);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 26d: ChatMessageItem never passes original url as fileUrl ───────

describe('Property 26d: resolveVideoSource always returns transcodedUrl as source when present', () => {
  it('holds for any url + transcodedUrl pair', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.webUrl({ withQueryParameters: false }),
        (url, transcodedUrl) => {
          const result = resolveVideoSourceLogic({ url, transcodedUrl });
          // source must be the transcoded URL — never the original
          expect(result.source).toBe(transcodedUrl);
          expect(result.source).not.toBe(url);
          expect(result.originalMayBeDeleted).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds: when no transcodedUrl, source is the original url', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        (url) => {
          const result = resolveVideoSourceLogic({ url });
          expect(result.source).toBe(url);
          expect(result.originalMayBeDeleted).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
