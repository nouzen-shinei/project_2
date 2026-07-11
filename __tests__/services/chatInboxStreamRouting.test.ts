// Feature: chat-production-hardening (messageIndex read lockdown).
//
// `chatService.onMessagesChange` powers the global in-app chat notification
// signal (hooks/useNotifications.ts). It USED to read the RTDB
// `tenantChat/{tenantId}/messageIndex` node directly (an
// `orderByChild('recipientId').equalTo(me)` + `onValue` query). That client read
// was the last thing forcing `messageIndex .read` open.
//
// These tests prove the refactor:
//   1. `onMessagesChange` subscribes to the authenticated backend per-user inbox
//      stream (`chatInboxStream`) scoped to the caller, and issues NO RTDB
//      `messageIndex` query (`onValue`/`query` are never called);
//   2. each inbound stream event is routed to the callback as the SAME
//      lightweight ChatMessage shape the hook expects (empty `text`, routing +
//      status only), so the hook's filtering/dedup/notification logic is
//      unchanged;
//   3. tearing down the subscription closes the stream;
//   4. with no chat backend configured it emits an empty set and still reads
//      nothing from RTDB.

// ---------------------------------------------------------------------------
// firebase/database mock — onValue/query are jest.fns so we can assert the
// messageIndex query is NEVER issued.
// ---------------------------------------------------------------------------
const onValueMock = jest.fn(() => () => {});
const queryMock = jest.fn((r: unknown) => r);
const getMock = jest.fn(async () => ({ exists: () => false, val: () => null, forEach: () => false }));

jest.mock('firebase/database', () => ({
  __esModule: true,
  ref: (_db: unknown, path = '') => ({ __ref: true, path }),
  child: (parent: { path: string }, sub: string) => ({ __ref: true, path: `${parent.path}/${sub}` }),
  push: (parent: { path: string }) => ({ __ref: true, path: `${parent.path}/-Mock` }),
  set: jest.fn(async () => {}),
  update: jest.fn(async () => {}),
  get: (...args: unknown[]) => (getMock as any)(...args),
  runTransaction: jest.fn(async () => ({ committed: false, snapshot: { val: () => null } })),
  onValue: (...args: unknown[]) => (onValueMock as any)(...args),
  onChildAdded: jest.fn(() => () => {}),
  onChildChanged: jest.fn(() => () => {}),
  off: jest.fn(),
  query: (...args: unknown[]) => (queryMock as any)(...args),
  orderByChild: jest.fn(() => ({})),
  equalTo: jest.fn(() => ({})),
  endAt: jest.fn(() => ({})),
  limitToLast: jest.fn(() => ({})),
}));

// ---------------------------------------------------------------------------
// Peripheral mocks — everything chatService imports at module scope.
// ---------------------------------------------------------------------------
jest.mock('@/config/firebase', () => ({
  __esModule: true,
  database: { __mockDatabase: true },
  storage: { __mockStorage: true },
  auth: { currentUser: { email: 'bob@example.com', uid: 'uid-mock' } },
}));

jest.mock('firebase/storage', () => ({ __esModule: true, ref: jest.fn(), deleteObject: jest.fn() }));

jest.mock('react-native', () => ({
  __esModule: true,
  Alert: { alert: jest.fn() },
  Platform: { OS: 'web' },
}));

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

jest.mock('@/lib/chatAttachmentMessage', () => ({
  __esModule: true,
  resolveChatAttachmentAutoText: jest.fn(() => ''),
}));

jest.mock('@/lib/chatUploadProgress', () => ({
  __esModule: true,
  createChatUploadProgressEmitter: jest.fn(() => ({ emit: jest.fn() })),
  normalizeChatUploadProgressPercent: jest.fn((v: number) => v),
  resolveChatUploadProgressPercentFromBytes: jest.fn(() => 0),
}));

jest.mock('@/lib/chatUploadUtils', () => ({
  __esModule: true,
  resolveChatUploadFolder: jest.fn(() => 'uploads'),
}));

jest.mock('@/services/sharedFileService', () => ({ __esModule: true, sharedFileService: {} }));

jest.mock('@/services/internalTokenManager', () => ({
  __esModule: true,
  internalTokenManager: {
    getToken: jest.fn(async () => 'token'),
    forceRefresh: jest.fn(async () => 'token'),
    setBaseUrl: jest.fn(),
  },
}));

jest.mock('@/services/maintenanceAlert', () => ({
  __esModule: true,
  maybeShowMaintenanceAlertFromRaw: jest.fn(),
}));

jest.mock('@/services/storageLimitAlert', () => ({
  __esModule: true,
  maybeShowStorageLimitReachedAlert: jest.fn(),
}));

jest.mock('@/services/modalAlertService', () => ({
  __esModule: true,
  tryPresentModalAlert: jest.fn(),
}));

jest.mock('@/services/chatRealtimeStream', () => ({ __esModule: true, chatRealtimeStream: {} }));

// The star of this test: the per-user inbox stream client.
const inboxSubscribeMock = jest.fn();
const inboxCloseMock = jest.fn();
jest.mock('@/services/chatInboxStream', () => ({
  __esModule: true,
  chatInboxStream: {
    subscribe: (...args: unknown[]) => (inboxSubscribeMock as any)(...args),
  },
}));

const getPreferredBackendBaseUrlMock = jest.fn<string | undefined, []>(() => 'https://api.example.com');
jest.mock('@/services/runtimeEndpoints', () => ({
  __esModule: true,
  runtimeEndpoints: {
    getSnapshot: jest.fn(() => ({})),
    getPreferredBackendBaseUrl: getPreferredBackendBaseUrlMock,
  },
}));

jest.mock('@/services/tenantService', () => ({
  __esModule: true,
  tenantService: {
    getCachedSelectedTenant: jest.fn(async () => 'tenant-test'),
  },
}));

jest.mock('@/hooks/useAuthUnified', () => ({
  __esModule: true,
  authService: {
    getCurrentUser: () => ({ uid: 'uid-mock', email: 'bob@example.com' }),
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks are registered.
// ---------------------------------------------------------------------------
import { chatService, type ChatMessage } from '../../services/chatService';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const RECIPIENT = 'bob@example.com';
const SENDER = 'alice@example.com';

describe('onMessagesChange routes through the backend inbox stream (messageIndex read lockdown)', () => {
  let capturedOptions: any = null;
  let capturedOnInbound: ((payload: any) => void) | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    getPreferredBackendBaseUrlMock.mockReturnValue('https://api.example.com');
    capturedOptions = null;
    capturedOnInbound = null;
    inboxSubscribeMock.mockImplementation(async (opts: any) => {
      capturedOptions = opts;
      capturedOnInbound = opts.onInbound;
      return inboxCloseMock;
    });
  });

  it('subscribes to the per-user inbox stream and issues NO RTDB messageIndex query', async () => {
    const received: ChatMessage[][] = [];
    const unsubscribe = chatService.onMessagesChange(RECIPIENT, (msgs) => received.push(msgs));
    await flush();

    expect(inboxSubscribeMock).toHaveBeenCalledTimes(1);
    expect(capturedOptions.baseUrl).toBe('https://api.example.com');
    expect(capturedOptions.tenantId).toBe('tenant-test');
    expect(capturedOptions.userEmail).toBe(RECIPIENT);

    // The client performed NO RTDB messageIndex read.
    expect(onValueMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(getMock).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('routes each inbound event to the callback as a lightweight ChatMessage (empty text, routing + status)', async () => {
    const received: ChatMessage[][] = [];
    const unsubscribe = chatService.onMessagesChange(RECIPIENT, (msgs) => received.push(msgs));
    await flush();

    expect(typeof capturedOnInbound).toBe('function');
    capturedOnInbound!({
      id: 'm1',
      sender: SENDER,
      recipientId: RECIPIENT,
      timestamp: '2026-04-15T00:00:01.000Z',
      conversationKey: 'alice_example_com__bob_example_com',
      delivered: false,
      read: false,
      isSpecial: true,
      tenantId: 'tenant-test',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    const msg = received[0][0];
    expect(msg.id).toBe('m1');
    expect(msg.sender).toBe(SENDER);
    expect(msg.recipientId).toBe(RECIPIENT);
    expect(msg.text).toBe('');
    expect(msg.timestamp).toBe('2026-04-15T00:00:01.000Z');
    expect(msg.isSpecial).toBe(true);
    expect(msg.delivered).toBe(false);
    expect(msg.read).toBe(false);
    expect(msg.conversationKey).toBe('alice_example_com__bob_example_com');
    expect(msg.tenantId).toBe('tenant-test');

    // A malformed payload (no id) is dropped, not forwarded.
    capturedOnInbound!({ sender: SENDER, timestamp: '2026-04-15T00:00:02.000Z' });
    expect(received).toHaveLength(1);

    unsubscribe();
  });

  it('closes the stream when the returned unsubscribe is invoked', async () => {
    const unsubscribe = chatService.onMessagesChange(RECIPIENT, () => {});
    await flush();
    expect(inboxCloseMock).not.toHaveBeenCalled();

    unsubscribe();
    expect(inboxCloseMock).toHaveBeenCalledTimes(1);
  });

  it('emits an empty set and reads nothing when no chat backend is configured', async () => {
    getPreferredBackendBaseUrlMock.mockReturnValue(undefined);

    const received: ChatMessage[][] = [];
    const unsubscribe = chatService.onMessagesChange(RECIPIENT, (msgs) => received.push(msgs));
    await flush();

    expect(received).toEqual([[]]);
    expect(inboxSubscribeMock).not.toHaveBeenCalled();
    expect(onValueMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();

    unsubscribe();
  });
});
