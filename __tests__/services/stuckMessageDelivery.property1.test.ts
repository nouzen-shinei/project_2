// Feature: stuck-message-delivery-fix
// Property 1 (Bug Condition) — Delivery: shown-as-Sent implies a durable record
// for the intended (non-self) recipient.
//
// **Validates: Requirements 2.1, 2.4**
//
// EXPLORATION TEST (exploratory bugfix workflow):
//   This property-based test is written BEFORE the fix and is EXPECTED TO FAIL on
//   the current UNFIXED code. Its failure is the SUCCESS signal — it surfaces the
//   counterexample that proves the bug exists: a pending send reaches the terminal
//   `sent` state while the only durable server record is self-addressed
//   (recipientId == sender, self conversationKey) and therefore is never delivered
//   to the intended recipient.
//
//   Do NOT "fix" this test or the production code to make it pass here. Once the
//   delivery / self-address fix lands, this same test will pass (fix checking).
//
// WHAT IS EXERCISED FOR REAL:
//   The real `chatService.sendMessage` -> `sendMessageDirect` durable-write path
//   runs against a functional in-memory Realtime Database. Only the transport
//   (firebase/database), tenant/auth resolution, and unrelated peripherals are
//   mocked. The bug logic under test — `getConversationKey(sender, recipientId)`
//   collapsing to a self key when recipient resolution falls back to the sender,
//   and the record persisting `recipientId == sender` — runs unmodified.
//
//   The client promotion rule is modelled exactly as `app/(tabs)/chat.tsx`
//   `handleSendMessage` implements it: once `await sendMessage(...)` resolves with
//   a server message id, the pending item is advanced to `status: 'sent'` with NO
//   verification that the durable record targeted the intended recipient.
//
// THE SIMULATED OUTAGE:
//   Per the confirmed incident (tenant CGnHGq43PFF8WD2DJekx), during a backend
//   outage recipient resolution fell back to the sender, so the durable write
//   landed self-addressed. We model that fallback by driving the send with
//   `recipientId := sender` while the *intended* recipient is a separate value
//   that never reaches the write path.

import * as fc from 'fast-check';

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
  // write path (sendMessageDirect), which is where the self-address bug lands.
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
// can evaluate `existsDurableRecordForIntendedRecipient` against the durable
// store. They are NOT the code under test — they only read/interpret what the
// real write path persisted.
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
  sender?: string;
  recipientId?: string;
  conversationKey?: string;
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
          out.push({ id: messageId, ...(record as Record<string, unknown>) });
        }
      }
    }
  }
  return out;
}

/**
 * The design's `existsDurableRecordForIntendedRecipient`: is there a durable
 * record addressed to the INTENDED recipient (non-self, correct conversationKey,
 * not deleted)?
 */
function existsDurableRecordForIntendedRecipient(
  store: Record<string, any>,
  sender: string,
  intendedRecipient: string
): boolean {
  const intended = normalizeEmail(intendedRecipient);
  const expectedKey = conversationKeyOf(sender, intendedRecipient);
  return collectDurableMessages(store).some((m) => {
    return (
      normalizeEmail(m.recipientId) === intended &&
      normalizeEmail(m.sender) !== intended &&
      m.conversationKey === expectedKey &&
      !isSelfConversationKey(String(m.conversationKey ?? '')) &&
      m.deleted !== true
    );
  });
}

/**
 * Drive one outage send. Models the real handleSendMessage promotion: begins in
 * `sending`, and on a resolved server message id advances to terminal `sent`.
 * The simulated outage means recipient resolution has already fallen back to the
 * sender, so `recipientId` passed into the write path equals the sender.
 */
async function runOutageSend(
  sender: string,
  text: string
): Promise<{ status: 'sent' | 'failed'; serverMessageId: string | null }> {
  setActiveSender(normalizeEmail(sender));
  try {
    const serverMessageId = await chatService.sendMessage({
      text,
      sender,
      recipientId: sender, // outage fallback: recipient resolved to the sender itself
      isSpecial: false,
    } as any);
    // handleSendMessage: on resolution -> status 'sent' (no durable-record verification).
    return { status: 'sent', serverMessageId };
  } catch {
    return { status: 'failed', serverMessageId: null };
  }
}

// ---------------------------------------------------------------------------
// Property 1 — Bug Condition
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 1 (Bug Condition): shown-as-Sent implies a durable record for the intended recipient', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  // Anchored to the confirmed incident before generalizing.
  it('ANCHOR (incident): a self-addressed outage send is rejected — never persisted self-addressed, and never shown as "sent" without a durable record for the intended recipient', async () => {
    const sender = 'krvikrantsingh51@gmail.com';
    const intendedRecipient = 'invipika@gmail.com';
    const text = 'hgghdsghs';

    const outcome = await runOutageSend(sender, text);
    const store = getStore();
    const durable = collectDurableMessages(store);

    // The self-conversation key from the export (identical halves). Under the
    // correct behavior the self-addressed outage send is rejected, so NO record
    // is ever persisted under this key.
    const selfKey = 'krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com';
    const selfRecord = durable.find((m) => m.conversationKey === selfKey);

    // Property 1: IF the send is shown as terminally "sent", it MUST be backed by
    // a durable record for the intended (non-self) recipient. On UNFIXED code the
    // item is promoted to "sent" while the sole durable record is self-addressed,
    // so this guarded invariant fails; on FIXED code the self-send is rejected
    // (outcome 'failed'), so the guard is skipped.
    if (outcome.status === 'sent') {
      expect(existsDurableRecordForIntendedRecipient(store, sender, intendedRecipient)).toBe(true);
    }

    // A self-addressed message SHALL never be durably persisted. On UNFIXED code
    // the self-addressed record exists, so this fails; on FIXED code no self
    // record is created.
    expect(selfRecord).toBeUndefined();
  });

  // Generalized property over random (sender, intendedRecipient, text).
  it('for any outage send shown as terminal "sent", a durable record exists for the intended (non-self) recipient', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        fc.emailAddress(),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (sender, intendedRecipient, text) => {
          // Intended recipient must genuinely differ from the sender (a real
          // one-to-one conversation, not a self-conversation).
          fc.pre(normalizeEmail(sender) !== normalizeEmail(intendedRecipient));

          resetStore();

          const outcome = await runOutageSend(sender, text);

          if (outcome.status === 'sent') {
            // The core invariant: a "sent" outcome must be backed by a durable
            // record for the intended recipient. UNFIXED code violates this.
            expect(existsDurableRecordForIntendedRecipient(getStore(), sender, intendedRecipient)).toBe(true);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
