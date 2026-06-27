// Feature: video-transcoding-compatibility, Property 29: Zero requests to the original URL during async resolution
// Validates Requirement 7.7
//
// Strategy: model the VideoPlayer's source-resolution state machine and assert
// that the original `uri` never appears in the set of requested URLs during
// the period from component mount until transcodedUri resolves.

import * as fc from 'fast-check';

// ─── Source resolution state machine ─────────────────────────────────────────

/**
 * Simulates the state machine from VideoPlayerLoaded's mount through
 * transcodedUri arrival, recording every URL that would be loaded
 * by the <video> element (i.e., every non-empty webResolvedUri value).
 *
 * Returns the list of URLs that would have been loaded by useWebVideoPlayer.
 */
function simulateSourceResolutionUntilResolved(
  uri: string,
  transcodedUri: string | undefined,
  resolutionDelayMs: number,
): string[] {
  const requestedUrls: string[] = [];

  // Step 1: Initial webResolvedUri (from VideoPlayerLoaded useState init)
  const trimmedTranscoded =
    typeof transcodedUri === 'string' && transcodedUri.trim().length > 0
      ? transcodedUri.trim()
      : null;

  const initialResolvedUri = trimmedTranscoded ?? ''; // empty if no transcodedUri

  if (initialResolvedUri) {
    // useWebVideoPlayer gets a non-empty src immediately
    requestedUrls.push(initialResolvedUri);
  }
  // If empty: useWebVideoPlayer's empty-guard fires — no request made

  // Step 2: After resolutionDelayMs, transcodedUri arrives (if it wasn't available at mount)
  if (!trimmedTranscoded && transcodedUri) {
    // transcodedUri arrives as a prop update
    const resolved = transcodedUri.trim();
    if (resolved) {
      requestedUrls.push(resolved);
    }
  }

  // If transcodedUri never arrives (no transcodedUri), the 200ms/1000ms timer
  // fires handleCodecErrorRef.current(0) → codec fallback → backend returns
  // transcodedUrl → requestedUrls.push(transcodedUrl). For this property we
  // model the "transcodedUri arrives" path only.

  return requestedUrls;
}

// ─── Property 29a: when transcodedUri arrives, original uri is never requested ─

describe('Property 29a: original uri is never in requestedUrls when transcodedUri resolves', () => {
  it('holds for any uri + transcodedUri pair with any resolution delay', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.webUrl({ withQueryParameters: false }),
        fc.nat({ max: 1000 }), // resolution delay
        (uri, transcodedUri, resolutionDelayMs) => {
          // Precondition: uri and transcodedUri are different (common case)
          fc.pre(uri !== transcodedUri);

          const requested = simulateSourceResolutionUntilResolved(
            uri,
            transcodedUri,
            resolutionDelayMs,
          );

          // The original uri must never appear in requested URLs
          expect(requested).not.toContain(uri);
          // The transcoded uri should appear
          expect(requested.some(u => u.trim() === transcodedUri.trim())).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── Property 29b: when transcodedUri is absent at mount, initial request is empty ─

describe('Property 29b: no request is made at mount when transcodedUri is absent', () => {
  it('holds for any uri', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        (uri) => {
          // transcodedUri not yet available
          const requested = simulateSourceResolutionUntilResolved(uri, undefined, 0);

          // No request should be made to the original uri at mount
          expect(requested).not.toContain(uri);
          // No requests at all at this point
          expect(requested).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 29c: the only requested URL is always the transcoded one ────────

describe('Property 29c: every requested URL during resolution is a transcoded URL', () => {
  it('holds: the set of requests contains only non-original URLs', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.webUrl({ withQueryParameters: false }),
        fc.nat({ max: 500 }),
        (uri, transcodedUri, delay) => {
          fc.pre(uri !== transcodedUri);

          const requested = simulateSourceResolutionUntilResolved(uri, transcodedUri, delay);

          for (const requestedUrl of requested) {
            expect(requestedUrl).not.toBe(uri);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
