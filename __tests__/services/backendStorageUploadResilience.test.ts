// Feature: upload-idempotency, Property 9: Client retries never re-mint the upload key
//
// Resilience pass for the shared upload helper `uploadBlobViaBackend` (used by
// every non-chat upload: receipt, notice image/audio, profile pic, student photo,
// tenant logo). A transient network drop or gateway blip (502/503/504) is retried
// with bounded backoff, while deterministic failures (quota 409, too-large 413,
// auth/validation) fail fast, and the one-shot 401 token refresh is preserved.
//
// Only the transport (`fetch`), token manager, alerts, endpoints, and Platform are
// mocked. A zero-size blob skips the preflight (bytes <= 0 -> no-op), so the only
// fetch calls are the upload POSTs — making the retry behavior directly assertable.
// Fake timers fast-forward the backoff delays.

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } }));
jest.mock('../../services/runtimeEndpoints', () => ({
  runtimeEndpoints: { getPreferredBackendBaseUrl: () => 'https://api.test' },
}));

const forceRefresh = jest.fn(async () => {});
jest.mock('../../services/internalTokenManager', () => ({
  internalTokenManager: {
    setBaseUrl: jest.fn(),
    getToken: jest.fn(async () => 'test-token'),
    forceRefresh,
  },
}));

const maybeShowStorageLimitReachedAlert = jest.fn((..._args: any[]) => false);
jest.mock('../../services/storageLimitAlert', () => ({
  maybeShowStorageLimitReachedAlert: (...args: any[]) => maybeShowStorageLimitReachedAlert(...args),
}));
const maybeShowMaintenanceAlertFromRaw = jest.fn((..._args: any[]) => {});
jest.mock('../../services/maintenanceAlert', () => ({
  maybeShowMaintenanceAlertFromRaw: (...args: any[]) => maybeShowMaintenanceAlertFromRaw(...args),
}));

import * as fc from 'fast-check';

import { newUploadKey } from '../../lib/uploadKey';
import { UPLOAD_MAX_ATTEMPTS } from '../../lib/uploadRetry';
import {
  uploadBlobViaBackend,
  type StorageUploadPurpose,
} from '../../services/backendStorageUploadService';

const zeroSizeBlob = { size: 0, type: 'image/jpeg' } as unknown as Blob;

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});
const errResponse = (status: number, body = '') => ({
  ok: false,
  status,
  text: async () => body,
});

const uploadArgs = () => ({
  tenantId: 't1',
  purpose: 'receipt' as const,
  blob: zeroSizeBlob,
  contentType: 'image/jpeg',
  filename: 'receipt.jpg',
});

describe('uploadBlobViaBackend resilience (native path)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries a transient network error and then succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(okResponse({ url: 'https://cdn/r.jpg', path: 'p', bytes: 10 }));
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend(uploadArgs());
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.url).toBe('https://cdn/r.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a transient 503 and then succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(errResponse(503, 'unavailable'))
      .mockResolvedValueOnce(okResponse({ url: 'https://cdn/ok.jpg', path: 'p', bytes: 5 }));
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend(uploadArgs());
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.url).toBe('https://cdn/ok.jpg');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a deterministic 409 storage-limit (fails fast, single call)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(errResponse(409, '{"error":"storage_limit_reached"}'));
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend(uploadArgs());
    const assertion = expect(p).rejects.toThrow('storage_limit_reached');
    await jest.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(maybeShowStorageLimitReachedAlert).toHaveBeenCalledTimes(1);
  });

  it('gives up after the max attempts on a persistent network error', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('Network request failed'));
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend(uploadArgs());
    const assertion = expect(p).rejects.toThrow('Network request failed');
    await jest.runAllTimersAsync();
    await assertion;

    // 1 initial try + 2 retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('still refreshes the token on 401 within a single attempt (no retry consumed)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(errResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(okResponse({ url: 'https://cdn/auth.jpg', path: 'p', bytes: 3 }));
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend(uploadArgs());
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.url).toBe('https://cdn/auth.jpg');
    expect(forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
// ---------------------------------------------------------------------------
// upload-idempotency (task 9.1): the upload key is minted by the CALLER, once per
// logical user action, and `uploadBlobViaBackend` must reuse that one value on
// every attempt of that action — web XHR path and native fetch path alike.
//
// Why this matters: the whole point of `uploadKey` is that the backend derives a
// DETERMINISTIC object path from it, so a retry after a lost response overwrites
// the first attempt's object instead of orphaning a second one. A key that were
// re-minted (or re-derived) mid-loop would produce a fresh path per attempt and
// silently restore the exact orphan-per-retry behavior the feature removes — so
// this suite asserts URL/key invariance across the retry loop directly from the
// transport's own `fetch` calls, not from a re-implementation of the loop.
// ---------------------------------------------------------------------------

/** A non-zero size makes `ensureUploadPreflight` actually issue its GET. */
const nonZeroBlob = { size: 4096, type: 'image/jpeg' } as unknown as Blob;

const SUCCESS_BODY = { url: 'https://cdn/idem.jpg', path: 'receipts/t1/k_abc_receipt.jpg', bytes: 7 };

/**
 * Per-test budget for the fast-check properties below. Jest's 5s default is
 * enough for them in isolation but not when the whole repo suite saturates the
 * CPU across workers, and cutting `numRuns` to fit would weaken the property.
 */
const PROPERTY_TEST_TIMEOUT_MS = 60_000;

/** `/storage/upload/preflight` vs the `/storage/upload` POST, by pathname. */
const isPreflightCall = (url: string): boolean =>
  new URL(url).pathname === '/storage/upload/preflight';

const uploadUrlsOf = (fetchMock: jest.Mock): string[] =>
  fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => !isPreflightCall(url));

const preflightUrlsOf = (fetchMock: jest.Mock): string[] =>
  fetchMock.mock.calls.map((call) => String(call[0])).filter((url) => isPreflightCall(url));

const uploadKeyParamOf = (url: string): string | null =>
  new URL(url).searchParams.get('uploadKey');

/** One scripted upload attempt outcome: a network rejection, a status, or success. */
type UploadStep = 'network' | 'success' | number;

const respondTo = (step: UploadStep): Promise<unknown> => {
  if (step === 'network') return Promise.reject(new Error('Network request failed'));
  if (step === 'success') return Promise.resolve(okResponse(SUCCESS_BODY));
  return Promise.resolve(errResponse(step, `gateway_${step}`));
};

/**
 * A `fetch` mock that answers the preflight GET with a 200 and walks `steps` for
 * the upload POSTs. Any attempt beyond the script answers a hard 500, so an
 * unexpected extra attempt surfaces as a failed assertion on the call count
 * rather than a hang.
 */
const scriptedFetch = (steps: UploadStep[]): jest.Mock => {
  let uploadIndex = 0;
  return jest.fn((input: unknown) => {
    const url = String(input);
    if (isPreflightCall(url)) return Promise.resolve(okResponse({ ok: true }));
    const step = uploadIndex < steps.length ? steps[uploadIndex] : 500;
    uploadIndex += 1;
    return respondTo(step);
  });
};

/**
 * Drive one invocation to completion under fake timers (skipping the backoff) and
 * report how it settled, so a run that ends in a thrown upload error is as
 * assertable as one that resolves.
 */
const settleUpload = async <T>(
  promise: Promise<T>,
): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }> => {
  const settled = promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason) => ({ status: 'rejected' as const, reason }),
  );
  await jest.runAllTimersAsync();
  return settled;
};

/**
 * Build the attempt script for a generated transient-failure sequence: the
 * transient failures (capped at the retry cap, since a transient on the LAST
 * attempt is not retried), then — only if attempts remain — a terminal success or
 * a deterministic 500.
 */
const buildAttemptScript = (transientFailures: UploadStep[], endsInSuccess: boolean): UploadStep[] => {
  const steps = transientFailures.slice(0, UPLOAD_MAX_ATTEMPTS);
  if (steps.length < UPLOAD_MAX_ATTEMPTS) {
    steps.push(endsInSuccess ? 'success' : 500);
  }
  return steps;
};

const transientStepArb: fc.Arbitrary<UploadStep> = fc.constantFrom<UploadStep>(
  'network',
  502,
  503,
  504,
);

const purposeArb: fc.Arbitrary<StorageUploadPurpose> = fc.constantFrom<StorageUploadPurpose>(
  'receipt',
  'noticeImage',
  'noticeAudio',
  'studentProfile',
  'tenantLogo',
  'chat',
);

/**
 * Keys in the endpoint's 8–200 window, drawn from a charset that includes a space
 * and reserved URL characters so query encoding and the helper's trim are both
 * exercised. `trim().length >= 8` keeps the generated value one the transport
 * actually sends (a blank-after-trim key is deliberately treated as absent).
 */
const uploadKeyArb: fc.Arbitrary<string> = fc
  .array(
    fc.constantFrom(
      ...'abcdefzABCDEFZ0189_-.:%+& '.split(''),
    ),
    { minLength: 8, maxLength: 64 },
  )
  .map((chars) => chars.join(''))
  .filter((key) => key.trim().length >= 8 && key.trim().length <= 200);

// Feature: upload-idempotency, Property 9: Client retries never re-mint the upload key
describe('uploadBlobViaBackend upload-key discipline (upload-idempotency)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // Feature: upload-idempotency, Property 9: Client retries never re-mint the upload key
  // **Validates: Requirements 7.2, 7.3, 7.6, 10.7**
  it('Property 9: every attempt of one invocation carries the identical uploadKey', async () => {
    await fc.assert(
      fc.asyncProperty(
        uploadKeyArb,
        purposeArb,
        fc.array(transientStepArb, { minLength: 0, maxLength: UPLOAD_MAX_ATTEMPTS }),
        fc.boolean(),
        async (uploadKey, purpose, transientFailures, endsInSuccess) => {
          jest.clearAllMocks();
          const steps = buildAttemptScript(transientFailures, endsInSuccess);
          const fetchMock = scriptedFetch(steps);
          (global as any).fetch = fetchMock;

          await settleUpload(
            uploadBlobViaBackend({ ...uploadArgs(), purpose, uploadKey }),
          );

          // The zero-size blob skips preflight, so every call here is an upload
          // attempt — and the scripted sequence really was consumed, so a run
          // with generated failures genuinely retried (the property is not
          // vacuously true on a single-attempt run).
          expect(preflightUrlsOf(fetchMock)).toHaveLength(0);
          const urls = uploadUrlsOf(fetchMock);
          expect(urls).toHaveLength(steps.length);

          // The invariant: one key for the whole action.
          const keys = urls.map(uploadKeyParamOf);
          expect(new Set(keys).size).toBe(1);
          for (const key of keys) {
            expect(key).toBe(uploadKey.trim());
          }
          // Attempt N targets a byte-identical URL to attempt 1, not merely the
          // same key: the path is derived from the whole request.
          expect(new Set(urls).size).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
    // 100 async runs, each driving the full retry loop through
    // `jest.runAllTimersAsync()`. Comfortably under jest's 5s default in
    // isolation, but not when the whole repo suite runs in parallel workers —
    // hence an explicit budget rather than a reduced `numRuns`.
  }, PROPERTY_TEST_TIMEOUT_MS);

  // Feature: upload-idempotency, Property 9: Client retries never re-mint the upload key
  // **Validates: Requirements 7.3, 7.6, 10.7**
  it('Property 9: two separate invocations minting via newUploadKey carry different uploadKeys', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(transientStepArb, { minLength: 0, maxLength: UPLOAD_MAX_ATTEMPTS - 1 }),
        fc.array(transientStepArb, { minLength: 0, maxLength: UPLOAD_MAX_ATTEMPTS - 1 }),
        purposeArb,
        async (firstFailures, secondFailures, purpose) => {
          const runOnce = async (transientFailures: UploadStep[]): Promise<string[]> => {
            jest.clearAllMocks();
            const fetchMock = scriptedFetch(buildAttemptScript(transientFailures, true));
            (global as any).fetch = fetchMock;

            // Minted per user action, exactly as the call sites do (task 8.1).
            const uploadKey = newUploadKey(purpose);
            expect(uploadKey.length).toBeGreaterThanOrEqual(8);
            expect(uploadKey.length).toBeLessThanOrEqual(200);

            await settleUpload(uploadBlobViaBackend({ ...uploadArgs(), purpose, uploadKey }));

            const keys = uploadUrlsOf(fetchMock).map(uploadKeyParamOf);
            expect(keys.length).toBeGreaterThan(0);
            for (const key of keys) {
              expect(key).toBe(uploadKey);
            }
            return keys as string[];
          };

          const firstKeys = await runOnce(firstFailures);
          const secondKeys = await runOnce(secondFailures);

          // Two user actions => two objects: the keys must not collide.
          expect(firstKeys[0]).not.toBe(secondKeys[0]);
        },
      ),
      { numRuns: 100 },
    );
    // Two full invocations per run, so twice the work of the property above.
  }, PROPERTY_TEST_TIMEOUT_MS);

  it('omits the uploadKey parameter entirely when no key is passed (legacy callers unaffected)', async () => {
    const fetchMock = scriptedFetch(['success']);
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend(uploadArgs());
    await jest.runAllTimersAsync();
    await p;

    const urls = uploadUrlsOf(fetchMock);
    expect(urls).toHaveLength(1);
    const parsed = new URL(urls[0]);
    expect(parsed.searchParams.has('uploadKey')).toBe(false);
    // Everything else a legacy caller sends is untouched.
    expect(parsed.searchParams.get('tenantId')).toBe('t1');
    expect(parsed.searchParams.get('purpose')).toBe('receipt');
    expect(parsed.searchParams.get('filename')).toBe('receipt.jpg');
  });

  it('issues the preflight exactly once per invocation, outside the retry loop', async () => {
    // A real (non-zero) size so preflight actually fires, and two transient
    // failures so the upload loop runs three attempts around it.
    const fetchMock = scriptedFetch([503, 'network', 'success']);
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend({
      ...uploadArgs(),
      blob: nonZeroBlob,
      uploadKey: 'receipt_preflight_key_1',
    });
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.url).toBe(SUCCESS_BODY.url);
    expect(preflightUrlsOf(fetchMock)).toHaveLength(1);
    const uploads = uploadUrlsOf(fetchMock);
    expect(uploads).toHaveLength(3);
    for (const url of uploads) {
      expect(uploadKeyParamOf(url)).toBe('receipt_preflight_key_1');
    }
    // The preflight is a size check for the logical action, so it carries the
    // byte count and no upload key.
    const preflight = new URL(preflightUrlsOf(fetchMock)[0]);
    expect(preflight.searchParams.get('bytes')).toBe('4096');
    expect(preflight.searchParams.has('uploadKey')).toBe(false);
  });

  it('keeps the same uploadKey across the 401 refresh inside a single attempt', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(errResponse(401, 'unauthorized'))
      .mockResolvedValueOnce(okResponse(SUCCESS_BODY));
    (global as any).fetch = fetchMock;

    const p = uploadBlobViaBackend({ ...uploadArgs(), uploadKey: 'receipt_401_refresh_key' });
    await jest.runAllTimersAsync();
    const result = await p;

    expect(result.url).toBe(SUCCESS_BODY.url);
    expect(forceRefresh).toHaveBeenCalledTimes(1);
    const urls = uploadUrlsOf(fetchMock);
    expect(urls).toHaveLength(2);
    expect(new Set(urls).size).toBe(1);
    for (const url of urls) {
      expect(uploadKeyParamOf(url)).toBe('receipt_401_refresh_key');
    }
  });
});
