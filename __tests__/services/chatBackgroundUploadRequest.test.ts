// Feature: upload-idempotency — the NATIVE BACKGROUND transport's object identity
//
// `chatService.buildChatBackgroundUploadRequest` builds the one URL the native
// uploader (`rn-background-upload` / gotev) replays for every internal retry. It
// used to send the OS-supplied `file.fileName` as `filename`, which the backend
// uses to seed the deterministic object path
// (`chat-files/{tenant}/{folder}/k_{hash(uploadKey)}_{safeName}`) — so a background
// upload that TRANSFERRED bytes and then failed, followed by a foreground retry,
// wrote a SECOND object (the message itself stayed deduped by `clientMsgId`, so the
// surplus blob was a pure orphan).
//
// The two jobs that one parameter was doing are now split: `filename` drives the
// object path and is derived from the send's `clientMsgId`, while `displayName`
// carries the real name the recipient sees. This suite pins both halves, asserted
// from the URL the builder actually produces.
//
// Only the auth/tenant/endpoint collaborators are mocked; the derivations under
// test (`deriveStableUploadFileName`, `uploadKeyFromStableId`) are the real ones.

jest.mock('react-native', () => ({
  __esModule: true,
  Alert: { alert: jest.fn() },
  Platform: { OS: 'web' },
}));

jest.mock('@/config/firebase', () => ({
  __esModule: true,
  database: { __mockDatabase: true },
  storage: { __mockStorage: true },
  auth: { currentUser: { email: 'sender@example.com', uid: 'uid-mock' } },
}));

jest.mock('firebase/database', () => ({
  __esModule: true,
  ref: jest.fn(),
  child: jest.fn(),
  push: jest.fn(),
  set: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  onValue: jest.fn(() => () => {}),
  onChildAdded: jest.fn(() => () => {}),
  onChildChanged: jest.fn(() => () => {}),
  off: jest.fn(),
  query: jest.fn(),
  orderByChild: jest.fn(),
  equalTo: jest.fn(),
  endAt: jest.fn(),
  limitToLast: jest.fn(),
  runTransaction: jest.fn(),
}));

jest.mock('firebase/storage', () => ({ __esModule: true, ref: jest.fn(), deleteObject: jest.fn() }));
jest.mock('expo-file-system', () => ({ __esModule: true }));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), metric: jest.fn() },
}));

jest.mock('@/services/sharedFileService', () => ({
  __esModule: true,
  sharedFileService: { recordUploadShareToken: jest.fn(), ensureSmartShareLink: jest.fn() },
}));

jest.mock('@/services/internalTokenManager', () => ({
  __esModule: true,
  internalTokenManager: {
    setBaseUrl: jest.fn(),
    getToken: jest.fn(async () => 'test-token'),
    forceRefresh: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/maintenanceAlert', () => ({
  __esModule: true,
  maybeShowMaintenanceAlertFromRaw: jest.fn(),
}));
jest.mock('@/services/storageLimitAlert', () => ({
  __esModule: true,
  maybeShowStorageLimitReachedAlert: jest.fn(() => false),
}));
jest.mock('@/services/modalAlertService', () => ({ __esModule: true, tryPresentModalAlert: jest.fn() }));
jest.mock('@/services/chatRealtimeStream', () => ({ __esModule: true, chatRealtimeStream: {} }));

jest.mock('@/services/runtimeEndpoints', () => ({
  __esModule: true,
  runtimeEndpoints: {
    getSnapshot: jest.fn(() => ({})),
    getPreferredBackendBaseUrl: jest.fn(() => 'https://api.example.com'),
  },
}));

jest.mock('@/services/tenantService', () => ({
  __esModule: true,
  tenantService: {
    getCachedSelectedTenant: jest.fn(async () => 'tenant-test'),
    getCachedMemberships: jest.fn(async () => [
      { tenantId: 'tenant-test', status: 'active', email: 'sender@example.com' },
    ]),
    getMembershipsForUser: jest.fn(async () => [
      { tenantId: 'tenant-test', status: 'active', email: 'sender@example.com' },
    ]),
    cacheMemberships: jest.fn(async () => {}),
    isEmailActiveMemberOfTenant: jest.fn(async () => true),
  },
}));

jest.mock('@/hooks/useAuthUnified', () => ({
  __esModule: true,
  authService: { getCurrentUser: () => ({ uid: 'uid-mock', email: 'sender@example.com' }) },
}));

import { chatService } from '../../services/chatService';
import { deriveStableUploadFileName } from '../../lib/uploadFileName';
import {
  stableIdForFileIndex,
  uploadKeyForFileIndex,
  uploadKeyFromStableId,
} from '../../lib/uploadKey';

const SENDER = 'sender@example.com';
const RECIPIENT = 'partner@example.com';

/** The route's chat-video detection regex (`backend-runtime/src/app.ts`). */
const ROUTE_VIDEO_NAME_REGEX = /\.(mp4|mov|m4v|avi|mkv|webm|hevc|heic)$/i;

const buildRequest = (overrides: Record<string, unknown> = {}) =>
  chatService.buildChatBackgroundUploadRequest({
    fileName: 'IMG_0042.jpg',
    fileType: 'image/jpeg',
    senderEmail: SENDER,
    recipientEmail: RECIPIENT,
    mediaKind: 'sticker',
    clientMsgId: 'pm_1712345678901_abc123',
    source: 'keyboard',
    localUri: 'file:///staged/pm_1712345678901_abc123.jpg',
    ...overrides,
  } as Parameters<typeof chatService.buildChatBackgroundUploadRequest>[0]);

const paramsOf = async (overrides: Record<string, unknown> = {}) => {
  const { url } = await buildRequest(overrides);
  return new URL(url).searchParams;
};

describe('buildChatBackgroundUploadRequest — deterministic filename + displayName', () => {
  it('sends a filename derived from the clientMsgId, not the OS-supplied name', async () => {
    const params = await paramsOf();
    const filename = params.get('filename') ?? '';

    // The value the foreground path derives for the same send (chat.tsx passes the
    // same stableId/source/mime/uri), computed here from the real helper.
    expect(filename).toBe(
      deriveStableUploadFileName({
        stableId: 'pm_1712345678901_abc123',
        source: 'keyboard',
        mime: 'image/jpeg',
        uri: 'file:///staged/pm_1712345678901_abc123.jpg',
      })
    );
    // Not the OS name any more, and traceable back to the pending item.
    expect(filename).not.toBe('IMG_0042.jpg');
    expect(filename).toContain('pm_1712345678901_abc123');
    // Already inside the backend's `[A-Za-z0-9._-]` sanitizer, so the path the
    // client predicts is the path the server writes.
    expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('carries the OS-supplied name through as displayName, unchanged', async () => {
    const params = await paramsOf();
    expect(params.get('displayName')).toBe('IMG_0042.jpg');
    // Two parameters, two different values — that is the whole point of the split.
    expect(params.get('displayName')).not.toBe(params.get('filename'));
  });

  it('applies only the pre-existing client-side sanitization to displayName', async () => {
    // `chatService` has always reduced the outgoing name to `[a-zA-Z0-9.-]`; the
    // display name keeps exactly that treatment, so nothing new reaches the message.
    const params = await paramsOf({ fileName: 'holiday photo (1).jpeg' });
    expect(params.get('displayName')).toBe('holiday_photo__1_.jpeg');
  });

  it('falls back to a non-empty displayName when the OS supplied no name', async () => {
    const params = await paramsOf({ fileName: '' });
    expect(params.get('displayName')).toBe('file');
    expect(params.get('filename')).toBeTruthy();
  });

  it('is stable across two invocations for the same clientMsgId', async () => {
    // The gap this closes: the native uploader's internal retries, and a re-drive
    // of the same pending item, must resolve to ONE object.
    const first = await paramsOf();
    const second = await paramsOf();
    expect(second.get('filename')).toBe(first.get('filename'));
    expect(second.get('uploadKey')).toBe(first.get('uploadKey'));
    expect(second.get('displayName')).toBe(first.get('displayName'));
  });

  it('is stable even when the OS-supplied name changes between attempts', async () => {
    // A hydrated/re-driven item can lose or re-mint its display name; the object
    // identity must not follow it.
    const first = await paramsOf({ fileName: 'IMG_0042.jpg' });
    const second = await paramsOf({ fileName: 'keyboard_1712345699999.jpg' });
    expect(second.get('filename')).toBe(first.get('filename'));
    expect(second.get('uploadKey')).toBe(first.get('uploadKey'));
    // Only the visible label differs.
    expect(second.get('displayName')).toBe('keyboard_1712345699999.jpg');
  });

  it('differs for a different clientMsgId — two sends still produce two objects', async () => {
    const first = await paramsOf({ clientMsgId: 'pm_1712345678901_aaaaaa' });
    const second = await paramsOf({ clientMsgId: 'pm_1712345678901_bbbbbb' });
    expect(second.get('filename')).not.toBe(first.get('filename'));
    expect(second.get('uploadKey')).not.toBe(first.get('uploadKey'));
    // Same file picked twice is still two attachments, as the spec requires.
    expect(second.get('displayName')).toBe(first.get('displayName'));
  });

  it('derives filename and uploadKey from the SAME clientMsgId as the foreground path', async () => {
    // Both halves of the object identity (`k_{hash(uploadKey)}_{safeName}`) must
    // match what `chat.tsx` sends on the foreground retry, or the retry writes a
    // second object. This is the assertion for the gap being closed.
    const clientMsgId = 'pm_1712345678901_abc123';
    const params = await paramsOf({ clientMsgId });

    const foregroundUploadKey = uploadKeyFromStableId(clientMsgId);
    const foregroundFileName = deriveStableUploadFileName({
      stableId: clientMsgId,
      source: 'keyboard',
      mime: 'image/jpeg',
      uri: 'file:///staged/pm_1712345678901_abc123.jpg',
    });

    expect(params.get('uploadKey')).toBe(foregroundUploadKey);
    expect(params.get('filename')).toBe(foregroundFileName);
  });

  it('uses the file-0 convention, so a single-file ATTACHMENT matches the foreground fan-out', async () => {
    // The foreground counterpart for an attachment is
    // `sendMessageWithMultipleFiles`, which seeds file i with
    // `stableIdForFileIndex(clientMsgId, i)` because the fan-out needs one distinct
    // identity per file. A single-file send is file 0, and `stableIdForFileIndex`
    // returns the bare base there — so this transport and that one derive the
    // identical pair. Before that convention existed the two disagreed on BOTH
    // halves and a background attachment that transferred bytes and then failed left
    // the foreground re-drive writing a second, orphaned object.
    //
    // (The end-to-end version of this, driven through the real foreground
    // transport, is in `__tests__/services/chatMultiFileUploadKeys.test.ts`.)
    const clientMsgId = 'pm_1712345678901_onefile';
    const localUri = 'file:///staged/pm_1712345678901_onefile.jpg';
    const params = await paramsOf({
      mediaKind: 'attachment',
      source: 'picker',
      clientMsgId,
      localUri,
      fileName: 'IMG_0042.jpg',
    });

    expect(params.get('uploadKey')).toBe(uploadKeyForFileIndex(clientMsgId, 0));
    expect(params.get('filename')).toBe(
      deriveStableUploadFileName({
        stableId: stableIdForFileIndex(clientMsgId, 0),
        source: 'picker',
        mime: 'image/jpeg',
        uri: localUri,
      })
    );
    // A second file of that same send would be a different object.
    expect(params.get('uploadKey')).not.toBe(uploadKeyForFileIndex(clientMsgId, 1));
  });

  it('keeps the video-transcode trigger intact for a background video upload', async () => {
    // The route detects a chat video via `contentType.startsWith('video/')` OR the
    // filename extension. A deterministic name must not silently drop out of both.
    const mp4 = await paramsOf({ fileType: 'video/mp4', fileName: 'VID_0001.mp4' });
    expect(ROUTE_VIDEO_NAME_REGEX.test(mp4.get('filename') ?? '')).toBe(true);

    // `video/quicktime` yields a `.quicktime` suffix, which the regex does not
    // match — the content-type arm is what carries it, so assert the header the
    // native uploader sends is still the video mime.
    const { headers } = await buildRequest({ fileType: 'video/quicktime', fileName: 'VID_0002.mov' });
    expect(headers['Content-Type']).toBe('video/quicktime');
    expect(headers['Content-Type'].startsWith('video/')).toBe(true);
  });

  it('leaves every other query parameter and the auth headers unchanged', async () => {
    const { url, headers } = await buildRequest({ text: 'here you go', mediaKind: 'attachment' });
    const params = new URL(url).searchParams;
    expect(new URL(url).origin + new URL(url).pathname).toBe('https://api.example.com/storage/upload');
    expect(params.get('purpose')).toBe('chat');
    expect(params.get('tenantId')).toBe('tenant-test');
    expect(params.get('createMessage')).toBe('1');
    expect(params.get('clientMsgId')).toBe('pm_1712345678901_abc123');
    expect(params.get('recipientId')).toBe(RECIPIENT);
    expect(params.get('mediaKind')).toBe('attachment');
    expect(params.get('messageText')).toBe('here you go');
    expect(params.get('conversationFolder')).toBeTruthy();
    expect(headers.Authorization).toBe('Bearer test-token');
  });
});
