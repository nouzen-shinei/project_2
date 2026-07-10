// Feature: stuck-message-delivery-fix
// Property 5 (Bug Condition) — Self-conversation cleanup converges and is idempotent.
//
// **Validates: Requirements 2.7, 2.8**
//
// EXPLORATION TEST (exploratory bugfix workflow):
//   This property-based test is written BEFORE the fix and is EXPECTED TO FAIL on
//   the current UNFIXED code. Its failure is the SUCCESS signal — it surfaces the
//   counterexample that proves the bug exists: there is NO reconciliation on the
//   live path that drives a pre-existing SELF-CONVERSATION summary's contribution
//   to zero, so the stuck Messages-tab red dot never clears. The self-conversation
//   summary (`partnerEmail == viewer`, self `conversationKey`, `unreadCount > 0`)
//   can never be opened/read, and the only live reconciliation
//   (`reconcileConversationUnreadCount`) is wired exclusively to the conversation
//   the user currently has OPEN and focused — which the self-conversation can never
//   be. A foreground resume / summary reload only re-reads the stored counts
//   verbatim (no true-unread recompute), so the phantom count survives forever.
//
//   Do NOT "fix" this test or the production code to make it pass here. Once the
//   unread / self-conversation cleanup fix lands (self-conversation exclusion +
//   a one-time/triggered reconciliation that zeroes/removes the stuck self summary
//   + general true-unread reconciliation), this same test will pass (fix checking,
//   task 12.5).
//
// WHAT IS EXERCISED FOR REAL:
//   The live-path reconciliation is composed from the REAL production functions,
//   driven exactly as `app/(tabs)/chat.tsx` wires them:
//     - `chatService.onConversationSummariesChange` (services/chatService.ts) —
//       REAL summary derivation. It reads the seeded
//       `conversationSummaries/{viewerKey}/*` node from a functional in-memory
//       Realtime Database and returns each stored `unreadCount` VERBATIM, keyed by
//       `partnerEmail`, with NO self-conversation exclusion and NO true-unread
//       recompute. This models the foreground-resume / summary-load refresh.
//     - `shouldRefreshChatSummariesOnForegroundResume` (lib/chatReceiptState.ts) —
//       REAL gate deciding whether a foreground resume refreshes summaries.
//     - `reconcileConversationUnreadCount` (lib/chatReceiptState.ts) — REAL
//       reconciliation, the ONLY live mechanism that reduces a stored unread count.
//       It only mutates the entry for the conversation currently open+focused
//       (`isFocused && isAppActive`), exactly as chat.tsx invokes it with
//       `effectiveIncomingUnreadCount = isFocused && isAppActive ? 0 : incoming`.
//   The badge rule under test is modelled exactly as `hooks/useUnreadChatCount.ts`
//   derives it: any tenant-scoped summary with `unreadCount > 0` lights the dot.
//
//   The CORRECT answer (Property 5) is that after reconciliation runs, every
//   self-conversation's stored contribution is driven to zero and re-running is
//   idempotent, so the badge reflects only real, NON-self unread. The true unread
//   is computed independently from the durable messages
//   (`recipientId == viewer AND read == false AND deleted != true`, self excluded).
//
// THE INCIDENT (tenant CGnHGq43PFF8WD2DJekx):
//   `conversationSummaries/krvikrantsingh51_gmail_com/krvikrantsingh51_gmail_com`
//   has `unreadCount: 1`, `partnerEmail == viewer`, mirrored in
//   `userConversations/krvikrantsingh51_gmail_com/krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com`.
//   Both real conversations (`…/invipika_gmail_com`, `…/vipulkr250_gmail_com`)
//   report `unreadCount: 0`. The latent desync case is the soft-deleted-while-unread
//   message `-Oukg2-81l1xe43cukZD` in `invipika_gmail_com__krvikrantsingh51_gmail_com`
//   (`deleted: true`, `read: false`) — a non-self conversation whose true unread is 0.

import * as fc from 'fast-check';

import type { ConversationSummary } from '../../services/chatService';
import {
  reconcileConversationUnreadCount,
  shouldRefreshChatSummariesOnForegroundResume,
} from '../../lib/chatReceiptState';

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`).
// Functional tree store so the REAL chatService summary-derivation path
// (onConversationSummariesChange) actually reads records we seed. Mirrors the
// mock used by the Property 4 exploration test: `onValue` fires the listener
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
// mirrored at
//   tenantChat/{tenantId}/userConversations/{viewerKey}/{conversationKey}
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
  writePath(`tenantChat/${TENANT_ID}/conversationSummaries/${viewerKey}/${partnerKey}`, {
    partnerEmail: normalizeEmail(partnerEmail),
    partnerId: null,
    partnerName: null,
    tenantId: TENANT_ID,
    unreadCount,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

/** Mirror the summary into userConversations/{viewerKey}/{conversationKey} (as in the export). */
function seedUserConversationMirror(viewer: string, partnerEmail: string, unreadCount: number): void {
  const viewerKey = sanitizeEmailKey(viewer);
  const conversationKey = conversationKeyOf(viewer, partnerEmail);
  writePath(`tenantChat/${TENANT_ID}/userConversations/${viewerKey}/${conversationKey}`, {
    conversationKey,
    partnerEmail: normalizeEmail(partnerEmail),
    tenantId: TENANT_ID,
    unreadCount,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
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

/**
 * The CORRECT badge per Property 4/5: true iff there EXISTS a NON-self conversation
 * with a real unread message for the viewer (`recipientId == viewer AND read == false
 * AND deleted != true`). Self-conversations contribute zero. Computed independently
 * from the durable messages, not from stored summaries.
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
// The SYSTEM UNDER TEST for reconciliation is the composition of the REAL
// production functions, driven exactly as app/(tabs)/chat.tsx wires them.
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
        try {
          unsubscribe();
        } catch {}
      },
      TENANT_ID
    );
  });
}

function toSummaryMap(records: Record<string, ConversationSummary>): Map<string, ConversationSummary> {
  const map = new Map<string, ConversationSummary>();
  for (const [key, summary] of Object.entries(records)) {
    map.set(normalizeEmail(key), summary);
  }
  return map;
}

/**
 * The conversation-open reconciliation step, EXACTLY as chat.tsx wires it: the
 * REAL `reconcileConversationUnreadCount` is applied per conversation, and only
 * the conversation that is currently OPEN + focused gets its effective incoming
 * count driven to 0 (`isFocused && isAppActive ? 0 : incoming`). Every other
 * conversation (including any self-conversation, which is NEVER openable) is
 * passed with `isFocused: false`, so the real function returns it unchanged.
 *
 * @param openedKey normalized partner email of the conversation the user has open,
 *   or null. It is NEVER the self-conversation — the app never displays/opens it.
 */
function applyOpenReconciliation(
  input: Map<string, ConversationSummary>,
  openedKey: string | null
): Map<string, ConversationSummary> {
  let map = input;
  for (const partner of Array.from(map.keys())) {
    const isFocused = openedKey != null && partner === openedKey;
    const existing = map.get(partner)!;
    const effectiveIncoming = isFocused ? 0 : existing.unreadCount;
    map = reconcileConversationUnreadCount(map, partner, effectiveIncoming, {
      isFocused,
      isAppActive: true,
      loading: false,
    });
  }
  return map;
}

/**
 * Run the full live-path reconciliation reachable on a foreground resume:
 *   (1) gate the summary refresh via the REAL foreground-resume decision,
 *   (2) load stored summaries via the REAL chatService derivation (verbatim),
 *   (3) apply the REAL conversation-open reconciliation for whichever non-self
 *       conversation is currently open (or none).
 */
function runLiveReconciliation(
  storedRecords: Record<string, ConversationSummary>,
  openedPartner: string | null
): Map<string, ConversationSummary> {
  // (1) Foreground resume actually triggers a refresh in this scenario.
  const willRefresh = shouldRefreshChatSummariesOnForegroundResume({
    isFocused: true,
    isAppActive: true,
    wasForegroundInteractive: false, // just resumed
    hasUserEmail: true,
    hasTenantId: true,
    now: 100_000,
    lastForegroundRefreshAt: 0,
  });
  expect(willRefresh).toBe(true);

  // (2) A refresh re-reads stored summaries verbatim (no true-unread recompute).
  const map = toSummaryMap(storedRecords);

  // (3) Reconcile the currently-open conversation (self is never open/openable).
  return applyOpenReconciliation(map, openedPartner ? normalizeEmail(openedPartner) : null);
}

/** The badge rule EXACTLY as hooks/useUnreadChatCount.ts derives it. */
function deriveBadgeLikeHook(map: Map<string, ConversationSummary>): boolean {
  const trimmedTenantId = TENANT_ID.trim();
  return Array.from(map.values()).some(
    (summary) => summary?.tenantId?.trim() === trimmedTenantId && summary.unreadCount > 0
  );
}

/** Snapshot of unread counts keyed by partner — for idempotency comparison. */
function unreadSnapshot(map: Map<string, ConversationSummary>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [partner, summary] of map) {
    out[partner] = summary.unreadCount;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property 5 — Bug Condition
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 5 (Bug Condition): self-conversation cleanup converges and is idempotent', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  // Anchored to the confirmed incident before generalizing.
  it('ANCHOR (incident): no reachable reconciliation drives the stuck self-conversation to zero; the phantom dot never clears', async () => {
    const viewer = 'krvikrantsingh51@gmail.com';
    const partnerA = 'invipika@gmail.com';
    const partnerB = 'vipulkr250@gmail.com';

    // Self-conversation summary from the export: partnerEmail == viewer, unreadCount 1,
    // mirrored in userConversations, backed by the stuck self-addressed message.
    seedSummary(viewer, viewer, 1);
    seedUserConversationMirror(viewer, viewer, 1);
    seedMessages(conversationKeyOf(viewer, viewer), [
      { sender: viewer, recipientId: viewer, read: false, deleted: false }, // -OwLnPs_TYzsdesLA6gC
    ]);

    // Both real conversations report unreadCount 0 (as in the export).
    seedSummary(viewer, partnerA, 0);
    seedSummary(viewer, partnerB, 0);
    // The latent non-self desync: a soft-deleted-while-unread message (-Oukg2-81l1xe43cukZD)
    // — true unread is 0, so no genuine non-self unread exists anywhere.
    seedMessages(conversationKeyOf(viewer, partnerA), [
      { sender: partnerA, recipientId: viewer, read: false, deleted: true },
      { sender: partnerA, recipientId: viewer, read: true, deleted: false },
    ]);
    seedMessages(conversationKeyOf(viewer, partnerB), [
      { sender: partnerB, recipientId: viewer, read: true, deleted: false },
    ]);

    const stored = await readSummariesViaService(viewer);

    // The correct badge is OFF — no non-self conversation has a real unread message.
    expect(trueBadgeFromMessages(getStore(), viewer)).toBe(false);

    // Try EVERY reachable reconciliation: a plain foreground resume (nothing open),
    // and opening each real (non-self) conversation. The self-conversation can never
    // be opened, so it is never eligible for the open reconciliation.
    for (const openedPartner of [null, partnerA, partnerB]) {
      const reconciled = runLiveReconciliation(stored, openedPartner);
      const selfSummary = reconciled.get(normalizeEmail(viewer));
      expect(selfSummary).toBeDefined();

      // Property 5: reconciliation SHALL drive the self-conversation's contribution
      // to zero. UNFIXED code has no such reconciliation on the live path, so the
      // stored self count stays > 0 — the counterexample.
      expect(selfSummary!.unreadCount).toBe(0);

      // And the phantom dot SHALL clear. UNFIXED: the self summary keeps it lit.
      expect(deriveBadgeLikeHook(reconciled)).toBe(false);
    }
  });

  // Generalized property over random pre-existing self-conversation summaries plus
  // the latent non-self desync case.
  it('for any pre-existing self-conversation with unreadCount > 0, reconciliation drives its contribution to zero and is idempotent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        // A pre-existing self-conversation with a positive stored unread count.
        fc.integer({ min: 1, max: 5 }),
        // Non-self conversations: either already-read (stored 0, true unread 0) or
        // desynced (stored k > 0 while true unread is 0 via soft-deleted-unread
        // messages). Neither has any genuine unread — mirrors the incident where
        // every real conversation's true unread is 0.
        fc.array(
          fc.record({
            partner: fc.emailAddress(),
            desyncCount: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 0, maxLength: 3 }
        ),
        // Which conversation (if any) the user currently has open — NEVER the self one.
        fc.integer({ min: -1, max: 3 }),
        async (viewer, selfUnread, nonSelfSpecs, openedIndexSeed) => {
          const v = normalizeEmail(viewer);
          const seenPartners = new Set<string>();
          const partners = nonSelfSpecs.filter((spec) => {
            const p = normalizeEmail(spec.partner);
            if (!p || p === v || seenPartners.has(p)) return false;
            seenPartners.add(p);
            return true;
          });

          resetStore();

          // Self-conversation: summary + userConversations mirror + self-addressed message.
          seedSummary(viewer, viewer, selfUnread);
          seedUserConversationMirror(viewer, viewer, selfUnread);
          seedMessages(conversationKeyOf(viewer, viewer), [
            { sender: viewer, recipientId: viewer, read: false, deleted: false },
          ]);

          // Non-self conversations. Stored count = desyncCount; true unread is always 0
          // (desynced messages are soft-deleted, plus one already-read message).
          for (const spec of partners) {
            const convKey = conversationKeyOf(viewer, spec.partner);
            seedSummary(viewer, spec.partner, spec.desyncCount);
            seedUserConversationMirror(viewer, spec.partner, spec.desyncCount);
            const messages: SeededMessage[] = [];
            for (let i = 0; i < spec.desyncCount; i++) {
              messages.push({ sender: spec.partner, recipientId: viewer, read: false, deleted: true });
            }
            messages.push({ sender: spec.partner, recipientId: viewer, read: true, deleted: false });
            seedMessages(convKey, messages);
          }

          const stored = await readSummariesViaService(viewer);

          // Pick the currently-open conversation among the NON-self partners (or none).
          const openedPartner =
            openedIndexSeed >= 0 && openedIndexSeed < partners.length
              ? partners[openedIndexSeed].partner
              : null;

          const reconciled = runLiveReconciliation(stored, openedPartner);

          // No non-self conversation has a genuine unread → the correct badge is OFF.
          expect(trueBadgeFromMessages(getStore(), viewer)).toBe(false);

          // Property 5 (convergence): the self-conversation's contribution SHALL be
          // driven to zero. UNFIXED code leaves the stored self count > 0.
          const selfSummary = reconciled.get(v);
          expect(selfSummary).toBeDefined();
          expect(selfSummary!.unreadCount).toBe(0);

          // Property 5 (badge): once reconciled, the dot SHALL be off (no real unread).
          expect(deriveBadgeLikeHook(reconciled)).toBe(false);

          // Property 5 (idempotent): re-running reconciliation produces no further
          // change and no oscillation. (This holds on the unfixed code too — the
          // failure above is convergence, not idempotency.)
          const openedKey = openedPartner ? normalizeEmail(openedPartner) : null;
          const reconciledTwice = applyOpenReconciliation(reconciled, openedKey);
          expect(unreadSnapshot(reconciledTwice)).toEqual(unreadSnapshot(reconciled));
        }
      ),
      { numRuns: 50 }
    );
  });
});
