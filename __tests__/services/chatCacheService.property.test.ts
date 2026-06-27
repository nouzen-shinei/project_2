// Feature: video-transcoding-compatibility, Property 4: Hydration attaches transcodedUrl for any valid video URL
// Feature: video-transcoding-compatibility, Property 5: Hydration returns undefined transcodedUrl for any URL with no matching document
// Feature: video-transcoding-compatibility, Property 6: Any Firestore query error leaves transcodedUrl undefined
// Feature: video-transcoding-compatibility, Property 9: Invalid attachment URLs skip the transcodedUrl query

/**
 * Property tests for `resolveTranscodedUrl` (private method) on `ChatCacheService`.
 *
 * Accessed via `(chatCacheService as any).resolveTranscodedUrl(url)`.
 *
 * All three properties test the web-only Firestore lookup path.
 * Platform is forced to `'web'` so the early-return guard for native is bypassed.
 */

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Module-level mocks — all declared before the service is imported.
// ---------------------------------------------------------------------------

// Force web platform so the native early-return is bypassed.
jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

// Firestore mock — we control getDocs, query, collection, where, limit, getFirestore.
// resolveTranscodedUrl uses dynamic import('firebase/firestore') and import('firebase/app'),
// so we mock them at the module level here; Jest hoists these mocks.
const mockGetDocs = jest.fn();
const mockQuery = jest.fn();
const mockCollection = jest.fn();
const mockWhere = jest.fn();
const mockLimit = jest.fn();
const mockGetFirestore = jest.fn();
const mockGetApp = jest.fn();

jest.mock('firebase/firestore', () => ({
  getDocs: (...args: unknown[]) => mockGetDocs(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  collection: (...args: unknown[]) => mockCollection(...args),
  where: (...args: unknown[]) => mockWhere(...args),
  limit: (...args: unknown[]) => mockLimit(...args),
  getFirestore: (...args: unknown[]) => mockGetFirestore(...args),
}));

jest.mock('firebase/app', () => ({
  getApp: (...args: unknown[]) => mockGetApp(...args),
}));

// Minimal mocks for all other chatCacheService dependencies.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('expo-file-system', () => ({
  documentDirectory: null,
  cacheDirectory: null,
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  downloadAsync: jest.fn().mockResolvedValue({ uri: '' }),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  readDirectoryAsync: jest.fn().mockResolvedValue([]),
  readAsStringAsync: jest.fn().mockResolvedValue(''),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn().mockResolvedValue(new Uint8Array(32)),
  digestStringAsync: jest.fn().mockResolvedValue('mock-digest'),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-device', () => ({
  getDeviceTypeAsync: jest.fn().mockResolvedValue(null),
  DeviceType: { PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4, UNKNOWN: 0 },
}));

jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: jest.fn().mockResolvedValue({ uri: '' }),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));

jest.mock('crypto-js', () => {
  const WordArray = { toString: jest.fn().mockReturnValue('') };
  const mockCipher = { toString: jest.fn().mockReturnValue('v2:mock-encrypted') };
  return {
    __esModule: true,
    default: {
      AES: {
        encrypt: jest.fn().mockReturnValue(mockCipher),
        decrypt: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue('{}') }),
      },
      SHA512: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue('a'.repeat(128)) }),
      enc: {
        Hex: {
          parse: jest.fn().mockReturnValue(WordArray),
        },
        Utf8: 'Utf8',
      },
      mode: { CBC: {} },
      pad: { Pkcs7: {} },
    },
  };
});

jest.mock('@/lib/logger', () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    metric: jest.fn(),
  },
}));

jest.mock('@/lib/chatHistoryPolicy', () => ({
  clampRange: jest.fn().mockReturnValue(null),
  deriveRangeFromMessages: jest.fn().mockReturnValue({ startTimestamp: null, endTimestamp: null }),
  partitionMessagesByLimit: jest.fn().mockReturnValue({ retained: [], spilled: [] }),
  rangesOverlap: jest.fn().mockReturnValue(false),
  safeTimestamp: jest.fn().mockReturnValue(null),
}));

jest.mock('@/lib/fileUtils', () => ({
  isAudioFile: jest.fn().mockReturnValue(false),
  isImageFile: jest.fn().mockReturnValue(false),
  isVideoFile: jest.fn().mockReturnValue(true),
}));

jest.mock('@/lib/chatPaginationConfig', () => ({
  getChatPaginationProfile: jest.fn().mockReturnValue({ cacheLimit: 100 }),
}));

jest.mock('@/services/tenantService', () => ({
  tenantService: {
    getCachedSelectedTenant: jest.fn().mockResolvedValue('tenant-123'),
  },
}));

jest.mock('./webMediaCache', () => ({
  webMediaCache: {
    getCached: jest.fn().mockResolvedValue(null),
    fetchAndCache: jest.fn().mockResolvedValue(null),
  },
}), { virtual: true });

jest.mock('@/services/webMediaCache', () => ({
  webMediaCache: {
    getCached: jest.fn().mockResolvedValue(null),
    fetchAndCache: jest.fn().mockResolvedValue(null),
  },
}));

// ---------------------------------------------------------------------------
// Import the service under test (after all mocks are in place).
// ---------------------------------------------------------------------------

import { chatCacheService } from '../../services/chatCacheService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an empty Firestore snapshot stub. */
function makeEmptySnapshot() {
  return { empty: true, docs: [] };
}

/** Build a Firestore snapshot stub with one document containing a transcodedUrl. */
function makeDocSnapshot(transcodedUrl: string) {
  return {
    empty: false,
    docs: [
      {
        data: () => ({ transcodedUrl, status: 'done' }),
      },
    ],
  };
}

/** A promise that never resolves — simulates an infinitely-pending Firestore query. */
function neverResolves(): Promise<never> {
  return new Promise(() => {/* intentionally never settles */});
}

// ---------------------------------------------------------------------------
// Property 4: Hydration attaches transcodedUrl for any valid video URL
// ---------------------------------------------------------------------------

/**
 * **Validates: Requirements 2.1, 2.2**
 *
 * Property 4: Hydration attaches transcodedUrl for any valid video URL
 *
 * For any valid HTTP/HTTPS video attachment URL where the Firestore query returns
 * a document with `status: 'done'`, `resolveTranscodedUrl` SHALL return the
 * `transcodedUrl` value from that document.
 *
 * Generator: `fc.webUrl()` for attachment URL; Firestore stub returns done doc;
 * assert returned value equals doc's `transcodedUrl`.
 */
describe('chatCacheService — Property 4: Hydration attaches transcodedUrl for any valid video URL', () => {
  const TRANSCODED_URL = 'https://cdn.example.com/h264.mp4';

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default Firestore chain mocks — all return the query object itself.
    mockGetApp.mockReturnValue({});
    mockGetFirestore.mockReturnValue({});
    mockCollection.mockReturnValue('mock-collection-ref');
    mockWhere.mockReturnValue('mock-where-ref');
    mockLimit.mockReturnValue('mock-limit-ref');
    mockQuery.mockReturnValue('mock-query');
    // getDocs returns a snapshot with one done document.
    mockGetDocs.mockResolvedValue(makeDocSnapshot(TRANSCODED_URL));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it(
    'resolveTranscodedUrl returns the transcodedUrl from the document for any valid URL',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.webUrl(),
          async (url) => {
            // Reset getDocs to return a done document for this URL.
            mockGetDocs.mockResolvedValue(makeDocSnapshot(TRANSCODED_URL));

            const result = await (chatCacheService as any).resolveTranscodedUrl(url);

            // MUST return the transcodedUrl from the document.
            expect(result).toBe(TRANSCODED_URL);
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it('returns the transcodedUrl for a specific valid HTTPS URL', async () => {
    mockGetDocs.mockResolvedValue(makeDocSnapshot(TRANSCODED_URL));
    const result = await (chatCacheService as any).resolveTranscodedUrl(
      'https://storage.googleapis.com/bucket/video.mp4',
    );
    expect(result).toBe(TRANSCODED_URL);
  });

  it('returns the transcodedUrl value as-is from the Firestore document', async () => {
    const specificTranscodedUrl = 'https://cdn.example.com/h264.mp4';
    mockGetDocs.mockResolvedValue(makeDocSnapshot(specificTranscodedUrl));
    const result = await (chatCacheService as any).resolveTranscodedUrl(
      'https://storage.example.com/video.hevc',
    );
    expect(result).toBe(specificTranscodedUrl);
  });
});

// ---------------------------------------------------------------------------
// Property 5: Hydration returns undefined transcodedUrl for any URL with no matching document
// ---------------------------------------------------------------------------

/**
 * **Validates: Requirements 2.3**
 *
 * Property 5: Hydration returns undefined transcodedUrl for any URL with no matching document
 *
 * For any valid HTTP/HTTPS video attachment URL where the Firestore query returns
 * an empty snapshot, `resolveTranscodedUrl` SHALL return `undefined`.
 *
 * Generator: `fc.webUrl()`; Firestore stub returns empty snapshot; assert `transcodedUrl === undefined`
 */
describe('chatCacheService — Property 5: No matching document returns undefined transcodedUrl', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default Firestore chain mocks — all return the query object itself.
    mockGetApp.mockReturnValue({});
    mockGetFirestore.mockReturnValue({});
    mockCollection.mockReturnValue('mock-collection-ref');
    mockWhere.mockReturnValue('mock-where-ref');
    mockLimit.mockReturnValue('mock-limit-ref');
    mockQuery.mockReturnValue('mock-query');
    // getDocs returns an empty snapshot (no matching document).
    mockGetDocs.mockResolvedValue(makeEmptySnapshot());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it(
    'resolveTranscodedUrl returns undefined for any valid URL with an empty Firestore snapshot',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.webUrl(),
          async (url) => {
            // Reset getDocs mock to return empty snapshot for this URL.
            mockGetDocs.mockResolvedValue(makeEmptySnapshot());

            const result = await (chatCacheService as any).resolveTranscodedUrl(url);

            // MUST return undefined — no matching document.
            expect(result).toBeUndefined();
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it('returns undefined for a specific valid URL with no matching document', async () => {
    mockGetDocs.mockResolvedValue(makeEmptySnapshot());
    const result = await (chatCacheService as any).resolveTranscodedUrl(
      'https://storage.googleapis.com/bucket/video.mp4',
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 6: Any Firestore query error leaves transcodedUrl undefined
// ---------------------------------------------------------------------------

/**
 * **Validates: Requirements 2.4**
 *
 * Property 6: Any Firestore query error leaves transcodedUrl undefined
 *
 * For any error value thrown by the Firestore `getDocs` call,
 * `resolveTranscodedUrl` SHALL return `undefined` and SHALL NOT rethrow.
 *
 * Generator: `fc.anything()` for thrown error type; assert method returns
 * `undefined` without rethrowing.
 */
describe('chatCacheService — Property 6: Firestore error leaves transcodedUrl undefined', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetApp.mockReturnValue({});
    mockGetFirestore.mockReturnValue({});
    mockCollection.mockReturnValue('mock-collection-ref');
    mockWhere.mockReturnValue('mock-where-ref');
    mockLimit.mockReturnValue('mock-limit-ref');
    mockQuery.mockReturnValue('mock-query');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it(
    'resolveTranscodedUrl returns undefined and does not rethrow for any getDocs error',
    async () => {
      // Use a valid HTTPS URL so the URL validation guard is passed.
      const validUrl = 'https://storage.example.com/video.mp4';

      await fc.assert(
        fc.asyncProperty(
          fc.anything(),
          async (thrownValue) => {
            // Make getDocs reject with the generated arbitrary error value.
            mockGetDocs.mockRejectedValue(thrownValue);

            let returnedValue: unknown = Symbol('NOT_CALLED'); // sentinel
            let threw = false;

            try {
              returnedValue = await (chatCacheService as any).resolveTranscodedUrl(validUrl);
            } catch {
              threw = true;
            }

            // MUST NOT rethrow — error is caught internally.
            expect(threw).toBe(false);
            // MUST return undefined.
            expect(returnedValue).toBeUndefined();
          },
        ),
        { numRuns: 50 },
      );
    },
  );

  it('returns undefined when getDocs throws a network Error', async () => {
    mockGetDocs.mockRejectedValue(new Error('Network error'));
    const result = await (chatCacheService as any).resolveTranscodedUrl(
      'https://storage.example.com/video.mp4',
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when getDocs throws a non-Error primitive', async () => {
    mockGetDocs.mockRejectedValue('permission-denied');
    const result = await (chatCacheService as any).resolveTranscodedUrl(
      'https://storage.example.com/video.mp4',
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when getDocs throws null', async () => {
    mockGetDocs.mockRejectedValue(null);
    const result = await (chatCacheService as any).resolveTranscodedUrl(
      'https://storage.example.com/video.mp4',
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Property 9: Invalid attachment URLs skip the transcodedUrl query
// ---------------------------------------------------------------------------

/**
 * **Validates: Requirements 2.8**
 *
 * Property 9: Invalid attachment URLs skip the transcodedUrl query
 *
 * WHEN the attachment URL is empty, a blob URL, a data URI, or an ftp:// URL,
 * `resolveTranscodedUrl` SHALL return `undefined` without issuing any Firestore query.
 *
 * Generator: `fc.oneof(fc.constant(''), fc.constant('blob:x'), fc.constant('data:x'), fc.constant('ftp://x'))`
 * assert no Firestore query is issued (getDocs is never called).
 */
describe('chatCacheService — Property 9: Invalid attachment URLs skip the Firestore query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetApp.mockReturnValue({});
    mockGetFirestore.mockReturnValue({});
    mockCollection.mockReturnValue('mock-collection-ref');
    mockWhere.mockReturnValue('mock-where-ref');
    mockLimit.mockReturnValue('mock-limit-ref');
    mockQuery.mockReturnValue('mock-query');
    // If getDocs is ever called, it will resolve with a document — ensuring any
    // accidental call would produce a non-undefined result and fail the assertion.
    mockGetDocs.mockResolvedValue(makeDocSnapshot('https://cdn.example.com/transcoded.mp4'));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it(
    'resolveTranscodedUrl returns undefined and never calls getDocs for invalid URL patterns',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(''),
            fc.constant('blob:x'),
            fc.constant('data:x'),
            fc.constant('ftp://x'),
          ),
          async (invalidUrl) => {
            mockGetDocs.mockClear();

            const result = await (chatCacheService as any).resolveTranscodedUrl(invalidUrl);

            // MUST return undefined — no valid HTTP/HTTPS URL prefix.
            expect(result).toBeUndefined();
            // MUST NOT call getDocs — the URL guard should short-circuit before any query.
            expect(mockGetDocs).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 4 }, // Only 4 distinct values in the generator.
      );
    },
  );

  it('returns undefined and skips getDocs for an empty string URL', async () => {
    const result = await (chatCacheService as any).resolveTranscodedUrl('');
    expect(result).toBeUndefined();
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('returns undefined and skips getDocs for a blob URL', async () => {
    const result = await (chatCacheService as any).resolveTranscodedUrl('blob:x');
    expect(result).toBeUndefined();
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('returns undefined and skips getDocs for a data URI', async () => {
    const result = await (chatCacheService as any).resolveTranscodedUrl('data:x');
    expect(result).toBeUndefined();
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('returns undefined and skips getDocs for an ftp:// URL', async () => {
    const result = await (chatCacheService as any).resolveTranscodedUrl('ftp://x');
    expect(result).toBeUndefined();
    expect(mockGetDocs).not.toHaveBeenCalled();
  });

  it('does call getDocs for a valid https:// URL (sanity check)', async () => {
    mockGetDocs.mockResolvedValue(makeEmptySnapshot());
    const result = await (chatCacheService as any).resolveTranscodedUrl(
      'https://storage.example.com/video.mp4',
    );
    // getDocs should have been called (valid URL passes the guard).
    expect(mockGetDocs).toHaveBeenCalledTimes(1);
    // Empty snapshot → undefined.
    expect(result).toBeUndefined();
  });
});
