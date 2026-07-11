// Feature: chat-production-hardening (Task 2 — finding P0-1, Model A: backend is
// the ONLY chat writer).
//
// Unit tests for the LAST client-writer migration: when the chat backend is
// configured, `chatService.rebuildConversationSummariesForUser` MUST route
// through the authenticated `POST /chat/summaries/rebuild` endpoint instead of
// writing to RTDB directly — because the deployed RTDB rules lock client chat
// write paths to `.write:false`, so the former direct `set(...)`/`update(...)`
// rebuild fails with permission_denied. The direct-write path is retained ONLY as
// the no-backend fallback (parity with `markConversationAsRead` /
// `reconcileUnreadForUser`).
//
// The real chatService runs against a functional in-memory Realtime Database;
// only the transport (`fetch`), token manager, and tenant/auth resolution are
// mocked (same scaffolding as chatMutationBackendRouting.test.ts).

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`).
// ---------------------------------------------------------------------------
jest.mock('firebase/database', () => {
  const store: Record<string, any> = {};

  const splitPath = (p: unknown): string[] =>
    String(p ?? '')
      .split('/')
      .filter((seg) => seg.length > 0);

  const clone = (v: unknown): any => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const readNode = (segments: string[]): any => {
    let cur: any = store;
    for (const seg of segments) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[seg];
    }
    return cur;
  };

  const writeNode = (segments: string[], value: any): void => {
    if (segments.length === 0) return;
    let cur: any = store;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (cur[seg] == null || typeof cur[seg] !== 'object') {
        cur[seg] = {};
      }
      cur = cur[seg];
    }
    if (value === undefined) {
      delete cur[segments[segments.length - 1]];
    } else {
      cur[segments[segments.length - 1]] = value;
    }
  };

  const makeRef = (path: string) => {
    const segments = splitPath(path);
    return { __ref: true as const, path, key: segments.length ? segments[segments.length - 1] : null };
  };

  const makeSnapshot = (segments: string[], key: string | null) => {
    const val = readNode(segments);
    return {
      exists: () => val !== undefined && val !== null,
      val: () => clone(val),
      key,
      forEach: (cb: (child: any) => boolean | void) => {
        const node = readNode(segments);
        if (node && typeof node === 'object') {
          for (const childKey of Object.keys(node)) {
            const stop = cb(makeSnapshot([...segments, childKey], childKey));
            if (stop === true) return true;
          }
        }
        return false;
      },
    };
  };

  return {
    __esModule: true,
    __getStore: () => store,
    __resetStore: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    ref: (_db: unknown, path = '') => makeRef(path),
    child: (parent: { path: string }, sub: string) => makeRef(`${parent.path}/${sub}`),
    push: (parent: { path: string }) => makeRef(`${parent.path}/-Mock${Math.random().toString(36).slice(2, 8)}`),
    set: async (r: { path: string }, value: unknown) => {
      writeNode(splitPath(r.path), clone(value));
    },
    update: async (r: { path: string }, patch: Record<string, unknown>) => {
      const segments = splitPath(r.path);
      const existing = readNode(segments);
      const base = existing && typeof existing === 'object' ? existing : {};
      writeNode(segments, { ...base, ...clone(patch) });
    },
    get: async (r: { path: string; key: string | null }) => makeSnapshot(splitPath(r.path), r.key),
    runTransaction: async (r: { path: string; key: string | null }, fn: (current: any) => any) => {
      const segments = splitPath(r.path);
      const current = clone(readNode(segments));
      const next = fn(current);
      const committed = next !== undefined;
      if (committed) writeNode(segments, clone(next));
      return { committed, snapshot: makeSnapshot(segments, r.key) };
    },
    onValue: () => () => {},
    onChildAdded: () => () => {},
    onChildChanged: () => () => {},
    off: () => {},
    query: (r: unknown) => r,
    orderByChild: () => ({}),
    equalTo: () => ({}),
    endAt: () => ({}),
    limitToLast: () => ({}),
  };
});

// ---------------------------------------------------------------------------
// Peripheral mocks — everything chatService imports at module scope.
// ---------------------------------------------------------------------------
jest.mock('@/config/firebase', () => ({
  __esModule: true,
  database: { __mockDatabase: true },
  storage: { __mockStorage: true },
  auth: { currentUser: { email: 'sender@example.com', uid: 'uid-mock' } },
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

// ---------------------------------------------------------------------------
// Imports after mocks are registered.
// ---------------------------------------------------------------------------
import { chatService } from '../../services/chatService';
import * as rtdb from 'firebase/database';

const resetStore = (): void => (rtdb as any).__resetStore();

const database = { __mockDatabase: true };

function sanitizeEmailKey(value: string): string {
  return value.trim().toLowerCase().replace(/[.@]/g, '_');
}
function conversationKeyOf(a: string, b: string): string {
  return [sanitizeEmailKey(a), sanitizeEmailKey(b)].sort().join('__');
}
function seedRaw(path: string, record: Record<string, unknown>): void {
  void (rtdb as any).set((rtdb as any).ref(database, path), record);
}
function readSummary(userKey: string, partnerKey: string): any {
  const store = (rtdb as any).__getStore();
  return store?.tenantChat?.['tenant-test']?.conversationSummaries?.[userKey]?.[partnerKey] ?? null;
}

const ME = 'sender@example.com';
const THEM = 'partner@example.com';

let fetchMock: jest.Mock;

function installFetch(routes: Record<string, any>): void {
  fetchMock = jest.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const payload = routes[path] ?? { ok: true };
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as any;
  });
  (global as any).fetch = fetchMock;
}

describe('rebuildConversationSummariesForUser backend routing (Task 2, P0-1 — Model A)', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    getPreferredBackendBaseUrlMock.mockReturnValue('https://api.example.com');
  });

  it('routes through POST /chat/summaries/rebuild and does NOT write RTDB directly', async () => {
    installFetch({
      '/chat/summaries/rebuild': { ok: true, rebuiltConversations: 2, prunedConversations: 1 },
    });

    const meKey = sanitizeEmailKey(ME);
    const ghostKey = sanitizeEmailKey('ghost@example.com');
    // A stale summary the DIRECT rebuild would prune (set null). Routing to the
    // backend must leave the store untouched — proof no direct RTDB write ran.
    seedRaw(`tenantChat/tenant-test/conversationSummaries/${meKey}/${ghostKey}`, {
      partnerEmail: 'ghost@example.com',
      unreadCount: 2,
      updatedAt: new Date().toISOString(),
    });

    await chatService.rebuildConversationSummariesForUser(ME);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(new URL(calledUrl).pathname).toBe('/chat/summaries/rebuild');
    expect(calledInit.method).toBe('POST');
    const body = JSON.parse(calledInit.body);
    expect(body.tenantId).toBe('tenant-test');

    // The client performed NO direct RTDB write — the stale summary is untouched
    // (the direct path would have pruned it).
    expect(readSummary(meKey, ghostKey)).not.toBeNull();
  });

  it('falls back to a direct RTDB rebuild when no chat backend is configured', async () => {
    installFetch({});
    getPreferredBackendBaseUrlMock.mockReturnValue(undefined);

    const meKey = sanitizeEmailKey(ME);
    const themKey = sanitizeEmailKey(THEM);
    const convKey = conversationKeyOf(ME, THEM);

    // Seed the conversation index entry, the latest pointer, and one unread
    // incoming message so the direct rebuild has something to reconstruct.
    seedRaw(`tenantChat/tenant-test/userConversations/${meKey}/${convKey}`, {
      conversationKey: convKey,
      partnerEmail: THEM,
      partnerKey: themKey,
      unreadCount: 1,
      updatedAt: new Date().toISOString(),
    });
    seedRaw(`tenantChat/tenant-test/conversationLatest/${convKey}`, {
      messageId: '-inbound',
      timestamp: new Date().toISOString(),
      sender: THEM,
      recipientId: ME,
      tenantId: 'tenant-test',
      delivered: false,
      read: false,
      isSpecial: false,
      preview: { text: 'hi', type: 'text' },
    });
    seedRaw(`tenantChat/tenant-test/conversationMessages/${convKey}/-inbound`, {
      id: '-inbound',
      sender: THEM,
      recipientId: ME,
      conversationKey: convKey,
      timestamp: new Date().toISOString(),
      text: 'hi',
      read: false,
      delivered: false,
    });

    await chatService.rebuildConversationSummariesForUser(ME);

    // No backend configured → the endpoint is never called and the direct path
    // reconstructs the summary in RTDB.
    expect(fetchMock).not.toHaveBeenCalled();
    const rebuilt = readSummary(meKey, themKey);
    expect(rebuilt).not.toBeNull();
    expect(rebuilt.partnerEmail).toBe(THEM);
  });
});
