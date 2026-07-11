// Feature: chat-production-hardening (Task 10 — finding P2-2).
//
// The CLIENT no-backend fallback `chatService.markConversationAsRead(...)` →
// `markConversationAsReadDirect(...)` must:
//   (a) mark ONLY genuinely-unread incoming messages read (not outgoing, not
//       already-read, not deleted);
//   (b) build the read-receipt patch from a BOUNDED indexed query over the
//       `read == false` set (`orderByChild('read').equalTo(false)`) rather than
//       downloading + scanning the whole conversation history;
//   (c) refresh the summary/unread counter from the BOUNDED reconcile (which
//       reads only the summaries node + a bounded per-conversation unread query)
//       and NEVER from the full-history `rebuildConversationSummariesForUser`
//       (which reads `userConversations/{user}` + every conversation's whole
//       message node) on this hot path; and
//   (d) be idempotent — a re-run after everything is read is a no-op.
//
// The real chatService runs against a functional in-memory Realtime Database
// that faithfully implements indexed `orderByChild(...).equalTo(...)` filtering
// (so a bounded query returns ONLY the matching subset, exactly like Firebase)
// and correct multi-path `update({ 'a/b': v })` semantics. Only the transport,
// token manager, and tenant/auth resolution are mocked. No chat backend is
// configured, so the direct fallback path is exercised.

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`) with indexed
// query support + a get-log so tests can prove the read path is bounded.
// ---------------------------------------------------------------------------
jest.mock('firebase/database', () => {
  const store: Record<string, any> = {};

  // Log of every `get(...)` so tests can assert which paths were read and
  // whether the read was bounded (query constraints) or a full-node scan.
  const getLog: Array<{
    path: string;
    hadConstraints: boolean;
    orderByField: string | null;
    equalToValue: unknown;
    returnedKeys: string[] | null;
  }> = [];

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
    return {
      __ref: true as const,
      path,
      key: segments.length ? segments[segments.length - 1] : null,
      __constraints: [] as any[],
    };
  };

  // A value-based snapshot: iterating `forEach` walks ONLY the (possibly
  // filtered) value it was created with, mirroring how a Firebase query
  // snapshot exposes only the matching children.
  const makeSnapshotFromValue = (value: any, key: string | null): any => ({
    exists: () => value !== undefined && value !== null,
    val: () => clone(value),
    key,
    forEach: (cb: (child: any) => boolean | void) => {
      if (value && typeof value === 'object') {
        for (const childKey of Object.keys(value)) {
          const stop = cb(makeSnapshotFromValue(value[childKey], childKey));
          if (stop === true) return true;
        }
      }
      return false;
    },
  });

  const applyConstraints = (raw: any, constraints: any[]): { value: any; bounded: boolean; orderByField: string | null; equalToValue: unknown } => {
    const orderBy = constraints.find((c) => c && c.__kind === 'orderByChild');
    const eq = constraints.find((c) => c && c.__kind === 'equalTo');
    if (orderBy && eq && raw && typeof raw === 'object') {
      const filtered: Record<string, any> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === 'object' && (v as any)[orderBy.field] === eq.value) {
          filtered[k] = v;
        }
      }
      // A query with no matching children yields a non-existent snapshot.
      const value = Object.keys(filtered).length > 0 ? filtered : null;
      return { value, bounded: true, orderByField: orderBy.field, equalToValue: eq.value };
    }
    return { value: raw, bounded: false, orderByField: null, equalToValue: undefined };
  };

  return {
    __esModule: true,
    __getStore: () => store,
    __resetStore: () => {
      for (const k of Object.keys(store)) delete store[k];
      getLog.length = 0;
    },
    __getGetLog: () => getLog.map((e) => ({ ...e, returnedKeys: e.returnedKeys ? [...e.returnedKeys] : null })),
    ref: (_db: unknown, path = '') => makeRef(path),
    child: (parent: { path: string }, sub: string) => makeRef(`${parent.path}/${sub}`),
    push: (parent: { path: string }) => makeRef(`${parent.path}/-Mock${Math.random().toString(36).slice(2, 8)}`),
    set: async (r: { path: string }, value: unknown) => {
      writeNode(splitPath(r.path), clone(value));
    },
    // Correct Firebase multi-path update: each key is a path RELATIVE to `ref`.
    update: async (r: { path: string }, patch: Record<string, unknown>) => {
      const baseSegments = splitPath(r.path);
      for (const [k, v] of Object.entries(patch)) {
        writeNode([...baseSegments, ...splitPath(k)], clone(v));
      }
    },
    get: async (r: { path: string; key: string | null; __constraints?: any[] }) => {
      const segments = splitPath(r.path);
      const raw = readNode(segments);
      const { value, bounded, orderByField, equalToValue } = applyConstraints(raw, r.__constraints ?? []);
      getLog.push({
        path: r.path,
        hadConstraints: bounded,
        orderByField,
        equalToValue,
        returnedKeys: value && typeof value === 'object' ? Object.keys(value) : null,
      });
      return makeSnapshotFromValue(value, r.key);
    },
    runTransaction: async (r: { path: string; key: string | null }, fn: (current: any) => any) => {
      const segments = splitPath(r.path);
      const current = clone(readNode(segments));
      const next = fn(current);
      const committed = next !== undefined;
      if (committed) writeNode(segments, clone(next));
      return { committed, snapshot: makeSnapshotFromValue(readNode(segments), r.key) };
    },
    onValue: () => () => {},
    onChildAdded: () => () => {},
    onChildChanged: () => () => {},
    off: () => {},
    // `query(ref, ...constraints)` accumulates constraints onto a ref-like object.
    query: (base: any, ...constraints: any[]) => ({
      ...base,
      __query: true,
      __constraints: [...(base.__constraints ?? []), ...constraints],
    }),
    orderByChild: (field: string) => ({ __kind: 'orderByChild', field }),
    equalTo: (value: unknown) => ({ __kind: 'equalTo', value }),
    endAt: () => ({ __kind: 'endAt' }),
    limitToLast: () => ({ __kind: 'limitToLast' }),
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

// No chat backend configured → the direct (fallback) path is exercised.
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

const TENANT = 'tenant-test';
const ME = 'sender@example.com';
const THEM = 'partner@example.com';

function sanitizeEmailKey(value: string): string {
  return value.trim().toLowerCase().replace(/[.@]/g, '_');
}
function conversationKeyOf(a: string, b: string): string {
  return [sanitizeEmailKey(a), sanitizeEmailKey(b)].sort().join('__');
}
function messagesPathOf(conversationKey: string): string {
  return `tenantChat/${TENANT}/conversationMessages/${conversationKey}`;
}
function seedMessage(conversationKey: string, messageId: string, record: Record<string, unknown>): void {
  const database = { __mockDatabase: true };
  const path = `${messagesPathOf(conversationKey)}/${messageId}`;
  void (rtdb as any).set((rtdb as any).ref(database, path), record);
}
function readMessage(conversationKey: string, messageId: string): any {
  const store = (rtdb as any).__getStore();
  return store?.tenantChat?.[TENANT]?.conversationMessages?.[conversationKey]?.[messageId] ?? null;
}
function seedSummary(userKey: string, partnerKey: string, record: Record<string, unknown>): void {
  const database = { __mockDatabase: true };
  const path = `tenantChat/${TENANT}/conversationSummaries/${userKey}/${partnerKey}`;
  void (rtdb as any).set((rtdb as any).ref(database, path), record);
}
function readSummary(userKey: string, partnerKey: string): any {
  const store = (rtdb as any).__getStore();
  return store?.tenantChat?.[TENANT]?.conversationSummaries?.[userKey]?.[partnerKey] ?? null;
}
function getLog(): Array<{ path: string; hadConstraints: boolean; orderByField: string | null; equalToValue: unknown; returnedKeys: string[] | null }> {
  return (rtdb as any).__getGetLog();
}

describe('markConversationAsRead direct fallback — bounded read + bounded summary refresh (Task 10, P2-2)', () => {
  beforeEach(() => {
    (rtdb as any).__resetStore();
    jest.clearAllMocks();
    // The reconcile dispatcher carries a throttle/in-flight guard on the shared
    // singleton; reset it so each test starts clean.
    (chatService as any).__resetUnreadReconcileState?.();
  });

  it('(a) marks ONLY genuinely-unread incoming messages read — not outgoing, already-read, or deleted', async () => {
    const key = conversationKeyOf(ME, THEM);

    seedMessage(key, '-unread-incoming', {
      id: '-unread-incoming',
      sender: THEM,
      recipientId: ME,
      conversationKey: key,
      read: false,
      delivered: false,
    });
    seedMessage(key, '-outgoing', {
      id: '-outgoing',
      sender: ME,
      recipientId: THEM,
      conversationKey: key,
      read: false,
      delivered: true,
    });
    seedMessage(key, '-already-read-incoming', {
      id: '-already-read-incoming',
      sender: THEM,
      recipientId: ME,
      conversationKey: key,
      read: true,
      readAt: '2020-01-01T00:00:00.000Z',
      delivered: true,
    });
    seedMessage(key, '-deleted-incoming', {
      id: '-deleted-incoming',
      sender: THEM,
      recipientId: ME,
      conversationKey: key,
      read: false,
      delivered: false,
      deleted: true,
    });

    const count = await chatService.markConversationAsRead(ME, THEM);

    // Exactly the one genuinely-unread incoming message is marked.
    expect(count).toBe(1);

    const unreadIncoming = readMessage(key, '-unread-incoming');
    expect(unreadIncoming.read).toBe(true);
    expect(typeof unreadIncoming.readAt).toBe('string');
    expect(unreadIncoming.delivered).toBe(true);
    expect(typeof unreadIncoming.deliveredAt).toBe('string');

    // Outgoing message left untouched (still read:false — a read receipt on an
    // outgoing message would be a forged receipt).
    expect(readMessage(key, '-outgoing').read).toBe(false);

    // Already-read incoming untouched (its original readAt is preserved).
    const alreadyRead = readMessage(key, '-already-read-incoming');
    expect(alreadyRead.read).toBe(true);
    expect(alreadyRead.readAt).toBe('2020-01-01T00:00:00.000Z');

    // Deleted incoming untouched.
    expect(readMessage(key, '-deleted-incoming').read).toBe(false);
  });

  it('(b) reads the unread set via the bounded read==false query and never scans the whole history', async () => {
    const key = conversationKeyOf(ME, THEM);

    // A large already-read history that a full scan would download in full.
    const TOTAL_READ = 50;
    for (let i = 0; i < TOTAL_READ; i++) {
      seedMessage(key, `-old-${i}`, {
        id: `-old-${i}`,
        sender: i % 2 === 0 ? THEM : ME,
        recipientId: i % 2 === 0 ? ME : THEM,
        conversationKey: key,
        read: true,
        readAt: '2020-01-01T00:00:00.000Z',
        delivered: true,
      });
    }
    // Two genuinely-unread incoming + one outgoing (read:false but not incoming).
    seedMessage(key, '-unread-a', { id: '-unread-a', sender: THEM, recipientId: ME, conversationKey: key, read: false, delivered: false });
    seedMessage(key, '-unread-b', { id: '-unread-b', sender: THEM, recipientId: ME, conversationKey: key, read: false, delivered: false });
    seedMessage(key, '-outgoing-unread', { id: '-outgoing-unread', sender: ME, recipientId: THEM, conversationKey: key, read: false, delivered: true });

    const totalMessages = TOTAL_READ + 3;

    const count = await chatService.markConversationAsRead(ME, THEM);

    // Only the two incoming unread messages are marked (the outgoing one is
    // returned by the read==false index but filtered out by the re-check).
    expect(count).toBe(2);

    const messagesPath = messagesPathOf(key);
    const messagesGets = getLog().filter((e) => e.path === messagesPath);

    // The conversation-messages node was read at least once (patch build +
    // bounded reconcile recompute), and EVERY such read was bounded by the
    // `read == false` index — never an unbounded full-node scan.
    expect(messagesGets.length).toBeGreaterThanOrEqual(1);
    expect(
      messagesGets.every((e) => e.hadConstraints && e.orderByField === 'read' && e.equalToValue === false)
    ).toBe(true);

    // The bounded query used to build the patch returned only the read==false
    // subset (2 incoming + 1 outgoing = 3), NOT the entire 53-message history.
    const patchBuildGet = messagesGets[0];
    expect(patchBuildGet.returnedKeys).not.toBeNull();
    expect(patchBuildGet.returnedKeys!.length).toBe(3);
    expect(patchBuildGet.returnedKeys!.length).toBeLessThan(totalMessages);
    // None of the already-read history was ever returned to the client.
    expect(patchBuildGet.returnedKeys!.some((k) => k.startsWith('-old-'))).toBe(false);
  });

  it('(c) converges the stored unread counter via the bounded reconcile without a full rebuild', async () => {
    const key = conversationKeyOf(ME, THEM);
    const userKey = sanitizeEmailKey(ME);
    const partnerKey = sanitizeEmailKey(THEM);

    // Two genuinely-unread incoming messages.
    seedMessage(key, '-u1', { id: '-u1', sender: THEM, recipientId: ME, conversationKey: key, read: false, delivered: false });
    seedMessage(key, '-u2', { id: '-u2', sender: THEM, recipientId: ME, conversationKey: key, read: false, delivered: false });

    // A stored summary whose unreadCount has drifted high (e.g. 5).
    seedSummary(userKey, partnerKey, {
      partnerEmail: THEM,
      tenantId: TENANT,
      unreadCount: 5,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const count = await chatService.markConversationAsRead(ME, THEM);
    expect(count).toBe(2);

    // After marking both messages read, the true unread is 0, so the reconcile
    // converges the stored counter exactly.
    expect(readSummary(userKey, partnerKey).unreadCount).toBe(0);

    // Proof the full rebuild did NOT run on this hot path: only the full
    // `rebuildConversationSummariesForUser` reads `userConversations/{user}` and
    // per-conversation `conversationLatest`. The bounded reconcile reads only the
    // summaries node + the bounded per-conversation unread query.
    const paths = getLog().map((e) => e.path);
    expect(paths).not.toContain(`tenantChat/${TENANT}/userConversations/${userKey}`);
    expect(paths.some((p) => p.startsWith(`tenantChat/${TENANT}/conversationLatest/`))).toBe(false);
    // And every conversation-messages read was bounded (no full-history scan).
    const messagesGets = getLog().filter((e) => e.path === messagesPathOf(key));
    expect(messagesGets.every((e) => e.hadConstraints)).toBe(true);
  });

  it('(d) is idempotent — a re-run after everything is read is a no-op', async () => {
    const key = conversationKeyOf(ME, THEM);
    const userKey = sanitizeEmailKey(ME);
    const partnerKey = sanitizeEmailKey(THEM);

    seedMessage(key, '-u1', { id: '-u1', sender: THEM, recipientId: ME, conversationKey: key, read: false, delivered: false });
    seedMessage(key, '-outgoing', { id: '-outgoing', sender: ME, recipientId: THEM, conversationKey: key, read: false, delivered: true });
    seedSummary(userKey, partnerKey, {
      partnerEmail: THEM,
      tenantId: TENANT,
      unreadCount: 1,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    const first = await chatService.markConversationAsRead(ME, THEM);
    expect(first).toBe(1);
    const readAtAfterFirst = readMessage(key, '-u1').readAt;
    expect(typeof readAtAfterFirst).toBe('string');
    expect(readSummary(userKey, partnerKey).unreadCount).toBe(0);

    // Re-run: nothing left unread → returns 0 and mutates nothing.
    const second = await chatService.markConversationAsRead(ME, THEM);
    expect(second).toBe(0);

    // The previously-read message's receipt timestamp is untouched (not
    // re-stamped) and the outgoing message is still never marked read.
    expect(readMessage(key, '-u1').readAt).toBe(readAtAfterFirst);
    expect(readMessage(key, '-outgoing').read).toBe(false);
    expect(readSummary(userKey, partnerKey).unreadCount).toBe(0);
  });
});
