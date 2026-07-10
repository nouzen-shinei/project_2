// Feature: stuck-message-delivery-fix
// Property 6 (Preservation) — Healthy send still succeeds.
//
// **Validates: Requirements 3.1**
//
// PRESERVATION TEST (exploratory bugfix workflow, observation-first):
//   This property-based test is written BEFORE the fix and is EXPECTED TO PASS on
//   the current UNFIXED code. It captures the BASELINE behavior that the upcoming
//   delivery / self-address fix must preserve. Following the observation-first
//   methodology, the assertions below encode what the UNFIXED code is observed to
//   do for a healthy send to a real recipient; the fix (tasks 10.x) must keep this
//   observable outcome identical (re-checked at task 13.1).
//
//   A healthy send is the normal, non-buggy case: the resolved recipient is a real
//   person (`recipientId != sender`), the backend/durable write is reachable, and
//   the write lands in the correct NON-SELF conversation. This is exactly the case
//   that every genuine message in the tenant export took.
//
// OBSERVED BASELINE (recorded by running the UNFIXED code, then asserted here):
//   Driving `chatService.sendMessage({ text, sender, recipientId, isSpecial:false })`
//   with `recipientId != sender` through the real `sendMessage -> sendMessageDirect`
//   durable-write path against the in-memory Realtime Database:
//     1. resolves with a durable server message id (a non-empty push key), which
//        `app/(tabs)/chat.tsx` `handleSendMessage` promotes to terminal `sent`;
//     2. creates EXACTLY ONE durable record under
//        `tenantChat/{tenantId}/conversationMessages/{conversationKey}/{id}`;
//     3. that record's `conversationKey` equals
//        `getConversationKey(sender, intendedRecipient)` — a NON-SELF key
//        (distinct participant halves);
//     4. the record carries `recipientId == normalizeEmail(intendedRecipient)`,
//        `sender == normalizeEmail(sender)`, `recipientId != sender`, and is not
//        deleted — i.e. it appears in the intended recipient's conversation so
//        both devices can surface it.
//
// WHAT IS EXERCISED FOR REAL:
//   The real `chatService.sendMessage -> sendMessageDirect` write path runs against
//   a functional in-memory Realtime Database. Only the transport (firebase/database),
//   tenant/auth resolution, and unrelated peripherals are mocked. Key derivation
//   (`getConversationKey`), record shaping, and the summary/userConversations writes
//   all run unmodified — so the "single durable record placement" we assert is what
//   the production code genuinely persists.
//
// This mock scaffolding intentionally mirrors
// `stuckMessageDelivery.property1.test.ts` / `.property3.test.ts` so the healthy
// baseline is observed through the identical harness the bug-condition tests use.

import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Realistic-email generator (smart, domain-constrained input space).
//
// `fc.emailAddress()` is RFC-valid but too broad for this property: its local
// part may include characters like "/" that are legal per RFC 5321 yet are
// Realtime-Database path separators. A recipient such as "a/a@a.aa" produces a
// conversationKey containing "/", which nests as a path rather than a flat key.
// That behavior is unrelated to the stuck-message-delivery bug and outside the
// "healthy send to a real recipient" domain this preservation property protects
// (real users authenticate via Gmail/Google Sign-In, so addresses are ordinary
// alphanumeric-plus-dot emails). We therefore constrain generation to that
// realistic domain — dots are fine because `sanitizeEmailKey` maps them to "_".
const realisticEmailArb: fc.Arbitrary<string> = fc
  .tuple(
    fc
      .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.'.split('')), {
        minLength: 1,
        maxLength: 16,
      })
      .map((chars) => chars.join(''))
      // Avoid leading/trailing/double dots so the local part stays a plausible address.
      .filter((local) => /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(local)),
    fc.constantFrom('gmail.com', 'example.com', 'outlook.com', 'company.co', 'mail.org', 'yahoo.com')
  )
  .map(([local, domain]) => `${local}@${domain}`);

// ---------------------------------------------------------------------------
// In-memory Realtime Database (mock for `firebase/database`).
// A functional tree store so the REAL chatService write path actually persists
// records we can then inspect. Everything is self-contained inside the factory
// (jest.mock hoisting rules), with __getStore / __resetStore escape hatches.
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

  let pushCounter = 0;

  return {
    __esModule: true,
    __getStore: () => store,
    __resetStore: () => {
      for (const k of Object.keys(store)) delete store[k];
      pushCounter = 0;
    },
    ref: (_db: unknown, path = '') => makeRef(path),
    child: (parent: { path: string }, sub: string) => makeRef(`${parent.path}/${sub}`),
    push: (parent: { path: string }) => {
      pushCounter += 1;
      const key = `-Mock${String(pushCounter).padStart(6, '0')}${Math.random().toString(36).slice(2, 6)}`;
      return makeRef(`${parent.path}/${key}`);
    },
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
      if (committed) {
        writeNode(segments, clone(next));
      }
      return { committed, snapshot: makeSnapshot(segments, r.key) };
    },
    // Listener / query primitives are unused on the send path — provide no-op stubs.
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
// Peripheral mocks — everything chatService imports at module scope, so the real
// module loads cleanly in a node test environment without pulling native deps.
// ---------------------------------------------------------------------------
jest.mock('@/config/firebase', () => ({
  __esModule: true,
  database: { __mockDatabase: true },
  storage: { __mockStorage: true },
  auth: { currentUser: { email: 'sender@example.com', uid: 'uid-mock' } },
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
  // Empty snapshot + no preferred base URL -> chatService uses the DIRECT RTDB
  // write path (sendMessageDirect). For a healthy send to a real recipient this
  // is the durable write that must keep landing in the correct non-self conversation.
  runtimeEndpoints: {
    getSnapshot: jest.fn(() => ({})),
    getPreferredBackendBaseUrl: jest.fn(() => undefined),
  },
}));

// tenantService: an active-membership stub. `ensureTenantChatScope` checks the
// sender's membership by exact email match, so we expose a setter to point the
// stub at the sender generated for each property run.
jest.mock('@/services/tenantService', () => {
  let activeSender = '';
  return {
    __esModule: true,
    __setActiveSender: (email: string) => {
      activeSender = String(email || '').toLowerCase();
    },
    tenantService: {
      getCachedSelectedTenant: jest.fn(async () => 'tenant-test'),
      getCachedMemberships: jest.fn(async () => [
        { tenantId: 'tenant-test', status: 'active', email: activeSender },
      ]),
      getMembershipsForUser: jest.fn(async () => [
        { tenantId: 'tenant-test', status: 'active', email: activeSender },
      ]),
      cacheMemberships: jest.fn(async () => {}),
      isEmailActiveMemberOfTenant: jest.fn(async () => true),
    },
  };
});

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
import * as tenantModule from '../../services/tenantService';

const getStore = (): Record<string, any> => (rtdb as any).__getStore();
const resetStore = (): void => (rtdb as any).__resetStore();
const setActiveSender = (email: string): void => (tenantModule as any).__setActiveSender(email);

// ---------------------------------------------------------------------------
// Assertion-side helpers. These mirror chatService's own key derivation so we
// can evaluate the placement of the single durable record. They are NOT the code
// under test — they only read/interpret what the real write path persisted.
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

interface DurableRecord {
  id: string;
  conversationKey: string;
  sender?: string;
  recipientId?: string;
  text?: string;
  deleted?: boolean;
  [k: string]: unknown;
}

/** Collect every durable message under tenantChat/*​/conversationMessages/*​/*. */
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
          out.push({ id: messageId, conversationKey: convKey, ...(record as Record<string, unknown>) });
        }
      }
    }
  }
  return out;
}

/**
 * Drive one HEALTHY send (real recipient, reachable durable write). Models the
 * real handleSendMessage promotion: on a resolved server message id the pending
 * item advances to terminal `sent`. Unlike the outage exploration tests, here the
 * recipient is a genuine, distinct party — the normal case.
 */
async function runHealthySend(
  sender: string,
  intendedRecipient: string,
  text: string
): Promise<{ status: 'sent' | 'failed'; serverMessageId: string | null }> {
  setActiveSender(normalizeEmail(sender));
  try {
    const serverMessageId = await chatService.sendMessage({
      text,
      sender,
      recipientId: intendedRecipient, // real recipient, distinct from the sender
      isSpecial: false,
    } as any);
    // handleSendMessage: on resolution with a durable id -> status 'sent'.
    return { status: serverMessageId ? 'sent' : 'failed', serverMessageId };
  } catch {
    return { status: 'failed', serverMessageId: null };
  }
}

/**
 * The observed healthy baseline: a single durable record, placed in the correct
 * non-self conversation for the intended recipient. Asserted verbatim so the fix
 * must preserve it.
 */
function assertHealthyDurablePlacement(
  store: Record<string, any>,
  sender: string,
  intendedRecipient: string,
  text: string
): void {
  const durable = collectDurableMessages(store);

  // Exactly one durable record is created for a healthy send (no duplicates).
  expect(durable).toHaveLength(1);

  const record = durable[0];
  const expectedKey = conversationKeyOf(sender, intendedRecipient);

  // Placed in the correct NON-SELF conversation for the intended recipient.
  expect(record.conversationKey).toBe(expectedKey);
  expect(isSelfConversationKey(expectedKey)).toBe(false);
  expect(isSelfConversationKey(String(record.conversationKey))).toBe(false);

  // Addressed to the intended recipient, from the sender, and not self-addressed.
  expect(normalizeEmail(record.recipientId)).toBe(normalizeEmail(intendedRecipient));
  expect(normalizeEmail(record.sender)).toBe(normalizeEmail(sender));
  expect(normalizeEmail(record.recipientId)).not.toBe(normalizeEmail(record.sender));

  // The message content is preserved and the record is live (surfaces on both devices).
  expect(record.text).toBe(text);
  expect(record.deleted).not.toBe(true);
}

// ---------------------------------------------------------------------------
// Property 6 — Preservation
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 6 (Preservation): healthy send still succeeds', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  // Anchored to a genuine (non-self) conversation from the export, mirroring the
  // real conversation krvikrantsingh51 <-> invipika that already delivers cleanly.
  it('ANCHOR (baseline): a send to a real recipient advances to "sent" with exactly one durable record in the correct non-self conversation', async () => {
    const sender = 'krvikrantsingh51@gmail.com';
    const intendedRecipient = 'invipika@gmail.com';
    const text = 'hey, are we still meeting today?';

    const outcome = await runHealthySend(sender, intendedRecipient, text);

    // Healthy send is shown as terminally "sent"...
    expect(outcome.status).toBe('sent');
    expect(typeof outcome.serverMessageId).toBe('string');
    expect(outcome.serverMessageId && outcome.serverMessageId.length).toBeGreaterThan(0);

    // ...and backed by the single, correctly-placed durable record.
    assertHealthyDurablePlacement(getStore(), sender, intendedRecipient, text);
  });

  // Generalized property over random (sender, realRecipient != sender, text).
  it('for any healthy send to a real recipient, the outcome is "sent" and exactly one durable record lands in the correct non-self conversation', async () => {
    await fc.assert(
      fc.asyncProperty(
        realisticEmailArb,
        realisticEmailArb,
        fc.string({ minLength: 1, maxLength: 40 }),
        async (sender, intendedRecipient, text) => {
          // Constrain to the healthy input space: a real, distinct recipient whose
          // sanitized key differs from the sender's, so the conversation is non-self.
          fc.pre(normalizeEmail(sender) !== normalizeEmail(intendedRecipient));
          fc.pre(sanitizeEmailKey(sender) !== sanitizeEmailKey(intendedRecipient));

          resetStore();

          const outcome = await runHealthySend(sender, intendedRecipient, text);

          // The healthy baseline: shown as "sent", backed by exactly one durable
          // record placed in the intended recipient's non-self conversation.
          expect(outcome.status).toBe('sent');
          assertHealthyDurablePlacement(getStore(), sender, intendedRecipient, text);
        }
      ),
      { numRuns: 50 }
    );
  });
});
