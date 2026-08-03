// Feature: video-transcoding-compatibility, Property 1: Codec error triggers source swap to transcodedUrl

/**
 * **Validates: Requirements 1.1**
 *
 * Property 1: Codec error triggers source swap to transcodedUrl
 *
 * For any VideoPlayer instance on web that receives a non-empty `transcodedUri` prop
 * and subsequently fires an `UnsupportedCodecError`, the active playback source SHALL
 * be set to `transcodedUri` and no user-visible error state SHALL be rendered
 * (phase should be `done`, not `error`).
 *
 * Generator: `fc.webUrl()` for uri; `fc.webUrl()` for transcodedUri;
 * simulate UnsupportedCodecError; assert `onSourceResolved` called with `transcodedUri`
 */

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before any imports that load the hook.
// ---------------------------------------------------------------------------

jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

jest.mock('@/config/firebase', () => ({
  firestore: {},
}));

jest.mock('firebase/firestore', () => ({
  collection: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  limit: jest.fn(),
  onSnapshot: jest.fn(),
}));

jest.mock('@/services/runtimeEndpoints', () => ({
  runtimeEndpoints: {
    getPreferredBackendBaseUrl: jest.fn().mockReturnValue('https://api.example.com'),
  },
}));

jest.mock('@/services/internalTokenManager', () => ({
  internalTokenManager: {
    getToken: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@/utils/codecDetector', () => ({
  canPlayCodec: jest.fn().mockReturnValue(false),
}));

// ---------------------------------------------------------------------------
// Minimal hook harness
//
// This harness intercepts React's hooks to run useVideoCodecFallback without
// a DOM renderer. The key design decision: state setters do NOT trigger
// automatic re-renders during flush (to avoid infinite loops when the hook
// calls setPhase multiple times synchronously in performSwap). Instead,
// we capture state updates in-place and read the final state after flush.
// ---------------------------------------------------------------------------

type EffectCleanup = (() => void) | void;

interface SlotState {
  value: unknown;
}

interface CapturedEffect {
  fn: () => EffectCleanup;
  deps: unknown[] | undefined;
  cleanup?: EffectCleanup;
}

interface HookState {
  states: SlotState[];
  refs: Array<{ current: unknown }>;
  effects: CapturedEffect[];
  callbacks: Array<{ fn: (...args: unknown[]) => unknown; deps: unknown[] }>;
  stateIdx: number;
  refIdx: number;
  effectIdx: number;
  callbackIdx: number;
}

function createHarness() {
  let hs: HookState = {
    states: [],
    refs: [],
    effects: [],
    callbacks: [],
    stateIdx: 0,
    refIdx: 0,
    effectIdx: 0,
    callbackIdx: 0,
  };

  // ── useState ──────────────────────────────────────────────────────────────
  // State setters mutate in-place only; no re-render is triggered.
  // This is intentional — the hook calls setPhase() / setActiveUri()
  // synchronously inside effects; we capture the final value without
  // needing to re-invoke the entire hook tree.
  function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
    const idx = hs.stateIdx++;
    if (hs.states.length <= idx) {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial;
      hs.states.push({ value });
    }
    const slot = hs.states[idx];
    const setter = (updater: T | ((prev: T) => T)) => {
      slot.value =
        typeof updater === 'function'
          ? (updater as (p: T) => T)(slot.value as T)
          : updater;
    };
    return [slot.value as T, setter];
  }

  // ── useRef ────────────────────────────────────────────────────────────────
  function useRef<T>(initial: T): { current: T } {
    const idx = hs.refIdx++;
    if (hs.refs.length <= idx) {
      hs.refs.push({ current: initial });
    }
    return hs.refs[idx] as { current: T };
  }

  // ── useEffect ─────────────────────────────────────────────────────────────
  // We collect effects during the hook call and flush them explicitly.
  function useEffect(fn: () => EffectCleanup, deps?: unknown[]) {
    const idx = hs.effectIdx++;
    if (hs.effects.length <= idx) {
      hs.effects.push({ fn, deps });
    } else {
      const existing = hs.effects[idx];
      const depsChanged =
        deps === undefined ||
        existing.deps === undefined ||
        deps.length !== (existing.deps?.length ?? 0) ||
        deps.some((d, i) => d !== (existing.deps as unknown[])[i]);
      if (depsChanged) {
        hs.effects[idx] = { fn, deps, cleanup: existing.cleanup };
      }
    }
  }

  // ── useCallback ───────────────────────────────────────────────────────────
  function useCallback<T extends (...args: unknown[]) => unknown>(fn: T, deps: unknown[]): T {
    const idx = hs.callbackIdx++;
    if (hs.callbacks.length <= idx) {
      hs.callbacks.push({ fn, deps });
      return fn;
    }
    const existing = hs.callbacks[idx];
    const changed =
      deps.length !== existing.deps.length ||
      deps.some((d, i) => d !== existing.deps[i]);
    if (changed) {
      hs.callbacks[idx] = { fn, deps };
    }
    return hs.callbacks[idx].fn as T;
  }

  // ── flushEffects ──────────────────────────────────────────────────────────
  // Run each effect exactly once. Cleanup from previous run is called first.
  function flushEffects() {
    for (const effect of hs.effects) {
      if (effect.cleanup) {
        try { effect.cleanup(); } catch { /* ignore */ }
      }
      effect.cleanup = effect.fn();
    }
  }

  // ── Install / uninstall ───────────────────────────────────────────────────
  function install() {
    const React = require('react');
    jest.spyOn(React, 'useState').mockImplementation(useState as typeof React.useState);
    jest.spyOn(React, 'useRef').mockImplementation(useRef as typeof React.useRef);
    jest.spyOn(React, 'useEffect').mockImplementation(useEffect as typeof React.useEffect);
    jest.spyOn(React, 'useCallback').mockImplementation(
      useCallback as typeof React.useCallback,
    );
  }

  function uninstall() {
    jest.restoreAllMocks();
  }

  // ── run ───────────────────────────────────────────────────────────────────
  // Invoke the hook once (simulates the initial render) then flush effects.
  function run<T>(hookFn: () => T): T {
    hs.stateIdx = 0;
    hs.refIdx = 0;
    hs.effectIdx = 0;
    hs.callbackIdx = 0;
    const result = hookFn();
    flushEffects();
    return result;
  }

  // ── Re-invoke to get fresh return value reflecting mutated state ──────────
  // Because state setters mutate in-place, we can re-invoke the hook to read
  // the updated state values without triggering any side-effects.
  function reread<T>(hookFn: () => T): T {
    hs.stateIdx = 0;
    hs.refIdx = 0;
    hs.effectIdx = 0;
    hs.callbackIdx = 0;
    return hookFn();
    // NOTE: we do NOT flush effects here — we only want the latest state values.
  }

  // ── unmount ───────────────────────────────────────────────────────────────
  function unmount() {
    for (const effect of hs.effects) {
      if (effect.cleanup) {
        try { effect.cleanup(); } catch { /* ignore */ }
      }
    }
    hs = {
      states: [],
      refs: [],
      effects: [],
      callbacks: [],
      stateIdx: 0,
      refIdx: 0,
      effectIdx: 0,
      callbackIdx: 0,
    };
  }

  return { install, uninstall, run, reread, unmount };
}

// ---------------------------------------------------------------------------
// Import the hook (after all top-level mocks are in place)
// ---------------------------------------------------------------------------

import {
  useVideoCodecFallback,
  UseVideoCodecFallbackOptions,
} from '../../hooks/useVideoCodecFallback';

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe('useVideoCodecFallback — Property 1: Codec error triggers source swap to transcodedUrl', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    harness.install();
    jest.clearAllMocks();
    // canPlayCodec returns false — H.265 not supported (web platform).
    const { canPlayCodec } = require('@/utils/codecDetector');
    (canPlayCodec as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    harness.uninstall();
    harness.unmount();
    jest.clearAllMocks();
  });

  it(
    'onSourceResolved is called with transcodedUri (not uri) after onCodecError, phase is not error',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.webUrl(),
          (uri, transcodedUri) => {
            // Reinitialise harness for each property run.
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();
            const onSpinnerChange = jest.fn();
            const onPermanentError = jest.fn();
            const onTimeoutError = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri,
              tenantId: 'tenant-123',
              onSourceResolved,
              onSpinnerChange,
              onPermanentError,
              onTimeoutError,
            };

            // Initial render — mount effect runs and may proactively swap.
            const result = harness.run(() => useVideoCodecFallback(options));

            // Clear mocks so we isolate the reactive onCodecError path.
            onSourceResolved.mockClear();
            onSpinnerChange.mockClear();
            onPermanentError.mockClear();

            // Simulate UnsupportedCodecError (Requirement 1.1).
            result.onCodecError(10);

            // onSourceResolved MUST have been called with transcodedUri as first arg.
            expect(onSourceResolved).toHaveBeenCalledTimes(1);
            const [resolvedUri] = onSourceResolved.mock.calls[0] as [string, number];
            expect(resolvedUri).toBe(transcodedUri);

            // The original uri must NOT be passed as the resolved source.
            expect(resolvedUri).not.toBe(uri);

            // No permanent error should have been surfaced.
            expect(onPermanentError).not.toHaveBeenCalled();

            // Re-read the latest state to verify phase is not 'error'.
            const latest = harness.reread(() => useVideoCodecFallback(options));
            expect(latest.phase).not.toBe('error');
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it(
    'onSourceResolved receives transcodedUri as first argument for any valid URL pair',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.webUrl(),
          (uri, transcodedUri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri,
              tenantId: 'tenant-abc',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError: jest.fn(),
              onTimeoutError: jest.fn(),
            };

            const result = harness.run(() => useVideoCodecFallback(options));

            // Clear any proactive swap call, isolate reactive path.
            onSourceResolved.mockClear();

            // Reactive path: call onCodecError.
            result.onCodecError(5);

            // onSourceResolved must be called and the first arg must be transcodedUri.
            expect(onSourceResolved).toHaveBeenCalled();
            const firstArg = (
              onSourceResolved.mock.calls[onSourceResolved.mock.calls.length - 1] as [
                string,
                number,
              ]
            )[0];
            expect(firstArg).toBe(transcodedUri);
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

// Feature: video-transcoding-compatibility, Property 2: Seek position is preserved within 1 second across source swap

/**
 * **Validates: Requirements 1.6**
 *
 * Property 2: Seek position is preserved within 1 second across source swap
 *
 * For any `currentTime` value in the range [0, 7200] recorded at the moment of
 * an UnsupportedCodecError, after the VideoPlayer swaps to `transcodedUri` the
 * resulting playback position SHALL satisfy `|seekedPosition − recordedCurrentTime| ≤ 1`.
 *
 * The hook passes `currentTimeAtError` directly as `seekTo` to `onSourceResolved`,
 * so the difference is exactly 0. The property validates the mechanism end-to-end.
 *
 * Generator: `fc.float({ min: 0, max: 7200, noNaN: true })` for currentTime
 */

describe('useVideoCodecFallback — Property 2: Seek position is preserved within 1 second across source swap', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    harness.install();
    jest.clearAllMocks();
    const { canPlayCodec } = require('@/utils/codecDetector');
    (canPlayCodec as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    harness.uninstall();
    harness.unmount();
    jest.clearAllMocks();
  });

  it(
    'seekTo passed to onSourceResolved is within 1 second of currentTime at codec error',
    () => {
      fc.assert(
        fc.property(
          // Generator: finite float in [0, 7200]. NaN is excluded because a real
          // video playback position is always a finite number.
          fc.float({ min: 0, max: 7200, noNaN: true }),
          (currentTime) => {
            // Reinitialise harness for isolation between property runs.
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            // Capture the seekTo value passed to onSourceResolved.
            let capturedSeekTo: number | undefined;
            let capturedResolvedUri: string | undefined;

            const onSourceResolved = jest.fn((resolvedUri: string, seekTo: number) => {
              capturedResolvedUri = resolvedUri;
              capturedSeekTo = seekTo;
            });

            const transcodedUri = 'https://cdn.example.com/video-h264.mp4';
            const uri = 'https://origin.example.com/video-h265.mp4';

            const opts: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri,
              tenantId: 'tenant-abc',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError: jest.fn(),
              onTimeoutError: jest.fn(),
            };

            // Mount the hook — proactive mount swap may fire on mount.
            const result = harness.run(() => useVideoCodecFallback(opts));

            // Clear mount-time calls to isolate the reactive onCodecError path.
            onSourceResolved.mockClear();

            // Trigger the reactive codec-error path with the generated currentTime.
            // This simulates useWebVideoPlayer reporting an UnsupportedCodecError.
            result.onCodecError(currentTime);

            // onSourceResolved MUST have been called (the swap happened).
            expect(onSourceResolved).toHaveBeenCalled();

            // The resolved URI must be transcodedUri (not the original).
            expect(capturedResolvedUri).toBe(transcodedUri);

            // ── Core property assertion (Requirement 1.6) ─────────────────────
            // The seek position MUST be within 1 second of the recorded currentTime.
            expect(capturedSeekTo).toBeDefined();
            const diff = Math.abs((capturedSeekTo as number) - currentTime);
            expect(diff).toBeLessThanOrEqual(1);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it('seek position is exactly equal to currentTime at error (zero drift for specific values)', () => {
    // Companion example-based test: confirms no rounding or drift occurs.
    const testCases = [0, 1, 30, 120, 3599.9, 7200];

    for (const currentTime of testCases) {
      harness.uninstall();
      harness.unmount();
      jest.clearAllMocks();
      harness = createHarness();
      harness.install();

      const { canPlayCodec } = require('@/utils/codecDetector');
      (canPlayCodec as jest.Mock).mockReturnValue(false);

      let capturedSeekTo: number | undefined;

      const onSourceResolved = jest.fn((_resolvedUri: string, seekTo: number) => {
        capturedSeekTo = seekTo;
      });

      const opts: UseVideoCodecFallbackOptions = {
        uri: 'https://origin.example.com/video-h265.mp4',
        transcodedUri: 'https://cdn.example.com/video-h264.mp4',
        tenantId: 'tenant-test',
        onSourceResolved,
        onSpinnerChange: jest.fn(),
        onPermanentError: jest.fn(),
        onTimeoutError: jest.fn(),
      };

      const result = harness.run(() => useVideoCodecFallback(opts));

      // Clear mount-time proactive swap calls.
      onSourceResolved.mockClear();

      // Trigger the reactive path.
      result.onCodecError(currentTime);

      // seekTo must exactly match currentTime (the hook passes it directly, no drift).
      expect(capturedSeekTo).toBe(currentTime);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

// Feature: video-transcoding-compatibility, Property 7: Non-empty transcodedUri prop is used as primary video source

/**
 * **Validates: Requirements 2.6**
 *
 * Property 7: Non-empty transcodedUri prop is used as primary video source
 *
 * When the VideoPlayer (via useVideoCodecFallback) is given a non-empty
 * `transcodedUri` prop AND `canPlayCodec('h265')` returns false (the proactive
 * check fires on mount), the hook SHALL resolve `transcodedUri` as the active
 * source. The original `uri` MUST NOT be passed to `onSourceResolved` at any
 * point — `transcodedUri` is the primary source.
 *
 * Generator: `fc.webUrl()` for transcodedUri; assert `onSourceResolved`
 * is called with transcodedUri (not uri) as first argument.
 */

describe('useVideoCodecFallback — Property 7: Non-empty transcodedUri prop is used as primary video source', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    harness.install();
    jest.clearAllMocks();
    const { canPlayCodec } = require('@/utils/codecDetector');
    (canPlayCodec as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    harness.uninstall();
    harness.unmount();
    jest.clearAllMocks();
  });

  it(
    'onSourceResolved is called with transcodedUri (not uri) as primary source on mount',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.webUrl(),
          (uri, transcodedUri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri,
              tenantId: 'tenant-p7',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError: jest.fn(),
              onTimeoutError: jest.fn(),
            };

            // Mount + flush effects — proactive codec check fires here.
            harness.run(() => useVideoCodecFallback(options));

            // The proactive path MUST have resolved to transcodedUri.
            expect(onSourceResolved).toHaveBeenCalled();
            const allCalls = onSourceResolved.mock.calls as [string, number][];

            // Every call to onSourceResolved must use transcodedUri, never uri.
            for (const [resolvedUri] of allCalls) {
              expect(resolvedUri).toBe(transcodedUri);
              expect(resolvedUri).not.toBe(uri);
            }
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it(
    'uri is never passed as resolvedUri when transcodedUri is non-empty',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.webUrl(),
          (uri, transcodedUri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const resolvedUris: string[] = [];
            const onSourceResolved = jest.fn((resolvedUri: string) => {
              resolvedUris.push(resolvedUri);
            });

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri,
              tenantId: 'tenant-p7b',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError: jest.fn(),
              onTimeoutError: jest.fn(),
            };

            harness.run(() => useVideoCodecFallback(options));

            // uri must never appear as a resolved source.
            expect(resolvedUris).not.toContain(uri);
            // At least one call with transcodedUri must exist.
            expect(resolvedUris).toContain(transcodedUri);
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

// Feature: video-transcoding-compatibility, Property 8: Whitespace-only transcodedUri is treated as absent

/**
 * **Validates: Requirements 2.7**
 *
 * Property 8: Whitespace-only transcodedUri is treated as absent
 *
 * When the VideoPlayer (via useVideoCodecFallback) receives a `transcodedUri`
 * that is non-null but contains only whitespace characters (e.g., " ", "\t",
 * "\n"), the hook SHALL treat it as absent: no swap SHALL occur on mount and
 * `onSourceResolved` SHALL NOT be called with a whitespace string as the URI.
 *
 * (The hook computes `effectiveTranscodedUri = transcodedUri?.trim() || undefined`;
 * a whitespace-only value becomes `undefined`, so the proactive path falls into
 * the "no transcodedUri" branch, which leaves the phase at `idle`.)
 *
 * CORRECTED EXPECTATION — the first test below previously asserted
 * `phase === 'error'` and that `onPermanentError` had fired on mount. That was
 * wrong for the same reason as Property 20 (see the note there): `canPlayType`
 * returning "" is advisory, not a veto, so an unsupported-codec reading on mount
 * must not produce a permanent error. Requirement 2.7 — the criterion this
 * property actually validates — only says a whitespace `transcodedUri` is
 * treated as absent; it says nothing about entering an error phase. Asserting
 * `idle` is the faithful reading and is strictly more precise than the old
 * assertion, since it also rules out a spurious `done`/`swapping`.
 *
 * Generator: `fc.string().filter(s => s.trim() === '')` for transcodedUri;
 * `fc.webUrl()` for uri; assert phase is `idle`, no permanent error, and
 * `onSourceResolved` is never called with a whitespace-only URI.
 */

describe('useVideoCodecFallback — Property 8: Whitespace-only transcodedUri is treated as absent', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    harness.install();
    jest.clearAllMocks();
    const { canPlayCodec } = require('@/utils/codecDetector');
    (canPlayCodec as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    harness.uninstall();
    harness.unmount();
    jest.clearAllMocks();
  });

  it(
    'whitespace-only transcodedUri is treated as absent: no swap, phase stays idle',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          // Generator: strings that are non-empty but consist entirely of whitespace.
          fc.string({ minLength: 1 }).filter((s) => s.trim() === ''),
          (uri, whitespaceTranscodedUri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();
            const onPermanentError = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri: whitespaceTranscodedUri,
              tenantId: 'tenant-p8',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError,
              onTimeoutError: jest.fn(),
            };

            // Mount + flush effects.
            harness.run(() => useVideoCodecFallback(options));

            // onSourceResolved must never be called with a whitespace-only URI.
            const allCalls = onSourceResolved.mock.calls as [string, number][];
            for (const [resolvedUri] of allCalls) {
              // If somehow called, the resolved URI must NOT be the whitespace string.
              expect(resolvedUri.trim()).not.toBe('');
            }

            // The whitespace value must not have been treated as a usable source,
            // so no swap may have happened at all.
            expect(onSourceResolved).not.toHaveBeenCalled();

            // Mount must not raise a permanent error — capability detection is
            // advisory; only a real UnsupportedCodecError may drive that.
            expect(onPermanentError).not.toHaveBeenCalled();

            // Re-read phase: must still be 'idle' (not 'done'/'swapping'/'error').
            const latest = harness.reread(() => useVideoCodecFallback(options));
            expect(latest.phase).toBe('idle');
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it(
    'whitespace-only transcodedUri: onSourceResolved is never called',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.string({ minLength: 1 }).filter((s) => s.trim() === ''),
          (uri, whitespaceTranscodedUri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri: whitespaceTranscodedUri,
              tenantId: 'tenant-p8b',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError: jest.fn(),
              onTimeoutError: jest.fn(),
            };

            harness.run(() => useVideoCodecFallback(options));

            // With a whitespace-only transcodedUri (treated as absent), no source
            // can be resolved — onSourceResolved must not be invoked at all.
            expect(onSourceResolved).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

// Feature: video-transcoding-compatibility, Property 19: canPlayCodec('h265') === false AND transcodedUri present → H.264 loaded directly

/**
 * **Validates: Requirements 5.4**
 *
 * Property 19: canPlayCodec('h265') === false AND transcodedUri present → H.264 loaded directly
 *
 * WHEN `canPlayCodec('h265')` returns `false` on web AND the hook receives a
 * non-empty `transcodedUri`, the hook SHALL proactively set the active playback
 * source to `transcodedUri` before any `<video>` element event fires. The
 * original `uri` SHALL NOT be passed to `onSourceResolved` at any point.
 *
 * This validates the proactive codec check path (Requirement 5.4):
 *   canPlayCodec('h265') === false + effectiveTranscodedUri present
 *   → performSwap(effectiveTranscodedUri, 0)
 *   → onSourceResolved called with transcodedUri
 *   → phase transitions to 'done'
 *
 * Generator: `fc.webUrl()` for transcodedUri; `canPlayCodec` mocked to return
 * false; assert `onSourceResolved` is called with transcodedUri, uri is never
 * set as src.
 */

describe('useVideoCodecFallback — Property 19: canPlayCodec false + transcodedUri present → H.264 loaded directly', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    harness.install();
    jest.clearAllMocks();
    const { canPlayCodec } = require('@/utils/codecDetector');
    (canPlayCodec as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    harness.uninstall();
    harness.unmount();
    jest.clearAllMocks();
  });

  it(
    'proactive check: transcodedUri is loaded directly when canPlayCodec returns false',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.webUrl(),
          (uri, transcodedUri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            // Mock: H.265 not supported — proactive path must fire.
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri,
              tenantId: 'tenant-p19',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError: jest.fn(),
              onTimeoutError: jest.fn(),
            };

            // Mount: proactive check fires synchronously during effect flush.
            harness.run(() => useVideoCodecFallback(options));

            // onSourceResolved MUST have been called (H.264 loaded directly).
            expect(onSourceResolved).toHaveBeenCalled();

            const allCalls = onSourceResolved.mock.calls as [string, number][];

            // The resolved source must be transcodedUri, not the original uri.
            for (const [resolvedUri] of allCalls) {
              expect(resolvedUri).toBe(transcodedUri);
              expect(resolvedUri).not.toBe(uri);
            }

            // Phase must be 'done' (not 'error', not 'idle').
            const latest = harness.reread(() => useVideoCodecFallback(options));
            expect(latest.phase).toBe('done');
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it(
    'proactive check: phase reaches done and seekTo is 0 (no prior playback position)',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          fc.webUrl(),
          (uri, transcodedUri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            let capturedSeekTo: number | undefined;
            const onSourceResolved = jest.fn((_resolvedUri: string, seekTo: number) => {
              capturedSeekTo = seekTo;
            });

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri,
              tenantId: 'tenant-p19b',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError: jest.fn(),
              onTimeoutError: jest.fn(),
            };

            harness.run(() => useVideoCodecFallback(options));

            // seekTo must be 0 — no playback had started before the proactive check.
            expect(capturedSeekTo).toBe(0);
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

// Feature: video-transcoding-compatibility, Property 20: canPlayCodec('h265') === false AND no transcodedUri → no video source resolved, no premature error

/**
 * **Validates: Requirements 5.5 (no source resolved for the original uri), 1.3**
 *
 * Property 20: canPlayCodec('h265') === false AND no transcodedUri → no video
 * source is resolved on mount, and no permanent error is raised
 *
 * WHEN `canPlayCodec('h265')` returns `false` on web AND the VideoPlayer has
 * no `transcodedUri` (undefined or omitted), the hook SHALL NOT call
 * `onSourceResolved` (no `<video>` source is assigned — in particular the
 * original `uri` is never assigned), SHALL NOT call `onPermanentError`, and
 * SHALL remain in the `idle` phase awaiting a real UnsupportedCodecError.
 *
 *   canPlayCodec('h265') === false + no effectiveTranscodedUri
 *   → phase stays 'idle'
 *   → onSourceResolved never called
 *   → onPermanentError never called
 *
 * CORRECTED EXPECTATION — both tests below previously asserted `phase === 'error'`
 * and that `onPermanentError` had fired on mount, quoting the first half of
 * Requirement 5.5 ("render the 'Video format not supported' error state"). That
 * expectation was wrong at the hook level:
 *
 *   • `canPlayType` returns "" for hvc1 on Chrome 107+ / macOS 13+, browsers that
 *     CAN decode H.265 via VideoToolbox. A pre-emptive veto blacks out videos
 *     that would have played.
 *   • Every Requirement 1 criterion is phrased "WHEN the VideoPlayer detects an
 *     UnsupportedCodecError" — reactive detection, not a capability veto.
 *     Requirement 1.3 requires POSTing /video/request-transcode and polling when
 *     no transcode document exists, which erroring on mount makes unreachable.
 *     Requirement 1.7 allows the permanent error only if the transcoded URL also
 *     fails after the swap.
 *   • The shipped VideoPlayer mount path matches this: it schedules a short timer
 *     that calls the codec-error handler, it does not render a capability error.
 *
 * The SECOND half of Requirement 5.5 — "SHALL NOT create or load any <video>
 * element for the original uri" — is real, and remains asserted here (and is
 * reinforced by Requirement 7.4). Only the "render the error state" half is not
 * asserted, because it conflicts with Requirements 1.3/1.7. That conflict lives
 * in requirements.md, not in this test; it is reported for the requirements
 * record and deliberately NOT resolved here.
 *
 * Generator: `fc.webUrl()` for uri; `canPlayCodec` mocked to return false;
 * no transcodedUri passed; assert phase is `idle` and `onSourceResolved` /
 * `onPermanentError` are never called.
 */

describe('useVideoCodecFallback — Property 20: canPlayCodec false + no transcodedUri → no source resolved, no premature error', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    harness.install();
    jest.clearAllMocks();
    const { canPlayCodec } = require('@/utils/codecDetector');
    (canPlayCodec as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    harness.uninstall();
    harness.unmount();
    jest.clearAllMocks();
  });

  it(
    'phase stays idle and onSourceResolved is never called when no transcodedUri',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          (uri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            // Mock: H.265 not supported — no transcodedUri available.
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();
            const onPermanentError = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              // transcodedUri intentionally omitted (undefined).
              tenantId: 'tenant-p20',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError,
              onTimeoutError: jest.fn(),
            };

            // Mount: proactive check fires; no transcodedUri → stays idle.
            harness.run(() => useVideoCodecFallback(options));

            // onSourceResolved must NEVER be called — no <video> source is
            // resolved on mount, so the original uri is never assigned as src
            // (Requirement 5.5 second half, Requirement 7.4).
            expect(onSourceResolved).not.toHaveBeenCalled();

            // No premature permanent error — only a real UnsupportedCodecError
            // (or a failed swap target, Requirement 1.7) may raise one.
            expect(onPermanentError).not.toHaveBeenCalled();

            // Phase must still be 'idle', awaiting reactive detection.
            const latest = harness.reread(() => useVideoCodecFallback(options));
            expect(latest.phase).toBe('idle');
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it(
    'idle phase is preserved for any uri when transcodedUri is explicitly undefined',
    () => {
      fc.assert(
        fc.property(
          fc.webUrl(),
          (uri) => {
            harness.uninstall();
            harness.unmount();
            jest.clearAllMocks();
            harness = createHarness();
            harness.install();

            const { canPlayCodec } = require('@/utils/codecDetector');
            (canPlayCodec as jest.Mock).mockReturnValue(false);

            const onSourceResolved = jest.fn();
            const onPermanentError = jest.fn();

            const options: UseVideoCodecFallbackOptions = {
              uri,
              transcodedUri: undefined, // Explicitly undefined.
              tenantId: 'tenant-p20b',
              onSourceResolved,
              onSpinnerChange: jest.fn(),
              onPermanentError,
              onTimeoutError: jest.fn(),
            };

            harness.run(() => useVideoCodecFallback(options));

            // No video source must be resolved.
            expect(onSourceResolved).not.toHaveBeenCalled();

            // No permanent error on mount.
            expect(onPermanentError).not.toHaveBeenCalled();

            // Phase must still be 'idle'.
            const latest = harness.reread(() => useVideoCodecFallback(options));
            expect(latest.phase).toBe('idle');
          },
        ),
        { numRuns: 50 },
      );
    },
  );
});
