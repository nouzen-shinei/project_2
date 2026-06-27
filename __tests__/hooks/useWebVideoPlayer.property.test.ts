// Feature: video-transcoding-compatibility, Property 16: videoRef.current is stable across state-only re-renders

/**
 * **Validates: Requirements 4.7**
 *
 * Property 16: videoRef.current is stable across state-only re-renders
 *
 * For any sequence of state-changing actions (mute, speed, controls), the
 * `videoRef.current` HTMLVideoElement reference returned by `useWebVideoPlayer`
 * SHALL remain the same object throughout. A new element is only created when
 * `resolvedUri` changes.
 *
 * Generator: `fc.array(fc.constantFrom('mute', 'speed', 'controls'), { minLength: 1, maxLength: 10 })`
 */

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that load the hook.
// ---------------------------------------------------------------------------

jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fake HTMLVideoElement factory
// ---------------------------------------------------------------------------

function createFakeVideoElement(): HTMLVideoElement {
  const listeners: Record<string, EventListenerOrEventListenerObject[]> = {};

  return {
    muted: false,
    playsInline: false,
    preload: '',
    playbackRate: 1,
    src: '',
    currentTime: 0,
    duration: 0,
    videoWidth: 640,
    videoHeight: 480,
    error: null,
    buffered: { length: 0, end: () => 0, start: () => 0 } as unknown as TimeRanges,
    addEventListener(type: string, handler: EventListenerOrEventListenerObject) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type: string, handler: EventListenerOrEventListenerObject) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter((h) => h !== handler);
    },
    load: jest.fn(),
    pause: jest.fn(),
    play: jest.fn().mockResolvedValue(undefined),
    removeAttribute: jest.fn(),
  } as unknown as HTMLVideoElement;
}

// ---------------------------------------------------------------------------
// Minimal hook execution engine
//
// This engine simulates React's hooks dispatcher well enough to execute
// useWebVideoPlayer in a controlled, synchronous environment (no DOM renderer).
//
// Supports: useState, useRef, useEffect (collected, then flushed), useCallback.
// ---------------------------------------------------------------------------

type EffectCleanup = (() => void) | void;
type Effect = { deps: unknown[] | undefined; fn: () => EffectCleanup; cleanup?: EffectCleanup };

interface HookState {
  states: { value: unknown; setter: (v: unknown) => void }[];
  refs: { current: unknown }[];
  effects: Effect[];
  callbacks: { fn: (...args: unknown[]) => unknown; deps: unknown[] }[];
  stateIdx: number;
  refIdx: number;
  effectIdx: number;
  callbackIdx: number;
}

function createEngine() {
  let hookState: HookState = {
    states: [],
    refs: [],
    effects: [],
    callbacks: [],
    stateIdx: 0,
    refIdx: 0,
    effectIdx: 0,
    callbackIdx: 0,
  };
  let renderFn: (() => void) | null = null;

  // ── Dispatchers ──────────────────────────────────────────────────────────

  function useState<T>(initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
    const idx = hookState.stateIdx++;
    if (hookState.states.length <= idx) {
      const value = typeof initial === 'function' ? (initial as () => T)() : initial;
      const setter = (updater: T | ((prev: T) => T)) => {
        const current = hookState.states[idx].value as T;
        hookState.states[idx].value =
          typeof updater === 'function' ? (updater as (p: T) => T)(current) : updater;
        // Trigger a re-render synchronously.
        if (renderFn) renderFn();
      };
      hookState.states.push({ value, setter });
    }
    const state = hookState.states[idx];
    return [state.value as T, state.setter as (v: T | ((prev: T) => T)) => void];
  }

  function useRef<T>(initial: T): { current: T } {
    const idx = hookState.refIdx++;
    if (hookState.refs.length <= idx) {
      hookState.refs.push({ current: initial });
    }
    return hookState.refs[idx] as { current: T };
  }

  function useEffect(fn: () => EffectCleanup, deps?: unknown[]) {
    const idx = hookState.effectIdx++;
    if (hookState.effects.length <= idx) {
      hookState.effects.push({ deps, fn });
    } else {
      const existing = hookState.effects[idx];
      // Determine if we need to re-run based on deps.
      const shouldRun =
        deps === undefined ||
        existing.deps === undefined ||
        deps.length !== (existing.deps?.length ?? 0) ||
        deps.some((d, i) => d !== (existing.deps as unknown[])[i]);
      if (shouldRun) {
        hookState.effects[idx] = { deps, fn, cleanup: existing.cleanup };
      }
    }
  }

  function useCallback<T extends (...args: unknown[]) => unknown>(fn: T, deps: unknown[]): T {
    const idx = hookState.callbackIdx++;
    if (hookState.callbacks.length <= idx) {
      hookState.callbacks.push({ fn, deps });
    } else {
      const existing = hookState.callbacks[idx];
      const changed =
        deps.length !== existing.deps.length ||
        deps.some((d, i) => d !== existing.deps[i]);
      if (changed) {
        hookState.callbacks[idx] = { fn, deps };
      }
    }
    return hookState.callbacks[idx].fn as T;
  }

  // ── Flush effects ─────────────────────────────────────────────────────────

  function flushEffects(force = false) {
    for (const effect of hookState.effects) {
      if (force || effect.fn !== (effect as unknown as { _ran?: unknown })['_ran']) {
        if (effect.cleanup) {
          try { effect.cleanup(); } catch { /* ignore */ }
        }
        const cleanup = effect.fn();
        effect.cleanup = cleanup;
        (effect as unknown as Record<string, unknown>)['_ran'] = effect.fn;
      }
    }
  }

  // ── Install dispatchers ───────────────────────────────────────────────────

  function install() {
    const React = require('react');
    jest.spyOn(React, 'useState').mockImplementation(useState as typeof React.useState);
    jest.spyOn(React, 'useRef').mockImplementation(useRef as typeof React.useRef);
    jest.spyOn(React, 'useEffect').mockImplementation(useEffect as typeof React.useEffect);
    jest.spyOn(React, 'useCallback').mockImplementation(useCallback as typeof React.useCallback);
  }

  function uninstall() {
    const React = require('react');
    jest.restoreAllMocks();
    // Suppress unused variable warning
    void React;
  }

  // ── Execute hook & flush ──────────────────────────────────────────────────

  function run<T>(hookFn: () => T): T {
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    hookState.effectIdx = 0;
    hookState.callbackIdx = 0;
    const result = hookFn();
    flushEffects();
    return result;
  }

  function rerender<T>(hookFn: () => T): T {
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    hookState.effectIdx = 0;
    hookState.callbackIdx = 0;
    const result = hookFn();
    flushEffects();
    return result;
  }

  function unmount() {
    for (const effect of hookState.effects) {
      if (effect.cleanup) {
        try { effect.cleanup(); } catch { /* ignore */ }
      }
    }
    hookState = {
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

  return { install, uninstall, run, rerender, unmount };
}

// ---------------------------------------------------------------------------
// Document stub helpers
// ---------------------------------------------------------------------------

let currentFakeEl: HTMLVideoElement | null = null;

function stubDocument() {
  currentFakeEl = null;
  (global as unknown as Record<string, unknown>)['document'] = {
    createElement: (tag: string) => {
      if (tag === 'video') {
        currentFakeEl = createFakeVideoElement();
        return currentFakeEl;
      }
      return {};
    },
  };
}

function removeDocumentStub() {
  delete (global as unknown as Record<string, unknown>)['document'];
  currentFakeEl = null;
}

// ---------------------------------------------------------------------------
// Import the hook (after mocks are declared above)
// ---------------------------------------------------------------------------

import { useWebVideoPlayer, UseWebVideoPlayerOptions } from '../../hooks/useWebVideoPlayer';

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

type StateAction = 'mute' | 'speed' | 'controls';

describe('useWebVideoPlayer — Property 16', () => {
  let engine: ReturnType<typeof createEngine>;

  beforeEach(() => {
    stubDocument();
    engine = createEngine();
    engine.install();
  });

  afterEach(() => {
    engine.uninstall();
    engine.unmount();
    removeDocumentStub();
    jest.clearAllMocks();
  });

  it(
    'videoRef.current is the same object reference across state-only re-renders',
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom<StateAction>('mute', 'speed', 'controls'),
            { minLength: 1, maxLength: 10 },
          ),
          (actions) => {
            // Fresh engine and document for each run.
            engine.uninstall();
            engine.unmount();
            removeDocumentStub();
            stubDocument();
            engine = createEngine();
            engine.install();

            const resolvedUri = 'https://example.com/video.mp4';
            let opts: UseWebVideoPlayerOptions = {
              resolvedUri,
              isMuted: false,
              playbackSpeed: 1,
              autoPlay: false,
            };

            // Initial render.
            let result = engine.run(() => useWebVideoPlayer(opts));

            const initialEl = result.videoRef.current;
            expect(initialEl).not.toBeNull();

            let isMuted = false;
            let playbackSpeed = 1;

            for (const action of actions) {
              switch (action) {
                case 'mute':
                  isMuted = !isMuted;
                  opts = { ...opts, resolvedUri, isMuted, playbackSpeed };
                  break;
                case 'speed':
                  playbackSpeed = playbackSpeed === 1 ? 1.5 : 1;
                  opts = { ...opts, resolvedUri, isMuted, playbackSpeed };
                  break;
                case 'controls':
                  // Simulate any non-URI state change.
                  opts = { ...opts, resolvedUri, isMuted, playbackSpeed };
                  break;
              }

              result = engine.rerender(() => useWebVideoPlayer(opts));

              // After every state-only re-render, the element MUST be the same.
              expect(result.videoRef.current).toBe(initialEl);
            }

            engine.uninstall();
            engine.unmount();
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it('videoRef.current changes when resolvedUri changes', () => {
    const uri1 = 'https://example.com/video1.mp4';
    const uri2 = 'https://example.com/video2.mp4';

    let opts: UseWebVideoPlayerOptions = {
      resolvedUri: uri1,
      isMuted: false,
      playbackSpeed: 1,
    };

    let result = engine.run(() => useWebVideoPlayer(opts));
    const firstEl = result.videoRef.current;
    expect(firstEl).not.toBeNull();

    // Change the URI — this is the only case a new element should be created.
    opts = { ...opts, resolvedUri: uri2 };
    result = engine.rerender(() => useWebVideoPlayer(opts));

    // After URI change, videoRef.current must NOT be the same element instance.
    expect(result.videoRef.current).not.toBe(firstEl);
  });
});
