// Feature: stuck-message-delivery-fix
// Property 8 (Preservation) — Genuine unread increment/clear and non-self
// conversations unaffected.
//
// **Validates: Requirements 3.3, 3.4, 3.7**
//
// PRESERVATION TEST (exploratory bugfix workflow, observation-first):
//   This property-based test is written BEFORE the fix and is EXPECTED TO PASS on
//   the current UNFIXED code. It captures the BASELINE genuine-unread behavior that
//   the upcoming unread / self-conversation fix (tasks 11.x) must preserve
//   (re-checked at task 13.3). Following the observation-first methodology, the
//   assertions below encode what the UNFIXED code is observed to do for NON-SELF
//   conversations that carry real unread messages — the healthy case that must be
//   left completely untouched by self-address blocking + self-conversation
//   exclusion/cleanup.
//
//   This is the mirror image of the Property 4 bug-condition test: Property 4
//   proves the badge lights PHANTOM from a self-conversation (and therefore FAILS
//   on unfixed code); Property 8 proves that for the non-self world the unfixed
//   badge is already CORRECT — the dot is on exactly when a real unread message
//   exists, clears when everything is read, and no non-self count is disturbed.
//
// OBSERVED BASELINE (recorded by running the UNFIXED code, then asserted here):
//   1. A genuinely unread incoming message in a non-self conversation
//      (`recipientId == viewer AND read == false AND deleted != true`) keeps that
//      conversation's stored `unreadCount > 0`, and the Messages-tab dot is on.
//   2. Reading that conversation (its stored count goes to 0 and its messages are
//      marked read) clears the count to 0, and the dot clears once no OTHER
//      conversation still has real unread — matching the export where both real
//      conversations (`…/invipika_gmail_com`, `…/vipulkr250_gmail_com`) already
//      read `unreadCount: 0`.
//   3. Deriving the badge and reconciling one conversation's count leaves every
//      OTHER non-self conversation, its messages, and its stored count unchanged.
//
// WHAT IS EXERCISED FOR REAL:
//   - `chatService.onConversationSummariesChange` — the REAL summary derivation.
//     It reads the seeded `conversationSummaries/{viewerKey}/*` node, normalizes
//     each record via `normalizeConversationSummaryRecord`, and keys the result by
//     `partnerEmail`, exactly as in production.
//   - The badge rule EXACTLY as `hooks/useUnreadChatCount.ts` implements it:
//     `hasUnread = Object.values(records).some(s => s.tenantId?.trim() === tenantId
//     && s.unreadCount > 0)`.
//   - `reconcileConversationUnreadCount` (lib/chatReceiptState.ts) — the REAL
//     per-conversation reconciliation used on the live path; the test asserts it
//     only ever touches the targeted conversation and leaves the rest byte-for-byte
//     (reference) identical.
//   The CORRECT badge (Property 8 / Property 4 spec) is computed independently from
//   the durable messages using the true-unread predicate, so the assertion is a
//   genuine cross-check, not a tautology.
//
// THE INCIDENT (tenant CGnHGq43PFF8WD2DJekx):
//   The self-conversation was the sole phantom-dot source; the user's two genuine
//   conversations behaved correctly throughout (increment on arrival, clear on
//   read). Property 8 pins that healthy behavior so the fix cannot regress it.

import * as fc from 'fast-check';
import type { ConversationSummary } from '../../services/chatService';

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`). Identical
// functional tree store to the Property 4 scaffolding so the REAL chatService
// summary-derivation path (onConversationSummariesChange) actually reads the
// records we seed. `onValue` fires the listener synchronously with a snapshot of
// the node at the ref path.
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
import { reconcileConversationUnreadCount } from '../../lib/chatReceiptState';

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
  writePath(`tenantChat/${TENANT_ID}/conversationSummaries/${viewerKey}/${partnerKey}`, {
    partnerEmail: normalizeEmail(partnerEmail),
    partnerId: null,
    partnerName: null,
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

// ---------------------------------------------------------------------------
// System under test for the badge:
//   (1) chatService.onConversationSummariesChange — REAL summary derivation.
//   (2) the useUnreadChatCount badge rule — modelled exactly.
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

/**
 * The badge rule EXACTLY as `hooks/useUnreadChatCount.ts` derives it: any summary
 * for this tenant with `unreadCount > 0` lights the dot.
 */
function deriveBadgeLikeHook(records: Record<string, ConversationSummary>): boolean {
  const trimmedTenantId = TENANT_ID.trim();
  return Object.values(records).some(
    (summary) => summary?.tenantId?.trim() === trimmedTenantId && summary.unreadCount > 0
  );
}

/**
 * The CORRECT badge per the spec: true iff there EXISTS a NON-self conversation
 * with a real unread message for the viewer (`recipientId == viewer AND
 * read == false AND deleted != true`). Computed independently from the durable
 * messages, not from stored summaries.
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
// Generators — realistic, simple emails so sanitized conversation keys never
// collide; a set of NON-self conversations each with an honest real-unread count.
// ---------------------------------------------------------------------------
const realisticEmailArb: fc.Arbitrary<string> = fc
  .tuple(
    fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
        minLength: 3,
        maxLength: 14,
      })
      .map((chars) => chars.join('')),
    fc.constantFrom('gmail.com', 'example.com', 'outlook.com', 'company.co', 'mail.org')
  )
  .map(([local, domain]) => `${local}@${domain}`);

interface NonSelfConversation {
  partner: string;
  realUnread: number;
}

/**
 * Seed a full non-self conversation set: for each conversation, the stored
 * summary count equals its real unread message count (honest / consistent — the
 * desync case is a separate bug-condition property), plus one already-read
 * message so the conversation exists even at count 0.
 */
function seedNonSelfConversations(viewer: string, conversations: NonSelfConversation[]): void {
  for (const c of conversations) {
    const convKey = conversationKeyOf(viewer, c.partner);
    seedSummary(viewer, c.partner, c.realUnread);
    const messages: SeededMessage[] = [];
    for (let i = 0; i < c.realUnread; i++) {
      messages.push({ sender: c.partner, recipientId: viewer, read: false, deleted: false });
    }
    messages.push({ sender: c.partner, recipientId: viewer, read: true, deleted: false });
    seedMessages(convKey, messages);
  }
}

/** Mark a conversation as read: stored count -> 0 and every message read. */
function markConversationRead(viewer: string, partner: string): void {
  const convKey = conversationKeyOf(viewer, partner);
  seedSummary(viewer, partner, 0);
  const node = getStore()?.tenantChat?.[TENANT_ID]?.conversationMessages?.[convKey] ?? {};
  for (const messageId of Object.keys(node)) {
    writePath(
      `tenantChat/${TENANT_ID}/conversationMessages/${convKey}/${messageId}`,
      { ...node[messageId], read: true }
    );
  }
}

/** Keep only conversations whose partner is genuinely distinct from viewer and each other. */
function dedupeNonSelf(viewer: string, specs: NonSelfConversation[]): NonSelfConversation[] {
  const viewerKey = sanitizeEmailKey(viewer);
  const seen = new Set<string>();
  const out: NonSelfConversation[] = [];
  for (const spec of specs) {
    const key = sanitizeEmailKey(spec.partner);
    if (!key || key === viewerKey || seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Property 8 — Preservation
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 8 (Preservation): genuine unread increment/clear and non-self conversations unaffected', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  // Anchored to the two genuine (non-self) conversations from the export.
  it('ANCHOR (baseline): a genuine unread message keeps the dot on; reading it clears the count and dot once nothing else is unread', async () => {
    const viewer = 'krvikrantsingh51@gmail.com';
    const partnerA = 'invipika@gmail.com';
    const partnerB = 'vipulkr250@gmail.com';

    // partnerA has one genuine unread message; partnerB is fully read.
    seedNonSelfConversations(viewer, [
      { partner: partnerA, realUnread: 1 },
      { partner: partnerB, realUnread: 0 },
    ]);

    // (3.3) Genuine unread -> stored count > 0 and the dot is on.
    let records = await readSummariesViaService(viewer);
    expect(records[normalizeEmail(partnerA)].unreadCount).toBe(1);
    expect(records[normalizeEmail(partnerB)].unreadCount).toBe(0);
    expect(deriveBadgeLikeHook(records)).toBe(true);
    expect(trueBadgeFromMessages(getStore(), viewer)).toBe(true);

    // (3.4) Reading partnerA clears its count to 0; nothing else is unread -> dot clears.
    markConversationRead(viewer, partnerA);
    records = await readSummariesViaService(viewer);
    expect(records[normalizeEmail(partnerA)].unreadCount).toBe(0);
    // (3.7) partnerB was untouched by reading partnerA.
    expect(records[normalizeEmail(partnerB)].unreadCount).toBe(0);
    expect(deriveBadgeLikeHook(records)).toBe(false);
    expect(trueBadgeFromMessages(getStore(), viewer)).toBe(false);
  });

  it('ANCHOR (baseline): with two unread conversations, reading one keeps the dot on because the other is still unread', async () => {
    const viewer = 'krvikrantsingh51@gmail.com';
    const partnerA = 'invipika@gmail.com';
    const partnerB = 'vipulkr250@gmail.com';

    seedNonSelfConversations(viewer, [
      { partner: partnerA, realUnread: 2 },
      { partner: partnerB, realUnread: 1 },
    ]);

    let records = await readSummariesViaService(viewer);
    expect(deriveBadgeLikeHook(records)).toBe(true);

    // Read partnerA only. partnerB still has a genuine unread -> dot stays on.
    markConversationRead(viewer, partnerA);
    records = await readSummariesViaService(viewer);
    expect(records[normalizeEmail(partnerA)].unreadCount).toBe(0);
    expect(records[normalizeEmail(partnerB)].unreadCount).toBe(1); // unchanged
    expect(deriveBadgeLikeHook(records)).toBe(true);
    expect(trueBadgeFromMessages(getStore(), viewer)).toBe(true);
  });

  // Generalized property over random NON-self conversation sets with real unread.
  it('for any non-self conversation set, badgeOn holds iff a non-self conversation has a real unread message, and reading everything clears it', async () => {
    await fc.assert(
      fc.asyncProperty(
        realisticEmailArb,
        fc.array(
          fc.record({
            partner: realisticEmailArb,
            realUnread: fc.integer({ min: 0, max: 3 }),
          }),
          { minLength: 0, maxLength: 4 }
        ),
        async (viewer, rawSpecs) => {
          const conversations = dedupeNonSelf(viewer, rawSpecs);

          resetStore();
          seedNonSelfConversations(viewer, conversations);

          // (1) Initial derivation: badge on iff some non-self conversation has real unread.
          const records = await readSummariesViaService(viewer);
          const badgeOn = deriveBadgeLikeHook(records);
          const expectedBadge = trueBadgeFromMessages(getStore(), viewer);
          expect(badgeOn).toBe(expectedBadge);

          // (3.3 / 3.7) Every non-self conversation's derived count exactly equals
          // its seeded honest count — the derivation neither drops nor disturbs
          // non-self conversations or their counts.
          for (const c of conversations) {
            expect(records[normalizeEmail(c.partner)]?.unreadCount).toBe(c.realUnread);
          }

          // (3.4) Read every conversation -> all counts clear to 0 and the dot clears.
          for (const c of conversations) {
            markConversationRead(viewer, c.partner);
          }
          const afterRead = await readSummariesViaService(viewer);
          for (const c of conversations) {
            expect(afterRead[normalizeEmail(c.partner)]?.unreadCount).toBe(0);
          }
          expect(deriveBadgeLikeHook(afterRead)).toBe(false);
          expect(trueBadgeFromMessages(getStore(), viewer)).toBe(false);
        }
      ),
      { numRuns: 50 }
    );
  });

  // Reconciliation of one conversation leaves all OTHER non-self conversations,
  // their messages, and their counts unchanged (3.7). Uses the REAL live-path
  // reconciler `reconcileConversationUnreadCount`.
  it('reconciling one conversation updates only that conversation and leaves all others untouched', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            partner: realisticEmailArb,
            unreadCount: fc.integer({ min: 0, max: 5 }),
          }),
          { minLength: 1, maxLength: 5 }
        ),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 9 }),
        (rawSpecs, targetPick, newCount) => {
          // Distinct partners keyed by normalized email.
          const seen = new Set<string>();
          const specs = rawSpecs.filter((s) => {
            const p = normalizeEmail(s.partner);
            if (!p || seen.has(p)) return false;
            seen.add(p);
            return true;
          });
          fc.pre(specs.length > 0);

          type SummaryEntry = { unreadCount: number; partnerName: string; messages: string[] };
          const previous = new Map<string, SummaryEntry>();
          for (const s of specs) {
            previous.set(normalizeEmail(s.partner), {
              unreadCount: s.unreadCount,
              partnerName: `name-${normalizeEmail(s.partner)}`,
              messages: ['m1', 'm2'],
            });
          }

          const target = specs[targetPick % specs.length];
          const targetKey = normalizeEmail(target.partner);
          const targetPrev = previous.get(targetKey)!;

          const next = reconcileConversationUnreadCount(previous, target.partner, newCount, {
            isFocused: true,
            isAppActive: true,
            loading: false,
          });

          if (newCount === targetPrev.unreadCount) {
            // No change requested -> the reconciler returns the SAME map instance.
            expect(next).toBe(previous);
            return;
          }

          // Only the target conversation's count changed.
          expect(next.get(targetKey)!.unreadCount).toBe(newCount);
          expect(next.size).toBe(previous.size);

          // Every OTHER conversation is left byte-for-byte identical (same object ref):
          // count, name, and messages are untouched.
          for (const [key, entry] of previous) {
            if (key === targetKey) continue;
            expect(next.get(key)).toBe(entry);
          }

          // The target's non-count fields (messages, name) are preserved as well.
          expect(next.get(targetKey)!.partnerName).toBe(targetPrev.partnerName);
          expect(next.get(targetKey)!.messages).toBe(targetPrev.messages);
        }
      ),
      { numRuns: 60 }
    );
  });
});
