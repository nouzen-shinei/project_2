// Feature: notify-expo-batching, Property 1: sendExpoMessages per-target results are index-aligned and consistent with aggregates

/**
 * Property 1 (notify-expo-batching): per-target `results` from `sendExpoMessages`
 * are INDEX-ALIGNED to the input `messages` and consistent with the aggregate
 * counts.
 *
 * **Validates: Requirements 12.2, 12.7**
 *
 * `sendExpoMessages` batches all Expo messages into as few HTTP requests as
 * possible (chunks of ≤100). It now returns, alongside the backward-compatible
 * `{ sent, failed, invalidTokens }` aggregate, a per-message `results` array such
 * that `results[i]` describes `messages[i]`. The universal invariants exercised
 * here across every code path (success receipts, mixed ok/error, chunk split
 * >100, retry-split after an HTTP failure, no-receipts success, and network
 * error) are:
 *   - `results.length === messages.length` and `results[i].to === messages[i].to`
 *     (positional mapping — two targets may share a token, so callers must map by
 *     index, never by token);
 *   - `sent === results.filter(r => r.ok).length`;
 *   - `failed === results.filter(r => !r.ok).length`.
 *
 * `node-fetch` is mocked so no real network request is made; the fake server
 * derives each message's receipt from whether its `to` token contains `FAIL`,
 * making per-message outcomes deterministic and index-checkable.
 */

import * as fc from 'fast-check';

import fetch from 'node-fetch';
import { sendExpoMessages } from '../pushUtils';

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
// `pushUtils` imports `getFirestore` at module load; stub it so no Admin SDK
// initialization happens (it is only used by `markPushTokensInvalid`, not here).
jest.mock('../firebaseAdmin', () => ({ __esModule: true, getFirestore: jest.fn() }));

const mockedFetch = fetch as unknown as jest.Mock;

const ENDPOINT = 'http://127.0.0.1/push';

/** A minimal `node-fetch` Response stand-in carrying a JSON string body. */
function makeResponse(body: unknown, init?: { ok?: boolean; status?: number; statusText?: string }) {
  const ok = init?.ok ?? true;
  return {
    ok,
    status: init?.status ?? (ok ? 200 : 500),
    statusText: init?.statusText ?? (ok ? 'OK' : 'Error'),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Parse the POSTed chunk (array of ExpoPushMessage) out of a fetch call. */
function chunkFromCall(call: any[]): Array<{ to: string }> {
  return JSON.parse(call[1].body);
}

/** An Expo receipt for one message: `ok` unless the token carries `FAIL`. */
function receiptFor(to: string) {
  return to.includes('FAIL')
    ? { status: 'error', message: 'delivery failed', details: { error: 'MessageRateExceeded' } }
    : { status: 'ok', id: `receipt-${to}` };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendExpoMessages — per-target results (unit)', () => {
  it('returns an empty results array for empty input and makes no HTTP call', async () => {
    const result = await sendExpoMessages([], { expoEndpoint: ENDPOINT });
    expect(result).toEqual({ sent: 0, failed: 0, invalidTokens: [], results: [] });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('maps each success receipt to its message index (index alignment)', async () => {
    mockedFetch.mockImplementation(async (_url: string, opts: any) => {
      const chunk = JSON.parse(opts.body) as Array<{ to: string }>;
      return makeResponse({ data: chunk.map((m) => receiptFor(m.to)) });
    });

    const messages = [
      { to: 'ExpoToken-A' },
      { to: 'ExpoToken-FAIL-B' },
      { to: 'ExpoToken-C' },
    ];
    const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT });

    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toEqual({ to: 'ExpoToken-A', ok: true });
    expect(result.results[1].to).toBe('ExpoToken-FAIL-B');
    expect(result.results[1].ok).toBe(false);
    expect(result.results[2]).toEqual({ to: 'ExpoToken-C', ok: true });
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('splits >100 messages into ceil(N/100) HTTP POSTs and keeps positional results', async () => {
    mockedFetch.mockImplementation(async (_url: string, opts: any) => {
      const chunk = JSON.parse(opts.body) as Array<{ to: string }>;
      return makeResponse({ data: chunk.map((m) => receiptFor(m.to)) });
    });

    const N = 250;
    const messages = Array.from({ length: N }, (_v, i) => ({ to: `ExpoToken-${i}` }));
    const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT });

    // Batching: 250 messages => 3 HTTP requests (100 + 100 + 50), not 250.
    expect(mockedFetch).toHaveBeenCalledTimes(Math.ceil(N / 100));
    const postedSizes = mockedFetch.mock.calls.map((c) => chunkFromCall(c).length);
    expect(postedSizes).toEqual([100, 100, 50]);

    expect(result.results).toHaveLength(N);
    result.results.forEach((r, i) => {
      expect(r.to).toBe(`ExpoToken-${i}`);
      expect(r.ok).toBe(true);
    });
    expect(result.sent).toBe(N);
    expect(result.failed).toBe(0);
  });

  it('maps mixed ok/error receipts across a multi-chunk send by global index', async () => {
    mockedFetch.mockImplementation(async (_url: string, opts: any) => {
      const chunk = JSON.parse(opts.body) as Array<{ to: string }>;
      return makeResponse({ data: chunk.map((m) => receiptFor(m.to)) });
    });

    const N = 150;
    const messages = Array.from({ length: N }, (_v, i) => ({
      to: i % 3 === 0 ? `ExpoToken-FAIL-${i}` : `ExpoToken-${i}`,
    }));
    const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT });

    expect(result.results).toHaveLength(N);
    result.results.forEach((r, i) => {
      expect(r.to).toBe(messages[i].to);
      expect(r.ok).toBe(i % 3 !== 0);
    });
    const expectedFailed = messages.filter((m) => m.to.includes('FAIL')).length;
    expect(result.failed).toBe(expectedFailed);
    expect(result.sent).toBe(N - expectedFailed);
  });

  it('on an HTTP failure with a multi-message chunk, retries each message individually (retry-split)', async () => {
    // Multi-message POSTs fail; single-message retries succeed/fail per token.
    mockedFetch.mockImplementation(async (_url: string, opts: any) => {
      const chunk = JSON.parse(opts.body) as Array<{ to: string }>;
      if (chunk.length > 1) {
        return makeResponse({ errors: [{ code: 'SERVER_ERROR' }] }, { ok: false, status: 500 });
      }
      return makeResponse({ data: chunk.map((m) => receiptFor(m.to)) });
    });

    const messages = [
      { to: 'ExpoToken-A' },
      { to: 'ExpoToken-FAIL-B' },
      { to: 'ExpoToken-C' },
    ];
    const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT });

    // 1 failing multi-message POST + 3 single-message retries.
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toEqual({ to: 'ExpoToken-A', ok: true });
    expect(result.results[1].to).toBe('ExpoToken-FAIL-B');
    expect(result.results[1].ok).toBe(false);
    expect(result.results[2]).toEqual({ to: 'ExpoToken-C', ok: true });
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
  });

  it('on an HTTP failure with no split (attemptSplit=false), fails every message in the chunk', async () => {
    mockedFetch.mockResolvedValue(
      makeResponse({ errors: [{ code: 'SERVER_ERROR' }] }, { ok: false, status: 502 })
    );

    const messages = [{ to: 'ExpoToken-A' }, { to: 'ExpoToken-B' }];
    const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT, attemptSplit: false });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.ok === false)).toBe(true);
    expect(result.results[0].to).toBe('ExpoToken-A');
    expect(result.results[1].to).toBe('ExpoToken-B');
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
  });

  it('treats a successful response with NO receipts as all-ok (mirrors sent += chunk.length)', async () => {
    mockedFetch.mockResolvedValue(makeResponse({ data: [] }));

    const messages = [{ to: 'ExpoToken-A' }, { to: 'ExpoToken-B' }, { to: 'ExpoToken-C' }];
    const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT });

    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.ok === true)).toBe(true);
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
  });

  it('on a network error, fails every message in the chunk', async () => {
    mockedFetch.mockRejectedValue(new Error('ECONNRESET'));

    const messages = [{ to: 'ExpoToken-A' }, { to: 'ExpoToken-B' }];
    const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT });

    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.ok === false)).toBe(true);
    expect(result.results.every((r) => r.error === 'ECONNRESET')).toBe(true);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
  });
});

describe('Property 1 — sendExpoMessages results are index-aligned and consistent with aggregates', () => {
  it(
    'for any messages + deterministic server, results align to input and sent/failed match the ok/!ok partition (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              base: fc.string({ minLength: 1, maxLength: 8 }),
              fail: fc.boolean(),
              seq: fc.integer({ min: 0, max: 100000 }),
            }),
            { minLength: 1, maxLength: 260 }
          ),
          async (specs) => {
            // Build unique tokens; `FAIL` marks a message the fake server rejects.
            const messages = specs.map((s, i) => ({
              to: `ExpoToken-${s.fail ? 'FAIL-' : ''}${s.base}-${s.seq}-${i}`,
            }));

            mockedFetch.mockImplementation(async (_url: string, opts: any) => {
              const chunk = JSON.parse(opts.body) as Array<{ to: string }>;
              return makeResponse({ data: chunk.map((m) => receiptFor(m.to)) });
            });

            const result = await sendExpoMessages(messages, { expoEndpoint: ENDPOINT });

            // Index alignment + length.
            expect(result.results).toHaveLength(messages.length);
            for (let i = 0; i < messages.length; i += 1) {
              expect(result.results[i].to).toBe(messages[i].to);
              expect(result.results[i].ok).toBe(!messages[i].to.includes('FAIL'));
            }

            // Aggregate/per-target consistency invariant.
            const okCount = result.results.filter((r) => r.ok).length;
            const failCount = result.results.filter((r) => !r.ok).length;
            expect(result.sent).toBe(okCount);
            expect(result.failed).toBe(failCount);
            expect(okCount + failCount).toBe(messages.length);

            // Batching: at most ceil(N/100) HTTP requests were made.
            expect(mockedFetch.mock.calls.length).toBeLessThanOrEqual(
              Math.ceil(messages.length / 100)
            );

            mockedFetch.mockClear();
          }
        ),
        { numRuns: 150, verbose: false }
      );
    },
    30_000
  );
});
