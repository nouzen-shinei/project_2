// Feature: stuck-message-delivery-fix
// Property 3 (Bug Condition) — Self-address prevention.
//
// **Validates: Requirements 2.5, 2.9**
//
// EXPLORATION TEST (exploratory bugfix workflow):
//   This property-based test is written BEFORE the fix and is EXPECTED TO FAIL on
//   the current UNFIXED code. Its failure is the SUCCESS signal — it surfaces the
//   counterexample that proves the bug exists: a send whose resolved recipient
//   equals the sender (`normalizeEmail(resolvedRecipient) == normalizeEmail(sender)`)
//   is ACCEPTED and durably persisted, creating a self-addressed message record
//   AND a self-conversation node/summary (identical `conversationKey` halves,
//   `sender == recipientId`, `partnerEmail == sender`) — exactly the export state
//   `conversationMessages/krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com/…`.
//
//   Do NOT "fix" this test or the production code to make it pass here. Once the
//   self-address prevention fix lands (reject the send at the client entry point;
//   never create a self-conversation node/summary), this same test will pass
//   (fix checking, task 12.3).
//
// WHAT IS EXERCISED FOR REAL:
//   The real `chatService.sendMessage` -> `sendMessageDirect` durable-write path
//   runs against a functional in-memory Realtime Database. Only the transport
//   (firebase/database), tenant/auth resolution, and unrelated peripherals are
//   mocked. The bug logic under test — no self-address guard before
//   `getConversationKey(sender, recipientId)` collapses to a self key, then
//   `set`/`registerConversationForUsers`/`applySummaryUpdatesForMessage`
//   persisting the self record + self summary — runs unmodified.
//
// THE INCIDENT (tenant CGnHGq43PFF8WD2DJekx):
//   During an outage recipient resolution fell back to the sender, so the send
//   arrived self-addressed (`recipientId == sender`). The unfixed write path
//   happily persisted `-OwLnPs_TYzsdesLA6gC` (text "hgghdsghs", `delivered:false`)
//   into the self conversation `krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com`
//   and lit a self-conversation summary with `unreadCount: 1`.

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
// Assertion-side helpers. These only read/interpret what the real write path
// persisted — they are NOT the code under test.
// ---------------------------------------------------------------------------
function normalizeEmail(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
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

/** conversationMessages nodes (top-level conversation keys) that were created. */
function collectConversationKeys(store: Record<string, any>): string[] {
  const out: string[] = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const conversations = tenants[tenantId]?.conversationMessages ?? {};
    out.push(...Object.keys(conversations));
  }
  return out;
}

interface SummaryEntry {
  ownerKey: string;
  partnerKey: string;
  partnerEmail?: string;
  unreadCount?: number;
  [k: string]: unknown;
}

/** Collect every conversationSummaries/{ownerKey}/{partnerKey} entry. */
function collectSummaries(store: Record<string, any>): SummaryEntry[] {
  const out: SummaryEntry[] = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const owners = tenants[tenantId]?.conversationSummaries ?? {};
    for (const ownerKey of Object.keys(owners)) {
      const partners = owners[ownerKey] ?? {};
      for (const partnerKey of Object.keys(partners)) {
        const entry = partners[partnerKey];
        if (entry && typeof entry === 'object') {
          out.push({ ownerKey, partnerKey, ...(entry as Record<string, unknown>) });
        }
      }
    }
  }
  return out;
}

/** Collect every userConversations/{userKey}/{conversationKey} entry. */
function collectUserConversationKeys(store: Record<string, any>): string[] {
  const out: string[] = [];
  const tenants = store?.tenantChat ?? {};
  for (const tenantId of Object.keys(tenants)) {
    const users = tenants[tenantId]?.userConversations ?? {};
    for (const userKey of Object.keys(users)) {
      out.push(...Object.keys(users[userKey] ?? {}));
    }
  }
  return out;
}

/**
 * Drive one self-addressed send (the outage fallback: recipient resolved to the
 * sender itself). Returns whether the send was rejected (threw). The property
 * assertions inspect the durable store either way.
 */
async function runSelfAddressedSend(
  sender: string,
  text: string
): Promise<{ rejected: boolean }> {
  setActiveSender(normalizeEmail(sender));
  try {
    await chatService.sendMessage({
      text,
      sender,
      recipientId: sender, // self-addressed: resolved recipient equals the sender
      isSpecial: false,
    } as any);
    return { rejected: false };
  } catch {
    return { rejected: true };
  }
}

/**
 * The core Property 3 assertion: a self-addressed send must persist NOTHING —
 * no message record, no self-conversation node, no self summary, no self
 * userConversations entry. On UNFIXED code every one of these is created.
 */
function assertNoSelfAddressedPersistence(store: Record<string, any>, sender: string): void {
  const normalizedSender = normalizeEmail(sender);
  const senderKey = normalizedSender.replace(/[.@]/g, '_');

  // (1) No message record at all was persisted for the self-addressed send.
  const durable = collectDurableMessages(store);
  const selfAddressed = durable.filter((m) => normalizeEmail(m.sender) === normalizeEmail(m.recipientId));
  expect(selfAddressed).toHaveLength(0);
  expect(durable).toHaveLength(0);

  // (2) No self-conversation node (identical conversationKey halves) was created.
  const selfConversationNodes = collectConversationKeys(store).filter(isSelfConversationKey);
  expect(selfConversationNodes).toHaveLength(0);

  // (3) No self-conversation summary (owner == partner, or partnerEmail == sender).
  const selfSummaries = collectSummaries(store).filter(
    (s) => s.ownerKey === s.partnerKey || normalizeEmail(s.partnerEmail) === normalizedSender
  );
  expect(selfSummaries).toHaveLength(0);

  // (4) No self userConversations entry (a self conversationKey under the sender).
  const selfUserConversations = collectUserConversationKeys(store).filter(
    (convKey) => isSelfConversationKey(convKey) || convKey === `${senderKey}__${senderKey}`
  );
  expect(selfUserConversations).toHaveLength(0);
}

// ---------------------------------------------------------------------------
// Property 3 — Bug Condition
// ---------------------------------------------------------------------------
describe('stuck-message-delivery-fix — Property 3 (Bug Condition): self-address prevention', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  // Anchored to the confirmed incident before generalizing.
  it('ANCHOR (incident): a self-addressed send persists a self-conversation record + summary instead of being rejected', async () => {
    const sender = 'krvikrantsingh51@gmail.com';
    const text = 'hgghdsghs';

    await runSelfAddressedSend(sender, text);

    // Property 3: a self-addressed send SHALL be rejected — nothing persisted.
    // On UNFIXED code this fails: the self record + self summary are created,
    // reproducing conversationMessages/krvikrantsingh51_gmail_com__krvikrantsingh51_gmail_com.
    assertNoSelfAddressedPersistence(getStore(), sender);
  });

  // Generalized property over random (sender, text).
  it('for any send whose resolved recipient equals the sender, no message record and no self-conversation node/summary is created', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        fc.string({ minLength: 1, maxLength: 40 }),
        async (sender, text) => {
          resetStore();

          await runSelfAddressedSend(sender, text);

          // The self-addressed send must leave the durable store free of any
          // self record / self-conversation node / self summary. UNFIXED code
          // violates this by persisting all three.
          assertNoSelfAddressedPersistence(getStore(), sender);
        }
      ),
      { numRuns: 50 }
    );
  });
});
