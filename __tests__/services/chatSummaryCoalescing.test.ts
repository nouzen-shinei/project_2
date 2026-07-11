// Feature: chat-production-hardening — Task 9 (finding P2-1).
// Coalesce unread recompute and dedupe the two summary listeners.
//
// WHAT IS EXERCISED FOR REAL:
//   The REAL `chatService.onConversationSummariesChange` shared/multiplexed
//   subscription runs against a functional in-memory Realtime Database. Unlike
//   the preservation-property mocks, this mock's `onValue` REGISTERS the listener
//   (and fires once with the initial snapshot) so a test can drive a burst of
//   subsequent snapshots via `__emit(path)` and observe how the service coalesces
//   them. Attach/detach of the underlying listen are counted so the ref-counted
//   sharing between the two consumers (useUnreadChatCount + the chat screen) can
//   be asserted directly.
//
// These tests assert the four Task-9 guarantees:
//   (a) a burst of N summary changes triggers a SINGLE coalesced recompute pass;
//   (b) only the CHANGED conversation is recomputed (unchanged ones served from
//       the short-TTL cache, not re-queried);
//   (c) two consumers share ONE underlying subscription (ref-counted attach on
//       first consumer, detach only after the last consumer leaves);
//   (d) the badge count stays correct across coalesced updates (and self-
//       conversations never contribute).

import type { ConversationSummary } from '../../services/chatService';

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`) with a functional
// tree store AND a controllable `onValue` listener registry so tests can emit a
// burst of snapshots and count listen attach/detach.
// ---------------------------------------------------------------------------
jest.mock('firebase/database', () => {
  const store: Record<string, any> = {};
  const listeners = new Map<string, Set<(snap: any) => void>>();
  let attachCounts: Record<string, number> = {};
  let detachCounts: Record<string, number> = {};

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
    __resetListeners: () => {
      listeners.clear();
      attachCounts = {};
      detachCounts = {};
    },
    __writePath: (path: string, value: unknown) => writeNode(splitPath(path), clone(value)),
    __deletePath: (path: string) => writeNode(splitPath(path), undefined),
    __emit: (path: string) => {
      const set = listeners.get(path);
      if (!set) return;
      const key = splitPath(path).slice(-1)[0] ?? null;
      for (const l of Array.from(set)) {
        l(makeSnapshot(splitPath(path), key));
      }
    },
    __attachCount: (path: string) => attachCounts[path] || 0,
    __detachCount: (path: string) => detachCounts[path] || 0,
    ref: (_db: unknown, path = '') => makeRef(path),
    child: (parent: { path: string }, sub: string) => makeRef(`${parent.path}/${sub}`),
    push: (parent: { path: string }) => makeRef(`${parent.path}/-Mock${Math.random().toString(36).slice(2, 10)}`),
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
    // Registering listener: fire once with the current snapshot (mirrors the
    // firebase initial-value callback), and keep it registered for `__emit`.
    onValue: (r: { path: string; key: string | null }, listener: (snap: any) => void) => {
      const path = r.path;
      attachCounts[path] = (attachCounts[path] || 0) + 1;
      let set = listeners.get(path);
      if (!set) {
        set = new Set();
        listeners.set(path, set);
      }
      set.add(listener);
      listener(makeSnapshot(splitPath(path), r.key));
      return () => {
        set!.delete(listener);
      };
    },
    off: (r: { path: string }, _event?: string, listener?: (snap: any) => void) => {
      const path = r.path;
      detachCounts[path] = (detachCounts[path] || 0) + 1;
      const set = listeners.get(path);
      if (!set) return;
      if (listener) set.delete(listener);
      else set.clear();
    },
    onChildAdded: () => () => {},
    onChildChanged: () => () => {},
    runTransaction: async (r: { path: string; key: string | null }, fn: (current: any) => any) => {
      const segments = splitPath(r.path);
      const current = clone(readNode(segments));
      const next = fn(current);
      const committed = next !== undefined;
      if (committed) writeNode(segments, clone(next));
      return { committed, snapshot: makeSnapshot(segments, r.key) };
    },
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
  auth: { currentUser: { email: 'viewer@example.com', uid: 'uid-mock' } },
}));

jest.mock('firebase/storage', () => ({
  __esModule: true,
  ref: jest.fn(),
  deleteObject: jest.fn(),
}));

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

jest.mock('@/services/sharedFileService', () => ({
  __esModule: true,
  sharedFileService: {},
}));

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

jest.mock('@/services/chatRealtimeStream', () => ({
  __esModule: true,
  chatRealtimeStream: {},
}));

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
    getCurrentUser: () => ({ uid: 'uid-mock', email: 'viewer@example.com' }),
  },
}));

// ---------------------------------------------------------------------------
// Imports after mocks are registered.
// ---------------------------------------------------------------------------
import { chatService } from '../../services/chatService';
import * as rtdb from 'firebase/database';

const TENANT_ID = 'tenant-test';
const VIEWER = 'viewer@example.com';

const resetStore = (): void => (rtdb as any).__resetStore();
const resetListeners = (): void => (rtdb as any).__resetListeners();
const writePath = (path: string, value: unknown): void => (rtdb as any).__writePath(path, value);
const emit = (path: string): void => (rtdb as any).__emit(path);
const attachCount = (path: string): number => (rtdb as any).__attachCount(path);
const detachCount = (path: string): number => (rtdb as any).__detachCount(path);

// ---------------------------------------------------------------------------
// Key/path helpers — mirror chatService's own derivation so seeded data matches
// the exact RTDB paths the real code reads. NOT the code under test.
// ---------------------------------------------------------------------------
function normalizeEmail(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function sanitizeEmailKey(value?: string | null): string {
  return normalizeEmail(value).replace(/[.@]/g, '_');
}
function conversationKeyOf(a: string, b: string): string {
  return [sanitizeEmailKey(a), sanitizeEmailKey(b)].sort().join('__');
}
function summariesPath(viewer: string): string {
  return `tenantChat/${TENANT_ID}/conversationSummaries/${sanitizeEmailKey(viewer)}`;
}

interface SeededMessage {
  sender: string;
  recipientId: string;
  read: boolean;
  deleted?: boolean;
}

function seedSummary(viewer: string, partnerEmail: string, unreadCount: number, updatedAt = '2026-01-01T00:00:00.000Z'): void {
  writePath(`${summariesPath(viewer)}/${sanitizeEmailKey(partnerEmail)}`, {
    partnerEmail: normalizeEmail(partnerEmail),
    partnerId: null,
    partnerName: null,
    tenantId: TENANT_ID,
    unreadCount,
    updatedAt,
    lastMessage: {
      messageId: `m-${updatedAt}`,
      text: 'seed',
      timestamp: updatedAt,
      sender: normalizeEmail(partnerEmail),
      isOwnMessage: false,
      delivered: true,
      read: unreadCount === 0,
      type: 'text',
    },
  });
}

function seedMessages(conversationKey: string, messages: SeededMessage[]): void {
  messages.forEach((m, idx) => {
    writePath(`tenantChat/${TENANT_ID}/conversationMessages/${conversationKey}/-Seed_${conversationKey}_${idx}`, {
      conversationKey,
      sender: normalizeEmail(m.sender),
      recipientId: normalizeEmail(m.recipientId),
      read: m.read,
      deleted: m.deleted === true,
      text: 'seed',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });
}

/** Subscribe and collect every emitted record map, plus an unsubscribe. */
function subscribe(viewer: string): {
  emissions: Record<string, ConversationSummary>[];
  latest: () => Record<string, ConversationSummary> | undefined;
  unsubscribe: () => void;
} {
  const emissions: Record<string, ConversationSummary>[] = [];
  const unsubscribe = chatService.onConversationSummariesChange(
    viewer,
    (records) => {
      emissions.push(records);
    },
    TENANT_ID
  );
  return {
    emissions,
    latest: () => emissions[emissions.length - 1],
    unsubscribe,
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** Let pending microtasks (and the async recompute pass) settle. */
const settle = async (): Promise<void> => {
  await delay(5);
  await Promise.resolve();
};

/** Badge rule modelled exactly as useUnreadChatCount derives it. */
function badgeFromRecords(records: Record<string, ConversationSummary>, viewer: string): boolean {
  const v = normalizeEmail(viewer);
  return Object.values(records).some(
    (s) =>
      s?.tenantId?.trim() === TENANT_ID &&
      s.unreadCount > 0 &&
      normalizeEmail(s.partnerEmail) !== v
  );
}

describe('chat-production-hardening — Task 9: shared summaries subscription + coalesced recompute', () => {
  beforeEach(() => {
    resetStore();
    resetListeners();
    chatService.__resetSummarySubscriptionState();
  });

  afterEach(() => {
    chatService.__resetSummarySubscriptionState();
    jest.restoreAllMocks();
  });

  // (c) Two consumers share ONE underlying subscription (ref-counted).
  it('shares one underlying RTDB listen across two consumers and tears it down only after the last unsubscribes', async () => {
    seedSummary(VIEWER, 'alice@example.com', 1);
    seedMessages(conversationKeyOf(VIEWER, 'alice@example.com'), [
      { sender: 'alice@example.com', recipientId: VIEWER, read: false },
    ]);

    const path = summariesPath(VIEWER);

    // First consumer (e.g. the app-global badge hook).
    const badge = subscribe(VIEWER);
    // Second consumer (e.g. the chat screen).
    const screen = subscribe(VIEWER);
    await settle();

    // ONE underlying listen for two consumers.
    expect(attachCount(path)).toBe(1);
    const stats = chatService.__getSummarySubscriptionStats();
    expect(stats.activeSubscriptions).toBe(1);
    expect(stats.totalSubscribers).toBe(2);

    // Both consumers received the derived summaries.
    expect(badge.latest()).toBeDefined();
    expect(screen.latest()).toBeDefined();

    // First unsubscribe does NOT tear down the shared listen.
    badge.unsubscribe();
    expect(detachCount(path)).toBe(0);
    expect(chatService.__getSummarySubscriptionStats().activeSubscriptions).toBe(1);

    // Last unsubscribe tears it down exactly once.
    screen.unsubscribe();
    expect(detachCount(path)).toBe(1);
    expect(chatService.__getSummarySubscriptionStats().activeSubscriptions).toBe(0);
  });

  // (a) A burst of N summary changes collapses into a SINGLE recompute pass.
  it('coalesces a burst of N summary-node changes into a single recompute pass', async () => {
    chatService.__setSummaryCoalesceWindowMs(60);
    seedSummary(VIEWER, 'alice@example.com', 0);
    seedMessages(conversationKeyOf(VIEWER, 'alice@example.com'), [
      { sender: 'alice@example.com', recipientId: VIEWER, read: true },
    ]);

    const path = summariesPath(VIEWER);
    const sub = subscribe(VIEWER);
    await settle(); // let the initial leading-edge pass complete

    const passSpy = jest.spyOn(chatService as any, 'runSummaryRecomputePass');
    const baseline = passSpy.mock.calls.length;

    // Fire a burst of 8 changes within the coalesce window.
    for (let i = 0; i < 8; i++) {
      seedSummary(VIEWER, 'alice@example.com', 0, `2026-01-01T00:00:0${i}.000Z`);
      emit(path);
    }

    // Before the window elapses, no new pass has run yet.
    expect(passSpy.mock.calls.length - baseline).toBe(0);

    await delay(90); // window + margin
    await settle();

    // The entire burst collapsed into exactly ONE recompute pass.
    expect(passSpy.mock.calls.length - baseline).toBe(1);
    sub.unsubscribe();
  });

  // (b) Only the changed conversation is recomputed; unchanged ones use cache.
  it('recomputes only the changed conversation and serves unchanged ones from cache', async () => {
    chatService.__setSummaryUnreadCacheTtlMs(120000); // keep cache valid for the test
    chatService.__setSummaryCoalesceWindowMs(10);
    const partners = ['alice@example.com', 'bob@example.com', 'carol@example.com'];
    for (const p of partners) {
      seedSummary(VIEWER, p, 1);
      seedMessages(conversationKeyOf(VIEWER, p), [{ sender: p, recipientId: VIEWER, read: false }]);
    }

    const path = summariesPath(VIEWER);
    const computeSpy = jest.spyOn(chatService as any, 'computeTrueUnreadCount');

    const sub = subscribe(VIEWER);
    await settle();

    // First pass recomputes all three non-self conversations.
    expect(computeSpy).toHaveBeenCalledTimes(3);
    const afterFirst = computeSpy.mock.calls.length;

    // Change ONLY alice's conversation (a new unread message + summary bump).
    const aliceKey = conversationKeyOf(VIEWER, 'alice@example.com');
    seedMessages(aliceKey, [
      { sender: 'alice@example.com', recipientId: VIEWER, read: false },
      { sender: 'alice@example.com', recipientId: VIEWER, read: false },
    ]);
    seedSummary(VIEWER, 'alice@example.com', 2, '2026-02-02T00:00:00.000Z');
    emit(path);
    await delay(40);
    await settle();

    // Exactly ONE additional recompute — for alice only. Bob/carol served from cache.
    expect(computeSpy.mock.calls.length - afterFirst).toBe(1);
    const lastCall = computeSpy.mock.calls[computeSpy.mock.calls.length - 1];
    expect(lastCall[2]).toBe(aliceKey);

    // The recomputed value is correct (2 unread).
    expect(sub.latest()!['alice@example.com'].unreadCount).toBe(2);
    sub.unsubscribe();
  });

  // (d) The badge count stays correct across coalesced updates; self excluded.
  it('keeps the badge correct across coalesced updates and never lights from a self-conversation', async () => {
    // A real unread conversation, an already-read one, and a self-conversation.
    seedSummary(VIEWER, 'alice@example.com', 2);
    seedMessages(conversationKeyOf(VIEWER, 'alice@example.com'), [
      { sender: 'alice@example.com', recipientId: VIEWER, read: false },
      { sender: 'alice@example.com', recipientId: VIEWER, read: false },
    ]);
    seedSummary(VIEWER, 'bob@example.com', 0);
    seedMessages(conversationKeyOf(VIEWER, 'bob@example.com'), [
      { sender: 'bob@example.com', recipientId: VIEWER, read: true },
    ]);
    // Self-conversation with a stuck positive count — must contribute zero.
    seedSummary(VIEWER, VIEWER, 3);
    seedMessages(conversationKeyOf(VIEWER, VIEWER), [
      { sender: VIEWER, recipientId: VIEWER, read: false },
    ]);

    const path = summariesPath(VIEWER);
    const sub = subscribe(VIEWER);
    await settle();

    // Initially: alice has 2 real unread → badge ON; self contributes zero.
    let latest = sub.latest()!;
    expect(latest['alice@example.com'].unreadCount).toBe(2);
    expect(latest[VIEWER].unreadCount).toBe(0);
    expect(badgeFromRecords(latest, VIEWER)).toBe(true);

    // A burst: mark alice's messages read (true unread → 0) then several summary
    // pushes for the same change. Coalesced, the badge must converge to OFF.
    const aliceKey = conversationKeyOf(VIEWER, 'alice@example.com');
    seedMessages(aliceKey, [
      { sender: 'alice@example.com', recipientId: VIEWER, read: true },
      { sender: 'alice@example.com', recipientId: VIEWER, read: true },
    ]);
    for (let i = 0; i < 5; i++) {
      seedSummary(VIEWER, 'alice@example.com', 0, `2026-03-0${i + 1}T00:00:00.000Z`);
      emit(path);
    }
    await delay(90);
    await settle();

    latest = sub.latest()!;
    expect(latest['alice@example.com'].unreadCount).toBe(0);
    expect(latest[VIEWER].unreadCount).toBe(0);
    expect(badgeFromRecords(latest, VIEWER)).toBe(false);
    sub.unsubscribe();
  });
});
