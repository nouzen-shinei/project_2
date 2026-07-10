// Feature: stuck-message-delivery-fix
// Property 4 (Bug Condition) — Unread soundness excluding self-conversations.
//
// **Validates: Requirements 2.6, 2.8**
//
// EXPLORATION TEST (exploratory bugfix workflow):
//   This property-based test is written BEFORE the fix and is EXPECTED TO FAIL on
//   the current UNFIXED code. Its failure is the SUCCESS signal — it surfaces the
//   counterexample that proves the bug exists: the Messages-tab red dot lights
//   from a SELF-CONVERSATION summary (`partnerEmail == viewer`, identical
//   `conversationKey` halves, `unreadCount > 0`) that can never be opened or read,
//   even though NO non-self conversation has a real unread message. The badge is
//   therefore stuck on permanently — exactly the export state
//   `conversationSummaries/krvikrantsingh51_gmail_com/krvikrantsingh51_gmail_com`
//   (`unreadCount: 1`, `partnerEmail == viewer`) while both real conversations
//   (`…/invipika_gmail_com`, `…/vipulkr250_gmail_com`) report `unreadCount: 0`.
//
//   Do NOT "fix" this test or the production code to make it pass here. Once the
//   unread / self-conversation-exclusion fix lands (self-conversations excluded
//   from the badge/total/list + reconciliation of the stuck summary), this same
//   test will pass (fix checking, task 12.4).
//
// WHAT IS EXERCISED FOR REAL:
//   The REAL `chatService.onConversationSummariesChange` summary derivation runs
//   against a functional in-memory Realtime Database: it reads the seeded
//   `conversationSummaries/{viewerKey}/*` node, normalizes each record via
//   `normalizeConversationSummaryRecord`, and keys the result by `partnerEmail`
//   — with NO self-conversation exclusion, exactly as it does in production. Only
//   the transport (firebase/database), tenant/auth resolution, and unrelated
//   peripherals are mocked.
//
//   The badge rule under test is modelled exactly as `hooks/useUnreadChatCount.ts`
//   implements it: `hasUnread = Object.values(records).some(s =>
//   s.tenantId?.trim() === tenantId && s.unreadCount > 0)`. There is NO filtering
//   of self-conversations before deriving `hasUnread`, so a self-conversation
//   summary with `unreadCount > 0` lights the dot.
//
//   The CORRECT answer (Property 4) is computed independently from the durable
//   messages using the true-unread predicate — a real unread message is one with
//   `recipientId == viewer AND read == false AND deleted != true` that lives in a
//   NON-self conversation. Self-conversations contribute zero.
//
// THE INCIDENT (tenant CGnHGq43PFF8WD2DJekx):
//   The self-conversation `krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com`
//   holds the stuck self-addressed message `-OwLnPs_TYzsdesLA6gC` (`delivered:false`,
//   `read:false`) and a summary with `unreadCount: 1`. Because a self-conversation
//   is never openable, that count can never be marked read → the dot never clears.

import * as fc from 'fast-check';
import type { ConversationSummary } from '../../services/chatService';

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`).
// A functional tree store so the REAL chatService summary-derivation path
// (onConversationSummariesChange) actually reads records we seed. Everything is
// self-contained inside the factory (jest.mock hoisting rules), with
// __getStore / __resetStore / __writePath escape hatches. Unlike the send-path
// property tests, here `onValue` is a functional read that fires the listener
// synchronously with a snapshot of the node at the ref path.
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
    __writePath: (path: string, value: unknown) => writeNode(splitPath(path), clone(value)),
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
    // Functional listener: fire once synchronously with the current snapshot.
    onValue: (r: { path: string; key: string | null }, listener: (snap: any) => void) => {
      listener(makeSnapshot(splitPath(r.path), r.key));
      return () => {};
    },
    off: () => {},
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
// Peripheral mocks — everything chatService imports at module scope, so the real
// module loads cleanly in a node test environment without pulling native deps.
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

const getStore = (): Record<string, any> => (rtdb as any).__getStore();
const resetStore = (): void => (rtdb as any).__resetStore();
const writePath = (path: string, value: unknown): void => (rtdb as any).__writePath(path, value);

// ---------------------------------------------------------------------------
// Key helpers — mirror chatService's own derivation so the seeded store matches
// the exact RTDB paths the real code reads. These only build/interpret data;
// they are NOT the code under test.
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

function isSelfConversationKey(key: string): boolean {
  const halves = String(key).split('__').filter(Boolean);
  return halves.length === 2 && halves[0] === halves[1];
}

// ---------------------------------------------------------------------------
// Store seeding. Summaries live at
//   tenantChat/{tenantId}/conversationSummaries/{viewerKey}/{partnerKey}
// and durable messages at
//   tenantChat/{tenantId}/conversationMessages/{conversationKey}/{messageId}.
// ---------------------------------------------------------------------------
interface SeededMessage {
  sender: string;
  recipientId: string;
  read: boolean;
  deleted?: boolean;
}

function seedSummary(viewer: string, partnerEmail: string, unreadCount: number): void {
  const viewerKey = sanitizeEmailKey(viewer);
  const partnerKey = sanitizeEmailKey(partnerEmail);
  writePath(
    `tenantChat/${TENANT_ID}/conversationSummaries/${viewerKey}/${partnerKey}`,
    {
      partnerEmail: normalizeEmail(partnerEmail),
      partnerId: null,
      partnerName: null,
      tenantId: TENANT_ID,
      unreadCount,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  );
}

function seedMessages(conversationKey: string, messages: SeededMessage[]): void {
  messages.forEach((m, idx) => {
    writePath(
      `tenantChat/${TENANT_ID}/conversationMessages/${conversationKey}/-Seed_${conversationKey}_${idx}`,
      {
        conversationKey,
        sender: normalizeEmail(m.sender),
        recipientId: normalizeEmail(m.recipientId),
        read: m.read,
        deleted: m.deleted === true,
        text: 'seed',
        timestamp: '2026-01-01T00:00:00.000Z',
      }
    );
  });
}

interface DurableRecord {
  conversationKey: string;
  sender?: string;
  recipientId?: string;
  read?: boolean;
  deleted?: boolean;
}

function collectDurableMessages(store: Record<string, any>): DurableRecord[] {
  const out: DurableRecord[] = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const conversations = tenants[tenantId]?.conversationMessages ?? {};
    for (const convKey of Object.keys(conversations)) {
      const messages = conversations[convKey] ?? {};
      for (const messageId of Object.keys(messages)) {
        const record = messages[messageId];
        if (record && typeof record === 'object') {
          out.push({ conversationKey: convKey, ...(record as Record<string, unknown>) });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The SYSTEM UNDER TEST for the badge is the composition of:
//   (1) chatService.onConversationSummariesChange — REAL summary derivation.
//   (2) the useUnreadChatCount badge rule — modelled exactly (see below).
// ---------------------------------------------------------------------------

/** Drive the REAL summary derivation and return the summaries keyed by partnerEmail. */
function readSummariesViaService(viewer: string): Promise<Record<string, ConversationSummary>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('summaries listener never fired')), 2000);
    const unsubscribe = chatService.onConversationSummariesChange(
      viewer,
      (records) => {
        clearTimeout(timer);
        resolve(records);
        // one-shot: detach after first emission
        try {
          unsubscribe();
        } catch {}
      },
      TENANT_ID
    );
  });
}

/**
 * The badge rule EXACTLY as `hooks/useUnreadChatCount.ts` derives it: any summary
 * for this tenant with `unreadCount > 0` lights the dot. There is NO exclusion of
 * self-conversations — this is the unfixed behavior under test.
 */
function deriveBadgeLikeHook(records: Record<string, ConversationSummary>): boolean {
  const trimmedTenantId = TENANT_ID.trim();
  return Object.values(records).some(
    (summary) => summary?.tenantId?.trim() === trimmedTenantId && summary.unreadCount > 0
  );
}

/**
 * The CORRECT badge per Property 4: true iff there EXISTS a NON-self conversation
 * with a real unread message for the viewer (`recipientId == viewer AND
 * read == false AND deleted != true`). Self-conversations contribute zero.
 * Computed independently from the durable messages, not from stored summaries.
 */
function trueBadgeFromMessages(store: Record<string, any>, viewer: string): boolean {
  const v = normalizeEmail(viewer);
  const byConversation = new Map<string, DurableRecord[]>();
  for (const m of collectDurableMessages(store)) {
    const list = byConversation.get(m.conversationKey) ?? [];
    list.push(m);
    byConversation.set(m.conversationKey, list);
  }

  for (const [convKey, messages] of byConversation) {
    // Self-conversation exclusion (identical key halves OR any sender == recipient).
    const isSelf =
      isSelfConversationKey(convKey) ||
      messages.some((m) => normalizeEmail(m.sender) === normalizeEmail(m.recipientId));
    if (isSelf) continue;

    const hasRealUnread = messages.some(
      (m) => normalizeEmail(m.recipientId) === v && m.read === false && m.deleted !== true
    );
    if (hasRealUnread) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Property 4 — Bug Condition
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 4 (Bug Condition): unread soundness excluding self-conversations', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  // Anchored to the confirmed incident before generalizing.
  it('ANCHOR (incident): the Messages-tab dot lights from a self-conversation with no non-self real unread', async () => {
    const viewer = 'krvikrantsingh51@gmail.com';
    const partnerA = 'invipika@gmail.com';
    const partnerB = 'vipulkr250@gmail.com';

    // Self-conversation summary from the export: partnerEmail == viewer, unreadCount 1.
    seedSummary(viewer, viewer, 1);
    // Both real conversations report unreadCount 0 (as in the export).
    seedSummary(viewer, partnerA, 0);
    seedSummary(viewer, partnerB, 0);

    // Durable messages: the stuck self-addressed message (sender == recipient == viewer,
    // read:false) lives in the self conversation; the real conversations have only
    // already-read messages, so there is NO non-self real unread.
    seedMessages(conversationKeyOf(viewer, viewer), [
      { sender: viewer, recipientId: viewer, read: false, deleted: false },
    ]);
    seedMessages(conversationKeyOf(viewer, partnerA), [
      { sender: partnerA, recipientId: viewer, read: true, deleted: false },
    ]);
    seedMessages(conversationKeyOf(viewer, partnerB), [
      { sender: partnerB, recipientId: viewer, read: true, deleted: false },
    ]);

    const records = await readSummariesViaService(viewer);
    const badgeOn = deriveBadgeLikeHook(records);
    const expectedBadge = trueBadgeFromMessages(getStore(), viewer);

    // The correct badge is OFF — no non-self conversation has a real unread message.
    expect(expectedBadge).toBe(false);

    // Property 4: badgeOn SHALL equal the true (non-self) unread existence.
    // On UNFIXED code this fails — the self-conversation summary (unreadCount 1)
    // lights the dot, so badgeOn === true !== expectedBadge (false).
    expect(badgeOn).toBe(expectedBadge);
  });

  // Generalized property over random summary sets containing self-conversations.
  it('for any viewer, badgeOn holds iff a non-self conversation has a real unread message (self-conversations contribute zero)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        // At least one self-conversation with a positive stored unread count — the
        // phantom-dot source. `unreadCount` cannot be marked read (self is unopenable).
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 1, maxLength: 2 }),
        // Non-self conversations, each with an honest true-unread count (stored
        // count kept consistent with real unread messages — the desync case is a
        // separate property).
        fc.array(
          fc.record({
            partner: fc.emailAddress(),
            realUnread: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 0, maxLength: 3 }
        ),
        async (viewer, selfUnreadCounts, nonSelfSpecs) => {
          // Non-self partners must be genuinely distinct from the viewer and each other.
          const v = normalizeEmail(viewer);
          const seenPartners = new Set<string>();
          const partners = nonSelfSpecs.filter((spec) => {
            const p = normalizeEmail(spec.partner);
            if (!p || p === v || seenPartners.has(p)) return false;
            seenPartners.add(p);
            return true;
          });

          resetStore();

          // Self-conversation summary + message (identical key halves, sender == recipient).
          // The stored self summary uses the largest generated count.
          const selfUnread = Math.max(...selfUnreadCounts);
          seedSummary(viewer, viewer, selfUnread);
          seedMessages(conversationKeyOf(viewer, viewer), [
            { sender: viewer, recipientId: viewer, read: false, deleted: false },
          ]);

          // Non-self conversations: stored unread count == number of real unread messages.
          for (const spec of partners) {
            const convKey = conversationKeyOf(viewer, spec.partner);
            seedSummary(viewer, spec.partner, spec.realUnread);
            const messages: SeededMessage[] = [];
            for (let i = 0; i < spec.realUnread; i++) {
              messages.push({ sender: spec.partner, recipientId: viewer, read: false, deleted: false });
            }
            // Always include one already-read message so the conversation exists even at count 0.
            messages.push({ sender: spec.partner, recipientId: viewer, read: true, deleted: false });
            seedMessages(convKey, messages);
          }

          const records = await readSummariesViaService(viewer);
          const badgeOn = deriveBadgeLikeHook(records);
          const expectedBadge = trueBadgeFromMessages(getStore(), viewer);

          // Property 4: the derived badge must equal the true non-self unread existence.
          // UNFIXED code violates this whenever a self-conversation has unreadCount > 0
          // and no non-self conversation has a real unread message.
          expect(badgeOn).toBe(expectedBadge);
        }
      ),
      { numRuns: 50 }
    );
  });
});
