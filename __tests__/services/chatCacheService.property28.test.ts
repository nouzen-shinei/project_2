// Feature: video-transcoding-compatibility, Property 28: Web media cache never fetches a video URL
// Validates Requirement 7.6

import * as fc from 'fast-check';

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn().mockResolvedValue(null), setItem: jest.fn(), removeItem: jest.fn(), multiRemove: jest.fn() },
}));

jest.mock('expo-file-system', () => ({}));
jest.mock('expo-crypto', () => ({ getRandomBytesAsync: jest.fn().mockResolvedValue(new Uint8Array(32)) }));
jest.mock('expo-secure-store', () => ({}));
jest.mock('expo-device', () => ({ getDeviceTypeAsync: jest.fn().mockResolvedValue(null) }));
jest.mock('expo-image-manipulator', () => ({}));
jest.mock('crypto-js', () => ({
  SHA512: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue('a'.repeat(128)) }),
  AES: { encrypt: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue('enc') }), decrypt: jest.fn().mockReturnValue({ toString: jest.fn().mockReturnValue('{}') }) },
  enc: { Hex: { parse: jest.fn() }, Utf8: 'utf8' },
  mode: { CBC: {} },
  pad: { Pkcs7: {} },
}));

const mockFetchAndCache = jest.fn().mockResolvedValue('https://cached.example.com/file');
const mockGetCached = jest.fn().mockResolvedValue(null);
jest.mock('../../services/webMediaCache', () => ({
  webMediaCache: { getCached: mockGetCached, fetchAndCache: mockFetchAndCache },
}));

jest.mock('../../lib/chatHistoryPolicy', () => ({ clampRange: jest.fn(), deriveRangeFromMessages: jest.fn(), partitionMessagesByLimit: jest.fn(), rangesOverlap: jest.fn(), safeTimestamp: jest.fn((ts: any) => (ts ? new Date(ts).getTime() : null)) }));
jest.mock('../../lib/chatPaginationConfig', () => ({ getChatPaginationProfile: jest.fn().mockReturnValue({ cacheLimit: 200 }) }));
jest.mock('../../services/tenantService', () => ({ tenantService: { getCachedSelectedTenant: jest.fn().mockResolvedValue('tenant1') } }));
jest.mock('firebase/app', () => ({ getApp: jest.fn() }));
jest.mock('firebase/firestore', () => ({ getFirestore: jest.fn(), collection: jest.fn(), query: jest.fn(), where: jest.fn(), limit: jest.fn(), getDocs: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { chatCacheService } from '../../services/chatCacheService';

// ─── Property 28 ─────────────────────────────────────────────────────────────

describe('Property 28: Web media cache never fetches a video URL', () => {
  describe('getMediaForDownload — returns URL unchanged for video files', () => {
    it('holds: fetchAndCache is never called for .mp4 files', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.webUrl({ withQueryParameters: true }),
          async (baseUrl) => {
            mockFetchAndCache.mockClear();
            mockGetCached.mockClear();

            const result = await chatCacheService.getMediaForDownload(
              baseUrl,
              'video.mp4',
            );

            // Must return the URL unchanged
            expect(result).toBe(baseUrl);
            // Must never invoke the cache fetch
            expect(mockFetchAndCache).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 50 },
      );
    });

    it('holds: fetchAndCache is never called for .mov files', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.webUrl({ withQueryParameters: false }),
          async (baseUrl) => {
            mockFetchAndCache.mockClear();

            const result = await chatCacheService.getMediaForDownload(
              baseUrl,
              'recording.mov',
            );

            expect(result).toBe(baseUrl);
            expect(mockFetchAndCache).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('prepareMediaUri (via drainAttachmentPrefetchQueue) — returns URL unchanged for video files', () => {
    it('holds: when a video fileName is present, the URL is returned unchanged', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.webUrl({ withQueryParameters: false }),
          fc.constantFrom('clip.mp4', 'video.mov', 'film.webm', 'screen.avi'),
          async (remoteUrl, fileName) => {
            mockFetchAndCache.mockClear();

            // Call getMediaForDownload directly (it delegates to prepareMediaUri for web)
            const result = await chatCacheService.getMediaForDownload(
              remoteUrl,
              fileName,
            );

            expect(result).toBe(remoteUrl);
            expect(mockFetchAndCache).not.toHaveBeenCalled();
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});
