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

import { uploadBlobViaBackend } from '../../services/backendStorageUploadService';

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
