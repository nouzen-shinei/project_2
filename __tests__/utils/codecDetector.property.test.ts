// Feature: video-transcoding-compatibility, Property 17: canPlayCodec returns boolean without network calls for all codec values
// Feature: video-transcoding-compatibility, Property 18: canPlayCodec results are cached per page load

/**
 * **Validates: Requirements 5.1**
 *
 * Property 17: canPlayCodec returns boolean without network calls for all codec values
 *
 * For any value in ['h265', 'h264', 'vp9', 'av1'], canPlayCodec SHALL return a
 * boolean without making any network request. No fetch, XMLHttpRequest, or
 * equivalent is invoked as a side effect.
 */

/**
 * **Validates: Requirements 5.3**
 *
 * Property 18: canPlayCodec results are cached per page load
 *
 * For any codec value, a second call to canPlayCodec on the same codec SHALL NOT
 * invoke HTMLVideoElement.canPlayType again; the cached result from the first call
 * SHALL be returned directly.
 */

import * as fc from 'fast-check';
import type { SupportedCodec } from '../../utils/codecDetector';

// ---------------------------------------------------------------------------
// Helpers — reset the module-level cache between runs
// ---------------------------------------------------------------------------

/**
 * Loads a fresh copy of codecDetector (clearing its module-level Map cache).
 *
 * In Jest's module runtime, `require.cache` is managed by Jest itself. We use
 * `jest.resetModules()` to clear Jest's internal module registry, then
 * re-require the module so the Map cache starts empty for the current run.
 */
function freshCanPlayCodec(): (codec: SupportedCodec) => boolean {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../utils/codecDetector').canPlayCodec as (codec: SupportedCodec) => boolean;
}

// ---------------------------------------------------------------------------
// Spy setup — intercept fetch and XMLHttpRequest before each test
// ---------------------------------------------------------------------------

let fetchSpy: jest.SpyInstance | undefined;
let xhrOpenSpy: jest.SpyInstance | undefined;

beforeEach(() => {
  // Ensure global.fetch exists so we can spy on it
  if (typeof global.fetch !== 'function') {
    (global as unknown as { fetch: unknown }).fetch = jest.fn();
  }
  fetchSpy = jest.spyOn(global as unknown as { fetch: jest.Mock }, 'fetch');

  // Ensure XMLHttpRequest exists so we can spy on its open() method
  if (typeof global.XMLHttpRequest === 'undefined') {
    class MockXHR {
      open() {}
      send() {}
    }
    (global as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;
  }
  xhrOpenSpy = jest.spyOn(
    (global as unknown as { XMLHttpRequest: { prototype: { open: () => void } } })
      .XMLHttpRequest.prototype,
    'open',
  );
});

afterEach(() => {
  fetchSpy?.mockRestore();
  xhrOpenSpy?.mockRestore();
  // Restore modules after each test so Jest's registry is clean
  jest.resetModules();
});

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

describe('canPlayCodec — Property 17', () => {
  it('returns a boolean for all codec values without triggering network calls', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SupportedCodec>('h265', 'h264', 'vp9', 'av1'),
        (codec) => {
          // Load a fresh module so the cache does not bleed between iterations
          const canPlayCodec = freshCanPlayCodec();

          // Exercise the function under test
          const result = canPlayCodec(codec);

          // 1. Return type must be boolean
          expect(typeof result).toBe('boolean');

          // 2. No fetch calls must have been made
          if (fetchSpy) {
            expect(fetchSpy).not.toHaveBeenCalled();
          }

          // 3. No XHR open() calls must have been made
          if (xhrOpenSpy) {
            expect(xhrOpenSpy).not.toHaveBeenCalled();
          }

          // Reset spy call counts for the next iteration
          fetchSpy?.mockClear();
          xhrOpenSpy?.mockClear();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('covers all four codec values explicitly — each returns a strict boolean', () => {
    // Exhaustive example-based companion: confirms every code path returns
    // true or false (not undefined, null, or a truthy/falsy non-boolean).
    const codecs: SupportedCodec[] = ['h265', 'h264', 'vp9', 'av1'];
    for (const codec of codecs) {
      const canPlayCodec = freshCanPlayCodec();
      const result = canPlayCodec(codec);
      // Strict boolean check — not just truthy/falsy
      expect(result === true || result === false).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 18 helpers
// ---------------------------------------------------------------------------

/**
 * Installs a minimal `document` stub on `global` so that the web path in
 * `codecDetector.ts` is exercised (`isWeb()` returns `true`).
 *
 * Returns the `canPlayType` spy and a `teardown` function that restores the
 * original `global.document` value.
 *
 * Call this BEFORE `freshCanPlayCodec()` so the stub is in place when the
 * module's `isWeb()` is evaluated at call time.
 */
function setupWebEnvironment(canPlayTypeReturnValue: string = 'probably'): {
  canPlayTypeSpy: jest.Mock;
  teardown: () => void;
} {
  const canPlayTypeSpy = jest.fn().mockReturnValue(canPlayTypeReturnValue);

  const fakeDocument = {
    createElement: (tag: string) => {
      if (tag === 'video') {
        return { canPlayType: canPlayTypeSpy };
      }
      return {};
    },
  };

  // Capture original value (undefined in Node test environment)
  const g = global as unknown as Record<string, unknown>;
  const originalDocument = g['document'];
  g['document'] = fakeDocument;

  return {
    canPlayTypeSpy,
    teardown: () => {
      if (originalDocument === undefined) {
        delete g['document'];
      } else {
        g['document'] = originalDocument;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

describe('canPlayCodec — Property 18', () => {
  it('does not invoke canPlayType on the second call for the same codec (caching)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SupportedCodec>('h265', 'h264', 'vp9', 'av1'),
        (codec) => {
          // 1. Install web environment BEFORE loading the module so isWeb() === true
          const { canPlayTypeSpy, teardown } = setupWebEnvironment('probably');

          try {
            // 2. Load a fresh module instance via jest.resetModules() — Map cache is empty
            const canPlayCodec = freshCanPlayCodec();

            // 3. First call — triggers the web path; canPlayType is invoked once
            const result1 = canPlayCodec(codec);

            // 4. Second call — result is served from the Map; canPlayType NOT invoked again
            const result2 = canPlayCodec(codec);

            // Assertions
            expect(typeof result1).toBe('boolean');
            expect(typeof result2).toBe('boolean');

            // Cache must return the same value both times
            expect(result1).toBe(result2);

            // canPlayType must have been invoked exactly once across both calls
            expect(canPlayTypeSpy).toHaveBeenCalledTimes(1);
          } finally {
            // Always restore global.document to keep tests isolated
            teardown();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
