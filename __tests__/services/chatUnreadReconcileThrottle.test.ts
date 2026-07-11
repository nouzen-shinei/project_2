// Feature: chat-production-hardening (Task 7 — finding P3-4).
//
// Guards the CLIENT `chatService.reconcileUnreadForUser` dispatcher against
// multi-device races/noise with a throttle + in-flight guard. These tests prove:
//   (a) N near-simultaneous triggers collapse to a SINGLE in-flight reconcile;
//   (b) a call inside the throttle window is suppressed (no extra call);
//   (c) a call after the throttle window still runs;
//   (d) the self short-circuit path (markConversationAsRead on a self-conversation)
//       issues NO network/direct call.
//
// Only the transport (`fetch`), token manager, and tenant/auth resolution are
// mocked — the real chatService runs against an in-memory Realtime Database
// (same scaffolding as chatMutationBackendRouting.test.ts).

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

const SENDER = 'sender@example.com';

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

const RECONCILE_ROUTE = { '/chat/unread/reconcile': { ok: true, reconciledConversations: 0, selfConversationsCleaned: 0 } };

describe('client unread-reconcile throttle + in-flight guard (Task 7, P3-4)', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
    getPreferredBackendBaseUrlMock.mockReturnValue('https://api.example.com');
    // Reset the singleton's throttle/coalescing state and clock between cases.
    (chatService as any).__resetUnreadReconcileState();
  });

  it('(a) coalesces N near-simultaneous triggers into a single in-flight reconcile', async () => {
    installFetch(RECONCILE_ROUTE);

    // Fire five triggers in the same tick (e.g. summary refresh + mark-as-read +
    // foreground resume racing on one client). They must collapse to one call.
    await Promise.all([
      chatService.reconcileUnreadForUser(SENDER),
      chatService.reconcileUnreadForUser(SENDER),
      chatService.reconcileUnreadForUser(SENDER),
      chatService.reconcileUnreadForUser(SENDER),
      chatService.reconcileUnreadForUser(SENDER),
    ]);

    const reconcileCalls = fetchMock.mock.calls.filter(
      ([url]) => new URL(url).pathname === '/chat/unread/reconcile'
    );
    expect(reconcileCalls).toHaveLength(1);
  });

  it('(b) suppresses a repeat call inside the throttle window', async () => {
    installFetch(RECONCILE_ROUTE);

    let mockNow = 1000;
    (chatService as any).__setUnreadReconcileClock(() => mockNow);
    (chatService as any).__setUnreadReconcileThrottleMs(5000);

    // First call runs.
    await chatService.reconcileUnreadForUser(SENDER);
    // Advance within the window (2000ms < 5000ms) — the repeat must be dropped.
    mockNow = 3000;
    await chatService.reconcileUnreadForUser(SENDER);

    const reconcileCalls = fetchMock.mock.calls.filter(
      ([url]) => new URL(url).pathname === '/chat/unread/reconcile'
    );
    expect(reconcileCalls).toHaveLength(1);
  });

  it('(c) still runs a genuinely-needed call after the throttle window elapses', async () => {
    installFetch(RECONCILE_ROUTE);

    let mockNow = 0;
    (chatService as any).__setUnreadReconcileClock(() => mockNow);
    (chatService as any).__setUnreadReconcileThrottleMs(5000);

    // Run at t=0.
    await chatService.reconcileUnreadForUser(SENDER);
    // Suppressed inside the window at t=2000.
    mockNow = 2000;
    await chatService.reconcileUnreadForUser(SENDER);
    // Past the window at t=6000 — must run again.
    mockNow = 6000;
    await chatService.reconcileUnreadForUser(SENDER);

    const reconcileCalls = fetchMock.mock.calls.filter(
      ([url]) => new URL(url).pathname === '/chat/unread/reconcile'
    );
    expect(reconcileCalls).toHaveLength(2);
  });

  it('(d) self short-circuit path issues no network/direct reconcile call', async () => {
    installFetch(RECONCILE_ROUTE);

    // A self-conversation read has nothing to reconcile; it must return 0 without
    // touching the backend (no /chat/conversations/read, no /chat/unread/reconcile).
    const count = await chatService.markConversationAsRead(SENDER, SENDER);

    expect(count).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
