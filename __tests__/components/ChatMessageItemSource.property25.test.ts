// Feature: video-transcoding-compatibility, Property 25: ChatMessageItem never selects original as playback source
// Validates Requirement 7.2
//
// Tests the resolveVideoSource helper that ChatMessageItem uses to choose
// the VideoPlayer source, asserting the original url is never returned as
// the playback source when a transcodedUrl is present.

import * as fc from 'fast-check';
import { resolveVideoSource } from '../../lib/videoSource';

// ─── Property 25: transcodedUrl always takes priority over original url ───────

describe('Property 25: ChatMessageItem source never equals original url when transcodedUrl exists', () => {
  it('holds for any url + transcodedUrl combination', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.webUrl({ withQueryParameters: false }),
        (originalUrl, transcodedUrl) => {
          // Precondition: urls are different (the interesting case)
          fc.pre(originalUrl !== transcodedUrl);

          const { source, originalMayBeDeleted } = resolveVideoSource({
            url: originalUrl,
            transcodedUrl,
          });

          // The source passed to VideoPlayer MUST be the transcoded URL
          expect(source).toBe(transcodedUrl);
          expect(source).not.toBe(originalUrl);
          // originalMayBeDeleted must be true so callers know to avoid the original
          expect(originalMayBeDeleted).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('holds even when transcodedUrl has surrounding whitespace', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.webUrl({ withQueryParameters: false }),
        fc.nat({ max: 5 }), // number of leading spaces
        fc.nat({ max: 5 }), // number of trailing spaces
        (originalUrl, transcodedUrl, leadingSpaces, trailingSpaces) => {
          fc.pre(originalUrl !== transcodedUrl.trim());

          const paddedTranscoded = ' '.repeat(leadingSpaces) + transcodedUrl + ' '.repeat(trailingSpaces);

          const { source } = resolveVideoSource({
            url: originalUrl,
            transcodedUrl: paddedTranscoded,
          });

          // Whitespace must be trimmed and the transcoded url used
          expect(source).toBe(transcodedUrl);
          expect(source).not.toBe(originalUrl);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds: the original url appears nowhere in the source when transcoded exists', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        fc.webUrl({ withQueryParameters: false }),
        fc.option(fc.boolean(), { nil: undefined }), // originalReplaced flag
        (originalUrl, transcodedUrl, originalReplaced) => {
          fc.pre(originalUrl !== transcodedUrl);

          const { source } = resolveVideoSource({
            url: originalUrl,
            transcodedUrl,
            originalReplaced,
          });

          expect(source).not.toBe(originalUrl);
          expect(source).toBe(transcodedUrl.trim());
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── When no transcodedUrl: original url is safe to use ──────────────────────

describe('Property 25 complementary: when no transcodedUrl, source is the original url', () => {
  it('holds for any url without transcodedUrl', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        (originalUrl) => {
          const { source, originalMayBeDeleted } = resolveVideoSource({
            url: originalUrl,
          });

          expect(source).toBe(originalUrl);
          expect(originalMayBeDeleted).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('holds when transcodedUrl is empty string', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: false }),
        (originalUrl) => {
          const { source, originalMayBeDeleted } = resolveVideoSource({
            url: originalUrl,
            transcodedUrl: '',
          });

          expect(source).toBe(originalUrl);
          expect(originalMayBeDeleted).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
