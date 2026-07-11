// Feature: chat-production-hardening — Task 6
// Harden the client realtime reconnect loop (finding P3-2).
//
// These tests prove the reconnect loop is now robust:
//   (a) the scheduled reconnect timer is CLEARED on close() and start() is never
//       invoked again after close (no dangling timer relying on flag checks);
//   (b) the backoff grows exponentially, is capped at the max, and applies full
//       jitter (the delay never exceeds the cap and stays within [0, ceiling]);
//   (c) a successful connection resets the backoff to its base.
//
// The pure `resolveStreamRetryDelay` helper carries the deterministic backoff /
// jitter math and is unit-tested directly. The timer-lifecycle + reset behavior
// is exercised through the real ChatRealtimeStream with fake timers and a minimal
// EventSource-like transport, plus a stubbed token manager.

// ---------------------------------------------------------------------------
// Peripheral mocks. The module imports these at load time; keep them light so
// the real reconnect logic runs unmodified in the node jest env.
// ---------------------------------------------------------------------------
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    metric: jest.fn(),
  },
}));

jest.mock('@/services/internalTokenManager', () => ({
  __esModule: true,
  internalTokenManager: {
    getToken: jest.fn(async () => 'token-abc'),
    invalidate: jest.fn(),
    forceRefresh: jest.fn(async () => 'token-abc'),
    setBaseUrl: jest.fn(),
  },
}));

import { ChatRealtimeStream, resolveStreamRetryDelay } from '../../services/chatRealtimeStream';
import { internalTokenManager } from '@/services/internalTokenManager';

const getTokenMock = internalTokenManager.getToken as jest.Mock;

const BASE = 500;
const MAX = 6000;

// The deterministic exponential ceiling for a given attempt (mirrors the helper).
function expectedCeiling(attempt: number): number {
  return Math.min(MAX, Math.round(BASE * Math.pow(1.6, attempt)));
}

// ---------------------------------------------------------------------------
// (b) Pure backoff/jitter helper.
// ---------------------------------------------------------------------------
describe('resolveStreamRetryDelay — exponential backoff with full jitter', () => {
  it('grows exponentially and saturates at the max cap when the jitter sample is at the ceiling', () => {
    const atCeiling = () => 1;
    expect(resolveStreamRetryDelay(1, BASE, MAX, atCeiling)).toBe(800);
    expect(resolveStreamRetryDelay(2, BASE, MAX, atCeiling)).toBe(1280);
    expect(resolveStreamRetryDelay(3, BASE, MAX, atCeiling)).toBe(2048);
    expect(resolveStreamRetryDelay(4, BASE, MAX, atCeiling)).toBe(3277);
    expect(resolveStreamRetryDelay(5, BASE, MAX, atCeiling)).toBe(5243);
    // From attempt 6 onward the exponential ceiling exceeds the cap -> pinned at MAX.
    expect(resolveStreamRetryDelay(6, BASE, MAX, atCeiling)).toBe(MAX);
    expect(resolveStreamRetryDelay(20, BASE, MAX, atCeiling)).toBe(MAX);
    expect(resolveStreamRetryDelay(9999, BASE, MAX, atCeiling)).toBe(MAX);
  });

  it('applies full jitter: 0 is the lower bound of the delay range', () => {
    expect(resolveStreamRetryDelay(1, BASE, MAX, () => 0)).toBe(0);
    expect(resolveStreamRetryDelay(5, BASE, MAX, () => 0)).toBe(0);
    expect(resolveStreamRetryDelay(50, BASE, MAX, () => 0)).toBe(0);
  });

  it('never exceeds the cap and always stays within [0, ceiling] for arbitrary jitter samples', () => {
    for (let attempt = 1; attempt <= 30; attempt++) {
      for (const sample of [0, 0.1, 0.37, 0.5, 0.83, 0.999]) {
        const delay = resolveStreamRetryDelay(attempt, BASE, MAX, () => sample);
        const ceiling = expectedCeiling(attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(MAX);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBe(Math.round(sample * ceiling));
      }
    }
  });

  it('de-synchronizes reconnects: distinct jitter samples yield distinct delays', () => {
    const samples = [0.05, 0.25, 0.5, 0.75, 0.95];
    const delays = new Set(samples.map((s) => resolveStreamRetryDelay(4, BASE, MAX, () => s)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('is defensive against invalid inputs (falls back to sane base/cap/attempt)', () => {
    // attempt <= 0 is treated as the first attempt.
    expect(resolveStreamRetryDelay(0, BASE, MAX, () => 1)).toBe(800);
    expect(resolveStreamRetryDelay(-5, BASE, MAX, () => 1)).toBe(800);
    // a jitter sample above 1 is clamped so the delay never exceeds the ceiling.
    expect(resolveStreamRetryDelay(2, BASE, MAX, () => 5)).toBe(1280);
  });
});

// ---------------------------------------------------------------------------
// Minimal EventSource-like transport used to drive the real reconnect loop.
// ---------------------------------------------------------------------------
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closeCount = 0;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closeCount += 1;
  }
}

// ---------------------------------------------------------------------------
// (a) + (c) Timer lifecycle and reset behavior through the real class.
// ---------------------------------------------------------------------------
describe('ChatRealtimeStream — reconnect timer lifecycle', () => {
  const baseArgs = {
    baseUrl: 'https://api.example.test',
    tenantId: 'tenant-1',
    userEmail: 'user@example.test',
    partnerEmail: 'partner@example.test',
  };

  let setTimeoutSpy: jest.SpyInstance;
  let randomSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    FakeEventSource.instances = [];
    (global as any).EventSource = FakeEventSource as unknown as typeof EventSource;
    getTokenMock.mockResolvedValue('token-abc');
    // Pin full jitter at the ceiling so scheduled delays are deterministic.
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(1);
    setTimeoutSpy = jest.spyOn(global, 'setTimeout');
  });

  afterEach(() => {
    randomSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    jest.useRealTimers();
    delete (global as any).EventSource;
  });

  const currentSource = () => FakeEventSource.instances[FakeEventSource.instances.length - 1];
  const lastScheduledDelay = () => {
    const calls = setTimeoutSpy.mock.calls;
    return calls[calls.length - 1][1];
  };

  it('(a) clears the pending reconnect timer on close and never invokes start() again', async () => {
    // Missing token -> start() bails out and schedules a reconnect timer.
    getTokenMock.mockResolvedValue(undefined);

    const stream = new ChatRealtimeStream();
    const close = await stream.subscribe(baseArgs);

    expect(getTokenMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);

    // close() must cancel the pending reconnect timer.
    close?.();
    expect(jest.getTimerCount()).toBe(0);

    // Advancing well past any backoff must NOT trigger another reconnect.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(getTokenMock).toHaveBeenCalledTimes(1);

    // Idempotent close: calling again is safe and leaves no timers behind.
    expect(() => close?.()).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('(a) a retry scheduled after a transport error is cancelled by close()', async () => {
    const stream = new ChatRealtimeStream();
    const close = await stream.subscribe(baseArgs);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);

    // Transport error schedules exactly one reconnect timer.
    currentSource().onerror?.({});
    expect(jest.getTimerCount()).toBe(1);
    expect(lastScheduledDelay()).toBe(expectedCeiling(1));

    // close() cancels it; the reconnect never runs and no new source is created.
    close?.();
    expect(jest.getTimerCount()).toBe(0);

    await jest.advanceTimersByTimeAsync(120_000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('(b)+(c) grows the backoff on repeated failures, caps at max, and resets to base after a successful open', async () => {
    const stream = new ChatRealtimeStream();
    const close = await stream.subscribe(baseArgs);
    expect(FakeEventSource.instances).toHaveLength(1);

    // Failure #1 -> attempt 1 -> ceiling 800.
    currentSource().onerror?.({});
    expect(lastScheduledDelay()).toBe(800);

    await jest.advanceTimersByTimeAsync(800);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Failure #2 -> attempt 2 -> ceiling 1280 (exponential growth).
    currentSource().onerror?.({});
    expect(lastScheduledDelay()).toBe(1280);

    await jest.advanceTimersByTimeAsync(1280);
    expect(FakeEventSource.instances).toHaveLength(3);

    // Failure #3 -> attempt 3 -> ceiling 2048.
    currentSource().onerror?.({});
    expect(lastScheduledDelay()).toBe(2048);

    await jest.advanceTimersByTimeAsync(2048);
    expect(FakeEventSource.instances).toHaveLength(4);

    // A healthy open resets the backoff to base.
    currentSource().onopen?.();

    // Next failure starts again from attempt 1 -> 800 (reset confirmed).
    currentSource().onerror?.({});
    expect(lastScheduledDelay()).toBe(800);

    close?.();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('(b) the delay stays capped at the max after many consecutive failures', async () => {
    const stream = new ChatRealtimeStream();
    const close = await stream.subscribe(baseArgs);

    // Drive enough consecutive failures for the exponential ceiling to saturate.
    for (let i = 1; i <= 8; i++) {
      currentSource().onerror?.({});
      const delay = lastScheduledDelay();
      expect(delay).toBeLessThanOrEqual(MAX);
      expect(delay).toBe(expectedCeiling(i));
      await jest.advanceTimersByTimeAsync(delay);
    }

    // Once saturated, the delay never exceeds the max cap.
    expect(lastScheduledDelay()).toBe(MAX);

    close?.();
    expect(jest.getTimerCount()).toBe(0);
  });
});
