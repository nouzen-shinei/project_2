// Feature: chat-production-hardening (Task 12 — finding P3-1).
//
// The client true-unread recompute (`computeTrueUnreadCount`, exercised here via
// the no-backend `reconcileUnreadForUser` → `reconcileUnreadForUserDirect` path)
// must be robust to messages that LACK a `read` field entirely.
//
// `computeTrueUnreadCount` recounts unread via the indexed
// `orderByChild('read').equalTo(false)` query. RTDB `equalTo(false)` matches ONLY
// records whose `read` is exactly `false`; a record MISSING the `read` key is
// invisible to that index, so a legacy/foreign write would be UNDER-counted.
//
// The fix keeps the O(unread) `read == false` index as the primary path (all
// first-party writers force `read: false`, so it is exact in steady state) and,
// ONLY when the stored counter claims MORE unread than the `read` index found,
// falls back to the bounded `orderByChild('recipientId').equalTo(viewer)` index
// (also `.indexOn`) treating a missing `read` as unread. The fallback never does
// a full-history scan.
//
// This proves, against a functional in-memory Realtime Database that faithfully
// implements indexed `orderByChild(...).equalTo(...)` filtering (a record missing
// the ordered field is NOT matched by `equalTo`, exactly like Firebase) plus a
// get-log so reads can be asserted bounded:
//   (a) a message MISSING `read` (recipientId == viewer, not deleted) is counted
//       as unread;
//   (b) `read: true` and `deleted: true` records are still excluded;
//   (c) outgoing / other-recipient records are excluded;
//   (d) the recompute stays bounded — every conversationMessages read is an
//       indexed query (`read` or `recipientId`), never a full-node scan.

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`) with indexed
// query support + a get-log so tests can prove the read path is bounded.
// ---------------------------------------------------------------------------
jest.mock('firebase/database', () => {
  const store: Record<string, any> = {};

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

  const applyConstraints = (
    raw: any,
    constraints: any[]
  ): { value: any; bounded: boolean; orderByField: string | null; equalToValue: unknown } => {
    const orderBy = constraints.find((c) => c && c.__kind === 'orderByChild');
    const eq = constraints.find((c) => c && c.__kind === 'equalTo');
    if (orderBy && eq && raw && typeof raw === 'object') {
      const filtered: Record<string, any> = {};
      for (const [k, v] of Object.entries(raw)) {
        // Mirrors Firebase: a record MISSING the ordered field is `undefined`,
        // which never equals the `equalTo` value → excluded.
        if (v && typeof v === 'object' && (v as any)[orderBy.field] === eq.value) {
          filtered[k] = v;
        }
      }
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

// No chat backend configured → the direct (fallback) reconcile path is exercised.
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
const OTHER = 'third@example.com';

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
function seedSummary(userKey: string, partnerKey: string, record: Record<string, unknown>): void {
  const database = { __mockDatabase: true };
  const path = `tenantChat/${TENANT}/conversationSummaries/${userKey}/${partnerKey}`;
  void (rtdb as any).set((rtdb as any).ref(database, path), record);
}
function readSummary(userKey: string, partnerKey: string): any {
  const store = (rtdb as any).__getStore();
  return store?.tenantChat?.[TENANT]?.conversationSummaries?.[userKey]?.[partnerKey] ?? null;
}
function getLog(): Array<{
  path: string;
  hadConstraints: boolean;
  orderByField: string | null;
  equalToValue: unknown;
  returnedKeys: string[] | null;
}> {
  return (rtdb as any).__getGetLog();
}

function assertMessagesReadsBounded(conversationKey: string): void {
  const messagesGets = getLog().filter((e) => e.path === messagesPathOf(conversationKey));
  // At least the primary read==false query ran, and EVERY conversationMessages
  // read was an indexed query — never an unbounded full-node scan.
  expect(messagesGets.length).toBeGreaterThanOrEqual(1);
  expect(messagesGets.every((e) => e.hadConstraints)).toBe(true);
  expect(messagesGets.some((e) => e.orderByField === 'read' && e.equalToValue === false)).toBe(true);
}

describe('client true-unread robust to missing `read` (Task 12, P3-1)', () => {
  beforeEach(() => {
    (rtdb as any).__resetStore();
    jest.clearAllMocks();
    (chatService as any).__resetUnreadReconcileState?.();
  });

  it('(a) counts a message MISSING the `read` field (recipientId == viewer, not deleted) as unread', async () => {
    const key = conversationKeyOf(ME, THEM);
    const userKey = sanitizeEmailKey(ME);
    const partnerKey = sanitizeEmailKey(THEM);

    // Legacy/foreign write: NO `read` key. Invisible to the read==false index.
    seedMessage(key, '-legacy-noread', {
      id: '-legacy-noread',
      sender: THEM,
      recipientId: ME,
      conversationKey: key,
      delivered: false,
      // read: (absent)
    });
    // Stored counter claims 1 unread → hint (1) > read-index count (0) → fallback.
    seedSummary(userKey, partnerKey, {
      partnerEmail: THEM,
      tenantId: TENANT,
      unreadCount: 1,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    await chatService.reconcileUnreadForUser(ME, TENANT, { force: true });

    // The missing-read message is counted as unread → stored stays at 1 (NOT
    // wiped to 0, which is the unfixed under-count behavior).
    expect(readSummary(userKey, partnerKey).unreadCount).toBe(1);

    // (d) bounded — including the recipientId fallback that caught the record.
    assertMessagesReadsBounded(key);
    const recipientGets = getLog().filter(
      (e) => e.path === messagesPathOf(key) && e.orderByField === 'recipientId'
    );
    expect(recipientGets.length).toBeGreaterThanOrEqual(1);
    expect(recipientGets.every((e) => e.equalToValue === ME)).toBe(true);
  });

  it('(a2) reconciles a drifted counter DOWN to the true count using the missing-read-aware fallback', async () => {
    const key = conversationKeyOf(ME, THEM);
    const userKey = sanitizeEmailKey(ME);
    const partnerKey = sanitizeEmailKey(THEM);

    seedMessage(key, '-noread', { id: '-noread', sender: THEM, recipientId: ME, conversationKey: key });
    // Drifted high (5). Must converge to 1 (the single missing-read record), not 0 and not 5.
    seedSummary(userKey, partnerKey, {
      partnerEmail: THEM,
      tenantId: TENANT,
      unreadCount: 5,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    await chatService.reconcileUnreadForUser(ME, TENANT, { force: true });

    expect(readSummary(userKey, partnerKey).unreadCount).toBe(1);
    assertMessagesReadsBounded(key);
  });

  it('(b) still excludes `read: true` and `deleted: true` records through the fallback', async () => {
    const key = conversationKeyOf(ME, THEM);
    const userKey = sanitizeEmailKey(ME);
    const partnerKey = sanitizeEmailKey(THEM);

    seedMessage(key, '-noread', { id: '-noread', sender: THEM, recipientId: ME, conversationKey: key });
    seedMessage(key, '-alreadyread', {
      id: '-alreadyread',
      sender: THEM,
      recipientId: ME,
      conversationKey: key,
      read: true,
    });
    seedMessage(key, '-deleted', {
      id: '-deleted',
      sender: THEM,
      recipientId: ME,
      conversationKey: key,
      read: false,
      deleted: true,
    });
    seedSummary(userKey, partnerKey, {
      partnerEmail: THEM,
      tenantId: TENANT,
      unreadCount: 5,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    await chatService.reconcileUnreadForUser(ME, TENANT, { force: true });

    // Only the one missing-read message counts.
    expect(readSummary(userKey, partnerKey).unreadCount).toBe(1);
    assertMessagesReadsBounded(key);
  });

  it('(c) excludes outgoing and other-recipient records', async () => {
    const key = conversationKeyOf(ME, THEM);
    const userKey = sanitizeEmailKey(ME);
    const partnerKey = sanitizeEmailKey(THEM);

    seedMessage(key, '-incoming', { id: '-incoming', sender: THEM, recipientId: ME, conversationKey: key });
    // Outgoing (me -> them), missing read — must not count for me.
    seedMessage(key, '-outgoing', { id: '-outgoing', sender: ME, recipientId: THEM, conversationKey: key });
    // Addressed to a third party, missing read — must not count.
    seedMessage(key, '-tothird', { id: '-tothird', sender: THEM, recipientId: OTHER, conversationKey: key });
    seedSummary(userKey, partnerKey, {
      partnerEmail: THEM,
      tenantId: TENANT,
      unreadCount: 3,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    await chatService.reconcileUnreadForUser(ME, TENANT, { force: true });

    expect(readSummary(userKey, partnerKey).unreadCount).toBe(1);
    assertMessagesReadsBounded(key);
    // The recipientId fallback is scoped to the viewer, so it never returns the
    // outgoing / other-recipient records.
    const recipientGets = getLog().filter(
      (e) => e.path === messagesPathOf(key) && e.orderByField === 'recipientId'
    );
    expect(recipientGets.every((e) => e.equalToValue === ME)).toBe(true);
  });

  it('does NOT fire the recipientId fallback when the read index already matches the stored counter', async () => {
    const key = conversationKeyOf(ME, THEM);
    const userKey = sanitizeEmailKey(ME);
    const partnerKey = sanitizeEmailKey(THEM);

    // A well-formed unread record whose stored counter already agrees.
    seedMessage(key, '-proper', {
      id: '-proper',
      sender: THEM,
      recipientId: ME,
      conversationKey: key,
      read: false,
    });
    seedSummary(userKey, partnerKey, {
      partnerEmail: THEM,
      tenantId: TENANT,
      unreadCount: 1,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    await chatService.reconcileUnreadForUser(ME, TENANT, { force: true });

    expect(readSummary(userKey, partnerKey).unreadCount).toBe(1);
    // Primary read index used; recipientId fallback NOT needed (hot path O(unread)).
    const messagesGets = getLog().filter((e) => e.path === messagesPathOf(key));
    expect(messagesGets.some((e) => e.orderByField === 'read' && e.equalToValue === false)).toBe(true);
    expect(messagesGets.some((e) => e.orderByField === 'recipientId')).toBe(false);
    expect(messagesGets.every((e) => e.hadConstraints)).toBe(true);
  });
});
