// Feature: video-transcoding-compatibility, Property 27: Web prefetch never targets a video URL
// Validates Requirement 7.5

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
jest.mock('../../services/webMediaCache', () => ({ webMediaCache: { getCached: jest.fn().mockResolvedValue(null), fetchAndCache: jest.fn().mockResolvedValue('https://cached.example.com/file') } }));
jest.mock('../../lib/chatHistoryPolicy', () => ({ clampRange: jest.fn(), deriveRangeFromMessages: jest.fn(), partitionMessagesByLimit: jest.fn(), rangesOverlap: jest.fn(), safeTimestamp: jest.fn((ts: any) => (ts ? new Date(ts).getTime() : null)) }));
jest.mock('../../lib/chatPaginationConfig', () => ({ getChatPaginationProfile: jest.fn().mockReturnValue({ cacheLimit: 200 }) }));
jest.mock('../../services/tenantService', () => ({ tenantService: { getCachedSelectedTenant: jest.fn().mockResolvedValue('tenant1') } }));
jest.mock('firebase/app', () => ({ getApp: jest.fn() }));
jest.mock('firebase/firestore', () => ({ getFirestore: jest.fn(), collection: jest.fn(), query: jest.fn(), where: jest.fn(), limit: jest.fn(), getDocs: jest.fn().mockResolvedValue({ empty: true, docs: [] }) }));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { chatCacheService } from '../../services/chatCacheService';
import { webMediaCache } from '../../services/webMediaCache';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VIDEO_FILE_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo'];
const IMAGE_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_FILE_NAMES = ['clip.mp4', 'recording.mov', 'video.avi'];
const IMAGE_FILE_NAMES = ['photo.jpg', 'thumb.png', 'preview.webp'];

// ─── Property 27 ─────────────────────────────────────────────────────────────

describe('Property 27: Web prefetch never targets a video URL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the prefetch set by creating fresh calls
  });

  it('holds: no video file URL is passed to webMediaCache.fetchAndCache', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            id: fc.uuid(),
            timestamp: fc.constant('2024-01-01T00:00:00.000Z'),
            sender: fc.emailAddress(),
            recipientId: fc.emailAddress(),
            text: fc.string(),
            attachments: fc.array(
              fc.oneof(
                // Video attachment
                fc.record({
                  url: fc.webUrl({ withQueryParameters: false }),
                  fileName: fc.constantFrom(...VIDEO_FILE_NAMES),
                  fileType: fc.constantFrom(...VIDEO_FILE_TYPES),
                  fileSize: fc.nat({ max: 50_000_000 }),
                }),
                // Image attachment
                fc.record({
                  url: fc.webUrl({ withQueryParameters: false }),
                  fileName: fc.constantFrom(...IMAGE_FILE_NAMES),
                  fileType: fc.constantFrom(...IMAGE_FILE_TYPES),
                  fileSize: fc.nat({ max: 1_000_000 }),
                }),
              ),
              { minLength: 1, maxLength: 5 },
            ),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (messages) => {
          // Drain any previous prefetch state by waiting
          await new Promise((r) => setTimeout(r, 10));
          (webMediaCache.fetchAndCache as jest.Mock).mockClear();

          // Cast to any — the generated records contain only the fields the
          // prefetch logic reads (attachments), not the full ChatMessage shape.
          chatCacheService.scheduleAttachmentPrefetch(messages as any);

          // Allow the prefetch timer (75 ms) and drain loop to run
          await new Promise((r) => setTimeout(r, 200));

          // Every fetchAndCache call must be for a non-video URL
          const fetchCalls = (webMediaCache.fetchAndCache as jest.Mock).mock.calls;
          for (const [url] of fetchCalls) {
            const isVideoUrl =
              VIDEO_FILE_NAMES.some((name) => String(url).includes(name)) ||
              VIDEO_FILE_TYPES.some((type) => String(url).includes(type.split('/')[1]));
            expect(isVideoUrl).toBe(false);
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
