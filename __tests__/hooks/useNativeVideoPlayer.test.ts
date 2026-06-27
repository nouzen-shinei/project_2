// Feature: video-transcoding-compatibility

/**
 * Unit tests for `useNativeVideoPlayer`
 *
 * Validates: Requirements 4.1
 *
 * Coverage:
 *   - All required NativePlayerState fields are returned with correct types
 *   - play, pause, seek, setMuted, setPlaybackSpeed functions are returned
 *   - player.remove() is called on unmount (cleanup)
 *
 * Approach: The hook logic is tested by mocking expo-video / expo and running
 * React hooks in isolation via jest.isolateModules + react-dom's act().
 * A minimal React component wrapper captures the hook's return value.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import type {
  UseNativeVideoPlayerOptions,
  NativePlayerState,
} from '../../hooks/useNativeVideoPlayer';
import type { VideoPlayerStatus } from 'expo-video';

// ---------------------------------------------------------------------------
// Shared mock player — recreated fresh for each test
// ---------------------------------------------------------------------------

type MockPlayer = {
  playing: boolean;
  currentTime: number;
  bufferedPosition: number;
  duration: number;
  status: VideoPlayerStatus;
  muted: boolean;
  loop: boolean;
  timeUpdateEventInterval: number;
  preservesPitch: boolean;
  playbackRate: number;
  play: jest.Mock;
  pause: jest.Mock;
  remove: jest.Mock;
};

let mockPlayer: MockPlayer;

function createMockPlayer(): MockPlayer {
  return {
    playing: false,
    currentTime: 0,
    bufferedPosition: 0,
    duration: 120,
    status: 'idle' as VideoPlayerStatus,
    muted: false,
    loop: false,
    timeUpdateEventInterval: 0,
    preservesPitch: false,
    playbackRate: 1,
    play: jest.fn(),
    pause: jest.fn(),
    remove: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock expo-video
// ---------------------------------------------------------------------------

jest.mock('expo-video', () => ({
  useVideoPlayer: jest.fn((
    _source: unknown,
    setup?: (p: MockPlayer) => void,
  ) => {
    if (setup) {
      setup(mockPlayer);
    }
    return mockPlayer;
  }),
  useEvent: jest.fn((
    _player: unknown,
    eventName: string,
    initialState: Record<string, unknown>,
  ) => ({ ...initialState })),
}));

// ---------------------------------------------------------------------------
// Mock expo (re-exports useEvent too)
// ---------------------------------------------------------------------------

jest.mock('expo', () => ({
  useEvent: jest.fn((
    _player: unknown,
    _eventName: string,
    initialState: Record<string, unknown>,
  ) => ({ ...initialState })),
}));

// ---------------------------------------------------------------------------
// Import helpers after mocks are declared
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { useNativeVideoPlayer } from '../../hooks/useNativeVideoPlayer';

// ---------------------------------------------------------------------------
// A tiny synchronous harness that drives the hook without a full DOM renderer.
//
// Strategy: call the hook function directly. Because jest.mock above replaces
// useVideoPlayer / useEvent with plain functions that return values
// immediately, and because we replace React's useEffect / useCallback with
// synchronous versions below, the hook behaves like a plain function during
// tests.
//
// We override React.useEffect to run callbacks synchronously and capture
// their cleanup functions. React.useCallback is overridden to return the
// callback directly (no dep array tracking needed in tests).
// ---------------------------------------------------------------------------

// We only patch React's hook internals inside a controlled scope, without
// affecting the global React module, by using jest.spyOn.

let capturedCleanups: Array<() => void> = [];

function runHook(
  options: UseNativeVideoPlayerOptions,
): ReturnType<typeof useNativeVideoPlayer> {
  capturedCleanups = [];

  // Spy on React hooks so we can run effects synchronously.
  const useEffectSpy = jest.spyOn(
    require('react') as typeof import('react'),
    'useEffect',
  );
  const useCallbackSpy = jest.spyOn(
    require('react') as typeof import('react'),
    'useCallback',
  );

  // useEffect: run the callback immediately, capture any returned cleanup.
  useEffectSpy.mockImplementation((fn: () => (() => void) | void) => {
    const cleanup = fn();
    if (typeof cleanup === 'function') {
      capturedCleanups.push(cleanup);
    }
  });

  // useCallback: return the callback as-is (tests don't need memoisation).
  useCallbackSpy.mockImplementation(<T>(fn: T) => fn);

  let result: ReturnType<typeof useNativeVideoPlayer>;
  try {
    result = useNativeVideoPlayer(options);
  } finally {
    useEffectSpy.mockRestore();
    useCallbackSpy.mockRestore();
  }

  return result;
}

function buildDefaultOptions(
  overrides: Partial<UseNativeVideoPlayerOptions> = {},
): UseNativeVideoPlayerOptions {
  return {
    uri: 'https://example.com/video.mp4',
    autoPlay: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockPlayer = createMockPlayer();
  jest.clearAllMocks();

  // Restore the real useVideoPlayer mock default behaviour after each test.
  const expoVideo = require('expo-video') as {
    useVideoPlayer: jest.Mock;
    useEvent: jest.Mock;
  };
  expoVideo.useVideoPlayer.mockImplementation(
    (_source: unknown, setup?: (p: MockPlayer) => void) => {
      if (setup) setup(mockPlayer);
      return mockPlayer;
    },
  );
  // expo-video's useEvent (not used by the hook directly, but kept for consistency).
  expoVideo.useEvent.mockImplementation(
    (_player: unknown, _event: string, initialState: Record<string, unknown>) => ({
      ...initialState,
    }),
  );

  // Restore expo's useEvent mock (the hook imports useEvent from 'expo').
  const expoMod = require('expo') as { useEvent: jest.Mock };
  expoMod.useEvent.mockImplementation(
    (_player: unknown, _event: string, initialState: Record<string, unknown>) => ({
      ...initialState,
    }),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useNativeVideoPlayer', () => {

  // ── NativePlayerState fields ─────────────────────────────────────────────

  describe('NativePlayerState — required fields and types', () => {
    it('returns isPlaying as a boolean', () => {
      const { state } = runHook(buildDefaultOptions());
      expect(typeof state.isPlaying).toBe('boolean');
    });

    it('returns status as a string', () => {
      const { state } = runHook(buildDefaultOptions());
      expect(typeof state.status).toBe('string');
    });

    it('returns currentTime as a number', () => {
      const { state } = runHook(buildDefaultOptions());
      expect(typeof state.currentTime).toBe('number');
    });

    it('returns duration as a number', () => {
      const { state } = runHook(buildDefaultOptions());
      expect(typeof state.duration).toBe('number');
    });

    it('returns bufferedPosition as a number', () => {
      const { state } = runHook(buildDefaultOptions());
      expect(typeof state.bufferedPosition).toBe('number');
    });

    it('returns error as null when no error is present', () => {
      const { state } = runHook(buildDefaultOptions());
      // error must be string | null; null when there is no error.
      expect(state.error === null || typeof state.error === 'string').toBe(true);
      expect(state.error).toBeNull();
    });

    it('returns all six required NativePlayerState fields', () => {
      const { state } = runHook(buildDefaultOptions());
      const required: Array<keyof NativePlayerState> = [
        'isPlaying',
        'status',
        'currentTime',
        'duration',
        'bufferedPosition',
        'error',
      ];
      for (const field of required) {
        expect(state).toHaveProperty(field);
      }
    });

    it('reflects player.playing in isPlaying', () => {
      // useEvent is imported from 'expo' in the hook.
      const expoMod = require('expo') as { useEvent: jest.Mock };
      expoMod.useEvent.mockImplementation(
        (_player: unknown, eventName: string, initialState: Record<string, unknown>) => {
          if (eventName === 'playingChange') {
            return { isPlaying: true };
          }
          return { ...initialState };
        },
      );
      mockPlayer.playing = true;
      const { state } = runHook(buildDefaultOptions());
      expect(state.isPlaying).toBe(true);
    });

    it('reflects player.duration in state.duration', () => {
      mockPlayer.duration = 300;
      const { state } = runHook(buildDefaultOptions());
      expect(state.duration).toBe(300);
    });

    it('returns error as a string when statusEvent carries an error', () => {
      // useEvent is imported from 'expo' (not 'expo-video') in the hook.
      const expoMod = require('expo') as { useEvent: jest.Mock };
      expoMod.useEvent.mockImplementation(
        (_player: unknown, eventName: string, initialState: Record<string, unknown>) => {
          if (eventName === 'statusChange') {
            return {
              status: 'error' as VideoPlayerStatus,
              oldStatus: undefined,
              error: { message: 'playback failed' },
            };
          }
          return { ...initialState };
        },
      );
      const { state } = runHook(buildDefaultOptions());
      expect(typeof state.error).toBe('string');
      expect(state.error).toBe('playback failed');
    });
  });

  // ── Action callbacks ─────────────────────────────────────────────────────

  describe('returned action callbacks', () => {
    it('returns a play function', () => {
      const result = runHook(buildDefaultOptions());
      expect(typeof result.play).toBe('function');
    });

    it('returns a pause function', () => {
      const result = runHook(buildDefaultOptions());
      expect(typeof result.pause).toBe('function');
    });

    it('returns a seek function', () => {
      const result = runHook(buildDefaultOptions());
      expect(typeof result.seek).toBe('function');
    });

    it('returns a setMuted function', () => {
      const result = runHook(buildDefaultOptions());
      expect(typeof result.setMuted).toBe('function');
    });

    it('returns a setPlaybackSpeed function', () => {
      const result = runHook(buildDefaultOptions());
      expect(typeof result.setPlaybackSpeed).toBe('function');
    });

    it('play() delegates to player.play()', () => {
      const { play } = runHook(buildDefaultOptions());
      play();
      expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    });

    it('pause() delegates to player.pause()', () => {
      const { pause } = runHook(buildDefaultOptions());
      pause();
      expect(mockPlayer.pause).toHaveBeenCalledTimes(1);
    });

    it('seek() sets player.currentTime', () => {
      const { seek } = runHook(buildDefaultOptions());
      seek(42);
      expect(mockPlayer.currentTime).toBe(42);
    });

    it('seek() ignores non-finite values', () => {
      const { seek } = runHook(buildDefaultOptions());
      const before = mockPlayer.currentTime;
      seek(NaN);
      seek(Infinity);
      expect(mockPlayer.currentTime).toBe(before);
    });

    it('setMuted() updates player.muted', () => {
      const { setMuted } = runHook(buildDefaultOptions());
      setMuted(true);
      expect(mockPlayer.muted).toBe(true);
    });

    it('setPlaybackSpeed() sets player.playbackRate', () => {
      const { setPlaybackSpeed } = runHook(buildDefaultOptions());
      setPlaybackSpeed(1.5);
      expect(mockPlayer.playbackRate).toBe(1.5);
    });

    it('setPlaybackSpeed() ignores non-finite values', () => {
      const { setPlaybackSpeed } = runHook(buildDefaultOptions());
      const before = mockPlayer.playbackRate;
      setPlaybackSpeed(NaN);
      expect(mockPlayer.playbackRate).toBe(before);
    });
  });

  // ── Cleanup (unmount) ────────────────────────────────────────────────────

  describe('cleanup on unmount', () => {
    it('calls player.remove() when the cleanup effect runs', () => {
      runHook(buildDefaultOptions());

      // At least one cleanup was registered by the hook's useEffect(() => () => player.remove(), []).
      expect(capturedCleanups.length).toBeGreaterThan(0);

      // Simulate unmount by running all captured cleanups.
      for (const cleanup of capturedCleanups) {
        cleanup();
      }

      expect(mockPlayer.remove).toHaveBeenCalledTimes(1);
    });

    it('does not throw even if player.remove() throws during cleanup', () => {
      mockPlayer.remove.mockImplementation(() => {
        throw new Error('remove failed');
      });

      runHook(buildDefaultOptions());

      expect(() => {
        for (const cleanup of capturedCleanups) {
          cleanup();
        }
      }).not.toThrow();
    });
  });
});
