// Feature: chat-production-hardening (Task 4 — Confirm "Sent" from an
// authoritative record check, not loaded-page presence; finding P1-2).
//
// Unit tests for `chatService.messageExistsById` — the cheap, keyed authoritative
// existence check the outbox self-heal driver consults BEFORE dead-lettering an
// exhausted send. It must return true only when a live durable record exists for
// the intended (non-self) recipient, so an exhausted-but-persisted item is
// confirmed instead of flipped to a misleading `failed`, while a truly-absent
// item still fails.
//
// The real `chatService.messageExistsById` runs against a functional in-memory
// Realtime Database; only the transport and tenant/auth resolution are mocked
// (same scaffolding as the stuck-message-delivery property tests).

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
    cur[segments[segments.length - 1]] = value;
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

jest.mock('@/services/runtimeEndpoints', () => ({
  __esModule: true,
  runtimeEndpoints: {
    getSnapshot: jest.fn(() => ({})),
    getPreferredBackendBaseUrl: jest.fn(() => undefined),
  },
}));

jest.mock('@/services/tenantService', () => ({
  __esModule: true,
  tenantService: {
    getCachedSelectedTenant: jest.fn(async () => 'tenant-test'),
    getCachedMemberships: jest.fn(async () => []),
    getMembershipsForUser: jest.fn(async () => []),
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

function sanitizeEmailKey(value: string): string {
  return value.trim().toLowerCase().replace(/[.@]/g, '_');
}

function conversationKeyOf(a: string, b: string): string {
  return [sanitizeEmailKey(a), sanitizeEmailKey(b)].sort().join('__');
}

/** Seed a durable message record directly into the in-memory store. */
function seedMessage(
  tenantId: string,
  conversationKey: string,
  messageId: string,
  record: Record<string, unknown>
): void {
  const database = { __mockDatabase: true };
  const path = `tenantChat/${tenantId}/conversationMessages/${conversationKey}/${messageId}`;
  void (rtdb as any).set((rtdb as any).ref(database, path), record);
}

const SENDER = 'krvikrantsingh51@gmail.com';
const RECIPIENT = 'invipika@gmail.com';
const MESSAGE_ID = '-OwLnPs_TYzsdesLA6gC';

describe('chatService.messageExistsById — authoritative record check (P1-2)', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('returns true for a live durable record addressed to the intended recipient', async () => {
    const key = conversationKeyOf(SENDER, RECIPIENT);
    seedMessage('tenant-test', key, MESSAGE_ID, {
      id: MESSAGE_ID,
      sender: SENDER,
      recipientId: RECIPIENT,
      conversationKey: key,
      text: 'hgghdsghs',
      delivered: false,
      read: false,
    });

    await expect(
      chatService.messageExistsById(SENDER, RECIPIENT, MESSAGE_ID)
    ).resolves.toBe(true);
  });

  it('returns false when no record exists (truly-absent → still dead-letters)', async () => {
    await expect(
      chatService.messageExistsById(SENDER, RECIPIENT, '-does-not-exist')
    ).resolves.toBe(false);
  });

  it('returns false for a soft-deleted record', async () => {
    const key = conversationKeyOf(SENDER, RECIPIENT);
    seedMessage('tenant-test', key, MESSAGE_ID, {
      id: MESSAGE_ID,
      sender: SENDER,
      recipientId: RECIPIENT,
      conversationKey: key,
      text: 'gone',
      deleted: true,
    });

    await expect(
      chatService.messageExistsById(SENDER, RECIPIENT, MESSAGE_ID)
    ).resolves.toBe(false);
  });

  it('returns false when the stored record targets a different recipient', async () => {
    const key = conversationKeyOf(SENDER, RECIPIENT);
    seedMessage('tenant-test', key, MESSAGE_ID, {
      id: MESSAGE_ID,
      sender: SENDER,
      recipientId: 'someoneelse@example.com',
      conversationKey: key,
      text: 'mismatch',
    });

    await expect(
      chatService.messageExistsById(SENDER, RECIPIENT, MESSAGE_ID)
    ).resolves.toBe(false);
  });

  it('returns false for a self-addressed lookup (never a delivered state)', async () => {
    await expect(
      chatService.messageExistsById(SENDER, SENDER, MESSAGE_ID)
    ).resolves.toBe(false);
  });

  it('returns false for empty inputs', async () => {
    await expect(chatService.messageExistsById('', RECIPIENT, MESSAGE_ID)).resolves.toBe(false);
    await expect(chatService.messageExistsById(SENDER, '', MESSAGE_ID)).resolves.toBe(false);
    await expect(chatService.messageExistsById(SENDER, RECIPIENT, '')).resolves.toBe(false);
  });
});
