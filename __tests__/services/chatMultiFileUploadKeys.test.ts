// Feature: upload-idempotency — foreground MULTI-file chat attachment path
//
// `chatService.sendMessageWithMultipleFiles` uploads N attachments concurrently
// through `chatService.uploadFile`. This suite pins the object-identity discipline
// for that fan-out — BOTH halves of it, since the backend's deterministic chat path
// is `chat-files/{tenant}/{folder}/k_{hash(uploadKey)}_{safeName}` and therefore
// keyed on the pair (`uploadKey`, `filename`). Asserted from the URLs the transport
// actually opens rather than from a re-implementation of the derivations:
//
//   - every file of one send carries a DISTINCT key AND a distinct storage
//     filename, both derived from `(clientMsgId, index)`, so two attachments that
//     share an OS filename cannot clobber each other;
//   - file i's key and filename are STABLE across two invocations carrying the same
//     `clientMsgId`, so a re-driven send overwrites rather than orphaning;
//   - two different `clientMsgId`s give file i two different objects, so two
//     separate user actions still produce two objects;
//   - the retry inside one invocation (the 401 token refresh, which re-opens the
//     request) reuses the byte-identical URL;
//   - the DEFENSIVE FALLBACK when the stable id is missing at runtime — a path only a
//     caller TypeScript never checked can reach, since `clientMsgId` is a required
//     parameter: both halves stay distinct per file, are deliberately NOT stable
//     across invocations, and the lost cross-invocation guarantee is logged;
//   - a normal typed call logs no such warning;
//   - a SINGLE-file send derives the identical pair as the native background
//     transport for the same `clientMsgId` (file 0 is the bare id), which is the
//     regression gate for the last orphan source in the chat media path;
//   - the OS-supplied name still travels, as `displayName`, and the `attachments`
//     array the message carries is unchanged.
//
// The real `chatService.uploadFile` runs on its web (XHR) branch. Only the
// transport (`XMLHttpRequest`), the token manager, tenant/auth resolution and the
// alert/share side effects are mocked; `sendMessage` is stubbed because the message
// write is a different concern.

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
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    metric: jest.fn(),
  },
}));

const recordUploadShareToken = jest.fn(async () => {});
const ensureSmartShareLink = jest.fn(async () => {});
jest.mock('@/services/sharedFileService', () => ({
  __esModule: true,
  sharedFileService: {
    recordUploadShareToken: (...args: any[]) => recordUploadShareToken(...(args as [])),
    ensureSmartShareLink: (...args: any[]) => ensureSmartShareLink(...(args as [])),
  },
}));

const forceRefresh = jest.fn(async () => {});
jest.mock('@/services/internalTokenManager', () => ({
  __esModule: true,
  internalTokenManager: {
    setBaseUrl: jest.fn(),
    getToken: jest.fn(async () => 'test-token'),
    forceRefresh: (...args: any[]) => forceRefresh(...(args as [])),
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
jest.mock('@/services/modalAlertService', () => ({
  __esModule: true,
  tryPresentModalAlert: jest.fn(),
}));

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
  authService: {
    getCurrentUser: () => ({ uid: 'uid-mock', email: 'sender@example.com' }),
  },
}));

import { chatService } from '../../services/chatService';
import { logger } from '@/lib/logger';

const SENDER = 'sender@example.com';
const RECIPIENT = 'partner@example.com';

// ---------------------------------------------------------------------------
// XMLHttpRequest fake: records every opened URL and answers `send()` with a
// scripted status. A zero-size blob keeps `ensureUploadPreflight` a no-op, so the
// only requests in play are the `/storage/upload` POSTs themselves.
// ---------------------------------------------------------------------------

/** Every `xhr.open()` seen this test, in order. */
let openedUrls: string[] = [];
/** Per-URL attempt counter, so a script can answer 401 then 200 for one URL. */
let attemptsByUrl: Map<string, number>;
/** `(url, attemptIndex) => status`. */
let statusFor: (url: string, attemptIndex: number) => number = () => 200;

class FakeXhr {
  status = 0;
  responseText = '';
  upload: Record<string, unknown> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private requestUrl = '';

  open(_method: string, url: string): void {
    this.requestUrl = url;
    openedUrls.push(url);
  }

  setRequestHeader(): void {}

  abort(): void {}

  send(): void {
    const seen = attemptsByUrl.get(this.requestUrl) ?? 0;
    attemptsByUrl.set(this.requestUrl, seen + 1);
    const status = statusFor(this.requestUrl, seen);
    this.status = status;
    if (status === 200) {
      // Echo the key back in the url so a caller could distinguish objects; the
      // assertions read the request URLs, not this body.
      const key = new URL(this.requestUrl).searchParams.get('uploadKey') ?? 'nokey';
      this.responseText = JSON.stringify({
        url: `https://cdn.example.com/${encodeURIComponent(key)}`,
        bytes: 11,
      });
    } else {
      this.responseText = `upload_failed_${status}`;
    }
    setTimeout(() => this.onload?.(), 0);
  }
}

/** A blob whose numeric size short-circuits `resolveWebUploadBlob` (no fetch). */
const webBlob = () => ({ size: 0, type: 'image/jpeg' }) as unknown as Blob;

const filesNamed = (names: string[]) =>
  names.map((fileName, index) => ({
    uri: `blob:local/${index}`,
    fileName,
    fileType: 'image/jpeg',
    fileSize: 0,
    webFile: webBlob(),
  }));

const keyOf = (url: string): string | null => new URL(url).searchParams.get('uploadKey');
/** The STORAGE name — deterministic in `(clientMsgId, index)`, not the OS name. */
const filenameOf = (url: string): string | null => new URL(url).searchParams.get('filename');
/** The user-visible name — the OS-supplied one, carried separately. */
const displayNameOf = (url: string): string | null => new URL(url).searchParams.get('displayName');

/**
 * Group the recorded upload URLs by their `displayName` param, i.e. by the OS name
 * of the file each attempt was for. The N uploads of one send run concurrently, so
 * `xhr.open()` order is not guaranteed — grouping maps an attempt back to its file
 * without depending on that order. The OS name is the right grouping key precisely
 * because it is the one thing the object identity is NOT derived from any more.
 */
const urlsByDisplayName = (): Map<string, string[]> => {
  const grouped = new Map<string, string[]>();
  for (const url of openedUrls) {
    const name = displayNameOf(url) ?? '';
    const list = grouped.get(name) ?? [];
    list.push(url);
    grouped.set(name, list);
  }
  return grouped;
};

/** Read one query param for `displayName`, asserting every attempt agreed on it. */
const paramForDisplayName = (
  displayName: string,
  read: (url: string) => string | null
): string => {
  const urls = urlsByDisplayName().get(displayName) ?? [];
  expect(urls.length).toBeGreaterThan(0);
  const values = new Set(urls.map(read));
  expect(values.size).toBe(1);
  const [value] = [...values];
  expect(typeof value).toBe('string');
  return value as string;
};

/** The single `uploadKey` used for the file the OS named `displayName`. */
const keyForDisplayName = (displayName: string): string =>
  paramForDisplayName(displayName, keyOf);

/** The single storage `filename` used for the file the OS named `displayName`. */
const filenameForDisplayName = (displayName: string): string =>
  paramForDisplayName(displayName, filenameOf);

const resetTransport = (): void => {
  openedUrls = [];
  attemptsByUrl = new Map();
  statusFor = () => 200;
};

let sendMessageSpy: jest.SpyInstance;

const send = (
  files: ReturnType<typeof filesNamed>,
  clientMsgId: string
): Promise<string> =>
  chatService.sendMessageWithMultipleFiles(
    'here you go',
    files,
    SENDER,
    RECIPIENT,
    undefined,
    undefined,
    undefined,
    clientMsgId
  );

/**
 * The DEGRADED call: no `clientMsgId` at all.
 *
 * `clientMsgId` is a REQUIRED parameter, so this is deliberately routed through an
 * `any`-typed reference — a type-checked caller cannot express it (omitting the
 * argument is a compile error). It stands in for the only callers that still can:
 * plain JS, or a call that has lost its types. The `as any` here is the point of the
 * test, not a convenience.
 */
const sendWithoutClientMsgId = (files: ReturnType<typeof filesNamed>): Promise<string> =>
  (chatService as any).sendMessageWithMultipleFiles(
    'here you go',
    files,
    SENDER,
    RECIPIENT,
    undefined,
    undefined,
    undefined
  );

/** The warning the service emits when the stable id is missing at runtime. */
const MISSING_ID_WARNING = 'chat.upload.multi_file_missing_client_msg_id';

const missingIdWarnings = (): unknown[][] =>
  (logger.warn as jest.Mock).mock.calls.filter((call) => call[0] === MISSING_ID_WARNING);

describe('sendMessageWithMultipleFiles upload-key discipline (upload-idempotency)', () => {
  beforeEach(() => {
    resetTransport();
    (global as any).XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    sendMessageSpy = jest
      .spyOn(chatService as any, 'sendMessage')
      .mockResolvedValue('server-message-1');
    forceRefresh.mockClear();
    (logger.warn as jest.Mock).mockClear();
  });

  afterEach(() => {
    sendMessageSpy.mockRestore();
  });

  it('gives every file of one send a DISTINCT uploadKey', async () => {
    await send(filesNamed(['a.jpg', 'b.jpg', 'c.jpg']), 'pm_1712345678901_abc123');

    expect(openedUrls).toHaveLength(3);
    const keys = openedUrls.map(keyOf);
    // Present on every attempt, and pairwise distinct.
    keys.forEach((key) => expect(key).toBeTruthy());
    expect(new Set(keys).size).toBe(3);
  });

  it('does NOT collapse two files that share an OS filename onto one object', async () => {
    // The deterministic chat path is `k_{hash(uploadKey)}_{safeName}`, so BOTH
    // halves have to differ per file. The OS name is no longer either half: the
    // three uploads below share `photo.jpg` and still resolve to three objects,
    // because the key AND the storage filename are both derived from
    // `(clientMsgId, index)`.
    await send(filesNamed(['photo.jpg', 'photo.jpg', 'photo.jpg']), 'pm_same_name_send');

    expect(openedUrls).toHaveLength(3);
    expect(new Set(openedUrls.map(keyOf)).size).toBe(3);
    expect(new Set(openedUrls.map(filenameOf)).size).toBe(3);
    // The OS name still reaches the recipient, via `displayName`.
    expect(new Set(openedUrls.map(displayNameOf))).toEqual(new Set(['photo.jpg']));
  });

  it('reuses the identical key per file across two invocations with the same clientMsgId', async () => {
    const names = ['a.jpg', 'b.jpg', 'c.jpg'];
    const clientMsgId = 'pm_1712345678901_stable';

    await send(filesNamed(names), clientMsgId);
    const first = names.map(keyForDisplayName);

    resetTransport();
    await send(filesNamed(names), clientMsgId);
    const second = names.map(keyForDisplayName);

    // A re-driven send (user-tapped retry / outbox re-drive re-sends the same
    // `entry.files` with the same tempId) overwrites its own objects.
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(3);
  });

  it('gives file i a different key when the clientMsgId differs', async () => {
    const names = ['a.jpg', 'b.jpg'];

    await send(filesNamed(names), 'pm_first_action_0001');
    const first = names.map(keyForDisplayName);

    resetTransport();
    await send(filesNamed(names), 'pm_second_action_0002');
    const second = names.map(keyForDisplayName);

    // Two separate user actions => two sets of objects (Requirement 7.3).
    names.forEach((_name, index) => expect(second[index]).not.toBe(first[index]));
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it('reuses the byte-identical URL when an attempt retries inside one invocation', async () => {
    // 401 on the first attempt of each upload, 200 on the re-opened one.
    statusFor = (_url, attemptIndex) => (attemptIndex === 0 ? 401 : 200);

    await send(filesNamed(['a.jpg', 'b.jpg']), 'pm_retry_within_send');

    expect(forceRefresh).toHaveBeenCalledTimes(2);
    expect(openedUrls).toHaveLength(4);

    const grouped = urlsByDisplayName();
    for (const name of ['a.jpg', 'b.jpg']) {
      const urls = grouped.get(name) ?? [];
      expect(urls).toHaveLength(2);
      // Not merely the same key: the same whole URL, so nothing about the target
      // object can drift between attempts.
      expect(new Set(urls).size).toBe(1);
      expect(keyOf(urls[0])).toBeTruthy();
    }
    // The two files still differ from each other.
    expect(keyForDisplayName('a.jpg')).not.toBe(keyForDisplayName('b.jpg'));
  });

  // -------------------------------------------------------------------------
  // THE DEFENSIVE FALLBACK. `clientMsgId` is a required parameter, so a
  // type-checked caller CANNOT reach the cases below; they cover the JS / lost-types
  // caller only. The contract is that such a call still uploads (no crash, no lost
  // send), still keeps the N files apart, and is LOUD about the guarantee it gives
  // up — cross-invocation dedupe.
  // -------------------------------------------------------------------------

  it('falls back to distinct per-file keys and WARNS when clientMsgId is missing at runtime', async () => {
    // Fallback behavior: mint one random base per invocation and index it. Keeps the
    // N files apart and makes the transport's own retries idempotent, but cannot
    // dedupe across invocations — there is no caller-stable id to key on.
    const names = ['a.jpg', 'b.jpg'];

    await sendWithoutClientMsgId(filesNamed(names));
    const first = names.map(keyForDisplayName);
    expect(new Set(first).size).toBe(2);
    first.forEach((key) => {
      expect(key).toMatch(/^[A-Za-z0-9_-]{8,200}$/);
    });

    // The degraded path names the guarantee it lost, once per invocation.
    const warnings = missingIdWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0][1]).toEqual(
      expect.objectContaining({
        fileCount: 2,
        lostGuarantee: expect.stringContaining('cross-invocation'),
      })
    );

    resetTransport();
    (logger.warn as jest.Mock).mockClear();
    await sendWithoutClientMsgId(filesNamed(names));
    const second = names.map(keyForDisplayName);

    // Deliberately UNSTABLE across invocations, asserted so it cannot change
    // silently: with no caller-stable id there is nothing to dedupe against, so a
    // re-drive is treated as a NEW logical action and gets new objects. This is the
    // degraded path — a type-checked caller cannot reach it, and the warning above
    // is what surfaces it if a JS caller does.
    names.forEach((_name, index) => expect(second[index]).not.toBe(first[index]));
    expect(missingIdWarnings()).toHaveLength(1);
  });

  it('emits NO missing-id warning for a normal typed call that supplies a clientMsgId', async () => {
    await send(filesNamed(['a.jpg', 'b.jpg']), 'pm_1712345678901_typed');

    expect(openedUrls).toHaveLength(2);
    expect(missingIdWarnings()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Storage FILENAME discipline. The object's identity is the PAIR
  // (uploadKey, filename), so a stable key with the OS-supplied name is only
  // half-stable — and it is the half that made a single-file attachment send
  // disagree with its own background upload.
  // -------------------------------------------------------------------------

  it('sends a deterministic storage filename per file, not the OS-supplied name', async () => {
    const names = ['a.jpg', 'b.jpg', 'c.jpg'];
    await send(filesNamed(names), 'pm_1712345678901_names');

    const filenames = names.map(filenameForDisplayName);
    // Never the OS name, and traceable back to the send.
    filenames.forEach((filename) => {
      expect(names).not.toContain(filename);
      expect(filename).toContain('pm_1712345678901_names');
      // Already inside the backend's `[A-Za-z0-9._-]` sanitizer, so the path the
      // client predicts is the path the server writes.
      expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
    });
    // Index participates in the filename, not just in the key.
    expect(new Set(filenames).size).toBe(3);
  });

  it('reuses the identical filename per file across two invocations with the same clientMsgId', async () => {
    const names = ['a.jpg', 'b.jpg', 'c.jpg'];
    const clientMsgId = 'pm_1712345678901_stable';

    await send(filesNamed(names), clientMsgId);
    const first = names.map(filenameForDisplayName);

    resetTransport();
    await send(filesNamed(names), clientMsgId);
    const second = names.map(filenameForDisplayName);

    // Both halves stable ⇒ a re-driven send overwrites its own objects.
    expect(second).toEqual(first);
  });

  it('gives file i a different filename when the clientMsgId differs', async () => {
    const names = ['a.jpg', 'b.jpg'];

    await send(filesNamed(names), 'pm_first_action_0001');
    const first = names.map(filenameForDisplayName);

    resetTransport();
    await send(filesNamed(names), 'pm_second_action_0002');
    const second = names.map(filenameForDisplayName);

    names.forEach((_name, index) => expect(second[index]).not.toBe(first[index]));
    expect(new Set([...first, ...second]).size).toBe(4);
  });

  it('carries the OS-supplied name through as displayName, unchanged', async () => {
    await send(filesNamed(['holiday photo (1).jpeg', 'b.jpg']), 'pm_display_name_send');

    // Only the pre-existing client-side reduction to `[a-zA-Z0-9.-]` is applied —
    // exactly what this path has always sent as `filename`.
    const displayNames = openedUrls.map(displayNameOf).sort();
    expect(displayNames).toEqual(['b.jpg', 'holiday_photo__1_.jpeg']);
  });

  it('falls back to distinct-but-unstable filenames and WARNS when clientMsgId is missing at runtime', async () => {
    // The filename half of the same defensive fallback, reachable only by a caller
    // TypeScript never checked. Distinct per file, deliberately unstable across
    // invocations: without a caller-stable id there is nothing to dedupe against.
    const names = ['a.jpg', 'b.jpg'];

    await sendWithoutClientMsgId(filesNamed(names));
    const first = names.map(filenameForDisplayName);
    expect(new Set(first).size).toBe(2);
    expect(missingIdWarnings()).toHaveLength(1);

    resetTransport();
    (logger.warn as jest.Mock).mockClear();
    await sendWithoutClientMsgId(filesNamed(names));
    const second = names.map(filenameForDisplayName);

    names.forEach((_name, index) => expect(second[index]).not.toBe(first[index]));
    expect(missingIdWarnings()).toHaveLength(1);
  });

  it('keeps a video extension on the storage filename so the transcode trigger still fires', async () => {
    // The route detects a chat video from `contentType.startsWith('video/')` OR the
    // storage filename's extension. A picked file whose mime the OS did not supply
    // arrives as `application/octet-stream`, so the extension arm is the only one
    // left — the deterministic name must not drop it.
    await send(
      [
        {
          uri: 'file:///staged/pa_1__0.MOV',
          fileName: 'IMG_9001.MOV',
          fileType: 'application/octet-stream',
          fileSize: 0,
          webFile: webBlob(),
        },
      ],
      'pm_video_ext_send'
    );

    expect(openedUrls).toHaveLength(1);
    expect(filenameOf(openedUrls[0])).toMatch(/\.(mp4|mov|m4v|avi|mkv|webm|hevc|heic)$/i);
  });

  // -------------------------------------------------------------------------
  // THE REGRESSION GATE for the gap this closes. A single-file attachment send
  // can go out over either transport: the native background uploader when it can
  // start, else this foreground fan-out. Before the fix the two derived DIFFERENT
  // keys (`uploadKeyFromStableId(clientMsgId)` vs
  // `uploadKeyForFileIndex(clientMsgId, 0)`) AND different filenames (derived vs
  // OS-supplied), so a background upload that transferred bytes and then failed,
  // followed by a foreground re-drive of the same send, wrote a second object —
  // an orphan, since the message stays deduped by `clientMsgId`.
  // -------------------------------------------------------------------------
  it('agrees with the native background transport on both halves of the object identity', async () => {
    const clientMsgId = 'pm_1712345678901_onefile';
    const file = {
      uri: 'file:///staged/pm_1712345678901_onefile.jpg',
      fileName: 'IMG_0042.jpg',
      fileType: 'image/jpeg',
      fileSize: 0,
      webFile: webBlob(),
    };

    // The URL the native uploader would replay for this send.
    const { url: backgroundUrl } = await chatService.buildChatBackgroundUploadRequest({
      fileName: file.fileName,
      fileType: file.fileType,
      senderEmail: SENDER,
      recipientEmail: RECIPIENT,
      mediaKind: 'attachment',
      clientMsgId,
      // What `app/(tabs)/chat.tsx` passes for a picked single-file attachment.
      source: 'picker',
      localUri: file.uri,
    });
    const background = new URL(backgroundUrl).searchParams;

    // The URL the foreground fan-out actually opens for the same send.
    await send([file], clientMsgId);
    expect(openedUrls).toHaveLength(1);
    const foreground = new URL(openedUrls[0]).searchParams;

    // Both halves of the identity — this is the assertion that fails before the fix.
    expect(foreground.get('uploadKey')).toBe(background.get('uploadKey'));
    expect(foreground.get('filename')).toBe(background.get('filename'));
    // Everything else the deterministic object path is built from.
    expect(foreground.get('tenantId')).toBe(background.get('tenantId'));
    expect(foreground.get('purpose')).toBe(background.get('purpose'));
    expect(foreground.get('conversationFolder')).toBe(background.get('conversationFolder'));
    // And the recipient sees the same name either way.
    expect(foreground.get('displayName')).toBe(background.get('displayName'));
    expect(foreground.get('displayName')).toBe('IMG_0042.jpg');
  });

  it('keeps the attachments array and the send payload intact', async () => {
    await send(filesNamed(['a.jpg', 'b.jpg']), 'pm_payload_check_1');

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const payload = sendMessageSpy.mock.calls[0][0];
    expect(payload.attachments).toHaveLength(2);
    payload.attachments.forEach((attachment: any) => {
      expect(attachment.url).toMatch(/^https:\/\/cdn\.example\.com\//);
      expect(attachment.fileType).toBe('image/jpeg');
      expect(attachment.fileSize).toBe(11);
    });
    // The OS-supplied names, unchanged by the deterministic STORAGE filenames the
    // uploads used: this path builds its own message payload rather than relying on
    // the server's `createMessage=1` path, so nothing user-visible moved.
    expect(payload.attachments.map((a: any) => a.fileName)).toEqual(['a.jpg', 'b.jpg']);
    expect(openedUrls.map(filenameOf)).not.toContain('a.jpg');
    expect(payload.clientMsgId).toBe('pm_payload_check_1');
    // Two attachments, two distinct stored objects.
    expect(new Set(payload.attachments.map((a: any) => a.url)).size).toBe(2);
    expect(openedUrls).toHaveLength(2);
  });
});
