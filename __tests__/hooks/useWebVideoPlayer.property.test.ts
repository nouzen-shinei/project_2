// Feature: video-transcoding-compatibility, Property 16: videoRef.current is stable across state-only re-renders

/**
 * **Validates: Requirements 4.7**
 *
 * Property 16: videoRef.current is stable across state-only re-renders
 *
 * For any sequence of state-changing actions (mute, speed, controls), the
 * `videoRef.current` HTMLVideoElement reference returned by `useWebVideoPlayer`
 * SHALL remain the same object throughout.
 *
 * Generator: `fc.array(fc.constantFrom('mute', 'speed', 'controls'), { minLength: 1, maxLength: 10 })`
 *
 * Who owns the element: the consumer renders `<video ref={videoRef} />`, so
 * REACT creates the element and assigns `videoRef.current` during the commit
 * phase — the hook only wires the committed element up to a source. The engine
 * below therefore models that commit (see `onCommit`) instead of letting the
 * hook build its own off-DOM element, which is what it used to do and which
 * produced a blank inline player (see the WHY-no-document.createElement comment
 * in the hook).
 */

import * as fc from 'fast-check';
import type { MutableRefObject } from 'react';

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
// Supports: useState, useRef, useEffect / useLayoutEffect (collected, then
// flushed), useCallback, and the ref-commit phase that sits between render and
// layout effects (`onCommit`).
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
      hookState.states.push({ value, setter: setter as (v: unknown) => void });
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
    // useWebVideoPlayer wires the <video> element up from a useLayoutEffect (it
    // has to run after React commits refs). This engine flushes every effect at
    // one synchronous point, so layout effects are collected exactly like
    // passive ones — without this spy the real dispatcher is reached and throws
    // "Cannot read properties of null (reading 'useLayoutEffect')".
    jest
      .spyOn(React, 'useLayoutEffect')
      .mockImplementation(useEffect as typeof React.useLayoutEffect);
    jest.spyOn(React, 'useCallback').mockImplementation(useCallback as typeof React.useCallback);
  }

  function uninstall() {
    const React = require('react');
    jest.restoreAllMocks();
    // Suppress unused variable warning
    void React;
  }

  // ── Execute hook & flush ──────────────────────────────────────────────────

  // `onCommit` stands in for React's commit phase: React attaches DOM refs
  // after rendering and BEFORE running layout effects. useWebVideoPlayer's
  // primary effect is a useLayoutEffect precisely so it can rely on that
  // ordering, and it returns early when videoRef.current is null — so without
  // an onCommit step the hook would be flushed inert and every assertion below
  // would be vacuous.
  function run<T>(hookFn: () => T, onCommit?: (result: T) => void): T {
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    hookState.effectIdx = 0;
    hookState.callbackIdx = 0;
    const result = hookFn();
    onCommit?.(result);
    flushEffects();
    return result;
  }

  function rerender<T>(hookFn: () => T, onCommit?: (result: T) => void): T {
    hookState.stateIdx = 0;
    hookState.refIdx = 0;
    hookState.effectIdx = 0;
    hookState.callbackIdx = 0;
    const result = hookFn();
    onCommit?.(result);
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
//
// The hook reads `typeof document` as its "are we in a browser" guard, so a
// document has to exist. It must NOT call createElement — React owns the
// element — but the stub still returns a working fake rather than throwing, so
// that a regression back to hook-created elements shows up as a failure of this
// property's own identity assertion (a different element than the committed
// one) instead of an unrelated exception.
// ---------------------------------------------------------------------------

function stubDocument() {
  (global as unknown as Record<string, unknown>)['document'] = {
    createElement: (tag: string) =>
      tag === 'video' ? createFakeVideoElement() : ({} as unknown),
  };
}

function removeDocumentStub() {
  delete (global as unknown as Record<string, unknown>)['document'];
}

// ---------------------------------------------------------------------------
// React's ref commit, modelled
//
// React creates the <video> node once, on mount, and keeps the SAME node for
// every subsequent render of `<video ref={videoRef} />` — there is no `key` on
// it in components/VideoPlayer.tsx, so not even a resolvedUri change replaces
// it. Assigning only when the ref is still empty reproduces exactly that.
// ---------------------------------------------------------------------------

function commitVideoRef(result: {
  videoRef: MutableRefObject<HTMLVideoElement | null>;
}): void {
  if (!result.videoRef.current) {
    result.videoRef.current = createFakeVideoElement();
  }
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

            // Initial render + commit (React attaches the <video> node here).
            let result = engine.run(() => useWebVideoPlayer(opts), commitVideoRef);

            const initialEl = result.videoRef.current;
            expect(initialEl).not.toBeNull();
            // The hook must have wired the committed element, not some other
            // one — otherwise "the reference never changes" would hold simply
            // because nothing ever touched it.
            expect(initialEl?.src).toBe(resolvedUri);

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

              result = engine.rerender(() => useWebVideoPlayer(opts), commitVideoRef);

              // After every state-only re-render, the element MUST be the same.
              expect(result.videoRef.current).toBe(initialEl);
            }

            engine.uninstall();
            engine.unmount();
          },
        ),
        // Repo convention for property suites (see the spec task notes): at
        // least 100 cases per property.
        { numRuns: 100 },
      );
    },
  );

  // Companion case: the negative control for Property 16.
  //
  // It used to read "videoRef.current changes when resolvedUri changes", which
  // described the hook's ORIGINAL design — it built its own element with
  // document.createElement inside the URI effect, so a new URI meant a new
  // element. That design was removed on purpose (it left the visible, React-
  // rendered <video> with no src and no listeners, i.e. a blank inline player).
  // React now owns the node, and `components/VideoPlayer.tsx` renders it without
  // a `key`, so a resolvedUri change does NOT replace it.
  //
  // The claim worth pinning is therefore the other half of the same behaviour:
  // a URI change re-wires the SAME element to the new source. That keeps this
  // case a real negative control — it is what distinguishes "the effect re-runs
  // when the URI changes" from "the effect never runs at all", which is the way
  // Property 16 could otherwise pass vacuously.
  it('re-wires the same element to the new source when resolvedUri changes', () => {
    const uri1 = 'https://example.com/video1.mp4';
    const uri2 = 'https://example.com/video2.mp4';

    let opts: UseWebVideoPlayerOptions = {
      resolvedUri: uri1,
      isMuted: false,
      playbackSpeed: 1,
    };

    let result = engine.run(() => useWebVideoPlayer(opts), commitVideoRef);
    const firstEl = result.videoRef.current;
    expect(firstEl).not.toBeNull();
    expect(firstEl?.src).toBe(uri1);

    const loadCallsAfterMount = (firstEl?.load as unknown as jest.Mock).mock.calls.length;

    // Change the URI — the source is swapped on the element React already owns.
    opts = { ...opts, resolvedUri: uri2 };
    result = engine.rerender(() => useWebVideoPlayer(opts), commitVideoRef);

    // Same DOM node: React never replaces it, and the hook must not either.
    expect(result.videoRef.current).toBe(firstEl);
    // ...but it now points at the new source.
    expect(result.videoRef.current?.src).toBe(uri2);
    // Re-wired, not merely re-pointed: the old wiring is torn down (cleanup
    // detaches the listeners, drops the src and reloads) and the new source is
    // loaded, so load() is called again after mount.
    expect((firstEl?.load as unknown as jest.Mock).mock.calls.length).toBeGreaterThan(
      loadCallsAfterMount,
    );
    expect(firstEl?.removeAttribute as unknown as jest.Mock).toHaveBeenCalledWith('src');
  });
});
