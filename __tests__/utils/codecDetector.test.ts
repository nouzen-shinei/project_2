// Feature: video-transcoding-compatibility

/**
 * Unit tests for `canPlayCodec`
 *
 * Validates: Requirements 5.1, 5.2
 *
 * Coverage:
 *   Web environment  — `canPlayType` returning "probably", "", or "maybe"
 *   Native environment — h264/h265 always true; vp9/av1 false without native API
 *
 * Design note: `jest.isolateModules` is used in every test so each test gets
 * a fresh module instance with a clean `codecCache` Map. This is necessary
 * because ts-jest maintains its own module registry that is independent of
 * Node's `require.cache`, so the `delete require.cache[path]` pattern used
 * in property tests does not reset the module-level Map inside ts-jest.
 */

import { SupportedCodec } from '../../utils/codecDetector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CanPlayTypeResult = '' | 'maybe' | 'probably';

type FakeVideo = {
  canPlayType: jest.Mock<CanPlayTypeResult, []>;
};

/**
 * Installs a minimal `document` stub on `global` so that the module's
 * `isWeb()` check returns `true` and `document.createElement('video')`
 * returns a fake element whose `canPlayType` yields `canPlayTypeResult`.
 */
function stubDocumentWithCanPlayType(canPlayTypeResult: CanPlayTypeResult): FakeVideo {
  const fakeVideo: FakeVideo = {
    canPlayType: jest.fn<CanPlayTypeResult, []>().mockReturnValue(canPlayTypeResult),
  };
  (global as unknown as { document: { createElement: (tag: string) => FakeVideo } }).document = {
    createElement: (_tag: string) => fakeVideo,
  };
  return fakeVideo;
}

/**
 * Removes the `document` stub so the environment looks like native (no DOM).
 */
function removeDocumentStub(): void {
  delete (global as unknown as { document?: unknown }).document;
}

/**
 * Loads a fresh module instance using `jest.isolateModules`, evaluates
 * `fn(canPlayCodec)` inside the isolated scope, and returns the result.
 * Because the module is freshly loaded, its `codecCache` Map is empty.
 */
function withFreshModule<T>(fn: (canPlayCodec: (codec: SupportedCodec) => boolean) => T): T {
  let result!: T;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { canPlayCodec } = require('../../utils/codecDetector') as {
      canPlayCodec: (codec: SupportedCodec) => boolean;
    };
    result = fn(canPlayCodec);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Web environment tests
// ---------------------------------------------------------------------------

describe('canPlayCodec — web environment', () => {
  afterEach(() => {
    removeDocumentStub();
  });

  it('returns true when canPlayType returns "probably"', () => {
    stubDocumentWithCanPlayType('probably');
    const result = withFreshModule((canPlayCodec) => canPlayCodec('h264'));
    expect(result).toBe(true);
  });

  it('returns false when canPlayType returns ""', () => {
    stubDocumentWithCanPlayType('');
    const result = withFreshModule((canPlayCodec) => canPlayCodec('h265'));
    expect(result).toBe(false);
  });

  it('returns true when canPlayType returns "maybe"', () => {
    stubDocumentWithCanPlayType('maybe');
    const result = withFreshModule((canPlayCodec) => canPlayCodec('vp9'));
    expect(result).toBe(true);
  });

  it('caches the result so canPlayType is only invoked once per codec', () => {
    const fakeVideo = stubDocumentWithCanPlayType('probably');

    withFreshModule((canPlayCodec) => {
      canPlayCodec('h264');
      canPlayCodec('h264'); // second call — must hit the module-level Map
    });

    expect(fakeVideo.canPlayType).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Native environment tests
// ---------------------------------------------------------------------------

describe('canPlayCodec — native environment (document === undefined)', () => {
  beforeEach(() => {
    // Ensure there is no `document` global so `isWeb()` returns false.
    removeDocumentStub();
  });

  afterEach(() => {
    delete (global as unknown as { __nativeVideoCapabilities?: unknown }).__nativeVideoCapabilities;
  });

  it('returns true for h264', () => {
    const result = withFreshModule((canPlayCodec) => canPlayCodec('h264'));
    expect(result).toBe(true);
  });

  it('returns true for h265', () => {
    const result = withFreshModule((canPlayCodec) => canPlayCodec('h265'));
    expect(result).toBe(true);
  });

  it('returns false for vp9 when __nativeVideoCapabilities is not set', () => {
    const result = withFreshModule((canPlayCodec) => canPlayCodec('vp9'));
    expect(result).toBe(false);
  });

  it('returns false for av1 when __nativeVideoCapabilities is not set', () => {
    const result = withFreshModule((canPlayCodec) => canPlayCodec('av1'));
    expect(result).toBe(false);
  });

  it('returns true for vp9 when __nativeVideoCapabilities reports support', () => {
    (global as unknown as { __nativeVideoCapabilities: Record<string, boolean> }).__nativeVideoCapabilities = {
      vp9: true,
    };
    const result = withFreshModule((canPlayCodec) => canPlayCodec('vp9'));
    expect(result).toBe(true);
  });

  it('returns false for vp9 when __nativeVideoCapabilities explicitly reports false', () => {
    (global as unknown as { __nativeVideoCapabilities: Record<string, boolean> }).__nativeVideoCapabilities = {
      vp9: false,
    };
    const result = withFreshModule((canPlayCodec) => canPlayCodec('vp9'));
    expect(result).toBe(false);
  });
});
