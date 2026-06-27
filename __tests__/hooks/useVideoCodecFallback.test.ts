// Feature: video-transcoding-compatibility

/**
 * Unit tests for `useVideoCodecFallback`
 *
 * Validates: Requirements 1.1, 1.5, 1.7
 *
 * Coverage:
 *   1. onCodecError + transcodedUri present → onSourceResolved called with
 *      transcodedUri and recorded seek time; phase becomes 'done'
 *   2. Poll timer exceeds 60s without a Firestore status:'done' doc →
 *      onTimeoutError called; phase becomes 'timeout'
 *   3. onSwapTargetError() → phase becomes 'error'; onPermanentError called
 *      with the appropriate message
 *
 * Test strategy:
 *   External dependencies are mocked via jest.mock/jest.doMock.
 *   React hooks (useState, useEffect, useRef, useCallback) are intercepted
 *   with jest.doMock('react', ...) + jest.isolateModules so the hook's named
 *   imports get the mock implementations.  This mirrors the pattern used in
 *   useWebVideoPlayer.test.ts.
 *
 *   State mutations are captured in plain arrays; effects are run
 *   synchronously or imperatively by each test; fake timers drive the 60s
 *   timeout scenario.
 */

// ─── Top-level mocks (resolved before any import) ────────────────────────────

jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

jest.mock('@/config/firebase', () => ({
  firestore: {},
}));

// firebase/firestore mock — we capture the onSnapshot call so tests can
// control snapshot delivery.
const mockOnSnapshot = jest.fn();
const mockUnsubscribe = jest.fn();

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(() => 'mock-collection-ref'),
  query: jest.fn((...args: unknown[]) => args),
  where: jest.fn((...args: unknown[]) => args),
  limit: jest.fn((n: number) => n),
  onSnapshot: (...args: unknown[]) => mockOnSnapshot(...args),
}));

const mockCanPlayCodec = jest.fn();

jest.mock('@/utils/codecDetector', () => ({
  canPlayCodec: (...args: unknown[]) => mockCanPlayCodec(...args),
}));

jest.mock('@/services/runtimeEndpoints', () => ({
  runtimeEndpoints: {
    getPreferredBackendBaseUrl: jest.fn(() => 'https://api.example.com'),
  },
}));

jest.mock('@/services/internalTokenManager', () => ({
  internalTokenManager: {
    getToken: jest.fn().mockResolvedValue('mock-token'),
  },
}));

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

// ─── Types ────────────────────────────────────────────────────────────────────

import type { UseVideoCodecFallbackOptions, FallbackPhase } from '../../hooks/useVideoCodecFallback';

// ─── Harness ──────────────────────────────────────────────────────────────────

/**
 * Drives `useVideoCodecFallback` without a React renderer.
 *
 * Uses jest.doMock + jest.isolateModules to replace React's named exports
 * (useState, useEffect, useRef, useCallback) before the hook module is
 * required.  All effects are captured and can be run explicitly.
 */

interface CapturedEffect {
  fn: () => (() => void) | void;
  deps: unknown[] | undefined;
}

interface HookHarness {
  result: ReturnType<typeof import('../../hooks/useVideoCodecFallback').useVideoCodecFallback>;
  /** Synchronously run all captured effects and return their cleanups. */
  runAllEffects: () => Array<(() => void) | void>;
  capturedEffects: CapturedEffect[];
  /** Current value of the `phase` state cell. */
  getPhase: () => FallbackPhase;
  /** Current value of the `activeUri` state cell. */
  getActiveUri: () => string;
}

function buildDefaultOptions(
  overrides: Partial<UseVideoCodecFallbackOptions> = {},
): UseVideoCodecFallbackOptions {
  return {
    uri: 'https://example.com/original.mp4',
    transcodedUri: undefined,
    tenantId: 'tenant-123',
    onSourceResolved: jest.fn(),
    onSpinnerChange: jest.fn(),
    onPermanentError: jest.fn(),
    onTimeoutError: jest.fn(),
    ...overrides,
  };
}

function runHook(opts: UseVideoCodecFallbackOptions): HookHarness {
  // State cells — index 0 = phase, index 1 = activeUri
  const stateValues: unknown[] = [];
  const capturedEffects: CapturedEffect[] = [];
  // We need real mutable ref objects because the hook writes to .current
  const capturedRefs: Array<{ current: unknown }> = [];
  let stateCallIndex = 0;

  // ── Mock React BEFORE isolateModules loads the hook ──────────────────────
  jest.doMock('react', () => {
    const actual = jest.requireActual<typeof import('react')>('react');

    const useState = <T>(initial: T | (() => T)): [T, (v: T | ((p: T) => T)) => void] => {
      const idx = stateCallIndex++;
      const value = typeof initial === 'function' ? (initial as () => T)() : initial;
      stateValues[idx] = value;
      const setter = (updater: T | ((prev: T) => T)) => {
        if (typeof updater === 'function') {
          stateValues[idx] = (updater as (prev: unknown) => unknown)(stateValues[idx]);
        } else {
          stateValues[idx] = updater;
        }
      };
      return [value, setter];
    };

    const useEffect = (fn: () => (() => void) | void, deps?: unknown[]) => {
      capturedEffects.push({ fn, deps });
    };

    const useRef = <T>(initial: T): { current: T } => {
      const ref = { current: initial };
      capturedRefs.push(ref as { current: unknown });
      return ref;
    };

    const useCallback = <T extends (...args: unknown[]) => unknown>(
      fn: T,
      _deps: unknown[],
    ): T => fn;

    return { ...actual, useState, useEffect, useRef, useCallback };
  });

  let hookResult!: HookHarness['result'];

  jest.isolateModules(() => {
    const mod = require('../../hooks/useVideoCodecFallback') as {
      useVideoCodecFallback: (o: UseVideoCodecFallbackOptions) => HookHarness['result'];
    };
    hookResult = mod.useVideoCodecFallback(opts);
  });

  jest.dontMock('react');
  jest.resetModules();

  return {
    result: hookResult,
    capturedEffects,
    runAllEffects: () => capturedEffects.map(({ fn }) => fn()),
    getPhase: () => stateValues[0] as FallbackPhase,
    getActiveUri: () => stateValues[1] as string,
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockCanPlayCodec.mockReturnValue(false); // h265 not supported by default
  mockOnSnapshot.mockReturnValue(mockUnsubscribe); // default: no snapshot delivery
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.resetModules();
});

// ─── Test group 1: onCodecError + transcodedUri → source swap ────────────────

describe('useVideoCodecFallback — Test 1: onCodecError + transcodedUri → source swap', () => {
  /**
   * Requirement 1.1: swap to transcodedUri when UnsupportedCodecError fires.
   * Requirement 1.6: seek position recorded at error time is passed through.
   */

  it('calls onSourceResolved with transcodedUri and recorded seek time', () => {
    const onSourceResolved = jest.fn();
    const transcodedUri = 'https://example.com/transcoded.mp4';

    // h265 IS supported → proactive mount effect is a no-op; test reactive path
    mockCanPlayCodec.mockReturnValue(true);

    const { result, runAllEffects } = runHook(
      buildDefaultOptions({ transcodedUri, onSourceResolved }),
    );

    // Run mount effects (proactive check → no-op because h265 supported)
    runAllEffects();

    const seekTime = 42.5;
    result.onCodecError(seekTime);

    expect(onSourceResolved).toHaveBeenCalledTimes(1);
    expect(onSourceResolved).toHaveBeenCalledWith(transcodedUri, seekTime);
  });

  it('onSourceResolved receives the exact transcodedUri value', () => {
    const onSourceResolved = jest.fn();
    const transcodedUri = 'https://cdn.example.com/video-h264.mp4';
    mockCanPlayCodec.mockReturnValue(true);

    const { result } = runHook(buildDefaultOptions({ transcodedUri, onSourceResolved }));

    result.onCodecError(10);

    const [calledUri] = (onSourceResolved as jest.Mock).mock.calls[0] as [string, number];
    expect(calledUri).toBe(transcodedUri);
  });

  it('onSourceResolved receives the currentTime passed to onCodecError', () => {
    const onSourceResolved = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);

    const { result } = runHook(
      buildDefaultOptions({ transcodedUri: 'https://example.com/t.mp4', onSourceResolved }),
    );

    result.onCodecError(123.456);

    const [, seekTo] = (onSourceResolved as jest.Mock).mock.calls[0] as [string, number];
    expect(seekTo).toBe(123.456);
  });

  it('phase becomes done after swap completes', () => {
    const onSourceResolved = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);

    const { result, getPhase } = runHook(
      buildDefaultOptions({ transcodedUri: 'https://example.com/t.mp4', onSourceResolved }),
    );

    result.onCodecError(0);

    // performSwap calls setPhase('swapping') then setPhase('done') synchronously
    expect(onSourceResolved).toHaveBeenCalled();
    expect(getPhase()).toBe('done');
  });

  it('does NOT call onSourceResolved when transcodedUri is absent', () => {
    const onSourceResolved = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);

    // requestTranscode path — mock fetch to reject immediately
    global.fetch = jest.fn().mockRejectedValue(new Error('network'));

    const { result } = runHook(buildDefaultOptions({ transcodedUri: undefined, onSourceResolved }));

    result.onCodecError(0);

    // async path; onSourceResolved must not be called synchronously
    expect(onSourceResolved).not.toHaveBeenCalled();
  });

  it('whitespace-only transcodedUri is treated as absent (no swap)', () => {
    const onSourceResolved = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);

    global.fetch = jest.fn().mockRejectedValue(new Error('network'));

    const { result } = runHook(buildDefaultOptions({ transcodedUri: '   ', onSourceResolved }));

    result.onCodecError(5);

    expect(onSourceResolved).not.toHaveBeenCalled();
  });
});

// ─── Test group 2: 60s polling timeout ───────────────────────────────────────

describe('useVideoCodecFallback — Test 2: 60s polling timeout → timeout phase + onTimeoutError', () => {
  /**
   * Requirement 1.5: after 60s without status:'done', call onTimeoutError and
   * set phase to 'timeout'.
   */

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  /**
   * Helper: trigger the requestTranscode → startPolling path and flush all
   * microtasks so the 60s setTimeout is registered.
   *
   * The hook calls:
   *   requestTranscode (async) → fetch → .json() → startPolling (calls setTimeout)
   *
   * We flush with repeated Promise.resolve() ticks.
   */
  function triggerPollingAndFlush(result: HookHarness['result']): Promise<void> {
    void result.onCodecError(0);
    // Flush: onCodecError → requestTranscode → fetch (mock) → .json() → startPolling
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => Promise.resolve())
      .then(() => Promise.resolve());
  }

  it('calls onTimeoutError and sets phase to timeout after 60 seconds of polling', () => {
    const onTimeoutError = jest.fn();
    mockCanPlayCodec.mockReturnValue(true); // skip proactive swap
    // onSnapshot never delivers a 'done' doc
    mockOnSnapshot.mockImplementation(() => mockUnsubscribe);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'processing' }),
      text: jest.fn().mockResolvedValue(''),
    });

    const { result, getPhase } = runHook(
      buildDefaultOptions({ transcodedUri: undefined, onTimeoutError }),
    );

    return triggerPollingAndFlush(result).then(() => {
      jest.advanceTimersByTime(60_000);

      expect(onTimeoutError).toHaveBeenCalledTimes(1);
      expect(getPhase()).toBe('timeout');
    });
  });

  it('does NOT call onTimeoutError before 60 seconds have elapsed', () => {
    const onTimeoutError = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);
    mockOnSnapshot.mockImplementation(() => mockUnsubscribe);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'processing' }),
      text: jest.fn().mockResolvedValue(''),
    });

    const { result } = runHook(buildDefaultOptions({ transcodedUri: undefined, onTimeoutError }));

    return triggerPollingAndFlush(result).then(() => {
      jest.advanceTimersByTime(59_999);
      expect(onTimeoutError).not.toHaveBeenCalled();
    });
  });

  it('spinner is dismissed (onSpinnerChange called with false) when timeout fires', () => {
    const onSpinnerChange = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);
    mockOnSnapshot.mockImplementation(() => mockUnsubscribe);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'processing' }),
      text: jest.fn().mockResolvedValue(''),
    });

    const { result } = runHook(buildDefaultOptions({ transcodedUri: undefined, onSpinnerChange }));

    return triggerPollingAndFlush(result).then(() => {
      jest.advanceTimersByTime(60_000);

      const calls = (onSpinnerChange as jest.Mock).mock.calls as [boolean][];
      const lastArg = calls[calls.length - 1]?.[0];
      expect(lastArg).toBe(false);
    });
  });

  it('Firestore listener is unsubscribed when timeout fires', () => {
    mockCanPlayCodec.mockReturnValue(true);
    mockOnSnapshot.mockImplementation(() => mockUnsubscribe);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'processing' }),
      text: jest.fn().mockResolvedValue(''),
    });

    const { result } = runHook(buildDefaultOptions({ transcodedUri: undefined }));

    return triggerPollingAndFlush(result).then(() => {
      jest.advanceTimersByTime(60_000);
      expect(mockUnsubscribe).toHaveBeenCalled();
    });
  });
});

// ─── Test group 3: onSwapTargetError → error phase ───────────────────────────

describe('useVideoCodecFallback — Test 3: onSwapTargetError → error phase + onPermanentError', () => {
  /**
   * Requirement 1.7: if the transcoded source also fails to play, show the
   * permanent error message.
   */

  it('sets phase to error when onSwapTargetError is called', () => {
    mockCanPlayCodec.mockReturnValue(true); // skip proactive swap
    const { result, getPhase } = runHook(buildDefaultOptions());

    result.onSwapTargetError();

    expect(getPhase()).toBe('error');
  });

  it('calls onPermanentError with the correct message', () => {
    const onPermanentError = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);
    const { result } = runHook(buildDefaultOptions({ onPermanentError }));

    result.onSwapTargetError();

    expect(onPermanentError).toHaveBeenCalledTimes(1);
    expect(onPermanentError).toHaveBeenCalledWith(
      'Video playback failed. Try downloading the file.',
    );
  });

  it('spinner is dismissed (onSpinnerChange false) when onSwapTargetError fires', () => {
    const onSpinnerChange = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);
    const { result } = runHook(buildDefaultOptions({ onSpinnerChange }));

    result.onSwapTargetError();

    const calls = (onSpinnerChange as jest.Mock).mock.calls as [boolean][];
    expect(calls.some(([arg]) => arg === false)).toBe(true);
  });

  it('onPermanentError is called exactly once on the first call', () => {
    const onPermanentError = jest.fn();
    mockCanPlayCodec.mockReturnValue(true);
    const { result } = runHook(buildDefaultOptions({ onPermanentError }));

    result.onSwapTargetError();

    expect(onPermanentError).toHaveBeenCalledTimes(1);
  });

  it('phase remains error after multiple onSwapTargetError calls', () => {
    mockCanPlayCodec.mockReturnValue(true);
    const { result, getPhase } = runHook(buildDefaultOptions());

    result.onSwapTargetError();
    result.onSwapTargetError();

    expect(getPhase()).toBe('error');
  });
});

// ─── Test group 4: proactive mount behaviour ─────────────────────────────────

describe('useVideoCodecFallback — proactive mount behaviour (h265 not supported)', () => {
  /**
   * Requirements 5.4, 5.5: On web, if h265 is not supported, the hook swaps
   * immediately on mount when transcodedUri is present, or errors when absent.
   */

  it('calls onSourceResolved on mount when h265 unsupported AND transcodedUri present', () => {
    const onSourceResolved = jest.fn();
    const transcodedUri = 'https://example.com/proactive.mp4';
    mockCanPlayCodec.mockReturnValue(false);

    const { runAllEffects } = runHook(
      buildDefaultOptions({ transcodedUri, onSourceResolved }),
    );
    runAllEffects();

    expect(onSourceResolved).toHaveBeenCalledWith(transcodedUri, 0);
  });

  it('sets phase to error on mount when h265 unsupported AND no transcodedUri', () => {
    const onPermanentError = jest.fn();
    mockCanPlayCodec.mockReturnValue(false);

    const { runAllEffects, getPhase } = runHook(
      buildDefaultOptions({ transcodedUri: undefined, onPermanentError }),
    );
    runAllEffects();

    expect(getPhase()).toBe('error');
    expect(onPermanentError).toHaveBeenCalled();
  });
});

// ─── Test group 5: public API surface ────────────────────────────────────────

describe('useVideoCodecFallback — returned public API surface', () => {
  it('returns phase, onCodecError, onSwapTargetError, retry, and activeUri', () => {
    const { result } = runHook(buildDefaultOptions());

    expect(typeof result.phase).toBe('string');
    expect(typeof result.onCodecError).toBe('function');
    expect(typeof result.onSwapTargetError).toBe('function');
    expect(typeof result.retry).toBe('function');
    expect(typeof result.activeUri).toBe('string');
  });

  it('activeUri starts as the original uri', () => {
    const uri = 'https://example.com/original.mp4';
    const { result } = runHook(buildDefaultOptions({ uri }));

    expect(result.activeUri).toBe(uri);
  });
});
