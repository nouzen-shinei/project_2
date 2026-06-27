// Feature: video-transcoding-compatibility

/**
 * Unit tests for `useWebVideoPlayer`
 *
 * Validates: Requirements 4.2
 *
 * Coverage:
 *   - All required WebPlayerState fields are present with correct initial values
 *   - UnsupportedCodecError detection via zero videoWidth/videoHeight after loadedmetadata (duration > 0)
 *   - UnsupportedCodecError detection via MediaError.code === 4 (MEDIA_ERR_SRC_NOT_SUPPORTED)
 *   - UnsupportedCodecError detection via MediaError.code === 3 (MEDIA_ERR_DECODE)
 *
 * Test strategy:
 *   Because no DOM renderer (react-test-renderer / @testing-library/react-hooks) is
 *   installed in this project, we test the hook by intercepting React's module-level
 *   hooks (useState, useEffect, useRef, useCallback) before the hook module is loaded.
 *   We capture every effect callback and every setState call, then trigger them
 *   imperatively — giving us deterministic, synchronous control over all state
 *   transitions without needing a React tree.
 */

// ─── Types re-exported from the hook ─────────────────────────────────────────

import type { WebPlayerState, UseWebVideoPlayerOptions } from '../../hooks/useWebVideoPlayer';

// ─── Fake HTMLVideoElement ────────────────────────────────────────────────────

type EventHandler = () => void;

interface FakeVideoElement {
  src: string;
  muted: boolean;
  playsInline: boolean;
  preload: string;
  playbackRate: number;
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  error: MediaError | null;
  play: jest.Mock;
  pause: jest.Mock;
  load: jest.Mock;
  removeAttribute: jest.Mock;
  addEventListener: jest.Mock;
  removeEventListener: jest.Mock;
  /** Map of eventName → registered handler (last registration wins per event name). */
  _handlers: Map<string, EventHandler>;
  /** Fire a registered event by name. */
  _fire: (eventName: string) => void;
}

function makeFakeVideoElement(): FakeVideoElement {
  const handlers = new Map<string, EventHandler>();

  const el: FakeVideoElement = {
    src: '',
    muted: false,
    playsInline: false,
    preload: '',
    playbackRate: 1,
    currentTime: 0,
    duration: 0,
    videoWidth: 0,
    videoHeight: 0,
    error: null,
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
    load: jest.fn(),
    removeAttribute: jest.fn(),
    addEventListener: jest.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
    removeEventListener: jest.fn(),
    _handlers: handlers,
    _fire: (eventName: string) => {
      const h = handlers.get(eventName);
      if (h) h();
    },
  };

  return el;
}

// ─── Test harness ─────────────────────────────────────────────────────────────

/**
 * Drives `useWebVideoPlayer` without a React renderer.
 *
 * 1. Mocks `react-native`'s Platform so `Platform.OS === 'web'`.
 * 2. Mocks `document.createElement('video')` to return a `FakeVideoElement`.
 * 3. Intercepts React's `useState`, `useEffect`, `useRef`, and `useCallback`
 *    so we can capture and invoke effect callbacks synchronously.
 * 4. Loads the hook module fresh via `jest.isolateModules`.
 * 5. Calls the hook function once (simulating a first render), which registers
 *    all effects but does not run them yet.
 * 6. Runs only the primary URI effect (the one that creates the `<video>`
 *    element and attaches event listeners) synchronously.
 * 7. Returns the fake video element and helpers for state inspection.
 */
interface HookHarness {
  fakeEl: FakeVideoElement;
  getState: () => WebPlayerState;
  onUnsupportedCodec: jest.Mock;
  cleanup: () => void;
}

function runHook(overrides: Partial<UseWebVideoPlayerOptions> = {}): HookHarness {
  const fakeEl = makeFakeVideoElement();
  const onUnsupportedCodec = jest.fn();

  // ── Captured hook internals ──────────────────────────────────────────────

  // We capture every setState dispatcher returned by useState calls in order.
  const stateSetters: Array<(updater: unknown) => void> = [];
  let currentState: WebPlayerState = {
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    bufferedPercent: null,
    isBuffering: false,
    isStalled: false,
    error: null,
    ended: false,
  };

  // We capture every effect callback + deps in order. We only auto-run the
  // first one whose dependency array contains the resolvedUri (the primary
  // element-creation effect).
  const capturedEffects: Array<{ fn: () => (() => void) | void; deps: unknown[] | undefined }> = [];

  // We capture every ref so videoRef.current can be verified.
  const capturedRefs: Array<{ current: unknown }> = [];

  let effectCleanup: (() => void) | void;

  // ── Mock react-native Platform ───────────────────────────────────────────

  jest.doMock('react-native', () => ({
    Platform: { OS: 'web' },
  }));

  // ── Mock document.createElement ─────────────────────────────────────────

  (global as unknown as Record<string, unknown>).document = {
    createElement: (_tag: string) => fakeEl,
    // minimal stub — the hook only calls createElement
  };

  // ── Intercept React hooks ────────────────────────────────────────────────

  jest.doMock('react', () => {
    const actualReact = jest.requireActual<typeof import('react')>('react');

    let stateCallCount = 0;

    const useState = <T>(initialValue: T | (() => T)): [T, (v: T | ((p: T) => T)) => void] => {
      stateCallCount++;
      // The first useState call in the hook is the main WebPlayerState.
      if (stateCallCount === 1) {
        const init = typeof initialValue === 'function'
          ? (initialValue as () => T)()
          : initialValue;
        currentState = init as unknown as WebPlayerState;

        const setter = (updater: T | ((prev: T) => T)) => {
          if (typeof updater === 'function') {
            currentState = (updater as (prev: WebPlayerState) => WebPlayerState)(currentState) as unknown as WebPlayerState;
          } else {
            currentState = updater as unknown as WebPlayerState;
          }
        };
        stateSetters.push(setter as (updater: unknown) => void);
        return [init, setter];
      }
      // Other useState calls — return stable stubs.
      const setter = (_v: unknown) => {};
      stateSetters.push(setter);
      return [initialValue instanceof Function ? initialValue() : initialValue, setter as (v: T | ((p: T) => T)) => void];
    };

    const useRef = <T>(initial: T) => {
      const ref = { current: initial };
      capturedRefs.push(ref);
      return ref;
    };

    const useEffect = (fn: () => (() => void) | void, deps?: unknown[]) => {
      capturedEffects.push({ fn, deps });
    };

    const useCallback = <T extends (...args: unknown[]) => unknown>(fn: T, _deps: unknown[]) => fn;

    return {
      ...actualReact,
      useState,
      useRef,
      useEffect,
      useCallback,
    };
  });

  // ── Load the hook with fresh module registry ─────────────────────────────

  let hookFn!: (opts: UseWebVideoPlayerOptions) => { state: WebPlayerState };

  jest.isolateModules(() => {
    const mod = require('../../hooks/useWebVideoPlayer') as {
      useWebVideoPlayer: (opts: UseWebVideoPlayerOptions) => { state: WebPlayerState };
    };
    hookFn = mod.useWebVideoPlayer;
  });

  // ── Invoke the hook (simulates a first render) ───────────────────────────

  const options: UseWebVideoPlayerOptions = {
    resolvedUri: 'https://example.com/video.mp4',
    onUnsupportedCodec,
    ...overrides,
  };

  hookFn(options);

  // ── Run the primary URI effect (last useEffect whose deps include the URI) ─
  // The hook uses multiple effects for syncing refs. The one that creates the
  // video element is the first effect that has a non-empty deps array OR is
  // the sole effect that calls document.createElement. We find it by running
  // the effect that results in addEventListener being called.

  let primaryEffectIndex = -1;
  for (let i = 0; i < capturedEffects.length; i++) {
    const { fn } = capturedEffects[i];
    // Run it tentatively and check if addEventListener was called.
    const prevCallCount = (fakeEl.addEventListener as jest.Mock).mock.calls.length;
    const cleanup = fn();
    if ((fakeEl.addEventListener as jest.Mock).mock.calls.length > prevCallCount) {
      primaryEffectIndex = i;
      effectCleanup = cleanup;
      break;
    }
    // Undo any side-effects by running cleanup if present.
    if (typeof cleanup === 'function') cleanup();
  }

  if (primaryEffectIndex === -1) {
    throw new Error('Could not find the primary URI effect in capturedEffects');
  }

  return {
    fakeEl,
    getState: () => currentState,
    onUnsupportedCodec,
    cleanup: () => {
      if (typeof effectCleanup === 'function') effectCleanup();
      delete (global as unknown as Record<string, unknown>).document;
      jest.dontMock('react-native');
      jest.dontMock('react');
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useWebVideoPlayer — initial WebPlayerState fields', () => {
  afterEach(() => {
    jest.resetModules();
    delete (global as unknown as Record<string, unknown>).document;
  });

  it('returns all required WebPlayerState fields with correct initial values', () => {
    const { getState, cleanup } = runHook();

    const state = getState();

    // All required fields per Requirement 4.2
    expect(state).toHaveProperty('isPlaying', false);
    expect(state).toHaveProperty('currentTime', 0);
    expect(state).toHaveProperty('duration', 0);
    expect(state).toHaveProperty('bufferedPercent', null);
    expect(state).toHaveProperty('isBuffering', false);
    expect(state).toHaveProperty('isStalled', false);
    expect(state).toHaveProperty('error', null);
    expect(state).toHaveProperty('ended', false);

    cleanup();
  });

  it('state object has exactly the eight required fields', () => {
    const { getState, cleanup } = runHook();

    const state = getState();
    const keys = Object.keys(state).sort();

    expect(keys).toEqual(
      ['bufferedPercent', 'currentTime', 'duration', 'ended', 'error', 'isBuffering', 'isPlaying', 'isStalled'].sort()
    );

    cleanup();
  });
});

describe('useWebVideoPlayer — UnsupportedCodecError via zero dimensions after loadedmetadata', () => {
  afterEach(() => {
    jest.resetModules();
    delete (global as unknown as Record<string, unknown>).document;
  });

  it('fires onUnsupportedCodec when videoWidth === 0 and videoHeight === 0 and duration > 0', () => {
    const { fakeEl, onUnsupportedCodec, getState, cleanup } = runHook();

    // Simulate zero-dimension video with valid duration (H.265 on unsupported browser)
    fakeEl.videoWidth = 0;
    fakeEl.videoHeight = 0;
    fakeEl.duration = 42.5;
    fakeEl.currentTime = 5;

    fakeEl._fire('loadedmetadata');

    expect(onUnsupportedCodec).toHaveBeenCalledTimes(1);
    expect(onUnsupportedCodec).toHaveBeenCalledWith(5); // currentTime at detection
    expect(getState().error).toBe('unsupported-codec');

    cleanup();
  });

  it('does NOT fire onUnsupportedCodec when videoWidth > 0 (normal video)', () => {
    const { fakeEl, onUnsupportedCodec, cleanup } = runHook();

    fakeEl.videoWidth = 1280;
    fakeEl.videoHeight = 720;
    fakeEl.duration = 10;

    fakeEl._fire('loadedmetadata');

    expect(onUnsupportedCodec).not.toHaveBeenCalled();

    cleanup();
  });

  it('does NOT fire onUnsupportedCodec when duration is 0 even with zero dimensions (stream not ready)', () => {
    const { fakeEl, onUnsupportedCodec, cleanup } = runHook();

    fakeEl.videoWidth = 0;
    fakeEl.videoHeight = 0;
    fakeEl.duration = 0;

    fakeEl._fire('loadedmetadata');

    expect(onUnsupportedCodec).not.toHaveBeenCalled();

    cleanup();
  });
});

describe('useWebVideoPlayer — UnsupportedCodecError via MediaError.code === 4', () => {
  afterEach(() => {
    jest.resetModules();
    delete (global as unknown as Record<string, unknown>).document;
  });

  it('fires onUnsupportedCodec when MediaError.code === 4 (MEDIA_ERR_SRC_NOT_SUPPORTED)', () => {
    const { fakeEl, onUnsupportedCodec, getState, cleanup } = runHook();

    fakeEl.error = { code: 4, message: 'Format not supported', MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };
    fakeEl.currentTime = 3.2;

    fakeEl._fire('error');

    expect(onUnsupportedCodec).toHaveBeenCalledTimes(1);
    expect(onUnsupportedCodec).toHaveBeenCalledWith(3.2);
    expect(getState().error).toBe('unsupported-codec');

    cleanup();
  });

  it('sets isBuffering to false when MediaError.code === 4 fires', () => {
    const { fakeEl, getState, cleanup } = runHook();

    fakeEl.error = { code: 4, message: '', MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };

    fakeEl._fire('error');

    expect(getState().isBuffering).toBe(false);

    cleanup();
  });
});

describe('useWebVideoPlayer — UnsupportedCodecError via MediaError.code === 3', () => {
  afterEach(() => {
    jest.resetModules();
    delete (global as unknown as Record<string, unknown>).document;
  });

  it('fires onUnsupportedCodec when MediaError.code === 3 (MEDIA_ERR_DECODE)', () => {
    const { fakeEl, onUnsupportedCodec, getState, cleanup } = runHook();

    fakeEl.error = { code: 3, message: 'Decode error', MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };
    fakeEl.currentTime = 12.7;

    fakeEl._fire('error');

    expect(onUnsupportedCodec).toHaveBeenCalledTimes(1);
    expect(onUnsupportedCodec).toHaveBeenCalledWith(12.7);
    expect(getState().error).toBe('unsupported-codec');

    cleanup();
  });

  it('does NOT fire onUnsupportedCodec for non-codec MediaError codes (code 2 = MEDIA_ERR_NETWORK)', () => {
    const { fakeEl, onUnsupportedCodec, getState, cleanup } = runHook();

    fakeEl.error = { code: 2, message: 'Network error', MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };

    fakeEl._fire('error');

    expect(onUnsupportedCodec).not.toHaveBeenCalled();
    expect(getState().error).not.toBe('unsupported-codec');

    cleanup();
  });

  it('does NOT fire onUnsupportedCodec when el.error is null', () => {
    const { fakeEl, onUnsupportedCodec, getState, cleanup } = runHook();

    fakeEl.error = null;

    fakeEl._fire('error');

    expect(onUnsupportedCodec).not.toHaveBeenCalled();

    cleanup();
  });
});
