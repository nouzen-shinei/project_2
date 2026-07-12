/**
 * Unit tests for the internal `mapWithConcurrency` fan-out helper.
 *
 * `mapWithConcurrency` bounds the number of concurrent per-target device
 * actions in `notify` / `bulkForceLogout` (see `DEVICE_ACTION_CONCURRENCY`).
 * Because it is a performance-only concern, its contract is behavior-preserving
 * and must hold exactly:
 *   - the returned array preserves INPUT ORDER (`results[i]` for `items[i]`),
 *     regardless of the order tasks happen to finish;
 *   - at most `limit` invocations of `fn` run at once (verified with a live
 *     in-flight counter and a recorded high-water mark);
 *   - empty input resolves to `[]` without ever invoking `fn`;
 *   - every result corresponds to its input (both value and index passed to
 *     `fn`).
 *
 * The real, exported helper is imported and exercised directly (no mocking).
 * `deviceAdminService.ts` is not modified by these tests.
 */

import { mapWithConcurrency } from '../deviceAdminService';

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('preserves input order even when later items finish first', async () => {
    const items = [0, 1, 2, 3, 4, 5];
    // Invert the delay by index so the LAST item resolves first and the first
    // item resolves last — proving ordering is positional, not completion-based.
    const results = await mapWithConcurrency(items, 3, async (value, index) => {
      await delay((items.length - index) * 5);
      return value * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('never exceeds the concurrency limit (in-flight high-water mark)', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const limit = 4;

    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency(items, limit, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield across a macrotask so overlap can actually occur if unbounded.
      await delay(2);
      inFlight -= 1;
      return value;
    });

    expect(results).toEqual(items);
    expect(maxInFlight).toBeLessThanOrEqual(limit);
    // With more items than the limit, the cap should actually be reached.
    expect(maxInFlight).toBe(limit);
  });

  it('caps concurrency at the item count when limit exceeds it', async () => {
    const items = [1, 2, 3];
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(items, 100, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(2);
      inFlight -= 1;
      return value;
    });

    // Only three items exist, so at most three tasks can ever be in flight.
    expect(maxInFlight).toBe(items.length);
  });

  it('runs a single task at a time when limit <= 0 (clamped to 1)', async () => {
    const items = [1, 2, 3, 4];
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency(items, 0, async (value) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(1);
      inFlight -= 1;
      return value;
    });

    expect(results).toEqual(items);
    expect(maxInFlight).toBe(1);
  });

  it('resolves to [] for empty input without invoking fn', async () => {
    const fn = jest.fn(async (value: number) => value);
    const results = await mapWithConcurrency([], 5, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('passes the correct value and index to fn for every element', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const seen: Array<{ value: string; index: number }> = [];

    const results = await mapWithConcurrency(items, 2, async (value, index) => {
      seen.push({ value, index });
      return `${value}:${index}`;
    });

    expect(results).toEqual(['a:0', 'b:1', 'c:2', 'd:3']);
    // Every (value, index) pair was observed exactly once, matching the input.
    const sorted = [...seen].sort((x, y) => x.index - y.index);
    expect(sorted).toEqual([
      { value: 'a', index: 0 },
      { value: 'b', index: 1 },
      { value: 'c', index: 2 },
      { value: 'd', index: 3 },
    ]);
  });

  it('matches Promise.all(items.map(fn)) ordering for the same inputs', async () => {
    const items = Array.from({ length: 30 }, (_, i) => i * 3 + 1);
    const mapper = async (value: number) => {
      await delay(value % 5);
      return value * value;
    };

    const bounded = await mapWithConcurrency(items, 7, mapper);
    const unbounded = await Promise.all(items.map((v) => mapper(v)));

    expect(bounded).toEqual(unbounded);
  });
});
